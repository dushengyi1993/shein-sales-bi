@echo off
setlocal
set "ROOT=%~dp0"
set "BRIEF=%ROOT%outputs\bi-briefings\latest.md"
if not exist "%BRIEF%" (
  echo SHEIN BI Markdown briefing not found:
  echo %BRIEF%
  pause
  exit /b 1
)
start "" "%BRIEF%"
