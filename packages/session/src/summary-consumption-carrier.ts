/** @author Codex @date 2026-10-14 @version 1.0
 * Bind the complete authoritative Summary to its designated final Provider request slot.
 */
import { createHash } from 'node:crypto';
import type { ChatRequest } from '../../proxy/public/client.ts';
import { messageText } from './interactive-consumption.ts';

type SummaryMessage = ChatRequest['messages'][number];
const CAPTURED = new WeakMap<object, Readonly<{ originalText: string; longterm: string; }>>();
const BOUND = new WeakSet<object>();
const MAX_SUMMARY_CHARS = 16_000;
const MAX_CARRIER_CHARS = 1_048_576;

export interface SummaryConsumptionSnapshot {
    readonly summaryDigest: string;
    readonly throughRound: number;
    readonly historyEpoch: number;
}

export interface SummaryConsumptionCarrier {
    readonly messageIndex: number;
    readonly summary: SummaryConsumptionSnapshot;
}

export interface BoundSummaryConsumptionCarrier extends SummaryConsumptionCarrier {
    readonly carrierDigest: string;
}

/** Summary hashes bind the raw stored value, not the renderer's trimmed presentation. */
export function summaryConsumptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


/** Only the leading assembly Summary slot can attest a complete retained Summary. */
export function captureSummaryConsumptionCarrier(input: {
    readonly messages: readonly SummaryMessage[];
    readonly longTermBlock: string;
    readonly summaryBlock: string;
    readonly summary: Readonly<{ longterm: string; throughRound: number; historyEpoch: number; }>;
}): SummaryConsumptionCarrier | null {
    const { longterm, throughRound, historyEpoch } = input.summary;
    if (typeof longterm !== 'string' || !longterm.trim() || longterm.length > MAX_SUMMARY_CHARS
        || /<\/?长期摘要(?:\s|>)/u.test(longterm)
        || !Number.isSafeInteger(throughRound) || throughRound < 0
        || !Number.isSafeInteger(historyEpoch) || historyEpoch < 0) return null;
    const expectedBlock = `<长期摘要>\n${longterm.trim()}\n</长期摘要>`;
    if (input.summaryBlock !== expectedBlock
        || !(input.longTermBlock === expectedBlock || input.longTermBlock.startsWith(`${expectedBlock}\n\n`))) {
        return null;
    }
    const messageIndex = input.messages.length - 1;
    const originalText = messageText(input.messages[messageIndex]);
    if (originalText === null || originalText.length > MAX_CARRIER_CHARS
        || !originalText.startsWith(`${input.longTermBlock}\n\n`)) return null;
    const summary = Object.freeze({ summaryDigest: summaryConsumptionDigest(longterm), throughRound, historyEpoch });
    const carrier = Object.freeze({ messageIndex, summary });
    CAPTURED.set(carrier, Object.freeze({ originalText, longterm }));
    return carrier;
}


/** Host image/evidence transforms may extend this exact slot, never substitute another message. */
export function bindSummaryConsumptionCarrier(carrier: SummaryConsumptionCarrier,
    messages: readonly SummaryMessage[]): BoundSummaryConsumptionCarrier | null {
    const captured = CAPTURED.get(carrier);
    if (!captured) return null;
    const text = messageText(messages[carrier.messageIndex]);
    if (text === null || text.length > MAX_CARRIER_CHARS || !text.startsWith(captured.originalText)) return null;
    const bound = Object.freeze({
        messageIndex: carrier.messageIndex, summary: carrier.summary, carrierDigest: summaryConsumptionDigest(text),
    });
    BOUND.add(bound);
    return bound;
}


export function summaryConsumptionCarrierMatches(carrier: BoundSummaryConsumptionCarrier,
    messages: readonly SummaryMessage[]): boolean {
    if (!BOUND.has(carrier)) return false;
    const text = messageText(messages[carrier.messageIndex]);
    return text !== null && text.length <= MAX_CARRIER_CHARS
        && summaryConsumptionDigest(text) === carrier.carrierDigest;
}


/** A foreground refresh or branch change cannot borrow the earlier Provider snapshot's ownership. */
export function summaryConsumptionSnapshotMatches(carrier: SummaryConsumptionCarrier, current: Readonly<{
    longterm: string; throughRound: number; historyEpoch: number;
}>): boolean {
    const captured = CAPTURED.get(carrier);
    return captured !== undefined && current.longterm === captured.longterm
        && current.throughRound === carrier.summary.throughRound
        && current.historyEpoch === carrier.summary.historyEpoch;
}
