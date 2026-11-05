import { createHash } from 'node:crypto';
import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import type { ProviderConfig, ProviderRegistry } from '../../packages/proxy/public/provider-runtime.ts';
import type { SessionArgs } from '../../packages/session/public/session.ts';
import type { ModelRuntimeProfile } from '../../packages/prompt/public/model-runtime-profile.ts';
import { assertTurnOperationProviderTransport, assertTurnOperationRates, createTurnOperationHost,
  type TurnOperationHostSnapshot } from './turn-operation-host.ts';
import type { TurnOperationPhase } from './turn-operation-runtime.ts';
import type { TurnOperationBudgetStore } from './turn-operation-budget-store.ts';
import { createSchemaRepairHost } from './schema-repair-host.ts';
import { createStandaloneSchemaRepairBudget } from './schema-repair-budget.ts';

type Selection = { readonly providerId: string; readonly model: string };
type ResolveBinding = () => { readonly selection: Selection; readonly client: ChatCompletionClient };
export interface SessionProviderRuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly providerSpiEnabled: boolean;
  readonly operationBudgetStore: () => TurnOperationBudgetStore;
  readonly loadProviderConfig: () => ProviderConfig;
  readonly assertProviderReady: (config: ProviderConfig) => void;
  readonly createDirectProviderClient: (config: ProviderConfig) => ChatCompletionClient;
  readonly agentModelBinding: () => { readonly selection: Selection; readonly client: ChatCompletionClient };
  readonly modelRuntimeProfileFor: (selection: Selection, client: ChatCompletionClient) => ModelRuntimeProfile;
  readonly providerClientForServer: (selection?: Selection) => ChatCompletionClient | undefined;
  readonly registryProviderClient: ChatCompletionClient;
  readonly providerRegistry: Pick<ProviderRegistry, 'bindingToken'>;
  readonly readProviderGeneration: () => number;
  readonly observeServerModelClient: (client: ChatCompletionClient, resolveProviderId: () => string) => ChatCompletionClient;
  readonly resolvedArbitratedAgentClient: (resolve: ResolveBinding, entry: 'interactive-final' | 'story-index') => ChatCompletionClient;
  readonly skillFulfillmentForSession: (id: string, host: ReturnType<typeof createTurnOperationHost>) => NonNullable<SessionArgs['skillFulfillment']>;
  readonly schemaRepairDispatchForSession?: (id: string) => NonNullable<Parameters<typeof createSchemaRepairHost>[0]['dispatch']>;
  readonly schemaRepairEvidence?: (sessionId: string, value: { runId: string; candidateDigest: string; evidence: string }) => void;
  readonly reportProgress: (sessionId: string, runId: string, phase: Parameters<NonNullable<SessionArgs['onTurnProgress']>>[0]['phase']) => void;
}

/** One exact-session operation host and its real foreground transport assembly. */
export function createSessionProviderRuntime(deps: SessionProviderRuntimeDependencies) {
  const { loadProviderConfig, assertProviderReady, agentModelBinding, modelRuntimeProfileFor, providerClientForServer,
    registryProviderClient, providerRegistry, observeServerModelClient, resolvedArbitratedAgentClient,
    skillFulfillmentForSession } = deps;
function readTurnOperationConfig(): { sessionId: string; snapshot: TurnOperationHostSnapshot } | null {
  const raw = deps.env.JG_TURN_OPERATION_CONFIG_JSON;
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.length > 65_536) throw new Error('turn-operation-config-invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('turn-operation-config-invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'sessionId,snapshot') throw new Error('turn-operation-config-invalid');
  const value = parsed as { sessionId: unknown; snapshot: unknown };
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId === '*'
    || !value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) {
    throw new Error('turn-operation-config-invalid');
  }
  return { sessionId: value.sessionId, snapshot: value.snapshot as TurnOperationHostSnapshot };
}

