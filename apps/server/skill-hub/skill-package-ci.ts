/** P17-04.5: deterministic, offline package CI and a body-free registry projection.
 * No Provider, filesystem, publication, enrollment or production admission side effects. */
import { createHash } from 'node:crypto';
import { fromJSONSchema } from 'zod';
import { normalizeAgentSkillPackageV2, type AgentSkillContentMode, type AgentSkillPackageV2 } from '@jiuguan/skill-hub';
import {
  AGENT_SKILL_COMPILER_REVISION, AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST, AGENT_SKILL_PROGRAM_JSON_SCHEMA,
  assessAgentSkillProgramCompatibility, compileAgentSkillPrograms, verifyCompiledAgentSkillArtifact,
} from '@jiuguan/prompt/agent-skill-compiler';
import {
  AGENT_SKILL_CONSUMER_PROFILES, type AgentSkillConsumerProfileV1,
} from '../../../packages/agent-policy/public/agent-skill-contract-index.ts';
import { canonicalFixture, fixtureHash, skillPackageSetReplayFixture } from './offline-package-replay.ts';

export interface SkillPackageReplayExample {
  readonly id: string;
  readonly contentMode: AgentSkillContentMode;
  readonly instructionTokenBudget: number;
  readonly expectedPromptDigest: string;
}
export interface SkillPackageCiInput {
  readonly package: AgentSkillPackageV2;
  /** Exact package-relative bytes, including the compiled body and every attachment. */
  readonly resourceBytes: ReadonlyMap<string, Uint8Array>;
  readonly examples: readonly SkillPackageReplayExample[];
}
export interface SkillPackageModelTarget {
  readonly modelId: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
}
const schema = fromJSONSchema(JSON.parse(JSON.stringify(AGENT_SKILL_PROGRAM_JSON_SCHEMA)));
const programSchemaDigest = fixtureHash(canonicalFixture(AGENT_SKILL_PROGRAM_JSON_SCHEMA));
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const risk = { advisory: 0, proposal: 1, write: 2 } as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(code: string): never { throw new TypeError(`skill-package-ci:${code}`); }
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`);
}

export function verifySkillPackageCi(input: SkillPackageCiInput, inventory: readonly AgentSkillPackageV2[] = [input.package]) {
  // Revalidate nested headers and all digests, rather than trusting TypeScript or a supplied receipt.
  const pkg = normalizeAgentSkillPackageV2(input.package);
  if (input.package.packageDigest !== pkg.packageDigest) fail('package-digest-required');
  const manifest = pkg.bundle.header.manifest;
  if (!(input.resourceBytes instanceof Map) || input.resourceBytes.size !== pkg.resources.length) fail('resource-set-mismatch');
  for (const resource of pkg.resources) {
    const bytes = input.resourceBytes.get(resource.path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== resource.bytes || digest(bytes) !== resource.sha256) {
      fail(`resource-bytes-mismatch:${resource.path}`);
    }
    if (resource.role === 'body' && !Buffer.from(bytes).equals(Buffer.from(pkg.bundle.body, 'utf8'))) fail('body-bytes-mismatch');
    if (resource.role === 'schema') {
      try {
        const text = Buffer.from(bytes).toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) fail('schema-encoding-invalid');
        fromJSONSchema(JSON.parse(text));
      } catch { fail(`resource-schema-invalid:${resource.path}`); }
    }
  }
  const compatibility = assessAgentSkillProgramCompatibility(pkg.bundle.body, manifest.kind);
  if (compatibility.status !== 'compatible') fail(compatibility.reasonCode ?? 'program-invalid');
  if (!schema.safeParse(JSON.parse(pkg.bundle.body)).success) fail('program-schema-invalid');
  if (pkg.acceptance.inputSchemaRef !== manifest.inputSchemaDigest
    || pkg.acceptance.outputSchemaRef !== manifest.outputSchemaDigest) fail('io-schema-binding-mismatch');
  if (!Array.isArray(input.examples) || input.examples.length < 1 || input.examples.length > 64) fail('examples-required');
  unique(input.examples.map(example => example.id), 'example');
  const packageRef = (item: AgentSkillPackageV2) => `${item.bundle.header.manifest.skillId}@${item.bundle.header.manifest.version}`;
  const catalog = new Map(inventory.map(item => [packageRef(item), normalizeAgentSkillPackageV2(item)]));
  if (catalog.size !== inventory.length) fail('duplicate-package-version');
  if (catalog.get(packageRef(pkg))?.packageDigest !== pkg.packageDigest) fail('inventory-package-mismatch');
  const closure = new Map<string, AgentSkillPackageV2>(), visiting = new Set<string>();
  const include = (item: AgentSkillPackageV2): void => {
    const key = packageRef(item);
    if (visiting.has(key)) fail(`dependency-cycle:${key}`);
    if (closure.has(key)) return;
    visiting.add(key); closure.set(key, item);
    for (const dep of item.bundle.header.manifest.requires) {
      const key = `${dep.skillId}@${dep.version}`, target = catalog.get(key);
      if (!target) fail(`dependency-missing:${key}`);
      if (target.release.state === 'retired') fail(`dependency-retired:${key}`);
      include(target);
    }
    visiting.delete(key);
  };
  include(pkg);
  const examples = input.examples.map(example => {
    if (!TOKEN.test(example.id) || !DIGEST.test(example.expectedPromptDigest)) fail('example-identity-invalid');
    if (!manifest.contentModes.includes(example.contentMode)) fail('example-content-mode-mismatch');
    const request = skillPackageSetReplayFixture([...closure.values()], example.contentMode, example.instructionTokenBudget);
    const compiled = compileAgentSkillPrograms(request);
    const promptDigest = fixtureHash(compiled.promptInstruction);
    if (promptDigest !== example.expectedPromptDigest) fail(`example-output-mismatch:${example.id}`);
    verifyCompiledAgentSkillArtifact(compiled, request);
    return { id: example.id, contentMode: example.contentMode, instructionTokenBudget: example.instructionTokenBudget,
      promptTokens: compiled.promptTokens, promptDigest, compiledArtifactDigest: compiled.compiledArtifactDigest };
  }).sort((a, b) => compare(a.id, b.id));
  if (manifest.contentModes.some(mode => !examples.some(example => example.contentMode === mode))) fail('example-content-mode-uncovered');
  const completedChecks = new Set(['static:package.integrity.v1', 'static:package.resources.v1',
    'static:program.schema.v1', 'replay:package.replay.v1', ...examples.map(example => `replay:${example.id}`)]);
  for (const check of pkg.acceptance.checks) {
    if (check.required && !completedChecks.has(`${check.kind}:${check.ref}`)) fail(`required-check-unavailable:${check.ref}`);
  }
  const receipt = { receiptVersion: 'skill-package-ci-v1' as const, packageDigest: pkg.packageDigest,
    compilerRevision: AGENT_SKILL_COMPILER_REVISION, primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    programSchemaDigest, checks: ['package.integrity.v1', 'package.resources.v1', 'program.schema.v1', 'package.replay.v1'],
    examples, environment: 'offline-fixture' as const };
  return freeze({ ...receipt, receiptDigest: fixtureHash(canonicalFixture(receipt)) });
}
export type SkillPackageCiReceipt = ReturnType<typeof verifySkillPackageCi>;

function agentSupport(pkg: AgentSkillPackageV2, profiles: readonly AgentSkillConsumerProfileV1[]) {
  const m = pkg.bundle.header.manifest;
  return profiles.map(profile => {
    const taskKinds = m.taskKinds.filter(kind => profile.taskKinds.includes(kind));
    const phases = m.phases.filter(phase => profile.phases.includes(phase));
    const contentModes = m.contentModes.filter(mode => profile.contentModes.includes(mode));
    const reasons = [!m.capabilityIds.includes(profile.capabilityId) && 'capability-mismatch',
      taskKinds.length === 0 && 'task-mismatch', phases.length === 0 && 'phase-mismatch',
      contentModes.length === 0 && 'content-mode-mismatch', risk[m.riskTier] > risk[profile.maxRiskTier] && 'risk-exceeded',
    ].filter((value): value is string => typeof value === 'string');
    return { profileId: profile.profileId, profileDigest: fixtureHash(canonicalFixture(profile)),
      status: reasons.length === 0 ? 'contract-match' as const : 'contract-mismatch' as const,
      reasons, taskKinds, phases, contentModes, runtimeBound: profile.runtimeBound,
      policyVersionIncludes: profile.policyVersionIncludes, policyVersionExcludes: profile.policyVersionExcludes };
  }).sort((a, b) => compare(a.profileId, b.profileId));
}

/** Input is a complete exact-version inventory, never an implicit "latest" lookup. */
export function buildSkillPackageRegistry(
  inputs: readonly SkillPackageCiInput[],
  options: Readonly<{ profiles?: readonly AgentSkillConsumerProfileV1[]; models?: readonly SkillPackageModelTarget[] }> = {},
) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 512) fail('inventory-size-invalid');
  const profiles = options.profiles ?? AGENT_SKILL_CONSUMER_PROFILES;
  const models = options.models ?? [];
  unique(profiles.map(profile => profile.profileId), 'profile');
  unique(models.map(model => model.modelId), 'model');
  for (const model of models) {
    if (!TOKEN.test(model.modelId) || !Number.isSafeInteger(model.contextTokens) || model.contextTokens < 1
      || model.contextTokens > 10_000_000 || !Number.isSafeInteger(model.maxOutputTokens)
      || model.maxOutputTokens < 1 || model.maxOutputTokens > model.contextTokens) fail('model-target-invalid');
  }
  const checked = inputs.map(input => ({ pkg: normalizeAgentSkillPackageV2(input.package), input }));
  const ref = (pkg: AgentSkillPackageV2) => `${pkg.bundle.header.manifest.skillId}@${pkg.bundle.header.manifest.version}`;
  unique(checked.map(item => ref(item.pkg)), 'package-version');
  const byRef = new Map(checked.map(item => [ref(item.pkg), item]));
  const dependencies = new Map<string, string[]>(), replacements = new Map<string, string[]>();
  for (const { pkg } of checked) {
    const own = ref(pkg);
    const requires = pkg.bundle.header.manifest.requires.map(dep => `${dep.skillId}@${dep.version}`);
    for (const target of requires) {
      if (!byRef.has(target)) fail(`dependency-missing:${target}`);
      if (byRef.get(target)!.pkg.release.state === 'retired') fail(`dependency-retired:${target}`);
    }
    dependencies.set(own, requires);
    const target = pkg.release.replacementRef;
    if (target !== undefined && !byRef.has(target)) fail(`replacement-missing:${target}`);
    if (target !== undefined && byRef.get(target)!.pkg.release.state === 'retired') fail(`replacement-retired:${target}`);
    replacements.set(own, target === undefined ? [] : [target]);
  }
  for (const [label, graph] of [['dependency', dependencies], ['replacement', replacements]] as const) {
    const done = new Set<string>(), active = new Set<string>();
    const visit = (key: string): void => {
      if (active.has(key)) fail(`${label}-cycle:${key}`);
      if (done.has(key)) return;
      active.add(key);
      for (const target of graph.get(key)!) visit(target);
      active.delete(key); done.add(key);
    };
    for (const key of graph.keys()) visit(key);
  }
  const packages = checked.map(item => item.pkg);
  const entries = checked.map(({ pkg, input }) => {
    const ci = verifySkillPackageCi(input, packages);
    const m = pkg.bundle.header.manifest, policy = pkg.environment.modelPolicy;
    const maxPromptTokens = Math.max(...ci.examples.map(example => example.promptTokens));
    const modelMatrix = models.map(model => {
      const reasons = [policy.mode === 'allowlist' && !policy.allowedModelIds.includes(model.modelId) && 'model-not-allowed',
        model.contextTokens < Math.max(policy.minContextTokens, maxPromptTokens + policy.maxOutputTokens) && 'context-insufficient',
        model.maxOutputTokens < policy.maxOutputTokens && 'output-capacity-insufficient',
      ].filter((value): value is string => typeof value === 'string');
      return { modelId: model.modelId, contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens,
        status: reasons.length === 0 ? 'declared-compatible' : 'incompatible', reasons };
    }).sort((a, b) => compare(a.modelId, b.modelId));
    return { packageRef: ref(pkg), packageDigest: pkg.packageDigest, manifestDigest: pkg.bundle.header.manifestDigest,
      skillId: m.skillId, version: m.version, name: m.name, kind: m.kind, owner: m.owner, ownerRef: pkg.ownerRef,
      dependencies: m.requires, conflictsWith: m.conflictsWith, scope: m.scope,
      permissions: { riskTier: m.riskTier, desiredTools: m.desiredTools, writableArtifactKinds: m.writableArtifactKinds,
        limits: m.limits, autoPromotion: m.autoPromotion }, resources: pkg.resources,
      environment: pkg.environment, acceptance: pkg.acceptance, tests: ci,
      support: { capabilityIds: m.capabilityIds, taskKinds: m.taskKinds, phases: m.phases, contentModes: m.contentModes,
        agents: agentSupport(pkg, profiles), modelMatrix, admission: 'not-evaluated' as const, providerEvidence: 'not-evaluated' as const },
      release: pkg.release,
      replacement: pkg.release.replacementRef === undefined ? null : {
        packageRef: pkg.release.replacementRef, packageDigest: byRef.get(pkg.release.replacementRef)!.pkg.packageDigest },
      effect: { ...pkg.effect, passRate: pkg.effect.sampleCount === 0 ? null : pkg.effect.passCount / pkg.effect.sampleCount,
        basis: 'package-declared' as const, qualityVerified: false as const } };
  }).sort((a, b) => compare(a.packageRef, b.packageRef));
  const registry = { registryVersion: 'skill-package-registry-v1' as const, executionAuthority: false as const,
    compilerRevision: AGENT_SKILL_COMPILER_REVISION, primitiveRegistryDigest: AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
    entries };
  return freeze({ ...registry, registryDigest: fixtureHash(canonicalFixture(registry)) });
}
