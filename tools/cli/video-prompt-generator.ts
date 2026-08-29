/**
 * tools/cli - H3 视频提示词生成器（分镜 Stage 5 按需旁路）
 * 输入已完成的完整 panels → 会话上下文对白提取（1 次 LLM，声源 ID 由代码确定性分配）
 * → 逐批（5 镜/批）并行转写为 MiniMax H3 T2VA 三字段提示词 → 代码级校验 → 可选落库。
 * 独立于 StoryboardOrchestrator 主管线：不改 cinematic-default.yaml，不做召回，不打断用户。
 */
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import type { ChatRequest, ChatResponse } from '../../packages/proxy/src/client.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { readSkillBody } from '../../packages/core/src/skills.ts';
import {
  DialogueSchema, VideoPromptsSchema, VideoPromptsSchemaLenient, safeParseStage,
  validateVideoPrompts, storyboardStageTools, renderVideoPromptMarkdown,
} from '../../packages/prompt/src/storyboard.ts';
import type { DialogueLine, Panel, VideoPrompt, ValidationIssue } from '../../packages/prompt/src/storyboard.ts';

/** 单批镜数上限（对齐 storyboard-orchestrator MAX_PANELS_PER_CALL，规避单次输出截断） */
const VIDEO_PANELS_PER_BATCH = 5;
/** H3 格式任务温度（低于分镜创意 0.9，降低格式漂移） */
const VIDEO_TEMPERATURE = 0.7;
/** 声源 ID 上限（超出者并入最后一个声源 ID，防 ID 爆炸） */
export const MAX_SPEAKERS = 6;
/** 对白提取源字符上限（对齐 directorRun extraContext 截断口径，session.ts 共用） */
export const DIALOGUE_SOURCE_MAX_CHARS = 6000;

export interface VideoPromptDeps {
  client: OpenAICompatibleClient;
  cardName: string;
  round: number;
  /** 提供则落库 memory_state(entity_type='storyboard_video')；独立页一次性库可省 */
  mem?: MemoryDb;
}

export interface VideoPromptRunOptions {
  /** 全序列音效设计（Stage2 六段式 sfx，overall_soundscape 推导基底） */
  sequenceSfx?: string;
  /** 对白提取源：会话模式=buildChatWindow+选中文本；独立页=场景描述；空则跳过提取 */
  dialogueSource?: string;
}

export interface VideoPromptResult {
  prompts: VideoPrompt[];
  /** 声源名册（"S1: 名字" 形式，代码按首次出现顺序分配） */
  speakers: string[];
  validation: ValidationIssue[];
  passed: boolean;
  errors: string[];
  warnings: string[];
  markdown: string;
}

export class VideoPromptGenerator {
  private tools = storyboardStageTools();
  /** 模型调用失败收集（对齐 orchestrator：429/超时/未调工具 → 并入 errors 浮到前端，不静默） */
  private modelFailures: string[] = [];
  private warnings: string[] = [];

  constructor(private deps: VideoPromptDeps) {}

  /** 执行：对白提取 → 声源分配 → 逐批转写 → 校验汇总 → 渲染 → 落库 */
  async run(panels: Panel[], opts: VideoPromptRunOptions, onStage?: (label: string, detail?: string) => void): Promise<VideoPromptResult> {
    this.modelFailures = [];
    this.warnings = [];

    // ① 对白提取（空源/失败降级为无对白 + warning，不阻断）
    const dialogue = await this.extractDialogue(opts.dialogueSource ?? '');
    onStage?.('对白提取', `命中 ${dialogue.length} 句 / ${new Set(dialogue.map((d) => d.speaker)).size} 声源`);
    // ② 声源名册：代码按首次出现顺序确定性分配 S1..Sn（跨批 ID 一致的唯一保障）
    const speakerMap = this.assignSpeakers(dialogue);
    const speakers = this.speakerRoster(speakerMap);
    // ③ 逐批并行转写
    const batchCount = Math.ceil(panels.length / VIDEO_PANELS_PER_BATCH);
    onStage?.('视频提示词', `共 ${panels.length} 镜 / ${batchCount} 批`);
    const styleAnchor = styleAnchorOf(panels);
    const batches = Array.from({ length: batchCount }, (_, i) => {
      const batch = panels.slice(i * VIDEO_PANELS_PER_BATCH, (i + 1) * VIDEO_PANELS_PER_BATCH);
      return this.genBatch(batch, dialogue, speakerMap, styleAnchor, opts.sequenceSfx ?? '');
    });
    const prompts = (await Promise.all(batches)).flat().sort((a, b) => a.panel - b.panel);

    // ④ 校验 + 汇总
    const validation = [validateVideoPrompts(prompts, panels.map((p) => p.panel))];
    const errors = [...validation.flatMap((v) => v.errors), ...this.modelFailures];
    const warnings = [...validation.flatMap((v) => v.warnings), ...this.warnings];
    const passed = errors.length === 0;
    onStage?.('完成', `${prompts.length} 镜提示词 | VP ${passed ? 'PASS' : 'FAIL'} (${errors.length} errors, ${warnings.length} warns)`);
    const markdown = renderVideoPromptMarkdown(prompts, speakers, passed);
    this.persist(prompts, speakers, passed);
    return { prompts, speakers, validation, passed, errors, warnings, markdown };
  }

