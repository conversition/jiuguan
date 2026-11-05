import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  normalizeAgentSkillProgram,
  parseAgentSkillProgramBody,
  LegacyAgentSkillBodyError,
  AGENT_SKILL_PROGRAM_LIMITS,
  prepareAgentSkillConsumptionSet,
  type AgentSkillAdmissionV1,
  type AgentSkillKind,
  type AgentSkillProfileAuthorizationV1,
  type AgentSkillProgramArgumentV1,
  type AgentSkillProgramOperationV1,
  type AgentSkillProgramV1,
  type AgentSkillSourceProofV1,
} from '@jiuguan/skill-hub';
import { estimateTokens } from './assembly.ts';
import { MIGRATED_PROCEDURE_STEP_TEXT } from './migrated-procedure-steps.ts';
import { MIGRATED_STYLE_PROFILE_TEXT } from './migrated-style-profiles.ts';

export const AGENT_SKILL_COMPILER_VERSION = 'agent-skill-compiler-v1' as const;
export const AGENT_SKILL_COMPILER_REVISION = 'agent-skill-compiler-v1.4.0' as const;

type PrimitiveTarget = 'prompt' | 'local-validator';
type PrimitiveArgumentType = 'token' | 'integer' | 'boolean';

interface PrimitiveArgumentSpec {
  readonly type: PrimitiveArgumentType;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly allowedValues?: readonly string[];
}

interface PrimitiveDefinition {
  readonly primitiveId: string;
  readonly kind: AgentSkillKind;
  readonly target: PrimitiveTarget;
  readonly args: Readonly<Record<string, PrimitiveArgumentSpec>>;
  readonly maxPerProgram: number;
  /** Omission means the primitive is a singleton across the compiled set. */
  readonly semanticArg?: string;
}

const PRIMITIVE_DEFINITIONS = Object.freeze([
  {
    primitiveId: 'foundation.output-contract',
    kind: 'foundation',
    target: 'prompt',
    args: { contractId: { type: 'token', allowedValues: ['game.turn.v1'] } },
    maxPerProgram: 1,
  },
  {
    primitiveId: 'foundation.context-priority',
    kind: 'foundation',
    target: 'prompt',
    args: { profileId: { type: 'token', allowedValues: ['memory-first.v1'] } },
    maxPerProgram: 1,
  },
  {
    primitiveId: 'policy.enforce-boundary',
    kind: 'policy',
    target: 'prompt',
    args: { boundaryId: { type: 'token', allowedValues: ['memory.write', 'world.write'] } },
    maxPerProgram: 8,
    semanticArg: 'boundaryId',
  },
  {
    primitiveId: 'policy.require-capability',
    kind: 'policy',
    target: 'prompt',
    args: { capabilityId: { type: 'token', allowedValues: ['context.read', 'memory.propose'] } },
    maxPerProgram: 8,
    semanticArg: 'capabilityId',
  },
  {
    primitiveId: 'procedure.apply-step',
    kind: 'procedure',
    target: 'prompt',
    args: {
      optional: { type: 'boolean' },
      order: { type: 'integer', minimum: 0, maximum: 1_000 },
      stepId: { type: 'token', allowedValues: ['continuity.scan', 'story.advance', 'state.reconcile', ...Object.keys(MIGRATED_PROCEDURE_STEP_TEXT)] },
    },
    maxPerProgram: 16,
    semanticArg: 'stepId',
  },
  {
    primitiveId: 'style.apply-axis',
    kind: 'style',
    target: 'prompt',
    args: {
      axisId: { type: 'token', allowedValues: ['dialogue.density', 'sensory.detail', 'sentence.tempo'] },
      level: { type: 'integer', minimum: -100, maximum: 100 },
    },
    maxPerProgram: 16,
    semanticArg: 'axisId',
  },
  {
    primitiveId: 'style.toggle-constraint',
    kind: 'style',
    target: 'prompt',
    args: {
      constraintId: { type: 'token', allowedValues: ['avoid.cliche', 'preserve.voice'] },
      enabled: { type: 'boolean' },
    },
    maxPerProgram: 16,
    semanticArg: 'constraintId',
  },
  {
    primitiveId: 'style.apply-profile',
    kind: 'style',
    target: 'prompt',
    args: { profileId: { type: 'token', allowedValues: Object.keys(MIGRATED_STYLE_PROFILE_TEXT) } },
    maxPerProgram: 1,
    semanticArg: 'profileId',
  },
  {
    primitiveId: 'validator.run-check',
    kind: 'validator',
    target: 'local-validator',
    args: {
      checkId: { type: 'token', allowedValues: ['turn.schema', 'memory.shape', 'world.consistency'] },
      severityId: { type: 'token', allowedValues: ['error', 'warn'] },
    },
    maxPerProgram: 16,
    semanticArg: 'checkId',
  },
] as const satisfies readonly PrimitiveDefinition[]);

