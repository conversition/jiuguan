/** @author Codex @date 2026-10-15 @version 1.0
 * Versioned Critic repair output boundary shared with the contract index.
 */
import {
    GameTurnSchema, normalizeTurn, safeParseTurn, validateGameTurn, type GameTurn,
} from '../../prompt/public/turn.ts';
import {
    evaluatePrecommitCritic, type PrecommitCriticDecision,
} from '../../agent-policy/public/precommit-critic.ts';

export const CRITIC_OUTPUT_CONTRACT_VERSION = 'session-critic-output-contract-v1' as const;

export interface CriticOutputValidationInput {
    readonly raw: string | null;
    readonly previousProse: string | undefined;
    readonly postProcess: (turn: GameTurn) => GameTurn;
}

export interface CriticOutputValidationResult {
    readonly version: typeof CRITIC_OUTPUT_CONTRACT_VERSION;
    readonly acceptedTurn: GameTurn | null;
    readonly criticOutputInvalid: boolean;
    readonly decision: PrecommitCriticDecision | null;
}

/**
 * Preserve the Session repair boundary, including plugin order and empty-string telemetry.
 * Exceptions propagate to the caller's optional-Critic fallback so failed plugins/normalization
 * do not create invalid-call or artifact observations that the original path never emitted.
 */
export function validateCriticOutput(input: CriticOutputValidationInput): CriticOutputValidationResult {
    const parsed = input.raw ? safeParseTurn(input.raw) : null;
    const rejected = (decision: PrecommitCriticDecision | null = null): CriticOutputValidationResult =>
        Object.freeze({
            version: CRITIC_OUTPUT_CONTRACT_VERSION,
            acceptedTurn: null,
            criticOutputInvalid: typeof input.raw === 'string',
            decision,
        });
    if (!parsed) return rejected();

    const normalized = normalizeTurn(parsed).turn;
    if (!validateGameTurn(normalized).ok) return rejected();

    const revised = input.postProcess(GameTurnSchema.parse(normalized));
    const decision = evaluatePrecommitCritic({
        turn: revised,
        duplicateOutput: input.previousProse?.trim() === revised.prose.trim(),
        contractIssueCount: 0,
    });
    if (decision.severity !== 'pass' && decision.severity !== 'warn') return rejected(decision);

    return Object.freeze({
        version: CRITIC_OUTPUT_CONTRACT_VERSION,
        acceptedTurn: revised,
        criticOutputInvalid: false,
        decision,
    });
}
