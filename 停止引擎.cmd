@echo off
chcp 65001 >nul
title Stop - Go KataGo
echo.
echo   Stopping Go KataGo engine ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$found=$false; foreach($port in 3210..3213){ $p=(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] bridge stopped (port ' + $port + ')'); $found=$true } }; if(-not $found){ Write-Host '  bridge is not running' }; Get-Process katago -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host '  [OK] KataGo engine stopped.'"
echo.
echo   You can now move / rename this folder freely.
echo.
pause
