# ST 生态兼容层 · 接口文档

> 本文档规范化「外部卡前端 ⇄ 宿主」的交互通道，覆盖三层：
> **① 后端端点**（`/api/session/:id/quiet` 静默生成）、**② `__jgfh` 前端桥协议**（postMessage）、**③ SillyTavern 生态兼容 shim**（`ST_COMPAT`）。
> 目标：把既有的"无接口/占位/死口"统一成文档化、可扩展、可验收的契约。
> 最后更新：2026-08-25 ｜ 分支：`feat/gal-interactive-frontend`

---

## 1. 范围与分层

外部卡前端（**WuWa Solaris-3 MVU Edition**、**魔法少女侵蚀实验记录** 等）是 SillyTavern 生态脚本，
习惯调用 `window.parent`/`ST_WIN` 下的 `toastr`、`#send_textarea`、`SillyTavern.getContext()`、
`generateQuietPrompt()`、`name1/name2`、`getSTFn('getVariables')`。沙箱 iframe（opaque origin）无法直接访问宿主 DOM/状态，
唯一通道是 postMessage。本层负责把 ST 习惯调用**转译**为宿主能力，并把宿主真实数据（静态生成 / 会话上下文 / 资源解析）**回填**给前端。

```text
       外部卡前端（沙箱 iframe，opaque origin）
                  │  ST 习惯调用（toastr / #send_textarea / getContext / generateQuietPrompt）
                  ▼
      ┌────────────────────────────────────────────┐
      │  ST_COMPAT shim（htmlCore.ts）              │
      │  翻译 ST 调用 → __jgfh 消息                  │
      └──────────────────┬─────────────────────────┘
                         │  postMessage（__jgfh 协议，经 __jgPost / realParent）
                         ▼
      ┌────────────────────────────────────────────┐
      │  宿主分发（App.tsx onMsg + handleRpcMessage）│
      │  message.send / ai.generate / asset.resolve │
      │  session.getContext / theme / viewport      │
      └──────┬──────────────────────────┬───────────┘
             ▼                          ▼
   后端 REST/SSE（server.ts）    宿主 React 状态/输入框
   /api/session/:id/quiet       applyBranch / sendText
```

分层职责：

| 层 | 文件（锚点） | 职责 |
|----|-------------|------|
| 后端端点 | `apps/server/server.ts` `POST /api/session/:id/quiet` | 静默生成（一次性补全，不落 chat_log） |
| `__jgfh` 桥 | `apps/web/src/gal/bridge.ts` | 消息类型 / 校验 / 注册表 / 定向 postMessage |
| ST 兼容 shim | `apps/web/src/htmlCore.ts` `ST_COMPAT_SNIPPET`(268) | ST 调用词法转译 + rpc 往返消费 |
| 宿主分发 | `apps/web/src/App.tsx` `handleRpcMessage`(678) | 按 `ns.op` 路由到宿主能力 / 后端 |
| 宿主输入框 | `apps/web/src/App.tsx` `applyBranch`(401) / `sendText`(515) | 回传输入框（draft）/ 直接发送（choice） |

---

## 2. 后端端点清单（本层涉及的）

### `POST /api/session/:id/quiet` — 静默生成

ST 前端 `generateQuietPrompt(prompt)` 的宿主侧真实端点（`ai.generate` rpc 的后端实现）。

| 项 | 值 |
|----|----|
| Method / Path | `POST /api/session/:id/quiet` |
| 请求体 | `{ "prompt": string, "round"?: number, "content_mode"?: "nsfw"\|"nsf" }` |
| 响应 | `{ "text": string }` |
| 错误 | `{ "error": string }` + HTTP 400/404 |
| 流式 | 否（JSON 一次性；`client.complete()` 非流式） |

行为语义（与 `/api/turn` 对比）：

- **读**：`buildChatWindow(round-1)` 近期窗口转写 + `getLongTermBlock()` + `getCardName()/cardDesc` 装配 system/user 提示；
- **不写**：不落 `chat_log`、不跑工具 DAG、不改记忆 —— 与 `/api/session/:id/story-index` 同级但更轻；
- **回合不推进**：不改变 `round`/推进槽，可随时静默调用。

后端实现：`session.quietGenerate(prompt, {round, mode})`（`tools/cli/session.ts`，`generateStoryIndex` 之后）。
复用 `this.client.complete()`（`packages/proxy/src/client.ts:136`），`temperature:0.7, max_tokens:1200`。

### 关联端点（文档化现状，未改动）

