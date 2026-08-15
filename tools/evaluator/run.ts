/**
 * Golden-session 评测器 CLI
 * 用法：
 *   node run.ts                 # mock 模式（快速回归，零 API 成本）
 *   node run.ts --live --rounds 10 [--scenario magical-girl-5r]   # 真实模型统计
 * 指标：种子事实召回率 / 契约格式成功率 / 双表一致率 / 单轮 token（live）
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { validateGameTurn, safeParseTurn, normalizeTurn } from '../../packages/prompt/src/turn.ts';
import type { GameTurn } from '../../packages/prompt/src/turn.ts';
import { ALL_SCENARIOS, mockTurnFor } from './scenarios.ts';
import type { GoldenScenario } from './scenarios.ts';

interface Metrics {
  rounds: number;
  contractOk: number;
  contractFail: number;
  dualTableOk: number;
  recallChecked: number;
  recallHitRounds: number;
  recallMissRounds: number;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}

function freshMetrics(): Metrics {
  return { rounds: 0, contractOk: 0, contractFail: 0, dualTableOk: 0, recallChecked: 0, recallHitRounds: 0, recallMissRounds: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 };
}

/** 种子事实入库（写入 memory_summary + memory_arc，指定关键词用于后续召回断言） */
function seedFacts(mem: MemoryDb, writer: WriteLoop, scenario: GoldenScenario): void {
  const insertLore = mem.db.prepare(
    'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  scenario.seedFacts.forEach((fact, i) => {
    writer.execute({ delta_summary: fact.content, round: i + 1 });
    insertLore.run(String(i), 'seed', fact.keywords, fact.keywords, fact.content, 0, 0, 1, 0, '[]', 100, 0, 1);
  });
  writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});
}

/** 断言：给定关键词，混合检索应命中对应种子事实 */
function assertRecall(ret: RetrievalEngine, keywords: string, round: number): boolean {
  const r = ret.recall({ query: keywords, round, budgetTokens: 200 });
  return r.hits.length > 0;
}

/** 单轮执行：turn 字符串 → 容错解析 → 归一化 → 校验 → 写环 → 返回结果 */
function runRound(mem: MemoryDb, writer: WriteLoop, turnJson: string, round: number): { ok: boolean; issue?: string } {
  const parsed = safeParseTurn(turnJson);
  if (!parsed) {
    return { ok: false, issue: 'JSON 容错解析失败' };
  }
  const { turn, warnings } = normalizeTurn(parsed);
  if (warnings.length > 0) console.log(`  ⚠ R${round} 归一化: ${warnings.join('; ')}`);
  const v = validateGameTurn(turn);
  if (!v.ok) return { ok: false, issue: v.issues[0] };
  const wr = writer.execute({
    delta_summary: turn.memory_delta.delta_summary,
    state_changes: turn.memory_delta.state_changes,
    new_events: turn.memory_delta.new_events,
    round,
  });
  return { ok: wr.codesConsistent, issue: wr.codesConsistent ? undefined : '双表不一致' };
}

/** mock 模式：预置输出重放（管线正确性） */
function runMock(scenario: GoldenScenario): Metrics {
  const m = freshMetrics();
  const t0 = Date.now();
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  seedFacts(mem, writer, scenario);
  const ret = new RetrievalEngine(mem);

  scenario.rounds.forEach((r, i) => {
    const round = i + 1;
    m.rounds++;
    const res = runRound(mem, writer, mockTurnFor(scenario, round), round);
    if (res.ok) m.contractOk++;
    else {
      m.contractFail++;
      console.log(`  ❌ R${round} 契约失败: ${res.issue}`);
    }
    // 召回断言：仅统计有 expect.recallKeywords 的轮次（不稀释分母）
    if (r.expect.recallKeywords?.length) {
      m.recallChecked++;
      const recallOk = r.expect.recallKeywords.some((kw) => assertRecall(ret, kw, round + scenario.seedFacts.length));
      if (recallOk) m.recallHitRounds++;
      else {
        m.recallMissRounds++;
        console.log(`  ❌ R${round} 召回失败: ${r.expect.recallKeywords.join(',')}`);
      }
    }
    if (res.ok) m.dualTableOk++;
  });
  m.elapsedMs = Date.now() - t0;
  return m;
}

