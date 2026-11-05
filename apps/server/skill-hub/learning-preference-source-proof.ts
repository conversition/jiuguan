/** @author Codex @date 2026-10-14 @version 1.0
 * A live output proof is not a proposal, profile write, consumption receipt or positive feedback.
 */
import {
    normalizeLearningPreferenceSkillProof,
    learningPreferenceSkillSourceDigest,
    type LearningPreferenceSkillProofV1,
} from '../../../packages/memory/public/learning-preference-skill-source-outbox.ts';

const PROOFS = new WeakSet<object>();
const USED = new WeakSet<object>();

/** Only the trusted actual-response owner calls this; parsing persisted metadata cannot acquire its brand. */
export function sealLearningPreferenceSkillOutputProof(input: Omit<LearningPreferenceSkillProofV1, 'proofDigest'>) {
    const proof = normalizeLearningPreferenceSkillProof({
        ...input, proofDigest: learningPreferenceSkillSourceDigest(input),
    });
    PROOFS.add(proof);
    return proof;
}

export function takeLearningPreferenceSkillOutputProof(value: unknown): LearningPreferenceSkillProofV1 | null {
    if (!value || typeof value !== 'object' || !PROOFS.has(value) || USED.has(value)) return null;
    USED.add(value);
    return value as LearningPreferenceSkillProofV1;
}
