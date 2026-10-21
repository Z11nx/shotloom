@echo off
rem Double-click to start Shotloom on Windows. Keep this window open while you work.
rem Port, ffmpeg/ffprobe paths and provider come from .env (see .env.example).
setlocal
cd /d "%~dp0" || goto :no_folder

where bun >nul 2>&1
if errorlevel 1 goto :no_bun

if not exist "node_modules\" (
  echo Installing dependencies...
  call bun install
  if errorlevel 1 goto :install_failed
)

rem Checks ffmpeg/ffprobe as configured, builds, starts the server and opens the configured port.
call bun run scripts/launch.ts
set "SHOTLOOM_EXIT=%errorlevel%"
if not "%SHOTLOOM_EXIT%"=="0" pause
exit /b %SHOTLOOM_EXIT%

:no_folder
echo Could not open the Shotloom folder: "%~dp0"
pause
exit /b 1

:no_bun
echo Bun was not found in this window.
echo If you just installed it, close this window and start Shotloom again.
echo Otherwise install it, see README.md section "Windows setup".
pause
exit /b 1

:install_failed
echo bun install failed. See the messages above.
pause
exit /b 1
