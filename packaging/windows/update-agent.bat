@echo off
setlocal
rem ============================================================
rem  Update wms-device-agent in place. config.json is preserved.
rem  Usage:
rem    1) Drag & drop the new wms-device-agent-*-win-x64.zip onto this file, OR
rem    2) Double-click: picks the newest wms-device-agent-*-win-x64.zip
rem       from your Downloads folder.
rem ============================================================

set "DIR=%~dp0"
set "ZIP=%~1"

if not "%ZIP%"=="" goto :havezip
for /f "delims=" %%f in ('dir /b /o-d "%USERPROFILE%\Downloads\wms-device-agent-*-win-x64.zip" 2^>nul') do (
  set "ZIP=%USERPROFILE%\Downloads\%%f"
  goto :havezip
)
echo No update zip found in Downloads.
echo Drag the new zip onto this file, or put it in your Downloads folder first.
pause
exit /b 1

:havezip
if not exist "%ZIP%" (
  echo Zip not found: %ZIP%
  pause
  exit /b 1
)
echo Updating from: %ZIP%
echo.

echo [1/4] Stopping agent...
taskkill /IM wms-device-agent.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] Backing up config.json...
if exist "%DIR%config.json" copy /y "%DIR%config.json" "%DIR%config.json.bak" >nul

echo [3/4] Extracting new version...
rem Extract to a temp dir first. The zip contains a single top-level folder
rem (wms-device-agent-<version>-win-x64\), so we copy its contents into the
rem install folder in place. (Older flat zips without a top folder still work.)
set "TMPDIR=%TEMP%\wms-device-agent-update"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%TMPDIR%' -Force"
if errorlevel 1 (
  echo Extract failed. Agent was NOT restarted; fix the problem and retry.
  pause
  exit /b 1
)

rem Find the single top-level folder inside the zip; fall back to TMPDIR (flat zip).
set "SRC="
for /d %%d in ("%TMPDIR%\*") do set "SRC=%%d"
if not defined SRC set "SRC=%TMPDIR%"

rem Copy new files over the install folder (existing extras like config.json.bak are kept).
robocopy "%SRC%" "%DIR%." /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NC /NS /NP >nul
if %ERRORLEVEL% GEQ 8 (
  echo Copy failed. Agent was NOT restarted; fix the problem and retry.
  rmdir /s /q "%TMPDIR%" >nul 2>&1
  pause
  exit /b 1
)
rmdir /s /q "%TMPDIR%" >nul 2>&1

if exist "%DIR%config.json.bak" copy /y "%DIR%config.json.bak" "%DIR%config.json" >nul

echo [4/4] Restarting agent...
schtasks /Query /TN "wms-device-agent" >nul 2>&1
if errorlevel 1 (
  start "" "%DIR%start-agent.bat"
) else (
  schtasks /Run /TN "wms-device-agent" >nul
)

echo.
echo Update done. Verify the new version at: http://127.0.0.1:8788/health
pause
