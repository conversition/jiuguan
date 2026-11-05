import { createHash } from 'node:crypto';
import {
  admissionLimitsFromBudgetProfile,
  admissionLimitsFromGatewayBudgetProfileV3,
  agentToolSetDigest,
  type AdmissionLease,
  type AgentContentMode,
  type AgentLane,
  type AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';
import {
  agentBudgetProfileDigest,
  normalizeAgentBudgetProfile,
  AGENT_GATEWAY_BUDGET_PROFILE_V3,
  normalizeAgentGatewayBudgetProfileV3,
  agentGatewayBudgetProfileDigestV3,
  type AgentGatewayBudgetProfileV3,
  type AgentBudgetProfileInput,
} from '../../packages/agent-policy/src/budget-profile.ts';
import {
  AbortTurnError,
  type ChatCompletionClient,
  type ChatProviderCall,
  type ChatRequest,
  type ChatResponse,
  type ChatToolArgumentDelta,
  type ChatUsage,
  type ModelCallLane,
} from '../../packages/proxy/src/client.ts';
import {
  providerFailureDiagnosticCode,
  type ProviderFailureDiagnosticCode,
} from '../../packages/proxy/src/provider-registry.ts';
import { AdmissionTicketBroker, AdmissionTicketError } from './agent-admission-broker.ts';
import { ProviderCallDiscardedError, ProviderDispatchAuthorityDeniedError } from './provider-arbitration-client.ts';
import { estimateTokens } from '../../packages/prompt/src/assembly.ts';

export type AdmittedModelGatewayErrorCode =
  | 'gateway-model-required'
  | 'gateway-tools-invalid'
  | 'gateway-budget-lane-mismatch'
  | 'gateway-output-budget-invalid'
  | 'gateway-cost-estimator-unavailable'
  | 'gateway-model-binding-mismatch'
  | 'gateway-toolset-binding-mismatch'
  | 'gateway-concurrent-call'
  | 'gateway-lease-closed'
  | 'gateway-model-call-budget-exhausted'
  | 'gateway-input-budget-exhausted'
  | 'gateway-request-window-exceeded'
  | 'gateway-output-budget-exhausted'
  | 'gateway-cost-budget-exhausted'
  | 'gateway-wall-budget-exhausted'
  | 'gateway-provider-usage-unavailable'
  | 'gateway-provider-usage-invalid'
  | 'gateway-provider-call-failed'
  | 'gateway-provider-call-cancelled'
  | 'gateway-request-completion-failed'
  | 'gateway-lease-audit-failed'
  | 'gateway-dispatch-authority-denied';

export class AdmittedModelGatewayError extends Error {
  constructor(readonly code: AdmittedModelGatewayErrorCode) {
    super(code);
    this.name = 'AdmittedModelGatewayError';
  }
}

const ADMITTED_MODEL_GATEWAY_ERROR_CODES = new Set<AdmittedModelGatewayErrorCode>([
  'gateway-model-required',
  'gateway-tools-invalid',
  'gateway-budget-lane-mismatch',
  'gateway-output-budget-invalid',
  'gateway-cost-estimator-unavailable',
  'gateway-model-binding-mismatch',
  'gateway-toolset-binding-mismatch',
  'gateway-concurrent-call',
  'gateway-lease-closed',
  'gateway-model-call-budget-exhausted',
  'gateway-input-budget-exhausted',
  'gateway-request-window-exceeded',
  'gateway-output-budget-exhausted',
  'gateway-cost-budget-exhausted',
  'gateway-wall-budget-exhausted',
  'gateway-provider-usage-unavailable',
  'gateway-provider-usage-invalid',
  'gateway-provider-call-failed',
  'gateway-provider-call-cancelled',
  'gateway-request-completion-failed',
  'gateway-lease-audit-failed',
  'gateway-dispatch-authority-denied',
]);

/** Preserve only the fixed, non-sensitive Gateway reason vocabulary across adapters. */
export function safeAdmittedModelGatewayErrorCode(
  error: unknown,
): AdmittedModelGatewayErrorCode | undefined {
  if (!(error instanceof AdmittedModelGatewayError)) return undefined;
  return ADMITTED_MODEL_GATEWAY_ERROR_CODES.has(error.code) ? error.code : undefined;
}

/** Only an immediate boolean true grants authority; future verdicts are refused, never awaited. */
function synchronousDispatchVerdictAllowed(verdict: unknown): boolean {
  if (verdict === true) return true;
  if (verdict !== false) {
    try { void Promise.prototype.then.call(verdict, () => {}, () => {}); }
    catch { /* Observe native Promise rejection without assimilating an arbitrary thenable. */ }
  }
  return false;
}

/** A host lifecycle check must finish synchronously, never grant on a future result. */
function synchronousVoidAllowed(verdict: unknown): boolean {
  if (verdict === undefined) return true;
  try { void Promise.prototype.then.call(verdict, () => {}, () => {}); }
  catch { /* Refuse arbitrary thenables without executing their code. */ }
  return false;
}

export interface AdmittedModelBinding {
  readonly ticketId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly mode: AgentContentMode;
  readonly budgetProfile: AgentBudgetProfileInput | AgentGatewayBudgetProfileV3;
}

export interface AdmittedModelRequest {
  readonly binding: AdmittedModelBinding;
  readonly request: ChatRequest;
  readonly signal?: AbortSignal;
}

export interface AdmittedModelLeaseRequest {
  readonly binding: AdmittedModelBinding;
  readonly modelId: string;
  readonly tools?: ChatRequest['tools'];
  /** May narrow the original Profile to a smaller issued quota reservation; never increases either ceiling. */
  readonly modelCallLimit?: number;
}

export type AdmittedModelLeaseOutcome =
  | 'completed'
  | 'budget_exhausted'
  | 'usage_unavailable'
  | 'provider_error'
  | 'cancelled'
  | 'expired';

export interface AdmittedModelLeaseSnapshot {
  readonly status: 'open' | 'closed';
  /** Provider attempts reserved from the bounded retry budget. */
  readonly modelCallsUsed: number;
  /** Calls that returned an upstream result and therefore consume the authorization window. */
  readonly authorizationCallsUsed: number;
  /** Non-cancellation Provider failures, including transient failures before a later success. */
  readonly providerErrorAttemptsUsed: number;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
  readonly costMicrousdUsed: number;
  readonly wallMsUsed: number;
  readonly modelCallsRemaining: number;
  readonly inputTokensRemaining: number;
  readonly outputTokensRemaining: number;
  readonly costMicrousdRemaining: number;
  readonly outcome?: AdmittedModelLeaseOutcome;
  readonly reasonCode?: AdmittedModelGatewayErrorCode;
  /** Content-free diagnostic for the latest Provider failure observed by this lease. */
  readonly providerDiagnosticCode?: ProviderFailureDiagnosticCode;
  /** Hash of the actual post-preparation request accepted for the latest physical attempt. */
  readonly lastRequestDigest?: string;
}

export interface AdmittedModelLeaseAudit extends AdmittedModelLeaseSnapshot {
  readonly leaseIdDigest: string;
  /** Durable quota reservation identity; contains no prompt, prose, or user identity. */
  readonly quotaReservationDigest?: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: AgentLane;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  /** Stable source identities only; never source text or generated prose. */
  readonly evidenceDigests: readonly string[];
  readonly modelId: string;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface AdmittedModelGatewayOptions {
  readonly nowMs?: () => number;
  /** Must price the same normalized Provider usage observed by ObservedChatCompletionClient. */
  readonly estimateCostMicrousd?: (usage: ChatUsage, call: ChatProviderCall) => number | undefined;
  /** Receives stable identities, digests and counters only; never prompt/prose/tool results. */
  readonly onLeaseClosed?: (audit: AdmittedModelLeaseAudit) => void;
  readonly onAuditError?: (code: 'gateway-lease-audit-failed') => void;
  /** Enforced lanes fail closed when the durable lease audit cannot be written. */
  readonly auditRequired?: boolean;
  /** A trusted host may require the whole prepared lifecycle; missing/stale preparation or completion is fatal. */
  readonly prepareRequestRequired?: boolean;
  /** Trusted host adapter only. Fallback is allowed before dispatch, never a second Provider call. */
  readonly prepareRequest?: (input: Readonly<{
    lease: AdmissionLease; binding: AdmittedModelBinding; request: ChatRequest; signal?: AbortSignal;
  }>) => Promise<AdmittedModelPreparedRequest | null>;
  /** Synchronous boolean-true authority before reserve and again at the physical dispatch boundary. */
  readonly authorizeDispatch?: (lease: AdmissionLease) => boolean;
}

export interface AdmittedModelPreparedRequest {
  readonly request: ChatRequest;
  /** Revalidates before reserve and after a queued physical permit; must allow repeated checks. */
  readonly beforeDispatch: () => void;
  readonly succeeded: (response: ChatResponse) => void;
  readonly discard: (terminal?: AdmittedModelPreparedRequestTerminal) => void;
}

/** Fixed, content-free terminal vocabulary exposed to trusted request sidecars. */
export type AdmittedModelPreparedRequestTerminal =
  | AdmittedModelGatewayErrorCode
  | ProviderFailureDiagnosticCode;

function toolNames(tools: ChatRequest['tools']): readonly string[] {
  const names: string[] = [];
  for (const entry of tools ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AdmittedModelGatewayError('gateway-tools-invalid');
    }
    const row = entry as Record<string, unknown>;
    const fn = row.function;
    if (row.type !== 'function' || !fn || typeof fn !== 'object' || Array.isArray(fn)
      || typeof (fn as Record<string, unknown>).name !== 'string') {
      throw new AdmittedModelGatewayError('gateway-tools-invalid');
    }
    names.push((fn as Record<string, unknown>).name as string);
  }
  return Object.freeze([...names]);
}

function providerLane(binding: AdmittedModelBinding): ModelCallLane {
  if (binding.taskKind === 'rp_child_analysis') return 'rp_child_analysis';
  if (binding.taskKind === 'interactive_prelude') return 'interactive_prelude';
  if (binding.taskKind === 'context_compiler') return 'context_compiler';
  if (binding.taskKind === 'style_compile') return 'style_compile';
  if (binding.taskKind === 'skill_compile') return 'skill_compile';
  if (binding.taskKind === 'skill_evaluate') return 'skill_evaluate';
  if (binding.taskKind === 'skill_sample') return 'skill_sample';
  if (binding.taskKind === 'skill_quality') return 'skill_quality';
  if (binding.taskKind === 'preference_extract') return 'preference';
  if (binding.taskKind === 'arc_maintenance' || binding.taskKind === 'branch_index') return 'arc';
  if (binding.taskKind === 'npc_maintenance' || binding.taskKind === 'npc_state') return 'npc';
  if (binding.taskKind === 'critic_revision') return 'critic';
  if (binding.taskKind === 'aql_replan') return 'aql_replan';
  return 'maintenance';
}

function expectedBudgetLane(taskKind: AgentTaskKind): AgentBudgetProfileInput['lane'] {
  if (taskKind === 'interactive_prelude' || taskKind === 'context_compiler' || taskKind === 'aql_replan') return 'interactive';
  if (taskKind === 'memory_consolidation' || taskKind === 'preference_extract') return 'preference';
  if (taskKind === 'rolling_summary' || taskKind === 'style_compile' || taskKind === 'skill_compile'
    || taskKind === 'skill_evaluate' || taskKind === 'skill_sample' || taskKind === 'skill_quality') return 'style';
  if (taskKind === 'branch_index' || taskKind === 'arc_maintenance') return 'arc';
  if (taskKind === 'npc_state' || taskKind === 'npc_maintenance') return 'npc';
  if (taskKind === 'worldbook_repair') return 'worldbook';
  return 'critic';
}

function deadlineSignal(external: AbortSignal | undefined, remainingMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(remainingMs, 2_147_483_647)));
  return external ? AbortSignal.any([external, deadline]) : deadline;
}

