/**
 * tools/cli 验证 - H3 视频提示词生成器（Stage 5 按需旁路）
 * 无模型 mock 端到端：schema 双路解析 → VP5 代码校验 → 生成器（对白提取/声源分配/逐批转写/落库）→ markdown 渲染。
 * 用 MockClient 提供结构化输出（绕过 API 限流）。
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import {
  DialogueSchema, VideoPromptsSchema, VideoPromptsSchemaLenient, safeParseStage,
  validateVideoPrompts, renderVideoPromptMarkdown, H3_PROMPT_MAX_CHARS,
} from '../../packages/prompt/src/storyboard.ts';
import type { VideoPrompt } from '../../packages/prompt/src/storyboard.ts';
import { VideoPromptGenerator, MAX_SPEAKERS, DIALOGUE_SOURCE_MAX_CHARS } from './video-prompt-generator.ts';
import type { VideoPromptDeps } from './video-prompt-generator.ts';
import type { Panel } from '../../packages/prompt/src/storyboard.ts';
import type { ChatRequest, ChatResponse } from '../../packages/proxy/src/client.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// ── 夹具（干净 H3 三字段提示词：[Shot 1] 无时间戳 / (S1) 声源 / <d>[中文] 闭合 / music N/A）──
const h3Prompt = (n: number): string => [
  `integrated_multimodal_description: [Shot 1] Anime illustration, cinematic composition, a medium-wide shot `
  + `frames the two figures on the wet grate beneath warm lamplight. The camera pushes in with small amplitude `
  + `at slow speed as the quiet young woman (S1) says: <d>[中文] 第${n}句：别松手。</d> `
  + `Her grip tightens on his sleeve while the lamp light slides across the wet steel.`,
  '',
  'overall_soundscape: Steady rain taps on the railing while distant traffic hums underneath. '
  + 'Fabric shifts and boots scrape the wet metal as a breath catches.',
  '',
  'non_diegetic_music: N/A',
].join('\n');
const vpFixture = (panels: number[]): string => JSON.stringify({
  prompts: panels.map((n) => ({
    panel: n, target_duration: 5, english_prompt: h3Prompt(n),
    chinese_translation: `第 ${n} 镜三字段翻译`, assumptions: '',
  })),
});
const dialogueFixture = {
  lines: [
    { speaker: '祥子', text: '别松手。', onScreen: true },
    { speaker: '帕琪', text: '我不会。', onScreen: true },
    { speaker: '祥子', text: '承诺过的。', onScreen: false },
  ],
};

function mkPanel(n: number): Panel {
  return {
    panel: n,
    time: `${2 + n * 0.5}s`,
    shot_size: 'medium wide',
    angle: n % 2 ? 'profile' : 'eye-level',
    lens_feel: 'natural 35mm perspective',
    camera_support: 'locked-off',
    movement: 'push-in',
    subject_relation: 'holds',
    start_frame: '可读起帧构图',
    end_frame: '变化后的终帧',
    fragile_anchors: 'yellow eyes / red bracelet',
    canvas: { width: 1536, height: 1024, ratio: '3:2' },
    camera: 'low side framing along the railing line',
    lighting: 'warm golden street lamps key against cool night blue fill',
    focus: 'sharp on the faces, soft skyline',
    positive_prompt: 'masterpiece anime illustration style, the frame shows the two figures on the wet grate, warm lamp reflections',
    positive_prompt_short: 'Two figures hold on the wet bridge.',
    negative_prompt: 'lowres, bad anatomy',
    nltags_sentences: ['the wet grate holds stretched lamp reflections', 'the figures stay frozen mid-gesture'],
    narrative_prompt: 'The two figures shift weight on the wet grate as the lamp light slides across the metal.',
    transition_hint: 'hard cut on the held gaze',
  } as Panel;
}
const PANELS_5 = [1, 2, 3, 4, 5].map(mkPanel);

// ── Mock 客户端（结构对齐 OpenAICompatibleClient.complete；按 tools[0].function.name 分发）──
class MockClient {
  calls: string[] = [];
  failDialogue = false;
  /** true 时对白夹具换为 8 个说话人（测声源 ID 封顶） */
  manySpeakers = false;
  private canned(tool: string): string {
    if (tool === 'storyboard_dialogue') {
      if (this.failDialogue) throw new Error('模拟对白提取失败');
      if (this.manySpeakers) {
        return JSON.stringify({ lines: Array.from({ length: MAX_SPEAKERS + 2 }, (_, i) => ({ speaker: `角色${i + 1}`, text: `第${i + 1}句`, onScreen: true })) });
      }
      return JSON.stringify(dialogueFixture);
    }
    if (tool === 'storyboard_videoprompt') return vpFixture([1, 2, 3, 4, 5]);
    return '{}';
  }
  private toolName(req: ChatRequest): string {
    return ((req.tools?.[0] as { function?: { name?: string } } | undefined)?.function?.name) ?? '';
  }
  async complete(req: ChatRequest): Promise<ChatResponse> {
    const tool = this.toolName(req);
    this.calls.push(tool);
    return { content: null, toolCalls: [{ id: 'c1', name: tool, arguments: this.canned(tool) }], finishReason: 'tool_calls', usage: null, raw: '' };
  }
  async stream(req: ChatRequest, _onDelta: (d: string) => void): Promise<ChatResponse> {
    return this.complete(req);
  }
}

