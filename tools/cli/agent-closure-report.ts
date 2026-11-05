#!/usr/bin/env node
/**
 * P16 C6 · Agent 闭环只读批量报表。
 *
 * 给人看的：一张 capability × 八步 的网格，实心 = 有证据，空心 = 没走到。
 * 给机器看的：`--json`。
 *
 * **只读铁律**（不改业务、不改账本）：
 * - 库不存在时**不创建**，只报 `present:false` 并把所有能力列成"零证据"；
 * - 通过"复制到临时目录再打开"读，绝不在真实数据根上开 WAL / 做 checkpoint / repair；
 * - schema 版本不认识就报 `readable:false`，**不迁移**；
 * - 不打印绝对路径、不打印会话 ID / operation id。
 */
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  AGENT_CLOSURE_CAPABILITIES,
  AGENT_CLOSURE_CAPABILITY_ALIASES,
  AGENT_CLOSURE_CAPABILITY_CONTRACTS,
  canonicalAgentClosureCapability,
  type AgentClosureCapability,
  type AgentClosureExecutionClass,
} from '../../packages/agent-closure/index.ts';
import {
  AGENT_CLOSURE_APPLICATION_ID,
  AGENT_CLOSURE_DB_FILE,
  AGENT_CLOSURE_SCHEMA_VERSION,
  readAgentClosureFile,
} from '../../apps/server/agent-closure-store.ts';
import { buildAgentTaskOutcome, type AgentTaskOutcomeV1 } from '../../apps/server/agent-task-outcome.ts';
import { readAqlSummaryRequestEvidenceFile } from '../../apps/server/aql-summary-request-evidence.ts';
import { readAqlReplanSkillSourceFile } from '../../apps/server/aql-replan-skill-source.ts';
import { readBranchPreferenceSkillSourceFile } from '../../apps/server/branch-preference-source-recovery.ts';
import { readStyleCompileSkillSourceFile, readStyleCompileSkillAdoptionFile }
  from '../../apps/server/style-compile-skill-source.ts';
import { readVariablePatchApplyEvidenceFile, readVariableProposalSkillReceiptFile }
  from '../../apps/server/variable-patch-apply-recovery.ts';
import { resolveSessionDatabase } from '../../apps/server/security.ts';
import {
  readSessionDeletionBlockedFile,
  sessionDeletionJournalPath,
} from '../../apps/server/session-deletion-journal.ts';
import { resolveOperationalDataDirectory } from './operational-data-root.ts';

export const AGENT_CLOSURE_REPORT_VERSION = 'p16-closure-report-v1' as const;
export const AGENT_TASK_OUTCOME_REPORT_VERSION = 'agent-task-outcome-report-v1' as const;
export const AQL_SUMMARY_REQUEST_REPORT_VERSION = 'aql-summary-request-report-v1' as const;

export interface AqlSummaryRequestReport {
  readonly version: typeof AQL_SUMMARY_REQUEST_REPORT_VERSION;
  readonly readable: boolean;
  readonly reasonCode?: 'aql-summary-request-source-unreadable';
  readonly aggregation: 'per-native-request-no-closure-or-task-join';
  readonly evidence: 'request-used-only';
  readonly adoption: 'unknown';
  readonly learningWeight: 0;
  readonly totals: Readonly<{
    complete: number; partial: number; unreadableSources: number; unreadableRecords: number; privacyExcluded: number;
  }>;
  readonly skillRequests: Readonly<{
    evidence: 'validated-advisory-request'; adoption: 'not-applicable'; learningWeight: 0;
    totals: Readonly<{ validated: number; current: number; invalidated: number;
      unreadableSources: number; unreadableRecords: number; privacyExcluded: number }>;
    recordCountUnit: 'native-skill-request';
  }>;
  readonly requestCountUnit: 'native-request';
  readonly unreadableRecordsUnit: 'native-record';
  readonly unreadableSourcesUnit: 'session-source';
  readonly privacyExcludedUnit: 'session-source';
}

export interface BranchPreferenceSourceReport {
  readonly version: 'branch-preference-source-report-v1';
  readonly readable: boolean;
  readonly evidence: 'semantic-low-event-provenance-only';
  readonly adoption: 'not-positive-profile-evidence';
  readonly learningWeight: 0;
  readonly totals: Readonly<{
    retained: number; invalidated: number; unreadableSources: number; unreadableRecords: number; privacyExcluded: number;
  }>;
  readonly recordCountUnit: 'native-source-record';
  readonly sourceCountUnit: 'session-source';
}

export interface StyleCompileSourceReport {
  readonly version: 'style-compile-source-report-v1';
  readonly readable: boolean;
  readonly evidence: 'historical-proposal-readback-only';
  readonly adoption: 'unknown';
  readonly learningWeight: 0;
  readonly totals: Readonly<{
    current: number; invalidated: number; unreadableSources: number; unreadableRecords: number; privacyExcluded: number;
  }>;
  readonly recordCountUnit: 'native-source-record';
  readonly sourceCountUnit: 'session-source';
  /** Historical use in a committed request; current does not mean enabled or quality-proven. */
  readonly adoptions: Readonly<{
    evidence: 'request-used-by-committed-turn';
    learningWeight: 0;
    totals: Readonly<{
      adopted: number; current: number; invalidated: number;
      unreadableSources: number; unreadableRecords: number; privacyExcluded: number;
    }>;
    recordCountUnit: 'committed-turn';
  }>;
}

export interface VariablePatchApplyReport {
  readonly version: 'variable-patch-apply-report-v1';
  readonly readable: boolean;
  readonly evidence: 'apply-committed-history-only';
  readonly adoption: 'applied-unknown-effect';
  readonly learningWeight: 0;
  readonly totals: Readonly<{
    current: number; invalidated: number; persistentlyInvalidated: number; superseded: number; unknown: number;
    unreadableSources: number; unreadableRecords: number; privacyExcluded: number;
  }>;
  /** Proposal-only Skill requests for the same domain; never an adoption or effect claim. */
  readonly proposalRequests: Readonly<{
    accepted: number; unreadableRecords: number; unreadableSources: number;
  }>;
  /** Exact request/candidate/native-apply links only; current state reuses the native apply view. */
  readonly skillAdoptions: Readonly<{
    adopted: number; current: number; invalidated: number; superseded: number; unknown: number;
    unreadableRecords: number; unreadableSources: number;
  }>;
  readonly recordCountUnit: 'native-apply-record';
  readonly sourceCountUnit: 'session-source';
}

