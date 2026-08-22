/**
 * prompt 包 - 导演分镜 schema（director content_mode）
 * 分镜创作工作流各阶段的输出契约：导演读本(stage0) / 逐镜分镜(stage1) / 串联序列(stage2) / 人类化改写(stage4)。
 * 校验器复用 game_turn 的 safeParse + issues 模式；容错解析对齐 safeParseTurn（平衡括号 + 尾随垃圾剥离）。
 *
 * 字段来源：`juben/plan/07-10` 规范 + `run-pipeline.js` Shot Contract（data/skills/分镜-* 同源）。
 */
import { z } from 'zod';

// ── Stage 0 导演读本（plan/10 §二 5 问 + §六 导演之声）──
export const DirectorsReadSchema = z.object({
  function: z.string().describe('这场戏在更大叙事里的功能：引入/深化/转折/收束'),
  turn: z.string().describe('转折，用"从X到Y"写出唯一变化，X/Y 为可见物理状态'),
  pov: z.string().describe('观众站在谁的体验内部，身体应站在哪里'),
  power: z.string().describe('谁拥有权力/谁想要/权力如何移动'),
  subtext: z.string().describe('什么是真的但没说出口，角色说的与想要的差距'),
  intention: z.string().describe('意图声明："让观众感受到 X"，不含抽象词'),
  voice: z.string().describe('导演之声：观察自然主义/古典构图/动态visceral/表现主义/亲密极简/图形形式主义'),
});
export type DirectorsRead = z.infer<typeof DirectorsReadSchema>;

// ── Stage 1 逐镜分镜（Shot Contract，对齐 run-pipeline.js panel 结构）──
export const CanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  ratio: z.string(),
});
export type Canvas = z.infer<typeof CanvasSchema>;

export const PanelSchema = z.object({
  panel: z.number().int().positive().describe('镜号 1..N'),
  time: z.string().describe('时长，如 2.5s'),
  shot_size: z.string().describe('景别：extreme wide/wide/medium wide/medium/medium close-up/close-up/extreme close-up/macro'),
  angle: z.string().describe('角度：eye-level/low angle/high angle/overhead/profile/over-shoulder/insert'),
  lens_feel: z.string().describe('镜头感：wide spatial energy/natural 35mm perspective/portrait compression/macro detail'),
  camera_support: z.string().describe('支撑：locked-off/handheld/slider/dolly/crane/gimbal'),
  movement: z.string().describe('运动：push-in/pull-back/lateral track/orbit/pan/tilt/pedestal/rack focus'),
  subject_relation: z.string().describe('subject_relation：camera follows/leads/discovers/holds/observes/blocks with subject'),
  start_frame: z.string().describe('第一帧可读构图'),
  end_frame: z.string().describe('变化后的状态/姿态/揭示/连续性交接帧'),
  fragile_anchors: z.string().describe('脆弱锚点 face/hands/logo/text/prop position/wardrobe，跨镜一致性锁定'),
  canvas: CanvasSchema,
  camera: z.string().describe('相机描述（构图语言，禁止 camera/lens/zoom 等设备词）'),
  lighting: z.string().describe('光线（含世界内光源动机）'),
  focus: z.string().describe('焦点/景深'),
  positive_prompt: z.string().describe('英文凝固帧 tag-stream，整段无标点'),
  positive_prompt_short: z.string().describe('英文自然语言简短版，约详细版 1/3'),
  negative_prompt: z.string().describe('英文负向提示词'),
  nltags_sentences: z.array(z.string()).describe('2-5 条单帧静态画面控制句'),
  narrative_prompt: z.string().describe('动态因果链（仅供视频模型），5-8 句英文'),
  transition_hint: z.string().describe('转场提示'),
});
export type Panel = z.infer<typeof PanelSchema>;

export const PanelsSchema = z.object({
  panels: z.array(PanelSchema),
});
export type Panels = z.infer<typeof PanelsSchema>;

// ── Stage 2 串联序列（plan/07 §八.3 六段式）──
export const SequenceSchema = z.object({
  master_prompt: z.string().describe('整体分镜概括提示词（Sequence Master Prompt，含统一视觉锚点表）'),
  rhythm_map: z.string().describe('全序列节奏地图（表格：镜号/时长/节奏类型/转场/情绪强度/衔接动势）'),
  narrative: z.string().describe('逐镜串联描述（精确时长 + 转场符号）'),
  consistency: z.string().describe('角色一致性锁定（外观锚点表/道具追踪/光线逻辑链/空间逻辑链）'),
  sfx: z.string().describe('音效设计 SFX Only（环境音/动作音/空间混响，禁 BGM）'),
  checklist: z.string().describe('节奏校验清单（逐项实证）'),
});
export type Sequence = z.infer<typeof SequenceSchema>;

