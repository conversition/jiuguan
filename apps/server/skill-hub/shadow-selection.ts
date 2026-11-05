import { createHash } from 'node:crypto';
import {
  normalizeAgentSkillSelectionReceipt,
  type AgentSkillSelectionReceiptV1,
} from '@jiuguan/skill-hub';

export const AGENT_SKILL_SHADOW_OBSERVATION_VERSION = 'agent-skill-shadow-observation-v1' as const;

export interface LegacySkillMatchObservation {
  /** Exact body-free catalog identity resolved by the compatibility adapter. */
  readonly skillId: string;
  readonly version: string;
  readonly score: number;
  readonly selectionReason: string;
}

export interface AgentSkillShadowRef {
  readonly skillId: string;
  readonly version: string;
}

export interface AgentSkillShadowObservation {
  readonly observationVersion: typeof AGENT_SKILL_SHADOW_OBSERVATION_VERSION;
  readonly mode: 'observe-only';
  readonly legacySelectionDigest: string;
  readonly candidateReceiptDigest: string;
  readonly legacySelected: readonly AgentSkillShadowRef[];
  readonly candidateSelected: readonly AgentSkillShadowRef[];
  readonly missingFromCandidate: readonly AgentSkillShadowRef[];
  readonly additionalInCandidate: readonly AgentSkillShadowRef[];
  readonly exactSetMatch: boolean;
  readonly exactOrderMatch: boolean;
  readonly promotionCompatible: boolean;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/** Locale-independent UTF-16 code-unit order for reproducible parity evidence. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function key(ref: AgentSkillShadowRef): string {
  return `${ref.skillId}\u0000${ref.version}`;
}

function sortedRefs(refs: readonly AgentSkillShadowRef[]): readonly AgentSkillShadowRef[] {
  return Object.freeze([...refs].sort((left, right) => (
    compareText(left.skillId, right.skillId) || compareText(left.version, right.version)
  )).map((item) => Object.freeze({ ...item })));
}

function frozenRefs(refs: readonly AgentSkillShadowRef[]): readonly AgentSkillShadowRef[] {
  return Object.freeze(refs.map((item) => Object.freeze({ ...item })));
}

/**
 * Produces a body-free parity receipt. It cannot affect either selector and is safe for shadow telemetry.
 * Query text, prompts and Skill bodies are intentionally absent from both input and output.
 */
export function observeAgentSkillSelection(
  legacyMatches: readonly LegacySkillMatchObservation[],
  candidateReceiptInput: AgentSkillSelectionReceiptV1,
): AgentSkillShadowObservation {
  if (!Array.isArray(legacyMatches) || legacyMatches.length > 64) {
    throw new TypeError('legacy Skill observations must contain at most 64 items');
  }
  const receipt = normalizeAgentSkillSelectionReceipt(candidateReceiptInput);
  const legacySelected = frozenRefs(legacyMatches.map((match) => {
    if (typeof match.skillId !== 'string' || match.skillId.length < 1 || match.skillId.length > 240
      || typeof match.version !== 'string' || match.version.length < 1 || match.version.length > 80
      || !Number.isFinite(match.score) || match.score < 0 || match.score > 1
      || typeof match.selectionReason !== 'string' || match.selectionReason.length > 80) {
      throw new TypeError('legacy Skill observation is invalid');
    }
    return {
      skillId: match.skillId,
      version: match.version,
    };
  }));
  const candidateSelected = frozenRefs(receipt.selected.map(({ header }) => ({
    skillId: header.manifest.skillId,
    version: header.manifest.version,
  })));
  const legacyKeys = new Set(legacySelected.map(key));
  const candidateKeys = new Set(candidateSelected.map(key));
  const missingFromCandidate = sortedRefs(legacySelected.filter((item) => !candidateKeys.has(key(item))));
  const additionalInCandidate = sortedRefs(candidateSelected.filter((item) => !legacyKeys.has(key(item))));
  const exactSetMatch = missingFromCandidate.length === 0 && additionalInCandidate.length === 0;
  const exactOrderMatch = legacySelected.length === candidateSelected.length
    && legacySelected.every((item, index) => key(item) === key(candidateSelected[index]!));
  return Object.freeze({
    observationVersion: AGENT_SKILL_SHADOW_OBSERVATION_VERSION,
    mode: 'observe-only',
    legacySelectionDigest: digest(legacySelected),
    candidateReceiptDigest: receipt.receiptDigest,
    legacySelected,
    candidateSelected,
    missingFromCandidate,
    additionalInCandidate,
    exactSetMatch,
    exactOrderMatch,
    promotionCompatible: exactSetMatch && exactOrderMatch,
  });
}
