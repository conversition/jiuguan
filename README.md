# jiuguan · 酒馆剧本引擎

> 下一代 SillyTavern 角色扮演平台 —— **本地优先 + 提示词架构驱动**。
> 用最优提示词架构保障完整剧本记忆、最大化大模型涌现能力、创造最佳沉浸游玩体验。
> **想跑起来看效果？先读 [`启动指南.md`](启动指南.md)**（3 步启动 + 试用路径 + CLI + 常见问题）。

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
- **混合检索防幻觉**：通道A FTS5 BM25 + LIKE 兜底 + 实体精确映射 + AM码直查（确定性）∥ 通道B bge 语义向量 ∥ 通道C 时效 → **RRF 融合 + min-max 置信门控**，注入块标注来源/置信度，低置信标 `[存疑]`
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

### 资产系统 `packages/core`
- chara_card v1/v2/v3 + PNG 提取 + 内嵌 worldbook/regex_scripts/tavern_helper
- 世界书双层格式合并去重；预设块解析 + 按 enabled ∧ override 过滤注入
- **源资产只读 + 用户层可编辑**：编辑器保存写 `data/`，新会话生效

### 正则管道
- 内置默认库 12 条 + 卡片 regex_scripts 自动导入；前端渲染时屏蔽 `<think>/<UpdateVariable>/<era_data>` 等标记（「显示原文」开关可看原始）

### 导演分镜编排器 `tools/cli/storyboard*.ts`（Commit B）
- 平行于 prose 主循环的批量工作流引擎：**工作流 yaml 注册表**（`data/storyboard-workflows/`，新增工作流=丢一个 yaml 零代码改动）+ 批量召回（剧情 RAG ∥ 世界书 ∥ 分镜 Skill）+ 四阶段模型编排（导演读本→逐镜 Shot Contract→串联六段式→人类化改写，≤5 镜/调用超限并行）+ **五级校验内联**（VP0 读本/VP1 反陈词·设备词/VP2 SFX 禁 BGM）+ `memory_state(storyboard)` 落库
- 用法：`pnpm storyboard --scene "深夜铁桥相拥" --shots 9 --voice 亲密极简`；`pnpm test:storyboard`（mock 端到端 22/22，绕 API 限流）
- 提交：`2064e38`（数据资产 data/skills、data/storyboard-workflows 按约定不入库，落盘验证）

---

## 4. 前端现状 `apps/web`（React 19 + Vite 6）

| 区域 | 组件 | 功能 |
|---|---|---|
| 对话主区 | `App.tsx` | **SSE 流式打字机**（`▋` 光标）、assistant 用 **Markdown 阅读卡片**（720px 居中/字号行高可调/代码高亮）、user 紧凑气泡、消息淡入 |
| 主题/字号 | `App.tsx` | 深色/米黄/纸白三档（`data-theme` + CSS 变量）、A-/A+ 字号（`--read-fs`） |
| 侧栏常驻 | `App.tsx` | **推进槽 4 条进度条** + 轮次/事件类型/NSFW 锁定（每轮后刷新）、角色卡/会话列表 |
| 建会话 | `SessionSetup.tsx` | 选角色卡 + 世界书多选 + 预设块勾选 + content_mode → SSE 阶段进度（卡→世界书→向量化→引擎→就绪） |
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
| 记忆 | `POST /api/session/:id/memory-search` `GET /api/session/:id/memory-state` `-memory-arc` `-memory-meta` |
| 调试 | `POST /api/session/:id/lorebook-scan` `GET /api/session/:id/variables` `-turn-state` `-lorebook-entries` |
| 资产 | `GET /api/presets` `GET /api/preset/:file` `GET /api/worldbooks` `GET /api/worldbook/:file` `POST /api/preset|worldbook/save|delete` |
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
