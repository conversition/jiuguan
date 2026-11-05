/** @author Codex @date 2026-10-19 @version 1.0
 * AL-3 骨架：Prepare–Model–Act–Observe–Verify **单步协调器**（`agent-loop-coordinator-v1`）。
 *
 * 它不是「又一个 Agent 循环」，而是一台**可断点续跑的阶段机**：
 * 每次 `step()` 只推进一个阶段，副作用全部落在 AL-1 的 revision CAS 与 AL-2 的归约上。
 *
 * 六条写死的规矩：
 * 1. **阶段顺序来自合同**：每次迁移都过 `assertAgentLoopPhaseTransition`，
 *    协调器不维护第二张阶段表（少一处漂移）。
 * 2. **决策绑定 revision**：`decision.expectedTaskRevision` 必须等于当前 revision，
 *    否则拒绝进入 ACT —— 模型看着旧上下文做的决定不能作用在新状态上。
 * 3. **有副作用 Act 至多一次**：ACT 之前以 `requireNew` 原子预留 `action-started`（带 revision）。
 *    崩溃后重入若看到该 revision 已有 started，就返回 `acted-uncertain` 并要求核对，**绝不重发**。
 * 4. **决策不伪造**：MODEL 产出的真实 Decision 由协调器在进程内暂存并原样交给 ACT；
 *    丢了就报 `coordinator-decision-lost`，绝不用摘要反推一个「长得像」的决策去执行。
 * 5. **passed 与审计DTO不授予完成权**：COMPLETED须由真实冻结评估的一次性live outcome，
 *    经原Store固定双状态同事务出口提交；缺受信端口就保持VERIFY，无两段通用CAS兜底。
 * 6. **MODEL 端口同 revision 至多进入一次**：先在原 Store 原子预留，unknown/崩溃后不自动重调。
 *    预留只表示端口调用意图，不是 Provider 派发、成功、用量或计费回执。
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
    AGENT_LOOP_OBSERVATION_VERSION,
    assertAgentLoopPhaseTransition,
    normalizeAgentLoopDecision,
    type AgentLoopDecisionV1,
    type AgentLoopPhase,
    type AgentLoopTaskState,
    type AgentLoopVerificationDisposition,
    normalizeAgentLoopTaskEnvelope,
    type AgentLoopTaskEnvelopeV1,
    type AgentLoopObservationEnvelopeV1,
} from '@jiuguan/agent-loop-contract';
import type {
    AgentLoopObservationIngest,
    AgentLoopTaskEvent,
    AgentLoopTaskRecord,
    AgentLoopTaskSuspendRequest, AgentLoopTaskResumeRequest, AgentLoopTaskResumeResult,
} from './agent-loop-projection-store.ts';
import { AgentLoopProjectionError } from './agent-loop-projection-store.ts';
import { reduceAgentLoopObservation } from './agent-loop-observation-reducer.ts';
import { readAgentLoopModelOutcome } from './agent-loop-model-outcome.ts';
import { AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF, AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION,
    assertAgentLoopModelCorrectionPolicyBinding, agentLoopModelCorrectionPolicyDigest,
    type AgentLoopModelCorrectionPolicy, type AgentLoopModelCorrectionState } from './agent-loop-model-correction.ts';
import { readAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
    AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT,
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT } from './agent-loop-action-receipt.ts';
import { consumeAgentLoopPreparedExecution, finalizeAgentLoopPreparedExecutionCapabilities, type AgentLoopPreparedExecution } from './agent-loop-prepared-execution.ts';
import type { AgentLoopGetVariablesCapability } from './agent-loop-get-variables-authorization.ts';
import type { AgentLoopRollingSummaryProposalCapability } from './agent-loop-rolling-summary-proposal-authorization.ts';
import type { AgentLoopRollingSummaryApplyCapability } from './agent-loop-rolling-summary-apply-authorization.ts';
import { agentLoopModelInvocationId, createAgentLoopModelInvocationPermit, revokeAgentLoopModelInvocationPermit,
    type AgentLoopModelInvocationPermit } from './agent-loop-model-invocation-permit.ts';
export { agentLoopModelInvocationId } from './agent-loop-model-invocation-permit.ts';
import { isPreparedFrozenAgentLoopCompletion, type AgentLoopCompletionDecision } from './agent-loop-frozen-completion.ts';
import { isPreparedAgentLoopCompletionRequest, revokeAgentLoopCompletionRequest, type AgentLoopCompletionRequest } from './agent-loop-completion-request.ts';
import { foldAgentLoopRepairEvents, type AgentLoopRepairState, type AgentLoopRepairCommitResult } from './agent-loop-repair-budget.ts';
import type {
    AgentLoopExtensionHookOutcome,
    AgentLoopExtensionPatchKey,
    AgentLoopHookName,
    AgentLoopHookPhase,
} from './agent-loop-extension-kernel.ts';

export const AGENT_LOOP_COORDINATOR_VERSION = 'agent-loop-coordinator-v1' as const;

/**
 * 协调器的拒绝/停摆理由闭集。刻意区分「不知道」和「知道不对」：
 * `acted-uncertain` 是不知道，`stale-decision` 是知道不对。
 */
export const AGENT_LOOP_COORDINATOR_REASON_CODES = Object.freeze([
    'coordinator-task-missing',
    'coordinator-fenced',
    'coordinator-terminal-state',
    'coordinator-waiting-state',
    'coordinator-paused-state',
    'coordinator-phase-unsupported',
    'coordinator-prepare-blocked',
    'coordinator-decision-invalid',
    'coordinator-decision-lost',
    'coordinator-stale-decision',
    'coordinator-attempt-mismatch',
    'coordinator-model-not-runnable',
    'coordinator-model-already-reserved',
    'coordinator-model-reservation-failed',
    'coordinator-model-context-changed',
    'coordinator-model-outcome-invalid',
    'coordinator-model-usage-unavailable',
    'coordinator-model-budget-exhausted',
    'coordinator-model-settlement-failed',
    'coordinator-model-correction-unavailable',
    'coordinator-model-correction-blocked',
    'coordinator-act-already-started',
    'coordinator-act-reservation-failed',
    'coordinator-act-uncertain',
    'coordinator-observe-payload-missing',
    'coordinator-completion-request-unavailable',
    'coordinator-verify-unavailable',
    'coordinator-repair-unavailable',
    'coordinator-extension-failed',
    'coordinator-extension-short-circuit',
    'coordinator-extension-after-patch',
] as const);
export type AgentLoopCoordinatorReasonCode =
    typeof AGENT_LOOP_COORDINATOR_REASON_CODES[number];

export type AgentLoopStepOutcome =
    | 'advanced'
    | 'model-correction-ready'
    | 'waiting'
    | 'acted'
    | 'acted-uncertain'
    | 'observed'
    | 'verified'
    | 'blocked';

export interface AgentLoopStepResult {
    readonly coordinatorVersion: typeof AGENT_LOOP_COORDINATOR_VERSION;
    /** 本步执行的阶段。 */
    readonly phase: AgentLoopPhase;
    /** 建议的下一步阶段；`null` = 停在这里等人/等核对。 */
    readonly nextPhase: AgentLoopPhase | null;
    readonly outcome: AgentLoopStepOutcome;
    /** 任务记录；`blocked` 且任务根本不存在时为 undefined（不造占位记录）。 */
    readonly record?: AgentLoopTaskRecord;
    readonly reasonCodes: readonly AgentLoopCoordinatorReasonCode[];
    readonly decision?: AgentLoopDecisionV1;
    /** Opaque post-Prepare-CAS capability; copying its JSON grants no Action authority. */
    readonly getVariablesCapability?: AgentLoopGetVariablesCapability;
    /** Independent one-use shadow-proposal capability; never a read capability or completion proof. */
    readonly rollingSummaryProposalCapability?: AgentLoopRollingSummaryProposalCapability;
    /** Independent one-use apply capability; no Runtime route or completion authority. */
    readonly rollingSummaryApplyCapability?: AgentLoopRollingSummaryApplyCapability;
    readonly wait?: Readonly<{
        waitId: string;
        kind: 'input' | 'approval' | 'event' | 'child' | 'verification';
        correlationRef: string;
        resumePredicateRef: string;
    }>;
    readonly verification?: Readonly<{
        disposition: AgentLoopVerificationDisposition;
        reasonCodes: readonly string[];
    }>;
    readonly action?: Readonly<{ actionId: string; decisionKind: string }>;
    /** 扩展给出的细分理由码（附加信息，不扩协调器闭集）。 */
    readonly extensionReasonCodes?: readonly string[];
    readonly observation?: Readonly<{
        classification: AgentLoopObservationIngest['classification'];
        satisfiesVerification: boolean;
    }>;
}

/** ACT 阶段唯一出口（AL-4 会把真 Gateway 接上来；这里只要一个端口）。 */
export interface AgentLoopActResult {
    readonly sourceKind: 'tool' | 'domain-readback';
    readonly sourceRef: string;
    readonly payloadDigest: string;
    readonly payloadRef?: string;
    readonly completeness: 'complete' | 'partial' | 'unknown';
    readonly evidenceRefs: readonly string[];
    readonly usageDelta?: Readonly<{
        modelCalls: number; toolCalls: number; writes: number; inputTokens: number;
        outputTokens: number; costMicrousd: number; wallMs: number; highRiskActions: number;
    }>;
}

/** Exact metadata coordinate only. The trusted host must independently resolve the durable child result. */
export interface AgentLoopChildWaitRequest {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly ownerId: string;
    readonly attemptId: string;
    readonly reservationId: string;
    readonly waitId: string;
}

export interface AgentLoopChildReconcileResult {
    readonly status: 'joined' | 'already-joined' | 'rejected' | 'already-rejected' | 'stale' | 'inconclusive';
    readonly record: AgentLoopTaskRecord;
    readonly observationId?: string;
}

