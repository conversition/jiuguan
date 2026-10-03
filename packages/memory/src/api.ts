/**
 * memory 包 - HTTP API（v2 07 §2 / 05 §5）
 * 零依赖实现：node:http + 手写路由；提供 /health /memory/recall /memory/search /memory/update /openapi.json。
 * 后续可平滑替换为 axum（Rust）或 fastify，接口契约不变。
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { MemoryDb } from './db.ts';
import { RetrievalEngine } from './retrieval.ts';
import type { RecallQuery } from './retrieval.ts';
import { WriteLoop } from './writer.ts';
import type { MemoryDelta } from './writer.ts';

export interface MemoryServiceOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** 调试模式：/memory/search 返回分通道详情 */
  debug?: boolean;
}

type Json = Record<string, unknown>;

export class MemoryService {
  private mem: MemoryDb;
  private retrieval: RetrievalEngine;
  private writer: WriteLoop;
  private opts: Required<Pick<MemoryServiceOptions, 'port' | 'host'>> & MemoryServiceOptions;

  constructor(opts: MemoryServiceOptions = {}) {
    this.opts = { port: opts.port ?? 17600, host: opts.host ?? '127.0.0.1', ...opts };
    this.mem = new MemoryDb({ path: opts.dbPath });
    this.retrieval = new RetrievalEngine(this.mem);
    this.writer = new WriteLoop(this.mem);
  }

  start(): void {
    const server = createServer((req, res) => this.route(req, res));
    server.listen(this.opts.port, this.opts.host, () => {
      console.log(`[memory-service] listening on http://${this.opts.host}:${this.opts.port}`);
      console.log(`[memory-service] openapi: http://${this.opts.host}:${this.opts.port}/openapi.json`);
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') return this.json(res, { ok: true, integrity: this.mem.integrityCheck(), uptime: process.uptime() });
      if (method === 'GET' && path === '/openapi.json') return this.json(res, this.openapi());

      if (method === 'POST' && path === '/memory/recall') {
        const body = await this.readJson(req) as Partial<RecallQuery>;
        if (typeof body.query !== 'string') return this.json(res, { error: 'query is required' }, 400);
        return this.json(res, this.retrieval.recall({ ...body, query: body.query, channels: this.opts.debug ? body.channels : { ...body.channels } }));
      }

      if (method === 'POST' && path === '/memory/search') {
        // 调试端点：分通道返回（BM25 / vec / 实体 / AM 码）
        const body = await this.readJson(req) as Partial<RecallQuery>;
        if (typeof body.query !== 'string') return this.json(res, { error: 'query is required' }, 400);
        const result = this.retrieval.recall({ ...body, query: body.query });
        const debugDetail = {
          query: body.query,
          hits: result.hits.map((h) => ({ code: h.code, category: h.category, score: h.score, source: h.source, confidence: h.confidence, content: h.content.slice(0, 80) })),
          layerStats: result.layerStats,
          elapsedMs: result.elapsedMs,
        };
        return this.json(res, { ...result, debug: debugDetail });
      }

      if (method === 'POST' && path === '/memory/update') {
        const body = await this.readJson(req) as MemoryDelta;
        return this.json(res, this.writer.execute(body));
      }

      if (method === 'GET' && path === '/memory/state') {
        const rows = this.mem.db.prepare('SELECT id, entity_type, entity_id, name, state_json, updated_round FROM memory_state').all();
        return this.json(res, { states: rows });
      }

      if (method === 'POST' && path === '/memory/init') {
        const body = await this.readJson(req) as { bars?: Record<string, number>; config?: Record<string, unknown> };
        this.writer.initMeta(body.bars ?? {}, body.config ?? {});
        return this.json(res, { ok: true });
      }

      return this.json(res, { error: `not found: ${method} ${path}` }, 404);
    } catch (e) {
      return this.json(res, { error: (e as Error).message }, 500);
    }
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8'); });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  private json(res: ServerResponse, obj: unknown, status = 200): void {
    res.statusCode = status;
    res.end(JSON.stringify(obj, null, 2));
  }

  private openapi(): Json {
    return {
      openapi: '3.1.0',
      info: { title: 'jiuguan memory-service', version: '0.1.0', description: '混合检索记忆服务（FTS5 trigram + vec BLOB + RRF）' },
      paths: {
        '/health': { get: { summary: '存活 + DB 完整性' } },
        '/memory/recall': { post: { summary: '混合检索（注入块）', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, budgetTokens: { type: 'number' }, round: { type: 'number' } } } } } } } },
        '/memory/search': { post: { summary: '分通道调试检索' } },
        '/memory/update': { post: { summary: '写环（AM 码平台分配 + 双表一致）' } },
        '/memory/state': { get: { summary: '状态表读取' } },
        '/memory/init': { post: { summary: '初始化剧本元数据' } },
      },
    };
  }
}

/** CLI 入口：node dist/api.js --port 17600 --db ./data/memory.db */
const isMain = process.argv[1]?.endsWith('api.js') || process.argv[1]?.endsWith('api.ts');
if (isMain) {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const svc = new MemoryService({
    port: Number(get('--port') ?? 17600),
    dbPath: get('--db'),
    debug: args.includes('--debug'),
  });
  svc.start();
}
