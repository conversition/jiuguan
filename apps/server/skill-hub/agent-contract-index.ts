/**
 * HC-1 read-only Agent contract index.
 *
 * This module is deliberately not exported from the production SkillHub barrel. Importing it
 * constructs no Lease, reads no environment/DB/file, performs no Provider call and changes no
 * rollout state. It only reconciles existing host-code contracts into a frozen derived view.
 */
import {
  ADMISSION_TICKET_VERSION,
  AGENT_CONTRACT_DESCRIPTOR_VERSION,
  AGENT_CONTRACT_INDEX_VERSION,
  AGENT_SKILL_CONSUMER_PROFILES,
  AGENT_TASK_KINDS,
  createAgentContractIndex,
  type AgentContractComponentRefV1,
  type AgentContractDescriptorV1,
  type AgentContractIdentityKind,
  type AgentContractIndexV1,
  type AgentSkillConsumerProfileV1,
} from '../../../packages/agent-policy/public/agent-skill-contract-index.ts';
import {
  BRANCH_SEMANTIC_NORMALIZATION_VERSION,
  LEARNED_STYLE_OUTPUT_VALIDATOR_VERSION,
  PRECOMMIT_CRITIC_VERSION,
  STYLE_EVALUATOR_VERSION,
  TYPED_PREFERENCE_OUTPUT_VERSION,
} from '../../../packages/agent-policy/public/agent-model-contracts.ts';
import { AQL_REPLAN_INPUT_VERSION } from '../../../packages/agent-policy/public/aql-replan-input.ts';
import { CONTEXT_COMPILER_INPUT_VERSION } from '../../../packages/agent-policy/public/context-compiler-input.ts';
import { CRITIC_INPUT_VERSION } from '../../../packages/harness/public/critic-input.ts';
import { AQL_REPLAN_OUTPUT_VERSION } from '../../../packages/agent-policy/public/aql-replan-output.ts';
import { AQL_REPLAN_REQUEST_VERSION } from '../../../packages/agent-policy/public/aql-replan-request.ts';
import { CRITIC_OUTPUT_CONTRACT_VERSION } from '../../../packages/session/public/critic-output-contract.ts';
import { PRELUDE_SOURCE_VERSION } from '../../../packages/harness/public/prelude-source.ts';
import {
  AGENT_CLOSURE_CAPABILITIES,
  AGENT_CLOSURE_CONTRACT_VERSION,
  canonicalAgentClosureCapability,
  type AgentClosureCapability,
} from '../../../packages/agent-closure/index.ts';
import {
  CONTEXT_CAPSULE_VERSION,
  CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
  INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
  INTERACTIVE_PRELUDE_OUTPUT_VALIDATOR_VERSION,
  INTERACTIVE_DIRECTOR_OUTPUT_VALIDATOR_VERSION,
  INTERACTIVE_VARIABLE_OUTPUT_VALIDATOR_VERSION,
  LEARNING_MODEL_CONTRACT_VERSION,
  PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
} from '../../../packages/harness/public/agent-model-contracts.ts';
import { AGENT_SKILL_PROGRAM_VERSION } from '@jiuguan/skill-hub';
import {
  MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION,
  MAINTENANCE_HOST_INSTRUCTION_VERSION,
  MAINTENANCE_OUTPUT_VALIDATOR_VERSION,
  MAINTENANCE_REPAIR_INSTRUCTION_VERSION,
  MAINTENANCE_SESSION_INPUT_VERSION,
  MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION,
} from '../maintenance-model-contract.ts';
import { createServerBuiltinAgentSkillPack } from './builtin-source-pack.ts';
import { SERVER_DOMAIN_SOURCE_CONTRACTS, SERVER_DOMAIN_SOURCE_DISPOSITIONS,
  domainSourceContractFor, domainSourceDispositionFor } from './domain-source-contracts.ts';
import { SERVER_AGENT_SKILL_PROFILE_ADMISSION_VERSION } from './profile-admission-service.ts';
import { SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION } from './profile-policy-registry.ts';
import { SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION } from './source-authority-registry.ts';
import { createRpScenarioHc1Index } from '../agent-loop-rp-scenario-template.ts';
import { NSFW_SCENE_SKILL_SOURCE_VERSION, NSFW_SCENE_SKILL_RECEIPT_VERSION }
  from '../../../packages/session/public/nsfw-scene-skill.ts';
import { NSFW_SCENE_SKILL_HOST_VERSION } from './nsfw-scene-host.ts';
import { NSFW_SCENE_RECEIPT_READER_VERSION } from '../../../packages/session/public/nsfw-scene-receipt-reader.ts';

export const SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY_VERSION = 'server-agent-contract-reference-registry-v12' as const;

