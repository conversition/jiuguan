/** @author Codex @date 2026-10-26 @version 1.0
 * Source facade for the host-owned RP query compiler; no source or execution authority is exported.
 */
export {
    compileRpQueryContext,
    normalizeRpQueryContextHostInput,
    RP_QUERY_CONTEXT_VERSION,
} from '../src/rp-query-context.ts';
export type {
    RpQueryContextInput,
    RpQueryContextHostInput,
    RpQueryContextSource,
    RpQueryContextChildResult,
    RpQueryContextTrace,
    RpQueryContextCompilation,
    RpQuerySourceLayer,
} from '../src/rp-query-context.ts';
