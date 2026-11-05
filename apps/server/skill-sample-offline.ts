/** @author Codex @date 2026-10-16 @version 1.0
 * Versioned, body-free observations over retained fixture prose; never a literary score or promotion verdict.
 * V1 counts all NFKC code points for characterCount. Sentence runs split on terminal punctuation clusters;
 * their numerator excludes whitespace, supported quote marks and terminal punctuation. Dialogue uses the
 * non-whitespace/non-quote pool, including punctuation. Repetition is excess adjacent bigrams in that pool.
 * Terms use case-sensitive NFKC substring presence per configured term, not occurrence counts. Empty ratios
 * are zero. Raw text digests preserve the original UTF-8 bytes. Historical v1 must keep this exact algorithm.
 */
import { normalizeSkillSamplePacket } from './skill-sample-model.ts';
import { evalDigest, evalFreeze, evalRawDigest } from './skill-evaluate-data.ts';

export const SKILL_SAMPLE_OFFLINE_VERSION = 'skill-sample-offline-receipt-v1' as const;
export const SKILL_SAMPLE_OFFLINE_ALGORITHM = 'nfkc-codepoint-sentence-quotes-bigram-v1' as const;
const MAX_NORMALIZED_CODEPOINTS = 120_000;
const TERMINAL = /^[。！？.!?]$/u;
const QUOTE_MARK = /^[“”「」『』"]$/u;
const WHITESPACE = /^\s$/u;
const QUOTE_CLOSE: Readonly<Record<string, string>> = Object.freeze({ '“': '”', '「': '」', '『': '』', '"': '"' });

export interface SkillSampleTextMetrics {
    readonly textDigest: string;
    readonly characterCount: number;
    readonly sentenceCount: number;
    readonly sentenceLength: Readonly<{ numerator: number; denominator: number; mean: number }>;
    readonly dialogue: Readonly<{ numerator: number; denominator: number; ratio: number }>;
    readonly repetition: Readonly<{ bigramCount: number; repeatedBigramCount: number; ratio: number }>;
    readonly terms: Readonly<{
        requiredMatched: number; requiredTotal: number; forbiddenMatched: number; forbiddenTotal: number;
    }>;
    readonly checks: Readonly<{ nonEmpty: boolean; requiredTermsPresent: boolean; forbiddenTermsAbsent: boolean }>;
}

export interface SkillSampleMetricDelta {
    readonly characterCount: number;
    readonly sentenceCount: number;
    readonly meanSentenceLength: number;
    readonly dialogueRatio: number;
    readonly repetitionRatio: number;
    readonly requiredTermsMatched: number;
    readonly forbiddenTermsMatched: number;
}

export type SkillSampleGoalObservation = Readonly<{
    goal: string; measurement: 'dialogue-ratio-proxy' | 'sentence-length-proxy'; delta: number;
}> | Readonly<{ goal: string; measurement: 'unmeasured' }>;

export interface SkillSampleOfflineReceipt {
    readonly receiptVersion: typeof SKILL_SAMPLE_OFFLINE_VERSION;
    readonly algorithmVersion: typeof SKILL_SAMPLE_OFFLINE_ALGORITHM;
    readonly rubricDigest: string;
    readonly sourcePacketDigest: string;
    readonly arms: Readonly<{ baseline: SkillSampleTextMetrics; candidate: SkillSampleTextMetrics }>;
    readonly delta: SkillSampleMetricDelta;
    readonly goalObservations: readonly SkillSampleGoalObservation[];
    readonly executionClass: 'fixture';
    readonly effectOutcome: 'unknown';
    readonly literaryQuality: 'unmeasured';
    readonly promotionEligible: false;
    readonly evidenceDigest: string;
}


function ratio(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
}


function escaped(points: readonly string[], index: number): boolean {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && points[cursor] === '\\'; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
}


/** Only correctly nested, completed Chinese pairs and unescaped ASCII double quotes count; union avoids overlap. */
function quotedPositions(points: readonly string[]): ReadonlySet<number> {
    const stack: { close: string; start: number }[] = [];
    const ranges: [number, number][] = [];
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        if (point === '"' && escaped(points, index)) continue;
        if (stack.at(-1)?.close === point) {
            const open = stack.pop()!;
            ranges.push([open.start + 1, index]);
        } else if (QUOTE_CLOSE[point] !== undefined) {
            stack.push({ close: QUOTE_CLOSE[point]!, start: index });
        }
    }
    const boundaries = new Int32Array(points.length + 1);
    for (const [start, end] of ranges) {
        boundaries[start] += 1;
        boundaries[end] -= 1;
    }
    const positions = new Set<number>();
    let depth = 0;
    for (let index = 0; index < points.length; index += 1) {
        depth += boundaries[index]!;
        if (depth > 0) positions.add(index);
    }
    return positions;
}