const DEFINITION_BY_ID = new Map<string, PrimitiveDefinition>(
  PRIMITIVE_DEFINITIONS.map((definition) => [definition.primitiveId, definition]),
);
const REQUEST_KEYS = new Set([
  'admission', 'sourceProofs', 'profileAuthorization', 'maxInstructionTokens',
  'maxValidatorOperations',
]);

export interface AgentSkillCompilationRequestV1 {
  readonly admission: AgentSkillAdmissionV1;
  readonly sourceProofs: readonly AgentSkillSourceProofV1[];
  /** Must be issued and verified by the server ProfileAdmissionService. */
  readonly profileAuthorization: AgentSkillProfileAuthorizationV1;
  /** Budget for the exact final fixed-template wrapper. Partial compilation is forbidden. */
  readonly maxInstructionTokens: number;
  /** Host/Profile ceiling for local validator work; zero rejects any validator operation. */
  readonly maxValidatorOperations: number;
}

export interface AgentSkillCompiledProgramTraceV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly programDigest: string;
  readonly sourceProofDigest: string;
  readonly kind: AgentSkillKind;
  readonly promptOperationCount: number;
  readonly validatorOperationCount: number;
}

export type AgentSkillPromptSlotKindV1 = Exclude<AgentSkillKind, 'validator'>;

export interface AgentSkillPromptSlotV1 {
  readonly slot: AgentSkillPromptSlotKindV1;
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly instruction: string;
  readonly instructionDigest: string;
  readonly tokens: number;
}

export interface AgentSkillValidatorPlanEntryV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly evaluatorId: string;
  readonly checkId: string;
  readonly severityId: string;
  readonly entryDigest: string;
}

export interface CompiledAgentSkillArtifactV1 {
  readonly compilerVersion: typeof AGENT_SKILL_COMPILER_VERSION;
  readonly compilerRevision: typeof AGENT_SKILL_COMPILER_REVISION;
  readonly primitiveRegistryDigest: string;
  readonly profileId: string;
  readonly profileAuthorizationDigest: string;
  readonly profilePolicyRevision: string;
  readonly profileRegistryRevision: string;
  readonly authorityRevision: string;
  readonly admissionDigest: string;
  readonly instructionSetDigest: string;
  readonly consumptionDigest: string;
  /** The only Skill-derived text eligible for a future system slot. Empty for validator-only sets. */
  readonly promptInstruction: string;
  readonly promptInstructionDigest: string;
  readonly promptTokens: number;
  readonly maxInstructionTokens: number;
  readonly promptSlots: readonly AgentSkillPromptSlotV1[];
  /** Validators are local deterministic work; they are never rendered into model instructions. */
  readonly validatorPlan: readonly AgentSkillValidatorPlanEntryV1[];
  readonly validatorPlanDigest: string;
  readonly maxValidatorOperations: number;
  readonly programs: readonly AgentSkillCompiledProgramTraceV1[];
  readonly compiledInstructionSetDigest: string;
  readonly compiledArtifactDigest: string;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  assertPlainRecord(value, 'canonical JSON value');
  return `{${Object.keys(value).sort().map((key) => {
    const child = value[key];
    if (child === undefined) throw new TypeError('canonical JSON does not support undefined');
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  }).join(',')}}`;
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object') {
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    if (!Object.isFrozen(object)) Object.freeze(object);
  }
  return value;
}

const MAX_ARTIFACT_SNAPSHOT_DEPTH = 64;
const MAX_ARTIFACT_SNAPSHOT_NODES = 20_000;
const MAX_ARTIFACT_CONTAINER_KEYS = 10_000;
const MAX_ARTIFACT_STRING_CHARS = 8_000_000;

