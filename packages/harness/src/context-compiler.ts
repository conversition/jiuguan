import { createHash } from 'node:crypto';
import { estimateTokens } from '../../prompt/src/assembly.ts';
import type { ChatRequest } from '../../proxy/src/client.ts';

export const CONTEXT_CAPSULE_VERSION = 'context-capsule-v1' as const;
export const CONTEXT_COMPILER_POLICY_VERSION = 'p14-q9r-context-compiler-v1' as const;

/**
 * Absolute structural ceilings for a single bounded compile call.
 *
 * These are safety rails against a misconfigured caller, not the effective budget. The server
 * derives the real input/output allowance from the frozen ModelRuntimeProfile, so a legitimately
 * larger declared window is no longer clamped to a flat 12K/2K constant. Keeping the rails well
 * above one real compile is what lets a width-32K window actually use its ~26K elastic allowance.
 */
export const CONTEXT_COMPILER_LIMITS = Object.freeze({
  minTargetTokens: 256,
  maxTargetTokens: 8_000,
  minBatchTokens: 256,
  maxBatchTokens: 48_000,
  maxOutputTokensCeiling: 8_000,
});

export interface ContextCompilerSourceBlock {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly text: string;
  readonly priority: number;
  readonly required?: boolean;
  readonly containsNegativeFacts?: boolean;
  readonly containsUnresolvedConflicts?: boolean;
}

export interface ContextCapsuleV1 {
  readonly version: typeof CONTEXT_CAPSULE_VERSION;
  readonly sourceDigest: string;
  readonly targetTokens: number;
  readonly facts: readonly { readonly sourceId: string; readonly claim: string; readonly confidence: number }[];
  readonly causalTimeline: readonly { readonly sourceIds: readonly string[]; readonly event: string }[];
  readonly activeConstraints: readonly { readonly sourceIds: readonly string[]; readonly rule: string }[];
  readonly openThreads: readonly { readonly sourceIds: readonly string[]; readonly summary: string }[];
  readonly negativeFacts: readonly { readonly sourceIds: readonly string[]; readonly claim: string }[];
  readonly unresolvedConflicts: readonly { readonly sourceIds: readonly string[]; readonly alternatives: readonly string[] }[];
  readonly omitted: readonly { readonly sourceId: string; readonly reasonCode: string }[];
  readonly coverage: {
    readonly requiredIds: readonly string[];
    readonly retainedIds: readonly string[];
  };
}

export interface ContextCompilerExpectation {
  readonly sourceDigest: string;
  readonly targetTokens: number;
  readonly sourceIds: readonly string[];
  readonly requiredSourceIds: readonly string[];
  readonly negativeFactSourceIds: readonly string[];
  readonly conflictSourceIds: readonly string[];
}

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const REASON_RE = /^[a-z][a-z0-9-]{0,79}$/u;
const CAPSULE_KEYS = new Set([
  'version', 'sourceDigest', 'targetTokens', 'facts', 'causalTimeline', 'activeConstraints',
  'openThreads', 'negativeFacts', 'unresolvedConflicts', 'omitted', 'coverage',
]);

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}-invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}-invalid`);
}

function boundedString(value: unknown, label: string, max = 8_000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error(`${label}-invalid`);
  return value;
}

function sourceId(value: unknown, label: string): string {
  const text = boundedString(value, label, 240);
  if (!SOURCE_ID_RE.test(text)) throw new Error(`${label}-invalid`);
  return text;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label}-invalid`);
  }
  return value as number;
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort((a, b) => a.localeCompare(b));
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label}-duplicate`);
  return Object.freeze(sorted);
}

function normalizeSourceBlocks(blocks: readonly ContextCompilerSourceBlock[]): readonly ContextCompilerSourceBlock[] {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 64) throw new Error('context-compiler-sources-invalid');
  const ids = new Set<string>();
  return Object.freeze(blocks.map((block, index) => {
    plain(block, `source-${index}`);
    const id = sourceId(block.sourceId, `source-${index}-id`);
    if (ids.has(id)) throw new Error('context-compiler-source-id-duplicate');
    ids.add(id);
    const priority = block.priority;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) throw new Error(`source-${index}-priority-invalid`);
    return Object.freeze({
      sourceId: id,
      sourceDigest: digest(block.sourceDigest, `source-${index}-digest`),
      text: boundedString(block.text, `source-${index}-text`, 200_000),
      priority,
      required: block.required === true,
      containsNegativeFacts: block.containsNegativeFacts === true,
      containsUnresolvedConflicts: block.containsUnresolvedConflicts === true,
    });
  }));
}

export function contextCompilerSourceDigest(blocks: readonly ContextCompilerSourceBlock[]): string {
  const normalized = normalizeSourceBlocks(blocks);
  const identity = normalized
    .map((block) => ({ sourceId: block.sourceId, sourceDigest: block.sourceDigest }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return `sha256:${createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex')}`;
}

