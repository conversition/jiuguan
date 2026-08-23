# jiuguan · 酒馆剧本引擎

> 下一代 SillyTavern 角色扮演平台 —— **本地优先 + 提示词架构驱动**。
> 用最优提示词架构保障完整剧本记忆、最大化大模型涌现能力、创造最佳沉浸游玩体验。
> **想跑起来看效果？先读 [`启动指南.md`](启动指南.md)**（3 步启动 + 试用路径 + CLI + 常见问题）。

---

## v0.8.0 变更（2026-08）

**世界书整条目语义激活**（`更新计划.md` 二.3：语义匹配 + 上下文相关性排序，补漏触发）

- **整条目语义召回**：`packages/core/src/worldbook/semantic-activator.ts` 新增 `LorebookScanner.scanAsync`，对无关键词/正则命中的条目用**整条目向量**（复用 memory 包 bge 能力 + `vec_memory` 已落库向量，不重复编码）做余弦相似度补充召回——同义词 / 表述差异 / 语义相近而字面不同的输入也能激活,解决"少量 query 头"漏触发。
- **多信号融合分级**：得分 = 加权线性（关键词 .35 / 语义 .4 / 实体 .1 / 概率 .15）+ sigmoid；`thresholdHigh=0.6` 高优先级整条注入、`thresholdMedium=0.5` 中优先级注入标题+摘要（`gatedWorldbookBlock` 可控）。权重/偏置/阈值均可经 `JG_WB_*` env 覆盖。
- **确定性触发保护**：关键词 / 正则 / 常驻命中**保证激活**、不过模糊阈值（防漏），语义仅作未命中条目的补充召回。
- **优雅降级**：无向量 / bge 编码不可用 → 自动回纯关键词/正则（基础功能不中断）。
- **世界书以整条目为单位向量化，绝不切碎**；**预设（Preset）不参与向量化、完整注入 `<预设>` 固定层**——两者明确隔离，避免思维链被打断。
- **测试**：`verify-semantic-activator.ts` 13 项（融合分级 / 语义补充 / 确定性保护 / 降级），`test:core` 全绿。

---

## v0.7.1 变更（2026-08）

**记忆衰减 + 访问计数**（`更新计划.md` 二.1：Ebbinghaus 遗忘曲线 + 被引用次数提升）

- **遗忘曲线衰减**：`packages/memory/retrieval.ts` 新增 `calculateDecay(elapsedMs, λ)`（`exp(-λ·Δt)`，默认 λ=0.1/天，7 天≈半衰），在 RRF 融合归一化得分上叠加时间磨损——久不被引用的旧记忆自然下沉，30 天零访问记忆衰减击穿置信门控后剔除。
- **访问计数提升**：每个命中注入提示词后 `access_count+1` 并刷新 `last_access_ms`（`bumpAccess`，arc↔summary 同 AM 码孪生行同步累计），检索得分加 `log(1+access_count)×boost`——被反复引用的长期伏笔即使久远仍保持高权重。
- **可调可关**：`JG_MEMORY_DECAY`（默认开）/ `JG_MEMORY_DECAY_LAMBDA`（默认 0.1） / `JG_MEMORY_ACCESS_BOOST`（默认 0.5）；`RecallQuery.decay=false` 保守模式不走磨损。
- **schema v4 迁移**（`packages/memory/db.ts`）：`memory_arc/summary/event/state` 四表补齐 `access_count`/`last_access_ms`（旧库幂等补列，存量数据不误伤），写环新记忆落地即打时间戳。
- **测试**：`verify.ts` 新增 8 项衰减/门控/回升/回写断言；`verify-migration` 覆盖 v4 迁移补列。

---

## v0.6.0 变更（2026-08）

**消息锚点 + 右侧楼层刻度表 + 生成后智能定位**（按规划文档 `右侧楼层刻度表 + 生成后自动定位到新回复开头.md`）

