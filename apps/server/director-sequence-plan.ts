/** Versioned data for a selected treatment and reconstructible scene plan. */
import { z } from 'zod';
import { creativeToken, creativeDigest, sceneMaterialSchema, assertMaterial, initialMaterial,
    type CreativePolicy, type DirectorSourceSnapshot } from './director-creative-contract.ts';

const text = z.string().trim().min(1).max(1000);
const ref = z.string().regex(/^message:[1-9][0-9]*$/u);
const point = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
const axisName = z.enum(['viewpoint', 'reveal', 'tempo', 'staging', 'performance']);
const geometry = z.array(z.object({ kind: z.enum(['rect', 'ellipse', 'line', 'door', 'lamp', 'cup', 'letter', 'staff']), label: text,
    from: point, to: point, tone: z.enum(['neutral', 'warm', 'light', 'shadow']).optional(),
    motion: z.object({ dx: z.number().finite().min(-1).max(1), dy: z.number().finite().min(-1).max(1),
        rotate: z.number().finite().min(-180).max(180) }).strict().optional() }).strict()).min(1).max(20);
const figures = z.array(z.object({ id: creativeToken, label: text, from: point, to: point, gaze: point,
    posture: z.enum(['standing', 'sitting']).optional(), gesture: z.enum(['reach', 'guard']).optional(),
    handMotion: z.object({ from: point, to: point }).strict().optional() }).strict()).max(12);
const sample = z.object({ axis: axisName, sourceRef: ref, durationMs: z.number().int().min(100).max(120000),
    geometry, figures }).strict();
const treatment = z.object({ id: creativeToken, intent: text, value: text, initialKnowledge: text,
    reveal: text, ending: text, staging: text, visual: text, sacrifice: text, risk: text,
    comparisonSamples: z.array(sample).min(2).max(5) }).strict();
const axis = z.object({ axis: axisName,
    sourceRef: ref, a: text, b: text, expectedDifference: text, comparisonFragment: text }).strict();
const action = z.object({ id: creativeToken, participants: z.array(creativeToken).max(12), goal: text,
    start: text, movement: text, end: text, performance: text, worldRules: z.array(text).max(12) }).strict();
const shot = z.object({ id: creativeToken, purpose: text, actionRefs: z.array(creativeToken).max(20),
    composition: text, visible: text, pose: text, entryExit: text, camera: text, gaze: text, cutReason: text,
    startMs: z.number().int().nonnegative().max(600000), durationMs: z.number().int().min(100).max(120000),
    durationBasis: z.literal('estimated'), background: text,
    geometry, figures,
}).strict();
export const sequencePlanSchema = z.object({ schemaVersion: z.literal('sequence-plan-v1'),
    treatments: z.tuple([treatment, treatment]), differences: z.array(axis).min(2).max(5),
    selectedTreatmentId: creativeToken, selectionReason: text,
    protectedBeatRefs: z.array(ref).min(1).max(128), space: z.array(text).min(1).max(20),
    actionUnits: z.array(action).min(1).max(40), shots: z.array(shot).min(1).max(40),
    audio: z.array(z.object({ kind: z.enum(['dialogue', 'ambience', 'action', 'music', 'silence']),
        startMs: z.number().int().nonnegative().max(600000), durationMs: z.number().int().min(1).max(600000), description: text }).strict()).max(80),
    audienceKnowledge: z.array(text).min(1).max(40), transitions: z.array(text).max(40),
    visualPerformanceRules: z.array(text).min(1).max(20),
    additions: sceneMaterialSchema.shape.additions,
    advice: z.array(z.object({ summary: text, accepted: z.boolean(), reason: text, impact: text }).strict()).max(20),
}).strict();
export type SequencePlan = z.infer<typeof sequencePlanSchema>;
export function acceptedSceneContext(plan: SequencePlan) {
    const selected = plan.treatments.find(item => item.id === plan.selectedTreatmentId);
    if (!selected) throw new Error('director-plan-invalid');
    return { selectedTreatmentId: selected.id, intent: selected.intent, selectionReason: plan.selectionReason,
        space: plan.space, audienceKnowledge: plan.audienceKnowledge, visualPerformanceRules: plan.visualPerformanceRules };
}
export function renderDirectorStoryboard(plan: SequencePlan): string {
    const chosen = plan.treatments.find(item => item.id === plan.selectedTreatmentId);
    if (!chosen) throw new Error('director-plan-invalid');
    return [`# 分镜草稿`, `意图：${chosen.intent}`, `选择理由：${plan.selectionReason}`,
        ...plan.shots.map(shot => `\n## ${shot.id} · ${shot.startMs}–${shot.startMs + shot.durationMs} ms（估算）\n${shot.purpose}\n构图：${shot.composition}\n摄影机：${shot.camera}\n画面：${shot.visible}`)].join('\n');
}