export interface AgentLoopCoordinatorPorts {
    readonly clock: () => string;
    readonly suspension?: {
        suspend(input: AgentLoopTaskSuspendRequest): AgentLoopTaskRecord;
        resume(input: AgentLoopTaskResumeRequest): AgentLoopTaskResumeResult;
    };
    /** Synchronous host-only metadata exchange. No Model output or caller DTO can commit a child join. */
    readonly childResults?: {
        wait(input: AgentLoopChildWaitRequest): AgentLoopTaskRecord;
        reconcile(input: AgentLoopChildWaitRequest): AgentLoopChildReconcileResult;
    };
    readonly taskStore: {
        read(taskId: string): AgentLoopTaskRecord | null;
        commit(input: unknown): AgentLoopTaskRecord;
        annotate(input: unknown): AgentLoopTaskRecord;
        ingestObservation(input: unknown): AgentLoopObservationIngest;
        readEvents(taskId: string): readonly AgentLoopTaskEvent[];
        readRepairState?(input: Readonly<{ taskId: string; expectedRevision: number }>): AgentLoopRepairState;
        readModelCorrectionState?(input: Readonly<{ taskId: string; expectedRevision: number;
            policy: AgentLoopModelCorrectionPolicy }>): AgentLoopModelCorrectionState;
        readObservations(taskId: string): readonly Readonly<{ observationId: string }>[];
        readRefs?(taskId: string): readonly import('./agent-loop-projection-store.ts').AgentLoopArtifactRefRecord[];
    };
    /** PREPARE：只读检查；首次执行 grant 必须是受信宿主的一次性品牌回执，与阶段同次 CAS。 */
    readonly prepare: (input: Readonly<{
        envelope: AgentLoopTaskEnvelopeV1;
        revision: number;
    }>) => Promise<Readonly<{ attemptId?: string }> | AgentLoopPreparedExecution>;
    /** MODEL：五类 Decision，或受信宿主品牌的 Decision+Gateway 用量回执。
     * 调用前持久预留；失败后同 attempt 未闭环的 invocation 不自动重调；模型 JSON 无记账权。
     */
    readonly decide: (input: Readonly<{
        envelope: AgentLoopTaskEnvelopeV1;
        revision: number;
        /** Only the durable reservation winner receives this host capability. Not Provider JSON. */
        invocationPermit?: AgentLoopModelInvocationPermit;
    }>) => Promise<unknown>;
    /** ACT：委托唯一 ActionGateway。抛错 = 副作用可能已经发生。 */
    readonly act: (input: Readonly<{
        actionRequest: Readonly<{
            contractVersion: 'agent-loop-action-request-v1';
            actionId: string;
            taskId: string;
            attemptId: string;
            harnessRunId: string;
            decisionId: string;
            expectedTaskRevision: number;
            decisionDigest: string;
            actionContractRef: string;
            args: Record<string, unknown>;
            requestedAt: string;
        }>;
        decision: AgentLoopDecisionV1;
    }>) => Promise<AgentLoopActResult>;
    /** VERIFY：只运行登记的 verifier set；不决定 COMPLETED。 */
    readonly verify: (input: Readonly<{
        envelope: AgentLoopTaskEnvelopeV1;
        revision: number;
        actionId: string | null;
    }>) => Promise<Readonly<{
        disposition: AgentLoopVerificationDisposition;
        reasonCodes: readonly string[];
    }>>;
    /** Host chooses a pinned policy inside the original Store transaction. This
     * port only moves metadata; it grants no Model/Action/budget/attempt rights. */
    readonly repair?: {
        commit(input: Readonly<{ record: AgentLoopTaskRecord; ownerId: string;
            expectedSnapshotDigest: string }>): AgentLoopRepairCommitResult;
    };
    /** Separate versioned contract only. A metadata step consumes one known
     * rejection inside the original Store; it never dispatches or grants budget.
     * Production single-pass Maintenance intentionally does not install this port. */
    readonly modelCorrection?: {
        readonly policy: AgentLoopModelCorrectionPolicy;
        advance(input: Readonly<{ record: AgentLoopTaskRecord; ownerId: string;
            policy: AgentLoopModelCorrectionPolicy; expectedSnapshotDigest: string }>): AgentLoopTaskRecord;
    };
    /** Trusted synchronous scope lookup for the one shared Coordinator. The
     * initial policy exists only after real Prepare; never a mutable getter,
     * process-global current policy or a replacement Coordinator per task. */
    readonly modelCorrectionFor?: (input: Readonly<{ record: AgentLoopTaskRecord; ownerId: string }>) =>
        AgentLoopCoordinatorPorts['modelCorrection'];
    /**
     * 生命周期扩展（AL-3E）。`runHook` 直接绑内核的 `runHook` 即可。
     * 扩展只能**提议**：内核对 patch 做 revision 校验，对 shortCircuit 停链，
     * 对 required 失败 fail-closed —— 扩展没有任何写入口。
     */
    readonly hooks?: {
        runHook(input: Readonly<{
            hook: AgentLoopHookName;
            phase: AgentLoopHookPhase;
            context: Readonly<Record<string, unknown>>;
        }>): Promise<AgentLoopExtensionHookOutcome>;
    };
    /**
     * AL-5 完成门。VERIFY 通过后由它决定「能不能真的算完成」。
     * 缺端口 ⇒ 协调器保持现状（只返回 verify 结果、不改状态），绝不自行宣布完成。
     */
    readonly completion?: {
        /** Optional synchronous host-only request, independent of the actual Model Decision. */
        request?(input: Readonly<{ record: AgentLoopTaskRecord; ownerId: string; actionWatermark: string | null }>): unknown;
        /** Runtime-scoped exchange into the original Store; no general taskStore write port. */
        commitRequested?(input: Readonly<{ request: AgentLoopCompletionRequest;
            record: AgentLoopTaskRecord; ownerId: string; actionWatermark: string | null }>): AgentLoopTaskRecord;
        evaluate(input: Readonly<{
            envelope: AgentLoopTaskEnvelopeV1;
            revision: number;
            attemptId: string;
            actionWatermark: string | null;
            repairAttempts: number;
        }>): Promise<AgentLoopCompletionDecision>;
        /** Synchronous trusted live-outcome exchange, not an Envelope/general CAS port. */
        commitVerified?(input: Readonly<{ evaluation: AgentLoopCompletionDecision;
            record: AgentLoopTaskRecord; ownerId: string }>): AgentLoopTaskRecord;
    };
    /** 故障注入（测试用）：在该阶段开始时被调用，抛错即模拟崩溃。 */
    readonly fault?: (phase: AgentLoopPhase) => void;
}

const TERMINAL_STATES = new Set<AgentLoopTaskState>(['COMPLETED', 'FAILED', 'CANCELLED']);

/** 阶段与扩展钩子的对应关系。`task-create` 由建任务方在 `create()` 前后自行驱动。 */
const HOOK_FOR_PHASE: Readonly<Record<AgentLoopPhase, AgentLoopHookName>> = Object.freeze({
    PREPARE: 'prepare',
    MODEL: 'model',
    ACT: 'action',
    OBSERVE: 'state',
    VERIFY: 'verify',
});

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function childResultRecord(
    input: unknown,
    keys: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (nodeTypes.isPromise(input)) {
        void Promise.prototype.then.call(
            input,
            () => undefined,
            () => undefined,
        );
        throw new Error('coordinator-child-result-input-invalid');
    }
    if (
        !input ||
        typeof input !== 'object' ||
        nodeTypes.isProxy(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    ) {
        throw new Error('coordinator-child-result-input-invalid');
    }
    const names = Reflect.ownKeys(input);
    if (
        names.some((key) => typeof key !== 'string' || ![...keys, ...optional].includes(key)) ||
        keys.some((key) => !Object.hasOwn(input, key))
    )
        throw new Error('coordinator-child-result-input-invalid');
    for (const key of names) {
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) {
            throw new Error('coordinator-child-result-input-invalid');
        }
    }
    return input as Record<string, unknown>;
}

function childWaitRequest(input: unknown): AgentLoopChildWaitRequest {
    const value = childResultRecord(input, [
        'taskId',
        'expectedRevision',
        'ownerId',
        'attemptId',
        'reservationId',
        'waitId',
    ]);
    for (const key of ['taskId', 'ownerId', 'attemptId', 'reservationId', 'waitId']) {
        if (typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(value[key] as string)) {
            throw new Error('coordinator-child-result-input-invalid');
        }
    }
    if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) {
        throw new Error('coordinator-child-result-input-invalid');
    }
    return Object.freeze({
        taskId: value.taskId as string,
        expectedRevision: Number(value.expectedRevision),
        ownerId: value.ownerId as string,
        attemptId: value.attemptId as string,
        reservationId: value.reservationId as string,
        waitId: value.waitId as string,
    });
}

function modelBudgetEnvelope(record: AgentLoopTaskRecord, observation?: AgentLoopObservationEnvelopeV1): AgentLoopTaskEnvelopeV1 {
    if (!observation) return record.envelope;
    const reduction = reduceAgentLoopObservation({ envelope: record.envelope, observation });
    if (reduction.classification !== 'applied' || !reduction.envelope
        || reduction.reasonCodes.includes('observation-budget-overrun')) throw new Error('agent-loop-model-budget-invalid');
    return reduction.envelope;
}

/** 决策摘要：五类 Decision 都只由合同字段构成，因此摘要可复算。 */
export function agentLoopDecisionDigest(decision: AgentLoopDecisionV1): string {
    return hash(decision);
}

/** 动作身份：同一 (task, attempt, revision, decision) 只会有一个 actionId。 */
export function agentLoopActionId(input: Readonly<{
    taskId: string;
    attemptId: string;
    expectedTaskRevision: number;
    decisionDigest: string;
}>): string {
    return hash({
        kind: 'agent-loop-action-id-v1',
        taskId: input.taskId,
        attemptId: input.attemptId,
        expectedTaskRevision: input.expectedTaskRevision,
        decisionDigest: input.decisionDigest,
    });
}

export class AgentLoopCoordinator {
    readonly #ports: AgentLoopCoordinatorPorts;
    /**
     * MODEL → ACT 之间的决策暂存。**进程内**，不落库：
     * 决策是「这一步的输入」，不是投影事实；丢了就老实报 `decision-lost`，
     * 而不是拿摘要反推一个像样的东西去执行。
     */
    readonly #pending = new Map<string, { revision: number; decision: AgentLoopDecisionV1 }>();

    constructor(ports: AgentLoopCoordinatorPorts) {
        if (ports.modelCorrection !== undefined && ports.modelCorrectionFor !== undefined) {
            throw new Error('agent-loop-model-correction-port-conflict');
        }
        this.#ports = ports;
    }

    #childRecord(request: AgentLoopChildWaitRequest, allowStaleAttempt = false): AgentLoopTaskRecord {
        const record = this.#ports.taskStore.read(request.taskId);
        const now = Date.parse(this.#ports.clock());
        if (
            !record ||
            record.fenced ||
            record.ownerId !== request.ownerId ||
            (!allowStaleAttempt && record.envelope.currentAttemptId !== request.attemptId) ||
            record.envelope.parentTaskId !== undefined ||
            record.envelope.rootTaskId !== request.taskId ||
            !record.leaseExpiresAt ||
            !Number.isSafeInteger(now) ||
            !Number.isSafeInteger(Date.parse(record.leaseExpiresAt)) ||
            Date.parse(record.leaseExpiresAt) <= now ||
            request.expectedRevision > record.revision
        )
            throw new Error('coordinator-child-result-denied');
        return record;
    }

