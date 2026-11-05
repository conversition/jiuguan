/** @author Codex @date 2026-10-17 @version 1.0
 * Required pre-dispatch Candidate reservation for the same two Skill Sample Provider calls.
 * This bridge creates no joined, quality, promotion, publication, or Provider-identity proof.
 */
import { types as nodeTypes } from 'node:util';
import type { AgentSkillValidatorPlanEntryV1 } from '@jiuguan/prompt/agent-skill-compiler';
import type { ChatRequest, ChatResponse } from '../../../packages/proxy/public/client.ts';
import type {
  AdmittedModelPreparedRequestTerminal,
} from '../admitted-model-gateway.ts';
import type {
  SkillSampleDispatchArmContext,
  SkillSampleDispatchContext,
  SkillSampleDispatchSidecar,
  SkillSampleDispatchSidecarFactory,
} from '../skill-sample-model.ts';
import { evalFreeze, evalRawDigest, evalSnapshot } from '../skill-evaluate-data.ts';
import {
  SKILL_SAMPLE_SUITE_REPEAT_COUNT,
  SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
} from '../skill-sample-registry.ts';
import {
  CandidateEvaluationBatchRuntime,
  isCandidateEvaluationBatchRuntime,
  type CandidateEvaluationBatchRuntimeHandle,
  type CandidateEvaluationBatchRuntimeResult,
} from './candidate-evaluation-batch-runtime.ts';
import type { CandidateEvaluationFailure } from './candidate-evaluation-validator.ts';

export const CANDIDATE_EVALUATION_SAMPLE_DISPATCH_VERSION =
  'candidate-evaluation-sample-dispatch-v1' as const;

export const CANDIDATE_EVALUATION_SAMPLE_DISPATCH_ERROR_CODES = Object.freeze([
  'candidate-evaluation-sample-dispatch-input-invalid',
  'candidate-evaluation-sample-dispatch-runtime-invalid',
  'candidate-evaluation-sample-dispatch-context-invalid',
  'candidate-evaluation-sample-dispatch-coordinate-unavailable',
  'candidate-evaluation-sample-dispatch-authority-denied',
  'candidate-evaluation-sample-dispatch-terminal-unconfirmed',
] as const);
export type CandidateEvaluationSampleDispatchErrorCode =
  typeof CANDIDATE_EVALUATION_SAMPLE_DISPATCH_ERROR_CODES[number];

export class CandidateEvaluationSampleDispatchError extends Error {
  constructor(readonly code: CandidateEvaluationSampleDispatchErrorCode) {
    if (!(CANDIDATE_EVALUATION_SAMPLE_DISPATCH_ERROR_CODES as readonly unknown[]).includes(code)) {
      throw new Error('candidate-evaluation-sample-dispatch-error-code-invalid');
    }
    super(code);
    this.name = 'CandidateEvaluationSampleDispatchError';
  }
}

type ArmState = {
  readonly expected: SkillSampleDispatchArmContext;
  handle: CandidateEvaluationBatchRuntimeHandle | null;
  result: CandidateEvaluationBatchRuntimeResult | null;
  observedResponse: ChatResponse | null;
  phase: 'idle' | 'prepared' | 'dispatching' | 'settled' | 'uncertain';
};
const FACTORIES = new WeakSet<Function>();
const SIDECARS = new WeakSet<object>();

function reject(code: CandidateEvaluationSampleDispatchErrorCode): never {
  throw new CandidateEvaluationSampleDispatchError(code);
}

function fixedRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    reject('candidate-evaluation-sample-dispatch-input-invalid');
  }
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !actual.includes(key))) {
    reject('candidate-evaluation-sample-dispatch-input-invalid');
  }
  return input as Record<string, unknown>;
}

function validateContext(input: SkillSampleDispatchContext): void {
  if (input.contextVersion !== 'skill-sample-dispatch-context-v1'
    || input.sampleKey !== input.jobId
    || !Number.isSafeInteger(input.scenarioOrdinal) || input.scenarioOrdinal < 0
    || input.scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
    || !Number.isSafeInteger(input.repeatIndex) || input.repeatIndex < 0
    || input.repeatIndex >= SKILL_SAMPLE_SUITE_REPEAT_COUNT
    || !Array.isArray(input.arms) || nodeTypes.isProxy(input.arms) || input.arms.length !== 2
    || input.arms[0]?.variant !== 'baseline' || input.arms[1]?.variant !== 'candidate') {
    reject('candidate-evaluation-sample-dispatch-context-invalid');
  }
}

