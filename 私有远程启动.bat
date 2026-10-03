@echo off
chcp 65001 >nul
title 酒馆私有远程启动
cd /d "%~dp0"

echo ============================================================
echo   酒馆私有远程启动
echo   启动 Tailscale 服务 + secured 酒馆 + Tailnet Serve
echo   不启用 Funnel，不监听 0.0.0.0
echo ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows\jiuguan-private.ps1" -Action start -Pause
exit /b %errorlevel%
