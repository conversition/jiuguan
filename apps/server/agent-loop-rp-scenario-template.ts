/** @author Codex @date 2026-10-26 @version 1.0
 * RP static declarations shared by the template catalog and HC-1 companion index.
 * No Provider, source loader, Runner, grant, business Store or production route is installed here.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { AGENT_LOOP_ACTION_REQUEST_VERSION, AGENT_LOOP_TASK_ENVELOPE_VERSION } from '@jiuguan/agent-loop-contract';
import { AgentLoopVerifierRegistry } from './agent-loop-completion-gate.ts';
import { normalizeAgentLoopDagLeafProfile } from './agent-loop-dag-budget.ts';
import { normalizeAgentContractComponentRef } from '../../packages/agent-policy/public/agent-skill-contract-index.ts';

export const RP_SCENARIO_TEMPLATE_VERSION = 'rp-scenario-template-v1' as const;
export const RP_SCENARIO_TEMPLATE_RELEASE_VERSION = '1.1.0' as const;
export const RP_SCENARIO_CATALOG_VERSION = 'rp-scenario-template-catalog-v1' as const;
export const RP_SCENARIO_HC1_INDEX_VERSION = 'rp-scenario-hc1-index-v1' as const;
export const RP_SCENARIO_REVIEWED_PACK_VERSION = 'rp-scenario-reviewed-pack-v1' as const;
export const RP_SCENARIO_REVIEW_MANIFEST_VERSION = 'rp-scenario-review-manifest-v1' as const;
export const RP_SCENARIO_CATALOG_MAX_TEMPLATES = 64;

export const RP_SCENARIO_TEMPLATE_ERROR_CODES = Object.freeze([
    'rp-template-input-invalid',
    'rp-template-unknown',
    'rp-template-duplicate',
    'rp-template-capability-denied',
    'rp-template-delegation-denied',
    'rp-template-authority-unknown',
    'rp-template-source-unknown',
    'rp-template-partition-denied',
    'rp-template-contract-drift',
    'rp-template-declaration-drift',
] as const);
export type RpScenarioTemplateErrorCode = (typeof RP_SCENARIO_TEMPLATE_ERROR_CODES)[number];

export class RpScenarioTemplateError extends Error {
    constructor(readonly code: RpScenarioTemplateErrorCode) {
        super(code);
        this.name = 'RpScenarioTemplateError';
    }
}

function reject(code: RpScenarioTemplateErrorCode): never {
    throw new RpScenarioTemplateError(code);
}

function freezeData<T>(input: T): Readonly<T> {
    if (input && typeof input === 'object') {
        for (const value of Object.values(input)) freezeData(value);
        Object.freeze(input);
    }
    return input;
}

function canonicalJson(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
    if (input && typeof input === 'object') {
        const record = input as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(input);
}

function digest(input: unknown): string {
    return `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
}

/** Snapshot own data without invoking getters, proxy traps or caller serialization hooks. */
function copyData(input: unknown, depth = 0, counter = { nodes: 0 }): unknown {
    if (++counter.nodes > 65_536 || depth > 16 || types.isProxy(input)) reject('rp-template-input-invalid');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string' && input.length <= 8_192) return input;
    if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
    if (!input || typeof input !== 'object') reject('rp-template-input-invalid');
    if (Array.isArray(input)) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (!Number.isSafeInteger(length) || length > 64 || Reflect.ownKeys(input).length !== length + 1)
            reject('rp-template-input-invalid');
        return Array.from({ length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('rp-template-input-invalid');
            return copyData(descriptor.value, depth + 1, counter);
        });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject('rp-template-input-invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length > 64) reject('rp-template-input-invalid');
    return Object.fromEntries(
        keys.map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
                reject('rp-template-input-invalid');
            }
            return [key, copyData(descriptor.value, depth + 1, counter)];
        }),
    );
}

function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject('rp-template-input-invalid');
    return input as Record<string, unknown>;
}

