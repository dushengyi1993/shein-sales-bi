@echo off
setlocal
set "ROOT=%~dp0"
set "PORTAL=%ROOT%outputs\bi-portal\index.html"
if not exist "%PORTAL%" (
  echo SHEIN BI portal was not found:
  echo %PORTAL%
  echo.
  echo Please run scripts\run_bi_daily_pipeline.ps1 first.
  pause
  exit /b 1
)
start "" "%PORTAL%"
endlocal
