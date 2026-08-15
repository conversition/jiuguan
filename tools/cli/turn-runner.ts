/**
 * 完整回合执行器（Phase 1 M2/M3 真实链路）：
 * 预计算(检索) → 装配 → 真实模型调用(game.turn) → 契约校验 → 写环 → 返回正文与入库结果
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/turn-runner.ts [回合数]
 */
import { readFileSync } from 'node:fs';
import { parseCharaCard } from '../../packages/core/src/chara.ts';
import { cardBookToLorebookRows, parseWorldBook, entryToLorebookRow } from '../../packages/core/src/worldbook.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { WriteLoop } from '../../packages/memory/src/writer.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { assembleTurn, DEFAULT_SYSTEM_CORE } from '../../packages/prompt/src/assembly.ts';
import { validateGameTurn, safeParseTurn, normalizeTurn } from '../../packages/prompt/src/turn.ts';
import type { GameTurn } from '../../packages/prompt/src/turn.ts';
import { OpenAICompatibleClient, toolLoopMessages } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';

// ── 1. 加载真实素材与配置 ──
const cfg = loadProviderConfig();
assertProviderReady(cfg);
console.log(`[config] model=${cfg.model} base=${cfg.baseUrl}/v1`);

const CARD = 'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/ASMR剧本工坊 (2).json';
const parsed = parseCharaCard(readFileSync(CARD, 'utf8'));
console.log(`[card] ${parsed.card.name}（世界书 ${parsed.worldbookEntries.length} 条目）`);

// ── 2. 初始化记忆服务（内存库，进程内直连）──
const mem = new MemoryDb();
const writer = new WriteLoop(mem);
const ret = new RetrievalEngine(mem);
const scanner = new LorebookScanner(mem);
writer.initMeta({ personal: 0, accident: 0, main: 0, erotic: 0 }, {});

const insertLore = mem.db.prepare(
  'INSERT OR IGNORE INTO lorebook_entry (uid, book, key, comment, content, selective, depth, constant, use_regex, triggers, probability, useProbability, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
);
for (const r of cardBookToLorebookRows(parsed.worldbookEntries, parsed.card.name)) {
  insertLore.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
}
// 加载 XP大全绿灯版 450 条（关键词激活）
const xp = parseWorldBook(readFileSync('E:/claude cade test/project/jiuguanlike/剧本方案/世界书/XP大全绿灯世界书-v1.4.json', 'utf8'));
for (const e of xp.entries) {
  const r = entryToLorebookRow(e);
  insertLore.run(r.uid, r.book, r.key, r.comment, r.content, r.selective, r.depth, r.constant, r.use_regex, r.triggers, r.probability, r.useProbability, r.active);
}
console.log(`[memory] lorebook 导入 ${parsed.worldbookEntries.length}(卡) + ${xp.stats.total}(XP大全) 条`);

// ── 3. 主循环 ──
const client = new OpenAICompatibleClient(cfg);
const userInputs = [
  '我是深夜失眠的用户，请开始一段温柔低语的哄睡台本',
  '继续，我的呼吸开始平缓了，请加入更多的耳语和呼吸引导',
  '我快睡着了，请让台本慢慢收尾，声音越来越轻',
];

