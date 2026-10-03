import {
  admissionLimitsFromBudgetProfile,
  agentToolSetDigest,
  type AgentContentMode,
  type AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';
import {
  agentBudgetProfileDigest,
  normalizeAgentBudgetProfile,
  type AgentBudgetProfileInput,
} from '../../packages/agent-policy/src/budget-profile.ts';
import type { SkillAdmissionSnapshot } from '../../packages/agent-policy/src/skill-admission.ts';
import type { HarnessModel } from '../../packages/harness/src/types.ts';
import type { ProviderFailureDiagnosticCode } from '../../packages/proxy/src/provider-registry.ts';
import { AdmissionTicketBroker } from './agent-admission-broker.ts';
import {
  AdmittedModelGateway,
  type AdmittedModelLeaseOutcome,
  type AdmittedModelLeaseSnapshot,
} from './admitted-model-gateway.ts';
import {
  maintenanceHarnessContent,
  maintenanceHarnessRequest,
} from './maintenance-model-adapter.ts';
import type { MaintenanceTaskKind, PublicMaintenanceJob } from './maintenance-types.ts';

const TASK_BINDING: Readonly<Record<MaintenanceTaskKind, Readonly<{
  taskKind: AgentTaskKind;
  budgetLane: 'preference' | 'style' | 'arc' | 'npc';
  expectedBenefit: 'memory-quality' | 'arc-coherence' | 'npc-consistency';
}>>> = Object.freeze({
  memory_consolidation: Object.freeze({
    taskKind: 'memory_consolidation', budgetLane: 'preference', expectedBenefit: 'memory-quality',
  }),
  branch_index: Object.freeze({
    taskKind: 'branch_index', budgetLane: 'arc', expectedBenefit: 'arc-coherence',
  }),
  rolling_summary: Object.freeze({
    taskKind: 'rolling_summary', budgetLane: 'style', expectedBenefit: 'memory-quality',
  }),
  npc_state: Object.freeze({
    taskKind: 'npc_state', budgetLane: 'npc', expectedBenefit: 'npc-consistency',
  }),
});

const QUERY_TOOL = (name: 'query_memory' | 'get_worldbook'): Record<string, unknown> => ({
  type: 'function',
  function: {
    name,
    description: 'Read-only bounded maintenance context lookup.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['query'],
    },
  },
});

const VARIABLES_TOOL: Record<string, unknown> = {
  type: 'function',
  function: {
    name: 'get_variables',
    description: 'Read-only bounded variable lookup.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        keys: {
          type: 'array', maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
  },
};

