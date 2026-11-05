/** @author Codex @date 2026-10-26 @version 1.0
 * Stable first-party event/auth imports; all implementation stays in the original runtime.
 */
export {
    EventStreamClient,
    parseTaskInvalidation,
    createCookieTransport,
    normalizeEndpoint,
    ClientRuntimeError,
    type ClientScheduler,
    type EventStreamHandlers,
    type EventStreamSubscription,
    type EventStreamCursor,
} from '../src/index.ts';
export type { EventEnvelope } from '@jiuguan/mobile-contracts';
