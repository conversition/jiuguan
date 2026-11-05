/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 元数据提案 CLI：生成**供人审的提案单**，不写 `data/skills`、不改任何包。
 *
 * 只处理「连 capabilityIds 都没声明」的包——已经有声明的包不能被提案覆盖，
 * 否则就是拿启发式去改别人已经写下的决定。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readLegacySkillPackages } from '../../apps/server/skill-hub/legacy-package-migrator.ts';
import {
  proposeSkillMetadata,
  type SkillMetadataProposalReportV1,
} from '../../apps/server/skill-hub/legacy-package-metadata-proposal.ts';

function render(report: SkillMetadataProposalReportV1): string {
  const lines: string[] = [];
  lines.push('# SKP-1 · 元数据提案（待人工确认）', '');
  lines.push(`- 生成方式：\`pnpm skill:package-propose\`（**只读** \`data/skills\`，不落盘、不发布）`);
  lines.push(`- 提案版本：\`${report.proposalVersion}\``);
  lines.push(`- 提案数：**${report.proposals.length}**；`
    + `模拟元数据充分：**${report.simulation.metadataComplete}**；`
    + `仍被 adapter 拒绝：**${report.simulation.stillSkipped.length}**`);
  lines.push('');
  lines.push('> 这份表是**提案**，不是迁移结果。`lifecycle` 一列故意留空：它决定包能否进入 Catalog');
  lines.push('> （等于上线），必须由人显式决定。确认后由人写回 `SKILL.md` 的 frontmatter，再跑');
  lines.push('> `pnpm skill:package-migrate` + `pnpm skill:package-verify` 更新基线。');
  lines.push('');
  lines.push('## 推导规则', '');
  lines.push('| 信号 | 结果 |');
  lines.push('|---|---|');
  lines.push('| `frontmatter.role=style` | style；`style.compose`/`style.revise`；`conversation-turn`；`execute` |');
  lines.push('| 名字以「文风」开头 | 同上（置信度 name-prefix） |');
  lines.push('| 名字含「分镜」 | procedure；`story.plan`/`prompt.compose`；`conversation-turn`/`story-continuation`；`plan`/`execute` |');
  lines.push('| 名字含「催眠」 | procedure；`story.plan`/`npc.dialogue`；`conversation-turn`；`plan`/`execute` |');
  lines.push('| 名字/描述含 NSFW | `contentModes = nsf,nsfw`，否则 `nsf` |');
  lines.push('| 其它 | 最小只读风格集合，且 `kind/capabilityIds/taskKinds` 进「需人工确认」 |');
  lines.push('| **`lifecycle`** | **永不推导**，恒为 null |');
  lines.push('');
  lines.push('## 提案清单', '');
  lines.push('| # | 目录 | kind | capabilityIds | taskKinds | phases | contentModes | 置信度 | 需人工确认 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  report.proposals.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.directory} | ${item.kind} | ${item.capabilityIds.join(', ')} | `
      + `${item.taskKinds.join(', ')} | ${item.phases.join(', ')} | ${item.contentModes.join(', ')} | `
      + `${item.confidence} | ${item.reviewRequired.join('；')} |`);
  });
  lines.push('');
  lines.push('## 模拟：提案 + lifecycle=active 时 adapter 的判定', '');
  lines.push(`- 元数据充分：**${report.simulation.metadataComplete}/${report.proposals.length}**`);
  if (report.simulation.stillSkipped.length > 0) {
    lines.push('', '| 目录 | 仍被拒绝的原因码 |', '|---|---|');
    for (const item of report.simulation.stillSkipped) {
      lines.push(`| ${item.directory} | \`${item.code}\` |`);
    }
  }
  lines.push('');
  lines.push(`> ${report.simulation.note}`);
  lines.push('');
  return lines.join('\n');
}

function main(argv: readonly string[]): number {
  const outIndex = argv.indexOf('--out');
  const out = resolve(outIndex >= 0
    ? String(argv[outIndex + 1])
    : 'docs/P17-SKP1-元数据提案-20261019.md');
  const dirIndex = argv.indexOf('--dir');
  const skillsDir = resolve(dirIndex >= 0 ? String(argv[dirIndex + 1]) : 'data/skills');
  if (!existsSync(skillsDir)) {
    console.error(`skills directory not found: ${skillsDir}`);
    return 2;
  }
  const scanned = readLegacySkillPackages(skillsDir);
  // 已经声明过 capabilityIds 的包不参与提案：不能用启发式覆盖人写下的决定。
  const pending = scanned.documents.filter((item) => !(item.record.capabilityIds?.length));
  const report = proposeSkillMetadata(pending);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, render(report), 'utf8');
  console.log(`SKP-1 proposals: ${report.proposals.length} packages, `
    + `metadata complete in simulation ${report.simulation.metadataComplete}, `
    + `still rejected ${report.simulation.stillSkipped.length}`);
  console.log(`written: ${out}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
