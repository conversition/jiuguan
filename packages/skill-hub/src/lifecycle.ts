import { type AgentSkillHeaderV1, normalizeAgentSkillHeader } from './manifest.ts';
import {
  assertExactKeys,
  assertPlainRecord,
  booleanValue,
  deepFreeze,
  digestCanonical,
  isoTimestamp,
  member,
  safeInteger,
  sha256Digest,
  stableToken,
} from './internal.ts';

export const AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION = 'agent-skill-candidate-lifecycle-v1' as const;
export const AGENT_SKILL_CANDIDATE_CREATE_VERSION = 'agent-skill-candidate-create-v1' as const;
export const AGENT_SKILL_CANDIDATE_EVENT_VERSION = 'agent-skill-candidate-event-v1' as const;
export const AGENT_SKILL_CANDIDATE_TRANSITION_VERSION = 'agent-skill-candidate-transition-v1' as const;

export const AGENT_SKILL_CANDIDATE_STATES = Object.freeze([
  'candidate', 'validated', 'replay-passed', 'shadow', 'canary-5', 'canary-25',
  'canary-50', 'active', 'retired', 'rejected', 'killed', 'rolled-back',
] as const);
export type AgentSkillCandidateState = typeof AGENT_SKILL_CANDIDATE_STATES[number];

export const AGENT_SKILL_PROMOTION_STATES = Object.freeze([
  'shadow', 'canary-5', 'canary-25', 'canary-50', 'active',
] as const);
export type AgentSkillPromotionState = typeof AGENT_SKILL_PROMOTION_STATES[number];

export const AGENT_SKILL_REPLAY_CLASSES = Object.freeze(['fixture', 'operational'] as const);
export type AgentSkillReplayClass = typeof AGENT_SKILL_REPLAY_CLASSES[number];

export const AGENT_SKILL_CANDIDATE_EVENT_TYPES = Object.freeze([
  'validation-result', 'replay-result', 'adoption', 'promote', 'retire', 'kill', 'rollback',
] as const);
export type AgentSkillCandidateEventType = typeof AGENT_SKILL_CANDIDATE_EVENT_TYPES[number];

export interface CreateAgentSkillCandidateInputV1 {
  readonly createVersion: typeof AGENT_SKILL_CANDIDATE_CREATE_VERSION;
  readonly header: AgentSkillHeaderV1;
  readonly bundleDigest: string;
  readonly parentBundleDigest: string | null;
  readonly createdAt: string;
}

interface AgentSkillCandidateEventBaseV1 {
  readonly eventVersion: typeof AGENT_SKILL_CANDIDATE_EVENT_VERSION;
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly evidenceDigest: string;
}

export interface AgentSkillValidationResultEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'validation-result';
  readonly passed: boolean;
  readonly reasonCode?: string;
}

export interface AgentSkillReplayResultEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'replay-result';
  readonly replayClass: AgentSkillReplayClass;
  readonly passed: boolean;
  readonly reasonCode?: string;
}

export interface AgentSkillPromoteEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'promote';
  readonly target: AgentSkillPromotionState;
}

/**
 * D-Q3a2c：采用事件。只允许 validated → validated 的 revision 推进（1 → 2），
 * 证据摘要绑定三源汇合/采用回执；不改变 state，也不授予部署或发布权限。
 */
export interface AgentSkillAdoptionEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'adoption';
}

export interface AgentSkillRetireEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'retire';
  readonly reasonCode: string;
}

export interface AgentSkillKillEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'kill';
  readonly reasonCode: string;
}

export interface AgentSkillRollbackEventV1 extends AgentSkillCandidateEventBaseV1 {
  readonly type: 'rollback';
  readonly reasonCode: string;
  readonly targetBundleDigest: string;
}

export type AgentSkillCandidateEventV1 =
  | AgentSkillValidationResultEventV1
  | AgentSkillReplayResultEventV1
  | AgentSkillAdoptionEventV1
  | AgentSkillPromoteEventV1
  | AgentSkillRetireEventV1
  | AgentSkillKillEventV1
  | AgentSkillRollbackEventV1;

export interface AgentSkillCandidateTransitionV1 {
  readonly transitionVersion: typeof AGENT_SKILL_CANDIDATE_TRANSITION_VERSION;
  readonly revision: number;
  readonly eventType: AgentSkillCandidateEventType;
  readonly fromState: AgentSkillCandidateState;
  readonly toState: AgentSkillCandidateState;
  readonly occurredAt: string;
  readonly evidenceDigest: string;
  readonly replayClass?: AgentSkillReplayClass;
  readonly reasonCode?: string;
  readonly targetBundleDigest?: string;
}

