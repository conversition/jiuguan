/** Body-free observation of an actual Style Skill output and original proposal readback.
 * This sidecar is not the proposal transaction, approval, activation or narrative adoption.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import { normalizeLearnedStyleDraft } from '../../packages/agent-policy/public/style-compiler.ts';
import type { StyleProposal } from '../../packages/core/public/learned-style-store.ts';
import { MemoryDb, inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { StyleCompileIntentOutbox }
    from '../../packages/memory/public/style-compile-intent-outbox.ts';
import { opaqueLearningToken, sha256Digest } from '../../packages/memory/public/learning-outbox.ts';
import { ChatSession, type SessionArgs } from '../../packages/session/public/session.ts';
import { assertStyleCompileSkillSourceSessionBinding, isStyleCompileSkillSourceCurrent,
    isStyleCompileSkillSourceCurrentAfterReceiptWrite,
    isStyleCompileSkillSourceRetained, normalizeStyleCompileSkillSourceSnapshot,
    type StyleCompileSkillSourceSnapshotV1 } from './skill-hub/style-compile-context.ts';
import { normalizeStyleCompileSkillOutputProof, takeStyleCompileSkillOutputProof,
    type StyleCompileSkillOutputProofV1 } from './skill-hub/style-compile-source-proof.ts';

export const STYLE_COMPILE_SKILL_SOURCE_PREFIX = 'style_compile_skill_source:';
export const STYLE_COMPILE_SKILL_SOURCE_RECEIPT_VERSION = 'style-compile-skill-source-receipt-v1' as const;
export interface StyleCompileSkillSourceReceipt {
    readonly version: typeof STYLE_COMPILE_SKILL_SOURCE_RECEIPT_VERSION;
    readonly source: StyleCompileSkillSourceSnapshotV1;
    readonly proof: StyleCompileSkillOutputProofV1;
    readonly proposal: Readonly<{
        proposalId: string; version: number; sourceDigest: string; profileVersion: string; model: string;
        policyVersion: string; bodyDigest: string; draftDigest: string; createdAt: string;
        observedRevision: string; observedStatus: 'disabled' | 'enabled'; observedActiveVersion: number | null;
    }>;
    readonly observedAt: string;
    readonly evidence: 'proposal-readback-only';
    readonly adoption: 'unknown';
    readonly learningWeight: 0;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly receiptDigest: string;
}
export interface StyleCompileSkillSourcePage {
    readonly version: 'style-compile-skill-source-page-v1';
    readonly entries: readonly Readonly<{ receipt: StyleCompileSkillSourceReceipt; sourceValidity: 'current' | 'invalidated' }>[];
    readonly attempted: number; readonly failed: number; readonly nextCursor: number; readonly hasMore: boolean;
}
const TRANSACTION = MemoryDb.prototype.transaction;
const GET_MEMORY = ChatSession.prototype.getMemory;
const MAX_RECORD_CHARS = 65_536;
const RECEIPT_FIELDS = ['version', 'source', 'proof', 'proposal', 'observedAt', 'evidence', 'adoption',
    'learningWeight', 'authorizesExecution', 'authorizesPromotion', 'receiptDigest'];
const PROPOSAL_FIELDS = ['proposalId', 'version', 'sourceDigest', 'profileVersion', 'model', 'policyVersion',
    'bodyDigest', 'draftDigest', 'createdAt', 'observedRevision', 'observedStatus', 'observedActiveVersion'];
function fail(): never { throw new Error('style-compile-skill-source-invalid'); }
export function styleCompileSkillSourceReceiptDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== names.length || names.some((name) => {
        const descriptor = descriptors[name];
        return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail();
    return value as Record<string, unknown>;
}
function count(value: unknown, minimum = 1): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) fail();
    return value;
}
function key(runId: string): string { return STYLE_COMPILE_SKILL_SOURCE_PREFIX + styleCompileSkillSourceReceiptDigest([runId]).slice(7); }

/** Restored metadata is structurally checked but never acquires a live source/output brand. */
export function normalizeStyleCompileSkillSourceReceipt(value: unknown): StyleCompileSkillSourceReceipt {
    const row = exact(value, RECEIPT_FIELDS), proposal = exact(row.proposal, PROPOSAL_FIELDS);
    const source = normalizeStyleCompileSkillSourceSnapshot(row.source);
    const proof = normalizeStyleCompileSkillOutputProof(row.proof);
    if (row.version !== STYLE_COMPILE_SKILL_SOURCE_RECEIPT_VERSION
        || row.evidence !== 'proposal-readback-only' || row.adoption !== 'unknown' || row.learningWeight !== 0
        || row.authorizesExecution !== false || row.authorizesPromotion !== false
        || JSON.stringify(source) !== JSON.stringify(proof.source)
        || typeof proposal.proposalId !== 'string' || !/^style-[a-f0-9]{20}$/u.test(proposal.proposalId)
        || !['disabled', 'enabled'].includes(proposal.observedStatus as string)) fail();
    const normalizedProposal = Object.freeze({
        proposalId: proposal.proposalId, version: count(proposal.version),
        sourceDigest: agentClosureDigest(proposal.sourceDigest as string, 'style-proposal-source'),
        profileVersion: agentClosureToken(proposal.profileVersion as string, 'style-proposal-profile'),
        model: agentClosureToken(proposal.model as string, 'style-proposal-model'),
        policyVersion: agentClosureToken(proposal.policyVersion as string, 'style-proposal-policy'),
        bodyDigest: agentClosureDigest(proposal.bodyDigest as string, 'style-proposal-body'),
        draftDigest: agentClosureDigest(proposal.draftDigest as string, 'style-proposal-draft'),
        createdAt: agentClosureTimestamp(proposal.createdAt as string, 'style-proposal-created'),
        observedRevision: agentClosureToken(proposal.observedRevision as string, 'style-proposal-revision'),
        observedStatus: proposal.observedStatus as 'disabled' | 'enabled',
        observedActiveVersion: proposal.observedActiveVersion === null ? null : count(proposal.observedActiveVersion),
    });
    const observedAt = agentClosureTimestamp(row.observedAt as string, 'style-source-observed');
    if (normalizedProposal.sourceDigest !== source.sourceProfileDigest
        || normalizedProposal.profileVersion !== source.profileVersion
        || normalizedProposal.policyVersion !== source.policyVersion
        || normalizedProposal.bodyDigest !== proof.bodyDigest || normalizedProposal.draftDigest !== proof.draftDigest
        || observedAt < normalizedProposal.createdAt || observedAt < proof.validatedAt) fail();
    const base = { version: STYLE_COMPILE_SKILL_SOURCE_RECEIPT_VERSION, source, proof, proposal: normalizedProposal,
        observedAt, evidence: 'proposal-readback-only' as const, adoption: 'unknown' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const };
    if (row.receiptDigest !== styleCompileSkillSourceReceiptDigest(base)) fail();
    return Object.freeze({ ...base, receiptDigest: row.receiptDigest as string });
}

