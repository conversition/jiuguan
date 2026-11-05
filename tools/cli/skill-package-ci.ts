/** Offline package CI. Optional JSON is a read model, never a deployment or publication artifact. */
import { realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { evaluateMigratedSkillPackageCi } from '../../apps/server/skill-hub/skill-package-inventory-ci.ts';

function main(argv: readonly string[]): number {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1];
    if (!['--dir', '--json'].includes(key) || options.has(key) || !value || value.startsWith('--')) {
      throw new TypeError('usage: skill-package-ci [--dir skills-directory] [--json new-output-file]');
    }
    options.set(key, value);
  }
  const skillsDir = resolve(options.get('--dir') ?? 'data/skills');
  const realSkillsDir = realpathSync(skillsDir);
  let output: string | undefined;
  if (options.has('--json')) {
    const requested = resolve(options.get('--json')!);
    output = join(realpathSync(dirname(requested)), basename(requested));
    const rel = relative(realSkillsDir, output);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../')) {
      throw new TypeError('skill-package-ci:output-inside-source');
    }
  }
  const result = evaluateMigratedSkillPackageCi(skillsDir);
  // Never overwrite an existing file (in particular an original source or program.json).
  if (output !== undefined) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Skill package CI: ${result.registry.entries.length} passed; `
    + `${result.registry.entries.reduce((count, entry) => count + entry.tests.examples.length, 0)} offline examples; `
    + `${result.missingDocuments.length} missing documents; no publication or Provider evidence.`);
  console.log(`Registry: ${result.registry.registryDigest}`);
  for (const directory of result.missingDocuments) console.log(`missing-document: ${directory}`);
  return 0;
}
try { process.exitCode = main(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : 'skill-package-ci failed'); process.exitCode = 1; }
