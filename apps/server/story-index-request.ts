export type StoryIndexRequestParseResult =
  | { ok: true; round: number; force: boolean }
  | { ok: false; error: string };

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict POST contract for the model-backed story index endpoint. */
export function parseStoryIndexPostBody(value: unknown): StoryIndexRequestParseResult {
  if (!isJsonRecord(value)) {
    return { ok: false, error: '剧情索引请求体必须是 JSON 对象' };
  }
  if (Object.keys(value).some((key) => key !== 'round' && key !== 'force')) {
    return { ok: false, error: '剧情索引请求包含未知字段' };
  }
  if (typeof value.round !== 'number' || !Number.isSafeInteger(value.round) || value.round < 1) {
    return { ok: false, error: 'round 必须是大于等于 1 的安全整数' };
  }
  if (value.force !== undefined && typeof value.force !== 'boolean') {
    return { ok: false, error: 'force 必须是布尔值' };
  }
  return { ok: true, round: value.round, force: value.force === true };
}
