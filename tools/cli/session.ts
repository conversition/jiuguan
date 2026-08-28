/**
 * 完整对话会话（Phase 2/4 核心："正常酒馆对话体验"）
 * 特性：
 *  - 文件 DB 持久化（记忆 + 对话记录，重启不丢）
 *  - 加载角色卡 + 世界书（绿灯版关键词 + 原始版 bge 向量）
 *  - greeting 开场（first_mes）
 *  - 每轮完整链路：检索(recallAsync+bge) ∥ 世界书扫描 ∥ VMS 变量 → 装配 → 模型 game_turn
 *    → 校验(归一化+容错+错误召回重试) → 写环 → 对话落库
 *  - 会话恢复：--resume 继续上次对话
 *
 * 用法：
 *   node session.ts --card <path> --db <path> [--resume] [--once "用户输入"]
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseCharaCard, extractCharaFromPng, pngPayloadToJson } from '../../packages/core/src/chara.ts';
import { cardBookToLorebookRows, parseWorldBook, entryToLorebookRow } from '../../packages/core/src/worldbook.ts';
import { parsePreset } from '../../packages/core/src/preset.ts';
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { applyRegexRules } from '../../packages/core/src/regex.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { parseLoreEntries, buildAliasIndex } from '../../packages/core/src/lore-parse.ts';
import type { AliasEntry } from '../../packages/core/src/lore-parse.ts';
import { matchSkills, renderSkillBlock, type SkillMatch } from '../../packages/core/src/skills.ts';
import { ToolDag, type ToolContext, type ToolDefinition } from '../../packages/core/src/tool-dag.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import type { WriteResult } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine, readableLoreContent, renderRecallBlock } from '../../packages/memory/src/retrieval.ts';
import { TelemetryRecorder } from '../../packages/memory/src/telemetry.ts';
import type { ContextFingerprint } from '../../packages/memory/src/telemetry.ts';
import { shapeTurnOutcome, planStructureScore } from '../../packages/prompt/src/reward.ts';
import {
  adaptiveRetrieval, adaptiveAliasAdditions, adaptiveSummaryDeltas, adaptiveReplanThresholds,
} from '../../packages/prompt/src/adaptive.ts';
import { Vectorizer } from '../../packages/memory/src/vectorize.ts';
import { createEmbeddingProvider, HashEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { persistVariables, restoreVariables } from '../../packages/variable/src/persist.ts';
import { VariableCompiler, detectCardSource } from '../../packages/variable/src/compiler.ts';
import type { CardVariableSpec } from '../../packages/variable/src/compiler.ts';
import { executeRules, formatVarDelta, bareVarName } from '../../packages/variable/src/rules.ts';
import type { RuleEffect } from '../../packages/variable/src/rules.ts';
import type { VariableManifestRule, VariableManifest } from '../../packages/variable/src/manifest.ts';
import { assembleTurn, DEFAULT_SYSTEM_CORE, estimateTokens } from '../../packages/prompt/src/assembly.ts';
import { KeyAnchorDetector, type KeyAnchor } from '../../packages/prompt/src/key-anchor-detector.ts';
import { validateGameTurn, safeParseTurn, normalizeTurn, createProseStreamExtractor, diagIssueDetail } from '../../packages/prompt/src/turn.ts';
import type { GameTurn } from '../../packages/prompt/src/turn.ts';
import { OpenAICompatibleClient, toolLoopMessages, AbortTurnError } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { MvuBridge } from '../../packages/sandbox/src/mvu-bridge.ts';
import { PluginRegistry, PluginHost } from '../../packages/plugin/src/index.ts';
import type { RecallResult } from '../../packages/memory/src/retrieval.ts';
import type { ScanResult } from '../../packages/core/src/scanner.ts';
import { ContextProviderRuntime } from '../../packages/prompt/src/context-provider-runtime.ts';
import type { TurnFocus, ContextProviderFiber } from '../../packages/prompt/src/context-provider-runtime.ts';
import { scheduleContext, shrinkToBudget } from '../../packages/prompt/src/context-scheduler.ts';
import type { ContextBlock } from '../../packages/prompt/src/context-scheduler.ts';
import { resolveAsset, listAssets } from '../../packages/core/src/asset-paths.ts';
import type { AssetKind } from '../../packages/core/src/asset-paths.ts';
import { StoryboardOrchestrator } from './storyboard-orchestrator.ts';
import type { StoryboardResult } from './storyboard-orchestrator.ts';
import { indexSessionLore } from './lore-index-task.ts';

/** 资产解析（用户层 data/{presets,worldbooks} 优先于 剧本方案 源目录，编辑器 P2） */
function resolveAssetFile(kind: AssetKind, file: string): string | null {
  return resolveAsset(kind, file)?.path ?? null;
}

/** content-modes.json 世界书"标签"→ 实际文件名（默认分支映射；显式入参直接用文件名） */
const WORLD_BOOK_LABELS: Record<string, string> = {
  'XP大全绿灯版': 'XP大全绿灯世界书-v1.4.json',
  '__XP大全': '__XP大全 v1.4.json',
  'XP情境大全': 'XP情境大全（需搭配全绿灯世界书-v1.4）.json',
  '文风库': 'Yukino的文风库（世界书合集）(2026-01-31).json',
};

export interface SessionArgs {
  card?: string;
  db?: string;
  resume: boolean;
  once?: string;
  useBge: boolean;
  contentMode?: 'nsfw' | 'nsf';
  /** 显式选定的世界书文件（相对 剧本方案/世界书/）；缺省 = 按 content_mode 默认（nsfw→XP大全） */
  worldbooks?: string[];
  /** 选定的预设文件（相对 剧本方案/预设/）；缺省 = 不加载预设 */
  preset?: string;
  /** 预设块勾选覆盖 {块索引: 启用?}（启动流程审查 P0：UI 勾选 → 会话入参） */
  presetOverrides?: Record<string, boolean>;
}

/** 导演模式入参（POST /api/session/:id/director 请求体对齐：选区定位 + 分镜偏好） */
export interface DirectorParams {
  /** 用户选中的台词/剧本片段（必填） */
  selectedText: string;
  /** 选中文本所在消息的轮次（用于上下文定位，≥0） */
  round?: number;
  /** 消息角色（assistant/user，信息性） */
  role?: string;
  /** 前端消息 id（信息性，备用定位） */
  messageId?: number;
  /** 生成镜数（1-30，缺省 9） */
  shots?: number;
  /** 导演之声（6 选一，缺省由 Stage0 自选） */
  voice?: string;
  /** 分镜工作流（cinematic-default 等，缺省默认） */
  workflow?: string;
}

function parseArgs(argv: string[]): SessionArgs {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const overridesRaw = get('--preset-overrides');
  let presetOverrides: Record<string, boolean> | undefined;
  if (overridesRaw) {
    try { presetOverrides = JSON.parse(overridesRaw) as Record<string, boolean>; } catch { presetOverrides = undefined; }
  }
  return {
    card: get('--card'),
    db: get('--db'),
    resume: argv.includes('--resume'),
    once: get('--once'),
    useBge: !argv.includes('--no-bge'),
    worldbooks: get('--worldbook')?.split(',').map((s) => s.trim()).filter(Boolean),
    preset: get('--preset'),
    presetOverrides,
  };
}

/** 从 AI 剧情索引输出解析：content（局势/伏笔）+ branches（建议分支按钮，最多 4 个）
 * 容错：段标记兼容【建议分支】/建议分支/建议分支：；无标记时兜底取文本末尾的连续 bullet 行 */
function parseStoryIndex(text: string): { content: string; branches: string[] } {
  const raw = text.split('\n');
  const lines = raw.map((l) => l.trim());
  const brkIdx = lines.findIndex((l) => /建议分支/.test(l));
  const isBranchLine = (l: string) => /^[-•·*＊]/.test(l) || /^\d{1,2}[.、]/.test(l);
  const clean = (l: string) => l
    .replace(/^[-•·*＊\s]+/, '')
    .replace(/^\d{1,2}[.、]\s*/, '')
    .replace(/^分支\d+[：:、]\s*/, '')
    .replace(/^行动\d+[：:、]\s*/, '')
    .replace(/[）)]\s*$/, '')
    .trim();

  const content = (brkIdx >= 0 ? lines.slice(0, brkIdx) : lines).join('\n').trim();

  let branches: string[] = [];
  if (brkIdx >= 0) {
    branches = lines.slice(brkIdx + 1).filter(isBranchLine).map(clean).filter((l) => l.length > 1);
  }
  // 兜底：无标记时取末尾连续 bullet 行（很多模型把分支放最后）
  if (branches.length === 0) {
    const trailing: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isBranchLine(lines[i])) trailing.unshift(lines[i]);
      else if (trailing.length > 0) break;
    }
    branches = trailing.map(clean).filter((l) => l.length > 1);
  }
  return { content, branches: branches.slice(0, 4) };
}

/** 错误召回重试前校验工具参数是否为合法 JSON 对象：
 *  首轮失败常因参数被流式截断/坏字符（非法 JSON），若原样塞回 assistant.tool_calls 会 400 顶掉重试；
 *  非法则用 {} 占位（诊断文本已说明错误，模型仍可自纠）。 */
