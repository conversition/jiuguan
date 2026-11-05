/** @author Codex @date 2026-10-27 @version 1.0
 * CX-4 metadata-only adapter for the current maintenance-owned rolling Summary.
 * It is consumer-local and never installs a global resolver or route.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  MAINTENANCE_ROLLING_SUMMARY_CURRENT_VERSION,
  MemorySummaryMaintenanceCommitter,
  type MaintenanceRollingSummaryCurrentSnapshot,
} from './memory-summary-maintenance-committer.ts';
import type { AgentLoopRefResolution, AgentLoopRefResolverRequest } from './agent-loop-continuation.ts';
import type { AgentLoopArtifactRefDescriptor, AgentLoopArtifactRefPolicy } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_ROLLING_SUMMARY_REF_PREFIX = 'ROLLING-SUMMARY:' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_REF_SNAPSHOT_VERSION =
  'agent-loop-rolling-summary-ref-snapshot-v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_REF_LOADER_VERSION =
  'agent-loop-rolling-summary-ref-loader-v1' as const;

export interface AgentLoopRollingSummaryReadAccess {
  readonly rawSessionId: string;
  readonly readAllowed: true;
  readonly sessionIdentity: object;
  readonly memoryIdentity: object;
}
export interface AgentLoopRollingSummaryDescribeRequest {
  readonly policy: AgentLoopArtifactRefPolicy;
  readonly budgetTokens: number;
}
export interface AgentLoopRollingSummaryExpandRequest {
  readonly loaderRef: string;
  readonly budgetTokens: number;
}
export type AgentLoopRollingSummaryExpansion =
  | Readonly<{
    status: 'found';
    tokens: number;
    snapshot: MaintenanceRollingSummaryCurrentSnapshot;
  }>
  | Readonly<{ status: 'budget-exhausted'; tokens: number }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved' }>;

type Snapshot = Readonly<{
  value: MaintenanceRollingSummaryCurrentSnapshot;
  revision: string;
  digest: string;
  tokens: number;
}>;
type Read = Readonly<{ status: 'found'; snapshot: Snapshot }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'unresolved' }>;
type Loader = Readonly<{
  loaderVersion: typeof AGENT_LOOP_ROLLING_SUMMARY_REF_LOADER_VERSION;
  refId: string;
  digest: string;
  revision: string;
  ownerRef: string;
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REF_ID = /^ROLLING-SUMMARY:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const RUN_ID = /^mjob_[a-f0-9]{32}$/u;
const OWNER = /^maintenance-rolling-summary-owner:sha256:[a-f0-9]{64}$/u;
const LOADER = /^agent-loop-rolling-summary-loader:([A-Za-z0-9_-]+):([a-f0-9]{64})$/u;
const MAX_TOKENS = 65_536;
const MAX_LOADER_REF_CHARS = 2_048;
const ASSERT_BINDING = MemorySummaryMaintenanceCommitter.prototype.assertRollingSummarySessionBinding;
const READ_CURRENT = MemorySummaryMaintenanceCommitter.prototype.readCurrentRollingSummary;

function invalid(): never { throw new TypeError('agent-loop-rolling-summary-ref-invalid'); }
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function valueDigest(value: unknown): string {
  return `sha256:${hash(JSON.stringify(value))}`;
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
function snapshot(value: MaintenanceRollingSummaryCurrentSnapshot): Snapshot {
  if (!exact(value, ['snapshotVersion', 'summary', 'summaryDigest', 'throughRound',
    'historyEpoch', 'revision', 'owner', 'lineage'])
    || value.snapshotVersion !== MAINTENANCE_ROLLING_SUMMARY_CURRENT_VERSION
    || typeof value.summary !== 'string' || value.summary.length < 1
    || !DIGEST.test(value.summaryDigest) || value.summaryDigest !== valueDigest(value.summary)
    || !Number.isSafeInteger(value.throughRound) || value.throughRound < 1
    || !Number.isSafeInteger(value.historyEpoch) || value.historyEpoch < 0
    || !DIGEST.test(value.revision)
    || !exact(value.owner, ['version', 'runId', 'intentDigest', 'operationDigest',
      'targetRevision', 'summaryDigest', 'throughRound', 'historyEpoch'])
    || value.owner.version !== 'maintenance-summary-current-owner-v1'
    || typeof value.owner.runId !== 'string' || !RUN_ID.test(value.owner.runId)
    || !DIGEST.test(value.owner.intentDigest) || !DIGEST.test(value.owner.operationDigest)
    || !DIGEST.test(value.owner.targetRevision)
    || value.owner.summaryDigest !== value.summaryDigest
    || value.owner.throughRound !== value.throughRound
    || value.owner.historyEpoch !== value.historyEpoch
    || !exact(value.lineage, ['runId', 'sourceRevision', 'proposalDigest', 'targetRevision',
      'intentDigest', 'operationDigest', 'truthVersion', 'historyEpoch', 'throughRound',
      'summaryDigest', 'committedAt', 'verifiedAt', 'readbackDigest'])
    || value.lineage.runId !== value.owner.runId
    || typeof value.lineage.sourceRevision !== 'string' || !TOKEN.test(value.lineage.sourceRevision)
    || !DIGEST.test(value.lineage.proposalDigest) || value.lineage.targetRevision !== value.owner.targetRevision
    || value.lineage.intentDigest !== value.owner.intentDigest
    || value.lineage.operationDigest !== value.owner.operationDigest
    || !Number.isSafeInteger(value.lineage.truthVersion) || value.lineage.truthVersion < 1
    || value.lineage.historyEpoch !== value.historyEpoch
    || value.lineage.throughRound !== value.throughRound
    || value.lineage.summaryDigest !== value.summaryDigest
    || typeof value.lineage.committedAt !== 'string' || typeof value.lineage.verifiedAt !== 'string'
    || !DIGEST.test(value.lineage.readbackDigest)
    || value.revision !== valueDigest({
      version: 'maintenance-rolling-summary-current-revision-v1',
      owner: value.owner,
      lineage: value.lineage,
    })) return invalid();
  const content = canonical({
    snapshotVersion: AGENT_LOOP_ROLLING_SUMMARY_REF_SNAPSHOT_VERSION,
    sourceSnapshotVersion: value.snapshotVersion,
    summaryDigest: value.summaryDigest,
    throughRound: value.throughRound,
    historyEpoch: value.historyEpoch,
  });
  const expansion = canonical({ snapshotVersion: AGENT_LOOP_ROLLING_SUMMARY_REF_SNAPSHOT_VERSION, value });
  const tokens = Buffer.byteLength(expansion, 'utf8');
  if (tokens > MAX_TOKENS) return invalid();
  return Object.freeze({ value, revision: value.revision, digest: `sha256:${hash(content)}`, tokens });
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
  return typeof value.refId === 'string' && REF_ID.test(value.refId) && value.kind === 'rolling-summary'
    && typeof value.ownerRef === 'string' && OWNER.test(value.ownerRef)
    && typeof value.expectedDigest === 'string' && DIGEST.test(value.expectedDigest)
    && (!hasExpectedRevision || value.expectedRevision === undefined
      || typeof value.expectedRevision === 'string' && DIGEST.test(value.expectedRevision));
}
function loader(payload: Loader): string {
  const json = canonical(payload);
  return `agent-loop-rolling-summary-loader:${Buffer.from(json).toString('base64url')}:${hash(json)}`;
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
    if (!exact(item, ['loaderVersion', 'refId', 'digest', 'revision', 'ownerRef'])
      || item.loaderVersion !== AGENT_LOOP_ROLLING_SUMMARY_REF_LOADER_VERSION
      || typeof item.refId !== 'string' || !REF_ID.test(item.refId)
      || typeof item.digest !== 'string' || !DIGEST.test(item.digest)
      || typeof item.revision !== 'string' || !DIGEST.test(item.revision)
      || typeof item.ownerRef !== 'string' || !OWNER.test(item.ownerRef)
      || canonical(item) !== json) return null;
    return Object.freeze({
      loaderVersion: AGENT_LOOP_ROLLING_SUMMARY_REF_LOADER_VERSION,
      refId: item.refId,
      digest: item.digest,
      revision: item.revision,
      ownerRef: item.ownerRef,
    });
  } catch { return null; }
}

export function createAgentLoopRollingSummaryRefAdapter(options: Readonly<{
  committer: MemorySummaryMaintenanceCommitter;
  rawSessionId: string;
  sessionIdentity: object;
  memoryIdentity: object;
  readAccess: () => AgentLoopRollingSummaryReadAccess | null;
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
  const refId = `${AGENT_LOOP_ROLLING_SUMMARY_REF_PREFIX}${hash(rawSessionId)}`;
  const ownerRef = `maintenance-rolling-summary-owner:sha256:${hash(rawSessionId)}`;
  const authorized = (): boolean => {
    try {
      const access = readAccess();
      return exact(access, ['rawSessionId', 'readAllowed', 'sessionIdentity', 'memoryIdentity'])
        && access.rawSessionId === rawSessionId && access.readAllowed === true
        && access.sessionIdentity === sessionIdentity && access.memoryIdentity === memoryIdentity;
    } catch { return false; }
  };
  const read = (): Read => {
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    let first: MaintenanceRollingSummaryCurrentSnapshot | null = null;
    let second: MaintenanceRollingSummaryCurrentSnapshot | null = null;
    let failed = false;
    try {
      first = READ_CURRENT.call(committer);
      second = READ_CURRENT.call(committer);
    } catch { failed = true; }
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    if (failed) return Object.freeze({ status: 'unresolved' });
    if (first === null && second === null) return Object.freeze({ status: 'missing' });
    if (!first || !second) return Object.freeze({ status: 'unresolved' });
    try {
      const before = snapshot(first);
      const after = snapshot(second);
      if (before.digest !== after.digest || before.revision !== after.revision) {
        return Object.freeze({ status: 'unresolved' });
      }
      return Object.freeze({ status: 'found', snapshot: after });
    } catch { return Object.freeze({ status: 'unresolved' }); }
  };

  return Object.freeze({
    ownerRef,
    describe(input: AgentLoopRollingSummaryDescribeRequest): AgentLoopArtifactRefDescriptor {
      if (!exact(input, ['policy', 'budgetTokens'])
        || !['required', 'optional'].includes(input.policy) || !budget(input.budgetTokens)) return invalid();
      const current = read();
      if (current.status !== 'found') throw new Error(`agent-loop-rolling-summary-ref-describe-${current.status}`);
      return Object.freeze({
        refId,
        kind: 'rolling-summary',
        ownerRef,
        expectedDigest: current.snapshot.digest,
        expectedRevision: current.snapshot.revision,
        policy: input.policy,
        aclClass: 'session',
        expandBudgetTokens: input.budgetTokens,
      });
    },
    resolve(input: AgentLoopRefResolverRequest): AgentLoopRefResolution {
      if (!resolverRequest(input) || input.refId !== refId || input.ownerRef !== ownerRef) {
        return Object.freeze({ status: 'forbidden' });
      }
      const current = read();
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
        loaderVersion: AGENT_LOOP_ROLLING_SUMMARY_REF_LOADER_VERSION,
        refId,
        digest: item.digest,
        revision: item.revision,
        ownerRef,
      });
      return Object.freeze({
        status: 'found', revision: item.revision, digest: item.digest,
        expandable: Object.freeze({ loaderRef: loader(payload), tokens: item.tokens }),
      });
    },
    expand(input: AgentLoopRollingSummaryExpandRequest): AgentLoopRollingSummaryExpansion {
      if (!exact(input, ['loaderRef', 'budgetTokens'])
        || typeof input.loaderRef !== 'string' || !budget(input.budgetTokens)) {
        return Object.freeze({ status: 'forbidden' });
      }
      if (!authorized()) return Object.freeze({ status: 'forbidden' });
      const payload = parseLoader(input.loaderRef);
      if (!payload || payload.refId !== refId || payload.ownerRef !== ownerRef) {
        return Object.freeze({ status: 'forbidden' });
      }
      const current = read();
      if (current.status !== 'found') return current;
      const item = current.snapshot;
      if (item.digest !== payload.digest) return Object.freeze({ status: 'digest-mismatch' });
      if (item.revision !== payload.revision) return Object.freeze({ status: 'stale' });
      if (item.tokens > input.budgetTokens) {
        return Object.freeze({ status: 'budget-exhausted', tokens: item.tokens });
      }
      return Object.freeze({ status: 'found', tokens: item.tokens, snapshot: item.value });
    },
  });
}

export type AgentLoopRollingSummaryRefAdapter = ReturnType<typeof createAgentLoopRollingSummaryRefAdapter>;
