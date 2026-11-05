/** @author Codex @date 2026-10-20 @version 1.1
 * Explicit delivery selection; this configuration does not grant model or write authority.
 */
import { parseStyleCompilePilotPolicy, type StyleCompilePilotPolicy } from './style-compile-pilot.ts';

export type StyleCompileDelivery = 'sync' | 'background';

export interface StyleCompileRuntimeConfig {
  readonly pilot?: StyleCompilePilotPolicy;
  readonly delivery: StyleCompileDelivery;
  readonly enabled: boolean;
  readonly intervalMs: 30_000;
  readonly leaseMs: 300_000;
  readonly sessionPageSize: 8;
  readonly intentPageSize: 32;
  readonly jobsPerTick: 4;
}

/**
 * Parse once at startup and capture delivery when constructing each Session. Changing delivery
 * requires a restart, not mutation of an in-flight turn. The host separately rechecks the exact
 * live background selection before paid work and commit, and may always perform read-only
 * settlement reconciliation. Neither a mode switch nor these scheduling limits grant retries.
 *
 * Defaults to the existing synchronous path. Deliberately reject blank values, aliases, case
 * folding and whitespace so a malformed production configuration cannot silently select a path.
 */
export function parseStyleCompileRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StyleCompileRuntimeConfig {
  const rawDelivery = env.JG_STYLE_COMPILE_DELIVERY;
  const delivery = rawDelivery === undefined ? 'sync' : rawDelivery;
  if (delivery !== 'sync' && delivery !== 'background') {
    throw new TypeError('style-compile-delivery-invalid');
  }
  const pilot = parseStyleCompilePilotPolicy(env.JG_STYLE_COMPILE_PILOT);
  return Object.freeze({
    ...(pilot ? { pilot } : {}),
    delivery,
    enabled: delivery === 'background',
    intervalMs: 30_000,
    leaseMs: 300_000,
    sessionPageSize: 8,
    intentPageSize: 32,
    jobsPerTick: 4,
  });
}
