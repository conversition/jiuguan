/** @author Codex @date 2026-10-19 @version 1.0
 * AL-3E：生命周期扩展内核（`agent-loop-extension-kernel-v1`）。
 *
 * 核心 Loop 只负责「阶段、状态迁移与统一提交」；扩展只能在六个钩子的 **before/after**
 * 观察并**提议**，不能自己动手。内核的唯一职责是把提议收敛成三类可审计产物：
 * `patch`（待核心 Loop 校验后提交）、`observation`（待 AL-2 归约）、`shortCircuit`（停链）。
 *
 * 六条写死的边界：
 * 1. **扩展拿不到 Store**：`RuntimeContext` 只有声明过的只读字段，投影后传入，
 *    没声明就根本看不到（不是「约定别看」）。
 * 2. **写集与读集都是声明式的**：patch 只能写自己 `writeSet` 里声明过的键，
 *    改别的键 → `extension-patch-undeclared-write`。
 * 3. **patch 绑定基准 revision**：`baseRevision` 与运行上下文不一致即失效，
 *    绝不把旧上下文算出来的补丁贴到新状态上。
 * 4. **补丁键是闭集**：`wait` / `completion` / `budget` / `state` / `phase` / `revision`
 *    **不允许**被扩展改 —— 解除等待、满足完成门、改预算都是核心路径的事。
 * 5. **required 失败 fail-closed，optional 失败降级留痕**：抛错、超时、权限不足都按这个规则。
 * 6. **observation 只收引用不收正文**：`payloadDigest` + `sourceRef` + `evidenceRefs`，
 *    多一个 `text`/`body`/`prompt` 字段就拒绝 —— 扩展没有机会把提示词或推理内容塞进审计。
 *
 * 不做的事（本阶段明确不建）：热加载、扩展市场、任意脚本插件。注册表在进程内，注册即冻结。
 */

export const AGENT_LOOP_EXTENSION_KERNEL_VERSION = 'agent-loop-extension-kernel-v1' as const;

/** 六个钩子。`before` / `after` 各跑一遍，顺序由依赖与 id 唯一确定。 */
export const AGENT_LOOP_HOOKS = Object.freeze([
    'task-create', 'prepare', 'model', 'action', 'state', 'verify',
] as const);
export type AgentLoopHookName = typeof AGENT_LOOP_HOOKS[number];

export const AGENT_LOOP_HOOK_PHASES = Object.freeze(['before', 'after'] as const);
export type AgentLoopHookPhase = typeof AGENT_LOOP_HOOK_PHASES[number];

/**
 * 允许被 patch 的投影键（闭集）。
 *
 * 刻意**不含** `state` / `phase` / `revision` / `wait` / `completion` / `budget`：
 * 这些是核心路径的不变量。扩展能改的就是「任务内容」这一类，
 * 而不是「任务现在处于什么状态、还要不要等人、能不能算完成」。
 */
export const AGENT_LOOP_EXTENSION_PATCH_KEYS = Object.freeze([
    'todos', 'blockers', 'confirmedFacts', 'artifacts', 'plan',
] as const);
export type AgentLoopExtensionPatchKey = typeof AGENT_LOOP_EXTENSION_PATCH_KEYS[number];

/** 可被扩展读取的上下文键（闭集）。没声明就投影不出来。 */
export const AGENT_LOOP_EXTENSION_READ_KEYS = Object.freeze([
    'taskId', 'attemptId', 'revision', 'phase', 'state', 'taskKind',
    'taskContractRef', 'budget', 'todos', 'blockers', 'confirmedFacts',
    'artifacts', 'goal', 'grantedAuthorities',
] as const);
export type AgentLoopExtensionReadKey = typeof AGENT_LOOP_EXTENSION_READ_KEYS[number];

export const AGENT_LOOP_EXTENSION_ERROR_CODES = Object.freeze([
    'extension-declaration-invalid',
    'extension-duplicate-id',
    'extension-unknown-dependency',
    'extension-cross-hook-dependency',
    'extension-dependency-cycle',
    'extension-write-conflict',
] as const);
export type AgentLoopExtensionErrorCode = typeof AGENT_LOOP_EXTENSION_ERROR_CODES[number];