export interface ServerAgentContractReferenceV1 {
  readonly ref: string;
  readonly targetKind:
    | 'instruction-selection'
    | 'profile-policy'
    | 'source-authority'
    | 'hard-check'
    | 'host-instruction'
    | 'input-validator'
    | 'output-validator'
    | 'outcome-evaluator'
    | 'task-source-proof'
    | 'closure-outcome'
    | 'evidence-stream'
    | 'evidence-reader';
  readonly contractVersion: string;
  readonly resolution: 'static' | 'runtime';
}

export interface ServerAgentContractReferenceRegistryV1 {
  readonly registryVersion: typeof SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY_VERSION;
  readonly entries: readonly ServerAgentContractReferenceV1[];
  byRef(ref: string): ServerAgentContractReferenceV1 | undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indexed(
  ref: string,
  coverage: 'complete' | 'partial' = 'complete',
  evidenceRefs: readonly string[] = [],
):
AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'indexed', coverage, ref,
    evidenceRefs: Object.freeze([...evidenceRefs].sort(compareText)),
  });
}

function runtimeResolved(
  ref: string,
  coverage: 'complete' | 'partial' = 'partial',
  evidenceRefs: readonly string[] = [],
):
AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'runtime-resolved', coverage, ref,
    evidenceRefs: Object.freeze([...evidenceRefs].sort(compareText)),
  });
}

function missing(reasonCode: string): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'missing', coverage: 'missing', reasonCode, evidenceRefs: Object.freeze([]),
  });
}

function pending(reasonCode: string, nextContract: string): AgentContractComponentRefV1 {
  return Object.freeze({
    state: 'pending', coverage: 'missing', reasonCode, nextContract,
    evidenceRefs: Object.freeze([]),
  });
}

function instructionRef(): string {
  return `ref.skill-program.instruction-set.${AGENT_SKILL_PROGRAM_VERSION}`;
}

function policyRef(profileId: string): string {
  return `ref.profile-policy.${profileId}.${SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION}`;
}

function skillSourceAuthorityRef(): string {
  return `ref.skill-source-authority.${SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION}`;
}

function ticketHardCheckRef(): string {
  return `ref.hard-check.admission-ticket.${ADMISSION_TICKET_VERSION}`;
}

function profileAdmissionHardCheckRef(): string {
  return `ref.hard-check.profile-admission.${SERVER_AGENT_SKILL_PROFILE_ADMISSION_VERSION}`;
}

function sourceAuthorityHardCheckRef(): string {
  return `ref.hard-check.source-authority.${SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION}`;
}

function nsfwHostHardCheckRef(): string {
  return `ref.hard-check.host-guarded-nsfw.${NSFW_SCENE_SKILL_HOST_VERSION}`;
}

function nsfwReceiptReaderRef(): string {
  return `ref.evidence-reader.nsfw-scene.${NSFW_SCENE_RECEIPT_READER_VERSION}`;
}

function deterministicNsfwRoute(profile: AgentSkillConsumerProfileV1, taskKind: string): boolean {
  return profile.profileId === 'maintenance.nsfwScene' && taskKind === 'nsfw_scene_curator';
}

function closureRef(logical: string, canonical: string): string {
  return 'ref.closure.' + logical + '.' + canonical + '.' + AGENT_CLOSURE_CONTRACT_VERSION;
}

type SemanticReferenceKind =
  | 'host-instruction'
  | 'input-validator'
  | 'output-validator'
  | 'outcome-evaluator';

function semanticRef(kind: SemanticReferenceKind, contractKey: string, version: string): string {
  return 'ref.' + kind + '.' + contractKey + '.' + version;
}

const MAINTENANCE_HOST_COMPONENT_REFS = Object.freeze([
  semanticRef(
    'host-instruction', 'maintenance-repair', MAINTENANCE_REPAIR_INSTRUCTION_VERSION,
  ),
  semanticRef(
    'host-instruction', 'maintenance-snapshot', MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION,
  ),
  semanticRef(
    'host-instruction', 'maintenance-system', MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION,
  ),
].sort(compareText));

const REAL_MAINTENANCE_TASK_KINDS = Object.freeze([
  'memory_consolidation',
  'branch_index',
  'rolling_summary',
  'npc_state',
  'worldbook_repair',
] as const);
type RealMaintenanceTaskKind = typeof REAL_MAINTENANCE_TASK_KINDS[number];

function isRealMaintenanceTaskKind(taskKind: string): taskKind is RealMaintenanceTaskKind {
  return (REAL_MAINTENANCE_TASK_KINDS as readonly string[]).includes(taskKind);
}

function learningContractKey(profileId: string): string | null {
  if (profileId === 'learning.preference') return 'learning-preference';
  if (profileId === 'learning.branchPreference') return 'learning-branch-preference';
  if (profileId === 'learning.styleCompile') return 'learning-style-compile';
  return null;
}

