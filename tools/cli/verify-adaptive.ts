/**
 * 验证脚本：AQL 自适应引擎 + 检索两回路（retrieval.setAdaptive / 纪要 Δ / 别名补齐 / 回滚）
 * 1) RRF 权重复活：DEFAULT_WEIGHTS 真正参与融合（wBm25=0 → bm25 命中消失）
 * 2) boostIds 强制保留（天然分未过门也补入，high 置信）
 * 3) dropThreshold 覆盖（=2 → 全丢）
 * 4) 纪要 Δ：longtermTokensDelta 改变长期摘要注入长度
 * 5) 别名补齐 + boosted query 锚点；reset 全部回滚到 env/默认
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-adaptive.ts
 */
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { estimateTokens } from '../../packages/prompt/src/assembly.ts';
import { resetAdaptiveConfig } from '../../packages/prompt/src/adaptive.ts';
import { ChatSession } from './session.ts';
import type { SessionArgs } from './session.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const sql = (s: ChatSession, q: string) => (s as unknown as { mem: { db: { prepare(st: string): { get(a?: unknown): unknown; all(a?: unknown): unknown[] } } } }).mem.db.prepare(q);

const CARD = {
  spec: 'chara_card_v3', spec_version: '2.0', name: '自适应测试', description: 'desc', personality: 'p',
  scenario: 's', first_mes: '你好。', mes_example: '', creatorcomment: '', avatar: 'none',
  talkativeness: 0.5, fav: false, tags: [],
  data: { name: '自适应测试', description: 'desc', personality: 'p', scenario: 's', first_mes: '你好',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [],
    creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], extensions: {} },
};

