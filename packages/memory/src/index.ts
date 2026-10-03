export { MemoryDb } from './db.ts';
export {
  StateStore, StateVersionConflictError, StateInstanceStaleError, StateOperationIntentConflictError,
  StateEpochStaleError, StatePredecessorStaleError, diffPaths, flatPaths, setPath, deletePath,
} from './state-store.ts';
export type { StateScope, StateSnapshot, CommitInput, CommitResult, PredecessorRef } from './state-store.ts';
export { CharacterStore, SYMMETRIC_RELATION_TYPES, promoteHits, DEFAULT_PROMOTE_HITS } from './character.ts';
export type {
  CharacterProjection, CharacterFact, CharacterRelationship, CharacterCandidate, CharacterChangeCandidate,
  CharacterRelationshipCandidate, AdmitContext, AdmitResult, MentionResolution, FactBlock, FactKind, FactStatus,
  FactScope, SourceRef, EffectiveAt, HistoricalFact, StageMentionInput, StageMentionResult, PoolEntry,
} from './character.ts';
export { SCOPE_SESSION, SCOPE_MESSAGE, SCOPE_CHARACTER, SESSION_SCOPE_KEY, DEFAULT_BRANCH_KEY, CONTROL_HISTORY_EPOCH, CHARACTER_POOL_SQL, TURN_OBSERVATION_SQL } from './schema.ts';
export { RetrievalEngine } from './retrieval.ts';
export { cosine, encodeF32, decodeF32 } from './retrieval.ts';
export type { RecallQuery, RecallHit, RecallResult } from './retrieval.ts';
export { WriteLoop } from './writer.ts';
export {
  TurnOutcomeStore,
  type CommitTurnOutcomeInput,
  type TurnOutcomeAction,
  type TurnOutcomeMarker,
} from './turn-outcome.ts';
export { TurnObservationStore, TurnObservationConflictError } from './turn-observation.ts';
export type { TurnObservationRecord, ObservationHarnessLane } from './turn-observation.ts';
export type { MemoryDelta, StateChange, WriteResult } from './writer.ts';
export { SCHEMA_V3, DEFAULT_WEIGHTS, DEFAULT_DROP_THRESHOLD, AM_CODE_RE, nextAmCode } from './schema.ts';
export { MemoryService } from './api.ts';
export type { MemoryServiceOptions } from './api.ts';
export { HashEmbeddingProvider, TransformersEmbeddingProvider, createEmbeddingProvider } from './embedding.ts';
export type { EmbeddingProvider } from './embedding.ts';
export { Vectorizer } from './vectorize.ts';
export type { VectorizeOptions, VectorizeResult, VecSource } from './vectorize.ts';
