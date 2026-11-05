/**
 * @author Codex
 * @date 2026-10-26
 * @version 1.1
 * Closed, non-sensitive Interactive failure diagnostics; never grants a retry.
 */
export const INTERACTIVE_FAILURE_CONTRACT_VERSION = 'interactive-failure-contract-v1' as const;

export type InteractiveFailureCategory =
    | 'input'
    | 'schema'
    | 'allowlist'
    | 'budget'
    | 'cancel'
    | 'source-auth'
    | 'provider'
    | 'tool-output'
    | 'tool-execution'
    | 'audit'
    | 'unknown';
export type InteractiveFailureStage =
    | 'admission'
    | 'provider'
    | 'tool-input'
    | 'tool-execution'
    | 'tool-output'
    | 'audit'
    | 'completion';
export type InteractiveFailureEffect = 'not-started' | 'read-only' | 'staging-possible' | 'staged' | 'unknown';
export type InteractiveFailureOwner = 'runner' | 'gateway' | 'source' | 'tool' | 'audit';
export type InteractiveFailureRetryability =
    | 'not-retryable'
    | 'requires-correction'
    | 'requires-new-authorization'
    | 'requires-reconciliation'
    | 'unknown';

export interface InteractiveFailureMetadata {
    readonly version: typeof INTERACTIVE_FAILURE_CONTRACT_VERSION;
    readonly category: InteractiveFailureCategory;
    readonly code: string;
    /** Diagnostic ownership is singular; Provider charging remains owned by the Gateway. */
    readonly owner: InteractiveFailureOwner;
    readonly retryability: InteractiveFailureRetryability;
    readonly autoRetry: false;
    readonly stage: InteractiveFailureStage;
    /** Describes observed tool execution, never a guarantee about external side effects. */
    readonly effect: InteractiveFailureEffect;
}

export interface InteractiveFailureInput {
    readonly reason?: unknown;
    readonly cause?: unknown;
    readonly stage?: InteractiveFailureStage;
    readonly effect?: InteractiveFailureEffect;
}

const CATEGORY_CODES: Readonly<Record<Exclude<InteractiveFailureCategory, 'unknown'>, readonly string[]>> = {
    input: [
        'interactive-input-invalid',
        'interactive-tool-call-id-invalid',
        'interactive-cost-invalid',
        'gateway-model-required',
        'gateway-tools-invalid',
        'gateway-budget-lane-mismatch',
        'gateway-output-budget-invalid',
    ],
    schema: [
        'interactive-director-plan-missing',
        'interactive-director-plan-invalid',
        'interactive-tool-args-invalid',
        'interactive-tool-schema-rejected',
        'query-invalid',
        'variable-keys-invalid',
        'variable-patch-invalid',
        'variable-hint-invalid',
        'sandbox-action-invalid',
    ],
    allowlist: ['interactive-tool-not-allowed', 'variable-patch-not-allowed', 'sandbox-action-not-allowed'],
    budget: [
        'interactive-final-model-call-reserve',
        'interactive-final-reserve',
        'interactive-tool-limit',
        'interactive-write-limit',
        'interactive-agent-request-exceeds-provider-context',
        'interactive-provider-context-insufficient',
        'interactive-final-reserve-insufficient',
        ...[
            'step',
            'model-call',
            'tool-call',
            'write',
            'input-token',
            'output-token',
            'token',
            'cost',
            'wall-time',
        ].map((limit) => `interactive-budget-${limit}-exhausted`),
        'gateway-model-call-budget-exhausted',
        'gateway-input-budget-exhausted',
        'gateway-output-budget-exhausted',
        'gateway-cost-budget-exhausted',
        'gateway-wall-budget-exhausted',
    ],
    cancel: ['interactive-cancelled', 'gateway-provider-call-cancelled'],
    'source-auth': [
        'interactive-source-revision-changed',
        'interactive-source-authorization-denied',
        'gateway-model-binding-mismatch',
        'gateway-toolset-binding-mismatch',
        'gateway-lease-closed',
        'gateway-dispatch-authority-denied',
    ],
    provider: [
        'interactive-provider-ineligible',
        'interactive-provider-usage-unavailable',
        'interactive-provider-usage-invalid',
        'gateway-cost-estimator-unavailable',
        'gateway-concurrent-call',
        'gateway-provider-usage-unavailable',
        'gateway-provider-usage-invalid',
        'gateway-provider-call-failed',
        'provider-rate-limited',
        'provider-timeout',
        'provider-upstream-unavailable',
        'provider-transport-failed',
        'provider-stream-failed',
        'provider-stream-incomplete',
    ],
    'tool-output': [
        'interactive-tool-output-invalid',
        'interactive-tool-output-unavailable',
        'interactive-tool-result-invalid',
        'interactive-tool-contract-result-limit-invalid',
        'interactive-tool-result-externalization-failed',
    ],
    'tool-execution': ['tool-execution-failed', 'variable-patch-already-staged', 'variable-hint-already-recorded'],
    audit: ['tool-audit-failed', 'gateway-lease-audit-failed', 'gateway-request-completion-failed'],
};

