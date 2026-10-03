# CommandCode runtime attribution

This package adapts configuration defaults and upstream endpoint policy from
`commandcode-proxy@1.0.0`.

- Copyright: Copyright (c) 2026 MAXeaglet
- License: MIT; see `LICENSE`
- Source snapshot: `vendor/commandcode-proxy-baseline/upstream/proxy.mjs`
- Adapted source areas: device fingerprint, session, initialization and trace
  behavior around lines 96-483; provider model refresh and fallback behavior
  around lines 2579-2618 of the imported snapshot.
- Snapshot aggregate SHA-256:
  `5ecf044992030a0df1fcff86937943578d603e6696ab73749149b47af04f247a`
- Imported snapshot date: 2026-09-24

Jiuguan changes include explicit configuration sources, own-data-only reads,
strict validation, immutable request snapshots, a fixed production upstream
origin/path policy, loopback-only proxy configuration and redacted public
diagnostics. Jiuguan also adds a PC-only Node HTTPS executor with explicit
loopback HTTP CONNECT, TLS verification, cancellation, deadline and error
redaction behavior, plus an explicit runtime instance for deterministic device
identity, credential-isolated initialization/model singleflight, response-body
leases, drain and dispose. Runtime state keys use an instance-random pepper;
successful initialization is cached only after both upstream calls return 2xx;
model results are schema/size checked, deduplicated and frozen; caller
cancellation does not cancel a shared flight. The package never reads files or
environment variables by itself. It also does not connect, listen, schedule
timers or register process listeners when imported.
