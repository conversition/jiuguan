import { createHash } from 'node:crypto';
import { estimateTokens } from '@jiuguan/prompt/assembly';
import type { ChatRequest } from '../../../packages/proxy/public/client.ts';
import { agentToolSetDigest } from '../../../packages/agent-policy/public/admission.ts';
import {
  normalizeAgentSkillClosureAttribution,
  type AgentSkillClosureAttributionV1,
} from '../../../packages/agent-closure/index.ts';
import {
  isServerAgentSkillProfileConsumption,
  type ServerAgentSkillProfileConsumptionV1,
  type ServerAgentSkillProfileConsumerPort,
} from './profile-admission-service.ts';
import {
  isCandidateEvaluationValidatorAuthority,
  type CandidateEvaluationProof,
  type CandidateEvaluationReceipt,
  type CandidateEvaluationValidatorAuthority,
} from './candidate-evaluation-validator.ts';

export const SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION =
  'server-agent-skill-prompt-receipt-v1' as const;
export const SERVER_AGENT_SKILL_PROMPT_CANDIDATE_BINDING_VERSION =
  'server-agent-skill-prompt-candidate-binding-v1' as const;

export interface ServerAgentSkillPromptBindingV1 {
  readonly ticketId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly toolSetDigest: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly contextRevision: string;
  readonly nsfwSafetyDigest: string | null;
  readonly expiresAtMs: number;
  readonly profileId: string;
}

export type ServerAgentSkillPromptAttributionV1 = AgentSkillClosureAttributionV1;

export interface ServerAgentSkillPromptReceiptV1 {
  readonly receiptVersion: typeof SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION;
  readonly bindingDigest: string;
  readonly requestDigest: string;
  readonly renderedMessageDigest: string;
}

export interface ServerAgentSkillCommittedConsumptionV1 {
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly requestDigest: string;
  readonly targetRevision: string;
  readonly validatorOutcome: 'passed' | 'not-required';
}

/**
 * Process-local replay authority for one exact validated Candidate. The binding is metadata-only;
 * the Prompt consumer separately proves that the matching manifest was actually compiled into the
 * branded artifact before it may emit Candidate attribution.
 */
export interface ServerAgentSkillPromptCandidateBindingV1 {
  readonly bindingVersion: typeof SERVER_AGENT_SKILL_PROMPT_CANDIDATE_BINDING_VERSION;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly candidateBindingDigest: string;
  readonly manifestDigest: string;
  readonly profileId: string;
  readonly profilePolicyRevision: string;
  readonly profileRegistryRevision: string;
  readonly sourceAuthorityRevision: string;
}

export interface ServerAgentSkillPromptCandidateAuthorityPort {
  readCurrent(proof: unknown): ServerAgentSkillPromptCandidateBindingV1 | null;
}

export interface ServerAgentSkillPromptConsumerDependencies {
  readonly binding: ServerAgentSkillPromptBindingV1;
  readonly maxPromptTokens: number;
  readonly readCurrentBinding: () => ServerAgentSkillPromptBindingV1 | null;
  /** Must attest this exact Agent request was used by the committed turn, not just that a turn exists. */
  readonly readCommittedConsumption: (receipt: ServerAgentSkillPromptReceiptV1) =>
    ServerAgentSkillCommittedConsumptionV1 | null;
  /** Content-free, idempotent Closure adapter; a failed delivery is retryable without another model call. */
  readonly recordConsumption: (input: Readonly<{
    receipt: ServerAgentSkillPromptReceiptV1;
    committed: ServerAgentSkillCommittedConsumptionV1;
    attribution: ServerAgentSkillPromptAttributionV1;
  }>) => void;
  /** Omitted for every ordinary live call. Only a server-owned operational replay pack supplies it. */
  readonly candidateBinding?: Readonly<{
    readonly authority: ServerAgentSkillPromptCandidateAuthorityPort;
    readonly proof: unknown;
  }>;
  /**
   * Omitted for ordinary live and D-Q3a1 replay calls. D-Q3a2 evaluation supplies the concrete
   * process-local authority; a caller string can never substitute for its terminal proof.
   */
  readonly validatorAuthority?: CandidateEvaluationValidatorAuthority;
  readonly nowMs?: () => number;
}

