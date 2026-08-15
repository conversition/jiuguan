/**
 * core 包验证 - 正则管道（04 §4.3：前端屏蔽隐藏 + 卡片正则智能导入 + 正则库 CRUD）
 */
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_REGEX_RULES, applyRegexRules, parseFindRegex, importCardRegexScripts } from '../src/regex.ts';
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
];
const imported = importCardRegexScripts(scripts);
check('导入 4 条', imported.length === 4, String(imported.length));
check('隐藏类启用', imported.find((x) => x.name.includes('隐藏开局html'))?.enabled === true);
check('美化类禁用（开局html美化含```html…```）', imported.find((x) => x.name === '开局html美化')?.enabled === false);
check('美化 CSS 禁用', imported.find((x) => x.name.includes('美化CSS'))?.enabled === false);
check('promptOnly→scope=prompt', imported.find((x) => x.name.includes('隐藏更新块'))?.scope === 'prompt');
check('markdownOnly→scope=display', imported.find((x) => x.name.includes('隐藏开局html'))?.scope === 'display');

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
// 隐藏开局html显示 与 开局html美化 共用 <开局html/> 模式 → 按模式去重保留先出现的隐藏类
check('卡片导入 3 条（同模式去重保留隐藏类）', imp2.imported === 3 && imp2.skipped === 1, JSON.stringify(imp2));
check('去重后保留隐藏类', lib.list().some((r) => r.source === 'card' && r.name === '隐藏开局html显示' && r.enabled));
const imp3 = lib.importFromCard(scripts);
check('重复导入去重', imp3.imported === 0 && imp3.skipped === 4, JSON.stringify(imp3));
const lib2 = new RegexLibrary();
check('持久化往返（卡片规则保留）', lib2.list().some((r) => r.source === 'card' && r.name.includes('隐藏开局html')), `total=${lib2.list().length}`);
check('regex-rules.json 已写', existsSync(resolve(process.env.JG_USER_DATA_DIR, 'regex-rules.json')));
rmSync(process.env.JG_USER_DATA_DIR, { recursive: true, force: true });

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