export function assertSequencePlan(input: unknown, source: DirectorSourceSnapshot, policy: CreativePolicy): SequencePlan {
    const plan = sequencePlanSchema.parse(input);
    assertMaterial({ ...initialMaterial(), additions: plan.additions }, source, policy);
    const refs = new Set(source.messages.map(message => message.ref));
    const [a, b] = plan.treatments;
    const unique = (items: readonly string[]) => new Set(items).size === items.length;
    const invalidMotion = (shape: z.infer<typeof geometry>[number]) => !!shape.motion &&
        [shape.from, shape.to].some(p => p.x + shape.motion!.dx < 0 || p.x + shape.motion!.dx > 1
            || p.y + shape.motion!.dy < 0 || p.y + shape.motion!.dy > 1);
    if (a.id === b.id) throw new Error('director-plan-invalid-treatment-ids');
    if (![a.id, b.id].includes(plan.selectedTreatmentId)) throw new Error('director-plan-invalid-selection');
    if (new Set(plan.differences.map(item => item.axis)).size !== plan.differences.length)
        throw new Error('director-plan-invalid-axes');
    if (plan.differences.some(item => item.a === item.b)) throw new Error('director-plan-invalid-identical-difference');
    if (plan.differences.some(item => !refs.has(item.sourceRef)) || plan.protectedBeatRefs.some(item => !refs.has(item)))
        throw new Error('director-plan-invalid-source-ref');
    if (!unique(plan.actionUnits.map(item => item.id)) || !unique(plan.shots.map(item => item.id)))
        throw new Error('director-plan-invalid-duplicate-id');
    for (const t of plan.treatments) {
        if (!unique(t.comparisonSamples.map(item => item.axis))) throw new Error('director-comparison-invalid-duplicate-axis');
        if (t.comparisonSamples.some(item => !plan.differences.some(d => d.axis === item.axis && d.sourceRef === item.sourceRef)))
            throw new Error('director-comparison-invalid-source');
        if (t.comparisonSamples.some(item => item.geometry.some(shape => invalidMotion(shape) || ((shape.kind === 'line' || shape.kind === 'staff')
                ? shape.from.x === shape.to.x && shape.from.y === shape.to.y
                : shape.from.x === shape.to.x || shape.from.y === shape.to.y)))) throw new Error('director-comparison-invalid-geometry');
        if (t.comparisonSamples.some(item => !unique(item.figures.map(figure => figure.id))
                || item.figures.some(figure => figure.handMotion && figure.gesture !== 'reach')))
            throw new Error('director-comparison-invalid-figures');
    }
    const comparable = plan.differences.filter(d => {
        const first = a.comparisonSamples.find(item => item.axis === d.axis && item.sourceRef === d.sourceRef);
        const second = b.comparisonSamples.find(item => item.axis === d.axis && item.sourceRef === d.sourceRef);
        const visibleHand = (figure: z.infer<typeof figures>[number]) => {
            if (figure.gesture !== 'reach') return undefined;
            const rounded = (value: number) => Math.round(value * 1e9) / 1e9;
            return [0, .5, 1].map(progress => {
                const x = figure.from.x + (figure.to.x - figure.from.x) * progress;
                const y = figure.from.y + (figure.to.y - figure.from.y) * progress;
                return figure.handMotion
                    ? { x: rounded(figure.handMotion.from.x + (figure.handMotion.to.x - figure.handMotion.from.x) * progress),
                        y: rounded(figure.handMotion.from.y + (figure.handMotion.to.y - figure.handMotion.from.y) * progress) }
                    : { x: rounded(x + (figure.gaze.x < x ? -.048 : .048)), y: rounded(y + .06) };
            });
        };
        const visible = (item: z.infer<typeof sample>) => ({ durationMs: item.durationMs,
            geometry: item.geometry.map(({ kind, from, to, tone, motion }) => ({ kind, from, to, tone: tone ?? 'neutral', motion: motion ?? { dx: 0, dy: 0, rotate: 0 } })),
            figures: item.figures.map(figure => ({ from: figure.from, to: figure.to, gaze: figure.gaze,
                posture: figure.posture, gesture: figure.gesture, hand: visibleHand(figure) })) });
        return first && second && creativeDigest(visible(first)) !== creativeDigest(visible(second));
    });
    if (new Set(comparable.map(item => item.axis)).size < 2) throw new Error('director-comparison-invalid-distinct-axes');
    // Every shared sample is eligible in the player; none may be visually identical.
    const shared = plan.differences.filter(d => a.comparisonSamples.some(s => s.axis === d.axis && s.sourceRef === d.sourceRef)
        && b.comparisonSamples.some(s => s.axis === d.axis && s.sourceRef === d.sourceRef));
    if (shared.length !== comparable.length) throw new Error('director-comparison-invalid-identical-sample');
    const actions = new Set(plan.actionUnits.map(item => item.id));
    let end = 0;
    for (const shot of plan.shots) {
        if (shot.figures.some(figure => figure.handMotion && figure.gesture !== 'reach'))
            throw new Error('director-plan-figure-invalid');
        if (shot.startMs !== end || shot.actionRefs.some(item => !actions.has(item)) || !unique(shot.figures.map(item => item.id)))
            throw new Error('director-plan-timeline-invalid');
        if (shot.geometry.some(shape => invalidMotion(shape) || ((shape.kind === 'line' || shape.kind === 'staff')
            ? shape.from.x === shape.to.x && shape.from.y === shape.to.y
            : shape.from.x === shape.to.x || shape.from.y === shape.to.y))) throw new Error('director-plan-geometry-invalid');
        end += shot.durationMs;
        if (end > 600000) throw new Error('director-plan-timeline-invalid');
    }
    if (plan.audio.some(cue => cue.startMs + cue.durationMs > end)) throw new Error('director-plan-timeline-invalid');
    return plan;
}
