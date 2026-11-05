/** @author Codex @date 2026-10-27 @version 1.0
 * Body-free AQL Summary request-use observations are not assistant adoption or execution authority.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import { buildAqlReplanRequest } from '../../packages/agent-policy/public/aql-replan-request.ts';
import { parseAqlReplanOutput } from '../../packages/agent-policy/public/aql-replan-output.ts';
import { MemoryDb, inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { SUMMARY_CURRENT_OWNER_KEY } from '../../packages/memory/public/maintenance-summary-consumption-outbox.ts';
import { opaqueLearningToken } from '../../packages/memory/public/learning-outbox.ts';
import type { ChatRequest } from '../../packages/proxy/public/client.ts';
import { MemorySummaryMaintenanceCommitter, type MaintenanceRollingSummaryCurrentSnapshot,
    type MaintenanceRollingSummaryCurrentLineage } from './memory-summary-maintenance-committer.ts';

export const AQL_SUMMARY_REQUEST_EVIDENCE_PREFIX = 'aql_summary_request_evidence:';
export const AQL_SUMMARY_REQUEST_EVIDENCE_VERSION = 'aql-summary-request-evidence-v1' as const;
declare const CAPTURE_BRAND: unique symbol;
export interface AqlSummaryRequestEvidenceCapture { readonly [CAPTURE_BRAND]: true; }
export interface AqlSummaryRequestEvidenceReceipt {
    readonly version: typeof AQL_SUMMARY_REQUEST_EVIDENCE_VERSION;
    readonly state: 'request-used';
    readonly sessionId: string;
    readonly consumer: Readonly<{ runId: string; round: number; contentMode: 'nsf' | 'nsfw'; sourceRevision: string }>;
    readonly source: Readonly<MaintenanceRollingSummaryCurrentLineage & { revision: string }>;
    readonly coverage: 'complete' | 'partial';
    readonly inputDigest: string;
    readonly renderedSummaryDigest: string;
    readonly requestDigest: string;
    readonly outputDigest: string;
    readonly occurredAt: string;
    readonly assistantAdopted: false;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly receiptDigest: string;
}
export interface AqlSummaryRequestEvidencePage {
    readonly version: 'aql-summary-request-evidence-page-v1';
    readonly entries: readonly AqlSummaryRequestEvidenceReceipt[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}
interface Captured {
    readonly rawSessionId: string;
    readonly consumer: AqlSummaryRequestEvidenceReceipt['consumer'];
    readonly prompt: string;
    readonly renderedSummary: string;
    readonly coverage: AqlSummaryRequestEvidenceReceipt['coverage'];
    readonly memory: MemoryDb;
    readonly committer: MemorySummaryMaintenanceCommitter;
    readonly snapshot: MaintenanceRollingSummaryCurrentSnapshot;
    readonly generation: string;
    readonly isCurrent: () => boolean;
}
const CAPTURED = new WeakMap<object, Captured>();
const COMMIT_ATTEMPTED = new WeakSet<object>();
const READ_CURRENT = MemorySummaryMaintenanceCommitter.prototype.readCurrentRollingSummary;
const READ_LINEAGE = MemorySummaryMaintenanceCommitter.prototype.readSummaryRetrievalLineageInTransaction;
const ASSERT_BINDING = MemorySummaryMaintenanceCommitter.prototype.assertRollingSummarySessionBinding;
const READ_AUTHORITY = MemoryDb.prototype.readSessionAuthority;
const MAX_RECORD_CHARS = 16_384;
const SOURCE_KEYS = ['runId', 'sourceRevision', 'proposalDigest', 'targetRevision', 'intentDigest',
    'operationDigest', 'truthVersion', 'historyEpoch', 'throughRound', 'summaryDigest', 'committedAt',
    'verifiedAt', 'readbackDigest', 'revision'] as const;
const RECEIPT_KEYS = ['version', 'state', 'sessionId', 'consumer', 'source', 'coverage', 'inputDigest',
    'renderedSummaryDigest', 'requestDigest', 'outputDigest', 'occurredAt', 'assistantAdopted',
    'authorizesExecution', 'authorizesPromotion', 'receiptDigest'] as const;
function invalid(): never { throw new Error('aql-summary-request-evidence-invalid'); }
function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function key(runId: string): string { return AQL_SUMMARY_REQUEST_EVIDENCE_PREFIX + digest([runId]).slice(7); }
function positive(value: unknown, minimum = 1): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
    return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((name) => {
        const descriptor = descriptors[name];
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
    })) invalid();
    return value as Record<string, unknown>;
}
function normalize(value: unknown, rawSessionId: string): AqlSummaryRequestEvidenceReceipt {
    const row = exact(value, RECEIPT_KEYS), used = exact(row.consumer, ['runId', 'round', 'contentMode', 'sourceRevision']);
    const source = exact(row.source, SOURCE_KEYS);
    if (row.version !== AQL_SUMMARY_REQUEST_EVIDENCE_VERSION || row.state !== 'request-used'
        || row.sessionId !== opaqueLearningToken('session', rawSessionId)
        || !['nsf', 'nsfw'].includes(used.contentMode as string)
        || !['complete', 'partial'].includes(row.coverage as string)
        || row.assistantAdopted !== false || row.authorizesExecution !== false || row.authorizesPromotion !== false
        || typeof source.runId !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(source.runId)) invalid();
    const consumer = Object.freeze({ runId: agentClosureToken(used.runId as string, 'aql-consumer-run'),
        round: positive(used.round), contentMode: used.contentMode as 'nsf' | 'nsfw',
        sourceRevision: agentClosureToken(used.sourceRevision as string, 'aql-consumer-source') });
    const lineage = Object.freeze({ runId: source.runId,
        sourceRevision: agentClosureToken(source.sourceRevision as string, 'aql-summary-source'),
        proposalDigest: agentClosureDigest(source.proposalDigest as string, 'aql-summary-proposal'),
        targetRevision: agentClosureDigest(source.targetRevision as string, 'aql-summary-target'),
        intentDigest: agentClosureDigest(source.intentDigest as string, 'aql-summary-intent'),
        operationDigest: agentClosureDigest(source.operationDigest as string, 'aql-summary-operation'),
        truthVersion: positive(source.truthVersion), historyEpoch: positive(source.historyEpoch, 0),
        throughRound: positive(source.throughRound),
        summaryDigest: agentClosureDigest(source.summaryDigest as string, 'aql-summary-content'),
        committedAt: agentClosureTimestamp(source.committedAt as string, 'aql-summary-committed'),
        verifiedAt: agentClosureTimestamp(source.verifiedAt as string, 'aql-summary-verified'),
        readbackDigest: agentClosureDigest(source.readbackDigest as string, 'aql-summary-readback'),
        revision: agentClosureDigest(source.revision as string, 'aql-summary-revision') });
    const occurredAt = agentClosureTimestamp(row.occurredAt as string, 'aql-summary-request-at');
    if (lineage.verifiedAt < lineage.committedAt || occurredAt < lineage.verifiedAt
        || consumer.round < lineage.throughRound || consumer.runId === lineage.runId) invalid();
    const owner = { version: 'maintenance-summary-current-owner-v1', runId: lineage.runId,
        intentDigest: lineage.intentDigest, operationDigest: lineage.operationDigest,
        targetRevision: lineage.targetRevision, summaryDigest: lineage.summaryDigest,
        throughRound: lineage.throughRound, historyEpoch: lineage.historyEpoch };
    const { revision, ...originalLineage } = lineage;
    if (revision !== digest({ version: 'maintenance-rolling-summary-current-revision-v1', owner,
        lineage: originalLineage })) invalid();
    const base = { version: AQL_SUMMARY_REQUEST_EVIDENCE_VERSION, state: 'request-used' as const,
        sessionId: row.sessionId as string, consumer, source: lineage,
        coverage: row.coverage as 'complete' | 'partial',
        inputDigest: agentClosureDigest(row.inputDigest as string, 'aql-input'),
        renderedSummaryDigest: agentClosureDigest(row.renderedSummaryDigest as string, 'aql-rendered-summary'),
        requestDigest: agentClosureDigest(row.requestDigest as string, 'aql-request'),
        outputDigest: agentClosureDigest(row.outputDigest as string, 'aql-output'), occurredAt,
        assistantAdopted: false as const, authorizesExecution: false as const, authorizesPromotion: false as const };
    if (row.receiptDigest !== digest(base)) invalid();
    return Object.freeze({ ...base, receiptDigest: row.receiptDigest as string });
}
function current(binding: Captured): boolean {
    try {
        if (binding.isCurrent() !== true || binding.memory.db.isTransaction !== false
            || READ_AUTHORITY.call(binding.memory).generation !== binding.generation) return false;
        ASSERT_BINDING.call(binding.committer, binding.rawSessionId, binding.memory);
        const next = READ_CURRENT.call(binding.committer);
        return next !== null && JSON.stringify(next) === JSON.stringify(binding.snapshot)
            && READ_AUTHORITY.call(binding.memory).generation === binding.generation && binding.isCurrent() === true;
    } catch { return false; }
}

/** Capture only proven current ownership; capture itself writes no durable fact. */
export function captureAqlSummaryRequestEvidence(input: {
    readonly rawSessionId: string; readonly runId: string; readonly round: number;
    readonly contentMode: 'nsf' | 'nsfw'; readonly sourceRevision: string;
    readonly prompt: string; readonly renderedSummary: string; readonly memory: MemoryDb;
    readonly committer: MemorySummaryMaintenanceCommitter; readonly isCurrent: () => boolean;
}): AqlSummaryRequestEvidenceCapture | null {
    try {
        agentClosureToken(input.rawSessionId, 'aql-session');
        const consumer = Object.freeze({ runId: agentClosureToken(input.runId, 'aql-consumer-run'),
            round: positive(input.round), contentMode: input.contentMode,
            sourceRevision: agentClosureToken(input.sourceRevision, 'aql-consumer-source') });
        if (!['nsf', 'nsfw'].includes(input.contentMode) || input.runId === 'missing-run'
            || typeof input.prompt !== 'string' || typeof input.renderedSummary !== 'string'
            || typeof input.isCurrent !== 'function' || input.isCurrent() !== true) return null;
        ASSERT_BINDING.call(input.committer, input.rawSessionId, input.memory);
        const generation = READ_AUTHORITY.call(input.memory).generation;
        const snapshot = READ_CURRENT.call(input.committer);
        if (!snapshot || input.round < snapshot.throughRound || input.runId === snapshot.lineage.runId) return null;
        const original = snapshot.summary.trim(), prefix = '<长期摘要>\n', suffix = '\n</长期摘要>';
        let coverage: 'complete' | 'partial';
        if (input.renderedSummary === prefix + original + suffix) coverage = 'complete';
        else {
            if (!input.renderedSummary.startsWith(prefix) || !input.renderedSummary.endsWith(suffix)) return null;
            const clipped = input.renderedSummary.slice(prefix.length, -suffix.length);
            if (!clipped.endsWith('…')) return null;
            const body = clipped.slice(0, -1);
            if (!body || body.length >= original.length || !original.startsWith(body)) return null;
            coverage = 'partial';
        }
        if (!input.prompt.includes(`长期摘要：\n${input.renderedSummary}`)) return null;
        const binding: Captured = Object.freeze({ ...input, consumer, snapshot, generation, coverage });
        if (!current(binding)) return null;
        const capture = Object.freeze({}) as AqlSummaryRequestEvidenceCapture;
        CAPTURED.set(capture, binding);
        return capture;
    } catch { return null; }
}
export function isAqlSummaryRequestEvidenceCurrent(capture: AqlSummaryRequestEvidenceCapture): boolean {
    const binding = CAPTURED.get(capture);
    return binding !== undefined && current(binding);
}

