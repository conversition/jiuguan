/** Public Skill catalog surface for cross-workspace consumers. */
export {
  DEFAULT_SKILLS_DIR,
  listSkills,
  listSkillDocuments,
  matchSkills,
  skillScopeIdentityDigest,
  skillDocumentIdentityDigest,
  skillDocumentSnapshot,
  setSkillEnabledFromSnapshot,
  deleteSkillFromSnapshot,
  SkillDocumentRevisionConflictError,
} from '../src/skills.ts';
export type { SkillDocumentSnapshot } from '../src/skills.ts';
