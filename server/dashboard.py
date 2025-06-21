import os
import pandas as pd
import plotly.express as px
import streamlit as st
import requests
from streamlit_autorefresh import st_autorefresh
import math

# Configuration
# Use localhost for API by default
API_URL = os.getenv("API_URL", "http://127.0.0.1:3000")
UI_PORT = int(os.getenv("UI_PORT", 8501))

# Page setup
st.set_page_config(page_title="Seismometer Dashboard", layout="wide", initial_sidebar_state="collapsed")
# Global CSS to hide menu, footer, reduce padding
st.markdown("""
<style>
  #MainMenu {visibility: hidden;}  
  footer {visibility: hidden;}
  header {visibility: hidden; height:0px;}  /* drop header */
  .css-1d391kg {padding-top: 0rem;}  /* reduce top padding */
  .block-container {padding-top: 0rem !important;} /* remove extra top space */
  /* Cyberpunk fonts */
  .css-1dq8tca h1 {font-family: 'Orbitron', sans-serif; color: #00ffea;}
</style>
""", unsafe_allow_html=True)

# Pixel-perfect cyberpunk CSS
st.markdown("""
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Share+Tech+Mono&display=swap');
  /* Minimal neon grid backdrop */
  html, body, [class*="block-container"] {
    font-family: 'Share Tech Mono', monospace;
    background: #0a0a0d url('') no-repeat center center fixed;
    background-size: cover;
  }
  /* Glass panels */
  .block-container {
    backdrop-filter: blur(20px);
    background-color: rgba(10,10,25,0.85) !important;
    padding: 1rem 2rem !important;
    border-radius: 8px;
  }
  /* Neon headings */
  .section-title { font-family: 'Orbitron', monospace; font-size:1.3rem; color:#00ffab; text-shadow:0 0 6px #00ffab; margin-top:1rem;}
  /* Metrics cards */
  .stMetric {
    background: rgba(30,30,50,0.9);
    border:1px solid #00ffaa;
    border-radius:6px;
    padding:0.8rem;
    box-shadow:0 2px 8px #00ffaa55;
  }
  /* Node chips */
  .node-status { display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1rem; }
  .node-chip { padding:0.4rem 0.8rem; border-radius:4px; border:1px solid #00ffaa; color:#fff; background:rgba(10,10,25,0.7); font-size:0.95rem;}
  .node-chip.online { background:#00ffaa; color:#000; }
  .node-chip.offline { border-color:#ff3366; }
  /* Selectbox styling */
  div[data-baseweb="select"] > div { background:rgba(20,20,40,0.9) !important; box-shadow:inset 0 0 4px #00ffaa55; border:1px solid #00ffaa !important; border-radius:4px; }
  /* Tables & charts frames */
  .stDataFrame, .stTable { background:rgba(20,20,40,0.9) !important; border:1px solid #00ffaa; border-radius:4px; box-shadow:0 2px 6px #00ffaa33; }
  .stPlotlyChart > div > div { background:transparent !important; border:none !important; box-shadow:none !important; border-radius:4px; }
  /* Divider line */
  .divider { border:none; height:2px; background:#00ffaa; margin:1.5rem 0 1rem; }
</style>
""", unsafe_allow_html=True)

# Data fetchers
@st.cache_data(ttl=5)
def fetch_statuses():
    try:
        resp = requests.get(f"{API_URL}/api/status", timeout=5)
        return resp.json()
    except:
        return {}

@st.cache_data(ttl=5)
def fetch_events():
    try:
        resp = requests.get(f"{API_URL}/api/events", timeout=5)
        df = pd.DataFrame(resp.json())
    except:
        df = pd.read_json("events.txt", lines=True)
    # parse timestamps as UTC (tz-aware)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    # remove any records missing id or alias
    df = df.dropna(subset=["id", "alias"])
    return df

@st.cache_data(ttl=60)
def fetch_http_logs():
    try:
        resp = requests.get(f"{API_URL}/api/http_logs", timeout=5)
        dfh = pd.DataFrame(resp.json())
        dfh["timestamp"] = pd.to_datetime(dfh["timestamp"], utc=True)
        return dfh
    except:
        return pd.DataFrame(columns=["timestamp", "endpoint"])

# Auto-refresh every 60s
st_autorefresh(interval=60_000, key="refresh")
# Fetch data immediately after refresh
df = fetch_events()
http_df = fetch_http_logs()

# Retrieve or set default history period
period = st.session_state.get('period', 'Real-time (24h)')
# Compute time window based on period using timezone-aware UTC
now = pd.Timestamp.now(tz='UTC')
# Compute time window based on period
start = now - {
    'Real-time (24h)': pd.Timedelta(hours=24),
    '7 days': pd.Timedelta(days=7),
    '15 days': pd.Timedelta(days=15),
    '30 days': pd.Timedelta(days=30)
}[period]
# Filter data
df_window = df[(df['timestamp'] >= start) & df['alias'].notnull()]
http_window = http_df[pd.to_datetime(http_df['timestamp']) >= start]

