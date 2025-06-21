import os
import pandas as pd
import plotly.express as px
import streamlit as st
import requests

# Configuration
# Use localhost for API by default
API_URL = os.getenv("API_URL", "http://127.0.0.1:3000")
UI_PORT = int(os.getenv("UI_PORT", 8501))

# Page setup
st.set_page_config(page_title="Seismometer Dashboard", layout="wide", initial_sidebar_state="collapsed")
# Global CSS to hide menu, footer and set dark theme padding
st.markdown("""
<style>
  #MainMenu {visibility: hidden;} 
  footer {visibility: hidden;}
  header {visibility: hidden;}
  .css-1d391kg {padding-top: 1rem;}  /* adjust content padding */
</style>
""", unsafe_allow_html=True)

# Cyberpunk CSS
st.markdown(
    """
    <style>
    .reportview-container {background-color: #0f0f0f; color: #00ffea;}
    </style>
    """, unsafe_allow_html=True
)

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
    # parse timestamps and drop timezone to allow tz-naive comparisons
    df["timestamp"] = pd.to_datetime(df["timestamp"])  
    try:
        df["timestamp"] = df["timestamp"].dt.tz_localize(None)
    except Exception:
        pass
    return df

# Load raw data
df = fetch_events()

# Auto-refresh every 5 seconds via meta tag and JS countdown
st.markdown(
    """
    <meta http-equiv="refresh" content="5">
    <script>
      let countdown = 5;
      setInterval(() => {
        countdown--;
        document.getElementById("countdown").innerText = `Refreshing in ${countdown}s`;
        if (countdown <= 0) location.reload();
      }, 1000);
    </script>
    <div id="countdown" style="color:#00ffea;font-size:16px;">Refreshing in 5s</div>
    """, unsafe_allow_html=True
)

# Time window selection
period = st.selectbox("History Window", ["Real-time (24h)", "7 days", "15 days", "30 days"], index=0)
now = pd.Timestamp.now()
if period == "Real-time (24h)":
    start = now - pd.Timedelta(hours=24)
elif period == "7 days":
    start = now - pd.Timedelta(days=7)
elif period == "15 days":
    start = now - pd.Timedelta(days=15)
else:
    start = now - pd.Timedelta(days=30)

# Filter by window
df_window = df[df["timestamp"] >= start]

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

# Three-column layout: status, activity, earthquakes
col1, col2, col3 = st.columns([1, 3, 3])
with col1:
    st.subheader("Nodes")
    for device, status in statuses.items():
        clr = "#00ff00" if status == "Online" else "#ff0044"
        st.markdown(f"<span style='color:{clr};font-size:16px;'>{device}: {status}</span>", unsafe_allow_html=True)
with col2:
    st.subheader("Activity Level (All Traffic)")
    if not df_window.empty:
        # raw level readings for all events
        fig_raw = px.line(df_window, x="timestamp", y="level", color="id", template="plotly_dark", height=350, title="Level Readings")
        st.plotly_chart(fig_raw, use_container_width=True)
with col3:
    st.subheader("DeltaG Readings")
    df_raw = df_window[df_window["deltaG"].notnull()]
    if not df_raw.empty:
        fig2 = px.line(df_raw, x="timestamp", y="deltaG", color="alias", template="plotly_dark", height=350)
        st.plotly_chart(fig2, use_container_width=True)

# Consensus table
st.markdown("---")
st.subheader("Consensus Events (Confirmed)")
consensus = df[df["status"] == "CONFIRMED"]
if not consensus.empty:
    st.table(consensus[["timestamp", "aliases"]].rename(columns={"aliases": "Devices"}).set_index("timestamp"))
else:
    st.markdown("_No consensus events_")
# Recent DeltaG Reports
st.markdown("---")
st.subheader("Recent DeltaG Reports")
recent = df_window[df_window["deltaG"].notnull()][["timestamp", "alias", "deltaG"]]
if not recent.empty:
    recent = recent.sort_values("timestamp", ascending=False).head(10)
    st.table(recent.set_index("timestamp"))
else:
    st.markdown("_No deltaG reports_")