async function main() {
  // ---- Part 1: retrieval 纯层（内存库，无 API）----
  const mem = new MemoryDb();
  mem.db.prepare(`INSERT INTO lorebook_entry (uid, book, key, comment, content, active) VALUES ('u1','b1','k1','关键词甲角色','关键词甲 的角色设定内容很长',1)`).run();
  mem.db.prepare(`INSERT INTO lorebook_entry (uid, book, key, comment, content, active) VALUES ('u2','b1','k2','空前绝后标题','某一实体设定',1)`).run();
  const ret = new RetrievalEngine(mem);

  const id1 = (mem.db.prepare("SELECT id FROM lorebook_entry WHERE comment='关键词甲角色'").get() as { id: number }).id;
  const id2 = (mem.db.prepare("SELECT id FROM lorebook_entry WHERE comment='空前绝后标题'").get() as { id: number }).id;
  const baseRecall = () => ret.recall({ query: '关键词甲', budgetTokens: 600 });

  check('默认 RRF（bm25 权重 0.45）命中词条', baseRecall().hits.some((h) => h.rowId === id1), '');
  ret.setAdaptive({ weights: { wBm25: 0 } });
  check('wBm25=0 → bm25 通道贡献为零 → 词条消失（权重参与融合）', !baseRecall().hits.some((h) => h.rowId === id1), '');
  ret.setAdaptive({});
  check('setAdaptive({}) 回落默认命中', baseRecall().hits.some((h) => h.rowId === id1), '');

  ret.setAdaptive({ boostIds: [id2] });
  const boosted = ret.recall({ query: '完全无关词XYZ', budgetTokens: 600 });
  check('boostIds 强制保留完全未召回 id（high 置信）', boosted.hits.some((h) => h.rowId === id2 && h.confidence === 'high'), `got ${boosted.hits.map((h) => h.rowId)}`);
  ret.setAdaptive({});

  ret.setAdaptive({ dropThreshold: 2 });
  check('dropThreshold=2 → 归一化分全低于门槛 → 全丢', baseRecall().hits.length === 0, `len=${baseRecall().hits.length}`);
  ret.setAdaptive({});

  // ---- Part 2: 会话层（纪要 Δ / 别名 / query 锚点 / 回滚）----
  const dir = tmpdir();
  const cardFile = join(dir, 'adaptive-card.json');
  const dbFile = join(dir, `adaptive-test-${Date.now()}.db`);
  const adaptiveFile = join(dir, `adaptive-test-${Date.now()}.json`);
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');
  process.env.JG_ADAPTIVE_CONFIG = adaptiveFile;
  process.env.JG_LONGTERM_TOKENS = '800';
  writeFileSync(adaptiveFile, JSON.stringify({
    summary: { longtermTokensDelta: 700 },
    archive: { aliasAdditions: [{ alias: '测试别名', entityName: '桐月樱佳' }] },
    retrieval: { boostIds: [] },
  }), 'utf8');

  const args: SessionArgs = { card: cardFile, db: dbFile, resume: false, useBge: false, contentMode: 'nsfw', worldbooks: [] };
  const s = new ChatSession(args);
  (s as unknown as { client: unknown }).client = {
    async stream() { return { content: null, toolCalls: [{ name: 'game_turn', arguments: '{}' }], finishReason: 'tool_calls', usage: null, raw: {} }; },
    async complete() { return { content: '摘要', toolCalls: [], finishReason: 'stop', usage: null, raw: {} }; },
  };
  await s.init();
  const cast = s as unknown as { effectiveLongtermTokens(): number; effectiveSummaryRounds(): number; buildRecallQuery(i: string, b: Record<string, number>): string; buildEntityRoster(): Map<string, { entityName: string }> };

  check('纪要 Δ：longterm 有效预算 800+700=1500', cast.effectiveLongtermTokens() === 1500, `got ${cast.effectiveLongtermTokens()}`);
  // 别名补齐（此时配置含 archive.aliasAdditions）
  const roster = cast.buildEntityRoster();
  check('adaptive 别名并入名册', roster.has('测试别名') && roster.get('测试别名')?.entityName === '桐月樱佳', '');
  const longText = '这是一段很长的长期摘要剧情内容，'.repeat(300); // ~3300 字
  sql(s, 'UPDATE memory_meta SET longterm = ? WHERE id = 1').run(longText) as unknown;
  const blkDefault = (s as unknown as { getLongTermBlock(): string }).getLongTermBlock();
  writeFileSync(adaptiveFile, JSON.stringify({ summary: { longtermTokensDelta: 0 } }), 'utf8');
  s.refreshAdaptive();
  const blkDelta0 = (s as unknown as { getLongTermBlock(): string }).getLongTermBlock();
  check('Δ 生效：longtermTokensDelta=700 → 注入更长摘要', estimateTokens(blkDefault) > estimateTokens(blkDelta0) + 100, `${estimateTokens(blkDefault)} vs ${estimateTokens(blkDelta0)}`);

  // boosted query 锚点
  sql(s, `INSERT INTO lorebook_entry (uid, book, key, comment, content, active) VALUES ('uB','b','k','被提升词条','内容',1)`).run() as unknown;
  const bid = (sql(s, "SELECT id FROM lorebook_entry WHERE comment='被提升词条'").get() as { id: number }).id;
  writeFileSync(adaptiveFile, JSON.stringify({ retrieval: { boostIds: [bid] }, archive: { aliasAdditions: [{ alias: '测试别名', entityName: '桐月樱佳' }] } }), 'utf8');
  s.refreshAdaptive();
  check('boosted 词条名并入 recall query 锚点', cast.buildRecallQuery('随便', {}).includes('被提升词条'), `q=${cast.buildRecallQuery('随便', {}).slice(0, 60)}`);

  // 回滚：reset → 全部回落
  resetAdaptiveConfig();
  s.refreshAdaptive();
  check('reset 后 longterm Δ 归零（回 800）', cast.effectiveLongtermTokens() === 800, `got ${cast.effectiveLongtermTokens()}`);
  check('reset 后别名移除', !cast.buildEntityRoster().has('测试别名'), '');
  check('reset 后 boost 锚点移除', !cast.buildRecallQuery('随便', {}).includes('被提升词条'), '');

  s['mem']['db'].close();
  try { rmSync(cardFile, { force: true }); rmSync(dbFile, { force: true }); rmSync(adaptiveFile, { force: true }); } catch { /* ignore */ }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('测试异常:', e); process.exit(2); });