/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2b2b：版本化 Sample execution packet。
 *
 * 一个 Sample 坐标（scenarioOrdinal × repeatIndex × 双臂）对应一条执行证据，显式绑定：
 * 1) Sample 方言的 response digest（不含 usage，既有 SkillSamplePacket 口径）；
 * 2) Candidate receipt 的 response digest（含 usage，Candidate 批次口径）；
 * 3) 两侧都能复算的 common response binding（finishReason + text digest + usage）；
 * 4) Gateway lease audit（content-free 身份/计数，不含 prompt 或正文）。
 *
 * 本模块不存正文，只存 digest 与有界计数；不产生 Gateway/质量/采用 proof。
 */
import { types as nodeTypes } from 'node:util';
import { evalDense, evalDigest, evalFreeze, evalHash, evalRawDigest, evalRecord, evalTime, evalToken } from './skill-evaluate-data.ts';
import {
  SKILL_SAMPLE_SUITE_REPEAT_COUNT,
  SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
} from './skill-sample-registry.ts';

export const SKILL_SAMPLE_EXECUTION_VERSION = 'skill-sample-execution-v1' as const;
export const SKILL_SAMPLE_COMMON_RESPONSE_VERSION = 'skill-sample-common-response-v1' as const;

export const SKILL_SAMPLE_EXECUTION_ERROR_CODES = Object.freeze([
  'skill-sample-execution-invalid',
  'skill-sample-execution-binding-mismatch',
] as const);
export type SkillSampleExecutionErrorCode = typeof SKILL_SAMPLE_EXECUTION_ERROR_CODES[number];

export class SkillSampleExecutionError extends Error {
  constructor(readonly code: SkillSampleExecutionErrorCode) {
    if (!(SKILL_SAMPLE_EXECUTION_ERROR_CODES as readonly unknown[]).includes(code)) {
      throw new Error('skill-sample-execution-error-code-invalid');
    }
    super(code);
    this.name = 'SkillSampleExecutionError';
  }
}

export interface SkillSampleExecutionUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface SkillSampleExecutionArm {
  readonly variant: 'baseline' | 'candidate';
  readonly promptBindingDigest: string;
  /** Sample 方言：不含 usage（既有 SkillSamplePacket.arms[].responseDigest）。 */
  readonly sampleResponseDigest: string;
  /** Sample 方言的正文摘要；common response binding 的输入。 */
  readonly sampleTextDigest: string;
  /** Candidate 批次 receipt 摘要（join candidate-evaluation-batch 的键）。 */
  readonly candidateReceiptDigest: string;
  /** Candidate 方言：含 usage 的 response digest；候选臂未通过时为 null。 */
  readonly candidateResponseDigest: string | null;
  readonly usage: SkillSampleExecutionUsage;
  /** 两侧共同可复算的绑定：finishReason + Sample text digest + usage。 */
  readonly commonResponseBinding: string;
}

export interface SkillSampleExecutionGatewayAudit {
  readonly leaseIdDigest: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sourceRevision: string;
  readonly policyVersion: string;
  readonly modelId: string;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: string;
  readonly modelCallsUsed: number;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
  readonly costMicrousdUsed: number;
  readonly quotaReservationDigest: string | null;
}

export interface SkillSampleExecution {
  readonly executionVersion: typeof SKILL_SAMPLE_EXECUTION_VERSION;
  readonly jobId: string;
  readonly sampleKey: string;
  readonly scenarioOrdinal: number;
  readonly repeatIndex: number;
  readonly planDigest: string;
  readonly arms: readonly [SkillSampleExecutionArm, SkillSampleExecutionArm];
  readonly gatewayAudit: SkillSampleExecutionGatewayAudit;
  readonly joinedAt: string;
  readonly executionDigest: string;
}

const MAX_COUNT = 1_000_000_000;
const AUDIT_OUTCOMES = Object.freeze([
  'completed', 'budget_exhausted', 'usage_unavailable', 'provider_error', 'cancelled', 'expired',
]);

function reject(code: SkillSampleExecutionErrorCode): never {
  throw new SkillSampleExecutionError(code);
}

