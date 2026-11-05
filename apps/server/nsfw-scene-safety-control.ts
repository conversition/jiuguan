import { DatabaseSync } from 'node:sqlite';

export const NSFW_SCENE_SAFETY_TABLE = 'nsfw_scene_safety_control';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_REVISION_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_WORLDBOOKS = 64;
const MAX_WORLDBOOK_NAME = 512;

export interface NsfwWorldbookSourceManifest {
  readonly books: readonly string[];
  readonly sourceRevision: string;
}

/** Structural mirror of SessionArgs' narrow gate; kept local to preserve package boundaries. */
export interface NsfwSceneSafetySnapshot {
  readonly adultAttestation: 'verified';
  readonly participantAgeStatus: 'adult-confirmed';
  readonly consentState: 'confirmed';
  readonly sourceRevision: string;
  readonly allowedWorldbooks: readonly string[];
  /** Present on server-issued snapshots; optional only for existing static Session callers. */
  readonly revision?: number;
}

export interface NsfwSceneSafetyUpdateRequest {
  readonly adultAttestation: 'verified' | 'revoked';
  readonly participantsAdult: boolean;
  readonly consent: 'confirmed' | 'revoked';
  readonly allowedWorldbooks: readonly string[];
  readonly expectedRevision?: number;
}

export interface PublicNsfwSceneSafety {
  readonly enabled: boolean;
  readonly adultAttestation: 'verified' | 'revoked';
  readonly participantsAdult: boolean;
  readonly consent: 'confirmed' | 'revoked';
  readonly allowedWorldbooks: readonly string[];
  readonly sourceRevision: string;
  readonly updatedAt: string | null;
  readonly revision: number;
  readonly reasonCode:
    | 'active'
    | 'not-configured'
    | 'revoked'
    | 'source-revision-mismatch'
    | 'worldbook-binding-mismatch'
    | 'session-binding-mismatch';
}

interface StoredSafetyRow {
  readonly session_id: string;
  readonly adult_attestation: string;
  readonly participants_adult: number;
  readonly consent_state: string;
  readonly allowed_worldbooks_json: string;
  readonly source_revision: string;
  readonly updated_at: string;
  readonly revision: number;
}

export class NsfwSceneSafetyControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'NsfwSceneSafetyControlError';
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) throw new NsfwSceneSafetyControlError('nsfw-safety-session-invalid');
}

function normalizeBookName(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > MAX_WORLDBOOK_NAME || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-worldbook-invalid');
  }
  return normalized;
}

function normalizedBookKey(value: string): string {
  return normalizeBookName(value).toLocaleLowerCase('und');
}

function assertManifest(manifest: NsfwWorldbookSourceManifest): void {
  if (!SOURCE_REVISION_RE.test(manifest.sourceRevision)
    || manifest.books.length > MAX_WORLDBOOKS) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-manifest-invalid');
  }
  const keys = new Set<string>();
  for (const book of manifest.books) {
    const key = normalizedBookKey(book);
    if (keys.has(key)) throw new NsfwSceneSafetyControlError('nsfw-safety-manifest-invalid');
    keys.add(key);
  }
}

function defaultState(
  manifest: NsfwWorldbookSourceManifest,
  reasonCode: PublicNsfwSceneSafety['reasonCode'] = 'not-configured',
): PublicNsfwSceneSafety {
  return Object.freeze({
    enabled: false,
    adultAttestation: 'revoked',
    participantsAdult: false,
    consent: 'revoked',
    allowedWorldbooks: Object.freeze([]),
    sourceRevision: manifest.sourceRevision,
    updatedAt: null,
    revision: 0,
    reasonCode,
  });
}

