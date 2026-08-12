@echo off
rem PR Monitor launcher. Double-click this file, or make a shortcut to it.
rem If the server is already running, this just opens the dashboard in a browser.
rem
rem NOTE: keep this file ASCII-only with CRLF line endings.
rem cmd.exe reads batch files in the OEM code page (CP932 on Japanese Windows),
rem so UTF-8 Japanese text here becomes mojibake and breaks parsing.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

node src\server.mjs %*
if errorlevel 1 (
  echo.
  echo Failed to start. See the message above.
  pause
  exit /b 1
)
