# Jiuguan v0.2 clean-release manifest

## Provenance

- Public version: `0.2.0`（公开预览版；内部开发线版本号与公开版解耦）
- Source revision used for the clean export: `5a0aa7d7d077855ed91069854bdd74a4ede9db47`
- Snapshot date: `2026-11-05`
- Export method: tracked `HEAD` files only, followed by a new repository history
- Source working tree changes and untracked files were not copied

The source revision identifies code ancestry only. The public repository intentionally starts from
one new commit so removed data cannot be recovered from Git history.

## Deliberate exclusions

- The original `.git` directory and internal development reports (`docs/` is rebuilt for the public
  tree and contains only the installation guide, the autonomous-install handoff protocol and the
  banner asset)
- `data/`, `.workbuddy/`, databases, logs, caches and snapshots
- Environment files, Provider configuration, keys, cookies and device credentials
- Character cards, worldbooks, presets, Skills and learned outputs
- Internal `tests/`, `verify-*` and `probe-*` automation, replay evidence, evaluator baselines and
  live screenshots
- Installed plugin state and generated plugin bundles
- APK/AAB files, Android local configuration, keystores and signing passwords
- Internal vendor review snapshots

## Deliberate retained code

- Generic card/worldbook/preset/Skill infrastructure
- Generic plugin host and SDK
- First-party CommandCode Provider source, build script and license metadata
- Agent policy, skill hub, harness, learning and maintenance implementation, all disabled by the
  public profile
- Mobile shell and Tailscale private-access automation
- Required third-party LICENSE and NOTICE files

## Deliberate neutralisations

The following are shipped as empty tables or configurable values instead of the author's private
assets. None of them changes the public default behaviour towards enabling anything:

- `packages/prompt/src/migrated-style-profiles.ts` and
  `packages/prompt/src/migrated-procedure-steps.ts` ship as empty `Object.freeze({})` tables.
  Style profiles and procedure steps are user assets; use `pnpm style:import` with your own
  `JG_STYLE_SRC` to materialise them locally.
- Worldbook labels are no longer hardcoded. `content-modes` supplied by the user decide which
  worldbook files load, and the web setup screen no longer preselects any worldbook.
- `ASSET_BASE` defaults to `<JG_USER_DATA_DIR>\library` and is only overridable through
  `JG_ASSET_BASE`. `pnpm style:import` requires `JG_STYLE_SRC`; there is no built-in source path.
- GLA/CDN URL construction stays disabled unless `JG_GAL_ASSET_BASE` is set; manifest-matched
  assets keep working without it.
- Launchers keep the frozen `public-safe-v0.1` profile, so every autonomous lane stays off until the
  user explicitly opts in.

## Default data boundary

User assets and sessions are created outside the source tree under the configured
`JG_USER_DATA_DIR`. On Windows launchers use `%LOCALAPPDATA%\Jiuguan\a9-private-data`. The optional
read-only asset library defaults to `<JG_USER_DATA_DIR>\library` and can be changed only through
`JG_ASSET_BASE`.

## Verification

`pnpm public:verify` is the mandatory static release gate. It rejects runtime data, credentials,
personal absolute paths, private tailnet hosts, generated plugin bundles and common key formats. A
release is ready only when that command, `pnpm typecheck`, and `pnpm build` all pass from a clean
checkout. Build output must remain ignored and must not be included in the source commit.

## Maintainer note

The root MIT copyright holder is the neutral collective name `Jiuguan Contributors`. A future
maintainer may change this before publishing, but must not remove third-party attribution.
