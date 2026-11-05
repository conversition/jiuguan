/** @author Codex @date 2026-10-19 @version 1.0
 * AL-2：Observation 的**纯**归约器（`agent-loop-observation-reducer-v1`）。
 *
 * 它只做一件事：拿一条已归一化的 Observation，判定「能不能用它推进 Task 投影」，
 * 能的话产出一份**新 revision** 的 Envelope。没有 I/O、没有随机、不读时钟。
 *
 * 四条硬规则（对应 §11.3 AL-2）：
 * 1. **同 ID 同摘要幂等、同 ID 不同摘要拒绝**：重放不二次记账，冲突不覆盖已成事实。
 * 2. **旧 attempt / 乱序事件只可审计**：`stale` 类**不推进 revision**，且
 *    `satisfiesVerification` 恒为 false —— 迟到的结果不能解除当前等待，也不能满足当前 Verify。
 * 3. **partial / unknown 不得满足完整结果校验**：可以记预算，但不能充当「已验证」。
 * 4. **Reducer 不改 state/phase/wait/completion**：状态迁移属 AL-3，完成门属 AL-5。
 *    这里唯一会变的是 `budget.spent`、`updatedAt` 与 `revision`。
 */
import { createHash } from 'node:crypto';
import {
    normalizeAgentLoopObservation,
    type AgentLoopObservationEnvelopeV1,
    normalizeAgentLoopTaskEnvelope,
    type AgentLoopTaskBudgetVectorV1,
    type AgentLoopTaskEnvelopeV1,
} from '@jiuguan/agent-loop-contract';

export const AGENT_LOOP_OBSERVATION_REDUCER_VERSION =
    'agent-loop-observation-reducer-v1' as const;

/** 归约结论闭集。除 `applied` 外都不推进 revision。 */
export const AGENT_LOOP_OBSERVATION_CLASSIFICATIONS = Object.freeze([
    'applied',
    'duplicate',
    'stale',
    'conflict',
] as const);
export type AgentLoopObservationClassification =
    typeof AGENT_LOOP_OBSERVATION_CLASSIFICATIONS[number];

/**
 * 归约理由闭集。故意不复用上游错误文本：理由码描述的是**投影为什么这样动**，
 * 不是「上游怎么了」。
 */
export const AGENT_LOOP_OBSERVATION_REASON_CODES = Object.freeze([
    'observation-duplicate',
    'observation-id-conflict',
    'observation-task-mismatch',
    'observation-future-revision',
    'observation-attempt-superseded',
    'observation-task-revision-stale',
    'observation-partial-result',
    'observation-unknown-completeness',
    'observation-budget-overrun',
] as const);
export type AgentLoopObservationReasonCode =
    typeof AGENT_LOOP_OBSERVATION_REASON_CODES[number];

export interface AgentLoopObservationReduction {
    readonly reducerVersion: typeof AGENT_LOOP_OBSERVATION_REDUCER_VERSION;
    readonly classification: AgentLoopObservationClassification;
    /** 仅 `applied` 时非 null；其余情况投影必须保持原样。 */
    readonly envelope: AgentLoopTaskEnvelopeV1 | null;
    readonly reasonCodes: readonly AgentLoopObservationReasonCode[];
    /**
     * 这条 Observation 能否用来满足 Verify 的完整结果校验。
     * `stale` / `duplicate` / `conflict` / partial / unknown 一律 false ——
     * 「迟到或残缺的结果不能算通过」的唯一执行点。
     */
    readonly satisfiesVerification: boolean;
}

const USAGE_KEYS = Object.freeze([
    'modelCalls', 'toolCalls', 'writes', 'inputTokens', 'outputTokens',
    'costMicrousd', 'wallMs', 'highRiskActions',
] as const);

/** Observation 内容的规范摘要（不含 `ingestedAt`：入库时间不是内容）。 */
export function agentLoopObservationDigest(observation: AgentLoopObservationEnvelopeV1): string {
    const core = {
        contractVersion: observation.contractVersion,
        observationId: observation.observationId,
        taskId: observation.taskId,
        attemptId: observation.attemptId,
        observedForTaskRevision: observation.observedForTaskRevision,
        sourceKind: observation.sourceKind,
        sourceRef: observation.sourceRef,
        ...(observation.causalActionId === undefined
            ? {} : { causalActionId: observation.causalActionId }),
        ...(observation.correlationRef === undefined
            ? {} : { correlationRef: observation.correlationRef }),
        observedAt: observation.observedAt,
        payloadDigest: observation.payloadDigest,
        ...(observation.payloadRef === undefined ? {} : { payloadRef: observation.payloadRef }),
        completeness: observation.completeness,
        evidenceRefs: observation.evidenceRefs,
        ...(observation.usageDelta === undefined ? {} : { usageDelta: observation.usageDelta }),
    };
    return `sha256:${createHash('sha256').update(JSON.stringify(core)).digest('hex')}`;
}

