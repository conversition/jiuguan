# CommandCode core attribution

This package contains TypeScript adaptations of protocol behavior from
`commandcode-proxy@1.0.0`.

- Copyright: Copyright (c) 2026 MAXeaglet
- License: MIT; see `LICENSE`
- Source snapshot: `vendor/commandcode-proxy-baseline/upstream/proxy.mjs`
- Snapshot aggregate SHA-256:
  `5ecf044992030a0df1fcff86937943578d603e6696ab73749149b47af04f247a`
- Imported snapshot date: 2026-09-24

The first extraction adapts the upstream error summarizer, tool aliases/output
conversion, usage normalization, finish-reason normalization,
incomplete-stream handling, and HTTP/stream error mapping. The corresponding
upstream functions are near lines 289-294, 686-705, 864-1018, and 1731-1751 of
the pinned `proxy.mjs`.

The second extraction adapts `buildCcRequest`,
`convertAnthropicToOpenAI`, and `convertResponsesToChat`, near lines
496-683, 1800-1970, and 2644-2753 of the pinned `proxy.mjs`. Jiuguan names
the two client-normalization APIs `convertAnthropicToChat` and
`convertResponsesToChat`.

Jiuguan changes in this package include strict TypeScript types, immutable
usage normalization, explicit exports, deterministic tests, and removal of all
configuration, environment, file, network, timer, process-listener, and HTTP
server side effects. Three upstream edge cases are intentionally hardened:
tool aliases use own Map entries instead of the JavaScript object prototype,
untrusted error message/code fields require strings and are length-bounded,
and reported HTTP statuses must be integers in the 100-599 range.

Request conversion additionally receives the date, device profile, and
Responses fallback call-id factory explicitly from the host. Unknown Responses
items are surfaced through a structured callback instead of writing logs, and
tool-call lookup tables use `Map` so special keys such as `__proto__` cannot
read or mutate the object prototype.

The third extraction adapts the non-stream accumulation paths and response
builders near lines 1556-1692, 1759-1798, 2429-2540, 2756-2829, and
3222-3335. NDJSON decoding, terminal classification, Chat/Anthropic/Responses
usage policies, and response rendering are isolated from HTTP readers and
writers. IDs, completion time, and thinking signatures are host-injected.

The decoder intentionally consumes a final NDJSON record without a trailing
newline. The pinned vendor non-stream loops leave that record buffered at EOF;
dropping a valid final finish record can falsely classify a complete response
as truncated. This is a deliberate, tested bug fix rather than parity.

The decoder also fixes its input mode per instance and requires an explicit
buffer bound. Event and usage fields are read only from own properties; token
counts are restricted to known, non-negative finite numbers. These checks
intentionally reject malformed programmatic values that the upstream JavaScript
would otherwise coerce, inherit, or propagate into billing output.

The fourth extraction adapts the three streaming translators near lines
709-848, 1976-2213, and 2838-3041. The extracted state machines emit immutable
SSE strings but do not read response bodies, commit HTTP headers, schedule
heartbeats or timeouts, wait for drain, abort requests, or log. Completion IDs,
creation time, tool/call IDs, thinking signatures, and warning sinks are all
provided by the host.

Streaming terminal output is deliberately hardened beyond the pinned vendor:
Chat delays its finish chunk until terminal classification succeeds and
synthesizes a complete terminal chunk for a finish-step-only stream; the final
finish reason overrides an earlier step reason. All translators lock after an
explicit error or final finish so later deltas cannot leak. Empty Anthropic
text deltas do not create blocks or token estimates. Responses uses actual
content for its empty check, never returns an empty successful SSE stream, and
closes and retains partial items in a failed response. Scalar false/zero tool
inputs are serialized rather than replaced with an empty object. These are
deliberate, golden-tested correctness and safety fixes; normal JSON event
sequences retain the vendor event ordering and wire shapes.

SSE serialization is additionally hardened against prototype-supplied and
payload-supplied callable `toJSON` methods. Payloads are copied from own data
properties into serialization-only containers; accessors are not invoked,
arrays shadow inherited `toJSON`, and cyclic/BigInt values are rejected.
Injected ID and thinking-signature functions are evaluated before the related
protocol state is committed, so a thrown exception does not consume a first
chunk, block/item index, or Responses sequence number.

Transport concerns remain host responsibilities. In particular, callers must
use the finalization decision together with `hadOutputBeforeFinalize` and their
own header/write state; the aggregate emitted-frame count includes terminal
frames and is not an HTTP-started signal. The Responses-only
`transportError(message)` formatter adapts the pinned vendor `errorEvent()`
wire shape and owns its next sequence number, but timeout detection, aborts,
header state, writes, drain handling, and connection closing remain in the
host. A transport error locks the translator and is not followed by synthetic
item completion or `response.failed` frames.

Malformed or null request collections are ignored or treated as empty instead
of reproducing upstream property-access exceptions. This core still requires
JSON-compatible, acyclic request values; it does not claim to serialize
arbitrary in-memory JavaScript graphs.

Do not import or execute the vendor snapshot from product code. Every vendor
refresh requires a separate hash, license, network-path, and parity review.
