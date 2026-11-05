/** Original NPC writes only: no replay, new business writes, or reconstructed readback. */
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentEvidenceNpcOperationRecord } from '@jiuguan/skill-hub';
import { MemoryDb, CharacterStore, StateStore } from '../../../packages/memory/public/db.ts';
import { inspectSessionAuthoritySchema } from '../../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../../packages/memory/public/schema.ts';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { NpcMaintenanceCommitter, npcMaintenanceOperationBindings,
    type NpcMaintenanceCommitRequest } from '../npc-maintenance-committer.ts';
import { MAINTENANCE_JOB_DB_FILE, type MaintenanceJobManager } from '../maintenance-job-manager.ts';
import { resolveSessionDatabase } from '../security.ts';
import { maintenanceNpcSkillDigest } from './maintenance-npc-result-proof.ts';
import type { AgentEvidenceLedger } from '../agent-evidence-ledger.ts';
import { createEvidenceRecoveryScheduler } from './evidence-recovery-scheduler.ts';

type Sources = { readonly manager: Pick<MaintenanceJobManager, 'readNpcCommitSource' | 'scanNpcCommitSources'>;
    readonly dataDir: string };
function originalTime(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
        throw new Error('npc-evidence-native-time-invalid');
    return value;
}
export function readNpcOperationEvidence(input: Sources, rawSessionId: string, runId: string) {
    const original = input.manager.readNpcCommitSource(runId);
    if (!original) return [];
    const { source, proposal } = original, record = source.record, proof = record.proof;
    if (record.sessionId !== rawSessionId || record.jobRunId !== runId || (proposal && proposal.sessionId !== rawSessionId))
        throw new Error('npc-evidence-session-mismatch');
    if (record.terminalKind === 'noop') return [];
    if (!proposal) throw new Error('npc-evidence-proposal-missing');
    // A historical archive survives rollback. Missing original rows cannot create a first archive.
    if (proposal.status === 'rolled_back') return [];
    const path = resolveSessionDatabase(input.dataDir, `${rawSessionId}.db`);
    if (!path || !existsSync(path)) throw new Error('npc-evidence-session-missing');
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('npc-evidence-file-invalid');
    const memory = new MemoryDb({ path, readOnly: true });
    try {
        memory.db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        const records = memory.transaction(() => {
            if (memory.userVersion() !== SCHEMA_VERSION
                || memory.db.prepare('PRAGMA application_id').get()?.application_id !== 0)
                throw new Error('npc-evidence-schema-invalid');
            inspectSessionAuthoritySchema(memory.db);
            const request = { runId, proposal: proposal.proposal.payload,
                context: proposal.context as NpcMaintenanceCommitRequest['context'], provenanceDigest: proposal.proposalDigest };
            const bindings = npcMaintenanceOperationBindings(request);
            const native = new NpcMaintenanceCommitter({
                characters: new CharacterStore(memory.db, new StateStore(memory.db, () => memory.inTransaction)),
                transaction: work => memory.transaction(work),
                currentRevision: () => { throw new Error('npc-evidence-no-current-authority'); },
                resolveSourceRef: (_id, token) => {
                    const match = /^msg:([1-9][0-9]*)$/u.exec(token);
                    return match ? { source: 'message', recordId: match[1]!, recordVersion: 1 } : null;
                },
            }).recoverApplied(request);
            if (!native) {
                if (bindings.length && proposal.status === 'applied') throw new Error('npc-evidence-native-unavailable');
                return [];
            }
            if (native.status !== 'committed' || !['pending', 'applied'].includes(proposal.status))
                throw new Error('npc-evidence-native-conflict');
            return bindings.map(binding => {
                let artifact: unknown, occurredAt: string;
                if (binding.operationKind === 'character') {
                    const rows = memory.db.prepare(`SELECT * FROM character_fact_log
                        WHERE session_key=? AND character_id=? AND operation_id=? ORDER BY id LIMIT 257`)
                        .all(rawSessionId, binding.characterId, binding.operationId);
                    const actualIntents = rows.map(row => ({ field: row.field, scopeKind: row.scope_kind,
                        factKind: row.fact_kind, value: JSON.parse(String(row.value_json)), effectiveRound: row.effective_round,
                        sourceRefs: JSON.parse(String(row.source_refs)) }));
                    if (!rows.length || rows.length > 256
                        || !isDeepStrictEqual(actualIntents.map(maintenanceNpcSkillDigest).sort(),
                            binding.factIntents.map(maintenanceNpcSkillDigest).sort()))
                        throw new Error('npc-evidence-facts-incomplete');
                    const commit = memory.db.prepare('SELECT * FROM state_commit WHERE operation_id=?').get(binding.operationId);
                    const result = commit && typeof commit.result_json === 'string' ? JSON.parse(commit.result_json) : null;
                    const changes = commit && typeof commit.changes_json === 'string' ? JSON.parse(commit.changes_json) : null;
                    if (!commit || commit.scope !== 'character' || commit.scope_key !== `${rawSessionId}:${binding.characterId}`
                        || commit.branch_key !== 'main' || commit.status !== 'committed'
                        || !Number.isSafeInteger(commit.state_version) || Number(commit.state_version) < 1
                        || rows.some(row => row.entity_version !== commit.state_version || row.history_epoch !== commit.history_epoch)
                        || typeof commit.intent_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(commit.intent_hash)
                        || !Array.isArray(changes) || changes.some(value => typeof value !== 'string')
                        || !isDeepStrictEqual(result, { stateVersion: commit.state_version, changed: changes, deduped: false }))
                        throw new Error('npc-evidence-state-commit-conflict');
                    occurredAt = originalTime(commit.created_at);
                    for (const row of rows) if (originalTime(row.created_at) < occurredAt)
                        throw new Error('npc-evidence-native-time-conflict');
                    artifact = { commit, facts: rows };
                } else {
                    const row = memory.db.prepare('SELECT * FROM character_alias_operation WHERE operation_id=?').get(binding.operationId);
                    if (!row || row.session_key !== rawSessionId || row.character_id !== binding.characterId
                        || row.rolled_back_at !== null || (row.created_alias !== 0 && row.created_alias !== 1))
                        throw new Error('npc-evidence-identity-conflict');
                    if (!isDeepStrictEqual({ alias: row.alias, mentionKey: row.mention_key, sourceRefs: JSON.parse(String(row.source_refs)) },
                        binding.identityIntent)) throw new Error('npc-evidence-identity-intent-conflict');
                    occurredAt = originalTime(row.created_at);
                    artifact = row;
                }
                if (occurredAt < record.proposalCreatedAt) throw new Error('npc-evidence-native-time-conflict');
                return createAgentEvidenceNpcOperationRecord({
                    recordVersion: 'agent-evidence-npc-operation-v1', eventType: 'npc-operation-committed',
                    sessionId: opaqueLearningToken('session', rawSessionId), contentMode: proof.contentMode,
                    capabilityId: 'maintenance.npc', sourceType: 'maintenance-npc-skill-source-v1',
                    sourceRef: `npc-operation:${sha256Digest(binding.operationId)}`, sourceDigest: record.recordDigest,
                    artifactDigest: maintenanceNpcSkillDigest(artifact), operationKind: binding.operationKind,
                    producerRunId: opaqueLearningToken('run', runId), requestDigests: [...proof.requestDigests], occurredAt,
                    attributionKind: 'skill', manifestDigests: [...proof.attribution.selectedManifestDigests].sort(),
                    candidateDigests: [...proof.attribution.activeCandidateDigests].sort(), executionClass: 'unknown',
                    effectOutcome: 'unknown', learningWeight: 0,
                });
            });
        });
        const tail = lstatSync(path);
        if (!tail.isFile() || tail.isSymbolicLink() || tail.ino !== file.ino || tail.dev !== file.dev)
            throw new Error('npc-evidence-file-drift');
        return Object.freeze(records);
    } finally { memory.close(); }
}

