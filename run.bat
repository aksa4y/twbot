@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
 pause
 exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)"
if errorlevel 1 (
 echo Node.js 24 or newer is required.
 pause
 exit /b 1
)
if not exist config\.env (
 copy config\.env.example config\.env >nul
 echo Fill config\.env with your Twitch credentials, then run again.
 notepad config\.env
 exit /b 1
)
if not exist node_modules (
 call npm ci --omit=dev
 if errorlevel 1 (pause & exit /b 1)
)
call npm start
pause
