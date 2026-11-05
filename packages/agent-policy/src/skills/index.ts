import {
  createAgentSkillAdapter,
  type AgentSkillAdapter,
  type AgentSkillConsumerContextV1,
} from './adapter.ts';
import { AGENT_SKILL_CONSUMER_PROFILES } from './profiles.ts';
import { AgentSkillAdapterRegistry } from './registry.ts';

export * from './profile.ts';
export * from './profiles.ts';
export * from './adapter.ts';
export * from './registry.ts';
export * from './contract-index.ts';
export * from './boundary-inventory.ts';

export const AGENT_SKILL_ADAPTERS: readonly AgentSkillAdapter<AgentSkillConsumerContextV1>[] =
  Object.freeze(AGENT_SKILL_CONSUMER_PROFILES.map(createAgentSkillAdapter));

export const AGENT_SKILL_ADAPTER_REGISTRY = new AgentSkillAdapterRegistry(AGENT_SKILL_ADAPTERS);
