#!/usr/bin/env node
/**
 * tools/cli - 文风库 → 文风 skill 生成导入
 * 读取 SillyTavern 文风库世界书 JSON（Yukino 文风库合集），把 43 个作者级风格条目
 * 生成到 data/skills/文风-<name>/SKILL.md（role=style），并生成默认底座
 * 「文风-底座-轻小说」（default=true，恒定注入，含详细缓慢节奏要求）。
 *
 * 运行：pnpm style:import
 *   — 幂等：重复跑不重复生成；源条目 content 不变则跳过（sourceHash 判定）。
 *   — 源路径默认取文风库 JSON，可用 env JG_STYLE_SRC 覆盖。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SKILLS_DIR, syncStylesFromSource, type StyleSkillSpec } from '../../packages/core/src/skills.ts';

/** 文风库源 JSON（可被 env 覆盖） */
const DEFAULT_SRC = 'E:/jiuguana/SillyTavern/世界书/Yukino的文风库（世界书合集）(2026-01-31).json';
const SRC = process.env.JG_STYLE_SRC ?? DEFAULT_SRC;
const SKILLS_DIR = process.env.JG_SKILLS_DIR ?? DEFAULT_SKILLS_DIR;

/** sha256 十六进制摘要（判定源变化） */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 把条目 comment 清洗成安全 skill 目录名（仅保留字母/数字/连字符，其余转 '-'） */
function safeStyleName(comment: string): string {
  return comment
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/** 从 comment 提取作者名（括号内；无括号则取末段） */
function authorOf(comment: string): string {
  const m = comment.match(/[（(]([^（）()]+)[）)]/);
  return (m?.[1] ?? comment).trim();
}

/** 从 comment 提取风格标题段（去掉作者括号，如「青春暧昧日常轻小说」） */
function titleOf(comment: string): string {
  return comment.replace(/[（(][^（）()]*[）)]/g, '').trim();
}

/** 把一条文风库 entry 转成 StyleSkillSpec（含 keywords/source/sourceHash/styleId）
 *  关键词 = key/keysecondary 项 + 风格标题段 + 作者；刻意不含「文风/风格」等通用词，
 *  以免 matchSkills 对同一 query 一次性命中全部文风 skill。 */
function entryToSpec(e: Record<string, unknown>, srcFile: string): StyleSkillSpec {
  const comment = String(e.comment ?? '');
  const uid = String(e.uid ?? comment);
  const content = String(e.content ?? '');
  const author = authorOf(comment);
  const title = titleOf(comment);
  const keyRaw = [e.key, e.keysecondary].filter(Boolean).map(String).join('|');
  const keywords = [
    ...keyRaw.split(/[|,，]/).map((s) => s.trim()).filter(Boolean),
    title,
    author,
  ].filter((s, i, a) => s && a.indexOf(s) === i);
  return {
    name: `文风-${safeStyleName(comment)}`,
    description: `文风库作者风格：${comment}`,
    body: content,
    keywords,
    role: 'style',
    source: `${srcFile}#${uid}`,
    sourceHash: sha256(content),
    styleId: uid,
  };
}

/** 默认底座：轻小说基调 + 详细缓慢 + 去AI腔（恒定注入；用户可改此文件即改默认） */
const DEFAULT_BLADE_BODY = `## 文风基调
这是一个轻小说风格的剧情引擎。正文以人物内心与日常细节为重心，节奏舒缓、描写细腻，不急于推进主线剧情。

## 节奏与详略（强制）
- 慢：单场景铺足细节，一个动作/一句对话可展开数句感官与心理描写；禁止摘要式跳进。
- 详：每个场景交代环境（空间/光线/声音/温度）与人物（神态/动作/距离感/气味）至少各一个可感知细节。
- 不赶：不快速切换场景、不略过情绪转折；让角色在细节里停留，感情在微小互动里渐近。
- 对白含蓄、有信息量，靠肢体与沉默推进，而非直接陈述。

## 去 AI 腔（禁止）
- 禁"突然/一抹/弧度/不容置疑/不仅…而且…"等 AI 痕迹；禁数字式清单化；禁升华说教。`;

function bladeSpec(): StyleSkillSpec {
  return {
    name: '文风-底座-轻小说',
    description: '默认文风底座：轻小说基调 + 详细缓慢进度（恒定注入，可在此文件修改默认文风）',
    body: DEFAULT_BLADE_BODY,
    keywords: ['轻小说', '文风', '默认', '日常', '细腻'],
    role: 'style',
    default: true,
    source: 'Yukino文风库#default-轻小说',
    sourceHash: sha256(DEFAULT_BLADE_BODY),
    styleId: '底座-轻小说',
  };
}

/** NSFW 增强文风：mode=nsfw 时在底座之上追加（角色/剧情连贯 + 官能化 + 慢节奏铺垫） */
const NSFW_BLADE_BODY = `## NSFW 文风（内容分支 NSFW 触发）
在 NSFW 内容分支下，正文在保持角色与剧情连贯的同时，按以下增强：
- 官能化但直白不堆砌：露骨描写按剧情需要完整呈现，禁生理学词汇堆砌（呼应内容模式 jailbreak）。
- 情绪张力优先于速度：暧昧的前戏、喘息、肢体语言、心理交锋缓慢铺陈，不急于抵达目的。
- 感官以触觉/温度/气味为主，节奏在细腻描写与克制推进间游走。
- 角色反应（羞耻、欲望、掌控、依赖）用动作与停顿暗示，而非直接陈述。`;

function nsfwBladeSpec(): StyleSkillSpec {
  return {
    name: '文风-NSFW',
    description: 'NSFW 增强文风（mode=nsfw 时注入）：官能化 + 慢节奏铺垫 + 情绪先于速度',
    body: NSFW_BLADE_BODY,
    keywords: ['NSFW', '官能', '成人', '敏感'],
    role: 'style',
    nsfw: true,
    source: 'Yukino文风库#nsfw-增强',
    sourceHash: sha256(NSFW_BLADE_BODY),
    styleId: 'nsfw-增强',
  };
}

/** 执行文风库导入：读源 JSON → 生成底座/NSFW/作者风格 skill → 幂等同步。
 *  @returns 每类 skill 名 + 生成总数（供 server/cli 复用） */
export function importStyleBooks(src = SRC, dir = SKILLS_DIR): {
  created: string[]; updated: string[]; unchanged: string[]; total: number;
} {
  const raw = readFileSync(src, 'utf8');
  const j = JSON.parse(raw) as { entries?: Record<string, unknown> };
  const entries = Object.values(j.entries ?? {});
  // 用源文件名作 source 前缀（避免绝对路径固定死）
  const srcLabel = src.replace(/[\\/]/g, '/').split('/').pop() ?? 'Yukino文风库';
  const specs: StyleSkillSpec[] = [bladeSpec(), nsfwBladeSpec(), ...entries.filter((e) => String((e as Record<string, unknown>).content ?? '').length).map((e) => entryToSpec(e, srcLabel))];
  const res = syncStylesFromSource(specs, dir);
  return { ...res, total: res.created.length + res.updated.length + res.unchanged.length };
}

/** 直跑守卫：仅当以脚本方式执行（node tools/cli/import-style.ts）时才打印报告 */
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const res = importStyleBooks();
  console.log(`[文风导入] 源 ${SRC}`);
  console.log(`  新建 ${res.created.length}：${res.created.slice(0, 6).join(', ')}${res.created.length > 6 ? `…(${res.created.length})` : ''}`);
  console.log(`  更新 ${res.updated.length}：${res.updated.slice(0, 6).join(', ')}${res.updated.length > 6 ? `…(${res.updated.length})` : ''}`);
  console.log(`  未变 ${res.unchanged.length}`);
}
