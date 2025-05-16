@echo off
REM -----------------------------------------------
REM Activate the venv and launch the Flask server
REM Can be pointed to by Windows Task Scheduler
REM -----------------------------------------------

REM Change to script’s directory
cd /d "%~dp0"

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Run the server
python server.py

pause
