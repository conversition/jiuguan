import {
  AGENT_SKILL_CONTENT_MODES,
  AGENT_SKILL_PHASES,
  AGENT_SKILL_RISK_TIERS,
  type AgentSkillContentMode,
  type AgentSkillHeaderV1,
  type AgentSkillPhase,
  type AgentSkillRiskTier,
  normalizeAgentSkillHeader,
} from './manifest.ts';
import {
  assertExactKeys,
  assertPlainRecord,
  compareText,
  compareVersion,
  deepFreeze,
  digestCanonical,
  member,
  safeInteger,
  sha256Digest,
  stableToken,
  uniqueSortedTokens,
  versionToken,
} from './internal.ts';

export const AGENT_SKILL_GRANT_VERSION = 'agent-skill-grant-v1' as const;
export const AGENT_SKILL_SELECTION_REQUEST_VERSION = 'agent-skill-selection-request-v1' as const;
export const AGENT_SKILL_SELECTOR_VERSION = 'agent-skill-selector-v1' as const;
export const AGENT_SKILL_SELECTION_RECEIPT_VERSION = 'agent-skill-selection-receipt-v1' as const;
export const AGENT_SKILL_DISCOVERY_VERSION = 'agent-skill-discovery-v1' as const;

export interface AgentSkillExecutionGrantV1 {
  readonly grantVersion: typeof AGENT_SKILL_GRANT_VERSION;
  readonly tools: readonly string[];
  readonly writableArtifactKinds: readonly string[];
  readonly maxRiskTier: AgentSkillRiskTier;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface AgentSkillTargetScopeV1 {
  readonly sessionId?: string;
  readonly cardId?: string;
  readonly worldId?: string;
}

export interface AgentSkillVersionRefV1 {
  readonly skillId: string;
  readonly version: string;
}

/** Body-free evidence that an upstream discovery stage found one exact Skill version relevant. */
export interface AgentSkillCandidateRefV1 extends AgentSkillVersionRefV1 {
  /** Stable, non-prose reason such as `legacy.keyword` or `agent.header-choice`. */
  readonly reasonCode: string;
  /** Deterministic fixed-point relevance in [0, 10000]; floating point scores are forbidden. */
  readonly scoreBps: number;
  /** Digest of minimized discovery evidence; never the raw query, prompt or model reasoning. */
  readonly evidenceDigest: string;
}

export interface AgentSkillDiscoveryReceiptV1 {
  readonly discoveryVersion: typeof AGENT_SKILL_DISCOVERY_VERSION;
  readonly candidates: readonly AgentSkillCandidateRefV1[];
  readonly discoveryDigest: string;
}

export interface AgentSkillSelectionRequestV1 {
  readonly requestVersion: typeof AGENT_SKILL_SELECTION_REQUEST_VERSION;
  /** Immutable catalog snapshot revision from which every candidate header was read. */
  readonly catalogRevision: string;
  readonly capabilityId: string;
  readonly taskKind: string;
  readonly phase: AgentSkillPhase;
  readonly contentMode: AgentSkillContentMode;
  readonly scope: AgentSkillTargetScopeV1;
  /** Authoritative host grant. A Skill can be selected only when all requirements fit inside it. */
  readonly grant: AgentSkillExecutionGrantV1;
  readonly budgetTokens: number;
  readonly maxSkills: number;
  readonly explicit: readonly AgentSkillVersionRefV1[];
  /** Omitted preserves compatibility selection. Present (including []) creates a bounded root set. */
  readonly candidates?: readonly AgentSkillCandidateRefV1[];
}

export const AGENT_SKILL_SELECTION_REASONS = Object.freeze([
  'foundation', 'explicit', 'dependency', 'candidate', 'ranked',
] as const);
export type AgentSkillSelectionReason = typeof AGENT_SKILL_SELECTION_REASONS[number];

export const AGENT_SKILL_REJECTION_REASONS = Object.freeze([
  'capability-mismatch', 'task-mismatch', 'phase-mismatch', 'content-mode-mismatch',
  'scope-mismatch', 'permission-expansion', 'dependency-missing', 'dependency-cycle',
  'dependency-version-conflict', 'conflict', 'over-budget', 'max-skills', 'not-candidate', 'superseded',
] as const);
export type AgentSkillRejectionReason = typeof AGENT_SKILL_REJECTION_REASONS[number];

export interface SelectedAgentSkillV1 {
  readonly header: AgentSkillHeaderV1;
  readonly reason: AgentSkillSelectionReason;
}

export interface RejectedAgentSkillV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly bodyTokens: number;
  readonly reason: AgentSkillRejectionReason;
}

