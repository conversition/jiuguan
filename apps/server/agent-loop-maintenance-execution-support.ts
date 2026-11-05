/** Inspection-only declaration of the existing bounded Maintenance assembly.
 * No Store, live reader, constructor, environment or capability is consulted.
 * A present implementation is not source/policy readiness, legacy equivalence,
 * a guaranteed first response, or permission to claim/execute/complete a job.
 */
import { types as nodeTypes } from 'node:util';

export const AGENT_LOOP_MAINTENANCE_EXECUTION_SUPPORT_VERSION =
  'agent-loop-maintenance-execution-support-v1' as const;
export const AGENT_LOOP_MAINTENANCE_SINGLE_PASS_CONTRACT = Object.freeze({
  version: 'agent-loop-maintenance-single-pass-contract-v1' as const,
  taskKind: 'rolling_summary' as const,
  protocol: 'single-pass' as const,
  modes: Object.freeze(['shadow', 'apply'] as const),
  modelCalls: 1 as const,
  actionCalls: 1 as const,
  correctionSupported: false as const,
  additionalModelCallsSupported: false as const,
  legacyEquivalent: false as const,
  executionAuthorized: false as const,
  canaryAuthorized: false as const,
  productionEligible: false as const,
});

export type AgentLoopMaintenanceExecutionRoute = 'apply' | 'proposal' | 'read' | null;
export interface AgentLoopMaintenanceExecutionInstalledRoutes {
  readonly getVariables: boolean;
  readonly rollingSummaryProposal: boolean;
  readonly rollingSummaryApply: boolean;
}
/** Captured booleans from the original frozen Runtime assembly, not a live
 * reader or portable authority. Installed object presence selects the route;
 * method readiness only describes whether that route is fully implemented.
 */
export interface AgentLoopMaintenanceExecutionHostState extends AgentLoopMaintenanceExecutionInstalledRoutes {
  readonly available: boolean;
  readonly closed: boolean;
  readonly baseReady: boolean;
  readonly getVariablesReady: boolean;
  readonly rollingSummaryProposalReady: boolean;
  readonly rollingSummaryProposalPublication: boolean;
  readonly rollingSummaryApplyReady: boolean;
  readonly rollingSummaryApplyCompletion: boolean;
}
export interface AgentLoopMaintenanceExecutionSupportRequest {
  readonly taskKind: string;
  readonly mode: 'shadow' | 'apply';
  readonly protocol: 'single-pass' | 'legacy-bounded';
}
export type AgentLoopMaintenanceExecutionSupportReason =
  | 'single-pass-shadow-publication' | 'single-pass-apply-completion'
  | 'model-only-probe' | 'read-only-probe'
  | 'legacy-bounded-not-supported' | 'task-kind-not-supported'
  | 'host-unavailable' | 'runtime-closed' | 'base-ports-unavailable'
  | 'route-ports-unavailable' | 'completion-port-unavailable' | 'route-mode-mismatch';
export interface AgentLoopMaintenanceExecutionSupport {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_EXECUTION_SUPPORT_VERSION;
  readonly contractVersion: typeof AGENT_LOOP_MAINTENANCE_SINGLE_PASS_CONTRACT.version;
  readonly request: AgentLoopMaintenanceExecutionSupportRequest;
  readonly route: AgentLoopMaintenanceExecutionRoute;
  readonly support: 'single-pass-completion' | 'limited-probe' | 'unsupported' | 'unavailable';
  readonly reason: AgentLoopMaintenanceExecutionSupportReason;
  readonly sourcePolicyReadiness: 'not-assessed';
  readonly firstResponseGuaranteed: false;
  readonly correctionSupported: false;
  readonly additionalModelCallsSupported: false;
  readonly legacyEquivalent: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
}

const ROUTES = Object.freeze(['getVariables', 'rollingSummaryProposal', 'rollingSummaryApply']);
const HOST = Object.freeze([...ROUTES, 'available', 'closed', 'baseReady', 'getVariablesReady',
  'rollingSummaryProposalReady', 'rollingSummaryProposalPublication', 'rollingSummaryApplyReady',
  'rollingSummaryApplyCompletion']);
function invalid(): never { throw new Error('agent-loop-maintenance-execution-support-input-invalid'); }
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) invalid();
  return input as Record<string, unknown>;
}
function flags<T>(input: unknown, keys: readonly string[]): T {
  const value = data(input, keys);
  if (keys.some(key => typeof value[key] !== 'boolean')) invalid();
  return value as T;
}
function requestOf(input: unknown): AgentLoopMaintenanceExecutionSupportRequest {
  const value = data(input, ['taskKind', 'mode', 'protocol']);
  if (typeof value.taskKind !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/u.test(value.taskKind)
    || value.mode !== 'shadow' && value.mode !== 'apply'
    || value.protocol !== 'single-pass' && value.protocol !== 'legacy-bounded') invalid();
  return Object.freeze({ taskKind: value.taskKind, mode: value.mode, protocol: value.protocol });
}

