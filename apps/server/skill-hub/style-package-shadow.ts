/** One real migrated package at the committed conversation style slot. No Provider/live consumer. */
import { normalizeSkillSelectionObservation, STYLE_PACKAGE_SCHEMA_PATHS, type SkillSelectionObservationV2, type StylePackageShadowRejection } from '../../../packages/session/public/skill-selection-observer.ts';
import { compileReviewedStylePackage, StylePackageCompilationError, STYLE_PACKAGE_SHADOW_PIN, STYLE_PACKAGE_SOURCE } from './style-package-source.ts';
export { STYLE_PACKAGE_SHADOW_PIN } from './style-package-source.ts';
const DOCUMENT = STYLE_PACKAGE_SOURCE.documentIdentityDigest, BODY = STYLE_PACKAGE_SOURCE.bodyHash;
const SHADOW_AUTHORITIES = new WeakMap<object, () => void>();
/** A prerequisite only: callers still need a separate exact host Canary authorization. */
export function assertStylePackageShadowReady(observer: object): void {
  const assertReady = SHADOW_AUTHORITIES.get(observer);
  if (!assertReady) throw new Error('style-package-canary-shadow-not-owned');
  assertReady();
}
type Failure = 'disabled' | 'observation-invalid' | 'source-unavailable' | 'source-mismatch'
  | 'content-mode-mismatch' | 'package-invalid' | 'admission-rejected' | 'compiler-rejected'
  | 'output-mismatch' | 'window-full';
class StylePackageShadowError extends Error {
  readonly code: string;
  constructor(reason: Failure) { super(`style-package-shadow-${reason}`); this.code = this.message; }
}
function fail(reason: Failure): never { throw new StylePackageShadowError(reason); }

interface StylePackageShadowReceipt {
  readonly environment: 'post-commit-shadow';
  readonly evidence: 'compilation-parity';
  readonly packageDigest: string;
  readonly catalogRevision: string;
  readonly selectionReceiptDigest: string;
  readonly admissionDigest: string;
  readonly profilePolicyRevision: string;
  readonly sourceAuthorityRevision: string;
  readonly compilerRevision: string;
  readonly compiledArtifactDigest: string;
  readonly promptTokens: number;
  readonly qualityEvaluated: false;
  readonly promotionEligible: false;
}

/**
 * Runs only behind the existing post-commit observer/one-worker queue. The compiler artifact,
 * source proofs and host policy never leave this closure and cannot be consumed by a live request.
 * AdmissionTicket/Provider rights and the existing 15 Agent profiles are deliberately untouched.
 */
export function createStylePackageShadowObserver(options: Readonly<{ directory: string; isEnabled(): boolean }>) {
  if (!options || typeof options.directory !== 'string' || typeof options.isEnabled !== 'function') {
    throw new TypeError('style-package-shadow-options-invalid');
  }
  const directory = options.directory, isEnabled = options.isEnabled.bind(options);
  const commits = new Set<string>(); // Fixed bounded window; never silently evict/recount old commits.
  let attempts = 0, succeeded = 0, failed = 0, skipped = 0, duplicates = 0;
  let rejectedTurns = 0;
  let lastTurnRejection: StylePackageShadowRejection | null = null;
  let lastErrorCode: string | null = null, lastReceipt: StylePackageShadowReceipt | null = null;
  const assertEnabled = (): void => { if (isEnabled() !== true) fail('disabled'); };
  const observer = Object.freeze({
    rejectTurn(input: StylePackageShadowRejection): void {
      assertEnabled();
      const areas = input?.schemaAreas;
      const paths = input?.schemaPaths;
      if (!input || (input.reason !== 'output-invalid' && input.reason !== 'budget-exhausted')
        || (input.reason === 'budget-exhausted' && (input.detail !== undefined || areas !== undefined || paths !== undefined))
        || (input.reason === 'output-invalid' && !['missing-tool', 'parse-rejected', 'normalization-failed', 'schema-invalid'].includes(input.detail ?? ''))
        || (areas !== undefined && (input.detail !== 'schema-invalid' || !Array.isArray(areas) || areas.length > 4
          || areas.some(area => !['plan', 'memory_delta', 'prose', 'other'].includes(area)) || new Set(areas).size !== areas.length))
        || (paths !== undefined && (input.detail !== 'schema-invalid' || !Array.isArray(paths) || paths.length > 10
          || paths.some(path => !(STYLE_PACKAGE_SCHEMA_PATHS as readonly string[]).includes(path)) || new Set(paths).size !== paths.length))) {
        fail('observation-invalid');
      }
      rejectedTurns++;
      lastTurnRejection = Object.freeze({ reason: input.reason, ...(input.detail ? { detail: input.detail } : {}),
        ...(areas ? { schemaAreas: Object.freeze([...areas].sort()) } : {}),
        ...(paths ? { schemaPaths: Object.freeze([...paths].sort()) } : {}) });
    },
    async observe(input: SkillSelectionObservationV2): Promise<void> {
      attempts++;
      let stage: Failure = 'observation-invalid';
      try {
        assertEnabled();
        const observation = normalizeSkillSelectionObservation(input);
        // An NSF-only package is not evaluated for an NSFW turn. This is not a failed sample.
        if (observation.contentMode !== 'nsf') { skipped++; return; }
        const observed = observation.styleChassis;
        if (observed === undefined) { skipped++; return; }
        if (observed === null) fail('source-unavailable');
        if (observed.skillId !== STYLE_PACKAGE_SHADOW_PIN.skillId || observed.sourceVersion !== '1.0'
          || observed.documentIdentityDigest !== DOCUMENT || observed.bodyHash !== BODY) fail('source-mismatch');
        const commit = `${observation.scopeDigests.sessionId}:${observed.commitDigest}`;
        if (commits.has(commit)) { duplicates++; return; }
        if (commits.size >= 1_024) fail('window-full');
        // Reserve before the first await. Failed attempts remain failed and cannot turn into extra samples.
        commits.add(commit);
        stage = 'package-invalid';
        const compiled = await compileReviewedStylePackage({ directory, scopeDigests: observation.scopeDigests,
          purpose: 'observe-only', assertAllowed: assertEnabled });
        lastReceipt = Object.freeze({ environment: 'post-commit-shadow', evidence: 'compilation-parity',
          ...compiled.receipt, qualityEvaluated: false, promotionEligible: false });
        succeeded++; lastErrorCode = null;
      } catch (error) {
        failed++; lastReceipt = null;
        const failure = error instanceof StylePackageShadowError ? error
          : new StylePackageShadowError(error instanceof StylePackageCompilationError ? error.reason as Failure : stage);
        lastErrorCode = failure.code; throw failure;
      }
    },
    snapshot() {
      return Object.freeze({ snapshotVersion: 'style-package-shadow-v1' as const,
        attempts, succeeded, failed, skipped, duplicates, rejectedTurns, lastTurnRejection, lastErrorCode, lastReceipt,
        qualityEvaluated: false as const, promotionEligible: false as const });
    },
  });
  SHADOW_AUTHORITIES.set(observer, () => {
    assertEnabled();
    if (succeeded < 20 || failed > 0 || rejectedTurns > 0 || !lastReceipt) throw new Error('style-package-canary-shadow-not-ready');
  });
  return observer;
}
