/** Host-only Model settlement. A Provider JSON object cannot mint this in-memory brand. */
import { normalizeAgentLoopObservation, type AgentLoopObservationEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { types as nodeTypes } from 'node:util';

export const AGENT_LOOP_MODEL_OUTCOME_VERSION = 'agent-loop-model-outcome-v1' as const;
/** Deterministic protocol stop metadata only, never a retry/repair grant. */
export const AGENT_LOOP_MODEL_PROTOCOL_REJECTION_REASONS = Object.freeze([
    'size-invalid', 'json-invalid', 'envelope-invalid', 'tool-unsupported', 'args-invalid', 'proposal-invalid',
] as const);
export type AgentLoopModelProtocolRejectionReason = typeof AGENT_LOOP_MODEL_PROTOCOL_REJECTION_REASONS[number];
export function isAgentLoopModelProtocolRejectionReason(value: unknown): value is AgentLoopModelProtocolRejectionReason {
    return typeof value === 'string' && (AGENT_LOOP_MODEL_PROTOCOL_REJECTION_REASONS as readonly string[]).includes(value);
}
/** A validation result, not Provider text, retry authority or an executable Decision. */
export const AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION = 'agent-loop-summary-validation-rejection-v1' as const;
export type AgentLoopSummaryValidationRejection = Readonly<{
    version: typeof AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION;
    code: 'schema-rejected' | 'through-round-mismatch';
}>;
export interface AgentLoopModelOutcome {
    readonly contractVersion: typeof AGENT_LOOP_MODEL_OUTCOME_VERSION;
}
export interface AgentLoopModelOutcomeData {
    readonly decision: unknown;
    readonly observation: AgentLoopObservationEnvelopeV1;
    readonly protocolRejectionReason?: AgentLoopModelProtocolRejectionReason;
    readonly summaryValidationRejection?: AgentLoopSummaryValidationRejection;
}
const outcomes = new WeakMap<object, AgentLoopModelOutcomeData>();
function invalid(): never { throw new Error('agent-loop-model-outcome-invalid'); }
/** New rejection-bearing inputs must be inert own data before normalization.
 * The original no-rejection constructor path retains its observation semantics.
 */
function ownData(value: unknown, stack = new Set<object>()): void {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'function' || typeof value === 'symbol') invalid();
        return;
    }
    if (nodeTypes.isProxy(value) || stack.has(value)
        || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    stack.add(value);
    try {
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') invalid();
            const field = Object.getOwnPropertyDescriptor(value, key);
            if (!field || !Object.hasOwn(field, 'value')) invalid();
            ownData(field.value, stack);
        }
    } finally { stack.delete(value); }
}

/** Decode persisted host data only. No getters, Proxy traps, Promise observation,
 * conversion hooks or unknown-version fallback may run while reading this DTO. */
export function normalizeAgentLoopSummaryValidationRejection(value: unknown): AgentLoopSummaryValidationRejection {
    ownData(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isPromise(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const keys = Reflect.ownKeys(value);
    const version = Object.getOwnPropertyDescriptor(value, 'version');
    const code = Object.getOwnPropertyDescriptor(value, 'code');
    if (keys.length !== 2 || !version?.enumerable || !code?.enumerable
        || !Object.hasOwn(version, 'value') || !Object.hasOwn(code, 'value')
        || version.value !== AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION
        || code.value !== 'schema-rejected' && code.value !== 'through-round-mismatch') invalid();
    return Object.freeze({ version: AGENT_LOOP_SUMMARY_VALIDATION_REJECTION_VERSION, code: code.value });
}

function hasSummaryValidationRejection(input: object): boolean {
    for (let current: object | null = input; current !== null; current = Object.getPrototypeOf(current)) {
        if (nodeTypes.isProxy(current)) invalid();
        if (Object.hasOwn(current, 'summaryValidationRejection')) return true;
    }
    return false;
}

/** Freeze the cloned JSON-like Decision, not the caller's input. Do not
 * normalize here: an invalid Decision must still carry known real usage to
 * Core's original blocked settlement. Non-JSON foreign values remain invalid
 * to the Decision normalizer; no executable Decision can contain them. */
function immutableDecision(value: unknown, seen = new Set<object>()): unknown {
    if (!value || typeof value !== 'object' || seen.has(value)
        || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (field && Object.hasOwn(field, 'value')) immutableDecision(field.value, seen);
    }
    return Object.freeze(value);
}

/** Only a trusted host adapter calls this, after the existing Gateway closes its audit. */
export function createAgentLoopModelOutcome(input: Readonly<{
    decision: unknown; observation: unknown; protocolRejectionReason?: AgentLoopModelProtocolRejectionReason;
    summaryValidationRejection?: AgentLoopSummaryValidationRejection;
}>): AgentLoopModelOutcome {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) invalid();
    const hasSummaryRejection = hasSummaryValidationRejection(input);
    const hasRejection = 'protocolRejectionReason' in input;
    let protocolRejectionReason: AgentLoopModelProtocolRejectionReason | undefined;
    let summaryValidationRejection: AgentLoopSummaryValidationRejection | undefined;
    if (hasRejection || hasSummaryRejection) {
        ownData(input);
        const keys = Reflect.ownKeys(input);
        if (keys.length !== (hasSummaryRejection ? 4 : 3)
            || !['decision', 'observation', 'protocolRejectionReason'].every(key => Object.hasOwn(input, key))
            || !isAgentLoopModelProtocolRejectionReason(input.protocolRejectionReason)) invalid();
        protocolRejectionReason = input.protocolRejectionReason;
        if (hasSummaryRejection) {
            if (!Object.hasOwn(input, 'summaryValidationRejection') || protocolRejectionReason !== 'proposal-invalid') invalid();
            summaryValidationRejection = normalizeAgentLoopSummaryValidationRejection(input.summaryValidationRejection);
        }
    }
    const observation = normalizeAgentLoopObservation(input.observation);
    if (observation.sourceKind !== 'provider'
        || (observation.completeness === 'complete' && observation.usageDelta === undefined)
        || (observation.completeness !== 'complete' && observation.usageDelta !== undefined)) {
        invalid();
    }
    if (hasRejection && (input.decision !== null || observation.completeness !== 'complete'
        || !observation.usageDelta || observation.usageDelta.modelCalls !== 1 || observation.usageDelta.toolCalls !== 0
        || observation.usageDelta.writes !== 0 || observation.usageDelta.highRiskActions !== 0
        || observation.usageDelta.inputTokens <= 0 || observation.usageDelta.outputTokens <= 0)) invalid();
    const value = Object.freeze({ contractVersion: AGENT_LOOP_MODEL_OUTCOME_VERSION });
    outcomes.set(value, Object.freeze({ decision: immutableDecision(structuredClone(input.decision)), observation,
        ...(protocolRejectionReason === undefined ? {} : { protocolRejectionReason }),
        ...(summaryValidationRejection === undefined ? {} : { summaryValidationRejection }) }));
    return value;
}

/** Brand recognition, not structural decoding. Clones / JSON / model self-reported usage are untrusted. */
export function readAgentLoopModelOutcome(value: unknown): AgentLoopModelOutcomeData | null {
    return value !== null && typeof value === 'object' ? outcomes.get(value) ?? null : null;
}
