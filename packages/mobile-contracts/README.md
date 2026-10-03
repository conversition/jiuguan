# @jiuguan/mobile-contracts

PC Web、手机 PWA、Android 壳与电脑服务端共用的线协议契约。

## 边界

- 只包含类型、常量和无副作用 type guard。
- src/ 禁止导入 node:*、Capacitor、数据库或服务端内部类。
- 不包含业务状态容器、网络请求实现、密钥或 endpoint。
- 当前 API 协议版本为 1；Provider SPI 版本独立演进。

## 设备认证契约

- `same-origin-cookie` 面向电脑 Web 与 PWA。配对成功后由服务端写入
  `HttpOnly + Secure + SameSite=Strict` Cookie，JSON 响应不得返回 `accessToken`。
- `bearer` 只面向后续原生壳的系统安全存储。只有 `BearerPairResult` 可以包含
  `accessToken`；共享 Web UI 不得把它写入 localStorage、sessionStorage、IndexedDB、URL
  或日志。
- 每台设备拥有独立 `DeviceScope[]` 与可撤销会话。`admin`、`settings.write` 等权限必须由
  服务端逐路由检查，客户端隐藏按钮不能代替授权。`admin` **不隐式蕴含**其它四个 scope。
- 配对码只允许放在 `PairRequest` 的 POST JSON body。`PublicPairingCodeDescriptor` 只公开
  状态、期限和剩余尝试次数，不公开配对码本身；只有 `IssuedPairingCode` 携带 code 明文，
  且仅限本机可信界面展示一次。
- `ServerMeta.auth.scheme` 是 P1 的兼容字段，等价于 `bearer`；新客户端读取
  `transports`。认证为必需时，服务端必须至少声明一种有效传输方式。

### 传输与秘密格式（契约固定，服务端实现必须遵守）

| 种类 | 格式 | 说明 |
|---|---|---|
| 设备凭据 | `jg1_<selector>_<secret>` | selector 公开可查，secret 高熵；DB 只存 selector 与 HMAC 摘要 |
| 配对码 | `jgp1_<selector>_<secret>` | 严格解析后只查一条记录；不存在/过期/耗尽统一公开响应 |
| CSRF token | canonical base64url 无填充，固定 43 字符 | 由 session selector + csrf_epoch 派生；仅 Cookie 传输存在 |
| 资产 capability | base64url 无填充，32–1024 字符 | 结构由 P5.2-A7 固定；短期 bearer，可在子资源 query |

- `PairRequest.transport` 必须显式声明，**不得**根据可伪造的 `platform=android` 推断 Bearer；
  `platform` 只作展示与审计元数据。请求的 transport 与 scopes 必须是服务端配对记录允许集合的子集，
  越权整次配对失败，不静默提升也不静默裁剪。
- `AuthSessionState.csrfToken` 只在 `transport === 'same-origin-cookie'` 时存在；Bearer 会话夹带
  CSRF 视为非法。刷新页面后重新调用 `GET /api/auth/session` 取得，不进入浏览器持久存储。
- `AssetCapabilityRequest` 只接受 `assetId + purpose`，不接受任意 URL；capability 不能由客户端
  提交 URL 换取。

### 公开 DTO 的守卫强度

所有认证公开 DTO 守卫都是 **exact own-key allowlist**：

1. 必须是普通对象（拒绝类实例与自定义原型）；无原型对象允许。
2. own enumerable 键必须全部落在白名单内，存在 symbol 键即拒绝。
3. 任意深度递归扫描秘密键名（大小写不敏感、忽略 `-`/`_`），覆盖
   `apiKey`/`password`/`refreshToken`/`token`/`cookie`/`code`/`capability` 等；只有
   `BearerPairResult.accessToken`、`IssuedPairingCode.code`、`AssetCapability.capability`、
   `AuthSessionState.csrfToken` 四个精确位置可放行。
4. 深度超过 24 层按违规处理，避免恶意深层对象造成无限递归。

因此新增字段必须先扩白名单，不会因为“多带一个字段”而被静默接受。第 3 条是纵深防御：
当前所有嵌套值都有各自的守卫，但未来若有 DTO 放宽嵌套值类型，秘密扫描仍会兜住。

## 标识语义

- serverId：电脑安装/用户数据目录的稳定公开标识，跨服务进程重启保持不变；换电脑或重装后变化。
- serverInstanceId：单次服务进程 epoch；变化表示事件游标失效并需要重新同步，不得用作持久身份。
- requestId：一次 HTTP/SSE 传输尝试，用于追踪，不是幂等键。
- runId：一次逻辑生成的稳定标识，跨断线和重连保持不变。
- Idempotency-Key：可重试写操作的业务幂等键，不能复用 requestId。
- revision / ETag：服务端实体版本；写入时通过 If-Match 检测冲突。

## 生成任务契约

- `PublicTurnJob` 只公开任务身份、状态、时间、版本和最终结果引用；不公开 prompt、设备身份、
  Idempotency-Key、Provider 参数或内部 lease。
- 合法状态迁移由 [`ADR-0003`](../../docs/adr/0003-server-owned-turn-jobs.md) 固定；终态不可改写。
- `requestId` 是第一次成功创建 job 的传输身份。幂等重试可以使用新的 requestId，但必须得到同一 runId。
- 客户端只能把 job DTO 当作 REST 真值；事件和旧 SSE 流都不能单独决定任务是否完成。

## 事件语义

EventEnvelope 只用于失效通知。收到事件后客户端必须重新读取 REST 真值；事件不得承载 Provider 凭据或作为唯一持久状态。游标缺口或 serverInstanceId 变化时，服务端应发送 sync.required。
