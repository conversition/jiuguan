/** @author Codex @date 2026-10-20 @version 1.0
 * P17-02.1 恢复入口：租约过期 / 进程重启后，把可恢复任务**接管**并重建续跑上下文。
 *
 * 组合的三块积木全部是已验收组件：
 * `scanRecoverable`（AL-1：未围栏 + 非终态 + 租约过期/缺失，坏行只计数）
 * → `claimLease`（CAS 接管，抢占不推进 revision，旧 owner 立即失权）
 * → `recoverAgentLoopContinuation`（CX-4：仅凭权威投影 + ref 重建快照与 continuation）。
 *
 * 两条纪律：
 * 1. **接管失败不是错误**：另一个 worker 先抢到（revision CAS 失败）⇒ 跳过并记录原因，
 *    绝不抛错拖垮整批恢复；
 * 2. **每次恢复都有凭据**：返回值带 continuation 摘要，调用方拿不到就说明这条没恢复成功。
 */
import type { AgentLoopProjectionStore, AgentLoopTaskRecord, AgentLoopRecoveryCursor } from './agent-loop-projection-store.ts';
import type { AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import {
    fenceSettledShadowProjection,
    isPristineShadowProjection,
    type AgentLoopShadowSourceState,
} from './agent-loop-turnjob-shadow.ts';
import {
    recoverAgentLoopContinuation,
    type AgentLoopRefResolver,
} from './agent-loop-continuation.ts';
import { MaintenanceJobManager } from './maintenance-job-manager.ts';
import { reconcileAgentLoopShadowPublication,
  reconcileAgentLoopCorrectionShadowPublication } from './agent-loop-shadow-publication.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF } from './agent-loop-model-correction.ts';
import { reconcileAgentLoopSummaryApplyCompletion } from './agent-loop-summary-apply-completion.ts';
import { MAINTENANCE_TASK_KIND_REGISTRY } from './agent-loop-turnjob-shadow.ts';

export const AGENT_LOOP_RECOVERY_VERSION = 'agent-loop-recovery-v1' as const;

export interface AgentLoopRecoveryOptions {
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly limit?: number;
  readonly after?: AgentLoopRecoveryCursor;
  readonly resolvers?: Record<string, AgentLoopRefResolver>;
  /** Trusted legacy Manager readback. Missing/mismatched/uninitialized sources are unavailable, never active. */
  readonly sourceState?: (envelope: AgentLoopTaskEnvelopeV1) => AgentLoopShadowSourceState;
  /** Original Manager may not exist during early server startup. This lazy host
   * reader grants only historical publication metadata reconciliation. */
  readonly shadowPublication?: Readonly<{
    readManager: () => MaintenanceJobManager | null;
    clock: () => string;
  }>;
  /** Independent committed apply history. No Session, continuation or execution
   * authority is reconstructed by this lazy metadata-only host seam. */
  readonly summaryApplyCompletion?: Readonly<{
    readManager: () => MaintenanceJobManager | null;
    clock: () => string;
  }>;
}

export type AgentLoopTakeover =
  | Readonly<{ taskId: string; takeover: 'claimed'; continuationDigest: string; taskRevision: number }>
  | Readonly<{ taskId: string; takeover: 'publication-reconciled'; status: 'completed' | 'already-completed'; taskRevision: number }>
  | Readonly<{ taskId: string; takeover: 'summary-apply-reconciled'; status: 'completed' | 'already-completed'; taskRevision: number }>
  | Readonly<{ taskId: string; takeover: 'skipped'; reasonCode:
      | 'agent-loop-recovery-claim-conflict'
      | 'agent-loop-recovery-fenced'
      | 'agent-loop-recovery-terminal'
      | 'agent-loop-recovery-suspended'
      | 'agent-loop-recovery-source-unavailable'
      | 'agent-loop-recovery-publication-rejected'
      | 'agent-loop-recovery-summary-apply-rejected' }>;

export interface AgentLoopRecoveryReport {
  readonly version: typeof AGENT_LOOP_RECOVERY_VERSION;
  readonly ownerId: string;
  readonly scanned: number;
  readonly claimed: number;
  readonly skipped: number;
  /** Present only for the explicitly selected historical publication seam.
   * These completions are NOT continuation reconstruction or execution claims. */
  readonly publicationReconciled?: number;
  /** Historical apply completions, never continuation/execution claims. */
  readonly summaryApplyReconciled?: number;
  readonly takeovers: readonly AgentLoopTakeover[];
  readonly nextCursor: AgentLoopRecoveryCursor | null;
}

function summaryApplyTakeoverOf(store: AgentLoopProjectionStore, record: AgentLoopTaskRecord,
  options: AgentLoopRecoveryOptions): AgentLoopTakeover | null {
  // The closed correction contract only produces shadow proposals. It cannot
  // borrow an apply receipt or fall through an apply-mode legacy source.
  if (record.envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF) return null;
  if (!options.summaryApplyCompletion || record.envelope.taskKind !== MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary.taskKind) return null;
  const binding = /^agentloop\.maintenance\.(mjob_[a-f0-9]{32})$/u.exec(record.envelope.taskId);
  if (!binding) return null;
  const taskId = record.envelope.taskId;
  const observeNativePromise = (value: unknown) => {
    if (value !== null && typeof value === 'object') {
      try { void Promise.prototype.then.call(value, () => undefined, () => undefined); }
      catch { /* Never read or assimilate an arbitrary then getter. */ }
    }
  };
  try {
    const manager: unknown = options.summaryApplyCompletion.readManager();
    observeNativePromise(manager);
    if (manager === null) return Object.freeze({ taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-source-unavailable' });
    if (!(manager instanceof MaintenanceJobManager)) throw new Error('summary-apply-reader-invalid');
    const committed = manager.readAgentLoopSummaryApplyCompletion(binding[1]!);
    if (!committed) {
      const job = manager.get(binding[1]!);
      if (!job) return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-source-unavailable' });
      // Keep ordinary legacy/pristine source fencing intact. A progressed apply
      // with no verified Manager commit may NOT fall into generic continuation,
      // even when the native Session write itself has already committed.
      if (job.mode !== 'apply' || isPristineShadowProjection(store, record)) return null;
      throw new Error('summary-apply-history-uncommitted');
    }
    const result = reconcileAgentLoopSummaryApplyCompletion({ store, manager, ownerId: options.ownerId,
      clock: () => {
        const value: unknown = options.summaryApplyCompletion!.clock();
        observeNativePromise(value);
        return typeof value === 'string' ? value : 'invalid-recovery-clock';
      }, runId: binding[1]!, taskId, leaseMs: options.leaseMs });
    return Object.freeze({ taskId, takeover: 'summary-apply-reconciled', status: result.status,
      taskRevision: result.record.revision });
  } catch {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-summary-apply-rejected' });
  }
}

function publicationTakeoverOf(store: AgentLoopProjectionStore, record: AgentLoopTaskRecord,
  options: AgentLoopRecoveryOptions): AgentLoopTakeover | null {
  const taskId = record.envelope.taskId;
  const correction = record.envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF;
  if (record.envelope.taskKind !== MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary.taskKind) {
    return correction ? Object.freeze({ taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-publication-rejected' }) : null;
  }
  if (!options.shadowPublication) {
    return correction ? Object.freeze({ taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-source-unavailable' }) : null;
  }
  // This fixed run/task mapping is not a ref-selected reader or a guessed proof.
  const binding = /^agentloop\.maintenance\.(mjob_[a-f0-9]{32})$/u.exec(record.envelope.taskId);
  if (!binding) return correction ? Object.freeze({ taskId, takeover: 'skipped',
    reasonCode: 'agent-loop-recovery-publication-rejected' }) : null;
  const observeNativePromise = (value: unknown) => {
    if (value !== null && typeof value === 'object') {
      try { void Promise.prototype.then.call(value, () => undefined, () => undefined); }
      catch { /* Never read/execute a foreign thenable's then getter. */ }
    }
  };
  try {
    const manager: unknown = options.shadowPublication.readManager();
    observeNativePromise(manager);
    if (manager === null) return Object.freeze({ taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-source-unavailable' });
    if (!(manager instanceof MaintenanceJobManager)) throw new Error('publication-reader-invalid');
    const published = manager.readAgentLoopShadowPublication(binding[1]!);
    if (!published) {
      if (correction) throw new Error('correction-publication-history-uncommitted');
      return null; // Ordinary progressed/legacy recovery stays unchanged.
    }
    if (!correction && record.envelope.taskContractRef !== MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary.contractRef) {
      throw new Error('publication-contract-mismatch');
    }
    const reconcile = correction ? reconcileAgentLoopCorrectionShadowPublication : reconcileAgentLoopShadowPublication;
    const result = reconcile({ store, manager, ownerId: options.ownerId,
      clock: () => {
        const value: unknown = options.shadowPublication!.clock();
        observeNativePromise(value);
        return typeof value === 'string' ? value : 'invalid-recovery-clock';
      }, runId: binding[1]!, taskId, leaseMs: options.leaseMs });
    return Object.freeze({ taskId, takeover: 'publication-reconciled', status: result.status,
      taskRevision: result.record.revision });
  } catch {
    // A bad publication must never fall through to generic continuation/lease
    // recovery. Per-row rejection does not stop later candidates in the batch.
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-publication-rejected' });
  }
}

function sourceStateOf(options: AgentLoopRecoveryOptions, record: AgentLoopTaskRecord): AgentLoopShadowSourceState | undefined {
  if (!options.sourceState) return undefined;
  try {
    const state = options.sourceState(record.envelope);
    return state === 'active' || state === 'terminal' ? state : 'unavailable';
  } catch { return 'unavailable'; }
}

function terminalSource(
  store: AgentLoopProjectionStore,
  record: AgentLoopTaskRecord,
  options: AgentLoopRecoveryOptions,
): AgentLoopTakeover {
  // Never revoke a Coordinator's progressed task, typed refs or action ledger
  // using a legacy sidecar. It is still ineligible for shadow reconstruction.
  if (isPristineShadowProjection(store, record)) {
    fenceSettledShadowProjection(store, record, { ownerId: options.ownerId, reasonCode: 'legacy-source-terminal' });
  }
  return Object.freeze({ taskId: record.envelope.taskId, takeover: 'skipped',
    reasonCode: 'agent-loop-recovery-terminal' });
}

async function takeoverOf(
  store: AgentLoopProjectionStore,
  record: AgentLoopTaskRecord,
  options: AgentLoopRecoveryOptions,
): Promise<AgentLoopTakeover> {
  const taskId = record.envelope.taskId;
  if (record.envelope.state.startsWith('WAITING_') || record.envelope.state === 'PAUSED') {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-suspended' });
  }
  const summaryApply = summaryApplyTakeoverOf(store, record, options);
  if (summaryApply) return summaryApply;
  const publication = publicationTakeoverOf(store, record, options);
  if (publication) return publication;
  const beforeSource = sourceStateOf(options, record);
  if (beforeSource === 'unavailable') return Object.freeze({ taskId, takeover: 'skipped',
    reasonCode: 'agent-loop-recovery-source-unavailable' });
  if (beforeSource === 'terminal' && !isPristineShadowProjection(store, record)) {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-terminal' });
  }
  try {
    store.claimLease({
      taskId,
      expectedRevision: record.revision,
      ownerId: options.ownerId,
      leaseMs: options.leaseMs,
    });
  } catch {
    // CAS 失败 = 别的 worker 先接管了。这是正常竞争，跳过而不是报错。
    return Object.freeze({
      taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-claim-conflict',
    });
  }
  const current = store.read(taskId);
  if (!current) {
    return Object.freeze({
      taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-claim-conflict',
    });
  }
  if (current.fenced) {
    return Object.freeze({ taskId, takeover: 'skipped',
      reasonCode: 'agent-loop-recovery-fenced' });
  }
  const claimedSource = sourceStateOf(options, current);
  if (claimedSource === 'unavailable' || (beforeSource === 'terminal' && claimedSource !== 'terminal')) {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-source-unavailable' });
  }
  if (claimedSource === 'terminal') return terminalSource(store, current, options);
  const continuation = await recoverAgentLoopContinuation({
    store, taskId, resolvers: options.resolvers ?? {},
  });
  const latest = store.read(taskId);
  if (!latest || latest.ownerId !== options.ownerId || latest.revision !== continuation.snapshot.taskRevision) {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-claim-conflict' });
  }
  if (latest.fenced) return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-fenced' });
  // Ref expansion can await external read-only resolvers. The source may have
  // settled or disappeared meanwhile; neither may be reported as reconstructed.
  const finalSource = sourceStateOf(options, latest);
  if (finalSource === 'unavailable') return Object.freeze({ taskId, takeover: 'skipped',
    reasonCode: 'agent-loop-recovery-source-unavailable' });
  if (finalSource === 'terminal') return terminalSource(store, latest, options);
  // A slow read-only resolver may outlive the lease without changing owner or
  // revision. Reconfirm through the normal CAS API before reporting a claim.
  let confirmed: AgentLoopTaskRecord;
  try {
    confirmed = store.claimLease({ taskId, expectedRevision: latest.revision,
      ownerId: options.ownerId, leaseMs: options.leaseMs });
  } catch {
    return Object.freeze({ taskId, takeover: 'skipped', reasonCode: 'agent-loop-recovery-claim-conflict' });
  }
  const confirmedSource = sourceStateOf(options, confirmed);
  if (confirmedSource === 'unavailable') return Object.freeze({ taskId, takeover: 'skipped',
    reasonCode: 'agent-loop-recovery-source-unavailable' });
  if (confirmedSource === 'terminal') return terminalSource(store, confirmed, options);
  return Object.freeze({
    taskId,
    takeover: 'claimed',
    continuationDigest: continuation.continuation.continuationDigest,
    taskRevision: continuation.snapshot.taskRevision,
  });
}

/** 恢复一轮：扫描 → 接管 → 重建续跑上下文。只写租约，不推进任务语义。 */
export async function recoverStaleAgentLoopTasks(
  store: AgentLoopProjectionStore,
  options: AgentLoopRecoveryOptions,
): Promise<AgentLoopRecoveryReport> {
  const scan = store.scanRecoverable({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.after === undefined ? {} : { after: options.after }),
  });
  const takeovers = await Promise.all(scan.tasks.map((record) => takeoverOf(store, record, options)));
  const claimed = takeovers.filter((item) => item.takeover === 'claimed').length;
  const publicationReconciled = takeovers.filter((item) => item.takeover === 'publication-reconciled').length;
  const summaryApplyReconciled = takeovers.filter((item) => item.takeover === 'summary-apply-reconciled').length;
  return Object.freeze({
    version: AGENT_LOOP_RECOVERY_VERSION,
    ownerId: options.ownerId,
    scanned: scan.tasks.length,
    claimed,
    skipped: takeovers.length - claimed - publicationReconciled - summaryApplyReconciled,
    ...(options.shadowPublication === undefined ? {} : { publicationReconciled }),
    ...(options.summaryApplyCompletion === undefined ? {} : { summaryApplyReconciled }),
    takeovers: Object.freeze(takeovers),
    nextCursor: scan.nextCursor,
  });
}
