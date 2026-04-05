# API Hard-Gate Implementation Plan

**Date:** 2026-04-03
**Status:** Proposed
**Depends on:** `agents/plans/2026-04-03-api-hard-gate-architecture-plan.md`

## Goal

Ship a true hard gate for `api.pharos.watch` without website downtime:

- `pharos.watch` must continue to load normally for end users
- `api.pharos.watch` must become a keyed external API
- rollout must be staged so the website is fully off the public API host before enforcement

## Research-Locked Decisions

### 1. The website must move to a separate same-origin data surface first

This remains the core requirement. Public browser calls to `api.pharos.watch` cannot be distinguished from third-party scripted calls strongly enough to support a hard gate.

### 2. Do not use browser heuristics for auth

`Origin`, `Referer`, `Sec-Fetch-*`, and the Pharos Accept marker remain telemetry-only. They must not participate in the allow/deny decision.

### 3. Refine the architecture for execution safety: do not put the website hot path behind Cloudflare Access

The architecture plan proposed `site-api.pharos.watch` protected by Access service tokens. After research, that is not the right execution choice for this repo.

Why:

- Cloudflare documents that the Cache API is not currently available for Workers fronted by Cloudflare Access.
- This Worker relies on `caches.default` for the public read path.
- Moving the website hot path behind Access would remove Worker edge-cache availability on that lane exactly where we want the lowest-risk, lowest-latency path.

**Implementation decision:** keep the dedicated website-upstream host, but authenticate it with a Worker-verified shared secret from Pages Functions instead of Cloudflare Access.

That gives us:

- a real server-side trust boundary
- preserved Worker cache behavior on `site-api.pharos.watch`
- simpler CI rehearsal against Worker preview URLs
- less Cloudflare dashboard coordination during the sensitive cutover

### 4. Do not switch the website-internal lane to Pages service bindings in v1

Service bindings were researched and are viable in principle, but they are not the best first rollout for this repo.

Reasons:

- Binding Pages Functions directly to the public Worker does not create a trustworthy target-side identity signal by itself; the Worker still needs a separate auth rule.
- Binding Pages Functions to a second private Worker would be cleaner architecturally, but it would force a larger CI/local-smoke redesign because the current Pages rehearsal model depends on preview URLs and a simple static proxy server.
- Cloudflare documents that multi-config local development for Pages + bound Workers with `wrangler pages dev -c ... -c ...` is experimental.
- A service-binding rollout would also move this change onto a different deployment surface than the repo's current preview-URL rehearsal path, which increases execution risk for a no-downtime first pass.
- For this rollout, the dedicated `site-api.pharos.watch` host plus a shared secret is the lower-risk execution path.

### 5. Keep request-source attribution two-way: `web` vs `external`

Do **not** add a third `"api-key"` source bucket.

After cutover:

- website traffic will largely disappear from `api.pharos.watch`
- keyed direct API traffic remains `external`
- the current stats/admin/UI contract stays intact

### 6. Do not emit per-key rate-limit headers in v1

Per-key `X-RateLimit-*` headers on cacheable GET responses create avoidable cache-safety complexity. The first release should return only:

- `401` for missing/invalid API key
- `429` for key-specific rate limiting

Skip per-key limit headers until there is a cache-safe post-routing/header-injection design.

### 7. Do not introduce a Pages production Wrangler configuration file in this rollout

The repo currently deploys Pages via `wrangler pages deploy out --project-name=stablecoin-dashboard` without a root Pages Wrangler config.

Cloudflare documents that:

- once `pages_build_output_dir` is added, the Wrangler file becomes the Pages project source of truth
- if a local-development Wrangler file is promoted without careful migration, Pages may use non-production config

**Implementation decision:** keep Pages production configuration dashboard-managed for this rollout.

That means:

- no new root `wrangler.toml` / `wrangler.jsonc` for Pages production config in v1
- configure Pages secrets and bindings in the Cloudflare dashboard
- keep local rehearsal on the existing Node smoke server rather than switching to `wrangler pages dev` as a deployment dependency

### 8. Worker preview URLs are an explicit dependency of the rollout

The combined worker+Pages rehearsal path depends on Worker preview URLs.

Cloudflare documents that preview URLs are public when enabled and can be explicitly toggled in Wrangler via `preview_urls = true`.

**Implementation decision:** treat `worker/wrangler.toml: preview_urls = true` as required infrastructure for this rollout and do not remove or disable it until the deployment strategy changes.

