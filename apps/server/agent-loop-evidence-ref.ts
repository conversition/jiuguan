/** @author Codex @date 2026-10-27 @version 1.0
 * CX-4 adapter for the immutable Agent Evidence archive.
 * The resolver exposes location metadata only; expansion remains separately authorized.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
    agentEvidenceRecordDigest,
    normalizeAgentEvidenceEnvelope,
} from '@jiuguan/skill-hub';
import { opaqueLearningToken } from '../../packages/memory/public/learning-outbox.ts';
import {
    AgentEvidenceLedger,
    type StoredAgentEvidenceRecord,
} from './agent-evidence-ledger.ts';
import type {
    AgentLoopRefResolution,
    AgentLoopRefResolverRequest,
} from './agent-loop-continuation.ts';

export interface AgentLoopEvidenceReadAccess {
    readonly rawSessionId: string;
    readonly readAllowed: true;
}

type ReadFailure = Readonly<{ status: 'missing' | 'forbidden' | 'unresolved' }>;
type EvidenceRead = Readonly<{ status: 'found'; evidence: StoredAgentEvidenceRecord }> | ReadFailure;

export type AgentLoopEvidenceExpansion =
    | Readonly<{ status: 'found'; tokens: number; evidence: StoredAgentEvidenceRecord }>
    | Readonly<{ status: 'budget-exhausted'; tokens: number }>
    | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'unresolved' }>;

const RAW_SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const LOADER = /^agent-evidence-loader:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/u;
const MAX_EXPANSION_TOKENS = 65_536;
const MAX_LOADER_REF_CHARS = 2_048;
const AUTHORITY_PROBE = `sha256:${'0'.repeat(64)}`;
// Capture during module evaluation so neither an instance override nor a later
// writable-prototype replacement can become the adapter's evidence authority.
const AGENT_EVIDENCE_GET = AgentEvidenceLedger.prototype.get;

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainDataObject(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
        const ownKeys = Reflect.ownKeys(input);
        if (ownKeys.length !== keys.length
            || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
        return ownKeys.every((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
        });
    } catch {
        return false;
    }
}

function canonicalTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value;
}

function normalizeStored(input: unknown): StoredAgentEvidenceRecord {
    if (!isPlainDataObject(input, ['record', 'recordDigest', 'ingestedAt', 'sourceStatus'])
        || typeof input.recordDigest !== 'string' || !DIGEST.test(input.recordDigest)
        || !canonicalTimestamp(input.ingestedAt) || input.sourceStatus !== 'unchecked') {
        throw new TypeError('agent-loop-evidence-record-invalid');
    }
    const record = normalizeAgentEvidenceEnvelope(input.record);
    if (agentEvidenceRecordDigest(record) !== input.recordDigest) {
        throw new TypeError('agent-loop-evidence-record-invalid');
    }
    return Object.freeze({
        record,
        recordDigest: input.recordDigest,
        ingestedAt: input.ingestedAt,
        sourceStatus: 'unchecked',
    });
}

function estimateTokens(evidence: StoredAgentEvidenceRecord): number {
    // Byte length is a conservative upper bound for this compact metadata-only envelope.
    return Buffer.byteLength(JSON.stringify(evidence), 'utf8');
}

/** Trusted composition only. This factory installs no production resolver or route by itself. */
export function createAgentLoopEvidenceRefAdapter(options: Readonly<{
    ledger: AgentEvidenceLedger;
    rawSessionId: string;
    readAccess: () => AgentLoopEvidenceReadAccess | null;
}>) {
    if (!isPlainDataObject(options, ['ledger', 'rawSessionId', 'readAccess'])) {
        throw new TypeError('agent-loop-evidence-adapter-invalid');
    }
    const { ledger, rawSessionId, readAccess } = options;
    if (typeof rawSessionId !== 'string' || !RAW_SESSION_ID.test(rawSessionId)
        || nodeTypes.isProxy(ledger) || !(ledger instanceof AgentEvidenceLedger)
        || typeof readAccess !== 'function' || nodeTypes.isProxy(readAccess)) {
        throw new TypeError('agent-loop-evidence-adapter-invalid');
    }
    const sessionId = opaqueLearningToken('session', rawSessionId);
    const ownerRef = `agent-evidence-owner:${sessionId}`;

    function authorize(): boolean {
        try {
            const access = readAccess();
            return isPlainDataObject(access, ['rawSessionId', 'readAllowed'])
                && access.rawSessionId === rawSessionId && access.readAllowed === true;
        } catch {
            return false;
        }
    }

    // Keep a denied adapter constructible without touching Ledger state, but
    // prove the concrete private brand before an already-authorized adapter can read.
    if (authorize()) {
        try {
            AGENT_EVIDENCE_GET.call(ledger, AUTHORITY_PROBE);
        } catch {
            throw new TypeError('agent-loop-evidence-adapter-invalid');
        }
    }

    function read(evidenceId: string): EvidenceRead {
        if (!authorize()) return Object.freeze({ status: 'forbidden' });
        let first: unknown;
        let second: unknown;
        let failed = false;
        try {
            first = AGENT_EVIDENCE_GET.call(ledger, evidenceId);
            second = AGENT_EVIDENCE_GET.call(ledger, evidenceId);
        } catch {
            failed = true;
        }
        if (!authorize()) return Object.freeze({ status: 'forbidden' });
        if (failed) return Object.freeze({ status: 'unresolved' });
        if (first === null && second === null) return Object.freeze({ status: 'missing' });
        if (first === null || second === null) return Object.freeze({ status: 'unresolved' });
        try {
            const before = normalizeStored(first);
            const after = normalizeStored(second);
            if (before.record.sessionId !== sessionId || after.record.sessionId !== sessionId) {
                return Object.freeze({ status: 'forbidden' });
            }
            if (before.record.evidenceId !== evidenceId || after.record.evidenceId !== evidenceId
                || before.recordDigest !== after.recordDigest
                || before.ingestedAt !== after.ingestedAt) {
                return Object.freeze({ status: 'unresolved' });
            }
            return Object.freeze({ status: 'found', evidence: after });
        } catch {
            return Object.freeze({ status: 'unresolved' });
        }
    }

    function loaderRef(evidence: StoredAgentEvidenceRecord): string {
        return `agent-evidence-loader:${evidence.record.evidenceId.slice(7)}:${evidence.recordDigest.slice(7)}:`
            + hash(`${ownerRef}\0${evidence.ingestedAt}`);
    }

    function validResolverRequest(input: unknown): input is AgentLoopRefResolverRequest {
        if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) return false;
        const hasExpectedRevision = Object.hasOwn(input, 'expectedRevision');
        const request = input as Partial<AgentLoopRefResolverRequest>;
        const keys = ['refId', 'kind', 'ownerRef', 'expectedDigest',
            ...(hasExpectedRevision ? ['expectedRevision'] : [])];
        return isPlainDataObject(input, keys)
            && typeof request.refId === 'string' && DIGEST.test(request.refId)
            && request.kind === 'evidence-ledger'
            && typeof request.ownerRef === 'string' && TOKEN.test(request.ownerRef)
            && typeof request.expectedDigest === 'string' && DIGEST.test(request.expectedDigest)
            && (!hasExpectedRevision || request.expectedRevision === undefined
                || (typeof request.expectedRevision === 'string' && TOKEN.test(request.expectedRevision)));
    }

    const adapter = Object.freeze({
        ownerRef,
        /** CX-4 receives only actual digest/revision and an opaque, non-authorizing loader. */
        resolve(input: AgentLoopRefResolverRequest): AgentLoopRefResolution {
            if (!validResolverRequest(input) || input.ownerRef !== ownerRef) {
                return Object.freeze({ status: 'forbidden' });
            }
            const current = read(input.refId);
            if (current.status !== 'found') {
                if (current.status === 'missing') return Object.freeze({ status: 'missing' });
                if (current.status === 'forbidden') return Object.freeze({ status: 'forbidden' });
                // The core contract maps a found location without a digest to unresolved.
                return Object.freeze({ status: 'found' });
            }
            const { evidence } = current;
            if (evidence.recordDigest !== input.expectedDigest) {
                return Object.freeze({
                    status: 'digest-mismatch', revision: evidence.ingestedAt, digest: evidence.recordDigest,
                });
            }
            if (input.expectedRevision !== undefined && input.expectedRevision !== evidence.ingestedAt) {
                return Object.freeze({
                    status: 'stale', revision: evidence.ingestedAt, digest: evidence.recordDigest,
                });
            }
            const tokens = estimateTokens(evidence);
            return Object.freeze({
                status: 'found',
                revision: evidence.ingestedAt,
                digest: evidence.recordDigest,
                expandable: Object.freeze({ loaderRef: loaderRef(evidence), tokens }),
            });
        },
        /** Re-authorizes and re-reads the immutable ledger; loaderRef never grants access. */
        expand(input: Readonly<{ loaderRef: string; budgetTokens: number }>): AgentLoopEvidenceExpansion {
            if (!isPlainDataObject(input, ['loaderRef', 'budgetTokens'])
                || typeof input.loaderRef !== 'string'
                || !Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 0
                || input.budgetTokens > MAX_EXPANSION_TOKENS) {
                return Object.freeze({ status: 'forbidden' });
            }
            const { loaderRef, budgetTokens } = input;
            // A valid loader is fixed-size and far below this bound. Reject hostile
            // inputs before regex work so parsing cost remains explicitly bounded.
            if (loaderRef.length > MAX_LOADER_REF_CHARS) {
                return Object.freeze({ status: 'forbidden' });
            }
            const match = LOADER.exec(loaderRef);
            if (!match) return Object.freeze({ status: 'forbidden' });
            const current = read(`sha256:${match[1]}`);
            if (current.status !== 'found') return current;
            const { evidence } = current;
            if (evidence.recordDigest !== `sha256:${match[2]}`) {
                return Object.freeze({ status: 'digest-mismatch' });
            }
            if (hash(`${ownerRef}\0${evidence.ingestedAt}`) !== match[3]) {
                return Object.freeze({ status: 'stale' });
            }
            const tokens = estimateTokens(evidence);
            if (tokens > budgetTokens) {
                return Object.freeze({ status: 'budget-exhausted', tokens });
            }
            return Object.freeze({ status: 'found', tokens, evidence });
        },
    });
    return adapter;
}
