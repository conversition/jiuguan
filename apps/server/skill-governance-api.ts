/** Admin governance for the already wired single-session Style Canary. */
import type { SkillPackagePinInput } from './skill-package-pin-store.ts';
export interface SkillPinRuntime {
  readPin(): unknown;
  setPin(input: SkillPackagePinInput): Promise<unknown>;
}
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const conflicts = ['skill-package-pin-revision-conflict', 'skill-package-pin-expiry-invalid', 'skill-package-pin-clock-regressed',
    'style-package-canary-session-revoked', 'style-package-canary-shadow-not-quiescent', 'style-package-canary-shadow-not-ready',
    'style-package-canary-writes-disabled', 'style-package-canary-legacy-control-conflict'];
  if (conflicts.includes(code)) return { status: 409, body: { code } };
  if (code === 'skill-package-pin-input-invalid') return { status: 400, body: { code } };
  return { status: 503, body: { code: 'skill-package-pin-unavailable' } };
}
export function readSkillPinApi(runtime: SkillPinRuntime) {
  try { return { status: 200, body: { governance: runtime.readPin() } }; }
  catch (error) { return failure(error); }
}
export async function setSkillPinApi(runtime: SkillPinRuntime, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 5 || Object.keys(input).some(key => !['expectedRevision','enabled','sessionId','expiresAt','reason'].includes(key))) {
    return { status: 400, body: { code: 'skill-package-pin-input-invalid' } };
  }
  const row = input as SkillPackagePinInput;
  if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0 || typeof row.enabled !== 'boolean'
    || typeof row.reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(row.reason)
    || (row.enabled ? typeof row.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.sessionId)
      || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt)) || new Date(row.expiresAt).toISOString() !== row.expiresAt
      : row.sessionId !== null || row.expiresAt !== null)) return { status: 400, body: { code: 'skill-package-pin-input-invalid' } };
  try { return { status: 200, body: { pin: await runtime.setPin(row) } }; }
  catch (error) { return failure(error); }
}
