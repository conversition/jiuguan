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
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseCharaCard, extractCharaFromPng, pngPayloadToJson } from '../../packages/core/src/chara.ts';
import { cardBookToLorebookRows, parseWorldBook, entryToLorebookRow } from '../../packages/core/src/worldbook.ts';
import { parsePreset } from '../../packages/core/src/preset.ts';
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { applyRegexRules } from '../../packages/core/src/regex.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { matchSkills, renderSkillBlock } from '../../packages/core/src/skills.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import type { WriteResult } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { Vectorizer } from '../../packages/memory/src/vectorize.ts';
import { createEmbeddingProvider, HashEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { persistVariables, restoreVariables } from '../../packages/variable/src/persist.ts';
import { assembleTurn, DEFAULT_SYSTEM_CORE, estimateTokens } from '../../packages/prompt/src/assembly.ts';
import { validateGameTurn, safeParseTurn, normalizeTurn, createProseStreamExtractor } from '../../packages/prompt/src/turn.ts';
import type { GameTurn } from '../../packages/prompt/src/turn.ts';
import { OpenAICompatibleClient, toolLoopMessages } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { MvuBridge } from '../../packages/sandbox/src/mvu-bridge.ts';
import { PluginRegistry, PluginHost } from '../../packages/plugin/src/index.ts';
import { resolveAsset, listAssets } from '../../packages/core/src/asset-paths.ts';
import type { AssetKind } from '../../packages/core/src/asset-paths.ts';

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
  /** 滑动窗口配置（长对话防爆 token；env 可覆盖） */
  private windowN = Number(process.env.JG_WINDOW_N ?? 12);
  private windowTokens = Number(process.env.JG_WINDOW_TOKENS ?? 1500);
  private longtermTokens = Number(process.env.JG_LONGTERM_TOKENS ?? 800);
  private summaryRounds = Number(process.env.JG_SUMMARY_ROUNDS ?? 20);

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

  /** 关闭会话（释放 DB 文件句柄；服务端删除会话用） */
  close(): void {
    try { this.mem.close(); } catch { /* 已关闭 */ }
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
    this.writer = new WriteLoop(this.mem);
    this.ret = new RetrievalEngine(this.mem);
    this.scanner = new LorebookScanner(this.mem);
    this.client = new OpenAICompatibleClient(this.cfg);
    this.round = this.loadRound();
    this.loadContentModes();
    // 插件宿主（04 §4.1：data/plugins 注册表，启用的服务端插件在 init 时沙箱加载）
    this.plugins = new PluginHost(new PluginRegistry(resolve('data', 'plugins')));
    // 正则库（04 §4.3：data/regex-rules.json，卡片正则自动导入）
    this.regexLib = new RegexLibrary();
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
    let vectorizable = false;
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
        vectorizable = true;
      } catch (e) {
        console.warn(`[世界书] ${f} 解析失败，跳过: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    // 语义向量化（bge；失败回落 hash）
    if (vectorizable && this.args.useBge) {
      onStage?.('vectorize');
      try {
        const provider = await createEmbeddingProvider(true);
        this.ret.setEmbeddingProvider(provider);
        const vr = await new Vectorizer(this.mem, provider).run({ sources: ['lore'], batchSize: 32, incremental: true });
        console.log(`[向量] ${provider.name} 向量化 ${vr.vectorized} 条（语义激活）`);
      } catch (e) {
        this.ret.setEmbeddingProvider(new HashEmbeddingProvider());
        console.warn(`[向量] 失败，回落 hash: ${(e as Error).message.slice(0, 60)}`);
      }
    } else if (!vectorizable) {
      this.ret.setEmbeddingProvider(new HashEmbeddingProvider());
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
      if (!this.args.resume) {
        this.writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
      }
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
    // 插件加载（04 §4.1）：启用插件的服务端入口沙箱加载 + onSessionStart 钩子
    this.plugins.start({ card: this.cardName, resume: this.args.resume });
  }

  private logChat(role: string, content: string, round: number): number {
    return this.mem.db.prepare('INSERT INTO chat_log (round, role, content, created_at) VALUES (?,?,?,?)')
      .run(round, role, content, new Date().toISOString()).lastInsertRowid as number;
  }

  /** 单轮对话
   *  @param contentMode 内容分支（缺省用会话配置）
   *  @param onProse     真流式回调：模型生成正文时逐字/逐块回调（prose 增量；未传入则完整返回时一次性给）
   */
  async turn(userInput: string, contentMode?: 'nsfw' | 'nsf', onProse?: (chunk: string) => void): Promise<string> {
    this.round++;
    return this.runTurnCore(this.round, userInput, contentMode ?? this.args.contentMode ?? 'nsfw', onProse, { logUser: true });
  }

  /** 每轮核心（turn / regenerate 共用）：预计算→装配→模型→写环→引擎 tick→持久化→账本 */
  private async runTurnCore(
    round: number, userInput: string, mode: 'nsfw' | 'nsf',
    onProse: ((chunk: string) => void) | undefined,
    opts: { logUser: boolean },
  ): Promise<string> {
    this.round = round;
    const emit = onProse ?? (() => {});
    // 0. 回合账本：写环前快照（重新生成/删除可精确回滚）+ 滑动窗口 + 滚动摘要
    const pre = this.snapshotPre();
    const windowInfo = this.buildChatWindow(round - 1);
    await this.maybeRollingSummarize(round, windowInfo);

    // ① 平台预计算（并行：检索 + 扫描 + 变量 + Skill 自觉匹配）
    const [recall, scan, skillMatches] = await Promise.all([
      this.ret.recallAsync({ query: userInput.slice(0, 24), round, budgetTokens: 400 }),
      Promise.resolve(this.scanner.scan({ text: userInput, seed: round, budgetTokens: 1200 })),
      // Skill 系统：语义匹配用户输入 vs 各 skill 描述（阈值/topK），命中读取指令正文
      Promise.resolve(matchSkills(userInput)),
    ]);
    const skillBlock = renderSkillBlock(skillMatches);
    if (skillMatches.length > 0) console.log(`[Skill] 命中 ${skillMatches.map((m) => `${m.skill.name}(${m.score.toFixed(2)})`).join(', ')}`);
    const vmsResult = this.vms.evaluate();
    console.log(`[预计算] 检索 ${recall.hits.length} 条 / 世界书 ${scan.activated.length} 条 / 变量 ${Object.keys(vmsResult.values).length} 个 / 窗口 ${windowInfo.messages.length} 条 ${windowInfo.tokens}t${windowInfo.truncated ? '（截断）' : ''}`);

    // ② 装配
    // 推进槽：从 memory_meta 读实际值（引擎状态块随动态状态注入）
    const meta = this.getMeta();
    const bars = meta ? JSON.parse(meta.bars ?? '{}') as Record<string, number> : {};
    let dynamicState = `轮次: ${round}\n推进槽: ${JSON.stringify({
      personal: bars.personal ?? 0, accident: bars.accident ?? 0, main: bars.main ?? 0, erotic: bars.erotic ?? 0,
    })}`;
    if (this.bridge) dynamicState += `\n${this.bridge.getStateBlock(600)}`;
    // 插件钩子 onMessageSend：收集 promptInject（易变尾部注入，缓存友好）
    const pluginInject = this.plugins.callHook('onMessageSend', { userInput, round, mode })
      .flatMap((r) => (typeof (r as { promptInject?: unknown }).promptInject === 'string' ? [(r as { promptInject: string }).promptInject] : []))
      .filter((s) => s.length > 0);
    // 变量值：VMS 全量 + 引擎叶子（完整名 session:mvu:<path>，宏展开走后缀匹配）
    const variableValues = { ...vmsResult.values, ...(this.bridge?.getFlat() ?? {}) };
    const userContent = `<最新互动>\n${userInput}\n</最新互动>${pluginInject.length ? `\n<插件注入>\n${pluginInject.join('\n')}\n</插件注入>` : ''}${skillBlock ? `\n${skillBlock}` : ''}`;
    const assembled = assembleTurn({
      systemCore: DEFAULT_SYSTEM_CORE,
      staticSettings: `角色卡：${this.cardName}\n${this.cardDesc.slice(0, 400)}${scan.injectedBlock ? `\n\n<世界书激活>\n${scan.injectedBlock}\n</世界书激活>` : ''}`,
      dynamicState,
      presetBlocks: this.presetBlocks,
      memoryBlock: recall.injectedBlock,
      longTermBlock: this.getLongTermBlock(),
      chatHistory: windowInfo.messages,
      lastTurn: this.lastTurn,
      userInput: userContent,
      useTools: true,
      variableValues,
      nsfwModule: this.nsfwModuleFor(mode),
    });
    if (opts.logUser) this.logChat('user', userInput, round);

    // ③ 模型调用（真流式）+ 校验 + 错误召回重试（统一：最多 2 次尝试，每次均过 归一化→校验；重试消息用首轮 tool_call 注入错误）
    const attemptTurn = async (messages: import('../../packages/proxy/src/client.ts').ChatMessage[]):
      Promise<{ turn: GameTurn | null; tc: import('../../packages/proxy/src/client.ts').ToolCall | null }> => {
      const extractor = createProseStreamExtractor();
      const res = await this.client.stream(
        { messages, tools: assembled.tools, temperature: 0.9 },
        () => {},   // content 增量忽略（prose 在 game_turn 工具参数里；content 多为模型思考/闲话）
        (name, argDelta) => {
          if (name === 'game_turn') {
            const p = extractor(argDelta);
            if (p) emit(p);
          }
        },
      );
      const tc = res.toolCalls.find((t) => t.name === 'game_turn') ?? null;
      if (!tc) {
        console.log(`  ⚠ 未返回 game_turn（finish=${res.finishReason}）`);
        return { turn: null, tc: null };
      }
      let turn = safeParseTurn(tc.arguments);
      if (!turn) return { turn: null, tc };
      const norm = normalizeTurn(turn);
      if (norm.warnings.length) console.log(`  ⚠ 归一化: ${norm.warnings.join('; ')}`);
      turn = norm.turn;
      const v = validateGameTurn(turn);
      if (!v.ok) {
        console.log(`  ⚠ 契约失败: ${v.issues[0]}`);
        return { turn: null, tc };
      }
      return { turn, tc };
    };

    const first = await attemptTurn(assembled.messages);
    let turn = first.turn;
    if (!turn && first.tc) {
      console.log('  ⚠ 首轮失败，错误召回重试一次...');
      turn = (await attemptTurn(toolLoopMessages(assembled.messages, first.tc, '输出校验失败，请重新生成完整的 game_turn 参数'))).turn;
    }

    if (!turn) {
      const msg = '（本轮回合生成失败，请重试）';
      this.logChat('assistant', msg, round);
      // 失败轮也记账本（created 空），后续删除该轮不崩
      this.writeLedger(round, pre, { mainCode: '', eventCodes: [], eventIds: [] }, 0, 0);
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
    return turn.prose;
  }

  // ── 重新生成 / 删除历史（round 账本机制）──

  /** 重新生成第 round 轮 AI 回复：回滚该轮状态（保留用户行）→ 用存储的用户输入重放 */
  async regenerate(round: number, onProse?: (chunk: string) => void): Promise<{ prose: string; round: number; assistantMsgId: number | null }> {
    const userRow = this.mem.db.prepare('SELECT content FROM chat_log WHERE round = ? AND role = ? ORDER BY id DESC LIMIT 1')
      .get(round, 'user') as { content: string } | undefined;
    if (!userRow) throw new Error(`round ${round} 无用户消息，无法重新生成`);
    this.rollbackStateOnly(round);
    const prose = await this.runTurnCore(round, userRow.content, this.args.contentMode ?? 'nsfw', onProse, { logUser: false });
    const aid = this.mem.db.prepare("SELECT id FROM chat_log WHERE round = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(round) as { id: number } | undefined;
    return { prose, round, assistantMsgId: aid?.id ?? null };
  }

  /** 删除消息（round=整轮 user+assistant+状态回滚；fromHere=从该轮到末尾全删） */
  deleteMessages(round: number, mode: 'round' | 'fromHere'): { ok: boolean; round: number } {
    if (round < 1) throw new Error('round 0（开场白）不可删除');
    if (mode === 'fromHere') {
      const max = this.loadRound();
      for (let r = max; r >= round; r--) this.rollbackRound(r);
    } else {
      this.rollbackRound(round);
    }
    this.round = (this.mem.db.prepare('SELECT COALESCE(MAX(round), 0) AS m FROM chat_log').get() as { m: number }).m;
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

  /** 近期对话窗口：从新往旧累积，token/条数预算内保持正序；prompt 层正则清洗内部标记 */
  private buildChatWindow(maxRound: number): { messages: { role: string; content: string }[]; truncated: boolean; tokens: number; startRound: number } {
    const rows = this.mem.db.prepare('SELECT round, role, content FROM chat_log WHERE round <= ? ORDER BY id ASC').all(maxRound) as {
      round: number; role: string; content: string;
    }[];
    const kept: { round: number; role: string; content: string }[] = [];
    let tokens = 0;
    let truncated = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (kept.length >= this.windowN) { truncated = true; break; }
      const clean = applyRegexRules(r.content, this.regexLib.list(), 'prompt').text;
      const t = estimateTokens(clean);
      if (tokens + t > this.windowTokens && kept.length > 0) { truncated = true; break; }
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

  /** 只读长期摘要（memory_meta.longterm），按 longtermTokens 预算截断 */
  private getLongTermBlock(): string {
    const row = this.mem.db.prepare('SELECT longterm FROM memory_meta WHERE id = 1').get() as { longterm: string } | undefined;
    const lt = (row?.longterm ?? '').trim();
    if (!lt) return '';
    let out = lt;
    while (estimateTokens(out) > this.longtermTokens && out.length > 80) out = out.slice(0, Math.floor(out.length * 0.8));
    return `<长期摘要>\n${out}${out !== lt ? '…' : ''}\n</长期摘要>`;
  }

  /** 滚动摘要触发：窗口真实截断 & 距上次摘要 ≥ SUMMARY_ROUNDS */
  private async maybeRollingSummarize(round: number, window: { truncated: boolean; startRound: number }): Promise<void> {
    if (!window.truncated) return;
    const meta = this.mem.db.prepare('SELECT summary_round FROM memory_meta WHERE id = 1').get() as { summary_round: number } | undefined;
    const last = meta?.summary_round ?? 0;
    if (round - last < this.summaryRounds) return;
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
    const oldLong = this.getLongTermBlock();
    const prompt = `以下是从对话窗口中滑出的近期剧情（按时间正序）：\n\n${lines.join('\n')}\n\n${oldLong ? `旧的长期摘要：\n${oldLong}\n\n` : ''}请输出合并去重后的新长期摘要，聚焦：角色关系、当前处境与目标、关键事件、未解决伏笔、已获物品/技能。要求：正文 ≤500 字，不含任何 XML/标签。`;
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
    while (estimateTokens(kept) > this.longtermTokens && kept.length > 80) kept = kept.slice(0, Math.floor(kept.length * 0.8));
    this.mem.db.prepare('UPDATE memory_meta SET longterm = ?, summary_round = ? WHERE id = 1').run(kept, round);
    console.log(`[摘要] 滚动压缩 ${lines.length} 条旧文 → ${kept.length} 字（第 ${round} 轮触发）`);
  }

  // ── 剧情分支索引（AI 生成，按轮缓存；帮助玩家决定下一步，减轻思考负担）──

  /** 生成第 round 轮的剧情分支索引：命中 story_index 缓存直接返回；否则由 AI 基于记忆生成 */
  async generateStoryIndex(round: number): Promise<{ content: string; round: number; fromCache: boolean }> {
    const cached = this.mem.db.prepare('SELECT content FROM story_index WHERE round = ?').get(round) as { content: string } | undefined;
    if (cached) return { content: cached.content, round, fromCache: true };

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

    const prompt = `基于以下剧情记忆，生成一份"剧情分支索引"，帮助玩家决定下一步行动。要求：
1. 【当前局势】1-2 句话概括
2. 【未解决伏笔 / 悬念】列出 2-4 个
3. 【建议分支】给出 2-4 个可选行动分支，每行一个，格式 "- 分支名：做法（可能后果）"
只输出索引正文，≤450 字，不用 XML，不加额外层级。

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
    console.log(`[剧情索引] round ${round} AI 生成 ${content.length} 字`);
    return { content, round, fromCache: false };
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
