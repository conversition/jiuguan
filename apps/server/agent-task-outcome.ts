/** HC-4a: a read-only, non-authorizing view of the original Closure evidence. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  AGENT_CLOSURE_CAPABILITY_CONTRACTS,
  AGENT_CLOSURE_CONTRACT_VERSION,
  agentClosureTimestamp,
  agentClosureToken,
  foldAgentClosure,
  normalizeAgentClosureEvent,
  normalizeAgentClosureRun,
  type AgentClosureEvent,
  type AgentClosureEventInput,
} from '../../packages/agent-closure/index.ts';
import type { AgentClosureRecord } from './agent-closure-store.ts';

export const AGENT_TASK_OUTCOME_VERSION = 'agent-task-outcome-v1' as const;
export interface AgentTaskOutcomeEvidenceRef {
  readonly kind: 'closure-event' | 'closure-contract';
  readonly refId: string;
  readonly sourceDigest: string;
  readonly occurredAt: string;
}
type Axis<State extends string> = Readonly<{
  state: State;
  evidence: readonly AgentTaskOutcomeEvidenceRef[];
}>;
type ReportedOutcome = NonNullable<AgentClosureEvent['effectOutcome']>;
export interface AgentTaskOutcomeV1 {
  readonly version: typeof AGENT_TASK_OUTCOME_VERSION;
  readonly identity: Readonly<{
    source: 'agent-closure'; operationId: string; runId: string;
    parentRunId: string | null; attempt: null;
  }>;
  readonly capability: AgentClosureRecord['capability'];
  readonly lane: AgentClosureRecord['lane'];
  readonly kind: AgentClosureRecord['kind'];
  readonly executionClass: AgentClosureRecord['executionClass'];
  readonly source: Readonly<{ revision: number; digest: string }>;
  readonly axes: Readonly<{
    execution: Axis<'completed' | 'no-op' | 'failed' | 'cancelled' | 'unknown'>;
    verification: Axis<'validated' | 'unknown'>;
    commit: Axis<'committed' | 'rolled-back' | 'not-applicable' | 'unknown'> & Readonly<{
      reasonCode?: 'advisory-no-business-write';
    }>;
    adoption: Axis<'consumed' | 'unknown'> & Readonly<{
      validity: 'invalidated' | 'not-checked';
    }>;
    effect: Axis<'observed' | 'unknown'> & Readonly<{
      reportedOutcomes: readonly ReportedOutcome[];
      independentOutcome: 'unknown';
    }>;
  }>;
  readonly learningWeight: 0;
  readonly authorizesExecution: false;
  readonly authorizesPromotion: false;
}

function invalid(): never { throw new TypeError('agent-task-outcome-invalid'); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : invalid();
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return invalid();
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
  )).join(',')}}`;
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}
/** Only original own data is inspected; unknown payloads/getters are not folded in. */
function ownData(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
      || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return invalid();
}
const EVENT_OPTIONAL = ['artifactDigest', 'evidenceRef', 'sourceRevision', 'targetRevision',
  'consumerRunId', 'contextBlock', 'reasonCode', 'itemCount', 'tokenCount', 'effectOutcome',
  'skillAttribution'] as const;
const RECORD_REQUIRED = ['operationId', 'runId', 'sessionId', 'capability', 'lane', 'kind',
  'executionClass', 'sourceRevision', 'policyVersion', 'admittedAt', 'stage', 'status',
  'nextRequiredEvent', 'eventCount', 'consumedCount', 'qualifiesAsProductionClosure',
  'revision', 'createdAt', 'updatedAt', 'events'] as const;
const SINGLETON = new Set<AgentClosureEvent['type']>(['admitted', 'execution-completed',
  'proposal-persisted', 'artifact-validated', 'apply-committed', 'readback-verified',
  'no-op-completed', 'rejected', 'stale', 'rolled-back']);