  /** 对白提取：LLM 单次调用；空源直接跳过；失败/解析失败降级为 []（warning，不阻断） */
  private async extractDialogue(source: string): Promise<DialogueLine[]> {
    const text = source.trim();
    if (!text) return [];
    const sys = '你是对白提取器。从剧情上下文提取角色的直接对白：只收引号内/引语中的直接引语；旁白、心理描写、转述不算。'
      + 'speaker 用原文角色名；onScreen 表示说话时该角色是否在画面内（无法判断时 false=画外音）。';
    const usr = `剧情上下文：\n${text}\n\n提取其中的逐字对白（禁止改写、禁止发明），按出现顺序输出。`;
    const args = await this.callTool('storyboard_dialogue', sys, usr);
    const parsed = args ? safeParseStage(args, DialogueSchema) : null;
    if (!parsed) {
      this.warnings.push('对白提取失败或为空，视频提示词将不含对白');
      return [];
    }
    return parsed.lines;
  }

  /** 声源名册：按首次出现顺序确定性分配 S1..Sn；超上限的角色并入最后一个声源 ID */
  private assignSpeakers(lines: DialogueLine[]): Map<string, string> {
    const map = new Map<string, string>();
    let n = 0;
    for (const line of lines) {
      if (!map.has(line.speaker)) {
        n += 1;
        map.set(line.speaker, n <= MAX_SPEAKERS ? `S${n}` : `S${MAX_SPEAKERS}`);
      }
    }
    return map;
  }

  /** 名册行（"S1: 名字"，按 ID 去重；超上限共享尾 ID 时取先出现者） */
  private speakerRoster(speakerMap: Map<string, string>): string[] {
    const seen = new Map<string, string>();
    for (const [name, id] of speakerMap) {
      if (!seen.has(id)) seen.set(id, name);
    }
    return [...seen.entries()].map(([id, name]) => `${id}: ${name}`);
  }

  /** 单批转写：skill 正文 + 名册 + 对白清单 + 风格锚/音效注入 sys；本批 panels 完整 JSON 注入 usr。
   *  严格 schema 失败 → 容错降级（缺辅助字段补默认）；再失败记 modelFailures（缺镜由 VV-E1 浮出）。 */
  private async genBatch(
    batch: Panel[], dialogue: DialogueLine[], speakerMap: Map<string, string>, styleAnchor: string, sequenceSfx: string,
  ): Promise<VideoPrompt[]> {
    const panelNos = batch.map((p) => p.panel).join(', ');
    const sys = `你是 MiniMax H3 T2VA 视频提示词工程师。\n\n${readSkillBody('分镜-视频提示词')}\n\n`
      + `【全序列统一风格锚（画风定调，禁止漂移）】\n${styleAnchor}\n\n`
      + `【声源名册（ID 已分配，禁止改动）】\n${this.speakerBlock(dialogue, speakerMap)}\n\n`
      + `【对白清单（逐字原文，禁止改写、禁止发明；旁白不算）】\n${this.dialogueBlock(dialogue, speakerMap)}\n\n`
      + `【全序列音效设计（overall_soundscape 推导基底，改写为本镜，禁照抄）】\n${sequenceSfx || '（无）'}`;
    const usr = `本批分镜面板（第 ${panelNos} 镜，完整 Shot Contract 数据）：\n${JSON.stringify(batch, null, 2)}\n\n`
      + `逐镜转写为 H3 三字段提示词：每镜一份独立视频提示词，target_duration 按 time 参考拉伸至 4-15 秒（常态 4-6 秒），`
      + `镜号与本批面板一一对应，禁止遗漏。`;
    const args = await this.callTool('storyboard_videoprompt', sys, usr);
    if (!args) return [];
    const strict = safeParseStage(args, VideoPromptsSchema);
    if (strict) return strict.prompts;
    const lenient = safeParseStage(args, VideoPromptsSchemaLenient);
    if (lenient) {
      console.log(`  [视频提示词] 严格 schema 失败，容错解析 ${lenient.prompts.length} 镜（镜 ${panelNos}）`);
      return lenient.prompts;
    }
    this.modelFailures.push(`视频提示词解析失败（镜 ${panelNos}；严格 + 容错 schema 均未通过）`);
    return [];
  }

