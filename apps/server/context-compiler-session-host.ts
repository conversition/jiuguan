import type { SessionArgs, ChatSession } from '../../packages/session/public/session.ts';
import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import type { ProviderRegistry, ProviderConfig } from '../../packages/proxy/public/provider-runtime.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/public/model-runtime-profile.ts';
import { sha256Digest } from '../../packages/memory/public/learning-outbox.ts';
import { CONTEXT_COMPILER_POLICY_VERSION, ContextCapsuleCache, buildContextCompilerModelRequest,
  buildContextCompilerRepairRequest, contextCompilerSourceDigest, parseContextCapsule, partitionContextCompilerSources }
  from '../../packages/harness/context-compiler.ts';
import { planContextCompilerBatches } from '../../packages/harness/context-compiler-batch.ts';
import { CONTEXT_COMPILER_INPUT_VERSION, parseContextCompilerInput, contextCompilerInputManifest }
  from '../../packages/agent-policy/public/context-compiler-input.ts';
import { admissionLimitsFromBudgetProfile, admissionLimitsFromGatewayBudgetProfileV3, agentToolSetDigest }
  from '../../packages/agent-policy/public/admission.ts';
import { agentBudgetProfileDigest, AGENT_GATEWAY_BUDGET_PROFILE_V3, normalizeAgentGatewayBudgetProfileV3,
  agentGatewayBudgetProfileDigestV3 } from '../../packages/agent-policy/public/budget-profile.ts';
import { createContextCompilerSkillLiveCall, createContextCompilerSkillLiveRecoveryCall } from './skill-hub/context-compiler-live.ts';
import { createContextCompilerSkillLiveBatchCall } from './skill-hub/context-compiler-batch-live.ts';
import { agentSkillLiveEnabled } from './skill-hub/live-request.ts';
import { createForegroundSkillHostAuthority } from './skill-hub/foreground-host-authority.ts';
import { parseContextCompilerRuntimeConfig, type ContextCompilerRuntimeConfig } from './context-compiler-runtime-config.ts';
import { ContextCompilerCanarySamples } from './context-compiler-canary.ts';
import { buildContextCompilerShadowRequest } from './context-compiler-shadow-runner.ts';
import { contextCompilerFailureDiagnostic } from './context-compiler-failure.ts';
import { AdmittedModelGateway, estimateAdmittedRequestInputTokens, type AdmittedModelLeaseAudit } from './admitted-model-gateway.ts';
import type { AdmissionTicketBroker, AgentAdmissionLease } from './agent-admission-broker.ts';
import type { AgentClosureRecorder } from './agent-closure-recorder.ts';
import type { configuredModelUsageCostEstimator } from './model-usage-client.ts';
import type { createTurnOperationHost } from './turn-operation-host.ts';
import type { TurnOperationPhase } from './turn-operation-runtime.ts';

type Selection = { readonly providerId: string; readonly model: string };
type Admission = NonNullable<SessionArgs['agentAdmission']>;
type CompilerCallbacks = Required<Pick<Admission, 'contextCompilerRequired' | 'contextCompilerSkillRequired' | 'compileContext'
  | 'assertContextCompilerCurrent' | 'prepareContextConsumption' | 'assertContextCompilerSkillCurrent' | 'observeContextConsumption'>>;