function failureFor(terminal: AdmittedModelPreparedRequestTerminal | undefined):
CandidateEvaluationFailure | null {
  if (terminal === undefined) return null;
  switch (terminal) {
    case 'gateway-wall-budget-exhausted':
    case 'provider-timeout':
      return 'timeout';
    case 'gateway-model-required':
    case 'gateway-tools-invalid':
    case 'gateway-budget-lane-mismatch':
    case 'gateway-output-budget-invalid':
    case 'gateway-cost-estimator-unavailable':
    case 'gateway-model-binding-mismatch':
    case 'gateway-toolset-binding-mismatch':
    case 'gateway-concurrent-call':
    case 'gateway-lease-closed':
    case 'gateway-model-call-budget-exhausted':
    case 'gateway-input-budget-exhausted':
    case 'gateway-request-window-exceeded':
    case 'gateway-output-budget-exhausted':
    case 'gateway-cost-budget-exhausted':
    case 'gateway-provider-call-cancelled':
    case 'gateway-lease-audit-failed':
    case 'gateway-dispatch-authority-denied':
    case 'gateway-request-completion-failed':
      return 'cancelled';
    case 'gateway-provider-usage-unavailable':
    case 'gateway-provider-usage-invalid':
    case 'gateway-provider-call-failed':
    case 'provider-not-configured':
    case 'provider-authentication-failed':
    case 'provider-request-invalid':
    case 'provider-rate-limited':
    case 'provider-upstream-unavailable':
    case 'provider-transport-failed':
    case 'provider-stream-failed':
    case 'provider-stream-incomplete':
    case 'provider-disposed':
    case 'provider-failed':
      return 'provider-error';
    default: {
      const exhaustive: never = terminal;
      return exhaustive;
    }
  }
}

function requestFor(expected: SkillSampleDispatchArmContext, request: ChatRequest): void {
  if (evalRawDigest(JSON.stringify(request)) !== expected.requestDigest) {
    reject('candidate-evaluation-sample-dispatch-context-invalid');
  }
}

