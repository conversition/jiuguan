/** Deterministic frames of the same trusted graphic used by the browser player. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { renderDirectorGraphic } from '../../packages/core/public/director-board-render.ts';
import type { DirectorGraphic } from '../../packages/core/public/director-board-render.ts';
import type { SequencePlan } from './director-sequence-plan.ts';

export interface DirectorVisualFrame { readonly timeMs: number; readonly digest: string; readonly png: Buffer }
export async function renderDirectorGraphicFrames(shots: readonly (DirectorGraphic & { startMs: number; durationMs: number })[]): Promise<DirectorVisualFrame[]> {
    if (shots.length < 1 || shots.length > 40) throw new Error('director-visual-frame-limit');
    const frames: DirectorVisualFrame[] = [];
    let totalBytes = 0;
    for (const shot of shots) {
        if (!Number.isInteger(shot.startMs) || shot.startMs < 0 || !Number.isInteger(shot.durationMs) || shot.durationMs < 2)
            throw new Error('director-visual-frame-time-invalid');
        // Sample the first and last playable millisecond. Interior quartiles
        // omit arrival/contact and hide state jumps across a cut. Keep two
        // frames per shot and the same half-open interval as the browser player.
        for (const offset of [0, shot.durationMs - 1]) {
            const progress = offset / shot.durationMs;
            const svg = renderDirectorGraphic(shot, progress, true);
            const png = await sharp(Buffer.from(svg), { limitInputPixels: 600000 }).png().toBuffer();
            totalBytes += png.length;
            if (png.length > 1024 * 1024 || totalBytes > 12 * 1024 * 1024) throw new Error('director-visual-frame-limit');
            frames.push({ timeMs: shot.startMs + offset, digest: `sha256:${createHash('sha256').update(png).digest('hex')}`, png });
        }
    }
    return frames;
}
export async function renderDirectorVisualFrames(plan: SequencePlan): Promise<DirectorVisualFrame[]> {
    return renderDirectorGraphicFrames(plan.shots);
}
