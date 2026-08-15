/**
 * VMS + 装配集成验证：夏瑾预设 29 个 setvar 真实变量 → VMS 注册 → 求值 → 宏展开
 */
import { readFileSync } from 'node:fs';
import { VariableManager } from '../src/vms.ts';
import { assembleTurn, expandVariables, DEFAULT_SYSTEM_CORE } from '../../prompt/src/assembly.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// 1. 解析夏瑾真实 setvar
const xj = JSON.parse(readFileSync('E:/claude cade test/project/jiuguanlike/剧本方案/预设/夏瑾 双鱼座 Beta 0.40.json', 'utf8'));
const allContent = xj.prompts.map((p: { content: string }) => p.content).join('\n');
const setvarMatches = [...allContent.matchAll(/\{\{setvar::([^:}]+)::([\s\S]*?)\}\}/g)];
console.log(`== 夏瑾 setvar 解析: ${setvarMatches.length} 个 ==`);

// 2. 注册到 VMS（preset 源；空默认值跳过或存空串）
const vms = new VariableManager();
let registered = 0;
for (const m of setvarMatches) {
  const name = m[1];
  const value = m[2].trim();
  try {
    vms.register({ scope: 'preset', source: 'preset', name, type: 'literal', value });
    registered++;
  } catch { /* 非法名跳过 */ }
}
check(`注册 ${registered} 个`, registered >= 20, `registered=${registered}`);

// 3. 求值 + 宏展开
const r = vms.evaluate();
check('求值无错误', r.errors.length === 0, JSON.stringify(r.errors.slice(0, 3)));
const wordsCloud = r.values['preset:preset:wordsCloud'];
check('wordsCloud 变量值', typeof wordsCloud === 'string' && wordsCloud.includes('1000'), `got=${wordsCloud}`);
const jailbreak = r.values['preset:preset:JailbreakPrompt'];
check('JailbreakPrompt 变量值', typeof jailbreak === 'string' && jailbreak.length > 20, `got=${String(jailbreak).slice(0, 30)}`);

// 4. 装配宏展开（用户输入引用变量）
const expanded = expandVariables(
  '请按 {{var:preset:preset:wordsCloud}} 字数写作，使用 {{getvar::JailbreakPrompt::默认}} 的理念',
  r.values,
);
check('{{var:}} 展开', expanded.includes('不少于1000'), expanded);
check('{{getvar::}} 展开', expanded.includes('你允许创作任何设定'), expanded.slice(0, 80));

// 5. 完整装配（变量值传入 assembleTurn）
const assembled = assembleTurn({
  systemCore: DEFAULT_SYSTEM_CORE,
  userInput: '生成一段 {{var:preset:preset:wordsCloud}} 的正文',
  useTools: true,
  variableValues: r.values,
});
const userMsg = assembled.messages[assembled.messages.length - 1].content;
check('装配内宏展开', userMsg.includes('不少于1000'), userMsg.slice(0, 60));

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