function normalized(record: AgentClosureRecord): Readonly<{
  run: ReturnType<typeof normalizeAgentClosureRun>;
  events: readonly AgentClosureEvent[];
}> {
  ownData(record, RECORD_REQUIRED, ['parentRunId', 'evidenceDigest', 'latestReasonCode']);
  const run = normalizeAgentClosureRun(record);
  if (!Array.isArray(record.events) || nodeTypes.isProxy(record.events)
    || Object.getPrototypeOf(record.events) !== Array.prototype
    || Reflect.ownKeys(record.events).length !== record.events.length + 1
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || record.revision !== record.events.length) return invalid();
  const ids = new Set<string>();
  const keys = new Set<string>();
  const singletons = new Set<AgentClosureEvent['type']>();
  const events = record.events.map((_, index): AgentClosureEvent => {
    const descriptor = Object.getOwnPropertyDescriptor(record.events, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
    const event = descriptor.value as AgentClosureEvent;
    ownData(event, ['eventId', 'sequence', 'type', 'idempotencyKey', 'occurredAt'], EVENT_OPTIONAL);
    const eventId = agentClosureToken(event.eventId, 'event-id');
    if (event.sequence !== index + 1 || ids.has(eventId) || keys.has(event.idempotencyKey)
      || SINGLETON.has(event.type) && singletons.has(event.type)) return invalid();
    ids.add(eventId); keys.add(event.idempotencyKey); singletons.add(event.type);
    if (event.type === 'admitted') {
      ownData(event, ['eventId', 'sequence', 'type', 'idempotencyKey', 'occurredAt', 'sourceRevision'],
        ['artifactDigest']);
      if (index !== 0 || event.idempotencyKey !== 'admitted'
        || event.occurredAt !== run.admittedAt || event.sourceRevision !== run.sourceRevision
        || event.artifactDigest !== run.evidenceDigest) return invalid();
      return Object.freeze({ eventId, sequence: event.sequence, type: 'admitted',
        idempotencyKey: 'admitted', occurredAt: run.admittedAt, sourceRevision: run.sourceRevision,
        ...(run.evidenceDigest === undefined ? {} : { artifactDigest: run.evidenceDigest }) });
    }
    const input = normalizeAgentClosureEvent(event as AgentClosureEventInput);
    return Object.freeze({ eventId, sequence: event.sequence, ...input });
  });
  if (events[0]?.type !== 'admitted') return invalid();
  const fold = foldAgentClosure(run.kind, events, run.executionClass);
  for (const key of ['stage', 'status', 'nextRequiredEvent', 'eventCount', 'consumedCount',
    'qualifiesAsProductionClosure', 'latestReasonCode'] as const) {
    if (record[key] !== fold[key]) return invalid();
  }
  if (agentClosureTimestamp(record.createdAt, 'created-at') !== run.admittedAt) return invalid();
  agentClosureTimestamp(record.updatedAt, 'updated-at');
  return Object.freeze({ run, events: Object.freeze(events) });
}

/** No Store, Provider, clock, feedback writer or execution authority is consulted. */
export function buildAgentTaskOutcome(record: AgentClosureRecord): AgentTaskOutcomeV1 {
  try {
    const { run, events } = normalized(record);
    const first = (type: AgentClosureEvent['type']) => events.find(event => event.type === type);
    const refs = (items: readonly AgentClosureEvent[]): readonly AgentTaskOutcomeEvidenceRef[] => Object.freeze(
      items.map(event => Object.freeze({ kind: 'closure-event' as const, refId: event.eventId,
        sourceDigest: digest(event), occurredAt: event.occurredAt })),
    );
    const axis = <State extends string>(state: State, items: readonly AgentClosureEvent[]): Axis<State> => (
      Object.freeze({ state, evidence: refs(items) })
    );
    const executed = first('execution-completed');
    const noOp = first('no-op-completed');
    const failed = first('failed');
    const cancelled = first('cancelled');
    const execution = executed ? axis('completed', [executed])
      : noOp ? axis('no-op', [noOp])
        : failed ? axis('failed', [failed])
          : cancelled ? axis('cancelled', [cancelled]) : axis('unknown', []);
    const validated = first('artifact-validated');
    const rollback = first('rolled-back');
    const applied = first('apply-committed');
    const readback = first('readback-verified');
    const advisory = AGENT_CLOSURE_CAPABILITY_CONTRACTS[run.capability].kind === 'advisory';
    const commit: AgentTaskOutcomeV1['axes']['commit'] = advisory ? Object.freeze({
      state: 'not-applicable', reasonCode: 'advisory-no-business-write',
      evidence: Object.freeze([Object.freeze({ kind: 'closure-contract' as const,
        refId: `${AGENT_CLOSURE_CONTRACT_VERSION}:${run.capability}`,
        sourceDigest: digest({ contractVersion: AGENT_CLOSURE_CONTRACT_VERSION,
          capability: run.capability, contract: AGENT_CLOSURE_CAPABILITY_CONTRACTS[run.capability] }),
        occurredAt: run.admittedAt })]),
    }) : rollback ? axis('rolled-back', [rollback])
      : applied ? axis('committed', [applied, ...(readback ? [readback] : [])]) : axis('unknown', []);
    const basis = advisory ? validated : readback;
    const consumed = basis?.artifactDigest ? events.filter(event => event.type === 'context-consumed'
      && event.artifactDigest === basis.artifactDigest && !!event.consumerRunId
      && Date.parse(event.occurredAt) >= Date.parse(basis.occurredAt)) : [];
    const effects = events.filter(event => event.type === 'effect-observed'
      && consumed.some(consume => event.artifactDigest === consume.artifactDigest
        && event.consumerRunId === consume.consumerRunId
        && Date.parse(event.occurredAt) >= Date.parse(consume.occurredAt)));
    const reportedOutcomes = Object.freeze([...new Set(effects.map(event => event.effectOutcome!))].sort());
    return Object.freeze({
      version: AGENT_TASK_OUTCOME_VERSION,
      identity: Object.freeze({ source: 'agent-closure', operationId: run.operationId,
        runId: run.runId, parentRunId: run.parentRunId ?? null, attempt: null }),
      capability: run.capability, lane: run.lane, kind: run.kind, executionClass: run.executionClass,
      source: Object.freeze({ revision: record.revision,
        digest: digest({ run, events, revision: record.revision }) }),
      axes: Object.freeze({ execution,
        verification: validated ? axis('validated', [validated]) : axis('unknown', []),
        commit,
        adoption: Object.freeze({ state: consumed.length ? 'consumed' : 'unknown',
          // This is only the producer's explicit historical rollback, not a
          // consumer-current recheck. Its proof is already in the commit axis.
          validity: rollback ? 'invalidated' : 'not-checked',
          evidence: refs(consumed) }),
        effect: Object.freeze({ state: effects.length ? 'observed' : 'unknown',
          evidence: refs(effects), reportedOutcomes, independentOutcome: 'unknown' }),
      }),
      learningWeight: 0, authorizesExecution: false, authorizesPromotion: false,
    });
  } catch { return invalid(); }
}
