/**
 * HC-1 companion inventory for logical Workspace, execution environment and authority lifetime.
 *
 * This module is deliberately absent from the production SkillHub barrel. Importing it performs
 * no IO, creates no Lease/claim and grants no execution or write authority; it derives one frozen
 * descriptor for every route in the read-only Agent contract index.
 */
import {
  AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION,
  AGENT_CONTRACT_BOUNDARY_INDEX_VERSION,
  createAgentContractBoundaryIndex,
  normalizeAgentContractBoundaryIndex,
  type AgentContractBoundaryDescriptorV1,
  type AgentContractBoundaryIndexV1,
  type AgentContractBoundarySlotV1,
  type AgentContractComponentRefV1,
  type AgentContractDescriptorV1,
} from '../../../packages/agent-policy/public/agent-skill-contract-index.ts';
import {
  SESSION_AGENT_SKILL_ASSET_CONTEXT_VERSION,
  SESSION_AGENT_SKILL_TURN_CONTEXT_VERSION,
} from '../../../packages/session/public/agent-skill-turn-context.ts';
import {
  SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION,
} from '../../../packages/session/public/learning-preference-skill-source.ts';
import { SESSION_BRANCH_PREFERENCE_SKILL_SOURCE_VERSION }
  from '../../../packages/session/public/branch-preference-skill-source.ts';
import {
  SESSION_DATABASE_SNAPSHOT_VERSION,
  SESSION_SNAPSHOT_VERSION,
} from '../../../packages/memory/public/session-snapshot.ts';
import { SCHEMA_VERSION as MEMORY_SCHEMA_VERSION } from '../../../packages/memory/public/schema.ts';
import {
  AGENT_SKILL_COMPILER_REVISION,
  AGENT_SKILL_COMPILER_VERSION,
} from '@jiuguan/prompt/agent-skill-compiler';
import { PROVIDER_PROTOCOL_VERSION } from '../../../packages/proxy/public/provider-protocol.ts';
import { AGENT_SKILL_GRANT_VERSION } from '@jiuguan/skill-hub';
import {
  MAINTENANCE_EXECUTION_CLAIM_VERSION,
  MAINTENANCE_JOB_SCHEMA_VERSION,
} from '../maintenance-job-contract.ts';
import {
  SERVER_AGENT_CONTRACT_INDEX,
  SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY,
} from './agent-contract-index.ts';
import {
  SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION,
  SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION,
} from './profile-admission-service.ts';
import { SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION } from './prompt-consumer.ts';
import { SERVER_MODEL_TOOL_SURFACES, modelToolSurfaceFor } from './model-tool-surfaces.ts';
import { NSFW_SCENE_SKILL_SOURCE_VERSION, NSFW_SCENE_SKILL_RECEIPT_VERSION }
  from '../../../packages/session/public/nsfw-scene-skill.ts';
import { NSFW_SCENE_SKILL_HOST_VERSION } from './nsfw-scene-host.ts';
import { domainSourceContractFor } from './domain-source-contracts.ts';

export const SERVER_AGENT_BOUNDARY_REFERENCE_REGISTRY_VERSION =
  'server-agent-boundary-reference-registry-v11' as const;

export interface ServerAgentBoundaryReferenceV1 {
  readonly ref: string;
  readonly targetKind:
    | 'active-turn-context'
    | 'asset-context'
    | 'learning-source'
    | 'session-snapshot'
    | 'snapshot-evidence'
    | 'proposal-store'
    | 'compiled-artifact'
    | 'prompt-receipt'
    | 'skill-grant'
    | 'host-port-set'
    | 'provider-transport'
    | 'model-tool-surface'
    | 'tool-surface-variant'
    | 'execution-claim';
  readonly contractVersion: string;
  readonly resolution: 'static' | 'runtime';
}

export interface ServerAgentBoundaryReferenceRegistryV1 {
  readonly registryVersion: typeof SERVER_AGENT_BOUNDARY_REFERENCE_REGISTRY_VERSION;
  readonly entries: readonly ServerAgentBoundaryReferenceV1[];
  byRef(ref: string): ServerAgentBoundaryReferenceV1 | undefined;
}

