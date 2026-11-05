/** @author Codex @date 2026-10-16 @version 1.0
 * Content-free proof of local explicit preferences retained in the designated Provider system slot.
 */
import { createHash } from 'node:crypto';
import type { LearningEventRecord, LearningProfileIdentityValue } from '../../memory/public/learning-outbox.ts';
import type { ChatRequest } from '../../proxy/public/client.ts';
import {
    PROMPT_PREFERENCE_EXTRACTOR_VERSION,
    rebuildPromptPreferenceProfiles,
    type PromptPreferenceProfile,
} from '../../agent-policy/public/prompt-preference.ts';
import {
    consolidateDirectionGuidance,
    directionGuidanceBlockDigest,
    renderDirectionGuidance,
    type DirectionGuidance,
} from '../../agent-policy/public/direction-guidance.ts';

export const EXPLICIT_PREFERENCE_ADOPTION_VERSION = 'explicit-preference-adoption-v1' as const;
export const MAX_EXPLICIT_PREFERENCE_ADOPTION_SOURCES = 64;
const MAX_EVENTS = 10_000;
const MAX_CARRIER_CHARS = 1_048_576;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
type Message = ChatRequest['messages'][number];

export interface ExplicitPreferenceAdoptionSourceInput {
    readonly identity: LearningProfileIdentityValue;
    readonly profile: PromptPreferenceProfile;
    readonly events: readonly LearningEventRecord[];
    readonly preferenceEpoch: number;
    readonly evidenceRevision: string;
    readonly guidance: DirectionGuidance;
    readonly block: string;
}

export interface ExplicitPreferenceAdoptionSource {
    readonly version: typeof EXPLICIT_PREFERENCE_ADOPTION_VERSION;
    readonly identity: LearningProfileIdentityValue;
    readonly sourceEventIds: readonly string[];
    readonly sourceDigest: string;
    readonly profileDigest: string;
    readonly preferenceDigest: string;
    readonly blockDigest: string;
    readonly preferenceEpoch: number;
    readonly evidenceRevision: string;
    readonly sampleCount: number;
    readonly tagCount: number;
}

export interface ExplicitPreferenceAdoptionCarrier {
    readonly messageIndex: 0;
    readonly source: ExplicitPreferenceAdoptionSource;
}

export interface BoundExplicitPreferenceAdoptionCarrier extends ExplicitPreferenceAdoptionCarrier {
    readonly carrierDigest: string;
}

const SOURCES = new WeakMap<object, Readonly<{ block: string; }>>();
const CAPTURED = new WeakMap<object, Readonly<{ originalText: string; wrapper: string; block: string; }>>();
const BOUND = new WeakMap<object, Readonly<{ wrapper: string; block: string; }>>();


function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
}


export function explicitPreferenceAdoptionDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
}


function identityMatches(left: LearningProfileIdentityValue, right: LearningProfileIdentityValue): boolean {
    return left.sessionId === right.sessionId && left.cardId === right.cardId && left.contentMode === right.contentMode;
}


function selectedProfile(events: readonly LearningEventRecord[], identity: LearningProfileIdentityValue):
    PromptPreferenceProfile | undefined {
    return rebuildPromptPreferenceProfiles(events).session.find((profile) => profile.sessionId === identity.sessionId
        && profile.cardId === identity.cardId && profile.contentMode === identity.contentMode);
}


function currentExplicitCandidate(event: LearningEventRecord, input: ExplicitPreferenceAdoptionSourceInput): boolean {
    const epoch = event.features.preferenceEpoch ?? 0;
    return event.eventKind === 'session_start_prompt' && identityMatches(event, input.identity)
        && epoch === input.preferenceEpoch && Array.isArray(event.features.explicitPreferenceTags)
        && event.features.explicitPreferenceTags.length > 0;
}


function explicitEventValid(event: LearningEventRecord): boolean {
    const tags = event.features.explicitPreferenceTags;
    return TOKEN.test(event.eventId) && SHA256.test(event.payloadDigest) && SHA256.test(event.subjectDigest)
        && event.features.preferenceExtractorVersion === PROMPT_PREFERENCE_EXTRACTOR_VERSION
        && event.features.preferenceConfidence === 'explicit'
        && Array.isArray(tags) && event.features.explicitPreferenceCount === new Set(tags).size
        && tags.length === new Set(tags).size && event.features.hasPreferenceConflict === false;
}