let activeTurnOperationHost: ReturnType<typeof createTurnOperationHost> | undefined;
let activeTurnOperationSession: string | undefined;
function turnOperationHostForSession(sessionId: string): ReturnType<typeof createTurnOperationHost> | undefined {
  if (activeTurnOperationSession === sessionId && activeTurnOperationHost) return activeTurnOperationHost;
  const selected = readTurnOperationConfig();
  if (!selected || selected.sessionId !== sessionId) return undefined;
  if (activeTurnOperationHost) throw new Error('turn-operation-config-scope-changed');
  assertTurnOperationProviderTransport(deps.providerSpiEnabled);
  const readSnapshot = (): TurnOperationHostSnapshot => {
    const current = readTurnOperationConfig();
    if (!current || current.sessionId !== sessionId) throw new Error('turn-operation-config-scope-changed');
    const repair = current.snapshot.holds?.repair;
    if (!repair || !Number.isSafeInteger(repair.calls) || repair.calls < 2
      || !Number.isSafeInteger(repair.inputTokens) || repair.inputTokens < 1
      || !Number.isSafeInteger(repair.outputTokens) || repair.outputTokens < 2
      || !Number.isSafeInteger(repair.costMicrousd) || repair.costMicrousd < 1)
      throw Object.assign(new Error('schema-repair-reserve-insufficient'), { code: 'schema-repair-reserve-insufficient' });
    const mainConfig = loadProviderConfig();
    const agent = agentModelBinding();
    const mainSelection = { providerId: mainConfig.providerId, model: mainConfig.model };
    const mainProfile = modelRuntimeProfileFor(mainSelection, providerClientForServer(mainSelection) ?? registryProviderClient);
    const agentProfile = modelRuntimeProfileFor(agent.selection, agent.client);
    const capture = (configured: TurnOperationHostSnapshot['main'],
      selection: { readonly providerId: string; readonly model: string },
      profile: ReturnType<typeof modelRuntimeProfileFor>) => {
      if (!configured || configured.providerId !== selection.providerId || configured.modelId !== selection.model
        || configured.contextWindowTokens > profile.contextWindowTokens
        || configured.maxRequestOutputTokens > profile.maxOutputTokens) {
        throw new Error('turn-operation-model-profile-mismatch');
      }
      assertTurnOperationRates(configured, profile, deps.env);
      const minimumMargin = Math.ceil((configured.contextWindowTokens - configured.maxRequestOutputTokens)
        * (profile.tokenizer === 'conservative-estimate' ? 0.05 : 0.02));
      if (configured.requestSafetyMarginTokens < minimumMargin) throw new Error('turn-operation-safety-margin-insufficient');
      const configurationDigest = `sha256:${createHash('sha256').update(JSON.stringify({ selection,
        profile, generation: deps.readProviderGeneration() })).digest('hex')}`;
      return { ...configured, configurationDigest };
    };
    return { ...current.snapshot, main: capture(current.snapshot.main, mainSelection, mainProfile),
      agent: capture(current.snapshot.agent, agent.selection, agentProfile) };
  };
  activeTurnOperationHost = createTurnOperationHost({ store: deps.operationBudgetStore(), sessionId, readSnapshot,
    readProviderTokens: (snapshot) => [providerRegistry.bindingToken(snapshot.main.providerId),
      providerRegistry.bindingToken(snapshot.agent.providerId)] });
  activeTurnOperationSession = sessionId;
  return activeTurnOperationHost;
}

function turnOperationClientForServer(sessionId: string, runId: string | undefined,
  phase: TurnOperationPhase, client: ChatCompletionClient): ChatCompletionClient {
  // A turn keeps the policy chosen when its Session was constructed. Never
  // activate a new host halfway through an already-running legacy turn.
  const host = activeTurnOperationSession === sessionId ? activeTurnOperationHost : undefined;
  if (!host) return client;
  if (!runId) throw new Error('turn-operation-run-required');
  return host.wrap(runId, phase, client);
}

function sessionProviderClientForServer(sessionId: string): ChatCompletionClient {
  if (!deps.providerSpiEnabled) assertProviderReady(loadProviderConfig());
  const resolveBinding = () => {
    const cfg = loadProviderConfig();
    const selection = Object.freeze({ providerId: cfg.providerId, model: cfg.model });
    const raw = providerClientForServer(selection) ?? deps.createDirectProviderClient(cfg);
    return { selection, client: observeServerModelClient(raw, () => selection.providerId) };
  };
  const foreground = resolvedArbitratedAgentClient(resolveBinding, 'interactive-final');
  const storyIndex = resolvedArbitratedAgentClient(resolveBinding, 'story-index');
  return {
    ...foreground,
    complete: (request, signal, call) => (call?.lane === 'story_index' ? storyIndex : foreground)
      .complete(request, signal, call),
    stream: (request, onDelta, onToolArg, signal, call) => (call?.lane === 'turn_final'
      ? turnOperationClientForServer(sessionId, call.runId, 'body', foreground)
      : call?.lane === 'story_index' ? storyIndex : foreground).stream(request, onDelta, onToolArg, signal, call),
  };
}

function sessionProviderArgsForServer(sessionId: string): Pick<SessionArgs, 'providerClient' | 'observeProviderClient' | 'turnOperation' | 'skillFulfillment' | 'onTurnProgress' | 'schemaRepair' | 'schemaRepairMode'> {
  const host = turnOperationHostForSession(sessionId);
  const dispatch = deps.schemaRepairDispatchForSession?.(sessionId);
  return { ...(deps.providerSpiEnabled
    ? { providerClient: sessionProviderClientForServer(sessionId) }
    : { observeProviderClient: () => sessionProviderClientForServer(sessionId) }),
    ...(dispatch ? { schemaRepairMode: host ? 'operation-v3' as const : 'admitted-once' as const,
      schemaRepair: createSchemaRepairHost({ operation: host, client: () => sessionProviderClientForServer(sessionId), dispatch,
        onEvidence: value => deps.schemaRepairEvidence?.(sessionId, value),
        standalone: () => createStandaloneSchemaRepairBudget({ env: deps.env, read: () => {
          const cfg = loadProviderConfig();
          const selection = { providerId: cfg.providerId, model: cfg.model };
          return { providerId: cfg.providerId, modelId: cfg.model, generation: deps.readProviderGeneration(),
            profile: modelRuntimeProfileFor(selection, providerClientForServer(selection) ?? registryProviderClient) };
        } }) }),
      onTurnProgress: ({ runId, phase }: Parameters<NonNullable<SessionArgs['onTurnProgress']>>[0]) => deps.reportProgress(sessionId, runId, phase) } : {}),
    ...(host ? { turnOperation: host, skillFulfillment: skillFulfillmentForSession(sessionId, host),
      onTurnProgress: ({ runId, phase }) => deps.reportProgress(sessionId, runId, phase) } : {}) };
}
function activeHostForSession(sessionId: string) {
  return activeTurnOperationSession === sessionId ? activeTurnOperationHost : undefined;
}
return Object.freeze({ turnOperationHostForSession, turnOperationClientForServer,
  sessionProviderClientForServer, sessionProviderArgsForServer, activeHostForSession });
}
