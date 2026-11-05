/** @author Codex @date 2026-10-19 @version 1.0
 * Host composition for one real Skill Sample suite and its pre-frozen Candidate arm ledger.
 * It creates no Quality verdict or promotion authority.
 */
import type { AgentSkillValidatorPlanEntryV1 } from '@jiuguan/prompt/agent-skill-compiler';
import {
  normalizeAgentSkillCandidate,
  SKILL_OPERATIONAL_CANDIDATE_BINDING_VERSION,
  skillOperationalCandidateBindingDigest,
} from '@jiuguan/skill-hub';
import {
  agentBudgetProfileDigest,
  normalizeAgentBudgetProfile,
} from '../../../packages/agent-policy/public/budget-profile.ts';
import {
  CandidateEvaluationBatchStore,
  candidateEvaluationBatchId,
  type CandidateEvaluationBatchCreateInput,
  type CandidateEvaluationBatchSourceV1,
  type CandidateEvaluationStoredBatch,
} from '../candidate-evaluation-batch-store.ts';
import {
  evalCanonical,
  evalDigest,
  evalFreeze,
} from '../skill-evaluate-data.ts';
import type { SkillEvaluatePlan } from '../skill-evaluate-registry.ts';
import type { SkillSampleDispatchSidecarFactory } from '../skill-sample-model.ts';
import {
  assertCurrentSkillSampleExecutionPlan,
  createSkillSampleSuitePlans,
  SKILL_SAMPLE_SUITE_PLAN_VERSION,
  type SkillSampleSuitePlan,
} from '../skill-sample-registry.ts';
import { skillSampleSuiteChildJobId } from '../skill-sample-store.ts';
import { CandidateEvaluationBatchRuntime } from './candidate-evaluation-batch-runtime.ts';
import { createCandidateEvaluationSampleDispatchFactory } from './candidate-evaluation-sample-dispatch.ts';
import {
  CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
  CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID,
  CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID,
  CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME,
  createCandidateEvaluationValidatorAuthority,
} from './candidate-evaluation-validator.ts';

export const CANDIDATE_EVALUATION_SAMPLE_HOST_VERSION =
  'candidate-evaluation-sample-host-v1' as const;

const VALIDATOR_MANIFEST_DIGEST = evalDigest({
  manifestVersion: 'candidate-evaluation-host-validator-manifest-v1',
  evaluatorId: CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID,
  checkId: CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID,
  forcedToolName: CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME,
  validatorPolicyDigest: CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
});
const VALIDATOR_ENTRY_CORE = evalFreeze({
  skillId: 'host.validator.candidate-sample-envelope',
  version: '1.0.0',
  manifestDigest: VALIDATOR_MANIFEST_DIGEST,
  evaluatorId: CANDIDATE_SAMPLE_ENVELOPE_EVALUATOR_ID,
  checkId: CANDIDATE_SAMPLE_ENVELOPE_CHECK_ID,
  severityId: 'error',
});
export const CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN:
readonly AgentSkillValidatorPlanEntryV1[] = evalFreeze([
  { ...VALIDATOR_ENTRY_CORE, entryDigest: evalDigest(VALIDATOR_ENTRY_CORE) },
]);
export const CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN_DIGEST =
  evalDigest(CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN);

export interface CandidateEvaluationSampleCurrentSource {
  readonly evaluatePlan: SkillEvaluatePlan;
  readonly modelId: string;
  readonly modelBindingDigest: string;
  readonly budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
}

export interface CandidateEvaluationSampleHostResolveInput {
  readonly jobId: string;
  readonly plan: unknown;
  readonly modelId: string;
  readonly modelBindingDigest: string;
}

export interface CandidateEvaluationSampleHostOptions {
  readonly dataDir: string;
  resolveCurrent(compileJobId: string): CandidateEvaluationSampleCurrentSource | null;
  readonly now?: () => string;
  readonly isSessionDeleted?: (rawSessionId: string) => boolean;
}

