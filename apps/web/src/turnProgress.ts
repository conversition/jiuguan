import { isTurnProgress, type TurnProgress, type TurnProgressPhase } from '../../../packages/mobile-contracts/public/turn-progress.ts';

const LABELS: Readonly<Record<TurnProgressPhase, string>> = Object.freeze({
  planning: '正在整理需求', compiling: '正在整理上下文', repairing: '正在修订候选',
  validating: '正在检查要求', committing: '正在保存结果',
});
export const turnProgressLabel = (phase: TurnProgressPhase): string => LABELS[phase];
export function readTurnProgressEvent(value: unknown): TurnProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'phase,runId,type' || row.type !== 'progress') return null;
  const progress = { runId: row.runId, phase: row.phase };
  return isTurnProgress(progress) ? progress : null;
}
export { isTurnProgress };
export type { TurnProgress };
