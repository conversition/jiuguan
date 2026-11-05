/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Closed terminal diagnostics, independent of bounded trace and never an authority to retry.
 */
export const HARNESS_FAILURE_CONTRACT_VERSION = 'harness-failure-contract-v1' as const;

export type HarnessHostFailureCode =
    | 'source-revision-changed'
    | 'source-authorization-denied'
    | 'host-lease-closed'
    | 'host-audit-failed'
    | 'host-input-invalid'
    | 'host-budget-exhausted'
    | 'host-provider-usage-unavailable';

export type HarnessFailureCategory = 'input' | 'protocol' | 'budget' | 'cancel'
    | 'source-auth' | 'provider' | 'audit' | 'store' | 'unknown';
export type HarnessFailureStage = 'admission' | 'model' | 'model-output' | 'protocol'
    | 'tool-input' | 'tool-execution' | 'tool-output' | 'state-admission' | 'store-commit' | 'completion';
export type HarnessFailureEffect = 'not-started' | 'unknown' | 'unknown-commit';
export type HarnessFailureOwner = 'runner' | 'gateway' | 'source' | 'tool' | 'audit' | 'store';
export type HarnessFailureRetryability = 'not-retryable' | 'requires-correction'
    | 'requires-new-authorization' | 'requires-reconciliation' | 'unknown';

const TERMINAL_CODES = {
    input: ['invalid-model-completion', 'invalid-model-usage'],
    protocol: ['invalid-protocol-limit'],
    budget: [
        'budget-step-exhausted', 'budget-model-call-exhausted', 'budget-tool-call-exhausted',
        'budget-write-exhausted', 'budget-input-token-exhausted', 'budget-output-token-exhausted',
        'budget-token-exhausted', 'budget-cost-exhausted', 'budget-wall-time-exhausted',
    ],
    cancel: ['external-cancelled'],
    provider: [
        'provider-rate-limited', 'provider-timeout', 'provider-upstream-unavailable',
        'provider-transport-failed', 'provider-stream-failed', 'provider-stream-incomplete',
    ],
    store: ['store-commit-failed'],
    unknown: ['model-failed', 'harness-unknown-failure'],
} as const;

const CAUSE_CODES = {
    input: [
        'gateway-model-required', 'gateway-tools-invalid', 'gateway-budget-lane-mismatch',
        'gateway-output-budget-invalid', 'host-input-invalid',
    ],
    budget: [
        'gateway-model-call-budget-exhausted', 'gateway-input-budget-exhausted',
        'gateway-output-budget-exhausted', 'gateway-cost-budget-exhausted',
        'gateway-wall-budget-exhausted', 'maintenance-output-budget-exhausted', 'host-budget-exhausted',
    ],
    cancel: ['gateway-provider-call-cancelled'],
    'source-auth': [
        'gateway-model-binding-mismatch', 'gateway-toolset-binding-mismatch', 'gateway-lease-closed',
        'gateway-dispatch-authority-denied', 'source-revision-changed', 'source-authorization-denied',
        'host-lease-closed',
    ],
    provider: [
        'gateway-cost-estimator-unavailable', 'gateway-concurrent-call',
        'gateway-provider-usage-unavailable', 'gateway-provider-usage-invalid',
        'gateway-provider-call-failed', 'provider-rate-limited', 'provider-timeout',
        'provider-upstream-unavailable', 'provider-transport-failed', 'provider-stream-failed',
        'provider-stream-incomplete', 'provider-not-configured', 'provider-authentication-failed',
        'provider-request-invalid', 'provider-disposed', 'provider-failed', 'host-provider-usage-unavailable',
    ],
    audit: ['gateway-lease-audit-failed', 'gateway-request-completion-failed', 'host-audit-failed'],
} as const;

export type HarnessFailureCode = typeof TERMINAL_CODES[keyof typeof TERMINAL_CODES][number];
export type HarnessFailureCauseCode = typeof CAUSE_CODES[keyof typeof CAUSE_CODES][number];

export interface HarnessFailureMetadata {
    readonly version: typeof HARNESS_FAILURE_CONTRACT_VERSION;
    readonly code: HarnessFailureCode;
    /** Preserves an exact safe cause without changing the historical termination reason. */
    readonly causeCode: HarnessFailureCauseCode | null;
    readonly category: HarnessFailureCategory;
    readonly owner: HarnessFailureOwner;
    readonly stage: HarnessFailureStage;
    /** Tool/store uncertainty only; Provider charging remains owned by the Gateway. */
    readonly effectScope: 'tool-and-store';
    readonly effect: HarnessFailureEffect;
    readonly retryability: HarnessFailureRetryability;
    readonly autoRetry: false;
}

