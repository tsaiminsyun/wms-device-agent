; Inno Setup script for wms-device-agent.
;
; This installer REPLACES the old zip + .bat flow:
;   - install/uninstall/upgrade all go through setup.exe
;   - re-running a newer setup.exe upgrades in place (config.json is preserved)
;   - it registers the same "logon autostart" scheduled task the .bat used to
;
; The payload (exe + node_modules + config + docs) is cross-built on macOS/Linux
; by packaging/windows/build-win.sh into dist-win/wms-device-agent/. Only THIS
; step needs Windows, because Inno's compiler (ISCC.exe) is Windows-only.
;
; Compile (on Windows): unzip the kit produced by `pnpm package:win`, then run
;   ISCC wms-device-agent.iss
; That kit lays the installed files under .\payload\ next to this script and
; prepends the app version, so no command-line arguments are needed. The compiled
; installer lands in .\Output\. (Both defines are still overridable via ISCC /D.)

#define MyAppName "wms-device-agent"
#define MyAppDisplayName "WMS Device Agent"
#define MyAppPublisher "Daigobang"
#define MyAppURL "http://127.0.0.1:8788/health"
#define TaskName "wms-device-agent"

; AppVersion is normally prepended by build-win.sh; this is the fallback default.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; The installed files sit in .\payload\ (relative to this script) inside the kit zip.
#ifndef PayloadDir
  #define PayloadDir "payload"
#endif

[Setup]
; A stable AppId is what lets a newer setup.exe recognise and upgrade a prior install.
AppId={{7E9B2C1A-4D5F-4A6B-9C3E-1F2A3B4C5D6E}
AppName={#MyAppDisplayName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
AppSupportURL={#MyAppURL}
; Install into Program Files (conventional program location). The app keeps its
; "config + logs beside the exe" layout; because the agent ALWAYS runs elevated
; (logon task /RL HIGHEST, and the exe self-elevates before any file I/O), it can
; write logs\ and read config.json here without UAC virtualization redirecting them.
; Note: config.json gets a users-modify ACL (see [Files]) so it stays directly
; editable/overwritable without an elevated editor, even under Program Files.
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppDisplayName}
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppDisplayName}
UninstallDisplayIcon={app}\wms-device-agent.exe
; Creating the scheduled task and writing under Program Files needs admin.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=wms-device-agent-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Our background worker has no window, so Inno's window-message close can't reach
; it. We stop it ourselves in PrepareToInstall (see [Code]) before copying files.
CloseApplications=no

[Tasks]
; Optional desktop shortcut, offered as a checkbox during install (default: on).
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Everything except config.json is refreshed on every install/upgrade.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; \
  Excludes: "config.json"; \
  Flags: recursesubdirs createallsubdirs ignoreversion
; config.json: written only on first install (onlyifdoesntexist), so a deployment's
; edited settings (allowedOrigins, logDir, ...) survive in-place UPGRADES (which don't
; run the uninstaller). It is NOT flagged uninsneveruninstall, so a real UNINSTALL
; removes it too - a clean uninstall leaves nothing behind.
; Permissions: users-modify grants the Users group Modify on this file so a
; deployer can edit/overwrite config.json directly (no "Run as admin" editor),
; even though it lives under Program Files.
Source: "{#PayloadDir}\config.json"; DestDir: "{app}"; \
  Permissions: users-modify; Flags: onlyifdoesntexist

[Icons]
; Shortcuts point straight at the exe: clicking it starts the program (the exe
; self-elevates -> one UAC -> shows the status window and starts the background
; worker; if already running it just opens the status window without a duplicate).
Name: "{group}\{#MyAppDisplayName}"; Filename: "{app}\wms-device-agent.exe"; \
  WorkingDir: "{app}"
; Desktop shortcut (same), only if the user ticked the box.
Name: "{autodesktop}\{#MyAppDisplayName}"; Filename: "{app}\wms-device-agent.exe"; \
  WorkingDir: "{app}"; Tasks: desktopicon

[UninstallDelete]
; Complete cleanup: remove everything the app touched that Inno doesn't already track.
; config.json is tracked (no uninsneveruninstall) and removed automatically, but list it
; explicitly too in case it was overwritten in place; config.json.bak is runtime-created.
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\config.json.bak"
; Runtime log folder under the user's Documents (Documents\wms-device-agent\logs).
Type: filesandordirs; Name: "{userdocs}\wms-device-agent"

[Code]
const
  TASK_NAME = '{#TaskName}';

{ Stop the logon task and kill every instance so files aren't locked during copy
  and the crash-respawn supervisor can't bring the worker back mid-upgrade. }
procedure StopAgent();
var
  ResultCode: Integer;
  i: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "' + TASK_NAME + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  for i := 1 to 10 do
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM tray_windows_release.exe',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM wms-device-agent.exe',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { taskkill returns 128 when no matching process was found -> nothing left. }
    if ResultCode = 128 then
      Break;
    Sleep(500);
  end;
end;

{ Runs just before files are copied, on both fresh install and upgrade. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopAgent();
  Result := '';
end;

{ Register the logon autostart task (HIGHEST privileges, hidden VBS launcher) and
  start it now so no log off/on is needed. A task - not a service - is used on
  purpose: the tray icon and keyboard fallback need the interactive session. }
procedure CreateAndStartTask();
var
  ResultCode: Integer;
  TR: string;
begin
  { Produces:  /TR "wscript.exe \"C:\...\run-hidden.vbs\""  (\" = a literal quote to schtasks). }
  TR := 'wscript.exe \"' + ExpandConstant('{app}\run-hidden.vbs') + '\"';
  Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/Create /F /TN "' + TASK_NAME + '" /SC ONLOGON /RL HIGHEST /TR "' + TR + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Run /TN "' + TASK_NAME + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ Make config.json directly editable/overwritable by ordinary users (no "Run as admin"),
  even under Program Files. The [Files] Permissions flag only applies when Inno actually
  installs the file, so onlyifdoesntexist (upgrades / pre-existing file) would leave the
  old admin-only ACL. Setting it here with icacls on EVERY install/upgrade guarantees the
  right applies universally. *S-1-5-32-545 = the built-in Users group (locale-independent);
  (M) = Modify, which covers editing and overwriting the file in place. }
procedure GrantConfigWritable();
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\icacls.exe'),
    '"' + ExpandConstant('{app}\config.json') + '" /grant *S-1-5-32-545:(M)',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    GrantConfigWritable();
    CreateAndStartTask();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopAgent();
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /F /TN "' + TASK_NAME + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
