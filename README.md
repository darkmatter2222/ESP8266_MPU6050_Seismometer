# ESP8266 MPU6050 Seismometer

A simple, end-to-end earthquake/quake detector using an ESP8266 (NodeMCU) + MPU6050 IMU, reporting seismic events to a local Python server. Designed to run entirely on a home network—no external cloud required.

---

## ⚙️ Repository Structure

```
.
├── .gitignore
├── LICENSE
├── README.md                 ← (you are here)
├── ESP8266_MPU6050_Seismometer.ino
├── arduino_secrets_template.h
└── server
    ├── .env                   ← Environment variables (PORT, LOG_FILE, etc.)
    ├── install.bat            ← Sets up venv & installs Python deps
    ├── requirements.txt
    ├── server.py              ← Flask API endpoint
    └── startup.bat            ← Runs the server on Windows startup
```

---

## 🔧 Hardware & Wiring

- **ESP8266 NodeMCU** (or any ESP8266-based board)  
- **MPU6050** (3-axis accelerometer + gyro)  
- **Wiring**  
  - MPU6050 **SDA** → D2 (GPIO4)  
  - MPU6050 **SCL** → D1 (GPIO5)  
  - **VCC** → 3.3 V  
  - **GND** → GND  

---

## 📡 Client: ESP8266 + MPU6050

1. **Secrets file**  
   Copy `arduino_secrets_template.h` → `arduino_secrets.h` and edit:
   ```cpp
   #define SECRET_SSID  "YourSSID"
   #define SECRET_PASS  "YourPassword"
   #define URL          "http://<SERVER_IP>:3000/api/seismic"
   ```
2. **Open & Upload**  
   - Launch `ESP8266_MPU6050_Seismometer.ino` in the Arduino IDE.  
   - Select your ESP8266 board & COM port.  
   - Upload the sketch.  
3. **Serial Plotter**  
   - Open Tools → Serial Plotter at 115200 baud.  
   - You’ll see two channels (Y, Z) centered near zero; when Δg exceeds thresholds, human-readable alerts (`Minor`, `Moderate`, `SEVERE quake!`) are printed and sent via HTTP POST.

---

## 🖥️ Server: Python Flask API

1. **Configure**  
   In `server/.env` define:
   ```
   PORT=3000
   LOG_FILE=seismic.log
   ```
2. **Install dependencies**  
   ```bat
   cd server
   install.bat
   ```
   (Creates a `venv` & installs `-r requirements.txt`.)  
3. **Run server**  
   ```bat
   startup.bat
   ```
   _Or manually:_
   ```bash
   cd server
   .\venv\Scripts\activate
   python server.py
   ```
   The Flask app listens on your configured port and logs incoming events.  
4. **Auto-start**  
   Add `startup.bat` to Task Scheduler or your Startup folder for automatic launch at boot.

---

## 📝 Data Format

Client → `POST /api/seismic` with JSON:
```json
{
  "level":   "minor" | "moderate" | "severe",
  "deltaG":  0.123   // peak Δg value detected
}
```
The server timestamps each entry in `seismic.log`.

---

## 📄 License

This project is MIT-licensed; see [LICENSE](./LICENSE) for details.