// ── Stage 4 人类化改写（Humanizer-zh，只改人类面向散文）──
export const HumanizeScoresSchema = z.object({
  directness: z.number(),
  rhythm: z.number(),
  trust: z.number(),
  authenticity: z.number(),
  concision: z.number(),
});

export const HumanizeSchema = z.object({
  function: z.string(),
  turn: z.string(),
  pov: z.string(),
  power: z.string(),
  subtext: z.string(),
  intention: z.string(),
  master_desc: z.string().describe('序列整体描述改写（不得改动锚点表/正负向提示词）'),
  narrative: z.string().describe('逐镜串联描述改写（保留每镜时长与转场符号）'),
  summary: z.string(),
  scores: HumanizeScoresSchema,
});
export type Humanize = z.infer<typeof HumanizeSchema>;

// ── 容错解析（对齐 safeParseTurn：平衡括号提取 + 尾随垃圾剥离）──
function extractBalancedJson(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') inString = !inString;
    if (!inString) {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 解析分镜阶段 JSON 输出（容错），校验通过返回类型化数据 */
export function safeParseStage<T>(json: string, schema: z.ZodType<T>): T | null {
  if (!json || !json.trim()) return null;
  const attempts: string[] = [json.trim()];
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(json.slice(start, end + 1));
  const balanced = extractBalancedJson(json);
  if (balanced) attempts.push(balanced);
  for (const a of [...new Set(attempts)]) {
    try {
      const r = schema.safeParse(JSON.parse(a));
      if (r.success) return r.data;
    } catch { /* 继续下一个尝试 */ }
  }
  return null;
}

// ── OpenAI 兼容 tools 定义（各阶段结构化输出，风格对齐 gameTurnTool）──
export interface StageTool {
  key: string;
  tool: Record<string, unknown>;
}

function funcTool(name: string, description: string, params: Record<string, unknown>): Record<string, unknown> {
  return { type: 'function', function: { name, description, parameters: { type: 'object', ...params } } };
}

/** 各分镜阶段的 tools 定义（orchestrator 按工作流注册表阶段取用） */
export function storyboardStageTools(): Record<string, Record<string, unknown>> {
  const str = (d: string) => ({ type: 'string', description: d });
  const obj = (d: string, p: Record<string, unknown>) => ({ type: 'object', description: d, properties: p });
  return {
    stage0: funcTool('storyboard_read', '导演读本：对场景执行 5 问 + 意图声明 + 导演之声选择', {
      properties: {
        function: str('这场戏在更大叙事里的功能'),
        turn: str('从X到Y 的唯一变化'),
        pov: str('观众体验视角'),
        power: str('权力关系'),
        subtext: str('潜台词'),
        intention: str('意图声明（不含抽象词）'),
        voice: str('导演之声 6 选一'),
      },
      required: ['function', 'turn', 'pov', 'power', 'subtext', 'intention', 'voice'],
    }),
    stage1: funcTool('storyboard_shots', '逐镜分镜：为场景生成镜头序列，每镜含 Shot Contract 完整字段', {
      properties: {
        panels: {
          type: 'array',
          description: '镜头序列（每镜一个对象）',
          items: {
            type: 'object',
            properties: {
              panel: { type: 'number' },
              time: str('时长'),
              shot_size: str('景别'),
              angle: str('角度'),
              lens_feel: str('镜头感'),
              camera_support: str('支撑'),
              movement: str('运动'),
              subject_relation: str('subject_relation'),
              start_frame: str('起帧'),
              end_frame: str('终帧'),
              fragile_anchors: str('脆弱锚点'),
              canvas: obj('画布', { width: { type: 'number' }, height: { type: 'number' }, ratio: str('比率') }),
              camera: str('相机'),
              lighting: str('光线（含动机）'),
              focus: str('焦点'),
              positive_prompt: str('英文凝固帧 tag-stream'),
              positive_prompt_short: str('英文自然语言简短版'),
              negative_prompt: str('英文负向'),
              nltags_sentences: { type: 'array', items: { type: 'string' }, description: '2-5 条单帧控制句' },
              narrative_prompt: str('动态因果链'),
              transition_hint: str('转场提示'),
            },
            required: ['panel', 'time', 'shot_size', 'canvas', 'positive_prompt', 'negative_prompt', 'nltags_sentences', 'narrative_prompt'],
          },
        },
      },
      required: ['panels'],
    }),
    stage2: funcTool('storyboard_link', '串联序列：把各镜按节奏转场矩阵串成六段式完整序列', {
      properties: {
        master_prompt: str('整体分镜概括提示词'),
        rhythm_map: str('全序列节奏地图'),
        narrative: str('逐镜串联描述'),
        consistency: str('角色一致性锁定'),
        sfx: str('音效设计 SFX Only'),
        checklist: str('节奏校验清单'),
      },
      required: ['master_prompt', 'rhythm_map', 'narrative', 'consistency', 'sfx', 'checklist'],
    }),
    stage4: funcTool('storyboard_humanize', '人类化改写：去除 AI 痕迹，保留分镜专业信息', {
      properties: {
        function: str('读本 功能'),
        turn: str('读本 转折'),
        pov: str('读本 视角'),
        power: str('读本 权力'),
        subtext: str('读本 潜台词'),
        intention: str('意图'),
        master_desc: str('序列整体描述改写'),
        narrative: str('逐镜串联描述改写'),
        summary: str('改写小结'),
        scores: obj('改写评分', {
          directness: { type: 'number' },
          rhythm: { type: 'number' },
          trust: { type: 'number' },
          authenticity: { type: 'number' },
          concision: { type: 'number' },
        }),
      },
      required: ['intention', 'master_desc', 'narrative', 'summary', 'scores'],
    }),
  };
}

// ── VP1 部分确定性校验（Stage 1 输出，代码内联，不调模型）──
export interface ValidationIssue {
  stage: string;
  errors: string[];
  warnings: string[];
}

/** 反陈词禁止词（plan/10 §五.2：愿望不是决定，命中即 ERROR） */
const SLOP_WORDS = [
  'cinematic camera', 'dynamic shot', 'epic zoom', 'film look', 'hollywood style',
  'beautiful composition', 'cinematic lighting', 'dramatic', 'gorgeous', 'stunning', 'epic', 'breathtaking',
];
/** 豁免短语（plan/10 §五.2 v1.1）：风格定调/收束句保留，不触发反陈词 */
const SLOP_ALLOWLIST = [
  'cinematic composition',
  'cinematic motion clarity',
  'dramatic motion clarity',
  'dramatic tension',
  'dramatic energy',
  'dramatic rim',
];
const CAMERA_DEVICE_TERMS = ['camera', 'lens', 'tripod', 'zoom', 'pan', 'tilt', 'dolly', 'orbit', 'handheld', 'tracking shot'];
/** 时间线连续动作动词链（positive_prompt 必须是单一凝固帧，禁止事件推进，plan/11 §四） */
const TIMELINE_MOTION_TERMS = [
  'walks to', 'turns around', 'then reaches', 'arms rise', 'steps forward',
  'then she', 'then he', 'as she walks', 'the camera pulls', 'the camera moves', 'slowly tracking',
];
/** 情绪词（C3：情绪必须转为可见行为，plan/10 §七 C3） */
const EMOTION_WORDS = ['悲伤', '伤心', 'sad', 'depressed', 'anxious', 'afraid', 'fearful', 'grie'];
/** 世界内光源动机词（C4：光必须有可信世界内来源，plan/10 §五.3） */
const LIGHT_MOTIVATION = ['window', 'lamp', 'screen', 'sun', 'moon', 'candle', 'streetlamp', 'motivat', 'laptop'];

/** 反陈词命中（含豁免短语跳过：SLOP_WORDS 命中点在 SLOP_ALLOWLIST 整短语命中内则不算） */
function checkSlop(text: string): string[] {
  const low = (text || '').toLowerCase();
  return SLOP_WORDS.filter((w) => {
    if (!low.includes(w)) return false;
    return !SLOP_ALLOWLIST.some((phrase) => phrase.includes(w) && low.includes(phrase));
  });
}

/** 校验一组镜头：编号连续 / 必含字段 / 反陈词(+豁免) / 设备词 / 时间线动作 / 因果链 / 八段全面度 / 光线动机 / 脆弱锚点
 *          （对齐 plan/09 VP1 + plan/10 §五/§七 + plan/11 §四） */
export function validatePanels(panels: Panel[]): ValidationIssue {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    if (p.panel !== i + 1) errors.push(`S1-E4: 格 ${i + 1} 编号 ${p.panel} 不连续`);
    if (!p.positive_prompt) errors.push(`S1-E5: 格${p.panel} positive_prompt 为空`);
    if (!p.negative_prompt) errors.push(`S1-E6: 格${p.panel} negative_prompt 为空`);
    if (!p.canvas?.width || !p.canvas?.height || !p.canvas?.ratio) errors.push(`S1-E7: 格${p.panel} canvas 不完整`);
    if (!p.camera || !p.lighting || !p.focus) errors.push(`S1-E8: 格${p.panel} camera/lighting/focus 不完整`);
    if (!p.nltags_sentences || p.nltags_sentences.length < 2 || p.nltags_sentences.length > 5) {
      errors.push(`S1-E9: 格${p.panel} nltags ${p.nltags_sentences?.length || 0} 条（需2-5）`);
    }
    if (!p.narrative_prompt || p.narrative_prompt.trim().length < 40) {
      errors.push(`S1-E12: 格${p.panel} narrative_prompt 缺失或过短（需≥40字符英文因果链：动机→动作→状态变化→环境响应）`);
    }
    const pp = (p.positive_prompt || '').toLowerCase();
    // 反陈词（S1-E10）：豁免短语命中不触发
    const slopHits = checkSlop(p.positive_prompt);
    if (slopHits.length) errors.push(`S1-E10: 格${p.panel} positive_prompt 含反陈词: ${slopHits.join(', ')}`);
    // 相机设备词（S1-W14）：positive_prompt 禁止设备词（图会画出真实相机）
    const cameraHits = CAMERA_DEVICE_TERMS.filter((t) => pp.includes(t));
    if (cameraHits.length) warnings.push(`S1-W14: 格${p.panel} positive_prompt 含相机设备词 ${cameraHits.join('/')}（应用构图语言替代: the frame shows / viewed from / composed with）`);
    // 时间线连续动作（S1-W15）：必须凝固帧
    const motionHits = TIMELINE_MOTION_TERMS.filter((t) => pp.includes(t));
    if (motionHits.length) warnings.push(`S1-W15: 格${p.panel} positive_prompt 含时间线动作 "${motionHits.join('/')}"（凝固帧，动作用 caught/frozen/suspended 锚定）`);
    // 动作因果链（S1-W16）：narrative_prompt 需链式因果连接
    const np = (p.narrative_prompt || '').toLowerCase();
    if (!/then|as |while|after|before|依次|随后|随即|接着|—|→|, so |, and then/.test(np)) {
      warnings.push(`S1-W16: 格${p.panel} narrative_prompt 缺动作因果连接（推荐"动作因果依次为：A—B—C"链式表达）`);
    }
    // 正向提示词八段全面度（S1-W17）：质量前缀 + 动作瞬间/光影/层级 ≥2 核心段
    const qPrefixOk = /masterpiece|best quality|highly detailed|\bvery aesthetic\b/.test(pp);
    const coreHits = [
      /\b(the exact instant|mid-|frozen|caught|suspended|halted)\b/,
      /(key light|rim light|backlight|backlit|illuminat|halation|specular)/,
      /\b(hierarchy|focal point|first [a-z, ]* second [a-z, ]* third)\b/,
    ].filter((re) => re.test(pp)).length;
    if (!qPrefixOk || coreHits < 2) {
      warnings.push(`S1-W17: 格${p.panel} positive_prompt 八段全面度不足（质量前缀${qPrefixOk ? '✓' : '✗'}，核心段 ${coreHits}/3 需≥2，对照 plan/11 §四 逐段补齐）`);
    }
    // 情绪词转可见行为（C3）
    const emotionHits = EMOTION_WORDS.filter((w) => pp.includes(w));
    if (emotionHits.length) warnings.push(`C3: 格${p.panel} 含情绪词 ${emotionHits.join('/')}，需转为可见行为`);
    // 光源动机（C4）：光/相机需世界内来源或动机
    const lightLow = (p.lighting || '').toLowerCase();
    if (!LIGHT_MOTIVATION.some((k) => pp.includes(k) || lightLow.includes(k))) {
      warnings.push(`C4: 格${p.panel} 光源未见世界内动机来源`);
    }
    // 脆弱锚点（C6）
    if (!p.fragile_anchors) warnings.push(`C6: 格${p.panel} 缺脆弱锚点 fragile_anchors`);
  }
  return { stage: 'VP1', errors, warnings };
}

/** 校验串联序列（对齐 plan/09 VP2：六段式存在 + master_prompt 统一视觉锚点表 + SFX 无 BGM） */
export function validateSequence(seq: Partial<Sequence>): ValidationIssue {
  const errors: string[] = [];
  const warnings: string[] = [];
  const required: Array<[keyof Sequence, string]> = [
    ['master_prompt', '整体分镜概括提示词'],
    ['rhythm_map', '全序列节奏地图'],
    ['narrative', '逐镜串联描述'],
    ['consistency', '角色一致性锁定'],
    ['sfx', '音效设计'],
    ['checklist', '节奏校验清单'],
  ];
  for (const [k, label] of required) {
    if (!seq[k]) errors.push(`S2-E: 串联缺 ${label}（${k}）`);
  }
  // S2-W5: master_prompt 应包含统一视觉锚点表（6行：画风/色调/光线/角色/场景/景深）
  if (seq.master_prompt && !/统一视觉锚点|视觉锚点表/.test(seq.master_prompt)) {
    warnings.push('S2-W5: 整体分镜概括缺「统一视觉锚点表」（画风/色调/光线/角色/场景/景深 6 行）');
  }
  // S2-W8: 音效必须 SFX Only（物理声源，禁音乐）
  if (seq.sfx && /BGM|music|soundtrack|score|melody|rhythm|beat/i.test(seq.sfx)) {
    warnings.push('S2-W8: 音效段含 BGM/音乐描述');
  }
  return { stage: 'VP2', errors, warnings };
}

// ── 导演分镜 Markdown 渲染（端口自 juben run-pipeline panelToMarkdown + 端到端组装，下载/探窗共用）──

/** 渲染入参（取自 StoryboardResult 关键字段，避免 prompt→tools 循环依赖） */
export interface DirectorRenderInput {
  sceneName?: string;
  directorSource?: string;
  voice?: string;
  intention?: string;
  panels: Panel[];
  sequence: Sequence | null;
  humanized?: { summary?: string } | null;
  validation?: { stage: string; errors: string[]; warnings: string[] }[];
}

/** 长提示词按标点折行（内容不变，仅加换行，对模型无害） */
function wrapPromptLine(text: string): string[] {
  const sentences = String(text || '').split(/(?<=[.!?。])\s+/);
  const out: string[] = [];
  for (const sen of sentences) {
    const t = sen.trim();
    if (!t) continue;
    if (t.length <= 90) { out.push(t); continue; }
    const parts = t.split(/(?<=[,，]\s)/);
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 90 && cur) { out.push(cur.trim()); cur = p; }
      else cur += p;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/** 单镜渲染（可读性版：镜头契约分组 + fragile 拆行 + 提示词折行） */
export function panelToMarkdown(p: Panel, idx: number): string {
  const lines: string[] = [];
  const time = p.time || '';
  const st = p.shot_size || '';
  lines.push(`### 第 ${p.panel || idx + 1} 镜｜${st || '分镜'}`);
  lines.push('');
  const contract: string[] = [];
  if (st) contract.push(`景别 ${st}`);
  if (p.angle) contract.push(`角度 ${p.angle}`);
  if (p.canvas) contract.push(`画布 ${p.canvas.width}x${p.canvas.height} (${p.canvas.ratio})`);
  if (p.lens_feel) contract.push(`镜头感 ${p.lens_feel}`);
  if (p.camera_support) contract.push(`支撑 ${p.camera_support}`);
  if (p.movement) contract.push(`运动 ${p.movement}`);
  if (p.subject_relation) contract.push(`关系 ${p.subject_relation}`);
  if (time || contract.length) {
    lines.push(`> ${[`${time}`, ...contract.slice(0, 4)].join(' ｜ ')}`);
    lines.push('');
  }
  if (p.start_frame || p.end_frame) {
    lines.push('**画面进程**');
    if (p.start_frame) lines.push(`- 起帧：${p.start_frame}`);
    if (p.end_frame) lines.push(`- 终帧：${p.end_frame}`);
    lines.push('');
  }
  if (p.fragile_anchors) {
    lines.push('**一致性锚点（fragile_anchors）**');
    const parts = String(p.fragile_anchors).split(/;|；|\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) parts.forEach((part) => lines.push(`- ${part}`));
    else lines.push(`- ${p.fragile_anchors}`);
    lines.push('');
  }
  if (p.camera || p.lighting || p.focus) {
    lines.push('**相机 · 光线 · 焦点**');
    if (p.camera) lines.push(`- 相机：${p.camera}`);
    if (p.lighting) lines.push(`- 光线：${p.lighting}`);
    if (p.focus) lines.push(`- 焦点：${p.focus}`);
    lines.push('');
  }
  if (p.positive_prompt) {
    lines.push('**正向提示词（详细·凝固帧）**');
    wrapPromptLine(p.positive_prompt).forEach((l) => lines.push(`> ${l}`));
    lines.push('');
  }
  if (p.positive_prompt_short) {
    lines.push('**正向提示词（简版）**');
    lines.push(`> ${p.positive_prompt_short || ''}`);
    lines.push('');
  }
  if (p.negative_prompt) {
    lines.push('**负向提示词**');
    wrapPromptLine(p.negative_prompt).forEach((l) => lines.push(`> ${l}`));
    lines.push('');
  }
  if (p.nltags_sentences && p.nltags_sentences.length) {
    lines.push('**nltags 控制句**');
    p.nltags_sentences.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  if (p.narrative_prompt) {
    lines.push('**动态因果链 narrative_prompt（视频模型）**');
    wrapPromptLine(p.narrative_prompt).forEach((l) => lines.push(`> ${l}`));
    lines.push('');
  }
  if (p.transition_hint) lines.push(`**转场**：${p.transition_hint}`);
  return lines.join('\n');
}

/** 端到端 Markdown（逐镜 + 串联 + 校验报告 + 元信息），探窗展示 + .md 下载共用 */
export function renderDirectorMarkdown(r: DirectorRenderInput): string {
  const name = r.sceneName ?? '导演分镜';
  const voice = r.voice ?? '';
  const intention = r.intention ?? '';
  const panelsMd = r.panels.length ? r.panels.map((p, i) => panelToMarkdown(p, i)).join('\n\n') : '（无分镜产出）';
  const seqMd = r.sequence ? [
    '# 分镜串联序列（Stage 2）',
    '',
    '## 零、整体分镜概括提示词（Sequence Master Prompt）',
    '',
    r.sequence.master_prompt || '',
    '',
    '## 一、全序列节奏地图',
    '',
    r.sequence.rhythm_map || '',
    '',
    '## 二、逐镜串联描述',
    '',
    r.sequence.narrative || '',
    '',
    '## 三、角色一致性锁定',
    '',
    r.sequence.consistency || '',
    '',
    '## 四、音效设计（SFX Only）',
    '',
    r.sequence.sfx || '',
    '',
    '## 五、节奏校验清单',
    '',
    r.sequence.checklist || '',
  ].join('\n') : '';
  const vpLines = (r.validation ?? []).map((v) => {
    const rows: string[] = [
      `### ${v.stage} ${v.errors.length === 0 ? '✅ PASS' : '❌ FAIL'}`,
    ];
    if (v.errors.length) rows.push('**Errors:**', ...v.errors.map((e) => `- ${e}`));
    if (v.warnings.length) rows.push('**Warnings:**', ...v.warnings.map((w) => `- ${w}`));
    return rows.join('\n');
  });
  const summary = r.humanized?.summary ? `\n\n> 🧑‍💻 人类化改写：${r.humanized.summary}` : '';
  return [
    `# ${name} 分镜（导演模式）`,
    '',
    `> 选取片段：${r.directorSource ?? ''}${voice ? ` ｜ 导演之声: ${voice}` : ''}${intention ? ` ｜ 意图: ${intention}` : ''}${summary}`,
    '',
    '---',
    '',
    '## 一、镜头分解（Stage 1）',
    '',
    panelsMd,
    seqMd ? `\n---\n\n${seqMd}` : '',
    vpLines.length ? `\n---\n\n## 校验报告（Stage 3）\n\n${vpLines.join('\n\n')}` : '',
  ].join('\n');
}
