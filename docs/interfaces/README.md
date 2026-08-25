# 酒馆接口文档（interfaces）

规范化 jiuguan 的对外交互契约。当前覆盖 **ST 生态兼容层**（外部卡前端 ⇄ 宿主），是"中转器"的规范源。

## 文档索引

| 文档 | 覆盖 |
|------|------|
| [st-ecosystem.md](st-ecosystem.md) | ST 生态兼容层：`__jgfh` 桥协议、ST 兼容 shim 映射表、宿主 rpc 路由、`/quiet` 静默生成端点、能力/缺口矩阵、Roadmap |

## 分层总览

```text
外部卡前端（iframe）──ST 习惯调用──▶ ST_COMPAT shim ──__jgfh postMessage──▶ 宿主分发
                                                                              │
                                                            /quiet 后端端点 ──┴── 宿主输入框
```

- **协议层**：`apps/web/src/gal/bridge.ts`（`__jgfh` 消息类型 / 校验 / 注册表）
- **转译层**：`apps/web/src/htmlCore.ts` `ST_COMPAT_SNIPPET`（toastr / #send_textarea / getContext / generateQuietPrompt）
- **宿主层**：`apps/web/src/App.tsx` `handleRpcMessage`（ai.generate / asset.resolve / session.getContext / message.send / theme / viewport）
- **后端**：`apps/server/server.ts` `POST /api/session/:id/quiet`（静默生成）

## 关键不变量

- 沙箱 srcdoc **不得出现 `window.parent` 字面**（`apps/web/tests/verify-html-core.ts` 断言）；父窗口引用一律走 `__jgSafeParent.__jgRealParent` / `__jgPost` / 方括号形式。
- 宿主只接收**已注册帧**（`registerFrame`）的消息；消息须过 `isJgFrameMessage` 严格校验。

## 测试

```bash
node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-html-core.ts
node --experimental-strip-types --experimental-transform-types apps/web/tests/verify-gal-bridge.ts
```

## 状态与 Roadmap

- 本期完成：`ai.generate`（/quiet 静默生成）、`asset.resolve`、`session.getContext` 会话数据回填、`isGenerating`、rpc 往返消费。
- 见 [st-ecosystem.md §6 Roadmap](st-ecosystem.md) —— toastr→UI toast、getContext 推送语义、scale 同步、全量上下文。

*更新：2026-08-25 ｜ 分支 `feat/gal-interactive-frontend` ｜ 范围：ST 生态兼容层（不含后端 HTTP 网关层重构）。*