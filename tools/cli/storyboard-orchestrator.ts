/**
 * tools/cli - 导演分镜编排器（director content_mode）
 * 平行于 prose 主循环的批量工作流引擎：输入具体场景 → 批量 RAG 召回（剧情记忆 ∥ 世界书 ∥ 分镜 Skill）
 * → 按工作流注册表（data/storyboard-workflows/*.yaml）分阶段调模型 → 五级校验 → 落库。
 *
 * 工作流余量：新增分镜工作流 = 在 data/storyboard-workflows/ 丢一个新 yaml（声明阶段顺序 +
 * 各阶段绑定 Skill/schema），orchestrator 代码零改动。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { matchSkills, readSkillBody } from '../../packages/core/src/skills.ts';
import type { SkillMatch } from '../../packages/core/src/skills.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import {
  DirectorsReadSchema, PanelsSchema, SequenceSchema, HumanizeSchema,
  safeParseStage, validatePanels, validateSequence, storyboardStageTools,
} from '../../packages/prompt/src/storyboard.ts';
import type { DirectorsRead, Panel, Sequence, Humanize } from '../../packages/prompt/src/storyboard.ts';

export const STORYBOARD_WORKFLOWS_DIR = join('data', 'storyboard-workflows');
export const DEFAULT_WORKFLOW = 'cinematic-default';
/** 单次模型调用生成镜数上限（规避单 agent 输出截断；超限拆批并行） */
const MAX_PANELS_PER_CALL = 5;

// ── 工作流注册表 ──
export interface StoryboardStageDef {
  key: string;
  label: string;
  skill?: string;
  schemaRef?: string;
  inline?: boolean;
  parallel?: boolean;
}

export interface StoryboardWorkflow {
  name: string;
  label: string;
  version: string;
  stages: StoryboardStageDef[];
  defaultWorldbooks: string[];
  voices: string[];
  slopWords: string[];
}

/** 解析工作流 yaml（固定结构，手写行解析避免引入 js-yaml 依赖） */
export function parseWorkflowYaml(text: string): StoryboardWorkflow {
  const wf: StoryboardWorkflow = {
    name: '', label: '', version: '1.0', stages: [], defaultWorldbooks: [], voices: [], slopWords: [],
  };
  type Section = 'meta' | 'stages' | 'defaultWorldbooks' | 'voices' | 'slopWords';
  let section: Section = 'meta';
  let cur: Partial<StoryboardStageDef> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[a-zA-Z]+:$/.test(line) && !line.startsWith('-')) {
      const s = line.slice(0, -1) as Section;
      section = (s === 'stages' || s === 'defaultWorldbooks' || s === 'voices' || s === 'slopWords') ? s : 'meta';
      cur = null;
      continue;
    }
    if (section === 'stages') {
      if (line.startsWith('- key:')) {
        cur = { key: line.slice(6).trim() };
        wf.stages.push(cur as StoryboardStageDef);
        continue;
      }
      const m = line.match(/^([a-zA-Z]+):\s*(.*)$/);
      if (m && cur) {
        const v = m[2].trim();
        // 布尔字段（parallel/inline）存真布尔
        (cur as Record<string, unknown>)[m[1]] = (m[1] === 'parallel' || m[1] === 'inline') ? v === 'true' : v;
      }
      continue;
    }
    if (section === 'defaultWorldbooks' || section === 'voices' || section === 'slopWords') {
      const m = line.match(/^-\s*(.*)$/);
      if (m) wf[section].push(m[1].trim());
      continue;
    }
    const m = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (m) (wf as unknown as Record<string, string>)[m[1]] = m[2].trim();
  }
  if (!wf.name) throw new Error('工作流 yaml 缺 name');
  return wf;
}

export class StoryboardRegistry {
  constructor(private dir = STORYBOARD_WORKFLOWS_DIR) {}

  list(): string[] {
    if (!readdirSync(this.dir, { withFileTypes: true }).length) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
      .map((e) => e.name.replace(/\.yaml$/, ''))
      .sort();
  }

  get(name: string): StoryboardWorkflow {
    const path = join(this.dir, `${name}.yaml`);
    return parseWorkflowYaml(readFileSync(path, 'utf8'));
  }
}

