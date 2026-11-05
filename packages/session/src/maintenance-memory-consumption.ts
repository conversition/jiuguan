/** @author Codex @date 2026-10-14 @version 1.0
 * Prove the designated Memory slot survived assembly and the successful Provider attempt unchanged.
 */
import { createHash } from 'node:crypto';
import {
    TOOL_RESULT_CONTRACT_VERSION,
    TOOL_RESULT_SIZE_UNIT,
    type ToolResultContractMetadata,
} from '../../harness/public/tool-result-contract.ts';
import type { ChatRequest } from '../../proxy/public/client.ts';
import { interactiveEvidenceBlock, messageText } from './interactive-consumption.ts';

type MemoryMessage = ChatRequest['messages'][number];

export interface MemoryConsumptionRecallHit {
    readonly rowId: number;
    readonly code: string;
    readonly category: string;
    readonly content: string;
    readonly score: number;
    readonly source: string;
    readonly confidence: string;
}

export interface MemoryConsumptionHit {
    readonly rowId: number;
    readonly code: string;
    readonly contentDigest: string;
}

export interface MemoryConsumptionCarrier {
    readonly messageIndex: number;
    readonly originalText: string;
    readonly hits: readonly MemoryConsumptionHit[];
}

export interface BoundMemoryConsumptionCarrier {
    readonly messageIndex: number;
    readonly carrierDigest: string;
    readonly hits: readonly MemoryConsumptionHit[];
}

interface InteractiveMemoryHit extends MemoryConsumptionRecallHit {
    readonly recordKey: string;
    readonly reasons?: readonly string[];
}

type InteractiveMemoryCategory = 'arc' | 'summary' | 'event' | 'state' | 'lore';

interface InteractivePreludeCompleteness {
    readonly state: 'complete' | 'partial';
    readonly toolResults: readonly {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly metadata: ToolResultContractMetadata;
    }[];
    readonly evidenceCarrier: ToolResultContractMetadata;
}

const QUERY_MEMORY_HEADER = '[query_memory]\n';
const MAX_INTERACTIVE_EVIDENCE_CHARS = 32_768;
const MAX_INTERACTIVE_QUERY_CHARS = 500;
const MAX_INTERACTIVE_HITS = 32;
const MAX_INTERACTIVE_HIT_CONTENT_CHARS = 1_200;

function plainRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    return required.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => allowed.has(key));
}

function interactiveMemoryHit(value: unknown): InteractiveMemoryHit | null {
    const hit = plainRecord(value);
    const required = ['recordKey', 'rowId', 'code', 'category', 'content', 'score', 'source', 'confidence'];
    if (!hit || !exactKeys(hit, required, ['reasons'])
        || typeof hit.recordKey !== 'string' || hit.recordKey.length < 1 || hit.recordKey.length > 256
        || !Number.isSafeInteger(hit.rowId) || Number(hit.rowId) < 1
        || typeof hit.code !== 'string' || hit.code.length > 256
        || !['arc', 'summary', 'event', 'state', 'lore'].includes(String(hit.category))
        || typeof hit.content !== 'string' || hit.content.length < 1
        || hit.content.length > MAX_INTERACTIVE_HIT_CONTENT_CHARS
        || typeof hit.score !== 'number' || !Number.isFinite(hit.score)
        || typeof hit.source !== 'string' || hit.source.length < 1 || hit.source.length > 64
        || /[\u0000-\u001f\u007f]/u.test(hit.source)
        || !['high', 'low'].includes(String(hit.confidence))
        || !hit.recordKey.endsWith(`:${hit.category}:${hit.rowId}`)
        || (hit.reasons !== undefined && (!Array.isArray(hit.reasons) || hit.reasons.length > 8
            || hit.reasons.some((reason) => typeof reason !== 'string' || reason.length > 160)))) return null;
    return Object.freeze({
        recordKey: hit.recordKey,
        rowId: Number(hit.rowId),
        code: hit.code,
        category: hit.category as InteractiveMemoryCategory,
        content: hit.content,
        score: hit.score,
        source: hit.source,
        confidence: hit.confidence,
        ...(hit.reasons === undefined ? {} : { reasons: Object.freeze([...hit.reasons]) }),
    }) as InteractiveMemoryHit;
}