interface ArtifactSnapshotState {
  readonly ancestors: Set<object>;
  readonly maxStringChars: number;
  nodes: number;
  stringChars: number;
}

function accountArtifactString(
  state: ArtifactSnapshotState,
  value: string,
  label: string,
): void {
  if (value.length > state.maxStringChars
    || state.stringChars > state.maxStringChars - value.length) {
    throw new TypeError(`${label} exceeds the compiled artifact string budget`);
  }
  state.stringChars += value.length;
}

function canonicalArtifactSnapshot(
  value: unknown,
  label: string,
  state: ArtifactSnapshotState = {
    ancestors: new Set<object>(),
    maxStringChars: MAX_ARTIFACT_STRING_CHARS,
    nodes: 0,
    stringChars: 0,
  },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (depth > MAX_ARTIFACT_SNAPSHOT_DEPTH || state.nodes > MAX_ARTIFACT_SNAPSHOT_NODES) {
    throw new TypeError(`${label} exceeds the compiled artifact complexity limit`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    accountArtifactString(state, value, label);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} contains a non-JSON value`);
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} must not contain a Proxy`);
  if (state.ancestors.has(value)) throw new TypeError(`${label} must not contain a cycle`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} must contain only plain arrays`);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol')) {
        throw new TypeError(`${label} must not contain symbol properties`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new TypeError(`${label} has an invalid array length`);
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_ARTIFACT_CONTAINER_KEYS) {
        throw new TypeError(`${label} exceeds the compiled artifact container limit`);
      }
      if (keys.length !== length + 1) {
        throw new TypeError(`${label} must be a dense array without extra properties`);
      }
      const snapshot: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`${label}[${index}] must be an enumerable data property`);
        }
        snapshot.push(canonicalArtifactSnapshot(
          descriptor.value,
          `${label}[${index}]`,
          state,
          depth + 1,
        ));
      }
      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_ARTIFACT_CONTAINER_KEYS) {
      throw new TypeError(`${label} exceeds the compiled artifact container limit`);
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new TypeError(`${label} must not contain symbol properties`);
      }
      accountArtifactString(state, key, `${label} property name`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${label}.${key} must be an enumerable data property`);
      }
      snapshot[key] = canonicalArtifactSnapshot(
        descriptor.value,
        `${label}.${key}`,
        state,
        depth + 1,
      );
    }
    return snapshot;
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeRequest(input: unknown): {
  readonly admission: unknown;
  readonly sourceProofs: unknown;
  readonly profileAuthorization: unknown;
  readonly maxInstructionTokens: number;
  readonly maxValidatorOperations: number;
} {
  assertPlainRecord(input, 'agentSkillCompilationRequest');
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new TypeError(`agentSkillCompilationRequest contains unsupported field: ${key}`);
    }
  }
  for (const key of REQUEST_KEYS) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`agentSkillCompilationRequest.${key} is required`);
  }
  if (!Number.isSafeInteger(input.maxInstructionTokens)
    || (input.maxInstructionTokens as number) < 0
    || (input.maxInstructionTokens as number) > 1_000_000) {
    throw new TypeError('agentSkillCompilationRequest.maxInstructionTokens must be a safe integer in [0, 1000000]');
  }
  if (!Number.isSafeInteger(input.maxValidatorOperations)
    || (input.maxValidatorOperations as number) < 0
    || (input.maxValidatorOperations as number) > 1_000) {
    throw new TypeError('agentSkillCompilationRequest.maxValidatorOperations must be a safe integer in [0, 1000]');
  }
  return {
    admission: input.admission,
    sourceProofs: input.sourceProofs,
    profileAuthorization: input.profileAuthorization,
    maxInstructionTokens: input.maxInstructionTokens as number,
    maxValidatorOperations: input.maxValidatorOperations as number,
  };
}