export interface AgentTaskOutcomeReportRow {
  readonly capability: AgentClosureCapability;
  readonly lane: string;
  readonly kind: string;
  readonly operations: number;
  readonly axes: Readonly<{
    execution: Readonly<Record<'completed' | 'no-op' | 'failed' | 'cancelled' | 'unknown', number>>;
    verification: Readonly<Record<'validated' | 'unknown', number>>;
    commit: Readonly<Record<'committed' | 'rolled-back' | 'not-applicable' | 'unknown', number>>;
    adoption: Readonly<{
      consumed: number; unknown: number;
      validity: Readonly<Record<'invalidated' | 'not-checked', number>>;
    }>;
    effect: Readonly<{
      observed: number; unknown: number;
      independentOutcome: Readonly<{ unknown: number }>;
    }>;
  }>;
}

export interface AgentTaskOutcomeReport {
  readonly version: typeof AGENT_TASK_OUTCOME_REPORT_VERSION;
  readonly readable: boolean;
  readonly reasonCode?: string;
  readonly aggregation: 'per-operation-no-cross-run-join';
  readonly taskAttemptIdentity: 'unavailable';
  readonly rows: readonly AgentTaskOutcomeReportRow[];
  readonly totals: Readonly<{ operations: number; privacyExcluded: number }>;
}

/**
 * 报表只列**真实能力**：`AGENT_CLOSURE_CAPABILITY_ALIASES` 里的历史别名（如
 * `maintenance.branchIndex`）已折算进唯一归属，再列一行全零只会让人误以为缺能力。
 */
const REPORTED_CAPABILITIES = Object.freeze(
  AGENT_CLOSURE_CAPABILITIES.filter((capability) => !(capability in AGENT_CLOSURE_CAPABILITY_ALIASES)),
);

/** 八步与用户看到的列一一对应；每一步都要有**该事件真的落库**才算"有证据"。 */
const STEPS = Object.freeze([
  Object.freeze({ key: 'admitted', label: '准入', events: Object.freeze(['admitted']) }),
  Object.freeze({ key: 'executed', label: '执行', events: Object.freeze(['execution-completed', 'no-op-completed']) }),
  Object.freeze({ key: 'proposed', label: '提案', events: Object.freeze(['proposal-persisted']) }),
  Object.freeze({ key: 'validated', label: '校验', events: Object.freeze(['artifact-validated']) }),
  Object.freeze({ key: 'applied', label: '写入', events: Object.freeze(['apply-committed']) }),
  Object.freeze({ key: 'verified', label: '回读', events: Object.freeze(['readback-verified']) }),
  Object.freeze({ key: 'consumed', label: '被消费', events: Object.freeze(['context-consumed']) }),
  Object.freeze({ key: 'observed', label: '有效果', events: Object.freeze(['effect-observed']) }),
] as const);

export interface AgentClosureReportRow {
  readonly capability: AgentClosureCapability;
  readonly lane: string;
  readonly kind: string;
  /** 该能力历史上出现过哪些里程碑（别名已折算到唯一归属）。 */
  readonly steps: readonly boolean[];
  readonly runs: number;
  readonly byExecutionClass: Readonly<Partial<Record<AgentClosureExecutionClass, number>>>;
  readonly byStage: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly productionClosed: number;
  readonly incomplete: number;
  readonly latestAt: string | null;
}

export interface AgentClosureReport {
  readonly version: typeof AGENT_CLOSURE_REPORT_VERSION;
  readonly generatedAt: string;
  readonly dataRootSource: string;
  readonly database: Readonly<{
    readonly file: string;
    readonly present: boolean;
    readonly readable: boolean;
    readonly schemaVersion: number | null;
    readonly reasonCode?: string;
  }>;
  readonly stepLabels: readonly string[];
  readonly rows: readonly AgentClosureReportRow[];
  readonly totals: Readonly<{
    readonly runs: number;
    readonly productionClosed: number;
    readonly zeroEvidence: number;
  }>;
  /** C4 尚未实现：这里必须显式说"不可得"，不能拿 0 冒充。 */
  readonly sourceOutbox: Readonly<{ readonly available: false; readonly reasonCode: string }>;
  /** HC-4a opt-in only: original operations projected independently, never a success or authorization. */
  readonly outcomes?: AgentTaskOutcomeReport;
  /** Independent request-use history, not a Closure/Task join or assistant adoption claim. */
  readonly aqlSummaryRequests?: AqlSummaryRequestReport;
  readonly branchPreferenceSources?: BranchPreferenceSourceReport;
  readonly styleCompileSources?: StyleCompileSourceReport;
  /** Applied variable patches and verified Skill adoption links; commit history, never an effect claim. */
  readonly variablePatchApplies?: VariablePatchApplyReport;
}

type Row = Record<string, unknown>;

function integer(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只读快照：复制主库 + WAL/SHM 到临时目录再打开，真实数据根一个字节都不动。 */
function withSnapshot<T>(
  databasePath: string,
  work: (db: DatabaseSync, snapshotPath: string) => T,
  onUnreadable: (reasonCode: string) => T,
): T {
  let root: string | null = null;
  let db: DatabaseSync | null = null;
  try {
    root = mkdtempSync(join(tmpdir(), 'jg-closure-report-'));
    const copy = join(root, AGENT_CLOSURE_DB_FILE);
    copyFileSync(databasePath, copy);
    // WAL 里可能还有未 checkpoint 的事务；一起复制才能看到最新状态。
    for (const suffix of ['-wal', '-shm'] as const) {
      if (existsSync(databasePath + suffix)) copyFileSync(databasePath + suffix, copy + suffix);
    }
    db = new DatabaseSync(copy);
    const applicationId = Number((db.prepare('PRAGMA application_id').get() as Row | undefined)?.application_id);
    const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version);
    if (applicationId !== AGENT_CLOSURE_APPLICATION_ID) return onUnreadable('application-id-mismatch');
    if (schemaVersion !== 1 && schemaVersion !== AGENT_CLOSURE_SCHEMA_VERSION) return onUnreadable('schema-version-unknown');
    return work(db, copy);
  } catch {
    return onUnreadable('snapshot-read-failed');
  } finally {
    try { db?.close(); } catch { /* 只读报表不因关闭失败而失败 */ }
    if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录只增不改 */ } }
  }
}

