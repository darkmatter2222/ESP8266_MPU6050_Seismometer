# Seismometer Project — Agent Reference

This document is the authoritative reference for AI agents working on this codebase.
Read this before making any changes.

---

## Project Overview

An ESP8266-based seismic event detection system with:
- **3 wall-mounted NodeMCU devices** — Ryan Office, Bonus Room, Kitchen
- **Real-time dashboard** — React (Vite) + Recharts + Socket.IO on port 3000
- **Admin panel** — `/admin` route for per-device config, reinit, firmware status
- **MongoDB** — event storage and configuration (running on `192.168.86.48:27017`)
- **Server** — Node.js + Express (`server/server.js`) running in Docker

---

## Device MACs

| Alias        | MAC Address           |
|-------------|----------------------|
| Ryan Office | `48:55:19:ED:D8:9A`  |
| Bonus Room  | `48:55:19:ED:9B:A9`  |
| Kitchen     | `C8:2B:96:23:21:BC`  |

---

## Repository Layout

```
src/
  ESP8266_MPU6050_Seismometer.cpp   ← Device firmware (C++, PlatformIO)
  arduino_secrets.h                 ← WiFi credentials + server URL (gitignored)
  arduino_secrets_template.h        ← Template for secrets file
platformio.ini                      ← PlatformIO build config
server/
  server.js                         ← Production Node.js API server
  Dockerfile                        ← Multi-stage: React build → Node runtime
  docker-compose.yml                ← Single-service compose file
  frontend/src/
    App.jsx                         ← Main dashboard (879 lines, all chart logic)
    App.css                         ← Dashboard styles
    Admin.jsx                       ← Admin/config panel
    Admin.css
    main.jsx                        ← React root + ErrorBoundary
  firmware/                         ← Created by Deploy.ps1 on the server
    firmware.bin                    ← Built by PlatformIO, SCPed by Deploy.ps1
    firmware.json                   ← {"version": "1.2.0", "built_at": "..."}
Deploy.ps1                          ← Deploys server + firmware to remote host
.env                                ← SSH_USER, SSH_HOST, SSH_KEY_PATH (gitignored)
AGENT.md                            ← This file
```

---

## How to Deploy

### Full deploy (server + firmware):

1. **Build firmware** in PlatformIO IDE: `Ctrl+Alt+B`
   - Output: `.pio/build/nodemcuv2/firmware.bin`
2. **Run deploy script**:
   ```powershell
   powershell -ExecutionPolicy Bypass -NoProfile -File Deploy.ps1 -Bypassed
   ```
   The script:
   - SCPs all server files to `192.168.86.48:/home/<user>/seismometer/`
   - SCPs `firmware.bin` to `seismometer/firmware/firmware.bin`
   - Writes `firmware/firmware.json` with the version string
   - Runs `docker compose build --no-cache && docker compose up -d`
   - Dashboard live at `http://192.168.86.48:3000`

### Deploy server only (no firmware change):
Run `Deploy.ps1` without building firmware. It will warn about missing `.bin`
but still deploy the server, dashboard, and Docker config.

### Deploy firmware only (after server is already running):
Skip the Docker rebuild — just SCP the files manually if needed. Or:
- Deploy normally; Docker rebuild is fast since no code changes.

---

## OTA (Over-The-Air) Firmware Updates

### How it works

1. Each firmware build has a hardcoded `FIRMWARE_VERSION` string (e.g. `"1.1.0"`).
2. On every boot, the device calls `GET /api/init?id=<MAC>&version=1.1.0`.
3. The server reads `firmware/firmware.json` and compares versions.
4. If the server's version is **newer**, the response includes:
   ```json
   {
     "heartbeat_interval": 60000,
     "sensitivity": { ... },
     "firmware_version": "1.2.0",
     "firmware_url": "http://192.168.86.48:3000/api/firmware/latest.bin"
   }
   ```
5. The device calls `ESPhttpUpdate.update(client, firmwareUrl)` which:
   - Downloads the `.bin` to the OTA staging partition
   - Verifies the binary
   - Reboots automatically — new firmware runs immediately
6. On the next boot the device reports `version=1.2.0` — fully updated.

### To push a firmware update to all 3 devices

1. Make your firmware changes in `src/ESP8266_MPU6050_Seismometer.cpp`
2. **Bump** `#define FIRMWARE_VERSION "x.x.x"` in the firmware
3. **Bump** `$FIRMWARE_VERSION = "x.x.x"` in `Deploy.ps1` (must match)
4. Build in PlatformIO → Run `Deploy.ps1`
5. All 3 devices will self-update within one heartbeat cycle (~60 seconds each)

### Firmware version tracking on dashboard

- `GET /api/status` returns `firmware_version` per device (what the device last reported)
- `GET /api/firmware/version` returns `{ version, built_at, devices: { MAC: version } }`
- Dashboard node chips show `v1.1.0` badge next to each device name
- Admin panel shows "Firmware: v1.1.0" in each device card

### Firmware file endpoints

| Endpoint                        | Description                              |
|--------------------------------|------------------------------------------|
| `GET /api/firmware/latest.bin` | Serves the compiled firmware binary      |
| `GET /api/firmware/version`    | Returns version metadata + per-device reported versions |

---

## Server API

