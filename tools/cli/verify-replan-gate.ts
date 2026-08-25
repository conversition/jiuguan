/**
 * 验证脚本：AQL 循环C 规划增强门（先收窄再重规划）
 * 场景：retry ≥ narrowK(1) → 上下文收窄（滑窗轮数减半，零额外 LLM）；
 *       retry ≥ replanK(2) → 导演式重规划建议生成（一次 LLM），不进 chat_log。
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-replan-gate.ts
 */
import { writeFileSync, rmSync } from 'node:fs';
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
  streamCalls = 0;
  completeCalls = 0;
  constructor(private prose: string, private summary: string, private barDelta: number) {}
  async stream(_req: unknown) {
    this.streamCalls++;
    const arg = mkTurn(this.prose, this.summary, this.barDelta);
    return { content: null, toolCalls: [{ id: 'tc1', name: 'game_turn', arguments: arg }], finishReason: 'tool_calls', usage: null, raw: {} };
  }
  async complete() {
    this.completeCalls++;
    return { content: '【重写方向】聚焦桐月樱佳的日程秘密，场景推进到天台，留意角色专属称呼。', toolCalls: [], finishReason: 'stop', usage: null, raw: {} };
  }
}

const CARD = {
  spec: 'chara_card_v3', spec_version: '2.0', name: '规划门测试', description: 'desc', personality: 'p',
  scenario: 's', first_mes: '你好。', mes_example: '', creatorcomment: '', avatar: 'none',
  talkativeness: 0.5, fav: false, tags: [],
  data: { name: '规划门测试', description: 'desc', personality: 'p', scenario: 's', first_mes: '你好',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [],
    creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], extensions: {} },
};

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const sql = (s: ChatSession, q: string) => (s as unknown as { mem: { db: { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[] } } } }).mem.db.prepare(q);

async function main() {
  const dir = tmpdir();
  const cardFile = join(dir, 'replan-card.json');
  const dbFile = join(dir, `replan-test-${Date.now()}.db`);
  const adaptiveFile = join(dir, `adaptive-replan-${Date.now()}.json`);
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');
  writeFileSync(adaptiveFile, JSON.stringify({ replan: { narrowK: 1, replanK: 2 }, summary: { roundsDelta: 0 } }), 'utf8');
  process.env.JG_ADAPTIVE_CONFIG = adaptiveFile;
  process.env.JG_WINDOW_N = '6';
  process.env.JG_SUMMARY_ROUNDS = '100'; // 关掉滚动摘要干扰（complete 计数用于重规划断言）
  const args: SessionArgs = { card: cardFile, db: dbFile, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] };
  const fc = new FakeClient('正文', '摘要', 1);
  const s = new ChatSession(args);
  (s as unknown as { client: unknown }).client = fc;
  await s.init();

  // 推进 6 轮形成 6 条窗口（默认 windowN=6 → 正常窗口 6 条）
  for (let i = 1; i <= 6; i++) await s.turn(`第${i}句话，内容各不相同`, 'nsfw');

  // ---- 第 1 次重发 round 6：retry=1 ≥ narrowK=1 → 收窄窗口（≤3 条），零额外 LLM（only 1 stream）----
  const beforeStream = fc.streamCalls;
  const beforeComplete = fc.completeCalls;
  const rg1 = await s.regenerate(6);
  check('第 1 次重发成功', rg1.prose.startsWith(fc['prose']) || rg1.prose.length > 0, `prose=${rg1.prose.slice(0, 20)}`);
  check('收窄重发仅 1 次 LLM 流（零额外模型往返）', fc.streamCalls - beforeStream === 1, `streamΔ=${fc.streamCalls - beforeStream}`);
  check('收窄重发不动 complete（无重规划/摘要）', fc.completeCalls - beforeComplete === 0, `completeΔ=${fc.completeCalls - beforeComplete}`);
  const fp1 = sql(s, "SELECT context_fingerprint FROM turn_ledger WHERE round = 6 AND retry_index = 1 ORDER BY id").get() as { context_fingerprint: string } | undefined;
  const f1 = fp1 ? JSON.parse(fp1.context_fingerprint) as { windowCount: number } : null;
  check('收窄轮窗口 ≤3 条（maxTurns=ceil(6/2)）', f1 !== null && f1.windowCount <= 3, `window=${f1?.windowCount}`);

  // ---- 第 2 次重发 round 6：retry=2 ≥ replanK=2 → 生成一次重规划建议（1 次 complete）----
  const beforeStream2 = fc.streamCalls;
  const beforeComplete2 = fc.completeCalls;
  const rg2 = await s.regenerate(6);
  check('第 2 次重发成功', rg2.prose.length > 0, '');
  check('重规划轮仍仅 1 次 LLM 流', fc.streamCalls - beforeStream2 === 1, `streamΔ=${fc.streamCalls - beforeStream2}`);
  check('重规划建议生成（complete +1）', fc.completeCalls - beforeComplete2 === 1, `completeΔ=${fc.completeCalls - beforeComplete2}`);
  check('regenerate 返回重写方向', typeof rg2.replanSuggestion === 'string' && rg2.replanSuggestion.length > 0, `got ${JSON.stringify(rg2.replanSuggestion)}`);
  const assist6 = (sql(s, "SELECT content FROM chat_log WHERE round = 6 AND role = 'assistant' ORDER BY id DESC LIMIT 1").get() as { content: string }).content;
  check('重规划建议未进 chat_log', !assist6.includes('重写方向') && !assist6.includes('日程秘密'), `assist=${assist6.slice(0, 30)}`);

  // ---- 第 3 次重发：同一 round 不应重复生成建议（replanGenerated 每轮仅一次）----
  const beforeComplete3 = fc.completeCalls;
  await s.regenerate(6);
  check('同一轮不再重复生成建议（complete 不变）', fc.completeCalls - beforeComplete3 === 0, `completeΔ=${fc.completeCalls - beforeComplete3}`);

  s['mem']['db'].close();
  try { rmSync(cardFile, { force: true }); rmSync(dbFile, { force: true }); rmSync(adaptiveFile, { force: true }); } catch { /* ignore */ }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('测试异常:', e); process.exit(2); });