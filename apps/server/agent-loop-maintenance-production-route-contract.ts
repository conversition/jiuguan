// §13.85 production dual-policy route contract.
//
// This module is deliberately declarative and inert. It records the exact
// production admission tuple and the independently versioned execution route,
// but it grants no Manager claim, Provider invocation, publication or
// completion authority.
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  isPublicMaintenanceJob,
  isSafeOpaqueId,
  type PublicMaintenanceJob,
} from '@jiuguan/mobile-contracts';
import { MAINTENANCE_ADMISSION_POLICY_VERSION } from '../../packages/agent-policy/public/maintenance-admission.ts';
import {
  AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT,
  AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE,
  AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE_VERSION,
} from './agent-loop-maintenance-execution-support.ts';
import { MAINTENANCE_POLICY_VERSION } from './maintenance-types.ts';

export const AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION =
  'agent-loop-maintenance-production-route-contract-v1' as const;

// Pin every upstream version represented by contract-v1. A dependency bump is
// intentionally a compile failure until this contract and its digest are
// reviewed and versioned together.
const JOB_ADMISSION_POLICY_VERSION =
  'p14-maintenance-admission-v3' as const satisfies typeof MAINTENANCE_ADMISSION_POLICY_VERSION;
const EXECUTION_POLICY_VERSION =
  'p13b-v1' as const satisfies typeof MAINTENANCE_POLICY_VERSION;
const EXECUTION_ACCEPTANCE_VERSION =
  'agent-loop-maintenance-correction-proposal-only-acceptance-v1' as const satisfies
    typeof AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE_VERSION;
const EXECUTION_CONTRACT_VERSION =
  'agent-loop-maintenance-correction-once-contract-v1' as const satisfies
    typeof AGENT_LOOP_MAINTENANCE_CORRECTION_ONCE_CONTRACT.version;
const EXECUTION_PROTOCOL =
  'correction-once' as const satisfies
    typeof AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE.scope.protocol;
const EXECUTION_ROUTE =
  'correction-proposal' as const satisfies
    typeof AGENT_LOOP_MAINTENANCE_CORRECTION_PROPOSAL_ONLY_ACCEPTANCE.scope.route;

const PRISTINE_JOB = Object.freeze({
  status: 'queued' as const,
  attempt: 0 as const,
  // Nulls describe the public wire meaning. The matcher below is stricter: the
  // optional fields must be absent, so an explicit null/undefined cannot be
  // mistaken for a Manager-issued pristine job.
  startedAt: null,
  finishedAt: null,
  errorCode: null,
});

const JOB_ADMISSION = Object.freeze({
  policyVersion: JOB_ADMISSION_POLICY_VERSION,
  taskKind: 'rolling_summary' as const,
  mode: 'shadow' as const,
  trigger: 'post-turn' as const,
  pristine: PRISTINE_JOB,
});

const EXECUTION = Object.freeze({
  policyVersion: EXECUTION_POLICY_VERSION,
  protocol: EXECUTION_PROTOCOL,
  route: EXECUTION_ROUTE,
  acceptanceVersion: EXECUTION_ACCEPTANCE_VERSION,
  contractVersion: EXECUTION_CONTRACT_VERSION,
});

export const AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT = Object.freeze({
  version: AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_VERSION,
  jobAdmission: JOB_ADMISSION,
  execution: EXECUTION,
  admissionAuthorized: false as const,
  claimAuthorized: false as const,
  executionAuthorized: false as const,
  completionAuthorized: false as const,
  publicationAuthorized: false as const,
  canaryAuthorized: false as const,
  productionEligible: false as const,
});

export type AgentLoopMaintenanceProductionRouteContract =
  typeof AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT;

export type AgentLoopMaintenanceProductionRouteJob = Omit<PublicMaintenanceJob,
  'taskKind' | 'policyVersion' | 'trigger' | 'mode' | 'status' | 'attempt'
  | 'parentRunId' | 'startedAt' | 'finishedAt' | 'errorCode' | 'budget' | 'proposal'> & Readonly<{
    taskKind: 'rolling_summary';
    policyVersion: typeof JOB_ADMISSION_POLICY_VERSION;
    parentRunId: string;
    trigger: 'post-turn';
    mode: 'shadow';
    status: 'queued';
    attempt: 0;
    startedAt?: never;
    finishedAt?: never;
    errorCode?: never;
    budget?: never;
    proposal?: never;
  }>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('production-route-contract-not-json');
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export const AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT_DIGEST =
  canonicalDigest(AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT);

