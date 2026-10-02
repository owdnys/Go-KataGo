@echo off
chcp 65001 >nul
title Go - KataGo
rem 工作目录设到 TEMP + 绝对路径启动，避免锁住工程文件夹（这样文件夹随时可移动）
cd /d "%TEMP%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Please install Node.js from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node "%~dp0server.js"

echo.
echo   Server stopped. Press any key to close this window.
pause >nul
