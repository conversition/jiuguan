import { createHash } from 'node:crypto';

export const PRECOMMIT_CRITIC_VERSION = 'p14-precommit-critic-v2' as const;
/**
 * Stable bindings for the operator-only defect-correction path.  Keep the defect id tied to the
 * historical false positive, while the policy revision identifies the corrected classifier.
 */
export const PLAYER_SOVEREIGNTY_ACTION_ALIAS_DEFECT_ID = 'precommit-action-alias-v1' as const;
export const PLAYER_SOVEREIGNTY_POLICY_REVISION = 'p14-player-sovereignty-v2' as const;
export const PRECOMMIT_ISSUE_CODES = Object.freeze([
  'fact-reference-gap',
  'player-sovereignty-violation',
  'duplicate-output',
  'npc-knowledge-conflict',
  'contract-invalid',
  // 正文清洗与渲染保障。保守口径：只识别"一定不该给玩家看到"的噪音与"一定渲染不出来"的结构，
  // 全部归入 repairable（交模型修稿），不参与 hard-deny。
  'prose-placeholder-leak',
  'prose-markup-unrendered',
  'prose-markup-broken',
  'prose-internal-markup-leak',
] as const);

export type PrecommitIssueCode = (typeof PRECOMMIT_ISSUE_CODES)[number];
export type PrecommitSeverity = 'pass' | 'warn' | 'repairable' | 'hard-deny';

/**
 * H0-R6 execution boundary. The deterministic gate protects persistence on every
 * turn path; the optional model Critic is only a quality-beta Interactive repair.
 */
export const PRECOMMIT_CRITIC_BOUNDARY = Object.freeze({
  deterministicGateScope: 'all-turn-paths',
  modelCriticScope: 'interactive-quality-beta-only',
  ordinaryTurnModelCalls: 0,
  modelCriticMaxCalls: 1,
  hardDenyFallback: 'reject-candidate',
  repairFailureFallback: 'use-original-draft-after-hard-gate',
} as const);

export function permitsModelCritic(input: {
  readonly interactiveActive: boolean;
  readonly autonomyProfile: 'legacy' | 'balanced' | 'quality-beta' | null;
  readonly repairDraftAvailable: boolean;
}): boolean {
  return input.interactiveActive
    && input.autonomyProfile === 'quality-beta'
    && input.repairDraftAvailable;
}

export interface PrecommitTurnLike {
  readonly plan: {
    readonly key_events?: readonly {
      readonly reference_source?: readonly string[];
      readonly character_focus?: readonly {
        readonly knows?: readonly string[];
        readonly unknowns?: readonly string[];
      }[];
    }[];
  };
  readonly memory_delta: {
    readonly state_changes?: readonly {
      readonly entity_type?: string;
      readonly field?: string;
      readonly action?: string;
    }[];
  };
  readonly prose: string;
}

export interface PrecommitCriticDecision {
  readonly policyVersion: typeof PRECOMMIT_CRITIC_VERSION;
  readonly severity: PrecommitSeverity;
  readonly issueCodes: readonly PrecommitIssueCode[];
  readonly hardDenyCodes: readonly PrecommitIssueCode[];
  readonly repairableCodes: readonly PrecommitIssueCode[];
  readonly factsDigest: string;
}

/**
 * 玩家主权：模型不得替玩家写「意图 / 决定 / 选择 / 目标」这类**接下来要做什么**的字段。
 *
 * ⚠️ 刻意**不含 `action` / `行动`**：主角的「当前行动」是正文里已经发生的叙事结果，
 * 而且 `assembly.ts:430` 明确要求模型把它写进 state_changes。2026-10-07 字段白名单归并
 * 把 `当前行动` 归一成 `action` 后，旧词表（含 action）让主角每次写行动都被判 hard-deny、
 * 整轮生成作废。行动状态不是"替玩家做决定"，故不纳入主权判定。
 */
const SOVEREIGNTY_FIELD = /(?:^|[._:/-])(?:intent|decision|choice|goal|意图|决定|选择|目标)(?:$|[._:/-])/iu;

export interface PlayerSovereigntyStateChangeLike {
  readonly entity_type?: string;
  readonly field?: string;
  readonly action?: string;
}

/**
 * Single deterministic source of truth shared by the persistence fence and post-commit audit.
 * `action / 当前行动` intentionally remains allowed: the turn contract defines it as an already
 * revealed current-state fact, not a future player choice.
 */
export function isPlayerSovereigntyStateChangeViolation(
  change: PlayerSovereigntyStateChangeLike,
): boolean {
  return change.entity_type === 'protagonist'
    && (change.action === 'delete' || SOVEREIGNTY_FIELD.test(change.field ?? ''));
}

/** 未替换的模板占位符：模型把模板变量原样吐给了玩家 */
const PROSE_PLACEHOLDER = /\{\{[^{}\n]{1,64}\}\}|<%=?[^%\n]{1,64}%>/u;
/**
 * 与前端 `apps/web/src/htmlCore.ts` 的 `looksLikeHtml` 同口径：
 * 只有「完整文档 / 含 <style> / 富标签 ≥ 3 个」才会被当成 HTML 渲染，其余按纯文本显示。
 */