/** NFKC code points, not UTF-16 units; whitespace/quote marks are excluded from the sentence and dialogue pools. */
function measureText(text: string, requiredTerms: readonly string[], forbiddenTerms: readonly string[]) {
    const normalized = text.normalize('NFKC');
    const points = [...normalized];
    if (points.length > MAX_NORMALIZED_CODEPOINTS) throw new Error('skill-sample-offline-text-too-large');
    const prose = points.filter((point) => !WHITESPACE.test(point) && !QUOTE_MARK.test(point));
    const sentenceNumerator = prose.filter((point) => !TERMINAL.test(point)).length;
    const sentenceCount = normalized.split(/[。！？.!?]+/u)
        .filter((part) => [...part].some((point) => !WHITESPACE.test(point) && !QUOTE_MARK.test(point))).length;
    const quotes = quotedPositions(points);
    const dialogueNumerator = points.filter((point, index) => quotes.has(index)
        && !WHITESPACE.test(point) && !QUOTE_MARK.test(point)).length;
    const bigrams = prose.slice(1).map((point, index) => `${prose[index]}${point}`);
    const repeatedBigramCount = bigrams.length - new Set(bigrams).size;
    const requiredMatched = requiredTerms.filter((term) => normalized.includes(term.normalize('NFKC'))).length;
    const forbiddenMatched = forbiddenTerms.filter((term) => normalized.includes(term.normalize('NFKC'))).length;
    return {
        textDigest: evalRawDigest(text), characterCount: points.length, sentenceCount,
        sentenceLength: {
            numerator: sentenceNumerator, denominator: sentenceCount,
            mean: ratio(sentenceNumerator, sentenceCount)
        },
        dialogue: {
            numerator: dialogueNumerator, denominator: prose.length,
            ratio: ratio(dialogueNumerator, prose.length)
        },
        repetition: {
            bigramCount: bigrams.length, repeatedBigramCount,
            ratio: ratio(repeatedBigramCount, bigrams.length)
        },
        terms: {
            requiredMatched, requiredTotal: requiredTerms.length, forbiddenMatched,
            forbiddenTotal: forbiddenTerms.length
        },
        checks: {
            nonEmpty: prose.length > 0, requiredTermsPresent: requiredMatched === requiredTerms.length,
            forbiddenTermsAbsent: forbiddenMatched === 0
        },
    };
}


function metricDelta(baseline: SkillSampleTextMetrics, candidate: SkillSampleTextMetrics): SkillSampleMetricDelta {
    return {
        characterCount: candidate.characterCount - baseline.characterCount,
        sentenceCount: candidate.sentenceCount - baseline.sentenceCount,
        meanSentenceLength: candidate.sentenceLength.mean - baseline.sentenceLength.mean,
        dialogueRatio: candidate.dialogue.ratio - baseline.dialogue.ratio,
        repetitionRatio: candidate.repetition.ratio - baseline.repetition.ratio,
        requiredTermsMatched: candidate.terms.requiredMatched - baseline.terms.requiredMatched,
        forbiddenTermsMatched: candidate.terms.forbiddenMatched - baseline.terms.forbiddenMatched,
    };
}


function goalObservations(goals: readonly string[], delta: SkillSampleMetricDelta): SkillSampleGoalObservation[] {
    return goals.map((goal) => {
        if (goal === 'dialogue-focused') {
            return { goal, measurement: 'dialogue-ratio-proxy', delta: delta.dialogueRatio };
        }
        if (goal === 'brisk-pace' || goal === 'restrained-pace') {
            return { goal, measurement: 'sentence-length-proxy', delta: delta.meanSentenceLength };
        }
        return { goal, measurement: 'unmeasured' };
    });
}


/** Rejects altered/truncated packets before measurement; input metrics never acquire authority. */
export function evaluateSkillSampleOffline(input: unknown): SkillSampleOfflineReceipt {
    const packet = normalizeSkillSamplePacket(input);
    const { fixture } = packet.plan;
    const goals = packet.plan.source.compilePacket.spec.goals;
    const baseline = measureText(packet.arms[0].text, fixture.requiredTerms, fixture.forbiddenTerms);
    const candidate = measureText(packet.arms[1].text, fixture.requiredTerms, fixture.forbiddenTerms);
    const delta = metricDelta(baseline, candidate);
    const core = {
        receiptVersion: SKILL_SAMPLE_OFFLINE_VERSION, algorithmVersion: SKILL_SAMPLE_OFFLINE_ALGORITHM,
        rubricDigest: evalDigest({
            algorithmVersion: SKILL_SAMPLE_OFFLINE_ALGORITHM,
            fixtureSetDigest: packet.plan.fixtureSetDigest, fixtureId: fixture.fixtureId,
            fixtureRevision: fixture.revision, goals, requiredTerms: fixture.requiredTerms,
            forbiddenTerms: fixture.forbiddenTerms
        }),
        sourcePacketDigest: packet.packetDigest, arms: { baseline, candidate }, delta,
        goalObservations: goalObservations(goals, delta), executionClass: 'fixture' as const,
        effectOutcome: 'unknown' as const, literaryQuality: 'unmeasured' as const, promotionEligible: false as const,
    };
    return evalFreeze({ ...core, evidenceDigest: evalDigest(core) });
}
