import type { PrecommitCriticDecision } from '../../agent-policy/src/precommit-critic.ts';
import { parseStoryIndexSeed, type GameTurn } from '../../prompt/src/turn.ts';
import type { ChatRequest } from '../../proxy/src/client.ts';

export const PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION = 'p14-precommit-critic-model-v2' as const;

export interface PrecommitCriticSkill {
  readonly snapshot: unknown;
  readonly body: string;
}

/**
 * Shared Provider request contract for production and operational replay.
 * It only accepts deterministic repairable decisions; hard-deny drafts never reach a model.
 */
export function buildPrecommitCriticModelRequest(input: {
  readonly decision: PrecommitCriticDecision;
  readonly draft: GameTurn;
  readonly fullSkills: readonly PrecommitCriticSkill[];
  readonly maxOutputTokens: number;
}): ChatRequest {
  if (input.decision.severity !== 'repairable'
    || input.decision.hardDenyCodes.length !== 0
    || input.decision.repairableCodes.length === 0) {
    throw new Error('critic-model-request-not-repairable');
  }
  if (!Number.isSafeInteger(input.maxOutputTokens)
    || input.maxOutputTokens < 256 || input.maxOutputTokens > 100_000) {
    throw new Error('critic-model-output-budget-invalid');
  }
  if (!Array.isArray(input.fullSkills) || input.fullSkills.length > 64
    || input.fullSkills.some((skill) => (
      !skill || typeof skill !== 'object' || typeof skill.body !== 'string'
      || skill.body.length > 1_000_000
    ))) {
    throw new Error('critic-model-skills-invalid');
  }
  const storyIndexSeed = parseStoryIndexSeed(input.draft.story_index_seed);
  const sanitizedDraft = {
    plan: input.draft.plan,
    memory_delta: input.draft.memory_delta,
    ...(storyIndexSeed ? { story_index_seed: storyIndexSeed } : {}),
    prose: input.draft.prose,
  };
  return Object.freeze({
    messages: [
      {
        role: 'system' as const,
        content: [
          '你是提交前 Critic，只修正给定 game_turn，不生成解释或第二条回复。',
          '必须保留用户选择权、已知事实边界和完整 Skill 约束。',
          '只输出一个完整 JSON 对象；顶层只允许 plan、memory_delta、story_index_seed、prose，且 prose 必须最后。',
          '若 draft 含合法 story_index_seed，必须保留并使其动作与修订后的最终正文一致；缺失或坏值可省略。',
          'story_index_seed 只能包含玩家此刻可执行的动作，禁止行动结果、内部 plan、未来事实或 NPC 私有知识。',
          'memory_delta.delta_summary 只能描述最终正文已经向玩家揭示的变化。',
          '不得调用工具，不得输出 Markdown 围栏或思维链。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          issueCodes: input.decision.repairableCodes,
          draft: sanitizedDraft,
          fullSkills: input.fullSkills.map((skill) => ({
            snapshot: skill.snapshot,
            body: skill.body,
          })),
        }),
      },
    ],
    temperature: 0.1,
    max_tokens: input.maxOutputTokens,
  });
}
