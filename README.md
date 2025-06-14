# ESP8266 MPU6050 Seismometer

A simple, end-to-end earthquake detector using an ESP8266 (NodeMCU) + MPU6050 IMU, reporting seismic events to a local Python Flask server — no external cloud required.

---

## ⚙️ Repository Structure

```
.
├── .gitignore
├── LICENSE
├── README.md                     ← Updated README
├── ESP8266_MPU6050_Seismometer.ino  ← Arduino client sketch
├── arduino_secrets_template.h    ← copy to arduino_secrets.h
└── server
    ├── .env                      ← Environment vars (PORT, LOG_FILE, MAX_LOG_BYTES)
    ├── install.bat               ← Sets up venv & installs deps
    ├── requirements.txt          ← `Flask`, etc.
    ├── server.py                 ← Flask API + window-timer logic
    └── startup.bat               ← Run server on Windows startup
```

---

## 🔧 Configuration Variables

### Client (Arduino)
- **SECRET_SSID** / **SECRET_PASS**  
  Your Wi-Fi network credentials.  
- **URL**  
  HTTP POST endpoint for seismic events, e.g.  
  `http://<SERVER_IP>:3000/api/seismic`.  
- **ROOT_URL**  
  Base URL for health checks (must handle `GET /?id=<MAC>`).

All defined in `arduino_secrets.h` (copy from the provided template).

### Server (Python)
- **PORT**  
  TCP port for Flask to listen on (default 3000).  
- **LOG_FILE**  
  Path to your event log file (e.g. `seismic.log`).  
- **MAX_LOG_BYTES**  
  Maximum size (in bytes) before skipping writes (default 20 MB).

Define these in `server/.env` per the template.

---

## 🛠 Hardware & Wiring

1. **ESP8266 NodeMCU**  
2. **MPU6050** (3-axis accelerometer + gyroscope)  
3. **Wiring**  
   - MPU6050 SDA → D2 (GPIO4)  
   - MPU6050 SCL → D1 (GPIO5)  
   - VCC → 3.3 V  
   - GND → GND  

---

## 📟 Client: ESP8266 + MPU6050 Sketch

1. **Boot & Wi-Fi**  
   - Connects to your SSID/PASS and prints `IP=` on success.  
2. **LED Indicator**  
   - Uses onboard blue LED (`LED_BUILTIN`, GPIO2) **active-LOW**:  
     - **LOW** → LED ON (healthy)  
     - **HIGH** → LED OFF (error)  
3. **Sensor Setup & Calibration**  
   - Configures MPU6050 via I2C (±2 g, DLPF BW=188 Hz).  
   - Averages 2000 samples at 2 ms intervals to compute biases (meanX/Y/Z).  
4. **Main Loop**  
   - Every 50 ms:  
     - Reads raw accel → de-bias → converts to _g_ (`/16384`).  
     - Prints `Y,Z` to Serial Plotter (baud 115200).  
     - Computes `Δg = max(|ax|,|ay|,|az|)`.  
     - If above thresholds (0.035, 0.10, 0.50 g) it calls `reportEvent()`.

5. **Health Check (every 60 s)**  
   - Performs `HTTPClient.GET(ROOT_URL + "?id=" + MAC)`.  
   - **200 →** LED ON; **205 or any other code →** LED OFF + `ESP.restart()`.

6. **Event Reporting**  
   - Builds JSON:  
     ```json
     {
       "id": "<MAC>",
       "level": "minor|moderate|severe",
       "deltaG": 0.123
     }
     ```  
   - Posts to `URL`. On failure or non-201, turns LED OFF and restarts.

---

## 🖥️ Server: Python Flask API

1. **`GET /` (root)**  
   Returns:
   ```json
   { "status": "ok", "time": "<UTC ISO>" }
   ```
   for external monitoring.

2. **`POST /api/seismic`**  
   - Expects JSON:
     ```json
     { "id": "...", "level": "...", "deltaG": ... }
     ```
   - Logs each event with a UTC timestamp and alias (from `translation_dict`).
   - **Window Logic:**  
     - On the first event in a fresh window, prints `----- start`.  
     - Collects all device IDs seen in 2 s via `threading.Timer`.  
     - After 2 s, prints `----- end`. If **all** devices in `DEVICE_IDS` reported, logs/prints **green** `Confirmed!!!`.  

3. **Aliases**  
   Maps MAC → human name (e.g. “Ryan Office”) via `translation_dict`.

---

## ⚙️ Dependencies & Installation

### Client
- Arduino IDE with ESP8266 support.  
- MPU6050 + I2Cdev libraries.

### Server
```bash
cd server
install.bat        # on Windows, or:
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
startup.bat        # or: python server.py
```

---

## 🔄 Data Format

**Client →** `POST /api/seismic`
```json
{
  "id":     "<MAC>",
  "level":  "minor"|"moderate"|"severe",
  "deltaG": 0.123
}
```
**Server** writes each entry to `LOG_FILE` with:
- `"timestamp": "<UTC ISO>"`
- `"alias": "<human name>"`

When all devices report within a 2 s window, server appends:
```json
{
  "timestamp": "<UTC ISO>",
  "status":    "CONFIRMED",
  "devices":   ["<MAC1>","<MAC2>",…],
  "aliases":   ["<Name1>","<Name2>",…]
}
```

---

## 📜 License

Apache-2.0
