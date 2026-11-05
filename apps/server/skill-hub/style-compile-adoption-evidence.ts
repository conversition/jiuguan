/** Historical learned-style consumption; compilation and publication are separate facts. */
import { AGENT_EVIDENCE_RECORD_VERSION, agentEvidenceRecordDigest, createAgentEvidenceRecord,
    type AgentEvidenceRecordV1 } from '@jiuguan/skill-hub';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { readStyleCompileSkillAdoptionEvidenceFile, readStyleCompileSkillAdoptionEvidenceByDigest,
    type StyleCompileSkillAdoptionEvidencePage }
    from '../style-compile-skill-source.ts';
import type { AgentEvidenceLedger, StoredAgentEvidenceRecord } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export const STYLE_COMPILE_ADOPTION_EVIDENCE_SOURCE = 'style-compile-adoption-v1' as const;
const STYLE_ADOPTION_EVIDENCE_PAGE_SIZE = 8;
type Entry = StyleCompileSkillAdoptionEvidencePage['entries'][number];

/** Never attribute the producer's Skill to the later consumer. */
export function styleCompileAdoptionEvidenceRecord(entry: Entry): AgentEvidenceRecordV1 | null {
    const { receipt, identity } = entry;
    if (!identity) return null;
    if (identity.sessionId !== receipt.sessionId) throw new Error('style-adoption-evidence-session-mismatch');
    return createAgentEvidenceRecord({
        recordVersion: AGENT_EVIDENCE_RECORD_VERSION, eventType: 'context-consumed',
        sessionId: identity.sessionId, cardId: identity.cardId, contentMode: identity.contentMode,
        capabilityId: 'style.compose', sourceType: STYLE_COMPILE_ADOPTION_EVIDENCE_SOURCE,
        sourceRef: `style-adoption:${sha256Digest(receipt.consumerRunId)}`, sourceDigest: receipt.receiptDigest,
        artifactDigest: receipt.bodyDigest, consumerRunId: opaqueLearningToken('run', receipt.consumerRunId),
        requestDigest: receipt.requestDigest, occurredAt: receipt.occurredAt,
        attributionKind: 'unattributed', manifestDigests: [], candidateDigests: [],
        executionClass: 'unknown', effectOutcome: 'unknown', learningWeight: 0,
    });
}

export interface StyleCompileAdoptionEvidenceProjection {
    readonly stored: StoredAgentEvidenceRecord;
    readonly state: 'current' | 'invalidated' | 'unavailable';
    readonly sourceValidity: 'current' | 'invalidated' | null;
    readonly consumerValidity: 'current' | 'invalidated' | null;
    readonly reasonCode: null | 'evidence-source-validation-failed' | 'evidence-source-unavailable';
}

export interface StyleCompileAdoptionEvidencePageView {
    readonly version: 'style-adoption-evidence-page-v1';
    readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
        state: 'current' | 'invalidated' | 'unavailable';
        sourceValidity: 'current' | 'invalidated' | null; consumerValidity: 'current' | 'invalidated' | null }>[];
    /** Cursor and hasMore describe all original Ledger rows, not only Style rows. */
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

