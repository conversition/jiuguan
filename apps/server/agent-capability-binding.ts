import type {
  AdmissionRequest,
  AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';
import type { AgentSubcapabilityId } from '../../packages/mobile-contracts/src/agent-control.ts';
import type { AgentControlStore } from './agent-control-store.ts';

const capabilities = (...ids: AgentSubcapabilityId[]): readonly AgentSubcapabilityId[] => Object.freeze(ids);

const TASK_CAPABILITIES: Readonly<Record<AgentTaskKind, readonly AgentSubcapabilityId[]>> = Object.freeze({
  // One shared interactive loop currently serves all three logical roles.
  interactive_prelude: capabilities(
    'interactive.prelude', 'interactive.director', 'interactive.variableProposal',
  ),
  context_compiler: capabilities('context.compiler'),
  memory_consolidation: capabilities('maintenance.memory'),
  branch_index: capabilities('maintenance.branchIndex'),
  rolling_summary: capabilities('maintenance.memory'),
  npc_state: capabilities('maintenance.npc'),
  preference_extract: capabilities('learning.preference'),
  style_compile: capabilities('learning.styleCompile'),
  arc_maintenance: capabilities('maintenance.arc'),
  npc_maintenance: capabilities('maintenance.npc'),
  critic_revision: capabilities('interactive.critic'),
  aql_replan: capabilities('interactive.aqlReplan'),
});

/**
 * Maps a Ticket to the logical capability controls that must all remain un-killed.
 * Shared execution is explicit: killing director/prelude/variableProposal stops their
 * one shared interactive Ticket rather than pretending those calls are separable.
 */
export function agentCapabilitiesForAdmission(
  request: Pick<AdmissionRequest, 'taskKind' | 'policyVersion'>,
): readonly AgentSubcapabilityId[] {
  if (request.taskKind === 'preference_extract' && request.policyVersion.includes('branch-semantic')) {
    return capabilities('learning.branchPreference');
  }
  return TASK_CAPABILITIES[request.taskKind];
}

export function agentCapabilityTicketAllowed(
  store: AgentControlStore,
  request: Pick<AdmissionRequest, 'taskKind' | 'policyVersion'>,
): boolean {
  return agentCapabilitiesForAdmission(request).every(
    (capabilityId) => store.capabilityControl(capabilityId).killedReason === null,
  );
}
