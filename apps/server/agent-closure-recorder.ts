import { createHash } from 'node:crypto';
import {
  AGENT_CLOSURE_CAPABILITY_CONTRACTS,
  agentClosureOperationId,
  agentClosureProposalMode,
  agentClosureTimestamp,
  executionClassForLearningSession,
  executionClassForMaintenanceTrigger,
  type AgentClosureCapability,
  type AgentClosureExecutionClass,
  type AgentClosureProposalMode,
  type AgentSkillClosureAttributionV1,
} from '../../packages/agent-closure/index.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';
import { AgentClosureStore } from './agent-closure-store.ts';
import { memoryWriteReadbackForIdentity } from './maintenance-memory-write-receipt.ts';
import { summaryWriteReadbackForIdentity } from './maintenance-summary-write-receipt.ts';

/**
 * P16 C1：`branch_index` 任务实际产出 Arc projection，唯一归属是 `maintenance.arc`；
 * `maintenance.branchIndex` 保留为 legacy/shared alias，只用于历史记录与显示
 * （见 contract 的 `AGENT_CLOSURE_CAPABILITY_ALIASES`）。
 */
/**
 * taskKind → 闭环能力的**唯一归属**。
 *
 * ⚠️ 它必须与控制面 `agentCapabilitiesForAdmission()` 保持一致：两边不一致时，
 * 操作者能 kill 的能力名与账本里记录的能力名会是两个东西 —— 结果是某个能力
 * **既杀不掉也看不见**。`rolling_summary` 曾归 `maintenance.summary`（那个名字不在控制面
 * 注册表里），现已折进 `maintenance.memory`。守卫测试逐条对账，不允许再漂移。
 *
 * `branch_index` 是唯一允许的例外：控制面按历史兼容同时暴露 `maintenance.branchIndex`
 * 与 `maintenance.arc`，账本只记 `maintenance.arc`（合同里已声明为别名关系）。
 */
export const MAINTENANCE_CAPABILITY = Object.freeze({
  memory_consolidation: 'maintenance.memory',
  branch_index: 'maintenance.arc',
  rolling_summary: 'maintenance.memory',
  npc_state: 'maintenance.npc',
  worldbook_repair: 'maintenance.worldbook',
} as const satisfies Record<PublicMaintenanceJob['taskKind'], AgentClosureCapability>);

export type MaintenanceClosureLifecycleEvent = Readonly<{
  phase: 'enqueued' | 'settled';
  job: PublicMaintenanceJob;
  replayed?: boolean;
  proposalId?: string;
}>;

/**
 * 世界书修正控制面（create / apply / revert）的转换回执。
 *
 * 该领域**不**使用 `maintenance_pending_proposal`，因此 `proposal-persisted` 与
 * `artifact-validated` 也在这里补记，而且必须与控制面用**同一份** proposalDigest ——
 * 用两套摘要会让血缘折叠判 digest-mismatch 并丢掉整条证据。
 */
export interface WorldbookRepairClosureTransition {
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly changeCount: number;
  readonly status: 'created' | 'applied' | 'reverted' | 'stale' | 'rejected';
  readonly occurredAt: string;
  /** 提交后重新读出的世界书投影摘要；缺省即"回读未成立"，不会被提升为 verified。 */
  readonly readbackDigest?: string;
  /** apply/revert 的目标版本（asset 层 revision）。 */
  readonly targetRevision?: string;
  /** rolled-back 需要一个稳定的回滚摘要。 */
  readonly rollbackDigest?: string;
  readonly reasonCode?: string;
}

/**
 * Style（`learning.styleCompile`）提案的创建回执。
 *
 * 与维护 lane 最大的差异：**提案没有 job**，它在会话回合里产生，激活却是操作者动作
 * （可能发生在几天后、另一个进程里）。因此唯一跨阶段稳定的标识是**提案 id**，
 * 而不是回合 runId —— 操作者激活时 runId 早已不可得。
 */
export interface StyleCompileClosureIdentity {
  readonly proposalId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  /**
   * 提案**首个**版本的 sourceDigest（`sha256:...`），也是整条血缘的 artifactDigest。
   * 必须固定为 v1 而不是"当前版本"：`revise()` 会追加新版本，若拿当前版本当血缘摘要，
   * 修订过的提案会因 digest 不匹配而永远停在 `validated`。
   */
  readonly sourceDigest: string;
  readonly profileVersion: string;
  readonly policyVersion: string;
  /**
   * 会话种类：**唯一**决定证据来源（P16 C2.3）。缺省 / 未知一律 fail-closed 记 fixture。
   */
  readonly sessionKind?: 'production' | 'replay' | 'unknown';
}

/** Style 提案控制面的转换回执（操作者 approve / rollback / disable）。 */
export interface StyleCompileClosureTransition {
  readonly proposalId: string;
  /** 必须与创建时 `proposal-persisted` 同源（首个版本的 sourceDigest），否则血缘折叠拒绝。 */
  readonly lineageDigest: string;
  readonly occurredAt: string;
  readonly status: 'applied' | 'reverted' | 'disabled';
  /** 激活之后从磁盘重读 proposal + 核对派生 Skill 绑定得到的摘要。 */
  readonly readbackDigest?: string;
  readonly targetRevision?: string;
  readonly reasonCode?: string;
}

