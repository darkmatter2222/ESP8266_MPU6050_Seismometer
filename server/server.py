#!/usr/bin/env python3
# server.py

import os
import traceback
import urllib.parse
import time
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, request, jsonify, Response
import logging
from logging.handlers import RotatingFileHandler

import pychromecast
import io
from gtts import gTTS

import socket  # used for default TTS host resolution

# ——— Load environment overrides ——————————————————————————
load_dotenv()
PORT           = int(os.getenv("PORT", 3000))
LOG_FILE       = os.getenv(
    "LOG_FILE",
    os.path.join(os.path.dirname(__file__), "events.txt")
)
MAX_LOG_BYTES  = int(os.getenv("MAX_LOG_BYTES", 20 * 1024 * 1024))  # 20 MB
CAST_DEVICE_NAMES = [
    name.strip()
    for name in os.getenv("CAST_DEVICES", "Ryan Office display").split(",")
]
# Default volume for notifications (0.0–1.0)
DEFAULT_VOLUME = float(os.getenv("CAST_VOLUME", 0.5))

# ——— Ensure log directory & file exist ——————————————————————
log_dir = os.path.dirname(LOG_FILE)
if (log_dir and not os.path.exists(log_dir)):
    os.makedirs(log_dir, exist_ok=True)
# Create the log file if it's missing
open(LOG_FILE, "a", encoding="utf-8").close()

# ——— Initialize Flask ——————————————————————————————————————
app = Flask(__name__)

# ——— Setup application logging —————————————————————————————
LOG_PATH = os.path.join(os.path.dirname(__file__), "app.log")
# Clear the log file at startup
with open(LOG_PATH, "w", encoding="utf-8") as f:
    pass
handler = RotatingFileHandler(LOG_PATH, maxBytes=5*1024*1024, backupCount=3, encoding="utf-8")
formatter = logging.Formatter('[%(asctime)s] %(levelname)s in %(module)s: %(message)s')
handler.setFormatter(formatter)
app.logger.addHandler(handler)
app.logger.setLevel(logging.DEBUG)

# Determine host/IP for TTS endpoint (accessible by Chromecast)
import socket
TTS_HOST = os.getenv("TTS_HOST")
if not TTS_HOST:
    try:
        TTS_HOST = socket.gethostbyname(socket.gethostname())
    except Exception:
        TTS_HOST = "127.0.0.1"
app.logger.debug(f"Using TTS server host: {TTS_HOST}")

# ——— Discover & connect to Chromecasts once at startup —————————
chromecasts = []
try:
    # Retry discovery up to 3 times with timeout and delay
    for attempt in range(3):
        app.logger.debug(f"Chromecast discovery attempt {attempt+1}/3")
        ccs, browser = pychromecast.get_listed_chromecasts(CAST_DEVICE_NAMES, timeout=5)
        if ccs:
            chromecasts = ccs
            break
        else:
            app.logger.debug("No devices found, retrying after delay")
            time.sleep(2)
    if not chromecasts:
        app.logger.warning(f"No Chromecasts found matching {CAST_DEVICE_NAMES!r} after retries")
    else:
        names = [getattr(cc, 'name', None) or getattr(cc.cast_info, 'friendly_name', None) for cc in chromecasts]
        app.logger.info(f"Discovered {len(chromecasts)} Chromecast(s): {names}")
        # Ensure each Chromecast is connected
        for cc in chromecasts:
            cc.wait(timeout=10)
    # Stop discovery to clean up Zeroconf
    browser.stop_discovery()
except Exception:
    app.logger.error("Error during Chromecast discovery:\n" + traceback.format_exc())
    # leave chromecasts=[] on failure

def get_cast_name(cast):
    return getattr(cast, 'friendly_name', None) or \
           getattr(cast, 'name', None) or \
           getattr(getattr(cast, 'device', None), 'friendly_name', None) or \
           '<unknown>'

