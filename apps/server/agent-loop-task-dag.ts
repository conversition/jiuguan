/** @author Codex @date 2026-10-19 @version 1.0
 * AL-6：parent/child DAG 与共享控制预算（`agent-loop-task-dag-v1`）。
 *
 * 这套东西要防的是三类**只有父子一起看才看得出来**的问题：
 * 1. **child 私自扩预算**：子任务自己发一个更大的额度，而不是从父的余量里切；
 * 2. **父子双计费**：同一份用量在 parent 与 child 各记一次，账目虚高；
 * 3. **取消/期限不传播**：父被取消后子还在跑，或者子的期限比父还长。
 *
 * 设计取舍：
 * - **额度只能从父的余量里切**：`allocate()` 在父上**预留**（reserved），子才拿到 grant；
 *   两个子不能同时认领同一份余量（并发安全靠单进程顺序 + 预留记账，测试里专门造并发场景）。
 * - **用量只结算一次**：子的 `settle()` 把用量**上报**给父（父的 spent 增加）；子自身也记 spent，
 *   但父的账只增加一份。重复 settle 同一 child 直接拒（不是幂等覆盖，是明确报错——
 *   因为「同一子任务结算两次」本身说明调用方错了）。
 * - **超支要看见**：子的实际用量超过自己的 grant 时，不裁剪、记 `child-budget-overrun`，
 *   并照实上报父（让超支体现在根预算上）。
 * - **取消向子树传播**：`cancel()` 一次把整棵子树标 cancelled；之后任何 allocate/settle 都被拒。
 * - **期限只能收窄**：子的 deadline 必须 ≤ 父的 deadline（不能借子任务延长总时长）。
 */

export const AGENT_LOOP_TASK_DAG_VERSION = 'agent-loop-task-dag-v1' as const;

export const AGENT_LOOP_DAG_BUDGET_KEYS = Object.freeze([
    'modelCalls', 'toolCalls', 'writes', 'inputTokens', 'outputTokens',
    'costMicrousd', 'wallMs', 'highRiskActions', 'childTasks',
] as const);
export type AgentLoopDagBudgetKey = typeof AGENT_LOOP_DAG_BUDGET_KEYS[number];
export type AgentLoopDagBudget = Readonly<Record<AgentLoopDagBudgetKey, number>>;

export const AGENT_LOOP_DAG_ERROR_CODES = Object.freeze([
    'dag-input-invalid',
    'dag-task-exists',
    'dag-task-missing',
    'dag-depth-exceeded',
    'dag-concurrency-exceeded',
    'dag-budget-exceeds-parent',
    'dag-deadline-exceeds-parent',
    'dag-task-cancelled',
    'dag-child-already-settled',
    'dag-requirement-invalid',
] as const);
export type AgentLoopDagErrorCode = typeof AGENT_LOOP_DAG_ERROR_CODES[number];

export class AgentLoopDagError extends Error {
    constructor(readonly code: AgentLoopDagErrorCode) {
        if (!(AGENT_LOOP_DAG_ERROR_CODES.includes(code))) {
            throw new Error('agent-loop-dag-error-code-invalid');
        }
        super(code);
        this.name = 'AgentLoopDagError';
    }
}

function reject(code: AgentLoopDagErrorCode): never {
    throw new AgentLoopDagError(code);
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('dag-input-invalid');
    return value;
}

function budget(input: unknown): AgentLoopDagBudget {
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('dag-input-invalid');
    const record = input as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (keys.length !== AGENT_LOOP_DAG_BUDGET_KEYS.length
        || keys.some((key) => typeof key !== 'string'
            || !(AGENT_LOOP_DAG_BUDGET_KEYS as readonly string[]).includes(key))) {
        reject('dag-input-invalid');
    }
    const out: Record<string, number> = {};
    for (const key of AGENT_LOOP_DAG_BUDGET_KEYS) {
        const value = record[key];
        if (!Number.isSafeInteger(value) || Number(value) < 0) reject('dag-input-invalid');
        out[key] = Number(value);
    }
    return Object.freeze(out as unknown as AgentLoopDagBudget);
}

const zero = (): Record<string, number> => Object.fromEntries(
    AGENT_LOOP_DAG_BUDGET_KEYS.map((key) => [key, 0]),
);

function add(a: AgentLoopDagBudget, b: AgentLoopDagBudget): AgentLoopDagBudget {
    const out = zero();
    for (const key of AGENT_LOOP_DAG_BUDGET_KEYS) out[key] = a[key] + b[key];
    return Object.freeze(out as unknown as AgentLoopDagBudget);
}

