/** Metadata-only provenance for one actual Context Compiler request, never replay authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { agentClosureDigest, agentClosureToken } from '../../agent-closure/index.ts';
import { parseContextCompilerInputManifest, type ContextCompilerInputManifestV1 }
    from '../../agent-policy/public/context-compiler-input.ts';

export const CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION = 'context-compiler-skill-source-receipt-v1' as const;
export const CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2 = 'context-compiler-skill-source-receipt-v2' as const;
export const CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3 = 'context-compiler-skill-source-receipt-v3' as const;

export interface ContextCompilerSkillSourceReceiptV1 {
    readonly version: typeof CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION;
    readonly manifest: ContextCompilerInputManifestV1;
    readonly sessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly policyVersion: string;
    readonly requestDigest: string;
    readonly capsuleDigest: string;
    readonly receiptDigest: string;
}

export interface ContextCompilerSkillSourceAttemptV2 {
    readonly ordinal: number;
    readonly phase: 'compile' | 'repair' | 'merge';
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly validation: 'rejected' | 'accepted';
}

export interface ContextCompilerSkillSourceReceiptV2 {
    readonly version: typeof CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2;
    readonly manifest: ContextCompilerInputManifestV1;
    readonly sessionId: string;
    readonly runId: string;
    readonly sourceRevision: string;
    readonly policyVersion: 'p14-q9r-context-compiler-v2';
    /** Ordered physical attempts; the final accepted attempt produced the consumed capsule. */
    readonly attempts: readonly ContextCompilerSkillSourceAttemptV2[];
    readonly requestDigest: string;
    readonly capsuleDigest: string;
    readonly receiptDigest: string;
}

export interface ContextCompilerReceiptFragmentV3 {
    readonly batch: 1 | 2;
    readonly fragmentId: string;
    readonly sourceId: string;
    readonly sourceDigest: string;
    readonly textDigest: string;
    readonly start: number;
    readonly end: number;
    readonly ordinal: number;
}

/** V3 binds the compact prompt and exact source fragment mapping to the accepted capsule. */
export interface ContextCompilerSkillSourceReceiptV3 extends Omit<ContextCompilerSkillSourceReceiptV2, 'version' | 'receiptDigest'> {
    readonly version: typeof CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3;
    readonly renderDigest: string;
    readonly fragmentDigest: string;
    readonly fragments: readonly ContextCompilerReceiptFragmentV3[];
    readonly receiptDigest: string;
}

export type ContextCompilerSkillSourceReceipt = ContextCompilerSkillSourceReceiptV1 | ContextCompilerSkillSourceReceiptV2 | ContextCompilerSkillSourceReceiptV3;

const FIELDS = ['version', 'manifest', 'sessionId', 'runId', 'sourceRevision', 'policyVersion',
    'requestDigest', 'capsuleDigest'] as const;
const V2_FIELDS = ['version', 'manifest', 'sessionId', 'runId', 'sourceRevision', 'policyVersion',
    'attempts', 'requestDigest', 'capsuleDigest'] as const;
const V3_FIELDS = [...V2_FIELDS, 'renderDigest', 'fragmentDigest', 'fragments'] as const;
const FRAGMENT_FIELDS = ['batch', 'fragmentId', 'sourceId', 'sourceDigest', 'textDigest', 'start', 'end', 'ordinal'] as const;
const ATTEMPT_FIELDS = ['ordinal', 'phase', 'requestDigest', 'responseDigest', 'validation'] as const;

function reject(): never { throw new Error('context-compiler-skill-source-receipt-invalid'); }

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string')
        || JSON.stringify([...keys].sort()) !== JSON.stringify([...fields].sort())) reject();
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
    }
    return input as Record<string, unknown>;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Canonical own-data only; raw source text and dynamic authority never enter a receipt. */