/** Historical archive stays unchanged; current source and consumer are independently re-read. */
export function readStyleCompileAdoptionEvidence(input: {
    readonly path: string; readonly rawSessionId: string; readonly evidenceId: string;
    readonly allowed: (id: string) => boolean; readonly ledger: Pick<AgentEvidenceLedger, 'get'>;
}): StyleCompileAdoptionEvidenceProjection | null {
    let denied = false;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(input.rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed()) return null;
    let stored: StoredAgentEvidenceRecord | null;
    try {
        stored = input.ledger.get(input.evidenceId);
        if (!stored || stored.record.evidenceId !== input.evidenceId
            || stored.record.sessionId !== opaqueLearningToken('session', input.rawSessionId)) return null;
    } catch { return null; }
    const unavailable = (): StyleCompileAdoptionEvidenceProjection => Object.freeze({
        stored, state: 'unavailable', sourceValidity: null, consumerValidity: null,
        reasonCode: 'evidence-source-unavailable',
    });
    let projection = unavailable();
    try {
        const record = stored.record;
        if (record.eventType === 'context-consumed' && record.sourceType === STYLE_COMPILE_ADOPTION_EVIDENCE_SOURCE
            && record.capabilityId === 'style.compose' && record.attributionKind === 'unattributed') {
            const read = () => readStyleCompileSkillAdoptionEvidenceByDigest({ path: input.path,
                rawSessionId: input.rawSessionId, receiptDigest: record.sourceDigest, allowed: () => allowed() });
            const first = read();
            if (!allowed()) return null;
            const original = first && styleCompileAdoptionEvidenceRecord(first);
            if (first && original && agentEvidenceRecordDigest(original) === stored.recordDigest
                && JSON.stringify(original) === JSON.stringify(record)) {
                const second = read();
                if (!allowed()) return null;
                if (second && JSON.stringify(first) === JSON.stringify(second)) {
                    const current = first.sourceValidity === 'current' && first.consumerValidity === 'current';
                    projection = Object.freeze({ stored, state: current ? 'current' : 'invalidated',
                        sourceValidity: first.sourceValidity, consumerValidity: first.consumerValidity,
                        reasonCode: current ? null : 'evidence-source-validation-failed' });
                }
            }
        }
    } catch { if (!allowed()) return null; }
    try {
        if (!allowed()) return null;
        const current = input.ledger.get(input.evidenceId);
        if (!current || current.record.evidenceId !== stored.record.evidenceId
            || current.recordDigest !== stored.recordDigest || current.ingestedAt !== stored.ingestedAt
            || current.sourceStatus !== stored.sourceStatus || JSON.stringify(current.record) !== JSON.stringify(stored.record)) return null;
        if (!allowed()) return null;
        return projection;
    } catch { return null; }
}

