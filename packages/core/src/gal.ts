/**
 * GLA（Galgame 交互）场景解析器——把角色卡/AI 回复里的 <gal_inface>…</gal_inface> 块解析为可渲染场景脚本。
 * 纯逻辑、零依赖，可在 node --experimental-strip-types 下单测（tools/cli/verify-gal.ts 用真实卡断言）。
 * 语法（鸿纱由美等 GLA 卡约定，行级扫描保留顺序）：
 *   指令行  [bg|背景名] [bgm|曲名] [show|角色|服装表情|槽位] [alter|角色|服装表情]
 *           [action|角色|动画] [cg|CG名] [hide_cg] [choice|选项1|选项2|…] [leave|角色]
 *   对话行  角色名|台词　旁白|台词　<user>|台词（行尾可内联 [action|…] 等指令，自动剥离并应用）
 *   注释    <!-- … -->（可含 <sprite_list>/<cg_list> 资产提示，供 LLM 选资产，展示层不消费）
 * 未包含 <gal_inface> 包裹的纯文本（如 greeting4 文字版）→ present=false，空场景。
 */

export type GalSpeakerRole = 'char' | 'narration' | 'user';

export type GalInstruction =
  | { kind: 'bgm'; name: string }
  | { kind: 'bg'; name: string }
  | { kind: 'show'; char: string; sprite: string; slot: string }
  | { kind: 'alter'; char: string; sprite: string }
  | { kind: 'action'; char: string; anim: string }
  | { kind: 'cg'; name: string }
  | { kind: 'hide_cg' }
  | { kind: 'choice'; options: string[] }
  | { kind: 'leave'; char: string }
  | { kind: 'line'; speaker: string; text: string; role: GalSpeakerRole };

export interface GalScene {
  instructions: GalInstruction[];
  /** <sprite_list>/<cg_list> 注释里提取的资产名提示（供作者/LLM 参考，展示层不消费） */
  assetHints: { sprites: string[]; cgs: string[] };
  warnings: string[];
  /** 是否含 <gal_inface> 包裹（纯文本版为 false → 显示层不建舞台） */
  present: boolean;
}

/** <gal_inface>…</gal_inface> 整块匹配（全局，可多个） */
const GAL_BLOCK_RE = /<gal_inface>([\s\S]*?)<\/gal_inface>/gi;

/** 已知指令名（句法校验用；未知指令进 warnings 并原样留作提示，不吞） */
const KNOWN_CMDS = new Set(['bg', 'bgm', 'show', 'alter', 'action', 'cg', 'hide_cg', 'choice', 'leave']);

/** 从文本中抽取所有 <gal_inface> 块到 gal[]，并把块替换为 \x00JGGAL<i>\x00 令牌（对其它显示规则不透明）。 */
export function extractGalBlocks(text: string): { text: string; gal: string[] } {
  const gal: string[] = [];
  const out = text.replace(GAL_BLOCK_RE, (m, inner: string) => {
    gal.push(inner);
    return `\x00JGGAL${gal.length - 1}\x00`;
  });
  return { text: out, gal };
}

/** 是否含 <gal_inface> 包裹 */
export function hasGalBlock(text: string): boolean {
  return /<gal_inface>/i.test(text);
}

/** 解析 GLA 指令行 [cmd|a|b]；未知指令 → warnings */
function applyCmd(name: string, body: string, out: GalInstruction[], warnings: string[]): void {
  const parts = body.split('|').map((s) => s.trim());
  switch (name) {
    case 'bgm': out.push({ kind: 'bgm', name: body.trim() }); break;
    case 'bg': out.push({ kind: 'bg', name: body.trim() }); break;
    case 'show': out.push({ kind: 'show', char: parts[0] ?? '', sprite: parts[1] ?? '', slot: parts[2] ?? '' }); break;
    case 'alter': out.push({ kind: 'alter', char: parts[0] ?? '', sprite: parts[1] ?? '' }); break;
    case 'action': out.push({ kind: 'action', char: parts[0] ?? '', anim: parts[1] ?? '' }); break;
    case 'cg': out.push({ kind: 'cg', name: body.trim() }); break;
    case 'hide_cg': out.push({ kind: 'hide_cg' }); break;
    case 'choice': out.push({ kind: 'choice', options: parts.filter(Boolean) }); break;
    case 'leave': out.push({ kind: 'leave', char: parts[0] ?? '' }); break;
    default: warnings.push(`未知指令 [${name}]`); break;
  }
}

