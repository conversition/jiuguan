import { createHash } from 'node:crypto';
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
import {
  MAINTENANCE_PROVIDER_RETRY_POLICY,
  maintenanceTransientProviderFailure,
  rememberMaintenanceHarnessFailure,
} from './maintenance-failure-contract.ts';
import { AdmissionTicketBroker } from './agent-admission-broker.ts';
import {
  consumeAgentLoopModelAdmissionScope, type AgentLoopModelAdmissionScope,
} from './agent-loop-model-invocation-permit.ts';
import {
  AdmittedModelGateway,
  type AdmittedModelLeaseOutcome,
  type AdmittedModelLeaseSnapshot,
  type AdmittedModelLeaseAudit,
} from './admitted-model-gateway.ts';
import {
  maintenanceHarnessContent,
  maintenanceHarnessRequest,
} from './maintenance-model-adapter.ts';
import {
    MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
    maintenanceModelToolSurfaceDescriptor,
    type MaintenanceModelToolSelector,
} from './maintenance-model-contract.ts';
export {
    MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
    MAINTENANCE_MODEL_TOOL_SURFACES,
    maintenanceModelToolSurfaceDescriptor,
} from './maintenance-model-contract.ts';
import type {
  ArcMaintenanceProposalContext,
  MemoryConsolidationProposalContext,
  MaintenanceStrictProposalContext,
  MaintenanceTaskKind,
  NpcMaintenanceProposalContext,
  PublicMaintenanceJob,
  RollingSummaryProposalContext,
  WorldbookRepairProposalContext,
} from './maintenance-types.ts';

const TASK_BINDING: Readonly<Record<MaintenanceTaskKind, Readonly<{
  taskKind: AgentTaskKind;
  budgetLane: 'preference' | 'style' | 'arc' | 'npc' | 'worldbook';
  expectedBenefit: 'memory-quality' | 'arc-coherence' | 'npc-consistency' | 'worldbook-consistency';
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
  // 世界书修正：独立预算 lane，避免与 NPC/剧情弧互相挤占；只产提案，落地需人工审批。
  worldbook_repair: Object.freeze({
    taskKind: 'worldbook_repair', budgetLane: 'worldbook', expectedBenefit: 'worldbook-consistency',
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

const NPC_PROVIDER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const NPC_PROVIDER_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARC_PROVIDER_ID = /^arc:sha256:[a-f0-9]{64}$/u;
const WORLDBOOK_PROVIDER_FILE = /^[^\\/\u0000-\u001f\u007f]{1,200}\.json$/iu;
const WORLDBOOK_PROVIDER_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/u;

function requireArcProviderContext(
  value: MaintenanceStrictProposalContext,
): ArcMaintenanceProposalContext {
  if (!('allowedArcIds' in value)
    || !Array.isArray(value.allowedArcIds) || value.allowedArcIds.length < 1
    || value.allowedArcIds.length > 64
    || new Set(value.allowedArcIds).size !== value.allowedArcIds.length
    || value.allowedArcIds.some((item) => typeof item !== 'string' || !ARC_PROVIDER_ID.test(item))
    || !Array.isArray(value.allowedSourceRefs) || value.allowedSourceRefs.length < 1
    || value.allowedSourceRefs.length > 128
    || new Set(value.allowedSourceRefs).size !== value.allowedSourceRefs.length
    || value.allowedSourceRefs.some((item) => typeof item !== 'string' || !NPC_PROVIDER_TOKEN.test(item))
    || !Number.isSafeInteger(value.maxRound) || value.maxRound < 1
    || typeof value.sessionId !== 'string' || !NPC_PROVIDER_TOKEN.test(value.sessionId)
    || typeof value.sourceRevision !== 'string' || !NPC_PROVIDER_DIGEST.test(value.sourceRevision)) {
    throw new Error('maintenance-arc-proposal-context-invalid');
  }
  return value;
}

/** Provider-native Arc contract bound to the fixed projection and chat source window. */
function arcProposalParameters(context: ArcMaintenanceProposalContext): Record<string, unknown> {
  const arcId = { $ref: '#/$defs/arcId' };
  const arcIds = (minimum: number, maximum: number) => ({
    type: 'array', minItems: minimum, maxItems: Math.min(maximum, context.allowedArcIds.length),
    uniqueItems: true, items: arcId,
  });
  const sourceRefs = (minimum = 1) => ({
    type: 'array', minItems: minimum, maxItems: Math.min(32, context.allowedSourceRefs.length),
    uniqueItems: true, items: { $ref: '#/$defs/sourceRef' },
  });
  const actionVariants: Record<string, unknown>[] = [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'arcId', 'status', 'sourceRefs'],
      properties: {
        kind: { type: 'string', enum: ['set_status'] },
        arcId,
        status: { type: 'string', enum: ['open', 'closed', 'dormant'] },
        sourceRefs: sourceRefs(),
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'arcIds', 'boundaryRound', 'sourceRefs'],
      properties: {
        kind: { type: 'string', enum: ['chapter_boundary'] },
        arcIds: arcIds(1, 8),
        boundaryRound: { type: 'integer', minimum: 1, maximum: context.maxRound },
        sourceRefs: sourceRefs(),
      },
    },
  ];
  // merge and dependency ordering are impossible with one Arc. Do not expose
  // unsatisfiable choices to the Provider and then reject them at runtime.
  if (context.allowedArcIds.length >= 2) actionVariants.push(
    {
      type: 'object', additionalProperties: false,
      description: 'targetArcId must also occur in arcIds.',
      required: ['kind', 'arcIds', 'targetArcId', 'sourceRefs'],
      properties: {
        kind: { type: 'string', enum: ['merge'] },
        arcIds: arcIds(2, 8),
        targetArcId: arcId,
        sourceRefs: sourceRefs(),
      },
    },
    {
      type: 'object', additionalProperties: false,
      description: 'dependencyArcIds must not contain arcId.',
      required: ['kind', 'arcId', 'dependencyArcIds', 'sourceRefs'],
      properties: {
        kind: { type: 'string', enum: ['order_dependencies'] },
        arcId,
        dependencyArcIds: arcIds(1, 16),
        sourceRefs: sourceRefs(),
      },
    },
  );
  // A source conflict requires at least two distinct source references.
  if (context.allowedSourceRefs.length >= 2) actionVariants.push({
    type: 'object', additionalProperties: false,
    required: ['kind', 'arcIds', 'sourceRefs'],
    properties: {
      kind: { type: 'string', enum: ['mark_source_conflict'] },
      arcIds: arcIds(1, 8),
      sourceRefs: sourceRefs(2),
    },
  });
  return {
    type: 'object', additionalProperties: false,
    $defs: {
      arcId: { type: 'string', enum: [...context.allowedArcIds] },
      sourceRef: { type: 'string', enum: [...context.allowedSourceRefs] },
    },
    required: ['version', 'sessionId', 'sourceRevision', 'actions'],
    properties: {
      version: { type: 'string', enum: ['arc-maintenance-proposal-v1'] },
      sessionId: { type: 'string', enum: [context.sessionId] },
      sourceRevision: { type: 'string', enum: [context.sourceRevision] },
      actions: {
        type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
        items: { type: 'object', anyOf: actionVariants },
      },
    },
  };
}

function requireNpcProviderContext(
  value: MaintenanceStrictProposalContext,
): NpcMaintenanceProposalContext {
  if (!('allowedCharacterIds' in value)
    || !Array.isArray(value.allowedCharacterIds) || value.allowedCharacterIds.length < 1
    || value.allowedCharacterIds.length > 64
    || new Set(value.allowedCharacterIds).size !== value.allowedCharacterIds.length
    || value.allowedCharacterIds.some((item) => typeof item !== 'string' || !NPC_PROVIDER_TOKEN.test(item))
    || !Array.isArray(value.allowedSourceRefs) || value.allowedSourceRefs.length < 1
    || value.allowedSourceRefs.length > 128
    || new Set(value.allowedSourceRefs).size !== value.allowedSourceRefs.length
    || value.allowedSourceRefs.some((item) => typeof item !== 'string' || !NPC_PROVIDER_TOKEN.test(item))
    || !Number.isSafeInteger(value.maxRound) || value.maxRound < 1
    || typeof value.sessionId !== 'string' || !NPC_PROVIDER_TOKEN.test(value.sessionId)
    || typeof value.sourceRevision !== 'string' || !NPC_PROVIDER_DIGEST.test(value.sourceRevision)
    || typeof value.expectedEntityVersions !== 'object' || value.expectedEntityVersions === null
    || Array.isArray(value.expectedEntityVersions)) {
    throw new Error('maintenance-npc-proposal-context-invalid');
  }
  const expectedKeys = Object.keys(value.expectedEntityVersions).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify([...value.allowedCharacterIds].sort())
    || expectedKeys.some((characterId) => !Number.isSafeInteger(value.expectedEntityVersions[characterId])
      || value.expectedEntityVersions[characterId]! < 0)) {
    throw new Error('maintenance-npc-proposal-context-invalid');
  }
  if (value.allowedSourceRefsByCharacter !== undefined) {
    const mapping = value.allowedSourceRefsByCharacter;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify([...value.allowedCharacterIds].sort())
      || value.allowedCharacterIds.some((characterId) => {
        const refs = mapping[characterId];
        return !Array.isArray(refs) || refs.length > 128
          || new Set(refs).size !== refs.length
          || refs.some((ref) => typeof ref !== 'string' || !value.allowedSourceRefs.includes(ref));
      })) {
      throw new Error('maintenance-npc-proposal-context-invalid');
    }
  }
  return value;
}

