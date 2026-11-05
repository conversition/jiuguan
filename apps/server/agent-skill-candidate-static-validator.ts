/** @author Codex @date 2026-10-16 @version 1.0
 * Fixed-host static checks produce branded metadata, never live Skill authority or quality/replay approval.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
    normalizeAgentSkillBundle, normalizeAgentSkillCandidate, parseAgentSkillProgramBody,
} from '@jiuguan/skill-hub';
import {
    AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST, validateAgentSkillProgramPrimitives,
} from '@jiuguan/prompt/agent-skill-compiler';

export const CANDIDATE_STATIC_VALIDATOR_VERSION = 'candidate-static-validator-v1' as const;
export const CANDIDATE_STATIC_VALIDATION_RECEIPT_VERSION = 'agent-skill-candidate-static-validation-v1' as const;

export const CANDIDATE_STATIC_VALIDATION_REASONS = Object.freeze([
    'candidate-static-validation-passed', 'candidate-static-input-invalid',
    'candidate-static-binding-mismatch', 'candidate-static-policy-denied',
    'candidate-static-program-invalid', 'candidate-static-claim-expired',
] as const);
export type CandidateStaticValidationReason = typeof CANDIDATE_STATIC_VALIDATION_REASONS[number];

export interface CandidateStaticValidationClaim {
    readonly claimVersion: 'agent-skill-candidate-claim-v1';
    readonly jobId: string;
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly ownerId: string;
    readonly ownerToken: string;
    readonly attempt: number;
    readonly jobRevision: number;
    readonly expectedCandidateRevision: number;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
}

export interface CandidateStaticValidationReceipt {
    readonly receiptVersion: typeof CANDIDATE_STATIC_VALIDATION_RECEIPT_VERSION;
    readonly jobId: string;
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly expectedCandidateRevision: number;
    readonly attempt: number;
    readonly jobRevision: number;
    readonly ownerToken: string;
    readonly claimDigest: string;
    readonly validatedAt: string;
    readonly validatorVersion: typeof CANDIDATE_STATIC_VALIDATOR_VERSION;
    readonly primitiveRegistryDigest: string;
    readonly passed: boolean;
    readonly reasonCode: CandidateStaticValidationReason;
    readonly evidenceDigest: string;
}

declare const CANDIDATE_STATIC_PROOF: unique symbol;
export interface CandidateStaticValidationProof { readonly [CANDIDATE_STATIC_PROOF]: true; }

const PROOFS = new WeakMap<object, CandidateStaticValidationReceipt>();
const CLAIM_FIELDS = ['claimVersion', 'jobId', 'candidateId', 'bundleDigest', 'ownerId', 'ownerToken',
    'attempt', 'jobRevision', 'expectedCandidateRevision', 'claimedAt', 'leaseExpiresAt'];
const RECEIPT_FIELDS = ['receiptVersion', 'jobId', 'candidateId', 'bundleDigest', 'expectedCandidateRevision',
    'attempt', 'jobRevision', 'ownerToken', 'claimDigest', 'validatedAt', 'validatorVersion',
    'primitiveRegistryDigest', 'passed', 'reasonCode', 'evidenceDigest'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;


function dataRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('static-data-invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
        throw new Error('static-data-invalid');
    }
    for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('static-data-invalid');
    }
    return input as Record<string, unknown>;
}


/** Reject active getters/proxies before a core normalizer reads caller-authored metadata. */
function snapshot(input: unknown, seen = new Set<object>(), depth = 0,
    budget = { nodes: 0, characters: 0 }): unknown {
    budget.nodes += 1;
    if (depth > 32 || budget.nodes > 20_000) throw new Error('static-data-invalid');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
        budget.characters += input.length;
        if (budget.characters > 2_097_152) throw new Error('static-data-invalid');
        return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || seen.has(input)) {
        throw new Error('static-data-invalid');
    }
    seen.add(input);
    try {
        if (Array.isArray(input)) {
            if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 20_000
                || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('static-data-invalid');
            return Array.from({ length: input.length }, (_, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
                    throw new Error('static-data-invalid');
                }
                return snapshot(descriptor.value, seen, depth + 1, budget);
            });
        }
        const keys = Reflect.ownKeys(input);
        const data = dataRecord(input, keys.map((key) => {
            if (typeof key !== 'string') throw new Error('static-data-invalid');
            return key;
        }));
        const output: Record<string, unknown> = Object.create(null);
        for (const key of Object.keys(data)) output[key] = snapshot(data[key], seen, depth + 1, budget);
        return output;
    } finally { seen.delete(input); }
}


