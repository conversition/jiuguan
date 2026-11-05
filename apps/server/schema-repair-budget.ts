import { createHash } from 'node:crypto';
import type { ModelRuntimeProfile } from '../../packages/prompt/public/model-runtime-profile.ts';
import { agentTaskRequestCeilings, pricedTaskCostCeiling } from './agent-task-budget-profiles.ts';
import type { StandaloneSchemaRepairBudget } from './schema-repair-host.ts';

export interface SchemaRepairModelSnapshot {
  readonly providerId: string;
  readonly modelId: string;
  readonly profile: ModelRuntimeProfile;
  readonly generation: number;
}

/** A normal turn's one admitted correction. This is not a v3 whole-turn operation. */
export function createStandaloneSchemaRepairBudget(input: {
  readonly read: () => SchemaRepairModelSnapshot;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
}): StandaloneSchemaRepairBudget {
  const nowMs = input.nowMs ?? Date.now;
  const capture = () => {
    const current = input.read();
    const inputRate = current.profile.inputMicrousdPerMillionTokens ?? Number(input.env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK);
    const outputRate = current.profile.outputMicrousdPerMillionTokens ?? Number(input.env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK);
    if (!Number.isSafeInteger(inputRate) || inputRate < 1 || !Number.isSafeInteger(outputRate) || outputRate < 1)
      throw new Error('schema-repair-rates-required');
    return structuredClone({ ...current, inputRate, outputRate });
  };
  const captured = capture(), fingerprint = JSON.stringify(captured);
  const outputTokens = Math.min(2048, captured.profile.maxOutputTokens);
  const task = agentTaskRequestCeilings('critic_revision');
  const rates = {
    ...input.env, JG_HARNESS_INPUT_MICROUSD_PER_MTOK: String(captured.inputRate),
    JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK: String(captured.outputRate),
  };
  const margin = Math.ceil((captured.profile.contextWindowTokens - outputTokens)
    * (captured.profile.tokenizer === 'conservative-estimate' ? 0.05 : 0.02));
  const inputTokens = Math.min(task.inputTokens, captured.profile.contextWindowTokens - outputTokens - margin);
  if (inputTokens < 1) throw new Error('schema-repair-window-invalid');
  const deadlineMs = nowMs() + task.maxWallMs;
  return {
    budget: { deadlineMs, hold: { calls: 1, inputTokens, outputTokens,
      costMicrousd: pricedTaskCostCeiling(inputTokens, outputTokens, task.floorCostMicrousd, rates) },
      binding: { providerId: captured.providerId, modelId: captured.modelId,
        contextWindowTokens: captured.profile.contextWindowTokens, maxRequestInputTokens: inputTokens,
        maxRequestOutputTokens: outputTokens, requestSafetyMarginTokens: margin,
        inputMicrousdPerMillionTokens: captured.inputRate, outputMicrousdPerMillionTokens: captured.outputRate,
        configurationDigest: `sha256:${createHash('sha256').update(fingerprint).digest('hex')}` } },
    assertCurrent() {
      if (nowMs() >= deadlineMs || JSON.stringify(capture()) !== fingerprint)
        throw new Error('schema-repair-binding-stale');
    },
  };
}
