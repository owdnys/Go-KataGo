@echo off
chcp 65001 >nul
title Deploy - Go KataGo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

echo.
echo   Deploying public/ to Cloudflare Pages (project: go-katago) ...
echo.

call npx --yes --registry=https://registry.npmmirror.com wrangler@4.144.0 pages deploy public --project-name go-katago --branch main --commit-dirty=true

echo.
echo   Online site: https://go-katago-4ac.pages.dev/
echo.
pause
