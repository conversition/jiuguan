/** Body-free original approval and regeneration facts; neither record grants quality or learning authority. */
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
import type { AgentEvidenceProposalRejectionRecordV1 } from './proposal-rejection-evidence.ts';

export const AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION = 'agent-evidence-proposal-approval-v1' as const;
export const AGENT_EVIDENCE_REGENERATION_RECORD_VERSION = 'agent-evidence-regeneration-v1' as const;
export const AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION = 'agent-evidence-variable-apply-v1' as const;

/** A committed patch linked to its original Skill request; no card or mode was recorded. */
export interface AgentEvidenceVariableApplyRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'variable-patch-applied';
    readonly sessionId: string;
    readonly sourceType: 'variable-proposal-skill-adoption-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly requestReceiptDigest: string;
    readonly applyReceiptDigest: string;
    readonly producerRunId: string;
    readonly round: number;
    readonly occurredAt: string;
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}
export type AgentEvidenceVariableApplyRecordInputV1 = Omit<AgentEvidenceVariableApplyRecordV1, 'evidenceId'>;

/** Approval is the original proposal decision, not adoption, execution success, or positive Skill feedback. */
export interface AgentEvidenceProposalApprovalRecordV1 extends Omit<AgentEvidenceProposalRejectionRecordV1,
    'recordVersion' | 'eventType' | 'sourceType'> {
    readonly recordVersion: typeof AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION;
    readonly eventType: 'proposal-approved';
    readonly sourceType: 'maintenance-proposal-approval-v1';
}

export type AgentEvidenceProposalApprovalRecordInputV1 = Omit<AgentEvidenceProposalApprovalRecordV1, 'evidenceId'>;

/** A historical replacement operation, never a quality verdict about either the old or new output. */
export interface AgentEvidenceRegenerationRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_REGENERATION_RECORD_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'history-regenerated';
    readonly sessionId: string;
    readonly cardId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly sourceType: 'session-learning-regenerate-v1';
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    /** Legacy original events may not have producer identity; missing identity must remain null. */
    readonly producerRunId: string | null;
    readonly round: number;
    readonly occurredAt: string;
    readonly replacedSourceRevisionDigest: string | null;
    readonly attributionKind: 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}

export type AgentEvidenceRegenerationRecordInputV1 = Omit<AgentEvidenceRegenerationRecordV1, 'evidenceId'>;

const APPROVAL_CORE_KEYS = new Set([
    'recordVersion', 'eventType', 'sessionId', 'sourceType', 'sourceRef', 'sourceDigest', 'artifactDigest',
    'producerRunId', 'taskKind', 'proposalRevision', 'occurredAt', 'decisionReasonDigest', 'attributionKind',
    'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight',
]);
const APPROVAL_RECORD_KEYS = new Set([...APPROVAL_CORE_KEYS, 'evidenceId']);
const REGENERATION_CORE_KEYS = new Set([
    'recordVersion', 'eventType', 'sessionId', 'cardId', 'contentMode', 'sourceType', 'sourceRef',
    'sourceDigest', 'artifactDigest', 'producerRunId', 'round', 'occurredAt', 'replacedSourceRevisionDigest',
    'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight',
]);
const REGENERATION_RECORD_KEYS = new Set([...REGENERATION_CORE_KEYS, 'evidenceId']);
const VARIABLE_APPLY_CORE_KEYS = new Set([
    'recordVersion', 'eventType', 'sessionId', 'sourceType', 'sourceRef', 'sourceDigest', 'artifactDigest',
    'requestReceiptDigest', 'applyReceiptDigest', 'producerRunId', 'round', 'occurredAt', 'attributionKind',
    'manifestDigests', 'candidateDigests', 'executionClass', 'effectOutcome', 'learningWeight',
]);
const VARIABLE_APPLY_RECORD_KEYS = new Set([...VARIABLE_APPLY_CORE_KEYS, 'evidenceId']);

function assertDataRecord(input: unknown, keys: ReadonlySet<string>): asserts input is Record<string, unknown> {
    assertPlainRecord(input, 'feedbackEvidence');
    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('feedbackEvidence must contain only enumerable data fields');
        }
    }
    assertExactKeys(input, keys, keys, 'feedbackEvidence');
}

