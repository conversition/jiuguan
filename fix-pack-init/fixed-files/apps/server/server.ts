/**
 * Web API 服务（前后端软件的后端）
 * 聚合 core/memory/prompt/proxy/variable 包，暴露 REST + SSE API：
 *   GET  /api/cards                 → 可用角色卡列表
 *   GET  /api/sessions              → 已有会话（DB 文件，含摘要名）
 *   POST /api/session/new           {card} → SSE：创建会话（阶段进度：card→worldbook→vectorize→ready）
 *   POST /api/session/resume        {db}   → 恢复会话
 *   POST /api/turn                  {session, input, content_mode} → SSE：状态 + 模拟流式正文
 *   GET  /api/session/:id/history   → 会话历史（chat_log）
 * 会话实例进程内 Map + DB 文件持久化。
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, existsSync, readFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatSession } from '../../tools/cli/session.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { PluginRegistry } from '../../packages/plugin/src/registry.ts';
import { DshPluginHost } from '../../packages/plugin/src/dsh-host.ts';
import { listAssets, readAsset, saveUserAsset, deleteUserAsset, deleteWorldbookFile, deleteUserCard, listCards, resolveCard, readCardText, saveAssetBuffer } from '../../packages/core/src/asset-paths.ts';
import { parseWorldBook } from '../../packages/core/src/worldbook.ts';
import { parsePreset } from '../../packages/core/src/preset.ts';
import { parseCharaCard, extractCharaFromPng, pngPayloadToJson, buildCharaPng } from '../../packages/core/src/chara.ts';
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { StoryboardOrchestrator, StoryboardRegistry, DEFAULT_WORKFLOW } from '../../tools/cli/storyboard-orchestrator.ts';
import type { StoryboardResult } from '../../tools/cli/storyboard-orchestrator.ts';
import { VideoPromptGenerator } from '../../tools/cli/video-prompt-generator.ts';
import type { VideoPromptResult } from '../../tools/cli/video-prompt-generator.ts';
import { renderDirectorMarkdown, safeParseStage, PanelsSchemaLenient } from '../../packages/prompt/src/storyboard.ts';
import type { Panel } from '../../packages/prompt/src/storyboard.ts';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider, createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import {
  DiskCache,
  DEFAULT_ASSETS_DIR,
  loadManifest,
  saveManifest,
  mergeAssetIndex,
  downloadOne,
  downloadAll,
  mimeForUrl,
} from '../../packages/assets/src/downloader.ts';
import { buildAssetIndex, countByKind, classifyAsset, entryName, assetId } from '../../packages/assets/src/build-index.ts';
import { analyzeQuality, scanSessionDbs } from '../../tools/cli/quality.ts';
import { readAdaptiveConfig, writeAdaptiveConfig } from '../../packages/prompt/src/adaptive.ts';

const PORT = Number(process.env.JG_WEB_PORT ?? 17800);
const HOST = '127.0.0.1';
const DATA_DIR = resolve('data');
/** 前端日志落盘路径（日志模块 v0.6.1：浏览器批量上报 → 逐行追加） */
const WEB_LOG_PATH = resolve(DATA_DIR, 'web.log');
/** GLA 远端资源缓存目录（全局共享：默认 %TEMP%/jiuguan-assets，与启动目录无关；env JG_ASSETS_DIR 可覆盖） */
const ASSET_DIR = DEFAULT_ASSETS_DIR;

/** 后端兜底脱敏：剥掉 data 里的敏感字段（apiKey/key/token/authorization…），避免 key 落盘 */
function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api_?key|key|token|authorization|auth|secret|password)$/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = stripSensitive(v);
      }
    }
    return out;
  }
  return value;
}

const sessions = new Map<string, ChatSession>();
/** 插件注册表（插件市场：git URL 安装 / 启停 / 卸载 / 更新，数据在 data/plugins） */
const pluginRegistry = new PluginRegistry(resolve('data', 'plugins'));
/**
 * DSH 标准插件宿主（deepseek-harness bundle 接口：package.json+main → ESM {name,inject,apply}）。
 * 宿主直跑模型（真 fs/网络），路由在 /api 之前分发。
 * 凭据解析对齐官方 credentials.resolve（每次调用即席解析，不缓存）：
 *   环境变量优先 → data/provider.json apiKey 兜底（DEEPSEEK_API_KEY / JG_API_KEY 等价复用平台已配 key）。
 */
const dshHost = new DshPluginHost(async (name) => {
  const env = process.env[name];
  if (env) return { value: env, source: 'env' };
  if (name === 'DEEPSEEK_API_KEY' || name === 'JG_API_KEY') {
    try {
      const cfg = loadProviderConfig();
      if (cfg.apiKey) return { value: cfg.apiKey, source: 'provider.json' };
    } catch { /* provider.json 缺失/损坏按未配置处理 */ }
  }
  return null;
});
/** 正则库（前端屏蔽隐藏 + 用户维护，数据在 data/regex-rules.json） */
const regexLibrary = new RegexLibrary();

function json(res: ServerResponse, obj: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
}

