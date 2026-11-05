/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 兼容矩阵 / 漂移门禁 CLI：判定逻辑在 `skill-package-gate.ts`，这里只做参数与输出。
 */
import { evaluateSkillPackageMatrix } from '../../apps/server/skill-hub/skill-package-gate.ts';

function main(argv: readonly string[]): number {
  const update = argv.includes('--update');
  const dirIndex = argv.indexOf('--dir');
  const skillsDir = dirIndex >= 0 ? String(argv[dirIndex + 1]) : undefined;
  const result = evaluateSkillPackageMatrix({
    ...(skillsDir === undefined ? {} : { skillsDir }),
    update,
  });
  if (!result.ok) {
    for (const message of result.messages) console.error(message.startsWith('  ') ? message : `\u2717 ${message}`);
    return 1;
  }
  if (update) {
    console.log(result.messages.join('\n'));
    return 0;
  }
  const totals = result.totals;
  console.log(`SKP-1 matrix: ${totals.documents} packages, compiled ${totals.compiled}, `
    + `legacy-uncompiled ${totals.legacyUncompiled}, skipped ${totals.skipped}, `
    + `missing documents ${result.missingDocuments} \u2014 matches baseline`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
