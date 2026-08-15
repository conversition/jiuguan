/**
 * memory 包 - 向量化管线（审查 §2.3/§6：真实 embedding 替换 hash）
 * 将文档条目（lorebook_entry / memory_arc / memory_event / memory_summary）批量向量化写入 vec_memory。
 * 原始版 __XP大全（key 空）经此管线获得语义向量，激活语义由检索通道 B 承接（审查 ADR 8）。
 */
import { MemoryDb } from './db.ts';
import { encodeF32 } from './retrieval.ts';
import type { EmbeddingProvider } from './embedding.ts';

export type VecSource = 'lore' | 'arc' | 'summary' | 'event';

export interface VectorizeOptions {
  sources?: VecSource[];
  /** 每批条数 */
  batchSize?: number;
  /** 跳过已有向量的行（增量） */
  incremental?: boolean;
  /** 进度回调 */
  onProgress?: (done: number, total: number) => void;
}

export interface VectorizeResult {
  vectorized: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}

/** 提取各源的文档文本（id → content） */
function collectDocuments(mem: MemoryDb, source: VecSource): { rowId: number; content: string }[] {
  switch (source) {
    case 'lore': {
      const rows = mem.db.prepare('SELECT id, comment, content FROM lorebook_entry').all() as { id: number; comment: string; content: string }[];
      return rows.map((r) => ({ rowId: r.id, content: `${r.comment ?? ''} ${r.content ?? ''}`.trim() }));
    }
    case 'arc': {
      const rows = mem.db.prepare('SELECT id, code, summary FROM memory_arc').all() as { id: number; code: string; summary: string }[];
      return rows.map((r) => ({ rowId: r.id, content: `[${r.code}] ${r.summary ?? ''}`.trim() }));
    }
    case 'summary': {
      const rows = mem.db.prepare('SELECT id, delta FROM memory_summary').all() as { id: number; delta: string }[];
      return rows.map((r) => ({ rowId: r.id, content: r.delta ?? '' }));
    }
    case 'event': {
      const rows = mem.db.prepare('SELECT id, description FROM memory_event').all() as { id: number; description: string }[];
      return rows.map((r) => ({ rowId: r.id, content: r.description ?? '' }));
    }
  }
}

export class Vectorizer {
  constructor(private mem: MemoryDb, private provider: EmbeddingProvider) {}

  /** 执行向量化 */
  async run(opts: VectorizeOptions = {}): Promise<VectorizeResult> {
    const t0 = Date.now();
    const sources = opts.sources ?? ['lore', 'arc', 'summary', 'event'];
    const batchSize = opts.batchSize ?? 32;
    let vectorized = 0;
    let skipped = 0;
    let errors = 0;
    let total = 0;

    const allDocs: { source: VecSource; rowId: number; content: string }[] = [];
    for (const src of sources) {
      for (const d of collectDocuments(this.mem, src)) {
        if (!d.content) continue;
        if (opts.incremental) {
          const exists = this.mem.db.prepare('SELECT 1 FROM vec_memory WHERE row_id = ?').get(d.rowId);
          if (exists) { skipped++; continue; }
        }
        allDocs.push({ source: src, rowId: d.rowId, content: d.content });
      }
    }
    total = allDocs.length;

    const upsert = this.mem.db.prepare(
      'INSERT OR REPLACE INTO vec_memory (row_id, dims, embedding) VALUES (?, ?, ?)'
    );

    for (let i = 0; i < allDocs.length; i += batchSize) {
      const chunk = allDocs.slice(i, i + batchSize);
      try {
        const vectors = await this.provider.embedBatch(chunk.map((d) => d.content));
        const dims = vectors[0]?.length ?? 0;
        if (dims === 0) throw new Error('embedding 返回空向量');
        for (let j = 0; j < chunk.length; j++) {
          upsert.run(chunk[j].rowId, dims, encodeF32(vectors[j]));
        }
        vectorized += chunk.length;
      } catch (e) {
        errors += chunk.length;
        console.warn(`[vectorize] 批次失败: ${(e as Error).message.slice(0, 80)}`);
      }
      opts.onProgress?.(vectorized + skipped, total);
    }

    return { vectorized, skipped, errors, elapsedMs: Date.now() - t0 };
  }
}
