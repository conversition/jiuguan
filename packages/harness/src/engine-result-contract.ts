/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Bounded, trace-independent metadata for tool payloads produced by the generic Engine.
 */
import type { ToolResultContractMetadata } from './tool-result-contract.ts';

export const HARNESS_RESULT_COMPLETENESS_VERSION = 'harness-result-completeness-v1' as const;
export const HARNESS_RESULT_RECORDS_LIMIT = 128;
const MAX_TOOL_NAME_LENGTH = 128;

export type HarnessToolResultDisposition =
    | 'admitted'
    | 'discarded-hard-limit'
    | 'discarded-invalid-state'
    | 'discarded-write-budget';

export interface HarnessToolResultRecord {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly toolNameTruncated: boolean;
    /** Admission concerns the run-local state and model message, not a durable store commit. */
    readonly disposition: HarnessToolResultDisposition;
    readonly metadata: ToolResultContractMetadata;
}

export interface HarnessResultCompleteness {
    readonly version: typeof HARNESS_RESULT_COMPLETENESS_VERSION;
    readonly scope: 'tool-results';
    /** Does not attest task completion, store persistence, domain validity or source truth. */
    readonly state: 'complete' | 'partial';
    readonly producedResults: number;
    readonly admittedResults: number;
    /** Includes discarded results and results whose per-call record was omitted at the fixed cap. */
    readonly partialResults: number;
    /** Metadata record omission does not omit any payload from aggregate completeness accounting. */
    readonly omittedResults: number;
    readonly recordsLimit: typeof HARNESS_RESULT_RECORDS_LIMIT;
    readonly toolResults: readonly HarnessToolResultRecord[];
}

/**
 * Only for trusted Engine results, not an external data/schema validator or a task/admission-success gate.
 * Omitted per-call records do not make complete payloads partial: aggregate counts still cover every result.
 */
export function hasCompleteHarnessToolResults(value: HarnessResultCompleteness | undefined): boolean {
    return value?.version === HARNESS_RESULT_COMPLETENESS_VERSION
        && value.scope === 'tool-results'
        && value.state === 'complete'
        && value.partialResults === 0;
}

function boundedToolName(value: string): string {
    const prefix = value.slice(0, MAX_TOOL_NAME_LENGTH);
    const last = prefix.charCodeAt(prefix.length - 1);
    const next = value.charCodeAt(prefix.length);
    return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        ? prefix.slice(0, -1) : prefix;
}

export function createHarnessResultCollector(): {
    record(input: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly disposition: HarnessToolResultDisposition;
        readonly metadata: ToolResultContractMetadata;
    }): void;
    snapshot(): HarnessResultCompleteness;
} {
    const records: HarnessToolResultRecord[] = [];
    let producedResults = 0;
    let admittedResults = 0;
    let partialResults = 0;
    return {
        record(input) {
            producedResults += 1;
            if (input.disposition === 'admitted') admittedResults += 1;
            if (input.metadata.state === 'partial') partialResults += 1;
            if (records.length >= HARNESS_RESULT_RECORDS_LIMIT) return;
            const toolName = boundedToolName(input.toolName);
            records.push(Object.freeze({
                ...input,
                toolName,
                toolNameTruncated: toolName.length !== input.toolName.length,
            }));
        },
        snapshot() {
            return Object.freeze({
                version: HARNESS_RESULT_COMPLETENESS_VERSION,
                scope: 'tool-results',
                state: partialResults > 0 ? 'partial' : 'complete',
                producedResults,
                admittedResults,
                partialResults,
                omittedResults: producedResults - records.length,
                recordsLimit: HARNESS_RESULT_RECORDS_LIMIT,
                toolResults: Object.freeze([...records]),
            });
        },
    };
}
