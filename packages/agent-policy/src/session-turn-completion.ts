/** @author Codex @date 2026-10-26 @version 1.0
 * Content-free ordinary-turn policy and proof contracts. Normalization grants no execution or commit authority.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type SessionTurnCompletionTier = 'daily' | 'key-plot';
export type SessionTurnCompletionAction = 'turn' | 'regenerate';
export interface SessionTurnCompletionVerifier {
    readonly verifierId: string;
    readonly version: '1.0.0';
    readonly kind: 'deterministic' | 'domain-readback';
    readonly requirement: 'required';
}
function verifier(verifierId: string, kind: SessionTurnCompletionVerifier['kind']): SessionTurnCompletionVerifier {
    return Object.freeze({ verifierId, version: '1.0.0', kind, requirement: 'required' });
}
const base = Object.freeze([
    verifier('verify.turn.structure.v1', 'deterministic'),
    verifier('verify.turn.domain-readback.v1', 'domain-readback'),
]);
export const SESSION_TURN_COMPLETION_VERIFIERS = Object.freeze({
    daily: base,
    'key-plot': Object.freeze([
        ...base,
        verifier('verify.turn.continuity-source-binding.v1', 'domain-readback'),
        verifier('verify.turn.character-knowledge-source-binding.v1', 'domain-readback'),
    ]),
});

export interface SessionTurnCompletionPin {
    readonly version: 'session-turn-completion-pin-v1';
    readonly sessionKey: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly action: SessionTurnCompletionAction;
    readonly round: number;
    readonly historyEpoch: number;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly tier: SessionTurnCompletionTier;
    readonly inputDigest: string;
    readonly routingDigest: string;
    readonly reasonCodes: readonly string[];
    readonly policyId: string;
    readonly verifierSetDigest: string;
    readonly pinDigest: string;
}
export interface SessionTurnCompletionProof {
    readonly version: 'session-turn-completion-proof-v1';
    readonly pinDigest: string;
    readonly sessionKey: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly action: SessionTurnCompletionAction;
    readonly round: number;
    readonly historyEpoch: number;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly tier: SessionTurnCompletionTier;
    readonly candidateDigest: string;
    readonly assistantDigest: string;
    readonly assistantMessageId: number;
    readonly requestDigest: string;
    readonly modelAttempts: number;
    readonly verifierResults: readonly Readonly<{ verifierId: string; evidenceDigest: string }>[];
    readonly proofDigest: string;
}
function invalid(): never {
    throw new Error('session-turn-completion-invalid');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        types.isProxy(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
    for (const key of keys) {
        const item = descriptors[key];
        if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) invalid();
    }
    return value as Record<string, unknown>;
}
function token(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) invalid();
    return value;
}
function key(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 240 ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/u.test(value)
    )
        invalid();
    return value;
}
function hash(value: unknown): string {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid();
    return value;
}
function integer(value: unknown, min = 0): number {
    if (!Number.isSafeInteger(value) || Number(value) < min) invalid();
    return Number(value);
}
function tier(value: unknown): SessionTurnCompletionTier {
    if (value !== 'daily' && value !== 'key-plot') invalid();
    return value;
}
function action(value: unknown): SessionTurnCompletionAction {
    if (value !== 'turn' && value !== 'regenerate') invalid();
    return value;
}
function mode(value: unknown): 'nsf' | 'nsfw' {
    if (value !== 'nsf' && value !== 'nsfw') invalid();
    return value;
}
function list(value: unknown, max: number): readonly unknown[] {
    if (
        !Array.isArray(value) ||
        types.isProxy(value) ||
        value.length > max ||
        Reflect.ownKeys(value).length !== value.length + 1
    )
        invalid();
    return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
            const item = Object.getOwnPropertyDescriptor(value, String(index));
            if (!item?.enumerable || !Object.hasOwn(item, 'value')) invalid();
            return item.value;
        }),
    );
}
export function sessionTurnCompletionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
type PinInput = Omit<SessionTurnCompletionPin, 'version' | 'policyId' | 'verifierSetDigest' | 'pinDigest'>;
const PIN_INPUT_KEYS = Object.freeze([
    'sessionKey',
    'sessionId',
    'runId',
    'action',
    'round',
    'historyEpoch',
    'contentMode',
    'tier',
    'inputDigest',
    'routingDigest',
    'reasonCodes',
]);

export function createSessionTurnCompletionPin(input: PinInput): SessionTurnCompletionPin {
    const value = object(input, PIN_INPUT_KEYS);
    const selected = tier(value.tier);
    const reasonCodes = list(value.reasonCodes, 2)
        .map((item) => {
            if (item !== 'ordinary-turn' && item !== 'key-plot-intent' && item !== 'inherited-key-plot') invalid();
            return item;
        })
        .sort();
    if (
        new Set(reasonCodes).size !== reasonCodes.length ||
        (selected === 'daily' && JSON.stringify(reasonCodes) !== '["ordinary-turn"]') ||
        (selected === 'key-plot' && (reasonCodes.length === 0 || reasonCodes.includes('ordinary-turn')))
    )
        invalid();
    const body = Object.freeze({
        version: 'session-turn-completion-pin-v1' as const,
        sessionKey: key(value.sessionKey),
        sessionId: token(value.sessionId),
        runId: token(value.runId),
        action: action(value.action),
        round: integer(value.round, 1),
        historyEpoch: integer(value.historyEpoch),
        contentMode: mode(value.contentMode),
        tier: selected,
        inputDigest: hash(value.inputDigest),
        routingDigest: hash(value.routingDigest),
        reasonCodes: Object.freeze(reasonCodes),
        policyId: `policy.turn-completion.${selected}.v1`,
        verifierSetDigest: sessionTurnCompletionDigest(SESSION_TURN_COMPLETION_VERIFIERS[selected]),
    });
    return Object.freeze({ ...body, pinDigest: sessionTurnCompletionDigest(body) });
}
export function normalizeSessionTurnCompletionPin(input: unknown): SessionTurnCompletionPin {
    const value = object(input, [...PIN_INPUT_KEYS, 'version', 'policyId', 'verifierSetDigest', 'pinDigest']);
    const plain = Object.fromEntries(PIN_INPUT_KEYS.map((name) => [name, value[name]]));
    const pinned = createSessionTurnCompletionPin(plain as PinInput);
    if (
        value.version !== pinned.version ||
        value.policyId !== pinned.policyId ||
        value.verifierSetDigest !== pinned.verifierSetDigest ||
        value.pinDigest !== pinned.pinDigest
    )
        invalid();
    return pinned;
}
type ProofInput = Omit<SessionTurnCompletionProof, 'version' | 'proofDigest'>;
const PROOF_INPUT_KEYS = Object.freeze([
    'pinDigest',
    'sessionKey',
    'sessionId',
    'runId',
    'action',
    'round',
    'historyEpoch',
    'contentMode',
    'tier',
    'candidateDigest',
    'assistantDigest',
    'assistantMessageId',
    'requestDigest',
    'modelAttempts',
    'verifierResults',
]);

export function createSessionTurnCompletionProof(input: ProofInput): SessionTurnCompletionProof {
    const value = object(input, PROOF_INPUT_KEYS);
    const selected = tier(value.tier);
    const required = SESSION_TURN_COMPLETION_VERIFIERS[selected];
    const results = list(value.verifierResults, 4).map((item) => {
        const row = object(item, ['verifierId', 'evidenceDigest']);
        return Object.freeze({ verifierId: token(row.verifierId), evidenceDigest: hash(row.evidenceDigest) });
    });
    if (
        results.length !== required.length ||
        required.some((declaration) => results.filter((row) => row.verifierId === declaration.verifierId).length !== 1)
    )
        invalid();
    const body = Object.freeze({
        version: 'session-turn-completion-proof-v1' as const,
        pinDigest: hash(value.pinDigest),
        sessionKey: key(value.sessionKey),
        sessionId: token(value.sessionId),
        runId: token(value.runId),
        action: action(value.action),
        round: integer(value.round, 1),
        historyEpoch: integer(value.historyEpoch),
        contentMode: mode(value.contentMode),
        tier: selected,
        candidateDigest: hash(value.candidateDigest),
        assistantDigest: hash(value.assistantDigest),
        assistantMessageId: integer(value.assistantMessageId, 1),
        requestDigest: hash(value.requestDigest),
        modelAttempts: integer(value.modelAttempts, 1),
        verifierResults: Object.freeze(
            required.map((declaration) => results.find((row) => row.verifierId === declaration.verifierId)!),
        ),
    });
    return Object.freeze({ ...body, proofDigest: sessionTurnCompletionDigest(body) });
}
export function normalizeSessionTurnCompletionProof(
    input: unknown,
    pin: SessionTurnCompletionPin,
): SessionTurnCompletionProof {
    const value = object(input, [...PROOF_INPUT_KEYS, 'version', 'proofDigest']);
    const plain = Object.fromEntries(PROOF_INPUT_KEYS.map((name) => [name, value[name]]));
    const proof = createSessionTurnCompletionProof(plain as ProofInput);
    const pinned = normalizeSessionTurnCompletionPin(pin);
    if (value.version !== proof.version || value.proofDigest !== proof.proofDigest) invalid();
    for (const name of [
        'pinDigest',
        'sessionKey',
        'sessionId',
        'runId',
        'action',
        'round',
        'historyEpoch',
        'contentMode',
        'tier',
    ] as const)
        if (proof[name] !== pinned[name]) invalid();
    return proof;
}
