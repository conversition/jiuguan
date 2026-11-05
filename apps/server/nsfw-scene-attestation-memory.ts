/** @author WorkBuddy @date 2026-11-01
 * Device-level memory of the most recent adult-scene attestation.
 *
 * Why this exists: the per-session gate stores its grant inside the session database, so a new
 * conversation always starts from "not configured" and the operator has to re-tick every
 * attestation. The three attestation statements describe the person operating this device, not
 * the session, so remembering the latest confirmed set — and pre-filling new sessions from it —
 * matches the user's mental model without weakening anything: the inheritance is a UI pre-fill
 * only, a new session still needs an explicit enable POST, and any revocation overwrites the
 * memory so later sessions do not inherit a withdrawn consent.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const NSFW_SCENE_ATTESTATION_FILE = 'nsfw-scene-attestation.sqlite';
const TABLE = 'nsfw_scene_attestation_memory';
const MAX_MEMORY_BOOKS = 32;

export interface NsfwSceneAttestationMemoryInput {
  readonly adultAttestation: 'verified' | 'revoked';
  readonly participantsAdult: boolean;
  readonly consent: 'confirmed' | 'revoked';
  readonly allowedWorldbooks: readonly string[];
}

export interface NsfwSceneInheritedAttestation {
  readonly adultAttestation: 'verified';
  readonly participantsAdult: true;
  readonly consent: 'confirmed';
  readonly books: readonly string[];
  readonly confirmedAt: string;
}

interface StoredRow {
  readonly adult_attestation: string;
  readonly participants_adult: number;
  readonly consent_state: string;
  readonly books_json: string;
  readonly updated_at: string;
}

function parseBooks(raw: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((book) => typeof book !== 'string')) return [];
    return Object.freeze((value as string[]).slice(0, MAX_MEMORY_BOOKS));
  } catch {
    return [];
  }
}

export class NsfwSceneAttestationMemory {
  readonly #path: string;
  readonly #now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#path = `${dataDir}/${NSFW_SCENE_ATTESTATION_FILE}`.replaceAll('\\', '/');
    this.#now = now;
  }

  #open(): DatabaseSync {
    const db = new DatabaseSync(this.#path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        adult_attestation TEXT NOT NULL CHECK(adult_attestation IN ('verified', 'revoked')),
        participants_adult INTEGER NOT NULL CHECK(participants_adult IN (0, 1)),
        consent_state TEXT NOT NULL CHECK(consent_state IN ('confirmed', 'revoked')),
        books_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1)
      ) STRICT;
    `);
    return db;
  }

  /** Latest device-wide attestation, or null while the last action was a revocation. */
  readLatest(): NsfwSceneInheritedAttestation | null {
    if (!existsSync(this.#path)) return null;
    const db = new DatabaseSync(this.#path, { readOnly: true });
    try {
      const present = db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      ).get(TABLE) as { ok?: number } | undefined;
      if (!present) return null;
      const row = db.prepare(
        `SELECT adult_attestation,participants_adult,consent_state,books_json,updated_at
           FROM ${TABLE} WHERE singleton=1`,
      ).get() as StoredRow | undefined;
      if (!row) return null;
      if (row.adult_attestation !== 'verified' || Number(row.participants_adult) !== 1
        || row.consent_state !== 'confirmed') return null;
      return Object.freeze({
        adultAttestation: 'verified',
        participantsAdult: true,
        consent: 'confirmed',
        books: parseBooks(row.books_json),
        confirmedAt: row.updated_at,
      });
    } catch {
      // A damaged or foreign file must never block the safety gate itself.
      return null;
    } finally {
      db.close();
    }
  }

  /** Called after every committed per-session update, including revocations. */
  record(input: NsfwSceneAttestationMemoryInput): void {
    const books = input.adultAttestation === 'verified'
      ? Object.freeze([...input.allowedWorldbooks].slice(0, MAX_MEMORY_BOOKS))
      : Object.freeze([]);
    let db: DatabaseSync | null = null;
    try {
      db = this.#open();
      db.exec('BEGIN IMMEDIATE');
      const current = db.prepare(
        `SELECT revision FROM ${TABLE} WHERE singleton=1`,
      ).get() as { revision?: number } | undefined;
      const revision = Number(current?.revision ?? 0) + 1;
      db.prepare(`
        INSERT INTO ${TABLE}(
          singleton,adult_attestation,participants_adult,consent_state,books_json,updated_at,revision
        ) VALUES(1,?,?,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET
          adult_attestation=excluded.adult_attestation,
          participants_adult=excluded.participants_adult,
          consent_state=excluded.consent_state,
          books_json=excluded.books_json,
          updated_at=excluded.updated_at,
          revision=excluded.revision
      `).run(
        input.adultAttestation,
        input.participantsAdult ? 1 : 0,
        input.consent,
        JSON.stringify(books),
        this.#now().toISOString(),
        revision,
      );
      db.exec('COMMIT');
    } catch {
      try { db?.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw new Error('nsfw-scene-attestation-memory-write-failed');
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
}