function same(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

function compareTemplateIds(left: { templateId: string }, right: { templateId: string }): number {
    return left.templateId < right.templateId ? -1 : left.templateId > right.templateId ? 1 : 0;
}

const TEMPLATE_ID_PATTERN = '^rp\\.[a-z][a-z0-9-]{0,95}$';
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Coverage metadata, not eight resident agents or a promise that the corresponding sources exist. */
export const RP_ANALYSIS_CAPABILITY_FAMILIES = freezeData([
    { familyId: 'character-cognition', scope: 'Values, goals, behaviour and each character’s knowledge boundary.' },
    { familyId: 'relationship-emotion', scope: 'Evidence-backed trust, attachment, misunderstanding and repair.' },
    { familyId: 'social-interests', scope: 'Negotiation, deception, persuasion, alliances and conflicting interests.' },
    {
        familyId: 'continuity-causality',
        scope: 'Supplied chronology, ownership, injuries, promises and prerequisites.',
    },
    {
        familyId: 'clue-reasoning',
        scope: 'Evidence, competing hypotheses, testimony conflicts and missing observations.',
    },
    {
        familyId: 'spatial-exploration',
        scope: 'Supplied reachability, visibility, routes and environmental constraints.',
    },
    { familyId: 'action-conflict', scope: 'Options and trade-offs in combat, pursuit, stealth, escape and rescue.' },
    { familyId: 'rules-resources', scope: 'Only explicitly supplied rules, equipment, resources and consumption.' },
] as const);

export type RpAnalysisCapabilityFamily = (typeof RP_ANALYSIS_CAPABILITY_FAMILIES)[number]['familyId'];
type AnalysisRequirement = Readonly<{ requirementId: string; material: string }>;
type AnalysisResultRequirement = Readonly<{ outputPath: 'conclusions[].claim'; requirement: string }>;
export type RpScenarioAnalysisSpecV1 = Readonly<{
    version: 'rp-analysis-spec-v1';
    capabilityFamilies: readonly RpAnalysisCapabilityFamily[];
    inputRequirements: readonly AnalysisRequirement[];
    analysisQuestions: readonly string[];
    resultRequirements: readonly AnalysisResultRequirement[];
    validationRequirements: readonly string[];
    sourceAvailability: 'character-only-if-present';
    missingInputPolicy: 'partial-or-unknown';
    evidenceScope: 'provided-character-evidence-only';
}>;
type ReviewedScenario = Readonly<{ templateId: string; scenarioKind: string; analysisSpec: RpScenarioAnalysisSpecV1 }>;

function analysisSpec(
    capabilityFamilies: readonly RpAnalysisCapabilityFamily[],
    materials: readonly (readonly [string, string])[],
    analysisQuestions: readonly string[],
    results: readonly string[],
    validationRequirements: readonly string[],
): RpScenarioAnalysisSpecV1 {
    return freezeData({
        version: 'rp-analysis-spec-v1',
        capabilityFamilies,
        inputRequirements: materials.map(([requirementId, material]) => ({ requirementId, material })),
        analysisQuestions,
        resultRequirements: results.map((requirement) => ({ outputPath: 'conclusions[].claim', requirement })),
        validationRequirements,
        sourceAvailability: 'character-only-if-present',
        missingInputPolicy: 'partial-or-unknown',
        evidenceScope: 'provided-character-evidence-only',
    });
}

const BUILTIN_SCENARIOS: readonly ReviewedScenario[] = freezeData([
    {
        templateId: 'rp.character-consistency',
        scenarioKind: 'character-consistency',
        analysisSpec: analysisSpec(
            ['character-cognition'],
            [
                ['values-goals', 'Explicit character values and goals'],
                ['proposed-behaviour', 'Recorded behaviour to assess'],
            ],
            ['Does behaviour follow stated goals and values?', 'Is an apparent change supported by recorded events?'],
            ['Identify supported consistency or a specific contradiction; distinguish an unexplained gap from a fact.'],
            ['Reference both sides of a contradiction; never invent an event to explain a personality change.'],
        ),
    },
    {
        templateId: 'rp.court-motivation',
        scenarioKind: 'court-motivation',
        analysisSpec: analysisSpec(
            ['social-interests'],
            [
                ['interests', 'Explicit goals, obligations and leverage'],
                ['positions', 'Recorded statements and relationships'],
            ],
            ['Which interests conflict or align?', 'What alternative motives could explain the same statement?'],
            ['Compare evidence-backed interests and competing motive hypotheses, not a single asserted hidden motive.'],
            [
                'Separate recorded public positions from inferred intent; court politics is a setting, not extra authority.',
            ],
        ),
    },
    {
        templateId: 'rp.combat-tactics',
        scenarioKind: 'combat-tactics',
        analysisSpec: analysisSpec(
            ['action-conflict', 'rules-resources'],
            [
                ['combat-state', 'Explicit combatants, conditions and equipment'],
                ['combat-rules', 'Recorded applicable rules'],
            ],
            ['Which options satisfy the supplied conditions?', 'What costs and counterplay remain uncertain?'],
            ['Compare conditional options and costs; leave unsupported success odds and damage unknown.'],
            ['Do not invent numerical rules, enemy knowledge or the player’s chosen action.'],
        ),
    },
]);

const ADDITIONAL_REVIEWED_SCENARIOS: readonly ReviewedScenario[] = freezeData([
    {
        templateId: 'rp.continuity-causality',
        scenarioKind: 'continuity-causality',
        analysisSpec: analysisSpec(
            ['continuity-causality'],
            [
                ['ordered-facts', 'Recorded times, locations, possessions and conditions'],
                ['dependencies', 'Explicit promises and prerequisites'],
            ],
            ['Do supplied facts conflict in time or state?', 'Which prerequisite is unsupported or contradicted?'],
            ['Name each conflicting pair and unsupported dependency, without claiming a complete history audit.'],
            [
                'Character records are not a world history store; absent history requires partial or unknown completeness.',
            ],
        ),
    },
    {
        templateId: 'rp.character-knowledge',
        scenarioKind: 'character-knowledge',
        analysisSpec: analysisSpec(
            ['character-cognition'],
            [
                ['knowledge-claims', 'Knowledge explicitly attributed to a character'],
                ['acquisition', 'Recorded perception or communication'],
            ],
            ['What could this character know from acquisition evidence?', 'Does a claim require unobserved knowledge?'],
            [
                'Separate supported knowledge, possible inference and unavailable information for each assessed character.',
            ],
            ['Narrator or another character knowing something is not proof this character knows it; no mind-reading.'],
        ),
    },
    {
        templateId: 'rp.relationship-interaction',
        scenarioKind: 'relationship-interaction',
        analysisSpec: analysisSpec(
            ['relationship-emotion'],
            [
                ['relationship-baseline', 'Explicit relationship and personal boundaries'],
                ['interaction-evidence', 'Recorded interactions relevant to change'],
            ],
            [
                'Which interaction supports a change in trust or closeness?',
                'Could it instead reflect misunderstanding?',
            ],
            ['State supported changes or uncertainty, distinguishing unilateral feelings from mutual agreement.'],
            [
                'Missing relationship history is not a neutral baseline; affection never proves consent or a player decision.',
            ],
        ),
    },
    {
        templateId: 'rp.clue-reasoning',
        scenarioKind: 'clue-reasoning',
        analysisSpec: analysisSpec(
            ['clue-reasoning'],
            [
                ['evidence-records', 'Explicit observations and attributed testimony'],
                ['hypotheses', 'Question and candidate explanations'],
            ],
            [
                'Which evidence supports or contradicts each hypothesis?',
                'What observation would distinguish alternatives?',
            ],
            ['Compare supported and disputed explanations and evidence gaps without inventing a clue or culprit.'],
            [
                'Testimony is not independently verified fact; absent investigation records require an inconclusive result.',
            ],
        ),
    },
    {
        templateId: 'rp.action-feasibility',
        scenarioKind: 'action-feasibility',
        analysisSpec: analysisSpec(
            ['spatial-exploration', 'action-conflict', 'rules-resources'],
            [
                ['action-conditions', 'Explicit proposed action, location, access and visibility'],
                ['resources-rules', 'Recorded resources and applicable constraints'],
            ],
            [
                'Which known prerequisite permits or blocks the option?',
                'Which route, resource or rule information is missing?',
            ],
            [
                'Describe conditional feasibility, explicit costs and unresolved prerequisites; never choose for the player.',
            ],
            [
                'Character-only input is not a map or inventory interface; never invent an exit, path, item or numeric rule.',
            ],
        ),
    },
]);

const SOURCE_REF_SCHEMA = {
    type: 'string',
    minLength: 1,
    maxLength: 240,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$',
} as const;

/** Structural evidence requirements are not a factual or literary quality verdict. */
export const RP_CHILD_ANALYSIS_OUTPUT_SCHEMA = freezeData({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'rp-child-analysis-v1',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'templateId', 'completeness', 'conclusions', 'sourceWatermarks', 'truncated'],
    properties: {
        version: { const: 'rp-child-analysis-v1' },
        templateId: { type: 'string', pattern: TEMPLATE_ID_PATTERN, minLength: 4, maxLength: 99 },
        completeness: { enum: ['complete', 'partial', 'unknown'] },
        conclusions: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['claim', 'epistemicStatus', 'evidenceRefs'],
                properties: {
                    claim: { type: 'string', minLength: 1, maxLength: 512 },
                    epistemicStatus: { enum: ['fact', 'hypothesis', 'disputed'] },
                    evidenceRefs: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 8,
                        uniqueItems: true,
                        items: SOURCE_REF_SCHEMA,
                    },
                },
            },
        },
        sourceWatermarks: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['sourceRef', 'revision', 'digest'],
                properties: {
                    sourceRef: SOURCE_REF_SCHEMA,
                    revision: SOURCE_REF_SCHEMA,
                    digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
                },
            },
        },
        truncated: { type: 'boolean' },
    },
} as const);

