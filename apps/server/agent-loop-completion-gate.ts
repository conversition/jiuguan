/** @author Codex @date 2026-10-19 @version 1.0
 * AL-5：`request_complete` 与 Verify 完成门（`agent-loop-completion-gate-v1`）。
 *
 * 这个模块只回答一个问题：**这个任务现在能不能算完成？**
 * 它不执行工具、不写业务库、不改状态 —— 判定结果交给核心 Loop 去提交。
 *
 * 五条不可绕过的条件（缺一条都不能 COMPLETED）：
 * 1. **候选仍属于当前 revision**：`candidate.taskRevision === 当前 revision`，
 *    否则候选已经过期（候选冻结后又被改过），必须重新申请完成。
 * 2. **没有被核对掉的未知效果**：`started` 但没有回执的动作必须先收敛，
 *    带着未知副作用宣布完成等于把风险留给下一次。
 * 3. **required child 必须终态 + 已验证 + 已合并**：optional child 只允许按预先声明的 fallback 降级。
 * 4. **全部 required verifier 通过**：可选 verifier 失败只降级不阻塞；required verifier 缺实现
 *    一律算 `inconclusive`（「没验」不等于「验过」）。
 * 5. **修复—验证循环有上限**：`failed-repairable` 超过上限转 `terminal-failure`，
 *    不允许无限「再修一次」。
 *
 * 另外一条容易被忽略的：**passed 必须有证据**。合同里 `COMPLETED` 要求
 * `completion.disposition=passed` + `verificationResultRef` + 非空 `evidenceRefs`，
 * 所以聚合证据为空时这里直接判 `inconclusive`，而不是让合同在校验阶段抛错。
 */

export const AGENT_LOOP_COMPLETION_GATE_VERSION = 'agent-loop-completion-gate-v1' as const;

export const AGENT_LOOP_VERIFIER_KINDS = Object.freeze([
    'deterministic', 'artifact-integrity', 'domain-readback', 'child-join', 'closure-evidence',
] as const);
export type AgentLoopVerifierKind = typeof AGENT_LOOP_VERIFIER_KINDS[number];

export const AGENT_LOOP_COMPLETION_VERDICTS = Object.freeze([
    'complete', 'repair', 'terminal-failure', 'inconclusive',
] as const);
export type AgentLoopCompletionVerdict = typeof AGENT_LOOP_COMPLETION_VERDICTS[number];

export const AGENT_LOOP_COMPLETION_REASON_CODES = Object.freeze([
    'completion-input-invalid',
    'completion-candidate-stale',
    'completion-registry-missing',
    'completion-registry-invalid',
    'completion-unknown-effect',
    'completion-required-child-unsettled',
    'completion-optional-child-unmerged',
    'completion-todos-open',
    'completion-blockers-open',
    'completion-verifier-missing',
    'completion-verifier-inconclusive',
    'completion-verifier-result-invalid',
    'completion-verifier-repairable',
    'completion-verifier-terminal',
    'completion-repair-budget-exhausted',
    'completion-evidence-empty',
] as const);
export type AgentLoopCompletionReasonCode = typeof AGENT_LOOP_COMPLETION_REASON_CODES[number];

export const AGENT_LOOP_COMPLETION_ERROR_CODES = Object.freeze([
    'verifier-registry-input-invalid',
    'verifier-registry-duplicate',
    'verifier-registry-empty-required',
    'verifier-registry-set-conflict',
] as const);
export type AgentLoopCompletionErrorCode = typeof AGENT_LOOP_COMPLETION_ERROR_CODES[number];

export class AgentLoopCompletionError extends Error {
    constructor(readonly code: AgentLoopCompletionErrorCode) {
        if (!(AGENT_LOOP_COMPLETION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('agent-loop-completion-error-code-invalid');
        }
        super(code);
        this.name = 'AgentLoopCompletionError';
    }
}

function reject(code: AgentLoopCompletionErrorCode): never {
    throw new AgentLoopCompletionError(code);
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('verifier-registry-input-invalid');
    return value;
}

/** 不执行 getter，不接收稀疏数组或把字符串当作 evidence 数组。 */
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('verifier-registry-input-invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || (keys && !keys.includes(key))
            || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable) reject('verifier-registry-input-invalid');
    }
    if (keys && keys.some(key => !Object.hasOwn(descriptors, key))) reject('verifier-registry-input-invalid');
    return value as Record<string, unknown>;
}

