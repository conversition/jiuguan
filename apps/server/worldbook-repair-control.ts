import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeWorldbookRepairProposal,
  worldbookRepairDigest,
  type WorldbookRepairPatch,
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
import { validateMaintenanceProposal, type MaintenanceStrictProposalContext } from './maintenance-types.ts';
import { maintenanceWorldbookSkillProviderProposalContext } from './skill-hub/maintenance-worldbook-context.ts';
import { isMaintenanceWorldbookSkillProposalProof, maintenanceWorldbookSkillDigest,
  type MaintenanceWorldbookSkillProposalProof } from './skill-hub/maintenance-worldbook-proposal-proof.ts';
import { inspectMaintenanceWorldbookSkillSourceSchema, MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE,
  MaintenanceWorldbookSkillSourceStore, type MaintenanceWorldbookSkillSourceEntry,
  type WorldbookSkillNativeBinding } from './maintenance-worldbook-skill-source.ts';
import { WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE, inspectWorldbookRepairApplyReceiptSchema,
  prepareWorldbookRepairApplyReceipt, insertWorldbookRepairApplyReceipt, readWorldbookRepairApplyReceipt,
  type WorldbookRepairApplyReceipt } from './worldbook-repair-apply-receipt.ts';

export const WORLDBOOK_REPAIR_DB_FILE = 'worldbook-repair.sqlite';
export const WORLDBOOK_REPAIR_READBACK_VERSION = 'worldbook-repair-readback-v1' as const;
const WORLDBOOK_REPAIR_OPERATION_PREFIX = 'worldbook-repair:';

/**
 * P16 C2.2 · 世界书写后回读。
 *
 * 用途：apply / revert **提交之后**重新读取生效层的世界书，产出一个可核对的摘要。
 * 它不是新真值来源：输入必须是提交后从 asset 层重新读出的内容，不能复用提案、
 * before/after 镜像或 apply 应答。回执**内容无关**：只出条目数、生效 revision、
 * 层来源和摘要，条目正文一律不出结构。
 */
export interface WorldbookReadbackReceipt {
  readonly version: typeof WORLDBOOK_REPAIR_READBACK_VERSION;
  readonly entryCount: number;
  readonly revision: string;
  readonly source: 'user' | 'asset';
  readonly readbackDigest: string;
}

/** 从 operationId 还原维护 job 的 runId；格式不符返回 null（调用方据此 fail-closed）。 */
export function worldbookRepairRunIdOf(operationId: string): string | null {
  return operationId.startsWith(WORLDBOOK_REPAIR_OPERATION_PREFIX)
    && operationId.length > WORLDBOOK_REPAIR_OPERATION_PREFIX.length
    ? operationId.slice(WORLDBOOK_REPAIR_OPERATION_PREFIX.length)
    : null;
}
export const WORLDBOOK_REPAIR_APPLICATION_ID = 0x4a475752;
const APPLICATION_ID = WORLDBOOK_REPAIR_APPLICATION_ID; // JGWR
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
  /** 去重排序后的原因码分类（不含条目正文）。 */
  readonly reasonCodes: readonly string[];
  /**
   * 仅在显式请求（includeContent=true，即本机可操作者）时提供：
   * 条目级变更的**审阅视图**（uid + 原因 + patch）。这是 "content-free" 边界
   * 唯一受控的出口；列表/摘要接口默认仍不携带。
   */
  readonly changes?: readonly WorldbookRepairChangeDetail[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 审阅视图：patch 原样给本机操作者（不含 before/after 全文镜像）。 */
export interface WorldbookRepairChangeDetail {
  readonly entryUid: string;
  readonly reasonCode: string;
  readonly patch: WorldbookRepairPatch;
}

export interface WorldbookRepairSessionDeletionResult {
  /** Number of proposal/audit rows removed from the private control database. */
  readonly deletedProposals: number;
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

function requireSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u.test(value)) {
    throw new Error('worldbook-repair-session-id-invalid');
  }
  return value;
}

/** 与插入顺序无关的 JSON：读回摘要不能随序列化顺序变化。 */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).filter((key) => row[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(row[key])).join(',') + '}';
}

/**
 * 规范化后的世界书读回：按稳定 uid 排序条目（缺 uid 时按序退化，与既有展示口径一致），
 * 用磁盘原始条目的规范化 JSON 求摘要。条目内容只进摘要、不进回执。
 */
