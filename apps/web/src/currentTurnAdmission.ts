/** Read only the exact active run; a previous run in the same round is never substituted. */
import { authFetch } from './authClient.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';

type Active = { active: true; runId: string; round: number; startedAt: number };
type Decision = Readonly<{ verdict: 'would-admit' | 'would-deny'; reasonCodes: readonly string[] }>;
export type CurrentTurnAdmission = Readonly<{ state: 'idle' }> | Readonly<{
  state: 'active'; round: number; decisions: readonly Decision[];
}>;
function readGeneration(value: unknown): Active | null {
  const generation = (value as { generation?: unknown } | null)?.generation;
  if (!generation || typeof generation !== 'object' || Array.isArray(generation)) throw new Error('current-turn-response-invalid');
  const row = generation as Record<string, unknown>;
  if (row.active === false) return null;
  if (row.active !== true || typeof row.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(row.runId)
    || !Number.isSafeInteger(row.round) || Number(row.round) < 1 || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 1) {
    throw new Error('current-turn-response-invalid');
  }
  return { active: true, runId: row.runId, round: Number(row.round), startedAt: Number(row.startedAt) };
}
export async function readCurrentTurnAdmission(sessionId: string, signal: AbortSignal,
  fetcher: typeof authFetch = authFetch): Promise<CurrentTurnAdmission> {
  const stateUrl = `/api/session/${encodeURIComponent(sessionId)}/turn-state`;
  const get = async (url: string) => {
    const response = await fetchWithInactivityTimeout(
      requestSignal => fetcher(url, { signal: requestSignal, cache: 'no-store' }), 12_000, signal);
    if (!response.ok) throw new Error(`current-turn-http-${response.status}`);
    return response.json() as Promise<unknown>;
  };
  const active = readGeneration(await get(stateUrl));
  if (!active) return Object.freeze({ state: 'idle' });
  const query = new URLSearchParams({ sessionId, runId: active.runId, limit: '128' });
  const raw = await get(`/api/agent/admission-decisions?${query}`) as { decisions?: unknown };
  if (!raw || !Array.isArray(raw.decisions) || raw.decisions.length > 128) throw new Error('current-turn-response-invalid');
  const decisions = raw.decisions.map((value: unknown): Decision => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('current-turn-response-invalid');
    const row = value as Record<string, unknown>;
    if (row.sessionId !== sessionId || row.runId !== active.runId || row.round !== active.round
      || !['would-admit', 'would-deny'].includes(String(row.verdict)) || !Array.isArray(row.reasonCodes)
      || row.reasonCodes.length > 64 || row.reasonCodes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(code))) {
      throw new Error('current-turn-response-invalid');
    }
    return Object.freeze({ verdict: row.verdict as Decision['verdict'], reasonCodes: Object.freeze([...row.reasonCodes] as string[]) });
  });
  const current = readGeneration(await get(stateUrl));
  if (!current || current.runId !== active.runId || current.round !== active.round || current.startedAt !== active.startedAt) {
    throw new Error('current-turn-source-changed');
  }
  return Object.freeze({ state: 'active', round: active.round, decisions: Object.freeze(decisions) });
}
