' Launch start-agent.bat in a hidden window (no console flash at logon).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\start-agent.bat""", 0, False
