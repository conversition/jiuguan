# Jiuguan Agent v0.1

Jiuguan is a Windows-first, local-first role-play chat host inspired by the asset workflow of
SillyTavern. It combines character cards, worldbooks, presets, persistent sessions, memory,
streaming generation, a plugin host, mobile private access, and a bounded multi-Agent runtime.

This repository is the clean `v0.1.0` public source distribution. It contains no user session,
character card, worldbook, preset, learned Skill, cache, installed plugin, API key, device
credential, private hostname, or signing material.

## What is included

- React web client and Node.js server
- Character-card, worldbook, preset and Skill import/edit infrastructure
- SQLite session truth with optional PostgreSQL/pgvector semantic indexing
- Streaming turns, reconnect/recovery and mobile-oriented UI
- Plugin framework and the first-party CommandCode Provider **source code**
- PolicyRouter, Context Compiler and bounded Harness infrastructure
- Tailscale-only private HTTPS launcher and Android packaging source

The first-party provider source is part of the product, not an installed user plugin. Its generated
bundle, credentials, configuration and runtime storage are deliberately absent.

## Public-safe defaults

The main chat path remains available after you configure a Provider. The experimental autonomous
lanes start fail-closed:

| Capability | v0.1 default |
|---|---|
| Interactive Agent / bounded tool loop | Off |
| Preference and Style learning calls | Off |
| Maintenance Harness | Off |
| Context Compiler live execution | Off |
| Maintenance business writes | Off |

No historical test session or authorization window is included. Do not enable a lane until you
have defined an exact session, a physical-request ceiling, a cost ceiling and a rollback policy.

## Quick start on Windows

Requirements: Node.js `22.22.2`, pnpm `10.33.0`, Git, and a modern browser.

```powershell
git clone <REPOSITORY_URL> jiuguan
Set-Location jiuguan
pnpm install --frozen-lockfile
pnpm public:verify
pnpm typecheck
pnpm build
```

Then double-click `一键启动.bat`. The local UI opens at `http://localhost:5173` and the API binds
to `127.0.0.1:17800`. Stop it with `停止.bat`.

On first launch the asset lists are empty by design. Configure your own Provider in the UI, then
import content you own or are permitted to use.

## Mobile access

For phone access, install Tailscale on the PC and phone, join the same tailnet, enable MagicDNS and
HTTPS certificates, then run `私有远程启动.bat`. It creates a tailnet-only HTTPS endpoint; it does
not enable public Funnel access or permanent Tailscale startup.

Read [安装与使用](docs/安装与使用.md) before pairing or building an APK.

## For installation agents

Automated assistants must follow [AGENT 自主安装交接](docs/AGENT-自主安装交接.md). It defines the
non-negotiable privacy boundary, offline checks, completion criteria and operations that require
explicit user authorization.

## Release hygiene

Run this before every public commit or archive:

```powershell
pnpm public:verify
```

The gate rejects runtime data, credentials, timestamp-derived session IDs, personal absolute paths,
private tailnet hosts, generated plugin bundles and common secret formats. See
[clean release manifest](CLEAN_RELEASE_MANIFEST.md) for provenance and exclusions.

## Known v0.1 limitations

- No example character card, worldbook, preset or Skill is bundled.
- Private-fixture integration tests from the development repository are intentionally excluded.
- Autonomous lanes are infrastructure-complete enough for controlled development, but are not
  enabled as a production default.
- The mobile web path is the recommended first mobile experience; APK builds require your own exact
  private HTTPS endpoint and Android toolchain.

## License

Project code is released under the [MIT License](LICENSE). Third-party components retain their own
LICENSE and NOTICE files.