function safeUsage(usage: ChatResponse['usage']): ChatUsage | null {
  if (!usage) return null;
  const values = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  for (const value of [usage.cached_input_tokens, usage.cache_write_tokens, usage.reasoning_tokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) return null;
  }
  if (usage.total_tokens < usage.prompt_tokens + usage.completion_tokens) return null;
  return usage;
}

/** Deterministic preflight only; Provider usage remains the post-call accounting truth. */
export function estimateAdmittedRequestInputTokens(request: ChatRequest): number {
  const messageTokens = request.messages.reduce((sum, message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content === null ? '' : JSON.stringify(message.content);
    return sum + estimateTokens(content)
      + estimateTokens(message.role)
      + (message.tool_calls ? estimateTokens(JSON.stringify(message.tool_calls)) : 0)
      + (message.tool_call_id ? estimateTokens(message.tool_call_id) : 0)
      + (message.name ? estimateTokens(message.name) : 0);
  }, 0);
  const tools = request.tools ? estimateTokens(JSON.stringify(request.tools)) : 0;
  return messageTokens + tools;
}

function ticketDigest(ticketId: string): string {
  return `sha256:${createHash('sha256').update(ticketId, 'utf8').digest('hex')}`;
}

/**
 * Server-only runtime lease. A Ticket is consumed exactly once when this object is opened;
 * every subsequent Provider call spends the same decreasing aggregate budget. The lease
 * retains only stable binding material and counters, never request, prompt, response or tool output.
 */