function interactiveOutputContract(profileId: string): readonly [string, string] {
  if (profileId === 'interactive.director') {
    return ['interactive-director', INTERACTIVE_DIRECTOR_OUTPUT_VALIDATOR_VERSION];
  }
  if (profileId === 'interactive.variableProposal') {
    return ['interactive-variable', INTERACTIVE_VARIABLE_OUTPUT_VALIDATOR_VERSION];
  }
  if (profileId === 'interactive.prelude') {
    return ['interactive-prelude', INTERACTIVE_PRELUDE_OUTPUT_VALIDATOR_VERSION];
  }
  throw new TypeError('interactive output contract profile missing: ' + profileId);
}

function semanticComponentRefs(
  profile: AgentSkillConsumerProfileV1,
  taskKind: string,
): Readonly<{
  hostInstruction: AgentContractComponentRefV1;
  inputValidator: AgentContractComponentRefV1;
  outputValidator: AgentContractComponentRefV1;
  outcomeEvaluator: AgentContractComponentRefV1;
}> {
  if (!hasRuntimeCaller(profile, taskKind)) {
    return Object.freeze({
      hostInstruction: missing('host-instruction-route-unbound'),
      inputValidator: missing('domain-input-validator-route-unbound'),
      outputValidator: missing('domain-output-validator-route-unbound'),
      outcomeEvaluator: missing('outcome-quality-evaluator-route-unbound'),
    });
  }
  const unresolved = Object.freeze({
    hostInstruction: pending(
      'host-instruction-contract-not-indexed',
      'host-instruction-ref-v1',
    ),
    inputValidator: pending(
      'domain-input-validator-ref-not-versioned',
      'domain-input-validator-ref-v1',
    ),
    outputValidator: pending(
      'domain-output-validator-ref-not-versioned',
      'domain-output-validator-ref-v1',
    ),
    outcomeEvaluator: pending(
      'outcome-quality-evaluator-not-indexed',
      'outcome-quality-evaluator-ref-v1',
    ),
  });
  if (deterministicNsfwRoute(profile, taskKind)) {
    return Object.freeze({
      hostInstruction: runtimeResolved(semanticRef('host-instruction', 'nsfw-scene', NSFW_SCENE_SKILL_HOST_VERSION), 'complete'),
      inputValidator: indexed(semanticRef('input-validator', 'nsfw-scene', NSFW_SCENE_SKILL_SOURCE_VERSION)),
      outputValidator: indexed(semanticRef('output-validator', 'nsfw-scene', NSFW_SCENE_SKILL_RECEIPT_VERSION)),
      outcomeEvaluator: unresolved.outcomeEvaluator,
    });
  }
  if (taskKind === 'interactive_prelude') {
    const [outputKey, outputVersion] = interactiveOutputContract(profile.profileId);
    return Object.freeze({
      hostInstruction: runtimeResolved(semanticRef(
        'host-instruction',
        'interactive-prelude',
        INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
      ), 'complete'),
      inputValidator: indexed(semanticRef(
        'input-validator',
        'interactive-prelude',
        profile.profileId === 'interactive.prelude' ? PRELUDE_SOURCE_VERSION : INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
      ), 'partial'),
      outputValidator: indexed(semanticRef('output-validator', outputKey, outputVersion)),
      outcomeEvaluator: unresolved.outcomeEvaluator,
    });
  }
  if (taskKind === 'critic_revision') {
    return Object.freeze({
      hostInstruction: indexed(semanticRef(
        'host-instruction',
        'critic-revision',
        PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
      )),
      inputValidator: indexed(semanticRef(
        'input-validator',
        'critic-revision',
        CRITIC_INPUT_VERSION,
      ), 'partial'),
      outputValidator: indexed(semanticRef('output-validator', 'critic-revision', CRITIC_OUTPUT_CONTRACT_VERSION)),
      outcomeEvaluator: indexed(semanticRef(
        'outcome-evaluator',
        'critic-revision',
        PRECOMMIT_CRITIC_VERSION,
      )),
    });
  }
  if (taskKind === 'aql_replan') {
    return Object.freeze({
      ...unresolved,
      hostInstruction: runtimeResolved(
        semanticRef('host-instruction', 'aql-replan', AQL_REPLAN_REQUEST_VERSION),
        'complete',
      ),
      inputValidator: indexed(semanticRef('input-validator', 'aql-replan', AQL_REPLAN_INPUT_VERSION)),
      outputValidator: indexed(semanticRef('output-validator', 'aql-replan', AQL_REPLAN_OUTPUT_VERSION)),
    });
  }
  if (taskKind === 'context_compiler') {
    return Object.freeze({
      hostInstruction: indexed(semanticRef(
        'host-instruction',
        'context-compiler',
        CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
      )),
      inputValidator: indexed(semanticRef(
        'input-validator',
        'context-compiler',
        CONTEXT_COMPILER_INPUT_VERSION,
      )),
      outputValidator: indexed(semanticRef(
        'output-validator',
        'context-compiler',
        CONTEXT_CAPSULE_VERSION,
      )),
      outcomeEvaluator: unresolved.outcomeEvaluator,
    });
  }
  const learningKey = learningContractKey(profile.profileId);
  if (learningKey) {
    const outputVersion = profile.profileId === 'learning.preference'
      ? TYPED_PREFERENCE_OUTPUT_VERSION
      : profile.profileId === 'learning.branchPreference'
        ? BRANCH_SEMANTIC_NORMALIZATION_VERSION
        : LEARNED_STYLE_OUTPUT_VALIDATOR_VERSION;
    return Object.freeze({
      hostInstruction: indexed(semanticRef(
        'host-instruction',
        learningKey,
        LEARNING_MODEL_CONTRACT_VERSION,
      )),
      inputValidator: indexed(semanticRef(
        'input-validator',
        learningKey,
        LEARNING_MODEL_CONTRACT_VERSION,
      )),
      outputValidator: indexed(semanticRef(
        'output-validator',
        learningKey,
        outputVersion,
      )),
      outcomeEvaluator: profile.profileId === 'learning.styleCompile'
        ? indexed(semanticRef(
            'outcome-evaluator',
            learningKey,
            STYLE_EVALUATOR_VERSION,
          ))
        : unresolved.outcomeEvaluator,
    });
  }
  if (isRealMaintenanceTaskKind(taskKind)) {
    const key = 'maintenance-' + taskKind;
    return Object.freeze({
      hostInstruction: runtimeResolved(semanticRef(
        'host-instruction',
        key,
        MAINTENANCE_HOST_INSTRUCTION_VERSION,
      ), taskKind === 'rolling_summary' ? 'partial' : 'complete',
      MAINTENANCE_HOST_COMPONENT_REFS),
      // Snapshot assembly bounds and binds Provider-visible inputs, while
      // upstream domain readers remain separate authorities.
      inputValidator: indexed(semanticRef(
        'input-validator',
        key,
        MAINTENANCE_SESSION_INPUT_VERSION,
      ), 'partial'),
      outputValidator: indexed(semanticRef(
        'output-validator',
        key,
        MAINTENANCE_OUTPUT_VALIDATOR_VERSION,
      )),
      outcomeEvaluator: unresolved.outcomeEvaluator,
    });
  }
  return unresolved;
}