let lastTurn: string | undefined;
for (let round = 1; round <= userInputs.length; round++) {
  console.log(`\n════════ 第 ${round} 回合 ════════`);

  // ① 平台预计算（0 模型往返）
  const recall = ret.recall({ query: `ASMR ${userInputs[round - 1].slice(0, 20)}`, round, budgetTokens: 400 });
  console.log(`[预计算] 检索 hits=${recall.hits.length} codes=[${recall.codes.join(',')}] ${recall.elapsedMs}ms`);

  // ①b 世界书扫描（L1 激活，Phase 3 补全）
  const scan = scanner.scan({ text: userInputs[round - 1], seed: round, budgetTokens: 600 });
  console.log(`[扫描] 激活 ${scan.activated.length} 条 (matched=${scan.stats.keywordMatched}, tokens=${scan.stats.tokens})`);

  // ② 装配
  const assembled = assembleTurn({
    systemCore: DEFAULT_SYSTEM_CORE,
    staticSettings: `角色卡：${parsed.card.name}\n${parsed.card.data.description.slice(0, 400)}${scan.injectedBlock ? `\n\n<世界书激活>\n${scan.injectedBlock}\n</世界书激活>` : ''}`,
    dynamicState: `轮次: ${round}\n推进槽: ${JSON.stringify({ personal: 0, accident: 0, main: 0, erotic: 0 })}`,
    memoryBlock: recall.injectedBlock,
    lastTurn,
    userInput: `<最新互动>\n${userInputs[round - 1]}\n</最新互动>`,
    useTools: true,
  });
  console.log(`[装配] messages=${assembled.messages.length} 稳定前缀≈${assembled.stablePrefixTokens}tok`);

  // ③ 真实模型调用（tools: game.turn）
  const res = await client.complete({
    messages: assembled.messages,
    tools: assembled.tools,
    temperature: 0.9,
  });
  console.log(`[模型] finish=${res.finishReason} usage=${res.usage ? `${res.usage.prompt_tokens}→${res.usage.completion_tokens}` : 'n/a'}`);

  if (res.toolCalls.length > 0) {
    const tc = res.toolCalls.find((t) => t.name === 'game_turn');
    if (tc) {
      // ④ 契约校验 + 错误输出召回（L6）：JSON 容错解析 → 归一化 → schema 校验 → 失败重试
      let turn: GameTurn | null = safeParseTurn(tc.arguments);
      if (turn) {
        const norm = normalizeTurn(turn);
        if (norm.warnings.length) console.log(`[校验] ⚠ 归一化: ${norm.warnings.join('; ')}`);
        turn = norm.turn;
        const v = validateGameTurn(turn);
        if (!v.ok) {
          console.log(`[校验] ❌ ${v.issues.join('; ')}`);
          turn = null;
        } else {
          console.log('[校验] ✅ game.turn 契约通过');
        }
      } else {
        console.log('[校验] ❌ JSON 解析失败（将重试）');
      }

      if (!turn) {
        // 错误召回：附上具体错误信息重试一次（重试失败跳过本回合，不中断整个 runner）
        const errMsg = tc.arguments
          ? `输出 JSON 校验失败（${describeJsonError(tc.arguments)}），请重新生成完整的 game_turn 参数`
          : '未返回 game_turn 参数，请重新生成';
        const retry = await client.complete({
          messages: toolLoopMessages(assembled.messages, tc, errMsg),
          tools: assembled.tools,
        });
        const retryTc = retry.toolCalls.find((t) => t.name === 'game_turn');
        if (!retryTc) {
          console.log('[校验] ❌ 重试未返回 game_turn，跳过本回合');
          continue;
        }
        turn = safeParseTurn(retryTc.arguments);
        if (turn) {
          const norm = normalizeTurn(turn);
          turn = norm.turn;
          const v2 = validateGameTurn(turn);
          if (!v2.ok) {
            console.log(`[校验] ❌ 重试校验失败: ${v2.issues.join('; ')}，跳过`);
            turn = null;
          }
        }
        if (!turn) {
          console.log('[校验] ❌ 重试仍失败，跳过本回合');
          continue;
        }
        console.log('[校验] 重试后通过');
      }

      // ⑤ 写环（平台分配 AM 码 + 双表一致）
      const wr = writer.execute({
        delta_summary: turn.memory_delta.delta_summary,
        state_changes: turn.memory_delta.state_changes,
        new_events: turn.memory_delta.new_events,
        round,
      });
      console.log(`[写环] codes=${wr.insertedCodes.join(',')} 双表一致=${wr.codesConsistent}`);
      console.log(`[正文预览] ${turn.prose.slice(0, 120)}...`);
      lastTurn = JSON.stringify(turn.plan);
    }
  } else if (res.content) {
    console.log(`[模型] 未调用工具，直接输出（降级路径）: ${res.content.slice(0, 100)}`);
  } else {
    console.log('[模型] 空响应');
  }
}

console.log('\n════════ 回合循环完成 ════════');
const arcCount = mem.db.prepare('SELECT COUNT(*) c FROM memory_arc').get() as { c: number };
const sumCount = mem.db.prepare('SELECT COUNT(*) c FROM memory_summary').get() as { c: number };
console.log(`[记忆] arc=${arcCount.c} summary=${sumCount.c} 双表同步=${arcCount.c === sumCount.c}`);

// ── 容错解析/错误描述（复用 prompt 包共享实现；describeJsonError 本地保留）──
/** 描述 JSON 解析错误（供重试信息使用） */
function describeJsonError(args: string): string {
  try {
    JSON.parse(args);
    return 'schema 校验失败';
  } catch (e) {
    return (e as Error).message.slice(0, 80);
  }
}
