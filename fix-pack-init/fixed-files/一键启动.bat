@echo off
chcp 65001 >nul
title jiuguan 一键启动
cd /d "%~dp0"

echo ============================================================
echo   jiuguan 一键启动（后端 API + Web 前端 + 浏览器）
echo   项目: 酒馆提示词Agent/jiuguan
echo ============================================================
echo.

rem ---- 环境检查 ----
where node >nul 2>&1
if errorlevel 1 ( echo [错误] 未找到 node，请先安装 Node.js 22 以上版本 & pause & exit /b 1 )
where pnpm >nul 2>&1
if errorlevel 1 ( echo [错误] 未找到 pnpm，请先执行: npm i -g pnpm & pause & exit /b 1 )
if not exist "node_modules" (
  echo [安装] 首次运行，安装依赖（约 1-2 分钟，请稍候）...
  call pnpm install
  if errorlevel 1 ( echo [错误] 依赖安装失败，请检查网络 & pause & exit /b 1 )
)
if exist ".env.local" (
  echo [配置] .env.local 已找到（API key 就绪）
) else (
  echo [提示] 未找到 .env.local —— 可稍后在页面 "Provider" 面板填写 key
)
echo.

rem ---- 1. 后端 API（17800）----
rem 初始化审查修复 #1：只认 LISTENING 状态。原 findstr ":17800 " 会命中浏览器残留的
rem TIME_WAIT 连接 → 误判「已在运行，跳过启动」→ 后端实际没起，页面能开但 /api 全挂
netstat -ano | findstr "LISTENING" | findstr ":17800 " >nul 2>&1
if not errorlevel 1 (
  echo [API] 端口 17800 已在运行，跳过启动
) else (
  echo [API] 启动后端服务...
  start "jiuguan-API(17800)" cmd /k "cd /d ""%~dp0"" && pnpm web:server"
)

rem ---- 2. Web 前端（5173）----
rem 同修复 #1：LISTENING 过滤，避免 TIME_WAIT 误判
netstat -ano | findstr "LISTENING" | findstr ":5173 " >nul 2>&1
if not errorlevel 1 (
  echo [Web] 端口 5173 已在运行，跳过启动
) else (
  echo [Web] 启动前端...
  start "jiuguan-Web(5173)" cmd /k "cd /d ""%~dp0"" && pnpm web:dev"
)

echo.
echo [等待] 前端就绪（首次可能需 10-30 秒，含依赖预构建）...
set /a tries=0
:waitweb
set /a tries+=1
curl -s -o nul -w "%%{http_code}" http://localhost:5173 2>nul | findstr "200" >nul
if not errorlevel 1 goto webup
if %tries% geq 40 goto webtimeout
ping -n 2 127.0.0.1 >nul
goto waitweb

:webup
echo [Web] 前端已就绪，打开浏览器...
goto openweb
:webtimeout
echo [提示] 等待超时（40 秒），仍尝试打开浏览器——若页面未加载，等几秒后刷新
:openweb
start "" "http://localhost:5173"

echo.
echo ============================================================
echo   浏览器已打开 http://localhost:5173
echo   · 后端窗口: jiuguan-API(17800)   （终端可见每轮回合日志）
echo   · 前端窗口: jiuguan-Web(5173)
echo   · 首次使用: 若提示缺 key，在页面 "Provider" 面板粘贴保存
echo   · 关闭: 直接关闭 两个黑窗口（API/Web）即可；关不掉就双击 停止.bat
echo   · 换端口: 设 JG_WEB_PORT 后后端/vite 代理自动跟随
echo ============================================================
pause