function logicalOutcomeCapability(profile: AgentSkillConsumerProfileV1, taskKind: string):
AgentClosureCapability {
  const candidate = taskKind === 'rolling_summary' ? 'maintenance.summary' : profile.capabilityId;
  if (!(AGENT_CLOSURE_CAPABILITIES as readonly string[]).includes(candidate)) {
    throw new TypeError(`agent-contract-index closure capability missing: ${candidate}`);
  }
  return candidate as AgentClosureCapability;
}

function buildReferenceRegistry(): ServerAgentContractReferenceRegistryV1 {
  const rows: ServerAgentContractReferenceV1[] = [
    {
      ref: instructionRef(), targetKind: 'instruction-selection',
      contractVersion: AGENT_SKILL_PROGRAM_VERSION, resolution: 'runtime',
    },
    {
      ref: skillSourceAuthorityRef(), targetKind: 'source-authority',
      contractVersion: SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION, resolution: 'runtime',
    },
    {
      ref: ticketHardCheckRef(), targetKind: 'hard-check',
      contractVersion: ADMISSION_TICKET_VERSION, resolution: 'static',
    },
    {
      ref: profileAdmissionHardCheckRef(), targetKind: 'hard-check',
      contractVersion: SERVER_AGENT_SKILL_PROFILE_ADMISSION_VERSION, resolution: 'static',
    },
    {
      ref: sourceAuthorityHardCheckRef(), targetKind: 'hard-check',
      contractVersion: SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION, resolution: 'static',
    },
    { ref: nsfwHostHardCheckRef(), targetKind: 'hard-check',
      contractVersion: NSFW_SCENE_SKILL_HOST_VERSION, resolution: 'static' },
    { ref: nsfwReceiptReaderRef(), targetKind: 'evidence-reader',
      contractVersion: NSFW_SCENE_RECEIPT_READER_VERSION, resolution: 'static' },
  ];
  const addSemantic = (
    targetKind: SemanticReferenceKind,
    contractKey: string,
    contractVersion: string,
    resolution: ServerAgentContractReferenceV1['resolution'] = 'static',
  ) => {
    rows.push({
      ref: semanticRef(targetKind, contractKey, contractVersion),
      targetKind,
      contractVersion,
      resolution,
    });
  };
  addSemantic('host-instruction', 'nsfw-scene', NSFW_SCENE_SKILL_HOST_VERSION, 'runtime');
  addSemantic('input-validator', 'nsfw-scene', NSFW_SCENE_SKILL_SOURCE_VERSION);
  addSemantic('output-validator', 'nsfw-scene', NSFW_SCENE_SKILL_RECEIPT_VERSION);
  addSemantic(
    'host-instruction',
    'interactive-prelude',
    INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
    'runtime',
  );
  addSemantic(
    'input-validator',
    'interactive-prelude',
    INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
  );
  addSemantic('input-validator', 'interactive-prelude', PRELUDE_SOURCE_VERSION);
  for (const profileId of ['interactive.prelude', 'interactive.director', 'interactive.variableProposal']) {
    const [key, version] = interactiveOutputContract(profileId);
    addSemantic('output-validator', key, version);
  }
  addSemantic('output-validator', 'critic-revision', CRITIC_OUTPUT_CONTRACT_VERSION);
  addSemantic('input-validator', 'aql-replan', AQL_REPLAN_INPUT_VERSION);
  addSemantic('output-validator', 'aql-replan', AQL_REPLAN_OUTPUT_VERSION);
  addSemantic('host-instruction', 'aql-replan', AQL_REPLAN_REQUEST_VERSION, 'runtime');
  addSemantic(
    'host-instruction',
    'critic-revision',
    PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
  );
  addSemantic(
    'input-validator',
    'critic-revision',
    PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
  );
  addSemantic('outcome-evaluator', 'critic-revision', PRECOMMIT_CRITIC_VERSION);
  addSemantic('input-validator', 'critic-revision', CRITIC_INPUT_VERSION);
  addSemantic(
    'host-instruction',
    'context-compiler',
    CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
  );
  addSemantic(
    'input-validator',
    'context-compiler',
    CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
  );
  addSemantic('input-validator', 'context-compiler', CONTEXT_COMPILER_INPUT_VERSION);
  addSemantic('output-validator', 'context-compiler', CONTEXT_CAPSULE_VERSION);
  for (const [contractKey, outputVersion] of [
    ['learning-preference', TYPED_PREFERENCE_OUTPUT_VERSION],
    ['learning-branch-preference', BRANCH_SEMANTIC_NORMALIZATION_VERSION],
    ['learning-style-compile', LEARNED_STYLE_OUTPUT_VALIDATOR_VERSION],
  ] as const) {
    addSemantic('host-instruction', contractKey, LEARNING_MODEL_CONTRACT_VERSION);
    addSemantic('input-validator', contractKey, LEARNING_MODEL_CONTRACT_VERSION);
    addSemantic('output-validator', contractKey, outputVersion);
  }
  addSemantic('outcome-evaluator', 'learning-style-compile', STYLE_EVALUATOR_VERSION);
  addSemantic(
    'host-instruction',
    'maintenance-system',
    MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION,
  );
  addSemantic(
    'host-instruction',
    'maintenance-snapshot',
    MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION,
  );
  addSemantic(
    'host-instruction',
    'maintenance-repair',
    MAINTENANCE_REPAIR_INSTRUCTION_VERSION,
    'runtime',
  );
  for (const taskKind of REAL_MAINTENANCE_TASK_KINDS) {
    const contractKey = 'maintenance-' + taskKind;
    addSemantic(
      'host-instruction',
      contractKey,
      MAINTENANCE_HOST_INSTRUCTION_VERSION,
      'runtime',
    );
    addSemantic(
      'input-validator',
      contractKey,
      MAINTENANCE_SESSION_INPUT_VERSION,
    );
    addSemantic(
      'output-validator',
      contractKey,
      MAINTENANCE_OUTPUT_VALIDATOR_VERSION,
    );
  }
  for (const profile of AGENT_SKILL_CONSUMER_PROFILES) {
    if (profile.runtimeBound) {
      rows.push({
        ref: policyRef(profile.profileId), targetKind: 'profile-policy',
        contractVersion: SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION, resolution: 'runtime',
      });
    }
    for (const taskKind of profile.taskKinds) {
      const logical = logicalOutcomeCapability(profile, taskKind);
      const canonical = canonicalAgentClosureCapability(logical);
      rows.push({
        ref: closureRef(logical, canonical), targetKind: 'closure-outcome',
        contractVersion: AGENT_CLOSURE_CONTRACT_VERSION, resolution: 'static',
      });
    }
  }
  for (const contract of SERVER_DOMAIN_SOURCE_CONTRACTS) {
    rows.push({ ref: contract.sourceRef, targetKind: 'task-source-proof',
      contractVersion: contract.sourceVersion, resolution: 'static' });
    rows.push({ ref: contract.evidenceRef, targetKind: 'evidence-stream',
      contractVersion: contract.evidenceVersion, resolution: 'static' });
  }
  rows.sort((left, right) => compareText(left.ref, right.ref));
  const uniqueRows: ServerAgentContractReferenceV1[] = [];
  for (const row of rows) {
    const previous = uniqueRows.at(-1);
    if (previous?.ref === row.ref) {
      if (JSON.stringify(previous) !== JSON.stringify(row)) {
        throw new TypeError(`agent-contract-reference ambiguous: ${row.ref}`);
      }
      continue;
    }
    uniqueRows.push(row);
  }
  const entries = Object.freeze(uniqueRows.map((row) => Object.freeze(row)));
  const byRef = new Map(entries.map((row) => [row.ref, row]));
  return Object.freeze({
    registryVersion: SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY_VERSION,
    entries,
    byRef(ref: string) { return byRef.get(ref); },
  });
}