function openDatabase(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function hasTable(db: DatabaseSync): boolean {
  const row = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
  ).get(NSFW_SCENE_SAFETY_TABLE) as { present?: number } | undefined;
  return row?.present === 1;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${NSFW_SCENE_SAFETY_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      session_id TEXT NOT NULL,
      adult_attestation TEXT NOT NULL CHECK(adult_attestation IN ('verified', 'revoked')),
      participants_adult INTEGER NOT NULL CHECK(participants_adult IN (0, 1)),
      consent_state TEXT NOT NULL CHECK(consent_state IN ('confirmed', 'revoked')),
      allowed_worldbooks_json TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1)
    ) STRICT;
  `);
}

function rowFrom(db: DatabaseSync): StoredSafetyRow | undefined {
  return db.prepare(`
    SELECT session_id, adult_attestation, participants_adult, consent_state,
           allowed_worldbooks_json, source_revision, updated_at, revision
      FROM ${NSFW_SCENE_SAFETY_TABLE}
     WHERE singleton=1
  `).get() as StoredSafetyRow | undefined;
}

function parseStoredBooks(raw: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new NsfwSceneSafetyControlError('nsfw-safety-storage-invalid');
  }
  if (!Array.isArray(value) || value.length > MAX_WORLDBOOKS
    || value.some((book) => typeof book !== 'string')) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-storage-invalid');
  }
  const output: string[] = [];
  const keys = new Set<string>();
  for (const rawBook of value as string[]) {
    let book: string;
    let key: string;
    try {
      book = normalizeBookName(rawBook);
      key = normalizedBookKey(book);
    } catch {
      throw new NsfwSceneSafetyControlError('nsfw-safety-storage-invalid');
    }
    if (keys.has(key)) throw new NsfwSceneSafetyControlError('nsfw-safety-storage-invalid');
    keys.add(key);
    output.push(book);
  }
  return Object.freeze(output);
}

function projectRow(
  row: StoredSafetyRow,
  sessionId: string,
  manifest: NsfwWorldbookSourceManifest,
): PublicNsfwSceneSafety {
  if (row.session_id !== sessionId) return defaultState(manifest, 'session-binding-mismatch');
  if ((row.adult_attestation !== 'verified' && row.adult_attestation !== 'revoked')
    || (row.consent_state !== 'confirmed' && row.consent_state !== 'revoked')
    || (row.participants_adult !== 0 && row.participants_adult !== 1)
    || !SOURCE_REVISION_RE.test(row.source_revision)
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-storage-invalid');
  }
  const books = parseStoredBooks(row.allowed_worldbooks_json);
  const configured = row.adult_attestation === 'verified'
    && row.participants_adult === 1
    && row.consent_state === 'confirmed'
    && books.length > 0;
  const sourceMatches = row.source_revision === manifest.sourceRevision;
  const available = new Set(manifest.books.map(normalizedBookKey));
  const booksMatch = books.every((book) => available.has(normalizedBookKey(book)));
  const reasonCode: PublicNsfwSceneSafety['reasonCode'] = !configured
    ? 'revoked'
    : !sourceMatches
      ? 'source-revision-mismatch'
      : !booksMatch
        ? 'worldbook-binding-mismatch'
        : 'active';
  return Object.freeze({
    enabled: reasonCode === 'active',
    adultAttestation: row.adult_attestation,
    participantsAdult: row.participants_adult === 1,
    consent: row.consent_state,
    allowedWorldbooks: books,
    sourceRevision: row.source_revision,
    updatedAt: new Date(row.updated_at).toISOString(),
    revision: row.revision,
    reasonCode,
  });
}

export function parseNsfwSceneSafetyUpdate(value: unknown): NsfwSceneSafetyUpdateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-request-invalid');
  }
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'adultAttestation', 'participantsAdult', 'consent', 'allowedWorldbooks', 'expectedRevision',
  ]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))
    || (row.adultAttestation !== 'verified' && row.adultAttestation !== 'revoked')
    || typeof row.participantsAdult !== 'boolean'
    || (row.consent !== 'confirmed' && row.consent !== 'revoked')
    || !Array.isArray(row.allowedWorldbooks)
    || row.allowedWorldbooks.some((book) => typeof book !== 'string')
    || (row.expectedRevision !== undefined
      && (!Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 0))) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-request-invalid');
  }
  const enabling = row.adultAttestation === 'verified'
    && row.participantsAdult === true
    && row.consent === 'confirmed';
  const revoking = row.adultAttestation === 'revoked'
    && row.participantsAdult === false
    && row.consent === 'revoked';
  if ((!enabling && !revoking) || (revoking && row.allowedWorldbooks.length !== 0)) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-gates-inconsistent');
  }
  if (enabling && row.expectedRevision === undefined) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-revision-required');
  }
  if (row.allowedWorldbooks.length > MAX_WORLDBOOKS || (enabling && row.allowedWorldbooks.length < 1)) {
    throw new NsfwSceneSafetyControlError('nsfw-safety-worldbook-required');
  }
  return Object.freeze({
    adultAttestation: row.adultAttestation,
    participantsAdult: row.participantsAdult,
    consent: row.consent,
    allowedWorldbooks: Object.freeze([...(row.allowedWorldbooks as string[])]),
    ...(row.expectedRevision === undefined ? {} : { expectedRevision: Number(row.expectedRevision) }),
  });
}

export class NsfwSceneSafetyControl {
  constructor(private readonly now: () => Date = () => new Date()) {}

  read(input: {
    readonly dbPath: string;
    readonly sessionId: string;
    readonly manifest: NsfwWorldbookSourceManifest;
  }): PublicNsfwSceneSafety {
    assertSessionId(input.sessionId);
    assertManifest(input.manifest);
    const db = openDatabase(input.dbPath, true);
    try {
      if (!hasTable(db)) return defaultState(input.manifest);
      const row = rowFrom(db);
      return row ? projectRow(row, input.sessionId, input.manifest) : defaultState(input.manifest);
    } finally {
      db.close();
    }
  }

  resolveSnapshot(input: {
    readonly dbPath: string;
    readonly sessionId: string;
    readonly manifest: NsfwWorldbookSourceManifest;
  }): NsfwSceneSafetySnapshot | null {
    const state = this.read(input);
    if (!state.enabled) return null;
    return Object.freeze({
      adultAttestation: 'verified',
      participantAgeStatus: 'adult-confirmed',
      consentState: 'confirmed',
      sourceRevision: state.sourceRevision,
      allowedWorldbooks: state.allowedWorldbooks,
      revision: state.revision,
    });
  }

  update(input: {
    readonly dbPath: string;
    readonly sessionId: string;
    readonly manifest: NsfwWorldbookSourceManifest;
    readonly request: NsfwSceneSafetyUpdateRequest;
  }): PublicNsfwSceneSafety {
    assertSessionId(input.sessionId);
    assertManifest(input.manifest);
    const enabling = input.request.adultAttestation === 'verified';
    if (enabling && input.request.expectedRevision === undefined) {
      throw new NsfwSceneSafetyControlError('nsfw-safety-revision-required');
    }
    const canonicalByKey = new Map(input.manifest.books.map((book) => [normalizedBookKey(book), book]));
    const books: string[] = [];
    const seen = new Set<string>();
    for (const rawBook of input.request.allowedWorldbooks) {
      const key = normalizedBookKey(rawBook);
      const canonical = canonicalByKey.get(key);
      if (!canonical) throw new NsfwSceneSafetyControlError('nsfw-safety-worldbook-not-loaded');
      if (seen.has(key)) throw new NsfwSceneSafetyControlError('nsfw-safety-worldbook-invalid');
      seen.add(key);
      books.push(canonical);
    }
    if (enabling && books.length < 1) {
      throw new NsfwSceneSafetyControlError('nsfw-safety-worldbook-required');
    }

    const db = openDatabase(input.dbPath, false);
    let committed = false;
    try {
      ensureSchema(db);
      db.exec('BEGIN IMMEDIATE');
      const current = rowFrom(db);
      const currentRevision = current?.revision ?? 0;
      // Consent withdrawal is safety-dominant and may never be blocked by a stale UI.
      if (enabling && input.request.expectedRevision !== currentRevision) {
        throw new NsfwSceneSafetyControlError('nsfw-safety-revision-conflict');
      }
      const revision = currentRevision + 1;
      const updatedAt = this.now().toISOString();
      db.prepare(`
        INSERT INTO ${NSFW_SCENE_SAFETY_TABLE}(
          singleton,session_id,adult_attestation,participants_adult,consent_state,
          allowed_worldbooks_json,source_revision,updated_at,revision
        ) VALUES(1,?,?,?,?,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET
          session_id=excluded.session_id,
          adult_attestation=excluded.adult_attestation,
          participants_adult=excluded.participants_adult,
          consent_state=excluded.consent_state,
          allowed_worldbooks_json=excluded.allowed_worldbooks_json,
          source_revision=excluded.source_revision,
          updated_at=excluded.updated_at,
          revision=excluded.revision
      `).run(
        input.sessionId,
        input.request.adultAttestation,
        input.request.participantsAdult ? 1 : 0,
        input.request.consent,
        JSON.stringify(books),
        input.manifest.sourceRevision,
        updatedAt,
        revision,
      );
      db.exec('COMMIT');
      committed = true;
      return projectRow(rowFrom(db)!, input.sessionId, input.manifest);
    } finally {
      if (!committed) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      }
      db.close();
    }
  }
}