const REAL_MAINTENANCE_TASK_KINDS = Object.freeze([
  'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state', 'worldbook_repair',
] as const);
const PROPOSAL_STORE_TASK_KINDS = Object.freeze([
  'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state',
] as const);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indexed(
  ref: string,
  coverage: 'complete' | 'partial' = 'complete',
  evidenceRefs: readonly string[] = [],
): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'indexed', coverage, ref, evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function runtimeResolved(
  ref: string,
  coverage: 'complete' | 'partial' = 'partial',
  evidenceRefs: readonly string[] = [],
): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'runtime-resolved', coverage, ref, evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

function pending(reasonCode: string, nextContract: string): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'pending', coverage: 'missing', reasonCode, nextContract,
    evidenceRefs: Object.freeze([]),
  });
}

function missing(reasonCode: string): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'missing', coverage: 'missing', reasonCode, evidenceRefs: Object.freeze([]),
  });
}

function slot(
  applicability: AgentContractBoundarySlotV1['applicability'],
  access: AgentContractBoundarySlotV1['access'],
  component: AgentContractComponentRefV1 | null,
): AgentContractBoundarySlotV1 {
  return Object.freeze({ applicability, access, component });
}

function notApplicable(): AgentContractBoundarySlotV1 {
  return slot('not-applicable', 'none', null);
}

function turnContextRef(): string {
  return `ref.workspace.active-turn.${SESSION_AGENT_SKILL_TURN_CONTEXT_VERSION}`;
}

function assetContextRef(): string {
  return `ref.workspace.assets.${SESSION_AGENT_SKILL_ASSET_CONTEXT_VERSION}`;
}

function learningPreferenceSourceRef(): string {
  return `ref.workspace.learning-source.${SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION}`;
}

function branchPreferenceSourceRef(): string {
  return `ref.workspace.learning-source.${SESSION_BRANCH_PREFERENCE_SKILL_SOURCE_VERSION}`;
}

function styleCompileSourceRef(): string {
  return 'ref.workspace.learning-source.style-compile-skill-source-v1';
}

function sessionSnapshotRef(): string {
  return `ref.workspace.session-snapshot.${SESSION_SNAPSHOT_VERSION}`;
}

function databaseSnapshotRef(): string {
  return `ref.evidence.database-snapshot.${SESSION_DATABASE_SNAPSHOT_VERSION}`;
}

function memorySchemaRef(): string {
  return `ref.evidence.memory-schema.v${MEMORY_SCHEMA_VERSION}`;
}

function maintenanceProposalStoreRef(): string {
  return `ref.workspace.maintenance-proposal-store.v${MAINTENANCE_JOB_SCHEMA_VERSION}`;
}

function compiledArtifactRef(): string {
  return `ref.process.compiled-artifact.${AGENT_SKILL_COMPILER_VERSION}.${AGENT_SKILL_COMPILER_REVISION}`;
}

function profileAdmissionHandleRef(): string {
  return `ref.process.profile-admission-handle.${SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION}`;
}

function promptReceiptRef(): string {
  return `ref.receipt.prompt.${SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION}`;
}

function skillGrantRef(): string {
  return `ref.environment.skill-grant.${AGENT_SKILL_GRANT_VERSION}`;
}

function hostPortSetRef(): string {
  return `ref.environment.host-ports.${SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION}`;
}

function providerTransportRef(): string {
  return `ref.environment.provider-transport.v${PROVIDER_PROTOCOL_VERSION}`;
}

function maintenanceClaimRef(): string {
  return `ref.lifetime.maintenance-claim.${MAINTENANCE_EXECUTION_CLAIM_VERSION}`;
}

function isNsfw(entry: AgentContractDescriptorV1): boolean {
  return entry.profileRef.profileId === 'maintenance.nsfwScene' && entry.route.taskKind === 'nsfw_scene_curator';
}
function isAqlReplan(entry: AgentContractDescriptorV1): boolean {
  return entry.profileRef.profileId === 'interactive.aqlReplan' && entry.route.taskKind === 'aql_replan'
    && entry.route.phase === 'plan';
}
function nsfwSourceRef() { return `ref.workspace.nsfw-scene-source.${NSFW_SCENE_SKILL_SOURCE_VERSION}`; }
function nsfwAssetsRef() { return `ref.workspace.nsfw-scene-assets.${NSFW_SCENE_SKILL_SOURCE_VERSION}`; }
function nsfwHandleRef() { return `ref.process.nsfw-scene-handle.${NSFW_SCENE_SKILL_HOST_VERSION}`; }
function nsfwReceiptRef() { return `ref.receipt.nsfw-scene.${NSFW_SCENE_SKILL_RECEIPT_VERSION}`; }
function nsfwHostRef() { return `ref.environment.nsfw-scene-host.${NSFW_SCENE_SKILL_HOST_VERSION}`; }
function nsfwNoModelRef() { return `ref.environment.nsfw-scene-zero-model.${NSFW_SCENE_SKILL_HOST_VERSION}`; }
function nsfwNoTransportRef() { return `ref.environment.nsfw-scene-zero-provider.${NSFW_SCENE_SKILL_HOST_VERSION}`; }