function contributingEvents(input: ExplicitPreferenceAdoptionSourceInput): readonly LearningEventRecord[] | null {
    const candidates = input.events.filter((event) => currentExplicitCandidate(event, input));
    // A bounded proof may decline a very large history without changing normal preference application.
    if (candidates.length === 0 || candidates.length > MAX_EXPLICIT_PREFERENCE_ADOPTION_SOURCES
        || new Set(input.events.map((event) => event.eventId)).size !== input.events.length) return null;
    const contributors = candidates.filter((event) => {
        const remaining = selectedProfile(input.events.filter((candidate) => candidate !== event), input.identity);
        return (remaining?.sampleCount ?? 0) === input.profile.sampleCount - 1;
    });
    return contributors.length === input.profile.sampleCount && contributors.every(explicitEventValid)
        ? contributors : null;
}


/** Only actual local explicit session evidence can claim adoption; card fallback and guesses stay unproven. */
export function captureExplicitPreferenceAdoptionSource(input: ExplicitPreferenceAdoptionSourceInput):
    ExplicitPreferenceAdoptionSource | null {
    const { identity, profile, guidance } = input;
    if (!TOKEN.test(identity.sessionId) || !TOKEN.test(identity.cardId)
        || (identity.contentMode !== 'nsf' && identity.contentMode !== 'nsfw')
        || profile.scope !== 'session' || profile.sessionId !== identity.sessionId
        || profile.cardId !== identity.cardId || profile.contentMode !== identity.contentMode
        || !Number.isSafeInteger(input.preferenceEpoch) || input.preferenceEpoch < 0
        || !SHA256.test(input.evidenceRevision) || !Array.isArray(input.events) || input.events.length > MAX_EVENTS
        || !Number.isSafeInteger(profile.sampleCount) || profile.sampleCount < 1
        || profile.sampleCount > MAX_EXPLICIT_PREFERENCE_ADOPTION_SOURCES || profile.conflictTags.length > 0
        || typeof input.block !== 'string' || input.block.length > MAX_CARRIER_CHARS) return null;
    const rebuilt = selectedProfile(input.events, identity);
    if (!rebuilt || stableJson(rebuilt) !== stableJson(profile)) return null;
    const expected = consolidateDirectionGuidance({
        branch: null, prompt: rebuilt,
        evidenceRevision: input.evidenceRevision
    });
    if (guidance.version !== expected.version || guidance.evidenceRevision !== input.evidenceRevision
        || guidance.preferenceDigest !== expected.preferenceDigest
        || stableJson(guidance.axes) !== stableJson(expected.axes)
        || input.block !== renderDirectionGuidance({ guidance, scope: 'session' })) return null;
    const tagCount = guidance.axes.reduce((count, axis) => count + axis.tags.length, 0);
    const contributors = contributingEvents(input);
    if (tagCount < 1 || !contributors) return null;
    const sorted = [...contributors].sort((left, right) => left.eventId < right.eventId ? -1 : 1);
    const snapshot = {
        version: EXPLICIT_PREFERENCE_ADOPTION_VERSION,
        identity: Object.freeze({
            sessionId: identity.sessionId, cardId: identity.cardId,
            contentMode: identity.contentMode
        }),
        sourceEventIds: Object.freeze(sorted.map((event) => event.eventId)),
        profileDigest: explicitPreferenceAdoptionDigest(rebuilt),
        preferenceDigest: guidance.preferenceDigest,
        blockDigest: directionGuidanceBlockDigest(input.block),
        preferenceEpoch: input.preferenceEpoch,
        evidenceRevision: input.evidenceRevision,
        sampleCount: profile.sampleCount,
        tagCount,
    };
    const source = Object.freeze({
        ...snapshot, sourceDigest: explicitPreferenceAdoptionDigest({
            ...snapshot,
            events: sorted.map((event) => ({ eventId: event.eventId, payloadDigest: event.payloadDigest })),
        })
    });
    SOURCES.set(source, Object.freeze({ block: input.block }));
    return source;
}


