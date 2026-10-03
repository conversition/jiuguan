/**
 * 正则库迁移：用修复后的卡片正则导入逻辑（前端注入规则启用 + 按 name upsert）对 data/cards/* 重跑导入，
 * 刷新陈旧卡规则（美化类从禁用→启用、补齐缺失的 [开场白]/[状态栏] 前端注入），保留 source='user' 用户编辑。
 *
 * 用法： node --experimental-strip-types --experimental-transform-types tools/cli/migrate-regex-frontend.ts
 */
import { RegexLibrary } from '../../packages/core/src/regex-library.ts';
import { parseCharaCard } from '../../packages/core/src/chara.ts';
import { listCards, readCardText } from '../../packages/core/src/asset-paths.ts';

const lib = new RegexLibrary();

for (const c of listCards()) {
  try {
    const text = readCardText(c.file);
    if (!text) continue;
    const parsed = parseCharaCard(text.raw);
    const r = lib.importFromCard(parsed.regexScripts);
    console.log(`[${c.file}] 导入 ${r.imported} 条（跳过 ${r.skipped}）`);
  } catch (e) {
    console.error(`[${c.file}] 失败: ${(e as Error).message}`);
  }
}

const total = lib.list().length;
console.log(`迁移完成：库共 ${total} 条（含内置 ${lib.list().filter((r) => r.source === 'builtin').length}）`);
console.log(`注入规则 ${lib.list().filter((r) => r.inject).length} 条：`);
for (const r of lib.list().filter((x) => x.inject)) {
  console.log(`  - ${r.name}（${r.replaceString.length} 字符，scope=${r.scope}，enabled=${r.enabled}）`);
}
const galExt = lib.list().filter((r) => r.galExternalUrl);
console.log(`GLA「前端界面」规则 ${galExt.length} 条（原生引擎消费 <gal_inface> 后结构性失效；外链引擎供"外部前端"备选）：`);
for (const r of galExt) {
  console.log(`  - ${r.name} → ${r.galExternalUrl}`);
}