/** Only the exact original version/draft may carry a successful actual-response observation. */
function proposalObservation(proposal: StyleProposal | null, proposalId: string,
    source: StyleCompileSkillSourceSnapshotV1, proof: StyleCompileSkillOutputProofV1,
    model: string, scope: NonNullable<StyleProposal['scope']>): StyleCompileSkillSourceReceipt['proposal'] | null {
    try {
        if (!proposal || proposal.id !== proposalId || !proposal.scope
            || proposal.scope.sessionId !== scope.sessionId || proposal.scope.cardId !== scope.cardId
            || proposal.scope.contentMode !== scope.contentMode || proposal.scope.baseStyleSkillId !== scope.baseStyleSkillId
            || !['disabled', 'enabled'].includes(proposal.status)) return null;
        const matching = proposal.versions.filter((version) => {
            const draft = normalizeLearnedStyleDraft({ name: version.draft.name, description: version.draft.description,
                keywords: version.draft.keywords, body: version.draft.body });
            return version.sourceDigest === source.sourceProfileDigest && version.profileVersion === source.profileVersion
                && version.model === model && version.policyVersion === source.policyVersion && draft !== null
                && draft.bodyDigest === version.draft.bodyDigest && draft.bodyDigest === proof.bodyDigest
                && styleCompileSkillSourceReceiptDigest(draft) === proof.draftDigest;
        });
        if (matching.length !== 1) return null;
        const version = matching[0]!;
        return Object.freeze({ proposalId, version: version.version, sourceDigest: version.sourceDigest,
            profileVersion: version.profileVersion, model: version.model, policyVersion: version.policyVersion,
            bodyDigest: proof.bodyDigest, draftDigest: proof.draftDigest, createdAt: version.createdAt,
            observedRevision: proposal.revision, observedStatus: proposal.status,
            observedActiveVersion: proposal.activeVersion });
    } catch { return null; }
}