const STAGED_PAYLOADS = new WeakSet<object>();
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeBinding(input: ServerAgentSkillPromptBindingV1): ServerAgentSkillPromptBindingV1 {
  const binding = {
    ticketId: input.ticketId, runId: input.runId, parentRunId: input.parentRunId,
    sessionId: input.sessionId, modelId: input.modelId, toolSetDigest: input.toolSetDigest,
    contentMode: input.contentMode, contextRevision: input.contextRevision,
    nsfwSafetyDigest: input.nsfwSafetyDigest, expiresAtMs: input.expiresAtMs, profileId: input.profileId,
  };
  for (const field of ['ticketId', 'runId', 'parentRunId', 'sessionId', 'modelId', 'profileId'] as const) {
    if (typeof binding[field] !== 'string' || !TOKEN_RE.test(binding[field])) throw new Error('binding-invalid');
  }
  if (!DIGEST_RE.test(binding.toolSetDigest) || !DIGEST_RE.test(binding.contextRevision)
    || !Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs < 1
    || (binding.contentMode !== 'nsf' && binding.contentMode !== 'nsfw')
    || (binding.contentMode === 'nsf' && binding.nsfwSafetyDigest !== null)
    || (binding.contentMode === 'nsfw' && !DIGEST_RE.test(binding.nsfwSafetyDigest ?? ''))) {
    throw new Error('binding-invalid');
  }
  return Object.freeze(binding);
}

function normalizeCandidateBinding(input: unknown): ServerAgentSkillPromptCandidateBindingV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('candidate-binding-invalid');
  }
  const value = input as Record<string, unknown>;
  const keys = [
    'bindingVersion', 'candidateId', 'candidateRevision', 'candidateBindingDigest',
    'manifestDigest', 'profileId', 'profilePolicyRevision', 'profileRegistryRevision',
    'sourceAuthorityRevision',
  ] as const;
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('candidate-binding-invalid');
  const binding = {
    bindingVersion: value.bindingVersion,
    candidateId: value.candidateId,
    candidateRevision: value.candidateRevision,
    candidateBindingDigest: value.candidateBindingDigest,
    manifestDigest: value.manifestDigest,
    profileId: value.profileId,
    profilePolicyRevision: value.profilePolicyRevision,
    profileRegistryRevision: value.profileRegistryRevision,
    sourceAuthorityRevision: value.sourceAuthorityRevision,
  };
  if (binding.bindingVersion !== SERVER_AGENT_SKILL_PROMPT_CANDIDATE_BINDING_VERSION
    || binding.candidateRevision !== 1
    || typeof binding.candidateId !== 'string' || !DIGEST_RE.test(binding.candidateId)
    || typeof binding.candidateBindingDigest !== 'string'
    || !DIGEST_RE.test(binding.candidateBindingDigest)
    || typeof binding.manifestDigest !== 'string' || !DIGEST_RE.test(binding.manifestDigest)
    || typeof binding.profileId !== 'string' || !TOKEN_RE.test(binding.profileId)
    || typeof binding.profilePolicyRevision !== 'string'
    || !DIGEST_RE.test(binding.profilePolicyRevision)
    || typeof binding.profileRegistryRevision !== 'string'
    || !DIGEST_RE.test(binding.profileRegistryRevision)
    || typeof binding.sourceAuthorityRevision !== 'string'
    || !DIGEST_RE.test(binding.sourceAuthorityRevision)) {
    throw new Error('candidate-binding-invalid');
  }
  return freeze(binding) as ServerAgentSkillPromptCandidateBindingV1;
}

/**
 * Fixed server-local adapter. It stages only service-branded verified payloads, atomically takes
 * one payload, then keeps Provider success distinct from actual committed consumption. Methods
 * are for the trusted coordinator only; no transport/model callback belongs in these dependencies.
 */
export function createServerAgentSkillPromptConsumer(dependencies: ServerAgentSkillPromptConsumerDependencies) {
  return createPromptConsumer(dependencies, 1, false);
}

/** One branded program, bounded sequential dispatches. Never expose another consume authority. */
export function createServerAgentSkillPromptCallGroup(
  dependencies: ServerAgentSkillPromptConsumerDependencies,
  maxDispatches: number,
) {
  if (!Number.isSafeInteger(maxDispatches) || maxDispatches < 1 || maxDispatches > 256) {
    throw new Error('agent-skill-prompt-dispatch-limit-invalid');
  }
  const sink = createPromptConsumer(dependencies, maxDispatches, true);
  // A group is sealed by its domain coordinator, never by one request's commit observer.
  const { observeCommitted: _observeCommitted, ...group } = sink;
  return Object.freeze(group);
}