export const SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY = buildReferenceRegistry();

function executionGroupRef(taskKind: string, runtimeBound: boolean): string {
  if (!runtimeBound) return `execution-group.unbound.${taskKind}`;
  if (taskKind === 'nsfw_scene_curator') return 'execution-group.deterministic-nsfw-scene';
  if (taskKind === 'interactive_prelude') return 'execution-group.interactive-prelude-v1';
  if (taskKind === 'branch_index') return 'execution-group.maintenance-branch-arc-v1';
  if (taskKind === 'preference_extract') return 'execution-group.learning-preference-v1';
  return `execution-group.${taskKind}`;
}

function dispatchOwnerCapabilityId(
  profile: AgentSkillConsumerProfileV1,
  taskKind: string,
): string | null {
  if (!hasRuntimeCaller(profile, taskKind)) return null;
  if (taskKind === 'interactive_prelude') return 'interactive.prelude';
  if (taskKind === 'branch_index') return 'maintenance.arc';
  if (taskKind === 'rolling_summary') return 'maintenance.memory';
  return profile.capabilityId;
}

/** A registered Profile/task does not establish a production issue caller for an alias. */
function hasRuntimeCaller(profile: AgentSkillConsumerProfileV1, taskKind: string): boolean {
  return profile.runtimeBound && !SERVER_DOMAIN_SOURCE_DISPOSITIONS.some(entry =>
    entry.profileId === profile.profileId && entry.taskKind === taskKind && entry.kind === 'registered-without-caller');
}