/** The live server owns these authorities and supplies the exact same objects to the isolated runtime. */
export interface ContextCompilerSessionDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly CONTEXT_COMPILER_RUNTIME: ContextCompilerRuntimeConfig;
  readonly CONTEXT_COMPILER_CANARY: ContextCompilerCanarySamples | null;
  readonly CONTEXT_CAPSULE_CACHE: ContextCapsuleCache;
  readonly AGENT_ADMISSION_BROKER: AdmissionTicketBroker;
  readonly AGENT_CLOSURE_STORE: object | null;
  readonly AGENT_CLOSURE_RECORDER: AgentClosureRecorder | null;
  readonly MODEL_USAGE_COST: NonNullable<ReturnType<typeof configuredModelUsageCostEstimator>>;
  readonly SKILL_CONSUMPTION_SCHEDULER: { schedule(id: string): void } | null;
  readonly sessions: ReadonlyMap<string, ChatSession>;
  readonly sessionDeletionAdmissionOpen: (id: string) => boolean;
  readonly agentModelBinding: () => { selection: Selection; client: ChatCompletionClient };
  readonly modelRuntimeProfileFor: (selection: Selection, client: ChatCompletionClient) => ModelRuntimeProfile;
  readonly contextCompilerRuntimeAllows: (config: ContextCompilerRuntimeConfig, sessionId: string) => boolean;
  readonly operationHost: () => ReturnType<typeof createTurnOperationHost> | undefined;
  readonly turnOperationClientForServer: (sessionId: string, runId: string | undefined,
    phase: TurnOperationPhase, client: ChatCompletionClient) => ChatCompletionClient;
  readonly foregroundSkillHostForSession: (sessionId: string, session: ChatSession,
    readEligibility: Parameters<typeof createForegroundSkillHostAuthority>[0]['readEligibility']) => ReturnType<typeof createForegroundSkillHostAuthority>;
  readonly arbitratedAgentClient: (client: ChatCompletionClient, selection: Selection, entry: 'context-compiler') => ChatCompletionClient;
  readonly providerRegistry: Pick<ProviderRegistry, 'bindingToken' | 'describe'>;
  readonly readProviderGeneration: () => number;
  readonly loadProviderConfig: () => ProviderConfig;
  readonly recordAgentRuntimeLease: (entry: AdmittedModelLeaseAudit) => void;
  readonly parseContextCompilerRuntimeConfig: typeof parseContextCompilerRuntimeConfig;
  readonly partitionContextCompilerSources: typeof partitionContextCompilerSources;
  readonly createContextCompilerSkillLiveCall: typeof createContextCompilerSkillLiveCall;
}