    #childReadback(
        request: AgentLoopChildWaitRequest,
        returned: unknown,
        allowStaleAttempt = false,
    ): AgentLoopTaskRecord {
        const value = childResultRecord(returned, [
            'envelope',
            'envelopeDigest',
            'ownerId',
            'leaseExpiresAt',
            'fenced',
            'fenceReason',
            'revision',
        ]);
        if (nodeTypes.isProxy(value.envelope)) throw new Error('coordinator-child-result-input-invalid');
        const envelope = normalizeAgentLoopTaskEnvelope(value.envelope);
        const actual = this.#childRecord(request, allowStaleAttempt);
        if (
            JSON.stringify(envelope) !== JSON.stringify(actual.envelope) ||
            ['envelopeDigest', 'ownerId', 'leaseExpiresAt', 'fenced', 'fenceReason', 'revision'].some(
                (key) => value[key] !== actual[key as keyof AgentLoopTaskRecord],
            )
        ) {
            throw new Error('coordinator-child-result-readback-invalid');
        }
        return actual;
    }

    /** Enter only the existing child wait from PREPARE; this does not dispatch or grant a new attempt. */
    waitForChild(input: AgentLoopChildWaitRequest): AgentLoopTaskRecord {
        const request = childWaitRequest(input);
        const port = this.#ports.childResults;
        if (!port) throw new Error('coordinator-child-result-unavailable');
        const before = this.#childRecord(request);
        const replay =
            before.envelope.state === 'WAITING_EVENT' &&
            before.envelope.wait?.kind === 'child' &&
            before.envelope.wait.waitId === request.waitId;
        if (
            before.envelope.phase !== 'PREPARE' ||
            (!replay &&
                (before.envelope.state !== 'RUNNING' ||
                    before.envelope.wait !== undefined ||
                    request.expectedRevision !== before.revision))
        ) {
            throw new Error('coordinator-child-result-denied');
        }
        const actual = this.#childReadback(request, port.wait(request));
        if (
            actual.envelope.state !== 'WAITING_EVENT' ||
            actual.envelope.phase !== 'PREPARE' ||
            actual.envelope.wait?.kind !== 'child' ||
            actual.envelope.wait.waitId !== request.waitId ||
            JSON.stringify(actual.envelope.budget) !== JSON.stringify(before.envelope.budget) ||
            (replay ? actual.envelopeDigest !== before.envelopeDigest : actual.revision !== before.revision + 1)
        ) {
            throw new Error('coordinator-child-result-readback-invalid');
        }
        this.forget(request.taskId);
        return actual;
    }

    /** Notify/join is delegated to the original Store's trusted port; ordinary step() never wakes a wait. */
    resumeChildResult(input: AgentLoopChildWaitRequest): AgentLoopChildReconcileResult {
        const request = childWaitRequest(input);
        const port = this.#ports.childResults;
        if (!port) throw new Error('coordinator-child-result-unavailable');
        const before = this.#childRecord(request, true);
        const waiting =
            before.envelope.state === 'WAITING_EVENT' &&
            before.envelope.wait?.kind === 'child' &&
            before.envelope.wait.waitId === request.waitId;
        const previouslyJoined =
            before.envelope.state === 'RUNNING' &&
            before.envelope.wait === undefined &&
            ['PREPARE', 'MODEL'].includes(before.envelope.phase);
        const auditOnly =
            TERMINAL_STATES.has(before.envelope.state) ||
            (before.envelope.state === 'WAITING_EVENT' && before.envelope.wait?.kind === 'child');
        if ((!waiting || before.envelope.phase !== 'PREPARE') && !previouslyJoined && !auditOnly) {
            throw new Error('coordinator-child-result-denied');
        }
        const value = childResultRecord(port.reconcile(request), ['status', 'record'], ['observationId']);
        if (
            !['joined', 'already-joined', 'rejected', 'already-rejected', 'stale', 'inconclusive'].includes(value.status as string) ||
            (value.observationId !== undefined &&
                (typeof value.observationId !== 'string' ||
                    !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(value.observationId)))
        ) {
            throw new Error('coordinator-child-result-readback-invalid');
        }
        const actual = this.#childReadback(request, value.record, true);
        const joined = value.status === 'joined' || value.status === 'already-joined';
        const rejected = value.status === 'rejected' || value.status === 'already-rejected';
        const semantic = (record: AgentLoopTaskRecord) => {
            const { revision: ignoredRevision, updatedAt: ignoredTime, ...rest } = record.envelope;
            void ignoredRevision;
            void ignoredTime;
            return JSON.stringify(rest);
        };
        const acceptedChild = waiting
            ? actual.envelope.children.find((child) => child.taskId === before.envelope.wait!.correlationRef)
            : undefined;
        if (
            JSON.stringify(actual.envelope.budget) !== JSON.stringify(before.envelope.budget) ||
            actual.revision < before.revision ||
            (joined &&
                (actual.envelope.state !== 'RUNNING' ||
                    actual.envelope.wait !== undefined ||
                    !['PREPARE', 'MODEL'].includes(actual.envelope.phase))) ||
            (value.status === 'joined' &&
                (!waiting ||
                    actual.envelope.phase !== 'PREPARE' ||
                    actual.revision <= before.revision ||
                    acceptedChild?.state !== 'COMPLETED' ||
                    acceptedChild.joinState !== 'accepted' ||
                    !acceptedChild.outcomeRef ||
                    acceptedChild.evidenceRefs.length === 0)) ||
            (value.status === 'already-joined' &&
                (!previouslyJoined || actual.envelopeDigest !== before.envelopeDigest)) ||
            (value.status === 'rejected' && (!waiting || actual.envelope.state !== 'RUNNING'
                || actual.envelope.phase !== 'PREPARE' || actual.envelope.wait !== undefined
                || actual.revision <= before.revision || acceptedChild?.joinState !== 'rejected'
                || !['FAILED', 'CANCELLED'].includes(acceptedChild.state)
                || !actual.envelope.blockers.some(blocker => blocker.blockerId === acceptedChild.outcomeRef && blocker.status === 'open'))) ||
            (value.status === 'already-rejected' && (!previouslyJoined || actual.envelopeDigest !== before.envelopeDigest
                || !actual.envelope.children.some(child => child.joinState === 'rejected'))) ||
            (!joined && !rejected &&
                (actual.envelope.state !== before.envelope.state ||
                    actual.envelope.phase !== before.envelope.phase ||
                    semantic(actual) !== semantic(before))) ||
            (value.status === 'stale' && actual.envelopeDigest !== before.envelopeDigest) ||
            (before.envelope.currentAttemptId !== request.attemptId && value.status !== 'stale')
        ) {
            throw new Error('coordinator-child-result-readback-invalid');
        }
        if (joined || rejected) this.forget(request.taskId);
        return Object.freeze({
            status: value.status as AgentLoopChildReconcileResult['status'],
            record: actual,
            ...(value.observationId === undefined ? {} : { observationId: value.observationId as string }),
        });
    }

    /**
     * 推进一步。幂等语义：
     * - 同一 revision 重复调用不会累积副作用（ACT 有 `action-started` 守卫，OBSERVE 有 AL-2 去重）；
     * - 崩溃恢复最多重放 PREPARE / 只读检查。
     */
    async step(input: Readonly<{ taskId: string; ownerId: string }>): Promise<AgentLoopStepResult> {
        const record = this.#ports.taskStore.read(input.taskId);
        if (!record) return this.#block('PREPARE', 'coordinator-task-missing');
        if (record.fenced) return this.#block(record.envelope.phase, 'coordinator-fenced', record);
        if (TERMINAL_STATES.has(record.envelope.state)) {
            return this.#block(record.envelope.phase, 'coordinator-terminal-state', record);
        }
        if (record.envelope.state.startsWith('WAITING_')) {
            return this.#block(
                record.envelope.phase,
                record.envelope.phase === 'MODEL' ? 'coordinator-model-not-runnable' : 'coordinator-waiting-state',
                record,
            );
        }
        if (record.envelope.state === 'PAUSED') {
            return this.#block(
                record.envelope.phase,
                record.envelope.phase === 'MODEL' ? 'coordinator-model-not-runnable' : 'coordinator-paused-state',
                record,
            );
        }
        this.#ports.fault?.(record.envelope.phase);
        const phase = record.envelope.phase;
        const hook = HOOK_FOR_PHASE[phase];
        const hooks = this.#ports.hooks;

        // ── before 钩子：只能补丁 / 短路 / 失败。扩展没有写入口，补丁交给下面的提交。 ──
        let writes: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>> | undefined;
        const observations: { extensionId: string; proposal: unknown }[] = [];
        if (hooks) {
            const before = await hooks.runHook({
                hook, phase: 'before', context: this.#hookContext(record),
            });
            if (!before.ok) {
                return this.#block(phase, 'coordinator-extension-failed', record, before.reasonCodes);
            }
            if (before.shortCircuit) {
                return this.#block(phase, 'coordinator-extension-short-circuit', record,
                    before.reasonCodes);
            }
            for (const patch of before.patches) {
                if (patch.baseRevision !== record.revision) {
                    // 钩子补丁必须绑定当前 revision（内核已校验，这里再守一次，因为
                    // 内核可能被多个调用方共用）。
                    return this.#block(phase, 'coordinator-extension-failed', record, ['extension-patch-stale']);
                }
                writes = { ...(writes ?? {}), ...patch.writes };
            }
            for (const item of before.observations) {
                observations.push({ extensionId: item.extensionId, proposal: item.observation });
            }
        }

        let result: AgentLoopStepResult;
        switch (phase) {
            case 'PREPARE': result = await this.#prepare(record, input.ownerId, writes); break;
            case 'MODEL': result = await this.#model(record, input.ownerId, writes); break;
            case 'ACT': result = await this.#act(record, input.ownerId, writes); break;
            case 'OBSERVE': result = await this.#observe(record, input.ownerId, writes); break;
            case 'VERIFY': result = await this.#verify(record, input.ownerId, writes); break;
            default:
                return this.#block(phase, 'coordinator-phase-unsupported', record);
        }

        if (!hooks || !result.record) return result;

        // ── after 钩子：只观察。想改就报错（不静默丢弃）。 ──
        const after = await hooks.runHook({
            hook, phase: 'after', context: this.#hookContext(result.record),
        });
        if (!after.ok) {
            return this.#block(phase, 'coordinator-extension-failed', result.record, after.reasonCodes);
        }
        if (after.patches.length > 0) {
            return this.#block(phase, 'coordinator-extension-after-patch', result.record, []);
        }
        for (const item of after.observations) {
            observations.push({ extensionId: item.extensionId, proposal: item.observation });
        }
        if (observations.length === 0) return result;
        return this.#ingestHookObservations(result, observations, input.ownerId);
    }

    /** 扩展上下文：只给字段，不给 Store。内核再按声明投影一次。 */
    #hookContext(record: AgentLoopTaskRecord): Readonly<Record<string, unknown>> {
        const envelope = record.envelope;
        return Object.freeze({
            taskId: envelope.taskId,
            attemptId: envelope.currentAttemptId ?? null,
            revision: record.revision,
            phase: envelope.phase,
            state: envelope.state,
            taskKind: envelope.taskKind,
            taskContractRef: envelope.taskContractRef,
            budget: envelope.budget,
            todos: envelope.todos,
            blockers: envelope.blockers,
            confirmedFacts: envelope.confirmedFacts,
            artifacts: envelope.artifacts,
            goal: envelope.goal,
            grantedAuthorities: Object.freeze([]),
        });
    }

    /** 把钩子给的观测（只有引用）交给 AL-2 归约；不构造正文。 */
    #ingestHookObservations(
        result: AgentLoopStepResult,
        observations: readonly { extensionId: string; proposal: unknown }[],
        ownerId: string,
    ): AgentLoopStepResult {
        let record = result.record!;
        for (const item of observations) {
            const proposal = item.proposal as {
                observationId: string; sourceKind: string; sourceRef: string;
                payloadDigest: string; completeness: string; evidenceRefs: readonly string[];
            };
            const now = this.#ports.clock();
            try {
                const ingested = this.#ports.taskStore.ingestObservation({
                    observation: {
                        contractVersion: AGENT_LOOP_OBSERVATION_VERSION,
                        observationId: proposal.observationId,
                        taskId: record.envelope.taskId,
                        attemptId: record.envelope.currentAttemptId ?? 'attempt.unknown',
                        observedForTaskRevision: record.revision,
                        sourceKind: proposal.sourceKind,
                        sourceRef: proposal.sourceRef,
                        observedAt: now,
                        ingestedAt: now,
                        payloadDigest: proposal.payloadDigest,
                        completeness: proposal.completeness,
                        evidenceRefs: proposal.evidenceRefs,
                    },
                    expectedRevision: record.revision,
                    ownerId,
                });
                record = ingested.record;
            } catch {
                return this.#block(result.phase, 'coordinator-extension-failed', record,
                    ['extension-observation-invalid']);
            }
        }
        return Object.freeze({ ...result, record });
    }

    suspendTask(input: AgentLoopTaskSuspendRequest): AgentLoopTaskRecord {
        const request = childResultRecord(input, ['taskId', 'expectedRevision', 'ownerId', 'attemptId'], ['wait', 'pauseId']);
        const before = this.#ports.taskStore.read(String(request.taskId));
        if (!before || !this.#ports.suspension) throw new Error('coordinator-suspension-unavailable');
        const record = this.#ports.suspension.suspend(input);
        const actual = this.#ports.taskStore.read(before.envelope.taskId);
        if (!actual || actual.envelopeDigest !== record.envelopeDigest || actual.revision !== before.revision + 1
            || actual.ownerId !== null || actual.leaseExpiresAt !== null
            || (!actual.envelope.state.startsWith('WAITING_') && actual.envelope.state !== 'PAUSED')
            || JSON.stringify(actual.envelope.budget) !== JSON.stringify(before.envelope.budget))
            throw new Error('coordinator-suspension-readback-invalid');
        this.forget(actual.envelope.taskId);
        return actual;
    }

    resumeTask(input: AgentLoopTaskResumeRequest): AgentLoopTaskResumeResult {
        const request = childResultRecord(input, ['taskId', 'expectedRevision', 'ownerId', 'attemptId', 'suspensionId', 'eventRef', 'leaseMs']);
        const before = this.#ports.taskStore.read(String(request.taskId));
        if (!before || !this.#ports.suspension) throw new Error('coordinator-suspension-unavailable');
        const result = this.#ports.suspension.resume(input);
        const actual = this.#ports.taskStore.read(before.envelope.taskId);
        if (!actual || actual.envelopeDigest !== result.record.envelopeDigest
            || !['resumed', 'already-resumed', 'stale', 'inconclusive'].includes(result.status)
            || JSON.stringify(actual.envelope.budget) !== JSON.stringify(before.envelope.budget)
            || (result.status === 'resumed' ? actual.revision !== before.revision + 1 || actual.envelope.wait !== undefined
                || !['RUNNING', 'VERIFYING'].includes(actual.envelope.state) || actual.ownerId !== request.ownerId
                : actual.envelopeDigest !== before.envelopeDigest)) throw new Error('coordinator-suspension-readback-invalid');
        if (result.status === 'resumed') this.forget(actual.envelope.taskId);
        return Object.freeze({ status: result.status, record: actual });
    }

    /** 丢弃暂存决策（换 owner / 换 attempt / 任务围栏时调用）。 */
    forget(taskId: string): void {
        this.#pending.delete(taskId);
    }

    #block(
        phase: AgentLoopPhase,
        code: AgentLoopCoordinatorReasonCode,
        record?: AgentLoopTaskRecord,
        extra: readonly string[] = [],
    ): AgentLoopStepResult {
        // 协调器理由码必须留在闭集里：扩展给的细分码只作为附加信息，不混进类型。
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase,
            nextPhase: null,
            outcome: 'blocked' as const,
            ...(record === undefined ? {} : { record }),
            reasonCodes: Object.freeze([code]),
            ...(extra.length === 0 ? {} : { extensionReasonCodes: Object.freeze([...extra]) }),
        });
    }

    /** Failed Model output never advances phase. Known spend is still recorded once; unknown has no delta. */
    #settleBlockedModel(record: AgentLoopTaskRecord, ownerId: string, observation: AgentLoopObservationEnvelopeV1,
        reason: AgentLoopCoordinatorReasonCode, modelOutcome?: unknown): AgentLoopStepResult {
        try {
            const settled = this.#ports.taskStore.ingestObservation({ observation,
                expectedRevision: record.revision, ownerId,
                ...(modelOutcome === undefined ? {} : { modelOutcome }) });
            return this.#block('MODEL', reason, settled.record);
        } catch {
            return this.#block('MODEL', 'coordinator-model-settlement-failed', record);
        }
    }

    #modelCorrectionPort(record: AgentLoopTaskRecord, ownerId: string): AgentLoopCoordinatorPorts['modelCorrection'] {
        const resolver = this.#ports.modelCorrectionFor;
        if (resolver === undefined) return this.#ports.modelCorrection;
        if (typeof resolver !== 'function' || nodeTypes.isProxy(resolver)) throw new Error('agent-loop-model-correction-port-invalid');
        const value = resolver({ record, ownerId });
        if (nodeTypes.isPromise(value)) {
            void Promise.prototype.then.call(value, () => undefined, () => undefined);
            throw new Error('agent-loop-model-correction-port-invalid');
        }
        if (value === undefined) return undefined;
        if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('agent-loop-model-correction-port-invalid');
        const keys = Reflect.ownKeys(value), policy = Object.getOwnPropertyDescriptor(value, 'policy');
        const advance = Object.getOwnPropertyDescriptor(value, 'advance');
        if (keys.length !== 2 || !keys.includes('policy') || !keys.includes('advance')
            || !policy?.enumerable || !Object.hasOwn(policy, 'value') || !advance?.enumerable || !Object.hasOwn(advance, 'value')
            || typeof advance.value !== 'function' || nodeTypes.isProxy(advance.value)) throw new Error('agent-loop-model-correction-port-invalid');
        return Object.freeze({ policy: assertAgentLoopModelCorrectionPolicyBinding(policy.value, record), advance: advance.value });
    }

    #commit(record: AgentLoopTaskRecord, ownerId: string, patch: {
        state?: AgentLoopTaskState;
        phase: AgentLoopPhase;
        wait?: AgentLoopTaskEnvelopeV1['wait'];
        currentAttemptId?: string;
        budget?: AgentLoopTaskEnvelopeV1['budget'];
        artifacts?: AgentLoopTaskEnvelopeV1['artifacts'];
        artifactRefs?: readonly import('./agent-loop-projection-store.ts').AgentLoopArtifactRefDescriptor[];
    }, eventId: string, kind: string, reasonCode?: string,
    writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    providerObservation?: AgentLoopObservationEnvelopeV1, modelOutcome?: unknown, modelPolicy?: AgentLoopModelCorrectionPolicy): AgentLoopTaskRecord {
        // 阶段迁移一律过合同，协调器不维护第二张表。
        assertAgentLoopPhaseTransition(record.envelope.phase, patch.phase);
        const now = this.#ports.clock();
        const base = modelBudgetEnvelope(record, providerObservation);
        const next = normalizeAgentLoopTaskEnvelope({
            ...base,
            // 扩展补丁只改内容类键；形状由合同 normalizer 复核，坏补丁直接抛错（fail-closed）。
            ...(writes ?? {}),
            ...(patch.state === undefined ? {} : { state: patch.state }),
            ...(patch.currentAttemptId === undefined
                ? {} : { currentAttemptId: patch.currentAttemptId }),
            ...(patch.budget === undefined ? {} : { budget: patch.budget }),
            ...(patch.artifacts === undefined ? {} : { artifacts: patch.artifacts }),
            // 进入 WAITING 时才带 wait；离开时显式清掉，避免旧 wait 残留。
            wait: patch.wait,
            phase: patch.phase,
            revision: record.revision + 1,
            updatedAt: providerObservation && base.updatedAt > now ? base.updatedAt : now,
        });
        return this.#ports.taskStore.commit({
            taskId: record.envelope.taskId,
            expectedRevision: record.revision,
            ownerId,
            envelope: next,
            event: { eventId, kind, ...(reasonCode === undefined ? {} : { reasonCode }) },
            ...(patch.budget ? { requirePristinePrepare: true } : {}),
            ...(providerObservation ? { providerObservation } : {}),
            ...(modelOutcome === undefined ? {} : { modelOutcome }),
            ...(patch.artifactRefs ? { artifactRefs: patch.artifactRefs } : {}),
            ...(record.envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
                ? { modelCorrectionPolicy: modelPolicy ?? this.#modelCorrectionPort(record, ownerId)?.policy } : {}),
        });
    }

    /**
     * 只改状态、**不动阶段**的提交。
     *
     * 用途：进入 WAITING。合同里 MODEL 只能去 ACT，而等待不是「往下走」而是「停在原地等人」，
     * 所以这里保持 phase 不变、只写 state + wait。恢复后仍从同一阶段继续（重新决定）。
     */
    #commitState(record: AgentLoopTaskRecord, ownerId: string, patch: {
        state: AgentLoopTaskState;
        wait?: AgentLoopTaskEnvelopeV1['wait'];
        completion?: AgentLoopTaskEnvelopeV1['completion'];
    }, eventId: string, kind: string, reasonCode: string,
    writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    providerObservation?: AgentLoopObservationEnvelopeV1, modelOutcome?: unknown, modelPolicy?: AgentLoopModelCorrectionPolicy): AgentLoopTaskRecord {
        const base = modelBudgetEnvelope(record, providerObservation);
        const now = this.#ports.clock();
        const next = normalizeAgentLoopTaskEnvelope({
            ...base,
            ...(writes ?? {}),
            state: patch.state,
            wait: patch.wait,
            ...(patch.completion === undefined ? {} : { completion: patch.completion }),
            revision: record.revision + 1,
            updatedAt: providerObservation && base.updatedAt > now ? base.updatedAt : now,
        });
        return this.#ports.taskStore.commit({
            taskId: record.envelope.taskId,
            expectedRevision: record.revision,
            ownerId,
            envelope: next,
            event: { eventId, kind, reasonCode },
            ...(providerObservation ? { providerObservation } : {}),
            ...(modelOutcome === undefined ? {} : { modelOutcome }),
            ...(record.envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
                ? { modelCorrectionPolicy: modelPolicy ?? this.#modelCorrectionPort(record, ownerId)?.policy } : {}),
        });
    }

    async #prepare(
        record: AgentLoopTaskRecord,
        ownerId: string,
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): Promise<AgentLoopStepResult> {
        const envelope = record.envelope;
        if (envelope.children.some((child) => child.joinState === 'rejected' || child.requirement === 'required' && child.joinState !== 'accepted')) {
            return this.#block('PREPARE', 'coordinator-prepare-blocked', record);
        }
        let prepared: Awaited<ReturnType<AgentLoopCoordinatorPorts['prepare']>>;
        let grant: ReturnType<typeof consumeAgentLoopPreparedExecution> = null;
        let attemptId: string | undefined;
        try {
            prepared = await this.#ports.prepare({ envelope, revision: record.revision });
            const current = this.#ports.taskStore.read(envelope.taskId);
            if (!current || current.fenced || current.ownerId !== ownerId || current.revision !== record.revision
                || current.envelopeDigest !== record.envelopeDigest || !current.leaseExpiresAt
                || Date.parse(current.leaseExpiresAt) <= Date.parse(this.#ports.clock())) throw new Error('prepare-context-changed');
            grant = consumeAgentLoopPreparedExecution(prepared, current, ownerId);
            // A prepared snapshot cannot authorize an extension-modified context in the same commit.
            if (grant && writes && Object.keys(writes).length > 0) throw new Error('prepare-context-patch');
            attemptId = envelope.currentAttemptId ?? (grant ? grant.attemptId : 'attemptId' in prepared ? prepared.attemptId : undefined);
        } catch {
            return this.#block('PREPARE', 'coordinator-prepare-blocked', record);
        }
        if (!attemptId) return this.#block('PREPARE', 'coordinator-attempt-mismatch', record);
        const next = this.#commit(record, ownerId, {
            // CREATED → RUNNING 是唯一允许的首次迁移；其余状态保持原样。
            ...(envelope.state === 'CREATED' ? { state: 'RUNNING' as const } : {}),
            phase: 'MODEL',
            currentAttemptId: attemptId,
            ...(grant ? { budget: grant.budget, artifacts: grant.artifacts, ...(grant.artifactRefs ? { artifactRefs: grant.artifactRefs } : {}) } : {}),
        }, `phase:${envelope.taskId}:${record.revision}:PREPARE-MODEL`, 'phase-advanced', undefined, writes);
        let capabilities: ReturnType<typeof finalizeAgentLoopPreparedExecutionCapabilities> | undefined;
        if (grant) {
            let refs: readonly import('./agent-loop-projection-store.ts').AgentLoopArtifactRefRecord[] | undefined;
            try { refs = grant.artifactRefs ? this.#ports.taskStore.readRefs?.(envelope.taskId) : undefined; } catch { /* No actual descriptor readback grants no proposal capability. */ }
            capabilities = finalizeAgentLoopPreparedExecutionCapabilities(grant, next, refs);
        }
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase: 'PREPARE' as const,
            nextPhase: 'MODEL' as const,
            outcome: 'advanced' as const,
            record: next,
            ...(capabilities?.getVariablesCapability ? { getVariablesCapability: capabilities.getVariablesCapability } : {}),
            ...(capabilities?.rollingSummaryProposalCapability
                ? { rollingSummaryProposalCapability: capabilities.rollingSummaryProposalCapability } : {}),
            ...(capabilities?.rollingSummaryApplyCapability
                ? { rollingSummaryApplyCapability: capabilities.rollingSummaryApplyCapability } : {}),
            reasonCodes: Object.freeze([]),
        });
    }

    async #model(
        record: AgentLoopTaskRecord,
        ownerId: string,
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): Promise<AgentLoopStepResult> {
        const envelope = record.envelope;
        if (envelope.state !== 'RUNNING') {
            return this.#block('MODEL', 'coordinator-model-not-runnable', record);
        }
        const attemptId = envelope.currentAttemptId;
        if (!attemptId) {
            return this.#block('MODEL', 'coordinator-attempt-mismatch', record);
        }
        let correction: AgentLoopModelCorrectionState | undefined;
        let correctionPolicy: AgentLoopModelCorrectionPolicy | undefined;
        if (envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF) {
            let port: AgentLoopCoordinatorPorts['modelCorrection'];
            try { port = this.#modelCorrectionPort(record, ownerId); }
            catch { return this.#block('MODEL', 'coordinator-model-correction-blocked', record); }
            if (!port || !this.#ports.taskStore.readModelCorrectionState) {
                return this.#block('MODEL', 'coordinator-model-correction-unavailable', record);
            }
            try {
                correctionPolicy = assertAgentLoopModelCorrectionPolicyBinding(port.policy, record);
                const now = Date.parse(this.#ports.clock());
                if (!Number.isSafeInteger(now) || Date.parse(correctionPolicy.deadlineAt) <= now) throw new Error('expired');
                correction = this.#ports.taskStore.readModelCorrectionState({ taskId: envelope.taskId,
                    expectedRevision: record.revision, policy: correctionPolicy });
                if (correction.version !== AGENT_LOOP_MODEL_CORRECTION_STATE_VERSION
                    || correction.taskId !== envelope.taskId || correction.taskRevision !== record.revision
                    || correction.envelopeDigest !== record.envelopeDigest
                    || correction.policyDigest !== agentLoopModelCorrectionPolicyDigest(correctionPolicy)) throw new Error('state');
                if (correction.status === 'rejected') {
                    // Same-phase metadata CAS is deliberately a separate step.
                    // Do not call Prepare, increment attempt, recharge, or dispatch here.
                    if (writes && Object.keys(writes).length > 0 || correction.correctionsUsed !== 0
                        || !correction.closedInvocationId) throw new Error('rejection');
                    const advanced: unknown = port.advance({ record, ownerId, policy: correctionPolicy,
                        expectedSnapshotDigest: correction.snapshotDigest });
                    if (nodeTypes.isPromise(advanced)) {
                        // Reject asynchronous authority without reading a user
                        // supplied then getter or leaving a native rejection unobserved.
                        void Promise.prototype.then.call(advanced, undefined, () => {});
                        throw new Error('async-advance');
                    }
                    if (!advanced || typeof advanced !== 'object' || nodeTypes.isProxy(advanced)) throw new Error('advance-result');
                    const advancedRevision = Object.getOwnPropertyDescriptor(advanced, 'revision');
                    const advancedDigest = Object.getOwnPropertyDescriptor(advanced, 'envelopeDigest');
                    const current = this.#ports.taskStore.read(envelope.taskId);
                    if (!current || current.fenced || current.ownerId !== ownerId
                        || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(this.#ports.clock())
                        || current.revision !== record.revision + 1 || !advancedRevision || !Object.hasOwn(advancedRevision, 'value')
                        || advancedRevision.value !== current.revision || !advancedDigest || !Object.hasOwn(advancedDigest, 'value')
                        || advancedDigest.value !== current.envelopeDigest || current.envelope.phase !== 'MODEL'
                        || current.envelope.state !== 'RUNNING'
                        || JSON.stringify(current.envelope.budget) !== JSON.stringify(envelope.budget)) throw new Error('advance');
                    const ready = this.#ports.taskStore.readModelCorrectionState({ taskId: envelope.taskId,
                        expectedRevision: current.revision, policy: correctionPolicy });
                    if (ready.status !== 'ready' || !ready.invocationAllowed || ready.correctionsUsed !== 1
                        || ready.readyRevision !== current.revision || ready.closedInvocationId !== correction.closedInvocationId
                        || ready.envelopeDigest !== current.envelopeDigest
                        || ready.policyDigest !== correction.policyDigest) throw new Error('ready');
                    return Object.freeze({ coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION, phase: 'MODEL' as const,
                        nextPhase: 'MODEL' as const, outcome: 'model-correction-ready' as const, record: current,
                        reasonCodes: Object.freeze([]) });
                }
                if (!correction.invocationAllowed || !['initial', 'ready'].includes(correction.status)
                    || correction.status === 'initial' && (record.revision !== correctionPolicy.initialRevision
                        || correction.correctionsUsed !== 0 || correction.closedInvocationId !== null)
                    || correction.status === 'ready' && (correction.readyRevision !== record.revision
                        || correction.correctionsUsed !== 1 || !correction.closedInvocationId)) throw new Error('slot');
            } catch {
                return this.#block('MODEL', 'coordinator-model-correction-blocked', this.#ports.taskStore.read(envelope.taskId) ?? record);
            }
        }
        const invocationId = agentLoopModelInvocationId({ taskId: envelope.taskId,
            attemptId, expectedTaskRevision: record.revision });
        try {
            const events = this.#ports.taskStore.readEvents(envelope.taskId);
            const byId = new Map(events.map((event) => [event.eventId, event]));
            const closedAt = (event: AgentLoopTaskEvent | undefined, revision: number, kind: string,
                reasons: readonly string[]) => event?.taskId === envelope.taskId && event.revision === revision + 1
                && event.kind === kind && reasons.includes(event.reasonCode ?? '');
            // An unrelated Observation can advance revision while MODEL is
            // unresolved. It is not permission to repeat the unknown call.
            const unresolved = events.some((reserved) => {
                if (reserved.taskId !== envelope.taskId || reserved.kind !== 'model-invocation-reserved'
                    || reserved.revision > record.revision || reserved.eventId !== `model-invocation:${agentLoopModelInvocationId({
                        taskId: envelope.taskId, attemptId, expectedTaskRevision: reserved.revision,
                    })}`) return false;
                const closedByCorrection = correction?.status === 'ready'
                    && correction.closedInvocationId === reserved.eventId.slice('model-invocation:'.length);
                return !closedByCorrection && !closedAt(byId.get(`phase:${envelope.taskId}:${reserved.revision}:MODEL-ACT`),
                    reserved.revision, 'phase-advanced', ['act', 'delegate', 'request_complete'])
                    && !closedAt(byId.get(`wait:${envelope.taskId}:${reserved.revision}`),
                        reserved.revision, 'wait-entered', ['ask_user', 'wait_event']);
            });
            if (unresolved) return this.#block('MODEL', 'coordinator-model-already-reserved', record);
            // A readEvents check followed by an idempotent append is NOT an
            // exclusive reservation. Only this transaction's first insertion
            // may enter decide, including across workers with the same owner.
            this.#ports.taskStore.annotate({ taskId: envelope.taskId,
                expectedRevision: record.revision, ownerId, requireNew: true,
                ...(correctionPolicy ? { modelCorrectionPolicy: correctionPolicy } : {}),
                event: { eventId: `model-invocation:${invocationId}`, kind: 'model-invocation-reserved' } });
        } catch (error) {
            return this.#block('MODEL', error instanceof AgentLoopProjectionError
                && error.code === 'agent-loop-projection-event-exists'
                ? 'coordinator-model-already-reserved' : 'coordinator-model-reservation-failed', record);
        }
        let output: unknown;
        let invocationPermit: AgentLoopModelInvocationPermit | undefined;
        try {
            invocationPermit = createAgentLoopModelInvocationPermit({ record, ownerId });
            output = await this.#ports.decide({ envelope, revision: record.revision, invocationPermit });
        } catch {
            return this.#block('MODEL', 'coordinator-decision-invalid', record);
        } finally {
            if (invocationPermit) revokeAgentLoopModelInvocationPermit(invocationPermit);
        }
        const modeled = readAgentLoopModelOutcome(output);
        if (correctionPolicy && !modeled) return this.#block('MODEL', 'coordinator-model-outcome-invalid', record);
        let decision: AgentLoopDecisionV1 | undefined;
        let invalid: AgentLoopCoordinatorReasonCode | undefined;
        try { decision = normalizeAgentLoopDecision(modeled ? modeled.decision : output); }
        catch { invalid = 'coordinator-decision-invalid'; }
        if (decision) {
            if (decision.taskId !== envelope.taskId || decision.taskContractRef !== envelope.taskContractRef) invalid = 'coordinator-decision-invalid';
            else if (decision.attemptId !== attemptId) invalid = 'coordinator-attempt-mismatch';
            else if (decision.expectedTaskRevision !== record.revision) invalid = 'coordinator-stale-decision';
        }
        // The port may settle after fence/takeover/source CAS. Never publish
        // its Decision or install pending state against that changed context.
        const current = this.#ports.taskStore.read(envelope.taskId);
        if (!current || current.fenced || current.ownerId !== ownerId || current.revision !== record.revision
            || current.envelopeDigest !== record.envelopeDigest || !current.leaseExpiresAt
            || Date.parse(current.leaseExpiresAt) <= Date.parse(this.#ports.clock())) {
            return this.#block('MODEL', 'coordinator-model-context-changed', current ?? record);
        }
        let providerObservation: AgentLoopObservationEnvelopeV1 | undefined;
        if (modeled) {
            const observation = modeled.observation, usage = observation.usageDelta;
            if (observation.taskId !== envelope.taskId || observation.attemptId !== attemptId
                || observation.observedForTaskRevision !== record.revision
                || observation.observationId !== `model-usage:${invocationId}`
                || observation.correlationRef !== `model-invocation:${invocationId}`
                || (usage && (usage.modelCalls !== 1 || usage.toolCalls !== 0 || usage.writes !== 0 || usage.highRiskActions !== 0))) {
                return this.#block('MODEL', 'coordinator-model-outcome-invalid', record);
            }
            const reduction = reduceAgentLoopObservation({ envelope, observation });
            if (reduction.classification !== 'applied') return this.#block('MODEL', 'coordinator-model-outcome-invalid', record);
            if (!usage || observation.completeness !== 'complete') invalid = 'coordinator-model-usage-unavailable';
            else if (correctionPolicy && (usage.inputTokens <= 0 || usage.outputTokens <= 0)) invalid = 'coordinator-model-usage-unavailable';
            else if (reduction.reasonCodes.includes('observation-budget-overrun')) invalid = 'coordinator-model-budget-exhausted';
            if (correctionPolicy) {
                const settledAt = Date.parse(this.#ports.clock());
                // A known physical return after the ORIGINAL deadline still
                // settles its cost, but cannot publish a Decision or rejection
                // that could be consumed as correction authority.
                if (!Number.isSafeInteger(settledAt) || settledAt >= Date.parse(correctionPolicy.deadlineAt)) {
                    invalid = 'coordinator-model-correction-blocked';
                }
            }
            // Rejected receipts have one terminal settlement path. This return
            // cannot reach either of the phase-commit paths below.
            if (invalid) return this.#settleBlockedModel(record, ownerId, observation, invalid,
                envelope.taskContractRef === 'task.rp-child-analysis.v1'
                    || invalid === 'coordinator-decision-invalid' && modeled.protocolRejectionReason !== undefined
                    ? output : undefined);
            providerObservation = observation;
        }
        if (invalid || !decision) return this.#block('MODEL', invalid ?? 'coordinator-decision-invalid', record);

        const waiting = decision.kind === 'ask_user' || decision.kind === 'wait_event'
            ? (decision.kind === 'ask_user'
                ? {
                    state: 'WAITING_INPUT' as const,
                    kind: 'input' as const,
                    correlationRef: decision.responseContractRef,
                    resumePredicateRef: `resume.input:${decision.responseContractRef}`,
                    expectedObservationContractRef: `observation.ask-user.v1`,
                }
                : {
                    state: 'WAITING_EVENT' as const,
                    kind: 'event' as const,
                    correlationRef: decision.correlationRef,
                    resumePredicateRef: `resume.event:${decision.observationContractRef}`,
                    expectedObservationContractRef: decision.observationContractRef,
                })
            : null;

        if (waiting) {
            // 进入 WAITING 并保存 waitId/correlation/resume predicate；等人唤醒，不占 worker。
            const waitId = `wait:${envelope.taskId}:${record.revision}:${waiting.kind}`;
            let next: AgentLoopTaskRecord;
            try {
                next = this.#commitState(record, ownerId, {
                    state: waiting.state,
                    wait: {
                        waitId,
                        kind: waiting.kind,
                        correlationRef: waiting.correlationRef,
                        expectedObservationContractRef: waiting.expectedObservationContractRef,
                        resumePredicateRef: waiting.resumePredicateRef,
                        since: this.#ports.clock(),
                    },
                }, `wait:${envelope.taskId}:${record.revision}`, 'wait-entered', decision.kind, writes, providerObservation,
                    correctionPolicy ? output : undefined, correctionPolicy);
            } catch {
                return this.#block('MODEL', 'coordinator-model-context-changed', this.#ports.taskStore.read(envelope.taskId) ?? record);
            }
            return Object.freeze({
                coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                phase: 'MODEL' as const,
                nextPhase: null,
                outcome: 'waiting' as const,
                record: next,
                reasonCodes: Object.freeze([]),
                decision,
                wait: Object.freeze({
                    waitId,
                    kind: waiting.kind,
                    correlationRef: waiting.correlationRef,
                    resumePredicateRef: waiting.resumePredicateRef,
                }),
            });
        }

        // act / delegate / request_complete 都进 ACT（唯一 Gateway，见 AL-4）；
        // request_complete 在 ACT 里只是登记完成候选，随后的 OBSERVE 才把它变成
        // completion-candidate Observation，再由 VERIFY 判定 —— 绝不在这里直接 COMPLETED。
        let next: AgentLoopTaskRecord;
        try {
            next = this.#commit(record, ownerId, { phase: 'ACT' },
                `phase:${envelope.taskId}:${record.revision}:MODEL-ACT`, 'phase-advanced', decision.kind, writes, providerObservation,
                correctionPolicy || envelope.taskContractRef === 'task.rp-child-analysis.v1' ? output : undefined,
                correctionPolicy);
        } catch {
            return this.#block('MODEL', 'coordinator-model-context-changed', this.#ports.taskStore.read(envelope.taskId) ?? record);
        }
        // Commit first: a rejected CAS must not leave an executable in-memory decision.
        this.#pending.set(envelope.taskId, { revision: record.revision, decision });
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase: 'MODEL' as const,
            nextPhase: 'ACT' as const,
            outcome: 'advanced' as const,
            record: next,
            reasonCodes: Object.freeze([]),
            decision,
        });
    }

    async #act(
        record: AgentLoopTaskRecord,
        ownerId: string,
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): Promise<AgentLoopStepResult> {
        const envelope = record.envelope;
        const attemptId = envelope.currentAttemptId;
        if (attemptId === undefined) {
            return this.#block('ACT', 'coordinator-attempt-mismatch', record);
        }
        const pending = this.#pending.get(envelope.taskId);
        // MODEL 提交把 revision 推进了一格，所以 ACT 看到的是 `pending.revision + 1`。
        // 只允许这一格间隔：再多一格说明中间发生过别的变更，决策已经不对应当前状态。
        if (!pending || pending.revision + 1 !== record.revision) {
            // 决策丢了（进程重启 / 换实例）。**不伪造**：先看这个 revision 上有没有 started。
            const startedHere = this.#ports.taskStore.readEvents(envelope.taskId)
                .some((event) => event.kind === 'action-started'
                    && event.revision === record.revision);
            return startedHere
                ? Object.freeze({
                    ...this.#block('ACT', 'coordinator-act-already-started', record),
                    outcome: 'acted-uncertain' as const,
                })
                : this.#block('ACT', 'coordinator-decision-lost', record);
        }

        const { decision } = pending;
        const decisionDigest = agentLoopDecisionDigest(decision);
        const actionId = agentLoopActionId({
            taskId: envelope.taskId,
            attemptId,
            expectedTaskRevision: record.revision,
            decisionDigest,
        });
        const events = this.#ports.taskStore.readEvents(envelope.taskId);
        const started = events.some((event) => event.eventId === `action-started:${actionId}`);
        const completed = events.some((event) => event.eventId === `action-completed:${actionId}`);

        if (completed) {
            // 上次已经完成 act，可能没来得及提交阶段：观测在就补提交，不在就老实说缺。
            const observationId = `obs:${actionId}`;
            const ingested = this.#ports.taskStore.readObservations(envelope.taskId)
                .some((row) => row.observationId === observationId);
            if (!ingested) {
                return this.#block('ACT', 'coordinator-observe-payload-missing', record);
            }
            this.#pending.delete(envelope.taskId);
            const next = this.#commit(record, ownerId, { phase: 'OBSERVE' },
                `phase:${envelope.taskId}:${record.revision}:ACT-OBSERVE`, 'phase-advanced',
                decision.kind, writes);
            return Object.freeze({
                coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                phase: 'ACT' as const,
                nextPhase: 'OBSERVE' as const,
                outcome: 'advanced' as const,
                record: next,
                reasonCodes: Object.freeze([]),
                action: Object.freeze({ actionId, decisionKind: decision.kind }),
            });
        }
        if (started) {
            // 有「已开始」没「已完成」⇒ 副作用可能已经发生，**绝不重发**。
            return Object.freeze({
                ...this.#block('ACT', 'coordinator-act-already-started', record),
                outcome: 'acted-uncertain' as const,
                action: Object.freeze({ actionId, decisionKind: decision.kind }),
            });
        }

        // Only this transaction's first insertion may enter the Action port.
        // A stale/reentrant readEvents plus an idempotent append is not an exclusive claim.
        try {
            this.#ports.taskStore.annotate({
                taskId: envelope.taskId,
                expectedRevision: record.revision,
                ownerId,
                requireNew: true,
                ...(envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
                    ? { modelCorrectionPolicy: this.#modelCorrectionPort(record, ownerId)?.policy } : {}),
                event: {
                    eventId: `action-started:${actionId}`,
                    kind: 'action-started',
                    reasonCode: decision.kind,
                },
            });
        } catch (error) {
            if (error instanceof AgentLoopProjectionError && error.code === 'agent-loop-projection-event-exists') {
                return Object.freeze({
                    ...this.#block('ACT', 'coordinator-act-already-started', record),
                    outcome: 'acted-uncertain' as const,
                    action: Object.freeze({ actionId, decisionKind: decision.kind }),
                });
            }
            // No successful reservation means no port entry. Do not leak Store errors or
            // mislabel an unstarted action as a Provider/tool failure.
            return this.#block('ACT', 'coordinator-act-reservation-failed', record);
        }

        const requestedAt = this.#ports.clock();
        let acted: AgentLoopActResult;
        try {
            acted = await this.#ports.act({
                decision,
                actionRequest: {
                    contractVersion: 'agent-loop-action-request-v1' as const,
                    actionId,
                    taskId: envelope.taskId,
                    attemptId,
                    // 用决策自带的 harnessRunId：三层身份都有出处，不现场编。
                    harnessRunId: decision.harnessRunId,
                    decisionId: decision.decisionId,
                    expectedTaskRevision: record.revision,
                    decisionDigest,
                    actionContractRef: decision.kind === 'act'
                        ? decision.actionContractRef
                        : envelope.taskContractRef,
                    args: decision.kind === 'act' ? decision.args : {},
                    requestedAt,
                },
            });
        } catch {
            return Object.freeze({
                ...this.#block('ACT', 'coordinator-act-uncertain', record),
                outcome: 'acted-uncertain' as const,
                action: Object.freeze({ actionId, decisionKind: decision.kind }),
            });
        }

        const receipt = readAgentLoopActionOutcome(acted);
        if (receipt && (receipt.observation.observationId !== `obs:${actionId}`
            || receipt.observation.taskId !== envelope.taskId || receipt.observation.attemptId !== attemptId
            || receipt.observation.observedForTaskRevision !== record.revision
            || receipt.observation.causalActionId !== actionId || receipt.observation.observedAt !== requestedAt
            || receipt.artifactBundle && (decision.kind !== 'act'
                || !(decision.actionContractRef === AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
                    && receipt.artifactBundle.artifact.kind === 'agent-loop-rolling-summary-proposal'
                    && receipt.artifactBundle.descriptor.kind === 'candidate'
                    || decision.actionContractRef === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT
                    && receipt.artifactBundle.artifact.kind === 'agent-loop-rolling-summary-apply'
                    && receipt.artifactBundle.descriptor.kind === 'memory-record'
                    || decision.actionContractRef === AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT
                    && envelope.taskContractRef === 'task.rp-child-analysis.v1'
                    && envelope.taskKind === 'rp.child-analysis'
                    && receipt.artifactBundle.artifact.kind === 'rp-child-analysis'
                    && receipt.artifactBundle.descriptor.kind === 'session-artifact')
                || receipt.observation.completeness !== 'complete'))) {
            return Object.freeze({
                ...this.#block('ACT', 'coordinator-act-uncertain', record),
                outcome: 'acted-uncertain' as const,
                action: Object.freeze({ actionId, decisionKind: decision.kind }),
            });
        }
        // Genuine host results keep their original normalized Observation identity.
        // Generic test/integration ports retain the original DTO fallback; the production
        // runtime separately denies that fallback and requires its captured host receipt.
        const observation = receipt?.observation ?? {
            contractVersion: AGENT_LOOP_OBSERVATION_VERSION,
            observationId: `obs:${actionId}`,
            taskId: envelope.taskId,
            attemptId,
            observedForTaskRevision: record.revision,
            sourceKind: acted.sourceKind,
            sourceRef: acted.sourceRef,
            causalActionId: actionId,
            observedAt: requestedAt,
            ingestedAt: this.#ports.clock(),
            payloadDigest: acted.payloadDigest,
            ...(acted.payloadRef === undefined ? {} : { payloadRef: acted.payloadRef }),
            completeness: acted.completeness,
            evidenceRefs: acted.evidenceRefs,
            ...(acted.usageDelta === undefined ? {} : { usageDelta: acted.usageDelta }),
        };
        let ingested: AgentLoopObservationIngest;
        try {
            ingested = this.#ports.taskStore.ingestObservation({
                observation,
                expectedRevision: record.revision,
                ownerId,
            });
        } catch {
            // 观测落不进去（冲突/存储问题）⇒ 动作确实发生过，但结果没有可信记账。
            return Object.freeze({
                ...this.#block('ACT', 'coordinator-act-uncertain', record),
                outcome: 'acted-uncertain' as const,
                action: Object.freeze({ actionId, decisionKind: decision.kind }),
            });
        }

        this.#ports.taskStore.annotate({
            taskId: envelope.taskId,
            expectedRevision: ingested.record.revision,
            ownerId,
            ...(envelope.taskContractRef === AGENT_LOOP_MODEL_CORRECTION_CONTRACT_REF
                ? { modelCorrectionPolicy: this.#modelCorrectionPort(ingested.record, ownerId)?.policy } : {}),
            event: {
                eventId: `action-completed:${actionId}`,
                kind: 'action-completed',
                reasonCode: decision.kind,
            },
        });
        this.#pending.delete(envelope.taskId);

        const bundle = receipt?.artifactBundle;
        const next = this.#commit(ingested.record, ownerId, { phase: 'OBSERVE',
            ...(bundle ? { artifacts: [...ingested.record.envelope.artifacts, bundle.artifact], artifactRefs: [bundle.descriptor] } : {}) },
            `phase:${envelope.taskId}:${ingested.record.revision}:ACT-OBSERVE`, 'phase-advanced',
            decision.kind, writes);
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase: 'ACT' as const,
            nextPhase: 'OBSERVE' as const,
            outcome: 'acted' as const,
            record: next,
            reasonCodes: Object.freeze([]),
            action: Object.freeze({ actionId, decisionKind: decision.kind }),
            observation: Object.freeze({
                classification: ingested.classification,
                satisfiesVerification: ingested.satisfiesVerification,
            }),
        });
    }

    async #observe(
        record: AgentLoopTaskRecord,
        ownerId: string,
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): Promise<AgentLoopStepResult> {
        const envelope = record.envelope;
        // 上一步做了什么决定去向：`request_complete` 必须进 VERIFY（由 AL-5 决定是否 COMPLETED）。
        const actionEvent = [...this.#ports.taskStore.readEvents(envelope.taskId)]
            .reverse()
            .find((event) => event.kind === 'action-completed'
                && typeof event.reasonCode === 'string');
        const decisionKind = actionEvent?.reasonCode ?? null;
        if (this.#ports.completion?.request) {
            let request: unknown;
            try {
                request = this.#ports.completion.request({ record, ownerId, actionWatermark: actionEvent?.eventId ?? null });
                if (request !== null) {
                    if (request !== null && typeof request === 'object') {
                        let asynchronous = false;
                        try { void Promise.prototype.then.call(request, revokeAgentLoopCompletionRequest, () => undefined); asynchronous = true; }
                        catch { /* Never inspect an arbitrary then getter. */ }
                        if (asynchronous) throw new Error();
                    }
                    if (!isPreparedAgentLoopCompletionRequest(request) || !this.#ports.completion.commitRequested
                        || writes && Object.keys(writes).length > 0) throw new Error();
                    const committed: unknown = this.#ports.completion.commitRequested({ request, record, ownerId,
                        actionWatermark: actionEvent?.eventId ?? null });
                    if (committed !== null && typeof committed === 'object') {
                        let asynchronous = false;
                        try { void Promise.prototype.then.call(committed, revokeAgentLoopCompletionRequest, () => undefined); asynchronous = true; }
                        catch { /* No Promise or foreign thenable can stand in for a record. */ }
                        if (asynchronous) throw new Error();
                    }
                    const next = committed as AgentLoopTaskRecord, current = this.#ports.taskStore.read(envelope.taskId);
                    const expected = normalizeAgentLoopTaskEnvelope({ ...envelope, phase: 'VERIFY',
                        revision: record.revision + 1, updatedAt: next.envelope.updatedAt });
                    if (!current || next.ownerId !== ownerId || next.fenced || next.revision !== record.revision + 1
                        || JSON.stringify(next) !== JSON.stringify(current)
                        || JSON.stringify(next.envelope) !== JSON.stringify(expected)) throw new Error();
                    return Object.freeze({ coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                        phase: 'OBSERVE', nextPhase: 'VERIFY', outcome: 'observed', record: next, reasonCodes: Object.freeze([]) });
                }
            } catch {
                return this.#block('OBSERVE', 'coordinator-completion-request-unavailable', this.#ports.taskStore.read(envelope.taskId) ?? record);
            } finally {
                // Failed preconditions or an invalid/throwing host port must not
                // leave an unconsumed live request behind. Successful consume
                // already burned it; this revocation is deliberately idempotent.
                revokeAgentLoopCompletionRequest(request);
            }
        }
        const target: AgentLoopPhase = decisionKind === 'request_complete' ? 'VERIFY' : 'PREPARE';
        // 状态**不动**：VERIFYING 需要 completion candidate（candidateRef + evidenceRefs），
        // 那是 AL-5 冻结的产物；协调器在这里造一个就是伪造完成候选。
        const next = this.#commit(record, ownerId, { phase: target },
            `phase:${envelope.taskId}:${record.revision}:OBSERVE-${target}`, 'phase-advanced',
            decisionKind ?? undefined, writes);
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase: 'OBSERVE' as const,
            nextPhase: target,
            outcome: 'observed' as const,
            record: next,
            reasonCodes: Object.freeze([]),
        });
    }

    #repair(
        record: AgentLoopTaskRecord,
        ownerId: string,
        state: AgentLoopRepairState | undefined,
        verification: Readonly<{ disposition: AgentLoopVerificationDisposition; reasonCodes: readonly string[] }>,
        gateReasons: readonly string[],
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): AgentLoopStepResult {
        try {
            if (!state || !this.#ports.repair || !this.#ports.taskStore.readRepairState
                || writes && Object.keys(writes).length > 0) throw new Error();
            const raw: unknown = this.#ports.repair.commit({ record, ownerId, expectedSnapshotDigest: state.snapshotDigest });
            if (raw !== null && typeof raw === 'object') {
                let asynchronous = false;
                try { void Promise.prototype.then.call(raw, () => undefined, () => undefined); asynchronous = true; }
                catch { /* Do not inspect an arbitrary then getter. */ }
                if (asynchronous) throw new Error();
            }
            const result = raw as AgentLoopRepairCommitResult, next = result.record;
            if (!['repair', 'terminal-failure', 'inconclusive'].includes(result.verdict)) throw new Error();
            const changed = result.verdict !== 'inconclusive';
            const expected = normalizeAgentLoopTaskEnvelope({ ...record.envelope,
                state: result.verdict === 'terminal-failure' ? 'FAILED' : 'RUNNING',
                phase: result.verdict === 'repair' ? 'PREPARE' : 'VERIFY',
                revision: record.revision + (changed ? 1 : 0), updatedAt: next.envelope.updatedAt });
            const current = this.#ports.taskStore.read(record.envelope.taskId);
            const actual = this.#ports.taskStore.readRepairState({ taskId: record.envelope.taskId, expectedRevision: next.revision });
            if (!current || next.fenced || next.ownerId !== ownerId || next.revision !== expected.revision
                || JSON.stringify(next) !== JSON.stringify(current) || JSON.stringify(next.envelope) !== JSON.stringify(expected)
                || JSON.stringify(result.state) !== JSON.stringify(actual)
                || actual.attempts !== state.attempts + (result.verdict === 'repair' ? 1 : 0)
                || result.verdict === 'repair' && (actual.maxAttempts === null || actual.attempts > actual.maxAttempts)
                || changed && (actual.policyDigest === null || actual.maxAttempts === null)
                || state.policyDigest !== null && (actual.policyDigest !== state.policyDigest || actual.maxAttempts !== state.maxAttempts)
                || !changed && (JSON.stringify(next) !== JSON.stringify(record) || actual.snapshotDigest !== state.snapshotDigest)) throw new Error();
            return Object.freeze({ coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                phase: 'VERIFY', nextPhase: result.verdict === 'repair' ? 'PREPARE' : null,
                outcome: 'verified', record: next, reasonCodes: Object.freeze([]),
                verification: Object.freeze({ disposition: verification.disposition, reasonCodes: Object.freeze([...verification.reasonCodes]) }),
                extensionReasonCodes: Object.freeze([...gateReasons, ...result.reasonCodes]) });
        } catch {
            return this.#block('VERIFY', 'coordinator-repair-unavailable', this.#ports.taskStore.read(record.envelope.taskId) ?? record);
        }
    }

    async #verify(
        record: AgentLoopTaskRecord,
        ownerId: string,
        writes?: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>,
    ): Promise<AgentLoopStepResult> {
        const envelope = record.envelope;
        let repairState: AgentLoopRepairState | undefined, repairAttempts: number;
        try {
            repairState = this.#ports.taskStore.readRepairState?.({ taskId: envelope.taskId, expectedRevision: record.revision });
            repairAttempts = repairState?.attempts ?? foldAgentLoopRepairEvents({ taskId: envelope.taskId,
                taskRevision: record.revision, events: this.#ports.taskStore.readEvents(envelope.taskId) }).attempts;
            if (repairState && (repairState.taskId !== envelope.taskId || repairState.taskRevision !== record.revision
                || repairState.envelopeDigest !== record.envelopeDigest)) throw new Error();
        } catch { return this.#block('VERIFY', 'coordinator-repair-unavailable', record); }
        const actionEvent = [...this.#ports.taskStore.readEvents(envelope.taskId)]
            .reverse()
            .find((event) => event.kind === 'action-completed');
        const actionId = actionEvent
            ? actionEvent.eventId.replace(/^action-completed:/u, '')
            : null;
        let verified: Readonly<{
            disposition: AgentLoopVerificationDisposition;
            reasonCodes: readonly string[];
        }>;
        try {
            verified = await this.#ports.verify({
                envelope, revision: record.revision, actionId,
            });
        } catch {
            return this.#block('VERIFY', 'coordinator-verify-unavailable', record);
        }
        if (verified.disposition === 'failed-repairable') {
            return this.#repair(record, ownerId, repairState, verified, [], writes);
        }
        // passed 才能进完成门；failed-terminal / inconclusive 直接返回结果，不改状态。
        if (verified.disposition === 'passed' && this.#ports.completion) {
            const attemptId = envelope.currentAttemptId;
            if (attemptId === undefined) {
                return this.#block('VERIFY', 'coordinator-attempt-mismatch', record);
            }
            let gate: Awaited<ReturnType<NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate']>>;
            try {
                gate = await this.#ports.completion.evaluate({
                    envelope,
                    revision: record.revision,
                    attemptId,
                    actionWatermark: actionEvent?.eventId ?? null,
                    repairAttempts,
                });
            } catch {
                return this.#block('VERIFY', 'coordinator-verify-unavailable', record);
            }
            if (gate.verdict === 'complete') {
                // Keep the candidate bound to exactly r. The original Store derives
                // VERIFYING@r+1 and COMPLETED@r+2 inside one writer transaction.
                // No generic commit, persisted DTO or missing port may bypass this.
                let completed: AgentLoopTaskRecord;
                try {
                    if (!isPreparedFrozenAgentLoopCompletion(gate) || !this.#ports.completion.commitVerified || gate.verificationResultRef === null
                        || gate.evidenceRefs.length === 0 || writes && Object.keys(writes).length > 0) throw new Error();
                    const committed: unknown = this.#ports.completion.commitVerified({ evaluation: gate, record, ownerId });
                    if (committed !== null && typeof committed === 'object') {
                        let asynchronous = false;
                        try { void Promise.prototype.then.call(committed, () => undefined, () => undefined); asynchronous = true; }
                        catch { /* Never read or assimilate an arbitrary then property. */ }
                        if (asynchronous) throw new Error();
                    }
                    completed = committed as AgentLoopTaskRecord;
                    const current = this.#ports.taskStore.read(envelope.taskId);
                    const expected = normalizeAgentLoopTaskEnvelope({ ...envelope, state: 'COMPLETED',
                        revision: record.revision + 2, updatedAt: completed.envelope.updatedAt,
                        completion: { candidateRef: gate.candidateRef, disposition: 'passed',
                            verificationResultRef: gate.verificationResultRef, evidenceRefs: gate.evidenceRefs } });
                    if (!current || completed.ownerId !== ownerId || completed.fenced
                        || completed.revision !== record.revision + 2
                        || JSON.stringify(completed) !== JSON.stringify(current)
                        || JSON.stringify(completed.envelope) !== JSON.stringify(expected)) throw new Error();
                } catch {
                    return this.#block('VERIFY', 'coordinator-verify-unavailable', this.#ports.taskStore.read(envelope.taskId) ?? record);
                }
                return Object.freeze({
                    coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                    phase: 'VERIFY' as const,
                    nextPhase: null,
                    outcome: 'verified' as const,
                    record: completed,
                    reasonCodes: Object.freeze([]),
                    verification: Object.freeze({
                        disposition: verified.disposition,
                        reasonCodes: Object.freeze([...verified.reasonCodes]),
                    }),
                    extensionReasonCodes: Object.freeze([...gate.reasonCodes]),
                });
            }
            if (gate.verdict === 'repair' || gate.verdict === 'terminal-failure'
                && gate.reasonCodes.includes('completion-repair-budget-exhausted')) {
                // The gate DTO does not authorize repair or exhaustion. Recheck
                // durable lifetime usage, remaining budget and unknown effects
                // in the same original writer transaction for both branches.
                return this.#repair(record, ownerId, repairState, verified, gate.reasonCodes, writes);
            }
            if (gate.verdict === 'terminal-failure') {
                const failed = this.#commitState(record, ownerId, { state: 'FAILED' },
                    `verify:${envelope.taskId}:${record.revision}:failed`,
                    'task-failed', 'verification-terminal', writes);
                return Object.freeze({
                    coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                    phase: 'VERIFY' as const,
                    nextPhase: null,
                    outcome: 'verified' as const,
                    record: failed,
                    reasonCodes: Object.freeze([]),
                    verification: Object.freeze({
                        disposition: verified.disposition,
                        reasonCodes: Object.freeze([...verified.reasonCodes]),
                    }),
                    extensionReasonCodes: Object.freeze([...gate.reasonCodes]),
                });
            }
            // inconclusive：留在 VERIFY，等人核对（不改状态、不伪造结论）。
            return Object.freeze({
                coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
                phase: 'VERIFY' as const,
                nextPhase: null,
                outcome: 'verified' as const,
                record,
                reasonCodes: Object.freeze([]),
                verification: Object.freeze({
                    disposition: verified.disposition,
                    reasonCodes: Object.freeze([...verified.reasonCodes]),
                }),
                extensionReasonCodes: Object.freeze([...gate.reasonCodes]),
            });
        }

        // 没有完成门（或 disposition 非 passed）：**不在这里改成 COMPLETED/FAILED**。
        return Object.freeze({
            coordinatorVersion: AGENT_LOOP_COORDINATOR_VERSION,
            phase: 'VERIFY' as const,
            nextPhase: null,
            outcome: 'verified' as const,
            record,
            reasonCodes: Object.freeze([]),
            verification: Object.freeze({
                disposition: verified.disposition,
                reasonCodes: Object.freeze([...verified.reasonCodes]),
            }),
        });
    }
}
