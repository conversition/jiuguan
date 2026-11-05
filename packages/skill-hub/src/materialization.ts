import {
  computeAgentSkillBodyHash,
  exactAgentSkillTokens,
  type AgentSkillHeaderV1,
} from './manifest.ts';
import {
  assertAgentSkillWithinGrant,
  normalizeAgentSkillExecutionGrant,
  normalizeAgentSkillSelectionReceipt,
  normalizeAgentSkillSelectionRequest,
  type AgentSkillExecutionGrantV1,
  type AgentSkillSelectionReceiptV1,
  type AgentSkillSelectionRequestV1,
  type SelectedAgentSkillV1,
} from './selector.ts';
import { deepFreeze, digestCanonical } from './internal.ts';

export const AGENT_SKILL_BODY_REQUEST_VERSION = 'agent-skill-body-request-v1' as const;
export const AGENT_SKILL_ADMISSION_VERSION = 'agent-skill-admission-v1' as const;
export const ADMITTED_AGENT_SKILL_VERSION = 'admitted-agent-skill-v1' as const;

export interface AgentSkillBodyRequestV1 {
  readonly requestVersion: typeof AGENT_SKILL_BODY_REQUEST_VERSION;
  readonly catalogRevision: string;
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
}

export interface AdmittedAgentSkillSnapshotV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly bodyTokens: number;
  readonly sourceHash: string;
  readonly sourceRevision: string;
}

export interface AdmittedAgentSkillV1 {
  readonly admittedVersion: typeof ADMITTED_AGENT_SKILL_VERSION;
  readonly header: AgentSkillHeaderV1;
  /** Exact materialized body, byte-for-byte as represented by the JavaScript string. */
  readonly body: string;
  readonly snapshot: AdmittedAgentSkillSnapshotV1;
}

export interface AgentSkillAdmissionV1 {
  readonly admissionVersion: typeof AGENT_SKILL_ADMISSION_VERSION;
  readonly catalogRevision: string;
  readonly selectionReceiptDigest: string;
  readonly instructionSetDigest: string;
  readonly totalBodyTokens: number;
  readonly skills: readonly AdmittedAgentSkillV1[];
  readonly admissionDigest: string;
}

export type AgentSkillBodyLoader = (request: AgentSkillBodyRequestV1) => string;
export type AsyncAgentSkillBodyLoader = (request: AgentSkillBodyRequestV1) => Promise<string>;

function bodyRequest(
  receipt: AgentSkillSelectionReceiptV1,
  selected: SelectedAgentSkillV1,
): AgentSkillBodyRequestV1 {
  return deepFreeze({
    requestVersion: AGENT_SKILL_BODY_REQUEST_VERSION,
    catalogRevision: receipt.catalogRevision,
    skillId: selected.header.manifest.skillId,
    version: selected.header.manifest.version,
    manifestDigest: selected.header.manifestDigest,
    bodyHash: selected.header.manifest.bodyHash,
  });
}

function admitBody(selected: SelectedAgentSkillV1, body: string): AdmittedAgentSkillV1 {
  if (typeof body !== 'string') throw new TypeError('Skill body loader must return a string');
  const manifest = selected.header.manifest;
  if (computeAgentSkillBodyHash(body) !== manifest.bodyHash) {
    throw new Error(`Skill bodyHash mismatch: ${manifest.skillId}@${manifest.version}`);
  }
  const exactTokens = exactAgentSkillTokens(body);
  if (exactTokens !== manifest.bodyTokens) {
    throw new Error(`Skill bodyTokens mismatch: ${manifest.skillId}@${manifest.version}`);
  }
  return deepFreeze({
    admittedVersion: ADMITTED_AGENT_SKILL_VERSION,
    header: selected.header,
    body,
    snapshot: {
      skillId: manifest.skillId,
      version: manifest.version,
      manifestDigest: selected.header.manifestDigest,
      bodyHash: manifest.bodyHash,
      bodyTokens: exactTokens,
      sourceHash: manifest.sourceHash,
      sourceRevision: manifest.sourceRevision,
    },
  });
}