function buildReferenceRegistry(): ServerAgentBoundaryReferenceRegistryV1 {
  const rows: ServerAgentBoundaryReferenceV1[] = [
    { ref: nsfwSourceRef(), targetKind: 'active-turn-context', contractVersion: NSFW_SCENE_SKILL_SOURCE_VERSION, resolution: 'runtime' },
    { ref: nsfwAssetsRef(), targetKind: 'asset-context', contractVersion: NSFW_SCENE_SKILL_SOURCE_VERSION, resolution: 'runtime' },
    { ref: nsfwHandleRef(), targetKind: 'compiled-artifact', contractVersion: NSFW_SCENE_SKILL_HOST_VERSION, resolution: 'runtime' },
    { ref: nsfwReceiptRef(), targetKind: 'prompt-receipt', contractVersion: NSFW_SCENE_SKILL_RECEIPT_VERSION, resolution: 'runtime' },
    { ref: nsfwHostRef(), targetKind: 'host-port-set', contractVersion: NSFW_SCENE_SKILL_HOST_VERSION, resolution: 'runtime' },
    { ref: nsfwNoModelRef(), targetKind: 'model-tool-surface', contractVersion: NSFW_SCENE_SKILL_HOST_VERSION, resolution: 'static' },
    { ref: nsfwNoTransportRef(), targetKind: 'provider-transport', contractVersion: NSFW_SCENE_SKILL_HOST_VERSION, resolution: 'static' },
    {
      ref: turnContextRef(), targetKind: 'active-turn-context',
      contractVersion: SESSION_AGENT_SKILL_TURN_CONTEXT_VERSION, resolution: 'runtime',
    },
    {
      ref: assetContextRef(), targetKind: 'asset-context',
      contractVersion: SESSION_AGENT_SKILL_ASSET_CONTEXT_VERSION, resolution: 'runtime',
    },
    {
      ref: learningPreferenceSourceRef(), targetKind: 'learning-source',
      contractVersion: SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION, resolution: 'runtime',
    },
    {
      ref: branchPreferenceSourceRef(), targetKind: 'learning-source',
      contractVersion: SESSION_BRANCH_PREFERENCE_SKILL_SOURCE_VERSION, resolution: 'runtime',
    },
    {
      ref: styleCompileSourceRef(), targetKind: 'learning-source',
      contractVersion: 'style-compile-skill-source-v1', resolution: 'runtime',
    },
    {
      ref: sessionSnapshotRef(), targetKind: 'session-snapshot',
      contractVersion: SESSION_SNAPSHOT_VERSION, resolution: 'runtime',
    },
    {
      ref: databaseSnapshotRef(), targetKind: 'snapshot-evidence',
      contractVersion: SESSION_DATABASE_SNAPSHOT_VERSION, resolution: 'runtime',
    },
    {
      ref: memorySchemaRef(), targetKind: 'snapshot-evidence',
      contractVersion: `memory-schema-v${MEMORY_SCHEMA_VERSION}`, resolution: 'static',
    },
    {
      ref: maintenanceProposalStoreRef(), targetKind: 'proposal-store',
      contractVersion: `maintenance-job-schema-v${MAINTENANCE_JOB_SCHEMA_VERSION}`,
      resolution: 'runtime',
    },
    {
      ref: compiledArtifactRef(), targetKind: 'compiled-artifact',
      contractVersion: AGENT_SKILL_COMPILER_REVISION, resolution: 'runtime',
    },
    {
      ref: profileAdmissionHandleRef(), targetKind: 'compiled-artifact',
      contractVersion: SERVER_AGENT_SKILL_PROFILE_ADMISSION_HANDLE_VERSION, resolution: 'runtime',
    },
    {
      ref: promptReceiptRef(), targetKind: 'prompt-receipt',
      contractVersion: SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION, resolution: 'runtime',
    },
    {
      ref: skillGrantRef(), targetKind: 'skill-grant',
      contractVersion: AGENT_SKILL_GRANT_VERSION, resolution: 'runtime',
    },
    {
      ref: hostPortSetRef(), targetKind: 'host-port-set',
      contractVersion: SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION, resolution: 'runtime',
    },
    {
      ref: providerTransportRef(), targetKind: 'provider-transport',
      contractVersion: `provider-protocol-v${PROVIDER_PROTOCOL_VERSION}`, resolution: 'runtime',
    },
    {
      ref: maintenanceClaimRef(), targetKind: 'execution-claim',
      contractVersion: MAINTENANCE_EXECUTION_CLAIM_VERSION, resolution: 'runtime',
    },
  ];
  for (const surface of SERVER_MODEL_TOOL_SURFACES) {
    rows.push({ ref: surface.reference, targetKind: 'model-tool-surface',
      contractVersion: surface.sourceVersion, resolution: surface.resolution });
    for (const variant of surface.variants) {
      rows.push({ ref: variant.reference, targetKind: 'tool-surface-variant',
        contractVersion: variant.sourceVersion, resolution: variant.digestResolution });
    }
  }
  rows.sort((left, right) => compareText(left.ref, right.ref));
  const duplicate = rows.find((row, index) => index > 0 && rows[index - 1]?.ref === row.ref);
  if (duplicate) throw new TypeError(`agent-boundary-reference duplicate: ${duplicate.ref}`);
  const entries = Object.freeze(rows.map((row) => Object.freeze(row)));
  const byRef = new Map(entries.map((row) => [row.ref, row]));
  return Object.freeze({
    registryVersion: SERVER_AGENT_BOUNDARY_REFERENCE_REGISTRY_VERSION,
    entries,
    byRef(ref: string) { return byRef.get(ref); },
  });
}