export const RP_CHILD_ANALYSIS_OUTPUT_CONTRACT = freezeData({
    ref: RP_CHILD_ANALYSIS_OUTPUT_SCHEMA.$id,
    version: '1.1.0',
    schemaDigest: digest(RP_CHILD_ANALYSIS_OUTPUT_SCHEMA),
} as const);

/** This is an unbound declaration, not a registration in the live Action allowlist. */
export const RP_CHARACTER_READ_ACTION_CONTRACT = freezeData({
    ref: 'action.rp.read-character.v1',
    version: '1.0.0',
    requestContractVersion: AGENT_LOOP_ACTION_REQUEST_VERSION,
    sourceKind: 'character',
    effect: 'read',
    requiresAuthority: 'rp.source.character.read',
    runtimeBound: false,
} as const);

// Reuse the existing declaration validator. No verifier runners or completion rights are installed.
export const RP_CHILD_ANALYSIS_VERIFIER_SET = new AgentLoopVerifierRegistry().register({
    taskKind: 'rp.child-analysis',
    contractRevision: '1.1.0',
    verifierSetRef: 'verifiers.rp-child-analysis.v1',
    verifierSetRevision: '1.0.0',
    verifiers: [
        { verifierId: 'rp.output-schema', version: '1.0.0', kind: 'deterministic', requirement: 'required' },
        { verifierId: 'rp.source-binding', version: '1.0.0', kind: 'domain-readback', requirement: 'required' },
        { verifierId: 'rp.player-sovereignty', version: '1.0.0', kind: 'deterministic', requirement: 'required' },
    ],
});