- **消息锚点系统**（`apps/web/src/hooks/useMessageRefs.ts`）：给每条消息行登记 DOM 锚点（锚点键 `round-role`，服务端每轮成对唯一），`register`/`getElement` 供刻度跳转与楼层检测统一取 DOM；沿用 `m.id` 作 React key（不动 memo/流式优化），锚点键并存不互扰，流式消息生成结束才挂锚点、时刻精准。
- **右侧楼层刻度表**（`apps/web/src/components/MessageRuler.tsx`）：垂直胶囊条，每刻度一轮，点击平滑跳到该轮 AI 回复开头；当前所在轮高亮放大；轮次多久自身可滚动（max-height + overflow）。
- **当前楼层检测**（`apps/web/src/hooks/useScrollSpy.ts`）：监听视口滚动，按 round+role 结构串监听（流式期内容变化不重建监听）定位当前楼层。
- **手动定位**（`apps/web/src/hooks/useScrollToMessage.ts`）：`scrollTo` 手动计算偏移（不用 scrollIntoView，避免整页滚动）。
- **生成完成智能定位**（`apps/web/src/hooks/useAutoScrollToMessage.ts`）：生成期未上滚 → 跟随流式尾部持续可见；生成结束未上滚 → 平滑滚到**新 AI 回复开头**（非底部）；已上滚在读旧内容 → 不打断、显示「查看新回复」浮窗，点击跳转。
- 替换 v0.4 的固定自动滚动（busy 钉起点 / 空闲到底部），体验更贴阅读诉求。
- **后续**（本期明确不做）：刻度表分组/折叠、楼层书签自定义、生成期悬浮进度条。

---

## v0.5.0 变更（2026-08）

**安全与数据一致性强化 + 工具 DAG 平台化**（按两份规划文档评估，只做前三项 A/B/C）

- **A · 沙箱隔离强化**（`packages/plugin/scan.ts` + `registry.ts` + `runtime.ts`）：插件加载前**静态逃逸扫描**（`child_process` / `process.exit` / `fs` 写 / `eval` 逃逸 / 任意网络 / `require`），命中拒载**不执行不可信代码**；manifest 增加 `permissions` 权限声明（未声明 = 最小权限，超范围源码拒载）；死循环在 vm 同步超时内 kill（不拖垮主进程）。`verify-sandbox-isolation`：5 类逃逸拒载 + 正常插件通过 + 权限归一化 + 超时隔离。
- **B · SQLite 统一事务 + 版本化迁移**（`packages/memory/db.ts` + `writer.ts`）：写环整体落 `BEGIN IMMEDIATE` 事务，中途失败 `ROLLBACK` **无部分写入**（多表强一致）；`PRAGMA user_version` + 最小 migration runner（幂等：已存在的列/表自动跳过），旧库逐级升到当前 schema **数据不丢**。`verify-migration`：建 v1 旧库 → 升级对齐 + 数据保留。
- **C · 工具 DAG 平台化**（`packages/core/tool-dag.ts` + `session.ts`）：把平台预计算组织为声明式工具（`ToolDefinition{name, deps, deterministic, sideEffects, execute}`），Kahn 拓扑分层（无依赖并行 / 有依赖串行），结果统一进 `tool_results` 命名空间；迁移四步骤为工具 `recall_memory` / `worldbook_activate` / `update_variable` / `skill_match`——**执行全在平台，不把工具选择权交给模型（延续每回合 1 次往返铁律）**。`verify-tool-dag`：菱形拓扑 / 无依赖并行 / 依赖读取上游 / 环检测 / 异常隔离。
- **后续**（本期明确不做）：路由 zod 校验收敛、前缀缓存开关、App.tsx 拆分面板。

---

