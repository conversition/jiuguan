@echo off
chcp 65001 >nul
title jiuguan 一键启动
cd /d "%~dp0"

rem ---- 电脑/手机共用唯一数据真值 ----
rem 私有远程启动固定使用此目录；普通本地回退也必须继承同一 JG_USER_DATA_DIR，
rem 否则会分别写入仓库 data/ 与手机私有库，形成看似“不同步”的两条时间线。
set "JG_USER_DATA_DIR=%LOCALAPPDATA%\Jiuguan\a9-private-data"

rem ---- v0.1 公开安全边界：所有自主 Agent 通道默认关闭 ----
rem 本地/私有入口读取同一冻结 profile；用户明确配置前不会产生后台模型调用或业务写入。
set "JG_AGENT_PROFILE=%~dp0tools\windows\public-safe-v0.1.env"
if not exist "%JG_AGENT_PROFILE%" (
  echo [错误] 缺少 Agent runtime profile: %JG_AGENT_PROFILE%
  pause
  exit /b 1
)
for %%K in (
  JG_AGENT_RUNTIME_PROFILE JG_AGENT_LANE_ROLLOUT JG_AGENT_LANE_ROLLOUT_ACK
  JG_AGENT_CONTROL_MUTATION JG_AGENT_CONTROL_MUTATION_ACK
  JG_AGENT_ADMISSION JG_AGENT_ADMISSION_ACK JG_AGENT_ADMISSION_SESSION_ALLOWLIST
  JG_AGENT_LEARNING_TEXT JG_AGENT_LEARNING_TEXT_ACK JG_HARNESS_INTERACTIVE
  JG_HARNESS_INTERACTIVE_ACK
  JG_HARNESS_BACKGROUND JG_HARNESS_INPUT_MICROUSD_PER_MTOK
  JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK
  JG_CONTEXT_COMPILER JG_CONTEXT_COMPILER_ACK JG_CONTEXT_COMPILER_SESSION_IDS JG_CONTEXT_COMPILER_KILL_SWITCH
  JG_MAINTENANCE_ADMISSION
  JG_MAINTENANCE_ADMISSION_ACK JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST
  JG_MAINTENANCE_APPLY JG_MAINTENANCE_APPLY_ACK JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST
) do set "%%K="
set /a JG_AGENT_PROFILE_KEYS=0
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%JG_AGENT_PROFILE%") do (
  set "%%A=%%B"
  set /a JG_AGENT_PROFILE_KEYS+=1 >nul
)
if not "%JG_AGENT_PROFILE_KEYS%"=="25" goto invalid_agent_profile
if not "%JG_AGENT_RUNTIME_PROFILE%"=="public-safe-v0.1" goto invalid_agent_profile
if not "%JG_AGENT_LANE_ROLLOUT%"=="interactive=off,learning=off,maintenance=off" goto invalid_agent_profile
if not "%JG_AGENT_LANE_ROLLOUT_ACK%"=="p14-lane-rollout-v2" goto invalid_agent_profile
if not "%JG_AGENT_CONTROL_MUTATION%"=="off" goto invalid_agent_profile
if not "%JG_AGENT_CONTROL_MUTATION_ACK%"=="p14-agent-control-mutation-v1" goto invalid_agent_profile
if not "%JG_AGENT_ADMISSION%"=="off" goto invalid_agent_profile
if not "%JG_AGENT_ADMISSION_ACK%"=="p14-quality-beta-v1" goto invalid_agent_profile
if not "%JG_AGENT_ADMISSION_SESSION_ALLOWLIST%"=="disabled" goto invalid_agent_profile
if not "%JG_AGENT_LEARNING_TEXT%"=="off" goto invalid_agent_profile
if not "%JG_AGENT_LEARNING_TEXT_ACK%"=="p14-learning-text-provider-v1" goto invalid_agent_profile
if not "%JG_HARNESS_INTERACTIVE%"=="off" goto invalid_agent_profile
if not "%JG_HARNESS_INTERACTIVE_ACK%"=="p13c-v1" goto invalid_agent_profile
if not "%JG_HARNESS_BACKGROUND%"=="off" goto invalid_agent_profile
if not "%JG_HARNESS_INPUT_MICROUSD_PER_MTOK%"=="50000000" goto invalid_agent_profile
if not "%JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK%"=="50000000" goto invalid_agent_profile
if not "%JG_CONTEXT_COMPILER%"=="off" goto invalid_agent_profile
if not "%JG_CONTEXT_COMPILER_ACK%"=="p14-q9r-context-compiler-v1" goto invalid_agent_profile
if not "%JG_CONTEXT_COMPILER_SESSION_IDS%"=="disabled" goto invalid_agent_profile
if not "%JG_CONTEXT_COMPILER_KILL_SWITCH%"=="1" goto invalid_agent_profile
if not "%JG_MAINTENANCE_ADMISSION%"=="off" goto invalid_agent_profile
if not "%JG_MAINTENANCE_ADMISSION_ACK%"=="p14-maintenance-enforce-v2" goto invalid_agent_profile
if not "%JG_MAINTENANCE_ADMISSION_SESSION_ALLOWLIST%"=="disabled" goto invalid_agent_profile
if not "%JG_MAINTENANCE_APPLY%"=="off" goto invalid_agent_profile
if not "%JG_MAINTENANCE_APPLY_ACK%"=="p14-maintenance-apply-v1" goto invalid_agent_profile
if not "%JG_MAINTENANCE_APPLY_SESSION_ALLOWLIST%"=="disabled" goto invalid_agent_profile
goto agent_profile_ready
:invalid_agent_profile
echo [错误] Agent runtime profile 不符合 v0.1 public-safe 边界。
pause
exit /b 1
:agent_profile_ready

