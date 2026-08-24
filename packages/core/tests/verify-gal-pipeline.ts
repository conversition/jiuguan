/**
 * GLA 显示管线验证：applyDisplayRules 的 gal 抽取 + galExternalUrl 识别 + 与注入规则共存。
 * 运行：node --experimental-strip-types --experimental-transform-types packages/core/tests/verify-gal-pipeline.ts
 */
import { applyDisplayRules, importCardRegexScripts } from '../src/regex.ts';
import type { RegexRule } from '../src/regex.ts';
import { extractGalBlocks, parseGalInfaceScene } from '../src/gal.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

console.log('\n== 真实卡规则：galExternalUrl 识别 ==');
const galExt = importCardRegexScripts([{
  scriptName: '前端界面',
  findRegex: '/<gal_inface>([\\s\\S]*?)</gal_inface>/gm',
  replaceString: '```text\n<body>\n<script>\n$(\'body\').load(\'https://raw.githubusercontent.com/rbqyorino/amakano3/refs/heads/main/index.html\')\n</script>\n</body>\n```',
  markdownOnly: true,
}]);
check('识别 galExternalUrl', galExt[0].galExternalUrl === 'https://raw.githubusercontent.com/rbqyorino/amakano3/refs/heads/main/index.html');
check('规则仍启用（原生引擎消费后结构性失效，零冲突）', galExt[0].enabled === true);
const galExt2 = importCardRegexScripts([{ scriptName: '普通规则', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '' }]);
check('非 gal 规则无 galExternalUrl', galExt2[0].galExternalUrl === undefined);

console.log('\n== applyDisplayRules：gal 抽取 + 与注入规则共存 ==');
const injectRule: RegexRule = {
  id: 'r-inject', name: '开场HTML注入', findRegex: '<开局html/>', replaceString: '<div class="opening-html"><b>开场页</b></div>',
  enabled: true, scope: 'display', source: 'card', inject: true, order: 1,
};
const stripRule: RegexRule = {
  id: 'r-strip', name: '杀八股', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '',
  enabled: true, scope: 'display', source: 'card', order: 2,
};
const text = '<开局html/>\n<gal_inface>\n[bg|乐乐浦寮会客厅早晨]\n叶梦|呀吼！\n</gal_inface>\n叙事：她笑了。\n<status>机密</status>';
const dr = applyDisplayRules(text, [injectRule, stripRule]);
check('gal 数组捕获 1 个场景块', dr.gal.length === 1 && dr.gal[0].includes('[bg|乐乐浦寮会客厅早晨]'));
check('注入 HTML 还原（不受 gal 抽取影响）', dr.text.includes('class="opening-html"'));
check('叙事文本保留', dr.text.includes('叙事：她笑了。'));
check('剩余文本含 gal 令牌（供 splitGalSegments）', dr.text.includes('\x00JGGAL0\x00'));
check('gal 块未被 strip 规则改写', !dr.text.includes('<gal_inface>'));
const parsed = parseGalInfaceScene(dr.gal[0]);
check('gal 块可再解析为场景（内层无包裹也能解析）', parsed.instructions.filter((x) => x.kind === 'bg').length === 1
  && parsed.instructions.some((x) => x.kind === 'line' && x.text.includes('呀吼')));

console.log('\n== extractGalBlocks 两端一致 ==');
const x = extractGalBlocks('<gal_inface>[choice|a|b]</gal_inface>');
check('gal 抽出 + 文本令牌', x.gal.length === 1 && x.text === '\x00JGGAL0\x00');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);