import { classifyContextCompilerRepair } from '../../packages/harness/context-compiler.ts';
import { AbortTurnError, OpenAICompatibleError } from '../../packages/proxy/public/client.ts';
import { ProviderRegistryError, providerFailureDiagnosticCode } from '../../packages/proxy/public/provider-runtime.ts';
import { AdmissionTicketError } from './agent-admission-broker.ts';
import { safeAdmittedModelGatewayErrorCode } from './admitted-model-gateway.ts';

export type ContextCompilerFailureCategory = 'format_or_validation' | 'capacity' | 'budget'
  | 'authority' | 'audit' | 'provider' | 'cancelled' | 'gateway' | 'runtime' | 'other';

// Only exact host vocabulary crosses this boundary. Never log provider messages,
// bodies, causes, source IDs, or user-controlled Error.name values.
const capacityCodes = new Set([
  'context-capsule-output-budget-exceeded', 'context-capsule-structured-budget-exceeded',
  'context-capsule-rendered-budget-exceeded', 'context-compiler-skill-input-budget-exhausted',
  'context-compiler-input-budget-exceeded', 'context-compiler-repair-input-budget-exceeded',
  'context-compiler-merge-input-budget-exceeded', 'context-compiler-repair-candidate-too-large',
  'context-compiler-source-block-too-large', 'context-compiler-source-paragraph-too-large', 'context-compiler-too-many-batches',
  'context-compiler-too-many-fragments', 'context-compiler-split-obligation-unlocatable',
  'context-compiler-repair-budget-unavailable',
  'turn-operation-request-window-exceeded',
]);
const hostCodes: Readonly<Record<string, ContextCompilerFailureCategory>> = Object.freeze({
  'context-compiler-skill-audit-failed': 'audit',
  'context-compiler-skill-audit-required': 'audit',
  'context-compiler-skill-source-stale': 'authority',
  'context-compiler-skill-source-invalid': 'authority',
  'context-compiler-skill-request-source-mismatch': 'authority',
  'context-compiler-skill-admission-denied': 'authority',
  'context-compiler-skill-proof-required': 'authority',
  'context-canary-authority-stale': 'authority',
  'context-canary-authority-missing': 'authority',
  'turn-operation-host-configuration-stale': 'authority',
  'turn-operation-provider-binding-stale': 'authority',
  'turn-operation-runtime-binding-stale': 'authority',
  'context-compiler-skill-runtime-invalid': 'runtime',
  'context-compiler-skill-model-unavailable': 'runtime',
  'context-compiler-skill-unavailable': 'runtime',
  'context-compiler-skill-session-unavailable': 'runtime',
  'context-compiler-skill-host-unavailable': 'runtime',
  'context-compiler-skill-live-required': 'runtime',
  'context-compiler-canary-operation-unsupported': 'runtime',
  'turn-operation-budget-exhausted': 'budget',
  'turn-operation-hold-insufficient': 'budget',
  'turn-operation-usage-exceeded': 'budget',
  'turn-operation-deadline-exhausted': 'budget',
  'turn-operation-call-aborted': 'cancelled',
  'context-compiler-output-incomplete': 'format_or_validation',
  'context-canary-output-invalid': 'format_or_validation',
  'context-capsule-required-content-missing': 'format_or_validation',
  'context-capsule-rendered-content-invalid': 'format_or_validation',
  'context-capsule-rendered-content-empty': 'format_or_validation',
  'context-compiler-merge-content-lost': 'format_or_validation',
  'context-compiler-merge-content-unbacked': 'format_or_validation',
  'context-compiler-merge-conflict-unbacked': 'format_or_validation',
  'context-compiler-merge-coverage-lost': 'format_or_validation',
});
const ticketCodes = new Set([
  'ticket-id-invalid', 'ticket-id-collision', 'ticket-request-expired', 'ticket-lane-disabled',
  'ticket-idempotency-conflict', 'ticket-unknown', 'ticket-replayed', 'ticket-expired',
  'ticket-binding-mismatch', 'ticket-toolset-mismatch', 'ticket-budget-escalation',
]);
const gatewayCategories: Readonly<Record<string, ContextCompilerFailureCategory>> = Object.freeze({
  'gateway-input-budget-exhausted': 'capacity',
  'gateway-output-budget-exhausted': 'capacity',
  'gateway-request-window-exceeded': 'capacity',
  'gateway-model-call-budget-exhausted': 'budget',
  'gateway-cost-budget-exhausted': 'budget',
  'gateway-wall-budget-exhausted': 'budget',
  'gateway-model-binding-mismatch': 'authority',
  'gateway-toolset-binding-mismatch': 'authority',
  'gateway-dispatch-authority-denied': 'authority',
  'gateway-lease-audit-failed': 'audit',
  'gateway-provider-call-cancelled': 'cancelled',
  'gateway-provider-usage-unavailable': 'provider',
  'gateway-provider-usage-invalid': 'provider',
  'gateway-provider-call-failed': 'provider',
});

/** Diagnostic classification only: this must never decide eligibility for a retry. */
export function contextCompilerFailureDiagnostic(error: unknown): {
  category: ContextCompilerFailureCategory; code: string; upstreamStatus?: number;
} {
  try {
    const gatewayCode = safeAdmittedModelGatewayErrorCode(error);
    if (gatewayCode) return { category: gatewayCategories[gatewayCode] ?? 'gateway', code: gatewayCode };
    if (error instanceof AdmissionTicketError && ticketCodes.has(error.code))
      return { category: 'authority', code: error.code };
    if (error instanceof AbortTurnError) return { category: 'cancelled', code: 'context-compiler-cancelled' };
    if (error instanceof ProviderRegistryError) {
      if (error.code === 'invocation-aborted') return { category: 'cancelled', code: 'provider-invocation-aborted' };
      if (error.code === 'not-found' || error.code === 'not-configured')
        return { category: 'provider', code: 'provider-not-configured' };
      if (error.code === 'invocation-forced') return { category: 'provider', code: 'provider-disposed' };
      const upstreamStatus = error.upstreamStatus;
      return { category: 'provider', code: providerFailureDiagnosticCode(error),
        ...(typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus)
          && upstreamStatus >= 400 && upstreamStatus <= 599 ? { upstreamStatus } : {}) };
    }
    const providerCode = providerFailureDiagnosticCode(error);
    if (providerCode !== 'provider-failed' || error instanceof OpenAICompatibleError) {
      const upstreamStatus = error instanceof OpenAICompatibleError ? error.status : undefined;
      return { category: 'provider', code: providerCode,
        ...(typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus)
          && upstreamStatus >= 400 && upstreamStatus <= 599 ? { upstreamStatus } : {}) };
    }
    const message = error instanceof Error ? error.message : '';
    if (typeof message !== 'string' || message.length > 120) return { category: 'other', code: 'context-compiler-failed' };
    if (capacityCodes.has(message)) return { category: 'capacity', code: message };
    if (Object.hasOwn(hostCodes, message)) return { category: hostCodes[message]!, code: message };
    // Reuse the parser's bounded code vocabulary, without granting repair authority.
    const validation = classifyContextCompilerRepair(error);
    if (validation || /^omitted-(?:0|[1-9]\d{0,2})-reason-invalid$/u.test(message))
      return { category: 'format_or_validation', code: message };
  } catch { /* Malformed error fields must not replace the original failure or leak their values. */ }
  return { category: 'other', code: 'context-compiler-failed' };
}
