/** @author Codex @date 2026-10-19 @version 1.0
 * AL-4：Action Plane 的唯一入口（`agent-loop-action-gateway-v1`）。
 *
 * 这个模块的价值不在「执行动作」——执行是注入端口的活；它的价值在于**顺序不可重排**：
 *
 *   task revision → 合同 → 身份/Policy/内容模式 → 预算原子预留 → 审批
 *     → 幂等/未知效果 → execute → Observation → 用量结算
 *
 * 任何一步想跳过，都会在这里被拦下并给出闭集理由码。四类最贵的错误都是「顺序错了」：
 * - 先执行后预留预算 ⇒ 超支已经发生；
 * - 先执行后审批 ⇒ 审批变成事后追认；
 * - 不查幂等就重放 ⇒ 同一动作扣两次费/写两次库；
 * - effect 未知就直接重试 ⇒ 真正的重复副作用。
 *
 * 边界：
 * 1. 只服务新 Loop（`AgentLoopCoordinator` 的 `act` 端口）。**没有**改动现有
 *    `interactive-turn-runner` 的工具执行路径 —— 那条路径的迁移需要单独批准（会改线上行为）。
 * 2. 不做业务写：有副作用的动作仍由注入的 `committer` 走领域 Store / CAS。
 * 3. 未知效果**先核对**（readback），核对不出结论就进 reconciliation，绝不盲目重发。
 * 4. 审批绑定 `actionDigest + taskRevision + authorityRevision` 的摘要 + TTL；
 *    参数一变就是新的绑定，必须重新审批。
 */

import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { normalizeAgentLoopDecision, type AgentLoopDelegateDecisionV1 } from '@jiuguan/agent-loop-contract';

export const AGENT_LOOP_ACTION_GATEWAY_VERSION = 'agent-loop-action-gateway-v1' as const;

export const AGENT_LOOP_ACTION_REASON_CODES = Object.freeze([
    'action-input-invalid',
    'action-stale-revision',
    'action-contract-unknown',
    'action-policy-denied',
    'action-approval-required',
    'action-budget-insufficient',
    'action-id-conflict',
    'action-reconciliation-required',
    'action-execution-failed',
    'action-uncertain-effect',
    'delegation-rejected',
] as const);
export type AgentLoopActionReasonCode = typeof AGENT_LOOP_ACTION_REASON_CODES[number];

export interface AgentLoopUsageVector {
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly writes: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicrousd: number;
    readonly wallMs: number;
    readonly highRiskActions: number;
}

/** Actual executor metadata only. No result body, model assertion, or fabricated payload ref. */
export interface AgentLoopActionExecutionResult {
    readonly receiptRef: string;
    readonly sourceKind: 'tool' | 'domain-readback';
    readonly sourceRef: string;
    readonly payloadDigest: string;
    readonly payloadRef?: string;
    readonly completeness: 'complete' | 'partial' | 'unknown';
    readonly evidenceRefs: readonly string[];
    readonly usage: AgentLoopUsageVector;
}

export interface AgentLoopActionRequest {
    readonly actionId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly harnessRunId: string;
    readonly decisionId: string;
    readonly expectedTaskRevision: number;
    readonly decisionDigest: string;
    readonly actionContractRef: string;
    readonly taskContractRef: string;
    readonly taskKind: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly requestedAt: string;
    /** 高风险动作即使 Policy 允许也要审批（由 Policy 给出，不由调用方自报）。 */
    readonly authorityRevision: string;
}

