# 酒馆 Agent v0.1：自主安装 Agent 交接协议

本文供 Codex、Claude Code 或其他自动化开发 Agent 使用。目标是在不读取、不复制、不泄露
用户私人数据的前提下，安装并验证 Jiuguan v0.1。

## 1. 完成定义

只有同时满足以下条件，才能报告“安装完成”：

- Node.js `22.22.2`、pnpm `10.33.0` 和 Git 可用；
- `pnpm install --frozen-lockfile` 成功；
- `pnpm public:verify` 成功；
- `pnpm typecheck` 成功；
- `pnpm build` 成功；
- 本机 `/health` 返回成功且浏览器入口可访问；
- smoke test 使用独立空白数据目录；
- 未读取、写入或提交 API Key；
- 未导入角色卡、世界书、预设、Skill、学习数据或插件存储；
- 未发起真实 Provider 请求；
- 未擅自启动 Tailscale；
- Agent Lane 和 Maintenance apply 保持 public-safe 默认值；
- Git 中没有运行时数据、生成物或凭据。

## 2. 不可违反的边界

安装 Agent 必须遵守：

1. 不读取既有 `.env`、`.env.local`、`provider.json` 的内容。
2. 不读取其他安装的 `data/` 或 `%LOCALAPPDATA%\Jiuguan\...` 内容。
3. 不复制旧会话、数据库、学习库、卡片、世界书、预设、Skill、插件、缓存或日志。
4. 不把 Key 放入命令参数、终端回显、日志或回复。
5. 不发起真实模型调用来证明“安装成功”。
6. 不 enable、reopen 或扩大 Interactive、Learning、Maintenance Lane。
7. 不开启 Maintenance 正式业务写入。
8. 不执行 `tailscale up`、Serve、配对或服务启停，除非用户明确要求手机远程访问。
9. 不构建 release APK，除非用户提供自己的 endpoint、签名方案和明确授权。
10. 不覆盖已经存在的目标目录。
11. 不修改来源仓库中的未提交文件。
12. 不自动创建远端仓库、push 或发布 Release。

需要账号登录、管理员权限、真实 Provider 调用、Tailscale 控制、写入现有用户目录或覆盖文件
时，暂停并向用户说明所需授权。

## 3. 公开副本真实性检查

安装前检查：

```powershell
git status --short
git log -1 --oneline
pnpm public:verify
```

合格公开版不得含有：

- 原开发仓库历史；
- `.env`、`.env.local`、Key、cookie 或配对码；
- `data/`、`.workbuddy/`、SQLite/WAL、日志或缓存；
- 角色卡、世界书、预设、Skill 或学习正文；
- 真实 tailnet 主机名和时间戳式真实 session id；
- 个人绝对路径、实机截图、APK、keystore；
- 安装后的第三方插件、插件配置或插件 storage。

允许保留的相关代码是通用插件框架与第一方 CommandCode Provider 源码；其生成 bundle、Key、
配置和安装态不得存在。第三方 LICENSE/NOTICE 必须保留。

若 `public:verify` 失败，不得跳过后宣称安装完成。先报告精确命中，并只在公开副本内修复。

## 4. 工具链与依赖

```powershell
node --version
pnpm --version
git --version
```

版本不符时先报告。pnpm 缺失可在用户允许后安装锁定版本：

```powershell
npm install --global pnpm@10.33.0
```