**变量后台自治服务 —— 编译期一次性翻译 + 运行期确定性执行 + 紧凑按需注入**
- **编译调度器**（`packages/variable/compiler.ts`）：卡片加载时检测类型（MVU 引擎直连桥 / 结构化声明直注 / 纯 NL 规则走编译器 / 混合 / 无），编译状态机 `Idle→Compiling→Active|Fallback`，编译器 LLM ≤2 次 + 2000 token 预算 + 产物静态校验，**磁盘缓存**（内容指纹失效，下次加载免 token）。编译产物**绝不进对话 prompt**。
- **确定性规则执行器**（`packages/variable/rules.ts`）：`trigger`（DSL 布尔，含新增 `contains()`）+ `action`（`lhs=rhs` 赋值）；回合末事件驱动执行，**零 token**；返回 old→new 变化集；步数上限防异常。
- **紧凑按需注入**：世界状态块的变量段从「扁平全量」改为「只注入本轮回变化集」——A/B 实测**省约 91% token**（134t → 12t）。
- **降级策略**：编译 Fallback（无 key/失败）→ 变量静止、会话正常；部分规则失败剔除标记 requires_ai；运行异常跳轮 + 日志。
- **会话接线**：init 编译注册变量 + 回合末 `executeRules`；A/B 评测器增「维度3：变化集 vs 全量」。
- **后续**（不进本期）：requires_ai 模糊变量批量小模型、监管面板、变量作为 Cordis effect/coeffect 完整集成。

---

## v0.3.0 变更（2026-08）

**上下文依赖调度 —— 让 AI 回复更聪明、更沉浸、省 token（Cordis 思想引入）**
- **L1 上下文提供者生命周期**（`packages/prompt/context-provider-runtime.ts`）：把 Cordis 的 coeffect 依赖满足 + revertible effects 迁移到上下文装配层。每个上下文来源（记忆/世界书/长期摘要/世界状态）声明为 provider fiber（inject 依赖 + provide 服务 + build 片段 + teardown 逆操作）；每回合依焦点做依赖求值、激活/撤销，**consumer 先退、provider 后撤，LIFO 逆操作**——旧场景上下文干净撤销、不残留、不串线。
- **L2 调度层**（`packages/prompt/context-scheduler.ts`）：只对符合条件的块按 cost/priority 排序 → 全局 `CONTEXT_BUDGET_TOKENS` 总闸裁剪（宁丢勿裁）——**省 token 主杠杆**。
- **内容改进**：检索 query 由 24 字截断 → 完整输入 + 在场实体裸词 + 推进槽（召回命中更准）；世界书按在场实体/场景条件化门控（只注入相关条目）；动态状态结构化为 `<世界状态>` 块（模型可直接遵循）。
- **评测**：`tools/evaluator/ab.ts` A/B（mock 零 API）——召回基线 1/3 → 增强 3/3；注入 token 门控后不高于基线；全局预算裁剪低优先级块。
- **分层责任**：Cordis 底座只解决「哪些进、哪些出、怎么干净出」；成本/优先级/预算为自研调度层；变量问题按规划于二期处理（本期仅以世界状态块参与装配）。

---

## v0.2.0 变更（2026-08）

**多轮流式体验修复**
- 流式期纯文本预览（`StreamText` + rAF 批合并），不再逐字全量 re-parse markdown/HTML，长对话不再卡死
- 消息行 `React.memo` + 稳定 key（round+role 匹配保留前端 id），流式只重渲最后一条、回合结束不重挂 DOM
- `fetchHistory` 统一抽取，send/regenerate/delete/resume 复用，减少前后端状态漂移

**生成中止（自己选择终止）**
- 发送按钮在生成中变为红色「停止」，Esc 亦可触发
- 贯通：前端 `AbortController` → `/api/turn` req close → 上游 `client.stream` 外部 signal（`AbortSignal.any` 合并超时）
- 中止保留已生成部分正文落库该轮，**不写记忆**（07 铁律 1：不完整 turn 的 memory_delta 属涌现内容，禁止写环）；回合账本记空 created，可重新生成

**失败兜底 + 孤儿修复**
- 模型异常（非中止）不再残留「有 user 无 assistant」孤儿轮：删孤儿 user 行 + 轮次回退 + 清空账本，前端清乐观气泡可重发
- `buildChatWindow` 双保险跳过历史遗留孤儿轮，旧库续聊不记忆断裂
- regenerate 失败写占位 assistant 成对，无孤儿

---

## 1. 定位