function npcNoopParameters(
  context: NpcMaintenanceProposalContext,
): Record<string, unknown> | undefined {
  const targetIds = context.completionTargetIds;
  const evidence = context.sourceEvidence;
  if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > 64
    || new Set(targetIds).size !== targetIds.length
    || targetIds.some((characterId) => !context.allowedCharacterIds.includes(characterId))
    || typeof context.evidenceSetDigest !== 'string'
    || !NPC_PROVIDER_DIGEST.test(context.evidenceSetDigest)
    || !Array.isArray(evidence) || evidence.length < 1 || evidence.length > 32
    || evidence.length !== context.allowedSourceRefs.length
    || evidence.some((row) => !row || typeof row !== 'object'
      || row.ref !== `msg:${row.messageId}`
      || !context.allowedSourceRefs.includes(row.ref)
      || !Number.isSafeInteger(row.messageId) || row.messageId < 1
      || !Number.isSafeInteger(row.round) || row.round < 1 || row.round > context.maxRound
      || (row.role !== 'user' && row.role !== 'assistant')
      || !NPC_PROVIDER_DIGEST.test(row.contentDigest))) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode', 'examinedCharacterIds', 'evidenceSetDigest'],
    properties: {
      reasonCode: { type: 'string', enum: ['no-applicable-evidence'] },
      examinedCharacterIds: {
        type: 'array',
        minItems: targetIds.length,
        maxItems: targetIds.length,
        uniqueItems: true,
        ...(targetIds.length > 0 ? { items: { type: 'string', enum: [...targetIds] } } : {}),
      },
      evidenceSetDigest: { type: 'string', enum: [context.evidenceSetDigest] },
    },
  };
}