function identityKind(profile: AgentSkillConsumerProfileV1, taskKind: string): AgentContractIdentityKind {
  if (!hasRuntimeCaller(profile, taskKind)) return 'unbound';
  if (profile.profileId === 'maintenance.nsfwScene') return 'foreground-turn';
  // Only the newly indexed Style Skill variant uses its durable claim; legacy synchronous Style stays outside it.
  if (profile.profileId === 'learning.styleCompile') return 'background-job';
  if (profile.profileId.startsWith('maintenance.')) return 'background-job';
  if (profile.profileId.startsWith('learning.')) return 'learning-run';
  return 'foreground-turn';
}

function descriptorFor(
  profile: AgentSkillConsumerProfileV1,
  taskKind: string,
  phase: AgentContractDescriptorV1['route']['phase'],
): AgentContractDescriptorV1 {
  const registeredTask = (AGENT_TASK_KINDS as readonly string[]).includes(taskKind);
  const deterministic = deterministicNsfwRoute(profile, taskKind);
  const logicalOutcome = logicalOutcomeCapability(profile, taskKind);
  const canonicalOutcome = canonicalAgentClosureCapability(logicalOutcome);
  const bound = hasRuntimeCaller(profile, taskKind);
  const sourceContract = domainSourceContractFor(profile.profileId, taskKind, phase);
  const sourceDisposition = domainSourceDispositionFor(profile.profileId, taskKind, phase);
  const semanticContracts = semanticComponentRefs(profile, taskKind);
  return {
    descriptorVersion: AGENT_CONTRACT_DESCRIPTOR_VERSION,
    contractId: `agent-contract.${profile.profileId}.${taskKind}.${phase}`,
    profileRef: {
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
    },
    route: {
      capabilityId: profile.capabilityId,
      taskKind,
      phase,
      policyVersionIncludes: profile.policyVersionIncludes,
      policyVersionExcludes: profile.policyVersionExcludes,
    },
    execution: {
      // Preserve published group identities; route-level unbound does not create another group.
      executionGroupRef: executionGroupRef(taskKind, profile.runtimeBound),
      dispatchOwnerCapabilityId: dispatchOwnerCapabilityId(profile, taskKind),
      logicalOutcomeCapabilityId: logicalOutcome,
      canonicalOutcomeCapabilityId: canonicalOutcome,
      identityKind: identityKind(profile, taskKind),
    },
    wiring: {
      adapterRegistration: bound ? 'runtime-compatible' : 'profile-only',
      admissionTask: deterministic ? 'host-guarded' : registeredTask ? 'registered' : 'profile-only',
      runtimeState: 'not-indexed',
    },
    contracts: {
      skillInstructionSet: bound
        ? runtimeResolved(instructionRef())
        : missing('runtime-instruction-route-unbound'),
      hostInstruction: semanticContracts.hostInstruction,
      inputValidator: semanticContracts.inputValidator,
      outputValidator: semanticContracts.outputValidator,
      policy: bound
        ? runtimeResolved(policyRef(profile.profileId))
        : missing('profile-policy-route-unbound'),
      skillSourceAuthority: bound
        ? runtimeResolved(skillSourceAuthorityRef())
        : missing('skill-source-authority-route-unbound'),
      taskSourceProof: sourceContract
        ? indexed(sourceContract.sourceRef, sourceContract.sourceCoverage)
        : sourceDisposition ? missing(`independent-source-not-applicable-${sourceDisposition.kind}`)
        : pending('task-source-proof-not-indexed', 'task-source-proof-ref-v1'),
      hardChecks: deterministic ? [indexed(nsfwHostHardCheckRef()), indexed(sourceAuthorityHardCheckRef())] : bound
        ? [
            indexed(ticketHardCheckRef()),
            indexed(profileAdmissionHardCheckRef()),
            indexed(sourceAuthorityHardCheckRef()),
          ]
        : [missing('profile-admission-route-unbound')],
      closureOutcome: indexed(closureRef(logicalOutcome, canonicalOutcome)),
      evidenceStream: sourceContract
        ? indexed(sourceContract.evidenceRef, sourceContract.evidenceCoverage,
          deterministic ? [nsfwReceiptReaderRef()] : [])
        : sourceDisposition ? missing(`independent-evidence-not-applicable-${sourceDisposition.kind}`)
        : pending('domain-evidence-stream-not-indexed', 'domain-evidence-stream-ref-v1'),
      outcomeEvaluator: semanticContracts.outcomeEvaluator,
    },
    authorityEffect: 'none',
    runtimeStateIncluded: false,
  };
}

