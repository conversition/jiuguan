/** @author Codex @date 2026-10-17 @version 1.0
 * Read-only D-Q2 adapter from durable Closure evidence to a branded operational source.
 * Candidate schema1 is never mutated and fixture quality is never operational evidence.
 */
import { createHash } from 'node:crypto';
import {
    agentClosureTimestamp, foldAgentClosure, normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEvent, type AgentClosureEventInput,
} from '../../../packages/agent-closure/index.ts';
import {
    normalizeAgentSkillBundle, normalizeAgentSkillCandidate, skillOperationalCandidateBindingDigest,
    type AgentSkillCandidateRecordV1,
} from '@jiuguan/skill-hub';
import { AgentClosureStore, type AgentClosureRecord } from '../agent-closure-store.ts';
import {
    AgentSkillCandidateStore, type StoredAgentSkillCandidate,
} from '../agent-skill-candidate-store.ts';
import { normalizeCandidateStaticValidationReceipt }
    from '../agent-skill-candidate-static-validator.ts';
import { AgentSkillCandidateRuntime } from './candidate-runtime.ts';

export const SKILL_OPERATIONAL_SOURCE_VERSION = 'skill-operational-source-v1' as const;
export const SKILL_OPERATIONAL_SOURCE_PROOF_VERSION = 'skill-operational-source-proof-v1' as const;

export interface SkillOperationalSourceReceiptV1 {
    readonly sourceVersion: typeof SKILL_OPERATIONAL_SOURCE_VERSION;
    readonly candidateId: string;
    readonly candidateRevision: 1;
    readonly candidateBindingDigest: string;
    readonly bundleDigest: string;
    readonly manifestDigest: string;
    readonly validationEvidenceDigest: string;
    readonly operationId: string;
    readonly closureRevision: number;
    readonly capability: AgentClosureRecord['capability'];
    readonly executionClass: 'operational-replay';
    readonly rawSessionId: string;
    readonly sourceRevision: string;
    readonly instructionSetDigest: string;
    readonly selectionReceiptDigest: string;
    readonly compiledArtifactDigest: string;
    readonly compiledInstructionSetDigest: string;
    readonly validatorPlanDigest: string;
    readonly artifactDigest: string;
    readonly consumerRunId: string;
    readonly effectOutcome: 'positive' | 'neutral' | 'negative' | 'inconclusive';
    readonly interpretation: 'observed-not-evaluated';
    readonly promotionEligible: false;
    readonly consumedAt: string;
    readonly observedAt: string;
    readonly evidenceDigest: string;
}

export interface SkillOperationalSourceProofV1 {
    readonly proofVersion: typeof SKILL_OPERATIONAL_SOURCE_PROOF_VERSION;
    readonly evidenceDigest: string;
}

export interface SkillOperationalSourcePublicViewV1 {
    readonly sourceVersion: typeof SKILL_OPERATIONAL_SOURCE_VERSION;
    readonly candidateId: string;
    readonly candidateRevision: 1;
    readonly candidateBindingDigest: string;
    readonly bundleDigest: string;
    readonly manifestDigest: string;
    readonly operationId: string;
    readonly closureRevision: number;
    readonly capability: AgentClosureRecord['capability'];
    readonly executionClass: 'operational-replay';
    readonly effectOutcome: SkillOperationalSourceReceiptV1['effectOutcome'];
    readonly interpretation: 'observed-not-evaluated';
    readonly promotionEligible: false;
    readonly consumedAt: string;
    readonly observedAt: string;
    readonly evidenceDigest: string;
    readonly sourceCurrent: true;
}

interface SkillOperationalSourcePorts {
    readCandidate(candidateId: string): StoredAgentSkillCandidate | null;
    readClosure(operationId: string): AgentClosureRecord | null | undefined;
    sourceAllowed(rawSessionId: string): boolean;
}

type ProofEntry = Readonly<{
    owner: object;
    receipt: SkillOperationalSourceReceiptV1;
    candidateSnapshot: string;
    closureSnapshot: string;
}>;

