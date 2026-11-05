/** Body-free evidence of an original pending proposal rejection, never semantic feedback or Skill attribution. */
import {
    assertExactKeys,
    assertPlainRecord,
    deepFreeze,
    digestCanonical,
    isoTimestamp,
    member,
    safeInteger,
    sha256Digest,
    stableToken,
} from './internal.ts';

export const AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION = 'agent-evidence-proposal-rejection-v1' as const;

/** A historical decision fact. It does not assert consumption, effect, quality, or authorization. */
export interface AgentEvidenceProposalRejectionRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'proposal-rejected';
    readonly sessionId: string;
    readonly sourceType: 'maintenance-pending-proposal-v1';
    readonly sourceRef: string;
    /** Hash of the complete authoritative rejected proposal record and its original producer job. */
    readonly sourceDigest: string;
    /** The original proposal digest, without proposal content. */
    readonly artifactDigest: string;
    readonly producerRunId: string;
    readonly taskKind: 'memory_consolidation' | 'rolling_summary' | 'branch_index' | 'npc_state';
    readonly proposalRevision: number;
    /** The original durable decision timestamp, not the archive time. */
    readonly occurredAt: string;
    readonly decisionReasonDigest: string;
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}

export type AgentEvidenceProposalRejectionRecordInputV1 = Omit<AgentEvidenceProposalRejectionRecordV1, 'evidenceId'>;

const CORE_KEYS = new Set([
    'recordVersion', 'eventType', 'sessionId', 'sourceType', 'sourceRef', 'sourceDigest', 'artifactDigest',
    'producerRunId', 'taskKind', 'proposalRevision', 'occurredAt', 'decisionReasonDigest', 'attributionKind',
    'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight',
]);
const RECORD_KEYS = new Set([...CORE_KEYS, 'evidenceId']);

function assertDataRecord(input: unknown, keys: ReadonlySet<string>): asserts input is Record<string, unknown> {
    assertPlainRecord(input, 'proposalRejectionEvidence');
    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('proposalRejectionEvidence must contain only enumerable data fields');
        }
    }
    assertExactKeys(input, keys, keys, 'proposalRejectionEvidence');
}

function canonicalString(value: unknown, field: string, validate: (input: unknown, label: string) => string): string {
    const result = validate(value, `proposalRejectionEvidence.${field}`);
    if (result !== value) throw new TypeError(`proposalRejectionEvidence.${field} must already be canonical`);
    return result;
}

function emptyDigests(value: unknown, field: string): readonly string[] {
    if (!Array.isArray(value) || value.length !== 0 || Reflect.ownKeys(value).length !== 1) {
        throw new TypeError(`proposalRejectionEvidence.${field} must be an empty data array`);
    }
    return Object.freeze([]);
}

function normalizeCore(input: Record<string, unknown>): AgentEvidenceProposalRejectionRecordInputV1 {
    if (input.recordVersion !== AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION) {
        throw new TypeError(`proposalRejectionEvidence.recordVersion must be ${AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION}`);
    }
    if (!Object.is(input.learningWeight, 0)) {
        throw new TypeError('proposalRejectionEvidence.learningWeight must be canonical zero');
    }
    return deepFreeze({
        recordVersion: AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION,
        eventType: member(input.eventType, ['proposal-rejected'] as const, 'proposalRejectionEvidence.eventType'),
        sessionId: canonicalString(input.sessionId, 'sessionId', stableToken),
        sourceType: member(input.sourceType, ['maintenance-pending-proposal-v1'] as const, 'proposalRejectionEvidence.sourceType'),
        sourceRef: canonicalString(input.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonicalString(input.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonicalString(input.artifactDigest, 'artifactDigest', sha256Digest),
        producerRunId: canonicalString(input.producerRunId, 'producerRunId', stableToken),
        taskKind: member(input.taskKind, ['memory_consolidation', 'rolling_summary', 'branch_index', 'npc_state'] as const,
            'proposalRejectionEvidence.taskKind'),
        proposalRevision: safeInteger(input.proposalRevision, 'proposalRejectionEvidence.proposalRevision', 2),
        occurredAt: canonicalString(input.occurredAt, 'occurredAt', isoTimestamp),
        decisionReasonDigest: canonicalString(input.decisionReasonDigest, 'decisionReasonDigest', sha256Digest),
        attributionKind: member(input.attributionKind, ['unattributed'] as const, 'proposalRejectionEvidence.attributionKind'),
        manifestDigests: emptyDigests(input.manifestDigests, 'manifestDigests'),
        candidateDigests: emptyDigests(input.candidateDigests, 'candidateDigests'),
        executionClass: member(input.executionClass, ['unknown'] as const, 'proposalRejectionEvidence.executionClass'),
        effectOutcome: member(input.effectOutcome, ['unknown'] as const, 'proposalRejectionEvidence.effectOutcome'),
        learningWeight: 0,
    });
}

function evidenceIdentity(core: AgentEvidenceProposalRejectionRecordInputV1): string {
    return digestCanonical({
        recordVersion: core.recordVersion,
        eventType: core.eventType,
        sessionId: core.sessionId,
        sourceType: core.sourceType,
        sourceRef: core.sourceRef,
    });
}

/** Stable per original proposal; changed payloads conflict in persistence rather than replacing history. */
export function createAgentEvidenceProposalRejectionRecord(input: unknown): AgentEvidenceProposalRejectionRecordV1 {
    assertDataRecord(input, CORE_KEYS);
    const core = normalizeCore(input);
    return deepFreeze({ ...core, evidenceId: evidenceIdentity(core) });
}

/** Closed-version validation. No caller object, plaintext reason, or optimistic outcome is retained. */
export function normalizeAgentEvidenceProposalRejectionRecord(input: unknown): AgentEvidenceProposalRejectionRecordV1 {
    assertDataRecord(input, RECORD_KEYS);
    const core = normalizeCore(input);
    const evidenceId = canonicalString(input.evidenceId, 'evidenceId', sha256Digest);
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('proposalRejectionEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}