export const RP_CHILD_ANALYSIS_TASK_CONTRACT = freezeData({
    ref: 'task.rp-child-analysis.v1',
    taskKind: 'rp.child-analysis',
    version: '1.1.0',
    envelopeContractVersion: AGENT_LOOP_TASK_ENVELOPE_VERSION,
    actionContractRefs: [RP_CHARACTER_READ_ACTION_CONTRACT.ref],
    outputContract: RP_CHILD_ANALYSIS_OUTPUT_CONTRACT,
    verifierSetRef: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRef,
    verifierSetRevision: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRevision,
    runtimeBound: false,
} as const);

/** Same read-only leaf policy as 03.1a; relative depth zero never changes root absolute maxDepth. */
export const RP_LEAF_EXECUTION_PROFILE_SNAPSHOT = freezeData({
    version: 'rp-leaf-execution-profile-snapshot-v1',
    profileRef: 'profile.rp.readonly-leaf.v1',
    leafPolicy: normalizeAgentLoopDagLeafProfile({
        version: 'agent-loop-dag-leaf-profile-v1',
        profileRef: 'profile.rp.readonly-leaf.v1',
        allowedCapabilities: ['read'],
        canDelegate: false,
    }),
    contentMode: 'nsf',
    maxChildTasks: 0,
    maxAdditionalDelegationDepth: 0,
    writes: 0,
    highRiskActions: 0,
    taskContractRef: RP_CHILD_ANALYSIS_TASK_CONTRACT.ref,
    actionContractRefs: RP_CHILD_ANALYSIS_TASK_CONTRACT.actionContractRefs,
    requiresAuthorities: [RP_CHARACTER_READ_ACTION_CONTRACT.requiresAuthority],
    modelPolicy: {
        version: 'rp-model-policy-v1',
        providerBinding: 'unbound',
        dispatchAllowed: false,
    },
    skillPolicy: { version: 'rp-skill-policy-v1', allowedSkillRefs: [] },
    sandboxPolicy: { version: 'rp-sandbox-policy-v1', capabilities: [] },
    contextPolicyRef: 'rp-context-policy-v1',
    memoryPolicy: { version: 'rp-memory-policy-v1', recall: 'disabled', embedding: 'disabled' },
    extensionVersions: [],
    authorityEffect: 'none',
} as const);

function declarationFor(scenario: ReviewedScenario) {
    return freezeData({
        templateVersion: RP_SCENARIO_TEMPLATE_VERSION,
        templateId: scenario.templateId,
        version: RP_SCENARIO_TEMPLATE_RELEASE_VERSION as string,
        scenarioKinds: [scenario.scenarioKind],
        analysisSpec: scenario.analysisSpec,
        readOnlyCapabilities: ['character.read'],
        contextPolicy: {
            version: 'rp-context-policy-v1',
            sourceKinds: ['character'],
            contentMode: 'nsf',
            maxSourceRefs: 8,
            maxInputTokens: 4_096,
            sourceInstructions: 'untrusted-data',
            playerSovereignty: 'parent-only',
            unsupportedRules: 'hypothesis-only',
        },
        outputContract: RP_CHILD_ANALYSIS_OUTPUT_CONTRACT,
        taskContract: {
            ref: RP_CHILD_ANALYSIS_TASK_CONTRACT.ref,
            version: RP_CHILD_ANALYSIS_TASK_CONTRACT.version,
            digest: digest(RP_CHILD_ANALYSIS_TASK_CONTRACT),
        },
        actionContracts: [
            {
                ref: RP_CHARACTER_READ_ACTION_CONTRACT.ref,
                version: RP_CHARACTER_READ_ACTION_CONTRACT.version,
                digest: digest(RP_CHARACTER_READ_ACTION_CONTRACT),
            },
        ],
        verifierSet: {
            ref: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRef,
            revision: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRevision,
            digest: digest(RP_CHILD_ANALYSIS_VERIFIER_SET),
        },
        executionProfileSnapshot: RP_LEAF_EXECUTION_PROFILE_SNAPSHOT,
        executionProfileDigest: digest(RP_LEAF_EXECUTION_PROFILE_SNAPSHOT),
        requiresAuthorities: RP_LEAF_EXECUTION_PROFILE_SNAPSHOT.requiresAuthorities,
        authorityEffect: 'none',
        runtimeBound: false,
    } as const);
}

