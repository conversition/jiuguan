/** Stable snapshot hash-domain labels and read-only calculations; no database write authority. */
export {
  SESSION_DATABASE_SNAPSHOT_VERSION,
  SESSION_SNAPSHOT_VERSION,
  computeSessionDatabaseSnapshot,
  aggregateSessionSnapshot,
} from '../src/session-snapshot.ts';