export function contextCompilerExpectation(
  blocks: readonly ContextCompilerSourceBlock[],
  targetTokens: number,
): ContextCompilerExpectation {
  const normalized = normalizeSourceBlocks(blocks);
  integer(targetTokens, 'context-compiler-target',
    CONTEXT_COMPILER_LIMITS.minTargetTokens, CONTEXT_COMPILER_LIMITS.maxTargetTokens);
  return Object.freeze({
    sourceDigest: contextCompilerSourceDigest(normalized),
    targetTokens,
    sourceIds: uniqueSorted(normalized.map((block) => block.sourceId), 'source-ids'),
    requiredSourceIds: uniqueSorted(normalized.filter((block) => block.required).map((block) => block.sourceId), 'required-source-ids'),
    negativeFactSourceIds: uniqueSorted(normalized.filter((block) => block.containsNegativeFacts).map((block) => block.sourceId), 'negative-source-ids'),
    conflictSourceIds: uniqueSorted(normalized.filter((block) => block.containsUnresolvedConflicts).map((block) => block.sourceId), 'conflict-source-ids'),
  });
}

/** Whole-source batching. No batch contains a copy of the original over-limit aggregate prompt. */
export function partitionContextCompilerSources(
  blocks: readonly ContextCompilerSourceBlock[],
  maxSourceTokens: number,
): readonly (readonly ContextCompilerSourceBlock[])[] {
  const normalized = [...normalizeSourceBlocks(blocks)]
    .sort((a, b) => Number(b.required) - Number(a.required) || b.priority - a.priority || a.sourceId.localeCompare(b.sourceId));
  integer(maxSourceTokens, 'context-compiler-input-budget',
    CONTEXT_COMPILER_LIMITS.minBatchTokens, CONTEXT_COMPILER_LIMITS.maxBatchTokens);
  const batches: ContextCompilerSourceBlock[][] = [];
  let current: ContextCompilerSourceBlock[] = [];
  let currentTokens = 0;
  for (const block of normalized) {
    const tokens = estimateTokens(JSON.stringify({ sourceId: block.sourceId, text: block.text }));
    if (tokens > maxSourceTokens) throw new Error('context-compiler-source-block-too-large');
    if (current.length > 0 && currentTokens + tokens > maxSourceTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

export function buildContextCompilerModelRequest(input: {
  readonly sources: readonly ContextCompilerSourceBlock[];
  readonly targetTokens: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}): { readonly request: ChatRequest; readonly expectation: ContextCompilerExpectation } {
  const sources = normalizeSourceBlocks(input.sources);
  const maxInputTokens = integer(input.maxInputTokens ?? 12_000, 'context-compiler-max-input',
    CONTEXT_COMPILER_LIMITS.minBatchTokens, CONTEXT_COMPILER_LIMITS.maxBatchTokens);
  const maxOutputTokens = integer(input.maxOutputTokens ?? 2_000, 'context-compiler-max-output',
    CONTEXT_COMPILER_LIMITS.minBatchTokens, CONTEXT_COMPILER_LIMITS.maxOutputTokensCeiling);
  const expectation = contextCompilerExpectation(sources, input.targetTokens);
  const payload = {
    sourceDigest: expectation.sourceDigest,
    targetTokens: expectation.targetTokens,
    requiredSourceIds: expectation.requiredSourceIds,
    negativeFactSourceIds: expectation.negativeFactSourceIds,
    conflictSourceIds: expectation.conflictSourceIds,
    sources: sources.map((block) => ({ sourceId: block.sourceId, text: block.text })),
  };
  const request = Object.freeze({
    messages: [
      {
        role: 'system' as const,
        content: [
          '你是有界 Context Compiler，只把给定 elastic context 编译为事实胶囊。',
          '不得改写 system、Skill 或玩家输入；不得创作剧情、调用工具、写数据库或输出思维链。',
          '只输出 context-capsule-v1 JSON。所有事实、时间线、约束、否定事实和冲突都必须引用 sourceId。',
          'requiredSourceIds 必须全部进入 coverage.retainedIds；否定事实与未解冲突不得省略。',
          '无法确认时写入 unresolvedConflicts 或 omitted，不得猜测。',
        ].join('\n'),
      },
      { role: 'user' as const, content: JSON.stringify(payload) },
    ],
    temperature: 0,
    // The capsule itself must fit targetTokens before it can enter the final prompt.
    // Do not let a wider lane ceiling spend tokens on output the parser must reject.
    max_tokens: Math.min(maxOutputTokens, expectation.targetTokens),
  });
  const inputTokens = request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  if (inputTokens > maxInputTokens) throw new Error('context-compiler-input-budget-exceeded');
  return Object.freeze({ request, expectation });
}

function stringArray(
  value: unknown,
  label: string,
  validSources: ReadonlySet<string>,
  max = 64,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > max) throw new Error(`${label}-invalid`);
  const values = value.map((entry, index) => sourceId(entry, `${label}-${index}`));
  if (values.some((id) => !validSources.has(id))) throw new Error(`${label}-unknown-source`);
  return uniqueSorted(values, label);
}

function objectArray(value: unknown, label: string, max = 256): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}-invalid`);
  return value.map((entry, index) => { plain(entry, `${label}-${index}`); return entry; });
}

export function normalizeContextCapsule(
  input: unknown,
  expectation: ContextCompilerExpectation,
): ContextCapsuleV1 {
  plain(input, 'context-capsule');
  if (Object.keys(input).some((key) => !CAPSULE_KEYS.has(key))) throw new Error('context-capsule-unknown-field');
  if (input.version !== CONTEXT_CAPSULE_VERSION) throw new Error('context-capsule-version-invalid');
  if (digest(input.sourceDigest, 'context-capsule-source-digest') !== expectation.sourceDigest) {
    throw new Error('context-capsule-source-digest-mismatch');
  }
  const targetTokens = integer(input.targetTokens, 'context-capsule-target',
    CONTEXT_COMPILER_LIMITS.minTargetTokens, CONTEXT_COMPILER_LIMITS.maxTargetTokens);
  if (targetTokens !== expectation.targetTokens) throw new Error('context-capsule-target-mismatch');
  const validSources = new Set(expectation.sourceIds);
  const facts = objectArray(input.facts, 'facts').map((row, index) => Object.freeze({
    sourceId: stringArray([row.sourceId], `facts-${index}-source`, validSources, 1)[0]!,
    claim: boundedString(row.claim, `facts-${index}-claim`),
    confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : (() => { throw new Error(`facts-${index}-confidence-invalid`); })(),
  }));
  const withSources = (value: unknown, label: string, textKey: 'event' | 'rule' | 'summary' | 'claim') => (
    objectArray(value, label).map((row, index) => Object.freeze({
      sourceIds: stringArray(row.sourceIds, `${label}-${index}-sources`, validSources),
      [textKey]: boundedString(row[textKey], `${label}-${index}-${textKey}`),
    }))
  );
  const causalTimeline = withSources(input.causalTimeline, 'causal-timeline', 'event') as unknown as ContextCapsuleV1['causalTimeline'];
  const activeConstraints = withSources(input.activeConstraints, 'active-constraints', 'rule') as unknown as ContextCapsuleV1['activeConstraints'];
  const openThreads = withSources(input.openThreads, 'open-threads', 'summary') as unknown as ContextCapsuleV1['openThreads'];
  const negativeFacts = withSources(input.negativeFacts, 'negative-facts', 'claim') as unknown as ContextCapsuleV1['negativeFacts'];
  const unresolvedConflicts = objectArray(input.unresolvedConflicts, 'unresolved-conflicts').map((row, index) => {
    if (!Array.isArray(row.alternatives) || row.alternatives.length < 2 || row.alternatives.length > 16) {
      throw new Error(`unresolved-conflicts-${index}-alternatives-invalid`);
    }
    return Object.freeze({
      sourceIds: stringArray(row.sourceIds, `unresolved-conflicts-${index}-sources`, validSources),
      alternatives: Object.freeze(row.alternatives.map((entry, itemIndex) =>
        boundedString(entry, `unresolved-conflicts-${index}-alternative-${itemIndex}`))),
    });
  });
  const omitted = objectArray(input.omitted, 'omitted').map((row, index) => {
    const id = sourceId(row.sourceId, `omitted-${index}-source`);
    if (!validSources.has(id)) throw new Error(`omitted-${index}-unknown-source`);
    const reasonCode = boundedString(row.reasonCode, `omitted-${index}-reason`, 80);
    if (!REASON_RE.test(reasonCode)) throw new Error(`omitted-${index}-reason-invalid`);
    return Object.freeze({ sourceId: id, reasonCode });
  });
  plain(input.coverage, 'coverage');
  const requiredIds = stringArray(input.coverage.requiredIds, 'coverage-required', validSources, 64, true);
  const retainedIds = stringArray(input.coverage.retainedIds, 'coverage-retained', validSources, 64, true);
  if (JSON.stringify(requiredIds) !== JSON.stringify([...expectation.requiredSourceIds].sort())) {
    throw new Error('context-capsule-required-coverage-mismatch');
  }
  if (requiredIds.some((id) => !retainedIds.includes(id))) throw new Error('context-capsule-required-source-omitted');
  if (omitted.some((entry) => requiredIds.includes(entry.sourceId))) throw new Error('context-capsule-required-source-omitted');
  const negativeCovered = new Set(negativeFacts.flatMap((entry) => entry.sourceIds));
  if (expectation.negativeFactSourceIds.some((id) => !negativeCovered.has(id))) {
    throw new Error('context-capsule-negative-fact-missing');
  }
  const conflictCovered = new Set(unresolvedConflicts.flatMap((entry) => entry.sourceIds));
  if (expectation.conflictSourceIds.some((id) => !conflictCovered.has(id))) {
    throw new Error('context-capsule-conflict-missing');
  }
  const capsule: ContextCapsuleV1 = Object.freeze({
    version: CONTEXT_CAPSULE_VERSION,
    sourceDigest: expectation.sourceDigest,
    targetTokens,
    facts: Object.freeze(facts),
    causalTimeline: Object.freeze(causalTimeline),
    activeConstraints: Object.freeze(activeConstraints),
    openThreads: Object.freeze(openThreads),
    negativeFacts: Object.freeze(negativeFacts),
    unresolvedConflicts: Object.freeze(unresolvedConflicts),
    omitted: Object.freeze(omitted),
    coverage: Object.freeze({ requiredIds, retainedIds }),
  });
  if (estimateTokens(JSON.stringify(capsule)) > targetTokens) throw new Error('context-capsule-output-budget-exceeded');
  return capsule;
}

export function parseContextCapsule(
  content: string,
  expectation: ContextCompilerExpectation,
): ContextCapsuleV1 {
  if (typeof content !== 'string' || content.length < 2 || content.length > 200_000) {
    throw new Error('context-capsule-content-invalid');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('context-capsule-json-invalid'); }
  return normalizeContextCapsule(parsed, expectation);
}

/** Process-local ephemeral cache. Keys are digest+target; no audit sink receives capsule content. */
export class ContextCapsuleCache {
  readonly #values = new Map<string, ContextCapsuleV1>();
  constructor(readonly maxEntries = 32) {
    integer(maxEntries, 'context-capsule-cache-size', 1, 256);
  }
  get(sourceDigest: string, targetTokens: number): ContextCapsuleV1 | undefined {
    return this.#values.get(`${digest(sourceDigest, 'cache-source-digest')}:${targetTokens}`);
  }
  set(capsule: ContextCapsuleV1): void {
    const key = `${digest(capsule.sourceDigest, 'cache-source-digest')}:${capsule.targetTokens}`;
    this.#values.delete(key);
    this.#values.set(key, capsule);
    while (this.#values.size > this.maxEntries) this.#values.delete(this.#values.keys().next().value!);
  }
  clear(): void { this.#values.clear(); }
}

