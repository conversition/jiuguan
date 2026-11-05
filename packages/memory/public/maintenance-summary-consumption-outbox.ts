/** @author Codex @date 2026-10-14 @version 1.0 */
export {
    MaintenanceSummaryConsumptionOutbox, SummaryConsumptionOutbox, SUMMARY_CONSUMPTION_PREFIX,
    SUMMARY_CURRENT_OWNER_KEY,
    summaryConsumptionDigest, summaryConsumptionEventKey, summaryConsumptionSourceRef, normalizeSummaryConsumptionPayload,
} from '../src/maintenance-summary-consumption-outbox.ts';
export type {
    SummaryConsumptionPreparation, SummaryConsumptionConsumer, SummaryConsumptionPayload,
    SummaryConsumptionEntry, SummaryConsumptionScan, SummaryConsumptionSummary,
} from '../src/maintenance-summary-consumption-outbox.ts';
