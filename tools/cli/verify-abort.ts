/**
 * 临时验证脚本：中止生成落库（幂等 + 不写记忆）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-abort.ts
 */
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from './session.ts';
import type { SessionArgs } from './session.ts';
import { AbortTurnError } from '../../packages/proxy/src/client.ts';

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

/** 中止模型：模拟用户停止 → stream 抛 AbortTurnError */
class AbortClient {
  async stream() { throw new AbortTurnError(); }
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
const sql = (s: ChatSession, q: string) => (s as unknown as { mem: { db: { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[] } } } }).mem.db.prepare(q);
const barsOf = (s: ChatSession) => JSON.parse((s as unknown as { getMeta(): { bars: string } | null }).getMeta()?.bars ?? '{}') as Record<string, number>;

async function main() {
  const dir = tmpdir();
  const cardFile = join(dir, 'abort-card.json');
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');

  // ---- 场景1：turn 正常完成一轮后，直接 finalizeAbortedRound（模拟前端停止但 turn 已完成的竞态）----
  const db1 = join(dir, `abort-test1-${Date.now()}.db`);
  const s1 = new ChatSession({ card: cardFile, db: db1, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] } as SessionArgs);
  (s1 as unknown as { client: unknown }).client = new OkClient();
  await s1.init();
  await s1.turn('第一句', 'nsfw');
  check('场景1 正常轮 bars=5', barsOf(s1).personal === 5, `got ${barsOf(s1).personal}`);
  const r1 = await s1.finalizeAbortedRound(1);
  check('场景1 finalizeAbortedRound 幂等跳过(已完整)', r1.kept === false, `got ${JSON.stringify(r1)}`);
  const chat1 = (sql(s1, 'SELECT COUNT(*) c FROM chat_log').get() as { c: number }).c;
  check('场景1 chat_log=3（开场白+1轮完整）', chat1 === 3, `got ${chat1}`);

  // ---- 场景2：turn 被 AbortTurnError 中断 → 部分正文落库 + 不写记忆 + 空 ledger ----
  const db2 = join(dir, `abort-test2-${Date.now()}.db`);
  const s2 = new ChatSession({ card: cardFile, db: db2, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] } as SessionArgs);
  (s2 as unknown as { client: unknown }).client = new AbortClient();
  await s2.init();
  // 流式回调记录部分正文（模拟 SSE 已发出 "半截"）
  let partial = '';
  const prose = await s2.turn('第二句', 'nsfw', (chunk) => { partial += chunk; });
  check('场景2 turn 返回占位（无正文可留）', prose.includes('已停止生成'), `got ${JSON.stringify(prose)}`);
  check('场景2 bars 未推进（记忆未写）', barsOf(s2).personal === 0, `got ${barsOf(s2).personal}`);
  const assist2 = (sql(s2, "SELECT content FROM chat_log WHERE round=1 AND role='assistant'").get() as { content: string });
  check('场景2 assistant 占位已落库', assist2?.content.includes('已停止生成'), `got ${JSON.stringify(assist2)}`);
  const led2 = (sql(s2, 'SELECT created FROM round_ledger WHERE round=1').get() as { created: string });
  const created2 = JSON.parse(led2?.created ?? '{}');
  check('场景2 ledger 空 created（可回滚）', created2.mainCode === '' && (created2.eventCodes ?? []).length === 0, `got ${JSON.stringify(created2)}`);
  const state2 = (sql(s2, "SELECT COUNT(*) c FROM memory_state WHERE entity_id='hero'").get() as { c: number }).c;
  check('场景2 无 hero 状态行（写环跳过）', state2 === 0, `got ${state2}`);

  // ---- 场景3：AbortTurnError 已落库后再次 finalizeAbortedRound（幂等）----
  const r3 = await s2.finalizeAbortedRound(1);
  check('场景3 finalizeAbortedRound 幂等(已落库)', r3.kept === false, `got ${JSON.stringify(r3)}`);

  // ---- 场景4：regenerate 中止（round 已知）----
  (s2 as unknown as { client: unknown }).client = new AbortClient();
  const rg = await s2.regenerate(1);
  check('场景4 regenerate 中止返回占位', rg.prose.includes('已停止生成'), `got ${JSON.stringify(rg.prose)}`);
  const assist4 = (sql(s2, "SELECT content FROM chat_log WHERE round=1 AND role='assistant'").get() as { content: string });
  check('场景4 中止后 assistant 占位更新', assist4?.content.includes('已停止生成'), `got ${JSON.stringify(assist4)}`);
  const led4 = (sql(s2, 'SELECT created FROM round_ledger WHERE round=1').get() as { created: string });
  check('场景4 ledger 空 created', (JSON.parse(led4?.created ?? '{}')).mainCode === '', `got ${JSON.stringify(led4)}`);

  for (const f of [db1, db2]) { try { rmSync(f); rmSync(`${f}-wal`); rmSync(`${f}-shm`); } catch { /* 忽略 */ } }

  console.log(failures === 0 ? '\n中止验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
await main();
