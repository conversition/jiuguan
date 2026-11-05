import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_GRANT_VERSION,
  AGENT_SKILL_SELECTION_REQUEST_VERSION,
  normalizeAgentSkillSelectionRequest,
  type AgentSkillCandidateRefV1,
  type AgentSkillExecutionGrantV1,
  type AgentSkillPhase,
  type AgentSkillVersionRefV1,
} from '@jiuguan/skill-hub';
import type {
  AgentSkillTurnContextReader,
  AgentSkillTurnContextV1,
} from '../../../packages/session/public/agent-skill-turn-context.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import { agentCapabilitiesForAdmission } from '../agent-capability-binding.ts';
import { rolloutLaneForAdmission } from '../agent-begin-policy.ts';
import type { AgentControlStore } from '../agent-control-store.ts';
import type { PublicNsfwSceneSafety } from '../nsfw-scene-safety-control.ts';
import {
  SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION,
  createServerAgentSkillAdmissionContextSnapshot,
  type AgentAdmissionLeaseAuthorityPort,
  type ServerAgentSkillAdmissionContextAuthorityPort,
  type ServerAgentSkillAdmissionContextSnapshotV1,
} from './profile-admission-service.ts';

/** Exact host registration. A model/request cannot choose its own consumer identity. */
export interface ServerAgentSkillContextBindingV1 {
  readonly taskKind: AgentAdmissionLease['taskKind'];
  readonly policyVersion: string;
  readonly capabilityId: string;
  readonly phase: AgentSkillPhase;
  readonly explicit: readonly AgentSkillVersionRefV1[];
  readonly candidates: readonly AgentSkillCandidateRefV1[] | null;
}

/** Current host ceilings and prompt headroom; this port must be synchronous and server-owned. */
export interface ServerAgentSkillRuntimeAuthorityV1 {
  readonly revision: string;
  /** Recomputed current rollout/session/host eligibility, not the Lease's historical decision. */
  readonly allowed: boolean;
  readonly grant: AgentSkillExecutionGrantV1;
  readonly maxBodyTokens: number;
  readonly maxCompiledInstructionTokens: number;
  readonly maxValidatorOperations: number;
  readonly maxSkills: number;
}

export interface ServerAgentSkillSafetyAuthorityV1 {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly state: PublicNsfwSceneSafety;
}

export interface ServerAgentSkillContextAuthorityDependencies {
  readonly leaseAuthority: Pick<AgentAdmissionLeaseAuthorityPort, 'ownsLease'>;
  readonly turnAuthority: AgentSkillTurnContextReader;
  readonly controlStore: Pick<AgentControlStore, 'get' | 'capabilityControl'>;
  readonly runtimeAuthority: {
    readForLease(lease: AgentAdmissionLease): ServerAgentSkillRuntimeAuthorityV1;
  };
  readonly safetyAuthority: {
    readForLease(
      lease: AgentAdmissionLease,
      turn: AgentSkillTurnContextV1,
    ): ServerAgentSkillSafetyAuthorityV1 | null;
  };
  readonly bindings: readonly ServerAgentSkillContextBindingV1[];
  readonly nowMs?: () => number;
}

export interface ServerAgentSkillSynchronousContextAuthorityPort
  extends ServerAgentSkillAdmissionContextAuthorityPort {
  readForLease(lease: AgentAdmissionLease): ServerAgentSkillAdmissionContextSnapshotV1;
}

/** Domain-owned source metadata. Neither an idle session nor a job ID alone authorizes a read. */
export interface ServerAgentSkillContextSourceV1 {
  readonly sourceContextVersion: 'server-agent-skill-context-source-v1';
  readonly origin: 'active-turn' | 'maintenance-job';
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly scope: AgentSkillTurnContextV1['scope'];
  readonly assetRevision: string;
  readonly worldbookSourceRevision: string;
  readonly authorityRevision: string;
}