/** Exactly the original Runtime ternary, including non-shadow/non-apply modes.
 * Readiness or completion availability MUST NOT silently choose another route.
 */
export function selectAgentLoopMaintenanceExecutionRoute(mode: unknown,
  installed: AgentLoopMaintenanceExecutionInstalledRoutes): AgentLoopMaintenanceExecutionRoute {
  const host = flags<AgentLoopMaintenanceExecutionInstalledRoutes>(installed, ROUTES);
  return mode === 'apply' && host.rollingSummaryApply ? 'apply'
    : host.rollingSummaryProposal && (!host.getVariables || mode === 'shadow')
      ? 'proposal' : host.getVariables ? 'read' : null;
}

/** A frozen implementation description only. Never accepts a comparison report,
 * invokes a host callback, probes a source, or issues execution/completion proof.
 * Unsupported legacy-bounded semantics stay unsupported even when ports exist.
 */
export function describeAgentLoopMaintenanceExecutionSupport(input: unknown,
  hostInput: AgentLoopMaintenanceExecutionHostState): AgentLoopMaintenanceExecutionSupport {
  const request = requestOf(input), host = flags<AgentLoopMaintenanceExecutionHostState>(hostInput, HOST);
  const route = selectAgentLoopMaintenanceExecutionRoute(request.mode, {
    getVariables: host.getVariables, rollingSummaryProposal: host.rollingSummaryProposal,
    rollingSummaryApply: host.rollingSummaryApply,
  });
  let support: AgentLoopMaintenanceExecutionSupport['support'], reason: AgentLoopMaintenanceExecutionSupportReason;
  if (request.protocol === 'legacy-bounded') { support = 'unsupported'; reason = 'legacy-bounded-not-supported'; }
  else if (request.taskKind !== 'rolling_summary') { support = 'unsupported'; reason = 'task-kind-not-supported'; }
  else if (!host.available) { support = 'unavailable'; reason = 'host-unavailable'; }
  else if (host.closed) { support = 'unavailable'; reason = 'runtime-closed'; }
  else if (!host.baseReady) { support = 'unavailable'; reason = 'base-ports-unavailable'; }
  else if (route === null) { support = 'limited-probe'; reason = 'model-only-probe'; }
  else if (route === 'read') {
    support = host.getVariablesReady ? 'limited-probe' : 'unavailable';
    reason = host.getVariablesReady ? 'read-only-probe' : 'route-ports-unavailable';
  } else if (route === 'proposal' && request.mode !== 'shadow') { support = 'unsupported'; reason = 'route-mode-mismatch'; }
  else if (route === 'proposal' && !host.rollingSummaryProposalReady
    || route === 'apply' && !host.rollingSummaryApplyReady) { support = 'unavailable'; reason = 'route-ports-unavailable'; }
  else if (route === 'proposal' && !host.rollingSummaryProposalPublication
    || route === 'apply' && !host.rollingSummaryApplyCompletion) { support = 'unsupported'; reason = 'completion-port-unavailable'; }
  else { support = 'single-pass-completion'; reason = route === 'proposal'
    ? 'single-pass-shadow-publication' : 'single-pass-apply-completion'; }
  return Object.freeze({ version: AGENT_LOOP_MAINTENANCE_EXECUTION_SUPPORT_VERSION,
    contractVersion: AGENT_LOOP_MAINTENANCE_SINGLE_PASS_CONTRACT.version, request, route, support, reason,
    sourcePolicyReadiness: 'not-assessed', firstResponseGuaranteed: false, correctionSupported: false,
    additionalModelCallsSupported: false, legacyEquivalent: false, executionAuthorized: false,
    completionAuthorized: false, canaryAuthorized: false, productionEligible: false });
}

/** Separate declaration for the existing shadow-only, correction-once routes.
 * Limits describe their upper bounds, NOT a budget reservation or capability.
 * In particular an installed lazy factory says nothing about its returned
 * bundle, optional publication port, source/policy, or a future response.
 */
export const AGENT_LOOP_MAINTENANCE_CORRECTION_SUPPORT_VERSION =
  'agent-loop-maintenance-correction-support-v1' as const;
