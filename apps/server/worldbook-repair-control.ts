import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeWorldbookRepairProposal,
  worldbookRepairDigest,
  type WorldbookRepairProposal,
} from '../../packages/agent-policy/src/worldbook-repair-proposal.ts';
import {
  ABSENT_ASSET_REVISION,
  computeAssetRevision,
  deleteUserAssetOverrideCas,
  readRevisionedAsset,
  readRevisionedAssetLayer,
  saveUserAssetCas,
  type AssetMutationResult,
  type RevisionedAsset,
} from '../../packages/core/src/asset-paths.ts';
import { rawEntriesOf, stableEntryUid, toTavernHelperEntry } from './worldbook-bridge.ts';

export const WORLDBOOK_REPAIR_DB_FILE = 'worldbook-repair.sqlite';
const APPLICATION_ID = 0x4a475752; // JGWR
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export type WorldbookRepairStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'stale' | 'reverted';

export interface WorldbookRepairSummary {
  readonly proposalId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly file: string;
  readonly evidenceSetDigest: string;
  readonly proposalDigest: string;
  readonly sourceRevision: string;
  readonly appliedRevision?: string;
  readonly status: WorldbookRepairStatus;
  readonly revision: number;
  readonly changeCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorldbookAssetAdapter {
  read(file: string): RevisionedAsset | null;
  readLayer(file: string, source: 'asset'): RevisionedAsset | null;
  save(file: string, raw: string, expectedRevision: string): AssetMutationResult;
  deleteUserOverride(file: string, expectedRevision: string, expectedAssetRevision: string): AssetMutationResult;
}

export const coreWorldbookAssetAdapter: WorldbookAssetAdapter = Object.freeze({
  read: (file: string) => readRevisionedAsset('worldbook', file),
  readLayer: (file: string, source: 'asset') => readRevisionedAssetLayer('worldbook', file, source),
  save: (file: string, raw: string, expectedRevision: string) => saveUserAssetCas('worldbook', file, raw, expectedRevision),
  deleteUserOverride: (file: string, expectedRevision: string, expectedAssetRevision: string) =>
    deleteUserAssetOverrideCas('worldbook', file, expectedRevision, expectedAssetRevision),
});

interface StoredRow extends Record<string, unknown> {
  proposal_id: string;
  operation_id: string;
  intent_digest: string;
  proposal_json: string;
  proposal_digest: string;
  before_raw: string;
  before_source: 'user' | 'asset';
  after_raw: string;
  after_revision: string;
  status: WorldbookRepairStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('worldbook-repair-clock-invalid');
  return value;
}

function requireOperationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u.test(value)) throw new Error('worldbook-repair-operation-id-invalid');
  return value;
}

export function worldbookEntryDigest(entry: Record<string, unknown>): string {
  return sha(JSON.stringify(entry));
}

