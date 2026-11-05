/** @author Codex @date 2026-10-26 @version 1.1
 * Session-owned outcomes and bounded completion receipts; no Provider or second writer.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import {
    normalizeSessionTurnCompletionPin,
    normalizeSessionTurnCompletionProof,
    sessionTurnCompletionDigest,
    type SessionTurnCompletionPin,
    type SessionTurnCompletionProof,
} from '../../agent-policy/public/session-turn-completion.ts';

export type TurnOutcomeAction = 'turn' | 'regenerate';

export interface TurnOutcomeMarker {
    runId: string;
    sessionId: string;
    action: TurnOutcomeAction;
    round: number;
    assistantMessageId: number;
    revision: string;
    committedAt: string;
}

export interface CommitTurnOutcomeInput {
    runId: string;
    sessionId: string;
    action: TurnOutcomeAction;
    round: number;
    assistantMessageId: number;
    revision: string;
    committedAt?: string;
}

function requireOpaque(value: unknown, field: string, maxLength = 160): string {
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > maxLength ||
        !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
        throw new Error(`${field} 非法`);
    }
    return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} 非法`);
    return value as number;
}

function canonicalTimestamp(value: string): string {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error('committedAt 必须是 canonical ISO 时间');
    }
    return value;
}

function parseMarker(row: Record<string, unknown>): TurnOutcomeMarker {
    const action = row.action;
    if (action !== 'turn' && action !== 'regenerate') throw new Error('turn outcome action 非法');
    return {
        runId: requireOpaque(row.run_id, 'run_id'),
        sessionId: requireOpaque(row.session_id, 'session_id'),
        action,
        round: requirePositiveInteger(row.round, 'round'),
        assistantMessageId: requirePositiveInteger(row.assistant_message_id, 'assistant_message_id'),
        revision: requireOpaque(row.revision, 'revision'),
        committedAt: canonicalTimestamp(String(row.committed_at)),
    };
}

const COMPLETION_POLICY_PREFIX = 'completion-policy:';
const COMPLETION_PROOF_PREFIX = 'completion-proof:';
const COMPLETION_JSON_MAX_BYTES = 16_384;

function completionKey(prefix: string, runId: string): string {
    return `${prefix}${createHash('sha256').update(requireOpaque(runId, 'runId'), 'utf8').digest('hex')}`;
}

function parseCompletionJson(value: unknown): unknown {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > COMPLETION_JSON_MAX_BYTES) {
        throw new Error('turn-completion-storage-invalid');
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error('turn-completion-storage-invalid');
    }
}

function captureBoundInput(input: CommitTurnOutcomeInput): CommitTurnOutcomeInput {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('turn-completion-outcome-invalid');
    }
    const required = ['runId', 'sessionId', 'action', 'round', 'assistantMessageId', 'revision'];
    const keys = Reflect.ownKeys(input);
    if (
        required.some((key) => !keys.includes(key)) ||
        keys.some(
            (key) =>
                typeof key !== 'string' ||
                ![...required, 'committedAt'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'),
        )
    ) {
        throw new Error('turn-completion-outcome-invalid');
    }
    return Object.freeze({ ...input });
}

/** 会话数据库中的成功回执；调用方必须在最终写环事务内 commit。 */
export class TurnOutcomeStore {
    constructor(private readonly db: DatabaseSync) {}

    private completionRow(prefix: string, runId: string): { session_key: string; value: unknown } | null {
        const rows = this.db
            .prepare('SELECT session_key,value FROM session_control WHERE control_key=?')
            .all(completionKey(prefix, runId)) as Array<{ session_key: string; value: unknown }>;
        if (rows.length > 1) throw new Error('turn-completion-namespace-conflict');
        return rows[0] ?? null;
    }

    readCompletionPin(runId: string): SessionTurnCompletionPin | null {
        const row = this.completionRow(COMPLETION_POLICY_PREFIX, runId);
        if (!row) return null;
        const pin = normalizeSessionTurnCompletionPin(parseCompletionJson(row.value));
        if (pin.runId !== runId || pin.sessionKey !== row.session_key)
            throw new Error('turn-completion-pin-binding-invalid');
        return pin;
    }

    readCompletionProof(runId: string): SessionTurnCompletionProof | null {
        const row = this.completionRow(COMPLETION_PROOF_PREFIX, runId);
        if (!row) return null;
        const pin = this.readCompletionPin(runId);
        if (!pin || pin.sessionKey !== row.session_key) throw new Error('turn-completion-proof-binding-invalid');
        return normalizeSessionTurnCompletionProof(parseCompletionJson(row.value), pin);
    }

