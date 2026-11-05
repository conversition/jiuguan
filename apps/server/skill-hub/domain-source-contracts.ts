/** Existing domain contracts only. This static index neither grants authority nor reports rollout state. */
import type { AgentSkillPhase } from '@jiuguan/skill-hub';
import { POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION }
  from '../../../packages/agent-policy/public/interactive-policy.ts';
import type { PreludeSourceManifest } from '../../../packages/harness/public/prelude-source.ts';
import type { PreludeSkillSourceReceiptV1 } from '../../../packages/memory/public/prelude-skill-source.ts';
import { MAINTENANCE_ADMISSION_POLICY_VERSIONS } from '../../../packages/agent-policy/public/maintenance-admission.ts';
import { MAINTENANCE_POLICY_VERSION } from '../maintenance-types.ts';
import type { VariableProposalSkillSourceV1 } from '../../../packages/agent-policy/public/variable-proposal-skill.ts';
import type { ContextCompilerInputManifestV1 } from '../../../packages/agent-policy/public/context-compiler-input.ts';
import type { CriticInputManifestV1 } from '../../../packages/harness/public/critic-input.ts';
import type { CriticSkillSourceReceiptV1 } from '../../../packages/memory/public/critic-skill-source.ts';
import type { ContextCompilerSkillSourceReceiptV1, ContextCompilerSkillSourceReceiptV2, ContextCompilerSkillSourceReceiptV3 } from '../../../packages/memory/public/context-compiler-skill-source.ts';
import type { VariableProposalSkillReceipt } from '../../../packages/memory/public/variable-proposal-skill-receipt.ts';
import type { LearningPreferenceSkillSourcePayload } from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';
import type { BranchPreferenceSkillSourcePayload } from '../../../packages/memory/public/branch-preference-skill-source.ts';
import type { AqlReplanSkillSourceV1 } from '../../../packages/session/public/aql-replan-skill-source.ts';
import type { LearningPreferenceSkillSourceV1 } from '../../../packages/session/public/learning-preference-skill-source.ts';
import type { BranchPreferenceSkillSourceV1 } from '../../../packages/session/public/branch-preference-skill-source.ts';
import type { NsfwSceneSkillSource, NsfwSceneSkillReceipt } from '../../../packages/session/public/nsfw-scene-skill.ts';
import type { AqlReplanSkillSourceReceipt } from '../aql-replan-skill-source.ts';
import type { StyleCompileSkillSourceReceipt } from '../style-compile-skill-source.ts';
import type { StyleCompileSkillSourceSnapshotV1 } from './style-compile-context.ts';
import type { MaintenanceMemorySkillSourceV1 } from './maintenance-memory-context.ts';
import type { MaintenanceMemorySkillProposalProof } from './maintenance-memory-proposal-proof.ts';
import type { MaintenanceSummarySkillSourceV1 } from './maintenance-summary-context.ts';
import type { MaintenanceSummarySkillProposalProof } from './maintenance-summary-proposal-proof.ts';
import type { MaintenanceArcSkillSourceV1 } from './maintenance-arc-context.ts';
import type { MaintenanceArcSkillProposalProof } from './maintenance-arc-proposal-proof.ts';
import type { MaintenanceNpcSkillSourceV1 } from './maintenance-npc-context.ts';
import type { MaintenanceNpcSkillResultProof } from './maintenance-npc-result-proof.ts';
import type { MaintenanceWorldbookSkillSourceV1 } from './maintenance-worldbook-context.ts';
import type { MaintenanceWorldbookSkillProposalProof } from './maintenance-worldbook-proposal-proof.ts';

export const SERVER_DOMAIN_SOURCE_CONTRACTS_VERSION = 'server-domain-source-contracts-v4' as const;

