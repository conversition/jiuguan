import { agentCapabilitiesForAdmission } from './agent-capability-binding.ts';
import type { AgentCapabilityControlRow, AgentControlStore } from './agent-control-store.ts';
import type { MaintenanceRuntimeObservation } from './maintenance-harness-service.ts';
import { MAINTENANCE_POLICY_VERSION, type MaintenanceTaskKind } from './maintenance-types.ts';
import {
  MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
  MAINTENANCE_MULTI_TASK_PROTOCOL_KILL_REASON,
} from './maintenance-protocol-reasons.ts';

export {
  MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
  MAINTENANCE_MULTI_TASK_PROTOCOL_KILL_REASON,
} from './maintenance-protocol-reasons.ts';

export interface MaintenanceProtocolCircuitResult {
  readonly stoppedCapabilities: readonly AgentCapabilityControlRow['capabilityId'][];
  readonly failureStreakIncidentGroups: readonly string[];
  readonly laneEscalated: boolean;
}

const TASK_INCIDENT_GROUP: Readonly<Record<MaintenanceTaskKind, string>> = Object.freeze({
  memory_consolidation: 'maintenance.memory',
  rolling_summary: 'maintenance.memory',
  branch_index: 'maintenance.branch-arc',
  npc_state: 'maintenance.npc',
  worldbook_repair: 'maintenance.worldbook',
});

/**
 * Persists value-free diagnostics and applies a two-level circuit breaker:
 * one failed run stops only its task capabilities; two distinct incident
 * groups in one uninterrupted failed-run streak stop the whole Maintenance
 * Lane. A clean or self-corrected valid run resets that streak. Superseded
 * window completions remain auditable but cannot affect current controls.
 */
export function recordMaintenanceProtocolCircuit(
  store: AgentControlStore,
  input: MaintenanceRuntimeObservation,
): MaintenanceProtocolCircuitResult {
  if (input.invalidCalls !== input.rejections.length
    || (input.outcome === 'clean' && input.invalidCalls !== 0)
    || (input.outcome !== 'clean' && input.invalidCalls < 1)) {
    throw new Error('maintenance-protocol-observation-invalid');
  }
  const recorded = store.recordMaintenanceProtocolRunOutcome({
    quotaReservationDigest: input.quotaReservationDigest,
    windowSequence: input.windowSequence,
    incidentGroup: TASK_INCIDENT_GROUP[input.taskKind],
    taskKind: input.taskKind,
    runId: input.runId,
    outcome: input.outcome,
    rejections: input.rejections,
  });
  if (!recorded.currentWindow || input.outcome !== 'failed') {
    return Object.freeze({
      stoppedCapabilities: Object.freeze([]),
      failureStreakIncidentGroups: recorded.failureStreakIncidentGroups,
      laneEscalated: false,
    });
  }

  const stoppedCapabilities: AgentCapabilityControlRow['capabilityId'][] = [];
  const capabilities = agentCapabilitiesForAdmission({
    taskKind: input.taskKind,
    policyVersion: MAINTENANCE_POLICY_VERSION,
  });
  for (const capabilityId of capabilities) {
    const current = store.capabilityControl(capabilityId);
    if (current.killedReason !== null) continue;
    try {
      store.killCapabilityCas(
        capabilityId,
        MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON,
        current.revision,
      );
      stoppedCapabilities.push(capabilityId);
    } catch (error) {
      // A concurrent operator/circuit action wins. Only suppress the benign
      // race where the capability is already stopped after re-read.
      if (store.capabilityControl(capabilityId).killedReason === null) throw error;
    }
  }
  let laneEscalated = false;
  if (recorded.failureStreakIncidentGroups.length >= 2) {
    const current = store.get('maintenance');
    if (current.desiredState !== 'killed') {
      try {
        store.killCas(
          'maintenance', MAINTENANCE_MULTI_TASK_PROTOCOL_KILL_REASON, current.revision,
        );
        laneEscalated = true;
      } catch (error) {
        // An operator, safety circuit, or another protocol worker may win after
        // our read. Never overwrite its reason and never turn that benign race
        // into a failed Maintenance job; propagate only if the Lane is still live.
        if (store.get('maintenance').desiredState !== 'killed') throw error;
      }
    }
  }
  return Object.freeze({
    stoppedCapabilities: Object.freeze(stoppedCapabilities),
    failureStreakIncidentGroups: recorded.failureStreakIncidentGroups,
    laneEscalated,
  });
}