export class AgentLoopExtensionError extends Error {
    constructor(readonly code: AgentLoopExtensionErrorCode) {
        if (!(AGENT_LOOP_EXTENSION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('agent-loop-extension-error-code-invalid');
        }
        super(code);
        this.name = 'AgentLoopExtensionError';
    }
}

function reject(code: AgentLoopExtensionErrorCode): never {
    throw new AgentLoopExtensionError(code);
}

export const AGENT_LOOP_EXTENSION_OUTCOME_CODES = Object.freeze([
    'extension-required-failed',
    'extension-required-timeout',
    'extension-authority-missing',
    'extension-patch-stale',
    'extension-patch-undeclared-write',
    'extension-decision-invalid',
    'extension-observation-invalid',
    'extension-optional-degraded',
    'extension-short-circuit',
] as const);
export type AgentLoopExtensionOutcomeCode = typeof AGENT_LOOP_EXTENSION_OUTCOME_CODES[number];

/** 扩展返回的结构化决定（闭集，exact keys）。 */
export type AgentLoopExtensionDecision =
    | Readonly<{ kind: 'allow' }>
    | Readonly<{
        kind: 'patch';
        /** 补丁基于哪个 revision 算出来的；与运行上下文不一致即失效。 */
        baseRevision: number;
        writes: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>;
    }>
    | Readonly<{ kind: 'short-circuit'; reasonCode: string }>
    | Readonly<{
        kind: 'append-observation';
        /** 只允许引用，不允许正文（见文件头第 6 条）。 */
        observation: Readonly<{
            observationId: string;
            sourceKind: string;
            sourceRef: string;
            payloadDigest: string;
            completeness: string;
            evidenceRefs: readonly string[];
        }>;
    }>;

export interface AgentLoopExtensionDeclaration {
    readonly id: string;
    readonly version: string;
    readonly hook: AgentLoopHookName;
    readonly phase: AgentLoopHookPhase;
    /** 同 hook + 同 phase 内的依赖；跨 hook 依赖本阶段不支持（会拒绝）。 */
    readonly dependsOn: readonly string[];
    readonly readSet: readonly AgentLoopExtensionReadKey[];
    readonly writeSet: readonly AgentLoopExtensionPatchKey[];
    /** 需要的权限 claim；上下文 `grantedAuthorities` 不含即视为权限不足。 */
    readonly requiresAuthorities: readonly string[];
    readonly requirement: 'required' | 'optional';
    /** 1..5000 ms。只对异步扩展有效（同步阻塞无法抢占，这是 JS 的硬限制）。 */
    readonly timeoutMs: number;
}

/** 扩展拿到的只读上下文（只含声明过的键）。 */
export type AgentLoopExtensionContext = Readonly<Record<string, unknown>>;

export interface AgentLoopExtension {
    readonly declaration: AgentLoopExtensionDeclaration;
    run(context: AgentLoopExtensionContext): Promise<AgentLoopExtensionDecision>;
}

/** 扩展能提供的观测**只有引用**：没有正文，也就没有机会泄露提示词或推理内容。 */
export interface AgentLoopExtensionObservationProposal {
    readonly observationId: string;
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly payloadDigest: string;
    readonly completeness: string;
    readonly evidenceRefs: readonly string[];
}

export interface AgentLoopExtensionHookOutcome {
    readonly kernelVersion: typeof AGENT_LOOP_EXTENSION_KERNEL_VERSION;
    readonly hook: AgentLoopHookName;
    readonly phase: AgentLoopHookPhase;
    /** `false` = required 扩展失败 ⇒ 核心 Loop **必须停止推进**。 */
    readonly ok: boolean;
    readonly order: readonly string[];
    readonly executed: readonly string[];
    /** 待核心 Loop 校验后提交的补丁（按执行顺序）。内核自己**不**写 Store。 */
    readonly patches: readonly Readonly<{
        extensionId: string;
        baseRevision: number;
        writes: Readonly<Partial<Record<AgentLoopExtensionPatchKey, unknown>>>;
    }>[];
    /** 待 AL-2 归约的观测（只有引用）。 */
    readonly observations: readonly Readonly<{
        extensionId: string;
        observation: AgentLoopExtensionDecision extends never ? never : Readonly<{
            observationId: string;
            sourceKind: string;
            sourceRef: string;
            payloadDigest: string;
            completeness: string;
            evidenceRefs: readonly string[];
        }>;
    }>[];
    readonly shortCircuit: Readonly<{ extensionId: string; reasonCode: string }> | null;
    readonly degraded: readonly Readonly<{ extensionId: string; code: AgentLoopExtensionOutcomeCode }>[];
    readonly failures: readonly Readonly<{ extensionId: string; code: AgentLoopExtensionOutcomeCode }>[];
    readonly reasonCodes: readonly AgentLoopExtensionOutcomeCode[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,159}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const REASON = /^[a-z][a-z0-9-]{0,79}$/u;

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('extension-declaration-invalid');
    return value;
}

function exactKeys(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        reject('extension-declaration-invalid');
    }
    const own = Reflect.ownKeys(input);
    if (own.length !== keys.length
        || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        reject('extension-declaration-invalid');
    }
    return input as Record<string, unknown>;
}

