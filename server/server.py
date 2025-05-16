import os
import traceback
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, request, jsonify

# ——— Load environment overrides ——————————————————————
load_dotenv()
PORT          = int(os.getenv("PORT", 3000))
LOG_FILE      = os.getenv("LOG_FILE", os.path.join(os.path.dirname(__file__), "events.txt"))
MAX_LOG_BYTES = int(os.getenv("MAX_LOG_BYTES", 20 * 1024 * 1024))  # 20 MB

# ——— Ensure log directory & file exist ————————————————————
log_dir = os.path.dirname(LOG_FILE)
if log_dir and not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)
# open in append mode will create the file if it doesn't exist
open(LOG_FILE, "a", encoding="utf-8").close()

# ——— Initialize Flask ——————————————————————————————————
app = Flask(__name__)

# ——— Endpoint —————————————————————————————————————————
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

        # 4) Check file size
        if os.path.getsize(LOG_FILE) >= MAX_LOG_BYTES:
            app.logger.warning("Log size limit reached; skipping write")
            return jsonify({"status": "skipped", "reason": "max size reached"}), 200

        # 5) Append to file
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)

        return jsonify({"status": "logged"}), 201

    except Exception as e:
        # Unexpected errors
        app.logger.error("Unhandled exception:\n" + traceback.format_exc())
        return jsonify({
            "error":   "Internal server error",
            "details": str(e)
        }), 500

# ——— Run the server —————————————————————————————————————
if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.DEBUG)
    app.run(host="0.0.0.0", port=PORT)
