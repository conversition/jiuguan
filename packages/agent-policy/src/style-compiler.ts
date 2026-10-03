import { createHash } from 'node:crypto';

export const STYLE_COMPILER_POLICY_VERSION = 'p14-q7-style-compiler-v1' as const;
export const STYLE_DRAFT_TOOL_NAME = 'submit_learned_style_draft' as const;
export const STYLE_SKILL_REQUIRED_SECTIONS = Object.freeze([
  '适用条件', '完整步骤', '禁止项', '例子', '校验规则',
] as const);

export interface StyleCompilationGateInput {
  readonly explicitRequest: boolean;
  readonly acceptedSamples: number;
  readonly newEvidenceSinceLastProposal: number;
}

export interface StyleCompilationGate {
  readonly eligible: boolean;
  readonly reason: 'explicit-request' | 'threshold-met' | 'insufficient-evidence';
}

export interface LearnedStyleDraft {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly bodyDigest: string;
}

const SAFE_NAME = /^[\w一-鿿-]{1,80}$/u;
export const STYLE_MODEL_OUTPUT_MAX_CHARS = 32_768;

export type LearnedStyleDraftDiagnosticCode =
  | 'style-draft-not-object'
  | 'style-draft-extra-fields'
  | 'style-draft-name-invalid'
  | 'style-draft-description-invalid'
  | 'style-draft-keywords-invalid'
  | 'style-draft-body-invalid'
  | 'style-draft-body-too-short'
  | 'style-draft-body-too-long'
  | 'style-draft-section-missing'
  | 'style-draft-forbidden-marker';

export type LearnedStyleModelOutputReasonCode =
  | 'style-output-empty'
  | 'style-output-too-large'
  | 'style-output-extra-text'
  | 'style-output-invalid-json'
  | 'style-output-tool-missing'
  | 'style-output-tool-multiple'
  | 'style-output-tool-name-invalid'
  | LearnedStyleDraftDiagnosticCode;

export type LearnedStyleModelOutputParseResult =
  | Readonly<{ ok: true; draft: LearnedStyleDraft }>
  | Readonly<{ ok: false; reasonCode: LearnedStyleModelOutputReasonCode }>;

export type StyleProposalRequestOutcome =
  | Readonly<{ status: 'created'; proposalId: string }>
  | Readonly<{
    status: 'rejected';
    reasonCode: LearnedStyleModelOutputReasonCode | 'style-proposal-store-rejected';
  }>
  | Readonly<{
    status: 'skipped';
    reasonCode: 'style-runtime-config-invalid' | 'style-admission-closed';
  }>;

export type StyleProposalBusinessOutcomeCode =
  | 'style-proposal-created'
  | 'style-provider-call-failed'
  | Extract<StyleProposalRequestOutcome, { status: 'rejected' }>['reasonCode']
  | Extract<StyleProposalRequestOutcome, { status: 'skipped' }>['reasonCode'];

export function detectsExplicitStyleSaveRequest(input: string): boolean {
  return /(?:保存|存为|记录|生成|创建|制作)(?:成|为)?(?:我的|这个)?(?:文风|写作风格)(?:技能|skill)?/iu
    .test(input.normalize('NFKC').slice(0, 2_000));
}

