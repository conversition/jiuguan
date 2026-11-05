#!/usr/bin/env node
/** @author Codex @date 2026-10-26 @version 1.0
 * Print reproducible body-free RP fixture governance evidence; no live Provider or promotion path.
 */
import { runRpTemplateGovernance } from '../../apps/server/agent-loop-rp-template-governance.ts';
import { createRpTemplateGovernanceFixture } from '../../apps/server/agent-loop-rp-template-governance-fixture.ts';

if (process.argv.length !== 2) throw new Error('rp-template-governance-cli-arguments-invalid');
const report = await runRpTemplateGovernance(createRpTemplateGovernanceFixture());
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
