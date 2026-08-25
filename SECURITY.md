# Security Policy

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities, exposed secrets, auth bypasses, data-leak risks, or abuse paths.

Use GitHub private vulnerability reporting from this repository's **Security** tab when available. Include:

- affected URL, endpoint, or file path
- impact and prerequisites
- reproduction steps or proof-of-concept details
- whether any credentials, API keys, tokens, or requester data may be exposed

If private vulnerability reporting is unavailable, contact the maintainer through a private channel before sharing details publicly.

## Scope

In scope:

- `pharos.watch`
- `api.pharos.watch`
- `site-api.pharos.watch`
- `ops.pharos.watch` and `ops-api.pharos.watch` access-control issues
- this repository's application, Worker, Pages Functions, CI, and deployment configuration

Out of scope:

- upstream provider outages or incorrect third-party data
- denial-of-service testing without prior coordination
- social engineering
- vulnerability reports that require access to another user's account, email inbox, or private infrastructure

For implementation guardrails around token-in-URL handling, inline scripts, CSP, and Safe Browsing, see [docs/security-governance.md](./docs/security-governance.md). The classifier-sensitive page-copy guardrail (`npm run check:sensitive-page-copy`) is documented in [docs/scripts.md](./docs/scripts.md).

## Handling

The maintainer will triage credible reports privately, prioritize fixes by severity, and publish public details only after a mitigation is available. Security fixes may be shipped without a public issue until disclosure is safe.

Supported version: the live production deployment from `main`.
