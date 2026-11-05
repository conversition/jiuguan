/** @author Codex @date 2026-10-16 @version 1.0
 * Explicit preference source and designated final carrier proof, without prompt or user prose in metadata.
 */
export {
    EXPLICIT_PREFERENCE_ADOPTION_VERSION,
    MAX_EXPLICIT_PREFERENCE_ADOPTION_SOURCES,
    captureExplicitPreferenceAdoptionSource,
    explicitPreferenceAdoptionSourceMatches,
    explicitPreferenceAdoptionDigest,
    captureExplicitPreferenceAdoptionCarrier,
    bindExplicitPreferenceAdoptionCarrier,
    explicitPreferenceAdoptionCarrierMatches,
    type ExplicitPreferenceAdoptionSourceInput,
    type ExplicitPreferenceAdoptionSource,
    type ExplicitPreferenceAdoptionCarrier,
    type BoundExplicitPreferenceAdoptionCarrier,
} from '../src/explicit-preference-adoption.ts';
