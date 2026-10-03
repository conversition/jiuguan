# Jiuguan v0.1 clean-release manifest

## Provenance

- Public version: `0.1.0`
- Source revision used for the clean export: `b279557e52139a8afa93404989fd5bfedc799e3d`
- Export method: tracked `HEAD` files only, followed by a new repository history
- Source working tree changes and untracked files were not copied

The source revision identifies code ancestry only. The public repository intentionally starts from
one new commit so removed data cannot be recovered from Git history.

## Deliberate exclusions

- The original `.git` directory and internal development reports
- `data/`, `.workbuddy/`, databases, logs, caches and snapshots
- Environment files, Provider configuration, keys, cookies and device credentials
- Character cards, worldbooks, presets, Skills and learned outputs
- Installed plugin state and generated plugin bundles
- Private-fixture tests, replay evidence, evaluator baselines and live screenshots
- APK/AAB files, Android local configuration, keystores and signing passwords
- Internal vendor review snapshots

## Deliberate retained code

- Generic card/worldbook/preset/Skill infrastructure
- Generic plugin host and SDK
- First-party CommandCode Provider source, build script and license metadata
- Agent policy, Harness, learning and maintenance implementation, all disabled by the public profile
- Mobile shell and Tailscale private-access automation
- Required third-party LICENSE and NOTICE files

## Default data boundary

User assets and sessions are created outside the source tree under the configured
`JG_USER_DATA_DIR`. On Windows launchers use `%LOCALAPPDATA%\Jiuguan\a9-private-data`. The optional
read-only asset library defaults to `<JG_USER_DATA_DIR>\library` and can be changed only through
`JG_ASSET_BASE`.

## Verification

`pnpm public:verify` is the mandatory static release gate. A release is ready only when that command,
`pnpm typecheck`, and `pnpm build` all pass from a clean checkout. Build output must remain ignored
and must not be included in the source commit.

## Maintainer note

The root MIT copyright holder is the neutral collective name `Jiuguan Contributors`. A future
maintainer may change this before publishing, but must not remove third-party attribution.
