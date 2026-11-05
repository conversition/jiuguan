/** @author Codex @date 2026-10-17 @version 1.0
 * Shared, content-free identity for a statically validated candidate under operational replay.
 * This digest is attribution only; it is never a replay verdict or promotion authority.
 */
import { digestCanonical } from './internal.ts';
import { normalizeAgentSkillCandidate } from './lifecycle.ts';

export const SKILL_OPERATIONAL_CANDIDATE_BINDING_VERSION =
  'skill-operational-candidate-binding-v1' as const;

export interface SkillOperationalCandidateBindingV1 {
  readonly bindingVersion: typeof SKILL_OPERATIONAL_CANDIDATE_BINDING_VERSION;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly bundleDigest: string;
  readonly manifestDigest: string;
  readonly validationEvidenceDigest: string;
}

export function skillOperationalCandidateBinding(input: unknown): SkillOperationalCandidateBindingV1 {
  const candidate = normalizeAgentSkillCandidate(input);
  if (candidate.state !== 'validated' || candidate.revision !== 1
    || candidate.validationEvidenceDigest === null
    || candidate.operationalReplayEvidenceDigest !== null) {
    throw new Error('skill-operational-candidate-not-validated');
  }
  return Object.freeze({
    bindingVersion: SKILL_OPERATIONAL_CANDIDATE_BINDING_VERSION,
    candidateId: candidate.candidateId,
    candidateRevision: 1,
    bundleDigest: candidate.bundleDigest,
    manifestDigest: candidate.header.manifestDigest,
    validationEvidenceDigest: candidate.validationEvidenceDigest,
  });
}

export function skillOperationalCandidateBindingDigest(input: unknown): string {
  return digestCanonical(skillOperationalCandidateBinding(input));
}