/**
 * 交互类 Agent 的消费回执（P16 C3）。
 *
 * 与维护/学习类不同：交互类工件是**回合内临时件**（prelude 的变量补丁/导演计划、critic 判定），
 * 提交之前随时可能因校验失败、修稿或中止而作废。因此 session 只在**回合提交成功之后**
 * 一次性发出，账本也在同一时刻记 `execution-completed → artifact-validated → context-consumed`：
 * "加载了"不算消费，"真的进了这一回合且这一回合真的提交了"才算。
 *
 * 这几个能力都是 `advisory`：合同明确禁止它们有 apply/readback 证据，
 * 所以在 C5 未接线时 `consumed` 就是它们的终点。
 */
export interface InteractiveArtifactObservation {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly executionClass: AgentClosureExecutionClass;
  readonly artifacts: readonly Readonly<{
    readonly capability: 'interactive.prelude' | 'interactive.variableProposal' | 'interactive.critic';
    readonly artifactDigest: string;
    readonly contextBlock: string;
  }>[];
}

/**
 * 方向/偏好**沉淀**落库的回执（P16 C3.3，proposal-persisted 一侧）。
 *
 * 与维护/学习类不同：这里的「产物」是**从学习证据派生出的语义沉淀**（高发方向 +
 * 偏好轴的简练提示词），不是模型提案。它是真实持久化、真实被应用、真实可回读的，
 * 因此合同里 `learning.preference` / `learning.branchPreference` 维持 `proposal`。
 * CAS 由学习层自管（`preferenceEpoch` + 证据修订），闭环层不另立修订权威。
 */
export interface DirectionConsolidationObservation {
  readonly rawSessionId: string;
  /** 产出该沉淀的回合 runId；同一条 run 的后续 apply 都记在它头上。 */
  readonly runId: string;
  readonly sourceRevision: string;
  readonly executionClass: AgentClosureExecutionClass;
  readonly capability: 'learning.preference' | 'learning.branchPreference';
  readonly artifactDigest: string;
  readonly evidenceRef: string;
}

/**
 * 沉淀结果**真的进了某一回合并提交成功**的回执（apply / readback / consumed 一侧）。
 * `runId` 是产出沉淀的回合（来自快照），`consumingRunId` 才是本回合。
 */
export interface DirectionApplicationObservation {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly consumingRunId: string;
  /** ⚠️ 必须是**产出沉淀那一回合**的修订（血缘锚），不是消费回合的。 */
  readonly sourceRevision: string;
  readonly executionClass: AgentClosureExecutionClass;
  readonly capability: 'learning.preference' | 'learning.branchPreference';
  readonly artifactDigest: string;
  readonly readbackDigest: string;
  readonly targetRevision: string;
  readonly contextBlock: string;
  readonly evidenceRef: string;
}

/**
 * 变量提案**作为写入**的完整回执（P16 W2，用户裁定：变量提案=写入）。
 * 补丁在事务内应用、提交成功后重读变量逐一比对吻合才发；同回合完成全部里程碑，
 * 因此不存在跨回合血缘问题（sourceRevision 全程 = 提交回合的修订）。
 */
export interface VariableProposalAppliedObservation {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly executionClass: AgentClosureExecutionClass;
  readonly artifactDigest: string;
  readonly readbackDigest: string;
  readonly targetRevision: string;
}

/** AQL 重规划建议的生成回执（P16 W3，advisory）。 */
export interface AqlReplanObservation {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly executionClass: AgentClosureExecutionClass;
  readonly artifactDigest: string;
}

/**
 * 效果观测（P16 E1，用户裁定：不再跳过效果观测器）。
 *
 * 口径（不引入第二个模型打分）：**负向**=消费它的回合被 regenerate / 删除；
 * **inconclusive**=观测窗口平稳结束（没有负向信号，也没有可采信的正向信号）——
 * 「没被投诉」不推断成 positive；**positive** 留给各领域将来的显式确认信号。
 * effect 事件必须与某条已落库的 context-consumed 在 (artifactDigest, consumerRunId)
 * 上精确配对、且时间不早于消费（合同血缘 join 强制）。
 */
export interface EffectObservation {
  /** 目标 run 的 operationId（产出该工件的 run，不是消费回合）。 */
  readonly operationId: string;
  readonly artifactDigest: string;
  readonly consumerRunId: string;
  readonly effectOutcome: 'positive' | 'neutral' | 'negative' | 'inconclusive';
}

export interface ContextCompilerClosureIdentity {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly policyVersion?: 'p14-q9r-context-compiler-v1' | 'p14-q9r-context-compiler-v2';
  /**
   * Classification from the authoritative runtime gate.  Older/internal
   * callers may omit it, but the recorder then fails safe to non-production.
   */
  readonly executionClass?: AgentClosureExecutionClass;
}

