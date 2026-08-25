/**
 * 验证脚本：AQL 归因聚合（M3）
 * 造一个小会话库（turn_ledger + chat_log + lorebook_entry）→ analyzeQuality 应产出：
 *  - 高重试词条建议（rag/high，lore#id）
 *  - 用户提到未注入（miss）建议（alias#…）
 *  - 摘要边界分桶高负反馈建议（summary/low）
 *  - 模型建议 + 负反馈率
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-quality-analyzer.ts
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { analyzeQuality } from './quality.ts';
import type { QualityReport } from './quality.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

function main() {
  process.env.JG_QUALITY_MIN_SAMPLE = '2';
  const mem = new MemoryDb(); // in-memory

  // 世界书条目（主动检索 base）
  mem.db.prepare(`INSERT INTO lorebook_entry (uid, book, key, comment, content, constant, active) VALUES ('u1','b1','k','桐月樱佳','桐月樱佳 是学生会长设定内容很长',0,1)`).run();
  mem.db.prepare(`INSERT INTO lorebook_entry (uid, book, key, comment, content, constant, active) VALUES ('u2','b1','k','班长','班长 设定内容',0,1)`).run();
  // 开场白 + 用户消息
  mem.db.prepare(`INSERT INTO chat_log (round, role, content) VALUES (0,'assistant','你好')`).run();
  const userMsg = [
    '你好', '你好吗', '桐月樱佳今天做什么', '再来一次', '继续', '学校在聊什么', '桐月樱佳呢', '桐月樱佳到底怎样',
  ];
  for (let i = 1; i <= 8; i++) {
    mem.db.prepare(`INSERT INTO chat_log (round, role, content) VALUES (?, 'user', ?)`).run(i, userMsg[i - 1]);
    mem.db.prepare(`INSERT INTO chat_log (round, role, content) VALUES (?, 'assistant', 'r')`).run(i);
  }
  // 遥测：round1..8（负反馈 = 重发/中止轮：4,5,7,8）
  const rows: [number, number, string, number[] | null, number][] = [
    [1, 0, 'ok', [], 2],
    [2, 0, 'ok', [1], 3],
    [3, 0, 'ok', [], 4],
    [4, 1, 'ok', [1], 5],
    [5, 2, 'ok', [1, 2], 6],
    [6, 0, 'ok', [1], 1],
    [7, 0, 'aborted', [2], 2],
    [8, 1, 'ok', [2], 3],
  ];
  const ins = mem.db.prepare(
    `INSERT INTO turn_ledger (session_id, round, attempt, retry_index, clicked_regenerate, outcome, token_cost, context_fingerprint, reward)
     VALUES ('test', ?, 1, ?, 0, ?, 100, ?, '{"score":1}')`
  );
  for (const [r, ri, outcome, scanIds, dist] of rows) {
    const fp = {
      recallHitIds: [], scanEntryIds: scanIds, archiveIds: [],
      windowCount: 4, windowTokens: 120, windowTruncated: false,
      distanceToSummary: dist, longtermTokens: 100, model: 'm1', bars: {},
    };
    ins.run(r, ri, outcome, JSON.stringify(fp));
  }

  const report = analyzeQuality(mem.db, 'data/session-1234567890.db');
  check('rounds=8 / 负反馈=4', report.rounds === 8 && report.negativeRounds === 4, `${report.rounds}/${report.negativeRounds}`);
  check('retryRate=0.5', report.retryRate === 0.5, `got ${report.retryRate}`);
  const e1 = report.entries.find((e) => e.id === 1) ?? ({} as QualityReport['entries'][number]);
  check('词条 id1 出现 4 / 负反馈 2 / 率 0.5', e1.appeared === 4 && e1.negative === 2 && e1.rate === 0.5, JSON.stringify(e1));
  check('词条 id1 miss 3 且负反馈 miss 2', e1.miss === 3 && e1.missNegative === 2, `miss=${e1.miss} neg=${e1.missNegative}`);
  const rag = report.suggestions.filter((s) => s.dimension === 'rag' && s.risk === 'high');
  check('产出高重试词条建议 rag/high lore#1', rag.some((s) => s.target === 'lore#1' && s.sample >= 2), JSON.stringify(rag));
  const aliasSug = report.suggestions.find((s) => s.dimension === 'rag' && s.target.startsWith('alias'));
  check('产出 miss 建议（用户提到未注入）', Boolean(aliasSug && aliasSug.sample >= 2), JSON.stringify(aliasSug));
  check('产出摘要边界低风险建议', report.suggestions.some((s) => s.dimension === 'summary' && s.risk === 'low'), JSON.stringify(report.suggestions.filter((s) => s.dimension === 'summary')));
  check('产出模型建议', report.suggestions.some((s) => s.dimension === 'model'), '');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
main();