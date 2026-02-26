#!/usr/bin/env node
// server.js – Express API for Seismometer Dashboard
// Drop-in replacement for Flask server.py — fully ESP8266-compatible
// Uses MongoDB for persistent event storage

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { MongoClient } = require('mongodb');
const { Server: SocketIO } = require('socket.io');

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
const lastInitTimes  = {};          // deviceId → ISO string (last init call)
const startTime = new Date();
let httpLogs = [];                  // { timestamp, endpoint }
let windowTimer = null;
let windowDevices = new Set();

// Default configuration
const DEFAULT_CONFIG = {
  heartbeat_interval: 60000,
  sensitivity: { minor: 0.035, moderate: 0.10, severe: 0.50 },
  consensus_window_ms: 2000,
  status_threshold_seconds: 120,
};

// ── MongoDB collections (set after connect) ─────────────────────
let eventsCol = null;   // seismic events + consensus entries
let configCol = null;   // global + per-device configuration
let reinitCol = null;   // reinit request tracking

// ── Express + Socket.IO setup ────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });
app.use(cors());
app.use(express.json());

// Socket.IO connection logging
io.on('connection', (socket) => {
  console.log(`[WS] client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[WS] client disconnected: ${socket.id}`));
});

// HTTP traffic logging middleware
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    httpLogs.push({ timestamp: new Date().toISOString(), endpoint: req.path });
    if (httpLogs.length > 10000) httpLogs = httpLogs.slice(-5000);
  }
  next();
});

// ── ESP8266 heartbeat (must come before static middleware) ───────
app.get('/', async (req, res, next) => {
  if (req.query.id) {
    const id = req.query.id;
    if (!translationDict[id]) translationDict[id] = id;
    lastEventTimes[id] = new Date();
    // Notify dashboard of heartbeat
    io.emit('device:heartbeat', { id, alias: translationDict[id], time: new Date().toISOString() });

    // Check for pending reinit flag
    try {
      const flag = await reinitCol.findOne({ deviceId: id, status: 'pending' });
      if (flag) {
        await reinitCol.updateOne(
          { _id: flag._id },
          { $set: { status: 'sent', sent_at: new Date().toISOString() } }
        );
        io.emit('device:reinit_sent', { id, alias: translationDict[id], time: new Date().toISOString() });
        console.log(`[REINIT] Sending 205 to ${translationDict[id]} (${id})`);
        return res.status(205).json({ status: 'reinit' });
      }
    } catch (e) { console.error('Reinit check error:', e.message); }

    // Auto-complete any stale 'sent' reinit flags (fallback if /api/init wasn't called)
    try {
      const cutoff = new Date(Date.now() - 60 * 1000).toISOString(); // 60s timeout
      const nowIso = new Date().toISOString();
      const result = await reinitCol.updateMany(
        { deviceId: id, status: 'sent', sent_at: { $lte: cutoff } },
        { $set: { status: 'completed', completed_at: nowIso } }
      );
      if (result && result.modifiedCount > 0) {
        io.emit('device:reinit_completed', { id, alias: translationDict[id], time: nowIso });
        console.log(`[REINIT] Auto-completed for ${translationDict[id]} (${id})`);
      }
    } catch (e) { console.error('Reinit auto-complete error:', e.message); }

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
    try {
      await eventsCol.insertOne(entry);
      io.emit('seismic:consensus', entry);
    } catch (e) { console.error('Consensus write error:', e.message); }
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

    // Push real-time to dashboard
    io.emit('seismic:event', entry);

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
app.get('/api/init', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });
  if (!translationDict[id]) translationDict[id] = id;
  lastEventTimes[id] = new Date();
  const now = new Date().toISOString();
  lastInitTimes[id] = now;

  // Load config from MongoDB (global + per-device override)
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const saved = await configCol.findOne({ _id: 'global' });
    if (saved) {
      cfg.heartbeat_interval = saved.heartbeat_interval ?? cfg.heartbeat_interval;
      cfg.sensitivity = { ...cfg.sensitivity, ...(saved.sensitivity || {}) };
      cfg.consensus_window_ms = saved.consensus_window_ms ?? cfg.consensus_window_ms;
      cfg.status_threshold_seconds = saved.status_threshold_seconds ?? cfg.status_threshold_seconds;

      // Per-device overrides
      const devCfg = saved.devices?.[id];
      if (devCfg) {
        if (devCfg.heartbeat_interval != null) cfg.heartbeat_interval = devCfg.heartbeat_interval;
        if (devCfg.sensitivity) cfg.sensitivity = { ...cfg.sensitivity, ...devCfg.sensitivity };
      }
    }
  } catch (e) { console.error('Config load error:', e.message); }

  // Mark any "sent" reinit flags as completed
  try {
    await reinitCol.updateMany(
      { deviceId: id, status: 'sent' },
      { $set: { status: 'completed', completed_at: now } }
    );
  } catch {}

  io.emit('device:init', { id, alias: translationDict[id], time: now, config: cfg });
  console.log(`[INIT] ${translationDict[id]} (${id}) initialized`);

  res.json({
    heartbeat_interval: cfg.heartbeat_interval,
    sensitivity: cfg.sensitivity,
  });
});

