/** Deterministic NSFW Skill provenance; neither a model Lease nor current execution authority. */
import { nsfwSceneRequestDigest, type NsfwSceneRequestReceipt } from './nsfw-scene-request.ts';

export const NSFW_SCENE_SKILL_SOURCE_VERSION = 'nsfw-scene-skill-source-v1' as const;
export const NSFW_SCENE_SKILL_RECEIPT_VERSION = 'nsfw-scene-skill-receipt-v1' as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const LIVE_RECEIPTS = new WeakSet<object>();
const SOURCE_KEYS = Object.freeze([
    'sourceVersion', 'sessionId', 'runId', 'round', 'historyEpoch', 'sourceRevision',
    'safetyDigest', 'sceneDigest', 'decisionDigest', 'queryHeadDigest', 'exposureDigests', 'sourceDigest',
]);
const RECEIPT_KEYS = Object.freeze([
    'version', 'profileId', 'executionKind', 'source', 'nativeReceiptDigest', 'requestDigest',
    'queryHeadDigest', 'instructionDigest', 'catalogRevision', 'selectionReceiptDigest',
    'instructionSetDigest', 'policyRevision', 'authorizationDigest', 'sourceAuthorityRevision',
    'artifactDigest', 'admissionDigest', 'profileRegistryRevision', 'authorityRevision',
    'selectedManifestDigests', 'preparedAt', 'acceptedAt', 'receiptDigest',
]);

export interface NsfwSceneSkillSource {
    readonly sourceVersion: typeof NSFW_SCENE_SKILL_SOURCE_VERSION;
    readonly sessionId: string;
    readonly runId: string;
    readonly round: number;
    readonly historyEpoch: number;
    readonly sourceRevision: string;
    readonly safetyDigest: string;
    readonly sceneDigest: string;
    readonly decisionDigest: string;
    readonly queryHeadDigest: string;
    readonly exposureDigests: readonly string[];
    readonly sourceDigest: string;
}

export interface NsfwSceneSkillReceipt {
    readonly version: typeof NSFW_SCENE_SKILL_RECEIPT_VERSION;
    readonly profileId: 'maintenance.nsfwScene';
    readonly executionKind: 'deterministic';
    readonly source: NsfwSceneSkillSource;
    readonly nativeReceiptDigest: string;
    readonly requestDigest: string;
    readonly queryHeadDigest: string;
    readonly instructionDigest: string;
    readonly catalogRevision: string;
    readonly selectionReceiptDigest: string;
    readonly instructionSetDigest: string;
    readonly policyRevision: string;
    readonly authorizationDigest: string;
    readonly sourceAuthorityRevision: string;
    readonly artifactDigest: string;
    readonly admissionDigest: string;
    readonly profileRegistryRevision: string;
    readonly authorityRevision: string;
    readonly selectedManifestDigests: readonly string[];
    readonly preparedAt: string;
    readonly acceptedAt: string;
    readonly receiptDigest: string;
}

export interface NsfwSceneSkillPrepared {
    /** Official compiled promptInstruction; the Session owns its system-slot placement and token accounting. */
    readonly instruction: string;
    assertCurrent(): void;
    /** Called within the accepted-turn transaction, after its synchronous current-source fence. */
    sealAccepted(native: NsfwSceneRequestReceipt): NsfwSceneSkillReceipt;
}

/** Server-only port. Its required predicate is authoritative for the current rollout state. */
export interface NsfwSceneSkillHost {
    required(): boolean;
    prepare(input: {
        readonly source: NsfwSceneSkillSource;
        readonly queryHead: string;
        readonly assertCurrent: () => void;
    }): Promise<NsfwSceneSkillPrepared>;
}

type SourceInput = Omit<NsfwSceneSkillSource, 'sourceVersion' | 'sourceDigest'>;
type ReceiptInput = Omit<NsfwSceneSkillReceipt, 'version' | 'profileId' | 'executionKind' | 'receiptDigest'>;

function dataKeys(value: unknown, keys: readonly string[]): asserts value is object {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
        !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value'))) throw new Error();
}

function digests(value: unknown, minimum: number, maximum: number): readonly string[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length < minimum || value.length > maximum
        || Reflect.ownKeys(value).length !== value.length + 1) throw new Error();
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
            || !DIGEST.test(descriptor.value)) throw new Error();
    }
    if (new Set(value).size !== value.length) throw new Error();
    return Object.freeze([...value]);
}

function hash(value: unknown): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error();
    return value;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error();
    return value;
}

