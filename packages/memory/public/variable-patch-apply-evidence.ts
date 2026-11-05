export {
    MAX_VARIABLE_PATCH_APPLY_INVALIDATION_CHARS, MAX_VARIABLE_PATCH_APPLY_RECORD_CHARS,
    MAX_VARIABLE_PATCH_APPLY_SCAN_LIMIT,
    VARIABLE_PATCH_APPLY_EVIDENCE_PREFIX, VARIABLE_PATCH_APPLY_EVIDENCE_VERSION,
    VARIABLE_PATCH_APPLY_INVALIDATION_PREFIX, VARIABLE_PATCH_APPLY_INVALIDATION_VERSION, VARIABLE_PATCH_APPLY_ROLLBACK_KINDS,
    VARIABLE_PATCH_APPLY_RECORD_VERSION, VariablePatchApplyEvidenceStore,
    VariablePatchApplyInvalidationStore, invalidateAppliedVariablePatches,
    literalVariableSnapshotDigest, normalizeVariablePatchApplyEvidence,
    normalizeVariablePatchApplyInvalidation, variablePatchApplyInvalidationKey,
    readLiteralVariableSnapshotDigest, variablePatchApplyEvidenceDigest, variablePatchApplyEvidenceKey,
    variablePatchApplySessionDigest,
} from '../src/variable-patch-apply-evidence.ts';
export type {
    VariablePatchApplyEvidenceEntry, VariablePatchApplyEvidenceInput, VariablePatchApplyEvidenceOrigin,
    VariablePatchApplyEvidenceReceipt, VariablePatchApplyEvidenceScan,
    VariablePatchApplyInvalidationEntry, VariablePatchApplyInvalidationReceipt,
    VariablePatchApplyInvalidationScan, VariablePatchApplyRollbackKind,
} from '../src/variable-patch-apply-evidence.ts';
