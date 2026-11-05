/** @author Codex @date 2026-10-14 @version 1.0 */
export {
    LearningOutboxStore, LearningEventConflictError, PreferenceClearOperationIntentConflictError,
    normalizeLearningEvent, learningEventId, sha256Digest, opaqueLearningToken,
    deriveLearningProfileIdentity, preferenceEpochOf, parsePreferenceClearTombstone,
} from '../src/learning-outbox.ts';
export type {
    LearningEventRecord, LearningEventInput, LearningEventKind, LearningFeatureValue,
    LearningContentMode, LearningProfileIdentityValue, PreferenceClearInput,
} from '../src/learning-outbox.ts';