export const SERVER_AGENT_BOUNDARY_REFERENCE_REGISTRY = buildReferenceRegistry();

function isOneOf(value: string, values: readonly string[]): boolean {
  return values.includes(value);
}

function baseSnapshotComponent(entry: AgentContractDescriptorV1): AgentContractComponentRefV1 | null {
  if (entry.execution.identityKind === 'unbound') return null;
  if (isAqlReplan(entry)) return entry.contracts.taskSourceProof;
  if (isNsfw(entry)) return runtimeResolved(nsfwSourceRef(), 'complete');
  if (entry.execution.identityKind === 'foreground-turn') return runtimeResolved(turnContextRef());
  if (entry.profileRef.profileId === 'learning.preference') {
    return indexed(learningPreferenceSourceRef());
  }
  if (entry.profileRef.profileId === 'learning.branchPreference') return indexed(branchPreferenceSourceRef());
  if (entry.profileRef.profileId === 'learning.styleCompile') return runtimeResolved(styleCompileSourceRef(), 'partial');
  if (entry.execution.identityKind === 'learning-run') {
    return pending('learning-source-contract-not-indexed', 'learning-source-ref-v1');
  }
  if (entry.route.taskKind === 'memory_consolidation' || entry.route.taskKind === 'rolling_summary') {
    return entry.contracts.taskSourceProof;
  }
  if (isOneOf(entry.route.taskKind, REAL_MAINTENANCE_TASK_KINDS)) {
    return runtimeResolved(sessionSnapshotRef(), 'partial', [databaseSnapshotRef(), memorySchemaRef()]);
  }
  return pending('maintenance-alias-source-not-indexed', 'maintenance-alias-source-ref-v1');
}

