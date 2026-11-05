/** @author Codex @date 2026-10-15 @version 1.0 Closed Engine terminal failure diagnostics. */
export {
    HARNESS_FAILURE_CONTRACT_VERSION,
    classifyHarnessFailure,
    rememberHarnessFailureCode,
    readHarnessFailureCode,
    type HarnessHostFailureCode,
    type HarnessFailureCategory,
    type HarnessFailureStage,
    type HarnessFailureEffect,
    type HarnessFailureOwner,
    type HarnessFailureRetryability,
    type HarnessFailureCode,
    type HarnessFailureCauseCode,
    type HarnessFailureInput,
    type HarnessFailureMetadata,
} from '../src/engine-failure-contract.ts';
