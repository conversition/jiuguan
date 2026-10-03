/**
 * variable 包 - VMS 持久化适配器（06 §6 集成点落地）
 * 变量快照持久化到 `memory_state`（entity_type='variable'，entity_id='vms'，单行全量快照）；
 * 剧本/会话加载时恢复为 literal 声明。
 *
 * 语义：
 *  - 只持久化 **literal** 变量（derived 由表达式重算，不冻结值）；引擎叶子（session:mvu:*）同步进快照
 *  - state_json 键 = VMS 完整名（scope:source:name，name 可能含中文/点路径但无冒号），值 = 字面量
 *  - 恢复按"最后一个冒号"切分完整名 → 重新 register（literal）；来源注册（预设文件/引擎桥）随后覆盖同名
 *  - 空快照不写行（避免垃圾行）；坏数据跳过
 */
import type { MemoryDb } from '../../memory/src/db.ts';
import type { VariableManager } from './vms.ts';
import type { VarValue } from './dsl.ts';

export const VMS_ENTITY_TYPE = 'variable';
export const VMS_ENTITY_ID = 'vms';

/** 持久化全部 literal 变量（一次 UPSERT 一行快照；返回写入条数） */
export function persistVariables(db: MemoryDb, vms: VariableManager, round = 0): number {
  const snap: Record<string, VarValue> = {};
  for (const d of vms.list()) {
    if (d.type === 'literal' && d.value !== undefined) snap[d.fullName] = d.value;
  }
  if (Object.keys(snap).length === 0) return 0;
  const json = JSON.stringify(snap);
  const existing = db.db.prepare("SELECT id FROM memory_state WHERE entity_type = ? AND entity_id = ?")
    .get(VMS_ENTITY_TYPE, VMS_ENTITY_ID) as { id: number } | undefined;
  if (existing) {
    db.db.prepare('UPDATE memory_state SET state_json = ?, updated_round = ? WHERE id = ?')
      .run(json, round, existing.id);
  } else {
    db.db.prepare(
      'INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES (?, ?, ?, ?, ?)'
    ).run(VMS_ENTITY_TYPE, VMS_ENTITY_ID, '变量快照', json, round);
  }
  return Object.keys(snap).length;
}

/** 从快照恢复 literal 变量（返回恢复条数；来源注册随后覆盖同名） */
export function restoreVariables(db: MemoryDb, vms: VariableManager): number {
  const row = db.db.prepare('SELECT state_json FROM memory_state WHERE entity_type = ? AND entity_id = ?')
    .get(VMS_ENTITY_TYPE, VMS_ENTITY_ID) as { state_json: string } | undefined;
  if (!row?.state_json) return 0;
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(row.state_json) as Record<string, unknown>;
  } catch {
    return 0;
  }
  let restored = 0;
  for (const [full, value] of Object.entries(snap)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const idx = full.lastIndexOf(':');
    if (idx <= 0 || idx === full.length - 1) continue;
    const scopeAndSource = full.slice(0, idx);
    const name = full.slice(idx + 1);
    const segs = scopeAndSource.split(':');
    const scope = segs[0];
    const source = segs.slice(1).join(':') || scope;
    if (!scope || !name) continue;
    try {
      vms.register({ scope, source, name, type: 'literal', value });
      restored++;
    } catch {
      // 冲突/坏数据：跳过单条，不阻断整体恢复
    }
  }
  return restored;
}
