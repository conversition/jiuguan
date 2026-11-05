import { createHash } from 'node:crypto';

export const NPC_MVU_PROJECTION_VERSION = 'npc-mvu-projection-v1' as const;
export const NPC_MVU_PROPOSAL_VERSION = 'npc-mvu-proposal-v1' as const;

export type NpcMvuScalar = string | number | boolean | null;
export type NpcMvuValueType = 'string' | 'number' | 'boolean' | 'null';
export type NpcMvuBindingSource = 'card-manifest' | 'name-anchored';
export type NpcMvuWritePolicy = 'read-only' | 'agent-proposal';

export interface NpcMvuCharacterIdentity {
  readonly characterId: string;
  readonly entityVersion: number;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface NpcMvuBindingConstraint {
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly NpcMvuScalar[];
}

export interface NpcMvuBinding {
  readonly bindingId: string;
  readonly characterId: string;
  readonly entityVersion: number;
  readonly path: string;
  readonly field: string;
  readonly valueType: NpcMvuValueType;
  readonly source: NpcMvuBindingSource;
  readonly writePolicy: NpcMvuWritePolicy;
  readonly visibility: 'public' | 'private';
  readonly constraint?: NpcMvuBindingConstraint;
}

export interface NpcMvuProjectionValue {
  readonly bindingId: string;
  readonly characterId: string;
  readonly entityVersion: number;
  readonly path: string;
  readonly field: string;
  readonly value: NpcMvuScalar;
  readonly valueDigest: string;
  readonly source: NpcMvuBindingSource;
  readonly writePolicy: NpcMvuWritePolicy;
  readonly visibility: 'public' | 'private';
}

export interface NpcMvuProjection {
  readonly version: typeof NPC_MVU_PROJECTION_VERSION;
  readonly stateVersion: number;
  readonly values: readonly NpcMvuProjectionValue[];
  readonly projectionDigest: string;
}

export interface NpcMvuProposalOperation {
  readonly kind: 'mvu_set';
  readonly bindingId: string;
  readonly characterId: string;
  readonly expectedValueDigest: string;
  readonly value: NpcMvuScalar;
  readonly sourceRefs: readonly string[];
}

export interface NpcMvuProposal {
  readonly version: typeof NPC_MVU_PROPOSAL_VERSION;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly expectedStateVersion: number;
  readonly operations: readonly NpcMvuProposalOperation[];
  readonly proposalDigest: string;
}

export interface NpcMvuProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly expectedStateVersion: number;
  readonly allowedSourceRefs: readonly string[];
  readonly bindings: readonly NpcMvuBinding[];
  readonly currentValueDigests: Readonly<Record<string, string>>;
  readonly maxWrites: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PATH_SEGMENT = /^[^\u0000-\u001f\u007f.\[\]\\/]{1,80}$/u;
const MAX_DISCOVERED_BINDINGS = 96;
const FORBIDDEN_PATH = /(?:api[_. -]?key|access[_. -]?token|password|passwd|credential|authorization|cookie|私钥|密钥|口令|密码|令牌)/iu;
const PRIVATE_FIELD = /(?:secret|hidden|private|秘密|隐私|隐藏|内心独白|幕后)/iu;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('und').replace(/\s+/gu, ' ');
}

function splitPath(path: string): string[] {
  return path.split(/[.\[\]\\/]+/u).map((part) => part.trim()).filter(Boolean);
}

function scalarType(value: NpcMvuScalar): NpcMvuValueType {
  return value === null ? 'null' : typeof value as NpcMvuValueType;
}

function flattenScalars(
  value: unknown,
  prefix: readonly string[] = [],
  output: Array<{ path: string; segments: readonly string[]; value: NpcMvuScalar }> = [],
  depth = 0,
): Array<{ path: string; segments: readonly string[]; value: NpcMvuScalar }> {
  if (output.length >= 512 || depth > 8) return output;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix.length > 0 && (typeof value !== 'number' || Number.isFinite(value))
      && (typeof value !== 'string' || value.length <= 1_000)) {
      const path = prefix.join('.');
      if (path.length <= 480 && !FORBIDDEN_PATH.test(path)) output.push({ path, segments: prefix, value });
    }
    return output;
  }
  if (typeof value !== 'object') return output;
  const entries = Array.isArray(value)
    ? value.slice(0, 64).map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>).slice(0, 128);
  for (const [key, item] of entries) {
    if (!PATH_SEGMENT.test(key)) continue;
    flattenScalars(item, [...prefix, key], output, depth + 1);
    if (output.length >= 512) break;
  }
  return output;
}

