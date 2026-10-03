import { createHash } from 'node:crypto';

export const WORLDBOOK_REPAIR_PROPOSAL_VERSION = 'worldbook-repair-proposal-v1' as const;
export const WORLDBOOK_REPAIR_LIMITS = Object.freeze({ changes: 16, contentChars: 16_000, keys: 32, keyChars: 240 });

export type WorldbookRepairReason = 'resolve-conflict' | 'clarify-scope' | 'disable-stale-entry';

export interface WorldbookRepairPatch {
  readonly content?: string;
  readonly enabled?: boolean;
  readonly name?: string;
  readonly key?: readonly string[];
}

export interface WorldbookRepairChange {
  readonly entryUid: string;
  readonly expectedEntryDigest: string;
  readonly reasonCode: WorldbookRepairReason;
  readonly patch: WorldbookRepairPatch;
}

export interface WorldbookRepairProposal {
  readonly version: typeof WORLDBOOK_REPAIR_PROPOSAL_VERSION;
  readonly sessionId: string;
  readonly file: string;
  readonly expectedRevision: string;
  readonly evidenceSetDigest: string;
  readonly changes: readonly WorldbookRepairChange[];
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u;
const FILE = /^[^\\/\u0000-\u001f\u007f]{1,200}\.json$/iu;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label}-invalid`);
  }
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label}-fields-invalid`);
  }
}

function opaque(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE.test(value)) throw new TypeError(`${label}-invalid`);
  return value.normalize('NFC');
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${label}-invalid`);
  return value;
}

function bounded(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label}-invalid`);
  }
  return value.normalize('NFC');
}

function normalizePatch(value: unknown, label: string): WorldbookRepairPatch {
  plain(value, label);
  exact(value, [], ['content', 'enabled', 'name', 'key'], label);
  if (Object.keys(value).length === 0) throw new TypeError(`${label}-empty`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError(`${label}.enabled-invalid`);
  if (value.key !== undefined && (!Array.isArray(value.key) || value.key.length > WORLDBOOK_REPAIR_LIMITS.keys
    || value.key.some((item) => typeof item !== 'string' || item.length === 0 || item.length > WORLDBOOK_REPAIR_LIMITS.keyChars))) {
    throw new TypeError(`${label}.key-invalid`);
  }
  return Object.freeze({
    ...(value.content === undefined ? {} : { content: bounded(value.content, WORLDBOOK_REPAIR_LIMITS.contentChars, `${label}.content`, true) }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.name === undefined ? {} : { name: bounded(value.name, 512, `${label}.name`, true) }),
    ...(value.key === undefined ? {} : { key: Object.freeze((value.key as string[]).map((item) => item.normalize('NFC'))) }),
  });
}

export function normalizeWorldbookRepairProposal(value: unknown): WorldbookRepairProposal {
  plain(value, 'worldbook-repair-proposal');
  exact(value, ['version', 'sessionId', 'file', 'expectedRevision', 'evidenceSetDigest', 'changes'], [], 'worldbook-repair-proposal');
  if (value.version !== WORLDBOOK_REPAIR_PROPOSAL_VERSION) throw new TypeError('worldbook-repair-version-invalid');
  if (typeof value.file !== 'string' || !FILE.test(value.file) || value.file !== value.file.trim()
    || value.file === '.' || value.file === '..' || value.file.startsWith('.')) throw new TypeError('worldbook-repair-file-invalid');
  const expectedRevision = digest(value.expectedRevision, 'worldbook-repair-expected-revision');
  const evidenceSetDigest = digest(value.evidenceSetDigest, 'worldbook-repair-evidence-digest');
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > WORLDBOOK_REPAIR_LIMITS.changes) {
    throw new TypeError('worldbook-repair-changes-invalid');
  }
  const seen = new Set<string>();
  const changes = value.changes.map((item, index) => {
    plain(item, `worldbook-repair-changes[${index}]`);
    exact(item, ['entryUid', 'expectedEntryDigest', 'reasonCode', 'patch'], [], `worldbook-repair-changes[${index}]`);
    const entryUid = opaque(item.entryUid, `worldbook-repair-changes[${index}].entryUid`);
    if (/^idx-[0-9]+$/u.test(entryUid)) throw new TypeError('worldbook-repair-entry-unstable');
    if (seen.has(entryUid)) throw new TypeError('worldbook-repair-entry-duplicate');
    seen.add(entryUid);
    if (!['resolve-conflict', 'clarify-scope', 'disable-stale-entry'].includes(String(item.reasonCode))) {
      throw new TypeError(`worldbook-repair-changes[${index}].reason-invalid`);
    }
    return Object.freeze({
      entryUid,
      expectedEntryDigest: digest(item.expectedEntryDigest, `worldbook-repair-changes[${index}].entry-digest`),
      reasonCode: item.reasonCode as WorldbookRepairReason,
      patch: normalizePatch(item.patch, `worldbook-repair-changes[${index}].patch`),
    });
  });
  return Object.freeze({
    version: WORLDBOOK_REPAIR_PROPOSAL_VERSION,
    sessionId: opaque(value.sessionId, 'worldbook-repair-session-id'),
    file: value.file.normalize('NFC'),
    expectedRevision,
    evidenceSetDigest,
    changes: Object.freeze(changes),
  });
}

export function worldbookRepairDigest(value: unknown): string {
  const proposal = normalizeWorldbookRepairProposal(value);
  return `sha256:${createHash('sha256').update(JSON.stringify(proposal), 'utf8').digest('hex')}`;
}
