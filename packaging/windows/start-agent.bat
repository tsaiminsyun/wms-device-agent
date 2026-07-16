@echo off
rem ============================================================
rem  Start wms-device-agent with a visible STATUS WINDOW.
rem
rem  The window shows the live log. Closing it with the X button
rem  does NOT stop the agent - the agent keeps running in the
rem  background with a system-tray icon (bottom-right, may be in
rem  the "^" hidden-icons area). To fully quit: right-click the
rem  tray icon -> "Exit". Double-clicking the exe does the same.
rem
rem    - Log file:  agent.log (this folder)
rem    - Status:    http://127.0.0.1:8788/health
rem ============================================================
cd /d "%~dp0"
start "WMS Device Agent" "%~dp0wms-device-agent.exe"