/** SSE 初始化 */
function sse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
}
function sseSend(res: ServerResponse, obj: unknown): void {
  // 客户端已断开/响应已结束时不写（中止生成后 res 可能已 close）
  if (res.writableEnded || res.destroyed) return;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ }
}

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c.toString('utf8'); });
    req.on('end', () => { try { resolveBody(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** 模拟流式分块（按标点/换行/60 字切） */
function chunkText(text: string, size = 60): string[] {
  const out: string[] = [];
  const parts = text.split(/(?<=[。！？\n；])/);
  let buf = '';
  for (const p of parts) {
    buf += p;
    if (buf.length >= size || p.includes('\n')) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 读取会话摘要（卡名/最新消息预览/轮次/开始文字/创建时间；HTML 清洗后截断） */
function readSessionMeta(dbPath: string): { card: string; preview: string; round: number; start: string; createdAt: string } {
  try {
    const mem = new MemoryDb({ path: dbPath });
    const meta = mem.db.prepare('SELECT config FROM memory_meta WHERE id = 1').get() as { config: string } | undefined;
    const cfg = meta ? (JSON.parse(meta.config ?? '{}') as { card?: string }) : {};
    // 预览优先取"非开场白的最后一条 assistant"（开场白常含 HTML/CSS 围栏，预览难读）
    const last = (
      mem.db.prepare("SELECT content FROM chat_log WHERE role='assistant' AND round > 0 ORDER BY id DESC LIMIT 1").get()
      ?? mem.db.prepare("SELECT content FROM chat_log WHERE role='assistant' ORDER BY id DESC LIMIT 1").get()
    ) as { content: string } | undefined;
    // 开始文字取首条消息（开场白 round 0）；创建时间优先 chat_log.created_at，缺失时用 DB 文件 mtime 兜底
    const first = mem.db.prepare("SELECT content, created_at FROM chat_log ORDER BY id ASC LIMIT 1").get() as { content: string; created_at?: string } | undefined;
    const r = mem.db.prepare('SELECT COALESCE(MAX(round), 0) AS m FROM chat_log').get() as { m: number };
    mem.db.close();
    const strip = (t: string) => t
      .replace(/```[^\n]*\n?/g, ' ')     // markdown 代码围栏
      .replace(/<[^>]+>/g, ' ')          // HTML 标签
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // CSS/注释
      .replace(/\s+/g, ' ').trim();
    const start = first?.content ? strip(first.content).slice(0, 100) : '';
    const createdAt = first?.created_at
      ?? (() => { try { return statSync(dbPath).mtime.toISOString(); } catch { return ''; } })();
    return { card: cfg.card ?? '', preview: last?.content ? strip(last.content).slice(0, 42) : '', round: r?.m ?? 0, start, createdAt };
  } catch { return { card: '', preview: '', round: 0, start: '', createdAt: '' }; }
}

/** 分镜完成载荷（/api/storyboard/run 与 /api/session/:id/director 共用；含下载用全量 Markdown，探窗展示/下载复用） */
function storyboardDonePayload(
  result: StoryboardResult,
  opts: { sceneName?: string; directorSource?: string } = {},
): Record<string, unknown> {
  return {
    type: 'done',
    passed: result.passed,
    voice: result.directorsRead?.voice ?? '',
    intention: result.directorsRead?.intention ?? '',
    // panels 全字段下发（H3 视频提示词按需转写的回传输入；localhost SSE 载荷无压力）
    panels: result.panels,
    sequence: result.sequence ? {
      master_prompt: result.sequence.master_prompt.slice(0, 400), narrative: result.sequence.narrative.slice(0, 400),
      consistency: result.sequence.consistency.slice(0, 200), sfx: result.sequence.sfx,
    } : null,
    humanized: result.humanized?.summary ?? '',
    validation: result.validation,
    errors: result.errors.slice(0, 12),
    warnings: result.warnings.slice(0, 12),
    markdown: renderDirectorMarkdown({
      sceneName: opts.sceneName,
      directorSource: opts.directorSource,
      voice: result.directorsRead?.voice ?? '',
      intention: result.directorsRead?.intention ?? '',
      panels: result.panels,
      sequence: result.sequence,
      humanized: result.humanized,
      validation: result.validation,
    }),
  };
}

/** H3 视频提示词完成载荷（/api/storyboard/video-prompt 与 /api/session/:id/director/video-prompt 共用） */
function videoPromptDonePayload(result: VideoPromptResult): Record<string, unknown> {
  return {
    type: 'done',
    passed: result.passed,
    speakers: result.speakers,
    prompts: result.prompts,
    validation: result.validation,
    errors: result.errors.slice(0, 12),
    warnings: result.warnings.slice(0, 12),
    markdown: result.markdown,
  };
}

/** 前端回传面板重校验（PanelsSchemaLenient 容错；上限 30 对齐分镜管线） */
function parseVideoPromptPanels(raw: unknown): Panel[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const parsed = safeParseStage(JSON.stringify({ panels: raw }), PanelsSchemaLenient);
  return parsed ? parsed.panels.slice(0, 30) : [];
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // DSH 插件路由优先分发（插件可注册任意路径；命中即响应，不落平台路由）
    if (dshHost.count() > 0 && dshHost.dispatch(req, res, p)) return;

    // 角色卡列表
    if (method === 'GET' && p === '/api/cards') {
      return json(res, { cards: listCards().map((c) => ({ id: c.file, name: c.name, format: c.format, source: c.source })) });
    }

    // 会话列表（data/*.db：卡名标题 + 最新消息预览 + 轮次）
    if (method === 'GET' && p === '/api/sessions') {
      if (!existsSync(DATA_DIR)) return json(res, { sessions: [] });
      const dbs = readdirSync(DATA_DIR).filter((f) => f.endsWith('.db'));
      const list = dbs.map((f) => {
        const dbPath = resolve(DATA_DIR, f);
        const meta = readSessionMeta(dbPath);
        const id = f.replace(/\.db$/, '');
        return { id, file: f, name: meta.card || id, preview: meta.preview, round: meta.round, start: meta.start, createdAt: meta.createdAt };
      });
      return json(res, { sessions: list });
    }

    // ── 前端日志落盘（浏览器上报 → data/web.log 逐行追加；前端已脱敏，后端再兜底 strip）──
    if (method === 'POST' && p === '/api/log') {
      const body = await readBody(req);
      const entries = Array.isArray((body as { entries?: unknown }).entries)
        ? (body as { entries: unknown[] }).entries
        : [body];
      const lines = entries
        .filter((e) => e && typeof e === 'object')
        .map((e) => JSON.stringify({
          ts: (e as { ts?: unknown }).ts ?? '',
          level: (e as { level?: unknown }).level ?? 'info',
          scope: (e as { scope?: unknown }).scope ?? '',
          msg: String((e as { msg?: unknown }).msg ?? ''),
          data: stripSensitive((e as { data?: unknown }).data),
        }));
      if (lines.length > 0) appendFileSync(WEB_LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
      return json(res, { ok: true, count: lines.length });
    }

    // ── 插件市场（04 §4.1 / §7：git 安装 + 启停 + 卸载 + 更新）──
    if (method === 'GET' && p === '/api/plugins') {
      return json(res, { plugins: pluginRegistry.list() });
    }
    if (method === 'POST' && p === '/api/plugins/install') {
      const body = await readBody(req);
      const url = (body.url ?? '').trim();
      if (!url) return json(res, { error: '缺少插件来源（git URL / 本地路径 / .zip）' }, 400);
      try {
        const rec = await pluginRegistry.install(url);
        if (rec.kind === 'dsh') await reloadDshPlugin(rec.id);
        return json(res, { plugin: rec });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }
    if (method === 'POST' && p.startsWith('/api/plugins/')) {
      const id = p.split('/')[3];
      const action = p.split('/')[4] ?? '';
      if (action === 'enable' || action === 'disable') {
        try {
          const rec = pluginRegistry.setEnabled(id, action === 'enable');
          if (rec.kind === 'dsh') await reloadDshPlugin(id);
          return json(res, { plugin: rec });
        }
        catch (e) { return json(res, { error: (e as Error).message }, 404); }
      }
      if (action === 'uninstall') {
        try {
          dshHost.unload(id);
          pluginRegistry.uninstall(id);
          return json(res, { ok: true });
        }
        catch (e) { return json(res, { error: (e as Error).message }, 404); }
      }
      if (action === 'update') {
        try {
          const rec = await pluginRegistry.update(id);
          if (rec.kind === 'dsh') await reloadDshPlugin(id);
          return json(res, { plugin: rec });
        }
        catch (e) { return json(res, { error: (e as Error).message.slice(0, 200) }, 400); }
      }
    }

    // 新会话（SSE：阶段进度；启动流程审查 P0：入参收纳 世界书/预设/预设块勾选）
    if (method === 'POST' && p === '/api/session/new') {
      const body = await readBody(req);
      const cardFile = body.card ?? '';
      const cardRes = resolveCard(cardFile);
      if (!cardFile || !cardRes) {
        return json(res, { error: `角色卡不存在: ${cardFile}` }, 404);
      }
      // 卡片导入会话（PNG 卡由 ChatSession 内部解包，见 tools/cli/session.ts init）
      sse(res);
      const dbName = `session-${Date.now()}.db`;
      const dbPath = resolve(DATA_DIR, dbName);
      const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
      let presetOverrides: Record<string, boolean> | undefined;
      if (body.preset_overrides && typeof body.preset_overrides === 'object') {
        presetOverrides = body.preset_overrides as Record<string, boolean>;
      }
      const session = new ChatSession({
        card: cardRes.path, db: dbPath, resume: false, useBge: true, contentMode: mode,
        worldbooks: Array.isArray(body.worldbooks) ? body.worldbooks.map(String) : undefined,
        preset: typeof body.preset === 'string' && body.preset ? body.preset : undefined,
        presetOverrides,
        style: typeof body.style === 'string' && body.style ? body.style : undefined,
      });
      await session.init((stage) => sseSend(res, { type: 'stage', stage }));
      const id = dbName.replace(/\.db$/, '');
      sessions.set(id, session);
      // DSH 插件会话事件：session/created（对齐官方 core/session Events）
      dshHost.emitSessionCreated({ id, card: session.getCardName(), round: 0 });
      sseSend(res, { type: 'ready', id, greeting: session.getGreeting(), card: session.getCardName(), db: dbName, contentMode: mode, config: session.getSessionConfig() });
      res.end();
      return;
    }

    // 恢复会话
    if (method === 'POST' && p === '/api/session/resume') {
      const body = await readBody(req);
      const dbName = body.db ?? '';
      const dbPath = resolve(DATA_DIR, dbName);
      if (!existsSync(dbPath)) return json(res, { error: '会话不存在' }, 404);
      const id = dbName.replace(/\.db$/, '');
      const session = sessions.get(id) ?? new ChatSession({ db: dbPath, resume: true, useBge: true });
      if (!sessions.has(id)) await session.init();
      sessions.set(id, session);
      return json(res, { id });
    }

    // 单轮对话（SSE：状态 + 模拟流式正文；req 断开 → 中止上游，前端停止按钮）
    if (method === 'POST' && p === '/api/turn') {
      const body = await readBody(req);
      const session = sessions.get(body.session ?? '');
      if (!session) return json(res, { error: '会话不存在，请先创建或恢复' }, 404);
      const input = (body.input ?? '').trim();
      if (!input) return json(res, { error: '输入为空' }, 400);
      // 并发守卫：同一会话回合互斥。幽灵回合未终结时新回合会交错写库（round/记忆错乱）；快速失败并明确提示
      if (session.isBusy()) {
        sse(res);
        sseSend(res, { type: 'error', message: '上一回合仍在生成中，请先停止或等待完成' });
        res.end();
        return;
      }

      sse(res);
      sseSend(res, { type: 'status', stage: 'thinking' });
      const ac = new AbortController();
      // 客户端断开检测必须挂 res 'close'：Node 16+ IncomingMessage(req) 的 'close' 语义变为「请求消息完成」，
      // SSE 场景客户端断开时 req 'close' 不触发 → 停止按钮后端无感知、上游继续生成（历史回归根因）
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClose);
      try {
        const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
        let streamStarted = false;
        // 真流式：session.turn 回调 prose 增量 → 逐字转发 SSE；最终 done 携带完整 prose（前端覆盖兜底）
        const prose = await session.turn(input, mode as 'nsfw' | 'nsf', (chunk) => {
          if (!streamStarted) {
            sseSend(res, { type: 'status', stage: 'streaming' });
            streamStarted = true;
          }
          sseSend(res, { type: 'delta', text: chunk });
        }, ac.signal);
        if (!streamStarted) sseSend(res, { type: 'status', stage: 'streaming' });
        sseSend(res, { type: 'done', prose });
        // DSH 插件会话事件：assistant/message(真实 usage) + turn/end（whale-widget 结算本轮消耗泡泡）
        const usage = session.getLastUsage();
        if (usage) {
          dshHost.emitJiuguanTurn({
            sessionId: body.session, card: session.getCardName(), round: session.getMemory().round,
            model: session.getModelName(), promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
          });
        } else {
          dshHost.emitSessionEvent({ id: body.session, card: session.getCardName() }, { type: 'turn/end', data: {} });
        }
      } catch (e) {
        // 非中止失败：清理本轮孤儿 user 行（模型异常下 runTurnCore 已写 user、无 assistant，会致记忆断裂）
        // 并发被拒（会话忙）是请求级拒绝，绝不能触发孤儿清理——否则会误删在跑回合的 user 行
        if (!ac.signal.aborted) {
          if (!session.isBusy()) session.rollbackFailedTurn();
          sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
        }
      }
      res.off('close', onClose);
      res.end();
      return;
    }

    // 静默生成（ST 生态前端 generateQuietPrompt → rpc ai.generate 的宿主端点）
    // 非 SSE（client.complete 一次性）：复用会话真实窗口+卡设定补全，不落 chat_log/不改记忆
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/quiet')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const prompt = String(body.prompt ?? '').trim();
      if (!prompt) return json(res, { error: '生成提示为空' }, 400);
      try {
        const round = Number(body.round) || 0;
        const mode = body.content_mode === 'nsf' ? 'nsf' : 'nsfw';
        const text = await session.quietGenerate(prompt, { round, mode: mode as 'nsfw' | 'nsf' });
        return json(res, { text });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 重新生成 AI 回复（回滚该轮状态 + 重放，SSE 流式同 /api/turn；req 断开 → 中止上游）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/regenerate')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const round = Number(body.round ?? 0);
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      // 并发守卫（同 /api/turn）：会话忙时快速拒绝
      if (session.isBusy()) {
        sse(res);
        sseSend(res, { type: 'error', message: '上一回合仍在生成中，请先停止或等待完成' });
        res.end();
        return;
      }
      sse(res);
      sseSend(res, { type: 'status', stage: 'thinking' });
      const ac = new AbortController();
      // 同 /api/turn：断开检测挂 res 'close'（req 'close' 在 Node 16+ 不反映客户端断开）
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClose);
      try {
        let streamStarted = false;
        const r = await session.regenerate(round, (chunk) => {
          if (!streamStarted) { sseSend(res, { type: 'status', stage: 'streaming' }); streamStarted = true; }
          sseSend(res, { type: 'delta', text: chunk });
        }, ac.signal);
        if (!streamStarted) sseSend(res, { type: 'status', stage: 'streaming' });
        sseSend(res, {
          type: 'done', prose: r.prose, assistantMsgId: r.assistantMsgId, round: r.round,
          // AQL 循环C：重试 ≥ replanK 时附带重写方向建议（前端「建议卡」；不进对话）
          replanSuggestion: r.replanSuggestion ?? undefined,
        });
        // DSH 插件会话事件：assistant/message + turn/end（重发路径同样结算真实 usage）
        const regenUsage = session.getLastUsage();
        if (regenUsage) {
          dshHost.emitJiuguanTurn({
            sessionId: id, card: session.getCardName(), round: r.round,
            model: session.getModelName(), promptTokens: regenUsage.promptTokens, completionTokens: regenUsage.completionTokens,
          });
        } else {
          dshHost.emitSessionEvent({ id, card: session.getCardName() }, { type: 'turn/end', data: {} });
        }
      } catch (e) {
        if (!ac.signal.aborted) sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.off('close', onClose);
      res.end();
      return;
    }

    // 中止回合落库（前端停止生成后调用，幂等：该轮若已有 assistant 落库则跳过）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/turn/abort')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const round = Number(body.round ?? 0);
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      try {
        // 显式中止进行中回合（双保险：断开检测失效——经代理/事件丢失——时停止仍生效），再等待落库定局
        const aborted = session.abortActiveTurn();
        const r = await session.finalizeAbortedRound(round);
        return json(res, { ok: true, aborted, ...r });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 删除消息（round=整轮 / fromHere=从该轮到末尾；状态按回合账本回滚）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/message/delete')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const round = Number(body.round ?? 0);
      const mode = body.mode === 'fromHere' ? 'fromHere' : 'round';
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      try {
        const r = session.deleteMessages(round, mode);
        return json(res, { ok: true, round: r.round, mode });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 剧情分支索引（AI 生成，按轮缓存；?round=N）
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/story-index')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const urlQ = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const round = Number(urlQ.searchParams.get('round') ?? 0);
      if (!Number.isInteger(round) || round < 0) return json(res, { error: 'round 非法' }, 400);
      try {
        const r = await session.generateStoryIndex(round);
        return json(res, { content: r.content, branches: r.branches ?? [], round: r.round, fromCache: r.fromCache });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }

    // 删除会话（关 DB + 删 data/session-*.db + 移出内存 Map）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/delete')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (session) { try { session.close(); } catch { /* 忽略 */ } }
      sessions.delete(id);
      // DSH 插件会话销毁事件（whale-widget 清理每轮消耗聚合桶）
      dshHost.emitSessionDisposed({ id, card: session?.getCardName() });
      const dbPath = resolve(DATA_DIR, `${id}.db`);
      let removed = false;
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const f = suffix ? `${dbPath}${suffix}` : dbPath;
          if (existsSync(f)) { rmSync(f, { force: true }); removed = true; }
        }
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
      return json(res, { ok: true, removed, id });
    }

    // 会话历史
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/history')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, { messages: session.getHistory() });
    }

    // 会话配置（启动流程审查：世界书/预设/引擎 回显）
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/config')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, { config: session.getSessionConfig() });
    }

    // 记忆控制台：双通道检索调试
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/memory-search')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const query = (body.query ?? '').trim();
      if (!query) return json(res, { error: '查询为空' }, 400);
      const r = session.debugSearch(query);
      return json(res, {
        hits: r.hits.map((h) => ({ code: h.code, category: h.category, source: h.source, score: Number(h.score.toFixed(3)), confidence: h.confidence, content: h.content.slice(0, 80) })),
        layerStats: r.layerStats,
        elapsedMs: r.elapsedMs,
      });
    }

    // 记忆控制台：状态表 + 大纲表 + 元数据
    if (method === 'GET' && p.startsWith('/api/session/') && (p.endsWith('/memory-state') || p.endsWith('/memory-arc') || p.endsWith('/memory-meta'))) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      if (p.endsWith('/memory-state')) return json(res, { states: session.getStateRows() });
      if (p.endsWith('/memory-arc')) return json(res, { arcs: session.getArcRows() });
      return json(res, { meta: session.getMeta() });
    }

    // 世界书激活调试（P2）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/lorebook-scan')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const input = (body.input ?? '').trim();
      if (!input) return json(res, { error: '输入为空' }, 400);
      const r = session.debugScan(input);
      return json(res, {
        activated: r.activated.map((e) => ({ comment: e.comment, matchType: e.matchType, content: e.content.slice(0, 60), constant: e.constant })),
        stats: r.stats,
      });
    }

    // 变量控制台（VMS：声明 + 求值 + 依赖分层）
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/variables')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const v = session.getVariables();
      return json(res, {
        decls: v.decls.map((d) => ({ name: d[0], type: d[1], expr: d[2] })),
        values: v.values,
        layers: v.layers,
        errors: v.errors,
      });
    }

    // 推进槽 / 事件类型 / NSFW 锁定（P2）
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/turn-state')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      return json(res, { state: session.getTurnState() });
    }

    // Provider 配置（非敏感：不含 key）
    if (method === 'GET' && p === '/api/provider') {
      const cfg = (await import('../../packages/proxy/src/config.ts')).loadProviderConfig();
      return json(res, {
        baseUrl: cfg.baseUrl, model: cfg.model, kind: cfg.kind, prefixCacheThreshold: cfg.prefixCacheThreshold,
        hasKey: Boolean(cfg.apiKey), keySource: cfg.keySource, keyFingerprint: cfg.keyFingerprint,
      });
    }

    // Provider 测试连接（校验草稿 baseUrl/key + 拉取模型列表；草稿值不落盘）
    if (method === 'POST' && p === '/api/provider/test') {
      const { loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const overrides = {
        ...(body.baseUrl ? { baseUrl: String(body.baseUrl) } : {}),
        ...(body.apiKey ? { apiKey: String(body.apiKey) } : {}),
        ...(body.model ? { model: String(body.model) } : {}), // 记录历史模型用表单值，避免落回已保存/默认模型
      };
      const cfg = loadProviderConfig(overrides);
      if (!cfg.apiKey) {
        return json(res, { ok: false, error: '缺少 API key：请在下方填入 key 后测试，或在 .env.local 配置 JG_API_KEY' }, 400);
      }
      const client = new OpenAICompatibleClient(cfg);
      try {
        const models = await client.listModels();
        // 测试成功 → 记忆该 URL+模型（best-effort 旁路：写盘失败不拖垮成功响应）
        let history: { baseUrl: string; model: string; lastSuccessAt: string }[] = [];
        try {
          const h = await import('../../packages/proxy/src/history.ts');
          history = h.recordProviderUrl(cfg.baseUrl, cfg.model);
        } catch { /* 历史记忆失败忽略 */ }
        return json(res, { ok: true, models: models.slice(0, 50), count: models.length, baseUrl: cfg.baseUrl, model: cfg.model, history });
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = (e as Error).message.slice(0, 300);
        const where = status ? `HTTP ${status}` : '网络';
        return json(res, { ok: false, error: `连接失败（${where}）：${msg}`, status: status ?? 0 }, status && status >= 400 ? status : 502);
      }
    }

    // Provider 写 key（启动流程审查 P0-2：UI 填写 → data/provider.json 立即热更，不回显）
    if (method === 'POST' && p === '/api/provider/key') {
      const { writeProviderJson, loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const apiKey = (body.apiKey ?? '').toString().trim();
      if (!apiKey) return json(res, { error: 'API key 为空' }, 400);
      writeProviderJson({ apiKey });
      const cfg = loadProviderConfig();
      // 热更：所有已建会话立即重建 client（新 key 即时生效，无需重启/新建会话；否则旧会话仍绑旧 client）
      for (const s of sessions.values()) {
        try { s.rebindProvider(cfg); } catch { /* 单个会话热更失败不阻塞 */ }
      }
      return json(res, { ok: true, hasKey: Boolean(cfg.apiKey), baseUrl: cfg.baseUrl, model: cfg.model, keyFingerprint: cfg.keyFingerprint });
    }

    // Provider 统一保存（baseUrl / model / key → data/provider.json 立即热更会话；key 不回显）
    if (method === 'POST' && p === '/api/provider/save') {
      const { writeProviderJson, loadProviderConfig } = await import('../../packages/proxy/src/config.ts');
      const body = await readBody(req);
      const partial: Record<string, unknown> = {};
      if (body.baseUrl) partial.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
      if (body.model) partial.model = String(body.model).trim();
      if (body.apiKey) partial.apiKey = String(body.apiKey).trim();
      if (body.kind === 'anthropic' || body.kind === 'openai') partial.kind = body.kind;
      if (body.prefixCacheThreshold) partial.prefixCacheThreshold = Number(body.prefixCacheThreshold);
      if (Object.keys(partial).length === 0) {
        return json(res, { error: '无可保存的配置（Base URL / 模型 / API key 至少填一项）' }, 400);
      }
      writeProviderJson(partial);
      const cfg = loadProviderConfig();
      for (const s of sessions.values()) {
        try { s.rebindProvider(cfg); } catch { /* 单个会话热更失败不阻塞 */ }
      }
      return json(res, {
        ok: true,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        kind: cfg.kind,
        hasKey: Boolean(cfg.apiKey),
        keySource: cfg.keySource,
        keyFingerprint: cfg.keyFingerprint,
        prefixCacheThreshold: cfg.prefixCacheThreshold,
      });
    }

    // Provider 历史 URL（测试成功自动记录，不含 key）—— 面板下拉快速切换
    if (method === 'GET' && p === '/api/provider/history') {
      const { readProviderHistory } = await import('../../packages/proxy/src/history.ts');
      return json(res, { ok: true, history: readProviderHistory() });
    }

    // Provider 历史删除（POST 兼容 CORS：json() 只放行 GET/POST/OPTIONS；body: {baseUrl} | {all:true}）
    if (method === 'POST' && p === '/api/provider/history/delete') {
      const { readProviderHistory, removeProviderUrl, writeProviderHistory } = await import('../../packages/proxy/src/history.ts');
      const body = await readBody(req);
      if ((body as { all?: unknown }).all === true) {
        writeProviderHistory([]);
        return json(res, { ok: true, history: [] });
      }
      const baseUrl = String(body.baseUrl ?? '').trim();
      if (!baseUrl) return json(res, { error: '缺少要删除的 Base URL（或传 all:true 清空）' }, 400);
      return json(res, { ok: true, history: removeProviderUrl(baseUrl) });
    }

    // ── GLA 远端资源（扫描 / 预载 / 出图；全局缓存 %TEMP%/jiuguan-assets，惰性下载 + 手动预载） ──

    if (method === 'GET' && p === '/api/assets/status') {
      const m = loadManifest(ASSET_DIR);
      const cache = new DiskCache(ASSET_DIR);
      const entries = m.entries.map((e) => ({ id: e.id, url: e.url, kind: e.kind, name: e.name, cached: e.cached, bytes: e.bytes, failed: e.failed, sourceCard: e.sourceCard }));
      return json(res, {
        ok: true,
        total: m.entries.length,
        cachedCount: m.entries.filter((e) => e.cached).length,
        failedCount: m.entries.filter((e) => e.failed).length,
        diskBytes: cache.diskBytes(),
        scannedAt: m.scannedAt,
        byKind: countByKind(m.entries),
        entries,
      });
    }

    // 扫描角色卡 → 建资产索引并入 manifest（不下载）
    if (method === 'POST' && p === '/api/assets/scan') {
      const body = await readBody(req);
      const card = String(body.card ?? '').trim();
      if (!card) return json(res, { error: '缺少 card 参数' }, 400);
      const ct = readCardText(card);
      if (!ct) return json(res, { error: '角色卡不存在' }, 404);
      const m = loadManifest(ASSET_DIR);
      const entries = buildAssetIndex(ct.raw, card);
      const { added } = mergeAssetIndex(m, entries);
      saveManifest(m, ASSET_DIR);
      return json(res, { ok: true, added, total: m.entries.length, counts: countByKind(m.entries), cachedCount: m.entries.filter((e) => e.cached).length });
    }

    // 预载全部资源（SSE 进度；失败逐条记录，允许重试）
    if (method === 'POST' && p === '/api/assets/preload') {
      const body = await readBody(req);
      const card = String(body.card ?? '').trim();
      sse(res);
      const abortMsg = (message: string): void => { sseSend(res, { type: 'error', message }); res.end(); };
      const ct = card ? readCardText(card) : null;
      if (!ct) return abortMsg('角色卡不存在');
      const m = loadManifest(ASSET_DIR);
      const entries = buildAssetIndex(ct.raw, card);
      mergeAssetIndex(m, entries);
      const cache = new DiskCache(ASSET_DIR);
      // 待下载 = 磁盘尚无缓存文件者（含此前 failed 的重试）；已缓存即跳过（幂等）
      const pending = m.entries.filter((e) => !cache.has(e.id)).map((e) => e.url);
      if (pending.length === 0) {
        saveManifest(m, ASSET_DIR);
        sseSend(res, { type: 'done', done: 0, total: 0, failed: [], downloadedBytes: 0 });
        return res.end();
      }
      let downloadedBytes = 0;
      const byUrl = new Map(m.entries.map((e) => [e.url, e]));
      const onProgress = (ev: { url: string; ok: boolean; bytes?: number; error?: string; done: number; total: number }): void => {
        const entry = byUrl.get(ev.url);
        if (entry) {
          entry.cached = ev.ok;
          entry.failed = ev.ok ? undefined : (ev.error ?? 'download failed');
          if (ev.ok && ev.bytes) { entry.bytes = ev.bytes; downloadedBytes += ev.bytes; }
        }
        sseSend(res, { type: 'progress', done: ev.done, total: ev.total, url: ev.url.slice(0, 140), ok: ev.ok, error: ev.error, kind: entry?.kind, name: entry?.name });
      };
      const { failed } = await downloadAll(pending, cache, onProgress, 4, 30000);
      saveManifest(m, ASSET_DIR);
      sseSend(res, { type: 'done', done: pending.length - failed.length, total: pending.length, failed, downloadedBytes });
      res.end();
    }

    // 取资源（惰性下载→缓存→同源出图；浏览器 <img>/<audio> 直接用本地 URL，免 CDN CORS）
    if (method === 'GET' && p === '/api/assets/img') {
      const rawUrl = url.searchParams.get('url');
      if (!rawUrl) return json(res, { error: '缺少 url 参数' }, 400);
      const cache = new DiskCache(ASSET_DIR);
      const m = loadManifest(ASSET_DIR);
      const u = rawUrl.trim();
      const entry = m.entries.find((e) => e.url === u);
      const id = entry?.id ?? assetId(u);
      let buf = cache.get(id);
      if (!buf) {
        const r = await downloadOne(u, cache, 30000);
        if (!r.ok) return json(res, { error: `资源获取失败：${r.error ?? '未知'}`, url: u.slice(0, 160) }, 502);
        buf = cache.get(id) ?? null;
        if (buf) {
          // 惰性新发现的资源也回写 manifest（后续状态/预载可见）
          if (entry) { entry.cached = true; entry.failed = undefined; entry.bytes = buf.length; }
          else { m.entries.push({ id, url: u, kind: classifyAsset(u), name: entryName(u), cached: true, bytes: buf.length, addedAt: new Date().toISOString() }); }
          m.scannedAt = new Date().toISOString();
          saveManifest(m, ASSET_DIR);
        }
      }
      if (!buf) return json(res, { error: '资源为空' }, 502);
      res.writeHead(200, {
        'Content-Type': mimeForUrl(u),
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end(buf);
      return;
    }

    // 清空资源缓存（仅物理删除 + 重置 cached 状态，保留索引）
    if (method === 'POST' && p === '/api/assets/cache/clear') {
      const m = loadManifest(ASSET_DIR);
      const cache = new DiskCache(ASSET_DIR);
      const removed = cache.clear();
      for (const e of m.entries) { e.cached = false; e.bytes = undefined; e.failed = undefined; }
      saveManifest(m, ASSET_DIR);
      return json(res, { ok: true, removed });
    }

    // 服务端代理抓取外部前端页文本（如卡自带 amakano3/index.html；浏览器 fetch 跨域受限，由服务器侧解决 CORS）
    if (method === 'POST' && p === '/api/assets/page') {
      const body = await readBody(req);
      const pageUrl = String(body.url ?? '').trim();
      if (!/^https?:\/\//.test(pageUrl)) return json(res, { error: 'url 必须为 http(s)' }, 400);
      try {
        const resp = await fetch(pageUrl, { headers: { 'User-Agent': 'jiuguan-assets/1' }, signal: AbortSignal.timeout(20000) });
        if (!resp.ok) return json(res, { error: `HTTP ${resp.status}` }, 502);
        const html = await resp.text();
        if (html.length > 2_000_000) return json(res, { error: '页面过大（>2MB）' }, 400);
        return json(res, { ok: true, url: pageUrl, html: html.slice(0, 2_000_000) });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 502);
      }
    }

    // ── P3 资产工具 ──

    // 正则调试器：测试 findRegex 对输入文本的匹配/替换（P3）
    if (method === 'POST' && p === '/api/regex/test') {
      const body = await readBody(req);
      const pattern = (body.findRegex ?? '').trim();
      const text = body.text ?? '';
      if (!pattern) return json(res, { error: '正则为空' }, 400);
      let re: RegExp;
      try {
        // 支持 /pattern/flags 与纯 pattern 两种格式
        const m = pattern.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
        re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'g');
      } catch (e) {
        return json(res, { error: `正则非法: ${(e as Error).message.slice(0, 60)}` }, 400);
      }
      const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
      const gRe = new RegExp(re.source, flags);
      const matches: { index: number; text: string }[] = [];
      let m2: RegExpExecArray | null;
      let count = 0;
      while ((m2 = gRe.exec(text)) !== null && count < 100) {
        matches.push({ index: m2.index, text: m2[0].slice(0, 60) });
        count++;
        if (m2.index === gRe.lastIndex) gRe.lastIndex++;
      }
      const replaceString = body.replaceString ?? '';
      const replaced = replaceString ? text.replace(new RegExp(re.source, flags.includes('g') ? flags : `${flags}g`), replaceString) : undefined;
      return json(res, { matches, count, replaced: replaced !== undefined ? replaced.slice(0, 2000) : undefined });
    }

    // ── 正则库（前端屏蔽隐藏 + 用户维护）──
    // 规则列表（builtin + user + card 合并）
    if (method === 'GET' && p === '/api/regex-rules') {
      return json(res, { rules: regexLibrary.list() });
    }

    // 保存/更新规则（builtin 可覆盖启用状态）
    if (method === 'POST' && p === '/api/regex-rules/save') {
      const body = await readBody(req);
      const rule = body.rule as unknown as Record<string, unknown>;
      if (!rule || typeof rule.id !== 'string' || typeof rule.findRegex !== 'string') {
        return json(res, { error: '规则缺少 id/findRegex' }, 400);
      }
      const saved = regexLibrary.save({
        id: rule.id,
        name: String(rule.name ?? rule.id),
        findRegex: rule.findRegex,
        replaceString: String(rule.replaceString ?? ''),
        enabled: rule.enabled !== false,
        scope: (rule.scope === 'prompt' || rule.scope === 'both' ? rule.scope : 'display') as 'display' | 'prompt' | 'both',
        source: 'user',
        inject: rule.inject === true,
        note: typeof rule.note === 'string' ? rule.note : undefined,
        order: Number(rule.order ?? 999),
      });
      return json(res, { rule: saved });
    }

    // 删除用户/卡片规则
    if (method === 'POST' && p === '/api/regex-rules/delete') {
      const body = await readBody(req);
      const id = (body.id ?? '').toString();
      const removed = id ? regexLibrary.remove(id) : false;
      return json(res, { ok: true, removed, id });
    }

    // 从角色卡智能导入正则脚本
    if (method === 'POST' && p === '/api/regex-rules/import-card') {
      const body = await readBody(req);
      const cardFile = (body.card ?? '').toString();
      const cardRes = resolveCard(cardFile);
      if (!cardFile || !cardRes) {
        return json(res, { error: `角色卡不存在: ${cardFile}` }, 404);
      }
      const parsed = parseCharaCard(readCardText(cardFile)?.raw ?? '');
      const result = regexLibrary.importFromCard(parsed.regexScripts);
      return json(res, { ok: true, ...result, total: regexLibrary.list().length });
    }

    // ── 资产导入/导出（前端可视化；JSON 原文 / 卡片 PNG base64，无 multipart 依赖）──
    // 导入大小上限：PNG 角色卡常 >10MB（base64 再 ×4/3），5MB 会误伤真实卡；64MB 覆盖绝大多数
    const MAX_IMPORT = 64 * 1024 * 1024;

    // 角色卡导入（JSON 或 PNG；PNG 自动解包 chara 元数据，强校验后写用户层 data/cards/）
    if (method === 'POST' && p === '/api/card/import') {
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const format = body.format === 'png' ? 'png' : 'json';
      const data = (body.data ?? '').toString();
      if (!filename) return json(res, { error: '缺少文件名' }, 400);
      if (!data || data.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      const name = filename.replace(/\.(json|png)$/i, '');
      if (!name) return json(res, { error: '文件名非法' }, 400);
      let cardJson: string;
      let pngBuf: Buffer | null = null;
      if (format === 'png') {
        pngBuf = Buffer.from(data, 'base64');
        const payload = extractCharaFromPng(pngBuf);
        if (!payload) return json(res, { error: 'PNG 卡无 chara 元数据' }, 400);
        cardJson = pngPayloadToJson(payload);
      } else {
        cardJson = data;
      }
      let parsedCard: ReturnType<typeof parseCharaCard>;
      try {
        parsedCard = parseCharaCard(cardJson);
      } catch (e) {
        return json(res, { error: `角色卡校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const jsonFile = `${name}.json`;
      saveUserAsset('card', jsonFile, cardJson);
      if (pngBuf) saveAssetBuffer('card', `${name}.png`, pngBuf);
      // 内嵌世界书检测：供前端弹窗确认是否单独导入世界书库（区分卡与内嵌世界书分别记录）
      const wbEntries = parsedCard.worldbookEntries;
      return json(res, {
        ok: true, file: jsonFile, name, format: 'json', pngSaved: Boolean(pngBuf),
        embeddedWorldbook: wbEntries.length > 0
          ? { count: wbEntries.length, name: parsedCard.card.data.character_book?.name ?? '' }
          : null,
      });
    }

    // 卡片内嵌世界书 → 独立世界书资产（导入卡片后前端弹窗确认调用；同名用户层覆盖=幂等）
    if (method === 'POST' && p === '/api/card/import-worldbook') {
      const body = await readBody(req);
      const file = (body.file ?? '').toString().trim();
      if (!/\.json$/i.test(file)) return json(res, { error: '需指定已导入的角色卡 JSON 文件' }, 400);
      let raw: string;
      try {
        const card = readCardText(file);
        if (!card) return json(res, { error: '角色卡不存在' }, 404);
        raw = card.raw;
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
      let parsed: ReturnType<typeof parseCharaCard>;
      try {
        parsed = parseCharaCard(raw);
      } catch (e) {
        return json(res, { error: `角色卡解析失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      const wbEntries = parsed.worldbookEntries;
      if (wbEntries.length === 0) return json(res, { error: '该角色卡未携带内嵌世界书' }, 400);
      const base = file.replace(/\.json$/i, '');
      const wbName = parsed.card.data.character_book?.name || `${base}-世界书`;
      const wbFile = `${base.replace(/[\\/:*?"<>|]/g, '_')}-世界书.json`;
      let overwritten = false;
      try {
        parseWorldBook(JSON.stringify({ name: wbName, entries: wbEntries }, null, 2)); // 强校验后再落盘
        const existing = readAsset('worldbook', wbFile);
        overwritten = existing?.source === 'user';
        saveUserAsset('worldbook', wbFile, JSON.stringify({ name: wbName, entries: wbEntries }, null, 2));
      } catch (e) {
        return json(res, { error: `世界书生成失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      return json(res, { ok: true, file: wbFile, name: wbName, count: wbEntries.length, overwritten });
    }

    // 角色卡删除（仅用户层副本；PNG 卡 .json+.png 同基名一并删除，源资产只读不删）
    if (method === 'POST' && p === '/api/card/delete') {
      const body = await readBody(req);
      const file = (body.file ?? '').toString().trim();
      const removed = file ? deleteUserCard(file) : false;
      return json(res, { ok: true, removed, file });
    }

    // 角色卡原文导出（JSON / PNG → 角色卡 JSON 文本）
    if (method === 'GET' && p.startsWith('/api/card/') && p.endsWith('/raw')) {
      const file = decodeURIComponent(p.slice('/api/card/'.length, -'/raw'.length));
      try {
        const card = readCardText(file);
        if (!card) return json(res, { error: '角色卡不存在' }, 404);
        return json(res, { raw: card.raw, format: card.format, file });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
    }

    // 角色卡导出为酒馆兼容 PNG（PNG 卡直接用原件；JSON 卡动态封装 chara tEXt）
    if (method === 'GET' && p.startsWith('/api/card/') && p.endsWith('/png')) {
      const file = decodeURIComponent(p.slice('/api/card/'.length, -'/png'.length));
      try {
        const src = resolveCard(file);
        if (!src) return json(res, { error: '角色卡不存在' }, 404);
        const buf = src.format === 'png'
          ? readFileSync(src.path)
          : buildCharaPng(readCardText(file)?.raw ?? '');
        if (!buf || buf.length === 0) return json(res, { error: '角色卡读取失败' }, 404);
        return json(res, {
          data_b64: buf.toString('base64'),
          file,
          pngFile: src.format === 'png' ? (src.path.split(/[\\/]/).pop() ?? '') : `${file.replace(/\.json$/i, '')}.png`,
        });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 120) }, 400);
      }
    }

    // 预设导入（校验 parsePreset 后写用户层）
    if (method === 'POST' && p === '/api/preset/import') {
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const raw = (body.raw ?? '').toString();
      if (!/\.json$/i.test(filename)) return json(res, { error: '文件名需 .json' }, 400);
      if (!raw || raw.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      try {
        parsePreset(raw, {});
      } catch (e) {
        return json(res, { error: `预设校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      saveUserAsset('preset', filename, raw);
      return json(res, { ok: true, file: filename });
    }

    // 预设原文导出
    if (method === 'GET' && p.startsWith('/api/preset/') && p.endsWith('/raw')) {
      const file = decodeURIComponent(p.slice('/api/preset/'.length, -'/raw'.length));
      const asset = readAsset('preset', file);
      if (!asset) return json(res, { error: '预设不存在' }, 404);
      return json(res, { raw: asset.raw, file, source: asset.source });
    }

    // 世界书导入（校验 parseWorldBook 后写用户层）
    if (method === 'POST' && p === '/api/worldbook/import') {
      const body = await readBody(req);
      const filename = (body.filename ?? '').toString().trim();
      const raw = (body.raw ?? '').toString();
      if (!/\.json$/i.test(filename)) return json(res, { error: '文件名需 .json' }, 400);
      if (!raw || raw.length > MAX_IMPORT) return json(res, { error: '文件过大或为空' }, 400);
      try {
        parseWorldBook(raw);
      } catch (e) {
        return json(res, { error: `世界书校验失败: ${(e as Error).message.slice(0, 120)}` }, 400);
      }
      saveUserAsset('worldbook', filename, raw);
      return json(res, { ok: true, file: filename });
    }

    // 世界书原文导出
    if (method === 'GET' && p.startsWith('/api/worldbook/') && p.endsWith('/raw')) {
      const file = decodeURIComponent(p.slice('/api/worldbook/'.length, -'/raw'.length));
      const asset = readAsset('worldbook', file);
      if (!asset) return json(res, { error: '世界书不存在' }, 404);
      return json(res, { raw: asset.raw, file, source: asset.source });
    }

    // ── 资产编辑器（P2 非只读：用户层 data/{presets,worldbooks} 优先于源）──
    // 预设列表（用户层 + 源，source 标记）
    if (method === 'GET' && p === '/api/presets') {
      return json(res, { presets: listAssets('preset').map((a) => ({ id: a.file, name: a.name, source: a.source })) });
    }

    // 预设内容（prompt 块，含全文 content 供编辑器）
    if (method === 'GET' && p.startsWith('/api/preset/')) {
      const file = decodeURIComponent(p.slice('/api/preset/'.length));
      const asset = readAsset('preset', file);
      if (!asset) return json(res, { error: '预设不存在' }, 404);
      const raw = JSON.parse(asset.raw) as { prompts?: { role?: string; name?: string; enabled?: boolean; content?: string }[]; name?: string };
      const prompts = (raw.prompts ?? []).map((pr, i) => ({
        index: i,
        role: pr.role ?? 'user',
        name: pr.name ?? '',
        enabled: pr.enabled !== false,
        content: pr.content ?? '',
        contentLen: (pr.content ?? '').length,
        preview: (pr.content ?? '').replace(/\s+/g, ' ').slice(0, 60),
      }));
      return json(res, { name: raw.name ?? file.replace(/\.json$/, ''), promptCount: prompts.length, prompts, source: asset.source });
    }

    // 预设保存（写用户层 data/presets/<file>；重名=另存为）
    if (method === 'POST' && p === '/api/preset/save') {
      const body = await readBody(req);
      const file = (body.file ?? '').trim();
      const prompts = Array.isArray(body.prompts) ? body.prompts as { role?: string; name?: string; enabled?: boolean; content?: string }[] : [];
      if (!file) return json(res, { error: '缺少文件名' }, 400);
      if (prompts.some((x) => typeof x.content !== 'string')) return json(res, { error: 'prompts 缺少 content' }, 400);
      const payload = JSON.stringify({ name: body.name ?? file.replace(/\.json$/, ''), prompts }, null, 2);
      const path = saveUserAsset('preset', file, payload);
      return json(res, { ok: true, file, path: path.replace(process.cwd(), '.'), source: 'user', promptCount: prompts.length });
    }

    // 预设删除（仅用户层副本，恢复源）
    if (method === 'POST' && p === '/api/preset/delete') {
      const body = await readBody(req);
      const file = (body.file ?? '').trim();
      const removed = file ? deleteUserAsset('preset', file) : false;
      return json(res, { ok: true, removed, file });
    }

    // 世界书列表（用户层 + 源）
    if (method === 'GET' && p === '/api/worldbooks') {
      return json(res, { worldbooks: listAssets('worldbook').map((a) => ({ id: a.file, name: a.name, source: a.source })) });
    }

    // 世界书全量条目（编辑器）
    if (method === 'GET' && p.startsWith('/api/worldbook/')) {
      const file = decodeURIComponent(p.slice('/api/worldbook/'.length));
      const asset = readAsset('worldbook', file);
      if (!asset) return json(res, { error: '世界书不存在' }, 404);
      const wb = parseWorldBook(asset.raw);
      return json(res, {
        file, name: file.replace(/\.json$/, ''), source: asset.source,
        entries: wb.entries.map((e) => ({
          uid: String(e.uid ?? ''),
          key: e.key ?? [],
          comment: e.comment ?? '',
          content: e.content ?? '',
          constant: Boolean(e.constant),
          selective: Boolean(e.selective),
          use_regex: Boolean(e.use_regex),
          triggers: e.triggers ?? [],
          probability: Number(e.extensions?.probability ?? e.probability ?? 100),
          useProbability: Boolean(e.extensions?.useProbability ?? e.useProbability ?? false),
          active: !e.disable,
          depth: e.depth ?? 0,
        })),
      });
    }

    // 世界书保存（写用户层 data/worldbooks/<file>，ST v1.12 entries 格式）
    if (method === 'POST' && p === '/api/worldbook/save') {
      const body = await readBody(req);
      const file = (body.file ?? '').trim();
      const entries = Array.isArray(body.entries) ? body.entries as Record<string, unknown>[] : [];
      if (!file) return json(res, { error: '缺少文件名' }, 400);
      const record: Record<string, unknown> = {};
      for (const e of entries) {
        const uid = String(e.uid ?? `e${Object.keys(record).length + 1}`);
        const { uid: _uid, ...rest } = e;
        record[uid] = { ...rest, uid: Number(uid) || uid };
      }
      const payload = JSON.stringify({ entries: record }, null, 2);
      const path = saveUserAsset('worldbook', file, payload);
      return json(res, { ok: true, file, path: path.replace(process.cwd(), '.'), source: 'user', count: entries.length });
    }

    // 世界书删除（仅用户层副本）
    if (method === 'POST' && p === '/api/worldbook/delete') {
      const body = await readBody(req);
      const file = (body.file ?? '').trim();
      // force=新建会话列表的全量删除（两层兜底）；不带 force=EditorPanel「恢复源文件」，只删用户层副本
      const result = body.force === true
        ? deleteWorldbookFile(file)
        : { removed: file ? deleteUserAsset('worldbook', file) : false, layer: 'user' as const };
      return json(res, { ok: true, removed: result.removed, layer: result.layer, file });
    }

    // 会话内世界书条目浏览（lorebook_entry）
    if (method === 'GET' && p.startsWith('/api/session/') && p.endsWith('/lorebook-entries')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const mem = (session as unknown as { getMemory(): { mem: { db: import('node:sqlite').DatabaseSync } } }).getMemory().mem.db;
      const rows = mem.prepare('SELECT id, book, comment, key, content, use_regex, probability, active FROM lorebook_entry ORDER BY id LIMIT 300').all() as {
        id: number; book: string; comment: string; key: string; content: string; use_regex: number; probability: number; active: number;
      }[];
      return json(res, {
        entries: rows.map((r) => ({
          id: r.id, book: r.book, comment: r.comment, key: r.key, useRegex: r.use_regex === 1,
          probability: r.probability, active: r.active === 1, preview: r.content.replace(/\s+/g, ' ').slice(0, 60),
        })),
        count: rows.length,
      });
    }

    // ── Skill 系统（公共格式 data/skills/<name>/SKILL.md）──
    if (method === 'GET' && p === '/api/skills') {
      const { listSkills } = await import('../../packages/core/src/skills.ts');
      return json(res, { skills: listSkills() });
    }
    if (method === 'POST' && p === '/api/skills/match') {
      const { matchSkills } = await import('../../packages/core/src/skills.ts');
      const body = await readBody(req);
      const query = String(body.query ?? '').trim();
      if (!query) return json(res, { matched: [] });
      return json(res, { matched: matchSkills(query).map((m) => ({ name: m.skill.name, score: Number(m.score.toFixed(3)), body: m.body.slice(0, 200) })) });
    }
    if (method === 'POST' && p === '/api/skills/add') {
      const { addSkill } = await import('../../packages/core/src/skills.ts');
      const body = await readBody(req);
      const name = String(body.name ?? '').trim();
      const description = String(body.description ?? '').trim();
      const content = String(body.content ?? '').trim();
      const keywords = Array.isArray(body.keywords)
        ? (body.keywords as string[]).map((s) => String(s).trim()).filter(Boolean)
        : String(body.keywords ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!name || !content) return json(res, { error: '技能名与指令正文不能为空' }, 400);
      try {
        const skill = addSkill({ name, description, content, keywords });
        return json(res, { ok: true, skill: { name: skill.name, description: skill.description, keywords: skill.keywords, enabled: skill.enabled } });
      } catch (e) {
        return json(res, { error: (e as Error).message }, 400);
      }
    }
    if (method === 'POST' && p === '/api/skills/import-style') {
      // 文风库 → 文风 skill（幂等；源内容不变则跳过）
      const { importStyleBooks } = await import('../../tools/cli/import-style.ts');
      try {
        const r = importStyleBooks();
        return json(res, { ok: true, created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, total: r.total });
      } catch (e) {
        return json(res, { error: `文风库导入失败: ${(e as Error).message}` }, 400);
      }
    }
    if (method === 'POST' && p.startsWith('/api/skills/')) {
      const { setSkillEnabled, deleteSkill } = await import('../../packages/core/src/skills.ts');
      const name = decodeURIComponent(p.split('/')[3]);
      const action = p.split('/')[4] ?? '';
      try {
        if (action === 'enable') return json(res, { ok: true, skill: setSkillEnabled(name, true) });
        if (action === 'disable') return json(res, { ok: true, skill: setSkillEnabled(name, false) });
        if (action === 'delete') { deleteSkill(name); return json(res, { ok: true }); }
        return json(res, { error: `未知操作: ${action}` }, 400);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 404);
      }
    }

    // ── 导演分镜（第三个创作选项，Commit B 前端入口）──
    // 工作流列表 + 默认导演之声池
    if (method === 'GET' && p === '/api/storyboard/workflows') {
      try {
        const registry = new StoryboardRegistry();
        const workflows = registry.list();
        const voices = workflows.includes(DEFAULT_WORKFLOW) ? registry.get(DEFAULT_WORKFLOW).voices : [];
        return json(res, { workflows, defaultWorkflow: DEFAULT_WORKFLOW, voices });
      } catch (e) {
        return json(res, { error: `工作流注册表不可用: ${(e as Error).message.slice(0, 120)}` }, 500);
      }
    }

    // 执行分镜（SSE：stage 阶段进度 → done 结果摘要）
    if (method === 'POST' && p === '/api/storyboard/run') {
      const body = await readBody(req);
      const scene = (body.scene ?? '').toString().trim();
      if (!scene) return json(res, { error: '场景描述为空' }, 400);
      sse(res);
      try {
        const cfg = (await import('../../packages/proxy/src/config.ts')).loadProviderConfig();
        (await import('../../packages/proxy/src/config.ts')).assertProviderReady(cfg);
        const mem = new MemoryDb({ path: resolve(DATA_DIR, `storyboard-${Date.now()}.db`) });
        const ret = new RetrievalEngine(mem);
        try {
          ret.setEmbeddingProvider(await createEmbeddingProvider(true));
        } catch {
          ret.setEmbeddingProvider(new HashEmbeddingProvider());
        }
        const orch = new StoryboardOrchestrator({
          client: new OpenAICompatibleClient(cfg),
          ret,
          scanner: new LorebookScanner(mem),
          vms: new VariableManager(),
          mem,
          cardName: '导演分镜',
          round: 1,
        });
        const result = await orch.run(
          scene,
          {
            mode: body.mode === 'shot' ? 'shot' : 'batch',
            shotCount: Math.min(30, Math.max(1, Number(body.shots ?? 3))),
            workflow: typeof body.workflow === 'string' && body.workflow ? body.workflow : undefined,
            voice: typeof body.voice === 'string' && body.voice ? body.voice : undefined,
          },
          (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }),
        );
        sseSend(res, storyboardDonePayload(result, { sceneName: `分镜「${scene.slice(0, 20)}」` }));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // ── 导演模式（对话内选区触发：选中文本 → 复用会话真实记忆/世界书/变量跑分镜管线，SSE 阶段进度 + done）
    // 与 /api/storyboard/run 同引擎，但上下文来自本会话（非空库）；结果落 memory_state(storyboard) 可检索 + 探窗展示/下载
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/director')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const selectedText = (body.selectedText ?? '').toString().trim();
      if (!selectedText) return json(res, { error: '选中文本为空' }, 400);
      sse(res);
      try {
        const result = await session.directorRun({
          selectedText,
          round: Number(body.round) || undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
          messageId: Number(body.messageId) || undefined,
          shots: Number(body.shots) || undefined,
          voice: typeof body.voice === 'string' && body.voice ? body.voice : undefined,
          workflow: typeof body.workflow === 'string' && body.workflow ? body.workflow : undefined,
        }, (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }));
        sseSend(res, storyboardDonePayload(result, {
          sceneName: `导演分镜「${selectedText.slice(0, 10)}…」`,
          directorSource: selectedText.slice(0, 120),
        }));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // ── H3 视频提示词（分镜完成后按需旁路：会话模式走会话上下文提取对白，独立页走场景描述；panels 由前端回传）──
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/director/video-prompt')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const panels = parseVideoPromptPanels(body.panels);
      if (!panels.length) return json(res, { error: 'panels 为空或非法' }, 400);
      sse(res);
      try {
        const result = await session.videoPromptRun({
          panels,
          sequenceSfx: typeof body.sequenceSfx === 'string' ? body.sequenceSfx : undefined,
          selectedText: typeof body.selectedText === 'string' ? body.selectedText : undefined,
          round: Number(body.round) || undefined,
        }, (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }));
        sseSend(res, videoPromptDonePayload(result));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // 独立页模式（无会话上下文：scene 作对白提取源；一次性客户端不落库）
    if (method === 'POST' && p === '/api/storyboard/video-prompt') {
      const body = await readBody(req);
      const panels = parseVideoPromptPanels(body.panels);
      if (!panels.length) return json(res, { error: 'panels 为空或非法' }, 400);
      const scene = (body.scene ?? '').toString().trim();
      if (!scene) return json(res, { error: '场景描述为空' }, 400);
      sse(res);
      try {
        const cfg = loadProviderConfig();
        assertProviderReady(cfg);
        const gen = new VideoPromptGenerator({ client: new OpenAICompatibleClient(cfg), cardName: '导演分镜', round: 1 });
        const result = await gen.run(panels, { sequenceSfx: typeof body.sequenceSfx === 'string' ? body.sequenceSfx : undefined, dialogueSource: scene },
          (label, detail) => sseSend(res, { type: 'stage', label, detail: detail ?? '' }));
        sseSend(res, videoPromptDonePayload(result));
      } catch (e) {
        sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      res.end();
      return;
    }

    // AQL 质量报表（半自动闭环：遥测归因 + 改进建议；只读）
    if (method === 'GET' && p === '/api/quality/report') {
      const files = scanSessionDbs(DATA_DIR);
      const reports = files
        .map((f) => {
          try { return analyzeQuality(f); } catch { return null; }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.rounds > 0);
      return json(res, { reports, minSample: Number(process.env.JG_QUALITY_MIN_SAMPLE ?? 5) });
    }

    // AQL 自适应覆盖：读 / 写 adaptive-config（半自动；POST 后对全部活动会话 refreshAdaptive 即时生效，可回滚）
    if (p === '/api/quality/overrides') {
      if (method === 'GET') return json(res, { config: readAdaptiveConfig() });
      if (method === 'POST') {
        const body = await readBody(req) as Record<string, unknown>;
        if (body.reset === true) {
          writeAdaptiveConfig({});
        } else {
          const cfg = readAdaptiveConfig();
          const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>;
          const next: Parameters<typeof writeAdaptiveConfig>[0] = {
            retrieval: { ...(cfg.retrieval ?? {}), ...(patch.retrieval as object | undefined) },
            archive: { ...(cfg.archive ?? {}), ...(patch.archive as object | undefined) },
            summary: { ...(cfg.summary ?? {}), ...(patch.summary as object | undefined) },
            replan: { ...(cfg.replan ?? {}), ...(patch.replan as object | undefined) },
            meta: { ...(cfg.meta ?? {}), updatedAt: new Date().toISOString(), note: 'overrides API 更新' },
          };
          writeAdaptiveConfig(next);
        }
        for (const s of sessions.values()) {
          try { s.refreshAdaptive(); } catch { /* 会话异常忽略 */ }
        }
        return json(res, { ok: true, config: readAdaptiveConfig() });
      }
    }

    // 健康检查
    if (method === 'GET' && p === '/api/health') {
      return json(res, { ok: true, sessions: sessions.size });
    }

    return json(res, { error: `not found: ${method} ${p}` }, 404);
  } catch (e) {
    return json(res, { error: (e as Error).message.slice(0, 200) }, 500);
  }
});

// 端口占用兜底（初始化审查修复 #2）：EADDRINUSE 时给出明确中文指引后退出，
// 避免裸抛堆栈「黑窗口一闪就退」用户无从排查
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[web-api] 启动失败：端口 ${PORT} 已被占用。`);
    console.error('[web-api] 原因：上次的 server 进程未退出（或残留孤儿 node 进程占着端口）。');
    console.error('[web-api] 处理：先双击 停止.bat（或任务管理器结束残留 node.exe），再重新启动；');
    console.error('[web-api]        或设置环境变量换端口，例如：JG_WEB_PORT=18000 pnpm web:server');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`[web-api] http://${HOST}:${PORT}`);
  console.log(`[web-api] GET /api/cards | POST /api/session/new(SSE) | POST /api/turn(SSE)`);
  // DSH 标准插件加载（宿主直跑；单插件失败仅告警）
  void dshHost.loadAll(pluginRegistry.list(), (rec) => resolve('data', 'plugins', rec.name));
});

/** DSH 插件生命周期联动：安装/启停/更新/卸载后重载对应实例（先卸旧再装新，幂等） */
async function reloadDshPlugin(id: string): Promise<void> {
  const rec = pluginRegistry.get(id);
  dshHost.unload(id);
  if (!rec || !rec.enabled || rec.kind !== 'dsh') return;
  try {
    await dshHost.load(rec, resolve('data', 'plugins', rec.name));
  } catch (e) {
    console.warn(`[dsh-插件] ${id} 重载失败: ${(e as Error).message.slice(0, 160)}`);
  }
}