export interface ServerAgentSkillSourceContextAuthorityDependencies
  extends Omit<ServerAgentSkillContextAuthorityDependencies, 'turnAuthority' | 'safetyAuthority'> {
  readonly sourceAuthority: { readForLease(lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null };
  readonly safetyAuthority: { readForLease(lease: AgentAdmissionLease, source: ServerAgentSkillContextSourceV1):
    ServerAgentSkillSafetyAuthorityV1 | null };
}

function reject(reason: string): never {
  throw new Error(`agent-skill-context-authority-${reason}`);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function key(taskKind: string, policyVersion: string): string {
  return JSON.stringify([taskKind, policyVersion]);
}

/**
 * Reads Session's active turn and real control rows without issuing Tickets or changing rollout.
 * Ports are fixed, audited, side-effect-free server-local readers. Synchronous execution avoids
 * an await splitting the snapshot; it does not sandbox arbitrary callbacks or reentrant writers.
 * Live consumers import this narrow adapter directly; it grants no permission by construction.
 */
export function createServerAgentSkillContextAuthority(
  dependencies: ServerAgentSkillContextAuthorityDependencies,
): ServerAgentSkillSynchronousContextAuthorityPort {
  const readTurn = dependencies.turnAuthority.readAgentSkillTurnContext.bind(dependencies.turnAuthority);
  return createServerAgentSkillSourceContextAuthority({ ...dependencies,
    sourceAuthority: { readForLease(lease) {
      const turn = readTurn(lease.parentRunId);
      if (!turn || turn.contextVersion !== 'session-agent-skill-turn-context-v1'
        || turn.runId !== lease.parentRunId) return null;
      return Object.freeze({ sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'active-turn',
        runId: lease.runId, parentRunId: lease.parentRunId, sessionId: turn.sessionId,
        sourceRevision: turn.sourceRevision, contentMode: turn.contentMode, scope: turn.scope,
        assetRevision: turn.assetRevision, worldbookSourceRevision: turn.worldbookSourceRevision,
        authorityRevision: digest(turn) });
    } },
    safetyAuthority: { readForLease(lease, source) {
      const turn = readTurn(lease.parentRunId);
      if (!turn || digest(turn) !== source.authorityRevision) reject('snapshot-drift');
      return dependencies.safetyAuthority.readForLease(lease, turn);
    } },
  });
}

/** Shared current-control validation only; each domain must attest its own running source. */
export function createServerAgentSkillSourceContextAuthority(
  dependencies: ServerAgentSkillSourceContextAuthorityDependencies,
): ServerAgentSkillSynchronousContextAuthorityPort {
  const ownsLease = dependencies.leaseAuthority.ownsLease.bind(dependencies.leaseAuthority);
  const readSource = dependencies.sourceAuthority.readForLease.bind(dependencies.sourceAuthority);
  const readLane = dependencies.controlStore.get.bind(dependencies.controlStore);
  const readCapability = dependencies.controlStore.capabilityControl.bind(dependencies.controlStore);
  const readRuntime = dependencies.runtimeAuthority.readForLease.bind(dependencies.runtimeAuthority);
  const readSafety = dependencies.safetyAuthority.readForLease.bind(dependencies.safetyAuthority);
  const nowMs = dependencies.nowMs ?? Date.now;
  const bindings = new Map<string, ServerAgentSkillContextBindingV1>();
  if (!Array.isArray(dependencies.bindings) || dependencies.bindings.length > 64) reject('bindings-invalid');
  for (const binding of dependencies.bindings) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(binding.policyVersion)) {
      reject('binding-policy-invalid');
    }
    if (!agentCapabilitiesForAdmission(binding)?.includes(binding.capabilityId as never)) {
      reject('capability-not-bound');
    }
    const bindingKey = key(binding.taskKind, binding.policyVersion);
    if (bindings.has(bindingKey)) reject('binding-ambiguous');
    const normalized = normalizeAgentSkillSelectionRequest({
      requestVersion: AGENT_SKILL_SELECTION_REQUEST_VERSION,
      catalogRevision: `sha256:${'0'.repeat(64)}`,
      capabilityId: binding.capabilityId,
      taskKind: binding.taskKind,
      phase: binding.phase,
      contentMode: 'nsf',
      scope: { sessionId: 'registration' },
      grant: {
        grantVersion: AGENT_SKILL_GRANT_VERSION,
        tools: [], writableArtifactKinds: [], maxRiskTier: 'advisory',
        maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0,
      },
      budgetTokens: 0,
      maxSkills: 64,
      explicit: binding.explicit,
      ...(binding.candidates === null ? {} : { candidates: binding.candidates }),
    });
    bindings.set(bindingKey, Object.freeze({
      taskKind: binding.taskKind,
      policyVersion: binding.policyVersion,
      capabilityId: normalized.capabilityId,
      phase: normalized.phase,
      explicit: normalized.explicit,
      candidates: binding.candidates === null ? null : normalized.candidates ?? Object.freeze([]),
    }));
  }

  return Object.freeze({
    readForLease(lease: AgentAdmissionLease): ServerAgentSkillAdmissionContextSnapshotV1 {
      if (!ownsLease(lease)) reject('lease-not-owned');
      if (nowMs() >= lease.expiresAtMs) reject('lease-expired');
      const binding = bindings.get(key(lease.taskKind, lease.policyVersion));
      if (!binding) reject('binding-unavailable');
      const turn = readSource(lease);
      if (!turn || turn.sourceContextVersion !== 'server-agent-skill-context-source-v1'
        || !['active-turn', 'maintenance-job'].includes(turn.origin)
        || turn.runId !== lease.runId || turn.parentRunId !== lease.parentRunId || turn.sessionId !== lease.sessionId
        || turn.scope.sessionId !== lease.sessionId || turn.sourceRevision !== lease.sourceRevision
        || turn.contentMode !== lease.mode) reject('turn-binding-mismatch');
      if (!/^sha256:[a-f0-9]{64}$/u.test(turn.assetRevision)
        || !/^sha256:[a-f0-9]{64}$/u.test(turn.worldbookSourceRevision)
        || !/^sha256:[a-f0-9]{64}$/u.test(turn.authorityRevision)) reject('assets-invalid');
      const turnDigest = digest(turn);
      const lane = readLane(rolloutLaneForAdmission(lease.lane));
      if (lane.lane !== rolloutLaneForAdmission(lease.lane)
        || lane.desiredState === 'off' || lane.desiredState === 'killed' || lane.killedReason !== null) {
        reject('lane-unavailable');
      }
      // Shared loops require every participating capability to remain enabled.
      const capabilities = agentCapabilitiesForAdmission(lease).map((id) => {
        const row = readCapability(id);
        if (row.capabilityId !== id) reject('capability-binding-mismatch');
        return row;
      });
      if (capabilities.some((row) => row.killedReason !== null)) reject('capability-killed');
      const laneDigest = digest(lane);
      const capabilityDigests = capabilities.map(digest);
      const runtime = readRuntime(lease);
      if (runtime.allowed !== true) reject('runtime-denied');
      if (typeof runtime.revision !== 'string' || !runtime.revision) reject('runtime-invalid');
      const runtimeDigest = digest(runtime);
      let nsfwSafetyDigest: string | null = null;
      if (turn.contentMode === 'nsfw') {
        const safety = readSafety(lease, turn);
        if (!safety || safety.sessionId !== lease.sessionId || safety.sourceRevision !== turn.sourceRevision
          || !safety.state.enabled || safety.state.reasonCode !== 'active'
          || safety.state.adultAttestation !== 'verified' || !safety.state.participantsAdult
          || safety.state.consent !== 'confirmed'
          || !Number.isSafeInteger(safety.state.revision) || safety.state.revision < 1
          || safety.state.sourceRevision !== turn.worldbookSourceRevision) reject('nsfw-safety-required');
        nsfwSafetyDigest = digest(safety);
      }
      const controlRevision = digest({
        lane, capabilities, runtimeRevision: runtime.revision,
        assetRevision: turn.assetRevision, worldbookSourceRevision: turn.worldbookSourceRevision,
        sourceAuthorityRevision: turn.authorityRevision,
      });
      const snapshot = createServerAgentSkillAdmissionContextSnapshot({
        snapshotVersion: SERVER_AGENT_SKILL_ADMISSION_CONTEXT_VERSION,
        ticketId: lease.ticketId, runId: lease.runId, parentRunId: lease.parentRunId,
        sessionId: lease.sessionId, sourceRevision: turn.sourceRevision,
        lane: lease.lane, taskKind: lease.taskKind, policyVersion: lease.policyVersion,
        contentMode: turn.contentMode,
        capabilityId: binding.capabilityId, profileId: binding.capabilityId, phase: binding.phase,
        scope: turn.scope, explicit: binding.explicit, candidates: binding.candidates,
        runtimeGrant: runtime.grant, maxBodyTokens: runtime.maxBodyTokens,
        maxCompiledInstructionTokens: runtime.maxCompiledInstructionTokens,
        maxValidatorOperations: runtime.maxValidatorOperations, maxSkills: runtime.maxSkills,
        controlRevision, nsfwSafetyDigest,
      });
      // Trusted adapters must not mutate authority during a read and leave a mixed snapshot.
      const currentTurn = readSource(lease);
      if (!currentTurn || digest(currentTurn) !== turnDigest
        || digest(readLane(lane.lane)) !== laneDigest
        || capabilities.some((row, index) => digest(readCapability(row.capabilityId)) !== capabilityDigests[index])
        || digest(readRuntime(lease)) !== runtimeDigest
        || (nsfwSafetyDigest !== null && digest(readSafety(lease, currentTurn)) !== nsfwSafetyDigest)) {
        reject('snapshot-drift');
      }
      if (nowMs() >= lease.expiresAtMs) reject('lease-expired');
      return snapshot;
    },
  });
}