### 9. Do not reuse `isCanonicalSiteHostname()` for the `/_site-data/*` Pages host gate

The current shared helper treats any `*.pharos.watch` hostname as canonical. That is broader than the website data surface needs and would incorrectly include hosts like `ops.pharos.watch`.

**Implementation decision:** add a new narrow helper for the website data surface that accepts only:

- `pharos.watch`
- `*.stablecoin-dashboard.pages.dev`

Do not use the broader `isCanonicalSiteHostname()` helper directly for the new `/_site-data/*` route gate.

### 10. Do not assume cache reuse across `pharos.watch`, `site-api.pharos.watch`, and `api.pharos.watch`

This repo's cache keys are URL-based, and Cloudflare documents that Cache API contents do not replicate outside the originating data center.

**Implementation decision:** treat these as three distinct cache surfaces:

- Pages cache on `pharos.watch/_site-data/*`
- Worker cache on `site-api.pharos.watch/api/*`
- Worker cache on `api.pharos.watch/api/*`

Smoke tests prove correctness, not global cache warmth. Do not build rollout assumptions around pre-warming every POP.

### 11. Public API auth must also be exercised on Worker preview URLs

The current CI flow smoke-tests uploaded candidate versions on preview URLs before promotion. If preview URLs bypass public API auth, preview smoke will not prove the gated behavior that production will enforce.

**Implementation decision:** on `*.workers.dev` preview URLs:

- requests with a valid site-proxy secret and an allowlisted website path follow the website-internal lane
- all other public API requests follow the same public API auth-mode logic as `api.pharos.watch`

That keeps preview smoke representative for both the website lane and the keyed external API lane.

### 12. The supported steady-state local-dev path is `NEXT_PUBLIC_API_BASE` -> local `wrangler dev`

After `api.pharos.watch` is enforced, anonymous browser rewrites to the production API are no longer a stable developer workflow.

**Implementation decision:** keep `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787` (or equivalent local Worker origin) as the supported local `next dev` contract after enforcement. Do not make an anonymous rewrite to production `api.pharos.watch` a required final-state dependency.

## Final Architecture For Implementation

### Host split

1. `pharos.watch`
   - static export + same-origin Pages Functions
   - new website data surface: `/_site-data/*`

2. `site-api.pharos.watch`
   - same Worker script as the public API
   - not documented as a product surface
   - requires Pages-to-Worker shared-secret auth
   - only serves the website route allowlist

3. `api.pharos.watch`
   - external API product surface
   - API key required for protected public JSON endpoints

4. `ops.pharos.watch` / `ops-api.pharos.watch`
   - unchanged

### Data flow

```text
Browser on pharos.watch
  -> GET /_site-data/*
  -> Pages Function allowlist + edge cache
  -> site-api.pharos.watch/api/* with shared secret
  -> Worker route handlers + Worker edge cache + D1

External consumer
  -> api.pharos.watch/api/*
  -> Worker API key gate
  -> Worker route handlers + Worker edge cache + D1
```

## No-Downtime Rollout Invariants

These are mandatory. If any cannot be satisfied, stop and re-scope.

1. `/_site-data/*` must be live and verified before the frontend cutover ships.
2. `PUBLIC_API_AUTH_MODE` must remain `off` until the live website no longer depends on direct public API GETs.
3. CI/build consumers must be updated to use an API key before enforcement, or they will break on the first gated deploy.
4. New D1 migrations must remain backward-compatible because worker deploy still applies migrations before production promotion.
5. Pages and Worker rollout must remain decomposed into separate safe deploys; do not combine frontend cutover and gate enforcement in one step.
6. Worker preview smoke must exercise both the preview public API gate and the preview site-proxy lane before any production promotion that depends on them.
7. The final supported local-dev path must not rely on anonymous browser access to production `api.pharos.watch`.

## Canonical Contracts

### Website data path contract

Public browser path prefix:

- `/_site-data`

Upstream mapping:

- `/_site-data/foo` -> `/api/foo`
- strip only the leading `/_site-data` prefix
- preserve the remaining pathname exactly
- preserve the query string exactly

Examples:

- `/_site-data/stablecoins` -> `/api/stablecoins`
- `/_site-data/stablecoin/usdt-tether` -> `/api/stablecoin/usdt-tether`
- `/_site-data/supply-history?stablecoin=usdc-circle&days=90` -> `/api/supply-history?stablecoin=usdc-circle&days=90`

Method policy:

- allow `GET` only
- reject all other methods with `405`
- return `Allow: GET`

