/** @author Codex @date 2026-10-19 @version 1.0
 * AL-1 收口：权威编排投影 Store（`agent-loop-projection-v1`）。
 *
 * 边界（逐条对应 §11.3 AL-1）：
 * 1) **revision CAS 是唯一并发键**：Envelope 的 `revision` 必须等于库里的 revision，
 *    写入后 +1；`UPDATE ... WHERE task_id=? AND revision=?` 必须恰好命中 1 行，
 *    否则 `agent-loop-projection-revision-conflict`，不产生半套状态。
 * 2) **owner/lease**：写操作必须由持有未过期 lease 的 owner 发起；lease 可以被
 *    过期抢占（CAS + 条件 UPDATE 双重保护），也可以主动 release；严格 renew
 *    只延续同 owner 的有效非终态 lease，不能代替 claim 复活过期租约。
 * 3) **删除 fence**：`fence()` 写墓碑（revision 前进一格 + 事件 + outbox），
 *    之后所有写（含 create/commit/claim）一律 `agent-loop-projection-fenced`。
 *    读仍然允许 —— 审计需要看到墓碑，而不是把记录变成「不存在」。
 * 4) **坏行隔离**：定向 `read()` 遇到坏行**抛错**（沉默返回 null 会把「坏了」
 *    伪装成「没有」，这是更糟的谎）；批量扫描（`scanRecoverable`/`readOutbox`）
 *    跳过坏行并计数，一条坏记录不能拖垮整次恢复。
 * 5) **有界恢复扫描**：只返回「未围栏 + 非终态 + lease 过期或缺失」的任务，
 *    上限 1..128，顺序稳定（updated_at, task_id），供宿主按预算分批恢复。
 * 6) **accepted event + Envelope 更新 + 通知 outbox 同事务**：三者要么全进，
 *    要么全不进；outbox 由 `readOutbox` 消费、`ackOutbox` 确认。
 * 7) **typed ref 只登记「引用」，不登记正文**（v3 / CX-4）：`agent_loop_artifact_ref`
 *    存 kind/ownerRef/期望摘要/ACL/展开预算，领域正文永远留在领域 Store。
 *    登记幂等（同 refId 同描述 ⇒ 重放），但**不得改指向**（同 refId 换摘要 ⇒ 冲突），
 *    也**不推进 revision**（引用登记不是编排语义变化，否则每次登记都造假水位）。
 * 8) **v4 Action hold/receipt**：同库 sidecar 保存 get_variables 的内容无关预算预留与回执，
 *    不修改 Envelope.reserved/语义 revision；active hold 阻断普通 commit 与不相关新观测，
 *    真实匹配 Observation 与原 Reducer 记 spent、receipt 消费、事件/outbox 同事务。
 *    started unknown 不退款、不重派；这不是宿主策略授权或领域正文/Skill proof。
 * 9) **v5 Completion metadata**：同 revision 冻结真实投影/refs/events/observations/receipts，
 *    候选与规范 verification 追加审计同事务；任何记录都不授予 COMPLETED 或恢复执行权。
 *
 * 不做的事：不调用模型、不执行工具、不写任何领域业务表；跨领域汇合仍走各领域
 * 自己的 outbox/readback，这里只存「编排看到的事实」。
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeAgentLoopRepairPolicy, agentLoopRepairPolicyBindingDigest, foldAgentLoopRepairEvents,
    type AgentLoopRepairState, type AgentLoopRepairCommitResult } from './agent-loop-repair-budget.ts';
import { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';
import { readAgentLoopModelOutcome, isAgentLoopModelProtocolRejectionReason,
    AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION, normalizeAgentLoopSummaryValidationRejection,
    type AgentLoopSummaryValidationRejection } from './agent-loop-model-outcome.ts';
import { readAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, normalizeAgentLoopModelCorrectionPolicy,
    agentLoopModelCorrectionPolicyDigest, assertAgentLoopModelCorrectionPolicyBinding, createAgentLoopModelCorrectionPolicy,
    type AgentLoopModelCorrectionPolicy, type AgentLoopModelCorrectionState } from './agent-loop-model-correction.ts';
import { consumeAgentLoopPreparedModelCorrection } from './agent-loop-prepared-model-correction.ts';
import { consumeAgentLoopPreparedModelCorrectionProposal } from './agent-loop-prepared-model-correction-proposal.ts';
import { agentLoopCompletionDigest, createStoredAgentLoopCompletionCandidate, normalizeStoredAgentLoopCompletionCandidate,
    createStoredAgentLoopCompletionVerification, normalizeStoredAgentLoopCompletionVerification,
    type AgentLoopCompletionSnapshot, type StoredAgentLoopCompletionCandidate,
    type StoredAgentLoopCompletionVerification } from './agent-loop-completion-record.ts';
import { assertAgentLoopTurnCompletionBirthBinding, assertAgentLoopTurnCompletionEvaluation,
    type AgentLoopTurnCompletionPolicy } from './agent-loop-turn-completion-policy.ts';
export type { StoredAgentLoopCompletionCandidate, StoredAgentLoopCompletionVerification } from './agent-loop-completion-record.ts';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join as joinPath, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    dagBudgetExact, dagBudgetToken, dagBudgetInteger, dagBudgetTimestamp,
    normalizeAgentLoopDagBudget, normalizeAgentLoopDagLeafProfile, normalizeAgentLoopDagRootPolicy,
    addAgentLoopDagBudget, subtractAgentLoopDagBudget,
    type AgentLoopDagBudgetVector, type AgentLoopDagRootPolicy, type AgentLoopDagLeafProfile,
} from './agent-loop-dag-budget.ts';
import {
    AGENT_LOOP_TASK_BUDGET_KEYS,
    AGENT_LOOP_ALLOWED_TRANSITIONS,
    normalizeAgentLoopTaskEnvelope,
    normalizeAgentLoopDecision,
    assertAgentLoopPhaseTransition,
    type AgentLoopTaskEnvelopeV1,
    normalizeAgentLoopObservation,
    type AgentLoopTaskState,
} from '@jiuguan/agent-loop-contract';
import {
    agentLoopObservationDigest,
    reduceAgentLoopObservation,
    type AgentLoopObservationClassification,
    type AgentLoopObservationReasonCode,
} from './agent-loop-observation-reducer.ts';
import {
    AGENT_LOOP_ACTION_USAGE_KEYS, normalizeAgentLoopActionContractRef,
    AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS,
    normalizeAgentLoopActionObject, normalizeAgentLoopActionToken, normalizeAgentLoopActionDigest,
    normalizeAgentLoopActionUsage, normalizeAgentLoopActionResult,
    type AgentLoopActionUsage, type AgentLoopActionScope, type AgentLoopActionReceiptRecord,
    type AgentLoopActionResultMetadata,
} from './agent-loop-action-receipt.ts';
export type { AgentLoopActionUsage, AgentLoopActionScope, AgentLoopActionReceiptRecord,
    AgentLoopActionResultMetadata } from './agent-loop-action-receipt.ts';

export const AGENT_LOOP_PROJECTION_DB_FILE = 'agent-loop-projection.sqlite';
/**
 * schema 版本。v2 Observation；v3 typed ref；v4 read receipt；v5 completion；v6 proposal；v7 apply；v8 DAG budget。
 * 有旧版本文件在场时必须走迁移，不能只改 DDL（改 DDL 会让旧库在自证时 fail closed）。
 */
export const AGENT_LOOP_PROJECTION_SCHEMA_VERSION = 9;
export const AGENT_LOOP_PROJECTION_APPLICATION_ID = 0x4a474c50; // 'JGLP'
export const AGENT_LOOP_PROJECTION_EVENT_VERSION = 'agent-loop-projection-event-v1' as const;
export const AGENT_LOOP_DAG_CHILD_OBSERVATION_CONTRACT = 'observation.rp-child-result.v1';
export const AGENT_LOOP_DAG_CHILD_RESUME_PREDICATE = 'resume.rp-child-result.v1';
export interface AgentLoopTaskSuspendRequest {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly wait?: AgentLoopTaskEnvelopeV1['wait'];
    readonly pauseId?: string;
}
export interface AgentLoopTaskResumeRequest {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly suspensionId: string;
    readonly eventRef: string;
    readonly leaseMs: number;
}
/** Resolved by a trusted host from its durable source, never accepted as a resume request. */
export interface AgentLoopTaskResumeEvidence {
    readonly observation: ReturnType<typeof normalizeAgentLoopObservation>;
    readonly contractRef: string;
    readonly predicateRef: string;
    readonly satisfied: boolean;
}
export interface AgentLoopTaskResumeResult {
    readonly status: 'resumed' | 'already-resumed' | 'stale' | 'inconclusive';
    readonly record: AgentLoopTaskRecord;
}
const SUMMARY_VALIDATION_EVENT = 'model-summary-validation-rejected-v1';
const SUMMARY_VALIDATION_PREFIX = 'summary-validation-v1:';

export const AGENT_LOOP_PROJECTION_ERROR_CODES = Object.freeze([
    'agent-loop-projection-input-invalid',
    'agent-loop-projection-record-missing',
    'agent-loop-projection-record-exists',
    'agent-loop-projection-revision-conflict',
    'agent-loop-projection-lease-lost',
    'agent-loop-projection-fenced',
    'agent-loop-projection-event-conflict',
    'agent-loop-projection-event-exists',
    'agent-loop-projection-observation-conflict',
    'agent-loop-projection-ref-conflict',
    'agent-loop-projection-storage-invalid',
] as const);
export type AgentLoopProjectionErrorCode = typeof AGENT_LOOP_PROJECTION_ERROR_CODES[number];

export class AgentLoopProjectionError extends Error {
    constructor(readonly code: AgentLoopProjectionErrorCode) {
        if (!(AGENT_LOOP_PROJECTION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('agent-loop-projection-error-code-invalid');
        }
        super(code);
        this.name = 'AgentLoopProjectionError';
    }
}

/**
 * 用**函数声明**而不是 `const` 箭头：TypeScript 只有对函数声明（或带显式变量
 * 类型注解的 const）才把 `never` 返回值接进控制流分析，否则 `if (!x) reject(...)`
 * 之后的 `x` 仍然是 `T | null`。
 */
function reject(code: AgentLoopProjectionErrorCode): never {
    throw new AgentLoopProjectionError(code);
}

/** 终态：不再参与恢复扫描（FAILED 重开会生成新 attempt，不在本 Store 里复活）。 */
const TERMINAL_STATES = new Set<AgentLoopTaskState>(['COMPLETED', 'FAILED', 'CANCELLED']);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_LIMIT = 128;

/** v1 的对象清单。**迁移基线，不要改**：改了 v1→v2 迁移就测不出来了。 */
export const AGENT_LOOP_PROJECTION_V1_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_task (
        task_id TEXT PRIMARY KEY,
        root_task_id TEXT NOT NULL,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        owner_id TEXT,
        lease_expires_at TEXT,
        fenced INTEGER NOT NULL DEFAULT 0,
        fence_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (revision >= 1),
        CHECK (fenced IN (0, 1)),
        CHECK (length(envelope_digest) = 71),
        CHECK (fenced = 0 OR fence_reason IS NOT NULL)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_task_recoverable
        ON agent_loop_task (fenced, lease_expires_at, updated_at)`,
    `CREATE TABLE IF NOT EXISTS agent_loop_task_event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        reason_code TEXT,
        event_digest TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        CHECK (revision >= 1),
        CHECK (length(event_digest) = 71)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_task_event_task
        ON agent_loop_task_event (task_id, seq)`,
    `CREATE TABLE IF NOT EXISTS agent_loop_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_outbox_pending
        ON agent_loop_outbox (delivered_at, seq)`,
    // 事件与任务是 append-only 语义：删除只能通过 fence 墓碑表达。
    `CREATE TRIGGER IF NOT EXISTS agent_loop_task_event_no_update
        BEFORE UPDATE ON agent_loop_task_event
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-event-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_task_event_no_delete
        BEFORE DELETE ON agent_loop_task_event
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-event-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_task_no_delete
        BEFORE DELETE ON agent_loop_task
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-task-immutable'); END`,
]);

/**
 * v2 增量：AL-2 的 Observation 记账表 + 冲突隔离表。
 *
 * - `agent_loop_observation` 只记**已归结**的观测（applied / stale），
 *   `observation_id` 是主键，「同 ID 同摘要幂等」靠它成立；
 * - `agent_loop_observation_quarantine` 只记**同 ID 不同摘要**的冲突，
 *   冲突观测永不进主表，也就永远不会被当作事实。
 */
export const AGENT_LOOP_PROJECTION_V2_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_observation (
        observation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        observed_for_revision INTEGER NOT NULL,
        source_kind TEXT NOT NULL,
        completeness TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        observation_digest TEXT NOT NULL,
        classification TEXT NOT NULL,
        satisfies_verification INTEGER NOT NULL,
        applied_revision INTEGER,
        reason_codes_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        CHECK (classification IN ('applied', 'stale')),
        CHECK (satisfies_verification IN (0, 1)),
        CHECK (classification = 'applied' OR applied_revision IS NULL),
        CHECK (length(observation_digest) = 71)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_observation_task
        ON agent_loop_observation (task_id, ingested_at)`,
    `CREATE TABLE IF NOT EXISTS agent_loop_observation_quarantine (
        observation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        stored_digest TEXT NOT NULL,
        conflicting_digest TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        CHECK (length(stored_digest) = 71),
        CHECK (length(conflicting_digest) = 71)
    )`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_observation_no_update
        BEFORE UPDATE ON agent_loop_observation
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-observation-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_observation_no_delete
        BEFORE DELETE ON agent_loop_observation
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-observation-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_observation_quarantine_no_update
        BEFORE UPDATE ON agent_loop_observation_quarantine
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-observation-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_observation_quarantine_no_delete
        BEFORE DELETE ON agent_loop_observation_quarantine
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-observation-immutable'); END`,
]);

/**
 * v3 增量：CX-4 的 typed ref 登记表。
 *
 * 只登记「引用」，不登记正文：`owner_ref` 指向领域 Store，`expected_digest` 是登记时
 * 看到的权威摘要。恢复时拿领域当前摘要对比，就能把「没变 / 变了 / 没了 / 不许看」
 * 四态分开——而不是把领域正文复制进编排库变成第二份真值。
 *
 * append-only：`UPDATE`/`DELETE` 由触发器拒绝。要换指向必须换新的 `ref_id`，
 * 这样历史快照引用的旧 ref 不会在背后被改写成另一份内容。
 */
export const AGENT_LOOP_PROJECTION_V3_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_artifact_ref (
        task_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_ref TEXT NOT NULL,
        expected_digest TEXT NOT NULL,
        expected_revision TEXT,
        policy TEXT NOT NULL,
        acl_class TEXT NOT NULL,
        expand_budget_tokens INTEGER NOT NULL,
        task_revision INTEGER NOT NULL,
        registered_at TEXT NOT NULL,
        PRIMARY KEY (task_id, ref_id),
        CHECK (policy IN ('required', 'optional')),
        CHECK (expand_budget_tokens >= 0),
        CHECK (task_revision >= 1),
        CHECK (length(expected_digest) = 71),
        CHECK (length(acl_class) >= 1)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_artifact_ref_task
        ON agent_loop_artifact_ref (task_id, kind, ref_id)`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_artifact_ref_no_update
        BEFORE UPDATE ON agent_loop_artifact_ref
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-ref-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_artifact_ref_no_delete
        BEFORE DELETE ON agent_loop_artifact_ref
        BEGIN SELECT RAISE(ABORT, 'agent-loop-projection-ref-immutable'); END`,
]);

/** v4 is a narrow original-Store sidecar, not another budget ledger or result-body Store. */
export const AGENT_LOOP_PROJECTION_V4_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_action_receipt (
        action_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        owner_id TEXT NOT NULL,
        action_digest TEXT NOT NULL CHECK(length(action_digest) = 71),
        action_contract_ref TEXT NOT NULL CHECK(action_contract_ref = 'action.maintenance.get_variables.v1'),
        estimate_json TEXT NOT NULL CHECK(json_valid(estimate_json)),
        status TEXT NOT NULL CHECK(status IN ('reserved','started','completed','observed','released')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        receipt_ref TEXT,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        settled_at TEXT,
        observation_id TEXT UNIQUE,
        applied_revision INTEGER CHECK(applied_revision IS NULL OR applied_revision >= 1),
        observed_at TEXT,
        released_at TEXT,
        metadata_digest TEXT NOT NULL CHECK(length(metadata_digest) = 71),
        UNIQUE(task_id,attempt_id,task_revision),
        CHECK((status='reserved' AND started_at IS NULL AND completed_at IS NULL AND receipt_ref IS NULL
            AND result_json IS NULL AND settled_at IS NULL AND observation_id IS NULL AND applied_revision IS NULL
            AND observed_at IS NULL AND released_at IS NULL)
          OR (status='released' AND started_at IS NULL AND completed_at IS NULL AND receipt_ref IS NULL
            AND result_json IS NULL AND settled_at IS NULL AND observation_id IS NULL AND applied_revision IS NULL
            AND observed_at IS NULL AND released_at IS NOT NULL)
          OR (status='started' AND started_at IS NOT NULL AND completed_at IS NULL AND receipt_ref IS NULL
            AND result_json IS NULL AND settled_at IS NULL AND observation_id IS NULL AND applied_revision IS NULL
            AND observed_at IS NULL AND released_at IS NULL)
          OR (status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND receipt_ref IS NOT NULL
            AND result_json IS NOT NULL AND observation_id IS NULL AND applied_revision IS NULL
            AND observed_at IS NULL AND released_at IS NULL)
          OR (status='observed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND receipt_ref IS NOT NULL
            AND result_json IS NOT NULL AND settled_at IS NOT NULL AND observation_id IS NOT NULL
            AND applied_revision IS NOT NULL AND observed_at IS NOT NULL AND released_at IS NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_action_receipt_task ON agent_loop_action_receipt(task_id,status)`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_action_receipt_no_delete BEFORE DELETE ON agent_loop_action_receipt
        BEGIN SELECT RAISE(ABORT,'agent-loop-action-receipt-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_action_receipt_binding_immutable BEFORE UPDATE ON agent_loop_action_receipt
        WHEN NEW.action_id IS NOT OLD.action_id OR NEW.task_id IS NOT OLD.task_id OR NEW.attempt_id IS NOT OLD.attempt_id
          OR NEW.task_revision IS NOT OLD.task_revision OR NEW.owner_id IS NOT OLD.owner_id
          OR NEW.action_digest IS NOT OLD.action_digest OR NEW.action_contract_ref IS NOT OLD.action_contract_ref
          OR NEW.estimate_json IS NOT OLD.estimate_json OR NEW.created_at IS NOT OLD.created_at
          OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
          OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
          OR (OLD.receipt_ref IS NOT NULL AND NEW.receipt_ref IS NOT OLD.receipt_ref)
          OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
          OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at)
          OR (OLD.observation_id IS NOT NULL AND NEW.observation_id IS NOT OLD.observation_id)
          OR (OLD.applied_revision IS NOT NULL AND NEW.applied_revision IS NOT OLD.applied_revision)
          OR (OLD.observed_at IS NOT NULL AND NEW.observed_at IS NOT OLD.observed_at)
          OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
          OR NOT (NEW.status=OLD.status OR (OLD.status='reserved' AND NEW.status IN ('started','released'))
            OR (OLD.status='started' AND NEW.status='completed') OR (OLD.status='completed' AND NEW.status='observed'))
        BEGIN SELECT RAISE(ABORT,'agent-loop-action-receipt-immutable'); END`,
]);

/** v5 only freezes content-free candidates/evaluations. Neither table grants COMPLETED. */
export const AGENT_LOOP_PROJECTION_V5_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_completion_candidate (
        candidate_ref TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 71),
        frozen_digest TEXT NOT NULL CHECK(length(frozen_digest) = 71),
        candidate_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id,snapshot_digest)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_completion_candidate_task ON agent_loop_completion_candidate(task_id,task_revision)`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_completion_candidate_no_update BEFORE UPDATE ON agent_loop_completion_candidate
        BEGIN SELECT RAISE(ABORT,'agent-loop-completion-candidate-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_completion_candidate_no_delete BEFORE DELETE ON agent_loop_completion_candidate
        BEGIN SELECT RAISE(ABORT,'agent-loop-completion-candidate-immutable'); END`,
    `CREATE TABLE IF NOT EXISTS agent_loop_completion_verification (
        verification_result_ref TEXT PRIMARY KEY,
        candidate_ref TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
        candidate_digest TEXT NOT NULL CHECK(length(candidate_digest) = 71),
        verification_digest TEXT NOT NULL CHECK(length(verification_digest) = 71),
        verification_json TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        FOREIGN KEY(candidate_ref) REFERENCES agent_loop_completion_candidate(candidate_ref)
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_completion_verification_task ON agent_loop_completion_verification(task_id,candidate_ref)`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_completion_verification_no_update BEFORE UPDATE ON agent_loop_completion_verification
        BEGIN SELECT RAISE(ABORT,'agent-loop-completion-verification-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_completion_verification_no_delete BEFORE DELETE ON agent_loop_completion_verification
        BEGIN SELECT RAISE(ABORT,'agent-loop-completion-verification-immutable'); END`,
]);

/** v6 widens only the original receipt contract CHECK. Historical v4/v5 stay frozen. */
export const AGENT_LOOP_PROJECTION_V6_SCHEMA = Object.freeze(AGENT_LOOP_PROJECTION_V4_SCHEMA.map((statement, index) => index === 0
    ? statement.replace("CHECK(action_contract_ref = 'action.maintenance.get_variables.v1')",
        "CHECK(action_contract_ref IN ('action.maintenance.get_variables.v1','action.maintenance.propose_rolling_summary.v1'))")
    : statement));

/** v7 changes only the exact receipt CHECK; v4/v5/v6 remain historical DDL. */
export const AGENT_LOOP_PROJECTION_V7_SCHEMA = Object.freeze(AGENT_LOOP_PROJECTION_V6_SCHEMA.map((statement, index) => index === 0
    ? statement.replace("CHECK(action_contract_ref IN ('action.maintenance.get_variables.v1','action.maintenance.propose_rolling_summary.v1'))",
        "CHECK(action_contract_ref IN ('action.maintenance.get_variables.v1','action.maintenance.propose_rolling_summary.v1','action.maintenance.apply_rolling_summary.v1'))")
    : statement));

const V7_SCHEMA = Object.freeze([
    ...AGENT_LOOP_PROJECTION_V1_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V2_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V3_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V7_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V5_SCHEMA,
]);

/** v8 adds only same-Store accounting metadata. Historical schemas remain frozen. */
export const AGENT_LOOP_PROJECTION_V8_SCHEMA = Object.freeze([
    `CREATE TABLE IF NOT EXISTS agent_loop_dag_policy (
        root_task_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        granted_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','cancelled')),
        created_at TEXT NOT NULL,
        CHECK (length(policy_digest)=71)
    )`,
    `CREATE TABLE IF NOT EXISTS agent_loop_child_budget (
        reservation_id TEXT PRIMARY KEY,
        root_task_id TEXT NOT NULL,
        child_task_id TEXT NOT NULL UNIQUE,
        allocation_json TEXT NOT NULL,
        allocation_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','dispatched','released','settled')),
        dispatched_at TEXT,
        finished_at TEXT,
        usage_json TEXT,
        settlement_ref TEXT,
        settlement_digest TEXT,
        created_at TEXT NOT NULL,
        CHECK (length(allocation_digest)=71),
        CHECK ((status='reserved' AND dispatched_at IS NULL AND finished_at IS NULL)
            OR (status='dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL)
            OR (status='released' AND dispatched_at IS NULL AND finished_at IS NOT NULL)
            OR (status='settled' AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL)),
        CHECK ((status='settled' AND usage_json IS NOT NULL AND settlement_ref IS NOT NULL
            AND settlement_digest IS NOT NULL AND length(settlement_digest)=71)
            OR (status!='settled' AND usage_json IS NULL AND settlement_ref IS NULL AND settlement_digest IS NULL))
    )`,
    `CREATE INDEX IF NOT EXISTS agent_loop_child_budget_root
        ON agent_loop_child_budget(root_task_id,reservation_id)`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_dag_policy_no_delete
        BEFORE DELETE ON agent_loop_dag_policy
        BEGIN SELECT RAISE(ABORT,'agent-loop-dag-policy-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_dag_policy_binding_immutable
        BEFORE UPDATE ON agent_loop_dag_policy
        WHEN OLD.root_task_id!=NEW.root_task_id OR OLD.policy_json!=NEW.policy_json
            OR OLD.policy_digest!=NEW.policy_digest OR OLD.granted_json!=NEW.granted_json
            OR OLD.created_at!=NEW.created_at OR (OLD.state='cancelled' AND NEW.state!='cancelled')
        BEGIN SELECT RAISE(ABORT,'agent-loop-dag-policy-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_child_budget_no_delete
        BEFORE DELETE ON agent_loop_child_budget
        BEGIN SELECT RAISE(ABORT,'agent-loop-dag-allocation-immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS agent_loop_child_budget_binding_immutable
        BEFORE UPDATE ON agent_loop_child_budget
        WHEN OLD.reservation_id!=NEW.reservation_id OR OLD.root_task_id!=NEW.root_task_id
            OR OLD.child_task_id!=NEW.child_task_id OR OLD.allocation_json!=NEW.allocation_json
            OR OLD.allocation_digest!=NEW.allocation_digest OR OLD.created_at!=NEW.created_at
            OR (OLD.status IN ('released','settled'))
            OR (OLD.status='dispatched' AND (NEW.status!='settled' OR NEW.dispatched_at!=OLD.dispatched_at))
        BEGIN SELECT RAISE(ABORT,'agent-loop-dag-allocation-immutable'); END`,
]);
const V8_SCHEMA = Object.freeze([...V7_SCHEMA, ...AGENT_LOOP_PROJECTION_V8_SCHEMA]);
/** v9 admits one exact read-only RP Action receipt; earlier DDL remains frozen. */
export const AGENT_LOOP_PROJECTION_V9_SCHEMA = Object.freeze(AGENT_LOOP_PROJECTION_V7_SCHEMA.map((statement, index) => index === 0
    ? statement.replace("'action.maintenance.apply_rolling_summary.v1'))",
        "'action.maintenance.apply_rolling_summary.v1','action.rp.read-character.v1'))")
    : statement));
const SCHEMA = Object.freeze([
    ...AGENT_LOOP_PROJECTION_V1_SCHEMA, ...AGENT_LOOP_PROJECTION_V2_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V3_SCHEMA, ...AGENT_LOOP_PROJECTION_V9_SCHEMA,
    ...AGENT_LOOP_PROJECTION_V5_SCHEMA, ...AGENT_LOOP_PROJECTION_V8_SCHEMA,
]);

/** Host-only live invocation identity. This DTO alone is never an execution capability. */
export interface AgentLoopDagLeafExecutionScope {
    readonly rootTaskId: string;
    readonly rootAttemptId: string;
    readonly rootExpectedRevision: number;
    readonly rootOwnerId: string;
    readonly reservationId: string;
    readonly childTaskId: string;
    readonly childAttemptId: string;
    readonly childOwnerId: string;
}
interface AgentLoopDagExecutionFrame {
    readonly scope: AgentLoopDagLeafExecutionScope;
    readonly root: AgentLoopTaskRecord;
    readonly child: AgentLoopTaskRecord;
    readonly startedAt: string;
    readonly settlementOnly: boolean;
}
type AgentLoopDagOperation = 'execution' | 'inspect' | 'accounting';

export interface AgentLoopDagChildAllocation {
    readonly reservationId: string;
    readonly taskId: string;
    readonly childEnvelope: AgentLoopTaskEnvelopeV1;
    readonly deadlineAt: string;
    readonly requirement: 'required' | 'optional';
    readonly profile: AgentLoopDagLeafProfile;
}
export interface AgentLoopDagBudgetSnapshot {
    readonly rootTaskId: string;
    readonly policy: AgentLoopDagRootPolicy;
    readonly state: 'active' | 'cancelled';
    readonly granted: AgentLoopDagBudgetVector;
    readonly record: AgentLoopTaskRecord;
    readonly allocations: readonly Readonly<{
        allocation: AgentLoopDagChildAllocation;
        status: 'reserved' | 'dispatched' | 'released' | 'settled';
        dispatchedAt: string | null;
        finishedAt: string | null;
        usage: AgentLoopDagBudgetVector | null;
        settlementRef: string | null;
    }>[];
}

export interface AgentLoopDagChildNotification extends AgentLoopObservationIngest {
    readonly observationId: string;
}

/** Content-free host readback, not a serialized authorization or result body. */
export interface AgentLoopDagChildResultEvidenceV1 {
    readonly version: 'agent-loop-rp-child-result-evidence-v1';
    readonly parentTaskId: string;
    readonly parentAttemptId: string;
    readonly childTaskId: string;
    readonly childAttemptId: string;
    readonly childRevision: number;
    readonly childEnvelopeDigest: string;
    readonly childTaskUpdatedAt: string;
    readonly candidateRef: string;
    readonly candidateDigest: string;
    readonly verificationResultRef: string;
    readonly verificationDigest: string;
    readonly sourceBindingDigest: string;
    readonly requiredVerifierIds: readonly string[];
    readonly artifact: AgentLoopArtifactRefDescriptor;
    readonly evidenceRefs: readonly string[];
    readonly proofDigest: string;
}
type RpChildResultEvidenceV1 = AgentLoopDagChildResultEvidenceV1;

/** Derived read-only stop, not another ledger: an unsettled grant cannot hide
 * actual physical use exceeding any of its nine dimensions from sibling work.
 */
export function hasUnsettledAgentLoopDagBudgetOverrun(
    snapshot: AgentLoopDagBudgetSnapshot,
    readChild: (taskId: string) => AgentLoopTaskRecord | null,
): boolean {
    return snapshot.allocations.some((entry) => {
        if (entry.status !== 'dispatched') return false;
        const child = readChild(entry.allocation.childEnvelope.taskId);
        if (!child) reject('agent-loop-projection-storage-invalid');
        return AGENT_LOOP_TASK_BUDGET_KEYS.some(
            (key) => child.envelope.budget.spent[key] > entry.allocation.childEnvelope.budget.granted[key],
        );
    });
}

/**
 * ref 词表跟着**登记表**走（谁持久化谁定义），续跑层直接复用，避免两处各写一份字符串。
 * `kind` 决定用哪个领域 resolver；`aclClass` 决定需要哪种授权才能展开。
 */
export const AGENT_LOOP_ARTIFACT_REF_KINDS = Object.freeze([
    'closure-receipt',
    'evidence-ledger',
    'candidate',
    'session-artifact',
    'memory-record',
    'memory-fact',
    'rolling-summary',
    'worldbook-asset',
    'skill-package',
    'tool-result',
] as const);
export type AgentLoopArtifactRefKind = typeof AGENT_LOOP_ARTIFACT_REF_KINDS[number];

export const AGENT_LOOP_ARTIFACT_REF_POLICIES = Object.freeze([
    'required', 'optional',
] as const);
export type AgentLoopArtifactRefPolicy = typeof AGENT_LOOP_ARTIFACT_REF_POLICIES[number];

export const AGENT_LOOP_ARTIFACT_REF_ACL_CLASSES = Object.freeze([
    'task', 'session', 'owner', 'restricted',
] as const);
export type AgentLoopArtifactRefAclClass = typeof AGENT_LOOP_ARTIFACT_REF_ACL_CLASSES[number];

export interface AgentLoopArtifactRefDescriptor {
    readonly refId: string;
    readonly kind: AgentLoopArtifactRefKind;
    readonly ownerRef: string;
    readonly expectedDigest: string;
    readonly expectedRevision?: string;
    readonly policy: AgentLoopArtifactRefPolicy;
    readonly aclClass: AgentLoopArtifactRefAclClass;
    readonly expandBudgetTokens: number;
}

type SqlRow = Record<string, string | number | null>;

export interface AgentLoopTaskEventInput {
    readonly eventId: string;
    readonly kind: string;
    readonly reasonCode?: string;
}

export interface AgentLoopTaskEvent extends AgentLoopTaskEventInput {
    readonly eventVersion: typeof AGENT_LOOP_PROJECTION_EVENT_VERSION;
    readonly taskId: string;
    readonly revision: number;
    readonly eventDigest: string;
    readonly acceptedAt: string;
}

export interface AgentLoopTaskRecord {
    readonly envelope: AgentLoopTaskEnvelopeV1;
    readonly envelopeDigest: string;
    readonly ownerId: string | null;
    readonly leaseExpiresAt: string | null;
    readonly fenced: boolean;
    readonly fenceReason: string | null;
    readonly revision: number;
}

/** One read transaction of original orchestration facts, never a domain commit or execution grant. */
export interface AgentLoopTaskOutcomeSnapshot {
    readonly record: AgentLoopTaskRecord;
    readonly completion: Readonly<{
        candidate: StoredAgentLoopCompletionCandidate;
        verification: StoredAgentLoopCompletionVerification;
        requested: AgentLoopTaskEvent;
        completed: AgentLoopTaskEvent;
    }> | null;
}

/** Historical metadata only, never a source, policy, retry or execution grant. */
export interface AgentLoopSummaryValidationHistory {
    readonly version: 'agent-loop-summary-validation-history-v1';
    readonly taskId: string; readonly attemptId: string; readonly modelRevision: number; readonly invocationId: string;
    readonly status: 'recorded' | 'not-recorded'; readonly rejection: AgentLoopSummaryValidationRejection | null;
    readonly executionAuthorized: false; readonly completionAuthorized: false;
    readonly canaryAuthorized: false; readonly productionEligible: false;
}

/** Content-free readback only. This does not issue or restore a live ACT cap. */
export interface AgentLoopModelCorrectionActionLineage {
    readonly version: 'agent-loop-model-correction-action-lineage-v1';
    readonly taskId: string;
    readonly taskRevision: number;
    readonly envelopeDigest: string;
    readonly policyDigest: string;
    readonly modelRevision: 2 | 4;
    readonly modelCallsUsed: 1 | 2;
    readonly invocationId: string;
    readonly decisionDigest: string;
    readonly actionId: string;
    readonly snapshotDigest: string;
}

/** Inert post-Action proof join; never a request, live completion or retry grant. */
export interface AgentLoopModelCorrectionCompletionLineage {
    readonly version: 'agent-loop-model-correction-completion-lineage-v1';
    readonly taskId: string; readonly taskRevision: number; readonly envelopeDigest: string;
    readonly policyDigest: string; readonly actionId: string; readonly actionRevision: 3 | 5;
    readonly modelCallsUsed: 1 | 2; readonly observeRevision: 5 | 7;
    readonly decisionDigest: string; readonly actionDigest: string; readonly actionWatermark: string;
    readonly observationId: string; readonly preparationDigest: string;
    readonly bindingRef: string; readonly proposalRef: string; readonly snapshotDigest: string;
}

/** 已登记的 typed ref（含登记时的任务 revision，供续跑层判断「登记之后是否前进过」）。 */
export interface AgentLoopArtifactRefRecord extends AgentLoopArtifactRefDescriptor {
    readonly taskRevision: number;
    readonly registeredAt: string;
}

export interface AgentLoopOutboxEntry {
    readonly seq: number;
    readonly taskId: string;
    readonly revision: number;
    readonly eventId: string;
    readonly eventDigest: string;
    readonly createdAt: string;
}

/** 一次 Observation 归结的结果。`conflict` 会写隔离表后抛错，不会走到这里。 */
export interface AgentLoopObservationIngest {
    readonly classification: AgentLoopObservationClassification;
    readonly record: AgentLoopTaskRecord;
    readonly reasonCodes: readonly AgentLoopObservationReasonCode[];
    readonly satisfiesVerification: boolean;
    readonly observationDigest: string;
}

export interface AgentLoopObservationRecord {
    readonly observationId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly observedForTaskRevision: number;
    readonly sourceKind: string;
    readonly completeness: string;
    readonly classification: 'applied' | 'stale';
    readonly satisfiesVerification: boolean;
    readonly appliedRevision: number | null;
    readonly reasonCodes: readonly string[];
    readonly ingestedAt: string;
}

/** Bounded SQL ordering markers, not a live source timestamp or Task authority.
 * Invalid Task bodies must not prevent advancing beyond their stored sort keys. */
export interface AgentLoopRecoveryCursor {
    readonly updatedAt: string;
    readonly taskId: string;
}

export interface AgentLoopRecoveryScan {
    readonly tasks: readonly AgentLoopTaskRecord[];
    /** 坏行只计数，不泄露内容、不中断整页（一条坏记录不能拖垮恢复）。 */
    readonly skipped: number;
    readonly nextCursor: AgentLoopRecoveryCursor | null;
}

/** 合同包的 normalizer；单独包一层只为让 `#insertObservation` 的入参类型可推导。 */
function normalizeObservationStrict(input: unknown) {
    return normalizeAgentLoopObservation(input);
}

function actionInput(input: unknown, extra: readonly string[] = []): Readonly<{
    scope: AgentLoopActionScope; value: Record<string, unknown>;
}> {
    try {
        const value = normalizeAgentLoopActionObject(input,
            ['taskId', 'attemptId', 'expectedRevision', 'ownerId', 'actionId', ...extra]);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        return { value, scope: Object.freeze({ taskId: normalizeAgentLoopActionToken(value.taskId),
            attemptId: normalizeAgentLoopActionToken(value.attemptId), expectedRevision: Number(value.expectedRevision),
            ownerId: normalizeAgentLoopActionToken(value.ownerId), actionId: normalizeAgentLoopActionToken(value.actionId) }) };
    } catch { return reject('agent-loop-projection-input-invalid'); }
}

function actionValue<T>(normalize: (input: unknown) => T, input: unknown): T {
    try { return normalize(input); } catch { return reject('agent-loop-projection-input-invalid'); }
}

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('agent-loop-projection-input-invalid');
    return value;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) reject('agent-loop-projection-input-invalid');
    return value;
}

function exact(input: unknown, required: readonly string[], optional: readonly string[] = []):
Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        reject('agent-loop-projection-input-invalid');
    }
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== 'string'
        || (!required.includes(key) && !optional.includes(key)))) {
        reject('agent-loop-projection-input-invalid');
    }
    for (const key of required) if (!keys.includes(key)) reject('agent-loop-projection-input-invalid');
    return input as Record<string, unknown>;
}

function boundedLimit(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) {
        reject('agent-loop-projection-input-invalid');
    }
    return Number(value);
}

/** 展开预算上限：单条 ref 最多 64K token，超过就是「把正文塞进 Prompt」的伪装。 */
const MAX_REF_EXPAND_TOKENS = 65_536;

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
    if (typeof value !== 'string' || !values.includes(value as T)) {
        reject('agent-loop-projection-input-invalid');
    }
    return value as T;
}

export function normalizeAgentLoopArtifactRefDescriptor(input: unknown): AgentLoopArtifactRefDescriptor {
    const value = actionValue(value => normalizeAgentLoopActionObject(value, [
        'refId', 'kind', 'ownerRef', 'expectedDigest', 'policy', 'aclClass', 'expandBudgetTokens',
    ], ['expectedRevision']), input);
    if (Reflect.ownKeys(value).some(key => !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) reject('agent-loop-projection-input-invalid');
    if (typeof value.expectedDigest !== 'string' || !HASH.test(value.expectedDigest)) {
        reject('agent-loop-projection-input-invalid');
    }
    const budget = value.expandBudgetTokens;
    if (!Number.isSafeInteger(budget) || Number(budget) < 0
        || Number(budget) > MAX_REF_EXPAND_TOKENS) {
        reject('agent-loop-projection-input-invalid');
    }
    const expectedRevision = value.expectedRevision === undefined
        ? undefined : token(value.expectedRevision);
    return Object.freeze({
        refId: token(value.refId),
        kind: oneOf(value.kind, AGENT_LOOP_ARTIFACT_REF_KINDS),
        ownerRef: token(value.ownerRef),
        expectedDigest: value.expectedDigest,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        policy: oneOf(value.policy, AGENT_LOOP_ARTIFACT_REF_POLICIES),
        aclClass: oneOf(value.aclClass, AGENT_LOOP_ARTIFACT_REF_ACL_CLASSES),
        expandBudgetTokens: Number(budget),
    });
}

function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function directory(path: string): void {
    if (path === parse(path).root) reject('agent-loop-projection-storage-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            reject('agent-loop-projection-storage-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
        reject('agent-loop-projection-storage-invalid');
    }
}

function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    const value = (db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        reject('agent-loop-projection-storage-invalid');
    }
    return Number(value);
}

function schemaRows(db: DatabaseSync): string[] {
    return (db.prepare(
        "SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
    ).all() as SqlRow[]).map((row) => {
        if (typeof row.sql !== 'string') reject('agent-loop-projection-storage-invalid');
        return normalizeSchemaSql(row.sql);
    }).sort();
}

function normalizeSchema(statements: readonly string[]): string[] {
    return statements.map(normalizeSchemaSql).sort();
}

/** Keywords may fold case; CHECK literals/trigger messages/quoted identifiers are exact schema data. */
function normalizeSchemaSql(sql: string): string {
    return sql.trim().replace(/;$/u, '')
        .split(/('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])/gu)
        .map((part, index) => index % 2 ? part : part.replace(/\s+/gu, ' ').toLowerCase()).join('');
}

export function inspectAgentLoopProjectionSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== AGENT_LOOP_PROJECTION_APPLICATION_ID
        || pragma(db, 'user_version') !== AGENT_LOOP_PROJECTION_SCHEMA_VERSION) {
        reject('agent-loop-projection-storage-invalid');
    }
    inspectSchemaObjects(db, SCHEMA);
}

/** Read-only snapshot validation: no additional non-internal schema objects are accepted.
 * The runtime inspector deliberately remains permissive about unrelated objects. */
export function inspectAgentLoopProjectionSchemaExact(db: DatabaseSync): void {
    inspectAgentLoopProjectionSchema(db);
    inspectSchemaExact(db, SCHEMA);
}

/** Released schema7 snapshots stay readable without opening/migrating the database. */
export function inspectAgentLoopProjectionSchemaV7Exact(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== AGENT_LOOP_PROJECTION_APPLICATION_ID
        || pragma(db, 'user_version') !== 7) reject('agent-loop-projection-storage-invalid');
    inspectSchemaExact(db, V7_SCHEMA);
}

/** Released accounting-only schema8 backups remain inspectable without a migration. */
export function inspectAgentLoopProjectionSchemaV8Exact(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== AGENT_LOOP_PROJECTION_APPLICATION_ID
        || pragma(db, 'user_version') !== 8) reject('agent-loop-projection-storage-invalid');
    inspectSchemaExact(db, V8_SCHEMA);
}

function inspectSchemaExact(db: DatabaseSync, statements: readonly string[]): void {
    const expected = normalizeSchema(statements.map(sql =>
        sql.replace(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS/u, 'CREATE $1')));
    const actual = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
    ).all() as SqlRow[]).map((row) => {
        if (typeof row.sql !== 'string') reject('agent-loop-projection-storage-invalid');
        return normalizeSchemaSql(row.sql);
    }).sort();
    if (expected.length !== actual.length || expected.some((sql, index) => sql !== actual[index])) {
        reject('agent-loop-projection-storage-invalid');
    }
}

function inspectSchemaObjects(db: DatabaseSync, statements: readonly string[]): void {
    const expected = normalizeSchema(statements.map((sql) => sql.replace(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS/u, 'CREATE $1')));
    const actual = schemaRows(db);
    // 只比对**本 Store 自己的**对象：同库将来可能并存别的表，但不能少了自己的。
    if (expected.some((sql) => !actual.includes(sql))) {
        reject('agent-loop-projection-storage-invalid');
    }
}

/**
 * Historical v1..v6 additions remain frozen. Rebuild only the original receipt
 * CHECK for three exact contracts, preserving all prior row bytes and rowids.
 * 全部本 Store 对象自证在 COMMIT 前完成，旧坏 schema 不留下半套迁移对象或版本。
 */
function migrate(db: DatabaseSync, from: number): void {
    if (from === 7 || from === 8) {
        db.exec('BEGIN IMMEDIATE');
        try {
            inspectSchemaObjects(db, from === 7 ? V7_SCHEMA : V8_SCHEMA);
            if (from === 7) for (const statement of AGENT_LOOP_PROJECTION_V8_SCHEMA) db.exec(statement);
            migrateReadOnlyRpReceipt(db);
            db.exec(`PRAGMA user_version=${AGENT_LOOP_PROJECTION_SCHEMA_VERSION}`);
            inspectAgentLoopProjectionSchema(db);
            db.exec('COMMIT');
        } catch (error) {
            if (db.isTransaction) db.exec('ROLLBACK');
            throw error;
        }
        return;
    }
    if (from !== 1 && from !== 2 && from !== 3 && from !== 4 && from !== 5 && from !== 6) {
        reject('agent-loop-projection-storage-invalid');
    }
    const ladder: readonly (readonly string[])[] = [
        AGENT_LOOP_PROJECTION_V2_SCHEMA,
        AGENT_LOOP_PROJECTION_V3_SCHEMA,
        AGENT_LOOP_PROJECTION_V4_SCHEMA,
        AGENT_LOOP_PROJECTION_V5_SCHEMA,
    ];
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const statements of ladder.slice(from - 1)) {
            for (const statement of statements) db.exec(statement);
        }
        inspectSchemaObjects(db, [...AGENT_LOOP_PROJECTION_V1_SCHEMA, ...AGENT_LOOP_PROJECTION_V2_SCHEMA,
            ...AGENT_LOOP_PROJECTION_V3_SCHEMA, ...(from === 6 ? AGENT_LOOP_PROJECTION_V6_SCHEMA : AGENT_LOOP_PROJECTION_V4_SCHEMA),
            ...AGENT_LOOP_PROJECTION_V5_SCHEMA]);
        const unchangedTables = ['agent_loop_task', 'agent_loop_task_event', 'agent_loop_outbox', 'agent_loop_observation',
            'agent_loop_observation_quarantine', 'agent_loop_artifact_ref', 'agent_loop_completion_candidate', 'agent_loop_completion_verification'];
        const snapshot = () => JSON.stringify(unchangedTables.map(table => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()));
        const before = snapshot();
        // Do not silently drop somebody else's attached trigger/index while
        // replacing the original table. Such an unknown schema fails closed.
        const owned = ['agent_loop_action_receipt', 'agent_loop_action_receipt_task',
            'agent_loop_action_receipt_no_delete', 'agent_loop_action_receipt_binding_immutable'];
        const attached = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name='agent_loop_action_receipt' AND sql IS NOT NULL").all() as SqlRow[];
        if (attached.some(row => !owned.includes(String(row.name)))) reject('agent-loop-projection-storage-invalid');
        // ALTER TABLE may rewrite a view, a foreign key or a trigger owned by
        // somebody else to the staging name. Never silently mutate/drop those
        // unknown dependencies while widening this Store's exact CHECK.
        const dependencies = db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as SqlRow[];
        if (dependencies.some(row => !owned.includes(String(row.name))
            && /\bagent_loop_action_receipt\b/iu.test(String(row.sql)))) reject('agent-loop-projection-storage-invalid');
        // Keep the established staging name: older migration-conflict tests
        // and recoverable canaries must remain protected, not overwritten.
        db.exec(`DROP INDEX agent_loop_action_receipt_task;
            DROP TRIGGER agent_loop_action_receipt_no_delete;
            DROP TRIGGER agent_loop_action_receipt_binding_immutable;
            ALTER TABLE agent_loop_action_receipt RENAME TO agent_loop_action_receipt_v5;`);
        for (const statement of AGENT_LOOP_PROJECTION_V9_SCHEMA) db.exec(statement);
        const columns = 'action_id,task_id,attempt_id,task_revision,owner_id,action_digest,action_contract_ref,estimate_json,status,created_at,started_at,completed_at,receipt_ref,result_json,settled_at,observation_id,applied_revision,observed_at,released_at,metadata_digest';
        db.exec(`INSERT INTO agent_loop_action_receipt(rowid,${columns}) SELECT rowid,${columns} FROM agent_loop_action_receipt_v5;`);
        if (db.prepare(`SELECT rowid,${columns} FROM agent_loop_action_receipt_v5 EXCEPT SELECT rowid,${columns} FROM agent_loop_action_receipt`).get()
            || db.prepare(`SELECT rowid,${columns} FROM agent_loop_action_receipt EXCEPT SELECT rowid,${columns} FROM agent_loop_action_receipt_v5`).get()) {
            reject('agent-loop-projection-storage-invalid');
        }
        db.exec('DROP TABLE agent_loop_action_receipt_v5');
        if (snapshot() !== before || db.prepare('PRAGMA foreign_key_check').all().length) reject('agent-loop-projection-storage-invalid');
        for (const statement of AGENT_LOOP_PROJECTION_V8_SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${AGENT_LOOP_PROJECTION_SCHEMA_VERSION}`);
        // Reject malformed historical objects before committing any new object/version.
        inspectAgentLoopProjectionSchema(db);
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
}

/** Rebuild only the original receipt CHECK, retaining every row byte and rowid. */
function migrateReadOnlyRpReceipt(db: DatabaseSync): void {
    const owned = ['agent_loop_action_receipt', 'agent_loop_action_receipt_task',
        'agent_loop_action_receipt_no_delete', 'agent_loop_action_receipt_binding_immutable'];
    const objects = db.prepare('SELECT name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL').all() as SqlRow[];
    if (objects.some(row => !owned.includes(String(row.name))
        && (row.tbl_name === 'agent_loop_action_receipt' || /\bagent_loop_action_receipt\b/iu.test(String(row.sql))))) {
        reject('agent-loop-projection-storage-invalid');
    }
    const tables = ['agent_loop_task', 'agent_loop_task_event', 'agent_loop_outbox', 'agent_loop_observation',
        'agent_loop_observation_quarantine', 'agent_loop_artifact_ref', 'agent_loop_completion_candidate',
        'agent_loop_completion_verification', 'agent_loop_dag_policy', 'agent_loop_child_budget'];
    const snapshot = () => JSON.stringify(tables.map(table => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()));
    const before = snapshot();
    db.exec(`DROP INDEX agent_loop_action_receipt_task;
        DROP TRIGGER agent_loop_action_receipt_no_delete;
        DROP TRIGGER agent_loop_action_receipt_binding_immutable;
        ALTER TABLE agent_loop_action_receipt RENAME TO agent_loop_action_receipt_v8;`);
    for (const statement of AGENT_LOOP_PROJECTION_V9_SCHEMA) db.exec(statement);
    const columns = 'action_id,task_id,attempt_id,task_revision,owner_id,action_digest,action_contract_ref,estimate_json,status,created_at,started_at,completed_at,receipt_ref,result_json,settled_at,observation_id,applied_revision,observed_at,released_at,metadata_digest';
    db.exec(`INSERT INTO agent_loop_action_receipt(rowid,${columns}) SELECT rowid,${columns} FROM agent_loop_action_receipt_v8;`);
    if (db.prepare(`SELECT rowid,${columns} FROM agent_loop_action_receipt_v8 EXCEPT SELECT rowid,${columns} FROM agent_loop_action_receipt`).get()
        || db.prepare(`SELECT rowid,${columns} FROM agent_loop_action_receipt EXCEPT SELECT rowid,${columns} FROM agent_loop_action_receipt_v8`).get()) {
        reject('agent-loop-projection-storage-invalid');
    }
    db.exec('DROP TABLE agent_loop_action_receipt_v8');
    if (snapshot() !== before || db.prepare('PRAGMA foreign_key_check').all().length) reject('agent-loop-projection-storage-invalid');
}

function initialize(db: DatabaseSync): void {
    const applicationId = pragma(db, 'application_id');
    const version = pragma(db, 'user_version');
    if (!applicationId && !version) {
        if (schemaRows(db).length) reject('agent-loop-projection-storage-invalid');
        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(`PRAGMA application_id=${AGENT_LOOP_PROJECTION_APPLICATION_ID}`);
            for (const statement of SCHEMA) db.exec(statement);
            db.exec(`PRAGMA user_version=${AGENT_LOOP_PROJECTION_SCHEMA_VERSION}`);
            inspectAgentLoopProjectionSchema(db);
            db.exec('COMMIT');
        } catch (error) {
            if (db.isTransaction) db.exec('ROLLBACK');
            throw error;
        }
        inspectAgentLoopProjectionSchema(db);
        return;
    }
    if (applicationId !== AGENT_LOOP_PROJECTION_APPLICATION_ID) {
        reject('agent-loop-projection-storage-invalid');
    }
    if (version > AGENT_LOOP_PROJECTION_SCHEMA_VERSION) {
        // 比本进程新的库不能被旧代码打开：它可能已有本代码不认识的约束。
        reject('agent-loop-projection-storage-invalid');
    }
    if (version < AGENT_LOOP_PROJECTION_SCHEMA_VERSION) migrate(db, version);
    inspectAgentLoopProjectionSchema(db);
}

function eventDigest(input: Readonly<{
    eventId: string;
    taskId: string;
    revision: number;
    kind: string;
    reasonCode: string | null;
    envelopeDigest: string;
}>): string {
    return hash({
        eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION,
        eventId: input.eventId,
        taskId: input.taskId,
        revision: input.revision,
        kind: input.kind,
        reasonCode: input.reasonCode,
        envelopeDigest: input.envelopeDigest,
    });
}

/** Pure historical event identity, not an execution/completion grant. Domain
 * verifiers can bind a reconstructed prior Envelope to its ORIGINAL event. */
export const agentLoopProjectionEventDigest = eventDigest;

function normalizeDagAllocation(input: unknown): AgentLoopDagChildAllocation {
    const value = dagBudgetExact(input, ['reservationId', 'taskId', 'childEnvelope', 'deadlineAt',
        'requirement', 'profile']);
    if (value.requirement !== 'required' && value.requirement !== 'optional') {
        reject('agent-loop-projection-input-invalid');
    }
    const child = normalizeAgentLoopTaskEnvelope(value.childEnvelope);
    if (child.revision !== 1 || child.state !== 'CREATED' || child.phase !== 'PREPARE'
        || child.currentAttemptId !== undefined || child.plan !== undefined || child.wait !== undefined
        || child.completion !== undefined || child.children.length || child.dependencyTaskIds.length
        || child.todos.length || child.blockers.length || child.artifacts.length || child.confirmedFacts.length
        || Object.values(child.budget.reserved).some(n => n !== 0)
        || Object.values(child.budget.spent).some(n => n !== 0)
        || child.budget.granted.childTasks !== 0 || child.budget.granted.writes !== 0
        || child.budget.granted.highRiskActions !== 0
        || !Object.values(child.budget.granted).some(n => n > 0)) reject('agent-loop-projection-input-invalid');
    const taskId = dagBudgetToken(value.taskId);
    if (child.parentTaskId !== taskId || child.rootTaskId !== taskId) reject('agent-loop-projection-input-invalid');
    return Object.freeze({ reservationId: dagBudgetToken(value.reservationId), taskId,
        childEnvelope: child, deadlineAt: dagBudgetTimestamp(value.deadlineAt),
        requirement: value.requirement as 'required' | 'optional',
        profile: normalizeAgentLoopDagLeafProfile(value.profile) });
}

/**
 * 权威编排投影 Store。
 *
 * 一次 `commit` = 一条 accepted event + 一次 Envelope revision 前进 + 一条通知 outbox，
 * 三者同事务。CAS 失败不推进 revision，也不留事件。
 */
export class AgentLoopProjectionStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    #closed = false;
    #dagExecution: AgentLoopDagExecutionFrame | null = null;

    constructor(options: { readonly dataDir: string; readonly now?: () => string }) {
        if (typeof options?.dataDir !== 'string' || !options.dataDir.trim()) {
            reject('agent-loop-projection-input-invalid');
        }
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = joinPath(dataDir, AGENT_LOOP_PROJECTION_DB_FILE);
        for (const suffix of ['', '-wal', '-shm', '-journal']) regular(`${file}${suffix}`);
        this.#db = new DatabaseSync(file);
        this.#now = options.now ?? (() => new Date().toISOString());
        try {
            this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
            initialize(this.#db);
            this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
            for (const suffix of ['', '-wal', '-shm']) {
                const path = `${file}${suffix}`;
                regular(path);
                if (stat(path)) {
                    try { chmodSync(path, 0o600); }
                    catch (error) { if (process.platform !== 'win32') throw error; }
                }
            }
        } catch (error) { this.#db.close(); throw error; }
    }

    #open(): void {
        if (this.#closed) reject('agent-loop-projection-storage-invalid');
    }

    #transaction<T>(
        work: () => T,
        write = true,
        dagExecution?: AgentLoopDagLeafExecutionScope,
        settlementOutcome?: unknown,
        operation: AgentLoopDagOperation = 'execution',
    ): T {
        this.#open();
        // A caller reentering a public writer from an authorization callback must
        // not inherit the private leaf frame already held by its outer writer.
        if (this.#db.isTransaction || this.#dagExecution) reject('agent-loop-projection-input-invalid');
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            if (dagExecution) {
                const startedAt = timestamp(this.#now());
                const { root, child, settlementOnly } = this.#dagExecutionAuthority(
                    dagExecution,
                    startedAt,
                    settlementOutcome,
                    write ? operation : 'inspect',
                );
                this.#dagExecution = { scope: dagExecution, root, child, startedAt, settlementOnly };
            }
            const result = work();
            if (this.#dagExecution) this.#finishDagExecution(this.#dagExecution, write);
            this.#db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
            throw error;
        } finally {
            this.#dagExecution = null;
        }
    }

    /** Captured only by the trusted Runtime composition, never accepted in a
     * Model decision or normal Store input. Proxy retains the original Store
     * identity required by existing Gateway/Frozen Completion integrations.
     */
    createDagLeafExecutionPort(readScope: () => AgentLoopDagLeafExecutionScope | null): AgentLoopProjectionStore {
        if (typeof readScope !== 'function' || nodeTypes.isProxy(readScope))
            reject('agent-loop-projection-input-invalid');
        const capture = (): AgentLoopDagLeafExecutionScope => {
            let value: Record<string, unknown>;
            try {
                const supplied = readScope();
                if (nodeTypes.isPromise(supplied)) {
                    void Promise.prototype.then.call(
                        supplied,
                        () => undefined,
                        () => undefined,
                    );
                    reject('agent-loop-projection-input-invalid');
                }
                value = dagBudgetExact(supplied, [
                    'rootTaskId',
                    'rootAttemptId',
                    'rootExpectedRevision',
                    'rootOwnerId',
                    'reservationId',
                    'childTaskId',
                    'childAttemptId',
                    'childOwnerId',
                ]);
            } catch {
                return reject('agent-loop-projection-input-invalid');
            }
            return Object.freeze({
                rootTaskId: token(value.rootTaskId),
                rootAttemptId: token(value.rootAttemptId),
                rootExpectedRevision: dagBudgetInteger(value.rootExpectedRevision, 1),
                rootOwnerId: token(value.rootOwnerId),
                reservationId: token(value.reservationId),
                childTaskId: token(value.childTaskId),
                childAttemptId: token(value.childAttemptId),
                childOwnerId: token(value.childOwnerId),
            });
        };
        const writes = {
            commit: (input: unknown) => this.#commit(input, capture()),
            annotate: (input: unknown) => this.#annotate(input, capture()),
            ingestObservation: (input: unknown) => this.#ingestObservation(input, capture()),
            registerRef: (input: unknown) => this.#registerRef(input, capture()),
            reserveAction: (input: unknown) => this.#reserveAction(input, capture()),
            markActionStarted: (input: unknown) => this.#markActionStarted(input, capture()),
            completeAction: (input: unknown) => this.#completeAction(input, capture()),
            settleAction: (input: unknown) => this.#settleAction(input, capture()),
            releaseAction: (input: unknown) => this.#releaseAction(input, capture()),
            readActionReceipt: (input: unknown) => this.#readActionReceipt(input, capture()),
            commitRequestedVerification: (input: unknown, authorize: () => unknown) =>
                this.#commitRequestedVerification(input, authorize, capture()),
            freezeCompletionCandidate: (input: unknown) => this.#freezeCompletionCandidate(input, capture()),
            assertCompletionCandidateCurrent: (input: unknown) =>
                this.#assertCompletionCandidateCurrent(input, capture()),
            recordCompletionVerification: (input: unknown, authorize?: () => void) =>
                this.#recordCompletionVerification(input, authorize, capture()),
            completeVerifiedCandidate: (input: unknown, authorize: () => unknown) =>
                this.#completeVerifiedCandidate(input, authorize, capture()),
        };
        const reads = new Set([
            'read',
            'readEvents',
            'readObservations',
            'readRefs',
            'readRepairState',
            'readCompletionCandidate',
            'readCompletionVerification',
            'assertFrozenCandidateSnapshot',
            'assertCompletedCandidate',
        ]);
        return new Proxy(this, {
            get: (_target, key) => {
                if (typeof key !== 'string') return undefined;
                if (Object.hasOwn(writes, key)) return writes[key as keyof typeof writes];
                if (!reads.has(key)) return () => reject('agent-loop-projection-input-invalid');
                return (input: unknown) => {
                    const frame = capture();
                    const id =
                        typeof input === 'string'
                            ? input
                            : Object.getOwnPropertyDescriptor(input ?? {}, 'taskId')?.value;
                    if (id !== frame.childTaskId) reject('agent-loop-projection-input-invalid');
                    return (this[key as keyof AgentLoopProjectionStore] as (value: unknown) => unknown).call(
                        this,
                        input,
                    );
                };
            },
        });
    }

    #dagExecutionAuthority(
        scope: AgentLoopDagLeafExecutionScope,
        now: string,
        settlementOutcome?: unknown,
        operation: AgentLoopDagOperation = 'execution',
    ): Readonly<{
        root: AgentLoopTaskRecord;
        child: AgentLoopTaskRecord;
        settlementOnly: boolean;
    }> {
        const snapshot = this.#dagSnapshot(scope.rootTaskId),
            root = this.#requireRecord(scope.rootTaskId);
        const entry = snapshot.allocations.find((item) => item.allocation.reservationId === scope.reservationId);
        const child = this.#requireRecord(scope.childTaskId);
        const modeled = readAgentLoopModelOutcome(settlementOutcome),
            observation = modeled?.observation;
        const usage = observation?.usageDelta;
        // Only a live, physically returned Model receipt can outlive a dispatch
        // deadline for accounting. It cannot publish a Decision or execute Act.
        const settlementOnly =
            !!modeled &&
            observation?.sourceKind === 'provider' &&
            observation.completeness === 'complete' &&
            !!usage &&
            usage.modelCalls === 1 &&
            usage.toolCalls === 0 &&
            usage.writes === 0 &&
            usage.highRiskActions === 0 &&
            observation.taskId === scope.childTaskId &&
            observation.attemptId === scope.childAttemptId &&
            observation.observedForTaskRevision === child.revision &&
            child.envelope.phase === 'MODEL';
        this.#requireLease(root, scope.rootOwnerId, now, true);
        this.#requireLease(child, scope.childOwnerId, now, true);
        if (
            [root, child].some(
                (item) =>
                    !item.leaseExpiresAt ||
                    !Number.isFinite(Date.parse(item.leaseExpiresAt)) ||
                    new Date(item.leaseExpiresAt).toISOString() !== item.leaseExpiresAt,
            )
        )
            reject('agent-loop-projection-lease-lost');
        if (root.revision !== scope.rootExpectedRevision) reject('agent-loop-projection-revision-conflict');
        if (
            snapshot.state !== 'active' ||
            !(root.envelope.state === 'RUNNING' ||
                root.envelope.state === 'WAITING_EVENT' && root.envelope.wait?.kind === 'child') ||
            root.envelope.currentAttemptId !== scope.rootAttemptId ||
            !entry ||
            entry.status !== 'dispatched' ||
            entry.allocation.childEnvelope.taskId !== scope.childTaskId ||
            child.envelope.parentTaskId !== scope.rootTaskId ||
            child.envelope.rootTaskId !== scope.rootTaskId ||
            child.envelope.updatedAt > now ||
            root.envelope.updatedAt > now ||
            (child.envelope.currentAttemptId !== undefined &&
                child.envelope.currentAttemptId !== scope.childAttemptId) ||
            TERMINAL_STATES.has(child.envelope.state) ||
            (!settlementOnly && (now >= snapshot.policy.deadlineAt || now >= entry.allocation.deadlineAt)) ||
            (operation === 'execution' &&
                (root.envelope.children.some(item => item.joinState === 'rejected') ||
                    hasUnsettledAgentLoopDagBudgetOverrun(snapshot, (taskId) => this.#record(this.#row(taskId))) ||
                    AGENT_LOOP_TASK_BUDGET_KEYS.some(
                        (key) =>
                            child.envelope.budget.spent[key] + child.envelope.budget.reserved[key] >
                            child.envelope.budget.granted[key],
                    )))
        ) {
            reject('agent-loop-projection-input-invalid');
        }
        this.#assertDagLeafFrame(child.envelope, entry.allocation.childEnvelope);
        return { root, child, settlementOnly };
    }

    #assertDagLeafFrame(child: AgentLoopTaskEnvelopeV1, initial: AgentLoopTaskEnvelopeV1): void {
        const mutable = [
            'state',
            'phase',
            'revision',
            'updatedAt',
            'currentAttemptId',
            'plan',
            'todos',
            'confirmedFacts',
            'blockers',
            'artifacts',
            'completion',
            'wait',
            'budget',
        ];
        const identity = (task: AgentLoopTaskEnvelopeV1) =>
            Object.fromEntries(Object.entries(task).filter(([key]) => !mutable.includes(key)));
        if (
            JSON.stringify(identity(child)) !== JSON.stringify(identity(initial)) ||
            child.children.length ||
            child.wait !== undefined ||
            ['WAITING_INPUT', 'WAITING_EVENT'].includes(child.state) ||
            (child.state === 'CREATED' && (child.phase !== 'PREPARE' || child.currentAttemptId !== undefined)) ||
            child.budget.policyRef !== initial.budget.policyRef ||
            JSON.stringify(child.budget.granted) !== JSON.stringify(initial.budget.granted) ||
            Object.values(child.budget.reserved).some((n) => n !== 0) ||
            ['writes', 'highRiskActions', 'childTasks'].some(
                (key) =>
                    child.budget.granted[key as keyof AgentLoopDagBudgetVector] !== 0 ||
                    child.budget.spent[key as keyof AgentLoopDagBudgetVector] !== 0,
            )
        ) {
            reject('agent-loop-projection-input-invalid');
        }
    }

    #finishDagExecution(frame: AgentLoopDagExecutionFrame, write: boolean): void {
        const now = timestamp(this.#now()),
            scope = frame.scope;
        const root = this.#requireRecord(scope.rootTaskId),
            child = this.#requireRecord(scope.childTaskId);
        this.#requireLease(root, scope.rootOwnerId, now, true);
        this.#requireLease(child, scope.childOwnerId, now, true);
        if (
            now < frame.startedAt ||
            root.revision !== frame.root.revision ||
            root.envelopeDigest !== frame.root.envelopeDigest ||
            (child.envelope.currentAttemptId !== undefined && child.envelope.currentAttemptId !== scope.childAttemptId)
        ) {
            reject('agent-loop-projection-revision-conflict');
        }
        const row = this.#db
            .prepare('SELECT allocation_json,status FROM agent_loop_child_budget WHERE reservation_id=?')
            .get(scope.reservationId) as SqlRow;
        const allocation = normalizeDagAllocation(JSON.parse(String(row.allocation_json)));
        if (row.status !== 'dispatched' || !frame.settlementOnly && now >= allocation.deadlineAt
            || frame.settlementOnly && (child.envelope.phase !== 'MODEL' || frame.child.envelope.phase !== 'MODEL')) {
            reject('agent-loop-projection-input-invalid');
        }
        this.#assertDagLeafFrame(child.envelope, allocation.childEnvelope);
        if (child.revision !== frame.child.revision) {
            if (!write || child.revision < frame.child.revision || child.envelope.updatedAt > now)
                reject('agent-loop-projection-input-invalid');
            this.#dagAdvance(
                root,
                {
                    ...root.envelope,
                    children: root.envelope.children.map((item) =>
                        item.taskId === scope.childTaskId
                            ? { ...item, state: child.envelope.state, taskRevision: child.revision }
                            : item,
                    ),
                },
                'dag-child-progressed',
                `${scope.reservationId}:${child.revision}`,
                now,
            );
        }
        this.#dagSnapshot(scope.rootTaskId);
    }

    #row(taskId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM agent_loop_task WHERE task_id=?').get(taskId) as
            SqlRow | undefined;
    }

    #record(row: SqlRow | undefined): AgentLoopTaskRecord | null {
        if (!row) return null;
        let envelope: AgentLoopTaskEnvelopeV1;
        try {
            envelope = normalizeAgentLoopTaskEnvelope(JSON.parse(String(row.envelope_json)));
        } catch { reject('agent-loop-projection-storage-invalid'); }
        if (envelope.taskId !== String(row.task_id)
            || envelope.revision !== Number(row.revision)
            || JSON.stringify(envelope) !== String(row.envelope_json)) {
            // 定向读遇到坏行必须报错：沉默 null 会把「坏了」伪装成「没有」。
            reject('agent-loop-projection-storage-invalid');
        }
        const fenced = Number(row.fenced) === 1;
        return Object.freeze({
            envelope,
            envelopeDigest: String(row.envelope_digest),
            ownerId: row.owner_id === null ? null : String(row.owner_id),
            leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
            fenced,
            fenceReason: row.fence_reason === null ? null : String(row.fence_reason),
            revision: Number(row.revision),
        });
    }

    #requireRecord(taskId: string): AgentLoopTaskRecord {
        const record = this.#record(this.#row(taskId));
        if (!record) reject('agent-loop-projection-record-missing');
        if (record.fenced) reject('agent-loop-projection-fenced');
        return record;
    }

    /** 写入前统一校验 owner/lease；过期即视为丢失（不自动续租，避免静默延长）。 */
    #requireLease(record: AgentLoopTaskRecord, ownerId: string, now: string, allowDagMetadata = false): void {
        if (
            !allowDagMetadata &&
            this.#dagExecution &&
            (record.envelope.taskId !== this.#dagExecution.scope.childTaskId ||
                ownerId !== this.#dagExecution.scope.childOwnerId)
        )
            reject('agent-loop-projection-input-invalid');
        if (record.ownerId !== ownerId) reject('agent-loop-projection-lease-lost');
        if (record.leaseExpiresAt === null || Date.parse(record.leaseExpiresAt) <= Date.parse(now)) {
            reject('agent-loop-projection-lease-lost');
        }
        if (!allowDagMetadata && this.#dagBound(record.envelope.taskId)) {
            const frame = this.#dagExecution;
            if (!frame || frame.scope.childTaskId !== record.envelope.taskId || frame.scope.childOwnerId !== ownerId) {
                reject('agent-loop-projection-input-invalid');
            }
        }
    }

    #dagBound(taskId: string): boolean {
        return !!this.#db
            .prepare(
                `SELECT 1 FROM agent_loop_dag_policy WHERE root_task_id=?
            UNION ALL SELECT 1 FROM agent_loop_child_budget WHERE child_task_id=? LIMIT 1`,
            )
            .get(taskId, taskId);
    }

    #dagSnapshot(taskId: string): AgentLoopDagBudgetSnapshot {
        const row = this.#db.prepare('SELECT * FROM agent_loop_dag_policy WHERE root_task_id=?').get(taskId) as
            | SqlRow
            | undefined;
        if (!row) reject('agent-loop-projection-record-missing');
        try {
            const policy = normalizeAgentLoopDagRootPolicy(JSON.parse(String(row.policy_json)));
            const granted = normalizeAgentLoopDagBudget(JSON.parse(String(row.granted_json)));
            const record = this.#record(this.#row(taskId));
            if (
                !record ||
                JSON.stringify(policy) !== row.policy_json ||
                hash(policy) !== row.policy_digest ||
                JSON.stringify(granted) !== row.granted_json ||
                JSON.stringify(record.envelope.budget.granted) !== row.granted_json ||
                !['active', 'cancelled'].includes(String(row.state))
            )
                throw new Error('dag-row-invalid');
            const zero = normalizeAgentLoopDagBudget(
                Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((k) => [k, 0])),
            );
            let reserved = zero,
                spent = zero;
            const rows = this.#db
                .prepare(
                    `SELECT * FROM agent_loop_child_budget
                WHERE root_task_id=? ORDER BY reservation_id`,
                )
                .all(taskId) as SqlRow[];
            const allocations = rows.map((childRow) => {
                const allocation = normalizeDagAllocation(JSON.parse(String(childRow.allocation_json)));
                const child = this.#record(this.#row(allocation.childEnvelope.taskId));
                const status = String(childRow.status) as AgentLoopDagBudgetSnapshot['allocations'][number]['status'];
                const dispatchedAt =
                    childRow.dispatched_at === null ? null : dagBudgetTimestamp(childRow.dispatched_at);
                const finishedAt = childRow.finished_at === null ? null : dagBudgetTimestamp(childRow.finished_at);
                const usage =
                    childRow.usage_json === null
                        ? null
                        : normalizeAgentLoopDagBudget(JSON.parse(String(childRow.usage_json)));
                const settlementRef = childRow.settlement_ref === null ? null : dagBudgetToken(childRow.settlement_ref);
                if (
                    !child ||
                    allocation.taskId !== taskId ||
                    allocation.reservationId !== childRow.reservation_id ||
                    allocation.childEnvelope.taskId !== childRow.child_task_id ||
                    JSON.stringify(allocation) !== childRow.allocation_json ||
                    hash(allocation) !== childRow.allocation_digest ||
                    JSON.stringify(allocation.profile) !== JSON.stringify(policy.leafProfile) ||
                    allocation.deadlineAt > policy.deadlineAt ||
                    !['reserved', 'dispatched', 'released', 'settled'].includes(status) ||
                    (status === 'reserved'
                        ? dispatchedAt !== null || finishedAt !== null
                        : status === 'dispatched'
                          ? dispatchedAt === null || finishedAt !== null
                          : status === 'released'
                            ? dispatchedAt !== null || finishedAt === null
                            : dispatchedAt === null || finishedAt === null) ||
                    (status === 'settled') !== (usage !== null && settlementRef !== null) ||
                    (usage &&
                        (JSON.stringify(usage) !== childRow.usage_json ||
                            usage.childTasks !== 0 ||
                            hash({ reservationId: allocation.reservationId, usage, settlementRef }) !==
                                childRow.settlement_digest))
                )
                    throw new Error('dag-row-invalid');
                const initial = allocation.childEnvelope;
                this.#assertDagLeafFrame(child.envelope, initial);
                if (status === 'reserved' || status === 'released') {
                    if (
                        JSON.stringify({
                            ...child.envelope,
                            state: initial.state,
                            revision: initial.revision,
                            updatedAt: initial.updatedAt,
                        }) !== JSON.stringify(initial) ||
                        child.envelope.state !== (status === 'released' ? 'CANCELLED' : 'CREATED')
                    ) {
                        throw new Error('dag-child-invalid');
                    }
                } else if (
                    (usage && JSON.stringify(child.envelope.budget.spent) !== JSON.stringify(usage)) ||
                    (row.state === 'cancelled' && !TERMINAL_STATES.has(child.envelope.state)) ||
                    (child.envelope.state !== 'CREATED' &&
                        child.envelope.currentAttemptId === undefined &&
                        child.envelope.state !== 'CANCELLED')
                )
                    throw new Error('dag-child-invalid');
                if (status === 'reserved' || status === 'dispatched') {
                    reserved = addAgentLoopDagBudget(reserved, initial.budget.granted);
                }
                if (usage) spent = addAgentLoopDagBudget(spent, usage);
                return Object.freeze({ allocation, status, dispatchedAt, finishedAt, usage, settlementRef });
            });
            spent = addAgentLoopDagBudget(spent, { ...zero, childTasks: allocations.length });
            const children = record.envelope.children;
            if (
                JSON.stringify(record.envelope.budget.reserved) !== JSON.stringify(reserved) ||
                JSON.stringify(record.envelope.budget.spent) !== JSON.stringify(spent) ||
                children.length !== allocations.length ||
                allocations.length > policy.maxTotalChildren ||
                (row.state === 'cancelled' ? record.envelope.state !== 'CANCELLED' :
                    !(record.envelope.state === 'RUNNING' || record.envelope.state === 'WAITING_EVENT' &&
                        record.envelope.wait?.kind === 'child')) ||
                allocations.some((item) => {
                    const child = this.#record(this.#row(item.allocation.childEnvelope.taskId));
                    const joined = children.find((value) => value.taskId === item.allocation.childEnvelope.taskId);
                    return (
                        !child ||
                        !joined ||
                        (joined.taskRevision !== child.revision &&
                            !(child.fenced && joined.taskRevision === child.revision - 1)) ||
                        joined.requirement !== item.allocation.requirement ||
                        joined.state !== child.envelope.state ||
                        (joined.joinState === 'pending' ?
                            joined.evidenceRefs.length !== 0 || joined.outcomeRef !== undefined :
                            joined.joinState === 'rejected' ? !this.#dagRejectedJoinCurrent(record, joined) :
                            joined.joinState !== 'accepted' || item.status !== 'settled' ||
                            child.envelope.state !== 'COMPLETED' || !joined.outcomeRef ||
                            !joined.evidenceRefs.length || !this.#dagJoinedChildCurrent(record, joined) ||
                            !record.envelope.artifacts.some(artifact =>
                                artifact.artifactRef === joined.outcomeRef && artifact.kind === 'rp-child-analysis') ||
                            !this.#db.prepare('SELECT 1 FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
                                .get(taskId, joined.outcomeRef))
                    );
                })
            )
                throw new Error('dag-accounting-invalid');
            return Object.freeze({
                rootTaskId: taskId,
                policy,
                state: row.state as 'active' | 'cancelled',
                granted,
                record,
                allocations: Object.freeze(allocations),
            });
        } catch {
            return reject('agent-loop-projection-storage-invalid');
        }
    }

    #dagScope(
        input: unknown,
        extra: readonly string[] = [],
    ): Readonly<{
        value: Record<string, unknown>;
        taskId: string;
        expectedRevision: number;
        ownerId: string;
    }> {
        const value = dagBudgetExact(input, ['taskId', 'expectedRevision', 'ownerId', ...extra]);
        return {
            value,
            taskId: dagBudgetToken(value.taskId),
            expectedRevision: dagBudgetInteger(value.expectedRevision, 1),
            ownerId: dagBudgetToken(value.ownerId),
        };
    }

    #dagCurrent(scope: Readonly<{ taskId: string; ownerId: string }>, now: string): AgentLoopTaskRecord {
        const current = this.#requireRecord(scope.taskId);
        this.#requireLease(current, scope.ownerId, now, true);
        if (current.envelope.updatedAt > now) reject('agent-loop-projection-input-invalid');
        return current;
    }

    #dagAdvance(
        current: AgentLoopTaskRecord,
        next: AgentLoopTaskEnvelopeV1,
        kind: string,
        identity: string,
        now: string,
        reasonCode: string | null = null,
    ): AgentLoopTaskRecord {
        const envelope = normalizeAgentLoopTaskEnvelope({ ...next, revision: current.revision + 1, updatedAt: now });
        const digest = hash(envelope);
        const changed = this.#db
            .prepare(
                `UPDATE agent_loop_task SET state=?,phase=?,revision=?,envelope_json=?,
            envelope_digest=?,updated_at=? WHERE task_id=? AND revision=? AND fenced=0`,
            )
            .run(
                envelope.state,
                envelope.phase,
                envelope.revision,
                JSON.stringify(envelope),
                digest,
                now,
                envelope.taskId,
                current.revision,
            );
        if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
        this.#appendEvent(
            envelope.taskId,
            envelope.revision,
            {
                eventId: `dag:${hash({ taskId: envelope.taskId, kind, identity }).slice(7)}`,
                kind,
                reasonCode,
            },
            digest,
            now,
        );
        return this.#requireRecord(envelope.taskId);
    }

    /** Pins one host-granted root budget and immutable limits. It grants no new budget or execution. */
    bindDagRoot(input: unknown): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagScope(input, ['policy']);
        const policy = normalizeAgentLoopDagRootPolicy(scope.value.policy);
        return this.#transaction(() => {
            const now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const existing = this.#db
                .prepare('SELECT policy_digest FROM agent_loop_dag_policy WHERE root_task_id=?')
                .get(scope.taskId) as SqlRow | undefined;
            if (existing) {
                if (existing.policy_digest !== hash(policy)) reject('agent-loop-projection-event-conflict');
                return this.#dagSnapshot(scope.taskId);
            }
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const task = current.envelope;
            if (
                this.#dagBound(scope.taskId) ||
                task.rootTaskId !== task.taskId ||
                task.parentTaskId !== undefined ||
                task.state !== 'RUNNING' ||
                task.phase !== 'PREPARE' ||
                task.children.length ||
                task.plan !== undefined ||
                task.wait !== undefined ||
                task.completion !== undefined ||
                task.artifacts.length ||
                task.dependencyTaskIds.length ||
                task.todos.length ||
                task.blockers.length ||
                task.confirmedFacts.length ||
                this.#activeActions(task.taskId).length ||
                [task.budget.reserved, task.budget.spent].some((vector) =>
                    Object.values(vector).some((n) => n !== 0),
                ) ||
                policy.maxTotalChildren > task.budget.granted.childTasks ||
                policy.deadlineAt <= now ||
                Date.parse(policy.deadlineAt) - Date.parse(now) > task.budget.granted.wallMs ||
                this.#db
                    .prepare('SELECT 1 FROM agent_loop_task WHERE root_task_id=? AND task_id!=? LIMIT 1')
                    .get(task.taskId, task.taskId)
            )
                reject('agent-loop-projection-input-invalid');
            this.#db
                .prepare(
                    `INSERT INTO agent_loop_dag_policy
                (root_task_id,policy_json,policy_digest,granted_json,state,created_at) VALUES(?,?,?,?,?,?)`,
                )
                .run(
                    task.taskId,
                    JSON.stringify(policy),
                    hash(policy),
                    JSON.stringify(task.budget.granted),
                    'active',
                    now,
                );
            this.#dagAdvance(current, task, 'dag-policy-bound', hash(policy), now);
            return this.#dagSnapshot(task.taskId);
        });
    }

    /** Same-Store audit view, never a reconstructed dispatch permit. */
    readDagBudget(taskIdInput: unknown): AgentLoopDagBudgetSnapshot {
        return this.#transaction(() => this.#dagSnapshot(dagBudgetToken(taskIdInput)), false);
    }

    /** Atomically creates a leaf identity, consumes its permanent derivation slot and reserves its grant. */
    reserveDagChild(input: unknown, authorize?: (snapshot: AgentLoopDagBudgetSnapshot) => void): AgentLoopDagBudgetSnapshot {
        if (authorize !== undefined && (typeof authorize !== 'function' || nodeTypes.isProxy(authorize)))
            reject('agent-loop-projection-input-invalid');
        const scope = this.#dagScope(input, ['reservationId', 'childEnvelope', 'deadlineAt', 'requirement', 'profile']);
        const allocation = normalizeDagAllocation(
            Object.fromEntries(
                ['reservationId', 'taskId', 'childEnvelope', 'deadlineAt', 'requirement', 'profile'].map((key) => [
                    key,
                    scope.value[key],
                ]),
            ),
        );
        return this.#transaction(() => {
            let now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId),
                policy = snapshot.policy;
            if (authorize !== undefined) {
                if (!this.#dagAssertSynchronous(() => authorize(snapshot))) reject('agent-loop-projection-input-invalid');
                now = timestamp(this.#now());
                current = this.#dagCurrent(scope, now);
            }
            const replay = this.#db
                .prepare(
                    `SELECT allocation_digest FROM agent_loop_child_budget
                WHERE reservation_id=?`,
                )
                .get(allocation.reservationId) as SqlRow | undefined;
            if (replay) {
                if (replay.allocation_digest !== hash(allocation)) reject('agent-loop-projection-event-conflict');
                return snapshot;
            }
            if (current.envelope.children.some(item => item.joinState === 'rejected') ||
                hasUnsettledAgentLoopDagBudgetOverrun(snapshot, taskId => this.#record(this.#row(taskId)))) {
                reject('agent-loop-projection-input-invalid');
            }
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const active = snapshot.allocations.filter((item) =>
                ['reserved', 'dispatched'].includes(item.status),
            ).length;
            const child = allocation.childEnvelope,
                grant = child.budget.granted;
            const remaining = subtractAgentLoopDagBudget(
                subtractAgentLoopDagBudget(current.envelope.budget.granted, current.envelope.budget.spent),
                current.envelope.budget.reserved,
            );
            if (
                snapshot.state !== 'active' ||
                now >= policy.deadlineAt ||
                now >= allocation.deadlineAt ||
                allocation.deadlineAt > policy.deadlineAt ||
                child.createdAt > now ||
                child.updatedAt > now ||
                child.budget.policyRef !== current.envelope.budget.policyRef ||
                JSON.stringify(allocation.profile) !== JSON.stringify(policy.leafProfile) ||
                snapshot.allocations.length >= policy.maxTotalChildren ||
                active >= policy.maxConcurrentChildren ||
                remaining.childTasks < 1 ||
                Object.keys(grant).some(
                    (key) => grant[key as keyof typeof grant] > remaining[key as keyof typeof remaining],
                ) ||
                this.#row(child.taskId)
            ) {
                reject('agent-loop-projection-input-invalid');
            }
            this.#db
                .prepare(
                    `INSERT INTO agent_loop_child_budget
                (reservation_id,root_task_id,child_task_id,allocation_json,allocation_digest,status,created_at)
                VALUES(?,?,?,?,?,'reserved',?)`,
                )
                .run(
                    allocation.reservationId,
                    scope.taskId,
                    child.taskId,
                    JSON.stringify(allocation),
                    hash(allocation),
                    now,
                );
            this.#db
                .prepare(
                    `INSERT INTO agent_loop_task
                (task_id,root_task_id,state,phase,revision,envelope_json,envelope_digest,
                 owner_id,lease_expires_at,fenced,fence_reason,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,0,NULL,?,?)`,
                )
                .run(
                    child.taskId,
                    child.rootTaskId,
                    child.state,
                    child.phase,
                    child.revision,
                    JSON.stringify(child),
                    hash(child),
                    scope.ownerId,
                    current.leaseExpiresAt,
                    now,
                    now,
                );
            this.#appendEvent(
                child.taskId,
                1,
                {
                    eventId: `dag-child:${hash(allocation).slice(7)}`,
                    kind: 'dag-child-created',
                    reasonCode: null,
                },
                hash(child),
                now,
            );
            const budget = current.envelope.budget;
            this.#dagAdvance(
                current,
                {
                    ...current.envelope,
                    budget: {
                        ...budget,
                        reserved: addAgentLoopDagBudget(budget.reserved, grant),
                        spent: { ...budget.spent, childTasks: budget.spent.childTasks + 1 },
                    },
                    children: [
                        ...current.envelope.children,
                        {
                            taskId: child.taskId,
                            requirement: allocation.requirement,
                            state: child.state,
                            taskRevision: 1,
                            joinState: 'pending',
                            evidenceRefs: [],
                        },
                    ],
                },
                'dag-child-reserved',
                allocation.reservationId,
                now,
            );
            return this.#dagSnapshot(scope.taskId);
        });
    }

    /** Records dispatch intent only. Re-reading/replaying this metadata never grants another dispatch. */
    markDagChildDispatched(input: unknown): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagScope(input, ['reservationId']);
        const reservationId = dagBudgetToken(scope.value.reservationId);
        return this.#transaction(() => {
            const now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId);
            const entry = snapshot.allocations.find((item) => item.allocation.reservationId === reservationId);
            if (!entry) reject('agent-loop-projection-record-missing');
            if (snapshot.state !== 'active' || now >= snapshot.policy.deadlineAt || now >= entry.allocation.deadlineAt)
                reject('agent-loop-projection-input-invalid');
            if (entry.status === 'dispatched' || entry.status === 'settled') return snapshot;
            if (current.envelope.children.some(item => item.joinState === 'rejected') ||
                hasUnsettledAgentLoopDagBudgetOverrun(snapshot, taskId => this.#record(this.#row(taskId)))) {
                reject('agent-loop-projection-input-invalid');
            }
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            this.#requireRecord(entry.allocation.childEnvelope.taskId);
            if (
                snapshot.state !== 'active' ||
                entry.status !== 'reserved' ||
                now >= snapshot.policy.deadlineAt ||
                now >= entry.allocation.deadlineAt
            )
                reject('agent-loop-projection-input-invalid');
            this.#db
                .prepare(
                    `UPDATE agent_loop_child_budget SET status='dispatched',dispatched_at=?
                WHERE reservation_id=? AND status='reserved'`,
                )
                .run(now, reservationId);
            this.#dagAdvance(current, current.envelope, 'dag-child-dispatched', reservationId, now);
            return this.#dagSnapshot(scope.taskId);
        });
    }

    #dagChildScope(input: unknown, extra: readonly string[] = []) {
        const scope = this.#dagScope(input, ['attemptId', 'reservationId', 'waitId', ...extra]);
        return {
            ...scope,
            attemptId: token(scope.value.attemptId),
            reservationId: token(scope.value.reservationId),
            waitId: token(scope.value.waitId),
        };
    }

    /**
     * Host-selected maintenance context may be published only with an accepted
     * child join. This is intentionally narrower than the generic typed-ref API.
     */
    #dagMaintenanceRefs(input: unknown): readonly AgentLoopArtifactRefDescriptor[] {
        if (
            nodeTypes.isProxy(input) ||
            !Array.isArray(input) ||
            Object.getPrototypeOf(input) !== Array.prototype ||
            input.length < 1 ||
            input.length > 16 ||
            Reflect.ownKeys(input).length !== input.length + 1
        )
            reject('agent-loop-projection-input-invalid');
        const refs = Array.from({ length: input.length }, (_, index) => {
            const field = Object.getOwnPropertyDescriptor(input, String(index));
            if (!field?.enumerable || !Object.hasOwn(field, 'value'))
                reject('agent-loop-projection-input-invalid');
            const ref = normalizeAgentLoopArtifactRefDescriptor(field.value);
            if (
                !['memory-fact', 'rolling-summary'].includes(ref.kind) ||
                ref.aclClass !== 'session' ||
                ref.expandBudgetTokens > 32_768
            )
                reject('agent-loop-projection-input-invalid');
            return ref;
        });
        if (new Set(refs.map((ref) => ref.refId)).size !== refs.length)
            reject('agent-loop-projection-input-invalid');
        return Object.freeze(
            refs.sort((left, right) => (left.refId < right.refId ? -1 : left.refId > right.refId ? 1 : 0)),
        );
    }

    #dagMaintenanceRefsMatchAcceptedJoin(
        taskId: string,
        childRefId: string,
        refs: readonly AgentLoopArtifactRefDescriptor[],
    ): boolean {
        const anchorRow = this.#db
            .prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
            .get(taskId, childRefId) as SqlRow | undefined;
        if (!anchorRow) return false;
        const anchor = this.#refRecord(anchorRow);
        const rows = this.#db
            .prepare("SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND kind IN ('memory-fact','rolling-summary') ORDER BY ref_id")
            .all(taskId) as SqlRow[];
        if (rows.length !== refs.length) return false;
        return rows.every((row, index) => {
            const stored = this.#refRecord(row),
                expected = refs[index];
            if (
                !expected ||
                stored.refId !== expected.refId ||
                stored.kind !== expected.kind ||
                stored.ownerRef !== expected.ownerRef ||
                stored.expectedDigest !== expected.expectedDigest ||
                stored.expectedRevision !== expected.expectedRevision ||
                stored.policy !== expected.policy ||
                stored.aclClass !== expected.aclClass ||
                stored.expandBudgetTokens !== expected.expandBudgetTokens ||
                stored.taskRevision !== anchor.taskRevision ||
                stored.registeredAt !== anchor.registeredAt
            )
                return false;
            const eventId = `dag-context-ref-registered:${hash({
                taskId,
                refId: stored.refId,
            }).slice(7)}`;
            const event = this.#db
                .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                .get(eventId) as SqlRow | undefined;
            if (
                !event ||
                event.task_id !== taskId ||
                Number(event.revision) !== anchor.taskRevision ||
                event.kind !== 'ref-registered' ||
                event.reason_code !== null ||
                event.accepted_at !== anchor.registeredAt
            )
                return false;
            return true;
        });
    }

    #registerDagMaintenanceRefAt(
        current: AgentLoopTaskRecord,
        ref: AgentLoopArtifactRefDescriptor,
        now: string,
    ): void {
        const taskId = current.envelope.taskId;
        if (
            this.#db
                .prepare('SELECT 1 FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
                .get(taskId, ref.refId)
        )
            reject('agent-loop-projection-ref-conflict');
        this.#db
            .prepare(
                `INSERT INTO agent_loop_artifact_ref (task_id,ref_id,kind,owner_ref,expected_digest,
                 expected_revision,policy,acl_class,expand_budget_tokens,task_revision,registered_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
                taskId,
                ref.refId,
                ref.kind,
                ref.ownerRef,
                ref.expectedDigest,
                ref.expectedRevision ?? null,
                ref.policy,
                ref.aclClass,
                ref.expandBudgetTokens,
                current.revision,
                now,
            );
        this.#appendEvent(
            taskId,
            current.revision,
            {
                eventId: `dag-context-ref-registered:${hash({ taskId, refId: ref.refId }).slice(7)}`,
                kind: 'ref-registered',
                reasonCode: null,
            },
            current.envelopeDigest,
            now,
        );
    }

    #dagJoinedChildCurrent(root: AgentLoopTaskRecord, joined: AgentLoopTaskEnvelopeV1['children'][number]): boolean {
        if (!joined.outcomeRef || joined.evidenceRefs.length < 2) return false;
        const taskId = root.envelope.taskId,
            refId = joined.outcomeRef;
        const row = this.#db
            .prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
            .get(taskId, refId) as SqlRow | undefined;
        const childRow = this.#db
            .prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
            .get(joined.taskId, refId) as SqlRow | undefined;
        if (!row || !childRow) return false;
        const ref = this.#refRecord(row),
            childRef = this.#refRecord(childRow);
        const ownDescriptor = ({
            taskRevision: ignoredRevision,
            registeredAt: ignoredTime,
            ...value
        }: AgentLoopArtifactRefRecord) => {
            void ignoredRevision;
            void ignoredTime;
            return value;
        };
        if (agentLoopCompletionDigest(ownDescriptor(ref)) !== agentLoopCompletionDigest(ownDescriptor(childRef)))
            return false;
        const observation = this.#db
            .prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?')
            .get(joined.evidenceRefs[0]!) as SqlRow | undefined;
        const eventIds = [joined.evidenceRefs[1]!, `dag-ref-registered:${hash({ taskId, refId }).slice(7)}`];
        const events = eventIds.map(
            (id) =>
                this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?').get(id) as SqlRow | undefined,
        );
        if (
            !observation ||
            observation.task_id !== taskId ||
            observation.attempt_id !== root.envelope.currentAttemptId ||
            observation.source_kind !== 'child-task' ||
            observation.classification !== 'applied' ||
            observation.satisfies_verification !== 1 ||
            observation.completeness !== 'complete' ||
            Number(observation.applied_revision) >= ref.taskRevision
        )
            return false;
        return events.every((event, index) => {
            if (
                !event ||
                event.task_id !== taskId ||
                event.revision !== ref.taskRevision ||
                event.kind !== (index === 0 ? 'dag-child-joined-woke' : 'ref-registered') ||
                event.reason_code !== null ||
                event.accepted_at !== ref.registeredAt
            )
                return false;
            const outbox = this.#db
                .prepare('SELECT * FROM agent_loop_outbox WHERE event_id=?')
                .all(eventIds[index]!) as SqlRow[];
            return (
                outbox.length === 1 &&
                outbox[0]!.task_id === taskId &&
                outbox[0]!.revision === ref.taskRevision &&
                outbox[0]!.event_digest === event.event_digest &&
                outbox[0]!.created_at === event.accepted_at
            );
        });
    }

    /** A durable child wait releases execution; it is not another dispatch grant. */
    waitForDagChild(input: unknown): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagChildScope(input);
        return this.#transaction(() => {
            const now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId);
            const entry = snapshot.allocations.find((value) => value.allocation.reservationId === scope.reservationId);
            if (
                !entry ||
                current.envelope.currentAttemptId !== scope.attemptId ||
                snapshot.state !== 'active' ||
                now >= snapshot.policy.deadlineAt ||
                now >= entry.allocation.deadlineAt
            )
                reject('agent-loop-projection-input-invalid');
            const wait = current.envelope.wait;
            if (
                wait?.waitId === scope.waitId &&
                wait.kind === 'child' &&
                wait.correlationRef === entry.allocation.childEnvelope.taskId &&
                wait.expectedObservationContractRef === AGENT_LOOP_DAG_CHILD_OBSERVATION_CONTRACT &&
                wait.resumePredicateRef === AGENT_LOOP_DAG_CHILD_RESUME_PREDICATE &&
                scope.expectedRevision <= current.revision
            )
                return snapshot;
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const child = current.envelope.children.find(
                (value) => value.taskId === entry.allocation.childEnvelope.taskId,
            );
            if (
                current.envelope.state !== 'RUNNING' ||
                current.envelope.phase !== 'PREPARE' ||
                wait ||
                !child ||
                child.joinState !== 'pending' ||
                entry.status === 'released'
            )
                reject('agent-loop-projection-input-invalid');
            this.#dagAdvance(
                current,
                {
                    ...current.envelope,
                    state: 'WAITING_EVENT',
                    wait: {
                        waitId: scope.waitId,
                        kind: 'child',
                        correlationRef: child.taskId,
                        expectedObservationContractRef: AGENT_LOOP_DAG_CHILD_OBSERVATION_CONTRACT,
                        resumePredicateRef: AGENT_LOOP_DAG_CHILD_RESUME_PREDICATE,
                        since: now,
                        deadlineAt: entry.allocation.deadlineAt,
                    },
                },
                'dag-child-wait-entered',
                scope.waitId,
                now,
            );
            return this.#dagSnapshot(scope.taskId);
        });
    }

    #dagRejectedJoinCurrent(root: AgentLoopTaskRecord, joined: AgentLoopTaskEnvelopeV1['children'][number]): boolean {
        if (!['FAILED', 'CANCELLED'].includes(joined.state) || joined.evidenceRefs.length !== 4
            || !joined.outcomeRef || !joined.evidenceRefs.includes(joined.outcomeRef)) return false;
        const revision = joined.evidenceRefs.find(ref => /^child-revision:[1-9][0-9]*$/u.test(ref));
        const digest = joined.evidenceRefs.find(ref => /^child-event-digest:sha256:[a-f0-9]{64}$/u.test(ref));
        if (!revision || !digest || !joined.evidenceRefs.some(ref => /^child-correlation:sha256:[a-f0-9]{64}$/u.test(ref))) return false;
        const event = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
            .get(joined.outcomeRef) as SqlRow | undefined;
        const terminal = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? AND revision=? AND event_digest=?')
            .get(joined.taskId, Number(revision.slice('child-revision:'.length)), digest.slice('child-event-digest:'.length)) as SqlRow | undefined;
        return !!event && !!terminal && event.task_id === root.envelope.taskId
            && event.kind === 'dag-child-join-rejected' && ['child-failed', 'child-cancelled'].includes(String(event.reason_code))
            && Number(event.revision) <= root.revision && terminal.task_id === joined.taskId
            && Number(terminal.revision) <= joined.taskRevision
            && String(terminal.accepted_at) <= String(event.accepted_at)
            && root.envelope.blockers.some(blocker => blocker.blockerId === joined.outcomeRef
                && blocker.status === 'open' && blocker.reasonCode === event.reason_code
                && JSON.stringify(blocker.evidenceRefs) === JSON.stringify(joined.evidenceRefs));
    }

    /** Known terminal child failure joins as a durable blocker. Unknown work keeps its full hold. */
    rejectDagChild(input: unknown, authorize: () => void): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagChildScope(input);
        if (typeof authorize !== 'function' || nodeTypes.isProxy(authorize)) reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            let now = timestamp(this.#now()), current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId);
            const entry = snapshot.allocations.find(item => item.allocation.reservationId === scope.reservationId);
            if (!entry) reject('agent-loop-projection-input-invalid');
            const child = this.#requireRecord(entry.allocation.childEnvelope.taskId);
            const joined = current.envelope.children.find(item => item.taskId === child.envelope.taskId)!;
            const correlation = agentLoopCompletionDigest({ waitId: scope.waitId, attemptId: scope.attemptId, reservationId: scope.reservationId });
            if (joined.joinState === 'rejected') {
                if (current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'PREPARE' || current.envelope.wait
                    || current.envelope.currentAttemptId !== scope.attemptId || !joined.evidenceRefs.includes(`child-correlation:${correlation}`))
                    return snapshot;
                if (!this.#dagAssertSynchronous(authorize)) reject('agent-loop-projection-input-invalid');
                this.#dagCurrent(scope, timestamp(this.#now()));
                return snapshot;
            }
            if (snapshot.state !== 'active' || child.fenced || current.envelope.currentAttemptId !== scope.attemptId
                || current.envelope.state !== 'WAITING_EVENT' || current.envelope.phase !== 'PREPARE'
                || current.envelope.wait?.waitId !== scope.waitId || current.envelope.wait.kind !== 'child'
                || current.envelope.wait.correlationRef !== child.envelope.taskId
                || now >= snapshot.policy.deadlineAt || now >= entry.allocation.deadlineAt) return snapshot;
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            if (joined.joinState !== 'pending' || !['FAILED', 'CANCELLED'].includes(child.envelope.state))
                reject('agent-loop-projection-input-invalid');
            if (!this.#dagAssertSynchronous(authorize)) reject('agent-loop-projection-input-invalid');
            now = timestamp(this.#now());
            current = this.#dagCurrent(scope, now);
            if (now >= snapshot.policy.deadlineAt || now >= entry.allocation.deadlineAt)
                reject('agent-loop-projection-input-invalid');
            const terminal = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? AND revision=? ORDER BY seq DESC LIMIT 1')
                .get(child.envelope.taskId, child.revision) as SqlRow | undefined;
            if (!terminal || terminal.event_digest !== eventDigest({ taskId: child.envelope.taskId,
                eventId: String(terminal.event_id), revision: child.revision, kind: String(terminal.kind),
                reasonCode: terminal.reason_code === null ? null : String(terminal.reason_code),
                envelopeDigest: child.envelopeDigest })) reject('agent-loop-projection-storage-invalid');
            const identity = `${correlation}:${terminal.event_id}`;
            const eventId = `dag:${hash({ taskId: scope.taskId, kind: 'dag-child-join-rejected', identity }).slice(7)}`;
            const reasonCode = child.envelope.state === 'FAILED' ? 'child-failed' : 'child-cancelled';
            const evidenceRefs = [eventId, `child-revision:${child.revision}`,
                `child-event-digest:${terminal.event_digest}`, `child-correlation:${correlation}`];
            const { wait: ignored, ...base } = current.envelope;
            void ignored;
            this.#dagAdvance(current, { ...base, state: 'RUNNING', phase: 'PREPARE',
                children: base.children.map(item => item.taskId === child.envelope.taskId
                    ? { ...item, joinState: 'rejected', outcomeRef: eventId, evidenceRefs } : item),
                blockers: [...base.blockers, { blockerId: eventId, reasonCode, status: 'open', evidenceRefs }],
            }, 'dag-child-join-rejected', identity, now, reasonCode);
            return this.#dagSnapshot(scope.taskId);
        });
    }

    #dagAssertSynchronous(authorize: () => void): boolean {
        try {
            const result: unknown = authorize();
            if (nodeTypes.isPromise(result)) {
                void Promise.prototype.then.call(result, undefined, () => undefined);
                return false;
            }
            return result === undefined;
        } catch {
            return false;
        }
    }

    #dagChildEvidence(
        scope: { taskId: string; attemptId: string; reservationId: string; waitId: string },
        evidence: RpChildResultEvidenceV1,
    ) {
        const value = dagBudgetExact(evidence, [
            'version',
            'parentTaskId',
            'parentAttemptId',
            'childTaskId',
            'childAttemptId',
            'childRevision',
            'childEnvelopeDigest',
            'childTaskUpdatedAt',
            'candidateRef',
            'candidateDigest',
            'verificationResultRef',
            'verificationDigest',
            'sourceBindingDigest',
            'requiredVerifierIds',
            'artifact',
            'evidenceRefs',
            'proofDigest',
        ]);
        const snapshot = this.#dagSnapshot(scope.taskId);
        const entry = snapshot.allocations.find((item) => item.allocation.reservationId === scope.reservationId);
        if (
            !entry ||
            value.version !== 'agent-loop-rp-child-result-evidence-v1' ||
            value.parentTaskId !== scope.taskId ||
            value.childTaskId !== entry.allocation.childEnvelope.taskId ||
            entry.status !== 'settled'
        )
            reject('agent-loop-projection-input-invalid');
        const child = this.#requireRecord(String(value.childTaskId));
        if (
            child.fenced ||
            child.envelope.state !== 'COMPLETED' ||
            child.envelope.phase !== 'VERIFY' ||
            child.envelope.parentTaskId !== scope.taskId ||
            child.envelope.rootTaskId !== scope.taskId ||
            child.envelope.taskContractRef !== 'task.rp-child-analysis.v1' ||
            value.childAttemptId !== child.envelope.currentAttemptId ||
            value.childRevision !== child.revision ||
            value.childEnvelopeDigest !== child.envelopeDigest ||
            !entry.usage ||
            JSON.stringify(entry.usage) !== JSON.stringify(child.envelope.budget.spent)
        )
            reject('agent-loop-projection-input-invalid');
        this.#assertCompletedCandidateAt(
            child.envelope.taskId,
            token(value.candidateRef),
            token(value.verificationResultRef),
            timestamp(value.childTaskUpdatedAt),
        );
        const candidate = this.#completionCandidateRecord(
            this.#db
                .prepare('SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?')
                .get(token(value.candidateRef)) as SqlRow,
        )!;
        const verification = this.#completionVerificationRecord(
            this.#db
                .prepare('SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                .get(token(value.verificationResultRef)) as SqlRow,
        )!;
        const required = ['rp.output-schema', 'rp.source-binding', 'rp.player-sovereignty'];
        const ref = normalizeAgentLoopArtifactRefDescriptor(value.artifact);
        const refRow = this.#db
            .prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?')
            .get(child.envelope.taskId, ref.refId) as SqlRow | undefined;
        if (!refRow) reject('agent-loop-projection-input-invalid');
        const storedRef = this.#refRecord(refRow);
        const { proofDigest: ignored, ...core } = evidence;
        void ignored;
        if (
            value.candidateDigest !== candidate.frozenDigest ||
            value.verificationDigest !== verification.verificationDigest ||
            candidate.verifierSetRef !== 'verifiers.rp-child-analysis.v1' ||
            candidate.verifierSetRevision !== '1.0.0' ||
            !storedRef ||
            value.proofDigest !== agentLoopCompletionDigest(core) ||
            agentLoopCompletionDigest(value.requiredVerifierIds) !== agentLoopCompletionDigest(required) ||
            agentLoopCompletionDigest(value.evidenceRefs) !==
                agentLoopCompletionDigest([
                    ...new Set([
                        ...verification.evaluation.evidenceRefs,
                        candidate.frozenDigest,
                        verification.verificationDigest,
                        ref.refId,
                    ]),
                ]) ||
            required.some(
                (id) =>
                    verification.evaluation.verifierResults.filter(
                        (result) => result.verifierId === id && result.disposition === 'passed',
                    ).length !== 1,
            ) ||
            agentLoopCompletionDigest(ref) !==
                agentLoopCompletionDigest(
                    normalizeAgentLoopArtifactRefDescriptor({
                        refId: storedRef.refId,
                        kind: storedRef.kind,
                        ownerRef: storedRef.ownerRef,
                        expectedDigest: storedRef.expectedDigest,
                        ...(storedRef.expectedRevision === undefined
                            ? {}
                            : { expectedRevision: storedRef.expectedRevision }),
                        policy: storedRef.policy,
                        aclClass: storedRef.aclClass,
                        expandBudgetTokens: storedRef.expandBudgetTokens,
                    }),
                ) ||
            ref.kind !== 'session-artifact' ||
            ref.policy !== 'required' ||
            ref.aclClass !== 'restricted' ||
            ref.expandBudgetTokens !== AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS ||
            child.envelope.artifacts.filter(
                (artifact) =>
                    artifact.artifactRef === ref.refId &&
                    artifact.kind === 'rp-child-analysis' &&
                    ['available', 'verified'].includes(artifact.status),
            ).length !== 1
        )
            reject('agent-loop-projection-input-invalid');
        return { snapshot, entry, child, ref, verification };
    }

    #dagChildNotificationId(scope: { taskId: string; waitId: string }, evidence: RpChildResultEvidenceV1): string {
        return `child-result:${agentLoopCompletionDigest({
            taskId: scope.taskId,
            waitId: scope.waitId,
            childTaskId: evidence.childTaskId,
            childEnvelopeDigest: evidence.childEnvelopeDigest,
        }).slice(7)}`;
    }

    #dagChildWaitCurrent(
        scope: { taskId: string; attemptId: string; waitId: string },
        evidence: RpChildResultEvidenceV1,
        now: string,
    ): boolean {
        const snapshot = this.#dagSnapshot(scope.taskId),
            root = snapshot.record,
            wait = root.envelope.wait;
        const entry = snapshot.allocations.find(
            (item) => item.allocation.childEnvelope.taskId === evidence.childTaskId,
        )!;
        return (
            evidence.parentAttemptId === scope.attemptId &&
            snapshot.state === 'active' &&
            root.envelope.state === 'WAITING_EVENT' &&
            root.envelope.currentAttemptId === scope.attemptId &&
            root.envelope.phase === 'PREPARE' &&
            wait?.kind === 'child' &&
            wait.waitId === scope.waitId &&
            wait.correlationRef === evidence.childTaskId &&
            wait.expectedObservationContractRef === AGENT_LOOP_DAG_CHILD_OBSERVATION_CONTRACT &&
            wait.resumePredicateRef === AGENT_LOOP_DAG_CHILD_RESUME_PREDICATE &&
            now < snapshot.policy.deadlineAt &&
            now < entry.allocation.deadlineAt &&
            (!wait.deadlineAt || now < wait.deadlineAt)
        );
    }

    #dagRejectedChild(current: AgentLoopTaskRecord, observationId: string, now: string): AgentLoopDagChildNotification {
        this.#appendEvent(
            current.envelope.taskId,
            current.revision,
            {
                eventId: `child-result-rejected:${hash({ observationId, revision: current.revision }).slice(7)}`,
                kind: 'dag-child-result-rejected',
                reasonCode: 'child-result-not-current',
            },
            current.envelopeDigest,
            now,
        );
        return Object.freeze({
            classification: 'stale',
            record: current,
            observationId,
            observationDigest: hash({ observationId }),
            reasonCodes: ['observation-task-revision-stale'] as const,
            satisfiesVerification: false,
        });
    }

    /** Durable metadata-only notification. Child physical usage is already settled, never replayed here. */
    notifyDagChildCompleted(input: unknown, authorize: () => void): AgentLoopDagChildNotification {
        const scope = this.#dagChildScope(input, ['evidence']);
        if (typeof authorize !== 'function' || nodeTypes.isProxy(authorize))
            reject('agent-loop-projection-input-invalid');
        const evidence = scope.value.evidence as RpChildResultEvidenceV1;
        return this.#transaction(() => {
            let now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            this.#dagChildEvidence(scope, evidence);
            const observationId = this.#dagChildNotificationId(scope, evidence);
            const seen = this.#db
                .prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?')
                .get(observationId) as SqlRow | undefined;
            const authorized = this.#dagAssertSynchronous(authorize);
            now = timestamp(this.#now());
            current = this.#dagCurrent(scope, now);
            const alreadyJoined =
                !!seen &&
                current.envelope.state === 'RUNNING' &&
                current.envelope.currentAttemptId === scope.attemptId &&
                current.envelope.children.some(
                    (value) =>
                        value.taskId === evidence.childTaskId &&
                        value.joinState === 'accepted' &&
                        value.outcomeRef === evidence.artifact.refId &&
                        value.evidenceRefs.includes(observationId),
                );
            if (!authorized || (!alreadyJoined && !this.#dagChildWaitCurrent(scope, evidence, now)))
                return this.#dagRejectedChild(current, observationId, now);
            if (!seen && current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const observation = normalizeObservationStrict({
                contractVersion: 'agent-loop-observation-v1',
                observationId,
                taskId: scope.taskId,
                attemptId: scope.attemptId,
                observedForTaskRevision: seen ? Number(seen.observed_for_revision) : current.revision,
                sourceKind: 'child-task',
                sourceRef: evidence.childTaskId,
                correlationRef: scope.waitId,
                observedAt: seen ? String(seen.observed_at) : now,
                ingestedAt: now,
                payloadDigest: evidence.artifact.expectedDigest,
                payloadRef: evidence.artifact.refId,
                completeness: 'complete',
                evidenceRefs: evidence.evidenceRefs,
            });
            const reduction = reduceAgentLoopObservation({
                envelope: current.envelope,
                observation,
                storedDigest: seen ? String(seen.observation_digest) : null,
            });
            const digest = agentLoopObservationDigest(observation);
            if (reduction.classification === 'duplicate')
                return Object.freeze({ ...reduction, record: current, observationId, observationDigest: digest });
            if (reduction.classification !== 'applied' || !reduction.envelope)
                reject('agent-loop-projection-observation-conflict');
            const next = reduction.envelope,
                envelopeDigest = hash(next);
            const changed = this.#db
                .prepare(
                    `UPDATE agent_loop_task SET state=?,phase=?,revision=?,envelope_json=?,
                envelope_digest=?,updated_at=? WHERE task_id=? AND revision=? AND fenced=0`,
                )
                .run(
                    next.state,
                    next.phase,
                    next.revision,
                    JSON.stringify(next),
                    envelopeDigest,
                    next.updatedAt,
                    scope.taskId,
                    current.revision,
                );
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
            this.#insertObservation(observation, 'applied', reduction, next.revision, now);
            this.#appendEvent(
                scope.taskId,
                next.revision,
                { eventId: `observation:${observationId}`, kind: 'observation-applied', reasonCode: null },
                envelopeDigest,
                now,
            );
            this.#dagSnapshot(scope.taskId);
            return Object.freeze({
                classification: 'applied',
                record: this.#requireRecord(scope.taskId),
                observationId,
                observationDigest: digest,
                reasonCodes: reduction.reasonCodes,
                satisfiesVerification: reduction.satisfiesVerification,
            });
        });
    }

    /** Exact original Observation consumption, child join, typed-ref registration and wake share one CAS. */
    joinDagChildAndWake(input: unknown, authorize: () => void): AgentLoopDagBudgetSnapshot {
        const hasMaintenanceRefs =
            !!input &&
            typeof input === 'object' &&
            !Array.isArray(input) &&
            !nodeTypes.isProxy(input) &&
            Object.hasOwn(input, 'maintenanceRefs');
        const scope = this.#dagChildScope(
            input,
            ['evidence', 'observationId', ...(hasMaintenanceRefs ? ['maintenanceRefs'] : [])],
        );
        const maintenanceRefs = hasMaintenanceRefs ? this.#dagMaintenanceRefs(scope.value.maintenanceRefs) : [];
        // The first accepted child pins the parent's P3 selection. Later joins
        // reuse that exact registration, including its original event and time.
        const matchesAcceptedMaintenanceRefs = (record: AgentLoopTaskRecord) => record.envelope.children.some(child =>
            child.joinState === 'accepted' && child.outcomeRef !== undefined &&
            this.#dagMaintenanceRefsMatchAcceptedJoin(scope.taskId, child.outcomeRef, maintenanceRefs));
        if (typeof authorize !== 'function' || nodeTypes.isProxy(authorize))
            reject('agent-loop-projection-input-invalid');
        const evidence = scope.value.evidence as RpChildResultEvidenceV1;
        const observationId = token(scope.value.observationId);
        const result = this.#transaction(() => {
            let now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const actual = this.#dagChildEvidence(scope, evidence);
            if (observationId !== this.#dagChildNotificationId(scope, evidence))
                reject('agent-loop-projection-input-invalid');
            const authorized = this.#dagAssertSynchronous(authorize);
            now = timestamp(this.#now());
            current = this.#dagCurrent(scope, now);
            const joined = current.envelope.children.find((value) => value.taskId === evidence.childTaskId)!;
            // Reject the merge attempt, not the valid child. Preserve the accepted
            // artifacts and allow an exact retry while retaining durable conflict evidence.
            const conflict = (): null => {
                this.#appendEvent(scope.taskId, current.revision, {
                    eventId: `child-merge-conflict:${hash({ taskId: scope.taskId, revision: current.revision,
                        observationId, artifact: actual.ref, maintenanceRefs }).slice(7)}`,
                    kind: 'dag-child-merge-conflict', reasonCode: 'child-artifact-conflict',
                }, current.envelopeDigest, now);
                return null;
            };
            if (
                authorized &&
                current.envelope.state === 'RUNNING' &&
                current.envelope.currentAttemptId === scope.attemptId &&
                joined.joinState === 'accepted' &&
                joined.outcomeRef === actual.ref.refId &&
                joined.evidenceRefs.includes(observationId) &&
                scope.expectedRevision <= current.revision
            ) {
                if (!matchesAcceptedMaintenanceRefs(current)) return conflict();
                return this.#dagSnapshot(scope.taskId);
            }
            if (!authorized || !this.#dagChildWaitCurrent(scope, evidence, now)) {
                this.#dagRejectedChild(current, observationId, now);
                return this.#dagSnapshot(scope.taskId);
            }
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const row = this.#db
                .prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?')
                .get(observationId) as SqlRow | undefined;
            if (
                !row ||
                row.task_id !== scope.taskId ||
                row.attempt_id !== scope.attemptId ||
                row.source_kind !== 'child-task' ||
                row.classification !== 'applied' ||
                row.completeness !== 'complete' ||
                row.satisfies_verification !== 1 ||
                Number(row.applied_revision) > current.revision
            )
                reject('agent-loop-projection-input-invalid');
            const observation = normalizeObservationStrict({
                contractVersion: 'agent-loop-observation-v1',
                observationId,
                taskId: scope.taskId,
                attemptId: scope.attemptId,
                observedForTaskRevision: Number(row.observed_for_revision),
                sourceKind: 'child-task',
                sourceRef: evidence.childTaskId,
                correlationRef: scope.waitId,
                observedAt: String(row.observed_at),
                ingestedAt: String(row.ingested_at),
                payloadDigest: actual.ref.expectedDigest,
                payloadRef: actual.ref.refId,
                completeness: 'complete',
                evidenceRefs: evidence.evidenceRefs,
            });
            if (agentLoopObservationDigest(observation) !== row.observation_digest)
                reject('agent-loop-projection-observation-conflict');
            const { wait: ignored, ...base } = current.envelope;
            void ignored;
            const artifact = actual.child.envelope.artifacts.find((value) => value.artifactRef === actual.ref.refId)!;
            const existingMaintenanceRef = this.#db.prepare(
                "SELECT 1 FROM agent_loop_artifact_ref WHERE task_id=? AND kind IN ('memory-fact','rolling-summary') LIMIT 1",
            ).get(scope.taskId);
            const hasAcceptedChild = current.envelope.children.some(child => child.joinState === 'accepted');
            if (
                current.envelope.artifacts.some((value) => value.artifactRef === actual.ref.refId) ||
                maintenanceRefs.some((ref) => ref.refId === actual.ref.refId) ||
                (hasAcceptedChild ? !matchesAcceptedMaintenanceRefs(current) : existingMaintenanceRef)
            )
                return conflict();
            const joinIdentity = `${scope.waitId}:${observationId}`;
            const joinEventId = `dag:${hash({
                taskId: scope.taskId,
                kind: 'dag-child-joined-woke',
                identity: joinIdentity,
            }).slice(7)}`;
            const next = this.#dagAdvance(
                current,
                {
                    ...base,
                    state: 'RUNNING',
                    phase: 'PREPARE',
                    children: current.envelope.children.map((value) =>
                        value.taskId === evidence.childTaskId
                            ? {
                                  ...value,
                                  joinState: 'accepted',
                                  outcomeRef: actual.ref.refId,
                                  evidenceRefs: [observationId, joinEventId, ...evidence.evidenceRefs],
                              }
                            : value,
                    ),
                    artifacts: [...current.envelope.artifacts, artifact],
                },
                'dag-child-joined-woke',
                joinIdentity,
                now,
            );
            const ref = actual.ref;
            this.#db
                .prepare(
                    `INSERT INTO agent_loop_artifact_ref (task_id,ref_id,kind,owner_ref,expected_digest,
                expected_revision,policy,acl_class,expand_budget_tokens,task_revision,registered_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                    scope.taskId,
                    ref.refId,
                    ref.kind,
                    ref.ownerRef,
                    ref.expectedDigest,
                    ref.expectedRevision ?? null,
                    ref.policy,
                    ref.aclClass,
                    ref.expandBudgetTokens,
                    next.revision,
                    now,
                );
            this.#appendEvent(
                scope.taskId,
                next.revision,
                {
                    eventId: `dag-ref-registered:${hash({ taskId: scope.taskId, refId: ref.refId }).slice(7)}`,
                    kind: 'ref-registered',
                    reasonCode: null,
                },
                next.envelopeDigest,
                now,
            );
            if (!hasAcceptedChild) for (const maintenanceRef of maintenanceRefs)
                this.#registerDagMaintenanceRefAt(next, maintenanceRef, now);
            return this.#dagSnapshot(scope.taskId);
        });
        // Throw after the audit transaction commits, without changing the projection.
        if (result === null) reject('agent-loop-projection-ref-conflict');
        return result;
    }

    /** The joined parent's original Core may compile Prepare once, not dispatch a Model or grant more budget. */
    commitDagParentPrepared(input: unknown, authorize: () => void): AgentLoopTaskRecord {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'envelope', 'event']);
        const taskId = token(value.taskId),
            ownerId = token(value.ownerId);
        const expected = dagBudgetInteger(value.expectedRevision, 1);
        const envelope = normalizeAgentLoopTaskEnvelope(value.envelope),
            event = this.#eventInput(value.event);
        if (typeof authorize !== 'function' || nodeTypes.isProxy(authorize))
            reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            let now = timestamp(this.#now());
            let current = this.#dagCurrent({ taskId, ownerId }, now);
            const snapshot = this.#dagSnapshot(taskId);
            if (!this.#dagAssertSynchronous(authorize)) reject('agent-loop-projection-input-invalid');
            now = timestamp(this.#now());
            current = this.#dagCurrent({ taskId, ownerId }, now);
            if (current.revision !== expected) reject('agent-loop-projection-revision-conflict');
            if (
                snapshot.state !== 'active' ||
                now >= snapshot.policy.deadlineAt ||
                snapshot.allocations.some(
                    (entry) => {
                        const child = this.#requireRecord(entry.allocation.childEnvelope.taskId);
                        const joined = current.envelope.children.find((value) => value.taskId === child.envelope.taskId);
                        return joined?.joinState === 'accepted' && (now >= entry.allocation.deadlineAt
                            || child.fenced || child.revision !== joined.taskRevision);
                    },
                ) ||
                current.envelope.state !== 'RUNNING' ||
                current.envelope.phase !== 'PREPARE' ||
                current.envelope.wait !== undefined ||
                !current.envelope.children.some((value) => value.joinState === 'accepted') ||
                current.envelope.children.some(
                    (value) => value.joinState !== 'accepted',
                ) ||
                envelope.taskId !== taskId ||
                envelope.revision !== expected + 1 ||
                envelope.phase !== 'MODEL' ||
                event.eventId !== `phase:${taskId}:${expected}:PREPARE-MODEL` ||
                event.kind !== 'phase-advanced' ||
                event.reasonCode !== null ||
                JSON.stringify(envelope) !==
                    JSON.stringify(
                        normalizeAgentLoopTaskEnvelope({
                            ...current.envelope,
                            phase: 'MODEL',
                            revision: expected + 1,
                            updatedAt: envelope.updatedAt,
                        }),
                    ) ||
                envelope.updatedAt < current.envelope.updatedAt ||
                envelope.updatedAt > now
            )
                reject('agent-loop-projection-input-invalid');
            const changed = this.#db
                .prepare(
                    `UPDATE agent_loop_task SET phase=?,revision=?,envelope_json=?,
                envelope_digest=?,updated_at=? WHERE task_id=? AND revision=? AND fenced=0`,
                )
                .run(
                    envelope.phase,
                    envelope.revision,
                    JSON.stringify(envelope),
                    hash(envelope),
                    envelope.updatedAt,
                    taskId,
                    expected,
                );
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
            this.#appendEvent(taskId, envelope.revision, event, hash(envelope), now);
            this.#dagSnapshot(taskId);
            return this.#requireRecord(taskId);
        });
    }

    /** Only a never-dispatched hold can be returned. Permanent child-count spent is not returned. */
    releaseDagChild(input: unknown): AgentLoopDagBudgetSnapshot {
        return this.#finishDagChild(input, false);
    }

    /** Settles real physical usage once, even after cancellation/deadline; no business completion/join. */
    settleDagChild(input: unknown): AgentLoopDagBudgetSnapshot {
        return this.#finishDagChild(input, true);
    }

    #finishDagChild(input: unknown, settle: boolean): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagScope(input, settle ? ['reservationId', 'usage', 'settlementRef'] : ['reservationId']);
        const reservationId = dagBudgetToken(scope.value.reservationId);
        const usage = settle ? normalizeAgentLoopDagBudget(scope.value.usage) : null;
        const settlementRef = settle ? dagBudgetToken(scope.value.settlementRef) : null;
        if (usage?.childTasks !== undefined && usage.childTasks !== 0) reject('agent-loop-projection-input-invalid');
        const settlementDigest = hash({ reservationId, usage, settlementRef });
        return this.#transaction(() => {
            const now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId);
            const entry = snapshot.allocations.find((item) => item.allocation.reservationId === reservationId);
            if (!entry) reject('agent-loop-projection-record-missing');
            if (settle && entry.status === 'settled') {
                if (
                    hash({ reservationId, usage: entry.usage, settlementRef: entry.settlementRef }) !== settlementDigest
                ) {
                    reject('agent-loop-projection-event-conflict');
                }
                return snapshot;
            }
            if (!settle && entry.status === 'released') return snapshot;
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            if (entry.status !== (settle ? 'dispatched' : 'reserved')) reject('agent-loop-projection-input-invalid');
            const child = this.#requireRecord(entry.allocation.childEnvelope.taskId),
                budget = current.envelope.budget;
            if (usage && AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => usage[key] < child.envelope.budget.spent[key])) {
                reject('agent-loop-projection-input-invalid');
            }
            if (settle)
                this.#db
                    .prepare(
                        `UPDATE agent_loop_child_budget SET status='settled',finished_at=?,
                usage_json=?,settlement_ref=?,settlement_digest=? WHERE reservation_id=? AND status='dispatched'`,
                    )
                    .run(now, JSON.stringify(usage), settlementRef, settlementDigest, reservationId);
            else
                this.#db
                    .prepare(
                        `UPDATE agent_loop_child_budget SET status='released',finished_at=?
                WHERE reservation_id=? AND status='reserved'`,
                    )
                    .run(now, reservationId);
            const childNext = this.#dagAdvance(
                child,
                {
                    ...child.envelope,
                    state: settle ? child.envelope.state : 'CANCELLED',
                    budget: { ...child.envelope.budget, spent: usage ?? child.envelope.budget.spent },
                },
                settle ? 'dag-child-usage-recorded' : 'dag-child-released',
                reservationId,
                now,
            );
            const overrun =
                usage && AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => usage[key] > child.envelope.budget.granted[key]);
            this.#dagAdvance(
                current,
                {
                    ...current.envelope,
                    budget: {
                        ...budget,
                        reserved: subtractAgentLoopDagBudget(budget.reserved, child.envelope.budget.granted),
                        spent: usage ? addAgentLoopDagBudget(budget.spent, usage) : budget.spent,
                    },
                    children: current.envelope.children.map((value) =>
                        value.taskId === child.envelope.taskId
                            ? { ...value, state: childNext.envelope.state, taskRevision: childNext.revision }
                            : value,
                    ),
                },
                settle ? 'dag-child-settled' : 'dag-child-hold-released',
                reservationId,
                now,
                overrun ? 'child-budget-overrun' : null,
            );
            return this.#dagSnapshot(scope.taskId);
        });
    }

    /** Cancellation never turns a dispatched unknown into a zero-cost refund or frees its physical slot. */
    cancelDagRoot(input: unknown): AgentLoopDagBudgetSnapshot {
        const scope = this.#dagScope(input);
        return this.#transaction(() => {
            const now = timestamp(this.#now()),
                current = this.#dagCurrent(scope, now);
            const snapshot = this.#dagSnapshot(scope.taskId);
            if (snapshot.state === 'cancelled') return snapshot;
            if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
            let reserved = current.envelope.budget.reserved;
            const children = current.envelope.children.map((value) => {
                const entry = snapshot.allocations.find(
                    (item) => item.allocation.childEnvelope.taskId === value.taskId,
                )!;
                const child = this.#requireRecord(value.taskId);
                if (entry.status === 'reserved') {
                    this.#db
                        .prepare(
                            `UPDATE agent_loop_child_budget SET status='released',finished_at=?
                        WHERE reservation_id=? AND status='reserved'`,
                        )
                        .run(now, entry.allocation.reservationId);
                    reserved = subtractAgentLoopDagBudget(reserved, child.envelope.budget.granted);
                }
                if (TERMINAL_STATES.has(child.envelope.state)) return value;
                const next = this.#dagAdvance(
                    child,
                    { ...child.envelope, state: 'CANCELLED' },
                    'dag-child-cancelled',
                    scope.taskId,
                    now,
                );
                return { ...value, state: next.envelope.state, taskRevision: next.revision };
            });
            this.#db
                .prepare(`UPDATE agent_loop_dag_policy SET state='cancelled' WHERE root_task_id=?`)
                .run(scope.taskId);
            const { wait: ignored, ...base } = current.envelope;
            void ignored;
            this.#dagAdvance(
                current,
                { ...base, state: 'CANCELLED', budget: { ...current.envelope.budget, reserved }, children },
                'dag-root-cancelled',
                scope.taskId,
                now,
            );
            return this.#dagSnapshot(scope.taskId);
        });
    }

    #actionRecord(row: SqlRow | undefined): AgentLoopActionReceiptRecord | null {
        if (!row) return null;
        try {
            const scope = actionInput({ taskId: row.task_id, attemptId: row.attempt_id,
                expectedRevision: row.task_revision, ownerId: row.owner_id, actionId: row.action_id }).scope;
            const actionContractRef = normalizeAgentLoopActionContractRef(row.action_contract_ref);
            const estimate = normalizeAgentLoopActionUsage(JSON.parse(String(row.estimate_json)), actionContractRef);
            if (JSON.stringify(estimate) !== row.estimate_json
                || !['reserved', 'started', 'completed', 'observed', 'released'].includes(String(row.status))) {
                reject('agent-loop-projection-storage-invalid');
            }
            const result = row.result_json === null ? undefined : normalizeAgentLoopActionResult(JSON.parse(String(row.result_json)), actionContractRef);
            if (result && JSON.stringify(result) !== row.result_json) reject('agent-loop-projection-storage-invalid');
            const optionalTime = (key: string) => row[key] === null ? undefined : timestamp(row[key]);
            const createdAt = timestamp(row.created_at), startedAt = optionalTime('started_at'), completedAt = optionalTime('completed_at');
            const settledAt = optionalTime('settled_at'), observedAt = optionalTime('observed_at'), releasedAt = optionalTime('released_at');
            const receiptRef = row.receipt_ref === null ? undefined : normalizeAgentLoopActionToken(row.receipt_ref);
            const observationId = row.observation_id === null ? undefined : normalizeAgentLoopActionToken(row.observation_id);
            const appliedRevision = row.applied_revision === null ? undefined : Number(row.applied_revision);
            if (appliedRevision !== undefined && (!Number.isSafeInteger(appliedRevision) || appliedRevision !== scope.expectedRevision + 1)
                || observationId !== undefined && observationId !== `obs:${scope.actionId}`) reject('agent-loop-projection-storage-invalid');
            const status = row.status as AgentLoopActionReceiptRecord['status'];
            const completed = status === 'completed' || status === 'observed';
            if ((status === 'reserved' || status === 'released') !== (startedAt === undefined)
                || completed !== (completedAt !== undefined && receiptRef !== undefined && result !== undefined)
                || !completed && (completedAt !== undefined || receiptRef !== undefined || result !== undefined || settledAt !== undefined)
                || (status === 'released') !== (releasedAt !== undefined)
                || (status === 'observed') !== (observationId !== undefined && appliedRevision !== undefined && observedAt !== undefined)
                || status !== 'observed' && (observationId !== undefined || appliedRevision !== undefined || observedAt !== undefined)
                || status === 'observed' && settledAt === undefined
                || startedAt !== undefined && startedAt < createdAt || completedAt !== undefined && completedAt < startedAt!
                || settledAt !== undefined && settledAt < completedAt! || observedAt !== undefined && observedAt < settledAt!
                || releasedAt !== undefined && releasedAt < createdAt) reject('agent-loop-projection-storage-invalid');
            const record: AgentLoopActionReceiptRecord = Object.freeze({ ...scope,
                actionDigest: normalizeAgentLoopActionDigest(row.action_digest), actionContractRef,
                estimate, status, createdAt, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
                ...(receiptRef ? { receiptRef } : {}), ...(result ? { result } : {}), ...(settledAt ? { settledAt } : {}),
                ...(observationId ? { observationId } : {}), ...(appliedRevision !== undefined ? { appliedRevision } : {}),
                ...(observedAt ? { observedAt } : {}), ...(releasedAt ? { releasedAt } : {}) });
            if (row.metadata_digest !== hash(record)) reject('agent-loop-projection-storage-invalid');
            return record;
        } catch { return reject('agent-loop-projection-storage-invalid'); }
    }

    #readAction(actionId: string): AgentLoopActionReceiptRecord | null {
        return this.#actionRecord(this.#db.prepare('SELECT * FROM agent_loop_action_receipt WHERE action_id=?').get(actionId) as SqlRow | undefined);
    }

    #activeActions(taskId: string): readonly AgentLoopActionReceiptRecord[] {
        return (this.#db.prepare("SELECT * FROM agent_loop_action_receipt WHERE task_id=? AND status IN ('reserved','started','completed')")
            .all(taskId) as SqlRow[]).map(row => this.#actionRecord(row)!);
    }

    #actionAuthority(scope: AgentLoopActionScope, now: string): AgentLoopTaskRecord {
        const current = this.#requireRecord(scope.taskId);
        this.#requireLease(current, scope.ownerId, now);
        if (!current.leaseExpiresAt || !Number.isFinite(Date.parse(current.leaseExpiresAt))
            || new Date(current.leaseExpiresAt).toISOString() !== current.leaseExpiresAt) reject('agent-loop-projection-lease-lost');
        if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
        if (current.envelope.phase !== 'ACT' || current.envelope.state !== 'RUNNING'
            || current.envelope.currentAttemptId !== scope.attemptId) reject('agent-loop-projection-input-invalid');
        const marker = this.#db.prepare('SELECT task_id,revision,kind,reason_code FROM agent_loop_task_event WHERE event_id=?')
            .get(`action-started:${scope.actionId}`) as SqlRow | undefined;
        if (!marker || marker.task_id !== scope.taskId || marker.revision !== scope.expectedRevision
            || marker.kind !== 'action-started' || marker.reason_code !== 'act') reject('agent-loop-projection-event-conflict');
        return current;
    }

    #sameActionScope(record: AgentLoopActionReceiptRecord, scope: AgentLoopActionScope): void {
        if (record.taskId !== scope.taskId || record.attemptId !== scope.attemptId || record.ownerId !== scope.ownerId
            || record.expectedRevision !== scope.expectedRevision || record.actionId !== scope.actionId) {
            reject('agent-loop-projection-event-conflict');
        }
    }

    #updateAction(record: AgentLoopActionReceiptRecord): void {
        const changes = this.#db.prepare(`UPDATE agent_loop_action_receipt SET status=?,started_at=?,completed_at=?,receipt_ref=?,
            result_json=?,settled_at=?,observation_id=?,applied_revision=?,observed_at=?,released_at=?,metadata_digest=? WHERE action_id=?`)
            .run(record.status, record.startedAt ?? null, record.completedAt ?? null, record.receiptRef ?? null,
                record.result ? JSON.stringify(record.result) : null, record.settledAt ?? null, record.observationId ?? null,
                record.appliedRevision ?? null, record.observedAt ?? null, record.releasedAt ?? null, hash(record), record.actionId);
        if (Number(changes.changes) !== 1) reject('agent-loop-projection-event-conflict');
        // Validate the whole stored state while rollback is still possible (including timestamp order/digest).
        if (!this.#readAction(record.actionId)) reject('agent-loop-projection-storage-invalid');
    }

    #actionEvent(record: AgentLoopActionReceiptRecord, stage: string, task: AgentLoopTaskRecord, now: string): void {
        this.#appendEvent(record.taskId, task.revision, {
            eventId: `action-receipt:${hash(record.actionId).slice(7)}:${stage}`,
            kind: `action-receipt-${stage}`, reasonCode: null,
        }, task.envelopeDigest, now);
    }

    #matchActionObservation(record: AgentLoopTaskRecord, observation: ReturnType<typeof normalizeObservationStrict>,
        action: AgentLoopActionReceiptRecord): void {
        const result = action.result;
        if (action.status !== 'completed' || !action.settledAt || !result || action.taskId !== record.envelope.taskId
            || action.attemptId !== record.envelope.currentAttemptId || action.ownerId !== record.ownerId
            || action.expectedRevision !== record.revision || record.envelope.phase !== 'ACT' || record.envelope.state !== 'RUNNING'
            || observation.observationId !== `obs:${action.actionId}` || observation.causalActionId !== action.actionId
            || observation.taskId !== action.taskId || observation.attemptId !== action.attemptId
            || observation.observedForTaskRevision !== action.expectedRevision || observation.sourceKind !== result.sourceKind
            || observation.sourceRef !== result.sourceRef || observation.payloadDigest !== result.payloadDigest
            || observation.completeness !== result.completeness || observation.payloadRef !== undefined
            || observation.correlationRef !== undefined || JSON.stringify(observation.evidenceRefs) !== JSON.stringify(result.evidenceRefs)
            || JSON.stringify(observation.usageDelta) !== JSON.stringify(result.usage)) reject('agent-loop-projection-observation-conflict');
    }

    #observationAction(observation: ReturnType<typeof normalizeObservationStrict>): AgentLoopActionReceiptRecord | null {
        const causal = observation.causalActionId ? this.#readAction(observation.causalActionId) : null;
        // The canonical ID is a durable binding too. An omitted/foreign causal ID cannot
        // poison it with a stale row before the genuine receipt can be accounted for.
        const canonical = observation.observationId.startsWith('obs:')
            ? this.#readAction(observation.observationId.slice(4)) : null;
        if (causal && canonical && causal.actionId !== canonical.actionId) reject('agent-loop-projection-observation-conflict');
        return causal ?? canonical;
    }

    #appendEvent(
        taskId: string,
        revision: number,
        event: { eventId: string; kind: string; reasonCode: string | null },
        envelopeDigest: string,
        now: string,
    ): { event: AgentLoopTaskEvent; replayed: boolean } {
        const existing = this.#db.prepare(
            'SELECT * FROM agent_loop_task_event WHERE event_id=?',
        ).get(event.eventId) as SqlRow | undefined;
        const digest = eventDigest({
            eventId: event.eventId,
            taskId,
            revision,
            kind: event.kind,
            reasonCode: event.reasonCode,
            envelopeDigest,
        });
        if (existing) {
            // 同 ID 同摘要 ⇒ 幂等重放；同 ID 不同摘要 ⇒ 拒绝（绝不覆盖已成事实）。
            if (String(existing.event_digest) !== digest) {
                reject('agent-loop-projection-event-conflict');
            }
            return {
                event: Object.freeze({
                    eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION,
                    eventId: event.eventId,
                    taskId: String(existing.task_id),
                    revision: Number(existing.revision),
                    kind: String(existing.kind),
                    ...(existing.reason_code === null
                        ? {} : { reasonCode: String(existing.reason_code) }),
                    eventDigest: digest,
                    acceptedAt: String(existing.accepted_at),
                }),
                replayed: true,
            };
        }
        const acceptedAt = now;
        this.#db.prepare(`INSERT INTO agent_loop_task_event
            (event_id,task_id,revision,kind,reason_code,event_digest,accepted_at)
            VALUES(?,?,?,?,?,?,?)`)
            .run(event.eventId, taskId, revision, event.kind, event.reasonCode, digest, acceptedAt);
        this.#db.prepare(`INSERT INTO agent_loop_outbox
            (task_id,revision,event_id,event_digest,created_at) VALUES(?,?,?,?,?)`)
            .run(taskId, revision, event.eventId, digest, acceptedAt);
        return {
            event: Object.freeze({
                eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION,
                eventId: event.eventId,
                taskId,
                revision,
                kind: event.kind,
                ...(event.reasonCode === null ? {} : { reasonCode: event.reasonCode }),
                eventDigest: digest,
                acceptedAt,
            }),
            replayed: false,
        };
    }

    /** 建任务：Envelope 必须是 revision=1 的初始投影，且 taskId 未被占用。 */
    create(input: unknown): AgentLoopTaskRecord {
        const value = exact(input, ['envelope', 'ownerId', 'leaseMs', 'event']);
        const envelope = normalizeAgentLoopTaskEnvelope(value.envelope);
        if (envelope.revision !== 1) reject('agent-loop-projection-input-invalid');
        const ownerId = token(value.ownerId);
        if (!Number.isSafeInteger(value.leaseMs) || Number(value.leaseMs) < 1 || Number(value.leaseMs) > 86_400_000)
            reject('agent-loop-projection-input-invalid');
        const event = this.#eventInput(value.event);
        try {
            const turnPolicy = assertAgentLoopTurnCompletionBirthBinding({ envelope, birthEvent: event });
            if (turnPolicy && (envelope.state === 'VERIFYING' || envelope.state === 'COMPLETED')) throw new Error();
        } catch {
            return reject('agent-loop-projection-input-invalid');
        }
        const now = timestamp(this.#now());
        const leaseExpiresAt = new Date(Date.parse(now) + Number(value.leaseMs)).toISOString();
        return this.#transaction(() => {
            if (
                this.#dagBound(envelope.rootTaskId) ||
                (envelope.parentTaskId !== undefined && this.#dagBound(envelope.parentTaskId))
            ) {
                reject('agent-loop-projection-input-invalid');
            }
            const existing = this.#row(envelope.taskId);
            if (existing) {
                if (Number(existing.fenced) === 1) reject('agent-loop-projection-fenced');
                reject('agent-loop-projection-record-exists');
            }
            const envelopeDigest = hash(envelope);
            this.#db
                .prepare(
                    `INSERT INTO agent_loop_task
                (task_id,root_task_id,state,phase,revision,envelope_json,envelope_digest,
                 owner_id,lease_expires_at,fenced,fence_reason,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,0,NULL,?,?)`,
                )
                .run(
                    envelope.taskId,
                    envelope.rootTaskId,
                    envelope.state,
                    envelope.phase,
                    envelope.revision,
                    JSON.stringify(envelope),
                    envelopeDigest,
                    ownerId,
                    leaseExpiresAt,
                    now,
                    now,
                );
            this.#appendEvent(envelope.taskId, envelope.revision, event, envelopeDigest, now);
            return this.#requireRecord(envelope.taskId);
        });
    }

    #eventInput(input: unknown): { eventId: string; kind: string; reasonCode: string | null } {
        const value = exact(input, ['eventId', 'kind'], ['reasonCode']);
        const reasonCode = value.reasonCode === undefined
            ? null : token(value.reasonCode);
        const eventId = token(value.eventId), kind = token(value.kind);
        if (['verify-repairable', 'repair-policy-bound', 'task-failed-repair', 'model-protocol-rejected', SUMMARY_VALIDATION_EVENT,
            'model-correction-policy-bound', 'model-correction-ready', 'model-correction-prepared', 'model-decision-bound'].includes(kind)
            || eventId.startsWith('repair-policy:') || eventId.startsWith('repair-failed:')
            || kind.startsWith('model-summary-validation-rejected-') || eventId.startsWith('summary-validation-')
            || eventId.startsWith('model-rejection:') || eventId.startsWith('model-decision:')
            || eventId.startsWith('model-correction-policy:') || eventId.startsWith('model-correction-ready:')
            || eventId.startsWith('model-correction-prepare:')
            || eventId.endsWith(':VERIFY-PREPARE')) reject('agent-loop-projection-input-invalid');
        return { eventId, kind, reasonCode };
    }

    /**
     * 乐观提交：`expectedRevision` 必须等于当前 revision，`envelope.revision`
     * 必须是 `expectedRevision + 1`。事件与该次前进同事务落盘。
     * 可选 providerObservation 仅把完整 Provider 用量与本次阶段提交原子结合；
     * 预算仍由既有纯 Reducer 唯一计算。任何拒绝整体回滚（不写 quarantine），
     * 与 standalone ingestObservation 的冲突隔离/迟到审计语义明确分开。
     */
    commit(input: unknown): AgentLoopTaskRecord {
        return this.#commit(input);
    }

    #commit(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): AgentLoopTaskRecord {
        const value = exact(
            input,
            ['taskId', 'expectedRevision', 'ownerId', 'envelope', 'event'],
            ['providerObservation', 'requirePristinePrepare', 'artifactRefs', 'modelCorrectionPolicy', 'modelOutcome'],
        );
        if (value.requirePristinePrepare !== undefined && typeof value.requirePristinePrepare !== 'boolean') {
            reject('agent-loop-projection-input-invalid');
        }
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        const envelope = normalizeAgentLoopTaskEnvelope(value.envelope);
        if (envelope.taskId !== taskId || envelope.revision !== expected + 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const event = this.#eventInput(value.event);
        const artifactRefs: AgentLoopArtifactRefDescriptor[] = [];
        if (Object.hasOwn(value, 'artifactRefs')) {
            const property = Object.getOwnPropertyDescriptor(value, 'artifactRefs');
            if (
                !property ||
                !Object.hasOwn(property, 'value') ||
                !property.enumerable ||
                !Array.isArray(property.value) ||
                property.value.length > MAX_LIMIT ||
                Reflect.ownKeys(property.value).length !== property.value.length + 1
            )
                reject('agent-loop-projection-input-invalid');
            for (let index = 0; index < property.value.length; index++) {
                const item = Object.getOwnPropertyDescriptor(property.value, String(index));
                if (!item || !Object.hasOwn(item, 'value') || !item.enumerable)
                    reject('agent-loop-projection-input-invalid');
                const descriptor = normalizeAgentLoopArtifactRefDescriptor(item.value);
                if (
                    artifactRefs.some((existing) => existing.refId === descriptor.refId) ||
                    envelope.artifacts.filter((artifact) => artifact.artifactRef === descriptor.refId).length !== 1
                )
                    reject('agent-loop-projection-input-invalid');
                artifactRefs.push(descriptor);
            }
        }
        const hasProviderObservation = Object.hasOwn(value, 'providerObservation');
        const providerObservation = () => {
            let observation: ReturnType<typeof normalizeObservationStrict>;
            try {
                observation = normalizeObservationStrict(value.providerObservation);
            } catch {
                return reject('agent-loop-projection-input-invalid');
            }
            if (
                observation.sourceKind !== 'provider' ||
                observation.taskId !== taskId ||
                envelope.currentAttemptId === undefined ||
                observation.attemptId !== envelope.currentAttemptId ||
                observation.observedForTaskRevision !== expected ||
                observation.completeness !== 'complete' ||
                observation.usageDelta === undefined ||
                event.eventId === `observation:${observation.observationId}`
            )
                reject('agent-loop-projection-input-invalid');
            return observation;
        };
        return this.#transaction(
            () => {
                const now = timestamp(this.#now());
                const current = this.#requireRecord(taskId);
                this.#requireLease(current, ownerId, now);
                this.#turnCompletionPolicy(current.envelope);
                const turnPolicy = this.#turnCompletionPolicy(envelope);
                if (turnPolicy && (envelope.state === 'VERIFYING' || envelope.state === 'COMPLETED'))
                    reject('agent-loop-projection-input-invalid');
                // Generic phase writes never obtain a DAG capability; only the
                // Runtime-captured private transaction can advance its exact child.
                if (this.#dagBound(taskId) && !dagExecution) reject('agent-loop-projection-input-invalid');
                if (dagExecution) {
                    if (
                        taskId !== dagExecution.childTaskId ||
                        ownerId !== dagExecution.childOwnerId ||
                        envelope.currentAttemptId !== dagExecution.childAttemptId ||
                        !['RUNNING', 'FAILED', 'CANCELLED'].includes(envelope.state) ||
                        (current.envelope.state !== 'CREATED' &&
                            envelope.currentAttemptId !== current.envelope.currentAttemptId) ||
                        (!hasProviderObservation &&
                            JSON.stringify(envelope.budget) !== JSON.stringify(current.envelope.budget))
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                    try {
                        if (current.envelope.phase !== envelope.phase)
                            assertAgentLoopPhaseTransition(current.envelope.phase, envelope.phase);
                    } catch {
                        return reject('agent-loop-projection-input-invalid');
                    }
                    if (current.envelope.phase === 'MODEL') {
                        const model = readAgentLoopModelOutcome(value.modelOutcome);
                        if (
                            !hasProviderObservation ||
                            !model ||
                            model.observation !== value.providerObservation ||
                            !model.decision ||
                            model.protocolRejectionReason !== undefined
                        )
                            reject('agent-loop-projection-input-invalid');
                        const decision = actionValue(normalizeAgentLoopDecision, model.decision),
                            observation = providerObservation();
                        const invocationId = agentLoopModelInvocationId({
                            taskId,
                            attemptId: dagExecution.childAttemptId,
                            expectedTaskRevision: expected,
                        });
                        const reservedId = `model-invocation:${invocationId}`;
                        const reserved = this.#db
                            .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                            .get(reservedId) as SqlRow | undefined;
                        if (
                            decision.taskId !== taskId ||
                            decision.attemptId !== dagExecution.childAttemptId ||
                            decision.expectedTaskRevision !== expected ||
                            decision.taskContractRef !== current.envelope.taskContractRef ||
                            (decision.kind !== 'request_complete' &&
                                (decision.kind !== 'act' ||
                                    decision.actionContractRef !== 'action.rp.read-character.v1')) ||
                            envelope.phase !== 'ACT' ||
                            event.reasonCode !== decision.kind ||
                            event.kind !== 'phase-advanced' ||
                            event.eventId !== `phase:${taskId}:${expected}:MODEL-ACT` ||
                            observation.observationId !== `model-usage:${invocationId}` ||
                            observation.correlationRef !== reservedId ||
                            observation.usageDelta?.modelCalls !== 1 ||
                            observation.usageDelta.toolCalls !== 0 ||
                            observation.usageDelta.writes !== 0 ||
                            observation.usageDelta.highRiskActions !== 0 ||
                            observation.usageDelta.inputTokens <= 0 ||
                            observation.usageDelta.outputTokens <= 0 ||
                            !reserved ||
                            reserved.task_id !== taskId ||
                            reserved.revision !== expected ||
                            reserved.kind !== 'model-invocation-reserved' ||
                            reserved.reason_code !== null ||
                            reserved.event_digest !==
                                eventDigest({
                                    eventId: reservedId,
                                    taskId,
                                    revision: expected,
                                    kind: 'model-invocation-reserved',
                                    reasonCode: null,
                                    envelopeDigest: current.envelopeDigest,
                                })
                        ) {
                            reject('agent-loop-projection-input-invalid');
                        }
                    } else if (hasProviderObservation || Object.hasOwn(value, 'modelOutcome'))
                        reject('agent-loop-projection-input-invalid');
                }
                let modelDecisionBinding: { eventId: string; kind: string; reasonCode: string } | undefined;
                if (this.#usesModelCorrection(current)) {
                    const policy = this.#boundModelCorrectionPolicy(current, this.#ownCorrectionPolicy(value));
                    if (now >= policy.deadlineAt || current.envelope.updatedAt > now)
                        reject('agent-loop-projection-input-invalid');
                    this.#assertCorrectionFrame(policy, {
                        ...current,
                        envelope,
                        revision: envelope.revision,
                        envelopeDigest: hash(envelope),
                    });
                    if (current.envelope.phase === 'MODEL') {
                        const property = Object.getOwnPropertyDescriptor(value, 'modelOutcome');
                        if (!hasProviderObservation || !property?.enumerable || !Object.hasOwn(property, 'value'))
                            reject('agent-loop-projection-input-invalid');
                        const model = readAgentLoopModelOutcome(property.value);
                        if (
                            !model ||
                            model.observation !== value.providerObservation ||
                            model.decision === null ||
                            model.protocolRejectionReason !== undefined
                        )
                            reject('agent-loop-projection-input-invalid');
                        let decision: ReturnType<typeof normalizeAgentLoopDecision>;
                        try {
                            decision = normalizeAgentLoopDecision(model.decision);
                        } catch {
                            return reject('agent-loop-projection-input-invalid');
                        }
                        if (
                            decision.taskId !== taskId ||
                            decision.attemptId !== policy.attemptId ||
                            decision.expectedTaskRevision !== expected ||
                            decision.taskContractRef !== current.envelope.taskContractRef ||
                            event.reasonCode !== decision.kind
                        )
                            reject('agent-loop-projection-input-invalid');
                        const waiting = decision.kind === 'ask_user' || decision.kind === 'wait_event';
                        if (
                            waiting
                                ? envelope.phase !== 'MODEL' ||
                                  envelope.state !==
                                      (decision.kind === 'ask_user' ? 'WAITING_INPUT' : 'WAITING_EVENT') ||
                                  event.kind !== 'wait-entered' ||
                                  event.eventId !== `wait:${taskId}:${expected}`
                                : envelope.phase !== 'ACT' ||
                                  event.kind !== 'phase-advanced' ||
                                  event.eventId !== `phase:${taskId}:${expected}:MODEL-ACT`
                        )
                            reject('agent-loop-projection-input-invalid');
                        const observation = providerObservation(),
                            usage = observation.usageDelta;
                        const invocationId = agentLoopModelInvocationId({
                            taskId,
                            attemptId: policy.attemptId,
                            expectedTaskRevision: expected,
                        });
                        if (
                            !usage ||
                            usage.modelCalls !== 1 ||
                            usage.toolCalls !== 0 ||
                            usage.writes !== 0 ||
                            usage.highRiskActions !== 0 ||
                            usage.inputTokens <= 0 ||
                            usage.outputTokens <= 0 ||
                            observation.observationId !== `model-usage:${invocationId}` ||
                            observation.correlationRef !== `model-invocation:${invocationId}`
                        )
                            reject('agent-loop-projection-input-invalid');
                        this.#assertCorrectionReservation(current, policy, invocationId);
                        const grant = current.envelope.budget.granted;
                        if (
                            policy.initialRevision === 2 &&
                            grant.modelCalls === 2 &&
                            grant.toolCalls === 1 &&
                            grant.writes === 1 &&
                            grant.highRiskActions === 0 &&
                            grant.childTasks === 0 &&
                            decision.kind === 'act' &&
                            decision.actionContractRef === 'action.maintenance.propose_rolling_summary.v1'
                        ) {
                            const decisionDigest = hash(decision);
                            modelDecisionBinding = {
                                eventId: `model-decision:${invocationId.slice(7)}:${decisionDigest.slice(7)}`,
                                kind: 'model-decision-bound',
                                reasonCode: 'act',
                            };
                        }
                    } else if (hasProviderObservation || Object.hasOwn(value, 'modelOutcome'))
                        reject('agent-loop-projection-input-invalid');
                    if (
                        !hasProviderObservation &&
                        JSON.stringify(envelope.budget) !== JSON.stringify(current.envelope.budget)
                    )
                        reject('agent-loop-projection-input-invalid');
                } else if (
                    !dagExecution &&
                    (envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF ||
                        Object.hasOwn(value, 'modelCorrectionPolicy') ||
                        Object.hasOwn(value, 'modelOutcome'))
                )
                    reject('agent-loop-projection-input-invalid');
                const seen = this.#db
                    .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                    .get(event.eventId) as SqlRow | undefined;
                if (seen) {
                    const digest = eventDigest({
                        eventId: event.eventId,
                        taskId,
                        revision: expected + 1,
                        kind: event.kind,
                        reasonCode: event.reasonCode,
                        envelopeDigest: hash(envelope),
                    });
                    if (String(seen.event_digest) !== digest) {
                        reject('agent-loop-projection-event-conflict');
                    }
                    if (hasProviderObservation) {
                        const observation = providerObservation();
                        const stored = this.#db
                            .prepare(
                                `SELECT observation_digest,classification,applied_revision
                        FROM agent_loop_observation WHERE observation_id=?`,
                            )
                            .get(observation.observationId) as SqlRow | undefined;
                        if (
                            !stored ||
                            String(stored.observation_digest) !== agentLoopObservationDigest(observation) ||
                            stored.classification !== 'applied' ||
                            Number(stored.applied_revision) !== expected + 1
                        ) {
                            reject('agent-loop-projection-event-conflict');
                        }
                    }
                    // A replay may validate only descriptors already written by the
                    // original CAS. Never backfill a missing ref under an old event.
                    for (const ref of artifactRefs)
                        this.#registerRefAt(
                            { ...current, envelope, envelopeDigest: hash(envelope), revision: envelope.revision },
                            ref,
                            now,
                            true,
                        );
                    // 同 ID 同摘要：这次提交已经发生过，按幂等返回当前记录（不二次推进）。
                    return current;
                }
                if (current.revision !== expected) {
                    reject('agent-loop-projection-revision-conflict');
                }
                if (!dagExecution && (current.envelope.state === 'PAUSED'
                    || current.envelope.state.startsWith('WAITING_') && current.envelope.wait?.kind !== 'child')
                    && envelope.state !== 'CANCELLED')
                    reject('agent-loop-projection-input-invalid');
                if (current.envelope.phase === 'VERIFY' && envelope.phase === 'PREPARE')
                    reject('agent-loop-projection-input-invalid');
                if (
                    Object.hasOwn(value, 'artifactRefs') &&
                    envelope.artifacts.some(
                        (artifact) =>
                            !current.envelope.artifacts.some(
                                (previous) => previous.artifactRef === artifact.artifactRef,
                            ) && !artifactRefs.some((ref) => ref.refId === artifact.artifactRef),
                    )
                )
                    reject('agent-loop-projection-input-invalid');
                // A sidecar hold is not reflected in Envelope.reserved. Do not let an ordinary
                // phase/budget commit escape it and mint fresh MODEL authority. Fence has its own path.
                if (this.#activeActions(taskId).length > 0) reject('agent-loop-projection-input-invalid');
                if (value.requirePristinePrepare === true && !dagExecution) {
                    // Initial execution grants must not race same-revision annotation/ref writes.
                    // This is a CAS precondition, not authority to grant a budget.
                    const task = current.envelope;
                    const events = this.#db
                        .prepare('SELECT kind FROM agent_loop_task_event WHERE task_id=?')
                        .all(taskId);
                    if (
                        hasProviderObservation ||
                        current.revision !== 1 ||
                        task.state !== 'CREATED' ||
                        task.phase !== 'PREPARE' ||
                        task.currentAttemptId !== undefined ||
                        task.plan !== undefined ||
                        task.wait !== undefined ||
                        task.completion !== undefined ||
                        task.rootTaskId !== task.taskId ||
                        task.parentTaskId !== undefined ||
                        task.dependencyTaskIds.length !== 0 ||
                        task.todos.length !== 0 ||
                        task.confirmedFacts.length !== 0 ||
                        task.blockers.length !== 0 ||
                        task.children.length !== 0 ||
                        task.artifacts.length !== 0 ||
                        [task.budget.granted, task.budget.reserved, task.budget.spent].some((vector) =>
                            Object.values(vector).some((n) => n !== 0),
                        ) ||
                        events.length !== 1 ||
                        events[0]?.kind !== 'task-created' ||
                        this.#db.prepare('SELECT 1 FROM agent_loop_artifact_ref WHERE task_id=? LIMIT 1').get(taskId) ||
                        this.#db.prepare('SELECT 1 FROM agent_loop_observation WHERE task_id=? LIMIT 1').get(taskId)
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                }
                let applied:
                    | {
                          observation: ReturnType<typeof normalizeObservationStrict>;
                          reduction: ReturnType<typeof reduceAgentLoopObservation>;
                      }
                    | undefined;
                if (hasProviderObservation) {
                    const observation = providerObservation();
                    if (observation.attemptId !== current.envelope.currentAttemptId)
                        reject('agent-loop-projection-input-invalid');
                    const stored = this.#db
                        .prepare('SELECT observation_digest FROM agent_loop_observation WHERE observation_id=?')
                        .get(observation.observationId) as SqlRow | undefined;
                    const reduction = reduceAgentLoopObservation({
                        envelope: current.envelope,
                        observation,
                        storedDigest: stored ? String(stored.observation_digest) : null,
                    });
                    if (reduction.classification !== 'applied' || !reduction.envelope) {
                        reject('agent-loop-projection-observation-conflict');
                    }
                    if (
                        reduction.reasonCodes.includes('observation-budget-overrun') ||
                        JSON.stringify(envelope.budget) !== JSON.stringify(reduction.envelope.budget)
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                    applied = { observation, reduction };
                }
                const envelopeDigest = hash(envelope);
                const changed = this.#db
                    .prepare(
                        `UPDATE agent_loop_task
                SET state=?, phase=?, revision=?, envelope_json=?, envelope_digest=?,
                    updated_at=?
                WHERE task_id=? AND revision=? AND fenced=0`,
                    )
                    .run(
                        envelope.state,
                        envelope.phase,
                        envelope.revision,
                        JSON.stringify(envelope),
                        envelopeDigest,
                        now,
                        taskId,
                        expected,
                    );
                if (Number(changed.changes) !== 1) {
                    reject('agent-loop-projection-revision-conflict');
                }
                if (applied) {
                    this.#insertObservation(applied.observation, 'applied', applied.reduction, envelope.revision, now);
                    this.#appendEvent(
                        taskId,
                        envelope.revision,
                        {
                            eventId: `observation:${applied.observation.observationId}`,
                            kind: 'observation-applied',
                            reasonCode: applied.reduction.reasonCodes[0] ?? null,
                        },
                        envelopeDigest,
                        now,
                    );
                }
                const updated = this.#requireRecord(taskId);
                for (const ref of artifactRefs) this.#registerRefAt(updated, ref, now);
                this.#appendEvent(taskId, envelope.revision, event, envelopeDigest, now);
                if (modelDecisionBinding)
                    this.#appendEvent(taskId, envelope.revision, modelDecisionBinding, envelopeDigest, now);
                if (!dagExecution && envelope.state.startsWith('WAITING_') && envelope.wait?.kind !== 'child')
                    this.#db.prepare('UPDATE agent_loop_task SET owner_id=NULL,lease_expires_at=NULL WHERE task_id=?').run(taskId);
                return this.#requireRecord(taskId);
            },
            true,
            dagExecution,
        );
    }

    #assertSuspensionIdle(record: AgentLoopTaskRecord): void {
        const calls = this.#db.prepare("SELECT COUNT(*) AS n FROM agent_loop_task_event WHERE task_id=? AND kind='model-invocation-reserved'")
            .get(record.envelope.taskId) as SqlRow;
        const pendingAction = this.#db.prepare(`SELECT 1 FROM agent_loop_task_event started
            WHERE started.task_id=? AND started.kind='action-started' AND NOT EXISTS
            (SELECT 1 FROM agent_loop_task_event finished WHERE finished.task_id=started.task_id
             AND finished.event_id='action-completed:' || substr(started.event_id,16) AND finished.kind='action-completed') LIMIT 1`)
            .get(record.envelope.taskId);
        if (pendingAction || this.#activeActions(record.envelope.taskId).length || Number(calls.n) > record.envelope.budget.spent.modelCalls
            || Object.values(record.envelope.budget.reserved).some(amount => amount !== 0))
            reject('agent-loop-projection-input-invalid');
    }

    #writeSuspension(current: AgentLoopTaskRecord, envelope: AgentLoopTaskEnvelopeV1,
        event: { eventId: string; kind: string; reasonCode: string | null }, now: string,
        lease: { ownerId: string; leaseMs: number } | null): AgentLoopTaskRecord {
        if (!(AGENT_LOOP_ALLOWED_TRANSITIONS[current.envelope.state] as readonly string[]).includes(envelope.state)
            || envelope.phase !== current.envelope.phase) reject('agent-loop-projection-input-invalid');
        const digest = hash(envelope);
        const changed = this.#db.prepare(`UPDATE agent_loop_task SET state=?,phase=?,revision=?,envelope_json=?,
            envelope_digest=?,updated_at=?,owner_id=?,lease_expires_at=? WHERE task_id=? AND revision=? AND fenced=0`)
            .run(envelope.state, envelope.phase, envelope.revision, JSON.stringify(envelope), digest, now,
                lease?.ownerId ?? null, lease ? new Date(Date.parse(now) + lease.leaseMs).toISOString() : null,
                envelope.taskId, current.revision);
        if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
        this.#appendEvent(envelope.taskId, envelope.revision, event, digest, now);
        return this.#requireRecord(envelope.taskId);
    }

    /** Persist a host-owned wait or explicit pause and relinquish the computation lease atomically. */
    suspendTask(input: AgentLoopTaskSuspendRequest, authorize: (record: AgentLoopTaskRecord) => void): AgentLoopTaskRecord {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = normalizeAgentLoopActionObject(input, ['taskId', 'expectedRevision', 'ownerId', 'attemptId'], ['wait', 'pauseId']);
        const taskId = token(value.taskId), ownerId = token(value.ownerId), attemptId = token(value.attemptId);
        const expected = dagBudgetInteger(value.expectedRevision, 1);
        if (Object.hasOwn(value, 'wait') === Object.hasOwn(value, 'pauseId') || typeof authorize !== 'function' || nodeTypes.isProxy(authorize))
            reject('agent-loop-projection-input-invalid');
        const pauseId = Object.hasOwn(value, 'pauseId') ? token(value.pauseId) : undefined;
        return this.#transaction(() => {
            let now = timestamp(this.#now());
            const current = this.#requireRecord(taskId);
            if (this.#dagBound(taskId) || current.fenced) reject('agent-loop-projection-input-invalid');
            if (!this.#dagAssertSynchronous(() => authorize(current))) reject('agent-loop-projection-input-invalid');
            now = timestamp(this.#now());
            this.#requireLease(current, ownerId, now);
            if (current.revision !== expected) reject('agent-loop-projection-revision-conflict');
            if (current.envelope.currentAttemptId !== attemptId || current.envelope.state !== 'RUNNING'
                || !['PREPARE', 'MODEL', 'OBSERVE', 'VERIFY'].includes(current.envelope.phase))
                reject('agent-loop-projection-input-invalid');
            this.#assertSuspensionIdle(current);
            if (nodeTypes.isProxy(value.wait)) reject('agent-loop-projection-input-invalid');
            const raw = pauseId === undefined ? normalizeAgentLoopActionObject(value.wait, ['waitId', 'kind', 'correlationRef',
                'expectedObservationContractRef', 'resumePredicateRef', 'since'], ['deadlineAt']) : null;
            if (raw && (!['input', 'approval', 'event', 'verification'].includes(String(raw.kind))
                || timestamp(raw.since) > now || timestamp(raw.since) < current.envelope.updatedAt
                || raw.deadlineAt !== undefined && timestamp(raw.deadlineAt) <= now))
                reject('agent-loop-projection-input-invalid');
            const state = pauseId ? 'PAUSED' : raw!.kind === 'input' ? 'WAITING_INPUT'
                : raw!.kind === 'approval' ? 'WAITING_APPROVAL' : 'WAITING_EVENT';
            const envelope = normalizeAgentLoopTaskEnvelope({ ...current.envelope, state,
                wait: raw ?? undefined, revision: current.revision + 1, updatedAt: now });
            const suspensionId = pauseId ?? envelope.wait!.waitId;
            return this.#writeSuspension(current, envelope, {
                eventId: `task-suspended:${hash({ taskId, attemptId, suspensionId, revision: envelope.revision }).slice(7)}`,
                kind: pauseId ? 'task-paused' : 'wait-entered', reasonCode: null,
            }, now, null);
        });
    }

    /** Exact source readback, observation, wake and lease claim are one transaction. No execution or completion. */
    resumeTask(input: AgentLoopTaskResumeRequest, authorize: (record: AgentLoopTaskRecord) => void,
        readEvidence: (record: AgentLoopTaskRecord) => AgentLoopTaskResumeEvidence | null): AgentLoopTaskResumeResult {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = normalizeAgentLoopActionObject(input, ['taskId', 'expectedRevision', 'ownerId', 'attemptId', 'suspensionId', 'eventRef', 'leaseMs']);
        const taskId = token(value.taskId), ownerId = token(value.ownerId), attemptId = token(value.attemptId),
            suspensionId = token(value.suspensionId), eventRef = token(value.eventRef);
        const expected = dagBudgetInteger(value.expectedRevision, 1), leaseMs = dagBudgetInteger(value.leaseMs, 1);
        if (leaseMs > 86_400_000 || [authorize, readEvidence].some(fn => typeof fn !== 'function' || nodeTypes.isProxy(fn)))
            reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            let now = timestamp(this.#now());
            const current = this.#requireRecord(taskId);
            const result = (status: AgentLoopTaskResumeResult['status'], record = current) => Object.freeze({ status, record });
            if (this.#dagBound(taskId) || current.fenced) reject('agent-loop-projection-input-invalid');
            if (!this.#dagAssertSynchronous(() => authorize(current))) reject('agent-loop-projection-input-invalid');
            now = timestamp(this.#now());
            if (TERMINAL_STATES.has(current.envelope.state) || current.envelope.currentAttemptId !== attemptId) return result('stale');
            const identity = hash({ taskId, attemptId, suspensionId, revision: expected, eventRef });
            const eventId = `task-resumed:${identity.slice(7)}`;
            const replay = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?').get(eventId) as SqlRow | undefined;
            const wait = current.envelope.wait, paused = current.envelope.state === 'PAUSED';
            if (!replay && (current.revision !== expected || (!paused && (!current.envelope.state.startsWith('WAITING_')
                || !wait || wait.waitId !== suspensionId || wait.kind === 'child')))) return result('stale');
            if (!replay && paused && !this.#db.prepare("SELECT 1 FROM agent_loop_task_event WHERE event_id=? AND kind='task-paused'")
                .get(`task-suspended:${hash({ taskId, attemptId, suspensionId, revision: expected }).slice(7)}`)) return result('stale');
            const evidence: unknown = readEvidence(current);
            if (nodeTypes.isPromise(evidence)) {
                void Promise.prototype.then.call(evidence, undefined, () => undefined);
                reject('agent-loop-projection-input-invalid');
            }
            if (evidence === null) return result('inconclusive');
            if (nodeTypes.isProxy(evidence)) reject('agent-loop-projection-input-invalid');
            const proof = normalizeAgentLoopActionObject(evidence, ['observation', 'contractRef', 'predicateRef', 'satisfied']);
            if (typeof proof.satisfied !== 'boolean') reject('agent-loop-projection-input-invalid');
            const observation = normalizeObservationStrict(proof.observation);
            if (observation.taskId !== taskId || observation.attemptId !== attemptId || observation.observationId !== eventRef
                || observation.observedForTaskRevision !== expected || observation.usageDelta !== undefined
                || (observation.sourceKind === 'tool' ? observation.causalActionId !== observation.correlationRef
                    : observation.causalActionId !== undefined)) reject('agent-loop-projection-input-invalid');
            const contractRef = token(proof.contractRef), predicateRef = token(proof.predicateRef);
            const digest = agentLoopObservationDigest(observation);
            const proofId = `resume-proof:${hash({ identity, digest, contractRef, predicateRef }).slice(7)}`;
            const seen = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?').get(eventRef) as SqlRow | undefined;
            if (seen && (seen.observation_digest !== digest || seen.task_id !== taskId)) reject('agent-loop-projection-observation-conflict');
            if (!this.#dagAssertSynchronous(() => authorize(current))) reject('agent-loop-projection-input-invalid');
            if (replay) {
                if (!seen || seen.classification !== 'applied' || Number(seen.applied_revision) !== Number(replay.revision)
                    || !this.#db.prepare('SELECT 1 FROM agent_loop_task_event WHERE event_id=? AND task_id=? AND revision=?')
                        .get(proofId, taskId, replay.revision)) reject('agent-loop-projection-event-conflict');
                return result('already-resumed');
            }
            const sources = paused || wait!.kind === 'input' ? ['user'] : wait!.kind === 'approval' ? ['approval']
                : wait!.kind === 'verification' ? ['verifier'] : ['tool', 'external-event', 'environment', 'timer', 'domain-readback'];
            if (contractRef !== (paused ? 'observation.resume.v1' : wait!.expectedObservationContractRef)
                || predicateRef !== (paused ? 'resume.explicit.v1' : wait!.resumePredicateRef)
                || observation.correlationRef !== (paused ? suspensionId : wait!.correlationRef)
                || !sources.includes(observation.sourceKind)) reject('agent-loop-projection-input-invalid');
            // Time cannot be borrowed from before source readback and its final authority check.
            now = timestamp(this.#now());
            if (!proof.satisfied || observation.completeness !== 'complete') return result('inconclusive');
            if (observation.observedAt > now || observation.ingestedAt > now
                || observation.observedAt < (wait?.since ?? current.envelope.updatedAt)
                || wait?.deadlineAt !== undefined && now >= wait.deadlineAt) return result('stale');
            if (current.ownerId !== null && current.ownerId !== ownerId && current.leaseExpiresAt !== null && current.leaseExpiresAt > now)
                reject('agent-loop-projection-lease-lost');
            this.#assertSuspensionIdle(current);
            if (seen) reject('agent-loop-projection-observation-conflict');
            const reduced = reduceAgentLoopObservation({ envelope: current.envelope, observation });
            if (reduced.classification !== 'applied' || !reduced.envelope) reject('agent-loop-projection-observation-conflict');
            const { wait: ignored, ...base } = reduced.envelope;
            void ignored;
            const envelope = normalizeAgentLoopTaskEnvelope({ ...base, state: 'RUNNING', updatedAt: now });
            const record = this.#writeSuspension(current, envelope,
                { eventId, kind: 'task-resumed', reasonCode: paused ? 'explicit-resume' : 'wait-satisfied' }, now, { ownerId, leaseMs });
            this.#insertObservation(observation, 'applied', reduced, record.revision, now);
            this.#appendEvent(taskId, record.revision, { eventId: proofId, kind: 'resume-proof', reasonCode: null }, record.envelopeDigest, now);
            return result('resumed', record);
        });
    }

    /** 取得/续租 lease（CAS 于 revision）。过期可被抢占，抢占后旧 owner 立即失去写权限。 */
    claimLease(input: unknown): AgentLoopTaskRecord {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'leaseMs']);
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        if (!Number.isSafeInteger(value.leaseMs) || Number(value.leaseMs) < 1
            || Number(value.leaseMs) > 86_400_000) reject('agent-loop-projection-input-invalid');
        const now = timestamp(this.#now());
        const leaseExpiresAt = new Date(Date.parse(now) + Number(value.leaseMs)).toISOString();
        return this.#transaction(() => {
            const current = this.#requireRecord(taskId);
            if (current.revision !== expected) {
                reject('agent-loop-projection-revision-conflict');
            }
            const held = current.ownerId === ownerId
                || current.leaseExpiresAt === null
                || Date.parse(current.leaseExpiresAt) <= Date.parse(now);
            if (!held) reject('agent-loop-projection-lease-lost');
            const changed = this.#db.prepare(`UPDATE agent_loop_task
                SET owner_id=?, lease_expires_at=?
                WHERE task_id=? AND revision=? AND fenced=0`)
                .run(ownerId, leaseExpiresAt, taskId, expected);
            if (Number(changed.changes) !== 1) {
                reject('agent-loop-projection-lease-lost');
            }
            return this.#requireRecord(taskId);
        });
    }

    /**
     * 严格续租：只接受当前 owner 尚未过期的非终态 lease，绝不取得/复活权限。
     * FAILED 在本 Store 中也是 settled：新 attempt 的重开不由续租暗中完成。
     * 仅更新 TTL；不推进 revision，不改 Envelope/updated_at，不追加 event/outbox。
     */
    renewLease(input: unknown): AgentLoopTaskRecord {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'leaseMs']);
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        if (!Number.isSafeInteger(value.leaseMs) || Number(value.leaseMs) < 1 || Number(value.leaseMs) > 86_400_000)
            reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            // A lock wait cannot preserve pre-lock authority: sample only after BEGIN IMMEDIATE.
            const now = timestamp(this.#now());
            const current = this.#requireRecord(taskId);
            if (current.revision !== expected) reject('agent-loop-projection-revision-conflict');
            if (TERMINAL_STATES.has(current.envelope.state)) reject('agent-loop-projection-lease-lost');
            this.#requireLease(current, ownerId, now, true);
            const currentExpiry = current.leaseExpiresAt;
            const currentExpiryMs = currentExpiry === null ? NaN : Date.parse(currentExpiry);
            // Corrupt/noncanonical TTL is not a lease capability, even when Date.parse accepts it.
            if (!Number.isFinite(currentExpiryMs) || new Date(currentExpiryMs).toISOString() !== currentExpiry) {
                reject('agent-loop-projection-lease-lost');
            }
            const expiry = new Date(Date.parse(now) + Number(value.leaseMs));
            if (!Number.isFinite(expiry.getTime())) reject('agent-loop-projection-input-invalid');
            const changed = this.#db
                .prepare(
                    `UPDATE agent_loop_task
                SET lease_expires_at=?
                WHERE task_id=? AND revision=? AND fenced=0 AND owner_id=? AND lease_expires_at=?`,
                )
                .run(expiry.toISOString(), taskId, expected, ownerId, currentExpiry);
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-lease-lost');
            return this.#requireRecord(taskId);
        });
    }

    /** 主动交还 lease（release 不推进 revision，也不写事件：它不是语义变化）。 */
    releaseLease(input: unknown): AgentLoopTaskRecord {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId']);
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        return this.#transaction(() => {
            const current = this.#requireRecord(taskId);
            if (current.revision !== expected) {
                reject('agent-loop-projection-revision-conflict');
            }
            if (current.ownerId !== ownerId) reject('agent-loop-projection-lease-lost');
            const changed = this.#db.prepare(`UPDATE agent_loop_task
                SET owner_id=NULL, lease_expires_at=NULL
                WHERE task_id=? AND revision=? AND fenced=0 AND owner_id=?`)
                .run(taskId, expected, ownerId);
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-lease-lost');
            return this.#requireRecord(taskId);
        });
    }

    /**
     * 删除围栏（墓碑）：一次 revision 前进 + 一条 `fenced` 事件 + 一条 outbox。
     * 之后任何写都 `agent-loop-projection-fenced`；读仍可看到墓碑。
     */
    fence(input: unknown): AgentLoopTaskRecord {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'reasonCode']);
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        const reasonCode = token(value.reasonCode);
        return this.#transaction(() => {
            // Cleanup also requires authority current after obtaining the writer lock.
            const now = timestamp(this.#now());
            const row = this.#row(taskId);
            const current = this.#record(row);
            if (!current) reject('agent-loop-projection-record-missing');
            if (current.fenced) return current; // 幂等：重复 fence 不改事实
            if (current.revision !== expected) {
                reject('agent-loop-projection-revision-conflict');
            }
            this.#requireLease(current, ownerId, now, true);
            const envelope = normalizeAgentLoopTaskEnvelope({
                ...current.envelope,
                revision: current.revision + 1,
                updatedAt: now > current.envelope.updatedAt ? now : current.envelope.updatedAt,
            });
            const envelopeDigest = hash(envelope);
            const changed = this.#db
                .prepare(
                    `UPDATE agent_loop_task
                SET revision=?, envelope_json=?, envelope_digest=?, updated_at=?,
                    fenced=1, fence_reason=?, owner_id=NULL, lease_expires_at=NULL
                WHERE task_id=? AND revision=? AND fenced=0`,
                )
                .run(
                    envelope.revision,
                    JSON.stringify(envelope),
                    envelopeDigest,
                    envelope.updatedAt,
                    reasonCode,
                    taskId,
                    expected,
                );
            if (Number(changed.changes) !== 1) {
                reject('agent-loop-projection-revision-conflict');
            }
            this.#appendEvent(
                taskId,
                envelope.revision,
                {
                    eventId: `fence:${taskId}:${envelope.revision}`,
                    kind: 'task-fenced',
                    reasonCode,
                },
                envelopeDigest,
                now,
            );
            const stored = this.#record(this.#row(taskId));
            if (!stored) reject('agent-loop-projection-storage-invalid');
            return stored;
        });
    }

    /**
     * 只追加审计事件，**不推进 revision**。
     *
     * 用途：`action-started` / `action-completed` / `action-uncertain` 这类「动作水位」标记。
     * 它们不改变投影内容（state/phase/budget 都不动），因此不该占用一个 revision；
     * 但它们必须是**持久**的 —— 崩溃恢复靠它判断「这个 actionId 到底发没发出去」，
     * 从而做到「最多重放只读阶段，不重复有副作用 Act」。
     * requireNew=true 只允许首次登记：同一写事务内已有 eventId 即拒绝，
     * 即使摘要相同或属于其他 task；省略/false 保留原有幂等语义。
     */
    annotate(input: unknown): AgentLoopTaskRecord {
        return this.#annotate(input);
    }

    #annotate(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): AgentLoopTaskRecord {
        const value = exact(
            input,
            ['taskId', 'expectedRevision', 'ownerId', 'event'],
            ['requireNew', 'modelCorrectionPolicy'],
        );
        if (Object.hasOwn(value, 'requireNew') && typeof value.requireNew !== 'boolean') {
            reject('agent-loop-projection-input-invalid');
        }
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        const event = this.#eventInput(value.event);
        return this.#transaction(
            () => {
                // Sample after BEGIN IMMEDIATE obtained the writer lock: waiting for
                // another connection must not preserve an already expired lease.
                const now = timestamp(this.#now());
                const current = this.#requireRecord(taskId);
                this.#requireLease(current, ownerId, now);
                if (current.revision !== expected) {
                    reject('agent-loop-projection-revision-conflict');
                }
                if (
                    dagExecution &&
                    (event.kind === 'model-invocation-reserved' || event.eventId.startsWith('model-invocation:'))
                ) {
                    const invocationId = agentLoopModelInvocationId({
                        taskId,
                        attemptId: dagExecution.childAttemptId,
                        expectedTaskRevision: expected,
                    });
                    const events = this.#db
                        .prepare('SELECT * FROM agent_loop_task_event WHERE task_id=?')
                        .all(taskId) as SqlRow[];
                    if (
                        current.envelope.phase !== 'MODEL' ||
                        value.requireNew !== true ||
                        event.reasonCode !== null ||
                        event.kind !== 'model-invocation-reserved' ||
                        event.eventId !== `model-invocation:${invocationId}` ||
                        current.envelope.budget.spent.modelCalls >= current.envelope.budget.granted.modelCalls ||
                        events.some(
                            (previous) =>
                                previous.kind === 'model-invocation-reserved' &&
                                !events.some(
                                    (closed) =>
                                        closed.event_id === `phase:${taskId}:${previous.revision}:MODEL-ACT` &&
                                        closed.kind === 'phase-advanced' &&
                                        closed.revision === Number(previous.revision) + 1,
                                ),
                        )
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                }
                if (dagExecution && event.kind === 'action-completed') {
                    const receipt = event.eventId.startsWith('action-completed:')
                        ? this.#readAction(event.eventId.slice('action-completed:'.length))
                        : null;
                    if (
                        !receipt ||
                        receipt.status !== 'observed' ||
                        receipt.actionContractRef !== 'action.rp.read-character.v1' ||
                        receipt.taskId !== taskId ||
                        receipt.ownerId !== ownerId ||
                        receipt.attemptId !== dagExecution.childAttemptId ||
                        receipt.appliedRevision !== current.revision
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                }
                if (this.#usesModelCorrection(current)) {
                    const policy = this.#boundModelCorrectionPolicy(current, this.#ownCorrectionPolicy(value));
                    if (now >= policy.deadlineAt || current.envelope.updatedAt > now)
                        reject('agent-loop-projection-input-invalid');
                    if (event.kind === 'model-invocation-reserved' || event.eventId.startsWith('model-invocation:')) {
                        const state = this.#modelCorrectionState(current, policy, now);
                        const invocationId = agentLoopModelInvocationId({
                            taskId,
                            attemptId: policy.attemptId,
                            expectedTaskRevision: expected,
                        });
                        if (
                            !state.invocationAllowed ||
                            value.requireNew !== true ||
                            event.kind !== 'model-invocation-reserved' ||
                            event.eventId !== `model-invocation:${invocationId}` ||
                            event.reasonCode !== null
                        )
                            reject('agent-loop-projection-input-invalid');
                    }
                } else if (Object.hasOwn(value, 'modelCorrectionPolicy')) reject('agent-loop-projection-input-invalid');
                if (
                    value.requireNew === true &&
                    this.#db.prepare('SELECT 1 FROM agent_loop_task_event WHERE event_id=?').get(event.eventId)
                ) {
                    reject('agent-loop-projection-event-exists');
                }
                this.#appendEvent(taskId, current.revision, event, current.envelopeDigest, now);
                return current;
            },
            true,
            dagExecution,
            undefined,
            dagExecution && event.kind === 'action-completed' ? 'accounting' : 'execution',
        );
    }

    /** Exclusive durable hold; accounting stays in this Store and never mutates the semantic Envelope. */
    reserveAction(input: unknown): 'reserved' | 'already-reserved' | 'insufficient' {
        return this.#reserveAction(input);
    }

    #reserveAction(
        input: unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): 'reserved' | 'already-reserved' | 'insufficient' {
        const { scope, value } = actionInput(input, ['actionDigest', 'actionContractRef', 'estimate']);
        const actionDigest = actionValue(normalizeAgentLoopActionDigest, value.actionDigest);
        const actionContractRef = actionValue(normalizeAgentLoopActionContractRef, value.actionContractRef);
        const estimate = actionValue(
            (value) => normalizeAgentLoopActionUsage(value, actionContractRef),
            value.estimate,
        );
        return this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#actionAuthority(scope, now);
                if (
                    this.#dagBound(scope.taskId) &&
                    (!dagExecution || actionContractRef !== 'action.rp.read-character.v1')
                ) {
                    reject('agent-loop-projection-input-invalid');
                }
                const existing = this.#readAction(scope.actionId);
                if (existing) {
                    this.#sameActionScope(existing, scope);
                    if (
                        existing.actionDigest !== actionDigest ||
                        existing.actionContractRef !== value.actionContractRef ||
                        JSON.stringify(existing.estimate) !== JSON.stringify(estimate) ||
                        existing.status === 'released' ||
                        existing.status === 'observed'
                    )
                        reject('agent-loop-projection-event-conflict');
                    return 'already-reserved';
                }
                // Before a first tool entry, its canonical result ID must still be available.
                // A legacy stale row written before this sidecar existed cannot be overwritten
                // or discovered only after the real tool has already run.
                if (
                    this.#db
                        .prepare('SELECT 1 FROM agent_loop_observation WHERE observation_id=?')
                        .get(`obs:${scope.actionId}`)
                )
                    reject('agent-loop-projection-observation-conflict');
                if (
                    this.#db
                        .prepare(
                            'SELECT 1 FROM agent_loop_action_receipt WHERE task_id=? AND attempt_id=? AND task_revision=?',
                        )
                        .get(scope.taskId, scope.attemptId, scope.expectedRevision)
                )
                    reject('agent-loop-projection-event-conflict');
                const active = this.#activeActions(scope.taskId);
                for (const key of AGENT_LOOP_ACTION_USAGE_KEYS) {
                    let held = 0;
                    for (const row of active) {
                        held += Math.max(row.estimate[key], row.result?.usage[key] ?? 0);
                        if (!Number.isSafeInteger(held)) return 'insufficient';
                    }
                    const budget = current.envelope.budget;
                    const used = budget.reserved[key] + budget.spent[key];
                    if (
                        !Number.isSafeInteger(used) ||
                        used > budget.granted[key] ||
                        held > budget.granted[key] - used ||
                        estimate[key] > budget.granted[key] - used - held
                    )
                        return 'insufficient';
                }
                const receipt: AgentLoopActionReceiptRecord = Object.freeze({
                    ...scope,
                    actionDigest,
                    actionContractRef,
                    estimate,
                    status: 'reserved',
                    createdAt: now,
                });
                this.#db
                    .prepare(
                        `INSERT INTO agent_loop_action_receipt(action_id,task_id,attempt_id,task_revision,owner_id,
                action_digest,action_contract_ref,estimate_json,status,created_at,metadata_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                    )
                    .run(
                        scope.actionId,
                        scope.taskId,
                        scope.attemptId,
                        scope.expectedRevision,
                        scope.ownerId,
                        actionDigest,
                        receipt.actionContractRef,
                        JSON.stringify(estimate),
                        receipt.status,
                        now,
                        hash(receipt),
                    );
                this.#actionEvent(receipt, 'reserved', current, now);
                return 'reserved';
            },
            true,
            dagExecution,
        );
    }

    markActionStarted(input: unknown): void {
        return this.#markActionStarted(input);
    }

    #markActionStarted(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): void {
        const { scope, value } = actionInput(input, ['actionDigest']);
        const digest = actionValue(normalizeAgentLoopActionDigest, value.actionDigest);
        this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#actionAuthority(scope, now),
                    row = this.#readAction(scope.actionId);
                if (!row) reject('agent-loop-projection-record-missing');
                this.#sameActionScope(row, scope);
                if (row.actionDigest !== digest || row.status === 'released' || row.status === 'observed')
                    reject('agent-loop-projection-event-conflict');
                // This transition is the executor-entry permit, not an idempotent acknowledgement.
                // A stale receipt read followed by an already-reserved result must never execute twice.
                if (row.status !== 'reserved') reject('agent-loop-projection-event-exists');
                this.#updateAction(Object.freeze({ ...row, status: 'started', startedAt: now }));
                this.#actionEvent(row, 'started', current, now);
            },
            true,
            dagExecution,
        );
    }

    /** Only exact content-free metadata from a real executor result; never derives a result from a receiptRef. */
    completeAction(input: unknown): void {
        return this.#completeAction(input);
    }

    #completeAction(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): void {
        const { scope, value } = actionInput(input, ['actionDigest', 'receiptRef', 'result']);
        const digest = actionValue(normalizeAgentLoopActionDigest, value.actionDigest);
        const receiptRef = actionValue(normalizeAgentLoopActionToken, value.receiptRef);
        this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#actionAuthority(scope, now),
                    row = this.#readAction(scope.actionId);
                if (!row) reject('agent-loop-projection-record-missing');
                this.#sameActionScope(row, scope);
                if (row.actionDigest !== digest) reject('agent-loop-projection-event-conflict');
                const result = actionValue(
                    (value) => normalizeAgentLoopActionResult(value, row.actionContractRef),
                    value.result,
                );
                if (row.status === 'completed') {
                    if (row.receiptRef !== receiptRef || JSON.stringify(row.result) !== JSON.stringify(result))
                        reject('agent-loop-projection-event-conflict');
                    return;
                }
                if (row.status !== 'started') reject('agent-loop-projection-event-conflict');
                // Actual safe-integer usage may exceed its estimate: preserve that fact for the Reducer, never clamp it.
                this.#updateAction(
                    Object.freeze({ ...row, status: 'completed', completedAt: now, receiptRef, result }),
                );
                this.#actionEvent(row, 'completed', current, now);
            },
            true,
            dagExecution,
            undefined,
            'accounting',
        );
    }

    /** Gateway settlement confirms the stored actual usage. Only Observation ingestion spends/releases the hold. */
    settleAction(input: unknown): void {
        return this.#settleAction(input);
    }

    #settleAction(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): void {
        const { scope, value } = actionInput(input, ['usage']);
        this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#actionAuthority(scope, now),
                    row = this.#readAction(scope.actionId);
                if (!row) reject('agent-loop-projection-record-missing');
                this.#sameActionScope(row, scope);
                const usage = actionValue(
                    (value) => normalizeAgentLoopActionUsage(value, row.actionContractRef),
                    value.usage,
                );
                if (
                    row.status !== 'completed' ||
                    !row.result ||
                    JSON.stringify(row.result.usage) !== JSON.stringify(usage)
                ) {
                    reject('agent-loop-projection-event-conflict');
                }
                if (row.settledAt) return;
                this.#updateAction(Object.freeze({ ...row, settledAt: now }));
                this.#actionEvent(row, 'settled', current, now);
            },
            true,
            dagExecution,
            undefined,
            'accounting',
        );
    }

    releaseAction(input: unknown): void {
        return this.#releaseAction(input);
    }

    #releaseAction(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): void {
        const { scope } = actionInput(input);
        this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#actionAuthority(scope, now),
                    row = this.#readAction(scope.actionId);
                if (!row) reject('agent-loop-projection-record-missing');
                this.#sameActionScope(row, scope);
                // The original Gateway also calls release on backend failure. A started unknown is not a refund.
                if (row.status !== 'reserved') return;
                this.#updateAction(Object.freeze({ ...row, status: 'released', releasedAt: now }));
                this.#actionEvent(row, 'released', current, now);
            },
            true,
            dagExecution,
            undefined,
            'accounting',
        );
    }

    readActionReceipt(input: unknown): AgentLoopActionReceiptRecord | null {
        return this.#readActionReceipt(input);
    }

    #readActionReceipt(
        input: unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): AgentLoopActionReceiptRecord | null {
        const value = actionValue((value) => normalizeAgentLoopActionObject(value, ['taskId', 'actionId']), input);
        const taskId = actionValue(normalizeAgentLoopActionToken, value.taskId);
        const actionId = actionValue(normalizeAgentLoopActionToken, value.actionId);
        if (dagExecution && taskId !== dagExecution.childTaskId) reject('agent-loop-projection-input-invalid');
        return this.#transaction(
            () => {
                const row = this.#readAction(actionId);
                if (row && row.taskId !== taskId) reject('agent-loop-projection-event-conflict');
                return row;
            },
            false,
            dagExecution,
        );
    }

    #refRecord(row: SqlRow): AgentLoopArtifactRefRecord {
        return Object.freeze({
            refId: String(row.ref_id),
            kind: String(row.kind) as AgentLoopArtifactRefKind,
            ownerRef: String(row.owner_ref),
            expectedDigest: String(row.expected_digest),
            ...(row.expected_revision === null
                ? {} : { expectedRevision: String(row.expected_revision) }),
            policy: String(row.policy) as AgentLoopArtifactRefPolicy,
            aclClass: String(row.acl_class) as AgentLoopArtifactRefAclClass,
            expandBudgetTokens: Number(row.expand_budget_tokens),
            taskRevision: Number(row.task_revision),
            registeredAt: String(row.registered_at),
        });
    }

    #completionCandidateRecord(row: SqlRow | undefined): StoredAgentLoopCompletionCandidate | null {
        if (!row) return null;
        try {
            const value = normalizeStoredAgentLoopCompletionCandidate(JSON.parse(String(row.candidate_json)));
            if (value.candidateRef !== row.candidate_ref || value.taskId !== row.task_id || value.attemptId !== row.attempt_id
                || value.taskRevision !== row.task_revision || value.snapshotDigest !== row.snapshot_digest
                || value.frozenDigest !== row.frozen_digest || value.createdAt !== row.created_at) throw new Error();
            return value;
        } catch { return reject('agent-loop-projection-storage-invalid'); }
    }

    #completionVerificationRecord(row: SqlRow | undefined): StoredAgentLoopCompletionVerification | null {
        if (!row) return null;
        try {
            const candidate = this.#completionCandidateRecord(this.#db.prepare(
                'SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?').get(row.candidate_ref) as SqlRow | undefined);
            if (!candidate) throw new Error();
            const value = normalizeStoredAgentLoopCompletionVerification(JSON.parse(String(row.verification_json)), candidate);
            if (value.verificationResultRef !== row.verification_result_ref || value.candidateRef !== row.candidate_ref
                || value.taskId !== row.task_id || value.taskRevision !== row.task_revision || value.candidateDigest !== row.candidate_digest
                || value.verificationDigest !== row.verification_digest || value.verifiedAt !== row.verified_at) throw new Error();
            return value;
        } catch { return reject('agent-loop-projection-storage-invalid'); }
    }

    #completionScope(input: unknown, extra: readonly string[] = []): Readonly<{
        taskId: string; ownerId: string; expectedRevision: number; value: Record<string, unknown>;
    }> {
        try {
            const value = normalizeAgentLoopActionObject(input, ['taskId', 'expectedRevision', 'ownerId', ...extra]);
            if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new Error();
            return { taskId: token(value.taskId), ownerId: token(value.ownerId), expectedRevision: Number(value.expectedRevision), value };
        } catch { return reject('agent-loop-projection-input-invalid'); }
    }

    #turnCompletionPolicy(envelope: AgentLoopTaskEnvelopeV1): AgentLoopTurnCompletionPolicy | null {
        const row = this.#db
            .prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq LIMIT 1')
            .get(envelope.taskId) as SqlRow | undefined;
        let selected: AgentLoopTurnCompletionPolicy | null;
        try {
            selected = assertAgentLoopTurnCompletionBirthBinding({
                envelope,
                birthEvent: row
                    ? {
                          eventId: String(row.event_id),
                          kind: String(row.kind),
                          reasonCode: row.reason_code === null ? null : String(row.reason_code),
                      }
                    : null,
            });
        } catch {
            return reject('agent-loop-projection-input-invalid');
        }
        if (!selected) return null;
        // The original birth event and its retained outbox are one durable pin.
        // Its ID binds the immutable policy tuple, not mutable historical payload.
        const outbox = this.#db
            .prepare('SELECT * FROM agent_loop_outbox WHERE event_id=?')
            .all(row!.event_id as string) as SqlRow[];
        if (
            row!.task_id !== envelope.taskId ||
            row!.revision !== 1 ||
            !HASH.test(String(row!.event_digest)) ||
            outbox.length !== 1 ||
            outbox[0]!.task_id !== envelope.taskId ||
            outbox[0]!.revision !== 1 ||
            outbox[0]!.event_digest !== row!.event_digest ||
            outbox[0]!.created_at !== row!.accepted_at
        ) {
            reject('agent-loop-projection-storage-invalid');
        }
        timestamp(row!.accepted_at);
        return selected;
    }

    #assertTurnCompletionEvaluation(
        envelope: AgentLoopTaskEnvelopeV1,
        evaluation: StoredAgentLoopCompletionVerification['evaluation'],
    ): void {
        const selected = this.#turnCompletionPolicy(envelope);
        if (!selected) return;
        try {
            assertAgentLoopTurnCompletionEvaluation({ policy: selected, evaluation });
        } catch {
            reject('agent-loop-projection-input-invalid');
        }
    }

    #completionAuthority(scope: Readonly<{ taskId: string; ownerId: string; expectedRevision: number }>, now: string): AgentLoopTaskRecord {
        const current = this.#requireRecord(scope.taskId);
        this.#requireLease(current, scope.ownerId, now);
        if (!current.leaseExpiresAt || !Number.isFinite(Date.parse(current.leaseExpiresAt))
            || new Date(current.leaseExpiresAt).toISOString() !== current.leaseExpiresAt) reject('agent-loop-projection-lease-lost');
        if (current.revision !== scope.expectedRevision) reject('agent-loop-projection-revision-conflict');
        if (TERMINAL_STATES.has(current.envelope.state) || current.envelope.phase !== 'VERIFY'
            || current.envelope.currentAttemptId === undefined) reject('agent-loop-projection-input-invalid');
        this.#turnCompletionPolicy(current.envelope);
        return current;
    }

    #completionSnapshot(current: AgentLoopTaskRecord, terminalEvents: ReadonlySet<string> = new Set()): AgentLoopCompletionSnapshot {
        const envelope = current.envelope, taskId = envelope.taskId;
        if (envelope.currentAttemptId === undefined) reject('agent-loop-projection-input-invalid');
        if (hash(envelope) !== current.envelopeDigest) reject('agent-loop-projection-storage-invalid');
        this.#turnCompletionPolicy(envelope);
        const ownEvents = new Set<string>();
        // Exclude only audit events actually owned by a strict durable completion record.
        // A caller-supplied kind/prefix alone must never hide a same-revision mutation.
        for (const row of this.#db.prepare('SELECT * FROM agent_loop_completion_candidate WHERE task_id=?').all(taskId) as SqlRow[]) {
            const value = this.#completionCandidateRecord(row)!;
            ownEvents.add(`completion-candidate-frozen:${value.snapshotDigest.slice(7)}`);
        }
        for (const row of this.#db.prepare('SELECT * FROM agent_loop_completion_verification WHERE task_id=?').all(taskId) as SqlRow[]) {
            const value = this.#completionVerificationRecord(row)!;
            ownEvents.add(`completion-verification-recorded:${value.verificationDigest.slice(7)}`);
        }
        const allEvents = (this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[])
            .filter(row => !terminalEvents.has(String(row.event_id)));
        for (const row of allEvents) {
            token(row.event_id); token(row.kind); timestamp(row.accepted_at);
            if (row.reason_code !== null) token(row.reason_code);
            if (!HASH.test(String(row.event_digest)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || Number(row.revision) > current.revision
                || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1) reject('agent-loop-projection-storage-invalid');
        }
        const events = allEvents.filter(row => !ownEvents.has(String(row.event_id)));
        const observations = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE task_id=? ORDER BY observation_id').all(taskId);
        const quarantine = this.#db.prepare('SELECT * FROM agent_loop_observation_quarantine WHERE task_id=? ORDER BY observation_id').all(taskId);
        const receipts = (this.#db.prepare('SELECT * FROM agent_loop_action_receipt WHERE task_id=? ORDER BY action_id').all(taskId) as SqlRow[])
            .map(row => this.#actionRecord(row)!);
        const artifactDescriptors = (this.#db.prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? ORDER BY ref_id').all(taskId) as SqlRow[])
            .map(row => this.#refRecord(row));
        const artifacts = envelope.artifacts, artifactRefs = Object.freeze(artifacts.map(item => item.artifactRef));
        const missingArtifactRefs = Object.freeze(artifactRefs.filter(ref => !artifactDescriptors.some(item => item.refId === ref)));
        const resolved = new Set(events.filter(row => row.kind === 'action-completed' || row.kind === 'action-reconciled')
            .map(row => String(row.event_id).replace(/^action-(?:completed|reconciled):/u, '')));
        const unknown = new Set(events.filter(row => row.kind === 'action-started')
            .map(row => String(row.event_id).replace(/^action-started:/u, '')).filter(id => !resolved.has(id)));
        for (const receipt of receipts) {
            if (receipt.status !== 'released' && (receipt.status !== 'observed' || receipt.result?.completeness !== 'complete')) unknown.add(receipt.actionId);
        }
        const actionWatermark = [...events].reverse().find(row => row.kind === 'action-completed')?.event_id;
        return { taskId, attemptId: envelope.currentAttemptId, taskRevision: current.revision,
            envelopeDigest: current.envelopeDigest, taskKind: envelope.taskKind, taskContractRef: envelope.taskContractRef,
            verifierSetRef: envelope.verifier.verifierSetRef, verifierSetRevision: envelope.verifier.verifierSetRevision,
            artifactRefs, artifacts, artifactDescriptors: Object.freeze(artifactDescriptors), missingArtifactRefs,
            artifactsDigest: agentLoopCompletionDigest({ artifacts, artifactDescriptors }), eventsDigest: agentLoopCompletionDigest(events),
            observationsDigest: agentLoopCompletionDigest({ observations, quarantine }), receiptsDigest: agentLoopCompletionDigest(receipts),
            actionWatermark: actionWatermark === undefined ? null : String(actionWatermark), unknownEffectActionIds: Object.freeze([...unknown].sort()) };
    }

    #currentCompletionCandidate(current: AgentLoopTaskRecord, candidateRef: string, now: string): StoredAgentLoopCompletionCandidate {
        const candidate = this.#completionCandidateRecord(this.#db.prepare(
            'SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?').get(candidateRef) as SqlRow | undefined);
        if (!candidate) reject('agent-loop-projection-record-missing');
        if (candidate.taskId !== current.envelope.taskId) reject('agent-loop-projection-event-conflict');
        let snapshotDigest: string;
        try { snapshotDigest = createStoredAgentLoopCompletionCandidate(this.#completionSnapshot(current), now).snapshotDigest; }
        catch { return reject('agent-loop-projection-storage-invalid'); }
        if (candidate.snapshotDigest !== snapshotDigest) reject('agent-loop-projection-revision-conflict');
        return candidate;
    }

    #correctionInput(input: unknown, owner: boolean, extra: readonly string[] = []): Record<string, unknown> {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = exact(input, ['taskId', 'expectedRevision', 'policy', ...(owner ? ['ownerId'] : []), ...extra]);
        for (const key of Reflect.ownKeys(value)) {
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject('agent-loop-projection-input-invalid');
        }
        token(value.taskId); if (owner) token(value.ownerId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) reject('agent-loop-projection-input-invalid');
        return value;
    }

    #ownCorrectionPolicy(value: Record<string, unknown>): unknown {
        const property = Object.getOwnPropertyDescriptor(value, 'modelCorrectionPolicy');
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject('agent-loop-projection-input-invalid');
        return property.value;
    }

    #usesModelCorrection(current: AgentLoopTaskRecord): boolean {
        return current.envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
            || !!this.#db.prepare("SELECT 1 FROM agent_loop_task_event WHERE task_id=? AND (kind='model-correction-policy-bound' OR event_id GLOB 'model-correction-policy:*') LIMIT 1").get(current.envelope.taskId);
    }

    #assertCorrectionFrame(input: unknown, current: AgentLoopTaskRecord): AgentLoopModelCorrectionPolicy {
        try { return assertAgentLoopModelCorrectionPolicyBinding(input, current); }
        catch { return reject('agent-loop-projection-input-invalid'); }
    }

    #boundModelCorrectionPolicy(current: AgentLoopTaskRecord, input: unknown): AgentLoopModelCorrectionPolicy {
        const policy = this.#assertCorrectionFrame(input, current), taskId = current.envelope.taskId;
        const rows = this.#db.prepare("SELECT * FROM agent_loop_task_event WHERE task_id=? AND (kind='model-correction-policy-bound' OR event_id GLOB 'model-correction-policy:*') ORDER BY seq").all(taskId) as SqlRow[];
        const id = `model-correction-policy:${agentLoopModelCorrectionPolicyDigest(policy).slice(7)}`;
        if (rows.length !== 1 || rows[0]!.event_id !== id || rows[0]!.kind !== 'model-correction-policy-bound'
            || Number(rows[0]!.revision) !== policy.initialRevision || rows[0]!.reason_code !== 'correction-once'
            || rows[0]!.event_digest !== eventDigest({ eventId: id, taskId, revision: policy.initialRevision,
                kind: 'model-correction-policy-bound', reasonCode: 'correction-once', envelopeDigest: policy.initialEnvelopeDigest })) {
            reject('agent-loop-projection-storage-invalid');
        }
        timestamp(rows[0]!.accepted_at);
        this.#correctionEventOutbox(rows[0]!);
        // Revision one remains the explicit generic-engine component boundary.
        // A genuine initial Prepare binds revision two; its original atomic
        // provenance must remain intact after reopen, not just a policy hash.
        const prepared = this.#db.prepare("SELECT * FROM agent_loop_task_event WHERE task_id=? AND (kind='model-correction-prepared' OR event_id GLOB 'model-correction-prepare:*') ORDER BY seq").all(taskId) as SqlRow[];
        if (policy.initialRevision !== 1 || prepared.length !== 0) {
            const row = prepared[0], phaseId = `phase:${taskId}:1:PREPARE-MODEL`;
            const phase = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? AND event_id=?').get(taskId, phaseId) as SqlRow | undefined;
            const preparedId = `model-correction-prepare:${agentLoopModelCorrectionPolicyDigest(policy).slice(7)}`;
            if (policy.initialRevision !== 2 || prepared.length !== 1 || !row || !phase
                || row.event_id !== preparedId || row.kind !== 'model-correction-prepared' || Number(row.revision) !== 2
                || row.reason_code !== 'correction-once' || row.accepted_at !== rows[0]!.accepted_at
                || current.revision === 2 && row.accepted_at !== current.envelope.updatedAt
                || row.event_digest !== eventDigest({ taskId, revision: 2, eventId: preparedId,
                    kind: 'model-correction-prepared', reasonCode: 'correction-once', envelopeDigest: policy.initialEnvelopeDigest })
                || phase.kind !== 'phase-advanced' || phase.reason_code !== null || Number(phase.revision) !== 2
                || phase.accepted_at !== row.accepted_at
                || phase.event_digest !== eventDigest({ taskId, revision: 2, eventId: phaseId,
                    kind: 'phase-advanced', reasonCode: null, envelopeDigest: policy.initialEnvelopeDigest })
                || Number(phase.seq) + 1 !== Number(row.seq) || Number(row.seq) + 1 !== Number(rows[0]!.seq)) reject('agent-loop-projection-storage-invalid');
            this.#correctionEventOutbox(row); this.#correctionEventOutbox(phase);
            const grant = current.envelope.budget.granted;
            if (grant.toolCalls !== 0 || grant.writes !== 0) {
                // Only the independent corrected-shadow Prepare can bind this
                // exact one-action frame. Its ref was written in the same CAS,
                // immediately before phase/prepared/policy, never backfilled.
                if (grant.toolCalls !== 1 || grant.writes !== 1 || grant.highRiskActions !== 0 || grant.childTasks !== 0) reject('agent-loop-projection-storage-invalid');
                const bindings = current.envelope.artifacts.filter(item => item.kind === 'agent-loop-execution-binding');
                const binding = bindings[0], claim = `sha256:${policy.attemptId.slice('attempt.al.'.length)}`;
                if (bindings.length !== 1 || !binding || binding.status !== 'declared'
                    || !/^execution\.prepare:[a-f0-9]{64}$/u.test(binding.artifactRef)
                    || !binding.evidenceRefs.includes(claim)) reject('agent-loop-projection-storage-invalid');
                const rawRef = this.#db.prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?').get(taskId, binding.artifactRef) as SqlRow | undefined;
                const refEvent = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? AND event_id=?').get(taskId, `ref-registered:${binding.artifactRef}`) as SqlRow | undefined;
                if (!rawRef || !refEvent) reject('agent-loop-projection-storage-invalid');
                const ref = this.#refRecord(rawRef);
                if (ref.kind !== 'session-artifact' || ref.ownerRef !== `maintenancejob.${taskId.slice('agentloop.maintenance.'.length)}`
                    || ref.expectedDigest !== `sha256:${binding.artifactRef.slice('execution.prepare:'.length)}` || ref.expectedRevision !== claim
                    || ref.policy !== 'required' || ref.aclClass !== 'restricted' || ref.expandBudgetTokens !== 0
                    || ref.taskRevision !== 2 || ref.registeredAt !== phase.accepted_at
                    || refEvent.kind !== 'ref-registered' || refEvent.reason_code !== null || Number(refEvent.revision) !== 2
                    || refEvent.accepted_at !== phase.accepted_at || Number(refEvent.seq) + 1 !== Number(phase.seq)
                    || refEvent.event_digest !== eventDigest({ taskId, revision: 2, eventId: String(refEvent.event_id),
                        kind: 'ref-registered', reasonCode: null, envelopeDigest: policy.initialEnvelopeDigest })) reject('agent-loop-projection-storage-invalid');
                this.#correctionEventOutbox(refEvent);
            }
        }
        return policy;
    }

    #correctionEventOutbox(event: SqlRow): void {
        const rows = this.#db.prepare('SELECT * FROM agent_loop_outbox WHERE event_id=?').all(event.event_id) as SqlRow[];
        if (rows.length !== 1 || rows[0]!.task_id !== event.task_id || Number(rows[0]!.revision) !== Number(event.revision)
            || rows[0]!.event_digest !== event.event_digest || rows[0]!.created_at !== event.accepted_at) reject('agent-loop-projection-storage-invalid');
        timestamp(rows[0]!.created_at);
        if (rows[0]!.delivered_at !== null) {
            timestamp(rows[0]!.delivered_at);
            if (String(rows[0]!.delivered_at) < String(rows[0]!.created_at)) reject('agent-loop-projection-storage-invalid');
        }
    }

    /** Each optional versioned detail is bound to the original invocation,
     * applied usage and unchanged coarse refusal. Its ID retains the original
     * rejected Envelope digest so cold readers can recompute both event hashes.
     * Absence is historical unknown, not a generic schema error or a grant. */
    #summaryValidationEvents(current: AgentLoopTaskRecord, events: readonly SqlRow[]): Map<string, AgentLoopSummaryValidationRejection> {
        const found = new Map<string, AgentLoopSummaryValidationRejection>();
        for (const row of events.filter(event => String(event.kind).startsWith('model-summary-validation-rejected-') || String(event.event_id).startsWith('summary-validation-'))) {
            const match = /^summary-validation-v1:([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(String(row.event_id));
            if (!match || row.kind !== SUMMARY_VALIDATION_EVENT || current.envelope.taskKind !== 'maintenance.rolling_summary') reject('agent-loop-projection-storage-invalid');
            const invocationId = `sha256:${match[1]}`, envelopeDigest = `sha256:${match[2]}`, taskId = current.envelope.taskId;
            const coarse = events.find(event => event.event_id === `model-rejection:${invocationId}`);
            const applied = events.find(event => event.event_id === `observation:model-usage:${invocationId}`);
            const reserved = events.find(event => event.event_id === `model-invocation:${invocationId}`);
            const observation = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?').get(`model-usage:${invocationId}`) as SqlRow | undefined;
            const revision = Number(row.revision), modelRevision = revision - 1;
            if (found.has(invocationId) || !coarse || !applied || !reserved || !observation || !Number.isSafeInteger(modelRevision) || modelRevision < 1
                || revision > current.revision || row.task_id !== taskId || coarse.task_id !== taskId || applied.task_id !== taskId || reserved.task_id !== taskId
                || coarse.kind !== 'model-protocol-rejected' || coarse.reason_code !== 'proposal-invalid' || Number(coarse.revision) !== revision
                || applied.kind !== 'observation-applied' || Number(applied.revision) !== revision || applied.reason_code !== null
                || reserved.kind !== 'model-invocation-reserved' || Number(reserved.revision) !== modelRevision || reserved.reason_code !== null
                || observation.task_id !== taskId || observation.source_kind !== 'provider' || observation.completeness !== 'complete'
                || observation.classification !== 'applied' || Number(observation.satisfies_verification) !== 1
                || Number(observation.observed_for_revision) !== modelRevision || Number(observation.applied_revision) !== revision
                || !HASH.test(String(observation.observation_digest)) || !HASH.test(String(observation.payload_digest))
                || invocationId !== agentLoopModelInvocationId({ taskId, attemptId: String(observation.attempt_id), expectedTaskRevision: modelRevision })
                || Number(coarse.seq) !== Number(applied.seq) + 1 || Number(row.seq) !== Number(coarse.seq) + 1 || Number(reserved.seq) >= Number(applied.seq)
                || row.accepted_at !== coarse.accepted_at || row.accepted_at !== applied.accepted_at || row.accepted_at !== observation.ingested_at
                || timestamp(row.accepted_at) < timestamp(reserved.accepted_at)
                || coarse.event_digest !== eventDigest({ taskId, eventId: String(coarse.event_id), revision, kind: 'model-protocol-rejected',
                    reasonCode: 'proposal-invalid', envelopeDigest })
                || applied.event_digest !== eventDigest({ taskId, eventId: String(applied.event_id), revision, kind: 'observation-applied', reasonCode: null, envelopeDigest })
                || row.event_digest !== eventDigest({ taskId, eventId: String(row.event_id), revision, kind: SUMMARY_VALIDATION_EVENT,
                    reasonCode: String(row.reason_code), envelopeDigest })) reject('agent-loop-projection-storage-invalid');
            let detail: AgentLoopSummaryValidationRejection;
            try { detail = normalizeAgentLoopSummaryValidationRejection({ version: AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION, code: row.reason_code }); }
            catch { return reject('agent-loop-projection-storage-invalid'); }
            for (const event of [reserved, applied, coarse, row]) this.#correctionEventOutbox(event);
            found.set(invocationId, detail);
        }
        return found;
    }

    readModelSummaryValidationRejection(input: unknown): AgentLoopSummaryValidationHistory {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = exact(input, ['taskId', 'attemptId', 'modelRevision'], ['modelOutcome']);
        for (const key of Reflect.ownKeys(value)) {
            const field = Object.getOwnPropertyDescriptor(value, key);
            if (!field?.enumerable || !Object.hasOwn(field, 'value')) reject('agent-loop-projection-input-invalid');
        }
        if (!Number.isSafeInteger(value.modelRevision) || Number(value.modelRevision) < 1) reject('agent-loop-projection-input-invalid');
        const taskId = token(value.taskId), attemptId = token(value.attemptId), modelRevision = Number(value.modelRevision);
        const invocationId = agentLoopModelInvocationId({ taskId, attemptId, expectedTaskRevision: modelRevision });
        // Optional live-brand comparison is still read-only. A historical DTO,
        // clone or new result with merely the same identity is not this receipt.
        const model = Object.hasOwn(value, 'modelOutcome') ? readAgentLoopModelOutcome(value.modelOutcome) : null;
        if (Object.hasOwn(value, 'modelOutcome') && (!model || model.decision !== null
            || model.protocolRejectionReason !== 'proposal-invalid' || !model.summaryValidationRejection)) reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            // Historical inspection does not acquire a lease or require an
            // unfenced execution lane. Original failed/fenced facts stay readable.
            const current = this.#record(this.#row(taskId));
            if (!current) reject('agent-loop-projection-record-missing');
            const events = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
            const coarse = events.find(event => event.event_id === `model-rejection:${invocationId}`);
            const observation = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?').get(`model-usage:${invocationId}`) as SqlRow | undefined;
            const applied = events.find(event => event.event_id === `observation:model-usage:${invocationId}`);
            const reserved = events.find(event => event.event_id === `model-invocation:${invocationId}`);
            if (current.envelope.taskKind !== 'maintenance.rolling_summary' || modelRevision >= current.revision
                || !coarse || coarse.kind !== 'model-protocol-rejected' || coarse.reason_code !== 'proposal-invalid'
                || Number(coarse.revision) !== modelRevision + 1 || !observation || observation.task_id !== taskId || observation.attempt_id !== attemptId
                || observation.classification !== 'applied' || observation.completeness !== 'complete'
                || Number(observation.observed_for_revision) !== modelRevision || Number(observation.applied_revision) !== modelRevision + 1) reject('agent-loop-projection-input-invalid');
            if (coarse.task_id !== taskId || observation.source_kind !== 'provider' || Number(observation.satisfies_verification) !== 1
                || !HASH.test(String(observation.observation_digest)) || !HASH.test(String(observation.payload_digest))
                || !applied || applied.task_id !== taskId || applied.kind !== 'observation-applied' || applied.reason_code !== null
                || Number(applied.revision) !== modelRevision + 1 || !reserved || reserved.task_id !== taskId
                || reserved.kind !== 'model-invocation-reserved' || reserved.reason_code !== null || Number(reserved.revision) !== modelRevision
                || ![coarse, applied, reserved].every(event => HASH.test(String(event.event_digest)))
                || Number(coarse.seq) !== Number(applied.seq) + 1 || Number(reserved.seq) >= Number(applied.seq)
                || coarse.accepted_at !== applied.accepted_at || coarse.accepted_at !== observation.ingested_at
                || timestamp(coarse.accepted_at) < timestamp(reserved.accepted_at)) reject('agent-loop-projection-storage-invalid');
            for (const event of [reserved, applied, coarse]) this.#correctionEventOutbox(event);
            const detail = this.#summaryValidationEvents(current, events).get(invocationId) ?? null;
            if (model) {
                const obs = model.observation;
                if (!detail || obs.taskId !== taskId || obs.attemptId !== attemptId || obs.observedForTaskRevision !== modelRevision
                    || obs.observationId !== `model-usage:${invocationId}` || obs.correlationRef !== `model-invocation:${invocationId}`
                    || obs.sourceKind !== 'provider' || obs.completeness !== 'complete'
                    || observation.observation_digest !== agentLoopObservationDigest(obs) || observation.payload_digest !== obs.payloadDigest
                    || model.summaryValidationRejection!.version !== detail.version || model.summaryValidationRejection!.code !== detail.code) reject('agent-loop-projection-input-invalid');
            }
            return Object.freeze({ version: 'agent-loop-summary-validation-history-v1' as const, taskId, attemptId, modelRevision, invocationId,
                status: detail ? 'recorded' as const : 'not-recorded' as const, rejection: detail,
                executionAuthorized: false, completionAuthorized: false, canaryAuthorized: false, productionEligible: false });
        }, false);
    }

    /** Historical metadata integrity only. It does not recover a policy body,
     * live Outcome, source, lease or execution capability after restart. */
    #assertCorrectionOutboxHistory(current: AgentLoopTaskRecord): void {
        if (current.envelope.taskContractRef !== AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF) return;
        const taskId = current.envelope.taskId;
        const events = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
        this.#summaryValidationEvents(current, events);
        const count = this.#db.prepare('SELECT COUNT(*) n FROM agent_loop_outbox WHERE task_id=?').get(taskId)!;
        if (Number(count.n) !== events.length) reject('agent-loop-projection-storage-invalid');
        for (const event of events) this.#correctionEventOutbox(event);
    }

    #correctionSnapshot(current: AgentLoopTaskRecord): string {
        const tail = ['agent_loop_task_event', 'agent_loop_outbox', 'agent_loop_observation', 'agent_loop_observation_quarantine',
            'agent_loop_artifact_ref', 'agent_loop_action_receipt', 'agent_loop_completion_candidate', 'agent_loop_completion_verification']
            .map(table => this.#db.prepare(`SELECT * FROM ${table} WHERE task_id=? ORDER BY rowid`).all(current.envelope.taskId));
        return hash({ current, tail });
    }

    #correctionLive(value: Record<string, unknown>, policy: AgentLoopModelCorrectionPolicy, now: string): AgentLoopTaskRecord {
        const current = this.#requireRecord(String(value.taskId));
        this.#requireLease(current, String(value.ownerId), now);
        this.#assertCorrectionFrame(policy, current);
        if (current.revision !== value.expectedRevision) reject('agent-loop-projection-revision-conflict');
        if (current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'MODEL'
            || current.envelope.updatedAt > now || now >= policy.deadlineAt) reject('agent-loop-projection-input-invalid');
        return current;
    }

    #correctionAuthorize(authorizeCommit: () => unknown): void {
        const result = authorizeCommit();
        if (result !== undefined) {
            if (result !== null && typeof result === 'object') {
                try { void Promise.prototype.then.call(result, () => undefined, () => undefined); } catch { /* Never assimilate a foreign thenable. */ }
            }
            reject('agent-loop-projection-input-invalid');
        }
    }

    #assertCorrectionReservation(current: AgentLoopTaskRecord, policy: AgentLoopModelCorrectionPolicy, invocationId: string): void {
        const state = this.#modelCorrectionState(current, policy, timestamp(this.#now()));
        if (state.reasonCodes.includes('correction-not-live')) reject('agent-loop-projection-input-invalid');
        const row = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?').get(`model-invocation:${invocationId}`) as SqlRow | undefined;
        if (!row || row.task_id !== current.envelope.taskId || Number(row.revision) !== current.revision
            || row.kind !== 'model-invocation-reserved' || row.reason_code !== null
            || row.event_digest !== eventDigest({ eventId: String(row.event_id), taskId: current.envelope.taskId,
                revision: current.revision, kind: 'model-invocation-reserved', reasonCode: null, envelopeDigest: current.envelopeDigest })) reject('agent-loop-projection-storage-invalid');
        this.#correctionEventOutbox(row);
        const ready = this.#db.prepare("SELECT revision FROM agent_loop_task_event WHERE task_id=? AND kind='model-correction-ready'").all(current.envelope.taskId) as SqlRow[];
        if (current.revision !== policy.initialRevision && (ready.length !== 1 || Number(ready[0]!.revision) !== current.revision)) reject('agent-loop-projection-input-invalid');
    }

    #modelCorrectionState(current: AgentLoopTaskRecord, input: unknown, now: string): AgentLoopModelCorrectionState {
        const policy = this.#boundModelCorrectionPolicy(current, input), taskId = current.envelope.taskId;
        const events = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
        this.#summaryValidationEvents(current, events);
        const observations = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE task_id=? ORDER BY applied_revision').all(taskId) as SqlRow[];
        const reserves = events.filter(row => row.kind === 'model-invocation-reserved' || String(row.event_id).startsWith('model-invocation:'));
        const rejections = events.filter(row => row.kind === 'model-protocol-rejected' || String(row.event_id).startsWith('model-rejection:'));
        const ready = events.filter(row => row.kind === 'model-correction-ready' || String(row.event_id).startsWith('model-correction-ready:'));
        const bound = events.find(row => row.kind === 'model-correction-policy-bound')!;
        if (String(bound.accepted_at) > now || String(bound.accepted_at) >= policy.deadlineAt) reject('agent-loop-projection-storage-invalid');
        if (reserves.length > 2 || rejections.length > 2 || ready.length > 1) reject('agent-loop-projection-storage-invalid');
        const initialId = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: policy.initialRevision });
        for (const row of reserves) {
            const revision = Number(row.revision), id = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: revision });
            if (revision > current.revision || ![policy.initialRevision, policy.initialRevision + 2].includes(revision) || row.event_id !== `model-invocation:${id}`
                || row.kind !== 'model-invocation-reserved' || row.reason_code !== null || Number(row.seq) <= Number(bound.seq)) reject('agent-loop-projection-storage-invalid');
            timestamp(row.accepted_at);
            if (String(row.accepted_at) < String(bound.accepted_at) || String(row.accepted_at) > now) reject('agent-loop-projection-storage-invalid');
            this.#correctionEventOutbox(row);
            if (revision === policy.initialRevision && row.event_digest !== eventDigest({ eventId: String(row.event_id), taskId, revision,
                kind: 'model-invocation-reserved', reasonCode: null, envelopeDigest: policy.initialEnvelopeDigest })) reject('agent-loop-projection-storage-invalid');
        }
        for (const row of rejections) {
            const revision = Number(row.revision), reserveRevision = revision - 1;
            const id = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: reserveRevision });
            const reserved = reserves.find(item => Number(item.revision) === reserveRevision);
            const observation = observations.find(item => item.observation_id === `model-usage:${id}`);
            const applied = events.find(item => item.event_id === `observation:model-usage:${id}`);
            if (!reserved || row.event_id !== `model-rejection:${id}` || row.kind !== 'model-protocol-rejected'
                || !isAgentLoopModelProtocolRejectionReason(row.reason_code) || !observation || !applied
                || observation.attempt_id !== policy.attemptId || observation.source_kind !== 'provider'
                || observation.classification !== 'applied' || observation.completeness !== 'complete'
                || Number(observation.observed_for_revision) !== reserveRevision || Number(observation.applied_revision) !== revision
                || applied.kind !== 'observation-applied' || Number(applied.revision) !== revision
                || events.indexOf(applied) + 1 !== events.indexOf(row) || applied.accepted_at !== row.accepted_at
                || Number(reserved.seq) >= Number(applied.seq) || row.accepted_at! < reserved.accepted_at!) reject('agent-loop-projection-storage-invalid');
            timestamp(row.accepted_at);
            if (String(row.accepted_at) > now || String(observation.ingested_at) !== String(row.accepted_at)
                || !HASH.test(String(observation.observation_digest)) || !HASH.test(String(observation.payload_digest))) reject('agent-loop-projection-storage-invalid');
            this.#correctionEventOutbox(applied); this.#correctionEventOutbox(row);
        }
        const firstRejected = rejections.find(row => Number(row.revision) === policy.initialRevision + 1);
        if (ready.length) {
            const row = ready[0]!;
            if (!firstRejected || row.event_id !== `model-correction-ready:${initialId.slice(7)}` || row.kind !== 'model-correction-ready'
                || row.reason_code !== 'correction-once' || Number(row.revision) !== policy.initialRevision + 2
                || Number(row.seq) <= Number(firstRejected.seq) || row.accepted_at! < firstRejected.accepted_at!) reject('agent-loop-projection-storage-invalid');
            timestamp(row.accepted_at);
            if (String(row.accepted_at) > now) reject('agent-loop-projection-storage-invalid');
            this.#correctionEventOutbox(row);
        }
        if (reserves.some(row => Number(row.revision) === policy.initialRevision + 2) && !ready.length) reject('agent-loop-projection-storage-invalid');
        const active = this.#activeActions(taskId).length > 0
            || events.some(row => row.kind === 'action-started')
            || !!this.#db.prepare('SELECT 1 FROM agent_loop_observation_quarantine WHERE task_id=? LIMIT 1').get(taskId);
        let status: AgentLoopModelCorrectionState['status'] = 'blocked';
        if (!active && current.envelope.state === 'RUNNING' && current.envelope.phase === 'MODEL') {
            if (current.revision === policy.initialRevision && reserves.length === 0 && observations.length === 0 && ready.length === 0) status = 'initial';
            else if (firstRejected && observations.length === 1 && reserves.length >= 1
                && current.revision === policy.initialRevision + (ready.length ? 2 : 1)) {
                const rejected = ready.length ? normalizeAgentLoopTaskEnvelope({ ...current.envelope, revision: current.revision - 1 }) : current.envelope;
                const rejectedDigest = hash(rejected), applied = events.find(row => row.event_id === `observation:model-usage:${initialId}`)!;
                for (const row of [applied, firstRejected]) if (row.event_digest !== eventDigest({ eventId: String(row.event_id), taskId,
                    revision: Number(row.revision), kind: String(row.kind), reasonCode: row.reason_code === null ? null : String(row.reason_code),
                    envelopeDigest: rejectedDigest })) reject('agent-loop-projection-storage-invalid');
                const spent = current.envelope.budget.spent;
                if (spent.modelCalls !== 1 || spent.toolCalls !== 0 || spent.writes !== 0 || spent.highRiskActions !== 0 || spent.childTasks !== 0
                    || spent.inputTokens <= 0 || spent.outputTokens <= 0
                    || Object.values(current.envelope.budget.reserved).some(amount => amount !== 0)) reject('agent-loop-projection-storage-invalid');
                status = ready.length ? reserves.some(row => Number(row.revision) === current.revision) ? 'blocked' : 'ready' : 'rejected';
                if (ready.length && ready[0]!.event_digest !== eventDigest({ eventId: String(ready[0]!.event_id), taskId,
                    revision: current.revision, kind: 'model-correction-ready', reasonCode: 'correction-once', envelopeDigest: current.envelopeDigest })) reject('agent-loop-projection-storage-invalid');
            }
        }
        const remaining = Object.keys(policy.requiredBudget).every(key => {
            const k = key as keyof typeof policy.requiredBudget, budget = current.envelope.budget;
            return budget.granted[k] - budget.reserved[k] - budget.spent[k] >= policy.requiredBudget[k];
        });
        const live = !current.fenced && current.ownerId !== null && current.leaseExpiresAt !== null && current.leaseExpiresAt > now && now < policy.deadlineAt;
        return Object.freeze({ version: 'agent-loop-model-correction-state-v1', taskId, taskRevision: current.revision,
            envelopeDigest: current.envelopeDigest, policyDigest: agentLoopModelCorrectionPolicyDigest(policy), initialRevision: policy.initialRevision,
            correctionsUsed: ready.length ? 1 : 0, status, invocationAllowed: live && remaining && (status === 'initial' || status === 'ready'),
            readyRevision: ready.length ? Number(ready[0]!.revision) : null,
            closedInvocationId: status === 'ready' || status === 'rejected' ? initialId : null, snapshotDigest: this.#correctionSnapshot(current),
            reasonCodes: Object.freeze([!live ? 'correction-not-live' : !remaining ? 'correction-budget-insufficient' : `correction-${status}`]) });
    }

    /** Independent initial Prepare only. The original opaque grant is consumed
     * once under this Store's writer lock. Contract/grant/binding/phase/policy and
     * every outbox are atomic; no invocation, old Action capability or DDL here.
     * A lost return after COMMIT never authorizes reinitialization or renewal.
     */
    commitModelCorrectionPrepare(input: unknown): Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }> {
        return this.#commitModelCorrectionInitialPrepare(input, 'model-only');
    }

    /** Independent initial corrected-shadow proposal grant. A descriptor and
     * fixed budget are metadata, never a reconstructed Action capability. */
    commitModelCorrectionProposalPrepare(input: unknown): Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }> {
        return this.#commitModelCorrectionInitialPrepare(input, 'proposal');
    }

    #commitModelCorrectionInitialPrepare(
        input: unknown,
        kind: 'model-only' | 'proposal',
    ): Readonly<{ record: AgentLoopTaskRecord; policy: AgentLoopModelCorrectionPolicy }> {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'prepared']);
        for (const key of Reflect.ownKeys(value)) {
            const field = Object.getOwnPropertyDescriptor(value, key);
            if (!field?.enumerable || !Object.hasOwn(field, 'value')) reject('agent-loop-projection-input-invalid');
        }
        const taskId = token(value.taskId),
            ownerId = token(value.ownerId);
        if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== 1)
            reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const beforeTime = timestamp(this.#now()),
                initial = this.#requireRecord(taskId);
            if (this.#dagBound(taskId)) reject('agent-loop-projection-input-invalid');
            const grant = actionValue(
                () =>
                    kind === 'model-only'
                        ? consumeAgentLoopPreparedModelCorrection(value.prepared, initial, ownerId, this)
                        : consumeAgentLoopPreparedModelCorrectionProposal(value.prepared, initial, ownerId, this),
                undefined,
            );
            const actions = kind === 'proposal' ? 1 : 0,
                granted = grant.budget.granted;
            if (
                granted.modelCalls !== 2 ||
                granted.toolCalls !== actions ||
                granted.writes !== actions ||
                granted.highRiskActions !== 0 ||
                granted.childTasks !== 0 ||
                [grant.budget.reserved, grant.budget.spent].some((vector) => Object.values(vector).some((n) => n !== 0))
            )
                reject('agent-loop-projection-input-invalid');
            const artifactRef =
                kind === 'proposal' && 'artifactRef' in grant
                    ? normalizeAgentLoopArtifactRefDescriptor(grant.artifactRef)
                    : undefined;
            if (kind === 'proposal' && !artifactRef) reject('agent-loop-projection-input-invalid');
            const snapshot = (record: AgentLoopTaskRecord) =>
                hash({ row: this.#row(taskId), tail: this.#correctionSnapshot(record) });
            const authorize = () => {
                // The source port may read the external Manager/Session, not
                // mutate this connection (including an unrelated row or SQL
                // sequence which would not appear in the task-tail snapshot).
                const changes = this.#db.prepare('SELECT total_changes() n').get()!.n;
                this.#correctionAuthorize(grant.authorizeCommit);
                if (this.#db.prepare('SELECT total_changes() n').get()!.n !== changes)
                    reject('agent-loop-projection-revision-conflict');
            };
            const inspect = (now: string) => {
                const current = this.#requireRecord(taskId),
                    task = current.envelope,
                    row = this.#row(taskId)!;
                this.#requireLease(current, ownerId, now);
                if (
                    current.revision !== value.expectedRevision ||
                    current.envelopeDigest !== grant.initialEnvelopeDigest ||
                    grant.taskId !== taskId ||
                    grant.ownerId !== ownerId ||
                    grant.expectedRevision !== current.revision ||
                    current.envelopeDigest !== hash(task) ||
                    task.updatedAt > now ||
                    now >= grant.deadlineAt ||
                    row.root_task_id !== task.rootTaskId ||
                    row.state !== task.state ||
                    row.phase !== task.phase ||
                    task.updatedAt !== task.createdAt ||
                    row.updated_at !== row.created_at ||
                    timestamp(row.created_at) < task.createdAt ||
                    String(row.created_at) > now ||
                    task.state !== 'CREATED' ||
                    task.phase !== 'PREPARE' ||
                    task.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF ||
                    task.currentAttemptId !== undefined ||
                    task.plan !== undefined ||
                    task.wait !== undefined ||
                    task.completion !== undefined ||
                    task.rootTaskId !== taskId ||
                    task.parentTaskId !== undefined ||
                    task.dependencyTaskIds.length !== 0 ||
                    task.todos.length !== 0 ||
                    task.confirmedFacts.length !== 0 ||
                    task.blockers.length !== 0 ||
                    task.children.length !== 0 ||
                    task.artifacts.length !== 0 ||
                    [task.budget.granted, task.budget.reserved, task.budget.spent].some((vector) =>
                        Object.values(vector).some((n) => n !== 0),
                    )
                )
                    reject('agent-loop-projection-input-invalid');
                const events = this.#db
                    .prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq')
                    .all(taskId) as SqlRow[];
                const outbox = this.#db
                    .prepare('SELECT * FROM agent_loop_outbox WHERE task_id=?')
                    .all(taskId) as SqlRow[];
                const created = events[0];
                if (
                    events.length !== 1 ||
                    !created ||
                    outbox.length !== 1 ||
                    created.kind !== 'task-created' ||
                    Number(created.revision) !== 1 ||
                    created.accepted_at !== row.created_at ||
                    created.event_digest !==
                        eventDigest({
                            taskId,
                            revision: 1,
                            eventId: String(created.event_id),
                            kind: 'task-created',
                            reasonCode: created.reason_code === null ? null : String(created.reason_code),
                            envelopeDigest: current.envelopeDigest,
                        }) ||
                    [
                        'agent_loop_observation',
                        'agent_loop_observation_quarantine',
                        'agent_loop_artifact_ref',
                        'agent_loop_action_receipt',
                        'agent_loop_completion_candidate',
                        'agent_loop_completion_verification',
                    ].some((table) => this.#db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(taskId))
                )
                    reject('agent-loop-projection-input-invalid');
                timestamp(created.accepted_at);
                this.#correctionEventOutbox(created);
                return current;
            };
            const before = inspect(beforeTime),
                initialTail = snapshot(before);
            authorize();
            const now = timestamp(this.#now()),
                fresh = inspect(now);
            if (now < beforeTime || snapshot(fresh) !== initialTail) reject('agent-loop-projection-revision-conflict');
            const envelope = normalizeAgentLoopTaskEnvelope({
                ...fresh.envelope,
                taskContractRef: AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF,
                state: 'RUNNING',
                phase: 'MODEL',
                currentAttemptId: grant.attemptId,
                budget: grant.budget,
                artifacts: [grant.artifact],
                revision: 2,
                updatedAt: now,
            });
            const envelopeDigest = hash(envelope);
            const policy = actionValue(
                () =>
                    createAgentLoopModelCorrectionPolicy({
                        record: { ...fresh, envelope, revision: envelope.revision, envelopeDigest },
                        deadlineAt: grant.deadlineAt,
                        requiredBudget: grant.requiredBudget,
                    }),
                undefined,
            );
            if (Date.parse(policy.deadlineAt) > Date.parse(now) + envelope.budget.granted.wallMs)
                reject('agent-loop-projection-input-invalid');
            const changed = this.#db
                .prepare(
                    'UPDATE agent_loop_task SET state=?,phase=?,revision=?,envelope_json=?,envelope_digest=?,updated_at=? WHERE task_id=? AND revision=? AND fenced=0',
                )
                .run(
                    envelope.state,
                    envelope.phase,
                    envelope.revision,
                    JSON.stringify(envelope),
                    envelopeDigest,
                    now,
                    taskId,
                    fresh.revision,
                );
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
            if (artifactRef) this.#registerRefAt(this.#requireRecord(taskId), artifactRef, now);
            this.#appendEvent(
                taskId,
                envelope.revision,
                { eventId: `phase:${taskId}:1:PREPARE-MODEL`, kind: 'phase-advanced', reasonCode: null },
                envelopeDigest,
                now,
            );
            const policyDigest = agentLoopModelCorrectionPolicyDigest(policy);
            this.#appendEvent(
                taskId,
                envelope.revision,
                {
                    eventId: `model-correction-prepare:${policyDigest.slice(7)}`,
                    kind: 'model-correction-prepared',
                    reasonCode: 'correction-once',
                },
                envelopeDigest,
                now,
            );
            this.#appendEvent(
                taskId,
                envelope.revision,
                {
                    eventId: `model-correction-policy:${policyDigest.slice(7)}`,
                    kind: 'model-correction-policy-bound',
                    reasonCode: 'correction-once',
                },
                envelopeDigest,
                now,
            );
            const written = this.#requireRecord(taskId),
                expectedTail = snapshot(written);
            authorize();
            const finalTime = timestamp(this.#now()),
                record = this.#correctionLive({ taskId, ownerId, expectedRevision: 2 }, policy, finalTime);
            const finalRow = this.#row(taskId)!;
            if (
                finalTime < now ||
                snapshot(record) !== expectedTail ||
                record.envelopeDigest !== hash(record.envelope) ||
                finalRow.state !== envelope.state ||
                finalRow.phase !== envelope.phase ||
                finalRow.revision !== envelope.revision ||
                finalRow.root_task_id !== envelope.rootTaskId ||
                finalRow.updated_at !== now
            )
                reject('agent-loop-projection-revision-conflict');
            if (!this.#modelCorrectionState(record, policy, finalTime).invocationAllowed)
                reject('agent-loop-projection-input-invalid');
            return Object.freeze({ record, policy });
        });
    }

    /** First-MODEL host policy pin; no budget or invocation is granted. */
    bindModelCorrectionPolicy(input: unknown, authorizeCommit: () => unknown): AgentLoopTaskRecord {
        const value = this.#correctionInput(input, true), policy = actionValue(normalizeAgentLoopModelCorrectionPolicy, value.policy);
        if (typeof authorizeCommit !== 'function') reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const inspect = (now: string) => {
                const current = this.#correctionLive(value, policy, now);
                const deadlineCeiling = Date.parse(current.envelope.updatedAt) + current.envelope.budget.granted.wallMs;
                if (!Number.isSafeInteger(deadlineCeiling) || Date.parse(policy.deadlineAt) > deadlineCeiling) reject('agent-loop-projection-input-invalid');
                if (current.revision !== policy.initialRevision || current.envelopeDigest !== policy.initialEnvelopeDigest
                    || Object.values(current.envelope.budget.spent).some(n => n !== 0) || Object.values(current.envelope.budget.reserved).some(n => n !== 0)
                    || this.#db.prepare("SELECT 1 FROM agent_loop_task_event WHERE task_id=? AND (kind IN ('model-invocation-reserved','action-started','action-completed','action-uncertain','model-correction-policy-bound','model-correction-ready') OR event_id GLOB 'model-invocation:*' OR event_id GLOB 'model-correction-*') LIMIT 1").get(String(value.taskId))
                    || ['agent_loop_observation', 'agent_loop_observation_quarantine', 'agent_loop_action_receipt'].some(table => this.#db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(String(value.taskId)))) reject('agent-loop-projection-input-invalid');
                return current;
            };
            const beforeTime = timestamp(this.#now()), current = inspect(beforeTime), snapshot = this.#correctionSnapshot(current);
            this.#correctionAuthorize(authorizeCommit);
            const now = timestamp(this.#now()), fresh = inspect(now);
            if (now < beforeTime || snapshot !== this.#correctionSnapshot(fresh)) reject('agent-loop-projection-revision-conflict');
            this.#appendEvent(String(value.taskId), fresh.revision, { eventId: `model-correction-policy:${agentLoopModelCorrectionPolicyDigest(policy).slice(7)}`,
                kind: 'model-correction-policy-bound', reasonCode: 'correction-once' }, fresh.envelopeDigest, now);
            const written = this.#requireRecord(String(value.taskId)), expectedTail = this.#correctionSnapshot(written);
            this.#correctionAuthorize(authorizeCommit);
            const finalTime = timestamp(this.#now()), final = this.#correctionLive(value, policy, finalTime);
            if (finalTime < now || this.#correctionSnapshot(final) !== expectedTail) reject('agent-loop-projection-revision-conflict');
            if (!this.#modelCorrectionState(final, policy, finalTime).invocationAllowed) reject('agent-loop-projection-input-invalid');
            return final;
        });
    }

    /** Original policy body is mandatory after reopen; this state is not a DTO grant. */
    readModelCorrectionState(input: unknown): AgentLoopModelCorrectionState {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const branded = input !== null && typeof input === 'object' && Object.hasOwn(input, 'modelOutcome');
        // Only this read accepts the optional brand. Shared commit/advance
        // input validation retains its original exact closed field set.
        const value = this.#correctionInput(input, false, branded ? ['modelOutcome'] : []);
        const model = branded ? readAgentLoopModelOutcome(value.modelOutcome) : null;
        if (branded && (!model || model.decision !== null || model.protocolRejectionReason !== 'json-invalid'
            || model.summaryValidationRejection !== undefined)) reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const current = this.#requireRecord(String(value.taskId));
            if (current.revision !== value.expectedRevision) reject('agent-loop-projection-revision-conflict');
            const state = this.#modelCorrectionState(current, value.policy, timestamp(this.#now()));
            if (model) {
                const policy = normalizeAgentLoopModelCorrectionPolicy(value.policy), taskId = current.envelope.taskId;
                const invocationId = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: policy.initialRevision });
                const obs = model.observation;
                const observation = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE observation_id=?').get(`model-usage:${invocationId}`) as SqlRow | undefined;
                const events = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
                const coarse = events.find(event => event.event_id === `model-rejection:${invocationId}`);
                const applied = events.find(event => event.event_id === `observation:model-usage:${invocationId}`);
                if (current.envelope.taskKind !== 'maintenance.rolling_summary' || current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'MODEL'
                    || current.revision !== policy.initialRevision + 2 || obs.taskId !== taskId || obs.attemptId !== policy.attemptId
                    || obs.observedForTaskRevision !== policy.initialRevision || obs.observationId !== `model-usage:${invocationId}`
                    || obs.correlationRef !== `model-invocation:${invocationId}` || obs.sourceKind !== 'provider' || obs.completeness !== 'complete'
                    || !observation || observation.task_id !== taskId || observation.attempt_id !== policy.attemptId
                    || observation.observation_digest !== agentLoopObservationDigest(obs) || observation.payload_digest !== obs.payloadDigest
                    || Number(observation.satisfies_verification) !== 1 || !coarse || !applied || coarse.reason_code !== 'json-invalid'
                    || Number(coarse.revision) !== policy.initialRevision + 1 || Number(applied.seq) + 1 !== Number(coarse.seq)
                    || applied.reason_code !== null || coarse.accepted_at !== applied.accepted_at || coarse.accepted_at !== observation.ingested_at) reject('agent-loop-projection-input-invalid');
                // Recheck hashes even when an unrelated active/quarantined
                // history makes the ordinary state merely blocked. Readback
                // of a selected live receipt must not weaken event integrity.
                const rejectedDigest = hash(normalizeAgentLoopTaskEnvelope({ ...current.envelope, revision: policy.initialRevision + 1 }));
                for (const event of [applied, coarse]) if (event.event_digest !== eventDigest({ eventId: String(event.event_id), taskId,
                    revision: policy.initialRevision + 1, kind: String(event.kind), reasonCode: event.reason_code === null ? null : String(event.reason_code),
                    envelopeDigest: rejectedDigest })) reject('agent-loop-projection-storage-invalid');
                // Original state validation joins policy, known applied usage,
                // the initial reservation hash and every corresponding outbox.
            }
            return state;
        }, false);
    }

    /** Exact successful slot before any Action entry. Original Outcome brands
     * are live evidence; modelRecord is merely a snapshot authenticated by its
     * canonical reservation digest, never a portable permission or new grant. */
    readModelCorrectionActionLineage(input: unknown): AgentLoopModelCorrectionActionLineage {
        return this.#readModelCorrectionActionLineage(input);
    }

    #readModelCorrectionActionLineage(input: unknown, replay?: Readonly<{
        current: AgentLoopTaskRecord; events: SqlRow[]; observations: SqlRow[]; refs: SqlRow[]; outbox: SqlRow[];
    }>): AgentLoopModelCorrectionActionLineage {
        const sync = (value: unknown) => {
            if (nodeTypes.isPromise(value)) {
                void Promise.prototype.then.call(value, () => undefined, () => undefined);
                reject('agent-loop-projection-input-invalid');
            }
        };
        sync(input);
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'policy', 'modelRecord', 'modelOutcome'], ['rejectedModelOutcome']);
        for (const key of Reflect.ownKeys(value)) {
            const property = Object.getOwnPropertyDescriptor(value, key);
            if (!property?.enumerable || !Object.hasOwn(property, 'value')) reject('agent-loop-projection-input-invalid');
            sync(property.value);
        }
        const inert = (raw: unknown, stack = new Set<object>()): void => {
            sync(raw);
            if (raw === null || typeof raw !== 'object') {
                if (typeof raw === 'function' || typeof raw === 'symbol') reject('agent-loop-projection-input-invalid');
                return;
            }
            if (nodeTypes.isProxy(raw) || stack.has(raw) || !Array.isArray(raw)
                && ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) reject('agent-loop-projection-input-invalid');
            stack.add(raw);
            try { for (const key of Reflect.ownKeys(raw)) {
                const property = Object.getOwnPropertyDescriptor(raw, key);
                if (typeof key !== 'string' || !property || !Object.hasOwn(property, 'value')) reject('agent-loop-projection-input-invalid');
                inert(property.value, stack);
            } } finally { stack.delete(raw); }
        };
        inert(value.policy); inert(value.modelRecord);
        const taskId = token(value.taskId), ownerId = token(value.ownerId);
        if (value.expectedRevision !== 3 && value.expectedRevision !== 5) reject('agent-loop-projection-input-invalid');
        const supplied = exact(value.modelRecord, ['envelope', 'envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
        const modelEnvelope = actionValue(normalizeAgentLoopTaskEnvelope, supplied.envelope);
        const modelRecord: AgentLoopTaskRecord = Object.freeze({ envelope: modelEnvelope,
            envelopeDigest: actionValue(normalizeAgentLoopActionDigest, supplied.envelopeDigest), ownerId: token(supplied.ownerId),
            leaseExpiresAt: timestamp(supplied.leaseExpiresAt), fenced: false, fenceReason: null, revision: modelEnvelope.revision });
        if (supplied.fenced !== false || supplied.fenceReason !== null || supplied.revision !== modelEnvelope.revision
            || modelRecord.ownerId !== ownerId || modelRecord.envelopeDigest !== hash(modelEnvelope)
            || modelRecord.leaseExpiresAt! <= modelEnvelope.updatedAt || modelEnvelope.taskId !== taskId
            || modelEnvelope.state !== 'RUNNING' || modelEnvelope.phase !== 'MODEL'
            || modelEnvelope.revision !== 2 && modelEnvelope.revision !== 4) reject('agent-loop-projection-input-invalid');
        const model = readAgentLoopModelOutcome(value.modelOutcome);
        if (!model || model.protocolRejectionReason !== undefined || model.decision === null) reject('agent-loop-projection-input-invalid');
        inert(model.decision);
        const decision = actionValue(normalizeAgentLoopDecision, model.decision);
        const inspect = () => {
            const now = timestamp(this.#now()), current = replay?.current ?? this.#requireRecord(taskId);
            this.#requireLease(current, ownerId, now);
            const policy = this.#boundModelCorrectionPolicy(current, value.policy), envelope = current.envelope;
            if (current.revision !== value.expectedRevision || current.revision !== modelRecord.revision + 1
                || envelope.state !== 'RUNNING' || envelope.phase !== 'ACT' || current.envelopeDigest !== hash(envelope)
                || envelope.updatedAt > now || now >= policy.deadlineAt || policy.initialRevision !== 2
                || modelEnvelope.updatedAt > envelope.updatedAt || envelope.wait !== undefined || envelope.completion !== undefined
                || decision.kind !== 'act' || decision.actionContractRef !== 'action.maintenance.propose_rolling_summary.v1'
                || decision.taskId !== taskId || decision.attemptId !== policy.attemptId
                || decision.taskContractRef !== envelope.taskContractRef || decision.expectedTaskRevision !== modelRecord.revision
                || decision.harnessRunId !== taskId.slice('agentloop.maintenance.'.length)) reject('agent-loop-projection-input-invalid');
            this.#assertCorrectionFrame(policy, modelRecord);
            const granted = envelope.budget.granted;
            if (granted.modelCalls !== 2 || granted.toolCalls !== 1 || granted.writes !== 1
                || granted.highRiskActions !== 0 || granted.childTasks !== 0
                || [envelope.budget.reserved, modelEnvelope.budget.reserved].some(vector => Object.values(vector).some(n => n !== 0))
                || !replay && ['agent_loop_action_receipt', 'agent_loop_observation_quarantine', 'agent_loop_completion_candidate', 'agent_loop_completion_verification']
                    .some(table => this.#db.prepare(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(taskId))) reject('agent-loop-projection-input-invalid');
            const events = replay?.events ?? this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
            this.#summaryValidationEvents(current, events);
            const observations = replay?.observations ?? this.#db.prepare('SELECT * FROM agent_loop_observation WHERE task_id=? ORDER BY applied_revision').all(taskId) as SqlRow[];
            const refs = replay?.refs ?? this.#db.prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=?').all(taskId) as SqlRow[];
            const outbox = replay?.outbox ?? this.#db.prepare('SELECT * FROM agent_loop_outbox WHERE task_id=?').all(taskId) as SqlRow[];
            const corrected = modelRecord.revision === 4, used = corrected ? 2 : 1;
            if (refs.length !== 1 || observations.length !== used || outbox.length !== events.length
                || Object.hasOwn(value, 'rejectedModelOutcome') !== corrected) reject('agent-loop-projection-input-invalid');
            const initialPhase = events.find(event => event.event_id === `phase:${taskId}:1:PREPARE-MODEL`);
            if (!initialPhase) reject('agent-loop-projection-storage-invalid');
            const zero = Object.fromEntries(Object.keys(granted).map(key => [key, 0])) as unknown as typeof granted;
            const initial = normalizeAgentLoopTaskEnvelope({ ...modelEnvelope, revision: 2, updatedAt: timestamp(initialPhase.accepted_at),
                budget: { ...modelEnvelope.budget, spent: zero } });
            if (hash(initial) !== policy.initialEnvelopeDigest) reject('agent-loop-projection-input-invalid');
            // This narrow initial brand accepts only the original Maintenance
            // registration, not an arbitrary generic-engine birth contract.
            const birth = normalizeAgentLoopTaskEnvelope({ ...initial, taskContractRef: 'contract.maintenance.v1',
                state: 'CREATED', phase: 'PREPARE', revision: 1, updatedAt: initial.createdAt, currentAttemptId: undefined,
                artifacts: [], budget: { ...initial.budget, granted: zero } });
            const initialId = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: 2 });
            const invocationId = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: modelRecord.revision });
            const policyDigest = agentLoopModelCorrectionPolicyDigest(policy), binding = envelope.artifacts.find(item => item.kind === 'agent-loop-execution-binding')!;
            const eventSpecs: Array<{ id: string; kind: string; revision: number; reason: string | null; digest: string }> = [
                { id: String(events[0]?.event_id), kind: 'task-created', revision: 1, reason: events[0]?.reason_code === null ? null : String(events[0]?.reason_code), digest: '' },
                { id: `ref-registered:${binding.artifactRef}`, kind: 'ref-registered', revision: 2, reason: null, digest: '' },
                { id: `phase:${taskId}:1:PREPARE-MODEL`, kind: 'phase-advanced', revision: 2, reason: null, digest: '' },
                { id: `model-correction-prepare:${policyDigest.slice(7)}`, kind: 'model-correction-prepared', revision: 2, reason: 'correction-once', digest: '' },
                { id: `model-correction-policy:${policyDigest.slice(7)}`, kind: 'model-correction-policy-bound', revision: 2, reason: 'correction-once', digest: '' },
                { id: `model-invocation:${initialId}`, kind: 'model-invocation-reserved', revision: 2, reason: null, digest: '' },
            ];
            const created = eventSpecs[0]!;
            created.digest = eventDigest({ taskId, eventId: created.id, kind: created.kind, revision: 1,
                reasonCode: created.reason, envelopeDigest: hash(birth) });
            if (events[0]?.accepted_at !== this.#row(taskId)!.created_at || String(events[0]?.accepted_at) < birth.createdAt) reject('agent-loop-projection-storage-invalid');
            const spec = (id: string, kind: string, revision: number, reason: string | null, candidate: AgentLoopTaskEnvelopeV1) => {
                eventSpecs.push({ id, kind, revision, reason, digest: eventDigest({ taskId, eventId: id, kind, revision, reasonCode: reason, envelopeDigest: hash(candidate) }) });
            };
            for (const entry of eventSpecs.slice(1)) entry.digest = eventDigest({ taskId, eventId: entry.id, kind: entry.kind,
                revision: entry.revision, reasonCode: entry.reason, envelopeDigest: policy.initialEnvelopeDigest });
            const observation = (outcome: NonNullable<ReturnType<typeof readAgentLoopModelOutcome>>, before: AgentLoopTaskEnvelopeV1) => {
                const obs = outcome.observation, usage = obs.usageDelta;
                const id = agentLoopModelInvocationId({ taskId, attemptId: policy.attemptId, expectedTaskRevision: before.revision });
                if (obs.taskId !== taskId || obs.attemptId !== policy.attemptId || obs.observedForTaskRevision !== before.revision
                    || obs.observationId !== `model-usage:${id}` || obs.correlationRef !== `model-invocation:${id}`
                    || obs.sourceKind !== 'provider' || obs.completeness !== 'complete' || !usage || usage.modelCalls !== 1
                    || usage.toolCalls !== 0 || usage.writes !== 0 || usage.highRiskActions !== 0
                    || usage.inputTokens <= 0 || usage.outputTokens <= 0 || obs.observedAt > obs.ingestedAt) reject('agent-loop-projection-input-invalid');
                const reduction = reduceAgentLoopObservation({ envelope: before, observation: obs });
                if (reduction.classification !== 'applied' || !reduction.envelope || !reduction.satisfiesVerification
                    || reduction.reasonCodes.length !== 0) reject('agent-loop-projection-input-invalid');
                const row = observations.find(row => row.observation_id === obs.observationId);
                const event = events.find(row => row.event_id === `observation:${obs.observationId}`);
                if (!row || !event || row.task_id !== taskId || row.attempt_id !== policy.attemptId
                    || Number(row.observed_for_revision) !== before.revision || Number(row.applied_revision) !== before.revision + 1
                    || row.source_kind !== obs.sourceKind || row.completeness !== obs.completeness || row.payload_digest !== obs.payloadDigest
                    || row.observation_digest !== agentLoopObservationDigest(obs) || row.classification !== 'applied'
                    || Number(row.satisfies_verification) !== 1 || row.reason_codes_json !== JSON.stringify(reduction.reasonCodes)
                    || row.observed_at !== obs.observedAt || timestamp(row.ingested_at) !== event.accepted_at
                    || String(row.ingested_at) < obs.ingestedAt || String(row.ingested_at) > now) reject('agent-loop-projection-storage-invalid');
                return reduction.envelope;
            };
            if (corrected) {
                const refused = readAgentLoopModelOutcome(value.rejectedModelOutcome);
                if (!refused || refused.decision !== null || !isAgentLoopModelProtocolRejectionReason(refused.protocolRejectionReason)) reject('agent-loop-projection-input-invalid');
                const rejected = observation(refused, initial);
                const ready = normalizeAgentLoopTaskEnvelope({ ...rejected, revision: 4 });
                if (JSON.stringify(ready) !== JSON.stringify(modelEnvelope)) reject('agent-loop-projection-input-invalid');
                spec(`observation:model-usage:${initialId}`, 'observation-applied', 3, null, rejected);
                spec(`model-rejection:${initialId}`, 'model-protocol-rejected', 3, refused.protocolRejectionReason, rejected);
                if (refused.summaryValidationRejection) spec(`${SUMMARY_VALIDATION_PREFIX}${initialId.slice(7)}:${hash(rejected).slice(7)}`,
                    SUMMARY_VALIDATION_EVENT, 3, refused.summaryValidationRejection.code, rejected);
                spec(`model-correction-ready:${initialId.slice(7)}`, 'model-correction-ready', 4, 'correction-once', ready);
                spec(`model-invocation:${invocationId}`, 'model-invocation-reserved', 4, null, ready);
            } else if (JSON.stringify(initial) !== JSON.stringify(modelEnvelope)) reject('agent-loop-projection-input-invalid');
            const reduced = observation(model, modelEnvelope);
            if (envelope.updatedAt < reduced.updatedAt) reject('agent-loop-projection-input-invalid');
            const actual = normalizeAgentLoopTaskEnvelope({ ...reduced, phase: 'ACT', updatedAt: envelope.updatedAt });
            if (JSON.stringify(actual) !== JSON.stringify(envelope) || envelope.budget.spent.modelCalls !== used) reject('agent-loop-projection-input-invalid');
            spec(`observation:model-usage:${invocationId}`, 'observation-applied', current.revision, null, envelope);
            spec(`phase:${taskId}:${modelRecord.revision}:MODEL-ACT`, 'phase-advanced', current.revision, 'act', envelope);
            const decisionDigest = hash(decision);
            spec(`model-decision:${invocationId.slice(7)}:${decisionDigest.slice(7)}`, 'model-decision-bound', current.revision, 'act', envelope);
            if (events.length !== eventSpecs.length) reject('agent-loop-projection-storage-invalid');
            for (let i = 0; i < eventSpecs.length; i++) {
                const expected = eventSpecs[i]!, row = events[i]!;
                if (row.event_id !== expected.id || row.kind !== expected.kind || Number(row.revision) !== expected.revision
                    || row.reason_code !== expected.reason || row.event_digest !== expected.digest
                    || timestamp(row.accepted_at) > now || i > 0 && String(row.accepted_at) < String(events[i - 1]!.accepted_at)) reject('agent-loop-projection-storage-invalid');
                this.#correctionEventOutbox(row);
            }
            const decisionEvent = events.at(-1)!, success = events.at(-2)!, successObs = events.at(-3)!;
            if (success.accepted_at !== successObs.accepted_at || Number(successObs.seq) + 1 !== Number(success.seq)
                || decisionEvent.accepted_at !== success.accepted_at || Number(success.seq) + 1 !== Number(decisionEvent.seq)
                || envelope.updatedAt > String(success.accepted_at)) reject('agent-loop-projection-storage-invalid');
            if (corrected && (events[6]!.accepted_at !== events[7]!.accepted_at || Number(events[6]!.seq) + 1 !== Number(events[7]!.seq))) reject('agent-loop-projection-storage-invalid');
            // Exact original Coordinator identity bytes; no reader dispatches it.
            const actionId = hash({ kind: 'agent-loop-action-id-v1', taskId, attemptId: policy.attemptId,
                expectedTaskRevision: current.revision, decisionDigest });
            return Object.freeze({ version: 'agent-loop-model-correction-action-lineage-v1' as const, taskId,
                taskRevision: current.revision, envelopeDigest: current.envelopeDigest, policyDigest,
                modelRevision: modelRecord.revision as 2 | 4, modelCallsUsed: used as 1 | 2, invocationId,
                decisionDigest, actionId, snapshotDigest: this.#correctionSnapshot(current) });
        };
        // The private replay is called only inside the post-Action reader's
        // existing read transaction. The public pre-ACT boundary stays exact.
        return replay ? inspect() : this.#transaction(inspect, false);
    }

    /** Exact live post-Action join. The original immutable snapshots carry
     * clocks not recoverable from SQL acceptance timestamps. Neither snapshot
     * nor this readback mints completion, execution or recovery authority. */
    readModelCorrectionCompletionLineage(input: unknown): AgentLoopModelCorrectionCompletionLineage {
        const inert = (raw: unknown, stack = new Set<object>()): void => {
            if (nodeTypes.isPromise(raw)) {
                void Promise.prototype.then.call(raw, () => undefined, () => undefined);
                reject('agent-loop-projection-input-invalid');
            }
            if (raw === null || typeof raw !== 'object') {
                if (typeof raw === 'function' || typeof raw === 'symbol') reject('agent-loop-projection-input-invalid');
                return;
            }
            if (nodeTypes.isProxy(raw) || stack.has(raw) || !Array.isArray(raw)
                && ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) reject('agent-loop-projection-input-invalid');
            stack.add(raw);
            try { for (const key of Reflect.ownKeys(raw)) {
                const field = Object.getOwnPropertyDescriptor(raw, key);
                if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) reject('agent-loop-projection-input-invalid');
                inert(field.value, stack);
            } } finally { stack.delete(raw); }
        };
        inert(input);
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'policy', 'modelRecord', 'modelOutcome',
            'actionRecord', 'observeRecord', 'actionOutcome'], ['rejectedModelOutcome']);
        for (const key of Reflect.ownKeys(value)) if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) reject('agent-loop-projection-input-invalid');
        // Pin once, before any clock port can mutate caller-owned metadata.
        // Re-reading a raw policy at the final clock would refresh its deadline.
        const policy = actionValue(normalizeAgentLoopModelCorrectionPolicy, value.policy);
        const taskId = token(value.taskId), ownerId = token(value.ownerId);
        const recordData = (raw: unknown, phase: 'ACT' | 'OBSERVE'): AgentLoopTaskRecord => {
            const supplied = exact(raw, ['envelope', 'envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision']);
            const envelope = actionValue(normalizeAgentLoopTaskEnvelope, supplied.envelope);
            const record: AgentLoopTaskRecord = { envelope, envelopeDigest: actionValue(normalizeAgentLoopActionDigest, supplied.envelopeDigest),
                ownerId: token(supplied.ownerId), leaseExpiresAt: timestamp(supplied.leaseExpiresAt), fenced: false, fenceReason: null, revision: envelope.revision };
            if (supplied.fenced !== false || supplied.fenceReason !== null || supplied.revision !== envelope.revision
                || record.envelopeDigest !== hash(envelope) || record.ownerId !== ownerId || record.leaseExpiresAt! <= envelope.updatedAt
                || envelope.taskId !== taskId || envelope.state !== 'RUNNING' || envelope.phase !== phase
                || envelope.wait !== undefined || envelope.completion !== undefined) reject('agent-loop-projection-input-invalid');
            return record;
        };
        const actionRecord = recordData(value.actionRecord, 'ACT'), observeRecord = recordData(value.observeRecord, 'OBSERVE');
        const action = readAgentLoopActionOutcome(value.actionOutcome);
        if (!action || !action.artifactBundle || action.observation.completeness !== 'complete'
            || action.observation.sourceKind !== 'tool') reject('agent-loop-projection-input-invalid');
        const obs = action.observation, bundle = action.artifactBundle;
        return this.#transaction(() => {
            const now = timestamp(this.#now()), current = this.#requireRecord(taskId);
            this.#requireLease(current, ownerId, now);
            const actionRevision = actionRecord.revision, observeRevision = observeRecord.revision;
            if (actionRevision !== 3 && actionRevision !== 5 || observeRevision !== actionRevision + 2
                || current.revision !== value.expectedRevision || current.envelope.updatedAt > now
                || current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'OBSERVE' && current.envelope.phase !== 'VERIFY'
                || current.revision !== observeRevision + (current.envelope.phase === 'VERIFY' ? 1 : 0)
                || current.envelopeDigest !== hash(current.envelope)
                || this.#db.prepare('SELECT 1 FROM agent_loop_observation_quarantine WHERE task_id=? LIMIT 1').get(taskId)) reject('agent-loop-projection-input-invalid');
            const events = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(taskId) as SqlRow[];
            const observations = this.#db.prepare('SELECT * FROM agent_loop_observation WHERE task_id=? ORDER BY applied_revision').all(taskId) as SqlRow[];
            const refs = this.#db.prepare('SELECT * FROM agent_loop_artifact_ref WHERE task_id=? ORDER BY ref_id').all(taskId) as SqlRow[];
            const outbox = this.#db.prepare('SELECT * FROM agent_loop_outbox WHERE task_id=?').all(taskId) as SqlRow[];
            const startIndex = events.findIndex(row => row.kind === 'action-started');
            if (startIndex < 0 || refs.length !== 2 || outbox.length !== events.length) reject('agent-loop-projection-storage-invalid');
            const prefix = events.slice(0, startIndex), prefixIds = new Set(prefix.map(row => row.event_id));
            const lineage = this.#readModelCorrectionActionLineage({ taskId, expectedRevision: actionRevision, ownerId,
                policy, modelRecord: value.modelRecord, modelOutcome: value.modelOutcome,
                ...(Object.hasOwn(value, 'rejectedModelOutcome') ? { rejectedModelOutcome: value.rejectedModelOutcome } : {}) }, {
                current: { ...actionRecord, ownerId: current.ownerId, leaseExpiresAt: current.leaseExpiresAt }, events: prefix,
                observations: observations.filter(row => row.source_kind === 'provider'),
                refs: refs.filter(row => row.kind === 'session-artifact'), outbox: outbox.filter(row => prefixIds.has(row.event_id)),
            });
            const actionId = lineage.actionId, receipt = this.#readAction(actionId), result = receipt?.result;
            const receipts = this.#db.prepare('SELECT action_id FROM agent_loop_action_receipt WHERE task_id=?').all(taskId);
            if (receipts.length !== 1 || receipts[0]!.action_id !== actionId
                || !receipt || !result || receipt.status !== 'observed' || receipt.actionContractRef !== 'action.maintenance.propose_rolling_summary.v1'
                || receipt.taskId !== taskId || receipt.ownerId !== ownerId || receipt.attemptId !== actionRecord.envelope.currentAttemptId
                || receipt.expectedRevision !== actionRevision || receipt.appliedRevision !== actionRevision + 1
                || !receipt.startedAt || !receipt.completedAt || !receipt.settledAt || !receipt.observedAt || receipt.releasedAt !== undefined
                || receipt.receiptRef !== `receipt:${actionId}` || receipt.observationId !== `obs:${actionId}`
                || obs.observationId !== receipt.observationId || obs.causalActionId !== actionId || obs.correlationRef !== undefined
                || obs.taskId !== taskId || obs.attemptId !== receipt.attemptId || obs.observedForTaskRevision !== actionRevision
                || obs.payloadRef !== undefined || obs.sourceRef !== `maintenance.proposal:${taskId.slice('agentloop.maintenance.'.length)}`
                || obs.observedAt < actionRecord.envelope.updatedAt || obs.observedAt > receipt.startedAt
                || obs.ingestedAt < receipt.settledAt || obs.ingestedAt > receipt.observedAt
                || JSON.stringify(normalizeAgentLoopActionResult({ sourceKind: obs.sourceKind, sourceRef: obs.sourceRef,
                    payloadDigest: obs.payloadDigest, completeness: obs.completeness, evidenceRefs: obs.evidenceRefs, usage: obs.usageDelta }, receipt.actionContractRef)) !== JSON.stringify(result)
                || result.usage.toolCalls !== 1 || result.usage.writes !== 1 || result.evidenceRefs.length !== 5) reject('agent-loop-projection-storage-invalid');
            const decision = actionValue(normalizeAgentLoopDecision, readAgentLoopModelOutcome(value.modelOutcome)!.decision);
            if (decision.kind !== 'act' || receipt.actionDigest !== hash({ kind: 'agent-loop-action-digest-v1', actionId, taskId, attemptId: receipt.attemptId,
                expectedTaskRevision: actionRevision, actionContractRef: receipt.actionContractRef, args: decision.args })) reject('agent-loop-projection-storage-invalid');
            const reduced = reduceAgentLoopObservation({ envelope: actionRecord.envelope, observation: obs });
            if (reduced.classification !== 'applied' || !reduced.envelope || !reduced.satisfiesVerification || reduced.reasonCodes.length !== 0) reject('agent-loop-projection-storage-invalid');
            const applied = reduced.envelope;
            const expectedObserve = normalizeAgentLoopTaskEnvelope({ ...applied, phase: 'OBSERVE', revision: observeRevision,
                updatedAt: observeRecord.envelope.updatedAt, artifacts: [...applied.artifacts, bundle.artifact] });
            if (observeRecord.envelope.updatedAt < applied.updatedAt || JSON.stringify(expectedObserve) !== JSON.stringify(observeRecord.envelope)
                || JSON.stringify(normalizeAgentLoopTaskEnvelope({ ...observeRecord.envelope, phase: current.envelope.phase,
                    revision: current.revision, updatedAt: current.envelope.updatedAt })) !== JSON.stringify(current.envelope)
                || current.envelope.updatedAt < observeRecord.envelope.updatedAt) reject('agent-loop-projection-storage-invalid');
            const storedObs = observations.filter(row => row.observation_id === obs.observationId);
            if (observations.length !== lineage.modelCallsUsed + 1 || storedObs.length !== 1) reject('agent-loop-projection-storage-invalid');
            const row = storedObs[0]!;
            if (row.task_id !== taskId || row.attempt_id !== obs.attemptId || row.observed_for_revision !== actionRevision
                || row.source_kind !== 'tool' || row.completeness !== 'complete' || row.payload_digest !== obs.payloadDigest
                || row.observation_digest !== agentLoopObservationDigest(obs) || row.classification !== 'applied'
                || row.satisfies_verification !== 1 || row.applied_revision !== applied.revision || row.reason_codes_json !== '[]'
                || row.observed_at !== obs.observedAt || row.ingested_at !== receipt.observedAt) reject('agent-loop-projection-storage-invalid');
            const descriptor = bundle.descriptor, found = refs.filter(row => row.ref_id === descriptor.refId);
            if (found.length !== 1 || JSON.stringify(this.#refRecord(found[0]!)) !== JSON.stringify({ ...descriptor,
                taskRevision: observeRevision, registeredAt: found[0]!.registered_at })) reject('agent-loop-projection-storage-invalid');
            const suffix = events.slice(startIndex), specs: Array<{ id: string; kind: string; r: number; why: string | null; env: AgentLoopTaskEnvelopeV1; at?: string }> = [];
            const spec = (id: string, kind: string, r: number, why: string | null, env: AgentLoopTaskEnvelopeV1, at?: string) => specs.push({ id, kind, r, why, env, at });
            spec(`action-started:${actionId}`, 'action-started', actionRevision, 'act', actionRecord.envelope);
            const receiptKey = hash(actionId).slice(7);
            for (const [stage, time] of [['reserved', receipt.createdAt], ['started', receipt.startedAt], ['completed', receipt.completedAt], ['settled', receipt.settledAt]] as const)
                spec(`action-receipt:${receiptKey}:${stage}`, `action-receipt-${stage}`, actionRevision, null, actionRecord.envelope, time);
            spec(`observation:${obs.observationId}`, 'observation-applied', applied.revision, null, applied, receipt.observedAt);
            spec(`action-receipt:${receiptKey}:observed`, 'action-receipt-observed', applied.revision, null, applied, receipt.observedAt);
            spec(`action-completed:${actionId}`, 'action-completed', applied.revision, 'act', applied);
            spec(`ref-registered:${descriptor.refId}`, 'ref-registered', observeRevision, null, observeRecord.envelope, String(found[0]!.registered_at));
            spec(`phase:${taskId}:${applied.revision}:ACT-OBSERVE`, 'phase-advanced', observeRevision, 'act', observeRecord.envelope, String(found[0]!.registered_at));
            if (current.envelope.phase === 'VERIFY') {
                const request = hash({ taskId, attemptId: current.envelope.currentAttemptId, revision: observeRevision, actionWatermark: `action-completed:${actionId}` });
                spec(`completion-requested:${request.slice(7)}`, 'completion-requested', current.revision, 'request_complete', current.envelope, current.envelope.updatedAt);
            }
            const audits = new Map<string, { kind: string; at: string }>();
            const candidates = this.#db.prepare('SELECT * FROM agent_loop_completion_candidate WHERE task_id=?').all(taskId) as SqlRow[];
            const verifications = this.#db.prepare('SELECT * FROM agent_loop_completion_verification WHERE task_id=?').all(taskId) as SqlRow[];
            if (current.envelope.phase !== 'VERIFY' && (candidates.length || verifications.length) || candidates.length > 1) reject('agent-loop-projection-storage-invalid');
            for (const candidateRow of candidates) {
                const candidate = this.#completionCandidateRecord(candidateRow)!;
                this.#currentCompletionCandidate(current, candidate.candidateRef, now);
                audits.set(`completion-candidate-frozen:${candidate.snapshotDigest.slice(7)}`, { kind: 'completion-candidate-frozen', at: candidate.createdAt });
            }
            for (const verificationRow of verifications) {
                const verification = this.#completionVerificationRecord(verificationRow)!;
                if (verification.taskRevision !== current.revision || !candidates.some(row => row.candidate_ref === verification.candidateRef)) reject('agent-loop-projection-storage-invalid');
                audits.set(`completion-verification-recorded:${verification.verificationDigest.slice(7)}`, { kind: 'completion-verification-recorded', at: verification.verifiedAt });
            }
            if (suffix.length !== specs.length + audits.size) reject('agent-loop-projection-storage-invalid');
            for (const [index, event] of suffix.entries()) {
                const expected = specs[index], audit = audits.get(String(event.event_id));
                const id = expected?.id ?? String(event.event_id), kind = expected?.kind ?? audit?.kind;
                const revision = expected?.r ?? current.revision, reason = expected?.why ?? null, envelope = expected?.env ?? current.envelope;
                const time = expected?.at ?? audit?.at;
                if (!kind || event.event_id !== id || event.kind !== kind || event.revision !== revision || event.reason_code !== reason
                    || event.event_digest !== eventDigest({ taskId, eventId: id, revision, kind, reasonCode: reason, envelopeDigest: hash(envelope) })
                    || timestamp(event.accepted_at) > now || time !== undefined && event.accepted_at !== time
                    || String(event.accepted_at) < String(events[startIndex + index - 1]!.accepted_at)) reject('agent-loop-projection-storage-invalid');
                this.#correctionEventOutbox(event);
            }
            if (Number(suffix[5]!.seq) + 1 !== Number(suffix[6]!.seq) || Number(suffix[8]!.seq) + 1 !== Number(suffix[9]!.seq)
                || observeRecord.envelope.updatedAt > String(suffix[9]!.accepted_at)) reject('agent-loop-projection-storage-invalid');
            const finalNow = timestamp(this.#now()), finalRecord = this.#requireRecord(taskId);
            this.#requireLease(finalRecord, ownerId, finalNow);
            if (finalNow < now || finalNow >= policy.deadlineAt
                || finalRecord.revision !== current.revision || finalRecord.envelopeDigest !== current.envelopeDigest) reject('agent-loop-projection-input-invalid');
            return Object.freeze({ version: 'agent-loop-model-correction-completion-lineage-v1' as const, taskId,
                taskRevision: current.revision, envelopeDigest: current.envelopeDigest, policyDigest: lineage.policyDigest,
                actionId, actionRevision: actionRevision as 3 | 5, modelCallsUsed: lineage.modelCallsUsed, observeRevision: observeRevision as 5 | 7,
                decisionDigest: lineage.decisionDigest, actionDigest: receipt.actionDigest, actionWatermark: `action-completed:${actionId}`,
                observationId: obs.observationId, preparationDigest: obs.payloadDigest,
                bindingRef: actionRecord.envelope.artifacts[0]!.artifactRef, proposalRef: descriptor.refId,
                snapshotDigest: this.#correctionSnapshot(current) });
        }, false);
    }

    /** Consume one known protocol stop. Same MODEL, same attempt and every
     * budget byte; only revision/event/outbox advance. It never calls a Model. */
    commitModelCorrection(input: unknown, authorizeCommit: () => unknown): AgentLoopTaskRecord {
        const value = this.#correctionInput(input, true, ['expectedSnapshotDigest']);
        const policy = actionValue(normalizeAgentLoopModelCorrectionPolicy, value.policy), expectedSnapshot = actionValue(normalizeAgentLoopActionDigest, value.expectedSnapshotDigest);
        if (typeof authorizeCommit !== 'function') reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const inspect = (now: string) => {
                const current = this.#correctionLive(value, policy, now), state = this.#modelCorrectionState(current, policy, now);
                if (state.status !== 'rejected' || state.correctionsUsed !== 0 || state.snapshotDigest !== expectedSnapshot
                    || state.reasonCodes[0] !== 'correction-rejected') reject('agent-loop-projection-input-invalid');
                return { current, state };
            };
            const beforeTime = timestamp(this.#now()), before = inspect(beforeTime);
            this.#correctionAuthorize(authorizeCommit);
            const now = timestamp(this.#now()), fresh = inspect(now);
            if (now < beforeTime || fresh.state.snapshotDigest !== before.state.snapshotDigest) reject('agent-loop-projection-revision-conflict');
            const envelope = normalizeAgentLoopTaskEnvelope({ ...fresh.current.envelope, revision: fresh.current.revision + 1 });
            const envelopeDigest = hash(envelope);
            const changed = this.#db.prepare('UPDATE agent_loop_task SET revision=?,envelope_json=?,envelope_digest=? WHERE task_id=? AND revision=? AND fenced=0')
                .run(envelope.revision, JSON.stringify(envelope), envelopeDigest, String(value.taskId), fresh.current.revision);
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
            const invocation = agentLoopModelInvocationId({ taskId: String(value.taskId), attemptId: policy.attemptId, expectedTaskRevision: policy.initialRevision });
            this.#appendEvent(String(value.taskId), envelope.revision, { eventId: `model-correction-ready:${invocation.slice(7)}`,
                kind: 'model-correction-ready', reasonCode: 'correction-once' }, envelopeDigest, now);
            const written = this.#requireRecord(String(value.taskId)), expectedTail = this.#correctionSnapshot(written);
            this.#correctionAuthorize(authorizeCommit);
            const finalTime = timestamp(this.#now()), result = this.#correctionLive({ ...value, expectedRevision: envelope.revision }, policy, finalTime);
            if (finalTime < now || this.#correctionSnapshot(result) !== expectedTail) reject('agent-loop-projection-revision-conflict');
            const state = this.#modelCorrectionState(result, policy, finalTime);
            if (state.status !== 'ready' || !state.invocationAllowed) reject('agent-loop-projection-input-invalid');
            return result;
        });
    }
    #repairEvents(current: AgentLoopTaskRecord): readonly AgentLoopTaskEvent[] {
        return (this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq').all(current.envelope.taskId) as SqlRow[])
            .map(row => ({ eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION, eventId: String(row.event_id), taskId: String(row.task_id),
                revision: Number(row.revision), kind: String(row.kind), eventDigest: String(row.event_digest), acceptedAt: String(row.accepted_at),
                ...(row.reason_code === null ? {} : { reasonCode: String(row.reason_code) }) }));
    }

    #repairState(current: AgentLoopTaskRecord): AgentLoopRepairState {
        try {
            const folded = foldAgentLoopRepairEvents({ taskId: current.envelope.taskId, taskRevision: current.revision, events: this.#repairEvents(current) });
            return Object.freeze({ version: 'agent-loop-repair-state-v1', taskId: current.envelope.taskId,
                taskRevision: current.revision, envelopeDigest: current.envelopeDigest, ...folded,
                snapshotDigest: agentLoopCompletionDigest(this.#completionSnapshot(current)) });
        } catch { return reject('agent-loop-projection-storage-invalid'); }
    }

    /** Read-only lifetime repair metadata. It grants no execution/lease/budget. */
    readRepairState(input: unknown): AgentLoopRepairState {
        const value = actionValue(v => normalizeAgentLoopActionObject(v, ['taskId', 'expectedRevision']), input), taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const current = this.#requireRecord(taskId);
            if (current.revision !== value.expectedRevision) reject('agent-loop-projection-revision-conflict');
            return this.#repairState(current);
        }, false);
    }

    /** Host-only mechanical repair verdict; no Model grant, attempt reset or
     * generic phase writer. Policy + task + accepted event/outbox share one TX.
     */
    commitRepairAttempt(input: unknown, authorizeCommit: () => unknown): AgentLoopRepairCommitResult {
        const scope = this.#completionScope(input, ['expectedSnapshotDigest', 'policy']);
        const expectedSnapshotDigest = actionValue(normalizeAgentLoopActionDigest, scope.value.expectedSnapshotDigest);
        const policy = actionValue(normalizeAgentLoopRepairPolicy, scope.value.policy);
        const policyDigest = agentLoopRepairPolicyBindingDigest(scope.taskId, policy);
        if (typeof authorizeCommit !== 'function' || !Number.isSafeInteger(scope.expectedRevision + 1)) reject('agent-loop-projection-input-invalid');
        return this.#transaction(() => {
            const inspect = (now: string) => {
                const current = this.#completionAuthority(scope, now), envelope = current.envelope;
                const turnPolicy = this.#turnCompletionPolicy(envelope);
                if (turnPolicy && policy.maxAttempts !== turnPolicy.maxRepairAttempts)
                    reject('agent-loop-projection-input-invalid');
                if (this.#usesModelCorrection(current)) reject('agent-loop-projection-input-invalid');
                if (envelope.state !== 'RUNNING' || envelope.updatedAt > now || policy.taskKind !== envelope.taskKind
                    || policy.taskContractRef !== envelope.taskContractRef || policy.verifierSetRef !== envelope.verifier.verifierSetRef
                    || policy.verifierSetRevision !== envelope.verifier.verifierSetRevision) reject('agent-loop-projection-input-invalid');
                const state = this.#repairState(current);
                if (state.snapshotDigest !== expectedSnapshotDigest) reject('agent-loop-projection-revision-conflict');
                if (state.policyDigest !== null && (state.policyDigest !== policyDigest || state.maxAttempts !== policy.maxAttempts)) reject('agent-loop-projection-event-conflict');
                const events = this.#repairEvents(current), byId = new Map(events.map(event => [event.eventId, event]));
                const unresolvedModel = events.some(event => {
                    if (event.kind !== 'model-invocation-reserved') return false;
                    // Exact original identity/closure algorithm; an unrecognized
                    // reservation is ambiguous, never proof that it was closed.
                    if (event.eventId !== `model-invocation:${agentLoopModelInvocationId({ taskId: scope.taskId,
                        attemptId: envelope.currentAttemptId!, expectedTaskRevision: event.revision })}`) return true;
                    const closed = (id: string, kind: string, reasons: readonly string[]) => {
                        const actual = byId.get(id);
                        return actual?.taskId === scope.taskId && actual.revision === event.revision + 1
                            && actual.kind === kind && reasons.includes(actual.reasonCode ?? '');
                    };
                    return !closed(`phase:${scope.taskId}:${event.revision}:MODEL-ACT`, 'phase-advanced', ['act', 'delegate', 'request_complete'])
                        && !closed(`wait:${scope.taskId}:${event.revision}`, 'wait-entered', ['ask_user', 'wait_event']);
                });
                const unknown = this.#activeActions(scope.taskId).length > 0 || this.#completionSnapshot(current).unknownEffectActionIds.length > 0;
                const tail = ['agent_loop_task_event', 'agent_loop_outbox', 'agent_loop_observation', 'agent_loop_observation_quarantine',
                    'agent_loop_artifact_ref', 'agent_loop_action_receipt', 'agent_loop_completion_candidate', 'agent_loop_completion_verification']
                    .map(table => this.#db.prepare(`SELECT * FROM ${table} WHERE task_id=? ORDER BY rowid`).all(scope.taskId));
                return { current, state, unknown, unresolvedModel, digest: hash({ current, state, tail }) };
            };
            const beforeTime = timestamp(this.#now()), initial = inspect(beforeTime);
            const result = (verdict: AgentLoopRepairCommitResult['verdict'], record: AgentLoopTaskRecord, state: AgentLoopRepairState, reason: string) =>
                Object.freeze({ verdict, record, state, reasonCodes: Object.freeze([reason]) });
            if (initial.unknown || initial.unresolvedModel) return result('inconclusive', initial.current, initial.state,
                initial.unknown ? 'repair-unknown-effect' : 'repair-model-unresolved');
            const authorization = authorizeCommit();
            if (authorization !== undefined) {
                if (authorization !== null && typeof authorization === 'object') {
                    try { void Promise.prototype.then.call(authorization, () => undefined, () => undefined); }
                    catch { /* Do not invoke or read a foreign then property. */ }
                }
                reject('agent-loop-projection-input-invalid');
            }
            const now = timestamp(this.#now()), fresh = inspect(now);
            if (now < beforeTime || fresh.digest !== initial.digest || fresh.unknown || fresh.unresolvedModel) reject('agent-loop-projection-event-conflict');
            const { current, state } = fresh;
            const exhausted = state.attempts >= policy.maxAttempts;
            const insufficient = Object.keys(policy.requiredBudget).some(key => {
                const k = key as keyof typeof policy.requiredBudget, used = current.envelope.budget.spent[k] + current.envelope.budget.reserved[k];
                return !Number.isSafeInteger(used) || used > current.envelope.budget.granted[k]
                    || policy.requiredBudget[k] > current.envelope.budget.granted[k] - used;
            });
            const failed = exhausted || insufficient;
            const envelope = normalizeAgentLoopTaskEnvelope({ ...current.envelope, state: failed ? 'FAILED' : 'RUNNING',
                phase: failed ? 'VERIFY' : 'PREPARE', revision: current.revision + 1, updatedAt: now });
            const envelopeDigest = hash(envelope);
            const changed = this.#db.prepare(`UPDATE agent_loop_task
                SET state=?,phase=?,revision=?,envelope_json=?,envelope_digest=?,updated_at=?
                WHERE task_id=? AND revision=? AND fenced=0`).run(envelope.state, envelope.phase, envelope.revision,
                    JSON.stringify(envelope), envelopeDigest, now, scope.taskId, current.revision);
            if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
            if (state.policyDigest === null) this.#appendEvent(scope.taskId, envelope.revision,
                { eventId: `repair-policy:${policyDigest.slice(7)}`, kind: 'repair-policy-bound', reasonCode: `repair-limit-${policy.maxAttempts}` }, envelopeDigest, now);
            this.#appendEvent(scope.taskId, envelope.revision, failed
                ? { eventId: `repair-failed:${agentLoopCompletionDigest({ taskId: scope.taskId, revision: current.revision, policyDigest }).slice(7)}`,
                    kind: 'task-failed-repair', reasonCode: exhausted ? 'repair-attempts-exhausted' : 'repair-budget-insufficient' }
                : { eventId: `phase:${scope.taskId}:${current.revision}:VERIFY-PREPARE`, kind: 'verify-repairable', reasonCode: 'verification-repairable' }, envelopeDigest, now);
            const record = this.#requireRecord(scope.taskId);
            return result(failed ? 'terminal-failure' : 'repair', record, this.#repairState(record),
                failed ? exhausted ? 'repair-attempts-exhausted' : 'repair-budget-insufficient' : 'repair-accepted');
        });
    }

    /** Mechanical host-request exchange only: no Model/Action, candidate or
     * completion authority is issued here. The caller supplies a trusted live
     * assertion, not an allow DTO; the original writer checks its entire tail.
     */
    commitRequestedVerification(input: unknown, authorizeCommit: () => unknown): AgentLoopTaskRecord {
        return this.#commitRequestedVerification(input, authorizeCommit);
    }

    #commitRequestedVerification(
        input: unknown,
        authorizeCommit: () => unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): AgentLoopTaskRecord {
        const scope = this.#completionScope(input, ['envelopeDigest', 'actionWatermark']);
        const envelopeDigest = scope.value.envelopeDigest,
            actionWatermark = token(scope.value.actionWatermark);
        if (
            typeof envelopeDigest !== 'string' ||
            !HASH.test(envelopeDigest) ||
            !actionWatermark.startsWith('action-completed:') ||
            typeof authorizeCommit !== 'function' ||
            !Number.isSafeInteger(scope.expectedRevision + 1) ||
            Reflect.ownKeys(scope.value).some((key) => !Object.getOwnPropertyDescriptor(scope.value, key)?.enumerable)
        ) {
            reject('agent-loop-projection-input-invalid');
        }
        return this.#transaction(
            () => {
                const inspect = (now: string) => {
                    const current = this.#requireRecord(scope.taskId);
                    this.#requireLease(current, scope.ownerId, now);
                    if (
                        !current.leaseExpiresAt ||
                        !Number.isFinite(Date.parse(current.leaseExpiresAt)) ||
                        new Date(current.leaseExpiresAt).toISOString() !== current.leaseExpiresAt
                    )
                        reject('agent-loop-projection-lease-lost');
                    if (current.revision !== scope.expectedRevision || current.envelopeDigest !== envelopeDigest)
                        reject('agent-loop-projection-revision-conflict');
                    if (
                        current.envelope.state !== 'RUNNING' ||
                        current.envelope.phase !== 'OBSERVE' ||
                        !current.envelope.currentAttemptId ||
                        current.envelope.updatedAt > now ||
                        this.#activeActions(scope.taskId).length > 0
                    )
                        reject('agent-loop-projection-input-invalid');
                    const snapshot = this.#completionSnapshot(current);
                    if (snapshot.actionWatermark !== actionWatermark || snapshot.unknownEffectActionIds.length > 0)
                        reject('agent-loop-projection-input-invalid');
                    // Include raw audit/outbox rows as well: completion snapshot's
                    // intentional owned-audit exclusions cannot conceal a tail edit.
                    const tail = [
                        'agent_loop_task_event',
                        'agent_loop_outbox',
                        'agent_loop_observation',
                        'agent_loop_observation_quarantine',
                        'agent_loop_artifact_ref',
                        'agent_loop_action_receipt',
                        'agent_loop_completion_candidate',
                        'agent_loop_completion_verification',
                    ].map((table) =>
                        this.#db.prepare(`SELECT * FROM ${table} WHERE task_id=? ORDER BY rowid`).all(scope.taskId),
                    );
                    return { current, digest: hash({ current, snapshot, tail }) };
                };
                const beforeTime = timestamp(this.#now()),
                    initial = inspect(beforeTime);
                const result = authorizeCommit();
                if (result !== undefined) {
                    if (result !== null && typeof result === 'object') {
                        try {
                            void Promise.prototype.then.call(
                                result,
                                () => undefined,
                                () => undefined,
                            );
                        } catch {
                            /* Never read or assimilate a foreign then property. */
                        }
                    }
                    reject('agent-loop-projection-input-invalid');
                }
                const now = timestamp(this.#now()),
                    { current, digest } = inspect(now);
                if (now < beforeTime || digest !== initial.digest) reject('agent-loop-projection-event-conflict');
                const envelope = normalizeAgentLoopTaskEnvelope({
                    ...current.envelope,
                    phase: 'VERIFY',
                    revision: scope.expectedRevision + 1,
                    updatedAt: now,
                });
                const nextDigest = hash(envelope);
                const changed = this.#db
                    .prepare(
                        `UPDATE agent_loop_task
                SET state=?,phase=?,revision=?,envelope_json=?,envelope_digest=?,updated_at=?
                WHERE task_id=? AND revision=? AND fenced=0`,
                    )
                    .run(
                        envelope.state,
                        envelope.phase,
                        envelope.revision,
                        JSON.stringify(envelope),
                        nextDigest,
                        now,
                        scope.taskId,
                        scope.expectedRevision,
                    );
                if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
                const requestDigest = hash({
                    taskId: scope.taskId,
                    attemptId: envelope.currentAttemptId,
                    revision: scope.expectedRevision,
                    actionWatermark,
                });
                this.#appendEvent(
                    scope.taskId,
                    envelope.revision,
                    {
                        eventId: `completion-requested:${requestDigest.slice(7)}`,
                        kind: 'completion-requested',
                        reasonCode: 'request_complete',
                    },
                    nextDigest,
                    now,
                );
                return this.#requireRecord(scope.taskId);
            },
            true,
            dagExecution,
        );
    }

    /** Same-revision immutable metadata only. Never changes phase, budget, owner or lease. */
    freezeCompletionCandidate(input: unknown): StoredAgentLoopCompletionCandidate {
        return this.#freezeCompletionCandidate(input);
    }

    #freezeCompletionCandidate(
        input: unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): StoredAgentLoopCompletionCandidate {
        const scope = this.#completionScope(input);
        return this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#completionAuthority(scope, now);
                // Required children must be verified and merged before a parent
                // can create a candidate, not merely before its final verdict.
                if (current.envelope.children.some(child =>
                    child.requirement === 'required' && child.joinState !== 'accepted')) {
                    reject('agent-loop-projection-input-invalid');
                }
                let candidate: StoredAgentLoopCompletionCandidate;
                try {
                    candidate = createStoredAgentLoopCompletionCandidate(this.#completionSnapshot(current), now);
                } catch {
                    return reject('agent-loop-projection-storage-invalid');
                }
                const seen = this.#completionCandidateRecord(
                    this.#db
                        .prepare('SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?')
                        .get(candidate.candidateRef) as SqlRow | undefined,
                );
                if (seen) {
                    if (seen.snapshotDigest !== candidate.snapshotDigest || seen.taskId !== scope.taskId)
                        reject('agent-loop-projection-event-conflict');
                    return seen;
                }
                this.#db
                    .prepare(
                        `INSERT INTO agent_loop_completion_candidate
                (candidate_ref,task_id,attempt_id,task_revision,snapshot_digest,frozen_digest,candidate_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
                    )
                    .run(
                        candidate.candidateRef,
                        candidate.taskId,
                        candidate.attemptId,
                        candidate.taskRevision,
                        candidate.snapshotDigest,
                        candidate.frozenDigest,
                        JSON.stringify(candidate),
                        candidate.createdAt,
                    );
                this.#appendEvent(
                    scope.taskId,
                    current.revision,
                    {
                        eventId: `completion-candidate-frozen:${candidate.snapshotDigest.slice(7)}`,
                        kind: 'completion-candidate-frozen',
                        reasonCode: null,
                    },
                    current.envelopeDigest,
                    now,
                );
                return this.#completionCandidateRecord(
                    this.#db
                        .prepare('SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?')
                        .get(candidate.candidateRef) as SqlRow | undefined,
                )!;
            },
            true,
            dagExecution,
        );
    }

    assertCompletionCandidateCurrent(input: unknown): StoredAgentLoopCompletionCandidate {
        return this.#assertCompletionCandidateCurrent(input);
    }

    #assertCompletionCandidateCurrent(
        input: unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): StoredAgentLoopCompletionCandidate {
        const scope = this.#completionScope(input, ['candidateRef']),
            candidateRef = token(scope.value.candidateRef);
        return this.#transaction(
            () => {
                const now = timestamp(this.#now()),
                    current = this.#completionAuthority(scope, now);
                return this.#currentCompletionCandidate(current, candidateRef, now);
            },
            true,
            dagExecution,
            undefined,
            'inspect',
        );
    }

    /** Read-only original-r full snapshot validation for historical reconciliation.
     * Deliberately grants no lease or current-owner authority, even on success.
     */
    assertFrozenCandidateSnapshot(input: unknown): StoredAgentLoopCompletionCandidate {
        const value = actionValue(v => normalizeAgentLoopActionObject(v, ['taskId', 'candidateRef']), input);
        const taskId = token(value.taskId), candidateRef = token(value.candidateRef);
        return this.#transaction(() => {
            const current = this.#requireRecord(taskId);
            if (current.fenced || current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'VERIFY') {
                reject('agent-loop-projection-input-invalid');
            }
            const candidate = this.#currentCompletionCandidate(current, candidateRef, timestamp(this.#now()));
            this.#assertCorrectionOutboxHistory(current);
            return candidate;
        }, false);
    }

    readCompletionCandidate(input: unknown): StoredAgentLoopCompletionCandidate | null {
        const value = actionValue(v => normalizeAgentLoopActionObject(v, ['taskId', 'candidateRef']), input);
        const taskId = token(value.taskId), candidateRef = token(value.candidateRef);
        return this.#transaction(() => {
            const candidate = this.#completionCandidateRecord(this.#db.prepare(
                'SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?').get(candidateRef) as SqlRow | undefined);
            if (candidate && candidate.taskId !== taskId) reject('agent-loop-projection-event-conflict');
            return candidate;
        }, false);
    }

    recordCompletionVerification(input: unknown, authorizeCommit?: () => void): StoredAgentLoopCompletionVerification {
        return this.#recordCompletionVerification(input, authorizeCommit);
    }

    #recordCompletionVerification(
        input: unknown,
        authorizeCommit?: () => void,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): StoredAgentLoopCompletionVerification {
        const scope = this.#completionScope(input, ['candidateRef', 'evaluation']),
            candidateRef = token(scope.value.candidateRef);
        if (authorizeCommit !== undefined && typeof authorizeCommit !== 'function')
            reject('agent-loop-projection-input-invalid');
        return this.#transaction(
            () => {
                let now = timestamp(this.#now());
                let current = this.#completionAuthority(scope, now);
                const candidate = this.#currentCompletionCandidate(current, candidateRef, now);
                let verification: StoredAgentLoopCompletionVerification;
                try {
                    verification = createStoredAgentLoopCompletionVerification(candidate, scope.value.evaluation, now);
                } catch {
                    return reject('agent-loop-projection-input-invalid');
                }
                if (authorizeCommit !== undefined) {
                    // Host-only synchronous assertion under the original writer lock, never DTO metadata.
                    // Do not await or assimilate thenables; an asynchronous result provides no authority.
                    const result: unknown = authorizeCommit();
                    if (result !== undefined) {
                        if (result !== null && typeof result === 'object') {
                            try {
                                void Promise.prototype.then.call(
                                    result,
                                    () => undefined,
                                    () => undefined,
                                );
                            } catch {
                                /* Do not execute an arbitrary then property. */
                            }
                        }
                        reject('agent-loop-projection-input-invalid');
                    }
                    now = timestamp(this.#now());
                    current = this.#completionAuthority(scope, now);
                    this.#currentCompletionCandidate(current, candidateRef, now);
                    try {
                        verification = createStoredAgentLoopCompletionVerification(
                            candidate,
                            scope.value.evaluation,
                            now,
                        );
                    } catch {
                        return reject('agent-loop-projection-input-invalid');
                    }
                }
                this.#assertTurnCompletionEvaluation(current.envelope, verification.evaluation);
                const seen = this.#completionVerificationRecord(
                    this.#db
                        .prepare('SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                        .get(verification.verificationResultRef) as SqlRow | undefined,
                );
                if (seen) {
                    if (seen.verificationDigest !== verification.verificationDigest)
                        reject('agent-loop-projection-event-conflict');
                    return seen;
                }
                this.#db
                    .prepare(
                        `INSERT INTO agent_loop_completion_verification
                (verification_result_ref,candidate_ref,task_id,task_revision,candidate_digest,verification_digest,verification_json,verified_at)
                VALUES(?,?,?,?,?,?,?,?)`,
                    )
                    .run(
                        verification.verificationResultRef,
                        candidate.candidateRef,
                        scope.taskId,
                        current.revision,
                        candidate.frozenDigest,
                        verification.verificationDigest,
                        JSON.stringify(verification),
                        now,
                    );
                this.#appendEvent(
                    scope.taskId,
                    current.revision,
                    {
                        eventId: `completion-verification-recorded:${verification.verificationDigest.slice(7)}`,
                        kind: 'completion-verification-recorded',
                        reasonCode: null,
                    },
                    current.envelopeDigest,
                    now,
                );
                return this.#completionVerificationRecord(
                    this.#db
                        .prepare('SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                        .get(verification.verificationResultRef) as SqlRow | undefined,
                )!;
            },
            true,
            dagExecution,
        );
    }

    readCompletionVerification(input: unknown): StoredAgentLoopCompletionVerification | null {
        const value = actionValue(v => normalizeAgentLoopActionObject(v, ['taskId', 'verificationResultRef']), input);
        const taskId = token(value.taskId), ref = token(value.verificationResultRef);
        return this.#transaction(() => {
            const record = this.#completionVerificationRecord(this.#db.prepare(
                'SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?').get(ref) as SqlRow | undefined);
            if (record && record.taskId !== taskId) reject('agent-loop-projection-event-conflict');
            return record;
        }, false);
    }

    /** Read-only exact terminal provenance. Never makes an old candidate current:
     * only the two independently validated terminal events are removed to audit
     * the original r snapshot. No lease, grant, execution or recovery is issued.
     */
    assertCompletedCandidate(input: unknown): AgentLoopTaskRecord {
        const value = actionValue(v => normalizeAgentLoopActionObject(v,
            ['taskId', 'candidateRef', 'verificationResultRef', 'taskUpdatedAt']), input);
        const taskId = token(value.taskId), candidateRef = token(value.candidateRef);
        const verificationResultRef = token(value.verificationResultRef), taskUpdatedAt = timestamp(value.taskUpdatedAt);
        return this.#transaction(() => this.#assertCompletedCandidateAt(
            taskId, candidateRef, verificationResultRef, taskUpdatedAt), false);
    }

    #assertCompletedCandidateAt(
        taskId: string,
        candidateRef: string,
        verificationResultRef: string,
        taskUpdatedAt: string,
    ): AgentLoopTaskRecord {
        const actual = this.#requireRecord(taskId);
        let current = actual;
        const excluded = new Set<string>();
        const candidate = this.#completionCandidateRecord(
            this.#db
                .prepare('SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?')
                .get(candidateRef) as SqlRow | undefined,
        );
        const verification = this.#completionVerificationRecord(
            this.#db
                .prepare('SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                .get(verificationResultRef) as SqlRow | undefined,
        );
        if (verification) this.#assertTurnCompletionEvaluation(actual.envelope, verification.evaluation);
        // The original settle writer may append exactly one accounting-only
        // revision after completion. It does not invalidate that frozen result.
        if (candidate && actual.revision === candidate.taskRevision + 3) {
            const row = this.#db.prepare('SELECT * FROM agent_loop_child_budget WHERE child_task_id=?').get(taskId) as
                | SqlRow
                | undefined;
            const completedEvent = this.#db
                .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                .get(`verify:${taskId}:${candidate.taskRevision + 1}:completed`) as SqlRow | undefined;
            if (
                !row ||
                row.status !== 'settled' ||
                !completedEvent ||
                completedEvent.task_id !== taskId ||
                completedEvent.kind !== 'task-completed' ||
                JSON.stringify(actual.envelope.budget.spent) !== row.usage_json
            )
                reject('agent-loop-projection-event-conflict');
            const settlementId = `dag:${hash({
                taskId,
                kind: 'dag-child-usage-recorded',
                identity: String(row.reservation_id),
            }).slice(7)}`;
            const settlement = this.#db
                .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                .get(settlementId) as SqlRow | undefined;
            const outbox = this.#db
                .prepare('SELECT * FROM agent_loop_outbox WHERE event_id=?')
                .all(settlementId) as SqlRow[];
            const expectedDigest = eventDigest({
                eventId: settlementId,
                taskId,
                revision: actual.revision,
                kind: 'dag-child-usage-recorded',
                reasonCode: null,
                envelopeDigest: actual.envelopeDigest,
            });
            if (
                !settlement ||
                settlement.task_id !== taskId ||
                settlement.revision !== actual.revision ||
                settlement.kind !== 'dag-child-usage-recorded' ||
                settlement.reason_code !== null ||
                settlement.event_digest !== expectedDigest ||
                settlement.accepted_at !== actual.envelope.updatedAt ||
                row.finished_at !== actual.envelope.updatedAt ||
                outbox.length !== 1 ||
                outbox[0]!.task_id !== taskId ||
                outbox[0]!.revision !== actual.revision ||
                outbox[0]!.event_digest !== expectedDigest ||
                outbox[0]!.created_at !== settlement.accepted_at
            )
                reject('agent-loop-projection-event-conflict');
            const envelope = normalizeAgentLoopTaskEnvelope({
                ...actual.envelope,
                revision: candidate.taskRevision + 2,
                updatedAt: completedEvent.accepted_at,
            });
            current = { ...actual, envelope, revision: envelope.revision, envelopeDigest: hash(envelope) };
            excluded.add(settlementId);
        }
        if (
            !candidate ||
            !verification ||
            candidate.taskId !== taskId ||
            verification.taskId !== taskId ||
            verification.candidateDigest !== candidate.frozenDigest ||
            verification.candidateRef !== candidateRef ||
            verification.taskRevision !== candidate.taskRevision ||
            verification.evaluation.verdict !== 'complete' ||
            candidate.missingArtifactRefs.length ||
            candidate.unknownEffectActionIds.length ||
            current.fenced ||
            current.envelope.state !== 'COMPLETED' ||
            current.envelope.phase !== 'VERIFY' ||
            current.revision !== candidate.taskRevision + 2 ||
            current.envelope.currentAttemptId !== candidate.attemptId ||
            current.envelope.updatedAt < verification.verifiedAt
        )
            reject('agent-loop-projection-event-conflict');
        const { completion: ignored, ...base } = current.envelope;
        void ignored;
        const original = normalizeAgentLoopTaskEnvelope({
            ...base,
            state: 'RUNNING',
            revision: candidate.taskRevision,
            updatedAt: taskUpdatedAt,
        });
        if (hash(original) !== candidate.envelopeDigest) reject('agent-loop-projection-event-conflict');
        const verifying = normalizeAgentLoopTaskEnvelope({
            ...original,
            state: 'VERIFYING',
            revision: candidate.taskRevision + 1,
            updatedAt: current.envelope.updatedAt,
            completion: { candidateRef, evidenceRefs: verification.evaluation.evidenceRefs },
        });
        const completed = normalizeAgentLoopTaskEnvelope({
            ...verifying,
            state: 'COMPLETED',
            revision: candidate.taskRevision + 2,
            completion: {
                candidateRef,
                disposition: 'passed',
                verificationResultRef,
                evidenceRefs: verification.evaluation.evidenceRefs,
            },
        });
        if (hash(completed) !== current.envelopeDigest) reject('agent-loop-projection-event-conflict');
        for (const [envelope, suffix, kind] of [
            [verifying, 'candidate', 'completion-candidate'],
            [completed, 'completed', 'task-completed'],
        ] as const) {
            const eventId = `verify:${taskId}:${envelope.revision - 1}:${suffix}`;
            const digest = eventDigest({
                eventId,
                taskId,
                revision: envelope.revision,
                kind,
                reasonCode: 'verification-passed',
                envelopeDigest: hash(envelope),
            });
            const row = this.#db.prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?').get(eventId) as
                | SqlRow
                | undefined;
            const outbox = this.#db
                .prepare('SELECT * FROM agent_loop_outbox WHERE event_id=?')
                .all(eventId) as SqlRow[];
            if (
                !row ||
                row.task_id !== taskId ||
                row.revision !== envelope.revision ||
                row.kind !== kind ||
                row.reason_code !== 'verification-passed' ||
                row.event_digest !== digest ||
                row.accepted_at !== current.envelope.updatedAt ||
                outbox.length !== 1 ||
                outbox[0]!.task_id !== taskId ||
                outbox[0]!.revision !== envelope.revision ||
                outbox[0]!.event_digest !== digest ||
                outbox[0]!.created_at !== row.accepted_at
            )
                reject('agent-loop-projection-event-conflict');
            excluded.add(eventId);
        }
        const snapshot = this.#completionSnapshot(
            {
                ...current,
                envelope: original,
                envelopeDigest: candidate.envelopeDigest,
                revision: candidate.taskRevision,
            },
            excluded,
        );
        if (
            createStoredAgentLoopCompletionCandidate(snapshot, timestamp(this.#now())).snapshotDigest !==
            candidate.snapshotDigest
        ) {
            reject('agent-loop-projection-event-conflict');
        }
        this.#assertCorrectionOutboxHistory(current);
        return actual;
    }

    /** Mechanical host-only terminal port. Audit JSON supplies no authority:
     * the caller must independently possess a live, source-bound authorization
     * and assert it synchronously under this writer lock. The original candidate
     * remains bound to r; the two legal derived states share one transaction and
     * timestamp, with no externally visible or recoverable r+1 window.
     */
    completeVerifiedCandidate(input: unknown, authorizeCommit: () => unknown): AgentLoopTaskRecord {
        return this.#completeVerifiedCandidate(input, authorizeCommit);
    }

    #completeVerifiedCandidate(
        input: unknown,
        authorizeCommit: () => unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): AgentLoopTaskRecord {
        const scope = this.#completionScope(input, ['candidateRef', 'verificationResultRef']);
        const candidateRef = token(scope.value.candidateRef),
            verificationResultRef = token(scope.value.verificationResultRef);
        if (
            typeof authorizeCommit !== 'function' ||
            !Number.isSafeInteger(scope.expectedRevision + 2) ||
            Reflect.ownKeys(scope.value).some((key) => !Object.getOwnPropertyDescriptor(scope.value, key)?.enumerable)
        ) {
            reject('agent-loop-projection-input-invalid');
        }
        return this.#transaction(
            () => {
                const inspect = (now: string) => {
                    const current = this.#completionAuthority(scope, now);
                    if (current.envelope.state !== 'RUNNING' || current.envelope.phase !== 'VERIFY')
                        reject('agent-loop-projection-input-invalid');
                    const candidate = this.#currentCompletionCandidate(current, candidateRef, now);
                    const verification = this.#completionVerificationRecord(
                        this.#db
                            .prepare('SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                            .get(verificationResultRef) as SqlRow | undefined,
                    );
                    if (!verification) reject('agent-loop-projection-record-missing');
                    this.#assertTurnCompletionEvaluation(current.envelope, verification.evaluation);
                    if (
                        candidate.taskRevision !== scope.expectedRevision ||
                        candidate.attemptId !== current.envelope.currentAttemptId ||
                        verification.taskId !== scope.taskId ||
                        verification.candidateRef !== candidateRef ||
                        verification.candidateDigest !== candidate.frozenDigest ||
                        verification.taskRevision !== scope.expectedRevision ||
                        verification.verificationResultRef !== verificationResultRef ||
                        verification.evaluation.verificationResultRef !== verificationResultRef ||
                        verification.evaluation.verdict !== 'complete' ||
                        verification.evaluation.evidenceRefs.length === 0 ||
                        candidate.missingArtifactRefs.length > 0 ||
                        candidate.unknownEffectActionIds.length > 0 ||
                        verification.verifiedAt > now ||
                        current.envelope.updatedAt > now
                    )
                        reject('agent-loop-projection-input-invalid');
                    return { current, candidate, verification };
                };
                const initial = inspect(timestamp(this.#now()));
                const result = authorizeCommit();
                if (result !== undefined) {
                    if (result !== null && typeof result === 'object') {
                        try {
                            void Promise.prototype.then.call(
                                result,
                                () => undefined,
                                () => undefined,
                            );
                        } catch {
                            /* Never invoke an arbitrary then property or assimilate a foreign thenable. */
                        }
                    }
                    reject('agent-loop-projection-input-invalid');
                }
                // The source assertion may consume time or revoke authority. Sample
                // again while still holding the original lock, then recheck all rows.
                const now = timestamp(this.#now()),
                    { current, candidate, verification } = inspect(now);
                if (
                    current.envelopeDigest !== initial.current.envelopeDigest ||
                    candidate.frozenDigest !== initial.candidate.frozenDigest ||
                    verification.verificationDigest !== initial.verification.verificationDigest
                )
                    reject('agent-loop-projection-event-conflict');
                let verifying: AgentLoopTaskEnvelopeV1, completed: AgentLoopTaskEnvelopeV1;
                try {
                    verifying = normalizeAgentLoopTaskEnvelope({
                        ...current.envelope,
                        state: 'VERIFYING',
                        phase: 'VERIFY',
                        completion: { candidateRef, evidenceRefs: verification.evaluation.evidenceRefs },
                        revision: scope.expectedRevision + 1,
                        updatedAt: now,
                    });
                    completed = normalizeAgentLoopTaskEnvelope({
                        ...verifying,
                        state: 'COMPLETED',
                        completion: {
                            candidateRef,
                            disposition: 'passed',
                            verificationResultRef,
                            evidenceRefs: verification.evaluation.evidenceRefs,
                        },
                        revision: scope.expectedRevision + 2,
                    });
                } catch {
                    return reject('agent-loop-projection-input-invalid');
                }
                const verifyingDigest = hash(verifying),
                    completedDigest = hash(completed);
                const changed = this.#db
                    .prepare(
                        `UPDATE agent_loop_task
                SET state=?,phase=?,revision=?,envelope_json=?,envelope_digest=?,updated_at=?
                WHERE task_id=? AND revision=? AND fenced=0`,
                    )
                    .run(
                        completed.state,
                        completed.phase,
                        completed.revision,
                        JSON.stringify(completed),
                        completedDigest,
                        now,
                        scope.taskId,
                        scope.expectedRevision,
                    );
                if (Number(changed.changes) !== 1) reject('agent-loop-projection-revision-conflict');
                this.#appendEvent(
                    scope.taskId,
                    verifying.revision,
                    {
                        eventId: `verify:${scope.taskId}:${scope.expectedRevision}:candidate`,
                        kind: 'completion-candidate',
                        reasonCode: 'verification-passed',
                    },
                    verifyingDigest,
                    now,
                );
                this.#appendEvent(
                    scope.taskId,
                    completed.revision,
                    {
                        eventId: `verify:${scope.taskId}:${scope.expectedRevision + 1}:completed`,
                        kind: 'task-completed',
                        reasonCode: 'verification-passed',
                    },
                    completedDigest,
                    now,
                );
                return this.#requireRecord(scope.taskId);
            },
            true,
            dagExecution,
        );
    }

    /**
     * 登记一条 typed ref（CX-4）。
     *
     * 三条边界：
     * 1. **不推进 revision**：引用登记不改变 state/phase/plan，不该占用语义 revision；
     *    它只是「这条任务曾引用过这份领域记录，当时摘要是 X」。
     * 2. **同 refId 同描述 = 重放**（返回 `replayed: true`，不写第二行、不写第二个事件）。
     * 3. **同 refId 不同描述 = 冲突**：摘要在背后被改写成另一份内容是最危险的静默漂移，
     *    要换指向必须换 `refId`，历史快照才不会被追溯性改写。
     */
    registerRef(input: unknown): Readonly<{
        ref: AgentLoopArtifactRefRecord;
        replayed: boolean;
    }> {
        return this.#registerRef(input);
    }

    #registerRef(
        input: unknown,
        dagExecution?: AgentLoopDagLeafExecutionScope,
    ): Readonly<{
        ref: AgentLoopArtifactRefRecord;
        replayed: boolean;
    }> {
        const value = exact(input, ['taskId', 'expectedRevision', 'ownerId', 'ref']);
        const taskId = token(value.taskId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const ownerId = token(value.ownerId);
        const ref = normalizeAgentLoopArtifactRefDescriptor(value.ref);
        const now = timestamp(this.#now());
        return this.#transaction(
            () => {
                const current = this.#requireRecord(taskId);
                this.#requireLease(current, ownerId, now);
                if (current.revision !== expected) {
                    reject('agent-loop-projection-revision-conflict');
                }
                return this.#registerRefAt(current, ref, now);
            },
            true,
            dagExecution,
        );
    }

    /** Same original writer for standalone registration and phase-CAS bundles. */
    #registerRefAt(current: AgentLoopTaskRecord, ref: AgentLoopArtifactRefDescriptor, now: string,
        requireExisting = false): Readonly<{ ref: AgentLoopArtifactRefRecord; replayed: boolean }> {
            const taskId = current.envelope.taskId;
            const existing = this.#db.prepare(
                'SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?',
            ).get(taskId, ref.refId) as SqlRow | undefined;
            if (existing) {
                const stored = this.#refRecord(existing);
                const same = stored.kind === ref.kind
                    && stored.ownerRef === ref.ownerRef
                    && stored.expectedDigest === ref.expectedDigest
                    && stored.expectedRevision === ref.expectedRevision
                    && stored.policy === ref.policy
                    && stored.aclClass === ref.aclClass
                    && stored.expandBudgetTokens === ref.expandBudgetTokens;
                if (!same) reject('agent-loop-projection-ref-conflict');
                if (requireExisting && (stored.taskRevision > current.revision
                    || !this.#db.prepare("SELECT 1 FROM agent_loop_task_event WHERE task_id=? AND revision=? AND event_id=? AND kind='ref-registered'")
                        .get(taskId, stored.taskRevision, `ref-registered:${ref.refId}`))) reject('agent-loop-projection-event-conflict');
                return Object.freeze({ ref: stored, replayed: true });
            }
            if (requireExisting) reject('agent-loop-projection-event-conflict');
            this.#db.prepare(`INSERT INTO agent_loop_artifact_ref
                (task_id,ref_id,kind,owner_ref,expected_digest,expected_revision,policy,
                 acl_class,expand_budget_tokens,task_revision,registered_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
                .run(taskId, ref.refId, ref.kind, ref.ownerRef, ref.expectedDigest,
                    ref.expectedRevision ?? null, ref.policy, ref.aclClass,
                    ref.expandBudgetTokens, current.revision, now);
            // 事件同时进 outbox 之外的审计流；refId 稳定 ⇒ 事件 id 稳定 ⇒ 重放幂等。
            this.#appendEvent(taskId, current.revision, {
                eventId: `ref-registered:${ref.refId}`,
                kind: 'ref-registered',
                reasonCode: null,
            }, current.envelopeDigest, now);
            const inserted = this.#db.prepare(
                'SELECT * FROM agent_loop_artifact_ref WHERE task_id=? AND ref_id=?',
            ).get(taskId, ref.refId) as SqlRow | undefined;
            if (!inserted) reject('agent-loop-projection-storage-invalid');
            return Object.freeze({ ref: this.#refRecord(inserted), replayed: false });
    }

    /** 读已登记的 ref（按 `ref_id` 字典序，保证同一任务两次读到的顺序一致）。 */
    readRefs(taskIdInput: unknown): readonly AgentLoopArtifactRefRecord[] {
        const taskId = token(taskIdInput);
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                'SELECT * FROM agent_loop_artifact_ref WHERE task_id=? ORDER BY ref_id ASC',
            ).all(taskId) as SqlRow[];
            return Object.freeze(rows.map((row) => this.#refRecord(row)));
        }, false);
    }

    /**
     * 摄取一条 Observation。
     *
     * 四条路径严格区分（都不猜）：
     * - `duplicate`：同 ID 同摘要 ⇒ 完全不写，投影不动；
     * - `conflict`：同 ID 不同摘要 / 任务不符 / 未来 revision ⇒ **先写隔离表再抛错**；
     * - `stale`：旧 attempt 或旧 revision ⇒ 只写审计（事件 + 归约记录），**不推进 revision**；
     * - `applied`：CAS 前进一格，事件与 outbox 同事务。
     */
    ingestObservation(input: unknown): AgentLoopObservationIngest {
        return this.#ingestObservation(input);
    }

    #ingestObservation(input: unknown, dagExecution?: AgentLoopDagLeafExecutionScope): AgentLoopObservationIngest {
        if (nodeTypes.isProxy(input)) reject('agent-loop-projection-input-invalid');
        const value = exact(input, ['observation', 'expectedRevision', 'ownerId'], ['modelOutcome']);
        const hasModelOutcome = Object.hasOwn(value, 'modelOutcome');
        if (hasModelOutcome) {
            // This optional live brand is not decoded from caller JSON or getters.
            for (const key of Reflect.ownKeys(value)) {
                const property = Object.getOwnPropertyDescriptor(value, key);
                if (!property?.enumerable || !Object.hasOwn(property, 'value'))
                    reject('agent-loop-projection-input-invalid');
            }
        }
        const rawObservation = value.observation;
        const modelOutcome = hasModelOutcome ? readAgentLoopModelOutcome(value.modelOutcome) : null;
        if (
            hasModelOutcome &&
            (!modelOutcome ||
                modelOutcome.observation !== rawObservation ||
                (!dagExecution &&
                    (modelOutcome.decision !== null ||
                        !isAgentLoopModelProtocolRejectionReason(modelOutcome.protocolRejectionReason))))
        ) {
            reject('agent-loop-projection-input-invalid');
        }
        const ownerId = token(value.ownerId);
        if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
            reject('agent-loop-projection-input-invalid');
        }
        const expected = Number(value.expectedRevision);
        const observation = normalizeObservationStrict(rawObservation);
        const digest = agentLoopObservationDigest(observation);
        const outcome = this.#transaction(
            () => {
                // Lease authority is sampled after obtaining the SQLite writer lock.
                const now = timestamp(this.#now());
                const current = this.#requireRecord(observation.taskId);
                this.#requireLease(current, ownerId, now);
                if (this.#dagBound(observation.taskId) && !dagExecution) reject('agent-loop-projection-input-invalid');
                if (current.revision !== expected) {
                    reject('agent-loop-projection-revision-conflict');
                }

                const seen = this.#db
                    .prepare(
                        'SELECT observation_digest, classification FROM agent_loop_observation WHERE observation_id=?',
                    )
                    .get(observation.observationId) as SqlRow | undefined;

                let rejection: { eventId: string; kind: string; reasonCode: string } | undefined;
                const summaryDetail = modelOutcome?.summaryValidationRejection;
                if (dagExecution) {
                    if (
                        observation.attemptId !== dagExecution.childAttemptId ||
                        observation.observedForTaskRevision !== expected ||
                        current.envelope.state !== 'RUNNING'
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                    if (observation.sourceKind === 'provider') {
                        const usage = observation.usageDelta;
                        const invocationId = agentLoopModelInvocationId({
                            taskId: observation.taskId,
                            attemptId: dagExecution.childAttemptId,
                            expectedTaskRevision: expected,
                        });
                        const reservedId = `model-invocation:${invocationId}`;
                        const reserved = this.#db
                            .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                            .get(reservedId) as SqlRow | undefined;
                        if (
                            !modelOutcome ||
                            summaryDetail ||
                            current.envelope.phase !== 'MODEL' ||
                            observation.observationId !== `model-usage:${invocationId}` ||
                            observation.correlationRef !== reservedId ||
                            (usage &&
                                (usage.modelCalls !== 1 ||
                                    usage.toolCalls !== 0 ||
                                    usage.writes !== 0 ||
                                    usage.highRiskActions !== 0)) ||
                            !reserved ||
                            reserved.task_id !== observation.taskId ||
                            reserved.revision !== expected ||
                            reserved.kind !== 'model-invocation-reserved' ||
                            reserved.reason_code !== null ||
                            reserved.event_digest !==
                                eventDigest({
                                    eventId: reservedId,
                                    taskId: observation.taskId,
                                    revision: expected,
                                    kind: 'model-invocation-reserved',
                                    reasonCode: null,
                                    envelopeDigest: current.envelopeDigest,
                                })
                        )
                            reject('agent-loop-projection-input-invalid');
                    } else {
                        const receipt = this.#observationAction(observation);
                        if (
                            hasModelOutcome ||
                            observation.sourceKind !== 'tool' ||
                            !receipt ||
                            receipt.actionContractRef !== 'action.rp.read-character.v1'
                        )
                            reject('agent-loop-projection-input-invalid');
                        this.#matchActionObservation(current, observation, receipt);
                    }
                } else if (hasModelOutcome) {
                    const usage = observation.usageDelta,
                        attemptId = current.envelope.currentAttemptId;
                    if (
                        seen ||
                        current.envelope.state !== 'RUNNING' ||
                        current.envelope.phase !== 'MODEL' ||
                        current.envelope.updatedAt > now ||
                        !attemptId ||
                        observation.attemptId !== attemptId ||
                        observation.observedForTaskRevision !== expected ||
                        observation.sourceKind !== 'provider' ||
                        observation.completeness !== 'complete' ||
                        !usage ||
                        usage.modelCalls !== 1 ||
                        usage.toolCalls !== 0 ||
                        usage.writes !== 0 ||
                        usage.highRiskActions !== 0 ||
                        usage.inputTokens <= 0 ||
                        usage.outputTokens <= 0
                    )
                        reject('agent-loop-projection-input-invalid');
                    const invocationId = agentLoopModelInvocationId({
                        taskId: observation.taskId,
                        attemptId,
                        expectedTaskRevision: expected,
                    });
                    const reservedId = `model-invocation:${invocationId}`;
                    if (
                        observation.observationId !== `model-usage:${invocationId}` ||
                        observation.correlationRef !== reservedId
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                    const reserved = this.#db
                        .prepare('SELECT * FROM agent_loop_task_event WHERE event_id=?')
                        .get(reservedId) as SqlRow | undefined;
                    if (
                        !reserved ||
                        reserved.task_id !== observation.taskId ||
                        Number(reserved.revision) !== expected ||
                        reserved.kind !== 'model-invocation-reserved' ||
                        reserved.reason_code !== null ||
                        reserved.event_digest !==
                            eventDigest({
                                eventId: reservedId,
                                taskId: observation.taskId,
                                revision: expected,
                                kind: 'model-invocation-reserved',
                                reasonCode: null,
                                envelopeDigest: current.envelopeDigest,
                            })
                    ) {
                        reject('agent-loop-projection-input-invalid');
                    }
                    rejection = {
                        eventId: `model-rejection:${invocationId}`,
                        kind: 'model-protocol-rejected',
                        reasonCode: modelOutcome!.protocolRejectionReason!,
                    };
                    if (summaryDetail && current.envelope.taskKind !== 'maintenance.rolling_summary')
                        reject('agent-loop-projection-input-invalid');
                    if (
                        this.#db.prepare('SELECT 1 FROM agent_loop_task_event WHERE event_id=?').get(rejection.eventId)
                    ) {
                        reject('agent-loop-projection-event-conflict');
                    }
                }

                const reduction = reduceAgentLoopObservation({
                    envelope: current.envelope,
                    observation,
                    storedDigest: seen ? String(seen.observation_digest) : null,
                });
                // No late backfill: only the original applied accounting CAS may
                // record this refusal. It is never a retry/repair or Model grant.
                if (
                    rejection &&
                    (reduction.classification !== 'applied' ||
                        reduction.reasonCodes.includes('observation-budget-overrun'))
                )
                    reject('agent-loop-projection-observation-conflict');

                if (reduction.classification === 'duplicate') {
                    return {
                        classification: 'duplicate' as const,
                        record: current,
                        reasonCodes: reduction.reasonCodes,
                        satisfiesVerification: false,
                        observationDigest: digest,
                    };
                }

                if (reduction.classification === 'conflict') {
                    this.#quarantine(
                        observation.observationId,
                        observation.taskId,
                        seen ? String(seen.observation_digest) : null,
                        digest,
                        reduction.reasonCodes[0] ?? 'observation-id-conflict',
                        now,
                    );
                    this.#appendEvent(
                        observation.taskId,
                        current.revision,
                        {
                            eventId: `observation-quarantined:${observation.observationId}`,
                            kind: 'observation-quarantined',
                            reasonCode: reduction.reasonCodes[0] ?? 'observation-id-conflict',
                        },
                        current.envelopeDigest,
                        now,
                    );
                    return { conflict: true as const };
                }

                if (reduction.classification === 'stale') {
                    // A known sidecar Action cannot be made to consume its own canonical ID as
                    // a stale, unbound result and thereby poison a later exact settlement.
                    if (this.#observationAction(observation)) {
                        reject('agent-loop-projection-observation-conflict');
                    }
                    // 只可审计：投影一行不动，事件记在当前 revision 上（不推进）。
                    this.#insertObservation(observation, 'stale', reduction, null, now);
                    this.#appendEvent(
                        observation.taskId,
                        current.revision,
                        {
                            eventId: `observation:${observation.observationId}`,
                            kind: 'observation-stale',
                            reasonCode: reduction.reasonCodes[0] ?? 'observation-task-revision-stale',
                        },
                        current.envelopeDigest,
                        now,
                    );
                    return {
                        classification: 'stale' as const,
                        record: current,
                        reasonCodes: reduction.reasonCodes,
                        satisfiesVerification: false,
                        observationDigest: digest,
                    };
                }

                const next = reduction.envelope;
                if (!next) reject('agent-loop-projection-storage-invalid');
                const action = this.#observationAction(observation);
                if (action || this.#activeActions(observation.taskId).length > 0) {
                    if (!action) reject('agent-loop-projection-observation-conflict');
                    this.#matchActionObservation(current, observation, action);
                }
                const envelopeDigest = hash(next);
                const changed = this.#db
                    .prepare(
                        `UPDATE agent_loop_task
                SET state=?, phase=?, revision=?, envelope_json=?, envelope_digest=?, updated_at=?
                WHERE task_id=? AND revision=? AND fenced=0`,
                    )
                    .run(
                        next.state,
                        next.phase,
                        next.revision,
                        JSON.stringify(next),
                        envelopeDigest,
                        next.updatedAt,
                        next.taskId,
                        expected,
                    );
                if (Number(changed.changes) !== 1) {
                    reject('agent-loop-projection-revision-conflict');
                }
                this.#insertObservation(observation, 'applied', reduction, next.revision, now);
                this.#appendEvent(
                    next.taskId,
                    next.revision,
                    {
                        eventId: `observation:${observation.observationId}`,
                        kind: 'observation-applied',
                        reasonCode: reduction.reasonCodes[0] ?? null,
                    },
                    envelopeDigest,
                    now,
                );
                if (rejection) this.#appendEvent(next.taskId, next.revision, rejection, envelopeDigest, now);
                if (rejection && summaryDetail) {
                    const invocationId = agentLoopModelInvocationId({
                        taskId: next.taskId,
                        attemptId: observation.attemptId!,
                        expectedTaskRevision: expected,
                    });
                    this.#appendEvent(
                        next.taskId,
                        next.revision,
                        {
                            eventId: `${SUMMARY_VALIDATION_PREFIX}${invocationId.slice(7)}:${envelopeDigest.slice(7)}`,
                            kind: SUMMARY_VALIDATION_EVENT,
                            reasonCode: summaryDetail.code,
                        },
                        envelopeDigest,
                        now,
                    );
                }
                if (action) {
                    const observed: AgentLoopActionReceiptRecord = Object.freeze({
                        ...action,
                        status: 'observed',
                        observationId: observation.observationId,
                        appliedRevision: next.revision,
                        observedAt: now,
                    });
                    this.#updateAction(observed);
                    this.#actionEvent(
                        observed,
                        'observed',
                        { ...current, envelope: next, revision: next.revision, envelopeDigest },
                        now,
                    );
                }
                const stored = this.#record(this.#row(next.taskId));
                if (!stored) reject('agent-loop-projection-storage-invalid');
                return {
                    classification: 'applied' as const,
                    record: stored,
                    reasonCodes: reduction.reasonCodes,
                    satisfiesVerification: reduction.satisfiesVerification,
                    observationDigest: digest,
                };
            },
            true,
            dagExecution,
            dagExecution ? value.modelOutcome : undefined,
            'accounting',
        );

        if ('conflict' in outcome) {
            throw new AgentLoopProjectionError('agent-loop-projection-observation-conflict');
        }
        return Object.freeze(outcome);
    }

    #insertObservation(
        observation: ReturnType<typeof normalizeObservationStrict>,
        classification: 'applied' | 'stale',
        reduction: ReturnType<typeof reduceAgentLoopObservation>,
        appliedRevision: number | null,
        now: string,
    ): void {
        this.#db.prepare(`INSERT INTO agent_loop_observation
            (observation_id,task_id,attempt_id,observed_for_revision,source_kind,completeness,
             payload_digest,observation_digest,classification,satisfies_verification,
             applied_revision,reason_codes_json,observed_at,ingested_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(observation.observationId, observation.taskId, observation.attemptId,
                observation.observedForTaskRevision, observation.sourceKind,
                observation.completeness, observation.payloadDigest,
                agentLoopObservationDigest(observation), classification,
                reduction.satisfiesVerification ? 1 : 0, appliedRevision,
                JSON.stringify(reduction.reasonCodes), observation.observedAt, now);
    }

    #quarantine(
        observationId: string,
        taskId: string,
        storedDigest: string | null,
        conflictingDigest: string,
        reasonCode: string,
        now: string,
    ): void {
        // 同 ID 第二次冲突不覆盖第一次：第一次才是「原始事实 vs 第一个异见」。
        this.#db.prepare(`INSERT OR IGNORE INTO agent_loop_observation_quarantine
            (observation_id,task_id,stored_digest,conflicting_digest,reason_code,quarantined_at)
            VALUES(?,?,?,?,?,?)`)
            .run(observationId, taskId,
                storedDigest ?? conflictingDigest, conflictingDigest, reasonCode, now);
    }

    /** 已归结的 Observation（applied / stale），按 ingested_at 升序。 */
    readObservations(taskIdInput: unknown): readonly AgentLoopObservationRecord[] {
        const taskId = token(taskIdInput);
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM agent_loop_observation
                WHERE task_id=? ORDER BY ingested_at ASC, observation_id ASC`).all(taskId) as SqlRow[];
            return Object.freeze(rows.map((row) => Object.freeze({
                observationId: String(row.observation_id),
                taskId: String(row.task_id),
                attemptId: String(row.attempt_id),
                observedForTaskRevision: Number(row.observed_for_revision),
                sourceKind: String(row.source_kind),
                completeness: String(row.completeness),
                classification: String(row.classification) as 'applied' | 'stale',
                satisfiesVerification: Number(row.satisfies_verification) === 1,
                appliedRevision: row.applied_revision === null ? null : Number(row.applied_revision),
                reasonCodes: JSON.parse(String(row.reason_codes_json)) as string[],
                ingestedAt: String(row.ingested_at),
            })));
        }, false);
    }

    /** 隔离区（只读）：同 ID 不同摘要的冲突留痕。 */
    readQuarantine(): readonly Readonly<Record<string, unknown>>[] {
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                'SELECT * FROM agent_loop_observation_quarantine ORDER BY quarantined_at ASC',
            ).all() as SqlRow[];
            return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
        }, false);
    }

    /** 定向读。任务不存在 → null；任务存在但行坏了 → 抛错（不伪装成不存在）。 */
    read(taskIdInput: unknown): AgentLoopTaskRecord | null {
        const taskId = token(taskIdInput);
        return this.#transaction(() => this.#record(this.#row(taskId)), false);
    }

    /** Original Task/attempt and, only when complete original evidence exists, its exact terminal provenance. */
    readTaskOutcomeSnapshot(taskIdInput: unknown): AgentLoopTaskOutcomeSnapshot | null {
        const taskId = token(taskIdInput);
        return this.#transaction(() => {
            const record = this.#record(this.#row(taskId));
            if (record === null) return null;
            if (hash(record.envelope) !== record.envelopeDigest) reject('agent-loop-projection-storage-invalid');
            const unknown = () => Object.freeze({ record, completion: null });
            const pointers = record.envelope.completion;
            if (record.fenced || record.envelope.state !== 'COMPLETED'
                || pointers?.disposition !== 'passed' || !pointers.candidateRef || !pointers.verificationResultRef) {
                return unknown();
            }
            const candidate = this.#completionCandidateRecord(this.#db.prepare(
                'SELECT * FROM agent_loop_completion_candidate WHERE candidate_ref=?')
                .get(pointers.candidateRef) as SqlRow | undefined);
            if (!candidate) return unknown();
            const verification = this.#completionVerificationRecord(this.#db.prepare(
                'SELECT * FROM agent_loop_completion_verification WHERE verification_result_ref=?')
                .get(pointers.verificationResultRef) as SqlRow | undefined);
            if (!verification) return unknown();
            const requests = this.#db.prepare(`SELECT * FROM agent_loop_task_event
                WHERE task_id=? AND revision=? AND kind='completion-requested' AND reason_code='request_complete'`)
                .all(taskId, candidate.taskRevision) as SqlRow[];
            if (requests.length !== 1) return unknown();
            const originalEvent = (row: SqlRow): AgentLoopTaskEvent => {
                try {
                    if (row.task_id !== taskId || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
                        || !HASH.test(String(row.event_digest))) throw new Error();
                    return Object.freeze({
                        eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION,
                        taskId, eventId: token(row.event_id), revision: Number(row.revision), kind: token(row.kind),
                        ...(row.reason_code === null ? {} : { reasonCode: token(row.reason_code) }),
                        eventDigest: String(row.event_digest), acceptedAt: timestamp(row.accepted_at),
                    });
                } catch { return reject('agent-loop-projection-storage-invalid'); }
            };
            const requested = originalEvent(requests[0]!);
            const checked = this.#assertCompletedCandidateAt(taskId, pointers.candidateRef,
                pointers.verificationResultRef, requested.acceptedAt);
            if (checked.revision !== record.revision || checked.envelopeDigest !== record.envelopeDigest) {
                reject('agent-loop-projection-event-conflict');
            }
            const completedRows = this.#db.prepare(`SELECT * FROM agent_loop_task_event
                WHERE task_id=? AND revision=? AND kind='task-completed'`)
                .all(taskId, candidate.taskRevision + 2) as SqlRow[];
            if (completedRows.length !== 1) reject('agent-loop-projection-event-conflict');
            return Object.freeze({ record, completion: Object.freeze({ candidate, verification, requested,
                completed: originalEvent(completedRows[0]!) }) });
        }, false);
    }

    /**
     * 有界恢复扫描：未围栏 + 非终态 + lease 缺失或过期。顺序稳定（updated_at, task_id）。
     * 坏行隔离：只计数，不中断（恢复不能被一条坏记录卡死）。
     */
    scanRecoverable(input: unknown = {}): AgentLoopRecoveryScan {
        const value = actionValue(v => normalizeAgentLoopActionObject(v, [], ['limit', 'now', 'after']), input);
        const limit = boundedLimit(value.limit, 32);
        const now = value.now === undefined ? timestamp(this.#now()) : timestamp(value.now);
        const cursor = (input: unknown): AgentLoopRecoveryCursor => {
            const row = actionValue(v => normalizeAgentLoopActionObject(v, ['updatedAt', 'taskId']), input);
            if (typeof row.updatedAt !== 'string' || row.updatedAt.length < 1 || row.updatedAt.length > 128
                || typeof row.taskId !== 'string' || row.taskId.length < 1 || row.taskId.length > 240
                || /[\u0000-\u001f\u007f]/u.test(row.updatedAt) || /[\u0000-\u001f\u007f]/u.test(row.taskId)) {
                reject('agent-loop-projection-input-invalid');
            }
            return Object.freeze({ updatedAt: row.updatedAt, taskId: row.taskId });
        };
        const after = value.after === undefined ? null : cursor(value.after);
        return this.#transaction(() => {
            const states = [...TERMINAL_STATES];
            const rows = this.#db.prepare(`SELECT * FROM agent_loop_task
                WHERE fenced=0
                  AND state NOT IN (${states.map(() => '?').join(',')})
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                  ${after ? 'AND (updated_at>? OR (updated_at=? AND task_id>?))' : ''}
                ORDER BY updated_at ASC, task_id ASC
                LIMIT ?`).all(...states, now, ...(after ? [after.updatedAt, after.updatedAt, after.taskId] : []), limit) as SqlRow[];
            const tasks: AgentLoopTaskRecord[] = [];
            let skipped = 0;
            for (const row of rows) {
                try {
                    const record = this.#record(row);
                    if (record) tasks.push(record);
                } catch { skipped += 1; }
            }
            // Advance from the actual last SQL row, even if every body on this
            // page was invalid. A full final page may need one empty tail scan.
            const last = rows.at(-1);
            const nextCursor = rows.length === limit && last
                ? cursor({ updatedAt: last.updated_at, taskId: last.task_id }) : null;
            return Object.freeze({ tasks: Object.freeze(tasks), skipped, nextCursor });
        }, false);
    }

    /** 未投递通知（有界）。坏行同样只计数。 */
    readOutbox(input: unknown = {}): Readonly<{ entries: readonly AgentLoopOutboxEntry[]; skipped: number }> {
        const value = exact(input, [], ['limit']);
        const limit = boundedLimit(value.limit, 64);
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM agent_loop_outbox
                WHERE delivered_at IS NULL ORDER BY seq ASC LIMIT ?`).all(limit) as SqlRow[];
            const entries: AgentLoopOutboxEntry[] = [];
            let skipped = 0;
            for (const row of rows) {
                const digest = String(row.event_digest);
                if (!HASH.test(digest) || !Number.isSafeInteger(Number(row.revision))) {
                    skipped += 1;
                    continue;
                }
                entries.push(Object.freeze({
                    seq: Number(row.seq),
                    taskId: String(row.task_id),
                    revision: Number(row.revision),
                    eventId: String(row.event_id),
                    eventDigest: digest,
                    createdAt: String(row.created_at),
                }));
            }
            return Object.freeze({ entries: Object.freeze(entries), skipped });
        }, false);
    }

    /** 确认投递：只标记，不删除（outbox 也是审计的一部分）。 */
    ackOutbox(input: unknown): number {
        const value = exact(input, ['seqs']);
        if (!Array.isArray(value.seqs) || value.seqs.length === 0 || value.seqs.length > 256
            || value.seqs.some((seq) => !Number.isSafeInteger(seq) || Number(seq) < 1)) {
            reject('agent-loop-projection-input-invalid');
        }
        const now = timestamp(this.#now());
        const seqs = value.seqs as number[];
        return this.#transaction(() => {
            let changed = 0;
            const statement = this.#db.prepare(
                'UPDATE agent_loop_outbox SET delivered_at=? WHERE seq=? AND delivered_at IS NULL',
            );
            for (const seq of seqs) changed += Number(statement.run(now, seq).changes);
            return changed;
        });
    }

    /** 某任务的事件序列（append-only，按 seq 升序）。 */
    readEvents(taskIdInput: unknown): readonly AgentLoopTaskEvent[] {
        const taskId = token(taskIdInput);
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                'SELECT * FROM agent_loop_task_event WHERE task_id=? ORDER BY seq ASC',
            ).all(taskId) as SqlRow[];
            return Object.freeze(rows.map((row) => Object.freeze({
                eventVersion: AGENT_LOOP_PROJECTION_EVENT_VERSION,
                eventId: String(row.event_id),
                taskId: String(row.task_id),
                revision: Number(row.revision),
                kind: String(row.kind),
                ...(row.reason_code === null ? {} : { reasonCode: String(row.reason_code) }),
                eventDigest: String(row.event_digest),
                acceptedAt: String(row.accepted_at),
            })));
        }, false);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }
}