export interface AgentSkillSelectionReceiptV1 {
  readonly receiptVersion: typeof AGENT_SKILL_SELECTION_RECEIPT_VERSION;
  readonly selectorVersion: typeof AGENT_SKILL_SELECTOR_VERSION;
  readonly catalogRevision: string;
  readonly requestDigest: string;
  readonly candidateHeadersDigest: string;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly budgetConflict: boolean;
  readonly selected: readonly SelectedAgentSkillV1[];
  readonly rejected: readonly RejectedAgentSkillV1[];
  /** Present only when the request used a bounded candidate set. */
  readonly discovery?: AgentSkillDiscoveryReceiptV1;
  readonly instructionSetDigest: string;
  readonly receiptDigest: string;
}

const GRANT_KEYS = new Set([
  'grantVersion', 'tools', 'writableArtifactKinds', 'maxRiskTier', 'maxModelCalls',
  'maxToolCalls', 'maxInputTokens', 'maxOutputTokens',
]);
const REQUEST_KEYS = new Set([
  'requestVersion', 'catalogRevision', 'capabilityId', 'taskKind', 'phase', 'contentMode', 'scope',
  'grant', 'budgetTokens', 'maxSkills', 'explicit', 'candidates',
]);
const REQUIRED_REQUEST_KEYS = new Set([...REQUEST_KEYS].filter((key) => key !== 'candidates'));
const TARGET_SCOPE_KEYS = new Set(['sessionId', 'cardId', 'worldId']);
const VERSION_REF_KEYS = new Set(['skillId', 'version']);
const CANDIDATE_REF_KEYS = new Set(['skillId', 'version', 'reasonCode', 'scoreBps', 'evidenceDigest']);
const RECEIPT_KEYS = new Set([
  'receiptVersion', 'selectorVersion', 'catalogRevision', 'requestDigest', 'candidateHeadersDigest',
  'budgetTokens', 'usedTokens', 'budgetConflict', 'selected', 'rejected',
  'discovery', 'instructionSetDigest', 'receiptDigest',
]);
const REQUIRED_RECEIPT_KEYS = new Set([...RECEIPT_KEYS].filter((key) => key !== 'discovery'));
const DISCOVERY_KEYS = new Set(['discoveryVersion', 'candidates', 'discoveryDigest']);
const SELECTED_KEYS = new Set(['header', 'reason']);
const REJECTED_KEYS = new Set([
  'skillId', 'version', 'manifestDigest', 'bodyHash', 'bodyTokens', 'reason',
]);
const RISK_STRENGTH: Readonly<Record<AgentSkillRiskTier, number>> = Object.freeze({
  advisory: 0,
  proposal: 1,
  write: 2,
});
const KIND_RANK: Readonly<Record<AgentSkillHeaderV1['manifest']['kind'], number>> = Object.freeze({
  foundation: 0,
  policy: 1,
  style: 2,
  procedure: 3,
  validator: 4,
});

export function normalizeAgentSkillExecutionGrant(input: unknown): AgentSkillExecutionGrantV1 {
  assertPlainRecord(input, 'skillGrant');
  assertExactKeys(input, GRANT_KEYS, GRANT_KEYS, 'skillGrant');
  if (input.grantVersion !== AGENT_SKILL_GRANT_VERSION) {
    throw new TypeError(`skillGrant.grantVersion must be ${AGENT_SKILL_GRANT_VERSION}`);
  }
  return deepFreeze({
    grantVersion: AGENT_SKILL_GRANT_VERSION,
    tools: uniqueSortedTokens(input.tools, 'skillGrant.tools'),
    writableArtifactKinds: uniqueSortedTokens(input.writableArtifactKinds, 'skillGrant.writableArtifactKinds'),
    maxRiskTier: member(input.maxRiskTier, AGENT_SKILL_RISK_TIERS, 'skillGrant.maxRiskTier'),
    maxModelCalls: safeInteger(input.maxModelCalls, 'skillGrant.maxModelCalls', 0, 1_000),
    maxToolCalls: safeInteger(input.maxToolCalls, 'skillGrant.maxToolCalls', 0, 10_000),
    maxInputTokens: safeInteger(input.maxInputTokens, 'skillGrant.maxInputTokens', 0, 10_000_000),
    maxOutputTokens: safeInteger(input.maxOutputTokens, 'skillGrant.maxOutputTokens', 0, 10_000_000),
  });
}