export interface AgentSkillCandidateRecordV1 {
  readonly lifecycleVersion: typeof AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION;
  readonly candidateId: string;
  readonly header: AgentSkillHeaderV1;
  readonly bundleDigest: string;
  readonly parentBundleDigest: string | null;
  readonly state: AgentSkillCandidateState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validationEvidenceDigest: string | null;
  readonly operationalReplayEvidenceDigest: string | null;
  readonly history: readonly AgentSkillCandidateTransitionV1[];
}

const CREATE_KEYS = new Set(['createVersion', 'header', 'bundleDigest', 'parentBundleDigest', 'createdAt']);
const RECORD_KEYS = new Set([
  'lifecycleVersion', 'candidateId', 'header', 'bundleDigest', 'parentBundleDigest',
  'state', 'revision', 'createdAt', 'updatedAt', 'validationEvidenceDigest',
  'operationalReplayEvidenceDigest', 'history',
]);
const COMMON_EVENT_KEYS = new Set(['eventVersion', 'type', 'expectedRevision', 'occurredAt', 'evidenceDigest']);
const TRANSITION_KEYS = new Set([
  'transitionVersion', 'revision', 'eventType', 'fromState', 'toState', 'occurredAt',
  'evidenceDigest', 'replayClass', 'reasonCode', 'targetBundleDigest',
]);
const TERMINAL_STATES = new Set<AgentSkillCandidateState>([
  'retired', 'rejected', 'killed', 'rolled-back',
]);
const DEPLOYED_STATES = new Set<AgentSkillCandidateState>([
  'shadow', 'canary-5', 'canary-25', 'canary-50', 'active',
]);
const NEXT_PROMOTION: Readonly<Partial<Record<AgentSkillCandidateState, AgentSkillPromotionState>>> = Object.freeze({
  'replay-passed': 'shadow',
  shadow: 'canary-5',
  'canary-5': 'canary-25',
  'canary-25': 'canary-50',
  'canary-50': 'active',
});

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : sha256Digest(value, label);
}

function expectedCandidateId(
  header: AgentSkillHeaderV1,
  bundleDigest: string,
  parentBundleDigest: string | null,
): string {
  return digestCanonical({
    lifecycleVersion: AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION,
    skillId: header.manifest.skillId,
    version: header.manifest.version,
    manifestDigest: header.manifestDigest,
    bundleDigest,
    parentBundleDigest,
  });
}

export function createAgentSkillCandidate(input: unknown): AgentSkillCandidateRecordV1 {
  assertPlainRecord(input, 'candidateCreate');
  assertExactKeys(input, CREATE_KEYS, CREATE_KEYS, 'candidateCreate');
  if (input.createVersion !== AGENT_SKILL_CANDIDATE_CREATE_VERSION) {
    throw new TypeError(`candidateCreate.createVersion must be ${AGENT_SKILL_CANDIDATE_CREATE_VERSION}`);
  }
  const header = normalizeAgentSkillHeader(input.header);
  const bundleDigest = sha256Digest(input.bundleDigest, 'candidateCreate.bundleDigest');
  const parentBundleDigest = nullableDigest(input.parentBundleDigest, 'candidateCreate.parentBundleDigest');
  if (header.manifest.owner === 'learned' && parentBundleDigest === null) {
    throw new TypeError('learned candidate must bind an immutable parent bundle');
  }
  if (parentBundleDigest === bundleDigest) throw new TypeError('candidate bundle must differ from its parent');
  const createdAt = isoTimestamp(input.createdAt, 'candidateCreate.createdAt');
  return deepFreeze({
    lifecycleVersion: AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION,
    candidateId: expectedCandidateId(header, bundleDigest, parentBundleDigest),
    header,
    bundleDigest,
    parentBundleDigest,
    state: 'candidate',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    validationEvidenceDigest: null,
    operationalReplayEvidenceDigest: null,
    history: Object.freeze([]),
  });
}

