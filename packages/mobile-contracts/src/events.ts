/** P7 / P17-03.4a: content-free event envelopes; task events only invalidate authoritative reads. */
export const EVENT_SCHEMA_VERSION = 1 as const;
export const TASK_EVENT_SCHEMA_VERSION = 2 as const;
export const TASK_EVENT_KINDS = Object.freeze(['task-created', 'task-completed', 'task-fenced',
  'task-resumed', 'task-paused', 'wait-entered', 'phase-advanced', 'observation-applied',
  'dag-child-joined-woke'] as const);
export const TASK_EVENT_REASONS = Object.freeze(['explicit-resume', 'wait-satisfied', 'child-failed',
  'child-cancelled', 'child-artifact-conflict', 'repair-attempts-exhausted', 'repair-budget-insufficient'] as const);
/** Original records linked to this event, never a current business-state assertion. */
export interface TaskEventRecordRefV2 {
  readonly kind: 'completion-candidate' | 'completion-verification' | 'summary-write-intent' | 'summary-write-readback';
  readonly refId: string;
  readonly sourceDigest: string;
  readonly occurredAt: string;
}
export interface TaskEventEvidenceV2 {
  readonly version: 'agent-loop-task-event-v2';
  readonly eventDigest: string;
  readonly acceptedAt?: string;
  /** Current snapshot identity, not necessarily the attempt that caused this event. */
  readonly currentAttemptIdAtRevision?: string;
  /** Present only when the original completion chain proves event attribution. */
  readonly attemptId?: string;
  readonly recordRefs?: readonly TaskEventRecordRefV2[];
  readonly kind?: typeof TASK_EVENT_KINDS[number];
  readonly reasonCode?: typeof TASK_EVENT_REASONS[number];
}

export type EventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'turn.queued'
  | 'turn.started'
  | 'turn.finished'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'asset.changed'
  | 'plugin.changed'
  | 'provider.changed'
  | 'task.updated'
  | 'sync.required';

export type EventResourceKind =
  | 'session'
  | 'message'
  | 'asset'
  | 'plugin'
  | 'provider'
  | 'task'
  | 'server';

export interface EventResource {
  kind: EventResourceKind;
  id?: string;
  revision?: string;
}

/**
 * SSE 只传失效通知；客户端收到事件后重新读取 REST 真值。
 * data 不得包含 Provider 凭据或完整私密资源。
 */
/**
 * P7-05：eventId 只是同一 serverInstanceId 进程生命周期内的投递序号，严格单调；
 * 客户端不得把它当业务 revision，也不得用它推导业务状态。
 */
export interface EventEnvelope<T = unknown> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION | typeof TASK_EVENT_SCHEMA_VERSION;
  eventId: string;
  serverInstanceId: string;
  type: EventType;
  resource: EventResource;
  occurredAt: string;
  requestId?: string;
  runId?: string;
  originClientId?: string;
  data: T;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'session.created',
  'session.updated',
  'session.deleted',
  'turn.queued',
  'turn.started',
  'turn.finished',
  'turn.failed',
  'turn.cancelled',
  'asset.changed',
  'plugin.changed',
  'provider.changed',
  'task.updated',
  'sync.required',
]);

const RESOURCE_KINDS: ReadonlySet<string> = new Set<EventResourceKind>([
  'session',
  'message',
  'asset',
  'plugin',
  'provider',
  'task',
  'server',
]);

// This is the original TaskEnvelope / projection Store token, not an HTTP client identifier.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const TASK_REVISION_RE = /^[1-9][0-9]{0,15}$/u;
function canonicalTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isTaskEventRecordRefs(value: unknown, acceptedAt: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || !canonicalTime(acceptedAt)
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const kinds = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return false;
    const ref = entry.value;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(ref))) return false;
    const fields = Object.getOwnPropertyDescriptors(ref);
    if (Reflect.ownKeys(fields).length !== 4 || !['kind', 'refId', 'sourceDigest', 'occurredAt']
      .every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'))) return false;
    const patterns: Record<string, RegExp> = {
      'completion-candidate': /^completion-candidate:[a-f0-9]{64}$/u,
      'completion-verification': /^verification:[a-f0-9]{64}$/u,
      'summary-write-intent': /^maintenance_summary_write_receipt:mjob_[a-f0-9]{32}$/u,
      'summary-write-readback': /^maintenance_summary_write_receipt:mjob_[a-f0-9]{32}$/u,
    };
    if (typeof ref.kind !== 'string' || !Object.hasOwn(patterns, ref.kind) || kinds.has(ref.kind)
      || typeof ref.refId !== 'string' || !patterns[ref.kind]!.test(ref.refId)
      || typeof ref.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.sourceDigest)
      || !canonicalTime(ref.occurredAt) || ref.occurredAt > acceptedAt) return false;
    kinds.add(ref.kind);
  }
  return true;
}
const TASK_EVENT_KEYS: ReadonlySet<string> = new Set([
    'schemaVersion',
    'eventId',
    'serverInstanceId',
    'type',
    'resource',
    'occurredAt',
    'requestId',
    'runId',
    'originClientId',
    'data',
]);

