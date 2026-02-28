#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266httpUpdate.h>
#include <Wire.h>
#include "I2Cdev.h"
#include "MPU6050.h"
#include "arduino_secrets.h"     // must define SECRET_SSID, SECRET_PASS, URL, ROOT_URL
#include <ArduinoJson.h>

// OTA firmware version - bump this string whenever new firmware is deployed
#define FIRMWARE_VERSION "1.2.0"

// I2C pins on NodeMCU
#define SDA_PIN D2  // GPIO4
#define SCL_PIN D1  // GPIO5

// Onboard blue LED is GPIO2 (D4), active LOW
#define LED_PIN LED_BUILTIN

// Seismic thresholds (in g)
unsigned long heartbeatInterval = 60000;  // ms
float sensMinor = 0.035;
float sensModerate = 0.10;
float sensSevere = 0.50;

// How many samples to "sit still" for software calibration
const int   CALIB_SAMPLES = 2000;
const float SCALE = 16384.0;  // LSB per g at +/-2g range

MPU6050 mpu;
float meanX, meanY, meanZ;    // raw-LSB bias measured at rest
String deviceId;

// Interval for connectivity check (ms)
const unsigned long CONNECTIVITY_INTERVAL = 60UL * 1000UL;  // 1 minute
unsigned long lastConnectivityCheck = 0;

// -- Waveform ring buffer ---------------------------------------------------
// Pre-event: circular buffer holding last ~3 seconds at ~20Hz
// Post-event: linear buffer capturing ~3 seconds after trigger
const int PRE_SAMPLES  = 60;   // 3 seconds at ~20Hz (delay 50ms)
const int POST_SAMPLES = 60;   // 3 seconds after event

struct WaveSample {
  unsigned long ms;    // millis() timestamp
  float ax, ay, az;    // bias-corrected acceleration in g
};

WaveSample preBuffer[PRE_SAMPLES];
int preHead  = 0;
int preCount = 0;

// Post-event capture state
bool waveCapturing = false;
WaveSample postBuffer[POST_SAMPLES];
int postCount = 0;
String capturedLevel;
float  capturedDeltaG;
unsigned long capturedEventTime;  // millis() when event first triggered

// Function declarations
void setup();
void loop();
void startCapture(const char* level, float dev, unsigned long eventTime);
void uploadWaveformEvent();

