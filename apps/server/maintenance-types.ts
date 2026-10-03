import type { HarnessBudgetPolicy } from '../../packages/harness/src/types.ts';
import {
  normalizeArcMaintenanceProposal,
  type ArcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';
import {
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import {
  MAINTENANCE_TASK_KINDS,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
  type MaintenanceMode,
  type MaintenanceSettings,
  type MaintenanceStatus,
  type MaintenanceTaskKind,
  type MaintenanceTrigger,
  type PublicMaintenanceJob,
} from '../../packages/mobile-contracts/src/index.ts';

export {
  MAINTENANCE_TASK_KINDS,
  isMaintenanceMode,
  isMaintenanceTaskKind,
  isMaintenanceTrigger,
};
export type {
  MaintenanceMode,
  MaintenanceSettings,
  MaintenanceStatus,
  MaintenanceTaskKind,
  MaintenanceTrigger,
  PublicMaintenanceJob,
};

export const MAINTENANCE_POLICY_VERSION = 'p13b-v1';
export const MAINTENANCE_POLICY: Readonly<HarnessBudgetPolicy> = Object.freeze({
  maxSteps: 6,
  maxModelCalls: 3,
  maxToolCalls: 8,
  maxTokens: 12_000,
  maxCostMicrousd: 100_000,
  maxWallMs: 90_000,
  maxWrites: 1,
  maxToolResultChars: 16_384,
  maxFinalChars: 8_192,
  maxTraceSteps: 64,
});

export interface MaintenanceProposal {
  readonly taskKind: MaintenanceTaskKind;
  readonly payload: Record<string, unknown>;
}

export type MaintenanceStrictProposalContext =
  | ArcMaintenanceProposalContext
  | NpcMaintenanceProposalContext;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown> : null;
}

function exactKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(row);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(row, key)) && keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validFact(value: unknown): boolean {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['subject', 'predicate', 'value'], ['sourceRound'])) return false;
  if (!boundedString(row.subject, 240) || !boundedString(row.predicate, 120)) return false;
  if (!['string', 'number', 'boolean'].includes(typeof row.value) && row.value !== null) return false;
  if (typeof row.value === 'string' && row.value.length > 2_000) return false;
  return row.sourceRound === undefined
    || (Number.isInteger(row.sourceRound) && (row.sourceRound as number) >= 0);
}

function validBranch(value: unknown): boolean {
  const row = plainRecord(value);
  return row !== null && exactKeys(row, ['branchId', 'title', 'summary', 'status'])
    && boundedString(row.branchId, 160) && boundedString(row.title, 240)
    && boundedString(row.summary, 2_000)
    && ['open', 'closed', 'dormant'].includes(String(row.status));
}

function validCharacter(value: unknown): boolean {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, ['characterId', 'patch'], ['sourceRound', 'evidenceKind'])
    || !boundedString(row.characterId, 160)) return false;
  if (row.evidenceKind !== undefined && ![
    'profile', 'objective_fact', 'belief', 'knowledge', 'secret', 'goal', 'history_only',
  ].includes(String(row.evidenceKind))) return false;
  const patch = plainRecord(row.patch);
  if (!patch || Object.keys(patch).length < 1 || Object.keys(patch).length > 32) return false;
  if (Object.entries(patch).some(([key, item]) => !boundedString(key, 120)
    || (!['string', 'number', 'boolean'].includes(typeof item) && item !== null)
    || (typeof item === 'string' && item.length > 2_000))) return false;
  return row.sourceRound === undefined
    || (Number.isInteger(row.sourceRound) && (row.sourceRound as number) >= 0);
}

function validateMaintenanceProposalInternal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
  strictContext: MaintenanceStrictProposalContext | undefined,
  allowLegacyDomainProposal: boolean,
): MaintenanceProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('proposal-payload-invalid');
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('proposal-payload-too-large');
  const payload = value as Record<string, unknown>;
  if (taskKind === 'branch_index' && strictContext && 'allowedArcIds' in strictContext) {
    const normalized = normalizeArcMaintenanceProposal(payload, strictContext);
    const { proposalDigest: _proposalDigest, ...persisted } = normalized;
    return { taskKind, payload: structuredClone(persisted) };
  }
  if (taskKind === 'npc_state' && strictContext && 'allowedCharacterIds' in strictContext) {
    const normalized = normalizeNpcMaintenanceProposal(payload, strictContext);
    const { proposalDigest: _proposalDigest, ...persisted } = normalized;
    return { taskKind, payload: structuredClone(persisted) };
  }
  if ((taskKind === 'branch_index' || taskKind === 'npc_state') && !allowLegacyDomainProposal) {
    throw new Error('proposal-strict-context-required');
  }
  const allowedKeys: Readonly<Record<MaintenanceTaskKind, readonly string[]>> = {
    memory_consolidation: ['facts', 'supersedes'],
    branch_index: ['branches'],
    rolling_summary: ['summary', 'throughRound'],
    npc_state: ['characters'],
  };
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => !allowedKeys[taskKind].includes(key))) {
    throw new Error('proposal-schema-invalid');
  }
  if (taskKind === 'rolling_summary') {
    if (typeof payload.summary !== 'string' || payload.summary.length === 0 || payload.summary.length > 16_000
      || !Number.isInteger(payload.throughRound) || (payload.throughRound as number) < 0) {
      throw new Error('proposal-schema-invalid');
    }
  } else {
    const primary = taskKind === 'memory_consolidation' ? payload.facts
      : taskKind === 'branch_index' ? payload.branches : payload.characters;
    if (!Array.isArray(primary) || primary.length > 512) throw new Error('proposal-schema-invalid');
    const valid = taskKind === 'memory_consolidation' ? primary.every(validFact)
      : taskKind === 'branch_index' ? primary.every(validBranch) : primary.every(validCharacter);
    if (!valid) throw new Error('proposal-schema-invalid');
    if (taskKind === 'memory_consolidation') {
      if (!Array.isArray(payload.supersedes) || payload.supersedes.length > 512
        || payload.supersedes.some((item) => !boundedString(item, 160))) {
        throw new Error('proposal-schema-invalid');
      }
    }
  }
  return { taskKind, payload: structuredClone(payload) };
}

/** Production boundary: Arc/NPC require their fixed-snapshot strict context. */
export function validateMaintenanceProposal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
  strictContext?: MaintenanceStrictProposalContext,
): MaintenanceProposal {
  return validateMaintenanceProposalInternal(taskKind, value, strictContext, false);
}

/** Historical replay compatibility only; production Harness must never call this entry point. */
export function validateLegacyMaintenanceReplayProposal(
  taskKind: MaintenanceTaskKind,
  value: unknown,
): MaintenanceProposal {
  return validateMaintenanceProposalInternal(taskKind, value, undefined, true);
}