export type RpScenarioTemplateV1 = ReturnType<typeof declarationFor>;
export const RP_SCENARIO_BUILTIN_TEMPLATES = Object.freeze(BUILTIN_SCENARIOS.map(declarationFor));
export const RP_SCENARIO_TEMPLATES = Object.freeze([
    ...RP_SCENARIO_BUILTIN_TEMPLATES,
    ...ADDITIONAL_REVIEWED_SCENARIOS.map(declarationFor),
]);

function assertDeclaration(value: Record<string, unknown>, expected: RpScenarioTemplateV1): void {
    if (!same(Object.keys(value).sort(), Object.keys(expected).sort())) reject('rp-template-input-invalid');
    const context = record(value.contextPolicy);
    const profile = record(value.executionProfileSnapshot);
    const leaf = record(profile.leafPolicy);
    if (context.contentMode !== 'nsf' || profile.contentMode !== 'nsf') reject('rp-template-partition-denied');
    if (!same(context.sourceKinds, expected.contextPolicy.sourceKinds)) reject('rp-template-source-unknown');
    if (leaf.canDelegate !== false || profile.maxChildTasks !== 0 || profile.maxAdditionalDelegationDepth !== 0) {
        reject('rp-template-delegation-denied');
    }
    if (
        !same(value.readOnlyCapabilities, expected.readOnlyCapabilities) ||
        !same(leaf.allowedCapabilities, expected.executionProfileSnapshot.leafPolicy.allowedCapabilities) ||
        profile.writes !== 0 ||
        profile.highRiskActions !== 0
    )
        reject('rp-template-capability-denied');
    if (
        !same(value.requiresAuthorities, expected.requiresAuthorities) ||
        !same(profile.requiresAuthorities, expected.requiresAuthorities)
    )
        reject('rp-template-authority-unknown');
    for (const key of ['taskContract', 'actionContracts', 'outputContract', 'verifierSet'] as const) {
        if (!same(value[key], expected[key])) reject('rp-template-contract-drift');
    }
    if (
        !same(profile, expected.executionProfileSnapshot) ||
        value.executionProfileDigest !== expected.executionProfileDigest
    )
        reject('rp-template-contract-drift');
    if (!same(value, expected)) reject('rp-template-declaration-drift');
}

function boundedText(input: unknown, pattern?: RegExp): string {
    if (typeof input !== 'string' || input.length < 1 || input.length > 512 || input.trim() !== input) {
        reject('rp-template-input-invalid');
    }
    if (pattern && !pattern.test(input)) reject('rp-template-input-invalid');
    return input;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (!same(Object.keys(value).sort(), [...keys].sort())) reject('rp-template-input-invalid');
}

function boundedList(input: unknown): unknown[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 8) reject('rp-template-input-invalid');
    return input;
}

function normalizeAnalysisSpec(input: unknown): RpScenarioAnalysisSpecV1 {
    const value = record(input);
    exactKeys(value, Object.keys(BUILTIN_SCENARIOS[0]!.analysisSpec));
    if (
        value.version !== 'rp-analysis-spec-v1' ||
        value.sourceAvailability !== 'character-only-if-present' ||
        value.missingInputPolicy !== 'partial-or-unknown' ||
        value.evidenceScope !== 'provided-character-evidence-only'
    )
        reject('rp-template-declaration-drift');
    const families = boundedList(value.capabilityFamilies).map((entry) => {
        const family = RP_ANALYSIS_CAPABILITY_FAMILIES.find((item) => item.familyId === entry);
        if (!family) reject('rp-template-input-invalid');
        return family.familyId;
    });
    if (new Set(families).size !== families.length) reject('rp-template-duplicate');
    const inputs = boundedList(value.inputRequirements).map((entry) => {
        const requirement = record(entry);
        exactKeys(requirement, ['requirementId', 'material']);
        return {
            requirementId: boundedText(requirement.requirementId, /^[a-z][a-z0-9-]{0,63}$/),
            material: boundedText(requirement.material),
        };
    });
    if (new Set(inputs.map((entry) => entry.requirementId)).size !== inputs.length) reject('rp-template-duplicate');
    const results = boundedList(value.resultRequirements).map((entry) => {
        const requirement = record(entry);
        exactKeys(requirement, ['outputPath', 'requirement']);
        if (requirement.outputPath !== 'conclusions[].claim') reject('rp-template-contract-drift');
        return { outputPath: 'conclusions[].claim' as const, requirement: boundedText(requirement.requirement) };
    });
    return freezeData({
        version: 'rp-analysis-spec-v1',
        capabilityFamilies: families,
        inputRequirements: inputs,
        analysisQuestions: boundedList(value.analysisQuestions).map((entry) => boundedText(entry)),
        resultRequirements: results,
        validationRequirements: boundedList(value.validationRequirements).map((entry) => boundedText(entry)),
        sourceAvailability: 'character-only-if-present',
        missingInputPolicy: 'partial-or-unknown',
        evidenceScope: 'provided-character-evidence-only',
    });
}