function normalizeTransition(input: unknown, index: number): AgentSkillCandidateTransitionV1 {
  assertPlainRecord(input, `candidate.history[${index}]`);
  assertExactKeys(input, TRANSITION_KEYS, new Set([
    'transitionVersion', 'revision', 'eventType', 'fromState', 'toState', 'occurredAt', 'evidenceDigest',
  ]), `candidate.history[${index}]`);
  if (input.transitionVersion !== AGENT_SKILL_CANDIDATE_TRANSITION_VERSION) {
    throw new TypeError(`candidate.history[${index}].transitionVersion is unsupported`);
  }
  return deepFreeze({
    transitionVersion: AGENT_SKILL_CANDIDATE_TRANSITION_VERSION,
    revision: safeInteger(input.revision, `candidate.history[${index}].revision`, 1),
    eventType: member(input.eventType, AGENT_SKILL_CANDIDATE_EVENT_TYPES, `candidate.history[${index}].eventType`),
    fromState: member(input.fromState, AGENT_SKILL_CANDIDATE_STATES, `candidate.history[${index}].fromState`),
    toState: member(input.toState, AGENT_SKILL_CANDIDATE_STATES, `candidate.history[${index}].toState`),
    occurredAt: isoTimestamp(input.occurredAt, `candidate.history[${index}].occurredAt`),
    evidenceDigest: sha256Digest(input.evidenceDigest, `candidate.history[${index}].evidenceDigest`),
    ...(input.replayClass === undefined ? {} : {
      replayClass: member(input.replayClass, AGENT_SKILL_REPLAY_CLASSES, `candidate.history[${index}].replayClass`),
    }),
    ...(input.reasonCode === undefined ? {} : {
      reasonCode: stableToken(input.reasonCode, `candidate.history[${index}].reasonCode`),
    }),
    ...(input.targetBundleDigest === undefined ? {} : {
      targetBundleDigest: sha256Digest(input.targetBundleDigest, `candidate.history[${index}].targetBundleDigest`),
    }),
  });
}

interface ReplayedCandidateState {
  readonly state: AgentSkillCandidateState;
  readonly validationEvidenceDigest: string | null;
  readonly operationalReplayEvidenceDigest: string | null;
}

function assertTransitionFieldAbsent(
  transition: AgentSkillCandidateTransitionV1,
  field: 'replayClass' | 'reasonCode' | 'targetBundleDigest',
  index: number,
): void {
  if (transition[field] !== undefined) {
    throw new TypeError(`candidate.history[${index}].${field} is invalid for ${transition.eventType}`);
  }
}

function assertTransitionReason(
  transition: AgentSkillCandidateTransitionV1,
  index: number,
): asserts transition is AgentSkillCandidateTransitionV1 & { readonly reasonCode: string } {
  if (transition.reasonCode === undefined) {
    throw new TypeError(`candidate.history[${index}].reasonCode is required for ${transition.eventType}`);
  }
}

/**
 * Replays normalized history using the same state-machine rules as
 * transitionAgentSkillCandidate. Persisted records are data, not authority: a
 * contiguous-looking history must not be able to invent a promotion edge or
 * top-level evidence digest.
 */
