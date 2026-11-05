/** @author Codex @date 2026-10-19 @version 1.0
 * CX-4 收口：**可重建的 ActiveContext 快照与 Continuation**（`agent-loop-continuation-v1`）。
 *
 * 目标不是再造一个 Store，而是把「模型窗口」和「任务真值」彻底分开：
 * 窗口是可丢弃的本轮视图，真正能重建续跑状态的是
 * **TaskProjection（AL-1，revision CAS）+ 已登记 typed ref（v3 表）+ 领域 resolver**。
 *
 * 三条不可退让的边界：
 * 1) **快照只从权威投影派生**：`buildActiveContextSnapshot()` 是纯函数，输入是
 *    `AgentLoopTaskRecord`（含 revision / envelopeDigest）+ ref / observation / event 列表，
 *    输出带 `snapshotDigest`。同一投影 ⇒ 同一摘要；Observation 重放是确定性的 ⇒ 重放后摘要相同。
 *    EventHub 只能拿它去做「快照失效，重新取」的通知，不能把内容当历史。
 * 2) **正文永远不搬过来**：ref 的解析结果只允许带 `loaderRef` + `tokens`（引用 + 预算），
 *    带正文的 resolver 直接判非法。领域 Store 才是正文所有者。
 * 3) **四态必须分开报**：`fresh / stale / digest-mismatch / missing`（外加 `forbidden`
 *    与 `unresolved`）是不同故障，不许合并成「取不到」。未知副作用的动作
 *    （`action-started` 无 `action-completed`）一律 `readback-required`，**不重放**。
 */
import { createHash } from 'node:crypto';
import type {
    AgentLoopPhase,
    AgentLoopTaskState,
} from '@jiuguan/agent-loop-contract';
import type { AgentLoopTaskBudgetKey } from '@jiuguan/agent-loop-contract';
import type {
    AgentLoopArtifactRefAclClass,
    AgentLoopArtifactRefKind,
    AgentLoopArtifactRefPolicy,
    AgentLoopArtifactRefRecord,
    AgentLoopObservationRecord,
    AgentLoopProjectionStore,
    AgentLoopTaskEvent,
    AgentLoopTaskRecord,
} from './agent-loop-projection-store.ts';
import {
    AGENT_LOOP_ARTIFACT_REF_ACL_CLASSES,
    AGENT_LOOP_ARTIFACT_REF_KINDS,
} from './agent-loop-projection-store.ts';

export const AGENT_LOOP_ACTIVE_CONTEXT_VERSION = 'agent-loop-active-context-v1' as const;
export const AGENT_LOOP_CONTINUATION_VERSION = 'agent-loop-continuation-v1' as const;
export const AGENT_LOOP_CONTINUATION_NOTIFICATION_VERSION =
    'agent-loop-continuation-notification-v1' as const;

export const AGENT_LOOP_CONTINUATION_ERROR_CODES = Object.freeze([
    'agent-loop-continuation-input-invalid',
    'agent-loop-continuation-record-missing',
    'agent-loop-continuation-snapshot-stale',
] as const);
export type AgentLoopContinuationErrorCode =
    typeof AGENT_LOOP_CONTINUATION_ERROR_CODES[number];