/** Closed host-wiring decisions; an owner relationship never lends its independent proof. */
export interface ServerDomainSourceDisposition {
  readonly profileId: string;
  readonly taskKind: string;
  readonly phase: AgentSkillPhase;
  readonly kind: 'shared-owner-variant' | 'registered-without-caller';
  readonly independentSource: 'not-applicable';
  readonly ownerProfileId: string | null;
  readonly ownerTaskKind: string | null;
  readonly ownerPhase: AgentSkillPhase | null;
}
export const SERVER_DOMAIN_SOURCE_DISPOSITIONS: readonly ServerDomainSourceDisposition[] = Object.freeze([
  Object.freeze({ profileId: 'interactive.director', taskKind: 'interactive_prelude', phase: 'plan',
    kind: 'shared-owner-variant', independentSource: 'not-applicable',
    ownerProfileId: 'interactive.prelude', ownerTaskKind: 'interactive_prelude', ownerPhase: 'plan' }),
  Object.freeze({ profileId: 'maintenance.branchIndex', taskKind: 'branch_index', phase: 'execute',
    kind: 'shared-owner-variant', independentSource: 'not-applicable',
    ownerProfileId: 'maintenance.arc', ownerTaskKind: 'branch_index', ownerPhase: 'execute' }),
  Object.freeze({ profileId: 'maintenance.arc', taskKind: 'arc_maintenance', phase: 'execute',
    kind: 'registered-without-caller', independentSource: 'not-applicable',
    ownerProfileId: null, ownerTaskKind: null, ownerPhase: null }),
  Object.freeze({ profileId: 'maintenance.npc', taskKind: 'npc_maintenance', phase: 'execute',
    kind: 'registered-without-caller', independentSource: 'not-applicable',
    ownerProfileId: null, ownerTaskKind: null, ownerPhase: null }),
]);
export function domainSourceDispositionFor(profileId: string, taskKind: string, phase: string):
ServerDomainSourceDisposition | null {
  return SERVER_DOMAIN_SOURCE_DISPOSITIONS.find(entry => entry.profileId === profileId
    && entry.taskKind === taskKind && entry.phase === phase) ?? null;
}

export type DomainEvidenceMeaning =
  | 'proposal-request-proof'
  | 'proposal-or-noop-request-proof'
  | 'advisory-request-receipt'
  | 'candidate-request-receipt'
  | 'inferred-low-event-source'
  | 'semantic-low-event-source'
  | 'proposal-version-source'
  | 'accepted-capsule-source-receipt'
  | 'accepted-revision-source-receipt'
  | 'accepted-series-source-receipt'
  | 'accepted-turn-skill-receipt';

export interface ServerDomainSourceContract {
  readonly profileId: string;
  readonly taskKind: string;
  readonly phase: AgentSkillPhase;
  readonly sourceVersion: string;
  readonly evidenceVersion: string;
  readonly sourceRef: string;
  readonly evidenceRef: string;
  /** Empty only for the deterministic NSFW host: it accepts no model policy. */
  readonly policyVersions: readonly string[];
  /** A closed live-policy variant cannot establish coverage for every historical route policy. */
  readonly sourceCoverage: 'complete' | 'partial';
  /** Native provenance is never an independent quality or general consumption assertion. */
  readonly evidenceCoverage: 'partial';
  readonly evidenceMeaning: DomainEvidenceMeaning;
}

const MAINTENANCE_POLICIES = Object.freeze([MAINTENANCE_POLICY_VERSION, ...MAINTENANCE_ADMISSION_POLICY_VERSIONS]);

