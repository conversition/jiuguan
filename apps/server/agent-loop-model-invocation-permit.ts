/** Host-only one-use MODEL entry and admission capabilities; JSON is never an authorization. */
import { createHash } from 'node:crypto';
import type { AgentLoopTaskRecord } from './agent-loop-projection-store.ts';

export interface AgentLoopModelInvocationPermit {
  readonly contractVersion: 'agent-loop-model-invocation-permit-v1';
}
export interface AgentLoopModelAdmissionScope {
  readonly contractVersion: 'agent-loop-model-admission-scope-v1';
}
export interface AgentLoopModelInvocationIdentity {
  readonly taskId: string;
  readonly attemptId: string;
  readonly expectedTaskRevision: number;
  readonly ownerId: string;
  readonly envelopeDigest: string;
  readonly invocationId: string;
}
export interface AgentLoopModelAdmissionScopeData extends AgentLoopModelInvocationIdentity {
  readonly deadlineMs: number;
}
const permits = new WeakMap<object, AgentLoopModelInvocationIdentity>();
interface Lifetime { active: boolean }
const lifetimes = new WeakMap<object, Lifetime>();
const scopes = new WeakMap<object, Readonly<{ data: AgentLoopModelAdmissionScopeData; lifetime: Lifetime }>>();
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
function reject(): never { throw new Error('agent-loop-model-invocation-permit-rejected'); }

/** Stable across workers/leases; only the durable requireNew insertion winner may mint a permit. */
export function agentLoopModelInvocationId(input: Readonly<{
  taskId: string; attemptId: string; expectedTaskRevision: number;
}>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ kind: 'agent-loop-model-invocation-v1',
    taskId: input.taskId, attemptId: input.attemptId, expectedTaskRevision: input.expectedTaskRevision })).digest('hex')}`;
}
function identity(record: AgentLoopTaskRecord, ownerId: string): AgentLoopModelInvocationIdentity {
  const { envelope } = record;
  if (record.fenced || record.ownerId !== ownerId || !TOKEN.test(ownerId)
    || envelope.state !== 'RUNNING' || envelope.phase !== 'MODEL'
    || !envelope.currentAttemptId || !TOKEN.test(envelope.taskId) || !TOKEN.test(envelope.currentAttemptId)
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !HASH.test(record.envelopeDigest)) reject();
  return Object.freeze({ taskId: envelope.taskId, attemptId: envelope.currentAttemptId,
    expectedTaskRevision: record.revision, ownerId, envelopeDigest: record.envelopeDigest,
    invocationId: agentLoopModelInvocationId({ taskId: envelope.taskId, attemptId: envelope.currentAttemptId,
      expectedTaskRevision: record.revision }) });
}

/** Called only by the Coordinator after its original Store.annotate(requireNew:true) succeeds.
 * Reading an existing marker (including after restart) is not a minting path.
 */
export function createAgentLoopModelInvocationPermit(input: Readonly<{
  record: AgentLoopTaskRecord; ownerId: string;
}>): AgentLoopModelInvocationPermit {
  const data = identity(input.record, input.ownerId);
  const value = Object.freeze({ contractVersion: 'agent-loop-model-invocation-permit-v1' as const });
  permits.set(value, data); lifetimes.set(value, { active: true }); return value;
}

/** A returned/failed callback cannot retain authority for a later out-of-band admission. */
export function revokeAgentLoopModelInvocationPermit(value: AgentLoopModelInvocationPermit): void {
  const lifetime = lifetimes.get(value);
  if (lifetime) lifetime.active = false;
  permits.delete(value); lifetimes.delete(value);
}

/** One winning callback may exchange its permit for exactly one scoped admission, before any Client/Ticket. */
export function consumeAgentLoopModelInvocationPermit(value: unknown, input: Readonly<{
  record: AgentLoopTaskRecord; ownerId: string; deadlineMs: number;
}>): AgentLoopModelAdmissionScope {
  if (value === null || typeof value !== 'object') reject();
  const data = permits.get(value);
  const lifetime = lifetimes.get(value);
  if (!data || !lifetime?.active) reject();
  permits.delete(value);
  if (JSON.stringify(data) !== JSON.stringify(identity(input.record, input.ownerId))
    || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) reject();
  const scope = Object.freeze({ contractVersion: 'agent-loop-model-admission-scope-v1' as const });
  scopes.set(scope, Object.freeze({ data: Object.freeze({ ...data, deadlineMs: input.deadlineMs }), lifetime })); return scope;
}

/** The existing admitted factory consumes this once, even across different Broker instances. */
export function consumeAgentLoopModelAdmissionScope(value: unknown): AgentLoopModelAdmissionScopeData | null {
  if (value === null || typeof value !== 'object') return null;
  const entry = scopes.get(value);
  if (!entry) return null;
  scopes.delete(value);
  return entry.lifetime.active ? entry.data : null;
}