function proposalParameters(taskKind: MaintenanceTaskKind): Record<string, unknown> {
  const boundedString = { type: 'string', minLength: 1 };
  if (taskKind === 'memory_consolidation') return {
    type: 'object', additionalProperties: false, required: ['facts', 'supersedes'],
    properties: {
      facts: {
        type: 'array', maxItems: 512, items: {
          type: 'object', additionalProperties: false, required: ['subject', 'predicate', 'value'],
          properties: {
            subject: { ...boundedString, maxLength: 240 },
            predicate: { ...boundedString, maxLength: 120 },
            value: { type: ['string', 'number', 'boolean', 'null'] },
            sourceRound: { type: 'integer', minimum: 0 },
          },
        },
      },
      supersedes: { type: 'array', maxItems: 512, items: { ...boundedString, maxLength: 160 } },
    },
  };
  if (taskKind === 'branch_index') return {
    type: 'object', additionalProperties: false,
    required: ['version', 'sessionId', 'sourceRevision', 'actions'],
    properties: {
      version: { type: 'string', const: 'arc-maintenance-proposal-v1' },
      sessionId: { ...boundedString, maxLength: 240 },
      sourceRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      actions: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'arcId', 'status', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'set_status' },
                arcId: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' },
                status: { type: 'string', enum: ['open', 'closed', 'dormant'] },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'arcIds', 'targetArcId', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'merge' },
                arcIds: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' } },
                targetArcId: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'arcIds', 'boundaryRound', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'chapter_boundary' },
                arcIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' } },
                boundaryRound: { type: 'integer', minimum: 1 },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'arcId', 'dependencyArcIds', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'order_dependencies' },
                arcId: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' },
                dependencyArcIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' } },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'arcIds', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'mark_source_conflict' },
                arcIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^arc:sha256:[a-f0-9]{64}$' } },
                sourceRefs: { type: 'array', minItems: 2, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
          ],
        },
      },
    },
  };
  if (taskKind === 'rolling_summary') return {
    type: 'object', additionalProperties: false, required: ['summary', 'throughRound'],
    properties: {
      summary: { ...boundedString, maxLength: 16_000 },
      throughRound: { type: 'integer', minimum: 0 },
    },
  };
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'sessionId', 'sourceRevision', 'entries'],
    properties: {
      version: { type: 'string', const: 'npc-maintenance-proposal-v1' },
      sessionId: { ...boundedString, maxLength: 240 },
      sourceRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      entries: {
        type: 'array', minItems: 1, maxItems: 64,
        items: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'mentionDigest', 'reasonCode', 'confidence', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'unresolved' },
                mentionDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
                reasonCode: { type: 'string', enum: ['ambiguous-mention', 'unknown-character', 'conflicting-identity'] },
                confidence: { type: 'string', const: 'low' },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'characterId', 'toCharacterId', 'relationType', 'perspective', 'status', 'confidence', 'effectiveRound', 'expectedEntityVersion', 'sourceRefs'],
              properties: {
                kind: { type: 'string', const: 'relationship' },
                characterId: { ...boundedString, maxLength: 160 },
                toCharacterId: { ...boundedString, maxLength: 160 },
                relationType: { ...boundedString, maxLength: 64 },
                perspective: { type: 'string', enum: ['objective', 'subjective'] },
                status: { type: 'string', enum: ['confirmed', 'pending', 'unresolved', 'last-known', 'unknown'] },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                effectiveRound: { type: 'integer', minimum: 1 },
                expectedEntityVersion: { type: 'integer', minimum: 0 },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'characterId', 'field', 'value', 'status', 'confidence', 'effectiveRound', 'expectedEntityVersion', 'sourceRefs'],
              properties: {
                kind: { type: 'string', enum: ['profile', 'objective_fact', 'belief', 'knowledge', 'secret', 'goal', 'history_only'] },
                characterId: { ...boundedString, maxLength: 160 },
                field: { ...boundedString, maxLength: 64 },
                value: {},
                status: { type: 'string', enum: ['confirmed', 'pending', 'unresolved', 'last-known', 'unknown'] },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                effectiveRound: { type: 'integer', minimum: 1 },
                expectedEntityVersion: { type: 'integer', minimum: 0 },
                sourceRefs: { type: 'array', minItems: 1, maxItems: 32, items: { ...boundedString, maxLength: 240 } },
              },
            },
          ],
        },
      },
    },
  };
}

/** Stable native declarations used only to bind and transport the existing Harness tool protocol. */
export function maintenanceProviderTools(taskKind: MaintenanceTaskKind): readonly Record<string, unknown>[] {
  return Object.freeze([
    QUERY_TOOL('query_memory'),
    QUERY_TOOL('get_worldbook'),
    VARIABLES_TOOL,
    {
      type: 'function',
      function: {
        name: `propose_${taskKind}`,
        description: `Submit one bounded ${taskKind} proposal; this does not commit domain state.`,
        parameters: proposalParameters(taskKind),
      },
    },
  ].map((tool) => Object.freeze(structuredClone(tool))));
}

/**
 * Frozen Q9 operational-replay schema. It exists only so historical evidence can be re-run
 * without changing its suite digest; production Harness always uses maintenanceProviderTools.
 */