/** Compiler request and its consumption proof share one exact-session state. */
export function createContextCompilerSessionHost(deps: ContextCompilerSessionDependencies, rawSessionId: string): CompilerCallbacks {
  const { CONTEXT_COMPILER_RUNTIME, CONTEXT_COMPILER_CANARY, CONTEXT_CAPSULE_CACHE, AGENT_ADMISSION_BROKER,
    AGENT_CLOSURE_STORE, AGENT_CLOSURE_RECORDER, MODEL_USAGE_COST, SKILL_CONSUMPTION_SCHEDULER, sessions,
    sessionDeletionAdmissionOpen, agentModelBinding, modelRuntimeProfileFor, contextCompilerRuntimeAllows,
    turnOperationClientForServer, foregroundSkillHostForSession, arbitratedAgentClient, providerRegistry,
    loadProviderConfig, recordAgentRuntimeLease, parseContextCompilerRuntimeConfig,
    partitionContextCompilerSources, createContextCompilerSkillLiveCall } = deps;
  let pendingContextSkill: ReturnType<typeof createContextCompilerSkillLiveCall> | ReturnType<typeof createContextCompilerSkillLiveRecoveryCall>
    | ReturnType<typeof createContextCompilerSkillLiveBatchCall> | null = null;
  let pendingContextSkillCurrent: (() => void) | null = null;
  let pendingContextCanaryCurrent: (() => void) | null = null;
  return {
      contextCompilerRequired: () => {
        try { return contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(deps.env), rawSessionId); }
        catch { throw new Error('context-compiler-skill-runtime-invalid'); }
      },
      contextCompilerSkillRequired: () => {
        if (!agentSkillLiveEnabled(deps.env)) return false;
        try { return contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(deps.env), rawSessionId); }
        catch { throw new Error('context-compiler-skill-runtime-invalid'); }
      },
      compileContext: async (input) => {
        pendingContextSkill = null;
        pendingContextSkillCurrent = null;
        pendingContextCanaryCurrent = null;
        const skillLive = agentSkillLiveEnabled(deps.env);
        try {
          if (!contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(deps.env), rawSessionId)) return null;
        } catch {
          throw new Error('context-compiler-skill-runtime-invalid');
        }
        // The callback is bound to one Session. An allowlist with several
        // sessions is not authority to compile one session's input as another.
        if (input.rawSessionId !== rawSessionId) {
          throw new Error('context-compiler-skill-source-invalid');
        }
        if (skillLive && !AGENT_CLOSURE_STORE) {
          throw new Error('context-compiler-skill-unavailable');
        }
        let live;
        let provider: Selection;
        let client: ChatCompletionClient;
        try {
          ({ selection: provider, client } = agentModelBinding());
        } catch {
          throw new Error('context-compiler-skill-model-unavailable');
        }
        try {
          live = parseContextCompilerRuntimeConfig(
            deps.env,
            modelRuntimeProfileFor(provider, client),
          );
        } catch {
          throw new Error('context-compiler-skill-runtime-invalid');
        }
        if (!contextCompilerRuntimeAllows(live, input.rawSessionId)
          || !live.budgetProfile || input.runId === 'missing-run') {
          throw new Error('context-compiler-skill-admission-denied');
        }
        const operationHost = deps.operationHost();
        const operationActive = Boolean(operationHost?.hasRun(input.runId));
        if (operationActive && live.mode === 'canary') throw new Error('context-compiler-canary-operation-unsupported');
        const recovery = operationActive;
        if (recovery && !skillLive) throw new Error('context-compiler-skill-live-required');
        const policyVersion = recovery ? 'p14-q9r-context-compiler-v2' : CONTEXT_COMPILER_POLICY_VERSION;
        const compilerBudget = recovery ? operationHost!.compilerBudget(input.runId) : null;
        if (compilerBudget && compilerBudget.hold.calls < 2) throw new Error('context-compiler-repair-budget-unavailable');
        const recoveryProfile = compilerBudget ? normalizeAgentGatewayBudgetProfileV3({
          version: AGENT_GATEWAY_BUDGET_PROFILE_V3, lane: 'interactive', maxModelCalls: Math.min(4, compilerBudget.hold.calls), maxToolCalls: 0,
          agentInputBudgetTokens: Math.min(compilerBudget.hold.inputTokens, live.budgetProfile.agentInputBudgetTokens * Math.min(4, compilerBudget.hold.calls)),
          agentOutputBudgetTokens: Math.min(compilerBudget.hold.outputTokens, live.budgetProfile.agentOutputBudgetTokens * Math.min(4, compilerBudget.hold.calls)),
          maxCostMicrousd: Math.min(compilerBudget.hold.costMicrousd, live.budgetProfile.maxCostMicrousd * Math.min(4, compilerBudget.hold.calls)),
          maxWallMs: live.budgetProfile.maxWallMs,
          providerContextWindowTokens: compilerBudget.binding.contextWindowTokens,
          maxRequestInputTokens: Math.min(live.budgetProfile.agentInputBudgetTokens, compilerBudget.binding.maxRequestInputTokens,
            compilerBudget.hold.inputTokens),
          maxRequestOutputTokens: Math.min(live.budgetProfile.agentOutputBudgetTokens, compilerBudget.binding.maxRequestOutputTokens,
            compilerBudget.hold.outputTokens),
          requestSafetyMarginTokens: compilerBudget.binding.requestSafetyMarginTokens,
        }) : null;
        const compilerInputLimit = recoveryProfile?.maxRequestInputTokens ?? live.budgetProfile.agentInputBudgetTokens;
        const compilerOutputLimit = recoveryProfile?.maxRequestOutputTokens ?? live.budgetProfile.agentOutputBudgetTokens;
        const baseProfileDigest = agentBudgetProfileDigest(live.budgetProfile);
        const profileDigest = recoveryProfile ? agentGatewayBudgetProfileDigestV3(recoveryProfile) : baseProfileDigest;
        let pendingAudit: AdmittedModelLeaseAudit | undefined;
        let failureStage: 'preparation' | 'gateway' | 'validation' | 'receipt' = 'preparation';
        let gatewayCallsStarted = 0;
        let responsesReceived = 0;
        let finishReason: string | null = null;
        const recordResponseDiagnostic = (response: { finishReason?: string | null }) => {
          responsesReceived++;
          finishReason = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(response.finishReason ?? '')
            ? response.finishReason! : 'unknown';
        };
        const execution = { mode: recovery ? 'operation-v3' : 'legacy-single-call', recoveryEnabled: recovery,
          policyVersion, maxModelCalls: recoveryProfile?.maxModelCalls ?? live.budgetProfile.maxModelCalls };
        console.info('[context-compiler-mode]', JSON.stringify(execution));
        let preflightCapacityFailure: ReturnType<typeof contextCompilerFailureDiagnostic> | undefined;
        let settleCanary: ((outcome: 'success' | 'failure') => void) | undefined;
        let auditRecorded = false;
        const recordPendingAudit = () => {
          if (!pendingAudit || auditRecorded) return false;
          auditRecorded = true;
          try { recordAgentRuntimeLease(pendingAudit); }
          catch { throw new Error('context-compiler-skill-audit-failed'); }
          return true;
        };
        let closureIdentity: {
          rawSessionId: string;
          runId: string;
          sourceRevision: string;
          sourceDigest: string;
          executionClass: 'operational-replay' | 'fixture';
          policyVersion?: 'p14-q9r-context-compiler-v1' | 'p14-q9r-context-compiler-v2';
        } | null = null;
        try {
          const capturedInput = parseContextCompilerInput({ version: CONTEXT_COMPILER_INPUT_VERSION,
            sources: input.sources, targetTokens: input.targetTokens });
          const sourceDigest = contextCompilerSourceDigest(capturedInput.sources);
          const sourceManifest = skillLive ? contextCompilerInputManifest(capturedInput) : null;
          closureIdentity = {
            rawSessionId: input.rawSessionId,
            runId: input.runId,
            sourceRevision: input.sourceRevision,
            sourceDigest,
            ...(recovery ? { policyVersion: 'p14-q9r-context-compiler-v2' as const } : {}),
            // An exact Canary binding is not proof of production provenance.
            // Keep its closure in the non-production class until independently witnessed.
            executionClass: live.mode === 'canary' ? 'fixture' : 'operational-replay',
          };
          AGENT_CLOSURE_RECORDER?.beginContextCompiler(closureIdentity);
          // Live attribution is per physical call. Until an attribution-aware cache is added,
          // it neither consumes nor populates the legacy (source-only) cache.
          const cached = skillLive || recovery || live.mode === 'canary' ? null : CONTEXT_CAPSULE_CACHE.get(sourceDigest, capturedInput.targetTokens);
          if (cached) {
            AGENT_CLOSURE_RECORDER?.completeContextCompiler({
              ...closureIdentity,
              capsuleDigest: sha256Digest(JSON.stringify(cached)),
              cached: true,
            });
            return cached;
          }

          // One Provider call is the hard ceiling. Once enabled for this session,
          // oversized input fails instead of silently changing the execution path.
          const maxSourceTokens = Math.max(256, compilerInputLimit - 1_500);
          const batchPlan = recovery ? planContextCompilerBatches({ sources: capturedInput.sources,
            targetTokens: capturedInput.targetTokens, maxSourceTokens }) : null;
          const batches = batchPlan?.batches ?? partitionContextCompilerSources(capturedInput.sources, maxSourceTokens);
          if (!recovery && batches.length !== 1) {
            AGENT_CLOSURE_RECORDER?.failContextCompiler(closureIdentity, 'context-compiler-multi-batch');
            throw new Error('context-compiler-skill-input-budget-exhausted');
          }
          if (recovery && batches.length === 2 && compilerBudget!.hold.calls < 4)
            throw new Error('context-compiler-repair-budget-unavailable');
          const compiled = (live.mode === 'canary' ? buildContextCompilerShadowRequest : buildContextCompilerModelRequest)({
            sources: batches[0]!,
            targetTokens: capturedInput.targetTokens,
            maxInputTokens: compilerInputLimit,
            maxOutputTokens: compilerOutputLimit,
          });
          const tools: Record<string, unknown>[] = [];
          const session = sessions.get(rawSessionId);
          const recoveryTurn = recovery ? session?.readAgentSkillTurnContext(input.runId) : null;
          const assertRecoveryCurrent = () => {
            if (!recovery) return;
            operationHost!.assertCurrent(input.runId);
            const current = session?.readAgentSkillTurnContext(input.runId);
            if (input.signal?.aborted || !session || sessions.get(rawSessionId) !== session
              || !sessionDeletionAdmissionOpen(rawSessionId) || !recoveryTurn || !current
              || recoveryTurn.sessionId !== input.ticketSessionId || recoveryTurn.sourceRevision !== input.sourceRevision
              || current.sessionId !== recoveryTurn.sessionId || current.sourceRevision !== recoveryTurn.sourceRevision
              || current.contentMode !== recoveryTurn.contentMode || current.assetRevision !== recoveryTurn.assetRevision
              || current.worldbookSourceRevision !== recoveryTurn.worldbookSourceRevision)
              throw new Error('context-compiler-skill-source-stale');
          };
          assertRecoveryCurrent();
          const canaryTurn = live.mode === 'canary' ? session?.readAgentSkillTurnContext(input.runId) : null;
          const canaryRegistration = live.mode === 'canary' ? providerRegistry.bindingToken(provider.providerId) : null;
          const canaryGeneration = live.mode === 'canary' ? deps.readProviderGeneration() : null;
          // Only held in memory: never publish a provider configuration or credential digest.
          const canaryProviderBinding = () => sha256Digest(JSON.stringify({ configuration: loadProviderConfig(),
            descriptor: providerRegistry.describe(provider.providerId) }));
          const expectedCanaryProviderBinding = live.mode === 'canary' ? canaryProviderBinding() : null;
          const assertCanaryCurrent = () => {
            if (live.mode !== 'canary') return;
            const currentTurn = session?.readAgentSkillTurnContext(input.runId);
            if (!canaryRegistration || providerRegistry.bindingToken(provider.providerId) !== canaryRegistration
              || deps.readProviderGeneration() !== canaryGeneration || canaryProviderBinding() !== expectedCanaryProviderBinding
              || !session || sessions.get(rawSessionId) !== session || !sessionDeletionAdmissionOpen(rawSessionId)
              || input.signal?.aborted || !canaryTurn || !currentTurn
              || canaryTurn.sessionId !== input.ticketSessionId || canaryTurn.sourceRevision !== input.sourceRevision
              || canaryTurn.contentMode !== input.contentMode || currentTurn.sessionId !== canaryTurn.sessionId
              || currentTurn.sourceRevision !== canaryTurn.sourceRevision || currentTurn.contentMode !== canaryTurn.contentMode
              || currentTurn.assetRevision !== canaryTurn.assetRevision
              || currentTurn.worldbookSourceRevision !== canaryTurn.worldbookSourceRevision
              || !contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(deps.env), rawSessionId))
              throw new Error('context-canary-authority-stale');
          };
          const countedClient: ChatCompletionClient = live.mode !== 'canary' ? client : {
            ...client,
            complete: (request, signal, call) => {
              assertCanaryCurrent();
              return client.complete(request, signal, { ...call, beforeAdapterDispatch: () => {
                assertCanaryCurrent();
                if (!CONTEXT_COMPILER_CANARY || settleCanary) throw new Error('context-canary-dispatch-invalid');
                settleCanary = CONTEXT_COMPILER_CANARY.begin({ sessionId: rawSessionId, providerId: provider.providerId,
                  model: provider.model, profileDigest: agentBudgetProfileDigest(live.budgetProfile!) });
              } });
            },
          };
          if (skillLive && !session) throw new Error('context-compiler-skill-session-unavailable');
          const skillHost = skillLive && session ? foregroundSkillHostForSession(rawSessionId, session, (lease) => {
            const current = parseContextCompilerRuntimeConfig(deps.env, modelRuntimeProfileFor(provider, client));
            if (recovery) operationHost!.assertCurrent(input.runId);
            return { revision: sha256Digest(JSON.stringify(current.budgetProfile)),
              allowed: contextCompilerRuntimeAllows(current, rawSessionId)
                && Boolean(current.budgetProfile && agentBudgetProfileDigest(current.budgetProfile) === baseProfileDigest
                  && profileDigest === lease.budgetProfileDigest) };
          }) : null;
          const skillCall = skillLive && session ? (recovery ? createContextCompilerSkillLiveBatchCall({
            broker: AGENT_ADMISSION_BROKER,
            identity: closureIdentity, executionClass: closureIdentity.executionClass,
            authority: skillHost!.authority, sourceInput: { ...capturedInput, maxSourceTokens },
            maxInputTokens: compilerInputLimit, maxOutputTokens: compilerOutputLimit, model: provider.model,
          }) : createContextCompilerSkillLiveCall({
            broker: AGENT_ADMISSION_BROKER, policyVersion,
            identity: closureIdentity, executionClass: closureIdentity.executionClass, authority: skillHost!.authority,
            sourceManifest: sourceManifest!, sourceRequest: { ...compiled.request, model: provider.model },
          })) : null;
          if (skillLive && (!skillHost || !skillCall)) throw new Error('context-compiler-skill-host-unavailable');
          let contextLease: AgentAdmissionLease | undefined;
          let permission: string | null = null;
          const assertCurrent = () => {
            if (recovery) operationHost!.assertCurrent(input.runId);
            if (!permission || !contextLease || !agentSkillLiveEnabled(deps.env) || !AGENT_CLOSURE_STORE
              || input.signal?.aborted || skillHost?.permissionSnapshot(contextLease) !== permission) {
              throw new Error('context-compiler-skill-source-stale');
            }
          };
          const gateway = new AdmittedModelGateway(AGENT_ADMISSION_BROKER,
            turnOperationClientForServer(rawSessionId, input.runId, 'compiler',
              arbitratedAgentClient(countedClient, provider, 'context-compiler')), {
            estimateCostMicrousd: (usage, call) => MODEL_USAGE_COST(usage, call)?.costMicrousd,
            onLeaseClosed: (entry) => {
              if (!skillLive) { recordAgentRuntimeLease(entry); return; }
              if (pendingAudit || auditRecorded) throw new Error('context-compiler-skill-audit-failed');
              pendingAudit = entry;
            },
            auditRequired: true,
            ...(skillLive ? { prepareRequestRequired: true } : {}),
            ...(skillCall ? { async prepareRequest(candidate) {
              const prepared = await skillCall.prepareRequest(candidate);
              if (prepared) {
                if (recovery && candidate.request === undefined) throw new Error('context-compiler-repair-budget-unavailable');
                if (recovery && !contextLease) {
                  try {
                  const minimum = buildContextCompilerRepairRequest({ sources: batches[0]!,
                    targetTokens: capturedInput.targetTokens, maxInputTokens: compilerInputLimit, maxOutputTokens: compilerOutputLimit,
                    previousContent: '', issue: { code: 'context-capsule-json-invalid', path: '$' } }).request;
                  const first = estimateAdmittedRequestInputTokens(prepared.request);
                  const original = estimateAdmittedRequestInputTokens(candidate.request);
                  const extra = Math.max(0, first - original);
                  const minInput = estimateAdmittedRequestInputTokens(minimum) + extra;
                  const reserve = (tokens: number, messages: number) => tokens + Math.max(64, Math.ceil(tokens * 0.05)) + messages * 8;
                  const firstReserve = reserve(first, prepared.request.messages.length);
                  const repairReserve = reserve(minInput, minimum.messages.length
                    + Math.max(0, prepared.request.messages.length - candidate.request.messages.length));
                  const second = batches.length === 2 ? buildContextCompilerModelRequest({ sources: batches[1]!,
                    targetTokens: capturedInput.targetTokens, maxInputTokens: compilerInputLimit, maxOutputTokens: compilerOutputLimit }).request : null;
                  const secondInput = second ? estimateAdmittedRequestInputTokens(second) + extra : 0;
                  const secondReserve = second ? reserve(secondInput, second.messages.length
                    + Math.max(0, prepared.request.messages.length - candidate.request.messages.length)) : 0;
                  // The exact merge depends on validated batch responses; this is a lower bound
                  // only. The actual merge is independently checked before its own dispatch.
                  const mergeMinimum = second ? extra + 64 : 0;
                  const mergeReserve = second ? reserve(mergeMinimum, prepared.request.messages.length) : 0;
                  const callCount = second ? 4 : 2;
                  const perOutput = candidate.request.max_tokens!;
                  const output = perOutput * callCount;
                  const cost = (inputTokens: number) => Number((BigInt(inputTokens) * BigInt(compilerBudget!.binding.inputMicrousdPerMillionTokens)
                    + BigInt(perOutput) * BigInt(compilerBudget!.binding.outputMicrousdPerMillionTokens) + 999_999n) / 1_000_000n);
                  if (minInput > recoveryProfile!.maxRequestInputTokens
                    || minInput + perOutput + recoveryProfile!.requestSafetyMarginTokens > recoveryProfile!.providerContextWindowTokens
                    || firstReserve + repairReserve + secondReserve + mergeReserve > compilerBudget!.hold.inputTokens || output > compilerBudget!.hold.outputTokens
                    || cost(firstReserve) + cost(repairReserve) + (second ? cost(secondReserve) + cost(mergeReserve) : 0) > compilerBudget!.hold.costMicrousd
                    || first + minInput + secondInput + mergeMinimum > recoveryProfile!.agentInputBudgetTokens
                    || output > recoveryProfile!.agentOutputBudgetTokens)
                    throw new Error('context-compiler-repair-budget-unavailable');
                  } catch (error) {
                    const diagnostic = contextCompilerFailureDiagnostic(error);
                    if (diagnostic.category === 'capacity') preflightCapacityFailure = diagnostic;
                    throw error;
                  }
                }
                contextLease = candidate.lease;
                permission = skillHost!.permissionSnapshot(contextLease);
                assertCurrent();
              }
              return prepared;
            }, authorizeDispatch: skillHost!.authorizeDispatch } : {}),
          });
          const ticket = AGENT_ADMISSION_BROKER.issue({
            runId: input.runId,
            parentRunId: input.runId,
            sessionId: input.ticketSessionId,
            sourceRevision: input.sourceRevision,
            lane: 'interactive',
            taskKind: 'context_compiler',
            policyVersion,
            modelId: provider.model,
            budgetProfileDigest: profileDigest,
            toolSetDigest: agentToolSetDigest(tools),
            mode: input.contentMode,
            reasonCodes: ['elastic-context-recovery-required'],
            evidenceDigests: [recovery ? sourceDigest : compiled.expectation.sourceDigest],
            noveltyDigest: recovery ? sourceDigest : compiled.expectation.sourceDigest,
            expectedBenefit: 'context-recovery',
            limits: recoveryProfile ? admissionLimitsFromGatewayBudgetProfileV3(recoveryProfile) : admissionLimitsFromBudgetProfile(live.budgetProfile),
            deadlineMs: Math.min(Date.now() + live.budgetProfile.maxWallMs, compilerBudget?.deadlineMs ?? Number.MAX_SAFE_INTEGER),
            allowedTools: [],
            fullSkillSnapshots: [],
            cooldownKey: `context-compiler:${input.ticketSessionId}`,
            idempotencyKey: `admit:${input.runId.slice(0, 120)}:context:${sourceDigest.slice(-16)}`,
            fallback: 'continue-deterministic',
          });
          const binding = {
              ticketId: ticket.ticketId,
              runId: ticket.runId,
              parentRunId: ticket.parentRunId,
              sessionId: ticket.sessionId,
              sourceRevision: ticket.sourceRevision,
              lane: ticket.lane,
              taskKind: ticket.taskKind,
              policyVersion: ticket.policyVersion,
              mode: ticket.mode,
              budgetProfile: recoveryProfile ?? live.budgetProfile,
            };
          let capsule;
          let compactResult: ReturnType<ReturnType<typeof createContextCompilerSkillLiveBatchCall>['result']> | null = null;
          if (recovery) {
            const lease = gateway.open({ binding, modelId: provider.model, tools });
            const recoveryCall = skillCall as ReturnType<typeof createContextCompilerSkillLiveBatchCall>;
            try {
              for (;;) {
                failureStage = 'preparation';
                assertRecoveryCurrent();
                if (contextLease) assertCurrent();
                const request = recoveryCall.nextRequest();
                failureStage = 'gateway';
                gatewayCallsStarted++;
                const response = await lease.complete(request, input.signal);
                recordResponseDiagnostic(response);
                failureStage = 'validation';
                if (recoveryCall.recordResponse(response)) break;
              }
              compactResult = recoveryCall.result();
              capsule = compactResult.capsule;
              assertRecoveryCurrent();
              assertCurrent();
              lease.finish('completed');
            } catch (error) {
              recoveryCall.abandon();
              lease.finish(input.signal?.aborted ? 'cancelled' : 'provider_error');
              throw error;
            }
          } else {
            failureStage = 'gateway';
            gatewayCallsStarted++;
            const response = await gateway.complete({ binding, request: { ...compiled.request, model: provider.model }, signal: input.signal });
            recordResponseDiagnostic(response);
            failureStage = 'validation';
            if (live.mode === 'canary' && (response.finishReason !== 'stop' || response.toolCalls.length !== 0))
              throw new Error('context-canary-output-invalid');
            capsule = parseContextCapsule(response.content ?? '', compiled.expectation);
          }
          if (!capsule) throw new Error('context-compiler-capsule-missing');
          failureStage = 'receipt';
          if (!skillLive && !recovery && live.mode !== 'canary') CONTEXT_CAPSULE_CACHE.set(capsule);
          if (skillCall) {
            assertCurrent();
            if (!recovery) (skillCall as ReturnType<typeof createContextCompilerSkillLiveCall>)
              .bindValidatedCapsule(sha256Digest(JSON.stringify(capsule)));
            if (!recordPendingAudit()) throw new Error('context-compiler-skill-audit-required');
            assertCurrent();
            pendingContextSkill = skillCall;
            pendingContextSkillCurrent = assertCurrent;
          }
          AGENT_CLOSURE_RECORDER?.completeContextCompiler({
            ...closureIdentity,
            capsuleDigest: sha256Digest(JSON.stringify(capsule)),
            cached: false,
          });
          assertCanaryCurrent();
          if (live.mode === 'canary') {
            if (!settleCanary) throw new Error('context-canary-dispatch-missing');
            pendingContextCanaryCurrent = assertCanaryCurrent;
            settleCanary('success'); settleCanary = undefined;
          }
          return compactResult ?? capsule;
        } catch (error) {
          pendingContextSkill = null;
          pendingContextSkillCurrent = null;
          pendingContextCanaryCurrent = null;
          const diagnostic = preflightCapacityFailure ?? contextCompilerFailureDiagnostic(error);
          if (closureIdentity) {
            AGENT_CLOSURE_RECORDER?.failContextCompiler(closureIdentity, diagnostic.code);
          }
          console.error('[context-compiler-failure]', JSON.stringify({ ...diagnostic,
            ...execution, stage: failureStage, gatewayCallsStarted, responsesReceived, finishReason,
            ...(pendingAudit?.providerDiagnosticCode ? { providerDiagnosticCode: pendingAudit.providerDiagnosticCode } : {}),
            targetTokens: Number.isFinite(input.targetTokens) ? input.targetTokens : null,
            inputBudgetTokens: compilerInputLimit,
            outputBudgetTokens: compilerOutputLimit }));
          // Diagnostic coverage must not change the public failure contract for
          // Gateway/operation errors merely because their category is now known.
          if (diagnostic.category === 'capacity' && /^context-(?:capsule|compiler)-/u.test(diagnostic.code))
            throw new Error(diagnostic.code);
          throw Object.assign(new Error('context-compiler-skill-required-failed'), {
            code: diagnostic.code === 'provider-request-invalid'
              ? 'context-compiler-provider-request-invalid' : 'context-compiler-failed',
          });
        } finally {
          if (settleCanary) settleCanary('failure');
          if (skillLive && !auditRecorded && pendingAudit) recordPendingAudit();
        }
      },
      assertContextCompilerCurrent: () => {
        if (CONTEXT_COMPILER_RUNTIME.mode !== 'canary') return;
        if (!pendingContextCanaryCurrent) throw new Error('context-canary-authority-missing');
        pendingContextCanaryCurrent();
      },
      prepareContextConsumption: (input) => {
        const pending = pendingContextSkill;
        const assertCurrent = pendingContextSkillCurrent;
        pendingContextSkill = null;
        const required = assertCurrent !== null || (agentSkillLiveEnabled(deps.env)
            && contextCompilerRuntimeAllows(parseContextCompilerRuntimeConfig(deps.env), rawSessionId));
        if (required && (!pending || !assertCurrent)) throw new Error('context-compiler-skill-proof-required');
        assertCurrent?.();
        const payload = pending?.prepareConsumption(input) ?? null;
        if (required && !payload) throw new Error('context-compiler-skill-proof-required');
        return payload;
      },
      assertContextCompilerSkillCurrent: () => {
        if (!pendingContextSkillCurrent) throw new Error('context-compiler-skill-proof-required');
        pendingContextSkillCurrent();
      },
      observeContextConsumption: (input) => {
        if (input.durableSkillConsumption) SKILL_CONSUMPTION_SCHEDULER?.schedule(rawSessionId);
        else AGENT_CLOSURE_RECORDER?.consumeContextCompiler(input);
      },
  };
}
