#!/usr/bin/env node
// server.js – Express API for Seismometer Dashboard
// Drop-in replacement for Flask server.py — fully ESP8266-compatible

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Configuration ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'data', 'events.txt');
const MAX_LOG_BYTES = parseInt(process.env.MAX_LOG_BYTES || String(20 * 1024 * 1024), 10);

// Device translation dictionary (MAC → human name)
const translationDict = {
  '48:55:19:ED:D8:9A': 'Ryan Office',
  '48:55:19:ED:9B:A9': 'Bonus Room',
  'C8:2B:96:23:21:BC': 'Kitchen',
};
const DEVICE_IDS = Object.keys(translationDict);

// In-memory state
const lastEventTimes = {};          // deviceId → Date
const startTime = new Date();
let httpLogs = [];                  // { timestamp, endpoint }
let windowTimer = null;
let windowDevices = new Set();

// ── Ensure log file exists ───────────────────────────────────────
const logDir = path.dirname(LOG_FILE);
if (logDir && !fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');

// ── Express setup ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// HTTP traffic logging middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    httpLogs.push({ timestamp: new Date().toISOString(), endpoint: req.path });
    if (httpLogs.length > 10000) httpLogs = httpLogs.slice(-5000);
  }
  next();
});

// ── ESP8266 heartbeat (must come before static middleware) ───────
app.get('/', (req, res, next) => {
  if (req.query.id) {
    const id = req.query.id;
    if (!translationDict[id]) translationDict[id] = id;
    lastEventTimes[id] = new Date();
    return res.json({ status: 'ok', time: new Date().toISOString() });
  }
  next();
});

// ── Consensus window logic ──────────────────────────────────────
function onWindowEnd() {
  console.log('----- window end');
  if (DEVICE_IDS.every(id => windowDevices.has(id))) {
    console.log('\x1b[92mConfirmed!!!\x1b[0m');
    const entry = {
      timestamp: new Date().toISOString(),
      status: 'CONFIRMED',
      devices: DEVICE_IDS,
      aliases: DEVICE_IDS.map(d => translationDict[d] || d),
    };
    try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8'); } catch {}
  }
  windowDevices.clear();
  windowTimer = null;
}

// ── POST /api/seismic ───────────────────────────────────────────
app.post('/api/seismic', (req, res) => {
  try {
    const data = req.body;
    if (!data || data.level === undefined || data.deltaG === undefined) {
      return res.status(400).json({ error: "Invalid payload: 'level' and 'deltaG' required" });
    }
    const id = data.id || 'unknown';
    if (!translationDict[id]) translationDict[id] = id;

    const entry = {
      timestamp: new Date().toISOString(),
      level: data.level,
      deltaG: data.deltaG,
      id,
      alias: translationDict[id],
    };
    const line = JSON.stringify(entry) + '\n';
    console.log(line.trim());

    // Size guard
    try {
      if (fs.statSync(LOG_FILE).size >= MAX_LOG_BYTES) {
        return res.json({ status: 'skipped', reason: 'max size reached' });
      }
    } catch {}

    fs.appendFileSync(LOG_FILE, line, 'utf8');
    lastEventTimes[id] = new Date();

    // Consensus window
    windowDevices.add(id);
    if (!windowTimer) {
      console.log('----- window start');
      windowTimer = setTimeout(onWindowEnd, 2000);
    }
    return res.status(201).json({ status: 'logged' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error', details: err.stack });
  }
});

// ── GET /api/init ───────────────────────────────────────────────
app.get('/api/init', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });
  if (!translationDict[id]) translationDict[id] = id;
  lastEventTimes[id] = new Date();
  res.json({
    heartbeat_interval: parseInt(process.env.HEARTBEAT_INTERVAL || '60000', 10),
    sensitivity: {
      minor:    parseFloat(process.env.SENSITIVITY_MINOR    || '0.035'),
      moderate: parseFloat(process.env.SENSITIVITY_MODERATE || '0.10'),
      severe:   parseFloat(process.env.SENSITIVITY_SEVERE   || '0.50'),
    },
  });
});

// ── GET /api/status ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const now = new Date();
  const threshold = parseInt(process.env.STATUS_THRESHOLD_SECONDS || '120', 10) * 1000;
  const result = {};
  for (const id of DEVICE_IDS) {
    const last = lastEventTimes[id];
    result[id] = {
      alias: translationDict[id] || '',
      status: last && (now - last) <= threshold ? 'Online' : 'Offline',
    };
  }
  res.json(result);
});

// ── GET /api/events ─────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const events = [];
  try {
    for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
      if (line.trim()) { try { events.push(JSON.parse(line)); } catch {} }
    }
  } catch {}
  res.json(events);
});

// ── GET /api/consensus ──────────────────────────────────────────
app.get('/api/consensus', (req, res) => {
  const events = [];
  try {
    for (const line of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
      if (line.trim()) {
        try {
          const e = JSON.parse(line);
          if (e.status === 'CONFIRMED') events.push(e);
        } catch {}
      }
    }
  } catch {}
  res.json(events);
});

// ── GET /api/http_logs ──────────────────────────────────────────
app.get('/api/http_logs', (req, res) => res.json(httpLogs));

// ── GET /api/info ───────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const localIp = getLocalIp();
  res.json({
    host_url: `http://${localIp}:${PORT}/`,
    api_port: PORT,
    local_ip: localIp,
    uptime_seconds: (Date.now() - startTime.getTime()) / 1000,
  });
});

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// ── Serve React build ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA catch-all (client-side routing)
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).json({ error: 'Not found' });
});

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Seismometer API listening on http://0.0.0.0:${PORT}`);
});