function sub(a: AgentLoopDagBudget, b: AgentLoopDagBudget): AgentLoopDagBudget {
    const out = zero();
    for (const key of AGENT_LOOP_DAG_BUDGET_KEYS) out[key] = a[key] - b[key];
    return Object.freeze(out as unknown as AgentLoopDagBudget);
}

function exceeds(a: AgentLoopDagBudget, limit: AgentLoopDagBudget): AgentLoopDagBudgetKey[] {
    return AGENT_LOOP_DAG_BUDGET_KEYS.filter((key) => a[key] > limit[key]);
}

function anyNonZero(a: AgentLoopDagBudget): boolean {
    return AGENT_LOOP_DAG_BUDGET_KEYS.some((key) => a[key] > 0);
}

export interface AgentLoopDagNodeView {
    readonly taskId: string;
    readonly parentTaskId: string | null;
    readonly depth: number;
    readonly requirement: 'required' | 'optional';
    readonly state: 'active' | 'cancelled' | 'settled';
    readonly granted: AgentLoopDagBudget;
    readonly reserved: AgentLoopDagBudget;
    readonly spent: AgentLoopDagBudget;
    readonly childIds: readonly string[];
    readonly deadline: string;
}

/**
 * 预算权威账本。**根预算只有一份**：所有子额度都是从根余量里切出来的预留，
 * 不存在「子任务自己发额度」的路径。
 */