function outcomeReport(
  projections: readonly AgentTaskOutcomeV1[],
  readable: boolean,
  reasonCode?: string,
  privacyExcluded = 0,
): AgentTaskOutcomeReport {
  const rows = REPORTED_CAPABILITIES.map((capability): AgentTaskOutcomeReportRow => {
    const contract = AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability];
    const selected = projections.filter((value) => canonicalAgentClosureCapability(value.capability) === capability);
    const execution = { completed: 0, 'no-op': 0, failed: 0, cancelled: 0, unknown: 0 };
    const verification = { validated: 0, unknown: 0 };
    const commit = { committed: 0, 'rolled-back': 0, 'not-applicable': 0, unknown: 0 };
    const adoption = { consumed: 0, unknown: 0, validity: { invalidated: 0, 'not-checked': 0 } };
    const effect = { observed: 0, unknown: 0, independentOutcome: { unknown: 0 } };
    for (const value of selected) {
      execution[value.axes.execution.state] += 1;
      verification[value.axes.verification.state] += 1;
      commit[value.axes.commit.state] += 1;
      adoption[value.axes.adoption.state] += 1;
      adoption.validity[value.axes.adoption.validity] += 1;
      effect[value.axes.effect.state] += 1;
      // Original effect observations are reported history, not independently established outcomes.
      effect.independentOutcome.unknown += 1;
    }
    return Object.freeze({
      capability, lane: contract.lane, kind: contract.kind, operations: selected.length,
      axes: Object.freeze({
        execution: Object.freeze(execution), verification: Object.freeze(verification),
        commit: Object.freeze(commit),
        adoption: Object.freeze({ ...adoption, validity: Object.freeze(adoption.validity) }),
        effect: Object.freeze({ ...effect, independentOutcome: Object.freeze(effect.independentOutcome) }),
      }),
    });
  });
  return Object.freeze({
    version: AGENT_TASK_OUTCOME_REPORT_VERSION, readable,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    aggregation: 'per-operation-no-cross-run-join', taskAttemptIdentity: 'unavailable',
    rows: Object.freeze(rows),
    totals: Object.freeze({ operations: rows.reduce((sum, row) => sum + row.operations, 0), privacyExcluded }),
  });
}

/** The SQL inventory supplies identities only; every projection requires a strict original Store read. */
function readOutcomeReport(db: DatabaseSync, snapshotPath: string, dataDir: string): AgentTaskOutcomeReport {
  try {
    const deletionFile = sessionDeletionJournalPath(dataDir);
    // Validate an existing privacy journal even when the Closure inventory is empty.
    readSessionDeletionBlockedFile(deletionFile, 'outcome-report-schema-probe');
    const inventory = db.prepare('SELECT operation_id,session_id FROM agent_closure_run ORDER BY operation_id')
      .all() as Row[];
    const projected: Array<{ sessionId: string; outcome: AgentTaskOutcomeV1 }> = [];
    let privacyExcluded = 0;
    for (const item of inventory) {
      const sessionId = stringOf(item.session_id);
      if (readSessionDeletionBlockedFile(deletionFile, sessionId)) { privacyExcluded += 1; continue; }
      const records = readAgentClosureFile(snapshotPath, {
        operationId: stringOf(item.operation_id), limit: 1,
      });
      const record = records[0];
      if (records.length !== 1 || record?.sessionId !== sessionId) throw new Error('source-record-invalid');
      projected.push({ sessionId, outcome: buildAgentTaskOutcome(record) });
    }
    // A prepared deletion is already a fence. Recheck after projection and discard all same-session contributions.
    const blocked = new Map<string, boolean>();
    for (const item of projected) {
      if (!blocked.has(item.sessionId)) blocked.set(item.sessionId, readSessionDeletionBlockedFile(deletionFile, item.sessionId));
    }
    const included = projected.filter((item) => blocked.get(item.sessionId) === false);
    return outcomeReport(included.map((item) => item.outcome), true, undefined,
      privacyExcluded + projected.length - included.length);
  } catch {
    return outcomeReport([], false, 'outcome-source-unreadable');
  }
}

/** Identify Session-shaped files only; the native reader performs the actual strict source validation. */
function isSessionSource(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0;');
    if (db.prepare('PRAGMA application_id').get()?.application_id !== 0) return false;
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_log','session_control')")
      .all().length === 2;
  } finally { db?.close(); }
}