/**
 * P16 C1：证据来源与写权限是两个**正交**字段。
 *
 * 旧实现把 `job.mode` 直接当执行来源（`apply → production`，否则 `shadow`）。但生产
 * 路径被明确禁止 `job.mode=apply`，于是自然生产回合的维护任务永远只能被记成 shadow，
 * 生产闭环在架构上不可达 —— 这是 C1 修正的 P0。
 *
 * 现在来源由**持久化的触发方式**决定：
 * - `post-turn`（自然真实回合）/ `idle`（自然空闲调度）→ `production`；
 * - `manual`（工具 / 离线回放 / 测试）→ `fixture`，在 C4 的 source outbox 能给出
 *   可核对来源之前绝不进入生产分母。
 *
 * 注意：来源**不**因 `proposalMode=shadow`（只产待审批提案）而降级 —— 只产提案的
 * 自然回合仍然是生产证据，只是停在 `validated`。
 */
export function maintenanceClosureExecutionClass(
  job: Pick<PublicMaintenanceJob, 'trigger'>,
): AgentClosureExecutionClass {
  return executionClassForMaintenanceTrigger(job.trigger);
}

/**
 * 写权限 / 审批方式（`shadow` = 只产待审批提案；`apply` = 允许自动写入）。
 * 它不影响证据来源，也不允许被用来绕过审批。
 */
export function maintenanceClosureProposalMode(
  job: Pick<PublicMaintenanceJob, 'mode'>,
): AgentClosureProposalMode {
  return agentClosureProposalMode(job.mode);
}

/** 报告与口径层共用的唯一解释入口：写权限与证据来源分栏，互不推导。 */
export function maintenanceClosureProvenance(
  job: Pick<PublicMaintenanceJob, 'trigger' | 'mode'>,
): Readonly<{ proposalMode: AgentClosureProposalMode; executionClass: AgentClosureExecutionClass }> {
  return Object.freeze({
    proposalMode: maintenanceClosureProposalMode(job),
    executionClass: maintenanceClosureExecutionClass(job),
  });
}

function contextCompilerExecutionClass(
  input: Pick<ContextCompilerClosureIdentity, 'executionClass'>,
): AgentClosureExecutionClass {
  // Unknown provenance is weaker than a witnessed replay. Classify it as a
  // fixture so an older/internal caller can never inflate either production
  // or operational-replay evidence.
  return input.executionClass ?? 'fixture';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex')}`;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** 域内 digest 归一化：`maintenance_job.proposal_digest` 存的是裸 hex，闭环合同要求 `sha256:` 前缀。 */
function contractDigest(value: string): string {
  return /^sha256:[a-f0-9]{64}$/u.test(value) ? value : /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : value;
}

/**
 * 域回执里"写后回读摘要"的通用取值口。
 *
 * 目前三种合法形状（都必须是提交后重新读到的投影摘要，不是备份/应答/公开 diff）：
 * - `readbackDigest`（顶层显式字段，P16 C2 起 NPC 用它）；
 * - `projection.projectionDigest`（Memory / Rolling Summary / Arc 的既有形状）；
 * - `readback.readbackDigest`（版本化 canonical readback 回执；只要没有该键就表示
 *   回读未成立，例如 NPC 的 `unavailable`）。
 */
function explicitReadbackDigest(receipt: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!receipt) return null;
  if (typeof receipt.readbackDigest === 'string' && DIGEST_PATTERN.test(receipt.readbackDigest)) {
    return receipt.readbackDigest;
  }
  const projection = receipt.projection;
  if (projection && typeof projection === 'object' && !Array.isArray(projection)) {
    const projectionDigest = (projection as Record<string, unknown>).projectionDigest;
    if (typeof projectionDigest === 'string' && DIGEST_PATTERN.test(projectionDigest)) {
      return projectionDigest;
    }
  }
  const readback = receipt.readback;
  if (readback && typeof readback === 'object' && !Array.isArray(readback)) {
    const readbackDigest = (readback as Record<string, unknown>).readbackDigest;
    if (typeof readbackDigest === 'string' && DIGEST_PATTERN.test(readbackDigest)) {
      return readbackDigest;
    }
  }
  return null;
}

function reasonCode(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? fallback).toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+/gu, '-')
    .slice(0, 80);
  return /^[a-z][a-z0-9-]{0,79}$/u.test(normalized) ? normalized : fallback;
}

export function maintenanceClosureOperationId(job: Pick<PublicMaintenanceJob, 'runId' | 'taskKind'>): string {
  return agentClosureOperationId('maintenance', job.runId, job.taskKind);
}

export function contextCompilerClosureOperationId(input: Pick<
  ContextCompilerClosureIdentity, 'runId' | 'sourceDigest'
>): string {
  return agentClosureOperationId('context', input.runId, input.sourceDigest);
}

/**
 * Style 提案的 operation id 以**提案 id** 为稳定键（见 `StyleCompileClosureIdentity` 注释）。
 * 创建与操作者激活两条路径都能算出同一个值，因此不需要把 operation id 落库。
 */
/**
 * 方向/偏好沉淀的 operation id：以「产出该沉淀的回合 runId + capability」为稳定键。
 * 同一份沉淀被后续多个回合反复应用时，apply/readback/consumed 都记在**同一条** run 上。
 */
export function directionClosureOperationId(
  runId: string,
  capability: 'learning.preference' | 'learning.branchPreference',
): string {
  return agentClosureOperationId('learning', runId, capability);
}

/** 变量提案（写入）的 operation id；同回合完成全部里程碑。 */
export function variableProposalClosureOperationId(runId: string): string {
  return agentClosureOperationId('interactive', runId, 'interactive.variableProposal');
}