function token(input: unknown): string {
    if (typeof input !== 'string' || !TOKEN.test(input)) throw new Error('static-data-invalid');
    return input;
}


function hash(input: unknown): string {
    if (typeof input !== 'string' || !HASH.test(input)) throw new Error('static-data-invalid');
    return input;
}


function count(input: unknown, minimum = 0): number {
    if (!Number.isSafeInteger(input) || Number(input) < minimum) throw new Error('static-data-invalid');
    return Number(input);
}


function timestamp(input: unknown): string {
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))
        || new Date(input).toISOString() !== input) throw new Error('static-data-invalid');
    return input;
}


function canonical(input: unknown): string {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const value = input as Record<string, unknown>;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}


function digest(input: unknown): string {
    return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}


function normalizeClaim(input: unknown): CandidateStaticValidationClaim {
    const value = dataRecord(input, CLAIM_FIELDS);
    if (value.claimVersion !== 'agent-skill-candidate-claim-v1') throw new Error('static-data-invalid');
    const claim = Object.freeze({
        claimVersion: 'agent-skill-candidate-claim-v1' as const,
        jobId: token(value.jobId), candidateId: hash(value.candidateId), bundleDigest: hash(value.bundleDigest),
        ownerId: token(value.ownerId), ownerToken: token(value.ownerToken),
        attempt: count(value.attempt, 1), jobRevision: count(value.jobRevision, 1),
        expectedCandidateRevision: count(value.expectedCandidateRevision),
        claimedAt: timestamp(value.claimedAt), leaseExpiresAt: timestamp(value.leaseExpiresAt),
    });
    if (claim.leaseExpiresAt <= claim.claimedAt) throw new Error('static-data-invalid');
    return claim;
}


export function candidateStaticValidationClaimDigest(input: unknown): string {
    try { return digest(normalizeClaim(input)); }
    catch { throw new Error('candidate-static-claim-invalid'); }
}


/** Durable receipts are strict data; reading one cannot recover a live proof object. */
export function normalizeCandidateStaticValidationReceipt(input: unknown): CandidateStaticValidationReceipt {
    try {
        const value = dataRecord(input, RECEIPT_FIELDS);
        if (value.receiptVersion !== CANDIDATE_STATIC_VALIDATION_RECEIPT_VERSION
            || value.validatorVersion !== CANDIDATE_STATIC_VALIDATOR_VERSION
            || typeof value.passed !== 'boolean'
            || !CANDIDATE_STATIC_VALIDATION_REASONS.includes(value.reasonCode as CandidateStaticValidationReason)
            || value.passed !== (value.reasonCode === 'candidate-static-validation-passed')) {
            throw new Error('static-data-invalid');
        }
        const core = {
            receiptVersion: CANDIDATE_STATIC_VALIDATION_RECEIPT_VERSION,
            jobId: token(value.jobId), candidateId: hash(value.candidateId), bundleDigest: hash(value.bundleDigest),
            expectedCandidateRevision: count(value.expectedCandidateRevision), attempt: count(value.attempt, 1),
            jobRevision: count(value.jobRevision, 1), ownerToken: token(value.ownerToken),
            claimDigest: hash(value.claimDigest), validatedAt: timestamp(value.validatedAt),
            validatorVersion: CANDIDATE_STATIC_VALIDATOR_VERSION,
            primitiveRegistryDigest: hash(value.primitiveRegistryDigest), passed: value.passed,
            reasonCode: value.reasonCode as CandidateStaticValidationReason,
        };
        if (hash(value.evidenceDigest) !== digest(core)) throw new Error('static-data-invalid');
        return Object.freeze({ ...core, evidenceDigest: value.evidenceDigest as string });
    } catch { throw new Error('candidate-static-receipt-invalid'); }
}