export class AgentLoopTaskDag {
    readonly #nodes = new Map<string, {
        taskId: string;
        parentTaskId: string | null;
        depth: number;
        requirement: 'required' | 'optional';
        state: 'active' | 'cancelled' | 'settled';
        granted: AgentLoopDagBudget;
        reserved: AgentLoopDagBudget;
        spent: AgentLoopDagBudget;
        childIds: string[];
        deadline: string;
        settled: boolean;
    }>();

    /** 建根任务：额度由宿主给定（这是唯一一次「凭空产生额度」）。 */
    createRoot(input: Readonly<{
        taskId: string;
        granted: AgentLoopDagBudget;
        deadline: string;
    }>): AgentLoopDagNodeView {
        const taskId = token(input.taskId);
        if (this.#nodes.has(taskId)) reject('dag-task-exists');
        if (!Number.isFinite(Date.parse(input.deadline))) reject('dag-input-invalid');
        this.#nodes.set(taskId, {
            taskId,
            parentTaskId: null,
            depth: 0,
            requirement: 'required',
            state: 'active',
            granted: budget(input.granted),
            reserved: Object.freeze(zero()) as unknown as AgentLoopDagBudget,
            spent: Object.freeze(zero()) as unknown as AgentLoopDagBudget,
            childIds: [],
            deadline: new Date(input.deadline).toISOString(),
            settled: false,
        });
        return this.inspect(taskId);
    }

    /**
     * 建子任务。额度必须从父的**剩余**里切，并在父上预留 —— 两个子不能同时认领同一份余量。
     */
    createChild(input: Readonly<{
        parentTaskId: string;
        childTaskId: string;
        requirement: 'required' | 'optional';
        granted: AgentLoopDagBudget;
        deadline: string;
        maxDepth: number;
        maxConcurrentChildren: number;
    }>): AgentLoopDagNodeView {
        const parentId = token(input.parentTaskId);
        const childId = token(input.childTaskId);
        const parent = this.#nodes.get(parentId);
        if (!parent) reject('dag-task-missing');
        if (parent.state !== 'active') reject('dag-task-cancelled');
        if (this.#nodes.has(childId)) reject('dag-task-exists');
        if (input.requirement !== 'required' && input.requirement !== 'optional') {
            reject('dag-requirement-invalid');
        }
        const granted = budget(input.granted);
        if (!anyNonZero(granted)) reject('dag-input-invalid');
        if (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 1
            || input.maxDepth > 8) reject('dag-input-invalid');
        if (!Number.isSafeInteger(input.maxConcurrentChildren)
            || input.maxConcurrentChildren < 1 || input.maxConcurrentChildren > 32) {
            reject('dag-input-invalid');
        }
        if (parent.depth + 1 > input.maxDepth) reject('dag-depth-exceeded');

        const liveChildren = parent.childIds
            .map((id) => this.#nodes.get(id)!)
            .filter((node) => node.state === 'active');
        if (liveChildren.length >= input.maxConcurrentChildren) {
            reject('dag-concurrency-exceeded');
        }

        // 期限只能收窄。
        const deadline = new Date(input.deadline).toISOString();
        if (!Number.isFinite(Date.parse(input.deadline))) reject('dag-input-invalid');
        if (Date.parse(deadline) > Date.parse(parent.deadline)) {
            reject('dag-deadline-exceeds-parent');
        }

        // 额度只能从父的剩余（granted - spent - reserved）里切。
        const remaining = sub(sub(parent.granted, parent.spent), parent.reserved);
        if (exceeds(granted, remaining).length > 0) reject('dag-budget-exceeds-parent');

        parent.reserved = add(parent.reserved, granted);
        parent.childIds.push(childId);
        this.#nodes.set(childId, {
            taskId: childId,
            parentTaskId: parentId,
            depth: parent.depth + 1,
            requirement: input.requirement,
            state: 'active',
            granted,
            reserved: Object.freeze(zero()) as unknown as AgentLoopDagBudget,
            spent: Object.freeze(zero()) as unknown as AgentLoopDagBudget,
            childIds: [],
            deadline,
            settled: false,
        });
        return this.inspect(childId);
    }

    /**
     * 结算子任务：用量**上报一次**给父（父 spent 增加、预留扣减）。
     * 同一子任务重复结算直接拒 —— 那是调用方出错，不是可以静默幂等的场景。
     */
    settle(input: Readonly<{
        taskId: string;
        usage: AgentLoopDagBudget;
    }>): Readonly<{
        overrun: boolean;
        overrunKeys: readonly AgentLoopDagBudgetKey[];
        parent: AgentLoopDagNodeView | null;
    }> {
        const taskId = token(input.taskId);
        const node = this.#nodes.get(taskId);
        if (!node) reject('dag-task-missing');
        if (node.state === 'cancelled') reject('dag-task-cancelled');
        if (node.settled) reject('dag-child-already-settled');
        const usage = budget(input.usage);

        node.spent = usage;
        node.settled = true;
        node.state = 'settled';

        // 超支不裁剪：照实记账，让根预算体现出来。
        const overrunKeys = exceeds(usage, node.granted);
        const parent = node.parentTaskId === null ? null : this.#nodes.get(node.parentTaskId)!;
        if (parent) {
            // 父：预留扣掉（这部分额度已经用掉），实际用量进 spent —— 只增加一份，不双计。
            parent.reserved = Object.freeze(
                Object.fromEntries(AGENT_LOOP_DAG_BUDGET_KEYS.map((key) => [
                    key, Math.max(0, parent.reserved[key] - node.granted[key]),
                ])) as unknown as AgentLoopDagBudget,
            );
            parent.spent = add(parent.spent, usage);
        }
        return Object.freeze({
            overrun: overrunKeys.length > 0,
            overrunKeys: Object.freeze(overrunKeys),
            parent: parent ? this.inspect(parent.taskId) : null,
        });
    }

    /** 取消整棵子树（父被取消后子不能继续跑）。 */
    cancel(taskIdInput: string): readonly string[] {
        const taskId = token(taskIdInput);
        const node = this.#nodes.get(taskId);
        if (!node) reject('dag-task-missing');
        const cancelled: string[] = [];
        const walk = (id: string): void => {
            const current = this.#nodes.get(id)!;
            if (current.state !== 'cancelled') {
                current.state = 'cancelled';
                cancelled.push(id);
            }
            for (const childId of current.childIds) walk(childId);
        };
        walk(taskId);
        return Object.freeze(cancelled);
    }

    /** 树的读视图（只读快照，调用方改不动内部状态）。 */
    inspect(taskIdInput: string): AgentLoopDagNodeView {
        const taskId = token(taskIdInput);
        const node = this.#nodes.get(taskId);
        if (!node) reject('dag-task-missing');
        return Object.freeze({
            taskId: node.taskId,
            parentTaskId: node.parentTaskId,
            depth: node.depth,
            requirement: node.requirement,
            state: node.state,
            granted: node.granted,
            reserved: Object.freeze({ ...node.reserved }) as unknown as AgentLoopDagBudget,
            spent: Object.freeze({ ...node.spent }) as unknown as AgentLoopDagBudget,
            childIds: Object.freeze([...node.childIds]),
            deadline: node.deadline,
        });
    }

    /** 某节点的剩余额度（根视角的「还能再切多少」）。 */
    remaining(taskIdInput: string): AgentLoopDagBudget {
        const node = this.inspect(taskIdInput);
        return sub(sub(node.granted, node.spent), node.reserved);
    }
}