/** Scan original managed Session receipts without creating a source or reconstructing its contents. */
function readAqlSummaryRequestsReport(dataDir: string): AqlSummaryRequestReport {
  const totals = { complete: 0, partial: 0, unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const skillRequests = { validated: 0, current: 0, invalidated: 0,
    unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const result = (readable: boolean): AqlSummaryRequestReport => Object.freeze({
    version: AQL_SUMMARY_REQUEST_REPORT_VERSION, readable,
    ...(readable ? {} : { reasonCode: 'aql-summary-request-source-unreadable' as const }),
    aggregation: 'per-native-request-no-closure-or-task-join', evidence: 'request-used-only',
    adoption: 'unknown', learningWeight: 0, totals: Object.freeze({ ...totals }),
    skillRequests: Object.freeze({ evidence: 'validated-advisory-request', adoption: 'not-applicable', learningWeight: 0,
      totals: Object.freeze({ ...skillRequests }), recordCountUnit: 'native-skill-request' }),
    requestCountUnit: 'native-request', unreadableRecordsUnit: 'native-record',
    unreadableSourcesUnit: 'session-source', privacyExcludedUnit: 'session-source',
  });
  try {
    const deletionFile = sessionDeletionJournalPath(dataDir);
    readSessionDeletionBlockedFile(deletionFile, 'aql-summary-report-schema-probe');
    if (!existsSync(dataDir)) return result(true);
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return result(false);
    const sources: Array<{ sessionId: string; complete: number; partial: number; unreadableRecords: number;
      unreadableSources: number; skillRequests: typeof skillRequests }> = [];
    for (const file of readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.db')) continue;
      const path = resolveSessionDatabase(dataDir, file.name);
      if (!path) continue;
      const sessionId = file.name.slice(0, -3);
      const allowed = (raw: string): boolean => raw === sessionId && !readSessionDeletionBlockedFile(deletionFile, raw);
      if (!allowed(sessionId)) { totals.privacyExcluded += 1; skillRequests.privacyExcluded++; continue; }
      const counts = { sessionId, complete: 0, partial: 0, unreadableRecords: 0, unreadableSources: 0,
        skillRequests: { validated: 0, current: 0, invalidated: 0, unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 } };
      try {
        if (!isSessionSource(path)) continue;
        let cursor = 0;
        while (true) {
          const page = readAqlSummaryRequestEvidenceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) throw new Error('aql-summary-report-source-unavailable');
          for (const receipt of page.entries) counts[receipt.coverage] += 1;
          counts.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('aql-summary-report-cursor-invalid');
          cursor = page.nextCursor;
        }
        cursor = 0;
        while (true) {
          const page = readAqlReplanSkillSourceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) throw new Error('aql-skill-report-source-unavailable');
          counts.skillRequests.validated += page.entries.length;
          for (const entry of page.entries) counts.skillRequests[entry.sourceValidity]++;
          counts.skillRequests.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('aql-skill-report-cursor-invalid');
          cursor = page.nextCursor;
        }
      } catch {
        counts.skillRequests = { validated: 0, current: 0, invalidated: 0,
          unreadableSources: 1, unreadableRecords: 0, privacyExcluded: 0 };
        counts.complete = 0; counts.partial = 0; counts.unreadableRecords = 0; counts.unreadableSources = 1;
      }
      sources.push(counts);
    }
    // A prepared deletion is already a fence; remove every contribution from the newly blocked source.
    for (const source of sources) {
      if (readSessionDeletionBlockedFile(deletionFile, source.sessionId)) {
        totals.privacyExcluded += 1; skillRequests.privacyExcluded++; continue;
      }
      for (const key of Object.keys(skillRequests) as Array<keyof typeof skillRequests>) {
        skillRequests[key] += source.skillRequests[key];
      }
      totals.complete += source.complete; totals.partial += source.partial;
      totals.unreadableRecords += source.unreadableRecords; totals.unreadableSources += source.unreadableSources;
    }
    return result(true);
  } catch {
    totals.complete = 0; totals.partial = 0; totals.unreadableSources = 0;
    totals.unreadableRecords = 0; totals.privacyExcluded = 0;
    for (const key of Object.keys(skillRequests) as Array<keyof typeof skillRequests>) skillRequests[key] = 0;
    return result(false);
  }
}

function readBranchPreferenceSourcesReport(dataDir: string): BranchPreferenceSourceReport {
  const totals = { retained: 0, invalidated: 0, unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const result = (readable: boolean): BranchPreferenceSourceReport => Object.freeze({
    version: 'branch-preference-source-report-v1', readable, evidence: 'semantic-low-event-provenance-only',
    adoption: 'not-positive-profile-evidence', learningWeight: 0, totals: Object.freeze({ ...totals }),
    recordCountUnit: 'native-source-record', sourceCountUnit: 'session-source',
  });
  try {
    const deletionFile = sessionDeletionJournalPath(dataDir);
    readSessionDeletionBlockedFile(deletionFile, 'branch-source-report-schema-probe');
    if (!existsSync(dataDir)) return result(true);
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return result(false);
    const sources: Array<{ sessionId: string; retained: number; invalidated: number;
      unreadableRecords: number; unreadableSources: number }> = [];
    for (const file of readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.db')) continue;
      const path = resolveSessionDatabase(dataDir, file.name);
      if (!path) continue;
      const sessionId = file.name.slice(0, -3);
      const allowed = (raw: string) => raw === sessionId && !readSessionDeletionBlockedFile(deletionFile, raw);
      if (!allowed(sessionId)) { totals.privacyExcluded++; continue; }
      const counts = { sessionId, retained: 0, invalidated: 0, unreadableRecords: 0, unreadableSources: 0 };
      try {
        if (!isSessionSource(path)) continue;
        let cursor = 0;
        while (true) {
          const page = readBranchPreferenceSkillSourceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) break;
          for (const entry of page.entries) counts[entry.state]++;
          counts.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('branch-source-report-cursor-invalid');
          cursor = page.nextCursor;
        }
      } catch { counts.retained = 0; counts.invalidated = 0; counts.unreadableRecords = 0; counts.unreadableSources = 1; }
      sources.push(counts);
    }
    for (const source of sources) {
      if (readSessionDeletionBlockedFile(deletionFile, source.sessionId)) { totals.privacyExcluded++; continue; }
      totals.retained += source.retained; totals.invalidated += source.invalidated;
      totals.unreadableRecords += source.unreadableRecords; totals.unreadableSources += source.unreadableSources;
    }
    return result(true);
  } catch {
    totals.retained = 0; totals.invalidated = 0; totals.unreadableRecords = 0;
    totals.unreadableSources = 0; totals.privacyExcluded = 0;
    return result(false);
  }
}