/** The proposal already exists. An optional Session sidecar cannot roll back or claim its creation. */
export function commitStyleCompileSkillSourceReceipt(input: {
    readonly rawSessionId: string; readonly session: ChatSession; readonly source: StyleCompileSkillSourceSnapshotV1;
    readonly proof: unknown; readonly proposalId: string; readonly readProposal: (proposalId: string) => StyleProposal | null;
    readonly isCurrentSession: () => boolean; readonly now?: () => string;
}): StyleCompileSkillSourceReceipt | null {
    const proof = takeStyleCompileSkillOutputProof(input.proof);
    if (!proof || JSON.stringify(proof.source) !== JSON.stringify(input.source)) return null;
    assertStyleCompileSkillSourceSessionBinding(input.source, input.rawSessionId, input.session);
    const memory = GET_MEMORY.call(input.session).mem;
    const current = () => input.isCurrentSession() === true && memory === GET_MEMORY.call(input.session).mem
        && isStyleCompileSkillSourceCurrent(input.source);
    const afterWriteCurrent = () => input.isCurrentSession() === true && memory === GET_MEMORY.call(input.session).mem
        && isStyleCompileSkillSourceCurrentAfterReceiptWrite(input.source);
    if (memory.db.isTransaction !== false || !current()) return null;
    const native = new StyleCompileIntentOutbox(memory.db, input.rawSessionId).readRetainedSource(input.source.runId);
    if (!native || !native.current || native.settlement !== null
        || native.entry.packetDigest !== input.source.intentPacketDigest) return null;
    const intent = native.entry.payload;
    if (styleCompileSkillSourceReceiptDigest(intent.binding) !== input.source.bindingDigest
        || intent.scope.sessionId !== input.source.sessionId) return null;
    const observed = proposalObservation(input.readProposal(input.proposalId), input.proposalId, input.source, proof,
        intent.binding.modelId, intent.scope);
    if (!observed || !current()) return null;
    const base = { version: STYLE_COMPILE_SKILL_SOURCE_RECEIPT_VERSION, source: input.source, proof, proposal: observed,
        observedAt: input.now?.() ?? new Date().toISOString(), evidence: 'proposal-readback-only' as const,
        adoption: 'unknown' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const };
    const receipt = normalizeStyleCompileSkillSourceReceipt({ ...base, receiptDigest: styleCompileSkillSourceReceiptDigest(base) });
    const write = (): StyleCompileSkillSourceReceipt | null => {
        if (memory.db.isTransaction !== true || !current()) return null;
        assertStyleCompileSkillSourceSessionBinding(input.source, input.rawSessionId, input.session);
        const observation = () => proposalObservation(input.readProposal(input.proposalId), input.proposalId,
            input.source, proof, intent.binding.modelId, intent.scope);
        if (JSON.stringify(observation()) !== JSON.stringify(observed)) return null;
        const controlKey = key(input.source.runId);
        const existing = memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(input.rawSessionId, controlKey) as { value: string } | undefined;
        if (existing) {
            const retained = normalizeStyleCompileSkillSourceReceipt(JSON.parse(existing.value));
            return JSON.stringify([retained.source, retained.proof, retained.proposal])
                === JSON.stringify([receipt.source, receipt.proof, receipt.proposal]) ? retained : null;
        }
        const value = JSON.stringify(receipt);
        if (value.length > MAX_RECORD_CHARS) fail();
        const result = memory.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(input.rawSessionId, controlKey, value, receipt.observedAt);
        const retained = memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(input.rawSessionId, controlKey) as { value: string } | undefined;
        if (result.changes !== 1 || retained?.value !== value || memory.db.isTransaction !== true
            || !afterWriteCurrent() || JSON.stringify(observation()) !== JSON.stringify(observed) || !afterWriteCurrent()) {
            throw new Error('style-compile-skill-source-write-drift');
        }
        return receipt;
    };
    return TRANSACTION.call(memory, write) as StyleCompileSkillSourceReceipt | null;
}