function buildAfterImage(asset: RevisionedAsset, proposal: WorldbookRepairProposal): string {
  if (Buffer.byteLength(asset.raw, 'utf8') > MAX_IMAGE_BYTES) throw new Error('worldbook-repair-before-image-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(asset.raw); } catch { throw new Error('worldbook-repair-source-json-invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('worldbook-repair-source-shape-invalid');
  const root = structuredClone(parsed) as Record<string, unknown>;
  const entries = rawEntriesOf(root).entries;
  const byUid = new Map<string, { raw: Record<string, unknown>; index: number }>();
  entries.forEach((entry, index) => {
    const uid = stableEntryUid(entry);
    if (uid === null) return;
    if (byUid.has(uid)) throw new Error('worldbook-repair-source-entry-ambiguous');
    byUid.set(uid, { raw: entry, index });
  });
  let changed = false;
  for (const change of proposal.changes) {
    const target = byUid.get(change.entryUid);
    if (!target) throw new Error('worldbook-repair-entry-not-found');
    if (worldbookEntryDigest(target.raw) !== change.expectedEntryDigest) throw new Error('worldbook-repair-entry-revision-conflict');
    const visible = { ...toTavernHelperEntry(target.raw, target.index), ...change.patch };
    const beforeVisible = toTavernHelperEntry(target.raw, target.index);
    if (change.patch.name !== undefined) {
      changed ||= beforeVisible.name !== visible.name;
      target.raw.comment = visible.name;
    }
    if (change.patch.content !== undefined) {
      changed ||= beforeVisible.content !== visible.content;
      target.raw.content = visible.content;
    }
    if (change.patch.key !== undefined) {
      changed ||= JSON.stringify(beforeVisible.key) !== JSON.stringify(visible.key);
      if (target.raw.keys !== undefined || target.raw.key === undefined) target.raw.keys = [...visible.key];
      else target.raw.key = [...visible.key];
    }
    if (change.patch.enabled !== undefined) {
      changed ||= beforeVisible.enabled !== visible.enabled;
      if (target.raw.enabled !== undefined || target.raw.disable === undefined) target.raw.enabled = visible.enabled;
      else target.raw.disable = !visible.enabled;
    }
  }
  if (!changed) throw new Error('worldbook-repair-no-op');
  const after = `${JSON.stringify(root, null, 2)}\n`;
  if (Buffer.byteLength(after, 'utf8') > MAX_IMAGE_BYTES) throw new Error('worldbook-repair-after-image-too-large');
  return after;
}

function initialize(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const app = Number((db.prepare('PRAGMA application_id').get() as Record<string, unknown>).application_id);
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version);
  if ((app !== 0 && app !== APPLICATION_ID) || version > 1) throw new Error('worldbook-repair-database-metadata-invalid');
  if (version === 1) return;
  db.exec(`
    BEGIN IMMEDIATE;
    PRAGMA application_id=${APPLICATION_ID};
    CREATE TABLE worldbook_repair_proposal (
      proposal_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      intent_digest TEXT NOT NULL,
      proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
      proposal_digest TEXT NOT NULL,
      before_raw TEXT NOT NULL,
      before_source TEXT NOT NULL CHECK(before_source IN ('user','asset')),
      after_raw TEXT NOT NULL,
      after_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','applied','rejected','stale','reverted')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX worldbook_repair_by_session ON worldbook_repair_proposal(
      json_extract(proposal_json,'$.sessionId'),status,created_at
    );
    PRAGMA user_version=1;
    COMMIT;
  `);
}

export class WorldbookRepairControl {
  readonly #db: DatabaseSync;
  readonly #asset: WorldbookAssetAdapter;
  readonly #now: () => string;
  readonly #randomId: () => string;