function npcProposalParameters(
  context: NpcMaintenanceProposalContext | undefined,
): Record<string, unknown> {
  const boundedString = { type: 'string', minLength: 1 };
  const refsSchema = (refs: readonly string[]): Record<string, unknown> => ({
    type: 'array', minItems: 1, maxItems: Math.min(32, refs.length),
    uniqueItems: true,
    items: { type: 'string', enum: [...refs] },
  });
  const mappedRefs = context?.allowedSourceRefsByCharacter;
  const entityBindings = context?.allowedCharacterIds.map((characterId) => ({
    characterId,
    expectedEntityVersion: context.expectedEntityVersions[characterId]!,
    sourceRefs: mappedRefs?.[characterId] ?? context.allowedSourceRefs,
  })) ?? [];
  const entityCapableBindings = entityBindings.filter((binding) => binding.sourceRefs.length > 0);
  const entityCharacterIds = entityCapableBindings.map((binding) => binding.characterId);
  const entitySourceRefSet = new Set(entityCapableBindings.flatMap((binding) => binding.sourceRefs));
  const entitySourceRefValues = context?.allowedSourceRefs.filter((ref) => entitySourceRefSet.has(ref)) ?? [];
  const relationshipCharacterIdSet = new Set<string>();
  const relationshipSourceRefSet = new Set<string>();
  for (let left = 0; left < entityCapableBindings.length; left += 1) {
    const leftBinding = entityCapableBindings[left]!;
    const leftRefs = new Set(leftBinding.sourceRefs);
    for (let right = left + 1; right < entityCapableBindings.length; right += 1) {
      const rightBinding = entityCapableBindings[right]!;
      const sharedRefs = rightBinding.sourceRefs.filter((ref) => leftRefs.has(ref));
      if (sharedRefs.length < 1) continue;
      relationshipCharacterIdSet.add(leftBinding.characterId);
      relationshipCharacterIdSet.add(rightBinding.characterId);
      sharedRefs.forEach((ref) => relationshipSourceRefSet.add(ref));
    }
  }
  const relationshipCharacterIds = context?.allowedCharacterIds.filter((characterId) => (
    relationshipCharacterIdSet.has(characterId)
  )) ?? [];
  const relationshipSourceRefValues = context?.allowedSourceRefs.filter((ref) => (
    relationshipSourceRefSet.has(ref)
  )) ?? [];
  const singletonCharacterId = context?.allowedCharacterIds.length === 1
    ? context.allowedCharacterIds[0]
    : undefined;
  // A one-character snapshot needs no cross-field binding union: inline exact values.
  // Multi-character snapshots expose bounded enums while the runtime validator
  // remains responsible for character/version/evidence cross-field binding.
  const singletonBinding = context && singletonCharacterId !== undefined
    && entityBindings[0] !== undefined
    ? {
      characterId: singletonCharacterId,
      expectedEntityVersion: context.expectedEntityVersions[singletonCharacterId]!,
      sourceRefs: entityBindings[0].sourceRefs,
      globalSourceRefs: context.allowedSourceRefs,
      maxRound: context.maxRound,
    }
    : undefined;
  const definitions = context && !singletonBinding ? {
    npcGlobalSourceRefs: refsSchema(context.allowedSourceRefs),
    npcEffectiveRound: { type: 'integer', minimum: 1, maximum: context.maxRound },
    ...(entityCapableBindings.length > 0 ? {
      npcCharacterId: { type: 'string', enum: entityCharacterIds },
      npcEntitySourceRefs: refsSchema(entitySourceRefValues),
    } : {}),
    ...(relationshipCharacterIds.length >= 2 && relationshipSourceRefValues.length > 0 ? {
      npcRelationshipCharacterId: { type: 'string', enum: relationshipCharacterIds },
      npcRelationshipSourceRefs: refsSchema(relationshipSourceRefValues),
    } : {}),
  } : undefined;
  const globalSourceRefs = singletonBinding
    ? refsSchema(singletonBinding.globalSourceRefs)
    : context
    ? { $ref: '#/$defs/npcGlobalSourceRefs' }
    : {
      type: 'array', minItems: 1, maxItems: 32,
      items: { ...boundedString, maxLength: 240 },
    };
  const entitySourceRefs = singletonBinding
    ? singletonBinding.sourceRefs.length > 0
      ? refsSchema(singletonBinding.sourceRefs)
      : globalSourceRefs
    : context
      ? { $ref: '#/$defs/npcEntitySourceRefs' }
      : globalSourceRefs;
  const effectiveRound = singletonBinding
    ? { type: 'integer', minimum: 1, maximum: singletonBinding.maxRound }
    : context
    ? { $ref: '#/$defs/npcEffectiveRound' }
    : { type: 'integer', minimum: 1 };
  const characterId = singletonBinding
    ? { type: 'string', enum: [singletonBinding.characterId] }
    : context
    ? { $ref: '#/$defs/npcCharacterId' }
    : { ...boundedString, maxLength: 160 };
  const expectedEntityVersion = singletonBinding
    ? { type: 'integer', enum: [singletonBinding.expectedEntityVersion] }
    : context
      ? {
        type: 'integer',
        enum: [...new Set(entityCapableBindings.map((binding) => binding.expectedEntityVersion))]
          .sort((left, right) => left - right),
      }
      : { type: 'integer', minimum: 0 };
  const relationshipCharacterId = context && !singletonBinding
    ? { $ref: '#/$defs/npcRelationshipCharacterId' }
    : characterId;
  const relationshipSourceRefs = context && !singletonBinding
    ? { $ref: '#/$defs/npcRelationshipSourceRefs' }
    : entitySourceRefs;
  const field = {
    type: 'string',
    pattern: '^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.:\\-\u4e00-\u9fff]{0,63}$',
  };
  const identitySchema = (): Record<string, unknown> => ({
    type: 'object', additionalProperties: false,
    required: [
      'kind', 'mentionKey', 'alias', 'characterId', 'confidence',
      'expectedEntityVersion', 'sourceRefs',
    ],
    properties: {
      kind: { type: 'string', enum: ['identity_resolution'] },
      mentionKey: { ...boundedString, minLength: 2, maxLength: 240 },
      alias: { ...boundedString, minLength: 2, maxLength: 160 },
      characterId,
      confidence: { type: 'string', enum: ['high', 'medium'] },
      expectedEntityVersion,
      sourceRefs: entitySourceRefs,
    },
  });
  const relationshipSchema = (
    perspective: 'objective' | 'subjective',
  ): Record<string, unknown> => ({
    type: 'object', additionalProperties: false,
    required: [
      'kind', 'characterId', 'toCharacterId', 'relationType', 'perspective', 'status', 'confidence',
      'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
    ],
    properties: {
      kind: { type: 'string', enum: ['relationship'] },
      characterId: relationshipCharacterId,
      toCharacterId: relationshipCharacterId,
      relationType: field,
      perspective: { type: 'string', enum: [perspective] },
      status: perspective === 'objective'
        ? { type: 'string', enum: ['confirmed'] }
        : { type: 'string', enum: ['confirmed', 'pending', 'unresolved', 'last-known', 'unknown'] },
      confidence: perspective === 'objective'
        ? { type: 'string', enum: ['high'] }
        : { type: 'string', enum: ['high', 'medium', 'low'] },
      effectiveRound,
      expectedEntityVersion,
      sourceRefs: relationshipSourceRefs,
    },
  });
  const factSchema = (
    kinds: readonly string[],
    classification: 'objective' | 'subjective' | 'general',
  ): Record<string, unknown> => ({
    type: 'object', additionalProperties: false,
    required: [
      'kind', 'characterId', 'field', 'value', 'status', 'confidence',
      'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
    ],
    properties: {
      kind: kinds.length === 1
        ? { type: 'string', enum: [kinds[0]] }
        : { type: 'string', enum: [...kinds] },
      characterId,
      field,
      value: {},
      status: classification === 'objective'
        ? { type: 'string', enum: ['confirmed'] }
        : classification === 'subjective'
          ? { type: 'string', enum: ['pending', 'unresolved', 'last-known', 'unknown'] }
          : { type: 'string', enum: ['confirmed', 'pending', 'unresolved', 'last-known', 'unknown'] },
      confidence: classification === 'objective'
        ? { type: 'string', enum: ['high'] }
        : { type: 'string', enum: ['high', 'medium', 'low'] },
      effectiveRound,
      expectedEntityVersion,
      sourceRefs: entitySourceRefs,
    },
  });
  const boundRelationshipSchemas = !context
    || (relationshipCharacterIds.length >= 2 && relationshipSourceRefValues.length > 0)
    ? [relationshipSchema('objective'), relationshipSchema('subjective')]
    : [];
  const boundCharacterSchemas = context && entityCapableBindings.length === 0
    ? []
    : [
      identitySchema(),
      ...boundRelationshipSchemas,
      factSchema(['objective_fact'], 'objective'),
      factSchema(['belief', 'goal'], 'subjective'),
      factSchema(['profile', 'knowledge', 'secret', 'history_only'], 'general'),
    ];

  return {
    type: 'object', additionalProperties: false,
    ...(definitions ? { $defs: definitions } : {}),
    required: ['version', 'sessionId', 'sourceRevision', 'entries'],
    properties: {
      version: { type: 'string', enum: ['npc-maintenance-proposal-v1'] },
      sessionId: context
        ? { type: 'string', enum: [context.sessionId] }
        : { ...boundedString, maxLength: 240 },
      sourceRevision: context
        ? { type: 'string', enum: [context.sourceRevision] }
        : { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      entries: {
        type: 'array', minItems: 1, maxItems: 64,
        items: {
          type: 'object',
          description: 'Each entries item is a JSON object, never a JSON-encoded string.',
          anyOf: [
            {
              type: 'object', additionalProperties: false,
              required: ['kind', 'mentionDigest', 'reasonCode', 'confidence', 'sourceRefs'],
              properties: {
                kind: { type: 'string', enum: ['unresolved'] },
                mentionDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
                reasonCode: { type: 'string', enum: ['ambiguous-mention', 'unknown-character', 'conflicting-identity'] },
                confidence: { type: 'string', enum: ['low'] },
                sourceRefs: globalSourceRefs,
              },
            },
            ...boundCharacterSchemas,
          ],
        },
      },
    },
  };
}

function requireWorldbookProviderContext(
  value: MaintenanceStrictProposalContext,
): WorldbookRepairProposalContext {
  if (!('files' in value)
    || typeof value.sessionId !== 'string' || !WORLDBOOK_PROVIDER_OPAQUE.test(value.sessionId)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 8) {
    throw new Error('maintenance-worldbook-proposal-context-invalid');
  }
  const files = value.files as WorldbookRepairProposalContext['files'];
  if (new Set(files.map((file) => file.file)).size !== files.length
    || files.some((file) => typeof file.file !== 'string' || !WORLDBOOK_PROVIDER_FILE.test(file.file)
      || !NPC_PROVIDER_DIGEST.test(file.expectedRevision)
      || !NPC_PROVIDER_DIGEST.test(file.evidenceSetDigest)
      || !Array.isArray(file.entries) || file.entries.length < 1 || file.entries.length > 64
      || new Set(file.entries.map((entry) => entry.entryUid)).size !== file.entries.length
      || file.entries.some((entry) => !WORLDBOOK_PROVIDER_OPAQUE.test(entry.entryUid)
        || !NPC_PROVIDER_DIGEST.test(entry.digest)))) {
    throw new Error('maintenance-worldbook-proposal-context-invalid');
  }
  return value as WorldbookRepairProposalContext;
}

function requireRollingSummaryProviderContext(
  value: MaintenanceStrictProposalContext,
): RollingSummaryProposalContext {
  if (!('targetRound' in value)
    || typeof value.sessionId !== 'string' || !NPC_PROVIDER_TOKEN.test(value.sessionId)
    || typeof value.sourceRevision !== 'string' || !NPC_PROVIDER_DIGEST.test(value.sourceRevision)
    || !Number.isSafeInteger(value.targetRound) || value.targetRound < 0) {
    throw new Error('maintenance-summary-proposal-context-invalid');
  }
  return value;
}

function requireMemoryProviderContext(
  value: MaintenanceStrictProposalContext,
): MemoryConsolidationProposalContext {
  if (!('allowedSourceRefs' in value) || 'allowedArcIds' in value || 'allowedCharacterIds' in value
    || typeof value.sessionId !== 'string' || !NPC_PROVIDER_TOKEN.test(value.sessionId)
    || typeof value.sourceRevision !== 'string' || !NPC_PROVIDER_DIGEST.test(value.sourceRevision)
    || !Array.isArray(value.allowedSourceRefs) || value.allowedSourceRefs.length < 1
    || value.allowedSourceRefs.length > 128
    || new Set(value.allowedSourceRefs).size !== value.allowedSourceRefs.length
    || value.allowedSourceRefs.some((item) => typeof item !== 'string' || !NPC_PROVIDER_TOKEN.test(item))
    || !Number.isSafeInteger(value.maxRound) || value.maxRound < 1) {
    throw new Error('maintenance-memory-proposal-context-invalid');
  }
  return value;
}

/** Provider-native worldbook proposal contract bound to the fixed asset snapshot. */
function worldbookRepairProposalParameters(
  context: WorldbookRepairProposalContext,
): Record<string, unknown> {
  const entries = context.files.flatMap((file) => file.entries);
  // Pair bindings materially improve small/normal worldbooks. At the maximum
  // 8x64 snapshot, keep the request bounded and let the same strict runtime
  // validator enforce uid/digest pairing after the call.
  const compactEntryBindings = entries.length <= 128
    ? {
      allOf: [{
        oneOf: entries.map((entry) => ({
          properties: {
            entryUid: { const: entry.entryUid },
            expectedEntryDigest: { const: entry.digest },
          },
          required: ['entryUid', 'expectedEntryDigest'],
        })),
      }],
    }
    : {};
  const patch = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: {
      content: { type: 'string', maxLength: 16_000 },
      enabled: { type: 'boolean' },
      name: { type: 'string', maxLength: 512 },
      key: {
        type: 'array', maxItems: 32,
        items: { type: 'string', minLength: 1, maxLength: 240 },
      },
    },
  };
  return {
    type: 'object', additionalProperties: false,
    required: ['version', 'sessionId', 'file', 'expectedRevision', 'evidenceSetDigest', 'changes'],
    properties: {
      version: { type: 'string', const: 'worldbook-repair-proposal-v1' },
      sessionId: { type: 'string', const: context.sessionId },
      file: { type: 'string', enum: context.files.map((file) => file.file) },
      expectedRevision: { type: 'string', enum: context.files.map((file) => file.expectedRevision) },
      evidenceSetDigest: { type: 'string', enum: context.files.map((file) => file.evidenceSetDigest) },
      changes: {
        type: 'array', minItems: 1, maxItems: 16,
        items: {
          type: 'object', additionalProperties: false,
          required: ['entryUid', 'expectedEntryDigest', 'reasonCode', 'patch'],
          properties: {
            entryUid: { type: 'string', enum: [...new Set(entries.map((entry) => entry.entryUid))] },
            expectedEntryDigest: { type: 'string', enum: [...new Set(entries.map((entry) => entry.digest))] },
            reasonCode: {
              type: 'string', enum: ['resolve-conflict', 'clarify-scope', 'disable-stale-entry'],
            },
            patch,
          },
          ...compactEntryBindings,
        },
      },
    },
    allOf: [{
      oneOf: context.files.map((file) => ({
        properties: {
          file: { const: file.file },
          expectedRevision: { const: file.expectedRevision },
          evidenceSetDigest: { const: file.evidenceSetDigest },
        },
        required: ['file', 'expectedRevision', 'evidenceSetDigest'],
      })),
    }],
  };
}

