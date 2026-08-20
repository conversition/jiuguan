/**
 * tools/cli - PG 别名/职位简写检索验证
 * 验证 lore_alias 表写入 + queryByAlias 精确/退化命中（"会长"→桐月樱佳）。
 */
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

async function main(): Promise<void> {
  const pg = await getPgVectorStore();
  if (!pg.isReady) {
    console.error('PG 不可用。检查 JG_PG_DSN / pgvector 扩展。');
    process.exit(1);
  }
  console.log(`PG 就绪：chunks=${await pg.chunkCount()} aliases=${await pg.aliasCount()}`);

  // 1) 确定性别名命中："会长" 应找到桐月樱佳
  const hus = await pg.queryByAlias('会长');
  console.log('\n== queryByAlias("会长") ==');
  for (const h of hus) console.log(`  ${h.alias} → ${h.entityName} (${h.explicit ? '显式' : '推导'})`);
  check('命中至少 1 条', hus.length > 0, JSON.stringify(hus));
  check('映射到含"樱佳"的实体', hus.some((h) => h.entityName.includes('樱佳')), JSON.stringify(hus.map((h) => h.entityName)));

  // 2) 精确别名："樱佳" 直中
  const ying = await pg.queryByAlias('樱佳');
  console.log('\n== queryByAlias("樱佳") ==');
  for (const h of ying) console.log(`  ${h.alias} → ${h.entityName}`);
  check('樱佳 命中', ying.length > 0);

  // 3) 精确原词优先于包含退化
  const exact = await pg.queryByAlias('塞蕾丝');
  console.log('\n== queryByAlias("塞蕾丝") ==');
  for (const h of exact) console.log(`  ${h.alias} → ${h.entityName}`);
  check('塞蕾丝 命中', exact.length > 0);

  console.log(failed === 0 ? `\npg-alias 验证全部通过（${passed} 项）✅` : `\n${failed} 项失败 ❌`);
  await pg.close();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
