/** Transfer one actual Branch Skill output into its original semantic-low event, never a positive profile. */
import {
    normalizeBranchPreferenceSkillSourcePayload,
    type BranchPreferenceSkillPreparation,
    type BranchPreferenceSkillProofV1,
    type BranchPreferenceSkillSourcePayload,
} from '../../../packages/memory/public/branch-preference-skill-source.ts';
import type { ChatSession, SessionArgs } from '../../../packages/session/public/session.ts';
import { captureBranchPreferenceSkillSource } from './branch-preference-context.ts';
import { takeBranchPreferenceSkillOutputProof } from './branch-preference-source-proof.ts';

type Admission = NonNullable<SessionArgs['agentAdmission']>;
type Prepare = Parameters<NonNullable<Admission['prepareBranchPreferenceSkillSource']>>[0];
type Commit = Parameters<NonNullable<Admission['commitBranchPreferenceSkillSource']>>[0];

/** Preparations are process-local, exact-host and one-shot. Historical JSON cannot reacquire authority. */
export function createBranchPreferenceSkillSourceCommitAuthority(input: {
    readonly rawSessionId: string;
    readonly session: ChatSession;
    readonly isCurrentSession: () => boolean;
}) {
    const pending = new WeakMap<object, BranchPreferenceSkillProofV1>();
    const session = input.session, rawSessionId = input.rawSessionId;
    const memory = session.getMemory().mem;
    const isCurrent = () => input.isCurrentSession() === true && session.getMemory().mem === memory;
    return Object.freeze({
        prepare(value: unknown, expected: Prepare): BranchPreferenceSkillPreparation | null {
            const proof = takeBranchPreferenceSkillOutputProof(value);
            if (!proof || !isCurrent() || expected.rawSessionId !== rawSessionId
                || expected.runId !== proof.source.runId || expected.sourceRevision !== proof.source.sourceRevision
                || expected.userInputDigest !== proof.source.userInputDigest
                || expected.outputDigest !== proof.outputDigest) return null;
            try {
                const source = captureBranchPreferenceSkillSource({ runId: expected.runId, sourceAuthority: session });
                if (source.sourceDigest !== proof.source.sourceDigest || !isCurrent()) return null;
                const preparation = Object.freeze({}) as BranchPreferenceSkillPreparation;
                pending.set(preparation, proof);
                return preparation;
            } catch { return null; }
        },
        commit(expected: Commit): BranchPreferenceSkillSourcePayload | null {
            const preparation = expected.preparation;
            const proof = preparation && typeof preparation === 'object' ? pending.get(preparation) : undefined;
            if (preparation && typeof preparation === 'object') pending.delete(preparation);
            if (!proof || !isCurrent() || memory.db.isTransaction !== true
                || expected.rawSessionId !== rawSessionId || expected.runId !== proof.source.runId) return null;
            try {
                const turn = session.readAgentSkillTurnContext(proof.source.runId);
                if (!turn || turn.sessionId !== proof.source.sessionId || turn.contentMode !== proof.source.contentMode
                    || turn.assetRevision !== proof.source.assetRevision
                    || turn.worldbookSourceRevision !== proof.source.worldbookSourceRevision
                    || JSON.stringify(turn.scope) !== JSON.stringify(proof.source.scope)
                    || session.getHistoryEpoch() !== proof.source.historyEpoch || !isCurrent()) return null;
                // The Session and native store independently recheck original rows inside this same transaction.
                return normalizeBranchPreferenceSkillSourcePayload({ version: 'branch-preference-skill-source-v1',
                    rawSessionId, proof, learningEvent: expected.learningEvent, assistant: expected.assistant,
                    committedAt: expected.occurredAt });
            } catch { return null; }
        },
    });
}