function replayCandidateHistory(
  history: readonly AgentSkillCandidateTransitionV1[],
  parentBundleDigest: string | null,
): ReplayedCandidateState {
  let state: AgentSkillCandidateState = 'candidate';
  let validationEvidenceDigest: string | null = null;
  let operationalReplayEvidenceDigest: string | null = null;

  for (let index = 0; index < history.length; index += 1) {
    const transition = history[index]!;
    if (transition.fromState !== state) {
      throw new TypeError(`candidate.history[${index}] does not start from the replayed state`);
    }
    if (TERMINAL_STATES.has(state)) {
      throw new TypeError(`candidate.history[${index}] follows terminal state ${state}`);
    }

    if (transition.eventType === 'validation-result') {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      if (state !== 'candidate' || (transition.toState !== 'validated' && transition.toState !== 'rejected')) {
        throw new TypeError(`candidate.history[${index}] has an invalid validation transition`);
      }
      if (transition.toState === 'validated') validationEvidenceDigest = transition.evidenceDigest;
    } else if (transition.eventType === 'replay-result') {
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      if (transition.replayClass === undefined) {
        throw new TypeError(`candidate.history[${index}].replayClass is required for replay-result`);
      }
      if (state !== 'validated') {
        throw new TypeError(`candidate.history[${index}] replay-result requires validated state`);
      }
      if (transition.replayClass === 'fixture') {
        if (transition.toState !== 'validated') {
          throw new TypeError(`candidate.history[${index}] fixture replay cannot change candidate state`);
        }
      } else if (transition.toState === 'replay-passed') {
        operationalReplayEvidenceDigest = transition.evidenceDigest;
      } else if (transition.toState !== 'rejected') {
        throw new TypeError(`candidate.history[${index}] has an invalid operational replay transition`);
      }
    } else if (transition.eventType === 'adoption') {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionFieldAbsent(transition, 'reasonCode', index);
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      if (state !== 'validated' || transition.toState !== 'validated') {
        throw new TypeError(`candidate.history[${index}] has an invalid adoption transition`);
      }
    } else if (transition.eventType === 'promote') {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionFieldAbsent(transition, 'reasonCode', index);
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      const expected: AgentSkillPromotionState | undefined = NEXT_PROMOTION[state];
      if (expected === undefined || transition.toState !== expected) {
        throw new TypeError(`candidate.history[${index}] has an invalid promotion: ${state} -> ${transition.toState}`);
      }
      if (validationEvidenceDigest === null || operationalReplayEvidenceDigest === null) {
        throw new TypeError(`candidate.history[${index}] promotion lacks validation or operational replay evidence`);
      }
    } else if (transition.eventType === 'retire') {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      assertTransitionReason(transition, index);
      if (state !== 'active' || transition.toState !== 'retired') {
        throw new TypeError(`candidate.history[${index}] has an invalid retire transition`);
      }
    } else if (transition.eventType === 'kill') {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionFieldAbsent(transition, 'targetBundleDigest', index);
      assertTransitionReason(transition, index);
      if (transition.toState !== 'killed') {
        throw new TypeError(`candidate.history[${index}] has an invalid kill transition`);
      }
    } else {
      assertTransitionFieldAbsent(transition, 'replayClass', index);
      assertTransitionReason(transition, index);
      if (!DEPLOYED_STATES.has(state) || transition.toState !== 'rolled-back') {
        throw new TypeError(`candidate.history[${index}] has an invalid rollback transition`);
      }
      if (parentBundleDigest === null || transition.targetBundleDigest !== parentBundleDigest) {
        throw new TypeError(`candidate.history[${index}] rollback target must equal the immutable parent bundle`);
      }
    }
    state = transition.toState;
  }

  return { state, validationEvidenceDigest, operationalReplayEvidenceDigest };
}

export function normalizeAgentSkillCandidate(input: unknown): AgentSkillCandidateRecordV1 {
  assertPlainRecord(input, 'candidate');
  assertExactKeys(input, RECORD_KEYS, RECORD_KEYS, 'candidate');
  if (input.lifecycleVersion !== AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION) {
    throw new TypeError(`candidate.lifecycleVersion must be ${AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION}`);
  }
  const header = normalizeAgentSkillHeader(input.header);
  const bundleDigest = sha256Digest(input.bundleDigest, 'candidate.bundleDigest');
  const parentBundleDigest = nullableDigest(input.parentBundleDigest, 'candidate.parentBundleDigest');
  if (header.manifest.owner === 'learned' && parentBundleDigest === null) {
    throw new TypeError('learned candidate must bind an immutable parent bundle');
  }
  if (parentBundleDigest === bundleDigest) throw new TypeError('candidate bundle must differ from its parent');
  const candidateId = sha256Digest(input.candidateId, 'candidate.candidateId');
  if (candidateId !== expectedCandidateId(header, bundleDigest, parentBundleDigest)) {
    throw new TypeError('candidate.candidateId mismatch');
  }
  const state = member(input.state, AGENT_SKILL_CANDIDATE_STATES, 'candidate.state');
  const revision = safeInteger(input.revision, 'candidate.revision', 0);
  const createdAt = isoTimestamp(input.createdAt, 'candidate.createdAt');
  const updatedAt = isoTimestamp(input.updatedAt, 'candidate.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError('candidate.updatedAt precedes createdAt');
  if (!Array.isArray(input.history)) throw new TypeError('candidate.history must be an array');
  const history = input.history.map(normalizeTransition);
  if (history.length !== revision) throw new TypeError('candidate revision/history mismatch');
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    if (item.revision !== index + 1) throw new TypeError('candidate history revisions must be contiguous');
    if (index > 0 && history[index - 1]!.toState !== item.fromState) {
      throw new TypeError('candidate history state chain is broken');
    }
    if (Date.parse(item.occurredAt) < Date.parse(index === 0 ? createdAt : history[index - 1]!.occurredAt)) {
      throw new TypeError('candidate history timestamps must be monotonic');
    }
  }
  if (history.length > 0 && history[history.length - 1]!.occurredAt !== updatedAt) {
    throw new TypeError('candidate current state does not match history tail');
  }
  if (history.length === 0 && (state !== 'candidate' || updatedAt !== createdAt)) {
    throw new TypeError('fresh candidate state is invalid');
  }
  const validationEvidenceDigest = nullableDigest(input.validationEvidenceDigest, 'candidate.validationEvidenceDigest');
  const operationalReplayEvidenceDigest = nullableDigest(
    input.operationalReplayEvidenceDigest,
    'candidate.operationalReplayEvidenceDigest',
  );
  const replayed = replayCandidateHistory(history, parentBundleDigest);
  if (replayed.state !== state) throw new TypeError('candidate current state does not match replayed history');
  if (replayed.validationEvidenceDigest !== validationEvidenceDigest) {
    throw new TypeError('candidate validation evidence does not match replayed history');
  }
  if (replayed.operationalReplayEvidenceDigest !== operationalReplayEvidenceDigest) {
    throw new TypeError('candidate operational replay evidence does not match replayed history');
  }
  const needsValidation = new Set<AgentSkillCandidateState>([
    'validated', 'replay-passed', ...AGENT_SKILL_PROMOTION_STATES, 'retired', 'rolled-back',
  ]).has(state);
  const needsReplay = new Set<AgentSkillCandidateState>([
    'replay-passed', ...AGENT_SKILL_PROMOTION_STATES, 'retired', 'rolled-back',
  ]).has(state);
  if (needsValidation && validationEvidenceDigest === null) throw new TypeError('candidate lacks validation evidence');
  if (needsReplay && operationalReplayEvidenceDigest === null) throw new TypeError('candidate lacks operational replay evidence');
  return deepFreeze({
    lifecycleVersion: AGENT_SKILL_CANDIDATE_LIFECYCLE_VERSION,
    candidateId,
    header,
    bundleDigest,
    parentBundleDigest,
    state,
    revision,
    createdAt,
    updatedAt,
    validationEvidenceDigest,
    operationalReplayEvidenceDigest,
    history: Object.freeze(history),
  });
}