| 维度 | 说明 |
|---|---|
| 形态 | 本地运行的桌面式前后端软件（浏览器访问，未来 Tauri 壳化） |
| 核心 | **Headless-first**：CLI 与 Web 共用同一会话核心（`tools/cli/session.ts`） |
| 内容分支 | **NSFW / NSF 双分支**（NSFW 先做，成年向内容用户自担风险，首次年龄确认） |
| 目标 | 完整剧本记忆 · 最大化涌现 · 每回合 1 次模型往返 · 模块全可插拔 |

### 四条铁律（`00-架构计划/07-执行架构方案.md` v2）

1. **平台做确定性的事，模型做涌现的事** —— 检索/写库/校验/AM码分配/世界书激活/变量求值全平台可测；规划/正文/风格归模型
2. **每回合 1 次模型往返** —— `game_turn` 单次结构化输出 `{plan, memory_delta, prose}`
3. **Headless-first** —— 核心逻辑先无头，UI 套同一 core
4. **模块可插拔** —— 插件(git 安装)/预设/世界书/NSFW 分支/MVU 引擎全声明式

---

## 2. 软件框架

```
┌──────────────────────────── 前端 apps/web (React 19 + Vite 6) ─────────────────────────────┐
│  对话(SSE流式/打字机/主题三档) · 建会话前置面板 · 记忆控制台 · 资产面板 · 编辑器 · 插件市场   │
└──────────────────────────────────┬───────────────────────────────────────────────────────┘
                                   │ vite proxy /api → 17800
┌──────────────────────────────────▼────────────────────────────────────────────────────────┐
│  Web API apps/server (node:http, 127.0.0.1:17800)  REST + SSE                              │
│  session/new(SSE阶段进度) · turn(SSE流式) · 记忆/变量/世界书/正则/预设/Provider/插件 端点     │
└──────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┘
       │              │              │              │              │              │
┌──────▼─────┐ ┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼───────┐ ┌─────▼───────┐ ┌───▼──────────┐
│ core       │ │ memory      │ │ prompt     │ │ proxy       │ │ variable    │ │ sandbox/plug │
│ 卡/世界书/ │ │ SQLite      │ │ L0-L6 装配 │ │ OpenAI兼容  │ │ VMS 变量    │ │ MVU沙箱     │
│ 预设/正则  │ │ FTS5 trigram│ │ game_turn  │ │ provider自适应│ │ DSL白名单   │ │ 插件git安装 │
│ 资产解析   │ │ +vec BLOB   │ │ 宏展开     │ │ 缓存/流式   │ │ 依赖图分层  │ │ node:vm钩子 │
└────────────┘ │ RRF融合+写环│ │ 容错/归一化│ └─────────────┘ │ 持久化      │ └─────────────┘
               └─────────────┘              └───────────────┘
┌────────────────────────────────────────── tools/cli ──────────────────────────────────────┐
│  session.ts(会话核心,CLI/Web共用) · turn-runner · turn-loop · evaluator(评测器) · vendor   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 每回合数据流

```
用户输入
 → 平台并行预计算：记忆召回(RRF 融合) ∥ 世界书激活(关键词/正则/概率) ∥ VMS 变量求值
 → 插件 onMessageSend（promptInject 注入）
 → 装配：L0 系统核心 + NSFW 分支 + 静态设定 + 预设块 + 动态状态(推进槽/引擎) + 记忆块 + 输入
 → 模型 game_turn 工具调用（1 次往返）
 → 校验/归一化/错误召回重试(≤2次) → 写环(AM码平台分配+双表一致)
 → 插件 onProsePostProcess（链式改写）→ 对话落库
 → MVU 引擎 tick（状态演化 → VMS + memory_state）→ VMS 快照落库
