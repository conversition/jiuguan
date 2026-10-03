# CommandCode 独立 3050 回退适配器

`apps/commandcode-proxy` 是酒馆仓库内的**电脑端、仅回环地址** CommandCode
兼容入口。它把 `commandcode-core` 的协议转换和 `commandcode-runtime` 的上游访问组合成
一个显式启动、显式关闭的 HTTP 服务，供本机调试与紧急回退使用。

它不是 APK 内置反代，不是手机入口，也不是 DSH Provider。手机端不能、也不应直接连接
这个服务；未来手机访问仍须经过酒馆电脑端的配对鉴权、任务管理与受控远程入口。

## 已提供的接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/`、`/health` | 就绪检查；接收请求时为 `200 OK`，drain 后为 `503 NOT READY` |
| `GET` | `/v1/models` | 无 Key 时返回内置回退表；带 Key 时按运行时策略查询上游模型 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 兼容入口，支持流式与非流式 |
| `POST` | `/v1/messages` | Anthropic Messages 兼容入口，支持流式与非流式 |
| `POST` | `/v1/responses` | OpenAI Responses 兼容入口，支持流式与非流式 |

生成接口只接受以下任一请求头中的 CommandCode Key：

```http
Authorization: Bearer user_REPLACE_ME
```

```http
x-api-key: user_REPLACE_ME
```

如果两个请求头同时出现，它们必须完全相同。API Key 不得写入 `config.json`、环境配置、
URL、日志或 APK；适配器只从当前请求头读取并将其显式传给电脑端 runtime。

## 快速启动

要求使用仓库 `.node-version` 固定的 Node.js `22.22.2` 和仓库锁定的 pnpm 版本；
源码入口依赖该版本支持的 TypeScript strip/transform 参数。首次启动先复制示例：

```powershell
Copy-Item apps\commandcode-proxy\config.example.json apps\commandcode-proxy\config.json
```

按本机情况修改 `deviceProjectDir` 和 `upstreamProxy`，然后从仓库根目录运行：

```powershell
pnpm commandcode:serve
```

如果主仓库快捷脚本尚未注册，也可直接运行源码入口：

```powershell
node --experimental-strip-types --experimental-transform-types apps\commandcode-proxy\src\main.ts
```

默认配置文件是 `apps/commandcode-proxy/config.json`，缺失时使用安全默认值。也可以显式指定
另一个文件；显式路径不存在或 JSON 非法时启动会失败，而不会静默回退：

```powershell
$env:CC_CONFIG_PATH = 'C:\secure\jiuguan\commandcode.json'
pnpm commandcode:serve
```

根脚本运行源码入口，因此能从任意工作目录按模块位置找到上述默认文件。当前没有发布
`dist-runtime` 启动脚本；若手工执行编译后的
`dist-runtime/apps/commandcode-proxy/src/main.js`，必须设置绝对 `CC_CONFIG_PATH`，
因为 TypeScript 构建不会复制被 Git 忽略的本机 `config.json`。

服务成功后只监听 `http://127.0.0.1:3050`。可先做不携带凭据的本机检查：

```powershell
Invoke-WebRequest http://127.0.0.1:3050/health
Invoke-RestMethod http://127.0.0.1:3050/v1/models
```

生成请求示例：

```powershell
$headers = @{ Authorization = 'Bearer user_REPLACE_ME' }
$body = @{
  model = 'claude-sonnet-4-6'
  messages = @(@{ role = 'user'; content = '你好' })
  stream = $false
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri http://127.0.0.1:3050/v1/chat/completions `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body
```

## 配置与容量边界

独立入口配置和 runtime 配置在进程启动时解析为不可变快照。常用字段见
`config.example.json`；对应环境变量优先于文件值。

- `host` 只能是 `127.0.0.1`，配置成 `0.0.0.0`、局域网地址或 IPv6 公网地址会拒绝启动。
- 默认请求体上限为 `8 MiB`，默认并发上限为 `8`，即默认最坏请求体预算为 `64 MiB`。
- 可配置的 `maxBodyMiB × maxInflight` 不得超过 `128 MiB`；超过即拒绝启动。
- 单请求体硬上限为 `32 MiB`，并发硬上限为 `128`，但仍受 `128 MiB` 聚合预算约束。
- `upstreamProxy` 只允许本机 `http://127.0.0.1`、`localhost` 或 `[::1]` CONNECT 代理。
- 上游 origin 固定为 `https://api.commandcode.ai`，客户端不能通过请求体或 header 改写。
- API Key 没有配置字段，也没有 Key 环境变量；必须逐请求放入鉴权 header。

## CORS 与手机边界

本服务故意不返回 `Access-Control-Allow-Origin: *`，也没有跨域凭据白名单。`OPTIONS` 仅返回
允许的方法，不授予浏览器跨域访问权限。因此：

- 本机命令行、桌面宿主和受控服务端代码可以调用；
- 不同 origin 的浏览器页面不能把它当成开放代理；
- 手机、PWA、APK 不应通过局域网端口转发绕过酒馆服务端鉴权；
- 不要用额外代理把 `3050` 暴露到 LAN、Tailscale、互联网或反向代理公网入口。

## 生命周期与退出

HTTP adapter 使用 `active → draining → disposed`，监听服务使用
`idle → starting → running → draining → disposed`。模块导入不会读配置、监听端口、启动定时器
或访问网络；只有显式调用 `start()` 或执行 CLI 主入口才会启动。

第一次 `Ctrl+C`/`SIGTERM` 会停止接收新请求并等待正在处理的请求完成，然后关闭 runtime；
15 秒仍未结束会强制 dispose。第二次终止信号会立即进入强制清理。`drain()` 和 `dispose()`
均设计为幂等调用。

## 验证

```powershell
pnpm test:commandcode-adapter
pnpm test:commandcode-core
pnpm test:commandcode-runtime
pnpm test:commandcode-vendor
pnpm typecheck
pnpm build
```

测试只使用 fake runtime 与 `127.0.0.1` 临时端口，不需要真实 API Key，也不会执行公网 smoke。

## 当前未包含

- 酒馆 DSH Provider 注册与 ProviderRegistry 接入；
- 手机配对、设备令牌、远程鉴权和 HTTPS 网关；
- 服务端持久化生成任务、断线重连和双端同步；
- Android/Capacitor 工程与 APK 打包；
- 真实用户 Key 的公网冒烟验证；
- 面向 nginx/LAN/DSH 长链路的严格 SSE keepalive 运营一致性。

最后一项必须在任何 nginx、LAN 或 DSH 流转启用前完成；当前 loopback 回退入口不宣称具备该
生产长链路能力。当前 `3050` 入口的职责仅是电脑端回退、协议回归和故障隔离。
