Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' 启动前先把 Gemini 的固定程序恢复成验收时的那一份（被它自带的更新程序换掉的话），见 tools\pinned-programs.cjs
sh.Run "cmd /c node """ & dir & "\tools\pinned-programs.cjs"" restore >> """ & dir & "\logs\relay.log"" 2>&1", 0, True
sh.Run "cmd /c """ & dir & "\run-hidden.bat""", 0, False
