/** @author Codex @date 2026-10-27 @version 1.0
 * Session/task-bound bridge from current maintenance Memory/Summary refs to RP P3 retrieval.
 * The token is private-branded; it neither registers refs nor installs a global resolver.
 */
import { types as nodeTypes } from 'node:util';
import {
  normalizeRpChildAnalysisBinding,
  rpChildAnalysisDigest,
  type RpChildAnalysisBindingV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import type { RpQueryContextSource } from '../../packages/prompt/public/rp-query-context.ts';
import {
  createAgentLoopMemoryFactRefAdapter,
  type AgentLoopMemoryFactReadAccess,
} from './agent-loop-memory-fact-ref.ts';
import {
  createAgentLoopRollingSummaryRefAdapter,
  type AgentLoopRollingSummaryReadAccess,
} from './agent-loop-rolling-summary-ref.ts';
import type {
  AgentLoopRefResolution,
  AgentLoopRefResolverRequest,
} from './agent-loop-continuation.ts';
import type { MemorySummaryMaintenanceCommitter } from './memory-summary-maintenance-committer.ts';
import type {
  AgentLoopArtifactRefDescriptor,
  AgentLoopArtifactRefPolicy,
  AgentLoopProjectionStore,
} from './agent-loop-projection-store.ts';

export const AGENT_LOOP_RP_MAINTENANCE_MEMORY_CONTEXT_VERSION =
  'agent-loop-rp-maintenance-memory-context-v1' as const;
export const AGENT_LOOP_RP_MAINTENANCE_MEMORY_RETRIEVAL_VERSION =
  'agent-loop-rp-maintenance-memory-retrieval-v1' as const;

export interface AgentLoopRpMaintenanceMemoryReadAccess {
  readonly rawSessionId: string;
  readonly readAllowed: true;
  readonly sessionIdentity: object;
  readonly memoryIdentity: object;
}

export type AgentLoopRpMaintenanceMemorySelection =
  | Readonly<{
      kind: 'memory-fact';
      code: string;
      policy: AgentLoopArtifactRefPolicy;
      budgetTokens: number;
    }>
  | Readonly<{
      kind: 'rolling-summary';
      policy: AgentLoopArtifactRefPolicy;
      budgetTokens: number;
    }>;

export interface AgentLoopRpMaintenanceMemoryContext {
  readonly contextVersion: typeof AGENT_LOOP_RP_MAINTENANCE_MEMORY_CONTEXT_VERSION;
}

export type AgentLoopRpMaintenanceMemoryExpansion =
  | Readonly<{ status: 'found'; tokens: number; source: RpQueryContextSource }>
  | Readonly<{ status: 'budget-exhausted'; tokens: number }>
  | Readonly<{
      status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved';
    }>;

type Entry = Readonly<{
  descriptor: AgentLoopArtifactRefDescriptor;
  resolve: (request: AgentLoopRefResolverRequest) => AgentLoopRefResolution;
  expand: (loaderRef: string, budgetTokens: number) => AgentLoopRpMaintenanceMemoryExpansion;
}>;

type Binding = Readonly<{
  store: AgentLoopProjectionStore;
  bindingDigest: string;
  descriptors: readonly AgentLoopArtifactRefDescriptor[];
  entries: ReadonlyMap<string, Entry>;
}>;

const CONTEXTS = new WeakMap<object, Binding>();
const MAX_REFS = 16;
const MAX_EXPANSION_TOKENS = 32_768;
const FACT_CODE = /^MEM:[a-f0-9]{64}$/u;

function invalid(): never {
  throw new TypeError('agent-loop-rp-maintenance-memory-context-invalid');
}

function exact(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string'
      || !required.includes(key) && !optional.includes(key)
      || !Object.getOwnPropertyDescriptor(input, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))
    || required.some((key) => !keys.includes(key))) invalid();
  return input as Record<string, unknown>;
}

function selection(input: unknown): AgentLoopRpMaintenanceMemorySelection {
  const value = exact(input, ['kind', 'policy', 'budgetTokens'], ['code']);
  if (!['required', 'optional'].includes(String(value.policy))
    || !Number.isSafeInteger(value.budgetTokens)
    || Number(value.budgetTokens) < 0
    || Number(value.budgetTokens) > MAX_EXPANSION_TOKENS) invalid();
  if (value.kind === 'memory-fact') {
    if (typeof value.code !== 'string' || !FACT_CODE.test(value.code)) invalid();
    return Object.freeze({
      kind: 'memory-fact',
      code: value.code,
      policy: value.policy as AgentLoopArtifactRefPolicy,
      budgetTokens: Number(value.budgetTokens),
    });
  }
  if (value.kind !== 'rolling-summary' || Object.hasOwn(value, 'code')) invalid();
  return Object.freeze({
    kind: 'rolling-summary',
    policy: value.policy as AgentLoopArtifactRefPolicy,
    budgetTokens: Number(value.budgetTokens),
  });
}