const CODE_CATEGORIES = new Map<string, InteractiveFailureCategory>(
    Object.entries(CATEGORY_CODES).flatMap(([category, codes]) =>
        codes.map((code) => [code, category as InteractiveFailureCategory] as const),
    ),
);
const FAILURE_CODES = new WeakMap<object, string>();

function knownCode(value: unknown): string | undefined {
    const code = typeof value === 'string' ? value : value instanceof Error ? value.message : undefined;
    return code !== undefined && CODE_CATEGORIES.has(code) ? code : undefined;
}

/** Keep the original ToolOutcome/errorCode unchanged; retain only an exact closed diagnostic code. */
export function rememberInteractiveFailureCode(outcome: object, errorOrKnownCode: unknown): void {
    const code = knownCode(errorOrKnownCode);
    if (code !== undefined) FAILURE_CODES.set(outcome, code);
    else FAILURE_CODES.delete(outcome);
}

export function readInteractiveFailureCode(outcome: object): string | undefined {
    return FAILURE_CODES.get(outcome);
}

function failureOwner(category: InteractiveFailureCategory, code: string): InteractiveFailureOwner {
    if (code.startsWith('gateway-') || category === 'provider') return 'gateway';
    if (category === 'source-auth') return 'source';
    if (category === 'audit') return 'audit';
    if (category === 'tool-output' || category === 'tool-execution') return 'tool';
    return 'runner';
}

function retryability(
    category: InteractiveFailureCategory,
    effect: InteractiveFailureEffect,
): InteractiveFailureRetryability {
    // 有副作用证据优先于失败分类：只要工具真的跑过，**任何**分类（包括"未知错误"）
    // 都必须先核对权威状态再谈重发。这与后台 `harness-failure-contract-v1` 的顺序一致；
    // 反过来（先判 unknown 分类）会让"非只读工具已执行 + 未识别错误"退化成 `unknown`，
    // 丢掉"必须核对"这条硬要求。
    if (effect !== 'not-started') return 'requires-reconciliation';
    if (category === 'cancel') return 'not-retryable';
    if (category === 'unknown') return 'unknown';
    if (category === 'input' || category === 'schema' || category === 'allowlist') return 'requires-correction';
    if (category === 'audit' || category === 'tool-execution' || category === 'tool-output') {
        return 'requires-reconciliation';
    }
    return 'requires-new-authorization';
}

/** Exact reason codes only: unknown text, including timeout-like messages, stays unknown and private. */
export function classifyInteractiveFailure(input: InteractiveFailureInput): InteractiveFailureMetadata {
    const code = knownCode(input.cause) ?? knownCode(input.reason) ?? 'interactive-unknown-failure';
    const category = CODE_CATEGORIES.get(code) ?? 'unknown';
    const effect = input.effect ?? 'unknown';
    return Object.freeze({
        version: INTERACTIVE_FAILURE_CONTRACT_VERSION,
        category,
        code,
        owner: failureOwner(category, code),
        retryability: retryability(category, effect),
        autoRetry: false,
        stage:
            category === 'audit' ? 'audit' : category === 'tool-output' ? 'tool-output' : (input.stage ?? 'admission'),
        effect,
    });
}
