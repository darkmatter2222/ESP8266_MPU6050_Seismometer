@echo off
REM -----------------------------------------------
REM Activate the venv and launch the Flask server and dashboard UI
REM Can be pointed to by Windows Task Scheduler
REM -----------------------------------------------

REM Change to script’s directory
cd /d "%~dp0"

REM Launch server in a new maximized console with the virtual env activated
start "" /max cmd /k "cd /d %~dp0 && call venv\Scripts\activate.bat && python server.py & pause"

REM Launch Streamlit dashboard UI
start "" /max cmd /k "cd /d %~dp0 && call venv\Scripts\activate.bat && streamlit run dashboard.py --server.port 8501 & pause"

REM Original window exits
exit /b
