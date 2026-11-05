/** Deterministic, zero-Provider Skill host for the original NSFW scene carrier. */
import { AGENT_SKILL_GRANT_VERSION, normalizeAgentSkillCatalogSnapshot,
  normalizeAgentSkillExecutionGrant, type AgentSkillCatalogSnapshotV1 } from '@jiuguan/skill-hub';
import { AGENT_SKILL_ADAPTERS } from '../../../packages/agent-policy/public/agent-skill-adapters.ts';
import { compileAgentSkillPrograms, verifyCompiledAgentSkillArtifact,
  type AgentSkillCompilationRequestV1 } from '@jiuguan/prompt/agent-skill-compiler';
import type { AgentSkillTurnContextV1 } from '../../../packages/session/public/agent-skill-turn-context.ts';
import { parseNsfwSceneSkillSource, sealNsfwSceneSkillReceipt, type NsfwSceneSkillHost,
  type NsfwSceneSkillSource } from '../../../packages/session/public/nsfw-scene-skill.ts';
import { nsfwSceneRequestDigest, parseNsfwSceneRequestReceipt,
  type NsfwSceneRequestReceipt } from '../../../packages/session/public/nsfw-scene-request.ts';
import { createServerBuiltinAgentSkillPack } from './builtin-source-pack.ts';
import { createServerAgentSkillRuntime } from './composition.ts';
import { createServerAgentSkillCompilerAuthorization, createServerAgentSkillCompilerSourceProofs } from './profile-admission-service.ts';

export const NSFW_SCENE_SKILL_HOST_VERSION = 'nsfw-scene-skill-host-v1' as const;
const PROFILE = 'maintenance.nsfwScene';
const MAX_TOKENS = 512;
type Pack = ReturnType<typeof createServerBuiltinAgentSkillPack>;
export interface NsfwSceneSkillHostDependencies {
  readonly readCurrent: (source: NsfwSceneSkillSource) => {
    readonly turn: AgentSkillTurnContextV1;
    readonly sessionIdentity: object;
  } | null;
  readonly liveEnabled: () => boolean;
  /** Trusted immutable pack port; tests may substitute failed catalog/body IO. */
  readonly pack?: Pack;
  readonly nowMs?: () => number;
  /** An untrusted compiler result is always checked by the official deterministic verifier. */
  readonly compile?: (request: AgentSkillCompilationRequestV1) => unknown | Promise<unknown>;
}

export function nsfwSceneSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.JG_AGENT_SKILL_LIVE === '1' && env.JG_AGENT_SKILL_NSFW_SCENE_LIVE === '1';
}