echo ============================================================
echo   jiuguan 一键启动（后端 API + Web 前端 + 浏览器）
echo   项目: 酒馆提示词Agent/jiuguan
echo   数据: %JG_USER_DATA_DIR%
echo ============================================================
echo.

rem ---- 入口边界：本脚本永远只启动本机开发入口 ----
rem Tailscale/私有 HTTPS 只能由“私有远程启动.bat”启停。本机入口不得因为检测到
rem 私有宿主而改开远程 URL，也不得因为 Tailscale 未运行而变成不可用。

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

rem ---- CommandCode 首方 Provider（离线安装 / 在线热更新）----
echo [插件] 同步 CommandCode Provider...
call pnpm.cmd commandcode:provider:sync
if errorlevel 1 (
  echo [警告] CommandCode Provider 同步失败；其它 Provider 和酒馆仍会正常启动
) else (
  echo [插件] CommandCode Provider 已同步
)
echo.

rem ---- 1. 后端 API（17800）----
rem 初始化审查修复 #1：只认 LISTENING 状态。原 findstr ":17800 " 会命中浏览器残留的
rem TIME_WAIT 连接 → 误判「已在运行，跳过启动」→ 后端实际没起，页面能开但 /api 全挂
netstat -ano | findstr "LISTENING" | findstr ":17800 " >nul 2>&1
if not errorlevel 1 (
  rem 只复用身份/协议/认证模式正确，且明确允许 localhost:5173 的开发后端。
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\windows\jiuguan-private.ps1" -Action probe-dev >nul 2>&1
  if errorlevel 1 (
    echo [错误] 端口 17800 已被不接受本地开发来源的进程占用。
    echo        若私有远程入口正在占用该端口，请先运行 停止.bat，再重新双击本脚本。
    pause
    exit /b 1
  )
  echo [API] 开发后端已在运行，跳过启动
) else (
  echo [API] 启动后端服务...
  rem 不依赖 start/cmd 的环境继承；在 API 子进程命令中再次显式绑定权威数据目录。
  start "jiuguan-API(17800)" cmd /k "cd /d ""%~dp0"" && set JG_USER_DATA_DIR=%JG_USER_DATA_DIR%&& set JG_DEV_WEB_PORT=5173&& pnpm web:server"
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
