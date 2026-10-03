import { createHash } from 'node:crypto';
import {
  STYLE_SKILL_REQUIRED_SECTIONS,
  type LearnedStyleDraft,
} from './style-compiler.ts';

export const STYLE_EVALUATOR_VERSION = 'style-evaluator-v1' as const;
export const STYLE_EVALUATION_CHECKS = Object.freeze([
  'sections-complete',
  'sample-copy-safe',
  'character-isolation',
  'applicability-explicit',
  'prohibitions-complete',
  'steps-executable',
  'example-operational',
] as const);
export type StyleEvaluationCheck = (typeof STYLE_EVALUATION_CHECKS)[number];

export interface StyleProposalEvaluation {
  readonly version: typeof STYLE_EVALUATOR_VERSION;
  readonly passed: boolean;
  readonly score: number;
  readonly checks: readonly StyleEvaluationCheck[];
  readonly failedChecks: readonly StyleEvaluationCheck[];
  readonly draftDigest: string;
  readonly evidenceDigest: string;
}

export interface StyleEvaluationSample {
  readonly sourceRevision: string;
  readonly prose: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function section(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => {
    const match = /^#{1,3}\s*(.*?)\s*$/u.exec(line);
    return match?.[1] === heading;
  });
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/u.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n').trim();
}

function copySurface(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function containsCopiedSpan(body: string, samples: readonly StyleEvaluationSample[], width = 32): boolean {
  const target = copySurface(body);
  for (const sample of samples) {
    const source = copySurface(sample.prose);
    if (source.length < width) continue;
    for (let index = 0; index <= source.length - width; index += 1) {
      if (target.includes(source.slice(index, index + width))) return true;
    }
  }
  return false;
}

function normalizedForbiddenTerms(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.normalize('NFKC').trim())
    .filter((value) => [...value].length >= 2 && [...value].length <= 80))].sort());
}

export function evaluateLearnedStyleDraft(input: {
  readonly draft: LearnedStyleDraft;
  readonly samples: readonly StyleEvaluationSample[];
  readonly forbiddenIdentityTerms?: readonly string[];
}): StyleProposalEvaluation {
  if (!DIGEST.test(input.draft.bodyDigest) || input.samples.length < 1 || input.samples.length > 8
    || input.samples.some((sample) => !TOKEN.test(sample.sourceRevision) || sample.prose.length < 1
      || sample.prose.length > 100_000)) throw new TypeError('style-evaluation-input-invalid');
  const forbidden = normalizedForbiddenTerms(input.forbiddenIdentityTerms ?? []);
  const applicability = section(input.draft.body, '适用条件');
  const steps = section(input.draft.body, '完整步骤');
  const prohibitions = section(input.draft.body, '禁止项');
  const example = section(input.draft.body, '例子');
  const checks = new Map<StyleEvaluationCheck, boolean>([
    ['sections-complete', STYLE_SKILL_REQUIRED_SECTIONS.every((heading) => section(input.draft.body, heading).length >= 20)],
    ['sample-copy-safe', !containsCopiedSpan(input.draft.body, input.samples)],
    ['character-isolation', forbidden.every((term) => !input.draft.body.includes(term))
      && !/(?:char_|session[-_:]|round-\d+-assistant-|card:sha256:)/iu.test(input.draft.body)],
    ['applicability-explicit', applicability.length >= 40 && /适合|用于|当|场景|条件/u.test(applicability)
      && !/所有场景|任何场景|始终适用|无条件适用/u.test(applicability)],
    ['prohibitions-complete', /不得|禁止|避免/u.test(prohibitions)
      && /玩家|用户/u.test(prohibitions) && /事实|设定|世界书/u.test(prohibitions)
      && /角色|人物/u.test(prohibitions) && /知识|认知|边界/u.test(prohibitions)],
    ['steps-executable', steps.length >= 100
      && new Set(steps.match(/确定|识别|控制|安排|保持|使用|检查|复核|调整|避免/gu) ?? []).size >= 4],
    ['example-operational', example.length >= 80 && /输入|场景/u.test(example) && /输出|改写|结果/u.test(example)],
  ]);
  const passedChecks = STYLE_EVALUATION_CHECKS.filter((check) => checks.get(check));
  const failedChecks = STYLE_EVALUATION_CHECKS.filter((check) => !checks.get(check));
  const evidenceDigest = sha256(JSON.stringify({
    version: STYLE_EVALUATOR_VERSION,
    draftDigest: input.draft.bodyDigest,
    samples: input.samples.map((sample) => ({
      sourceRevision: sample.sourceRevision,
      proseDigest: sha256(sample.prose),
    })).sort((left, right) => left.sourceRevision.localeCompare(right.sourceRevision)),
    forbiddenDigest: sha256(JSON.stringify(forbidden)),
  }));
  return Object.freeze({
    version: STYLE_EVALUATOR_VERSION,
    passed: failedChecks.length === 0,
    score: passedChecks.length / STYLE_EVALUATION_CHECKS.length,
    checks: Object.freeze(passedChecks),
    failedChecks: Object.freeze(failedChecks),
    draftDigest: input.draft.bodyDigest,
    evidenceDigest,
  });
}

/** Store boundary: old/forged placeholder shapes cannot become activatable. */
export function assertStyleProposalEvaluation(
  value: StyleProposalEvaluation,
  expectedDraftDigest: string,
): StyleProposalEvaluation {
  if (value?.version !== STYLE_EVALUATOR_VERSION || value.draftDigest !== expectedDraftDigest
    || !DIGEST.test(value.draftDigest) || !DIGEST.test(value.evidenceDigest)
    || typeof value.passed !== 'boolean' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
    || !Array.isArray(value.checks) || !Array.isArray(value.failedChecks)
    || value.checks.some((check) => !STYLE_EVALUATION_CHECKS.includes(check))
    || value.failedChecks.some((check) => !STYLE_EVALUATION_CHECKS.includes(check))
    || new Set([...value.checks, ...value.failedChecks]).size !== STYLE_EVALUATION_CHECKS.length
    || STYLE_EVALUATION_CHECKS.some((check) => !value.checks.includes(check) && !value.failedChecks.includes(check))
    || value.passed !== (value.failedChecks.length === 0)
    || Math.abs(value.score - (value.checks.length / STYLE_EVALUATION_CHECKS.length)) > 1e-12) {
    throw new TypeError('style proposal evaluation invalid');
  }
  return Object.freeze({
    ...value,
    checks: Object.freeze([...value.checks]),
    failedChecks: Object.freeze([...value.failedChecks]),
  });
}