function assertOperationArgs(
  operation: AgentSkillProgramOperationV1,
  definition: PrimitiveDefinition,
  skillRef: string,
): void {
  const expectedKeys = Object.keys(definition.args).sort();
  const actualKeys = Object.keys(operation.args).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError(`primitive args mismatch: ${skillRef}:${operation.primitiveId}`);
  }
  for (const key of expectedKeys) {
    const value = operation.args[key];
    const spec = definition.args[key]!;
    if (spec.type === 'token' && typeof value !== 'string') {
      throw new TypeError(`primitive arg ${key} must be a token: ${skillRef}:${operation.primitiveId}`);
    }
    if (spec.type === 'token' && typeof value === 'string'
      && spec.allowedValues !== undefined && !spec.allowedValues.includes(value)) {
      throw new TypeError(`primitive arg ${key} is not registered: ${skillRef}:${operation.primitiveId}`);
    }
    if (spec.type === 'boolean' && typeof value !== 'boolean') {
      throw new TypeError(`primitive arg ${key} must be a boolean: ${skillRef}:${operation.primitiveId}`);
    }
    if (spec.type === 'integer') {
      if (!Number.isSafeInteger(value)
        || (value as number) < (spec.minimum ?? Number.MIN_SAFE_INTEGER)
        || (value as number) > (spec.maximum ?? Number.MAX_SAFE_INTEGER)) {
        throw new TypeError(`primitive arg ${key} is outside its integer bounds: ${skillRef}:${operation.primitiveId}`);
      }
    }
  }
}

function argument(
  operation: AgentSkillProgramOperationV1,
  key: string,
): AgentSkillProgramArgumentV1 {
  const value = operation.args[key];
  if (value === undefined) throw new TypeError(`primitive arg missing after validation: ${key}`);
  return value;
}

interface PrimitiveValidationState {
    readonly semanticOperations: Set<string>;
    lastProcedureOrder: number;
}

function validateProgramOperation(
    operation: AgentSkillProgramOperationV1,
    kind: AgentSkillKind,
    skillRef: string,
    primitiveCounts: Map<string, number>,
    state: PrimitiveValidationState,
): PrimitiveDefinition {
    const definition = DEFINITION_BY_ID.get(operation.primitiveId);
    if (!definition) throw new TypeError(`unknown Agent Skill primitive: ${operation.primitiveId}`);
    if (definition.kind !== kind) {
        throw new TypeError(`primitive kind mismatch: ${skillRef}:${operation.primitiveId}`);
    }
    assertOperationArgs(operation, definition, skillRef);
    const nextCount = (primitiveCounts.get(operation.primitiveId) ?? 0) + 1;
    if (nextCount > definition.maxPerProgram) {
        throw new TypeError(`primitive cardinality exceeded: ${skillRef}:${operation.primitiveId}`);
    }
    primitiveCounts.set(operation.primitiveId, nextCount);
    const semanticValue = definition.semanticArg === undefined
        ? 'singleton'
        : String(argument(operation, definition.semanticArg));
    const semanticKey = `${operation.primitiveId}\u0000${semanticValue}`;
    if (state.semanticOperations.has(semanticKey)) {
        throw new TypeError(`duplicate semantic primitive: ${operation.primitiveId}:${semanticValue}`);
    }
    state.semanticOperations.add(semanticKey);
    if (operation.primitiveId === 'procedure.apply-step') {
        const order = argument(operation, 'order') as number;
        if (order <= state.lastProcedureOrder) {
            throw new TypeError('procedure operation order must be globally unique and strictly increasing');
        }
        state.lastProcedureOrder = order;
    }
    return definition;
}

/** Static syntax/registered-primitive checks only; no source authority, rendering or compiled artifact is issued. */
export function validateAgentSkillProgramPrimitives(input: unknown): void {
    const program = normalizeAgentSkillProgram(canonicalArtifactSnapshot(input, 'agentSkillStaticProgram'));
    const counts = new Map<string, number>();
    const state: PrimitiveValidationState = { semanticOperations: new Set<string>(), lastProcedureOrder: -1 };
    for (const operation of program.operations) {
        validateProgramOperation(operation, program.kind, 'static-program', counts, state);
    }
}