// ── 编排器 ──
export interface StoryboardDeps {
  client: OpenAICompatibleClient;
  ret: RetrievalEngine;
  scanner: LorebookScanner;
  vms: VariableManager;
  mem: MemoryDb;
  cardName: string;
  round: number;
}

export interface StoryboardRunOptions {
  mode: 'batch' | 'shot';
  shotCount: number;
  workflow?: string;
  voice?: string;
}

export interface StoryboardResult {
  directorsRead: DirectorsRead | null;
  panels: Panel[];
  sequence: Sequence | null;
  humanized: Humanize | null;
  validation: { stage: string; errors: string[]; warnings: string[] }[];
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export class StoryboardOrchestrator {
  private tools = storyboardStageTools();
  private registry = new StoryboardRegistry();

  constructor(private deps: StoryboardDeps) {}

  /** 执行分镜工作流：召回 → 分阶段（导演读本/逐镜/串联/校验/人类化）→ 落库 */
  async run(sceneInput: string, opts: StoryboardRunOptions, onStage?: (label: string, detail?: string) => void): Promise<StoryboardResult> {
    const wf = this.registry.get(opts.workflow ?? DEFAULT_WORKFLOW);

    // ① 批量召回（剧情记忆 ∥ 世界书 ∥ 分镜 Skill 并行）
    onStage?.('召回', '批量轮次召回（剧情 RAG ∥ 世界书 ∥ 分镜 Skill）');
    const [recall, scan, skillMatches] = await Promise.all([
      this.deps.ret.recallAsync({ query: sceneInput.slice(0, 24), round: this.deps.round, budgetTokens: 400 }),
      Promise.resolve(this.deps.scanner.scan({ text: sceneInput, seed: this.deps.round, budgetTokens: 1200 })),
      Promise.resolve(matchSkills(sceneInput)),
    ]);
    const skillBlock = renderMatches(skillMatches);
    const anchors = this.anchorBlock();

    // ② 逐阶段执行
    let validation: { stage: string; errors: string[]; warnings: string[] }[] = [];
    let directorsRead: DirectorsRead | null = null;
    let panels: Panel[] = [];
    let sequence: Sequence | null = null;
    let humanized: Humanize | null = null;

    for (const stage of wf.stages) {
      if (stage.inline) {
        // Stage 3 校验：代码内联（VP0~VP4），不调模型
        onStage?.(stage.label);
        validation = this.runValidation(directorsRead, panels, sequence);
        continue;
      }
      const skillBody = stage.skill ? readSkillBody(stage.skill) : '';
      if (stage.key === 'read') {
        onStage?.(stage.label);
        directorsRead = await this.genDirectorsRead(sceneInput, recall.injectedBlock, scan.injectedBlock, skillBlock, skillBody, opts.voice ?? '');
      } else if (stage.key === 'shots') {
        onStage?.(stage.label, `${opts.mode === 'shot' ? '单镜接力' : `批量 ${opts.shotCount} 镜`}`);
        panels = await this.genPanels(sceneInput, opts, directorsRead, recall.injectedBlock, scan.injectedBlock, anchors, skillBlock, skillBody);
      } else if (stage.key === 'link') {
        onStage?.(stage.label);
        if (panels.length > 0) sequence = await this.genSequence(panels, directorsRead, anchors, skillBlock, skillBody);
      } else if (stage.key === 'humanize') {
        onStage?.(stage.label);
        if (directorsRead && sequence) humanized = await this.genHumanize(directorsRead, sequence, skillBody);
      }
    }

    const errors = validation.flatMap((v) => v.errors);
    const warnings = validation.flatMap((v) => v.warnings);
    const passed = errors.length === 0;
    onStage?.('完成', `${panels.length} 镜 | VP ${passed ? 'PASS' : 'FAIL'} (${errors.length} errors, ${warnings.length} warns)`);

    const result: StoryboardResult = { directorsRead, panels, sequence, humanized, validation, passed, errors, warnings };
    this.persist(result);
    return result;
  }

  // ── Stage 0 导演读本 ──
  private async genDirectorsRead(
    sceneInput: string, recallBlock: string, worldbookBlock: string, skillBlock: string, skillBody: string, voice: string,
  ): Promise<DirectorsRead | null> {
    const sys = `你是一位商用级电影分镜导演。\n\n${skillBody}\n\n【已发生剧情氛围（召回）】\n${recallBlock || '（无历史召回）'}\n\n【场景背景（世界书激活）】\n${worldbookBlock || '（无激活条目）'}\n\n${skillBlock}`;
    const usr = `场景输入：\n${sceneInput}${voice ? `\n\n调用方已指定导演之声「${voice}」，直接采用并简要说明为何适合。` : '\n\n从 6 种导演之声选一（观察自然主义/古典构图/动态visceral/表现主义/亲密极简/图形形式主义）。'}`;
    const args = await this.callTool('storyboard_read', sys, usr);
    return args ? safeParseStage(args, DirectorsReadSchema) : null;
  }

  // ── Stage 1 逐镜分镜 ──
  private async genPanels(
    sceneInput: string, opts: StoryboardRunOptions, directorsRead: DirectorsRead | null,
    recallBlock: string, worldbookBlock: string, anchors: string, skillBlock: string, skillBody: string,
  ): Promise<Panel[]> {
    if (opts.mode === 'shot') {
      const p = await this.genPanelsRange(sceneInput, directorsRead, recallBlock, worldbookBlock, anchors, skillBlock, skillBody, opts.shotCount, opts.shotCount, opts.shotCount);
      return p.length ? [p[p.length - 1]] : [];
    }
    const batchCount = Math.ceil(opts.shotCount / MAX_PANELS_PER_CALL);
    const batches = Array.from({ length: batchCount }, (_, i) => {
      const start = i * MAX_PANELS_PER_CALL + 1;
      const end = Math.min(opts.shotCount, (i + 1) * MAX_PANELS_PER_CALL);
      return this.genPanelsRange(sceneInput, directorsRead, recallBlock, worldbookBlock, anchors, skillBlock, skillBody, start, end, opts.shotCount);
    });
    const all = (await Promise.all(batches)).flat();
    return all.sort((a, b) => a.panel - b.panel);
  }

  private async genPanelsRange(
    sceneInput: string, directorsRead: DirectorsRead | null, recallBlock: string, worldbookBlock: string,
    anchors: string, skillBlock: string, skillBody: string, start: number, end: number, total: number,
  ): Promise<Panel[]> {
    const sys = `你是一个分镜专家。\n\n${skillBody}\n\n【已发生剧情氛围（召回）】\n${recallBlock || '（无历史召回）'}\n\n【场景背景（世界书激活）】\n${worldbookBlock || '（无激活条目）'}\n\n【跨镜锚点 — 禁止漂移】\n${anchors}\n\n导演意图：${directorsRead?.intention || ''}\n导演之声：${directorsRead?.voice || ''}\n\n${skillBlock}`;
    const usr = `场景：\n${sceneInput}\n\n镜头数共 ${total} 镜。本次只生成第 ${start}~${end} 镜，跳过其他镜头，逐条对应。每镜严格满足 Shot Contract 字段。`;
    const args = await this.callTool('storyboard_shots', sys, usr);
    if (!args) return [];
    const parsed = safeParseStage(args, PanelsSchema);
    return parsed?.panels ?? [];
  }

  // ── Stage 2 串联序列 ──
  private async genSequence(panels: Panel[], directorsRead: DirectorsRead | null, anchors: string, skillBlock: string, skillBody: string): Promise<Sequence | null> {
    const summary = panels.map((p) => ({
      镜: p.panel, 时间: p.time, 景别: p.shot_size, 画布: `${p.canvas.width}x${p.canvas.height}`, 光线: p.lighting, 转场: p.transition_hint,
    }));
    const sys = `你是一个电影剪辑师。\n\n${skillBody}\n\n【跨镜锚点】\n${anchors}\n\n导演意图：${directorsRead?.intention || ''}\n导演之声：${directorsRead?.voice || ''}\n\n${skillBlock}`;
    const usr = `${panels.length} 格数据：\n${JSON.stringify(summary, null, 2)}\n\n按六段式输出完整串联序列（master_prompt/rhythm_map/narrative/consistency/sfx/checklist）。`;
    const args = await this.callTool('storyboard_link', sys, usr);
    return args ? safeParseStage(args, SequenceSchema) : null;
  }

  // ── Stage 4 人类化改写 ──
  private async genHumanize(directorsRead: DirectorsRead, sequence: Sequence, skillBody: string): Promise<Humanize | null> {
    const sys = `你是文字编辑。\n\n${skillBody}`;
    const usr = `导演读本：\n${JSON.stringify(directorsRead, null, 2)}\n\n逐镜串联描述：\n${sequence.narrative}\n\n整体分镜概括（前 3000 字符）：\n${sequence.master_prompt.slice(0, 3000)}`;
    const args = await this.callTool('storyboard_humanize', sys, usr);
    return args ? safeParseStage(args, HumanizeSchema) : null;
  }

  // ── Stage 3 五级校验（内联代码，不调模型）──
  private runValidation(
    directorsRead: DirectorsRead | null, panels: Panel[], sequence: Sequence | null,
  ): { stage: string; errors: string[]; warnings: string[] }[] {
    const out: { stage: string; errors: string[]; warnings: string[] }[] = [];
    // VP0 导演读本
    if (directorsRead) {
      const errors: string[] = [];
      for (const q of ['function', 'turn', 'pov', 'power', 'subtext', 'intention']) {
        if (!String((directorsRead as Record<string, unknown>)[q]).trim()) errors.push(`S0-E: 读本缺答 ${q}`);
      }
      out.push({ stage: 'VP0', errors, warnings: [] });
    }
    // VP1 逐镜 + VP2 串联
    if (panels.length) out.push(validatePanels(panels));
    if (sequence) out.push(validateSequence(sequence));
    return out;
  }

  // ── 内部工具 ──
  /** 调模型工具（结构化输出），返回 toolCall.arguments 或 null */
  private async callTool(toolName: string, system: string, user: string): Promise<string | null> {
    try {
      // 工具注册表键为 stage0/1/2/4，此处按 function.name 解析（storyboard_read 等）
      const tool = Object.values(this.tools).find((t) => (t as { function?: { name?: string } }).function?.name === toolName);
      if (!tool) {
        console.warn(`[分镜] 未找到工具定义: ${toolName}`);
        return null;
      }
      const res = await this.deps.client.stream(
        { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: [tool], temperature: 0.9 },
        () => {},
      );
      const tc = res.toolCalls.find((t) => t.name === toolName);
      return tc?.arguments ?? null;
    } catch (e) {
      console.warn(`[分镜] ${toolName} 调用失败: ${(e as Error).message.slice(0, 120)}`);
      return null;
    }
  }

  /** 跨镜锚点块：VMS session 级变量（跨会话记忆），渲染为常量表 */
  private anchorBlock(): string {
    const vars = this.deps.vms.list().filter((d) => d.scope === 'session');
    if (vars.length === 0) return '（无跨会话锚点，按场景描述自适应锁定）';
    const lines = vars.map((d) => `${d.name} = ${String(d.value ?? '')}`).sort();
    return lines.join('\n');
  }

  /** 落库：memory_state entity_type='storyboard'（FTS 可检索；复用 memory_state 快照机制） */
  private persist(r: StoryboardResult): void {
    const json = JSON.stringify(r);
    const existing = this.deps.mem.db.prepare("SELECT id FROM memory_state WHERE entity_type = 'storyboard' AND entity_id = ?")
      .get(this.deps.cardName) as { id: number } | undefined;
    if (existing) {
      this.deps.mem.db.prepare('UPDATE memory_state SET state_json = ?, updated_round = ? WHERE id = ?')
        .run(json, this.deps.round, existing.id);
    } else {
      this.deps.mem.db.prepare(
        "INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES ('storyboard', ?, '导演分镜快照', ?, ?)"
      ).run(this.deps.cardName, json, this.deps.round);
    }
  }
}

/** 命中 Skill 注入块（复用 renderSkillBlock 语义；Skills 面板的 <Skill 指令> 包裹） */
function renderMatches(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  const lines = matches.map((m) => `[${m.skill.name}|${m.score.toFixed(2)}]\n${m.body}`);
  return `<Skill 指令>\n${lines.join('\n\n')}\n</Skill 指令>`;
}
