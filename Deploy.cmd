@echo off
REM Deploy.cmd - wrapper to run Deploy.ps1 under bypass execution policy

REM Determine script directory
set SCRIPT_DIR=%~dp0

REM Call PowerShell with bypass
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%Deploy.ps1" %*