export function createNsfwSceneSkillHost(dependencies: NsfwSceneSkillHostDependencies): NsfwSceneSkillHost {
  const readCurrent = dependencies.readCurrent.bind(dependencies);
  const enabled = dependencies.liveEnabled.bind(dependencies);
  const now = dependencies.nowMs ?? Date.now;
  const compile = dependencies.compile ?? compileAgentSkillPrograms;
  const pack = dependencies.pack ?? createServerBuiltinAgentSkillPack();
  const runtime = createServerAgentSkillRuntime(pack.catalogPort);
  const readCatalog = pack.catalogPort.readCatalog.bind(pack.catalogPort);
  const grant = normalizeAgentSkillExecutionGrant({ grantVersion: AGENT_SKILL_GRANT_VERSION,
    tools: [], writableArtifactKinds: [], maxRiskTier: 'advisory', maxModelCalls: 0,
    maxToolCalls: 0, maxInputTokens: MAX_TOKENS, maxOutputTokens: 0 });
  const required = () => {
    try { return enabled() === true; }
    catch { throw new Error('nsfw-scene-skill-authority-unavailable'); }
  };
  return Object.freeze({ required, async prepare(input: Parameters<NsfwSceneSkillHost['prepare']>[0]) {
    let revoked = false, sealed = false;
    const fail = (code: string): never => { revoked = true; throw new Error(code); };
    if (!required()) return fail('nsfw-scene-skill-disabled');
    const source = parseNsfwSceneSkillSource(input.source);
    if (typeof input.queryHead !== 'string' || input.queryHead.length === 0 || input.queryHead.length > 16_384
      || nsfwSceneRequestDigest(input.queryHead) !== source.queryHeadDigest || typeof input.assertCurrent !== 'function') {
      return fail('nsfw-scene-skill-input-invalid');
    }
    const assertSource = input.assertCurrent.bind(input);
    const read = () => {
      try {
        const value = readCurrent(source);
        if (!required() || !value || !value.sessionIdentity || typeof value.sessionIdentity !== 'object'
          || value.turn.contextVersion !== 'session-agent-skill-turn-context-v1'
          || value.turn.runId !== source.runId || value.turn.contentMode !== 'nsfw'
          || value.turn.worldbookSourceRevision !== source.sourceRevision) return fail('nsfw-scene-skill-source-stale');
        return value;
      } catch { return fail('nsfw-scene-skill-source-stale'); }
    };
    try { assertSource(); } catch { return fail('nsfw-scene-skill-source-stale'); }
    const captured = read();
    const identity = captured.sessionIdentity;
    const turn = Object.freeze(structuredClone(captured.turn));
    const turnDigest = nsfwSceneRequestDigest(turn);
    const assertCurrent = () => {
      if (revoked || sealed) return fail('nsfw-scene-skill-preparation-unavailable');
      try {
        assertSource();
        const current = read();
        if (current.sessionIdentity !== identity || nsfwSceneRequestDigest(current.turn) !== turnDigest) {
          return fail('nsfw-scene-skill-source-stale');
        }
      } catch { return fail('nsfw-scene-skill-source-stale'); }
    };
    assertCurrent();
    const profile = pack.profileRegistry.byProfileId(PROFILE);
    const adapter = AGENT_SKILL_ADAPTERS.find(item => item.profile.profileId === PROFILE);
    if (!profile || !adapter || profile.executionCeiling.maxModelCalls !== 0
      || profile.executionCeiling.maxToolCalls !== 0 || profile.allowedTools.length !== 0
      || profile.allowedWritableArtifactKinds.length !== 0) return fail('nsfw-scene-skill-profile-unavailable');
    const policyRevision = profile.policyRevision, registryRevision = pack.profileRegistry.registryRevision;
    const sourceAuthorityRevision = pack.sourceAuthority.authorityRevision;
    let catalog: AgentSkillCatalogSnapshotV1;
    try { catalog = normalizeAgentSkillCatalogSnapshot(await readCatalog()); }
    catch { return fail('nsfw-scene-skill-catalog-unavailable'); }
    assertCurrent();
    const context = Object.freeze({ capabilityId: PROFILE, taskKind: 'nsfw_scene_curator', phase: 'plan' as const,
      contentMode: 'nsfw' as const, scope: turn.scope, grant, budgetTokens: MAX_TOKENS, maxSkills: 1,
      explicit: Object.freeze(profile.enrollments.filter(item => item.required).map(item => ({ skillId: item.skillId, version: item.version }))) });
    if (!adapter.supports(context)) return fail('nsfw-scene-skill-profile-unavailable');
    const request = adapter.buildSelectionRequest(context, catalog);
    const assertAdmissionCurrent = async () => {
      assertCurrent();
      const currentCatalog = normalizeAgentSkillCatalogSnapshot(await readCatalog());
      if (currentCatalog.catalogRevision !== catalog.catalogRevision
        || pack.profileRegistry.registryRevision !== registryRevision
        || pack.profileRegistry.byProfileId(PROFILE)?.policyRevision !== policyRevision
        || pack.sourceAuthority.authorityRevision !== sourceAuthorityRevision) return fail('nsfw-scene-skill-authority-drift');
      assertCurrent();
    };
    try {
      const guarded = await runtime.prepareGuardedAdmission(request, grant, {
        authorize(receipt) {
          assertCurrent();
          const authorization = pack.profileRegistry.authorizeSelection(PROFILE, receipt);
          const sources = receipt.selected.map(({ header }) => pack.sourceAuthority.authorizeHeader(header));
          return Object.freeze({ authorization, sources });
        }, assertCurrent: assertAdmissionCurrent,
      });
      await assertAdmissionCurrent();
      adapter.validateAdmission(guarded.admission, context);
      const admittedSources = pack.sourceAuthority.authorizeAdmission(guarded.admission);
      if (admittedSources.length !== 1 || admittedSources.length !== guarded.authorization.sources.length
        || admittedSources.some((entry, index) => nsfwSceneRequestDigest(entry) !== nsfwSceneRequestDigest(guarded.authorization.sources[index]))) {
        return fail('nsfw-scene-skill-source-unavailable');
      }
      const authorityRevision = nsfwSceneRequestDigest({ hostVersion: NSFW_SCENE_SKILL_HOST_VERSION,
        sourceDigest: source.sourceDigest, turnDigest, catalogRevision: catalog.catalogRevision,
        policyRevision, registryRevision, sourceAuthorityRevision, selectionReceiptDigest: guarded.receipt.receiptDigest });
      const authorization = createServerAgentSkillCompilerAuthorization(guarded.authorization.authorization,
        registryRevision, authorityRevision);
      const compilationRequest: AgentSkillCompilationRequestV1 = Object.freeze({ admission: guarded.admission,
        sourceProofs: createServerAgentSkillCompilerSourceProofs(guarded.admission, admittedSources, authorization),
        profileAuthorization: authorization, maxInstructionTokens: MAX_TOKENS, maxValidatorOperations: 0 });
      const artifact = verifyCompiledAgentSkillArtifact(await compile(compilationRequest), compilationRequest);
      await assertAdmissionCurrent();
      if (!artifact.promptInstruction || artifact.promptSlots.length !== 1 || artifact.validatorPlan.length !== 0
        || artifact.profileId !== PROFILE || artifact.promptTokens > MAX_TOKENS) return fail('nsfw-scene-skill-artifact-invalid');
      const instruction = artifact.promptInstruction, instructionDigest = nsfwSceneRequestDigest(instruction);
      const preparedAt = new Date(now()).toISOString();
      return Object.freeze({ instruction, assertCurrent, sealAccepted(nativeInput: NsfwSceneRequestReceipt) {
        if (revoked || sealed) return fail('nsfw-scene-skill-preparation-unavailable');
        sealed = true;
        // Own synchronous business writes may have advanced the turn snapshot. The Session
        // already checked it before entering that ring; here retain only live identity/root gates.
        const current = read();
        if (current.sessionIdentity !== identity) return fail('nsfw-scene-skill-source-stale');
        const native = parseNsfwSceneRequestReceipt(nativeInput);
        if (native.sessionId !== source.sessionId || native.runId !== source.runId || native.round !== source.round
          || native.historyEpoch !== source.historyEpoch || native.sourceRevision !== source.sourceRevision
          || native.safetyDigest !== source.safetyDigest || native.sceneDigest !== source.sceneDigest
          || native.decisionDigest !== source.decisionDigest || native.queryHeadDigest !== source.queryHeadDigest
          || nsfwSceneRequestDigest(native.exposureDigests) !== nsfwSceneRequestDigest(source.exposureDigests)) {
          return fail('nsfw-scene-skill-native-binding-invalid');
        }
        return sealNsfwSceneSkillReceipt({ source, nativeReceiptDigest: native.receiptDigest,
          requestDigest: native.requestDigest, queryHeadDigest: native.queryHeadDigest, instructionDigest,
          catalogRevision: catalog.catalogRevision, selectionReceiptDigest: guarded.receipt.receiptDigest,
          instructionSetDigest: guarded.admission.instructionSetDigest, policyRevision,
          authorizationDigest: authorization.authorizationDigest, sourceAuthorityRevision,
          artifactDigest: artifact.compiledArtifactDigest, admissionDigest: guarded.admission.admissionDigest,
          profileRegistryRevision: registryRevision, authorityRevision,
          selectedManifestDigests: guarded.receipt.selected.map(({ header }) => header.manifestDigest),
          preparedAt, acceptedAt: native.createdAt });
      } });
    } catch { return fail('nsfw-scene-skill-admission-failed'); }
  } });
}
