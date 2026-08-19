/**
 * core 包验证：世界书条目标题解析 + 全局别名索引（RAG 语义通道前置）
 * 覆盖：EJS/MVU 段切分、别名/名册抽取、职位简写推导（会长→桐月樱佳）、变量规则保留。
 * 数据：内联 fixture（模拟《魔法少女侵蚀技术检证实验记录》条目形态），不依赖具体 db。
 */
import { parseLoreEntry, buildAliasIndex, extractYamlEntities } from '../src/lore-parse.ts';
import type { LoreRow } from '../src/scanner.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

// ---- fixture：EJS 型单实体条目（桐月樱佳） ----
const yokaRow: Pick<LoreRow, 'id' | 'comment' | 'content' | 'key' | 'constant' | 'active' | 'book'> = {
  id: 15,
  book: '魔法少女侵蚀录',
  comment: '桐月 樱佳（蓝灯/绿灯自选）',
  key: '',
  constant: 1,
  active: 1,
  content: `{{// 桐月樱佳 (Kiritsuki Yoka) - 精炼与恶堕扩展版}}
<%_
var 角色状态 = getvar('stat_data.角色状态');
var yokaStatus;
_%>
  桐月樱佳:
    name: 桐月樱佳
    gender: Female
    identity: [桐月学园学生会长, 桐月财阀唯一继承人, 魔法少女·塞蕾丝]
    school_class: 桐月学园高中二年级A班
    appearance: 耀眼樱红色长发，雪肌鹅蛋脸，紫罗兰色杏眼`,
};

// ---- fixture：YAML 名册（多实体） ----
const rosterContent = `---\n<mahoshojos_characters_list>\nmahoshojos:\n  - 桐月樱佳:\n      alias:\n        - 桐月学园学生会长\n        - 魔法少女·塞蕾丝\n        - 樱佳\n      初始信念: 6\n  - 神乐坂琴音:\n      alias:\n        - 桐月学园风纪委员长\n        - 魔法少女·天礼纱\n        - 琴音\n      初始信念: 9\n  - 物部千代凛:\n      alias:\n        - 大小姐\n        - 魔法少女·百鬼目\n        - 千代凛\n</mahoshojos_characters_list>`;

console.log('\n== parseLoreEntry（EJS 段切分 + 变量规则保留）==');
const yoka = parseLoreEntry(yokaRow);
check('EJS 被剥离出 settingText（不含 <%_）', !yoka.settingText.includes('<%_'), yoka.settingText.slice(0, 60));
check('settingText 保留可读设定（含 学生会长）', yoka.settingText.includes('桐月学园学生会长'), yoka.settingText.slice(0, 60));
check('变量规则被保留（不丢 MVU 逻辑）', yoka.variableRules.length === 1 && yoka.variableRules[0].mvuVars.includes('read:stat_data.角色状态'), JSON.stringify(yoka.variableRules));
check('identity 数组抽成别名（塞蕾丝）', yoka.aliases.includes('魔法少女·塞蕾丝'), JSON.stringify(yoka.aliases));
check('alwaysOn=true（constant）', yoka.meta.alwaysOn === true);

console.log('\n== extractYamlEntities（名册实体-别名绑定）==');
const ents = extractYamlEntities(rosterContent);
check('名册解析出 3 实体', ents.length === 3, `got ${ents.length}`);
const yokaE = ents.find((e) => e.entityName === '桐月樱佳');
check('桐月樱佳别名含 学生会长/樱佳', !!yokaE && yokaE.aliases.includes('桐月学园学生会长') && yokaE.aliases.includes('樱佳'), JSON.stringify(yokaE?.aliases));
check('神乐坂琴音别名含 琴音', ents.some((e) => e.entityName === '神乐坂琴音' && e.aliases.includes('琴音')));
check('物部千代凛别名含 大小姐', ents.some((e) => e.entityName === '物部千代凛' && e.aliases.includes('大小姐')));

console.log('\n== buildAliasIndex（跨条目 + 职位简写）==');
const roster = parseLoreEntry({ ...yokaRow, id: 20, comment: '魔法少女列表', constant: 0, content: rosterContent });
const index = buildAliasIndex([yoka, roster]);
const huiZhang = index.get('会长');
check('职位简写「会长」→ 桐月樱佳', huiZhang?.entityName === '桐月樱佳', JSON.stringify(huiZhang));
check('「学生会长」→ 桐月樱佳', index.get('学生会长')?.entityName === '桐月樱佳');
check('「桐月学园学生会长」→ 桐月樱佳(explicit)', index.get('桐月学园学生会长')?.entityName === '桐月樱佳' && index.get('桐月学园学生会长')?.explicit === true);
check('「樱佳」→ 桐月樱佳', index.get('樱佳')?.entityName === '桐月樱佳', JSON.stringify(index.get('樱佳')));
check('「塞蕾丝」→ 桐月樱佳（·后缀简写）', index.get('塞蕾丝')?.entityName === '桐月樱佳');
check('「琴音」→ 神乐坂琴音', index.get('琴音')?.entityName === '神乐坂琴音', JSON.stringify(index.get('琴音')));
check('「大小姐」→ 物部千代凛', index.get('大小姐')?.entityName === '物部千代凛', JSON.stringify(index.get('大小姐')));

console.log(failed === 0 ? `\nlore-parse 验证全部通过（${passed} 项）✅` : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
