/**
 * memory 包 - 写环执行器（v2 07 §3 ③b / 审查 §4.6）
 * 铁律：AM 码由平台自增分配；双表一致性由代码强校验（继承 <tableCheck> 规则）。
 * 模型只提供 memory_delta 的**内容**（delta_summary / state_changes / new_events）。
 */
import { MemoryDb } from './db.ts';
import { nextAmCode, AM_CODE_RE } from './schema.ts';

export interface StateChange {
  entity_type: 'time' | 'protagonist' | 'npc' | 'skill' | 'item' | 'quest';
  entity_id: string;
  field?: string;
  value?: string;
  action: 'upsert' | 'delete';
}

export interface MemoryDelta {
  /** 本轮增量摘要（聚焦变化，≤300 字） */
  delta_summary: string;
  state_changes?: StateChange[];
  new_events?: { description: string; characters?: string }[];
  scene?: string;
  round?: number;
}

export interface WriteResult {
  insertedCodes: string[];
  updatedCodes: string[];
  codesConsistent: boolean;
  warnings: string[];
  arcId?: number;
  summaryId?: number;
}

export class WriteLoop {
  constructor(private mem: MemoryDb) {}

  /** 执行一轮写环 */
  execute(delta: MemoryDelta): WriteResult {
    const warnings: string[] = [];
    const round = delta.round ?? this.currentRound() + 1;
    const scene = delta.scene ?? '';

    // 1. 平台分配 AM 码
    const allCodes = this.allCodes();
    const code = nextAmCode(allCodes);

    // 2. 校验 delta_summary 长度（≤300 字，超限警告并截断）
    let summary = delta.delta_summary ?? '';
    if (summary.length > 300) {
      warnings.push(`delta_summary 超长(${summary.length}字)，已压缩至 300 字`);
      summary = summary.slice(0, 300);
    }

    // 3. 写入总结表（memory_summary，新 AM 码）
    const now = new Date().toISOString();
    const summaryId = this.mem.db.prepare(
      'INSERT INTO memory_summary (code, round, delta, scene, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(code, round, summary, scene, now).lastInsertRowid as number;

    // 4. 写入/更新大纲表（memory_arc，同 AM 码 → 双表一致）
    let arcId: number | undefined;
    const arcRow = this.mem.db.prepare('SELECT id FROM memory_arc WHERE code = ?').get(code) as { id: number } | undefined;
    if (arcRow) {
      this.mem.db.prepare('UPDATE memory_arc SET summary = ?, chapter = COALESCE(chapter, ?) WHERE id = ?')
        .run(summary, scene, arcRow.id);
      arcId = arcRow.id;
    } else {
      const seq = this.maxSeq() + 1;
      arcId = this.mem.db.prepare(
        'INSERT INTO memory_arc (code, chapter, title, summary, status, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(code, scene, `R${round}`, summary, 'active', seq).lastInsertRowid as number;
    }

    // 5. 新事件（可分配独立 AM 码或并入本轮码）
    const insertedCodes: string[] = [code];
    for (const ev of delta.new_events ?? []) {
      const evCode = nextAmCode(this.allCodes());
      this.mem.db.prepare(
        'INSERT INTO memory_event (code, description, characters, refs, resolved) VALUES (?, ?, ?, ?, 0)'
      ).run(evCode, ev.description.slice(0, 400), ev.characters ?? '[]', '[]');
      insertedCodes.push(evCode);
    }

    // 6. 状态表 diff（表0-5 语义 upsert/delete）
    for (const sc of delta.state_changes ?? []) {
      this.applyStateChange(sc, round);
    }

    // 7. 实体索引同步（name → idx_entity）
    this.syncEntityIndex(round);

    // 8. 双表 AM 码一致性校验（返回是否一致；孤儿自动回填发生在 checkDualTableConsistency 内部）
    const consistent = this.checkDualTableConsistency();
    if (consistent) {
      warnings.push(`双表一致性 OK (${insertedCodes.join(',')})`);
    } else {
      // 审查 §3.2 修复：回填发生时必须可见，供 audit 追溯
      warnings.push(`双表不一致已自动回填（<tableCheck> 修正语义，涉及码: ${insertedCodes.join(',')}）`);
    }

    // 9. 轮次推进 + 元数据（UPSERT 语义：保留 initMeta 的 stage/bars/config，审查 §3.1 修复）
    const meta = this.mem.db.prepare('SELECT id FROM memory_meta WHERE id = 1').get() as { id: number } | undefined;
    if (meta) {
      this.mem.db.prepare('UPDATE memory_meta SET plot_round = ? WHERE id = 1').run(round);
    } else {
      // 未初始化时自动创建（默认 'setup' stage，不硬编码 'development'）
      this.mem.db.prepare('INSERT INTO memory_meta (id, arc_id, stage, plot_round, bars, config) VALUES (1, ?, ?, ?, ?, ?)')
        .run('arc-1', 'setup', round, '{}', '{}');
    }

    return {
      insertedCodes,
      updatedCodes: [],
      codesConsistent: consistent,
      warnings,
      arcId,
      summaryId,
    };
  }

  /** 初始化剧本元数据（首轮） */
  initMeta(bars: Record<string, number>, config: Record<string, unknown>): void {
    this.mem.db.prepare('DELETE FROM memory_meta').run();
    this.mem.db.prepare('INSERT INTO memory_meta (id, arc_id, stage, plot_round, bars, config) VALUES (1, ?, ?, 0, ?, ?)')
      .run('arc-1', 'setup', JSON.stringify(bars), JSON.stringify(config));
  }

  private applyStateChange(sc: StateChange, round: number): void {
    const existing = this.mem.db.prepare(
      'SELECT id FROM memory_state WHERE entity_type = ? AND entity_id = ?'
    ).get(sc.entity_type, sc.entity_id) as { id: number } | undefined;

    if (sc.action === 'delete') {
      if (existing) this.mem.db.prepare('DELETE FROM memory_state WHERE id = ?').run(existing.id);
      return;
    }
    if (existing) {
      const row = this.mem.db.prepare('SELECT state_json FROM memory_state WHERE id = ?').get(existing.id) as { state_json: string };
      const st = JSON.parse(row.state_json ?? '{}');
      if (sc.field) st[sc.field] = sc.value ?? '';
      this.mem.db.prepare('UPDATE memory_state SET state_json = ?, updated_round = ? WHERE id = ?')
        .run(JSON.stringify(st), round, existing.id);
    } else {
      this.mem.db.prepare(
        'INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES (?, ?, ?, ?, ?)'
      ).run(sc.entity_type, sc.entity_id, sc.entity_id, JSON.stringify(sc.field ? { [sc.field]: sc.value ?? '' } : {}), round);
    }
  }

  private syncEntityIndex(round: number): void {
    const rows = this.mem.db.prepare('SELECT id, entity_id, entity_type FROM memory_state WHERE updated_round = ?').all(round) as {
      id: number; entity_id: string; entity_type: string;
    }[];
    for (const r of rows) {
      this.mem.db.prepare('INSERT OR REPLACE INTO idx_entity (entity, category, row_id, weight) VALUES (?, ?, ?, ?)')
        .run(r.entity_id, 'state', r.id, 1.0);
    }
  }

  /** 双表一致性：本轮 summary 的每个码在大纲表中存在同码行 */
  private checkDualTableConsistency(): boolean {
    const orphans = this.mem.db.prepare(
      `SELECT s.code FROM memory_summary s
       LEFT JOIN memory_arc a ON a.code = s.code
       WHERE a.code IS NULL`
    ).all() as { code: string }[];
    if (orphans.length > 0) {
      for (const o of orphans) {
        if (AM_CODE_RE.test(o.code)) {
          // 自动回填（继承 <tableCheck> 修正语义）
          this.mem.db.prepare('INSERT OR IGNORE INTO memory_arc (code, chapter, title, summary, status, seq) VALUES (?, ?, ?, ?, ?, ?)')
            .run(o.code, '', `自动回填 ${o.code}`, '', 'active', this.maxSeq() + 1);
        }
      }
      return false;
    }
    return true;
  }

  /** 全局 AM 码集合（arc + event + summary 三表 UNION，保证全局唯一） */
  private allCodes(): string[] {
    const rows = this.mem.db.prepare(
      `SELECT code FROM memory_arc
       UNION SELECT code FROM memory_event WHERE code != ''
       UNION SELECT code FROM memory_summary WHERE code != ''`
    ).all() as { code: string }[];
    return rows.map((r) => r.code);
  }

  private maxSeq(): number {
    const row = this.mem.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM memory_arc').get() as { s: number };
    return row.s;
  }

  private currentRound(): number {
    const row = this.mem.db.prepare('SELECT plot_round FROM memory_meta WHERE id = 1').get() as { plot_round: number } | undefined;
    return row?.plot_round ?? 0;
  }
}