```

---

## 3. 核心功能清单

### 记忆系统 `packages/memory`
- **SQLite（node:sqlite，零原生依赖）**：WAL + integrity + 热备；7 表 + 4 组 FTS5 external-content（**trigram 中文分词**）+ vec BLOB + 触发器
- **混合检索防幻觉**：通道A FTS5 BM25 + LIKE 兜底 + 实体精确映射 + AM码直查（确定性）∥ 通道B bge 语义向量 ∥ 通道C 时效 → **RRF 融合 + min-max 置信门控**（叠加记忆衰减/访问提升：Ebbinghaus 遗忘曲线 + 被引用次数），注入块标注来源/置信度，低置信标 `[存疑]`
- **写环平台驱动**：AM 码全局唯一（三表 UNION 自增）+ 双表一致性自动回填 + 状态表 diff + 实体索引
- **真实 embedding**：本地 `bge-small-zh-v1.5`（512 维，HF 镜像下载），`hash-ngram` 兜底；批量向量化管线

### 提示词架构 `packages/prompt`
- **L0-L6 七层**（L0 系统核心 / L1 静态设定 / L2 动态状态 / L3 记忆 / L4 编排 / L5 执行 / L6 校验修复）
- **game_turn 单轮契约**（Zod 生成 OpenAI tools 定义 + 校验器同源）—— 每回合 1 往返
- **容错解析 + 归一化**：JSON 截断/尾随/嵌套字符串修复、越界 clamp（countdown>30、bars>100）
- **稳定前缀缓存**：L0/L1/L2 前缀在前、易变尾部在后；`PLATFORM_PADDING_SEGMENTS` 循环填充达 ≥1024 tok 缓存门槛
- **宏展开**：`{{var:key}}` / `{{var:ns:key}}` / `{{getvar::key::default}}` 酒馆宏兼容（含中文/点路径键）

### LLM 代理 `packages/proxy`
- OpenAI 兼容 chat/completions（tools + SSE 流式）+ 模型列表
- **provider 自适应缓存**：openai 走隐式前缀缓存（不发 cache_control）；anthropic 注入 `cache_control: ephemeral`（≤4 断点）
- 密钥：`.env.local`（gitignore）+ UI 写入 `data/provider.json`（不回显，优先于 env）

### 变量管理 VMS `packages/variable`
- 三源命名空间 `scope:source:name`（session>scene>card>book>preset>sys 覆盖优先级）
- **DSL 白名单求值器**（算术/比较/逻辑/`{ref}`/min/max/clamp/roll/len/concat）+ **依赖图拓扑分层**（同层无依赖，Kahn 循环检测）
- 持久化：`memory_state(entity_type='variable')` 快照 + 恢复（仅 literal，derived 重算）

### MVU 引擎沙箱 `packages/sandbox`
- **node:vm 白名单沙箱** + lodash 子集 + Mvu mock —— 魔法少女卡 34.5KB 原引擎 **零转译**运行
- **MvuBridge**：`VARIABLE_UPDATE_ENDED` 驱动真实 tick → 状态叶子进 VMS → 回合后持久化

### 插件系统 `packages/plugin`
- **git URL 安装**（SillyTavern 同款 manifest：name/version/includes/server...）
- node:vm 沙箱运行时 + 钩子映射 ST 扩展 API（onMessageSend / onProsePostProcess / onSessionStart / onSessionEnd）
- Web API + 前端插件市场面板（安装/启停/更新/卸载）

### 世界书扫描器 `packages/core/scanner.ts`
- 复刻酒馆 world-info 激活语义：关键词匹配 / `/regex/` 正则触发 / 常量恒激活 / **概率门** / 预算截断
- 绿灯版（关键词激活）+ 原始版（bge 语义激活）双通道，450×2 条实测
- **整条目语义激活**（`scanAsync`，v0.8.0）：条目以整条目为单位向量化（不切碎），多信号融合补漏触发；确定性触发保证激活、语义作补充召回；无向量自动降级
- **预设边界**：预设（Preset）不向量化、不切碎，完整注入 L3 `<预设>` 固定层，与语义增强隔离，保思维链连贯

### 资产系统 `packages/core`
- chara_card v1/v2/v3 + PNG 提取 + 内嵌 worldbook/regex_scripts/tavern_helper
- 世界书双层格式合并去重；预设块解析 + 按 enabled ∧ override 过滤注入
- **源资产只读 + 用户层可编辑**：编辑器保存写 `data/`，新会话生效

### 正则管道
- 内置默认库 12 条 + 卡片 regex_scripts 自动导入；前端渲染时屏蔽 `<think>/<UpdateVariable>/<era_data>` 等标记（「显示原文」开关可看原始）

### 消息操作（重新生成 / 删除历史）
- **重新生成任意轮 AI 回复**：回合账本 `round_ledger` 记录每轮写环前状态快照 + 本轮新写行（AM 码/事件/引擎/变量），重新生成=回滚该轮（保留用户行）→ 用存储的用户输入重放，状态精确还原、无双表孤儿
- **删除历史**：单轮删除（用户+AI+状态回滚）/ 从该轮删到结尾；middle 轮删除为尽力回滚（与酒馆删中间消息一致容忍轻微不一致）
- 前端消息悬浮操作：`↻ 重新生成`（最后一条 AI）/ `✕ 删除本轮` / `⧗ 从本轮删到结尾`

### 资产导入导出（前端可视化）
- 角色卡 **PNG 兼容酒馆**：导入认 `.json` / 真 `.png`（自动解包 chara tEXt），导出生成酒馆可直接拖入的 PNG（`buildCharaPng`）
- 世界书 / 预设 JSON 导入导出；PNG 卡 / 世界书 / 预设均落**用户层** `data/`，不碰源目录；`/api/cards` 现支持源+用户双源、json+png 双格式

### 长对话滑动窗口 + 滚动摘要
- **近期原文窗口**：最近 N 条消息（默认 12 / 1500 token，env `JG_WINDOW_N`/`JG_WINDOW_TOKENS`）原文进 prompt（补上 `assembleTurn` 长期空置的 `chatHistory` 槽位），prompt 层正则清洗内部标记
- **滚动摘要兜底**：滑出窗口的旧文在 `SUMMARY_ROUNDS` 轮后压缩成 ≤500 字长期摘要（`memory_meta.longterm`，env `JG_LONGTERM_TOKENS`/`JG_SUMMARY_ROUNDS`），随轮注入；上下文各块独立封顶，长对话不爆 token

### 剧情分支索引（AI 生成）
- 每轮对话后自动生成"当前局势 + 未解决伏笔 + 建议分支（2-4 个）"，帮助玩家决定下一步、减轻思考负担
- 后端 `generateStoryIndex` 用当前记忆（大纲/事件/长期摘要/上轮规划/推进槽）喂给模型，结果按轮缓存 `story_index` 表（同轮重复请求零成本）；模型不可用时降级纯 DB 脉络
- 前端侧栏"剧情分支索引"卡片随推进槽刷新自动拉取 + `↻` 手动重生成

### 会话清理
- 侧栏"会话"列表每项带 🗑 删除按钮（关 DB + 删 `data/session-*.db` + 移出内存）；消息级删除用 ✕（本轮）/ ⧗（从此删到结尾），操作按钮半透明常显、悬停加深

### 导演分镜编排器 `tools/cli/storyboard*.ts`（Commit B）
- 平行于 prose 主循环的批量工作流引擎：**工作流 yaml 注册表**（`data/storyboard-workflows/`，新增工作流=丢一个 yaml 零代码改动）+ 批量召回（剧情 RAG ∥ 世界书 ∥ 分镜 Skill）+ 四阶段模型编排（导演读本→逐镜 Shot Contract→串联六段式→人类化改写，≤5 镜/调用超限并行）+ **五级校验内联**（VP0 读本/VP1 反陈词·设备词/VP2 SFX 禁 BGM）+ `memory_state(storyboard)` 落库
- 用法：`pnpm storyboard --scene "深夜铁桥相拥" --shots 3 --voice 亲密极简`；`pnpm test:storyboard`（mock 端到端 22/22，绕 API 限流）
- 提交：`2064e38`（数据资产 data/skills、data/storyboard-workflows 按约定不入库，落盘验证）

---

## 4. 前端现状 `apps/web`（React 19 + Vite 6）

| 区域 | 组件 | 功能 |
|---|---|---|
| 对话主区 | `App.tsx` | **SSE 流式打字机**（`▋` 光标）、assistant 用 **Markdown 阅读卡片**（720px 居中/字号行高可调/代码高亮）、user 紧凑气泡、消息淡入、**消息悬浮操作**（↻ 重新生成 / ✕ 删除本轮 / ⧗ 从此删到结尾） |
| 主题/字号 | `App.tsx` | 深色/米黄/纸白三档（`data-theme` + CSS 变量）、A-/A+ 字号（`--read-fs`） |
| 侧栏常驻 | `App.tsx` | **推进槽 4 条进度条** + 轮次/事件类型/NSFW 锁定（每轮后刷新）、**剧情分支索引卡片**（AI 生成，按轮缓存 + ↻ 重生成）、角色卡/会话列表（**会话可 🗑 删除**） |
| 建会话 | `SessionSetup.tsx` | 选角色卡 + 世界书多选 + 预设块勾选 + content_mode → SSE 阶段进度（卡→世界书→向量化→引擎→就绪）；**卡片（PNG/JSON）/ 世界书 / 预设可视化导入导出** |
| 记忆控制台 | `MemoryConsole.tsx` | 双通道检索测试（BM25/vec/RRF 分层得分）、状态表(表0-5)/大纲表(AM码)、世界书激活调试、VMS 变量分层 |
| Provider | `ProviderPanel.tsx` | 显示 base/model/kind/key 状态 + **密码输入框写 key** + 测试连接 |
| 资产 | `AssetsPanel.tsx` | 预设浏览器(块查看/勾选)、正则调试器、世界书条目浏览 |
| 编辑 | `EditorPanel.tsx` + `RegexLibraryPanel.tsx` | 预设/世界书编辑保存(用户层)、正则库维护(增删/启停/从卡导入) |
| 插件 | `PluginsPanel.tsx` | 插件市场：git URL 安装/列表/启停/更新/卸载 |

**7 个 tab**：新建·对话·记忆·Provider·资产·编辑·插件（侧栏切换）。

---

## 5. 后端现状 `apps/server`（node:http，127.0.0.1:17800）

| 分组 | 端点 |
|---|---|
| 会话 | `GET /api/cards` `GET /api/sessions` `POST /api/session/new`(SSE) `POST /api/session/resume` `GET /api/session/:id/history` `GET /api/session/:id/config` |
| 回合 | `POST /api/turn`（**SSE**：thinking→streaming→delta→done） |
| 消息操作 | `POST /api/session/:id/regenerate {round}`（SSE） `POST /api/session/:id/message/delete {round,mode:round\|fromHere}` |
| 剧情/会话 | `GET /api/session/:id/story-index?round=N`（AI 剧情分支索引，按轮缓存） `POST /api/session/:id/delete`（删会话 db） |
| 记忆 | `POST /api/session/:id/memory-search` `GET /api/session/:id/memory-state` `-memory-arc` `-memory-meta` |
| 调试 | `POST /api/session/:id/lorebook-scan` `GET /api/session/:id/variables` `-turn-state` `-lorebook-entries` |
| 资产 | `GET /api/cards`（源+用户，json+png） `GET /api/card/:file/raw` `GET /api/card/:file/png` `POST /api/card/import` `GET /api/presets` `GET /api/preset/:file` `GET /api/preset/:file/raw` `POST /api/preset/import` `GET /api/worldbooks` `GET /api/worldbook/:file` `GET /api/worldbook/:file/raw` `POST /api/worldbook/import` `POST /api/preset|worldbook/save|delete` |
| 正则 | `GET /api/regex-rules` `POST /api/regex-rules/save|delete|import-card` `POST /api/regex/test` |
| Provider | `GET /api/provider` `POST /api/provider/test` `POST /api/provider/key` |
| 插件 | `GET /api/plugins` `POST /api/plugins/install` `POST /api/plugins/:id/enable|disable|uninstall|update` |
| 健康 | `GET /api/health` |

**独立记忆服务**（可选）：`packages/memory/src/api.ts` 127.0.0.1:17600（/health /recall /search /update /state /init /openapi.json）。

---

## 6. 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 6 · CSS 变量三主题 · react-markdown + remark-gfm + rehype-highlight |
| 后端 | node:http（零框架）· SSE · node:sqlite（零原生依赖） |
| 核心 | zod（契约共享前后端）· FTS5 trigram · bge-small-zh-v1.5 · node:vm 沙箱 |
| 运行 | Node ≥ 22.5 · pnpm 10 · git（插件安装）· Windows（可跨平台） |

---

## 7. 快速开始

> 详细：见 [`启动指南.md`](启动指南.md)。最快路径：双击 **`一键启动.bat`**。

```bash
# 0. 依赖
pnpm install
# 1. API key（二选一）
#    A. 启动后 UI Provider 面板粘贴保存（写 data/provider.json）
#    B. 编辑 .env.local（JG_API_BASE / JG_API_KEY / JG_MODEL）
# 2. 后端
pnpm web:server          # 127.0.0.1:17800
# 3. 前端（另开终端）
pnpm web:dev             # 浏览器 http://localhost:5173
```

### CLI（Headless 核心）

```bash
pnpm session --card <卡路径> --db data/play.db                     # 交互对话
pnpm session --card <卡> --db data/play.db --once "第一句话"       # 单轮
pnpm session --card <卡> --db data/play.db --once "继续"           # 恢复续聊
pnpm turn-loop / turn-runner                                       # 闭环 / 真实模型回合
pnpm evaluate                                                      # Golden-session 评测
```

---

## 8. 测试与质量基线

```bash
pnpm test          # 全量回归 195 项（memory 14 + core 30+11+11+14 + proxy 9 + prompt 7 + variable 22+7+14 + sandbox 7+16 + plugin 15+8+5）
pnpm evaluate      # Golden-session mock 评测（召回率/契约成功率/双表一致率 100% 基线）
```

设计文档在 `酒馆提示词Agent/00-架构计划/`（v2 执行架构方案）与 `剧本方案/`（审查/排查/美化建议）。

---

## 9. Git 工作流（本地回退）

项目已纳入 git 管理（本地仓库）：

```bash
git status          # 查看改动
git add -A          # 暂存所有改动
git commit -m "描述改动"   # 提交快照
git log --oneline   # 查看历史提交
git reset --hard <commit>   # 回退到某次提交（⚠ 会丢弃该提交后的改动）
git revert <commit>         # 安全回退（保留历史，产生新提交）
```

> 常规开发流程：**每完成一个可运行改动就 `commit` 一次** → 后续任何代码更新出错都能 `git reset --hard` 回到上一个稳定快照。

---

## 10. 已知约束与下一步

| 状态 | 项 |
|---|---|
| ⚠️ | 前缀缓存命中率待 API 侧实测（稳定前缀 ~1662 tok 已过 1024 门槛） |
| ⏳ | 世界书绿/蓝灯 + 层级防递归（selectiveLogic 6 档/keysecondary/递归控制）——字段漏斗待补，见 `剧本方案/世界书与渲染排查_jiuguan.md` |
| ⏳ | 前端立绘 + 角色名 + 思考折叠块 + 章节小标（需 chat_log 加列 + SSE 推元数据） |
| ⏳ | 右滑抽屉（记忆命中/世界书激活读时可见，免切 tab） |
| ⏳ | 50/100 轮 live 评测、RRF 权重/drop 阈值调优 |
| ⏳ | Tauri 2 UI 壳（Phase 4） |

*配套：`00-架构计划/07-执行架构方案.md`（v2 四铁律 + ADR）、`剧本方案/启动流程审查_jiuguan.md`（启动闭环）、`剧本方案/前端美化建议_jiuguan.md`（沉浸阅读）、`剧本方案/世界书与渲染排查_jiuguan.md`（绿蓝灯/渲染根因）。*