function isValidToolArgs(args: string): boolean {
  if (!args || !args.trim()) return false;
  try {
    const v = JSON.parse(args) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** 平台预计算 DAG 的运行上下文（runtime 注入只读句柄：检索器/扫描器/VMS） */
interface PlatformToolCtx extends ToolContext {
  runtime: Record<string, unknown> & {
    bars: Record<string, number>;
    round: number;
    input: string;
    ret?: { recallAsync: (opts: { query: string; round: number; budgetTokens: number }) => Promise<RecallResult> };
    scanner?: { scan: (opts: { text: string; seed: number; budgetTokens: number }) => ScanResult };
    vms?: { evaluate: () => { values: Record<string, string | number | boolean> } };
  };
}

export class ChatSession {
  private mem: MemoryDb;
  private writer: WriteLoop;
  private ret: RetrievalEngine;
  private scanner: LorebookScanner;
  private vms = new VariableManager();
  private client: OpenAICompatibleClient;
  private cfg: ReturnType<typeof loadProviderConfig>;
  private cardName = '';
  private cardDesc = '';
  private greeting = '';
  private dbPath: string;
  private args: SessionArgs;
  private lastTurn: string | undefined;
  private round = 0;
  private lastEventType = 'normal';
  private lastNsfwLock = { locked: false, round: 0 };
  private contentModes: Record<string, { jailbreak: string; director: string; worldbooks: string[] }> = {};
  /** MVU 引擎 ↔ VMS 桥（角色卡 tavern_helper 引擎脚本；回合后驱动 tick） */
  private bridge: MvuBridge | undefined;
  /** 插件宿主（04 §4.1：git 安装插件 + 沙箱钩子） */
  private plugins: PluginHost;
  /** 正则库（04 §4.3：卡片 regex_scripts 自动导入 + 前端屏蔽隐藏规则） */
  private regexLib: RegexLibrary;
  /** 滑动窗口配置（长对话防爆 token；env 可覆盖）
   *  windowN=10（5 回合×2）；windowTokens 窗口原文预算（窗口优先）；超预算旧文靠滚动摘要 + 检索 query 头召回 */
  private windowN = Number(process.env.JG_WINDOW_N ?? 10);
  private windowTokens = Number(process.env.JG_WINDOW_TOKENS ?? 3500);
  private longtermTokens = Number(process.env.JG_LONGTERM_TOKENS ?? 1500);
  private summaryRounds = Number(process.env.JG_SUMMARY_ROUNDS ?? 5);
  /** 上下文提供者运行时（L1：依赖满足激活 + 干净撤销）与 cost/priority 台账（L2 调度） */
  private ctxRuntime = new ContextProviderRuntime();
  private ctxCost = new Map<string, { cost: number; priority: number; reducible?: boolean }>();
  /** 实体名册（buildAliasIndex：entityName → AliasEntry，惰性构建一次）——角色档案层的数据源 */
  private entityRoster: Map<string, AliasEntry> | null = null;
  /** 本轮已注入档案的 lore 条目 id（记忆块去重用） */
  private archiveIds = new Set<number>();
  /** 每回合预计算结果暂存（provider build 闭包读取：L3 内容源） */
  private turnInput: { recall: RecallResult | null; scan: ScanResult | null; bars: Record<string, number>; vmsValues: Record<string, string | number | boolean> } =
    { recall: null, scan: null, bars: {}, vmsValues: {} };
  /** 变量编译调度器（0.4.0：卡 NL 变量规则 → manifest；Active 后运行期规则执行） */
  private varCompiler: VariableCompiler | null = null;
  private varRules: VariableManifestRule[] = [];
  /** 上轮规则执行变化集（紧凑注入：只注入变化的变量；首轮为空则全量紧凑兜底） */
  private lastVarEffects: RuleEffect[] = [];
  /** AQL 信号底座：回合遥测（只追加写，不回滚路径读取） */
  private telemetry: TelemetryRecorder;
  /** 每个 round 的用户重发计数（0=首次生成；regenerate 递增，delete/回滚清理） */
  private retryCounters = new Map<number, number>();
  /** 本回合上下文指纹（装配后填充，终局遥测落库用） */
  private lastFingerprint: ContextFingerprint | null = null;
  /** 本回合近似 token 成本（上下文估算；cost 塑形用） */
  private lastTokenCost = 0;
  /** 最近一次成功模型调用的真实 usage（DSH 插件会话事件桥接；attemptTurn 成功后填充） */
  private lastUsage: { promptTokens: number; completionTokens: number } | null = null;
  /** 本回合遥测上下文（runTurnCore 由 turn/regenerate 入参透传） */
  private telemetryCtx: { retryIndex: number; clickedRegenerate: boolean; prevProseMd5?: string; narrow?: boolean } =
    { retryIndex: 0, clickedRegenerate: false };
  /** 本回合是否收窄上下文（AQL 循环C：重试 ≥ narrowK 生效，重定向近况/档案） */
  private narrowMode = false;
  /** 已生成重规划建议的 round（每 round 仅一次，避免重复额外 LLM 开销） */
  private replanGenerated = new Map<number, boolean>();
  /** 本回合塑形奖励（终局落库；aborted/failed 为 0 分） */
  private lastReward: Record<string, number> | null = null;
  /** 进行中回合的中止控制器（turn/regenerate 入口登记、finally 清槽；/turn/abort 显式中止 + 并发守卫） */
  private activeAbort: AbortController | null = null;
  /** 自适应参数 Δ（AQL：data/adaptive-config.json 热读；有效值 = 基线 + Δ） */
  private summaryRoundsDelta = 0;
  private longtermTokensDelta = 0;
  private windowTokensDelta = 0;
  private narrowK = 2;
  private replanK = 3;

  /** 内容模式模块加载（WP14：可编辑文件 data/content-modes.json） */
  private loadContentModes(): void {
    const path = resolve('data', 'content-modes.json');
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { jailbreak?: string; director?: string; worldbooks?: string[] }>;
      for (const [mode, m] of Object.entries(raw)) {
        if (m && typeof m === 'object') {
          this.contentModes[mode] = { jailbreak: m.jailbreak ?? '', director: m.director ?? '', worldbooks: m.worldbooks ?? [] };
        }
      }
      console.log(`[内容模式] 加载模块: ${Object.keys(this.contentModes).join(', ')}`);
    } catch (e) {
      console.warn(`[内容模式] 模块加载失败: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  /** 当前分支的 jailbreak 包裹（未配置时返回空） */
  nsfwModuleFor(mode: string): string {
    const m = this.contentModes[mode];
    if (!m) return '';
    return `${m.jailbreak}\n\n${m.director}`;
  }

  /** 公共访问器（Web API 用） */
  getDbPath(): string { return this.dbPath; }
  getGreeting(): string { return this.greeting; }
  getCardName(): string { return this.cardName; }
  getHistory(): { round: number; role: string; content: string }[] {
    return this.mem.db.prepare('SELECT round, role, content FROM chat_log ORDER BY id').all() as { round: number; role: string; content: string }[];
  }
  getMemory(): { mem: MemoryDb; round: number } {
    return { mem: this.mem, round: this.round };
  }

  /** 最近一次成功模型调用的真实 usage（DSH 插件会话事件桥接用；无记录返回 null） */
  getLastUsage(): { promptTokens: number; completionTokens: number } | null {
    return this.lastUsage;
  }

  /** 当前 provider 模型名（DSH 插件事件桥接的 message.source.model 字段） */
  getModelName(): string {
    return this.cfg.model || '';
  }

  /** 关闭会话（释放 DB 文件句柄；服务端删除会话用） */
  close(): void {
    try { this.mem.close(); } catch { /* 已关闭 */ }
  }

  /** 卡名写入 memory_meta.config（会话列表标题用，避免依赖开场白文本/HTML） */
  private persistCardName(): void {
    if (!this.cardName) return;
    try {
      const row = this.mem.db.prepare('SELECT config FROM memory_meta WHERE id = 1').get() as { config: string } | undefined;
      const cfg = row ? (JSON.parse(row.config ?? '{}') as Record<string, unknown>) : {};
      cfg.card = this.cardName;
      this.mem.db.prepare('UPDATE memory_meta SET config = ? WHERE id = 1').run(JSON.stringify(cfg));
    } catch { /* 忽略 */ }
  }

  // ── 记忆控制台调试方法（Web 前端对接）──
  /** 双通道检索调试：返回分通道命中与融合得分 */
  debugSearch(query: string): import('../../packages/memory/src/retrieval.ts').RecallResult {
    return this.ret.recall({ query, round: this.round, budgetTokens: 400 });
  }
  /** 状态表（表0-5 SQL 化） */
  getStateRows(): { entity_type: string; entity_id: string; state_json: string; updated_round: number }[] {
    return this.mem.db.prepare('SELECT entity_type, entity_id, state_json, updated_round FROM memory_state ORDER BY id').all() as {
      entity_type: string; entity_id: string; state_json: string; updated_round: number;
    }[];
  }
  /** 大纲表（AM 码） */
  getArcRows(): { code: string; chapter: string; title: string; summary: string; status: string }[] {
    return this.mem.db.prepare('SELECT code, chapter, title, summary, status FROM memory_arc ORDER BY id').all() as {
      code: string; chapter: string; title: string; summary: string; status: string;
    }[];
  }
  /** 元数据（推进槽等） */
  getMeta(): { plot_round: number; bars: string; stage: string } | null {
    const row = this.mem.db.prepare('SELECT plot_round, bars, stage FROM memory_meta WHERE id = 1').get() as
      { plot_round: number; bars: string; stage: string } | undefined;
    return row ?? null;
  }

  // ── P2：世界书激活调试 + 推进槽/NSFW 状态 ──
  /** 世界书激活扫描调试：返回激活条目与统计 */
  debugScan(input: string): import('../../packages/core/src/scanner.ts').ScanResult {
    return this.scanner.scan({ text: input, seed: Date.now() % 100000, budgetTokens: 600 });
  }

  /** 角色档案调试：返回当前输入命中的角色档案注入块（text + 已注入条目 id） */
  debugArchive(input: string): { text: string; ids: number[] } {
    const focus: TurnFocus = { round: this.round, scene: this.currentScene(), present: this.presentEntities(input), bars: {}, input };
    const r = this.buildArchiveBlock(focus);
    return { text: r.text, ids: [...r.ids] };
  }

  /** 推进槽持久化：累加 bars_delta 到 memory_meta.bars（clamp 0-100） */
  private applyBars(delta: { personal?: number; accident?: number; main?: number; erotic?: number } | undefined): void {
    if (!delta) return;
    const meta = this.mem.db.prepare('SELECT bars FROM memory_meta WHERE id = 1').get() as { bars: string } | undefined;
    const bars = JSON.parse(meta?.bars ?? '{}') as Record<string, number>;
    for (const [k, v] of Object.entries(delta)) {
      const cur = bars[k] ?? 0;
      bars[k] = Math.max(0, Math.min(100, cur + Number(v ?? 0)));
    }
    this.mem.db.prepare('UPDATE memory_meta SET bars = ? WHERE id = 1').run(JSON.stringify(bars));
  }

  /** 预设生效块（启动流程审查 P0：选定预设 → 按 enabled ∧ override 过滤后注入 <预设>） */
  private presetBlocks: string[] = [];

  /** 加载选定预设：解析 → 注册 setvar 到 VMS + 生成生效块（用户层优先；来源由会话入参决定） */
  private loadPreset(file: string, overrides?: Record<string, boolean>): void {
    const presetPath = resolveAssetFile('preset', file);
    if (!presetPath) {
      console.warn(`[预设] 文件不存在: ${file}，跳过`);
      return;
    }
    try {
      const parsed = parsePreset(readFileSync(presetPath, 'utf8'), overrides ?? {});
      if (parsed.vars.length > 0) {
        const r = this.vms.registerBatch(parsed.vars);
        console.log(`[预设] ${parsed.name || file} VMS 注册 ${parsed.vars.length} 个变量（冲突 ${r.conflicts.length}）`);
      }
      // 生效块注入预算：上限 4000 字符（L1 预算内，防超长预设撑爆前缀）
      let budget = 4000;
      const blocks: string[] = [];
      for (const b of parsed.blockEntries) {
        if (budget <= 0) break;
        const content = b.content.length > budget ? `${b.content.slice(0, budget)}…` : b.content;
        blocks.push(content);
        budget -= content.length;
      }
      this.presetBlocks = blocks;
      console.log(`[预设] ${parsed.name || file} 生效块 ${parsed.stats.enabled}/${parsed.stats.total}（${parsed.stats.chars} 字符，注入 ${blocks.length} 块）`);
    } catch (e) {
      console.warn(`[预设] 加载失败: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  /** 变量控制台数据（声明 + 求值 + 依赖分层） */
  getVariables(): { decls: string[][]; values: Record<string, string | number | boolean>; layers: string[][]; errors: { name: string; message: string }[] } {
    const r = this.vms.evaluate();
    return {
      decls: this.vms.list().map((d) => [d.fullName, d.type, d.expression ?? String(d.value ?? '')]),
      values: r.values,
      layers: r.layers,
      errors: r.errors,
    };
  }

  /** 当前回合状态（推进槽/事件类型/NSFW 锁定 + 滑动窗口/长期摘要统计） */
  getTurnState(): { bars: Record<string, number>; event_type: string; nsfw_lock: { locked: boolean; round: number }; round: number; window: { count: number; tokens: number; truncated: boolean }; longterm: number } {
    const meta = this.getMeta();
    const window = this.buildChatWindow(this.round - 1);
    const longRow = this.mem.db.prepare('SELECT longterm FROM memory_meta WHERE id = 1').get() as { longterm: string } | undefined;
    return {
      bars: meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {},
      event_type: this.lastEventType,
      nsfw_lock: this.lastNsfwLock,
      round: this.round,
      window: { count: window.messages.length, tokens: window.tokens, truncated: window.truncated },
      longterm: (longRow?.longterm ?? '').length,
    };
  }

  /** 引擎桥状态（Web 调试展示） */
  getEngineState(): { ready: boolean; block: string; leaves: number; logs: string[] } | null {
    if (!this.bridge) return null;
    return {
      ready: this.bridge.isReady(),
      block: this.bridge.getStateBlock(1200),
      leaves: Object.keys(this.bridge.getFlat()).length,
      logs: this.bridge.getLogs().slice(-30),
    };
  }

  /** 会话配置（启动流程审查：世界书/预设为会话入参，Web 可回显） */
  getSessionConfig(): { card: string; mode: string; worldbooks: string[]; preset: string; presetBlocks: number; engine: boolean } {
    return {
      card: this.cardName,
      mode: this.args.contentMode ?? 'nsfw',
      worldbooks: this.args.worldbooks ?? [],
      preset: this.args.preset ?? '',
      presetBlocks: this.presetBlocks.length,
      engine: this.bridge?.isReady() ?? false,
    };
  }

  /** 外部 key/配置更新后热更 LLM 客户端（ProviderPanel 保存 Key → 对已建会话立即生效，无需重启/新建会话）
   *  原 client 构造函数内一次性绑定旧 key，导致前台写新 key 仅对新会话生效。 */
  rebindProvider(cfg: ReturnType<typeof loadProviderConfig>): void {
    this.cfg = cfg;
    try {
      this.client = new OpenAICompatibleClient(cfg);
      console.log(`[Provider] 会话 client 热更: baseUrl=${cfg.baseUrl} model=${cfg.model} key=${cfg.keyFingerprint ?? ''}`);
    } catch (e) {
      console.warn(`[Provider] client 重建失败（维持旧配置）: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  /** 引擎可见聊天上下文（chat_log → {is_user,is_system,content}；末条为 assistant 时引擎才计算） */
  private getChatForEngine(): { is_user: boolean; is_system: boolean; content: string }[] {
    const rows = this.mem.db.prepare('SELECT role, content FROM chat_log ORDER BY id').all() as { role: string; content: string }[];
    return rows.map((r) => ({ is_user: r.role === 'user', is_system: r.role === 'system', content: r.content }));
  }

  constructor(args: SessionArgs) {
    this.args = args;
    this.cfg = loadProviderConfig();
    assertProviderReady(this.cfg);
    this.dbPath = args.db ?? resolve('data', 'session.db');
    if (!existsSync(dirname(this.dbPath))) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.mem = new MemoryDb({ path: this.dbPath });
    this.telemetry = new TelemetryRecorder(this.mem.db, this.sessionLabel());
    this.writer = new WriteLoop(this.mem);
    this.ret = new RetrievalEngine(this.mem);
    this.scanner = new LorebookScanner(this.mem);
    this.client = new OpenAICompatibleClient(this.cfg);
    this.round = this.loadRound();
    this.refreshAdaptive();
    this.loadContentModes();
    // 插件宿主（04 §4.1：data/plugins 注册表，启用的服务端插件在 init 时沙箱加载）
    this.plugins = new PluginHost(new PluginRegistry(resolve('data', 'plugins')));
    // 正则库（04 §4.3：data/regex-rules.json，卡片正则自动导入）
    this.regexLib = new RegexLibrary();
    // L1 上下文 provider 注册（Cordis 底座：依存判定 + cost/priority 台账）
    this.initContextProviders();
  }

  /** 注册上下文 provider（L1 fiber）：每块声明 deps/build + 登记 cost/priority（L2）。
   *  build 读取 this.turnInput 预计算源（回合前由 runTurnCore 汇入），产注入片段。 */
  private initContextProviders(): void {
    // cost 默认适配 128k–200k 窗口；均可经 JG_COST_* 环境变量按量上调/下调
    this.regProvider('memory', Number(process.env.JG_COST_MEMORY ?? 5000), 75, {
      build: () => this.turnInput.recall?.injectedBlock ?? '',
    });
    this.regProvider('longterm', Number(process.env.JG_COST_LONGTERM ?? 1500), 70, {
      build: () => this.getLongTermBlock(),
    });
    // worldbook cost 须 ≥ JG_WB_BUDGET_TOKENS（5000t 内容 + 门控渲染标签开销），否则 over-cost 整块丢（宁丢勿裁）
    this.regProvider('worldbook', Number(process.env.JG_COST_WORLDBOOK ?? 12000), 60, {
      build: (focus) => this.gatedWorldbookBlock(focus),
    });
    // worldstate：变量段可降级（reducible），cost 默认 3000（核心段必留，变量段由 worldStateBlock 内部收缩到 JG_WORLDSTATE_VAR_TOKENS）
    this.regProvider('worldstate', Number(process.env.JG_COST_WORLDSTATE ?? 3000), 90, {
      build: (focus) => this.worldStateBlock(focus),
    }, true);
  }

  /** 登记单个 provider（成本/优先级进台账，fiber 进运行时） */
  private regProvider(id: string, cost: number, priority: number, fiber: Omit<ContextProviderFiber, 'id'>, reducible = false): void {
    this.ctxCost.set(id, { cost, priority, reducible });
    this.ctxRuntime.register({ id, ...fiber });
  }

  /** 当前场景标识：上轮 plan 的 scene/next_plan（无则空字符串） */
  private currentScene(): string {
    if (!this.lastTurn) return '';
    try {
      const p = JSON.parse(this.lastTurn) as { scene?: unknown; next_plan?: unknown };
      if (typeof p.scene === 'string') return p.scene;
      if (typeof p.next_plan === 'string') return p.next_plan.slice(0, 24);
    } catch { /* 忽略坏 JSON */ }
    return '';
  }

  /** 在场实体：输入去标点分词（2-8 字连续段），限 6 个 */
  private presentEntities(input: string): string[] {
    return input.split(/[，。！？、,.!?\s]+/).filter((s) => s.length >= 2 && s.length <= 8).slice(0, 6);
  }

  /** 世界书扫描面扩展：最近 n 条历史原文（跳 user 孤儿轮 + prompt 正则清洗），供关键词/正则命中。
   *  语义激活仍只用本轮输入（向量聚焦当前话题，不稀释召回重心）。 */
  private recentScanHistory(maxRound: number, n = 6): string[] {
    const rows = this.mem.db.prepare(
      `SELECT r.content AS content
       FROM chat_log r
       WHERE r.round <= ? AND r.role IN ('user', 'assistant')
         AND EXISTS (SELECT 1 FROM chat_log a WHERE a.round = r.round AND a.role = 'assistant')
       ORDER BY r.id DESC LIMIT ?`,
    ).all(maxRound, n) as { content: string }[];
    return rows.map((r) => applyRegexRules(r.content, this.regexLib.list(), 'prompt').text).reverse();
  }

  /** 实体名册（惰性构建一次）：世界书启用条目 → buildAliasIndex「实体名→所属条目」。
   *  复用离线索引同一逻辑（lore-parse），纯 core 计算，无 PG 依赖；CLI/Web 同享。
   *  注意：必须显式带 uid=行 id——parseLoreEntries 在缺 uid 时用数组下标覆盖 id（0 基），
   *  会与 lorebook_entry 自增 id（1 基）错位，导致档案条目选取漂移。 */
  private buildEntityRoster(): Map<string, AliasEntry> {
    if (this.entityRoster) return this.entityRoster;
    try {
      const rows = this.mem.db.prepare(
        'SELECT id, book, key, comment, content, constant, active FROM lorebook_entry WHERE active = 1'
      ).all() as { id: number; book: string; key: string; comment: string; content: string; constant: number; active: number }[];
      this.entityRoster = buildAliasIndex(parseLoreEntries(rows.map((r) => ({ ...r, uid: r.id })) as never, ''));
    } catch {
      this.entityRoster = new Map();
    }
    this.mergeAdaptiveAliases();
    return this.entityRoster;
  }

  /** 别名补齐（AQL 循环A）：把 adaptive-config 的 aliasAdditions 并入名册（2 字段称谓 miss 的确定性兜底） */
  private mergeAdaptiveAliases(): void {
    if (!this.entityRoster) return;
    for (const a of adaptiveAliasAdditions()) {
      if (!a.alias || !a.entityName) continue;
      if (!this.entityRoster.has(a.alias)) {
        this.entityRoster.set(a.alias, { entityName: a.entityName, entryIds: [], explicit: true });
      }
    }
  }

  /** 角色档案恒定层：名册实体（entityName/别名，含「会长→桐月樱佳」职位简写）命中本轮回话线索 →
   *  完整注入该实体「本体设定」条目（active=1 且 constant/comment 含实体名），绕开 120/200 字截断与 L2 调度。
   *  返回注入文本 + 已注入 lore 条目 id（记忆块去重）。预算 JG_ARCHIVE_TOKENS（默认 8000），≤2 实体。 */
  private buildArchiveBlock(focus: TurnFocus): { text: string; ids: Set<number> } {
    const empty = { text: '', ids: new Set<number>() };
    const roster = this.buildEntityRoster();
    if (roster.size === 0) return empty;
    const clue = `${focus.input} ${focus.present.join(' ')} ${focus.scene}`;
    // byEntity 携带 AliasEntry 引用：roster 的 key 是「别名」而非 entityName，不能靠 roster.get(entityName)
    const byEntity = new Map<string, { entry: AliasEntry; strength: number }>();
    for (const [alias, entry] of roster) {
      if (!entry.entityName) continue;
      const nameHit = clue.includes(entry.entityName);
      const aliasHit = alias !== entry.entityName && clue.includes(alias);
      if (!nameHit && !aliasHit) continue;
      const prev = byEntity.get(entry.entityName);
      const strength = Math.max(prev?.strength ?? 0, nameHit ? 2 : 1);
      byEntity.set(entry.entityName, { entry, strength });
    }
    const top = [...byEntity.entries()].sort((a, b) => b[1].strength - a[1].strength).slice(0, 2);
    if (top.length === 0) return empty;

    const globalBudget = Number(process.env.JG_ARCHIVE_TOKENS ?? 8000);
    const perEntityBudget = Math.max(1500, Math.floor(globalBudget / top.length));
    const ids = new Set<number>();
    const blocks: string[] = [];
    let used = 0;
    for (const [, { entry }] of top) {
      if (entry.entryIds.length === 0) continue;
      const placeholders = entry.entryIds.map(() => '?').join(',');
      const rows = this.mem.db.prepare(
        `SELECT id, comment, content, constant FROM lorebook_entry
         WHERE active = 1 AND id IN (${placeholders})
         ORDER BY constant DESC, id ASC`
      ).all(...entry.entryIds) as { id: number; comment: string; content: string; constant: number }[];
      // 本体设定：常驻条目 或 comment 含实体名的条目（排除情节/EJS 变量条目之外的同名碎片）
      const profile = rows.filter((r) => r.constant === 1 || String(r.comment ?? '').includes(entry.entityName));
      if (profile.length === 0) continue;
      for (const r of profile) ids.add(r.id);
      const text = profile.map((r) => `[${entry.entityName}] ${r.comment}: ${readableLoreContent(r.content)}`).join('\n');
      const capped = used + estimateTokens(text) > globalBudget
        ? shrinkToBudget(text, Math.min(perEntityBudget, globalBudget - used))
        : text;
      used += estimateTokens(capped);
      blocks.push(capped);
    }
    if (blocks.length === 0) return empty;
    return { text: `<角色档案>\n${blocks.join('\n\n')}\n</角色档案>`, ids };
  }

  /** 检索 query 增强：压缩摘要 + 完整输入 + 名册实体锚点 + 在场实体裸词 + 推进槽，预算内截断
   *  压缩摘要（memory_meta.longterm）并入 query 头：被滑动窗口压缩掉的旧文/远史靠摘要词项仍能被记忆检索召回；
   *  名册实体锚点（新）：input 命中任一枚实体别名/真名 → 追加该实体规范名（「会长」→「桐月樱佳」），
   *  解决用户不点全名时检索失去角色锚的问题；<300 字预算 */
  private buildRecallQuery(input: string, bars: Record<string, number>): string {
    const lt = this.getLongTermCompact();
    const roster = this.buildEntityRoster();
    const anchors: string[] = [];
    for (const [alias, entry] of roster) {
      if (!entry.entityName || anchors.includes(entry.entityName)) continue;
      if (input.includes(entry.entityName) || input.includes(alias)) anchors.push(entry.entityName);
      if (anchors.length >= 6) break;
    }
    // AQL 循环A：boosted 词条名并入 query 锚点（低召回词的显式查询头；自适应热读）
    const boost = adaptiveRetrieval();
    if (boost.boostIds.length > 0) {
      const placeholders = boost.boostIds.map(() => '?').join(',');
      const names = this.mem.db.prepare(
        `SELECT comment FROM lorebook_entry WHERE active = 1 AND id IN (${placeholders})`
      ).all(...boost.boostIds) as { comment: string }[];
      for (const n of names.slice(0, 4)) {
        const nm = String(n.comment ?? '').trim();
        if (nm && !anchors.includes(nm)) anchors.push(nm);
      }
    }
    const parts = [
      lt,
      input,
      ...anchors,
      ...this.presentEntities(input),
      Object.entries(bars).map(([k, v]) => `${k}:${v}`).join(' '),
    ].filter(Boolean);
    return parts.join(' ').slice(0, 300);
  }

  /** 压缩摘要紧凑片段（只读）：取 memory_meta.longterm 前 ~150 字作为检索 query 词元来源 */
  private getLongTermCompact(): string {
    const row = this.mem.db.prepare('SELECT longterm FROM memory_meta WHERE id = 1').get() as { longterm: string } | undefined;
    const lt = (row?.longterm ?? '').trim();
    return lt ? lt.slice(0, 150) : '';
  }

  /** 世界状态块：核心段（场景/在场/推进槽）恒定必留；变量段（上轮变化集 / 前 12 个 vmsValues）
   *  收缩到 JG_WORLDSTATE_VAR_TOKENS（默认 1200），避免变量段过大把整块拖入 over-cost。 */
  private worldStateBlock(focus: TurnFocus): string {
    const rawVars = this.lastVarEffects.length > 0
      ? formatVarDelta(this.lastVarEffects)
      : Object.entries(this.turnInput.vmsValues).slice(0, 12).map(([k, v]) => `${bareVarName(k)}=${v}`).join('; ');
    const maxVarTokens = Number(process.env.JG_WORLDSTATE_VAR_TOKENS ?? 1200);
    const vars = rawVars ? shrinkToBudget(`变量: ${rawVars}`, maxVarTokens) : '';
    return [
      '<世界状态>',
      `场景: ${focus.scene || '（未知）'}`,
      `在场: ${focus.present.join('、') || '（无）'}`,
      `推进槽: ${JSON.stringify(focus.bars)}`,
      vars,
      '</世界状态>',
    ].filter(Boolean).join('\n');
  }

  /** 世界书条件化门控：按在场实体/场景过滤已扫描条目（只注入相关条目；恒常条目保留）。
   *  语义融合条目已由融合公式确认相关性：high 整条保留；medium 注入标题+摘要提示可展开（LLM 决定是否展开）。
   *  在场实体为空时不过滤（presentEntities 依赖标点分词，无标点长句会得到空 present，
   *  若此时仍一票否决会误杀确定性激活条目 → 模型看不到世界书）；扫描器已按本轮输入激活，相关性有底。 */
  private gatedWorldbookBlock(focus: TurnFocus): string {
    const scan = this.turnInput.scan;
    if (!scan || !Array.isArray(scan.activated) || scan.activated.length === 0) return '';
    const maxEntryChars = Number(process.env.JG_WB_ENTRY_MAX_CHARS ?? 1200);
    const mediumChars = Number(process.env.JG_WB_MEDIUM_CHARS ?? 600);
    const relevant = scan.activated.filter((e) => {
      if (e.constant) return true;
      if (focus.present.length === 0) return true;
      // 语义融合已确认相关性：high 语义条目标记（fusion 阈值高）直接保留；medium 仍需在场/场景佐证
      if (e.matchType === 'semantic') {
        return e.priority === 'high' || focus.present.some((p) => `${e.comment} ${e.content}`.includes(p));
      }
      const text = `${e.comment} ${e.content}`;
      return focus.present.some((p) => text.includes(p))
        || (focus.scene.length > 0 && text.includes(focus.scene));
    });
    if (relevant.length === 0) return '';
    return relevant.map((e) => {
      // medium 语义：注入标题 + 摘要而非完整内容（LLM 决定是否展开）；其余注入完整；
      // 统一用可读设定（剥 EJS/MVU/{{//}} 代码），模型读到设定正文而非代码噪音
      const readable = readableLoreContent(e.content);
      const content = e.matchType === 'semantic' && e.priority === 'medium'
        ? `${readable.slice(0, mediumChars)}…(可展开)`
        : readable;
      const tag = e.constant ? '恒定' : e.matchType;
      return `[${tag}] ${e.comment}: ${content.slice(0, maxEntryChars)}`;
    }).join('\n');
  }

  /** 回合上下文调度：L1 激活（beginTurn）→ 收集激活块 → L2 全局预算裁剪 → 各槽位片段 */
  private scheduleTurnContext(focus: TurnFocus): {
    memoryBlock: string; longTermBlock: string; worldbookBlock: string; worldStateBlock: string; dropped: string[];
  } {
    this.ctxRuntime.beginTurn(focus);
    const blocks: ContextBlock[] = this.ctxRuntime.activeFragments().map(({ id, fragment }) => {
      const c = this.ctxCost.get(id) ?? { cost: 400, priority: 50 };
      return { id, fragment, cost: c.cost, priority: c.priority, reducible: c.reducible };
    });
    const sched = scheduleContext(blocks);
    if (sched.dropped.length > 0) console.log(`[调度] 预算裁剪: ${sched.dropped.map((d) => `${d.id}(${d.reason})`).join(', ')}`);
    const pick = (id: string): string => sched.blocks.find((b) => b.id === id)?.fragment ?? '';
    return {
      memoryBlock: pick('memory'),
      longTermBlock: pick('longterm'),
      worldbookBlock: pick('worldbook'),
      worldStateBlock: pick('worldstate'),
      dropped: sched.dropped.map((d) => d.id),
    };
  }

  // ── 变量后台自治（0.4.0：编译期一次性翻译 + 运行期确定性规则）──

  /** 卡变量编译接线：检测卡类型 → 结构化直注 / NL 走编译器 / MVU 直连桥（不进编译） */
  private async compileCardVariables(engineScript?: string): Promise<void> {
    const src = detectCardSource({ cardId: this.cardName, cardText: this.cardDesc, engineScript });
    if (src === 'none' || src === 'mvu') return; // MVU 卡由桥 tick，不进编译
    const spec: CardVariableSpec = { cardId: this.cardName, cardText: this.cardDesc, engineScript };
    if (src === 'structured') {
      this.registerVarSpecs(spec.structured ?? []);
      console.log(`[变量] 结构化声明 ${spec.structured?.length ?? 0} 项（直注，无编译）`);
      return;
    }
    // nl / mixed：编译器 LLM seam（缓存命中免 token；失败降级变量静止）
    this.varCompiler = new VariableCompiler(this.cardName, resolve('data', 'var-cache'), this.compileFromLlm.bind(this));
    const r = await this.varCompiler.compile(spec);
    if (r.state === 'active' && r.manifest) {
      this.registerVarSpecs(r.manifest.vars.map((v) => ({ name: v.name, type: v.type, default: v.default })));
      this.varRules = r.manifest.rules.filter((x) => !x.requires_ai);
      console.log(`[变量] 编译 ${r.manifest.source} 卡 → ${r.manifest.vars.length} 变量 / ${this.varRules.length} 规则${r.cacheHit ? '（缓存命中）' : ''}`);
    } else {
      console.log(`[变量] 编译降级（${r.state}）：${this.varCompiler.lastErrorOf()}`);
    }
  }

  /** 注册清单变量（literal 默认值；derived 规则由 VMS 表达式另算） */
  private registerVarSpecs(specs: { name: string; type: 'number' | 'string' | 'boolean'; default?: number | string | boolean }[]): void {
    for (const s of specs) {
      try {
        this.vms.register({ scope: 'session', source: 'card', name: s.name, type: 'literal', value: s.default ?? (s.type === 'number' ? 0 : s.type === 'boolean' ? false : '') });
      } catch { /* 冲突/坏名跳过，不阻断 */ }
    }
  }

  /** 编译器 LLM seam：卡 NL 变量规则 → VariableManifest JSON；无 provider key / 解析失败 → null（降级） */
  private async compileFromLlm(spec: CardVariableSpec, lastError?: string): Promise<VariableManifest | null> {
    if (!this.cfg.apiKey) return null;
    const prompt = [
      '把以下角色卡的变量规则编译为 JSON（VariableManifest）。',
      '格式：{"cardId":string,"source":"nl","vars":[{"name","type","default?"}],"rules":[{"trigger","action"}]}',
      '要求：变量名小写字母/下划线/中文；trigger 为 DSL 布尔表达式（可用 contains({event_user_input},"词")、{变量名}、算术/比较/逻辑）；action 为 "变量 = DSL表达式" 赋值，只能用已声明变量做左值；无规则则 rules:[]。',
      '只输出 JSON，不要解释。',
      lastError ? `\n上次编译被拒，原因：${lastError}\n请修正后重新输出完整 JSON。` : '',
      `\n规则文本：\n${spec.cardText.slice(0, 4000)}`,
    ].join('');
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: '你是角色扮演变量规则编译器，只输出合法 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
      });
      const text = (res.content ?? '').replace(/```(json)?/g, '').trim();
      return JSON.parse(text) as VariableManifest;
    } catch {
      return null;
    }
  }

  private loadRound(): number {
    const row = this.mem.db.prepare('SELECT plot_round FROM memory_meta WHERE id = 1').get() as { plot_round: number } | undefined;
    return row?.plot_round ?? 0;
  }

  /** 世界书加载（启动流程审查 P0：入参 worldbooks 显式选定；缺省 = content_mode 默认，不再硬编码路径）
   *  @param insert 预编译的 lorebook_entry INSERT 语句 */
  private async loadWorldbooks(
    onStage: ((stage: string) => void) | undefined,
    insert: ReturnType<MemoryDb['db']['prepare']>,
  ): Promise<void> {
    const mode = this.args.contentMode ?? 'nsfw';
    const modeCfg = this.contentModes[mode];
    const defaultLabels = modeCfg?.worldbooks ?? (mode === 'nsfw' ? ['XP大全绿灯版', '__XP大全'] : []);
    const books = this.args.worldbooks !== undefined
      ? this.args.worldbooks
      : defaultLabels.map((l) => WORLD_BOOK_LABELS[l] ?? l);
    for (const f of books) {
      const path = resolveAssetFile('worldbook', f);
      if (!path) { console.warn(`[世界书] 文件不存在: ${f}，跳过`); continue; }
      onStage?.('worldbook');
      try {
        const parsed = parseWorldBook(readFileSync(path, 'utf8'));
        for (const e of parsed.entries) {
          const r = entryToLorebookRow(e);
          insert.run(r.uid, r.book || f, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
        }
        console.log(`[世界书] ${f} ${parsed.stats.total} 条（mode=${mode}）`);
      } catch (e) {
        console.warn(`[世界书] ${f} 解析失败，跳过: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    // 检索渠道初始化不内联在本函数：resume 重建会话不传 card、不走卡片分支，
    // 渠道必须独立恢复（见 initRetrievalChannels / init 末尾调用点）
  }

  /** 检索渠道初始化：bge 注入（检索器+语义激活器）+ PG pgvector 关联 + 空库自动索引。
   *  独立于卡片导入路径——服务重启 resume 重建会话不传 card，此前渠道只在 loadWorldbooks（卡片分支内）
   *  初始化 → 恢复会话通道0(别名)/通道B(bge ANN) 全灭、检索恒 0 条（世界书 SQLite 扫描不受影响）。
   *  判据用 SQLite lorebook_entry 现状（resume 时已持久），不依赖本次是否重新导入世界书文件。 */
  private async initRetrievalChannels(onStage?: (stage: string) => void): Promise<void> {
    const loreCount = (this.mem.db.prepare('SELECT COUNT(*) c FROM lorebook_entry WHERE active = 1').get() as { c: number }).c;
    // 无启用条目：hash 兜底（原 vectorizable=false 路径）；useBge=false 且有世界书：不设 provider（原行为）
    if (loreCount === 0) {
      this.ret.setEmbeddingProvider(new HashEmbeddingProvider());
      return;
    }
    if (!this.args.useBge) return;
    onStage?.('vectorize');
    // 注入 embedding provider 到检索器 + 世界书语义激活器（同一 bge 模型，不重复编码）
    let wbProvider: import('../../packages/memory/src/embedding.ts').EmbeddingProvider | null = null;
    try {
      const provider = await createEmbeddingProvider(true);
      this.ret.setEmbeddingProvider(provider);
      wbProvider = provider;
      const vr = await new Vectorizer(this.mem, provider).run({ sources: ['lore'], batchSize: 32, incremental: true });
      console.log(`[向量] ${provider.name} 向量化 ${vr.vectorized} 条（语义激活）`);
    } catch (e) {
      this.ret.setEmbeddingProvider(new HashEmbeddingProvider());
      console.warn(`[向量] 失败，回落 hash: ${(e as Error).message.slice(0, 60)}`);
    }
    // 世界书整条目语义激活：复用 Vectorizer 已落库的 vec_memory 整条目向量，不重复编码。
    // 向量/编码缺失时扫描器自动降级为纯关键词/正则（基础功能不中断）。
    if (wbProvider) {
      try {
        this.scanner.setEmbeddingProvider(wbProvider);
        this.scanner.initSemantic(this.mem);
        console.log(`[世界书·语义] 整条目语义索引就绪（${this.scanner.isSemanticReady() ? '开' : '降级'}）`);
      } catch (e) {
        console.warn(`[世界书·语义] 语义索引初始化失败，降级关键词: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    // PG pgvector 真向量/别名检索通道（同一 bge model）；缺连优雅回落 SQLite 检索。
    // 计数按本会话命名空间统计：全库总数会掩盖「新会话命名空间为空 → 通道恒 0 命中」。
    // 空库且有启用条目时后台自动补索引（复用 index-lore 共享实现，幂等，不阻塞会话启动）。
    try {
      const pg = await getPgVectorStore();
      if (pg.isReady) {
        this.ret.setPgStore(pg);
        const ns = this.sessionLabel();
        const nsChunks = await pg.chunkCount(ns);
        const nsAliases = await pg.aliasCount(ns);
        console.log(`[向量] PG pgvector 就绪（本会话 namespace=${ns}: chunks=${nsChunks} aliases=${nsAliases}；全库 ${await pg.chunkCount()}）`);
        if (nsChunks === 0) {
          console.log(`[向量] 本会话 PG 命名空间为空，后台自动索引 ${loreCount} 条世界书（完成前别名/ANN 通道暂空）…`);
          void indexSessionLore(this.mem, pg, ns, wbProvider, (m) => console.log(m))
            .then((r) => {
              if (r) console.log(`[向量] PG 自动索引完成：${r.entries} 条 / ${r.chunks} 窗口 / ${r.aliases} 别名（namespace=${ns}）`);
            })
            .catch((e) => console.warn(`[向量] PG 自动索引失败（不影响对话，可手动跑 index-lore）: ${(e as Error).message.slice(0, 80)}`));
        }
      } else {
        this.ret.setPgStore(null);
      }
    } catch (e) {
      this.ret.setPgStore(null);
      console.warn(`[向量] PG 不可用，回落 SQLite 检索: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  /** 加载角色卡（新会话）或恢复（--resume / 自动检测）
   *  @param onStage 初始化阶段回调（Web SSE 进度用） */
  async init(onStage?: (stage: string) => void): Promise<void> {
    const hasHistory = (this.mem.db.prepare('SELECT COUNT(*) c FROM chat_log').get() as { c: number }).c > 0;
    if (!this.args.resume && hasHistory) {
      console.warn('[会话] 检测到已有历史，自动进入恢复模式（继续上一轮记忆）');
      this.args.resume = true;
    }
    // VMS 恢复（06 §6）：从 memory_state 快照恢复 literal 变量；来源注册（预设文件/引擎桥）随后覆盖同名
    const restored = restoreVariables(this.mem, this.vms);
    if (restored > 0) console.log(`[变量] 从快照恢复 ${restored} 个变量`);
    if (this.args.card) {
      onStage?.('card');
      // 角色卡解析：PNG 卡自动解包 chara tEXt（酒馆 PNG 首次可用）
      const cardBuf = readFileSync(this.args.card);
      const cardText = this.args.card.toLowerCase().endsWith('.png')
        ? (() => {
            const payload = extractCharaFromPng(cardBuf);
            if (!payload) throw new Error(`PNG 卡无 chara 元数据: ${this.args.card}`);
            return pngPayloadToJson(payload);
          })()
        : cardBuf.toString('utf8');
      const parsed = parseCharaCard(cardText);
      // 正则库：自动导入卡片 regex_scripts（隐藏类启用 / 美化类禁用），前端据此屏蔽隐藏
      const rgx = this.regexLib.importFromCard(parsed.regexScripts);
      if (rgx.imported > 0) console.log(`[正则] 卡片导入 ${rgx.imported} 条（跳过重复 ${rgx.skipped}，库共 ${this.regexLib.list().length} 条）`);
      this.cardName = parsed.card.name;
      this.cardDesc = parsed.card.data.description;
      this.greeting = parsed.card.data.first_mes || parsed.card.first_mes || '';
      // VMS：预设变量 + 生效块（会话入参选定，不再硬编码）
      if (this.args.preset) this.loadPreset(this.args.preset, this.args.presetOverrides);
      // 卡片世界书导入
      const insert = this.mem.db.prepare(
        'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      );
      for (const r of cardBookToLorebookRows(parsed.worldbookEntries, parsed.card.name)) {
        insert.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
      }
      // 世界书：会话入参选定（worldbooks）或按 content_mode 默认（WP14 素材归档）
      await this.loadWorldbooks(onStage, insert);
      // MVU 引擎接入（Phase 3）：角色卡 tavern_helper 引擎脚本 → 沙箱运行 + VMS 桥接
      const engineScript = parsed.tavernHelperScripts.find((s) => s.content.length > 10000);
      if (engineScript) {
        onStage?.('engine');
        this.bridge = new MvuBridge({
          cardName: this.cardName,
          engineScript: engineScript.content,
          db: this.mem,
          vms: this.vms,
        });
        await this.bridge.start();
        console.log(`[引擎] ${engineScript.name} 接入回合（ready=${this.bridge.isReady()}，叶子 ${Object.keys(this.bridge.getFlat()).length}）`);
      }
      // 变量后台自治（0.4.0）：卡变量规则编译（缓存命中免 token；MVU 卡直连桥）
      await this.compileCardVariables(engineScript?.content);
      if (!this.args.resume) {
        this.writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
      }
      // 会话标题持久化：卡名写入 memory_meta.config（会话列表标题用）
      this.persistCardName();
      onStage?.('ready');
      console.log(`[角色卡] ${this.cardName}`);
      if (!this.args.resume && this.greeting) {
        console.log(`\n━━━ ${this.cardName} ━━━\n${this.greeting.slice(0, 500)}`);
        this.logChat('assistant', this.greeting, 0);
      }
    } else {
      this.cardDesc = '';
      this.greeting = '';
    }
    // 检索渠道（bge/语义激活/PG）恢复：resume 不传 card 也必须执行——原挂在卡片分支 loadWorldbooks
    // 内，服务重启恢复会话后渠道全灭（检索恒 0 条根因）；新会话此处与世界书导入天然有序（导入先完成）
    await this.initRetrievalChannels(onStage);
    // 插件加载（04 §4.1）：启用插件的服务端入口沙箱加载 + onSessionStart 钩子
    this.plugins.start({ card: this.cardName, resume: this.args.resume });
  }

  private logChat(role: string, content: string, round: number): number {
    return this.mem.db.prepare('INSERT INTO chat_log (round, role, content, created_at) VALUES (?,?,?,?)')
      .run(round, role, content, new Date().toISOString()).lastInsertRowid as number;
  }

  /** 遥测会话标识 = 会话 DB 基名（与 PG 命名空间同源） */
  private sessionLabel(): string {
    return basename(this.dbPath).replace(/\.db$/i, '');
  }

  /** 本回合上下文指纹（M3 归因聚合字段字典；装配后填充 this.lastFingerprint） */
  private buildContextFingerprint(window: ReturnType<ChatSession['buildChatWindow']>, budgetDropped: string[]): ContextFingerprint {
    const recall = this.turnInput.recall;
    const scan = this.turnInput.scan;
    const summaryRound = (this.mem.db.prepare('SELECT summary_round FROM memory_meta WHERE id = 1').get() as { summary_round: number } | undefined)?.summary_round ?? 0;
    return {
      recallHitIds: recall?.hits?.map((h) => h.rowId) ?? [],
      recallCodes: recall?.codes ?? [],
      scanEntryIds: scan?.activated?.map((e) => e.id) ?? [],
      windowCount: window.messages.length,
      windowTokens: window.tokens,
      windowTruncated: window.truncated,
      distanceToSummary: this.round - summaryRound,
      longtermTokens: estimateTokens(this.getLongTermBlock()),
      archiveIds: [...this.archiveIds],
      budgetDropped,
      model: this.cfg.model || '',
      bars: this.turnInput.bars,
      retryIndex: this.telemetryCtx.retryIndex,
    };
  }

  /** 终局遥测落库（append-only；失败旁路不打断主链路）；attempt=模型尝试次数 */
  private recordTurn(outcome: 'ok' | 'aborted' | 'failed', attempt: number): void {
    this.telemetry.record({
      sessionId: this.sessionLabel(),
      round: this.round,
      attempt,
      retryIndex: this.telemetryCtx.retryIndex,
      clickedRegenerate: this.telemetryCtx.clickedRegenerate,
      outcome,
      tokenCost: this.lastTokenCost,
      contextFingerprint: this.lastFingerprint ?? undefined,
      reward: this.lastReward ?? undefined,
      prevProseMd5: this.telemetryCtx.prevProseMd5,
    });
  }

  /** 热读 adaptive-config 并应用到检索器/会话参数（半自动闭环：overrides 写入后调用）
   *  全部可回滚：reset 配置后行为回落 env/默认 */
  refreshAdaptive(): void {
    const R = adaptiveRetrieval();
    this.ret.setAdaptive({ boostIds: R.boostIds, dropThreshold: R.dropThreshold, weights: R.weights });
    const S = adaptiveSummaryDeltas();
    this.summaryRoundsDelta = S.roundsDelta;
    this.longtermTokensDelta = S.longtermTokensDelta;
    this.windowTokensDelta = S.windowTokensDelta;
    const T = adaptiveReplanThresholds();
    this.narrowK = T.narrowK;
    this.replanK = T.replanK;
    // 别名补齐可能变化 → 下次 buildEntityRoster 重建
    this.entityRoster = null;
  }

  /** 有效纪要参数（基线 + 自适应 Δ；下限保护防窗口/摘要塌陷） */
  private effectiveSummaryRounds(): number { return Math.max(1, this.summaryRounds + this.summaryRoundsDelta); }
  private effectiveLongtermTokens(): number { return Math.max(200, this.longtermTokens + this.longtermTokensDelta); }
  private effectiveWindowTokens(): number { return Math.max(500, this.windowTokens + this.windowTokensDelta); }

  /** 单轮对话
   *  @param contentMode 内容分支（缺省用会话配置）
   *  @param onProse     真流式回调：模型生成正文时逐字/逐块回调（prose 增量；未传入则完整返回时一次性给）
   *  @param signal      外部中止信号（用户停止生成；中止时保留已生成正文落库，不写记忆）
   */
  async turn(userInput: string, contentMode?: 'nsfw' | 'nsf', onProse?: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
    this.round++;
    return this.withActiveAbort(
      (sig) => this.runTurnCore(this.round, userInput, contentMode ?? this.args.contentMode ?? 'nsfw', onProse, { logUser: true }, sig),
      signal,
    );
  }

  /** 回合执行包装：并发守卫（同一会话同时只允许一个回合，防中止传播慢时新回合与幽灵回合交错写库）
   *  + in-flight 登记（abortActiveTurn 供 /turn/abort 显式中止；finally 清槽保证不卡后续回合） */
  private async withActiveAbort<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    if (this.activeAbort) throw new Error('上一回合仍在生成中，请先停止或等待完成');
    const internal = new AbortController();
    const forward = () => internal.abort();
    external?.addEventListener('abort', forward, { once: true });
    this.activeAbort = internal;
    try {
      return await run(internal.signal);
    } finally {
      this.activeAbort = null;
      external?.removeEventListener('abort', forward);
    }
  }

  /** 显式中止进行中的回合（Web /turn/abort 调用；res close 自动中止失效（经代理/断开检测丢事件）时的兜底）
   *  @returns 是否确有进行中回合被中止 */
  abortActiveTurn(): boolean {
    if (!this.activeAbort) return false;
    this.activeAbort.abort();
    return true;
  }

  /** 是否有回合进行中（Web /api/turn、/regenerate 入口并发守卫：忙时快速拒绝并明确提示） */
  isBusy(): boolean { return this.activeAbort !== null; }

  /** 平台预计算 → 工具 DAG（0.5.0 C：声明式工具，无依赖并行；执行全在平台，模型不参与选工具）
   *  工具：recall_memory(记忆检索) / worldbook_activate(世界书扫描) / update_variable(变量求值) / skill_match(Skill 匹配) */
  private buildPlatformDag(): ToolDag<PlatformToolCtx> {
    // self：闭包捕获 ChatSession（箭头内 this 被工具对象字面量上下文遮蔽）
    const self = this;
    const tools: ToolDefinition<PlatformToolCtx>[] = [
      {
        name: 'recall_memory', description: '记忆检索（RAG：弧/总结/事件/状态，RRF 融合）', dependencies: [], deterministic: true, sideEffects: false,
        async execute(c, args) {
          const round = c.runtime.round as number;
          const input = c.runtime.input as string;
          const bars = c.runtime.bars as Record<string, number>;
          const ns = basename(self.dbPath).replace(/\.db$/i, ''); // PG 命名空间 = 会话 DB 基名（隔离跨卡，同会话多世界书共享）
          const hits = await c.runtime.ret!.recallAsync({ query: self.buildRecallQuery(input, bars), round, budgetTokens: Number(process.env.JG_RECALL_BUDGET_TOKENS ?? 3000), namespace: ns });
          // data 必须直接是完整 RecallResult（调用方据此读 injectedBlock/codes 进装配）；包一层 {hits,raw}
          // 会让 provider 的 turnInput.recall.injectedBlock 读到 undefined → 记忆块静默失活（0.5.0 回归）
          return { ok: true, data: hits, cost: hits.hits.length };
        },
      },
      {
        name: 'worldbook_activate', description: '世界书扫描（正则/关键词命中 + 概率门 + 整条目语义融合召回）', dependencies: [], deterministic: false, sideEffects: false,
        async execute(c, args) {
          const round = c.runtime.round as number;
          const input = c.runtime.input as string;
          // 扫描面扩展（ST scanDepth 等价）：关键词/正则命中含最近 6 条历史；语义激活仍只看本轮输入
          const history = self.recentScanHistory(round - 1, 6);
          const scan = await c.runtime.scanner!.scanAsync({ text: input, history, seed: round, budgetTokens: Number(process.env.JG_WB_BUDGET_TOKENS ?? 5000) });
          return { ok: true, data: scan, cost: scan.activated.length };
        },
      },
      {
        name: 'update_variable', description: '变量求值（VMS：确定性 DSL 表达式求值）', dependencies: [], deterministic: true, sideEffects: false,
        execute(c, args) {
          const evalResult = c.runtime.vms!.evaluate();
          return { ok: true, data: evalResult, cost: Object.keys(evalResult.values).length };
        },
      },
      {
        name: 'skill_match', description: 'Skill 语义匹配（关键词/描述余弦，阈值+topK）', dependencies: [], deterministic: true, sideEffects: false,
        execute(c, args) {
          const input = c.runtime.input as string;
          const matches = matchSkills(input);
          return { ok: true, data: { matches }, cost: matches.length };
        },
      },
    ];
    const dag = new ToolDag<PlatformToolCtx>();
    for (const tool of tools) dag.define(tool);
    return dag;
  }

  /** 每轮核心（turn / regenerate 共用）：预计算→装配→模型→写环→引擎 tick→持久化→账本
   *  @param signal 外部中止信号：用户停止生成时，保留已流式生成的正文落库，不写记忆（07 铁律1）
   */
  private async runTurnCore(
    round: number, userInput: string, mode: 'nsfw' | 'nsf',
    onProse: ((chunk: string) => void) | undefined,
    opts: { logUser: boolean; telemetry?: { retryIndex?: number; clickedRegenerate?: boolean; prevProseMd5?: string } },
    signal?: AbortSignal,
  ): Promise<string> {
    this.round = round;
    this.telemetryCtx = opts.telemetry ? {
      retryIndex: opts.telemetry.retryIndex ?? 0,
      clickedRegenerate: opts.telemetry.clickedRegenerate ?? false,
      prevProseMd5: opts.telemetry.prevProseMd5,
      narrow: opts.telemetry.narrow,
    } : { retryIndex: 0, clickedRegenerate: false };
    this.narrowMode = this.telemetryCtx.narrow ?? false;
    this.lastReward = null;
    this.lastFingerprint = null;
    const emit = onProse ?? (() => {});
    // 0. 回合账本：写环前快照（重新生成/删除可精确回滚）+ 滑动窗口 + 滚动摘要
    const pre = this.snapshotPre();
    // AQL 循环C 收窄模式：重试 ≥ narrowK 时削减滑窗轮数（聚焦近期 + 档案），零额外 LLM 开销
    const windowInfo = this.buildChatWindow(round - 1, this.narrowMode ? { maxTurns: Math.max(2, Math.ceil(this.windowN / 2)) } : {});
    await this.maybeRollingSummarize(round, windowInfo);

    // ① 平台预计算 → 工具 DAG（0.5.0 C：平台步骤声明化为工具，自动拓扑并行 + 结果进 tool_results）
    // 推进槽（bars）：先于检索读取（焦点合成/检索 query 增强复用）
    const meta = this.getMeta();
    const bars = meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {};
    const dag = this.buildPlatformDag();
    const toolResults = await dag.runAll({
      round, input: userInput, deps: {},
      runtime: { bars, round, input: userInput, ret: this.ret, scanner: this.scanner, vms: this.vms },
    });
    const recall = (toolResults.recall_memory?.data as unknown as RecallResult) ?? null;
    const scan = (toolResults.worldbook_activate?.data as unknown as ScanResult) ?? null;
    const skillMatches = (toolResults.skill_match?.data as unknown as { matches?: SkillMatch[] } | undefined)?.matches ?? [];
    const vmsResult = toolResults.update_variable?.data as { values: Record<string, string | number | boolean> } | undefined;
    const skillBlock = renderSkillBlock(skillMatches);
    if (skillMatches.length > 0) console.log(`[Skill] 命中 ${skillMatches.map((m) => `${m.skill.name}(${m.score.toFixed(2)})`).join(', ')}`);
    const scanStats = scan?.stats as { budgetDropped?: number } | undefined;
    const recallStats = recall?.layerStats as { budgetDropped?: number } | undefined;
    console.log(`[预计算] 检索 ${recall?.hits?.length ?? 0} 条${recallStats?.budgetDropped ? `(+预算砍${recallStats.budgetDropped})` : ''} / 世界书 ${scan?.activated?.length ?? 0} 条${scanStats?.budgetDropped ? `(+预算砍${scanStats.budgetDropped})` : ''} / 变量 ${Object.keys(vmsResult?.values ?? {}).length} 个 / 窗口 ${windowInfo.messages.length} 条 ${windowInfo.tokens}t${windowInfo.truncated ? '（截断）' : ''}`);

    // ② 装配（L1/L2：焦点 → 依赖激活 → 全局预算调度 → 各槽位片段）
    const variableValues = { ...(vmsResult?.values ?? {}), ...(this.bridge?.getFlat() ?? {}) };
    this.turnInput = { recall: recall ?? null, scan: scan ?? null, bars, vmsValues: variableValues };
    const focus: TurnFocus = { round, scene: this.currentScene(), present: this.presentEntities(userInput), bars, input: userInput };
    // 角色档案恒定层：命中实体本体设定完整注入（绕开 120/200 字截断与 L2 调度预算）
    const archive = this.buildArchiveBlock(focus);
    this.archiveIds = archive.ids;
    const ctx = this.scheduleTurnContext(focus);
    // 记忆块去重：已被档案完整注入的 lore 条目从记忆召回剔除（避免同条目「短版+全版」重复喂给模型）
    let memoryBlock = ctx.memoryBlock;
    if (this.archiveIds.size > 0 && recall && Array.isArray(recall.hits)) {
      const deduped = recall.hits.filter((h) => !(h.category === 'lore' && this.archiveIds.has(h.rowId)));
      memoryBlock = renderRecallBlock(deduped);
    }
    // 动态状态：优先世界状态结构化块（L2 规范化呈现）；被预算裁掉则退回紧凑推进槽
    let dynamicState = ctx.worldStateBlock || `轮次: ${round}\n推进槽: ${JSON.stringify({
      personal: bars.personal ?? 0, accident: bars.accident ?? 0, main: bars.main ?? 0, erotic: bars.erotic ?? 0,
    })}`;
    if (this.bridge) dynamicState += `\n${this.bridge.getStateBlock(600)}`;
    // 插件钩子 onMessageSend：收集 promptInject（易变尾部注入，缓存友好）
    const pluginInject = this.plugins.callHook('onMessageSend', { userInput, round, mode })
      .flatMap((r) => (typeof (r as { promptInject?: unknown }).promptInject === 'string' ? [(r as { promptInject: string }).promptInject] : []))
      .filter((s) => s.length > 0);
    const userContent = `<最新互动>\n${userInput}\n</最新互动>${pluginInject.length ? `\n<插件注入>\n${pluginInject.join('\n')}\n</插件注入>` : ''}${skillBlock ? `\n${skillBlock}` : ''}`;
    const assembled = assembleTurn({
      systemCore: DEFAULT_SYSTEM_CORE,
      staticSettings: `角色卡：${this.cardName}\n${this.cardDesc.slice(0, 400)}${ctx.worldbookBlock ? `\n\n<世界书激活>\n${ctx.worldbookBlock}\n</世界书激活>` : ''}${archive.text ? `\n\n${archive.text}` : ''}\n\n<设定纪律>\n世界书/角色档案未记载的具体细节（外貌细节、能力名号与数值、未登场事件）严禁自行捏造；如剧情确需，向对方或世界意志询问，或以「（设定未记载）」留白。\n</设定纪律>`,
      dynamicState,
      presetBlocks: this.presetBlocks,
      memoryBlock,
      longTermBlock: ctx.longTermBlock,
      chatHistory: windowInfo.messages,
      lastTurn: this.lastTurn,
      userInput: userContent,
      useTools: true,
      variableValues,
      nsfwModule: this.nsfwModuleFor(mode),
    });
    // AQL 遥测指纹 + 成本估算（装配后；M3 归因聚合字段来源）
    this.lastFingerprint = this.buildContextFingerprint(windowInfo, ctx.dropped);
    this.lastTokenCost = windowInfo.tokens + estimateTokens(userContent) + estimateTokens(ctx.longTermBlock);
    if (opts.logUser) this.logChat('user', userInput, round);

    // ③ 模型调用（真流式）+ 校验 + 错误召回重试（统一：最多 2 次尝试，每次均过 归一化→校验；重试消息用首轮 tool_call 注入错误）
    // sentProse：已流式发出的正文累积（用户停止生成时保留该部分落库）
    let sentProse = '';
    let modelAttempts = 1;
    const attemptTurn = async (messages: import('../../packages/proxy/src/client.ts').ChatMessage[]):
      Promise<{ turn: GameTurn | null; tc: import('../../packages/proxy/src/client.ts').ToolCall | null; aborted?: boolean; issues?: string[]; details?: string[] }> => {
      const extractor = createProseStreamExtractor();
      let res: import('../../packages/proxy/src/client.ts').ChatResponse;
      try {
        res = await this.client.stream(
          { messages, tools: assembled.tools, temperature: 0.9 },
          () => {},   // content 增量忽略（prose 在 game_turn 工具参数里；content 多为模型思考/闲话）
          (name, argDelta) => {
            if (name === 'game_turn') {
              const p = extractor(argDelta);
              if (p) { emit(p); sentProse += p; }
            }
          },
          signal,
        );
      } catch (e) {
        if (e instanceof AbortTurnError) return { turn: null, tc: null, aborted: true };
        throw e;
      }
      const tc = res.toolCalls.find((t) => t.name === 'game_turn') ?? null;
      if (!tc) {
        console.log(`  ⚠ 未返回 game_turn（finish=${res.finishReason}）`);
        return { turn: null, tc: null };
      }
      // 真实 usage 记录（DSH 插件会话事件桥接；多步重试取最后一次成功调用）
      if (res.usage) {
        this.lastUsage = { promptTokens: res.usage.prompt_tokens ?? 0, completionTokens: res.usage.completion_tokens ?? 0 };
      }
      let turn = safeParseTurn(tc.arguments);
      if (!turn) return { turn: null, tc };
      const norm = normalizeTurn(turn);
      if (norm.warnings.length) console.log(`  ⚠ 归一化: ${norm.warnings.join('; ')}`);
      turn = norm.turn;
      const v = validateGameTurn(turn);
      if (!v.ok) {
        // 诊断：附实际字段值（供错误召回让模型自纠 + 日志可观测）
        const details = v.issues.map((issue) => diagIssueDetail(issue, turn)).filter((d): d is string => d.length > 0);
        console.log(`  ⚠ 契约失败: ${v.issues[0]}${details[0] ?? ''}`);
        return { turn: null, tc, issues: v.issues, details };
      }
      return { turn, tc };
    };

    const first = await attemptTurn(assembled.messages);
    if (first.aborted) { this.recordTurn('aborted', modelAttempts); return this.finalizeAborted(round, sentProse, pre); }
    let turn = first.turn;
    if (!turn && first.tc) {
      // 错误召回：把具体 zod issues + 实际值注入 tool result，模型才能自纠（否则复现同一错误）
      const diag = first.issues && first.issues.length > 0
        ? `game_turn 输出校验失败：${first.issues.join('; ')}${(first.details ?? []).join(' ')}。请严格按照上述每条要求修正后重新生成完整的 game_turn 参数。`
        : '输出校验失败，请重新生成完整的 game_turn 参数';
      console.log('  ⚠ 首轮失败，错误召回重试一次...');
      // 非法工具参数才回填 {}（safeParse 已失败=参数坏）；可解析参数保留原文供模型自查
      const retryTc = isValidToolArgs(first.tc.arguments) ? first.tc : { ...first.tc, arguments: '{}' };
      modelAttempts = 2;
      const retry = await attemptTurn(toolLoopMessages(assembled.messages, retryTc, diag));
      if (retry.aborted) { this.recordTurn('aborted', modelAttempts); return this.finalizeAborted(round, sentProse, pre); }
      turn = retry.turn;
    }

    if (!turn) {
      const msg = '（本轮回合生成失败，请重试）';
      this.logChat('assistant', msg, round);
      // 失败轮也记账本（created 空），后续删除该轮不崩
      this.writeLedger(round, pre, { mainCode: '', eventCodes: [], eventIds: [] }, 0, 0);
      this.lastReward = shapeTurnOutcome({ retryIndex: this.telemetryCtx.retryIndex, failed: true });
      this.recordTurn('failed', modelAttempts);
      return msg;
    }

    // ④ 写环（平台 AM 码 + 双表一致）+ 落库 + 推进槽持久化
    const wr = this.writer.execute({
      delta_summary: turn.memory_delta.delta_summary,
      state_changes: turn.memory_delta.state_changes,
      new_events: turn.memory_delta.new_events,
      round,
    });
    this.applyBars(turn.plan.bars_delta);
    this.lastEventType = turn.plan.event_type ?? 'normal';
    this.lastNsfwLock = turn.plan.nsfw_lock ?? { locked: false, round: 0 };
    this.lastTurn = JSON.stringify(turn.plan);
    // 插件钩子 onProsePostProcess：链式改写正文（前一个插件的 prose 作为下一个输入）
    let finalProse = turn.prose;
    for (const r of this.plugins.callHook('onProsePostProcess', { prose: finalProse, turn, round })) {
      const p = (r as { prose?: unknown }).prose;
      if (typeof p === 'string' && p.length > 0) finalProse = p;
    }
    turn.prose = finalProse;
    this.logChat('assistant', turn.prose, round);
    // ④b 确定性变量规则（0.4.0：后台自治，零 token）→ 上轮变化集供下一轮紧凑注入
    if (this.varRules.length > 0) {
      const rr = executeRules(this.varRules, { user_input: userInput, location: this.currentScene(), event_type: this.lastEventType }, this.vms);
      this.lastVarEffects = rr.effects;
      if (rr.effects.length > 0) console.log(`[变量] 规则更新 ${rr.effects.map((e) => `${bareVarName(e.name)}:${e.old}→${e.new}`).join(', ')}`);
      if (rr.errors.length > 0) console.warn(`[变量] 规则异常 ${rr.errors.length} 条：${rr.errors[0].message.slice(0, 80)}`);
    }
    // ⑤ MVU 引擎回合后计算：assistant 消息已落库 → 驱动引擎 tick（确定性演化 → VMS + 持久化）
    if (this.bridge) {
      const tick = this.bridge.tickAfterAiTurn(this.getChatForEngine(), round);
      console.log(`[引擎] 回合后计算 ${tick.elapsedMs}ms，变更 ${tick.changed.length} 项 / 叶子 ${tick.leaves}${tick.changed.slice(0, 6).map((p) => `\n    ↳ ${p}`).join('')}`);
    }
    // ⑥ VMS 快照落库（引擎 tick 变更的叶子即刻持久化，不依赖下一次 evaluate）
    persistVariables(this.mem, this.vms, round);
    this.mem.checkpoint();
    // ⑦ 回合账本：记录本轮新写行 + 写环前快照
    const userMsgId = this.mem.db.prepare('SELECT id FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1')
      .get(round, 'user') as { id: number } | undefined;
    const assistMsgId = this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(round) as { id: number } | undefined;
    this.writeLedger(round, pre, {
      summaryId: wr.summaryId, mainCode: wr.insertedCodes[0] ?? '', arcId: wr.arcId,
      eventCodes: wr.insertedCodes.slice(1), eventIds: wr.eventIds,
    }, userMsgId?.id ?? 0, assistMsgId?.id ?? 0);
    // AQL 终局遥测：ok + 塑形奖励（契约已绿：planOk=true；结构完整度来自 plan 字段）
    this.lastReward = shapeTurnOutcome({
      retryIndex: this.telemetryCtx.retryIndex,
      tokenCost: this.lastTokenCost,
      planOk: true,
      planStructureScore: planStructureScore(turn.plan),
    });
    this.recordTurn('ok', modelAttempts);
    return turn.prose;
  }

  // ── 重新生成 / 删除历史（round 账本机制）──

  /** 重新生成第 round 轮 AI 回复：回滚该轮状态（保留用户行）→ 用存储的用户输入重放
   *  @param signal 外部中止信号（同 turn：中止时保留已生成正文落库）
   *  模型异常（非中止）：原正文已被回滚，写占位 assistant 防孤儿 user 行，再抛出让上层报错 */
  regenerate(round: number, onProse?: (chunk: string) => void, signal?: AbortSignal): Promise<{ prose: string; round: number; assistantMsgId: number | null; replanSuggestion?: string | null }> {
    return this.withActiveAbort(async (sig) => {
      const userRow = this.mem.db.prepare('SELECT content FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1')
        .get(round, 'user') as { content: string } | undefined;
      if (!userRow) throw new Error(`round ${round} 无用户消息，无法重新生成`);
      // AQL 信号：重发计数（第 n 次重发）+ 旧正文 md5（旧正文将破坏性删除，hash 供差分/回看）
      const retryIndex = (this.retryCounters.get(round) ?? 0) + 1;
      this.retryCounters.set(round, retryIndex);
      const prevAssist = this.mem.db.prepare("SELECT content FROM chat_log WHERE round = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
        .get(round) as { content: string } | undefined;
      const prevProseMd5 = prevAssist ? createHash('md5').update(prevAssist.content).digest('hex') : undefined;
      // AQL 循环C：重试 ≥ narrowK → 收窄上下文（零 LLM，聚焦近期/档案）；= replanK → 生成一次重规划建议（不进 chat_log）
      const narrow = retryIndex >= this.narrowK;
      this.rollbackStateOnly(round);
      let prose: string;
      try {
        prose = await this.runTurnCore(round, userRow.content, this.args.contentMode ?? 'nsfw', onProse,
          { logUser: false, telemetry: { retryIndex, clickedRegenerate: true, prevProseMd5, narrow } }, sig);
      } catch (e) {
        // 回滚已删原 assistant，此处补占位（与 runTurnCore !turn 分支一致），保证该轮成对
        this.logChat('assistant', '（本轮回合生成失败，请重试）', round);
        this.writeLedger(round, this.snapshotPre(), { mainCode: '', eventCodes: [], eventIds: [] }, 0, 0);
        this.lastReward = shapeTurnOutcome({ retryIndex, failed: true });
        this.recordTurn('failed', 1);
        throw e;
      }
      const aid = this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
        .get(round) as { id: number } | undefined;
      // 中止后不再追加重规划建议 LLM 调用（停止语义 = 立即收尾，不多花一次 token）
      let replanSuggestion: string | null = null;
      if (!sig.aborted && retryIndex >= this.replanK && !this.replanGenerated.get(round)) {
        this.replanGenerated.set(round, true);
        replanSuggestion = await this.planRepairSuggestion(round);
      }
      return { prose, round, assistantMsgId: aid?.id ?? null, replanSuggestion };
    }, signal);
  }

  /** 删除消息（round=整轮 user+assistant+状态回滚；fromHere=从该轮到末尾全删）。
   *  同步写 delete 遥测（AQL 隐式负反馈）并清理该轮重发计数。 */
  deleteMessages(round: number, mode: 'round' | 'fromHere'): { ok: boolean; round: number } {
    if (round < 1) throw new Error('round 0（开场白）不可删除');
    const removed: number[] = [];
    if (mode === 'fromHere') {
      const max = this.loadRound();
      for (let r = max; r >= round; r--) { this.rollbackRound(r); removed.push(r); }
    } else {
      this.rollbackRound(round);
      removed.push(round);
    }
    this.round = (this.mem.db.prepare('SELECT COALESCE(MAX(round), 0) AS m FROM chat_log').get() as { m: number }).m;
    for (const r of removed) {
      const retryIndex = this.retryCounters.get(r) ?? 0;
      this.retryCounters.delete(r);
      this.telemetry.record({
        sessionId: this.sessionLabel(), round: r, attempt: 1, retryIndex, clickedRegenerate: false,
        outcome: 'deleted', tokenCost: 0, reward: { score: 0, acc: 0, cost: 0, step: 0 },
      });
    }
    return { ok: true, round };
  }

  /** 写环前快照：memory_meta 单行 + memory_state 全量 + 内存态（供回滚精确还原） */
  private snapshotPre(): {
    meta: Record<string, unknown> | null;
    state: { entity_type: string; entity_id: string; name: string; state_json: string; updated_round: number }[];
    round: number; lastTurn?: string; lastEventType: string; lastNsfwLock: { locked: boolean; round: number };
  } {
    const meta = this.mem.db.prepare('SELECT arc_id, stage, plot_round, bars, config, longterm, summary_round FROM memory_meta WHERE id = 1')
      .get() as Record<string, unknown> | undefined;
    const state = this.mem.db.prepare('SELECT entity_type, entity_id, name, state_json, updated_round FROM memory_state').all() as {
      entity_type: string; entity_id: string; name: string; state_json: string; updated_round: number;
    }[];
    return {
      meta: meta ?? null,
      state,
      round: this.round, lastTurn: this.lastTurn, lastEventType: this.lastEventType, lastNsfwLock: this.lastNsfwLock,
    };
  }

  private writeLedger(
    round: number,
    pre: ReturnType<ChatSession['snapshotPre']>,
    created: { summaryId?: number; mainCode: string; arcId?: number; eventCodes: string[]; eventIds: number[] },
    userMsgId: number, assistantMsgId: number,
  ): void {
    // meta_snapshot 附带内存态字段（_last*），回滚一并还原
    const metaSnap = {
      ...(pre.meta ?? {}),
      _lastTurn: pre.lastTurn,
      _lastEventType: pre.lastEventType,
      _lastNsfwLock: pre.lastNsfwLock,
    };
    this.mem.db.prepare(
      `INSERT OR REPLACE INTO round_ledger (round, user_msg_id, assistant_msg_id, meta_snapshot, state_snapshot, created, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(round, userMsgId, assistantMsgId, JSON.stringify(metaSnap), JSON.stringify(pre.state), JSON.stringify(created), new Date().toISOString());
  }

  /** 中止收尾（用户停止生成）：保留已流式生成的正文落库，不写记忆/引擎/变量（07 铁律1：不完整 turn 不写环）
   *  幂等：若该轮已有 assistant 落库（正常完成或已中止过）则跳过
   *  @param prose  已流式发出的正文（可能为空串，落库占位符）
   *  @param pre    写环前快照（round_ledger 回滚锚点，保证重新生成/删除不产生孤儿） */
  private finalizeAborted(round: number, prose: string, pre: ReturnType<ChatSession['snapshotPre']>): string {
    const existing = this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant'").get(round) as { id: number } | undefined;
    if (existing) return prose.trim() || '（已停止生成）';
    const text = prose.trim() || '（已停止生成）';
    this.logChat('assistant', text, round);
    const userMsgId = this.mem.db.prepare('SELECT id FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1')
      .get(round, 'user') as { id: number } | undefined;
    const assistMsgId = this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(round) as { id: number } | undefined;
    this.writeLedger(round, pre, { mainCode: '', eventCodes: [], eventIds: [] }, userMsgId?.id ?? 0, assistMsgId?.id ?? 0);
    console.log(`[中止] round ${round} 保留部分正文 ${text.length} 字（记忆未写）`);
    return text;
  }

  /** 前端停止后兜底落库（Web /turn/abort）：幂等等待进行中的 turn 完成中止落库
   *  若该轮 assistant 已落库（正常完成/已中止）则跳过；等待超时且 user 已入库 → 落库占位符，防孤儿 user 行
   *  先等 in-flight 回合终结：显式 abortActiveTurn 后 runTurnCore 毫秒级中止落库，此处等它完成再检查，
   *  保证端点返回时落库已定局（前端随后 fetchHistory 必能拿到部分正文/占位符，不出现状态漂移） */
  async finalizeAbortedRound(round: number): Promise<{ round: number; kept: boolean; waited: boolean }> {
    const hasAssistant = () => Boolean(this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant'").get(round));
    // 等 in-flight 回合终结（中止传播通常毫秒级；上限 3s 兜底慢网关，超时后由下方占位符路径保底）
    const ACTIVE_WAIT_MS = 3000;
    const ACTIVE_POLL_MS = 100;
    const activeDeadline = Date.now() + ACTIVE_WAIT_MS;
    while (this.activeAbort && Date.now() < activeDeadline) {
      await new Promise((r) => setTimeout(r, ACTIVE_POLL_MS));
    }
    if (hasAssistant()) return { round, kept: false, waited: false };
    // 等待进行中的 turn 完成中止落库（最多 1s，每 100ms 检查一次；保证部分正文优先于占位符）
    const ABORT_WAIT_MS = 1000;
    const ABORT_POLL_MS = 100;
    let waited = false;
    const deadline = Date.now() + ABORT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ABORT_POLL_MS));
      waited = true;
      if (hasAssistant()) return { round, kept: false, waited };
    }
    const userRow = this.mem.db.prepare('SELECT id FROM chat_log WHERE round = ? AND role = ?').get(round, 'user') as { id: number } | undefined;
    if (!userRow) return { round, kept: false, waited };
    // AQL 遥测：超时兜底补记 aborted（runTurnCore 已被中止返回时已记录，此路径幂等覆盖）
    this.telemetry.record({
      sessionId: this.sessionLabel(), round, attempt: 1, retryIndex: this.retryCounters.get(round) ?? 0,
      clickedRegenerate: false, outcome: 'aborted', tokenCost: this.lastTokenCost,
      contextFingerprint: this.lastFingerprint ?? undefined,
      reward: { score: 0, acc: 0, cost: 0, step: 0 },
    });
    const pre = this.snapshotPre();
    this.finalizeAborted(round, '', pre);
    return { round, kept: true, waited };
  }

  /** 回合失败兜底（模型异常/网络错误，非中止）：清除本轮孤儿 user 行 + 回退轮次计数 + 清空账本
   *  幂等：仅清理「有 user 无 assistant」的最大孤儿轮；正常完成/已中止轮不动。
   *  目的：孤儿 user 行会被下次 buildChatWindow 带入装配上下文 → 记忆断裂；清理后该轮视为未发生。 */
  rollbackFailedTurn(): { round: number; cleaned: boolean } {
    const orphan = this.mem.db.prepare(
      `SELECT r.round AS round
       FROM (SELECT DISTINCT round FROM chat_log WHERE role = 'user') r
       LEFT JOIN (SELECT DISTINCT round FROM chat_log WHERE role = 'assistant') a ON a.round = r.round
       WHERE a.round IS NULL
       ORDER BY r.round DESC LIMIT 1`,
    ).get() as { round: number } | undefined;
    if (!orphan) return { round: this.round, cleaned: false };
    const round = orphan.round;
    // 回合未完成：该轮 ledger 若已写（created 为空占位）一并清除，避免残留空账本
    this.mem.db.prepare('DELETE FROM round_ledger WHERE round = ?').run(round);
    // 轮次计数回退（当前正卡在该失败轮 → 回退到上一轮，下次 turn 重新递增）
    if (this.round >= round) this.round = round - 1;
    // 删除孤儿 user 行
    this.mem.db.prepare("DELETE FROM chat_log WHERE round = ? AND role = 'user'").run(round);
    // AQL 遥测：网络层失败轮（runTurnCore 抛出未落库）记 failed + 清理重发计数
    const retryIndex = this.retryCounters.get(round) ?? 0;
    this.retryCounters.delete(round);
    this.telemetry.record({
      sessionId: this.sessionLabel(), round, attempt: 1, retryIndex, clickedRegenerate: false,
      outcome: 'failed', tokenCost: this.lastTokenCost,
      contextFingerprint: this.lastFingerprint ?? undefined,
      reward: { score: 0, acc: 0, cost: 0, step: 0 },
    });
    console.log(`[兜底] 清理失败轮 round ${round} 孤儿 user 行（轮次回退 ${round - 1}）`);
    return { round, cleaned: true };
  }

  /** 回滚第 round 轮：删本轮新写行 + 恢复写环前状态；keepUser=true 保留用户行（重新生成路径） */
  private restoreFromLedger(round: number, keepUser: boolean): void {
    const ledger = this.mem.db.prepare('SELECT meta_snapshot, state_snapshot, created FROM round_ledger WHERE round = ?')
      .get(round) as { meta_snapshot: string; state_snapshot: string; created: string } | undefined;
    if (!ledger) return;
    let meta: Record<string, unknown> | null;
    let state: { entity_type: string; entity_id: string; name: string; state_json: string; updated_round: number }[];
    let created: { summaryId?: number; mainCode: string; arcId?: number; eventCodes: string[]; eventIds: number[] };
    try { meta = JSON.parse(ledger.meta_snapshot) as Record<string, unknown> | null; } catch { return; }
    try { state = JSON.parse(ledger.state_snapshot) as typeof state; } catch { state = []; }
    try { created = JSON.parse(ledger.created) as typeof created; } catch { created = { mainCode: '', eventCodes: [], eventIds: [] }; }

    // 1. chat_log
    if (keepUser) this.mem.db.prepare("DELETE FROM chat_log WHERE round = ? AND role = 'assistant'").run(round);
    else this.mem.db.prepare('DELETE FROM chat_log WHERE round = ?').run(round);
    // 2. memory_summary（round 精确；FTS 触发器自动清）
    this.mem.db.prepare('DELETE FROM memory_summary WHERE round = ?').run(round);
    // 3. memory_arc（主码 + title 兜底，避免双表孤儿）
    if (created.mainCode) this.mem.db.prepare('DELETE FROM memory_arc WHERE code = ?').run(created.mainCode);
    this.mem.db.prepare('DELETE FROM memory_arc WHERE title = ?').run(`R${round}`);
    // 4. memory_event（本轮新事件码）
    const evCodes = (created.eventCodes ?? []).filter((c) => c);
    if (evCodes.length > 0) {
      this.mem.db.prepare(`DELETE FROM memory_event WHERE code IN (${evCodes.map(() => '?').join(',')})`).run(...evCodes);
    }
    // 5. vec_memory（源行删除）
    const vecIds = [created.summaryId, created.arcId, ...(created.eventIds ?? [])]
      .filter((x): x is number => typeof x === 'number' && x > 0);
    if (vecIds.length > 0) {
      this.mem.db.prepare(`DELETE FROM vec_memory WHERE row_id IN (${vecIds.map(() => '?').join(',')})`).run(...vecIds);
    }
    // 5b. 剧情索引缓存随轮删除（rollback 后该轮索引失效，下次按需重建）
    this.mem.db.prepare('DELETE FROM story_index WHERE round = ?').run(round);
    // 6. memory_state 全量恢复（行数少，直接重建；FTS 触发器自动清）
    this.mem.db.prepare('DELETE FROM memory_state').run();
    const insState = this.mem.db.prepare(
      'INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES (?, ?, ?, ?, ?)'
    );
    const newIds: number[] = [];
    for (const s of state) newIds.push(Number(insState.run(s.entity_type, s.entity_id, s.name, s.state_json, s.updated_round).lastInsertRowid));
    // idx_entity.state 重建（行 id 已变）
    this.mem.db.prepare("DELETE FROM idx_entity WHERE category = 'state'").run();
    const insIdx = this.mem.db.prepare('INSERT OR REPLACE INTO idx_entity (entity, category, row_id, weight) VALUES (?, ?, ?, ?)');
    state.forEach((s, i) => insIdx.run(s.entity_id, 'state', newIds[i], 1.0));
    // 7. memory_meta 整行还原（含 longterm/summary_round）
    this.mem.db.prepare('DELETE FROM memory_meta').run();
    this.mem.db.prepare(
      'INSERT INTO memory_meta (id, arc_id, stage, plot_round, bars, config, longterm, summary_round) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
    ).run(meta.arc_id ?? 'arc-1', meta.stage ?? 'setup', meta.plot_round ?? 0, meta.bars ?? '{}',
      meta.config ?? '{}', meta.longterm ?? '', meta.summary_round ?? 0);
    // 8. 内存态 + VMS 重载（restoreVariables 按快照重注册 literal，来源随后覆盖）
    this.round = Number(meta.plot_round ?? 0);
    this.lastTurn = typeof meta._lastTurn === 'string' ? meta._lastTurn : undefined;
    this.lastEventType = (meta._lastEventType as string) ?? 'normal';
    this.lastNsfwLock = (meta._lastNsfwLock as { locked: boolean; round: number }) ?? { locked: false, round: 0 };
    restoreVariables(this.mem, this.vms);
  }

  /** 重新生成路径：仅删 assistant + 回滚状态，保留用户行 */
  private rollbackStateOnly(round: number): void {
    this.restoreFromLedger(round, true);
  }

  /** 删除整轮：删 user+assistant + 回滚状态 */
  private rollbackRound(round: number): void {
    this.restoreFromLedger(round, false);
  }

  // ── 滑动窗口 + 滚动摘要（长对话防爆 token）──

  /** 近期对话窗口：从新往旧累积，token/条数预算内保持正序；prompt 层正则清洗内部标记
   *  双保险：跳过孤儿轮（有 user 无 assistant，历史遗留或失败残留），避免带入装配上下文致记忆断裂 */
  private buildChatWindow(maxRound: number, opts: { maxTurns?: number } = {}): { messages: { role: string; content: string }[]; truncated: boolean; tokens: number; startRound: number } {
    const windowN = opts.maxTurns ?? this.windowN;
    const rows = this.mem.db.prepare('SELECT round, role, content FROM chat_log WHERE round <= ? ORDER BY id ASC').all(maxRound) as {
      round: number; role: string; content: string;
    }[];
    const orphanRounds = new Set(
      (this.mem.db.prepare(
        `SELECT r.round AS round
         FROM (SELECT DISTINCT round FROM chat_log WHERE role = 'user') r
         LEFT JOIN (SELECT DISTINCT round FROM chat_log WHERE role = 'assistant') a ON a.round = r.round
         WHERE a.round IS NULL`,
      ).all() as { round: number }[]).map((x) => x.round),
    );
    const kept: { round: number; role: string; content: string }[] = [];
    let tokens = 0;
    let truncated = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (kept.length >= windowN) { truncated = true; break; }
      if (orphanRounds.has(r.round)) continue;
      const clean = applyRegexRules(r.content, this.regexLib.list(), 'prompt').text;
      const t = estimateTokens(clean);
      // 预算裁剪：最新一条（kept 为空时）强制保留，避免「单条超预算 → 窗口塌陷只剩 1 条」；
      // 从第二条起严格按 windowTokens 预算从新往旧累积；被裁旧文靠滚动摘要 + 检索 query 头召回
      if (kept.length > 0 && tokens + t > this.effectiveWindowTokens()) { truncated = true; break; }
      kept.push({ round: r.round, role: r.role, content: clean });
      tokens += t;
    }
    kept.reverse();
    return {
      messages: kept.map(({ round: _r, role, content }) => ({ role, content })),
      truncated, tokens,
      startRound: kept.length > 0 ? kept[0].round : 0,
    };
  }

  /** 只读长期摘要（memory_meta.longterm），按 longtermTokens 预算截断（自适应 Δ 生效） */
  private getLongTermBlock(): string {
    const row = this.mem.db.prepare('SELECT longterm FROM memory_meta WHERE id = 1').get() as { longterm: string } | undefined;
    const lt = (row?.longterm ?? '').trim();
    if (!lt) return '';
    let out = lt;
    while (estimateTokens(out) > this.effectiveLongtermTokens() && out.length > 80) out = out.slice(0, Math.floor(out.length * 0.8));
    return `<长期摘要>\n${out}${out !== lt ? '…' : ''}\n</长期摘要>`;
  }

  /** 滚动摘要触发：窗口真实截断 & 距上次摘要 ≥ SUMMARY_ROUNDS（自适应 Δ 生效） */
  private async maybeRollingSummarize(round: number, window: { truncated: boolean; startRound: number }): Promise<void> {
    if (!window.truncated) return;
    const meta = this.mem.db.prepare('SELECT summary_round FROM memory_meta WHERE id = 1').get() as { summary_round: number } | undefined;
    const last = meta?.summary_round ?? 0;
    if (round - last < this.effectiveSummaryRounds()) return;
    await this.rollingSummarize(round, window.startRound);
  }

  /** 压缩滑出窗口的旧文 + 旧 longterm → 新 longterm（+1 次模型往返，阈值才触发） */
  private async rollingSummarize(round: number, windowStartRound: number): Promise<void> {
    const rows = this.mem.db.prepare('SELECT role, content FROM chat_log WHERE round >= 2 AND round < ? ORDER BY id DESC')
      .all(windowStartRound) as { role: string; content: string }[];
    const lines: string[] = [];
    let chars = 0;
    for (const r of rows) {
      const line = `${r.role === 'user' ? '玩家' : '角色'}: ${r.content}`;
      if (chars + line.length > 4000) break;
      lines.unshift(line);
      chars += line.length;
    }
    if (lines.length === 0) return;
    // 锚点检测：在滚动压缩前识别「不可丢弃」信息（实体首次出现/情感突变/目标声明/世界书触发点），
    // 即使窗口滑过也借新 longterm 保留（B1）。按累积滑出块新建实例，块内同名实体只记首次。
    const anchorBlock = this.anchorBlockFor(rows);
    const oldLong = this.getLongTermBlock();
    const prompt = `以下是从对话窗口中滑出的近期剧情（按时间正序）：\n\n${lines.join('\n')}\n\n${anchorBlock ? `${anchorBlock}\n\n` : ''}${oldLong ? `旧的长期摘要：\n${oldLong}\n\n` : ''}请输出合并去重后的新长期摘要，聚焦：角色关系、当前处境与目标、关键事件、未解决伏笔、已获物品/技能。要求：正文 ≤500 字，不含任何 XML/标签；若上面给出「不可丢弃锚点」，必须确保其中的实体关系、目标与关键事件被纳入摘要。`;
    let summary = '';
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: '你是剧情记忆压缩器，只输出摘要正文，禁止解释、禁止输出对话。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 700,
      });
      summary = (res.content ?? '').trim();
    } catch (e) {
      console.warn(`[摘要] 压缩失败，跳过本轮: ${(e as Error).message.slice(0, 80)}`);
      return;
    }
    if (!summary) return;
    let kept = summary.replace(/<[^>]{0,40}>/g, '');
    while (estimateTokens(kept) > this.effectiveLongtermTokens() && kept.length > 80) kept = kept.slice(0, Math.floor(kept.length * 0.8));
    this.mem.db.prepare('UPDATE memory_meta SET longterm = ?, summary_round = ? WHERE id = 1').run(kept, round);
    console.log(`[摘要] 滚动压缩 ${lines.length} 条旧文 → ${kept.length} 字（第 ${round} 轮触发）`);
  }

  /** 对滑出窗口的旧文跑关键锚点检测，格式化为「不可丢弃锚点」提示块（无锚点返回空串）。
   *  锚点并入 longterm：实体首次出现/情感突变/目标声明/世界书触发点即使窗口滑过也不丢。 */
  private anchorBlockFor(rows: { role: string; content: string }[]): string {
    const detector = new KeyAnchorDetector();
    const anchors = detector.detect(rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content, round: 0 })));
    if (anchors.length === 0) return '';
    const byType: Record<string, string[]> = {};
    for (const a of anchors) {
      const label: Record<KeyAnchor['type'], string> = {
        entity: '实体', emotion: '情感变化', goal: '目标声明', worldbook: '世界书触发',
      };
      (byType[label[a.type]] ??= []).push(a.text.slice(0, 30));
    }
    const lines = Object.entries(byType).map(([k, v]) => `- ${k}: ${[...new Set(v)].join('、')}`);
    return `<不可丢弃锚点>\n${lines.join('\n')}\n</不可丢弃锚点>`;
  }

  // ── 剧情分支索引（AI 生成，按轮缓存；帮助玩家决定下一步，减轻思考负担）──

  /** 生成第 round 轮的剧情分支索引：命中 story_index 缓存直接返回；否则由 AI 基于记忆生成 */
  async generateStoryIndex(round: number): Promise<{ content: string; branches: string[]; round: number; fromCache: boolean }> {
    const cached = this.mem.db.prepare('SELECT content FROM story_index WHERE round = ?').get(round) as { content: string } | undefined;
    if (cached) return { ...parseStoryIndex(cached.content), round, fromCache: true };

    // 从 DB 装配剧情记忆上下文（有界）
    const arcs = this.mem.db.prepare('SELECT title, summary FROM memory_arc ORDER BY id DESC LIMIT 10').all() as { title: string; summary: string }[];
    const events = this.mem.db.prepare('SELECT description FROM memory_event ORDER BY id DESC LIMIT 10').all() as { description: string }[];
    const meta = this.getMeta();
    const bars = meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {};
    const longterm = this.getLongTermBlock();
    let nextPlan = '';
    try {
      const last = this.lastTurn ? JSON.parse(this.lastTurn) as { next_plan?: string } : undefined;
      nextPlan = last?.next_plan ?? '';
    } catch { /* 忽略坏 JSON */ }
    const arcText = arcs.reverse().map((a) => `· ${a.title}: ${a.summary.slice(0, 120)}`).join('\n') || '（暂无）';
    const eventText = events.reverse().map((e) => `· ${e.description.slice(0, 120)}`).join('\n') || '（暂无）';
    const context = [
      `当前轮次: ${round}`,
      `推进槽: ${JSON.stringify(bars)}`,
      longterm ? `长期摘要:\n${longterm}` : '',
      `主线脉络（大纲表）:\n${arcText}`,
      `关键事件:\n${eventText}`,
      nextPlan ? `上一轮规划的下轮焦点: ${nextPlan}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `基于以下剧情记忆，生成一份"剧情分支索引"，帮助玩家决定下一步行动。必须严格按下面三段格式输出，段落标题必须是【当前局势】【未解决伏笔】【建议分支】：
【当前局势】1-2 句话概括
【未解决伏笔】
- （列出伏笔，每行一个）
【建议分支】
- （一个玩家可执行的行动指令）
- （另一个行动指令）
- （又一个行动指令）
要求：建议分支 3-4 个，每个必须结合剧情记忆生成、是当下最合理的行动，直接写玩家可执行的指令（如"- 前往旧校舍调查封印"），以 "- " 开头，不要加"分支1"等前缀，不要写后果括号；【未解决伏笔】不要用"- "之外的编号。整段 ≤450 字，不用 XML。

===剧情记忆===
${context}`;

    let content = '';
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: '你是剧情参谋，输出精炼的剧情分支索引，帮助玩家选下一步。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 600,
      });
      content = (res.content ?? '').trim();
    } catch (e) {
      console.warn(`[剧情索引] AI 生成失败，降级 DB 索引: ${(e as Error).message.slice(0, 80)}`);
    }
    if (!content) {
      content = `（AI 索引暂不可用，展示剧情脉络）\n\n【主线脉络】\n${arcText}\n\n【关键事件】\n${eventText}`;
    }
    if (content.length > 2000) content = content.slice(0, 2000);
    this.mem.db.prepare('INSERT OR REPLACE INTO story_index (round, content, created_at) VALUES (?, ?, ?)')
      .run(round, content, new Date().toISOString());
    const parsed = parseStoryIndex(content);
    console.log(`[剧情索引] round ${round} AI 生成 ${parsed.branches.length} 个分支`);
    return { ...parsed, round, fromCache: false };
  }

  /** 导演式重规划建议（AQL 循环C：retry_index ≥ replanK 时触发，每 round 一次）
   *  复用对话真实上下文（用户输入/窗口/长摘/上轮规划）做一次 LLM 诊断 →
   *  产出"重写方向"纯文本（≤200 字）。纪律：不进 chat_log、不进正文，仅作为前端"建议卡"；
   *  解析失败回退 null，绝不抛错打断 regenerate。 */
  async planRepairSuggestion(round: number): Promise<string | null> {
    const userRow = this.mem.db.prepare('SELECT content FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1')
      .get(round, 'user') as { content: string } | undefined;
    if (!userRow) return null;
    try {
      const windowInfo = this.buildChatWindow(round - 1);
      const recent = windowInfo.messages.slice(-3).map((m) => `${m.role === 'user' ? '玩家' : '角色'}: ${m.content.slice(0, 200)}`).join('\n');
      const longterm = this.getLongTermBlock() || '（无）';
      const meta = this.getMeta();
      const bars = meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {};
      let lastPlan = '';
      try {
        const last = this.lastTurn ? JSON.parse(this.lastTurn) as { next_plan?: string; scene?: string } : undefined;
        lastPlan = last?.next_plan ?? '';
      } catch { /* 忽略坏 JSON */ }
      const prompt = [
        `本轮玩家输入：\n${userRow.content.slice(0, 300)}`,
        `最近对话：\n${recent || '（无）'}`,
        `推进槽：${JSON.stringify(bars)}`,
        `长期摘要：\n${longterm}`,
        lastPlan ? `上轮规划的下轮焦点：${lastPlan}` : '',
      ].filter(Boolean).join('\n\n');
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: '你是剧本导演。玩家对某一轮回复不满意而重发，请诊断卡点并给出精炼的"重写方向"。规则：只给方向（应聚焦的角色/场景细节、卡点原因、下一步推进），不得捏造世界书未记载内容；输出 ≤200 字纯文本，不要解释，不用 XML。' },
          { role: 'user', content: `=== 当前剧情上下文 ===\n${prompt}` },
        ],
        temperature: 0.6,
        max_tokens: 300,
      });
      const text = (res.content ?? '').trim();
      if (!text) return null;
      console.log(`[重规划] round ${round} 生成重写方向 ${text.length} 字`);
      return text.slice(0, 300);
    } catch (e) {
      console.warn(`[重规划] 建议生成失败: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  }

  /** 静默生成（ST 生态前端 generateQuietPrompt → 宿主 rpc ai.generate）
   * 语义同 generateStoryIndex 但更轻：近窗转写 + 卡设定 → client.complete 一次性补全，
   * 不写 chat_log、不跑工具 DAG、不改记忆。返回纯文本（失败抛错，由端点降级 reply）。 */
  async quietGenerate(prompt: string, opts: { round?: number; mode?: 'nsfw' | 'nsf' } = {}): Promise<string> {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('生成提示为空');
    const round = Number.isInteger(opts.round) && (opts.round ?? 0) >= 0 ? (opts.round ?? 0) : this.round;
    const windowInfo = this.buildChatWindow(round - 1);
    const windowText = windowInfo.messages.length
      ? windowInfo.messages.map((m) => `${m.role === 'user' ? '玩家' : '角色'}: ${m.content}`).join('\n')
      : '（暂无对话窗口）';
    const longterm = this.getLongTermBlock();
    const system = `角色卡：${this.cardName}\n${this.cardDesc.slice(0, 400)}\n\n<设定纪律>\n世界书/角色档案未记载的具体细节（外貌细节、能力名号与数值、未登场事件）严禁自行捏造；如剧情确需，向对方或世界意志询问，或以「（设定未记载）」留白。\n</设定纪律>`;
    const user = `${longterm ? `${longterm}\n\n` : ''}<对话窗口>\n${windowText}\n</对话窗口>\n\n<补全任务>\n${text}\n</补全任务>\n\n请基于以上剧情与设定，直接输出补全结果正文（自然叙述，≤800 字），不要输出 XML/标签，不要解释。`;
    let res: import('../../packages/proxy/src/client.ts').ChatResponse;
    try {
      res = await this.client.complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        max_tokens: 1200,
      });
    } catch (e) {
      throw new Error(`静默生成失败: ${(e as Error).message.slice(0, 120)}`);
    }
    let out = (res.content ?? '').trim();
    if (out.length > 2000) out = out.slice(0, 2000);
    return out;
  }

  // ── 导演模式（对话内选区 → 复用本会话真实上下文跑分镜管线；结果落 memory_state 可检索）──

  async directorRun(
    params: DirectorParams,
    onStage?: (label: string, detail?: string) => void,
  ): Promise<StoryboardResult> {
    const text = params.selectedText.trim();
    if (!text) throw new Error('选中文本为空');
    // 检索 query：与会话回合同款增强（压缩摘要 + 完整选中文本 + 在场实体 + 推进槽），带 PG 命名空间隔离
    const meta = this.getMeta();
    const bars = meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {};
    const recallQuery = this.buildRecallQuery(text, bars);
    // extraContext：选中消息所在轮次之前的近期原文（buildChatWindow，对齐"L6 选中文本上下文"）
    const maxRound = Number.isInteger(params.round) && (params.round ?? 0) > 0 ? (params.round as number) : this.round;
    const window = this.buildChatWindow(maxRound);
    const ctx = [
      window.messages.length > 0
        ? `【近期剧情（至第 ${maxRound} 轮）】\n${window.messages.map((m) => `${m.role === 'user' ? '玩家' : '角色'}: ${m.content}`).join('\n')}`
        : '',
      `【用户选中片段】\n${text}`,
    ].filter(Boolean).join('\n\n');
    const orch = new StoryboardOrchestrator({
      client: this.client,
      ret: this.ret,
      scanner: this.scanner,
      vms: this.vms,
      mem: this.mem,
      cardName: this.cardName || '导演分镜',
      round: this.round,
    });
    const ns = basename(this.dbPath).replace(/\.db$/i, '');
    return orch.run(text, {
      mode: 'batch',
      shotCount: Math.min(30, Math.max(1, Number(params.shots ?? 3))),
      workflow: params.workflow,
      voice: params.voice,
      recallQuery,
      extraContext: ctx.slice(0, 6000),
      namespace: ns,
    }, onStage);
  }
}

// ── CLI 入口（仅主模块运行时执行；被 Web API import 时跳过）──
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const session = new ChatSession(args);
  await session.init();

  if (args.once) {
    const prose = await session.turn(args.once);
    console.log(`\n━━━ 回复 ━━━\n${prose}`);
    process.exit(0);
  }

  // 交互循环（酒馆对话体验）
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n（输入 /quit 退出，/new 重置轮次）');
  const promptUser = (): void => {
  rl.question('\n你> ', async (input) => {
    const t = input.trim();
    if (t === '/quit') { rl.close(); return; }
    if (t === '/new') {
      session['writer'].initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
      console.log('（已重置记忆）');
      promptUser();
      return;
    }
    if (!t) { promptUser(); return; }
    try {
      const prose = await session.turn(t);
      console.log(`\n━━━ 回复 ━━━\n${prose}`);
    } catch (e) {
      console.log(`\n⚠ 错误: ${(e as Error).message.slice(0, 120)}`);
    }
    promptUser();
  });
  };
  promptUser();
}