function readStyleCompileSourcesReport(dataDir: string): StyleCompileSourceReport {
  const totals = { current: 0, invalidated: 0, unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const adoptions = { adopted: 0, current: 0, invalidated: 0,
    unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const result = (readable: boolean): StyleCompileSourceReport => Object.freeze({
    version: 'style-compile-source-report-v1', readable, evidence: 'historical-proposal-readback-only',
    adoption: 'unknown', learningWeight: 0, totals: Object.freeze({ ...totals }),
    recordCountUnit: 'native-source-record', sourceCountUnit: 'session-source',
    adoptions: Object.freeze({ evidence: 'request-used-by-committed-turn', learningWeight: 0,
      totals: Object.freeze({ ...adoptions }), recordCountUnit: 'committed-turn' }),
  });
  try {
    const deletionFile = sessionDeletionJournalPath(dataDir);
    readSessionDeletionBlockedFile(deletionFile, 'style-compile-source-report-schema-probe');
    if (!existsSync(dataDir)) return result(true);
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return result(false);
    const sources: Array<{ sessionId: string; current: number; invalidated: number;
      unreadableRecords: number; unreadableSources: number; adoptions: typeof adoptions }> = [];
    for (const file of readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.db')) continue;
      const path = resolveSessionDatabase(dataDir, file.name);
      if (!path) continue;
      const sessionId = file.name.slice(0, -3);
      const allowed = (raw: string) => raw === sessionId && !readSessionDeletionBlockedFile(deletionFile, raw);
      if (!allowed(sessionId)) { totals.privacyExcluded++; adoptions.privacyExcluded++; continue; }
      const counts = { sessionId, current: 0, invalidated: 0, unreadableRecords: 0, unreadableSources: 0,
        adoptions: { adopted: 0, current: 0, invalidated: 0,
          unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 } };
      try {
        if (!isSessionSource(path)) continue;
        let cursor = 0;
        while (true) {
          const page = readStyleCompileSkillSourceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) throw new Error('style-compile-source-report-source-unavailable');
          for (const entry of page.entries) counts[entry.sourceValidity]++;
          counts.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('style-compile-source-report-cursor-invalid');
          cursor = page.nextCursor;
        }
        cursor = 0;
        while (true) {
          const page = readStyleCompileSkillAdoptionFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) throw new Error('style-compile-adoption-report-source-unavailable');
          counts.adoptions.adopted += page.entries.length;
          for (const entry of page.entries) {
            const validity = entry.consumerValidity === 'current' && entry.sourceValidity === 'current'
              ? 'current' : 'invalidated';
            counts.adoptions[validity]++;
          }
          counts.adoptions.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('style-compile-adoption-report-cursor-invalid');
          cursor = page.nextCursor;
        }
      } catch {
        counts.current = 0; counts.invalidated = 0; counts.unreadableRecords = 0; counts.unreadableSources = 1;
        counts.adoptions = { adopted: 0, current: 0, invalidated: 0,
          unreadableSources: 1, unreadableRecords: 0, privacyExcluded: 0 };
      }
      sources.push(counts);
    }
    for (const source of sources) {
      if (readSessionDeletionBlockedFile(deletionFile, source.sessionId)) {
        totals.privacyExcluded++; adoptions.privacyExcluded++; continue;
      }
      totals.current += source.current; totals.invalidated += source.invalidated;
      totals.unreadableRecords += source.unreadableRecords; totals.unreadableSources += source.unreadableSources;
      adoptions.adopted += source.adoptions.adopted; adoptions.current += source.adoptions.current;
      adoptions.invalidated += source.adoptions.invalidated;
      adoptions.unreadableRecords += source.adoptions.unreadableRecords;
      adoptions.unreadableSources += source.adoptions.unreadableSources;
    }
    return result(true);
  } catch {
    totals.current = 0; totals.invalidated = 0; totals.unreadableRecords = 0;
    totals.unreadableSources = 0; totals.privacyExcluded = 0;
    for (const key of Object.keys(adoptions) as Array<keyof typeof adoptions>) adoptions[key] = 0;
    return result(false);
  }
}

