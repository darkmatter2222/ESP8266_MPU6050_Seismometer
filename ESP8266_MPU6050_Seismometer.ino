#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050.h"
#include "arduino_secrets.h"     // must define SECRET_SSID, SECRET_PASS, URL

// I2C pins on NodeMCU
#define SDA_PIN D2  // GPIO4
#define SCL_PIN D1  // GPIO5

// Seismic thresholds (in g)
const float T_MINOR    = 0.035;
const float T_MODERATE = 0.10;
const float T_SEVERE   = 0.50;

// How many samples to “sit still” for software calibration
const int   CALIB_SAMPLES = 2000;
const float SCALE = 16384.0;  // LSB per g at ±2g range

MPU6050 mpu;

// These hold the raw-LSB bias we measured at rest
float meanX, meanY, meanZ;

// Store the MAC address once we’ve connected
String deviceId;

void setup() {
  Serial.begin(115200);
  while (!Serial) { }

  // ─── Connect to Wi-Fi ──────────────────────────────────────────
  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print('.');
    delay(300);
    if (++tries > 100) {
      Serial.println("\nWi-Fi failed, rebooting…");
      ESP.restart();
    }
  }
  Serial.println();
  Serial.printf("Wi-Fi connected, IP=%s\n", WiFi.localIP().toString().c_str());

  // ─── Grab and log our MAC for use as “self-ID” ───────────────────
  deviceId = WiFi.macAddress();  
  Serial.printf("Device MAC (self-ID): %s\n", deviceId.c_str());

  // ─── Setup MPU6050 ─────────────────────────────────────────────
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

  // ─── Software-Calibrate Bias ──────────────────────────────────
  Serial.println("Keep sensor perfectly still — calibrating...");
  double sumX=0, sumY=0, sumZ=0;
  for (int i = 0; i < CALIB_SAMPLES; i++) {
    int16_t rx, ry, rz;
    mpu.getAcceleration(&rx, &ry, &rz);
    sumX += rx; sumY += ry; sumZ += rz;
    delay(2);
  }
  meanX = sumX / CALIB_SAMPLES;
  meanY = sumY / CALIB_SAMPLES;
  meanZ = sumZ / CALIB_SAMPLES;
  Serial.printf("Calibration complete: mean raw = (%.1f, %.1f, %.1f)\n",
                meanX, meanY, meanZ);
  delay(500);
}

void loop() {
  // ─── Wi-Fi watchdog ────────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost — rebooting…");
    ESP.restart();
  }

  // ─── Read & de-bias raw accel ─────────────────────────────────
  int16_t rawX, rawY, rawZ;
  mpu.getAcceleration(&rawX, &rawY, &rawZ);
  float ax = (rawX - meanX) / SCALE;
  float ay = (rawY - meanY) / SCALE;
  float az = (rawZ - meanZ) / SCALE;

  // ─── Plotter output: Y,Z (zero-centered at rest) ─────────────
  Serial.print(ay, 3); Serial.print(','); Serial.println(az, 3);

  // ─── Compute Δg and trigger ──────────────────────────────────
  float dev = max(fabs(ax), max(fabs(ay), fabs(az)));
  if      (dev >= T_SEVERE)   reportEvent("severe",   dev);
  else if (dev >= T_MODERATE) reportEvent("moderate", dev);
  else if (dev >= T_MINOR)    reportEvent("minor",    dev);

  delay(50);
}

void reportEvent(const char* level, float dev) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost during POST — rebooting…");
    ESP.restart();
  }

  WiFiClient client;
  HTTPClient http;
  http.begin(client, URL);
  http.addHeader("Content-Type", "application/json");

  // build JSON including our MAC as id
  String body = String("{")
                + "\"id\":\""     + deviceId       + "\","
                + "\"level\":\""  + level          + "\","
                + "\"deltaG\":"   + String(dev, 3) 
                + "}";

  int code = http.POST(body);
  http.end();

  if      (code < 0)  { Serial.printf("! POST error (%d) — rebooting…\n", code); ESP.restart(); }
  else if (code != 201){ Serial.printf("! POST returned %d\n", code); }
  else               { Serial.println("→ Event sent"); }
}
