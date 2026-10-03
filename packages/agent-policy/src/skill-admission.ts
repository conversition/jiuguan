import { createHash } from 'node:crypto';

export const SKILL_ADMISSION_VERSION = 'p14-skill-admission-v1' as const;

export type SkillRole = 'style' | 'tactical';
export type SkillSelectionReason = 'explicit' | 'keyword' | 'semantic';

export interface SkillAdmissionCandidate {
  readonly skillId: string;
  readonly name: string;
  readonly role?: SkillRole;
  readonly version: string;
  readonly sourceHash: string;
  readonly body: string;
  readonly selectionReason: SkillSelectionReason;
  readonly explicit: boolean;
}

export interface BudgetedSkillAdmissionCandidate extends SkillAdmissionCandidate {
  /** Match confidence in [0, 1]. Explicit candidates ignore this value for precedence. */
  readonly relevanceScore: number;
  /** Optional mutual-exclusion family. At most one automatic candidate per family is admitted. */
  readonly conflictGroup?: string;
}

export type SkillAdmissionRejectionReason = 'duplicate' | 'conflict' | 'over-budget';

export interface SkillAdmissionRejection {
  readonly skillId: string;
  readonly bodyHash: string;
  readonly exactTokens: number;
  readonly reason: SkillAdmissionRejectionReason;
}

export interface BudgetedSkillAdmissionPlan {
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly budgetConflict: boolean;
  readonly selected: readonly BudgetedSkillAdmissionCandidate[];
  readonly rejected: readonly SkillAdmissionRejection[];
}

export interface SkillAdmissionSnapshot {
  readonly skillId: string;
  readonly name: string;
  readonly role: SkillRole;
  readonly version: string;
  readonly sourceHash: string;
  readonly bodyHash: string;
  readonly exactTokens: number;
  readonly selectionReason: SkillSelectionReason;
  readonly explicit: boolean;
}

export interface AdmittedSkill {
  readonly version: typeof SKILL_ADMISSION_VERSION;
  /** Exact in-memory body paired with the snapshot; never truncated, summarized, or rewritten. */
  readonly body: string;
  readonly snapshot: SkillAdmissionSnapshot;
}

const SNAPSHOT_KEYS = new Set<keyof SkillAdmissionSnapshot>([
  'skillId', 'name', 'role', 'version', 'sourceHash', 'bodyHash', 'exactTokens',
  'selectionReason', 'explicit',
]);

const STABLE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH_RE = /^sha256:[a-f0-9]{64}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const MAX_SKILLS = 64;
const MAX_BODY_CHARS = 1_048_576;

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
}

function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function stableToken(value: unknown, label: string): string {
  const normalized = string(value, label, 240).normalize('NFC');
  if (!STABLE_TOKEN_RE.test(normalized)) throw new TypeError(`${label} must be an opaque stable token`);
  return normalized;
}

function hash(value: unknown, label: string): string {
  const normalized = string(value, label, 71);
  if (!HASH_RE.test(normalized)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
  return normalized;
}

function version(value: unknown): string {
  const normalized = string(value, 'version', 80).normalize('NFC');
  if (!VERSION_RE.test(normalized)) throw new TypeError('version must be a stable version token');
  return normalized;
}

function role(value: unknown): SkillRole {
  if (value === undefined || value === 'tactical') return 'tactical';
  if (value === 'style') return 'style';
  throw new TypeError('role must be style or tactical');
}

function reason(value: unknown): SkillSelectionReason {
  if (value === 'explicit' || value === 'keyword' || value === 'semantic') return value;
  throw new TypeError('selectionReason must be explicit, keyword, or semantic');
}

export function computeSkillBodyHash(body: string): string {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_BODY_CHARS) {
    throw new TypeError('body must be a non-empty bounded string');
  }
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** Same estimator as the existing Skill runtime; it observes cost but never truncates. */
export function exactSkillTokens(body: string): number {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_BODY_CHARS) {
    throw new TypeError('body must be a non-empty bounded string');
  }
  const cjk = (body.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  return Math.ceil(cjk * 1.5 + (body.length - cjk) * 0.4);
}

function renderedCandidateTokens(candidate: SkillAdmissionCandidate): number {
  return exactSkillTokens(`[${candidate.name}|${candidate.selectionReason}]\n${candidate.body}`);
}

/**
 * Budget gate that runs before whole-skill snapshots are signed. Explicit Skills remain indivisible
 * and may report a conflict; automatic Skills are admitted/rejected as whole bodies.
 */
export function planBudgetedSkillAdmission(
  candidates: readonly BudgetedSkillAdmissionCandidate[],
  budgetTokens: number,
): BudgetedSkillAdmissionPlan {
  if (!Array.isArray(candidates) || candidates.length > MAX_SKILLS) {
    throw new TypeError(`candidates must be an array with at most ${MAX_SKILLS} items`);
  }
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) {
    throw new TypeError('budgetTokens must be a non-negative safe integer');
  }
  const prepared = candidates.map((candidate, index) => {
    const admitted = admitOne(candidate, index);
    if (!Number.isFinite(candidate.relevanceScore) || candidate.relevanceScore < 0 || candidate.relevanceScore > 1) {
      throw new TypeError(`candidates[${index}].relevanceScore must be in [0, 1]`);
    }
    const conflictGroup = candidate.conflictGroup?.trim();
    if (candidate.conflictGroup !== undefined && !conflictGroup) {
      throw new TypeError(`candidates[${index}].conflictGroup must be non-empty when present`);
    }
    return {
      index,
      candidate: Object.freeze({ ...candidate, conflictGroup: conflictGroup || undefined }),
      snapshot: admitted.snapshot,
      renderedTokens: renderedCandidateTokens(candidate),
      identity: `${admitted.snapshot.sourceHash}\0${admitted.snapshot.version}\0${admitted.snapshot.bodyHash}`,
    };
  });
  prepared.sort((a, b) => (
    Number(b.snapshot.explicit) - Number(a.snapshot.explicit)
    || Number(b.snapshot.selectionReason === 'keyword') - Number(a.snapshot.selectionReason === 'keyword')
    || b.candidate.relevanceScore - a.candidate.relevanceScore
    || (b.candidate.relevanceScore / b.renderedTokens) - (a.candidate.relevanceScore / a.renderedTokens)
    || a.index - b.index
  ));

  const selected: BudgetedSkillAdmissionCandidate[] = [];
  const rejected: SkillAdmissionRejection[] = [];
  const identities = new Set<string>();
  const conflictGroups = new Set<string>();
  let usedTokens = exactSkillTokens('<Skill 指令>\n\n</Skill 指令>');
  for (const item of prepared) {
    const reject = (reason: SkillAdmissionRejectionReason) => rejected.push(Object.freeze({
      skillId: item.snapshot.skillId,
      bodyHash: item.snapshot.bodyHash,
      exactTokens: item.snapshot.exactTokens,
      reason,
    }));
    if (identities.has(item.identity)) {
      reject('duplicate');
      continue;
    }
    const group = item.candidate.conflictGroup;
    if (group && conflictGroups.has(group)) {
      reject('conflict');
      continue;
    }
    if (!item.snapshot.explicit && usedTokens + item.renderedTokens > budgetTokens) {
      reject('over-budget');
      continue;
    }
    identities.add(item.identity);
    if (group) conflictGroups.add(group);
    selected.push(item.candidate);
    usedTokens += item.renderedTokens;
  }
  if (selected.length === 0) usedTokens = 0;
  return Object.freeze({
    budgetTokens,
    usedTokens,
    budgetConflict: usedTokens > budgetTokens,
    selected: Object.freeze(selected),
    rejected: Object.freeze(rejected),
  });
}