export type AgentLoopActionOutcome =
    | Readonly<{
        status: 'executed';
        actionId: string;
        actionDigest: string;
        receiptRef: string;
        usage: AgentLoopUsageVector;
        steps: readonly string[];
        observation: Readonly<{
            sourceKind: 'tool' | 'domain-readback';
            sourceRef: string;
            payloadDigest: string;
            payloadRef?: string;
            completeness: 'complete' | 'partial' | 'unknown';
            evidenceRefs: readonly string[];
        }>;
    }>
    | Readonly<{
        status: 'replayed';
        actionId: string;
        actionDigest: string;
        receiptRef: string;
        steps: readonly string[];
    }>
    | Readonly<{
        status: 'reconciled';
        actionId: string;
        actionDigest: string;
        receiptRef: string;
        steps: readonly string[];
        reasonCodes: readonly AgentLoopActionReasonCode[];
    }>
    | Readonly<{
        status: 'rejected';
        actionId: string;
        steps: readonly string[];
        reasonCodes: readonly AgentLoopActionReasonCode[];
        /** `require-approval` 时给出待审批绑定，便于宿主去拿审批。 */
        approvalBinding?: string;
    }>;

export interface AgentLoopDelegationRequest {
    readonly parentTaskId: string;
    readonly childTaskContractRef: string;
    readonly objective: string;
    /** Compatibility hints only. A host adapter must derive both from its authoritative snapshot. */
    readonly depth: number;
    readonly activeChildren: number;
    readonly decision?: AgentLoopDelegateDecisionV1;
}

export interface AgentLoopActionGatewayPorts {
    readonly clock: () => string;
    /** 当前权威 revision（AL-1 投影）。返回 null = 任务不存在。 */
    readonly readTaskRevision: (taskId: string) => number | null;
    readonly contracts: {
        /** 解析 taskKind → 允许的 action 合同集合。返回 null = 合同未登记。 */
        resolve: (input: Readonly<{
            taskKind: string;
            taskContractRef: string;
        }>) => Readonly<{ actionContractRefs: readonly string[] }> | null;
    };
    readonly policy: {
        evaluate: (input: Readonly<{
            request: AgentLoopActionRequest;
            actionDigest: string;
        }>) => Readonly<{
            decision: 'allow' | 'deny' | 'require-approval';
            reasonCodes: readonly string[];
            contentMode?: string;
        }>;
    };
    readonly budget: {
        /** 原子预留：同一 actionId 重复调用只预留一次（返回 already-reserved）。 */
        reserve: (input: Readonly<{
            actionId: string;
            actionDigest: string;
            estimate: Readonly<Partial<AgentLoopUsageVector>>;
        }>) => 'reserved' | 'already-reserved' | 'insufficient';
        settle: (input: Readonly<{ actionId: string; usage: AgentLoopUsageVector }>) => void;
        release: (input: Readonly<{ actionId: string }>) => void;
    };
    readonly approvals: {
        /** 按绑定摘要查审批；没有记录返回 null。 */
        find: (input: Readonly<{
            approvalBinding: string;
            taskId: string;
            actionDigest: string;
            authorityRevision: string;
            now: string;
        }>) => Readonly<{ granted: boolean; expiresAt: string }> | null;
    };
    readonly receipts: {
        read: (actionId: string) =>
            | Readonly<{ status: 'completed'; actionDigest: string; receiptRef: string }>
            | Readonly<{ status: 'started'; actionDigest: string }>
            | null;
        /** 记「已开始」，在 execute 之前落，用来区分「没发出去」和「发出去了但结果不明」。 */
        markStarted: (input: Readonly<{ actionId: string; actionDigest: string }>) => void;
        writeCompleted: (input: Readonly<{
            actionId: string;
            actionDigest: string;
            receiptRef: string;
            /** Absent on legacy reconciliation: a ref alone is NOT a known result/usage receipt. */
            result?: AgentLoopActionExecutionResult;
        }>) => void;
    };
    /** 未知效果的核对端口：只读业务真值，不重放副作用。 */
    readonly reconcile: {
        readback: (input: Readonly<{
            actionId: string;
            actionContractRef: string;
            args: Readonly<Record<string, unknown>>;
        }>) => Readonly<{
            verdict: 'applied' | 'not-applied' | 'unknown';
            receiptRef?: string;
        }>;
    };
    readonly execute: (input: Readonly<{
        request: AgentLoopActionRequest;
        actionDigest: string;
        estimation: Readonly<Partial<AgentLoopUsageVector>>;
        contentMode: string | null;
    }>) => Promise<AgentLoopActionExecutionResult>;
    /** 子任务准入：`delegate` 决策在创建 child 之前必须过这里（宿主侧判断，不是模型自报）。 */
    readonly delegation?: {
        admit: (input: AgentLoopDelegationRequest) =>
            Readonly<{ admitted: true }> | Readonly<{ admitted: false; reasonCode: string }>;
    };
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;

function delegationRequest(input: AgentLoopDelegationRequest): AgentLoopDelegationRequest {
    const object = (value: unknown): Record<string, unknown> => {
        if (
            !value ||
            typeof value !== 'object' ||
            nodeTypes.isProxy(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        )
            throw new Error('delegation-invalid');
        return Object.fromEntries(
            Reflect.ownKeys(value).map((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
                    throw new Error('delegation-invalid');
                }
                return [key, descriptor.value];
            }),
        );
    };
    const value = object(input);
    const keys = ['parentTaskId', 'childTaskContractRef', 'objective', 'depth', 'activeChildren'];
    if (
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key) && key !== 'decision') ||
        typeof value.parentTaskId !== 'string' ||
        !TOKEN.test(value.parentTaskId) ||
        typeof value.childTaskContractRef !== 'string' ||
        !TOKEN.test(value.childTaskContractRef) ||
        typeof value.objective !== 'string' ||
        value.objective.length < 2 ||
        value.objective.length > 2_000 ||
        !Number.isSafeInteger(value.depth) ||
        Number(value.depth) < 1 ||
        !Number.isSafeInteger(value.activeChildren) ||
        Number(value.activeChildren) < 0
    ) {
        throw new Error('delegation-invalid');
    }
    let decision: AgentLoopDelegateDecisionV1 | undefined;
    if (Object.hasOwn(value, 'decision')) {
        const declaration = object(value.decision);
        if (declaration.kind !== 'delegate') throw new Error('delegation-invalid');
        const normalized = normalizeAgentLoopDecision(declaration);
        if (
            normalized.kind !== 'delegate' ||
            normalized.taskId !== value.parentTaskId ||
            normalized.childTaskContractRef !== value.childTaskContractRef ||
            normalized.objective !== value.objective
        )
            throw new Error('delegation-invalid');
        decision = normalized;
    }
    return Object.freeze({ ...value, ...(decision ? { decision } : {}) }) as unknown as AgentLoopDelegationRequest;
}

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** 动作摘要：参数一变就是新动作，审批与幂等都必须重新判定。 */
export function agentLoopActionDigest(request: Pick<AgentLoopActionRequest,
    'actionId' | 'taskId' | 'attemptId' | 'expectedTaskRevision' | 'actionContractRef' | 'args'>): string {
    return hash({
        kind: 'agent-loop-action-digest-v1',
        actionId: request.actionId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        expectedTaskRevision: request.expectedTaskRevision,
        actionContractRef: request.actionContractRef,
        args: request.args,
    });
}

