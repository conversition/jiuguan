/** @author Codex @date 2026-10-17 @version 1.0
 * Replay-only D-Q3 adapter for one exact statically validated style Candidate.
 * It cannot mutate Candidate state, publish a Skill, or issue a replay/promotion verdict.
 */
import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_BODY_REQUEST_VERSION,
  AGENT_SKILL_PROGRAM_VERSION,
  computeAgentSkillBodyHash,
  createAgentSkillCatalogSnapshot,
  createAgentSkillHeader,
  exactAgentSkillTokens,
  normalizeAgentSkillBundle,
  normalizeAgentSkillCandidate,
  parseAgentSkillProgramBody,
  skillOperationalCandidateBindingDigest,
  type AgentSkillBodyRequestV1,
  type AgentSkillCandidateRefV1,
  type AgentSkillCatalogPort,
  type AgentSkillHeaderV1,
} from '@jiuguan/skill-hub';
import {
  AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
} from '@jiuguan/prompt/agent-skill-compiler';
import {
  AgentSkillCandidateStore,
  type StoredAgentSkillCandidate,
} from '../agent-skill-candidate-store.ts';
import {
  normalizeCandidateStaticValidationReceipt,
} from '../agent-skill-candidate-static-validator.ts';
import {
  SKILL_COMPILE_GOALS,
  SKILL_COMPILE_SPEC_VERSION,
  SKILL_COMPILE_TOOL_SCHEMA_DIGEST,
} from '../skill-compile-model.ts';
import { AgentSkillCandidateRuntime } from './candidate-runtime.ts';
import {
  CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME,
  createCandidateEvaluationValidatorAuthority,
} from './candidate-evaluation-validator.ts';
import { createServerBuiltinAgentSkillPack } from './builtin-source-pack.ts';
import {
  SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION,
  createServerAgentSkillProfilePolicyRegistry,
} from './profile-policy-registry.ts';
import {
  SERVER_AGENT_SKILL_PROMPT_CANDIDATE_BINDING_VERSION,
  type ServerAgentSkillPromptCandidateAuthorityPort,
  type ServerAgentSkillPromptCandidateBindingV1,
} from './prompt-consumer.ts';
import {
  SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION,
  createServerAgentSkillSourceAuthorityRegistry,
} from './source-authority-registry.ts';

export const SERVER_AGENT_SKILL_CANDIDATE_REPLAY_RELEASE =
  'validated-style-candidate-replay-v1.0.0' as const;
export const SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE =
  'validated-style-candidate-evaluation-v1.0.0' as const;

const PROFILE_ID = 'learning.styleCompile' as const;
const CANDIDATE_FAMILY = 'skill.candidate-replay' as const;
const VALIDATOR_FAMILY = 'skill.candidate-validator' as const;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_REVISION = /^skill-compile:[a-f0-9]{64}$/u;
const AUTHORITY_PROBE_CANDIDATE_ID = `sha256:${'0'.repeat(64)}`;

type CandidateReader = (candidateId: string) => StoredAgentSkillCandidate | null;

interface ValidatedReplayCandidate {
  readonly stored: StoredAgentSkillCandidate;
  readonly snapshot: string;
  readonly candidateBindingDigest: string;
}

interface ReplayProofEntry {
  readonly owner: object;
  readonly candidateId: string;
  readonly candidateSnapshot: string;
  readonly binding: ServerAgentSkillPromptCandidateBindingV1;
}

const REPLAY_PROOFS = new WeakMap<object, ReplayProofEntry>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(record[key])}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('candidate-replay-value-invalid');
  return encoded;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function frozen<T extends object>(value: T): Readonly<T> {
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) frozen(item as object);
  }
  return Object.freeze(value);
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((item, index) => item === expected[index]);
}

