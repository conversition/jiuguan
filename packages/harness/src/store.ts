/**
 * P13-01：可注入 store 与默认 temp DB。
 *
 * 评测层默认环境 = 临时 SQLite 数据库（mkdtemp + node:sqlite）+ mock/replay 模型，
 * 绝不连接真实用户数据库（`data/session-*.db` / 生产 JG_USER_DATA_DIR）。
 * store 语义：load() 播种引擎初始状态；save() 在循环终止后持久化最终状态。
 * 单次循环内引擎仍是唯一写者（工具只改内存快照，终态一次性落盘）——
 * 并发写与 revision CAS 属 P13-B 的 HarnessJob 域，评测层不伪造。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface HarnessStore {
  readonly kind: 'memory' | 'temp-sqlite';
  /** 可读性描述（评测报告引用；绝不包含敏感路径以外的信息）。 */
  readonly location: string;
  /** 播种初始状态（返回全新对象，调用方可自由改写）。 */
  load(): Record<string, unknown>;
  /** 持久化终态（整体覆盖写）。 */
  save(state: Record<string, unknown>): void;
  close?(): void;
}

export function createMemoryStore(seed: Record<string, unknown> = {}): HarnessStore {
  let state = structuredClone(seed);
  return {
    kind: 'memory',
    location: 'in-memory',
    load: () => structuredClone(state),
    save: (next) => { state = structuredClone(next); },
  };
}

interface TempSqliteStore extends HarnessStore {
  /** 清理临时目录（测试结束调用；失败可容忍）。 */
  dispose(): void;
}

export function createTempSqliteStore(seed: Record<string, unknown> = {}): TempSqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'jiuguan-harness-'));
  const dbPath = join(dir, 'harness.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS harness_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  const seeded = JSON.stringify(seed);
  db.prepare('INSERT INTO harness_state (id, payload) VALUES (1, ?)').run(seeded);
  return {
    kind: 'temp-sqlite',
    // 报告只暴露不敏感的存储类型，不泄露宿主临时目录。
    location: 'ephemeral-sqlite',
    load(): Record<string, unknown> {
      const row = db.prepare('SELECT payload FROM harness_state WHERE id = 1').get() as { payload: string } | undefined;
      return row === undefined ? {} : JSON.parse(row.payload) as Record<string, unknown>;
    },
    save(state: Record<string, unknown>): void {
      db.prepare('UPDATE harness_state SET payload = ? WHERE id = 1').run(JSON.stringify(state));
    },
    close(): void {
      db.close();
    },
    dispose(): void {
      try { db.close(); } catch { /* 已关闭 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmpdir 清理失败可容忍 */ }
    },
  };
}
