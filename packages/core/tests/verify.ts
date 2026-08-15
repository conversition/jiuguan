/**
 * core 包验证：用真实 chara_card_v3 JSON 解析（3 张卡）
 */
import { readFileSync } from 'node:fs';
import { parseCharaCard } from '../src/chara.ts';
import { parseWorldBook, entryToLorebookRow, cardBookToLorebookRows } from '../src/worldbook.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

const CARDS = [
  'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/魔法少女是不会败北恶堕的吧！1.json',
  'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/《魔法少女侵蚀技术检证实验记录》2.json',
  'E:/claude cade test/project/jiuguanlike/剧本方案/角色卡/ASMR剧本工坊 (2).json',
];

console.log('== chara_card_v3 真实卡解析 ==');
for (const path of CARDS) {
  const name = path.split('/').pop()!;
  console.log(`\n-- ${name} --`);
  try {
    const json = readFileSync(path, 'utf8');
    const result = parseCharaCard(json);
    check(`spec=${result.spec}`, result.spec === 'chara_card_v3');
    check(`卡名: ${result.card.name.slice(0, 24)}`, result.card.name.length > 0);
    check(`first_mes 长度 ${result.card.data.first_mes.length}`, result.card.data.first_mes.length > 0);
    check(`内嵌世界书条目 ${result.worldbookEntries.length}`, result.worldbookEntries.length >= 0);
    check(`regex_scripts ${result.regexScripts.length}`, Array.isArray(result.regexScripts));
    check(`tavern_helper 脚本 ${result.tavernHelperScripts.length}`, Array.isArray(result.tavernHelperScripts));
    check(`system_prompt 长度 ${result.card.data.system_prompt.length}`, typeof result.card.data.system_prompt === 'string');
    check(`alternate_greetings ${result.card.data.alternate_greetings.length}`, Array.isArray(result.card.data.alternate_greetings));
    // 展示关键提取物
    if (result.worldbookEntries.length > 0) {
      const rows = cardBookToLorebookRows(result.worldbookEntries, result.card.name);
      const useRegex = rows.filter((r) => r.use_regex === 1).length;
      const constant = rows.filter((r) => r.constant === 1).length;
      console.log(`   → lorebook 行 ${rows.length} (use_regex=${useRegex}, constant=${constant})`);
      check('条目→lorebook 行映射', rows.length === result.worldbookEntries.length);
    }
    if (result.tavernHelperScripts.length > 0) {
      const mvu = result.tavernHelperScripts.find((s) => s.name.includes('MVU'));
      console.log(`   → MVU 脚本: ${mvu ? `${mvu.name} (${mvu.content.length} 字符)` : '无'}`);
    }
    result.warnings.forEach((w) => console.log(`   ⚠ ${w}`));
  } catch (e) {
    failed++;
    console.log(`  ❌ 解析失败: ${(e as Error).message}`);
  }
}

console.log('\n== 世界书双层格式解析（XP大全绿灯版）==');
try {
  const wbPath = 'E:/claude cade test/project/jiuguanlike/剧本方案/世界书/XP大全绿灯世界书-v1.4.json';
  const wb = parseWorldBook(readFileSync(wbPath, 'utf8'));
  console.log(`  entries=${wb.stats.total} duplicates=${wb.stats.duplicates} warnings=${wb.warnings.length}`);
  check('XP大全条目 ≥400', wb.stats.total >= 400, `total=${wb.stats.total}`);
  const sample = wb.entries[0];
  if (sample) {
    const row = entryToLorebookRow(sample);
    check(`样例条目 content 长度 ${sample.content.length}`, sample.content.length > 50);
    check(`样例行映射 use_regex=${row.use_regex}`, typeof row.use_regex === 'number');
  }
  wb.warnings.slice(0, 3).forEach((w) => console.log(`   ⚠ ${w}`));
} catch (e) {
  failed++;
  console.log(`  ❌ 世界书解析失败: ${(e as Error).message}`);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
