/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Content-free Maintenance failure identity; legacy public error selection is kept byte-equivalent.
 */
import {
    classifyHarnessFailure,
    rememberHarnessFailureCode,
    type HarnessFailureMetadata,
    type HarnessHostFailureCode,
} from '../../packages/harness/public/engine-failure-contract.ts';

export const MAINTENANCE_FAILURE_CONTRACT_VERSION = 'maintenance-failure-contract-v1' as const;

const TRANSIENT_PROVIDER_FAILURES = Object.freeze([
    'provider-rate-limited', 'provider-timeout', 'provider-upstream-unavailable',
    'provider-transport-failed', 'provider-stream-failed', 'provider-stream-incomplete',
]);

/** This describes the existing sole Provider-retry owner, not a new retry permission. */
export const MAINTENANCE_PROVIDER_RETRY_POLICY = Object.freeze({
    version: 'maintenance-provider-retry-policy-v1' as const,
    owner: 'admitted-maintenance-model' as const,
    maxAttempts: 2,
    eligibleDiagnosticCodes: TRANSIENT_PROVIDER_FAILURES,
});


export function maintenanceTransientProviderFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    let code: unknown;
    try { code = (error as { diagnosticCode?: unknown }).diagnosticCode; }
    catch { return false; }
    return typeof code === 'string' && TRANSIENT_PROVIDER_FAILURES.includes(code);
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
    'provider-not-configured',
    'provider-authentication-failed',
    'provider-request-invalid',
    'provider-rate-limited',
    'provider-timeout',
    'provider-upstream-unavailable',
    'provider-transport-failed',
    'provider-stream-failed',
    'provider-stream-incomplete',
    'provider-disposed',
    'provider-failed',
]);

const SAFE_MODEL_PREFLIGHT_CODES = new Set([
    'maintenance-session-not-found',
    'maintenance-production-lane-disabled',
    'maintenance-admission-ledger-unavailable',
    'maintenance-admission-audit-missing',
    'maintenance-job-not-claimed',
    'maintenance-source-revision-stale',
    'maintenance-model-unavailable',
    'maintenance-budget-lane-mismatch',
    'maintenance-strict-context-unavailable',
    'maintenance-strict-context-mismatch',
    'maintenance-summary-input-budget-exhausted',
    'maintenance-summary-baseline-too-large',
    'maintenance-arc-proposal-context-required',
    'maintenance-arc-proposal-context-invalid',
    'maintenance-arc-proposal-context-mismatch',
    'maintenance-npc-proposal-context-required',
    'maintenance-npc-proposal-context-invalid',
    'maintenance-npc-proposal-context-mismatch',
    'maintenance-worldbook-proposal-context-required',
    'maintenance-worldbook-proposal-context-invalid',
    'maintenance-worldbook-proposal-context-mismatch',
    'maintenance-summary-proposal-context-required',
    'maintenance-summary-proposal-context-invalid',
    'maintenance-summary-proposal-context-mismatch',
    'maintenance-provider-tool-contract-invalid',
    'maintenance-output-budget-exhausted',
    'maintenance-provider-usage-unavailable',
    'maintenance-arc-skill-policy-unsupported',
    'maintenance-arc-skill-context-required',
    'maintenance-arc-skill-call-required',
    'maintenance-arc-skill-route-invalid',
    'maintenance-arc-skill-proof-required',
    'maintenance-arc-skill-context-invalid',
    'maintenance-arc-skill-source-invalid',
    'maintenance-arc-skill-provider-context-invalid',
    'maintenance-arc-skill-context-binding-invalid',
    'maintenance-arc-skill-policy-mismatch',
    'maintenance-arc-skill-context-mismatch',
    'maintenance-arc-skill-request-invalid',
    'maintenance-arc-skill-request-unavailable',
    'maintenance-arc-skill-output-invalid',
    'maintenance-arc-skill-proof-unavailable',
    'maintenance-arc-skill-provenance-invalid',
    'maintenance-npc-skill-policy-unsupported',
    'maintenance-npc-skill-context-required',
    'maintenance-npc-skill-call-required',
    'maintenance-npc-skill-route-invalid',
    'maintenance-npc-skill-proof-required',
    'maintenance-npc-skill-context-invalid',
    'maintenance-npc-skill-source-invalid',
    'maintenance-npc-skill-provider-context-invalid',
    'maintenance-npc-skill-context-binding-invalid',
    'maintenance-npc-skill-policy-mismatch',
    'maintenance-npc-skill-context-mismatch',
    'maintenance-npc-skill-request-invalid',
    'maintenance-npc-skill-request-unavailable',
    'maintenance-npc-skill-output-invalid',
    'maintenance-npc-skill-proof-unavailable',
    'maintenance-npc-skill-provenance-invalid',
    'maintenance-worldbook-skill-policy-unsupported',
    'maintenance-worldbook-skill-context-required',
    'maintenance-worldbook-skill-call-required',
    'maintenance-worldbook-skill-route-invalid',
    'maintenance-worldbook-skill-proof-required',
    'maintenance-worldbook-skill-context-invalid',
    'maintenance-worldbook-skill-source-invalid',
    'maintenance-worldbook-skill-provider-context-invalid',
    'maintenance-worldbook-skill-context-binding-invalid',
    'maintenance-worldbook-skill-policy-mismatch',
    'maintenance-worldbook-skill-context-mismatch',
    'maintenance-worldbook-skill-request-invalid',
    'maintenance-worldbook-skill-request-unavailable',
    'maintenance-worldbook-skill-output-invalid',
    'maintenance-worldbook-skill-proof-unavailable',
    'maintenance-worldbook-skill-provenance-invalid',
    'maintenance-worldbook-skill-registration-required',
    'maintenance-worldbook-skill-registration-invalid',
    'maintenance-worldbook-skill-registration-unavailable',
]);

