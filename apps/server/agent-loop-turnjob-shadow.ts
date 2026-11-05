/** @author Codex @date 2026-10-20 @version 1.0
 * P17-02.1：TurnJob/Maintenance → TaskEnvelope shadow adapter，不接管业务执行。
 *
 * AL-7 的第一块地板：把真实 TurnJob 投影成 AL-1 的 TaskEnvelope，让恢复/接管有东西可读。
 * 三条硬规则：
 * 1. **映射全部显式**：action → taskKind/contract/verifier/budget/authority 都在登记表里，
 *    没登记的 action 直接拒绝——不许「默认 conversation-turn」这种隐式兜底；
 * 2. **不搬运 prompt/凭据**：PublicTurnJob 本来就不含 prompt（契约如此），投影里也不允许出现；
 * 3. pure builder 只产出信封/摘要；宿主生命周期 helper 只写元数据投影/围栏，遵守 CAS/lease。
 */
import { createHash } from 'node:crypto';
import {
  normalizeAgentLoopTaskEnvelope,
  type AgentLoopTaskEnvelopeV1,
} from '@jiuguan/agent-loop-contract';
import { isTurnJobAction, type PublicTurnJob } from '@jiuguan/mobile-contracts';

export const AGENT_LOOP_TURNJOB_SHADOW_VERSION = 'agent-loop-turnjob-shadow-v1' as const;

export interface TurnJobTaskKindRegistration {
  readonly taskKind: string;
  readonly contractRef: string;
  readonly contractRevision: string;
  readonly verifierSetRef: string;
  readonly verifierSetRevision: string;
  readonly budgetProfileRef: string;
  readonly authorityProfile: string;
  readonly goalSummary: string;
}

/** P17-02.1 的显式登记表：新增 action 必须先在这里登记，投影直接拒绝未登记项。 */
export const TURNJOB_TASK_KIND_REGISTRY: Readonly<
  Record<string, TurnJobTaskKindRegistration>
> = Object.freeze({
  turn: Object.freeze({
    taskKind: 'conversation-turn',
    contractRef: 'contract.turn.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.turn.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'interactive',
    authorityProfile: 'admission.interactive.v1',
    goalSummary: '完成用户回合',
  }),
  regenerate: Object.freeze({
    taskKind: 'conversation-turn',
    contractRef: 'contract.turn.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.turn.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'interactive',
    authorityProfile: 'admission.interactive.v1',
    goalSummary: '重新生成用户回合',
  }),
});

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export function turnJobTaskKind(action: string): TurnJobTaskKindRegistration {
  if (!Object.hasOwn(TURNJOB_TASK_KIND_REGISTRY, action)) throw new Error('agent-loop-turnjob-action-unmapped');
  const registration = TURNJOB_TASK_KIND_REGISTRY[action];
  if (!registration) throw new Error('agent-loop-turnjob-action-unmapped');
  return registration;
}