| 端点 | 用途 | 备注 |
|------|------|------|
| `GET /api/assets/status` | 资产索引（`entries`、`overrides`） | `asset.resolve` rpc 的数据源 |
| `GET /api/assets/img?url=` | 资源本地代理（惰性下载+同源出图） | `asset.resolve` 返回的 URL 指向这里 |
| `GET /api/session/:id/config` | 会话启动配置（含 card 名） | `session.getContext` rpc 取角色名的数据源 |
| `GET /api/session/:id/history` | 会话历史 | getContext chat 快照的持久源 |

> 全量 ~60 端点的 REST/SSE 清单（server.ts 内联分发器）不在本文展开，属后续「后端 HTTP 网关层」文档化范围。

---

## 3. `__jgfh` 前端桥协议

定义于 `apps/web/src/gal/bridge.ts`。iframe（不透明源）无法直接访问宿主 DOM/状态，唯一通道是 postMessage。
消息格式为带 `__jgfh`/`__jgfh_h` 标记的普通对象，经 `window.postMessage(msg, '*')`（目标源统用 `*`，
安全靠 `e.source` 身份校验）。

### 3.1 iframe → 宿主（`JgFrameMessage`）

| 类型标签 | 载荷 | 含义 |
|---------|------|------|
| `{ __jgfh_h:'height', h }` | `h:number` | 仅高度测高（旧） |
| `{ __jgfh_h:'size', w, h }` | `w,h:number` | 宽+高测高（当前主力；80ms 防抖） |
| `{ __jgfh:'choice', text, mode? }` | `text:string`，`mode:'send'\|'draft'` | 点选项 → 直接发消息 / 填输入框 |
| `{ __jgfh:'draft', text }` | `text:string` | 填宿主输入框（`applyBranch`），不发 |
| `{ __jgfh:'rpc', id, ns, op, payload? }` | `id:number`, `ns:string`, `op:string` | 通用远程调用，`id` 关联回复 |

### 3.2 宿主 → iframe（`JgHostMessage`）

| 类型标签 | 载荷 | 含义 |
|---------|------|------|
| `{ __jgfh:'host', op:'theme'\|'scale', value }` | 广播 | 主题/缩放同步（当前仅主题广播） |
| `{ __jgfh:'rpc', id, ok, result?, error? }` | `id:number`, `ok:boolean` | rpc 回复，定向发往来源帧 |

### 3.3 注册表与校验语义

- `registerFrame(source, post)` → 返回注销函数；宿主**只**接收已注册帧的消息；
- `findFrame(e.source)` 按 `e.source` 身份查帧；`broadcastToFrames` 向全部已注册帧广播；
- `buildFramePost(win)` 构造向该帧定向发消息的函数（targetOrigin 用 `'*'`）；
- `isJgFrameMessage(data)` 严格校验字段类型 + 有限值，拒绝伪造/格式错误消息。

### 3.4 iframe 内 rpc 往返（`ST_COMPAT` 新增）

iframe 侧 `rpcCall(ns, op, payload, timeoutMs?)`：发 `{__jgfh:'rpc',id,ns,op,payload}` 并把 `{resolve,reject,timer}`
登记进 `pendingRpc`；`window` `message` 监听匹配 `d.__jgfh==='rpc'` 且 `d.id` → 兑现/拒绝（超时默认 15s reject）。

---

## 4. ST 生态兼容层映射表（中转器核心）

`ST_COMPAT_SNIPPET`（`htmlCore.ts:268`）在 iframe 内模拟 ST 环境，源符号 → 宿主姿态：

| ST 符号 | 宿主行为 | 状态 |
|---------|---------|------|
| `toastr.info/success/warning/error` | console 占位（宿主暂无 UI toast） | 占位 |
| `$('#send_textarea').val(x)` / `input` 事件 | `__jgfh:'draft'` → 宿主真实输入框（`applyBranch`） | **已接** |
| `SillyTavern.getContext().generateQuietPrompt(prompt)` | `rpcCall('ai','generate',{prompt})` → 宿主 `/quiet` 静默生成 → 回 `{text}` | **已接（真实）** |
| `SillyTavern.getContext().isGenerating` | 静默生成往返期 `truthy`（WuWa 类卡轮询等待） | **已接** |
| `SillyTavern.getContext().name1/name2` | 读缓存（首次 `rpc session.getContext` 回填） | **已接（真实数据）** |
| `SillyTavern.getContext().character` | 读缓存（卡名 → `{name}`） | **已接（真实数据）** |
| `SillyTavern.getContext().chat` | 读缓存（宿主消息快照 `{id,round,role,content}`） | **已接（真实数据）** |
| `SillyTavern.getContext().getMessageById(id)` | 从缓存 chat 查 | **已接（真实数据）** |
| `getCharacters()` | 缓存 character（若有）→ `{name:char}` | **已接（真实数据）** |
| `extensionSettings` / `eventSource` / `addOneMessage` 等 | 安全空实现，保证探测/初始化不崩 | 空实现 |
| `getSTFn` / `getVariables` / `replaceVariables` | 已知助手符号给无副作用安全默认（可 await 不抛，流程走到底）；未知符号 `undefined`（保留探测降级） | **已接** |
| `SillyTavern.getContext().getCharacters` | 同 `getCharacters` | 已接 |