function queryMemoryHits(block: string): readonly InteractiveMemoryHit[] | null {
    if (!block.startsWith(QUERY_MEMORY_HEADER)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(block.slice(QUERY_MEMORY_HEADER.length)); }
    catch { return null; }
    const envelope = plainRecord(parsed);
    if (!envelope || !exactKeys(envelope, ['query', 'hits'])
        || typeof envelope.query !== 'string' || envelope.query.trim().length < 1
        || envelope.query.length > MAX_INTERACTIVE_QUERY_CHARS
        || !Array.isArray(envelope.hits) || envelope.hits.length > MAX_INTERACTIVE_HITS) {
        return null;
    }
    const hits = envelope.hits.map(interactiveMemoryHit);
    if (hits.some((hit) => hit === null)) return null;
    return Object.freeze(hits.filter((hit): hit is InteractiveMemoryHit => hit !== null)
        .filter((hit) => hit.category === 'event' && /^MEM:[a-f0-9]{64}$/u.test(hit.code)));
}

function utf16SourceDigest(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf16le').digest('hex')}`;
}

function completeMetadataMatches(
    metadata: ToolResultContractMetadata,
    scope: ToolResultContractMetadata['scope'],
    value: string,
): boolean {
    return metadata.version === TOOL_RESULT_CONTRACT_VERSION
        && metadata.scope === scope
        && metadata.state === 'complete'
        && metadata.sizeUnit === TOOL_RESULT_SIZE_UNIT
        && metadata.digestEncoding === 'utf16le'
        && metadata.parseability === 'not-asserted'
        && metadata.reason === undefined
        && Number.isSafeInteger(metadata.maxLength) && metadata.maxLength >= value.length
        && metadata.originalLength === value.length
        && metadata.returnedLength === value.length
        && metadata.previewLength === value.length
        && metadata.sourceDigest === utf16SourceDigest(value);
}

function contentFreeHit(hit: Pick<InteractiveMemoryHit, 'rowId' | 'code' | 'content'>): MemoryConsumptionHit {
    return Object.freeze({
        rowId: hit.rowId,
        code: hit.code,
        contentDigest: memoryConsumptionDigest(hit.content),
    });
}

function deduplicateHits(hits: readonly MemoryConsumptionHit[]): readonly MemoryConsumptionHit[] | null {
    const accepted = new Map<number, MemoryConsumptionHit>();
    for (const hit of hits) {
        const previous = accepted.get(hit.rowId);
        if (!previous) {
            accepted.set(hit.rowId, hit);
            continue;
        }
        if (previous.code !== hit.code || previous.contentDigest !== hit.contentDigest) {
            return null;
        }
    }
    return Object.freeze([...accepted.values()].map((hit) => Object.freeze({ ...hit })));
}

/** Use the same JSON envelope for text and structured metadata at every Memory proof boundary. */
export function memoryConsumptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


/** A matching string in history or player input cannot substitute for the actual assembly slot. */
export function captureMemoryConsumptionCarrier(input: {
    readonly messages: readonly MemoryMessage[];
    readonly prefix: string;
    readonly memoryBlock: string;
    readonly hits: readonly MemoryConsumptionRecallHit[];
}): MemoryConsumptionCarrier | null {
    const open = '<记忆召回>\n';
    const close = '\n</记忆召回>';
    const block = input.memoryBlock;
    if (!block.startsWith(open) || !block.endsWith(close)
        || block.indexOf('<记忆召回', open.length) !== -1
        || block.indexOf('</记忆召回>') !== block.length - '</记忆召回>'.length) return null;
    const messageIndex = input.messages.length - 1;
    const originalText = messageText(input.messages[messageIndex]);
    if (originalText === null || !originalText.startsWith(`${input.prefix}${block}\n\n`)) return null;
    const lines = block.slice(open.length, -close.length).split('\n');
    const seen = new Set<number>();
    const hits: MemoryConsumptionHit[] = [];
    for (const hit of input.hits) {
        if (hit.category !== 'event' || !/^MEM:[a-f0-9]{64}$/u.test(hit.code)
            || !Number.isSafeInteger(hit.rowId) || hit.rowId < 1 || seen.has(hit.rowId)
            || !hit.content || hit.content.length > 240 || /[\r\n]/u.test(hit.content)
            || /<\/?记忆召回(?:\s|>)/u.test(hit.content) || !Number.isFinite(hit.score)
            || /[\r\n\]]/u.test(hit.source)) continue;
        const tag = hit.confidence === 'low' ? ' [存疑]' : '';
        const rendered = `[${hit.code}|event|${hit.score.toFixed(2)}|${hit.source}]${tag} ${hit.content}`;
        if (lines.filter((line) => line === rendered).length !== 1) continue;
        seen.add(hit.rowId);
        hits.push(Object.freeze({
            rowId: hit.rowId, code: hit.code,
            contentDigest: memoryConsumptionDigest(hit.content)
        }));
    }
    return hits.length === 0 ? null : Object.freeze({ messageIndex, originalText, hits: Object.freeze(hits) });
}


