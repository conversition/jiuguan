import type { HarnessTool, ToolContext, ToolOutcome } from '../../packages/harness/src/types.ts';
import {
  validateMaintenanceProposal,
  type MaintenanceProposal,
  type MaintenanceStrictProposalContext,
  type MaintenanceTaskKind,
} from './maintenance-types.ts';

export type MaintenanceCapability =
  | 'memory.read'
  | 'worldbook.read'
  | 'variables.read'
  | 'maintenance.propose';
export type MaintenanceToolEffect = 'read' | 'proposal';

interface ToolDefinition<T> {
  readonly name: string;
  readonly capability: MaintenanceCapability;
  readonly effect: MaintenanceToolEffect;
  readonly taskKinds: readonly MaintenanceTaskKind[];
  validate(value: unknown): { ok: true; value: T } | { ok: false; error: string };
  execute(value: T, context: ToolContext, taskKind: MaintenanceTaskKind): Promise<ToolOutcome>;
}

export interface MaintenanceToolRegistryOptions {
  readonly capabilities: ReadonlySet<MaintenanceCapability>;
  readonly maxResultChars: number;
  readonly timeoutMs: number;
  /**
   * 会话绑定的只读混合检索端口。生产环境由 ChatSession 注入，PG/pgvector
   * 可用时参与召回；未注入时保留确定性快照搜索，供测试与降级路径使用。
   */
  readonly readMemory?: (query: string, signal: AbortSignal) => Promise<unknown>;
  /** Arc/NPC strict binding captured by the same fixed snapshot as the job revision. */
  readonly proposalContext?: MaintenanceStrictProposalContext;
}

function objectArg(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundedQuery(value: unknown): { ok: true; value: { query: string } } | { ok: false; error: string } {
  const record = objectArg(value);
  return record && typeof record.query === 'string' && record.query.length > 0 && record.query.length <= 500
    && Object.keys(record).every((key) => key === 'query')
    ? { ok: true, value: { query: record.query } }
    : { ok: false, error: 'query-invalid' };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function searchRows(value: unknown, query: string, maxItems = 50): unknown[] {
  const needle = query.trim().toLocaleLowerCase();
  const record = objectArg(value);
  const rows = Array.isArray(value)
    ? value
    : record ? Object.entries(record).flatMap(([section, sectionValue]) => (
      Array.isArray(sectionValue)
        ? sectionValue.map((item) => ({ section, item }))
        : [{ section, item: sectionValue }]
    )) : [];
  return rows.filter((row) => {
    try { return JSON.stringify(row).toLocaleLowerCase().includes(needle); }
    catch { return false; }
  }).slice(0, maxItems);
}

const ALL_TASKS = [
  'memory_consolidation', 'branch_index', 'rolling_summary', 'npc_state',
] as const;

function definitions(
  readMemory?: MaintenanceToolRegistryOptions['readMemory'],
  proposalContext?: MaintenanceStrictProposalContext,
): ToolDefinition<unknown>[] {
  return [
    {
      name: 'query_memory',
      capability: 'memory.read',
      effect: 'read',
      taskKinds: ALL_TASKS,
      validate: boundedQuery,
      execute: async (args, context) => {
        const query = (args as { query: string }).query;
        const hits = readMemory
          ? await readMemory(query, context.signal)
          : searchRows(context.state.memory, query);
        return { ok: true, result: jsonResult({ query, hits }) };
      },
    },
    {
      name: 'get_worldbook',
      capability: 'worldbook.read',
      effect: 'read',
      taskKinds: ALL_TASKS,
      validate: boundedQuery,
      execute: async (args, context) => ({
        ok: true,
        result: jsonResult({
          query: (args as { query: string }).query,
          hits: searchRows(context.state.worldbook, (args as { query: string }).query),
        }),
      }),
    },
    {
      name: 'get_variables',
      capability: 'variables.read',
      effect: 'read',
      taskKinds: ALL_TASKS,
      validate(value) {
        const record = objectArg(value);
        if (!record || Object.keys(record).some((key) => key !== 'keys')) {
          return { ok: false, error: 'keys-invalid' };
        }
        if (record.keys !== undefined && (!Array.isArray(record.keys) || record.keys.length > 100
          || record.keys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 160))) {
          return { ok: false, error: 'keys-invalid' };
        }
        return { ok: true, value: { keys: record.keys as string[] | undefined } };
      },
      execute: async (args, context) => {
        const variables = objectArg(context.state.variables) ?? {};
        const keys = (args as { keys?: string[] }).keys;
        const selected = keys === undefined
          ? variables
          : Object.fromEntries(keys.filter((key) => Object.hasOwn(variables, key)).map((key) => [key, variables[key]]));
        return { ok: true, result: jsonResult(selected) };
      },
    },
    ...ALL_TASKS.map((taskKind): ToolDefinition<unknown> => ({
      name: `propose_${taskKind}`,
      capability: 'maintenance.propose',
      effect: 'proposal',
      taskKinds: [taskKind],
      validate(value) {
        try {
          const proposal = validateMaintenanceProposal(taskKind, value, proposalContext);
          return { ok: true, value: proposal };
        } catch {
          return { ok: false, error: 'proposal-schema-invalid' };
        }
      },
      execute: async (value, context) => {
        if (context.state.proposal !== undefined) return { ok: false, error: 'proposal-already-exists' };
        context.state.proposal = structuredClone(value as MaintenanceProposal);
        return { ok: true, result: 'proposal-accepted' };
      },
    })),
  ];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => reject(new Error('tool-timeout')), timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export class MaintenanceToolRegistry {
  readonly #definitions: ToolDefinition<unknown>[];

  constructor(private readonly options: MaintenanceToolRegistryOptions) {
    if (!Number.isInteger(options.maxResultChars) || options.maxResultChars < 1 || options.maxResultChars > 65_536) {
      throw new Error('maxResultChars invalid');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) {
      throw new Error('timeoutMs invalid');
    }
    this.#definitions = definitions(options.readMemory, options.proposalContext);
  }

  toolsFor(taskKind: MaintenanceTaskKind): ReadonlyMap<string, HarnessTool<never>> {
    const tools = new Map<string, HarnessTool<never>>();
    for (const definition of this.#definitions) {
      if (!definition.taskKinds.includes(taskKind) || !this.options.capabilities.has(definition.capability)) continue;
      const tool: HarnessTool<unknown> = {
        name: definition.name,
        description: `${definition.effect}:${definition.capability}`,
        validate: definition.validate,
        execute: async (value, context) => {
          const outcome = await withTimeout(
            definition.execute(value, context, taskKind),
            this.options.timeoutMs,
            context.signal,
          );
          if (outcome.ok && outcome.result.length > this.options.maxResultChars) {
            return { ok: false, error: 'tool-result-too-large' };
          }
          return outcome;
        },
      };
      tools.set(tool.name, tool as HarnessTool<never>);
    }
    return tools;
  }
}