export function readVariablePatchApplyReport(dataDir: string): VariablePatchApplyReport {
  const totals = { current: 0, invalidated: 0, persistentlyInvalidated: 0, superseded: 0, unknown: 0,
    unreadableSources: 0, unreadableRecords: 0, privacyExcluded: 0 };
  const requests = { accepted: 0, unreadableRecords: 0, unreadableSources: 0 };
  const skillAdoptions = { adopted: 0, current: 0, invalidated: 0, superseded: 0, unknown: 0,
    unreadableRecords: 0, unreadableSources: 0 };
  const result = (readable: boolean): VariablePatchApplyReport => Object.freeze({
    version: 'variable-patch-apply-report-v1', readable, evidence: 'apply-committed-history-only',
    adoption: 'applied-unknown-effect', learningWeight: 0, totals: Object.freeze({ ...totals }),
    proposalRequests: Object.freeze({ ...requests }),
    skillAdoptions: Object.freeze({ ...skillAdoptions }),
    recordCountUnit: 'native-apply-record', sourceCountUnit: 'session-source',
  });
  try {
    const deletionFile = sessionDeletionJournalPath(dataDir);
    readSessionDeletionBlockedFile(deletionFile, 'variable-patch-apply-report-schema-probe');
    if (!existsSync(dataDir)) return result(true);
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return result(false);
    const sources: Array<{ sessionId: string; current: number; invalidated: number; persistentlyInvalidated: number;
      superseded: number; unknown: number; unreadableRecords: number; unreadableSources: number;
      requests: typeof requests; skillAdoptions: typeof skillAdoptions }> = [];
    for (const file of readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.db')) continue;
      const path = resolveSessionDatabase(dataDir, file.name);
      if (!path) continue;
      const sessionId = file.name.slice(0, -3);
      const allowed = (raw: string) => raw === sessionId && !readSessionDeletionBlockedFile(deletionFile, raw);
      if (!allowed(sessionId)) { totals.privacyExcluded++; continue; }
      const counts = { sessionId, current: 0, invalidated: 0, persistentlyInvalidated: 0, superseded: 0,
        unknown: 0, unreadableRecords: 0, unreadableSources: 0,
        requests: { accepted: 0, unreadableRecords: 0, unreadableSources: 0 },
        skillAdoptions: { adopted: 0, current: 0, invalidated: 0, superseded: 0, unknown: 0,
          unreadableRecords: 0, unreadableSources: 0 } };
      try {
        if (!isSessionSource(path)) continue;
        const applyPages: Array<{ cursor: number; snapshot: string }> = [];
        const requestPages: Array<{ cursor: number; snapshot: string }> = [];
        let currentSnapshot: string | null | undefined;
        let cursor = 0;
        while (true) {
          if (applyPages.length >= 256) throw new Error('variable-patch-apply-report-page-limit');
          const page = readVariablePatchApplyEvidenceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor });
          if (!page) throw new Error('variable-patch-apply-report-source-unavailable');
          if (currentSnapshot !== undefined && page.currentSnapshotDigest !== currentSnapshot)
            throw new Error('variable-patch-apply-report-snapshot-drift');
          currentSnapshot = page.currentSnapshotDigest;
          applyPages.push({ cursor, snapshot: createHash('sha256').update(JSON.stringify(page)).digest('hex') });
          for (const entry of page.entries) {
            counts[entry.state]++;
            if (entry.skillAdoption) {
              counts.skillAdoptions.adopted++;
              counts.skillAdoptions[entry.state]++;
            }
          }
          counts.skillAdoptions.unreadableRecords += page.skillAdoptionFailed;
          counts.persistentlyInvalidated += page.entries.filter((entry) => entry.persistentInvalidation).length;
          counts.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error('variable-patch-apply-report-cursor-invalid');
          cursor = page.nextCursor;
        }
        let requestCursor = 0;
        while (true) {
          if (requestPages.length >= 256) throw new Error('variable-proposal-report-page-limit');
          const page = readVariableProposalSkillReceiptFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor: requestCursor });
          if (!page) throw new Error('variable-proposal-report-source-unavailable');
          requestPages.push({ cursor: requestCursor, snapshot: createHash('sha256').update(JSON.stringify(page)).digest('hex') });
          counts.requests.accepted += page.accepted;
          counts.requests.unreadableRecords += page.failed;
          if (!page.hasMore) break;
          if (page.nextCursor <= requestCursor) throw new Error('variable-proposal-report-cursor-invalid');
          requestCursor = page.nextCursor;
        }
        for (const captured of applyPages) {
          const page = readVariablePatchApplyEvidenceFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor: captured.cursor });
          if (!page || createHash('sha256').update(JSON.stringify(page)).digest('hex') !== captured.snapshot)
            throw new Error('variable-patch-apply-report-page-drift');
        }
        for (const captured of requestPages) {
          const page = readVariableProposalSkillReceiptFile({ path, rawSessionId: sessionId, allowed, limit: 100, cursor: captured.cursor });
          if (!page || createHash('sha256').update(JSON.stringify(page)).digest('hex') !== captured.snapshot)
            throw new Error('variable-proposal-report-page-drift');
        }
      } catch {
        counts.current = 0; counts.invalidated = 0; counts.persistentlyInvalidated = 0;
        counts.superseded = 0; counts.unknown = 0;
        counts.unreadableRecords = 0; counts.unreadableSources = 1;
        counts.requests = { accepted: 0, unreadableRecords: 0, unreadableSources: 1 };
        counts.skillAdoptions = { adopted: 0, current: 0, invalidated: 0, superseded: 0, unknown: 0,
          unreadableRecords: 0, unreadableSources: 1 };
      }
      sources.push(counts);
    }
    for (const source of sources) {
      if (readSessionDeletionBlockedFile(deletionFile, source.sessionId)) { totals.privacyExcluded++; continue; }
      totals.current += source.current; totals.invalidated += source.invalidated;
      totals.persistentlyInvalidated += source.persistentlyInvalidated;
      totals.superseded += source.superseded; totals.unknown += source.unknown;
      totals.unreadableRecords += source.unreadableRecords; totals.unreadableSources += source.unreadableSources;
      requests.accepted += source.requests.accepted;
      requests.unreadableRecords += source.requests.unreadableRecords;
      requests.unreadableSources += source.requests.unreadableSources;
      for (const field of Object.keys(skillAdoptions) as Array<keyof typeof skillAdoptions>) {
        skillAdoptions[field] += source.skillAdoptions[field];
      }
    }
    return result(true);
  } catch {
    totals.current = 0; totals.invalidated = 0; totals.persistentlyInvalidated = 0;
    totals.superseded = 0; totals.unknown = 0;
    totals.unreadableRecords = 0; totals.unreadableSources = 0; totals.privacyExcluded = 0;
    requests.accepted = 0; requests.unreadableRecords = 0; requests.unreadableSources = 0;
    for (const field of Object.keys(skillAdoptions) as Array<keyof typeof skillAdoptions>) skillAdoptions[field] = 0;
    return result(false);
  }
}