export interface HarnessFailureInput {
    readonly reason?: unknown;
    readonly cause?: unknown;
    readonly stage?: HarnessFailureStage;
    readonly effect?: HarnessFailureEffect;
}

const TERMINAL_CATEGORIES = new Map<string, HarnessFailureCategory>(
    Object.entries(TERMINAL_CODES).flatMap(([category, codes]) =>
        codes.map((code) => [code, category as HarnessFailureCategory] as const)),
);
const CAUSE_CATEGORIES = new Map<string, HarnessFailureCategory>(
    Object.entries(CAUSE_CODES).flatMap(([category, codes]) =>
        codes.map((code) => [code, category as HarnessFailureCategory] as const)),
);
const HOST_CODES = new Set<HarnessHostFailureCode>([
    'source-revision-changed', 'source-authorization-denied', 'host-lease-closed',
    'host-audit-failed', 'host-input-invalid', 'host-budget-exhausted', 'host-provider-usage-unavailable',
]);
const HOST_FAILURES = new WeakMap<object, HarnessHostFailureCode>();
const STAGES = new Set<HarnessFailureStage>([
    'admission', 'model', 'model-output', 'protocol', 'tool-input', 'tool-execution',
    'tool-output', 'state-admission', 'store-commit', 'completion',
]);
const EFFECTS = new Set<HarnessFailureEffect>(['not-started', 'unknown', 'unknown-commit']);

/** A host may preserve a generic closed cause without replacing or exposing its original error. */
export function rememberHarnessFailureCode(error: object, code: HarnessHostFailureCode): void {
    if (HOST_CODES.has(code)) HOST_FAILURES.set(error, code);
    else HOST_FAILURES.delete(error);
}

export function readHarnessFailureCode(error: object): HarnessHostFailureCode | undefined {
    return HOST_FAILURES.get(error);
}

/** Read each field independently: one hostile getter must not hide other exact diagnostic codes. */
export function readHarnessErrorField(
    error: unknown,
    key: 'diagnosticCode' | 'code' | 'message' | 'name',
): unknown {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
    try { return (error as Record<string, unknown>)[key]; }
    catch { return undefined; }
}

function safeCause(error: unknown): HarnessFailureCauseCode | null {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        const branded = HOST_FAILURES.get(error);
        if (branded !== undefined) return branded;
    }
    for (const field of ['diagnosticCode', 'code', 'message'] as const) {
        const value = readHarnessErrorField(error, field);
        if (typeof value === 'string' && CAUSE_CATEGORIES.has(value)) {
            return value as HarnessFailureCauseCode;
        }
    }
    return typeof error === 'string' && CAUSE_CATEGORIES.has(error)
        ? error as HarnessFailureCauseCode : null;
}

function owner(category: HarnessFailureCategory, code: string): HarnessFailureOwner {
    if (code.startsWith('gateway-') || category === 'provider') return 'gateway';
    if (category === 'source-auth') return 'source';
    if (category === 'audit') return 'audit';
    if (category === 'store') return 'store';
    return 'runner';
}

function retryability(
    category: HarnessFailureCategory,
    effect: HarnessFailureEffect,
): HarnessFailureRetryability {
    if (effect !== 'not-started') return 'requires-reconciliation';
    if (category === 'cancel') return 'not-retryable';
    if (category === 'input' || category === 'protocol') return 'requires-correction';
    if (category === 'store' || category === 'audit') return 'requires-reconciliation';
    if (category === 'unknown') return 'unknown';
    return 'requires-new-authorization';
}

/** Only exact closed codes are retained; unknown text is neither echoed nor guessed from substrings. */
export function classifyHarnessFailure(input: HarnessFailureInput): HarnessFailureMetadata {
    const code = typeof input.reason === 'string' && TERMINAL_CATEGORIES.has(input.reason)
        ? input.reason as HarnessFailureCode : 'harness-unknown-failure';
    const causeCode = safeCause(input.cause);
    const category = code === 'store-commit-failed' ? 'store' : causeCode === null ? TERMINAL_CATEGORIES.get(code)!
        : CAUSE_CATEGORIES.get(causeCode)!;
    const effect = input.effect !== undefined && EFFECTS.has(input.effect) ? input.effect : 'unknown';
    const stage = input.stage !== undefined && STAGES.has(input.stage) ? input.stage : 'admission';
    return Object.freeze({
        version: HARNESS_FAILURE_CONTRACT_VERSION,
        code,
        causeCode,
        category,
        owner: category === 'store' ? 'store' : owner(category, causeCode ?? code),
        stage,
        effectScope: 'tool-and-store',
        effect,
        retryability: retryability(category, effect),
        autoRetry: false,
    });
}