function normalizeIdentity(input: NpcMvuCharacterIdentity): NpcMvuCharacterIdentity {
  if (!TOKEN.test(input.characterId) || !Number.isSafeInteger(input.entityVersion) || input.entityVersion < 0
    || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 160
    || !Array.isArray(input.aliases) || input.aliases.length > 32
    || input.aliases.some((alias) => typeof alias !== 'string' || alias.length < 1 || alias.length > 160)) {
    throw new TypeError('npc mvu character identity is invalid');
  }
  return Object.freeze({
    characterId: input.characterId,
    entityVersion: input.entityVersion,
    name: input.name.normalize('NFKC').trim(),
    aliases: Object.freeze([...new Set(input.aliases.map((alias) => alias.normalize('NFKC').trim()).filter(Boolean))]),
  });
}

function normalizeBinding(input: NpcMvuBinding): NpcMvuBinding {
  if (!DIGEST.test(input.bindingId) || !TOKEN.test(input.characterId)
    || !Number.isSafeInteger(input.entityVersion) || input.entityVersion < 0
    || typeof input.path !== 'string' || input.path.length < 1 || input.path.length > 480
    || FORBIDDEN_PATH.test(input.path)
    || typeof input.field !== 'string' || input.field.length < 1 || input.field.length > 160
    || !['string', 'number', 'boolean', 'null'].includes(input.valueType)
    || !['card-manifest', 'name-anchored'].includes(input.source)
    || !['read-only', 'agent-proposal'].includes(input.writePolicy)
    || !['public', 'private'].includes(input.visibility)) {
    throw new TypeError('npc mvu binding is invalid');
  }
  if (input.source === 'name-anchored' && input.writePolicy !== 'read-only') {
    throw new TypeError('inferred npc mvu bindings must remain read-only');
  }
  const constraint = input.constraint;
  if (constraint) {
    if ((constraint.min !== undefined && (!Number.isFinite(constraint.min) || input.valueType !== 'number'))
      || (constraint.max !== undefined && (!Number.isFinite(constraint.max) || input.valueType !== 'number'))
      || (constraint.min !== undefined && constraint.max !== undefined && constraint.min > constraint.max)
      || (constraint.enum !== undefined && (!Array.isArray(constraint.enum) || constraint.enum.length < 1
        || constraint.enum.length > 64 || constraint.enum.some((item) => scalarType(item) !== input.valueType)))) {
      throw new TypeError('npc mvu binding constraint is invalid');
    }
  }
  return Object.freeze({ ...input, ...(constraint ? { constraint: Object.freeze({ ...constraint }) } : {}) });
}

/**
 * Conservative compatibility discovery for existing cards.
 *
 * A leaf is associated only when one complete MVU path segment exactly equals one
 * stable character id, name or alias. Inferred bindings are permanently read-only;
 * production writes require an explicit card-manifest binding.
 */
export function discoverNameAnchoredNpcMvuBindings(input: {
  readonly characters: readonly NpcMvuCharacterIdentity[];
  readonly state: Readonly<Record<string, unknown>>;
}): readonly NpcMvuBinding[] {
  const characters = input.characters.map(normalizeIdentity);
  const leaves = flattenScalars(input.state);
  const bindings: NpcMvuBinding[] = [];
  const seenPaths = new Set<string>();
  for (const leaf of leaves) {
    const normalizedSegments = leaf.segments.map(normalizedIdentity);
    const matches = characters.flatMap((character) => {
      const terms = [character.characterId, character.name, ...character.aliases]
        .map(normalizedIdentity).filter((term) => [...term].length >= 2);
      const indexes = normalizedSegments.flatMap((segment, index) => terms.includes(segment) ? [index] : []);
      return indexes.length > 0 ? [{ character, index: Math.max(...indexes) }] : [];
    });
    if (matches.length !== 1 || seenPaths.has(leaf.path)) continue;
    const match = matches[0]!;
    const fieldSegments = leaf.segments.slice(match.index + 1);
    if (fieldSegments.length < 1 || fieldSegments.length > 5) continue;
    const field = fieldSegments.join('.').slice(0, 160);
    const bindingBase = {
      characterId: match.character.characterId,
      entityVersion: match.character.entityVersion,
      path: leaf.path,
      field,
      valueType: scalarType(leaf.value),
      source: 'name-anchored' as const,
      writePolicy: 'read-only' as const,
      visibility: PRIVATE_FIELD.test(field) ? 'private' as const : 'public' as const,
    };
    bindings.push(Object.freeze({
      bindingId: digest({ version: NPC_MVU_PROJECTION_VERSION, ...bindingBase }),
      ...bindingBase,
    }));
    seenPaths.add(leaf.path);
    if (bindings.length >= MAX_DISCOVERED_BINDINGS) break;
  }
  return Object.freeze(bindings.sort((left, right) => left.characterId.localeCompare(right.characterId)
    || left.path.localeCompare(right.path)));
}