export class AdmittedModelLease {
  readonly #nowMs: () => number;
  readonly #deadlineMs: number;
  readonly #toolSetDigest: string;
  readonly #lane: ModelCallLane;
  #modelCallsUsed = 0;
  #authorizationCallsUsed = 0;
  #providerErrorAttemptsUsed = 0;
  #inputTokensUsed = 0;
  #outputTokensUsed = 0;
  #costMicrousdUsed = 0;
  #inFlight = false;
  #preparing = false;
  #closed = false;
  #outcome: AdmittedModelLeaseOutcome | undefined;
  #reasonCode: AdmittedModelGatewayErrorCode | undefined;
  #providerDiagnosticCode: ProviderFailureDiagnosticCode | undefined;
  #lastRequestDigest: string | undefined;
  #closedAudit: AdmittedModelLeaseAudit | null = null;

  constructor(
    private readonly admission: AdmissionLease,
    private readonly binding: AdmittedModelBinding,
    private readonly delegate: ChatCompletionClient,
    private readonly options: AdmittedModelGatewayOptions,
    private readonly requestBounds?: AgentGatewayBudgetProfileV3,
  ) {
    this.#nowMs = options.nowMs ?? Date.now;
    this.#deadlineMs = admission.consumedAtMs + admission.limits.maxWallMs;
    this.#toolSetDigest = admission.toolSetDigest;
    this.#lane = providerLane(binding);
  }