function closedList<T extends string>(
    input: unknown,
    allowed: readonly T[],
    max: number,
): readonly T[] {
    if (!Array.isArray(input) || input.length > max) reject('extension-declaration-invalid');
    const seen = new Set<string>();
    for (const item of input) {
        if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
            reject('extension-declaration-invalid');
        }
        if (seen.has(item)) reject('extension-declaration-invalid');
        seen.add(item);
    }
    return Object.freeze([...input] as T[]);
}

function normalizeDeclaration(input: unknown): AgentLoopExtensionDeclaration {
    const value = exactKeys(input, [
        'id', 'version', 'hook', 'phase', 'dependsOn', 'readSet', 'writeSet',
        'requiresAuthorities', 'requirement', 'timeoutMs',
    ]);
    if (!(AGENT_LOOP_HOOKS as readonly string[]).includes(String(value.hook))) {
        reject('extension-declaration-invalid');
    }
    if (!(AGENT_LOOP_HOOK_PHASES as readonly string[]).includes(String(value.phase))) {
        reject('extension-declaration-invalid');
    }
    if (value.requirement !== 'required' && value.requirement !== 'optional') {
        reject('extension-declaration-invalid');
    }
    if (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1
        || Number(value.timeoutMs) > 5_000) {
        reject('extension-declaration-invalid');
    }
    const authorities = Array.isArray(value.requiresAuthorities)
        && value.requiresAuthorities.length <= 16
        && value.requiresAuthorities.every((item) => typeof item === 'string' && TOKEN.test(item))
        ? Object.freeze([...(value.requiresAuthorities as string[])])
        : reject('extension-declaration-invalid');
    const dependsOn = Array.isArray(value.dependsOn)
        && value.dependsOn.length <= 16
        && value.dependsOn.every((item) => typeof item === 'string' && TOKEN.test(item))
        ? Object.freeze([...(value.dependsOn as string[])])
        : reject('extension-declaration-invalid');
    if (dependsOn.includes(String(value.id))) reject('extension-dependency-cycle');
    return Object.freeze({
        id: token(value.id),
        version: token(value.version),
        hook: value.hook as AgentLoopHookName,
        phase: value.phase as AgentLoopHookPhase,
        dependsOn,
        readSet: closedList(value.readSet, AGENT_LOOP_EXTENSION_READ_KEYS, 16),
        writeSet: closedList(value.writeSet, AGENT_LOOP_EXTENSION_PATCH_KEYS, 5),
        requiresAuthorities: authorities,
        requirement: value.requirement,
        timeoutMs: Number(value.timeoutMs),
    });
}

/**
 * 稳定拓扑序：同层按 id 字典序，与注册顺序无关（可复现、可 diff）。
 *
 * 依赖校验**必须在排序之前**：缺失的依赖永远等不到 ready，Kahn 会把它误报成环。
 * 而 `cross-hook` 只有在能看到**全量注册表**时才分得清 —— 否则同 hook 内找不到就只会说「未知」。
 */