function readScalarAtPath(state: Readonly<Record<string, unknown>>, path: string): NpcMvuScalar | undefined {
  let cursor: unknown = state;
  for (const segment of splitPath(path)) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === null || typeof cursor === 'string' || typeof cursor === 'boolean') return cursor;
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return cursor;
  return undefined;
}

export function buildNpcMvuProjection(input: {
  readonly characters: readonly NpcMvuCharacterIdentity[];
  readonly state: Readonly<Record<string, unknown>>;
  readonly stateVersion: number;
  readonly manifestBindings?: readonly NpcMvuBinding[];
}): NpcMvuProjection {
  if (!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 0) {
    throw new TypeError('npc mvu stateVersion is invalid');
  }
  const identities = new Map(input.characters.map(normalizeIdentity).map((identity) => [identity.characterId, identity]));
  const inferred = discoverNameAnchoredNpcMvuBindings({ characters: [...identities.values()], state: input.state });
  const manifest = (input.manifestBindings ?? []).map(normalizeBinding);
  const byPath = new Map<string, NpcMvuBinding>();
  for (const binding of inferred) byPath.set(binding.path, binding);
  // Explicit manifest bindings replace read-only compatibility discoveries for the same path.
  for (const binding of manifest) {
    const identity = identities.get(binding.characterId);
    if (!identity || identity.entityVersion !== binding.entityVersion) {
      throw new TypeError('npc mvu manifest binding has a stale character identity');
    }
    byPath.set(binding.path, binding);
  }
  const values: NpcMvuProjectionValue[] = [];
  for (const binding of [...byPath.values()].sort((left, right) => left.characterId.localeCompare(right.characterId)
    || left.path.localeCompare(right.path))) {
    const value = readScalarAtPath(input.state, binding.path);
    if (value === undefined || scalarType(value) !== binding.valueType) continue;
    values.push(Object.freeze({
      bindingId: binding.bindingId,
      characterId: binding.characterId,
      entityVersion: binding.entityVersion,
      path: binding.path,
      field: binding.field,
      value,
      valueDigest: digest(value),
      source: binding.source,
      writePolicy: binding.writePolicy,
      visibility: binding.visibility,
    }));
  }
  const payload = { version: NPC_MVU_PROJECTION_VERSION, stateVersion: input.stateVersion, values };
  return Object.freeze({ ...payload, values: Object.freeze(values), projectionDigest: digest(payload) });
}

function validateProposalValue(value: NpcMvuScalar, binding: NpcMvuBinding): void {
  if (scalarType(value) !== binding.valueType) throw new TypeError('npc mvu proposal value type mismatch');
  const constraint = binding.constraint;
  if (!constraint) return;
  if (typeof value === 'number' && ((constraint.min !== undefined && value < constraint.min)
    || (constraint.max !== undefined && value > constraint.max))) {
    throw new TypeError('npc mvu proposal value exceeds numeric constraint');
  }
  if (constraint.enum && !constraint.enum.some((candidate) => canonical(candidate) === canonical(value))) {
    throw new TypeError('npc mvu proposal value is outside enum constraint');
  }
}

/**
 * Normalizes a future NPC→MVU write proposal at the admission boundary.
 * It performs no write. Only explicit card-manifest bindings marked
 * `agent-proposal` can pass; inferred name matches can never become writes.
 */