function list<T>(value: unknown, normalize: (value: unknown) => T, max = 256): readonly T[] {
    if (!Array.isArray(value) || value.length > max
        || Reflect.ownKeys(value).length !== value.length + 1) reject('verifier-registry-input-invalid');
    const items: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) reject('verifier-registry-input-invalid');
        items.push(normalize(descriptor.value));
    }
    return Object.freeze(items);
}

function tokens(value: unknown, max = 256): readonly string[] {
    const values = list(value, token, max);
    if (new Set(values).size !== values.length) reject('verifier-registry-input-invalid');
    return values;
}

function integer(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) reject('verifier-registry-input-invalid');
    return value as number;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) reject('verifier-registry-input-invalid');
    return value;
}

function normalizeSet(value: unknown): AgentLoopVerifierSet {
    const input = object(value, ['verifierSetRef', 'verifierSetRevision', 'verifiers']);
    const seen = new Set<string>();
    const verifiers = list(input.verifiers, value => {
        const item = object(value, ['verifierId', 'version', 'kind', 'requirement']);
        const verifierId = token(item.verifierId);
        const version = token(item.version);
        if (typeof item.kind !== 'string' || !(AGENT_LOOP_VERIFIER_KINDS as readonly string[]).includes(item.kind)
            || (item.requirement !== 'required' && item.requirement !== 'optional')) reject('verifier-registry-input-invalid');
        if (seen.has(verifierId)) reject('verifier-registry-duplicate');
        seen.add(verifierId);
        return Object.freeze({ verifierId, version, kind: item.kind as AgentLoopVerifierKind, requirement: item.requirement });
    }, 32);
    if (!verifiers.some(item => item.requirement === 'required')) reject('verifier-registry-empty-required');
    return Object.freeze({ verifierSetRef: token(input.verifierSetRef), verifierSetRevision: token(input.verifierSetRevision), verifiers });
}

function normalizeOutcome(value: unknown): Omit<AgentLoopVerifierResult, 'verifierId'> {
    const input = object(value, ['disposition', 'reasonCodes', 'evidenceRefs']);
    if (!['passed', 'failed-repairable', 'failed-terminal', 'inconclusive'].includes(input.disposition as string)) {
        reject('verifier-registry-input-invalid');
    }
    const reasonCodes = tokens(input.reasonCodes, 32);
    if (input.disposition !== 'passed' && reasonCodes.length === 0) reject('verifier-registry-input-invalid');
    return Object.freeze({ disposition: input.disposition as AgentLoopVerifierResult['disposition'],
        reasonCodes, evidenceRefs: tokens(input.evidenceRefs, 64) });
}

export interface AgentLoopVerifierDeclaration {
    readonly verifierId: string;
    readonly version: string;
    readonly kind: AgentLoopVerifierKind;
    readonly requirement: 'required' | 'optional';
}

export interface AgentLoopVerifierSet {
    readonly verifierSetRef: string;
    readonly verifierSetRevision: string;
    readonly verifiers: readonly AgentLoopVerifierDeclaration[];
}

/** 完成候选：冻结 revision + 产物 + 动作水位。冻结之后任何变化都会让候选失效。 */
export interface AgentLoopCompletionCandidate {
    readonly candidateRef: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly taskRevision: number;
    readonly artifactRefs: readonly string[];
    /** 已经发生的最晚动作标识（`action-completed` 事件 id）；null = 还没执行过动作。 */
    readonly actionWatermark: string | null;
    readonly createdAt: string;
}

/** 必须由权威 Store 读出，不能从待验 candidate 回填相同值当作校验。 */
export interface AgentLoopCompletionBinding {
    readonly taskId: string;
    readonly attemptId: string;
    readonly artifactRefs: readonly string[];
    readonly actionWatermark: string | null;
    readonly verifierSetRef: string;
    readonly verifierSetRevision: string;
}

export interface AgentLoopVerifierResult {
    readonly verifierId: string;
    readonly disposition: 'passed' | 'failed-repairable' | 'failed-terminal' | 'inconclusive';
    readonly reasonCodes: readonly string[];
    readonly evidenceRefs: readonly string[];
}

export type AgentLoopVerifierRunner = (input: Readonly<{
    candidate: AgentLoopCompletionCandidate;
    declaration: AgentLoopVerifierDeclaration;
}>) => Promise<Omit<AgentLoopVerifierResult, 'verifierId'>>;

