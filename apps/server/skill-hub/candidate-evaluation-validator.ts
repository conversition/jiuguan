/** @author Codex @date 2026-10-17 @version 1.0
 * Closed, process-local envelope validator for one dispatched Candidate replay sample.
 * It owns no Provider, Candidate, Store, lifecycle, promotion, or publication authority.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { ChatResponse } from '../../../packages/proxy/public/client.ts';
import type { AgentSkillValidatorPlanEntryV1 } from '@jiuguan/prompt/agent-skill-compiler';

export const CANDIDATE_EVALUATION_VALIDATOR_VERSION = 'candidate-evaluation-validator-v1' as const;
export const CANDIDATE_EVALUATION_SLOT_TICKET_VERSION = 'candidate-evaluation-slot-ticket-v1' as const;
export const CANDIDATE_EVALUATION_RECEIPT_VERSION = 'candidate-evaluation-receipt-v1' as const;
// The global compiler registry stays frozen at v1.0.0. This exact host manifest specializes its
// existing schema check; Candidate envelope semantics remain bound by the manifest and policy digest.
export const CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID = 'turn.schema' as const;
export const CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID =
  'evaluator.turn-schema' as const;
export const CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME = 'submit_skill_sample' as const;

// Skill versions may contain SemVer build metadata; all other ticket labels stay bounded.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT_CHARS = 6_000;
const MAX_ARGUMENT_CHARS = 65_536;

export const CANDIDATE_EVALUATION_VALIDATOR_ERROR_CODES = Object.freeze([
  'candidate-evaluation-slot-invalid',
  'candidate-evaluation-validator-plan-invalid',
  'candidate-evaluation-ticket-not-owned',
  'candidate-evaluation-ticket-replayed',
  'candidate-evaluation-terminal-invalid',
  'candidate-evaluation-proof-not-owned',
  'candidate-evaluation-receipt-invalid',
] as const);
export type CandidateEvaluationValidatorErrorCode =
  typeof CANDIDATE_EVALUATION_VALIDATOR_ERROR_CODES[number];

export class CandidateEvaluationValidatorError extends Error {
  constructor(readonly code: CandidateEvaluationValidatorErrorCode) {
    if (!(CANDIDATE_EVALUATION_VALIDATOR_ERROR_CODES as readonly unknown[]).includes(code)) {
      throw new Error('candidate-evaluation-error-code-invalid');
    }
    super(code);
    this.name = 'CandidateEvaluationValidatorError';
  }
}

export type CandidateEvaluationArm = 'baseline' | 'candidate';
export type CandidateEvaluationFailure =
  'provider-error' | 'timeout' | 'cancelled' | 'validator-error';
export type CandidateEvaluationOutcome = 'passed' | 'failed' | 'inconclusive' | 'invalid';
export const CANDIDATE_EVALUATION_REASON_CODES = Object.freeze([
  'candidate-evaluation-passed',
  'candidate-evaluation-response-invalid',
  'candidate-evaluation-provider-error',
  'candidate-evaluation-timeout',
  'candidate-evaluation-cancelled',
  'candidate-evaluation-validator-error',
] as const);
export type CandidateEvaluationReasonCode =
  typeof CANDIDATE_EVALUATION_REASON_CODES[number];

export interface CandidateEvaluationSlotInput {
  readonly planDigest: string;
  readonly sampleKey: string;
  readonly arm: CandidateEvaluationArm;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly candidateBindingDigest: string;
  readonly sourceAuthorityRevision: string;
  readonly compiledArtifactDigest: string;
  readonly validatorPlanDigest: string;
  readonly requestDigest: string;
  readonly promptBindingDigest: string;
  readonly validatorPlan: readonly AgentSkillValidatorPlanEntryV1[];
}

export interface CandidateEvaluationSlotBinding {
  readonly planDigest: string;
  readonly sampleKey: string;
  readonly arm: CandidateEvaluationArm;
  readonly attemptId: string;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly candidateBindingDigest: string;
  readonly sourceAuthorityRevision: string;
  readonly compiledArtifactDigest: string;
  readonly validatorPlanDigest: string;
  readonly requestDigest: string;
  readonly promptBindingDigest: string;
}

export interface CandidateEvaluationSlotTicket {
  readonly ticketVersion: typeof CANDIDATE_EVALUATION_SLOT_TICKET_VERSION;
  readonly slotDigest: string;
}

export interface CandidateEvaluationReceipt extends CandidateEvaluationSlotBinding {
  readonly receiptVersion: typeof CANDIDATE_EVALUATION_RECEIPT_VERSION;
  readonly slotDigest: string;
  readonly responseDigest: string | null;
  readonly outcome: CandidateEvaluationOutcome;
  readonly reasonCode: CandidateEvaluationReasonCode;
  readonly validatorVersion: typeof CANDIDATE_EVALUATION_VALIDATOR_VERSION;
  readonly validatorPolicyDigest: string;
  readonly occurredAt: string;
  readonly receiptDigest: string;
}

declare const CANDIDATE_EVALUATION_PROOF: unique symbol;
export interface CandidateEvaluationProof {
  readonly [CANDIDATE_EVALUATION_PROOF]: true;
}

interface OpenSlot {
  readonly binding: CandidateEvaluationSlotBinding;
  readonly slotDigest: string;
  consumed: boolean;
}

interface ProofEntry {
  readonly owner: object;
  readonly ticket: object;
  readonly receipt: CandidateEvaluationReceipt;
}

const PROOFS = new WeakMap<object, ProofEntry>();
const AUTHORITIES = new WeakSet<object>();

function reject(code: CandidateEvaluationValidatorErrorCode): never {
  throw new CandidateEvaluationValidatorError(code);
}

function record(input: unknown, required: readonly string[], optional: readonly string[] = []):
  Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('data-invalid');
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string'
    || !required.includes(key) && !optional.includes(key))
    || required.some((key) => !keys.includes(key))) throw new Error('data-invalid');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('data-invalid');
  }
  return input as Record<string, unknown>;
}

function dense(input: unknown, exactLength: number): readonly unknown[] {
  if (!Array.isArray(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Array.prototype || input.length !== exactLength
    || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('data-invalid');
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('data-invalid');
    return descriptor.value;
  });
}

function canonical(input: unknown): string {
  if (input === null || typeof input !== 'object') {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) throw new Error('data-invalid');
    return encoded;
  }
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value).sort().map((key) => {
    const child = value[key];
    if (child === undefined) throw new Error('data-invalid');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}

function digest(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(input), 'utf8').digest('hex')}`;
}

function deepFreeze<T>(input: T): T {
  if (input && typeof input === 'object' && !Object.isFrozen(input)) {
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
    }
    Object.freeze(input);
  }
  return input;
}

function hash(input: unknown): string {
  if (typeof input !== 'string' || !HASH.test(input)) throw new Error('data-invalid');
  return input;
}

function token(input: unknown): string {
  if (typeof input !== 'string' || !TOKEN.test(input)) throw new Error('data-invalid');
  return input;
}

function time(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))
    || new Date(input).toISOString() !== input) throw new Error('data-invalid');
  return input;
}

function normalizeValidatorPlan(input: unknown, claimedDigest: unknown): string {
  try {
    const item = record(dense(input, 1)[0], [
      'skillId', 'version', 'manifestDigest', 'evaluatorId', 'checkId', 'severityId', 'entryDigest',
    ]);
    const core = {
      skillId: token(item.skillId), version: token(item.version),
      manifestDigest: hash(item.manifestDigest), evaluatorId: item.evaluatorId,
      checkId: item.checkId, severityId: item.severityId,
    };
    if (core.evaluatorId !== CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID
      || core.checkId !== CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID || core.severityId !== 'error'
      || hash(item.entryDigest) !== digest(core)) throw new Error('plan-invalid');
    const entry = deepFreeze({ ...core, entryDigest: item.entryDigest as string });
    const plan = Object.freeze([entry]);
    const planDigest = hash(claimedDigest);
    if (planDigest !== digest(plan)) throw new Error('plan-invalid');
    return planDigest;
  } catch { reject('candidate-evaluation-validator-plan-invalid'); }
}

function normalizeSlotInput(input: unknown): CandidateEvaluationSlotBinding {
  try {
    const value = record(input, [
      'planDigest', 'sampleKey', 'arm', 'attemptId', 'candidateId', 'candidateRevision',
      'candidateBindingDigest', 'sourceAuthorityRevision', 'compiledArtifactDigest',
      'validatorPlanDigest', 'requestDigest', 'promptBindingDigest', 'validatorPlan',
    ]);
    const validatorPlanDigest = normalizeValidatorPlan(value.validatorPlan, value.validatorPlanDigest);
    if (value.arm !== 'baseline' && value.arm !== 'candidate') throw new Error('slot-invalid');
    if (value.candidateRevision !== 1) throw new Error('slot-invalid');
    return deepFreeze({
      planDigest: hash(value.planDigest), sampleKey: token(value.sampleKey), arm: value.arm,
      attemptId: token(value.attemptId), candidateId: hash(value.candidateId), candidateRevision: 1 as const,
      candidateBindingDigest: hash(value.candidateBindingDigest),
      sourceAuthorityRevision: hash(value.sourceAuthorityRevision),
      compiledArtifactDigest: hash(value.compiledArtifactDigest), validatorPlanDigest,
      requestDigest: hash(value.requestDigest), promptBindingDigest: hash(value.promptBindingDigest),
    });
  } catch (error) {
    if (error instanceof CandidateEvaluationValidatorError) throw error;
    reject('candidate-evaluation-slot-invalid');
  }
}

function normalizeSlotBinding(input: unknown): CandidateEvaluationSlotBinding {
  const value = record(input, [
    'planDigest', 'sampleKey', 'arm', 'attemptId', 'candidateId', 'candidateRevision',
    'candidateBindingDigest', 'sourceAuthorityRevision', 'compiledArtifactDigest',
    'validatorPlanDigest', 'requestDigest', 'promptBindingDigest',
  ]);
  if (value.arm !== 'baseline' && value.arm !== 'candidate') throw new Error('data-invalid');
  if (value.candidateRevision !== 1) throw new Error('data-invalid');
  return deepFreeze({
    planDigest: hash(value.planDigest), sampleKey: token(value.sampleKey), arm: value.arm,
    attemptId: token(value.attemptId), candidateId: hash(value.candidateId), candidateRevision: 1 as const,
    candidateBindingDigest: hash(value.candidateBindingDigest),
    sourceAuthorityRevision: hash(value.sourceAuthorityRevision),
    compiledArtifactDigest: hash(value.compiledArtifactDigest),
    validatorPlanDigest: hash(value.validatorPlanDigest), requestDigest: hash(value.requestDigest),
    promptBindingDigest: hash(value.promptBindingDigest),
  });
}

export const CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST = digest({
  validatorVersion: CANDIDATE_EVALUATION_VALIDATOR_VERSION,
  evaluatorId: CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID,
  checkId: CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID,
  severityId: 'error', forcedToolName: CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME,
  response: {
    content: 'null-or-empty', finishReason: 'tool_calls', exactToolCalls: 1,
    exactArguments: ['text'], textMinimumCharacters: 1, textMaximumCharacters: MAX_TEXT_CHARS,
    usage: 'optional-nonnegative-safe-integers-with-total-at-least-visible-sum',
  },
});

function uniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let index = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  };
  const jsonString = (): string => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error('json-invalid');
  };
  const visit = (depth: number): void => {
    if (depth > 16 || ++nodes > 128) throw new Error('json-invalid');
    whitespace();
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = jsonString();
        if (keys.has(key)) throw new Error('json-invalid');
        keys.add(key);
        whitespace();
        if (text[index++] !== ':') throw new Error('json-invalid');
        visit(depth + 1);
        whitespace();
        const delimiter = text[index++];
        if (delimiter === '}') return;
        if (delimiter !== ',') throw new Error('json-invalid');
      }
      throw new Error('json-invalid');
    }
    if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        visit(depth + 1);
        whitespace();
        const delimiter = text[index++];
        if (delimiter === ']') return;
        if (delimiter !== ',') throw new Error('json-invalid');
      }
      throw new Error('json-invalid');
    }
    if (text[index] === '"') { jsonString(); return; }
    const start = index;
    while (index < text.length && !/[\s,}\]]/u.test(text[index]!)) index += 1;
    if (index === start) throw new Error('json-invalid');
  };
  visit(0);
  whitespace();
  if (index !== text.length) throw new Error('json-invalid');
  return parsed;
}

interface NormalizedUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cached_input_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
}

function normalizeUsage(input: unknown): NormalizedUsage | null {
  if (input === undefined || input === null) return null;
  const required = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  const optional = ['cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens'];
  const value = record(input, required, optional);
  for (const key of [...required, ...optional]) {
    if (value[key] !== undefined
      && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new Error('usage-invalid');
  }
  if (Number(value.total_tokens) < Number(value.prompt_tokens) + Number(value.completion_tokens)) {
    throw new Error('usage-invalid');
  }
  const normalized: Record<string, number> = {
    prompt_tokens: Number(value.prompt_tokens), completion_tokens: Number(value.completion_tokens),
    total_tokens: Number(value.total_tokens),
  };
  for (const key of optional) {
    if (value[key] !== undefined) normalized[key] = Number(value[key]);
  }
  return deepFreeze(normalized) as unknown as NormalizedUsage;
}

function validatedResponseDigest(input: unknown): string {
  const value = record(input, ['content', 'toolCalls', 'finishReason', 'raw'], ['usage']);
  if (value.content !== null && value.content !== '') throw new Error('response-invalid');
  if (value.finishReason !== 'tool_calls') throw new Error('response-invalid');
  const call = record(dense(value.toolCalls, 1)[0], ['id', 'name', 'arguments']);
  const id = token(call.id);
  if (call.name !== CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME
    || typeof call.arguments !== 'string' || call.arguments.length < 1
    || call.arguments.length > MAX_ARGUMENT_CHARS) throw new Error('response-invalid');
  const output = record(uniqueJson(call.arguments), ['text']);
  if (typeof output.text !== 'string' || output.text.length < 1
    || output.text.length > MAX_TEXT_CHARS || output.text.trim().length === 0) {
    throw new Error('response-invalid');
  }
  const usage = normalizeUsage(value.usage);
  return digest({
    content: value.content,
    toolCalls: [{ id, name: CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME, arguments: call.arguments }],
    finishReason: 'tool_calls', usage,
  });
}

function reasonForFailure(failure: CandidateEvaluationFailure): CandidateEvaluationReasonCode {
  switch (failure) {
    case 'provider-error': return 'candidate-evaluation-provider-error';
    case 'timeout': return 'candidate-evaluation-timeout';
    case 'cancelled': return 'candidate-evaluation-cancelled';
    case 'validator-error': return 'candidate-evaluation-validator-error';
  }
}

function outcomeForFailure(failure: CandidateEvaluationFailure): CandidateEvaluationOutcome {
  return failure === 'validator-error' ? 'invalid' : 'inconclusive';
}

function validOutcomeReason(
  outcome: unknown,
  reasonCode: unknown,
  responseDigest: unknown,
): outcome is CandidateEvaluationOutcome {
  if (outcome === 'passed') {
    return reasonCode === 'candidate-evaluation-passed'
      && typeof responseDigest === 'string' && HASH.test(responseDigest);
  }
  if (responseDigest !== null) return false;
  if (outcome === 'failed') return reasonCode === 'candidate-evaluation-response-invalid';
  if (outcome === 'inconclusive') {
    return reasonCode === 'candidate-evaluation-provider-error'
      || reasonCode === 'candidate-evaluation-timeout'
      || reasonCode === 'candidate-evaluation-cancelled';
  }
  return outcome === 'invalid' && reasonCode === 'candidate-evaluation-validator-error';
}

function terminalReceipt(
  slot: OpenSlot,
  outcome: CandidateEvaluationOutcome,
  reasonCode: CandidateEvaluationReasonCode,
  responseDigest: string | null,
  occurredAt: string,
): CandidateEvaluationReceipt {
  const core = deepFreeze({
    receiptVersion: CANDIDATE_EVALUATION_RECEIPT_VERSION,
    ...slot.binding,
    slotDigest: slot.slotDigest,
    responseDigest,
    outcome,
    reasonCode,
    validatorVersion: CANDIDATE_EVALUATION_VALIDATOR_VERSION,
    validatorPolicyDigest: CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
    occurredAt,
  });
  return normalizeCandidateEvaluationReceipt({ ...core, receiptDigest: digest(core) });
}

function issueProof(owner: object, ticket: object,
  receipt: CandidateEvaluationReceipt): CandidateEvaluationProof {
  const proof = Object.freeze({}) as CandidateEvaluationProof;
  PROOFS.set(proof, Object.freeze({ owner, ticket, receipt }));
  return proof;
}

/** Strict data validation never recovers the process-local authority of a live proof. */
export function normalizeCandidateEvaluationReceipt(input: unknown): CandidateEvaluationReceipt {
  try {
    const value = record(input, [
      'receiptVersion', 'planDigest', 'sampleKey', 'arm', 'attemptId', 'candidateId',
      'candidateRevision', 'candidateBindingDigest', 'sourceAuthorityRevision',
      'compiledArtifactDigest', 'validatorPlanDigest', 'requestDigest', 'promptBindingDigest',
      'slotDigest', 'responseDigest', 'outcome', 'reasonCode', 'validatorVersion',
      'validatorPolicyDigest', 'occurredAt', 'receiptDigest',
    ]);
    const binding = normalizeSlotBinding({
      planDigest: value.planDigest,
      sampleKey: value.sampleKey,
      arm: value.arm,
      attemptId: value.attemptId,
      candidateId: value.candidateId,
      candidateRevision: value.candidateRevision,
      candidateBindingDigest: value.candidateBindingDigest,
      sourceAuthorityRevision: value.sourceAuthorityRevision,
      compiledArtifactDigest: value.compiledArtifactDigest,
      validatorPlanDigest: value.validatorPlanDigest,
      requestDigest: value.requestDigest,
      promptBindingDigest: value.promptBindingDigest,
    });
    const slotDigest = hash(value.slotDigest);
    const outcome = value.outcome;
    const reasonCode = value.reasonCode;
    if (value.receiptVersion !== CANDIDATE_EVALUATION_RECEIPT_VERSION
      || value.validatorVersion !== CANDIDATE_EVALUATION_VALIDATOR_VERSION
      || value.validatorPolicyDigest !== CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST
      || slotDigest !== digest(binding)
      || (value.responseDigest !== null
        && (typeof value.responseDigest !== 'string' || !HASH.test(value.responseDigest)))
      || !CANDIDATE_EVALUATION_REASON_CODES.includes(reasonCode as CandidateEvaluationReasonCode)
      || !validOutcomeReason(outcome, reasonCode, value.responseDigest)) {
      throw new Error('receipt-invalid');
    }
    const core = deepFreeze({
      receiptVersion: CANDIDATE_EVALUATION_RECEIPT_VERSION,
      ...binding,
      slotDigest,
      responseDigest: value.responseDigest as string | null,
      outcome: outcome as CandidateEvaluationOutcome,
      reasonCode: reasonCode as CandidateEvaluationReasonCode,
      validatorVersion: CANDIDATE_EVALUATION_VALIDATOR_VERSION,
      validatorPolicyDigest: CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
      occurredAt: time(value.occurredAt),
    });
    if (hash(value.receiptDigest) !== digest(core)) throw new Error('receipt-invalid');
    return deepFreeze({ ...core, receiptDigest: value.receiptDigest as string });
  } catch { reject('candidate-evaluation-receipt-invalid'); }
}