function baseAssetComponent(entry: AgentContractDescriptorV1): AgentContractComponentRefV1 | null {
  if (entry.execution.identityKind === 'unbound') return null;
  if (isAqlReplan(entry)) return entry.contracts.taskSourceProof;
  if (isNsfw(entry)) return runtimeResolved(nsfwAssetsRef(), 'complete');
  if (entry.execution.identityKind === 'foreground-turn') return runtimeResolved(assetContextRef());
  if (entry.profileRef.profileId === 'learning.preference') {
    return indexed(learningPreferenceSourceRef());
  }
  if (entry.profileRef.profileId === 'learning.branchPreference') return indexed(branchPreferenceSourceRef());
  if (entry.profileRef.profileId === 'learning.styleCompile') return runtimeResolved(styleCompileSourceRef(), 'partial');
  if (entry.execution.identityKind === 'learning-run') {
    return pending('learning-assets-contract-not-indexed', 'learning-assets-ref-v1');
  }
  if (entry.route.taskKind === 'memory_consolidation' || entry.route.taskKind === 'rolling_summary') {
    return entry.contracts.taskSourceProof;
  }
  if (isOneOf(entry.route.taskKind, REAL_MAINTENANCE_TASK_KINDS)) {
    return runtimeResolved(sessionSnapshotRef(), 'partial', [databaseSnapshotRef(), memorySchemaRef()]);
  }
  return pending('maintenance-alias-assets-not-indexed', 'maintenance-alias-assets-ref-v1');
}

function withDomainSource(entry: AgentContractDescriptorV1, component: AgentContractComponentRefV1 | null): AgentContractComponentRefV1 | null {
  const source = domainSourceContractFor(entry.profileRef.profileId, entry.route.taskKind, entry.route.phase);
  if (!source || !component || (component.state !== 'indexed' && component.state !== 'runtime-resolved')
    || component.ref === source.sourceRef) return component;
  return Object.freeze({ ...component,
    coverage: source.sourceCoverage === 'partial' ? 'partial' : component.coverage,
    evidenceRefs: Object.freeze([...new Set([...component.evidenceRefs, source.sourceRef])].sort(compareText)),
  });
}

function workspaceFor(entry: AgentContractDescriptorV1): AgentContractBoundaryDescriptorV1['workspace'] {
  if (entry.execution.identityKind === 'unbound') {
    return {
      snapshot: notApplicable(), assets: notApplicable(), proposal: notApplicable(),
      truth: notApplicable(), artifact: notApplicable(), receipt: notApplicable(),
      debugExport: notApplicable(), secondaryWritableTruth: false,
    };
  }
  const snapshot = withDomainSource(entry, baseSnapshotComponent(entry))!;
  const assets = withDomainSource(entry, baseAssetComponent(entry))!;
  let proposal = notApplicable();
  if (isOneOf(entry.route.taskKind, PROPOSAL_STORE_TASK_KINDS)) {
    proposal = slot('required', 'domain-proposal', runtimeResolved(maintenanceProposalStoreRef()));
  } else if (entry.route.taskKind === 'worldbook_repair') {
    proposal = slot('optional', 'domain-committer-only', pending(
      'worldbook-proposal-store-not-indexed', 'worldbook-proposal-store-ref-v1',
    ));
  } else if (entry.profileRef.profileId === 'interactive.variableProposal') {
    proposal = slot('required', 'domain-proposal', pending(
      'interactive-variable-proposal-store-not-indexed',
      'interactive-variable-proposal-store-ref-v1',
    ));
  }
  return {
    snapshot: slot('required', 'read-only', snapshot),
    assets: slot('required', 'read-only', assets),
    proposal,
    truth: slot('required', 'read-only', runtimeResolved(
      sessionSnapshotRef(), 'partial', [databaseSnapshotRef(), memorySchemaRef()],
    )),
    artifact: slot('required', 'process-opaque', runtimeResolved(
      compiledArtifactRef(), 'complete', [isNsfw(entry) ? nsfwHandleRef() : profileAdmissionHandleRef()],
    )),
    receipt: slot(isNsfw(entry) ? 'required' : 'optional', 'receipt-read', runtimeResolved(
      isNsfw(entry) ? nsfwReceiptRef() : promptReceiptRef(), 'complete')),
    debugExport: slot('optional', 'read-only', pending(
      'read-only-debug-export-contract-not-indexed', 'read-only-debug-export-ref-v1',
    )),
    secondaryWritableTruth: false,
  };
}

