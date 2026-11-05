/** Exact, bounded rollout scope. This module does not enable the compiler. */
export interface ContextCompilerCanaryScope {
  readonly sessionId: string;
  readonly providerId: string;
  readonly model: string;
  readonly profileDigest: string;
  readonly minSamples: number;
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240
    || value.trim() !== value || value.includes('*') || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`context-canary-${name}-invalid`);
  }
  return value;
}

export function contextCompilerCanaryScope(input: ContextCompilerCanaryScope): ContextCompilerCanaryScope {
  if (!input || !Number.isSafeInteger(input.minSamples) || input.minSamples < 1 || input.minSamples > 10_000)
    throw new Error('context-canary-min-samples-invalid');
  const profileDigest = token(input.profileDigest, 'profile');
  if (!/^sha256:[a-f0-9]{64}$/u.test(profileDigest)) throw new Error('context-canary-profile-invalid');
  return Object.freeze({ sessionId: token(input.sessionId, 'session'), providerId: token(input.providerId, 'provider'),
    model: token(input.model, 'model'), profileDigest, minSamples: input.minSamples });
}

export function contextCompilerCanaryMatches(scope: ContextCompilerCanaryScope,
  binding: Omit<ContextCompilerCanaryScope, 'minSamples'>): boolean {
  return binding.sessionId === scope.sessionId && binding.providerId === scope.providerId
    && binding.model === scope.model && binding.profileDigest === scope.profileDigest;
}

/** Process-local accounting; the caller must start only at physical dispatch and settle after validation. */
export class ContextCompilerCanarySamples {
  #started = 0;
  #succeeded = 0;
  #failed = 0;
  readonly scope: ContextCompilerCanaryScope;
  constructor(scope: ContextCompilerCanaryScope) { this.scope = contextCompilerCanaryScope(scope); }

  begin(binding: Omit<ContextCompilerCanaryScope, 'minSamples'>): (outcome: 'success' | 'failure') => void {
    if (!contextCompilerCanaryMatches(this.scope, binding)) throw new Error('context-canary-scope-mismatch');
    this.#started++;
    let settled = false;
    return (outcome) => {
      if (settled || (outcome !== 'success' && outcome !== 'failure')) throw new Error('context-canary-settlement-invalid');
      settled = true;
      if (outcome === 'success') this.#succeeded++; else this.#failed++;
    };
  }

  snapshot() {
    return Object.freeze({ dispatched: this.#started, completed: this.#succeeded + this.#failed,
      succeeded: this.#succeeded, failed: this.#failed,
      inFlight: this.#started - this.#succeeded - this.#failed,
      requiredSamples: this.scope.minSamples,
      remainingSamples: Math.max(0, this.scope.minSamples - this.#succeeded),
      lifetime: 'process' as const, semanticQuality: 'not-evaluated' as const });
  }
}
