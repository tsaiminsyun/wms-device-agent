@echo off
rem Start wms-device-agent with output appended to agent.log.
rem Working directory is set to this folder so config.json is found.
cd /d "%~dp0"
"%~dp0wms-device-agent.exe" >> "%~dp0agent.log" 2>&1