const CORRECTION_MODEL_ONLY_LIMITS = Object.freeze({
  maxCorrections: 1 as const, maxModelCalls: 2 as const, maxModelCallsPerDispatch: 1 as const,
  maxActionCalls: 0 as const, maxToolCalls: 0 as const, maxWrites: 0 as const,
});
const CORRECTION_PROPOSAL_LIMITS = Object.freeze({
  maxCorrections: 1 as const, maxModelCalls: 2 as const, maxModelCallsPerDispatch: 1 as const,
  // The write is private Manager proposal/publication metadata, never a Session
  // domain write or permission to apply a Summary.
  maxActionCalls: 1 as const, maxToolCalls: 1 as const, maxWrites: 1 as const,
});
export const AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT = Object.freeze({
  version: 'agent-loop-maintenance-correction-once-contract-v1' as const,
  taskKind: 'rolling_summary' as const, protocol: 'correction-once' as const,
  modes: Object.freeze(['shadow'] as const),
  limits: Object.freeze({ modelOnly: CORRECTION_MODEL_ONLY_LIMITS, correctionProposal: CORRECTION_PROPOSAL_LIMITS }),
  legacyEquivalent: false as const, executionAuthorized: false as const,
  completionAuthorized: false as const, canaryAuthorized: false as const, productionEligible: false as const,
});

/** Product decision only. This selects the narrow proposal route as the
 * contract to qualify next; it is not a Runtime grant, a comparison allowance
 * or evidence that any lazy host port is ready. The broader support query
 * above remains useful for inspection, including its model-only probe, while
 * only this exact route is accepted for a future single-route Canary plan. */
export const AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE_VERSION =
  'agent-loop-maintenance-correction-proposal-only-acceptance-v1' as const;
export const AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE = Object.freeze({
  version: AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE_VERSION,
  contractVersion: AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT.version,
  decision: 'accepted-narrow-contract' as const,
  scope: Object.freeze({ taskKind: 'rolling_summary' as const, mode: 'shadow' as const,
    protocol: 'correction-once' as const, route: 'correction-proposal' as const }),
  capability: Object.freeze({ providerToolSurface: 'unchanged' as const,
    executableDecisionTools: Object.freeze(['propose_rolling_summary'] as const),
    readExecution: 'unsupported' as const, getVariables: false as const }),
  limits: CORRECTION_PROPOSAL_LIMITS,
  comparisonRewriteAllowed: false as const, legacyEquivalent: false as const,
  contractAcceptanceGranted: true as const, operationalEvidence: false as const,
  executionAuthorized: false as const, completionAuthorized: false as const,
  canaryAuthorized: false as const, productionEligible: false as const,
});
export type AgentLoopMaintenanceCorrectionRoute = 'model-only' | 'correction-proposal' | null;
export interface AgentLoopMaintenanceCorrectionHostState {
  readonly available: boolean;
  readonly closed: boolean;
  readonly readExecutionReady: boolean;
  readonly modelCorrection: boolean;
  readonly correctionProposal: boolean;
}
export interface AgentLoopMaintenanceCorrectionSupportRequest {
  readonly taskKind: string;
  readonly mode: 'shadow' | 'apply';
  readonly protocol: 'correction-once' | 'legacy-bounded';
}
export type AgentLoopMaintenanceCorrectionSupportReason =
  | 'correction-proposal-declared' | 'model-only-probe'
  | 'legacy-bounded-not-supported' | 'task-kind-not-supported' | 'route-mode-mismatch'
  | 'host-unavailable' | 'runtime-closed' | 'read-execution-unavailable'
  | 'correction-port-unavailable' | 'route-conflict';
export interface AgentLoopMaintenanceCorrectionSupport {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_CORRECTION_SUPPORT_VERSION;
  readonly contractVersion: typeof AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT.version;
  readonly request: AgentLoopMaintenanceCorrectionSupportRequest;
  readonly route: AgentLoopMaintenanceCorrectionRoute;
  readonly support: 'declared' | 'limited-probe' | 'unsupported' | 'unavailable';
  readonly reason: AgentLoopMaintenanceCorrectionSupportReason;
  readonly limits: typeof CORRECTION_MODEL_ONLY_LIMITS | typeof CORRECTION_PROPOSAL_LIMITS | null;
  readonly bundleReadiness: 'not-assessed';
  readonly publicationReadiness: 'not-assessed';
  readonly sourcePolicyReadiness: 'not-assessed';
  readonly firstResponseGuaranteed: false;
  readonly legacyEquivalent: false;
  readonly executionAuthorized: false;
  readonly completionAuthorized: false;
  readonly canaryAuthorized: false;
  readonly productionEligible: false;
}
const CORRECTION_HOST = Object.freeze(['available', 'closed', 'readExecutionReady', 'modelCorrection', 'correctionProposal']);
const CORRECTION_INTRINSIC_PROMISE = Promise;
const CORRECTION_INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const CORRECTION_INTRINSIC_PROMISE_SPECIES = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
function correctionSupportInvalid(): never { throw new Error('agent-loop-maintenance-correction-support-input-invalid'); }
function correctionSupportObservePromise(input: unknown): void {
  if (!nodeTypes.isPromise(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== CORRECTION_INTRINSIC_PROMISE.prototype
    || Object.getOwnPropertyDescriptor(input, 'constructor')) return;
  const constructor = Object.getOwnPropertyDescriptor(CORRECTION_INTRINSIC_PROMISE.prototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(CORRECTION_INTRINSIC_PROMISE, Symbol.species);
  // Intrinsic then consults constructor/species. Observe only an ordinary native
  // Promise whose lookup cannot invoke caller hooks; exotic Promises are simply
  // rejected. Never use input.then, await, Promise.resolve or caller species.
  if (!constructor || !Object.hasOwn(constructor, 'value') || constructor.value !== CORRECTION_INTRINSIC_PROMISE
    || !species || species.get !== CORRECTION_INTRINSIC_PROMISE_SPECIES || species.set !== undefined) return;
  void CORRECTION_INTRINSIC_PROMISE_THEN.call(input, () => undefined, () => undefined);
}
/** Deliberately independent from the old single-pass validator. Never access a
 * getter/Proxy or assimilate a thenable. Ordinary intrinsic rejected Promises
 * are observed to avoid unhandled rejection; exotic Promises are only rejected.
 */
function correctionSupportData(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || nodeTypes.isProxy(input)) correctionSupportInvalid();
  if (nodeTypes.isPromise(input)) { correctionSupportObservePromise(input); correctionSupportInvalid(); }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) correctionSupportInvalid();
  const actual = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(descriptors[key] ?? {}, 'value'))) correctionSupportInvalid();
  for (const key of keys) correctionSupportObservePromise(descriptors[key]?.value);
  return input as Record<string, unknown>;
}

