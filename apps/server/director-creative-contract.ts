/** Director R2 domain data. These records grant no RP, AL or Provider authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const DIRECTOR_PLAN_OUTPUT_TOKENS = 6144;


export function creativeDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
export const creativeToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = z.string().min(1).max(2000);
const refs = z.array(z.string().regex(/^message:[1-9][0-9]*$/u)).max(128);
export const creativePolicySchema = z.object({ allowL2: z.boolean(), approvedL3Digests: z.array(digest).max(32) }).strict();
export const sceneMaterialSchema = z.object({
    schemaVersion: z.literal('scene-material-v1'),
    boundary: z.enum(['scene', 'fragment', 'multiple-scenes', 'insufficient']),
    boundaryReason: text,
    assertions: z.array(z.object({ id: creativeToken, statement: text,
        epistemicStatus: z.enum(['confirmed', 'belief', 'interpretation', 'unknown', 'disputed']),
        perspective: text, evidenceRefs: refs, revealConstraints: z.array(text).max(16),
    }).strict()).max(64),
    protectedRefs: refs,
    unknowns: z.array(text).max(32),
    additions: z.array(z.object({ id: creativeToken, level: z.enum(['L1', 'L2', 'L3']),
        description: text, evidenceRefs: refs }).strict()).max(32),
}).strict();
export type SceneMaterial = z.infer<typeof sceneMaterialSchema>;
export type CreativePolicy = z.infer<typeof creativePolicySchema>;
export const creativeContinuitySchema = z.object({
    parentSessionId: creativeToken, parentRevision: z.number().int().positive(), parentPlanId: creativeToken,
    parentPlanDigest: digest, parentAcceptanceId: creativeToken, parentAcceptanceDigest: digest, parentSourceSnapshotRef: digest,
    accepted: z.object({ selectedTreatmentId: creativeToken, intent: text, selectionReason: text,
        space: z.array(text).min(1).max(20), audienceKnowledge: z.array(text).min(1).max(40),
        visualPerformanceRules: z.array(text).min(1).max(20) }).strict(),
}).strict();
export type CreativeContinuity = z.infer<typeof creativeContinuitySchema>;
export const sourceSnapshotSchema = z.object({
    schemaVersion: z.literal('director-source-snapshot-v1'), sessionId: creativeToken,
    partition: z.enum(['nsf', 'nsfw']), safetyDigest: digest.optional(), firstRound: z.number().int().positive(), lastRound: z.number().int().positive(),
    sourceSnapshotRef: digest, capturedAt: z.string().datetime(),
    authority: z.object({ generation: z.string(), revision: z.number().int().nonnegative() }).strict(),
    messages: z.array(z.object({ ref: z.string(), messageId: z.number().int().positive(),
        round: z.number().int().positive(), role: z.enum(['user', 'assistant']), content: z.string().max(65536),
        sourceRunId: creativeToken, proofDigest: digest, digest,
    }).strict()).min(2).max(128),
}).strict();
export type DirectorSourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export function assertSourceSnapshot(input: unknown): DirectorSourceSnapshot {
    const value = sourceSnapshotSchema.parse(input);
    if ((value.partition === 'nsfw') !== (value.safetyDigest !== undefined)
        || value.lastRound < value.firstRound || value.lastRound - value.firstRound >= 64
        || Buffer.byteLength(JSON.stringify(value)) > 262144
        || value.sourceSnapshotRef !== creativeDigest({ sessionId: value.sessionId, partition: value.partition,
            firstRound: value.firstRound, lastRound: value.lastRound, messages: value.messages,
            ...(value.safetyDigest ? { safetyDigest: value.safetyDigest } : {}) }))
        throw new Error('director-source-invalid');
    return value;
}
export function assertMaterial(input: unknown, source: DirectorSourceSnapshot, policy: CreativePolicy): SceneMaterial {
    const value = sceneMaterialSchema.parse(input), allowed = new Set(source.messages.map(item => item.ref));
    const allRefs = [...value.protectedRefs, ...value.assertions.flatMap(item => item.evidenceRefs),
        ...value.additions.flatMap(item => item.evidenceRefs)];
    if (allRefs.some(ref => !allowed.has(ref)) || new Set(value.assertions.map(item => item.id)).size !== value.assertions.length
        || new Set(value.additions.map(item => item.id)).size !== value.additions.length
        || value.assertions.some(item => ['confirmed', 'belief', 'interpretation'].includes(item.epistemicStatus) && !item.evidenceRefs.length))
        throw new Error('director-material-reference-invalid');
    for (const addition of value.additions) {
        if (addition.level === 'L2' && !policy.allowL2
            || addition.level === 'L3' && !policy.approvedL3Digests.includes(creativeDigest(addition)))
            throw new Error('director-addition-permission-denied');
    }
    return value;
}
export function initialMaterial(): SceneMaterial {
    return { schemaVersion: 'scene-material-v1', boundary: 'insufficient', boundaryReason: '材料已冻结，场景边界尚未评审。',
        assertions: [], protectedRefs: [], unknowns: ['人物动机、场景边界及改编选择尚未确定。'], additions: [] };
}
