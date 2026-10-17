@echo off
rem Double-click to start Capture FPS. Installs Electron on the first run.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Electron, first run only...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Is Node.js installed?
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" .
