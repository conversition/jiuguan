/** Size-only upper bound for existing foreground foundation receipts; never dispatches or stores a packet. */
import type { AgentSkillClosureAttributionV1 } from '../../../packages/agent-closure/index.ts';
import type { AgentSkillConsumptionOutboxPayloadV1, AgentSkillConsumptionEvidenceBindingV1 }
  from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';

export interface ForegroundSourcePacketWidths {
  readonly digest: string;
  readonly timestamp: string;
  readonly count: number;
  readonly attribution: AgentSkillClosureAttributionV1;
}

/** Closed foreground consumers select one foundation and no Candidate; callers recheck those bounds on success. */
export function assertForegroundSourcePacketSize(runId: string,
  build: (widths: ForegroundSourcePacketWidths) => AgentSkillConsumptionOutboxPayloadV1, errorCode: string): void {
  const digest = `sha256:${'0'.repeat(64)}`;
  const timestamp = new Date(8_640_000_000_000_000).toISOString();
  const attribution: AgentSkillClosureAttributionV1 = {
    attributionVersion: 'agent-skill-attribution-v1', instructionSetDigest: digest,
    selectionReceiptDigest: digest, compiledArtifactDigest: digest,
    compiledInstructionSetDigest: digest, validatorPlanDigest: digest,
    selectedManifestDigests: [digest], activeCandidateDigests: [], validatorOutcome: 'not-required',
  };
  const evidenceBinding: AgentSkillConsumptionEvidenceBindingV1 = {
    bindingVersion: 'agent-skill-consumption-binding-v1',
    identity: { sessionId: 'x'.repeat(240), cardId: 'x'.repeat(240), contentMode: 'nsfw' },
    consumer: { runId, round: Number.MAX_SAFE_INTEGER, assistantMessageId: Number.MAX_SAFE_INTEGER,
      assistantDigest: digest, historyEpoch: Number.MAX_SAFE_INTEGER }, committedAt: timestamp,
  };
  const payload = build({ digest, timestamp, count: Number.MAX_SAFE_INTEGER, attribution });
  if (JSON.stringify({ ...payload, evidenceBinding }).length > 32_768) throw new Error(errorCode);
}