/**
 * 累加已花费预算。**不裁剪到 granted**：超支是要看见的事实，
 * 钳掉它等于把「超预算」这个最该报警的信号抹平。
 */
function addSpent(
    spent: AgentLoopTaskBudgetVectorV1,
    delta: AgentLoopObservationEnvelopeV1['usageDelta'],
): AgentLoopTaskBudgetVectorV1 {
    if (delta === undefined) return spent;
    const next: Record<string, number> = {};
    for (const key of USAGE_KEYS) {
        const value = Number(spent[key]) + Number(delta[key]);
        next[key] = Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
    }
    // childTasks 不来自 usageDelta（子任务是派发事实，不是用量），原样保留。
    next.childTasks = spent.childTasks;
    return Object.freeze(next as unknown as AgentLoopTaskBudgetVectorV1);
}

export function reduceAgentLoopObservation(input: Readonly<{
    envelope: AgentLoopTaskEnvelopeV1;
    observation: unknown;
    /** 同一 observationId 已落库的摘要；undefined/null 表示从未见过。 */
    storedDigest?: string | null;
}>): AgentLoopObservationReduction {
    const envelope = input.envelope;
    const observation = normalizeAgentLoopObservation(input.observation);
    const digest = agentLoopObservationDigest(observation);

    const result = (
        classification: AgentLoopObservationClassification,
        reasonCodes: readonly AgentLoopObservationReasonCode[],
        next: AgentLoopTaskEnvelopeV1 | null,
        satisfiesVerification: boolean,
    ): AgentLoopObservationReduction => Object.freeze({
        reducerVersion: AGENT_LOOP_OBSERVATION_REDUCER_VERSION,
        classification,
        envelope: next,
        reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
        satisfiesVerification,
    });

    // 1. 幂等 / 冲突：先看身份，再看内容。
    if (input.storedDigest !== undefined && input.storedDigest !== null) {
        if (input.storedDigest === digest) {
            // 重放：投影不动，也绝不允许用它再满足一次 Verify。
            return result('duplicate', ['observation-duplicate'], null, false);
        }
        return result('conflict', ['observation-id-conflict'], null, false);
    }

    // 2. 身份不匹配：这条 Observation 根本不属于这个任务。
    if (observation.taskId !== envelope.taskId) {
        return result('conflict', ['observation-task-mismatch'], null, false);
    }
    // 3. 观测的是「还没发生的 revision」：不能应用（否则让未来事实改现在）。
    if (observation.observedForTaskRevision > envelope.revision) {
        return result('conflict', ['observation-future-revision'], null, false);
    }
    // 4. 旧 attempt：上一个 attempt 的迟到结果只可审计。
    if (envelope.currentAttemptId !== undefined
        && observation.attemptId !== envelope.currentAttemptId) {
        return result('stale', ['observation-attempt-superseded'], null, false);
    }
    // 5. 旧 revision：乱序到达的旧观测只可审计。
    if (observation.observedForTaskRevision < envelope.revision) {
        return result('stale', ['observation-task-revision-stale'], null, false);
    }

    // 6. 可应用：只动 budget.spent / updatedAt / revision。
    const reasons: AgentLoopObservationReasonCode[] = [];
    const spent = addSpent(envelope.budget.spent, observation.usageDelta);
    if (USAGE_KEYS.some((key) => Number(spent[key]) > Number(envelope.budget.granted[key]))) {
        reasons.push('observation-budget-overrun');
    }

    let satisfiesVerification = true;
    if (observation.completeness === 'partial') {
        reasons.push('observation-partial-result');
        satisfiesVerification = false;
    } else if (observation.completeness === 'unknown') {
        reasons.push('observation-unknown-completeness');
        satisfiesVerification = false;
    }

    const updatedAt = Date.parse(observation.ingestedAt) >= Date.parse(envelope.updatedAt)
        ? observation.ingestedAt
        : envelope.updatedAt;
    // 用合同自己的 normalizer 复核我们刚构造的投影：不信任自己的组装。
    const next = normalizeAgentLoopTaskEnvelope({
        ...envelope,
        budget: { ...envelope.budget, spent },
        revision: envelope.revision + 1,
        updatedAt,
    });
    return result('applied', reasons, next, satisfiesVerification);
}