function isTaskInvalidation(event: Record<string, unknown>, resource: Record<string, unknown>): boolean {
    if (event.type !== 'task.updated' || resource.kind !== 'task') return false;
    if (Reflect.ownKeys(event).some((key) => typeof key !== 'string' || !TASK_EVENT_KEYS.has(key))) return false;
    const eventDescriptors = Object.getOwnPropertyDescriptors(event);
    if (Object.values(eventDescriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return false;
    const prototype = Object.getPrototypeOf(resource);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const resourceDescriptors = Object.getOwnPropertyDescriptors(resource);
    if (
        Reflect.ownKeys(resource).length !== 3 ||
        !['kind', 'id', 'revision'].every((key) => Object.hasOwn(resourceDescriptors[key] ?? {}, 'value'))
    )
        return false;
    if (
        typeof resource.id !== 'string' ||
        !TASK_ID_RE.test(resource.id) ||
        typeof resource.revision !== 'string' ||
        !TASK_REVISION_RE.test(resource.revision) ||
        !Number.isSafeInteger(Number(resource.revision))
    )
        return false;
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return false;
    const dataPrototype = Object.getPrototypeOf(event.data);
    if (dataPrototype !== Object.prototype && dataPrototype !== null) return false;
    if (event.schemaVersion === EVENT_SCHEMA_VERSION) return Reflect.ownKeys(event.data).length === 0;
    if (event.schemaVersion !== TASK_EVENT_SCHEMA_VERSION) return false;
    const descriptors = Object.getOwnPropertyDescriptors(event.data);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !['version', 'eventDigest', 'acceptedAt', 'currentAttemptIdAtRevision', 'attemptId', 'recordRefs', 'kind', 'reasonCode'].includes(key))
      || ['version', 'eventDigest'].some(key => !Object.hasOwn(descriptors, key))
      || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) return false;
    const data = event.data as Record<string, unknown>;
    return data.version === 'agent-loop-task-event-v2'
      && typeof data.eventDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(data.eventDigest)
      && (data.acceptedAt === undefined || typeof data.acceptedAt === 'string' && Number.isFinite(Date.parse(data.acceptedAt))
        && new Date(data.acceptedAt).toISOString() === data.acceptedAt)
      && (data.currentAttemptIdAtRevision === undefined || typeof data.currentAttemptIdAtRevision === 'string'
        && TASK_ID_RE.test(data.currentAttemptIdAtRevision))
      && (data.attemptId === undefined || typeof data.attemptId === 'string' && TASK_ID_RE.test(data.attemptId)
        && data.kind === 'task-completed' && canonicalTime(data.acceptedAt))
      && (data.recordRefs === undefined || data.attemptId !== undefined && isTaskEventRecordRefs(data.recordRefs, data.acceptedAt))
      && (data.kind === undefined || typeof data.kind === 'string' && (TASK_EVENT_KINDS as readonly string[]).includes(data.kind))
      && (data.reasonCode === undefined || typeof data.reasonCode === 'string' && (TASK_EVENT_REASONS as readonly string[]).includes(data.reasonCode));
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.resource !== 'object' || event.resource === null || Array.isArray(event.resource)) {
    return false;
  }
  const resource = event.resource as Record<string, unknown>;
    if ((event.type === 'task.updated' || resource.kind === 'task') && !isTaskInvalidation(event, resource)) {
        return false;
    }

  return (event.schemaVersion === EVENT_SCHEMA_VERSION || (event.schemaVersion === TASK_EVENT_SCHEMA_VERSION && event.type === 'task.updated'))
    && 'data' in event
    && typeof event.eventId === 'string'
    && event.eventId.length > 0
    && typeof event.serverInstanceId === 'string'
    && event.serverInstanceId.length > 0
    && typeof event.type === 'string'
    && EVENT_TYPES.has(event.type)
    && typeof resource.kind === 'string'
    && RESOURCE_KINDS.has(resource.kind)
    && (resource.id === undefined || typeof resource.id === 'string')
    && (resource.revision === undefined || typeof resource.revision === 'string')
    && typeof event.occurredAt === 'string'
    && (event.requestId === undefined || typeof event.requestId === 'string')
    && (event.runId === undefined || typeof event.runId === 'string')
    && (event.originClientId === undefined || typeof event.originClientId === 'string');
}
