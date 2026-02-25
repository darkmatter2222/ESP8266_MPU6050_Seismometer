#!/usr/bin/env node
// server.js – Express API for Seismometer Dashboard
// Drop-in replacement for Flask server.py — fully ESP8266-compatible
// Uses MongoDB for persistent event storage

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MongoClient } = require('mongodb');

// ── Configuration ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/seismic';

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

// ── MongoDB collections (set after connect) ─────────────────────
let eventsCol = null;   // seismic events + consensus entries
let httpLogsCol = null; // API traffic logs

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
async function onWindowEnd() {
  console.log('----- window end');
  if (DEVICE_IDS.every(id => windowDevices.has(id))) {
    console.log('\x1b[92mConfirmed!!!\x1b[0m');
    const entry = {
      timestamp: new Date().toISOString(),
      status: 'CONFIRMED',
      devices: DEVICE_IDS,
      aliases: DEVICE_IDS.map(d => translationDict[d] || d),
    };
    try { await eventsCol.insertOne(entry); } catch (e) { console.error('Consensus write error:', e.message); }
  }
  windowDevices.clear();
  windowTimer = null;
}

// ── POST /api/seismic ───────────────────────────────────────────
app.post('/api/seismic', async (req, res) => {
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
    console.log(JSON.stringify(entry));

    await eventsCol.insertOne(entry);
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
app.get('/api/events', async (req, res) => {
  try {
    const events = await eventsCol.find({}, { projection: { _id: 0 } })
      .sort({ timestamp: -1 })
      .limit(50000)
      .toArray();
    res.json(events);
  } catch (err) {
    console.error('Events read error:', err.message);
    res.json([]);
  }
});

// ── GET /api/consensus ──────────────────────────────────────────
app.get('/api/consensus', async (req, res) => {
  try {
    const events = await eventsCol.find(
      { status: 'CONFIRMED' },
      { projection: { _id: 0 } }
    ).sort({ timestamp: -1 }).toArray();
    res.json(events);
  } catch (err) {
    console.error('Consensus read error:', err.message);
    res.json([]);
  }
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

// ── Connect to MongoDB then start ───────────────────────────────
async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('Connected to MongoDB');

  const db = client.db();          // uses database name from URI
  eventsCol = db.collection('events');

  // Create indexes for common queries
  await eventsCol.createIndex({ timestamp: -1 });
  await eventsCol.createIndex({ status: 1 });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Seismometer API listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
