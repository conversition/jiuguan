/** Strict data-only Context Compiler inputs and retained manifests; no execution authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const CONTEXT_COMPILER_INPUT_VERSION = 'context-compiler-input-v1' as const;

export interface ContextCompilerInputSourceV1 {
    readonly sourceId: string;
    readonly sourceDigest: string;
    readonly text: string;
    readonly priority: number;
    readonly required: boolean;
    readonly containsNegativeFacts: boolean;
    readonly containsUnresolvedConflicts: boolean;
}

export interface ContextCompilerInputV1 {
    readonly version: typeof CONTEXT_COMPILER_INPUT_VERSION;
    readonly sources: readonly ContextCompilerInputSourceV1[];
    readonly targetTokens: number;
}

export interface ContextCompilerInputSourceManifestV1 {
    readonly sourceId: string;
    readonly sourceDigest: string;
    readonly textDigest: string;
    readonly textLength: number;
    readonly priority: number;
    readonly required: boolean;
    readonly containsNegativeFacts: boolean;
    readonly containsUnresolvedConflicts: boolean;
}

export interface ContextCompilerInputManifestV1 {
    readonly inputVersion: typeof CONTEXT_COMPILER_INPUT_VERSION;
    /** Original identity: only sorted sourceId/sourceDigest pairs, byte-for-byte compatible. */
    readonly sourceDigest: string;
    readonly targetTokens: number;
    readonly sources: readonly ContextCompilerInputSourceManifestV1[];
    /** Covers every manifest field above; the original sourceDigest is deliberately unchanged. */
    readonly inputDigest: string;
}

const SOURCE_REQUIRED = ['sourceId', 'sourceDigest', 'text', 'priority'] as const;
const FLAGS = ['required', 'containsNegativeFacts', 'containsUnresolvedConflicts'] as const;
const MANIFEST_SOURCE_FIELDS = ['sourceId', 'sourceDigest', 'textDigest', 'textLength', 'priority', ...FLAGS];
const HASH = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;

function invalid(manifest: boolean): never {
    throw new Error(manifest ? 'context-compiler-input-manifest-invalid' : 'context-compiler-input-invalid');
}

function object(value: unknown, required: readonly string[], optional: readonly string[], manifest: boolean):
Record<string, unknown> {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(manifest);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) invalid(manifest);
        const item = descriptors[key]!;
        if (!item.enumerable || !Object.hasOwn(item, 'value')) invalid(manifest);
    }
    if (required.some((key) => !Object.hasOwn(descriptors, key))) invalid(manifest);
    return value as Record<string, unknown>;
}

function list(value: unknown, manifest: boolean): readonly unknown[] {
    if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length < 1 || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) {
        invalid(manifest);
    }
    return Array.from({ length: value.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item?.enumerable || !Object.hasOwn(item, 'value')) invalid(manifest);
        return item.value;
    });
}

function id(value: unknown, manifest: boolean): string {
    if (typeof value !== 'string' || value.trim() !== value || !SOURCE_ID.test(value)) invalid(manifest);
    return value;
}

function hash(value: unknown, manifest: boolean): string {
    if (typeof value !== 'string' || value.length !== 71 || !HASH.test(value)) invalid(manifest);
    return value;
}

function integer(value: unknown, min: number, max: number, manifest: boolean): number {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(manifest);
    return Number(value);
}

function priority(value: unknown, manifest: boolean): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(manifest);
    return value;
}

function flags(value: Record<string, unknown>, manifest: boolean) {
    for (const key of FLAGS) {
        if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') invalid(manifest);
    }
    return {
        required: Object.hasOwn(value, 'required') && value.required === true,
        containsNegativeFacts: Object.hasOwn(value, 'containsNegativeFacts') && value.containsNegativeFacts === true,
        containsUnresolvedConflicts: Object.hasOwn(value, 'containsUnresolvedConflicts') && value.containsUnresolvedConflicts === true,
    };
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function sourceIdentity(sources: readonly { readonly sourceId: string; readonly sourceDigest: string }[]): string {
    return digest(sources.map(({ sourceId, sourceDigest }) => ({ sourceId, sourceDigest }))
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
}

function unique(sources: readonly { readonly sourceId: string }[], manifest: boolean): void {
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) invalid(manifest);
}

/** Preserve source order for the existing request builder. No source getter or Proxy is evaluated. */
export function parseContextCompilerInput(value: unknown): ContextCompilerInputV1 {
    const row = object(value, ['version', 'sources', 'targetTokens'], [], false);
    if (row.version !== CONTEXT_COMPILER_INPUT_VERSION) invalid(false);
    const sources = list(row.sources, false).map((entry) => {
        const source = object(entry, SOURCE_REQUIRED, FLAGS, false);
        if (typeof source.text !== 'string' || source.text.length < 1 || source.text.length > 200_000) invalid(false);
        return Object.freeze({ sourceId: id(source.sourceId, false), sourceDigest: hash(source.sourceDigest, false),
            text: source.text, priority: priority(source.priority, false), ...flags(source, false) });
    });
    unique(sources, false);
    return Object.freeze({ version: CONTEXT_COMPILER_INPUT_VERSION, sources: Object.freeze(sources),
        targetTokens: integer(row.targetTokens, 256, 8_000, false) });
}

/** Full text is hashed through JSON to distinguish every UTF-16 input, including lone surrogates. */
export function contextCompilerInputManifest(input: ContextCompilerInputV1): ContextCompilerInputManifestV1 {
    const parsed = parseContextCompilerInput(input);
    const sources = Object.freeze(parsed.sources.map((source) => Object.freeze({
        sourceId: source.sourceId, sourceDigest: source.sourceDigest,
        textDigest: digest(source.text), textLength: source.text.length, priority: source.priority,
        required: source.required, containsNegativeFacts: source.containsNegativeFacts,
        containsUnresolvedConflicts: source.containsUnresolvedConflicts,
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
    const base = { inputVersion: CONTEXT_COMPILER_INPUT_VERSION, sourceDigest: sourceIdentity(sources),
        targetTokens: parsed.targetTokens, sources };
    return Object.freeze({ ...base, inputDigest: digest(base) });
}

/** Recompute metadata identity only; a durable manifest never restores source or Provider authority. */
export function parseContextCompilerInputManifest(value: unknown): ContextCompilerInputManifestV1 {
    const row = object(value, ['inputVersion', 'sourceDigest', 'targetTokens', 'sources', 'inputDigest'], [], true);
    if (row.inputVersion !== CONTEXT_COMPILER_INPUT_VERSION) invalid(true);
    const sources = list(row.sources, true).map((entry) => {
        const source = object(entry, MANIFEST_SOURCE_FIELDS, [], true);
        return Object.freeze({ sourceId: id(source.sourceId, true), sourceDigest: hash(source.sourceDigest, true),
            textDigest: hash(source.textDigest, true), textLength: integer(source.textLength, 1, 200_000, true),
            priority: priority(source.priority, true), ...flags(source, true) });
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    unique(sources, true);
    const base = { inputVersion: CONTEXT_COMPILER_INPUT_VERSION, sourceDigest: sourceIdentity(sources),
        targetTokens: integer(row.targetTokens, 256, 8_000, true), sources: Object.freeze(sources) };
    const inputDigest = digest(base);
    if (hash(row.sourceDigest, true) !== base.sourceDigest || hash(row.inputDigest, true) !== inputDigest) invalid(true);
    return Object.freeze({ ...base, inputDigest });
}