/** Historical inspection never restores source brands, a lease, an approval or a model operation. */
export function readStyleCompileSkillSourceFile(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number; readonly cursor?: number;
}): StyleCompileSkillSourcePage | null {
    const limit = count(input.limit ?? 50), cursor = count(input.cursor ?? 0, 0);
    if (limit > 100) fail();
    const allowed = () => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const original = lstatSync(input.path);
    if (!original.isFile() || original.isSymbolicLink()) fail();
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) fail();
        inspectSessionAuthoritySchema(db);
        const columns = (db.prepare('PRAGMA table_info(session_control)').all() as {
            name: string; type: string; notnull: number; pk: number;
        }[]).map((row) => [row.name, row.type, row.notnull, row.pk]);
        if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
            ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) fail();
        if (!allowed()) return null;
        const statement = db.prepare(`SELECT rowid,control_key,value,updated_at FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`);
        const readRows = () => statement.all(input.rawSessionId, STYLE_COMPILE_SKILL_SOURCE_PREFIX + '*', cursor, limit + 1) as {
            rowid: number; control_key: string; value: string; updated_at: string;
        }[];
        const rows = readRows();
        const entries: Array<StyleCompileSkillSourcePage['entries'][number]> = [];
        let failed = 0, nextCursor = cursor;
        for (const row of rows.slice(0, limit)) {
            nextCursor = count(row.rowid);
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) fail();
                const receipt = normalizeStyleCompileSkillSourceReceipt(JSON.parse(row.value));
                if (row.control_key !== key(receipt.source.runId) || row.updated_at !== receipt.observedAt
                    || receipt.source.sessionId !== opaqueLearningToken('session', input.rawSessionId)) fail();
                const sourceValidity = isStyleCompileSkillSourceRetained(db, input.rawSessionId, receipt.source) ? 'current' : 'invalidated';
                entries.push(Object.freeze({ receipt, sourceValidity }));
            } catch { failed++; }
        }
        const final = lstatSync(input.path);
        if (!final.isFile() || final.isSymbolicLink() || final.dev !== original.dev || final.ino !== original.ino) fail();
        if (!allowed()) return null;
        if (JSON.stringify(rows) !== JSON.stringify(readRows())) throw new Error('style-compile-skill-source-read-drift');
        // Source validity is a current projection; a changed rollback/clear cannot retain an old answer.
        for (const entry of entries) {
            const validity = isStyleCompileSkillSourceRetained(db, input.rawSessionId, entry.receipt.source) ? 'current' : 'invalidated';
            if (validity !== entry.sourceValidity) throw new Error('style-compile-skill-source-validity-drift');
        }
        if (!allowed()) return null;
        return Object.freeze({ version: 'style-compile-skill-source-page-v1', entries: Object.freeze(entries),
            attempted: Math.min(rows.length, limit), failed, nextCursor, hasMore: rows.length > limit });
    } finally { db.close(); }
}

export const STYLE_COMPILE_SKILL_ADOPTION_PREFIX = 'style_compile_skill_adoption:';
export interface StyleCompileSkillAdoptionReceipt {
    readonly version: 'style-compile-skill-adoption-v1';
    readonly sessionId: string;
    readonly sourceRunId: string;
    readonly sourceReceiptDigest: string;
    readonly proposalId: string;
    readonly proposalVersion: number;
    readonly activationRevision: string;
    readonly bodyDigest: string;
    readonly scopeDigest: string;
    readonly consumerRunId: string;
    readonly round: number;
    readonly historyEpoch: number;
    readonly requestDigest: string;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly occurredAt: string;
    readonly evidence: 'request-used-by-committed-turn';
    readonly learningWeight: 0;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly receiptDigest: string;
}
export interface StyleCompileSkillAdoptionPage {
    readonly version: 'style-compile-skill-adoption-page-v1';
    readonly entries: readonly Readonly<{ receipt: StyleCompileSkillAdoptionReceipt;
        sourceValidity: 'current' | 'invalidated'; consumerValidity: 'current' | 'invalidated' }>[];
    readonly attempted: number; readonly failed: number; readonly nextCursor: number; readonly hasMore: boolean;
}
/** Opaque identity captured by the original intent, available only to the Evidence adapter. */
export interface StyleCompileSkillAdoptionEvidencePage extends Omit<StyleCompileSkillAdoptionPage, 'entries'> {
    readonly entries: readonly Readonly<{ receipt: StyleCompileSkillAdoptionReceipt;
        sourceValidity: 'current' | 'invalidated'; consumerValidity: 'current' | 'invalidated';
        identity: Readonly<{ sessionId: string; cardId: string; contentMode: 'nsf' | 'nsfw' }> | null }>[];
}
const ADOPTION_FIELDS = ['version', 'sessionId', 'sourceRunId', 'sourceReceiptDigest', 'proposalId',
    'proposalVersion', 'activationRevision', 'bodyDigest', 'scopeDigest', 'consumerRunId', 'round', 'historyEpoch',
    'requestDigest', 'assistantMessageId', 'assistantDigest', 'occurredAt', 'evidence', 'learningWeight',
    'authorizesExecution', 'authorizesPromotion', 'receiptDigest'];
