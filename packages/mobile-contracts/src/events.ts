export const EVENT_SCHEMA_VERSION = 1 as const;

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
  | 'sync.required';

export type EventResourceKind =
  | 'session'
  | 'message'
  | 'asset'
  | 'plugin'
  | 'provider'
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
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
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
  'sync.required',
]);

const RESOURCE_KINDS: ReadonlySet<string> = new Set<EventResourceKind>([
  'session',
  'message',
  'asset',
  'plugin',
  'provider',
  'server',
]);

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.resource !== 'object' || event.resource === null || Array.isArray(event.resource)) {
    return false;
  }
  const resource = event.resource as Record<string, unknown>;
  return event.schemaVersion === EVENT_SCHEMA_VERSION
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
