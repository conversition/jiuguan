/** Narrow source boundary for authoritative Session DB/snapshot integration.
 * Reexports the original implementations without loading derived vector/PG
 * adapters, configuration or Provider credentials as a database side effect.
 */
export { MemoryDb, type SessionClaimFenceSnapshot } from '../src/db.ts';
export { computeSessionDatabaseSnapshot, aggregateSessionSnapshot,
  type SessionDatabaseSnapshot, type SessionSnapshot } from '../src/session-snapshot.ts';
export {
  inspectSessionAuthoritySchema,
  inspectSessionPredecessorV16Storage,
  validateSessionAuthorityForOwnedAdapter,
  type SessionAuthorityCoordinate,
} from '../src/session-authority.ts';
export {
  SESSION_DIRECTOR_STORAGE_REQUIRED_COLUMNS,
  SESSION_STORAGE_PREDECESSOR_VERSION,
  SESSION_V16_STORAGE_REQUIRED_COLUMNS,
} from '../src/session-storage-contract.ts';
export { DIRECTOR_CONTINUITY_SQL } from '../src/schema.ts';
export { inspectRpChildAnalysisStorage } from '../src/rp-child-analysis.ts';
