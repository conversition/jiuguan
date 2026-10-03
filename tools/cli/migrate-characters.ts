/**
 * MEM-06：老存档 → 人物投影的**显式迁移步骤**（不在打开面板时迁移）
 *
 * 用法：
 *   node --experimental-strip-types --experimental-transform-types tools/cli/migrate-characters.ts \
 *     --db data/session.db [--session <sessionKey>] [--batch <id>] [--lore <recordId>] [--apply]
 *
 * 纪律：
 *  · 默认**干跑**（dry-run）：只报告将做什么，不写任何东西；加 --apply 才写入
 *  · 写入前**自动备份**（<db>.bak-<timestamp>），并打印回退命令
 *  · 迁移幂等：同一 --batch 重跑不重复建人/写字段
 *  · 无来源字段记为待核对（pending），不把推测升级为确认
 *  · 只处理该 session 命名空间；不扫描其它会话
 */
import { copyFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { StateStore } from '../../packages/memory/src/state-store.ts';
import { CharacterStore } from '../../packages/memory/src/character.ts';

const argv = process.argv.slice(2);
const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const apply = argv.includes('--apply');
const dbArg = get('--db');
if (!dbArg) {
  console.error('缺少 --db <path>（迁移必须显式指定目标库，避免误操作真实环境）');
  process.exit(2);
}
const dbPath = resolve(dbArg);
if (!existsSync(dbPath)) { console.error(`库不存在：${dbPath}`); process.exit(2); }

/** 会话命名空间 = 数据库基名（与会话层 sessionLabel 口径一致） */
const sessionKey = get('--session') ?? basename(dbPath).replace(/\.db$/i, '');
const batchId = get('--batch') ?? `migrate-${Date.now().toString(36)}`;
const loreId = get('--lore');

const db = new MemoryDb({ path: dbPath });
const cs = new CharacterStore(db.db, new StateStore(db.db));
const rows = db.db.prepare('SELECT entity_type, entity_id, name, state_json, updated_round FROM memory_state').all() as
  { entity_type: string; entity_id: string; name: string; state_json: string; updated_round: number }[];

console.log(`[迁移] 目标库 ${dbPath}`);
console.log(`[迁移] 会话命名空间 ${sessionKey}`);
console.log(`[迁移] 候选行 ${rows.length}（memory_state）；批次 ${batchId}；来源 ${loreId ? `lore#${loreId}` : '(无 → 全部待核对)'}`);

if (!apply) {
  console.log('[迁移] 干跑：未写入任何数据。加 --apply 执行（会先自动备份）。');
  db.close();
  process.exit(0);
}

const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(dbPath, backupPath);
console.log(`[迁移] 已备份 → ${backupPath}`);
console.log(`[迁移] 回退：copy "${backupPath}" "${dbPath}"`);

const r = cs.migrateFromLegacy(sessionKey, rows, {
  batchId,
  instanceId: `migrate:${sessionKey}`,
  sourceRefs: loreId ? [{ source: 'lore', recordId: `lore#${loreId}`, recordVersion: 1 }] : undefined,
});
console.log(`[迁移] 新建人物 ${r.createdCharacters}；迁入字段 ${r.importedFields}（全部 pending 待核对）`);
if (r.skipped.length > 0) {
  console.log(`[迁移] 跳过 ${r.skipped.length} 项（保持待核对，不强行填满角色表）：`);
  for (const s of r.skipped.slice(0, 20)) console.log(`   - ${s.entityId}: ${s.reason}`);
}
db.checkpoint();
db.close();
