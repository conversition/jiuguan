/** Archive only original Closure-reported observations; no independent quality is inferred. */
import { join } from 'node:path';
import { createAgentEvidenceReportedEffectRecord, type AgentEvidenceReportedEffectRecordV1 } from '@jiuguan/skill-hub';
import { normalizeAgentClosureRun } from '../../../packages/agent-closure/index.ts';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { AGENT_CLOSURE_DB_FILE, readAgentClosureEffectPage, type AgentClosureRecord } from '../agent-closure-store.ts';
import { buildAgentTaskOutcome } from '../agent-task-outcome.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

export function reportedEffectEvidenceRecord(rawSessionId: string, record: AgentClosureRecord, eventId: string):
    AgentEvidenceReportedEffectRecordV1 | null {
    if (record.sessionId !== rawSessionId) throw new Error('reported-effect-session-mismatch');
    const outcome = buildAgentTaskOutcome(record);
    const effect = record.events.find(item => item.eventId === eventId && item.type === 'effect-observed');
    if (!effect) throw new Error('reported-effect-original-missing');
    if (!outcome.axes.effect.evidence.some(item => item.refId === eventId)) return null;
    const basis = record.events.find(item => item.type === (record.kind === 'advisory' ? 'artifact-validated' : 'readback-verified'));
    const consumed = record.events.filter(item => item.type === 'context-consumed'
        && item.artifactDigest === effect.artifactDigest && item.consumerRunId === effect.consumerRunId
        && outcome.axes.adoption.evidence.some(ref => ref.refId === item.eventId)
        && item.occurredAt <= effect.occurredAt);
    if (!basis || consumed.length !== 1 || !effect.artifactDigest || !effect.consumerRunId || !effect.effectOutcome)
        throw new Error('reported-effect-lineage-ambiguous');
    const sourceDigest = sha256Digest(JSON.stringify({ run: normalizeAgentClosureRun(record), basis, consumed: consumed[0], effect }));
    return createAgentEvidenceReportedEffectRecord({
        recordVersion: 'agent-evidence-reported-effect-v1', eventType: 'reported-effect-observed',
        sessionId: opaqueLearningToken('session', rawSessionId), capabilityId: record.capability,
        sourceType: 'agent-closure-effect-observed-v1', sourceRef: `closure-effect:${sha256Digest(JSON.stringify([record.operationId, eventId]))}`,
        sourceDigest, artifactDigest: effect.artifactDigest, consumerRunId: opaqueLearningToken('run', effect.consumerRunId),
        occurredAt: effect.occurredAt, reportedOutcome: effect.effectOutcome, independentOutcome: 'unknown',
        attributionKind: 'unattributed', manifestDigests: [], candidateDigests: [], executionClass: 'unknown',
        effectOutcome: 'unknown', learningWeight: 0,
    });
}
type Input = { readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean };
function permission(input: Pick<Input, 'rawSessionId' | 'allowed'>) {
    let denied = false;
    return (id: string) => {
        if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
}
export function readReportedEffectEvidenceFile(input: Input & { readonly limit?: number; readonly cursor?: number }) {
    const limit = input.limit ?? 8, cursor = input.cursor ?? 0, allowed = permission(input);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('reported-effect-page-invalid');
    if (!allowed(input.rawSessionId)) return null;
    const page = readAgentClosureEffectPage(input.path, { sessionId: input.rawSessionId, limit, cursor });
    if (!page || !allowed(input.rawSessionId)) return null;
    const records = page.entries.map(row => reportedEffectEvidenceRecord(input.rawSessionId, row.record, row.eventId))
        .filter((value): value is AgentEvidenceReportedEffectRecordV1 => value !== null);
    if (!allowed(input.rawSessionId)) return null;
    return Object.freeze({ records: Object.freeze(records), attempted: page.attempted, nextCursor: page.nextCursor, hasMore: page.hasMore });
}
export function reconcileReportedEffectEvidence(input: Input & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly limit?: number; readonly cursor?: number;
}) {
    const requested = input.limit ?? 8, cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('reported-effect-page-invalid');
    const allowed = permission(input), limit = Math.min(requested, 8);
    let attempted = 0, delivered = 0, skipped = 0;
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        const read = () => readReportedEffectEvidenceFile({ ...input, allowed, limit, cursor });
        const page = read();
        if (!page) return fail();
        attempted = page.attempted;
        const same = () => { const current = read(); return current !== null && JSON.stringify(current) === JSON.stringify(page); };
        for (const record of page.records) {
            if (!same() || !allowed(input.rawSessionId)) return fail();
            if (input.ledger.append(input.rawSessionId, record).status === 'discarded-deleted-session') { skipped++; return fail(); }
            if (!same() || !allowed(input.rawSessionId)) return fail();
            delivered++;
        }
        if (!same() || !allowed(input.rawSessionId)) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function hasRetainedReportedEffects(dataDir: string, blocked: (id: string) => boolean): boolean {
    const path = join(dataDir, AGENT_CLOSURE_DB_FILE);
    let cursor = 0;
    do {
        const page = readAgentClosureEffectPage(path, { cursor });
        if (!page) return false;
        for (const row of page.entries) {
            if (!blocked(row.record.sessionId) && reportedEffectEvidenceRecord(row.record.sessionId, row.record, row.eventId)) return true;
        }
        if (!page.hasMore) return false;
        if (page.nextCursor <= cursor) throw new Error('reported-effect-cursor-invalid');
        cursor = page.nextCursor;
    } while (true);
}
export function createReportedEffectEvidenceScheduler(input: {
    readonly dataDir: string; readonly ledger: Pick<AgentEvidenceLedger, 'append'>;
    readonly allowed: (id: string) => boolean; readonly onFailure?: () => void;
}) {
    const path = join(input.dataDir, AGENT_CLOSURE_DB_FILE);
    const scheduler = createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (rawSessionId, limit, cursor, allowed) =>
            reconcileReportedEffectEvidence({ path, rawSessionId, allowed, ledger: input.ledger, limit, cursor }) });
    return Object.freeze({ ...scheduler, recoverRetained() {
        try {
            let cursor = 0;
            do {
                const page = readAgentClosureEffectPage(path, { cursor });
                if (!page) return;
                for (const row of page.entries) scheduler.schedule(row.record.sessionId);
                if (!page.hasMore) return;
                if (page.nextCursor <= cursor) throw new Error('reported-effect-cursor-invalid');
                cursor = page.nextCursor;
            } while (true);
        } catch { try { input.onFailure?.(); } catch { /* diagnostic only */ } }
    } });
}
