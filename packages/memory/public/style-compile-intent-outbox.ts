/** Durable, content-free Style proposal source metadata; not an execution capability. */
export {
    StyleCompileIntentOutbox, STYLE_COMPILE_INTENT_PREFIX, STYLE_COMPILE_SETTLEMENT_PREFIX,
    normalizeStyleCompileBinding, normalizeStyleCompileIntent, styleCompileIntentDigest,
} from '../src/style-compile-intent-outbox.ts';
export type {
    StyleCompileBinding, StyleCompileSampleRef, StyleCompileIntent, StyleCompileIntentEntry, StyleCompileIntentScan,
    StyleCompileSettlementResult, StyleCompileIntentSettlement,
} from '../src/style-compile-intent-outbox.ts';
