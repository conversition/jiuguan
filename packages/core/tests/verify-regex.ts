/**
 * core 包验证 - 正则管道（04 §4.3：前端屏蔽隐藏 + 卡片正则智能导入 + 正则库 CRUD + display 两阶段注入）
 */
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_REGEX_RULES, applyRegexRules, parseFindRegex, importCardRegexScripts, applyDisplayRules } from '../src/regex.ts';
import { RegexLibrary } from '../src/regex-library.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== 解析 ==');
check('/…/gi 格式', parseFindRegex('/<think>[\\s\\S]*?<\\/think>/gi')?.toString().includes('think') === true);
check('字面串转义（<开局html/> 不当作标签）', parseFindRegex('<开局html/>')?.source === '<开局html\\/>');
check('裸正则（含元字符）→ 按正则解析（不再双重转义）', parseFindRegex('\\[角色创建与故事开场\\]')?.test('[角色创建与故事开场]') === true);
check('裸正则 <(options|selection)> 命中', parseFindRegex('<(options|selection)>([\\s\\S]*?)<\\/\\1>')?.test('<options>x</options>') === true);
check('非法正则返回 null', parseFindRegex('/(/') === null);

console.log('\n== 内置默认库应用（display）==');
const dirty = '她沉默。<think>她其实很在意</think>然后说：好。<UpdateVariable>{"魔力":90}</UpdateVariable><era_data>{"meta":1}</era_data><开局html/>';
const r1 = applyRegexRules(dirty, DEFAULT_REGEX_RULES, 'display');
check('屏蔽 think/UpdateVariable/era_data/开局html', !r1.text.includes('<think>') && !r1.text.includes('<UpdateVariable>') && !r1.text.includes('<era_data>') && !r1.text.includes('<开局html/>'), r1.text);
check('正文保留', r1.text.includes('她沉默') && r1.text.includes('然后说：好'), r1.text);
check('应用计数', r1.applied.length >= 4, r1.applied.join('|'));

console.log('\n== scope 过滤（prompt 规则不进 display）==');
const mixed = [...DEFAULT_REGEX_RULES, { id: 't', name: 'prompt-only', findRegex: '<PFLAG>', replaceString: '', enabled: true, scope: 'prompt' as const, source: 'user' as const, order: 999 }];
const r2 = applyRegexRules('x<PFLAG>y', mixed, 'display');
check('prompt 规则不在 display 应用', r2.text.includes('<PFLAG>'));
const r3 = applyRegexRules('x<PFLAG>y', mixed, 'prompt');
check('prompt 规则在 prompt 应用', !r3.text.includes('<PFLAG>'));