export function reconcileNpcOperationEvidence(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean;
}, rawSessionId: string, limit = 8, cursor = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error('npc-evidence-page-invalid');
    let denied = false, attempted = 0, delivered = 0, skipped = 0;
    const allowed = () => {
        if (denied) return false;
        try { if (input.allowed(rawSessionId) === true) return true; } catch { /* fail closed */ }
        denied = true; return false;
    };
    const fail = () => Object.freeze({ attempted, delivered, skipped, failed: 1, nextCursor: cursor, hasMore: false });
    try {
        if (!allowed()) return fail();
        const page = input.manager.scanNpcCommitSources(rawSessionId, Math.min(limit, 8), cursor);
        attempted = page.attempted;
        for (const row of page.entries) {
            if (!allowed() || row.sessionId !== rawSessionId) return fail();
            const read = () => readNpcOperationEvidence(input, rawSessionId, row.runId);
            const original = read();
            if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
            if (!original.length) { skipped++; continue; }
            for (const record of original) {
                if (!allowed() || !isDeepStrictEqual(original, read())) return fail();
                const result = input.ledger.append(rawSessionId, record);
                if (result.status === 'discarded-deleted-session') { skipped++; return fail(); }
                if (!isDeepStrictEqual(original, read()) || !allowed()) return fail();
                delivered++;
            }
        }
        if (!allowed() || !isDeepStrictEqual(page, input.manager.scanNpcCommitSources(rawSessionId, Math.min(limit, 8), cursor))
            || !allowed()) return fail();
        return Object.freeze({ attempted, delivered, skipped, failed: 0, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch { return fail(); }
}
export function createNpcOperationEvidenceScheduler(input: Sources & {
    readonly ledger: Pick<AgentEvidenceLedger, 'append'>; readonly allowed: (id: string) => boolean; readonly onFailure?: () => void;
}) {
    const scheduler = createEvidenceRecoveryScheduler({ allowed: input.allowed, onFailure: input.onFailure, retryOnFailure: false,
        reconcile: async (id, limit, cursor, allowed) => reconcileNpcOperationEvidence({ ...input, allowed }, id, limit, cursor) });
    return Object.freeze({ ...scheduler, recoverRetained() {
        try {
            let cursor = 0;
            do {
                const page = input.manager.scanNpcCommitSources(undefined, 8, cursor);
                for (const row of page.entries) scheduler.schedule(row.sessionId);
                if (!page.hasMore) break;
                if (page.nextCursor <= cursor) throw new Error('npc-evidence-cursor-invalid');
                cursor = page.nextCursor;
            } while (true);
        } catch { try { input.onFailure?.(); } catch { /* diagnostic only */ } }
    } });
}

/** Discovery hint only. Archival always validates the original Manager + Session source above. */
export function hasRetainedNpcOperationEvidence(dataDir: string, isSessionDeleted: (id: string) => boolean): boolean {
    const path = join(dataDir, MAINTENANCE_JOB_DB_FILE);
    if (!existsSync(path)) return false;
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('npc-evidence-discovery-file-invalid');
    const manager = new DatabaseSync(path, { readOnly: true });
    try {
        manager.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
        if (!manager.prepare("SELECT 1 FROM sqlite_master WHERE name='maintenance_npc_skill_source'").get()) return false;
        let cursor = 0;
        do {
            const rows = manager.prepare(`SELECT rowid AS cursor,run_id,session_id FROM maintenance_npc_skill_source
                WHERE rowid>? AND terminal_kind='proposal' ORDER BY rowid LIMIT 8`)
                .all(cursor) as { cursor: number; run_id: string; session_id: string }[];
            for (const row of rows) {
                if (typeof row.session_id !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(row.run_id))
                    throw new Error('npc-evidence-discovery-invalid');
                if (isSessionDeleted(row.session_id) !== false) continue;
                const nativePath = resolveSessionDatabase(dataDir, `${row.session_id}.db`);
                if (!nativePath || !existsSync(nativePath)) continue;
                const nativeFile = lstatSync(nativePath);
                if (!nativeFile.isFile() || nativeFile.isSymbolicLink()) throw new Error('npc-evidence-discovery-file-invalid');
                const db = new DatabaseSync(nativePath, { readOnly: true });
                try {
                    db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
                    const characterPrefix = `maintenance:${row.run_id}:npc:`, identityPrefix = `maintenance:${row.run_id}:npc-identity:`;
                    if (db.prepare(`SELECT 1 FROM character_fact_log WHERE session_key=?
                        AND substr(operation_id,1,?)=? LIMIT 1`).get(row.session_id, characterPrefix.length, characterPrefix)
                        || db.prepare(`SELECT 1 FROM character_alias_operation WHERE session_key=? AND rolled_back_at IS NULL
                            AND substr(operation_id,1,?)=? LIMIT 1`).get(row.session_id, identityPrefix.length, identityPrefix)) return true;
                } finally { db.close(); }
            }
            if (rows.length < 8) return false;
            const next = rows.at(-1)!.cursor;
            if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('npc-evidence-cursor-invalid');
            cursor = next;
        } while (true);
    } finally { manager.close(); }
}
