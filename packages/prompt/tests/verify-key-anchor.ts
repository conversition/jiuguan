/**
 * prompt 包验证：关键锚点检测器（KeyAnchorDetector）
 * 覆盖：实体首次出现 / 情感突变 / 目标声明 / 世界书触发点 四类锚点 + 已知实体去重 + 数量上限。
 * 运行：node --experimental-strip-types --experimental-transform-types packages/prompt/tests/verify-key-anchor.ts
 */
import { KeyAnchorDetector } from '../src/key-anchor-detector.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

function main(): void {
  console.log('== 关键锚点检测器 ==\n');

  // ---- 实体首次出现 + 已知去重 ----
  const d1 = new KeyAnchorDetector();
  const r1 = d1.detect([
    { role: 'user', content: '夜璃，白川真昼，藤原主任，三人来到学院。', round: 1 },
    { role: 'user', content: '夜璃又见到白川真昼。', round: 2 },
  ]);
  check('首轮实体「夜璃」记录为锚点', d1.hasType(r1, 'entity', '夜璃'), JSON.stringify(r1.map((a) => a.text)));
  check('独立名「藤原主任」整段作为新锚点', d1.hasType(r1, 'entity', '藤原主任'), '');
  // 注意：detect() 每次是全新调用，knownEntities 延续（同一实例）；这里 r1 是 detect 的返回
  const entityAnchors = r1.filter((a) => a.type === 'entity');
  check('实体「夜璃」跨轮去重（不重复标两次）', entityAnchors.filter((a) => a.text.includes('夜璃')).length === 1, String(entityAnchors.length));

  // ---- 情感突变 ----
  const d2 = new KeyAnchorDetector();
  const r2 = d2.detect([
    { role: 'user', content: '夜璃平静地点头', round: 1 },
    { role: 'user', content: '夜璃愤怒地砸向墙壁，泪水夺眶而出', round: 2 },
  ]);
  check('平静→愤怒 检测为情感突变锚点', d2.hasType(r2, 'emotion'), '');

  // ---- 目标声明 ----
  const d3 = new KeyAnchorDetector();
  const r3 = d3.detect([{ role: 'user', content: '我决定要去旧校舍调查封印', round: 3 }]);
  check('目标声明「我要去…」检测为 goal 锚点', d3.hasType(r3, 'goal'), JSON.stringify(r3));

  // ---- 世界书触发点 ----
  const d4 = new KeyAnchorDetector();
  const r4 = d4.detect([{ role: 'user', content: '她走向旧楼', round: 4 }], [{ entryId: 42, snippet: '旧楼缎带' }]);
  check('世界书触发点标记为锚点（含 entryId）', d4.hasType(r4, 'worldbook', '旧楼'),
    JSON.stringify(r4.filter((a) => a.type === 'worldbook')));

  // ---- 上限 + 去重 ----
  const d5 = new KeyAnchorDetector({ maxAnchorsPerRound: 2 });
  const r5 = d5.detect([
    { role: 'user', content: '夜璃、白川真昼、藤原主任三人同行', round: 1 },
    { role: 'user', content: '夜璃再次遇到白川真昼', round: 2 },
  ]);
  const r5Entities = r5.filter((a) => a.type === 'entity');
  check('实体匿名上限生效（≤ 消息数×maxPerRound）', r5Entities.length <= 2 * 2, String(r5Entities.length));
  const yeliCount = r5Entities.filter((a) => a.text.includes('夜璃')).length;
  check('实体去重：同名实体只留一次', yeliCount <= 1, String(yeliCount));

  // ---- 负例：普通描写不误标强信号锚点（B1 验收）----
  // 实体提取为启发式（≤4 字分句会被当实体候选），但情感/目标/世界书三类有真信号，普通描写不应触发。
  const d6 = new KeyAnchorDetector();
  const r6 = d6.detect([
    { role: 'user', content: '暮色渐沉，晚风穿过长廊。', round: 5 },
    { role: 'user', content: '她默默收拾好桌上的信。', round: 6 },
  ]);
  check('普通描写不误标情感/目标类锚点',
    !d6.hasType(r6, 'emotion') && !d6.hasType(r6, 'goal') && !d6.hasType(r6, 'worldbook'),
    JSON.stringify(r6));

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
void main();