### Route metadata source of truth

Do not scatter route policy across the Pages Function, worker gates, and smoke scripts.

Implementation rule:

- `shared/lib/site-data-routes.ts` is the single source of truth for the website allowlist and path matching
- shared endpoint metadata must also carry the public API auth policy so worker gating is not a hand-maintained hostname/path switchboard

Minimum shared policy flags required by implementation:

- website data lane: `allowed` or `denied`
- external public API lane: `protected` or `exempt`

Default policy:

- public JSON endpoints on `api.pharos.watch` are protected unless explicitly exempted
- `/_site-data/*` is denied unless explicitly allowlisted

### Website data allowlist

This should be explicit and shared, not ad hoc inside the function.

**V1 allowlist derived from actual public-site usage today:**

- `/api/stablecoins`
- `/api/stablecoin/:id`
- `/api/stablecoin-reserves/:id`
- `/api/stablecoin-charts`
- `/api/peg-summary`
- `/api/health`
- `/api/blacklist`
- `/api/blacklist-summary`
- `/api/depeg-events`
- `/api/usds-status`
- `/api/bluechip-ratings`
- `/api/dex-liquidity`
- `/api/dex-liquidity-history`
- `/api/supply-history`
- `/api/daily-digest`
- `/api/digest-archive`
- `/api/digest-snapshot`
- `/api/yield-rankings`
- `/api/yield-history`
- `/api/safety-score-history`
- `/api/stability-index`
- `/api/report-cards`
- `/api/redemption-backstops`
- `/api/treasury-stable-exposure`
- `/api/mint-burn-flows`
- `/api/mint-burn-events`
- `/api/stress-signals`
- `/api/chains`
- `/api/non-usd-share`

**Deliberately omitted in v1 because the public host does not currently use them:**

- `/api/stablecoin-summary/:id`
- all admin/status routes
- `/api/feedback`
- `/api/telegram-webhook`
- `/api/og/*`

### Site-proxy auth contract

Worker-only trusted website lane:

- host: `site-api.pharos.watch`
- request header: `X-Pharos-Site-Proxy-Secret: <secret>`
- env source:
  - Worker secret: `SITE_API_SHARED_SECRET`
  - Pages Functions secret: `SITE_API_SHARED_SECRET`

Rules:

- Worker accepts the header on:
  - `site-api.pharos.watch`
  - Worker preview URLs on `*.workers.dev` used by CI/site-data rehearsal
- Worker never accepts the site-proxy secret as a bypass on:
  - `api.pharos.watch`
  - `ops-api.pharos.watch`
- on Worker preview URLs, a valid site-proxy secret only unlocks the website allowlist; all other requests still follow preview public-API gate rules
- Worker rejects missing/invalid secret before cache lookup
- Worker rejects non-allowlisted paths on the site-api host even with a valid secret
- Pages Functions never forward the header back to the browser
- Pages Functions must configure this as an encrypted secret, not a plain-text Pages environment variable
- the preview-URL exception exists only because CI rehearses candidate Worker versions before promotion; production traffic must never depend on it

### External API key contract

Canonical client header:

- `X-API-Key: <token>`

Token format:

```text
ph_live_<prefix>_<secret>
```

Canonical generation:

- `prefix`: 8 random bytes encoded as 16 lowercase hex characters
- `secret`: 24 random bytes encoded as unpadded base64url
- token parsing is exact and case-sensitive

Storage model:

- `key_prefix` unique indexed lookup key
- `secret_hash` stored as `HMAC_SHA256(API_KEY_HASH_PEPPER, secret)`
- no plaintext key storage
- create/rotate responses return the full token once; list/read responses return only masked metadata

Why HMAC-SHA256 is enough here:

- API key secrets are high-entropy random values, not human passwords
- the Worker runtime already exposes Web Crypto primitives cleanly
- a server-side pepper adds protection if the D1 table leaks

Rotation behavior:

- rotation generates a new prefix and secret
- rotation replaces the stored `key_prefix` and `secret_hash` for the existing key row in place
- rotation clears `last_used_at` and `last_used_route`
- the old token stops working immediately after the rotated row is written

### Public API gate scope

Protected on `api.pharos.watch` once enforcement is enabled:

- all public JSON read endpoints except explicit exemptions

Initial exemptions:

