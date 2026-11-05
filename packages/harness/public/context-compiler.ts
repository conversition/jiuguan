/** Pure Context Compiler request/capsule contracts; no Provider dispatch or runtime authority. */
export {
  CONTEXT_CAPSULE_VERSION,
  CONTEXT_COMPILER_POLICY_VERSION,
  buildContextCompilerModelRequest,
  contextCompilerSourceDigest,
  parseContextCapsule,
  partitionContextCompilerSources,
} from '../src/context-compiler.ts';