export class AgentLoopContinuationError extends Error {
    constructor(readonly code: AgentLoopContinuationErrorCode) {
        if (!(AGENT_LOOP_CONTINUATION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('agent-loop-continuation-error-code-invalid');
        }
        super(code);
        this.name = 'AgentLoopContinuationError';
    }
}

function reject(code: AgentLoopContinuationErrorCode): never {
    throw new AgentLoopContinuationError(code);
}

/** ref 的解析状态。`deferred` 不是故障：定位到了，只是展开预算不够。 */
export const AGENT_LOOP_REF_STATUSES = Object.freeze([
    'fresh',
    'stale',
    'digest-mismatch',
    'missing',
    'forbidden',
    'unresolved',
    'deferred',
] as const);
export type AgentLoopRefStatus = typeof AGENT_LOOP_REF_STATUSES[number];

export const AGENT_LOOP_CONTINUATION_REASON_CODES = Object.freeze([
    'continuation-required-ref-missing',
    'continuation-required-ref-stale',
    'continuation-required-ref-digest-mismatch',
    'continuation-required-ref-forbidden',
    'continuation-required-ref-unresolved',
    'continuation-optional-ref-degraded',
    'continuation-expansion-budget-exhausted',
    'continuation-unknown-effect-readback-required',
    'continuation-task-fenced',
    'continuation-task-terminal',
] as const);
export type AgentLoopContinuationReasonCode =
    typeof AGENT_LOOP_CONTINUATION_REASON_CODES[number];

export type AgentLoopContinuationCompleteness = 'complete' | 'degraded' | 'blocked';
export type AgentLoopContinuationReplayPolicy = 'allowed' | 'readback-required';

export interface AgentLoopBudgetVectorView {
    readonly granted: Readonly<Record<string, number>>;
    readonly reserved: Readonly<Record<string, number>>;
    readonly spent: Readonly<Record<string, number>>;
    /** `granted - reserved - spent`；负数表示已超支（不裁剪，超支要能被看见）。 */
    readonly remaining: Readonly<Record<string, number>>;
}

export interface AgentLoopSourceWatermark {
    readonly taskRevision: number;
    readonly envelopeDigest: string;
    readonly updatedAt: string;
    readonly appliedObservations: number;
    readonly lastAppliedObservationId: string | null;
    readonly lastAppliedAttemptId: string | null;
}

export interface AgentLoopActiveContextSnapshotV1 {
    readonly contextVersion: typeof AGENT_LOOP_ACTIVE_CONTEXT_VERSION;
    readonly taskId: string;
    readonly rootTaskId: string;
    readonly parentTaskId: string | null;
    readonly attemptId: string | null;
    readonly taskRevision: number;
    readonly envelopeDigest: string;
    readonly state: AgentLoopTaskState;
    readonly phase: AgentLoopPhase;
    readonly fenced: boolean;
    readonly goal: Readonly<{ summary: string; sourceRefs: readonly string[] }>;
    /**
     * 「续跑时必须继续成立」的东西。全部来自 Envelope 既有字段，不发明新事实：
     * 合同版本、verifier 绑定、预算策略、以及 goal 的受保护来源。
     */
    readonly constraints: Readonly<{
        taskContractRef: string;
        verifierSetRef: string;
        verifierSetRevision: string;
        budgetPolicyRef: string;
        goalSourceRefs: readonly string[];
    }>;
    readonly plan: Readonly<{
        planRef: string;
        planRevision: string;
        summary: string;
        todoOrder: readonly string[];
    }> | null;
    readonly todos: readonly Readonly<{
        todoId: string;
        status: string;
        evidenceRefs: readonly string[];
    }>[];
    readonly confirmedFacts: readonly Readonly<{
        factId: string;
        statement: string;
        evidenceRefs: readonly string[];
    }>[];
    readonly openBlockers: readonly Readonly<{
        blockerId: string;
        reasonCode: string;
        evidenceRefs: readonly string[];
    }>[];
    readonly openChildren: readonly Readonly<{
        taskId: string;
        requirement: string;
        state: string;
        joinState: string;
    }>[];
    readonly wait: Readonly<{
        waitId: string;
        kind: string;
        correlationRef: string;
        expectedObservationContractRef: string;
        resumePredicateRef: string;
        since: string;
        deadlineAt: string | null;
    }> | null;
    readonly budget: AgentLoopBudgetVectorView;
    readonly sourceWatermark: AgentLoopSourceWatermark;
    /** 已登记的 typed ref（按 refId 字典序）。 */
    readonly artifactRefs: readonly Readonly<{
        refId: string;
        kind: AgentLoopArtifactRefKind;
        policy: AgentLoopArtifactRefPolicy;
        aclClass: AgentLoopArtifactRefAclClass;
    }>[];
    /** Envelope 自己声明的工件（可能尚未登记 typed ref，两者不合并、不互相冒充）。 */
    readonly envelopeArtifacts: readonly Readonly<{
        artifactRef: string;
        kind: string;
        status: string;
    }>[];
    readonly evidenceRefs: readonly string[];
    /** 有 started/uncertain 但没 completed/reconciled 的动作 ⇒ 效果未知，不能重放。 */
    readonly unsettledActionIds: readonly string[];
    readonly snapshotDigest: string;
}

function digestOf(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function sortedCopy(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null);
}

function actionIdsFromEvents(
    events: readonly AgentLoopTaskEvent[],
): readonly string[] {
    const opened = new Set<string>();
    const closed = new Set<string>();
    for (const event of events) {
        const kind = event.kind;
        if (kind !== 'action-started' && kind !== 'action-uncertain'
            && kind !== 'action-completed' && kind !== 'action-reconciled') continue;
        const prefix = `${kind}:`;
        if (!event.eventId.startsWith(prefix)) continue;
        const actionId = event.eventId.slice(prefix.length);
        if (!actionId) continue;
        if (kind === 'action-completed' || kind === 'action-reconciled') closed.add(actionId);
        else opened.add(actionId);
    }
    return [...opened].filter((actionId) => !closed.has(actionId)).sort();
}

function appliedWatermark(
    observations: readonly AgentLoopObservationRecord[],
): Pick<AgentLoopSourceWatermark,
    'appliedObservations' | 'lastAppliedObservationId' | 'lastAppliedAttemptId'> {
    const applied = observations
        .filter((item) => item.classification === 'applied')
        .slice()
        .sort((left, right) => {
            const leftRevision = left.appliedRevision ?? 0;
            const rightRevision = right.appliedRevision ?? 0;
            if (leftRevision !== rightRevision) return leftRevision - rightRevision;
            return left.observationId < right.observationId ? -1
                : left.observationId > right.observationId ? 1 : 0;
        });
    const last = applied.at(-1);
    return {
        appliedObservations: applied.length,
        lastAppliedObservationId: last ? last.observationId : null,
        lastAppliedAttemptId: last ? last.attemptId : null,
    };
}

/**
 * 从权威投影派生 ActiveContext 快照（纯函数，无 IO、无端口）。
 *
 * 摘要只看**投影事实**：revision、envelopeDigest、goal/plan/todo/blocker/wait/budget、
 * ref 清单、动作水位。不含任何领域正文，也不含 resolver 的返回，因此
 * 「换 Worker / 清空窗口」后只要投影与 ref 相同，摘要必然相同。
 */
export function buildActiveContextSnapshot(input: Readonly<{
    record: AgentLoopTaskRecord;
    refs?: readonly AgentLoopArtifactRefRecord[];
    observations?: readonly AgentLoopObservationRecord[];
    events?: readonly AgentLoopTaskEvent[];
}>): AgentLoopActiveContextSnapshotV1 {
    if (!isRecord(input) || !isRecord(input.record) || !isRecord(input.record.envelope)) {
        reject('agent-loop-continuation-input-invalid');
    }
    const record = input.record;
    const envelope = record.envelope;
    const refs = [...(input.refs ?? [])]
        .sort((left, right) => (left.refId < right.refId ? -1 : left.refId > right.refId ? 1 : 0));
    const events = input.events ?? [];
    const observations = input.observations ?? [];

    const budgetKeys = Object.keys(envelope.budget.granted).sort();
    const granted: Record<string, number> = {};
    const reserved: Record<string, number> = {};
    const spent: Record<string, number> = {};
    const remaining: Record<string, number> = {};
    for (const key of budgetKeys) {
        const grantedValue = envelope.budget.granted[key as AgentLoopTaskBudgetKey] ?? 0;
        const reservedValue = envelope.budget.reserved[key as AgentLoopTaskBudgetKey] ?? 0;
        const spentValue = envelope.budget.spent[key as AgentLoopTaskBudgetKey] ?? 0;
        granted[key] = grantedValue;
        reserved[key] = reservedValue;
        spent[key] = spentValue;
        remaining[key] = grantedValue - reservedValue - spentValue;
    }

    const evidenceRefs = sortedCopy([
        ...envelope.todos.flatMap((item) => [...item.evidenceRefs]),
        ...envelope.confirmedFacts.flatMap((item) => [...item.evidenceRefs]),
        ...envelope.blockers.flatMap((item) => [...item.evidenceRefs]),
        ...envelope.children.flatMap((item) => [...item.evidenceRefs]),
        ...envelope.artifacts.flatMap((item) => [...item.evidenceRefs]),
        ...(envelope.completion?.evidenceRefs ?? []),
        ...envelope.goal.sourceRefs,
    ]);

    const snapshot = {
        contextVersion: AGENT_LOOP_ACTIVE_CONTEXT_VERSION,
        taskId: envelope.taskId,
        rootTaskId: envelope.rootTaskId,
        parentTaskId: envelope.parentTaskId ?? null,
        attemptId: envelope.currentAttemptId ?? null,
        taskRevision: record.revision,
        envelopeDigest: record.envelopeDigest,
        state: envelope.state,
        phase: envelope.phase,
        fenced: record.fenced,
        goal: {
            summary: envelope.goal.summary,
            sourceRefs: [...envelope.goal.sourceRefs],
        },
        constraints: {
            taskContractRef: envelope.taskContractRef,
            verifierSetRef: envelope.verifier.verifierSetRef,
            verifierSetRevision: envelope.verifier.verifierSetRevision,
            budgetPolicyRef: envelope.budget.policyRef,
            goalSourceRefs: [...envelope.goal.sourceRefs],
        },
        plan: envelope.plan
            ? {
                planRef: envelope.plan.planRef,
                planRevision: envelope.plan.planRevision,
                summary: envelope.plan.summary,
                todoOrder: [...envelope.plan.todoOrder],
            }
            : null,
        todos: envelope.todos.map((item) => ({
            todoId: item.todoId,
            status: item.status,
            evidenceRefs: [...item.evidenceRefs],
        })),
        confirmedFacts: envelope.confirmedFacts.map((item) => ({
            factId: item.factId,
            statement: item.statement,
            evidenceRefs: [...item.evidenceRefs],
        })),
        openBlockers: envelope.blockers
            .filter((item) => item.status === 'open')
            .map((item) => ({
                blockerId: item.blockerId,
                reasonCode: item.reasonCode,
                evidenceRefs: [...item.evidenceRefs],
            })),
        openChildren: envelope.children
            .filter((item) => item.joinState !== 'accepted' && item.joinState !== 'rejected')
            .map((item) => ({
                taskId: item.taskId,
                requirement: item.requirement,
                state: item.state,
                joinState: item.joinState,
            })),
        wait: envelope.wait
            ? {
                waitId: envelope.wait.waitId,
                kind: envelope.wait.kind,
                correlationRef: envelope.wait.correlationRef,
                expectedObservationContractRef: envelope.wait.expectedObservationContractRef,
                resumePredicateRef: envelope.wait.resumePredicateRef,
                since: envelope.wait.since,
                deadlineAt: envelope.wait.deadlineAt ?? null,
            }
            : null,
        budget: { granted, reserved, spent, remaining },
        sourceWatermark: {
            taskRevision: record.revision,
            envelopeDigest: record.envelopeDigest,
            updatedAt: envelope.updatedAt,
            ...appliedWatermark(observations),
        },
        artifactRefs: refs.map((ref) => ({
            refId: ref.refId,
            kind: ref.kind,
            policy: ref.policy,
            aclClass: ref.aclClass,
        })),
        envelopeArtifacts: envelope.artifacts.map((item) => ({
            artifactRef: item.artifactRef,
            kind: item.kind,
            status: item.status,
        })),
        evidenceRefs,
        unsettledActionIds: actionIdsFromEvents(events),
    };

    return Object.freeze({
        ...snapshot,
        snapshotDigest: digestOf(snapshot),
    }) as AgentLoopActiveContextSnapshotV1;
}

/** 快照必须与当前投影同一条 revision；否则是**旧窗口**，不能拿来续跑。 */
export function assertActiveContextSnapshotCurrent(
    snapshot: AgentLoopActiveContextSnapshotV1,
    record: AgentLoopTaskRecord,
): void {
    if (snapshot.taskId !== record.envelope.taskId
        || snapshot.taskRevision !== record.revision
        || snapshot.envelopeDigest !== record.envelopeDigest) {
        reject('agent-loop-continuation-snapshot-stale');
    }
}

export interface AgentLoopRefResolverRequest {
    readonly refId: string;
    readonly kind: AgentLoopArtifactRefKind;
    readonly ownerRef: string;
    readonly expectedDigest: string;
    readonly expectedRevision?: string;
}

/** resolver 只能回「定位结果」，**不能回正文**（`content` 字段会被判非法）。 */
export interface AgentLoopRefResolution {
    readonly status: 'found' | 'missing' | 'forbidden' | 'stale' | 'digest-mismatch';
    readonly revision?: string;
    readonly digest?: string;
    readonly expandable?: Readonly<{ loaderRef: string; tokens: number }>;
}

export type AgentLoopRefResolver = (
    request: AgentLoopRefResolverRequest,
) => AgentLoopRefResolution | Promise<AgentLoopRefResolution>;

export interface AgentLoopRefState {
    readonly refId: string;
    readonly kind: AgentLoopArtifactRefKind;
    readonly policy: AgentLoopArtifactRefPolicy;
    readonly status: AgentLoopRefStatus;
    readonly reasonCode: AgentLoopContinuationReasonCode | null;
    readonly revision: string | null;
    readonly digest: string | null;
    readonly expansion: Readonly<{ loaderRef: string; tokens: number }> | null;
}

export interface AgentLoopContinuationV1 {
    readonly continuationVersion: typeof AGENT_LOOP_CONTINUATION_VERSION;
    readonly taskId: string;
    readonly taskRevision: number;
    readonly snapshotDigest: string;
    readonly completeness: AgentLoopContinuationCompleteness;
    readonly reasonCodes: readonly AgentLoopContinuationReasonCode[];
    readonly refStates: readonly AgentLoopRefState[];
    readonly expansion: Readonly<{
        budgetTokens: number;
        usedTokens: number;
        deferredRefIds: readonly string[];
    }>;
    readonly resume: Readonly<{
        state: AgentLoopTaskState;
        phase: AgentLoopPhase;
        attemptId: string | null;
        waitId: string | null;
    }>;
    readonly replay: Readonly<{
        policy: AgentLoopContinuationReplayPolicy;
        mustNotReplayActionIds: readonly string[];
    }>;
    readonly continuationDigest: string;
}

const TERMINAL_STATES: readonly AgentLoopTaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const EXPANDABLE_KEYS = new Set(['status', 'revision', 'digest', 'expandable']);
const EXPANDABLE_KEYS_INNER = new Set(['loaderRef', 'tokens']);

function validateResolution(value: unknown): AgentLoopRefResolution {
    if (!isRecord(value)) reject('agent-loop-continuation-input-invalid');
    for (const key of Object.keys(value)) {
        if (!EXPANDABLE_KEYS.has(key)) reject('agent-loop-continuation-input-invalid');
    }
    const status = value.status;
    if (
        status !== 'found' &&
        status !== 'missing' &&
        status !== 'forbidden' &&
        status !== 'stale' &&
        status !== 'digest-mismatch'
    ) {
        reject('agent-loop-continuation-input-invalid');
    }
    if (value.revision !== undefined && typeof value.revision !== 'string') {
        reject('agent-loop-continuation-input-invalid');
    }
    if (value.digest !== undefined
        && (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest))) {
        reject('agent-loop-continuation-input-invalid');
    }
    if (value.expandable !== undefined) {
        const expandable = value.expandable;
        if (!isRecord(expandable)) reject('agent-loop-continuation-input-invalid');
        for (const key of Object.keys(expandable)) {
            if (!EXPANDABLE_KEYS_INNER.has(key)) reject('agent-loop-continuation-input-invalid');
        }
        if (typeof expandable.loaderRef !== 'string' || !expandable.loaderRef.trim()
            || !Number.isSafeInteger(expandable.tokens) || Number(expandable.tokens) < 0) {
            reject('agent-loop-continuation-input-invalid');
        }
        return {
            status,
            ...(value.revision === undefined ? {} : { revision: value.revision as string }),
            ...(value.digest === undefined ? {} : { digest: value.digest as string }),
            expandable: {
                loaderRef: expandable.loaderRef as string,
                tokens: Number(expandable.tokens),
            },
        };
    }
    return {
        status,
        ...(value.revision === undefined ? {} : { revision: value.revision as string }),
        ...(value.digest === undefined ? {} : { digest: value.digest as string }),
    };
}