function sourceMetadata(input: SourceInput): Omit<NsfwSceneSkillSource, 'sourceDigest'> {
    if (typeof input.sessionId !== 'string' || !TOKEN.test(input.sessionId)
        || typeof input.runId !== 'string' || !TOKEN.test(input.runId)
        || !Number.isSafeInteger(input.round) || input.round < 1
        || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0) throw new Error();
    return {
        sourceVersion: NSFW_SCENE_SKILL_SOURCE_VERSION,
        sessionId: input.sessionId, runId: input.runId, round: input.round, historyEpoch: input.historyEpoch,
        sourceRevision: hash(input.sourceRevision), safetyDigest: hash(input.safetyDigest),
        sceneDigest: hash(input.sceneDigest), decisionDigest: hash(input.decisionDigest),
        queryHeadDigest: hash(input.queryHeadDigest), exposureDigests: digests(input.exposureDigests, 1, 3),
    };
}

/** Pure historical metadata parsing confers neither a host binding nor current authority. */
export function parseNsfwSceneSkillSource(value: unknown): NsfwSceneSkillSource {
    try {
        dataKeys(value, SOURCE_KEYS);
        const input = value as NsfwSceneSkillSource;
        if (input.sourceVersion !== NSFW_SCENE_SKILL_SOURCE_VERSION) throw new Error();
        const metadata = sourceMetadata(input);
        if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8_192
            || nsfwSceneRequestDigest(metadata) !== hash(input.sourceDigest)) throw new Error();
        return Object.freeze({ ...metadata, sourceDigest: input.sourceDigest });
    } catch { throw new Error('nsfw-scene-skill-source-invalid'); }
}

export function createNsfwSceneSkillSource(input: SourceInput): NsfwSceneSkillSource {
    try {
        dataKeys(input, SOURCE_KEYS.filter(key => key !== 'sourceVersion' && key !== 'sourceDigest'));
        const metadata = sourceMetadata(input);
        return parseNsfwSceneSkillSource({ ...metadata, sourceDigest: nsfwSceneRequestDigest(metadata) });
    } catch { throw new Error('nsfw-scene-skill-source-invalid'); }
}

function receiptMetadata(input: ReceiptInput): Omit<NsfwSceneSkillReceipt, 'receiptDigest'> {
    const source = parseNsfwSceneSkillSource(input.source);
    const preparedAt = timestamp(input.preparedAt), acceptedAt = timestamp(input.acceptedAt);
    if (preparedAt > acceptedAt || hash(input.queryHeadDigest) !== source.queryHeadDigest) throw new Error();
    return {
        version: NSFW_SCENE_SKILL_RECEIPT_VERSION, profileId: 'maintenance.nsfwScene', executionKind: 'deterministic',
        source, nativeReceiptDigest: hash(input.nativeReceiptDigest), requestDigest: hash(input.requestDigest),
        queryHeadDigest: input.queryHeadDigest, instructionDigest: hash(input.instructionDigest),
        catalogRevision: hash(input.catalogRevision), selectionReceiptDigest: hash(input.selectionReceiptDigest),
        instructionSetDigest: hash(input.instructionSetDigest), policyRevision: hash(input.policyRevision),
        authorizationDigest: hash(input.authorizationDigest), sourceAuthorityRevision: hash(input.sourceAuthorityRevision),
        artifactDigest: hash(input.artifactDigest), admissionDigest: hash(input.admissionDigest),
        profileRegistryRevision: hash(input.profileRegistryRevision), authorityRevision: hash(input.authorityRevision),
        selectedManifestDigests: digests(input.selectedManifestDigests, 1, 1), preparedAt, acceptedAt,
    };
}

/** Reopened JSON remains historical even when it has a valid receipt digest. */
export function parseNsfwSceneSkillReceipt(value: unknown): NsfwSceneSkillReceipt {
    try {
        dataKeys(value, RECEIPT_KEYS);
        const input = value as NsfwSceneSkillReceipt;
        if (input.version !== NSFW_SCENE_SKILL_RECEIPT_VERSION || input.profileId !== 'maintenance.nsfwScene'
            || input.executionKind !== 'deterministic') throw new Error();
        const metadata = receiptMetadata(input);
        if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 16_384
            || nsfwSceneRequestDigest(metadata) !== hash(input.receiptDigest)) throw new Error();
        return Object.freeze({ ...metadata, receiptDigest: input.receiptDigest });
    } catch { throw new Error('nsfw-scene-skill-receipt-invalid'); }
}

/** Issuance is reserved for the trusted deterministic host; it does not grant model/tool/write authority. */
export function sealNsfwSceneSkillReceipt(input: ReceiptInput): NsfwSceneSkillReceipt {
    try {
        dataKeys(input, RECEIPT_KEYS.filter(key => !['version', 'profileId', 'executionKind', 'receiptDigest'].includes(key)));
        const metadata = receiptMetadata(input);
        const receipt = parseNsfwSceneSkillReceipt({ ...metadata, receiptDigest: nsfwSceneRequestDigest(metadata) });
        LIVE_RECEIPTS.add(receipt);
        return receipt;
    } catch { throw new Error('nsfw-scene-skill-receipt-invalid'); }
}

export function isNsfwSceneSkillReceipt(value: unknown): value is NsfwSceneSkillReceipt {
    return value !== null && typeof value === 'object' && LIVE_RECEIPTS.has(value);
}