  constructor(options: { dataDir: string; asset?: WorldbookAssetAdapter; now?: () => string; randomId?: () => string }) {
    mkdirSync(options.dataDir, { recursive: true });
    const path = join(options.dataDir, WORLDBOOK_REPAIR_DB_FILE);
    this.#db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the private data root. */ }
    initialize(this.#db);
    this.#asset = options.asset ?? coreWorldbookAssetAdapter;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
  }

  close(): void { this.#db.close(); }

  create(input: { operationId: string; proposal: unknown }): WorldbookRepairSummary {
    const operationId = requireOperationId(input.operationId);
    const proposal = normalizeWorldbookRepairProposal(input.proposal);
    const proposalDigest = worldbookRepairDigest(proposal);
    const intentDigest = sha(JSON.stringify({ operationId, proposalDigest }));
    const replay = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE operation_id=?').get(operationId) as StoredRow | undefined;
    if (replay) {
      if (replay.intent_digest !== intentDigest) throw new Error('worldbook-repair-operation-intent-conflict');
      return this.#summary(replay);
    }
    const current = this.#asset.read(proposal.file);
    if (!current) throw new Error('worldbook-repair-source-not-found');
    if (current.revision !== proposal.expectedRevision) throw new Error('worldbook-repair-source-revision-conflict');
    const afterRaw = buildAfterImage(current, proposal);
    const afterRevision = computeAssetRevision('worldbook', proposal.file, 'user', afterRaw);
    const proposalId = `wbr_${this.#randomId()}`;
    const now = canonicalTimestamp(this.#now());
    this.#db.prepare(`INSERT INTO worldbook_repair_proposal(
      proposal_id,operation_id,intent_digest,proposal_json,proposal_digest,before_raw,before_source,
      after_raw,after_revision,status,revision,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'pending',1,?,?)`).run(
      proposalId, operationId, intentDigest, JSON.stringify(proposal), proposalDigest, current.raw, current.source,
      afterRaw, afterRevision, now, now,
    );
    return this.get(proposalId)!;
  }

  get(proposalId: string): WorldbookRepairSummary | null {
    const row = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId) as StoredRow | undefined;
    return row ? this.#summary(row) : null;
  }

  /**
   * Content-free, exact-session read model. The fixed upper bound prevents a
   * long-lived repair database from turning the Agent status endpoint into an
   * unbounded JSON/SQLite read.
   */
  list(sessionId: string, limit = 50): readonly WorldbookRepairSummary[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u.test(sessionId)) {
      throw new Error('worldbook-repair-session-id-invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('worldbook-repair-list-limit-invalid');
    }
    const rows = this.#db.prepare(`SELECT * FROM worldbook_repair_proposal
      WHERE json_extract(proposal_json,'$.sessionId')=?
      ORDER BY updated_at DESC, proposal_id DESC LIMIT ?`).all(sessionId, limit) as StoredRow[];
    return Object.freeze(rows.map((row) => this.#summary(row)));
  }

  approve(proposalId: string, expectedRevision: number): WorldbookRepairSummary {
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='approved',revision=revision+1,updated_at=?
      WHERE proposal_id=? AND status='pending' AND revision=?`).run(now, proposalId, expectedRevision);
    if (result.changes !== 1) throw new Error('worldbook-repair-proposal-revision-conflict');
    return this.get(proposalId)!;
  }

  apply(proposalId: string, expectedRevision: number): WorldbookRepairSummary {
    return this.#transition(proposalId, expectedRevision, 'apply');
  }

  revert(proposalId: string, expectedRevision: number): WorldbookRepairSummary {
    return this.#transition(proposalId, expectedRevision, 'revert');
  }

  reject(proposalId: string, expectedRevision: number): WorldbookRepairSummary {
    const now = canonicalTimestamp(this.#now());
    const result = this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='rejected',revision=revision+1,updated_at=?
      WHERE proposal_id=? AND status IN ('pending','approved') AND revision=?`).run(now, proposalId, expectedRevision);
    if (result.changes !== 1) throw new Error('worldbook-repair-proposal-revision-conflict');
    return this.get(proposalId)!;
  }

  #transition(proposalId: string, expectedRevision: number, operation: 'apply' | 'revert'): WorldbookRepairSummary {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('worldbook-repair-proposal-revision-invalid');
    let restoreDeletedOverride: {
      readonly file: string;
      readonly raw: string;
      readonly expectedEffectiveRevision: string;
      readonly expectedRestoredRevision: string;
    } | null = null;
    let committed = false;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId) as StoredRow | undefined;
      if (!row || row.revision !== expectedRevision || row.status !== (operation === 'apply' ? 'approved' : 'applied')) {
        throw new Error('worldbook-repair-proposal-revision-conflict');
      }
      const proposal = normalizeWorldbookRepairProposal(JSON.parse(row.proposal_json));
      const current = this.#asset.read(proposal.file);
      if (!current && !(operation === 'revert' && row.before_source === 'asset')) {
        throw new Error('worldbook-repair-source-not-found');
      }
      const now = canonicalTimestamp(this.#now());
      if (operation === 'apply') {
        if (!current) throw new Error('worldbook-repair-source-not-found');
        if (current.revision === proposal.expectedRevision) {
          const mutation = this.#asset.save(proposal.file, row.after_raw, proposal.expectedRevision);
          if (!DIGEST.test(mutation.revision)) throw new Error('worldbook-repair-applied-revision-invalid');
          this.#db.prepare('UPDATE worldbook_repair_proposal SET after_revision=? WHERE proposal_id=?')
            .run(mutation.revision, proposalId);
          row.after_revision = mutation.revision;
        } else if (current.raw === row.after_raw && current.source === 'user') {
          // A process may die after the atomic file replace but before the SQLite receipt commit.
          // Exact bytes plus the user layer are sufficient to reconcile that bounded crash window.
          this.#db.prepare('UPDATE worldbook_repair_proposal SET after_revision=? WHERE proposal_id=?')
            .run(current.revision, proposalId);
          row.after_revision = current.revision;
        } else {
          this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='stale',revision=revision+1,updated_at=? WHERE proposal_id=?`)
            .run(now, proposalId);
          this.#db.exec('COMMIT;');
          return this.get(proposalId)!;
        }
        this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='applied',revision=revision+1,updated_at=? WHERE proposal_id=?`)
          .run(now, proposalId);
      } else {
        const alreadyReverted = current?.revision === proposal.expectedRevision
          && current.raw === row.before_raw && current.source === row.before_source;
        if (!alreadyReverted) {
          if (row.before_source === 'asset' && (!current || current.source === 'asset')) {
            // The process may have died after deleting the override but before committing the
            // SQLite receipt. If the revealed asset is not the exact before-image, restore the
            // applied user override rather than leaving the control DB and filesystem divergent.
            const actualRevision = current?.revision ?? ABSENT_ASSET_REVISION;
            const recovered = this.#asset.save(proposal.file, row.after_raw, actualRevision);
            const recoveredAsset = this.#asset.read(proposal.file);
            if (recovered.revision !== row.after_revision || !recoveredAsset
              || recoveredAsset.source !== 'user' || recoveredAsset.raw !== row.after_raw
              || recoveredAsset.revision !== row.after_revision) {
              throw new Error('worldbook-repair-revert-restore-failed');
            }
            throw new Error('worldbook-repair-revert-revision-conflict');
          }
          if (!current || current.revision !== row.after_revision || current.raw !== row.after_raw
            || current.source !== 'user') {
            throw new Error('worldbook-repair-revert-revision-conflict');
          }
          if (row.before_source === 'asset') {
            const source = this.#asset.readLayer(proposal.file, 'asset');
            if (!source || source.revision !== proposal.expectedRevision || source.raw !== row.before_raw) {
              throw new Error('worldbook-repair-revert-source-drift');
            }
            const deletion = this.#asset.deleteUserOverride(
              proposal.file,
              row.after_revision,
              proposal.expectedRevision,
            );
            restoreDeletedOverride = {
              file: proposal.file,
              raw: row.after_raw,
              expectedEffectiveRevision: deletion.revision,
              expectedRestoredRevision: row.after_revision,
            };
            if (!deletion.removed || deletion.revision !== proposal.expectedRevision) {
              throw new Error('worldbook-repair-revert-verification-failed');
            }
          } else {
            this.#asset.save(proposal.file, row.before_raw, row.after_revision);
          }
          const restored = this.#asset.read(proposal.file);
          if (!restored || restored.raw !== row.before_raw || restored.source !== row.before_source
            || restored.revision !== proposal.expectedRevision) throw new Error('worldbook-repair-revert-verification-failed');
        }
        this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='reverted',revision=revision+1,updated_at=? WHERE proposal_id=?`)
          .run(now, proposalId);
      }
      this.#db.exec('COMMIT;');
      committed = true;
      restoreDeletedOverride = null;
      return this.get(proposalId)!;
    } catch (error) {
      try { this.#db.exec('ROLLBACK;'); } catch { /* preserve first error */ }
      if (!committed && restoreDeletedOverride) {
        try {
          const restored = this.#asset.save(
            restoreDeletedOverride.file,
            restoreDeletedOverride.raw,
            restoreDeletedOverride.expectedEffectiveRevision,
          );
          const current = this.#asset.read(restoreDeletedOverride.file);
          if (restored.revision !== restoreDeletedOverride.expectedRestoredRevision || !current
            || current.source !== 'user' || current.raw !== restoreDeletedOverride.raw
            || current.revision !== restoreDeletedOverride.expectedRestoredRevision) {
            throw new Error('worldbook-repair-revert-restore-verification-failed');
          }
        } catch (restoreError) {
          const failure = new Error('worldbook-repair-revert-restore-failed');
          (failure as Error & { cause?: unknown }).cause = { originalError: error, restoreError };
          throw failure;
        }
      }
      throw error;
    }
  }

  #summary(row: StoredRow): WorldbookRepairSummary {
    const proposal = normalizeWorldbookRepairProposal(JSON.parse(row.proposal_json));
    return Object.freeze({
      proposalId: row.proposal_id,
      operationId: row.operation_id,
      sessionId: proposal.sessionId,
      file: proposal.file,
      evidenceSetDigest: proposal.evidenceSetDigest,
      proposalDigest: row.proposal_digest,
      sourceRevision: proposal.expectedRevision,
      ...(row.status === 'applied' || row.status === 'reverted' ? { appliedRevision: row.after_revision } : {}),
      status: row.status,
      revision: row.revision,
      changeCount: proposal.changes.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