const SAFE_TICKET_ERROR_CODES = new Set([
    'ticket-id-invalid',
    'ticket-id-collision',
    'ticket-request-expired',
    'ticket-lane-disabled',
    'ticket-idempotency-conflict',
    'ticket-unknown',
    'ticket-replayed',
    'ticket-expired',
    'ticket-binding-mismatch',
    'ticket-toolset-mismatch',
    'ticket-budget-escalation',
]);

const SAFE_GATEWAY_ERROR_CODES = new Set([
    'gateway-model-required',
    'gateway-tools-invalid',
    'gateway-budget-lane-mismatch',
    'gateway-output-budget-invalid',
    'gateway-cost-estimator-unavailable',
    'gateway-model-binding-mismatch',
    'gateway-toolset-binding-mismatch',
    'gateway-concurrent-call',
    'gateway-lease-closed',
    'gateway-model-call-budget-exhausted',
    'gateway-input-budget-exhausted',
    'gateway-output-budget-exhausted',
    'gateway-cost-budget-exhausted',
    'gateway-wall-budget-exhausted',
    'gateway-provider-usage-unavailable',
    'gateway-provider-usage-invalid',
    'gateway-provider-call-failed',
    'gateway-provider-call-cancelled',
    'gateway-request-completion-failed',
    'gateway-lease-audit-failed',
]);

