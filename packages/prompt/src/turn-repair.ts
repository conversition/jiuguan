import { GameTurnSchema } from './turn.ts';

/** Private repair feedback: messages may contain model data and must not be logged. */
export interface GameTurnRepairIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}
export interface GameTurnRepairPatch {
  readonly path: readonly (string | number)[];
  readonly value: unknown;
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const primitive = (value: unknown): boolean => value === null || typeof value === 'string'
  || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const safePath = (path: readonly (string | number)[]): boolean => path.length > 0
  && path[0] !== 'prose' && path.length <= 32
  && path.every(part => typeof part === 'string' ? part.length > 0 && !forbidden.has(part)
    : Number.isSafeInteger(part) && part >= 0);

/** Exact paths and schema diagnostics for a private, bounded repair request. */
export function getGameTurnRepairIssues(candidate: unknown): GameTurnRepairIssue[] {
  const result = GameTurnSchema.safeParse(candidate);
  if (result.success) return [];
  return result.error.issues.map(issue => ({
    path: issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number'),
    code: issue.code, message: issue.message,
  }));
}

/** True only when every issue can be addressed by the restricted scalar patch contract. */
export function canRepairGameTurn(candidate: unknown): boolean {
  const result = GameTurnSchema.safeParse(candidate);
  if (result.success || !result.error.issues.length) return false;
  return result.error.issues.every(issue => {
    if (issue.path.some(part => typeof part !== 'string' && typeof part !== 'number')) return false;
    const path = issue.path as (string | number)[];
    if (!safePath(path)) return false;
    if (issue.code === 'invalid_type') {
      if (!['string', 'number', 'int', 'boolean'].includes(issue.expected)) return false;
    } else if (issue.code === 'invalid_value') {
      if (!issue.values.length || !issue.values.every(primitive)) return false;
    } else if (issue.code === 'too_small' || issue.code === 'too_big') {
      if (issue.origin !== 'string' && issue.origin !== 'number') return false;
    } else return false;
    let target: unknown = candidate;
    for (const part of path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) return false;
      target = (target as Record<string | number, unknown>)[part];
    }
    if (!target || typeof target !== 'object') return false;
    const last = path[path.length - 1]!;
    if (Array.isArray(target)) {
      if (typeof last !== 'number' || last >= target.length || !Object.hasOwn(target, last)) return false;
    } else if (typeof last !== 'string') return false;
    return !Object.hasOwn(target, last) || primitive((target as Record<string | number, unknown>)[last]);
  });
}

/** Apply only direct scalar error fields. The caller binds the candidate to the current run. */
export function applyGameTurnRepairPatch(candidate: unknown, patches: readonly GameTurnRepairPatch[]): unknown {
  const issues = getGameTurnRepairIssues(candidate);
  if (!issues.length || !Array.isArray(patches) || !patches.length || patches.length > issues.length)
    throw new Error('game-turn-repair-patch-invalid');
  const allowed = new Set(issues.filter(issue => safePath(issue.path)).map(issue => JSON.stringify(issue.path)));
  const seen = new Set<string>();
  const result = structuredClone(candidate);
  for (const patch of patches) {
    if (!patch || !Array.isArray(patch.path) || !safePath(patch.path) || !primitive(patch.value))
      throw new Error('game-turn-repair-patch-invalid');
    const key = JSON.stringify(patch.path);
    if (!allowed.has(key) || seen.has(key)) throw new Error('game-turn-repair-patch-path-invalid');
    seen.add(key);
    let target: unknown = result;
    for (const part of patch.path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, part))
        throw new Error('game-turn-repair-patch-path-invalid');
      target = (target as Record<string | number, unknown>)[part];
    }
    if (!target || typeof target !== 'object') throw new Error('game-turn-repair-patch-path-invalid');
    const last = patch.path[patch.path.length - 1]!;
    if (Array.isArray(target) && (typeof last !== 'number' || last >= target.length))
      throw new Error('game-turn-repair-patch-path-invalid');
    if (!Array.isArray(target) && typeof last !== 'string') throw new Error('game-turn-repair-patch-path-invalid');
    if (Object.hasOwn(target, last) && !primitive((target as Record<string | number, unknown>)[last]))
      throw new Error('game-turn-repair-patch-path-invalid');
    (target as Record<string | number, unknown>)[last] = patch.value;
  }
  if (!GameTurnSchema.safeParse(result).success) throw new Error('game-turn-repair-patch-schema-invalid');
  return result;
}
