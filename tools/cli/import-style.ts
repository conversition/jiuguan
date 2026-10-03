#!/usr/bin/env node
/**
 * Import style entries from a user-supplied SillyTavern worldbook into Jiuguan Skills.
 *
 * The public distribution intentionally has no default source path and no bundled style body.
 * Set JG_STYLE_SRC to a JSON file you own, and optionally JG_SKILLS_DIR to an isolated target.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SKILLS_DIR,
  syncStylesFromSource,
  type StyleSkillSpec,
} from '../../packages/core/src/skills.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeStyleName(label: string, fallback: string): string {
  return label
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim() || fallback;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/[|,，]/u) : [];
}

function entryToSpec(entry: Record<string, unknown>, sourceLabel: string, index: number): StyleSkillSpec {
  const label = String(entry.comment ?? entry.name ?? `style-${index + 1}`).trim();
  const uid = String(entry.uid ?? entry.id ?? index + 1);
  const body = String(entry.content ?? '').trim();
  const keywords = [...asStringList(entry.key), ...asStringList(entry.keysecondary), label]
    .map((value) => value.trim())
    .filter((value, position, all) => Boolean(value) && all.indexOf(value) === position);
  return {
    name: `文风-${safeStyleName(label, `style-${index + 1}`)}`,
    description: `由用户提供的文风条目导入：${label}`,
    body,
    keywords,
    role: 'style',
    source: `${sourceLabel}#${uid}`,
    sourceHash: sha256(body),
    styleId: uid,
  };
}

export function importStyleBooks(
  src = process.env.JG_STYLE_SRC?.trim(),
  dir = process.env.JG_SKILLS_DIR?.trim() || DEFAULT_SKILLS_DIR,
): { created: string[]; updated: string[]; unchanged: string[]; total: number } {
  if (!src) {
    throw new Error('未配置 JG_STYLE_SRC；公开版不会自动读取任何外部文风库');
  }
  const raw = readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> | unknown[] };
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries
    : Object.values(parsed.entries ?? {});
  const specs = entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => String(entry.content ?? '').trim().length > 0)
    .map((entry, index) => entryToSpec(entry, basename(src), index));
  if (specs.length === 0) throw new Error('源文件没有可导入的非空文风条目');
  const result = syncStylesFromSource(specs, dir);
  return {
    ...result,
    total: result.created.length + result.updated.length + result.unchanged.length,
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const result = importStyleBooks();
  console.log(`[文风导入] 新建 ${result.created.length}，更新 ${result.updated.length}，未变 ${result.unchanged.length}`);
}