function reviewedCandidate(input: unknown): RpScenarioTemplateV1 {
    const value = record(input);
    const templateId = boundedText(value.templateId, new RegExp(TEMPLATE_ID_PATTERN));
    const version = boundedText(value.version, SEMANTIC_VERSION_PATTERN);
    if (version === '1.0.0' && RP_SCENARIO_TEMPLATES.some((entry) => entry.templateId === templateId)) {
        reject('rp-template-declaration-drift');
    }
    const scenarioKinds = boundedList(value.scenarioKinds);
    if (scenarioKinds.length !== 1) reject('rp-template-input-invalid');
    const scenarioKind = boundedText(scenarioKinds[0], /^[a-z][a-z0-9-]{0,95}$/);
    const expected = freezeData({
        ...declarationFor({ templateId, scenarioKind, analysisSpec: normalizeAnalysisSpec(value.analysisSpec) }),
        version,
    });
    assertDeclaration(value, expected);
    const released = RP_SCENARIO_TEMPLATES.find(
        (entry) => entry.templateId === templateId && entry.version === version,
    );
    if (released && !same(released, expected)) reject('rp-template-declaration-drift');
    return released ?? expected;
}

type ReviewEntry = Readonly<{ templateId: string; version: string; declarationDigest: string }>;
export type RpScenarioReviewedTemplatePack = Readonly<{
    packVersion: typeof RP_SCENARIO_REVIEWED_PACK_VERSION;
    reviewManifest: Readonly<{
        manifestVersion: typeof RP_SCENARIO_REVIEW_MANIFEST_VERSION;
        reviewRef: string;
        entries: readonly ReviewEntry[];
    }>;
    entries: readonly RpScenarioTemplateV1[];
    authorityEffect: 'none';
    runtimeBound: false;
    packRevision: string;
}>;

const REVIEWED_PACKS = new WeakSet<object>();
const TEMPLATE_CATALOGS = new WeakSet<object>();
const REVIEWED_DECLARATION_DIGESTS = new Map<string, string>();

/** Host construction-time review binding only. Never accept a model-provided manifest as approval or a grant. */
export function createRpScenarioReviewedTemplatePack(
    input: unknown,
    trustedReviewManifest: unknown,
): RpScenarioReviewedTemplatePack {
    const snapshot = copyData(input);
    if (!Array.isArray(snapshot) || snapshot.length < 1 || snapshot.length > RP_SCENARIO_CATALOG_MAX_TEMPLATES) {
        reject('rp-template-input-invalid');
    }
    const entries = snapshot.map(reviewedCandidate).sort(compareTemplateIds);
    if (new Set(entries.map((entry) => entry.templateId)).size !== entries.length) reject('rp-template-duplicate');
    const manifest = record(copyData(trustedReviewManifest));
    exactKeys(manifest, ['manifestVersion', 'reviewRef', 'entries']);
    if (manifest.manifestVersion !== RP_SCENARIO_REVIEW_MANIFEST_VERSION) reject('rp-template-input-invalid');
    const reviewRef = boundedText(manifest.reviewRef, /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/);
    if (!Array.isArray(manifest.entries) || manifest.entries.length !== entries.length)
        reject('rp-template-declaration-drift');
    const reviewEntries = manifest.entries
        .map((entry) => {
            const value = record(entry);
            exactKeys(value, ['templateId', 'version', 'declarationDigest']);
            return {
                templateId: boundedText(value.templateId, new RegExp(TEMPLATE_ID_PATTERN)),
                version: boundedText(value.version, SEMANTIC_VERSION_PATTERN),
                declarationDigest: boundedText(value.declarationDigest, /^sha256:[a-f0-9]{64}$/),
            };
        })
        .sort(compareTemplateIds);
    const expected = entries.map((entry) => ({
        templateId: entry.templateId,
        version: entry.version,
        declarationDigest: digest(entry),
    }));
    if (!same(reviewEntries, expected)) reject('rp-template-declaration-drift');
    for (const entry of reviewEntries) {
        const fixedDigest = REVIEWED_DECLARATION_DIGESTS.get(`${entry.templateId}@${entry.version}`);
        if (fixedDigest && fixedDigest !== entry.declarationDigest) reject('rp-template-declaration-drift');
    }
    const data = {
        packVersion: RP_SCENARIO_REVIEWED_PACK_VERSION,
        reviewManifest: { manifestVersion: RP_SCENARIO_REVIEW_MANIFEST_VERSION, reviewRef, entries: reviewEntries },
        entries,
        authorityEffect: 'none' as const,
        runtimeBound: false as const,
    };
    const pack = freezeData({ ...data, packRevision: digest(data) });
    for (const entry of reviewEntries) {
        REVIEWED_DECLARATION_DIGESTS.set(`${entry.templateId}@${entry.version}`, entry.declarationDigest);
    }
    REVIEWED_PACKS.add(pack);
    return pack;
}

