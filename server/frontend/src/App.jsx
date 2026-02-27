import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine, ReferenceArea, Customized,
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
  const navigate = useNavigate();
  const [events, setEvents] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [httpLogs, setHttpLogs] = useState([]);
  const [serverInfo, setServerInfo] = useState(null);
  const [period, setPeriod] = useState('7d');
  const [timezone, setTimezone] = useState('America/New_York');
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  // ── Interactivity state ─────────────────────────────────────
  const [deviceFilters, setDeviceFilters] = useState({}); // alias -> bool
  const [levelFilters, setLevelFilters] = useState({ minor: true, moderate: true, severe: true });
  const [showConsensus, setShowConsensus] = useState(true);
  const [xZoomDomain, setXZoomDomain] = useState(null); // [min, max]
  const [refAreaStart, setRefAreaStart] = useState(null);
  const [refAreaEnd, setRefAreaEnd] = useState(null);
  const [modalEvent, setModalEvent] = useState(null);
  const [rangeModal, setRangeModal] = useState(null); // {start,end,events}
  const [toolMode, setToolMode] = useState('zoom'); // 'zoom' | 'pan' | 'select'
  const [colorMode, setColorMode] = useState('level'); // 'level' | 'device' | 'gradient'
  const panRef = useRef({ anchor: null, domain: null });
  const chartRef = useRef(null);
  const plotBoundsRef = useRef({ left: 0, width: 1, top: 0, height: 0 });
  const dragRef = useRef({ active: false, startPx: 0, curPx: 0, mode: null });
  const currentDomainRef = useRef([0, 1]);
  const commitDragRef = useRef(null); // always-current commitDrag for window listener
  const [selectionRect, setSelectionRect] = useState(null); // {startPx,curPx} for rendering
  const [isDragging, setIsDragging] = useState(false);      // for pan cursor

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

  // Helpers: dataset bounds for zoom/gradient
  const xDataMin = useMemo(() => (seismicEvents.length ? Math.min(...seismicEvents.map(e => e._time)) : cutoff), [seismicEvents, cutoff]);
  const xDataMax = useMemo(() => (seismicEvents.length ? Math.max(...seismicEvents.map(e => e._time)) : Date.now()), [seismicEvents]);
  const [dgMin, dgMax] = useMemo(() => {
    if (!seismicEvents.length) return [0, 1];
    let mn = Infinity, mx = -Infinity;
    for (const e of seismicEvents) { if (e.deltaG < mn) mn = e.deltaG; if (e.deltaG > mx) mx = e.deltaG; }
    return [mn, mx];
  }, [seismicEvents]);

  // Color mapping (hoisted functions so they're available below)
  function rampColor(t) {
    const h = 120 - 120 * Math.min(1, Math.max(0, t));
    return `hsl(${h}, 100%, 50%)`;
  }
  function colorForPoint(e) {
    if (colorMode === 'level') return LEVEL_COLORS[e.level] || '#999';
    if (colorMode === 'device') return DEVICE_COLORS[e.alias] || '#999';
    const t = dgMax > dgMin ? (e.deltaG - dgMin) / (dgMax - dgMin) : 0;
    return rampColor(t);
  }

  // ── Computed: Device groups for scatter chart ──────────────────
  const deviceGroups = useMemo(() => {
    const groups = {};
    for (const e of seismicEvents) {
      if (!levelFilters[e.level]) continue;
      const key = e.alias || e.id || 'Unknown';
      if (Object.keys(deviceFilters).length && deviceFilters[key] === false) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push({
        _time: e._time,
        deltaG: e.deltaG,
        level: e.level,
        alias: key,
        _c: colorForPoint({ ...e, alias: key })
      });
    }
    return groups;
  }, [seismicEvents, deviceFilters, levelFilters]);

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

  // ── Thresholds ────────────────────────────────────────────────
  const thresholds = { minor: 0.035, moderate: 0.10, severe: 0.50 };

  // Initialize device filters from statuses/events once
  useEffect(() => {
    const aliases = new Set(Object.keys(statuses).map(k => statuses[k]?.alias).filter(Boolean));
    const fromEvents = new Set(seismicEvents.map(e => e.alias || e.id));
    const all = new Set([...aliases, ...fromEvents]);
    setDeviceFilters(prev => {
      const next = { ...prev };
      for (const a of all) if (!(a in next)) next[a] = true;
      return next;
    });
  }, [statuses, seismicEvents.length]);

  // Pixel-domain helpers
  const currentDomain = useMemo(() => xZoomDomain || [xDataMin, xDataMax], [xZoomDomain, xDataMin, xDataMax]);
  // Assign directly during render — always synchronous, never stale (no useEffect needed)
  currentDomainRef.current = currentDomain;

  // Reads only from refs — never stale regardless of render cycle
  const pxToTime = (px) => {
    const { left, width } = plotBoundsRef.current;
    const fraction = Math.max(0, Math.min(1, (px - left) / width));
    const [d0, d1] = currentDomainRef.current;
    return d0 + fraction * (d1 - d0);
  };

  const cancelDrag = () => {
    dragRef.current = { active: false, startPx: 0, curPx: 0, mode: null };
    panRef.current  = { anchor: null, domain: null };
    setSelectionRect(null);
    setIsDragging(false);
  };

  // commitDrag is a plain function (re-created each render) so it always closes over
  // the latest seismicEvents / levelFilters / deviceFilters state.
  // commitDragRef.current is updated every render so the window listener always calls
  // the fresh version.
  const commitDrag = () => {
    const d = dragRef.current;
    if (!d.active) return;
    if ((d.mode === 'zoom' || d.mode === 'select') && Math.abs(d.curPx - d.startPx) > 6) {
      const start = Math.min(d.startPx, d.curPx);
      const end   = Math.max(d.startPx, d.curPx);
      const t0 = pxToTime(start);
      const t1 = pxToTime(end);
      if (d.mode === 'zoom') {
        setXZoomDomain([t0, t1]);
      } else {
        const inRange = seismicEvents
          .filter(e => e._time >= t0 && e._time <= t1)
          .filter(e => levelFilters[e.level] && (deviceFilters[e.alias || e.id] ?? true));
        setRangeModal({ start: t0, end: t1, events: inRange });
      }
    }
    cancelDrag();
  };
  commitDragRef.current = commitDrag;

  // Window mouseup — fires even if pointer leaves the overlay (no auto-commit on edge)
  useEffect(() => {
    const onWinUp = () => { if (dragRef.current.active) commitDragRef.current(); };
    window.addEventListener('mouseup', onWinUp);
    return () => window.removeEventListener('mouseup', onWinUp);
  }, []);

  const onOverlayDown = (ev) => {
    if (ev.button !== 0) return;
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ev.clientX - rect.left;
    if (toolMode === 'pan') {
      panRef.current = { anchor: x, domain: [...currentDomainRef.current] };
      dragRef.current = { active: true, startPx: x, curPx: x, mode: 'pan' };
      setIsDragging(true);
    } else {
      dragRef.current = { active: true, startPx: x, curPx: x, mode: toolMode };
      setSelectionRect({ startPx: x, curPx: x });
      setIsDragging(true);
    }
  };

  const onOverlayMove = (ev) => {
    if (!dragRef.current.active) return;
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ev.clientX - rect.left;
    dragRef.current.curPx = x;
    if (dragRef.current.mode === 'pan' && panRef.current.anchor != null) {
      const dxPx = x - panRef.current.anchor;
      const span = panRef.current.domain[1] - panRef.current.domain[0];
      const plotW = plotBoundsRef.current.width || 1;
      let next = [
        panRef.current.domain[0] - (dxPx / plotW) * span,
        panRef.current.domain[1] - (dxPx / plotW) * span,
      ];
      const w = next[1] - next[0];
      if (next[0] < xDataMin) next = [xDataMin, xDataMin + w];
      if (next[1] > xDataMax) next = [xDataMax - w, xDataMax];
      setXZoomDomain(next);
    } else {
      setSelectionRect({ startPx: dragRef.current.startPx, curPx: x });
    }
  };

  const onOverlayUp = () => commitDrag();

  const resetZoom = () => setXZoomDomain(null);
  const onPointClick = (data) => { if (data?.payload) setModalEvent(data.payload); };

  const onWheel = (ev) => {
    ev.preventDefault();
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ev.clientX - rect.left;
    const [d0, d1] = currentDomainRef.current;
    const span = d1 - d0;
    const { left: plotLeft, width: plotW } = plotBoundsRef.current;
    const fraction = Math.max(0, Math.min(1, (x - plotLeft) / plotW));
    const center = d0 + fraction * span;
    const factor = ev.deltaY < 0 ? 0.8 : 1.25;
    const half = (span * factor) / 2;
    let next = [center - half, center + half];
    if (next[0] < xDataMin) next[0] = xDataMin;
    if (next[1] > xDataMax) next[1] = xDataMax;
    if (next[1] - next[0] < 2000) return;
    setXZoomDomain(next);
  };

  // Color mapping moved above deviceGroups

  const exportCsv = (rows, filename = 'events.csv') => {
    const header = ['time','alias','level','deltaG'];
    const lines = [header.join(',')].concat(rows.map(r => [
      new Date(r._time).toISOString(),
      (r.alias || r.id || ''),
      r.level,
      (r.deltaG != null ? r.deltaG : '').toString()
    ].join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

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
          <button className="admin-link" onClick={() => navigate('/admin')}>⚙ Config</button>
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

      {/* ─── Controls Row ───────────────────────────────────── */}
      <div className="controls-row">
        <div className="filter-group">
          <span className="control-label">Devices:</span>
          {Object.keys(deviceFilters).map(alias => (
            <label key={alias} className="chk">
              <input
                type="checkbox"
                checked={deviceFilters[alias]}
                onChange={e => setDeviceFilters(prev => ({ ...prev, [alias]: e.target.checked }))}
              />
              <span style={{ color: deviceColor(alias) }}>{alias}</span>
            </label>
          ))}
        </div>
        <div className="filter-group">
          <span className="control-label">Levels:</span>
          {(['minor','moderate','severe']).map(lvl => (
            <label key={lvl} className="chk">
              <input
                type="checkbox"
                checked={levelFilters[lvl]}
                onChange={e => setLevelFilters(prev => ({ ...prev, [lvl]: e.target.checked }))}
              />
              <span className={`level-badge ${lvl}`}>{lvl}</span>
            </label>
          ))}
        </div>
        <div className="filter-group">
          <span className="control-label">Color:</span>
          <select className="tz-select" value={colorMode} onChange={e => setColorMode(e.target.value)}>
            <option value="level">By Level</option>
            <option value="device">By Device</option>
            <option value="gradient">By ΔG Gradient</option>
          </select>
        </div>
        <div className="filter-group">
          <span className="control-label">Tool:</span>
          <div className="period-toggle">
            {['zoom','pan','select'].map(m => (
              <button key={m} className={`period-btn ${toolMode===m?'active':''}`} onClick={()=>setToolMode(m)}>
                {m}
              </button>
            ))}
          </div>
        </div>
        <label className="chk">
          <input type="checkbox" checked={showConsensus} onChange={e => setShowConsensus(e.target.checked)} />
          <span>Show consensus markers</span>
        </label>
        <button className="btn" onClick={() => {
          const dom = xZoomDomain || [xDataMin, xDataMax];
          const center = (dom[0]+dom[1])/2; const span = (dom[1]-dom[0])*0.8/2; setXZoomDomain([center-span, center+span]);
        }}>Zoom In</button>
        <button className="btn" onClick={() => {
          const dom = xZoomDomain || [xDataMin, xDataMax];
          const center = (dom[0]+dom[1])/2; const span = (dom[1]-dom[0])*1.25/2; let next=[center-span, center+span];
          if (next[0]<xDataMin) next[0]=xDataMin; if (next[1]>xDataMax) next[1]=xDataMax; setXZoomDomain(next);
        }}>Zoom Out</button>
        <button className="btn" onClick={resetZoom} disabled={!xZoomDomain}>Reset Zoom</button>
      </div>

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
          <div className="chart-wrapper">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="_time"
                type="number"
                scale="time"
                domain={currentDomain}
                allowDataOverflow={true}
                tickFormatter={t => fmtTick(t, timezone, period)}
                tick={{ fill: '#666', fontSize: 11 }}
                tickCount={10}
              />
              <YAxis
                dataKey="deltaG"
                tick={{ fill: '#666', fontSize: 11 }}
                tickFormatter={v => v.toFixed(2)}
                allowDataOverflow={true}
                label={{ value: 'ΔG (g)', angle: -90, position: 'insideLeft', fill: '#555', fontSize: 11 }}
              />
              <Tooltip content={props => <DeltaTooltip {...props} tz={timezone} />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
              />
              {/* Capture exact Recharts plot-area pixel bounds on every render */}
              <Customized component={({ xAxisMap, yAxisMap }) => {
                const xa = xAxisMap && (xAxisMap[0] ?? Object.values(xAxisMap)[0]);
                const ya = yAxisMap && (yAxisMap[0] ?? Object.values(yAxisMap)[0]);
                if (xa && ya) {
                  plotBoundsRef.current = {
                    left:   xa.x   ?? 0,
                    width:  xa.width  ?? 1,
                    top:    ya.y   ?? 0,
                    height: ya.height ?? 0,
                  };
                }
                return null;
              }} />
              {/* Threshold reference lines */}
              <ReferenceLine y={thresholds.minor} stroke="#00ff8825" strokeDasharray="6 4" />
              <ReferenceLine y={thresholds.moderate} stroke="#ffaa0025" strokeDasharray="6 4" />
              <ReferenceLine y={thresholds.severe} stroke="#ff336625" strokeDasharray="6 4" />
              {/* Consensus event lines */}
              {showConsensus && consensusEvents.map((c, i) => (
                <ReferenceLine key={`c${i}`} x={c._time} stroke="#ff00ff" strokeDasharray="4 3" strokeWidth={1} opacity={0.5} />
              ))}
              {/* One Scatter per device */}
              {Object.entries(deviceGroups).map(([alias, data]) => (
                <Scatter
                  key={alias}
                  name={alias}
                  data={data}
                  shape={(p) => (
                    <g>
                      {/* thin X mark */}
                      <line x1={p.cx-3} y1={p.cy-3} x2={p.cx+3} y2={p.cy+3} stroke={p.payload._c} strokeWidth={1} />
                      <line x1={p.cx-3} y1={p.cy+3} x2={p.cx+3} y2={p.cy-3} stroke={p.payload._c} strokeWidth={1} />
                    </g>
                  )}
                  onClick={onPointClick}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          <div
            ref={chartRef}
            className="chart-overlay"
            style={{ cursor: toolMode === 'pan' ? (isDragging ? 'grabbing' : 'grab') : toolMode === 'select' ? 'crosshair' : 'zoom-in' }}
            onMouseDown={onOverlayDown}
            onMouseMove={onOverlayMove}
            onMouseUp={onOverlayUp}
            onMouseLeave={cancelDrag}
            onWheel={onWheel}
          >
            {selectionRect && (
              <div
                className="selection-rect"
                style={{
                  left:   Math.min(selectionRect.startPx, selectionRect.curPx),
                  width:  Math.abs(selectionRect.curPx - selectionRect.startPx),
                  top:    plotBoundsRef.current.top,
                  height: plotBoundsRef.current.height,
                }}
              />
            )}
          </div>
          </div>
        )}
      </Panel>

      {/* Removed secondary panels: Activity, Consensus table, Recent, API Traffic */}

      {/* ─── Event Modal ───────────────────────────────────── */}
      {modalEvent && (
        <div className="modal-backdrop" onClick={() => setModalEvent(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>Event Details</div>
              <button className="modal-close" onClick={() => setModalEvent(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="kv"><span>Time</span><span className="mono">{fmtTs(modalEvent._time, timezone)}</span></div>
              <div className="kv"><span>Device</span><span style={{ color: deviceColor(modalEvent.alias) }}>{modalEvent.alias}</span></div>
              <div className="kv"><span>Level</span><span className={`level-badge ${modalEvent.level}`}>{modalEvent.level}</span></div>
              <div className="kv"><span>ΔG</span><span className="mono">{modalEvent.deltaG?.toFixed(5)}</span></div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => exportCsv([modalEvent], 'event.csv')}>Export</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Range Modal ───────────────────────────────────── */}
      {rangeModal && (
        <div className="modal-backdrop" onClick={() => setRangeModal(null)}>
          <div className="modal large" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>Selected Range</div>
              <button className="modal-close" onClick={() => setRangeModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="kv"><span>From</span><span className="mono">{fmtTs(rangeModal.start, timezone)}</span></div>
              <div className="kv"><span>To</span><span className="mono">{fmtTs(rangeModal.end, timezone)}</span></div>
              <div className="kv"><span>Events</span><span className="mono">{rangeModal.events.length}</span></div>
              <div className="range-table table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Device</th>
                      <th>Level</th>
                      <th>ΔG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rangeModal.events.slice(0, 500).map((e,i) => (
                      <tr key={i}>
                        <td className="mono">{fmtTs(e._time, timezone)}</td>
                        <td style={{ color: deviceColor(e.alias) }}>{e.alias}</td>
                        <td><span className={`level-badge ${e.level}`}>{e.level}</span></td>
                        <td className="mono">{e.deltaG?.toFixed(5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => exportCsv(rangeModal.events, 'range_events.csv')}>Export CSV</button>
              <button className="btn" onClick={() => setRangeModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
