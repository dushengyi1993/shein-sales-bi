Option Explicit

Dim shell, scriptPath, workDir, powerShellPath, cmd, rc

If WScript.Arguments.Count < 2 Then
  WScript.Quit 64
End If

scriptPath = WScript.Arguments.Item(0)
workDir = WScript.Arguments.Item(1)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workDir

powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = Quote(powerShellPath) & " -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(scriptPath)

rc = shell.Run(cmd, 0, True)
WScript.Quit rc

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
