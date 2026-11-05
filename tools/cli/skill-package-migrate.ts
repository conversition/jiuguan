/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 迁移 CLI：扫描 `data/skills`，逐包算资源摘要，输出可对账的迁移报告。
 *
 * 只读源目录：不写 data/skills、不改正文、不发布。报告落盘由 `--json` / `--md` 指定。
 * 排序一律按 UTF-16 码元（`<` 比较），不用 localeCompare —— 报告必须在任意机器上逐字节相同。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  migrateLegacySkillPackages,
  readLegacySkillPackages,
} from '../../apps/server/skill-hub/legacy-package-migrator.ts';
import { renderSkillPackageMarkdown } from '../../apps/server/skill-hub/skill-package-report.ts';

function main(argv: readonly string[]): number {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`missing value for ${token}`);
      return 2;
    }
    options.set(token.slice(2), value);
    index += 1;
  }
  const skillsDir = resolve(options.get('dir') ?? 'data/skills');
  if (!existsSync(skillsDir)) {
    console.error(`skills directory not found: ${skillsDir}`);
    return 2;
  }

  const scanned = readLegacySkillPackages(skillsDir);
  const result = migrateLegacySkillPackages(scanned.documents, {
    missingDirectories: scanned.missingDirectories,
  });

  const jsonPath = options.get('json');
  if (jsonPath) {
    mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
    writeFileSync(resolve(jsonPath), `${JSON.stringify(result.report, null, 2)}\n`, 'utf8');
  }
  const mdPath = options.get('md');
  if (mdPath) {
    mkdirSync(dirname(resolve(mdPath)), { recursive: true });
    writeFileSync(resolve(mdPath), renderSkillPackageMarkdown(result.report), 'utf8');
  }

  const { totals } = result.report;
  console.log(`SKP-1 migration: ${totals.documents} packages `
    + `(compiled ${totals.compiled}, legacy-uncompiled ${totals.legacyUncompiled}, `
    + `skipped ${totals.skipped}, build-failed ${totals.packageBuildFailed})`);
  if (result.report.missingDocuments.length > 0) {
    console.log(`directories without SKILL.md: ${result.report.missingDocuments.join(', ')}`);
  }
  for (const item of result.report.entries) {
    if (item.status === 'invalid' && item.reasonCode !== 'inactive-lifecycle') {
      console.log(`  - ${item.directory}: ${item.reasonCode}`
        + `${item.detail ? ` (${item.detail})` : ''}`);
    }
  }
  console.log(`relative source: ${relative(process.cwd(), skillsDir) || '.'}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