export interface AgentLoopCompletionVerdictResult {
    readonly gateVersion: typeof AGENT_LOOP_COMPLETION_GATE_VERSION;
    readonly verdict: AgentLoopCompletionVerdict;
    readonly reasonCodes: readonly AgentLoopCompletionReasonCode[];
    /** `complete` 时非空：合同要求 `completion.disposition=passed` 必须带 evidenceRefs。 */
    readonly evidenceRefs: readonly string[];
    readonly verificationResultRef: string | null;
    readonly verifierResults: readonly AgentLoopVerifierResult[];
}

/** `VerifierRegistry(taskKind + contractRevision → verifierSetRevision)`。 */
export class AgentLoopVerifierRegistry {
    readonly #byContract = new Map<string, Map<string, AgentLoopVerifierSet>>();

    /**
     * 登记一个 verifier set。`taskKind + contractRevision` 组合下，
     * 同一个 `verifierSetRevision` 只能登记一次，且不允许用不同内容覆盖（防止「悄悄改验证口径」）。
     */
    register(input: Readonly<{
        taskKind: string;
        contractRevision: string;
        verifierSetRef: string;
        verifierSetRevision: string;
        verifiers: readonly AgentLoopVerifierDeclaration[];
    }>): AgentLoopVerifierSet {
        object(input, ['taskKind', 'contractRevision', 'verifierSetRef', 'verifierSetRevision', 'verifiers']);
        const taskKind = token(input.taskKind);
        const contractRevision = token(input.contractRevision);
        const set = normalizeSet({ verifierSetRef: input.verifierSetRef,
            verifierSetRevision: input.verifierSetRevision, verifiers: input.verifiers });
        const verifierSetRevision = set.verifierSetRevision;
        const key = JSON.stringify([taskKind, contractRevision]);
        const byRevision = this.#byContract.get(key) ?? new Map<string, AgentLoopVerifierSet>();
        const existing = byRevision.get(verifierSetRevision);
        if (existing && JSON.stringify(existing) !== JSON.stringify(set)) {
            reject('verifier-registry-set-conflict');
        }
        byRevision.set(verifierSetRevision, set);
        this.#byContract.set(key, byRevision);
        return set;
    }

    /** 解析当前应该用哪一版 verifier set（登记顺序无关：按 revision 取，不做「最新」猜测）。 */
    resolve(input: Readonly<{
        taskKind: string;
        contractRevision: string;
        verifierSetRevision?: string;
    }>): AgentLoopVerifierSet | null {
        object(input);
        token(input.taskKind); token(input.contractRevision);
        if (input.verifierSetRevision !== undefined) token(input.verifierSetRevision);
        const byRevision = this.#byContract.get(JSON.stringify([input.taskKind, input.contractRevision]));
        if (!byRevision) return null;
        if (input.verifierSetRevision !== undefined) {
            return byRevision.get(input.verifierSetRevision) ?? null;
        }
        // 未指定版本时取**唯一**登记项；多版本必须显式指定，不猜「最新」。
        return byRevision.size === 1 ? [...byRevision.values()][0]! : null;
    }
}

/**
 * 判定完成。纯函数 + 注入的 verifier 实现；不做任何写。
 *
 * `currentRevision` 由调用方从权威投影读；`unknownEffectActionIds` 由 ActionGateway 的
 * `started` 且无回执的动作集合给出。
 */
