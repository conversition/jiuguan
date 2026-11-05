/** @author Codex @date 2026-10-14 @version 1.0 */
export {
    MaintenanceMemoryConsumptionOutbox, MemoryConsumptionOutbox, MEMORY_CONSUMPTION_PREFIX,
    memoryConsumptionDigest, memoryConsumptionEventKey, memoryConsumptionSourceRef, normalizeMemoryConsumptionPayload,
} from '../src/maintenance-memory-consumption-outbox.ts';
export type {
    MemoryConsumptionPreparation, MemoryConsumptionRetainedHit, MemoryConsumptionConsumer,
    MemoryConsumptionPayload, MemoryConsumptionEntry, MemoryConsumptionScan,
} from '../src/maintenance-memory-consumption-outbox.ts';