/** Literal review digests deliberately do not recompute themselves when a same-version declaration changes. */
export const RP_SCENARIO_DEFAULT_REVIEW_MANIFEST = freezeData({
    manifestVersion: RP_SCENARIO_REVIEW_MANIFEST_VERSION,
    reviewRef: 'review.p17-03.2a.character-only-analysis.v1',
    entries: [
        {
            templateId: 'rp.action-feasibility',
            version: '1.1.0',
            declarationDigest: 'sha256:97128e6fc3315a6fe9902806815ea5549474a897315fe1e198ff5d6d25737e41',
        },
        {
            templateId: 'rp.character-consistency',
            version: '1.1.0',
            declarationDigest: 'sha256:4170245bd39fbfface68e624c87695c3100b9384ab0f7f221243f119e56ac71c',
        },
        {
            templateId: 'rp.character-knowledge',
            version: '1.1.0',
            declarationDigest: 'sha256:832532a43d03f8b1efc8e15d0544497088a0bc6e75403fed4cba5b92efecc4d3',
        },
        {
            templateId: 'rp.clue-reasoning',
            version: '1.1.0',
            declarationDigest: 'sha256:5420f65194ea032ac83d73d5b9cdeb05771fea8f5533023e02f79690379d120c',
        },
        {
            templateId: 'rp.combat-tactics',
            version: '1.1.0',
            declarationDigest: 'sha256:05f7f4f6567cc0c53ce64fc4c23e3658c2eff5b53c40e16bee62b0fb8f0b9174',
        },
        {
            templateId: 'rp.continuity-causality',
            version: '1.1.0',
            declarationDigest: 'sha256:710495d6d88f69ce3f6d158c432615b353013ce4ac8a62e677f672581d860c88',
        },
        {
            templateId: 'rp.court-motivation',
            version: '1.1.0',
            declarationDigest: 'sha256:4f41222c858fb691400947b020532b8d9ce54f05830e122b22f2787cc9757471',
        },
        {
            templateId: 'rp.relationship-interaction',
            version: '1.1.0',
            declarationDigest: 'sha256:3e1ad8b0fe1606526781233388fcc04039e669d6b89f2086fd156100d03af4d9',
        },
    ],
} as const);

export const RP_SCENARIO_REVIEWED_PACK = createRpScenarioReviewedTemplatePack(
    RP_SCENARIO_TEMPLATES,
    RP_SCENARIO_DEFAULT_REVIEW_MANIFEST,
);

/** Pure candidate validation never registers reviewed membership or supplies execution authority. */
export function normalizeRpScenarioTemplateCandidate(input: unknown): RpScenarioTemplateV1 {
    return reviewedCandidate(copyData(input));
}

/** Registration checks exact reviewed membership independently of the extensible shared output schema. */
export function normalizeRpScenarioTemplate(
    input: unknown,
    reviewedPack: RpScenarioReviewedTemplatePack = RP_SCENARIO_REVIEWED_PACK,
): RpScenarioTemplateV1 {
    if (!REVIEWED_PACKS.has(reviewedPack)) reject('rp-template-input-invalid');
    const value = record(copyData(input));
    const expected = reviewedPack.entries.find((item) => item.templateId === value.templateId);
    if (!expected) reject('rp-template-unknown');
    assertDeclaration(value, expected);
    return expected;
}

/** Pure digest utility; callers still need catalog resolution to establish reviewed membership. */
export function rpScenarioTemplateDeclarationDigest(input: unknown): string {
    return digest(copyData(input));
}