export function normalizeNpcMvuProposal(value: unknown, context: NpcMvuProposalContext): NpcMvuProposal {
  if (!TOKEN.test(context.sessionId) || !DIGEST.test(context.sourceRevision)
    || !Number.isSafeInteger(context.expectedStateVersion) || context.expectedStateVersion < 0
    || !Number.isSafeInteger(context.maxWrites) || context.maxWrites < 1 || context.maxWrites > 8
    || !Array.isArray(context.allowedSourceRefs) || context.allowedSourceRefs.length < 1
    || context.allowedSourceRefs.length > 128
    || new Set(context.allowedSourceRefs).size !== context.allowedSourceRefs.length
    || context.allowedSourceRefs.some((ref) => !TOKEN.test(ref))
    || !Array.isArray(context.bindings) || context.bindings.length < 1 || context.bindings.length > 128) {
    throw new TypeError('npc mvu proposal context is invalid');
  }
  const sourceRefs = new Set(context.allowedSourceRefs);
  const bindings = new Map(context.bindings.map(normalizeBinding).map((binding) => [binding.bindingId, binding]));
  if (bindings.size !== context.bindings.length) throw new TypeError('npc mvu proposal context has duplicate bindings');
  const proposal = plain(value, 'npc mvu proposal');
  exact(proposal, ['version', 'sessionId', 'sourceRevision', 'expectedStateVersion', 'operations'], 'npc mvu proposal');
  if (proposal.version !== NPC_MVU_PROPOSAL_VERSION || proposal.sessionId !== context.sessionId
    || proposal.sourceRevision !== context.sourceRevision || proposal.expectedStateVersion !== context.expectedStateVersion
    || !Array.isArray(proposal.operations) || proposal.operations.length < 1
    || proposal.operations.length > context.maxWrites) {
    throw new TypeError('npc mvu proposal binding is invalid');
  }
  const usedBindings = new Set<string>();
  const operations = proposal.operations.map((raw, index): NpcMvuProposalOperation => {
    const operation = plain(raw, `npc mvu operation ${index}`);
    exact(operation, ['kind', 'bindingId', 'characterId', 'expectedValueDigest', 'value', 'sourceRefs'], `npc mvu operation ${index}`);
    if (operation.kind !== 'mvu_set' || typeof operation.bindingId !== 'string'
      || usedBindings.has(operation.bindingId)) throw new TypeError('npc mvu proposal operation is invalid');
    const binding = bindings.get(operation.bindingId);
    if (!binding || binding.source !== 'card-manifest' || binding.writePolicy !== 'agent-proposal'
      || operation.characterId !== binding.characterId
      || typeof operation.expectedValueDigest !== 'string' || !DIGEST.test(operation.expectedValueDigest)
      || context.currentValueDigests[operation.bindingId] !== operation.expectedValueDigest
      || !Array.isArray(operation.sourceRefs) || operation.sourceRefs.length < 1 || operation.sourceRefs.length > 16
      || new Set(operation.sourceRefs).size !== operation.sourceRefs.length
      || operation.sourceRefs.some((ref) => typeof ref !== 'string' || !sourceRefs.has(ref))) {
      throw new TypeError('npc mvu proposal operation is not admitted');
    }
    validateProposalValue(operation.value as NpcMvuScalar, binding);
    usedBindings.add(operation.bindingId);
    return Object.freeze({
      kind: 'mvu_set',
      bindingId: operation.bindingId,
      characterId: binding.characterId,
      expectedValueDigest: operation.expectedValueDigest,
      value: operation.value as NpcMvuScalar,
      sourceRefs: Object.freeze([...new Set(operation.sourceRefs as string[])].sort()),
    });
  });
  const payload = {
    version: NPC_MVU_PROPOSAL_VERSION,
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    expectedStateVersion: context.expectedStateVersion,
    operations,
  };
  return Object.freeze({ ...payload, operations: Object.freeze(operations), proposalDigest: digest(payload) });
}

export function renderNpcMvuProjectionBlock(
  projection: NpcMvuProjection,
  characters: readonly NpcMvuCharacterIdentity[],
  maxValues = 24,
): string {
  const names = new Map(characters.map((character) => [character.characterId, character.name]));
  const visible = projection.values.filter((value) => value.visibility === 'public').slice(0, maxValues);
  if (visible.length === 0) return '';
  return [
    `<NPC-MVU投影 version="${projection.version}" stateVersion="${projection.stateVersion}" digest="${projection.projectionDigest}">`,
    '以下是人物索引与本轮权威 MVU 状态的只读关联；它不是新设定，不得据此泄露未公开信息或绕过变量写入协议。',
    ...visible.map((value) => `- ${names.get(value.characterId) ?? value.characterId} [${value.characterId}@v${value.entityVersion}] ${value.field}=${JSON.stringify(value.value)} (${value.source}/${value.writePolicy})`),
    '</NPC-MVU投影>',
  ].join('\n');
}