const RICH_TAG = /<(?:div|p|span|h[1-6]|table|ul|ol|li|a|img|br|b|strong|i|em|section|article|main|header|footer|button|details|summary)[\s>]/giu;
/** 带 class/style/id 的标签：作者显然期望它按 HTML 结构渲染，而不是把原始标签显示给玩家 */
const STYLED_TAG = /<[a-z][a-z0-9-]*\b[^>]*\b(?:class|style|id)\s*=/iu;
/** 需要成对出现的标签（br/img 等自闭合标签不在内） */
const PAIRED_TAG = /<\/?(div|span|p|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|b|i|strong|em|section|article|header|footer|button|h[1-6])\b[^>]*>/giu;
/** 剧情索引/规划的内部结构标记，不该出现在给玩家看的正文里 */
const INTERNAL_MARKUP = /【(?:建议分支|当前局势|未解决伏笔)】/u;

/** 开闭标签配对检查（按标签名计数；`<tag/>` 不计入开标签）。 */
function hasUnbalancedPairedTags(prose: string): boolean {
  const open = new Map<string, number>();
  const close = new Map<string, number>();
  for (const match of prose.matchAll(PAIRED_TAG)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name) continue;
    const raw = match[0];
    if (raw.startsWith('</')) close.set(name, (close.get(name) ?? 0) + 1);
    else if (!raw.endsWith('/>')) open.set(name, (open.get(name) ?? 0) + 1);
  }
  if (open.size === 0 && close.size === 0) return false;
  for (const [name, count] of open) if ((close.get(name) ?? 0) !== count) return true;
  for (const [name, count] of close) if ((open.get(name) ?? 0) !== count) return true;
  return false;
}

/**
 * 正文噪音与渲染保障（保守口径）。命中即 repairable，交修稿器做「删噪音 / 修标记 / 补配对」，
 * 不允许借此改写剧情、人物言行或既定事实。
 */
function collectProseIssues(prose: string, add: (code: PrecommitIssueCode) => void): void {
  if (PROSE_PLACEHOLDER.test(prose)) add('prose-placeholder-leak');
  if (INTERNAL_MARKUP.test(prose)) add('prose-internal-markup-leak');
  if (hasUnbalancedPairedTags(prose)) add('prose-markup-broken');
  // 想渲染成 HTML（带 class/style/id）但富标签不足 3 个 ⇒ 前端判不出 HTML，玩家会看到原始标签
  if (STYLED_TAG.test(prose) && (prose.match(RICH_TAG) ?? []).length < 3) {
    add('prose-markup-unrendered');
  }
}

/** Deterministic post-draft gate. It returns codes/count-derived digest, never hidden reasoning. */
export function evaluatePrecommitCritic(input: {
  readonly turn: PrecommitTurnLike;
  readonly duplicateOutput: boolean;
  readonly contractIssueCount: number;
}): PrecommitCriticDecision {
  if (!input.turn || typeof input.turn !== 'object' || typeof input.turn.prose !== 'string') {
    throw new TypeError('precommit turn is invalid');
  }
  if (typeof input.duplicateOutput !== 'boolean'
    || !Number.isSafeInteger(input.contractIssueCount) || input.contractIssueCount < 0) {
    throw new TypeError('precommit flags are invalid');
  }
  const issues = new Set<PrecommitIssueCode>();
  const events = input.turn.plan.key_events ?? [];
  if (events.some((event) => (event.reference_source ?? []).length === 0
    && (event.character_focus ?? []).some((focus) => (focus.knows ?? []).length > 0))) {
    issues.add('fact-reference-gap');
  }
  if ((input.turn.memory_delta.state_changes ?? []).some(
    isPlayerSovereigntyStateChangeViolation,
  )) issues.add('player-sovereignty-violation');
  if (input.duplicateOutput) issues.add('duplicate-output');
  if (events.some((event) => (event.character_focus ?? []).some((focus) => {
    const known = new Set((focus.knows ?? []).map((value) => value.normalize('NFKC').trim()).filter(Boolean));
    return (focus.unknowns ?? []).some((value) => known.has(value.normalize('NFKC').trim()));
  }))) issues.add('npc-knowledge-conflict');
  if (input.contractIssueCount > 0) issues.add('contract-invalid');
  collectProseIssues(input.turn.prose, (code) => { issues.add(code); });
  const issueCodes = Object.freeze(PRECOMMIT_ISSUE_CODES.filter((code) => issues.has(code)));
  const hardDenyCodes = Object.freeze(issueCodes.filter((code) => (
    code === 'player-sovereignty-violation'
      || code === 'npc-knowledge-conflict'
      || code === 'contract-invalid'
  )));
  const repairableCodes = Object.freeze(issueCodes.filter((code) => (
    code === 'fact-reference-gap' || code === 'duplicate-output'
    || code === 'prose-placeholder-leak' || code === 'prose-internal-markup-leak'
    || code === 'prose-markup-broken' || code === 'prose-markup-unrendered'
  )));
  const severity: PrecommitSeverity = hardDenyCodes.length > 0
    ? 'hard-deny'
    : repairableCodes.length > 0 ? 'repairable' : 'pass';
  const factsDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    version: PRECOMMIT_CRITIC_VERSION,
    issueCodes,
    hardDenyCodes,
    repairableCodes,
  }), 'utf8').digest('hex')}`;
  return Object.freeze({
    policyVersion: PRECOMMIT_CRITIC_VERSION,
    severity,
    issueCodes,
    hardDenyCodes,
    repairableCodes,
    factsDigest,
  });
}
