/** Exact Provider-visible Critic inputs and metadata-only provenance; never execution authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { parseStoryIndexSeed } from '../../prompt/public/turn.ts';

export const CRITIC_INPUT_VERSION = 'critic-input-v1' as const;
export type CriticJsonValue = null | string | number | boolean | readonly CriticJsonValue[]
  | { readonly [key: string]: CriticJsonValue };
export interface CriticInputV1 {
  readonly version: typeof CRITIC_INPUT_VERSION;
  readonly issueCodes: readonly string[];
  readonly draft: Readonly<{
    plan: Readonly<Record<string, CriticJsonValue>>;
    memory_delta: Readonly<Record<string, CriticJsonValue>>;
    story_index_seed?: CriticJsonValue;
    prose: string;
  }>;
  readonly fullSkills: readonly { readonly snapshot?: CriticJsonValue; readonly body: string }[];
  readonly maxOutputTokens: number;
}
export interface CriticInputManifestV1 {
  readonly inputVersion: typeof CRITIC_INPUT_VERSION;
  readonly inputDigest: string;
  readonly payloadDigest: string;
  readonly issueCodes: readonly string[];
  readonly draftDigest: string;
  readonly draftLength: number;
  readonly skills: readonly {
    readonly snapshotDigest: string | null; readonly snapshotLength: number;
    readonly bodyDigest: string; readonly bodyLength: number;
  }[];
  readonly maxOutputTokens: number;
}
export type CriticPayloadManifestV1 = Pick<CriticInputManifestV1,
  'payloadDigest' | 'issueCodes' | 'draftDigest' | 'draftLength' | 'skills'>;

const OMIT = Symbol('json-omitted');
const HASH = /^sha256:[a-f0-9]{64}$/u;
function invalid(manifest = false): never {
  throw new Error(manifest ? 'critic-input-manifest-invalid' : 'critic-input-invalid');
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = [],
  manifest = false, allowExtra = false): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(manifest);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowExtra && !required.includes(key) && !optional.includes(key)) invalid(manifest);
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(manifest);
  }
  if (required.some(key => !Object.hasOwn(descriptors, key))) invalid(manifest);
  return descriptors;
}
function list(value: unknown, max: number, min = 0, manifest = false): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid(manifest);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(manifest);
    return descriptor.value;
  });
}
/** Match JSON's optional undefined omission without evaluating toJSON, accessors or Proxy traps. */
function json(value: unknown, ancestors = new Set<object>()): CriticJsonValue | typeof OMIT {
  if (value === undefined) return OMIT;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
  if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(list(value, Number.MAX_SAFE_INTEGER).map(item => {
      const cloned = json(item, ancestors); return cloned === OMIT ? null : cloned;
    }));
    const descriptors = fields(value, [], [], false, true);
    const entries: [string, CriticJsonValue][] = [];
    for (const key of Object.keys(descriptors)) {
      const cloned = json(descriptors[key]!.value, ancestors);
      if (cloned !== OMIT) entries.push([key, cloned]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally { ancestors.delete(value); }
}
function objectJson(value: unknown): Readonly<Record<string, CriticJsonValue>> {
  fields(value, [], [], false, true);
  return json(value) as Readonly<Record<string, CriticJsonValue>>;
}
function issues(value: unknown, manifest = false): readonly string[] {
  return Object.freeze(list(value, 64, 1, manifest).map(item => {
    if (typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,239}$/u.test(item)) invalid(manifest);
    return item;
  }));
}
function budget(value: unknown, manifest = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < 256 || Number(value) > 100_000) invalid(manifest);
  return Number(value);
}
function draft(value: unknown, alreadySanitized: boolean): CriticInputV1['draft'] {
  const descriptors = fields(value, ['plan', 'memory_delta', 'prose'], ['story_index_seed'], false, !alreadySanitized);
  const prose: unknown = descriptors.prose!.value;
  if (typeof prose !== 'string') invalid();
  const seedValue = descriptors.story_index_seed?.value;
  const seed = seedValue === undefined ? null : parseStoryIndexSeed(json(seedValue));
  if (alreadySanitized && seedValue !== undefined && !seed) invalid();
  return Object.freeze({ plan: objectJson(descriptors.plan!.value),
    memory_delta: objectJson(descriptors.memory_delta!.value),
    ...(seed ? { story_index_seed: json(seed) as CriticJsonValue } : {}), prose });
}
function skills(value: unknown, alreadySanitized = false): CriticInputV1['fullSkills'] {
  return Object.freeze(list(value, 64).map(item => {
    const descriptors = fields(item, ['body'], ['snapshot'], false, !alreadySanitized);
    const body: unknown = descriptors.body!.value;
    if (typeof body !== 'string' || body.length > 1_000_000) invalid();
    const snapshot = json(descriptors.snapshot?.value);
    return Object.freeze({ ...(snapshot === OMIT ? {} : { snapshot }), body });
  }));
}
function payload(raw: unknown): Pick<CriticInputV1, 'issueCodes' | 'draft' | 'fullSkills'> {
  const input = fields(raw, ['decision', 'draft', 'fullSkills']);
  const decision = fields(input.decision!.value, ['severity', 'hardDenyCodes', 'repairableCodes'], [], false, true);
  if (decision.severity!.value !== 'repairable' || list(decision.hardDenyCodes!.value, 64).length !== 0) {
    throw new Error('critic-model-request-not-repairable');
  }
  if (list(decision.repairableCodes!.value, 64).length === 0) throw new Error('critic-model-request-not-repairable');
  const issueCodes = issues(decision.repairableCodes!.value);
  return Object.freeze({ issueCodes, draft: draft(input.draft!.value, false), fullSkills: skills(input.fullSkills!.value) });
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
/** Capture only the payload actually rendered by the existing Critic request builder. */
export function createCriticInput(raw: unknown): CriticInputV1 {
  const input = fields(raw, ['decision', 'draft', 'fullSkills', 'maxOutputTokens']);
  return Object.freeze({ version: CRITIC_INPUT_VERSION,
    ...payload({ decision: input.decision!.value, draft: input.draft!.value, fullSkills: input.fullSkills!.value }),
    maxOutputTokens: budget(input.maxOutputTokens!.value) });
}
/** The Session can attest actual payload bytes without inventing the server-owned output budget. */
export function criticPayloadDigest(raw: unknown): string { return digest(payload(raw)); }
/** Independently attest every Provider-visible semantic field without a server-owned budget. */
export function criticPayloadManifest(raw: unknown): CriticPayloadManifestV1 { return metadata(payload(raw)); }
export function parseCriticInput(raw: unknown): CriticInputV1 {
  const input = fields(raw, ['version', 'issueCodes', 'draft', 'fullSkills', 'maxOutputTokens']);
  if (input.version!.value !== CRITIC_INPUT_VERSION) invalid();
  return Object.freeze({ version: CRITIC_INPUT_VERSION, issueCodes: issues(input.issueCodes!.value),
    draft: draft(input.draft!.value, true), fullSkills: skills(input.fullSkills!.value, true),
    maxOutputTokens: budget(input.maxOutputTokens!.value) });
}
export function criticInputManifest(value: CriticInputV1): CriticInputManifestV1 {
  const input = parseCriticInput(value);
  const core = { inputVersion: CRITIC_INPUT_VERSION, ...metadata(input), maxOutputTokens: input.maxOutputTokens };
  return Object.freeze({ ...core, inputDigest: digest(core) });
}
function metadata(input: Pick<CriticInputV1, 'issueCodes' | 'draft' | 'fullSkills'>): CriticPayloadManifestV1 {
  const serializedDraft = JSON.stringify(input.draft);
  return Object.freeze({
    payloadDigest: digest({ issueCodes: input.issueCodes, draft: input.draft, fullSkills: input.fullSkills }),
    issueCodes: input.issueCodes, draftDigest: digest(input.draft), draftLength: serializedDraft.length,
    skills: Object.freeze(input.fullSkills.map(skill => Object.freeze({
      snapshotDigest: Object.hasOwn(skill, 'snapshot') ? digest(skill.snapshot) : null,
      snapshotLength: Object.hasOwn(skill, 'snapshot') ? JSON.stringify(skill.snapshot).length : 0,
      bodyDigest: digest(skill.body), bodyLength: skill.body.length,
    }))),
  });
}
export function parseCriticInputManifest(value: unknown): CriticInputManifestV1 {
  const input = fields(value, ['inputVersion', 'inputDigest', 'payloadDigest', 'issueCodes', 'draftDigest',
    'draftLength', 'skills', 'maxOutputTokens'], [], true);
  const hash = (value: unknown): string => {
    if (typeof value !== 'string' || !HASH.test(value)) invalid(true); return value;
  };
  const count = (value: unknown, minimum: number): number => {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(true); return Number(value);
  };
  if (input.inputVersion!.value !== CRITIC_INPUT_VERSION) invalid(true);
  const parsedSkills = list(input.skills!.value, 64, 0, true).map(item => {
    const skill = fields(item, ['snapshotDigest', 'snapshotLength', 'bodyDigest', 'bodyLength'], [], true);
    const snapshotDigest = skill.snapshotDigest!.value === null ? null : hash(skill.snapshotDigest!.value);
    const snapshotLength = count(skill.snapshotLength!.value, snapshotDigest === null ? 0 : 1);
    if (snapshotDigest === null && snapshotLength !== 0) invalid(true);
    const bodyLength = count(skill.bodyLength!.value, 0);
    if (bodyLength > 1_000_000) invalid(true);
    return Object.freeze({ snapshotDigest, snapshotLength, bodyDigest: hash(skill.bodyDigest!.value), bodyLength });
  });
  const core = { inputVersion: CRITIC_INPUT_VERSION, payloadDigest: hash(input.payloadDigest!.value),
    issueCodes: issues(input.issueCodes!.value, true), draftDigest: hash(input.draftDigest!.value),
    draftLength: count(input.draftLength!.value, 1), skills: Object.freeze(parsedSkills),
    maxOutputTokens: budget(input.maxOutputTokens!.value, true) };
  const inputDigest = digest(core);
  if (hash(input.inputDigest!.value) !== inputDigest) invalid(true);
  return Object.freeze({ ...core, inputDigest });
}
