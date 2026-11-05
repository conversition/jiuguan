import { AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION, normalizeAgentEvidenceVariableInvalidationRecord,
    type AgentEvidenceVariableInvalidationRecordV1 } from './variable-invalidation-evidence.ts';
import { AGENT_EVIDENCE_BRANCH_MODIFIED_VERSION, normalizeAgentEvidenceBranchModifiedRecord,
    type AgentEvidenceBranchModifiedRecordV1 } from './branch-modified-evidence.ts';
import { AGENT_EVIDENCE_REPORTED_EFFECT_VERSION, normalizeAgentEvidenceReportedEffectRecord,
    type AgentEvidenceReportedEffectRecordV1 } from './reported-effect-evidence.ts';
import { AGENT_EVIDENCE_BRANCH_ATTRIBUTION_VERSION, normalizeAgentEvidenceBranchAttributionRecord,
    type AgentEvidenceBranchAttributionRecordV1 } from './branch-attribution-evidence.ts';
import { AGENT_EVIDENCE_PREFERENCE_INFERENCE_VERSION, normalizeAgentEvidencePreferenceInferenceRecord,
    type AgentEvidencePreferenceInferenceRecordV1 } from './preference-inference-evidence.ts';
import { AGENT_EVIDENCE_AQL_ADVISORY_VERSION, normalizeAgentEvidenceAqlAdvisoryRecord,
    type AgentEvidenceAqlAdvisoryRecordV1 } from './aql-advisory-evidence.ts';
/**
 * @author  : Codex
 * @time    : 2026-10-16
 * @function: Pure, body-free historical Agent evidence envelope; never authority or positive learning.
 * @version : v1.0
 */
import {
    assertExactKeys,
    assertPlainRecord,
    compareText,
    deepFreeze,
    digestCanonical,
    isoTimestamp,
    member,
    sha256Digest,
    stableToken,
} from './internal.ts';
import {
    AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION,
    normalizeAgentEvidenceProposalRejectionRecord,
    type AgentEvidenceProposalRejectionRecordV1,
} from './proposal-rejection-evidence.ts';
import {
    AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION,
    AGENT_EVIDENCE_REGENERATION_RECORD_VERSION,
    AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION,
    normalizeAgentEvidenceProposalApprovalRecord,
    normalizeAgentEvidenceRegenerationRecord,
    normalizeAgentEvidenceVariableApplyRecord,
    type AgentEvidenceProposalApprovalRecordV1,
    type AgentEvidenceRegenerationRecordV1,
    type AgentEvidenceVariableApplyRecordV1,
} from './feedback-evidence.ts';
import { AGENT_EVIDENCE_SCENE_CONSUMPTION_VERSION, normalizeAgentEvidenceSceneConsumptionRecord,
    type AgentEvidenceSceneConsumptionRecordV1 } from './scene-consumption-evidence.ts';
import { AGENT_EVIDENCE_ARC_COMMIT_VERSION, normalizeAgentEvidenceArcCommitRecord,
    type AgentEvidenceArcCommitRecordV1 } from './arc-commit-evidence.ts';

import { AGENT_EVIDENCE_NPC_OPERATION_VERSION, normalizeAgentEvidenceNpcOperationRecord,
    type AgentEvidenceNpcOperationRecordV1 } from './npc-operation-evidence.ts';

import { AGENT_EVIDENCE_WORLDBOOK_APPLY_VERSION, normalizeAgentEvidenceWorldbookApplyRecord,
    type AgentEvidenceWorldbookApplyRecordV1 } from './worldbook-apply-evidence.ts';

export const AGENT_EVIDENCE_RECORD_VERSION = 'agent-evidence-record-v1' as const;
export const AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION = 'agent-evidence-invalidation-v1' as const;


/** A historical consumption fact, not source validity, authorization, or a successful learning outcome. */
export interface AgentEvidenceRecordV1 {
    readonly recordVersion: typeof AGENT_EVIDENCE_RECORD_VERSION;
    readonly evidenceId: string;
    readonly eventType: 'context-consumed';
    readonly sessionId: string;
    readonly cardId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly capabilityId: string;
    readonly sourceType: string;
    readonly sourceRef: string;
    readonly sourceDigest: string;
    readonly artifactDigest: string;
    readonly consumerRunId: string;
    readonly requestDigest: string | null;
    readonly occurredAt: string;
    readonly attributionKind: 'legacy-profile' | 'skill' | 'unattributed';
    readonly manifestDigests: readonly string[];
    readonly candidateDigests: readonly string[];
    readonly executionClass: 'unknown';
    readonly effectOutcome: 'unknown';
    readonly learningWeight: 0;
}


