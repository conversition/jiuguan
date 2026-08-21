/**
 * core 包 - 世界书语义激活模块出口
 */
export { SemanticWorldbookActivator, defaultActivatorOptions } from './semantic-activator.ts';
export { scoreKeyword, hasDeterministicHit } from './keyword-scorer.ts';
export type {
  ActivationContext,
  SemanticEntry,
  SemanticActivation,
  SemanticActivatorOptions,
  SemanticIndexStatus,
} from './types.ts';
