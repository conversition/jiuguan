/** Single-session host Canary for the reviewed filesystem style package. No new Store/Agent. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StylePackageCanaryInput, StylePackageCanaryAdmission } from '../../../packages/session/public/style-package-canary.ts';
import { STYLE_PACKAGE_SCHEMA_PATHS, type StylePackageSchemaPath } from '../../../packages/session/public/skill-selection-observer.ts';
import { skillScopeIdentityDigest } from '../../../packages/core/public/skills.ts';
import { compileReviewedStylePackage, STYLE_PACKAGE_SHADOW_PIN, STYLE_PACKAGE_SOURCE } from './style-package-source.ts';
import { assertStylePackageShadowReady } from './style-package-shadow.ts';
import { SessionAgentSkillShadowRunner } from './session-shadow-runner.ts';
import type { SkillPackagePinStore, SkillPackagePinInput } from '../skill-package-pin-store.ts';

export const STYLE_PACKAGE_CANARY_ACK = 'style-package-canary-v1' as const;
export const STYLE_PACKAGE_CANARY_FILE = 'style-package-canary.json' as const;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
class CanaryError extends Error {
  readonly code: string;
  constructor(reason: string) { super(`style-package-canary-${reason}`); this.code = this.message; }
}
function fail(reason: string): never { throw new CanaryError(reason); }
function errorCode(error: unknown, otherwise: string): string {
  return error instanceof Error && /^style-package-[a-z-]{1,80}$/u.test(error.message) ? error.message : otherwise;
}
interface Control {
  readonly ack: typeof STYLE_PACKAGE_CANARY_ACK;
  readonly revision: number;
  readonly sessionId: string;
  readonly packageDigest: string;
  readonly expiresAt: string;
}
function readControl(file: string): { control: Control; fileIdentity: string } | null {
  let stat;
  try { stat = lstatSync(file, { throwIfNoEntry: false, bigint: true }); }
  catch { return fail('control-unavailable'); }
  // Absence is explicit off/rollback. Corrupt, linked, partial or unreadable controls are errors.
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096n) fail('control-invalid');
  const identity = (item: typeof stat) => [item.dev, item.ino, item.size, item.birthtimeNs, item.mtimeNs, item.ctimeNs].map(String).join(':');
  const before = identity(stat);
  let value: unknown;
  try { const bytes = readFileSync(file); if (bytes.byteLength > 4_096) fail('control-invalid'); const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('control-invalid'); value = JSON.parse(text);
  } catch { return fail('control-invalid'); }
  let after;
  try { after = lstatSync(file, { throwIfNoEntry: false, bigint: true }); }
  catch { return fail('control-unavailable'); }
  if (!after || !after.isFile() || after.isSymbolicLink() || identity(after) !== before) fail('control-changed');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('control-invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 5 || Object.keys(row).some(key => !['ack', 'revision', 'sessionId', 'packageDigest', 'expiresAt'].includes(key))
    || row.ack !== STYLE_PACKAGE_CANARY_ACK || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || typeof row.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.sessionId)
    || row.packageDigest !== STYLE_PACKAGE_SHADOW_PIN.packageDigest || typeof row.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(row.expiresAt)) || new Date(row.expiresAt).toISOString() !== row.expiresAt) fail('control-invalid');
  return Object.freeze({ control: Object.freeze(row as unknown as Control), fileIdentity: before });
}

/** Shadow evidence is a prerequisite, never the authority. An exact host control file is also required. */
export function createStylePackageCanary(options: Readonly<{
  directory: string; controlFile: string; shadow: object; runner: SessionAgentSkillShadowRunner;
  allowsSession(sessionId: string): boolean; nowMs?: () => number;
  controlStore?: SkillPackagePinStore;
  writesEnabled?: () => boolean;
}>) {
  if (!options || !(options.runner instanceof SessionAgentSkillShadowRunner) || typeof options.allowsSession !== 'function') fail('options-invalid');
  const directory = resolve(options.directory), file = resolve(options.controlFile);
  const now = options.nowMs ?? Date.now, allowsSession = options.allowsSession.bind(options);
  const shadow = options.shadow, runner = options.runner;
  const readSnapshot = (): ReturnType<typeof readControl> => {
    if (!options.controlStore) return readControl(file);
    const pin = options.controlStore.read();
    // A legacy file is never a second writer for a managed installation. An explicit CAS
    // on/off decision supersedes it; an unclaimed legacy configuration fails visibly.
    if (!pin) {
      if (lstatSync(file, { throwIfNoEntry: false })) fail('legacy-control-conflict');
      return null;
    }
    if (!pin.enabled) return null;
    return { control: Object.freeze({ ack: STYLE_PACKAGE_CANARY_ACK, revision: pin.revision,
      sessionId: pin.sessionId!, packageDigest: pin.packageDigest, expiresAt: pin.expiresAt! }), fileIdentity: pin.digest };
  };
  let controlIdentity: string | null = null, generation = 0, maxRevision = 0;
  let qualifiedIdentity: string | null = null;
  let prepared = 0, committed = 0, failed = 0, abandoned = 0, inFlight = 0;
  let lastErrorCode: string | null = null;
  let lastOutputFailure: 'missing-tool' | 'parse-rejected' | 'normalization-failed' | 'schema-invalid' | null = null;
  let lastSchemaFailureAreas: readonly ('plan' | 'memory_delta' | 'prose' | 'other')[] = Object.freeze([]);
  let lastSchemaFailurePaths: readonly StylePackageSchemaPath[] = Object.freeze([]);
  let lastReceipt: Readonly<Record<string, string | number | boolean>> | null = null;
  const currentControl = (): Control | null => {
    const snapshot = readSnapshot(), control = snapshot?.control ?? null;
    const identity = snapshot ? hash(snapshot) : null;
    if (identity !== controlIdentity) {
      generation++;
      if (control && control.revision <= maxRevision) fail('control-revision-replayed');
      controlIdentity = identity;
      if (control) maxRevision = control.revision;
    }
    return control;
  };
  const assertShadow = (quiescent = false): void => {
    assertStylePackageShadowReady(shadow);
    const health = runner.snapshot();
    // Idle time is not a failure. Requiring a fresh post-commit observation here would deadlock
    // the selected session: this guard runs before that session can make its next commit.
    if (health.failed > 0 || health.dropped > 0 || health.faulted
      || (quiescent && (health.inFlight > 0 || health.pending > 0 || health.running))) fail('shadow-not-quiescent');
  };
  /** Current, body-free diagnostics only. Does not advance revisions or issue a handle. */
  const preflight = () => {
    const blockers: string[] = [];
    let snapshot: ReturnType<typeof readControl> = null;
    try { snapshot = readSnapshot(); }
    catch (error) { blockers.push(errorCode(error, 'style-package-canary-control-unavailable')); }
    if (blockers.length === 0 && !snapshot) blockers.push('style-package-canary-control-off');
    if (snapshot) {
      const identity = hash(snapshot);
      if (identity !== controlIdentity && snapshot.control.revision <= maxRevision) blockers.push('style-package-canary-control-revision-replayed');
      if (Date.parse(snapshot.control.expiresAt) <= now()) blockers.push('style-package-canary-expired');
      if (!allowsSession(snapshot.control.sessionId)) blockers.push('style-package-canary-session-revoked');
    }
    try { assertShadow(Boolean(snapshot && hash(snapshot) !== qualifiedIdentity)); }
    catch (error) { blockers.push(errorCode(error, 'style-package-canary-shadow-unavailable')); }
    return Object.freeze({ blockers: Object.freeze(blockers), potentialReady: blockers.length === 0,
      // The next admission rereads the complete package and all authority; this status never grants execution.
      packageSource: 'not-checked' as const, authorizesExecution: false as const });
  };
  return Object.freeze({
    readPin() {
      if (!options.controlStore) fail('managed-control-unavailable');
      const pin = options.controlStore.read();
      const checks = preflight();
      return Object.freeze({ pin, revision: pin?.revision ?? 0, writesEnabled: options.writesEnabled?.() === true,
        profileId: 'style.compose', fixedPackage: STYLE_PACKAGE_SHADOW_PIN, preflight: checks,
        // Historical receipt is labelled separately; readiness alone is never proof of use.
        currentRevisionConsumed: Boolean(pin && lastReceipt?.controlRevision === pin.revision),
        lastReceipt, published: false, qualityEvaluated: false });
    },
    async setPin(input: SkillPackagePinInput) {
      input = Object.freeze({ ...input });
      if (!options.controlStore) fail('managed-control-unavailable');
      if (options.writesEnabled?.() !== true) fail('writes-disabled');
      let compilation: Awaited<ReturnType<typeof compileReviewedStylePackage>> | null = null;
      const authorize = () => {
        if (options.writesEnabled?.() !== true) fail('writes-disabled');
        if (input.enabled) {
          if (!input.sessionId || !allowsSession(input.sessionId)) fail('session-revoked');
          assertShadow(true);
        }
      };
      authorize();
      if (input.enabled) compilation = await compileReviewedStylePackage({ directory,
        scopeDigests: { sessionId: skillScopeIdentityDigest('session', input.sessionId!) }, purpose: 'canary', assertAllowed: authorize });
      return options.controlStore.set(input, () => { authorize(); compilation?.assertCurrent(); });
    },
    async prepare(input: StylePackageCanaryInput): Promise<StylePackageCanaryAdmission | null> {
      try {
        const control = currentControl();
        if (!control || control.sessionId !== input.sessionId) return null;
        // This reviewed package is NSF-only. An NSFW turn is outside the
        // selected route and must retain its own existing style selection.
        if (input.contentMode === 'nsfw') return null;
        const capturedGeneration = generation, capturedIdentity = controlIdentity;
        const source = input.source;
        if (!allowsSession(input.sessionId) || input.contentMode !== 'nsf' || !source
          || source.skillId !== STYLE_PACKAGE_SHADOW_PIN.skillId
          || source.sourceVersion !== STYLE_PACKAGE_SOURCE.sourceVersion || source.bodyHash !== STYLE_PACKAGE_SOURCE.bodyHash
          || source.documentIdentityDigest !== STYLE_PACKAGE_SOURCE.documentIdentityDigest
          || typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(input.runId)
          || !Number.isSafeInteger(input.round) || input.round < 1) fail('source-invalid');
        // Freeze caller binding before any await; an ordinary DTO is never control authority.
        const runId = input.runId, round = input.round, sessionId = input.sessionId;
        const assertAllowed = () => {
          const current = currentControl();
          if (!current || generation !== capturedGeneration || controlIdentity !== capturedIdentity) fail('revoked');
          if (Date.parse(current.expiresAt) <= now()) fail('expired');
          if (!allowsSession(sessionId)) fail('session-revoked');
          assertShadow();
        };
        if (qualifiedIdentity !== capturedIdentity) assertShadow(true);
        assertAllowed();
        const compilation = await compileReviewedStylePackage({ directory,
          scopeDigests: { sessionId: skillScopeIdentityDigest('session', sessionId) }, purpose: 'canary', assertAllowed });
        assertAllowed(); qualifiedIdentity = capturedIdentity; prepared++; inFlight++;
        let state: 'prepared' | 'committed' | 'failed' | 'disposed' = 'prepared';
        let released = false;
        const release = () => { if (!released) { released = true; inFlight--; } };
        const guard = <T>(check: () => T): T => {
          if (state !== 'prepared') fail('handle-closed');
          try { return check(); }
          catch (error) {
            state = 'failed'; failed++; release();
            lastErrorCode = errorCode(error, 'style-package-canary-current-check-failed');
            if (lastErrorCode !== 'style-package-canary-output-invalid') { lastOutputFailure = null; lastSchemaFailureAreas = Object.freeze([]); lastSchemaFailurePaths = Object.freeze([]); }
            throw error;
          }
        };
        return Object.freeze({
          instruction: compilation.artifact.promptInstruction,
          assertActive: () => guard(assertAllowed),
          assertCurrent: () => guard(() => { assertAllowed(); compilation.assertCurrent(); }),
          rejectOutput: (reason: 'output-invalid' | 'budget-exhausted', detail?: 'missing-tool' | 'parse-rejected' | 'normalization-failed' | 'schema-invalid',
            schemaAreas?: readonly ('plan' | 'memory_delta' | 'prose' | 'other')[], schemaPaths?: readonly StylePackageSchemaPath[]) => guard(() => {
            if (reason !== 'output-invalid' && reason !== 'budget-exhausted') fail('rejection-invalid');
            if ((reason === 'output-invalid' && detail !== 'missing-tool' && detail !== 'parse-rejected' && detail !== 'normalization-failed' && detail !== 'schema-invalid')
              || (reason === 'budget-exhausted' && detail !== undefined)) fail('rejection-invalid');
            if (schemaAreas !== undefined && (detail !== 'schema-invalid' || !Array.isArray(schemaAreas)
              || schemaAreas.length > 4 || schemaAreas.some(area => !['plan', 'memory_delta', 'prose', 'other'].includes(area))
              || new Set(schemaAreas).size !== schemaAreas.length)) fail('rejection-invalid');
            if (schemaPaths !== undefined && (detail !== 'schema-invalid' || !Array.isArray(schemaPaths) || schemaPaths.length > 10
              || schemaPaths.some(path => !(STYLE_PACKAGE_SCHEMA_PATHS as readonly string[]).includes(path))
              || new Set(schemaPaths).size !== schemaPaths.length)) fail('rejection-invalid');
            lastOutputFailure = detail ?? null;
            lastSchemaFailureAreas = Object.freeze([...(schemaAreas ?? [])].sort());
            lastSchemaFailurePaths = Object.freeze([...(schemaPaths ?? [])].sort());
            return fail(reason);
          }),
          committed(receipt: Parameters<StylePackageCanaryAdmission['committed']>[0]) {
            guard(() => {
              if (!receipt || receipt.runId !== runId || receipt.round !== round || !HASH.test(receipt.requestDigest)
                || !HASH.test(receipt.assistantDigest) || !Number.isSafeInteger(receipt.assistantMessageId) || receipt.assistantMessageId < 1) fail('commit-binding-invalid');
            });
            // Historical fact from the original successful transaction; a later rollback cannot erase it.
            state = 'committed'; committed++; release(); lastErrorCode = null; lastOutputFailure = null; lastSchemaFailureAreas = Object.freeze([]); lastSchemaFailurePaths = Object.freeze([]);
            lastReceipt = Object.freeze({ ...compilation.receipt, controlRevision: control.revision,
              environment: 'canary', commitDigest: hash([sessionId, runId, receipt]), qualityEvaluated: false, published: false });
          },
          dispose() { if (state === 'prepared') { state = 'disposed'; abandoned++; } release(); },
        });
      } catch (error) {
        failed++; lastOutputFailure = null; lastSchemaFailureAreas = Object.freeze([]); lastSchemaFailurePaths = Object.freeze([]);
        lastErrorCode = errorCode(error, 'style-package-canary-preparation-failed');
        throw error;
      }
    },
    snapshot() { return Object.freeze({ snapshotVersion: 'style-package-canary-v1', prepared, committed, failed,
      abandoned, inFlight, lastErrorCode, lastOutputFailure, lastSchemaFailureAreas, lastSchemaFailurePaths, lastReceipt, preflight: preflight(), qualityEvaluated: false, published: false }); },
  });
}