console.log('\n== Schema 双路解析 ==');
const strict = safeParseStage(vpFixture([1, 2]), VideoPromptsSchema);
check('严格解析 2 镜', strict?.prompts.length === 2 && strict.prompts[0].target_duration === 5);
const lenient = safeParseStage(JSON.stringify({
  prompts: [{ panel: '2', target_duration: 'bad', english_prompt: 'integrated_multimodal_description: x\noverall_soundscape: y\nnon_diegetic_music: z' }],
}), VideoPromptsSchemaLenient);
check('lenient 补默认（coerce+catch）', lenient?.prompts.length === 1 && lenient.prompts[0].panel === 2 && lenient.prompts[0].target_duration === 5, JSON.stringify(lenient?.prompts[0]));
check('非法 JSON 返回 null', safeParseStage('not json', VideoPromptsSchema) === null);
const dlg = safeParseStage(JSON.stringify(dialogueFixture) + ' 尾随垃圾', DialogueSchema);
check('对白夹具容错解析 3 句', dlg?.lines.length === 3 && dlg.lines[0].speaker === '祥子');

console.log('\n== VP5 代码校验 ==');
const clean = validateVideoPrompts([1, 2].map((n) => ({
  panel: n, target_duration: 5, english_prompt: h3Prompt(n), chinese_translation: '', assumptions: '',
})), [1, 2]);
check('干净夹具 0 error 0 warning', clean.errors.length === 0 && clean.warnings.length === 0, `${clean.errors.join('|')} / ${clean.warnings.join('|')}`);
const tooLong = validateVideoPrompts([{ panel: 1, target_duration: 5, english_prompt: 'x'.repeat(H3_PROMPT_MAX_CHARS + 1), chinese_translation: '', assumptions: '' }], [1]);
check('超 7000 字符 → VV-E2', tooLong.errors.some((e) => e.startsWith('VV-E2')));
const noClose = validateVideoPrompts([{ panel: 1, target_duration: 5, english_prompt: `integrated_multimodal_description: <d>[中文] 未闭合`, chinese_translation: '', assumptions: '' }], [1]);
check('<d> 未闭合 → VV-E4', noClose.errors.some((e) => e.startsWith('VV-E4')));
const badDur = validateVideoPrompts([{ panel: 1, target_duration: 2.5, english_prompt: h3Prompt(1), chinese_translation: '', assumptions: '' }], [1]);
check('时长 2.5s → VV-E5', badDur.errors.some((e) => e.startsWith('VV-E5')));
const withMusic = validateVideoPrompts([{ panel: 1, target_duration: 5, english_prompt: h3Prompt(1).replace('non_diegetic_music: N/A', 'non_diegetic_music: Soft piano at slow tempo'), chinese_translation: '', assumptions: '' }], [1]);
check('music 非 N/A → VV-W1（警告不阻断）', withMusic.warnings.some((e) => e.startsWith('VV-W1')) && withMusic.errors.length === 0);
const zhOutside = validateVideoPrompts([{ panel: 1, target_duration: 5, english_prompt: h3Prompt(1) + ' 第1镜额外中文', chinese_translation: '', assumptions: '' }], [1]);
check('<d> 外中文 → VV-W3', zhOutside.warnings.some((e) => e.startsWith('VV-W3')));
const missingPanel = validateVideoPrompts([{ panel: 1, target_duration: 5, english_prompt: h3Prompt(1), chinese_translation: '', assumptions: '' }], [1, 2]);
check('缺镜 → VV-E1', missingPanel.errors.some((e) => e.startsWith('VV-E1')));

