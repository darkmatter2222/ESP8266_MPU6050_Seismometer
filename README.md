# ESP8266 MPU6050 Seismometer

![Infographic](images/infographic.png)
![Infographic](images/node.jpg)

---

A comprehensive, step-by-step guide to building, deploying, and debugging your ESP8266 + MPU6050 seismometer project entirely in Visual Studio Code.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Overview](#repository-overview)
3. [Setting Up Visual Studio Code](#setting-up-visual-studio-code)
   - [Installing VS Code](#installing-vs-code)
   - [Essential Extensions](#essential-extensions)
   - [Configuring Settings](#configuring-settings)
4. [Configuring the Arduino/ESP8266 Environment](#configuring-the-arduinoesp8266-environment)
   - [PlatformIO Project Setup](#platformio-project-setup)
   - [platformio.ini Explained](#platformioini-explained)
   - [Managing Libraries](#managing-libraries)
5. [Client Sketch (ESP8266 MPU6050 Code)](#client-sketch-esp8266-mpu6050-code)
6. [Server Setup (Flask API)](#server-setup-flask-api)
7. [Working with the Serial Monitor](#working-with-the-serial-monitor)
8. [Debugging and Deployment](#debugging-and-deployment)
9. [Troubleshooting Common Issues](#troubleshooting-common-issues)
10. [License](#license)

---

## Prerequisites

- **Visual Studio Code** installed on your system  
- **Python 3.7+** (for Flask server)  
- **NodeMCU (ESP8266)** board & **MPU6050** sensor module  
- **USB cable** for flashing ESP8266

---

## Repository Overview

```
ESP8266_MPU6050_Seismometer/
├── lib/                        # Third-party Arduino libraries
├── src/                        # Client .cpp sketch
│   └── ESP8266_MPU6050_Seismometer.cpp
├── server/                     # Flask server files
│   ├── .env
│   ├── install.bat
│   ├── requirements.txt
│   ├── server.py
│   └── startup.bat
├── platformio.ini              # PlatformIO project config
├── .gitignore
└── LICENSE
```

---

## Setting Up Visual Studio Code

### Installing VS Code

1. Download the installer from [Visual Studio Code](https://code.visualstudio.com/) and follow the standard installation process.  
2. Launch VS Code once installed.

### Essential Extensions

Install these from the Extensions view (`Ctrl+Shift+X`):

- **PlatformIO IDE** for embedded development with ESP8266 citeturn2search0  
- **C/C++ Extension Pack** for IntelliSense and debugging citeturn2search8  
- **Python (ms-python.python)** for Flask and scripting citeturn3search1  

### Configuring Settings

1. Open **Settings** (`Ctrl+,`).  
2. Enable **PlatformIO › IDE: Toolbar** to see Build/Upload icons.  
3. Set `python.pythonPath` to your interpreter (e.g., `${workspaceFolder}/.venv/bin/python`).  

---

## Configuring the Arduino/ESP8266 Environment

### PlatformIO Project Setup

1. Verify `platformio.ini` is present at the root.  
2. Open the folder in VS Code—look for the PlatformIO alien-head icon.  
3. Use **PlatformIO: Build** (checkmark) to compile, and **PlatformIO: Upload** (arrow) to flash citeturn2search1turn2search2.

### platformio.ini Explained

```ini
[platformio]
default_envs = nodemcuv2

[env:nodemcuv2]
platform      = espressif8266
board         = nodemcuv2
framework     = arduino
monitor_speed = 115200
lib_deps =
  jrowberg/I2Cdev @ ^1.1.0
  adafruit/MPU6050 @ ^1.4.3
```

- `default_envs` sets the environment for builds.  
- `board` and `platform` define toolchains for NodeMCU citeturn2search7.  
- `lib_deps` auto-downloads I2Cdev and MPU6050 libraries.

### Managing Libraries

- Place local libraries in `lib/`, or use `lib_deps` in `platformio.ini`.  
- After editing `platformio.ini`, PlatformIO fetches/update dependencies automatically when building.

---

## Client Sketch (ESP8266 MPU6050 Code)

See `src/ESP8266_MPU6050_Seismometer.cpp` for:

1. **Wi-Fi Connection** & MAC ID report  
2. **MPU6050 Initialization** & calibration  
3. **Event Detection** (`minor`, `moderate`, `severe`)  
4. **Health Check** every 60s with HTTP GET to `ROOT_URL?id=<MAC>`  
5. **JSON POST** of events to server endpoint  

---

## Server Setup (Flask API)

1. Change into `server/` directory.  
2. Copy `.env.example` to `.env` and set `PORT`, `LOG_FILE`, `MAX_LOG_BYTES`.  
3. Run `install.bat` (Windows) or:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
4. Start server: `python server.py` or `startup.bat`.  

---

## Working with the Serial Monitor

- **PlatformIO Monitor**: click the plug icon or run `PlatformIO: Monitor`. citeturn2search3  
- Serial output shows real-time accelerometer Y,Z and boot/health messages.

---

## Debugging and Deployment

- Set breakpoints in `server.py` and press **F5** to run Flask in debug mode.  
- Use **Debug Console** to inspect variables during runtime.  

---

## Troubleshooting Common Issues

- **COM Port Access Denied:** close other serial monitors or run VS Code as Administrator.  
- **Long Path Errors:** move project to a shorter path (e.g., `C:\Projects\ESPSeismo`) or enable Windows long paths via Group Policy citeturn3search10.  

---

## License

This project is licensed under the Apache-2.0 License.
