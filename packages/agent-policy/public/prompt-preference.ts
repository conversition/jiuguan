/** @author Codex @date 2026-10-14 @version 1.0
 * Public frozen preference normalization; model guesses are never profile evidence.
 */
export {
    normalizeTypedPreferenceExtraction,
    PROMPT_PREFERENCE_EXTRACTOR_VERSION,
    rebuildPromptPreferenceProfiles,
    type TypedPreferenceExtraction,
    type PromptPreferenceProfile,
    type PromptPreferenceEvidence,
} from '../src/prompt-preference.ts';
