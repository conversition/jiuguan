/** P17-04.3: deterministic source extraction and immutable resource binding. */
import {
  AGENT_SKILL_PROGRAM_SOURCE_CONTRACT,
  AGENT_SKILL_RESOURCE_ROLES,
  resolveAgentSkillProgramSource,
  type AgentSkillProgramSourceForm,
  type AgentSkillProgramSourceInvalidReason,
  type AgentSkillResourceV1,
} from '@jiuguan/skill-hub';
import { createHash } from 'node:crypto';
import { skillDocumentIdentityDigest, skillDocumentSnapshot } from '../../../packages/core/public/skills.ts';
import type { MigratableSkillDocument } from './legacy-package-migrator.ts';

export interface SkillProgramSourceBinding {
  readonly sourceVersion: string;
  readonly form: AgentSkillProgramSourceForm;
  readonly documentIdentityDigest: string;
  readonly declaredSourceHash: string | null;
  /** The original SKILL.md file (when present), not its stripped program body. */
  readonly resources: readonly AgentSkillResourceV1[];
  readonly programBodyHash: string;
}
export type PreparedSkillProgramMigration = Readonly<
  | { status: 'legacy' }
  | { status: 'invalid'; reasonCode: AgentSkillProgramSourceInvalidReason }
  | { status: 'ready'; body: string; sourceHash: string;
      resources: readonly AgentSkillResourceV1[]; sourceBinding: SkillProgramSourceBinding }
>;

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function resource(path: string, role: AgentSkillResourceV1['role'], mediaType: string, text: string): AgentSkillResourceV1 {
  return Object.freeze({ path, role, mediaType, bytes: Buffer.byteLength(text, 'utf8'), sha256: hash(text) });
}
function comparePath(a: AgentSkillResourceV1, b: AgentSkillResourceV1): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function matches(value: AgentSkillResourceV1 | undefined, text: string): boolean {
  return value?.sha256 === hash(text) && value.bytes === Buffer.byteLength(text, 'utf8');
}
const invalid = (reasonCode: AgentSkillProgramSourceInvalidReason): PreparedSkillProgramMigration =>
  Object.freeze({ status: 'invalid', reasonCode });

export function prepareSkillProgramMigration(document: MigratableSkillDocument): PreparedSkillProgramMigration {
  const original = document.resources;
  if (original.some(item => item.path === 'program.json') && document.explicitProgram === undefined) {
    return invalid('program-source-missing');
  }
  const source = resolveAgentSkillProgramSource(document.record.body, document.explicitProgram);
  if (source.status !== 'resolved') return source;
  // Validate the supplied ledger before deriving a new manifest. Never heal a mismatched hash.
  const paths = new Set<string>();
  if (original.length < 1 || original.length > 256 || original.some(item => {
    const path = item.path.toLowerCase();
    const bad = paths.has(path) || item.path.length > 512 || /[\\:\u0000]/u.test(item.path)
      || item.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || !AGENT_SKILL_RESOURCE_ROLES.includes(item.role) || !/^sha256:[a-f0-9]{64}$/u.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 16 * 1024 * 1024
      || (path === 'program.json' && item.path !== 'program.json');
    paths.add(path);
    return bad;
  })) return invalid('resource-binding-invalid');
  const bodyResource = original.find(item => item.path === 'SKILL.md');
  if (original.filter(item => item.role === 'body').length !== 1 || bodyResource?.role !== 'body'
    || !matches(bodyResource, document.record.body)
    || !/^sha256:[a-f0-9]{64}$/u.test(document.documentIdentityDigest)
    || (document.record.documentIdentityDigest !== undefined
      && document.record.documentIdentityDigest !== document.documentIdentityDigest)) return invalid('resource-binding-invalid');
  if (document.originalDocument !== undefined) {
    if (skillDocumentIdentityDigest(document.originalDocument) !== document.documentIdentityDigest
      || skillDocumentSnapshot(document.directory, 'SKILL.md', document.originalDocument).body !== document.record.body) {
      return invalid('resource-binding-invalid');
    }
  } else if (source.form !== 'canonical-body') return invalid('resource-binding-invalid');
  if (document.explicitProgram !== undefined && !matches(original.find(item => item.path === 'program.json'), document.explicitProgram)) {
    return invalid('resource-binding-invalid');
  }

  // Keep all source bytes in the ledger. Scripts, references and examples remain inert data.
  const sourceResources = original.map(item => item.path === 'SKILL.md' && document.originalDocument !== undefined
    ? resource('SKILL.md', 'reference', 'text/markdown', document.originalDocument)
    : Object.freeze({ path: item.path, role: item.role, mediaType: item.mediaType, bytes: item.bytes, sha256: item.sha256 }))
    .sort(comparePath);
  const resources = source.form === 'canonical-body' ? original.map(item => Object.freeze({ ...item }))
    : sourceResources.filter(item => item.path !== 'program.json').concat(resource('program.json', 'body', 'application/json', source.body));
  if (resources.length > 256) return invalid('resource-binding-invalid');
  const sourceBinding: SkillProgramSourceBinding = Object.freeze({
    sourceVersion: AGENT_SKILL_PROGRAM_SOURCE_CONTRACT.sourceVersion,
    form: source.form,
    documentIdentityDigest: document.documentIdentityDigest,
    declaredSourceHash: document.record.sourceHash ?? null,
    resources: Object.freeze(sourceResources),
    programBodyHash: hash(source.body),
  });
  return Object.freeze({ status: 'ready', body: source.body,
    sourceHash: hash(JSON.stringify(sourceBinding)), sourceBinding,
    resources: Object.freeze(resources.sort(comparePath)) });
}