type BatchEntry = {
  readonly source: CandidateEvaluationBatchSourceV1;
  readonly store: CandidateEvaluationBatchStore;
  readonly runtime: CandidateEvaluationBatchRuntime;
  readonly factory: SkillSampleDispatchSidecarFactory;
};

function suitePlansFromPlan(plan: SkillSampleSuitePlan): readonly SkillSampleSuitePlan[] {
  return createSkillSampleSuitePlans(plan.source, {
    suiteId: plan.suite.suiteId,
    perPairBudgetDigest: plan.suite.perPairBudgetDigest,
    perPairInputTokens: plan.suite.perPairInputTokens,
    perPairOutputTokens: plan.suite.perPairOutputTokens,
    perPairMaxCostMicrousd: plan.suite.perPairMaxCostMicrousd,
  });
}

function suitePlansFromCurrent(
  current: CandidateEvaluationSampleCurrentSource,
  suiteId: string,
): readonly SkillSampleSuitePlan[] {
  const budget = normalizeAgentBudgetProfile(current.budgetProfile);
  if (budget.lane !== 'style' || budget.maxModelCalls !== 2 || budget.maxSteps !== 2
    || budget.maxToolCalls !== 0 || budget.maxWrites !== 0) {
    throw new Error('candidate-evaluation-sample-host-budget-invalid');
  }
  return createSkillSampleSuitePlans(current.evaluatePlan, {
    suiteId,
    perPairBudgetDigest: agentBudgetProfileDigest(budget),
    perPairInputTokens: budget.agentInputBudgetTokens,
    perPairOutputTokens: budget.agentOutputBudgetTokens,
    perPairMaxCostMicrousd: budget.maxCostMicrousd,
  });
}

function batchSource(
  plans: readonly SkillSampleSuitePlan[],
  modelId: string,
  modelBindingDigest: string,
): CandidateEvaluationBatchCreateInput {
  const first = plans[0];
  if (!first) throw new Error('candidate-evaluation-sample-host-suite-empty');
  const candidateBindingDigest = skillOperationalCandidateBindingDigest(first.source.candidate);
  const sourceAuthorityRevision = candidateEvaluationSampleSourceAuthorityRevision({
    compileJobId: first.source.compilePacket.jobId,
    sampleSuiteId: first.suite.suiteId,
    candidateBindingDigest,
    compiledArtifactDigest: first.source.compilePacket.packetDigest,
    sampleSuiteDigest: first.suite.manifestDigest,
    modelId,
    modelBindingDigest,
    perPairBudgetDigest: first.suite.perPairBudgetDigest,
  });
  return evalFreeze({
    rawSessionId: first.source.compilePacket.rawSessionId,
    compileJobId: first.source.compilePacket.jobId,
    sampleSuiteId: first.suite.suiteId,
    candidateId: first.source.candidate.candidateId,
    candidateRevision: 1 as const,
    candidateBindingDigest,
    sourceAuthorityRevision,
    compiledArtifactDigest: first.source.compilePacket.packetDigest,
    sampleSuiteDigest: first.suite.manifestDigest,
    validatorPolicyDigest: CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
    validatorPlanDigest: CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN_DIGEST,
    samples: plans.map((plan) => evalFreeze({
      scenarioOrdinal: plan.suite.scenarioOrdinal,
      repeatIndex: plan.suite.repeatIndex,
      planDigest: plan.planDigest,
      sampleKey: skillSampleSuiteChildJobId(
        plan.suite.suiteId,
        plan.suite.scenarioOrdinal,
        plan.suite.repeatIndex,
      ),
    })),
  });
}

