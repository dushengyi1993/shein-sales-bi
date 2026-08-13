Option Explicit

Dim shell, cmd, rc, i, exePath, workDir, scriptPath, powerShellPath

If WScript.Arguments.Count < 2 Then
  WScript.Quit 64
End If

Set shell = CreateObject("WScript.Shell")

' Generic mode: run <exePath> <workDir> [arg...]
' Launches a console executable with a hidden window (SW_HIDE) and waits for
' it, so the calling scheduled task stays Running until the child exits and
' receives the child exit code (restart policy preserved). No cmd.exe is
' involved: the command line is parsed by CreateProcess only, and every part
' is re-quoted with embedded quotes doubled, so argument content cannot
' inject extra commands or quotes.
If LCase(WScript.Arguments.Item(0)) = "run" And WScript.Arguments.Count >= 3 Then
  exePath = WScript.Arguments.Item(1)
  workDir = WScript.Arguments.Item(2)

  If Len(exePath) = 0 Or Len(workDir) = 0 Then
    WScript.Quit 64
  End If

  shell.CurrentDirectory = workDir

  cmd = Quote(exePath)
  For i = 3 To WScript.Arguments.Count - 1
    cmd = cmd & " " & Quote(WScript.Arguments.Item(i))
  Next

  On Error Resume Next
  rc = shell.Run(cmd, 0, True)
  If Err.Number <> 0 Then
    WScript.Quit 255
  End If
  On Error GoTo 0
  WScript.Quit rc
End If

' Legacy mode (unchanged): ps1ScriptPath workDir

scriptPath = WScript.Arguments.Item(0)
workDir = WScript.Arguments.Item(1)

shell.CurrentDirectory = workDir

powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = Quote(powerShellPath) & " -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(scriptPath)

rc = shell.Run(cmd, 0, True)
WScript.Quit rc

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