const READ_TURN = ChatSession.prototype.readAgentSkillTurnContext;
function adoptionKey(runId: string): string {
    return STYLE_COMPILE_SKILL_ADOPTION_PREFIX + styleCompileSkillSourceReceiptDigest([runId]).slice(7);
}
function adoptionFail(reason: string): never { throw new Error(`style-compile-skill-adoption-${reason}`); }
export function normalizeStyleCompileSkillAdoptionReceipt(value: unknown): StyleCompileSkillAdoptionReceipt {
    const row = exact(value, ADOPTION_FIELDS);
    if (row.version !== 'style-compile-skill-adoption-v1' || row.evidence !== 'request-used-by-committed-turn'
        || row.learningWeight !== 0 || row.authorizesExecution !== false || row.authorizesPromotion !== false
        || typeof row.proposalId !== 'string' || !/^style-[a-f0-9]{20}$/u.test(row.proposalId)) adoptionFail('invalid');
    const base = {
        version: 'style-compile-skill-adoption-v1' as const,
        sessionId: agentClosureToken(row.sessionId as string, 'style-adoption-session'),
        sourceRunId: agentClosureToken(row.sourceRunId as string, 'style-adoption-source-run'),
        sourceReceiptDigest: agentClosureDigest(row.sourceReceiptDigest as string, 'style-adoption-source'),
        proposalId: row.proposalId, proposalVersion: count(row.proposalVersion),
        activationRevision: agentClosureTimestamp(row.activationRevision as string, 'style-adoption-activation'),
        bodyDigest: agentClosureDigest(row.bodyDigest as string, 'style-adoption-body'),
        scopeDigest: agentClosureDigest(row.scopeDigest as string, 'style-adoption-scope'),
        consumerRunId: agentClosureToken(row.consumerRunId as string, 'style-adoption-consumer'),
        round: count(row.round), historyEpoch: count(row.historyEpoch, 0),
        requestDigest: agentClosureDigest(row.requestDigest as string, 'style-adoption-request'),
        assistantMessageId: count(row.assistantMessageId),
        assistantDigest: agentClosureDigest(row.assistantDigest as string, 'style-adoption-assistant'),
        occurredAt: agentClosureTimestamp(row.occurredAt as string, 'style-adoption-time'),
        evidence: 'request-used-by-committed-turn' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const,
    };
    if (row.receiptDigest !== styleCompileSkillSourceReceiptDigest(base)) adoptionFail('digest-invalid');
    return Object.freeze({ ...base, receiptDigest: row.receiptDigest as string });
}
function readSourceRow(db: DatabaseSync, rawSessionId: string, runId: string): StyleCompileSkillSourceReceipt {
    const row = db.prepare('SELECT control_key,value,updated_at FROM session_control WHERE session_key=? AND control_key=?')
        .get(rawSessionId, key(runId)) as { control_key: string; value: string; updated_at: string } | undefined;
    if (!row || typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) adoptionFail('source-missing');
    const receipt = normalizeStyleCompileSkillSourceReceipt(JSON.parse(row.value));
    if (receipt.source.runId !== runId || receipt.source.sessionId !== opaqueLearningToken('session', rawSessionId)
        || row.updated_at !== receipt.observedAt) adoptionFail('source-mismatch');
    return receipt;
}
function verifyAdoptionSource(db: DatabaseSync, rawSessionId: string, receipt: StyleCompileSkillAdoptionReceipt) {
    const source = readSourceRow(db, rawSessionId, receipt.sourceRunId);
    if (receipt.sessionId !== opaqueLearningToken('session', rawSessionId)
        || source.receiptDigest !== receipt.sourceReceiptDigest || source.proposal.proposalId !== receipt.proposalId
        || source.proposal.version !== receipt.proposalVersion || source.proposal.bodyDigest !== receipt.bodyDigest
        || receipt.occurredAt < source.observedAt || receipt.round <= source.source.round) adoptionFail('source-mismatch');
    return source;
}
function consumerCurrent(db: DatabaseSync, rawSessionId: string, receipt: StyleCompileSkillAdoptionReceipt): boolean {
    const epoch = db.prepare("SELECT value FROM session_control WHERE session_key=? AND control_key='history_epoch'")
        .get(rawSessionId) as { value: string } | undefined;
    const historyEpoch = epoch ? count(Number(epoch.value), 0) : 0;
    if (epoch && epoch.value !== String(historyEpoch)) adoptionFail('epoch-invalid');
    const assistant = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant'")
        .get(receipt.assistantMessageId, receipt.round) as { content: string } | undefined;
    return historyEpoch === receipt.historyEpoch && !!assistant && sha256Digest(assistant.content) === receipt.assistantDigest;
}