export function createContextCompilerSkillSourceReceipt(
    input: Omit<ContextCompilerSkillSourceReceiptV1, 'receiptDigest'>,
): ContextCompilerSkillSourceReceiptV1 {
    try {
        const value = record(input, FIELDS);
        if (value.version !== CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION
            || value.policyVersion !== 'p14-q9r-context-compiler-v1') reject();
        const core = {
            version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION,
            manifest: parseContextCompilerInputManifest(value.manifest),
            sessionId: agentClosureToken(value.sessionId, 'context-compiler-source-session'),
            runId: agentClosureToken(value.runId, 'context-compiler-source-run'),
            sourceRevision: agentClosureToken(value.sourceRevision, 'context-compiler-source-revision'),
            policyVersion: 'p14-q9r-context-compiler-v1',
            requestDigest: agentClosureDigest(value.requestDigest, 'context-compiler-source-request'),
            capsuleDigest: agentClosureDigest(value.capsuleDigest, 'context-compiler-source-capsule'),
        };
        return Object.freeze({ ...core, receiptDigest: digest(core) });
    } catch { reject(); }
}

function attemptsV2(input: unknown): readonly ContextCompilerSkillSourceAttemptV2[] {
    if (!Array.isArray(input) || types.isProxy(input) || input.length < 1 || input.length > 4
        || Reflect.ownKeys(input).some((key) => key !== 'length' && (typeof key !== 'string'
            || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= input.length))) reject();
    const attempts: ContextCompilerSkillSourceAttemptV2[] = [];
    const requests = new Set<string>();
    let repairs = 0, merges = 0, compilations = 0;
    for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
        const value = record(descriptor.value, ATTEMPT_FIELDS);
        if (value.ordinal !== index + 1 || typeof value.phase !== 'string'
            || !['compile', 'repair', 'merge'].includes(value.phase)
            || typeof value.validation !== 'string' || !['rejected', 'accepted'].includes(value.validation)) reject();
        const phase = value.phase as ContextCompilerSkillSourceAttemptV2['phase'];
        if ((index === 0 && phase !== 'compile')
            || (phase === 'repair' && (index === 0 || attempts[index - 1]!.validation !== 'rejected'))
            || (phase === 'repair' && ++repairs > 1)
            || (phase === 'merge' && ++merges > 1)
            || (phase === 'compile' && ++compilations > 2)) reject();
        const requestDigest = agentClosureDigest(value.requestDigest, 'context-compiler-source-request');
        if (requests.has(requestDigest)) reject();
        requests.add(requestDigest);
        attempts.push(Object.freeze({ ordinal: index + 1, phase, requestDigest,
            responseDigest: agentClosureDigest(value.responseDigest, 'context-compiler-source-response'),
            validation: value.validation as ContextCompilerSkillSourceAttemptV2['validation'] }));
    }
    if (attempts.at(-1)!.validation !== 'accepted') reject();
    // A rejected attempt must be repaired immediately; a second successful source
    // batch requires a final merge so a partial batch cannot masquerade as final.
    for (let index = 0; index < attempts.length; index++) {
        const current = attempts[index]!;
        if (current.validation === 'rejected' && attempts[index + 1]?.phase !== 'repair') reject();
        if (current.phase === 'repair' && current.validation !== 'accepted') reject();
    }
    const mergeIndex = attempts.findIndex((attempt) => attempt.phase === 'merge');
    if (mergeIndex === -1) {
        if (compilations !== 1 || attempts.length > 2) reject();
    } else if (compilations !== 2 || attempts.slice(mergeIndex + 1).some((attempt) => attempt.phase !== 'repair')
        || attempts.slice(mergeIndex + 1).length > 1) reject();
    return Object.freeze(attempts);
}

