/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Explicit, in-memory limits for untrusted tool results and evidence carriers.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export const TOOL_RESULT_CONTRACT_VERSION = 'tool-result-contract-v1' as const;
export const TOOL_RESULT_SIZE_UNIT = 'utf16-code-units' as const;
export const TOOL_RESULT_BOUND_RULE = 'utf16-payload-limit-including-partial-marker' as const;

export type ToolResultScope = 'tool-result' | 'evidence-carrier';

export interface ToolResultContractMetadata {
    readonly version: typeof TOOL_RESULT_CONTRACT_VERSION;
    readonly scope: ToolResultScope;
    readonly state: 'complete' | 'partial';
    readonly sizeUnit: typeof TOOL_RESULT_SIZE_UNIT;
    readonly originalLength: number;
    readonly returnedLength: number;
    readonly previewLength: number;
    readonly maxLength: number;
    /** Hash UTF-16LE code units without losing lone surrogates through UTF-8 replacement. */
    readonly sourceDigest: string;
    readonly digestEncoding: 'utf16le';
    /** Bounding is not a domain output validator and never parses the source just to classify it. */
    readonly parseability: 'not-asserted' | 'not-complete-json';
    readonly reason?: 'result-limit-exceeded' | 'result-limit-too-small-for-marker';
}

export interface BoundedToolResult {
    readonly text: string;
    readonly metadata: ToolResultContractMetadata;
}

/** A location hint only: a host must independently authorize every body read. */
export interface ExternalToolResultReference {
    readonly refId: string;
    readonly expiresAtMs: number;
}

export interface ExternalToolResultRequest {
    readonly runId: string;
    readonly sessionId?: string;
    readonly inputRevision: string;
    readonly stepOrdinal: number;
    readonly toolName: 'query_memory' | 'get_worldbook';
    readonly toolCallId: string;
    readonly body: string;
    readonly maxLength: number;
    readonly signal: AbortSignal;
}

const externalizationErrors = new WeakSet<object>();

/** External storage failures must escape the optional Prelude's fallback boundary. */
export class InteractiveToolResultExternalizationError extends Error {
    constructor(cause?: unknown) {
        super('interactive-tool-result-externalization-failed', { cause });
        this.name = 'InteractiveToolResultExternalizationError';
        externalizationErrors.add(this);
    }
}

export function isInteractiveToolResultExternalizationError(
    value: unknown,
): value is InteractiveToolResultExternalizationError {
    return typeof value === 'object' && value !== null && externalizationErrors.has(value);
}

/** Inspect own data only; a descriptor never gets to run getters, Proxy traps or coercions. */
export function parseExternalToolResultReference(value: unknown): ExternalToolResultReference {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 2 || !keys.includes('refId') || !keys.includes('expiresAtMs')) throw new TypeError();
        const ref = Object.getOwnPropertyDescriptor(value, 'refId');
        const expiry = Object.getOwnPropertyDescriptor(value, 'expiresAtMs');
        if (ref?.enumerable !== true || expiry?.enumerable !== true
            || !Object.hasOwn(ref, 'value') || !Object.hasOwn(expiry, 'value')
            || typeof ref.value !== 'string' || !/^tool-result-body:[a-f0-9]{64}$/u.test(ref.value)
            || !Number.isSafeInteger(expiry.value) || expiry.value <= 0) throw new TypeError();
        return Object.freeze({ refId: ref.value, expiresAtMs: expiry.value });
    } catch (cause) {
        throw new InteractiveToolResultExternalizationError(cause);
    }
}

function boundedPrefix(value: string, length: number): string {
    const prefix = value.slice(0, length);
    const tail = prefix.charCodeAt(prefix.length - 1);
    const next = value.charCodeAt(prefix.length);
    return tail >= 0xd800 && tail <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        ? prefix.slice(0, -1) : prefix;
}

/**
 * Metadata carries completeness even when the cap cannot fit a whole marker.
 * Marker fields never interpolate source text, so source content cannot forge its framing.
 */
export function boundToolResult(
    value: string,
    maxLength: number,
    scope: ToolResultScope = 'tool-result',
): BoundedToolResult {
    if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new Error('tool-result-limit-invalid');
    if (scope !== 'tool-result' && scope !== 'evidence-carrier') throw new Error('tool-result-scope-invalid');
    const sourceDigest = `sha256:${createHash('sha256').update(value, 'utf16le').digest('hex')}`;
    const common = {
        version: TOOL_RESULT_CONTRACT_VERSION,
        scope,
        sizeUnit: TOOL_RESULT_SIZE_UNIT,
        originalLength: value.length,
        maxLength,
        sourceDigest,
        digestEncoding: 'utf16le' as const,
    };
    if (value.length <= maxLength) {
        return Object.freeze({
            text: value, metadata: Object.freeze({
                ...common,
                state: 'complete',
                returnedLength: value.length,
                previewLength: value.length,
                parseability: 'not-asserted',
            })
        });
    }
    const marker = `[PARTIAL_TOOL_RESULT version=${TOOL_RESULT_CONTRACT_VERSION} scope=${scope}`
        + ` unit=${TOOL_RESULT_SIZE_UNIT} original=${value.length} digest=${sourceDigest}`
        + ' parseability=not-complete-json]\n';
    const hasMarker = marker.length <= maxLength;
    const preview = hasMarker ? boundedPrefix(value, maxLength - marker.length) : '';
    const text = hasMarker ? marker + preview : '';
    return Object.freeze({
        text, metadata: Object.freeze({
            ...common,
            state: 'partial',
            returnedLength: text.length,
            previewLength: preview.length,
            parseability: 'not-complete-json',
            reason: hasMarker ? 'result-limit-exceeded' : 'result-limit-too-small-for-marker',
        })
    });
}

/**
 * Preserve the original partial-body identity while fitting a host-owned ref and preview
 * into the same payload cap. Externalization never turns a preview into complete evidence.
 */
export function boundExternalToolResult(
    value: string,
    maxLength: number,
    reference: unknown,
): BoundedToolResult {
    const ref = parseExternalToolResultReference(reference);
    if (!Number.isSafeInteger(maxLength) || maxLength < 0 || value.length <= maxLength) {
        throw new InteractiveToolResultExternalizationError();
    }
    const marker = `[EXTERNAL_TOOL_RESULT ref=${ref.refId} expiresAtMs=${ref.expiresAtMs}]\n`;
    const available = maxLength - marker.length;
    if (available < 0) throw new InteractiveToolResultExternalizationError();
    const bounded = boundToolResult(value, available);
    if (bounded.metadata.state !== 'partial' || bounded.metadata.reason !== 'result-limit-exceeded') {
        throw new InteractiveToolResultExternalizationError();
    }
    const text = marker + bounded.text;
    return Object.freeze({
        text,
        metadata: Object.freeze({ ...bounded.metadata, maxLength, returnedLength: text.length }),
    });
}