/** evalRecord 只接受精确键集；审计对象允许 quota 摘要缺省，故这里显式区分必填/可选。 */
function recordWithOptional(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('skill-sample-execution-invalid');
  const allowed = [...required, ...optional];
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))) reject('skill-sample-execution-invalid');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key as string);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('skill-sample-execution-invalid');
  }
  return input as Record<string, unknown>;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_COUNT) reject('skill-sample-execution-invalid');
  return Number(value);
}

function usage(value: unknown): SkillSampleExecutionUsage {
  const row = evalRecord(value, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
  const prompt = count(row.prompt_tokens);
  const completion = count(row.completion_tokens);
  const total = count(row.total_tokens);
  if (total < prompt + completion) reject('skill-sample-execution-invalid');
  return evalFreeze({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: total });
}

/** 两侧共同可复算的 response 绑定：不含 tool call id，也不含候选方言的原始 arguments 字符串。 */
export function skillSampleCommonResponseBinding(input: Readonly<{
  sampleTextDigest: string;
  usage: SkillSampleExecutionUsage;
}>): string {
  return evalDigest({
    bindingVersion: SKILL_SAMPLE_COMMON_RESPONSE_VERSION,
    finishReason: 'tool_calls',
    textDigest: evalHash(input.sampleTextDigest),
    usage: usage(input.usage),
  });
}

function arm(input: unknown, variant: SkillSampleExecutionArm['variant']): SkillSampleExecutionArm {
  const row = evalRecord(input, ['variant', 'promptBindingDigest', 'sampleResponseDigest', 'sampleTextDigest',
    'candidateReceiptDigest', 'candidateResponseDigest', 'usage', 'commonResponseBinding']);
  if (row.variant !== variant) reject('skill-sample-execution-invalid');
  const normalizedUsage = usage(row.usage);
  const sampleResponseDigest = evalHash(row.sampleResponseDigest);
  const sampleTextDigest = evalHash(row.sampleTextDigest);
  const candidateReceiptDigest = evalHash(row.candidateReceiptDigest);
  const candidateResponseDigest = row.candidateResponseDigest === null
    ? null : evalHash(row.candidateResponseDigest);
  const commonResponseBinding = evalHash(row.commonResponseBinding);
  if (commonResponseBinding !== skillSampleCommonResponseBinding({
    sampleTextDigest, usage: normalizedUsage,
  })) reject('skill-sample-execution-invalid');
  return evalFreeze({
    variant,
    promptBindingDigest: evalHash(row.promptBindingDigest),
    sampleResponseDigest,
    sampleTextDigest,
    candidateReceiptDigest,
    candidateResponseDigest,
    usage: normalizedUsage,
    commonResponseBinding,
  });
}

function gatewayAudit(input: unknown): SkillSampleExecutionGatewayAudit {
  const row = recordWithOptional(input,
    ['leaseIdDigest', 'runId', 'parentRunId', 'sourceRevision'],
    ['policyVersion', 'modelId', 'budgetProfileDigest', 'toolSetDigest', 'startedAt', 'finishedAt',
      'outcome', 'modelCallsUsed', 'inputTokensUsed', 'outputTokensUsed', 'costMicrousdUsed',
      'quotaReservationDigest']);
  if (typeof row.outcome !== 'string' || !AUDIT_OUTCOMES.includes(row.outcome)
    || typeof row.policyVersion !== 'string' || row.policyVersion.length < 1
    || typeof row.modelId !== 'string' || row.modelId.length < 1) reject('skill-sample-execution-invalid');
  return evalFreeze({
    leaseIdDigest: evalHash(row.leaseIdDigest),
    runId: evalToken(row.runId),
    parentRunId: evalToken(row.parentRunId),
    sourceRevision: evalToken(row.sourceRevision),
    policyVersion: evalToken(row.policyVersion),
    modelId: evalToken(row.modelId),
    budgetProfileDigest: evalHash(row.budgetProfileDigest),
    toolSetDigest: evalHash(row.toolSetDigest),
    startedAt: evalTime(row.startedAt),
    finishedAt: evalTime(row.finishedAt),
    outcome: row.outcome,
    modelCallsUsed: count(row.modelCallsUsed),
    inputTokensUsed: count(row.inputTokensUsed),
    outputTokensUsed: count(row.outputTokensUsed),
    costMicrousdUsed: count(row.costMicrousdUsed),
    quotaReservationDigest: row.quotaReservationDigest === undefined || row.quotaReservationDigest === null
      ? null : evalHash(row.quotaReservationDigest),
  });
}

export function normalizeSkillSampleExecution(input: unknown): SkillSampleExecution {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('skill-sample-execution-invalid');
    const row = evalRecord(input, ['executionVersion', 'jobId', 'sampleKey', 'scenarioOrdinal',
      'repeatIndex', 'planDigest', 'arms', 'gatewayAudit', 'joinedAt', 'executionDigest']);
    if (row.executionVersion !== SKILL_SAMPLE_EXECUTION_VERSION) reject('skill-sample-execution-invalid');
    const arms = evalDense(row.arms, 2, 2);
    const core = {
      executionVersion: SKILL_SAMPLE_EXECUTION_VERSION,
      jobId: evalToken(row.jobId),
      sampleKey: evalToken(row.sampleKey),
      scenarioOrdinal: count(row.scenarioOrdinal),
      repeatIndex: count(row.repeatIndex),
      planDigest: evalHash(row.planDigest),
      arms: [arm(arms[0], 'baseline'), arm(arms[1], 'candidate')] as const,
      gatewayAudit: gatewayAudit(row.gatewayAudit),
      joinedAt: evalTime(row.joinedAt),
    };
    if (core.sampleKey !== core.jobId
      || core.scenarioOrdinal < 0 || core.scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
      || core.repeatIndex < 0 || core.repeatIndex >= SKILL_SAMPLE_SUITE_REPEAT_COUNT
      || core.gatewayAudit.runId !== core.jobId
      || core.gatewayAudit.finishedAt > core.joinedAt
      || row.executionDigest !== evalDigest(core)) reject('skill-sample-execution-invalid');
    return evalFreeze({ ...core, executionDigest: evalHash(row.executionDigest) });
  } catch (error) {
    if (error instanceof SkillSampleExecutionError) throw error;
    return reject('skill-sample-execution-invalid');
  }
}