/** Metadata only: no prompt, response or hidden reasoning is retained in the receipt. */
export function createContextCompilerSkillSourceReceiptV2(
    input: Omit<ContextCompilerSkillSourceReceiptV2, 'receiptDigest'>,
): ContextCompilerSkillSourceReceiptV2 {
    try {
        const value = record(input, V2_FIELDS);
        if (value.version !== CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2
            || value.policyVersion !== 'p14-q9r-context-compiler-v2') reject();
        const attempts = attemptsV2(value.attempts);
        const requestDigest = agentClosureDigest(value.requestDigest, 'context-compiler-source-request');
        if (attempts.at(-1)!.requestDigest !== requestDigest) reject();
        const core = {
            version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2,
            manifest: parseContextCompilerInputManifest(value.manifest),
            sessionId: agentClosureToken(value.sessionId, 'context-compiler-source-session'),
            runId: agentClosureToken(value.runId, 'context-compiler-source-run'),
            sourceRevision: agentClosureToken(value.sourceRevision, 'context-compiler-source-revision'),
            policyVersion: 'p14-q9r-context-compiler-v2' as const,
            attempts, requestDigest,
            capsuleDigest: agentClosureDigest(value.capsuleDigest, 'context-compiler-source-capsule'),
        };
        return Object.freeze({ ...core, receiptDigest: digest(core) });
    } catch { reject(); }
}

/** Verify metadata coverage; byte-level fragment truth must be checked against source text by the live host. */
function fragmentsV3(input: unknown, manifest: ContextCompilerInputManifestV1): readonly ContextCompilerReceiptFragmentV3[] {
    if (!Array.isArray(input) || types.isProxy(input) || input.length < 1 || input.length > 128
        || Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) reject();
    const sources = new Map(manifest.sources.map(source => [source.sourceId, source]));
    const next = new Map<string, { offset: number; ordinal: number }>();
    const ids = new Set<string>();
    let previousBatch = 1;
    const fragments: ContextCompilerReceiptFragmentV3[] = [];
    for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
        const row = record(descriptor.value, FRAGMENT_FIELDS);
        const sourceId = agentClosureToken(row.sourceId, 'context-compiler-fragment-source');
        const fragmentId = agentClosureToken(row.fragmentId, 'context-compiler-fragment-id');
        const original = sources.get(sourceId);
        if (!original || ids.has(fragmentId) || (row.batch !== 1 && row.batch !== 2)
            || Number(row.batch) < previousBatch || (index === 0 && row.batch !== 1)
            || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || !Number.isSafeInteger(row.ordinal)) reject();
        const prior = next.get(sourceId) ?? { offset: 0, ordinal: 0 };
        const start = Number(row.start), end = Number(row.end), ordinal = Number(row.ordinal);
        const sourceDigest = agentClosureDigest(row.sourceDigest, 'context-compiler-fragment-source-digest');
        const textDigest = agentClosureDigest(row.textDigest, 'context-compiler-fragment-text-digest');
        if (sourceDigest !== original.sourceDigest || start !== prior.offset || ordinal !== prior.ordinal
            || end <= start || end > original.textLength) reject();
        if (sources.has(fragmentId) && (fragmentId !== sourceId || start !== 0 || end !== original.textLength)) reject();
        if (start === 0 && end === original.textLength
            && (fragmentId !== sourceId || textDigest !== original.textDigest)) reject();
        ids.add(fragmentId); previousBatch = Number(row.batch);
        next.set(sourceId, { offset: end, ordinal: ordinal + 1 });
        fragments.push(Object.freeze({ batch: row.batch as 1 | 2, fragmentId, sourceId, sourceDigest,
            textDigest, start, end, ordinal }));
    }
    if (next.size !== sources.size || manifest.sources.some(source => next.get(source.sourceId)?.offset !== source.textLength)) reject();
    return Object.freeze(fragments);
}

