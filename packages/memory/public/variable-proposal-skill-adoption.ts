/** @author Codex @date 2026-10-28 @version 1.0 Public adoption ledger boundary. */
export {
    VARIABLE_PROPOSAL_SKILL_ADOPTION_PREFIX, VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION,
    MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_CHARS, MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_SCAN_LIMIT,
    VariableProposalSkillAdoptionStore, createVariableProposalAdoptionPatch,
    normalizeVariableProposalSkillAdoption, variableProposalSkillAdoptionKey,
} from '../src/variable-proposal-skill-adoption.ts';
export type {
    VariableProposalAdoptionPatch, VariableProposalSkillAdoption,
    VariableProposalSkillAdoptionEntry, VariableProposalSkillAdoptionScan,
} from '../src/variable-proposal-skill-adoption.ts';