const OUTPUT_CONTRACT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'game.turn.v1': 'Use the host game turn version one structured output contract.',
});
const CONTEXT_PRIORITY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'memory-first.v1': 'Resolve committed memory facts before optional narrative context.',
});
const POLICY_BOUNDARY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'memory.write': 'Treat memory changes as proposals until the host commits them.',
  'world.write': 'Treat world-state changes as proposals until the host commits them.',
});
const CAPABILITY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'context.read': 'Use only context that the host supplied for this turn.',
  'memory.propose': 'Return memory changes only through the host proposal contract.',
});
const PROCEDURE_STEP_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'continuity.scan': 'Check the draft against committed continuity facts.',
  'story.advance': 'Advance at least one currently active story objective.',
  'state.reconcile': 'Reconcile proposed state changes with the generated outcome.',
  ...MIGRATED_PROCEDURE_STEP_TEXT,
});
const STYLE_AXIS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'dialogue.density': 'Set dialogue density',
  'sensory.detail': 'Set sensory detail',
  'sentence.tempo': 'Set sentence tempo',
});
const STYLE_CONSTRAINT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'avoid.cliche': 'Avoid the host-defined cliche pattern set',
  'preserve.voice': 'Preserve the established character voice',
});
const VALIDATOR_EVALUATOR: Readonly<Record<string, string>> = Object.freeze({
  'turn.schema': 'evaluator.turn-schema',
  'memory.shape': 'evaluator.memory-shape',
  'world.consistency': 'evaluator.world-consistency',
});

function registeredText(registry: Readonly<Record<string, string>>, value: unknown, label: string): string {
  if (typeof value !== 'string' || registry[value] === undefined) {
    throw new TypeError(`${label} is not registered`);
  }
  return registry[value];
}

/** Host-owned renderers. No Skill body, name or description is interpolated. */
function renderPromptPrimitive(operation: AgentSkillProgramOperationV1): string {
  switch (operation.primitiveId) {
    case 'foundation.output-contract':
      return registeredText(OUTPUT_CONTRACT_TEXT, argument(operation, 'contractId'), 'output contract');
    case 'foundation.context-priority':
      return registeredText(CONTEXT_PRIORITY_TEXT, argument(operation, 'profileId'), 'context priority');
    case 'policy.enforce-boundary':
      return registeredText(POLICY_BOUNDARY_TEXT, argument(operation, 'boundaryId'), 'policy boundary');
    case 'policy.require-capability':
      return registeredText(CAPABILITY_TEXT, argument(operation, 'capabilityId'), 'capability');
    case 'procedure.apply-step': {
      const step = registeredText(PROCEDURE_STEP_TEXT, argument(operation, 'stepId'), 'procedure step');
      const optional = argument(operation, 'optional') === true
        ? 'This step is optional when its preconditions are absent.'
        : 'This step is required.';
      return `${step} Apply it at deterministic order ${argument(operation, 'order')}. ${optional}`;
    }
    case 'style.apply-axis':
      return `${registeredText(STYLE_AXIS_TEXT, argument(operation, 'axisId'), 'style axis')} to ${argument(operation, 'level')}.`;
    case 'style.apply-profile':
      return registeredText(MIGRATED_STYLE_PROFILE_TEXT, argument(operation, 'profileId'), 'style profile');
    case 'style.toggle-constraint': {
      const constraint = registeredText(
        STYLE_CONSTRAINT_TEXT,
        argument(operation, 'constraintId'),
        'style constraint',
      );
      return argument(operation, 'enabled') === true
        ? `${constraint}.`
        : `Do not apply this turn's host-defined style constraint: ${constraint.toLowerCase()}.`;
    }
    default:
      throw new TypeError(`primitive has no prompt renderer: ${operation.primitiveId}`);
  }
}


/**
 * @author Codex @date 2026-10-16 @version 1.0
 * Offline fixture rendering only. This returns text, never a live admission, slot or compiled artifact.
 * Sharing the host renderer prevents a fixture from testing a different interpretation of Style primitives.
 */
export function renderAgentSkillStyleFixture(input: unknown): Readonly<{
    rendererVersion: 'agent-skill-style-fixture-renderer-v1';
    compilerRevision: typeof AGENT_SKILL_COMPILER_REVISION;
    primitiveRegistryDigest: string;
    instruction: string;
    instructionDigest: string;
}> {
    const program = normalizeAgentSkillProgram(canonicalArtifactSnapshot(input, 'agentSkillStyleFixture'));
    if (program.kind !== 'style') throw new TypeError('style-fixture-program-kind-invalid');
    validateAgentSkillProgramPrimitives(program);
    const instruction = program.operations.map(renderPromptPrimitive).join('\n');
    return Object.freeze({
        rendererVersion: 'agent-skill-style-fixture-renderer-v1',
        compilerRevision: AGENT_SKILL_COMPILER_REVISION,
        primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
        instruction, instructionDigest: digestText(instruction),
    });
}