/** The exact successful managed request is observed once; this never adopts its suggestion. */
export function commitAqlSummaryRequestEvidence(capture: AqlSummaryRequestEvidenceCapture, input: {
    readonly request: ChatRequest; readonly output: string; readonly occurredAt?: string;
}): AqlSummaryRequestEvidenceReceipt | null {
    const binding = CAPTURED.get(capture);
    if (!binding || COMMIT_ATTEMPTED.has(capture)) return null;
    COMMIT_ATTEMPTED.add(capture);
    if (!current(binding) || !parseAqlReplanOutput(input.output)) return null;
    const { request } = input;
    if (typeof request.model !== 'string' || !request.model || !Number.isSafeInteger(request.max_tokens)
        || request.max_tokens! < 1 || JSON.stringify(request) !== JSON.stringify(buildAqlReplanRequest(binding.prompt,
            { variant: 'managed', model: request.model, maxTokens: request.max_tokens! }))) return null;
    const occurredAt = agentClosureTimestamp(input.occurredAt ?? new Date().toISOString(), 'aql-summary-request-at');
    const base = { version: AQL_SUMMARY_REQUEST_EVIDENCE_VERSION, state: 'request-used' as const,
        sessionId: opaqueLearningToken('session', binding.rawSessionId), consumer: binding.consumer,
        source: Object.freeze({ ...binding.snapshot.lineage, revision: binding.snapshot.revision }),
        coverage: binding.coverage, inputDigest: digest(binding.prompt), renderedSummaryDigest: digest(binding.renderedSummary),
        requestDigest: digest(request), outputDigest: digest(input.output), occurredAt,
        assistantAdopted: false as const, authorizesExecution: false as const, authorizesPromotion: false as const };
    const receipt = normalize({ ...base, receiptDigest: digest(base) }, binding.rawSessionId);
    return binding.memory.transaction(() => {
        if (binding.memory.db.isTransaction !== true || binding.isCurrent() !== true
            || READ_AUTHORITY.call(binding.memory).generation !== binding.generation) return null;
        ASSERT_BINDING.call(binding.committer, binding.rawSessionId, binding.memory);
        const history = READ_LINEAGE.call(binding.committer, binding.snapshot), original = binding.snapshot.lineage;
        if (!history || !history.readback || history.state !== 'applied'
            || history.intent.runId !== original.runId || history.intent.intentDigest !== original.intentDigest
            || history.intent.operationDigest !== original.operationDigest
            || history.intent.committedAt !== original.committedAt
            || history.readback.readbackDigest !== original.readbackDigest
            || history.readback.verifiedAt !== original.verifiedAt) return null;
        const owner = binding.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(binding.rawSessionId, SUMMARY_CURRENT_OWNER_KEY) as { value: string } | undefined;
        if (owner?.value !== JSON.stringify(binding.snapshot.owner) || binding.isCurrent() !== true) return null;
        const controlKey = key(binding.consumer.runId);
        if (binding.memory.db.prepare('SELECT 1 FROM session_control WHERE session_key=? AND control_key=?')
            .get(binding.rawSessionId, controlKey)) return null;
        const value = JSON.stringify(receipt);
        if (value.length > MAX_RECORD_CHARS) invalid();
        const written = binding.memory.db.prepare(
            'INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)',
        ).run(binding.rawSessionId, controlKey, value, occurredAt);
        if (written.changes !== 1 || binding.memory.db.isTransaction !== true || binding.isCurrent() !== true)
            throw new Error('aql-summary-request-evidence-write-drift');
        const retained = binding.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(binding.rawSessionId, controlKey) as { value: string } | undefined;
        if (retained?.value !== value) throw new Error('aql-summary-request-evidence-readback-failed');
        const tail = READ_LINEAGE.call(binding.committer, binding.snapshot);
        const tailOwner = binding.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(binding.rawSessionId, SUMMARY_CURRENT_OWNER_KEY) as { value: string } | undefined;
        if (!tail || tail.intent.intentDigest !== original.intentDigest
            || tail.readback?.readbackDigest !== original.readbackDigest
            || tailOwner?.value !== JSON.stringify(binding.snapshot.owner) || binding.isCurrent() !== true)
            throw new Error('aql-summary-request-evidence-write-source-drift');
        return receipt;
    });
}

