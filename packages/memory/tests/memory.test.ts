/**
 * memory 包冒烟测试（node:test + --experimental-strip-types）
 * 覆盖：schema 初始化、写环（AM 码分配 + 双表一致）、混合检索（trigram + LIKE 兜底 + RRF）、门控。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../src/db.ts';
import { RetrievalEngine } from '../src/retrieval.ts';
import { WriteLoop } from '../src/writer.ts';

describe('memory core', () => {
  test('schema v3 初始化 + FTS5 trigram 表可用', () => {
    const mem = new MemoryDb();
    const tables = mem.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expect of ['memory_arc', 'memory_summary', 'memory_event', 'memory_parallel', 'memory_state', 'lorebook_entry', 'vec_memory', 'audit_log', 'fts_arc', 'fts_summary']) {
      assert.ok(names.includes(expect), `缺少表 ${expect}`);
    }
  });

  test('写环：AM 码平台分配 + 双表一致', () => {
    const mem = new MemoryDb();
    const writer = new WriteLoop(mem);
    writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});

    const r1 = writer.execute({
      delta_summary: '主角抵达学院，与魔法少女初遇，获得初始契约',
      state_changes: [
        { entity_type: 'protagonist', entity_id: '主角', field: '位置', value: '学院', action: 'upsert' },
        { entity_type: 'npc', entity_id: '魔法少女', field: '好感', value: '10', action: 'upsert' },
      ],
      new_events: [{ description: '主角与魔法少女签订契约' }],
      round: 1,
    });
    assert.ok(r1.insertedCodes.includes('AM01'), `首轮应为 AM01，实际 ${r1.insertedCodes.join(',')}`);
    assert.ok(r1.codesConsistent, '双表一致性应通过');

    const r2 = writer.execute({
      delta_summary: '主角遭遇怪物袭击，魔法少女变身迎战',
      round: 2,
    });
    assert.ok(r2.insertedCodes.includes('AM02'), `第二轮应为 AM02，实际 ${r2.insertedCodes.join(',')}`);
    assert.ok(r2.codesConsistent);
  });

  test('混合检索：trigram 命中 + LIKE 兜底 + RRF 融合', () => {
    const mem = new MemoryDb();
    const writer = new WriteLoop(mem);
    writer.initMeta({}, {});
    writer.execute({ delta_summary: '魔法少女在战斗中处于劣势姿态，快感值累积', round: 1 });
    writer.execute({ delta_summary: '主角在酒馆遇到神秘少女，获得任务线索', round: 2 });
    writer.execute({ delta_summary: '魔法少女变身迎战怪物，战斗进入白热化', round: 3 });

    const ret = new RetrievalEngine(mem);
    const r1 = ret.recall({ query: '魔法少女', round: 3, budgetTokens: 200 });
    assert.ok(r1.hits.length >= 1, `trigram 应命中，实际 ${r1.hits.length}`);
    assert.ok(r1.injectedBlock.startsWith('<记忆召回>'));

    const r2 = ret.recall({ query: '少女', round: 3, budgetTokens: 200 });
    assert.ok(r2.hits.length >= 1, `LIKE 兜底应命中，实际 ${r2.hits.length}`);
  });

  test('注入块格式：来源 + 置信度标注', () => {
    const mem = new MemoryDb();
    const writer = new WriteLoop(mem);
    writer.initMeta({}, {});
    writer.execute({ delta_summary: '主角获得传说级武器屠龙刃', round: 1 });
    const ret = new RetrievalEngine(mem);
    const r = ret.recall({ query: '屠龙刃 主角', round: 1 });
    assert.ok(r.injectedBlock.includes('[AM01|'), '注入块应带 [码|类别|得分|来源] 标注');
    assert.ok(r.codes.includes('AM01'));
  });

  test('AM 码直查', () => {
    const mem = new MemoryDb();
    const writer = new WriteLoop(mem);
    writer.initMeta({}, {});
    writer.execute({ delta_summary: '关键剧情：决战前夜', round: 1 });
    const ret = new RetrievalEngine(mem);
    const r = ret.recall({ query: 'AM01' });
    assert.ok(r.hits.some((h) => h.code === 'AM01'), 'AM 码直查应命中');
  });

  test('空库检索：返回空块而非崩溃', () => {
    const mem = new MemoryDb();
    const ret = new RetrievalEngine(mem);
    const r = ret.recall({ query: '无关内容' });
    assert.ok(r.hits.length === 0);
    assert.ok(r.injectedBlock.includes('无高置信记忆命中'));
  });
});