function normalizeEvent(input: unknown): AgentSkillCandidateEventV1 {
  assertPlainRecord(input, 'candidateEvent');
  const type = member(input.type, AGENT_SKILL_CANDIDATE_EVENT_TYPES, 'candidateEvent.type');
  const extra = type === 'validation-result' ? ['passed', 'reasonCode']
    : type === 'replay-result' ? ['replayClass', 'passed', 'reasonCode']
      : type === 'adoption' ? []
        : type === 'promote' ? ['target']
          : type === 'rollback' ? ['reasonCode', 'targetBundleDigest']
            : ['reasonCode'];
  const allowed = new Set([...COMMON_EVENT_KEYS, ...extra]);
  const required = new Set([...COMMON_EVENT_KEYS, ...extra.filter((key) => key !== 'reasonCode')]);
  if (type === 'retire' || type === 'kill' || type === 'rollback') required.add('reasonCode');
  assertExactKeys(input, allowed, required, 'candidateEvent');
  if (input.eventVersion !== AGENT_SKILL_CANDIDATE_EVENT_VERSION) {
    throw new TypeError(`candidateEvent.eventVersion must be ${AGENT_SKILL_CANDIDATE_EVENT_VERSION}`);
  }
  const base = {
    eventVersion: AGENT_SKILL_CANDIDATE_EVENT_VERSION,
    type,
    expectedRevision: safeInteger(input.expectedRevision, 'candidateEvent.expectedRevision', 0),
    occurredAt: isoTimestamp(input.occurredAt, 'candidateEvent.occurredAt'),
    evidenceDigest: sha256Digest(input.evidenceDigest, 'candidateEvent.evidenceDigest'),
  } as const;
  if (type === 'validation-result') {
    return deepFreeze({ ...base, type, passed: booleanValue(input.passed, 'candidateEvent.passed'),
      ...(input.reasonCode === undefined ? {} : { reasonCode: stableToken(input.reasonCode, 'candidateEvent.reasonCode') }) });
  }
  if (type === 'replay-result') {
    return deepFreeze({ ...base, type,
      replayClass: member(input.replayClass, AGENT_SKILL_REPLAY_CLASSES, 'candidateEvent.replayClass'),
      passed: booleanValue(input.passed, 'candidateEvent.passed'),
      ...(input.reasonCode === undefined ? {} : { reasonCode: stableToken(input.reasonCode, 'candidateEvent.reasonCode') }) });
  }
  if (type === 'promote') {
    return deepFreeze({ ...base, type, target: member(input.target, AGENT_SKILL_PROMOTION_STATES, 'candidateEvent.target') });
  }
  if (type === 'adoption') {
    return deepFreeze({ ...base, type });
  }
  const reasonCode = stableToken(input.reasonCode, 'candidateEvent.reasonCode');
  if (type === 'rollback') {
    return deepFreeze({ ...base, type, reasonCode,
      targetBundleDigest: sha256Digest(input.targetBundleDigest, 'candidateEvent.targetBundleDigest') });
  }
  return deepFreeze({ ...base, type, reasonCode });
}