function normalizeTargetScope(input: unknown): AgentSkillTargetScopeV1 {
  assertPlainRecord(input, 'selectionRequest.scope');
  assertExactKeys(input, TARGET_SCOPE_KEYS, new Set(), 'selectionRequest.scope');
  return deepFreeze({
    ...(input.sessionId === undefined ? {} : { sessionId: stableToken(input.sessionId, 'selectionRequest.scope.sessionId') }),
    ...(input.cardId === undefined ? {} : { cardId: stableToken(input.cardId, 'selectionRequest.scope.cardId') }),
    ...(input.worldId === undefined ? {} : { worldId: stableToken(input.worldId, 'selectionRequest.scope.worldId') }),
  });
}

function normalizeVersionRefs(input: unknown, label: string): readonly AgentSkillVersionRefV1[] {
  if (!Array.isArray(input) || input.length > 64) throw new TypeError(`${label} must be an array with at most 64 items`);
  const output = input.map((item, index) => {
    assertPlainRecord(item, `${label}[${index}]`);
    assertExactKeys(item, VERSION_REF_KEYS, VERSION_REF_KEYS, `${label}[${index}]`);
    return deepFreeze({
      skillId: stableToken(item.skillId, `${label}[${index}].skillId`),
      version: versionToken(item.version, `${label}[${index}].version`),
    });
  }).sort((left, right) => compareText(left.skillId, right.skillId) || compareVersion(left.version, right.version));
  const keys = output.map(versionRefKey);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(output);
}

