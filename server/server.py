#!/usr/bin/env python3
# server.py

import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
import traceback

# Configuration
PORT = int(os.getenv("PORT", 3000))
LOG_FILE = os.getenv(
    "LOG_FILE",
    os.path.join(os.path.dirname(__file__), "events.txt")
)
MAX_LOG_BYTES = int(os.getenv("MAX_LOG_BYTES", 20 * 1024 * 1024))  # 20 MB

# Global translation dict for MAC address aliases
translation_dict = {}

# Ensure log directory and file exist
log_dir = os.path.dirname(LOG_FILE)
if log_dir and not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)
# Create the log file if it's missing
open(LOG_FILE, "a", encoding="utf-8").close()

app = Flask(__name__)

@app.route("/api/seismic", methods=["POST"])
def log_seismic():
    # Must be JSON
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    try:
        # Parse & validate
        data = request.get_json()
        if "level" not in data or "deltaG" not in data:
            return jsonify({"error": "Invalid payload: 'level' and 'deltaG' required"}), 400

        # Extract new id (MAC) and maintain translation dict
        device_id = data.get("id", "unknown")
        # Ensure entry exists in translation dict (blank alias for now)
        translation_dict.setdefault(device_id, "")

        # Prepare timestamp
        ts = datetime.utcnow().isoformat() + "Z"
        level = data["level"]
        delta = data["deltaG"]

        # Build log line including id and translation dict
        log_entry = {
            "timestamp": ts,
            "level": level,
            "deltaG": delta,
            "id": device_id,
            "translations": translation_dict
        }
        line = json.dumps(log_entry) + "\n"

        # Print to console
        print(line.strip())

        # Rotate by size
        if os.path.getsize(LOG_FILE) >= MAX_LOG_BYTES:
            return jsonify({"status": "skipped", "reason": "max size reached"}), 200

        # Append to file
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        return jsonify({"status": "logged"}), 201

    except Exception:
        return jsonify({
            "error":   "Internal server error",
            "details": traceback.format_exc()
        }), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