export type AgentEvidenceRecordInputV1 = Omit<AgentEvidenceRecordV1, 'evidenceId'>;

/** An original producer rollback invalidates one exact historical consumption; it is never quality feedback. */
export interface AgentEvidenceInvalidationRecordV1 extends Omit<AgentEvidenceRecordV1,
    'recordVersion' | 'eventType' | 'sourceType' | 'requestDigest'> {
    readonly recordVersion: typeof AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION;
    readonly eventType: 'source-invalidated';
    readonly sourceType: 'maintenance-memory-rollback-v1' | 'maintenance-summary-rollback-v1';
    /** The original consumed evidence ID and complete record digest, respectively. */
    readonly sourceRef: string;
    readonly sourceDigest: string;
    /** Original durable rollback digest; occurredAt is its original timestamp. */
    readonly artifactDigest: string;
    readonly requestDigest: null;
}

export type AgentEvidenceEnvelope = AgentEvidenceRecordV1 | AgentEvidenceInvalidationRecordV1
    | AgentEvidenceProposalRejectionRecordV1 | AgentEvidenceProposalApprovalRecordV1 | AgentEvidenceRegenerationRecordV1
    | AgentEvidenceVariableApplyRecordV1 | AgentEvidenceSceneConsumptionRecordV1 | AgentEvidenceArcCommitRecordV1 | AgentEvidenceNpcOperationRecordV1 | AgentEvidenceWorldbookApplyRecordV1 | AgentEvidenceAqlAdvisoryRecordV1 | AgentEvidencePreferenceInferenceRecordV1 | AgentEvidenceBranchAttributionRecordV1 | AgentEvidenceReportedEffectRecordV1 | AgentEvidenceBranchModifiedRecordV1 | AgentEvidenceVariableInvalidationRecordV1;
export type AgentEvidenceInvalidationDomain = 'memory' | 'summary';

const MAX_DIGESTS = 64;
const CORE_KEYS = new Set([
    'recordVersion', 'eventType', 'sessionId', 'cardId', 'contentMode', 'capabilityId',
    'sourceType', 'sourceRef', 'sourceDigest', 'artifactDigest', 'consumerRunId', 'requestDigest',
    'occurredAt', 'attributionKind', 'manifestDigests', 'candidateDigests', 'executionClass',
    'effectOutcome', 'learningWeight',
]);
const RECORD_KEYS = new Set([...CORE_KEYS, 'evidenceId']);


function assertDataRecord(input: unknown, keys: ReadonlySet<string>): asserts input is Record<string, unknown> {
    assertPlainRecord(input, 'agentEvidence');
    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('agentEvidence must contain only enumerable data fields');
        }
    }
    assertExactKeys(input, keys, keys, 'agentEvidence');
}


function canonicalString(
    value: unknown,
    label: string,
    validate: (input: unknown, name: string) => string,
): string {
    const output = validate(value, label);
    if (output !== value) throw new TypeError(`${label} must already be canonical`);
    return output;
}


function opaqueToken(value: unknown, field: string): string {
    return canonicalString(value, `agentEvidence.${field}`, stableToken);
}


function digestValue(value: unknown, field: string): string {
    return canonicalString(value, `agentEvidence.${field}`, sha256Digest);
}