/** Original successful turn transaction owns this insert. A known Skill source can never downgrade to legacy. */
export function commitStyleCompileSkillAdoption(input: {
    readonly rawSessionId: string; readonly session: ChatSession;
    readonly consumption: Parameters<NonNullable<SessionArgs['commitLearnedStyleAdoption']>>[0];
    readonly readProposal: (proposalId: string) => StyleProposal | null;
    readonly isCurrentSession: () => boolean;
}): StyleCompileSkillAdoptionReceipt | null {
    const memory = GET_MEMORY.call(input.session).mem, db = memory.db, consumption = input.consumption;
    if (db.isTransaction !== true) adoptionFail('transaction-required');
    const current = () => {
        const turn = READ_TURN.call(input.session, consumption.runId);
        return input.isCurrentSession() === true && GET_MEMORY.call(input.session).mem === memory
            && turn?.sessionId === opaqueLearningToken('session', input.rawSessionId)
            && turn.contentMode === consumption.scope.contentMode;
    };
    if (!current() || consumption.rawSessionId !== input.rawSessionId) adoptionFail('session-stale');
    // Keep the existing source storage; bound the scan and refuse uncertainty instead of inventing lineage.
    const rows = db.prepare(`SELECT control_key,value,updated_at FROM session_control WHERE session_key=?
        AND control_key GLOB ? ORDER BY rowid LIMIT 1025`)
        .all(input.rawSessionId, STYLE_COMPILE_SKILL_SOURCE_PREFIX + '*') as
        { control_key: string; value: string; updated_at: string }[];
    if (rows.length > 1024) adoptionFail('source-scan-limit');
    const sources = rows.map((row) => {
        if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) adoptionFail('source-invalid');
        const receipt = normalizeStyleCompileSkillSourceReceipt(JSON.parse(row.value));
        if (row.control_key !== key(receipt.source.runId) || row.updated_at !== receipt.observedAt
            || receipt.source.sessionId !== opaqueLearningToken('session', input.rawSessionId)) adoptionFail('source-invalid');
        return receipt;
    }).filter((receipt) => receipt.proposal.proposalId === consumption.learned.proposalId
        && receipt.proposal.version === consumption.learned.version);
    if (sources.length === 0) return null;
    if (sources.length !== 1) adoptionFail('source-ambiguous');
    const source = sources[0]!;
    const validate = () => {
        if (!current() || !isStyleCompileSkillSourceRetained(db, input.rawSessionId, source.source)
            || readSourceRow(db, input.rawSessionId, source.source.runId).receiptDigest !== source.receiptDigest) adoptionFail('source-stale');
        const native = new StyleCompileIntentOutbox(db, input.rawSessionId).readRetainedSource(source.source.runId);
        if (!native || !native.current || JSON.stringify(native.entry.payload.scope) !== JSON.stringify(consumption.scope)) {
            adoptionFail('scope-mismatch');
        }
        const proposal = input.readProposal(consumption.learned.proposalId);
        if (!proposal || proposal.status !== 'enabled' || proposal.activeVersion !== consumption.learned.version
            || proposal.revision !== consumption.learned.proposalRevision || consumption.learned.bodyDigest !== source.proposal.bodyDigest
            || sha256Digest(consumption.learned.body) !== consumption.learned.bodyDigest) adoptionFail('proposal-stale');
        const observed = proposalObservation(proposal, proposal.id, source.source, source.proof,
            native.entry.payload.binding.modelId, native.entry.payload.scope);
        if (!observed || observed.version !== source.proposal.version || observed.createdAt !== source.proposal.createdAt
            || observed.bodyDigest !== source.proposal.bodyDigest || observed.draftDigest !== source.proposal.draftDigest) adoptionFail('proposal-mismatch');
    };
    validate();
    const base = {
        version: 'style-compile-skill-adoption-v1' as const, sessionId: source.source.sessionId,
        sourceRunId: source.source.runId, sourceReceiptDigest: source.receiptDigest,
        proposalId: consumption.learned.proposalId, proposalVersion: consumption.learned.version,
        activationRevision: consumption.learned.proposalRevision, bodyDigest: consumption.learned.bodyDigest,
        scopeDigest: styleCompileSkillSourceReceiptDigest(consumption.scope), consumerRunId: consumption.runId,
        round: consumption.round, historyEpoch: consumption.historyEpoch, requestDigest: consumption.requestDigest,
        assistantMessageId: consumption.assistantMessageId, assistantDigest: consumption.assistantDigest,
        occurredAt: consumption.occurredAt, evidence: 'request-used-by-committed-turn' as const, learningWeight: 0 as const,
        authorizesExecution: false as const, authorizesPromotion: false as const,
    };
    const receipt = normalizeStyleCompileSkillAdoptionReceipt({ ...base, receiptDigest: styleCompileSkillSourceReceiptDigest(base) });
    verifyAdoptionSource(db, input.rawSessionId, receipt);
    if (!consumerCurrent(db, input.rawSessionId, receipt)) adoptionFail('consumer-stale');
    const controlKey = adoptionKey(receipt.consumerRunId), value = JSON.stringify(receipt);
    const read = () => db.prepare('SELECT value,updated_at FROM session_control WHERE session_key=? AND control_key=?')
        .get(input.rawSessionId, controlKey) as { value: string; updated_at: string } | undefined;
    const previous = read();
    if (previous && (previous.value !== value || previous.updated_at !== receipt.occurredAt)) adoptionFail('conflict');
    if (!previous) db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
        .run(input.rawSessionId, controlKey, value, receipt.occurredAt);
    validate();
    const retained = read();
    if (retained?.value !== value || retained.updated_at !== receipt.occurredAt
        || !consumerCurrent(db, input.rawSessionId, receipt) || !current()) adoptionFail('write-drift');
    return receipt;
}