export function createContextCompilerSkillSourceReceiptV3(
    input: Omit<ContextCompilerSkillSourceReceiptV3, 'receiptDigest'>,
): ContextCompilerSkillSourceReceiptV3 {
    try {
        const value = record(input, V3_FIELDS);
        if (value.version !== CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3
            || value.policyVersion !== 'p14-q9r-context-compiler-v2') reject();
        const manifest = parseContextCompilerInputManifest(value.manifest);
        const attempts = attemptsV2(value.attempts);
        const fragments = fragmentsV3(value.fragments, manifest);
        const fragmentDigest = agentClosureDigest(value.fragmentDigest, 'context-compiler-fragment-digest');
        if (fragmentDigest !== digest(fragments)) reject();
        const compilationCount = attempts.filter(attempt => attempt.phase === 'compile').length;
        if (compilationCount !== new Set(fragments.map(fragment => fragment.batch)).size) reject();
        const requestDigest = agentClosureDigest(value.requestDigest, 'context-compiler-source-request');
        if (attempts.at(-1)!.requestDigest !== requestDigest) reject();
        const core = { version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3, manifest,
            sessionId: agentClosureToken(value.sessionId, 'context-compiler-source-session'),
            runId: agentClosureToken(value.runId, 'context-compiler-source-run'),
            sourceRevision: agentClosureToken(value.sourceRevision, 'context-compiler-source-revision'),
            policyVersion: 'p14-q9r-context-compiler-v2' as const, attempts, requestDigest,
            capsuleDigest: agentClosureDigest(value.capsuleDigest, 'context-compiler-source-capsule'),
            renderDigest: agentClosureDigest(value.renderDigest, 'context-compiler-render-digest'),
            fragmentDigest, fragments };
        return Object.freeze({ ...core, receiptDigest: digest(core) });
    } catch { reject(); }
}

/** Historical parsing validates the retained digest and never consults current configuration. */
export function parseContextCompilerSkillSourceReceipt(input: unknown): ContextCompilerSkillSourceReceipt {
    try {
        if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) reject();
        const version = Object.getOwnPropertyDescriptor(input, 'version');
        if (!version || !version.enumerable || !Object.hasOwn(version, 'value')) reject();
        if (version.value === CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3) {
            const value = record(input, [...V3_FIELDS, 'receiptDigest']);
            const { receiptDigest, ...core } = value;
            const receipt = createContextCompilerSkillSourceReceiptV3(core as unknown as Omit<ContextCompilerSkillSourceReceiptV3, 'receiptDigest'>);
            if (agentClosureDigest(receiptDigest, 'context-compiler-source-receipt') !== receipt.receiptDigest) reject();
            return receipt;
        }
        if (version.value === CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2) {
            const value = record(input, [...V2_FIELDS, 'receiptDigest']);
            const receipt = createContextCompilerSkillSourceReceiptV2({
                version: value.version as ContextCompilerSkillSourceReceiptV2['version'],
                manifest: value.manifest as ContextCompilerInputManifestV1,
                sessionId: value.sessionId as string, runId: value.runId as string,
                sourceRevision: value.sourceRevision as string,
                policyVersion: value.policyVersion as ContextCompilerSkillSourceReceiptV2['policyVersion'],
                attempts: value.attempts as ContextCompilerSkillSourceReceiptV2['attempts'],
                requestDigest: value.requestDigest as string, capsuleDigest: value.capsuleDigest as string,
            });
            if (agentClosureDigest(value.receiptDigest, 'context-compiler-source-receipt') !== receipt.receiptDigest) reject();
            return receipt;
        }
        const value = record(input, [...FIELDS, 'receiptDigest']);
        const receipt = createContextCompilerSkillSourceReceipt({
            version: value.version as ContextCompilerSkillSourceReceiptV1['version'],
            manifest: value.manifest as ContextCompilerInputManifestV1,
            sessionId: value.sessionId as string, runId: value.runId as string,
            sourceRevision: value.sourceRevision as string, policyVersion: value.policyVersion as string,
            requestDigest: value.requestDigest as string, capsuleDigest: value.capsuleDigest as string,
        });
        if (agentClosureDigest(value.receiptDigest, 'context-compiler-source-receipt') !== receipt.receiptDigest) reject();
        return receipt;
    } catch { reject(); }
}
