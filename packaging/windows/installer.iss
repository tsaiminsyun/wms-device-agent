; WMS Device Agent — Inno Setup 安裝腳本
; 前置：先執行 packaging/windows/build-win.sh 產生 dist-win/wms-device-agent/，
; 再（於 Windows）以 Inno Setup 6 編譯：iscc packaging\windows\installer.iss
; 版本覆寫：iscc /DMyAppVersion=1.2.3 packaging\windows\installer.iss
;
; 安裝內容：
;   1. 檔案複製到 {app}（config.json 只在首次安裝寫入，升級不覆蓋）。
;   2. 註冊 Windows 服務（wms-device-agent.exe --install-service，node-windows/winsw）：
;      開機自動啟動、異常自動重啟（SCM 復原設定）、授權一般使用者啟停（工作列「重啟服務」免 UAC）。
;   3. HKLM Run 機碼：每位使用者登入自動啟動工作列元件（--tray，經 wscript 隱藏、無主控台視窗）。
;   4. log 寫入 {app}\logs（安裝時開放 Users 修改權限；每日輪替 wms-agent-YYYY-MM-DD.log）。

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "WMS Device Agent"
#define MyAppExe "wms-device-agent.exe"
#define MyDistDir "..\..\dist-win\wms-device-agent"
#define MyServiceName "WMSDeviceAgent"

[Setup]
AppId={{6F1C0A3E-9B7D-4A52-8E4F-2D9C7B1A5E30}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=WMS
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist-win
OutputBaseFilename=wms-device-agent-setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\{#MyAppExe}
CloseApplications=no

[Files]
; config.json 另列（首次才裝、永不覆蓋既有設定、解除安裝保留）。
Source: "{#MyDistDir}\*"; DestDir: "{app}"; Excludes: "config.json,agent.log*,logs\*"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#MyDistDir}\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

[Dirs]
; 服務（SYSTEM）與工作列元件（一般使用者）都要能寫 log。
Name: "{app}\logs"; Permissions: users-modify

[Registry]
; 每位使用者登入時啟動工作列元件（隱藏視窗）。
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "WMSDeviceAgentTray"; ValueData: "wscript.exe //B //Nologo ""{app}\run-tray-hidden.vbs"""; \
  Flags: uninsdeletevalue

[Run]
; 註冊並啟動服務（含 SCM 自動重啟與使用者啟停授權；已安裝則沿用）。
Filename: "{app}\{#MyAppExe}"; Parameters: "--install-service"; Flags: runhidden waituntilterminated; \
  StatusMsg: "正在註冊 Windows 服務…"
; 立即啟動目前使用者的工作列元件（之後每次登入由 Run 機碼啟動）。
Filename: "wscript.exe"; Parameters: "//B //Nologo ""{app}\run-tray-hidden.vbs"""; Flags: nowait; \
  StatusMsg: "正在啟動工作列圖示…"

[UninstallRun]
Filename: "{app}\{#MyAppExe}"; Parameters: "--uninstall-service"; Flags: runhidden waituntilterminated; \
  RunOnceId: "UninstallService"
Filename: "taskkill"; Parameters: "/F /IM {#MyAppExe}"; Flags: runhidden; RunOnceId: "KillAgent"
Filename: "taskkill"; Parameters: "/F /IM tray_windows_release.exe"; Flags: runhidden; RunOnceId: "KillTrayHelper"

[Code]
// 升級/重裝前先停服務並結束執行中的實例，否則檔案被鎖住無法覆蓋。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  R: Integer;
begin
  Exec('sc.exe', 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, R);
  Exec('taskkill.exe', '/F /IM {#MyAppExe}', '', SW_HIDE, ewWaitUntilTerminated, R);
  Exec('taskkill.exe', '/F /IM tray_windows_release.exe', '', SW_HIDE, ewWaitUntilTerminated, R);
  Sleep(1500);
  Result := '';
end;