/** Convert only fixed, content-free classifications; arbitrary exception text is never persisted. */
export function maintenanceExecutionFailureCode(error: unknown): string {
    let diagnosticCode: unknown;
    let code: unknown;
    let message: unknown;
    try {
        if (!error || typeof error !== 'object') return 'maintenance-execution-failed';
        const row = error as { diagnosticCode?: unknown; code?: unknown; message?: unknown };
        diagnosticCode = row.diagnosticCode;
        code = row.code;
        message = row.message;
    } catch {
        return 'maintenance-execution-failed';
    }
    if (typeof diagnosticCode === 'string' && SAFE_PROVIDER_ERROR_CODES.has(diagnosticCode)) {
        return `maintenance-${diagnosticCode}`;
    }
    if (typeof code === 'string' && SAFE_PROVIDER_ERROR_CODES.has(code)) return `maintenance-${code}`;
    if (typeof code === 'string'
        && (SAFE_TICKET_ERROR_CODES.has(code) || SAFE_GATEWAY_ERROR_CODES.has(code))) {
        return `maintenance-${code}`;
    }
    if (typeof message === 'string' && SAFE_MODEL_PREFLIGHT_CODES.has(message)) return message;
    return 'maintenance-execution-failed';
}

export type MaintenanceFailurePhase = 'preflight' | 'engine' | 'proposal-validation'
    | 'direct-preparation' | 'proposal-commit' | 'job-settlement';
export type MaintenanceBusinessEffect = 'not-attempted' | 'unknown-commit' | 'committed-domain-write';

export interface MaintenanceFailureDiagnostic {
    readonly version: typeof MAINTENANCE_FAILURE_CONTRACT_VERSION;
    readonly phase: MaintenanceFailurePhase;
    readonly originCode: string | null;
    readonly businessEffect: MaintenanceBusinessEffect;
    readonly failure: HarnessFailureMetadata;
    readonly retryPolicyVersion: typeof MAINTENANCE_PROVIDER_RETRY_POLICY.version;
}

const HOST_CAUSES = new Map<string, HarnessHostFailureCode>([
    ['maintenance-gateway-request-completion-failed', 'host-audit-failed'],
    ['maintenance-source-revision-stale', 'source-revision-changed'],
    ['maintenance-production-lane-disabled', 'source-authorization-denied'],
    ['maintenance-execution-disabled', 'source-authorization-denied'],
    ['maintenance-session-not-found', 'source-authorization-denied'],
    ['maintenance-job-not-claimed', 'host-lease-closed'],
    ['maintenance-direct-commit-aborted', 'host-lease-closed'],
    ['maintenance-admission-audit-missing', 'host-audit-failed'],
    ['maintenance-admission-ledger-unavailable', 'host-audit-failed'],
    ['maintenance-provider-usage-unavailable', 'host-provider-usage-unavailable'],
    ['maintenance-summary-input-budget-exhausted', 'host-budget-exhausted'],
    ['maintenance-summary-baseline-too-large', 'host-budget-exhausted'],
    ['maintenance-output-budget-exhausted', 'host-budget-exhausted'],
    ['maintenance-strict-context-mismatch', 'source-authorization-denied'],
    ['maintenance-memory-proposal-context-mismatch', 'source-authorization-denied'],
    ['maintenance-arc-proposal-context-mismatch', 'source-authorization-denied'],
    ['maintenance-npc-proposal-context-mismatch', 'source-authorization-denied'],
    ['maintenance-worldbook-proposal-context-mismatch', 'source-authorization-denied'],
    ['maintenance-summary-proposal-context-mismatch', 'source-authorization-denied'],
    ['maintenance-arc-skill-source-invalid', 'source-revision-changed'],
    ['maintenance-arc-skill-context-mismatch', 'source-revision-changed'],
    ['maintenance-arc-skill-request-unavailable', 'source-authorization-denied'],
    ['maintenance-arc-skill-proof-unavailable', 'source-authorization-denied'],
    ['maintenance-arc-skill-proof-required', 'host-audit-failed'],
    ['maintenance-arc-skill-provenance-invalid', 'host-audit-failed'],
    ['maintenance-npc-skill-source-invalid', 'source-revision-changed'],
    ['maintenance-npc-skill-context-mismatch', 'source-revision-changed'],
    ['maintenance-npc-skill-request-unavailable', 'source-authorization-denied'],
    ['maintenance-npc-skill-proof-unavailable', 'source-authorization-denied'],
    ['maintenance-npc-skill-proof-required', 'host-audit-failed'],
    ['maintenance-npc-skill-provenance-invalid', 'host-audit-failed'],
    ['maintenance-worldbook-skill-source-invalid', 'source-revision-changed'],
    ['maintenance-worldbook-skill-context-mismatch', 'source-revision-changed'],
    ['maintenance-worldbook-skill-request-unavailable', 'source-authorization-denied'],
    ['maintenance-worldbook-skill-proof-unavailable', 'source-authorization-denied'],
    ['maintenance-worldbook-skill-proof-required', 'host-audit-failed'],
    ['maintenance-worldbook-skill-provenance-invalid', 'host-audit-failed'],
    ['maintenance-worldbook-skill-registration-required', 'host-audit-failed'],
    ['maintenance-worldbook-skill-registration-invalid', 'host-audit-failed'],
    ['maintenance-worldbook-skill-registration-unavailable', 'source-authorization-denied'],
    ['maintenance-provider-context-unavailable', 'host-input-invalid'],
    ['maintenance-memory-proposal-context-required', 'host-input-invalid'],
    ['maintenance-memory-proposal-context-invalid', 'host-input-invalid'],
    ['maintenance-proposal-invalid', 'host-input-invalid'],
    ['maintenance-noop-invalid', 'host-input-invalid'],
]);