function evaluate(input: Record<string, unknown>, claim: CandidateStaticValidationClaim,
    validatedAt: string): CandidateStaticValidationReason {
    if (validatedAt < claim.claimedAt || validatedAt >= claim.leaseExpiresAt) return 'candidate-static-claim-expired';
    let candidate: ReturnType<typeof normalizeAgentSkillCandidate>;
    let bundle: ReturnType<typeof normalizeAgentSkillBundle>;
    try {
        candidate = normalizeAgentSkillCandidate(snapshot(input.candidate));
        bundle = normalizeAgentSkillBundle(snapshot(input.bundle));
    } catch { return 'candidate-static-input-invalid'; }
    if (candidate.candidateId !== claim.candidateId || candidate.bundleDigest !== claim.bundleDigest
        || bundle.bundleDigest !== claim.bundleDigest || candidate.revision !== claim.expectedCandidateRevision
        || candidate.state !== 'candidate' || canonical(candidate.header) !== canonical(bundle.header)) {
        return 'candidate-static-binding-mismatch';
    }
    const manifest = bundle.header.manifest;
    if (manifest.owner !== 'author' || !['filesystem', 'imported'].includes(manifest.sourceType)
        || manifest.scope.kind !== 'global' || manifest.contentModes.length !== 1 || manifest.contentModes[0] !== 'nsf'
        || manifest.riskTier !== 'advisory' || manifest.desiredTools.length !== 0
        || manifest.writableArtifactKinds.length !== 0 || manifest.limits.maxModelCalls !== 0
        || manifest.limits.maxToolCalls !== 0 || manifest.autoPromotion) return 'candidate-static-policy-denied';
    try {
        const program = parseAgentSkillProgramBody(bundle.body);
        if (program.kind !== manifest.kind) return 'candidate-static-program-invalid';
        validateAgentSkillProgramPrimitives(program);
    } catch { return 'candidate-static-program-invalid'; }
    return 'candidate-static-validation-passed';
}


/** Caller-provided passed/evaluator/receipt fields cannot select or override the fixed host checks. */
export function evaluateCandidateStaticValidation(input: unknown): CandidateStaticValidationProof {
    let value: Record<string, unknown>;
    let claim: CandidateStaticValidationClaim;
    let validatedAt: string;
    try {
        value = dataRecord(input, ['candidate', 'bundle', 'claim', 'validatedAt']);
        claim = normalizeClaim(value.claim);
        validatedAt = timestamp(value.validatedAt);
    } catch { throw new Error('candidate-static-input-invalid'); }
    const reasonCode = evaluate(value, claim, validatedAt);
    const core = {
        receiptVersion: CANDIDATE_STATIC_VALIDATION_RECEIPT_VERSION,
        jobId: claim.jobId, candidateId: claim.candidateId, bundleDigest: claim.bundleDigest,
        expectedCandidateRevision: claim.expectedCandidateRevision, attempt: claim.attempt,
        jobRevision: claim.jobRevision, ownerToken: claim.ownerToken, claimDigest: digest(claim), validatedAt,
        validatorVersion: CANDIDATE_STATIC_VALIDATOR_VERSION,
        primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
        passed: reasonCode === 'candidate-static-validation-passed', reasonCode,
    };
    const receipt = normalizeCandidateStaticValidationReceipt({ ...core, evidenceDigest: digest(core) });
    const proof = Object.freeze({}) as CandidateStaticValidationProof;
    PROOFS.set(proof, receipt);
    return proof;
}


export function readCandidateStaticValidationProof(input: unknown): CandidateStaticValidationReceipt {
    const receipt = input && typeof input === 'object' ? PROOFS.get(input) : undefined;
    if (!receipt || receipt.validatorVersion !== CANDIDATE_STATIC_VALIDATOR_VERSION
        || receipt.primitiveRegistryDigest !== AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST) {
        throw new Error('candidate-static-proof-not-owned');
    }
    return normalizeCandidateStaticValidationReceipt(receipt);
}