/**
 * 与已持久化的 SkillSamplePacket 回读校验：两个方言的摘要必须同时指向同一份物理响应。
 * 只信 Sample packet 里的正文重新计算的 digest；不信任任何预写摘要。
 */
export function verifySkillSampleExecution(
  executionInput: unknown,
  packet: Readonly<{
    jobId: string; planDigest: string;
    arms: readonly Readonly<{
      variant: 'baseline' | 'candidate'; responseDigest: string; text: string;
      usage: SkillSampleExecutionUsage;
    }>[];
  }>,
): void {
  const execution = normalizeSkillSampleExecution(executionInput);
  if (execution.jobId !== packet.jobId || execution.planDigest !== packet.planDigest) {
    reject('skill-sample-execution-binding-mismatch');
  }
  for (const [index, expected] of packet.arms.entries()) {
    const actual = execution.arms[index];
    if (!actual || actual.variant !== expected.variant) reject('skill-sample-execution-binding-mismatch');
    if (actual.sampleResponseDigest !== expected.responseDigest) reject('skill-sample-execution-binding-mismatch');
    if (actual.sampleTextDigest !== evalRawDigest(expected.text)) reject('skill-sample-execution-binding-mismatch');
    if (actual.usage.prompt_tokens !== expected.usage.prompt_tokens
      || actual.usage.completion_tokens !== expected.usage.completion_tokens
      || actual.usage.total_tokens !== expected.usage.total_tokens) {
      reject('skill-sample-execution-binding-mismatch');
    }
    if (actual.commonResponseBinding !== skillSampleCommonResponseBinding({
      sampleTextDigest: evalRawDigest(expected.text), usage: expected.usage,
    })) reject('skill-sample-execution-binding-mismatch');
  }
}
