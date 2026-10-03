import { createHash } from 'node:crypto';

export const QUERY_PLAN_VERSION = 'p14-query-plan-v1' as const;
export const QUERY_ROUTING_DIGEST_VERSION = 'p14-routing-digest-v1' as const;

const MAX_EPHEMERAL_TEXT_LENGTH = 1_048_576;
const MAX_CONTEXT_ITEMS = 4_096;
const MAX_STABLE_IDS = 256;
const STABLE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export interface QueryRecallContext {
  readonly currentInput: string;
  readonly resolvedEntities?: readonly string[];
  readonly sceneFacts?: readonly string[];
  readonly recentDialogueHints?: readonly string[];
  readonly memoryHints?: readonly string[];
  readonly plotHypotheses?: readonly string[];
  readonly scope?: string;
  readonly stateVersion?: string | number;
}

export interface QueryRoutingFacts {
  readonly hasExplicitVerificationIntent: boolean;
  readonly hasVariableWriteIntent: boolean;
  readonly referencedOldStory: boolean;
}

export interface QueryRoutingCounts {
  readonly resolvedEntityCount: number;
  readonly sceneFactCount: number;
  readonly recentDialogueHintCount: number;
  readonly memoryHintCount: number;
  readonly plotHypothesisCount: number;
}

export interface QueryRoutingIdentityInput {
  readonly namespace: string;
  readonly contentMode: string;
  readonly stateVersion?: string | number | null;
  readonly resolvedEntityIds?: readonly string[];
  readonly skillCandidateIds?: readonly string[];
  readonly counts: QueryRoutingCounts;
  readonly routingFacts: QueryRoutingFacts;
}

export interface QueryRoutingIdentity {
  readonly digestVersion: typeof QUERY_ROUTING_DIGEST_VERSION;
  readonly queryPlanVersion: typeof QUERY_PLAN_VERSION;
  readonly namespace: string;
  readonly contentMode: string;
  readonly stateVersion: string | number | null;
  readonly resolvedEntityIds: readonly string[];
  readonly skillCandidateIds: readonly string[];
  readonly counts: QueryRoutingCounts;
  readonly routingFacts: QueryRoutingFacts;
}

export interface QueryPlanInput {
  readonly currentInput: string;
  readonly recallQuery: string;
  readonly recallContext: QueryRecallContext;
  readonly namespace: string;
  /** Stable opaque namespace identity for routing metadata when namespace itself is a display/local name. */
  readonly routingNamespaceId?: string;
  readonly contentMode: string;
  readonly skillQuery: string;
  /** Opaque stable IDs only. Display names and model/user-authored text are forbidden. */
  readonly resolvedEntityIds?: readonly string[];
  /** Opaque stable IDs only. Skill bodies, summaries, and queries are forbidden. */
  readonly skillCandidateIds?: readonly string[];
  readonly routingFacts: QueryRoutingFacts;
}

export interface QueryPlanV1 {
  readonly version: typeof QUERY_PLAN_VERSION;
  /** Ephemeral turn input. It must never be persisted as routing metadata. */
  readonly currentInput: string;
  readonly recallQuery: string;
  readonly recallContext: QueryRecallContext;
  readonly namespace: string;
  readonly contentMode: string;
  readonly resolvedEntities: readonly string[];
  readonly skillQuery: string;
  readonly routingFacts: QueryRoutingFacts;
  readonly routingIdentity: QueryRoutingIdentity;
  readonly routingDigest: string;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertEphemeralText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.length > MAX_EPHEMERAL_TEXT_LENGTH) {
    throw new RangeError(`${label} exceeds the in-memory size limit`);
  }
}