  snapshot(): AdmittedModelLeaseSnapshot {
    const limits = this.admission.limits;
    return Object.freeze({
      status: this.#closed ? 'closed' : 'open',
      modelCallsUsed: this.#modelCallsUsed,
      authorizationCallsUsed: this.#authorizationCallsUsed,
      providerErrorAttemptsUsed: this.#providerErrorAttemptsUsed,
      inputTokensUsed: this.#inputTokensUsed,
      outputTokensUsed: this.#outputTokensUsed,
      costMicrousdUsed: this.#costMicrousdUsed,
      wallMsUsed: Math.max(0, this.#nowMs() - this.admission.consumedAtMs),
      modelCallsRemaining: Math.max(0, limits.maxModelCalls - this.#modelCallsUsed),
      inputTokensRemaining: Math.max(0, limits.maxInputTokens - this.#inputTokensUsed),
      outputTokensRemaining: Math.max(0, limits.maxOutputTokens - this.#outputTokensUsed),
      costMicrousdRemaining: Math.max(0, limits.maxCostMicrousd - this.#costMicrousdUsed),
      ...(this.#outcome ? { outcome: this.#outcome } : {}),
      ...(this.#reasonCode ? { reasonCode: this.#reasonCode } : {}),
      ...(this.#providerDiagnosticCode
        ? { providerDiagnosticCode: this.#providerDiagnosticCode }
        : {}),
      ...(this.#lastRequestDigest ? { lastRequestDigest: this.#lastRequestDigest } : {}),
    });
  }

  /** The exact closed accounting snapshot, not evidence that an external audit sink persisted it. */
  closedAudit(): AdmittedModelLeaseAudit | null { return this.#closedAudit; }

  finish(outcome: AdmittedModelLeaseOutcome = 'completed', reasonCode?: AdmittedModelGatewayErrorCode): void {
    if (this.#inFlight) throw new AdmittedModelGatewayError('gateway-concurrent-call');
    this.#close(outcome, reasonCode);
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return await this.#invoke(request, signal, (actual, combined, call) =>
      this.delegate.complete(actual, combined, call));
  }

  async stream(
    request: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return await this.#invoke(request, signal, (actual, combined, call) =>
      this.delegate.stream(actual, onDelta, onToolArg, combined, call));
  }

  async #invoke(
    request: ChatRequest,
    externalSignal: AbortSignal | undefined,
    invoke: (request: ChatRequest, signal: AbortSignal, call: ChatProviderCall) => Promise<ChatResponse>,
  ): Promise<ChatResponse> {
    if (this.#preparing || this.#inFlight) throw new AdmittedModelGatewayError('gateway-concurrent-call');
    if (this.#closed) throw new AdmittedModelGatewayError('gateway-lease-closed');
    let prepared: AdmittedModelPreparedRequest | null = null;
    let preparationFailed = false;
    if (this.options.prepareRequest && !externalSignal?.aborted) {
      this.#preparing = true;
      try {
        prepared = await this.options.prepareRequest({
          lease: this.admission, binding: this.binding, request, signal: externalSignal,
        });
        if (!prepared) preparationFailed = true;
      } catch { preparationFailed = true; /* Optional Skill assembly may still fall back before dispatch. */ }
      finally { this.#preparing = false; }
    } else if (this.options.prepareRequestRequired) {
      preparationFailed = true;
    }
    const discard = (terminal?: AdmittedModelPreparedRequestTerminal) => {
      try { prepared?.discard(terminal); } catch { /* optional sidecar */ }
    };
    const rejectRequiredPreparation = (): never => {
      discard('gateway-dispatch-authority-denied');
      this.#close('cancelled', 'gateway-dispatch-authority-denied');
      throw new AdmittedModelGatewayError('gateway-dispatch-authority-denied');
    };
    if (this.options.prepareRequestRequired && (preparationFailed || !prepared)) {
      rejectRequiredPreparation();
    }
    let actual = request;
    if (prepared) {
      try {
        if (!synchronousVoidAllowed(prepared.beforeDispatch())) throw new Error('invalid-dispatch-check');
        actual = prepared.request;
      }
      catch {
        if (this.options.prepareRequestRequired) rejectRequiredPreparation();
        discard(); prepared = null;
      }
    }
    // Request preparation is optional; an explicit host dispatch guard is not.
    if (this.options.prepareRequest || this.options.authorizeDispatch !== undefined) {
      let authorized = false;
      try {
        authorized = this.options.authorizeDispatch === undefined
          || synchronousDispatchVerdictAllowed(this.options.authorizeDispatch(this.admission));
      } catch { /* fail closed */ }
      if (!authorized) {
        discard('gateway-dispatch-authority-denied');
        this.#close('cancelled', 'gateway-dispatch-authority-denied');
        throw new AdmittedModelGatewayError('gateway-dispatch-authority-denied');
      }
    }
    let reservation: { signal: AbortSignal; call: ChatProviderCall; reservedOutput: number };
    try { reservation = this.#reserve(actual, externalSignal); }
    catch (error) { discard(safeAdmittedModelGatewayErrorCode(error)); throw error; }
    const { signal, call, reservedOutput } = reservation;
    const dispatchPrepared = prepared;
    const reservedRequestDigest = this.#lastRequestDigest;
    const physicalCall: ChatProviderCall = dispatchPrepared || this.options.authorizeDispatch !== undefined
      ? Object.freeze({ ...call, beforeDispatch: () => {
        try {
          if (this.#closed || signal.aborted || externalSignal?.aborted || this.#nowMs() >= this.#deadlineMs
            || `sha256:${createHash('sha256').update(JSON.stringify(actual), 'utf8').digest('hex')}` !== reservedRequestDigest
            || (this.options.authorizeDispatch !== undefined
              && !synchronousDispatchVerdictAllowed(this.options.authorizeDispatch(this.admission)))
            || (dispatchPrepared !== null && !synchronousVoidAllowed(dispatchPrepared.beforeDispatch()))) {
            throw new ProviderDispatchAuthorityDeniedError();
          }
        } catch { throw new ProviderDispatchAuthorityDeniedError(); }
      } }) : call;
    try {
      const response = await invoke(actual, signal, physicalCall);
      this.#inFlight = false;
      // A reserved attempt becomes an authorized call only after the Provider returns a
      // result. Transport failures and local aborts never consume the authorization window.
      this.#authorizationCallsUsed += 1;
      this.#settle(response.usage, call, reservedOutput);
      if (externalSignal?.aborted) {
        this.#close('cancelled', 'gateway-provider-call-cancelled');
        throw new AbortTurnError();
      }
      if (this.#nowMs() >= this.#deadlineMs) {
        this.#close('expired', 'gateway-wall-budget-exhausted');
        throw new AdmittedModelGatewayError('gateway-wall-budget-exhausted');
      }
      if (!this.#closed && this.#modelCallsUsed >= this.admission.limits.maxModelCalls) {
        this.#close('completed');
      }
      try {
        const completed: unknown = prepared?.succeeded(response);
        if (this.options.prepareRequestRequired && !synchronousVoidAllowed(completed)) {
          throw new Error('invalid-required-completion');
        }
      } catch {
        if (this.options.prepareRequestRequired) throw new AdmittedModelGatewayError('gateway-request-completion-failed');
        discard(); // Optional observers never regenerate a successful response.
      }
      return response;
    } catch (error) {
      this.#inFlight = false;
      if (error instanceof AdmittedModelGatewayError || error instanceof ProviderDispatchAuthorityDeniedError) {
        const terminal = error instanceof ProviderDispatchAuthorityDeniedError
          ? new AdmittedModelGatewayError('gateway-dispatch-authority-denied') : error;
        discard(safeAdmittedModelGatewayErrorCode(terminal));
        if (terminal.code === 'gateway-dispatch-authority-denied' || terminal.code === 'gateway-request-completion-failed') {
          this.#close('cancelled', terminal.code);
        }
        throw terminal;
      }
      // Arbitration is local scheduling, not evidence of Provider/model quality failure.
      // Its independent deadline timer can win before this lease's signal timer fires.
      const arbitration = error instanceof ProviderCallDiscardedError ? error : null;
      const expired = this.#nowMs() >= this.#deadlineMs
        || arbitration?.reasonCode === 'arbiter-deadline-exceeded';
      if (expired || arbitration || externalSignal?.aborted || error instanceof AbortTurnError || signal.aborted) {
        const terminal = expired
          ? 'gateway-wall-budget-exhausted'
          : 'gateway-provider-call-cancelled';
        discard(terminal);
        this.#close(expired ? 'expired' : 'cancelled', terminal);
        if (arbitration) throw new AdmittedModelGatewayError(terminal);
      } else {
        const terminal = providerFailureDiagnosticCode(error);
        discard(terminal);
        this.#providerErrorAttemptsUsed += 1;
        this.#providerDiagnosticCode = terminal;
        if (this.#modelCallsUsed >= this.admission.limits.maxModelCalls) {
          this.#close('provider_error', 'gateway-provider-call-failed');
        }
      }
      throw error;
    }
  }

  #reserve(request: ChatRequest, externalSignal: AbortSignal | undefined): {
    signal: AbortSignal;
    call: ChatProviderCall;
    reservedOutput: number;
  } {
    if (this.#closed) throw new AdmittedModelGatewayError('gateway-lease-closed');
    if (this.#inFlight) throw new AdmittedModelGatewayError('gateway-concurrent-call');
    if (externalSignal?.aborted) {
      this.#close('cancelled', 'gateway-provider-call-cancelled');
      throw new AdmittedModelGatewayError('gateway-lease-closed');
    }
    const now = this.#nowMs();
    const remainingMs = this.#deadlineMs - now;
    if (remainingMs <= 0) {
      this.#close('expired', 'gateway-wall-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-wall-budget-exhausted');
    }
    if (request.model !== this.admission.modelId) {
      throw new AdmittedModelGatewayError('gateway-model-binding-mismatch');
    }
    toolNames(request.tools);
    if (agentToolSetDigest(request.tools ?? []) !== this.#toolSetDigest) {
      throw new AdmittedModelGatewayError('gateway-toolset-binding-mismatch');
    }
    if (this.#modelCallsUsed >= this.admission.limits.maxModelCalls) {
      this.#close('budget_exhausted', 'gateway-model-call-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-model-call-budget-exhausted');
    }
    const estimatedInput = estimateAdmittedRequestInputTokens(request);
    const remainingInput = this.admission.limits.maxInputTokens - this.#inputTokensUsed;
    if (estimatedInput > remainingInput) {
      this.#close('budget_exhausted', 'gateway-input-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-input-budget-exhausted');
    }
    const remainingOutput = this.admission.limits.maxOutputTokens - this.#outputTokensUsed;
    if (remainingOutput < 1) {
      this.#close('budget_exhausted', 'gateway-output-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-output-budget-exhausted');
    }
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! < 1
      || request.max_tokens! > remainingOutput) {
      throw new AdmittedModelGatewayError('gateway-output-budget-invalid');
    }
    if (this.requestBounds && (estimatedInput > this.requestBounds.maxRequestInputTokens
      || request.max_tokens! > this.requestBounds.maxRequestOutputTokens
      || estimatedInput + request.max_tokens! + this.requestBounds.requestSafetyMarginTokens
        > this.requestBounds.providerContextWindowTokens)) {
      throw new AdmittedModelGatewayError('gateway-request-window-exceeded');
    }
    if (this.admission.limits.maxCostMicrousd > 0
      && this.#costMicrousdUsed >= this.admission.limits.maxCostMicrousd) {
      this.#close('budget_exhausted', 'gateway-cost-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-cost-budget-exhausted');
    }
    const call = Object.freeze({
      runId: this.admission.runId,
      parentRunId: this.admission.parentRunId,
      sessionId: this.admission.sessionId,
      lane: this.#lane,
      callIndex: this.#modelCallsUsed,
      deadlineAt: new Date(this.#deadlineMs).toISOString(),
      // Authorization is expressed in physical Provider requests. Hidden transport
      // retries would bypass the durable window, so admitted calls are single-attempt.
      maxTransportAttempts: 1,
    });
    // Never retain request/prose. A failed preflight has not reserved a physical call.
    const requestDigest = `sha256:${createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex')}`;
    this.#lastRequestDigest = requestDigest;
    this.#modelCallsUsed += 1;
    this.#inFlight = true;
    return { signal: deadlineSignal(externalSignal, remainingMs), call, reservedOutput: request.max_tokens! };
  }

  #settle(rawUsage: ChatResponse['usage'], call: ChatProviderCall, reservedOutput: number): void {
    const usage = safeUsage(rawUsage);
    if (!usage) {
      this.#close('usage_unavailable', rawUsage ? 'gateway-provider-usage-invalid' : 'gateway-provider-usage-unavailable');
      throw new AdmittedModelGatewayError(rawUsage
        ? 'gateway-provider-usage-invalid'
        : 'gateway-provider-usage-unavailable');
    }
    let cost: number | undefined;
    try {
      cost = this.options.estimateCostMicrousd?.(usage, call);
    } catch {
      this.#close('usage_unavailable', 'gateway-cost-estimator-unavailable');
      throw new AdmittedModelGatewayError('gateway-cost-estimator-unavailable');
    }
    if (!Number.isSafeInteger(cost) || cost! < 0) {
      this.#close('usage_unavailable', 'gateway-cost-estimator-unavailable');
      throw new AdmittedModelGatewayError('gateway-cost-estimator-unavailable');
    }
    const nextInput = this.#inputTokensUsed + usage.prompt_tokens;
    const nextOutput = this.#outputTokensUsed + usage.completion_tokens;
    const nextCost = this.#costMicrousdUsed + cost!;
    if (!Number.isSafeInteger(nextInput) || !Number.isSafeInteger(nextOutput) || !Number.isSafeInteger(nextCost)) {
      this.#close('usage_unavailable', 'gateway-provider-usage-invalid');
      throw new AdmittedModelGatewayError('gateway-provider-usage-invalid');
    }
    // Provider usage is the sole token truth. Record the actual spend even when the call
    // crossed a ceiling; closing the lease prevents that overrun becoming new authority.
    this.#inputTokensUsed = nextInput;
    this.#outputTokensUsed = nextOutput;
    this.#costMicrousdUsed = nextCost;
    if (this.requestBounds && (usage.prompt_tokens > this.requestBounds.maxRequestInputTokens
      || usage.prompt_tokens + usage.completion_tokens + this.requestBounds.requestSafetyMarginTokens
        > this.requestBounds.providerContextWindowTokens)) {
      this.#close('budget_exhausted', 'gateway-request-window-exceeded');
      throw new AdmittedModelGatewayError('gateway-request-window-exceeded');
    }
    if (nextInput > this.admission.limits.maxInputTokens) {
      this.#close('budget_exhausted', 'gateway-input-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-input-budget-exhausted');
    }
    if (usage.completion_tokens > reservedOutput
      || nextOutput > this.admission.limits.maxOutputTokens) {
      this.#close('budget_exhausted', 'gateway-output-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-output-budget-exhausted');
    }
    if (nextCost > this.admission.limits.maxCostMicrousd) {
      this.#close('budget_exhausted', 'gateway-cost-budget-exhausted');
      throw new AdmittedModelGatewayError('gateway-cost-budget-exhausted');
    }
  }

  #close(outcome: AdmittedModelLeaseOutcome, reasonCode?: AdmittedModelGatewayErrorCode): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outcome = outcome;
    this.#reasonCode = reasonCode;
    const finishedAt = new Date(this.#nowMs()).toISOString();
    const audit: AdmittedModelLeaseAudit = Object.freeze({
      ...this.snapshot(),
      leaseIdDigest: ticketDigest(this.admission.ticketId),
      ...(this.admission.quotaReservationDigest
        ? { quotaReservationDigest: this.admission.quotaReservationDigest }
        : {}),
      runId: this.admission.runId,
      parentRunId: this.admission.parentRunId,
      sessionId: this.admission.sessionId,
      sourceRevision: this.admission.sourceRevision,
      lane: this.admission.lane,
      taskKind: this.admission.taskKind,
      policyVersion: this.admission.policyVersion,
      evidenceDigests: this.admission.evidenceDigests,
      modelId: this.admission.modelId,
      budgetProfileDigest: this.admission.budgetProfileDigest,
      toolSetDigest: this.admission.toolSetDigest,
      startedAt: new Date(this.admission.consumedAtMs).toISOString(),
      finishedAt,
    });
    this.#closedAudit = audit;
    try {
      this.options.onLeaseClosed?.(audit);
    } catch {
      try { this.options.onAuditError?.('gateway-lease-audit-failed'); } catch { /* preserve stable error */ }
      if (this.options.auditRequired) {
        throw new AdmittedModelGatewayError('gateway-lease-audit-failed');
      }
    }
  }
}

/** Server-only gate that exchanges one signed Ticket for one bounded runtime lease. */
export class AdmittedModelGateway {
  constructor(
    private readonly broker: AdmissionTicketBroker,
    private readonly delegate: ChatCompletionClient,
    private readonly options: AdmittedModelGatewayOptions = {},
  ) {}

  open(input: AdmittedModelLeaseRequest): AdmittedModelLease {
    if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
      throw new AdmittedModelGatewayError('gateway-model-required');
    }
    const profileInput = input.binding.budgetProfile;
    const isV3 = profileInput.version === AGENT_GATEWAY_BUDGET_PROFILE_V3;
    const budgetProfile = isV3
      ? normalizeAgentGatewayBudgetProfileV3(profileInput as AgentGatewayBudgetProfileV3)
      : normalizeAgentBudgetProfile(profileInput as AgentBudgetProfileInput);
    if (isV3 && (input.binding.taskKind !== 'context_compiler'
      || input.binding.policyVersion !== 'p14-q9r-context-compiler-v2')) {
      throw new AdmittedModelGatewayError('gateway-budget-lane-mismatch');
    }
    const limits = isV3
      ? admissionLimitsFromGatewayBudgetProfileV3(budgetProfile as AgentGatewayBudgetProfileV3)
      : admissionLimitsFromBudgetProfile(budgetProfile as AgentBudgetProfileInput);
    if (input.modelCallLimit !== undefined && (!Number.isSafeInteger(input.modelCallLimit)
      || input.modelCallLimit < 1 || input.modelCallLimit > limits.maxModelCalls)) {
      throw new AdmissionTicketError('ticket-budget-escalation');
    }
    const actualTools = toolNames(input.tools);
    const admission = this.broker.begin({
      ticketId: input.binding.ticketId,
      runId: input.binding.runId,
      parentRunId: input.binding.parentRunId,
      sessionId: input.binding.sessionId,
      sourceRevision: input.binding.sourceRevision,
      lane: input.binding.lane,
      taskKind: input.binding.taskKind,
      policyVersion: input.binding.policyVersion,
      modelId: input.modelId,
      budgetProfileDigest: isV3 ? agentGatewayBudgetProfileDigestV3(budgetProfile as AgentGatewayBudgetProfileV3)
        : agentBudgetProfileDigest(budgetProfile as AgentBudgetProfileInput),
      toolSetDigest: agentToolSetDigest(input.tools ?? []),
      mode: input.binding.mode,
      allowedTools: actualTools,
      limits: { ...limits, maxModelCalls: input.modelCallLimit ?? limits.maxModelCalls },
    });
    if (budgetProfile.lane !== expectedBudgetLane(input.binding.taskKind)) {
      throw new AdmittedModelGatewayError('gateway-budget-lane-mismatch');
    }
    if (!this.options.estimateCostMicrousd) {
      throw new AdmittedModelGatewayError('gateway-cost-estimator-unavailable');
    }
    const baseOptions = this.options;
    const options = baseOptions.prepareRequest || baseOptions.authorizeDispatch !== undefined ? {
      ...baseOptions,
      authorizeDispatch: (lease: AdmissionLease) => this.broker.mayDispatchLease(lease)
        && (baseOptions.authorizeDispatch === undefined
          || synchronousDispatchVerdictAllowed(baseOptions.authorizeDispatch(lease))),
    } : baseOptions;
    return new AdmittedModelLease(admission, input.binding, this.delegate, options,
      isV3 ? budgetProfile as AgentGatewayBudgetProfileV3 : undefined);
  }

  async complete(input: AdmittedModelRequest): Promise<ChatResponse> {
    const modelId = input.request.model;
    if (typeof modelId !== 'string' || modelId.length === 0) {
      throw new AdmittedModelGatewayError('gateway-model-required');
    }
    const lease = this.open({ binding: input.binding, modelId, tools: input.request.tools });
    try {
      const response = await lease.complete(input.request, input.signal);
      lease.finish('completed');
      return response;
    } catch (error) {
      lease.finish(
        input.signal?.aborted ? 'cancelled' : 'provider_error',
        input.signal?.aborted ? 'gateway-provider-call-cancelled' : 'gateway-provider-call-failed',
      );
      throw error;
    }
  }

  async stream(
    input: AdmittedModelRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
  ): Promise<ChatResponse> {
    const modelId = input.request.model;
    if (typeof modelId !== 'string' || modelId.length === 0) {
      throw new AdmittedModelGatewayError('gateway-model-required');
    }
    const lease = this.open({ binding: input.binding, modelId, tools: input.request.tools });
    try {
      const response = await lease.stream(input.request, onDelta, onToolArg, input.signal);
      lease.finish('completed');
      return response;
    } catch (error) {
      lease.finish(
        input.signal?.aborted ? 'cancelled' : 'provider_error',
        input.signal?.aborted ? 'gateway-provider-call-cancelled' : 'gateway-provider-call-failed',
      );
      throw error;
    }
  }
}
