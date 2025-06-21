#!/usr/bin/env python3
# server.py

import os
import json
import threading
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import traceback
# socket will be used to determine local LAN IP
import socket

# Performance tracking imports

# Configuration
PORT = int(os.getenv("PORT", 3000))
LOG_FILE = os.getenv(
    "LOG_FILE",
    os.path.join(os.path.dirname(__file__), "events.txt")
)
MAX_LOG_BYTES = int(os.getenv("MAX_LOG_BYTES", 20 * 1024 * 1024))  # 20 MB

translation_dict = {
    "48:55:19:ED:D8:9A": "Ryan Office",
    "48:55:19:ED:9B:A9": "Bonus Room",
    "C8:2B:96:23:21:BC": "Kitchen",
}

# Derive the list of devices to monitor
DEVICE_IDS = list(translation_dict.keys())

# Track last event times per device (unused for the window logic but retained)
last_event_times = {}

# Window-tracking globals
window_timer = None
window_devices = set()

# Record server start time
start_time = datetime.utcnow()

# Ensure log directory and file exist
log_dir = os.path.dirname(LOG_FILE)
if log_dir and not os.path.exists(log_dir):
    os.makedirs(log_dir, exist_ok=True)
open(LOG_FILE, "a", encoding="utf-8").close()

app = Flask(__name__)
CORS(app)

@app.route("/", methods=["GET"])
def root():
    """Simple health check for the root URL."""
    return jsonify({"status": "ok", "time": datetime.utcnow().isoformat() + "Z"}), 200

def on_window_end():
    """Called 2 seconds after the first event in the window."""
    global window_timer, window_devices

    print("----- end")

    # If every device reported in this window, confirm
    if set(DEVICE_IDS).issubset(window_devices):
        # Print in green
        print("\033[92mConfirmed!!!\033[0m")
        # Also log to file
        now_dt = datetime.utcnow()
        ts = now_dt.isoformat() + "Z"
        confirm_entry = {
            "timestamp": ts,
            "status": "CONFIRMED",
            "devices": DEVICE_IDS,
            "aliases": [translation_dict[d] for d in DEVICE_IDS]
        }
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(confirm_entry) + "\n")

    # Reset for the next window
    window_devices.clear()
    window_timer = None

@app.route("/api/seismic", methods=["POST"])
def log_seismic():
    global window_timer, window_devices

    # Must be JSON
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    try:
        # Parse & validate
        data = request.get_json()
        if "level" not in data or "deltaG" not in data:
            return jsonify({"error": "Invalid payload: 'level' and 'deltaG' required"}), 400

        # Extract device ID and alias
        device_id = data.get("id", "unknown")
        translation_dict.setdefault(device_id, "")
        alias = translation_dict[device_id]

        # Timestamp
        now_dt = datetime.utcnow()
        ts = now_dt.isoformat() + "Z"
        level = data["level"]
        delta = data["deltaG"]

        # Build and print the raw event
        log_entry = {
            "timestamp": ts,
            "level": level,
            "deltaG": delta,
            "id": device_id,
            "alias": alias
        }
        line = json.dumps(log_entry) + "\n"
        print(line.strip())

        # Rotate by size
        if os.path.getsize(LOG_FILE) >= MAX_LOG_BYTES:
            return jsonify({"status": "skipped", "reason": "max size reached"}), 200

        # Append raw event to log
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)

        # Update last-seen timestamp (for any other use)
        last_event_times[device_id] = now_dt

        # Add to this window's set
        window_devices.add(device_id)

        # If no timer is running, start one
        if window_timer is None:
            print("----- start")
            window_timer = threading.Timer(2.0, on_window_end)
            window_timer.start()

        return jsonify({"status": "logged"}), 201

    except Exception:
        return jsonify({
            "error":   "Internal server error",
            "details": traceback.format_exc()
        }), 500

@app.route("/api/init", methods=["GET"])
def init_config():
    """Initialization endpoint: returns heartbeat interval and sensitivity thresholds."""
    device_id = request.args.get("id")
    if not device_id:
        return jsonify({"error": "Missing id parameter"}), 400
    # ensure device known
    translation_dict.setdefault(device_id, "")
    # load configurable params (ms and g thresholds)
    heartbeat_interval = int(os.getenv("HEARTBEAT_INTERVAL", 60000))
    sens_minor = float(os.getenv("SENSITIVITY_MINOR", 0.035))
    sens_mod = float(os.getenv("SENSITIVITY_MODERATE", 0.10))
    sens_sev = float(os.getenv("SENSITIVITY_SEVERE", 0.50))
    config = {
        "heartbeat_interval": heartbeat_interval,
        "sensitivity": {
            "minor": sens_minor,
            "moderate": sens_mod,
            "severe": sens_sev
        }
    }
    return jsonify(config), 200

@app.route("/api/status", methods=["GET"])
def api_status():
    """Return online/offline status for each device based on last event time."""
    now = datetime.utcnow()
    hb = int(os.getenv("HEARTBEAT_INTERVAL", 60000)) / 1000.0
    status = {}
    for device in DEVICE_IDS:
        last = last_event_times.get(device)
        status[device] = "Online" if last and (now - last).total_seconds() <= 2 * hb else "Offline"
    return jsonify(status), 200

@app.route("/api/events", methods=["GET"])
def api_events():
    """Return all logged events from the log file."""
    events = []
    with open(LOG_FILE, "r", encoding="utf-8") as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except:
                continue
    return jsonify(events), 200

# Helper to determine local LAN IP
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # doesn't have to connect to succeed
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

@app.route("/api/info", methods=["GET"])
def api_info():
    """Return server hosting info, uptime, and local IP."""
    host_url = request.host_url
    uptime = (datetime.utcnow() - start_time).total_seconds()
    local_ip = get_local_ip()
    info = {
        "host_url": host_url,
        "api_port": PORT,
        "ui_port": int(os.getenv("UI_PORT", 8501)),
        "local_ip": local_ip,
        "uptime_seconds": uptime
    }
    return jsonify(info), 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
