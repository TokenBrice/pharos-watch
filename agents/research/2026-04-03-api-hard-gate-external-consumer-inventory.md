# External Consumer Inventory for API Hard Gate

**Date:** 2026-04-03
**Status:** Repo-derived inventory with explicit unknowns
**Scope:** `api.pharos.watch` hard-gate rollout planning

## What this inventory can and cannot prove

This note establishes the strongest consumer inventory that can be derived from:

- the current repository
- configured GitHub workflows
- local Cloudflare Wrangler visibility available in this workspace

It does **not** prove the absence of off-repo consumers. Anything outside this repository still requires Cloudflare traffic/log review or human system inventory before production enforcement is flipped to `PUBLIC_API_AUTH_MODE=enforce`.

## Cloudflare surface confirmed from this workspace

- Worker script: `stablecoin-api`
- Pages project: `stablecoin-dashboard`
- Pages domains currently attached:
  - `pharos.watch`
  - `ops.pharos.watch`
  - `stablecoin-dashboard.pages.dev`
- Worker custom domains currently attached in repo config:
  - `api.pharos.watch`
  - `ops-api.pharos.watch`
- Worker secrets already present:
  - `SITE_API_SHARED_SECRET`
  - `API_KEY_HASH_PEPPER`

## Repo-visible consumers of `api.pharos.watch`

### 1. First-party website browser traffic

Current state:

- Public site/browser reads default to `https://api.pharos.watch` on canonical site and Pages hosts.
- Main source of that behavior: [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts)
- This is the website traffic that must move to same-origin `/_site-data/*` before public API enforcement.

Observed repo touchpoints:

- all hook-based public reads through `apiFetch()` / `apiFetchWithMeta()`
- public status/browser probes via [src/hooks/use-endpoint-probes.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-endpoint-probes.ts)

### 2. CI preview smoke against candidate Worker versions

- Workflow: [deploy-cloudflare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- Job: `upload-worker-version`
- Behavior:
  - uploads a candidate Worker version
  - smokes the preview URL with `npm run test:smoke-api`

This consumer must send an API key once protected routes are enforced.

### 3. Post-promotion production API smoke

- Workflow: [deploy-cloudflare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- Job: `smoke-api`
- Base URL:
  - `vars.SMOKE_API_BASE_URL`
  - fallback `vars.API_BASE_URL`

This consumer must send an API key once protected routes are enforced.

### 4. Pages build digest sync

- Workflow: [pages-prepare.yml](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-prepare.yml)
- Script: [scripts/sync-digests.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/sync-digests.ts)
- Current source:
  - `DIGEST_API_URL`
  - fallback `SMOKE_API_BASE`
  - fallback `API_BASE_URL`
- Current endpoint dependency:
  - `GET /api/digest-archive`

This consumer must send an API key once protected routes are enforced. The plan intentionally does not exempt `GET /api/digest-archive`.

### 5. Local static-export smoke proxy

- Script: [scripts/serve-static-export.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/serve-static-export.mjs)
- Current behavior:
  - proxies `/api/*` to `STATIC_EXPORT_API_BASE`
  - default fallback is the public API origin

This is not a production consumer, but it is part of the repo-controlled rehearsal path and must be updated for:

- `/_site-data/*` proxying with `SITE_API_SHARED_SECRET`
- keyed `/api/*` smoke for remaining direct public calls

### 6. Public feedback widget

- Browser POST from [src/components/feedback-modal.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/feedback-modal.tsx)
- Endpoint: `POST /api/feedback`

This route is explicitly planned to remain exempt from API-key enforcement.

### 7. Telegram webhook ingress

- Worker/runtime registration helpers and ops scripts point Telegram to `https://api.pharos.watch/api/telegram-webhook`
- Files:
  - [worker/src/lib/telegram-webhook-registration.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/telegram-webhook-registration.ts)
  - [scripts/register-telegram-webhook.sh](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/register-telegram-webhook.sh)

This route is explicitly planned to remain exempt from API-key enforcement.

### 8. Public OG image fetches

- Metadata helpers build OG URLs from the public API origin.
- Files:
  - [src/lib/page-metadata.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts)
  - [src/components/share-button.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/share-button.tsx)
- Endpoint family:
  - `GET /api/og/*`

This route family is explicitly planned to remain exempt from API-key enforcement.

## Repo-visible traffic that is not a blocking external consumer for enforcement

### 1. Ops/admin browser and automation traffic

- `ops.pharos.watch` Pages Functions proxy to `ops-api.pharos.watch`
- Access-protected admin/API traffic is already on the operator lane
- Representative files:
  - [functions/api/admin/[[path]].ts](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/api/admin/[[path]].ts)
  - [scripts/smoke-ops.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ops.mjs)

These are not the public hard-gate target. They must keep working, but they do not need public API keys.

### 2. Worker self-checks

- Cron: [worker/src/cron/status-self-check.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts)
- Important nuance:
  - when probing the default production public API origin, the Worker internally routes the probe instead of making a public custom-domain self-fetch

This means the default production self-check is not a normal external consumer of `api.pharos.watch`.

## Unknowns that the repo cannot certify

These remain possible until checked outside the repository:

- partner or customer integrations
- internal scripts living in other repos
- notebooks, spreadsheets, Postman collections
- cron jobs or CI pipelines outside this repo
- third-party monitors or uptime checks
- browser extensions or internal dashboards not represented here

## Enforcement readiness implications

Safe to implement autonomously now:

- website cutover to `/_site-data/*`
- `site-api.pharos.watch` secret-backed lane
- API key infrastructure
- CI/script support for keyed consumers already visible in this repo

Still requires human confirmation before final production enforcement:

- whether any off-repo legitimate consumers exist
- whether any existing monitor/uplink should receive a key
- whether traffic seen in Cloudflare analytics after rollout matches this repo-derived inventory