/** 从注释行提取 <sprite_list>/<cg_list> 内容（宽松：闭合标签缺失时放弃该条，不报错） */
function collectAssetHints(line: string, hints: { sprites: string[]; cgs: string[] }): void {
  const sp = /<sprite_list>([\s\S]*?)<\/sprite_list>/i.exec(line);
  if (sp) hints.sprites.push(...sp[1].split(/[,\n、]/).map((s) => s.trim()).filter(Boolean));
  const cg = /<cg_list>([\s\S]*?)<\/cg_list>/i.exec(line);
  if (cg) hints.cgs.push(...cg[1].split(/[,\n、]/).map((s) => s.trim()).filter(Boolean));
}

/** 对话行内联指令（如 "叶梦|呀吼～[action|叶梦|jump_up]"）→ 追加指令并从展示文本剥离 */
const INLINE_CMD_RE = /\[([a-zA-Z_]+)\|([^\]]*)\]/g;

/** 解析一段可能含 <gal_inface> 包裹的文本为场景脚本（正文既有块可整体解析，也可直接给块内内容） */
export function parseGalInfaceScene(text: string): GalScene {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const open = /<gal_inface>/i.exec(normalized);
  let present = false;
  let body = normalized;
  if (open) {
    present = true;
    const rest = normalized.slice(open.index + open[0].length);
    const close = /<\/gal_inface>/i.exec(rest);
    body = close ? rest.slice(0, close.index) : rest;
  }

  const instructions: GalInstruction[] = [];
  const assetHints = { sprites: [] as string[], cgs: [] as string[] };
  const warnings: string[] = [];

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('<!--')) { collectAssetHints(line, assetHints); continue; }
    // 整行指令（带参 [cmd|a|b] 或无参 [cmd]，如 [hide_cg]）
    const cmd = /^\[([a-zA-Z_]+)\|([\s\S]*)\]$/.exec(line);
    if (cmd) {
      applyCmd(cmd[1], cmd[2], instructions, warnings);
      continue;
    }
    const cmdNoBody = /^\[([a-zA-Z_]+)\]$/.exec(line);
    if (cmdNoBody) {
      applyCmd(cmdNoBody[1], '', instructions, warnings);
      continue;
    }
    // 对话行（speaker|text）；无 | 的整行按旁白台词处理
    if (line.includes('|')) {
      const idx = line.indexOf('|');
      const speaker = line.slice(0, idx).trim();
      let text = line.slice(idx + 1).trim();
      const role: GalSpeakerRole = speaker === '旁白' ? 'narration'
        : (speaker === '<user>' || speaker.includes('<user>')) ? 'user' : 'char';
      const inline: GalInstruction[] = [];
      let disp = text;
      for (const mm of text.matchAll(INLINE_CMD_RE)) {
        disp = disp.replace(mm[0], '');
        applyCmd(mm[1], mm[2].trim(), inline, warnings);
      }
      const clean = disp.trim();
      if (clean || inline.length > 0) {
        if (clean) instructions.push({ kind: 'line', speaker, text: clean, role });
        instructions.push(...inline);
      }
    } else {
      instructions.push({ kind: 'line', speaker: '', text: line, role: 'narration' });
    }
  }
  return { instructions, assetHints, warnings, present };
}

/** 仅提取场景内所有计划出现的资产名（BG/立绘/音乐/CG，去重保序）——供资源预检/统计使用 */
export function collectSceneAssetNames(scene: GalScene): { bg: string[]; sprites: string[]; bgm: string[]; cg: string[] } {
  const pushU = (arr: string[], v: string): void => { if (v && !arr.includes(v)) arr.push(v); };
  const bg: string[] = [];
  const sprites: string[] = [];
  const bgm: string[] = [];
  const cg: string[] = [];
  for (const ins of scene.instructions) {
    if (ins.kind === 'bg') pushU(bg, ins.name);
    else if (ins.kind === 'bgm') pushU(bgm, ins.name);
    else if (ins.kind === 'cg') pushU(cg, ins.name);
    else if (ins.kind === 'show' || ins.kind === 'alter') pushU(sprites, ins.sprite);
  }
  return { bg, sprites, bgm, cg };
}