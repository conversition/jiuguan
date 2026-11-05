import type { AgentSkillAssetContextV1 } from './agent-skill-turn-context.ts';

export const SESSION_AQL_REPLAN_SKILL_SOURCE_VERSION = 'session-aql-replan-skill-source-v1' as const;

/** Only the native post-commit AQL callback owns this body-free source. */
export interface AqlReplanSkillSourceV1 {
    readonly sourceVersion: typeof SESSION_AQL_REPLAN_SKILL_SOURCE_VERSION;
    readonly taskKind: 'aql_replan';
    readonly policyVersion: 'p14-q9r-aql-replan-interactive-v1';
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: AgentSkillAssetContextV1['scope'];
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly round: number;
    readonly historyEpoch: number;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly markerDigest: string;
    readonly inputDigest: string;
    readonly authorityRevision: string;
}

export interface AqlReplanSkillSourceReader {
    readAqlReplanSkillSource(runId: string): AqlReplanSkillSourceV1 | null;
}