function validatorEntry(
  skill: {
    readonly skillId: string;
    readonly version: string;
    readonly manifestDigest: string;
    readonly evaluatorId: string;
  },
  operation: AgentSkillProgramOperationV1,
): AgentSkillValidatorPlanEntryV1 {
  if (operation.primitiveId !== 'validator.run-check') {
    throw new TypeError(`primitive has no local validator planner: ${operation.primitiveId}`);
  }
  const checkId = argument(operation, 'checkId') as string;
  const expectedEvaluator = VALIDATOR_EVALUATOR[checkId];
  if (expectedEvaluator === undefined || skill.evaluatorId !== expectedEvaluator) {
    throw new TypeError(`validator evaluator mismatch: ${skill.skillId}@${skill.version}`);
  }
  const core = {
    skillId: skill.skillId,
    version: skill.version,
    manifestDigest: skill.manifestDigest,
    evaluatorId: skill.evaluatorId,
    checkId,
    severityId: argument(operation, 'severityId') as string,
  };
  return deepFreeze({ ...core, entryDigest: digestCanonical(core) });
}

export const AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST = digestCanonical({
  definitions: PRIMITIVE_DEFINITIONS,
  fixedRenderers: {
    outputContracts: OUTPUT_CONTRACT_TEXT,
    contextPriorities: CONTEXT_PRIORITY_TEXT,
    policyBoundaries: POLICY_BOUNDARY_TEXT,
    capabilities: CAPABILITY_TEXT,
    procedureSteps: PROCEDURE_STEP_TEXT,
    styleAxes: STYLE_AXIS_TEXT,
    styleConstraints: STYLE_CONSTRAINT_TEXT,
    styleProfiles: MIGRATED_STYLE_PROFILE_TEXT,
  },
  validatorEvaluators: VALIDATOR_EVALUATOR,
});

/** The structural Schema is generated from the SAME closed registry used by
 * validation/rendering. Canonical bytes and cross-operation semantics still
 * require assessAgentSkillProgramCompatibility; Schema alone grants nothing. */
export const AGENT_SKILL_PROGRAM_JSON_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:jiuguan:agent-skill-program:v1',
  title: 'Agent Skill Safe Program v1',
  oneOf: [...new Set(PRIMITIVE_DEFINITIONS.map(definition => definition.kind))].map(kind => ({
    type: 'object', additionalProperties: false, required: ['programVersion', 'kind', 'operations'],
    properties: {
      programVersion: { const: 'agent-skill-program-v1' }, kind: { const: kind },
      operations: { type: 'array', minItems: 1, maxItems: AGENT_SKILL_PROGRAM_LIMITS.operations, uniqueItems: true,
        items: { oneOf: PRIMITIVE_DEFINITIONS.filter(definition => definition.kind === kind).map((definition: PrimitiveDefinition) => ({
          type: 'object', additionalProperties: false, required: ['primitiveId', 'args'],
          properties: {
            primitiveId: { const: definition.primitiveId },
            args: { type: 'object', additionalProperties: false, required: Object.keys(definition.args).sort(),
              properties: Object.fromEntries(Object.entries(definition.args).map(([key, spec]) => [key,
                spec.type === 'token' ? { type: 'string', enum: spec.allowedValues, maxLength: 240 }
                  : spec.type === 'integer' ? { type: 'integer', minimum: spec.minimum, maximum: spec.maximum }
                    : { type: 'boolean' }])) },
          },
        })) },
      },
    },
  })),
  'x-jiuguan-compatibility': {
    compilerRevision: AGENT_SKILL_COMPILER_REVISION,
    primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    maxBodyChars: AGENT_SKILL_PROGRAM_LIMITS.bodyChars,
    requiredChecks: ['exact-canonical-json', 'manifest-kind-binding', 'primitive-cardinality',
      'unique-semantic-operations', 'strict-procedure-order'],
    authority: 'none',
  },
});