# Node status and history selector side by side (narrower status)
status_col, hist_col = st.columns([2,1])
with hist_col:
    period = st.selectbox("History Window", ["Real-time (24h)", "7 days", "15 days", "30 days"], key='period')
with status_col:
    st.subheader("Nodes Status")
    for dev, info in fetch_statuses().items():
        alias = info.get('alias', dev)
        stat = info.get('status', 'Offline')
        color_val = '#00ff00' if stat == 'Online' else '#ff0044'
        st.markdown(
            f"<span style='color:{color_val};font-size:16px;margin-right:1rem'>{alias}: {stat}</span>",
            unsafe_allow_html=True
        )
# After selector/status, re-filter df_window based on updated period
start = now - {
    "Real-time (24h)": pd.Timedelta(hours=24),
    "7 days": pd.Timedelta(days=7),
    "15 days": pd.Timedelta(days=15),
    "30 days": pd.Timedelta(days=30)
}[period]
# Re-filter data after period change
df_window = df[(df["timestamp"] >= start) & df["alias"].notnull()]
# Also recompute consensus_df and HTTP window
consensus_df = df[df['status']=='CONFIRMED']
http_window = http_df[pd.to_datetime(http_df['timestamp']) >= start]

# Compute key metrics based on df_window after period change
total_events = len(df_window)
last_event_time = df_window['timestamp'].max() if not df_window.empty else None
minutes_since_last = round((now - last_event_time).total_seconds()/60,1) if last_event_time else None
last_consensus_time = consensus_df['timestamp'].max() if not consensus_df.empty else None
minutes_since_consensus = round((now - last_consensus_time).total_seconds()/60,1) if last_consensus_time else None
max_delta = round(df_window['deltaG'].max(),3) if not df_window.empty else None

# Display key metrics
keys = st.columns(4)
keys[0].metric('Total Events', total_events)
keys[1].metric('Min Since Last Event', f"{minutes_since_last}" if minutes_since_last is not None else '-')
keys[2].metric('Min Since Last Consensus', f"{minutes_since_consensus}" if minutes_since_consensus is not None else '-')
keys[3].metric('Max ΔG', f"{max_delta}" if max_delta is not None else '-')

# Compute statuses based on last 5min heartbeat
# Determine online status: heartbeat in past 5 min
devices = df["id"].unique().tolist()
last_ts = df.groupby("id")["timestamp"].max()
statuses = {}
for device in devices:
    lt = last_ts.get(device)
    if lt is None or pd.isna(lt):
        statuses[device] = "Offline"
    else:
        # use Python datetime subtraction to avoid overflow on large intervals
        delta = (now.to_pydatetime() - lt.to_pydatetime()).total_seconds()
        statuses[device] = "Online" if delta <= 5*60 else "Offline"

# Layout: Consensus (left) and DeltaG (right)
st.markdown("---")
cols = st.columns([3, 3])
with cols[0]:
    st.subheader("Consensus Events (Confirmed)")
    if not consensus_df.empty:
        st.table(consensus_df[["timestamp", "aliases"]].rename(columns={"aliases": "Devices"}).set_index("timestamp"))
    else:
        st.markdown("_No consensus events_")
with cols[1]:
    st.subheader("DeltaG Over Time")
    if not df_window.empty:
        # scatter with custom symbols for each severity
        fig_delta = px.scatter(
            df_window,
            x="timestamp",
            y="deltaG",
            color="alias",
            symbol="level",
            symbol_map={
                'minor': 'x',
                'moderate': 'cross',
                'severe': 'star'
            },
            template="plotly_dark",
            title="ΔG by Node & Severity",
            opacity=0.8
        )
        # make plot background transparent
        fig_delta.update_layout(
            plot_bgcolor='rgba(0,0,0,0)',
            paper_bgcolor='rgba(0,0,0,0)'
        )
        st.plotly_chart(fig_delta, use_container_width=True)

# HTTP traffic full width below
st.markdown("---")
st.subheader("HTTP Traffic Volume by Endpoint (1-min)")
if not http_window.empty:
    df_http = http_window.set_index("timestamp").groupby("endpoint").resample("1T")["endpoint"].count().reset_index(name="count")
    fig_http = px.area(df_http, x="timestamp", y="count", color="endpoint", template="plotly_dark")
    st.plotly_chart(fig_http, use_container_width=True)

# Recent DeltaG Reports with minutes since event
st.markdown("---")
st.subheader("Recent DeltaG Reports")
recent = df_window[df_window["deltaG"].notnull()].copy()
if not recent.empty:
    recent['min_since'] = recent['timestamp'].apply(lambda t: math.floor((now - t).total_seconds()/60))
    recent = recent.sort_values("timestamp", ascending=False).head(10)
    st.table(recent.set_index("timestamp")[['alias','deltaG','min_since']].rename(columns={'min_since':'Min Since (min)'}))
else:
    st.markdown("_No deltaG reports_")