void setup() {
  Serial.begin(115200);
  while (!Serial) { }

  // Initialize LED pin
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);  // LED off until we're fully up

  // --- Connect to Wi-Fi ---
  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print('.');
    delay(300);
    if (++tries > 100) {
      Serial.println("\nWi-Fi failed, rebooting...");
      digitalWrite(LED_PIN, HIGH);
      ESP.restart();
    }
  }
  Serial.println();
  Serial.printf("Wi-Fi connected, IP=%s\n", WiFi.localIP().toString().c_str());
  digitalWrite(LED_PIN, LOW);  // LED on: we're connected

  // --- Grab and log our MAC for use as "self-ID" ---
  deviceId = WiFi.macAddress();
  Serial.printf("Device MAC (self-ID): %s\n", deviceId.c_str());

  // --- Initialization API call ---
  HTTPClient initHttp;
  WiFiClient initClient;
  // Include current firmware version so server can track what each device is running
  String initUrl = String(ROOT_URL) + "api/init?id=" + deviceId + "&version=" + FIRMWARE_VERSION;
  Serial.printf("Fetching init config from %s ... ", initUrl.c_str());
  initHttp.begin(initClient, initUrl);
  int initCode = initHttp.GET();
  if (initCode != HTTP_CODE_OK) {
    Serial.printf("Failed HTTP %d, rebooting...\n", initCode);
    digitalWrite(LED_PIN, HIGH);
    ESP.restart();
  }
  String payload = initHttp.getString();
  initHttp.end();
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.println("JSON parse error, rebooting...");
    ESP.restart();
  }
  heartbeatInterval = doc["heartbeat_interval"];
  sensMinor = doc["sensitivity"]["minor"];
  sensModerate = doc["sensitivity"]["moderate"];
  sensSevere = doc["sensitivity"]["severe"];
  Serial.printf("Config: heartbeatInterval=%lu, sensMinor=%.3f, sensModerate=%.3f, sensSevere=%.3f\n",
                heartbeatInterval, sensMinor, sensModerate, sensSevere);

  // --- OTA Update Check ---
  const char* serverFwVersion = doc["firmware_version"] | "";
  const char* firmwareUrl     = doc["firmware_url"]     | "";
  if (strlen(serverFwVersion) > 0 && strlen(firmwareUrl) > 0 &&
      strcmp(serverFwVersion, FIRMWARE_VERSION) != 0) {
    Serial.printf("OTA update available: %s -> %s\n", FIRMWARE_VERSION, serverFwVersion);
    Serial.printf("Downloading from: %s\n", firmwareUrl);
    WiFiClient otaClient;
    t_httpUpdate_return ret = ESPhttpUpdate.update(otaClient, firmwareUrl);
    switch (ret) {
      case HTTP_UPDATE_FAILED:
        Serial.printf("OTA FAILED (%d): %s\n",
          ESPhttpUpdate.getLastError(),
          ESPhttpUpdate.getLastErrorString().c_str());
        break;
      case HTTP_UPDATE_NO_UPDATES:
        Serial.println("OTA: Server says no update.");
        break;
      default:
        break;
    }
    Serial.println("Continuing with current firmware after OTA attempt.");
  } else {
    Serial.printf("Firmware up to date: %s\n", FIRMWARE_VERSION);
  }
  delay(500);

  // --- Setup MPU6050 ---
  Wire.begin(SDA_PIN, SCL_PIN);
  mpu.initialize();
  mpu.setClockSource(MPU6050_CLOCK_PLL_XGYRO);
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_2);
  mpu.setDLPFMode(MPU6050_DLPF_BW_188);
  if (!mpu.testConnection()) {
    Serial.println("MPU6050 not found! Check wiring.");
    digitalWrite(LED_PIN, HIGH);
    while (1) delay(500);
  }
  Serial.println("MPU6050 initialized.");

  // --- Software-Calibrate Bias ---
  Serial.println("Keep sensor perfectly still - calibrating...");
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

  lastConnectivityCheck = millis();
}

void loop() {
  unsigned long now = millis();

  // --- Wi-Fi watchdog ---
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost - rebooting...");
    digitalWrite(LED_PIN, HIGH);
    ESP.restart();
  }

  // --- Connectivity check (skip during waveform capture for smooth sampling) ---
  if (!waveCapturing && now - lastConnectivityCheck >= heartbeatInterval) {
    lastConnectivityCheck = now;
    HTTPClient http;
    WiFiClient client;

    String healthUrl = String(ROOT_URL) + "?id=" + deviceId;
    Serial.printf("Checking server connectivity to %s ... ", healthUrl.c_str());

    http.begin(client, healthUrl);
    int code = http.GET();
    http.end();

    if (code == HTTP_CODE_OK) {
      Serial.println("OK");
      digitalWrite(LED_PIN, LOW);
    }
    else if (code == 205) {
      Serial.println("Received 205 - rebooting...");
      digitalWrite(LED_PIN, HIGH);
      ESP.restart();
    }
    else {
      Serial.printf("FAILED (HTTP %d) - rebooting...\n", code);
      digitalWrite(LED_PIN, HIGH);
      ESP.restart();
    }
  }

  // --- Read & de-bias raw accel ---
  int16_t rawX, rawY, rawZ;
  mpu.getAcceleration(&rawX, &rawY, &rawZ);
  float ax = (rawX - meanX) / SCALE;
  float ay = (rawY - meanY) / SCALE;
  float az = (rawZ - meanZ) / SCALE;

  // --- Serial plotter output ---
  Serial.print(ay, 3); Serial.print(','); Serial.println(az, 3);

  // --- Compute delta-g ---
  float dev = max(fabs(ax), max(fabs(ay), fabs(az)));

  // --- Waveform capture state machine ---
  if (!waveCapturing) {
    // IDLE: write to pre-event ring buffer
    preBuffer[preHead] = { now, ax, ay, az };
    preHead = (preHead + 1) % PRE_SAMPLES;
    if (preCount < PRE_SAMPLES) preCount++;

    // Check thresholds - start capture on event
    if      (dev >= sensSevere)   startCapture("severe",   dev, now);
    else if (dev >= sensModerate) startCapture("moderate", dev, now);
    else if (dev >= sensMinor)    startCapture("minor",    dev, now);
  } else {
    // CAPTURING: accumulate post-event samples
    // Track peak during capture window
    if (dev > capturedDeltaG) {
      capturedDeltaG = dev;
      if      (dev >= sensSevere)   capturedLevel = "severe";
      else if (dev >= sensModerate) capturedLevel = "moderate";
    }
    postBuffer[postCount] = { now, ax, ay, az };
    postCount++;
    if (postCount >= POST_SAMPLES) {
      // Done capturing - upload full waveform
      uploadWaveformEvent();
      waveCapturing = false;
      postCount = 0;
      // Reset ring buffer so stale data isn't reused
      preCount = 0;
      preHead = 0;
    }
  }

  delay(50);
}

