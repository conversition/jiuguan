/** @author Codex @date 2026-10-26 @version 1.0
 * Reuse the authenticated event SDK for the existing status panel, without another event bus.
 */
import {
    createCookieTransport,
    EventStreamClient,
    normalizeEndpoint,
    type ClientScheduler,
    type EventStreamHandlers,
    type EventStreamSubscription,
} from '../../../packages/client-runtime/public/events.ts';
import { authFetch, eventUrl } from './authClient.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';

export interface AgentStatusEventOptions {
    readonly onConnected?: () => void | Promise<void>;
    readonly fetchImpl?: typeof fetch;
    readonly scheduler?: ClientScheduler;
    readonly endpoint?: string;
    readonly supportsStreaming?: boolean;
}

export function startAgentStatusEvents(
    handlers: EventStreamHandlers,
    options: AgentStatusEventOptions = {},
): EventStreamSubscription | null {
    const supported =
        options.supportsStreaming ??
        (WEB_CLIENT_PROFILE.profile !== 'android-bundled' && typeof ReadableStream !== 'undefined');
    if (!supported) return null;
    const endpoint = normalizeEndpoint(options.endpoint ?? new URL(eventUrl('/api/events')).origin, {
        allowInsecureLoopback: true,
    });
    const base = createCookieTransport({
        endpoint,
        fetchImpl: options.fetchImpl ?? authFetch,
        csrfTokenProvider: () => undefined,
    });
    const client = new EventStreamClient({
        transport: {
            kind: base.kind,
            endpoint,
            async execute(input, init) {
                const response = await base.execute(input, init);
                if (
                    response.status === 200 &&
                    response.body &&
                    response.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream'
                ) {
                    // Subscribe first, then refresh: an update between the initial GET
                    // and the SSE connection must not leave the inspector stale forever.
                    try {
                        await options.onConnected?.();
                    } catch (error) {
                        try {
                            await response.body.cancel();
                        } catch {
                            /* Preserve the read failure. */
                        }
                        throw error;
                    }
                }
                return response;
            },
        },
        scheduler: options.scheduler ?? {
            schedule(callback, delayMs) {
                const timer = globalThis.setTimeout(callback, delayMs);
                return () => globalThis.clearTimeout(timer);
            },
        },
        taskEventVersion: 2,
        requestIdFactory: () => crypto.randomUUID(),
    });
    return client.start(handlers);
}