function requiredReason(status: AgentLoopRefStatus): AgentLoopContinuationReasonCode | null {
    switch (status) {
        case 'missing': return 'continuation-required-ref-missing';
        case 'stale': return 'continuation-required-ref-stale';
        case 'digest-mismatch': return 'continuation-required-ref-digest-mismatch';
        case 'forbidden': return 'continuation-required-ref-forbidden';
        case 'unresolved': return 'continuation-required-ref-unresolved';
        default: return null;
    }
}

function optionalReason(status: AgentLoopRefStatus): AgentLoopContinuationReasonCode | null {
    if (status === 'fresh' || status === 'deferred') return null;
    return 'continuation-optional-ref-degraded';
}

/**
 * 解析 ref 并产出 Continuation。
 *
 * 逐条判定的顺序是**固定的**，因为顺序本身就是语义：ACL → resolver 存在性 →
 * 领域拒绝（missing/forbidden/stale/digest-mismatch）→ digest 复验 → revision 复验 → 展开预算。
 * fresh 的 digest 必须由 resolver 给出；found 给不出摘要就只能是 `unresolved`，
 * 否则「没验证」会被伪装成「验证通过」。
 */
export async function resolveAgentLoopContinuation(input: Readonly<{
    snapshot: AgentLoopActiveContextSnapshotV1;
    refs: readonly AgentLoopArtifactRefRecord[];
    resolvers: Readonly<Partial<Record<AgentLoopArtifactRefKind, AgentLoopRefResolver>>>;
    grantedAclClasses?: readonly AgentLoopArtifactRefAclClass[];
    expansionBudgetTokens?: number;
}>): Promise<AgentLoopContinuationV1> {
    if (!isRecord(input) || !isRecord(input.snapshot)) {
        reject('agent-loop-continuation-input-invalid');
    }
    const snapshot = input.snapshot;
    const budgetTokens = input.expansionBudgetTokens ?? 0;
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) {
        reject('agent-loop-continuation-input-invalid');
    }
    const granted = new Set<AgentLoopArtifactRefAclClass>(
        input.grantedAclClasses ?? ['task', 'session'],
    );
    for (const value of granted) {
        if (!(AGENT_LOOP_ARTIFACT_REF_ACL_CLASSES as readonly string[]).includes(value)) {
            reject('agent-loop-continuation-input-invalid');
        }
    }

    const refs = [...input.refs]
        .sort((left, right) => (left.refId < right.refId ? -1 : left.refId > right.refId ? 1 : 0));
    const reasons = new Set<AgentLoopContinuationReasonCode>();
    const refStates: AgentLoopRefState[] = [];
    const deferredRefIds: string[] = [];
    let used = 0;

    for (const ref of refs) {
        if (!(AGENT_LOOP_ARTIFACT_REF_KINDS as readonly string[]).includes(ref.kind)) {
            reject('agent-loop-continuation-input-invalid');
        }
        const state = (status: AgentLoopRefStatus,
            extra: Partial<Omit<AgentLoopRefState, 'refId' | 'kind' | 'policy' | 'status'>> = {},
        ): AgentLoopRefState => Object.freeze({
            refId: ref.refId,
            kind: ref.kind,
            policy: ref.policy,
            status,
            reasonCode: null,
            revision: null,
            digest: null,
            expansion: null,
            ...extra,
        });

        if (!granted.has(ref.aclClass)) {
            const status: AgentLoopRefStatus = 'forbidden';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason }));
            continue;
        }

        const resolver = input.resolvers[ref.kind];
        if (!resolver) {
            const status: AgentLoopRefStatus = 'unresolved';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason }));
            continue;
        }

        let resolution: AgentLoopRefResolution;
        try {
            resolution = validateResolution(await resolver({
                refId: ref.refId,
                kind: ref.kind,
                ownerRef: ref.ownerRef,
                expectedDigest: ref.expectedDigest,
                ...(ref.expectedRevision === undefined
                    ? {} : { expectedRevision: ref.expectedRevision }),
            }));
        } catch (error) {
            if (error instanceof AgentLoopContinuationError) throw error;
            const status: AgentLoopRefStatus = 'unresolved';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason }));
            continue;
        }

        if (resolution.status !== 'found') {
            const status: AgentLoopRefStatus = resolution.status;
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, {
                reasonCode: reason,
                revision: resolution.revision ?? null,
                digest: resolution.digest ?? null,
            }));
            continue;
        }

        const revision = resolution.revision ?? null;
        const digest = resolution.digest ?? null;
        // 给不出摘要 = 没验证，不能当 fresh。
        if (digest === null) {
            const status: AgentLoopRefStatus = 'unresolved';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason, revision }));
            continue;
        }
        if (digest !== ref.expectedDigest) {
            const status: AgentLoopRefStatus = 'digest-mismatch';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason, revision, digest }));
            continue;
        }
        if (ref.expectedRevision !== undefined && revision !== ref.expectedRevision) {
            const status: AgentLoopRefStatus = 'stale';
            const reason = ref.policy === 'required'
                ? requiredReason(status) : optionalReason(status);
            if (reason) reasons.add(reason);
            refStates.push(state(status, { reasonCode: reason, revision, digest }));
            continue;
        }

        const expandable = resolution.expandable ?? null;
        const tokens = expandable ? expandable.tokens : 0;
        // The persisted per-ref cap is an authority boundary, not documentation.
        // A large global budget must never make one ref expandable beyond its own grant.
        if (expandable && (tokens > ref.expandBudgetTokens || used + tokens > budgetTokens)) {
            deferredRefIds.push(ref.refId);
            reasons.add('continuation-expansion-budget-exhausted');
            refStates.push(state('deferred', {
                reasonCode: ref.policy === 'required'
                    ? 'continuation-expansion-budget-exhausted'
                    : optionalReason('deferred'),
                revision,
                digest,
            }));
            continue;
        }
        used += tokens;
        refStates.push(state('fresh', {
            revision,
            digest,
            expansion: expandable
                ? { loaderRef: expandable.loaderRef, tokens } : null,
        }));
    }

    let completeness: AgentLoopContinuationCompleteness = 'complete';
    for (const state of refStates) {
        if (state.status === 'fresh' || state.status === 'deferred') continue;
        if (state.policy === 'required') completeness = 'blocked';
        else if (completeness !== 'blocked') completeness = 'degraded';
    }
    if (snapshot.fenced) {
        reasons.add('continuation-task-fenced');
        completeness = 'blocked';
    }
    if (TERMINAL_STATES.includes(snapshot.state)) {
        reasons.add('continuation-task-terminal');
        completeness = 'blocked';
    }

    const mustNotReplayActionIds = [...snapshot.unsettledActionIds].sort();
    if (mustNotReplayActionIds.length) {
        reasons.add('continuation-unknown-effect-readback-required');
    }
    const replayPolicy: AgentLoopContinuationReplayPolicy =
        mustNotReplayActionIds.length ? 'readback-required' : 'allowed';

    const reasonCodes = [...reasons].sort();
    const payload = {
        continuationVersion: AGENT_LOOP_CONTINUATION_VERSION,
        taskId: snapshot.taskId,
        taskRevision: snapshot.taskRevision,
        snapshotDigest: snapshot.snapshotDigest,
        completeness,
        reasonCodes,
        refStates,
        expansion: {
            budgetTokens,
            usedTokens: used,
            deferredRefIds: [...deferredRefIds].sort(),
        },
        resume: {
            state: snapshot.state,
            phase: snapshot.phase,
            attemptId: snapshot.attemptId,
            waitId: snapshot.wait ? snapshot.wait.waitId : null,
        },
        replay: { policy: replayPolicy, mustNotReplayActionIds },
    };

    return Object.freeze({
        ...payload,
        continuationDigest: digestOf(payload),
    }) as AgentLoopContinuationV1;
}

