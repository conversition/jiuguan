/** @author Codex @date 2026-10-27 @version 1.0
 * CX-4 typed-ref adapter for the authoritative AgentSkillCandidateStore.
 * Descriptors/loaders carry metadata only; every Store read is re-authorized.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  AgentSkillCandidateStore,
  type StoredAgentSkillCandidate,
} from './agent-skill-candidate-store.ts';
import type { AgentLoopRefResolution, AgentLoopRefResolverRequest } from './agent-loop-continuation.ts';
import type { AgentLoopArtifactRefDescriptor, AgentLoopArtifactRefPolicy } from './agent-loop-projection-store.ts';

export const AGENT_LOOP_CANDIDATE_REF_SNAPSHOT_VERSION = 'agent-loop-candidate-ref-snapshot-v1' as const;
export const AGENT_LOOP_CANDIDATE_REF_LOADER_VERSION = 'agent-loop-candidate-ref-loader-v1' as const;
export interface AgentLoopCandidateReadAccess { readonly rawSessionId: string; readonly readAllowed: true }
export interface AgentLoopCandidateDescribeRequest {
  readonly candidateId: string; readonly policy: AgentLoopArtifactRefPolicy; readonly budgetTokens: number;
}
export interface AgentLoopCandidateExpandRequest { readonly loaderRef: string; readonly budgetTokens: number }
export type AgentLoopCandidateExpansion =
  | Readonly<{ status: 'found'; tokens: number; candidate: StoredAgentSkillCandidate }>
  | Readonly<{ status: 'budget-exhausted'; tokens: number }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved' }>;

type Snapshot = Readonly<{ stored: StoredAgentSkillCandidate; revision: string; digest: string; tokens: number }>;
type Read = Readonly<{ status: 'found'; snapshot: Snapshot }>
  | Readonly<{ status: 'missing' | 'forbidden' | 'unresolved' }>;
type Loader = Readonly<{ loaderVersion: typeof AGENT_LOOP_CANDIDATE_REF_LOADER_VERSION;
  candidateId: string; digest: string; revision: string; ownerRef: string }>;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const OWNER = /^agent-candidate-owner:sha256:[a-f0-9]{64}$/u;
const LOADER = /^agent-candidate-loader:([A-Za-z0-9_-]+):([a-f0-9]{64})$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const MAX_TOKENS = 65_536;
const MAX_LOADER_REF_CHARS = 2_048;
const AUTHORITY_PROBE = `sha256:${'0'.repeat(64)}`;
// Capture during module evaluation so prototype replacement cannot become authority.
const AGENT_SKILL_CANDIDATE_READ = AgentSkillCandidateStore.prototype.readCandidate;

function invalid(): never { throw new TypeError('agent-loop-candidate-ref-invalid'); }
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

function snapshot(stored: StoredAgentSkillCandidate, candidateId: string): Snapshot {
  if (!exact(stored, ['candidate', 'bundle', 'validation'])
    || stored.candidate.candidateId !== candidateId
    || stored.candidate.bundleDigest !== stored.bundle.bundleDigest
    || !Number.isSafeInteger(stored.candidate.revision) || stored.candidate.revision < 0
    || stored.candidate.history.length !== stored.candidate.revision) return invalid();
  const revision = String(stored.candidate.revision);
  const json = canonical({ snapshotVersion: AGENT_LOOP_CANDIDATE_REF_SNAPSHOT_VERSION, candidate: stored });
  return Object.freeze({ stored, revision, digest: `sha256:${hash(json)}`,
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
  return typeof value.refId === 'string' && TOKEN.test(value.refId) && value.kind === 'candidate'
    && typeof value.ownerRef === 'string' && TOKEN.test(value.ownerRef)
    && typeof value.expectedDigest === 'string' && DIGEST.test(value.expectedDigest)
    && (!hasExpectedRevision || value.expectedRevision === undefined
      || typeof value.expectedRevision === 'string' && TOKEN.test(value.expectedRevision));
}
function loader(payload: Loader): string {
  const json = canonical(payload);
  return `agent-candidate-loader:${Buffer.from(json).toString('base64url')}:${hash(json)}`;
}
function parseLoader(value: string): Loader | null {
  try {
    // Reject before regex, base64 decoding, hashing or JSON parsing so hostile inputs stay bounded.
    if (value.length > MAX_LOADER_REF_CHARS) return null;
    const match = LOADER.exec(value);
    if (!match) return null;
    const bytes = Buffer.from(match[1]!, 'base64url');
    if (bytes.toString('base64url') !== match[1]) return null;
    const json = bytes.toString('utf8');
    if (hash(json) !== match[2]) return null;
    const item: unknown = JSON.parse(json);
    if (!exact(item, ['loaderVersion', 'candidateId', 'digest', 'revision', 'ownerRef'])
      || item.loaderVersion !== AGENT_LOOP_CANDIDATE_REF_LOADER_VERSION
      || typeof item.candidateId !== 'string' || !DIGEST.test(item.candidateId)
      || typeof item.digest !== 'string' || !DIGEST.test(item.digest)
      || typeof item.revision !== 'string' || !REVISION.test(item.revision)
      || !Number.isSafeInteger(Number(item.revision))
      || typeof item.ownerRef !== 'string' || !OWNER.test(item.ownerRef)
      || canonical(item) !== json) return null;
    return Object.freeze({ loaderVersion: AGENT_LOOP_CANDIDATE_REF_LOADER_VERSION,
      candidateId: item.candidateId, digest: item.digest, revision: item.revision, ownerRef: item.ownerRef });
  } catch { return null; }
}

/** Trusted composition only. This factory installs no production resolver or route. */
export function createAgentLoopCandidateRefAdapter(options: Readonly<{
  store: AgentSkillCandidateStore; rawSessionId: string; readAccess: () => AgentLoopCandidateReadAccess | null;
}>) {
  if (!exact(options, ['store', 'rawSessionId', 'readAccess'])) return invalid();
  const { store, rawSessionId, readAccess } = options;
  if (typeof rawSessionId !== 'string' || !TOKEN.test(rawSessionId)
    || nodeTypes.isProxy(store) || !(store instanceof AgentSkillCandidateStore)
    || typeof readAccess !== 'function' || nodeTypes.isProxy(readAccess)) return invalid();
  const ownerRef = `agent-candidate-owner:sha256:${hash(rawSessionId)}`;
  const authorized = (): boolean => {
    try {
      const access = readAccess();
      return exact(access, ['rawSessionId', 'readAllowed'])
        && access.rawSessionId === rawSessionId && access.readAllowed === true;
    } catch { return false; }
  };
  // Verify the private Store brand only while currently authorized. A denied
  // adapter remains constructible without touching Store state.
  if (authorized()) {
    try { AGENT_SKILL_CANDIDATE_READ.call(store, AUTHORITY_PROBE); } catch { return invalid(); }
  }
  const read = (candidateId: string): Read => {
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    let first: StoredAgentSkillCandidate | null = null;
    let second: StoredAgentSkillCandidate | null = null;
    let failed = false;
    try {
      first = AGENT_SKILL_CANDIDATE_READ.call(store, candidateId);
      second = AGENT_SKILL_CANDIDATE_READ.call(store, candidateId);
    } catch { failed = true; }
    // Revocation wins even when the underlying read failed; loaders never authorize.
    if (!authorized()) return Object.freeze({ status: 'forbidden' });
    if (failed) return Object.freeze({ status: 'unresolved' });
    if (first === null && second === null) return Object.freeze({ status: 'missing' });
    if (!first || !second) return Object.freeze({ status: 'unresolved' });
    try {
      const before = snapshot(first, candidateId);
      const after = snapshot(second, candidateId);
      if (before.digest !== after.digest || before.revision !== after.revision) {
        return Object.freeze({ status: 'unresolved' });
      }
      return Object.freeze({ status: 'found', snapshot: after });
    } catch { return Object.freeze({ status: 'unresolved' }); }
  };

  return Object.freeze({
    ownerRef,
    describe(input: AgentLoopCandidateDescribeRequest): AgentLoopArtifactRefDescriptor {
      if (!exact(input, ['candidateId', 'policy', 'budgetTokens'])
        || typeof input.candidateId !== 'string' || !DIGEST.test(input.candidateId)
        || !['required', 'optional'].includes(input.policy) || !budget(input.budgetTokens)) return invalid();
      const current = read(input.candidateId);
      if (current.status !== 'found') throw new Error(`agent-loop-candidate-ref-describe-${current.status}`);
      return Object.freeze({ refId: input.candidateId, kind: 'candidate', ownerRef,
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
      const payload: Loader = Object.freeze({ loaderVersion: AGENT_LOOP_CANDIDATE_REF_LOADER_VERSION,
        candidateId: item.stored.candidate.candidateId, digest: item.digest, revision: item.revision, ownerRef });
      return Object.freeze({ status: 'found', revision: item.revision, digest: item.digest,
        expandable: Object.freeze({ loaderRef: loader(payload), tokens: item.tokens }) });
    },
    expand(input: AgentLoopCandidateExpandRequest): AgentLoopCandidateExpansion {
      if (!exact(input, ['loaderRef', 'budgetTokens'])
        || typeof input.loaderRef !== 'string' || !budget(input.budgetTokens)) {
        return Object.freeze({ status: 'forbidden' });
      }
      if (!authorized()) return Object.freeze({ status: 'forbidden' });
      const payload = parseLoader(input.loaderRef);
      if (!payload || payload.ownerRef !== ownerRef) return Object.freeze({ status: 'forbidden' });
      const current = read(payload.candidateId);
      if (current.status !== 'found') return current;
      const item = current.snapshot;
      if (item.digest !== payload.digest) return Object.freeze({ status: 'digest-mismatch' });
      if (item.revision !== payload.revision) return Object.freeze({ status: 'stale' });
      if (item.tokens > input.budgetTokens) return Object.freeze({ status: 'budget-exhausted', tokens: item.tokens });
      return Object.freeze({ status: 'found', tokens: item.tokens, candidate: item.stored });
    },
  });
}
export type AgentLoopCandidateRefAdapter = ReturnType<typeof createAgentLoopCandidateRefAdapter>;