const PROOFS = new WeakMap<object, ProofEntry>();
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const AUTHORITY_PROBE_CANDIDATE_ID = `sha256:${'0'.repeat(64)}`;
const AUTHORITY_PROBE_OPERATION_ID = 'skill-operational-authority-probe';

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const data = value as Record<string, unknown>;
        return `{${Object.keys(data).sort().map((key) => (
            `${JSON.stringify(key)}:${canonical(data[key])}`
        )).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('skill-operational-source-value-invalid');
    return encoded;
}

function frozen<T extends object>(value: T): Readonly<T> {
    for (const item of Object.values(value)) {
        if (item && typeof item === 'object' && !Object.isFrozen(item)) frozen(item as object);
    }
    return Object.freeze(value);
}

function validatedCandidate(input: StoredAgentSkillCandidate): Readonly<{
    candidate: AgentSkillCandidateRecordV1;
    stored: StoredAgentSkillCandidate;
    validation: NonNullable<StoredAgentSkillCandidate['validation']>;
    snapshot: string;
}> {
    const candidate = normalizeAgentSkillCandidate(input.candidate);
    const bundle = normalizeAgentSkillBundle(input.bundle);
    const validation = input.validation === null
        ? null : normalizeCandidateStaticValidationReceipt(input.validation);
    if (candidate.state !== 'validated' || candidate.revision !== 1
        || candidate.validationEvidenceDigest === null
        || candidate.operationalReplayEvidenceDigest !== null
        || bundle.bundleDigest !== candidate.bundleDigest
        || JSON.stringify(bundle.header) !== JSON.stringify(candidate.header)
        || !validation || validation.passed !== true
        || validation.candidateId !== candidate.candidateId
        || validation.bundleDigest !== candidate.bundleDigest
        || validation.evidenceDigest !== candidate.validationEvidenceDigest) {
        throw new Error('skill-operational-candidate-not-validated');
    }
    const stored = Object.freeze({ candidate, bundle, validation });
    return Object.freeze({ candidate, stored, validation, snapshot: canonical(stored) });
}

function normalizedClosure(input: AgentClosureRecord): Readonly<{
    closure: AgentClosureRecord;
    snapshot: string;
}> {
    const run = normalizeAgentClosureRun(input);
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 10_000) {
        throw new Error('skill-operational-closure-events-invalid');
    }
    const events: AgentClosureEvent[] = [];
    for (let index = 0; index < input.events.length; index += 1) {
        const event = input.events[index]!;
        if (!event || typeof event !== 'object' || Array.isArray(event)
            || event.sequence !== index + 1 || typeof event.eventId !== 'string'
            || !TOKEN.test(event.eventId)) throw new Error('skill-operational-closure-event-invalid');
        if (index === 0) {
            const expectedKeys = ['eventId', 'sequence', 'type', 'idempotencyKey', 'occurredAt',
                'sourceRevision', ...(run.evidenceDigest === undefined ? [] : ['artifactDigest'])].sort();
            if (event.type !== 'admitted' || event.idempotencyKey !== 'admitted'
                || event.occurredAt !== run.admittedAt || event.sourceRevision !== run.sourceRevision
                || event.artifactDigest !== run.evidenceDigest
                || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(expectedKeys)) {
                throw new Error('skill-operational-closure-admission-invalid');
            }
        } else {
            const { eventId: _eventId, sequence: _sequence, ...eventInput } = event;
            const normalized = normalizeAgentClosureEvent(eventInput as AgentClosureEventInput);
            if (canonical(normalized) !== canonical(eventInput)) {
                throw new Error('skill-operational-closure-event-invalid');
            }
        }
        events.push(event);
    }
    const admittedAt = Date.parse(run.admittedAt);
    const updatedAtValue = agentClosureTimestamp(input.updatedAt, 'skill-operational-updated-at');
    const updatedAt = Date.parse(updatedAtValue);
    // Recovery may append a historical milestone after a retry, so sequence order need not be
    // chronological. The durable run window is still authoritative: no event may predate
    // admission or claim to occur after the Store's latest persisted update.
    if (updatedAt < admittedAt || events.some((event) => {
        const occurredAt = Date.parse(event.occurredAt);
        return occurredAt < admittedAt || occurredAt > updatedAt;
    })) throw new Error('skill-operational-closure-event-time-invalid');
    const fold = foldAgentClosure(run.kind, events, run.executionClass);
    if (input.revision !== events.length || input.createdAt !== run.admittedAt
        || !Number.isSafeInteger(input.revision) || input.revision < 1
        || updatedAtValue !== input.updatedAt
        || input.stage !== fold.stage || input.status !== fold.status
        || input.nextRequiredEvent !== fold.nextRequiredEvent
        || input.eventCount !== fold.eventCount || input.consumedCount !== fold.consumedCount
        || input.qualifiesAsProductionClosure !== fold.qualifiesAsProductionClosure
        || input.latestReasonCode !== fold.latestReasonCode) {
        throw new Error('skill-operational-closure-fold-invalid');
    }
    const closure: AgentClosureRecord = Object.freeze({
        ...run, ...fold, revision: input.revision,
        createdAt: input.createdAt, updatedAt: input.updatedAt,
        events: Object.freeze(events),
    });
    return Object.freeze({ closure, snapshot: canonical(closure) });
}

function buildReceipt(candidateInput: StoredAgentSkillCandidate, closureInput: AgentClosureRecord):
    SkillOperationalSourceReceiptV1 | null {
    const { candidate, validation } = validatedCandidate(candidateInput);
    const { closure } = normalizedClosure(closureInput);
    if (closure.executionClass !== 'operational-replay' || closure.status !== 'closed'
        || closure.stage !== 'observed' || closure.nextRequiredEvent !== null
        || closure.qualifiesAsProductionClosure !== false
        || Date.parse(closure.admittedAt) < Date.parse(validation.validatedAt)) return null;
    const candidateBindingDigest = skillOperationalCandidateBindingDigest(candidate);
    const lineageType = closure.kind === 'proposal' ? 'readback-verified' : 'artifact-validated';
    const lineages = closure.events.filter((event) => event.type === lineageType);
    if (lineages.length !== 1 || !lineages[0]!.artifactDigest) return null;
    const lineage = lineages[0]!;
    const lineageAt = Date.parse(lineage.occurredAt);
    const consumed = closure.events.filter((event) => {
        const attribution = event.skillAttribution;
        return event.type === 'context-consumed' && attribution !== undefined
            && event.artifactDigest === lineage.artifactDigest
            && Date.parse(event.occurredAt) >= lineageAt
            && Date.parse(event.occurredAt) >= Date.parse(validation.validatedAt)
            && attribution.validatorOutcome === 'passed'
            && attribution.activeCandidateDigests.length === 1
            && attribution.activeCandidateDigests[0] === candidateBindingDigest
            && attribution.selectedManifestDigests.includes(candidate.header.manifestDigest);
    });
    if (consumed.length !== 1) return null;
    const consumption = consumed[0]!;
    const attribution = consumption.skillAttribution!;
    const effects = closure.events.filter((event) => event.type === 'effect-observed'
        && event.artifactDigest === consumption.artifactDigest
        && event.consumerRunId === consumption.consumerRunId
        && Date.parse(event.occurredAt) >= Date.parse(consumption.occurredAt));
    if (effects.length !== 1 || !consumption.artifactDigest || !consumption.consumerRunId
        || !effects[0]!.effectOutcome) return null;
    const effect = effects[0]!;
    const possibleParents = closure.events.filter((event) => event.type === 'context-consumed'
        && event.artifactDigest === consumption.artifactDigest
        && event.consumerRunId === consumption.consumerRunId
        && Date.parse(event.occurredAt) >= lineageAt
        && Date.parse(event.occurredAt) <= Date.parse(effect.occurredAt));
    if (possibleParents.length !== 1 || possibleParents[0]!.eventId !== consumption.eventId) {
        return null;
    }
    const core = {
        sourceVersion: SKILL_OPERATIONAL_SOURCE_VERSION,
        candidateId: candidate.candidateId,
        candidateRevision: 1 as const,
        candidateBindingDigest,
        bundleDigest: candidate.bundleDigest,
        manifestDigest: candidate.header.manifestDigest,
        validationEvidenceDigest: candidate.validationEvidenceDigest!,
        operationId: closure.operationId,
        closureRevision: closure.revision,
        capability: closure.capability,
        executionClass: 'operational-replay' as const,
        rawSessionId: closure.sessionId,
        sourceRevision: closure.sourceRevision,
        instructionSetDigest: attribution.instructionSetDigest,
        selectionReceiptDigest: attribution.selectionReceiptDigest,
        compiledArtifactDigest: attribution.compiledArtifactDigest,
        compiledInstructionSetDigest: attribution.compiledInstructionSetDigest,
        validatorPlanDigest: attribution.validatorPlanDigest,
        artifactDigest: consumption.artifactDigest,
        consumerRunId: consumption.consumerRunId,
        effectOutcome: effect.effectOutcome,
        interpretation: 'observed-not-evaluated' as const,
        promotionEligible: false as const,
        consumedAt: consumption.occurredAt,
        observedAt: effect.occurredAt,
    };
    return frozen({ ...core, evidenceDigest: digest(core) }) as SkillOperationalSourceReceiptV1;
}

/** Public projection intentionally omits raw session/source/consumer identifiers. */
function publicView(receipt: SkillOperationalSourceReceiptV1): SkillOperationalSourcePublicViewV1 {
    return Object.freeze({
        sourceVersion: receipt.sourceVersion,
        candidateId: receipt.candidateId,
        candidateRevision: receipt.candidateRevision,
        candidateBindingDigest: receipt.candidateBindingDigest,
        bundleDigest: receipt.bundleDigest,
        manifestDigest: receipt.manifestDigest,
        operationId: receipt.operationId,
        closureRevision: receipt.closureRevision,
        capability: receipt.capability,
        executionClass: receipt.executionClass,
        effectOutcome: receipt.effectOutcome,
        interpretation: receipt.interpretation,
        promotionEligible: receipt.promotionEligible,
        consumedAt: receipt.consumedAt,
        observedAt: receipt.observedAt,
        evidenceDigest: receipt.evidenceDigest,
        sourceCurrent: true,
    });
}

export interface SkillOperationalSourceRuntime {
    resolve(candidateId: string, operationId: string): SkillOperationalSourceProofV1 | null;
    current(proof: unknown): boolean;
    readCurrent(proof: unknown): SkillOperationalSourceReceiptV1 | null;
    publicView(proof: unknown): SkillOperationalSourcePublicViewV1 | null;
}

/** Concrete Store instances are bound once at the composition root; request data never supplies ports. */
class StoreSkillOperationalSource implements SkillOperationalSourceRuntime {
    readonly #ports: SkillOperationalSourcePorts;
    readonly #owner = Object.freeze({});

    constructor(ports: SkillOperationalSourcePorts) { this.#ports = ports; }

    resolve(candidateId: string, operationId: string): SkillOperationalSourceProofV1 | null {
        if (!HASH.test(candidateId) || !TOKEN.test(operationId)) {
            throw new Error('skill-operational-source-reference-invalid');
        }
        const firstCandidate = this.#ports.readCandidate(candidateId);
        const firstClosure = this.#ports.readClosure(operationId);
        if (!firstCandidate || !firstClosure) return null;
        if (this.#ports.sourceAllowed(firstClosure.sessionId) !== true) return null;
        const candidate = validatedCandidate(firstCandidate);
        const closure = normalizedClosure(firstClosure);
        const receipt = buildReceipt(firstCandidate, firstClosure);
        if (!receipt) return null;
        const nextCandidate = this.#ports.readCandidate(candidateId);
        const nextClosure = this.#ports.readClosure(operationId);
        if (!nextCandidate || !nextClosure
            || this.#ports.sourceAllowed(nextClosure.sessionId) !== true
            || validatedCandidate(nextCandidate).snapshot !== candidate.snapshot
            || normalizedClosure(nextClosure).snapshot !== closure.snapshot) return null;
        const proof = Object.freeze({
            proofVersion: SKILL_OPERATIONAL_SOURCE_PROOF_VERSION,
            evidenceDigest: receipt.evidenceDigest,
        });
        PROOFS.set(proof, Object.freeze({
            owner: this.#owner, receipt,
            candidateSnapshot: candidate.snapshot, closureSnapshot: closure.snapshot,
        }));
        return proof;
    }

    current(proof: unknown): boolean {
        return this.readCurrent(proof) !== null;
    }

    /** Only the issuing instance may unwrap a proof, and only while both Stores are unchanged. */
    readCurrent(proof: unknown): SkillOperationalSourceReceiptV1 | null {
        if (!proof || typeof proof !== 'object') return null;
        const retained = PROOFS.get(proof);
        if (!retained || retained.owner !== this.#owner) return null;
        try {
            const candidate = this.#ports.readCandidate(retained.receipt.candidateId);
            const closure = this.#ports.readClosure(retained.receipt.operationId);
            if (!candidate || !closure
                || this.#ports.sourceAllowed(closure.sessionId) !== true
                || validatedCandidate(candidate).snapshot !== retained.candidateSnapshot
                || normalizedClosure(closure).snapshot !== retained.closureSnapshot) return null;
            const receipt = buildReceipt(candidate, closure);
            return receipt?.evidenceDigest === retained.receipt.evidenceDigest ? retained.receipt : null;
        } catch { return null; }
    }

    publicView(proof: unknown): SkillOperationalSourcePublicViewV1 | null {
        const receipt = this.readCurrent(proof);
        return receipt ? publicView(receipt) : null;
    }
}

/**
 * The factory rejects structural lookalikes: only the repository's concrete Candidate and Closure
 * Stores can mint source proofs. Each returned runtime owns a separate, process-local proof brand.
 */
export function createSkillOperationalSource(input: Readonly<{
    candidates: AgentSkillCandidateStore | AgentSkillCandidateRuntime;
    closures: AgentClosureStore;
    sourceAllowed(rawSessionId: string): boolean;
}>): SkillOperationalSourceRuntime {
    if (!(input.candidates instanceof AgentSkillCandidateStore)
        && !(input.candidates instanceof AgentSkillCandidateRuntime)) {
        throw new Error('skill-operational-candidate-authority-invalid');
    }
    try {
        if (input.candidates instanceof AgentSkillCandidateStore) {
            AgentSkillCandidateStore.prototype.jobStatus.call(input.candidates);
        } else {
            AgentSkillCandidateRuntime.prototype.readCandidate.call(
                input.candidates, AUTHORITY_PROBE_CANDIDATE_ID,
            );
        }
    } catch {
        throw new Error('skill-operational-candidate-authority-invalid');
    }
    if (!(input.closures instanceof AgentClosureStore)
        || typeof input.sourceAllowed !== 'function') {
        throw new Error('skill-operational-closure-authority-invalid');
    }
    try {
        AgentClosureStore.prototype.get.call(input.closures, AUTHORITY_PROBE_OPERATION_ID);
    } catch {
        throw new Error('skill-operational-closure-authority-invalid');
    }
    return new StoreSkillOperationalSource({
        readCandidate: (candidateId) => input.candidates instanceof AgentSkillCandidateStore
            ? AgentSkillCandidateStore.prototype.readCandidate.call(input.candidates, candidateId)
            : AgentSkillCandidateRuntime.prototype.readCandidate.call(input.candidates, candidateId),
        readClosure: (operationId) => AgentClosureStore.prototype.get.call(input.closures, operationId),
        sourceAllowed: input.sourceAllowed,
    });
}