/**
 * 换 Worker 的唯一入口：**不接收任何内存态**，只从 Store 重读权威投影与 ref。
 * 这就是「清空窗口后能否恢复」的实测口径。
 */
export async function recoverAgentLoopContinuation(input: Readonly<{
    store: Pick<AgentLoopProjectionStore,
        'read' | 'readRefs' | 'readObservations' | 'readEvents'>;
    taskId: string;
    resolvers: Readonly<Partial<Record<AgentLoopArtifactRefKind, AgentLoopRefResolver>>>;
    grantedAclClasses?: readonly AgentLoopArtifactRefAclClass[];
    expansionBudgetTokens?: number;
}>): Promise<Readonly<{
    snapshot: AgentLoopActiveContextSnapshotV1;
    continuation: AgentLoopContinuationV1;
}>> {
    if (!isRecord(input) || typeof input.taskId !== 'string' || !input.taskId.trim()) {
        reject('agent-loop-continuation-input-invalid');
    }
    // 端口按**能力**检查：Store 是类实例（原型不是 Object.prototype），不能当纯记录校验。
    const store = input.store;
    if (!store || typeof store.read !== 'function' || typeof store.readRefs !== 'function'
        || typeof store.readObservations !== 'function' || typeof store.readEvents !== 'function') {
        reject('agent-loop-continuation-input-invalid');
    }
    const record = store.read(input.taskId);
    if (!record) reject('agent-loop-continuation-record-missing');
    const snapshot = buildActiveContextSnapshot({
        record,
        refs: store.readRefs(input.taskId),
        observations: store.readObservations(input.taskId),
        events: store.readEvents(input.taskId),
    });
    const continuation = await resolveAgentLoopContinuation({
        snapshot,
        refs: store.readRefs(input.taskId),
        resolvers: input.resolvers,
        ...(input.grantedAclClasses === undefined
            ? {} : { grantedAclClasses: input.grantedAclClasses }),
        ...(input.expansionBudgetTokens === undefined
            ? {} : { expansionBudgetTokens: input.expansionBudgetTokens }),
    });
    return Object.freeze({ snapshot, continuation });
}

