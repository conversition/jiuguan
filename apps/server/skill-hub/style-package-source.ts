/** Shared fixed-package compilation; callers retain distinct Shadow and Canary authority. */
import { createHash } from 'node:crypto';
import { createAgentSkillCatalogSnapshot, type AgentSkillCatalogPort, type AgentSkillBodyRequestV1 } from '@jiuguan/skill-hub';
import { compileAgentSkillPrograms, verifyCompiledAgentSkillArtifact } from '@jiuguan/prompt/agent-skill-compiler';
import { createServerConversationStyleFoundationPack } from './builtin-source-pack.ts';
import { createFilesystemSkillPackageCatalog } from './filesystem-package-catalog.ts';
import { createServerAgentSkillRuntime } from './composition.ts';
import { createServerAgentSkillProfilePolicyRegistry } from './profile-policy-registry.ts';
import { createServerAgentSkillSourceAuthorityRegistry } from './source-authority-registry.ts';
import {
  createServerAgentSkillCompilerAuthorization, createServerAgentSkillCompilerSourceProofs,
} from './profile-admission-service.ts';

export const STYLE_PACKAGE_SHADOW_PIN = Object.freeze({
  skillId: 'skill:sha256:25a8810147cd01a3e0142836298ea8a0407d0b62416b157fcc899d8e70cfa101',
  version: 'legacy.1.0.87d5d9d5eee9a8344047cdbeccae38a731ccd25fbdff4cb1a25031cfd072b543',
  packageDigest: 'sha256:cbd8e180e8db03ebbbdbf3c834fe02afb190a60eb0dafa7b8a41f2ab09e9f6fe',
});
const DOCUMENT = 'sha256:de8efcc7d24d776d277bc9574eb51cdeec2ab2c1157607d615fc4b0bd1176000';
const BODY = 'sha256:0fc5bed3d233884f3d0604ff798d88ecc8877a598410572e574c368901569e8c';
const PROFILE = 'style.compose';
const MAX_TOKENS = 8_000;
const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;