function normalizeCandidateRefs(input: unknown, label: string): readonly AgentSkillCandidateRefV1[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new TypeError(`${label} must be an array with at most 64 items`);
  }
  const output = input.map((item, index) => {
    assertPlainRecord(item, `${label}[${index}]`);
    assertExactKeys(item, CANDIDATE_REF_KEYS, CANDIDATE_REF_KEYS, `${label}[${index}]`);
    return deepFreeze({
      skillId: stableToken(item.skillId, `${label}[${index}].skillId`),
      version: versionToken(item.version, `${label}[${index}].version`),
      reasonCode: stableToken(item.reasonCode, `${label}[${index}].reasonCode`),
      scoreBps: safeInteger(item.scoreBps, `${label}[${index}].scoreBps`, 0, 10_000),
      evidenceDigest: sha256Digest(item.evidenceDigest, `${label}[${index}].evidenceDigest`),
    });
  }).sort((left, right) => (
    compareText(left.skillId, right.skillId)
    || compareVersion(left.version, right.version)
    || compareText(left.reasonCode, right.reasonCode)
    || right.scoreBps - left.scoreBps
    || compareText(left.evidenceDigest, right.evidenceDigest)
  ));
  const keys = output.map(versionRefKey);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${label} must not contain duplicate Skill refs`);
  return Object.freeze(output);
}

export function normalizeAgentSkillSelectionRequest(input: unknown): AgentSkillSelectionRequestV1 {
  assertPlainRecord(input, 'selectionRequest');
  assertExactKeys(input, REQUEST_KEYS, REQUIRED_REQUEST_KEYS, 'selectionRequest');
  if (input.requestVersion !== AGENT_SKILL_SELECTION_REQUEST_VERSION) {
    throw new TypeError(`selectionRequest.requestVersion must be ${AGENT_SKILL_SELECTION_REQUEST_VERSION}`);
  }
  const grant = normalizeAgentSkillExecutionGrant(input.grant);
  const budgetTokens = safeInteger(input.budgetTokens, 'selectionRequest.budgetTokens', 0, 10_000_000);
  if (budgetTokens > grant.maxInputTokens) {
    throw new TypeError('selectionRequest.budgetTokens cannot exceed the host input-token grant');
  }
  return deepFreeze({
    requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
    catalogRevision: stableToken(input.catalogRevision, 'selectionRequest.catalogRevision'),
    capabilityId: stableToken(input.capabilityId, 'selectionRequest.capabilityId'),
    taskKind: stableToken(input.taskKind, 'selectionRequest.taskKind'),
    phase: member(input.phase, AGENT_SKILL_PHASES, 'selectionRequest.phase'),
    contentMode: member(input.contentMode, AGENT_SKILL_CONTENT_MODES, 'selectionRequest.contentMode'),
    scope: normalizeTargetScope(input.scope),
    grant,
    budgetTokens,
    maxSkills: safeInteger(input.maxSkills, 'selectionRequest.maxSkills', 1, 64),
    explicit: normalizeVersionRefs(input.explicit, 'selectionRequest.explicit'),
    ...(input.candidates === undefined
      ? {}
      : { candidates: normalizeCandidateRefs(input.candidates, 'selectionRequest.candidates') }),
  });
}

function versionRefKey(value: AgentSkillVersionRefV1): string {
  return `${value.skillId}\u0000${value.version}`;
}

function headerRefKey(header: AgentSkillHeaderV1): string {
  return versionRefKey(header.manifest);
}

/** Returns why the manifest would exceed authority already granted by the host. */
export function agentSkillGrantViolations(
  headerInput: unknown,
  grantInput: unknown,
): readonly string[] {
  const header = normalizeAgentSkillHeader(headerInput);
  const grant = normalizeAgentSkillExecutionGrant(grantInput);
  const manifest = header.manifest;
  const tools = new Set(grant.tools);
  const artifacts = new Set(grant.writableArtifactKinds);
  const violations: string[] = [];
  for (const tool of manifest.desiredTools) if (!tools.has(tool)) violations.push(`tool:${tool}`);
  for (const artifact of manifest.writableArtifactKinds) {
    if (!artifacts.has(artifact)) violations.push(`artifact:${artifact}`);
  }
  if (RISK_STRENGTH[manifest.riskTier] > RISK_STRENGTH[grant.maxRiskTier]) violations.push('riskTier');
  if (manifest.limits.maxModelCalls > grant.maxModelCalls) violations.push('maxModelCalls');
  if (manifest.limits.maxToolCalls > grant.maxToolCalls) violations.push('maxToolCalls');
  if (manifest.limits.maxInputTokens > grant.maxInputTokens) violations.push('maxInputTokens');
  if (manifest.limits.maxOutputTokens > grant.maxOutputTokens) violations.push('maxOutputTokens');
  return Object.freeze(violations.sort(compareText));
}

export function assertAgentSkillWithinGrant(headerInput: unknown, grantInput: unknown): void {
  const violations = agentSkillGrantViolations(headerInput, grantInput);
  if (violations.length > 0) {
    throw new Error(`Skill cannot expand host permissions: ${violations.join(', ')}`);
  }
}

function scopeMatches(header: AgentSkillHeaderV1, request: AgentSkillSelectionRequestV1): boolean {
  const scope = header.manifest.scope;
  if (scope.kind === 'global') return true;
  const actual = scope.kind === 'session' ? request.scope.sessionId
    : scope.kind === 'card' ? request.scope.cardId
      : request.scope.worldId;
  return actual !== undefined && (scope.selector === undefined || scope.selector === actual);
}

function eligibilityReason(
  header: AgentSkillHeaderV1,
  request: AgentSkillSelectionRequestV1,
): AgentSkillRejectionReason | null {
  const manifest = header.manifest;
  if (!manifest.capabilityIds.includes(request.capabilityId)) return 'capability-mismatch';
  if (!manifest.taskKinds.includes(request.taskKind)) return 'task-mismatch';
  if (!manifest.phases.includes(request.phase)) return 'phase-mismatch';
  if (!manifest.contentModes.includes(request.contentMode)) return 'content-mode-mismatch';
  if (!scopeMatches(header, request)) return 'scope-mismatch';
  if (agentSkillGrantViolations(header, request.grant).length > 0) return 'permission-expansion';
  return null;
}

function rejection(header: AgentSkillHeaderV1, reason: AgentSkillRejectionReason): RejectedAgentSkillV1 {
  return deepFreeze({
    skillId: header.manifest.skillId,
    version: header.manifest.version,
    manifestDigest: header.manifestDigest,
    bodyHash: header.manifest.bodyHash,
    bodyTokens: header.manifest.bodyTokens,
    reason,
  });
}

function isExplicit(header: AgentSkillHeaderV1, explicit: ReadonlySet<string>): boolean {
  return explicit.has(headerRefKey(header));
}

function compareHeaders(
  left: AgentSkillHeaderV1,
  right: AgentSkillHeaderV1,
  explicit: ReadonlySet<string>,
  candidates: ReadonlyMap<string, AgentSkillCandidateRefV1>,
): number {
  const leftForced = left.manifest.kind === 'foundation' ? 2 : isExplicit(left, explicit) ? 1 : 0;
  const rightForced = right.manifest.kind === 'foundation' ? 2 : isExplicit(right, explicit) ? 1 : 0;
  return rightForced - leftForced
    || (candidates.get(headerRefKey(right))?.scoreBps ?? -1)
      - (candidates.get(headerRefKey(left))?.scoreBps ?? -1)
    || right.manifest.priority - left.manifest.priority
    || KIND_RANK[left.manifest.kind] - KIND_RANK[right.manifest.kind]
    || compareText(left.manifest.skillId, right.manifest.skillId)
    || -compareVersion(left.manifest.version, right.manifest.version)
    || compareText(left.manifestDigest, right.manifestDigest);
}

function selectedReason(
  header: AgentSkillHeaderV1,
  root: AgentSkillHeaderV1,
  explicit: ReadonlySet<string>,
  candidates: ReadonlyMap<string, AgentSkillCandidateRefV1>,
): AgentSkillSelectionReason {
  if (header.manifest.kind === 'foundation') return 'foundation';
  if (isExplicit(header, explicit)) return 'explicit';
  if (header.manifestDigest !== root.manifestDigest) return 'dependency';
  return candidates.has(headerRefKey(header)) ? 'candidate' : 'ranked';
}

function conflictExists(headers: readonly AgentSkillHeaderV1[]): boolean {
  for (let leftIndex = 0; leftIndex < headers.length; leftIndex += 1) {
    const left = headers[leftIndex]!.manifest;
    for (let rightIndex = leftIndex + 1; rightIndex < headers.length; rightIndex += 1) {
      const right = headers[rightIndex]!.manifest;
      if ((left.conflictGroup !== undefined && left.conflictGroup === right.conflictGroup)
        || left.conflictsWith.includes(right.skillId)
        || right.conflictsWith.includes(left.skillId)) return true;
    }
  }
  return false;
}

function receiptCore(input: Omit<AgentSkillSelectionReceiptV1, 'receiptDigest'>): unknown {
  return input;
}

function instructionSetDigest(selected: readonly SelectedAgentSkillV1[]): string {
  return digestCanonical(selected.map((item) => ({
    skillId: item.header.manifest.skillId,
    version: item.header.manifest.version,
    manifestDigest: item.header.manifestDigest,
    bodyHash: item.header.manifest.bodyHash,
    sourceHash: item.header.manifest.sourceHash,
    sourceRevision: item.header.manifest.sourceRevision,
  })));
}

/**
 * Deterministic header-only selector. It never accepts or loads a body. Dependencies are exact,
 * whole Skills are budgeted atomically, and foundation/explicit Skills remain indivisible even
 * when they expose a budget conflict.
 */
export function selectAgentSkillHeaders(
  headerInputs: readonly unknown[],
  requestInput: unknown,
): AgentSkillSelectionReceiptV1 {
  if (!Array.isArray(headerInputs) || headerInputs.length > 256) {
    throw new TypeError('skillHeaders must be an array with at most 256 items');
  }
  const request = normalizeAgentSkillSelectionRequest(requestInput);
  const headers = headerInputs.map(normalizeAgentSkillHeader);
  const byRefAll = new Map<string, AgentSkillHeaderV1>();
  for (const header of headers) {
    const key = headerRefKey(header);
    const prior = byRefAll.get(key);
    if (prior && prior.manifestDigest !== header.manifestDigest) {
      throw new Error(`immutable Skill version collision: ${header.manifest.skillId}@${header.manifest.version}`);
    }
    if (prior) throw new TypeError(`duplicate Skill header: ${header.manifest.skillId}@${header.manifest.version}`);
    byRefAll.set(key, header);
  }
  const explicit = new Set(request.explicit.map(versionRefKey));
  const explicitMissing = request.explicit.filter((ref) => !byRefAll.has(versionRefKey(ref)));
  if (explicitMissing.length > 0) {
    throw new Error(`explicit Skill header missing: ${explicitMissing.map(versionRefKey).join(', ')}`);
  }
  const candidateByRef = new Map((request.candidates ?? []).map((candidate) => [
    versionRefKey(candidate), candidate,
  ]));
  const candidateMissing = (request.candidates ?? []).filter((candidate) => (
    !byRefAll.has(versionRefKey(candidate))
  ));
  if (candidateMissing.length > 0) {
    throw new Error(`candidate Skill header missing: ${candidateMissing.map(versionRefKey).join(', ')}`);
  }
  const ranked = [...headers].sort((left, right) => (
    compareHeaders(left, right, explicit, candidateByRef)
  ));
  const eligibleByRef = new Map<string, AgentSkillHeaderV1>();
  const rejectedByDigest = new Map<string, RejectedAgentSkillV1>();
  for (const header of ranked) {
    const reason = eligibilityReason(header, request);
    if (reason === null) eligibleByRef.set(headerRefKey(header), header);
    else rejectedByDigest.set(header.manifestDigest, rejection(header, reason));
  }

  const selected: SelectedAgentSkillV1[] = [];
  const selectedByRef = new Map<string, AgentSkillHeaderV1>();
  const selectedBySkillId = new Map<string, AgentSkillHeaderV1>();
  let usedTokens = 0;

  const closureFor = (root: AgentSkillHeaderV1): {
    readonly headers?: readonly AgentSkillHeaderV1[];
    readonly error?: AgentSkillRejectionReason;
  } => {
    const ordered: AgentSkillHeaderV1[] = [];
    const visiting = new Set<string>();
    const included = new Map<string, AgentSkillHeaderV1>();
    let error: AgentSkillRejectionReason | undefined;
    const visit = (header: AgentSkillHeaderV1): void => {
      if (error) return;
      const key = headerRefKey(header);
      if (selectedByRef.has(key) || included.has(key)) return;
      const selectedVersion = selectedBySkillId.get(header.manifest.skillId);
      const includedVersion = [...included.values()].find((item) => item.manifest.skillId === header.manifest.skillId);
      if ((selectedVersion && headerRefKey(selectedVersion) !== key)
        || (includedVersion && headerRefKey(includedVersion) !== key)) {
        error = 'dependency-version-conflict';
        return;
      }
      if (visiting.has(key)) {
        error = 'dependency-cycle';
        return;
      }
      visiting.add(key);
      for (const dependency of header.manifest.requires) {
        const dependencyKey = versionRefKey(dependency);
        const dependencyHeader = eligibleByRef.get(dependencyKey);
        if (!dependencyHeader) {
          error = 'dependency-missing';
          break;
        }
        visit(dependencyHeader);
      }
      visiting.delete(key);
      if (!error) {
        included.set(key, header);
        ordered.push(header);
      }
    };
    visit(root);
    return error ? { error } : { headers: Object.freeze(ordered) };
  };

  for (const root of ranked) {
    if (!eligibleByRef.has(headerRefKey(root)) || selectedByRef.has(headerRefKey(root))) continue;
    if (request.candidates !== undefined
      && root.manifest.kind !== 'foundation'
      && !isExplicit(root, explicit)
      && !candidateByRef.has(headerRefKey(root))) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, 'not-candidate'));
      continue;
    }
    const selectedVersion = selectedBySkillId.get(root.manifest.skillId);
    if (selectedVersion) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, 'superseded'));
      continue;
    }
    const closure = closureFor(root);
    if (!closure.headers) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, closure.error!));
      continue;
    }
    const additions = closure.headers.filter((header) => !selectedByRef.has(headerRefKey(header)));
    const combined = [...selected.map((item) => item.header), ...additions];
    if (conflictExists(combined)) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, 'conflict'));
      continue;
    }
    if (combined.length > request.maxSkills) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, 'max-skills'));
      continue;
    }
    const additionalTokens = additions.reduce((sum, header) => sum + header.manifest.bodyTokens, 0);
    const forced = root.manifest.kind === 'foundation' || isExplicit(root, explicit);
    if (!forced && usedTokens + additionalTokens > request.budgetTokens) {
      rejectedByDigest.set(root.manifestDigest, rejection(root, 'over-budget'));
      continue;
    }
    for (const header of additions) {
      selected.push(deepFreeze({
        header,
        reason: selectedReason(header, root, explicit, candidateByRef),
      }));
      selectedByRef.set(headerRefKey(header), header);
      selectedBySkillId.set(header.manifest.skillId, header);
      rejectedByDigest.delete(header.manifestDigest);
      usedTokens += header.manifest.bodyTokens;
    }
  }

  for (const header of ranked) {
    if (!selectedByRef.has(headerRefKey(header)) && !rejectedByDigest.has(header.manifestDigest)) {
      rejectedByDigest.set(header.manifestDigest, rejection(header, 'superseded'));
    }
  }
  const rejected = [...rejectedByDigest.values()].sort((left, right) => (
    compareText(left.skillId, right.skillId)
    || -compareVersion(left.version, right.version)
    || compareText(left.manifestDigest, right.manifestDigest)
  ));
  const candidateHeadersDigest = digestCanonical(
    headers.map((header) => header.manifestDigest).sort(compareText),
  );
  const discovery = request.candidates === undefined ? undefined : deepFreeze({
    discoveryVersion: AGENT_SKILL_DISCOVERY_VERSION,
    candidates: request.candidates,
    discoveryDigest: digestCanonical(request.candidates),
  });
  const core: Omit<AgentSkillSelectionReceiptV1, 'receiptDigest'> = deepFreeze({
    receiptVersion: AGENT_SKILL_SELECTION_RECEIPT_VERSION,
    selectorVersion: AGENT_SKILL_SELECTOR_VERSION,
    catalogRevision: request.catalogRevision,
    requestDigest: digestCanonical(request),
    candidateHeadersDigest,
    budgetTokens: request.budgetTokens,
    usedTokens,
    budgetConflict: usedTokens > request.budgetTokens,
    selected: Object.freeze(selected),
    rejected: Object.freeze(rejected),
    ...(discovery === undefined ? {} : { discovery }),
    instructionSetDigest: instructionSetDigest(selected),
  });
  return deepFreeze({ ...core, receiptDigest: digestCanonical(receiptCore(core)) });
}

function normalizeSelected(input: unknown, index: number): SelectedAgentSkillV1 {
  assertPlainRecord(input, `selectionReceipt.selected[${index}]`);
  assertExactKeys(input, SELECTED_KEYS, SELECTED_KEYS, `selectionReceipt.selected[${index}]`);
  return deepFreeze({
    header: normalizeAgentSkillHeader(input.header),
    reason: member(input.reason, AGENT_SKILL_SELECTION_REASONS, `selectionReceipt.selected[${index}].reason`),
  });
}

function normalizeRejected(input: unknown, index: number): RejectedAgentSkillV1 {
  assertPlainRecord(input, `selectionReceipt.rejected[${index}]`);
  assertExactKeys(input, REJECTED_KEYS, REJECTED_KEYS, `selectionReceipt.rejected[${index}]`);
  return deepFreeze({
    skillId: stableToken(input.skillId, `selectionReceipt.rejected[${index}].skillId`),
    version: versionToken(input.version, `selectionReceipt.rejected[${index}].version`),
    manifestDigest: sha256Digest(input.manifestDigest, `selectionReceipt.rejected[${index}].manifestDigest`),
    bodyHash: sha256Digest(input.bodyHash, `selectionReceipt.rejected[${index}].bodyHash`),
    bodyTokens: safeInteger(input.bodyTokens, `selectionReceipt.rejected[${index}].bodyTokens`, 1, 10_000_000),
    reason: member(input.reason, AGENT_SKILL_REJECTION_REASONS, `selectionReceipt.rejected[${index}].reason`),
  });
}

function normalizeDiscovery(input: unknown): AgentSkillDiscoveryReceiptV1 {
  assertPlainRecord(input, 'selectionReceipt.discovery');
  assertExactKeys(input, DISCOVERY_KEYS, DISCOVERY_KEYS, 'selectionReceipt.discovery');
  if (input.discoveryVersion !== AGENT_SKILL_DISCOVERY_VERSION) {
    throw new TypeError(`selectionReceipt.discovery.discoveryVersion must be ${AGENT_SKILL_DISCOVERY_VERSION}`);
  }
  const candidates = normalizeCandidateRefs(input.candidates, 'selectionReceipt.discovery.candidates');
  const discoveryDigest = sha256Digest(
    input.discoveryDigest,
    'selectionReceipt.discovery.discoveryDigest',
  );
  if (discoveryDigest !== digestCanonical(candidates)) {
    throw new TypeError('selectionReceipt.discovery.discoveryDigest mismatch');
  }
  return deepFreeze({
    discoveryVersion: AGENT_SKILL_DISCOVERY_VERSION,
    candidates,
    discoveryDigest,
  });
}

export function normalizeAgentSkillSelectionReceipt(input: unknown): AgentSkillSelectionReceiptV1 {
  assertPlainRecord(input, 'selectionReceipt');
  assertExactKeys(input, RECEIPT_KEYS, REQUIRED_RECEIPT_KEYS, 'selectionReceipt');
  if (input.receiptVersion !== AGENT_SKILL_SELECTION_RECEIPT_VERSION
    || input.selectorVersion !== AGENT_SKILL_SELECTOR_VERSION) {
    throw new TypeError('selectionReceipt contract version is unsupported');
  }
  if (!Array.isArray(input.selected) || !Array.isArray(input.rejected)) {
    throw new TypeError('selectionReceipt selected/rejected must be arrays');
  }
  const selected = input.selected.map(normalizeSelected);
  const rejected = input.rejected.map(normalizeRejected);
  const selectedIds = selected.map((item) => item.header.manifest.skillId);
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new TypeError('selectionReceipt cannot select multiple versions of one Skill');
  }
  const usedTokens = safeInteger(input.usedTokens, 'selectionReceipt.usedTokens', 0, 10_000_000);
  if (usedTokens !== selected.reduce((sum, item) => sum + item.header.manifest.bodyTokens, 0)) {
    throw new TypeError('selectionReceipt.usedTokens mismatch');
  }
  const budgetTokens = safeInteger(input.budgetTokens, 'selectionReceipt.budgetTokens', 0, 10_000_000);
  if (input.budgetConflict !== (usedTokens > budgetTokens)) {
    throw new TypeError('selectionReceipt.budgetConflict mismatch');
  }
  const discovery = input.discovery === undefined ? undefined : normalizeDiscovery(input.discovery);
  const normalizedCore: Omit<AgentSkillSelectionReceiptV1, 'receiptDigest'> = deepFreeze({
    receiptVersion: AGENT_SKILL_SELECTION_RECEIPT_VERSION,
    selectorVersion: AGENT_SKILL_SELECTOR_VERSION,
    catalogRevision: stableToken(input.catalogRevision, 'selectionReceipt.catalogRevision'),
    requestDigest: sha256Digest(input.requestDigest, 'selectionReceipt.requestDigest'),
    candidateHeadersDigest: sha256Digest(input.candidateHeadersDigest, 'selectionReceipt.candidateHeadersDigest'),
    budgetTokens,
    usedTokens,
    budgetConflict: input.budgetConflict as boolean,
    selected: Object.freeze(selected),
    rejected: Object.freeze(rejected),
    ...(discovery === undefined ? {} : { discovery }),
    instructionSetDigest: sha256Digest(input.instructionSetDigest, 'selectionReceipt.instructionSetDigest'),
  });
  if (normalizedCore.instructionSetDigest !== instructionSetDigest(selected)) {
    throw new TypeError('selectionReceipt.instructionSetDigest mismatch');
  }
  const receiptDigest = sha256Digest(input.receiptDigest, 'selectionReceipt.receiptDigest');
  if (receiptDigest !== digestCanonical(receiptCore(normalizedCore))) {
    throw new TypeError('selectionReceipt.receiptDigest mismatch');
  }
  return deepFreeze({ ...normalizedCore, receiptDigest });
}
