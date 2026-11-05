/**
 * Narrow source-level NPC maintenance boundary for workspace integration tests.
 * Runtime packages consume @jiuguan/agent-policy after build; source-mode tests
 * must not depend on ignored dist artifacts or private package source paths.
 */
export { NPC_APPLY_POLICY_VERSION } from '../src/npc-apply-policy.ts';
export { normalizeNpcMaintenanceProposal } from '../src/npc-maintenance-proposal.ts';
