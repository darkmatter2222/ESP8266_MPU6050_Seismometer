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
    firmware.json                   ← {"version": "1.1.0", "built_at": "..."}
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
| POST   | `/api/seismic`                    | Log seismic event                                |
| GET    | `/api/init`                       | Device init — returns config + firmware info     |
| GET    | `/api/status`                     | Online/Offline + last_init + firmware_version    |
| GET    | `/api/events`                     | All seismic events from MongoDB                  |
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
  → Read accel, debias
  → If deltaG ≥ threshold → POST /api/seismic
  Every heartbeat_interval (default 60s):
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