// These remain diagnostic-only additions; the historical persisted-code selector above is unchanged.
for (const code of SAFE_MODEL_PREFLIGHT_CODES) {
    if (!HOST_CAUSES.has(code) && code !== 'maintenance-output-budget-exhausted') {
        HOST_CAUSES.set(code, 'host-input-invalid');
    }
}
for (const code of SAFE_TICKET_ERROR_CODES) {
    HOST_CAUSES.set(`maintenance-${code}`, 'source-authorization-denied');
}


function maintenanceDiagnosticOriginCode(error: unknown): string | null {
    const legacy = maintenanceExecutionFailureCode(error);
    if (legacy !== 'maintenance-execution-failed') return legacy;
    let message: unknown;
    try { message = (error as { message?: unknown } | null)?.message; }
    catch { return null; }
    return typeof message === 'string' && HOST_CAUSES.has(message) ? message : null;
}


/** Weak host branding preserves a generic cause without replacing or serializing the original exception. */
export function rememberMaintenanceHarnessFailure(error: unknown): void {
    if (!error || typeof error !== 'object') return;
    const origin = maintenanceDiagnosticOriginCode(error);
    const cause = origin === null ? undefined : HOST_CAUSES.get(origin);
    if (cause !== undefined) rememberHarnessFailureCode(error, cause);
}


export function maintenanceFailureDiagnostic(input: {
    readonly phase: MaintenanceFailurePhase;
    readonly error?: unknown;
    readonly engineFailure?: HarnessFailureMetadata | null;
    readonly businessEffect?: MaintenanceBusinessEffect;
}): MaintenanceFailureDiagnostic {
    rememberMaintenanceHarnessFailure(input.error);
    const persistenceStarted = input.phase === 'direct-preparation' || input.phase === 'proposal-commit'
        || input.phase === 'job-settlement';
    const failure = input.engineFailure ?? classifyHarnessFailure({
        cause: input.error,
        stage: persistenceStarted ? 'store-commit'
            : input.phase === 'preflight' ? 'admission' : 'completion',
        effect: persistenceStarted ? 'unknown-commit' : input.phase === 'preflight' ? 'not-started' : 'unknown',
    });
    return Object.freeze({
        version: MAINTENANCE_FAILURE_CONTRACT_VERSION,
        phase: input.phase,
        originCode: maintenanceDiagnosticOriginCode(input.error),
        businessEffect: input.businessEffect
            ?? (input.phase === 'proposal-commit' ? 'unknown-commit' : 'not-attempted'),
        failure,
        retryPolicyVersion: MAINTENANCE_PROVIDER_RETRY_POLICY.version,
    });
}
