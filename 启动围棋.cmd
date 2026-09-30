@echo off
chcp 65001 >nul
title Go - KataGo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Please install Node.js from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