function digestList(value: unknown, field: string): readonly string[] {
    const label = `agentEvidence.${field}`;
    if (!Array.isArray(value) || value.length > MAX_DIGESTS) {
        throw new TypeError(`${label} must contain at most ${MAX_DIGESTS} digests`);
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError(`${label} must be a dense array without additional fields`);
    }
    const output: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must be a dense data array`);
        }
        const digest = digestValue(descriptor.value, `${field}[${index}]`);
        const previous = output[index - 1];
        if (previous !== undefined && compareText(previous, digest) >= 0) {
            throw new TypeError(`${label} must contain unique digests in canonical ascending order`);
        }
        output.push(digest);
    }
    return Object.freeze(output);
}


function normalizeCore(input: Record<string, unknown>): AgentEvidenceRecordInputV1 {
    if (input.recordVersion !== AGENT_EVIDENCE_RECORD_VERSION) {
        throw new TypeError(`agentEvidence.recordVersion must be ${AGENT_EVIDENCE_RECORD_VERSION}`);
    }
    const attributionKind = member(
        input.attributionKind,
        ['legacy-profile', 'skill', 'unattributed'] as const,
        'agentEvidence.attributionKind',
    );
    const manifestDigests = digestList(input.manifestDigests, 'manifestDigests');
    const candidateDigests = digestList(input.candidateDigests, 'candidateDigests');
    if (attributionKind === 'skill' && manifestDigests.length === 0) {
        throw new TypeError('agentEvidence skill attribution requires at least one manifest digest');
    }
    if (attributionKind !== 'skill' && (manifestDigests.length > 0 || candidateDigests.length > 0)) {
        throw new TypeError('agentEvidence non-skill attribution must not claim manifest or candidate digests');
    }
    if (!Object.is(input.learningWeight, 0)) {
        throw new TypeError('agentEvidence.learningWeight must be canonical zero');
    }
    return deepFreeze({
        recordVersion: AGENT_EVIDENCE_RECORD_VERSION,
        eventType: member(input.eventType, ['context-consumed'] as const, 'agentEvidence.eventType'),
        sessionId: opaqueToken(input.sessionId, 'sessionId'),
        cardId: opaqueToken(input.cardId, 'cardId'),
        contentMode: member(input.contentMode, ['nsf', 'nsfw'] as const, 'agentEvidence.contentMode'),
        capabilityId: opaqueToken(input.capabilityId, 'capabilityId'),
        sourceType: opaqueToken(input.sourceType, 'sourceType'),
        sourceRef: opaqueToken(input.sourceRef, 'sourceRef'),
        sourceDigest: digestValue(input.sourceDigest, 'sourceDigest'),
        artifactDigest: digestValue(input.artifactDigest, 'artifactDigest'),
        consumerRunId: opaqueToken(input.consumerRunId, 'consumerRunId'),
        requestDigest: input.requestDigest === null ? null : digestValue(input.requestDigest, 'requestDigest'),
        occurredAt: canonicalString(input.occurredAt, 'agentEvidence.occurredAt', isoTimestamp),
        attributionKind,
        manifestDigests,
        candidateDigests,
        executionClass: member(input.executionClass, ['unknown'] as const, 'agentEvidence.executionClass'),
        effectOutcome: member(input.effectOutcome, ['unknown'] as const, 'agentEvidence.effectOutcome'),
        learningWeight: 0,
    });
}


function evidenceIdentity(core: Readonly<{
    recordVersion: string; eventType: string; sessionId: string; sourceType: string; sourceRef: string;
}>): string {
    return digestCanonical({
        recordVersion: core.recordVersion,
        eventType: core.eventType,
        sessionId: core.sessionId,
        sourceType: core.sourceType,
        sourceRef: core.sourceRef,
    });
}


/** Mint a deterministic historical identity. Same-identity payload conflicts belong to the persistence layer. */
export function createAgentEvidenceRecord(input: unknown): AgentEvidenceRecordV1 {
    assertDataRecord(input, CORE_KEYS);
    const core = normalizeCore(input);
    return deepFreeze({ ...core, evidenceId: evidenceIdentity(core) });
}


/** Validate and copy an existing record without granting authority or accepting optimistic outcome claims. */
export function normalizeAgentEvidenceRecord(input: unknown): AgentEvidenceRecordV1 {
    assertDataRecord(input, RECORD_KEYS);
    const core = normalizeCore(input);
    const evidenceId = digestValue(input.evidenceId, 'evidenceId');
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('agentEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}


function invalidationSourceType(consumed: AgentEvidenceRecordV1, domain: AgentEvidenceInvalidationDomain):
    AgentEvidenceInvalidationRecordV1['sourceType'] {
    if ((domain !== 'memory' && domain !== 'summary')
        || consumed.sourceType !== `maintenance-${domain}-consumption-v1`
        || consumed.capabilityId !== 'maintenance.memory' || consumed.attributionKind !== 'skill') {
        throw new TypeError('agentEvidence invalidation requires the matching original maintenance consumption');
    }
    return domain === 'memory' ? 'maintenance-memory-rollback-v1' : 'maintenance-summary-rollback-v1';
}


/** One stable observation per consumed record. A changed rollback conflicts instead of replacing history. */
export function agentEvidenceInvalidationId(consumedInput: unknown, domain: AgentEvidenceInvalidationDomain): string {
    const consumed = normalizeAgentEvidenceRecord(consumedInput);
    return evidenceIdentity({
        recordVersion: AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION, eventType: 'source-invalidated',
        sessionId: consumed.sessionId, sourceType: invalidationSourceType(consumed, domain),
        sourceRef: consumed.evidenceId,
    });
}


export function createAgentEvidenceInvalidationRecord(input: unknown): AgentEvidenceInvalidationRecordV1 {
    assertDataRecord(input, new Set(['consumed', 'domain', 'rollbackDigest', 'rolledBackAt']));
    const consumed = normalizeAgentEvidenceRecord(input.consumed);
    const domain = member(input.domain, ['memory', 'summary'] as const, 'agentEvidence.invalidation.domain');
    const { evidenceId: ignored, ...original } = consumed;
    void ignored;
    const core = {
        ...original,
        recordVersion: AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION, eventType: 'source-invalidated' as const,
        sourceType: invalidationSourceType(consumed, domain), sourceRef: consumed.evidenceId,
        sourceDigest: digestCanonical(consumed), artifactDigest: digestValue(input.rollbackDigest, 'rollbackDigest'),
        requestDigest: null,
        occurredAt: canonicalString(input.rolledBackAt, 'agentEvidence.rolledBackAt', isoTimestamp),
    };
    return deepFreeze({ ...core, evidenceId: agentEvidenceInvalidationId(consumed, domain) });
}


export function normalizeAgentEvidenceInvalidationRecord(input: unknown): AgentEvidenceInvalidationRecordV1 {
    assertDataRecord(input, RECORD_KEYS);
    if (input.recordVersion !== AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION || input.eventType !== 'source-invalidated'
        || !['maintenance-memory-rollback-v1', 'maintenance-summary-rollback-v1'].includes(String(input.sourceType))
        || input.capabilityId !== 'maintenance.memory' || input.attributionKind !== 'skill'
        || input.requestDigest !== null) {
        throw new TypeError('agentEvidence invalidation version or domain mismatch');
    }
    const common = normalizeCore({ ...input, recordVersion: AGENT_EVIDENCE_RECORD_VERSION, eventType: 'context-consumed' });
    const core = {
        ...common,
        recordVersion: AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION, eventType: 'source-invalidated' as const,
        sourceType: input.sourceType as AgentEvidenceInvalidationRecordV1['sourceType'],
        sourceRef: digestValue(input.sourceRef, 'consumedEvidenceId'), requestDigest: null,
    };
    const evidenceId = digestValue(input.evidenceId, 'evidenceId');
    if (evidenceId !== evidenceIdentity(core)) throw new TypeError('agentEvidence.evidenceId mismatch');
    return deepFreeze({ ...core, evidenceId });
}


/** A versioned envelope reader; the original v1-only reader remains closed and byte-compatible. */
export function normalizeAgentEvidenceEnvelope(input: unknown): AgentEvidenceEnvelope {
    assertPlainRecord(input, 'agentEvidence');
    const recordVersion = Object.getOwnPropertyDescriptor(input, 'recordVersion')?.value;
    if (recordVersion === AGENT_EVIDENCE_BRANCH_MODIFIED_VERSION) {
        return normalizeAgentEvidenceBranchModifiedRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_VARIABLE_INVALIDATION_VERSION) {
        return normalizeAgentEvidenceVariableInvalidationRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_REPORTED_EFFECT_VERSION) {
        return normalizeAgentEvidenceReportedEffectRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_BRANCH_ATTRIBUTION_VERSION) {
        return normalizeAgentEvidenceBranchAttributionRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_PREFERENCE_INFERENCE_VERSION) {
        return normalizeAgentEvidencePreferenceInferenceRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_AQL_ADVISORY_VERSION) {
        return normalizeAgentEvidenceAqlAdvisoryRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_ARC_COMMIT_VERSION) {
        return normalizeAgentEvidenceArcCommitRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_NPC_OPERATION_VERSION) {
        return normalizeAgentEvidenceNpcOperationRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_WORLDBOOK_APPLY_VERSION) {
        return normalizeAgentEvidenceWorldbookApplyRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_SCENE_CONSUMPTION_VERSION) {
        return normalizeAgentEvidenceSceneConsumptionRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_PROPOSAL_APPROVAL_RECORD_VERSION) {
        return normalizeAgentEvidenceProposalApprovalRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_REGENERATION_RECORD_VERSION) {
        return normalizeAgentEvidenceRegenerationRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_VARIABLE_APPLY_RECORD_VERSION) {
        return normalizeAgentEvidenceVariableApplyRecord(input);
    }
    if (recordVersion === AGENT_EVIDENCE_PROPOSAL_REJECTION_RECORD_VERSION) {
        return normalizeAgentEvidenceProposalRejectionRecord(input);
    }
    assertDataRecord(input, RECORD_KEYS);
    return input.recordVersion === AGENT_EVIDENCE_INVALIDATION_RECORD_VERSION
        ? normalizeAgentEvidenceInvalidationRecord(input) : normalizeAgentEvidenceRecord(input);
}


/** Digest the complete validated record, separately from its stable identity. */
export function agentEvidenceRecordDigest(input: unknown): string {
    return digestCanonical(normalizeAgentEvidenceEnvelope(input));
}