export function readCandidateEvaluationProof(input: unknown): CandidateEvaluationReceipt {
  const retained = input && typeof input === 'object' ? PROOFS.get(input) : undefined;
  if (!retained) reject('candidate-evaluation-proof-not-owned');
  return normalizeCandidateEvaluationReceipt(retained.receipt);
}

export interface CandidateEvaluationValidatorAuthority {
  issueSlot(input: unknown): CandidateEvaluationSlotTicket;
  evaluate(input: Readonly<{
    ticket: unknown;
    response: ChatResponse;
    occurredAt: string;
  }>): CandidateEvaluationProof;
  terminalizeFailure(input: Readonly<{
    ticket: unknown;
    failure: CandidateEvaluationFailure;
    occurredAt: string;
  }>): CandidateEvaluationProof;
  /** Returns all terminal outcomes; consumers must explicitly require `outcome === 'passed'`. */
  readCurrent(proof: unknown): CandidateEvaluationReceipt | null;
  /** Exact ticket identity is required when a proof is used to close a durable claim. */
  readCurrentForTicket(ticket: unknown, proof: unknown): CandidateEvaluationReceipt | null;
}

export interface CandidateEvaluationValidatorAuthorityOptions {
  readonly expectedCandidate?: Readonly<{
    candidateId: string;
    candidateRevision: 1;
    candidateBindingDigest: string;
    sourceAuthorityRevision: string;
  }>;
  readonly expectedValidatorPlanDigest?: string;
  /** Host-owned currentness check; false or throw revokes tickets and live proofs. */
  readonly isCurrent?: () => boolean;
}

