/**
 * 临时验证脚本：turn 失败兜底 + 孤儿修复（rollbackFailedTurn / buildChatWindow 跳孤儿 / regenerate 失败占位）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-fallback.ts
 */
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from './session.ts';
import type { SessionArgs } from './session.ts';

const mkTurn = (prose: string, summary: string) => JSON.stringify({
  plan: { thought: 't', key_events: [{ description: '事件' }], next_plan: '继续', event_type: 'normal', bars_delta: { personal: 5 } },
  memory_delta: { delta_summary: summary, state_changes: [{ entity_type: 'protagonist', entity_id: 'hero', field: '好感', value: '5', action: 'upsert' }], new_events: [] },
  prose,
});

/** 正常模型：完整 game_turn */
class OkClient {
  async stream() {
    const arg = mkTurn('正常正文', '摘要A');
    return { content: null, toolCalls: [{ id: 'tc1', name: 'game_turn', arguments: arg }], finishReason: 'tool_calls', usage: null, raw: {} };
  }
  async complete() { return { content: '【建议分支】\n- 继续', toolCalls: [], finishReason: 'stop', usage: null, raw: {} }; }
}

/** 异常模型：stream 抛普通错误（非 AbortTurnError，模拟 provider 挂掉） */
class FailClient {
  async stream() { throw new Error('provider 500: upstream down'); }
  async complete() { return { content: '【建议分支】\n- 继续', toolCalls: [], finishReason: 'stop', usage: null, raw: {} }; }
}

const CARD = {
  spec: 'chara_card_v3', spec_version: '2.0', name: '测试角色', description: 'desc', personality: 'p',
  scenario: 's', first_mes: '你好，我是测试角色。', mes_example: '', creatorcomment: '', avatar: 'none',
  talkativeness: 0.5, fav: false, tags: [],
  data: { name: '测试角色', description: 'desc', personality: 'p', scenario: 's', first_mes: '你好',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [],
    creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], extensions: {} },
};

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
type DB = { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[]; run(...a: unknown[]): { lastInsertRowid: number } } };
const dbOf = (s: ChatSession) => (s as unknown as { mem: { db: DB } }).mem.db;
const windowOf = (s: ChatSession) => (s as unknown as { buildChatWindow(r: number): { messages: { role: string; content: string }[]; truncated: boolean; tokens: number; startRound: number } }).buildChatWindow.bind(s);

async function main() {
  const dir = tmpdir();
  const cardFile = join(dir, 'fallback-card.json');
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');

  // ---- 场景1：turn 模型异常（非中止）→ rollbackFailedTurn 清孤儿 + 回退轮次 ----
  const db1 = join(dir, `fallback-test1-${Date.now()}.db`);
  const s1 = new ChatSession({ card: cardFile, db: db1, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] } as SessionArgs);
  (s1 as unknown as { client: unknown }).client = new FailClient();
  await s1.init();
  let rejected = false;
  try { await s1.turn('失败句', 'nsfw'); } catch { rejected = true; }
  check('场景1 模型异常 turn reject', rejected);
  const orphanBefore = (dbOf(s1).prepare("SELECT COUNT(*) c FROM chat_log WHERE round=1 AND role='user'").get() as { c: number }).c;
  check('场景1 失败后存在孤儿 user 行', orphanBefore === 1, `got ${orphanBefore}`);
  const r1 = s1.rollbackFailedTurn();
  check('场景1 rollbackFailedTurn 清理孤儿', r1.cleaned === true && r1.round === 1, `got ${JSON.stringify(r1)}`);
  const orphanAfter = (dbOf(s1).prepare("SELECT COUNT(*) c FROM chat_log WHERE round=1 AND role='user'").get() as { c: number }).c;
  check('场景1 孤儿 user 行已删', orphanAfter === 0, `got ${orphanAfter}`);
  const ledAfter = (dbOf(s1).prepare('SELECT COUNT(*) c FROM round_ledger WHERE round=1').get() as { c: number }).c;
  check('场景1 round 1 账本已清空', ledAfter === 0, `got ${ledAfter}`);
  // 轮次回退后正常重发 → 复用 round 1（不成孤儿）
  (s1 as unknown as { client: unknown }).client = new OkClient();
  await s1.turn('重发句', 'nsfw');
  const pairs1 = (dbOf(s1).prepare(
    `SELECT COUNT(*) c FROM (SELECT round FROM chat_log WHERE role='user') u
     LEFT JOIN (SELECT round FROM chat_log WHERE role='assistant') a ON a.round=u.round WHERE a.round IS NULL`,
  ).get() as { c: number }).c;
  check('场景1 重发后无孤儿（round 复用）', pairs1 === 0, `got ${pairs1}`);

  // ---- 场景2：历史遗留孤儿 → buildChatWindow 跳过 ----
  const db2 = join(dir, `fallback-test2-${Date.now()}.db`);
  const s2 = new ChatSession({ card: cardFile, db: db2, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] } as SessionArgs);
  (s2 as unknown as { client: unknown }).client = new OkClient();
  await s2.init();
  await s2.turn('第一句', 'nsfw');
  // 手工注入孤儿轮 2（有 user 无 assistant，模拟历史失败残留）
  dbOf(s2).prepare("INSERT INTO chat_log (round, role, content, created_at) VALUES (2, 'user', '孤儿输入', ?)").run(new Date().toISOString());
  const win = windowOf(s2)(2);
  check('场景2 buildChatWindow 跳过孤儿轮', !win.messages.some((m) => m.content === '孤儿输入'), `got ${JSON.stringify(win.messages)}`);
  check('场景2 窗口仍含正常轮', win.messages.some((m) => m.content === '第一句'), `got ${JSON.stringify(win.messages)}`);

  // ---- 场景3：regenerate 失败 → 占位 assistant 成对，无孤儿 ----
  const db3 = join(dir, `fallback-test3-${Date.now()}.db`);
  const s3 = new ChatSession({ card: cardFile, db: db3, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] } as SessionArgs);
  (s3 as unknown as { client: unknown }).client = new OkClient();
  await s3.init();
  await s3.turn('第一句', 'nsfw');
  (s3 as unknown as { client: unknown }).client = new FailClient();
  let rgRejected = false;
  try { await s3.regenerate(1); } catch { rgRejected = true; }
  check('场景3 regenerate 模型异常 reject', rgRejected);
  const pair3 = (dbOf(s3).prepare("SELECT COUNT(*) c FROM chat_log WHERE round=1 AND role='assistant'").get() as { c: number }).c;
  check('场景3 失败后 assistant 占位成对', pair3 === 1, `got ${pair3}`);
  const orphans3 = (dbOf(s3).prepare(
    `SELECT COUNT(*) c FROM (SELECT round FROM chat_log WHERE role='user') u
     LEFT JOIN (SELECT round FROM chat_log WHERE role='assistant') a ON a.round=u.round WHERE a.round IS NULL`,
  ).get() as { c: number }).c;
  check('场景3 无孤儿 user 行', orphans3 === 0, `got ${orphans3}`);
  const r3 = s3.rollbackFailedTurn();
  check('场景3 rollbackFailedTurn 幂等跳过(有 assistant)', r3.cleaned === false, `got ${JSON.stringify(r3)}`);

  for (const f of [db1, db2, db3]) { try { rmSync(f); rmSync(`${f}-wal`); rmSync(`${f}-shm`); } catch { /* 忽略 */ } }

  console.log(failures === 0 ? '\n失败兜底验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
await main();