  /** 声源名册块："S1: 祥子（画内）" 一行一源（画内/画外取该角色最近一句对白的 onScreen） */
  private speakerBlock(lines: DialogueLine[], speakerMap: Map<string, string>): string {
    if (speakerMap.size === 0) return '（无对白声源）';
    return [...speakerMap.entries()].map(([name, id]) => `${id}: ${name}（${dialogueOnScreen(lines, name) ? '画内' : '画外音'}）`).join('\n');
  }

  /** 对白清单块："(S1) 画内: 「…逐字原文…」" 一行一句 */
  private dialogueBlock(lines: DialogueLine[], speakerMap: Map<string, string>): string {
    if (lines.length === 0) return '（无对白）';
    return lines.map((l) => `(${speakerMap.get(l.speaker) ?? 'S1'}) ${l.onScreen ? '画内' : '画外'}: 「${l.text}」`).join('\n');
  }

  // ── 内部工具（对齐 storyboard-orchestrator callTool：非流式 complete + 工具调用 + content 兜底 + 失败浮出）──
  private async callTool(toolName: string, system: string, user: string): Promise<string | null> {
    try {
      const tool = Object.values(this.tools).find((t) => (t as { function?: { name?: string } }).function?.name === toolName);
      if (!tool) {
        this.modelFailures.push(`工具定义缺失: ${toolName}`);
        console.warn(`[视频提示词] 未找到工具定义: ${toolName}`);
        return null;
      }
      const res = await this.deps.client.complete(
        { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], tools: [tool], tool_choice: 'auto', temperature: VIDEO_TEMPERATURE },
      );
      const tc = res.toolCalls.find((t) => t.name === toolName);
      if (!tc) {
        // 模型直接返回 JSON 文本而非工具调用 → 交给上层 safeParseStage 容错解析
        if (res.content) return res.content;
        this.modelFailures.push(`模型未调用工具 ${toolName}（finish=${res.finishReason}）`);
        return null;
      }
      return tc.arguments ?? null;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      this.modelFailures.push(`模型调用失败 ${toolName}: ${msg}`);
      console.warn(`[视频提示词] ${toolName} 调用失败: ${msg.slice(0, 120)}`);
      return null;
    }
  }

  /** 落库：memory_state entity_type='storyboard_video'（对齐 orchestrator persist 的 upsert；无 mem 跳过） */
  private persist(prompts: VideoPrompt[], speakers: string[], passed: boolean): void {
    if (!this.deps.mem) return;
    const json = JSON.stringify({ prompts, speakers, passed });
    const existing = this.deps.mem.db.prepare("SELECT id FROM memory_state WHERE entity_type = 'storyboard_video' AND entity_id = ?")
      .get(this.deps.cardName) as { id: number } | undefined;
    if (existing) {
      this.deps.mem.db.prepare('UPDATE memory_state SET state_json = ?, updated_round = ? WHERE id = ?')
        .run(json, this.deps.round, existing.id);
    } else {
      this.deps.mem.db.prepare(
        "INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES ('storyboard_video', ?, 'H3视频提示词快照', ?, ?)"
      ).run(this.deps.cardName, json, this.deps.round);
    }
  }
}

// ── 纯函数辅助（保持类方法 ≤50 行）──

/** 全序列统一风格锚：第 1 镜 positive_prompt 首句（质量前缀 + 画风词），代码截取防漂移 */
function styleAnchorOf(panels: Panel[]): string {
  const first = panels[0]?.positive_prompt ?? '';
  const head = first.split(/[,，]/).slice(0, 3).join(', ').trim();
  return head || '（无风格前缀，按画面内容自定画风）';
}

/** 某角色名册行的画内/画外判断（其最近一句对白的 onScreen） */
function dialogueOnScreen(lines: DialogueLine[], speaker: string): boolean {
  const own = lines.filter((l) => l.speaker === speaker);
  return own.length ? own[own.length - 1].onScreen : false;
}