- `GET /api/health`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/telegram-webhook`
- existing admin ops lanes on `ops-api.pharos.watch`

Build/CI consumers like digest sync and smoke tests must use an API key. Do **not** exempt `GET /api/digest-archive` just to keep CI working.

### API auth mode flag

Add optional Worker env:

- `PUBLIC_API_AUTH_MODE=off|report-only|enforce`

Semantics:

- `off`: API keys parsed but not required
- `report-only`: missing/invalid key is logged/telemetry-only, request still allowed
- `enforce`: protected routes require a valid key

Use this as the rollout control. Do not hard-wire enforcement directly in code on the first shipping PR.

## D1 Schema Plan

Use additive backward-compatible migrations only.

### Migration `0083_api_keys.sql`

Create `api_keys`:

- `id INTEGER PRIMARY KEY`
- `key_prefix TEXT NOT NULL UNIQUE`
- `secret_hash TEXT NOT NULL`
- `name TEXT NOT NULL`
- `owner_email TEXT`
- `tier TEXT NOT NULL DEFAULT 'default'`
- `rate_limit_per_minute INTEGER NOT NULL`
- `is_active INTEGER NOT NULL DEFAULT 1`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `last_used_at INTEGER`
- `last_used_route TEXT`

Indexes:

- unique `key_prefix`
- `is_active, created_at`

### Migration `0084_api_key_rate_limit.sql`

Create `api_key_rate_limit`:

- `api_key_id INTEGER NOT NULL`
- `bucket_start INTEGER NOT NULL`
- `count INTEGER NOT NULL`
- `last_seen_at INTEGER NOT NULL`
- primary/unique key on `(api_key_id, bucket_start)`

Index:

- `bucket_start`

Notes:

- reuse the current D1-backed minute-bucket model
- do not add a per-request usage/audit table in v1
- `last_used_at` should be best-effort throttled, not written on every request
- keyed protected routes bypass the legacy public IP limiter after key validation and use the per-key limiter only
- exempt public routes keep the existing public IP limiter

## Code Changes By Phase

### Phase 1: Build the website-internal lane with frontend unchanged

**Outcome:** `/_site-data/*` and `site-api.pharos.watch` are live, tested, and unused by production UI.

#### Worker

Files:

- `worker/wrangler.toml`
- `worker/src/lib/env.ts`
- `worker/src/lib/auth.ts` or new `worker/src/lib/site-proxy-auth.ts`
- `worker/src/handlers/http/gates.ts`
- `worker/src/handlers/http/request-dispatch.ts`
- `worker/src/handlers/http/request-source.ts`
- `shared/lib/runtime-origins.json`
- `shared/lib/runtime-origins.ts`
- new shared route helper: `shared/lib/site-data-routes.ts`

Work:

- add `site-api.pharos.watch` as a Worker custom-domain route
- add Worker env support for:
  - `SITE_API_SHARED_SECRET`
  - `PUBLIC_API_AUTH_MODE`
  - `API_KEY_HASH_PEPPER` as reserved for later Phase 3
- add Worker secret validation through Wrangler `secrets.required` only for secrets that are actually required in that phase
- add host helpers for `SITE_API_ORIGIN` / `SITE_API_HOSTNAME`
- implement `hasValidSiteProxyCredential(request, env)`
- update `evaluateAccessGate()` to:
  - recognize site-api host
  - require valid site-proxy secret there
  - accept the same secret on preview hosts only when the hostname ends with `.workers.dev`, so Pages/preview rehearsal can target uploaded candidates
  - never treat the same secret as valid on `api.pharos.watch`
  - allow only the shared website route allowlist there
  - bypass public IP limiter there
  - on preview hosts, apply public API auth-mode logic to requests that do not qualify for the preview site-proxy lane
  - keep request-source telemetry scoped to `api.pharos.watch` only

#### Pages Functions

Files:

- new `functions/_site-data/[[path]].ts`
- new `functions/lib/site-proxy-env.ts`
- new `functions/lib/site-origin.ts`

Work:

- add same-origin Pages Function proxy under `/_site-data/*`
- allow only `GET`
- allow only the shared website route allowlist
- require request URL hostname to be:
  - `pharos.watch`
  - `*.stablecoin-dashboard.pages.dev`
- add a dedicated narrow host helper for the public-site Pages surface; do not reuse `isCanonicalSiteHostname()` directly
- validate hostname, method, and allowlisted path before any cache lookup
- forward only narrow request headers upstream:
  - `Accept`
  - no browser auth headers
- inject `X-Pharos-Site-Proxy-Secret` from Pages secret binding
- reflect only narrow response headers back:
  - `Allow`
  - `Cache-Control`
  - `Content-Type`
  - `Warning`
  - `X-Data-Age`
- preserve query strings exactly
- use an explicit upstream timeout of `10_000 ms` unless there is a stronger reason to diverge
- translate upstream timeout/fetch failures into explicit `502`/`504`

#### Pages edge cache

The Pages Function must also cache on `pharos.watch` using `caches.default`.

Rules:

- cache key = public request URL including query string
- cache only cacheable `GET` + `200` responses
- skip cache writes when upstream returns `Cache-Control: no-store`
- skip cache writes when upstream returns `Set-Cookie`
- cache the upstream response clone before per-request header decoration
- never cache the site-proxy secret or any request-specific auth data
- preserve `Cache-Control` / `Warning` / `X-Data-Age`
- do not assume Pages cache entries are shared with the Worker cache on `site-api.pharos.watch`
- do not rely on tiered caching or POP pre-warming; Cache API entries are per-data-center

#### Local smoke parity

Files:

- `scripts/serve-static-export.mjs`

Work:

- teach the local smoke server to proxy `/_site-data/*`
- drive that proxy through the same shared site-data route mapping module
- allow env overrides:
  - `STATIC_EXPORT_SITE_API_BASE`
  - `STATIC_EXPORT_SITE_API_SHARED_SECRET`
- keep existing `/api/*` proxy behavior for the remaining direct API calls like feedback
- use the same secret-backed path when `STATIC_EXPORT_SITE_API_BASE` points at a Worker preview URL
- never attach the site-proxy secret when proxying ordinary `/api/*` requests

#### Tests

Add:

- `functions/__tests__/site-data-proxy.test.ts`
- extend `worker/src/__tests__/index.fetch.test.ts`
- extend `worker/src/lib/__tests__/auth.test.ts`
- shared route helper tests in `shared/lib/__tests__/site-data-routes.test.ts`

Verify:

- non-allowed host -> `404`
- non-allowlisted path -> `404`
- method mismatch -> `405`
- missing secret on site-api -> `401`
- valid secret on site-api allowed path -> `200`
- preview URL + valid site secret + allowlisted path -> `200`
- preview URL + protected path without API key follows current public auth-mode behavior
- request-source stats are not written for site-api traffic

#### Cloudflare setup

Before merging frontend cutover work:

1. Add custom domain `site-api.pharos.watch` to the Worker.
2. Set Worker secret `SITE_API_SHARED_SECRET` using the dashboard or `wrangler versions secret put`, not `wrangler secret put`.
3. Set Pages secret `SITE_API_SHARED_SECRET` as an encrypted secret in the dashboard before the first deployment that uses `/_site-data/*`.
4. If preview Pages deployments need the new proxy, set the Pages secret in both Preview and Production environments.
5. If Pages Functions need an origin override, set `SITE_API_ORIGIN`; otherwise use the shared default from `runtime-origins`.
6. Deploy a new Pages build after any new Pages binding/secret change that the proxy depends on.
7. Keep `preview_urls = true` enabled on the Worker because preview-smoke rehearsal depends on it.
8. Do not add a root Pages Wrangler config during this rollout; keep Pages bindings/secrets dashboard-managed.
9. Remember that the custom domain attaches the Worker to all paths on `site-api.pharos.watch`; the allowlist remains a code-enforced responsibility.

#### Phase 1 verification

- direct browser GET to `https://pharos.watch/_site-data/stablecoins` returns `200`
- direct anonymous GET to `https://site-api.pharos.watch/api/stablecoins` returns `401`
- secret-backed GET to `https://site-api.pharos.watch/api/stablecoins` returns `200`
- existing website still uses `api.pharos.watch` and remains unaffected

### Phase 2: Cut the website over to same-origin `/_site-data/*`

**Outcome:** production website data no longer depends on direct browser GETs to `api.pharos.watch`.

#### Frontend API client

Files:

- `src/lib/api.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`
- `next.config.ts`

Work:

- change public-site browser GET resolution from `https://api.pharos.watch/api/*` to same-origin `/_site-data/*` when no explicit local API override is configured
- keep admin paths untouched:
  - `/api/admin/*` still same-origin ops proxy
- keep explicit direct API helpers only where intended:
  - feedback
  - OG image metadata URLs
- remove the Pharos Accept marker from any auth decision; it may remain as telemetry until no longer needed

Implementation rule:

- public website data helpers should no longer construct cross-origin GET URLs to `api.pharos.watch` on production/preview website hosts
- when `NEXT_PUBLIC_API_BASE` is set, public website data helpers may continue to target `${NEXT_PUBLIC_API_BASE}/api/*` directly for local `next dev` against `wrangler dev`
- only explicit exemptions should still target the external API host

#### Dev ergonomics

Files:

- `next.config.ts`
- `README.md`

Work:

- keep `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8787 npm run dev` as the documented steady-state local-dev path
- do not make anonymous browser rewrites to production `api.pharos.watch` a required final-state dependency
- if a temporary convenience rewrite is introduced before enforcement, it must be removed or gated off before Phase 5

#### Browser smoke hardening

Files:

- `scripts/smoke-ui.mjs`

Work:

- record network requests during the live/local canary routes
- fail if public-site pages emit direct GET requests to `https://api.pharos.watch/api/*`
- allow only:
  - `POST /api/feedback`
  - `GET /api/og/*` metadata URLs if they appear in page HTML

This is the key automatic proof that the website is truly off the direct API host before enforcement.

#### Optional direct site-data smoke

Preferred addition:

- new `scripts/smoke-site-data.mjs`

Checks:

- `/_site-data/stablecoins`
- `/_site-data/peg-summary`
- `/_site-data/report-cards`
- one dynamic detail/history path

Run it:

- in `pages-prepare` against the local static smoke server
- in `pages-publish` against `https://pharos.watch`

#### Phase 2 verification

- live `smoke-ui` passes
- live `smoke-site-data` passes
- request capture shows site pages use `/_site-data/*`
- no direct public-site GETs to `api.pharos.watch` remain
- request-source stats on `api.pharos.watch` show website share falling toward zero apart from explicit exemptions

### Phase 3: Add API key infrastructure with enforcement still off

**Outcome:** the public API understands API keys, the admin surface can manage them, and nothing is blocked yet.

#### D1 + Worker auth

Files:

- `worker/migrations/0083_api_keys.sql`
- `worker/migrations/0084_api_key_rate_limit.sql`
- `worker/src/lib/env.ts`
- new `worker/src/lib/api-keys.ts`
- possibly genericize `worker/src/lib/rate-limit.ts`
- `worker/src/handlers/http/gates.ts`

Work:

- parse `X-API-Key`
- validate token structure
- look up by prefix
- compute `HMAC_SHA256(API_KEY_HASH_PEPPER, secret)`
- timing-safe compare
- reject inactive keys
- add small in-isolate prefix cache for active key metadata
- add D1-backed per-key minute-bucket limiter
- throttle `last_used_at` updates so they happen at most once per key per small window
- on protected routes with a valid API key, bypass the legacy public IP limiter and apply only the per-key limiter
- on exempt public routes, retain the existing public IP limiter

#### Shared endpoint/admin routing

Files:

- `shared/lib/api-endpoints.ts`
- `worker/src/route-registry.ts`
- new Worker handlers for API key admin routes

Admin route family:

- `GET /api/api-keys`
- `POST /api/api-keys`
- `POST /api/api-keys/:id/update`
- `POST /api/api-keys/:id/deactivate`
- `POST /api/api-keys/:id/rotate`

Rules:

- stay on `/api/*`, not `/api/admin/*`
- ops Pages proxy exposes them as `/api/admin/*` automatically
- use existing GET/POST-only endpoint contract
- `POST /api/api-keys` creates a new row and returns the raw token once
- `POST /api/api-keys/:id/update` updates mutable metadata only (`name`, `owner_email`, `tier`, `rate_limit_per_minute`, `is_active` if kept mutable there)
- `POST /api/api-keys/:id/deactivate` only flips `is_active = 0`; it does not delete the row
- `POST /api/api-keys/:id/rotate` rotates the existing row in place and returns the replacement raw token once

#### Admin UI

Files:

- `src/app/admin/client.tsx`
- new small components under `src/components/status/` or `src/components/admin/`

Scope:

- list keys
- create key and show one-time token
- deactivate key
- rotate key and show one-time replacement token
- update name/tier/rate limit

Do not overbuild this UI in v1.

#### Tests

Add:

- `worker/src/lib/__tests__/api-keys.test.ts`
- extend `worker/src/__tests__/index.fetch.test.ts`
- extend `worker/src/api/__tests__/router-contract.test.ts`
- admin proxy tests for the new routes if needed

Verify:

- malformed token -> `401`
- unknown prefix -> `401`
- inactive key -> `401`
- valid key on protected path in `off` mode -> still `200`
- valid key on protected path in `report-only` mode -> `200`
- per-key rate limiting returns `429`
- admin create returns masked metadata + one-time raw token only on create/rotate

### Phase 4: Update CI/build/smoke consumers to use API keys

**Outcome:** everything outside the website that legitimately depends on `api.pharos.watch` is key-ready before enforcement.

#### Smoke API

Files:

- `scripts/smoke-api.mjs`
- `.github/workflows/deploy-cloudflare.yml`
- `package.json`
- `scripts/lib/deploy-impact.mjs`

Work:

- add optional `X-API-Key` support via env:
  - `SMOKE_API_KEY`
- use it for preview smoke and post-promotion smoke once protected paths are gated
- preview smoke must hit a protected path so the candidate gate is actually exercised
- add the same support to any new site-data preview smoke that targets Worker preview URLs

#### Digest sync during Pages build

Files:

- `scripts/sync-digests.ts`
- `.github/workflows/pages-prepare.yml`
- `.github/workflows/pages-publish.yml`
- `package.json`
- `scripts/lib/deploy-impact.mjs`

Work:

- add optional `DIGEST_API_KEY`
- send `X-API-Key` when fetching `/api/digest-archive`
- configure a dedicated CI read key for Pages build/digest sync
- if `smoke-site-data` is added, wire it into the Pages prepare/publish path and mark the new script as Pages-impacting in deploy classification
- if Pages prepare uses a Worker preview URL for rehearsal, continue sending `DIGEST_API_KEY` there so preview behavior matches post-enforcement production behavior

#### Secrets / vars

Repository or Cloudflare secret inventory needed before enforcement:

- `SMOKE_API_KEY`
- `DIGEST_API_KEY`
- `SITE_API_SHARED_SECRET`
- `API_KEY_HASH_PEPPER`

Recommended practice:

- use a distinct CI read-only API key instead of reusing an operator key
- for Worker secrets added during gradual-deploy rollout, prefer dashboard changes or `wrangler versions secret put` so secrets do not trigger an immediate production deploy outside the normal candidate/promotion flow

#### Phase 4 verification

- worker preview smoke passes with API key
- production `smoke-api` passes with API key
- Pages build digest sync passes with API key
- preview/local site-data smoke passes against the candidate Worker preview URL with `SITE_API_SHARED_SECRET`
- no CI job still assumes anonymous access to protected endpoints

### Phase 5: Enforce the hard gate on `api.pharos.watch`

**Outcome:** protected routes on the external API require a valid API key.

#### Switch

Set:

- `PUBLIC_API_AUTH_MODE=enforce`

Only do this after all of the following are true:

1. Phase 2 is live and browser-smoke verified.
2. Phase 4 CI consumers are key-ready.
3. direct public-site GETs to `api.pharos.watch` are gone.

#### Enforcement behavior

On `api.pharos.watch`:

- protected path + missing key -> `401`
- protected path + invalid key -> `401`
- protected path + valid key -> normal route handling
- exempt path + no key -> current public behavior

On `site-api.pharos.watch`:

- valid site secret + allowlisted path -> normal route handling
- everything else -> `401` or `404` per policy above

#### Phase 5 verification

- `curl https://api.pharos.watch/api/stablecoins` -> `401`
- `curl -H 'X-API-Key: <valid>' https://api.pharos.watch/api/stablecoins` -> `200`
- live website smoke still passes
- `https://pharos.watch/_site-data/stablecoins` still returns `200`

## Testing And Validation Matrix

Run these at the appropriate phases, not only at the end.

### Repo validation

Always:

```bash
npm run lint
npm run typecheck
npm test
cd worker && npx tsc --noEmit
npm run check:migrations
```

Before push:

```bash
npm run test:merge-gate
```

### New targeted test lanes

Add or extend:

- `functions/__tests__/site-data-proxy.test.ts`
- `shared/lib/__tests__/site-data-routes.test.ts`
- `worker/src/lib/__tests__/api-keys.test.ts`
- `worker/src/__tests__/index.fetch.test.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`
- `scripts/__tests__/serve-static-export.test.ts`
- `scripts/__tests__/smoke-api.test.ts` if smoke headers/auth branching becomes non-trivial

### Smoke stages

Local artifact smoke:

- `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local`
- `npm run test:smoke-site-data -- --base-url http://127.0.0.1:4173`

Preview/prod worker smoke:

- `npm run test:smoke-api -- --base-url <preview-or-prod>`

Live site smoke:

- `npm run test:smoke-ui -- --url https://pharos.watch --mode live`
- `npm run test:smoke-site-data -- --base-url https://pharos.watch`

Ops smoke remains unchanged:

- `npm run test:smoke-ops`

## Rollback Plan

### Fast rollback options

1. **Gate rollback**
   - set `PUBLIC_API_AUTH_MODE=off`
   - this is the fastest way to recover if enforcement breaks a consumer unexpectedly

2. **Pages rollback**
   - rollback the Pages deployment if the frontend cutover to `/_site-data/*` is broken

3. **Worker rollback**
   - use the existing Worker version rollback path if a Worker deploy regresses the site-api or API-key logic

### Rollback order by failure type

- Website broken after frontend cutover:
  - rollback Pages first
  - leave the dormant `/_site-data` lane in place

- API consumers broken after enforcement:
  - set `PUBLIC_API_AUTH_MODE=off`
  - diagnose before re-enabling

- Site-api auth/proxy broken before frontend cutover:
  - fix forward; the production website is still on the old path, so there is no downtime risk yet

## Docs To Update During Execution

When the corresponding phase lands, update:

- `README.md`
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`
- `docs/deployment-process.md`
- `docs/worker-and-api-limits.md`
- `docs/scripts.md`
- `docs/operator-origin-access.md` only if ops docs need cross-reference clarification

Add a dedicated doc for the website data surface if the implementation introduces enough contract/process detail to justify it.

## Explicitly Deferred

Not part of the first hard-gate rollout:

- moving the website lane to a private service-bound worker
- per-key response rate-limit headers
- API-key analytics beyond the current `external` attribution bucket
- monetization/billing logic
- multiple API products/scopes beyond a basic tier/rate-limit model

## Recommended PR Sequence

1. PR-A: site-api host + `/_site-data/*` proxy + local smoke support, frontend unchanged
2. PR-B: frontend cutover to `/_site-data/*` + browser network assertions
3. PR-C: API key schema/auth/admin UI, `PUBLIC_API_AUTH_MODE=off`
4. PR-D: CI/build/smoke key support
5. PR-E: flip `PUBLIC_API_AUTH_MODE=enforce` after bake period and live verification

This order minimizes the blast radius of each deploy and keeps the website recoverable at every step.

## Cloudflare Research Appendix

These are the Cloudflare docs this plan is intentionally grounded in. Re-check them if Cloudflare product behavior changes, but do not re-open settled design questions during execution unless these docs materially change.

- Workers Cache API
  - https://developers.cloudflare.com/workers/runtime-apis/cache/
  - Confirms: Cache API is available on custom-domain Workers and Pages Functions; unavailable behind Cloudflare Access; entries are per-data-center; `cache.put()` is not tiered; `cache.put()` respects `Cache-Control`; responses with `Set-Cookie` are not cached; `cache.put()` errors on non-cacheable responses.
- Pages Functions bindings
  - https://developers.cloudflare.com/pages/functions/bindings/
  - Confirms: Service bindings exist; new bindings require redeploy; Pages environment variables are plain text; Pages secrets are encrypted; secrets must be configured before the deployment that uses them.
- Pages Wrangler configuration
  - https://developers.cloudflare.com/pages/functions/wrangler-configuration/
  - Confirms: once used for Pages project config, the Wrangler file becomes the project source of truth; adding `pages_build_output_dir` promotes a local config into deploy-time config; omitting that key keeps the file local-dev only.
- Pages local development for service bindings
  - https://developers.cloudflare.com/pages/functions/local-development/
  - https://developers.cloudflare.com/pages/functions/bindings/
  - Confirms: local Pages + Worker service-binding development requires either parallel `wrangler dev` processes or multi-config `wrangler pages dev -c ... -c ...`; the multi-config path is experimental.
- Workers preview URLs
  - https://developers.cloudflare.com/workers/configuration/previews/
  - Confirms: preview URLs are public when enabled, use `*.workers.dev`, can be toggled in Wrangler via `preview_urls = true`, and are suitable for CI/CD preview environments.
- Workers secrets
  - https://developers.cloudflare.com/workers/configuration/secrets/
  - https://developers.cloudflare.com/workers/wrangler/configuration/
  - Confirms: `wrangler secret put` deploys immediately; `wrangler versions secret put` only creates a new version for later promotion; `secrets.required` can fail deploys early when required secrets are missing.
- Workers custom domains
  - https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  - Confirms: a Worker custom domain points all paths on that hostname to the Worker, so `site-api.pharos.watch` path restriction must be enforced in code.