export function createCandidateEvaluationSampleDispatchFactory(input: Readonly<{
  runtime: CandidateEvaluationBatchRuntime;
  batchId: string;
  validatorPlan: readonly AgentSkillValidatorPlanEntryV1[];
  isCurrent: () => boolean;
}>): SkillSampleDispatchSidecarFactory {
  const value = fixedRecord(input, ['runtime', 'batchId', 'validatorPlan', 'isCurrent']);
  if (!isCandidateEvaluationBatchRuntime(value.runtime)) {
    reject('candidate-evaluation-sample-dispatch-runtime-invalid');
  }
  if (typeof value.batchId !== 'string' || typeof value.isCurrent !== 'function'
    || !Array.isArray(value.validatorPlan) || nodeTypes.isProxy(value.validatorPlan)) {
    reject('candidate-evaluation-sample-dispatch-input-invalid');
  }
  const runtime = value.runtime;
  const batchId = value.batchId;
  const validatorPlan = evalFreeze(evalSnapshot(value.validatorPlan)) as AgentSkillValidatorPlanEntryV1[];
  const isCurrent = value.isCurrent as () => boolean;
  const claimNext = (claimInput: Parameters<CandidateEvaluationBatchRuntime['claimNext']>[0]) =>
    CandidateEvaluationBatchRuntime.prototype.claimNext.call(runtime, claimInput);
  const ownsClaim = (handle: CandidateEvaluationBatchRuntimeHandle): boolean =>
    CandidateEvaluationBatchRuntime.prototype.ownsClaim.call(runtime, handle);
  const succeeded = (handle: CandidateEvaluationBatchRuntimeHandle,
    response: Parameters<CandidateEvaluationBatchRuntime['succeeded']>[1]) =>
    CandidateEvaluationBatchRuntime.prototype.succeeded.call(runtime, handle, response);
  const terminalize = (handle: CandidateEvaluationBatchRuntimeHandle,
    failure: CandidateEvaluationFailure) =>
    CandidateEvaluationBatchRuntime.prototype.terminalize.call(runtime, handle, failure);
  const terminalResponseDigest = (handle: CandidateEvaluationBatchRuntimeHandle) =>
    CandidateEvaluationBatchRuntime.prototype.terminalResponseDigest.call(runtime, handle);

  const factory: SkillSampleDispatchSidecarFactory = (context): SkillSampleDispatchSidecar => {
    validateContext(context);
    const states: readonly [ArmState, ArmState] = [
      { expected: context.arms[0], handle: null, result: null, observedResponse: null, phase: 'idle' },
      { expected: context.arms[1], handle: null, result: null, observedResponse: null, phase: 'idle' },
    ];

    const current = (): boolean => {
      try { return isCurrent() === true; }
      catch { return false; }
    };

    const prepareRequest: SkillSampleDispatchSidecar['prepareRequest'] = async ({ request }) => {
      const state = states.find((item) => item.expected.requestDigest
        === evalRawDigest(JSON.stringify(request)));
      if (!state || state.phase !== 'idle' || !current()) {
        reject('candidate-evaluation-sample-dispatch-authority-denied');
      }
      requestFor(state.expected, request);
      const handle = claimNext({
        batchId,
        validatorPlan,
        expectedCoordinate: {
          scenarioOrdinal: context.scenarioOrdinal,
          repeatIndex: context.repeatIndex,
          arm: state.expected.variant,
          planDigest: context.planDigest,
          sampleKey: context.sampleKey,
        },
        requestDigest: state.expected.requestDigest,
        promptBindingDigest: state.expected.promptBindingDigest,
      });
      if (!handle) reject('candidate-evaluation-sample-dispatch-coordinate-unavailable');
      state.handle = handle;
      state.phase = 'prepared';
      return Object.freeze({
        request,
        beforeDispatch(): void {
          if ((state.phase !== 'prepared' && state.phase !== 'dispatching')
            || !current() || !ownsClaim(handle)) {
            reject('candidate-evaluation-sample-dispatch-authority-denied');
          }
          state.phase = 'dispatching';
        },
        succeeded(response: ChatResponse): void {
          // Gateway owns the physical response. Record only its object identity here because Gateway
          // intentionally swallows sidecar exceptions; durable settlement happens synchronously below.
          if (state.phase !== 'dispatching' || state.observedResponse !== null) {
            state.phase = 'uncertain';
            return;
          }
          state.observedResponse = response;
        },
        discard(terminal: AdmittedModelPreparedRequestTerminal | undefined): void {
          if (state.phase === 'settled' || state.phase === 'uncertain') return;
          const failure = failureFor(terminal);
          if (!failure) {
            state.phase = 'uncertain';
            return;
          }
          try {
            state.result = terminalize(handle, failure);
            state.phase = 'settled';
          } catch {
            state.phase = 'uncertain';
          }
        },
      });
    };

    const sidecar = Object.freeze({
      prepareRequest,
      authorizeDispatch(): boolean {
        const active = states.find((item) => item.phase === 'dispatching');
        return Boolean(active?.handle && current() && ownsClaim(active.handle));
      },
      succeededRequired(input: Parameters<SkillSampleDispatchSidecar['succeededRequired']>[0]): ReturnType<SkillSampleDispatchSidecar['succeededRequired']> {
        const { variant, requestDigest } = input;
        const state = states.find((item) => item.expected.variant === variant
          && item.expected.requestDigest === requestDigest);
        if (!state || state.phase !== 'dispatching' || !state.handle
          || state.observedResponse === null) {
          if (state) state.phase = 'uncertain';
          reject('candidate-evaluation-sample-dispatch-terminal-unconfirmed');
        }
        try {
          const result = succeeded(state.handle, state.observedResponse);
          if (result.arm !== variant || result.sampleKey !== context.sampleKey) {
            state.phase = 'uncertain';
            reject('candidate-evaluation-sample-dispatch-terminal-unconfirmed');
          }
          state.result = result;
          state.phase = 'settled';
          // D-Q3a2b2b：把 Candidate 方言的结算身份交给 Sample 执行证据，避免二次读取可变状态。
          return Object.freeze({
            receiptDigest: result.receiptDigest,
            responseDigest: terminalResponseDigest(state.handle),
          });
        } catch {
          state.phase = 'uncertain';
          reject('candidate-evaluation-sample-dispatch-terminal-unconfirmed');
        }
      },
    });
    SIDECARS.add(sidecar);
    return sidecar;
  };
  FACTORIES.add(factory);
  return factory;
}

/** Only factories minted by this module may activate the mandatory Sample path. */
export function isCandidateEvaluationSampleDispatchFactory(
  input: unknown,
): input is SkillSampleDispatchSidecarFactory {
  return typeof input === 'function' && FACTORIES.has(input);
}

/** Structural copies and caller-authored no-op sidecars cannot mint Sample evidence. */
export function isCandidateEvaluationSampleDispatchSidecar(
  input: unknown,
): input is SkillSampleDispatchSidecar {
  return Boolean(input && typeof input === 'object' && SIDECARS.has(input));
}
