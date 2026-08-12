@echo off
rem PR Monitor stopper. Double-click this file to stop the running dashboard server.
rem The start launcher is pr-monitor.cmd; this is its counterpart.
rem
rem NOTE: keep this file ASCII-only with CRLF line endings (same reason as pr-monitor.cmd).
rem cmd.exe reads batch files in the OEM code page (CP932 on Japanese Windows).

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Close the PR Monitor window manually.
  pause
  exit /b 1
)

node src\stop.mjs %*
if errorlevel 1 (
  echo.
  echo Could not stop the server. See the message above.
  pause
  exit /b 1
)

rem Keep the message readable when started by double-click.
rem timeout fails when stdin is redirected (called from a script), so drop its exit code.
timeout /t 3 >nul 2>&1
exit /b 0
