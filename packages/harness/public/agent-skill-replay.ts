/** @author Codex @date 2026-10-26 @version 1.0
 * Domain-neutral offline replay facade. No lifecycle mutation or promotion assertion is exported.
 */
export {
    AGENT_SKILL_REPLAY_EVIDENCE_VERSION,
    agentSkillReplayEvidenceDigest,
    parseAgentSkillReplayEvidence,
    runAgentSkillReplayComparison,
} from '../src/agent-skill-replay.ts';
export type {
    AgentSkillDomainEvaluation,
    AgentSkillDomainEvaluationRequest,
    AgentSkillDomainEvaluatorPort,
    AgentSkillReplayAggregateMetrics,
    AgentSkillReplayComparisonInput,
    AgentSkillReplayComparisonResult,
    AgentSkillReplayEvidenceV1,
    AgentSkillReplayExecutionMetrics,
    AgentSkillReplayExecutionObservation,
    AgentSkillReplayExecutionRequest,
    AgentSkillReplayExecutorPort,
    AgentSkillReplayScenario,
    AgentSkillReplayThresholds,
} from '../src/agent-skill-replay.ts';
