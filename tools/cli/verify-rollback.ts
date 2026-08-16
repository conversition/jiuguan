/**
 * 临时验证脚本：重新生成/删除历史/滑动窗口（FakeClient 无 API 成本）
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-rollback.ts
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from './session.ts';
import type { SessionArgs } from './session.ts';

const mkTurn = (prose: string, summary: string, barDelta: number) => JSON.stringify({
  plan: {
    thought: 't',
    key_events: [{ description: `事件${barDelta}` }],
    next_plan: '继续',
    event_type: 'normal',
    bars_delta: { personal: barDelta },
  },
  memory_delta: {
    delta_summary: summary,
    state_changes: [{ entity_type: 'protagonist', entity_id: 'hero', field: '好感', value: String(barDelta), action: 'upsert' }],
    new_events: [],
  },
  prose,
});

class FakeClient {
  seq = 0;
  constructor(private prose: string, private summary: string, private barDelta: number) {}
  async stream(_req: unknown) {
    const arg = mkTurn(`${this.prose}#${this.seq}`, this.summary, this.barDelta);
    this.seq++;
    return { content: null, toolCalls: [{ id: 'tc1', name: 'game_turn', arguments: arg }], finishReason: 'tool_calls', usage: null, raw: {} };
  }
  async complete() {
    return { content: '滚动摘要：角色经历关键事件，目标延续。', toolCalls: [], finishReason: 'stop', usage: null, raw: {} };
  }
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
const barsOf = (s: ChatSession) => JSON.parse((s as unknown as { getMeta(): { bars: string } | null }).getMeta()?.bars ?? '{}') as Record<string, number>;
const sql = (s: ChatSession, q: string) => (s as unknown as { mem: { db: { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[] } } } }).mem.db.prepare(q);

async function main() {
  const dir = tmpdir();
  const cardFile = join(dir, 'rollback-card.json');
  const dbFile = join(dir, `rollback-test-${Date.now()}.db`);
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');
  const args: SessionArgs = { card: cardFile, db: dbFile, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] };
  const s = new ChatSession(args);
  (s as unknown as { client: unknown }).client = new FakeClient('正文', '摘要A', 5);
  await s.init();

  // ---- 回归：回合写入与推进槽 ----
  await s.turn('第一句', 'nsfw');
  await s.turn('第二句', 'nsfw');
  check('两轮后 bars=10', barsOf(s).personal === 10, `got ${barsOf(s).personal}`);
  check('插槽 round=2', (s as unknown as { round: number }).round === 2);
  const stateCount = (sql(s, 'SELECT COUNT(*) c FROM memory_state').get() as { c: number }).c;
  check('memory_state 有 protagonist 行', stateCount >= 1);
  const chatCount = (sql(s, 'SELECT COUNT(*) c FROM chat_log').get() as { c: number }).c;
  check('chat_log = 开场白+2轮×2', chatCount === 5, `got ${chatCount}`);

  // ---- 重新生成 round 2（bars_delta 每轮 +5/+3 区分）----
  (s as unknown as { client: unknown }).client = new FakeClient('重新生成正文', '摘要B', 3);
  const rg = await s.regenerate(2);
  check('regenerate 返回新 prose', rg.prose.startsWith('重新生成正文'));
  check('regenerate 后 bars=8 (5+3，回滚生效)', barsOf(s).personal === 8, `got ${barsOf(s).personal}`);
  check('regenerate 后 round=2', rg.round === 2);
  // 无孤儿 AM 码：summary 与 arc 一一对应
  const orphans = (sql(s, 'SELECT COUNT(*) c FROM memory_summary s LEFT JOIN memory_arc a ON a.code=s.code WHERE a.code IS NULL').get() as { c: number }).c;
  check('无双表孤儿 AM 码', orphans === 0, `got ${orphans}`);

  // ---- 删除 round 2 整轮 ----
  s.deleteMessages(2, 'round');
  check('删除后 bars=5', barsOf(s).personal === 5, `got ${barsOf(s).personal}`);
  const chat2 = (sql(s, 'SELECT COUNT(*) c FROM chat_log').get() as { c: number }).c;
  check('删除后 chat_log=3（开场白+第1轮）', chat2 === 3, `got ${chat2}`);

  // ---- fromHere 删除全部轮次 ----
  s.deleteMessages(1, 'fromHere');
  check('fromHere 后 bars=0', barsOf(s).personal === 0, `got ${barsOf(s).personal}`);
  const chat3 = (sql(s, 'SELECT COUNT(*) c FROM chat_log').get() as { c: number }).c;
  check('fromHere 后 chat_log=1（仅开场白）', chat3 === 1, `got ${chat3}`);

  // ---- 滑动窗口 + 滚动摘要 ----
  process.env.JG_WINDOW_N = '3';
  process.env.JG_SUMMARY_ROUNDS = '2';
  process.env.JG_WINDOW_TOKENS = '600';
  const s2 = new ChatSession({ ...args, db: join(dir, `rollback-test2-${Date.now()}.db`) });
  (s2 as unknown as { client: unknown }).client = new FakeClient('长对话正文', '摘要', 1);
  await s2.init();
  for (let i = 1; i <= 6; i++) await s2.turn(`第${i}句话，内容各不相同以产生足够文字`, 'nsfw');
  const win = (s2 as unknown as { buildChatWindow(r: number): { messages: unknown[]; truncated: boolean; tokens: number } }).buildChatWindow(5);
  check('窗口条数 ≤ WINDOW_N=3', win.messages.length <= 3, `got ${win.messages.length}`);
  const longterm = ((sql(s2, 'SELECT longterm FROM memory_meta WHERE id=1').get() ?? {}) as { longterm?: string }).longterm ?? '';
  check('滚动摘要触发后 longterm 非空', longterm.length > 0, `got ${JSON.stringify(longterm)}`);
  const sr = ((sql(s2, 'SELECT summary_round FROM memory_meta WHERE id=1').get() ?? {}) as { summary_round?: number }).summary_round ?? 0;
  check('summary_round > 0', sr > 0, `got ${sr}`);

  // ---- 剧情分支索引（AI 生成 + 按轮缓存）----
  const idx1 = await s2.generateStoryIndex(4);
  check('story-index 生成非空', idx1.content.length > 0, `got ${JSON.stringify(idx1.content.slice(0, 24))}`);
  check('story-index 首次为 AI 生成', idx1.fromCache === false);
  const idx2 = await s2.generateStoryIndex(4);
  check('story-index 二次命中缓存', idx2.fromCache === true);
  const idxMiss = await s2.generateStoryIndex(5);
  check('story-index 不同轮不误命中', idxMiss.fromCache === false);

  s['mem']['db'].close();
  s2['mem']['db'].close();
  try { rmSync(cardFile, { force: true }); rmSync(dbFile, { force: true }); } catch { /* ignore */ }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('测试异常:', e); process.exit(2); });