/** Source-level static contract for migration CLIs; no dist bootstrap or execution authority. */
export {
  AGENT_SKILL_COMPILER_REVISION,
  AGENT_SKILL_PRIMITIVE_REGISTRY_DIGEST,
  AGENT_SKILL_PROGRAM_JSON_SCHEMA,
  AGENT_SKILL_PROGRAM_INVALID_REASONS,
  assessAgentSkillProgramCompatibility,
} from '../src/agent-skill-compiler.ts';
export type { AgentSkillProgramCompatibility, AgentSkillProgramInvalidReason } from '../src/agent-skill-compiler.ts';
