# @jiuguan/commandcode-runtime

电脑端专用的 CommandCode 运行时边界。`apps/web` 和未来的 `apps/mobile` 不得导入本包。

当前阶段负责把宿主显式传入的文件配置、环境映射和宿主覆盖解析成请求级不可变快照，
提供四路请求构建器、单快照 upstream client、显式 runtime 实例，以及只在
`execute()` 时访问网络的 `createCommandCodeNodeTransport()`。其中 `hostOverrides`、
`hostZdrOverride` 只能由可信电脑端宿主构造，禁止直接映射浏览器或手机请求体/header。

- CommandCode 生产上游只能是 `https://api.commandcode.ai`；
- generate、初始化和 models 只能使用代码内定义的四条路径；
- 协议版本固定为当前已经审计的 `1.53.1`，不能随 npm 版本自动漂移；
- 上游 HTTP 代理首期只允许电脑 loopback 地址，公开诊断永不包含代理凭据；
- API Key 由每次 generate/listModels 调用显式注入，不进入配置快照、公开状态或明文 Map key；
- 模块导入不读取 `process.env`、配置文件，不访问网络，不监听端口，也不创建定时器。
- generate、fingerprint、lifecycle、models 只能构造固定 method/URL/header，全部要求
  transport 拒绝重定向；调用者不能注入 URL、Host 或任意 header；
- 请求体由带深度、节点和字符预算的严格 serializer 生成，不调用 getter/`toJSON`，
  并拒绝 Proxy、循环、BigInt、非有限数和未知顶层信封字段；
- 每次 client 调用只读取一次配置源；已经构建的请求不会受来源或 body 后续突变影响；
- runtime 的一次 generate/listModels 只解析一个配置快照；同一次生成中的初始化与主请求
  不会观察到两份配置；
- 预先取消会在读取配置、trace factory 和 body 之前停止，并用固定 `AbortError` 隔离
  任意 `signal.reason`；
- 如果配置了 loopback HTTP proxy，而注入 transport 未声明 CONNECT 能力，请求会
  fail closed，不能静默直连。
- Node transport 只接受本进程构建器签发的请求；直连禁用 global Agent，代理模式固定为
  loopback HTTP CONNECT，再以固定 SNI、证书校验和 HTTP/1.1 建立 TLS；代理认证不会
  穿透至 CommandCode origin。
- redirect、连接绝对截止时间、初始化/models 总请求超时、TLS/CONNECT/upgrade/early-close、
  AbortSignal 和 Response body cancel 均由 transport 显式处理；底层错误、API Key、
  代理密码和 `signal.reason` 不进入公开错误。
- session、traceparent、设备指纹和 lifecycle ID 由 runtime 在电脑端生成；设备指纹与
  已审计 vendor 算法保持一致，运行时 Map 仅使用实例级随机 pepper 派生的凭据摘要，
  不以明文 API Key 为键。
- fingerprint/lifecycle 初始化按“凭据 + 身份/网络配置”singleflight；只有两路均为 2xx
  才写入长期 TTL，失败只做短退避且不阻塞 generate。初始化响应体始终 cancel，避免遗留
  socket、timer 或 AbortSignal listener。
- models 缓存按凭据及网络配置隔离，过期刷新 singleflight；结果限制为 1 MiB、最多
  1000 个合法 ID，去重并冻结。刷新失败优先返回该凭据的 stale 值，无历史值才回退内置表。
- session、初始化和 models 三类状态表均有 256 项硬上限并只淘汰非 busy 项，避免随机
  credential 把机会式清理放大成无界内存或扫描成本。
- runtime 生命周期为 `active → draining → disposed`。drain 拒绝新调用并等待现有
  shared flight/响应体；dispose 幂等广播取消、清空状态。generate 在响应体 EOF/cancel
  之前仍占用活跃租约，不能只在收到 headers 时提前卸载。
- 对外 runtime API 仅为 `generate/listModels/drain/dispose/snapshot`；初始化与缓存刷新
  是内部流程，浏览器和手机不能直接驱动。

独立 `3050` HTTP 回退入口已经在 `apps/commandcode-proxy` 中通过组合本包与
`commandcode-core` 实现：它只监听电脑 loopback，具有显式生命周期、请求体/并发预算和
三协议 HTTP 边界，不把 HTTP 细节反向塞进 runtime 或协议 core。当前仍未接入生产 server
或 DSH Provider，也未使用真实用户 Key 执行公网 smoke；在 Provider 接入、远程鉴权和
设备配对完成前，不得开放手机入口。
