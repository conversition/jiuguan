/**
 * Golden-session 场景定义
 * 固定剧本（种子事实 + 用户输入序列 + 断言），用于评估器重放。
 */

export interface SeedFact {
  /** 种子事实关键词（断言检索命中用） */
  keywords: string;
  /** 种子事实内容（写环入库） */
  content: string;
  round: number;
}

export interface GoldenRound {
  /** 用户输入（模拟玩家） */
  userInput: string;
  /** 期望断言 */
  expect: {
    /** 该输入应召回的种子事实关键词（≥1 命中即通过） */
    recallKeywords?: string[];
    /** 期望 event_type（可空=不检查） */
    eventType?: string;
  };
}

export interface GoldenScenario {
  name: string;
  description: string;
  seedFacts: SeedFact[];
  rounds: GoldenRound[];
}

/** 魔法少女题材 5 轮 Golden 场景 */
export const MAGICAL_GIRL_5R: GoldenScenario = {
  name: 'magical-girl-5r',
  description: '魔法少女题材 5 轮剧情：种子事实（契约/怪物/学院）逐步被输入触发召回',
  seedFacts: [
    { keywords: '魔法少女 契约', content: '主角与魔法少女签订契约，获得变身能力', round: 0 },
    { keywords: '怪物 袭击', content: '学院周边出现低级怪物袭击事件', round: 0 },
    { keywords: '学院 试炼', content: '主角即将参加期末试炼', round: 0 },
  ],
  rounds: [
    { userInput: '主角来到学院，想起与魔法少女的契约', expect: { recallKeywords: ['契约', '学院'] } },
    { userInput: '突然怪物袭击学院，主角决定变身迎战', expect: { recallKeywords: ['怪物', '契约'] } },
    { userInput: '战斗结束，主角与魔法少女商量期末试炼的准备', expect: { recallKeywords: ['试炼', '学院'] } },
    { userInput: '主角受伤，魔法少女照顾他，关系升温', expect: { recallKeywords: ['怪物'] } },
    { userInput: '期末试炼开始，主角独自面对最终考验', expect: { recallKeywords: ['试炼'] } },
  ],
};

/** ASMR 哄睡题材 3 轮 Golden 场景（真实模型验证用） */
export const ASMR_3R: GoldenScenario = {
  name: 'asmr-3r',
  description: 'ASMR 哄睡台本 3 轮：低语开场 → 耳语引导 → 收尾',
  seedFacts: [
    { keywords: '哄睡 低语', content: '用户深夜失眠，需要温柔低语哄睡', round: 0 },
  ],
  rounds: [
    { userInput: '请开始一段温柔低语的哄睡台本', expect: { recallKeywords: ['哄睡'] } },
    { userInput: '继续，加入耳语和呼吸引导', expect: {} },
    { userInput: '我快睡着了，让台本慢慢收尾', expect: {} },
  ],
};

export const ALL_SCENARIOS: Record<string, GoldenScenario> = {
  [MAGICAL_GIRL_5R.name]: MAGICAL_GIRL_5R,
  [ASMR_3R.name]: ASMR_3R,
};

/** mock 模式预置输出（模拟模型 game_turn 结果，测试管线而非模型） */
export function mockTurnFor(scenario: GoldenScenario, round: number): string {
  const userInput = scenario.rounds[round - 1]?.userInput ?? '继续';
  return JSON.stringify({
    plan: {
      thought: `委员会：围绕"${userInput.slice(0, 12)}"规划推进`,
      key_events: [{ description: `本轮事件：${userInput.slice(0, 20)}` }],
      bars_delta: { personal: 1, accident: 2, main: 1, erotic: 0 },
      next_plan: '下一轮继续推进',
      event_type: 'normal',
    },
    memory_delta: {
      delta_summary: `第${round}轮：${userInput.slice(0, 30)}`,
      state_changes: [{ entity_type: 'protagonist', entity_id: '主角', field: 'round', value: String(round), action: 'upsert' }],
      new_events: [],
    },
    prose: `（第${round}轮正文：${userInput}……）`,
  });
}
