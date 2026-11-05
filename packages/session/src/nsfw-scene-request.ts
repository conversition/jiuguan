/** Native deterministic scene request evidence; this is neither a Skill brand nor execution authority. */
import { createHash } from 'node:crypto';

export const NSFW_SCENE_REQUEST_VERSION = 'nsfw-scene-request-v1' as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MAX_RECEIPT_BYTES = 8_192;
const KEYS = Object.freeze([
    'version', 'sessionId', 'runId', 'round', 'historyEpoch', 'safetyDigest', 'sourceRevision',
    'sceneDigest', 'inputDigest', 'decisionDigest', 'exposureDigests', 'queryHeadDigest',
    'requestDigest', 'assistantMessageId', 'assistantDigest', 'createdAt', 'receiptDigest',
]);

export interface NsfwSceneRequestReceipt {
    readonly version: typeof NSFW_SCENE_REQUEST_VERSION;
    readonly sessionId: string;
    readonly runId: string;
    readonly round: number;
    readonly historyEpoch: number;
    readonly safetyDigest: string;
    readonly sourceRevision: string;
    readonly sceneDigest: string;
    readonly inputDigest: string;
    readonly decisionDigest: string;
    readonly exposureDigests: readonly string[];
    readonly queryHeadDigest: string;
    readonly requestDigest: string;
    readonly assistantMessageId: number;
    readonly assistantDigest: string;
    readonly createdAt: string;
    readonly receiptDigest: string;
}

/** Callers supply ordered native metadata or the exact request representation they captured. */
export function nsfwSceneRequestDigest(value: unknown): string {
    try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== 'string') throw new Error();
        return `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
    } catch { throw new Error('nsfw-scene-request-digest-invalid'); }
}

type ReceiptInput = Omit<NsfwSceneRequestReceipt, 'version' | 'receiptDigest'>;

function assertDataKeys(value: unknown, keys: readonly string[]): asserts value is object {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length
        || keys.some(key => !Object.hasOwn(descriptors, key)
            || !Object.hasOwn(descriptors[key]!, 'value'))) throw new Error();
}

function metadata(input: ReceiptInput): Omit<NsfwSceneRequestReceipt, 'receiptDigest'> {
    return {
        version: NSFW_SCENE_REQUEST_VERSION,
        sessionId: input.sessionId,
        runId: input.runId,
        round: input.round,
        historyEpoch: input.historyEpoch,
        safetyDigest: input.safetyDigest,
        sourceRevision: input.sourceRevision,
        sceneDigest: input.sceneDigest,
        inputDigest: input.inputDigest,
        decisionDigest: input.decisionDigest,
        exposureDigests: Object.freeze([...input.exposureDigests]),
        queryHeadDigest: input.queryHeadDigest,
        requestDigest: input.requestDigest,
        assistantMessageId: input.assistantMessageId,
        assistantDigest: input.assistantDigest,
        createdAt: input.createdAt,
    };
}

/** Reparse persisted metadata without conferring a live permission or reading current assets. */
export function parseNsfwSceneRequestReceipt(value: unknown): NsfwSceneRequestReceipt {
    try {
        assertDataKeys(value, KEYS);
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RECEIPT_BYTES) throw new Error();
        const input = value as NsfwSceneRequestReceipt;
        if (input.version !== NSFW_SCENE_REQUEST_VERSION
            || typeof input.sessionId !== 'string' || !TOKEN.test(input.sessionId)
            || typeof input.runId !== 'string' || !TOKEN.test(input.runId)
            || !Number.isSafeInteger(input.round) || input.round < 1
            || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0
            || !Number.isSafeInteger(input.assistantMessageId) || input.assistantMessageId < 1
            || typeof input.createdAt !== 'string'
            || new Date(input.createdAt).toISOString() !== input.createdAt
            || !Array.isArray(input.exposureDigests) || input.exposureDigests.length < 1
            || input.exposureDigests.length > 3
            || new Set(input.exposureDigests).size !== input.exposureDigests.length) throw new Error();
        for (const digest of [input.safetyDigest, input.sourceRevision, input.sceneDigest,
            input.inputDigest, input.decisionDigest, ...input.exposureDigests,
            input.queryHeadDigest, input.requestDigest, input.assistantDigest, input.receiptDigest]) {
            if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error();
        }
        const normalized = metadata(input);
        if (nsfwSceneRequestDigest(normalized) !== input.receiptDigest) throw new Error();
        return Object.freeze({ ...normalized, receiptDigest: input.receiptDigest });
    } catch { throw new Error('nsfw-scene-request-receipt-invalid'); }
}

export function createNsfwSceneRequestReceipt(input: ReceiptInput): NsfwSceneRequestReceipt {
    try {
        assertDataKeys(input, KEYS.filter(key => key !== 'version' && key !== 'receiptDigest'));
        const normalized = metadata(input);
        return parseNsfwSceneRequestReceipt({ ...normalized, receiptDigest: nsfwSceneRequestDigest(normalized) });
    } catch { throw new Error('nsfw-scene-request-receipt-invalid'); }
}