/** AQL 重规划建议的 operation id。 */
export function aqlReplanClosureOperationId(runId: string): string {
  return agentClosureOperationId('interactive', runId, 'interactive.aqlReplan');
}

/**
 * 交互类工件的 operation id：一条 run 只装**一个** capability 的工件。
 * `interactive.director` 与 `interactive.prelude` 共用同一份产出，因此只有后者会真正建 run
 * （前者是合同里声明的别名）。
 */
export function interactiveClosureOperationId(
  runId: string,
  capability: 'interactive.prelude' | 'interactive.variableProposal' | 'interactive.critic',
): string {
  return agentClosureOperationId('interactive', runId, capability);
}

export function styleCompileClosureOperationId(
  input: Pick<StyleCompileClosureIdentity, 'proposalId'>,
): string {
  return agentClosureOperationId('learning', input.proposalId, 'style_compile');
}

/**
 * Anti-corruption adapter. It converts domain receipts into the generic
 * closure vocabulary; business code never sees the closure database.
 * Recording is deliberately non-authoritative and cannot roll back a
 * successful domain commit.
 */
export class AgentClosureRecorder {
  constructor(
    private readonly store: AgentClosureStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onError: (code: string) => void = () => {},
  ) {}

  observeMaintenanceLifecycle(input: MaintenanceClosureLifecycleEvent): void {
    this.#capture('maintenance-lifecycle-record-failed', () => {
      const operationId = this.#ensureMaintenance(input.job);
      if (input.phase !== 'settled') return;
      const at = input.job.finishedAt ?? input.job.updatedAt;
      if (input.job.status === 'succeeded') {
        this.store.record(operationId, {
          type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
          sourceRevision: input.job.sourceRevision,
        });
        if (!input.job.proposal) {
          this.store.record(operationId, {
            type: 'no-op-completed', idempotencyKey: 'no-op-completed', occurredAt: at,
            reasonCode: 'no-applicable-write',
          });
          return;
        }
        // 世界书修正的提案**不落** `maintenance_pending_proposal`，且它有自己的控制面
        // （before-image / CAS / apply / revert + 写后回读）。这里刻意不再记
        // proposal-persisted / artifact-validated，避免与
        // `observeWorldbookRepairTransition` 用两套不同摘要把同一条链路搅成 milestone-conflict。
        if (input.job.taskKind === 'worldbook_repair') return;
        if (input.proposalId) {
          this.store.record(operationId, {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: at,
            artifactDigest: contractDigest(input.job.proposal.digest),
            evidenceRef: input.proposalId,
            sourceRevision: input.job.sourceRevision,
          });
        }
        this.store.record(operationId, {
          type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
          artifactDigest: contractDigest(input.job.proposal.digest),
          sourceRevision: input.job.sourceRevision,
          itemCount: Number.isSafeInteger(input.job.proposal.diff.itemCount)
            ? Number(input.job.proposal.diff.itemCount) : undefined,
        });
        // A legacy direct-commit job exposes only a public diff, not the typed
        // committer receipt. Do not promote that diff to readback evidence.
        return;
      }
      const type = input.job.status === 'cancelled' ? 'cancelled'
        : input.job.status === 'stale' ? 'stale' : 'failed';
      this.store.record(operationId, {
        type,
        idempotencyKey: `settled-${type}`,
        occurredAt: at,
        reasonCode: reasonCode(input.job.errorCode, `maintenance-${type}`),
      });
    });
  }

  observeMaintenanceProposal(
    job: PublicMaintenanceJob,
    proposal: MaintenancePendingProposalRecord,
  ): void {
    this.#capture('maintenance-proposal-record-failed', () => {
      const operationId = this.#ensureMaintenance(job);
      const at = proposal.updatedAt;
      // Recovery may discover the business receipt after an earlier observer
      // failed. Backfill safe milestones idempotently before the transition.
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: job.finishedAt ?? at,
        sourceRevision: proposal.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: proposal.createdAt,
        artifactDigest: proposal.proposalDigest,
        evidenceRef: proposal.proposalId,
        sourceRevision: proposal.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: proposal.createdAt,
        artifactDigest: proposal.proposalDigest,
        sourceRevision: proposal.sourceRevision,
        itemCount: Number.isSafeInteger(proposal.diff.itemCount)
          ? Number(proposal.diff.itemCount) : undefined,
      });
      if (proposal.status === 'applied') {
        const isMemory = proposal.taskKind === 'memory_consolidation';
        const isSummary = proposal.taskKind === 'rolling_summary';
        const requiresCommittedReadback = isMemory || isSummary;
        const identity = {
          runId: job.runId, sessionId: proposal.sessionId,
          sourceRevision: proposal.sourceRevision, proposalDigest: proposal.proposalDigest,
        };
        const domainReadback = isMemory ? memoryWriteReadbackForIdentity(proposal.receipt?.readback, identity)
          : isSummary ? summaryWriteReadbackForIdentity(proposal.receipt?.readback, identity) : null;
        const verifiedReadback = domainReadback && domainReadback.committedAt >= proposal.createdAt
          && domainReadback.verifiedAt <= at
          && (proposal.receipt?.targetRevision === undefined
            || proposal.receipt.targetRevision === domainReadback.targetRevision) ? domainReadback : null;
        const readbackDigest = requiresCommittedReadback ? verifiedReadback?.readbackDigest ?? null
          : explicitReadbackDigest(proposal.receipt);
        const committedTarget = requiresCommittedReadback && typeof proposal.receipt?.targetRevision === 'string'
          && DIGEST_PATTERN.test(proposal.receipt.targetRevision) ? proposal.receipt.targetRevision : null;
        const targetRevision = verifiedReadback?.targetRevision ?? committedTarget ?? readbackDigest ?? digest({
          proposalId: proposal.proposalId,
          receipt: proposal.receipt ?? null,
        });
        let appliedAt = at;
        if (requiresCommittedReadback && typeof proposal.receipt?.committedAt === 'string') {
          const original = agentClosureTimestamp(proposal.receipt.committedAt, 'maintenance-applied-at');
          if (original >= proposal.createdAt && original <= at) appliedAt = original;
        }
        this.store.record(operationId, {
          type: 'apply-committed', idempotencyKey: 'apply-committed',
          occurredAt: verifiedReadback?.committedAt ?? appliedAt,
          artifactDigest: proposal.proposalDigest,
          evidenceRef: proposal.proposalId,
          targetRevision,
        });
        if (readbackDigest) {
          this.store.record(operationId, {
            type: 'readback-verified', idempotencyKey: 'readback-verified',
            occurredAt: verifiedReadback?.verifiedAt ?? at,
            artifactDigest: readbackDigest,
            evidenceRef: proposal.proposalId,
            targetRevision,
          });
        }
      } else if (proposal.status === 'rejected') {
        this.store.record(operationId, {
          type: 'rejected', idempotencyKey: 'proposal-rejected', occurredAt: at,
          reasonCode: reasonCode(proposal.decisionReason, 'proposal-rejected'),
        });
      } else if (proposal.status === 'stale') {
        this.store.record(operationId, {
          type: 'stale', idempotencyKey: 'proposal-stale', occurredAt: at,
          reasonCode: reasonCode(proposal.decisionReason, 'source-revision-stale'),
        });
      } else if (proposal.status === 'rolled_back') {
        const memoryRollback = proposal.taskKind === 'memory_consolidation'
          && typeof proposal.receipt?.rollbackDigest === 'string'
          && DIGEST_PATTERN.test(proposal.receipt.rollbackDigest) ? proposal.receipt.rollbackDigest : null;
        let rolledBackAt = at;
        if (memoryRollback && typeof proposal.receipt?.rolledBackAt === 'string') {
          const original = agentClosureTimestamp(proposal.receipt.rolledBackAt, 'memory-rolled-back-at');
          if (original >= proposal.createdAt && original <= at) rolledBackAt = original;
        }
        this.store.record(operationId, {
          type: 'rolled-back', idempotencyKey: 'proposal-rolled-back', occurredAt: rolledBackAt,
          artifactDigest: memoryRollback ?? digest(proposal.receipt ?? { proposalDigest: proposal.proposalDigest }),
          evidenceRef: proposal.proposalId,
          reasonCode: 'operator-rolled-back',
        });
      }
    });
  }

  /**
   * 世界书修正控制面的转换回执。只追加事件到**已存在**的 run（由维护 job 的生命周期观察创建），
   * 因此不需要在这里重复决定 executionClass。run 不存在时 `record` 抛错并被吞掉 ⇒ 证据保持
   * "未证明"，由 C4 的 reconciler 补录，绝不猜测。
   */
  observeWorldbookRepairTransition(input: WorldbookRepairClosureTransition): void {
    this.#capture('worldbook-repair-transition-record-failed', () => {
      const operationId = agentClosureOperationId('maintenance', input.runId, 'worldbook_repair');
      const at = input.occurredAt;
      const digest = contractDigest(input.proposalDigest);
      this.store.record(operationId, {
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: at,
        artifactDigest: digest, evidenceRef: input.proposalId, sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: digest, sourceRevision: input.sourceRevision,
        itemCount: Number.isSafeInteger(input.changeCount) ? input.changeCount : undefined,
      });
      if (input.status === 'created') return;
      if (input.status === 'stale' || input.status === 'rejected') {
        this.store.record(operationId, {
          type: input.status, idempotencyKey: `worldbook-${input.status}`, occurredAt: at,
          reasonCode: reasonCode(input.reasonCode, `worldbook-repair-${input.status}`),
        });
        return;
      }
      if (input.status === 'reverted') {
        // revert 更新**原链**为 rolled_back，不新建假成功链。
        this.store.record(operationId, {
          type: 'rolled-back', idempotencyKey: 'proposal-rolled-back', occurredAt: at,
          artifactDigest: contractDigest(input.rollbackDigest ?? digest),
          evidenceRef: input.proposalId,
          reasonCode: reasonCode(input.reasonCode, 'worldbook-repair-reverted'),
        });
        return;
      }
      const targetRevision = input.targetRevision ?? contractDigest(input.readbackDigest ?? digest);
      this.store.record(operationId, {
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: at,
        artifactDigest: digest, evidenceRef: input.proposalId, targetRevision,
      });
      if (input.readbackDigest) {
        this.store.record(operationId, {
          type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: at,
          artifactDigest: contractDigest(input.readbackDigest), evidenceRef: input.proposalId, targetRevision,
        });
      }
    });
  }

  /**
   * Style 提案创建（模型草案已通过 evaluator 并落盘）。
   *
   * 此刻提案是 `disabled`：**激活是操作者动作**，必须另行观察。这里只记到
   * `validated`，刻意不预支 apply / readback —— 否则一个从未被批准的提案会被算成闭环。
   */
  beginStyleCompile(input: StyleCompileClosureIdentity): string {
    const operationId = styleCompileClosureOperationId(input);
    this.#capture('style-compile-create-record-failed', () => {
      const at = this.now();
      this.store.begin({
        operationId,
        runId: input.proposalId,
        sessionId: input.sessionId,
        capability: 'learning.styleCompile',
        lane: 'learning',
        kind: 'proposal',
        executionClass: executionClassForLearningSession(input.sessionKind),
        sourceRevision: input.sourceRevision,
        policyVersion: input.policyVersion,
        evidenceDigest: input.sourceDigest,
        admittedAt: at,
      });
      const artifact = contractDigest(input.sourceDigest);
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
        sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: at,
        artifactDigest: artifact, evidenceRef: input.proposalId, sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: artifact, sourceRevision: input.sourceRevision,
      });
    });
    return operationId;
  }

  /**
   * Style 提案控制面的转换回执（操作者 approve / rollback / disable）。
   *
   * 只向**已存在**的 run 追加事件：run 不存在时 `record` 抛错并被吞掉 ⇒ 证据保持
   * "未证明"，由 C4 的 reconciler 补录，绝不猜测来源或执行方式。
   */
  observeStyleCompileTransition(input: StyleCompileClosureTransition): void {
    this.#capture('style-compile-transition-record-failed', () => {
      const operationId = styleCompileClosureOperationId(input);
      const at = input.occurredAt;
      const artifact = contractDigest(input.lineageDigest);
      if (input.status === 'disabled' || input.status === 'reverted') {
        // 停用与回滚都落在**原链**上：不新建假成功链，也不删除已成立的读回证据。
        this.store.record(operationId, {
          type: 'rolled-back',
          idempotencyKey: input.status === 'disabled' ? 'style-proposal-disabled' : 'proposal-rolled-back',
          occurredAt: at,
          artifactDigest: contractDigest(input.readbackDigest ?? artifact),
          evidenceRef: input.proposalId,
          reasonCode: reasonCode(input.reasonCode, `style-proposal-${input.status}`),
        });
        return;
      }
      const targetRevision = input.targetRevision ?? contractDigest(input.readbackDigest ?? artifact);
      this.store.record(operationId, {
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: at,
        artifactDigest: artifact, evidenceRef: input.proposalId, targetRevision,
      });
      if (input.readbackDigest) {
        this.store.record(operationId, {
          type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: at,
          artifactDigest: contractDigest(input.readbackDigest), evidenceRef: input.proposalId, targetRevision,
        });
      }
    });
  }

  /**
   * 交互类 Agent 的消费回执（P16 C3）。由 session 在**回合提交成功之后**调用。
   *
   * 同一回合内多次调用是幂等的：operation id 由 `runId + capability` 决定，
   * 事件用固定 idempotencyKey，重复只会命中唯一约束而不会造出第二条 run。
   */
  /**
   * 方向/偏好**沉淀**落库（P16 C3.3）。由 session 在证据修订变化、快照真的写入之后调用。
   * 幂等：operation id 由 runId + capability 决定，重复调用不会造出第二条 run。
   */
  beginDirectionConsolidation(input: DirectionConsolidationObservation): void {
    this.#capture('direction-consolidation-record-failed', () => {
      const at = this.now();
      const operationId = directionClosureOperationId(input.runId, input.capability);
      const digest = contractDigest(input.artifactDigest);
      this.store.begin({
        operationId,
        runId: input.runId,
        sessionId: input.rawSessionId,
        capability: input.capability,
        lane: 'learning',
        kind: AGENT_CLOSURE_CAPABILITY_CONTRACTS[input.capability].kind,
        executionClass: input.executionClass,
        sourceRevision: input.sourceRevision,
        policyVersion: 'direction-guidance-v1',
        admittedAt: at,
      });
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
        sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: at,
        artifactDigest: digest, evidenceRef: input.evidenceRef, sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: digest, sourceRevision: input.sourceRevision,
      });
    });
  }

  /**
   * 沉淀结果被应用（P16 C3.3）：由 session 在**回合提交成功之后**、且重读落库快照
   * 重放出的渲染文本与本回合注入的块**逐字节一致**时调用。不一致就不调用 ——
   * 证据保持"未证明"，绝不把对不上的块硬凑成已验证。
   */
  observeDirectionApplication(input: DirectionApplicationObservation): void {
    this.#capture('direction-application-record-failed', () => {
      const at = this.now();
      const operationId = directionClosureOperationId(input.runId, input.capability);
      const digest = contractDigest(input.artifactDigest);
      this.store.record(operationId, {
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: at,
        artifactDigest: digest, evidenceRef: input.evidenceRef, targetRevision: input.targetRevision,
      });
      this.store.record(operationId, {
        type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: at,
        artifactDigest: contractDigest(input.readbackDigest), evidenceRef: input.evidenceRef,
        targetRevision: input.targetRevision,
      });
      // ⚠️ 合同的血缘 join 有两条硬规则：
      // ① `context-consumed.artifactDigest` 必须等于 **readback-verified** 的摘要
      //    （proposal 类的血缘锚是回读，不是提案摘要）；
      // ② `context-consumed.sourceRevision` 必须等于 **admitted** 的修订
      //    （沉淀产自哪个回合，血缘就锚在哪个回合；消费回合由 consumerRunId 指认）。
      //    所以调用方必须传**产出沉淀那一回合**的 sourceRevision，传消费回合的会被吞掉。
      this.store.record(operationId, {
        type: 'context-consumed', idempotencyKey: `consumed-${input.consumingRunId}`, occurredAt: at,
        artifactDigest: contractDigest(input.readbackDigest), sourceRevision: input.sourceRevision,
        consumerRunId: input.consumingRunId, contextBlock: input.contextBlock,
      });
    });
  }

  /**
   * 变量提案作为**写入**的完整回执（P16 W2）。由 session 在提交成功、且重读变量
   * 逐一比对吻合之后调用；同回合完成全部里程碑。
   */
  recordVariableProposalApplied(input: VariableProposalAppliedObservation): void {
    this.#capture('variable-proposal-record-failed', () => {
      const at = this.now();
      const operationId = variableProposalClosureOperationId(input.runId);
      const digest = contractDigest(input.artifactDigest);
      const readback = contractDigest(input.readbackDigest);
      this.store.begin({
        operationId,
        runId: input.runId,
        sessionId: input.rawSessionId,
        capability: 'interactive.variableProposal',
        lane: 'interactive',
        kind: AGENT_CLOSURE_CAPABILITY_CONTRACTS['interactive.variableProposal'].kind,
        executionClass: input.executionClass,
        sourceRevision: input.sourceRevision,
        policyVersion: 'interactive-variable-patch-v1',
        admittedAt: at,
      });
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
        sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: at,
        artifactDigest: digest, evidenceRef: 'interactive-variable-patch',
        sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: digest, sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'apply-committed', idempotencyKey: 'apply-committed', occurredAt: at,
        artifactDigest: digest, evidenceRef: 'interactive-variable-patch',
        targetRevision: input.targetRevision,
      });
      this.store.record(operationId, {
        type: 'readback-verified', idempotencyKey: 'readback-verified', occurredAt: at,
        artifactDigest: readback, evidenceRef: 'interactive-variable-patch',
        targetRevision: input.targetRevision,
      });
      this.store.record(operationId, {
        type: 'context-consumed', idempotencyKey: `consumed-${input.runId}`, occurredAt: at,
        artifactDigest: readback, sourceRevision: input.sourceRevision,
        consumerRunId: input.runId, contextBlock: 'interactiveVariablePatch',
      });
    });
  }

  /**
   * AQL 重规划建议的生成回执（P16 W3，advisory）。建议只返回给前端、没有进入
   * 后续回合的路径 ⇒ 记到 `validated` 是正确终点，绝不冒充"被消费"。
   */
  observeAqlReplan(input: AqlReplanObservation): void {
    this.#capture('aql-replan-record-failed', () => {
      const at = this.now();
      const operationId = aqlReplanClosureOperationId(input.runId);
      const digest = contractDigest(input.artifactDigest);
      this.store.begin({
        operationId,
        runId: input.runId,
        sessionId: input.rawSessionId,
        capability: 'interactive.aqlReplan',
        lane: 'interactive',
        kind: AGENT_CLOSURE_CAPABILITY_CONTRACTS['interactive.aqlReplan'].kind,
        executionClass: input.executionClass,
        sourceRevision: input.sourceRevision,
        policyVersion: 'aql-replan-v1',
        admittedAt: at,
      });
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
        sourceRevision: input.sourceRevision,
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: digest, sourceRevision: input.sourceRevision,
      });
    });
  }

  /**
   * 效果观测落库（P16 E1）。由 session 在观测窗口结算后调用；同一 (digest, consumerRunId)
   * 只记一次（idempotencyKey 固定），重复结算不会造出第二条效果记录。
   */
  observeEffect(input: EffectObservation): void {
    try {
      const at = this.now();
      this.store.record(input.operationId, {
        type: 'effect-observed', idempotencyKey: `effect-${input.consumerRunId}`, occurredAt: at,
        artifactDigest: contractDigest(input.artifactDigest),
        consumerRunId: input.consumerRunId,
        effectOutcome: input.effectOutcome,
      });
      const current = this.store.get(input.operationId);
      const events = current?.events.filter(event => event.idempotencyKey === `effect-${input.consumerRunId}`) ?? [];
      if (events.length !== 1 || events[0]!.type !== 'effect-observed'
          || events[0]!.artifactDigest !== contractDigest(input.artifactDigest)
          || events[0]!.consumerRunId !== input.consumerRunId || events[0]!.effectOutcome !== input.effectOutcome)
        throw new Error('effect-observation-readback-invalid');
    } catch (error) {
      try { this.onError('effect-observation-record-failed'); } catch { /* Preserve original failure. */ }
      throw error;
    }
  }

  observeInteractiveTurn(input: InteractiveArtifactObservation): void {
    this.#capture('interactive-consumption-record-failed', () => {
      const at = this.now();
      for (const artifact of input.artifacts) {
        const capability = artifact.capability;
        // proposal 类（variableProposal）有**专属写入回执**（recordVariableProposalApplied，
        // 见 W2）。走这条 advisory 的"执行即消费"路径会把一次写入冒充成已被消费的建议。
        if (AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability].kind !== 'advisory') continue;
        const digest = contractDigest(artifact.artifactDigest);
        const operationId = agentClosureOperationId('interactive', input.runId, capability);
        this.store.begin({
          operationId,
          runId: input.runId,
          sessionId: input.rawSessionId,
          capability,
          lane: 'interactive',
          // advisory / proposal 由合同唯一决定，适配层不允许改写。
          kind: AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability].kind,
          executionClass: input.executionClass,
          sourceRevision: input.sourceRevision,
          policyVersion: 'p14-interactive-turn-v1',
          admittedAt: at,
        });
        this.store.record(operationId, {
          type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
          sourceRevision: input.sourceRevision,
        });
        this.store.record(operationId, {
          type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
          artifactDigest: digest, sourceRevision: input.sourceRevision,
        });
        this.store.record(operationId, {
          type: 'context-consumed', idempotencyKey: `consumed-${input.runId}`,
          occurredAt: at, artifactDigest: digest, sourceRevision: input.sourceRevision,
          consumerRunId: input.runId, contextBlock: artifact.contextBlock,
        });
      }
    });
  }

  beginContextCompiler(input: ContextCompilerClosureIdentity): string {
    const operationId = contextCompilerClosureOperationId(input);
    this.#capture('context-compiler-admission-record-failed', () => {
      this.store.begin({
        operationId,
        runId: input.runId,
        sessionId: input.rawSessionId,
        capability: 'context.compiler',
        lane: 'interactive',
        kind: 'advisory',
        executionClass: contextCompilerExecutionClass(input),
        sourceRevision: input.sourceRevision,
        policyVersion: input.policyVersion ?? 'p14-q9r-context-compiler-v1',
        evidenceDigest: input.sourceDigest,
      });
    });
    return operationId;
  }

  completeContextCompiler(input: ContextCompilerClosureIdentity & {
    readonly capsuleDigest: string;
    readonly cached: boolean;
  }): void {
    this.#capture('context-compiler-completion-record-failed', () => {
      const operationId = this.#ensureContextCompiler(input);
      const at = this.now();
      this.store.record(operationId, {
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: at,
        sourceRevision: input.sourceRevision,
        ...(input.cached ? { reasonCode: 'cache-hit' } : {}),
      });
      this.store.record(operationId, {
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: at,
        artifactDigest: input.capsuleDigest,
        sourceRevision: input.sourceRevision,
      });
    });
  }

  failContextCompiler(input: ContextCompilerClosureIdentity, code: string): void {
    this.#capture('context-compiler-failure-record-failed', () => {
      const operationId = this.#ensureContextCompiler(input);
      this.store.record(operationId, {
        type: 'failed', idempotencyKey: `failed-${reasonCode(code, 'context-compiler-failed')}`,
        occurredAt: this.now(), reasonCode: reasonCode(code, 'context-compiler-failed'),
      });
    });
  }

  consumeContextCompiler(input: ContextCompilerClosureIdentity & {
    readonly capsuleDigest: string;
    readonly tokenCount: number;
    readonly skillAttribution?: AgentSkillClosureAttributionV1;
  }): void {
    this.#capture('context-compiler-consumption-record-failed', () => {
      const operationId = this.#ensureContextCompiler(input);
      this.store.record(operationId, {
        type: 'context-consumed',
        idempotencyKey: `consumed-${input.runId}`,
        occurredAt: this.now(),
        artifactDigest: input.capsuleDigest,
        sourceRevision: input.sourceRevision,
        consumerRunId: input.runId,
        contextBlock: 'contextCapsule',
        tokenCount: input.tokenCount,
        ...(input.skillAttribution === undefined ? {} : { skillAttribution: input.skillAttribution }),
      });
    });
  }

  #ensureMaintenance(job: PublicMaintenanceJob): string {
    const operationId = maintenanceClosureOperationId(job);
    this.store.begin({
      operationId,
      runId: job.runId,
      ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}),
      sessionId: job.sessionId,
      capability: MAINTENANCE_CAPABILITY[job.taskKind],
      lane: 'maintenance',
      kind: 'proposal',
      executionClass: maintenanceClosureExecutionClass(job),
      sourceRevision: job.sourceRevision,
      policyVersion: job.policyVersion,
      admittedAt: job.createdAt,
    });
    return operationId;
  }

  #ensureContextCompiler(input: ContextCompilerClosureIdentity): string {
    const operationId = contextCompilerClosureOperationId(input);
    this.store.begin({
      operationId,
      runId: input.runId,
      sessionId: input.rawSessionId,
      capability: 'context.compiler',
      lane: 'interactive',
      kind: 'advisory',
      executionClass: contextCompilerExecutionClass(input),
      sourceRevision: input.sourceRevision,
      policyVersion: input.policyVersion ?? 'p14-q9r-context-compiler-v1',
      evidenceDigest: input.sourceDigest,
    });
    return operationId;
  }

  #capture(code: string, work: () => void): void {
    try { work(); } catch { this.onError(code); }
  }
}
