/** @author Codex @date 2026-10-15 @version 1.0 Bounded result contract public facade. */
export {
    TOOL_RESULT_CONTRACT_VERSION,
    TOOL_RESULT_SIZE_UNIT,
    TOOL_RESULT_BOUND_RULE,
    boundToolResult,
    boundExternalToolResult,
    parseExternalToolResultReference,
    InteractiveToolResultExternalizationError,
    isInteractiveToolResultExternalizationError,
    type ExternalToolResultReference,
    type ExternalToolResultRequest,
    type ToolResultScope,
    type ToolResultContractMetadata,
    type BoundedToolResult,
} from '../src/tool-result-contract.ts';
