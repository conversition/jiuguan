# Security policy

## Supported release

The `v0.1.x` line receives security fixes while it is the newest public line.

## Reporting a vulnerability

Please use the repository's private GitHub Security Advisory form. Do not place API keys,
pairing codes, cookies, private hostnames, character cards, worldbooks, conversations, or
database files in a public issue.

Include the affected version, a minimal reproduction using synthetic data, and the security
impact. Remove secrets from logs before attaching them.

## Deployment boundary

Jiuguan is local-first. The local launcher binds to loopback. Mobile access is designed for a
private Tailscale HTTPS endpoint and must not be exposed with Funnel or public port forwarding.
Autonomous Agent lanes and maintenance writes are disabled in the public profile by default.