export function legacyMaintenanceReplayProviderTools(
  taskKind: Extract<MaintenanceTaskKind, 'branch_index' | 'npc_state'>,
): readonly Record<string, unknown>[] {
  const legacyParameters = taskKind === 'branch_index'
    ? {
      type: 'object', additionalProperties: false, required: ['branches'],
      properties: {
        branches: {
          type: 'array', maxItems: 512, items: {
            type: 'object', additionalProperties: false,
            required: ['branchId', 'title', 'summary', 'status'],
            properties: {
              branchId: { type: 'string', minLength: 1, maxLength: 160 },
              title: { type: 'string', minLength: 1, maxLength: 240 },
              summary: { type: 'string', minLength: 1, maxLength: 2_000 },
              status: { type: 'string', enum: ['open', 'closed', 'dormant'] },
            },
          },
        },
      },
    }
    : {
      type: 'object', additionalProperties: false, required: ['characters'],
      properties: {
        characters: {
          type: 'array', maxItems: 512, items: {
            type: 'object', additionalProperties: false,
            required: ['characterId', 'evidenceKind', 'patch'],
            properties: {
              characterId: { type: 'string', minLength: 1, maxLength: 160 },
              evidenceKind: {
                type: 'string',
                enum: ['profile', 'objective_fact', 'belief', 'knowledge', 'secret', 'goal', 'history_only'],
              },
              patch: { type: 'object', minProperties: 1, maxProperties: 32 },
              sourceRound: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    };
  return Object.freeze([
    QUERY_TOOL('query_memory'),
    QUERY_TOOL('get_worldbook'),
    VARIABLES_TOOL,
    {
      type: 'function',
      function: {
        name: `propose_${taskKind}`,
        description: `Submit one bounded ${taskKind} proposal; this does not commit domain state.`,
        parameters: legacyParameters,
      },
    },
  ].map((tool) => Object.freeze(structuredClone(tool))));
}

function toolNames(tools: readonly Record<string, unknown>[]): readonly string[] {
  return Object.freeze(tools.map((tool) => {
    const fn = tool.function as Record<string, unknown> | undefined;
    if (tool.type !== 'function' || typeof fn?.name !== 'string') {
      throw new Error('maintenance-provider-tool-contract-invalid');
    }
    return fn.name;
  }).sort());
}

export interface AdmittedMaintenanceModelOptions {
  readonly broker: AdmissionTicketBroker;
  readonly gateway: AdmittedModelGateway;
  /** Must be a job already claimed by MaintenanceJobManager. */
  readonly job: PublicMaintenanceJob;
  /** Revision returned by the post-claim snapshot recheck. */
  readonly verifiedSourceRevision: string;
  readonly budgetProfile: AgentBudgetProfileInput;
  readonly modelId: string;
  readonly mode: AgentContentMode;
  readonly reasonCodes: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly noveltyDigest: string;
  readonly fullSkillSnapshots?: readonly SkillAdmissionSnapshot[];
  readonly nowMs?: () => number;
  /** Test seam; production uses one short bounded delay before the sole transient retry. */
  readonly transientRetryDelayMs?: number;
}

export interface AdmittedMaintenanceModelHandle {
  readonly model: HarnessModel;
  readonly ticketId: string;
  readonly taskKind: AgentTaskKind;
  snapshot(): AdmittedModelLeaseSnapshot;
  finish(outcome?: AdmittedModelLeaseOutcome): void;
}

const TRANSIENT_PROVIDER_FAILURES = new Set<ProviderFailureDiagnosticCode>([
  'provider-rate-limited',
  'provider-timeout',
  'provider-upstream-unavailable',
  'provider-transport-failed',
  'provider-stream-failed',
  'provider-stream-incomplete',
]);

function transientProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  let code: unknown;
  try { code = (error as { diagnosticCode?: unknown }).diagnosticCode; }
  catch { return false; }
  return typeof code === 'string'
    && TRANSIENT_PROVIDER_FAILURES.has(code as ProviderFailureDiagnosticCode);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Issue one post-claim Ticket and exchange it for a shared decreasing Gateway lease.
 * The caller must close the handle in a finally block after runBoundedLoop settles.
 */
export function createAdmittedMaintenanceModel(
  options: AdmittedMaintenanceModelOptions,
): AdmittedMaintenanceModelHandle {
  const { job } = options;
  if (job.status !== 'running') throw new Error('maintenance-job-not-claimed');
  if (options.verifiedSourceRevision !== job.sourceRevision) {
    throw new Error('maintenance-source-revision-stale');
  }
  if (!options.modelId) throw new Error('maintenance-model-unavailable');
  const task = TASK_BINDING[job.taskKind];
  const budgetProfile = normalizeAgentBudgetProfile(options.budgetProfile);
  if (budgetProfile.lane !== task.budgetLane) throw new Error('maintenance-budget-lane-mismatch');
  const tools = [...maintenanceProviderTools(job.taskKind)];
  const nowMs = options.nowMs ?? Date.now;
  const issuedAt = nowMs();
  const ticket = options.broker.issue({
    runId: job.runId,
    parentRunId: job.parentRunId ?? job.runId,
    sessionId: job.sessionId,
    sourceRevision: job.sourceRevision,
    lane: 'maintenance',
    taskKind: task.taskKind,
    policyVersion: job.policyVersion,
    modelId: options.modelId,
    budgetProfileDigest: agentBudgetProfileDigest(budgetProfile),
    toolSetDigest: agentToolSetDigest(tools),
    mode: options.mode,
    reasonCodes: options.reasonCodes,
    evidenceDigests: options.evidenceDigests,
    noveltyDigest: options.noveltyDigest,
    expectedBenefit: task.expectedBenefit,
    limits: admissionLimitsFromBudgetProfile(budgetProfile),
    deadlineMs: issuedAt + budgetProfile.maxWallMs,
    allowedTools: toolNames(tools),
    fullSkillSnapshots: options.fullSkillSnapshots ?? [],
    cooldownKey: `maintenance:${job.sessionId}:${job.taskKind}`,
    idempotencyKey: `admit:${job.runId}:${job.taskKind}`,
    fallback: 'defer-maintenance',
  });
  const lease = options.gateway.open({
    binding: {
      ticketId: ticket.ticketId,
      runId: ticket.runId,
      parentRunId: ticket.parentRunId,
      sessionId: ticket.sessionId,
      sourceRevision: ticket.sourceRevision,
      lane: ticket.lane,
      taskKind: ticket.taskKind,
      policyVersion: ticket.policyVersion,
      mode: ticket.mode,
      budgetProfile,
    },
    modelId: options.modelId,
    tools,
  });
  const model: HarnessModel = Object.freeze({
    name: options.modelId,
    async complete(input: Parameters<HarnessModel['complete']>[0]) {
      const firstSnapshot = lease.snapshot();
      const retryDelayMs = options.transientRetryDelayMs ?? 750;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = lease.snapshot();
        // The legacy Harness ledger exposes one aggregate token remainder (input + output).
        // The Gateway, correctly, binds max_tokens to the dedicated Agent output ceiling.
        const maxOutputTokens = Math.min(input.maxOutputTokens, before.outputTokensRemaining);
        if (maxOutputTokens < 1) throw new Error('maintenance-output-budget-exhausted');
        try {
          const response = await lease.complete(
            maintenanceHarnessRequest(options.modelId, { ...input, maxOutputTokens }, tools),
            input.signal,
          );
          const after = lease.snapshot();
          if (!response.usage) throw new Error('maintenance-provider-usage-unavailable');
          return {
            content: maintenanceHarnessContent(response),
            usage: {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
              costMicrousd: after.costMicrousdUsed - firstSnapshot.costMicrousdUsed,
            },
          };
        } catch (error) {
          const remaining = lease.snapshot();
          if (attempt > 0 || !transientProviderFailure(error)
            || remaining.status !== 'open' || remaining.modelCallsRemaining < 1
            || input.signal.aborted) throw error;
          await waitForRetry(retryDelayMs, input.signal);
        }
      }
      throw new Error('maintenance-provider-retry-unreachable');
    },
  });
  return Object.freeze({
    model,
    ticketId: ticket.ticketId,
    taskKind: task.taskKind,
    snapshot: () => lease.snapshot(),
    finish: (outcome: AdmittedModelLeaseOutcome = 'completed') => lease.finish(outcome),
  });
}