function createPromptConsumer(
  dependencies: ServerAgentSkillPromptConsumerDependencies, maxDispatches: number, isGroup: boolean,
) {
  const binding = normalizeBinding(dependencies.binding);
  const candidateAuthority = dependencies.candidateBinding?.authority;
  const candidateProof = dependencies.candidateBinding?.proof;
  if ((candidateAuthority === undefined) !== (candidateProof === undefined)
    || (candidateAuthority !== undefined && typeof candidateAuthority.readCurrent !== 'function')) {
    throw new Error('candidate-binding-authority-invalid');
  }
  const candidateBinding = candidateAuthority === undefined
    ? null
    : normalizeCandidateBinding(candidateAuthority.readCurrent(candidateProof));
  const validatorAuthority = dependencies.validatorAuthority;
  if (validatorAuthority !== undefined
    && !isCandidateEvaluationValidatorAuthority(validatorAuthority)) {
    throw new Error('agent-skill-prompt-validator-authority-invalid');
  }
  const candidateBindingDigest = candidateBinding === null ? null : digest(candidateBinding);
  const promptBindingDigest = digest(binding);
  const bindingDigest = candidateBinding === null
    ? promptBindingDigest
    : digest({ binding, candidateBinding });
  const readCurrentBinding = dependencies.readCurrentBinding;
  const readCommittedConsumption = dependencies.readCommittedConsumption;
  const recordConsumption = dependencies.recordConsumption;
  const nowMs = dependencies.nowMs ?? Date.now;
  const maxPromptTokens = dependencies.maxPromptTokens;
  if (!Number.isSafeInteger(maxPromptTokens) || maxPromptTokens < 1 || maxPromptTokens > 10_000_000) {
    throw new Error('agent-skill-prompt-budget-invalid');
  }
  let state: 'empty' | 'staged' | 'taken' | 'dispatched' | 'provider-succeeded' | 'provider-terminal'
    | 'delivery-pending' | 'committed' | 'discarded' = 'empty';
  let pending: ServerAgentSkillProfileConsumptionV1 | undefined;
  let taken: Readonly<{
    receipt: ServerAgentSkillPromptReceiptV1;
    request: ChatRequest;
    payload: ServerAgentSkillProfileConsumptionV1;
  }> | undefined;
  let delivery: Parameters<typeof recordConsumption>[0] | undefined;
  let validationReceipt: CandidateEvaluationReceipt | null = null;
  let validationProof: CandidateEvaluationProof | null = null;
  let dispatches = 0;
  const requireCandidateCurrent = (): ServerAgentSkillPromptCandidateBindingV1 | null => {
    if (candidateBinding === null) return null;
    let current: ServerAgentSkillPromptCandidateBindingV1;
    try {
      current = normalizeCandidateBinding(candidateAuthority!.readCurrent(candidateProof));
    } catch {
      throw new Error('agent-skill-prompt-candidate-authority-drift');
    }
    if (digest(current) !== candidateBindingDigest) {
      throw new Error('agent-skill-prompt-candidate-authority-drift');
    }
    return current;
  };
  const activeCandidateDigests = (
    payload: ServerAgentSkillProfileConsumptionV1,
  ): readonly string[] => {
    const current = requireCandidateCurrent();
    if (current === null) return Object.freeze([]);
    const artifact = payload.artifact;
    const programs = artifact.programs.filter(
      (program) => program.manifestDigest === current.manifestDigest,
    );
    const slots = artifact.promptSlots.filter(
      (slot) => slot.manifestDigest === current.manifestDigest,
    );
    if (payload.trace.profileId !== current.profileId
      || payload.trace.profilePolicyRevision !== current.profilePolicyRevision
      || payload.trace.profileRegistryRevision !== current.profileRegistryRevision
      || artifact.profileId !== current.profileId
      || artifact.profilePolicyRevision !== current.profilePolicyRevision
      || artifact.profileRegistryRevision !== current.profileRegistryRevision
      || payload.trace.sourceAuthorityRevision !== current.sourceAuthorityRevision
      || artifact.authorityRevision !== payload.trace.authorityRevision
      || programs.length !== 1 || programs[0]!.kind !== 'style'
      || programs[0]!.promptOperationCount < 1
      || programs[0]!.validatorOperationCount !== 0
      || slots.length !== 1 || slots[0]!.slot !== 'style'
      || slots[0]!.instruction.length === 0) {
      throw new Error('agent-skill-prompt-candidate-artifact-mismatch');
    }
    return Object.freeze([current.candidateBindingDigest]);
  };
  const readExactValidation = (
    payload: ServerAgentSkillProfileConsumptionV1,
    receipt: ServerAgentSkillPromptReceiptV1,
    proof: unknown,
  ): Readonly<{
    proof: CandidateEvaluationProof;
    result: CandidateEvaluationReceipt;
  }> => {
    const currentCandidate = requireCandidateCurrent();
    const result = validatorAuthority?.readCurrent(proof) ?? null;
    if (!currentCandidate || !result
      || result.candidateId !== currentCandidate.candidateId
      || result.candidateRevision !== currentCandidate.candidateRevision
      || result.candidateBindingDigest !== currentCandidate.candidateBindingDigest
      || result.sourceAuthorityRevision !== currentCandidate.sourceAuthorityRevision
      || result.compiledArtifactDigest !== payload.artifact.compiledArtifactDigest
      || result.validatorPlanDigest !== payload.artifact.validatorPlanDigest
      || result.requestDigest !== receipt.requestDigest
      || result.promptBindingDigest !== receipt.bindingDigest) {
      throw new Error('agent-skill-prompt-validator-proof-invalid');
    }
    requireCandidateCurrent();
    return Object.freeze({
      proof: proof as CandidateEvaluationProof,
      result,
    });
  };
  const requirePassedValidationCurrent = (
    payload: ServerAgentSkillProfileConsumptionV1,
  ): void => {
    if (payload.artifact.validatorPlan.length === 0) return;
    if (validationReceipt?.outcome !== 'passed' || validationProof === null
      || validatorAuthority?.readCurrent(validationProof)?.receiptDigest
        !== validationReceipt.receiptDigest) {
      throw new Error('agent-skill-prompt-validator-not-passed');
    }
  };
  const attributionFor = (
    payload: ServerAgentSkillProfileConsumptionV1,
    validatorOutcome: 'passed' | 'not-required',
  ): ServerAgentSkillPromptAttributionV1 => {
    if (validatorOutcome !== (payload.artifact.validatorPlan.length ? 'passed' : 'not-required')) {
      throw new Error('agent-skill-prompt-validator-outcome-mismatch');
    }
    requirePassedValidationCurrent(payload);
    const artifact = payload.artifact;
    return normalizeAgentSkillClosureAttribution({
      attributionVersion: 'agent-skill-attribution-v1',
      instructionSetDigest: artifact.instructionSetDigest,
      selectionReceiptDigest: payload.trace.selectionReceiptDigest,
      compiledArtifactDigest: artifact.compiledArtifactDigest,
      compiledInstructionSetDigest: artifact.compiledInstructionSetDigest,
      validatorPlanDigest: artifact.validatorPlanDigest,
      selectedManifestDigests: artifact.programs.map((program) => program.manifestDigest),
      activeCandidateDigests: activeCandidateDigests(payload), validatorOutcome,
    });
  };
  const consumer: ServerAgentSkillProfileConsumerPort = Object.freeze({
    consume(payload: ServerAgentSkillProfileConsumptionV1) {
      if (state !== 'empty') throw new Error('agent-skill-prompt-consumer-replayed');
      state = 'discarded';
      if (!isServerAgentSkillProfileConsumption(payload) || STAGED_PAYLOADS.has(payload)) {
        throw new Error('agent-skill-prompt-consumption-not-owned');
      }
      STAGED_PAYLOADS.add(payload);
      activeCandidateDigests(payload);
      if (payload.artifact.validatorPlan.length > 0
        && !isCandidateEvaluationValidatorAuthority(validatorAuthority)) {
        throw new Error('agent-skill-prompt-validator-authority-required');
      }
      if (digest(normalizeBinding({ ...payload, profileId: payload.artifact.profileId })) !== promptBindingDigest
        || nowMs() >= binding.expiresAtMs) throw new Error('agent-skill-prompt-binding-mismatch');
      pending = payload;
      state = 'staged';
    },
  });
  return Object.freeze({
    consumer,
    assemble(baseRequest: ChatRequest): Readonly<{
      kind: 'assembled'; request: ChatRequest; receipt: ServerAgentSkillPromptReceiptV1;
    }> | Readonly<{ kind: 'fallback'; reason: string }> {
      const reusable = maxDispatches > 1 && state === 'provider-succeeded' && dispatches < maxDispatches;
      const payload = pending ?? (reusable ? taken?.payload : undefined);
      pending = undefined;
      const wasStaged = state === 'staged' || reusable;
      if (!wasStaged || !payload) {
        if (state === 'empty' || isGroup) { state = 'discarded'; taken = undefined; }
        return Object.freeze({ kind: 'fallback', reason: 'not-staged' });
      }
      state = 'discarded';
      taken = undefined;
      dispatches += 1;
      try {
        requireCandidateCurrent();
        const current = readCurrentBinding();
        if (!current || digest(normalizeBinding(current)) !== promptBindingDigest
          || nowMs() >= binding.expiresAtMs) throw new Error('authority-drift');
        if (baseRequest.model !== binding.modelId
          || agentToolSetDigest(baseRequest.tools ?? []) !== binding.toolSetDigest
          || !Array.isArray(baseRequest.messages) || baseRequest.messages[0]?.role !== 'system') {
          throw new Error('request-binding-mismatch');
        }
        if (baseRequest.extraBody && ['model', 'messages', 'tools', 'tool_choice', 'system', 'prompt', 'input']
          .some((key) => Object.hasOwn(baseRequest.extraBody!, key))) throw new Error('request-override');
        const rendered = `<AgentSkillProgramV1>\n${payload.artifact.promptSlots
          .map((slot) => slot.instruction).join('\n')}\n</AgentSkillProgramV1>`;
        if (payload.artifact.promptSlots.length === 0 || rendered !== payload.artifact.promptInstruction) {
          throw new Error('typed-slot-mismatch');
        }
        const request = structuredClone(baseRequest);
        let index = 1;
        while (request.messages[index]?.role === 'system') index += 1;
        request.messages.splice(index, 0, { role: 'system', content: rendered });
        if (estimateTokens(JSON.stringify(request)) > maxPromptTokens) throw new Error('prompt-budget-exceeded');
        if (nowMs() >= binding.expiresAtMs) throw new Error('authority-expired');
        freeze(request);
        const receipt = freeze({
          receiptVersion: SERVER_AGENT_SKILL_PROMPT_RECEIPT_VERSION,
          bindingDigest, requestDigest: digest(request), renderedMessageDigest: digest(rendered),
        });
        taken = Object.freeze({ receipt, request, payload });
        state = 'taken';
        return Object.freeze({ kind: 'assembled', request, receipt });
      } catch {
        return Object.freeze({ kind: 'fallback', reason: 'assembly-rejected' });
      }
    },
    beforeProviderDispatch(receipt: unknown, request: unknown): void {
      if ((state !== 'taken' && state !== 'dispatched') || !taken
        || taken.receipt !== receipt || taken.request !== request) {
        throw new Error('agent-skill-prompt-dispatch-not-owned');
      }
      const current = readCurrentBinding();
      if (!current || digest(normalizeBinding(current)) !== digest(binding) || nowMs() >= binding.expiresAtMs) {
        state = 'discarded';
        throw new Error('agent-skill-prompt-dispatch-authority-drift');
      }
      try { requireCandidateCurrent(); }
      catch (error) { state = 'discarded'; throw error; }
      state = 'dispatched';
    },
    /** Called only by the successful Provider invocation that received this exact frozen request. */
    providerSucceeded(receipt: unknown, request: unknown, validatorProof?: unknown): void {
      if ((state === 'provider-succeeded' || state === 'provider-terminal'
        || state === 'delivery-pending' || state === 'committed')
        && taken !== undefined && taken.receipt === receipt && taken.request === request
        && (taken.payload.artifact.validatorPlan.length === 0
          || validationProof === validatorProof)) return;
      if (state !== 'dispatched' || !taken || taken.receipt !== receipt || taken.request !== request
        || nowMs() >= binding.expiresAtMs) {
        if (state !== 'committed') state = 'discarded';
        throw new Error('agent-skill-prompt-provider-binding-mismatch');
      }
      try { requireCandidateCurrent(); }
      catch (error) { state = 'discarded'; throw error; }
      if (taken.payload.artifact.validatorPlan.length === 0) {
        if (validatorProof !== undefined) {
          state = 'discarded';
          throw new Error('agent-skill-prompt-validator-proof-unexpected');
        }
        validationReceipt = null;
        validationProof = null;
      } else {
        try {
          const exact = readExactValidation(taken.payload, taken.receipt, validatorProof);
          validationReceipt = exact.result;
          validationProof = exact.proof;
        } catch (error) {
          state = 'discarded';
          throw error;
        }
      }
      state = validationReceipt !== null && validationReceipt.outcome !== 'passed'
        ? 'provider-terminal'
        : 'provider-succeeded';
    },
    /** Records a non-success Provider/Validator terminal without making it Closure-eligible. */
    providerTerminated(receipt: unknown, request: unknown, validatorProof: unknown): void {
      if (state === 'provider-terminal' && taken?.receipt === receipt && taken?.request === request
        && validationProof === validatorProof) return;
      if (state !== 'dispatched' || !taken || taken.receipt !== receipt || taken.request !== request
        || taken.payload.artifact.validatorPlan.length === 0) {
        throw new Error('agent-skill-prompt-provider-binding-mismatch');
      }
      try {
        const exact = readExactValidation(taken.payload, taken.receipt, validatorProof);
        if (exact.result.outcome === 'passed') {
          throw new Error('agent-skill-prompt-validator-terminal-invalid');
        }
        validationReceipt = exact.result;
        validationProof = exact.proof;
        state = 'provider-terminal';
      } catch (error) {
        state = 'discarded';
        throw error;
      }
    },
    /** Read-only audit material; copying it never recreates the process-local Validator proof. */
    readValidationReceipt(receipt: unknown): CandidateEvaluationReceipt | null {
      if (!taken || taken.receipt !== receipt || validationReceipt === null
        || validationProof === null
        || validatorAuthority?.readCurrent(validationProof)?.receiptDigest
          !== validationReceipt.receiptDigest) return null;
      try {
        requireCandidateCurrent();
        return validationReceipt;
      } catch { return null; }
    },
    /** Stage metadata into the session outbox inside the final transaction; this is not a consumption event. */
    prepareCommitAttribution(receipt: unknown, validatorOutcome: 'passed' | 'not-required'):
      ServerAgentSkillPromptAttributionV1 {
      if (state !== 'provider-succeeded' || !taken || taken.receipt !== receipt) {
        throw new Error('agent-skill-prompt-commit-attribution-not-owned');
      }
      return attributionFor(taken.payload, validatorOutcome);
    },
    observeCommitted(receipt: unknown): 'recorded' | 'not-committed' | 'retryable' {
      if (state === 'committed' && taken?.receipt === receipt) return 'recorded';
      if (!taken || taken.receipt !== receipt
        || (state !== 'provider-succeeded' && state !== 'delivery-pending')) return 'not-committed';
      try {
        if (!delivery) {
          const committed = readCommittedConsumption(taken.receipt);
          if (!committed || committed.runId !== binding.runId || committed.parentRunId !== binding.parentRunId
            || committed.sessionId !== binding.sessionId || committed.requestDigest !== taken.receipt.requestDigest
            || !TOKEN_RE.test(committed.targetRevision)
            || committed.validatorOutcome !== (taken.payload.artifact.validatorPlan.length ? 'passed' : 'not-required')) {
            return 'not-committed';
          }
          delivery = freeze({
            receipt: taken.receipt, committed: { ...committed },
            attribution: attributionFor(taken.payload, committed.validatorOutcome),
          });
        }
        state = 'delivery-pending';
        const result = recordConsumption(delivery) as unknown;
        if (result !== undefined) throw new Error('consumption-recorder-must-be-synchronous');
        state = 'committed';
        return 'recorded';
      } catch {
        return 'retryable';
      }
    },
    discard(): void {
      if (state === 'provider-terminal') {
        pending = undefined;
        delivery = undefined;
        return;
      }
      if (state !== 'committed') state = 'discarded';
      pending = undefined;
      taken = undefined;
      delivery = undefined;
      validationReceipt = null;
      validationProof = null;
    },
  });
}
