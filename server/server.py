#!/usr/bin/env python3
import os
import traceback
import urllib.parse
import time
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, request, jsonify

import pychromecast

# ——— Load environment overrides ——————————————————————————
load_dotenv()
PORT          = int(os.getenv("PORT", 3000))
LOG_FILE      = os.getenv(
    "LOG_FILE",
    os.path.join(os.path.dirname(__file__), "events.txt")
)
MAX_LOG_BYTES = int(os.getenv("MAX_LOG_BYTES", 20 * 1024 * 1024))  # 20 MB
CAST_DEVICES  = [
    n.strip()
    for n in os.getenv("CAST_DEVICES", "Ryan Office display").split(",")
    if n.strip()
]

# ——— Ensure log directory & file exist ——————————————————————
log_dir = os.path.dirname(LOG_FILE)
if log_dir and not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)
open(LOG_FILE, "a", encoding="utf-8").close()

# ——— Initialize Flask ————————————————————————————————————
app = Flask(__name__)

# ——— Discover & connect to Chromecasts once at startup —————————
chromecasts = []
try:
    chromecasts, browser = pychromecast.get_listed_chromecasts(CAST_DEVICES)
    if not chromecasts:
        app.logger.warning(f"No Chromecasts found matching {CAST_DEVICES!r}")
    else:
        app.logger.info(f"Discovered {len(chromecasts)} Chromecast(s):")
        for cc in chromecasts:
            # log friendly name
            name = getattr(cc, "name", None) or getattr(cc.cast_info, "friendly_name", None)
            app.logger.info(f"  • {name}")
        # now wait on _each_ one so their socket_client threads fetch service_info
        for cc in chromecasts:
            cc.wait()     # blocks until connection is up
        # only now stop discovery to avoid killing the Zeroconf loop
        browser.stop_discovery()
except Exception:
    app.logger.error("Error during Chromecast discovery:\n" + traceback.format_exc())
    # leave chromecasts = [] if something failed

def speak_text(message: str):
    """
    Play a TTS message on each previously‐discovered Chromecast.
    """
    if not chromecasts:
        app.logger.warning("speak_text(): no devices to speak on")
        return

    # build TTS URL via Google Translate
    tts_url = (
        "http://translate.google.com/translate_tts?"
        f"ie=UTF-8&client=tw-ob&tl=en&q={urllib.parse.quote(message)}"
    )

    for cc in chromecasts:
        try:
            mc = cc.media_controller
            mc.play_media(tts_url, "audio/mp3")
            mc.block_until_active()
            # wait until playback ends
            while mc.status.player_state == "PLAYING":
                time.sleep(0.1)
            mc.stop()
            cc.quit_app()
            name = getattr(cc, "name", None) or getattr(cc.cast_info, "friendly_name", None)
            app.logger.info(f"Spoke on {name}")
        except Exception:
            app.logger.error(f"Error speaking on {name}:\n{traceback.format_exc()}")

# ——— HTTP POST endpoint ——————————————————————————————————
@app.route("/api/seismic", methods=["POST"])
def log_seismic():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400
    try:
        data = request.get_json()
        if "level" not in data or "deltaG" not in data:
            return jsonify({"error": "Invalid payload: need level & deltaG"}), 400

        # Prepare log line
        ts    = datetime.utcnow().isoformat() + "Z"
        level = data["level"]
        delta = float(data["deltaG"])
        line  = f"{ts} level={level} deltaG={delta:.2f}\n"

        # Rotate by size
        if os.path.getsize(LOG_FILE) >= MAX_LOG_BYTES:
            app.logger.warning("Log size limit reached; skipping write")
            return jsonify({"status": "skipped", "reason": "max size reached"}), 200

        # Append to file
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        app.logger.info(f"Logged event: {level} Δg={delta:.2f}")

        # Announce on every Chromecast
        speak_text(f"Detected {level} quake, delta G {delta:.2f}")

        return jsonify({"status": "logged"}), 201

    except Exception:
        app.logger.error("Unhandled exception:\n" + traceback.format_exc())
        return jsonify({"error": "Internal server error"}), 500

# ——— Run the server —————————————————————————————————————
if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.DEBUG)
    app.run(host="0.0.0.0", port=PORT)
