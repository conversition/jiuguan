/** Fixed Branch attribution normalization. Semantic guesses remain excluded from positive profiles. */
export {
    normalizeSemanticBranchAttribution,
    rebuildBranchPreferenceProfiles,
    type SemanticBranchCandidate,
} from '../src/branch-preference.ts';
