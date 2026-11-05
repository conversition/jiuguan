/** @author Codex @date 2026-10-27 @version 1.0
 * CX-4 metadata-only adapter for current maintenance-owned Memory facts.
 * It is consumer-local and never installs a global resolver or route.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  MAINTENANCE_MEMORY_CURRENT_FACT_VERSION,
  MemorySummaryMaintenanceCommitter,
  type MaintenanceMemoryCurrentFact,
} from './memory-summary-maintenance-committer.ts';
import type { AgentLoopRefResolution, AgentLoopRefResolverRequest } from './agent-loop-continuation.ts';
import type { AgentLoopArtifactRefDescriptor, AgentLoopArtifactRefPolicy } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_MEMORY_FACT_REF_SNAPSHOT_VERSION =
  'agent-loop-memory-fact-ref-snapshot-v1' as const;
export const AGENT_LOOP_MEMORY_FACT_REF_LOADER_VERSION =
  'agent-loop-memory-fact-ref-loader-v1' as const;

export interface AgentLoopMemoryFactReadAccess {
  readonly rawSessionId: string;
  readonly readAllowed: true;
  readonly sessionIdentity: object;
  readonly memoryIdentity: object;
}
export interface AgentLoopMemoryFactDescribeRequest {
  readonly code: string;
  readonly policy: AgentLoopArtifactRefPolicy;
  readonly budgetTokens: number;
}
export interface AgentLoopMemoryFactExpandRequest {
  readonly loaderRef: string;
  readonly budgetTokens: number;
}
export type AgentLoopMemoryFactExpansion =
  | Readonly<{ status: 'found'; tokens: number; fact: MaintenanceMemoryCurrentFact }>
  | Readonly<{ status: 'budget-exhausted'; tokens: number }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved' }>;

type Snapshot = Readonly<{
  fact: MaintenanceMemoryCurrentFact;
  revision: string;
  digest: string;
  tokens: number;
}>;
type Read = Readonly<{ status: 'found'; snapshot: Snapshot }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'unresolved' }>;
type Loader = Readonly<{
  loaderVersion: typeof AGENT_LOOP_MEMORY_FACT_REF_LOADER_VERSION;
  code: string;
  digest: string;
  revision: string;
  ownerRef: string;
}>;

const CODE = /^MEM:[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const OWNER = /^maintenance-memory-fact-owner:sha256:[a-f0-9]{64}$/u;
const LOADER = /^agent-loop-memory-fact-loader:([A-Za-z0-9_-]+):([a-f0-9]{64})$/u;
const MAX_TOKENS = 65_536;
const MAX_LOADER_REF_CHARS = 2_048;
const ASSERT_BINDING = MemorySummaryMaintenanceCommitter.prototype.assertMemoryFactSessionBinding;
const READ_CURRENT = MemorySummaryMaintenanceCommitter.prototype.readCurrentMemoryFact;

function invalid(): never { throw new TypeError('agent-loop-memory-fact-ref-invalid'); }
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function exact(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
    const own = Reflect.ownKeys(input);
    return own.length === keys.length
      && own.every((key) => typeof key === 'string' && keys.includes(key)
        && Object.getOwnPropertyDescriptor(input, key)?.enumerable === true
        && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'));
  } catch { return false; }
}
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
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid();
        return canonical(field.value, seen);
      }).join(',')}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return invalid();
    return `{${(keys as string[]).sort().map((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid();
      return `${JSON.stringify(key)}:${canonical(field.value, seen)}`;
    }).join(',')}}`;
  } finally { seen.delete(value); }
}
function snapshot(fact: MaintenanceMemoryCurrentFact, code: string): Snapshot {
  if (!exact(fact, ['snapshotVersion', 'factDigest', 'revision', 'rowDigest', 'ledgerDigest',
    'row', 'marker', 'lineage'])
    || fact.snapshotVersion !== MAINTENANCE_MEMORY_CURRENT_FACT_VERSION
    || fact.row.code !== code || !CODE.test(fact.row.code)
    || fact.factDigest !== `sha256:${code.slice('MEM:'.length)}`
    || !DIGEST.test(fact.revision) || !DIGEST.test(fact.rowDigest) || !DIGEST.test(fact.ledgerDigest)) {
    return invalid();
  }
  const content = canonical({
    snapshotVersion: AGENT_LOOP_MEMORY_FACT_REF_SNAPSHOT_VERSION,
    sourceSnapshotVersion: fact.snapshotVersion,
    factDigest: fact.factDigest,
    rowDigest: fact.rowDigest,
    row: fact.row,
  });
  const expansion = canonical({ snapshotVersion: AGENT_LOOP_MEMORY_FACT_REF_SNAPSHOT_VERSION, fact });
  const tokens = Buffer.byteLength(expansion, 'utf8');
  if (tokens > MAX_TOKENS) return invalid();
  return Object.freeze({ fact, revision: fact.revision, digest: `sha256:${hash(content)}`, tokens });
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
  return typeof value.refId === 'string' && CODE.test(value.refId) && value.kind === 'memory-fact'
    && typeof value.ownerRef === 'string' && OWNER.test(value.ownerRef)
    && typeof value.expectedDigest === 'string' && DIGEST.test(value.expectedDigest)
    && (!hasExpectedRevision || value.expectedRevision === undefined
      || typeof value.expectedRevision === 'string' && DIGEST.test(value.expectedRevision));
}
function loader(payload: Loader): string {
  const json = canonical(payload);
  return `agent-loop-memory-fact-loader:${Buffer.from(json).toString('base64url')}:${hash(json)}`;
}
function parseLoader(value: string): Loader | null {
  try {
    if (value.length > MAX_LOADER_REF_CHARS) return null;
    const match = LOADER.exec(value);
    if (!match) return null;
    const bytes = Buffer.from(match[1]!, 'base64url');
    if (bytes.toString('base64url') !== match[1]) return null;
    const json = bytes.toString('utf8');
    if (hash(json) !== match[2]) return null;
    const item: unknown = JSON.parse(json);
    if (!exact(item, ['loaderVersion', 'code', 'digest', 'revision', 'ownerRef'])
      || item.loaderVersion !== AGENT_LOOP_MEMORY_FACT_REF_LOADER_VERSION
      || typeof item.code !== 'string' || !CODE.test(item.code)
      || typeof item.digest !== 'string' || !DIGEST.test(item.digest)
      || typeof item.revision !== 'string' || !DIGEST.test(item.revision)
      || typeof item.ownerRef !== 'string' || !OWNER.test(item.ownerRef)
      || canonical(item) !== json) return null;
    return Object.freeze({
      loaderVersion: AGENT_LOOP_MEMORY_FACT_REF_LOADER_VERSION,
      code: item.code,
      digest: item.digest,
      revision: item.revision,
      ownerRef: item.ownerRef,
    });
  } catch { return null; }
}

export function createAgentLoopMemoryFactRefAdapter(options: Readonly<{
  committer: MemorySummaryMaintenanceCommitter;
  rawSessionId: string;
  sessionIdentity: object;
  memoryIdentity: object;
  readAccess: () => AgentLoopMemoryFactReadAccess | null;
}>) {
  if (!exact(options, ['committer', 'rawSessionId', 'sessionIdentity', 'memoryIdentity', 'readAccess'])) {
    return invalid();
  }
  const { committer, rawSessionId, sessionIdentity, memoryIdentity, readAccess } = options;
  if (typeof rawSessionId !== 'string' || !TOKEN.test(rawSessionId)
    || nodeTypes.isProxy(committer) || !(committer instanceof MemorySummaryMaintenanceCommitter)
    || !sessionIdentity || typeof sessionIdentity !== 'object' || nodeTypes.isProxy(sessionIdentity)
    || !memoryIdentity || typeof memoryIdentity !== 'object' || nodeTypes.isProxy(memoryIdentity)
    || typeof readAccess !== 'function' || nodeTypes.isProxy(readAccess)) return invalid();
  try { ASSERT_BINDING.call(committer, rawSessionId, memoryIdentity); } catch { return invalid(); }
  const ownerRef = `maintenance-memory-fact-owner:sha256:${hash(rawSessionId)}`;
  const authorized = (): boolean => {
    try {
      const access = readAccess();
      return exact(access, ['rawSessionId', 'readAllowed', 'sessionIdentity', 'memoryIdentity'])
        && access.rawSessionId === rawSessionId && access.readAllowed === true
        && access.sessionIdentity === sessionIdentity && access.memoryIdentity === memoryIdentity;
    } catch { return false; }
  };
  const read = (code: string): Read => {
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    let first: MaintenanceMemoryCurrentFact | null = null;
    let second: MaintenanceMemoryCurrentFact | null = null;
    let failed = false;
    try {
      first = READ_CURRENT.call(committer, code);
      second = READ_CURRENT.call(committer, code);
    } catch { failed = true; }
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    if (failed) return Object.freeze({ status: 'unresolved' });
    if (first === null && second === null) return Object.freeze({ status: 'missing' });
    if (!first || !second) return Object.freeze({ status: 'unresolved' });
    try {
      const before = snapshot(first, code);
      const after = snapshot(second, code);
      if (before.digest !== after.digest || before.revision !== after.revision) {
        return Object.freeze({ status: 'unresolved' });
      }
      return Object.freeze({ status: 'found', snapshot: after });
    } catch { return Object.freeze({ status: 'unresolved' }); }
  };

  return Object.freeze({
    ownerRef,
    describe(input: AgentLoopMemoryFactDescribeRequest): AgentLoopArtifactRefDescriptor {
      if (!exact(input, ['code', 'policy', 'budgetTokens'])
        || typeof input.code !== 'string' || !CODE.test(input.code)
        || !['required', 'optional'].includes(input.policy) || !budget(input.budgetTokens)) return invalid();
      const current = read(input.code);
      if (current.status !== 'found') throw new Error(`agent-loop-memory-fact-ref-describe-${current.status}`);
      return Object.freeze({
        refId: input.code,
        kind: 'memory-fact',
        ownerRef,
        expectedDigest: current.snapshot.digest,
        expectedRevision: current.snapshot.revision,
        policy: input.policy,
        aclClass: 'session',
        expandBudgetTokens: input.budgetTokens,
      });
    },
    resolve(input: AgentLoopRefResolverRequest): AgentLoopRefResolution {
      if (!resolverRequest(input) || input.ownerRef !== ownerRef) {
        return Object.freeze({ status: 'forbidden' });
      }
      const current = read(input.refId);
      if (current.status === 'missing') return Object.freeze({ status: 'missing' });
      if (current.status === 'forbidden') return Object.freeze({ status: 'forbidden' });
      if (current.status !== 'found') return Object.freeze({ status: 'found' });
      const item = current.snapshot;
      if (item.digest !== input.expectedDigest) return Object.freeze({
        status: 'digest-mismatch', revision: item.revision, digest: item.digest,
      });
      if (input.expectedRevision !== undefined && item.revision !== input.expectedRevision) {
        return Object.freeze({ status: 'stale', revision: item.revision, digest: item.digest });
      }
      const payload: Loader = Object.freeze({
        loaderVersion: AGENT_LOOP_MEMORY_FACT_REF_LOADER_VERSION,
        code: item.fact.row.code,
        digest: item.digest,
        revision: item.revision,
        ownerRef,
      });
      return Object.freeze({
        status: 'found', revision: item.revision, digest: item.digest,
        expandable: Object.freeze({ loaderRef: loader(payload), tokens: item.tokens }),
      });
    },
    expand(input: AgentLoopMemoryFactExpandRequest): AgentLoopMemoryFactExpansion {
      if (!exact(input, ['loaderRef', 'budgetTokens'])
        || typeof input.loaderRef !== 'string' || !budget(input.budgetTokens)) {
        return Object.freeze({ status: 'forbidden' });
      }
      if (!authorized()) return Object.freeze({ status: 'forbidden' });
      const payload = parseLoader(input.loaderRef);
      if (!payload || payload.ownerRef !== ownerRef) return Object.freeze({ status: 'forbidden' });
      const current = read(payload.code);
      if (current.status !== 'found') return current;
      const item = current.snapshot;
      if (item.digest !== payload.digest) return Object.freeze({ status: 'digest-mismatch' });
      if (item.revision !== payload.revision) return Object.freeze({ status: 'stale' });
      if (item.tokens > input.budgetTokens) {
        return Object.freeze({ status: 'budget-exhausted', tokens: item.tokens });
      }
      return Object.freeze({ status: 'found', tokens: item.tokens, fact: item.fact });
    },
  });
}

export type AgentLoopMemoryFactRefAdapter = ReturnType<typeof createAgentLoopMemoryFactRefAdapter>;
