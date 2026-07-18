@echo off
rem ============================================================
rem  Start wms-device-agent (same as double-clicking the exe).
rem
rem  No window is shown - the agent runs silently with a
rem  system-tray icon (bottom-right, may be in the "^" hidden-
rem  icons area). Right-click the tray icon for:
rem  Open Logs / Connection Status / Restart Service / Exit.
rem
rem    - Logs:    logs\wms-agent-YYYY-MM-DD.log (daily rolling)
rem    - Status:  http://127.0.0.1:8788/health
rem ============================================================
cd /d "%~dp0"
start "" "%~dp0wms-device-agent.exe"
