/** @author Codex @date 2026-10-27 @version 1.0
 * CX-4 typed-ref adapter for the authoritative AgentClosureStore.
 * Descriptors/loaders carry metadata only; every Store read is re-authorized.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { AgentClosureStore, type AgentClosureRecord } from './agent-closure-store.ts';
import type { AgentLoopRefResolution, AgentLoopRefResolverRequest } from './agent-loop-continuation.ts';
import type { AgentLoopArtifactRefDescriptor, AgentLoopArtifactRefPolicy } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_CLOSURE_REF_SNAPSHOT_VERSION = 'agent-loop-closure-ref-snapshot-v1' as const;
export const AGENT_LOOP_CLOSURE_REF_LOADER_VERSION = 'agent-loop-closure-ref-loader-v1' as const;
export interface AgentLoopClosureReadAccess { readonly rawSessionId: string; readonly readAllowed: true }
export interface AgentLoopClosureDescribeRequest {
  readonly operationId: string; readonly policy: AgentLoopArtifactRefPolicy; readonly budgetTokens: number;
}
export interface AgentLoopClosureExpandRequest { readonly loaderRef: string; readonly budgetTokens: number }
export type AgentLoopClosureExpansion =
  | Readonly<{ status: 'found'; tokens: number; closure: AgentClosureRecord }>
  | Readonly<{ status: 'budget-exhausted'; tokens: number }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved' }>;

type Snapshot = Readonly<{ record: AgentClosureRecord; revision: string; digest: string; tokens: number }>;
type Read = Readonly<{ status: 'found'; snapshot: Snapshot }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'unresolved' }>;
type Loader = Readonly<{ loaderVersion: typeof AGENT_LOOP_CLOSURE_REF_LOADER_VERSION;
  operationId: string; digest: string; revision: string; ownerRef: string }>;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const OWNER = /^agent-closure-owner:sha256:[a-f0-9]{64}$/u;
const LOADER = /^agent-closure-loader:([A-Za-z0-9_-]+):([a-f0-9]{64})$/u;
const REVISION = /^[1-9][0-9]*$/u;
const MAX_TOKENS = 65_536;
const MAX_LOADER_REF_CHARS = 2_048;
const AUTHORITY_PROBE = 'agent-loop-closure-ref-authority-probe';
// Capture the class method during module evaluation. A later writable-prototype
// replacement must not become the adapter's authority or defeat its private-brand probe.
const AGENT_CLOSURE_GET = AgentClosureStore.prototype.get;

function invalid(): never { throw new TypeError('agent-loop-closure-ref-invalid'); }
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function exact(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
    const own = Reflect.ownKeys(input);
    return own.length === keys.length
      && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.getOwnPropertyDescriptor(input, key)?.enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'));
  } catch { return false; }
}
/** RFC-8259 own data only, with lexicographically sorted object keys. */
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : invalid();
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || seen.has(value)) return invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
      return `[${value.map((_, index) => {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return invalid();
        return canonical(field.value, seen);
      }).join(',')}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) return invalid();
    return `{${(keys as string[]).sort().map(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return invalid();
      return `${JSON.stringify(key)}:${canonical(field.value, seen)}`;
    }).join(',')}}`;
  } finally { seen.delete(value); }
}

function snapshot(record: AgentClosureRecord, operationId: string): Snapshot {
  if (record.operationId !== operationId || !Array.isArray(record.events)
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || record.revision !== record.events.length || record.eventCount !== record.events.length) return invalid();
  const revision = String(record.revision);
  const json = canonical({ snapshotVersion: AGENT_LOOP_CLOSURE_REF_SNAPSHOT_VERSION, closure: record });
  return Object.freeze({ record, revision, digest: `sha256:${hash(json)}`,
    // UTF-8 bytes are a deliberately conservative tokenizer upper bound.
    tokens: Buffer.byteLength(json, 'utf8') });
}
function budget(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TOKENS;
}
function resolverRequest(input: unknown): input is AgentLoopRefResolverRequest {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) return false;
  const hasExpectedRevision = Object.hasOwn(input, 'expectedRevision');
  if (!exact(input, ['refId', 'kind', 'ownerRef', 'expectedDigest',
    ...(hasExpectedRevision ? ['expectedRevision'] : [])])) return false;
  const value = input as Partial<AgentLoopRefResolverRequest>;
  return typeof value.refId === 'string' && TOKEN.test(value.refId) && value.kind === 'closure-receipt'
    && typeof value.ownerRef === 'string' && TOKEN.test(value.ownerRef)
    && typeof value.expectedDigest === 'string' && DIGEST.test(value.expectedDigest)
    && (!hasExpectedRevision || value.expectedRevision === undefined
      || typeof value.expectedRevision === 'string' && TOKEN.test(value.expectedRevision));
}
function loader(payload: Loader): string {
  const json = canonical(payload);
  return `agent-closure-loader:${Buffer.from(json).toString('base64url')}:${hash(json)}`;
}
function parseLoader(value: string): Loader | null {
  try {
    // A valid canonical payload is well below this bound. Reject before regex,
    // base64 decoding, hashing or JSON parsing to keep hostile inputs bounded.
    if (value.length > MAX_LOADER_REF_CHARS) return null;
    const match = LOADER.exec(value);
    if (!match) return null;
    const bytes = Buffer.from(match[1]!, 'base64url');
    if (bytes.toString('base64url') !== match[1]) return null;
    const json = bytes.toString('utf8');
    if (hash(json) !== match[2]) return null;
    const item: unknown = JSON.parse(json);
    if (!exact(item, ['loaderVersion', 'operationId', 'digest', 'revision', 'ownerRef'])
      || item.loaderVersion !== AGENT_LOOP_CLOSURE_REF_LOADER_VERSION
      || typeof item.operationId !== 'string' || !TOKEN.test(item.operationId)
      || typeof item.digest !== 'string' || !DIGEST.test(item.digest)
      || typeof item.revision !== 'string' || !REVISION.test(item.revision)
      || !Number.isSafeInteger(Number(item.revision))
      || typeof item.ownerRef !== 'string' || !OWNER.test(item.ownerRef)
      || canonical(item) !== json) return null;
    return Object.freeze({ loaderVersion: AGENT_LOOP_CLOSURE_REF_LOADER_VERSION,
      operationId: item.operationId, digest: item.digest, revision: item.revision, ownerRef: item.ownerRef });
  } catch { return null; }
}

/** Trusted composition only. This factory installs no production resolver or route. */
export function createAgentLoopClosureRefAdapter(options: Readonly<{
  store: AgentClosureStore; rawSessionId: string; readAccess: () => AgentLoopClosureReadAccess | null;
}>) {
  if (!exact(options, ['store', 'rawSessionId', 'readAccess'])) return invalid();
  const { store, rawSessionId, readAccess } = options;
  try { agentClosureToken(rawSessionId, 'session-id'); } catch { return invalid(); }
  if (nodeTypes.isProxy(store) || !(store instanceof AgentClosureStore)
    || typeof readAccess !== 'function' || nodeTypes.isProxy(readAccess)) return invalid();
  const ownerRef = `agent-closure-owner:sha256:${hash(rawSessionId)}`;
  const authorized = (): boolean => {
    try {
      const access = readAccess();
      return exact(access, ['rawSessionId', 'readAllowed'])
        && access.rawSessionId === rawSessionId && access.readAllowed === true;
    } catch { return false; }
  };
  // Verify the private Store brand only while this adapter is currently allowed
  // to read. A denied adapter remains constructible but cannot touch the Store.
  if (authorized()) {
    try { AGENT_CLOSURE_GET.call(store, AUTHORITY_PROBE); } catch { return invalid(); }
  }
  const read = (operationId: string): Read => {
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    let first: AgentClosureRecord | undefined;
    let second: AgentClosureRecord | undefined;
    let failed = false;
    try {
      first = AGENT_CLOSURE_GET.call(store, operationId);
      second = AGENT_CLOSURE_GET.call(store, operationId);
    } catch { failed = true; }
    // Revocation wins even when the underlying read failed; loaders never authorize.
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    if (failed) return Object.freeze({ status: 'unresolved' });
    if (first === undefined && second === undefined) return Object.freeze({ status: 'missing' });
    if (!first || !second) return Object.freeze({ status: 'unresolved' });
    if (first.sessionId !== rawSessionId || second.sessionId !== rawSessionId) {
      return Object.freeze({ status: 'forbidden' });
    }
    try {
      const before = snapshot(first, operationId);
      const after = snapshot(second, operationId);
      if (before.digest !== after.digest || before.revision !== after.revision) {
        return Object.freeze({ status: 'unresolved' });
      }
      return Object.freeze({ status: 'found', snapshot: after });
    } catch { return Object.freeze({ status: 'unresolved' }); }
  };

  return Object.freeze({
    ownerRef,
    describe(input: AgentLoopClosureDescribeRequest): AgentLoopArtifactRefDescriptor {
      if (!exact(input, ['operationId', 'policy', 'budgetTokens'])
        || typeof input.operationId !== 'string' || !TOKEN.test(input.operationId)
        || !['required', 'optional'].includes(input.policy) || !budget(input.budgetTokens)) return invalid();
      const current = read(input.operationId);
      if (current.status !== 'found') throw new Error(`agent-loop-closure-ref-describe-${current.status}`);
      return Object.freeze({ refId: input.operationId, kind: 'closure-receipt', ownerRef,
        expectedDigest: current.snapshot.digest, expectedRevision: current.snapshot.revision,
        policy: input.policy, aclClass: 'session', expandBudgetTokens: input.budgetTokens });
    },
    resolve(input: AgentLoopRefResolverRequest): AgentLoopRefResolution {
      if (!resolverRequest(input) || input.ownerRef !== ownerRef) return Object.freeze({ status: 'forbidden' });
      const current = read(input.refId);
      if (current.status === 'missing') return Object.freeze({ status: 'missing' });
      if (current.status === 'forbidden') return Object.freeze({ status: 'forbidden' });
      if (current.status !== 'found') return Object.freeze({ status: 'found' });
      const item = current.snapshot;
      // The core also checks this order: content drift is stronger than revision drift.
      if (item.digest !== input.expectedDigest) return Object.freeze({ status: 'digest-mismatch',
        revision: item.revision, digest: item.digest });
      if (input.expectedRevision !== undefined && item.revision !== input.expectedRevision) {
        return Object.freeze({ status: 'stale', revision: item.revision, digest: item.digest });
      }
      const payload: Loader = Object.freeze({ loaderVersion: AGENT_LOOP_CLOSURE_REF_LOADER_VERSION,
        operationId: item.record.operationId, digest: item.digest, revision: item.revision, ownerRef });
      return Object.freeze({ status: 'found', revision: item.revision, digest: item.digest,
        expandable: Object.freeze({ loaderRef: loader(payload), tokens: item.tokens }) });
    },
    expand(input: AgentLoopClosureExpandRequest): AgentLoopClosureExpansion {
      if (!exact(input, ['loaderRef', 'budgetTokens'])
        || typeof input.loaderRef !== 'string' || !budget(input.budgetTokens)) {
        return Object.freeze({ status: 'forbidden' });
      }
      if (!authorized()) return Object.freeze({ status: 'forbidden' });
      const payload = parseLoader(input.loaderRef);
      if (!payload || payload.ownerRef !== ownerRef) return Object.freeze({ status: 'forbidden' });
      const current = read(payload.operationId);
      if (current.status !== 'found') return current;
      const item = current.snapshot;
      if (item.digest !== payload.digest) return Object.freeze({ status: 'digest-mismatch' });
      if (item.revision !== payload.revision) return Object.freeze({ status: 'stale' });
      if (item.tokens > input.budgetTokens) return Object.freeze({ status: 'budget-exhausted', tokens: item.tokens });
      return Object.freeze({ status: 'found', tokens: item.tokens, closure: item.record });
    },
  });
}
export type AgentLoopClosureRefAdapter = ReturnType<typeof createAgentLoopClosureRefAdapter>;
