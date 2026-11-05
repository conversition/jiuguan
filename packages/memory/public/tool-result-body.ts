/** Session-owned body storage; opaque references never authorize reading or execution. */
export { TOOL_RESULT_BODY_REFERENCE_VERSION, ToolResultBodyStore, inspectToolResultBodyStorage,
    type ToolResultBodyAccess, type ToolResultBodyLimits, type ToolResultBodyReference,
    type ToolResultBodyStoreOptions } from '../src/tool-result-body.ts';