function proposalParameters(
  taskKind: MaintenanceTaskKind,
  proposalContext?: MaintenanceStrictProposalContext,
): Record<string, unknown> {
  const boundedString = { type: 'string', minLength: 1 };
  if (taskKind === 'memory_consolidation') {
    if (proposalContext === undefined) throw new Error('maintenance-memory-proposal-context-required');
    const context = requireMemoryProviderContext(proposalContext);
    return {
    type: 'object', additionalProperties: false,
    required: ['version', 'sessionId', 'sourceRevision', 'facts'],
    properties: {
      version: { type: 'string', const: 'memory-consolidation-proposal-v1' },
      sessionId: { type: 'string', const: context.sessionId },
      sourceRevision: { type: 'string', const: context.sourceRevision },
      facts: {
        type: 'array', minItems: 1, maxItems: 64, items: {
          type: 'object', additionalProperties: false,
          required: [
            'subject', 'predicate', 'value', 'status', 'confidence', 'effectiveRound', 'sourceRefs',
          ],
          properties: {
            subject: { ...boundedString, maxLength: 240 },
            predicate: { ...boundedString, maxLength: 120 },
            value: { type: ['string', 'number', 'boolean', 'null'] },
            status: { type: 'string', enum: ['confirmed', 'pending', 'last-known', 'history_only'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            effectiveRound: { type: 'integer', minimum: 1, maximum: context.maxRound },
            sourceRefs: {
              type: 'array', minItems: 1, maxItems: Math.min(16, context.allowedSourceRefs.length),
              uniqueItems: true,
              items: { type: 'string', enum: [...context.allowedSourceRefs] },
            },
          },
          allOf: [{
            if: { properties: { status: { const: 'confirmed' } }, required: ['status'] },
            then: { properties: { confidence: { const: 'high' } } },
          }, {
            if: { properties: { status: { const: 'history_only' } }, required: ['status'] },
            then: { properties: { confidence: { enum: ['medium', 'low'] } } },
          }],
        },
      },
    },
  };
  }
  if (taskKind === 'branch_index') {
    if (proposalContext === undefined) throw new Error('maintenance-arc-proposal-context-required');
    return arcProposalParameters(requireArcProviderContext(proposalContext));
  }
  if (taskKind === 'rolling_summary') {
    if (proposalContext === undefined) throw new Error('maintenance-summary-proposal-context-required');
    const context = requireRollingSummaryProviderContext(proposalContext);
    return {
    type: 'object', additionalProperties: false, required: ['summary', 'throughRound'],
    properties: {
      summary: { ...boundedString, maxLength: 16_000 },
      throughRound: { type: 'integer', const: context.targetRound },
    },
    };
  }
  if (taskKind === 'npc_state') {
    return npcProposalParameters(
      proposalContext === undefined ? undefined : requireNpcProviderContext(proposalContext),
    );
  }
  if (taskKind === 'worldbook_repair') {
    if (proposalContext === undefined) {
      throw new Error('maintenance-worldbook-proposal-context-required');
    }
    return worldbookRepairProposalParameters(requireWorldbookProviderContext(proposalContext));
  }
  throw new Error('maintenance-provider-tool-contract-invalid');
}

/** Native declarations; strict NPC proposal fields are bound to the current fixed snapshot. */
export function maintenanceProviderTools(
  taskKind: MaintenanceTaskKind,
  proposalContext?: MaintenanceStrictProposalContext,
): readonly Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    QUERY_TOOL('query_memory'),
    QUERY_TOOL('get_worldbook'),
    VARIABLES_TOOL,
    {
      type: 'function',
      function: {
        name: `propose_${taskKind}`,
        description: `Submit one bounded ${taskKind} proposal; this does not commit domain state.`,
        parameters: proposalParameters(taskKind, proposalContext),
      },
    },
  ];
  if (taskKind === 'npc_state' && proposalContext !== undefined) {
    const context = requireNpcProviderContext(proposalContext);
    const parameters = npcNoopParameters(context);
    if (parameters) tools.push({
      type: 'function',
      function: {
        name: 'complete_npc_state_noop',
        description: 'Finish successfully when every incomplete NPC was examined but visible evidence supports no proposal; this performs no business write.',
        parameters,
      },
    });
  }
  return Object.freeze(tools.map((tool) => Object.freeze(structuredClone(tool))));
}

