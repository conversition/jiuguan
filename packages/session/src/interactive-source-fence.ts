/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Keep one host-owned source fence alive independently of optional Prelude outcomes.
 */
export const INTERACTIVE_SOURCE_FENCE_VERSION = 'interactive-source-fence-v1' as const;

export interface InteractiveSourceFence {
    /** Cheap sticky/owner check for streaming callbacks; does not read source state. */
    assertValid(): void;
    /** Revalidate the exact captured source, including after recoverable tool failures. */
    assertCurrent(): void;
    /** Retire old read callbacks after the authoritative transaction has committed. */
    close(): void;
}

/** Only the host supplies these ports; failure metadata is never accepted as authority. */
export function createInteractiveSourceFence(input: {
    readonly expectedRevision: string;
    readonly readRevision: () => string;
    readonly isCurrentOwner: () => boolean;
    readonly abortOwner: (reason: Error) => void;
}): InteractiveSourceFence {
    const { expectedRevision, readRevision, isCurrentOwner, abortOwner } = input;
    let failure: Error | undefined;
    let closed = false;
    const reject = (code: string, abort: boolean): never => {
        failure ??= new Error(code);
        if (abort) {
            try { abortOwner(failure); } catch { /* The sticky failure still prevents dispatch/commit. */ }
        }
        throw failure;
    };
    const assertValid = (): void => {
        if (failure) throw failure;
        if (closed) reject('interactive-source-fence-closed', false);
        let currentOwner: boolean;
        try { currentOwner = isCurrentOwner(); }
        catch { return reject('interactive-source-check-failed', true); }
        if (!currentOwner) reject('interactive-source-owner-changed', false);
    };
    const assertCurrent = (): void => {
        assertValid();
        let currentRevision: string;
        try { currentRevision = readRevision(); }
        catch { return reject('interactive-source-check-failed', true); }
        if (currentRevision !== expectedRevision) reject('interactive-source-revision-changed', true);
    };
    return Object.freeze({ assertValid, assertCurrent, close: () => { closed = true; } });
}
