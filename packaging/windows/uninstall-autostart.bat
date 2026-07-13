@echo off
rem Remove the autostart task and stop the running agent (if any).
schtasks /Delete /F /TN "wms-device-agent" 2>nul
taskkill /IM wms-device-agent.exe /F >nul 2>&1
echo Autostart removed and agent stopped (if it was running).
pause