/** Bounded operator view; historical records and raw source identifiers never leave the server. */
export function readStyleCompileAdoptionEvidencePage(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly ledger: Pick<AgentEvidenceLedger, 'get' | 'list'>; readonly limit: number; readonly cursor: number;
}): StyleCompileAdoptionEvidencePageView | null {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10
        || !Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('style-evidence-page-invalid');
    let denied = false;
    const allowed = (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    if (!allowed(input.rawSessionId)) return null;
    const page = input.ledger.list({ rawSessionId: input.rawSessionId, limit: input.limit, cursor: input.cursor });
    if (!allowed(input.rawSessionId)) return null;
    if (page.failed !== 0) throw new Error('style-evidence-ledger-unavailable');
    const entries: StyleCompileAdoptionEvidencePageView['entries'][number][] = [];
    for (const stored of page.records) {
        if (stored.record.eventType !== 'context-consumed' || stored.record.sourceType !== STYLE_COMPILE_ADOPTION_EVIDENCE_SOURCE) continue;
        const projection = readStyleCompileAdoptionEvidence({ path: input.path, rawSessionId: input.rawSessionId,
            evidenceId: stored.record.evidenceId, allowed, ledger: input.ledger });
        if (!projection || projection.stored.recordDigest !== stored.recordDigest
            || projection.stored.ingestedAt !== stored.ingestedAt) return null;
        entries.push(Object.freeze({ evidenceId: stored.record.evidenceId, occurredAt: stored.record.occurredAt,
            state: projection.state, sourceValidity: projection.sourceValidity, consumerValidity: projection.consumerValidity }));
    }
    if (!allowed(input.rawSessionId)) return null;
    for (const stored of page.records) {
        const current = input.ledger.get(stored.record.evidenceId);
        if (!current || current.recordDigest !== stored.recordDigest || current.ingestedAt !== stored.ingestedAt) return null;
    }
    if (!allowed(input.rawSessionId)) return null;
    return Object.freeze({ version: 'style-adoption-evidence-page-v1', entries: Object.freeze(entries),
        nextCursor: page.nextCursor, hasMore: page.hasMore });
}

/** Read original metadata twice under the deletion fence; no Session, Provider or business replay. */
export function reconcileStyleCompileAdoptionEvidence(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requestedLimit = input.limit ?? STYLE_ADOPTION_EVIDENCE_PAGE_SIZE, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1
        || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('style-adoption-evidence-page-invalid');
    const limit = Math.min(requestedLimit, STYLE_ADOPTION_EVIDENCE_PAGE_SIZE);
    let denied = false;
    const allowed = (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    const read = () => readStyleCompileSkillAdoptionEvidenceFile({ path: input.path, rawSessionId: input.rawSessionId,
        allowed, limit, cursor });
    const batch = read();
    if (!batch) return Object.freeze({ attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false });
    let delivered = 0, skipped = 0, failed = batch.failed;
    if (failed) return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed, nextCursor: cursor, hasMore: false });
    for (const entry of batch.entries) {
        try {
            if (!allowed(input.rawSessionId)) { skipped++; failed++; return Object.freeze({ attempted: batch.attempted,
                delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            const record = styleCompileAdoptionEvidenceRecord(entry);
            if (!record) { skipped++; continue; }
            const current = read();
            const matches = current?.entries.filter((item) => item.receipt.receiptDigest === entry.receipt.receiptDigest) ?? [];
            if (!current || current.failed !== 0 || matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(entry))
                throw new Error('style-adoption-evidence-source-drift');
            if (!allowed(input.rawSessionId)) { skipped++; failed++; return Object.freeze({ attempted: batch.attempted,
                delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            const result = input.ledger.append(input.rawSessionId, record);
            if (result.status === 'discarded-deleted-session') { skipped++; failed++; return Object.freeze({
                attempted: batch.attempted, delivered, skipped, failed, nextCursor: cursor, hasMore: false }); }
            const after = read();
            const afterMatches = after?.entries.filter((item) => item.receipt.receiptDigest === entry.receipt.receiptDigest) ?? [];
            if (!allowed(input.rawSessionId) || !after || after.failed !== 0 || afterMatches.length !== 1
                || JSON.stringify(afterMatches[0]) !== JSON.stringify(entry))
                throw new Error('style-adoption-evidence-post-append-drift');
            delivered++;
        } catch {
            failed++;
            return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed, nextCursor: cursor, hasMore: false });
        }
    }
    return Object.freeze({ attempted: batch.attempted, delivered, skipped, failed, nextCursor: batch.nextCursor, hasMore: batch.hasMore });
}

export function hasRetainedStyleCompileAdoptionEvidence(path: string, rawSessionId: string): boolean {
    let cursor = 0;
    do {
        const page = readStyleCompileSkillAdoptionEvidenceFile({ path, rawSessionId, allowed: () => true,
            limit: STYLE_ADOPTION_EVIDENCE_PAGE_SIZE, cursor });
        if (!page) return false;
        if (page.failed !== 0) throw new Error('style-adoption-evidence-source-invalid');
        if (page.entries.some((entry) => entry.identity !== null)) return true;
        if (!page.hasMore) return false;
        if (page.nextCursor <= cursor) throw new Error('style-adoption-evidence-cursor-invalid');
        cursor = page.nextCursor;
    } while (true);
}

export function createStyleCompileAdoptionEvidenceScheduler(input: {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>;
    readonly allowed: (id: string) => boolean;
    readonly resolvePath: (id: string) => string | null;
    readonly onFailure?: () => void;
}) {
    return createEvidenceRecoveryScheduler({
        allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) => {
            if (!allowed(rawSessionId))
                return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            const path = input.resolvePath(rawSessionId);
            if (!allowed(rawSessionId))
                return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            if (!path) return { attempted: 0, delivered: 0, skipped: 0, failed: 1, nextCursor: cursor, hasMore: false };
            return reconcileStyleCompileAdoptionEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor });
        },
    });
}