/** Restore history only: a disk receipt cannot recover a live capture or dispatch authority. */
export function readAqlSummaryRequestEvidenceFile(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number; readonly cursor?: number;
}): AqlSummaryRequestEvidencePage | null {
    agentClosureToken(input.rawSessionId, 'aql-session');
    const limit = positive(input.limit ?? 50), cursor = positive(input.cursor ?? 0, 0);
    if (limit > 100) invalid();
    const allowed = (): boolean => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const file = lstatSync(input.path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('aql-summary-request-evidence-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) invalid();
        inspectSessionAuthoritySchema(db);
        const columns = (db.prepare('PRAGMA table_info(session_control)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
            ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) invalid();
        if (!allowed()) return null;
        const statement = db.prepare(`SELECT rowid,control_key,value,updated_at FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
        const readRows = () => statement.all(input.rawSessionId,
            `${AQL_SUMMARY_REQUEST_EVIDENCE_PREFIX}*`, cursor, limit + 1) as {
                rowid: number; control_key: string; value: string; updated_at: string;
            }[];
        const rows = readRows();
        const entries: AqlSummaryRequestEvidenceReceipt[] = [];
        let failed = 0, nextCursor = cursor;
        for (const row of rows.slice(0, limit)) {
            nextCursor = positive(row.rowid);
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) invalid();
                const receipt = normalize(JSON.parse(row.value) as unknown, input.rawSessionId);
                if (row.control_key !== key(receipt.consumer.runId) || row.updated_at !== receipt.occurredAt) invalid();
                entries.push(receipt);
            } catch { failed++; }
        }
        const currentFile = lstatSync(input.path);
        if (!currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.dev !== file.dev
            || currentFile.ino !== file.ino) throw new Error('aql-summary-request-evidence-file-drift');
        if (!allowed()) return null;
        if (JSON.stringify(readRows()) !== JSON.stringify(rows))
            throw new Error('aql-summary-request-evidence-read-drift');
        if (!allowed()) return null;
        return Object.freeze({ version: 'aql-summary-request-evidence-page-v1', entries: Object.freeze(entries),
            attempted: Math.min(rows.length, limit), failed, nextCursor, hasMore: rows.length > limit });
    } finally { db.close(); }
}
