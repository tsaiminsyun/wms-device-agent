' Launch run-agent.bat in a hidden window (no console). The agent runs in the
' background and shows a system-tray icon; quit it from the tray menu's "Exit".
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\run-agent.bat""", 0, False