function candidateEvaluationValidator(): Readonly<{
  header: AgentSkillHeaderV1;
  body: string;
}> {
  const body = canonical({
    kind: 'validator',
    operations: [{
      args: { checkId: 'turn.schema', severityId: 'error' },
      primitiveId: 'validator.run-check',
    }],
    programVersion: AGENT_SKILL_PROGRAM_VERSION,
  });
  const seed = createAgentSkillHeader({
    manifestVersion: 'agent-skill-manifest-v1',
    skillId: 'host.validator.candidate-sample-envelope',
    version: '1.0.0',
    name: 'Host Candidate sample envelope validator',
    description: 'Validate one controlled Candidate sample response using the host-owned closed evaluator.',
    kind: 'validator',
    owner: 'host',
    capabilityIds: [PROFILE_ID],
    taskKinds: ['style_compile'],
    phases: ['learn'],
    contentModes: ['nsf'],
    scope: { kind: 'global' },
    riskTier: 'advisory',
    artifactKind: 'agent.candidate-sample-validation',
    requires: [],
    conflictsWith: [],
    desiredTools: [],
    writableArtifactKinds: [],
    limits: { maxModelCalls: 0, maxToolCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
    inputSchemaDigest: digest(['candidate-sample-provider-envelope', 1]),
    outputSchemaDigest: digest(['candidate-evaluation-validator-receipt', 1]),
    bodyHash: computeAgentSkillBodyHash(body),
    bodyTokens: exactAgentSkillTokens(body),
    sourceType: 'builtin',
    sourceHash: digest([SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE, body]),
    sourceRevision: SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE,
    provenanceDigest: digest([
      'host-code',
      SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE,
      'candidate.sample-envelope',
    ]),
    evaluatorId: 'evaluator.turn-schema',
    autoPromotion: false,
    priority: 900,
  });
  return Object.freeze({
    header: createAgentSkillHeader({
      ...seed.manifest,
      version: '1.0.0+' + seed.manifestDigest.slice('sha256:'.length),
    }),
    body,
  });
}

/**
 * Only a narrow compiled-style shape is replay-consumable. Static validation is necessary but
 * does not prove that a bundle originated from a real compiler job or make an arbitrary author
 * draft a replay source.
 */
function validatedReplayCandidate(input: StoredAgentSkillCandidate): ValidatedReplayCandidate {
  const candidate = normalizeAgentSkillCandidate(input.candidate);
  const bundle = normalizeAgentSkillBundle(input.bundle);
  const validation = input.validation === null
    ? null
    : normalizeCandidateStaticValidationReceipt(input.validation);
  const manifest = bundle.header.manifest;
  const program = parseAgentSkillProgramBody(bundle.body);
  if (candidate.state !== 'validated' || candidate.revision !== 1
    || candidate.validationEvidenceDigest === null
    || candidate.operationalReplayEvidenceDigest !== null
    || candidate.parentBundleDigest !== null
    || bundle.bundleDigest !== candidate.bundleDigest
    || canonical(bundle.header) !== canonical(candidate.header)
    || !validation || validation.passed !== true
    || validation.reasonCode !== 'candidate-static-validation-passed'
    || validation.candidateId !== candidate.candidateId
    || validation.bundleDigest !== candidate.bundleDigest
    || validation.expectedCandidateRevision !== 0
    || validation.evidenceDigest !== candidate.validationEvidenceDigest
    || validation.validatedAt !== candidate.updatedAt
    || validation.primitiveRegistryDigest !== AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST
    || program.kind !== 'style'
    || manifest.kind !== 'style' || manifest.owner !== 'author'
    || manifest.sourceType !== 'imported'
    || !/^author\.compiled\.[A-Za-z0-9]/u.test(manifest.skillId)
    || !exactStringSet(manifest.capabilityIds, [PROFILE_ID])
    || !exactStringSet(manifest.taskKinds, ['style_compile'])
    || !exactStringSet(manifest.phases, ['learn'])
    || !exactStringSet(manifest.contentModes, ['nsf'])
    || manifest.scope.kind !== 'global' || manifest.scope.selector !== undefined
    || manifest.riskTier !== 'advisory' || manifest.artifactKind !== 'style.override'
    || manifest.requires.length !== 0 || manifest.conflictsWith.length !== 0
    || manifest.conflictGroup !== undefined
    || manifest.desiredTools.length !== 0 || manifest.writableArtifactKinds.length !== 0
    || manifest.limits.maxModelCalls !== 0 || manifest.limits.maxToolCalls !== 0
    || manifest.limits.maxInputTokens !== 0 || manifest.limits.maxOutputTokens !== 0
    || manifest.inputSchemaDigest !== digest({
      specVersion: SKILL_COMPILE_SPEC_VERSION,
      goals: SKILL_COMPILE_GOALS,
    })
    || manifest.outputSchemaDigest !== SKILL_COMPILE_TOOL_SCHEMA_DIGEST
    || manifest.evaluatorId !== 'style-evaluator-v1'
    || manifest.autoPromotion !== false || manifest.priority !== 0
    || !SOURCE_REVISION.test(manifest.sourceRevision)) {
    throw new Error('agent-skill-candidate-replay-source-invalid');
  }
  const stored = frozen({ candidate, bundle, validation }) as StoredAgentSkillCandidate;
  return Object.freeze({
    stored,
    snapshot: canonical(stored),
    candidateBindingDigest: skillOperationalCandidateBindingDigest(candidate),
  });
}

function candidateReader(
  authority: AgentSkillCandidateStore | AgentSkillCandidateRuntime,
): CandidateReader {
  if (!(authority instanceof AgentSkillCandidateStore)
    && !(authority instanceof AgentSkillCandidateRuntime)) {
    throw new Error('agent-skill-candidate-replay-authority-invalid');
  }
  try {
    if (authority instanceof AgentSkillCandidateStore) {
      AgentSkillCandidateStore.prototype.jobStatus.call(authority);
    } else {
      AgentSkillCandidateRuntime.prototype.readCandidate.call(
        authority,
        AUTHORITY_PROBE_CANDIDATE_ID,
      );
    }
  } catch {
    throw new Error('agent-skill-candidate-replay-authority-invalid');
  }
  return (candidateId) => authority instanceof AgentSkillCandidateStore
    ? AgentSkillCandidateStore.prototype.readCandidate.call(authority, candidateId)
    : AgentSkillCandidateRuntime.prototype.readCandidate.call(authority, candidateId);
}

function requestSnapshot(input: AgentSkillBodyRequestV1): AgentSkillBodyRequestV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return null;
  const keys = [
    'requestVersion', 'catalogRevision', 'skillId', 'version', 'manifestDigest', 'bodyHash',
  ] as const;
  if (Reflect.ownKeys(input).length !== keys.length) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    output[key] = descriptor.value;
  }
  return output as unknown as AgentSkillBodyRequestV1;
}