export const STYLE_PACKAGE_SOURCE = Object.freeze({ sourceVersion: '1.0', documentIdentityDigest: DOCUMENT, bodyHash: BODY });
export class StylePackageCompilationError extends Error {
  readonly code: string;
  constructor(readonly reason: string) { super(`style-package-${reason}`); this.code = this.message; }
}
function fail(reason: string): never { throw new StylePackageCompilationError(reason); }
/** Host-only compiler composition. No Provider calls, publication or authority from package metadata. */
export async function compileReviewedStylePackage(options: Readonly<{
  directory: string; scopeDigests: { sessionId: string; cardId?: string; worldId?: string };
  purpose: 'observe-only' | 'canary'; assertAllowed(): void;
}>) {
  const { directory, scopeDigests, purpose } = options;
  const assertEnabled = options.assertAllowed.bind(options);
  const isEnabled = () => { assertEnabled(); return true; };
  let stage = 'package-invalid';
  try {
    const packageCatalog = createFilesystemSkillPackageCatalog({ directory, pins: [STYLE_PACKAGE_SHADOW_PIN], isEnabled });
    const foundation = createServerConversationStyleFoundationPack();
    const foundationCatalog = await foundation.catalogPort.readCatalog();
    const snapshot = createAgentSkillCatalogSnapshot([...foundationCatalog.headers, ...packageCatalog.snapshot.headers]);
    const foundationDigests = new Set(foundationCatalog.headers.map(header => header.manifestDigest));
    const assertCurrent = () => {
      assertEnabled();
      try { packageCatalog.assertCurrent(); }
      catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('style-package-')) throw error;
        fail('package-invalid');
      }
    };
    const catalogPort: AgentSkillCatalogPort = Object.freeze({
      async readCatalog() { assertCurrent(); return snapshot; },
      async loadBody(request: AgentSkillBodyRequestV1) {
        assertCurrent();
        if (request.catalogRevision !== snapshot.catalogRevision) throw new Error('agent-skill-catalog-revision-stale');
        const isFoundation = foundationDigests.has(request.manifestDigest);
        const body = await (isFoundation ? foundation.catalogPort : packageCatalog.catalogPort).loadBody({
          ...request, catalogRevision: isFoundation ? foundationCatalog.catalogRevision : packageCatalog.snapshot.catalogRevision,
        });
        assertCurrent(); return body;
      },
    });
    stage = 'admission-rejected';
    const policy = foundation.profileRegistry.byProfileId(PROFILE)!;
    const header = packageCatalog.snapshot.headers[0]!, manifest = header.manifest;
    const { policyRevision: _revision, ...basePolicy } = policy;
    const profiles = createServerAgentSkillProfilePolicyRegistry([{
      ...basePolicy, maxSkills: 2, maxInstructionTokens: MAX_TOKENS,
      executionCeiling: { ...basePolicy.executionCeiling, maxInputTokens: MAX_TOKENS },
      familyRules: [...basePolicy.familyRules, { familyId: 'skill.style', allowAutoPromotion: false, allowedContracts: [{
        kind: manifest.kind, artifactKind: manifest.artifactKind, inputSchemaDigest: manifest.inputSchemaDigest,
        outputSchemaDigest: manifest.outputSchemaDigest, evaluatorId: manifest.evaluatorId, owner: manifest.owner, sourceType: manifest.sourceType,
      }] }],
      enrollments: [...basePolicy.enrollments, { familyId: 'skill.style', skillId: manifest.skillId,
        version: manifest.version, manifestDigest: header.manifestDigest, required: true }],
    }]);
    const sources = createServerAgentSkillSourceAuthorityRegistry({
      snapshotVersion: 'server-agent-skill-source-authority-snapshot-v1',
      entries: [...foundation.sourceAuthority.snapshot.entries, {
        skillId: manifest.skillId, version: manifest.version, manifestDigest: header.manifestDigest,
        bodyHash: manifest.bodyHash, sourceHash: manifest.sourceHash, sourceRevision: manifest.sourceRevision,
        trustClass: 'reviewed-author', evidenceDigest: hash(JSON.stringify([`${purpose}-host-pin-v1`, STYLE_PACKAGE_SHADOW_PIN])),
      }],
    });
    const grant = { grantVersion: 'agent-skill-grant-v1' as const, tools: [], writableArtifactKinds: [],
      maxRiskTier: 'advisory' as const, maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: MAX_TOKENS, maxOutputTokens: 0 };
    const prepared = await createServerAgentSkillRuntime(catalogPort).prepareGuardedAdmission({
      requestVersion: 'agent-skill-selection-request-v1', catalogRevision: snapshot.catalogRevision,
      capabilityId: PROFILE, taskKind: 'conversation-turn', phase: 'execute', contentMode: 'nsf',
      scope: scopeDigests, grant, budgetTokens: MAX_TOKENS, maxSkills: 2,
      explicit: snapshot.headers.map(({ manifest }) => ({ skillId: manifest.skillId, version: manifest.version })),
    }, grant, {
      authorize(receipt) {
        const authorization = profiles.authorizeSelection(PROFILE, receipt);
        for (const selected of receipt.selected) sources.authorizeHeader(selected.header);
        return authorization;
      }, assertCurrent,
    });
    const authorization = createServerAgentSkillCompilerAuthorization(prepared.authorization, profiles.registryRevision, sources.authorityRevision);
    const sourceProofs = createServerAgentSkillCompilerSourceProofs(prepared.admission, sources.authorizeAdmission(prepared.admission), authorization);
    stage = 'compiler-rejected';
    const request = { admission: prepared.admission, profileAuthorization: authorization, sourceProofs,
      maxInstructionTokens: MAX_TOKENS, maxValidatorOperations: 0 };
    const artifact = compileAgentSkillPrograms(request);
    verifyCompiledAgentSkillArtifact(artifact, request);
    const slots = artifact.promptSlots.filter(slot => slot.slot === 'style');
    const styleBody = slots.length === 1 ? /^<style>\n([\s\S]*)\n<\/style>$/u.exec(slots[0]!.instruction)?.[1] : undefined;
    if (slots.length !== 1 || slots[0]!.manifestDigest !== header.manifestDigest
      || styleBody === undefined || hash(styleBody) !== STYLE_PACKAGE_SOURCE.bodyHash) fail('output-mismatch');
    stage = 'package-invalid';
    assertCurrent();

    return Object.freeze({ artifact, assertCurrent, receipt: Object.freeze({
      packageDigest: STYLE_PACKAGE_SHADOW_PIN.packageDigest, catalogRevision: snapshot.catalogRevision,
      selectionReceiptDigest: prepared.receipt.receiptDigest, admissionDigest: prepared.admission.admissionDigest,
      profilePolicyRevision: authorization.policyRevision, sourceAuthorityRevision: sources.authorityRevision,
      compilerRevision: artifact.compilerRevision, compiledArtifactDigest: artifact.compiledArtifactDigest,
      promptTokens: artifact.promptTokens,
    }) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('style-package-')) throw error;
    throw new StylePackageCompilationError(stage);
  }
}
