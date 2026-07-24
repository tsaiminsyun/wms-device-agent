@echo off
rem INTERNAL: hidden autostart entry (launched by run-hidden.vbs at logon).
rem WMS_LAUNCHER_QUIET=1 -> the exe starts the background worker (tray icon)
rem and exits immediately, leaving no window. Do not double-click this
rem directly - use start-agent.bat (or the exe) for a status window.
rem The worker writes its own dated log (wms-agent-YYYY-MM-DD.log), so no
rem redirect is needed here.
cd /d "%~dp0"
set "WMS_LAUNCHER_QUIET=1"
"%~dp0wms-device-agent.exe"