export interface AgentLoopContinuationNotificationV1 {
    readonly notificationVersion: typeof AGENT_LOOP_CONTINUATION_NOTIFICATION_VERSION;
    readonly type: 'agent-loop-continuation-invalidate';
    readonly taskId: string;
    readonly taskRevision: number;
    readonly refetch: 'active-context-snapshot';
}

/**
 * EventHub 方向的通知：**只有「失效，请重新取快照」**。
 *
 * 任何多余字段（payload / snapshot / text / envelope）一律拒绝 —— 事件流一旦能
 * 携带业务正文，它就会变成第二份历史真值，而它没有 revision CAS、没有归约、
 * 也没有 ACL。
 */
export function agentLoopContinuationNotification(
    input: unknown,
): AgentLoopContinuationNotificationV1 {
    if (!isRecord(input)) reject('agent-loop-continuation-input-invalid');
    const keys = Object.keys(input);
    if (keys.length !== 2 || !keys.includes('taskId') || !keys.includes('taskRevision')) {
        reject('agent-loop-continuation-input-invalid');
    }
    if (typeof input.taskId !== 'string' || !input.taskId.trim()) {
        reject('agent-loop-continuation-input-invalid');
    }
    if (!Number.isSafeInteger(input.taskRevision) || Number(input.taskRevision) < 1) {
        reject('agent-loop-continuation-input-invalid');
    }
    return Object.freeze({
        notificationVersion: AGENT_LOOP_CONTINUATION_NOTIFICATION_VERSION,
        type: 'agent-loop-continuation-invalidate',
        taskId: input.taskId,
        taskRevision: Number(input.taskRevision),
        refetch: 'active-context-snapshot',
    });
}