function buildDescriptors(): readonly AgentContractDescriptorV1[] {
  const descriptors: AgentContractDescriptorV1[] = [];
  for (const profile of AGENT_SKILL_CONSUMER_PROFILES) {
    for (const taskKind of profile.taskKinds) {
      for (const phase of profile.phases) descriptors.push(descriptorFor(profile, taskKind, phase));
    }
  }
  return Object.freeze(descriptors);
}

function routeKey(entry: AgentContractDescriptorV1): string {
  return JSON.stringify([
    entry.profileRef.profileId,
    entry.route.taskKind,
    entry.route.phase,
    entry.route.policyVersionIncludes,
    entry.route.policyVersionExcludes,
  ]);
}

function componentRegistrations(
  entry: AgentContractDescriptorV1,
): readonly Readonly<{
  component: AgentContractComponentRefV1;
  targetKind: ServerAgentContractReferenceV1['targetKind'];
}>[] {
  const contracts = entry.contracts;
  return [
    { component: contracts.skillInstructionSet, targetKind: 'instruction-selection' },
    { component: contracts.hostInstruction, targetKind: 'host-instruction' },
    { component: contracts.inputValidator, targetKind: 'input-validator' },
    { component: contracts.outputValidator, targetKind: 'output-validator' },
    { component: contracts.policy, targetKind: 'profile-policy' },
    { component: contracts.skillSourceAuthority, targetKind: 'source-authority' },
    { component: contracts.taskSourceProof, targetKind: 'task-source-proof' },
    ...contracts.hardChecks.map((component) => ({
      component, targetKind: 'hard-check' as const,
    })),
    { component: contracts.closureOutcome, targetKind: 'closure-outcome' },
    { component: contracts.evidenceStream, targetKind: 'evidence-stream' },
    { component: contracts.outcomeEvaluator, targetKind: 'outcome-evaluator' },
  ];
}

/**
 * Reconciles the derived index against the current Profile, task, Policy and Closure authorities.
 * It validates references only; it never executes the referenced runtime checks.
 */
