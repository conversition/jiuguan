/** Read the current committed Session run and its exact interactive Closure receipts. */
import type { TurnOutcomeMarker } from '../../packages/memory/public/turn-outcome.ts';
import type { AgentClosureRecord } from './agent-closure-store.ts';
import { canonicalAgentClosureCapability } from '../../packages/agent-closure/index.ts';
import { aqlReplanClosureOperationId, interactiveClosureOperationId, contextCompilerClosureOperationId,
  directionClosureOperationId, maintenanceClosureOperationId, MAINTENANCE_CAPABILITY } from './agent-closure-recorder.ts';
import { MAINTENANCE_TASK_KINDS } from './maintenance-types.ts';
import type { StyleCompileIntentEntry } from '../../packages/memory/public/style-compile-intent-outbox.ts';
import { readTurnStyleJob } from './turn-style-job-status.ts';

const CAPABILITIES = ['interactive.prelude', 'interactive.variableProposal', 'interactive.critic', 'interactive.aqlReplan'] as const;
const LEARNING = ['learning.preference', 'learning.branchPreference'] as const;
type Capability = typeof CAPABILITIES[number];
type SessionPort = Readonly<{
  currentVerifiedTurnOutcome(): TurnOutcomeMarker | null;
  getActiveTurnState(): { active: boolean };
  readStyleCompileIntent(runId: string): StyleCompileIntentEntry | null;
  getHistoryEpoch(): number;
}>;
export function readCurrentTurnAgentEvidence(input: {
  sessionId: string; session: SessionPort;
  closure: { get(operationId: string): AgentClosureRecord | null | undefined;
    listContextForRun(sessionId: string, runId: string): readonly AgentClosureRecord[];
    listMaintenanceForParentRun(sessionId: string, parentRunId: string): readonly AgentClosureRecord[];
    listLearningForConsumerRun(sessionId: string, runId: string): readonly AgentClosureRecord[] };
  styleJobs: Parameters<typeof readTurnStyleJob>[2];
  allowed(): boolean;
}) {
  const check = () => { if (!input.allowed()) throw new Error('turn-agent-evidence-unavailable'); };
  check();
  const active = input.session.getActiveTurnState();
  if (active.active) {
    check();
    if (JSON.stringify(input.session.getActiveTurnState()) !== JSON.stringify(active)) throw new Error('turn-agent-evidence-stale');
    return Object.freeze({ state: 'active' as const });
  }
  const marker = input.session.currentVerifiedTurnOutcome();
  if (!marker) {
    check();
    if (input.session.getActiveTurnState().active || input.session.currentVerifiedTurnOutcome() !== null) {
      throw new Error('turn-agent-evidence-stale');
    }
    check(); return Object.freeze({ state: 'unknown' as const });
  }
  if (marker.sessionId !== input.sessionId) throw new Error('turn-agent-evidence-unavailable');
  const read = () => {
    const interactive = CAPABILITIES.map((capability: Capability) => {
      const operationId = capability === 'interactive.aqlReplan' ? aqlReplanClosureOperationId(marker.runId)
        : interactiveClosureOperationId(marker.runId, capability);
      const record = input.closure.get(operationId);
      if (record && (record.operationId !== operationId || record.runId !== marker.runId
        || record.sessionId !== marker.sessionId || record.capability !== capability || record.lane !== 'interactive')) {
        throw new Error('turn-agent-evidence-unavailable');
      }
      return record;
    });
    const contexts = input.closure.listContextForRun(marker.sessionId, marker.runId);
    if (!Array.isArray(contexts) || contexts.length > 256) throw new Error('turn-agent-evidence-unavailable');
    for (const record of contexts) {
      if (record.sessionId !== marker.sessionId || record.runId !== marker.runId || record.capability !== 'context.compiler'
        || record.lane !== 'interactive' || record.kind !== 'advisory' || !record.evidenceDigest
        || record.operationId !== contextCompilerClosureOperationId({ runId: marker.runId, sourceDigest: record.evidenceDigest })) {
        throw new Error('turn-agent-evidence-unavailable');
      }
    }
    const learning = LEARNING.map(capability => {
      const operationId = directionClosureOperationId(marker.runId, capability);
      const record = input.closure.get(operationId);
      if (record && (record.operationId !== operationId || record.sessionId !== marker.sessionId
        || record.runId !== marker.runId || record.capability !== capability || record.lane !== 'learning' || record.kind !== 'proposal')) {
        throw new Error('turn-agent-evidence-unavailable');
      }
      return record;
    });
    const maintenance = input.closure.listMaintenanceForParentRun(marker.sessionId, marker.runId);
    if (!Array.isArray(maintenance) || maintenance.length > 256) throw new Error('turn-agent-evidence-unavailable');
    for (const record of maintenance) {
      const matched = MAINTENANCE_TASK_KINDS.some(taskKind => MAINTENANCE_CAPABILITY[taskKind] === canonicalAgentClosureCapability(record.capability)
        && maintenanceClosureOperationId({ runId: record.runId, taskKind }) === record.operationId);
      if (record.sessionId !== marker.sessionId || record.parentRunId !== marker.runId || record.lane !== 'maintenance'
        || record.kind !== 'proposal' || !matched) throw new Error('turn-agent-evidence-unavailable');
    }
    const consumedLearning = input.closure.listLearningForConsumerRun(marker.sessionId, marker.runId);
    if (!Array.isArray(consumedLearning) || consumedLearning.length > 256) throw new Error('turn-agent-evidence-unavailable');
    for (const record of consumedLearning) {
      if (record.sessionId !== marker.sessionId || record.lane !== 'learning' || record.kind !== 'proposal'
        || !LEARNING.some(capability => capability === record.capability
          && directionClosureOperationId(record.runId, capability) === record.operationId)) {
        throw new Error('turn-agent-evidence-unavailable');
      }
    }
    const styleIntent = input.session.readStyleCompileIntent(marker.runId);
    const historyEpoch = input.session.getHistoryEpoch();
    const styleCompile = readTurnStyleJob(marker, styleIntent, input.styleJobs, historyEpoch);
    return { interactive, contexts: contexts as readonly AgentClosureRecord[], learning, consumedLearning, styleIntent, styleCompile, historyEpoch,
      maintenance: maintenance as readonly AgentClosureRecord[] };
  };
  const first = read();
  check();
  const again = input.session.currentVerifiedTurnOutcome();
  if (input.session.getActiveTurnState().active || JSON.stringify(again) !== JSON.stringify(marker)
    || JSON.stringify(read()) !== JSON.stringify(first)) throw new Error('turn-agent-evidence-stale');
  if (input.session.getActiveTurnState().active || JSON.stringify(input.session.currentVerifiedTurnOutcome()) !== JSON.stringify(marker)) {
    throw new Error('turn-agent-evidence-stale');
  }
  check();
  const project = (capability: string, record: AgentClosureRecord | null | undefined) => {
    const lineage = record?.events.find(event => event.type === (record.kind === 'proposal' ? 'readback-verified' : 'artifact-validated'));
    const completed = record?.events.find(event => event.type === 'execution-completed');
    return Object.freeze({ capability,
      execution: completed?.reasonCode === 'cache-hit' && capability === 'context.compiler' ? 'cached' as const
        : completed ? 'recorded' as const : 'unknown' as const,
      executionClass: record?.executionClass ?? null,
      validated: record?.events.some(event => event.type === 'artifact-validated') ?? false,
      consumed: Boolean(lineage?.artifactDigest && record?.events.some(event => event.type === 'context-consumed'
        && event.consumerRunId === marker.runId && event.artifactDigest === lineage.artifactDigest
        && event.sourceRevision === record.sourceRevision && event.occurredAt >= lineage.occurredAt)) });
  };
  return Object.freeze({ state: 'verified' as const, round: marker.round,
    capabilities: Object.freeze([...CAPABILITIES.map((capability, index) => ({ capability, record: first.interactive[index] })),
      ...(first.contexts.length ? first.contexts.map(record => ({ capability: 'context.compiler' as const, record }))
        : [{ capability: 'context.compiler' as const, record: undefined }])].map(({ capability, record }) => project(capability, record))),
    learning: Object.freeze(LEARNING.map((capability, index) => project(capability, first.learning[index]))),
    learningConsumption: Object.freeze(first.consumedLearning.map(record => {
      const projected = project(record.capability, record);
      if (!projected.consumed) throw new Error('turn-agent-evidence-unavailable');
      return Object.freeze({ capability: record.capability, executionClass: record.executionClass,
        origin: record.runId === marker.runId ? 'current' as const : 'prior' as const });
    })),
    styleCompile: first.styleCompile,
    maintenance: Object.freeze(first.maintenance.map(record => Object.freeze({ ...project(canonicalAgentClosureCapability(record.capability), record), status: record.status }))) });
}
