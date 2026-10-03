import { createHash } from 'node:crypto';
import { MemoryDb } from './db.ts';
import { encodeF32 } from './retrieval.ts';
import type { EmbeddingProvider } from './embedding.ts';

export type VecSource = 'lore' | 'arc' | 'summary' | 'event';

export interface VectorizeOptions {
  sources?: VecSource[];
  batchSize?: number;
  incremental?: boolean;
  rebuild?: boolean;
  buildId?: string;
  preprocess?: Record<string, unknown>;
  activate?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface VectorizeResult {
  vectorized: number;
  skipped: number;
  errors: number;
  stale: number;
  buildIds: string[];
  elapsedMs: number;
}

interface VecDocument {
  rowId: number;
  content: string;
}

interface PendingVecDocument extends VecDocument {
  source: VecSource;
  contentHash: string;
  buildId: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function collectDocuments(mem: MemoryDb, source: VecSource): VecDocument[] {
  switch (source) {
    case 'lore': {
      const rows = mem.db.prepare('SELECT id, comment, content FROM lorebook_entry WHERE active = 1').all() as { id: number; comment: string; content: string }[];
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

  async run(opts: VectorizeOptions = {}): Promise<VectorizeResult> {
    const t0 = Date.now();
    const sources = opts.sources ?? ['lore', 'arc', 'summary', 'event'];
    const batchSize = opts.batchSize ?? 32;
    const preprocess = stableJson(opts.preprocess ?? { kind: 'whole-row', version: 1 });
    const model = `${this.provider.name}:${this.provider.dims}`;
    const rebuild = opts.rebuild === true;
    const activate = opts.activate !== false;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buildIds = sources.map((src) =>
      opts.buildId ? `${opts.buildId}:${src}` : rebuild ? `${src}:${stamp}` : `active:${src}:${sha256(`${model}:${preprocess}`).slice(0, 12)}`,
    );

    let vectorized = 0;
    let skipped = 0;
    let errors = 0;
    let stale = 0;

    const allDocs: PendingVecDocument[] = [];
    for (let si = 0; si < sources.length; si++) {
      const source = sources[si];
      const buildId = buildIds[si];
      this.ensureBuild(buildId, source, model, preprocess, rebuild ? 'staging' : 'active');

      const docs = collectDocuments(this.mem, source).filter((d) => d.content.trim().length > 0);
      stale += this.deactivateMissing(source, new Set(docs.map((d) => d.rowId)));

      for (const d of docs) {
        const contentHash = sha256(d.content);
        if (opts.incremental && this.hasCurrentVector(source, d.rowId, contentHash, model, preprocess)) {
          skipped++;
          continue;
        }
        const docBuildId = rebuild ? buildId : `${buildId}:${contentHash.slice(0, 12)}`;
        if (!rebuild) this.ensureBuild(docBuildId, source, model, preprocess, 'active');
        allDocs.push({ source, rowId: d.rowId, content: d.content, contentHash, buildId: docBuildId });
      }
    }

    const upsert = this.mem.db.prepare(
      'INSERT OR REPLACE INTO vec_memory (source, row_id, build_id, content_hash, model, preprocess, indexed_at, active, dims, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    for (let i = 0; i < allDocs.length; i += batchSize) {
      const chunk = allDocs.slice(i, i + batchSize);
      try {
        const vectors = await this.provider.embedBatch(chunk.map((d) => d.content));
        const dims = vectors[0]?.length ?? 0;
        if (dims === 0) throw new Error('embedding returned an empty vector');
        for (let j = 0; j < chunk.length; j++) {
          const doc = chunk[j];
          if (!rebuild) this.deactivateRecord(doc.source, doc.rowId);
          upsert.run(doc.source, doc.rowId, doc.buildId, doc.contentHash, model, preprocess, Date.now(), rebuild ? 0 : 1, dims, encodeF32(vectors[j]));
        }
        vectorized += chunk.length;
      } catch (e) {
        errors += chunk.length;
        console.warn(`[vectorize] batch failed: ${(e as Error).message.slice(0, 80)}`);
      }
      opts.onProgress?.(vectorized + skipped, allDocs.length);
    }

    if (rebuild && activate && errors === 0) {
      for (let si = 0; si < sources.length; si++) this.activateBuild(sources[si], buildIds[si]);
    }

    return { vectorized, skipped, errors, stale, buildIds, elapsedMs: Date.now() - t0 };
  }

  private ensureBuild(buildId: string, source: VecSource, model: string, preprocess: string, status: 'active' | 'staging'): void {
    const now = Date.now();
    this.mem.db.prepare(
      `INSERT OR IGNORE INTO vec_index_build (build_id, source, model, preprocess, status, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(buildId, source, model, preprocess, status, now, status === 'active' ? now : 0);
  }

  private hasCurrentVector(source: VecSource, rowId: number, contentHash: string, model: string, preprocess: string): boolean {
    return !!this.mem.db.prepare(
      'SELECT 1 FROM vec_memory WHERE source = ? AND row_id = ? AND content_hash = ? AND model = ? AND preprocess = ? AND active = 1',
    ).get(source, rowId, contentHash, model, preprocess);
  }

  private deactivateRecord(source: VecSource, rowId: number): void {
    this.mem.db.prepare('UPDATE vec_memory SET active = 0 WHERE source = ? AND row_id = ? AND active = 1').run(source, rowId);
  }

  private deactivateMissing(source: VecSource, currentIds: Set<number>): number {
    const rows = this.mem.db.prepare('SELECT row_id FROM vec_memory WHERE source = ? AND active = 1').all(source) as { row_id: number }[];
    let stale = 0;
    for (const r of rows) {
      if (currentIds.has(r.row_id)) continue;
      this.deactivateRecord(source, r.row_id);
      stale++;
    }
    return stale;
  }

  private activateBuild(source: VecSource, buildId: string): void {
    const now = Date.now();
    this.mem.db.prepare('UPDATE vec_memory SET active = 0 WHERE source = ?').run(source);
    this.mem.db.prepare('UPDATE vec_memory SET active = 1 WHERE source = ? AND build_id = ?').run(source, buildId);
    this.mem.db.prepare(
      "UPDATE vec_index_build SET status = CASE WHEN build_id = ? THEN 'active' ELSE 'superseded' END, activated_at = CASE WHEN build_id = ? THEN ? ELSE activated_at END WHERE source = ?",
    ).run(buildId, buildId, now, source);
  }
}