/** Read-only same-snapshot history. Neither consumer nor source invalidation erases an observed adoption. */
type AdoptionReadInput = {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (rawSessionId: string) => boolean;
    readonly limit?: number; readonly cursor?: number;
};
function readStyleCompileAdoption(input: AdoptionReadInput, includeIdentity: boolean,
    receiptDigest?: string): StyleCompileSkillAdoptionEvidencePage | null {
    const limit = count(input.limit ?? 50), cursor = count(input.cursor ?? 0, 0);
    if (limit > 100) adoptionFail('scan-limit');
    const allowed = () => { try { return input.allowed(input.rawSessionId) === true; } catch { return false; } };
    if (!allowed() || !existsSync(input.path)) return null;
    const original = lstatSync(input.path);
    if (!original.isFile() || original.isSymbolicLink()) adoptionFail('file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN DEFERRED;');
        if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
            || db.prepare('PRAGMA application_id').get()?.application_id !== 0) adoptionFail('schema-invalid');
        inspectSessionAuthoritySchema(db);
        if (!allowed()) return null;
        if (receiptDigest !== undefined && agentClosureDigest(receiptDigest, 'style-adoption-receipt') !== receiptDigest)
            adoptionFail('receipt-digest-invalid');
        const digestFilter = receiptDigest === undefined ? ''
            : ' AND CASE WHEN json_valid(value) THEN json_extract(value,\'$.receiptDigest\') END = ?';
        const statement = db.prepare(`SELECT rowid,control_key,value,updated_at FROM session_control
            WHERE session_key=? AND control_key GLOB ? AND rowid>?${digestFilter} ORDER BY rowid LIMIT ?`);
        const parameters = [input.rawSessionId, STYLE_COMPILE_SKILL_ADOPTION_PREFIX + '*', cursor,
            ...(receiptDigest === undefined ? [] : [receiptDigest]), limit + 1];
        const rows = statement.all(...parameters) as
            { rowid: number; control_key: string; value: string; updated_at: string }[];
        const entries: Array<StyleCompileSkillAdoptionEvidencePage['entries'][number]> = [];
        let failed = 0, nextCursor = cursor;
        for (const row of rows.slice(0, limit)) {
            nextCursor = count(row.rowid);
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) adoptionFail('row-invalid');
                const receipt = normalizeStyleCompileSkillAdoptionReceipt(JSON.parse(row.value));
                if (row.control_key !== adoptionKey(receipt.consumerRunId) || row.updated_at !== receipt.occurredAt) adoptionFail('row-invalid');
                const source = verifyAdoptionSource(db, input.rawSessionId, receipt);
                const native = new StyleCompileIntentOutbox(db, input.rawSessionId).readRetainedSource(source.source.runId);
                if (native && (native.entry.packetDigest !== source.source.intentPacketDigest
                    || native.entry.payload.rawSessionId !== input.rawSessionId
                    || native.entry.payload.scope.sessionId !== receipt.sessionId
                    || native.entry.payload.scope.contentMode !== source.source.contentMode
                    || styleCompileSkillSourceReceiptDigest(native.entry.payload.scope) !== receipt.scopeDigest)) adoptionFail('scope-mismatch');
                const identity = native ? Object.freeze({ sessionId: native.entry.payload.scope.sessionId,
                    cardId: native.entry.payload.scope.cardId, contentMode: native.entry.payload.scope.contentMode }) : null;
                const entry = { receipt,
                    sourceValidity: isStyleCompileSkillSourceRetained(db, input.rawSessionId, source.source) ? 'current' : 'invalidated',
                    consumerValidity: consumerCurrent(db, input.rawSessionId, receipt) ? 'current' : 'invalidated' } as const;
                entries.push(Object.freeze(includeIdentity ? { ...entry, identity } : entry) as StyleCompileSkillAdoptionEvidencePage['entries'][number]);
            } catch { failed++; }
        }
        db.exec('ROLLBACK;');
        const final = lstatSync(input.path);
        if (!final.isFile() || final.isSymbolicLink() || final.dev !== original.dev || final.ino !== original.ino) adoptionFail('file-drift');
        if (!allowed()) return null;
        return Object.freeze({ version: 'style-compile-skill-adoption-page-v1', entries: Object.freeze(entries),
            attempted: Math.min(rows.length, limit), failed, nextCursor, hasMore: rows.length > limit });
    } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}

export function readStyleCompileSkillAdoptionFile(input: AdoptionReadInput): StyleCompileSkillAdoptionPage | null {
    return readStyleCompileAdoption(input, false);
}

/** A missing original intent keeps the historical receipt but supplies no invented identity. */
export function readStyleCompileSkillAdoptionEvidenceFile(input: AdoptionReadInput): StyleCompileSkillAdoptionEvidencePage | null {
    return readStyleCompileAdoption(input, true);
}

/** Exact receipt digest lookup for a central archived record; ambiguity or corruption is not current. */
export function readStyleCompileSkillAdoptionEvidenceByDigest(input: Omit<AdoptionReadInput, 'limit' | 'cursor'> & {
    readonly receiptDigest: string;
}): StyleCompileSkillAdoptionEvidencePage['entries'][number] | null {
    const page = readStyleCompileAdoption({ ...input, limit: 2, cursor: 0 }, true, input.receiptDigest);
    if (!page) return null;
    if (page.failed !== 0 || page.hasMore || page.attempted > 1) adoptionFail('receipt-ambiguous-or-invalid');
    return page.entries[0] ?? null;
}
