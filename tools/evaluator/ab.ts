/**
 * A/B 评测：基线装配 vs L1/L2 调度装配（mock，零 API 成本）
 * 维度：
 *   1) 召回命中 —— 检索 query 增强（24 字截断 vs 完整输入+实体+推进槽）
 *   2) 注入 token —— 世界书条件化门控（滤除「激活但与在场/场景无关」条目）+ 全局预算裁剪
 * 种子库构造与 run.ts seedFacts 同口径（lorebook 常驻行 + 摘要写环）。
 * 用法：node --experimental-strip-types --experimental-transform-types tools/evaluator/ab.ts
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { scheduleContext, blockTokens } from '../../packages/prompt/src/context-scheduler.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

/** 在场实体分词（镜像 session.presentEntities，A/B 用） */
const presentEntities = (input: string): string[] => input.split(/[，。！？、,.!?\s]+/).filter((s) => s.length >= 2 && s.length <= 8).slice(0, 6);

/** 增强检索 query（镜像 session.buildRecallQuery：实体裸词同形，FTS/LIKE 才命中） */
const enhancedQuery = (input: string, bars: Record<string, number>): string =>
  [input, ...presentEntities(input), Object.entries(bars).map(([k, v]) => `${k}:${v}`).join(' ')].filter(Boolean).join(' ').slice(0, 120);

/** 世界书条件化门控口径（镜像 session.gatedWorldbookBlock：恒常保留 + 在场实体/场景相关保留） */
const gatedEntries = (entries: { constant: boolean; comment: string; content: string }[], present: string[], scene: string): typeof entries =>
  entries.filter((e) => e.constant || (() => { const t = `${e.comment} ${e.content}`; return present.some((p) => t.includes(p)) || (scene.length > 0 && t.includes(scene)); })());