function request(input: unknown): AgentLoopRefResolverRequest | null {
  try {
    const value = exact(input, ['refId', 'kind', 'ownerRef', 'expectedDigest'],
      ['expectedRevision']);
    if (typeof value.refId !== 'string' || typeof value.kind !== 'string'
      || typeof value.ownerRef !== 'string' || typeof value.expectedDigest !== 'string'
      || value.expectedRevision !== undefined && typeof value.expectedRevision !== 'string') return null;
    return value as unknown as AgentLoopRefResolverRequest;
  } catch {
    return null;
  }
}

function sameDescriptor(
  value: AgentLoopRefResolverRequest,
  descriptor: AgentLoopArtifactRefDescriptor,
): boolean {
  return value.refId === descriptor.refId
    && value.kind === descriptor.kind
    && value.ownerRef === descriptor.ownerRef
    && value.expectedDigest === descriptor.expectedDigest
    && value.expectedRevision === descriptor.expectedRevision;
}

/**
 * Trusted host construction. The two real adapters are created inside this
 * module so a structural resolver cannot be smuggled into the RP scope.
 */
export function createAgentLoopRpMaintenanceMemoryContext(options: Readonly<{
  store: AgentLoopProjectionStore;
  binding: RpChildAnalysisBindingV1;
  committer: MemorySummaryMaintenanceCommitter;
  sessionIdentity: object;
  memoryIdentity: object;
  readAccess: () => AgentLoopRpMaintenanceMemoryReadAccess | null;
  refs: readonly AgentLoopRpMaintenanceMemorySelection[];
}>): AgentLoopRpMaintenanceMemoryContext {
  const value = exact(options, [
    'store', 'binding', 'committer', 'sessionIdentity', 'memoryIdentity', 'readAccess', 'refs',
  ]);
  if (!value.store || typeof value.store !== 'object' || nodeTypes.isProxy(value.store)
    || typeof value.readAccess !== 'function' || nodeTypes.isProxy(value.readAccess)
    || !value.sessionIdentity || typeof value.sessionIdentity !== 'object' || nodeTypes.isProxy(value.sessionIdentity)
    || !value.memoryIdentity || typeof value.memoryIdentity !== 'object' || nodeTypes.isProxy(value.memoryIdentity)
    || !Array.isArray(value.refs) || nodeTypes.isProxy(value.refs)
    || Object.getPrototypeOf(value.refs) !== Array.prototype
    || value.refs.length < 1 || value.refs.length > MAX_REFS
    || Reflect.ownKeys(value.refs).length !== value.refs.length + 1) invalid();
  const binding = normalizeRpChildAnalysisBinding(value.binding);
  const refs = Array.from({ length: value.refs.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value.refs as readonly unknown[], String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid();
    return selection(field.value);
  });
  const keys = refs.map((item) => item.kind === 'memory-fact' ? `${item.kind}:${item.code}` : item.kind);
  if (new Set(keys).size !== keys.length) invalid();

  const readAccess = (): AgentLoopMemoryFactReadAccess & AgentLoopRollingSummaryReadAccess | null => {
    const access = (value.readAccess as () => AgentLoopRpMaintenanceMemoryReadAccess | null)();
    return access as AgentLoopMemoryFactReadAccess & AgentLoopRollingSummaryReadAccess | null;
  };
  const common = {
    committer: value.committer as MemorySummaryMaintenanceCommitter,
    rawSessionId: binding.sessionId,
    sessionIdentity: value.sessionIdentity as object,
    memoryIdentity: value.memoryIdentity as object,
    readAccess,
  };
  const factAdapter = refs.some((item) => item.kind === 'memory-fact')
    ? createAgentLoopMemoryFactRefAdapter(common)
    : null;
  const summaryAdapter = refs.some((item) => item.kind === 'rolling-summary')
    ? createAgentLoopRollingSummaryRefAdapter(common)
    : null;
  const entries = new Map<string, Entry>();

  for (const item of refs) {
    if (item.kind === 'memory-fact') {
      const adapter = factAdapter ?? invalid();
      const descriptor = adapter.describe({
        code: item.code,
        policy: item.policy,
        budgetTokens: item.budgetTokens,
      });
      entries.set(descriptor.refId, Object.freeze({
        descriptor,
        resolve: (input) => adapter.resolve(input),
        expand: (loaderRef, budgetTokens) => {
          const expanded = adapter.expand({ loaderRef, budgetTokens });
          if (expanded.status !== 'found') return expanded;
          const fact = expanded.fact;
          return Object.freeze({
            status: 'found' as const,
            tokens: expanded.tokens,
            source: Object.freeze({
              sourceRef: descriptor.refId,
              content: JSON.stringify({
                version: AGENT_LOOP_RP_MAINTENANCE_MEMORY_RETRIEVAL_VERSION,
                kind: 'memory-fact',
                factDigest: fact.factDigest,
                description: fact.row.description,
                characters: fact.row.characters,
                sourceRefs: fact.row.refs,
              }),
              required: descriptor.policy === 'required',
            }),
          });
        },
      }));
      continue;
    }
    const adapter = summaryAdapter ?? invalid();
    const descriptor = adapter.describe({
      policy: item.policy,
      budgetTokens: item.budgetTokens,
    });
    entries.set(descriptor.refId, Object.freeze({
      descriptor,
      resolve: (input) => adapter.resolve(input),
      expand: (loaderRef, budgetTokens) => {
        const expanded = adapter.expand({ loaderRef, budgetTokens });
        if (expanded.status !== 'found') return expanded;
        const summary = expanded.snapshot;
        return Object.freeze({
          status: 'found' as const,
          tokens: expanded.tokens,
          source: Object.freeze({
            sourceRef: descriptor.refId,
            content: JSON.stringify({
              version: AGENT_LOOP_RP_MAINTENANCE_MEMORY_RETRIEVAL_VERSION,
              kind: 'rolling-summary',
              summaryDigest: summary.summaryDigest,
              summary: summary.summary,
              throughRound: summary.throughRound,
              historyEpoch: summary.historyEpoch,
            }),
            required: descriptor.policy === 'required',
          }),
        });
      },
    }));
  }

  const descriptors = Object.freeze([...entries.values()]
    .map((entry) => entry.descriptor)
    .sort((left, right) => left.refId < right.refId ? -1 : left.refId > right.refId ? 1 : 0));
  const context = Object.freeze({
    contextVersion: AGENT_LOOP_RP_MAINTENANCE_MEMORY_CONTEXT_VERSION,
  });
  CONTEXTS.set(context, Object.freeze({
    store: value.store as AgentLoopProjectionStore,
    bindingDigest: rpChildAnalysisDigest(binding),
    descriptors,
    entries,
  }));
  return context;
}

