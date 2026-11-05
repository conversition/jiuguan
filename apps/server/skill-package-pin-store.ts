/** Durable, single-session control for the existing reviewed Style package Canary. */
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STYLE_PACKAGE_SHADOW_PIN } from './skill-hub/style-package-source.ts';

export const SKILL_PACKAGE_PIN_DB_FILE = 'agent-skill-package-pin.sqlite';
export const SKILL_PACKAGE_PIN_APPLICATION_ID = 0x4a475049; // JGPI
export interface SkillPackagePin {
  readonly version: 'skill-package-pin-v1';
  readonly revision: number;
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly packageDigest: string;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
  readonly reason: string;
  readonly digest: string;
}
export interface SkillPackagePinInput {
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expiresAt: string | null;
  readonly reason: string;
}
const HASH = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const fail = (code: string): never => { throw new Error(`skill-package-pin-${code}`); };
const SCHEMA = [
  `CREATE TABLE pin (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=1), record TEXT NOT NULL CHECK(json_valid(record)))`,
  `CREATE TABLE history (revision INTEGER PRIMARY KEY CHECK(revision>=1), record TEXT NOT NULL CHECK(json_valid(record)))`,
  `CREATE TRIGGER pin_revision BEFORE UPDATE ON pin WHEN NEW.revision != OLD.revision+1 BEGIN SELECT RAISE(ABORT,'pin revision conflict'); END`,
  `CREATE TRIGGER pin_no_delete BEFORE DELETE ON pin BEGIN SELECT RAISE(ABORT,'pin cannot be deleted'); END`,
  `CREATE TRIGGER history_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'pin history immutable'); END`,
  `CREATE TRIGGER history_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT,'pin history immutable'); END`,
];
const normalized = (sql: string) => sql.trim().replace(/\s+/gu, ' ').toLowerCase();
export function inspectSkillPackagePinSchema(db: DatabaseSync): void {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row => normalized(String(row.sql))).sort();
  if (db.prepare('PRAGMA user_version').get()!.user_version !== 1
    || db.prepare('PRAGMA application_id').get()!.application_id !== SKILL_PACKAGE_PIN_APPLICATION_ID
    || JSON.stringify(schema) !== JSON.stringify(SCHEMA.map(normalized).sort())) fail('storage-invalid');
}
function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validFields(value: { enabled: unknown; sessionId: unknown; expiresAt: unknown; reason: unknown }): boolean {
  return typeof value.enabled === 'boolean' && typeof value.reason === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(value.reason)
    && (value.enabled ? typeof value.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.sessionId)
      && validTime(value.expiresAt) : value.sessionId === null && value.expiresAt === null);
}
export class SkillPackagePinStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(options: { dataDir: string; nowMs?: () => number }) {
    const directory = resolve(options.dataDir);
    for (let current = directory; current !== parse(current).root; current = dirname(current)) {
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('storage-invalid');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, SKILL_PACKAGE_PIN_DB_FILE);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('storage-invalid');
    }
    this.#now = options.nowMs ?? Date.now;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get()!.user_version;
      const appId = this.#db.prepare('PRAGMA application_id').get()!.application_id;
      const schema = () => this.#db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row => normalized(String(row.sql))).sort();
      if (version === 0 && appId === 0 && schema().length === 0) {
        SCHEMA.forEach(sql => this.#db.exec(sql));
        this.#db.exec(`PRAGMA user_version=1; PRAGMA application_id=${SKILL_PACKAGE_PIN_APPLICATION_ID}`);
      } else if (version !== 1 || appId !== SKILL_PACKAGE_PIN_APPLICATION_ID) fail('storage-invalid');
      inspectSkillPackagePinSchema(this.#db);
      this.#db.exec('COMMIT');
      this.read();
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      this.#db.close(); throw error;
    }
  }
  read(): SkillPackagePin | null {
    const row = this.#db.prepare('SELECT revision,record FROM pin WHERE id=1').get();
    const latest = this.#db.prepare('SELECT revision,record FROM history ORDER BY revision DESC LIMIT 1').get();
    if (!row) { if (latest) fail('storage-invalid'); return null; }
    let value: SkillPackagePin;
    try { value = JSON.parse(String(row.record)); } catch { return fail('storage-invalid'); }
    if (!value || Object.keys(value).length !== 9 || value.version !== 'skill-package-pin-v1'
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || row.revision !== value.revision
      || value.packageDigest !== STYLE_PACKAGE_SHADOW_PIN.packageDigest || !validTime(value.updatedAt) || !validFields(value)
      || !latest || latest.revision !== row.revision || latest.record !== row.record) fail('storage-invalid');
    const { digest, ...core } = value;
    if (digest !== HASH(core)) fail('storage-invalid');
    return Object.freeze(value);
  }
  /** Caller performs permission/source checks inside this synchronous write transaction. */
  set(input: SkillPackagePinInput, authorize: () => void): SkillPackagePin {
    if (!input || Object.keys(input).length !== 5 || !validFields(input)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || input.expectedRevision >= Number.MAX_SAFE_INTEGER || typeof authorize !== 'function') fail('input-invalid');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.read();
      if ((old?.revision ?? 0) !== input.expectedRevision) fail('revision-conflict');
      authorize();
      const now = this.#now();
      if (input.enabled && (Date.parse(input.expiresAt!) <= now || Date.parse(input.expiresAt!) > now + 24 * 60 * 60 * 1000)) fail('expiry-invalid');
      const core = { version: 'skill-package-pin-v1' as const, revision: input.expectedRevision + 1,
        enabled: input.enabled, sessionId: input.sessionId, packageDigest: STYLE_PACKAGE_SHADOW_PIN.packageDigest,
        expiresAt: input.expiresAt, updatedAt: new Date(now).toISOString(), reason: input.reason };
      if (old && core.updatedAt < old.updatedAt) fail('clock-regressed');
      const value = Object.freeze({ ...core, digest: HASH(core) });
      const json = JSON.stringify(value);
      this.#db.prepare('INSERT INTO pin(id,revision,record) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record').run(value.revision, json);
      this.#db.prepare('INSERT INTO history(revision,record) VALUES(?,?)').run(value.revision, json);
      this.read(); this.#db.exec('COMMIT'); return value;
    } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  close() { this.#db.close(); }
}
