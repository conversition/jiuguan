@echo off
chcp 65001 >nul
title jiuguan 停止（17800 后端 + 5173 前端）
echo ============================================================
echo   jiuguan 一键停止：结束占用 17800 / 5173 的进程树
echo   （关闭黑窗口无效时的兜底，也用于一键清残留）
echo ============================================================
echo.
if exist "%~dp0.workbuddy\runtime\private-host.json" (
  echo [私有入口] 撤销 Serve、断开 Tailnet并停止 Tailscale 服务...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows\jiuguan-private.ps1" -Action stop
)
for %%P in (17800 5173) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo   [%%P] 结束进程树 PID %%a ...
    taskkill /F /T /PID %%a >nul 2>&1
  )
)
echo.
echo 完成。若仍有 node 残留，可再执行: taskkill /F /IM node.exe
echo.
pause