function environmentFor(entry: AgentContractDescriptorV1): AgentContractBoundaryDescriptorV1['environment'] {
  if (entry.execution.identityKind === 'unbound') {
    return {
      applicationGrantedDirectCapabilities: [],
      modelToolSurface: missing('model-tool-surface-route-unbound'),
      skillExecutionGrant: missing('skill-execution-grant-route-unbound'),
      hostPortSet: missing('host-port-set-route-unbound'),
      providerTransport: missing('provider-transport-route-unbound'),
      isolationGuarantees: [],
      isolationLevel: 'not-applicable',
    };
  }
  if (isNsfw(entry)) return {
    applicationGrantedDirectCapabilities: [],
    modelToolSurface: indexed(nsfwNoModelRef()),
    skillExecutionGrant: runtimeResolved(skillGrantRef(), 'complete'),
    hostPortSet: runtimeResolved(nsfwHostRef(), 'complete'),
    providerTransport: indexed(nsfwNoTransportRef()),
    isolationGuarantees: entry.contracts.hardChecks,
    isolationLevel: 'application-contract-only',
  };
  const toolSurface = modelToolSurfaceFor(entry.profileRef.profileId, entry.route.taskKind);
  const surfaceComponent = toolSurface === null ? pending(
    'execution-variant-tool-surface-not-indexed', 'execution-variant-tool-contract-v1',
  ) : toolSurface.resolution === 'runtime'
    ? runtimeResolved(toolSurface.reference, 'complete', toolSurface.variants.map((variant) => variant.reference))
    : indexed(toolSurface.reference, 'complete', toolSurface.variants.map((variant) => variant.reference));
  return {
    applicationGrantedDirectCapabilities: [],
    modelToolSurface: surfaceComponent,
    skillExecutionGrant: runtimeResolved(skillGrantRef(), 'complete'),
    hostPortSet: runtimeResolved(hostPortSetRef()),
    providerTransport: runtimeResolved(providerTransportRef()),
    isolationGuarantees: entry.contracts.hardChecks,
    isolationLevel: 'application-contract-only',
  };
}

function lifetimeFor(entry: AgentContractDescriptorV1): AgentContractBoundaryDescriptorV1['lifetime'] {
  if (entry.execution.identityKind === 'unbound') {
    return {
      kind: 'unbound', authority: missing('execution-authority-route-unbound'),
      parentTurnContinuation: 'not-applicable', terminationFences: ['route-unbound'],
    };
  }
  if (isAqlReplan(entry)) return {
    kind: 'post-commit-source-window', authority: entry.contracts.taskSourceProof,
    parentTurnContinuation: 'independent-while-current',
    terminationFences: ['source-window-closed', 'source-drift', 'history-rewritten', 'session-closed'],
  };
  if (entry.execution.identityKind === 'foreground-turn') {
    return {
      kind: 'active-turn', authority: runtimeResolved(isNsfw(entry) ? nsfwSourceRef() : turnContextRef(), 'complete'),
      parentTurnContinuation: 'forbidden',
      terminationFences: [
        'run-replaced', 'turn-aborted', 'turn-committed', 'session-closed', 'source-drift',
      ],
    };
  }
  if (entry.profileRef.profileId === 'learning.preference'
    || entry.profileRef.profileId === 'learning.branchPreference') {
    return {
      kind: 'in-flight-learning-source', authority: indexed(entry.profileRef.profileId === 'learning.preference'
        ? learningPreferenceSourceRef() : branchPreferenceSourceRef()),
      parentTurnContinuation: 'forbidden',
      terminationFences: [
        'source-missing', 'inference-finished', 'turn-aborted', 'turn-committed',
        'history-rewritten', 'evidence-drift',
      ],
    };
  }
  if (entry.profileRef.profileId === 'learning.styleCompile') {
    return {
      kind: 'claimed-job-attempt', authority: runtimeResolved(styleCompileSourceRef(), 'partial'),
      parentTurnContinuation: 'independent-while-current',
      terminationFences: ['job-claim-lost', 'job-lease-expired', 'job-cancelled', 'source-drift', 'session-deleted'],
    };
  }
  if (entry.execution.identityKind === 'learning-run') {
    return {
      kind: 'pending', authority: pending(
        'learning-execution-authority-not-indexed', 'learning-execution-authority-ref-v1',
      ),
      parentTurnContinuation: 'not-indexed', terminationFences: ['contract-pending'],
    };
  }
  if (isOneOf(entry.route.taskKind, REAL_MAINTENANCE_TASK_KINDS)) {
    return {
      kind: 'claimed-job-attempt', authority: runtimeResolved(maintenanceClaimRef(), 'complete'),
      parentTurnContinuation: 'independent-while-current',
      terminationFences: [
        'job-terminal', 'cancel-requested', 'lease-expired', 'owner-changed', 'attempt-changed',
        'session-deleted', 'source-drift',
      ],
    };
  }
  return {
    kind: 'pending', authority: pending(
      'maintenance-alias-execution-authority-not-indexed',
      'maintenance-alias-execution-authority-ref-v1',
    ),
    parentTurnContinuation: 'not-indexed', terminationFences: ['contract-pending'],
  };
}

