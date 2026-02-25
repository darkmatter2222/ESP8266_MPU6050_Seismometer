import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine,
  ComposedChart, Bar, Line, AreaChart, Area,
} from 'recharts';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CONSTANTS                                                       ║
// ╚══════════════════════════════════════════════════════════════════╝
const POLL_FALLBACK_MS = 60_000;

const DEVICE_COLORS = {
  'Ryan Office': '#00ff88',
  'Bonus Room':  '#00aaff',
  'Kitchen':     '#ff6644',
};

const LEVEL_COLORS = {
  minor:    '#00ff88',
  moderate: '#ffaa00',
  severe:   '#ff3366',
};

const PERIODS = [
  { key: '24h', label: '24H', ms: 86_400_000 },
  { key: '7d',  label: '7D',  ms: 604_800_000 },
  { key: '15d', label: '15D', ms: 1_296_000_000 },
  { key: '30d', label: '30D', ms: 2_592_000_000 },
];

const TIMEZONES = [
  { value: 'UTC',                 label: 'UTC' },
  { value: 'America/New_York',    label: 'Eastern' },
  { value: 'America/Chicago',     label: 'Central' },
  { value: 'America/Denver',      label: 'Mountain' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║  UTILITIES                                                       ║
// ╚══════════════════════════════════════════════════════════════════╝
function timeAgo(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function fmtTs(epochMs, tz) {
  return new Date(epochMs).toLocaleString('en-US', {
    timeZone: tz,
    month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function fmtTick(epochMs, tz, periodKey) {
  if (periodKey === '24h') {
    return new Date(epochMs).toLocaleTimeString('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  return new Date(epochMs).toLocaleDateString('en-US', {
    timeZone: tz, month: 'short', day: 'numeric',
  });
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function deviceColor(alias) {
  return DEVICE_COLORS[alias] || '#888';
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CUSTOM TOOLTIPS                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝
function DeltaTooltip({ active, payload, tz }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-title" style={{ color: deviceColor(d.alias) }}>{d.alias}</div>
      <div className="tooltip-row">
        Level: <span style={{ color: LEVEL_COLORS[d.level] }}>{d.level}</span>
      </div>
      <div className="tooltip-row">ΔG: <strong>{d.deltaG?.toFixed(4)}</strong></div>
      <div className="tooltip-time">{fmtTs(d._time, tz)}</div>
    </div>
  );
}

function ActivityTooltip({ active, payload, label, tz }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-time">{fmtTs(label, tz)}</div>
      {payload.map((p, i) => (
        <div key={i} className="tooltip-row" style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? (p.name === 'Max ΔG' ? p.value.toFixed(3) : p.value) : p.value}
        </div>
      ))}
    </div>
  );
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  SUB-COMPONENTS                                                  ║
// ╚══════════════════════════════════════════════════════════════════╝
function Panel({ title, children, className = '' }) {
  return (
    <div className={`panel ${className}`}>
      <div className="panel-header">{title}</div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  MAIN APP                                                        ║
// ╚══════════════════════════════════════════════════════════════════╝
export default function App() {
  // ── State ──────────────────────────────────────────────────────
  const [events, setEvents] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [httpLogs, setHttpLogs] = useState([]);
  const [serverInfo, setServerInfo] = useState(null);
  const [period, setPeriod] = useState('7d');
  const [timezone, setTimezone] = useState('America/New_York');
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  // ── Data Fetching ──────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [evRes, statRes, httpRes, infoRes] = await Promise.all([
        fetch('/api/events'),
        fetch('/api/status'),
        fetch('/api/http_logs'),
        fetch('/api/info'),
      ]);
      if (evRes.ok) setEvents(await evRes.json());
      if (statRes.ok) setStatuses(await statRes.json());
      if (httpRes.ok) setHttpLogs(await httpRes.json());
      if (infoRes.ok) setServerInfo(await infoRes.json());
      setLastRefresh(Date.now());
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Fallback poll every 60s (real-time handles most updates)
    const id = setInterval(fetchAll, POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Socket.IO real-time updates ────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('[WS] connected:', socket.id);
      setWsConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('[WS] disconnected');
      setWsConnected(false);
    });

    // New seismic event → prepend to events array
    socket.on('seismic:event', (entry) => {
      setEvents(prev => [entry, ...prev]);
      setLastRefresh(Date.now());
    });

    // Consensus confirmed → prepend to events array
    socket.on('seismic:consensus', (entry) => {
      setEvents(prev => [entry, ...prev]);
      setLastRefresh(Date.now());
    });

    // Device heartbeat → update that device to Online
    socket.on('device:heartbeat', ({ id, alias }) => {
      setStatuses(prev => ({
        ...prev,
        [id]: { alias: alias || id, status: 'Online' },
      }));
    });

    return () => socket.disconnect();
  }, []);

  // ── Computed: Filter by period ─────────────────────────────────
  const periodMs = PERIODS.find(p => p.key === period)?.ms || 604_800_000;
  const cutoff = Date.now() - periodMs;

  const { seismicEvents, consensusEvents } = useMemo(() => {
    const seismic = [];
    const consensus = [];
    for (const e of events) {
      const t = new Date(e.timestamp).getTime();
      if (t < cutoff) continue;
      if (e.status === 'CONFIRMED') {
        consensus.push({ ...e, _time: t });
      } else if (e.deltaG !== undefined) {
        seismic.push({ ...e, _time: t });
      }
    }
    return { seismicEvents: seismic, consensusEvents: consensus };
  }, [events, cutoff]);

  // ── Computed: Device groups for scatter chart ──────────────────
  const deviceGroups = useMemo(() => {
    const groups = {};
    for (const e of seismicEvents) {
      const key = e.alias || e.id || 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        _time: e._time,
        deltaG: e.deltaG,
        level: e.level,
        alias: key,
      });
    }
    return groups;
  }, [seismicEvents]);

  // ── Computed: Key metrics ──────────────────────────────────────
  const metrics = useMemo(() => {
    const total = seismicEvents.length;
    let maxDelta = 0;
    let lastEvent = null;
    for (const e of seismicEvents) {
      if (e.deltaG > maxDelta) maxDelta = e.deltaG;
      if (!lastEvent || e._time > lastEvent) lastEvent = e._time;
    }
    let lastConsensus = null;
    for (const c of consensusEvents) {
      if (!lastConsensus || c._time > lastConsensus) lastConsensus = c._time;
    }
    return {
      total,
      maxDelta: maxDelta || null,
      lastEvent,
      lastConsensus,
      consensusCount: consensusEvents.length,
    };
  }, [seismicEvents, consensusEvents]);

  // ── Computed: Activity chart data (stacked bars by severity) ──
  const activityData = useMemo(() => {
    const bucketMs = period === '24h' ? 3_600_000 : 86_400_000;
    const buckets = new Map();
    for (const e of seismicEvents) {
      const t = Math.floor(e._time / bucketMs) * bucketMs;
      if (!buckets.has(t)) {
        buckets.set(t, { time: t, minor: 0, moderate: 0, severe: 0, maxDg: 0 });
      }
      const b = buckets.get(t);
      b[e.level] = (b[e.level] || 0) + 1;
      if (e.deltaG > b.maxDg) b.maxDg = e.deltaG;
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  }, [seismicEvents, period]);

  // ── Computed: Traffic chart data ──────────────────────────────
  const trafficData = useMemo(() => {
    const bucketMs = period === '24h' ? 300_000 : 3_600_000;
    const buckets = new Map();
    for (const log of httpLogs) {
      const t = new Date(log.timestamp).getTime();
      if (t < cutoff) continue;
      const bt = Math.floor(t / bucketMs) * bucketMs;
      if (!buckets.has(bt)) buckets.set(bt, { time: bt, seismic: 0, status: 0, events: 0, other: 0 });
      const b = buckets.get(bt);
      if (log.endpoint === '/api/seismic') b.seismic++;
      else if (log.endpoint === '/api/status') b.status++;
      else if (log.endpoint === '/api/events') b.events++;
      else b.other++;
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  }, [httpLogs, cutoff, period]);

  // ── Computed: Recent events ───────────────────────────────────
  const recentEvents = useMemo(() => {
    return [...seismicEvents].sort((a, b) => b._time - a._time).slice(0, 25);
  }, [seismicEvents]);

  // ── Computed: Consensus details ───────────────────────────────
  const consensusDetails = useMemo(() => {
    return [...consensusEvents].sort((a, b) => b._time - a._time).slice(0, 20);
  }, [consensusEvents]);

  // ── Thresholds ────────────────────────────────────────────────
  const thresholds = { minor: 0.035, moderate: 0.10, severe: 0.50 };

  // ── Render ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <div>Connecting to seismometer network...</div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {/* ─── Header ──────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <span className="header-icon">🌍</span>
          <h1>Seismometer Dashboard</h1>
          {serverInfo && (
            <span className="header-uptime">
              Uptime: {fmtUptime(serverInfo.uptime_seconds)}
            </span>
          )}
        </div>
        <div className="header-right">
          <div className="period-toggle">
            {PERIODS.map(p => (
              <button
                key={p.key}
                className={`period-btn ${period === p.key ? 'active' : ''}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <select
            className="tz-select"
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
          >
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
          {lastRefresh && (
            <span className="refresh-badge" title={wsConnected ? 'Real-time via WebSocket' : 'Polling fallback'}>
              {wsConnected ? '⚡ Live' : '⟳ Poll'} · {timeAgo(lastRefresh)}
            </span>
          )}
        </div>
      </header>

      {/* ─── Status Row ──────────────────────────────────────── */}
      <div className="status-row">
        <div className="node-chips">
          {Object.entries(statuses).map(([id, info]) => (
            <div key={id} className={`node-chip ${info.status === 'Online' ? 'online' : 'offline'}`}>
              <span className="chip-dot" />
              {info.alias || id}
            </div>
          ))}
        </div>
        <div className="metrics-row">
          <div className="metric-card">
            <span className="metric-value">{metrics.total.toLocaleString()}</span>
            <span className="metric-label">Events</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">{metrics.lastEvent ? timeAgo(metrics.lastEvent) : '–'}</span>
            <span className="metric-label">Last Event</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">{metrics.lastConsensus ? timeAgo(metrics.lastConsensus) : '–'}</span>
            <span className="metric-label">Last Consensus</span>
          </div>
          <div className="metric-card">
            <span className="metric-value accent">{metrics.maxDelta ? metrics.maxDelta.toFixed(3) : '–'}</span>
            <span className="metric-label">Max ΔG</span>
          </div>
          <div className="metric-card">
            <span className="metric-value">{metrics.consensusCount}</span>
            <span className="metric-label">Consensus</span>
          </div>
        </div>
      </div>

      {/* ─── Main Delta-G Chart ──────────────────────────────── */}
      <Panel title="ΔG Over Time" className="main-chart">
        {seismicEvents.length === 0 ? (
          <div className="empty-state">No seismic events in this period</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="_time"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={t => fmtTick(t, timezone, period)}
                tick={{ fill: '#666', fontSize: 11 }}
                tickCount={10}
              />
              <YAxis
                dataKey="deltaG"
                tick={{ fill: '#666', fontSize: 11 }}
                tickFormatter={v => v.toFixed(2)}
                label={{ value: 'ΔG (g)', angle: -90, position: 'insideLeft', fill: '#555', fontSize: 11 }}
              />
              <Tooltip content={props => <DeltaTooltip {...props} tz={timezone} />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              />
              {/* Threshold reference lines */}
              <ReferenceLine y={thresholds.minor} stroke="#00ff8825" strokeDasharray="6 4" />
              <ReferenceLine y={thresholds.moderate} stroke="#ffaa0025" strokeDasharray="6 4" />
              <ReferenceLine y={thresholds.severe} stroke="#ff336625" strokeDasharray="6 4" />
              {/* Consensus event lines */}
              {consensusEvents.map((c, i) => (
                <ReferenceLine key={`c${i}`} x={c._time} stroke="#ff00ff" strokeDasharray="4 3" strokeWidth={1} opacity={0.5} />
              ))}
              {/* One Scatter per device */}
              {Object.entries(deviceGroups).map(([alias, data]) => (
                <Scatter
                  key={alias}
                  name={alias}
                  data={data}
                  fill={deviceColor(alias)}
                  fillOpacity={0.8}
                  r={3}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {/* ─── Bottom Grid ─────────────────────────────────────── */}
      <div className="bottom-grid">

        {/* Activity Chart */}
        <Panel title="Event Activity by Severity">
          {activityData.length === 0 ? (
            <div className="empty-state">No activity data</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={activityData} margin={{ top: 8, right: 40, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={t => fmtTick(t, timezone, period)}
                  tick={{ fill: '#666', fontSize: 10 }}
                  tickCount={6}
                />
                <YAxis
                  yAxisId="count"
                  tick={{ fill: '#666', fontSize: 10 }}
                  label={{ value: 'Count', angle: -90, position: 'insideLeft', fill: '#555', fontSize: 10 }}
                />
                <YAxis
                  yAxisId="dg"
                  orientation="right"
                  tick={{ fill: '#666', fontSize: 10 }}
                  tickFormatter={v => v.toFixed(2)}
                  label={{ value: 'Max ΔG', angle: 90, position: 'insideRight', fill: '#555', fontSize: 10 }}
                />
                <Tooltip content={props => <ActivityTooltip {...props} tz={timezone} />} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Bar yAxisId="count" dataKey="severe"   name="Severe"   stackId="s" fill="#ff3366" radius={[2,2,0,0]} />
                <Bar yAxisId="count" dataKey="moderate" name="Moderate" stackId="s" fill="#ffaa00" radius={[0,0,0,0]} />
                <Bar yAxisId="count" dataKey="minor"    name="Minor"    stackId="s" fill="#00ff88" radius={[0,0,0,0]} />
                <Line yAxisId="dg" dataKey="maxDg" name="Max ΔG" stroke="#ffffff60" dot={false} strokeWidth={1.5} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Panel>

        {/* Consensus Events */}
        <Panel title={`Consensus Events (${consensusDetails.length})`}>
          {consensusDetails.length === 0 ? (
            <div className="empty-state">No consensus events</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Devices</th>
                    <th>Ago</th>
                  </tr>
                </thead>
                <tbody>
                  {consensusDetails.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{fmtTs(c._time, timezone)}</td>
                      <td>{(c.aliases || []).join(', ')}</td>
                      <td className="muted">{timeAgo(c._time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Recent Events */}
        <Panel title="Recent Events">
          {recentEvents.length === 0 ? (
            <div className="empty-state">No recent events</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Device</th>
                    <th>Level</th>
                    <th>ΔG</th>
                    <th>Ago</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{fmtTs(e._time, timezone)}</td>
                      <td style={{ color: deviceColor(e.alias) }}>{e.alias}</td>
                      <td>
                        <span className={`level-badge ${e.level}`}>{e.level}</span>
                      </td>
                      <td className="mono">{e.deltaG?.toFixed(4)}</td>
                      <td className="muted">{timeAgo(e._time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* HTTP Traffic */}
        <Panel title="API Traffic">
          {trafficData.length === 0 ? (
            <div className="empty-state">No traffic data</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trafficData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={t => fmtTick(t, timezone, period)}
                  tick={{ fill: '#666', fontSize: 10 }}
                  tickCount={6}
                />
                <YAxis tick={{ fill: '#666', fontSize: 10 }} />
                <Tooltip content={props => <ActivityTooltip {...props} tz={timezone} />} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Area type="monotone" dataKey="seismic" name="/api/seismic" stackId="1" stroke="#00ff88" fill="#00ff8820" />
                <Area type="monotone" dataKey="status"  name="/api/status"  stackId="1" stroke="#00aaff" fill="#00aaff20" />
                <Area type="monotone" dataKey="events"  name="/api/events"  stackId="1" stroke="#ff6644" fill="#ff664420" />
                <Area type="monotone" dataKey="other"   name="other"        stackId="1" stroke="#888"    fill="#88888820" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Panel>

      </div>
    </div>
  );
}