const JOB_KEYS = Object.freeze([
  'attempt', 'createdAt', 'mode', 'parentRunId', 'policyVersion', 'runId',
  'sessionId', 'sourceRevision', 'status', 'taskKind', 'trigger', 'updatedAt',
] as const);

/**
 * Reads only plain own data descriptors. Proxy detection happens before any
 * reflective operation; accessors and thenables are never invoked or awaited.
 */
function exactOwnJobData(input: unknown): Record<string, unknown> | null {
  try {
    if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)
      || nodeTypes.isPromise(input) || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== JOB_KEYS.length
      || ownKeys.some((key) => typeof key !== 'string' || !JOB_KEYS.includes(
        key as (typeof JOB_KEYS)[number],
      ))) return null;
    const output: Record<string, unknown> = {};
    for (const key of JOB_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined
        || descriptor.enumerable !== true) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

/**
 * Strict, synchronous and side-effect-free match for a production-admitted,
 * still-pristine PublicMaintenanceJob. It deliberately does not translate the
 * p14 admission policy into the p13b execution policy or grant a route.
 */
export function matchesAgentLoopMaintenanceProductionRouteJob(
  input: unknown,
): input is AgentLoopMaintenanceProductionRouteJob {
  const job = exactOwnJobData(input);
  if (!job || !isPublicMaintenanceJob(job)) return false;
  return job.policyVersion === JOB_ADMISSION.policyVersion
    && job.taskKind === JOB_ADMISSION.taskKind
    && job.mode === JOB_ADMISSION.mode
    && job.trigger === JOB_ADMISSION.trigger
    && job.status === PRISTINE_JOB.status
    && job.attempt === PRISTINE_JOB.attempt
    && isSafeOpaqueId(job.parentRunId)
    && job.createdAt === job.updatedAt;
}

/**
 * Complete pristine queued-job identity shared by source proof, dispatcher and
 * Manager validation. Unlike the narrower cohort digest, this binds parent,
 * trigger, updatedAt and every absent optional public field.
 */
export function agentLoopMaintenanceProductionQueuedJobDigest(
  input: unknown,
): string | null {
  if (!matchesAgentLoopMaintenanceProductionRouteJob(input)) return null;
  const job = input as AgentLoopMaintenanceProductionRouteJob;
  return `sha256:${createHash('sha256').update(JSON.stringify({
    runId: job.runId,
    sessionId: job.sessionId,
    taskKind: job.taskKind,
    sourceRevision: job.sourceRevision,
    policyVersion: job.policyVersion,
    parentRunId: job.parentRunId ?? null,
    trigger: job.trigger,
    mode: job.mode,
    status: job.status,
    attempt: job.attempt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    errorCode: job.errorCode ?? null,
    budget: job.budget ?? null,
    proposal: job.proposal ?? null,
  }), 'utf8').digest('hex')}`;
}

function exactConstant(input: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(input, expected);
  try {
    if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)
      || nodeTypes.isPromise(input)) return false;
    const expectedArray = Array.isArray(expected);
    if (Array.isArray(input) !== expectedArray) return false;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== (expectedArray ? Array.prototype : Object.prototype)
      && (!expectedArray && prototype !== null)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const actualKeys = Reflect.ownKeys(descriptors);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
    for (const key of expectedKeys) {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined
        || descriptor.enumerable !== true
        || !exactConstant(descriptor.value, (expected as Record<string, unknown>)[key])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Exact content validator for persisted/configured copies of contract-v1. */
export function isAgentLoopMaintenanceProductionRouteContract(
  input: unknown,
): input is AgentLoopMaintenanceProductionRouteContract {
  return exactConstant(input, AGENT_LOOP_MAINTENANCE_PRODUCTION_ROUTE_CONTRACT);
}
