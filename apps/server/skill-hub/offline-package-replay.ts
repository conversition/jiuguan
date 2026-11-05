/** Offline fixtures only. These synthetic proofs must never enter production admission. */
import { createHash } from 'node:crypto';
import {
  createAgentSkillCatalogSnapshot, materializeAgentSkillSelection, selectAgentSkillHeaders,
  type AgentSkillContentMode, type AgentSkillPackageV2,
} from '@jiuguan/skill-hub';
import type { AgentSkillCompilationRequestV1 } from '@jiuguan/prompt/agent-skill-compiler';

export function canonicalFixture(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalFixture(object[key])}`).join(',')}}`;
}
export function fixtureHash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function skillPackageReplayFixture(
  pkg: AgentSkillPackageV2,
  contentMode: AgentSkillContentMode,
  instructionTokenBudget = 8_000,
): AgentSkillCompilationRequestV1 {
  return skillPackageSetReplayFixture([pkg], contentMode, instructionTokenBudget);
}

/** Exercise the original selector/materializer for an existing base + explicit style combination. */
export function skillPackageSetReplayFixture(
  packages: readonly AgentSkillPackageV2[],
  contentMode: AgentSkillContentMode,
  instructionTokenBudget = 8_000,
): AgentSkillCompilationRequestV1 {
  if (packages.length < 1 || packages.length > 16) throw new Error('fixture needs 1..16 packages');
  if (!Number.isSafeInteger(instructionTokenBudget) || instructionTokenBudget < 1 || instructionTokenBudget > 16_000) {
    throw new RangeError('offline fixture instruction budget must be in [1, 16000]');
  }
  const manifest = packages[0]!.bundle.header.manifest;
  const catalog = createAgentSkillCatalogSnapshot(packages.map(pkg => pkg.bundle.header));
  const bodies = new Map(packages.map(pkg => [pkg.bundle.header.manifestDigest, pkg.bundle.body]));
  const grant = { grantVersion: 'agent-skill-grant-v1' as const,
    tools: [], writableArtifactKinds: [], maxRiskTier: 'advisory' as const,
    maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: instructionTokenBudget, maxOutputTokens: 0 };
  const request = { requestVersion: 'agent-skill-selection-request-v1' as const, catalogRevision: catalog.catalogRevision,
    capabilityId: manifest.capabilityIds[0]!, taskKind: manifest.taskKinds[0]!, phase: manifest.phases[0]!, contentMode,
    scope: { sessionId: 'offline-migration-fixture' }, grant, budgetTokens: instructionTokenBudget, maxSkills: packages.length,
    explicit: packages.map(pkg => ({ skillId: pkg.bundle.header.manifest.skillId, version: pkg.bundle.header.manifest.version })) };
  const receipt = selectAgentSkillHeaders(catalog.headers, request);
  const admission = materializeAgentSkillSelection(receipt, grant, ({ manifestDigest }) => {
    const body = bodies.get(manifestDigest);
    if (body === undefined) throw new Error('fixture manifest missing');
    return body;
  }, request);
  if (admission.skills.length !== packages.length) throw new Error('fixture package was not admitted');
  const core = { authorizationVersion: 'server-agent-skill-profile-authorization-v1' as const,
    profileId: 'migration.fixture', policyRevision: fixtureHash('offline-fixture-policy-v1'),
    catalogRevision: admission.catalogRevision, selectionReceiptDigest: admission.selectionReceiptDigest,
    instructionSetDigest: admission.instructionSetDigest, selectedManifestDigests: admission.skills.map(skill => skill.header.manifestDigest) };
  const profileAuthorization = { ...core, registryRevision: fixtureHash('offline-fixture-registry-v1'),
    authorityRevision: 'offline-fixture-authority-v1', authorizationDigest: fixtureHash(canonicalFixture(core)) };
  const sourceProofs = admission.skills.map(({ header }) => ({ proofVersion: 'agent-skill-source-proof-v1' as const,
    admissionDigest: admission.admissionDigest, skillId: header.manifest.skillId, version: header.manifest.version,
    manifestDigest: header.manifestDigest, bodyHash: header.manifest.bodyHash, trustClass: 'reviewed-author' as const,
    profileId: core.profileId, profileAuthorizationDigest: profileAuthorization.authorizationDigest,
    profilePolicyRevision: core.policyRevision, profileRegistryRevision: profileAuthorization.registryRevision,
    authorityRevision: profileAuthorization.authorityRevision, evidenceDigest: fixtureHash('offline-migration-fixture-only') }));
  return { admission, profileAuthorization, sourceProofs, maxInstructionTokens: instructionTokenBudget, maxValidatorOperations: 0 };
}
