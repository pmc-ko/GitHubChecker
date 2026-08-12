@echo off
rem PR Monitor desktop app launcher (double-click this file).
rem 1) If Electron is installed (npm install), start the real app window + tray.
rem 2) Otherwise fall back to Edge/Chrome app mode: own window, no tabs, no address bar.
rem
rem NOTE: keep this file ASCII-only with CRLF line endings (see pr-monitor.cmd).

cd /d "%~dp0"

set "ELECTRON=node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" (
  start "" "%ELECTRON%" .
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

echo Electron is not installed. Run "npm install" once for the app window with tray icon.
echo Falling back to browser app mode.

set "PRPORT="
for /f "usebackq delims=" %%p in (`node --input-type=commonjs -e "import('./src/config.mjs').then(m=>m.loadConfig()).then(c=>console.log(process.env.PORT||c.port))"`) do set "PRPORT=%%p"
if not defined PRPORT set "PRPORT=8787"

rem Already running? server.mjs notices the busy port and exits without starting a second one.
start "PR Monitor server" /min node src\server.mjs --no-open

set "APPBROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%APPBROWSER%" set "APPBROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%APPBROWSER%" set "APPBROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%APPBROWSER%" (
  echo Neither Edge nor Chrome was found. Open http://127.0.0.1:%PRPORT%/ manually.
  pause
  exit /b 1
)

start "" "%APPBROWSER%" --app=http://127.0.0.1:%PRPORT%/ --window-size=1440,920
exit /b 0
