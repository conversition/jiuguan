import type { MaintenanceSnapshot } from './maintenance-harness-service.ts';
import type { MaintenanceTaskKind } from './maintenance-types.ts';

export interface MaintenanceSessionReader {
  getHistory(): Array<{ id: number; round: number; role: string; content: string }>;
  getStateRows(): Array<{ entity_type: string; entity_id: string; state_json: string; updated_round: number }>;
  getArcRows(): Array<{ code: string; chapter: string; title: string; summary: string; status: string }>;
  getMeta(): { plot_round: number; bars: string; stage: string } | null;
  getVariables(): { values: Record<string, string | number | boolean> };
  getCharacterProjections(): unknown[];
  getSessionConfig(): { worldbooks: string[] };
}

function text(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

function boundedRows(rows: readonly unknown[], maxChars: number, maxItems: number): unknown[] {
  const output: unknown[] = [];
  let used = 2;
  for (const row of rows.slice(-maxItems)) {
    let encoded: string;
    try { encoded = JSON.stringify(row); } catch { continue; }
    if (encoded.length > 4_096 || used + encoded.length + 1 > maxChars) continue;
    output.push(JSON.parse(encoded));
    used += encoded.length + 1;
  }
  return output;
}

function boundedVariables(values: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  let used = 2;
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).slice(0, 100)) {
    const safeKey = text(key, 160);
    const safeValue = typeof value === 'string' ? value.slice(0, 1_000) : value;
    const encoded = JSON.stringify([safeKey, safeValue]);
    if (used + encoded.length + 1 > 12_000) break;
    output[safeKey] = safeValue;
    used += encoded.length + 1;
  }
  return output;
}

/**
 * 只读、确定性、有界的后台上下文。它不包含 Provider 凭据、插件配置或完整 prompt，
 * 且每一类工具种子都控制在 ToolRegistry 的 16KiB 结果上限以内。
 */
export function buildMaintenanceSessionSnapshot(input: {
  readonly session: MaintenanceSessionReader;
  readonly sessionId: string;
  readonly revision: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly allowedArcIds?: readonly string[];
  readonly worldbookEntries?: readonly unknown[];
}): MaintenanceSnapshot {
  const history = input.session.getHistory().slice(-16).map((row) => ({
    id: row.id,
    round: row.round,
    role: text(row.role, 32),
    content: text(row.content, 800),
  }));
  const states = input.session.getStateRows().slice(-32).map((row) => ({
    type: text(row.entity_type, 80),
    id: text(row.entity_id, 160),
    state: text(row.state_json, 500),
    round: row.updated_round,
  }));
  const arcs = input.session.getArcRows().slice(-32).map((row) => ({
    code: text(row.code, 80), chapter: text(row.chapter, 120), title: text(row.title, 240),
    summary: text(row.summary, 500), status: text(row.status, 40),
  }));
  const rawCharacterProjections = input.session.getCharacterProjections();
  const characters = boundedRows(rawCharacterProjections, 3_000, 24);
  const sourceRefs = history.map((row) => `msg:${row.id}`);
  const maxRound = Math.max(1, ...history.map((row) => row.round));
  const proposalContext = input.taskKind === 'branch_index'
    && (input.allowedArcIds?.length ?? 0) > 0 && sourceRefs.length > 0
    ? {
      sessionId: input.sessionId,
      sourceRevision: input.revision,
      allowedArcIds: Object.freeze([...new Set(input.allowedArcIds)].sort()),
      allowedSourceRefs: Object.freeze([...sourceRefs]),
      maxRound,
    }
    : input.taskKind === 'npc_state' && sourceRefs.length > 0
      ? (() => {
        const rows = rawCharacterProjections.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const row = value as Record<string, unknown>;
          return typeof row.characterId === 'string' && Number.isSafeInteger(row.entityVersion)
            && (row.entityVersion as number) >= 0
            ? [{ characterId: row.characterId, entityVersion: row.entityVersion as number }] : [];
        }).sort((left, right) => left.characterId.localeCompare(right.characterId)).slice(0, 64);
        if (rows.length < 1 || new Set(rows.map((row) => row.characterId)).size !== rows.length) return undefined;
        return {
          sessionId: input.sessionId,
          sourceRevision: input.revision,
          allowedCharacterIds: Object.freeze(rows.map((row) => row.characterId)),
          allowedSourceRefs: Object.freeze([...sourceRefs]),
          expectedEntityVersions: Object.freeze(Object.fromEntries(
            rows.map((row) => [row.characterId, row.entityVersion]),
          )),
          maxRound,
        };
      })()
      : undefined;
  const memory = {
    recentHistory: boundedRows(history, 7_000, 16),
    states: boundedRows(states, 3_000, 32),
    arcs: boundedRows(arcs, 2_500, 32),
    characters,
    meta: input.session.getMeta(),
  };
  const worldbooks = input.worldbookEntries === undefined
    ? input.session.getSessionConfig().worldbooks.slice(0, 32).map((name) => ({ name: text(name, 240) }))
    : boundedRows(input.worldbookEntries, 12_000, 64);
  return {
    revision: input.revision,
    state: {
      memory,
      worldbook: worldbooks,
      variables: boundedVariables(input.session.getVariables().values),
    },
    userMessage: JSON.stringify({
      taskKind: input.taskKind,
      sourceRevision: input.revision,
      proposalContext,
      instruction: '读取必要上下文并提交一份有类型的维护提案；不要复述原文。',
    }),
    ...(proposalContext ? { proposalContext } : {}),
  };
}
