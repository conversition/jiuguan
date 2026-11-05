/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 报告的**唯一**渲染实现。迁移 CLI 与矩阵门禁共用它，
 * 否则「生成的报告」和「校验的报告」会各写一份格式，漂移就检验不出来。
 */
import type { SkillPackageMigrationReportV1 } from './legacy-package-migrator.ts';

export function renderSkillPackageMarkdown(report: SkillPackageMigrationReportV1): string {
  const lines: string[] = [];
  lines.push('# SKP-1 · SkillPackage v2 迁移报告', '');
  lines.push('- 生成方式：`pnpm skill:package-migrate`（只读 `data/skills`，不改正文、不发布）');
  lines.push(`- 报告版本：\`${report.reportVersion}\``);
  lines.push(`- 包数：**${report.totals.documents}**；compiled **${report.totals.compiled}**；`
    + `legacy-uncompiled **${report.totals.legacyUncompiled}**；`
    + `skipped **${report.totals.skipped}**；build-failed **${report.totals.packageBuildFailed}**`);
  lines.push('');
  lines.push('> 迁移只产出 `release.state=\'draft\'` 的包。发布必须另走 Shadow → Canary → 显式 Active，');
  lines.push('> 本报告不构成任何发布授权。');
  lines.push('');
  lines.push('| # | 目录 | 包名 | 状态 | 稳定原因码 | 正文形态 | 资源数 | 附件字节 | 备注 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  report.entries.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.directory} | ${item.name} | ${item.status} | `
      + `${item.reasonCode ?? '—'} | ${item.program} | ${item.resourceCount} | ${item.attachmentBytes} | `
      + `${item.detail ?? '—'} |`);
  });
  lines.push('');
  const byReason = new Map<string, number>();
  for (const item of report.entries) {
    const key = item.reasonCode ?? 'compiled';
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  lines.push('## 原因码分布', '');
  lines.push('| 原因码 | 数量 |');
  lines.push('|---|---|');
  for (const key of [...byReason.keys()].sort((left, right) => (left < right ? -1 : 1))) {
    lines.push(`| \`${key}\` | ${byReason.get(key)} |`);
  }
  if (report.missingDocuments.length > 0) {
    lines.push('', '## 目录存在但没有 SKILL.md', '');
    for (const name of report.missingDocuments) lines.push(`- ${name}`);
  }
  if (report.duplicateSkillIds.length > 0) {
    lines.push('', '## 重名包（必须人工改名）', '');
    for (const name of report.duplicateSkillIds) lines.push(`- ${name}`);
  }
  lines.push('');
  return lines.join('\n');
}

