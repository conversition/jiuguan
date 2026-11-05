/** @author Codex @date 2026-10-14 @version 1.0
 * Existing proposal-level automatic-write policy; runtime authorization remains a separate host boundary.
 */
import type { MaintenanceProposal } from './maintenance-types.ts';

export function maintenanceProposalAutoApplyEligible(proposal: MaintenanceProposal): boolean {
    if (proposal.taskKind === 'rolling_summary') return true;
    if (proposal.taskKind !== 'memory_consolidation') return false;
    const facts = proposal.payload.facts;
    return Array.isArray(facts) && facts.length > 0 && facts.every((candidate) => (
        candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        && (candidate as { status?: unknown }).status === 'confirmed'
        && (candidate as { confidence?: unknown }).confidence === 'high'
    ));
}