export const AGENT_SKILL_PROGRAM_INVALID_REASONS = Object.freeze([
  'legacy-uncompiled', 'program-invalid', 'program-kind-mismatch', 'program-primitive-incompatible',
] as const);
export type AgentSkillProgramInvalidReason = typeof AGENT_SKILL_PROGRAM_INVALID_REASONS[number];
export type AgentSkillProgramCompatibility =
  | Readonly<{ status: 'compatible'; form: 'canonical'; reasonCode: null; program: AgentSkillProgramV1 }>
  | Readonly<{ status: 'invalid'; form: 'canonical' | 'legacy-body' | 'unknown'; reasonCode: AgentSkillProgramInvalidReason }>;

/** Static compatibility, never admission or a compiled artifact. Exact parse
 * precedes kind binding, which precedes the original registered-primitive check. */
export function assessAgentSkillProgramCompatibility(body: unknown, expectedKind?: AgentSkillKind): AgentSkillProgramCompatibility {
  let program: AgentSkillProgramV1;
  try { program = parseAgentSkillProgramBody(body); }
  catch (error) {
    return Object.freeze({ status: 'invalid', form: error instanceof LegacyAgentSkillBodyError ? 'legacy-body' : 'unknown',
      reasonCode: error instanceof LegacyAgentSkillBodyError ? 'legacy-uncompiled' : 'program-invalid' });
  }
  if (expectedKind !== undefined && expectedKind !== program.kind)
    return Object.freeze({ status: 'invalid', form: 'canonical', reasonCode: 'program-kind-mismatch' });
  try { validateAgentSkillProgramPrimitives(program); }
  catch { return Object.freeze({ status: 'invalid', form: 'canonical', reasonCode: 'program-primitive-incompatible' }); }
  return Object.freeze({ status: 'compatible', form: 'canonical', reasonCode: null, program });
}

/**
 * Compile an admitted set atomically. This is intentionally dark infrastructure: callers must not
 * connect the result to Prompt assembly until a server ProfileAdmissionService supplies the source
 * proofs and a live policy explicitly authorizes the compiled artifact.
 */