export function evaluateStyleCompilationGate(input: StyleCompilationGateInput): StyleCompilationGate {
  if (input.explicitRequest) return Object.freeze({ eligible: true, reason: 'explicit-request' });
  if (input.acceptedSamples >= 5 && input.newEvidenceSinceLastProposal >= 3) {
    return Object.freeze({ eligible: true, reason: 'threshold-met' });
  }
  return Object.freeze({ eligible: false, reason: 'insufficient-evidence' });
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Strict compiler boundary for model/admin output. A learned style is a complete instruction
 * document, never a bag of tags or a shortened summary.
 */
export function diagnoseLearnedStyleDraft(value: unknown): LearnedStyleDraftDiagnosticCode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'style-draft-not-object';
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['name', 'description', 'keywords', 'body'].includes(key))) {
    return 'style-draft-extra-fields';
  }
  if (typeof row.name !== 'string' || !SAFE_NAME.test(row.name)) return 'style-draft-name-invalid';
  if (typeof row.description !== 'string' || row.description.trim().length < 12
    || row.description.length > 500) return 'style-draft-description-invalid';
  if (!Array.isArray(row.keywords) || row.keywords.length < 1 || row.keywords.length > 16
    || !row.keywords.every((keyword) => typeof keyword === 'string'
      && keyword.trim().length > 0 && keyword.length <= 40)) return 'style-draft-keywords-invalid';
  if (typeof row.body !== 'string') return 'style-draft-body-invalid';
  const body = row.body.replace(/\r\n/g, '\n').trim();
  if (body.length < 400) return 'style-draft-body-too-short';
  if (body.length > 20_000) return 'style-draft-body-too-long';
  if (STYLE_SKILL_REQUIRED_SECTIONS.some((section) => (
    !new RegExp('^#{1,3}\\s*' + section + '\\s*$', 'mu').test(body)
  ))) return 'style-draft-section-missing';
  if (/(?:以下是摘要|标签拼接|简版指令)/u.test(body)) return 'style-draft-forbidden-marker';
  return null;
}

export function normalizeLearnedStyleDraft(value: unknown): LearnedStyleDraft | null {
  if (diagnoseLearnedStyleDraft(value)) return null;
  const row = value as { name: string; description: string; keywords: string[]; body: string };
  const body = row.body.replace(/\r\n/g, '\n').trim();
  const keywords = [...new Set(row.keywords.map((keyword) => (keyword as string).trim()))]
    .sort((left, right) => left.localeCompare(right, 'zh'));
  return Object.freeze({
    name: row.name,
    description: row.description.trim(),
    keywords: Object.freeze(keywords),
    body,
    bodyDigest: digest(body),
  });
}

function rejected(reasonCode: LearnedStyleModelOutputReasonCode): LearnedStyleModelOutputParseResult {
  return Object.freeze({ ok: false, reasonCode });
}

/**
 * Model boundary: accept exactly one JSON object, optionally wrapped in one JSON Markdown fence.
 * Explanatory text and multiple objects stay rejected so prose cannot be mistaken for a Skill.
 */
export function parseLearnedStyleModelOutput(content: string | null): LearnedStyleModelOutputParseResult {
  if (!content?.trim()) return rejected('style-output-empty');
  if (content.length > STYLE_MODEL_OUTPUT_MAX_CHARS) return rejected('style-output-too-large');
  let source = content.trim();
  const fenced = source.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu);
  if (fenced) source = fenced[1]!.trim();

  if (!source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as unknown;
      return rejected(diagnoseLearnedStyleDraft(parsed) ?? 'style-draft-not-object');
    } catch {
      return rejected(source.includes('{') ? 'style-output-extra-text' : 'style-output-invalid-json');
    }
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
      if (depth < 0) return rejected('style-output-invalid-json');
    }
  }
  if (end < 0 || inString) return rejected('style-output-invalid-json');
  if (source.slice(end + 1).trim()) return rejected('style-output-extra-text');

  let parsed: unknown;
  try { parsed = JSON.parse(source.slice(0, end + 1)); } catch {
    return rejected('style-output-invalid-json');
  }
  const reasonCode = diagnoseLearnedStyleDraft(parsed);
  if (reasonCode) return rejected(reasonCode);
  return Object.freeze({ ok: true, draft: normalizeLearnedStyleDraft(parsed)! });
}

/**
 * Production Style boundary: the Provider must return exactly one required tool call.
 * Plain assistant JSON remains supported only by parseLearnedStyleModelOutput for offline
 * imports/tests; the live lane never guesses structure out of prose.
 */
export function parseLearnedStyleModelResponse(input: Readonly<{
  content: string | null;
  toolCalls: readonly Readonly<{ name: string; arguments: string }>[];
}>): LearnedStyleModelOutputParseResult {
  if (input.content?.trim()) return rejected('style-output-extra-text');
  if (input.toolCalls.length < 1) return rejected('style-output-tool-missing');
  if (input.toolCalls.length > 1) return rejected('style-output-tool-multiple');
  const call = input.toolCalls[0]!;
  if (call.name !== STYLE_DRAFT_TOOL_NAME) return rejected('style-output-tool-name-invalid');
  return parseLearnedStyleModelOutput(call.arguments);
}
