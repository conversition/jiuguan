export const SESSION_AGENT_SKILL_ASSET_CONTEXT_VERSION = 'session-agent-skill-assets-v1' as const;
export const SESSION_AGENT_SKILL_TURN_CONTEXT_VERSION = 'session-agent-skill-turn-context-v1' as const;

/** Asset metadata alone is not active-turn or background-job authority. */
export interface AgentSkillAssetContextV1 {
  readonly assetContextVersion: typeof SESSION_AGENT_SKILL_ASSET_CONTEXT_VERSION;
  readonly sessionId: string;
  readonly scope: Readonly<{ sessionId: string; cardId?: string; worldId?: string }>;
  readonly assetRevision: string;
  readonly worldbookSourceRevision: string;
}

/** Server-local metadata for the exact active turn; contains no dialogue or asset bodies. */
export interface AgentSkillTurnContextV1 {
  readonly contextVersion: typeof SESSION_AGENT_SKILL_TURN_CONTEXT_VERSION;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly scope: Readonly<{ sessionId: string; cardId?: string; worldId?: string }>;
  readonly assetRevision: string;
  readonly worldbookSourceRevision: string;
}

/** An idle, aborted, committed or different run must resolve to null. */
export interface AgentSkillTurnContextReader {
  readAgentSkillTurnContext(runId: string): AgentSkillTurnContextV1 | null;
}