function canonicalString(value: unknown, field: string, validate: (input: unknown, label: string) => string): string {
    const result = validate(value, `feedbackEvidence.${field}`);
    if (result !== value) throw new TypeError(`feedbackEvidence.${field} must already be canonical`);
    return result;
}

function emptyDigests(value: unknown, field: string): readonly string[] {
    if (!Array.isArray(value) || value.length !== 0 || Reflect.ownKeys(value).length !== 1) {
        throw new TypeError(`feedbackEvidence.${field} must be an empty data array`);
    }
    return Object.freeze([]);
}

function historicalOnly(input: Record<string, unknown>): Readonly<{
    attributionKind: 'unattributed'; manifestDigests: readonly string[]; candidateDigests: readonly string[];
    executionClass: 'unknown'; effectOutcome: 'unknown'; learningWeight: 0;
}> {
    if (!Object.is(input.learningWeight, 0)) throw new TypeError('feedbackEvidence.learningWeight must be canonical zero');
    return {
        attributionKind: member(input.attributionKind, ['unattributed'] as const, 'feedbackEvidence.attributionKind'),
        manifestDigests: emptyDigests(input.manifestDigests, 'manifestDigests'),
        candidateDigests: emptyDigests(input.candidateDigests, 'candidateDigests'),
        executionClass: member(input.executionClass, ['unknown'] as const, 'feedbackEvidence.executionClass'),
        effectOutcome: member(input.effectOutcome, ['unknown'] as const, 'feedbackEvidence.effectOutcome'),
        learningWeight: 0,
    };
}

