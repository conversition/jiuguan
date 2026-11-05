/**
 * Narrow source-level database boundary for workspace integration tests.
 *
 * Runtime packages consume @jiuguan/memory after build; source-mode tests must
 * not depend on ignored dist artifacts or reach directly into private src.
 */
export { MemoryDb } from '../src/db.ts';
export {
  CharacterStore,
  CHARACTER_READBACK_VERSION,
  canonicalCharacterReadback,
  characterReadbackBatchDigest,
  characterReadbackDigest,
  characterReadbackReceipt,
  type CharacterReadback,
  type CharacterReadbackFact,
  type CharacterReadbackHistory,
  type CharacterReadbackReceipt,
  type CharacterReadbackRelationship,
} from '../src/character.ts';
export { StateStore } from '../src/state-store.ts';
export { getPgVectorStore } from '../src/pg-vector.ts';
