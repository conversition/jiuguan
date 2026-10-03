@echo off
chcp 65001 >nul
title 酒馆手机配对码
cd /d "%~dp0"

echo ============================================================
echo   酒馆手机配对码（仅首次或更换手机时使用）
echo   请先启动“私有远程启动.bat”；配对码 15 分钟内有效
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows\jiuguan-private.ps1" -Action pair -Pause
exit /b %errorlevel%
