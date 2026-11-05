/** P17-04.1 metadata apply CLI; default dry-run, explicit --apply writes. */
import { applySkillPackageMetadata, parseSkillPackageApplyArgs } from '../../apps/server/skill-hub/legacy-package-metadata-apply.ts';

try {
  const result = applySkillPackageMetadata(parseSkillPackageApplyArgs(process.argv.slice(2)));
  console.log(`${result.mode}: directories=${result.directories}, documents=${result.documents}, `
    + `changed=${result.changed}, unchanged=${result.unchanged}, missing-document=${result.missingDocuments.length}`);
  for (const item of result.entries) {
    if (item.status === 'changed') console.log(`  ${item.directory}: +${item.added.join(',')}`);
    if (item.status === 'missing-document') console.log(`  ${item.directory}: missing-document (no SKILL.md; retained in total)`);
  }
  if (result.backupDir) console.log(`backup: ${result.backupDir}`);
  if (result.mode === 'dry-run') console.log('dry-run: zero writes; --apply writes missing metadata only');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