export function compileAgentSkillPrograms(input: unknown): CompiledAgentSkillArtifactV1 {
  const request = normalizeRequest(input);
  const consumption = prepareAgentSkillConsumptionSet(
    request.admission,
    request.sourceProofs,
    request.profileAuthorization,
  );
  const promptSlots: AgentSkillPromptSlotV1[] = [];
  const validatorPlan: AgentSkillValidatorPlanEntryV1[] = [];
  const programTraces: AgentSkillCompiledProgramTraceV1[] = [];
  const primitiveValidation: PrimitiveValidationState = {
    semanticOperations: new Set<string>(), lastProcedureOrder: -1,
  };

  for (const skill of consumption.programs) {
    let promptOperationCount = 0;
    let validatorOperationCount = 0;
    const skillRef = `${skill.skillId}@${skill.version}`;
    const primitiveCounts = new Map<string, number>();
    const skillPromptLines: string[] = [];
    for (const operation of skill.program.operations) {
      const definition = validateProgramOperation(
        operation, skill.kind, skillRef, primitiveCounts, primitiveValidation,
      );
      if (definition.target === 'prompt') {
        skillPromptLines.push(renderPromptPrimitive(operation));
        promptOperationCount += 1;
      } else {
        validatorPlan.push(validatorEntry(skill, operation));
        validatorOperationCount += 1;
      }
    }
    if (skillPromptLines.length > 0) {
      if (skill.kind === 'validator') throw new TypeError(`validator cannot enter a Prompt slot: ${skillRef}`);
      const instruction = `<${skill.kind}>\n${skillPromptLines.join('\n')}\n</${skill.kind}>`;
      promptSlots.push(deepFreeze({
        slot: skill.kind,
        skillId: skill.skillId,
        version: skill.version,
        manifestDigest: skill.manifestDigest,
        instruction,
        instructionDigest: digestText(instruction),
        tokens: estimateTokens(instruction),
      }));
    }
    programTraces.push(deepFreeze({
      skillId: skill.skillId,
      version: skill.version,
      manifestDigest: skill.manifestDigest,
      programDigest: skill.programDigest,
      sourceProofDigest: skill.sourceProofDigest,
      kind: skill.kind,
      promptOperationCount,
      validatorOperationCount,
    }));
  }

  if (validatorPlan.length > request.maxValidatorOperations) {
    throw new RangeError('compiled Agent Skill validators exceed the host validator-operation ceiling');
  }
  const promptInstruction = promptSlots.length === 0
    ? ''
    : `<AgentSkillProgramV1>\n${promptSlots.map((slot) => slot.instruction).join('\n')}\n</AgentSkillProgramV1>`;
  const promptTokens = promptInstruction === '' ? 0 : estimateTokens(promptInstruction);
  if (promptTokens > request.maxInstructionTokens) {
    throw new RangeError('compiled Agent Skill instructions exceed the host instruction-token budget');
  }
  const frozenPromptSlots = Object.freeze(promptSlots);
  const frozenValidatorPlan = Object.freeze(validatorPlan);
  const frozenPrograms = Object.freeze(programTraces);
  const promptInstructionDigest = digestText(promptInstruction);
  const validatorPlanDigest = digestCanonical(frozenValidatorPlan);
  const compiledInstructionSetDigest = digestCanonical({
    compilerVersion: AGENT_SKILL_COMPILER_VERSION,
    compilerRevision: AGENT_SKILL_COMPILER_REVISION,
    primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    profileId: consumption.profileId,
    profileAuthorizationDigest: consumption.profileAuthorizationDigest,
    profilePolicyRevision: consumption.profilePolicyRevision,
    profileRegistryRevision: consumption.profileRegistryRevision,
    authorityRevision: consumption.authorityRevision,
    admissionDigest: consumption.admissionDigest,
    selectionInstructionSetDigest: consumption.instructionSetDigest,
    consumptionDigest: consumption.consumptionDigest,
    promptInstructionDigest,
    validatorPlanDigest,
    promptTokens,
    maxInstructionTokens: request.maxInstructionTokens,
    validatorOperations: frozenValidatorPlan.length,
    maxValidatorOperations: request.maxValidatorOperations,
    orderedPrograms: frozenPrograms.map((program) => ({
      skillId: program.skillId,
      version: program.version,
      manifestDigest: program.manifestDigest,
      programDigest: program.programDigest,
      sourceProofDigest: program.sourceProofDigest,
      kind: program.kind,
    })),
  });
  const core = deepFreeze({
    compilerVersion: AGENT_SKILL_COMPILER_VERSION,
    compilerRevision: AGENT_SKILL_COMPILER_REVISION,
    primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    profileId: consumption.profileId,
    profileAuthorizationDigest: consumption.profileAuthorizationDigest,
    profilePolicyRevision: consumption.profilePolicyRevision,
    profileRegistryRevision: consumption.profileRegistryRevision,
    authorityRevision: consumption.authorityRevision,
    admissionDigest: consumption.admissionDigest,
    instructionSetDigest: consumption.instructionSetDigest,
    consumptionDigest: consumption.consumptionDigest,
    promptInstruction,
    promptInstructionDigest,
    promptTokens,
    maxInstructionTokens: request.maxInstructionTokens,
    promptSlots: frozenPromptSlots,
    validatorPlan: frozenValidatorPlan,
    validatorPlanDigest,
    maxValidatorOperations: request.maxValidatorOperations,
    programs: frozenPrograms,
    compiledInstructionSetDigest,
  });
  return deepFreeze({ ...core, compiledArtifactDigest: digestCanonical(core) });
}

/**
 * Verify an untrusted compiled artifact against a fresh result from the official compiler.
 * Candidate digests are deliberately not trusted: every field must match the canonical result.
 */
export function verifyCompiledAgentSkillArtifact(
  input: unknown,
  requestInput: unknown,
): CompiledAgentSkillArtifactV1 {
  const expected = compileAgentSkillPrograms(requestInput);
  const expectedCanonical = canonicalJson(expected);
  if (expectedCanonical.length > MAX_ARTIFACT_STRING_CHARS) {
    throw new TypeError('official compiled Agent Skill artifact exceeds the verification limit');
  }
  const candidateSnapshot = canonicalArtifactSnapshot(input, 'compiledAgentSkillArtifact', {
    ancestors: new Set<object>(),
    // A candidate can never legitimately contain more raw string data than the complete expected
    // canonical JSON. The floor keeps small artifacts easy to diagnose without weakening the cap.
    maxStringChars: Math.max(1_024, expectedCanonical.length),
    nodes: 0,
    stringChars: 0,
  });
  if (canonicalJson(candidateSnapshot) !== expectedCanonical) {
    throw new TypeError('compiled Agent Skill artifact does not match canonical compiler output');
  }
  return expected;
}
