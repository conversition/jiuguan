import type { SkillSourceInput } from '../../packages/harness/public/skill-fulfillment-plan.ts';

/** Optional host declaration. Model output and Session input cannot declare stages. */
export function bindSkillFulfillmentStages(skills: readonly SkillSourceInput[], raw: string | undefined): readonly SkillSourceInput[] {
  let declarations: unknown = [];
  if (raw !== undefined && raw.trim()) {
    if (raw.length > 65_536) throw new Error('skill-fulfillment-stage-config-invalid');
    try { declarations = JSON.parse(raw); } catch { throw new Error('skill-fulfillment-stage-config-invalid'); }
  }
  if (!Array.isArray(declarations) || declarations.length > 64) throw new Error('skill-fulfillment-stage-config-invalid');
  const byId = new Map<string, { skillId: string; version: string; bodyHash: string; stage: 'rewrite';
    dependsOn: string[]; sameStageWith: string[] }>();
  for (const value of declarations) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'bodyHash,dependsOn,sameStageWith,skillId,stage,version')
      throw new Error('skill-fulfillment-stage-config-invalid');
    const row = value as { skillId: unknown; version: unknown; bodyHash: unknown; stage: unknown;
      dependsOn: unknown; sameStageWith: unknown };
    if (typeof row.skillId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(row.skillId)
      || typeof row.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u.test(row.version)
      || typeof row.bodyHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.bodyHash) || row.stage !== 'rewrite'
      || !Array.isArray(row.dependsOn) || !Array.isArray(row.sameStageWith)
      || [...row.dependsOn, ...row.sameStageWith].some(item => typeof item !== 'string') || byId.has(row.skillId))
      throw new Error('skill-fulfillment-stage-config-invalid');
    byId.set(row.skillId, { skillId: row.skillId, version: row.version, bodyHash: row.bodyHash, stage: 'rewrite',
      dependsOn: [...row.dependsOn] as string[], sameStageWith: [...row.sameStageWith] as string[] });
  }
  return Object.freeze(skills.map(skill => {
    if (skill.stage !== undefined || skill.stageDeclared !== undefined || skill.dependsOn !== undefined || skill.sameStageWith !== undefined)
      throw new Error('skill-fulfillment-stage-source-invalid');
    const declaration = byId.get(skill.skillId);
    if (!declaration) return Object.freeze({ ...skill });
    if (declaration.version !== skill.version || declaration.bodyHash !== skill.bodyHash)
      throw new Error('skill-fulfillment-stage-source-stale');
    return Object.freeze({ ...skill, stage: 'rewrite' as const, stageDeclared: true,
      dependsOn: Object.freeze(declaration.dependsOn), sameStageWith: Object.freeze(declaration.sameStageWith) });
  }));
}
