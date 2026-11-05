/** Strict content-free Action metadata. Storage and execution authority remain in the original Store/host. */
export const AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT = 'action.maintenance.get_variables.v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT =
    'action.maintenance.propose_rolling_summary.v1' as const;
export const AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT = 'action.maintenance.apply_rolling_summary.v1' as const;
export const AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT = 'action.rp.read-character.v1' as const;
/**
 * Immutable per-ref ceiling for the RP child result body. The RP source adapter
 * accounts the serialized UTF-8 byte length in the continuation token-shaped field.
 */
export const AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS = 32_768;
export type AgentLoopActionContractRef =
    | typeof AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT
    | typeof AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
    | typeof AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT
    | typeof AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT;
export const AGENT_LOOP_ACTION_USAGE_KEYS = Object.freeze([
    'modelCalls',
    'toolCalls',
    'writes',
    'inputTokens',
    'outputTokens',
    'costMicrousd',
    'wallMs',
    'highRiskActions',
] as const);
export type AgentLoopActionUsage = Readonly<Record<(typeof AGENT_LOOP_ACTION_USAGE_KEYS)[number], number>>;
export interface AgentLoopActionScope {
    readonly taskId: string;
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly ownerId: string;
    readonly actionId: string;
}
export interface AgentLoopActionResultMetadata {
    readonly sourceKind: 'tool' | 'domain-readback';
    readonly sourceRef: string;
    readonly payloadDigest: string;
    readonly completeness: 'complete' | 'partial' | 'unknown';
    readonly evidenceRefs: readonly string[];
    readonly usage: AgentLoopActionUsage;
}
export type AgentLoopActionReceiptStatus = 'reserved' | 'started' | 'completed' | 'observed' | 'released';
export interface AgentLoopActionReceiptRecord extends AgentLoopActionScope {
    readonly actionDigest: string;
    readonly actionContractRef: AgentLoopActionContractRef;
    readonly estimate: AgentLoopActionUsage;
    readonly status: AgentLoopActionReceiptStatus;
    readonly createdAt: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly receiptRef?: string;
    readonly result?: AgentLoopActionResultMetadata;
    readonly settledAt?: string;
    readonly observationId?: string;
    readonly appliedRevision?: number;
    readonly observedAt?: string;
    readonly releasedAt?: string;
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
function invalid(): never {
    throw new Error('agent-loop-action-metadata-invalid');
}
export function normalizeAgentLoopActionObject(
    input: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        invalid();
    const keys = Reflect.ownKeys(input);
    if (
        keys.some(
            (key) =>
                typeof key !== 'string' ||
                (!required.includes(key) && !optional.includes(key)) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'),
        ) ||
        required.some((key) => !keys.includes(key))
    )
        invalid();
    return input as Record<string, unknown>;
}
export function normalizeAgentLoopActionToken(input: unknown): string {
    if (typeof input !== 'string' || !TOKEN.test(input)) invalid();
    return input;
}
export function normalizeAgentLoopActionDigest(input: unknown): string {
    if (typeof input !== 'string' || !HASH.test(input)) invalid();
    return input;
}
export function normalizeAgentLoopActionContractRef(input: unknown): AgentLoopActionContractRef {
    if (
        input !== AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT &&
        input !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT &&
        input !== AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT &&
        input !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT
    )
        invalid();
    return input;
}
/** Metadata only, not execution authority. Defaults retain the original read contract;
 * proposal staging and domain apply have distinct exact contracts, each charging one write. */
export function normalizeAgentLoopActionUsage(
    input: unknown,
    actionContractRef: AgentLoopActionContractRef = AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT,
): AgentLoopActionUsage {
    const contract = normalizeAgentLoopActionContractRef(actionContractRef);
    const value = normalizeAgentLoopActionObject(input, AGENT_LOOP_ACTION_USAGE_KEYS);
    for (const key of AGENT_LOOP_ACTION_USAGE_KEYS)
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) invalid();
    const readOnly =
        contract === AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT ||
        contract === AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT;
    if (
        value.toolCalls !== 1 ||
        value.writes !== (readOnly ? 0 : 1) ||
        AGENT_LOOP_ACTION_USAGE_KEYS.some(
            (key) => key !== 'toolCalls' && key !== 'writes' && key !== 'wallMs' && value[key] !== 0,
        )
    )
        invalid();
    return Object.freeze(
        Object.fromEntries(
            AGENT_LOOP_ACTION_USAGE_KEYS.map((key) => [key, Number(value[key])]),
        ) as unknown as AgentLoopActionUsage,
    );
}
export function normalizeAgentLoopActionResult(
    input: unknown,
    actionContractRef: AgentLoopActionContractRef = AGENT_LOOP_GET_VARIABLES_ACTION_CONTRACT,
): AgentLoopActionResultMetadata {
    const contract = normalizeAgentLoopActionContractRef(actionContractRef);
    const value = normalizeAgentLoopActionObject(input, [
        'sourceKind',
        'sourceRef',
        'payloadDigest',
        'completeness',
        'evidenceRefs',
        'usage',
    ]);
    const sourceKind = contract === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT ? 'domain-readback' : 'tool';
    if (
        value.sourceKind !== sourceKind ||
        typeof value.completeness !== 'string' ||
        !['complete', 'partial', 'unknown'].includes(value.completeness) ||
        !Array.isArray(value.evidenceRefs) ||
        value.evidenceRefs.length > 32
    )
        invalid();
    const evidenceRefs: string[] = [];
    for (let i = 0; i < value.evidenceRefs.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value.evidenceRefs, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
        evidenceRefs.push(normalizeAgentLoopActionToken(descriptor.value));
    }
    if (new Set(evidenceRefs).size !== evidenceRefs.length) invalid();
    if (contract === AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT) {
        if (
            value.completeness !== 'complete' ||
            typeof value.sourceRef !== 'string' ||
            !/^rp-character:sha256:[a-f0-9]{64}$/u.test(value.sourceRef) ||
            evidenceRefs.length !== 6 ||
            !/^rp-child-analysis:[a-f0-9]{64}$/u.test(evidenceRefs[5]!)
        )
            invalid();
        for (const ref of evidenceRefs.slice(0, 5)) normalizeAgentLoopActionDigest(ref);
    }
    return Object.freeze({
        sourceKind,
        sourceRef: normalizeAgentLoopActionToken(value.sourceRef),
        payloadDigest: normalizeAgentLoopActionDigest(value.payloadDigest),
        completeness: value.completeness as AgentLoopActionResultMetadata['completeness'],
        evidenceRefs: Object.freeze(evidenceRefs),
        usage: normalizeAgentLoopActionUsage(value.usage, contract),
    });
}