// Literal formats absent a runtime constant remain checked against their actual exported contract types.
// Type-only imports avoid constructing Session, opening a Store or reading runtime configuration.
const MEMORY_SOURCE = 'maintenance-memory-skill-source-v1' satisfies MaintenanceMemorySkillSourceV1['sourceVersion'];
const MEMORY_PROOF = 'maintenance-memory-skill-proposal-v1' satisfies MaintenanceMemorySkillProposalProof['proofVersion'];
const SUMMARY_SOURCE = 'maintenance-summary-skill-source-v1' satisfies MaintenanceSummarySkillSourceV1['sourceVersion'];
const SUMMARY_PROOF = 'maintenance-summary-skill-proposal-v1' satisfies MaintenanceSummarySkillProposalProof['proofVersion'];
const NSFW_SOURCE = 'nsfw-scene-skill-source-v1' satisfies NsfwSceneSkillSource['sourceVersion'];
const NSFW_RECEIPT = 'nsfw-scene-skill-receipt-v1' satisfies NsfwSceneSkillReceipt['version'];
const AQL_SOURCE = 'session-aql-replan-skill-source-v1' satisfies AqlReplanSkillSourceV1['sourceVersion'];
const AQL_RECEIPT = 'aql-replan-skill-source-receipt-v1' satisfies AqlReplanSkillSourceReceipt['version'];
const AQL_POLICY = 'p14-q9r-aql-replan-interactive-v1' satisfies AqlReplanSkillSourceV1['policyVersion'];
const VARIABLE_SOURCE = 'variable-proposal-skill-source-v1' satisfies VariableProposalSkillSourceV1['sourceVersion'];
const VARIABLE_RECEIPT = 'variable-proposal-skill-receipt-v1' satisfies VariableProposalSkillReceipt['version'];
const VARIABLE_POLICY = 'p17-variable-proposal-v1' satisfies VariableProposalSkillSourceV1['policyVersion'];
const PREFERENCE_SOURCE = 'session-learning-preference-skill-source-v1' satisfies LearningPreferenceSkillSourceV1['sourceVersion'];
const PREFERENCE_RECEIPT = 'learning-preference-skill-source-v1' satisfies LearningPreferenceSkillSourcePayload['version'];
const PREFERENCE_POLICY = 'p14-q6-preference-v1' satisfies LearningPreferenceSkillSourceV1['policyVersion'];
const BRANCH_SOURCE = 'session-branch-preference-skill-source-v1' satisfies BranchPreferenceSkillSourceV1['sourceVersion'];
const BRANCH_RECEIPT = 'branch-preference-skill-source-v1' satisfies BranchPreferenceSkillSourcePayload['version'];
const BRANCH_POLICY = 'p14-q6-branch-semantic-v1' satisfies BranchPreferenceSkillSourceV1['policyVersion'];
const STYLE_SOURCE = 'style-compile-skill-source-v1' satisfies StyleCompileSkillSourceSnapshotV1['sourceVersion'];
const STYLE_RECEIPT = 'style-compile-skill-source-receipt-v1' satisfies StyleCompileSkillSourceReceipt['version'];
const STYLE_POLICY = 'p14-q7-style-compiler-v1' satisfies StyleCompileSkillSourceSnapshotV1['policyVersion'];
const ARC_SOURCE = 'maintenance-arc-skill-source-v1' satisfies MaintenanceArcSkillSourceV1['sourceVersion'];
const ARC_PROOF = 'maintenance-arc-skill-proposal-v1' satisfies MaintenanceArcSkillProposalProof['proofVersion'];
const NPC_SOURCE = 'maintenance-npc-skill-source-v1' satisfies MaintenanceNpcSkillSourceV1['sourceVersion'];
const NPC_PROOF = 'maintenance-npc-skill-result-v1' satisfies MaintenanceNpcSkillResultProof['proofVersion'];
const WORLDBOOK_SOURCE = 'maintenance-worldbook-skill-source-v1' satisfies MaintenanceWorldbookSkillSourceV1['sourceVersion'];
const WORLDBOOK_PROOF = 'maintenance-worldbook-skill-proposal-v1' satisfies MaintenanceWorldbookSkillProposalProof['proofVersion'];
const CONTEXT_SOURCE = 'context-compiler-input-v1' satisfies ContextCompilerInputManifestV1['inputVersion'];
const CONTEXT_RECEIPT = 'context-compiler-skill-source-receipt-v1' satisfies ContextCompilerSkillSourceReceiptV1['version'];
const CONTEXT_POLICY = 'p14-q9r-context-compiler-v1' satisfies ContextCompilerSkillSourceReceiptV1['policyVersion'];
const CONTEXT_RECEIPT_V2 = 'context-compiler-skill-source-receipt-v2' satisfies ContextCompilerSkillSourceReceiptV2['version'];
const CONTEXT_POLICY_V2 = 'p14-q9r-context-compiler-v2' satisfies ContextCompilerSkillSourceReceiptV2['policyVersion'];
const CONTEXT_RECEIPT_V3 = 'context-compiler-skill-source-receipt-v3' satisfies ContextCompilerSkillSourceReceiptV3['version'];
const CRITIC_SOURCE = 'critic-input-v1' satisfies CriticInputManifestV1['inputVersion'];
const CRITIC_RECEIPT = 'critic-skill-source-receipt-v1' satisfies CriticSkillSourceReceiptV1['version'];
const CRITIC_POLICY = 'p14-precommit-critic-v2' satisfies CriticSkillSourceReceiptV1['policyVersion'];
const PRELUDE_SOURCE = 'prelude-source-v1' satisfies PreludeSourceManifest['sourceVersion'];
const PRELUDE_RECEIPT = 'prelude-skill-source-receipt-v1' satisfies PreludeSkillSourceReceiptV1['version'];

function contract(profileId: string, taskKind: string, phase: AgentSkillPhase,
  sourceVersion: string, evidenceVersion: string, policyVersions: readonly string[],
  evidenceMeaning: DomainEvidenceMeaning, legacyRefs = false): ServerDomainSourceContract {
  const key = legacyRefs ? taskKind : `${profileId}.${taskKind}.${phase}`;
  return Object.freeze({ profileId, taskKind, phase, sourceVersion, evidenceVersion,
    sourceRef: `ref.task-source.${key}.${sourceVersion}`,
    evidenceRef: `ref.evidence.${key}.${evidenceVersion}`,
    policyVersions: Object.freeze([...policyVersions]),
    sourceCoverage: policyVersions.length === 0 ? 'complete' : 'partial',
    evidenceCoverage: 'partial', evidenceMeaning });
}