console.log('\n== 卡片正则智能导入 ==');
const scripts = [
  { scriptName: '隐藏开局html显示', findRegex: '<开局html/>', replaceString: '', markdownOnly: true, promptOnly: false, disabled: false },
  { scriptName: '隐藏更新块提示词', findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi', replaceString: '', markdownOnly: false, promptOnly: true, disabled: false },
  { scriptName: '思维链、更新块美化CSS管理正则', findRegex: '$', replaceString: '<style>…</style>', markdownOnly: true, promptOnly: false, disabled: true },
  { scriptName: '开局html美化', findRegex: '<开局html/>', replaceString: '```html…```', markdownOnly: true, promptOnly: false, disabled: false },
  { scriptName: '状态栏前端', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<!DOCTYPE html><html><body><status>机密</status><div>状态栏</div></body></html>', markdownOnly: true, promptOnly: false, disabled: false },
  { scriptName: '完整变量更新美化', findRegex: '/<update>[\\s\\S]*?<\\/update>/gi', replaceString: '<details><summary>$2</summary></details>', markdownOnly: true, promptOnly: false, disabled: false },
];
const imported = importCardRegexScripts(scripts);
check('导入 6 条', imported.length === 6, String(imported.length));
check('隐藏类启用', imported.find((x) => x.name.includes('隐藏开局html'))?.enabled === true);
check('前端文档注入启用+inject+display（状态栏）', imported.find((x) => x.name === '状态栏前端')?.enabled === true && imported.find((x) => x.name === '状态栏前端')?.inject === true && imported.find((x) => x.name === '状态栏前端')?.scope === 'display');
check('围栏整文档注入（开局html美化）', imported.find((x) => x.name === '开局html美化')?.inject === true && imported.find((x) => x.name === '开局html美化')?.scope === 'display');
check('美化片段启用但非 inject（完整变量更新）', imported.find((x) => x.name.includes('完整变量更新'))?.enabled === true && imported.find((x) => x.name.includes('完整变量更新'))?.inject !== true);
check('disabled 尊重（美化 CSS）', imported.find((x) => x.name.includes('美化CSS'))?.enabled === false);
check('promptOnly→scope=prompt', imported.find((x) => x.name.includes('隐藏更新块'))?.scope === 'prompt');
check('markdownOnly→scope=display', imported.find((x) => x.name.includes('隐藏开局html'))?.scope === 'display');
// 「匹配整条普通正文」的变换规则（如 ^([\s\S]*)$ 包 <user_input>）→ 默认禁用（跨卡易污染），用户可按需开启
const wholeText = importCardRegexScripts([{ scriptName: '最新输入强调', findRegex: '^([\\s\\S]*)$', replaceString: '<user_input>\n$1\n</user_input>', disabled: false }]);
check('整文匹配变换规则 → 默认禁用', wholeText[0]?.enabled === false && wholeText[0]?.inject !== true, JSON.stringify(wholeText[0]));
// 裸锚 $ 追加全局 CSS → 默认禁用
const bareAnchor = importCardRegexScripts([{ scriptName: '全局CSS美化', findRegex: '$', replaceString: '<style>details{}</style>', disabled: false }]);
check('裸锚 $ 全局注入 → 默认禁用', bareAnchor[0]?.enabled === false, JSON.stringify(bareAnchor[0]));
// 纯占位符注入不被误判为整文匹配
const markerInject = importCardRegexScripts([{ scriptName: '开场前端', findRegex: '<开局html/>', replaceString: '```\n<html><body>前端</body></html>\n```', disabled: false }]);
check('占位符注入仍为 display', markerInject[0]?.scope === 'display' && markerInject[0]?.inject === true, JSON.stringify(markerInject[0]));

console.log('\n== applyDisplayRules 两阶段（注入 HTML 对其它规则不透明）==');
const stripStatus = { id: 't-status', name: '删状态块', findRegex: '/<(status)>[\\s\\S]*?<\\/status>/g', replaceString: '', enabled: true, scope: 'both' as const, source: 'user' as const, order: 999 };
const kill = { id: 't-kill', name: '杀八股', findRegex: '/。{2,}/g', replaceString: '', enabled: true, scope: 'both' as const, source: 'user' as const, order: 1000 };
const all = [...imported, stripStatus, kill];
const docHtml = imported.find((x) => x.name === '状态栏前端')?.replaceString ?? '';
check('注入 HTML 完整保留（<status> 不被 strip 误删）', applyDisplayRules('<StatusPlaceHolderImpl/>', all).text.includes('<status>机密</status>'));
check('注入后无残留占位符', !applyDisplayRules('<StatusPlaceHolderImpl/>', all).text.includes('<StatusPlaceHolderImpl/>'));
check('占位符先注入后 strip 不抢先', applyDisplayRules('前缀<StatusPlaceHolderImpl/>后缀', all).text.includes(docHtml));
check('prompt scope 不含注入 HTML', !applyRegexRules('<StatusPlaceHolderImpl/>', all, 'prompt').text.includes('<html'));
check('injected 规则被统计', applyDisplayRules('<StatusPlaceHolderImpl/>', all).injected.length === 1);

console.log('\n== 正则库 CRUD + 持久化 ==');
process.env.JG_USER_DATA_DIR = resolve('data', 'test-regex-lib');
rmSync(process.env.JG_USER_DATA_DIR, { recursive: true, force: true });
const lib = new RegexLibrary();
check('合并视图含内置', lib.list().length >= DEFAULT_REGEX_RULES.length);
const userRule = lib.save({ id: 'user-my', name: '我的规则', findRegex: '测试词', replaceString: '', enabled: true, scope: 'display', source: 'user', order: 1 });
check('保存用户规则', lib.get('user-my')?.source === 'user');
check('内置不可删', lib.remove('builtin-think') === false);
check('用户规则可删', lib.remove('user-my') === true);
const imp2 = lib.importFromCard(scripts);
// 按 name upsert：6 条全部新导入（隐藏开局html显示 与 开局html美化 同 find 但不同 name → 并存，不再按 findRegex 去重）
check('卡片导入 6 条（同名不同 find 并存）', imp2.imported === 6 && imp2.skipped === 0, JSON.stringify(imp2));
check('隐藏类保留', lib.list().some((r) => r.source === 'card' && r.name === '隐藏开局html显示' && r.enabled));
check('前端注入规则存在', lib.list().some((r) => r.source === 'card' && r.name === '状态栏前端' && r.inject === true));
const imp3 = lib.importFromCard(scripts);
check('重复导入去重', imp3.imported === 0 && imp3.skipped === 6, JSON.stringify(imp3));
// 用户编辑某条卡规则后重导不覆盖（source='user' 保护）
const edited = lib.list().find((r) => r.name === '隐藏开局html显示');
if (edited) lib.save({ ...edited, enabled: false });
const imp4 = lib.importFromCard(scripts);
check('用户编辑不被重导覆盖', lib.list().find((r) => r.name === '隐藏开局html显示')?.enabled === false, JSON.stringify(lib.list().find((r) => r.name === '隐藏开局html显示')));
const lib2 = new RegexLibrary();
check('持久化往返（卡片规则保留）', lib2.list().some((r) => r.source === 'card' && r.name === '状态栏前端' && r.inject === true), `total=${lib2.list().length}`);
check('regex-rules.json 已写', existsSync(resolve(process.env.JG_USER_DATA_DIR, 'regex-rules.json')));
rmSync(process.env.JG_USER_DATA_DIR, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
