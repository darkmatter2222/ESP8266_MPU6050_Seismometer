import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ADMIN / CONFIGURATION PAGE                                      ║
// ╚══════════════════════════════════════════════════════════════════╝
export default function Admin() {
  const navigate = useNavigate();

  // ── State ──────────────────────────────────────────────────────
  const [config, setConfig] = useState(null);
  const [reinitStatus, setReinitStatus] = useState({ active: [], recent: [] });
  const [deviceStatuses, setDeviceStatuses] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reinitPending, setReinitPending] = useState({});  // deviceId → true
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);

  // ── Toast helper ───────────────────────────────────────────────
  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ── Data Fetching ──────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [cfgRes, statusRes, reinitRes] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/status'),
        fetch('/api/config/reinit-status'),
      ]);
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        setConfig(cfg);
      }
      if (statusRes.ok) setDeviceStatuses(await statusRes.json());
      if (reinitRes.ok) setReinitStatus(await reinitRes.json());
    } catch (err) {
      console.error('Admin fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ── Socket.IO for real-time reinit updates ─────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

    socket.on('device:reinit_sent', ({ id, alias, time }) => {
      addToast(`205 sent to ${alias} — awaiting reboot`, 'warning');
      setReinitPending(prev => { const n = { ...prev }; delete n[id]; return n; });
      fetchAll();
    });

    socket.on('device:init', ({ id, alias, time }) => {
      addToast(`${alias} reinitialized successfully`, 'success');
      setReinitPending(prev => { const n = { ...prev }; delete n[id]; return n; });
      fetchAll();
    });

    socket.on('device:heartbeat', ({ id, alias }) => {
      setDeviceStatuses(prev => ({
        ...prev,
        [id]: { ...prev[id], alias, status: 'Online' },
      }));
    });

    socket.on('config:updated', () => {
      fetchAll();
    });

    return () => socket.disconnect();
  }, [addToast, fetchAll]);

  // ── Handlers ───────────────────────────────────────────────────
  const updateGlobal = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const updateSensitivity = (level, value) => {
    setConfig(prev => ({
      ...prev,
      sensitivity: { ...prev.sensitivity, [level]: value },
    }));
    setSaved(false);
  };

  const updateDevice = (deviceId, field, value) => {
    setConfig(prev => ({
      ...prev,
      devices: {
        ...prev.devices,
        [deviceId]: { ...prev.devices[deviceId], [field]: value },
      },
    }));
    setSaved(false);
  };

  const updateDeviceSensitivity = (deviceId, level, value) => {
    setConfig(prev => {
      const dev = prev.devices[deviceId] || {};
      const sens = dev.sensitivity || {};
      return {
        ...prev,
        devices: {
          ...prev.devices,
          [deviceId]: {
            ...dev,
            sensitivity: { ...sens, [level]: value === '' ? null : parseFloat(value) },
          },
        },
      };
    });
    setSaved(false);
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaved(true);
        addToast('Configuration saved', 'success');
      } else {
        addToast('Failed to save configuration', 'error');
      }
    } catch (err) {
      addToast('Network error saving configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  const requestReinit = async (deviceId) => {
    setReinitPending(prev => ({ ...prev, [deviceId]: true }));
    try {
      const res = await fetch(`/api/config/reinit/${encodeURIComponent(deviceId)}`, { method: 'POST' });
      if (res.ok) {
        addToast(`Reinit queued for ${config?.devices?.[deviceId]?.alias || deviceId}`, 'info');
        fetchAll();
      }
    } catch {
      addToast('Failed to request reinit', 'error');
      setReinitPending(prev => { const n = { ...prev }; delete n[deviceId]; return n; });
    }
  };

  const requestReinitAll = async () => {
    const ids = Object.keys(config?.devices || {});
    ids.forEach(id => setReinitPending(prev => ({ ...prev, [id]: true })));
    try {
      const res = await fetch('/api/config/reinit-all', { method: 'POST' });
      if (res.ok) {
        addToast('Reinit queued for ALL devices', 'info');
        fetchAll();
      }
    } catch {
      addToast('Failed to request reinit-all', 'error');
    }
  };

  // ── Render ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        Loading configuration...
      </div>
    );
  }

  const devices = config?.devices || {};
  const activeReinits = reinitStatus.active || [];
  const recentReinits = reinitStatus.recent || [];

  return (
    <div className="admin-page">
      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
        ))}
      </div>

      {/* Header */}
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={() => navigate('/')}>← Dashboard</button>
          <span className="header-icon">⚙️</span>
          <h1>Configuration</h1>
        </div>
        <div className="header-right">
          <button
            className={`save-btn ${saved ? 'saved' : ''}`}
            onClick={saveConfig}
            disabled={saving || saved}
          >
            {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save Configuration'}
          </button>
        </div>
      </header>

      {/* Main content grid */}
      <div className="admin-grid">
        {/* ─── Global Settings ─────────────────────────────── */}
        <div className="admin-panel global-panel">
          <div className="panel-header">Global Settings</div>
          <div className="panel-body">
            <div className="config-group">
              <label>Heartbeat Interval (ms)</label>
              <input
                type="number"
                value={config?.heartbeat_interval || ''}
                onChange={e => updateGlobal('heartbeat_interval', parseInt(e.target.value) || 60000)}
              />
              <span className="config-hint">{((config?.heartbeat_interval || 60000) / 1000).toFixed(0)}s between device check-ins</span>
            </div>

            <div className="config-group">
              <label>Consensus Window (ms)</label>
              <input
                type="number"
                value={config?.consensus_window_ms || ''}
                onChange={e => updateGlobal('consensus_window_ms', parseInt(e.target.value) || 2000)}
              />
              <span className="config-hint">Time window for cross-device event confirmation</span>
            </div>

            <div className="config-group">
              <label>Status Threshold (seconds)</label>
              <input
                type="number"
                value={config?.status_threshold_seconds || ''}
                onChange={e => updateGlobal('status_threshold_seconds', parseInt(e.target.value) || 120)}
              />
              <span className="config-hint">Device goes Offline after this period of silence</span>
            </div>

            <div className="config-divider" />
            <h3 className="config-section-title">Sensitivity Thresholds (ΔG)</h3>

            <div className="sensitivity-row">
              <div className="config-group">
                <label className="level-minor">Minor</label>
                <input
                  type="number"
                  step="0.001"
                  value={config?.sensitivity?.minor ?? ''}
                  onChange={e => updateSensitivity('minor', parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="config-group">
                <label className="level-moderate">Moderate</label>
                <input
                  type="number"
                  step="0.01"
                  value={config?.sensitivity?.moderate ?? ''}
                  onChange={e => updateSensitivity('moderate', parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="config-group">
                <label className="level-severe">Severe</label>
                <input
                  type="number"
                  step="0.01"
                  value={config?.sensitivity?.severe ?? ''}
                  onChange={e => updateSensitivity('severe', parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ─── Reinit Controls ─────────────────────────────── */}
        <div className="admin-panel reinit-panel">
          <div className="panel-header">
            Reinitialize Devices
            <button className="reinit-all-btn" onClick={requestReinitAll}>⟳ Reinit All</button>
          </div>
          <div className="panel-body">
            <p className="config-hint" style={{ marginBottom: 12 }}>
              Force devices to reboot and re-fetch configuration. The device will receive HTTP 205 on its next heartbeat,
              triggering a reboot. After reboot it calls <code>/api/init</code> to load the latest config.
            </p>

            {/* Active reinit flags */}
            {activeReinits.length > 0 && (
              <div className="reinit-active">
                <h4>Active Requests</h4>
                {activeReinits.map((r, i) => (
                  <div key={i} className={`reinit-flag reinit-${r.status}`}>
                    <span className="reinit-device">{r.alias || r.deviceId}</span>
                    <span className="reinit-status-badge">{r.status}</span>
                    <span className="reinit-time">{new Date(r.requested_at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Recent completed */}
            {recentReinits.length > 0 && (
              <div className="reinit-recent">
                <h4>Recently Completed</h4>
                {recentReinits.map((r, i) => (
                  <div key={i} className="reinit-flag reinit-completed">
                    <span className="reinit-device">{r.alias || r.deviceId}</span>
                    <span className="reinit-status-badge">completed</span>
                    <span className="reinit-time">{r.completed_at ? new Date(r.completed_at).toLocaleTimeString() : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ─── Per-Device Cards ────────────────────────────── */}
        {Object.entries(devices).map(([id, dev]) => {
          const status = deviceStatuses[id] || {};
          const isOnline = status.status === 'Online';
          const activeFlag = activeReinits.find(r => r.deviceId === id);
          const reinitPhase = reinitPending[id] ? 'requesting'
            : activeFlag?.status === 'pending' ? 'pending'
            : activeFlag?.status === 'sent' ? 'sent'
            : null;
          const isBlocked = !!reinitPhase;
          const hasOverride = dev.heartbeat_interval != null || (dev.sensitivity && Object.values(dev.sensitivity).some(v => v != null));

          return (
            <div key={id} className={`admin-panel device-panel ${isOnline ? 'device-online' : 'device-offline'}`}>
              <div className="panel-header">
                <div className="device-header-left">
                  <span className={`chip-dot ${isOnline ? 'dot-online' : 'dot-offline'}`} />
                  <span className="device-alias">{dev.alias || id}</span>
                  {hasOverride && <span className="override-badge">OVERRIDE</span>}
                </div>
                <button
                  className={`reinit-btn ${isBlocked ? 'pending' : ''}`}
                  onClick={() => requestReinit(id)}
                  disabled={isBlocked}
                >
                  {reinitPhase === 'requesting' ? '⏳ Sending...'
                    : reinitPhase === 'pending' ? '⏳ Waiting for heartbeat...'
                    : reinitPhase === 'sent' ? '🔄 Rebooting...'
                    : '⟳ Reinit'}
                </button>
              </div>
              <div className="panel-body">
                <div className="device-info-row">
                  <div className="device-info">
                    <span className="info-label">MAC</span>
                    <span className="info-value mono">{id}</span>
                  </div>
                  <div className="device-info">
                    <span className="info-label">Status</span>
                    <span className={`info-value ${isOnline ? 'text-online' : 'text-offline'}`}>
                      {status.status || 'Unknown'}
                    </span>
                  </div>
                  <div className="device-info">
                    <span className="info-label">Last Init</span>
                    <span className="info-value mono">
                      {status.last_init ? new Date(status.last_init).toLocaleString() : '—'}
                    </span>
                  </div>
                </div>

                <div className="config-divider" />
                <h4 className="config-section-title">Per-Device Overrides <span className="config-hint">(blank = use global)</span></h4>

                <div className="config-group">
                  <label>Heartbeat Interval (ms)</label>
                  <input
                    type="number"
                    placeholder={`Global: ${config?.heartbeat_interval || 60000}`}
                    value={dev.heartbeat_interval ?? ''}
                    onChange={e => updateDevice(id, 'heartbeat_interval', e.target.value === '' ? null : parseInt(e.target.value))}
                  />
                </div>

                <div className="sensitivity-row">
                  <div className="config-group">
                    <label className="level-minor">Minor</label>
                    <input
                      type="number"
                      step="0.001"
                      placeholder={`${config?.sensitivity?.minor ?? 0.035}`}
                      value={dev.sensitivity?.minor ?? ''}
                      onChange={e => updateDeviceSensitivity(id, 'minor', e.target.value)}
                    />
                  </div>
                  <div className="config-group">
                    <label className="level-moderate">Moderate</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder={`${config?.sensitivity?.moderate ?? 0.10}`}
                      value={dev.sensitivity?.moderate ?? ''}
                      onChange={e => updateDeviceSensitivity(id, 'moderate', e.target.value)}
                    />
                  </div>
                  <div className="config-group">
                    <label className="level-severe">Severe</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder={`${config?.sensitivity?.severe ?? 0.50}`}
                      value={dev.sensitivity?.severe ?? ''}
                      onChange={e => updateDeviceSensitivity(id, 'severe', e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
