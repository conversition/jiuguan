import { createHash } from 'node:crypto';

export interface StoryIndexPresetBlock {
  readonly name: string;
  readonly content: string;
}

export interface StoryIndexPresetVariable {
  readonly name: string;
  readonly value: string;
}

export interface StoryIndexPresetProjection {
  readonly text: string;
  readonly digest: string;
  readonly sourceCount: number;
  readonly chars: number;
}

const STORY_INDEX_PRESET_MAX_CHARS = 2_400;
const RELEVANT_BLOCK = /(?:内容|边界|角色|扮演|叙事|剧情|故事|文风|风格|禁忌|content|roleplay|character|narrative|story|style)/iu;
const CONFLICTING_BLOCK = /(?:game[_ .-]?turn|emit[_ .-]?story|工具调用|tool[_ .-]?call|输出格式|json|xml|html|mvu|状态栏|变量更新|字数|扩写|转述|思维链|推理过程|chain[_ .-]?of[_ .-]?thought|reasoning effort)/iu;
const CONTENT_POLICY_VARIABLE = /^(?:jailbreakprompt|contentpolicy|contentmode|roleplaypolicy|创作边界|内容边界)$/iu;
const CONFLICTING_VARIABLE = /(?:core|cot|think|reason|format|template|tool|json|xml|思维|推理|格式|字数)/iu;

function boundedAppend(parts: string[], label: string, raw: string, remaining: number): number {
  if (remaining <= 0) return 0;
  const clean = raw.trim().replace(/<\/?preset_compatibility_shell\b/giu, (token) => token.replace('<', '&lt;'));
  if (!clean) return remaining;
  const prefix = `[${label}]\n`;
  if (remaining <= prefix.length) return 0;
  const content = clean.slice(0, remaining - prefix.length);
  parts.push(`${prefix}${content}`);
  return remaining - prefix.length - content.length;
}

/**
 * Projects only the preset's content/roleplay compatibility boundary into the story-index call.
 * Main-prose expansion, CoT, formatting, tool and variable-update instructions are deliberately
 * excluded because they conflict with the story-index response contract.
 */
export function projectStoryIndexPreset(input: {
  readonly blocks: readonly StoryIndexPresetBlock[];
  readonly variables: readonly StoryIndexPresetVariable[];
  readonly maxChars?: number;
}): StoryIndexPresetProjection {
  const limit = Math.max(0, Math.min(STORY_INDEX_PRESET_MAX_CHARS, input.maxChars ?? STORY_INDEX_PRESET_MAX_CHARS));
  const parts: string[] = [];
  let remaining = limit;
  let sourceCount = 0;

  for (const variable of input.variables) {
    if (remaining <= 0) break;
    if (!CONTENT_POLICY_VARIABLE.test(variable.name) || CONFLICTING_VARIABLE.test(variable.name)) continue;
    const before = remaining;
    remaining = boundedAppend(parts, `预设变量:${variable.name}`, variable.value, remaining);
    if (remaining < before) sourceCount += 1;
  }
  for (const block of input.blocks) {
    if (remaining <= 0) break;
    const haystack = `${block.name}\n${block.content.slice(0, 600)}`;
    if (!RELEVANT_BLOCK.test(haystack) || CONFLICTING_BLOCK.test(haystack)) continue;
    const before = remaining;
    remaining = boundedAppend(parts, `预设块:${block.name}`, block.content, remaining);
    if (remaining < before) sourceCount += 1;
  }

  const body = parts.join('\n\n');
  const text = body
    ? `<preset_compatibility_shell trust="instruction" scope="content-and-roleplay-only">\n${body}\n</preset_compatibility_shell>\n`
      + '仅继承上方预设的内容许可、角色扮演与叙事边界；不得继承正文扩写、字数、思维链、变量更新或输出格式指令。'
    : '';
  return Object.freeze({
    text,
    digest: createHash('sha256').update(text).digest('hex'),
    sourceCount,
    chars: text.length,
  });
}

/** Accepts one JSON object, optionally wrapped in a single Markdown JSON fence. */
export function parseStoryIndexJsonObject(content: string | null): unknown | null {
  if (!content || content.length > 32_768) return null;
  let source = content.trim();
  const fenced = source.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/iu);
  if (fenced) source = fenced[1]!.trim();
  const start = source.indexOf('{');
  if (start < 0 || source.slice(0, start).trim()) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
      if (depth < 0) return null;
    }
  }
  if (end < 0 || inString || source.slice(end + 1).trim()) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}