export async function evaluateAgentLoopCompletion(input: Readonly<{
    candidate: AgentLoopCompletionCandidate;
    binding: AgentLoopCompletionBinding;
    currentRevision: number;
    envelope: Readonly<{
        todos: readonly Readonly<{ status: string }>[];
        blockers: readonly Readonly<{ status: string }>[];
        children: readonly Readonly<{
            taskId: string;
            requirement: 'required' | 'optional';
            joinState: string;
            /** optional child 允许降级时，必须**预先声明** fallback。 */
            fallbackDeclared?: boolean;
        }>[];
    }>;
    verifierSet: AgentLoopVerifierSet | null;
    runners: Readonly<Record<string, AgentLoopVerifierRunner>>;
    unknownEffectActionIds: readonly string[];
    repairAttempts: number;
    maxRepairAttempts: number;
    clock: () => string;
}>): Promise<AgentLoopCompletionVerdictResult> {
    const reasons = new Set<AgentLoopCompletionReasonCode>();
    const done = (verdict: AgentLoopCompletionVerdict, verifierResults: AgentLoopVerifierResult[] = []) =>
        Object.freeze({
            gateVersion: AGENT_LOOP_COMPLETION_GATE_VERSION,
            verdict,
            reasonCodes: Object.freeze([...reasons].sort()),
            evidenceRefs: Object.freeze([...new Set(verifierResults.flatMap((item) => [...item.evidenceRefs]))]),
            // 纯评估没有持久凭证。只有原 Store 成功提交后才能生成真实 ref。
            verificationResultRef: null,
            verifierResults: Object.freeze(verifierResults),
        });

    let candidate: AgentLoopCompletionCandidate;
    let binding: AgentLoopCompletionBinding;
    try {
        object(input);
        const raw = object(input.candidate);
        candidate = Object.freeze({ candidateRef: token(raw.candidateRef), taskId: token(raw.taskId),
            attemptId: token(raw.attemptId), taskRevision: integer(raw.taskRevision),
            artifactRefs: tokens(raw.artifactRefs), actionWatermark: raw.actionWatermark === null ? null : token(raw.actionWatermark),
            createdAt: timestamp(raw.createdAt) });
        const rawBinding = object(input.binding, ['taskId', 'attemptId', 'artifactRefs', 'actionWatermark', 'verifierSetRef', 'verifierSetRevision']);
        binding = Object.freeze({ taskId: token(rawBinding.taskId), attemptId: token(rawBinding.attemptId),
            artifactRefs: tokens(rawBinding.artifactRefs),
            actionWatermark: rawBinding.actionWatermark === null ? null : token(rawBinding.actionWatermark),
            verifierSetRef: token(rawBinding.verifierSetRef), verifierSetRevision: token(rawBinding.verifierSetRevision) });
        if (candidate.taskRevision < 1 || candidate.taskRevision !== integer(input.currentRevision)
            || candidate.taskId !== binding.taskId || candidate.attemptId !== binding.attemptId
            || candidate.actionWatermark !== binding.actionWatermark
            || JSON.stringify(candidate.artifactRefs) !== JSON.stringify(binding.artifactRefs)) {
            throw new Error('stale');
        }
    } catch {
        reasons.add('completion-candidate-stale');
        return done('inconclusive');
    }
    let unknownEffectActionIds: readonly string[];
    let envelope: typeof input.envelope;
    let runners: Map<string, AgentLoopVerifierRunner>;
    let repairAttempts: number;
    let maxRepairAttempts: number;
    try {
        repairAttempts = integer(input.repairAttempts);
        maxRepairAttempts = integer(input.maxRepairAttempts);
        if (typeof input.clock !== 'function' || Date.parse(candidate.createdAt) > Date.parse(timestamp(input.clock()))) {
            reject('verifier-registry-input-invalid');
        }
        unknownEffectActionIds = tokens(input.unknownEffectActionIds);
        const rawEnvelope = object(input.envelope);
        envelope = Object.freeze({
            todos: list(rawEnvelope.todos, value => {
                const status = token(object(value).status);
                if (!['pending', 'in-progress', 'blocked', 'completed', 'cancelled'].includes(status)) reject('verifier-registry-input-invalid');
                return Object.freeze({ status });
            }),
            blockers: list(rawEnvelope.blockers, value => {
                const status = token(object(value).status);
                if (!['open', 'resolved'].includes(status)) reject('verifier-registry-input-invalid');
                return Object.freeze({ status });
            }),
            children: list(rawEnvelope.children, value => {
                const child = object(value);
                const taskId = token(child.taskId);
                const joinState = token(child.joinState);
                if (!['accepted', 'merged', 'pending', 'rejected', 'degraded'].includes(joinState)
                    || (child.requirement !== 'required' && child.requirement !== 'optional')
                    || (child.fallbackDeclared !== undefined && typeof child.fallbackDeclared !== 'boolean')) reject('verifier-registry-input-invalid');
                return Object.freeze({ taskId, joinState, requirement: child.requirement,
                    ...(child.fallbackDeclared === undefined ? {} : { fallbackDeclared: child.fallbackDeclared }) });
            }),
        });
        runners = new Map(Object.entries(object(input.runners)).map(([id, runner]) => {
            token(id);
            if (typeof runner !== 'function') reject('verifier-registry-input-invalid');
            return [id, runner as AgentLoopVerifierRunner];
        }));
    } catch {
        reasons.add('completion-input-invalid');
        return done('inconclusive');
    }
    // ② 未知效果没核对掉就不许完成。
    if (unknownEffectActionIds.length > 0) {
        reasons.add('completion-unknown-effect');
        return done('inconclusive');
    }
    // ③ required child 必须终态 + 已验证 + 已合并；optional 只能用预先声明的 fallback 降级。
    const unsettled = envelope.children.filter((child) => (
        child.requirement === 'required'
        && !['accepted', 'merged'].includes(child.joinState)
    ));
    if (unsettled.length > 0) {
        reasons.add('completion-required-child-unsettled');
        return done('inconclusive');
    }
    const unmergedOptional = envelope.children.filter((child) => (
        child.requirement === 'optional'
        && !['accepted', 'merged'].includes(child.joinState)
        && child.fallbackDeclared !== true
    ));
    if (unmergedOptional.length > 0) {
        reasons.add('completion-optional-child-unmerged');
        return done('inconclusive');
    }
    if (envelope.todos.some((todo) => ['pending', 'in-progress', 'blocked'].includes(todo.status))) {
        reasons.add('completion-todos-open');
        return done('inconclusive');
    }
    if (envelope.blockers.some((blocker) => blocker.status === 'open')) {
        reasons.add('completion-blockers-open');
        return done('inconclusive');
    }

    // ④ 跑登记的 verifier set。
    if (!input.verifierSet) {
        reasons.add('completion-registry-missing');
        return done('inconclusive');
    }
    let verifierSet: AgentLoopVerifierSet;
    try {
        verifierSet = normalizeSet(input.verifierSet);
        if (verifierSet.verifierSetRef !== binding.verifierSetRef
            || verifierSet.verifierSetRevision !== binding.verifierSetRevision) reject('verifier-registry-input-invalid');
    } catch {
        reasons.add('completion-registry-invalid');
        return done('inconclusive');
    }
    const results: AgentLoopVerifierResult[] = [];
    for (const declaration of verifierSet.verifiers) {
        const runner = runners.get(declaration.verifierId);
        if (!runner) {
            // 「没实现」不等于「验过」：required 缺实现直接判 inconclusive。
            if (declaration.requirement === 'required') {
                reasons.add('completion-verifier-missing');
                return done('inconclusive', results);
            }
            continue;
        }
        let outcome: Omit<AgentLoopVerifierResult, 'verifierId'>;
        let rawOutcome: unknown;
        try {
            rawOutcome = await runner(Object.freeze({ candidate, declaration }));
        } catch {
            rawOutcome = { disposition: 'inconclusive', reasonCodes: ['verifier-threw'], evidenceRefs: [] };
        }
        try {
            outcome = normalizeOutcome(rawOutcome);
        } catch {
            if (declaration.requirement === 'required') reasons.add('completion-verifier-result-invalid');
            outcome = normalizeOutcome({ disposition: 'inconclusive', reasonCodes: ['verifier-result-invalid'], evidenceRefs: [] });
        }
        const emptyPassed = outcome.disposition === 'passed' && outcome.evidenceRefs.length === 0;
        if (emptyPassed) {
            outcome = normalizeOutcome({ disposition: 'inconclusive', reasonCodes: ['verifier-evidence-empty'], evidenceRefs: [] });
        }
        results.push(Object.freeze({ ...outcome, verifierId: declaration.verifierId }));
        const failed = outcome.disposition !== 'passed';
        if (declaration.requirement === 'optional') continue;
        if (emptyPassed) {
            reasons.add('completion-evidence-empty');
            return done('inconclusive', results);
        }
        if (outcome.disposition === 'failed-terminal') {
            reasons.add('completion-verifier-terminal');
            return done('terminal-failure', results);
        }
        if (outcome.disposition === 'failed-repairable') {
            reasons.add('completion-verifier-repairable');
            // ⑤ 修复—验证循环有上限：超了就转终态失败，不允许无限「再修一次」。
            if (repairAttempts >= maxRepairAttempts) {
                reasons.add('completion-repair-budget-exhausted');
                return done('terminal-failure', results);
            }
            return done('repair', results);
        }
        if (failed) {
            reasons.add('completion-verifier-inconclusive');
            return done('inconclusive', results);
        }
    }

    // ⑥ passed 必须有证据：合同要求 COMPLETED 带非空 evidenceRefs。
    const evidence = results.flatMap((item) => [...item.evidenceRefs]);
    if (evidence.length === 0) {
        reasons.add('completion-evidence-empty');
        return done('inconclusive', results);
    }
    return done('complete', results);
}
