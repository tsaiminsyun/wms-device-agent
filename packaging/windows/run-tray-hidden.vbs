' Launch the tray companion (wms-device-agent.exe --tray) with no visible console.
' Installed to the HKLM Run key so it starts for every user at logon.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\wms-device-agent.exe"" --tray", 0, False