export interface ResolvedMaintenanceModelToolSurface {
    readonly sourceVersion: typeof MAINTENANCE_MODEL_TOOL_SURFACE_VERSION;
    readonly taskKind: MaintenanceTaskKind;
    readonly selector: MaintenanceModelToolSelector;
    readonly tools: readonly Record<string, unknown>[];
    readonly toolNames: readonly string[];
    readonly toolSetDigest: string;
    readonly toolChoice: 'auto';
}


function freezeMaintenanceToolValue(value: unknown): void {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeMaintenanceToolValue(child);
    Object.freeze(value);
}


/** Resolves actual declaration bytes; this neither issues a Ticket nor grants any tool authority. */
export function resolveMaintenanceModelToolSurface(
    taskKind: MaintenanceTaskKind,
    proposalContext?: MaintenanceStrictProposalContext,
): ResolvedMaintenanceModelToolSurface {
    // The old NPC no-context builder is retained for compatibility, not indexed as production.
    if (taskKind === 'npc_state' && proposalContext === undefined) {
        throw new Error('maintenance-npc-proposal-context-required');
    }
    const tools = structuredClone(maintenanceProviderTools(taskKind, proposalContext));
    freezeMaintenanceToolValue(tools);
    const names = tools.map((tool) => (tool.function as { name: string }).name);
    const selector: MaintenanceModelToolSelector = taskKind !== 'npc_state'
        ? 'fixed-snapshot'
        : names.includes('complete_npc_state_noop') ? 'npc-fixed-snapshot-noop' : 'npc-fixed-snapshot';
    const descriptor = maintenanceModelToolSurfaceDescriptor(taskKind).variants
        .find((variant) => variant.selector === selector);
    if (!descriptor || JSON.stringify(descriptor.toolNames) !== JSON.stringify(names)) {
        throw new Error('maintenance-provider-tool-contract-invalid');
    }
    return Object.freeze({
        sourceVersion: MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
        taskKind,
        selector,
        tools,
        toolNames: Object.freeze(names),
        toolSetDigest: agentToolSetDigest(tools),
        toolChoice: 'auto',
    });
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

/**
 * Frozen v3 operational-replay memory schema. Historical evidence predates the
 * fixed-snapshot/sourceRefs write contract, so it must never be reused by the
 * production Harness or a domain committer.
 */
export function legacyMemoryMaintenanceReplayProviderTools(): readonly Record<string, unknown>[] {
  const legacyParameters = {
    type: 'object', additionalProperties: false, required: ['facts', 'supersedes'],
    properties: {
      facts: {
        type: 'array', maxItems: 512, items: {
          type: 'object', additionalProperties: false,
          required: ['subject', 'predicate', 'value'],
          properties: {
            subject: { type: 'string', minLength: 1, maxLength: 240 },
            predicate: { type: 'string', minLength: 1, maxLength: 120 },
            value: { type: ['string', 'number', 'boolean', 'null'] },
            sourceRound: { type: 'integer', minimum: 0 },
          },
        },
      },
      supersedes: {
        type: 'array', maxItems: 512, uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    anyOf: [
      { properties: { facts: { minItems: 1 } } },
      { properties: { supersedes: { minItems: 1 } } },
    ],
  };
  return Object.freeze([
    QUERY_TOOL('query_memory'),
    QUERY_TOOL('get_worldbook'),
    VARIABLES_TOOL,
    {
      type: 'function',
      function: {
        name: 'propose_memory_consolidation',
        description: 'Replay one historical memory proposal; this cannot commit domain state.',
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
  /** Fixed-snapshot strict proposal binding used to build Provider-native constraints. */
  readonly proposalContext?: MaintenanceStrictProposalContext;
  readonly budgetProfile: AgentBudgetProfileInput;
  readonly modelId: string;
  readonly mode: AgentContentMode;
  readonly reasonCodes: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly noveltyDigest: string;
  readonly fullSkillSnapshots?: readonly SkillAdmissionSnapshot[];
  /** One-use host capability for an already reserved AL MODEL invocation, not Manager ownership. */
  readonly agentLoopInvocation?: AgentLoopModelAdmissionScope;
  readonly nowMs?: () => number;
  /** Test seam; production uses one short bounded delay before the sole transient retry. */
  readonly transientRetryDelayMs?: number;
}

export interface AdmittedMaintenanceModelHandle {
  readonly model: HarnessModel;
  readonly ticketId: string;
  readonly taskKind: AgentTaskKind;
  readonly quotaReservationDigest?: string;
  readonly quotaWindowSequence?: number;
  snapshot(): AdmittedModelLeaseSnapshot;
  finish(outcome?: AdmittedModelLeaseOutcome): void;
  /** Exclusive, fresh, single-call consumer; this grants no permission beyond the existing lease. */
  claimAgentLoopConsumer(): AdmittedMaintenanceAgentLoopConsumer;
}

export interface AdmittedMaintenanceAgentLoopConsumer {
  readonly binding: AdmittedMaintenanceAgentLoopBinding;
  readonly model: HarnessModel;
  snapshot(): AdmittedModelLeaseSnapshot;
  finish(outcome?: AdmittedModelLeaseOutcome): void;
  receipt(): AdmittedModelLeaseAudit | null;
}

/** Issued from the original admitted closure, not supplied by an AL caller or Provider. */
export interface AdmittedMaintenanceAgentLoopBinding {
  readonly runId: string;
  readonly parentRunId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly lane: string;
  readonly taskKind: AgentTaskKind;
  readonly policyVersion: string;
  readonly modelId: string;
  readonly contentMode: AgentContentMode;
  readonly budgetProfileDigest: string;
  readonly toolSetDigest: string;
  readonly leaseIdDigest: string;
  readonly jobAttempt: number;
  readonly jobMode: PublicMaintenanceJob['mode'];
  readonly jobTrigger: PublicMaintenanceJob['trigger'];
  readonly jobCreatedAt: string;
  readonly agentLoopInvocationId?: string;
  readonly agentLoopTaskId?: string;
  readonly agentLoopAttemptId?: string;
  readonly agentLoopExpectedTaskRevision?: number;
  readonly agentLoopOwnerId?: string;
  readonly agentLoopEnvelopeDigest?: string;
  readonly agentLoopDeadlineMs?: number;
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
  const hasAgentLoopInvocation = 'agentLoopInvocation' in options;
  if (hasAgentLoopInvocation && (job.taskKind !== 'rolling_summary' || budgetProfile.maxModelCalls !== 1)) {
    throw new Error('maintenance-agent-loop-invocation-invalid');
  }
  if (job.taskKind === 'branch_index') {
    if (options.proposalContext === undefined) {
      throw new Error('maintenance-arc-proposal-context-required');
    }
    const context = requireArcProviderContext(options.proposalContext);
    if (context.sessionId !== job.sessionId || context.sourceRevision !== job.sourceRevision) {
      throw new Error('maintenance-arc-proposal-context-mismatch');
    }
  }
  if (job.taskKind === 'memory_consolidation') {
    if (options.proposalContext === undefined) {
      throw new Error('maintenance-memory-proposal-context-required');
    }
    const context = requireMemoryProviderContext(options.proposalContext);
    if (context.sessionId !== job.sessionId || context.sourceRevision !== job.sourceRevision) {
      throw new Error('maintenance-memory-proposal-context-mismatch');
    }
  }
  if (job.taskKind === 'npc_state') {
    if (options.proposalContext === undefined) {
      throw new Error('maintenance-npc-proposal-context-required');
    }
    const context = requireNpcProviderContext(options.proposalContext);
    if (context.sessionId !== job.sessionId || context.sourceRevision !== job.sourceRevision) {
      throw new Error('maintenance-npc-proposal-context-mismatch');
    }
  }
  if (job.taskKind === 'worldbook_repair') {
    if (options.proposalContext === undefined) {
      throw new Error('maintenance-worldbook-proposal-context-required');
    }
    const context = requireWorldbookProviderContext(options.proposalContext);
    if (context.sessionId !== job.sessionId) {
      throw new Error('maintenance-worldbook-proposal-context-mismatch');
    }
  }
  if (job.taskKind === 'rolling_summary') {
    if (options.proposalContext === undefined) {
      throw new Error('maintenance-summary-proposal-context-required');
    }
    const context = requireRollingSummaryProviderContext(options.proposalContext);
    if (context.sessionId !== job.sessionId || context.sourceRevision !== job.sourceRevision) {
      throw new Error('maintenance-summary-proposal-context-mismatch');
    }
  }
  const toolSurface = resolveMaintenanceModelToolSurface(job.taskKind, options.proposalContext);
  const tools = toolSurface.tools.map((tool) => Object.freeze(structuredClone(tool)));
  const nowMs = options.nowMs ?? Date.now;
  const issuedAt = nowMs();
  if (hasAgentLoopInvocation && (!Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(issuedAt + budgetProfile.maxWallMs))) {
    throw new Error('maintenance-agent-loop-invocation-invalid');
  }
  // Consume only after the original job/context/profile validation. A copied scope, explicit
  // undefined, or a second factory (even with another Broker) must never open another lease.
  const invocation = hasAgentLoopInvocation ? consumeAgentLoopModelAdmissionScope(options.agentLoopInvocation) : null;
  if (hasAgentLoopInvocation && (!invocation || invocation.taskId !== `agentloop.maintenance.${job.runId}`
    || !/^sha256:[a-f0-9]{64}$/u.test(invocation.invocationId)
    || !Number.isSafeInteger(invocation.deadlineMs) || invocation.deadlineMs <= issuedAt
    || invocation.deadlineMs > issuedAt + budgetProfile.maxWallMs)) {
    throw new Error('maintenance-agent-loop-invocation-invalid');
  }
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
    toolSetDigest: toolSurface.toolSetDigest,
    mode: options.mode,
    reasonCodes: options.reasonCodes,
    evidenceDigests: options.evidenceDigests,
    noveltyDigest: options.noveltyDigest,
    expectedBenefit: task.expectedBenefit,
    limits: admissionLimitsFromBudgetProfile(budgetProfile),
    deadlineMs: invocation ? invocation.deadlineMs : issuedAt + budgetProfile.maxWallMs,
    allowedTools: toolNames(tools),
    fullSkillSnapshots: options.fullSkillSnapshots ?? [],
    cooldownKey: `maintenance:${job.sessionId}:${job.taskKind}`,
    idempotencyKey: invocation ? `admit:al-model:${invocation.invocationId}` : `admit:${job.runId}:${job.taskKind}`,
    fallback: 'defer-maintenance',
  });
  const lease = options.gateway.open({
    // The quota window can admit fewer calls than the unchanged Profile ceiling.
    // Bind that issued reservation instead of accidentally requesting the full ceiling again.
    modelCallLimit: ticket.limits.maxModelCalls,
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
  const agentLoopBinding: AdmittedMaintenanceAgentLoopBinding = Object.freeze({
    runId: ticket.runId, parentRunId: ticket.parentRunId, sessionId: ticket.sessionId,
    sourceRevision: ticket.sourceRevision, lane: ticket.lane, taskKind: ticket.taskKind,
    policyVersion: ticket.policyVersion, modelId: ticket.modelId, contentMode: ticket.mode,
    budgetProfileDigest: ticket.budgetProfileDigest, toolSetDigest: ticket.toolSetDigest,
    leaseIdDigest: `sha256:${createHash('sha256').update(ticket.ticketId, 'utf8').digest('hex')}`,
    jobAttempt: job.attempt, jobMode: job.mode, jobTrigger: job.trigger, jobCreatedAt: job.createdAt,
    ...(invocation ? { agentLoopInvocationId: invocation.invocationId, agentLoopTaskId: invocation.taskId,
      agentLoopAttemptId: invocation.attemptId, agentLoopExpectedTaskRevision: invocation.expectedTaskRevision,
      agentLoopOwnerId: invocation.ownerId, agentLoopEnvelopeDigest: invocation.envelopeDigest,
      agentLoopDeadlineMs: invocation.deadlineMs } : {}),
  });
  let consumer: 'fresh' | 'legacy' | 'agent-loop' = 'fresh';
  const complete = async (input: Parameters<HarnessModel['complete']>[0], maxAttempts: number) => {
      const firstSnapshot = lease.snapshot();
      const retryDelayMs = options.transientRetryDelayMs ?? 750;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const before = lease.snapshot();
        const maxOutputTokens = Math.min(input.maxOutputTokens, before.outputTokensRemaining);
        if (maxOutputTokens < 1) throw new Error('maintenance-output-budget-exhausted');
        try {
          const response = await lease.complete(
            maintenanceHarnessRequest(options.modelId, { ...input, maxOutputTokens }, tools), input.signal,
          );
          const after = lease.snapshot();
          if (!response.usage) throw new Error('maintenance-provider-usage-unavailable');
          return {
            content: maintenanceHarnessContent(response),
            usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens,
              costMicrousd: after.costMicrousdUsed - firstSnapshot.costMicrousdUsed },
          };
        } catch (error) {
          const remaining = lease.snapshot();
          if (attempt >= maxAttempts - 1 || !maintenanceTransientProviderFailure(error)
            || remaining.status !== 'open' || remaining.modelCallsRemaining < 1 || input.signal.aborted) {
            rememberMaintenanceHarnessFailure(error);
            throw error;
          }
          await waitForRetry(retryDelayMs, input.signal);
        }
      }
      throw new Error('maintenance-provider-retry-unreachable');
  };
  const model: HarnessModel = Object.freeze({
    name: options.modelId,
    async complete(input: Parameters<HarnessModel['complete']>[0]) {
      if (consumer === 'agent-loop') throw new Error('maintenance-model-consumer-conflict');
      consumer = 'legacy';
      return await complete(input, MAINTENANCE_PROVIDER_RETRY_POLICY.maxAttempts);
    },
  });
  return Object.freeze({
    model,
    ticketId: ticket.ticketId,
    taskKind: task.taskKind,
    ...(ticket.quotaReservationDigest
      ? { quotaReservationDigest: ticket.quotaReservationDigest }
      : {}),
    ...(ticket.quotaWindowSequence !== undefined
      ? { quotaWindowSequence: ticket.quotaWindowSequence }
      : {}),
    snapshot: () => lease.snapshot(),
    finish: (outcome: AdmittedModelLeaseOutcome = 'completed') => lease.finish(outcome),
    claimAgentLoopConsumer(): AdmittedMaintenanceAgentLoopConsumer {
      const current = lease.snapshot();
      if (consumer !== 'fresh' || current.status !== 'open' || current.modelCallsUsed !== 0
        || budgetProfile.maxModelCalls !== 1 || current.modelCallsRemaining !== 1) {
        throw new Error('maintenance-model-consumer-conflict');
      }
      consumer = 'agent-loop';
      let used = false;
      return Object.freeze({
        binding: agentLoopBinding,
        model: Object.freeze({ name: options.modelId,
          async complete(input: Parameters<HarnessModel['complete']>[0]) {
            if (used) throw new Error('maintenance-model-consumer-already-used');
            used = true;
            return await complete(input, 1);
          },
        }),
        snapshot: () => lease.snapshot(),
        finish: (outcome: AdmittedModelLeaseOutcome = 'completed') => lease.finish(outcome),
        receipt: () => lease.closedAudit(),
      });
    },
  });
}
