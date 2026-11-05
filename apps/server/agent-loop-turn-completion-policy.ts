/** @author Codex @date 2026-10-26 @version 1.0
 * P17-06.5: bounded AL turn contracts, not ordinary-turn routing or semantic review.
 * The original task-created event pins the immutable tuple without another schema.
 */
import { createHash } from 'node:crypto';
import type { AgentLoopTaskEnvelopeV1 } from '@jiuguan/agent-loop-contract';
import { SESSION_TURN_COMPLETION_VERIFIERS } from '../../packages/agent-policy/public/session-turn-completion.ts';
import {
    AgentLoopVerifierRegistry,
    type AgentLoopCompletionVerdictResult,
    type AgentLoopVerifierDeclaration,
    type AgentLoopVerifierSet,
} from './agent-loop-completion-gate.ts';
import { normalizeAgentLoopActionObject, normalizeAgentLoopActionToken } from './agent-loop-action-receipt.ts';

export type AgentLoopTurnCompletionTier = 'daily' | 'key-plot';

export interface AgentLoopTurnCompletionPolicy {
    readonly policyId: string;
    readonly taskKind: string;
    readonly taskContractRef: string;
    readonly contractRevision: '1.0.0';
    readonly verifierSetRef: string;
    readonly verifierSetRevision: '1.0.0';
    readonly maxRepairAttempts: 0;
    readonly verifiers: readonly AgentLoopVerifierDeclaration[];
}

function policy(tier: AgentLoopTurnCompletionTier): AgentLoopTurnCompletionPolicy {
    return Object.freeze({
        policyId: `policy.turn-completion.${tier}.v1`,
        taskKind: `conversation-turn.${tier}`,
        taskContractRef: `contract.turn.${tier}.v1`,
        contractRevision: '1.0.0',
        verifierSetRef: `verifier.turn.${tier}.v1`,
        verifierSetRevision: '1.0.0',
        maxRepairAttempts: 0,
        // The shared declarations attest source binding, not plot/character semantic quality.
        verifiers: SESSION_TURN_COMPLETION_VERIFIERS[tier],
    });
}

export const AGENT_LOOP_TURN_COMPLETION_POLICIES = Object.freeze({
    daily: policy('daily'),
    'key-plot': policy('key-plot'),
});

function invalid(): never {
    throw new Error('agent-loop-turn-completion-policy-invalid');
}

export function getAgentLoopTurnCompletionPolicy(tier: AgentLoopTurnCompletionTier): AgentLoopTurnCompletionPolicy {
    if (tier !== 'daily' && tier !== 'key-plot') invalid();
    return AGENT_LOOP_TURN_COMPLETION_POLICIES[tier];
}

function birthEvent(taskId: string, selected: AgentLoopTurnCompletionPolicy) {
    const digest = createHash('sha256')
        .update(JSON.stringify({ taskId, policy: selected }))
        .digest('hex');
    return Object.freeze({
        eventId: `turn-completion-created:${digest}`,
        kind: 'task-created' as const,
        reasonCode: selected.policyId,
    });
}

export function createAgentLoopTurnCompletionBirthEvent(
    input: Readonly<{
        taskId: string;
        tier: AgentLoopTurnCompletionTier;
    }>,
): Readonly<{ eventId: string; kind: 'task-created'; reasonCode: string }> {
    try {
        normalizeAgentLoopActionObject(input, ['taskId', 'tier']);
        return birthEvent(normalizeAgentLoopActionToken(input.taskId), getAgentLoopTurnCompletionPolicy(input.tier));
    } catch {
        return invalid();
    }
}

type TurnEnvelope = Pick<AgentLoopTaskEnvelopeV1, 'taskId' | 'taskKind' | 'taskContractRef' | 'verifier'>;
type BirthEvent = Readonly<{ eventId: string; kind: string; reasonCode?: string | null }>;

