/** @author Codex @date 2026-10-14 @version 1.0
 * Transfer a single live inference proof into its exact original learning event, not a profile mutation.
 */
import {
    normalizeLearningPreferenceSkillSourcePayload,
    type LearningPreferenceSkillPreparation,
    type LearningPreferenceSkillProofV1,
    type LearningPreferenceSkillSourcePayload,
} from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';
import type { SessionArgs, ChatSession } from '../../../packages/session/public/session.ts';
import { captureLearningPreferenceSkillSource } from './learning-preference-context.ts';
import { takeLearningPreferenceSkillOutputProof } from './learning-preference-source-proof.ts';

type Admission = NonNullable<SessionArgs['agentAdmission']>;
type Prepare = Parameters<NonNullable<Admission['preparePreferenceSkillSource']>>[0];
type Commit = Parameters<NonNullable<Admission['commitPreferenceSkillSource']>>[0];

/** Ownership stays in this host instance; copied preparations and reopened disk records are read-only history. */
export function createLearningPreferenceSkillSourceCommitAuthority(input: {
    readonly rawSessionId: string;
    readonly session: ChatSession;
    readonly isCurrentSession: () => boolean;
}) {
    const pending = new WeakMap<object, LearningPreferenceSkillProofV1>();
    const session = input.session;
    const rawSessionId = input.rawSessionId;
    const isCurrent = input.isCurrentSession;
    return Object.freeze({
        prepare(proof: unknown, expected: Prepare): LearningPreferenceSkillPreparation | null {
            const live = takeLearningPreferenceSkillOutputProof(proof);
            if (!live || !isCurrent() || expected.rawSessionId !== rawSessionId
                || expected.runId !== live.source.runId || expected.sourceRevision !== live.source.sourceRevision
                || expected.userPromptDigest !== live.source.userPromptDigest
                || expected.outputDigest !== live.outputDigest) {
                return null;
            }
            try {
                const current = captureLearningPreferenceSkillSource({
                    runId: expected.runId, sourceAuthority: session,
                });
                if (current.sourceDigest !== live.source.sourceDigest) return null;
                const preparation = Object.freeze({}) as LearningPreferenceSkillPreparation;
                pending.set(preparation, live);
                return preparation;
            } catch { return null; }
        },
        commit(expected: Commit): LearningPreferenceSkillSourcePayload | null {
            const preparation = expected.preparation;
            const proof = preparation && typeof preparation === 'object' ? pending.get(preparation) : undefined;
            if (preparation && typeof preparation === 'object') pending.delete(preparation);
            if (!proof || !isCurrent() || expected.rawSessionId !== rawSessionId
                || expected.runId !== proof.source.runId
                || session.getMemory().mem.db.isTransaction !== true) return null;
            try {
                const turn = session.readAgentSkillTurnContext(proof.source.runId);
                if (!turn || turn.contentMode !== proof.source.contentMode || turn.sessionId !== proof.source.sessionId
                    || turn.assetRevision !== proof.source.assetRevision
                    || turn.worldbookSourceRevision !== proof.source.worldbookSourceRevision
                    || JSON.stringify(turn.scope) !== JSON.stringify(proof.source.scope)) return null;
                const payload = normalizeLearningPreferenceSkillSourcePayload({
                    version: 'learning-preference-skill-source-v1', rawSessionId, proof,
                    learningEvent: expected.learningEvent, assistant: expected.assistant,
                    committedAt: expected.occurredAt,
                });
                // Session's same-transaction enqueue separately checks the authoritative event and assistant rows.
                return payload;
            } catch { return null; }
        },
    });
}
