import { hasRetainedBranchModifiedEvidence } from './skill-hub/branch-modified-evidence.ts';
import { hasRetainedVariableInvalidationEvidence } from './skill-hub/variable-invalidation-evidence.ts';
import { hasRetainedReportedEffects } from './skill-hub/reported-effect-evidence.ts';
import { hasRetainedBranchAttributionEvidence } from './skill-hub/branch-attribution-evidence.ts';
import { hasRetainedPreferenceInferenceEvidence } from './skill-hub/preference-inference-evidence.ts';
import { hasRetainedAqlAdvisoryEvidence } from './skill-hub/aql-advisory-evidence.ts';
import { hasRetainedWorldbookApplyEvidence } from './skill-hub/worldbook-apply-evidence.ts';
/** @author Codex @date 2026-10-16 @version 1.0
 * Optional metadata composition; discover retained receipts without opening Session or a Provider.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentEvidenceLedger, AGENT_EVIDENCE_DB_FILE } from './agent-evidence-ledger.ts';
import { hasRetainedExplicitPreferenceEvidence } from './explicit-preference-evidence-source.ts';
import { hasRetainedClosureSkillEvidence } from './closure-skill-evidence-source.ts';
import { hasRetainedMaintenanceMemoryEvidence } from './maintenance-memory-evidence-source.ts';
import { hasRetainedMaintenanceSummaryEvidence } from './maintenance-summary-evidence-source.ts';
import { hasRetainedMaintenanceProposalRejections } from './skill-hub/maintenance-proposal-rejection-evidence.ts';
import { hasRetainedMaintenanceProposalApprovals } from './skill-hub/maintenance-proposal-approval-evidence.ts';
import { hasRetainedRegenerationEvidence } from './regeneration-evidence-source.ts';
import { hasRetainedStyleCompileAdoptionEvidence } from './skill-hub/style-compile-adoption-evidence.ts';
import { hasRetainedVariableApplyEvidence } from './skill-hub/variable-apply-evidence.ts';
import { hasRetainedNsfwSceneEvidence } from './skill-hub/nsfw-scene-evidence.ts';
import { hasRetainedArcCommitEvidence } from './skill-hub/arc-commit-evidence.ts';
import { hasRetainedNpcOperationEvidence } from './skill-hub/npc-operation-evidence.ts';


export function openAgentEvidenceRuntime(input: {
    readonly dataDir: string;
    readonly recordingEnabled: boolean;
    resolveSession(fileName: string): string | null;
    isSessionDeleted(rawSessionId: string): boolean;
    onFailure?(code: 'source-discovery-pending' | 'ledger-open-failed'): void;
}): AgentEvidenceLedger | null {
    const warn = (code: 'source-discovery-pending' | 'ledger-open-failed'): void => {
        try { input.onFailure?.(code); } catch { /* Optional diagnostics cannot become startup authority. */ }
    };
    try {
        let needed = input.recordingEnabled || existsSync(join(input.dataDir, AGENT_EVIDENCE_DB_FILE));
        if (!needed) {
            try { needed = hasRetainedMaintenanceProposalRejections(input.dataDir, input.isSessionDeleted)
                || hasRetainedMaintenanceProposalApprovals(input.dataDir, input.isSessionDeleted)
                || hasRetainedArcCommitEvidence(input.dataDir, input.isSessionDeleted)
                || hasRetainedNpcOperationEvidence(input.dataDir, input.isSessionDeleted)
                || hasRetainedWorldbookApplyEvidence(input.dataDir, input.isSessionDeleted)
                || hasRetainedReportedEffects(input.dataDir, input.isSessionDeleted); }
            catch {
                // An unreadable source is not proof that retained evidence is absent.
                // Open the existing recovery composition; each source still validates independently.
                warn('source-discovery-pending');
                needed = true;
            }
        }
        if (!needed) {
            for (const file of readdirSync(input.dataDir)) {
                if (!file.endsWith('.db')) continue;
                const rawSessionId = file.slice(0, -3);
                if (input.isSessionDeleted(rawSessionId)) continue;
                const path = input.resolveSession(file);
                if (!path) continue;
                try {
                    needed = hasRetainedExplicitPreferenceEvidence(path, rawSessionId)
                        || hasRetainedClosureSkillEvidence(path, rawSessionId)
                        || hasRetainedMaintenanceMemoryEvidence(path, rawSessionId)
                        || hasRetainedMaintenanceSummaryEvidence(path, rawSessionId)
                        || hasRetainedRegenerationEvidence(path, rawSessionId)
                        || hasRetainedStyleCompileAdoptionEvidence(path, rawSessionId)
                        || hasRetainedVariableApplyEvidence(path, rawSessionId)
                        || hasRetainedNsfwSceneEvidence(path, rawSessionId)
                        || hasRetainedAqlAdvisoryEvidence(path, rawSessionId)
                        || hasRetainedPreferenceInferenceEvidence(path, rawSessionId)
                        || hasRetainedBranchAttributionEvidence(path, rawSessionId)
                        || hasRetainedBranchModifiedEvidence(path, rawSessionId)
                        || hasRetainedVariableInvalidationEvidence(path, rawSessionId);
                }
                catch {
                    warn('source-discovery-pending');
                    needed = true;
                }
                if (needed) break;
            }
        }
        if (!needed) return null;
        return new AgentEvidenceLedger({ dataDir: input.dataDir, isSessionDeleted: input.isSessionDeleted });
    } catch {
        warn('ledger-open-failed');
        return null;
    }
}
