/**
 * Source-level, authority-free identities for Agent model contracts.
 *
 * This facade intentionally exports versions only. It does not expose a Provider,
 * a dispatch entry point or any runtime permission.
 */
export {
  CONTEXT_CAPSULE_VERSION,
  CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
} from '../src/context-compiler.ts';
export { CONTEXT_COMPILER_INPUT_VERSION } from '../../agent-policy/public/context-compiler-input.ts';
export {
  INTERACTIVE_PRELUDE_MODEL_CONTRACT_VERSION,
} from '../src/interactive-turn-runner.ts';
export {
  INTERACTIVE_PRELUDE_OUTPUT_VALIDATOR_VERSION,
  INTERACTIVE_DIRECTOR_OUTPUT_VALIDATOR_VERSION,
  INTERACTIVE_VARIABLE_OUTPUT_VALIDATOR_VERSION,
} from '../src/interactive-output-contract.ts';
export {
  LEARNING_MODEL_CONTRACT_VERSION,
} from '../src/learning-model-contract.ts';
export {
  PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
} from '../src/precommit-critic-model.ts';