export function worldbookReadbackOf(asset: RevisionedAsset | null): WorldbookReadbackReceipt {
  if (!asset) throw new Error('worldbook-readback-source-missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(asset.raw);
  } catch {
    throw new Error('worldbook-readback-unparseable');
  }
  const { entries } = rawEntriesOf(parsed);
  const canonical = entries
    .map((entry, index) => ({ uid: stableEntryUid(entry) ?? `idx-${index}`, entry }))
    .sort((left, right) => (left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0))
    .map((item) => ({ uid: item.uid, digest: sha(stableJson(item.entry)) }));
  return Object.freeze({
    version: WORLDBOOK_REPAIR_READBACK_VERSION,
    entryCount: canonical.length,
    revision: asset.revision,
    source: asset.source === 'user' ? 'user' as const : 'asset' as const,
    readbackDigest: sha(stableJson(canonical)),
  });
}

/** 世界书修正控制面的转换回执（内容无关），供旁路评估层消费。 */
export interface WorldbookRepairTransitionObservation {
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly changeCount: number;
  readonly status: 'created' | 'applied' | 'reverted' | 'stale' | 'rejected';
  readonly occurredAt: string;
  readonly targetRevision?: string;
  readonly readbackDigest?: string;
  readonly rollbackDigest?: string;
  readonly reasonCode?: string;
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

const PROPOSAL_SCHEMA = `CREATE TABLE worldbook_repair_proposal (
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
    )`;
const PROPOSAL_INDEX = `CREATE INDEX worldbook_repair_by_session ON worldbook_repair_proposal(
      json_extract(proposal_json,'$.sessionId'),status,created_at
    )`;

/** Frozen/read-only owner validation. Optional historical tables stay optional; no repair or migration. */
export function inspectWorldbookRepairSchema(db: DatabaseSync): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID
    || db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('worldbook-repair-database-metadata-invalid');
  const normalized = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().replace(/;$/u, '') : '';
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const table = objects.find(row => row.name === 'worldbook_repair_proposal');
  const index = objects.find(row => row.name === 'worldbook_repair_by_session');
  const allowed = ['worldbook_repair_proposal', 'worldbook_repair_by_session'];
  if (table?.type !== 'table' || normalized(table.sql) !== normalized(PROPOSAL_SCHEMA)
    || index?.type !== 'index' || normalized(index.sql) !== normalized(PROPOSAL_INDEX)) throw new Error('worldbook-repair-schema-invalid');
  if (objects.some(row => row.name === MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE)) {
    inspectMaintenanceWorldbookSkillSourceSchema(db); allowed.push(MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE);
  }
  if (objects.some(row => row.name === WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE)) {
    inspectWorldbookRepairApplyReceiptSchema(db); allowed.push(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE);
  }
  if (objects.some(row => !allowed.includes(String(row.name))) || db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('worldbook-repair-schema-invalid');
}

function initialize(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const app = Number((db.prepare('PRAGMA application_id').get() as Record<string, unknown>).application_id);
  const version = Number((db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version);
  if ((app !== 0 && app !== APPLICATION_ID) || version > 1) throw new Error('worldbook-repair-database-metadata-invalid');
  if (version === 1) {
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE))
      inspectWorldbookRepairApplyReceiptSchema(db);
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(MAINTENANCE_WORLDBOOK_SKILL_SOURCE_TABLE)) {
      inspectMaintenanceWorldbookSkillSourceSchema(db);
    }
    return;
  }
  db.exec(`
    BEGIN IMMEDIATE;
    PRAGMA application_id=${APPLICATION_ID};
    ${PROPOSAL_SCHEMA};
    ${PROPOSAL_INDEX};
    PRAGMA user_version=1;
    COMMIT;
  `);
}

export class WorldbookRepairControl {
  readonly #db: DatabaseSync;
  readonly #asset: WorldbookAssetAdapter;
  readonly #observe?: (observation: WorldbookRepairTransitionObservation) => void;
  readonly #now: () => string;
  readonly #randomId: () => string;