function normalizeStableToken(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.normalize('NFC');
  if (!STABLE_TOKEN_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be an opaque stable token`);
  }
  return normalized;
}

function normalizeStateVersion(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('stateVersion must be a non-negative safe integer or stable token');
    }
    return value;
  }
  return normalizeStableToken(value, 'stateVersion');
}

function cloneTextList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (value.length > MAX_CONTEXT_ITEMS) {
    throw new RangeError(`${label} exceeds the item limit`);
  }
  const copy = value.map((item, index) => {
    assertEphemeralText(item, `${label}[${index}]`);
    return item;
  });
  return Object.freeze(copy);
}

function normalizeStableIds(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (value.length > MAX_STABLE_IDS) {
    throw new RangeError(`${label} exceeds the stable ID limit`);
  }
  const normalized = value.map((item, index) => normalizeStableToken(item, `${label}[${index}]`));
  return Object.freeze([...new Set(normalized)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

function normalizeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function normalizeRoutingFacts(value: unknown): QueryRoutingFacts {
  assertPlainRecord(value, 'routingFacts');
  const keys: Array<keyof QueryRoutingFacts> = [
    'hasExplicitVerificationIntent',
    'hasVariableWriteIntent',
    'referencedOldStory',
  ];
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') {
      throw new TypeError(`routingFacts.${key} must be a boolean`);
    }
  }
  return Object.freeze({
    hasExplicitVerificationIntent: value.hasExplicitVerificationIntent as boolean,
    hasVariableWriteIntent: value.hasVariableWriteIntent as boolean,
    referencedOldStory: value.referencedOldStory as boolean,
  });
}

function normalizeRoutingCounts(value: unknown): QueryRoutingCounts {
  assertPlainRecord(value, 'counts');
  return Object.freeze({
    resolvedEntityCount: normalizeCount(value.resolvedEntityCount, 'counts.resolvedEntityCount'),
    sceneFactCount: normalizeCount(value.sceneFactCount, 'counts.sceneFactCount'),
    recentDialogueHintCount: normalizeCount(value.recentDialogueHintCount, 'counts.recentDialogueHintCount'),
    memoryHintCount: normalizeCount(value.memoryHintCount, 'counts.memoryHintCount'),
    plotHypothesisCount: normalizeCount(value.plotHypothesisCount, 'counts.plotHypothesisCount'),
  });
}

function cloneRecallContext(value: unknown): QueryRecallContext {
  assertPlainRecord(value, 'recallContext');
  assertEphemeralText(value.currentInput, 'recallContext.currentInput');
  if (value.scope !== undefined) assertEphemeralText(value.scope, 'recallContext.scope');

  if (value.stateVersion === null) {
    throw new TypeError('recallContext.stateVersion must not be null');
  }
  const result: QueryRecallContext = {
    currentInput: value.currentInput,
    resolvedEntities: cloneTextList(value.resolvedEntities, 'recallContext.resolvedEntities'),
    sceneFacts: cloneTextList(value.sceneFacts, 'recallContext.sceneFacts'),
    recentDialogueHints: cloneTextList(value.recentDialogueHints, 'recallContext.recentDialogueHints'),
    memoryHints: cloneTextList(value.memoryHints, 'recallContext.memoryHints'),
    plotHypotheses: cloneTextList(value.plotHypotheses, 'recallContext.plotHypotheses'),
    ...(value.scope === undefined ? {} : { scope: value.scope as string }),
    ...(value.stateVersion === undefined ? {} : { stateVersion: normalizeStateVersion(value.stateVersion) as string | number }),
  };
  return Object.freeze(result);
}

export function normalizeQueryRoutingIdentity(input: QueryRoutingIdentityInput): QueryRoutingIdentity {
  assertPlainRecord(input, 'routingIdentity');
  return Object.freeze({
    digestVersion: QUERY_ROUTING_DIGEST_VERSION,
    queryPlanVersion: QUERY_PLAN_VERSION,
    namespace: normalizeStableToken(input.namespace, 'namespace'),
    contentMode: normalizeStableToken(input.contentMode, 'contentMode'),
    stateVersion: normalizeStateVersion(input.stateVersion),
    resolvedEntityIds: normalizeStableIds(input.resolvedEntityIds, 'resolvedEntityIds'),
    skillCandidateIds: normalizeStableIds(input.skillCandidateIds, 'skillCandidateIds'),
    counts: normalizeRoutingCounts(input.counts),
    routingFacts: normalizeRoutingFacts(input.routingFacts),
  });
}

export function serializeQueryRoutingIdentity(input: QueryRoutingIdentityInput): string {
  const identity = normalizeQueryRoutingIdentity(input);
  return JSON.stringify({
    digestVersion: identity.digestVersion,
    queryPlanVersion: identity.queryPlanVersion,
    namespace: identity.namespace,
    contentMode: identity.contentMode,
    stateVersion: identity.stateVersion,
    resolvedEntityIds: identity.resolvedEntityIds,
    skillCandidateIds: identity.skillCandidateIds,
    counts: {
      resolvedEntityCount: identity.counts.resolvedEntityCount,
      sceneFactCount: identity.counts.sceneFactCount,
      recentDialogueHintCount: identity.counts.recentDialogueHintCount,
      memoryHintCount: identity.counts.memoryHintCount,
      plotHypothesisCount: identity.counts.plotHypothesisCount,
    },
    routingFacts: {
      hasExplicitVerificationIntent: identity.routingFacts.hasExplicitVerificationIntent,
      hasVariableWriteIntent: identity.routingFacts.hasVariableWriteIntent,
      referencedOldStory: identity.routingFacts.referencedOldStory,
    },
  });
}

export function computeQueryRoutingDigest(input: QueryRoutingIdentityInput): string {
  return `sha256:${createHash('sha256').update(serializeQueryRoutingIdentity(input), 'utf8').digest('hex')}`;
}

export function createQueryPlan(input: QueryPlanInput): QueryPlanV1 {
  assertPlainRecord(input, 'queryPlan');
  assertEphemeralText(input.currentInput, 'currentInput');
  assertEphemeralText(input.recallQuery, 'recallQuery');
  assertEphemeralText(input.skillQuery, 'skillQuery');
  assertEphemeralText(input.namespace, 'namespace');
  if (input.namespace.length === 0) throw new TypeError('namespace must not be empty');

  const recallContext = cloneRecallContext(input.recallContext);
  if (recallContext.currentInput !== input.currentInput) {
    throw new TypeError('recallContext.currentInput must exactly match currentInput');
  }
  const routingFacts = normalizeRoutingFacts(input.routingFacts);
  const resolvedEntities = recallContext.resolvedEntities ?? Object.freeze([]);
  const routingIdentity = normalizeQueryRoutingIdentity({
    namespace: input.routingNamespaceId ?? input.namespace,
    contentMode: input.contentMode,
    stateVersion: recallContext.stateVersion,
    resolvedEntityIds: input.resolvedEntityIds,
    skillCandidateIds: input.skillCandidateIds,
    counts: {
      resolvedEntityCount: resolvedEntities.length,
      sceneFactCount: recallContext.sceneFacts?.length ?? 0,
      recentDialogueHintCount: recallContext.recentDialogueHints?.length ?? 0,
      memoryHintCount: recallContext.memoryHints?.length ?? 0,
      plotHypothesisCount: recallContext.plotHypotheses?.length ?? 0,
    },
    routingFacts,
  });

  return Object.freeze({
    version: QUERY_PLAN_VERSION,
    currentInput: input.currentInput,
    recallQuery: input.recallQuery,
    recallContext,
    namespace: input.namespace,
    contentMode: routingIdentity.contentMode,
    resolvedEntities,
    skillQuery: input.skillQuery,
    routingFacts,
    routingIdentity,
    routingDigest: computeQueryRoutingDigest(routingIdentity),
  });
}
