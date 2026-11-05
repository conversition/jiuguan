import type { PrecommitCriticDecision } from '../../agent-policy/src/precommit-critic.ts';
import type { GameTurn } from '../../prompt/public/turn.ts';
import type { ChatRequest } from '../../proxy/src/client.ts';
import { createCriticInput, parseCriticInput, type CriticInputV1 } from './critic-input.ts';

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
  return buildPrecommitCriticRequestFromInput(createCriticInput(input));
}

/** The server captures once; provenance and Provider bytes share this frozen input. */
export function buildPrecommitCriticRequestFromInput(value: CriticInputV1): ChatRequest {
  const input = parseCriticInput(value);
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
          '除按 issueCodes 修复外，只做以下最小清洗：',
          '- 删除未替换的模板占位符（如 {{...}}、<%...%>），删除不属于正文的内部结构标记（【建议分支】【当前局势】【未解决伏笔】）。',
          '- 保留 HTML 时必须开闭配对；若 HTML 状态栏/面板只有一两个标签，前端不会按 HTML 渲染、玩家会看到原始标签 —— 要么补足为可识别结构（不少于三个富标签），要么降级为纯文本并去掉标签。',
          '- 清洗只允许删噪音、修标记、补配对与让状态栏内容自洽；禁止增删情节、改写人物言行或已发生的既定事实。',
          '不得调用工具，不得输出 Markdown 围栏或思维链。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          issueCodes: input.issueCodes,
          draft: input.draft,
          fullSkills: input.fullSkills,
        }),
      },
    ],
    temperature: 0.1,
    max_tokens: input.maxOutputTokens,
  });
}