/** Inspection ONLY: captured own-function booleans, never a host/factory call,
 * live Store/Manager read, clock, model invocation, or completion evaluation.
 * A proposal declaration does not claim its lazy publication port is present.
 * The old single-pass selector, contract and output intentionally stay separate.
 */
export function describeAgentLoopMaintenanceCorrectionSupport(input: unknown,
  hostInput: AgentLoopMaintenanceCorrectionHostState): AgentLoopMaintenanceCorrectionSupport {
  const requestData = correctionSupportData(input, ['taskKind', 'mode', 'protocol']);
  const host = correctionSupportData(hostInput, CORRECTION_HOST);
  if (typeof requestData.taskKind !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/u.test(requestData.taskKind)
    || requestData.mode !== 'shadow' && requestData.mode !== 'apply'
    || requestData.protocol !== 'correction-once' && requestData.protocol !== 'legacy-bounded'
    || CORRECTION_HOST.some(key => typeof host[key] !== 'boolean')) correctionSupportInvalid();
  const request = Object.freeze({ taskKind: requestData.taskKind,
    mode: requestData.mode, protocol: requestData.protocol }) as AgentLoopMaintenanceCorrectionSupportRequest;
  const route: AgentLoopMaintenanceCorrectionRoute = host.modelCorrection === host.correctionProposal ? null
    : host.correctionProposal ? 'correction-proposal' : 'model-only';
  let support: AgentLoopMaintenanceCorrectionSupport['support'], reason: AgentLoopMaintenanceCorrectionSupportReason;
  if (request.protocol === 'legacy-bounded') { support = 'unsupported'; reason = 'legacy-bounded-not-supported'; }
  else if (request.taskKind !== 'rolling_summary') { support = 'unsupported'; reason = 'task-kind-not-supported'; }
  else if (request.mode !== 'shadow') { support = 'unsupported'; reason = 'route-mode-mismatch'; }
  else if (!host.available) { support = 'unavailable'; reason = 'host-unavailable'; }
  else if (host.closed) { support = 'unavailable'; reason = 'runtime-closed'; }
  else if (!host.readExecutionReady) { support = 'unavailable'; reason = 'read-execution-unavailable'; }
  else if (host.modelCorrection && host.correctionProposal) { support = 'unsupported'; reason = 'route-conflict'; }
  else if (!route) { support = 'unavailable'; reason = 'correction-port-unavailable'; }
  else { support = route === 'correction-proposal' ? 'declared' : 'limited-probe';
    reason = route === 'correction-proposal' ? 'correction-proposal-declared' : 'model-only-probe'; }
  return Object.freeze({ version: AGENT_LOOP_MAINTENANCE_CORRECTION_SUPPORT_VERSION,
    contractVersion: AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT.version, request, route, support, reason,
    limits: route === 'correction-proposal' ? CORRECTION_PROPOSAL_LIMITS : route === 'model-only' ? CORRECTION_MODEL_ONLY_LIMITS : null,
    bundleReadiness: 'not-assessed', publicationReadiness: 'not-assessed', sourcePolicyReadiness: 'not-assessed',
    firstResponseGuaranteed: false, legacyEquivalent: false, executionAuthorized: false,
    completionAuthorized: false, canaryAuthorized: false, productionEligible: false });
}
