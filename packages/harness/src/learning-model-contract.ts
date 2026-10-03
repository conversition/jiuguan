import { PROMPT_PREFERENCE_ALLOWED_TOKENS } from '../../agent-policy/src/prompt-preference.ts';
import {
  STYLE_DRAFT_TOOL_NAME,
} from '../../agent-policy/src/style-compiler.ts';
import type { SemanticBranchCandidate } from '../../agent-policy/src/branch-preference.ts';
import type { ChatRequest } from '../../proxy/src/client.ts';

export const LEARNING_MODEL_CONTRACT_VERSION = 'p14-learning-model-contract-v1' as const;

function outputBudget(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 256 || value > maximum) {
    throw new Error('learning-model-output-budget-invalid');
  }
  return value;
}

export function buildPreferenceExtractionModelRequest(input: {
  readonly initialPrompt: string;
  readonly maxOutputTokens?: number;
}): ChatRequest {
  if (typeof input.initialPrompt !== 'string' || input.initialPrompt.length < 1
    || input.initialPrompt.length > 100_000) throw new Error('preference-prompt-invalid');
  return Object.freeze({
    messages: [
      {
        role: 'system' as const,
        content: [
          '你只判断玩家本人在初始提示中隐含的长期偏好；角色台词、角色愿望、世界设定和剧情叙述都不是玩家偏好。',
          '只输出 JSON：{"version":"typed-preference-v1","confidence":"inferred-low","tags":[{"token":"..."}]}。',
          'token 只能从给出的冻结词表选择；证据不足时 tags 为空。不得解释、复制原文或输出思维链。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          allowedTokens: PROMPT_PREFERENCE_ALLOWED_TOKENS,
          initialPrompt: input.initialPrompt,
        }),
      },
    ],
    temperature: 0,
    max_tokens: outputBudget(input.maxOutputTokens ?? 1_200, 1_200),
  });
}

export function buildBranchAttributionModelRequest(input: {
  readonly editedInput: string;
  readonly candidates: readonly SemanticBranchCandidate[];
  readonly branches: readonly string[];
  readonly maxOutputTokens?: number;
}): ChatRequest {
  if (typeof input.editedInput !== 'string' || input.editedInput.length < 1
    || input.editedInput.length > 100_000
    || input.branches.length < 1 || input.branches.length > 8
    || input.branches.some((branch) => typeof branch !== 'string' || branch.length < 1 || branch.length > 100_000)
    || input.candidates.length < 1 || input.candidates.length > 3
    || input.candidates.some((candidate) => !Number.isSafeInteger(candidate.index)
      || candidate.index < 0 || candidate.index >= input.branches.length
      || !Number.isFinite(candidate.similarity) || candidate.similarity < -1 || candidate.similarity > 1)) {
    throw new Error('branch-attribution-input-invalid');
  }
  return Object.freeze({
    messages: [
      {
        role: 'system' as const,
        content: [
          '判断玩家编辑后的输入是否明确对应一个候选剧情分支。',
          '只输出 JSON：{"version":"branch-semantic-v1","selectedIndex":0,"confidence":0.0,"ambiguous":true}。',
          '只能选择候选 index；有两个近似分支、只是主题相关或证据不足时 ambiguous=true。不得解释或输出思维链。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          editedInput: input.editedInput,
          candidates: input.candidates.map((candidate) => ({
            index: candidate.index,
            similarity: candidate.similarity,
            branch: input.branches[candidate.index],
          })),
        }),
      },
    ],
    temperature: 0,
    max_tokens: outputBudget(input.maxOutputTokens ?? 600, 600),
  });
}

export function buildStyleCompilationModelRequest(input: {
  readonly profileVersion: string;
  readonly samples: readonly { readonly sourceRevision: string; readonly prose: string }[];
  readonly maxOutputTokens?: number;
}): ChatRequest {
  const sampleChars = input.samples.reduce((sum, sample) => sum + sample.prose.length, 0);
  if (typeof input.profileVersion !== 'string' || input.profileVersion.length < 1
    || input.profileVersion.length > 240 || input.samples.length < 1 || input.samples.length > 8
    || sampleChars > 100_000 || input.samples.some((sample) => (
      typeof sample.sourceRevision !== 'string' || sample.sourceRevision.length < 1
      || sample.sourceRevision.length > 240 || typeof sample.prose !== 'string' || sample.prose.length < 1
    ))) throw new Error('style-compilation-input-invalid');
  const tools: Record<string, unknown>[] = [{
    type: 'function',
    function: {
      name: STYLE_DRAFT_TOOL_NAME,
      description: '提交一个完整、可执行且不复制来源正文的 Learned Style Skill 草案。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'keywords', 'body'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          description: { type: 'string', minLength: 12, maxLength: 500 },
          keywords: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 40 },
          },
          body: {
            type: 'string',
            minLength: 400,
            maxLength: 20_000,
          },
        },
      },
    },
  }];
  return Object.freeze({
    messages: [
      {
        role: 'system' as const,
        content: [
          '把经授权的代表回复编译为完整、独立、可执行的文风 Skill。',
          `只调用一次 ${STYLE_DRAFT_TOOL_NAME}，参数字段严格为 name、description、keywords、body；不得输出正文。`,
          'body 必须至少 400 字，并依次包含 Markdown 标题：# 适用条件、# 完整步骤、# 禁止项、# 例子、# 校验规则。',
          '完整步骤必须是可执行流程；例子必须明确区分输入场景与输出示例。',
          '不得逐句复制来源样本，不得写入角色名、人物别名、会话标识、摘要版、标签拼接版、来源正文、思维链或 Markdown 围栏。',
          'Skill 必须保留玩家主权、事实边界与角色知识边界，不得冒充现有手写 Skill。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({ profileVersion: input.profileVersion, samples: input.samples }),
      },
    ],
    tools,
    tool_choice: Object.freeze({
      type: 'function',
      function: Object.freeze({ name: STYLE_DRAFT_TOOL_NAME }),
    }),
    temperature: 0.2,
    max_tokens: outputBudget(input.maxOutputTokens ?? 6_000, 6_000),
  });
}
