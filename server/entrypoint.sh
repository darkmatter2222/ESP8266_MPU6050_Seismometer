#!/bin/bash
set -e

# Start Flask API server in background
echo "Starting Flask API server on port ${PORT:-3000}..."
python server.py &

# Start Streamlit dashboard in foreground
echo "Starting Streamlit dashboard on port ${UI_PORT:-8501}..."
exec streamlit run dashboard.py \
  --server.port "${UI_PORT:-8501}" \
  --server.address 0.0.0.0 \
  --server.headless true \
  --browser.gatherUsageStats false
