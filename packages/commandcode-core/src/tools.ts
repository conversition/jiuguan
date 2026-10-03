/*
 * Adapted from commandcode-proxy 1.0.0 (proxy.mjs).
 * Copyright (c) 2026 MAXeaglet.
 * SPDX-License-Identifier: MIT
 * Jiuguan modifications: see ../NOTICE.md.
 */

const TOOL_NAME_ALIASES = new Map<string, string>([
  ['bash_output', 'shell_output'],
  ['task_output', 'shell_output'],
  ['tool_search', 'search_tools'],
  ['read_multiple_files', 'read_file'],
]);

export function toWireToolName(name: string): string {
  return TOOL_NAME_ALIASES.get(name) ?? name;
}

export function toWireToolOutputValue(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: 'text'; text?: unknown } => (
        Boolean(item)
        && typeof item === 'object'
        && (item as { type?: unknown }).type === 'text'
      ))
      .map((item) => item.text == null ? '' : String(item.text))
      .join('\n');
  }
  return content == null ? '' : String(content);
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
