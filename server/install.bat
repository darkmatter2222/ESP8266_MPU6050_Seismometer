@echo off
REM -----------------------------------------------
REM 1) Create & activate virtual environment
REM 2) Install/upgrade pip and dependencies
REM Run this once to set up your project
REM -----------------------------------------------

REM Change to script’s directory
cd /d "%~dp0"

REM Create venv folder
python -m venv venv

REM Activate it
call venv\Scripts\activate.bat

REM Upgrade pip
pip install --upgrade pip

REM Install requirements
pip install -r requirements.txt

echo.
echo Setup complete. Your virtualenv is in %CD%\venv
pause