# ——— TTS proxy endpoint —————————————————————————————————————
@app.route('/tts')
def proxy_tts():
    msg = request.args.get('msg')
    if not msg:
        return jsonify({"error": "msg parameter required"}), 400
    # generate TTS with gTTS
    try:
        tts = gTTS(text=msg, lang='en')
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        buf.seek(0)
        # return full mp3 bytes with Content-Length header to satisfy Chromecast
        mp3_data = buf.getvalue()
        return Response(mp3_data, mimetype='audio/mp3', headers={
            'Content-Length': str(len(mp3_data)),
            'Cache-Control': 'no-cache'
        })
    except Exception:
        app.logger.error("Error generating TTS:\n" + traceback.format_exc())
        return jsonify({"error": "TTS generation failed"}), 500

def speak_text(message: str):
    """
    Play TTS message on each Chromecast using Google Translate URL.
    """
    if not chromecasts:
        app.logger.warning("speak_text(): no devices to speak on")
        return

    # use local proxy for TTS with cache busting param so Chromecast fetches fresh media
    params = {
        'msg': message,
        'cb': str(int(time.time() * 1000))
    }
    tts_url = f"http://{TTS_HOST}:{PORT}/tts?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"

    for cc in chromecasts:
        try:
            # ensure Chromecast socket is ready
            cc.wait(timeout=10)
            app.logger.debug(f"[SPEAK_TEXT] media_controller ready for {get_cast_name(cc)}")
            app.logger.debug(f"[SPEAK_TEXT] Playing media on {get_cast_name(cc)}: {tts_url}")
            mc = cc.media_controller
            mc.play_media(tts_url, "audio/mp3")
            # wait for the controller to be active
            mc.block_until_active(timeout=10)
            app.logger.debug("[SPEAK_TEXT] media playback started")
            # wait until playback ends
            while mc.status.player_state == "PLAYING":
                time.sleep(0.1)
            app.logger.debug("[SPEAK_TEXT] media playback ended")
            mc.stop()
            cc.quit_app()
            app.logger.debug("[SPEAK_TEXT] media_controller stopped and app quit")
            name = getattr(cc, "friendly_name", None) or getattr(cc, "name", None)
            app.logger.info(f"Spoke on {name}")
        except Exception:
            name = getattr(cc, "friendly_name", None) or getattr(cc, "name", None)
            app.logger.error(f"Error speaking on {name}:\n" + traceback.format_exc())

# ——— HTTP POST endpoint —————————————————————————————————————————
@app.route("/api/seismic", methods=["POST"])
def log_seismic():
    # 1) Must be JSON
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    try:
        # 2) Parse & validate
        data = request.get_json()
        app.logger.debug(f"Payload: {data}")
        if "level" not in data or "deltaG" not in data:
            return jsonify({"error": "Invalid payload: 'level' and 'deltaG' required"}), 400

        # 3) Prepare log line
        ts    = datetime.utcnow().isoformat() + "Z"
        level = data["level"]
        delta = data["deltaG"]
        line  = f"{ts} level={level} deltaG={delta}\n"

        # 4) Rotate by size
        if os.path.getsize(LOG_FILE) >= MAX_LOG_BYTES:
            app.logger.warning("Log size limit reached; skipping write")
            return jsonify({"status": "skipped", "reason": "max size reached"}), 200

        # 5) Append to file
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        app.logger.info(f"Logged event: {level} Δg={delta:.2f}")

        # 6) Announce
        msg = f"Warning! Earthquake Detector admin, detected {level} quake, delta G {delta:.2f}"
        speak_text(msg)

        return jsonify({"status": "logged"}), 201

    except Exception:
        app.logger.error("Unhandled exception:\n" + traceback.format_exc())
        return jsonify({
            "error":   "Internal server error",
            "details": traceback.format_exc()
        }), 500

# ——— Run the server ———————————————————————————————————————
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
