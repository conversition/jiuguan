/**
 * core 包 - 正则管道（04 §4.3 正则引擎落地 / 启动流程问题：卡片 regex_scripts 在前端屏蔽隐藏）
 * 能力：
 *  - 规则模型（scope: display=前端隐藏 / prompt=进模型前剥离 / both）
 *  - 内置默认库（屏蔽卡片/模型常见的 思维链/ERA 变量块/开局html 占位 等原始标记）
 *  - findRegex 解析（/.../flags 正则 或 字面串）
 *  - 按 scope 应用规则（顺序执行，返回应用统计）
 *  - 卡片 regex_scripts 智能导入（隐藏类启用、美化类禁用——美化是 ST UI 专属，本平台不渲染）
 */

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
  note?: string;
  order: number;
}

export type RegexScope = RegexRule['scope'];

/** 解析 findRegex：/pattern/flags 格式按正则；否则按字面串（转义） */
export function parseFindRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  const m = pattern.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`); } catch { return null; }
  }
  // 字面串（转义正则元字符；避免 `<think>` 被当作字符类等）
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

/** 从卡片 extensions.regex_scripts 智能导入规则（隐藏类启用；美化类禁用——ST UI 专属） */
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
    // 美化类（replaceString 含 <style>/<details> 或名字含 美化/显示）→ 导入但禁用（本平台不渲染 ST 美化）
    const replace = s.replaceString ?? '';
    const isBeautify = replace.includes('<style') || replace.includes('<details') || /美化|显示/.test(name);
    const isHide = replace === '' || /隐藏|屏蔽|去除|清理/.test(name);
    // scope 映射：promptOnly→prompt；markdownOnly→display；双 true/皆 false→both
    const scope: RegexRule['scope'] = s.promptOnly && !s.markdownOnly ? 'prompt' : s.markdownOnly && !s.promptOnly ? 'display' : 'both';
    rules.push({
      id: `card-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rules.length}`,
      name,
      findRegex: find,
      replaceString: replace,
      enabled: !s.disabled && (isHide || !isBeautify),
      scope,
      source: 'card',
      note: isBeautify ? '美化类（ST UI 专属），默认禁用' : isHide ? '隐藏类，自动启用' : undefined,
      order: 100 + rules.length,
    });
  }
  return rules;
}