console.log('\n== 生成器端到端（mock 客户端，无 API）==');
const mem = new MemoryDb();
const client = new MockClient();
const deps: VideoPromptDeps = { client: client as unknown as VideoPromptDeps['client'], cardName: '测试卡', round: 1, mem };
const gen = new VideoPromptGenerator(deps);
const stagesSeen: string[] = [];
const result = await gen.run(PANELS_5, { sequenceSfx: '雨声+金属刮擦，无音乐', dialogueSource: '祥子说「别松手」' }, (label) => stagesSeen.push(label));
check('阶段推进 对白提取→视频提示词→完成', stagesSeen.join(',') === '对白提取,视频提示词,完成', stagesSeen.join('→'));
check('5 镜 → 5 prompts 升序', result.prompts.length === 5 && result.prompts.map((p) => p.panel).join(',') === '1,2,3,4,5', String(result.prompts.length));
check('整体 PASS', result.passed === true, `errors=${result.errors.join('|')}`);
check('模型调用 2 次（dialogue+videoprompt）', client.calls.join(',') === 'storyboard_dialogue,storyboard_videoprompt', client.calls.join(','));
check('声源名册 2 人（去重）', result.speakers.join(',') === 'S1: 祥子,S2: 帕琪', result.speakers.join(','));
check('markdown 含标题与每镜小节', result.markdown.includes('## MiniMax H3 视频提示词') && result.markdown.includes('### 第 3 镜（目标 5s）'));
const persisted = mem.db.prepare("SELECT entity_id, length(state_json) len FROM memory_state WHERE entity_type='storyboard_video'").get() as { entity_id: string; len: number } | undefined;
check('落库 memory_state(storyboard_video)', persisted?.entity_id === '测试卡' && (persisted.len ?? 0) > 100, JSON.stringify(persisted));

// 7 镜 → 2 批（恰好 2 次 videoprompt 调用）
const client7 = new MockClient();
const gen7 = new VideoPromptGenerator({ client: client7 as unknown as VideoPromptDeps['client'], cardName: '测试卡', round: 1 });
await gen7.run([1, 2, 3, 4, 5, 6, 7].map(mkPanel), {});
check('7 镜 → 恰好 2 次 videoprompt 调用', client7.calls.filter((c) => c === 'storyboard_videoprompt').length === 2, client7.calls.join(','));

// 对白提取失败 → 降级继续（prompts 照常产出 + warning；API 失败按纪律浮到 errors）
const clientBad = new MockClient();
clientBad.failDialogue = true;
const genBad = new VideoPromptGenerator({ client: clientBad as unknown as VideoPromptDeps['client'], cardName: '测试卡', round: 1 });
const resultBad = await genBad.run(PANELS_5, { dialogueSource: '祥子说「别松手」' });
check('对白提取失败 → 降级继续产出 + warning', resultBad.prompts.length === 5 && resultBad.warnings.some((w) => w.includes('对白提取')), `${resultBad.prompts.length}/${resultBad.warnings.join('|')}`);

// 声源上限：MAX_SPEAKERS+2 个说话人 → 唯一 ID 数封顶 S6
const clientMany = new MockClient();
clientMany.manySpeakers = true;
const genMany = new VideoPromptGenerator({ client: clientMany as unknown as VideoPromptDeps['client'], cardName: '测试卡', round: 1 });
const resultMany = await genMany.run(PANELS_5.slice(0, 1), { dialogueSource: '多人对话场景' });
check(`声源 ID 封顶 S${MAX_SPEAKERS}`, resultMany.speakers.length === MAX_SPEAKERS && resultMany.speakers[resultMany.speakers.length - 1] === `S${MAX_SPEAKERS}: 角色6`, resultMany.speakers.join(','));
check('DIALOGUE_SOURCE_MAX_CHARS=6000 常量存在', DIALOGUE_SOURCE_MAX_CHARS === 6000);

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