function stableOrder(
    declarations: readonly AgentLoopExtensionDeclaration[],
    allById: ReadonlyMap<string, AgentLoopExtensionDeclaration>,
): string[] {
    for (const item of declarations) {
        for (const dep of item.dependsOn) {
            const target = allById.get(dep);
            if (!target) reject('extension-unknown-dependency');
            if (target.hook !== item.hook || target.phase !== item.phase) {
                reject('extension-cross-hook-dependency');
            }
        }
    }
    const pending = new Map(declarations.map((item) => [item.id, new Set(item.dependsOn)]));
    const order: string[] = [];
    while (pending.size > 0) {
        const ready = [...pending.entries()]
            .filter(([, deps]) => deps.size === 0)
            .map(([id]) => id)
            .sort();
        if (ready.length === 0) reject('extension-dependency-cycle');
        for (const id of ready) {
            order.push(id);
            pending.delete(id);
            for (const deps of pending.values()) deps.delete(id);
        }
    }
    return order;
}

function assertNoWriteConflict(
    group: readonly AgentLoopExtensionDeclaration[],
): void {
    const owner = new Map<string, string>();
    for (const item of group) {
        for (const key of item.writeSet) {
            const existing = owner.get(key);
            // 同 hook+phase 内两个扩展写同一个键 ⇒ 语义上无法决定谁赢，注册期就拒。
            if (existing !== undefined && existing !== item.id) reject('extension-write-conflict');
            owner.set(key, item.id);
        }
    }
}

function projectContext(
    declaration: AgentLoopExtensionDeclaration,
    full: Readonly<Record<string, unknown>>,
): AgentLoopExtensionContext {
    const projected: Record<string, unknown> = {};
    for (const key of declaration.readSet) {
        // 没声明的键根本不会出现在上下文里 —— 不是「约定别看」，是看不到。
        if (key in full) projected[key] = full[key];
    }
    return Object.freeze(projected);
}

function callWithTimeout(
    extension: AgentLoopExtension,
    context: AgentLoopExtensionContext,
): Promise<'timeout' | { decision: unknown }> {
    return new Promise((resolve, rejectPromise) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve('timeout');
        }, extension.declaration.timeoutMs);
        Promise.resolve()
            .then(() => extension.run(context))
            .then((decision) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ decision });
            })
            .catch((error: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                rejectPromise(error);
            });
    });
}

/**
 * 扩展注册表 + 钩子执行器。
 *
 * 注册即冻结：`register()` 每次都重新校验整个集合（重复 id、未知依赖、跨钩子依赖、
 * 依赖环、写集冲突），校验失败不留半套注册。
 */
export class AgentLoopExtensionKernel {
    readonly #extensions = new Map<string, AgentLoopExtension>();
    readonly #order = new Map<string, readonly string[]>();

