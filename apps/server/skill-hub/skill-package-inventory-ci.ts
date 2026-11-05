/** CI adapter for the existing 48-package source-preserving migration. No source writes. */
import { migrateLegacySkillPackages, readLegacySkillPackages } from './legacy-package-migrator.ts';
import { buildSkillPackageRegistry, type SkillPackageCiInput } from './skill-package-ci.ts';
import { fixtureHash } from './offline-package-replay.ts';
import { evaluateSkillPackageMatrix } from './skill-package-gate.ts';

export function readMigratedSkillPackageCiInputs(skillsDir: string) {
  const scanned = readLegacySkillPackages(skillsDir, { includeResourceBytes: true });
  const migrated = migrateLegacySkillPackages(scanned.documents, { missingDirectories: scanned.missingDirectories });
  const failed = migrated.report.entries.find(entry => entry.status !== 'compiled');
  if (failed) throw new TypeError(`skill-package-ci:inventory-invalid:${failed.directory}:${failed.reasonCode}`);
  const inputs: SkillPackageCiInput[] = migrated.packages.map(item => {
    const source = scanned.documents.find(document => document.directory === item.directory)!;
    const program = JSON.parse(item.package.bundle.body);
    const operation = program.operations[0];
    if (!source.resourceBytes || !source.explicitProgram || program.operations.length !== 1
      || (program.kind !== 'style' && program.kind !== 'procedure')
      || operation.primitiveId !== (program.kind === 'style' ? 'style.apply-profile' : 'procedure.apply-step')) {
      throw new TypeError(`skill-package-ci:source-example-unmapped:${item.directory}`);
    }
    // Reviewed migration examples compare the original body to the original compiler, byte for byte.
    // The two explicitly reviewed long procedures have a bounded offline budget, never auto-expansion.
    const longProcedure = program.kind === 'procedure'
      && ['storyboard.anime-director.v1', 'narrative.hypnosis.v1'].includes(operation.args.stepId);
    const instruction = program.kind === 'style' ? source.record.body
      : `${source.record.body} Apply it at deterministic order ${operation.args.order}. This step is ${operation.args.optional ? 'optional' : 'required'}.`;
    const prompt = `<AgentSkillProgramV1>\n<${program.kind}>\n${instruction}\n</${program.kind}>\n</AgentSkillProgramV1>`;
    return { package: item.package, resourceBytes: source.resourceBytes,
      examples: item.package.bundle.header.manifest.contentModes.map(contentMode => ({
        id: `source-replay.${contentMode}`, contentMode, instructionTokenBudget: longProcedure ? 16_000 : 8_000,
        expectedPromptDigest: fixtureHash(prompt),
      })) };
  });
  return { inputs, missingDocuments: scanned.missingDirectories, totals: migrated.report.totals, migrationResult: migrated };
}

export function evaluateMigratedSkillPackageCi(skillsDir: string) {
  const { inputs, missingDocuments, totals, migrationResult } = readMigratedSkillPackageCiInputs(skillsDir);
  const matrix = evaluateSkillPackageMatrix({ skillsDir, migrationResult });
  if (!matrix.ok) throw new TypeError(`skill-package-ci:inventory-drift:${matrix.messages.join('; ')}`);
  return Object.freeze({ totals, missingDocuments, registry: buildSkillPackageRegistry(inputs) });
}