export function candidateEvaluationSampleSourceAuthorityRevision(input: Readonly<{
  compileJobId: string;
  sampleSuiteId: string;
  candidateBindingDigest: string;
  compiledArtifactDigest: string;
  sampleSuiteDigest: string;
  modelId: string;
  modelBindingDigest: string;
  perPairBudgetDigest: string;
}>): string {
  return evalDigest({
    authorityVersion: CANDIDATE_EVALUATION_SAMPLE_HOST_VERSION,
    compileJobId: input.compileJobId,
    sampleSuiteId: input.sampleSuiteId,
    candidateBindingDigest: input.candidateBindingDigest,
    compiledArtifactDigest: input.compiledArtifactDigest,
    sampleSuiteDigest: input.sampleSuiteDigest,
    modelId: input.modelId,
    modelBindingDigest: input.modelBindingDigest,
    perPairBudgetDigest: input.perPairBudgetDigest,
    validatorPlanDigest: CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN_DIGEST,
  });
}

/**
 * Completed-batch read currentness is deliberately different from dispatch currentness.
 * Adoption advances the live lifecycle record to rev2 without changing the immutable
 * candidate/source identity that the rev1 Batch evaluated. Reconstruct that rev1 projection
 * from immutable candidate fields, while still rechecking model/budget authority.
 */
export function candidateEvaluationCompletedSourceIdentityCurrent(input: Readonly<{
  source: CandidateEvaluationBatchSourceV1;
  /** Recomputed from the durable compileJobId via the current Compile Store. */
  currentCompileSource: CandidateEvaluationBatchSourceV1 | null;
  candidate: unknown;
  modelId: string;
  modelBindingDigest: string;
  budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
}>): boolean {
  try {
    const budget = normalizeAgentBudgetProfile(input.budgetProfile);
    const source = input.source;
    if (source.compileJobId === null || source.sampleSuiteId === null
      || input.currentCompileSource === null
      || evalCanonical(input.currentCompileSource) !== evalCanonical(source)) return false;
    const candidate = normalizeAgentSkillCandidate(input.candidate);
    if (source.candidateRevision !== 1
      || candidate.candidateId !== source.candidateId
      || candidate.validationEvidenceDigest === null
      || source.validatorPolicyDigest !== CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST
      || source.validatorPlanDigest !== CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN_DIGEST) {
      return false;
    }
    const immutableBindingDigest = evalDigest({
      bindingVersion: SKILL_OPERATIONAL_CANDIDATE_BINDING_VERSION,
      candidateId: candidate.candidateId,
      candidateRevision: 1,
      bundleDigest: candidate.bundleDigest,
      manifestDigest: candidate.header.manifestDigest,
      validationEvidenceDigest: candidate.validationEvidenceDigest,
    });
    return immutableBindingDigest === source.candidateBindingDigest
      && candidateEvaluationSampleSourceAuthorityRevision({
        compileJobId: source.compileJobId,
        sampleSuiteId: source.sampleSuiteId,
        candidateBindingDigest: source.candidateBindingDigest,
        compiledArtifactDigest: source.compiledArtifactDigest,
        sampleSuiteDigest: source.sampleSuiteDigest,
        modelId: input.modelId,
        modelBindingDigest: input.modelBindingDigest,
        perPairBudgetDigest: agentBudgetProfileDigest(budget),
      }) === source.sourceAuthorityRevision;
  } catch { return false; }
}

/** Rebuild the exact durable Batch source from the current Compile Store snapshot. */
export function candidateEvaluationSampleSourceFromCurrent(input: Readonly<{
  evaluatePlan: SkillEvaluatePlan;
  sampleSuiteId: string;
  modelId: string;
  modelBindingDigest: string;
  budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
}>): CandidateEvaluationBatchCreateInput {
  const current: CandidateEvaluationSampleCurrentSource = {
    evaluatePlan: input.evaluatePlan,
    modelId: input.modelId,
    modelBindingDigest: input.modelBindingDigest,
    budgetProfile: input.budgetProfile,
  };
  return batchSource(
    suitePlansFromCurrent(current, input.sampleSuiteId),
    input.modelId,
    input.modelBindingDigest,
  );
}

/** Lazy: no Candidate DB is created until a V2 Sample child actually asks to dispatch. */
export class CandidateEvaluationSampleHost {
  readonly #options: CandidateEvaluationSampleHostOptions;
  readonly #entries = new Map<string, BatchEntry>();
  #closed = false;

  constructor(options: CandidateEvaluationSampleHostOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0
      || typeof options.resolveCurrent !== 'function'
      || options.now !== undefined && typeof options.now !== 'function'
      || options.isSessionDeleted !== undefined && typeof options.isSessionDeleted !== 'function') {
      throw new Error('candidate-evaluation-sample-host-options-invalid');
    }
    this.#options = options;
  }

  resolve(input: CandidateEvaluationSampleHostResolveInput): SkillSampleDispatchSidecarFactory {
    if (this.#closed) throw new Error('candidate-evaluation-sample-host-closed');
    const plan = assertCurrentSkillSampleExecutionPlan(input.plan);
    if (plan.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION
      || input.jobId !== skillSampleSuiteChildJobId(
        plan.suite.suiteId,
        plan.suite.scenarioOrdinal,
        plan.suite.repeatIndex,
      )) throw new Error('candidate-evaluation-sample-host-input-invalid');
    const plans = suitePlansFromPlan(plan);
    const source = batchSource(plans, input.modelId, input.modelBindingDigest);
    const batchId = candidateEvaluationBatchId(source);
    const retained = this.#entries.get(batchId);
    if (retained) {
      if (evalCanonical(retained.source) !== evalCanonical(source)) {
        throw new Error('candidate-evaluation-sample-host-source-conflict');
      }
      return retained.factory;
    }

    const current = (): boolean => {
      if (this.#closed) return false;
      try {
        const resolved = this.#options.resolveCurrent(plan.source.compilePacket.jobId);
        if (!resolved) return false;
        const expected = batchSource(
          suitePlansFromCurrent(resolved, plan.suite.suiteId),
          resolved.modelId,
          resolved.modelBindingDigest,
        );
        return evalCanonical(expected) === evalCanonical(source);
      } catch { return false; }
    };
    let store: CandidateEvaluationBatchStore | null = null;
    try {
      store = new CandidateEvaluationBatchStore({
        dataDir: this.#options.dataDir,
        now: this.#options.now,
        isSessionDeleted: this.#options.isSessionDeleted,
        sourceCurrent: (stored) => evalCanonical(stored) === evalCanonical(source) && current(),
      });
      const stored = store.createBatch(source, `candidate-evaluation:${batchId}`);
      const authority = createCandidateEvaluationValidatorAuthority({
        expectedCandidate: {
          candidateId: source.candidateId,
          candidateRevision: 1,
          candidateBindingDigest: source.candidateBindingDigest,
          sourceAuthorityRevision: source.sourceAuthorityRevision,
        },
        expectedValidatorPlanDigest: source.validatorPlanDigest,
        isCurrent: current,
      });
      const runtime = new CandidateEvaluationBatchRuntime({
        store,
        authority,
        now: this.#options.now,
      });
      runtime.recoverUncertain();
      const factory = createCandidateEvaluationSampleDispatchFactory({
        runtime,
        batchId: stored.batch.batchId,
        validatorPlan: CANDIDATE_EVALUATION_SAMPLE_VALIDATOR_PLAN,
        isCurrent: current,
      });
      this.#entries.set(batchId, { source, store, runtime, factory });
      return factory;
    } catch (error) {
      try { store?.close(); } catch { /* Preserve the original composition failure. */ }
      throw error;
    }
  }

  batchIdFor(input: CandidateEvaluationSampleHostResolveInput): string {
    const plan = assertCurrentSkillSampleExecutionPlan(input.plan);
    if (plan.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION) {
      throw new Error('candidate-evaluation-sample-host-input-invalid');
    }
    return candidateEvaluationBatchId(batchSource(
      suitePlansFromPlan(plan), input.modelId, input.modelBindingDigest,
    ));
  }

  readBatch(batchId: string): CandidateEvaluationStoredBatch | null {
    if (this.#closed) throw new Error('candidate-evaluation-sample-host-closed');
    return this.#entries.get(batchId)?.store.readBatch(batchId) ?? null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#entries.values()) entry.runtime.close();
    this.#entries.clear();
  }
}
