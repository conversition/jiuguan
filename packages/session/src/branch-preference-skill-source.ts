/** @author Codex @date 2026-10-27 @version 1.0
 * Body-free authority for one real, in-flight edited branch attribution request.
 */
import type { AgentSkillAssetContextV1 } from './agent-skill-turn-context.ts';

export const SESSION_BRANCH_PREFERENCE_SKILL_SOURCE_VERSION =
    'session-branch-preference-skill-source-v1' as const;

export interface BranchPreferenceSkillSourceV1 {
    readonly sourceVersion: typeof SESSION_BRANCH_PREFERENCE_SKILL_SOURCE_VERSION;
    readonly taskKind: 'preference_extract';
    readonly policyVersion: 'p14-q6-branch-semantic-v1';
    readonly stage: 'edited-branch-attribution';
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: AgentSkillAssetContextV1['scope'];
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly round: number;
    readonly exposureRound: number;
    readonly regenerate: false;
    readonly userInputDigest: string;
    readonly branchSetDigest: string;
    readonly storyIndexDigest: string;
    readonly exposureDigest: string;
    readonly candidatesDigest: string;
    readonly preferenceEpoch: number;
    readonly preferenceEvidenceRevision: string;
    readonly historyEpoch: number;
    readonly inputDigest: string;
    readonly authorityRevision: string;
}

export interface BranchPreferenceSkillSourceReader {
    readBranchPreferenceSkillSource(runId: string): BranchPreferenceSkillSourceV1 | null;
}