export function isAgentLoopRpMaintenanceMemoryContext(
  input: unknown,
): input is AgentLoopRpMaintenanceMemoryContext {
  return !!input && typeof input === 'object' && CONTEXTS.has(input);
}

export function matchesAgentLoopRpMaintenanceMemoryContext(
  input: unknown,
  store: AgentLoopProjectionStore,
  binding: RpChildAnalysisBindingV1,
): boolean {
  if (!input || typeof input !== 'object') return false;
  const state = CONTEXTS.get(input);
  if (!state || state.store !== store) return false;
  try {
    return state.bindingDigest === rpChildAnalysisDigest(normalizeRpChildAnalysisBinding(binding));
  } catch {
    return false;
  }
}

export function readAgentLoopRpMaintenanceMemoryDescriptors(
  input: unknown,
): readonly AgentLoopArtifactRefDescriptor[] | null {
  return input && typeof input === 'object' ? CONTEXTS.get(input)?.descriptors ?? null : null;
}

export function resolveAgentLoopRpMaintenanceMemoryContext(
  input: unknown,
  requestInput: unknown,
): AgentLoopRefResolution {
  if (!input || typeof input !== 'object') return Object.freeze({ status: 'forbidden' });
  const state = CONTEXTS.get(input);
  const safe = request(requestInput);
  if (!state || !safe) return Object.freeze({ status: 'forbidden' });
  const entry = state.entries.get(safe.refId);
  if (!entry || !sameDescriptor(safe, entry.descriptor)) {
    return Object.freeze({ status: 'forbidden' });
  }
  return entry.resolve(safe);
}

export function expandAgentLoopRpMaintenanceMemoryContext(
  input: unknown,
  requestInput: unknown,
): AgentLoopRpMaintenanceMemoryExpansion {
  try {
    if (!input || typeof input !== 'object') return Object.freeze({ status: 'forbidden' });
    const state = CONTEXTS.get(input);
    const value = exact(requestInput, ['refId', 'kind', 'loaderRef', 'budgetTokens']);
    if (!state || typeof value.refId !== 'string' || typeof value.kind !== 'string'
      || typeof value.loaderRef !== 'string' || !Number.isSafeInteger(value.budgetTokens)
      || Number(value.budgetTokens) < 0) return Object.freeze({ status: 'forbidden' });
    const entry = state.entries.get(value.refId);
    if (!entry || entry.descriptor.kind !== value.kind
      || Number(value.budgetTokens) > entry.descriptor.expandBudgetTokens) {
      return Object.freeze({ status: 'forbidden' });
    }
    return entry.expand(value.loaderRef, Number(value.budgetTokens));
  } catch {
    return Object.freeze({ status: 'forbidden' });
  }
}