export function validateServerAgentContractIndex(index: AgentContractIndexV1): void {
  if (index.indexVersion !== AGENT_CONTRACT_INDEX_VERSION
    || index.authorityEffect !== 'none' || index.runtimeStateIncluded !== false) {
    throw new TypeError('agent-contract-index must remain descriptive-only');
  }
  if (createAgentContractIndex(index.entries).indexRevision !== index.indexRevision) {
    throw new TypeError('agent-contract-index revision mismatch');
  }
  const profiles = new Map(AGENT_SKILL_CONSUMER_PROFILES.map((profile) => [profile.profileId, profile]));
  const expectedRoutes = new Set(buildDescriptors().map(routeKey));
  const expectedByRoute = new Map(buildDescriptors().map((entry) => [routeKey(entry), entry]));
  const actualRoutes = new Set(index.entries.map(routeKey));
  if (expectedRoutes.size !== actualRoutes.size
    || [...expectedRoutes].some((key) => !actualRoutes.has(key))) {
    throw new TypeError('agent-contract-index profile route coverage drift');
  }
  const pack = createServerBuiltinAgentSkillPack();
  for (const entry of index.entries) {
    const expected = expectedByRoute.get(routeKey(entry));
    if (!expected) throw new TypeError(`agent-contract-index unexpected route: ${entry.contractId}`);
    const profile = profiles.get(entry.profileRef.profileId);
    if (!profile || profile.profileVersion !== entry.profileRef.profileVersion
      || profile.capabilityId !== entry.route.capabilityId
      || !profile.taskKinds.includes(entry.route.taskKind)
      || !profile.phases.includes(entry.route.phase)
      || JSON.stringify(profile.policyVersionIncludes) !== JSON.stringify(entry.route.policyVersionIncludes)
      || JSON.stringify(profile.policyVersionExcludes) !== JSON.stringify(entry.route.policyVersionExcludes)) {
      throw new TypeError(`agent-contract-index profile route mismatch: ${entry.contractId}`);
    }
    const taskRegistered = (AGENT_TASK_KINDS as readonly string[]).includes(entry.route.taskKind);
    const deterministic = deterministicNsfwRoute(profile, entry.route.taskKind);
    const policyRegistered = pack.profileRegistry.byProfileId(profile.profileId) !== undefined;
    if (profile.runtimeBound !== (taskRegistered || deterministic) || profile.runtimeBound !== policyRegistered
      || entry.wiring.adapterRegistration
        !== (hasRuntimeCaller(profile, entry.route.taskKind) ? 'runtime-compatible' : 'profile-only')
      || entry.wiring.admissionTask !== (deterministic ? 'host-guarded' : taskRegistered ? 'registered' : 'profile-only')
      || entry.wiring.runtimeState !== 'not-indexed') {
      throw new TypeError(`agent-contract-index wiring mismatch: ${entry.contractId}`);
    }
    const logical = logicalOutcomeCapability(profile, entry.route.taskKind);
    const canonical = canonicalAgentClosureCapability(logical);
    if (entry.execution.executionGroupRef !== executionGroupRef(entry.route.taskKind, profile.runtimeBound)
      || entry.execution.dispatchOwnerCapabilityId
        !== dispatchOwnerCapabilityId(profile, entry.route.taskKind)
      || entry.execution.logicalOutcomeCapabilityId !== logical
      || entry.execution.canonicalOutcomeCapabilityId !== canonical
      || entry.execution.identityKind !== identityKind(profile, entry.route.taskKind)) {
      throw new TypeError(`agent-contract-index execution mapping mismatch: ${entry.contractId}`);
    }
    for (const { component, targetKind } of componentRegistrations(entry)) {
      if (component.state === 'indexed' || component.state === 'runtime-resolved') {
        const registered = SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY.byRef(component.ref);
        if (!registered) {
          throw new TypeError(`agent-contract-index dangling reference: ${component.ref}`);
        }
        if (registered.targetKind !== targetKind) {
          throw new TypeError(`agent-contract-index reference target mismatch: ${component.ref}`);
        }
        const expectedResolution = component.state === 'indexed' ? 'static' : 'runtime';
        if (registered.resolution !== expectedResolution) {
          throw new TypeError(`agent-contract-index reference resolution mismatch: ${component.ref}`);
        }
      }
      for (const evidenceRef of component.evidenceRefs) {
        if (!SERVER_AGENT_CONTRACT_REFERENCE_REGISTRY.byRef(evidenceRef)) {
          throw new TypeError(`agent-contract-index dangling evidence reference: ${evidenceRef}`);
        }
      }
    }
    if (entry.contractId !== expected.contractId
      || JSON.stringify(entry.contracts) !== JSON.stringify(expected.contracts)) {
      throw new TypeError(`agent-contract-index contract mapping mismatch: ${entry.contractId}`);
    }
  }
}

export function createServerAgentContractIndex(): AgentContractIndexV1 {
  const index = createAgentContractIndex(buildDescriptors());
  validateServerAgentContractIndex(index);
  return index;
}

export const SERVER_AGENT_CONTRACT_INDEX = createServerAgentContractIndex();

/** RP declarations are visible without extending the exact live Profile routes or granting execution. */
export const SERVER_RP_SCENARIO_CONTRACT_INDEX = createRpScenarioHc1Index();
