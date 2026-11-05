/**
 * Versioned host ceiling for sessions that are owned by this Jiuguan data root.
 *
 * This is intentionally not an authentication or resource-ownership predicate. Production
 * callers may use it only after the session was created/resumed from the managed local data
 * directory (Worldbook repair additionally re-resolves its session/asset binding). The narrow
 * canonical id check prevents an arbitrary legacy/opaque id from inheriting this scope.
 */
export const MANAGED_LOCAL_SESSION_SCOPE_VERSION = 'managed-local-v1' as const;
export const MANAGED_LOCAL_SESSION_SCOPE_ACK = 'p14-managed-local-session-scope-v1' as const;

export type RuntimeSessionScope = 'exact' | typeof MANAGED_LOCAL_SESSION_SCOPE_VERSION;

// New sessions are generated as `session-${Date.now()}`. Keep the accepted shape aligned with
// both Windows launchers and deliberately exclude legacy ids such as `session:foo`/`session-a`.
const CANONICAL_MANAGED_LOCAL_SESSION_ID = /^session-[0-9]{6,24}$/u;

export function isCanonicalManagedLocalSessionId(sessionId: string): boolean {
  return CANONICAL_MANAGED_LOCAL_SESSION_ID.test(sessionId);
}

export function parseRuntimeSessionScope(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeSessionScope {
  const raw = env.JG_MANAGED_LOCAL_SESSION_SCOPE?.trim();
  const acknowledgement = env.JG_MANAGED_LOCAL_SESSION_SCOPE_ACK?.trim();
  if (!raw) {
    if (acknowledgement) {
      throw new Error('JG_MANAGED_LOCAL_SESSION_SCOPE_ACK 不能脱离显式 scope 使用');
    }
    return 'exact';
  }
  if (raw !== MANAGED_LOCAL_SESSION_SCOPE_VERSION) {
    throw new Error(
      `JG_MANAGED_LOCAL_SESSION_SCOPE 只允许 ${MANAGED_LOCAL_SESSION_SCOPE_VERSION}`,
    );
  }
  if (acknowledgement !== MANAGED_LOCAL_SESSION_SCOPE_ACK) {
    throw new Error(
      `JG_MANAGED_LOCAL_SESSION_SCOPE=${MANAGED_LOCAL_SESSION_SCOPE_VERSION} 需要 `
      + `JG_MANAGED_LOCAL_SESSION_SCOPE_ACK=${MANAGED_LOCAL_SESSION_SCOPE_ACK}`,
    );
  }
  return MANAGED_LOCAL_SESSION_SCOPE_VERSION;
}

/** Host-ceiling composition only; callers remain responsible for local session ownership. */
export function runtimeSessionScopeAllows(
  scope: RuntimeSessionScope,
  exactSessionAllowlist: ReadonlySet<string>,
  sessionId: string,
): boolean {
  return exactSessionAllowlist.has(sessionId)
    || (scope === MANAGED_LOCAL_SESSION_SCOPE_VERSION
      && isCanonicalManagedLocalSessionId(sessionId));
}