/** Frozen catalog construction is a static registration operation, never execution approval. */
export function createRpScenarioTemplateCatalog(
    input: unknown = RP_SCENARIO_TEMPLATES,
    reviewedPack: RpScenarioReviewedTemplatePack = RP_SCENARIO_REVIEWED_PACK,
) {
    const snapshot = copyData(input);
    if (!Array.isArray(snapshot) || snapshot.length < 1 || snapshot.length > RP_SCENARIO_CATALOG_MAX_TEMPLATES) {
        reject('rp-template-input-invalid');
    }
    const entries = snapshot.map((entry) => normalizeRpScenarioTemplate(entry, reviewedPack)).sort(compareTemplateIds);
    if (new Set(entries.map((item) => item.templateId)).size !== entries.length) reject('rp-template-duplicate');
    const data = {
        catalogVersion: RP_SCENARIO_CATALOG_VERSION,
        reviewedPackRevision: reviewedPack.packRevision,
        entries,
        authorityEffect: 'none',
        runtimeBound: false,
    } as const;
    const catalog = freezeData({ ...data, catalogRevision: digest(data) });
    TEMPLATE_CATALOGS.add(catalog);
    return catalog;
}

/** Brand checks inspect no caller property, including for proxies and accessor-bearing forged catalogs. */
export function isRpScenarioTemplateCatalog(
    input: unknown,
): input is ReturnType<typeof createRpScenarioTemplateCatalog> {
    return TEMPLATE_CATALOGS.has(input as object);
}

/** A copied or self-declared catalog is not a construction-time reviewed registry. */
export function resolveRpScenarioTemplate(
    catalog: ReturnType<typeof createRpScenarioTemplateCatalog>,
    templateId: string,
    version: string,
    declarationDigest: string,
): RpScenarioTemplateV1 {
    if (!isRpScenarioTemplateCatalog(catalog)) reject('rp-template-input-invalid');
    boundedText(templateId, new RegExp(TEMPLATE_ID_PATTERN));
    boundedText(version, SEMANTIC_VERSION_PATTERN);
    boundedText(declarationDigest, /^sha256:[a-f0-9]{64}$/);
    const expected = catalog.entries.find((entry) => entry.templateId === templateId);
    if (!expected) reject('rp-template-unknown');
    if (expected.version !== version || digest(expected) !== declarationDigest) reject('rp-template-declaration-drift');
    return expected;
}

/** HC-1's non-runnable companion references the exact catalog declaration; it is not a new live Profile route. */
export function createRpScenarioHc1Index(
    input: unknown = RP_SCENARIO_TEMPLATES,
    reviewedPack: RpScenarioReviewedTemplatePack = RP_SCENARIO_REVIEWED_PACK,
) {
    const catalog = createRpScenarioTemplateCatalog(input, reviewedPack);
    const entries = catalog.entries.map((template) =>
        freezeData({
            contractId: `${template.templateId}@${template.version}`,
            templateId: template.templateId,
            templateVersion: template.version,
            declarationDigest: digest(template),
            declaration: template,
            taskContract: template.taskContract,
            actionContracts: template.actionContracts,
            outputContract: template.outputContract,
            verifierSet: template.verifierSet,
            executionProfileSnapshot: template.executionProfileSnapshot,
            executionProfileDigest: template.executionProfileDigest,
            components: {
                task: hc1Indexed(template.taskContract.ref),
                readAction: hc1Indexed(template.actionContracts[0]!.ref),
                outputSchema: hc1Indexed(template.outputContract.ref),
                verifierSet: hc1Indexed(template.verifierSet.ref),
                executionProfile: hc1Indexed(template.executionProfileSnapshot.profileRef),
                sourceLoader: hc1Pending('rp-source-loader-unbound', 'rp-character-source-loader-v1'),
                verifierImplementation: hc1Pending('rp-verifier-runner-unbound', template.verifierSet.ref),
                execution: hc1Pending('rp-execution-unbound', template.taskContract.ref),
            },
            wiring: {
                adapterRegistration: 'declaration-only',
                runtimeState: 'not-indexed',
                sourceLoader: 'pending',
                verifierImplementation: 'pending',
                execution: 'pending',
            },
            authorityEffect: 'none',
            runtimeStateIncluded: false,
            runtimeBound: false,
        } as const),
    );
    const data = {
        indexVersion: RP_SCENARIO_HC1_INDEX_VERSION,
        catalogRevision: catalog.catalogRevision,
        entries,
        authorityEffect: 'none',
        runtimeStateIncluded: false,
        runtimeBound: false,
    } as const;
    return freezeData({ ...data, indexRevision: digest(data) });
}

function hc1Indexed(ref: string) {
    return normalizeAgentContractComponentRef({
        state: 'indexed',
        coverage: 'complete',
        ref,
        evidenceRefs: [],
    });
}

function hc1Pending(reasonCode: string, nextContract: string) {
    return normalizeAgentContractComponentRef({
        state: 'pending',
        coverage: 'missing',
        reasonCode,
        nextContract,
        evidenceRefs: [],
    });
}

export const RP_SCENARIO_TEMPLATE_CATALOG = createRpScenarioTemplateCatalog();