    /** Risk floor only: a pending critical pin never grants execution or completion. */
    hasPinnedCriticalRisk(sessionKey: string, round: number, historyEpoch: number): boolean {
        if (
            typeof sessionKey !== 'string' ||
            sessionKey.length < 1 ||
            sessionKey.length > 240 ||
            sessionKey.trim() !== sessionKey ||
            /[\u0000-\u001f\u007f]/u.test(sessionKey) ||
            !Number.isSafeInteger(round) ||
            round < 1 ||
            !Number.isSafeInteger(historyEpoch) ||
            historyEpoch < 0
        ) {
            throw new Error('turn-completion-risk-scope-invalid');
        }
        const rows = this.db
            .prepare(
                "SELECT control_key,value FROM session_control WHERE session_key=? AND control_key LIKE 'completion-policy:%'",
            )
            .all(sessionKey) as Array<{ control_key: string; value: unknown }>;
        for (const row of rows) {
            const value = parseCompletionJson(row.value);
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('turn-completion-storage-invalid');
            }
            const scope = value as { round?: unknown; historyEpoch?: unknown };
            if (scope.round !== round || scope.historyEpoch !== historyEpoch) continue;
            const pin = normalizeSessionTurnCompletionPin(value);
            if (
                pin.sessionKey !== sessionKey ||
                row.control_key !== completionKey(COMPLETION_POLICY_PREFIX, pin.runId) ||
                this.readCompletionPin(pin.runId)?.pinDigest !== pin.pinDigest
            ) {
                throw new Error('turn-completion-pin-binding-invalid');
            }
            if (pin.tier === 'key-plot') return true;
        }
        return false;
    }

    /** Returns only after the pre-Provider pin has its own durable commit. */
    pinCompletionPolicy(input: SessionTurnCompletionPin): SessionTurnCompletionPin {
        const pin = normalizeSessionTurnCompletionPin(input);
        if (this.db.isTransaction) throw new Error('turn-completion-pin-transaction-active');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const existing = this.readCompletionPin(pin.runId);
            if (existing) {
                if (JSON.stringify(existing) !== JSON.stringify(pin))
                    throw new Error('turn-completion-policy-conflict');
                this.db.exec('COMMIT');
                return existing;
            }
            // A current source may never retrofit policy authority onto old success.
            if (this.get(pin.runId) || this.completionRow(COMPLETION_PROOF_PREFIX, pin.runId)) {
                throw new Error('turn-completion-history-unbound');
            }
            this.db
                .prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
                .run(
                    pin.sessionKey,
                    completionKey(COMPLETION_POLICY_PREFIX, pin.runId),
                    JSON.stringify(pin),
                    new Date().toISOString(),
                );
            this.db.exec('COMMIT');
            return pin;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                /* Preserve the original pin failure. */
            }
            throw error;
        }
    }

    private completionCurrent(pin: SessionTurnCompletionPin, proof: SessionTurnCompletionProof): boolean {
        const epoch = this.db
            .prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(pin.sessionKey, 'history_epoch') as { value: unknown } | undefined;
        const rawEpoch = epoch?.value ?? '0';
        if (
            typeof rawEpoch !== 'string' ||
            !/^(?:0|[1-9][0-9]*)$/u.test(rawEpoch) ||
            !Number.isSafeInteger(Number(rawEpoch))
        )
            throw new Error('turn-completion-history-epoch-invalid');
        if (Number(rawEpoch) !== proof.historyEpoch) return false;
        const assistant = this.db
            .prepare('SELECT round,role,content FROM chat_log WHERE id=?')
            .get(proof.assistantMessageId) as { round: unknown; role: unknown; content: unknown } | undefined;
        if (
            !assistant ||
            assistant.round !== proof.round ||
            assistant.role !== 'assistant' ||
            typeof assistant.content !== 'string' ||
            sessionTurnCompletionDigest(assistant.content) !== proof.assistantDigest
        )
            return false;
        const ledger = this.db
            .prepare('SELECT assistant_msg_id,created FROM round_ledger WHERE round=?')
            .get(proof.round) as { assistant_msg_id: unknown; created: unknown } | undefined;
        if (!ledger || ledger.assistant_msg_id !== proof.assistantMessageId) return false;
        const created = parseCompletionJson(ledger.created);
        if (!created || typeof created !== 'object' || Array.isArray(created)) {
            throw new Error('turn-completion-ledger-invalid');
        }
        const binding = created as { completionPinDigest?: unknown; completionCandidateDigest?: unknown };
        return (
            binding.completionPinDigest === pin.pinDigest && binding.completionCandidateDigest === proof.candidateDigest
        );
    }

    private assertCompletionMarker(marker: CommitTurnOutcomeInput, proof: SessionTurnCompletionProof): void {
        if (
            marker.runId !== proof.runId ||
            marker.sessionId !== proof.sessionId ||
            marker.action !== proof.action ||
            marker.round !== proof.round ||
            marker.assistantMessageId !== proof.assistantMessageId ||
            marker.revision !== `round-${proof.round}-assistant-${proof.assistantMessageId}`
        ) {
            throw new Error('turn-completion-outcome-binding-invalid');
        }
    }

    private insertCompletionProof(pin: SessionTurnCompletionPin, proof: SessionTurnCompletionProof, at: string): void {
        this.db
            .prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(pin.sessionKey, completionKey(COMPLETION_PROOF_PREFIX, pin.runId), JSON.stringify(proof), at);
    }

    /** Direct calls retain internal completion audit, never a server Job success marker. */
    commitDirectCompletion(value: SessionTurnCompletionProof): void {
        if (!this.db.isTransaction) throw new Error('turn-completion-transaction-required');
        if (!value || typeof value !== 'object' || types.isProxy(value)) {
            throw new Error('turn-completion-proof-binding-invalid');
        }
        const run = Object.getOwnPropertyDescriptor(value, 'runId');
        if (!run || !Object.hasOwn(run, 'value')) throw new Error('turn-completion-proof-binding-invalid');
        const pin = this.readCompletionPin(requireOpaque(run.value, 'runId'));
        if (!pin) throw new Error('turn-completion-pin-missing');
        const proof = normalizeSessionTurnCompletionProof(value, pin);
        if (pin.sessionId !== `session-direct:${sessionTurnCompletionDigest(pin.sessionKey)}` || this.get(pin.runId)) {
            throw new Error('turn-completion-direct-binding-invalid');
        }
        if (!this.completionCurrent(pin, proof)) throw new Error('turn-completion-source-stale');
        const existing = this.readCompletionProof(pin.runId);
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(proof)) throw new Error('turn-completion-proof-conflict');
            return;
        }
        this.insertCompletionProof(pin, proof, new Date().toISOString());
    }

    /** The existing Session write ring must commit proof, ledger, assistant and outcome together. */
    commitBound(input: CommitTurnOutcomeInput, value: SessionTurnCompletionProof): TurnOutcomeMarker {
        if (!this.db.isTransaction) throw new Error('turn-completion-transaction-required');
        const marker = captureBoundInput(input);
        const pin = this.readCompletionPin(marker.runId);
        if (!pin) throw new Error('turn-completion-pin-missing');
        const proof = normalizeSessionTurnCompletionProof(value, pin);
        this.assertCompletionMarker(marker, proof);
        if (!this.completionCurrent(pin, proof)) throw new Error('turn-completion-source-stale');
        const existing = this.readCompletionProof(marker.runId);
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(proof) || !this.get(marker.runId)) {
                throw new Error('turn-completion-proof-conflict');
            }
        } else {
            if (this.get(marker.runId)) throw new Error('turn-completion-history-unbound');
            this.insertCompletionProof(pin, proof, canonicalTimestamp(marker.committedAt ?? new Date().toISOString()));
        }
        return this.commit(marker);
    }

    /** Historical JSON is audit only; recovery additionally checks the current branch anchor. */
    getForRecovery(runId: string): TurnOutcomeMarker | null {
        const read = () => {
            const pin = this.readCompletionPin(runId);
            const proof = this.readCompletionProof(runId);
            const marker = this.get(runId);
            if (!pin && !proof) {
                if (!marker) return null;
                const ledger = this.db.prepare('SELECT created FROM round_ledger WHERE round=?').get(marker.round) as
                    | { created?: unknown }
                    | undefined;
                let created: unknown;
                try {
                    created = typeof ledger?.created === 'string' ? JSON.parse(ledger.created) : undefined;
                } catch {
                    /* Legacy ledgers were not completion proofs and remain optional here. */
                }
                if (
                    created &&
                    typeof created === 'object' &&
                    (Object.hasOwn(created, 'completionPinDigest') ||
                        Object.hasOwn(created, 'completionCandidateDigest'))
                ) {
                    throw new Error('turn-completion-recovery-incomplete');
                }
                const assistant = this.db
                    .prepare('SELECT round,role FROM chat_log WHERE id=?')
                    .get(marker.assistantMessageId) as { round: unknown; role: unknown } | undefined;
                return assistant?.round === marker.round && assistant.role === 'assistant' ? marker : null;
            }
            if (!marker && pin && !proof) return null;
            if (
                !marker &&
                pin &&
                proof &&
                pin.sessionId === `session-direct:${sessionTurnCompletionDigest(pin.sessionKey)}`
            )
                return null;
            if (!pin || !proof || !marker) throw new Error('turn-completion-recovery-incomplete');
            this.assertCompletionMarker(marker, proof);
            return this.completionCurrent(pin, proof) ? marker : null;
        };
        if (this.db.isTransaction) return read();
        this.db.exec('BEGIN');
        try {
            const result = read();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                /* Preserve the original read failure. */
            }
            throw error;
        }
    }

    /** Resolve only a uniquely current, proof-backed committed run for one exact session/round. */
    getCurrentVerifiedOutcome(sessionIdValue: string, roundValue: number): TurnOutcomeMarker | null {
        const sessionId = requireOpaque(sessionIdValue, 'sessionId');
        if (!Number.isSafeInteger(roundValue) || roundValue < 0) throw new Error('round 非法');
        const round = roundValue;
        const read = () => {
            const meta = this.db.prepare('SELECT plot_round FROM memory_meta WHERE id=1').get() as { plot_round: unknown } | undefined;
            const chat = this.db.prepare("SELECT COALESCE(MAX(round), 0) AS round FROM chat_log WHERE role='assistant'").get() as { round: unknown };
            const plotRound = meta?.plot_round ?? 0; // Matches Session.loadRound for an uninitialized session.
            if (!Number.isSafeInteger(plotRound) || Number(plotRound) < 0
                || !Number.isSafeInteger(chat.round) || Number(chat.round) < 0
                || Math.max(Number(plotRound), Number(chat.round)) !== round) {
                throw new Error('turn-completion-round-stale');
            }
            if (round === 0) return null;
            const rows = this.db.prepare(
                'SELECT run_id FROM turn_job_outcome WHERE session_id=? AND round=? ORDER BY run_id LIMIT 257',
            ).all(sessionId, round) as Array<{ run_id: unknown }>;
            if (rows.length > 256) throw new Error('turn-completion-candidates-limit');
            let current: TurnOutcomeMarker | null = null;
            for (const row of rows) {
                const runId = requireOpaque(row.run_id, 'runId');
                const pin = this.readCompletionPin(runId);
                const proof = this.readCompletionProof(runId);
                // Old recovery markers can reuse an assistant id after regeneration. They are
                // valid for their legacy recovery contract but not a current-run identity proof.
                if (!pin && !proof) continue;
                if (!pin || !proof) throw new Error('turn-completion-recovery-incomplete');
                const marker = this.getForRecovery(runId);
                if (!marker) continue;
                if (marker.sessionId !== sessionId || marker.round !== round || marker.runId !== runId) {
                    throw new Error('turn-completion-outcome-binding-invalid');
                }
                if (current) throw new Error('turn-completion-current-ambiguous');
                current = marker;
            }
            return current ? Object.freeze(current) : null;
        };
        if (this.db.isTransaction) return read();
        this.db.exec('BEGIN');
        try {
            const result = read();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
            throw error;
        }
    }

    get(runIdValue: string): TurnOutcomeMarker | null {
        const runId = requireOpaque(runIdValue, 'runId');
        const row = this.db.prepare('SELECT * FROM turn_job_outcome WHERE run_id = ?').get(runId) as
            | Record<string, unknown>
            | undefined;
        return row ? parseMarker(row) : null;
    }

    commit(input: CommitTurnOutcomeInput): TurnOutcomeMarker {
        const marker: TurnOutcomeMarker = {
            runId: requireOpaque(input.runId, 'runId'),
            sessionId: requireOpaque(input.sessionId, 'sessionId'),
            action: input.action,
            round: requirePositiveInteger(input.round, 'round'),
            assistantMessageId: requirePositiveInteger(input.assistantMessageId, 'assistantMessageId'),
            revision: requireOpaque(input.revision, 'revision'),
            committedAt: canonicalTimestamp(input.committedAt ?? new Date().toISOString()),
        };
        if (marker.action !== 'turn' && marker.action !== 'regenerate') throw new Error('action 非法');

        const existing = this.get(marker.runId);
        if (existing) {
            if (
                existing.sessionId !== marker.sessionId ||
                existing.action !== marker.action ||
                existing.round !== marker.round ||
                existing.assistantMessageId !== marker.assistantMessageId ||
                existing.revision !== marker.revision
            ) {
                throw new Error('相同 runId 已绑定不同会话结果');
            }
            return existing;
        }

        this.db
            .prepare(
                `INSERT INTO turn_job_outcome
         (run_id, session_id, action, round, assistant_message_id, revision, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                marker.runId,
                marker.sessionId,
                marker.action,
                marker.round,
                marker.assistantMessageId,
                marker.revision,
                marker.committedAt,
            );
        return marker;
    }
}
