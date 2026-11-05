/** Compare to the exact configured live Profile baseline, never to a staging Channel. */
import { createAgentSkillBundle } from '@jiuguan/skill-hub';
import type { StoredAgentSkillCandidate } from '../agent-skill-candidate-store.ts';
import { diffSkillCandidates } from '../skill-candidate-diff.ts';
import { createServerBuiltinAgentSkillPack } from './builtin-source-pack.ts';

export async function readSkillActiveDiff(input: {
  candidateId: string; readCandidate(id: string): StoredAgentSkillCandidate | null; enabled(): boolean;
}) {
  const source = input.readCandidate(input.candidateId);
  if (!source) throw new Error('candidate-not-found');
  const base = { version: 'skill-active-diff-v1', profileId: 'learning.styleCompile',
    candidateId: input.candidateId, authorizesReplacement: false, actualInvocation: false } as const;
  if (source.bundle.header.manifest.capabilityIds.length !== 1
    || source.bundle.header.manifest.capabilityIds[0] !== base.profileId) {
    return Object.freeze({ ...base, state: 'profile-not-supported', active: null, diff: null });
  }
  if (!input.enabled()) return Object.freeze({ ...base, state: 'off', active: null, diff: null });
  const pack = createServerBuiltinAgentSkillPack();
  const catalog = await pack.catalogPort.readCatalog();
  // Keep the selection identical to live-request; no consumer or authority is fabricated here.
  const header = catalog.headers.find(entry => entry.manifest.capabilityIds[0] === base.profileId);
  if (!header || header.manifest.kind !== 'foundation') throw new Error('skill-active-baseline-unavailable');
  const body = await pack.catalogPort.loadBody({ requestVersion: 'agent-skill-body-request-v1',
    catalogRevision: catalog.catalogRevision, skillId: header.manifest.skillId, version: header.manifest.version,
    manifestDigest: header.manifestDigest, bodyHash: header.manifest.bodyHash });
  if (!input.enabled() || JSON.stringify(source) !== JSON.stringify(input.readCandidate(input.candidateId))) {
    throw new Error('skill-active-baseline-stale');
  }
  const active = Object.freeze({ kind: 'configured-foundation', skillId: header.manifest.skillId,
    version: header.manifest.version, manifestDigest: header.manifestDigest, bodyHash: header.manifest.bodyHash,
    catalogRevision: catalog.catalogRevision, requiresLiveAdmission: true });
  const compared = diffSkillCandidates({
    left: { candidateId: source.candidate.candidateId, state: source.candidate.state,
      revision: source.candidate.revision, bundle: source.bundle },
    right: { candidateId: header.manifest.skillId, state: 'configured-foundation', revision: 0,
      bundle: createAgentSkillBundle(header.manifest, body) },
  });
  return Object.freeze({ ...base, state: 'configured', active,
    candidate: { candidateId: source.candidate.candidateId, revision: source.candidate.revision,
      state: source.candidate.state, bundleDigest: source.bundle.bundleDigest },
    diff: { changes: compared.changes, truncated: compared.truncated, program: compared.program, identical: compared.identical } });
}
