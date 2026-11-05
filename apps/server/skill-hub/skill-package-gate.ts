/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 矩阵门禁的**纯实现**：给一组路径，返回 ok/messages，不打印、不退出。
 *
 * 单独拆出来是因为「门禁必须真的会红」这条只能靠测试证明，而测试里再起 node 子进程
 * 既慢又依赖宿主策略；把判定做成纯函数，测试可以直接跑十几次。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  migrateLegacySkillPackages,
  readLegacySkillPackages,
  type SkillPackageMigrationReportV1,
  type SkillPackageMigrationResultV1,
} from './legacy-package-migrator.ts';
import { renderSkillPackageMarkdown } from './skill-package-report.ts';

export const SKP1_BASELINE_PATH = 'tools/architecture/skill-package-migration-baseline.json';
export const SKP1_REPORT_PATH = 'docs/P17-SKP1-SkillPackage-v2迁移报告-20261019.md';

export interface SkillPackageGateResult {
  readonly ok: boolean;
  readonly messages: readonly string[];
  readonly baseline: unknown;
  readonly markdown: string;
  readonly totals: SkillPackageMigrationReportV1['totals'];
  readonly missingDocuments: number;
}

function stableEntry(entry: SkillPackageMigrationReportV1['entries'][number]) {
  return {
    directory: entry.directory,
    name: entry.name,
    skillId: entry.skillId,
    version: entry.version,
    documentIdentityDigest: entry.documentIdentityDigest,
    status: entry.status,
    reasonCode: entry.reasonCode,
    program: entry.program,
    resourceCount: entry.resourceCount,
    attachmentBytes: entry.attachmentBytes,
    detail: entry.detail,
  };
}

function baselineOf(report: SkillPackageMigrationReportV1) {
  return {
    baselineVersion: 'skill-package-migration-baseline-v1',
    reportVersion: report.reportVersion,
    totals: report.totals,
    missingDocuments: report.missingDocuments,
    duplicateSkillIds: report.duplicateSkillIds,
    entries: report.entries.map(stableEntry),
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function diff(before: unknown, after: unknown, path = ''): string[] {
  if (typeof before !== typeof after || before === null || after === null
    || typeof before !== 'object') {
    return before === after ? [] : [`${path || '<root>'}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = before as unknown[];
    const right = after as unknown[];
    const out: string[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      out.push(...diff(left[index], right[index], `${path}[${index}]`));
    }
    return out;
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const key of keys) {
    out.push(...diff(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return out;
}

export function evaluateSkillPackageMatrix(input: Readonly<{
  skillsDir?: string;
  baselinePath?: string;
  reportPath?: string;
  update?: boolean;
  /** CI may supply the already-read immutable inventory, avoiding a second filesystem snapshot. */
  migrationResult?: SkillPackageMigrationResultV1;
}> = {}): SkillPackageGateResult {
  const skillsDir = resolve(input.skillsDir ?? 'data/skills');
  const baselinePath = resolve(input.baselinePath ?? SKP1_BASELINE_PATH);
  const reportPath = resolve(input.reportPath ?? SKP1_REPORT_PATH);
  const messages: string[] = [];

  const result = input.migrationResult ?? (() => {
    const scanned = readLegacySkillPackages(skillsDir);
    return migrateLegacySkillPackages(scanned.documents, { missingDirectories: scanned.missingDirectories });
  })();
  const totals = result.report.totals;
  const missingDocuments = result.report.missingDocuments.length;
  const baseline = baselineOf(result.report);
  const markdown = renderSkillPackageMarkdown(result.report);

  for (const item of result.packages) {
    if (item.package.release.state !== 'draft') {
      messages.push(`${item.directory}: migrated package must be draft`);
    }
    if (item.package.effect.sampleCount !== 0 || item.package.effect.passCount !== 0) {
      messages.push(`${item.directory}: migrated package must not claim effect samples`);
    }
  }
  if (totals.documents
    !== totals.compiled + totals.legacyUncompiled + totals.skipped
    + totals.packageBuildFailed + result.report.missingDocuments.length) {
    messages.push('totals do not reconcile');
  }
  if (messages.length > 0) {
    return { ok: false, messages, baseline, markdown, totals, missingDocuments };
  }

  if (input.update === true) {
    writeFileSync(baselinePath, serialize(baseline), 'utf8');
    writeFileSync(reportPath, markdown, 'utf8');
    return { ok: true, messages: ['baseline and report updated'], baseline, markdown, totals, missingDocuments };
  }

  if (!existsSync(baselinePath)) {
    return {
      ok: false,
      messages: [`baseline missing: ${baselinePath}`],
      baseline, markdown, totals, missingDocuments,
    };
  }
  const committedBaseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown;
  const drift = diff(committedBaseline, baseline);
  if (drift.length > 0) {
    return {
      ok: false,
      messages: [
        `migration drift: ${drift.length} difference(s) vs baseline`,
        ...drift.slice(0, 40).map((line) => `  - ${line}`),
        ...(drift.length > 40 ? [`  ... ${drift.length - 40} more`] : []),
        'If the change is intended, rerun with --update and commit the new baseline + report.',
      ],
      baseline, markdown, totals, missingDocuments,
    };
  }
  if (!existsSync(reportPath)) {
    return { ok: false, messages: [`report missing: ${reportPath}`], baseline, markdown, totals, missingDocuments };
  }
  // 换行符归一化后再比对：autocrlf 检出会把仓库里的 LF 报告写成 CRLF，
  // 逐字节比较会把它误判成「被手改」。git 对象库里存的是 LF，归一化后比较
  // 既容忍检出转换，又仍能抓住真正的手改（内容差异在归一化后依然可见）。
  const committed = readFileSync(reportPath, 'utf8').replace(/\r\n/gu, '\n');
  if (committed !== markdown) {
    return {
      ok: false,
      messages: ['committed markdown report is stale (regenerate with --update)'],
      baseline, markdown, totals, missingDocuments,
    };
  }
  return { ok: true, messages: [], baseline, markdown, totals, missingDocuments };
}

