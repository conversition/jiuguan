/**
 * @author  : Codex
 * @time    : 2026-10-15
 * @function: Parse the existing advisory-only AQL plain-text response.
 * @version : v1.0
 */
export const AQL_REPLAN_OUTPUT_VERSION = 'aql-replan-output-v1' as const;
export const AQL_REPLAN_MAX_SUGGESTION_LENGTH = 300;

export interface AqlReplanOutput {
    readonly version: typeof AQL_REPLAN_OUTPUT_VERSION;
    readonly suggestion: string;
    readonly trimmedLength: number;
    readonly truncated: boolean;
}


/**
 * Keep the deployed trim/slice behavior, including UTF-16 length and literal JSON-like text.
 * The prompt's 200-character target is advisory; the existing consumer cap is 300 code units.
 * Managed callers validate here but return the original text so the final Session consumer
 * normalizes once and retains the original trimmed length for its generation log.
 */
export function parseAqlReplanOutput(raw: unknown): AqlReplanOutput | null {
    if (typeof raw !== 'string') return null;

    const text = raw.trim();
    if (text.length === 0) return null;

    return Object.freeze({
        version: AQL_REPLAN_OUTPUT_VERSION,
        suggestion: text.slice(0, AQL_REPLAN_MAX_SUGGESTION_LENGTH),
        trimmedLength: text.length,
        truncated: text.length > AQL_REPLAN_MAX_SUGGESTION_LENGTH,
    });
}