/** The birth marker is checked even when a proposed envelope tries to become legacy. */
export function assertAgentLoopTurnCompletionBirthBinding(
    input: Readonly<{
        envelope: TurnEnvelope;
        birthEvent: BirthEvent | null;
    }>,
): AgentLoopTurnCompletionPolicy | null {
    try {
        normalizeAgentLoopActionObject(input, ['envelope', 'birthEvent']);
        const envelope = normalizeAgentLoopActionObject(input.envelope, [], Object.keys(input.envelope));
        const verifier = normalizeAgentLoopActionObject(envelope.verifier, [], Object.keys(input.envelope.verifier));
        const event =
            input.birthEvent === null
                ? null
                : normalizeAgentLoopActionObject(input.birthEvent, [], Object.keys(input.birthEvent));
        const marked = [
            envelope.taskKind,
            envelope.taskContractRef,
            verifier.verifierSetRef,
            event?.reasonCode,
            event?.eventId,
        ].some(
            (value) =>
                typeof value === 'string' &&
                (/^conversation-turn\.(?:daily|key-plot)(?:$|[.])/u.test(value) ||
                    /^contract\.turn\.(?:daily|key-plot)\./u.test(value) ||
                    /^verifier\.turn\.(?:daily|key-plot)\./u.test(value) ||
                    value.startsWith('policy.turn-completion.') ||
                    value.startsWith('turn-completion-created:')),
        );
        if (!marked) return null;
        const selected = Object.values(AGENT_LOOP_TURN_COMPLETION_POLICIES).find(
            (item) => item.policyId === event?.reasonCode,
        );
        if (
            !selected ||
            envelope.taskKind !== selected.taskKind ||
            envelope.taskContractRef !== selected.taskContractRef ||
            verifier.verifierSetRef !== selected.verifierSetRef ||
            verifier.verifierSetRevision !== selected.verifierSetRevision
        )
            invalid();
        const expected = birthEvent(normalizeAgentLoopActionToken(envelope.taskId), selected);
        if (event?.eventId !== expected.eventId || event.kind !== expected.kind) invalid();
        return selected;
    } catch {
        return invalid();
    }
}

function canonicalDeclarations(verifiers: readonly AgentLoopVerifierDeclaration[]): string {
    return JSON.stringify(
        verifiers
            .map((item) => {
                normalizeAgentLoopActionObject(item, ['verifierId', 'version', 'kind', 'requirement']);
                return [item.verifierId, item.version, item.kind, item.requirement];
            })
            .sort((left, right) => left[0]!.localeCompare(right[0]!)),
    );
}

/** A fresh registry with the same ref must not silently remove/relax requirements. */
export function assertAgentLoopTurnCompletionVerifierSet(
    input: Readonly<{
        policy: AgentLoopTurnCompletionPolicy;
        verifierSet: AgentLoopVerifierSet | null;
        maxRepairAttempts: number;
    }>,
): void {
    try {
        const { policy: selected, verifierSet } = input;
        if (
            !verifierSet ||
            input.maxRepairAttempts !== selected.maxRepairAttempts ||
            verifierSet.verifierSetRef !== selected.verifierSetRef ||
            verifierSet.verifierSetRevision !== selected.verifierSetRevision ||
            canonicalDeclarations(verifierSet.verifiers) !== canonicalDeclarations(selected.verifiers)
        )
            invalid();
    } catch {
        invalid();
    }
}

/** Mechanical coverage only; original host runners/source assertions remain authority. */
export function assertAgentLoopTurnCompletionEvaluation(
    input: Readonly<{
        policy: AgentLoopTurnCompletionPolicy;
        evaluation: AgentLoopCompletionVerdictResult;
    }>,
): void {
    const { evaluation, policy: selected } = input;
    if (evaluation.verdict !== 'complete') return;
    const results = evaluation.verifierResults;
    if (
        results.length !== selected.verifiers.length ||
        selected.verifiers.some(
            (required) =>
                results.filter(
                    (result) =>
                        result.verifierId === required.verifierId &&
                        result.disposition === 'passed' &&
                        result.evidenceRefs.length > 0,
                ).length !== 1,
        )
    )
        invalid();
}

/** Registrations only: no runner, Model dispatch, publication or ordinary-turn routing. */
export function createAgentLoopTurnCompletionRegistry(): AgentLoopVerifierRegistry {
    const registry = new AgentLoopVerifierRegistry();
    for (const selected of Object.values(AGENT_LOOP_TURN_COMPLETION_POLICIES)) {
        registry.register({
            taskKind: selected.taskKind,
            contractRevision: selected.contractRevision,
            verifierSetRef: selected.verifierSetRef,
            verifierSetRevision: selected.verifierSetRevision,
            verifiers: selected.verifiers,
        });
    }
    return registry;
}
