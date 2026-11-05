/** Variable original application and rollback evidence, without inventing an Agent Task. */
import { agentEvidenceRecordDigest, variableInvalidationEvidenceId } from '@jiuguan/skill-hub';
import { variablePatchApplyInvalidationKey, VARIABLE_PATCH_APPLY_ROLLBACK_KINDS } from '../../../packages/memory/public/variable-patch-apply-evidence.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { readVariablePatchApplyWithInvalidations } from '../variable-patch-apply-recovery.ts';
import { variableApplyEvidenceRecord } from './variable-apply-evidence.ts';
import { variableInvalidationEvidenceRecord } from './variable-invalidation-evidence.ts';

export interface VariableApplyEvidencePageV2 {
    readonly version: 'variable-apply-evidence-page-v2';
    /** Historical application and observed rollback only, not current variable validity. */
    readonly entries: readonly Readonly<{ evidenceId: string; occurredAt: string;
        execution: 'unknown'; verification: 'unknown'; adoption: 'unknown'; effect: 'unknown';
        commit: Readonly<{ state: 'committed' | 'rolled-back' | 'rollback-pending';
            rollbacks: readonly Readonly<{ evidenceId: string; occurredAt: string;
                kind: 'round-delete' | 'regenerate-state-only' }>[] }> }> [];
    readonly nextCursor: number; readonly hasMore: boolean;
}
export function readVariableApplyEvidencePageV2(input: {
    readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
    readonly ledger: Pick<AgentEvidenceLedger, 'get' | 'list'>; readonly limit: number; readonly cursor: number;
}): VariableApplyEvidencePageV2 | null {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10
        || !Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new Error('variable-evidence-page-invalid');
    let denied = false;
    const allowed = (id: string) => { if (denied || id !== input.rawSessionId) return false;
        try { if (input.allowed(id) === true) return true; } catch {} denied = true; return false; };
    if (!allowed(input.rawSessionId)) return null;
    const ledgerPage = input.ledger.list({ rawSessionId: input.rawSessionId, limit: input.limit, cursor: input.cursor });
    if (!allowed(input.rawSessionId) || ledgerPage.failed) return null;
    const entries: VariableApplyEvidencePageV2['entries'][number][] = [];
    const captures: { id: string; value: unknown }[] = [];
    const sources: { read: () => unknown; value: unknown }[] = [];
    for (const stored of ledgerPage.records) {
        const apply = stored.record;
        if (apply.eventType !== 'variable-patch-applied' || apply.sourceType !== 'variable-proposal-skill-adoption-v1') continue;
        const read = () => readVariablePatchApplyWithInvalidations({ path: input.path, rawSessionId: input.rawSessionId,
            runId: apply.producerRunId, allowed });
        const first = read();
        if (!first || !allowed(input.rawSessionId)) return null;
        const original = variableApplyEvidenceRecord(input.rawSessionId, first);
        if (!original || agentEvidenceRecordDigest(original) !== stored.recordDigest
            || JSON.stringify(original) !== JSON.stringify(apply)) return null;
        for (const kind of VARIABLE_PATCH_APPLY_ROLLBACK_KINDS) {
            const key = variablePatchApplyInvalidationKey(first.evidence.receiptDigest, kind);
            if (first.invalidations.some(marker => marker.controlKey === key)) continue;
            const id = variableInvalidationEvidenceId(apply.sessionId, key);
            const absent = input.ledger.get(id);
            if (!allowed(input.rawSessionId) || absent !== null) return null;
            captures.push({ id, value: absent });
        }
        const rollbacks: { evidenceId: string; occurredAt: string; kind: 'round-delete' | 'regenerate-state-only' }[] = [];
        let pending = false;
        for (const marker of first.invalidations) {
            const record = variableInvalidationEvidenceRecord(input.rawSessionId, { ...first, invalidation: marker });
            if (!record || record.appliedEvidenceId !== apply.evidenceId || record.appliedRecordDigest !== stored.recordDigest) return null;
            const archived = input.ledger.get(record.evidenceId);
            if (!allowed(input.rawSessionId)) return null;
            captures.push({ id: record.evidenceId, value: archived });
            if (!archived) { pending = true; continue; }
            if (archived.recordDigest !== agentEvidenceRecordDigest(record)
                || JSON.stringify(archived.record) !== JSON.stringify(record)) return null;
            rollbacks.push(Object.freeze({ evidenceId: record.evidenceId, occurredAt: record.occurredAt, kind: record.rollbackKind }));
        }
        if (JSON.stringify(read()) !== JSON.stringify(first) || !allowed(input.rawSessionId)) return null;
        sources.push({ read, value: first });
        entries.push(Object.freeze({ evidenceId: apply.evidenceId, occurredAt: apply.occurredAt,
            execution: 'unknown', verification: 'unknown', adoption: 'unknown', effect: 'unknown',
            commit: Object.freeze({ state: pending ? 'rollback-pending' : rollbacks.length ? 'rolled-back' : 'committed',
                rollbacks: Object.freeze(rollbacks) }) }));
    }
    for (const source of sources) if (!allowed(input.rawSessionId) || JSON.stringify(source.read()) !== JSON.stringify(source.value)) return null;
    for (const stored of ledgerPage.records) if (JSON.stringify(input.ledger.get(stored.record.evidenceId)) !== JSON.stringify(stored)) return null;
    for (const capture of captures) if (JSON.stringify(input.ledger.get(capture.id)) !== JSON.stringify(capture.value)) return null;
    if (!allowed(input.rawSessionId) || JSON.stringify(input.ledger.list({ rawSessionId: input.rawSessionId,
        limit: input.limit, cursor: input.cursor })) !== JSON.stringify(ledgerPage) || !allowed(input.rawSessionId)) return null;
    return Object.freeze({ version: 'variable-apply-evidence-page-v2', entries: Object.freeze(entries),
        nextCursor: ledgerPage.nextCursor, hasMore: ledgerPage.hasMore });
}