| Method | Endpoint                          | Description                                      |
|--------|----------------------------------|--------------------------------------------------|
| GET    | `/`                               | Heartbeat (device sends `?id=MAC`)               |
| POST   | `/api/seismic`                    | Log seismic event (with optional waveform)       |
| GET    | `/api/init`                       | Device init - returns config + firmware info     |
| GET    | `/api/status`                     | Online/Offline + last_init + firmware_version    |
| GET    | `/api/events`                     | All seismic events (waveform excluded for perf)  |
| GET    | `/api/events/:id/waveform`        | Waveform data for a specific event               |
| GET    | `/api/config`                     | Global + per-device config from MongoDB          |
| PUT    | `/api/config`                     | Save config                                      |
| POST   | `/api/config/reinit/:deviceId`    | Queue 205 reinit for a device                    |
| POST   | `/api/config/reinit-all`          | Queue 205 for all devices                        |
| GET    | `/api/firmware/version`           | Server firmware version + device reported versions |
| GET    | `/api/firmware/latest.bin`        | Download firmware binary                         |

---

## Firmware Lifecycle (Normal Operation)

```
Boot
  → WiFi connect
  → GET /api/init?id=MAC&version=FIRMWARE_VERSION
      ← config JSON + (if newer: firmware_version + firmware_url)
  → OTA check: if server version ≠ local version
      → ESPhttpUpdate.update()   ← downloads, flashes, REBOOTS (loops back to Boot)
  → MPU6050 init
  → Calibration (2000 samples, ~4 seconds)
Loop (every 50ms):
  → Read accel, debias, write to ring buffer (60-sample circular)
  → If deltaG ≥ threshold AND not already capturing:
      → Start post-event capture (60 more samples = 3 seconds)
      → Track peak deltaG during capture window
  → When post-capture complete:
      → Build JSON with waveform: [[relative_ms, ax, ay, az], ...]
      → POST /api/seismic (with event_offset_ms for timestamp accuracy)
      → Reset ring buffer
  Every heartbeat_interval (default 60s, skipped during capture):
  → GET /?id=MAC
      ← 200 OK (healthy) | 205 (server wants reinit → ESP.restart())
```

---

## Dashboard Architecture

- **React 18 + Vite** — `server/frontend/`
- **Recharts 2.15** — ScatterChart with `Customized` component for pixel-accurate coordinate mapping
- **Socket.IO** — real-time seismic events, heartbeats, reinit lifecycle events
- **Ref-based interaction** — all drag/zoom/pan state in refs to avoid stale closures
- **Overlay div** — `position:absolute; inset:0; z-index:5` inside `chart-wrapper` captures mouse events
- **Tool modes**: zoom, pan, range, inspect (crosshair + hover popup)
- **Color modes**: level, device, gradient (gradient rescales to visible zoom window)

---

## Important Notes

- **`arduino_secrets.h`** is gitignored. Uses `ROOT_URL` (e.g. `http://192.168.86.48:3000/`)
  and `URL` for the seismic POST endpoint.
- **`server/.env`** is gitignored. Contains SSH credentials for Deploy.ps1.
- **MongoDB** runs on the host (not in Docker). Container connects via `MONGO_URI`.
- The **volume mount** `./firmware:/app/firmware` means no Docker rebuild is ever
  needed for a firmware-only update — just SCP the files and the server serves them live.
- **OTA flash partition**: NodeMCU v2 (4MB flash) supports OTA natively. Current sketch
  is small — plenty of room for the OTA staging partition.

---

## Waveform Capture System (v1.2.0)

### How it works

1. **Ring buffer**: Device continuously stores last 3 seconds (~60 samples at 20Hz)
   of accelerometer data (ax, ay, az) in a circular buffer.
2. **Event trigger**: When ΔG exceeds a threshold, the device enters "capture" mode.
   The ring buffer is frozen (pre-event data preserved).
3. **Post-capture**: Device continues sampling for 3 more seconds into a linear buffer,
   tracking the peak ΔG during the entire capture window.
4. **Upload**: After post-capture, the device builds a JSON payload with:
   - The event metadata (level, peak deltaG, device ID)
   - `event_offset_ms` — how many ms ago the event actually occurred
   - `waveform` — array of `[relative_ms, ax, ay, az]` tuples (120 samples)
5. **Server**: Stores waveform in MongoDB with the event. Emits socket event
   WITHOUT waveform (bandwidth). Frontend fetches waveform on-demand.
6. **Dashboard**: Event modal shows "View Waveform" button → fetches from
   `GET /api/events/:id/waveform` → renders interactive seismograph chart.

### Waveform data format

```json
{
  "id": "48:55:19:ED:D8:9A",
  "level": "moderate",
  "deltaG": 0.1234,
  "event_offset_ms": 3050,
  "waveform": [
    [-2950, 0.0012, -0.0005, 0.0003],
    [-2900, 0.0015, -0.0008, 0.0001],
    [0, 0.1234, 0.0800, 0.0100],
    [50, 0.0900, 0.0600, 0.0080],
    [3000, 0.0010, -0.0002, 0.0005]
  ]
}
```

Each waveform sample: `[time_relative_to_event_ms, ax, ay, az]`

### Dashboard waveform viewer

- **3-Axis mode**: Shows X (red), Y (green), Z (blue) acceleration traces
- **ΔG mode**: Shows max(|ax|, |ay|, |az|) as single trace
- Vertical dashed line marks event detection point
- Tooltip shows exact time offset and acceleration values
- Events in range table show 📊 indicator when waveform is available

### Memory budget (ESP8266)

- Pre-buffer: 60 × 16 bytes = 960 bytes
- Post-buffer: 60 × 16 bytes = 960 bytes
- JSON payload: ~5KB (String with reserve(12000))
- Total static: ~1.9KB, total dynamic: ~12KB during upload