### 宿主分发路由（`App.tsx handleRpcMessage`）

| `ns.op` | 请求 payload | 回复 result |
|---------|-------------|-------------|
| `message.send` | `{ text, draft? }` | `{ ok:true }`（draft→填输入框，否则发送） |
| `theme.get` | — | `{ theme }` |
| `viewport.get` | — | `{ w, h }` |
| `ai.generate` | `{ prompt }` | `{ text }`（调 `/quiet`）；无会话/失败 → error reply |
| `session.getContext` | — | `{ name1, name2, character, chat }` |
| `asset.resolve` | `{ kind, name }` | `{ status:'ok', url, constructed, cached }` 或 `{ status:'miss' }`；url 指向 `/api/assets/img?url=` 本地代理 |
| 其它 | — | error reply `未知 rpc ${ns}.${op}` |

---

## 5. 能力 / 缺口矩阵

| 能力 | 本期前 | 本期后 | 说明 |
|------|--------|--------|------|
| `ai.generate` / 静默生成 | 死口：rpc 回 error，shim 回 `''` 不消费 | **真实**：`/quiet` + 消费 reply | 已实测 DeepSeek 出中文正文 |
| `asset.resolve` | 占位：恒回 `{status:'miss'}` | **真实**：status 索引 + `resolveGalUrl` | hit/craft/miss；回本地代理 URL |
| getContext 会话数据 | 空 stub（name1/name2/chat 全空） | **真实**：session.getContext rpc 回填 | 按需拉取，非推送 |
| `isGenerating` | 无 | **真实**：往返期 truthy | 支撑 WuWa 轮询 |
| `#send_textarea` 回传输入框 | 已接 | 已接（不变） | 验证过 |
| `toastr` | console 占位 | console 占位（不变） | 宿主无 UI toast 端点 → Roadmap |
| `scale` 前端同步 | 声明未发 | 未改（不变） | → Roadmap |
| `SillyTavern.getContext()` 全量上下文（extensions/preset/API） | 空实现 | 空实现（范围外） | 保初始化不崩；真实扩展走插件系统 |

---

## 6. Roadmap（本期不做）

1. **toastr → 宿主 UI toast**：新增宿主 toast 通道（前端轻量组件）或 `isHost` rpc，shim 的 `toast()` 改投递而非 console。
2. **getContext 推送语义**：会话变化时宿主 `broadcastToFrames` 主动推 `session context` 增量，减少按需 rpc 的往返。
3. **`scale` 前端同步**：宿主缩放变化广播到 iframe（`__jgfh:'host' op:'scale'`）已有通道未接线。
4. **`ST_COMPAT` 全量上下文**：按需回填 `getContext().extensionSettings` / `getApiUrl` 等更完整字段。
5. **`asset.resolve` 卡内嵌覆盖**：`/api/assets/status` 加 `?card=` 过滤 + 序列化 `manifest.overrides`，支持脚本写覆盖。

---

## 附：验收路径

- **自动化**：`node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-html-core.ts`（srcdoc `/window\.parent/` 不变量 + shim rpc/isGenerating/getContext 断言）；`apps/web/tests/verify-gal-bridge.ts`（协议/注册表）。
- **端到端**：配 key → 导入 `WuWa_Solaris-3_MVU_Edition_14` → 建会话 →
  ① 外部前端 `generateQuietPrompt` 出真实文本（无 `[Request Failed`）；
  ② `getContext()` 的 `name1/name2/character/chat` 可见；
  ③ `__jgfhRpc('asset','resolve',{kind:'bg',name:'...'})` 出图/占位；
  ④ `/api/assets/scan`+`preload` 后 `resolve` 反映 `cached`。