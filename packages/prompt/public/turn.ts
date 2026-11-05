/** @author Codex @date 2026-10-15 @version 1.0
 * Public deterministic turn validation functions for cross-workspace output contracts.
 */
export { GameTurnSchema, normalizeTurn, safeParseTurn, validateGameTurn, parseStoryIndexSeed, gameTurnTool } from '../src/turn.ts';
export type { GameTurn } from '../src/turn.ts';
export { getGameTurnRepairIssues, canRepairGameTurn, applyGameTurnRepairPatch } from '../src/turn-repair.ts';
export type { GameTurnRepairIssue, GameTurnRepairPatch } from '../src/turn-repair.ts';
