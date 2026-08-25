/**
 * 验证脚本：AQL 信号底座（回合遥测 turn_ledger）
 * 场景：turn/regenerate 重发计数 + 旧正文 md5 + abort + delete；只追加写（不回滚路径读取）。
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-telemetry.ts
 */
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChatSession } from './session.ts';
import type { SessionArgs } from './session.ts';
import { AbortTurnError } from '../../packages/proxy/src/client.ts';

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
  mode: 'normal' | 'abort' = 'normal';
  constructor(private prose: string, private summary: string, private barDelta: number) {}
  async stream(_req: unknown) {
    if (this.mode === 'abort') throw new AbortTurnError();
    const arg = mkTurn(`${this.prose}#${this.seq}`, this.summary, this.barDelta);
    this.seq++;
    return { content: null, toolCalls: [{ id: 'tc1', name: 'game_turn', arguments: arg }], finishReason: 'tool_calls', usage: null, raw: {} };
  }
  async complete() {
    return { content: '【局势】紧张的剧情。', toolCalls: [], finishReason: 'stop', usage: null, raw: {} };
  }
}

const CARD = {
  spec: 'chara_card_v3', spec_version: '2.0', name: '遥测测试', description: 'desc', personality: 'p',
  scenario: 's', first_mes: '你好。', mes_example: '', creatorcomment: '', avatar: 'none',
  talkativeness: 0.5, fav: false, tags: [],
  data: { name: '遥测测试', description: 'desc', personality: 'p', scenario: 's', first_mes: '你好',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [],
    creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], extensions: {} },
};

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const sql = (s: ChatSession, q: string) => (s as unknown as { mem: { db: { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[] } } } }).mem.db.prepare(q);
const telOf = (s: ChatSession, q: string) => sql(s, q);
const md5 = (t: string) => createHash('md5').update(t).digest('hex');

async function main() {
  const dir = tmpdir();
  const cardFile = join(dir, 'tel-card.json');
  const dbFile = join(dir, `tel-test-${Date.now()}.db`);
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');
  const args: SessionArgs = { card: cardFile, db: dbFile, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] };
  const s = new ChatSession(args);
  (s as unknown as { client: unknown }).client = new FakeClient('正文', '摘要', 1);
  await s.init();

  // ---- 正常 turn：retry_index=0 / outcome=ok / 指纹+奖励落库 ----
  await s.turn('第一句', 'nsfw');
  await s.turn('第二句', 'nsfw');
  const r2ok = (telOf(s, "SELECT * FROM turn_ledger WHERE round = 2 AND outcome = 'ok' ORDER BY id").get() as Record<string, string | number | null> | undefined);
  check('turn 正常记 ok 遥测', Boolean(r2ok), `round2 ok=${Boolean(r2ok)}`);
  check('首轮 retry_index=0', r2ok?.retry_index === 0, `got ${r2ok?.retry_index}`);
  check('非重发 clicked_regenerate=0', r2ok?.clicked_regenerate === 0, `got ${r2ok?.clicked_regenerate}`);
  const fp = r2ok?.context_fingerprint ? JSON.parse(String(r2ok.context_fingerprint)) as Record<string, unknown> : null;
  check('指纹含 recallHitIds(数组)', fp !== null && Array.isArray(fp.recallHitIds), `got ${JSON.stringify(fp ?? {}).slice(0, 60)}`);
  check('指纹含 windowCount', fp !== null && typeof fp.windowCount === 'number', `got ${fp?.windowCount}`);
  const rw = r2ok?.reward ? JSON.parse(String(r2ok.reward)) as { score: number; acc: number } : null;
  check('ok 轮奖励 acc=1', rw !== null && rw.acc === 1 && rw.score === 1, `got ${JSON.stringify(rw)}`);

  // ---- regenerate：本轮首次重发 retry_index=1 + clicked_regenerate=1 + 旧正文 md5 ----
  const oldProse = (sql(s, "SELECT content FROM chat_log WHERE round = 2 AND role = 'assistant' ORDER BY id DESC LIMIT 1").get() as { content: string }).content;
  (s as unknown as { client: unknown }).client = new FakeClient('重发正文', '摘要B', 2);
  await s.regenerate(2);
  const r2rg1 = (telOf(s, "SELECT * FROM turn_ledger WHERE round = 2 AND clicked_regenerate = 1 ORDER BY id DESC").get() as Record<string, string | number | null>);
  check('首次重发 retry_index=1', r2rg1?.retry_index === 1, `got ${r2rg1?.retry_index}`);
  check('重发 outcome=ok', r2rg1?.outcome === 'ok', `got ${r2rg1?.outcome}`);
  check('重发 prev_prose_md5 = 旧正文 md5', r2rg1?.prev_prose_md5 === md5(oldProse), `got ${r2rg1?.prev_prose_md5} vs ${md5(oldProse)}`);

  // ---- 连续重发 2 次：retry_index 递增 2→3，遥测只追加（round 2 共 4 行）----
  (s as unknown as { client: unknown }).client = new FakeClient('重发正文X', '摘要B', 2);
  await s.regenerate(2);
  await s.regenerate(2);
  const lastRg = (telOf(s, "SELECT retry_index FROM turn_ledger WHERE round = 2 AND clicked_regenerate = 1 ORDER BY retry_index DESC LIMIT 1").get() as { retry_index: number }).retry_index;
  check('第 3 次重发 retry_index=3', lastRg === 3, `got ${lastRg}`);
  const count2 = (sql(s, 'SELECT COUNT(*) c FROM turn_ledger WHERE round = 2').get() as { c: number }).c;
  check('round 2 遥测只追加（ok+3 次重发=4 行）', count2 === 4, `got ${count2}`);

  // ---- abort：outcome=aborted（AbortTurnError 直达）----
  const fc = new FakeClient('中止正文', '摘要C', 0);
  fc.mode = 'abort';
  (s as unknown as { client: unknown }).client = fc;
  await s.turn('第三句', 'nsfw');
  const r3ab = (telOf(s, "SELECT outcome FROM turn_ledger WHERE round = 3 ORDER BY id DESC").get() as { outcome: string });
  check('中止轮 outcome=aborted', r3ab?.outcome === 'aborted', `got ${r3ab?.outcome}`);
  const abortAssist = (sql(s, "SELECT content FROM chat_log WHERE round = 3 AND role = 'assistant'").get() as { content: string } | undefined);
  check('中止轮有占位正文', Boolean(abortAssist), `got ${Boolean(abortAssist)}`);

  // ---- delete：outcome=deleted 且重发计数清理 ----
  s.deleteMessages(1, 'round');
  const r1del = (telOf(s, "SELECT outcome FROM turn_ledger WHERE round = 1 ORDER BY id DESC").get() as { outcome: string });
  check('删除轮记 deleted 遥测', r1del?.outcome === 'deleted', `got ${r1del?.outcome}`);
  s['mem']['db'].close();
  try { rmSync(cardFile, { force: true }); rmSync(dbFile, { force: true }); } catch { /* ignore */ }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('测试异常:', e); process.exit(2); });