function main() {
  // ==== 维度1：召回命中 ============================================================
  // 种子关键词出现在输入「24 字截断」之外的段落，暴露截断缺陷
  const mem1 = new MemoryDb();
  const writer1 = new WriteLoop(mem1);
  const insertLore1 = mem1.db.prepare(
    'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const seeds = [
    { kw: '古堡', content: '巫师古堡藏于黑森林深处，传闻有千年诅咒' },
    { kw: '魔药', content: '魔药由龙血与月露调配，可令死者回响' },
    { kw: '龙血', content: '剑刃淬过龙血后永不锈蚀，代价是持有者渐渐失忆' },
  ];
  seeds.forEach((s, i) => {
    writer1.execute({ delta_summary: s.content, round: i + 1 });
    insertLore1.run(String(i), 'seed', s.kw, s.kw, s.content, 0, 0, 1, 0, '[]', 100, 0, 1);
  });
  writer1.initMeta({}, {});
  const ret = new RetrievalEngine(mem1);
  const inputs = [
    '清晨出发时，我们沿山路走了大半天，黄昏与雾气渐浓，古堡，就在前方黑森林的深处若隐若现，传来低语。',
    '老医者翻遍药典三日，烛火将白发映得惨淡，魔药，若想配成，尚缺一味龙血与月露，他叹着气合上了书。',
    '骑士从战场归来的那个傍晚，雨水浸透旧甲，剑刃上的一线暗红，龙血，据传可以永不锈蚀，记忆却渐渐剥落。',
  ];
  let baseHit = 0;
  let enhHit = 0;
  for (const [i, input] of inputs.entries()) {
    const kw = seeds[i].kw;
    const baseQuery = input.slice(0, 24);
    const enhQuery = enhancedQuery(input, { main: 3 });
    const baseHitNow = baseQuery.includes(kw) || ret.recall({ query: baseQuery, round: 10, budgetTokens: 300 }).hits.length > 0;
    const enhHitNow = enhQuery.includes(kw) && ret.recall({ query: enhQuery, round: 10, budgetTokens: 300 }).hits.length > 0;
    if (baseHitNow) baseHit++;
    if (enhHitNow) enhHit++;
  }
  console.log(`\n[召回] 基线(24字)命中 ${baseHit}/${inputs.length} | 增强(全输入+实体+推进槽)命中 ${enhHit}/${inputs.length}`);
  check('召回：增强命中 ≥ 基线', enhHit >= baseHit, `base=${baseHit} enh=${enhHit}`);
  check('召回：增强对「关键词在后半段」真实抬升', enhHit >= 2, `enh=${enhHit}`);

  // ==== 维度2：注入 token（世界书门控 + 全局预算） ================================
  const mem2 = new MemoryDb();
  const insertLore = mem2.db.prepare(
    'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  // 酒保(恒常)；麦酒-内容含酒保→相关；麦酒旧闻-内容指向北方骑士→无关（无在场/场景词）
  const entries = [
    { key: '酒保', comment: '本店酒保', content: '酒保擦拭酒杯，寡言', constant: 1 },
    { key: '麦酒', comment: '熟客常点的麦酒', content: '酒保从柜台下取出五大杯麦酒', constant: 0 },
    { key: '麦酒', comment: '一则旧闻', content: '北方骑士的麦酒杯沿刻着家徽', constant: 0 },
  ];
  entries.forEach((e, i) => {
    insertLore.run(String(i), 'seed', e.key, e.comment, e.content, 0, 0, e.constant, 0, e.constant ? '[]' : e.key, 100, 0, 1);
  });
  const scanner = new LorebookScanner(mem2);
  const scan = scanner.scan({ text: '我走进酒馆，向酒保要了杯麦酒', seed: 1, budgetTokens: 1200 });
  const scene = '酒馆';
  const present = ['酒保', '旅人'];
  const fmt = (e: { constant: boolean; matchType: string; comment: string; content: string }) => `[${e.constant ? '恒定' : e.matchType}] ${e.comment}: ${e.content.slice(0, 200)}`;
  const allActivated = scan.activated;
  const gated = gatedEntries(allActivated, present, scene);
  const baseTokens = allActivated.reduce((acc, e) => acc + blockTokens(fmt(e)), 0);
  const gatedTokens = gated.reduce((acc, e) => acc + blockTokens(fmt(e)), 0);
  console.log(`\n[注入] 世界书激活 ${allActivated.length} 条：${allActivated.map((e) => e.comment).join('/')}`);
  console.log(`[注入] 门控后 ${gated.length} 条：${gated.map((e) => e.comment).join('/')}（恒定+在场/场景相关；滤除「酒馆旧闻」）`);
  check('注入：门控滤除无关条目（激活3条→门控2条）', gated.length === allActivated.length - 1 && allActivated.length >= 3, `${gated.length} vs ${allActivated.length}`);
  check('注入：门控 token ≤ 基线', gatedTokens <= baseTokens, `${gatedTokens} vs ${baseTokens}`);

  // 全局预算：世界状态块 + 门控后世界书 + 记忆块放小预算 → 低优先级被裁
  const ctxBudget = 90;
  const blocks = [
    { id: 'worldstate', fragment: '<世界状态>\n场景: 酒馆\n在场: 酒保、旅人\n推进槽: {"main":3}', cost: 500, priority: 90 },
    { id: 'memory', fragment: '记忆召回：旅人说北境狼患', cost: 400, priority: 75 },
    { id: 'worldbook', fragment: gated.map(fmt).join('\n'), cost: 1200, priority: 60 },
  ];
  const sched = scheduleContext(blocks, ctxBudget);
  const baseAllTokens = baseTokens + blockTokens(blocks[0].fragment) + blockTokens(blocks[1].fragment);
  console.log(`\n[预算] 基线堆积 ${baseAllTokens}t vs 全局闸 ${ctxBudget}t → 调度保留 ${sched.totalTokens}t（裁 ${sched.dropped.map((d) => `${d.id}:${d.reason}`).join('、') || '无'}）`);
  check('预算：调度后总 token ≤ 闸', sched.totalTokens <= ctxBudget, `sched=${sched.totalTokens}`);
  check('预算：调度少于基线堆积', sched.totalTokens < baseAllTokens, `${sched.totalTokens} vs ${baseAllTokens}`);
  check('预算：低优先级世界书被裁（宁丢勿裁）', sched.dropped.some((d) => d.id === 'worldbook' && d.reason === 'over-budget'), JSON.stringify(sched.dropped));

  console.log(failures === 0 ? '\nA/B 评测通过：调度装配在召回与 token 双维度均优于/不劣于基线 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();