function normalizeApprovalCore(input: Record<string, unknown>): AgentEvidenceProposalApprovalRecordInputV1 {
    if (input.recordVersion !== AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION) {
        throw new TypeError(`feedbackEvidence.recordVersion must be ${AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION}`);
    }
    return deepFreeze({
        recordVersion: AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION,
        eventType: member(input.eventType, ['proposal-approved'] as const, 'feedbackEvidence.eventType'),
        sessionId: canonicalString(input.sessionId, 'sessionId', stableToken),
        sourceType: member(input.sourceType, ['maintenance-proposal-approval-v1'] as const, 'feedbackEvidence.sourceType'),
        sourceRef: canonicalString(input.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonicalString(input.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonicalString(input.artifactDigest, 'artifactDigest', sha256Digest),
        producerRunId: canonicalString(input.producerRunId, 'producerRunId', stableToken),
        taskKind: member(input.taskKind, ['memory_consolidation', 'rolling_summary', 'branch_index', 'npc_state'] as const,
            'feedbackEvidence.taskKind'),
        proposalRevision: safeInteger(input.proposalRevision, 'feedbackEvidence.proposalRevision', 2),
        occurredAt: canonicalString(input.occurredAt, 'occurredAt', isoTimestamp),
        decisionReasonDigest: canonicalString(input.decisionReasonDigest, 'decisionReasonDigest', sha256Digest),
        ...historicalOnly(input),
    });
}

function normalizeRegenerationCore(input: Record<string, unknown>): AgentEvidenceRegenerationRecordInputV1 {
    if (input.recordVersion !== AGENT_EVIDENCE_REGENERATION_RECORD_VERSION) {
        throw new TypeError(`feedbackEvidence.recordVersion must be ${AGENT_EVIDENCE_REGENERATION_RECORD_VERSION}`);
    }
    return deepFreeze({
        recordVersion: AGENT_EVIDENCE_REGENERATION_RECORD_VERSION,
        eventType: member(input.eventType, ['history-regenerated'] as const, 'feedbackEvidence.eventType'),
        sessionId: canonicalString(input.sessionId, 'sessionId', stableToken),
        cardId: canonicalString(input.cardId, 'cardId', stableToken),
        contentMode: member(input.contentMode, ['nsf', 'nsfw'] as const, 'feedbackEvidence.contentMode'),
        sourceType: member(input.sourceType, ['session-learning-regenerate-v1'] as const, 'feedbackEvidence.sourceType'),
        sourceRef: canonicalString(input.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonicalString(input.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonicalString(input.artifactDigest, 'artifactDigest', sha256Digest),
        producerRunId: input.producerRunId === null ? null : canonicalString(input.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(input.round, 'feedbackEvidence.round', 1),
        occurredAt: canonicalString(input.occurredAt, 'occurredAt', isoTimestamp),
        replacedSourceRevisionDigest: input.replacedSourceRevisionDigest === null ? null
            : canonicalString(input.replacedSourceRevisionDigest, 'replacedSourceRevisionDigest', sha256Digest),
        ...historicalOnly(input),
    });
}

function normalizeVariableApplyCore(input: Record<string, unknown>): AgentEvidenceVariableApplyRecordInputV1 {
    if (input.recordVersion !== AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION)
        throw new TypeError('feedbackEvidence.variableApplyVersion invalid');
    return deepFreeze({
        recordVersion: AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION,
        eventType: member(input.eventType, ['variable-patch-applied'] as const, 'feedbackEvidence.eventType'),
        sessionId: canonicalString(input.sessionId, 'sessionId', stableToken),
        sourceType: member(input.sourceType, ['variable-proposal-skill-adoption-v1'] as const, 'feedbackEvidence.sourceType'),
        sourceRef: canonicalString(input.sourceRef, 'sourceRef', stableToken),
        sourceDigest: canonicalString(input.sourceDigest, 'sourceDigest', sha256Digest),
        artifactDigest: canonicalString(input.artifactDigest, 'artifactDigest', sha256Digest),
        requestReceiptDigest: canonicalString(input.requestReceiptDigest, 'requestReceiptDigest', sha256Digest),
        applyReceiptDigest: canonicalString(input.applyReceiptDigest, 'applyReceiptDigest', sha256Digest),
        producerRunId: canonicalString(input.producerRunId, 'producerRunId', stableToken),
        round: safeInteger(input.round, 'feedbackEvidence.round', 1),
        occurredAt: canonicalString(input.occurredAt, 'occurredAt', isoTimestamp),
        ...historicalOnly(input),
    });
}

function evidenceIdentity(core: Readonly<{
    recordVersion: string; eventType: string; sessionId: string; sourceType: string; sourceRef: string;
}>): string {
    return digestCanonical({
        recordVersion: core.recordVersion, eventType: core.eventType, sessionId: core.sessionId,
        sourceType: core.sourceType, sourceRef: core.sourceRef,
    });
}

export function createAgentEvidenceVariableApplyRecord(input: unknown): AgentEvidenceVariableApplyRecordV1 {
    assertDataRecord(input, VARIABLE_APPLY_CORE_KEYS);
    const core = normalizeVariableApplyCore(input);
    return deepFreeze({ ...core, evidenceId: evidenceIdentity(core) });
}

export function normalizeAgentEvidenceVariableApplyRecord(input: unknown): AgentEvidenceVariableApplyRecordV1 {
    assertDataRecord(input, VARIABLE_APPLY_RECORD_KEYS);
    const core = normalizeVariableApplyCore(input);
    const evidenceId = canonicalString(input.evidenceId, 'evidenceId', sha256Digest);
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('feedbackEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}

/** Stable per original decision; altered payloads conflict in persistence rather than replacing history. */
export function createAgentEvidenceProposalApprovalRecord(input: unknown): AgentEvidenceProposalApprovalRecordV1 {
    assertDataRecord(input, APPROVAL_CORE_KEYS);
    const core = normalizeApprovalCore(input);
    return deepFreeze({ ...core, evidenceId: evidenceIdentity(core) });
}

export function normalizeAgentEvidenceProposalApprovalRecord(input: unknown): AgentEvidenceProposalApprovalRecordV1 {
    assertDataRecord(input, APPROVAL_RECORD_KEYS);
    const core = normalizeApprovalCore(input);
    const evidenceId = canonicalString(input.evidenceId, 'evidenceId', sha256Digest);
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('feedbackEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}

/** Stable per original regenerate event, including historical events whose producer is unknown. */
export function createAgentEvidenceRegenerationRecord(input: unknown): AgentEvidenceRegenerationRecordV1 {
    assertDataRecord(input, REGENERATION_CORE_KEYS);
    const core = normalizeRegenerationCore(input);
    return deepFreeze({ ...core, evidenceId: evidenceIdentity(core) });
}

export function normalizeAgentEvidenceRegenerationRecord(input: unknown): AgentEvidenceRegenerationRecordV1 {
    assertDataRecord(input, REGENERATION_RECORD_KEYS);
    const core = normalizeRegenerationCore(input);
    const evidenceId = canonicalString(input.evidenceId, 'evidenceId', sha256Digest);
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('feedbackEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}