export interface ShadowTurnJobProjectionV1 {
  readonly version: typeof AGENT_LOOP_TURNJOB_SHADOW_VERSION;
  readonly taskKind: string;
  readonly taskId: string;
  readonly envelope: AgentLoopTaskEnvelopeV1;
  readonly envelopeDigest: string;
  /** 恒为 true：builder 无副作用，host sidecar 不接管原 Manager 的业务执行。 */
  readonly shadow: true;
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new Error(`agent-loop-turnjob-${label}-invalid`);
  }
  return value;
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/** 把一个已认领的 TurnJob 投影成规范 TaskEnvelope。失败只抛错，绝不写任何 Store。 */
export function buildShadowTurnJobEnvelope(input: Readonly<{
  job: PublicTurnJob;
  now: string;
}>): ShadowTurnJobProjectionV1 {
  const { job } = input;
  if (!job || typeof job !== 'object') throw new Error('agent-loop-turnjob-job-invalid');
  if (!isTurnJobAction(job.action)) throw new Error('agent-loop-turnjob-action-unmapped');
  if (job.status !== 'running' && job.status !== 'queued') {
    throw new Error('agent-loop-turnjob-status-not-active');
  }
  const registration = turnJobTaskKind(job.action);
  const runId = token(job.runId, 'runid');
  const requestId = token(job.requestId, 'requestid');
  if (typeof input.now !== 'string' || Number.isNaN(Date.parse(input.now))) {
    throw new Error('agent-loop-turnjob-now-invalid');
  }
  const now = input.now;
  const taskId = `agentloop.turn.${runId}`;
  const zeroBudget = {
    modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0,
    costMicrousd: 0, wallMs: 0, highRiskActions: 0, childTasks: 0,
  };
  const envelope = normalizeAgentLoopTaskEnvelope({
    contractVersion: 'agent-loop-task-envelope-v1',
    taskId,
    rootTaskId: taskId,
    dependencyTaskIds: [],
    taskContractRef: registration.contractRef,
    taskKind: registration.taskKind,
    state: 'CREATED',
    phase: 'PREPARE',
    goal: { summary: registration.goalSummary,
      sourceRefs: [`turnjob.${runId}`, `request.${requestId}`] },
    todos: [],
    confirmedFacts: [],
    blockers: [],
    children: [],
    artifacts: [],
    budget: {
      policyRef: `agent.budget.${registration.budgetProfileRef}`,
      granted: zeroBudget,
      reserved: zeroBudget,
      spent: zeroBudget,
    },
    verifier: {
      verifierSetRef: registration.verifierSetRef,
      verifierSetRevision: registration.verifierSetRevision,
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return Object.freeze({
    version: AGENT_LOOP_TURNJOB_SHADOW_VERSION,
    taskKind: registration.taskKind,
    taskId,
    envelope,
    envelopeDigest: digestOf(envelope),
    shadow: true,
  });
}

import {
  MAINTENANCE_TASK_KINDS,
  type MaintenanceTaskKind,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';

/**
 * 维护侧登记表：五种 taskKind 各自显式登记（P17-02.1 要求「显式」到 kind 级，
 * 不允许「maintenance 一把抓」——不同维护任务的 verifier 口径未来必然分叉）。
 */
export const MAINTENANCE_TASK_KIND_REGISTRY: Readonly<
  Record<MaintenanceTaskKind, TurnJobTaskKindRegistration>
> = Object.freeze({
  memory_consolidation: Object.freeze({
    taskKind: 'maintenance.memory_consolidation',
    contractRef: 'contract.maintenance.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.maintenance.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'maintenance',
    authorityProfile: 'admission.maintenance.v1',
    goalSummary: '巩固会话记忆',
  }),
  branch_index: Object.freeze({
    taskKind: 'maintenance.branch_index',
    contractRef: 'contract.maintenance.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.maintenance.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'maintenance',
    authorityProfile: 'admission.maintenance.v1',
    goalSummary: '重建剧情分支索引',
  }),
  rolling_summary: Object.freeze({
    taskKind: 'maintenance.rolling_summary',
    contractRef: 'contract.maintenance.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.maintenance.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'maintenance',
    authorityProfile: 'admission.maintenance.v1',
    goalSummary: '滚动生成会话摘要',
  }),
  npc_state: Object.freeze({
    taskKind: 'maintenance.npc_state',
    contractRef: 'contract.maintenance.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.maintenance.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'maintenance',
    authorityProfile: 'admission.maintenance.v1',
    goalSummary: '推进 NPC 状态',
  }),
  worldbook_repair: Object.freeze({
    taskKind: 'maintenance.worldbook_repair',
    contractRef: 'contract.maintenance.v1',
    contractRevision: 'rev.1',
    verifierSetRef: 'verifier.maintenance.v1',
    verifierSetRevision: 'rev.1',
    budgetProfileRef: 'maintenance',
    authorityProfile: 'admission.maintenance.v1',
    goalSummary: '修复世界书',
  }),
});

/** 把一个维护任务投影成规范 TaskEnvelope（shadow，零写库）。 */
export function buildShadowMaintenanceJobEnvelope(input: Readonly<{
  job: PublicMaintenanceJob;
  now: string;
}>): ShadowTurnJobProjectionV1 {
  const { job } = input;
  if (!job || typeof job !== 'object') throw new Error('agent-loop-turnjob-job-invalid');
  if (!(MAINTENANCE_TASK_KINDS as readonly string[]).includes(job.taskKind)) {
    throw new Error('agent-loop-turnjob-action-unmapped');
  }
  if (job.status !== 'queued' && job.status !== 'running') {
    throw new Error('agent-loop-turnjob-status-not-active');
  }
  const registration = MAINTENANCE_TASK_KIND_REGISTRY[job.taskKind];
  const runId = token(job.runId, 'runid');
  const now = input.now;
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) {
    throw new Error('agent-loop-turnjob-now-invalid');
  }
  const taskId = `agentloop.maintenance.${runId}`;
  const zeroBudget = {
    modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0, outputTokens: 0,
    costMicrousd: 0, wallMs: 0, highRiskActions: 0, childTasks: 0,
  };
  const envelope = normalizeAgentLoopTaskEnvelope({
    contractVersion: 'agent-loop-task-envelope-v1',
    taskId,
    rootTaskId: taskId,
    dependencyTaskIds: [],
    currentAttemptId: undefined,
    taskContractRef: registration.contractRef,
    taskKind: registration.taskKind,
    state: 'CREATED',
    phase: 'PREPARE',
    goal: {
      summary: registration.goalSummary,
      sourceRefs: [`maintenancejob.${runId}`, `revision.${job.sourceRevision}`],
    },
    todos: [],
    confirmedFacts: [],
    blockers: [],
    children: [],
    artifacts: [],
    budget: {
      policyRef: `agent.budget.${registration.budgetProfileRef}`,
      granted: zeroBudget,
      reserved: zeroBudget,
      spent: zeroBudget,
    },
    verifier: {
      verifierSetRef: registration.verifierSetRef,
      verifierSetRevision: registration.verifierSetRevision,
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return Object.freeze({
    version: AGENT_LOOP_TURNJOB_SHADOW_VERSION,
    taskKind: registration.taskKind,
    taskId,
    envelope,
    envelopeDigest: digestOf(envelope),
    shadow: true,
  });
}

import {
  AgentLoopProjectionError,
  type AgentLoopProjectionStore,
  type AgentLoopTaskRecord,
} from './agent-loop-projection-store.ts';

export type AgentLoopShadowSourceState = 'active' | 'terminal' | 'unavailable';
export interface AgentLoopShadowSourceReaders {
  readTurnJob(runId: string): PublicTurnJob | null;
  readMaintenanceJob(runId: string): PublicMaintenanceJob | null;
}
export interface ShadowJobPhaseOutcome {
  readonly projected: boolean;
  readonly fenced: boolean;
  /** Another unexpired owner still holds the lease; no authority was borrowed or stolen. */
  readonly deferred?: true;
}
const TURN_TERMINAL = new Set<string>(['succeeded', 'failed', 'cancelled']);
const MAINTENANCE_TERMINAL = new Set<string>(['succeeded', 'failed', 'cancelled', 'stale']);

function matchesShadowSource(envelope: AgentLoopTaskEnvelopeV1, projection: ShadowTurnJobProjectionV1): boolean {
  // A terminal fence advances only revision/updatedAt. Every source, route and
  // semantic field must still equal the original pure projection.
  return JSON.stringify({ ...envelope, revision: 1, updatedAt: envelope.createdAt })
    === JSON.stringify(projection.envelope);
}

/**
 * Trusted composition-root readback of the content-free refs actually stored by
 * this shadow version. This is not complete DTO/session/policy authorization and
 * grants no execution permission; a future live adapter must bind fresh authority.
 * A lifecycle label or a missing source alone is never terminal proof.
 */
export function shadowJobSourceState(
  envelope: AgentLoopTaskEnvelopeV1,
  readers: AgentLoopShadowSourceReaders,
): AgentLoopShadowSourceState {
  try {
    if (envelope.taskId.startsWith('agentloop.turn.')) {
      const runId = token(envelope.taskId.slice('agentloop.turn.'.length), 'runid');
      const job = readers.readTurnJob(runId);
      if (!job || job.runId !== runId || !isTurnJobAction(job.action)) return 'unavailable';
      const terminal = TURN_TERMINAL.has(job.status);
      if (!terminal && !['queued', 'running', 'recovering'].includes(job.status)) return 'unavailable';
      const projection = buildShadowTurnJobEnvelope({ job: { ...job, status: 'running' }, now: envelope.createdAt });
      return matchesShadowSource(envelope, projection) ? terminal ? 'terminal' : 'active' : 'unavailable';
    }
    if (envelope.taskId.startsWith('agentloop.maintenance.')) {
      const runId = token(envelope.taskId.slice('agentloop.maintenance.'.length), 'runid');
      const job = readers.readMaintenanceJob(runId);
      if (!job || job.runId !== runId) return 'unavailable';
      const terminal = MAINTENANCE_TERMINAL.has(job.status);
      if (!terminal && !['queued', 'running'].includes(job.status)) return 'unavailable';
      const projection = buildShadowMaintenanceJobEnvelope({ job: { ...job, status: 'running' }, now: envelope.createdAt });
      return matchesShadowSource(envelope, projection) ? terminal ? 'terminal' : 'active' : 'unavailable';
    }
  } catch { /* Uninitialized, corrupt or mismatched legacy readers fail closed. */ }
  return 'unavailable';
}

/** Source settlement may revoke only a pristine shadow, never work already owned by a Coordinator. */
export function isPristineShadowProjection(store: AgentLoopProjectionStore, record: AgentLoopTaskRecord): boolean {
  const task = record.envelope;
  const events = store.readEvents(task.taskId);
  return task.state === 'CREATED' && task.phase === 'PREPARE' && task.currentAttemptId === undefined
    && task.plan === undefined && task.wait === undefined && task.completion === undefined
    && task.rootTaskId === task.taskId && task.parentTaskId === undefined && task.dependencyTaskIds.length === 0
    && task.todos.length === 0 && task.confirmedFacts.length === 0 && task.blockers.length === 0
    && task.children.length === 0 && task.artifacts.length === 0
    && Object.values(task.budget.granted).every((value) => value === 0)
    && Object.values(task.budget.reserved).every((value) => value === 0)
    && Object.values(task.budget.spent).every((value) => value === 0)
    && record.revision === (record.fenced ? 2 : 1)
    && store.readRefs(task.taskId).length === 0 && store.readObservations(task.taskId).length === 0
    && events.length === (record.fenced ? 2 : 1)
    && events.filter((event) => event.kind === 'task-created').length === 1
    && events.every((event) => event.kind === 'task-created'
      || (record.fenced && event.kind === 'task-fenced'));
}

/** Uses only the caller's normal lease/CAS permissions; an unexpired foreign lease explicitly defers. */
export function fenceSettledShadowProjection(
  store: AgentLoopProjectionStore,
  record: AgentLoopTaskRecord,
  input: Readonly<{ ownerId: string; reasonCode: 'turn-settled' | 'maintenance-settled' | 'legacy-source-terminal' }>,
): ShadowJobPhaseOutcome {
  if (!isPristineShadowProjection(store, record)) throw new Error('agent-loop-shadow-projection-not-pristine');
  if (record.fenced) return Object.freeze({ projected: false, fenced: true });
  try {
    const claimed = store.claimLease({ taskId: record.envelope.taskId, expectedRevision: record.revision,
      ownerId: input.ownerId, leaseMs: 300_000 });
    store.fence({ taskId: claimed.envelope.taskId, expectedRevision: claimed.revision,
      ownerId: input.ownerId, reasonCode: input.reasonCode });
    return Object.freeze({ projected: false, fenced: true });
  } catch (error) {
    if (error instanceof AgentLoopProjectionError
      && (error.code === 'agent-loop-projection-lease-lost' || error.code === 'agent-loop-projection-revision-conflict')) {
      return Object.freeze({ projected: false, fenced: false, deferred: true });
    }
    throw error;
  }
}

export type ProjectionPersistOutcome =
  | Readonly<{ created: true }>
  | Readonly<{ created: false; replayed: true; reasonCode: 'replayed' }>
  | Readonly<{ created: false; replayed: false; reasonCode: 'conflict' }>;

/**
 * 把投影写进权威 Store（shadow → 真实投影的唯一入口）。
 *
 * 幂等语义：taskId 已存在时，**逐字段比较**存储的信封与投影信封——
 * 完全一致 ⇒ 幂等重放（不产生第二个事件）；不一致 ⇒ conflict 并抛错，
 * **绝不覆盖**（第一个创建者拥有这个 taskId，后到者无权改写）。
 * 注意不能用摘要比较：本模块的 digestOf 与 Store 的 hash 口径不保证一致，
 * 逐字段 JSON 比较才是契约。
 */
export function persistProjectionIntoStore(
  store: AgentLoopProjectionStore,
  projection: ShadowTurnJobProjectionV1,
  options: Readonly<{ ownerId: string; leaseMs?: number; eventId?: string }>,
): ProjectionPersistOutcome {
  const existing = store.read(projection.taskId);
  if (existing) {
    const identical = JSON.stringify(existing.envelope) === JSON.stringify(projection.envelope);
    if (identical) return Object.freeze({ created: false, replayed: true, reasonCode: 'replayed' });
    throw new Error('agent-loop-turnjob-projection-conflict');
  }
  store.create({
    envelope: projection.envelope,
    ownerId: options.ownerId,
    leaseMs: options.leaseMs ?? 86_400_000,
    event: {
      eventId: options.eventId ?? `event.created:${projection.taskId}`,
      kind: 'task-created',
    },
  });
  return Object.freeze({ created: true });
}

/**
 * TurnJob 生命周期钩子：running ⇒ 投影落库；settled ⇒ 围栏（恢复永不复活完成的回合）。
 * 其余 phase 原样忽略。抛错由调用方决定是否吞掉——server.ts 的策略是
 * 「投影/围栏失败不阻断回合主路径」，这里只保证不产生半写状态。
 */
export function handleTurnJobPhase(
  store: AgentLoopProjectionStore,
  input: Readonly<{ job: PublicTurnJob; phase: 'queued' | 'running' | 'settled'; ownerId: string; now: string }>,
): ShadowJobPhaseOutcome {
  if (input.phase === 'running') {
    const projection = buildShadowTurnJobEnvelope({ job: input.job, now: input.job.createdAt });
    persistProjectionIntoStore(store, projection, { ownerId: input.ownerId });
    return Object.freeze({ projected: true, fenced: false });
  }
  if (input.phase === 'settled') {
    if (!TURN_TERMINAL.has(input.job.status)) throw new Error('agent-loop-shadow-source-not-terminal');
    const record = store.read(`agentloop.turn.${input.job.runId}`);
    if (record) {
      if (shadowJobSourceState(record.envelope, {
        readTurnJob: () => input.job, readMaintenanceJob: () => null,
      }) !== 'terminal') throw new Error('agent-loop-shadow-source-mismatch');
      return fenceSettledShadowProjection(store, record, { ownerId: input.ownerId, reasonCode: 'turn-settled' });
    }
    return Object.freeze({ projected: false, fenced: false });
  }
  return Object.freeze({ projected: false, fenced: false });
}

/** Metadata-only sidecar of the existing Maintenance Manager; never executes or resumes a job. */
export function handleMaintenanceJobPhase(
  store: AgentLoopProjectionStore,
  input: Readonly<{ job: PublicMaintenanceJob; phase: 'enqueued' | 'settled'; ownerId: string; now: string }>,
): ShadowJobPhaseOutcome {
  if (input.phase === 'enqueued') {
    // A replay may already be terminal in the authoritative Manager. Repair an
    // existing shadow only; never manufacture an active task for a missing one.
    if (MAINTENANCE_TERMINAL.has(input.job.status)) {
      return handleMaintenanceJobPhase(store, { ...input, phase: 'settled' });
    }
    const projection = buildShadowMaintenanceJobEnvelope({ job: input.job, now: input.job.createdAt });
    persistProjectionIntoStore(store, projection, { ownerId: input.ownerId });
    return Object.freeze({ projected: true, fenced: false });
  }
  if (input.phase === 'settled') {
    if (!MAINTENANCE_TERMINAL.has(input.job.status)) throw new Error('agent-loop-shadow-source-not-terminal');
    const record = store.read(`agentloop.maintenance.${input.job.runId}`);
    if (!record) return Object.freeze({ projected: false, fenced: false });
    if (shadowJobSourceState(record.envelope, {
      readTurnJob: () => null, readMaintenanceJob: () => input.job,
    }) !== 'terminal') throw new Error('agent-loop-shadow-source-mismatch');
    return fenceSettledShadowProjection(store, record, { ownerId: input.ownerId, reasonCode: 'maintenance-settled' });
  }
  return Object.freeze({ projected: false, fenced: false });
}
