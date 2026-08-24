/**
 * core 包 - 正则管道（04 §4.3 正则引擎落地 / 启动流程问题：卡片 regex_scripts 在前端屏蔽隐藏）
 * 能力：
 *  - 规则模型（scope: display=前端隐藏 / prompt=进模型前剥离 / both）
 *  - 内置默认库（屏蔽卡片/模型常见的 思维链/ERA 变量块/开局html 占位 等原始标记）
 *  - findRegex 解析（/.../flags 正则 或 字面串）
 *  - 按 scope 应用规则（顺序执行，返回应用统计）
 *  - 卡片 regex_scripts 智能导入（前端注入规则 display 专属启用，其余按卡片 disabled 标记）
 *  - display 三阶段管线 applyDisplayRules：GLA 场景块抽令牌 + 注入 HTML 抽令牌，其它规则不触碰注入产物
 */
import { extractGalBlocks } from './gal.ts';

/** 提取"GLA 前端界面"规则的外链引擎 URL（find 命中 <gal_inface> 且 replace 引用外链页），供外部前端备选路径 */
function galExternalUrlHint(find: string, replace: string): string | undefined {
  if (!/gal_inface/i.test(find)) return undefined;
  const m = /https?:\/\/[^\s'"`\]>]+/.exec(replace);
  return m ? m[0].replace(/\)$/, '') : undefined;
}

export interface RegexRule {
  id: string;
  name: string;
  findRegex: string;
  replaceString: string;
  enabled: boolean;
  /** display=前端屏蔽隐藏；prompt=进模型前剥离；both */
  scope: 'display' | 'prompt' | 'both';
  /** builtin=内置默认；user=用户维护；card=卡片自动导入 */
  source: 'builtin' | 'user' | 'card';
  /** 整文档前端注入（replaceString 为完整 HTML 文档/围栏）：display 专属、字面替换、绝进模型 prompt */
  inject?: boolean;
  /** GLA「前端界面」规则（find 命中 <gal_inface> 且 replace 引外链引擎页）：原生引擎消费 gal 块后此类规则结构性失效，
   *  此字段记录外链引擎 URL，供"外部前端"备选路径（Phase 6）使用 */
  galExternalUrl?: string;
  note?: string;
  order: number;
}

export type RegexScope = RegexRule['scope'];

/** 含正则元字符 → 视为裸正则（卡片脚本多为裸正则，如 \[…\]、<(options|selection)>、<\/\1>） */
const REGEXISH = /[\[\](){}*+?.\^$\\|]/;

/** 普通对话正文样例：无卡片占位符/HTML/八股词。用于判断卡片规则是否「匹配普通正文」——
 *  若匹配，说明它是模型上下文变换规则（如 ^([\s\S]*)$ 包 <user_input>），不应作用于展示。 */
const PLAIN_SAMPLE_TEXT = '她沉默了一会儿，然后轻声说：好的，我明白了。明天见。';

/** 整文锚定模式：^([\s\S]*)$ / ^[\s\S]*$ / ^.*$ 等——匹配并改写整条消息（卡片上下文标记） */
const WHOLE_TEXT_FIND = /^\^\(?\[\\s\\S\]\*\)?\$$|^\^\(?\.\*\)?\$$/;
/** 裸锚模式：$ / ^ / ^$——匹配每条消息的锚点（追加全局 CSS 等） */
const BARE_ANCHOR_FIND = /^[$\^]{1,2}$/;

