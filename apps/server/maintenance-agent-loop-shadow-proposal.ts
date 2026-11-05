/** P17-02.5b1: immutable prepared storage origin, not an AL Action/proof or completion grant. */
import { createHash } from 'node:crypto';
import { shadowDiff } from './maintenance-proposal-committer.ts';
import { isRollingSummaryApplyContext, isMaintenanceTrigger, validateMaintenanceProposal,
  type MaintenanceProposal, type MaintenanceStrictProposalContext, type PublicMaintenanceJob,
  type RollingSummaryProposalContext } from './maintenance-types.ts';

export const MAINTENANCE_AGENT_LOOP_SHADOW_PREPARATION_VERSION = 'maintenance-agent-loop-shadow-preparation-v1' as const;
export type MaintenanceAgentLoopShadowProposalContext = RollingSummaryProposalContext & Readonly<{
  expectedSummaryRound: number; historyEpoch: number; baseSummaryDigest: string; inputDigest: string;
  sourceEvidence: NonNullable<RollingSummaryProposalContext['sourceEvidence']>;
}>;
export interface MaintenanceAgentLoopShadowProposalPreparation {
  readonly version: typeof MAINTENANCE_AGENT_LOOP_SHADOW_PREPARATION_VERSION;
  readonly runId: string; readonly sessionId: string; readonly sourceRevision: string;
  readonly policyVersion: string; readonly parentRunId: string;
  readonly trigger: PublicMaintenanceJob['trigger']; readonly mode: 'shadow'; readonly attempt: number;
  readonly ownerInstanceId: string; readonly jobCreatedAt: string; readonly jobStartedAt: string;
  readonly createdAt: string; readonly proposalDigest: string; readonly proposalContextDigest: string;
  readonly preparationDigest: string;
}
export interface MaintenanceAgentLoopShadowProposalRecord {
  readonly proposalId: string; readonly jobRunId: string; readonly sessionId: string;
  readonly taskKind: 'rolling_summary'; readonly sourceRevision: string; readonly proposalDigest: string;
  readonly proposal: MaintenanceProposal; readonly context: MaintenanceAgentLoopShadowProposalContext;
  readonly diff: Readonly<Record<string, unknown>>; readonly status: 'prepared'; readonly revision: 1;
  readonly createdAt: string; readonly updatedAt: string;
  readonly preparation: MaintenanceAgentLoopShadowProposalPreparation;
}
export const MAINTENANCE_AGENT_LOOP_SHADOW_PUBLICATION_VERSION = 'maintenance-agent-loop-shadow-publication-v1' as const;
/** Content-free historical join metadata. This DTO is never a live publication grant. */
export interface MaintenanceAgentLoopShadowPublicationInput {
  readonly version: typeof MAINTENANCE_AGENT_LOOP_SHADOW_PUBLICATION_VERSION;
  readonly runId: string; readonly taskId: string; readonly attemptId: string; readonly taskRevision: number;
  readonly taskUpdatedAt: string;
  readonly envelopeDigest: string; readonly candidateRef: string; readonly candidateDigest: string;
  readonly verificationResultRef: string; readonly verificationDigest: string;
  readonly actionId: string; readonly actionDigest: string; readonly actionWatermark: string;
  readonly claimDigest: string; readonly sourceDigest: string; readonly preparationDigest: string;
  readonly proposalDigest: string; readonly proposalContextDigest: string;
}
export interface MaintenanceAgentLoopShadowPublicationReceipt extends MaintenanceAgentLoopShadowPublicationInput {
  readonly publishedAt: string; readonly publicationDigest: string;
}
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
function invalid(): never { throw new Error('maintenance-agent-loop-shadow-proposal-input-invalid'); }
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const row = value as Record<string, unknown>, ownKeys = Reflect.ownKeys(row);
  if (ownKeys.some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key) ?? {}, 'value'))
    || keys && (ownKeys.length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))) invalid();
  return row;
}
function canonical(value: unknown, stack = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || stack.has(value)) invalid();
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
      return `[${Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
        return canonical(descriptor.value, stack);
      }).join(',')}]`;
    }
    const row = record(value);
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key], stack)}`).join(',')}}`;
  } finally { stack.delete(value); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
export function maintenanceAgentLoopShadowProposalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}
function storedJsonDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function token(value: unknown): string { if (typeof value !== 'string' || !TOKEN.test(value)) invalid(); return value; }
function digest(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

/** Strict metadata normalization does not establish producer or verifier authority. */
export function normalizeMaintenanceAgentLoopShadowPublicationInput(value: unknown): MaintenanceAgentLoopShadowPublicationInput {
  const row = record(value, ['version', 'runId', 'taskId', 'attemptId', 'taskRevision', 'taskUpdatedAt', 'envelopeDigest',
    'candidateRef', 'candidateDigest', 'verificationResultRef', 'verificationDigest', 'actionId', 'actionDigest',
    'actionWatermark', 'claimDigest', 'sourceDigest', 'preparationDigest', 'proposalDigest', 'proposalContextDigest']);
  if (row.version !== MAINTENANCE_AGENT_LOOP_SHADOW_PUBLICATION_VERSION
    || typeof row.runId !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(row.runId)
    || !Number.isSafeInteger(row.taskRevision) || (row.taskRevision as number) < 1
    || (row.taskRevision as number) > Number.MAX_SAFE_INTEGER - 2) invalid();
  return freeze({ version: MAINTENANCE_AGENT_LOOP_SHADOW_PUBLICATION_VERSION, runId: row.runId,
    taskId: token(row.taskId), attemptId: token(row.attemptId), taskRevision: row.taskRevision as number,
    taskUpdatedAt: time(row.taskUpdatedAt),
    envelopeDigest: digest(row.envelopeDigest), candidateRef: token(row.candidateRef), candidateDigest: digest(row.candidateDigest),
    verificationResultRef: token(row.verificationResultRef), verificationDigest: digest(row.verificationDigest),
    actionId: token(row.actionId), actionDigest: digest(row.actionDigest), actionWatermark: token(row.actionWatermark),
    claimDigest: digest(row.claimDigest), sourceDigest: digest(row.sourceDigest), preparationDigest: digest(row.preparationDigest),
    proposalDigest: digest(row.proposalDigest), proposalContextDigest: digest(row.proposalContextDigest) });
}

export function createMaintenanceAgentLoopShadowPublicationReceipt(input: {
  readonly publication: MaintenanceAgentLoopShadowPublicationInput;
  readonly preparation: MaintenanceAgentLoopShadowProposalPreparation; readonly publishedAt: string;
}): MaintenanceAgentLoopShadowPublicationReceipt {
  record(input, ['publication', 'preparation', 'publishedAt']);
  const publication = normalizeMaintenanceAgentLoopShadowPublicationInput(input.publication);
  const preparation = record(input.preparation), publishedAt = time(input.publishedAt);
  if (publication.runId !== preparation.runId || publication.preparationDigest !== preparation.preparationDigest
    || publication.proposalDigest !== preparation.proposalDigest
    || publication.proposalContextDigest !== preparation.proposalContextDigest
    || typeof preparation.createdAt !== 'string' || publishedAt < preparation.createdAt) invalid();
  const metadata = { ...publication, publishedAt };
  return freeze({ ...metadata, publicationDigest: maintenanceAgentLoopShadowProposalDigest(metadata) });
}

/** A persisted receipt remains historical evidence, never an opaque host capability. */
export function parseMaintenanceAgentLoopShadowPublicationReceipt(value: unknown,
  preparation: MaintenanceAgentLoopShadowProposalPreparation): MaintenanceAgentLoopShadowPublicationReceipt {
  const row = record(value), { publishedAt, publicationDigest, ...publication } = row;
  const expected = createMaintenanceAgentLoopShadowPublicationReceipt({
    publication: publication as unknown as MaintenanceAgentLoopShadowPublicationInput, preparation, publishedAt: time(publishedAt) });
  if (digest(publicationDigest) !== expected.publicationDigest || canonical(row) !== canonical(expected)) invalid();
  return expected;
}

/** Strict bounded canonical body. Its validation establishes no live producer authority. */
export function normalizeMaintenanceAgentLoopShadowProposal(input: {
  readonly proposal: MaintenanceProposal; readonly proposalContext: MaintenanceStrictProposalContext;
}): Readonly<{ proposal: MaintenanceProposal; context: MaintenanceAgentLoopShadowProposalContext;
  proposalDigest: string; proposalContextDigest: string; diff: Readonly<Record<string, unknown>> }> {
  record(input, ['proposal', 'proposalContext']);
  record(input.proposal, ['taskKind', 'payload']);
  record(input.proposalContext, ['sessionId', 'sourceRevision', 'targetRound', 'expectedSummaryRound',
    'historyEpoch', 'baseSummaryDigest', 'inputDigest', 'sourceEvidence']);
  const proposalText = canonical(input.proposal), contextText = canonical(input.proposalContext);
  if (Buffer.byteLength(proposalText, 'utf8') > 65_536 || Buffer.byteLength(contextText, 'utf8') > 131_072) invalid();
  const context = JSON.parse(contextText) as MaintenanceAgentLoopShadowProposalContext;
  if (!Array.isArray(context.sourceEvidence)) invalid();
  // The existing domain inputDigest contract uses this original evidence field
  // order. Sorted transport keys must not change the domain's historical hash.
  const sourceEvidence = context.sourceEvidence.map(value => {
    const row = record(value, ['ref', 'messageId', 'round', 'role', 'contentDigest']);
    return { ref: row.ref, messageId: row.messageId, round: row.round, role: row.role, contentDigest: row.contentDigest };
  });
  const normalizedContext = { ...context, sourceEvidence } as MaintenanceAgentLoopShadowProposalContext;
  const raw = JSON.parse(proposalText) as MaintenanceProposal;
  if (raw.taskKind !== 'rolling_summary' || !isRollingSummaryApplyContext(normalizedContext)) invalid();
  const proposal = validateMaintenanceProposal('rolling_summary', raw.payload, normalizedContext);
  if (canonical(proposal) !== proposalText) invalid();
  return freeze({ proposal, context: normalizedContext, proposalDigest: storedJsonDigest(proposal),
    proposalContextDigest: storedJsonDigest(normalizedContext), diff: shadowDiff(proposal) });
}

/** Plain storage metadata only. Callers must separately enforce the real live claim and source fence. */
export function createMaintenanceAgentLoopShadowProposalPreparation(input: {
  readonly job: PublicMaintenanceJob; readonly ownerInstanceId: string; readonly createdAt: string;
  readonly proposalDigest: string; readonly proposalContextDigest: string;
}): MaintenanceAgentLoopShadowProposalPreparation {
  record(input, ['job', 'ownerInstanceId', 'createdAt', 'proposalDigest', 'proposalContextDigest']);
  record(input.job);
  const job = input.job;
  if (job.taskKind !== 'rolling_summary' || job.mode !== 'shadow' || !/^mjob_[a-f0-9]{32}$/u.test(job.runId)
    || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !isMaintenanceTrigger(job.trigger)) invalid();
  const metadata = {
    version: MAINTENANCE_AGENT_LOOP_SHADOW_PREPARATION_VERSION, runId: job.runId,
    sessionId: token(job.sessionId), sourceRevision: digest(job.sourceRevision), policyVersion: token(job.policyVersion),
    parentRunId: token(job.parentRunId ?? job.runId), trigger: job.trigger, mode: 'shadow' as const,
    attempt: job.attempt, ownerInstanceId: token(input.ownerInstanceId), jobCreatedAt: time(job.createdAt),
    jobStartedAt: time(job.startedAt), createdAt: time(input.createdAt), proposalDigest: digest(input.proposalDigest),
    proposalContextDigest: digest(input.proposalContextDigest),
  };
  if (metadata.jobCreatedAt > metadata.jobStartedAt || metadata.jobStartedAt > metadata.createdAt) invalid();
  return freeze({ ...metadata, preparationDigest: maintenanceAgentLoopShadowProposalDigest(metadata) });
}

/** A disk read validates immutable original job/body bindings, never upgrades JSON into a live capability. */
export function parseMaintenanceAgentLoopShadowProposalPreparation(value: unknown, input: {
  readonly job: PublicMaintenanceJob; readonly createdAt: string; readonly proposalDigest: string;
  readonly proposalContextDigest: string;
}): MaintenanceAgentLoopShadowProposalPreparation {
  record(input, ['job', 'createdAt', 'proposalDigest', 'proposalContextDigest']);
  record(input.job);
  const row = record(value, ['version', 'runId', 'sessionId', 'sourceRevision', 'policyVersion', 'parentRunId',
    'trigger', 'mode', 'attempt', 'ownerInstanceId', 'jobCreatedAt', 'jobStartedAt', 'createdAt',
    'proposalDigest', 'proposalContextDigest', 'preparationDigest']);
  const expected = createMaintenanceAgentLoopShadowProposalPreparation({ ...input, ownerInstanceId: token(row.ownerInstanceId) });
  if (canonical(row) !== canonical(expected)) invalid();
  return expected;
}

/** Reject async/boolean/thenable returns without executing a foreign then property. */
export function assertMaintenanceAgentLoopShadowSource(authorizeCommit: () => void): void {
  if (typeof authorizeCommit !== 'function') throw new Error('maintenance-agent-loop-shadow-proposal-authorization-invalid');
  let result: unknown;
  try { result = authorizeCommit(); }
  catch { throw new Error('maintenance-agent-loop-shadow-proposal-authorization-invalid'); }
  if (result !== undefined) {
    if (result !== null && typeof result === 'object') {
      try { void Promise.prototype.then.call(result, () => undefined, () => undefined); }
      catch { /* Neither an arbitrary thenable nor its getters are invoked. */ }
    }
    throw new Error('maintenance-agent-loop-shadow-proposal-authorization-invalid');
  }
}