/** Only existing host transforms may append text/image parts to this same carrier. */
export function bindMemoryConsumptionCarrier(carrier: MemoryConsumptionCarrier,
    messages: readonly MemoryMessage[]): BoundMemoryConsumptionCarrier | null {
    const text = messageText(messages[carrier.messageIndex]);
    return text !== null && text.startsWith(carrier.originalText)
        ? Object.freeze({
            messageIndex: carrier.messageIndex, carrierDigest: memoryConsumptionDigest(text),
            hits: carrier.hits
        }) : null;
}


/**
 * Recover only exact, complete `query_memory` bytes already present in the designated final user slot.
 * Summary rows and ordinary events deliberately remain unproven: the existing Memory authority performs
 * the final maintenance-write lineage/readback check inside the successful turn transaction.
 */
export function captureInteractivePreludeMemoryCarrier(input: {
    readonly messages: readonly MemoryMessage[];
    readonly messageIndex: number;
    readonly evidence: string;
    readonly completeness: InteractivePreludeCompleteness;
}): BoundMemoryConsumptionCarrier | null {
    if (input.completeness.state !== 'complete' || typeof input.evidence !== 'string'
        || input.evidence.length < 1 || input.evidence.length > MAX_INTERACTIVE_EVIDENCE_CHARS
        || !Number.isSafeInteger(input.messageIndex) || input.messageIndex < 0
        || input.messageIndex >= input.messages.length) return null;
    // The final-request wrapper escapes these tokens.  Parsing the pre-escape
    // bytes would otherwise attest a DB fact whose exact content the Provider
    // never received, so leave that optional source unproven.
    if (/<\/?harness_evidence\b/iu.test(input.evidence)) return null;
    if (!completeMetadataMatches(input.completeness.evidenceCarrier, 'evidence-carrier', input.evidence)) return null;
    const text = messageText(input.messages[input.messageIndex]);
    if (text === null || !text.endsWith(interactiveEvidenceBlock(input.evidence))) return null;

    for (const result of input.completeness.toolResults) {
        // Provider call ids are unique only within one model response. A legal
        // multi-step Prelude may reuse an id; payload digests below, not ids,
        // provide the one-for-one result/evidence binding across the whole run.
        if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(result.toolCallId)
            || typeof result.toolName !== 'string' || result.toolName.length < 1) return null;
    }
    const blocks = input.evidence.split('\n\n').filter((block) => block.startsWith(QUERY_MEMORY_HEADER));
    const unmatched = input.completeness.toolResults.filter((result) => result.toolName === 'query_memory');
    if (blocks.length !== unmatched.length) return null;
    const remaining = [...unmatched];
    const collected: MemoryConsumptionHit[] = [];
    for (const block of blocks) {
        const payload = block.slice(QUERY_MEMORY_HEADER.length);
        const matchIndex = remaining.findIndex((result) =>
            completeMetadataMatches(result.metadata, 'tool-result', payload));
        if (matchIndex < 0) return null;
        remaining.splice(matchIndex, 1);
        const parsedHits = queryMemoryHits(block);
        if (!parsedHits) return null;
        collected.push(...parsedHits.map(contentFreeHit));
    }
    if (remaining.length > 0) return null;
    const hits = deduplicateHits(collected);
    return !hits || hits.length === 0 ? null : Object.freeze({
        messageIndex: input.messageIndex,
        carrierDigest: memoryConsumptionDigest(text),
        hits,
    });
}


/** Merge only the same final carrier; ambiguous identity is not evidence and fails closed. */
export function mergeMemoryConsumptionCarriers(
    primary: BoundMemoryConsumptionCarrier | null,
    additional: BoundMemoryConsumptionCarrier | null,
): BoundMemoryConsumptionCarrier | null {
    if (!primary) return additional;
    if (!additional) return primary;
    if (primary.messageIndex !== additional.messageIndex
        || primary.carrierDigest !== additional.carrierDigest) return null;
    const hits = deduplicateHits([...primary.hits, ...additional.hits]);
    if (!hits) return null;
    return Object.freeze({
        messageIndex: primary.messageIndex,
        carrierDigest: primary.carrierDigest,
        hits,
    });
}


export function memoryConsumptionCarrierMatches(carrier: BoundMemoryConsumptionCarrier,
    messages: readonly MemoryMessage[]): boolean {
    const text = messageText(messages[carrier.messageIndex]);
    return text !== null && memoryConsumptionDigest(text) === carrier.carrierDigest;
}
