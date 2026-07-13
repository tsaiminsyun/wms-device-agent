@echo off
rem Register wms-device-agent to start automatically at user logon (hidden window),
rem then start it immediately.
rem
rem NOTE: a logon task (not a Windows service) is used on purpose: the keyboard
rem fallback types into the interactive user session, which services (session 0)
rem cannot do.

set "DIR=%~dp0"
schtasks /Create /F /TN "wms-device-agent" /SC ONLOGON /RL LIMITED ^
  /TR "wscript.exe \"%DIR%run-hidden.vbs\""
if errorlevel 1 goto :err

schtasks /Run /TN "wms-device-agent" >nul
echo.
echo Done. The agent now starts automatically at logon and is running.
echo Health check:  http://127.0.0.1:8788/health
echo Log file:      %DIR%agent.log
pause
exit /b 0

:err
echo Failed to create the scheduled task.
pause
exit /b 1