/** 解析 findRegex：/pattern/flags 显式正则优先；含元字符按裸正则；否则按字面串（转义） */
export function parseFindRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  const m = pattern.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`); } catch { return null; }
  }
  // 裸正则（含正则元字符）：直接按正则解析，避免把 \[...\] / <(options|selection)> 双重转义成字面
  if (REGEXISH.test(pattern)) {
    try { return new RegExp(pattern, 'g'); } catch { return null; }
  }
  // 纯字面串（<think> 等标签）：转义正则元字符后按字面匹配
  try {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch { return null; }
}

/** 按 scope 应用规则：顺序执行 findRegex→replaceString；返回清洗文本 + 应用统计 */
export function applyRegexRules(text: string, rules: RegexRule[], scope: RegexScope): { text: string; applied: string[]; count: number } {
  let out = text;
  const applied: string[] = [];
  for (const r of rules) {
    if (!r.enabled || (r.scope !== scope && r.scope !== 'both')) continue;
    const re = parseFindRegex(r.findRegex);
    if (!re) continue;
    let hits = 0;
    const replaced = out.replace(re, (...args) => {
      hits++;
      return r.replaceString;
    });
    if (hits > 0) {
      applied.push(r.name);
      out = replaced;
    }
  }
  return { text: out, applied, count: applied.length };
}

/** display 三阶段管线：① GLA 块（<gal_inface>）先抽离为令牌（对其它规则完全不透明）；② 注入规则把占位符替换为唯一令牌；
 *  ③ 其余 display 规则在令牌化文本上运行；最后令牌还原为 HTML。
 *  保证注入的 HTML 与 gal 前端对其它 strip/杀八股 规则完全不透明（防止 <status>/<options> 等被误删）。
 *  Phase A 用函数替换 → replaceString 按字面（整文档注入无 $n 反向引用依赖）。 */
export function applyDisplayRules(
  text: string,
  rules: RegexRule[],
): { text: string; applied: string[]; injected: string[]; gal: string[] } {
  // Phase 0：GLA 场景块抽令牌（gal[] 保留块内脚本，前端 GalStage 消费；块对其它规则不可见）
  const { text: gText, gal } = extractGalBlocks(text);
  const injectRules = rules.filter((r) => r.inject && r.enabled);
  const otherRules = rules.filter((r) => !r.inject);
  // Phase A：注入 → 令牌（占位符先于一切 strip 被消费，如 <StatusPlaceHolderImpl/> 先注入后 strip 不抢先）
  const fragments = new Map<string, string>();
  let tokenized = gText;
  const injected: string[] = [];
  for (let idx = 0; idx < injectRules.length; idx++) {
    const r = injectRules[idx];
    const re = parseFindRegex(r.findRegex);
    if (!re) continue;
    let hits = 0;
    const token = `\x00JGF${idx}\x00`;
    tokenized = tokenized.replace(re, () => {
      hits++;
      fragments.set(token, r.replaceString);
      return token;
    });
    if (hits > 0) injected.push(r.name);
  }
  // Phase B：其余 display 规则（注入 HTML 不在文本里，对其完全不可见）
  const mid = applyRegexRules(tokenized, otherRules, 'display');
  // Phase C：令牌还原
  let out = mid.text;
  for (const [token, html] of fragments) {
    out = out.split(token).join(html);
  }
  return { text: out, applied: mid.applied, injected, gal };
}

/** 内置默认库：屏蔽卡片/模型常见的原始标记（display 为主；美化类默认禁用） */
export const DEFAULT_REGEX_RULES: RegexRule[] = [
  { id: 'builtin-think', name: '思维链 <think>', findRegex: '/<think>[\\s\\S]*?<\\/think>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 1 },
  { id: 'builtin-mini-cot', name: '认知隔离 mini-Cot', findRegex: '/<mini-Cot>[\\s\\S]*?<\\/mini-Cot>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 2 },
  { id: 'builtin-update-var', name: '变量更新块 UpdateVariable', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 3 },
  { id: 'builtin-opening-update', name: '开局变量块 OpeningUpdateVariable', findRegex: '/<OpeningUpdateVariable>[\\s\\S]*?<\\/OpeningUpdateVariable>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 4 },
  { id: 'builtin-repair', name: '变量检修 VariablesRepair', findRegex: '/<VariablesRepair>[\\s\\S]*?<\\/VariablesRepair>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 5 },
  { id: 'builtin-era-data', name: 'ERA 元数据 era_data', findRegex: '/<era_data>[\\s\\S]*?<\\/era_data>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 6 },
  { id: 'builtin-era-var', name: 'ERA 变量块 variable(insert|edit|delete|think)', findRegex: '/<variable(?:insert|edit|delete|think)>[\\s\\S]*?<\\/variable(?:insert|edit|delete|think)>/gi', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 7 },
  { id: 'builtin-kaimo-html', name: '开局 html 占位 <开局html/>', findRegex: '<开局html/>', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 8 },
  { id: 'builtin-status-placeholder', name: '状态栏占位 StatusPlaceHolderImpl', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 9 },
  { id: 'builtin-user-input', name: 'user_input 标签', findRegex: '</?user_input>', replaceString: '', enabled: true, scope: 'display', source: 'builtin', order: 10 },
  { id: 'builtin-persona-set', name: '人设生成块 人物设定/开场白', findRegex: '/<(?:人物设定|开场白)>[\\s\\S]*?<\\/(?:人物设定|开场白)>/gi', replaceString: '', enabled: false, scope: 'display', source: 'builtin', order: 11 },
  { id: 'builtin-html-fence', name: '```html 代码围栏（开局 HTML）', findRegex: '/^```html\\s*[\\s\\S]*?```$/gi', replaceString: '', enabled: false, scope: 'display', source: 'builtin', order: 12 },
];