export function buildAgentClosureReport(options: {
  readonly dataDir: string;
  readonly dataRootSource: string;
  readonly now?: () => string;
  readonly includeOutcomes?: boolean;
  readonly includeAqlSummaryRequests?: boolean;
  readonly includeBranchPreferenceSources?: boolean;
  readonly includeStyleCompileSources?: boolean;
  readonly includeVariablePatchApplies?: boolean;
}): AgentClosureReport {
  const now = options.now ?? (() => new Date().toISOString());
  const databasePath = join(options.dataDir, AGENT_CLOSURE_DB_FILE);
  const fileExists = existsSync(databasePath) && lstatSync(databasePath).isFile();

  const emptyReport = (reasonCode?: string, present = false): AgentClosureReport => {
    const rows: AgentClosureReportRow[] = REPORTED_CAPABILITIES.map((capability) => {
      const contract = AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability];
      return Object.freeze({
        capability, lane: contract.lane, kind: contract.kind,
        steps: Object.freeze(STEPS.map(() => false)),
        runs: 0, byExecutionClass: Object.freeze({}), byStage: Object.freeze({}), byStatus: Object.freeze({}),
        productionClosed: 0, incomplete: 0, latestAt: null,
      });
    });
    return Object.freeze({
      version: AGENT_CLOSURE_REPORT_VERSION,
      generatedAt: now(),
      dataRootSource: options.dataRootSource,
      database: Object.freeze({
        file: basename(databasePath), present, readable: false,
        schemaVersion: null, ...(reasonCode === undefined ? {} : { reasonCode }),
      }),
      stepLabels: Object.freeze(STEPS.map((step) => step.label)),
      rows: Object.freeze(rows),
      totals: Object.freeze({ runs: 0, productionClosed: 0, zeroEvidence: rows.length }),
      sourceOutbox: Object.freeze({
        available: false as const, reasonCode: 'source-outbox-not-implemented-c4',
      }),
      ...(options.includeOutcomes ? {
        outcomes: outcomeReport([], false, present ? 'outcome-source-unreadable' : 'outcome-source-absent'),
      } : {}),
      ...(options.includeAqlSummaryRequests ? { aqlSummaryRequests: readAqlSummaryRequestsReport(options.dataDir) } : {}),
      ...(options.includeBranchPreferenceSources ? { branchPreferenceSources: readBranchPreferenceSourcesReport(options.dataDir) } : {}),
      ...(options.includeStyleCompileSources ? { styleCompileSources: readStyleCompileSourcesReport(options.dataDir) } : {}),
      ...(options.includeVariablePatchApplies ? { variablePatchApplies: readVariablePatchApplyReport(options.dataDir) } : {}),
    });
  };

  if (!fileExists) return emptyReport(undefined, false);

  return withSnapshot<AgentClosureReport>(databasePath, (db, snapshotPath): AgentClosureReport => {
    const runRows = db.prepare(`SELECT capability,execution_class,current_stage,status,
        COUNT(*) n,SUM(production_closed) closed,MAX(updated_at) latest
      FROM agent_closure_run GROUP BY capability,execution_class,current_stage,status`).all() as Row[];
    const eventRows = db.prepare(`SELECT r.capability capability,e.event_type event_type,COUNT(*) n
      FROM agent_closure_run r JOIN agent_closure_event e ON e.operation_id=r.operation_id
      GROUP BY r.capability,e.event_type`).all() as Row[];

    type Acc = {
      runs: number; closed: number; byExecutionClass: Record<string, number>;
      byStage: Record<string, number>; byStatus: Record<string, number>;
      present: Set<string>; latest: string | null;
    };
    const acc = new Map<AgentClosureCapability, Acc>();
    const slot = (capability: AgentClosureCapability): Acc => {
      const found = acc.get(capability);
      if (found) return found;
      const created: Acc = {
        runs: 0, closed: 0, byExecutionClass: {}, byStage: {}, byStatus: {},
        present: new Set<string>(), latest: null,
      };
      acc.set(capability, created);
      return created;
    };
    for (const row of runRows) {
      // 别名折算到唯一归属：`maintenance.branchIndex` 与 `maintenance.arc` 只能进同一个分母。
      const capability = canonicalAgentClosureCapability(stringOf(row.capability));
      const bucket = slot(capability);
      const n = integer(row.n);
      bucket.runs += n;
      bucket.closed += integer(row.closed);
      const klass = stringOf(row.execution_class);
      const stage = stringOf(row.current_stage);
      const status = stringOf(row.status);
      bucket.byExecutionClass[klass] = (bucket.byExecutionClass[klass] ?? 0) + n;
      bucket.byStage[stage] = (bucket.byStage[stage] ?? 0) + n;
      bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + n;
      const latest = stringOf(row.latest);
      if (latest && (bucket.latest === null || latest > bucket.latest)) bucket.latest = latest;
    }
    for (const row of eventRows) {
      const bucket = slot(canonicalAgentClosureCapability(stringOf(row.capability)));
      bucket.present.add(stringOf(row.event_type));
    }

    const rows: AgentClosureReportRow[] = REPORTED_CAPABILITIES.map((capability) => {
      const contract = AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability];
      const bucket = acc.get(capability);
      const present = bucket?.present ?? new Set<string>();
      const runs = bucket?.runs ?? 0;
      const incomplete = runs - (bucket?.closed ?? 0);
      return Object.freeze({
        capability, lane: contract.lane, kind: contract.kind,
        steps: Object.freeze(STEPS.map((step) => step.events.some((event) => present.has(event)))),
        runs,
        byExecutionClass: Object.freeze(bucket?.byExecutionClass ?? {}),
        byStage: Object.freeze(bucket?.byStage ?? {}),
        byStatus: Object.freeze(bucket?.byStatus ?? {}),
        productionClosed: bucket?.closed ?? 0,
        incomplete: incomplete < 0 ? 0 : incomplete,
        latestAt: bucket?.latest ?? null,
      });
    });

    return Object.freeze({
      version: AGENT_CLOSURE_REPORT_VERSION,
      generatedAt: now(),
      dataRootSource: options.dataRootSource,
      database: Object.freeze({
        file: basename(databasePath), present: true, readable: true,
        schemaVersion: Number((db.prepare('PRAGMA user_version').get() as Row).user_version),
      }),
      stepLabels: Object.freeze(STEPS.map((step) => step.label)),
      rows: Object.freeze(rows),
      totals: Object.freeze({
        runs: rows.reduce((sum, row) => sum + row.runs, 0),
        productionClosed: rows.reduce((sum, row) => sum + row.productionClosed, 0),
        zeroEvidence: rows.filter((row) => row.runs === 0).length,
      }),
      sourceOutbox: Object.freeze({
        available: false as const, reasonCode: 'source-outbox-not-implemented-c4',
      }),
      ...(options.includeOutcomes ? { outcomes: readOutcomeReport(db, snapshotPath, options.dataDir) } : {}),
      ...(options.includeAqlSummaryRequests ? { aqlSummaryRequests: readAqlSummaryRequestsReport(options.dataDir) } : {}),
      ...(options.includeBranchPreferenceSources ? { branchPreferenceSources: readBranchPreferenceSourcesReport(options.dataDir) } : {}),
      ...(options.includeStyleCompileSources ? { styleCompileSources: readStyleCompileSourcesReport(options.dataDir) } : {}),
      ...(options.includeVariablePatchApplies ? { variablePatchApplies: readVariablePatchApplyReport(options.dataDir) } : {}),
    });
  }, (reasonCode) => emptyReport(reasonCode, true));
}

