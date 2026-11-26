@echo off
title Claude Editor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install it from https://nodejs.org  ^(the "LTS" button^), then run this again.
  echo  Or in PowerShell:  winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo.
  echo  FFmpeg is not installed.
  echo  In PowerShell run:  winget install Gyan.FFmpeg
  echo  then close this window and run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing for the first time, this takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo  Claude Editor is starting. Your browser will open in a moment.
echo  Keep this window open while you edit. Close it to quit.
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:5317"
node server/index.js
pause