    /** 注册一组扩展。失败时整组不生效（不做部分注册）。 */
    register(extensions: readonly AgentLoopExtension[]): void {
        const staged = new Map(this.#extensions);
        for (const extension of extensions) {
            const declaration = normalizeDeclaration(extension.declaration);
            if (staged.has(declaration.id)) reject('extension-duplicate-id');
            if (typeof extension.run !== 'function') reject('extension-declaration-invalid');
            staged.set(declaration.id, Object.freeze({
                declaration, run: extension.run.bind(extension),
            }));
        }
        const groups = new Map<string, AgentLoopExtensionDeclaration[]>();
        const allById = new Map<string, AgentLoopExtensionDeclaration>();
        for (const item of staged.values()) {
            const key = `${item.declaration.hook}:${item.declaration.phase}`;
            const group = groups.get(key) ?? [];
            group.push(item.declaration);
            groups.set(key, group);
            allById.set(item.declaration.id, item.declaration);
        }
        const order = new Map<string, readonly string[]>();
        for (const [key, group] of groups) {
            assertNoWriteConflict(group);
            order.set(key, Object.freeze(stableOrder(group, allById)));
        }
        this.#extensions.clear();
        for (const [id, item] of staged) this.#extensions.set(id, item);
        this.#order.clear();
        for (const [key, value] of order) this.#order.set(key, value);
    }

    /** 已注册扩展的稳定顺序（供控制台/测试核对）。 */
    orderOf(hook: AgentLoopHookName, phase: AgentLoopHookPhase): readonly string[] {
        return this.#order.get(`${hook}:${phase}`) ?? Object.freeze([]);
    }

    /**
     * 跑一个钩子。返回的 `patches` / `observations` 都只是**提议**：
     * 内核不写 Store、不调 Reducer、不调模型、不执行工具。
     */
    async runHook(input: Readonly<{
        hook: AgentLoopHookName;
        phase: AgentLoopHookPhase;
        context: Readonly<Record<string, unknown>>;
    }>): Promise<AgentLoopExtensionHookOutcome> {
        const ids = this.orderOf(input.hook, input.phase);
        const executed: string[] = [];
        const patches: AgentLoopExtensionHookOutcome['patches'][number][] = [];
        const observations: AgentLoopExtensionHookOutcome['observations'][number][] = [];
        const degraded: { extensionId: string; code: AgentLoopExtensionOutcomeCode }[] = [];
        const failures: { extensionId: string; code: AgentLoopExtensionOutcomeCode }[] = [];
        const reasonCodes = new Set<AgentLoopExtensionOutcomeCode>();
        let shortCircuit: { extensionId: string; reasonCode: string } | null = null;

        const revision = Number(input.context.revision);
        const granted = Array.isArray(input.context.grantedAuthorities)
            ? (input.context.grantedAuthorities as string[])
            : [];

        for (const id of ids) {
            const extension = this.#extensions.get(id)!;
            const declaration = extension.declaration;
            executed.push(id);

            const missing = declaration.requiresAuthorities.filter(
                (authority) => !granted.includes(authority),
            );
            if (missing.length > 0) {
                reasonCodes.add('extension-authority-missing');
                if (declaration.requirement === 'required') {
                    failures.push({ extensionId: id, code: 'extension-authority-missing' });
                    break;
                }
                degraded.push({ extensionId: id, code: 'extension-authority-missing' });
                continue;
            }

            let decision: unknown;
            try {
                const outcome = await callWithTimeout(
                    extension, projectContext(declaration, input.context),
                );
                if (outcome === 'timeout') throw new TimeoutError();
                decision = outcome.decision;
            } catch (error) {
                const timedOut = error instanceof TimeoutError;
                if (declaration.requirement === 'required') {
                    // required 抛错/超时 ⇒ 整条钩子 fail-closed，后面的扩展不再执行。
                    const code: AgentLoopExtensionOutcomeCode = timedOut
                        ? 'extension-required-timeout' : 'extension-required-failed';
                    reasonCodes.add(code);
                    failures.push({ extensionId: id, code });
                    break;
                }
                // optional 失败可降级，但必须留痕（降级本身进 reasonCodes）。
                reasonCodes.add('extension-optional-degraded');
                degraded.push({ extensionId: id, code: 'extension-optional-degraded' });
                continue;
            }

            const interpreted = this.#interpret(id, decision, declaration, revision);
            if (interpreted.ok === false) {
                reasonCodes.add(interpreted.code);
                if (declaration.requirement === 'required') {
                    failures.push({ extensionId: id, code: interpreted.code });
                    break;
                }
                degraded.push({ extensionId: id, code: 'extension-optional-degraded' });
                continue;
            }
            if (interpreted.patch) patches.push(interpreted.patch);
            if (interpreted.observation) {
                observations.push({ extensionId: id, observation: interpreted.observation });
            }
            if (interpreted.shortCircuit) {
                shortCircuit = { extensionId: id, reasonCode: interpreted.shortCircuit };
                reasonCodes.add('extension-short-circuit');
                break;
            }
        }

        return Object.freeze({
            kernelVersion: AGENT_LOOP_EXTENSION_KERNEL_VERSION,
            hook: input.hook,
            phase: input.phase,
            // required 失败 ⇒ 核心 Loop 必须停止推进（fail-closed）。
            ok: failures.length === 0,
            order: Object.freeze([...ids]),
            executed: Object.freeze([...executed]),
            patches: Object.freeze(patches),
            observations: Object.freeze(observations),
            shortCircuit,
            degraded: Object.freeze(degraded),
            failures: Object.freeze(failures),
            reasonCodes: Object.freeze([...reasonCodes].sort()),
        });
    }

    #interpret(
        extensionId: string,
        input: unknown,
        declaration: AgentLoopExtensionDeclaration,
        revision: number,
    ): { ok: false; code: AgentLoopExtensionOutcomeCode } | {
        ok: true;
        patch?: AgentLoopExtensionHookOutcome['patches'][number];
        observation?: AgentLoopExtensionHookOutcome['observations'][number]['observation'];
        shortCircuit?: string;
    } {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return { ok: false, code: 'extension-decision-invalid' };
        }
        const decision = input as Record<string, unknown>;
        if (typeof decision.kind !== 'string') {
            return { ok: false, code: 'extension-decision-invalid' };
        }
        if (decision.kind === 'allow') {
            if (Reflect.ownKeys(decision).length !== 1) {
                return { ok: false, code: 'extension-decision-invalid' };
            }
            return { ok: true };
        }
        if (decision.kind === 'short-circuit') {
            if (Reflect.ownKeys(decision).length !== 2
                || typeof decision.reasonCode !== 'string'
                || !REASON.test(decision.reasonCode)) {
                return { ok: false, code: 'extension-decision-invalid' };
            }
            return { ok: true, shortCircuit: decision.reasonCode };
        }
        if (decision.kind === 'patch') {
            if (Reflect.ownKeys(decision).length !== 3
                || !Number.isSafeInteger(decision.baseRevision)
                || !decision.writes || typeof decision.writes !== 'object'
                || Array.isArray(decision.writes)) {
                return { ok: false, code: 'extension-decision-invalid' };
            }
            if (Number(decision.baseRevision) !== revision) {
                // 旧上下文算出来的补丁不能贴到新状态上。
                return { ok: false, code: 'extension-patch-stale' };
            }
            const writes = decision.writes as Record<string, unknown>;
            const declared = new Set<string>(declaration.writeSet);
            if (Reflect.ownKeys(writes).some(
                (key) => typeof key !== 'string' || !declared.has(key),
            )) {
                return { ok: false, code: 'extension-patch-undeclared-write' };
            }
            if (Reflect.ownKeys(writes).length === 0) {
                return { ok: false, code: 'extension-decision-invalid' };
            }
            return {
                ok: true,
                patch: Object.freeze({
                    extensionId,
                    baseRevision: Number(decision.baseRevision),
                    writes: Object.freeze({ ...writes }) as never,
                }),
            };
        }
        if (decision.kind === 'append-observation') {
            const observation = decision.observation as Record<string, unknown> | undefined;
            if (Reflect.ownKeys(decision).length !== 2 || !observation
                || typeof observation !== 'object' || Array.isArray(observation)) {
                return { ok: false, code: 'extension-observation-invalid' };
            }
            // 只允许这七个键：多一个 `text` / `body` / `prompt` 就拒 —— 扩展没有机会塞正文。
            if (Reflect.ownKeys(observation).length !== 6
                || typeof observation.observationId !== 'string'
                || !TOKEN.test(observation.observationId)
                || typeof observation.sourceKind !== 'string'
                || !TOKEN.test(observation.sourceKind)
                || typeof observation.sourceRef !== 'string'
                || !TOKEN.test(observation.sourceRef)
                || typeof observation.payloadDigest !== 'string'
                || !HASH.test(observation.payloadDigest)
                || typeof observation.completeness !== 'string'
                || !['complete', 'partial', 'unknown'].includes(observation.completeness)
                || !Array.isArray(observation.evidenceRefs)
                || observation.evidenceRefs.length > 16
                || observation.evidenceRefs.some(
                    (ref) => typeof ref !== 'string' || !TOKEN.test(ref),
                )) {
                return { ok: false, code: 'extension-observation-invalid' };
            }
            return {
                ok: true,
                observation: Object.freeze({
                    observationId: observation.observationId,
                    sourceKind: observation.sourceKind,
                    sourceRef: observation.sourceRef,
                    payloadDigest: observation.payloadDigest,
                    completeness: observation.completeness,
                    evidenceRefs: Object.freeze([...(observation.evidenceRefs as string[])]),
                }),
            };
        }
        return { ok: false, code: 'extension-decision-invalid' };
    }
}

class TimeoutError extends Error {
    constructor() {
        super('agent-loop-extension-timeout');
        this.name = 'TimeoutError';
    }
}
