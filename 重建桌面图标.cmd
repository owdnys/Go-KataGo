@echo off
chcp 65001 >nul
title Fix desktop shortcut - Go KataGo
echo.
echo   Rebuilding the desktop shortcut for THIS folder ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = Split-Path -Parent '%~f0'; $name = [string]([char]0x56F4) + [char]0x68CB + [char]0xFF08 + 'KataGo' + [char]0xFF09 + '.lnk'; $path = Join-Path ([Environment]::GetFolderPath('Desktop')) $name; $ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut($path); $lnk.TargetPath = \"$env:SystemRoot\System32\wscript.exe\"; $lnk.Arguments = '\"' + (Join-Path $dir 'start.vbs') + '\"'; $lnk.WorkingDirectory = $dir; $lnk.IconLocation = (Join-Path $dir 'go.ico'); $lnk.Description = 'Play Go vs KataGo in browser'; $lnk.Save(); Write-Host ('  [OK] shortcut -> ' + $path); Write-Host ('  [OK] target   -> ' + (Join-Path $dir 'start.vbs'))"
echo.
pause