function transitionEntry(
  record: AgentSkillCandidateRecordV1,
  event: AgentSkillCandidateEventV1,
  toState: AgentSkillCandidateState,
): AgentSkillCandidateTransitionV1 {
  return deepFreeze({
    transitionVersion: AGENT_SKILL_CANDIDATE_TRANSITION_VERSION,
    revision: record.revision + 1,
    eventType: event.type,
    fromState: record.state,
    toState,
    occurredAt: event.occurredAt,
    evidenceDigest: event.evidenceDigest,
    ...(event.type === 'replay-result' ? { replayClass: event.replayClass } : {}),
    ...('reasonCode' in event && event.reasonCode !== undefined ? { reasonCode: event.reasonCode } : {}),
    ...(event.type === 'rollback' ? { targetBundleDigest: event.targetBundleDigest } : {}),
  });
}

/** Candidate-level state machine. It cannot mutate lane/capability state and cannot skip gates. */
export function transitionAgentSkillCandidate(
  recordInput: unknown,
  eventInput: unknown,
): AgentSkillCandidateRecordV1 {
  const record = normalizeAgentSkillCandidate(recordInput);
  const event = normalizeEvent(eventInput);
  if (event.expectedRevision !== record.revision) {
    throw new Error(`stale candidate revision: expected ${record.revision}, received ${event.expectedRevision}`);
  }
  if (Date.parse(event.occurredAt) < Date.parse(record.updatedAt)) {
    throw new Error('candidate event timestamp precedes current revision');
  }
  if (TERMINAL_STATES.has(record.state)) throw new Error(`candidate state is terminal: ${record.state}`);

  let state: AgentSkillCandidateState;
  let validationEvidenceDigest = record.validationEvidenceDigest;
  let operationalReplayEvidenceDigest = record.operationalReplayEvidenceDigest;
  if (event.type === 'validation-result') {
    if (record.state !== 'candidate') throw new Error('validation-result is only valid for candidate state');
    state = event.passed ? 'validated' : 'rejected';
    if (event.passed) validationEvidenceDigest = event.evidenceDigest;
  } else if (event.type === 'replay-result') {
    if (record.state !== 'validated') throw new Error('replay-result requires validated state');
    if (event.replayClass === 'fixture') {
      // Fixture evidence is useful diagnostically but never unlocks a promotion state.
      state = 'validated';
    } else if (event.passed) {
      state = 'replay-passed';
      operationalReplayEvidenceDigest = event.evidenceDigest;
    } else {
      state = 'rejected';
    }
  } else if (event.type === 'promote') {
    const expected = NEXT_PROMOTION[record.state];
    if (expected === undefined || event.target !== expected) {
      throw new Error(`invalid candidate promotion: ${record.state} -> ${event.target}`);
    }
    if (record.validationEvidenceDigest === null || record.operationalReplayEvidenceDigest === null) {
      throw new Error('candidate promotion requires validation and operational replay evidence');
    }
    state = event.target;
  } else if (event.type === 'adoption') {
    // 采用只把 validated 推进一个 revision；不改变 state，不进入部署/发布态。
    if (record.state !== 'validated') throw new Error('adoption requires validated state');
    state = 'validated';
  } else if (event.type === 'retire') {
    if (record.state !== 'active') throw new Error('only an active candidate can be retired');
    state = 'retired';
  } else if (event.type === 'kill') {
    state = 'killed';
  } else {
    if (!DEPLOYED_STATES.has(record.state)) throw new Error('rollback requires a deployed candidate state');
    if (record.parentBundleDigest === null) throw new Error('rollback requires a parent bundle');
    if (event.targetBundleDigest !== record.parentBundleDigest) {
      throw new Error('rollback target must equal the immutable parent bundle');
    }
    state = 'rolled-back';
  }

  const transition = transitionEntry(record, event, state);
  return deepFreeze({
    ...record,
    state,
    revision: record.revision + 1,
    updatedAt: event.occurredAt,
    validationEvidenceDigest,
    operationalReplayEvidenceDigest,
    history: Object.freeze([...record.history, transition]),
  });
}