  constructor(options: {
    dataDir: string;
    asset?: WorldbookAssetAdapter;
    now?: () => string;
    randomId?: () => string;
    /** 旁路评估层的转换观测口；best-effort，绝不影响控制面结果。 */
    observe?: (observation: WorldbookRepairTransitionObservation) => void;
  }) {
    mkdirSync(options.dataDir, { recursive: true });
    const path = join(options.dataDir, WORLDBOOK_REPAIR_DB_FILE);
    this.#db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the private data root. */ }
    try { initialize(this.#db); } catch (error) { this.#db.close(); throw error; }
    this.#asset = options.asset ?? coreWorldbookAssetAdapter;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomId = options.randomId ?? randomUUID;
    this.#observe = options.observe;
  }

  close(): void { this.#db.close(); }

  /** 只发事件，不抛错：评估失败不得回滚已提交的业务真值。 */
  #emit(observation: Omit<WorldbookRepairTransitionObservation, 'runId'> & { runId: string | null }): void {
    if (!this.#observe || !observation.runId) return;
    try {
      this.#observe(Object.freeze({ ...observation, runId: observation.runId }) as WorldbookRepairTransitionObservation);
    } catch { /* 评估证据丢失由 reconciler 补录 */ }
  }

  create(input: { operationId: string; proposal: unknown;
    skillProof?: MaintenanceWorldbookSkillProposalProof; context?: MaintenanceStrictProposalContext }): WorldbookRepairSummary {
    const operationId = requireOperationId(input.operationId);
    const proposal = normalizeWorldbookRepairProposal(input.proposal);
    const proposalDigest = worldbookRepairDigest(proposal);
    const intentDigest = sha(JSON.stringify({ operationId, proposalDigest }));
    const required = Object.hasOwn(input, 'skillProof');
    if (required) {
      try {
        if (!isMaintenanceWorldbookSkillProposalProof(input.skillProof) || !input.context
          || operationId !== `worldbook-repair:${input.skillProof.runId}`
          || proposal.sessionId !== input.skillProof.sessionId || input.context.sessionId !== proposal.sessionId
          || input.skillProof.validatedAt > canonicalTimestamp(this.#now())
          || maintenanceWorldbookSkillDigest(input.context) !== input.skillProof.proposalContextDigest
          || maintenanceWorldbookSkillDigest(maintenanceWorldbookSkillProviderProposalContext(input.context))
            !== input.skillProof.providerProposalContextDigest
          || maintenanceWorldbookSkillDigest(validateMaintenanceProposal('worldbook_repair', proposal, input.context))
            !== input.skillProof.proposalDigest) throw new Error();
      } catch { throw new Error('maintenance-worldbook-skill-provenance-invalid'); }
    }
    // Required source and the original pending row share one transaction. No asset is written here.
    if (required) this.#db.exec('BEGIN IMMEDIATE;');
    let created: WorldbookRepairSummary;
    let now: string;
    try {
      const replay = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE operation_id=?').get(operationId) as StoredRow | undefined;
      if (replay) {
        if (replay.intent_digest !== intentDigest) throw new Error('worldbook-repair-operation-intent-conflict');
        if (required) {
          const source = MaintenanceWorldbookSkillSourceStore.openExisting(this.#db, (id) => this.#readSkillNative(id))?.read(replay.proposal_id);
          if (!source || source.record.proof.proofDigest !== input.skillProof!.proofDigest) {
            throw new Error('maintenance-worldbook-skill-provenance-invalid');
          }
          this.#db.exec('COMMIT;');
        }
        return this.#summary(replay);
      }
      const current = this.#asset.read(proposal.file);
      if (!current) throw new Error('worldbook-repair-source-not-found');
      if (current.revision !== proposal.expectedRevision) throw new Error('worldbook-repair-source-revision-conflict');
      const afterRaw = buildAfterImage(current, proposal);
      const afterRevision = computeAssetRevision('worldbook', proposal.file, 'user', afterRaw);
      const proposalId = `wbr_${this.#randomId()}`;
      now = canonicalTimestamp(this.#now());
      this.#db.prepare(`INSERT INTO worldbook_repair_proposal(
        proposal_id,operation_id,intent_digest,proposal_json,proposal_digest,before_raw,before_source,
        after_raw,after_revision,status,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending',1,?,?)`).run(
        proposalId, operationId, intentDigest, JSON.stringify(proposal), proposalDigest, current.raw, current.source,
        afterRaw, afterRevision, now, now,
      );
      created = this.get(proposalId)!;
      if (required) {
        new MaintenanceWorldbookSkillSourceStore(this.#db, (id) => this.#readSkillNative(id))
          .insert(proposalId, input.skillProof!);
        this.#db.exec('COMMIT;');
      }
    } catch (error) {
      if (required) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } }
      throw error;
    }
    // create 只到 proposal persisted + validated：apply/readback 必须由本地操作者触发。
    this.#emit({
      runId: worldbookRepairRunIdOf(operationId),
      sessionId: created.sessionId,
      sourceRevision: created.sourceRevision,
      proposalId: created.proposalId,
      proposalDigest: created.proposalDigest,
      changeCount: created.changeCount,
      status: 'created',
      occurredAt: now,
    });
    return created;
  }

  readSkillProvenance(proposalId: string): MaintenanceWorldbookSkillSourceEntry | null {
    const ownsTransaction = !this.#db.isTransaction;
    if (ownsTransaction) this.#db.exec('BEGIN;');
    try {
      const entry = MaintenanceWorldbookSkillSourceStore.openExisting(this.#db, (id) => this.#readSkillNative(id))?.read(proposalId) ?? null;
      if (ownsTransaction) this.#db.exec('COMMIT;');
      return entry;
    } catch (error) {
      if (ownsTransaction) { try { this.#db.exec('ROLLBACK;'); } catch { /* preserve */ } }
      throw error;
    }
  }

  /** Original source and retained apply receipt in one committed owner snapshot. */
  readSkillApplyEvidence(proposalId: string): Readonly<{
    source: MaintenanceWorldbookSkillSourceEntry; receipt: WorldbookRepairApplyReceipt;
  }> | null {
    if (this.#db.isTransaction) throw new Error('worldbook-apply-uncommitted-read');
    this.#db.exec('BEGIN;');
    try {
      const source = this.readSkillProvenance(proposalId);
      if (!source) return null;
      const native = this.#readSkillNative(proposalId)!;
      const row = this.#db.prepare('SELECT after_raw FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId)!;
      const receipt = readWorldbookRepairApplyReceipt(this.#db, native, sha(String(row.after_raw)));
      return receipt ? Object.freeze({ source, receipt }) : null;
    } finally { this.#db.exec('ROLLBACK;'); }
  }

  scanSkillApplyEvidence(sessionId?: string, limit = 8, cursor = 0) {
    if (this.#db.isTransaction) throw new Error('worldbook-apply-uncommitted-read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error('worldbook-apply-page-invalid');
    if (sessionId !== undefined) requireSessionId(sessionId);
    if (!this.#db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(WORLDBOOK_REPAIR_APPLY_RECEIPT_TABLE))
      return Object.freeze({ entries: [], attempted: 0, nextCursor: cursor, hasMore: false });
    inspectWorldbookRepairApplyReceiptSchema(this.#db);
    const rows = this.#db.prepare(`SELECT rowid AS cursor,proposal_id,session_id FROM worldbook_repair_apply_receipt
      WHERE rowid>?${sessionId === undefined ? '' : ' AND session_id=?'} ORDER BY rowid LIMIT ?`)
      .all(...(sessionId === undefined ? [cursor, limit + 1] : [cursor, sessionId, limit + 1]));
    let nextCursor = cursor;
    const entries = rows.slice(0, limit).map(row => {
      if (!Number.isSafeInteger(row.cursor) || Number(row.cursor) <= nextCursor) throw new Error('worldbook-apply-cursor-invalid');
      nextCursor = Number(row.cursor);
      return Object.freeze({ proposalId: requireOperationId(String(row.proposal_id)), sessionId: requireSessionId(String(row.session_id)) });
    });
    return Object.freeze({ entries: Object.freeze(entries), attempted: entries.length, nextCursor, hasMore: rows.length > limit });
  }

  #readSkillNative(proposalId: string): WorldbookSkillNativeBinding | null {
    const row = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId) as StoredRow | undefined;
    if (!row) return null;
    try {
      const proposal = normalizeWorldbookRepairProposal(JSON.parse(row.proposal_json));
      if (JSON.stringify(proposal) !== row.proposal_json || worldbookRepairDigest(proposal) !== row.proposal_digest
        || row.intent_digest !== sha(JSON.stringify({ operationId: row.operation_id, proposalDigest: row.proposal_digest }))
        || !['user', 'asset'].includes(row.before_source)
        || Buffer.byteLength(row.before_raw, 'utf8') > MAX_IMAGE_BYTES || Buffer.byteLength(row.after_raw, 'utf8') > MAX_IMAGE_BYTES
        || buildAfterImage({ path: '', raw: row.before_raw, source: row.before_source, revision: proposal.expectedRevision }, proposal) !== row.after_raw
        || !DIGEST.test(row.after_revision)
        || !['pending', 'approved', 'applied', 'rejected', 'stale', 'reverted'].includes(row.status)
        || !Number.isSafeInteger(row.revision) || row.revision < (row.status === 'pending' ? 1 : 2)
        || row.status === 'pending' && row.revision !== 1
        || canonicalTimestamp(row.updated_at) < canonicalTimestamp(row.created_at)) throw new Error();
      return Object.freeze({ proposalId: row.proposal_id, operationId: row.operation_id, sessionId: proposal.sessionId,
        proposalDigest: row.proposal_digest, outerProposalDigest: maintenanceWorldbookSkillDigest({ taskKind: 'worldbook_repair', payload: proposal }),
        sourceRevision: proposal.expectedRevision, createdAt: row.created_at,
        // after_revision is the mutable adapter receipt; historical source binds only immutable native inputs.
        nativeBindingDigest: maintenanceWorldbookSkillDigest([row.proposal_id, row.operation_id, row.intent_digest,
          row.proposal_json, row.proposal_digest, row.before_raw, row.before_source, row.after_raw, row.created_at]),
        status: row.status, revision: row.revision, updatedAt: row.updated_at,
        ...(['applied', 'reverted'].includes(row.status) ? { appliedRevision: row.after_revision } : {}),
      });
    } catch { throw new Error('worldbook-skill-source-native-corrupt'); }
  }

  get(proposalId: string, includeContent = false): WorldbookRepairSummary | null {
    const row = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId) as StoredRow | undefined;
    return row ? this.#summary(row, includeContent) : null;
  }

  /**
   * Content-free by default, exact-session read model. The fixed upper bound prevents a
   * long-lived repair database from turning the Agent status endpoint into an
   * unbounded JSON/SQLite read. `includeContent` 是唯一携带变更审阅视图的通道，
   * 只应由「本机可操作」的读取路径传入（见 control-plane）。
   */
  list(sessionId: string, limit = 50, includeContent = false): readonly WorldbookRepairSummary[] {
    requireSessionId(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('worldbook-repair-list-limit-invalid');
    }
    const rows = this.#db.prepare(`SELECT * FROM worldbook_repair_proposal
      WHERE json_extract(proposal_json,'$.sessionId')=?
      ORDER BY updated_at DESC, proposal_id DESC LIMIT ?`).all(sessionId, limit) as StoredRow[];
    return Object.freeze(rows.map((row) => this.#summary(row, includeContent)));
  }

  /**
   * Privacy cleanup for one exact session namespace.
   *
   * A proposal row is also the complete repair audit receipt: `proposal_json`
   * carries the session id and patches while the same row retains the before and
   * after images. Removing the row therefore removes every session-scoped
   * proposal/audit/content reference owned by this control database. Applied
   * worldbook assets are deliberately not reverted here because they are shared
   * user assets, not session-owned storage.
   *
   * The operation is atomic and replay-safe: a second call returns zero.
   */
  deleteSession(sessionId: string): WorldbookRepairSessionDeletionResult {
    const exactSessionId = requireSessionId(sessionId);
    const result = this.#db.prepare(`DELETE FROM worldbook_repair_proposal
      WHERE json_extract(proposal_json,'$.sessionId')=?`).run(exactSessionId);
    return Object.freeze({ deletedProposals: Number(result.changes) });
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
    /** 提交之后要重新读回的目标镜像；null 表示本次转换不产生读回证据。 */
    let readbackIntent: { file: string; expectedRaw: string; expectedRevision: string } | null = null;
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.#db.prepare('SELECT * FROM worldbook_repair_proposal WHERE proposal_id=?').get(proposalId) as StoredRow | undefined;
      // apply 允许从 pending 直接执行：本地操作者在审阅弹窗里的确认动作本身即审批，
      // 不必强迫先点一次 approve 再点一次 apply（approved 仍保持可用，兼容既有流程）。
      const allowedStatuses = operation === 'apply' ? ['approved', 'pending'] : ['applied'];
      if (!row || row.revision !== expectedRevision || !allowedStatuses.includes(row.status)) {
        throw new Error('worldbook-repair-proposal-revision-conflict');
      }
      // Validate/create native receipt storage before any irreversible file replacement.
      if (operation === 'apply') {
        this.#readSkillNative(proposalId);
        this.readSkillProvenance(proposalId);
        prepareWorldbookRepairApplyReceipt(this.#db);
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
          const stale = this.get(proposalId)!;
          this.#emit({
            runId: worldbookRepairRunIdOf(stale.operationId),
            sessionId: stale.sessionId,
            sourceRevision: stale.sourceRevision,
            proposalId: stale.proposalId,
            proposalDigest: stale.proposalDigest,
            changeCount: stale.changeCount,
            status: 'stale',
            occurredAt: now,
            reasonCode: 'source-revision-drift',
          });
          return stale;
        }
        this.#db.prepare(`UPDATE worldbook_repair_proposal SET status='applied',revision=revision+1,updated_at=? WHERE proposal_id=?`)
          .run(now, proposalId);
        insertWorldbookRepairApplyReceipt(this.#db, this.#readSkillNative(proposalId)!, sha(row.after_raw));
        readbackIntent = { file: proposal.file, expectedRaw: row.after_raw, expectedRevision: row.after_revision };
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
        // revert 的读回必须等于 **before-image**：证明恢复到了当初的原状。
        readbackIntent = { file: proposal.file, expectedRaw: row.before_raw, expectedRevision: proposal.expectedRevision };
      }
      this.#db.exec('COMMIT;');
      committed = true;
      restoreDeletedOverride = null;
      const updated = this.get(proposalId)!;
      const readback = this.#readbackAfterCommit(readbackIntent);
      if (operation === 'revert') {
        // revert 更新**原链**：不新建假成功链。
        this.#emit({
          runId: worldbookRepairRunIdOf(updated.operationId),
          sessionId: updated.sessionId,
          sourceRevision: updated.sourceRevision,
          proposalId: updated.proposalId,
          proposalDigest: updated.proposalDigest,
          changeCount: updated.changeCount,
          status: 'reverted',
          occurredAt: now,
          ...(readback ? { targetRevision: readback.revision, rollbackDigest: readback.readbackDigest } : {}),
          reasonCode: 'operator-reverted',
        });
      } else {
        this.#emit({
          runId: worldbookRepairRunIdOf(updated.operationId),
          sessionId: updated.sessionId,
          sourceRevision: updated.sourceRevision,
          proposalId: updated.proposalId,
          proposalDigest: updated.proposalDigest,
          changeCount: updated.changeCount,
          status: 'applied',
          occurredAt: now,
          ...(readback ? {
            targetRevision: readback.revision,
            readbackDigest: readback.readbackDigest,
          } : {}),
        });
      }
      return updated;
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

  /**
   * 提交**之后**重新读取生效层并产出读回摘要。
   * 只有读到的字节恰好等于本次应当写入的镜像（apply=after_raw / revert=before_raw）
   * 且 revision 也吻合时才成立；否则返回 null —— fail-closed，绝不把"之后某时刻的
   * 当前状态"包装成写后回读。
   */
  #readbackAfterCommit(
    intent: { file: string; expectedRaw: string; expectedRevision: string } | null,
  ): WorldbookReadbackReceipt | null {
    if (!intent) return null;
    try {
      const asset = this.#asset.read(intent.file);
      if (!asset || asset.raw !== intent.expectedRaw || asset.revision !== intent.expectedRevision) return null;
      return worldbookReadbackOf(asset);
    } catch {
      return null;
    }
  }

  #summary(row: StoredRow, includeContent = false): WorldbookRepairSummary {
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
      // 只暴露原因码分类，不含条目正文 —— 保持 "content-free" 读模型边界。
      reasonCodes: Object.freeze([...new Set(proposal.changes.map((change) => change.reasonCode))].sort()),
      // 审阅视图只随显式请求携带；默认（含 approve/reject/apply 的返回值）不带。
      ...(includeContent ? {
        changes: Object.freeze(proposal.changes.map((change) => Object.freeze({
          entryUid: change.entryUid,
          reasonCode: change.reasonCode,
          patch: change.patch,
        }))),
      } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
