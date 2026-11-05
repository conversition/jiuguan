/** Shared mechanical binding to the ORIGINAL Store for the two distinct Summary write
 * contracts. The public wrappers remain exact. No execution/source authority, body,
 * domain writer, reconciliation shortcut or completion grant is supplied here. */
import { agentLoopActionDigest, type AgentLoopActionGatewayPorts,
    type AgentLoopActionRequest, type AgentLoopUsageVector } from './agent-loop-action-gateway.ts';
import { AGENT_LOOP_ACTION_USAGE_KEYS, AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
    AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT,
    normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { AgentLoopProjectionError, type AgentLoopProjectionStore } from './agent-loop-projection-store.ts';

export type AgentLoopRollingSummaryActionPersistence = Readonly<Pick<AgentLoopActionGatewayPorts,
    'budget' | 'receipts' | 'readTaskRevision' | 'reconcile'>>;

export function createAgentLoopRollingSummaryActionPersistence(options: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; request: AgentLoopActionRequest;
}>, actionContractRef: typeof AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
    | typeof AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT): AgentLoopRollingSummaryActionPersistence {
    const { store, ownerId } = options, request = options.request;
    if ((actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT
        && actionContractRef !== AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT)
        || request.actionContractRef !== actionContractRef) {
        throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
    }
    const sourceKind = actionContractRef === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT ? 'domain-readback' : 'tool';
    const scope = Object.freeze({ taskId: request.taskId, attemptId: request.attemptId,
        expectedRevision: request.expectedTaskRevision, ownerId, actionId: request.actionId });
    const actionDigest = agentLoopActionDigest(request);
    function assertBinding(actionId: string, digest = actionDigest): void {
        if (actionId !== scope.actionId || digest !== actionDigest) {
            throw new AgentLoopProjectionError('agent-loop-projection-event-conflict');
        }
    }
    return Object.freeze({
        readTaskRevision: (taskId: string) => taskId === scope.taskId ? store.read(taskId)?.revision ?? null : null,
        budget: Object.freeze({
            reserve: input => {
                assertBinding(input.actionId, input.actionDigest);
                let source: Record<string, unknown>;
                try { source = normalizeAgentLoopActionObject(input.estimate, [], AGENT_LOOP_ACTION_USAGE_KEYS); }
                catch { throw new AgentLoopProjectionError('agent-loop-projection-input-invalid'); }
                const estimate = Object.fromEntries(AGENT_LOOP_ACTION_USAGE_KEYS.map(key => [key, source[key] === undefined ? 0 : source[key]])) as unknown as AgentLoopUsageVector;
                return store.reserveAction({ ...scope, actionDigest,
                    actionContractRef, estimate });
            },
            settle: input => { assertBinding(input.actionId); store.settleAction({ ...scope, usage: input.usage }); },
            release: input => { assertBinding(input.actionId); store.releaseAction(scope); },
        }),
        receipts: Object.freeze({
            read: actionId => {
                assertBinding(actionId);
                const row = store.readActionReceipt({ taskId: scope.taskId, actionId });
                if (row && (row.actionDigest !== actionDigest
                    || row.actionContractRef !== actionContractRef)) {
                    throw new AgentLoopProjectionError('agent-loop-projection-event-conflict');
                }
                if (row?.status === 'completed' || row?.status === 'observed') {
                    return Object.freeze({ status: 'completed' as const, actionDigest: row.actionDigest, receiptRef: row.receiptRef! });
                }
                return row?.status === 'started' ? Object.freeze({ status: 'started' as const, actionDigest: row.actionDigest }) : null;
            },
            markStarted: input => { assertBinding(input.actionId, input.actionDigest); store.markActionStarted({ ...scope, actionDigest }); },
            writeCompleted: input => {
                assertBinding(input.actionId, input.actionDigest);
                try { normalizeAgentLoopActionObject(input.result, ['receiptRef', 'sourceKind', 'sourceRef', 'payloadDigest',
                    'completeness', 'evidenceRefs', 'usage']); }
                catch { throw new AgentLoopProjectionError('agent-loop-projection-input-invalid'); }
                const result = input.result;
                if (!result || result.sourceKind !== sourceKind || result.payloadRef !== undefined || result.receiptRef !== input.receiptRef) {
                    throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
                }
                store.completeAction({ ...scope, actionDigest, receiptRef: result.receiptRef, result: {
                    sourceKind: result.sourceKind, sourceRef: result.sourceRef, payloadDigest: result.payloadDigest,
                    completeness: result.completeness, evidenceRefs: result.evidenceRefs, usage: result.usage,
                } });
            },
        }),
        // A started write may already exist in its original domain/Manager database.
        // Receipt absence is not proof of no effect and never authorizes re-entry.
        reconcile: Object.freeze({ readback: () => Object.freeze({ verdict: 'unknown' as const }) }),
    } satisfies AgentLoopRollingSummaryActionPersistence);
}
