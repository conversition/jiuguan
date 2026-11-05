/** Read only committed RP message pairs. No Session construction, retrieval, migration or RP write. */
import { lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { TurnOutcomeStore } from '../../packages/memory/public/turn-outcome.ts';
import { inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { sessionTurnCompletionDigest } from '../../packages/agent-policy/public/session-turn-completion.ts';
import { sqliteTransaction } from './sqlite-transaction.ts';
import { assertSourceSnapshot, creativeDigest, creativeToken, type DirectorSourceSnapshot } from './director-creative-contract.ts';

export function readDirectorMaterialSource(input: {
    path: string; sessionId: string; firstRound: number; lastRound: number;
    allowed(): boolean; nsfwSafetyDigest?(): string | null; now?: () => string;
}): DirectorSourceSnapshot {
    const sessionId = creativeToken.parse(input.sessionId);
    const permit = () => { if (input.allowed() !== true) throw new Error('director-source-forbidden'); };
    permit();
    if (!Number.isSafeInteger(input.firstRound) || input.firstRound < 1 || !Number.isSafeInteger(input.lastRound)
        || input.lastRound < input.firstRound || input.lastRound - input.firstRound >= 64)
        throw new Error('director-source-range-invalid');
    const before = lstatSync(input.path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('director-source-file-invalid');
    const db = new DatabaseSync(input.path, { readOnly: true });
    try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
        const snapshot = sqliteTransaction(db, () => {
            if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
                || db.prepare('PRAGMA application_id').get()?.application_id !== 0) throw new Error('director-source-schema-invalid');
            inspectSessionAuthoritySchema(db);
            const config = JSON.parse(String(db.prepare('SELECT config FROM memory_meta WHERE id=1').get()?.config));
            if (config.mode !== 'nsf' && config.mode !== 'nsfw') throw new Error('director-source-partition-denied');
            const partition: 'nsf' | 'nsfw' = config.mode;
            const safetyDigest = partition === 'nsfw' ? input.nsfwSafetyDigest?.() : undefined;
            if (partition === 'nsfw' && (!safetyDigest || !/^sha256:[a-f0-9]{64}$/u.test(safetyDigest)))
                throw new Error('director-source-partition-denied');
            const authority = db.prepare('SELECT generation,revision FROM session_authority WHERE singleton=1').get()!;
            const outcomes = new TurnOutcomeStore(db), messages: DirectorSourceSnapshot['messages'] = [];
            let bytes = 0;
            for (let round = input.firstRound; round <= input.lastRound; round++) {
                const pair = db.prepare('SELECT user_msg_id,assistant_msg_id,created FROM round_ledger WHERE round=?').get(round);
                if (!pair) throw new Error('director-source-uncommitted');
                const rows = db.prepare('SELECT id,round,role,content FROM chat_log WHERE id IN (?,?) ORDER BY id')
                    .all(pair.user_msg_id!, pair.assistant_msg_id!);
                if (rows.length !== 2 || rows[0]!.role !== 'user' || rows[1]!.role !== 'assistant'
                    || rows.some(row => row.round !== round) || rows[0]!.id !== pair.user_msg_id || rows[1]!.id !== pair.assistant_msg_id)
                    throw new Error('director-source-uncommitted');
                const matches = db.prepare(`SELECT value FROM session_control WHERE session_key=?
                    AND control_key LIKE 'completion-proof:%' AND json_extract(value,'$.assistantMessageId')=? LIMIT 2`)
                    .all(sessionId, pair.assistant_msg_id!);
                if (matches.length !== 1) throw new Error('director-source-partition-unproven');
                const original = JSON.parse(String(matches[0]!.value));
                const proof = outcomes.readCompletionProof(original.runId);
                const pin = outcomes.readCompletionPin(original.runId);
                const binding = JSON.parse(String(pair.created));
                if (!proof || !pin || proof.sessionKey !== sessionId || proof.round !== round
                    || proof.assistantMessageId !== pair.assistant_msg_id || proof.assistantDigest !== sessionTurnCompletionDigest(rows[1]!.content)
                    || binding.completionPinDigest !== pin.pinDigest || binding.completionCandidateDigest !== proof.candidateDigest)
                    throw new Error('director-source-proof-invalid');
                if (proof.contentMode !== partition) throw new Error('director-source-partition-denied');
                for (const row of rows) {
                    if (typeof row.content !== 'string') throw new Error('director-source-invalid');
                    bytes += Buffer.byteLength(row.content);
                    if (bytes > 131072) throw new Error('director-source-limit');
                    messages.push({ ref: `message:${row.id}`, messageId: Number(row.id), round,
                        role: row.role as 'user' | 'assistant', content: row.content,
                        sourceRunId: proof.runId, proofDigest: proof.proofDigest, digest: creativeDigest(row.content) });
                }
            }
            permit();
            if (partition === 'nsfw' && input.nsfwSafetyDigest?.() !== safetyDigest) throw new Error('director-source-forbidden');
            const basis = { sessionId, partition, firstRound: input.firstRound, lastRound: input.lastRound, messages,
                ...(safetyDigest ? { safetyDigest } : {}) };
            return assertSourceSnapshot({ schemaVersion: 'director-source-snapshot-v1', ...basis,
                sourceSnapshotRef: creativeDigest(basis), capturedAt: (input.now ?? (() => new Date().toISOString()))(),
                authority: { generation: String(authority.generation), revision: Number(authority.revision) } });
        }, false, 'director-source');
        permit();
        const after = lstatSync(input.path);
        if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('director-source-file-drift');
        return snapshot;
    } finally { db.close(); }
}
