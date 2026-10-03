import {
  MAINTENANCE_ADMISSION_POLICY_VERSION,
  MAINTENANCE_ADMISSION_TASKS,
  evaluateMaintenanceAdmissionBatch,
  maintenanceAdmissionFactsDigest,
  type MaintenanceAdmissionAudit,
  type MaintenanceAdmissionReasonCode,
  type MaintenanceAdmissionTask,
} from '../../packages/agent-policy/src/maintenance-admission.ts';
import {
  maintenanceAdmissionAllowsSession,
  type MaintenanceAdmissionRuntimeConfig,
} from './maintenance-admission-runtime-config.ts';

export interface MaintenanceAdmissionSelection {
  readonly mode: MaintenanceAdmissionRuntimeConfig['mode'];
  readonly parentRunId: string | null;
  readonly sessionId: string | null;
  readonly sourceRevision: string | null;
  readonly wouldAdmitTasks: readonly MaintenanceAdmissionTask[];
  readonly admittedTasks: readonly MaintenanceAdmissionTask[];
}

export type PostTurnModelSlot = 'style-explicit' | 'style-auto' | null;

function emptySelection(
  mode: MaintenanceAdmissionRuntimeConfig['mode'],
): MaintenanceAdmissionSelection {
  return Object.freeze({
    mode,
    parentRunId: null,
    sessionId: null,
    sourceRevision: null,
    wouldAdmitTasks: Object.freeze([]),
    admittedTasks: Object.freeze([]),
  });
}

function sameStrings(values: readonly string[], label: string): string {
  const unique = new Set(values);
  if (unique.size !== 1) throw new TypeError('maintenance admission batch has mixed ' + label);
  return values[0]!;
}

/**
 * Pure queue-enforcement boundary. It validates that the persisted/audited decisions
 * are the exact result of the current policy before exposing at most one task to enqueue.
 * It never creates, claims, cancels or commits a maintenance job.
 */
export function enforceMaintenanceAdmission(
  config: MaintenanceAdmissionRuntimeConfig,
  audits: readonly MaintenanceAdmissionAudit[],
): MaintenanceAdmissionSelection {
  if (config.mode === 'off') return emptySelection('off');
  if (!Array.isArray(audits) || audits.length !== MAINTENANCE_ADMISSION_TASKS.length) {
    throw new TypeError('maintenance admission batch must contain every task exactly once');
  }
  const tasks = audits.map((audit) => audit.facts.taskKind);
  if (new Set(tasks).size !== MAINTENANCE_ADMISSION_TASKS.length
    || MAINTENANCE_ADMISSION_TASKS.some((task) => !tasks.includes(task))) {
    throw new TypeError('maintenance admission batch must contain every task exactly once');
  }

  const parentRunId = sameStrings(audits.map((audit) => audit.parentRunId), 'parentRunId');
  const sessionId = sameStrings(audits.map((audit) => audit.sessionId), 'sessionId');
  const sourceRevision = sameStrings(audits.map((audit) => audit.sourceRevision), 'sourceRevision');
  const round = audits[0]!.round;
  if (!Number.isSafeInteger(round) || round < 1 || audits.some((audit) => audit.round !== round)) {
    throw new TypeError('maintenance admission batch has mixed round');
  }
  if (audits.some((audit) => audit.decision.policyVersion !== MAINTENANCE_ADMISSION_POLICY_VERSION
    || audit.decision.taskKind !== audit.facts.taskKind
    || audit.decision.factsDigest !== maintenanceAdmissionFactsDigest(audit.facts))) {
    throw new TypeError('maintenance admission decision binding is invalid');
  }

  const expected = evaluateMaintenanceAdmissionBatch(round, audits.map((audit) => audit.facts));
  const expectedByTask = new Map(expected.map((decision) => [decision.taskKind, decision]));
  for (const audit of audits) {
    const decision = expectedByTask.get(audit.facts.taskKind)!;
    if (audit.decision.verdict !== decision.verdict
      || audit.decision.reasonCodes.length !== decision.reasonCodes.length
      || audit.decision.reasonCodes.some((
        reason: MaintenanceAdmissionReasonCode,
        index: number,
      ) => reason !== decision.reasonCodes[index])) {
      throw new TypeError('maintenance admission decision does not match policy');
    }
  }

  const wouldAdmitTasks = Object.freeze(
    [...audits]
      .sort((left, right) => MAINTENANCE_ADMISSION_TASKS.indexOf(left.facts.taskKind)
        - MAINTENANCE_ADMISSION_TASKS.indexOf(right.facts.taskKind))
      .filter((audit) => audit.decision.verdict === 'would-admit')
      .map((audit) => audit.facts.taskKind),
  );
  if (wouldAdmitTasks.length > 1) throw new TypeError('maintenance admission selected too many tasks');
  const admittedTasks = config.mode === 'enforce'
    && maintenanceAdmissionAllowsSession(config, sessionId)
    ? wouldAdmitTasks
    : Object.freeze([] as MaintenanceAdmissionTask[]);
  return Object.freeze({
    mode: config.mode,
    parentRunId,
    sessionId,
    sourceRevision,
    wouldAdmitTasks,
    admittedTasks,
  });
}

/**
 * Q8-E scheduler boundary: Style compilation has already run synchronously before
 * TurnJob settlement. An attempted Style call owns this turn's only background
 * model slot, so lower-priority maintenance is reconsidered on a later turn.
 */
export function schedulePostTurnMaintenance(
  config: MaintenanceAdmissionRuntimeConfig,
  audits: readonly MaintenanceAdmissionAudit[],
  occupiedSlot: PostTurnModelSlot,
): MaintenanceAdmissionSelection {
  const selection = enforceMaintenanceAdmission(config, audits);
  if (occupiedSlot === null || selection.admittedTasks.length === 0) return selection;
  return Object.freeze({
    ...selection,
    admittedTasks: Object.freeze([] as MaintenanceAdmissionTask[]),
  });
}
