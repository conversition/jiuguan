/** A live branch attribution proof is not a positive sample or profile adoption receipt. */
import {
    normalizeBranchPreferenceSkillProof, branchPreferenceSkillSourceDigest,
    type BranchPreferenceSkillProofV1,
} from '../../../packages/memory/public/branch-preference-skill-source.ts';

const PROOFS = new WeakSet<object>();
const USED = new WeakSet<object>();
export function sealBranchPreferenceSkillOutputProof(input: Omit<BranchPreferenceSkillProofV1, 'proofDigest'>) {
    const proof = normalizeBranchPreferenceSkillProof({
        ...input, proofDigest: branchPreferenceSkillSourceDigest(input),
    });
    PROOFS.add(proof);
    return proof;
}
/** A stored or structural copy cannot regain actual-response authority. */
export function takeBranchPreferenceSkillOutputProof(value: unknown): BranchPreferenceSkillProofV1 | null {
    if (!value || typeof value !== 'object' || !PROOFS.has(value) || USED.has(value)) return null;
    USED.add(value);
    return value as BranchPreferenceSkillProofV1;
}
