import type { AgentSkillAdapter } from './adapter.ts';

/**
 * Registry dispatch is deliberately predicate-based. Shared or future taskKinds do not require a
 * central switch: each adapter owns its own `supports` decision.
 */
export class AgentSkillAdapterRegistry<TContext> {
  readonly adapters: readonly AgentSkillAdapter<TContext>[];
  readonly #byId: ReadonlyMap<string, AgentSkillAdapter<TContext>>;

  constructor(adapters: readonly AgentSkillAdapter<TContext>[]) {
    if (!Array.isArray(adapters)) throw new TypeError('Agent Skill adapters must be an array');
    const copy = [...adapters];
    const byId = new Map<string, AgentSkillAdapter<TContext>>();
    for (const adapter of copy) {
      if (adapter === null || typeof adapter !== 'object'
        || typeof adapter.adapterId !== 'string' || typeof adapter.supports !== 'function'
        || typeof adapter.buildSelectionRequest !== 'function') {
        throw new TypeError('Agent Skill registry entry must be an adapter');
      }
      if (byId.has(adapter.adapterId)) throw new TypeError(`duplicate Agent Skill adapter: ${adapter.adapterId}`);
      byId.set(adapter.adapterId, adapter);
    }
    this.adapters = Object.freeze(copy);
    this.#byId = byId;
    Object.freeze(this);
  }

  byId(adapterId: string): AgentSkillAdapter<TContext> | undefined {
    return this.#byId.get(adapterId);
  }

  supporting(context: TContext): readonly AgentSkillAdapter<TContext>[] {
    return Object.freeze(this.adapters.filter((adapter) => adapter.supports(context)));
  }

  resolve(context: TContext): AgentSkillAdapter<TContext> {
    const supported = this.supporting(context);
    if (supported.length === 0) throw new Error('no Agent Skill adapter supports context');
    if (supported.length > 1) {
      throw new Error(`multiple Agent Skill adapters support context: ${supported.map((item) => item.adapterId).join(', ')}`);
    }
    return supported[0]!;
  }
}

export function createAgentSkillAdapterRegistry<TContext>(
  adapters: readonly AgentSkillAdapter<TContext>[],
): AgentSkillAdapterRegistry<TContext> {
  return new AgentSkillAdapterRegistry(adapters);
}