// ── GET /api/status ─────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const now = new Date();
  // Load threshold from config
  let threshold = DEFAULT_CONFIG.status_threshold_seconds * 1000;
  try {
    const saved = await configCol.findOne({ _id: 'global' });
    if (saved?.status_threshold_seconds) threshold = saved.status_threshold_seconds * 1000;
  } catch {}

  const result = {};
  for (const id of DEVICE_IDS) {
    const last = lastEventTimes[id];
    result[id] = {
      alias: translationDict[id] || '',
      status: last && (now - last) <= threshold ? 'Online' : 'Offline',
      last_init: lastInitTimes[id] || null,
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

// ── GET /api/config ──────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    let cfg = await configCol.findOne({ _id: 'global' });
    if (!cfg) cfg = { _id: 'global', ...DEFAULT_CONFIG, devices: {} };
    // Ensure devices dict has all known devices
    if (!cfg.devices) cfg.devices = {};
    for (const id of DEVICE_IDS) {
      if (!cfg.devices[id]) {
        cfg.devices[id] = { alias: translationDict[id], heartbeat_interval: null, sensitivity: null };
      } else {
        cfg.devices[id].alias = translationDict[id];
      }
    }
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/config ─────────────────────────────────────────────
app.put('/api/config', async (req, res) => {
  try {
    const body = req.body;
    const update = {
      heartbeat_interval: body.heartbeat_interval ?? DEFAULT_CONFIG.heartbeat_interval,
      sensitivity: {
        minor:    body.sensitivity?.minor    ?? DEFAULT_CONFIG.sensitivity.minor,
        moderate: body.sensitivity?.moderate ?? DEFAULT_CONFIG.sensitivity.moderate,
        severe:   body.sensitivity?.severe   ?? DEFAULT_CONFIG.sensitivity.severe,
      },
      consensus_window_ms: body.consensus_window_ms ?? DEFAULT_CONFIG.consensus_window_ms,
      status_threshold_seconds: body.status_threshold_seconds ?? DEFAULT_CONFIG.status_threshold_seconds,
      devices: body.devices || {},
      updated_at: new Date().toISOString(),
    };
    await configCol.updateOne(
      { _id: 'global' },
      { $set: update },
      { upsert: true }
    );
    // Update translation dict from device aliases
    for (const [id, dev] of Object.entries(update.devices)) {
      if (dev.alias) translationDict[id] = dev.alias;
    }
    io.emit('config:updated', update);
    console.log('[CONFIG] Configuration saved');
    res.json({ status: 'saved', config: update });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/config/reinit/:deviceId ───────────────────────────
app.post('/api/config/reinit/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!DEVICE_IDS.includes(deviceId) && !translationDict[deviceId]) {
      return res.status(404).json({ error: 'Unknown device' });
    }
    // Cancel any existing pending flags for this device
    await reinitCol.updateMany(
      { deviceId, status: 'pending' },
      { $set: { status: 'cancelled', cancelled_at: new Date().toISOString() } }
    );
    // Create new reinit request
    const doc = {
      deviceId,
      alias: translationDict[deviceId] || deviceId,
      requested_at: new Date().toISOString(),
      status: 'pending',       // pending → sent (205 sent) → completed (device called /init)
      sent_at: null,
      completed_at: null,
    };
    await reinitCol.insertOne(doc);
    io.emit('device:reinit_requested', { id: deviceId, alias: translationDict[deviceId], time: doc.requested_at });
    console.log(`[REINIT] Requested for ${translationDict[deviceId]} (${deviceId})`);
    res.json({ status: 'queued', deviceId, alias: translationDict[deviceId] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/config/reinit-all ─────────────────────────────────
app.post('/api/config/reinit-all', async (req, res) => {
  try {
    const results = [];
    for (const deviceId of DEVICE_IDS) {
      await reinitCol.updateMany(
        { deviceId, status: 'pending' },
        { $set: { status: 'cancelled', cancelled_at: new Date().toISOString() } }
      );
      const doc = {
        deviceId,
        alias: translationDict[deviceId] || deviceId,
        requested_at: new Date().toISOString(),
        status: 'pending',
        sent_at: null,
        completed_at: null,
      };
      await reinitCol.insertOne(doc);
      results.push({ deviceId, alias: translationDict[deviceId] });
    }
    io.emit('device:reinit_all_requested', { devices: results, time: new Date().toISOString() });
    console.log('[REINIT] Requested for ALL devices');
    res.json({ status: 'queued', devices: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/config/reinit-status ───────────────────────────────
app.get('/api/config/reinit-status', async (req, res) => {
  try {
    const flags = await reinitCol.find(
      { status: { $in: ['pending', 'sent'] } }
    ).toArray();
    // Also get recent completed (last 10)
    const recent = await reinitCol.find({ status: 'completed' })
      .sort({ completed_at: -1 }).limit(10).toArray();
    res.json({ active: flags, recent });
  } catch (err) {
    res.json({ active: [], recent: [] });
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
  configCol = db.collection('config');
  reinitCol = db.collection('reinit_flags');

  // Create indexes for common queries
  await eventsCol.createIndex({ timestamp: -1 });
  await eventsCol.createIndex({ status: 1 });
  await reinitCol.createIndex({ deviceId: 1, status: 1 });

  // Seed default config if none exists
  const existing = await configCol.findOne({ _id: 'global' });
  if (!existing) {
    const seed = { _id: 'global', ...DEFAULT_CONFIG, devices: {} };
    for (const id of DEVICE_IDS) {
      seed.devices[id] = { alias: translationDict[id], heartbeat_interval: null, sensitivity: null };
    }
    await configCol.insertOne(seed);
    console.log('Seeded default config');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Seismometer API listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