/** live 模式：真实模型驱动（需要 .env.local 配置 key） */
async function runLive(scenario: GoldenScenario, rounds: number): Promise<Metrics> {
  const { loadProviderConfig, assertProviderReady } = await import('../../packages/proxy/src/config.ts');
  const { OpenAICompatibleClient, toolLoopMessages } = await import('../../packages/proxy/src/client.ts');
  const { assembleTurn, DEFAULT_SYSTEM_CORE } = await import('../../packages/prompt/src/assembly.ts');

  const cfg = loadProviderConfig();
  assertProviderReady(cfg);
  const client = new OpenAICompatibleClient(cfg);
  const m = freshMetrics();
  const t0 = Date.now();
  const mem = new MemoryDb();
  const writer = new WriteLoop(mem);
  seedFacts(mem, writer, scenario);
  const ret = new RetrievalEngine(mem);

  let lastTurn: string | undefined;
  for (let i = 0; i < Math.min(rounds, scenario.rounds.length); i++) {
    const round = i + 1;
    m.rounds++;
    const r = scenario.rounds[i];
    // 召回：仅统计有 expect.recallKeywords 的轮次
    if (r.expect.recallKeywords?.length) {
      m.recallChecked++;
      const hit = r.expect.recallKeywords.some((kw) => assertRecall(ret, kw, round + scenario.seedFacts.length));
      if (hit) m.recallHitRounds++;
      else {
        m.recallMissRounds++;
        console.log(`  ❌ R${round} 召回失败: ${r.expect.recallKeywords.join(',')}`);
      }
    }
    const recall = ret.recall({ query: r.userInput.slice(0, 16), round, budgetTokens: 300 });

    const assembled = assembleTurn({
      systemCore: DEFAULT_SYSTEM_CORE,
      staticSettings: `场景：${scenario.description}`,
      dynamicState: `轮次: ${round}`,
      memoryBlock: recall.injectedBlock,
      lastTurn,
      userInput: `<最新互动>\n${r.userInput}\n</最新互动>`,
      useTools: true,
    });

    try {
      const res = await client.complete({ messages: assembled.messages, tools: assembled.tools, temperature: 0.8 });
      m.promptTokens += res.usage?.prompt_tokens ?? 0;
      m.completionTokens += res.usage?.completion_tokens ?? 0;
      const tc = res.toolCalls.find((t) => t.name === 'game_turn');
      if (!tc) {
        m.contractFail++;
        console.log(`  ❌ R${round} 未返回 game_turn（finish=${res.finishReason}）`);
        continue;
      }
      // 契约执行：失败 → 错误召回重试一次（L6 协议）
      let rr = runRound(mem, writer, tc.arguments, round);
      if (!rr.ok) {
        console.log(`  ⚠ R${round} 契约失败(${rr.issue})，错误召回重试...`);
        const retry = await client.complete({
          messages: toolLoopMessages(assembled.messages, tc, `输出校验失败（${rr.issue}），请重新生成完整的 game_turn 参数`),
          tools: assembled.tools,
        });
        const retryTc = retry.toolCalls.find((t) => t.name === 'game_turn');
        if (retryTc) {
          rr = runRound(mem, writer, retryTc.arguments, round);
          if (rr.ok) console.log('  ✅ R' + round + ' 重试后通过');
        }
      }
      if (rr.ok) {
        m.contractOk++;
        m.dualTableOk++;
      } else {
        m.contractFail++;
        console.log(`  ❌ R${round} 契约失败: ${rr.issue}`);
      }
      lastTurn = tc.arguments;
    } catch (e) {
      m.contractFail++;
      console.log(`  ❌ R${round} 调用异常: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  m.elapsedMs = Date.now() - t0;
  return m;
}

function report(scenario: GoldenScenario, m: Metrics): void {
  const recallRate = m.recallChecked > 0 ? ((m.recallHitRounds / m.recallChecked) * 100).toFixed(1) : 'n/a';
  const contractRate = m.rounds > 0 ? ((m.contractOk / m.rounds) * 100).toFixed(1) : 'n/a';
  const dualRate = m.rounds > 0 ? ((m.dualTableOk / m.rounds) * 100).toFixed(1) : 'n/a';
  console.log(`\n══════ Golden-session 报告: ${scenario.name} ══════`);
  console.log(`  轮次: ${m.rounds} | 耗时: ${m.elapsedMs}ms`);
  console.log(`  召回率: ${recallRate}% (${m.recallHitRounds}/${m.recallChecked})`);
  console.log(`  契约成功率: ${contractRate}% (${m.contractOk}/${m.rounds})${m.contractFail ? ` 失败: ${m.contractFail}` : ''}`);
  console.log(`  双表一致率: ${dualRate}% (${m.dualTableOk}/${m.rounds})`);
  if (m.promptTokens > 0) console.log(`  Token: 输入 ${m.promptTokens} + 输出 ${m.completionTokens} = ${m.promptTokens + m.completionTokens}`);
  console.log('══════════════════════════════════════════');
}

// ── CLI ──
const args = process.argv.slice(2);
const live = args.includes('--live');
const roundsArg = args.indexOf('--rounds');
const rounds = roundsArg >= 0 ? Number(args[roundsArg + 1]) : 5;
const scenarioName = args.indexOf('--scenario') >= 0 ? args[args.indexOf('--scenario') + 1] : 'magical-girl-5r';
const scenario = ALL_SCENARIOS[scenarioName] ?? ALL_SCENARIOS['magical-girl-5r'];

console.log(`[evaluator] 模式=${live ? 'live(真实模型)' : 'mock'} 场景=${scenario.name} 轮次=${live ? rounds : scenario.rounds.length}`);

if (live) {
  const m = await runLive(scenario, rounds);
  report(scenario, m);
  process.exit(m.contractFail > 0 && m.contractOk / m.rounds < 0.8 ? 1 : 0);
} else {
  const m = runMock(scenario);
  report(scenario, m);
  process.exit(m.contractFail > 0 ? 1 : 0);
}