function descriptorFor(entry: AgentContractDescriptorV1): AgentContractBoundaryDescriptorV1 {
  return {
    boundaryVersion: AGENT_CONTRACT_BOUNDARY_DESCRIPTOR_VERSION,
    contractId: entry.contractId,
    contractIndexRevision: SERVER_AGENT_CONTRACT_INDEX.indexRevision,
    identityKind: entry.execution.identityKind,
    workspace: workspaceFor(entry),
    environment: environmentFor(entry),
    lifetime: lifetimeFor(entry),
    authorityEffect: 'none',
    runtimeStateIncluded: false,
  };
}

function buildDescriptors(): readonly AgentContractBoundaryDescriptorV1[] {
  return Object.freeze(SERVER_AGENT_CONTRACT_INDEX.entries.map(descriptorFor));
}

function boundaryComponents(
  entry: AgentContractBoundaryDescriptorV1,
): readonly AgentContractComponentRefV1[] {
  const slots = [
    entry.workspace.snapshot,
    entry.workspace.assets,
    entry.workspace.proposal,
    entry.workspace.truth,
    entry.workspace.artifact,
    entry.workspace.receipt,
    entry.workspace.debugExport,
  ];
  return [
    ...slots.flatMap((item) => item.component === null ? [] : [item.component]),
    entry.environment.modelToolSurface,
    entry.environment.skillExecutionGrant,
    entry.environment.hostPortSet,
    entry.environment.providerTransport,
    ...entry.environment.isolationGuarantees,
    entry.lifetime.authority,
  ];
}

function referenceExists(ref: string): boolean {
  return SERVER_AGENT_BOUNDARY_REFERENCE_REGISTRY.byRef(ref) !== undefined
    || SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY.byRef(ref) !== undefined;
}

/** Reconcile a caller-supplied inventory against current host-code contracts without executing it. */
export function validateServerAgentBoundaryInventory(index: AgentContractBoundaryIndexV1): void {
  const normalized = normalizeAgentContractBoundaryIndex(SERVER_AGENT_CONTRACT_INDEX, index);
  if (normalized.indexVersion !== AGENT_CONTRACT_BOUNDARY_INDEX_VERSION
    || normalized.contractIndexRevision !== SERVER_AGENT_CONTRACT_INDEX.indexRevision
    || normalized.authorityEffect !== 'none' || normalized.runtimeStateIncluded !== false) {
    throw new TypeError('agent-boundary-inventory must remain current and descriptive-only');
  }
  if (createAgentContractBoundaryIndex(SERVER_AGENT_CONTRACT_INDEX, normalized.entries).indexRevision
    !== normalized.indexRevision) {
    throw new TypeError('agent-boundary-inventory revision mismatch');
  }
  for (const entry of normalized.entries) {
    if (entry.environment.applicationGrantedDirectCapabilities.length !== 0) {
      throw new TypeError(`agent-boundary-inventory direct capability drift: ${entry.contractId}`);
    }
    for (const component of boundaryComponents(entry)) {
      if ((component.state === 'indexed' || component.state === 'runtime-resolved')
        && !referenceExists(component.ref)) {
        throw new TypeError(`agent-boundary-inventory dangling reference: ${component.ref}`);
      }
      for (const evidenceRef of component.evidenceRefs) {
        if (!referenceExists(evidenceRef)) {
          throw new TypeError(`agent-boundary-inventory dangling evidence reference: ${evidenceRef}`);
        }
      }
    }
  }
  const expected = createAgentContractBoundaryIndex(SERVER_AGENT_CONTRACT_INDEX, buildDescriptors());
  if (JSON.stringify(normalized.entries) !== JSON.stringify(expected.entries)) {
    throw new TypeError('agent-boundary-inventory mapping mismatch');
  }
}

export function createServerAgentBoundaryInventory(): AgentContractBoundaryIndexV1 {
  const index = createAgentContractBoundaryIndex(SERVER_AGENT_CONTRACT_INDEX, buildDescriptors());
  validateServerAgentBoundaryInventory(index);
  return index;
}

export const SERVER_AGENT_BOUNDARY_INVENTORY = createServerAgentBoundaryInventory();
