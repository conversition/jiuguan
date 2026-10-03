# CommandCode Provider

First-party, PC-only DSH Provider for Jiuguan. It is not a mobile runtime and
does not expose credentials to the browser or Android client.

- Credential: host-owned `COMMANDCODE_API_KEY`
- Provider id: `commandcode`
- Build artifact: `bundle/index.js` (self-contained ESM; Node built-ins only)
- Capabilities: chat completions, streaming, tools, vision and model listing

Run `pnpm --filter commandcode-provider build` after changing CommandCode core,
runtime or Provider code. The DSH host copies this package to an isolated
runtime directory and imports only the bundled `main` file.

Use `pnpm commandcode:provider:sync` to build and install/sync this first-party
bundle into `JG_USER_DATA_DIR/plugins` (or `data/plugins` by default). The
command is idempotent. If Jiuguan is running on `JG_WEB_PORT` (17800 by
default), sync uses the loopback plugin HTTP API so the DSH runtime is reloaded
without competing for `registry.json`. With the server stopped, sync performs
an offline registry update. `--data-dir` is offline-only and is refused while
the configured server is live.

The repository one-click private launcher builds and performs an offline sync
into `%LOCALAPPDATA%\\Jiuguan\\a9-private-data` before backend startup. A sync
failure blocks startup and is written to
`.workbuddy/runtime/private-commandcode-provider-sync.log`; the launcher never
continues with a stale or partially updated first-party plugin.

If an installation with the same id came from another source, it is preserved
and the command exits with code 2; there is deliberately no implicit `--force`
path that could overwrite a user-managed version.

Set `COMMANDCODE_API_KEY=user_...` in the PC server environment, or keep an
existing valid `user_...` key in the host-only `provider.json`, then select
`commandcode` and its model explicitly in the Provider panel. The key stays
inside the host credential resolver. It is never copied into the plugin,
browser, or APK.

Optional host-only runtime settings live in
`a9-private-data/plugins/.data/commandcode-provider/config.json`. The file has a
strict allowlist: `apiBase` (string), `upstreamProxy` (string), `zdr`
(boolean), `streamIdleTimeoutMs`, and `nonStreamIdleTimeoutMs` (integer,
1,000–7,200,000 ms). Unknown keys—including `apiKey`—make plugin activation
fail closed. The stream default is five minutes of complete upstream silence;
every received chunk restarts that window, so it is not a total generation
deadline. Non-streaming summaries and quiet tasks also receive a bounded
five-minute response window. For these fields the plugin-owned file overrides any stale ambient
CommandCode environment variables; the fixed logical project identity remains
host-controlled and cannot be overridden by this file. `upstreamProxy` can
contain proxy authentication, so this file must remain computer-local even
though the CommandCode API key itself is never written there. Disabling the plugin removes CommandCode
from the available Provider list while preserving the explicit selection as
unavailable; it never silently falls back to a different Provider.

To migrate only those non-secret fields from the legacy standalone proxy, run:

```powershell
pnpm commandcode:provider:migrate-config -- --source "<legacy-config.json>" --data-dir "$env:LOCALAPPDATA\Jiuguan\a9-private-data"
```

The migration copies the two optional idle timeout fields in addition to the
non-secret connection settings. It ignores the known standalone-only fields
(`port`, `host`, `projectSlug`, and logging fields) and never copies `apiKey`. It rejects unknown
fields and refuses to overwrite an existing plugin config unless the operator
adds the explicit `--replace` flag. Output contains status and migrated field
names only, never values. Run migration while the private Jiuguan service is
stopped, then start it normally; the plugin reads this file during activation.

The upstream CommandCode identity uses the fixed logical path
`C:\\jiuguan\\workspace`. It is intentionally unrelated to the plugin
installation directory or user profile, because CommandCode derives both
`workingDir` and `x-project-slug` from this value.