/** 人类可读网格：列就是八步，实心 = 该里程碑真的落过库。 */
export function renderAgentClosureReport(report: AgentClosureReport): string {
  const out: string[] = [];
  const fill = '■';
  const blank = '·';
  const capabilityWidth = Math.max(
    ...report.rows.map((row) => row.capability.length),
    'capability'.length,
  );
  const head = `${'capability'.padEnd(capabilityWidth)}  ${'lane'.padEnd(11)} `
    + report.stepLabels.map((label) => label.padEnd(label.length + (label.length < 3 ? 1 : 0))).join(' ')
    + '   运行  生产闭环  未完成  最近活动';
  out.push(head);
  for (const row of report.rows) {
    const steps = row.steps.map((done, index) => {
      const label = report.stepLabels[index]!;
      return (done ? fill : blank).padEnd(label.length >= 3 ? label.length + 1 : 3);
    }).join('');
    out.push(
      `${row.capability.padEnd(capabilityWidth)}  ${row.lane.padEnd(11)} ${steps}`
      + `${String(row.runs).padStart(5)}${String(row.productionClosed).padStart(10)}`
      + `${String(row.incomplete).padStart(8)}  ${row.latestAt ?? '—'}`,
    );
  }
  const zero = report.rows.filter((row) => row.runs === 0).map((row) => row.capability);
  out.push('');
  out.push(`${fill} = 有该里程碑的落库证据；${blank} = 没走到。别名已折算到唯一归属，分母不会双计。`);
  out.push(`数据源：${report.dataRootSource}；库 ${report.database.file}`
    + `（present=${report.database.present} readable=${report.database.readable}`
    + `${report.database.reasonCode ? ` reason=${report.database.reasonCode}` : ''}）`);
  out.push(`合计：运行 ${report.totals.runs}，生产闭环 ${report.totals.productionClosed}，零证据能力 ${report.totals.zeroEvidence}`);
  out.push(`source outbox：不可得（${report.sourceOutbox.reasonCode}）——C4 未实现前不能拿 0 冒充。`);
  if (zero.length > 0) out.push(`零证据能力（**不隐藏**）：${zero.join('、')}`);
  if (report.outcomes) {
    out.push('');
    out.push(`Task Outcome 只读投影：readable=${report.outcomes.readable}`
      + `${report.outcomes.reasonCode ? ` reason=${report.outcomes.reasonCode}` : ''}`
      + `；独立 operation ${report.outcomes.totals.operations}`
      + `；隐私排除 ${report.outcomes.totals.privacyExcluded}；不跨 run 拼接，Task/Attempt 身份不可得。`);
    for (const row of report.outcomes.rows) {
      const axes = row.axes;
      out.push(`${row.capability}：operations=${row.operations}`
        + ` execution=${JSON.stringify(axes.execution)} verification=${JSON.stringify(axes.verification)}`
        + ` commit=${JSON.stringify(axes.commit)} adoption=${JSON.stringify(axes.adoption)}`
        + ` effect=${JSON.stringify(axes.effect)}`);
    }
    out.push('五轴独立计数；unknown 不等于成功，not-applicable 仅表示 advisory 无业务写入；不授予执行或晋级资格。');
  }
  if (report.aqlSummaryRequests) {
    const requests = report.aqlSummaryRequests;
    out.push('');
    out.push(`AQL Summary requests：readable=${requests.readable}`
      + `${requests.reasonCode ? ` reason=${requests.reasonCode}` : ''}；${JSON.stringify(requests.totals)}`);
    out.push('request-used-only；complete/partial 按原生请求计；unreadableRecords 按坏行计，'
      + 'unreadableSources/privacyExcluded 按 Session source 计；adoption=unknown，learningWeight=0；不拼接 Closure/Task。');
    out.push(`AQL Skill requests：${JSON.stringify(requests.skillRequests.totals)}`);
    out.push('validated-advisory-request；adoption=not-applicable，learningWeight=0；不代表建议进入后续剧情。');
  }
  if (report.branchPreferenceSources) {
    const source = report.branchPreferenceSources;
    out.push('');
    out.push(`BranchPreference sources：readable=${source.readable}；${JSON.stringify(source.totals)}`);
    out.push('semantic-low-event-provenance-only；retained/invalidated/unreadableRecords按原生记录计，'
      + 'unreadableSources/privacyExcluded按Session source计；不计入正样本、剧情采用或Closure闭环，learningWeight=0。');
  }
  if (report.variablePatchApplies) {
    const applied = report.variablePatchApplies;
    out.push('');
    out.push(`Variable patch applies：readable=${applied.readable}；${JSON.stringify(applied.totals)}`);
    out.push(`Variable proposal Skill adoptions：${JSON.stringify(applied.skillAdoptions)}`);
    out.push('apply-committed-history-only；current/invalidated/superseded 由原变量快照摘要判定，'
      + 'persistentlyInvalidated 是原Session回滚事务写下的持久标记（后续回合改回原值也不能抹掉）；'
      + '不含变量名/值/operationKey，effect=unknown，不授执行或晋级权。');
  }
  if (report.styleCompileSources) {
    const source = report.styleCompileSources;
    out.push('');
    out.push(`StyleCompile sources：readable=${source.readable}；${JSON.stringify(source.totals)}`);
    out.push('historical-proposal-readback-only；current/invalidated仅描述原来源有效性，不代表提案当前启用或剧情采用；'
      + '记录与Session source分别计数，adoption=unknown，learningWeight=0，不授发布权。');
    out.push(`StyleCompile adoptions：${JSON.stringify(source.adoptions.totals)}`);
    out.push('request-used-by-committed-turn；按成功提交回合计数，current仅表示原来源和消费回执仍有效，'
      + '不代表提案当前启用或文风质量，learningWeight=0。');
  }
  return out.join('\n');
}

function main(argv: readonly string[]): number {
  let explicit: string | undefined;
  let json = false;
  let includeOutcomes = false;
  let includeAqlSummaryRequests = false;
  let includeBranchPreferenceSources = false;
  let includeStyleCompileSources = false;
  let includeVariablePatchApplies = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--outcomes') { includeOutcomes = true; continue; }
    if (arg === '--aql-summary-requests') { includeAqlSummaryRequests = true; continue; }
    if (arg === '--branch-preference-sources') { includeBranchPreferenceSources = true; continue; }
    if (arg === '--style-compile-sources') { includeStyleCompileSources = true; continue; }
    if (arg === '--variable-patch-applies') { includeVariablePatchApplies = true; continue; }
    if (arg === '--data-dir') { explicit = argv[index + 1]; index += 1; continue; }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法：pnpm p16:closure-report [--data-dir <dir>] [--json] [--outcomes] [--aql-summary-requests] [--branch-preference-sources] [--style-compile-sources] [--variable-patch-applies]\n');
      return 0;
    }
    process.stderr.write(`未知参数: ${arg}\n`);
    return 2;
  }
  const root = resolveOperationalDataDirectory({ explicit });
  const report = buildAgentClosureReport({
    dataDir: root.path, dataRootSource: root.source, includeOutcomes, includeAqlSummaryRequests,
    includeBranchPreferenceSources,
    includeStyleCompileSources,
    includeVariablePatchApplies,
  });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderAgentClosureReport(report)}\n`);
  return 0;
}

if (process.argv[1] && basename(process.argv[1]).startsWith('agent-closure-report')) {
  process.exitCode = main(process.argv.slice(2));
}