/** Re-validate an already signed snapshot at a later trust boundary without loading its body. */
export function normalizeSkillAdmissionSnapshot(input: SkillAdmissionSnapshot): SkillAdmissionSnapshot {
  assertPlainRecord(input, 'skillSnapshot');
  for (const key of Object.keys(input)) {
    if (!SNAPSHOT_KEYS.has(key as keyof SkillAdmissionSnapshot)) {
      throw new TypeError(`skillSnapshot contains unsupported field: ${key}`);
    }
  }
  if (typeof input.explicit !== 'boolean') throw new TypeError('skillSnapshot.explicit must be a boolean');
  const selectionReason = reason(input.selectionReason);
  if (input.explicit !== (selectionReason === 'explicit')) {
    throw new TypeError('skillSnapshot explicit and selectionReason must agree');
  }
  if (!Number.isSafeInteger(input.exactTokens) || input.exactTokens < 1) {
    throw new TypeError('skillSnapshot.exactTokens must be a positive safe integer');
  }
  return Object.freeze({
    skillId: stableToken(input.skillId, 'skillSnapshot.skillId'),
    name: string(input.name, 'skillSnapshot.name', 240).normalize('NFC'),
    role: role(input.role),
    version: version(input.version),
    sourceHash: hash(input.sourceHash, 'skillSnapshot.sourceHash'),
    bodyHash: hash(input.bodyHash, 'skillSnapshot.bodyHash'),
    exactTokens: input.exactTokens,
    selectionReason,
    explicit: input.explicit,
  });
}

function admitOne(input: SkillAdmissionCandidate, index: number): AdmittedSkill {
  assertPlainRecord(input, `candidates[${index}]`);
  if (typeof input.explicit !== 'boolean') throw new TypeError(`candidates[${index}].explicit must be a boolean`);
  const selectionReason = reason(input.selectionReason);
  if (input.explicit !== (selectionReason === 'explicit')) {
    throw new TypeError(`candidates[${index}] explicit and selectionReason must agree`);
  }
  const body = string(input.body, `candidates[${index}].body`, MAX_BODY_CHARS);
  const snapshot = Object.freeze({
    skillId: stableToken(input.skillId, `candidates[${index}].skillId`),
    name: string(input.name, `candidates[${index}].name`, 240).normalize('NFC'),
    role: role(input.role),
    version: version(input.version),
    sourceHash: hash(input.sourceHash, `candidates[${index}].sourceHash`),
    bodyHash: computeSkillBodyHash(body),
    exactTokens: exactSkillTokens(body),
    selectionReason,
    explicit: input.explicit,
  });
  return Object.freeze({ version: SKILL_ADMISSION_VERSION, body, snapshot });
}

/**
 * Freezes whole-skill bodies and metadata. Dedup identity is sourceHash + version + bodyHash;
 * when the same source is both automatic and explicit, the explicit selection wins in place.
 */
export function createWholeSkillAdmission(
  candidates: readonly SkillAdmissionCandidate[],
): readonly AdmittedSkill[] {
  if (!Array.isArray(candidates) || candidates.length > MAX_SKILLS) {
    throw new TypeError(`candidates must be an array with at most ${MAX_SKILLS} items`);
  }
  const output: AdmittedSkill[] = [];
  const indexByIdentity = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const admitted = admitOne(candidate, index);
    const snapshot = admitted.snapshot;
    const identity = `${snapshot.sourceHash}\0${snapshot.version}\0${snapshot.bodyHash}`;
    const existing = indexByIdentity.get(identity);
    if (existing === undefined) {
      indexByIdentity.set(identity, output.length);
      output.push(admitted);
    } else if (admitted.snapshot.explicit && !output[existing]!.snapshot.explicit) {
      output[existing] = admitted;
    }
  });
  return Object.freeze(output);
}