/** 审批绑定：动作 + 任务 revision + 权限 revision，三者任一变化都要重新审批。 */
export function agentLoopApprovalBinding(input: Readonly<{
    taskId: string;
    actionDigest: string;
    expectedTaskRevision: number;
    authorityRevision: string;
}>): string {
    return hash({ kind: 'agent-loop-approval-binding-v1', ...input });
}

function usageOf(input: Readonly<Partial<AgentLoopUsageVector>> | undefined): AgentLoopUsageVector {
    const zero = {
        modelCalls: 0, toolCalls: 0, writes: 0, inputTokens: 0,
        outputTokens: 0, costMicrousd: 0, wallMs: 0, highRiskActions: 0,
    };
    if (input === undefined) return Object.freeze(zero);
    const merged: Record<string, number> = { ...zero };
    for (const key of Object.keys(zero) as (keyof AgentLoopUsageVector)[]) {
        const value = input[key];
        merged[key] = Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
    }
    return Object.freeze(merged as unknown as AgentLoopUsageVector);
}

/** Snapshot once before persistence: invalid actual usage must not silently become zero. */
function executionResultOf(input: AgentLoopActionExecutionResult): AgentLoopActionExecutionResult {
    const { receiptRef, sourceKind, sourceRef, payloadDigest, payloadRef, completeness } = input;
    if (!Array.isArray(input.evidenceRefs)) throw new Error('agent-loop-action-result-invalid');
    const evidenceRefs = [...input.evidenceRefs];
    const usage = { ...input.usage };
    const usageKeys = Object.keys(usageOf(undefined)) as (keyof AgentLoopUsageVector)[];
    if (typeof receiptRef !== 'string' || typeof sourceRef !== 'string' || typeof payloadDigest !== 'string'
        || !TOKEN.test(receiptRef) || !TOKEN.test(sourceRef) || !HASH.test(payloadDigest)
        || (sourceKind !== 'tool' && sourceKind !== 'domain-readback')
        || !['complete', 'partial', 'unknown'].includes(completeness)
        || (payloadRef !== undefined && (typeof payloadRef !== 'string' || !TOKEN.test(payloadRef)))
        || evidenceRefs.length > 32 || evidenceRefs.some((ref) => typeof ref !== 'string' || !TOKEN.test(ref))
        || new Set(evidenceRefs).size !== evidenceRefs.length
        || Object.keys(usage).length !== usageKeys.length
        || usageKeys.some((key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
        throw new Error('agent-loop-action-result-invalid');
    }
    return Object.freeze({
        receiptRef, sourceKind, sourceRef, payloadDigest,
        ...(payloadRef === undefined ? {} : { payloadRef }),
        completeness, evidenceRefs: Object.freeze(evidenceRefs), usage: Object.freeze(usage),
    });
}

function reject(
    actionId: string,
    steps: string[],
    code: AgentLoopActionReasonCode,
    extra: readonly AgentLoopActionReasonCode[] = [],
): AgentLoopActionOutcome {
    return Object.freeze({
        status: 'rejected' as const,
        actionId,
        steps: Object.freeze([...steps]),
        reasonCodes: Object.freeze([code, ...extra]),
    });
}

export class AgentLoopActionGateway {
    readonly #ports: AgentLoopActionGatewayPorts;

    constructor(ports: AgentLoopActionGatewayPorts) {
        this.#ports = ports;
    }

    /**
     * 唯一动作入口。顺序写死，策略拒绝返回 `rejected`（附已完成步骤，便于审计）。
     * 持久端口故障向原 Coordinator 传播并保守停止，不将未落盘结果包装为成功。
     *
     * `estimation` 只用于预算预留；真实用量以 `execute` 返回的 usage 为准。
     * 持久预算端口可保留 hold 至原 Reducer 消费真实回执；settle 不等于可以提前退款。
     */
    async run(
        request: AgentLoopActionRequest,
        estimation: Readonly<Partial<AgentLoopUsageVector>> = {},
    ): Promise<AgentLoopActionOutcome> {
        const steps: string[] = [];
        if (
            !TOKEN.test(request.actionId) ||
            !TOKEN.test(request.taskId) ||
            !TOKEN.test(request.actionContractRef) ||
            !TOKEN.test(request.taskContractRef) ||
            !TOKEN.test(request.authorityRevision) ||
            !Number.isSafeInteger(request.expectedTaskRevision) ||
            request.expectedTaskRevision < 1
        ) {
            return reject(request.actionId, steps, 'action-input-invalid');
        }
        const actionDigest = agentLoopActionDigest(request);

        // ① task revision：动作必须针对当前权威 revision。
        steps.push('revision');
        const currentRevision = this.#ports.readTaskRevision(request.taskId);
        if (currentRevision === null) return reject(request.actionId, steps, 'action-stale-revision');
        if (currentRevision !== request.expectedTaskRevision) {
            return reject(request.actionId, steps, 'action-stale-revision');
        }

        // ② 合同：taskKind 必须登记过，且该动作合同在允许集合内。
        steps.push('contract');
        const contract = this.#ports.contracts.resolve({
            taskKind: request.taskKind,
            taskContractRef: request.taskContractRef,
        });
        if (!contract || !contract.actionContractRefs.includes(request.actionContractRef)) {
            return reject(request.actionId, steps, 'action-contract-unknown');
        }

        // ③ 身份 / Policy / 内容模式。
        steps.push('policy');
        const policy = this.#ports.policy.evaluate({ request, actionDigest });
        if (policy.decision === 'deny') {
            return reject(request.actionId, steps, 'action-policy-denied');
        }

        // 幂等：完成的直接回放，不执行、不重复预留。
        const existing = this.#ports.receipts.read(request.actionId);
        if (existing?.status === 'completed') {
            if (existing.actionDigest !== actionDigest) {
                return reject(request.actionId, steps, 'action-id-conflict');
            }
            steps.push('replay');
            return Object.freeze({
                status: 'replayed' as const,
                actionId: request.actionId,
                actionDigest,
                receiptRef: existing.receiptRef,
                steps: Object.freeze([...steps]),
            });
        }

        // ④ 预算原子预留（审批之前：没预算就不必去打扰人审批）。
        steps.push('reserve');
        const reservation = this.#ports.budget.reserve({
            actionId: request.actionId,
            actionDigest,
            estimate: estimation,
        });
        if (reservation === 'insufficient') {
            return reject(request.actionId, steps, 'action-budget-insufficient');
        }
        const releaseOnce = () => {
            this.#ports.budget.release({ actionId: request.actionId });
        };

        // ⑤ 审批：绑定 = 动作摘要 + task revision + authority revision，且必须未过期。
        const approvalBinding = agentLoopApprovalBinding({
            taskId: request.taskId,
            actionDigest,
            expectedTaskRevision: request.expectedTaskRevision,
            authorityRevision: request.authorityRevision,
        });
        if (policy.decision === 'require-approval') {
            steps.push('approval');
            const approval = this.#ports.approvals.find({
                approvalBinding,
                taskId: request.taskId,
                actionDigest,
                authorityRevision: request.authorityRevision,
                now: this.#ports.clock(),
            });
            const now = Date.parse(this.#ports.clock());
            if (
                !approval ||
                !approval.granted ||
                !Number.isFinite(Date.parse(approval.expiresAt)) ||
                Date.parse(approval.expiresAt) <= now
            ) {
                releaseOnce();
                return Object.freeze({
                    ...reject(request.actionId, steps, 'action-approval-required'),
                    approvalBinding,
                });
            }
        }

        // ⑥ 幂等 / 未知效果：有 started 无 completed ⇒ 先核对业务真值。
        if (existing?.status === 'started') {
            if (existing.actionDigest !== actionDigest) {
                releaseOnce();
                return reject(request.actionId, steps, 'action-id-conflict');
            }
            steps.push('reconcile');
            const readback = this.#ports.reconcile.readback({
                actionId: request.actionId,
                actionContractRef: request.actionContractRef,
                args: request.args,
            });
            if (readback.verdict === 'applied') {
                const receiptRef = readback.receiptRef ?? `receipt:${request.actionId}`;
                this.#ports.receipts.writeCompleted({
                    actionId: request.actionId,
                    actionDigest,
                    receiptRef,
                });
                // 已经发生的副作用照实用量结算（这里没有可靠 usage，记零并留痕）。
                this.#ports.budget.settle({
                    actionId: request.actionId,
                    usage: usageOf({}),
                });
                return Object.freeze({
                    status: 'reconciled' as const,
                    actionId: request.actionId,
                    actionDigest,
                    receiptRef,
                    steps: Object.freeze([...steps]),
                    reasonCodes: Object.freeze(['action-uncertain-effect'] as const),
                });
            }
            if (readback.verdict === 'unknown') {
                releaseOnce();
                return reject(request.actionId, steps, 'action-reconciliation-required');
            }
            // not-applied：确认没生效，允许继续执行（这不是「重试」，是「第一次没发出去」）。
            steps.push('reconcile-not-applied');
        }

        // ⑦ 执行。先落 started，再动手 —— 崩溃后才知道「可能已经发出去了」。
        steps.push('execute');
        this.#ports.receipts.markStarted({ actionId: request.actionId, actionDigest });
        let executed: Awaited<ReturnType<AgentLoopActionGatewayPorts['execute']>>;
        try {
            executed = executionResultOf(
                await this.#ports.execute({
                    request,
                    actionDigest,
                    estimation,
                    contentMode: policy.contentMode ?? null,
                }),
            );
        } catch {
            // 效果未知：保留 started，交给核对路径；不自动重发。
            releaseOnce();
            return reject(request.actionId, steps, 'action-execution-failed', ['action-uncertain-effect']);
        }

        // ⑧ Observation + ⑨ 用量结算（真实用量覆盖预留）。
        steps.push('observe', 'settle');
        this.#ports.receipts.writeCompleted({
            actionId: request.actionId,
            actionDigest,
            receiptRef: executed.receiptRef,
            result: executed,
        });
        const usage = executed.usage;
        this.#ports.budget.settle({ actionId: request.actionId, usage });

        return Object.freeze({
            status: 'executed' as const,
            actionId: request.actionId,
            actionDigest,
            receiptRef: executed.receiptRef,
            usage,
            steps: Object.freeze([...steps]),
            observation: Object.freeze({
                sourceKind: executed.sourceKind,
                sourceRef: executed.sourceRef,
                payloadDigest: executed.payloadDigest,
                ...(executed.payloadRef === undefined ? {} : { payloadRef: executed.payloadRef }),
                completeness: executed.completeness,
                evidenceRefs: Object.freeze([...executed.evidenceRefs]),
            }),
        });
    }

    /**
     * 子任务准入。`delegate` 只是模型**提议**：创建 child 之前必须过宿主侧准入，
     * 拒绝时给出结构化理由（不静默降级成内联执行——那需要合同允许，属 AL-4 后续）。
     */
    admitDelegation(input: AgentLoopDelegationRequest): Readonly<{ admitted: boolean; reasonCode: string | null }> {
        let request: AgentLoopDelegationRequest;
        try {
            request = delegationRequest(input);
        } catch {
            return Object.freeze({ admitted: false, reasonCode: 'delegation-rejected' });
        }
        if (!this.#ports.delegation) {
            // 没接准入端口就不许创建 child：默认拒绝，绝不默认放行。
            return Object.freeze({ admitted: false, reasonCode: 'delegation-rejected' });
        }
        try {
            const verdict = this.#ports.delegation.admit(request);
            if (
                !verdict ||
                typeof verdict !== 'object' ||
                nodeTypes.isProxy(verdict) ||
                nodeTypes.isPromise(verdict) ||
                ![Object.prototype, null].includes(Object.getPrototypeOf(verdict)) ||
                Reflect.ownKeys(verdict).some(
                    (key) =>
                        typeof key !== 'string' ||
                        !['admitted', 'reasonCode'].includes(key) ||
                        !Object.getOwnPropertyDescriptor(verdict, key)?.enumerable ||
                        !Object.hasOwn(Object.getOwnPropertyDescriptor(verdict, key) ?? {}, 'value'),
                )
            ) {
                return Object.freeze({ admitted: false, reasonCode: 'delegation-rejected' });
            }
            const admitted = Object.getOwnPropertyDescriptor(verdict, 'admitted')?.value;
            const reason = Object.getOwnPropertyDescriptor(verdict, 'reasonCode')?.value;
            if (admitted === true) return Object.freeze({ admitted: true, reasonCode: null });
            return Object.freeze({
                admitted: false,
                reasonCode:
                    admitted === false && typeof reason === 'string' && TOKEN.test(reason)
                        ? reason
                        : 'delegation-rejected',
            });
        } catch {
            return Object.freeze({ admitted: false, reasonCode: 'delegation-rejected' });
        }
    }
}
