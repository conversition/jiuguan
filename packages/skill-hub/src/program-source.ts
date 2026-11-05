/** Frozen source mapping and deterministic extraction; no file I/O or execution. */
import { deepFreeze } from './internal.ts';
import { AGENT_SKILL_PROGRAM_VERSION } from './consumption.ts';
import { AGENT_SKILL_PACKAGE_V2_VERSION } from './package-v2.ts';

export const AGENT_SKILL_PROGRAM_SOURCE_CONTRACT = deepFreeze({
  sourceVersion: 'agent-skill-program-source-v1',
  programVersion: AGENT_SKILL_PROGRAM_VERSION,
  packageVersion: AGENT_SKILL_PACKAGE_V2_VERSION,
  forms: {
    canonicalBody: { encoding: 'exact-canonical-json', bodyPath: 'SKILL.md' },
    markdownProgram: { fence: 'agent-skill-program-v1', blocks: 1,
      outside: 'whitespace-only', encoding: 'exact-canonical-json', bodyPath: 'program.json' },
    explicitProgram: { path: 'program.json', encoding: 'exact-canonical-json', bodyPath: 'program.json' },
  },
  simultaneousSources: 'reject',
  programSourceBinding: 'exact-original-document-digest-and-all-resource-hashes',
  originalDocumentRoleAfterExtraction: 'reference',
  mappings: [
    { source: 'instruction', target: 'registered-operation', rule: 'explicit-primitive-and-typed-arguments-only',
      invalidReason: 'instruction-unmapped' },
    { source: 'template', target: 'template', rule: 'hashed-data-no-interpolation-or-system-injection',
      invalidReason: 'template-expansion-unsupported' },
    { source: 'example', target: 'sample', rule: 'hashed-example-not-business-fact-or-authority',
      invalidReason: 'example-authority-unsupported' },
    { source: 'reference', target: 'reference', rule: 'package-local-hashed-data-no-implicit-read-or-fetch',
      invalidReason: 'reference-expansion-unsupported' },
    { source: 'script', target: 'reference', rule: 'hashed-source-data-no-execution',
      invalidReason: 'script-execution-unsupported' },
  ],
  sourceInvalidReasons: ['markdown-unmapped-content', 'program-source-conflict', 'program-source-missing',
    'resource-binding-invalid'] as const,
  inheritedAuthority: ['capabilityIds', 'taskKinds', 'phases', 'contentModes', 'scope', 'riskTier',
    'desiredTools', 'writableArtifactKinds', 'limits'],
  inferredAuthority: false,
  inferredLifecycle: false,
  inferredBusinessFacts: false,
  releaseState: 'draft',
  grantsExecution: false,
  fallback: false,
});

export type AgentSkillProgramSourceForm = 'canonical-body' | 'markdown-program' | 'explicit-program';
export type AgentSkillProgramSourceInvalidReason =
  typeof AGENT_SKILL_PROGRAM_SOURCE_CONTRACT.sourceInvalidReasons[number];
export type AgentSkillProgramSourceResolution = Readonly<
  | { status: 'resolved'; form: AgentSkillProgramSourceForm; body: string; bodyPath: 'SKILL.md' | 'program.json' }
  | { status: 'legacy' }
  | { status: 'invalid'; reasonCode: AgentSkillProgramSourceInvalidReason }
>;

/** Extraction only. The original compiler must still validate canonical bytes and primitives.
 * A sidecar is an explicitly authored replacement, never proof of semantic equivalence to prose. */
export function resolveAgentSkillProgramSource(
  body: string,
  explicitProgram?: string,
): AgentSkillProgramSourceResolution {
  const canonicalCandidate = body.trimStart().startsWith('{');
  const marker = '```agent-skill-program-v1';
  const hasFence = body.includes(marker);
  const invalid = (reasonCode: AgentSkillProgramSourceInvalidReason) =>
    Object.freeze({ status: 'invalid' as const, reasonCode });
  if (explicitProgram !== undefined) {
    if (canonicalCandidate || hasFence) return invalid('program-source-conflict');
    if (explicitProgram.length === 0) return invalid('program-source-missing');
    return Object.freeze({ status: 'resolved', form: 'explicit-program', body: explicitProgram, bodyPath: 'program.json' });
  }
  if (hasFence) {
    if (canonicalCandidate || body.split(marker).length !== 2) return invalid('program-source-conflict');
    const match = /^\s*```agent-skill-program-v1\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(body);
    if (!match) return invalid('markdown-unmapped-content');
    if (match[1]!.length === 0) return invalid('program-source-missing');
    return Object.freeze({ status: 'resolved', form: 'markdown-program', body: match[1]!, bodyPath: 'program.json' });
  }
  return canonicalCandidate
    ? Object.freeze({ status: 'resolved', form: 'canonical-body', body, bodyPath: 'SKILL.md' })
    : Object.freeze({ status: 'legacy' });
}