export function isCandidateEvaluationValidatorAuthority(
  input: unknown,
): input is CandidateEvaluationValidatorAuthority {
  return Boolean(input && typeof input === 'object' && AUTHORITIES.has(input));
}

/** One authority instance recognizes only its own ticket/proof identities; copying bytes grants nothing. */
export function createCandidateEvaluationValidatorAuthority(
  options: CandidateEvaluationValidatorAuthorityOptions = {},
): CandidateEvaluationValidatorAuthority {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some((key) => ![
      'expectedCandidate', 'expectedValidatorPlanDigest', 'isCurrent',
    ].includes(String(key)))
    || options.isCurrent !== undefined && typeof options.isCurrent !== 'function') {
    reject('candidate-evaluation-slot-invalid');
  }
  let expectedCandidate: CandidateEvaluationValidatorAuthorityOptions['expectedCandidate'];
  let expectedValidatorPlanDigest: string | undefined;
  try {
    expectedValidatorPlanDigest = options.expectedValidatorPlanDigest === undefined
      ? undefined
      : hash(options.expectedValidatorPlanDigest);
  } catch { reject('candidate-evaluation-slot-invalid'); }
  if (options.expectedCandidate !== undefined) {
    try {
      const value = record(options.expectedCandidate, [
        'candidateId', 'candidateRevision', 'candidateBindingDigest', 'sourceAuthorityRevision',
      ]);
      if (value.candidateRevision !== 1) throw new Error('candidate-invalid');
      expectedCandidate = deepFreeze({
        candidateId: hash(value.candidateId),
        candidateRevision: 1 as const,
        candidateBindingDigest: hash(value.candidateBindingDigest),
        sourceAuthorityRevision: hash(value.sourceAuthorityRevision),
      });
    } catch { reject('candidate-evaluation-slot-invalid'); }
  }
  const owner = Object.freeze({});
  const slots = new WeakMap<object, OpenSlot>();
  const current = (): boolean => {
    try { return options.isCurrent?.() !== false; }
    catch { return false; }
  };

  const take = (ticket: unknown, occurredAt: unknown): OpenSlot => {
    try { time(occurredAt); } catch { reject('candidate-evaluation-terminal-invalid'); }
    if (!ticket || typeof ticket !== 'object') reject('candidate-evaluation-ticket-not-owned');
    const slot = slots.get(ticket);
    if (!slot) reject('candidate-evaluation-ticket-not-owned');
    if (slot.consumed) reject('candidate-evaluation-ticket-replayed');
    slot.consumed = true;
    return slot;
  };

  const readCurrent = (proof: unknown, exactTicket?: object): CandidateEvaluationReceipt | null => {
    if (!current()) return null;
    if (!proof || typeof proof !== 'object') return null;
    const retained = PROOFS.get(proof);
    if (!retained || retained.owner !== owner
      || exactTicket !== undefined && retained.ticket !== exactTicket) return null;
    try {
      const receipt = normalizeCandidateEvaluationReceipt(retained.receipt);
      if (expectedCandidate && (receipt.candidateId !== expectedCandidate.candidateId
        || receipt.candidateRevision !== expectedCandidate.candidateRevision
        || receipt.candidateBindingDigest !== expectedCandidate.candidateBindingDigest
        || receipt.sourceAuthorityRevision !== expectedCandidate.sourceAuthorityRevision)) return null;
      return current() ? receipt : null;
    }
    catch { return null; }
  };

  const authority = Object.freeze({
    issueSlot(input: unknown): CandidateEvaluationSlotTicket {
      if (!current()) reject('candidate-evaluation-slot-invalid');
      const binding = normalizeSlotInput(input);
      if (expectedCandidate && (binding.candidateId !== expectedCandidate.candidateId
        || binding.candidateRevision !== expectedCandidate.candidateRevision
        || binding.candidateBindingDigest !== expectedCandidate.candidateBindingDigest
        || binding.sourceAuthorityRevision !== expectedCandidate.sourceAuthorityRevision)) {
        reject('candidate-evaluation-slot-invalid');
      }
      if (expectedValidatorPlanDigest !== undefined
        && binding.validatorPlanDigest !== expectedValidatorPlanDigest) {
        reject('candidate-evaluation-validator-plan-invalid');
      }
      if (!current()) reject('candidate-evaluation-slot-invalid');
      const slotDigest = digest(binding);
      const ticket = Object.freeze({
        ticketVersion: CANDIDATE_EVALUATION_SLOT_TICKET_VERSION,
        slotDigest,
      });
      slots.set(ticket, { binding, slotDigest, consumed: false });
      return ticket;
    },

    evaluate(input: Readonly<{
      ticket: unknown;
      response: ChatResponse;
      occurredAt: string;
    }>): CandidateEvaluationProof {
      let value: Record<string, unknown>;
      try { value = record(input, ['ticket', 'response', 'occurredAt']); }
      catch { reject('candidate-evaluation-terminal-invalid'); }
      let occurredAt: string;
      try { occurredAt = time(value.occurredAt); }
      catch { reject('candidate-evaluation-terminal-invalid'); }
      const slot = take(value.ticket, occurredAt);
      const ticket = value.ticket as object;
      try {
        const responseDigest = validatedResponseDigest(value.response);
        return issueProof(owner, ticket, terminalReceipt(
          slot, 'passed', 'candidate-evaluation-passed', responseDigest, occurredAt,
        ));
      } catch {
        return issueProof(owner, ticket, terminalReceipt(
          slot, 'failed', 'candidate-evaluation-response-invalid', null, occurredAt,
        ));
      }
    },

    terminalizeFailure(input: Readonly<{
      ticket: unknown;
      failure: CandidateEvaluationFailure;
      occurredAt: string;
    }>): CandidateEvaluationProof {
      let value: Record<string, unknown>;
      try { value = record(input, ['ticket', 'failure', 'occurredAt']); }
      catch { reject('candidate-evaluation-terminal-invalid'); }
      if (!['provider-error', 'timeout', 'cancelled', 'validator-error'].includes(String(value.failure))) {
        reject('candidate-evaluation-terminal-invalid');
      }
      let occurredAt: string;
      try { occurredAt = time(value.occurredAt); }
      catch { reject('candidate-evaluation-terminal-invalid'); }
      const failure = value.failure as CandidateEvaluationFailure;
      const slot = take(value.ticket, occurredAt);
      return issueProof(owner, value.ticket as object, terminalReceipt(
        slot, outcomeForFailure(failure), reasonForFailure(failure), null, occurredAt,
      ));
    },

    readCurrent(proof: unknown): CandidateEvaluationReceipt | null {
      return readCurrent(proof);
    },

    readCurrentForTicket(ticket: unknown, proof: unknown): CandidateEvaluationReceipt | null {
      if (!ticket || typeof ticket !== 'object') return null;
      return readCurrent(proof, ticket);
    },
  });
  AUTHORITIES.add(authority);
  return authority;
}
