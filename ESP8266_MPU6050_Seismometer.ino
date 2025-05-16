// ─────────────────────────────────────────────────────────────────────────────
//  ESP8266 MPU6050 Seismometer
// ─────────────────────────────────────────────────────────────────────────────

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050.h"
#include "arduino_secrets.h"     // SECRET_SSID, SECRET_PASS, URL

// I2C pins on NodeMCU
#define SDA_PIN D2  // GPIO4
#define SCL_PIN D1  // GPIO5

// Seismic thresholds (in g)
const float T_MINOR    = 0.035;
const float T_MODERATE = 0.10;
const float T_SEVERE   = 0.50;

MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  while (!Serial) { }

  // ─── Connect to Wi-Fi ────────────────────────────────────────────────
  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  int wifi_tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print('.');
    delay(300);
    if (++wifi_tries > 100) {
      Serial.println("\nWi-Fi failed, restarting...");
      ESP.restart();
    }
  }
  Serial.println();
  Serial.print("Wi-Fi connected, IP=");
  Serial.println(WiFi.localIP());

  // ─── Initialize MPU6050 ─────────────────────────────────────────────
  Wire.begin(SDA_PIN, SCL_PIN);
  mpu.initialize();
  mpu.setClockSource(MPU6050_CLOCK_PLL_XGYRO);
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_2);
  mpu.setDLPFMode(MPU6050_DLPF_BW_188);

  if (!mpu.testConnection()) {
    Serial.println("❌ MPU6050 not found! Check wiring.");
    while (1) delay(500);
  }
  Serial.println("✅ MPU6050 initialized.");
}

void loop() {
  // ─── Watchdog: reboot if Wi-Fi drops ────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost—rebooting...");
    ESP.restart();
  }

  // ─── Read raw accel ────────────────────────────────────────────────
  int16_t rawX, rawY, rawZ;
  mpu.getAcceleration(&rawX, &rawY, &rawZ);

  // ─── Convert to g ────────────────────────────────────────────────
  float ax = rawX / 16384.0;
  float ay = rawY / 16384.0;
  float az = rawZ / 16384.0;

  // ─── Serial Plotter format (Y,Z) ─────────────────────────────────
  Serial.print(ay, 3);
  Serial.print(',');
  Serial.println(az, 3);

  // ─── Compute Δg from rest (0,0,1) ─────────────────────────────────
  float dX = fabs(ax);
  float dY = fabs(ay);
  float dZ = fabs(az - 1.0);
  float dev = max(dX, max(dY, dZ));

  // ─── Trigger alarms & report ──────────────────────────────────────
  if (dev >= T_SEVERE) {
    Serial.printf("SEVERE quake! Δg=%.3f\n", dev);
    reportEvent("severe", dev);
  }
  else if (dev >= T_MODERATE) {
    Serial.printf("Moderate tremor. Δg=%.3f\n", dev);
    reportEvent("moderate", dev);
  }
  else if (dev >= T_MINOR) {
    Serial.printf("Minor vibration. Δg=%.3f\n", dev);
    reportEvent("minor", dev);
  }

  delay(50);
}

void reportEvent(const char* level, float dev) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  http.begin(client, URL);              // URL from arduino_secrets.h
  http.addHeader("Content-Type", "application/json");

  String body = String("{\"level\":\"") + level +
                String("\",\"deltaG\":") + String(dev, 3) +
                String("}");

  int code = http.POST(body);
  if (code == 201) {
    Serial.println("→ Event sent");
  } else {
    Serial.printf("! POST failed, code=%d\n", code);
  }
  http.end();
}