/** Fourteen independent source variants; shared-owner variants and registered-only aliases are separate. */
export const SERVER_DOMAIN_SOURCE_CONTRACTS: readonly ServerDomainSourceContract[] = Object.freeze([
  contract('maintenance.memory', 'memory_consolidation', 'execute', MEMORY_SOURCE, MEMORY_PROOF,
    MAINTENANCE_POLICIES, 'proposal-request-proof', true),
  contract('maintenance.memory', 'rolling_summary', 'execute', SUMMARY_SOURCE, SUMMARY_PROOF,
    MAINTENANCE_POLICIES, 'proposal-request-proof', true),
  contract('maintenance.nsfwScene', 'nsfw_scene_curator', 'plan', NSFW_SOURCE, NSFW_RECEIPT,
    [], 'accepted-turn-skill-receipt', true),
  contract('interactive.aqlReplan', 'aql_replan', 'plan', AQL_SOURCE, AQL_RECEIPT,
    [AQL_POLICY], 'advisory-request-receipt'),
  contract('interactive.variableProposal', 'interactive_prelude', 'execute', VARIABLE_SOURCE, VARIABLE_RECEIPT,
    [VARIABLE_POLICY], 'candidate-request-receipt'),
  contract('learning.preference', 'preference_extract', 'learn', PREFERENCE_SOURCE, PREFERENCE_RECEIPT,
    [PREFERENCE_POLICY], 'inferred-low-event-source'),
  contract('learning.branchPreference', 'preference_extract', 'learn', BRANCH_SOURCE, BRANCH_RECEIPT,
    [BRANCH_POLICY], 'semantic-low-event-source'),
  contract('learning.styleCompile', 'style_compile', 'learn', STYLE_SOURCE, STYLE_RECEIPT,
    [STYLE_POLICY], 'proposal-version-source'),
  contract('maintenance.arc', 'branch_index', 'execute', ARC_SOURCE, ARC_PROOF,
    MAINTENANCE_POLICIES, 'proposal-request-proof'),
  contract('maintenance.npc', 'npc_state', 'execute', NPC_SOURCE, NPC_PROOF,
    MAINTENANCE_POLICIES, 'proposal-or-noop-request-proof'),
  contract('maintenance.worldbook', 'worldbook_repair', 'execute', WORLDBOOK_SOURCE, WORLDBOOK_PROOF,
    MAINTENANCE_POLICIES, 'proposal-request-proof'),
  contract('context.compiler', 'context_compiler', 'plan', CONTEXT_SOURCE, CONTEXT_RECEIPT,
    [CONTEXT_POLICY], 'accepted-capsule-source-receipt'),
  contract('context.compiler', 'context_compiler', 'plan', CONTEXT_SOURCE, CONTEXT_RECEIPT_V2,
    [CONTEXT_POLICY_V2], 'accepted-capsule-source-receipt'),
  contract('context.compiler', 'context_compiler', 'plan', CONTEXT_SOURCE, CONTEXT_RECEIPT_V3,
    [CONTEXT_POLICY_V2], 'accepted-capsule-source-receipt'),
  contract('interactive.critic', 'critic_revision', 'validate', CRITIC_SOURCE, CRITIC_RECEIPT,
    [CRITIC_POLICY], 'accepted-revision-source-receipt'),
  contract('interactive.prelude', 'interactive_prelude', 'plan', PRELUDE_SOURCE, PRELUDE_RECEIPT,
    [POLICY_ROUTER_VERSION, POLICY_ROUTER_LEGACY_VERSION, DIRECTOR_CRITIC_SHADOW_VERSION],
    'accepted-series-source-receipt'),
]);

/** Optional policy narrows an exact static route; there is deliberately no task-only fallback. */
export function domainSourceContractFor(profileId: string, taskKind: string, phase: string,
  policyVersion?: string, evidenceVersion?: string): ServerDomainSourceContract | null {
  const found = SERVER_DOMAIN_SOURCE_CONTRACTS.find(entry => entry.profileId === profileId
    && entry.taskKind === taskKind && entry.phase === phase
    && (policyVersion === undefined || entry.policyVersions.includes(policyVersion))
    && (evidenceVersion === undefined || entry.evidenceVersion === evidenceVersion));
  if (!found) return null;
  return found;
}