function exactRequest(
  input: AgentSkillBodyRequestV1,
  catalogRevision: string,
  header: AgentSkillHeaderV1,
): boolean {
  const request = requestSnapshot(input);
  const manifest = header.manifest;
  return request !== null
    && request.requestVersion === AGENT_SKILL_BODY_REQUEST_VERSION
    && request.catalogRevision === catalogRevision
    && request.skillId === manifest.skillId
    && request.version === manifest.version
    && request.manifestDigest === header.manifestDigest
    && request.bodyHash === manifest.bodyHash;
}

/**
 * Build a replay-only Catalog/Profile/authority composition for one exact validated Candidate.
 * The factory and every subsequent Catalog/body/proof read fail closed when either the Candidate
 * snapshot changes or the host-controlled replay switch closes.
 */
type CandidateReplayPackInput = Readonly<{
  candidates: AgentSkillCandidateStore | AgentSkillCandidateRuntime;
  candidateId: string;
  replayAllowed(): boolean;
}>;

export async function createServerAgentSkillCandidateReplayPack(input: CandidateReplayPackInput) {
  return createCandidatePack(input, false);
}

/**
 * D-Q3a2a composition. It preserves the Candidate's zero-validator Style program and adds one
 * required host-builtin local Validator. The original replay factory above intentionally keeps
 * its D-Q3a1 empty-validator/not-required semantics.
 */
export async function createServerAgentSkillCandidateEvaluationPack(input: CandidateReplayPackInput) {
  return createCandidatePack(input, true);
}

