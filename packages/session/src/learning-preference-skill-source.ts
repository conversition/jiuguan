/** @author Codex @date 2026-10-14 @version 1.0
 * Content-free authority for one real, in-flight initial preference inference request.
 */
import type { AgentSkillAssetContextV1 } from './agent-skill-turn-context.ts';

export const SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION =
    'session-learning-preference-skill-source-v1' as const;

export interface LearningPreferenceSkillSourceV1 {
    readonly sourceVersion: typeof SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION;
    readonly taskKind: 'preference_extract';
    readonly policyVersion: 'p14-q6-preference-v1';
    readonly stage: 'initial-prompt-inference';
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: AgentSkillAssetContextV1['scope'];
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly round: 1;
    readonly explicitPreferenceCount: 0;
    readonly regenerate: false;
    readonly userPromptDigest: string;
    /** Semantic request identity only; the server independently binds the complete fixed ChatRequest. */
    readonly inputDigest: string;
    readonly preferenceEpoch: number;
    readonly preferenceEvidenceRevision: string;
    readonly authorityRevision: string;
}

export interface LearningPreferenceSkillSourceReader {
    readLearningPreferenceSkillSource(runId: string): LearningPreferenceSkillSourceV1 | null;
}
