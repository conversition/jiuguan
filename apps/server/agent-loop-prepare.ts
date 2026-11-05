/** P17-02.3a: reproducible, read-only Prepare previews, never execution authority.
 * The host resolver must read the actual Manager/loaded Session/current policy.
 * Neither content-free shadow refs nor a successful preview may authorize a call.
 */
import { createHash } from 'node:crypto';
import { isMaintenanceTrigger, type PublicMaintenanceJob } from '@jiuguan/mobile-contracts';
import { normalizeAgentBudgetProfile } from '../../packages/agent-policy/public/budget-profile.ts';
import {
  MODEL_RUNTIME_PROFILE_VERSION, type ModelRuntimeProfile,
} from '../../packages/prompt/public/model-runtime-profile.ts';
import { estimateAdmittedRequestInputTokens } from './admitted-model-gateway.ts';
import { resolveMaintenanceModelToolSurface } from './admitted-maintenance-model.ts';
import type { AgentLoopProjectionStore, AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import {
  buildShadowMaintenanceJobEnvelope, isPristineShadowProjection, MAINTENANCE_TASK_KIND_REGISTRY,
} from './agent-loop-turnjob-shadow.ts';
import { maintenanceSystemPrompt, type MaintenanceSnapshot } from './maintenance-harness-service.ts';
import { maintenanceHarnessRequest } from './maintenance-model-adapter.ts';
import {
  MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION, MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
  MAINTENANCE_OUTPUT_VALIDATOR_VERSION, MAINTENANCE_SESSION_INPUT_VERSION,
  MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION,
} from './maintenance-model-contract.ts';
import { MAINTENANCE_SNAPSHOT_INSTRUCTION } from './maintenance-session-snapshot.ts';
import {
  isRollingSummaryApplyContext, maintenanceMessageEvidenceBinding, maintenanceValueDigest,
} from './maintenance-types.ts';

export const AGENT_LOOP_MAINTENANCE_PREPARE_VERSION = 'agent-loop-maintenance-prepare-preview-v1' as const;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TASK_PREFIX = 'agentloop.maintenance.';
const MAX_INPUT_CHARS = 1_000_000;

export type AgentLoopMaintenancePrepareErrorCode =
  | 'agent-loop-prepare-options-invalid' | 'agent-loop-prepare-input-invalid'
  | 'agent-loop-prepare-record-invalid' | 'agent-loop-prepare-lease-lost'
  | 'agent-loop-prepare-record-changed' | 'agent-loop-prepare-source-invalid'
  | 'agent-loop-prepare-source-unavailable' | 'agent-loop-prepare-source-changed'
  | 'agent-loop-prepare-snapshot-invalid' | 'agent-loop-prepare-profile-invalid'
  | 'agent-loop-prepare-budget-exceeded';

export class AgentLoopMaintenancePrepareError extends Error {
  constructor(readonly code: AgentLoopMaintenancePrepareErrorCode) {
    super(code);
    this.name = 'AgentLoopMaintenancePrepareError';
  }
}
function reject(code: AgentLoopMaintenancePrepareErrorCode): never {
  throw new AgentLoopMaintenancePrepareError(code);
}

export interface AgentLoopMaintenancePrepareSource {
  readonly job: PublicMaintenanceJob;
  readonly snapshot: MaintenanceSnapshot;
  readonly profile: Readonly<{
    providerId: string;
    modelId: string;
    runtimeProfile: ModelRuntimeProfile;
    budgetProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
    policyVersion: string;
    contentMode: 'nsf' | 'nsfw';
  }>;
}
export interface AgentLoopMaintenancePrepareOptions {
  readonly store: AgentLoopProjectionStore;
  readonly ownerId: string;
  readonly clock: () => string;
  /** Trusted, fresh readback only. No cached DTO, Client, Ticket issuance or execution is allowed. */
  readonly readSource: (runId: string) => AgentLoopMaintenancePrepareSource | null
    | Promise<AgentLoopMaintenancePrepareSource | null>;
}
export interface AgentLoopMaintenancePrepareCandidate {
  readonly version: typeof AGENT_LOOP_MAINTENANCE_PREPARE_VERSION;
  /** Optional Gateway/Skill preparation has not run; this is not the final transport payload. */
  readonly requestStage: 'host-base-before-gateway-prepare';
  readonly taskId: string;
  readonly revision: number;
  readonly taskKind: 'maintenance.rolling_summary';
  readonly sourceRevision: string;
  readonly envelopeDigest: string;
  readonly requestDigest: string;
  readonly profileDigest: string;
  readonly sourceDigest: string;
  readonly fixedInputDigest: string;
  readonly taskContractRef: string;
  readonly contractRevision: string;
  readonly verifierSetRef: string;
  readonly verifierSetRevision: string;
  readonly toolSetDigest: string;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly executionAuthorized: false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown> : null;
}
/** Stable semantic hashing of selected data only; no serialization of a resolver or arbitrary source object. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = record(value);
  if (!row) reject('agent-loop-prepare-source-invalid');
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function rawDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function digest(value: unknown): string { return rawDigest(canonical(value)); }
function token(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function profileOf(source: AgentLoopMaintenancePrepareSource) {
  const { profile, job } = source;
  const runtime = profile?.runtimeProfile;
  if (!profile || !token(profile.providerId) || !token(profile.modelId)
    || profile.policyVersion !== job.policyVersion || !token(profile.policyVersion)
    || !['nsf', 'nsfw'].includes(profile.contentMode) || !runtime
    || runtime.version !== MODEL_RUNTIME_PROFILE_VERSION || runtime.modelId !== profile.modelId
    || runtime.providerIdDigest !== rawDigest(profile.providerId)
    || !Number.isSafeInteger(runtime.contextWindowTokens) || runtime.contextWindowTokens < 1
    || !Number.isSafeInteger(runtime.maxOutputTokens) || runtime.maxOutputTokens < 1
    || runtime.maxOutputTokens >= runtime.contextWindowTokens || runtime.supportsTools !== true
    || typeof runtime.supportsStreaming !== 'boolean'
    || !['provider-exact', 'local-exact', 'conservative-estimate'].includes(runtime.tokenizer)
    || !['static-declaration', 'provider-verified'].includes(runtime.source) || !timestamp(runtime.updatedAt)) {
    reject('agent-loop-prepare-profile-invalid');
  }
  const rates = [runtime.inputMicrousdPerMillionTokens, runtime.outputMicrousdPerMillionTokens];
  if (rates.some((rate) => rate !== undefined && (!Number.isSafeInteger(rate) || rate < 1))
    || (rates[0] === undefined) !== (rates[1] === undefined)) reject('agent-loop-prepare-profile-invalid');
  let budget: ReturnType<typeof normalizeAgentBudgetProfile>;
  try { budget = normalizeAgentBudgetProfile(profile.budgetProfile); }
  catch { return reject('agent-loop-prepare-profile-invalid'); }
  // rolling_summary uses the existing style budget lane, not the coarse shadow policy label.
  if (budget.lane !== 'style' || budget.maxModelCalls < 1 || budget.agentOutputBudgetTokens < 1
    || budget.providerContextWindowTokens > runtime.contextWindowTokens
    || budget.agentOutputBudgetTokens > runtime.maxOutputTokens) reject('agent-loop-prepare-profile-invalid');
  return {
    providerId: profile.providerId, modelId: profile.modelId, policyVersion: profile.policyVersion,
    contentMode: profile.contentMode, budgetProfile: budget,
    runtimeProfile: {
      version: runtime.version, providerIdDigest: runtime.providerIdDigest, modelId: runtime.modelId,
      contextWindowTokens: runtime.contextWindowTokens, maxOutputTokens: runtime.maxOutputTokens,
      tokenizer: runtime.tokenizer, supportsTools: runtime.supportsTools,
      supportsStreaming: runtime.supportsStreaming, source: runtime.source, updatedAt: runtime.updatedAt,
      inputMicrousdPerMillionTokens: rates[0] ?? null, outputMicrousdPerMillionTokens: rates[1] ?? null,
    },
  };
}

function snapshotOf(source: AgentLoopMaintenancePrepareSource) {
  const { snapshot, job } = source;
  const context = snapshot?.proposalContext;
  // Bound the contiguous-window guard before invoking its existing complete-evidence validator.
  if (!snapshot || !record(context) || !context || !('targetRound' in context)
    || !('expectedSummaryRound' in context) || typeof context.expectedSummaryRound !== 'number'
    || context.targetRound - context.expectedSummaryRound > 64
    || !isRollingSummaryApplyContext(context) || context.sessionId !== job.sessionId
    || context.sourceRevision !== job.sourceRevision || snapshot.revision !== job.sourceRevision
    || snapshot.strictContextUnavailableReason !== undefined
    || typeof snapshot.userMessage !== 'string' || snapshot.userMessage.length > MAX_INPUT_CHARS
    || snapshot.providerProposalContext !== undefined
      && digest(snapshot.providerProposalContext) !== digest(context)) reject('agent-loop-prepare-snapshot-invalid');
  let message: Record<string, unknown> | null;
  try { message = record(JSON.parse(snapshot.userMessage)); }
  catch { return reject('agent-loop-prepare-snapshot-invalid'); }
  const evidence = record(message?.evidence), summary = record(evidence?.rollingSummary);
  const memory = record(snapshot.state?.memory), history = evidence?.recentHistory;
  if (!message || !exactKeys(message, ['taskKind', 'sourceRevision', 'proposalContext', 'evidence', 'instruction'])
    || !evidence || !exactKeys(evidence, ['rollingSummary', 'recentHistory'])
    || message.taskKind !== 'rolling_summary' || message.sourceRevision !== snapshot.revision
    || message.instruction !== MAINTENANCE_SNAPSHOT_INSTRUCTION || digest(message.proposalContext) !== digest(context)
    || !summary || !exactKeys(summary, ['longterm', 'summaryRound', 'targetRound', 'historyEpoch', 'baseSummaryDigest', 'inputDigest'])
    || !memory || typeof summary.longterm !== 'string' || summary.longterm.length > 16_000
    || maintenanceValueDigest(summary.longterm) !== context.baseSummaryDigest
    || summary.summaryRound !== context.expectedSummaryRound || summary.targetRound !== context.targetRound
    || summary.historyEpoch !== context.historyEpoch || summary.baseSummaryDigest !== context.baseSummaryDigest
    || summary.inputDigest !== context.inputDigest || digest(memory.rollingSummary) !== digest(summary)
    || !Array.isArray(history) || history.length !== context.sourceEvidence.length
    || digest(memory.recentHistory) !== digest(history)) reject('agent-loop-prepare-snapshot-invalid');
  for (let index = 0; index < history.length; index += 1) {
    const row = record(history[index]);
    if (!row || Object.keys(row).length !== 4 || !Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.round)
      || typeof row.id !== 'number' || typeof row.round !== 'number' || typeof row.role !== 'string'
      || typeof row.content !== 'string') reject('agent-loop-prepare-snapshot-invalid');
    try {
      if (digest(maintenanceMessageEvidenceBinding({ id: row.id, round: row.round, role: row.role, content: row.content }))
        !== digest(context.sourceEvidence[index])) reject('agent-loop-prepare-snapshot-invalid');
    } catch { reject('agent-loop-prepare-snapshot-invalid'); }
  }
  // Whitelist the existing builder's data fields. Function-valued readMemory and
  // arbitrary resolver/profile/Client metadata never enter hashes or the return DTO.
  if (!exactKeys(snapshot.state, ['memory', 'worldbook', 'variables'])
    || Object.keys(memory).some((key) => !['recentHistory', 'states', 'arcs', 'characters', 'meta', 'rollingSummary'].includes(key))) {
    reject('agent-loop-prepare-snapshot-invalid');
  }
  const fixed = { revision: snapshot.revision, userMessage: snapshot.userMessage,
    state: snapshot.state, proposalContext: context, providerProposalContext: snapshot.providerProposalContext ?? context };
  if (canonical(fixed).length > MAX_INPUT_CHARS) reject('agent-loop-prepare-snapshot-invalid');
  return fixed;
}

function capture(source: AgentLoopMaintenancePrepareSource, current: AgentLoopTaskRecord, runId: string) {
  const { job } = source;
  if (!job || job.runId !== runId || !token(job.sessionId) || !HASH.test(job.sourceRevision)
    || !token(job.policyVersion) || job.parentRunId !== undefined && !token(job.parentRunId)
    || !isMaintenanceTrigger(job.trigger) || !['shadow', 'apply'].includes(job.mode)
    || !['queued', 'running'].includes(job.status) || !Number.isSafeInteger(job.attempt) || job.attempt < 0
    || !timestamp(job.createdAt)) reject('agent-loop-prepare-source-invalid');
  const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
  const expected = buildShadowMaintenanceJobEnvelope({ job, now: current.envelope.createdAt });
  if (JSON.stringify(expected.envelope) !== JSON.stringify(current.envelope)
    || current.envelope.taskContractRef !== registration.contractRef
    || current.envelope.verifier.verifierSetRef !== registration.verifierSetRef
    || current.envelope.verifier.verifierSetRevision !== registration.verifierSetRevision
    || current.envelope.budget.policyRef !== `agent.budget.${registration.budgetProfileRef}`) {
    reject('agent-loop-prepare-source-invalid');
  }
  const profile = profileOf(source), snapshot = snapshotOf(source);
  const surface = resolveMaintenanceModelToolSurface('rolling_summary', snapshot.proposalContext);
  const request = maintenanceHarnessRequest(profile.modelId, {
    system: maintenanceSystemPrompt('rolling_summary'), messages: [{ role: 'user', content: snapshot.userMessage }],
    maxOutputTokens: profile.budgetProfile.agentOutputBudgetTokens, signal: new AbortController().signal,
  }, [...surface.tools]);
  const inputTokens = estimateAdmittedRequestInputTokens(request);
  if (inputTokens > profile.budgetProfile.agentInputBudgetTokens
    || inputTokens + profile.budgetProfile.agentOutputBudgetTokens > profile.runtimeProfile.contextWindowTokens) {
    reject('agent-loop-prepare-budget-exceeded');
  }
  const profileDigest = digest({ profile, contract: registration,
    instructions: [MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION, MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION],
    inputVersion: MAINTENANCE_SESSION_INPUT_VERSION, toolVersion: MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
    validatorVersion: MAINTENANCE_OUTPUT_VALIDATOR_VERSION });
  const sourceDigest = digest({
    job: { runId: job.runId, sessionId: job.sessionId, taskKind: job.taskKind, sourceRevision: job.sourceRevision,
      policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? null, trigger: job.trigger,
      mode: job.mode, status: job.status, attempt: job.attempt, createdAt: job.createdAt },
    snapshot, profileDigest,
  });
  return { requestDigest: rawDigest(JSON.stringify(request)), profileDigest, sourceDigest, fixedInputDigest: digest(snapshot),
    sourceRevision: job.sourceRevision, toolSetDigest: surface.toolSetDigest, inputTokens,
    maxOutputTokens: profile.budgetProfile.agentOutputBudgetTokens };
}

export function createAgentLoopMaintenancePrepare(options: AgentLoopMaintenancePrepareOptions) {
  if (!options || !token(options.ownerId) || typeof options.clock !== 'function'
    || typeof options.readSource !== 'function' || !options.store) reject('agent-loop-prepare-options-invalid');
  const { store, ownerId, clock, readSource } = options;
  const current = (taskId: string, revision: number): AgentLoopTaskRecord => {
    const found = store.read(taskId);
    if (!found || found.revision !== revision || found.fenced || !isPristineShadowProjection(store, found)) {
      reject('agent-loop-prepare-record-invalid');
    }
    const now = clock();
    if (!timestamp(now) || found.ownerId !== ownerId || !found.leaseExpiresAt
      || Date.parse(found.leaseExpiresAt) <= Date.parse(now)) reject('agent-loop-prepare-lease-lost');
    return found;
  };
  return Object.freeze({
    async preview(input: Readonly<{ taskId: string; revision: number }>): Promise<AgentLoopMaintenancePrepareCandidate | null> {
      if (!input || !token(input.taskId) || !Number.isSafeInteger(input.revision) || input.revision < 1) {
        reject('agent-loop-prepare-input-invalid');
      }
      const initial = current(input.taskId, input.revision);
      if (initial.envelope.taskKind !== 'maintenance.rolling_summary' || !input.taskId.startsWith(TASK_PREFIX)) return null;
      const runId = input.taskId.slice(TASK_PREFIX.length);
      if (!token(runId)) reject('agent-loop-prepare-input-invalid');
      const initialDigest = digest(initial);
      const recheck = () => {
        const next = current(input.taskId, input.revision);
        if (digest(next) !== initialDigest) reject('agent-loop-prepare-record-changed');
      };
      const read = async () => {
        try { return await readSource(runId); }
        catch { return reject('agent-loop-prepare-source-unavailable'); }
      };
      const first = await read();
      recheck();
      if (!first || first.job?.taskKind !== 'rolling_summary'
        || !['queued', 'running'].includes(first.job.status)) return null;
      const captureSafe = (source: AgentLoopMaintenancePrepareSource) => {
        try { return capture(source, initial, runId); }
        catch (error) {
          if (error instanceof AgentLoopMaintenancePrepareError) throw error;
          return reject('agent-loop-prepare-source-invalid');
        }
      };
      const prepared = captureSafe(first);
      const second = await read();
      recheck();
      if (!second || second.job?.taskKind !== 'rolling_summary'
        || !['queued', 'running'].includes(second.job.status)) reject('agent-loop-prepare-source-changed');
      const verified = captureSafe(second);
      if (digest(prepared) !== digest(verified)) reject('agent-loop-prepare-source-changed');
      recheck();
      const registration = MAINTENANCE_TASK_KIND_REGISTRY.rolling_summary;
      return Object.freeze({ version: AGENT_LOOP_MAINTENANCE_PREPARE_VERSION,
        requestStage: 'host-base-before-gateway-prepare' as const,
        taskId: input.taskId, revision: initial.revision, taskKind: 'maintenance.rolling_summary' as const,
        envelopeDigest: initial.envelopeDigest, ...prepared, taskContractRef: registration.contractRef,
        contractRevision: registration.contractRevision, verifierSetRef: registration.verifierSetRef,
        verifierSetRevision: registration.verifierSetRevision, executionAuthorized: false as const });
    },
  });
}

/** Shared pure data checks only; neither function grants admission, a claim or model execution. */
export { profileOf as resolveAgentLoopMaintenanceProfile, snapshotOf as validateAgentLoopMaintenanceSnapshot };