从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm public:verify
pnpm typecheck
pnpm build
```

这份清洁版主动移除了依赖私人 fixture 的旧测试。不要声称“全量测试通过”；只能如实报告
上述静态门禁、类型检查和构建结果。后续公开测试必须使用仓库内合成匿名 fixture。

## 5. 隔离数据目录

标准用户数据目录是：

```powershell
$jgDataDir = Join-Path $env:LOCALAPPDATA 'Jiuguan\a9-private-data'
```

安装 Agent 只能确认路径，不得枚举或读取既有内容。若该目录已存在，smoke test 必须使用
本轮新建的隔离目录，例如：

```powershell
$jgSmokeData = Join-Path $env:TEMP ('jiuguan-v0.1-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $jgSmokeData | Out-Null
$env:JG_USER_DATA_DIR = $jgSmokeData
```

只有 Agent 本轮创建、已验证绝对路径位于临时目录且不含用户数据的目录，才可在验收后删除。

## 6. Provider 与用户素材

默认不创建真实 `.env.local`。让用户本人在浏览器 Provider 面板输入 Key，不要求用户把 Key
发到聊天中。

如需准备模板，只能：

```powershell
Copy-Item .env.example .env.local
```

并保留空值或显式占位符。允许报告 Provider id、模型名、Key 是否已配置和脱敏指纹；禁止
输出完整 Key。

安装过程中不导入用户素材。安装完成后由用户自己导入有权使用的卡片、世界书、预设与 Skill。

## 7. 本机启动与只读验收

推荐由用户双击 `一键启动.bat`。自动化 smoke test 可在隔离数据目录中启动后端和前端，但
不得读取默认用户目录，也不得调用 Provider。

完成 `pnpm build` 后，可直接复制执行以下 PowerShell。它加载公开安全 profile、使用本轮
新建的隔离数据目录，并通过生产同源页面完成 smoke；不会启动 Vite、Tailscale 或真实
Provider 请求：

```powershell
$repoRoot = (Resolve-Path '.').Path
$jgSmokeData = Join-Path $env:TEMP ('jiuguan-v0.1-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $jgSmokeData | Out-Null

$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$smokePort = ([Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$smokeBase = "http://127.0.0.1:$smokePort"

$env:JG_USER_DATA_DIR = $jgSmokeData
$env:JG_WEB_PORT = [string]$smokePort
$env:JG_DEV_WEB_PORT = '5173'
$env:JG_AGENT_PROFILE = (Resolve-Path 'tools/windows/public-safe-v0.1.env').Path
Get-Content -LiteralPath $env:JG_AGENT_PROFILE |
  Where-Object { $_ -and -not $_.StartsWith('#') } |
  ForEach-Object {
    $name, $value = $_ -split '=', 2
    Set-Item -LiteralPath ("Env:" + $name) -Value $value
  }

$serverOut = Join-Path $jgSmokeData 'server.stdout.log'
$serverErr = Join-Path $jgSmokeData 'server.stderr.log'
$server = Start-Process -FilePath (Get-Command pnpm.cmd).Source `
  -ArgumentList @('web:server') `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $serverOut `
  -RedirectStandardError $serverErr `
  -PassThru

try {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $health = Invoke-RestMethod "$smokeBase/health"
      break
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Milliseconds 500
    }
  } while ($true)

  $health
  Invoke-RestMethod "$smokeBase/api/capabilities"
  Invoke-WebRequest "$smokeBase/" -UseBasicParsing |
    Select-Object StatusCode, ContentType
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
```

如需额外验证开发页，再在同一环境中运行 `pnpm web:dev` 并访问
`http://localhost:5173`。上面的 `JG_DEV_WEB_PORT=5173` 是后端允许该 Vite Origin 的必要
条件。保留 `$jgSmokeData` 路径供交接审计；只有确认它由本轮创建且位于临时目录后才可清理。

公开端点：

```text
API：http://127.0.0.1:17800
Web：http://localhost:5173
```

只读检查：

```powershell
Invoke-RestMethod http://127.0.0.1:17800/health
Invoke-RestMethod http://127.0.0.1:17800/api/capabilities
```

验收记录只能包含 HTTP 状态、应用名、公开版本、协议版本、认证模式和 Lane 公开状态。不得
记录 cookie、设备凭据、完整数据库内容或用户输入。

停止使用 `停止.bat`。不要留下后台进程。

## 8. Public-safe Agent 状态

未经用户逐项授权，新安装必须保持：

```text
Interactive: off
Learning: off
Maintenance: off
Context Compiler live execution: off
Maintenance apply: off
正式业务写入: 不可达
```

主对话在用户配置 Provider 后仍可使用。

用户若要求开放 Agent，必须另外确认：

- 精确 session id；
- 开放哪条 Lane；
- 最大物理 Provider 请求数；
- 总费用上限；
- 成功、失败和零 Token 请求如何计数；
- 是否仅限 test-session；
- Maintenance 是 shadow 还是允许提案；
- 是否允许任何正式业务写入及其回滚路径。

缺少关键授权时继续保持关闭。历史授权、其他设备的授权窗口和旧控制库不能迁入。

## 9. 手机私有访问

只有用户明确要求时执行本节。先确认两端同一 tailnet，用户理解 UAC 与服务启停，且 MagicDNS
和 HTTPS Certificates 已开启。

启动：

```powershell
pnpm private:start
```

状态：

```powershell
pnpm private:status
```

安全边界：只接受私有 HTTPS；不启用 Funnel；不监听 `0.0.0.0`；不做公网端口映射；不把
端口 `3050` 暴露给手机；不把配对码复制进 Agent 回复、日志或文件。

首次配对码由用户现场查看并输入。已有管理员设备后，新码应从“设备与安全”页面生成，重复
bootstrap 被拒绝是预期行为。

停止：

```powershell
pnpm private:stop
```

## 10. APK 构建

APK 不是安装完成的必需条件。只有用户明确授权并提供自己的精确 Tailscale endpoint 后才执行：

```powershell
$env:JG_PINNED_ENDPOINT = 'https://your-host.your-tailnet.ts.net'
pnpm mobile:doctor
pnpm mobile:apk:debug
```

Release 签名还要求用户自己的 JDK 17、Android SDK 34 和仓库外 keystore。Agent 不生成、猜测、
输出或提交签名密码。

## 11. 安装验收表

交接时逐项填写：

| 项目 | 结果 | 可公开证据 |
|---|---|---|
| 源码版本 | PASS/FAIL | commit/tag |
| Node 22.22.2 | PASS/FAIL | 版本号 |
| pnpm 10.33.0 | PASS/FAIL | 版本号 |
| frozen install | PASS/FAIL | exit code |
| public clean gate | PASS/FAIL | 扫描计数 |
| typecheck | PASS/FAIL | exit code |
| build | PASS/FAIL | exit code |
| `/health` | PASS/FAIL/未执行 | 状态与公开字段 |
| 数据目录隔离 | PASS/FAIL | 路径，不列内容 |
| Provider | 未配置/用户配置 | 不记录 Key |
| Agent Lane | OFF/用户授权 | 只报公开状态 |
| 手机远程 | 未执行/通过/失败 | 不记录配对码 |
| APK | 未执行/通过/失败 | 文件名与 SHA-256 |
| Git 污染检查 | PASS/FAIL | 无敏感文件 |

## 12. 标准交接回复

```text
酒馆 v0.1 已安装到：<绝对路径>
源码版本：<tag/commit>
数据目录：<隔离或标准路径>
本机入口：http://localhost:5173
健康检查：通过/失败/未执行
Provider：未配置；请由你本人在 Provider 面板填写
Agent Lane：public-safe 默认关闭
手机私有入口：未启动
APK：未构建

已通过：
- pnpm install --frozen-lockfile
- pnpm public:verify
- pnpm typecheck
- pnpm build

未执行：
- 真实 Provider 请求
- Tailscale 登录或远程入口
- Agent Lane 放行
- 正式业务写入
- GitHub push

需要用户继续操作：
1. 在 Provider 面板配置自己的模型与 Key；
2. 导入自己有权使用的角色卡、世界书和预设；
3. 如需手机访问，再明确授权启动 Tailscale 私有入口。
```
