Set WshShell = CreateObject("WScript.Shell")
appDir = "C:\Users\jsj\study"
exePath = appDir & "\node_modules\electron\dist\electron.exe"
WshShell.Run """" & exePath & """ """ & appDir & """", 1, False
