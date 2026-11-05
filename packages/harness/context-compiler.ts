/** @author Codex @date 2026-10-13 @version 1.0
 * Public bounded protocol without exposing session internals.
 */
export {
    CONTEXT_CAPSULE_VERSION,
    CONTEXT_COMPILER_POLICY_VERSION,
    ContextCapsuleCache,
    partitionContextCompilerSources,
    buildContextCompilerModelRequest,
    buildContextCompilerRepairRequest,
    classifyContextCompilerRepair,
    type ContextCompilerRepairIssue,
    contextCompilerSourceDigest,
    parseContextCapsule,
    COMPACT_CONTEXT_CAPSULE_VERSION,
    parseAndRenderCompactContextCapsule,
} from './src/context-compiler.ts';
export {
    CONTEXT_COMPILER_INPUT_VERSION,
    parseContextCompilerInput,
    contextCompilerInputManifest,
    parseContextCompilerInputManifest,
    type ContextCompilerInputV1,
    type ContextCompilerInputManifestV1,
} from '../agent-policy/public/context-compiler-input.ts';