void startCapture(const char* level, float dev, unsigned long eventTime) {
  waveCapturing = true;
  capturedLevel = level;
  capturedDeltaG = dev;
  capturedEventTime = eventTime;
  postCount = 0;
  Serial.printf(">> Event detected: %s (%.4fg) - capturing waveform for 3s...\n", level, dev);
}

void uploadWaveformEvent() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost during waveform upload - rebooting...");
    digitalWrite(LED_PIN, HIGH);
    ESP.restart();
  }

  // How many ms ago the event was detected (server uses this to compute real timestamp)
  unsigned long offsetMs = millis() - capturedEventTime;

  // Build JSON with waveform array: [[relative_ms, ax, ay, az], ...]
  // Pre-allocate String to avoid fragmentation (~12KB max)
  String body;
  body.reserve(12000);

  body += "{\"id\":\"";
  body += deviceId;
  body += "\",\"level\":\"";
  body += capturedLevel;
  body += "\",\"deltaG\":";
  body += String(capturedDeltaG, 4);
  body += ",\"event_offset_ms\":";
  body += String(offsetMs);
  body += ",\"waveform\":[";

  // Pre-event samples from ring buffer (oldest first)
  int start = (preHead - preCount + PRE_SAMPLES) % PRE_SAMPLES;
  for (int i = 0; i < preCount; i++) {
    int idx = (start + i) % PRE_SAMPLES;
    WaveSample& s = preBuffer[idx];
    int relTime = (int)((long)s.ms - (long)capturedEventTime);
    if (i > 0) body += ",";
    body += "[";
    body += String(relTime);
    body += ",";
    body += String(s.ax, 4);
    body += ",";
    body += String(s.ay, 4);
    body += ",";
    body += String(s.az, 4);
    body += "]";
  }

  // Post-event samples (the event trigger is at t=0 boundary)
  for (int i = 0; i < postCount; i++) {
    WaveSample& s = postBuffer[i];
    int relTime = (int)((long)s.ms - (long)capturedEventTime);
    if (preCount > 0 || i > 0) body += ",";
    body += "[";
    body += String(relTime);
    body += ",";
    body += String(s.ax, 4);
    body += ",";
    body += String(s.ay, 4);
    body += ",";
    body += String(s.az, 4);
    body += "]";
  }

  body += "]}";

  Serial.printf(">> Uploading waveform: %s, peak=%.4fg, %d pre + %d post samples, %d bytes\n",
                capturedLevel.c_str(), capturedDeltaG, preCount, postCount, body.length());

  WiFiClient client;
  HTTPClient http;
  http.begin(client, URL);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  http.end();

  if (code < 0) {
    Serial.printf("! POST error (%d) - rebooting...\n", code);
    digitalWrite(LED_PIN, HIGH);
    ESP.restart();
  }
  else if (code != 201) {
    Serial.printf("! POST returned %d\n", code);
    digitalWrite(LED_PIN, HIGH);
  }
  else {
    Serial.println(">> Waveform event sent successfully");
  }
}