async function createCandidatePack(input: CandidateReplayPackInput, evaluation: boolean) {
  if (!input || typeof input !== 'object') {
    throw new Error('agent-skill-candidate-replay-input-invalid');
  }
  const candidates = input.candidates;
  const candidateId = input.candidateId;
  const replayAllowed = input.replayAllowed;
  if (!HASH.test(candidateId) || typeof replayAllowed !== 'function') {
    throw new Error('agent-skill-candidate-replay-input-invalid');
  }
  const readCandidate = candidateReader(candidates);
  const requireAllowed = (): void => {
    let allowed = false;
    try { allowed = replayAllowed() === true; } catch { /* Closed on host switch failure. */ }
    if (!allowed) throw new Error('agent-skill-candidate-replay-disabled');
  };
  const readValidated = (): ValidatedReplayCandidate => {
    const stored = readCandidate(candidateId);
    if (!stored) throw new Error('agent-skill-candidate-replay-source-missing');
    return validatedReplayCandidate(stored);
  };

  requireAllowed();
  const candidateSource = readValidated();
  requireAllowed();
  const candidateCheck = readValidated();
  if (candidateCheck.snapshot !== candidateSource.snapshot) {
    throw new Error('agent-skill-candidate-replay-source-drift');
  }

  const builtin = createServerBuiltinAgentSkillPack();
  const builtinCatalog = await builtin.catalogPort.readCatalog();
  const foundations = builtinCatalog.headers.filter(({ manifest }) => (
    manifest.kind === 'foundation'
    && exactStringSet(manifest.capabilityIds, [PROFILE_ID])
    && exactStringSet(manifest.taskKinds, ['style_compile'])
    && exactStringSet(manifest.phases, ['learn'])
  ));
  if (foundations.length !== 1) {
    throw new Error('agent-skill-candidate-replay-foundation-invalid');
  }
  const foundation = foundations[0]!;
  const foundationBody = await builtin.catalogPort.loadBody({
    requestVersion: AGENT_SKILL_BODY_REQUEST_VERSION,
    catalogRevision: builtinCatalog.catalogRevision,
    skillId: foundation.manifest.skillId,
    version: foundation.manifest.version,
    manifestDigest: foundation.manifestDigest,
    bodyHash: foundation.manifest.bodyHash,
  });
  const candidateHeader = candidateSource.stored.bundle.header;
  const candidateBody = candidateSource.stored.bundle.body;
  const validator = evaluation ? candidateEvaluationValidator() : null;
  const catalog = createAgentSkillCatalogSnapshot([
    foundation,
    candidateHeader,
    ...(validator === null ? [] : [validator.header]),
  ]);

  const foundationAuthority = builtin.sourceAuthority.lookupExact({
    skillId: foundation.manifest.skillId,
    version: foundation.manifest.version,
    manifestDigest: foundation.manifestDigest,
    bodyHash: foundation.manifest.bodyHash,
    sourceHash: foundation.manifest.sourceHash,
    sourceRevision: foundation.manifest.sourceRevision,
  });
  if (!foundationAuthority || foundationAuthority.trustClass !== 'host-builtin') {
    throw new Error('agent-skill-candidate-replay-foundation-authority-invalid');
  }
  const candidateAuthority = {
    skillId: candidateHeader.manifest.skillId,
    version: candidateHeader.manifest.version,
    manifestDigest: candidateHeader.manifestDigest,
    bodyHash: candidateHeader.manifest.bodyHash,
    sourceHash: candidateHeader.manifest.sourceHash,
    sourceRevision: candidateHeader.manifest.sourceRevision,
    trustClass: 'validated-candidate' as const,
    evidenceDigest: digest({
      evidenceVersion: 'validated-candidate-source-v1',
      candidateBindingDigest: candidateSource.candidateBindingDigest,
      validationEvidenceDigest: candidateSource.stored.validation!.evidenceDigest,
      primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    }),
  };
  const validatorSourceAuthority = validator === null ? null : {
    skillId: validator.header.manifest.skillId,
    version: validator.header.manifest.version,
    manifestDigest: validator.header.manifestDigest,
    bodyHash: validator.header.manifest.bodyHash,
    sourceHash: validator.header.manifest.sourceHash,
    sourceRevision: validator.header.manifest.sourceRevision,
    trustClass: 'host-builtin' as const,
    evidenceDigest: digest([
      'host-code-release',
      SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE,
      validator.header.manifestDigest,
    ]),
  };
  const sourceAuthority = createServerAgentSkillSourceAuthorityRegistry({
    snapshotVersion: SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION,
    entries: [
      foundationAuthority,
      candidateAuthority,
      ...(validatorSourceAuthority === null ? [] : [validatorSourceAuthority]),
    ],
  });

  const contractFor = (header: AgentSkillHeaderV1) => Object.freeze({
    kind: header.manifest.kind,
    artifactKind: header.manifest.artifactKind,
    inputSchemaDigest: header.manifest.inputSchemaDigest,
    outputSchemaDigest: header.manifest.outputSchemaDigest,
    evaluatorId: header.manifest.evaluatorId,
    owner: header.manifest.owner,
    sourceType: header.manifest.sourceType,
  });
  const maxInstructionTokens = foundation.manifest.bodyTokens
    + candidateHeader.manifest.bodyTokens
    + (validator?.header.manifest.bodyTokens ?? 0);
  const validatorRule = validator === null ? [] : [{
    familyId: VALIDATOR_FAMILY,
    allowedContracts: [contractFor(validator.header)],
    allowAutoPromotion: false as const,
  }];
  const validatorEnrollment = validator === null ? [] : [{
    familyId: VALIDATOR_FAMILY,
    skillId: validator.header.manifest.skillId,
    version: validator.header.manifest.version,
    manifestDigest: validator.header.manifestDigest,
    required: true as const,
  }];
  const profileRegistry = createServerAgentSkillProfilePolicyRegistry([{
    policyVersion: SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION,
    profileId: PROFILE_ID,
    familyRules: [{
      familyId: 'skill.foundation',
      allowedContracts: [contractFor(foundation)],
      allowAutoPromotion: false,
    }, {
      familyId: CANDIDATE_FAMILY,
      allowedContracts: [contractFor(candidateHeader)],
      allowAutoPromotion: false,
    }, ...validatorRule],
    enrollments: [{
      familyId: 'skill.foundation', skillId: foundation.manifest.skillId,
      version: foundation.manifest.version, manifestDigest: foundation.manifestDigest, required: true,
    }, {
      familyId: CANDIDATE_FAMILY, skillId: candidateHeader.manifest.skillId,
      version: candidateHeader.manifest.version,
      manifestDigest: candidateHeader.manifestDigest, required: true,
    }, ...validatorEnrollment],
    maxSkills: evaluation ? 3 : 2,
    maxInstructionTokens,
    executionCeiling: {
      maxModelCalls: 0,
      maxToolCalls: evaluation ? 1 : 0,
      maxInputTokens: maxInstructionTokens,
      maxOutputTokens: 0,
    },
    maxRiskTier: 'advisory',
    allowedTools: evaluation ? [CANDIDATE_SAMPLE_ENVELOPE_TOOL_NAME] : [],
    allowedWritableArtifactKinds: [],
  }]);
  const profilePolicy = profileRegistry.byProfileId(PROFILE_ID);
  if (!profilePolicy) throw new Error('agent-skill-candidate-replay-profile-invalid');

  const assertCurrent = (): void => {
    requireAllowed();
    const first = readValidated();
    if (first.snapshot !== candidateSource.snapshot) {
      throw new Error('agent-skill-candidate-replay-source-drift');
    }
    requireAllowed();
    const second = readValidated();
    if (second.snapshot !== candidateSource.snapshot) {
      throw new Error('agent-skill-candidate-replay-source-drift');
    }
    requireAllowed();
  };
  const bodies = new Map<string, Readonly<{
    header: AgentSkillHeaderV1;
    body: string;
  }>>([
    [foundation.manifestDigest, Object.freeze({ header: foundation, body: foundationBody })],
    [candidateHeader.manifestDigest, Object.freeze({ header: candidateHeader, body: candidateBody })],
    ...(validator === null ? [] : [[
      validator.header.manifestDigest,
      Object.freeze({ header: validator.header, body: validator.body }),
    ]] as const),
  ]);
  const catalogPort: AgentSkillCatalogPort = Object.freeze({
    async readCatalog() {
      assertCurrent();
      const current = catalog;
      assertCurrent();
      return current;
    },
    async loadBody(request: AgentSkillBodyRequestV1) {
      assertCurrent();
      const snapshot = requestSnapshot(request);
      const entry = snapshot ? bodies.get(snapshot.manifestDigest) : undefined;
      if (!entry || !exactRequest(request, catalog.catalogRevision, entry.header)) {
        throw new Error('agent-skill-catalog-revision-stale');
      }
      const body = entry.body;
      assertCurrent();
      return body;
    },
  });

  const binding = frozen({
    bindingVersion: SERVER_AGENT_SKILL_PROMPT_CANDIDATE_BINDING_VERSION,
    candidateId: candidateSource.stored.candidate.candidateId,
    candidateRevision: 1 as const,
    candidateBindingDigest: candidateSource.candidateBindingDigest,
    manifestDigest: candidateHeader.manifestDigest,
    profileId: PROFILE_ID,
    profilePolicyRevision: profilePolicy.policyRevision,
    profileRegistryRevision: profileRegistry.registryRevision,
    sourceAuthorityRevision: sourceAuthority.authorityRevision,
  }) as ServerAgentSkillPromptCandidateBindingV1;
  const owner = Object.freeze({});
  const proof = Object.freeze({
    proofVersion: 'server-agent-skill-candidate-replay-proof-v1',
    candidateBindingDigest: candidateSource.candidateBindingDigest,
  });
  REPLAY_PROOFS.set(proof, Object.freeze({
    owner,
    candidateId,
    candidateSnapshot: candidateSource.snapshot,
    binding,
  }));
  const authority: ServerAgentSkillPromptCandidateAuthorityPort = Object.freeze({
    readCurrent(candidateProof: unknown): ServerAgentSkillPromptCandidateBindingV1 | null {
      if (!candidateProof || typeof candidateProof !== 'object') return null;
      const retained = REPLAY_PROOFS.get(candidateProof);
      if (!retained || retained.owner !== owner || retained.candidateId !== candidateId
        || retained.candidateSnapshot !== candidateSource.snapshot) return null;
      try {
        assertCurrent();
        return retained.binding;
      } catch { return null; }
    },
  });
  const selectionCandidateRef = Object.freeze({
    skillId: candidateHeader.manifest.skillId,
    version: candidateHeader.manifest.version,
    reasonCode: 'candidate.operational-replay',
    scoreBps: 10_000,
    evidenceDigest: candidateSource.candidateBindingDigest,
  }) satisfies AgentSkillCandidateRefV1;
  const validatorAuthority = evaluation
    ? createCandidateEvaluationValidatorAuthority({
      expectedCandidate: {
        candidateId: binding.candidateId,
        candidateRevision: binding.candidateRevision,
        candidateBindingDigest: binding.candidateBindingDigest,
        sourceAuthorityRevision: binding.sourceAuthorityRevision,
      },
      expectedValidatorPlanDigest: digest([{
        skillId: validator!.header.manifest.skillId,
        version: validator!.header.manifest.version,
        manifestDigest: validator!.header.manifestDigest,
        evaluatorId: validator!.header.manifest.evaluatorId,
        checkId: 'turn.schema',
        severityId: 'error',
        entryDigest: digest({
          skillId: validator!.header.manifest.skillId,
          version: validator!.header.manifest.version,
          manifestDigest: validator!.header.manifestDigest,
          evaluatorId: validator!.header.manifest.evaluatorId,
          checkId: 'turn.schema',
          severityId: 'error',
        }),
      }]),
      isCurrent: () => {
        try {
          assertCurrent();
          return authority.readCurrent(proof) !== null;
        } catch { return false; }
      },
    })
    : null;

  assertCurrent();
  const common = {
    release: evaluation
      ? SERVER_AGENT_SKILL_CANDIDATE_EVALUATION_RELEASE
      : SERVER_AGENT_SKILL_CANDIDATE_REPLAY_RELEASE,
    candidateId: candidateSource.stored.candidate.candidateId,
    catalogPort,
    sourceAuthority,
    profileRegistry,
    selectionCandidateRef,
    candidateBinding: Object.freeze({ authority, proof }),
  };
  return evaluation && validator !== null
    ? Object.freeze({
      ...common,
      validatorExplicit: Object.freeze({
        skillId: validator.header.manifest.skillId,
        version: validator.header.manifest.version,
      }),
      validatorManifestDigest: validator.header.manifestDigest,
      validatorAuthority: validatorAuthority!,
    })
    : Object.freeze(common);
}