/** 从卡片 extensions.regex_scripts 智能导入规则
 *  整文档前端注入（replaceString 为完整 HTML 文档/围栏）→ inject=true、display 专属、字面替换；
 *  其余（隐藏类/美化片段）→ 尊重卡片 disabled 标记启用，scope 按原映射。 */
export function importCardRegexScripts(
  scripts: { scriptName?: string; name?: string; findRegex?: string; replaceString?: string; markdownOnly?: boolean; promptOnly?: boolean; disabled?: boolean }[],
): RegexRule[] {
  const rules: RegexRule[] = [];
  for (const s of scripts) {
    const find = (s.findRegex ?? '').trim();
    if (!find) continue;
    // parseCharaCard 已把 scriptName 映射为 name；两处兼容
    const rawName = s.scriptName ?? s.name ?? 'card-regex';
    const name = rawName || 'card-regex';
    const replace = s.replaceString ?? '';
    // 整文档前端注入：replaceString 以代码围栏或完整文档标签开头（开场页/状态栏 HUD）→ 字面替换、display 专属。
    // 以 <details>/<div> 等开头的片段（如「更新块美化正则」用 ```json\n$1 包裹模板）依赖 $n 反向引用 → 属美化片段，不在此列
    const trimmedReplace = replace.trimStart();
    const isFrontendDoc = /^```/.test(trimmedReplace) || /^<!DOCTYPE|^<!doctype|^<html[\s>]/i.test(trimmedReplace);
    // 隐藏类（清空替换 或 名字含隐藏词）
    const isHide = replace === '' || /隐藏|屏蔽|去除|清理/.test(name);
    // 整文/裸锚变换规则：^([\s\S]*)$ 包 <user_input> 的上下文标记、$ 追加全局 CSS 等。
    // 它们是卡片专属约定，作用于全局库会污染其他卡会话的 prompt/display → 默认禁用，用户可在面板按需开启
    const isContextTransformer = WHOLE_TEXT_FIND.test(find) || BARE_ANCHOR_FIND.test(find);
    // scope 映射：promptOnly→prompt；markdownOnly→display；双 true/皆 false→both
    const scope: RegexRule['scope'] = s.promptOnly && !s.markdownOnly ? 'prompt' : s.markdownOnly && !s.promptOnly ? 'display' : 'both';
    // 「匹配普通正文」的变换规则只应作用于 prompt，否则会在 display 把每条消息整体改写。注入规则与纯隐藏不在此列
    const matchesPlain = !isFrontendDoc && !isContextTransformer && (() => {
      const re = parseFindRegex(find);
      return !!re && re.test(PLAIN_SAMPLE_TEXT);
    })();
    rules.push({
      id: `card-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rules.length}`,
      name,
      findRegex: find,
      replaceString: replace,
      // 不再因「美化」禁用：卡片 markdownOnly 前端/美化是渲染意图，一律尊重卡片 disabled 标记启用；
      // 整文/裸锚全局变换规则默认禁用（防跨卡污染）
      enabled: !s.disabled && !isContextTransformer,
      scope: isFrontendDoc ? 'display' : matchesPlain ? 'prompt' : scope,
      source: 'card',
      inject: isFrontendDoc,
      galExternalUrl: galExternalUrlHint(find, replace),
      note: isFrontendDoc ? '前端注入（仅展示，不进模型）' : isContextTransformer ? '整文/全局变换（跨卡易污染），默认禁用' : isHide ? '隐藏类，自动启用' : undefined,
      order: 100 + rules.length,
    });
  }
  return rules;
}