/** Rebuild current local state again at final settlement; copied metadata cannot establish ownership. */
export function explicitPreferenceAdoptionSourceMatches(source: ExplicitPreferenceAdoptionSource,
    current: ExplicitPreferenceAdoptionSourceInput): boolean {
    if (!SOURCES.has(source)) return false;
    return captureExplicitPreferenceAdoptionSource(current)?.sourceDigest === source.sourceDigest;
}


function systemText(messages: readonly Message[]): string | null {
    const message = messages[0];
    return message?.role === 'system' && typeof message.content === 'string' ? message.content : null;
}


function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}


function designatedSystem(text: string, wrapper: string, block: string): boolean {
    const wrapperIndex = text.indexOf(wrapper);
    const suffix = text.slice(wrapperIndex + wrapper.length);
    return text.length <= MAX_CARRIER_CHARS && wrapperIndex >= 2
        && text.slice(wrapperIndex - 2, wrapperIndex) === '\n\n' && (!suffix || suffix.startsWith('\n\n'))
        && occurrences(text, wrapper) === 1 && occurrences(text, block) === 1
        && occurrences(text, '<动态状态>\n') === 1 && occurrences(text, '\n</动态状态>') === 1
        && (text.match(/<\/?学习偏好(?:\s|>)/gu)?.length ?? 0) === 2;
}

/** Actual designated Direction carrier, independent of whether explicit-user evidence exists. */
export function directionGuidanceCarrierText(messages: readonly Message[], dynamicState: string, block: string): string | null {
    if (!block || typeof dynamicState !== 'string' || !dynamicState.endsWith(`\n${block}`)
        || /<\/?动态状态(?:\s|>)/u.test(dynamicState)) return null;
    const text = systemText(messages);
    const wrapper = `<动态状态>\n${dynamicState}\n</动态状态>`;
    return text !== null && designatedSystem(text, wrapper, block) ? text : null;
}


/** The exact dynamic-state tail inside the leading system is authoritative, never matching user/history prose. */
export function captureExplicitPreferenceAdoptionCarrier(input: {
    readonly source: ExplicitPreferenceAdoptionSource;
    readonly messages: readonly Message[];
    readonly dynamicState: string;
    readonly block: string;
}): ExplicitPreferenceAdoptionCarrier | null {
    const capturedSource = SOURCES.get(input.source);
    if (!capturedSource || input.block !== capturedSource.block || typeof input.dynamicState !== 'string'
        || !input.dynamicState.endsWith(`\n${input.block}`)
        || /<\/?动态状态(?:\s|>)/u.test(input.dynamicState)) return null;
    const originalText = directionGuidanceCarrierText(input.messages, input.dynamicState, input.block);
    const wrapper = `<动态状态>\n${input.dynamicState}\n</动态状态>`;
    if (originalText === null) return null;
    const carrier = Object.freeze({ messageIndex: 0 as const, source: input.source });
    CAPTURED.set(carrier, Object.freeze({ originalText, wrapper, block: input.block }));
    return carrier;
}


/** Existing host transforms may append, but may not relocate, replace, truncate or ambiguously repeat the slot. */
export function bindExplicitPreferenceAdoptionCarrier(carrier: ExplicitPreferenceAdoptionCarrier,
    messages: readonly Message[]): BoundExplicitPreferenceAdoptionCarrier | null {
    const captured = CAPTURED.get(carrier);
    const text = systemText(messages);
    if (!captured || text === null || !text.startsWith(captured.originalText)
        || !designatedSystem(text, captured.wrapper, captured.block)) return null;
    const bound = Object.freeze({
        messageIndex: 0 as const, source: carrier.source,
        carrierDigest: explicitPreferenceAdoptionDigest(text)
    });
    BOUND.set(bound, Object.freeze({ wrapper: captured.wrapper, block: captured.block }));
    return bound;
}


/** Only the exact bound system of the successful Provider attempt proves retained preference context. */
export function explicitPreferenceAdoptionCarrierMatches(carrier: BoundExplicitPreferenceAdoptionCarrier,
    messages: readonly Message[]): boolean {
    const bound = BOUND.get(carrier);
    const text = systemText(messages);
    return bound !== undefined && text !== null && designatedSystem(text, bound.wrapper, bound.block)
        && explicitPreferenceAdoptionDigest(text) === carrier.carrierDigest;
}
