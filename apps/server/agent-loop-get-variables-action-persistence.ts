/** P17-02.4b: mechanical binding to the ORIGINAL projection Store, not execution authority.
 * No grant, policy, tool execution, scheduler, result body, or Verify is supplied here.
 * Production keeps toolCalls=0 and ACT denied until the trusted host capability is bound.
 */
import {
    agentLoopActionDigest,
    type AgentLoopActionGatewayPorts,
    type AgentLoopActionRequest,
    type AgentLoopUsageVector,
} from './agent-loop-action-gateway.ts';
import { AgentLoopProjectionError, type AgentLoopProjectionStore } from './agent-loop-projection-store.ts';
import { types } from 'node:util';
import {
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    normalizeAgentLoopActionObject,
} from './agent-loop-action-receipt.ts';

const CONTRACT = 'action.maintenance.get_variables.v1';
const USAGE_KEYS = Object.freeze([
    'modelCalls',
    'toolCalls',
    'writes',
    'inputTokens',
    'outputTokens',
    'costMicrousd',
    'wallMs',
    'highRiskActions',
] as const);

export type AgentLoopGetVariablesActionPersistence = Readonly<
    Pick<AgentLoopActionGatewayPorts, 'budget' | 'receipts' | 'readTaskRevision' | 'reconcile'>
>;

export function createAgentLoopGetVariablesActionPersistence(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        ownerId: string;
        request: AgentLoopActionRequest;
    }>,
): AgentLoopGetVariablesActionPersistence {
    return createReadonlyActionPersistence(options, CONTRACT);
}

/** Distinct exact RP ingress; the existing Maintenance factory never accepts this contract. */
export function createAgentLoopRpCharacterActionPersistence(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        ownerId: string;
        request: AgentLoopActionRequest;
    }>,
): AgentLoopGetVariablesActionPersistence {
    if (types.isProxy(options.request)) throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
    const request = normalizeAgentLoopActionObject(
        options.request,
        [
            'actionId',
            'taskId',
            'attemptId',
            'harnessRunId',
            'decisionId',
            'expectedTaskRevision',
            'decisionDigest',
            'actionContractRef',
            'taskContractRef',
            'taskKind',
            'args',
            'requestedAt',
            'authorityRevision',
        ],
        ['contractVersion'],
    );
    if (types.isProxy(request.args)) throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
    const args = normalizeAgentLoopActionObject(request.args, ['sourceRef']);
    if (
        request.taskKind !== 'rp.child-analysis' ||
        request.taskContractRef !== 'task.rp-child-analysis.v1' ||
        typeof args.sourceRef !== 'string' ||
        !/^rp-character:sha256:[a-f0-9]{64}$/u.test(args.sourceRef)
    ) {
        throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
    }
    return createReadonlyActionPersistence(options, AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT);
}

function createReadonlyActionPersistence(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        ownerId: string;
        request: AgentLoopActionRequest;
    }>,
    contract: typeof CONTRACT | typeof AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
): AgentLoopGetVariablesActionPersistence {
    const { store, ownerId } = options;
    const request = options.request;
    if (request.actionContractRef !== contract) {
        throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
    }
    // Capture scalars/digest, never retain mutable caller args as a future authority source.
    const scope = Object.freeze({
        taskId: request.taskId,
        attemptId: request.attemptId,
        expectedRevision: request.expectedTaskRevision,
        ownerId,
        actionId: request.actionId,
    });
    const actionDigest = agentLoopActionDigest(request);
    function assertBinding(actionId: string, digest = actionDigest): void {
        if (actionId !== scope.actionId || digest !== actionDigest) {
            throw new AgentLoopProjectionError('agent-loop-projection-event-conflict');
        }
    }
    return Object.freeze({
        readTaskRevision: (taskId: string) => (taskId === scope.taskId ? (store.read(taskId)?.revision ?? null) : null),
        budget: Object.freeze({
            reserve: (input) => {
                assertBinding(input.actionId, input.actionDigest);
                if (Object.keys(input.estimate).some((key) => !(USAGE_KEYS as readonly string[]).includes(key))) {
                    throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
                }
                const estimate = Object.fromEntries(
                    USAGE_KEYS.map((key) => [key, input.estimate[key] ?? 0]),
                ) as unknown as AgentLoopUsageVector;
                return store.reserveAction({ ...scope, actionDigest, actionContractRef: contract, estimate });
            },
            settle: (input) => {
                assertBinding(input.actionId);
                store.settleAction({ ...scope, usage: input.usage });
            },
            release: (input) => {
                assertBinding(input.actionId);
                // After started this intentionally does NOT refund an unresolved action.
                store.releaseAction(scope);
            },
        }),
        receipts: Object.freeze({
            read: (actionId: string) => {
                assertBinding(actionId);
                const row = store.readActionReceipt({ taskId: scope.taskId, actionId });
                if (row?.status === 'completed' || row?.status === 'observed') {
                    return Object.freeze({
                        status: 'completed' as const,
                        actionDigest: row.actionDigest,
                        receiptRef: row.receiptRef!,
                    });
                }
                return row?.status === 'started'
                    ? Object.freeze({ status: 'started' as const, actionDigest: row.actionDigest })
                    : null;
            },
            markStarted: (input) => {
                assertBinding(input.actionId, input.actionDigest);
                store.markActionStarted({ ...scope, actionDigest });
            },
            writeCompleted: (input) => {
                assertBinding(input.actionId, input.actionDigest);
                const result = input.result;
                if (
                    !result ||
                    result.sourceKind !== 'tool' ||
                    result.payloadRef !== undefined ||
                    result.receiptRef !== input.receiptRef
                ) {
                    throw new AgentLoopProjectionError('agent-loop-projection-input-invalid');
                }
                store.completeAction({
                    ...scope,
                    actionDigest,
                    receiptRef: result.receiptRef,
                    result: {
                        sourceKind: result.sourceKind,
                        sourceRef: result.sourceRef,
                        payloadDigest: result.payloadDigest,
                        completeness: result.completeness,
                        evidenceRefs: result.evidenceRefs,
                        usage: result.usage,
                    },
                });
            },
        }),
        // An unresolved read is not reconstructible from an AL notification or a ref.
        // Never enter the legacy reconciliation branch that records unknown usage as zero.
        reconcile: Object.freeze({ readback: () => Object.freeze({ verdict: 'unknown' as const }) }),
    } satisfies AgentLoopGetVariablesActionPersistence);
}