function finishAdmission(
  receipt: AgentSkillSelectionReceiptV1,
  skills: readonly AdmittedAgentSkillV1[],
): AgentSkillAdmissionV1 {
  const totalBodyTokens = skills.reduce((sum, item) => sum + item.snapshot.bodyTokens, 0);
  if (totalBodyTokens !== receipt.usedTokens) throw new Error('materialized Skill token total changed after selection');
  const core = deepFreeze({
    admissionVersion: AGENT_SKILL_ADMISSION_VERSION,
    catalogRevision: receipt.catalogRevision,
    selectionReceiptDigest: receipt.receiptDigest,
    instructionSetDigest: receipt.instructionSetDigest,
    totalBodyTokens,
    skills: Object.freeze([...skills]),
  });
  return deepFreeze({ ...core, admissionDigest: digestCanonical(core) });
}

function validateBeforeLoading(
  receiptInput: unknown,
  grantInput: unknown,
  requestInput?: unknown,
): Readonly<{ receipt: AgentSkillSelectionReceiptV1; grant: AgentSkillExecutionGrantV1 }> {
  const receipt = normalizeAgentSkillSelectionReceipt(receiptInput);
  const grant = normalizeAgentSkillExecutionGrant(grantInput);
  if (requestInput !== undefined) {
    const request = normalizeAgentSkillSelectionRequest(requestInput);
    if (request.catalogRevision !== receipt.catalogRevision
      || digestCanonical(request) !== receipt.requestDigest) {
      throw new Error('Skill selection receipt does not match the current selection request');
    }
  }
  if (receipt.budgetConflict) {
    throw new Error('Skill selection has an unresolved input-token budget conflict');
  }
  if (receipt.budgetTokens > grant.maxInputTokens || receipt.usedTokens > grant.maxInputTokens) {
    throw new Error('Skill selection exceeds the current host input-token grant');
  }
  // Repeat authority validation at the provider/body boundary. A persisted receipt is not a grant.
  for (const selected of receipt.selected) assertAgentSkillWithinGrant(selected.header, grant);
  return Object.freeze({ receipt, grant });
}

/**
 * Low-level pure primitive: materialize only selected bodies and re-verify every whole body.
 * Service callers must first reselect from their authoritative current Catalog; Receipt digest
 * self-consistency alone is not authorization to consume a Skill.
 */
export function materializeAgentSkillSelection(
  receiptInput: unknown,
  grantInput: unknown,
  loadBody: AgentSkillBodyLoader,
  requestInput?: AgentSkillSelectionRequestV1,
): AgentSkillAdmissionV1 {
  if (typeof loadBody !== 'function') throw new TypeError('loadBody must be a function');
  const { receipt } = validateBeforeLoading(receiptInput, grantInput, requestInput);
  const skills = receipt.selected.map((selected) => admitBody(selected, loadBody(bodyRequest(receipt, selected))));
  return finishAdmission(receipt, skills);
}

/**
 * Async low-level variant; requests remain sequential and deterministic in injection order.
 * The server composition owns authoritative Catalog reselection before calling this primitive.
 */
export async function materializeAgentSkillSelectionAsync(
  receiptInput: unknown,
  grantInput: unknown,
  loadBody: AsyncAgentSkillBodyLoader,
  requestInput?: AgentSkillSelectionRequestV1,
): Promise<AgentSkillAdmissionV1> {
  if (typeof loadBody !== 'function') throw new TypeError('loadBody must be a function');
  const { receipt } = validateBeforeLoading(receiptInput, grantInput, requestInput);
  const skills: AdmittedAgentSkillV1[] = [];
  for (const selected of receipt.selected) {
    skills.push(admitBody(selected, await loadBody(bodyRequest(receipt, selected))));
  }
  return finishAdmission(receipt, skills);
}
