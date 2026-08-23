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
import { listAssets, readAsset, saveUserAsset, deleteUserAsset, deleteUserCard, listCards, resolveCard, readCardText, saveAssetBuffer } from '../../packages/core/src/asset-paths.ts';
import { parseWorldBook } from '../../packages/core/src/worldbook.ts';
import { parsePreset } from '../../packages/core/src/preset.ts';
import { parseCharaCard, extractCharaFromPng, pngPayloadToJson, buildCharaPng } from '../../packages/core/src/chara.ts';
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { StoryboardOrchestrator, StoryboardRegistry, DEFAULT_WORKFLOW } from '../../tools/cli/storyboard-orchestrator.ts';
import type { StoryboardResult } from '../../tools/cli/storyboard-orchestrator.ts';
import { renderDirectorMarkdown } from '../../packages/prompt/src/storyboard.ts';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider, createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';

const PORT = Number(process.env.JG_WEB_PORT ?? 17800);
const HOST = '127.0.0.1';
const DATA_DIR = resolve('data');
/** 前端日志落盘路径（日志模块 v0.6.1：浏览器批量上报 → 逐行追加） */
const WEB_LOG_PATH = resolve(DATA_DIR, 'web.log');

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
    panels: result.panels.map((p) => ({
      panel: p.panel, time: p.time, shot_size: p.shot_size, angle: p.angle,
      transition_hint: p.transition_hint, positive_prompt_short: p.positive_prompt_short,
    })),
    sequence: result.sequence ? {
      master_prompt: result.sequence.master_prompt.slice(0, 400), narrative: result.sequence.narrative.slice(0, 400),
      consistency: result.sequence.consistency.slice(0, 200), sfx: result.sequence.sfx.slice(0, 200),
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

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

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
        return json(res, { plugin: rec });
      } catch (e) {
        return json(res, { error: (e as Error).message.slice(0, 200) }, 400);
      }
    }
    if (method === 'POST' && p.startsWith('/api/plugins/')) {
      const id = p.split('/')[3];
      const action = p.split('/')[4] ?? '';
      if (action === 'enable' || action === 'disable') {
        try { return json(res, { plugin: pluginRegistry.setEnabled(id, action === 'enable') }); }
        catch (e) { return json(res, { error: (e as Error).message }, 404); }
      }
      if (action === 'uninstall') {
        try { pluginRegistry.uninstall(id); return json(res, { ok: true }); }
        catch (e) { return json(res, { error: (e as Error).message }, 404); }
      }
      if (action === 'update') {
        try { return json(res, { plugin: await pluginRegistry.update(id) }); }
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
      });
      await session.init((stage) => sseSend(res, { type: 'stage', stage }));
      const id = dbName.replace(/\.db$/, '');
      sessions.set(id, session);
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

      sse(res);
      sseSend(res, { type: 'status', stage: 'thinking' });
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on('close', onClose);
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
      } catch (e) {
        // 非中止失败：清理本轮孤儿 user 行（模型异常下 runTurnCore 已写 user、无 assistant，会致记忆断裂）
        if (!ac.signal.aborted) {
          session.rollbackFailedTurn();
          sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
        }
      }
      req.off('close', onClose);
      res.end();
      return;
    }

    // 重新生成 AI 回复（回滚该轮状态 + 重放，SSE 流式同 /api/turn；req 断开 → 中止上游）
    if (method === 'POST' && p.startsWith('/api/session/') && p.endsWith('/regenerate')) {
      const id = p.split('/')[3];
      const session = sessions.get(id);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const body = await readBody(req);
      const round = Number(body.round ?? 0);
      if (!Number.isInteger(round) || round < 1) return json(res, { error: 'round 非法' }, 400);
      sse(res);
      sseSend(res, { type: 'status', stage: 'thinking' });
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on('close', onClose);
      try {
        let streamStarted = false;
        const r = await session.regenerate(round, (chunk) => {
          if (!streamStarted) { sseSend(res, { type: 'status', stage: 'streaming' }); streamStarted = true; }
          sseSend(res, { type: 'delta', text: chunk });
        }, ac.signal);
        if (!streamStarted) sseSend(res, { type: 'status', stage: 'streaming' });
        sseSend(res, { type: 'done', prose: r.prose, assistantMsgId: r.assistantMsgId, round: r.round });
      } catch (e) {
        if (!ac.signal.aborted) sseSend(res, { type: 'error', message: (e as Error).message.slice(0, 200) });
      }
      req.off('close', onClose);
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
        const r = session.finalizeAbortedRound(round);
        return json(res, { ok: true, ...r });
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
      };
      const cfg = loadProviderConfig(overrides);
      if (!cfg.apiKey) {
        return json(res, { ok: false, error: '缺少 API key：请在下方填入 key 后测试，或在 .env.local 配置 JG_API_KEY' }, 400);
      }
      const client = new OpenAICompatibleClient(cfg);
      try {
        const models = await client.listModels();
        return json(res, { ok: true, models: models.slice(0, 50), count: models.length, baseUrl: cfg.baseUrl, model: cfg.model });
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
      const removed = file ? deleteUserAsset('worldbook', file) : false;
      return json(res, { ok: true, removed, file });
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

    // 健康检查
    if (method === 'GET' && p === '/api/health') {
      return json(res, { ok: true, sessions: sessions.size });
    }

    return json(res, { error: `not found: ${method} ${p}` }, 404);
  } catch (e) {
    return json(res, { error: (e as Error).message.slice(0, 200) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web-api] http://${HOST}:${PORT}`);
  console.log(`[web-api] GET /api/cards | POST /api/session/new(SSE) | POST /api/turn(SSE)`);
});
