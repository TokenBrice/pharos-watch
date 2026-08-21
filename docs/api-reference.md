# Pharos API Reference

The Pharos API is a REST API served by a Cloudflare Worker backed by a D1 database. It powers the [pharos.watch](https://pharos.watch) stablecoin analytics dashboard through a split website-data lane plus an external integration API. On `https://api.pharos.watch`, all public routes are API-key protected unless this reference explicitly marks them as exempt.

**Base URL:** `https://api.pharos.watch`

Unless noted otherwise, responses are `Content-Type: application/json`. Exceptions: `GET /api/og/*` returns `image/png` for known image routes, and `POST /api/telegram-webhook` returns a plain-text `ok` body. CORS headers are added to every response, but `Access-Control-Allow-Origin` is restricted by the Worker `CORS_ORIGIN` allowlist (production repo config: `https://pharos.watch,https://ops.pharos.watch`). When the request `Origin` matches an allowlisted entry, the Worker echoes that origin and sets `Vary: Origin`; when a request includes a foreign `Origin`, the worker omits `Access-Control-Allow-Origin`, and `OPTIONS` preflights from foreign origins receive `403`. Requests without an `Origin` header keep the existing first-allowlisted-origin fallback. Non-exempt `/api/*` requests on `api.pharos.watch` require a valid `X-API-Key`; missing or invalid keys return `401 Unauthorized`. Per-key rate-limit overages return `429`, and cold auth/limiter dependency failures can still return `503`.

> **Agent navigation** — this reference is intentionally large; never read it wholesale. Grep the heading you need: Surface Split · Public API Auth · Stablecoin IDs · Response Headers · Response Body Freshness (`_meta`) · Cache-Control Profiles · Polling Guidance · Rate Limits · Error Response Conventions · Method Gating Policy · Admin Auth And Idempotency · Public Endpoints (the generated quick-reference table lists every route) · Pages Function endpoints · Admin Endpoints. For one route, grep its path (e.g. `/api/stablecoins`).

## Surface Split

The runtime now uses three HTTP lanes:

- `https://api.pharos.watch` is the external integration API. Protected public routes require `X-API-Key`.
- `https://site-api.pharos.watch` is the website-internal Worker host. It accepts only allowlisted `GET` reads plus `X-Pharos-Site-Proxy-Secret`.
- `/_site-data/*` is the same-origin Pages Functions proxy used by browsers on `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev`.

Static dataset exports are served from the public website, not from the Worker API, and do not require `X-API-Key`. The Stablecoin Cemetery export is available as JSON at `https://pharos.watch/datasets/stablecoin-cemetery.json` and CSV at `https://pharos.watch/datasets/stablecoin-cemetery.csv`.

Machine-readable integration artifacts are also served from the public website for onboarding. The OpenAPI endpoint catalogue is available at `https://pharos.watch/openapi.json`, and Postman artifacts are available at `https://pharos.watch/postman/pharos-api.postman_collection.json` plus `https://pharos.watch/postman/pharos-api.postman_environment.json`. Import both Postman files, then replace the environment `apiKey` placeholder with a real `X-API-Key`. The generated OpenAPI artifact includes named schemas for the richer Yield Intelligence ranking and history payloads, and the Postman collection includes both best-source and source-key yield-history examples. These are public integration/read onboarding artifacts, not a complete dump of every no-key route; they intentionally exclude Cloudflare-Access-gated admin routes, self-serve key issuance POST endpoints, feedback submission, Telegram webhook ingestion, Telegram Mini App endpoints, and dynamic OG image routes. Request keys through `https://pharos.watch/api/`.

Browser consumers should use same-origin `/_site-data/*` via the frontend helpers in `src/lib/api.ts`. In production, that Pages proxy targets `https://site-api.pharos.watch` through `SITE_API_ORIGIN`. Direct integrations and CI smoke should target `https://api.pharos.watch` and send `X-API-Key` for protected public reads, including `/api/telegram-pulse`; production Pages build-input syncs instead read allowlisted `GET` endpoints through `https://stablecoin-dashboard.pages.dev/_site-data/*` with an allowed site caller header. Each sync command rejects missing or invalid input; the Pages release catches a failed refresh, restores that committed snapshot, and continues the build with a warning.

Production Pages does not proxy public self-serve `/api/*` POST requests. The public form at `https://pharos.watch/api/` calls `https://api.pharos.watch/api/api-key-requests` and `https://api.pharos.watch/api/api-key-requests/verify` with normal CORS preflights for JSON `POST` requests.

Self-serve API-key request honeypot submissions are intentionally no-op accepted: `POST /api/api-key-requests` returns `200 { "ok": true }` when the optional `website` field is non-empty, without creating an API-key request or sending email. Normal non-honeypot submissions return `202 Accepted` with `pending_verification`.

The direct Worker cache profiles below describe responses from `api.pharos.watch` / `site-api.pharos.watch`. Pages `/_site-data/*` forwards the upstream cache policy, `Age`, and `Date` without adding a second Cache API lifetime, so it cannot make a nearly expired Worker response fresh again.

## Public API Auth

Unless a route is explicitly called out below as exempt, requests to `https://api.pharos.watch` must send:

- header: `X-API-Key: ph_live_<16 hex prefix>_<32 char base64url secret>`
- example shape: `ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF`

Public, non-admin routes on `https://api.pharos.watch` that do not require `X-API-Key` are limited to:

- `GET /api/health`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/api-key-requests`
- `POST /api/api-key-requests/verify`
- `POST /api/telegram-webhook`
- `POST /api/telegram-mini-app/session`
- `POST /api/telegram-mini-app/mutate`

`POST /api/telegram-webhook` is externally reachable but not anonymous: it requires `X-Telegram-Bot-Api-Secret-Token` instead of `X-API-Key`.

`POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate` are also externally reachable but not anonymous. They require Telegram Mini App `initData` signed for `@PharosWatchBot`; the worker validates the HMAC, `auth_date`, and user payload before any D1-backed state write. These endpoints are denied on the website-internal site-data lane and are intended only for the Mini App at `https://pharos.watch/pharoswatchbot/app/`.

Admin/operator routes are also outside the public API-key gate, but they remain Cloudflare-Access-gated and are supported through `ops-api.pharos.watch` or the `ops.pharos.watch/api/admin/*` Pages proxy. The public API host rejects registered admin paths and configured admin-like root families before API-key auth, so a public API key cannot be used to reach registered admin routes or malformed children of configured roots such as `/api/api-keys*` and `/api/api-key-requests-admin*` on `api.pharos.watch`.

The public self-serve request form lives at `https://pharos.watch/api/`. It sends an email verification link, then exchanges that one-time token for a default key after verification. Default self-serve keys are `tier="self-serve"`, `trafficClass="external"`, limited to `30` requests per minute, expire after `60` days, and allow one active/pending self-serve claim per normalized email. Request details are available only in the private `ops.pharos.watch/admin-api/` UI.

The worker stores only the key prefix plus a peppered HMAC of the secret portion. Admin callers create, rotate, and deactivate keys through the operator lane (`ops.pharos.watch` / `ops-api.pharos.watch`); plaintext tokens are returned only once at creation/rotation time. Self-serve issuance uses the same storage model and returns the plaintext token only once after verification.

For protected cacheable `GET` routes, the worker keeps a bounded isolate-local verified-key cache and a bounded isolate-local limiter. A recently verified non-self-serve key can use that local path for hot edge-cache hits, and can continue to read cached routes during a brief D1 auth/limiter outage. Self-serve, unknown, stale-cache, or not-yet-verified keys still fail closed.

---

## Stablecoin IDs

Most endpoints use the Pharos stablecoin ID in `ticker-issuer` format (e.g. `usdt-tether`). IDs are checked through the shared stablecoin-ID registry (`shared/lib/stablecoin-id-registry.ts`). Unknown or non-canonical IDs return `404`.

Canonical IDs use `ticker-issuer` format — lowercase ticker symbol hyphenated with the issuer/protocol name:

| Example             | Asset           |
| ------------------- | --------------- |
| `"usdt-tether"`     | Tether (USDT)   |
| `"usdc-circle"`     | USD Coin (USDC) |
| `"paxg-paxos"`      | PAX Gold (PAXG) |
| `"ustb-superstate"` | Superstate USTB |
| `"gyen-gyen"`       | GYEN            |

The full list is exported from `shared/lib/stablecoins/registry.ts`, with editable per-coin metadata stored in `shared/data/stablecoins/coins/*.json`, the checked-in generated aggregate at `shared/data/stablecoins/coins.generated.json`, and validation in `shared/lib/stablecoins/schema.ts`. The API accepts canonical IDs only. Non-canonical stablecoin detail URLs and legacy frontend route aliases are retired and unsupported.

---

## Response Headers

Endpoints backed by the cron cache include these additional headers:

| Header       | Description                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Data-Age` | Seconds elapsed since the cron last wrote this data to D1                                                                                                               |
| `Warning`    | Freshness warning (`110`) when cached data is older than the generic freshness runway, plus endpoint-specific advisory warnings (`199`) on a few compute-on-read routes |

Generic freshness status is `fresh` through `8x maxAge`, `degraded` through `12x maxAge`, then `stale`. Generic freshness headers emit `Warning` and downgrade `Cache-Control` to `no-store` after `age > 8x maxAge` so edge/browser caches do not keep serving an old payload after the underlying cron data recovers. Some routes also use `Warning` for dependency or quality advisories even when the age is still inside that runway; clients should treat body `_meta.status` as authoritative when it exists.

---

## Response Body Freshness (`_meta`)

Endpoints that emit `_meta` into plain-object (non-array) response bodies do so through `createCacheHandler()` or route-specific manual injection, alongside the HTTP freshness headers above. This provides inline freshness metadata for consumers that prefer not to parse response headers.

**Shape:**

```json
{
  "_meta": {
    "updatedAt": 1710500000,
    "ageSeconds": 42,
    "status": "fresh"
  }
}
```

| Field        | Type     | Description                                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `updatedAt`  | `number` | Unix epoch seconds when the cron last wrote this data to D1                                 |
| `ageSeconds` | `number` | `floor(now / 1000) - updatedAt`                                                             |
| `status`     | `string` | `"fresh"` (age/max <= 8.0), `"degraded"` (8.0 < ratio <= 12.0), or `"stale"` (ratio > 12.0) |

Route-specific manual `_meta` injectors can be stricter. `GET /api/chains` uses its 1800-second budget directly (`fresh <= 1x`, `degraded <= 2x`, then `stale`) and switches its response to `no-store` whenever the chain snapshot is not fresh.

**Endpoints with `_meta`:**

| Endpoint                         | Max Age (sec) | Source                                       |
| -------------------------------- | ------------- | -------------------------------------------- |
| `GET /api/stablecoins`           | 600           | `createCacheHandler`                         |
| `GET /api/chains`                | 1800          | `worker/src/api/chains.ts`                   |
| `GET /api/events`                | 600           | `worker/src/api/events.ts`                   |
| `GET /api/bluechip-ratings`      | 43200         | `createCacheHandler`                         |
| `GET /api/usds-status`           | 86400         | `createCacheHandler`                         |
| `GET /api/yield-rankings`        | 3600          | Manual injection after live safety hydration |
| `GET /api/depeg-resolver`        | 900           | `worker/src/api/depeg-resolver.ts`           |
| `GET /api/depeg-resolver-review` | 900           | `worker/src/api/depeg-resolver-review.ts`    |

Array-typed responses (e.g., endpoints returning a JSON array at the top level) do not include `_meta`. They receive `X-Data-Age` / `Warning` only when their handler wires freshness metadata explicitly. Supply history, safety score history, and non-USD share are explicit history-endpoint exceptions that emit freshness headers; DEX liquidity history currently exposes cache headers but no freshness headers.

The frontend `apiFetchWithMeta()` helper (in `src/lib/api.ts`) reads `_meta` from the response body when present, falling back to the `X-Data-Age` header for endpoints that do not include it.

---

## Cache-Control Profiles

These profiles apply while the dataset is within its generic freshness runway. Once a cache-backed response exceeds `8x` its endpoint max age, the worker overrides that response to `Cache-Control: no-store` until a fresh response is generated.

All rows below are members of the centralized `API_CACHE_PROFILES` map (`shared/lib/api-cache-profiles.ts`) except `immutable-snapshot`, which is a route-local constant (`IMMUTABLE_CACHE_CONTROL` in `worker/src/api/snapshot.ts`) reused for the immutable public-snapshot routes.

| Profile            | `Cache-Control`                                                | Used by                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| realtime           | `public, s-maxage=60, max-age=10`                              | health, events                                                                                                                                                                                                                                                                                                                                                                                      |
| producer-backed    | `public, s-maxage=300, max-age=60, stale-while-revalidate=300` | stablecoins, stablecoin-summary, blacklist, blacklist-summary, depeg-events, peg-summary, mint-burn-events, chains (cron-published payloads with 15-30 min producers)                                                                                                                                                                                                                               |
| standard           | `public, s-maxage=300, max-age=60`                             | stablecoin-charts, depeg-resolver, depeg-resolver-review, redemption-backstops, usds-status, daily-digest, digest-archive, stability-index, yield-rankings, yield-adapter-manifest, mint-burn-flows, stress-signals. `/api/report-cards/v9` uses this profile only for a current handler response, uses `no-store` while held, and always bypasses the edge cache. |
| custom             | `public, s-maxage=300, max-age=300`                            | dex-liquidity (browser-side max-age extended to match CDN TTL); telegram-pulse uses route-local `public, max-age=300, s-maxage=300`                                                                                                                                                                                                                                                                 |
| per-coin           | `public, s-maxage=300, max-age=10`                             | stablecoin/:id (cache-aside with 5-min per-coin TTL in D1)                                                                                                                                                                                                                                                                                                                                          |
| slow               | `public, s-maxage=3600, max-age=300`                           | supply-history, dex-liquidity-history, bluechip-ratings, yield-history, safety-score-history, non-usd-share                                                                                                                                                                                                                                                                                         |
| archive            | `public, s-maxage=86400, max-age=3600`                         | digest-snapshot, snapshots-index                                                                                                                                                                                                                                                                                                                                                                    |
| immutable-snapshot | `public, s-maxage=31536000, max-age=31536000, immutable`       | snapshots/:date.json, snapshot/:date/stablecoin/:id                                                                                                                                                                                                                                                                                                                                                 |
| public-status      | `public, max-age=60`                                           | public-status-history                                                                                                                                                                                                                                                                                                                                                                               |
| og-image           | `public, max-age=900, s-maxage=900`                            | dynamic Open Graph images, including rendered safety-score degraded states that remain explicitly marked with degraded metadata headers                                                                                                                                                                                                                                                              |
| reserve-live       | `public, s-maxage=3600, max-age=300`                           | stablecoin-reserves live mode                                                                                                                                                                                                                                                                                                                                                                       |
| reserve-live-stale | `public, s-maxage=1800, max-age=120`                           | stablecoin-reserves live-stale mode                                                                                                                                                                                                                                                                                                                                                                 |
| reserve-fallback   | `public, s-maxage=300, max-age=60`                             | stablecoin-reserves curated/template/unavailable fallback modes                                                                                                                                                                                                                                                                                                                                     |
| no-store           | `no-store`                                                     | admin GET routes via the router override or admin route wrapper (`status`, `status-history`, `request-source-stats`, API key inventory/audit routes, `admin-action-log`, `debug-sync-state`, `backfill-dews`, `backfill-dews?repair=...&dry-run=true`, `audit-depeg-history?dry-run=true`) |

`POST /api/feedback`, `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, `POST /api/telegram-mini-app/mutate`, and admin POST endpoints bypass edge caching because they are non-GET request paths. The self-serve API-key endpoints and Telegram Mini App endpoints explicitly return no-store responses so verification tokens, plaintext API keys, and per-chat alert state are never cacheable.

---

## Polling Guidance

Recommended minimum polling cadence for external integrations:

| Cache profile      | Minimum poll interval | Notes                                                                  |
| ------------------ | --------------------- | ---------------------------------------------------------------------- |
| realtime           | 60 seconds            | Polling faster usually re-fetches the same edge-cached payload         |
| producer-backed    | 300 seconds           | Backing crons publish every 15-30 min; faster polls hit the edge cache |
| standard           | 300 seconds           | Preferred baseline for most dashboards                                 |
| per-coin           | 300 seconds           | `GET /api/stablecoin/:id` is history-heavy; avoid short loops          |
| slow               | 3600 seconds          | Historical/timeline endpoints should generally be polled hourly        |
| archive            | 86400 seconds         | Historical digest snapshots and public snapshot index listings         |
| immutable-snapshot | On-demand only        | Dated public dataset snapshots are content-addressed and immutable     |
| no-store           | On-demand only        | Admin/control diagnostics; avoid high-frequency polling                |

Client best practices:

- Add interval jitter (`±10%`) to avoid synchronized bursts.
- Read `X-Data-Age` + `Warning` for freshness/stale decisions when those optional headers are present.
- Back off exponentially on `429` and `5xx` responses.

---

## Rate Limits

Public API traffic enforces per-key rate limiting to ensure fair usage. Non-exempt `/api/*` requests require a valid `X-API-Key`; the no-key public exceptions are `GET /api/health`, `GET /api/og/*`, `POST /api/feedback`, `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`. The Telegram webhook is authenticated separately with `X-Telegram-Bot-Api-Secret-Token`; Telegram Mini App endpoints are authenticated with signed Telegram `initData`.

### Per-key limit

| Scope       | Limit                | Window     |
| ----------- | -------------------- | ---------- |
| Per API key | Varies (default 120) | 60 seconds |

Per-key overrides are stored in `api_keys.rate_limit_per_minute`.

Self-serve keys are issued with a fixed default of `30` requests per minute and a `60` day expiry. The request workflow has separate abuse limits: initial submissions are throttled by salted IP hash (`5/hour`) and private email hash (`3/day`), verification attempts are throttled by salted IP hash (`20/10 minutes`) and token hash (`5/10 minutes`), and successful issuance allows one self-serve key creation per salted IP hash per 24 hours.

When the per-key limiter is exceeded, the API returns `429 Too Many Requests`:

```json
{
  "error": "Rate limit exceeded"
}
```

Rate-limited responses include the retry delay in the HTTP `Retry-After` header when the worker can compute one.

`POST /api/feedback` also has a form-specific limiter. Its `429` body is `{ "error": "Too many submissions. Please wait a few minutes." }`, and it should be handled as a local submission throttle rather than as a public API quota response. If the feedback limiter's D1 dependency is unavailable, the endpoint returns `503 Service Unavailable` with `{ "error": "Feedback service temporarily unavailable. Please try again." }` and `Retry-After: 60`.

API-key authentication and per-key limiter storage normally rely on D1. For protected cacheable `GET` edge-cache hits, the worker can serve a recently verified non-self-serve key through a bounded isolate-local auth/limiter path. It can also continue serving a recently verified non-self-serve key during a brief D1 outage by reusing its bounded verified-key cache and isolate-local limiter. Self-serve keys are refused when their D1 lookup is unavailable because revocation and claim state cannot be rechecked from stale isolate cache. Unknown or not-yet-verified keys still fail closed with `503 Service Unavailable`, `{ "error": "Public API temporarily unavailable" }`, and `Retry-After: 60`. Best-effort API-key usage timestamp updates do not fail otherwise successful reads.

### Retry Guidance

- Respect the `Retry-After` header when present
- Add random jitter (0–2 seconds) to avoid thundering-herd retries
- Use exponential backoff for sustained 429 responses
- Combine with the polling cadences in the section above to stay well under limits

## Error Response Conventions

JSON API handlers use `{ "error": "message" }` JSON format. `GET /api/og/*` returns `image/png` on success for known image routes; unknown OG route patterns return the normal JSON error body, while OG data/render failures inside known image routes can return `text/plain`.

| Status | Meaning               | When                                                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Bad Request           | Missing required parameters, invalid enum values, malformed numeric input, or out-of-range numeric/filter values on handlers that opt into rejection (`rangePolicy: "reject"`). Some endpoints intentionally clamp or default selected numeric params; endpoint sections call this out where it is part of the contract.                       |
| 401    | Unauthorized          | Public `/api/*` endpoint called without a valid `X-API-Key`, or admin endpoint called without a valid `ops-api` Access JWT (typically obtained through Cloudflare Access user login or service-token auth)                                                                                                                                     |
| 403    | Forbidden             | Disallowed CORS preflight from a foreign `Origin`, Pages ops proxy mutating request without a matching same-origin `Origin`, or mutating admin request missing `X-Pharos-Admin: 1`                                                                                                                                                             |
| 404    | Not Found             | Unknown stablecoin ID or missing resource                                                                                                                                                                                                                                                                                                      |
| 413    | Payload Too Large     | Public JSON `POST` body exceeds that endpoint's defensive byte cap before parsing or side effects                                                                                                                                                                                                                                              |
| 429    | Too Many Requests     | Rate limit exceeded (per-key public API limiter or feedback-specific limiter; feedback uses its own message body)                                                                                                                                                                                                                              |
| 500    | Internal Server Error | Unhandled exception (caught by `withErrorHandler`)                                                                                                                                                                                                                                                                                             |
| 502    | Bad Gateway           | Upstream fetch failed (external data provider or Pages proxy upstream), or the ops proxy received a Cloudflare Access login redirect from `ops-api`                                                                                                                                                                                            |
| 503    | Service Unavailable   | Cache-passthrough endpoint where cache has never been populated, cached payload is corrupt / rejected by validation, a protected public API request cannot be authenticated from D1 or the recent verified-key cache, the feedback limiter/storage dependency fails, or `MAINTENANCE_MODE=true` (global kill switch via `wrangler secret put`) |
| 504    | Gateway Timeout       | Pages `/_site-data/*` or `/api/admin/*` proxy timed out waiting for its Worker upstream (10 s default; 20 s for ops `/api/status` and `/api/status-history`; 45 s for ops `/api/audit-depeg-history`)                                                                                                                                          |

**Rule:** Cache-passthrough handlers return **503** when data hasn't been populated yet or when the stored cache payload is malformed and rejected at read time. Query handlers that find no matching rows return **200** with empty results (e.g., `{ events: [], total: 0 }`). When `MAINTENANCE_MODE` is set to `"true"`, all non-`OPTIONS` requests immediately return `503` with `{ "error": "maintenance", "message": "..." }` — used during DB migrations. `OPTIONS` CORS preflights are handled before the maintenance gate.

---

## Method Gating Policy

HTTP method allowance is defined centrally in `shared/lib/api-endpoints/` and enforced by `worker/src/router.ts` via `validateRouteMatchMethod()` and `validateAllowedEndpointMethods()`.

- `GET` is accepted for read endpoints (plus admin debug/status endpoints, `GET /api/backfill-dews`, and dry-run repair previews for `GET /api/backfill-dews?repair=...&dry-run=true`).
- `POST` is accepted for mutating admin endpoints, `POST /api/feedback`, `POST /api/api-key-requests`, `POST /api/api-key-requests/verify`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`.
- `GET, POST` is accepted on `/api/api-keys` so operators can list keys and create a new key through the same route.
- `GET` is accepted on `/api/api-keys/lifecycle-summary` for counts-only Triage credential monitoring.
- `POST` is accepted on `/api/api-keys/:id/update`, `/api/api-keys/:id/deactivate`, and `/api/api-keys/:id/rotate`.
- `/api/audit-depeg-history` allows `GET` only with `?dry-run=true`; otherwise it is `POST`-only.
- `/api/backfill-dews` allows `GET` for the historical backtest and for `repair=...&dry-run=true` previews; mutating repair runs are `POST`-only.
- Unknown public `/api/*` requests can return `401` first when the API key is missing or invalid. After lane auth succeeds, unregistered paths return `404` because no route dependencies can be hydrated. Once a static or dynamic route family is registered, known paths with disallowed methods return `405` with `Allow`; unsupported verbs on known endpoint families return `405` with `Allow: GET, POST`.

The same shared endpoint descriptors now also carry static worker dependency-hydration hints consumed by `worker/src/routes/registry.ts`, where the worker binds shared endpoint keys directly to handlers through a single static route-definition list. That keeps endpoint metadata, router behavior, method guards, admin status-page actions, and worker-side static route wiring aligned from one source of truth plus one worker binding table.

## Admin Auth And Idempotency

Admin endpoints are authenticated only on the `ops-api.pharos.watch` host. Cloudflare Access must authenticate the caller first, then inject `Cf-Access-Jwt-Assertion` for the worker. `worker/src/lib/auth.ts` verifies that JWT against the configured Access audience (`CF_ACCESS_OPS_API_AUD`) and team domain (`CF_ACCESS_TEAM_DOMAIN`) via `shared/lib/cloudflare-access-jwt.ts`, including signature, `aud`, `exp`, and `iss` checks. Browser operators should use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access; the Pages proxy verifies the inbound UI Access token against `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_OPS_UI_AUD`, requires an interactive Access token (`type: "app"`), and accepts the token from `Cf-Access-Jwt-Assertion` when Cloudflare forwards it or from the same-origin `cf-access-token` / `CF_Authorization` carrier when the browser is operating off an existing Access session. Mutating requests still require same-origin `Origin`.

Mutating admin calls also require `X-Pharos-Admin: 1` after Cloudflare Access authentication. Browser proxy calls forward that header from the operator UI and additionally require same-origin `Origin`; direct `ops-api` automation must send the header along with the Access service-token credentials.

The website-internal read lane is separate from Cloudflare Access. `site-api.pharos.watch` accepts only allowlisted `GET` public-read paths and requires `X-Pharos-Site-Proxy-Secret`, which the Pages `/_site-data/*` proxy injects server-to-server from `SITE_API_SHARED_SECRET`. All Pages hosts — production and preview — must configure `SITE_API_ORIGIN=https://site-api.pharos.watch` (or a Worker preview URL that accepts the site-data secret); the Pages proxy fails closed with `500` when that binding is missing. The `/_site-data/*` lane additionally accepts requests only when the browser `Origin` header (or `Referer` as a fallback) matches `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, or a subdomain of `stablecoin-dashboard.pages.dev`. Public browser traffic must not call `site-api.pharos.watch` directly.

Many router-dispatched mutating admin endpoints also support optional `Idempotency-Key` handling. Current idempotent routes are:

- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-yield-history`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `POST /api/backfill-tape`
- `POST /api/reclassify-atomic-roundtrips`
- `POST /api/backfill-dews`
- `POST /api/audit-depeg-history`
- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `POST /api/remediate-blacklist-amount-gaps`
- `POST /api/backfill-blacklist-current-balances`
- `POST /api/admin-telegram-broadcast`
- `POST /api/api-key-requests-admin/:requestId/reject`
- `POST /api/api-key-requests-admin/:requestId/release-claim`

When an `Idempotency-Key` is supplied on one of those routes, the worker fingerprints the request and reserves the key with owner/generation fencing before execution. Terminal responses echo `Idempotency-Key` plus `X-Idempotent-Replay`; a stored terminal response is replayed without rerunning the action, while reuse with a different request fingerprint returns `409`. Only an abandoned reservation whose execution never started can be reclaimed after its takeover window.

Once execution has been marked as started, an unconfirmed outcome is never retried automatically. An in-flight duplicate, a handler throw after that point, or a terminal response that cannot be confirmed as persisted returns `503` with `error: "execution_unknown"`; subsequent requests with the same key also return `503` with `X-Idempotent-Replay: true` and do not invoke the handler again. Operators must reconcile whether the external effect occurred before deciding whether to submit a new idempotency key.

The worker’s idempotent admin route helpers now authenticate first and only then enter idempotency bookkeeping. That keeps the helper contract aligned with its name and prevents future admin endpoints from accidentally becoming “idempotent but unauthenticated” through wrapper misuse.

The `/admin/` UI now sends an `Idempotency-Key` automatically for supported manual actions so double-submits from the operator surface replay safely.

---

## Public Endpoints

Unless an endpoint section explicitly says `Authentication: exempt`, routes in this section require `X-API-Key` when called on `https://api.pharos.watch`.

<!-- GENERATED-START: public-endpoints-quick-reference -->
<!-- This block is generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json. -->
<!-- Do not edit by hand. Run `node --import tsx scripts/maintenance/generate-api-reference.ts` to refresh. -->

### Public Endpoints Quick Reference

Generated from `public/openapi.json` (`Pharos API` v1.0.0). The OpenAPI artifact intentionally excludes Cloudflare-Access-gated admin routes, self-serve key issuance POST endpoints, feedback submission, Telegram webhook ingestion, Telegram Mini App endpoints, and dynamic OG image routes. Those endpoints are documented in the hand-written sections below.

Total documented public operations: **39**.

| Method | Path | Summary | Tags | Auth | Parameters | Status codes |
| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |
| GET | `/api/blacklist` | Blacklist events | Blacklist | X-API-Key | `stablecoin?`, `chain?`, `chainId?`, `eventType?`, `q?`, `sortBy?`, `sortDirection?`, `limit?`, `offset?`, `includeTotal?` | 200, 400, 401, 429, 503 |
| GET | `/api/blacklist-summary` | Blacklist summary | Blacklist | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/bluechip-ratings` | Bluechip ratings | Risk | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/chains` | Chains | Chains | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/daily-digest` | Daily digest | Digest | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-events` | Depeg incidents | Peg Monitoring | X-API-Key | `stablecoin?`, `limit?`, `offset?`, `cursor?`, `active?`, `includeTotal?`, `includePending?` | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver` | Depeg Duration Resolver | Risk, Peg Monitoring | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver-review` | Depeg Duration Resolver Reviewer | Risk, Peg Monitoring | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity` | DEX liquidity | Liquidity | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity-history` | DEX liquidity history | Liquidity, History | X-API-Key | `stablecoin`, `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/digest-archive` | Digest archive | Digest | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/digest-snapshot` | Digest snapshot | Digest | X-API-Key | `date` | 200, 400, 401, 429, 503 |
| GET | `/api/events` | Tape events | Risk | X-API-Key | `type?`, `class?`, `coin?`, `pegCurrency?`, `chain?`, `q?`, `severityFloor?`, `since?`, `until?`, `cursor?`, `limit?`, `includeTotal?` | 200, 400, 401, 429, 503 |
| GET | `/api/health` | Health check | Health | none | — | 200, 400, 503 |
| GET | `/api/mint-burn-events` | Mint and burn events | Flows | X-API-Key | `stablecoin`, `direction?`, `chain?`, `burnType?`, `scope?`, `minAmount?`, `limit?`, `offset?`, `cursor?`, `includeTotal?` | 200, 400, 401, 429, 503 |
| GET | `/api/mint-burn-flows` | Mint and burn flows | Flows | X-API-Key | `stablecoin?`, `hours?` | 200, 400, 401, 429, 503 |
| GET | `/api/non-usd-share` | Non-USD share | Market Structure, History | X-API-Key | `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/peg-summary` | Peg summary | Peg Monitoring | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/public-status-history` | Public status history | Status | X-API-Key | `limit?`, `window?` | 200, 400, 401, 429, 503 |
| GET | `/api/redemption-backstops` | Redemption backstops | Risk, Reserves | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/report-cards/v9` | Safety Score V9 report cards | Risk | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/safety-score-history` | Safety score history | Risk, History | X-API-Key | `stablecoin`, `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/safety-score-history-v2` | Safety score history (identity-aware) | Risk, History | X-API-Key | `stablecoin`, `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/snapshot/{date}/stablecoin/{stablecoinId}` | Public snapshot projection for a single coin | Digest, Stablecoins, History | X-API-Key | `date`, `stablecoinId` | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/{date}.json` | Public snapshot for a single day | Digest, History | X-API-Key | `date` | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/index` | Public snapshot index | Digest | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/stability-index` | Pharos Stability Index | Risk | X-API-Key | `detail?` | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-charts` | Stablecoin charts | Stablecoins, History | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-reserves/{stablecoinId}` | Stablecoin reserves | Stablecoins, Reserves | X-API-Key | `stablecoinId` | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-summary/{stablecoinId}` | Stablecoin summary | Stablecoins | X-API-Key | `stablecoinId` | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin/{stablecoinId}` | Stablecoin detail | Stablecoins | X-API-Key | `stablecoinId` | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoins` | List stablecoins | Stablecoins | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/stress-signals` | Stress signals | Risk, Peg Monitoring | X-API-Key | `stablecoin?`, `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/supply-history` | Supply history | History | X-API-Key | `stablecoin`, `days?` | 200, 400, 401, 429, 503 |
| GET | `/api/telegram-pulse` | Telegram pulse | Status | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/usds-status` | USDS freeze status | Risk | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/yield-adapter-manifest` | Yield adapter manifest | Yield | X-API-Key | — | 200, 400, 401, 429, 503 |
| GET | `/api/yield-history` | Yield history | Yield, History | X-API-Key | `stablecoin`, `days?`, `mode?`, `sourceKey?` | 200, 400, 401, 429, 503 |
| GET | `/api/yield-rankings` | Yield rankings | Yield | X-API-Key | `projection?` | 200, 400, 401, 429, 503 |

<!-- GENERATED-END: public-endpoints-quick-reference -->

### `GET /api/events`

Tape events surface, backed by `worker/src/api/events.ts`. The handler already accepts `type`, `class`, `coin` (multi-value), `pegCurrency`, `chain`, `q` (case-insensitive free-text search, max 200 characters; `%` and `_` are matched literally), `severityFloor`, `since` / `until` (epoch ms), `cursor`, `limit`, and `includeTotal` per the quick-reference table above. The response envelope is `{ events[], nextCursor, total, totalExact, _meta }`: `nextCursor` is a keyset cursor string (null when there are no more rows), `total` is the exact count only when `includeTotal=true` (otherwise null), and `totalExact` mirrors that boolean.

As of the May 2026 detail-page pass, the frontend hook `useChartAnnotations` (`src/hooks/use-chart-annotations.ts`) consumes this endpoint to drive per-coin chart annotations on the stablecoin detail route. The hook is gated by `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` — see [process/feature-flags.md](process/feature-flags.md).

**Phase 1 (shipped May 2026):** the hook is wired through the consumer surface (`<ChartAnnotationDots>` + screen-reader-only legend) but returns an empty array. Charts render byte-identically to the pre-flag baseline; the flag-off path never fetches.

**Phase 2 (planned):** align the hook's URL params to the handler's existing shape — `coin=<id>` + `since` / `until` in epoch ms — or extend the worker to accept chart-friendly aliases (`stablecoin`, `from`, `to`). Phase 2 will also wire `useApiQueryWithMeta`, map tape-event rows into `ChartAnnotation`, and clamp results to the rendered chart's `[fromMs, toMs]` window inside the memo so out-of-range markers cannot push the data domain.

### `GET /api/stablecoins`

Full stablecoin list with current supply, price, chain breakdown, and FX rates. Data is refreshed by cron every 15 minutes; the cache entry has a 10-minute max-age.

**Cache:** producer-backed — `X-Data-Age` and `Warning` headers included.

The canonical `stablecoins` cache is written only after `StablecoinListResponseSchema` validation. Worker consumers that require the published public contract can opt into the same schema on cache read and return `503` for schema-invalid cached objects. Compatibility readers that only need critical fields may still salvage valid entries from older or partially malformed payloads, but they surface that state as degraded with a filtered-entry count instead of treating the filtered payload as fully healthy.

**Response**

```text
{
  "peggedAssets": [StablecoinData, ...],
  "fxFallbackRates": { "peggedEUR": 1.082, "peggedGBP": 1.26 },
  "_meta": { "updatedAt": 1710500000, "ageSeconds": 42, "status": "fresh" }
}
```

`fxFallbackRates` is present when the FX-rate state loaded by `sync-stablecoins` has usable fresh or static references; inputs can come from Frankfurter/ECB, secondary or tertiary FX mirrors, commodity references, or cached/static fallback rates. Keys are `pegType` strings (e.g. `"peggedEUR"`), values are rates in USD.

**`StablecoinData` fields**

| Field                          | Type                                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | `string`                                           | Pharos stablecoin ID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `name`                         | `string`                                           | Full name (e.g. `"Tether"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `symbol`                       | `string`                                           | Ticker (e.g. `"USDT"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `geckoId`                      | `string \| null`                                   | CoinGecko ID (normalized output key; upstream DefiLlama uses `gecko_id`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pegType`                      | `string`                                           | DefiLlama peg type (e.g. `"peggedUSD"`, `"peggedEUR"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pegMechanism`                 | `string`                                           | `"fiat-backed"`, `"crypto-backed-algorithmic"`, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `priceSource`                  | `string`                                           | Source label for the current price (`"defillama-list"`, `"coingecko"`, composite agreement labels such as `"binance+coingecko+kraken"`, `"geckoterminal"`, `"protocol-redeem"`, `"dexscreener"`, etc.). For high-confidence consensus this label can describe the full agreeing cluster even when the published price is the cluster median rather than one member's raw mark. When no usable current price survives validation, the cache keeps `price = null` and serializes `priceSource = "missing"` for contract stability.                                                                                                                                                                   |
| `priceConfidence`              | `string \| null`                                   | Price confidence level: `"high"` (cross-validated agreement), `"single-source"`, `"low"` (sources diverge), `"fallback"` (enrichment pipeline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `priceUpdatedAt`               | `number \| null`                                   | Compatibility timestamp for the current price; mirrors the effective observation time when available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `priceObservedAt`              | `number \| null`                                   | Unix seconds for the effective observation time attached to the selected source price; interpret alongside `priceObservedAtMode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `priceObservedAtMode`          | `"upstream" \| "local_fetch" \| "unknown" \| null` | Whether `priceObservedAt` came from source-native freshness metadata, local fetch time, or legacy/unknown provenance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `priceSyncedAt`                | `number \| null`                                   | Unix seconds when Pharos selected and wrote the current price during the sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `supplySource`                 | `string \| undefined`                              | Supply data source: `"defillama"`, `"defillama-history-gap-fill"` (used when a tracked DefiLlama live row collapses to zero supply but recent DefiLlama chart history still has a fresh non-zero total), `"coingecko-gap-fill"` (used when tracked deployments are missing from DefiLlama chain coverage and CoinGecko repairs the total/history buckets), `"coingecko-fallback"`, `"onchain-total-supply"` (used when a supplemental asset is normalized from on-chain total supply instead of an upstream market-cap field), or `"onchain-circulating-supply"` (used when the same live on-chain fallback subtracts configured non-circulating protocol inventory balances before normalization) |
| `supplyObservedAt`             | `number \| undefined`                              | Unix seconds for the supply observation when the current supply was retained from a previous supplemental snapshot. Omitted when supply freshness is not separately tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `supplyRestored`               | `true \| undefined`                                | Present and `true` when supplemental supply was restored from the prior positive `stablecoins` cache instead of observed during the current run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `price`                        | `number \| null`                                   | Current price in USD. For high-confidence consensus this is the median of the winning agreeing cluster; for single-source, low-confidence, or fallback outcomes it is the selected source price.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `circulating`                  | `Record<string, number>`                           | Current supply in USD, keyed by pegType (e.g. `{ "peggedUSD": 138000000 }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `circulatingPrevDay`           | `Record<string, number>`                           | Supply 24 h ago                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `circulatingPrevWeek`          | `Record<string, number>`                           | Supply 7 days ago                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `circulatingPrevMonth`         | `Record<string, number>`                           | Supply ~30 days ago                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `chainCirculating`             | `Record<string, ChainCirculating>`                 | Per-chain breakdown. For `"coingecko-gap-fill"` and `"defillama-history-gap-fill"` assets this remains DefiLlama-led unless the missing total can be allocated safely to one tracked chain, so the per-chain sum may be a lower bound on total supply.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `chains`                       | `string[]`                                         | List of chain names where the token is deployed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `contracts`                    | `ContractDeployment[] \| undefined`                | Curated on-chain deployments for tracked stablecoins (active and frozen). Omitted when curated metadata has no contracts on file. Use this to map a Pharos `id` to its on-chain token contracts when joining with `/api/report-cards/v9` or other endpoints keyed by `id`.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `consensusSources`             | `string[]`                                         | Source names that returned a valid price for this coin during the sync cycle. Defaults to `[]` when absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `priceSourceConfidenceProfile` | `PriceSourceConfidenceProfile \| undefined`        | Present for DEX-inclusive primary prices. Summarizes active protocol DEX lanes, the freshest DEX lane age, and whether the price relies only on the aggregate `dex-promoted` lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `agreeSources`                 | `string[] \| undefined`                            | Compatibility alias for agreeing/current price sources when present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**`ContractDeployment`**

| Field      | Type     | Description                                                            |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `chain`    | `string` | Pharos chain identifier (e.g. `"ethereum"`, `"arbitrum"`, `"solana"`). |
| `address`  | `string` | Token contract address as published by the issuer.                     |
| `decimals` | `number` | Token decimals.                                                        |

**`PriceSourceConfidenceProfile`**

| Field                   | Type             | Description                                                                                    |
| ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `activeDexLanes`        | `number`         | Count of accepted protocol-specific DEX lanes such as `balancer-dex` or `raydium-dex`.         |
| `freshestDexLaneAgeSec` | `number \| null` | Age in seconds of the freshest accepted DEX lane when the source carried observation metadata. |
| `aggregateLaneOnly`     | `boolean`        | `true` when the only DEX contribution is the legacy aggregate `dex-promoted` source.           |

**`ChainCirculating`**

```json
{
  "current": 50000000,
  "circulatingPrevDay": 49000000,
  "circulatingPrevWeek": 47000000,
  "circulatingPrevMonth": 44000000
}
```

All `circulating` values are already in USD (the list endpoint does not return native-currency values for non-USD pegs). Do not multiply by price.

---

### `GET /api/stablecoin/:id`

Historical price and supply chart data for a single stablecoin. Proxies DefiLlama (or CoinGecko for commodity/CG-only tokens) with a 5-minute server-side cache.
All upstream calls use `fetchWithRetry` with explicit per-request timeouts; on upstream/parse failures, or when CoinGecko-derived history is empty/stale, logs include source tags and stablecoin ID before stale-cache fallback or `supply_history` reconstruction. CoinGecko history is treated as stale when its newest point is more than 72 hours old.

When a D1 detail cache row exists but is older than the 5-minute TTL and younger than 24 hours, the Worker serves that stale row immediately with `Warning: 110`, `X-Data-Age`, and `Cache-Control: no-store`, then refreshes the coin in the background. Refresh work is best-effort single-flight per coin within a Worker isolate, so bursts of stale reads do not all fan out to upstream providers. Rows older than 24 hours are not served as stale fallback; they force the same synchronous refresh path used by cold misses, sharing an in-flight refresh where one already exists in the same isolate.

**Path parameter:** `:id` — Pharos stablecoin ID.

**Cache:** per-coin — custom `Cache-Control` with a 5-minute server-side D1 TTL (`public, s-maxage<=300, max-age=10`)

**Response**

```text
{
  "tokens": [TokenPoint, ...]
}
```

**`TokenPoint`**

| Field                 | Type                     | Description                            |
| --------------------- | ------------------------ | -------------------------------------- |
| `date`                | `number`                 | Unix timestamp (seconds)               |
| `totalCirculatingUSD` | `Record<string, number>` | Supply in USD per pegType key          |
| `totalCirculating`    | `Record<string, number>` | Supply in native units per pegType key |

For regular stablecoins the response still includes the raw DefiLlama detail fields, but the worker now also materializes `totalCirculatingUSD` and `totalCirculating` on each token row for contract consistency. Commodity and CG-only tokens are returned directly in the normalized shape above.

The upstream `chainBalances` per-chain history blob is stripped before caching and serving: for large coins it is ~98% of the upstream payload (USDT: ~21 MB) and pushed cached rows past D1's 2 MiB value cap. Current per-chain supply remains available as `chainCirculating` on `GET /api/stablecoins`; consumers needing full per-chain history should query DefiLlama directly.

For non-USD pegs, `totalCirculating` remains in native units while `totalCirculatingUSD` is converted to USD using the current token price before caching, so the USD field always reflects market cap regardless of peg type.

---

### `GET /api/stablecoin-summary/:id`

Lightweight per-coin snapshot sourced from cached `stablecoins` data. Designed for integrators that need current price/supply context without transferring full `/api/stablecoin/:id` history payloads.
Browser surfaces on `pharos.watch` and `ops.pharos.watch` should reach this route through same-origin `/_site-data/stablecoin-summary/:id`, which proxies onto the internal `site-api` lane instead of the external API-key lane.

**Path parameter:** `:id` — Pharos stablecoin ID.

**Cache:** producer-backed — `X-Data-Age` and `Warning` headers included.

**Error responses:** `503` when the shared `stablecoins` cache is missing or structurally corrupt; `404` when the requested coin ID is absent from an otherwise valid cache snapshot.

**Response**

```json
{
  "id": "usdt-tether",
  "name": "Tether",
  "symbol": "USDT",
  "pegType": "peggedUSD",
  "pegMechanism": "fiat-backed",
  "priceUsd": 1.0001,
  "priceSource": "coingecko+defillama-list",
  "priceConfidence": "high",
  "supplySource": "defillama",
  "supplyByPegUsd": { "peggedUSD": 183883564940.52 },
  "supplyUsd": {
    "current": 183883564940.52,
    "prevDay": 183697699496.48,
    "prevWeek": 183673067145.19,
    "prevMonth": 185316486043.16,
    "change1d": 185865444.03,
    "change7d": 210497795.33,
    "change30d": -1432921102.64
  },
  "chainCount": 17,
  "updatedAt": 1772718367
}
```

| Field              | Type                     | Description                                                                                                                               |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                 | Pharos stablecoin ID                                                                                                                      |
| `name`             | `string`                 | Asset name                                                                                                                                |
| `symbol`           | `string`                 | Ticker symbol                                                                                                                             |
| `pegType`          | `string`                 | Peg type key (`peggedUSD`, `peggedEUR`, etc.)                                                                                             |
| `pegMechanism`     | `string`                 | Backing/mechanism classification                                                                                                          |
| `priceUsd`         | `number \| null`         | Current price in USD                                                                                                                      |
| `priceSource`      | `string`                 | Price source identifier. When `priceUsd` is `null`, this may be `"missing"` to indicate that no usable current price survived validation. |
| `priceConfidence`  | `string \| null`         | Price confidence label                                                                                                                    |
| `supplySource`     | `string \| null`         | Supply source identifier                                                                                                                  |
| `supplyObservedAt` | `number \| null`         | Unix seconds for restored supplemental supply observation, or `null` when not separately tracked                                          |
| `supplyRestored`   | `boolean`                | Whether current supply was retained from the previous positive `stablecoins` cache rather than observed in the current run                |
| `supplyByPegUsd`   | `Record<string, number>` | Current supply by peg bucket (USD)                                                                                                        |
| `supplyUsd`        | `object`                 | Aggregate USD supply values and deltas (`current`, `prevDay`, `prevWeek`, `prevMonth`, `change1d`, `change7d`, `change30d`)               |
| `chainCount`       | `number`                 | Number of chains where the asset is deployed                                                                                              |
| `updatedAt`        | `number`                 | Unix seconds of the stablecoins snapshot used for this response                                                                           |

---

### `GET /api/non-usd-share`

Returns historical non-USD stablecoin market share data from `supply_history`, split into commodity-pegged (gold/silver) and non-commodity non-USD buckets. The denominator and both numerator buckets include only core stablecoins and cash equivalents; tracked variants and stable-value investments are excluded. The response keeps the legacy `fiatNonUsd*` field names for wire compatibility, but those fields include currency-linked plus other non-commodity non-USD pegs. Data is downsampled: daily for the last 90 days, weekly for the last 2 years, monthly beyond that.

**Cache:** slow — `public, s-maxage=3600, max-age=300`

Freshness headers are emitted from the latest completed `snapshot-supply` run when available. Stale responses include `X-Data-Age` and can downgrade to `Cache-Control: no-store` with `Warning: 110` once the daily history runway is exceeded. Rows newer than the completed daily snapshot marker are hidden so a failed chunked write cannot expose a partial latest day.

| Param  | Type     | Default | Constraints      | Description             |
| ------ | -------- | ------- | ---------------- | ----------------------- |
| `days` | `number` | `5000`  | min 30, max 5000 | Lookback window in days |

Unlike most numeric-query handlers, this endpoint defaults missing or malformed `days` values to `5000` and clamps most out-of-range values into `30..5000` instead of returning `400`. Current parser quirk: `days=0` is treated like a missing value and returns the default `5000` rather than the minimum `30`.

**Response:** `Array<{ date, commodityShare, fiatNonUsdShare, commodity, fiatNonUsd, total }>`

| Field             | Type     | Description                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `date`            | `number` | Unix seconds (snapshot date)                                                  |
| `commodityShare`  | `number` | Commodity-pegged share as % of total supply                                   |
| `fiatNonUsdShare` | `number` | Non-commodity non-USD share as % of total supply, using the legacy field name |
| `commodity`       | `number` | Commodity-pegged circulating USD                                              |
| `fiatNonUsd`      | `number` | Non-commodity non-USD circulating USD, using the legacy field name            |
| `total`           | `number` | Total circulating USD across core stablecoins and cash equivalents            |

---

### `GET /api/chains`

Returns chain-level core stablecoin and cash-equivalent aggregates with Chain Health Scores. Tracked variants and stable-value investments are excluded from supply, count, dominance, and quality totals. Results are computed on-the-fly from the stablecoins cache and report-card cache (two D1 reads); `chain_supply_history` stores the matching forward daily aggregate. The response body also carries `_meta`, so the frontend can distinguish fresh, degraded, and missing-dependency states without inferring freshness from fetch timing alone.

**Cache:** producer-backed — `public, s-maxage=300, max-age=60, stale-while-revalidate=300`

**Freshness threshold:** 1800 seconds. Returns `503` when the stablecoins cache is unavailable or structurally corrupt. When dependent snapshots lag, the endpoint stays readable but the body `_meta.status` degrades and the frontend surfaces stale-data warnings.

**Status codes:**

| Status | Meaning                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| 200    | Chain aggregates computed successfully; freshness may still be degraded in `_meta` |
| 503    | Stablecoins cache unavailable (missing or structurally corrupt)                    |

**Response (`ChainsResponse`):**

```text
{
  "_meta": {
    "updatedAt": 1710500000,
    "ageSeconds": 42,
    "status": "fresh",
    "dependencies": {
      "reportCards": {
        "updatedAt": 1710499800,
        "ageSeconds": 242,
        "status": "fresh"
      }
    }
  },
  "chains": [ChainSummary, ...],
  "globalTotalUsd": 230000000000,
  "chainAttributedTotalUsd": 218000000000,
  "unattributedTotalUsd": 12000000000,
  "globalChange24hPct": 0.0012,
  "globalChange7dPct": 0.0045,
  "globalChange30dPct": 0.018,
  "updatedAt": 1710500000,
  "healthMethodologyVersion": "1.5"
}
```

| Field                      | Type             | Description                                                                              |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `chains`                   | `ChainSummary[]` | Chains sorted by `totalUsd` descending                                                   |
| `globalTotalUsd`           | `number`         | Total core stablecoin and cash-equivalent supply in USD                                   |
| `chainAttributedTotalUsd`  | `number`         | Chain-attributed USD supply, capped at `globalTotalUsd`                                  |
| `unattributedTotalUsd`     | `number`         | Positive residual between tracked supply and chain-attributed supply in USD              |
| `globalChange24hPct`       | `number`         | 24h change for total tracked stablecoin supply as a decimal share                        |
| `globalChange7dPct`        | `number`         | 7d change for total tracked stablecoin supply as a decimal share                         |
| `globalChange30dPct`       | `number`         | 30d change for total tracked stablecoin supply as a decimal share                        |
| `updatedAt`                | `number`         | Unix epoch seconds of the underlying stablecoins snapshot                                |
| `healthMethodologyVersion` | `string`         | Chain Health Score methodology version (currently `"1.5"`)                               |

`_meta.dependencies.reportCards` is present when the endpoint can determine report-card freshness. When that dependency is stale or unavailable, `healthScore` degrades to `null` and the route UI surfaces the dependency reason instead of pretending the chain is fully fresh.

**`ChainSummary` fields:**

| Field                      | Type                                 | Description                                                                                                                        |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `string`                             | Canonical chain identifier (DefiLlama chain name)                                                                                  |
| `name`                     | `string`                             | Human-readable chain name                                                                                                          |
| `logoPath`                 | `string \| null`                     | Path to chain logo asset                                                                                                           |
| `type`                     | `"evm" \| "tron" \| "other"`         | Chain runtime family from `CHAIN_META`                                                                                             |
| `totalUsd`                 | `number`                             | Total stablecoin supply on this chain in USD                                                                                       |
| `change24h`                | `number`                             | Absolute 24h supply change in USD                                                                                                  |
| `change24hPct`             | `number`                             | 24h supply change as a decimal share (`0.084` = +8.4%), same units as `globalChange24hPct`                                         |
| `change7d`                 | `number`                             | Absolute 7d supply change in USD                                                                                                   |
| `change7dPct`              | `number`                             | 7d supply change as a decimal share (`0.084` = +8.4%), same units as `globalChange7dPct`                                           |
| `change30d`                | `number`                             | Absolute 30d supply change in USD                                                                                                  |
| `change30dPct`             | `number`                             | 30d supply change as a decimal share (`0.084` = +8.4%), same units as `globalChange30dPct`                                         |
| `stablecoinCount`          | `number`                             | Number of distinct stablecoins on this chain                                                                                       |
| `dominantStablecoin`       | `{ id, symbol, share }`              | Largest stablecoin by supply on the chain                                                                                          |
| `topStablecoins`           | `{ id, symbol, share, supplyUsd }[]` | Up to five largest stablecoins by supply on the chain; `share` is chain-local (0–1) and `supplyUsd` is USD-denominated             |
| `dominanceShare`           | `number`                             | Bounded chain share of global supply; normalized when raw chain attribution exceeds it                                             |
| `healthScore`              | `number \| null`                     | Chain Health Score 0–100, or `null` if insufficient data                                                                           |
| `healthBand`               | `string \| null`                     | Health band label: `"robust"` (80–100), `"healthy"` (60–79), `"mixed"` (40–59), `"fragile"` (20–39), `"concentrated"` (0–19)       |
| `healthFactors`            | `ChainHealthFactors`                 | Raw sub-factor scores (0–100 each; `quality` may still be `null`)                                                                  |
| `chainEnvironmentEvidence` | `ChainEnvironmentEvidence`           | Provenance for `healthFactors.chainEnvironment`; either the consumed L2BEAT snapshot fields or the fallback Pharos resilience tier |

**`ChainHealthFactors` fields:**

| Field              | Type             | Description                                                                                                                                                                                          |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concentration`    | `number`         | HHI-based supply concentration score (higher = more diverse)                                                                                                                                         |
| `quality`          | `number \| null` | Supply-weighted average stablecoin quality from report-card grades; `null` when rated supply coverage is below 50% by value                                                                          |
| `chainEnvironment` | `number`         | Chain environment score. Matched L2BEAT scaling projects use stage plus the five L2BEAT risk fields; unmatched chains fall back to Pharos resilience tiers (`100` tier 1, `60` tier 2, `20` tier 3). |
| `pegStability`     | `number`         | Supply-weighted average peg deviation score                                                                                                                                                          |
| `backingDiversity` | `number`         | Shannon entropy of the active backing split across the chain (`rwa-backed` vs `crypto-backed`)                                                                                                       |

**`ChainEnvironmentEvidence` variants:**

| Variant     | Fields                                                                                                                             | Description                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L2BEAT      | `source: "l2beat"`, `score`, `projectId`, `slug`, `name`, `stage`, `isUnderReview`, `stageScore`, `riskScore`, `risks`, `snapshot` | Static L2BEAT snapshot evidence used for matched scaling projects. `risks` includes Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure values/sentiments. |
| Pharos tier | `source: "pharos-chain-tier"`, `score`, `resilienceTier`                                                                           | Fallback evidence for chains without an explicit L2BEAT alias.                                                                                                                                   |

---

### `GET /api/stablecoin-reserves/:id`

Returns the resolved reserve presentation for a stablecoin with `liveReservesConfig`.

- Unknown IDs or coins without live reserve support return `404`.
- Live-enabled coins return `200` even before the first successful sync; the payload includes fallback mode + sync state.
- This endpoint powers the stablecoin detail-page reserve card. The same underlying live-reserve dataset also feeds report-card collateral quality, reserve-drift monitoring, and `/status`, but those surfaces read D1-backed reserve snapshots directly rather than calling this endpoint.
- A response is treated as `live` only when the stored reserve snapshot matches the latest successful sync state and passes strict integrity validation; orphaned partial writes or corrupt stored snapshots fall back to the curated/template presentation instead of presenting malformed live data as authoritative.
- Successful responses are covered by the shared `StablecoinReservesResponseSchema`; frontend API clients validate `200` payloads strictly while preserving `404` as the not-live-enabled/null path.

**Cache:** dynamic

- Live snapshots: slow (`public, s-maxage=3600, max-age=300`)
- `live-stale` snapshots: `public, s-maxage=1800, max-age=120`
- Bootstrap / fallback / unavailable presentations: shorter (`public, s-maxage=300, max-age=60`) so pre-sync fallback responses do not stay pinned at the edge after the first successful live sync

**Response (200):**

| Field          | Type             | Description                                                                                                                                                                                                          |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stablecoinId` | `string`         | Pharos coin ID                                                                                                                                                                                                       |
| `mode`         | `string`         | One of `live`, `live-stale`, `curated-fallback`, `template-fallback`, `unavailable`. This is snapshot transport/freshness state, not the user-facing reserve badge semantics.                                        |
| `reserves`     | `ReserveSlice[]` | Reserve slices currently being shown to the user                                                                                                                                                                     |
| `estimated`    | `boolean`        | `true` only when using the classification template fallback                                                                                                                                                          |
| `liveAt`       | `number?`        | Unix seconds of the last successful live snapshot. Present only when live data exists                                                                                                                                |
| `source`       | `string?`        | Adapter key (for example `"infinifi"`, `"m0"`, `"openeden-usdo"`, or `"accountable"`). Present only when live data exists                                                                                            |
| `displayUrl`   | `string?`        | Curated click-through page shown as `Source` in the UI. Present only when configured                                                                                                                                 |
| `evidenceUrls` | `string[]?`      | Adapter-emitted evidence URLs for the authoritative live snapshot, shown separately as `Evidence` links when available                                                                                               |
| `displayBadge` | `object?`        | User-facing reserve badge semantics for authoritative live snapshots (`live`, `curated-validated`, or `proof`)                                                                                                       |
| `metadata`     | `object?`        | Adapter snapshot metadata for authoritative live snapshots. This can include feed-specific context such as `yieldBasisCollateralPct` for `crvusd`; adapter-specific metadata and nested `details` remain passthrough |
| `provenance`   | `object?`        | Evidence-quality envelope for authoritative live snapshots (`evidenceClass`, `sourceModel`, optional `freshnessMode`, `scoringEligible`)                                                                             |
| `sync`         | `object?`        | Live sync state (`status`, `bootstrap`, `stale`, `lastAttemptedAt`, `lastSuccessAt`, `warnings`, `lastError`, optional `failureCategory`, optional `uncertainWrite`). Present only when live-enabled                 |

`sync.warnings` can include both adapter-emitted warnings from the latest attempt and storage-integrity warnings when a stored live snapshot is rejected and the endpoint fails closed to a fallback presentation.
`sync.failureCategory` is copied from `reserve_sync_state.metadata.failureCategory` when available. `sync.uncertainWrite=true` means the latest attempt hit the D1 write-timeout / finalize-rejection path, so the endpoint may be serving the last consistent snapshot or fallback while the attempted write remains ambiguous until the next clean run.

`displayUrl` and `evidenceUrls` are intentionally different:

- `displayUrl` is the curated reserve-card destination
- `evidenceUrls` are adapter-emitted URLs tied to the authoritative live snapshot metadata
- some live feeds expose only `displayUrl`, while others expose both

When present, `displayBadge` has:

| Field   | Type                                       | Description                                                                    |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `kind`  | `"live" \| "curated-validated" \| "proof"` | User-facing reserve badge classification                                       |
| `label` | `string`                                   | Badge label rendered by the frontend (`Live`, `Curated-Validated`, or `Proof`) |

When present, `provenance` has:

| Field             | Type                                                          | Description                                                                                                       |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `evidenceClass`   | `"independent" \| "static-validated" \| "weak-live-probe"`    | Evidence class used for scoring and provenance. This is related to, but not identical to, the UI badge semantics. |
| `sourceModel`     | `"dynamic-mix" \| "validated-static" \| "single-bucket"`      | Structural shape of the reserve feed                                                                              |
| `freshnessMode`   | `"verified" \| "unverified" \| "not-applicable" \| undefined` | Explicit freshness policy when the adapter emits one                                                              |
| `scoringEligible` | `boolean`                                                     | Whether this exact snapshot is currently eligible for collateral-quality passthrough                              |

**Response (404):** unknown or non-canonical IDs, known active coins without live reserve support, and live-enabled coins with no resolved reserve result return `{ "error": "Not found" }`.

---

### `GET /api/stablecoin-charts`

Aggregate historical supply chart data broken down by peg type. Existing DefiLlama history remains a legacy provider-wide aggregate and each response point is marked `aggregateUniverse: "legacy-provider-all-stablecoins-v1"`. The API deliberately does not append the core-only live point to that series: joining different classification universes would render the 2026-07-15 policy cutover as a false market-cap drop. Live homepage monetary KPIs use `core-stablecoins-v1`; a live chart tail can resume once historical chart rows are rebuilt under that same marker. Structural supplemental overlays are already limited to core stablecoins and cash equivalents. `sync-stablecoin-charts` is triggered every 30 minutes; scheduled deliveries share an hourly generation-fenced cadence bucket, and a failed first delivery remains retryable at the second delivery. `/api/health` treats the cache as healthy for up to 1 hour.

**Cache:** standard — `X-Data-Age` and `Warning` headers included. This array response gets freshness headers only; it does not receive a response-body `_meta` envelope.

**Response:** A top-level array.

```json
[
  {
    "date": 1511913600,
    "aggregateUniverse": "legacy-provider-all-stablecoins-v1",
    "totalCirculatingUSD": {
      "peggedUSD": 110105,
      "peggedEUR": 14967600
    }
  }
]
```

| Field                 | Type                     | Description                                                                                                                      |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `date`                | `number`                 | Unix timestamp (seconds) for the downsampled cache entry                                                                          |
| `aggregateUniverse`   | `string \| undefined`   | Classification universe for the point. Current legacy provider history uses `"legacy-provider-all-stablecoins-v1"`             |
| `totalCirculatingUSD` | `Record<string, number>` | Aggregate supply in USD per peg type                                                                                              |

---

### `GET /api/blacklist`

Freeze, blacklist, block/unblock, account-pause, and token-destruction events for symbols in the shared `BLACKLIST_STABLECOINS` set. EURC mirror-zero rows are preserved with suppression metadata and excluded from public aggregates. Data is sourced from on-chain logs via Etherscan, Tron, and EVM RPCs.

**Cache:** producer-backed

**Freshness note:** `X-Data-Age` / `Warning` track the latest successful 6-hourly `sync-blacklist` writer timestamp. Public freshness stays `fresh` through that 6-hour budget and only degrades once the scheduled blacklist sync is actually late.

**Query parameters**

| Param           | Type      | Default | Description                                                                                                                                                                    |
| --------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stablecoin`    | `string`  | —       | Filter by uppercase blacklist-tracker symbol from the full `BLACKLIST_STABLECOINS` set in `shared/types/market.ts` (for example `USDT`, not `usdt-tether`)                     |
| `chain`         | `string`  | —       | Filter by exact chain display name (e.g. `Ethereum`, `Tron`)                                                                                                                   |
| `chainId`       | `string`  | —       | Filter by canonical chain-registry ID (e.g. `ethereum`, `tron`). When both `chain` and `chainId` are supplied, they must identify the same chain or the endpoint returns `400` |
| `eventType`     | `string`  | —       | Filter by type: `blacklist`, `unblacklist`, `destroy`                                                                                                                          |
| `q`             | `string`  | —       | Case-insensitive address substring search                                                                                                                                      |
| `sortBy`        | `string`  | `date`  | Sort field: `date`, `stablecoin`, `chain`, `event`                                                                                                                             |
| `sortDirection` | `string`  | `desc`  | Sort direction: `asc`, `desc`                                                                                                                                                  |
| `limit`         | `integer` | `1000`  | Max results (0–1000; `0` maps to default `1000`)                                                                                                                               |
| `offset`        | `integer` | `0`     | Legacy pagination offset (0–25,000); cannot be combined with `cursor`                                                                                                          |
| `cursor`        | `string`  | —       | Opaque keyset cursor from `nextCursor`; preferred for deep pagination and valid for every supported sort order                                                                 |
| `includeTotal`  | `boolean` | `false` | When `true`, runs an exact `COUNT(*)`; otherwise `total` is a page lower bound and `totalExact` is `false`                                                                     |

**Response**

```text
{
  "events": [BlacklistEvent, ...],
  "total": 13422,
  "totalExact": true,
  "nextCursor": "eyJ2IjoxLCJ2YWx1ZXMiOlsxNzcyNjA2NDAwLCJldmVudC1pZCJdfQ",
  "methodology": {
    "version": "3.99",
    "versionLabel": "v3.99",
    "currentVersion": "4.0",
    "currentVersionLabel": "v4.0",
    "changelogPath": "/methodology/blacklist-tracker-changelog/",
    "asOf": 1776729600,
    "isCurrent": false
  }
}
```

Prefer `cursor`/`nextCursor` for sequential or deep traversal. Numbered FreezeWatch pages opt into exact totals and retain bounded offset pagination for direct page navigation.

**`BlacklistEvent`**

| Field                | Type             | Description                                                                                                                                                                                               |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`         | Composite ID: `{chainId}-{txHash}-{logIndex}`                                                                                                                                                             |
| `stablecoin`         | `string`         | Token symbol (`USDC`, `USDT`, etc.)                                                                                                                                                                       |
| `chainId`            | `string`         | Stable chain identifier from the shared chain registry (e.g. `"ethereum"`, `"tron"`). This is the preferred join key for integrations                                                                     |
| `chainName`          | `string`         | Human-readable chain name (e.g. `"Ethereum"`)                                                                                                                                                             |
| `eventType`          | `string`         | `"blacklist"`, `"unblacklist"`, or `"destroy"`                                                                                                                                                            |
| `address`            | `string`         | Affected address (EVM `0x…` or Tron `T…`)                                                                                                                                                                 |
| `amountNative`       | `number \| null` | Canonical token-native amount recovered from event data or historical balance lookup                                                                                                                      |
| `amountUsdAtEvent`   | `number \| null` | Event-time USD value when Pharos can justify one                                                                                                                                                          |
| `amountSource`       | `string`         | `event`, `historical_balance`, `current_balance_snapshot`, `derived`, `legacy_migration`, or `unavailable`                                                                                                |
| `amountStatus`       | `string`         | `resolved`, `recoverable_pending`, `permanently_unavailable`, `provider_failed`, `ambiguous`                                                                                                              |
| `txHash`             | `string`         | Transaction hash                                                                                                                                                                                          |
| `blockNumber`        | `number`         | Block number                                                                                                                                                                                              |
| `timestamp`          | `number`         | Unix seconds                                                                                                                                                                                              |
| `methodologyVersion` | `string`         | Methodology version attributed to this event row                                                                                                                                                          |
| `contractAddress`    | `string \| null` | Emitting token contract when known                                                                                                                                                                        |
| `configKey`          | `string \| null` | Internal tracker config identity (`{chainId}-{contract}`)                                                                                                                                                 |
| `eventSignature`     | `string \| null` | Human-readable event signature/name when known                                                                                                                                                            |
| `eventTopic0`        | `string \| null` | Raw EVM topic0 when applicable                                                                                                                                                                            |
| `suppressionReason`  | `string \| null` | Always `null` or absent on public rows because `/api/blacklist` filters `suppression_reason IS NULL`; non-null reasons are retained only on internal/audit DB rows excluded from public aggregates/events |
| `explorerTxUrl`      | `string`         | Block explorer URL for the transaction                                                                                                                                                                    |
| `explorerAddressUrl` | `string`         | Block explorer URL for the address                                                                                                                                                                        |

**`methodology`**

| Field                 | Type      | Description                                                       |
| --------------------- | --------- | ----------------------------------------------------------------- |
| `version`             | `string`  | Methodology version of the latest returned event in this response |
| `versionLabel`        | `string`  | Display label (e.g. `"v3.2"`)                                     |
| `currentVersion`      | `string`  | Latest methodology version                                        |
| `currentVersionLabel` | `string`  | Display label for latest methodology version                      |
| `changelogPath`       | `string`  | Relative URL to the methodology changelog page                    |
| `asOf`                | `number`  | Unix timestamp of latest event used for freshness                 |
| `isCurrent`           | `boolean` | Whether `version` matches `currentVersion`                        |

---

### `GET /api/blacklist-summary`

Server-side aggregates for the Blacklist Tracker overview cards, chart, and filter options. This lets the frontend render summary state without hydrating the full blacklist history first.

`stats.destroyedTotal` remains an event-history total. `stats.activeAddressCount`, `stats.activeFrozenTotal`, and `stats.activeAmountGapCount` are legacy wire-compatible fields for Pharos' local net-active blacklist state machine. `stats.trackedFrozenTotal` is the persistent freeze-ledger total sourced from `blacklist_current_balances`, including reconciled historical bootstrap rows where later seizures or unblacklists would otherwise hide the frozen amount. New consumers should prefer `trackedAddressCount`, `trackedFrozenTotal`, and `trackedAmountGapCount` for public freeze-ledger exposure, and use the active fields only when they specifically need the current local net-frozen state. These current-balance totals are last-known successful snapshots, not a live guarantee; provider refresh failures preserve the last successful amount and should be interpreted through freshness, status, and provenance metadata when present. New snapshot rows are contract/config-scoped; older rows can still fall back to the legacy symbol/chain/address identity until remediated. `stats.recentCount` covers the last 30 days, while `stats.recentCount24h` is the last-24-hours subset used by chrome-level monitoring surfaces. The `chart` now uses that same freeze ledger and attributes each tracked balance back to its latest recorded blacklist quarter, so the quarterly buckets explain the `trackedFrozenTotal` headline rather than raw event-time intake.

The four `perCoin*` maps power the per-coin "Blacklist Activity" block on stablecoin detail pages. `perCoinFrozenAddressCount` counts addresses whose latest event is `blacklist` (net-frozen). `perCoinFrozenTotal` sums last-known successful `blacklist_current_balances.balance_usd` snapshots per coin. `perCoinDestroyedTotal` sums `amount_usd_at_event` over `destroy` events per coin. `perCoinQuarterlyEventTypes` contains each coin's quarterly breakdown of event-type counts, zero-filled between the coin's first and last event quarters so bars render contiguously. All per-coin aggregations exclude rows where `suppression_reason` is set (e.g. EURC mirror zero-balance entries).

`reconciliation` exposes the latest durable guarded-recovery result. It is hydrated onto older producer snapshots after a recovery run, so exact manifest/gap evidence does not wait for the next six-hour publication. The same object is available to operators in `GET /api/status` at `dataQuality.blacklistReconciliation`.

**Cache:** producer-backed

**Freshness note:** Shares the same 6-hourly freshness headers as `GET /api/blacklist`, keyed to the latest successful `sync-blacklist` write rather than the request time of the summary endpoint itself.

**Response**

```json
{
  "stats": {
    "usdcBlacklisted": 1204,
    "usdtBlacklisted": 3881,
    "goldBlacklisted": 19,
    "frozenAddresses": 5071,
    "destroyedTotal": 158938221.19,
    "activeAddressCount": 5071,
    "activeFrozenTotal": 2120456789.42,
    "activeAmountGapCount": 17,
    "trackedAddressCount": 9466,
    "trackedFrozenTotal": 3235360796.7,
    "trackedAmountGapCount": 0,
    "recentCount": 42,
    "recentCount24h": 3,
    "recoverableGapCount": 17,
    "perCoinBlacklistCounts": { "USDC": 1204, "USDT": 3881 },
    "perCoinTotalEvents": { "USDC": 1210, "USDT": 3945 },
    "perCoinFrozenAddressCount": { "USDC": 1151, "USDT": 3794 },
    "perCoinFrozenTotal": { "USDC": 143000000, "USDT": 1800000000 },
    "perCoinDestroyedTotal": { "USDC": 0, "USDT": 158900000 },
    "perCoinQuarterlyEventTypes": {
      "USDC": [{ "quarter": "Q1 '26", "blacklist": 42, "unblacklist": 0, "destroy": 1 }]
    }
  },
  "chart": [{ "quarter": "Q1 '24", "USDT": 1200000, "USDC": 850000, "PAXG": 0, "XAUT": 0, "total": 2050000 }],
  "chains": [
    { "id": "ethereum", "name": "Ethereum" },
    { "id": "tron", "name": "Tron" }
  ],
  "coverage": {
    "supported": [
      {
        "symbol": "USDT",
        "stablecoinId": "usdt-tether",
        "chainId": "ethereum",
        "chainName": "Ethereum",
        "contractAddress": "0xdac17f958d2ee523a2206206994597c13d831ec7",
        "configKey": "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
        "providerSource": "evm-logs",
        "eventFamilies": ["USDT legacy"],
        "eventTypes": ["blacklist", "unblacklist", "destroy"]
      }
    ],
    "unsupportedDeferred": [
      { "symbol": "TUSD", "chainId": "bsc", "reason": "deferred_contract_creation_verification" }
    ],
    "counts": {
      "supportedConfigs": 71,
      "unsupportedDeferredConfigs": 10,
      "bySymbol": { "USDT": 8 },
      "byChain": { "ethereum": 35 },
      "byProviderSource": { "evm-logs": 70, "trongrid": 1 }
    }
  },
  "freezeLedgerMeta": {
    "totalRows": 9466,
    "scopedRows": 240,
    "legacyRows": 9226,
    "oldestObservedAt": 1710000000,
    "newestObservedAt": 1776729600,
    "oldestAgeSec": 66600000,
    "newestAgeSec": 1200,
    "statusDistribution": { "resolved": 9466 },
    "sourceDistribution": { "current_balance": 240, "bootstrap_kyc_rip": 9226 },
    "freshnessDistribution": { "fresh": 9450, "degraded": 10, "stale": 6 },
    "currentFreshnessDistribution": { "fresh": 240, "degraded": 0, "stale": 0 },
    "providerFailedCount": 0,
    "lastErrorClassDistribution": {},
    "sourceCategoryCounts": { "bootstrap": 9226, "current": 240, "destroy": 0, "other": 0 },
    "gaps": {
      "tracked": 0,
      "recoverable": 17,
      "unrecoverable": 0,
      "recentRecoverable": 0,
      "neverAttempted": 0,
      "repeatedFailures": 0,
      "oldestRecoverableAgeSec": null,
      "amountStatusDistribution": { "resolved": 13405, "recoverable_pending": 17 },
      "amountSourceDistribution": { "historical_balance": 9000, "event": 4405, "unavailable": 17 }
    }
  },
  "dataQuality": {
    "status": "ok",
    "warnings": [],
    "amountGaps": {
      "totalEvents": 13422,
      "recoverable": 17,
      "unrecoverable": 0,
      "recentRecoverable": 0,
      "missingRatio": 0.0013,
      "recentWindowSec": 86400
    },
    "freezeLedger": {
      "providerFailedCount": 0,
      "staleSnapshotCount": 0,
      "trackedGapCount": 0,
      "scopedRows": 240,
      "legacyRows": 9226
    },
    "coverage": { "supportedConfigs": 71, "unsupportedDeferredConfigs": 10 }
  },
  "reconciliation": {
    "status": "verified",
    "runId": "night-watch-usdt-tron-2026-07-09:apply:1783660000",
    "manifestId": "night-watch-usdt-tron-2026-07-09",
    "manifestSha256": "bc46bbce09a1c7e926499c07e6f968a914ae9df58c8acec552b7ebff1425f917",
    "bookmarkRecorded": true,
    "expectedEventCount": 86,
    "presentEventCount": 86,
    "missingEventCount": 0,
    "duplicateIdentityCount": 0,
    "destroyedAmountExpectedRaw": "8874287612325",
    "destroyedAmountActualRaw": "8874287612325",
    "balanceReplayExpectedCount": 70,
    "balanceReplayMatchingCount": 70,
    "unresolvedManifestGapCount": 0,
    "tronAtSafeHead": true,
    "arbitrumAtSafeHead": true,
    "startedAt": 1783660000,
    "completedAt": 1783660100
  },
  "totalEvents": 13422,
  "methodology": {
    "version": "4.0",
    "versionLabel": "v4.0",
    "currentVersion": "4.0",
    "currentVersionLabel": "v4.0",
    "changelogPath": "/methodology/blacklist-tracker-changelog/",
    "asOf": 1776729600,
    "isCurrent": true
  }
}
```

`coverage` is the machine-readable tracker coverage inventory. `supported` entries are contract/config-level rows; each row includes the required tracked fields `symbol`, `stablecoinId`, `chainId`, `chainName`, `contractAddress`, `configKey`, `providerSource`, `eventFamilies`, and `eventTypes`. `unsupportedDeferred` identifies known deferred or explicitly de-scoped deployments from the runtime manifest and the reason they are not live; current examples use `chainId` values from the same shared chain registry as event rows. `freezeLedgerMeta` describes the last-known snapshot ledger used by `trackedFrozenTotal`, including scoped-vs-legacy row counts, observed-age bounds, source/status distributions, provider failures, and amount-gap distributions. `freshnessDistribution` covers every historical ledger row; `currentFreshnessDistribution` isolates rows produced by the current-balance provider when present, but old resolved snapshots are diagnostic rather than an actionable stale condition. `dataQuality.status` summarizes recoverable amount-gap thresholds and current-balance provider failures into `ok`, `degraded`, or `stale`; permanent unavailable rows and deferred coverage remain visible in the payload without opening warning state by themselves. Clients should display or alert on `warnings` rather than inferring quality from null amount fields alone.

---

### `GET /api/depeg-events`

Peg deviation events (≥ 100 bps for USD-pegged, ≥ 150 bps for non-USD pegs). Events are detected every 15 minutes by the cron.

**Cache:** producer-backed

**Query parameters**

| Param            | Type      | Default | Description                                                                                              |
| ---------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `stablecoin`     | `string`  | —       | Filter by Pharos stablecoin ID                                                                           |
| `active`         | `"true"`  | —       | When `"true"`, return only ongoing (unresolved) depeg events                                             |
| `limit`          | `integer` | `100`   | Max results (1–1000)                                                                                     |
| `offset`         | `integer` | `0`     | Pagination offset (0–50,000); cannot be combined with `cursor`                                           |
| `cursor`         | `string`  | —       | Opaque keyset cursor from `nextCursor`                                                                   |
| `includeTotal`   | `boolean` | `true`  | When `false`, skips the exact `COUNT(*)`; `total` becomes a page lower bound and `totalExact` is `false` |
| `includePending` | `boolean` | `false` | When `true`, includes pending incidents awaiting confirmation in `pending`                               |

**Response**

```text
{
  "events": [DepegEvent, ...],
  "pending": [DepegPendingIncident, ...],
  "total": 6,
  "totalExact": true,
  "counts": { "incidents": 6, "thresholdCrossings": 13 },
  "nextCursor": null,
  "methodology": {
    "version": "6.21",
    "versionLabel": "v6.21",
    "currentVersion": "6.21",
    "currentVersionLabel": "v6.21",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1772606400,
    "isCurrent": true
  }
}
```

Results are ordered by `startedAt DESC, id DESC`. Prefer cursor pagination; offsets remain for shallow compatibility. `total` counts public incidents. Filtered historical exact-total responses also include incident and raw threshold-crossing counts; other modes omit `counts`.

When the Depeg Duration Resolver has linked multiple raw event rows into one active repaired incident, this endpoint returns only the incident's current event row, excludes superseded source rows from the active projection, and projects the public `startedAt`/`startPrice` from the first linked row.

**`DepegEvent`**

| Field                 | Type                   | Description                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | `number`               | Auto-increment DB ID                                                                                                                                                                                                                                                                                                                                                           |
| `stablecoinId`        | `string`               | Pharos stablecoin ID                                                                                                                                                                                                                                                                                                                                                           |
| `symbol`              | `string`               | Token symbol                                                                                                                                                                                                                                                                                                                                                                   |
| `pegType`             | `string`               | DefiLlama peg type (e.g. `"peggedUSD"`)                                                                                                                                                                                                                                                                                                                                        |
| `direction`           | `"above" \| "below"`   | Whether the price was above or below the peg                                                                                                                                                                                                                                                                                                                                   |
| `peakDeviationBps`    | `number`               | Largest deviation observed (basis points, signed; negative = below peg, positive = above peg)                                                                                                                                                                                                                                                                                  |
| `startedAt`           | `number`               | Unix seconds when depeg was first detected                                                                                                                                                                                                                                                                                                                                     |
| `endedAt`             | `number \| null`       | Unix seconds when the event row closed; `null` if still active                                                                                                                                                                                                                                                                                                                 |
| `startPrice`          | `number`               | Price at event start (USD)                                                                                                                                                                                                                                                                                                                                                     |
| `peakPrice`           | `number \| null`       | Price at worst deviation                                                                                                                                                                                                                                                                                                                                                       |
| `recoveryPrice`       | `number \| null`       | Price at recovery when the close reason is a market recovery. `null` for open rows, legacy rows without terminal evidence, and non-price recovery evidence such as native-peg quote closes.                                                                                                                                                                                    |
| `pegReference`        | `number`               | Reference peg value used (USD)                                                                                                                                                                                                                                                                                                                                                 |
| `source`              | `"live" \| "backfill"` | Detection method                                                                                                                                                                                                                                                                                                                                                               |
| `confirmationSources` | `string \| null`       | Composite provenance tag recorded when a pending depeg was promoted. Components (joined with `+`): the off-chain source label (`CoinGecko`, `DefiLlama`, or `NativePeg(<currency>)`), `DEX`, `CEX`, `Pool`. Example: `"DEX+CEX"` or `"CoinGecko+Pool"`. `null` for events that bypassed the pending lane (small-cap authoritative direct-insert and historical backfill rows). |
| `pendingReason`       | `string \| null`       | Composite reason the incident entered the pending lane, e.g. `"large-cap"`, `"low-confidence"`, `"large-cap+low-confidence"`, `"extreme-move"`. `null` when the event did not enter pending.                                                                                                                                                                                   |
| `closeReason`         | `string \| null`       | Why an ended live row closed. Recovery values are `"recovered-primary"`, `"recovered-dex"`, and `"recovered-native"`; non-recovery terminal values are `"coverage-lost-supply"`, `"superseded-direction"`, and `"orphan-tracking-removed"`. `null` for open rows and legacy/backfill rows without a classified terminal reason.                                                |
| `constituentEventCount` | `number \| undefined` | Raw threshold crossings grouped into this incident; `1` for ungrouped rows. |
| `provenance`          | `object \| null`       | Public replay/audit metadata when available: `sourceKind`, `replayRunId`, `replayVersion`, `sourcePriceProviders`, `quoteMode`, `pegReferenceSource`, `supplySource`, `confirmationPolicy`, `confirmationPointCount`, `confidenceTier`, `auditVerdict`, `pegScoreEligible`, and `updatedAt`. Legacy rows return `null`.                                                        |

**`DepegPendingIncident`** — returned only when `includePending=true`

| Field                             | Type                 | Description                                                                                  |
| --------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `stablecoinId`                    | `string`             | Pharos stablecoin ID                                                                         |
| `symbol`                          | `string`             | Token symbol                                                                                 |
| `direction`                       | `"above" \| "below"` | Pending deviation direction                                                                  |
| `firstSeenAt`                     | `number`             | Unix seconds when the pending incident was first observed                                    |
| `lastSeenAt`                      | `number`             | Unix seconds when the pending incident was last refreshed                                    |
| `firstSeenBps`                    | `number`             | First observed deviation in basis points                                                     |
| `lastSeenBps`                     | `number`             | Most recent observed deviation in basis points                                               |
| `peakSeenBps`                     | `number`             | Worst observed pending deviation in basis points                                             |
| `reason`                          | `string`             | Pending lane reason, e.g. `"large-cap"` or `"large-cap+low-confidence"`                      |
| `ageSec`                          | `number`             | Seconds elapsed since `firstSeenAt`                                                          |
| `expiresAt`                       | `number`             | Unix seconds when the pending row expires if it is not confirmed                             |
| `availableConfirmationCategories` | `string[]`           | Confirmation categories currently derivable from public metadata / D1 snapshots              |
| `missingConfirmationCategories`   | `string[]`           | Expected confirmation categories not currently derivable from public metadata / D1 snapshots |

**`methodology`**

| Field                 | Type      | Description                                                             |
| --------------------- | --------- | ----------------------------------------------------------------------- |
| `version`             | `string`  | Methodology version attributed from the latest returned event timestamp |
| `versionLabel`        | `string`  | Display label (e.g. `"v5.94"`)                                          |
| `currentVersion`      | `string`  | Latest methodology version                                              |
| `currentVersionLabel` | `string`  | Display label for latest methodology version                            |
| `changelogPath`       | `string`  | Relative URL to the methodology changelog page                          |
| `asOf`                | `number`  | Unix timestamp used for methodology attribution                         |
| `isCurrent`           | `boolean` | Whether `version` matches `currentVersion`                              |

---

### `GET /api/depeg-resolver`

Cache-backed Depeg Duration Resolver readouts for active/current confirmed depeg incidents. DDRv4 emits one row per canonical incident projection, keyed by `incidentKey`, and separates live facts from the official public lock outcome.

**Cache:** standard — `X-Data-Age` and `Warning` headers included. Freshness threshold: 900 s. Missing or invalid snapshots return `200` with `_meta.degraded=true` and `rows: []`; stale snapshots mark `_meta.degraded=true`, include the read overlay when available, and keep pre-publication rows free of verdict/duration details.

**Row states**

| State                       | Meaning                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending_lock`              | Incident is active but has not sealed through forecast readiness or the 72h backstop. Live facts plus trigger/readiness metadata may render; no verdict or duration is exposed.              |
| `lock_deferred`             | Forecast readiness or the 72h backstop triggered, but a deterministic system-health predicate failed. Shows deferral/retry status only; no no-call, verdict, or duration is created.         |
| `publication_retry_pending` | A lock outcome sealed, but first-publication manifest finalization has not succeeded. The sealed outcome stays hidden until publication.                                                     |
| `frozen`                    | First-published official prediction. Shows frozen verdict/duration, lock timestamp, lock timing, anchored duration, immutable trigger/readiness metadata, and live overlay facts separately. |
| `no_call`                   | Healthy lock run had insufficient row-level signal. Shows missing inputs and lock metadata, not a recovery/terminal verdict.                                                                 |
| `invalidated`               | Append-only erratum invalidated the original first-published prediction or no-call; original exposure remains visible with correction history.                                               |

**Lock readiness/backstop contract**

- Forecast readiness is a readiness score, not a probability or confidence value.
- A readiness lock is eligible only when `prediction.readiness.score > 0.75` (strictly greater than; exactly `0.75` is not ready). The readiness contract version is `readiness-72h-v1`.
- If no healthy run crosses readiness first, the backstop seals on the first healthy run at or after `startedAt + 72h`.
- Health failures at either trigger produce `lock_deferred`; the next healthy run seals only if the incident is still unresolved and non-terminal.
- If the incident recovers before a healthy lock, DDRR reports `resolved_before_prediction`; reliable terminal evidence before a healthy lock becomes `terminal_before_prediction`. For rollout-active incidents that already existed when DDRv2 became the public prediction contract, DDRR floors this boundary at the DDRv2 effective timestamp so outcomes that predate any possible public prediction are not treated as live missed locks.
- First-published prediction metadata is immutable and includes `lockTrigger` (`forecast_readiness`, `readiness_backstop`, or legacy/default `scheduled_24h`), the `readiness` object (`version`, `score`, `threshold`, `strictEarlyLockReady`, `reasons`, `components`), the `backstop` object (`version`, `delaySec`, `backstopAt`, `reached`), deferral reason/count metadata, and policy version.
- Current readiness/backstop rows may still carry `predictionPolicyVersion="sticky-24h-v1"` for compatibility with the existing policy universe. Distinguish fixed-24h legacy exposures from readiness/backstop outcomes using `lockTrigger`, `policyDelaySec`, readiness/backstop metadata, and methodology version. Existing DDRv2 rows remain valid and keep `policyDelaySec=86400` with default `lockTrigger="scheduled_24h"`.

**Pre-lock lifecycle:** an unsealed incident that recovers is logically `closed_pre_lock` after the settle margin. It is excluded from active locking and the live DDR projection, never receives a frozen outcome, and remains in DDRR coverage as `resolved_before_prediction`. A later matching event inside the six-hour reopen window resurrects the same incident; a regime-escalating sealed tail instead starts a new incident.

**Response**

```text
{
  "_meta": {
    "schemaVersion": 2,
    "dataAsOf": 1779700000,
    "modelAsOf": 1779700000,
    "computedAt": 1779700000,
    "expiresAt": 1779701800,
    "snapshotToken": "ddrpub_...",
    "snapshotGeneration": 3,
    "publicPredictionIds": [101, 102],
    "publicPredictionRowHashes": { "101": "..." },
    "basePayloadHash": "...",
    "readOverlay": {
      "degradedLockDeferralIncidentKeys": [],
      "closedPendingReviewIncidentKeys": [],
      "suppressedIncidentKeys": []
    },
    "degraded": false,
    "degradedReason": null,
    "publicWarning": "Forecast from Pharos historical data. Not investment advice or a credit rating.",
    "resolutionRubricVersion": "resolution-rubric-v3",
    "durationModelVersion": "duration-landmark-v2",
    "durationBand": { "label": "typical_range", "lowerPercentile": 15, "upperPercentile": 85 },
    "incidentGroupingVersion": "incident-group-v3",
    "supportRulesVersion": "support-rules-v2",
    "lineage": { "eventCount": 34129, "incidentCount": 1820, "coinCount": 142, "quarantinedCoins": 7 }
  },
  "rows": [DdrV2ResponseRow, ...],
  "methodology": { "version": "4.0", "versionLabel": "v4.0", "changelogPath": "/methodology/depeg-resolver-changelog/" }
}
```

`DdrV2ResponseRow.kind` is one of `pending`, `prediction`, `no_call`, or `invalidated_prediction`; the type name remains for backward compatibility with the v2 schema generation. `prediction.state` carries the public state above. Prediction rows include `frozen.resolution` and `frozen.duration`; no-call rows include `noCall.missingReasons`; invalidated rows include `originalOutcome`, `latestErratum`, and errata history. `_meta.durationBand` defines the meaning of legacy `iqrSec` fields: the typical p15–p85 remaining-duration range. All rows include a `live` overlay with current event age, peak/current deviation, event state, freshness, and degraded reason.

---

### `GET /api/depeg-resolver-review`

Cache-backed Depeg Duration Resolver Reviewer snapshot. DDRR reviews frozen public predictions and no-calls that reached first publication, then reports the full incident-scoped policy universe so missing predictions are visible coverage debt rather than silently excluded. The reviewer engine is identified by `reviewerVersion="ddr-reviewer-v4"` while DDR methodology versions can advance independently.

**Cache:** standard — `X-Data-Age` and `Warning` headers included. Freshness threshold: 900 s. Missing or invalid snapshots return `200` with `_meta.degraded=true`, an empty summary, and `rows: []`; stale snapshots keep review rows but set `_meta.degraded=true` and `degradedReason="stale-cache"`.

**Headline fields**

| Field                                            | Type             | Meaning                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.headline.recoveryLikelihoodAccuracyPct` | `number \| null` | Strict scored DDR recovery-verdict accuracy over first-published frozen predictions.                                                                                                        |
| `summary.headline.meanSignedDurationErrorSec`    | `number \| null` | Mean observed-minus-DDR duration error for recovered rows with a DDR median remaining-time estimate. Positive means observed recovery was slower than DDR predicted; negative means faster. |
| `summary.headline.meanAbsoluteDurationErrorSec`  | `number \| null` | Mean absolute duration miss for the same scored recovered rows.                                                                                                                             |
| `summary.headline.durationScoredCount`           | `number`         | Number of recovered, duration-scored rows included in duration-error averages.                                                                                                              |
| `summary.headline.predictionRatePct`             | `number \| null` | Share of eligible finalized incidents that received a published prediction/no-call decision.                                                                                                |
| `summary.headline.finalizedCoveragePct`          | `number \| null` | Share of the policy universe assigned to a finalized/public coverage state.                                                                                                                 |
| `summary.headline.noCallRatePct`                 | `number \| null` | Share of finalized lock outcomes that became no-calls.                                                                                                                                      |
| `summary.headline.invalidatedPct`                | `number \| null` | Share of first-published predictions invalidated by errata.                                                                                                                                 |
| `summary.headline.horizonCalibration`            | `array`           | Per horizon: scored count, mean predicted probability, realized closure share, percentage-point bias, and Poisson-binomial normal-approximation z-score.                                  |

**Response**

```text
{
  "_meta": {
    "computedAt": 1779700000,
    "expiresAt": 1779701800,
    "degraded": false,
    "degradedReason": null,
    "reviewerVersion": "ddr-reviewer-v4",
    "assessedEventCount": 12,
    "reviewedEventCount": 12,
    "pendingEventCount": 8,
    "durationScoredCount": 6,
    "verdictScoredCount": 10,
    "methodologyVersions": ["3.04"]
  },
  "summary": {
    "headlineScope": "current_policy",
    "headlineLabel": "Current DDRv2 public prediction policy",
    "headline": {
      "policyUniverseIncidentCount": 20,
      "predictionRatePct": 0.65,
      "finalizedCoveragePct": 0.9,
      "noCallRatePct": 0.1,
      "invalidatedPct": 0.05,
      "recoveryLikelihoodAccuracyPct": 0.7,
      "meanSignedDurationErrorSec": 3600,
      "meanAbsoluteDurationErrorSec": 7200,
      "horizonHitRates": [{ "horizon": "6h", "scored": 5, "hits": 3, "misses": 2, "hitRate": 0.6 }],
      "horizonCalibration": [{ "horizon": "6h", "scored": 5, "meanPredictedProbability": 0.58, "realizedClosureShare": 0.6, "biasPp": 2, "zScore": 0.09 }]
    },
    "byPredictionPolicy": []
  },
  "rows": [DdrrRow, ...],
  "methodology": { "version": "4.0", "versionLabel": "v4.0", "changelogPath": "/methodology/depeg-resolver-changelog/" }
}
```

`DdrrRow.kind` is one of `prediction_review`, `no_call_review`, `coverage`, or `invalidated_prediction`. Only `prediction_review` rows enter recovery-likelihood and duration accuracy. `no_call_review` rows are deliberate lock outcomes but unscored. `coverage` rows include states such as `resolved_before_prediction`, `terminal_before_prediction`, `missed_lock_recovered`, `missed_lock_terminal`, `publication_retry_pending`, and `publication_failed`. Rollout-active incidents whose reliable recovery or terminal evidence predates the DDRv2 public prediction contract are reported as pre-lock coverage, not missed-lock debt. `closed_pre_lock` incidents are retained in that coverage universe as `resolved_before_prediction`. `invalidated_prediction` rows retain original exposure and attach errata history. Rows with recorded lineage may include `lineage.autoRepaired=true` plus `lineage.repairSources` for a writer or repair-runner link, and `lineage.parentIncidentKey` when the incident was split from a sealed parent. Policy-version breakdowns keep old `sticky-24h-v1` rows separate from readiness/backstop rows when reviewing trigger behavior.

---

### `GET /api/peg-summary`

Composite peg scores and aggregate statistics. Score history begins at each coin's reviewed coverage anchor or age-derived fallback. `coins` may include NAV / non-peg rows with `currentDeviationBps = null`; summary counters exclude them.

**Cache:** producer-backed

**Response**

```text
{
  "coins": [PegSummaryCoin, ...],
  "summary": PegSummaryStats,
  "methodology": {
    "version": "6.21",
    "versionLabel": "v6.21",
    "currentVersion": "6.21",
    "currentVersionLabel": "v6.21",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1772606400,
    "isCurrent": true
  }
}
```

**`PegSummaryCoin`**

| Field                       | Type                                                       | Description                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `string`                                                   | Pharos stablecoin ID                                                                                                                                                                                                                                                                                                                                                |
| `symbol`                    | `string`                                                   | Token symbol                                                                                                                                                                                                                                                                                                                                                        |
| `name`                      | `string`                                                   | Full name                                                                                                                                                                                                                                                                                                                                                           |
| `pegType`                   | `string`                                                   | DefiLlama peg type                                                                                                                                                                                                                                                                                                                                                  |
| `pegCurrency`               | `string`                                                   | Peg currency code (`USD`, `EUR`, `GOLD`, etc.)                                                                                                                                                                                                                                                                                                                      |
| `governance`                | `string`                                                   | `"centralized"`, `"centralized-dependent"`, `"decentralized"`                                                                                                                                                                                                                                                                                                       |
| `currentDeviationBps`       | `number \| null`                                           | Live price deviation from peg (basis points, signed). `null` for NAV / non-fixed-peg rows, for coins with current supply below the live depeg-event floor, when price / peg-reference inputs are missing, or when `pegReferenceUnavailable` is set.                                                                                                                 |
| `depegEventCoverageLimited` | `boolean`                                                  | Present when the coin's current supply is below the live depeg-event floor (`$1M`). Use this to distinguish "below coverage floor" from generic missing-price cases when `currentDeviationBps` is `null`.                                                                                                                                                           |
| `pegReferenceUnavailable`   | `boolean \| undefined`                                     | Present (`true`) since v6.08 when the coin's peg reference lacks authority — a thin non-USD peer-median group with no live FX fallback — so `currentDeviationBps` is withheld as `null` instead of showing a self-referential deviation.                                                                                                                            |
| `priceSource`               | `string`                                                   | Primary price source label used for current deviation (`defillama-list`, `coingecko`, composite agreement labels such as `binance+coingecko+kraken`, `protocol-redeem`, `defillama-contract`, `coinmarketcap`, `dexscreener`, `cached`, etc.). High-confidence consensus can expose the agreeing cluster label even when the published price is the cluster median. |
| `priceConfidence`           | `"high" \| "single-source" \| "low" \| "fallback" \| null` | Confidence tier attached to the primary price input                                                                                                                                                                                                                                                                                                                 |
| `priceUpdatedAt`            | `number \| null`                                           | Compatibility timestamp for the primary price; now mirrors the effective observation time rather than the cache-write time                                                                                                                                                                                                                                          |
| `priceObservedAt`           | `number \| null`                                           | Unix seconds for the effective observation time attached to the selected primary price; interpret alongside `priceObservedAtMode`                                                                                                                                                                                                                                   |
| `priceObservedAtMode`       | `"upstream" \| "local_fetch" \| "unknown" \| null`         | Whether `priceObservedAt` came from source-native freshness metadata, local fetch time, or legacy/unknown provenance                                                                                                                                                                                                                                                |
| `priceSyncedAt`             | `number \| null`                                           | Unix seconds when Pharos selected and wrote the primary price during the sync                                                                                                                                                                                                                                                                                       |
| `primaryTrust`              | `"authoritative" \| "confirm_required" \| "unusable"`      | Whether the current primary price is trusted to mutate live depeg state directly                                                                                                                                                                                                                                                                                    |
| `pegReference`              | `object \| undefined`                                       | Peg value/source evidence, contributor count, and `asOf`; live fiat FX precedes peer medians. |
| `pegScore`                  | `number \| null`                                           | Composite peg score 0–100 (higher = more stable)                                                                                                                                                                                                                                                                                                                    |
| `pegPct`                    | `number`                                                   | % of tracked time within ±100 bps                                                                                                                                                                                                                                                                                                                                   |
| `severityScore`             | `number`                                                   | Severity sub-score (0–100)                                                                                                                                                                                                                                                                                                                                          |
| `spreadPenalty`             | `number`                                                   | Spread/liquidity penalty applied to score                                                                                                                                                                                                                                                                                                                           |
| `eventCount`                | `number`                                                   | Number of depeg events in the 4-year window                                                                                                                                                                                                                                                                                                                         |
| `worstDeviationBps`         | `number \| null`                                           | Worst single deviation seen (basis points)                                                                                                                                                                                                                                                                                                                          |
| `activeDepeg`               | `boolean`                                                  | Whether a depeg event is currently open                                                                                                                                                                                                                                                                                                                             |
| `lastEventAt`               | `number \| null`                                           | Unix seconds of most recent depeg event                                                                                                                                                                                                                                                                                                                             |
| `trackingSpanDays`          | `number`                                                   | Days of history used for score computation                                                                                                                                                                                                                                                                                                                          |
| `historyCoverage` / `recent90d` | `object \| undefined`                                  | Coverage anchor (`startedAt`, source, verification) and 90-day observed days, limited flag, peg percentage, incident/crossing counts, and worst deviation, respectively. |
| `methodologyVersion`        | `string`                                                   | Methodology version attributed to this coin snapshot                                                                                                                                                                                                                                                                                                                |
| `dexPriceCheck`             | `DexPriceCheck \| null`                                    | Optional cross-validation against DEX price (shown when coin supply is at or above the live depeg-event floor, DEX data is ≤ 60 minutes old, and aggregate source TVL is ≥ $250K)                                                                                                                                                                                   |
| `consensusSources`          | `string[]`                                                 | Source names that returned a valid price for this coin. Defaults to `[]` when absent.                                                                                                                                                                                                                                                                               |
| `agreeSources`              | `string[] \| undefined`                                    | Compatibility alias for agreeing/current price sources when present                                                                                                                                                                                                                                                                                                 |

**`DexPriceCheck`**

| Field             | Type      | Description                                         |
| ----------------- | --------- | --------------------------------------------------- |
| `dexPrice`        | `number`  | DEX-derived price (USD)                             |
| `dexDeviationBps` | `number`  | DEX price deviation from peg (basis points, signed) |
| `agrees`          | `boolean` | Whether primary and DEX prices are within 50 bps    |
| `sourcePools`     | `number`  | Number of DEX pools contributing to the price       |
| `sourceTvl`       | `number`  | Combined TVL of those pools (USD)                   |

**`PegSummaryStats`**

| Field                  | Type                          | Description                                                                                                                   |
| ---------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `activeDepegCount`     | `number`                      | Coins with an open depeg event                                                                                                |
| `medianDeviationBps`   | `number`                      | Median absolute deviation across rows with a live current deviation                                                           |
| `worstCurrent`         | `{ id, symbol, bps } \| null` | Coin with the largest current deviation among rows with a live current deviation                                              |
| `coinsAtPeg`           | `number`                      | Rows with a live current deviation that are below their live depeg threshold (100 bps for USD pegs, 150 bps for non-USD pegs) |
| `totalTracked`         | `number`                      | Rows included in the live peg-status aggregate (`currentDeviationBps !== null`)                                               |
| `depegEventsToday`     | `number`                      | Number of depeg events whose `startedAt` is in the current UTC day                                                            |
| `depegEventsYesterday` | `number`                      | Number of depeg events whose `startedAt` is in the previous UTC day                                                           |
| `fxPegRates`           | `string[]`                    | _(optional)_ peg types using live FX                                                                                           |
| `fallbackPegRates`     | `string[]`                    | _(optional)_ peg types using non-FX references                                                                                |

**`methodology`** — same fields and semantics as `/api/depeg-events`

---

### `GET /api/usds-status`

Sky/USDS protocol status — whether the current implementation exposes freeze/blacklist capability.

**Cache:** standard — `X-Data-Age` and `Warning` headers included.

**Response**

```json
{
  "freezeCapabilityPresent": false,
  "implementationAddress": "0x1923dfee706a8e78157416c29cbccfde7cdf4102",
  "lastChecked": 1771809338,
  "_meta": { "updatedAt": 1710500000, "ageSeconds": 42, "status": "fresh" }
}
```

| Field                     | Type      | Description                                                                 |
| ------------------------- | --------- | --------------------------------------------------------------------------- |
| `freezeCapabilityPresent` | `boolean` | Whether the current USDS implementation exposes freeze/blacklist capability |
| `implementationAddress`   | `string`  | Address of the current USDS implementation contract                         |
| `lastChecked`             | `number`  | Unix seconds when this was last fetched on-chain                            |

---

### `GET /api/bluechip-ratings`

Safety ratings from [bluechip.org](https://bluechip.org) for covered stablecoins. Updated daily at 08:05 UTC.

**Cache:** slow — `X-Data-Age` and `Warning` headers included.

**Response:** Object keyed by Pharos stablecoin ID, plus top-level `_meta` freshness metadata.

```text
{
  "usdt-tether": BluechipRating,
  "usdc-circle": BluechipRating,
  "_meta": { "updatedAt": 1710500000, "ageSeconds": 42, "status": "fresh" }
}
```

**`BluechipRating`**

| Field                | Type             | Description                                         |
| -------------------- | ---------------- | --------------------------------------------------- |
| `grade`              | `string`         | Letter grade: `"A+"`, `"A"`, `"A-"`, `"B+"` … `"F"` |
| `slug`               | `string`         | Bluechip report slug (e.g. `"usdt"`)                |
| `collateralization`  | `number`         | Collateralization percentage                        |
| `smartContractAudit` | `boolean`        | Whether an audit exists                             |
| `dateOfRating`       | `string`         | ISO 8601 date of rating                             |
| `dateLastChange`     | `string \| null` | ISO 8601 date of last grade change                  |
| `smidge`             | `BluechipSmidge` | Plain-text evaluation summaries (HTML stripped)     |

**`BluechipSmidge`** — each field is `string | null`:

| Field              | Description                                      |
| ------------------ | ------------------------------------------------ |
| `stability`        | Reserves management and stabilization mechanisms |
| `management`       | Personnel restrictions and track records         |
| `implementation`   | Smart contract implementation assessment         |
| `decentralization` | Decentralization posture                         |
| `governance`       | Governance and redemption terms                  |
| `externals`        | External risk factors                            |

---

### `GET /api/dex-liquidity`

DEX liquidity scores, pool breakdowns, source-confidence metadata, and on-chain DEX price data for all tracked stablecoins. Updated every 30 minutes. Trend data is only returned when a trusted historical baseline exists.

**Cache:** custom — `public, s-maxage=300, max-age=300`

**Freshness note:** In addition to stale-data warnings, this endpoint can also emit a `Warning` header when the latest `sync-dex-liquidity` run finished in `degraded` or `error` state and the API is serving the last successful dataset.

**Response:** Object keyed by Pharos stablecoin ID plus a `__global__` aggregate sentinel row.

```text
{
  "usdt-tether": DexLiquidityData,
  "usdc-circle": DexLiquidityData,
  "__global__": DexLiquidityData
}
```

**`DexLiquidityData`**

| Field                          | Type                                                                        | Description                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalTvlUsd`                  | `number`                                                                    | Total DEX TVL (USD)                                                                                                                                                                                                                                                       |
| `totalVolume24hUsd`            | `number`                                                                    | 24 h trading volume (USD)                                                                                                                                                                                                                                                 |
| `totalVolume7dUsd`             | `number \| null`                                                            | 7-day trading volume (USD), or `null` when retained pools include sources that do not publish measured 7-day volume                                                                                                                                                       |
| `poolCount`                    | `number`                                                                    | Number of liquidity pools                                                                                                                                                                                                                                                 |
| `pairCount`                    | `number`                                                                    | Number of unique trading pairs                                                                                                                                                                                                                                            |
| `chainCount`                   | `number`                                                                    | Number of chains with active pools                                                                                                                                                                                                                                        |
| `protocolTvl`                  | `Record<string, number>`                                                    | TVL per DEX protocol (e.g. `{ "uniswap-v3": 100000 }`)                                                                                                                                                                                                                    |
| `chainTvl`                     | `Record<string, number>`                                                    | TVL per chain (e.g. `{ "Ethereum": 500000 }`)                                                                                                                                                                                                                             |
| `topPools`                     | `DexLiquidityPool[]`                                                        | Top 10 retained pools sorted by 24h volume, then TVL                                                                                                                                                                                                                      |
| `liquidityScore`               | `number \| null`                                                            | Composite liquidity score 0–100                                                                                                                                                                                                                                           |
| `concentrationHhi`             | `number \| null`                                                            | Herfindahl–Hirschman Index for pool concentration (0–1; lower = more distributed), computed from the full retained pool set before top-10 truncation                                                                                                                      |
| `depthStability`               | `number \| null`                                                            | Pool depth stability metric                                                                                                                                                                                                                                               |
| `tvlChange24h`                 | `number \| null`                                                            | % TVL change vs. 24 h ago                                                                                                                                                                                                                                                 |
| `tvlChange7d`                  | `number \| null`                                                            | % TVL change vs. 7 days ago                                                                                                                                                                                                                                               |
| `updatedAt`                    | `number`                                                                    | Unix seconds of last cron update                                                                                                                                                                                                                                          |
| `dexPriceUsd`                  | `number \| null`                                                            | DEX-derived price (USD)                                                                                                                                                                                                                                                   |
| `dexDeviationBps`              | `number \| null`                                                            | DEX price deviation from peg (basis points, signed)                                                                                                                                                                                                                       |
| `priceSourceCount`             | `number \| null`                                                            | Number of pools used for DEX price (all must meet the shared $50K observation floor)                                                                                                                                                                                      |
| `priceSourceTvl`               | `number \| null`                                                            | Combined TVL of price-source pools (USD)                                                                                                                                                                                                                                  |
| `priceSources`                 | `DexPriceSource[] \| null`                                                  | Aggregated price sources by protocol (for example one `balancer` or `raydium` entry per asset)                                                                                                                                                                            |
| `effectiveTvlUsd`              | `number`                                                                    | TVL after applying quality multipliers                                                                                                                                                                                                                                    |
| `avgPoolStress`                | `number \| null`                                                            | Average pool stress index on a 0–100 scale (0 = balanced, 100 = maximally stressed / imbalanced)                                                                                                                                                                          |
| `weightedBalanceRatio`         | `number \| null`                                                            | TVL-weighted balance ratio across pools                                                                                                                                                                                                                                   |
| `organicFraction`              | `number \| null`                                                            | Fraction of TVL from organic (non-incentivized) pools                                                                                                                                                                                                                     |
| `durabilityScore`              | `number \| null`                                                            | Score for pool maturity and reliability                                                                                                                                                                                                                                   |
| `coverageClass`                | `"primary" \| "mixed" \| "fallback" \| "legacy" \| "unobserved" \| null`    | Coverage-confidence classification for the retained pool set; `primary` includes pure `dl` and pure `direct_api` rows. The `__global__` aggregate sentinel uses `null`.                                                                                                   |
| `coverageConfidence`           | `number`                                                                    | Evidence-weighted confidence (`0-1`) derived from retained-pool breadth, measured TVL share, and synthetic/decayed dependence                                                                                                                                             |
| `liquidityEvidenceClass`       | `"unobserved" \| "measured" \| "partial_measured" \| "observed_unmeasured"` | Coverage-confidence evidence class: `measured` for high-confidence primary coverage, `partial_measured` for high-confidence mixed coverage, informational otherwise                                                                                                       |
| `hasMeasuredLiquidityEvidence` | `boolean`                                                                   | Whether the row's coverage-confidence evidence qualifies as measured or partially measured                                                                                                                                                                                |
| `trendworthy`                  | `boolean`                                                                   | Whether this row is suitable for trend baselines (`coverageConfidence >= 0.75`, positive TVL, and `primary`/`mixed` coverage)                                                                                                                                             |
| `sourceMix`                    | `Record<string, { poolCount: number; tvlUsd: number }>`                     | TVL/pool-count mix across source families (`dl`, `direct_api`, `cg_onchain`, `gecko_terminal`, `dexscreener`, `cg_tickers`)                                                                                                                                               |
| `balanceMeasuredTvlUsd`        | `number`                                                                    | TVL denominator actually used for `weightedBalanceRatio`                                                                                                                                                                                                                  |
| `organicMeasuredTvlUsd`        | `number`                                                                    | TVL denominator actually used for `organicFraction`                                                                                                                                                                                                                       |
| `scoreComponents`              | `ScoreComponents \| null`                                                   | Breakdown of the composite liquidity score                                                                                                                                                                                                                                |
| `lockedLiquidityPct`           | `number \| null`                                                            | TVL-weighted fraction of liquidity reported as locked by source pools                                                                                                                                                                                                     |
| `methodologyVersion`           | `string`                                                                    | Methodology version attributed to this row                                                                                                                                                                                                                                |
| `deploymentCoverage`           | `object \| null`                                                            | Exact deployment outcome summary and rows. Each contract is `observed_pools`, `verified_no_pools`, or `provider_inaccessible`; active owned waivers include owner, reason, and expiry. `null` means the additive outcome ledger has not published a row for the coin yet. |

**`ScoreComponents`**

| Field            | Type     | Description               |
| ---------------- | -------- | ------------------------- |
| `tvlDepth`       | `number` | TVL depth sub-score       |
| `volumeActivity` | `number` | Volume activity sub-score |
| `poolQuality`    | `number` | Pool quality sub-score    |
| `durability`     | `number` | Durability sub-score      |
| `pairDiversity`  | `number` | Pair diversity sub-score  |

**`DexLiquidityPool`**

| Field         | Type                  | Description                                                                                                             |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `project`     | `string`              | Protocol slug (e.g. `"curve-dex"`, `"uniswap-v3"`)                                                                      |
| `chain`       | `string`              | Chain name                                                                                                              |
| `tvlUsd`      | `number`              | Pool TVL (USD)                                                                                                          |
| `symbol`      | `string`              | Pool pair name (e.g. `"USDC-USDT"`), normalized to tracked tickers when direct-API sources only provide token addresses |
| `volumeUsd1d` | `number`              | 24 h volume (USD)                                                                                                       |
| `poolType`    | `string`              | Pool type (e.g. `"curve-stableswap"`, `"uniswap-v3-5bp"`)                                                               |
| `source`      | `string \| undefined` | Canonical source family for this retained pool                                                                          |
| `extra`       | `object \| undefined` | Optional detailed pool metrics (A-factor, balance ratio, measurement flags, etc.)                                       |

`extra` may include:

| Field                      | Type                                                                             | Description                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amplificationCoefficient` | `number \| undefined`                                                            | Curve amplification coefficient (`A`)                                                                                                                           |
| `balanceRatio`             | `number \| undefined`                                                            | Measured pool balance ratio from 0 to 1; Balancer weighted pools normalize against weights and Fluid uses official DexReservesResolver balances where deployed  |
| `feeTier`                  | `number \| undefined`                                                            | Normalized fee tier in basis points                                                                                                                             |
| `balanceDetails`           | `Array<{ symbol: string; balancePct: number; isTracked: boolean }> \| undefined` | Per-token USD composition shares used for balance tooltips/detail                                                                                               |
| `measurement`              | `object \| undefined`                                                            | Per-pool provenance flags such as `tvlMeasured`, `volumeMeasured`, `balanceMeasured`, `maturityMeasured`, `priceMeasured`, `synthetic`, `decayed`, and `capped` |
| `executionCapabilityGate`  | `object \| undefined`                                                            | Reviewed fail-closed family/reason for an exact-capability pool that cannot currently emit score-eligible executable evidence                                          |
| `ammExecutionModel`        | `object \| undefined`                                                            | Proof-bearing exact AMM inputs retained for supported reserve-based execution models                                                                                   |
| `measuredExecution`        | `object \| undefined`                                                            | Proof-free public measured-depth profile with quote time, block, endpoint provenance, token identities, marginal ratio, and capacity curve; raw call proofs stay in D1 |

**`DexPriceSource`**

| Field      | Type     | Description            |
| ---------- | -------- | ---------------------- |
| `protocol` | `string` | DEX protocol name      |
| `chain`    | `string` | Chain name             |
| `price`    | `number` | Price from this source |
| `tvl`      | `number` | TVL of this pool (USD) |

---

### `GET /api/dex-liquidity-history`

Per-coin historical DEX liquidity snapshots. Snapshots are recorded daily (UTC midnight, first sync after day rollover). Baseline consumers should use `coverageClass` / `coverageConfidence` before treating a history point as trend-worthy.

**Cache:** slow — `public, s-maxage=3600, max-age=300`

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param  | Type      | Default | Bounds | Description             |
| ------ | --------- | ------- | ------ | ----------------------- |
| `days` | `integer` | `90`    | 1–365  | Lookback window in days |

**Response:** Array sorted by `date` ascending.

```json
[
  {
    "tvl": 1658000000,
    "volume24h": 1700000000,
    "score": 93,
    "date": 1771500000,
    "coverageClass": "mixed",
    "coverageConfidence": 0.85,
    "liquidityEvidenceClass": "partial_measured",
    "hasMeasuredLiquidityEvidence": true,
    "trendworthy": true,
    "methodologyVersion": "3.1"
  }
]
```

| Field                          | Type             | Description                                                                                                                                                    |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tvl`                          | `number`         | Total DEX TVL snapshot (USD)                                                                                                                                   |
| `volume24h`                    | `number`         | 24 h volume at time of snapshot (USD)                                                                                                                          |
| `score`                        | `number \| null` | Liquidity score at time of snapshot                                                                                                                            |
| `date`                         | `number`         | Unix seconds                                                                                                                                                   |
| `coverageClass`                | `string`         | Snapshot confidence class (`primary`, `mixed`, `fallback`, `legacy`, `unobserved`)                                                                             |
| `coverageConfidence`           | `number`         | Snapshot confidence score                                                                                                                                      |
| `liquidityEvidenceClass`       | `string`         | Snapshot evidence class (`measured`, `partial_measured`, `observed_unmeasured`, `unobserved`) using the same coverage-confidence rules as `/api/dex-liquidity` |
| `hasMeasuredLiquidityEvidence` | `boolean`        | Whether the snapshot's coverage-confidence evidence qualifies as measured or partially measured                                                                |
| `trendworthy`                  | `boolean`        | Whether the snapshot is suitable for trend baselines rather than informational use                                                                             |
| `methodologyVersion`           | `string`         | Methodology version attributed to this snapshot                                                                                                                |

---

### `GET /api/supply-history`

Per-coin circulating supply and price history. The `snapshot-supply` cron writes one snapshot per UTC day; it runs on the quarter-hourly trigger once the previous day's snapshot is at least 20 hours old, with an 08:00 UTC daily trigger as a safety-net fallback.

**Cache:** slow — `public, s-maxage=3600, max-age=300`

Freshness headers are emitted from the latest completed `snapshot-supply` run when available. Rows newer than the completed daily snapshot marker are hidden so a failed chunked write cannot expose a partial latest day.

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param  | Type      | Default | Bounds | Description             |
| ------ | --------- | ------- | ------ | ----------------------- |
| `days` | `integer` | `365`   | 1–5000 | Lookback window in days |

**Response:** Array sorted by `date` ascending.

```json
[
  {
    "date": 1771500000,
    "circulatingUsd": 138000000000,
    "price": 1.0001
  }
]
```

| Field            | Type             | Description                                                   |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| `date`           | `number`         | Unix seconds                                                  |
| `circulatingUsd` | `number`         | Circulating supply in USD                                     |
| `price`          | `number \| null` | Price at snapshot time (USD); may be `null` for older records |

---

### `GET /api/daily-digest`

Latest AI-generated market summary, produced daily at 08:05 UTC via the Claude API.

**Cache:** standard. When a digest exists, the response includes `X-Data-Age` and `Warning` freshness headers keyed to a 24 h endpoint budget. The bootstrap `{ "digest": null }` response carries only `Cache-Control`.

**Response**

```json
{
  "digest": "USDC absorbed $812M of the market's $1.36B weekly inflow…",
  "editionNumber": 214,
  "riskSignal": {
    "kind": "depeg",
    "symbol": "PMUSD",
    "bps": -5284,
    "mcapUsd": 65610000,
    "severity": "critical",
    "activeCount": 7,
    "date": null
  },
  "riskTape": [{ "id": "risk-tape:depegs", "label": "Depegs", "value": "PMUSD 5284bps", "tone": "critical" }],
  "nextTriggers": [
    {
      "id": "trigger:depeg:pmusd",
      "label": "PMUSD depeg widening",
      "metric": "depeg-bps",
      "comparator": "abs-gte",
      "thresholdLabel": "5500 bps off peg",
      "thresholdValue": 5500,
      "symbol": "PMUSD",
      "rationale": "A wider deviation raises severity.",
      "detail": "If PMUSD reaches 5500 bps off peg, severity rises."
    }
  ]
}
```

If no digest exists yet, the endpoint returns only `{ "digest": null }`.

| Field                 | Type                                 | Description                                                                                                                                     |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `digest`              | `string \| null`                     | Tweet-ready summary (≤ 240 characters). `null` if no digest has been generated yet.                                                             |
| `digestTitle`         | `string \| null`                     | Short headline for the digest                                                                                                                   |
| `digestExtended`      | `string \| null`                     | Extended commentary for the website view                                                                                                        |
| `generatedAt`         | `number`                             | Unix seconds when this digest was generated (present only when `digest` is non-null)                                                            |
| `editionNumber`       | `number \| null`                     | Sequential daily digest number (present only when `digest` is non-null)                                                                         |
| `riskSignal`          | `DigestRiskSignal \| null`           | Compact active-depeg risk summary parsed from stored digest input data; critical depegs are prioritized before market impact and deviation size |
| `changeSummary`       | `DigestChangeSummary \| null`        | Deterministic "what changed since yesterday" summary parsed from stored digest input data                                                       |
| `nextTriggers`        | `DigestNextTrigger[] \| null`        | Structured forward-looking threshold checks for tomorrow's digest                                                                               |
| `forwardLookOutcomes` | `DigestForwardLookOutcome[] \| null` | Evaluation of the previous digest's next triggers against the latest input                                                                      |
| `riskTape`            | `DigestRiskTapeItem[] \| null`       | Compact reader-facing risk state chips parsed from stored digest input data                                                                     |

---

### `GET /api/digest-archive`

Newest-first archive of up to 365 daily and weekly digests.

**Cache:** standard

**Response**

```json
{
  "digests": [
    {
      "digestText": "USDC absorbed $812M…",
      "digestTitle": "USDC Eats the Week",
      "digestExtended": "Longer editorial…",
      "generatedAt": 1771839719,
      "psiScore": 81.1,
      "psiBand": "STEADY",
      "totalMcapUsd": 234500000000,
      "riskSignal": {
        "kind": "depeg",
        "symbol": "PMUSD",
        "bps": -5284,
        "mcapUsd": 65610000,
        "severity": "critical",
        "activeCount": 7,
        "date": "2026-05-05"
      },
      "riskTape": [{ "id": "risk-tape:depegs", "label": "Depegs", "value": "PMUSD 5284bps", "tone": "critical" }],
      "nextTriggers": [
        {
          "id": "trigger:depeg:pmusd",
          "label": "PMUSD depeg widening",
          "metric": "depeg-bps",
          "comparator": "abs-gte",
          "thresholdLabel": "5500 bps off peg",
          "thresholdValue": 5500,
          "symbol": "PMUSD",
          "rationale": "A wider deviation raises severity.",
          "detail": "If PMUSD reaches 5500 bps off peg, severity rises."
        }
      ],
      "digestType": "daily",
      "editionNumber": 214
    }
  ]
}
```

Each element uses `digestText` (note: differs from the singular `/api/daily-digest` which uses `digest`).

| Field                 | Type                                 | Description                                                                                                                                       |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `digestText`          | `string`                             | Tweet-ready summary                                                                                                                               |
| `digestTitle`         | `string \| null`                     | Short headline                                                                                                                                    |
| `digestExtended`      | `string \| null`                     | Extended commentary                                                                                                                               |
| `generatedAt`         | `number`                             | Unix seconds of generation time                                                                                                                   |
| `psiScore`            | `number \| null`                     | PSI score parsed from archived digest input data                                                                                                  |
| `psiBand`             | `string \| null`                     | PSI condition band parsed from archived digest input data                                                                                         |
| `totalMcapUsd`        | `number \| null`                     | Ecosystem market cap parsed from archived digest input data                                                                                       |
| `riskSignal`          | `DigestRiskSignal \| null`           | Compact active-depeg risk summary parsed from archived digest input data; critical depegs are prioritized before market impact and deviation size |
| `nextTriggers`        | `DigestNextTrigger[] \| null`        | Structured forward-looking threshold checks parsed from archived digest input data                                                                |
| `forwardLookOutcomes` | `DigestForwardLookOutcome[] \| null` | Evaluation of the previous digest's next triggers parsed from archived digest input data                                                          |
| `riskTape`            | `DigestRiskTapeItem[] \| null`       | Compact risk-state chips parsed from archived digest input data                                                                                   |
| `digestType`          | `"daily" \| "weekly"`                | Digest cadence for this archived entry                                                                                                            |
| `editionNumber`       | `number`                             | Sequential edition number within that digest cadence                                                                                              |

**`DigestRiskSignal`**

| Field         | Type                    | Description                                                                         |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `kind`        | `"depeg"`               | Risk signal family; currently active-depeg context                                  |
| `symbol`      | `string`                | Stablecoin symbol                                                                   |
| `bps`         | `number`                | Signed basis-point deviation where available; archive badges display absolute value |
| `mcapUsd`     | `number \| null`        | Market cap associated with the stored digest signal                                 |
| `severity`    | `"critical" \| "watch"` | `"critical"` at ≥2,500 bps and ≥$50M mcap, or ≥5,000 bps and ≥$10M mcap             |
| `activeCount` | `number`                | Active depeg count from the stored digest input, when available                     |
| `date`        | `string \| null`        | Daily input date for weekly archive entries; `null` for latest daily responses      |

**Digest intelligence fields**

| Field                              | Type                                                                                                  | Description                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DigestRiskTapeItem.id`            | `string`                                                                                              | Stable identifier for the displayed tape item                                       |
| `DigestRiskTapeItem.label`         | `string`                                                                                              | Short label such as `PSI`, `Depegs`, `Gauge`, `DEWS`, or `Supply`                   |
| `DigestRiskTapeItem.value`         | `string`                                                                                              | Already formatted compact value for display                                         |
| `DigestRiskTapeItem.tone`          | `"critical" \| "warning" \| "neutral" \| "positive"`                                                  | Presentation severity                                                               |
| `DigestRiskTapeItem.detail`        | `string`                                                                                              | Optional supporting detail                                                          |
| `DigestNextTrigger.metric`         | `"depeg-bps" \| "supply-1d-usd" \| "supply-7d-usd" \| "bank-run-gauge" \| "dews-band" \| "psi-score"` | Metric that the next daily input can evaluate                                       |
| `DigestNextTrigger.comparator`     | `"abs-gte" \| "gte" \| "lte" \| "band-gte"`                                                           | Comparison operator for `thresholdValue`                                            |
| `DigestNextTrigger.thresholdLabel` | `string`                                                                                              | Display string for the threshold                                                    |
| `DigestForwardLookOutcome.status`  | `"hit" \| "missed" \| "pending"`                                                                      | Whether the prior trigger fired, failed, or still needs more data                   |
| `DigestChangeSummary.*Signals`     | `array`                                                                                               | Buckets of signal changes, each with `id`, `label`, `kind`, `symbols`, and `detail` |

---

### `GET /api/digest-snapshot`

Contextual data snapshot for a specific digest date — includes the digest's input data, active depeg events, and blacklist events for that day. Used by SSG builds for individual digest pages.

**Cache:** archive

**Required query parameter**

| Param  | Type     | Description                                                                           |
| ------ | -------- | ------------------------------------------------------------------------------------- |
| `date` | `string` | Date in `YYYY-MM-DD` format, or `YYYY-MM-DD-weekly` for weekly recap pages (required) |

**Response**

```text
{
  "date": "2026-02-27",
  "inputData": { "aggregateUniverse": "core-stablecoins-v1", "totalMcapUsd": 230000000000, "mcap7dDelta": 0.012, ... },
  "prevInputData": { ... },
  "depegEvents": [{ "stablecoinId": "usdt-tether", "symbol": "USDT", "direction": "below", "peakDeviationBps": -150, ... }],
  "blacklistEvents": [{ "stablecoin": "USDT", "chainName": "Ethereum", "eventType": "blacklist", ... }]
}
```

| Field             | Type             | Description                                                                                     |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `date`            | `string`         | The requested date                                                                              |
| `inputData`       | `object \| null` | Digest input data for this date. Current rows include `aggregateUniverse: "core-stablecoins-v1"`; legacy rows may omit it |
| `prevInputData`   | `object \| null` | Previous day's input data for delta computation                                                 |
| `depegEvents`     | `array`          | Up to 20 depeg events active on that date, ordered by severity                                  |
| `blacklistEvents` | `array`          | Up to 50 blacklist events on that date                                                          |

**Error responses:** `400` for missing/invalid date, `404` if no digest exists for that date.

---

### `GET /api/snapshots/index`

Lists immutable public daily dataset snapshots written by the `snapshot-public-dataset` cron. Each row points to a dated payload that can be fetched through `GET /api/snapshots/:date.json`.

**Cache:** archive

**Response**

```json
{
  "snapshots": [
    {
      "snapshotDate": "2026-05-17",
      "methodologyVersions": { "reportCard": "7.25", "psi": "3.3" },
      "safetyScoreIdentity": { "model": "v8", "methodologyVersion": "7.25", "...": "..." },
      "contentHash": "sha256-hex",
      "byteSize": 1234567,
      "createdAt": 1778976000
    }
  ]
}
```

| Field                             | Type                      | Description                                   |
| --------------------------------- | ------------------------- | --------------------------------------------- |
| `snapshots`                       | `array`                   | Snapshot index sorted newest first            |
| `snapshots[].snapshotDate`        | `string`                  | UTC snapshot date in `YYYY-MM-DD` format      |
| `snapshots[].methodologyVersions` | `Record<string, string>?` | Methodology versions embedded in the snapshot |
| `snapshots[].safetyScoreIdentity` | `object \| null`          | Exact immutable V8/V9 publication identity; `null` for legacy and the bounded July 13-15 transition rows |
| `snapshots[].contentHash`         | `string`                  | Snapshot payload hash used by dated `ETag`s   |
| `snapshots[].byteSize`            | `number`                  | Uncompressed JSON payload size in bytes       |
| `snapshots[].createdAt`           | `number`                  | Snapshot creation timestamp in Unix seconds   |

---

### `GET /api/snapshots/:date.json`

Returns the full immutable public dataset snapshot for a UTC date. The worker reads the gzipped payload from D1, decompresses it, and returns the original JSON envelope.

The writer fails closed for required cache/table reads and marks the cron run `degraded` without inserting a snapshot when the canonical V9 Safety Score, DEWS, or DEX liquidity section is unavailable. V9 must be complete, current, and no older than two 30-minute producer cadences. Its identity is embedded in the row metadata, envelope, and report-card payload. Immediately before insert, the writer reloads and fences the exact canonical publication identity so a publication change cannot seal a mixed-generation immutable row.

DEWS rows must match the exact timestamp, row count, and stablecoin-ID digest in `cache["dews:published-generation"]`; a missing pointer, failed partial generation, or coverage mismatch cannot be sealed into an immutable snapshot. A successful empty DEX read may still publish an empty `liquidity` section, while failed reads are never silently omitted from an `ok` snapshot. New rows validate canonical V9 identity, card membership, and completeness before serving. Historical V8 rows remain readable, and known partial-identity rows from July 13-15, 2026 are served without asserting a verified identity.

**Cache:** immutable-snapshot

**Path parameters**

| Param  | Type     | Description                            |
| ------ | -------- | -------------------------------------- |
| `date` | `string` | UTC snapshot date in `YYYY-MM-DD` form |

**Response**

```text
PublicSnapshotEnvelope {
  snapshotDate,
  generatedAt,
  methodologyVersions,
  safetyScoreIdentity,
  stablecoins,
  fxFallbackRates,
  reportCards,
  psi,
  dews,
  liquidity
}
```

**Headers:** `ETag: "<contentHash>"`.

**Error responses:** `400` for invalid date format, `404` if no snapshot exists for that date, `500` if the stored snapshot payload is unreadable or corrupted.

---

### `GET /api/snapshot/:date/stablecoin/:id`

Returns a per-stablecoin projection from a dated public dataset snapshot. The projection includes the immutable `safetyScoreIdentity`, stablecoin row, and matching V8 score entry or native V9 card plus DEWS and liquidity rows when those datasets were present in the snapshot.

**Cache:** immutable-snapshot

**Path parameters**

| Param  | Type     | Description                            |
| ------ | -------- | -------------------------------------- |
| `date` | `string` | UTC snapshot date in `YYYY-MM-DD` form |
| `id`   | `string` | Canonical Pharos stablecoin ID         |

**Response**

```text
{
  snapshotDate: "2026-05-17",
  stablecoinId: "usdt-tether",
  generatedAt: 1778976000,
  methodologyVersions: { safetyScore: "5.9", psi: "3.0" },
  stablecoin: { id: "usdt-tether", symbol: "USDT" },
  scores: {
    reportCard,
    psi,
    dews,
    liquidity
  }
}
```

| Field                 | Type      | Description                                   |
| --------------------- | --------- | --------------------------------------------- |
| `snapshotDate`        | `string`  | Served snapshot date                          |
| `stablecoinId`        | `string`  | Requested stablecoin ID                       |
| `generatedAt`         | `number`  | Snapshot generation timestamp                 |
| `methodologyVersions` | `object?` | Methodology versions embedded in the snapshot |
| `stablecoin`          | `object`  | Stablecoin row from the dated public dataset  |
| `scores.reportCard`   | `object?` | Matching report-card score, or `null`         |
| `scores.psi`          | `object?` | Snapshot-level PSI object, or `null`          |
| `scores.dews`         | `object?` | Matching DEWS stress-signal row, or `null`    |
| `scores.liquidity`    | `object?` | Matching DEX-liquidity row, or `null`         |

**Headers:** `ETag: "<contentHash>-<stablecoinId>"`.

**Error responses:** `400` for invalid date format, `404` if no snapshot exists or the stablecoin is absent from that snapshot, `500` if the stored snapshot payload is unreadable or corrupted.

---

### `GET /api/health`

Worker health check. Reports cache freshness, blacklist integrity, mint/burn freshness, and circuit-breaker states. Public responses use the realtime cache profile (`public, s-maxage=60, max-age=10`), so edge responses can lag live D1 state by up to about 60 seconds.

Cache freshness in `/api/health` separates producer cadence, endpoint freshness, and availability impact. `caches[*].maxAge` is the availability budget used by `/api/health`, `/api/status`, and the public/admin status pages. `endpointMaxAge` is the endpoint freshness basis used for `_meta`, `X-Data-Age`, and the generic freshness warning runway when it differs. `producerIntervalSec` is the expected writer cadence.

**Authentication:** exempt

**Response**

```json
{
  "status": "healthy",
  "timestamp": 1771856453,
  "warnings": [],
  "caches": {
    "stablecoins": {
      "ageSeconds": 323,
      "maxAge": 600,
      "healthy": true,
      "producerJob": "sync-stablecoins",
      "producerIntervalSec": 900,
      "endpointMaxAge": 600,
      "availabilityMaxAge": 600
    },
    "stablecoin-charts": {
      "ageSeconds": 323,
      "maxAge": 3600,
      "healthy": true,
      "producerJob": "sync-stablecoin-charts",
      "producerIntervalSec": 3600,
      "endpointMaxAge": 3600,
      "availabilityMaxAge": 3600
    },
    "usds-status": {
      "ageSeconds": 47118,
      "maxAge": 86400,
      "healthy": true,
      "producerJob": "sync-usds-status",
      "producerIntervalSec": 86400,
      "endpointMaxAge": 86400,
      "availabilityMaxAge": 86400
    },
    "fx-rates": {
      "ageSeconds": 1223,
      "maxAge": 1800,
      "healthy": true,
      "producerJob": "sync-fx-rates",
      "producerIntervalSec": 1800,
      "endpointMaxAge": 1800,
      "availabilityMaxAge": 1800,
      "mode": "live",
      "sourceUpdatedAt": 1771855200,
      "sourceAgeSeconds": 323,
      "sourceStatus": "fresh",
      "warning": null,
      "consecutiveFallbackRuns": 0
    },
    "bluechip-ratings": {
      "ageSeconds": 22815,
      "maxAge": 86400,
      "healthy": true,
      "producerJob": "sync-bluechip",
      "producerIntervalSec": 86400,
      "endpointMaxAge": 43200,
      "availabilityMaxAge": 86400
    },
    "dex-liquidity": {
      "ageSeconds": 290,
      "maxAge": 43200,
      "healthy": true,
      "producerJob": "sync-dex-liquidity",
      "producerIntervalSec": 7200,
      "endpointMaxAge": 14400,
      "availabilityMaxAge": 43200
    },
    "yield-data": {
      "ageSeconds": 820,
      "maxAge": 3600,
      "healthy": true,
      "producerJob": "sync-yield-data",
      "producerIntervalSec": 3600,
      "endpointMaxAge": 3600,
      "availabilityMaxAge": 3600
    },
    "dews": {
      "ageSeconds": 240,
      "maxAge": 1800,
      "healthy": true,
      "producerJob": "compute-dews",
      "producerIntervalSec": 1800,
      "endpointMaxAge": 1800,
      "availabilityMaxAge": 1800
    }
  },
  "blacklist": {
    "totalEvents": 13422,
    "missingAmounts": 0,
    "recentMissingAmounts": 0,
    "recentWindowSec": 86400,
    "missingRatio": 0
  },
  "mintBurn": {
    "totalEvents": null,
    "latestEventTs": null,
    "latestHourlyTs": null,
    "freshnessAgeSec": null,
    "majorStaleCount": 0,
    "staleMajorSymbols": [],
    "sync": {
      "lastSuccessfulSyncAt": 1771856400,
      "freshnessStatus": "fresh",
      "warning": null,
      "criticalLaneHealthy": true
    }
  },
  "circuits": {
    "defillama-stablecoins": { "state": "closed", "consecutiveFailures": 0, "lastSuccessAt": 1772190029 },
    "coingecko-prices": { "state": "closed", "consecutiveFailures": 0, "lastSuccessAt": 1772190030 }
  },
  "telegramSummary": {
    "totalChats": 142,
    "pendingDeliveries": 0,
    "pendingDeliveryLifecycleStatus": "available",
    "pendingDeliveryBacklog": {
      "claimable": 0,
      "due": 0,
      "deferred": 0,
      "sending": 0,
      "executionUnknown": 0,
      "sentCleanup": 0,
      "expired": 0
    },
    "lastDispatchAt": 1771856400,
    "lastDispatchStatus": "ok",
    "safetyAlertSourceState": "ok",
    "safetyAlertSourceAgeSeconds": 120,
    "safetyAlertsSuppressed": false,
    "safetyAlertSourceGeneration": "safety-7.291-alert-source-v1"
  }
}
```

| Field                                         | Type                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                      | `string`                                                                  | `"healthy"` / `"degraded"` / `"stale"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `timestamp`                                   | `number`                                                                  | Unix seconds at time of response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `warnings`                                    | `string[]`                                                                | Best-effort machine-readable warnings when health subqueries fail but the endpoint can still return a non-500 payload. Messages are sanitized for public output and do not include raw exception text, SQL fragments, or table names. Yield safety availability adds `yield-safety-publish-time-fallback:<reason>` (informational; `/api/yield-rankings` is serving its coherent publish-time safety snapshot during a Safety Score identity rollover) and `yield-safety-unrated-serving:<reason>` (degrades `status`; the public yield surface is serving NR safety fields because the stamped identity is missing or the fallback aged past the 24-hour stale-coherent window).                                                                                                                                                                                                                                                                                                                               |
| `caches`                                      | `Record<string, CacheStatus>`                                             | Per-cache freshness status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `caches["fx-rates"]`                          | `CacheStatus`                                                             | FX cache freshness plus source-cadence diagnostics (`mode`, `sourceUpdatedAt`, `sourceAgeSeconds`, `sourceStatus`, `warning`, `consecutiveFallbackRuns`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `blacklist.totalEvents`                       | `number`                                                                  | Total events in blacklist table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blacklist.missingAmounts`                    | `number`                                                                  | Events where `amount` is null (should be 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `blacklist.recentMissingAmounts`              | `number`                                                                  | Missing-amount events inside the recent monitoring window used by status logic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `blacklist.recentWindowSec`                   | `number`                                                                  | Size of the recent monitoring window in seconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `blacklist.missingRatio`                      | `number`                                                                  | `missingAmounts / totalEvents` (0 when no blacklist rows exist yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `telegramSummary`                             | `TelegramHealthSummary \| null`                                           | Lightweight Telegram delivery health summary. `null` when the Telegram tables are unavailable or not yet migrated                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `telegramSummary.totalChats`                  | `number`                                                                  | Total subscribed Telegram chats currently stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `telegramSummary.pendingDeliveries`           | `number \| null`                                                          | Active claimable plus deferred Telegram deliveries. `null` when lifecycle capacity is unavailable; it never reports a fabricated zero on query failure.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `telegramSummary.pendingDeliveryLifecycleStatus` | `"available" \| "unknown"`                                           | Whether the lifecycle counts are authoritative for this response. An `unknown` result also adds `telegram-delivery-lifecycle:unknown` to `warnings`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `telegramSummary.pendingDeliveryBacklog`      | `TelegramPendingDeliveryBacklog`                                          | Present when lifecycle data is available. Separates claimable/due, deferred, recent sending, execution-unknown, sent-cleanup, expired, and near-TTL work, with source splits and bounded-sample saturation metadata for execution-unknown rows.                                                                                                                                                                                                                                                                                                                           |
| `telegramSummary.lastDispatchAt`              | `number \| null`                                                          | Unix seconds of the most recent `dispatch-telegram-alerts` cron run, if available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `telegramSummary.lastDispatchStatus`          | `string \| null`                                                          | Status of the most recent `dispatch-telegram-alerts` cron run, if available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `telegramSummary.safetyAlertSourceState`      | `"ok" \| "missing" \| "corrupt" \| "stale" \| "wrong-generation" \| null` | Live safety-alert source-cache state from the most recent Telegram dispatch run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `telegramSummary.safetyAlertSourceAgeSeconds` | `number \| null`                                                          | Age of the current live safety-alert source snapshot when available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `telegramSummary.safetyAlertsSuppressed`      | `boolean`                                                                 | `true` when safety alerts are paused because the live source snapshot is missing, corrupt, stale, or from the wrong generation                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `telegramSummary.safetyAlertSourceGeneration` | `string \| null`                                                          | Generation marker of the current live safety-alert source snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mintBurn.totalEvents`                        | `number \| null`                                                          | Legacy advisory total sourced from the latest `mint-burn-growth-watchdog` `cron_runs` row. `null` until that daily watchdog has published a count. The budget-capped health path does not scan `mint_burn_events` or `mint_burn_hourly`; use `/api/mint-burn-flows` or `/api/mint-burn-events` for live mint/burn data views.                                                                                                                                                                                                                                       |
| `mintBurn.latestEventTs`                      | `number \| null`                                                          | Legacy advisory timestamp. `null` on the budget-capped health path because `/api/health` no longer scans `mint_burn_events`; freshness is represented by `mintBurn.sync.lastSuccessfulSyncAt`.                                                                                                                                                                                                                                                                                                                                                                      |
| `mintBurn.latestHourlyTs`                     | `number \| null`                                                          | Legacy advisory timestamp. `null` on the budget-capped health path because `/api/health` no longer scans `mint_burn_hourly`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mintBurn.freshnessAgeSec`                    | `number \| null`                                                          | Legacy advisory age. `null` on the budget-capped health path; derive critical-lane age from `mintBurn.sync.lastSuccessfulSyncAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mintBurn.majorStaleCount`                    | `number`                                                                  | Legacy advisory count. Always `0` on the budget-capped health path because per-symbol stale checks are intentionally not scanned from D1.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mintBurn.staleMajorSymbols`                  | `string[]`                                                                | Legacy advisory list. Always empty on the budget-capped health path because per-symbol stale checks are intentionally not scanned from D1.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mintBurn.sync`                               | `object`                                                                  | Critical-lane sync freshness summary used for public health evaluation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mintBurn.sync.lastSuccessfulSyncAt`          | `number \| null`                                                          | Unix seconds of the latest successful `sync-mint-burn` run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mintBurn.sync.freshnessStatus`               | `"fresh" \| "degraded" \| "stale"`                                        | Public freshness state keyed to the 30-minute critical-lane cadence (`fresh <= 60m`, `degraded <= 90m`, `stale > 90m`)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mintBurn.sync.warning`                       | `string \| null`                                                          | Human-readable warning when the critical lane is stale, degraded, or errored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mintBurn.sync.criticalLaneHealthy`           | `boolean`                                                                 | `true` when the latest critical-lane run is `ok`, `degraded`, or `skipped_locked`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `circuits`                                    | `Record<string, CircuitRecord>`                                           | Per-source circuit breaker states. Keys include `defillama-stablecoins`, `defillama-stablecoin-detail`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-detail-platforms`, `coingecko-mcap`, `coinmarketcap-prices`, `dexscreener-prices`, `dexscreener-liquidity`, `dexscreener-search`, `treasury-rates`, `etherscan`, `alchemy`, `twitter-api`, `telegram-api`, `pyth-prices`, `binance-prices`, `coinbase-prices`, `redstone-prices`, `curve-onchain`, `curve-liquidity-api`, `fx-realtime` |

**`CacheStatus`**

| Field                      | Type                                                                       | Description                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ageSeconds`               | `number \| null`                                                           | Seconds since last cron update; `null` if never populated                                                                                                                   |
| `maxAge`                   | `number`                                                                   | Availability budget in seconds for this cache key; same value as `availabilityMaxAge` for current workers                                                                   |
| `healthy`                  | `boolean`                                                                  | `true` when `ageSeconds / maxAge ≤ 12.0`; status-page bands use `>8.0x` for degraded and `>12.0x` for stale                                                                 |
| `producerJob`              | `string \| null \| undefined`                                              | Cron job that produces the cache freshness signal                                                                                                                           |
| `producerIntervalSec`      | `number \| null \| undefined`                                              | Expected producer cadence in seconds                                                                                                                                        |
| `endpointMaxAge`           | `number \| null \| undefined`                                              | Endpoint freshness basis used by `_meta`, `X-Data-Age`, and generic freshness warning runway when available                                                                 |
| `availabilityMaxAge`       | `number \| null \| undefined`                                              | Availability budget used by `/api/health`, `/api/status`, and status-page cache ratios                                                                                      |
| `endpointBudgetReason`     | `string \| null \| undefined`                                              | Short explanation when endpoint freshness differs from producer cadence or availability budget                                                                              |
| `availabilityBudgetReason` | `string \| null \| undefined`                                              | Short explanation for the availability budget                                                                                                                               |
| `freshnessSource`          | `"freshness-sentinel" \| "table-fallback" \| "cron-fallback" \| undefined` | Source used to derive freshness for sentinel-backed cache lanes                                                                                                             |
| `sentinelValidationReason` | `string \| null \| undefined`                                              | Present when a malformed, stale, wrong-source, future-dated, or non-`ok` freshness sentinel was ignored                                                                     |
| `mode`                     | `"live" \| "cached-fallback" \| undefined`                                 | FX cache only: whether the latest usable sync came from a live fetch or cached fallback                                                                                     |
| `sourceUpdatedAt`          | `number \| null \| undefined`                                              | FX cache only: Unix seconds for the source currently driving `sourceStatus`                                                                                                 |
| `sourceAgeSeconds`         | `number \| null \| undefined`                                              | FX cache only: age of the source currently driving `sourceStatus`                                                                                                           |
| `sourceStatus`             | `"fresh" \| "degraded" \| "stale" \| "none"`                               | FX cache only: cadence-aware source freshness status                                                                                                                        |
| `warning`                  | `string \| null \| undefined`                                              | Human-readable warning when a lane is running on degraded freshness evidence (FX fallback/source cadence, or cache freshness fallback from sentinel to table/cron evidence) |
| `consecutiveFallbackRuns`  | `number \| undefined`                                                      | FX cache only: number of back-to-back cached-fallback runs                                                                                                                  |

The `/status/` page consumes the richer blacklist fields directly so it can distinguish long-tail historical cleanup from fresh incoming amount gaps.
Blacklist amount-gap severity is intentionally tolerant of isolated parser/provider misses: data-quality degrades when the missing-amount ratio reaches 1% or when at least 5 recent events are missing amounts, and becomes stale at 2% or at 25 recent missing events.

`dex-liquidity`, `yield-data`, and `dews` compute freshness from producer-owned cache sentinels first (`freshness:dex-liquidity`, `freshness:yield-data`, `freshness:dews`). A sentinel is trusted only when its JSON payload has `updatedAt`, the expected producer `source`, and `publishStatus: "ok"`; optional `rowsWritten` and `coverageRatio` fields may also be present. If the sentinel is missing or fails validation, the worker falls back to the legacy table query. If that freshness diagnostic also fails, it can fall back again to the latest successful producer cron timestamp. Invalid sentinels surface `freshnessSource`, `sentinelValidationReason`, and a cache `warning` instead of making the sentinel row authoritative.

Stablecoin publication and active-price coverage use the newest `sync-stablecoins` run that persisted both exact coverage reports. Synthetic abandoned or no-write attempts remain visible in cron health, but they do not replace the last publication evidence with `unknown`.

**Overall status logic:**

- `healthy` — every cache impact is healthy, the public mint/burn lane is healthy, fewer than 3 public-impact circuit groups are open, and the health subqueries all resolved cleanly
- `degraded` — any cache impact is degraded (including FX cached-fallback or source-cadence lag), any of the blacklist/mint-burn/circuit health subqueries failed, stablecoin-publication coverage is incomplete/unavailable, active-price coverage is unavailable (`unknown`), the public mint/burn lane is warning-only, or 3+ public-impact circuit groups are open. Alert-eligible active-price misses emit `active-price-coverage-incomplete` warnings but stay public-health `healthy` unless another public-impact gate is degraded; transient single-cycle misses also stay `healthy` while `activePriceCoverage` still reports the exact counts/IDs.
- `stale` — any cache impact is stale, or the public mint/burn lane is stale versus its critical-lane cadence

`/api/health` still emits every circuit record under `circuits`, including dynamic per-coin `live-reserves:*` scopes, but those reserve-specific breakers do not change the top-level public status on their own; reserve sync health is evaluated on the dedicated reserve/data-quality lanes instead.

Blacklist ratio fields are still emitted here for the public surface, but threshold-based blacklist severity lives under `/api/status` data-quality; `/api/health` only escalates its top-level status when the blacklist health loader itself fails.

---

### `GET /api/public-status-history`

Public transition history for the read-only `/status/` page. Returns the current public status plus recent state transitions within a requested time window. Not edge-cached beyond the standard 60-second response cache.

**Query parameters**

| Param    | Type                     | Default | Description                                                                                                                               |
| -------- | ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `window` | `"24h" \| "7d" \| "30d"` | `"30d"` | Transition time window applied server-side before rows are returned                                                                       |
| `limit`  | `integer`                | `50`    | Max raw status transitions loaded within the time window before public-impact filtering (1–200); returned public transitions may be fewer |

**Response**

```json
{
  "timestamp": 1771856453,
  "currentStatus": "healthy",
  "lastChangedAt": 1771770000,
  "transitions": [
    {
      "id": 418,
      "from": "degraded",
      "to": "healthy",
      "transitionType": "recover",
      "reason": "raw-healthy-recovery-threshold",
      "at": 1771770000
    }
  ]
}
```

| Field           | Type                                 | Description                                                                                                  |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `timestamp`     | `number`                             | Unix seconds at time of response                                                                             |
| `currentStatus` | `"healthy" \| "degraded" \| "stale"` | Current public status, sourced from `assessPublicHealth` (matches the `status` field from `GET /api/health`) |
| `lastChangedAt` | `number \| null`                     | Unix seconds for the newest retained public transition when it ends in `currentStatus`; otherwise `null`     |
| `transitions`   | `PublicStatusTransition[]`           | Recent public-impact incident transitions, inside the requested window, newest first                         |

This endpoint powers two separate public `/status/` views: the hero `Status runway` always uses `window=30d`, while the transition table owns its own user-selected `24h` / `7d` / `30d` filter.

Browser consumers on `pharos.watch` and `ops.pharos.watch` should use same-origin `/_site-data/public-status-history`, which proxies onto the internal website lane instead of calling the external API host directly.

**Public-impact filtering (2026-04-13; active-price coverage adjusted 2026-07-19):** The endpoint filters the admin state-machine transitions down to incidents opened by at least one public-facing impact code (`cache_ratio_*`, `cache_freshness_query_failed`, `cache_warning`, `fx_cached_fallback`, `mint_burn_public_*`, `mint_burn_health_query_failed`, `active_price_coverage_unknown`, `open_circuit_groups`, `circuit_query_failed`, `cron_error_runs`, `multiple_unhealthy_crons`, `unhealthy_crons_present`, `db_unhealthy`). Producer-only source freshness causes such as `fx_source_*`, admin-only aggregate data-quality causes (`active_price_coverage_incomplete`, `missing_prices_*`, `blacklist_gaps_*`, `reserve_sync_*`, `onchain_*`, `watch_*`), and `info`-severity causes cannot open a public incident. Once a public-impact incident is retained, the endpoint also retains the recovery path needed to return that incident to `healthy`, even when those recovery rows only carry info-level causes. Live public health is authoritative for `currentStatus` and today's uptime segment; when no matching public transition proves when that state began, `lastChangedAt` is `null` and earlier runway days remain unknown. The unfiltered admin view is still available via the admin `/api/status` endpoint.

---

### `GET /api/telegram-pulse`

Lightweight Telegram adoption metrics for the public PharosWatchBot page. The canonical page route is `/pharoswatchbot/`; the legacy `/telegram` alias redirects there. Returns aggregate watcher/subscription counts, explicit vs preset-implied alert follows, the most subscribed coin symbols, and snapshot-backed watcher history when available. When active chats predate the first daily snapshot row, the history is prefixed with live active-chat cohort points so the public lifecycle chart shows the full available bot lifecycle. The common path serves the five-minute `telegram:pulse:snapshot` cache written by the Telegram cron sidecar; live aggregation is a stale/missing snapshot fallback.

Direct `https://api.pharos.watch/api/telegram-pulse` access is protected and requires `X-API-Key`. Public browser access on `pharos.watch` and `ops.pharos.watch` uses same-origin `/_site-data/telegram-pulse`, which proxies to the internal `site-api` lane with `X-Pharos-Site-Proxy-Secret`.

**Cache:** `public, max-age=300, s-maxage=300`

**Response**

```json
{
  "activeWatchers": 1842,
  "coinSubscriptions": 5621,
  "explicitCoinSubscriptions": 5000,
  "presetImpliedCoinSubscriptions": 621,
  "activePresetFollowers": 81,
  "newWatchersToday": 12,
  "churnedWatchersToday": 3,
  "reactivatedWatchersToday": 5,
  "historySource": "snapshot",
  "pendingDeliveries": 3,
  "miniAppSessionsToday": 88,
  "miniAppMutationsToday": 31,
  "miniAppDeniedToday": 2,
  "miniAppReplayClaimsToday": 1,
  "miniAppOpenToFirstMutationP50Sec": null,
  "currentSnapshotAt": 1771856400,
  "lifecycleHistoryUpdatedAt": 1775088900,
  "lifecycleHistoryEverySeconds": 900,
  "quality": {
    "status": "complete",
    "unavailableFields": []
  },
  "privacy": {
    "exactActiveWatchers": true,
    "lowCardinalityThreshold": 5,
    "suppressedFields": []
  },
  "updatedAt": 1771856400,
  "updatedEverySeconds": 300,
  "topCoins": ["USDT", "USDC", "USDe"],
  "watcherHistory": [
    {
      "date": "2026-04-01",
      "timestamp": 1775001600000,
      "snapshotAt": 1775002500,
      "newWatchers": 12,
      "activeWatchers": 12
    },
    {
      "date": "2026-04-02",
      "timestamp": 1775088000000,
      "newWatchers": 9,
      "activeWatchers": 21,
      "churnedWatchers": 1,
      "reactivatedWatchers": 2
    }
  ]
}
```

| Field                              | Type                            | Description                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeWatchers`                   | `number`                        | Subscribers with at least one active global, explicit coin, or preset alert follow                                                                                                                                                                                                                                                                                          |
| `coinSubscriptions`                | `number`                        | Total active alert follows, including explicit coin follows plus preset-implied follows                                                                                                                                                                                                                                                                                     |
| `explicitCoinSubscriptions`        | `number`                        | Active explicit per-coin subscription rows                                                                                                                                                                                                                                                                                                                                  |
| `presetImpliedCoinSubscriptions`   | `number`                        | Dynamic preset follower count multiplied by each preset's currently resolved coin set                                                                                                                                                                                                                                                                                       |
| `activePresetFollowers`            | `number`                        | Chats with at least one active preset follow                                                                                                                                                                                                                                                                                                                                |
| `newWatchersToday`                 | `number \| null`                | Active watchers created in the current UTC day snapshot; `null` when suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                                        |
| `churnedWatchersToday`             | `number \| null`                | Snapshot-estimated active watcher churn for the current UTC day; `null` when suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                                |
| `reactivatedWatchersToday`         | `number \| null`                | Snapshot-estimated active watcher reactivation for the current UTC day; `null` when suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                         |
| `historySource`                    | `"snapshot" \| "live-fallback"` | `snapshot` when the response is only fixed `telegram_watcher_lifecycle_daily` rows, or when no live fallback rows are available; `live-fallback` when subscriber-created-at aggregation supplies older active-chat cohort points ahead of the fixed snapshot rows                                                                                                           |
| `pendingDeliveries`                | `number \| null`                | Count of queued Telegram alert deliveries; `null` when unavailable or suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                                       |
| `miniAppSessionsToday`             | `number \| null`                | Valid Mini App session launches today; `null` when unavailable or suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                                           |
| `miniAppMutationsToday`            | `number \| null`                | Successful Mini App mutations today; `null` when unavailable or suppressed by low-cardinality privacy filtering                                                                                                                                                                                                                                                             |
| `miniAppDeniedToday`               | `number \| null`                | Mini App denial count for abuse/health monitoring. This field is not suppressed by the low-cardinality privacy rule because it is an operational counter, not an adoption signal.                                                                                                                                                                                           |
| `miniAppReplayClaimsToday`         | `number \| null`                | Mini App replay-protection claim count for abuse/health monitoring. This field is not suppressed by the low-cardinality privacy rule because it is an operational counter, not an adoption signal.                                                                                                                                                                          |
| `miniAppOpenToFirstMutationP50Sec` | `number \| null`                | Approximate P50 selected from first-party open-to-first-mutation bucket midpoints; `null` when unavailable, no known correlations exist, or the daily sample is privacy-suppressed below five                                                                                                                                                                               |
| `currentSnapshotAt`                | `number`                        | Unix seconds when the current aggregate pulse snapshot was measured                                                                                                                                                                                                                                                                                                         |
| `lifecycleHistoryUpdatedAt`        | `number \| null`                | Unix seconds of the latest daily lifecycle snapshot when any snapshot row exists; can be non-null while `historySource="live-fallback"` when subscriber-created-at aggregation yields older chart points; `null` when no snapshot history exists                                                                                                                            |
| `lifecycleHistoryEverySeconds`     | `number`                        | Expected lifecycle-history snapshot cadence, currently 900 seconds                                                                                                                                                                                                                                                                                                          |
| `quality`                          | `object`                        | Public telemetry quality marker. `partial` means one or more non-critical fields were unavailable; raw errors are omitted from public pulse responses.                                                                                                                                                                                                                      |
| `privacy`                          | `object`                        | Public privacy stance and suppressed field list. Exact active watcher totals are public; nonzero supporting metrics below `lowCardinalityThreshold` are suppressed.                                                                                                                                                                                                         |
| `updatedAt`                        | `number`                        | Unix seconds when the pulse payload was produced                                                                                                                                                                                                                                                                                                                            |
| `updatedEverySeconds`              | `number`                        | Cache cadence for consumers that display freshness                                                                                                                                                                                                                                                                                                                          |
| `topCoins`                         | `string[]`                      | Up to five most subscribed coin tickers, ordered by subscription count                                                                                                                                                                                                                                                                                                      |
| `watcherHistory`                   | `array`                         | UTC day buckets. Snapshot-backed points preserve historical active counts and include `snapshotAt`; daily delta fields can be `null` when suppressed. During bootstrap, fallback prefix points use current active watcher created-at aggregation and cumulative active watchers so the public chart keeps all available historical points before fixed snapshots take over. |

Low-cardinality privacy rule: nonzero values below `privacy.lowCardinalityThreshold` are hidden for public daily deltas, pending deliveries, Mini App session/mutation adoption counts, and lifecycle-history delta fields. Subscriber preference aggregates such as alert-type opt-ins and quiet-hours adoption are intentionally omitted from this public endpoint; authenticated admin status diagnostics retain those operational details. Consumers should treat `null` as "not publicly shown", not as zero. Mini App denied/replay counters are an explicit exception because they are abuse/health counters; they remain visible when available and are not listed in `privacy.suppressedFields`.

---

### `GET /api/stability-index`

Latest Pharos Stability Index (PSI) sample plus daily history. The PSI is a composite ecosystem health score (0–100) computed from active depeg severity, affected-market breadth, DEWS stress breadth, and 7-day ecosystem trend across core stablecoins, cash equivalents, and configured shadow assets used for historical continuity. Tracked variants and stable-value investments remain readable but do not enter this monetary aggregate. If a dependency failure prevents a safe fresh sample, the endpoint continues serving the last healthy stored PSI sample instead of publishing a degraded substitute.

**Cache:** standard — `X-Data-Age` and `Warning` headers included after at least one PSI sample/history row exists. Before bootstrap, the empty response carries `Cache-Control` only and contains `{ current: null, history: [], methodology: ... }` without `malformedRows`.

**Error responses:** `503` when the canonical current PSI `components` or `input_snapshot` payload is missing or malformed.

**Optional query parameters**

| Param    | Type     | Default | Description                                                                                             |
| -------- | -------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `detail` | `"true"` | —       | When `"true"`, returns full history with persisted per-day component breakdowns instead of last 91 days |

**Response**

```json
{
  "current": {
    "score": 81.1,
    "band": "STEADY",
    "components": { "severity": 4.59, "breadth": 15, "stressBreadth": 1.8, "trend": 0.65 },
    "aggregateUniverse": "core-stablecoins-v1",
    "computedAt": 1771977600,
    "methodologyVersion": "3.6"
  },
  "history": [{ "date": 1771891200, "score": 81.0, "band": "STEADY", "methodologyVersion": "2.1" }],
  "methodology": {
    "version": "3.6",
    "versionLabel": "v3.6",
    "currentVersion": "3.6",
    "currentVersionLabel": "v3.6",
    "changelogPath": "/methodology/stability-index-changelog/",
    "asOf": 1771977600,
    "isCurrent": true
  }
}
```

| Field                          | Type                  | Description                                                                                                                                               |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`                      | `object \| null`      | Latest PSI score and components. `null` if cron has not yet run                                                                                           |
| `current.score`                | `number`              | PSI score 0–100                                                                                                                                           |
| `current.band`                 | `string`              | Condition band: `"BEDROCK"`, `"STEADY"`, `"TREMOR"`, `"FRACTURE"`, `"CRISIS"`, `"MELTDOWN"`                                                               |
| `current.avg24h`               | `number \| undefined` | Rolling 24 h average PSI score                                                                                                                            |
| `current.avg24hBand`           | `string \| undefined` | Condition band for `avg24h`                                                                                                                               |
| `current.components`           | `object`              | Component breakdown: `severity`, `breadth`, `stressBreadth`, `trend`                                                                                      |
| `current.aggregateUniverse`    | `string \| undefined` | Aggregate-universe marker. Current v3.6 samples use `"core-stablecoins-v1"`; older stored samples may omit it                                            |
| `current.contributors`         | `array`               | Top per-coin contributors from `input_snapshot.contributors` (empty when unavailable)                                                                     |
| `current.inputDegradation`     | `object \| undefined` | Dependency-loss metadata carried by the served sample when the stored input snapshot recorded degraded upstream inputs                                    |
| `current.totalMcapUsd`         | `number`              | Core stablecoin, cash-equivalent, and shadow-asset market cap from the latest input snapshot (`0` when unavailable)                                       |
| `current.computedAt`           | `number`              | Unix seconds of computation                                                                                                                               |
| `current.methodologyVersion`   | `string`              | Methodology version used to compute the current score                                                                                                     |
| `history`                      | `array`               | Historical scores, newest first. With `detail=true`, persisted rows include `components`; the synthesized current-day running-average point may omit them |
| `malformedRows`                | `number`              | Count of historical rows dropped from `detail=true` because persisted `components` JSON was malformed                                                     |
| `history[].methodologyVersion` | `string`              | Methodology version used for that history point                                                                                                           |
| `methodology`                  | `object`              | Version metadata for current PSI methodology context                                                                                                      |
| `methodology.version`          | `string`              | Methodology version used by current score                                                                                                                 |
| `methodology.changelogPath`    | `string`              | Relative path to full methodology changelog                                                                                                               |

---

### `GET /api/og/*`

Dynamic Open Graph PNG images used by share buttons and page metadata.

**Authentication:** exempt

**Supported routes**

- `/api/og/stablecoin/:id`
- `/api/og/chain/:id`
- `/api/og/safety-scores`
- `/api/og/depeg`
- `/api/og/stability-index`

**Content-Type:** `image/png`

**Cache:** `public, max-age=900, s-maxage=900`

**Error cases**

- `404` with `text/plain` for unknown coin IDs inside `/api/og/stablecoin/:id` and for unknown chain IDs (or chains with no tracked supply) inside `/api/og/chain/:id`; unknown OG route patterns return the standard JSON `{ "error": "Unknown OG route" }`
- `503` when required cached data is not yet available
- `400` for malformed URI encoding in `/api/og/stablecoin/:id`
- `500` with `text/plain` body when OG image rendering fails

`/api/og/stablecoin/:id` accepts tracked public stablecoin IDs only. The renderer assembles each card from cached stablecoin, DEWS, PSI, report-card, depeg, liquidity, and mint/burn data on the worker. `/api/og/chain/:id` accepts `CHAIN_META` chain IDs and renders supply, 7d trend, dominance, chain-health, and top-stablecoin data from the same cached stablecoins payload that backs `/api/chains`.

Safety-dependent OG routes resolve the identified canonical V9 source, require complete current data, and return `X-Safety-Score-Model` plus `X-Safety-Score-Status: current|degraded`. V9 is stale after two missed 30-minute producer cadences. Degraded cards label Safety Score data unavailable and do not render a numeric zero as an aggregate score. The safety-summary average is descriptive only and is never converted back into an asset grade.

---

### `GET /api/report-cards/v9`

Canonical Safety Score V9 ratings with Backing, Exit, and Economic Control pillars, publication identity, evidence completeness, component breakdowns, and the serial/basket dependency graph.

**Cache:** handler-generated responses bypass the edge cache

**Response**

```text
{
  "model": "v9",
  "schemaVersion": 5,
  "lifecycle": "active",
  "safetyScoreIdentity": {
    "model": "v9",
    "methodologyVersion": "9.33",
    "publicationGenerationId": "report-cards:v9:v1:<sha256>",
    ...
  },
  "methodology": {
    "version": "9.33",
    "policy": { "id": "safety-score-v9", "semanticDigest": "<sha256>" }
  },
  "completeness": { ... },
  "publicationHealth": {
    "status": "current | held",
    "acceptedAtSec": 1771977600,
    "attemptedAtSec": 1771977600,
    "reasons": []
  },
  "cards": [SafetyScoreV9Card, ...],
  "dependencyGraph": {
    "nodes": [...],
    "edges": [{ "from": "usdc-circle", "to": "usde-ethena", "weight": 0.9, "type": "collateral", ... }]
  },
  "updatedAt": 1771977600
}
```

The endpoint reads only the accepted `report-cards:v9` publication and its `report-cards:v9:publication-health` row. Missing, malformed, or incomplete accepted state returns `503`; an identity mismatch between otherwise valid rows serves the authenticated publication as explicitly held. The handler never recomputes a score and never falls back to V8. The retired unversioned `/api/report-cards` route and preview aliases return `404`.

Rateable cards contain mandatory `backing`, `exit`, and `control` breakdowns. Each card may also carry `backingFromLiveReserves`; current report-v5 publications set it to `true` exactly when the compiled V9 fact set used accepted live reserve exposures for Backing, independently of the reserve detail-page badge. The field is optional only for rollout compatibility with a retained pre-report-v5 publication. Each breakdown reconciles evaluator and published pillar values through ordered adjustments. Economic Control uses the minimum binding component; Backing and Exit expose bounded aggregation inputs and weights. `breakdowns` is `null` exactly when the card is `NR`.

`breakdowns.exit.primaryRoute.capacity` describes the selected route rather than market-wide liquidity. It exposes `executableUsd`, `requestedNotionalUsd`, `completionRatio`, request and observed cost bounds, settlement delay and scoring horizon, chain, protocol, pool, evidence kind, and evidence timestamp. Exit alternatives expose their own horizon, delay, confidence factor, and compact capacity summary so the evidence-confidence tradeoff against a higher-capacity alternative remains visible. Issuer redemption remains a separate daily, queued, or eventual route; exchange volume, aggregate DEX TVL, and issuer reserves are not interchangeable with executable capacity on one selected route.

`accessPosture` publishes four reviewed posture enums plus `unknownFields` and `signals`. `primaryExit` is one of `permissionless`, `eligibility-gated`, `issuer-discretionary`, `none`, `undisclosed`, or `unknown`, and is derived from every route the Exit pillar credits — score-eligible routes plus reviewed issuer-, protocol-, and eventual-redemption routes — so it cannot contradict a scored `breakdowns.exit.primaryRoute`. The three absences are distinct and consumers should not collapse them: `none` is a reviewed negative (an exit surface observed complete with zero routes); `undisclosed` means no credited route resolved a posture, or the exit surface was never observed; `unknown` means credited routes exist but their access facts are unresolved. Only `unknown` appears in `unknownFields`. The `primaryExit` vocabulary grew from five members to six in methodology `9.25`, which added `undisclosed`; the change is additive, but a consumer that exhaustively switches on the enum needs the new arm. The posture change itself moved no pillar score or grade; a separate Economic Control correction shipped in the same release moved three assets downward, all documented in the `9.25` methodology changelog entry.

`publicationHealth.status` is `current` or `held`. A held response serves the last accepted ratings, uses the accepted timestamp for freshness headers and `updatedAt`, adds `X-Safety-Score-Status: held`, and forces `Cache-Control: no-store`. The latest unsuccessful attempt is exposed separately through `attemptedAtSec` and bounded hold reasons. Isolated producer failures may still publish when at least 90% of active assets are unaffected; broader or identity-level failures hold the prior accepted publication.

Automated consumers validate the complete V9 response and treat held or unavailable data according to their own freshness policy. Public, yield, digest, mint/burn, history, Telegram, OG, portfolio, comparison, and dependency-map consumers use this canonical identity.

**`dependencyGraph.edges`**: Pre-computed forward edges. `from` is the upstream stablecoin ID and `to` is the dependent stablecoin ID. Weight, relationship type, materiality, and basket/serial semantics come from the canonical V9 evaluator.

---

### `GET /api/redemption-backstops`

Current redemption-backstop dataset for redeemable assets.

**Cache:** standard

**Error responses:** `503` when `redemption_backstop` has no rows yet, or when the current snapshot cannot be read cleanly.

Rows written by the current worker are grouped by a completed snapshot run manifest. The API serves the latest valid completed run when one exists, which prevents a partially written hourly sync from being treated as a fresh complete dataset. If the newest completed manifest is incomplete or its rows are unreadable, the reader tries recent earlier completed runs before returning `503`. If no completed manifest exists but the manifest table has run records and the current table contains rows with a non-null `snapshot_run_id`, the reader returns `503` instead of treating those partial manifested rows as legacy data. Legacy rows without a completed run remain readable during bootstrap and migration fallback only when the current table has no manifested rows.

**Response**

```json
{
  "coins": {
    "cusd-cap": {
      "stablecoinId": "cusd-cap",
      "score": 88,
      "dexLiquidityScore": 29,
      "accessScore": 100,
      "settlementScore": 100,
      "executionCertaintyScore": 80,
      "capacityScore": 100,
      "outputAssetQualityScore": 80,
      "costScore": 40,
      "routeFamily": "basket-redeem",
      "accessModel": "permissionless-onchain",
      "settlementModel": "atomic",
      "executionModel": "deterministic-basket",
      "outputAssetType": "stable-basket",
      "provider": "supply-full-model",
      "immediateCapacityUsd": null,
      "immediateCapacityRatio": null,
      "sourceMode": "estimated",
      "resolutionState": "resolved",
      "routeStatus": "open",
      "routeStatusSource": "static-config",
      "holderEligibility": "any-holder",
      "capacityConfidence": "heuristic",
      "capacitySemantics": "eventual-only",
      "capacityKind": "documented-eventual",
      "freshnessKind": "reviewed-static",
      "sourceTimestamp": 1773350300,
      "sourceUrls": ["https://example.com/redemption-source"],
      "settlementDelaySec": 86400,
      "queueDepthUsd": 12000000,
      "dailyLimitUsd": 5000000,
      "minRedeemUsd": 100000,
      "liveHolderEligibility": "any-holder",
      "feeConfidence": "undisclosed-reviewed",
      "feeModelKind": "undisclosed-reviewed",
      "modelConfidence": "low",
      "feeBps": null,
      "queueEnabled": false,
      "updatedAt": 1773350400,
      "methodologyVersion": "4.38"
    }
  },
  "methodology": {
    "version": "4.38",
    "versionLabel": "v4.37",
    "currentVersion": "4.38",
    "currentVersionLabel": "v4.37",
    "changelogPath": "/methodology/#safety-scores-methodology",
    "asOf": 1773350400,
    "isCurrent": true,
    "componentWeights": {
      "access": 0.2,
      "settlement": 0.15,
      "executionCertainty": 0.15,
      "capacity": 0.25,
      "outputAssetQuality": 0.15,
      "cost": 0.1
    },
    "routeFamilyCaps": {
      "queueRedeem": 70,
      "offchainIssuer": 65
    }
  },
  "updatedAt": 1773350400
}
```

`score` is the direct redemption-quality score.

The `effectiveExitScore` field and the `methodology.effectiveExitModel` block were removed in redemption methodology v4.3. Same-notional exit is published by the Safety Score V9 Exit pillar (`GET /api/report-cards/v9`, `pillars.exit`), which measures completion of an explicit stress request against reviewed route capacity curves; `dexLiquidityScore` remains only as backward-compatible DEX diagnostic context and is not blended into a current score.

`methodology.version` is attributed from the latest completed redemption snapshot run, falling back to the latest stored row for legacy snapshots. `methodology.currentVersion` remains the live code version when the API is serving an older snapshot that has not yet been recomputed.

`sourceMode`:

- `dynamic` = live reserve/protocol telemetry
- `estimated` = modelled from current supply and conservative route assumptions
- `static` = route remains configured, but current runtime inputs did not resolve a usable score

`resolutionState`:

- `resolved` = the route produced a usable score
- `missing-cache` = the stablecoins snapshot did not include the asset or its current supply
- `missing-capacity` = the route is configured, but the snapshot could not resolve enough capacity to score it
- `failed` = a route-specific resolver failed
- `impaired` = the route shape is known but current market or route-availability evidence contradicts broad par redemption

`routeStatus` / `routeStatusSource` describe current route availability separately from the static route shape. Normal rows use `routeStatus: "open"` and `routeStatusSource: "static-config"`. A severe active depeg (`>=2500 bps`) can publish `routeStatus: "degraded"` and `routeStatusSource: "market-implied"` for static or non-live-direct routes; those impaired rows have `score = null` and `modelConfidence = "low"`. `holderEligibility` describes the modeled holder cohort, such as `any-holder`, `verified-customer`, `whitelisted-primary`, `pre-incident-holder`, `issuer-discretionary`, or `unknown`.

For v4-compatible snapshots, route-status and capacity telemetry remain part of the four-hour `sync-redemption-backstops` snapshot. The worker does not fetch a separate real-time route-status feed during this sync; route status comes from live-reserve adapter metadata, static reviewed policy, and market-implied severe-depeg overlays.

Top-level fields:

| Field         | Type                                      | Description                                                                                                |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `coins`       | `Record<string, RedemptionBackstopEntry>` | Current snapshot keyed by Pharos stablecoin ID                                                             |
| `methodology` | `object`                                  | Version metadata plus standalone route-score component weights and route-family caps                        |
| `updatedAt`   | `number`                                  | Freshest `updated_at` timestamp for the served completed run, or freshest current row for legacy snapshots |

`RedemptionBackstopEntry` highlights:

| Field                        | Type                                                                                                                                                       | Description                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `score`                      | `number \| null`                                                                                                                                           | Direct redemption-quality score after route-family/config caps                                                                                                                                                                |
| `dexLiquidityScore`          | `number \| null`                                                                                                                                           | Backward-compatible DEX diagnostic context; it does not compute the current standalone route score or a combined exit score                                                                                                   |
| `routeFamily`                | `string`                                                                                                                                                   | `stablecoin-redeem`, `basket-redeem`, `collateral-redeem`, `psm-swap`, `queue-redeem`, or `offchain-issuer`                                                                                                                   |
| `accessModel`                | `string`                                                                                                                                                   | `permissionless-onchain`, `whitelisted-onchain`, `issuer-api`, or `manual`                                                                                                                                                    |
| `settlementModel`            | `string`                                                                                                                                                   | `atomic`, `immediate`, `same-day`, `days`, or `queued`                                                                                                                                                                        |
| `outputAssetType`            | `string`                                                                                                                                                   | `stable-single`, `stable-basket`, `bluechip-collateral`, `mixed-collateral`, or `nav`                                                                                                                                         |
| `sourceMode`                 | `string`                                                                                                                                                   | `dynamic`, `estimated`, or `static` capacity provenance                                                                                                                                                                       |
| `resolutionState`            | `string`                                                                                                                                                   | `resolved`, `missing-cache`, `missing-capacity`, `failed`, or `impaired`                                                                                                                                                      |
| `routeStatus`                | `string`                                                                                                                                                   | Current route availability: `open`, `degraded`, `paused`, `cohort-limited`, or `unknown`                                                                                                                                      |
| `routeStatusSource`          | `string`                                                                                                                                                   | Source for current route availability: `static-config`, `market-implied`, `operator-notice`, `protocol-api`, or `onchain`                                                                                                     |
| `routeStatusReason`          | `string \| undefined`                                                                                                                                      | Human-readable explanation when current availability impairs scoring                                                                                                                                                          |
| `routeStatusReviewedAt`      | `string \| undefined`                                                                                                                                      | UTC date (`YYYY-MM-DD`) for the current route-status assessment                                                                                                                                                               |
| `holderEligibility`          | `string`                                                                                                                                                   | Modeled holder cohort: `any-holder`, `verified-customer`, `whitelisted-primary`, `pre-incident-holder`, `issuer-discretionary`, or `unknown`                                                                                  |
| `capacityConfidence`         | `string`                                                                                                                                                   | `live-direct`, `live-proxy`, `documented-bound`, `heuristic`, or legacy `dynamic` fidelity tag for the capacity model                                                                                                         |
| `capacityBasis`              | `string \| undefined`                                                                                                                                      | Typed basis for the modeled capacity, such as `issuer-term-redemption`, `full-system-eventual`, `psm-balance-share`, `strategy-buffer`, `hot-buffer`, `daily-limit`, `live-direct-telemetry`, or `live-proxy-buffer`          |
| `capacitySemantics`          | `string`                                                                                                                                                   | `immediate-bounded` or `eventual-only`, distinguishing current redeemable buffer from eventual redeemability                                                                                                                  |
| `capacityProfile`            | `object \| undefined`                                                                                                                                      | Optional v4 capacity profile separating immediate, daily, queued, eventual, and scoring capacity with a `scoringHorizon` and `capacityProfileConfidence`                                                                      |
| `capacityKind`               | `string \| undefined`                                                                                                                                      | Optional adapter-declared live evidence shape, such as `live-direct-bounded`, `live-queue`, `live-proxy-validated`, `documented-bound`, `documented-eventual`, or `heuristic`. Context only; not Safety eligibility by itself |
| `freshnessKind`              | `string \| undefined`                                                                                                                                      | Optional adapter-declared redemption freshness evidence, such as `verified-source-timestamp`, `same-run-onchain`, `same-run-api`, `reviewed-static`, or `unverified`                                                          |
| `confidenceDetails`          | `object \| undefined`                                                                                                                                      | Optional v4 confidence rollup dimensions for capacity evidence, fee evidence, route-status freshness, holder-cohort breadth, and source quality                                                                               |
| `sourceTimestamp`            | `number \| undefined`                                                                                                                                      | Optional source timestamp emitted by a live reserve adapter for the redemption telemetry                                                                                                                                      |
| `sourceUrls`                 | `string[] \| undefined`                                                                                                                                    | Optional source URLs emitted by a live reserve adapter for the redemption telemetry                                                                                                                                           |
| `settlementDelaySec`         | `number \| undefined`                                                                                                                                      | Optional adapter-emitted settlement delay constraint in seconds                                                                                                                                                               |
| `queueDepthUsd`              | `number \| undefined`                                                                                                                                      | Optional adapter-emitted queued redemption depth in USD                                                                                                                                                                       |
| `dailyLimitUsd`              | `number \| undefined`                                                                                                                                      | Optional adapter-emitted daily redemption limit in USD                                                                                                                                                                        |
| `minRedeemUsd`               | `number \| undefined`                                                                                                                                      | Optional adapter-emitted minimum redemption size in USD                                                                                                                                                                       |
| `liveHolderEligibility`      | `string \| undefined`                                                                                                                                      | Optional adapter-emitted holder eligibility context when it differs from or sharpens the static model                                                                                                                         |
| `eventualRedeemabilityScore` | `number \| null \| undefined`                                                                                                                              | Optional v4 long-tail legal/protocol redeemability score, separate from current executable exit capacity                                                                                                                      |
| `feeConfidence`              | `string`                                                                                                                                                   | `fixed`, `formula`, or `undisclosed-reviewed` fidelity tag for the fee model                                                                                                                                                  |
| `feeModelKind`               | `string`                                                                                                                                                   | `fixed-bps`, `formula`, `documented-variable`, or `undisclosed-reviewed`                                                                                                                                                      |
| `modelConfidence`            | `string`                                                                                                                                                   | Overall route-fidelity rollup: `high`, `medium`, or `low`                                                                                                                                                                     |
| `immediateCapacityUsd`       | `number \| null`                                                                                                                                           | Immediate redeemable capacity in USD. `null` when the model is eventual-only or currently unrated                                                                                                                             |
| `immediateCapacityRatio`     | `number \| null`                                                                                                                                           | Immediate redeemable capacity as a share of supply. `null` when not separately quantified                                                                                                                                     |
| `feeBps`                     | `number \| null`                                                                                                                                           | Explicit bounded fee when configured                                                                                                                                                                                          |
| `feeDescription`             | `string \| undefined`                                                                                                                                      | Docs-backed fee description for variable, conditional, flat-minimum, or undisclosed redemption schedules                                                                                                                      |
| `costScenarioScores`         | `object \| undefined`                                                                                                                                      | Optional v4 cost scores for retail, active-user, and institutional route-size scenarios                                                                                                                                       |
| `routeExitCorrelation`       | `string \| undefined`                                                                                                                                      | Optional v4 correlation tag for DEX-vs-redemption independence, such as `independent-issuer-rail`, `same-stablecoin-pool-backing`, `same-protocol-liquidity`, `wrapper-to-parent-dependency`, or `unknown`                    |
| `queueEnabled`               | `boolean`                                                                                                                                                  | Whether the modeled route is explicitly queued/serial                                                                                                                                                                         |
| `docs`                       | `{ label?: string, url?: string, reviewedAt?: string, provenance?: string, sources?: { label: string, url: string, supports?: string[] }[] } \| undefined` | Optional documentation / transparency metadata. `reviewedAt` is the route-review date, while `provenance` is `config-reviewed`, `live-reserve-display`, `proof-of-reserves`, or `preferred-link`                              |
| `notes`                      | `string[] \| undefined`                                                                                                                                    | Runtime notes such as stale reserve metadata fallback                                                                                                                                                                         |
| `capsApplied`                | `string[] \| undefined`                                                                                                                                    | Applied score caps (`queue-route-cap`, `offchain-route-cap`, `config-cap`)                                                                                                                                                    |

**Response (503):** `{ "error": "Data not yet available" }` or `{ "error": "Redemption backstop snapshot unavailable" }`

---

### `GET /api/safety-score-history`

Per-coin Safety Score grade transition history (seed row + grade changes only). Rows are written by the daily `snapshot-safety-grade-history` cron and returned in ascending date order.

**Cache:** slow

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param  | Type      | Default | Bounds | Description             |
| ------ | --------- | ------- | ------ | ----------------------- |
| `days` | `integer` | `365`   | 1–3650 | Lookback window in days |

**Response:** Array sorted by `date` ascending.

```json
[
  {
    "date": 1771977600,
    "grade": "B+",
    "score": 78,
    "prevGrade": "B",
    "prevScore": 74,
    "methodologyVersion": "5.5"
  }
]
```

| Field                | Type             | Description                                               |
| -------------------- | ---------------- | --------------------------------------------------------- |
| `date`               | `number`         | UTC day bucket (Unix seconds) when the event was recorded |
| `grade`              | `string`         | Current Safety Score letter grade at `date`               |
| `score`              | `number \| null` | Current numeric score (0–100); `null` when grade is `NR`  |
| `prevGrade`          | `string \| null` | Previous grade before this event; `null` for the seed row |
| `prevScore`          | `number \| null` | Previous score before this event; `null` for the seed row |
| `methodologyVersion` | `string`         | Safety Score methodology version used for this event row  |

---

### `GET /api/yield-rankings`

Cache-backed yield rankings written by `sync-yield-data`. The post-V9 publisher and API-time hydrator read the canonical current `report-cards:v9` publication through the shared safety loader, so Yield Intelligence stays aligned with `/api/report-cards/v9` without recomputing Safety Scores. A missing, held, stale, or incompatible V9 publication makes the safety snapshot explicitly unavailable; ranking rows remain available with the documented NR/default treatment and `safety-unrated` provenance. Royco Dawn structured-tranche rows use the attached underlying asset's V9 score before applying opportunity-level source risk. PYS remains benchmark-aware and source-risk-aware, and expired source or benchmark evidence returns a null PYS with the corresponding reason.

Set `projection=summary` for the compact workbench contract. It preserves leaderboard, filter, scatter, comparison, benchmark, warning, publication, and evidence-qualification fields while omitting retained alternatives and deep decision/source-risk evidence. The detailed response remains the default. Repeated or unknown `projection` values return a non-cacheable `400`.

**Cache:** standard — `X-Data-Age` and `Warning` headers included. Freshness threshold: 1800 s (30 minutes, aligned to the post-V9 `sync-yield-data` publisher).

**Error responses:** `503` when the cached rankings payload is missing, unparseable JSON, or parseable JSON that fails the `YieldRankingsResponseSchema` cache-read validation. Schema-invalid cached objects are not served because the endpoint cannot safely hydrate or trust their row shape.

**Response**

```text
{
  "rankings": [YieldRanking, ...],
  "riskFreeRate": 4.25,
  "benchmarks": {
    "USD": { "key": "USD", "label": "USD 3M T-Bill", "currency": "USD", "rate": 4.25, "recordDate": "2026-03-25", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "fred-dgs3mo", "isFallback": false, "fallbackMode": null, "isProxy": false },
    "EUR": { "key": "EUR", "label": "EUR 3M compounded €STR", "currency": "EUR", "rate": 1.9358, "recordDate": "2026-03-26", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "ecb-estr-3m", "isFallback": false, "fallbackMode": null, "isProxy": false },
    "CHF": { "key": "CHF", "label": "CHF 3M compounded SARON", "currency": "CHF", "rate": -0.0539, "recordDate": "2026-03-25", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "six-sar3mc", "isFallback": false, "fallbackMode": null, "isProxy": false }
  },
  "scalingFactor": 8,
  "medianApy": 4.21,
  "updatedAt": 1772000000,
  "provenance": {
    "selectionMethod": "confidence-weighted",
    "benchmark": { "key": "USD", "label": "USD 3M T-Bill", "currency": "USD", "rate": 4.25, "recordDate": "2026-03-25", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "fred-dgs3mo", "isFallback": false, "fallbackMode": null, "isProxy": false },
    "benchmarks": {
      "USD": { "key": "USD", "label": "USD 3M T-Bill", "currency": "USD", "rate": 4.25, "recordDate": "2026-03-25", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "fred-dgs3mo", "isFallback": false, "fallbackMode": null, "isProxy": false },
      "EUR": { "key": "EUR", "label": "EUR 3M compounded €STR", "currency": "EUR", "rate": 1.9358, "recordDate": "2026-03-26", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "ecb-estr-3m", "isFallback": false, "fallbackMode": null, "isProxy": false },
      "CHF": { "key": "CHF", "label": "CHF 3M compounded SARON", "currency": "CHF", "rate": -0.0539, "recordDate": "2026-03-25", "fetchedAt": 1774425600, "ageSeconds": 0, "source": "six-sar3mc", "isFallback": false, "fallbackMode": null, "isProxy": false }
    },
    "dlPools": { "mode": "dex-cache", "ageSeconds": 240, "poolCount": 812 },
    "safetySnapshot": {
      "kind": "ok",
      "coverageRatio": 0.8532,
      "coveredCount": 308,
      "trackedCount": 361,
      "reason": null,
      "source": "safety-score-v9-publication",
      "publicationGenerationId": "report-cards:v9:v1:<sha256>",
      "methodologyVersion": "9.33",
      "publishedAt": 1771999800
    },
    "liveSafetyHydration": {
      "kind": "ok",
      "coverageRatio": 0.9846,
      "coveredCount": 64,
      "trackedCount": 65,
      "reason": null,
      "source": "safety-score-v9-publication",
      "publicationGenerationId": "report-cards:v9:v1:<sha256>",
      "methodologyVersion": "9.33",
      "publishedAt": 1772000700
    }
  },
  "warnings": [],
  "publication": {
    "generationId": "yield-1772000000",
    "updatedAt": 1772000000,
    "cutoffAt": 1772000000,
    "schemaVersion": 1,
    "status": "published"
  },
  "methodology": {
    "version": "8.37",
    "currentVersion": "8.41",
    "changelogPath": "/methodology/yield-changelog/"
  },
  "_meta": { "updatedAt": 1710500000, "ageSeconds": 42, "status": "fresh" }
}
```

| Field           | Type                     | Description                                                                                                                                                                                                     |
| --------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rankings`      | `YieldRanking[]`         | All ranked stablecoins, sorted by Pharos Yield Score descending                                                                                                                                                 |
| `riskFreeRate`  | `number`                 | Default USD benchmark rate (%) retained for backward compatibility and mixed-view fallback                                                                                                                      |
| `benchmarks`    | `object \| null`         | Benchmark registry keyed by currency (`USD`, `EUR`, `CHF`, plus v8.13: `GBP`, `JPY`, `MXN`, `BRL`, `AUD`, `CAD`; `SGD` is reserved without a fetcher) with label, rate, freshness, fallback, and proxy metadata |
| `scalingFactor` | `number`                 | Scaling factor applied in yield score computation                                                                                                                                                               |
| `medianApy`     | `number`                 | TVL-weighted median APY (30d) across best-source rows, used as a peer reference in warning heuristics                                                                                                           |
| `updatedAt`     | `number`                 | Unix seconds when the rankings were last computed                                                                                                                                                               |
| `provenance`    | `object \| null`         | Snapshot-level provenance for benchmark and pool freshness, immutable post-V9 Safety Score evidence, optional live read-time hydration health, and selection method                                              |
| `warnings`      | `YieldResponseWarning[]` | Optional body-level warnings for degraded but still served payloads. `yield-safety-hydration-degraded` marks partial or cleared safety hydration; `yield-safety-hydration-stale` marks rows served from the payload's own coherent publish-time safety snapshot while live hydration is unusable. Clients should surface these separately from row-level `warningSignals`                                |
| `publication`   | `object \| null`         | Optional publication metadata for generation-aware payloads; omitted on legacy payloads                                                                                                                         |
| `methodology`   | `object \| undefined`    | Optional Yield Intelligence methodology envelope for rankings payloads when emitted by the publisher                                                                                                            |

Optional v8 fields are nullable and omittable. Publication-generation fields are populated by the generation-aware publisher when available; legacy rows and old payloads may still omit them. Public source-risk values are nested under the `sourceRisk` object; flattened top-level fields such as `sourceRiskPenalty` or `rewardShare` are not part of the public API contract.

| Field                                    | Surface                     | Type                                                                                                                                                                                                              | Population status                                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publication.generationId`               | rankings/history root       | `string \| null \| undefined`                                                                                                                                                                                     | Publisher generation identifier, e.g. `yield-1774526400`; omitted on legacy payloads                                                                                              |
| `publication.updatedAt`                  | rankings/history root       | `number \| null \| undefined`                                                                                                                                                                                     | Unix seconds when the generation was computed                                                                                                                                     |
| `publication.cutoffAt`                   | rankings/history root       | `number \| null \| undefined`                                                                                                                                                                                     | Latest history timestamp approved for public reads                                                                                                                                |
| `publication.schemaVersion`              | rankings/history root       | `number \| null \| undefined`                                                                                                                                                                                     | Payload-generation schema version                                                                                                                                                 |
| `publication.status`                     | rankings/history root       | `"staged" \| "published" \| "failed" \| null \| undefined`                                                                                                                                                        | Public cache payloads should expose `published`; failed or CAS-skipped generations do not replace current `yield_data` rows                                                       |
| `warnings[]`                             | rankings root               | `YieldResponseWarning[] \| undefined`                                                                                                                                                                             | Body-level degraded-response advisories; row source warnings remain in `warningSignals`                                                                                           |
| `pysNullReason`                          | ranking rows                | `"apy-non-positive" \| "effective-yield-non-positive" \| "scaling-invalid" \| "missing-inputs" \| "source-stale" \| "source-freshness-unknown" \| "benchmark-stale" \| "safety-unrated" \| "opportunity-evidence-missing" \| null \| undefined` | Machine-readable reason a numeric current PYS is unavailable. `safety-unrated` and `opportunity-evidence-missing` remain valid for historical payloads; current rows surface those as estimate warnings instead |
| `provenance.sourceFreshness`             | ranking rows                | `"fresh" \| "stale" \| "unknown" \| undefined`                                                                                                                                                              | Source-family eligibility state used before confidence arbitration                                                                                                                |
| `provenance.benchmarkFreshness`          | ranking rows                | `"healthy" \| "degraded" \| "stale" \| undefined`                                                                                                                                                            | Row benchmark state; fallback within TTL is degraded, while stale cannot support exact PYS                                                                                        |
| `provenance.scoreQualified`              | ranking rows                | `boolean \| undefined`                                                                                                                                                                                            | Whether current source and benchmark freshness permit a numeric PYS; use `scoreQualification` to distinguish rated, partial, and estimated rows                                  |
| `provenance.safetySnapshot.source`       | rankings root               | `"safety-score-v9-publication" \| undefined` | Canonical V9 safety publication used by the post-V9 publisher |
| `provenance.safetySnapshot.publicationGenerationId` | rankings root      | `string \| null \| undefined`                                                                                                                                                                                     | Report-card publication generation consumed for PYS; `null` when no exact projection was accepted                                                                                 |
| `provenance.safetySnapshot.methodologyVersion` | rankings root           | `string \| null \| undefined`                                                                                                                                                                                     | Safety Score methodology pinned by the consumed report-card projection                                                                                                            |
| `provenance.safetySnapshot.publishedAt`  | rankings root               | `number \| null \| undefined`                                                                                                                                                                                     | Unix seconds for the compact report-card projection consumed by the post-V9 publisher                                                                                             |
| `provenance.liveSafetyHydration`         | rankings root               | `object \| undefined`                                                                                                                                                                                             | Optional read-time evidence for the report-card data used to hydrate public safety fields and recompute PYS; it does not replace `safetySnapshot`                                  |
| `provenance.liveSafetyHydration.kind`    | rankings root               | `"ok" \| "degraded"`                                                                                                                                                                                           | Read-time hydration health after source freshness/input checks and row coverage evaluation                                                                                         |
| `provenance.liveSafetyHydration.fallback` | rankings root              | `"publish-time-snapshot" \| undefined`                                                                                                                                                                          | Present when live hydration is unusable but rows still carry the cached payload's own coherent publish-time safety values (warning code `yield-safety-hydration-stale`); absent when hydration succeeded or the response degraded to NR fields                                  |
| `provenance.liveSafetyHydration.coverageRatio` | rankings root         | `number`                                                                                                                                                                                                          | `coveredCount / trackedCount` for hydrated ranking rows, rounded to four decimals                                                                                                  |
| `provenance.liveSafetyHydration.coveredCount` | rankings root          | `number`                                                                                                                                                                                                          | Ranking rows hydrated from a report card or explicit opportunity safety rather than the default safety fallback                                                                    |
| `provenance.liveSafetyHydration.trackedCount` | rankings root          | `number`                                                                                                                                                                                                          | Total ranking rows evaluated during read-time hydration                                                                                                                            |
| `provenance.liveSafetyHydration.reason`  | rankings root               | `string \| null`                                                                                                                                                                                                  | Comma-separated degradation reasons, including stale report-card inputs/snapshot age or low row coverage                                                                           |
| `provenance.liveSafetyHydration.source`  | rankings root               | `"safety-score-v9-publication"` | Canonical current V9 publication used for response hydration |
| `provenance.liveSafetyHydration.publicationGenerationId` | rankings root | `string \| null`                                                                                                                                                                                     | Full report-card publication generation used for hydration; `null` when no compatible V9 publication was accepted                                                                 |
| `provenance.liveSafetyHydration.methodologyVersion` | rankings root     | `string \| null`                                                                                                                                                                                                  | Full report-card publication methodology; `null` when V9 safety hydration is unavailable                                                                                           |
| `provenance.liveSafetyHydration.publishedAt` | rankings root           | `number \| null`                                                                                                                                                                                                  | Full report-card snapshot timestamp; `null` when V9 safety hydration is unavailable                                                                                                |
| `publicationGenerationId`                | ranking/history rows        | `string \| null \| undefined`                                                                                                                                                                                     | Row-to-generation join identifier; `null` on legacy rows                                                                                                                          |
| `publishedRank`                          | ranking rows                | `integer >= 1 \| null \| undefined`                                                                                                                                                                               | Stable rank from the published cache order before live Safety Score hydration                                                                                                     |
| `liveRank`                               | ranking rows                | `integer >= 1 \| null \| undefined`                                                                                                                                                                               | Post-hydration rank assigned after live Safety Score recomputation                                                                                                                |
| `sourceRole`                             | ranking/source rows         | `"canonical-holder" \| "external-opportunity" \| "fallback-proxy" \| "audit-alternate" \| "degraded-canonical" \| undefined`                                                                                      | Worker-derived source role explaining whether the row is the selected holder source, external opportunity, fallback proxy, retained audit alternate, or degraded canonical source |
| `altSources[].confidenceTier`            | ranking rows                | `"deterministic" \| "curated" \| "discovered" \| "fallback" \| undefined`                                                                                                                                         | Source-candidate confidence tier from the worker arbitration pass                                                                                                                 |
| `altSources[].selectionRank`             | ranking rows                | `integer >= 1 \| undefined`                                                                                                                                                                                       | Rank inside the worker's source-candidate ordering for that stablecoin                                                                                                            |
| `altSources[].rejectionReasonCode`       | ranking rows                | `"thinner" \| "stale" \| "lower-confidence" \| "rewards-only" \| "smaller" \| "unspecified" \| undefined`                                                                                                         | Stable reason code for why the retained alternate did not become the selected source                                                                                              |
| `alternateSummary`                       | ranking rows                | `object \| null \| undefined`                                                                                                                                                                                     | Optional deterministic summary of retained alternates: count, best 30d-APY alternate, best source-risk-adjusted alternate, and APY spread versus selected                         |
| `sourceRisk.sourceRiskScore`             | ranking/history/source rows | `0..100 number \| null \| undefined`                                                                                                                                                                              | Optional source-risk score when populated by the source-risk worker                                                                                                               |
| `sourceRisk.sourceRiskPenalty`           | ranking/history/source rows | `number >= 1 \| null \| undefined`                                                                                                                                                                                | Active PYS v8 source-risk multiplier derived from reliable source evidence. Missing/invalid values are neutral (`1`); runtime clamps values to `1..2.5`                           |
| `sourceRisk.sourceDepthRatio`            | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Optional venue-depth ratio                                                                                                                                                        |
| `sourceRisk.rewardShare`                 | ranking/history/source rows | `0..1 number \| null \| undefined`                                                                                                                                                                                | Optional reward APY share                                                                                                                                                         |
| `sourceRisk.sourceAgeSeconds`            | ranking/history/source rows | `integer seconds >= 0 \| null \| undefined`                                                                                                                                                                       | Optional source-observation age                                                                                                                                                   |
| `sourceRisk.observationCount30d`         | ranking/history/source rows | `integer >= 0 \| null \| undefined`                                                                                                                                                                               | Optional 30-day observation count for the source                                                                                                                                  |
| `sourceRisk.sourceSwitchCount30d`        | ranking/history/source rows | `integer >= 0 \| null \| undefined`                                                                                                                                                                               | Optional 30-day selected-source switch count                                                                                                                                      |
| `sourceRisk.deploymentPlace`             | ranking/history/source rows | `"native-wrapper" \| "issuer-savings" \| "lending-market" \| "strategy-vault" \| "structured-tranche" \| "lp-or-dex" \| "rwa-fund" \| "reward-program" \| "rate-derived" \| "price-derived" \| null \| undefined` | Optional sourced deployment-place label                                                                                                                                           |
| `sourceRisk.venueProtocol`               | ranking/history/source rows | `string \| null \| undefined`                                                                                                                                                                                     | Optional venue protocol label                                                                                                                                                     |
| `sourceRisk.venueChain`                  | ranking/history/source rows | `string \| null \| undefined`                                                                                                                                                                                     | Optional venue chain label                                                                                                                                                        |
| `sourceRisk.venueRiskTier`               | ranking/history/source rows | `"low" \| "medium" \| "high" \| "unknown" \| null \| undefined`                                                                                                                                                   | Optional sourced venue tier; unknown remains neutral                                                                                                                              |
| `sourceRisk.venueRiskScores`             | ranking/history/source rows | `object \| null \| undefined`                                                                                                                                                                                     | Optional Yearn-style venue sub-scores (`audits`, `centralization`, `fundsManagement`, `liquidity`, `operational`), each `1..5`                                                    |
| `sourceRisk.venueRiskWeighted`           | ranking/history/source rows | `1..5 number \| null \| undefined`                                                                                                                                                                                | Optional weighted venue-risk score derived from the venue sub-scores                                                                                                              |
| `sourceRisk.venueRiskConfidence`         | ranking/history/source rows | `"verified" \| "partial" \| "low" \| null \| undefined`                                                                                                                                                           | Optional evidence-confidence label for the reviewed venue-risk inputs                                                                                                             |
| `sourceRisk.dependencyConcentration`     | ranking/history/source rows | `object \| null \| undefined`                                                                                                                                                                                     | Optional reviewed cross-venue concentration signal with `ecosystem`, `severity`, `note`, and `reviewedAt`                                                                         |
| `sourceRisk.investabilityFlags`          | ranking/history/source rows | `string[] \| undefined`                                                                                                                                                                                           | Optional investability caveats                                                                                                                                                    |
| `sourceRisk.trancheSide`                 | ranking/history/source rows | `"senior" \| "junior" \| null \| undefined`                                                                                                                                                                       | Royco Dawn tranche side for structured-tranche rows                                                                                                                               |
| `sourceRisk.trancheSafetyScore`          | ranking/history/source rows | `0..100 number \| null \| undefined`                                                                                                                                                                              | Opportunity-level Safety Score used by Royco Dawn tranche rows after underlying-score and tranche-risk adjustments                                                                |
| `sourceRisk.trancheSafetyPenalty`        | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Difference between the underlying report-card Safety Score and the final tranche Safety Score                                                                                     |
| `sourceRisk.underlyingSafetyScore`       | ranking/history/source rows | `0..100 number \| null \| undefined`                                                                                                                                                                              | Current underlying report-card Safety Score input used for opportunity-level tranche scoring                                                                                      |
| `sourceRisk.marketCoverageRatio`         | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Current Royco market coverage ratio                                                                                                                                               |
| `sourceRisk.marketMinCoverageRatio`      | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Royco market minimum required coverage ratio                                                                                                                                      |
| `sourceRisk.marketUtilizationRatio`      | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Current Royco market utilization ratio                                                                                                                                            |
| `sourceRisk.marketUtilizationLimitRatio` | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Royco market utilization target or limit ratio when supplied                                                                                                                      |
| `sourceRisk.marketDrawdownRatio`         | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Current Royco market drawdown ratio                                                                                                                                               |
| `sourceRisk.marketTotalDrawdowns`        | ranking/history/source rows | `integer >= 0 \| null \| undefined`                                                                                                                                                                               | Royco market drawdown count when supplied                                                                                                                                         |
| `sourceRisk.marketStatus`                | ranking/history/source rows | `"normal" \| "protected" \| "unhealthy" \| "critical" \| null \| undefined`                                                                                                                                       | Normalized Royco market status used by tranche scoring                                                                                                                            |
| `sourceRisk.marketTvlUsd`                | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Royco market-level TVL in USD                                                                                                                                                     |
| `sourceRisk.trancheTvlUsd`               | ranking/history/source rows | `number >= 0 \| null \| undefined`                                                                                                                                                                                | Royco vault/tranche TVL in USD                                                                                                                                                    |
| `sourceRisk.trancheShareTokenAddress`    | ranking/history/source rows | `string \| null \| undefined`                                                                                                                                                                                     | Share-token address for the Royco tranche vault                                                                                                                                   |
| `sourceRisk.trancheDepositTokenAddress`  | ranking/history/source rows | `string \| null \| undefined`                                                                                                                                                                                     | Deposit-token address used to attach the tranche row to a tracked underlying stablecoin                                                                                           |
| `sourceRisk.withdrawalDelaySeconds`      | ranking/history/source rows | `integer seconds >= 0 \| null \| undefined`                                                                                                                                                                       | Withdrawal/redemption delay for the tranche when supplied                                                                                                                         |
| `sourceRisk.kycRequired`                 | ranking/history/source rows | `boolean \| null \| undefined`                                                                                                                                                                                    | Whether the source marks KYC as required                                                                                                                                          |
| `sourceRisk.accessRestricted`            | ranking/history/source rows | `boolean \| null \| undefined`                                                                                                                                                                                    | Whether the source marks jurisdictional or other access restrictions                                                                                                              |
| `sourceRisk.opportunityRisk`             | ranking/history/source rows | `object \| null \| undefined`                                                                                                                                                                                     | v8.32 opportunity-level risk contract for external opportunities: `opportunityClass` (`"lending" \| "fixed-yield" \| "structured-tranche"`), `underlyingSafetyScore`, nullable `opportunitySafetyScore` / `opportunitySafetyPenalty`, `venueReviewed`, and `missingCriticalEvidence` (`"venue-review" \| "market-size" \| "market-status"`) |
| `rankChangeAttribution`                  | ranking rows                | `object \| null \| undefined`                                                                                                                                                                                     | Optional previous-rank/PYS delta attribution with primary driver and contribution hints                                                                                           |
| `decisionLedger`                         | ranking rows                | `object \| null \| undefined`                                                                                                                                                                                     | Bounded selected-source decision evidence, including selected reason, source-switch metadata, rejected count, and up to two public alternatives with role/rank/rejection metadata |

Holder-yield rows still treat missing source-risk evidence as neutral: omitted or `null` `sourceRisk`, `sourceRisk.sourceRiskPenalty`, or `sourceRisk.venueRiskTier` values resolve to a neutral source-risk penalty and do not change PYS or report-card scoring. `sourceRisk.sourceRiskScore` is now derived from the resolved source-risk penalty when no upstream value is provided. Since `v8.32`, external opportunity rows (`lending-opportunity`, `fixed-yield`, `structured-tranche` yield types) are no longer neutral on missing market evidence: they publish `sourceRisk.opportunityRisk`, score safety at the opportunity level with `safetyProvenance: "opportunity-safety"` when critical evidence is complete, and otherwise withhold the exact PYS with `pysNullReason: "opportunity-evidence-missing"` and an `NR` score qualification. Royco Dawn structured-tranche rows additionally carry opportunity-level Safety Score evidence under `sourceRisk.tranche*`; this changes only the yield row's safety input and PYS, not the underlying stablecoin's report-card Safety Score. Generic on-chain exchange-rate and price-derived APY observations above the deterministic 300% sanity envelope are rejected before publication; protocol-specific adapters and benchmark rate-derived rows retain their family-specific rules. DEWS methodology v5.99 consumes only populated structured yield stress evidence inside its Yield Anomaly sub-signal; neutral, malformed, or missing structured rows remain no-ops. Saved payloads used by calibration tooling should normalize from the nested `sourceRisk.*` fields before analysis rather than assuming flattened row properties.

**`YieldRanking`**

| Field                     | Type                                                                                                                          | Description                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `string`                                                                                                                      | Pharos stablecoin ID                                                                                                                                                                                                  |
| `symbol`                  | `string`                                                                                                                      | Token symbol                                                                                                                                                                                                          |
| `name`                    | `string`                                                                                                                      | Full name                                                                                                                                                                                                             |
| `currentApy`              | `number`                                                                                                                      | Current APY (%)                                                                                                                                                                                                       |
| `apy7d`                   | `number`                                                                                                                      | 7-day average APY (%)                                                                                                                                                                                                 |
| `apy30d`                  | `number`                                                                                                                      | 30-day average APY (%)                                                                                                                                                                                                |
| `apyBase`                 | `number \| null`                                                                                                              | Base APY component (%)                                                                                                                                                                                                |
| `apyReward`               | `number \| null`                                                                                                              | Reward APY component (%), `null` if none                                                                                                                                                                              |
| `yieldSource`             | `string`                                                                                                                      | Human-readable yield source description                                                                                                                                                                               |
| `yieldSourceUrl`          | `string \| null`                                                                                                              | Official URL for the selected source when Pharos has a curated or metadata-derived link                                                                                                                               |
| `yieldType`               | `string`                                                                                                                      | Yield type classification (e.g. `"lending-vault"`, `"staking"`)                                                                                                                                                       |
| `dataSource`              | `string`                                                                                                                      | Data source identifier (e.g. `"defillama"`)                                                                                                                                                                           |
| `sourceTvlUsd`            | `number \| null`                                                                                                              | TVL of the yield source pool (USD)                                                                                                                                                                                    |
| `pharosYieldScore`        | `number \| null`                                                                                                              | Composite Pharos Yield Score (0–100), recomputed at read time from cached APY + benchmark inputs plus the current Safety Score                                                                                        |
| `safetyScore`             | `number \| null`                                                                                                              | Current Safety Score input used by Yield Intelligence. Rated coins match `/api/report-cards/v9`; Royco structured-tranche rows expose the row-level tranche score; unrated coins use the default NR penalty input (`40`) |
| `safetyGrade`             | `string \| null`                                                                                                              | Current Safety Score letter grade (`"A+"` through `"F"`, or `"NR"`); Royco structured-tranche rows derive the grade from the opportunity-level tranche score                                                          |
| `safetyReason`            | `"report-card-score-missing" \| "report-card-grade-not-rated" \| "underlying-report-card-score-missing" \| null \| undefined` | Stable reason for a default or explicit-NR safety input; `null` for normally rated rows                                                                                                                               |
| `yieldToRisk`             | `number \| null`                                                                                                              | Yield-to-risk ratio recomputed at read time from cached APY inputs plus the current Safety Score                                                                                                                      |
| `excessYield`             | `number \| null`                                                                                                              | 30-day average APY above the row benchmark (percentage points)                                                                                                                                                        |
| `benchmarkKey`            | `"USD" \| "EUR" \| "CHF" \| "GBP" \| "JPY" \| "MXN" \| "BRL" \| "AUD" \| "CAD" \| "SGD" \| undefined`                         | Benchmark selected for this row's `excessYield` and any rate-derived APY logic (v8.13 expanded the set; `SGD` is reserved without a fetcher and routes to USD fallback)                                               |
| `benchmarkLabel`          | `string \| undefined`                                                                                                         | Human-readable benchmark label for the row                                                                                                                                                                            |
| `benchmarkCurrency`       | `string \| undefined`                                                                                                         | Benchmark currency code used for the row                                                                                                                                                                              |
| `benchmarkRate`           | `number \| undefined`                                                                                                         | Benchmark rate (%) applied to this row                                                                                                                                                                                |
| `benchmarkRecordDate`     | `string \| null \| undefined`                                                                                                 | Market or policy record date for the selected benchmark                                                                                                                                                               |
| `benchmarkIsFallback`     | `boolean \| undefined`                                                                                                        | Whether the row benchmark is currently on a fallback path                                                                                                                                                             |
| `benchmarkFallbackMode`   | `string \| null \| undefined`                                                                                                 | Fallback reason for the row benchmark when applicable                                                                                                                                                                 |
| `benchmarkSelectionMode`  | `"native" \| "fallback-usd" \| "manual-override" \| undefined`                                                                | How the row benchmark was selected                                                                                                                                                                                    |
| `benchmarkIsProxy`        | `boolean \| undefined`                                                                                                        | True when the selected benchmark is an explicit proxy rather than the exact reference rate                                                                                                                            |
| `yieldStability`          | `number \| null`                                                                                                              | Yield stability metric (0–1; higher = more stable)                                                                                                                                                                    |
| `apyVariance30d`          | `number \| null`                                                                                                              | 30-day APY variance                                                                                                                                                                                                   |
| `apyMin30d`               | `number \| null`                                                                                                              | Minimum APY in last 30 days (%)                                                                                                                                                                                       |
| `apyMax30d`               | `number \| null`                                                                                                              | Maximum APY in last 30 days (%)                                                                                                                                                                                       |
| `warningSignals`          | `string[]`                                                                                                                    | Active warning-signal flags for the selected best source                                                                                                                                                              |
| `altSources`              | `AltYieldSource[]`                                                                                                            | Additional non-selected source rows for the same coin                                                                                                                                                                 |
| `alternateSummary`        | `object \| null \| undefined`                                                                                                 | Optional deterministic summary of retained alternates: count, best 30d-APY alternate, best source-risk-adjusted alternate, and spread versus selected                                                                 |
| `provenance`              | `object \| null`                                                                                                              | Source-level provenance: confidence tier, selection reason, benchmark state, source-switch metadata, source freshness, and optional anchor timing                                                                     |
| `publicationGenerationId` | `string \| null \| undefined`                                                                                                 | Publication-generation identifier, or `null`/omitted for legacy rows                                                                                                                                                  |
| `publishedRank`           | `number \| null \| undefined`                                                                                                 | Stable publication-order rank from the cached generation                                                                                                                                                              |
| `liveRank`                | `number \| null \| undefined`                                                                                                 | Post-hydration rank from the response order after live Safety Score recomputation                                                                                                                                     |
| `sourceRisk`              | `object \| null \| undefined`                                                                                                 | Optional nested source-risk payload. Runtime rows derive or resolve `sourceRisk.sourceRiskPenalty` before PYS v8 scoring; missing or unknown values remain neutral                                                    |
| `sourceRole`              | `string \| undefined`                                                                                                         | Worker-derived role (`canonical-holder`, `external-opportunity`, `fallback-proxy`, `audit-alternate`, or `degraded-canonical`) for selected and alternate source transparency                                         |
| `rankChangeAttribution`   | `object \| null \| undefined`                                                                                                 | Optional rank-change attribution with previous rank/PYS, delta, primary driver, and driver contribution hints                                                                                                         |
| `decisionLedger`          | `object \| null \| undefined`                                                                                                 | Bounded selected-source decision evidence with stable reason/rejection codes and up to two public alternatives                                                                                                        |

When present, `YieldRanking.provenance` includes:

- `sourceObservedAt` / `sourceAgeSeconds`: the timestamp and age of the latest observation actually backing the row
- `comparisonAnchorObservedAt` / `comparisonAnchorAgeSeconds`: optional prior-anchor timing for APYs derived from two observations, such as price-derived and on-chain exchange-rate rows
- `safetyReason`: the same stable missing/default/NR reason published on the ranking row, or `null` for a normally rated row
- `benchmarkKey`, `benchmarkLabel`, `benchmarkRate`, `benchmarkIsFallback`, `benchmarkSelectionMode`, and related fields for the exact benchmark applied to that row

---

### `GET /api/yield-adapter-manifest`

Yield adapter manifest for every yield-bearing asset. The route is public-read, uses the standard cache profile (`s-maxage=300`), and requires `X-API-Key` on the public API lane.

`sourceKey` is an exact runtime key only when it can join to `/api/yield-history?sourceKey=...`, rankings provenance, or decision-ledger rows. Runtime-resolved DeFiLlama variant strategies and disabled/quarantined readers return `sourceKey: null` with `sourceKeyPattern` set to the runtime pattern or would-be disabled key instead of a synthetic non-runtime value.

**Response**

```text
{
  "methodologyVersion": "v8.41",
  "updatedAt": 1779210000,
  "entries": [
    {
      "stablecoinId": "susde-ethena",
      "coinSymbol": "sUSDe",
      "family": "defillama",
      "sourceKey": "66985a81-9c51-46ca-9977-42b4fe7bc6df",
      "sourceKeyPattern": null,
      "label": "Curated DeFiLlama pool UUID",
      "chain": null,
      "project": null,
      "lifecycle": "active",
      "quarantineReason": null,
      "methodologyVersion": "v8.41",
      "updatedAt": 1779210000
    }
  ]
}
```

---

### `GET /api/yield-history`

Historical yield data for a single stablecoin. If a stored `warning_signals` payload is malformed, the API treats it as an empty array rather than failing the entire response. Generation-aware rows are returned only after their publication generation is marked `published`; legacy rows remain readable through the existing cutoff fallback. Returned rows are capped at the latest published `/api/yield-rankings` snapshot so history cannot advance past an unpublished yield cache state. If the cached rankings payload is missing or malformed, the cap degrades to the latest successful `sync-yield-data` cron timestamp instead of wall-clock `now`.

History written under methodology v8.31 or later includes the versioned PYS formula inputs captured at publication. `pysReproducibility: "exact"` means the point can be recomputed from `pysInputsAtPublish`; older rows are labeled `legacy-partial` and do not invent missing benchmark, source-risk, or scaling facts.

The newest 30 days use full hourly `yield_history` points. Days 31–365 use the last published point per stablecoin/source/UTC day from `yield_history_daily`. During backfill the handler uses raw rows for any day that does not yet have a daily materialization, so activating the tier does not create a temporary history gap.

For tracked savings-wrapper handoffs (`USDe`, `USDS`, `DAI`, `frxUSD`, `crvUSD`, `avUSD`), legacy parent-owned wrapper rows are filtered immediately at read time and are also purged by the post-V9 publisher plus the operator cleanup tool. The discontinuity is intentional: those old child-owned series no longer remain queryable through the parent id or through `mode=source&sourceKey=...`. New linked parent rows use `linked-variant:<variantId>:<sourceKey>` source keys when a tracked variant's eligible native/wrapper source is intentionally exposed on the active parent for comparison and coverage context. The same suppression and guarded purge path removes the former `protocol-api:re-protocol-reusde` rows from `reusd-re-protocol`; those rows represented a separate Re Protocol product and are replaced by reUSD's own `protocol-api:re-protocol-reusd` series.

**Cache:** slow — `X-Data-Age` and `Warning` headers included. Freshness threshold: 1800 s (30 minutes, aligned to the post-V9 `sync-yield-data` publisher).

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param       | Type      | Default | Bounds           | Description                                                                      |
| ----------- | --------- | ------- | ---------------- | -------------------------------------------------------------------------------- |
| `days`      | `integer` | `90`    | 1–365            | Lookback window in days                                                          |
| `mode`      | `string`  | `best`  | `best`, `source` | `best` for historically selected best-source rows; `source` requires `sourceKey` |
| `sourceKey` | `string`  | —       | —                | Required with `mode=source`; returns source-specific history for that source key |

**Response**

```text
{
  "current": {
    "date": 1772000000,
    "apy": 4.21,
    "sourceKey": "onchain:susde-ethena",
    "yieldSource": "Ethena staking (sUSDe)"
  },
  "history": [YieldHistoryPoint, "..."],
  "publication": {
    "generationId": "yield-1772000000",
    "updatedAt": 1772000000,
    "cutoffAt": 1772000000,
    "schemaVersion": 1,
    "status": "published"
  },
  "methodology": {
    "version": "8.37",
    "currentVersion": "8.41",
    "changelogPath": "/methodology/yield-changelog/"
  }
}
```

| Field         | Type                      | Description                                                                      |
| ------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `current`     | `YieldHistoryPoint\|null` | Latest row in the returned history window, or `null` when no history exists      |
| `history`     | `YieldHistoryPoint[]`     | History rows sorted by `date` ASC                                                |
| `methodology` | `object`                  | Yield methodology envelope for the response                                      |
| `warning`     | `string \| undefined`     | Present when freshness lookup fails and the handler falls back to cache metadata |
| `publication` | `object \| null`          | Optional published-generation metadata; omitted for legacy rankings payloads     |

**`YieldHistoryPoint`**

```json
{
  "date": 1771500000,
  "apy": 12.4,
  "apyBase": 10.2,
  "apyReward": 2.2,
  "exchangeRate": 1.052,
  "sourceTvlUsd": 5200000000,
  "warningSignals": [],
  "sourceKey": "rate-derived",
  "yieldSource": "T-bill proxy",
  "yieldSourceUrl": "https://ondo.finance/usdy",
  "yieldType": "nav-appreciation",
  "dataSource": "rate-derived",
  "isBest": true,
  "sourceSwitch": false,
  "publicationGenerationId": "yield-1771500000",
  "pysAtPublish": 42.7,
  "pysInputsAtPublish": {
    "schemaVersion": 1,
    "methodologyVersion": "8.41",
    "apy30d": 12.1,
    "safetyScore": 81,
    "varianceScore": 0.18,
    "benchmarkRate": 4.25,
    "sourceRiskPenalty": 1.15,
    "scalingFactor": 16,
    "scoreQualification": "rated",
    "benchmarkKey": "USD",
    "evidenceClass": "direct-onchain"
  },
  "pysReproducibility": "exact"
}
```

| Field                     | Type                          | Description                                                                                                                                       |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`                    | `number`                      | Unix seconds                                                                                                                                      |
| `apy`                     | `number`                      | Total APY at snapshot time (%)                                                                                                                    |
| `apyBase`                 | `number \| null`              | Base APY component (%)                                                                                                                            |
| `apyReward`               | `number \| null`              | Reward APY component (%); `null` if none                                                                                                          |
| `exchangeRate`            | `number \| null`              | Exchange rate at snapshot time (e.g. sUSDe/USDe); `null` if not applicable                                                                        |
| `sourceTvlUsd`            | `number \| null`              | TVL of the yield source pool at snapshot time (USD)                                                                                               |
| `warningSignals`          | `string[]`                    | Active warning-signal flags at that snapshot                                                                                                      |
| `sourceKey`               | `string \| null`              | Stable source identifier for this history row (for example a DL pool UUID, `onchain:<stablecoinId>`, or `linked-variant:<variantId>:<sourceKey>`) |
| `yieldSource`             | `string \| null`              | Human-readable source label at that snapshot                                                                                                      |
| `yieldSourceUrl`          | `string \| null`              | Official URL for that source when Pharos has a curated or metadata-derived link                                                                   |
| `yieldType`               | `string \| null`              | Yield type classification at that snapshot                                                                                                        |
| `dataSource`              | `string \| null`              | Underlying data-source family                                                                                                                     |
| `isBest`                  | `boolean`                     | Whether this row was the selected best source at that timestamp                                                                                   |
| `sourceSwitch`            | `boolean`                     | True when the historically selected best source changed at this row                                                                               |
| `publicationGenerationId` | `string \| null \| undefined` | Published generation identifier for generation-aware rows; `null`/omitted on legacy rows                                                          |
| `sourceRisk`              | `object \| null \| undefined` | Optional nested source-risk payload for historical rows; missing or unknown values are neutral                                                    |
| `pysAtPublish`            | `number \| null \| undefined` | PYS stored at publication time                                                                                                                    |
| `pysInputsAtPublish`      | `object \| null \| undefined` | Versioned formula and evidence inputs for exact post-v8.31 recomputation; `null` for legacy or malformed snapshots                                |
| `pysReproducibility`      | `"exact" \| "legacy-partial"` | Whether the stored point has every input required for exact recomputation                                                                         |

---

### `GET /api/mint-burn-flows`

Mint/burn flow data across tracked stablecoins — aggregate gauge score, per-coin net-flow + pressure-shift signals, and hourly timeseries. Updated every 30 minutes by the sync cron. Aggregate responses without `stablecoin` are served cache-first; the critical sync lane pre-publishes the default 24h and 168h windows after successful runs so public reads avoid rescanning hourly mint/burn aggregates.

**Cache:** standard

**Error responses:** `503` when the cached fallback payload is missing or malformed and live recomputation cannot satisfy the request. Malformed embedded freshness fields inside an otherwise valid cached payload no longer reset freshness to synthetic values; the API logs the corruption and falls back to the cache row timestamp.

**Optional query parameters**

| Param        | Type      | Default | Bounds | Description                                                               |
| ------------ | --------- | ------- | ------ | ------------------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | —      | Filter to a single stablecoin ID. Changes response shape to per-coin mode |
| `hours`      | `integer` | `24`    | 1–720  | Lookback window for the returned `hourly[]` series                        |

**Response (aggregate mode — no `stablecoin` param)**

```text
{
  "gauge": {
    "score": 2.3,
    "band": "NEUTRAL",
    "flightToQuality": false,
    "flightIntensity": 0,
    "trackedCoins": 8,
    "trackedMcapUsd": 215000000000,
    "intensitySemantics": "signed-v2",
    "classificationSource": "safety-score-v9-publication"
  },
  "coins": [CoinFlow, ...],
  "chains": [{ "chainId": "ethereum", "netFlow24hUsd": -12000000 }, ...],
  "hourly": [HourlyFlow, ...],
  "updatedAt": 1772000000,
  "windowHours": 24,
  "scope": { "chainIds": ["ethereum", "arbitrum"], "label": "Configured issuance chains" },
  "sync": { "lastSuccessfulSyncAt": 1772000200, "freshnessStatus": "fresh", "warning": null, "criticalLaneHealthy": true }
}
```

**`gauge`**

| Field                  | Type             | Description                                                                                          |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `score`                | `number \| null` | Market-cap-weighted pressure-shift composite (-100 to +100). `null` when insufficient data           |
| `band`                 | `string \| null` | Gauge band: `"CRISIS"`, `"STRESS"`, `"CAUTIOUS"`, `"NEUTRAL"`, `"HEALTHY"`, `"CONFIDENT"`, `"SURGE"` |
| `flightToQuality`      | `boolean`        | Whether flight-to-quality conditions are active                                                      |
| `flightIntensity`      | `number`         | Flight-to-quality intensity (0–100). 0 when not active                                               |
| `trackedCoins`         | `number`         | Number of stablecoins tracked for mint/burn flows                                                    |
| `trackedMcapUsd`       | `number`         | Combined market cap of tracked coins (USD)                                                           |
| `intensitySemantics`   | `string`         | Scoring semantics version identifier (currently `"signed-v2"`)                                       |
| `classificationSource` | `string` | Source of flight-to-quality classification (`"safety-score-v9-publication"` or `"unavailable"`) |

This payload is the single producer of the Bank Run Gauge. Internal consumers (daily digest) read the published `24`-hour aggregate and re-bin it rather than recomputing a composite — see [Mint/Burn Flows: Bank Run Gauge](./mint-burn-flows.md#bank-run-gauge-composite).

**Top-level metadata**

| Field         | Type     | Description                                                                                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `windowHours` | `number` | Requested chart window for `hourly[]`                                                                              |
| `chains`      | `array`  | Per-chain 24h net flow over the same tracked-pair universe as `coins`, sorted by absolute net flow (descending): `{ chainId, netFlow24hUsd }`. Fixed to the canonical 24h window even when `hours` changes. Absent from publications written before the Bank Run Gauge unification |
| `scope`       | `object` | Current ingestion scope, for example `{ chainIds: ["ethereum", "arbitrum"], label: "Configured issuance chains" }` |
| `sync`        | `object` | Latest critical-lane freshness metadata, warning state, and optional `classificationWarning`                       |

**`CoinFlow`**

| Field                 | Type                                             | Description                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stablecoinId`        | `string`                                         | Pharos stablecoin ID                                                                                                                                                                                                                                                                |
| `symbol`              | `string`                                         | Token symbol                                                                                                                                                                                                                                                                        |
| `flowIntensity`       | `number \| null`                                 | Deprecated alias for `pressureShiftScore`; retained for compatibility                                                                                                                                                                                                               |
| `pressureShiftScore`  | `number \| null`                                 | Canonical baseline-relative pressure score (-100 to +100). `null` if < 7 days of data or no current activity                                                                                                                                                                        |
| `pressureShiftState`  | `"improving" \| "stable" \| "worsening" \| "nr"` | Interpreted pressure state from `pressureShiftScore`                                                                                                                                                                                                                                |
| `netFlowDirection24h` | `"minting" \| "burning" \| "flat" \| "inactive"` | Current 24h direction derived from raw net flow + activity                                                                                                                                                                                                                          |
| `has24hActivity`      | `boolean`                                        | Whether any 24h mint/burn events were recorded for the coin                                                                                                                                                                                                                         |
| `baselineDailyNetUsd` | `number \| null`                                 | Average daily net flow over the baseline window used for scoring                                                                                                                                                                                                                    |
| `baselineDailyAbsUsd` | `number \| null`                                 | Average daily absolute flow over the baseline window used for scoring                                                                                                                                                                                                               |
| `baselineDataDays`    | `number \| null`                                 | Number of tracked days contributing to the baseline window                                                                                                                                                                                                                          |
| `netFlow24hUsd`       | `number`                                         | Raw 24h net flow (USD, positive = net minting, negative = net burning). Fixed to the canonical 24h window even when `hours` changes                                                                                                                                                 |
| `mintVolume24hUsd`    | `number`                                         | Total mint volume in the canonical 24h window (USD)                                                                                                                                                                                                                                 |
| `burnVolume24hUsd`    | `number`                                         | Total burn volume in the canonical 24h window (USD)                                                                                                                                                                                                                                 |
| `mintCount24h`        | `number`                                         | Number of mint events in the canonical 24h window                                                                                                                                                                                                                                   |
| `burnCount24h`        | `number`                                         | Number of burn events in the canonical 24h window                                                                                                                                                                                                                                   |
| `netFlow7dUsd`        | `number`                                         | 7-day net flow (USD)                                                                                                                                                                                                                                                                |
| `netFlow30dUsd`       | `number`                                         | 30-day net flow (USD)                                                                                                                                                                                                                                                               |
| `netFlow90dUsd`       | `number`                                         | 90-day net flow (USD)                                                                                                                                                                                                                                                               |
| `largestEvent24h`     | `object \| null`                                 | Largest event in the last 24h: `{ direction, amountUsd, txHash, timestamp }`                                                                                                                                                                                                        |
| `coverage`            | `object \| undefined`                            | Coverage metadata: `startBlock`, `lastSyncedBlock`, `lagBlocks`, retained-event `historyStartAt`, window booleans, adapter provenance (`adapterKinds`, `startBlockSource`, `startBlockConfidence`), and `status` (`full`, `partial-history`, `lagging`, `bootstrapping`, `unknown`, or `disabled`). Window booleans accept retained-event age or completed block-scan span, so `historyStartAt` can be recent or `null` while older scan progress proves mature coverage. |

**`HourlyFlow`**

| Field           | Type     | Description                     |
| --------------- | -------- | ------------------------------- |
| `hourTs`        | `number` | Unix seconds (start of hour)    |
| `netFlowUsd`    | `number` | Net flow for this hour (USD)    |
| `mintVolumeUsd` | `number` | Mint volume for this hour (USD) |
| `burnVolumeUsd` | `number` | Burn volume for this hour (USD) |

**Response (per-coin mode — with `stablecoin` param)**

Returns per-chain breakdown and hourly timeseries for a single coin. Returns `404` if the stablecoin is not tracked for mint/burn flows.

```text
{
  "stablecoinId": "usdt-tether",
  "symbol": "USDT",
  "mintVolumeUsd": 50000000,
  "burnVolumeUsd": 30000000,
  "netFlowUsd": 20000000,
  "mintCount": 12,
  "burnCount": 8,
  "chains": [{ "chainId": "ethereum", "mintVolumeUsd": 40000000, ... }],
  "hourly": [HourlyFlow, ...],
  "updatedAt": 1772000000,
  "windowHours": 24,
  "scope": { "chainIds": ["ethereum"], "label": "Ethereum-only" },
  "sync": { "lastSuccessfulSyncAt": 1772000200, "freshnessStatus": "fresh", "warning": null, "criticalLaneHealthy": true }
}
```

---

### `GET /api/mint-burn-events`

Paginated list of recent individual mint/burn events for a specific stablecoin. Events are sourced from on-chain logs via Alchemy JSON-RPC. Safely valued, aggregated, and Tape-projected event rows are retained for at least 8 days; protected repair or projection debt can remain longer. Missing aggregation evidence is rebuilt in bounded batches only for terminal hours without unresolved price debt, and an hourly bucket remains protected while any raw event depends on it. The 90-day aggregate flow history is served separately by `GET /api/mint-burn-flows`.

**Cache:** producer-backed

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param          | Type      | Default | Bounds                                                   | Description                                                                                                             |
| -------------- | --------- | ------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `direction`    | `string`  | —       | `"mint"` or `"burn"`                                     | Filter by direction                                                                                                     |
| `chain`        | `string`  | —       | tracked chain IDs for the requested stablecoin           | Filter by chain ID within the stablecoin's configured issuance scope                                                    |
| `burnType`     | `string`  | —       | `"effective_burn"`, `"bridge_burn"`, `"review_required"` | Filter burn rows by classification                                                                                      |
| `scope`        | `string`  | `"all"` | `"all"` or `"counted"`                                   | `counted` returns only rows used in economic-flow aggregates (`flow_type='standard'` and mint/effective-burn semantics) |
| `minAmount`    | `number`  | —       | —                                                        | Minimum USD amount; unpriced rows are excluded when this filter is used                                                 |
| `limit`        | `integer` | `50`    | 1–500                                                    | Max results                                                                                                             |
| `offset`       | `integer` | `0`     | 0–25,000                                                 | Pagination offset; cannot be combined with `cursor`                                                                     |
| `cursor`       | `string`  | —       | opaque                                                   | Keyset cursor from `nextCursor`                                                                                         |
| `includeTotal` | `boolean` | `true`  | `true` or `false`                                        | When `false`, skips the exact `COUNT(*)`; `total` becomes a page lower bound and `totalExact` is `false`                |

**Response**

```text
{
  "events": [MintBurnEvent, ...],
  "total": 1234,
  "totalExact": true,
  "nextCursor": "eyJ2IjoxLCJ2YWx1ZXMiOlsxNzcyMDAwMDAwLDE5MDAwMDAwLCJtYi0xIl19"
}
```

Results are ordered by `timestamp DESC, blockNumber DESC, id DESC`. Prefer `cursor`/`nextCursor` for deep pagination within the retained event window; offset pagination is capped for D1 safety. A previously issued cursor can eventually age beyond retention and return an empty page.

**`MintBurnEvent`**

| Field              | Type                                                             | Description                                                                                                       |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`               | `string`                                                         | Composite ID: `{chainId}-{txHash}-{logIndex}`                                                                     |
| `stablecoinId`     | `string`                                                         | Pharos stablecoin ID                                                                                              |
| `symbol`           | `string`                                                         | Token symbol                                                                                                      |
| `chainId`          | `string`                                                         | Chain identifier (e.g. `"ethereum"`)                                                                              |
| `direction`        | `"mint" \| "burn"`                                               | Whether tokens were minted or burned                                                                              |
| `flowType`         | `"standard" \| "bridge_transfer" \| "atomic_roundtrip"`          | Flow-noise classification; `bridge_transfer` and `atomic_roundtrip` rows are excluded from aggregate flow metrics |
| `amount`           | `number`                                                         | Amount in native token units                                                                                      |
| `amountUsd`        | `number \| null`                                                 | USD value at time of event                                                                                        |
| `burnType`         | `"effective_burn" \| "bridge_burn" \| "review_required" \| null` | Burn classification; `null` for mint rows                                                                         |
| `burnReviewReason` | `string \| null`                                                 | Reason emitted when a burn requires manual review classification                                                  |
| `counterparty`     | `string \| null`                                                 | Non-zero address (recipient for mint, sender for burn)                                                            |
| `txHash`           | `string`                                                         | Transaction hash                                                                                                  |
| `blockNumber`      | `number`                                                         | Block number                                                                                                      |
| `timestamp`        | `number`                                                         | Unix seconds                                                                                                      |
| `explorerTxUrl`    | `string`                                                         | Block explorer URL for the transaction                                                                            |
| `priceUsed`        | `number \| null`                                                 | Price used to derive `amountUsd`                                                                                  |
| `priceTimestamp`   | `number \| null`                                                 | Unix seconds of the price snapshot used                                                                           |
| `priceSource`      | `string \| null`                                                 | Valuation provenance (`supply_history`, `price_cache`, `price_cache_heal`, etc.)                                  |

---

### `GET /api/stress-signals`

Returns Depeg Early Warning Score (DEWS) data for active tracked stablecoins.

**All coins (no params):** Latest DEWS score + signal breakdown per coin.

**Single coin:** Add `?stablecoin=ID&days=30` for latest + daily history.

`stablecoin` must be an active tracked Pharos stablecoin ID. Unknown IDs return `404` with `{ "error": "Unknown stablecoin" }`; tracked-but-non-active IDs return `404` with `{ "error": "Stablecoin not tracked" }`.

**Cache:** standard (`public, s-maxage=300, max-age=60`). Freshness threshold: 1800 s (30 minutes, aligned to `compute-dews`).

**Query parameters**

| Param        | Type      | Default | Description                                     |
| ------------ | --------- | ------- | ----------------------------------------------- |
| `stablecoin` | `string`  | —       | Single coin mode: return latest + daily history |
| `days`       | `integer` | `30`    | History lookback (max 365)                      |

Current responses are bounded by `cache["dews:published-generation"]`. Version 2 pointers bind the exact generation timestamp, row count, and stablecoin-ID digest; readers verify those rows in the two-generation `stress_signal_publication_rows` buffer. Missing rows, same-count ID drift, and newer failed partial generations fail closed instead of being filled with older per-coin rows. Legacy or absent pointers retain the bounded compatibility path during rollout.

Aggregate responses are filtered to active tracked stablecoin IDs only, even if stale rows for non-active or de-tracked IDs still exist in storage. The aggregate response keeps `updatedAt` as the newest returned current row, and `X-Data-Age` / `Warning` freshness headers use that aggregate generation timestamp. `oldestComputedAt` remains a body-only lag diagnostic for consumers that need per-coin retained-last-valid detection.

**Response (all coins)**

```json
{
  "signals": {
    "usdt-tether": {
      "score": 5,
      "band": "CALM",
      "signals": {
        "supply": { "value": 2, "available": true },
        "price": { "value": 1, "available": true }
      },
      "amplifiers": { "psi": 1, "contagion": 1 },
      "computedAt": 1740000000,
      "methodologyVersion": "6.21"
    }
  },
  "updatedAt": 1740000000,
  "oldestComputedAt": 1740000000,
  "malformedRows": 0,
  "methodology": {
    "version": "6.21",
    "versionLabel": "v6.21",
    "currentVersion": "6.21",
    "currentVersionLabel": "v6.21",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1740000000,
    "isCurrent": true
  }
}
```

**Response (single coin)**

```json
{
  "current": {
    "score": 5,
    "band": "CALM",
    "signals": {
      "supply": { "value": 2, "available": true },
      "price": { "value": 1, "available": true }
    },
    "amplifiers": { "psi": 1, "contagion": 1 },
    "computedAt": 1740000000,
    "methodologyVersion": "6.21"
  },
  "history": [
    {
      "date": 1739900000,
      "score": 3,
      "band": "CALM",
      "signals": {
        "supply": { "value": 1, "available": true },
        "price": { "value": 1, "available": true }
      },
      "amplifiers": { "psi": 1, "contagion": 1 },
      "methodologyVersion": "6.08"
    }
  ],
  "malformedRows": 0,
  "methodology": {
    "version": "6.21",
    "versionLabel": "v6.21",
    "currentVersion": "6.21",
    "currentVersionLabel": "v6.21",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1740000000,
    "isCurrent": true
  }
}
```

**`malformedRows`** — count of DB rows with unparseable JSON signal data (expected 0 under normal operation)

**`oldestComputedAt`** — aggregate mode only; oldest returned current row, exposed as a body-only lag diagnostic

**`amplifiers`** — clamped multipliers that were applied on top of the base weighted score. `psi` is the systemic PSI amplifier (range `[1.0, 1.3]`); `contagion` is the per-peg-type cross-asset amplifier (range `[1.0, 1.2]`). Both default to `1.0` for legacy cached rows written before v5.95.

**`methodology`** — same fields and semantics as `/api/depeg-events`

---

### `POST /api/api-key-requests`

Public self-serve API key request endpoint used by `https://pharos.watch/api/`. It records the request, reserves the normalized email claim, and sends an email verification link through Resend. It does not issue a key until the email verification endpoint succeeds.

**Authentication:** exempt

**Cache:** no-store

**Default key policy after verification**

- `tier`: `"self-serve"`
- `trafficClass`: `"external"`
- `rateLimitPerMinute`: `30`
- `expiresAt`: 60 days after issuance
- one active or pending self-serve key per normalized email

**Request body**

```json
{
  "email": "dev@example.com",
  "requesterName": "Optional name",
  "organization": "Optional organization",
  "projectUrl": "https://example.com",
  "useCase": "Required, 10-1200 characters",
  "expectedCadence": "hourly",
  "expectedVolume": "Optional free-form estimate",
  "acceptedTerms": true,
  "website": ""
}
```

| Field               | Type                                                                | Required | Notes                                                                                                                           |
| ------------------- | ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `email`             | `string`                                                            | Yes      | Normalized to lowercase for the one-key-per-email claim                                                                         |
| `requesterName`     | `string`                                                            | No       | Private operator context only                                                                                                   |
| `organization`      | `string`                                                            | No       | Private operator context only                                                                                                   |
| `projectUrl`        | `string`                                                            | No       | Must start with `https://` when provided                                                                                        |
| `useCase`           | `string`                                                            | Yes      | 10-1200 characters                                                                                                              |
| `intendedEndpoints` | `string[]`                                                          | No       | **Deprecated 2026-08-10 — accepted and ignored.** It was a free-text operator note that granted and restricted nothing; nothing reads or stores it now. Kept in the schema only so pre-removal bundles do not start failing validation |
| `expectedCadence`   | `"hourly" \| "every_5_min" \| "every_1_min" \| "manual" \| "other"` | Yes      | Used for review context                                                                                                         |
| `expectedVolume`    | `string`                                                            | No       | Private operator context only                                                                                                   |
| `acceptedTerms`     | `true`                                                              | Yes      | Fair-use acknowledgement                                                                                                        |
| `website`           | `string`                                                            | No       | Honeypot field, max 300 chars; non-empty submissions are silently accepted without issuing work                                 |

**Success response:** `202 Accepted`

```json
{
  "status": "pending_verification",
  "message": "If this address can receive verification email, check your inbox to continue."
}
```

**Error responses**

- `400` invalid body, invalid email, invalid project URL, unknown/admin intended endpoint, or missing fair-use acknowledgement
- duplicate active or pending self-serve key claims receive the same `202` response shape as a new pending request and do not send a second verification link
- `413` request body above the 16 KiB defensive cap
- `429` request throttle exceeded; responses include `Retry-After`
- `503` self-serve env/email dependency unavailable (`Retry-After: 60`)

### `POST /api/api-key-requests/verify`

Public self-serve verification endpoint used by the email link. Links carry the token only in the URL fragment as raw `/api/#akv_...`, which is not sent to the server in the page request, logged by intermediaries, or leaked via Referer. The browser strips the fragment before posting and exchanges the token here. Query-string and legacy fragment-parameter verification forms are not accepted. A successful response creates the key, marks the request issued, and returns the plaintext API token exactly once.

**Authentication:** exempt

**Cache:** no-store

**Request body**

```json
{ "token": "akv_..." }
```

**Success response:** `201 Created`

```json
{
  "status": "issued",
  "key": {
    "keyPrefix": "0123456789abcdef",
    "maskedToken": "ph_live_0123456789abcdef_...",
    "tier": "self-serve",
    "trafficClass": "external",
    "rateLimitPerMinute": 30,
    "expiresAt": 1715686400
  },
  "token": "ph_live_...",
  "usage": {
    "baseUrl": "https://api.pharos.watch",
    "headerName": "X-API-Key",
    "retryGuidance": "Respect Retry-After on 429 responses and add jitter to polling intervals."
  }
}
```

**Error responses**

- `400` invalid, expired, used, or no-longer-pending verification token
- `413` request body above the 1 KiB defensive cap
- `429` verification attempt throttle exceeded or daily issuance limit for the salted IP hash reached; responses include `Retry-After`
- `503` self-serve dependency unavailable or issuance consistency compensation triggered (`Retry-After: 60`)

### `POST /api/feedback`

Public feedback ingestion endpoint used by the in-app feedback modal. Validates payloads, applies IP-based rate limiting, and forwards submissions to GitHub Issues.

**Authentication:** exempt

**Cache:** no edge cache (POST passthrough)

**Required header:** `Idempotency-Key` with 8–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Reuse the same key only for an exact retry of the same request body. Completed responses are replayed with `X-Idempotent-Replay: true`; reusing a key with a different body returns `409`.

**Rate limits**

- Feedback endpoint limiter: `3 submissions / 10 minutes` per salted IP hash in D1.
- Idempotent replays do not reserve another limiter slot. A confirmed GitHub non-2xx rejection releases the submission's one reserved slot; an ambiguous network or timeout failure keeps the slot because issue creation may have completed.
- Feedback limiter dependency failure: `503` with `Retry-After: 60` and `{ "error": "Feedback service temporarily unavailable. Please try again." }`.

**Request body**

```json
{
  "type": "bug",
  "title": "Optional short title",
  "description": "Required, 10-2000 characters",
  "expectedValue": "Optional expected behavior/value",
  "stablecoinId": "Optional canonical stablecoin id",
  "stablecoinName": "Optional stablecoin name",
  "pageUrl": "/stablecoin/usdt-tether",
  "pegValue": "Optional UI value snapshot",
  "contactHandle": "@pharos_user",
  "website": ""
}
```

| Field                                                         | Type                                              | Required    | Notes                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`                                                        | `"bug" \| "data-correction" \| "feature-request"` | Yes         | Submission category                                                                                                                        |
| `title`                                                       | `string`                                          | Conditional | Required for `bug` and `feature-request` (3–100 chars); optional for `data-correction`                                                     |
| `description`                                                 | `string`                                          | Yes         | 10–2000 chars                                                                                                                              |
| `pageUrl`                                                     | `string`                                          | Yes         | Relative app path (must be a single-slash internal path such as `/stablecoin/usdc-circle/`; protocol-relative `//...` values are rejected) |
| `website`                                                     | `string`                                          | No          | Honeypot field, max 300 chars; non-empty is silently accepted/dropped                                                                      |
| `expectedValue`, `stablecoinId`, `stablecoinName`, `pegValue` | `string`                                          | No          | Optional metadata                                                                                                                          |
| `contactHandle`                                               | `string`                                          | No          | Optional Telegram/X handle that appears publicly on GitHub                                                                                 |

**Response**

```json
{ "ok": true }
```

**Error responses**

- `400` invalid payload
- `400` missing or malformed `Idempotency-Key` for an otherwise valid submission
- `409` idempotency key currently reserved or reused with a different request payload
- `413` request body above the 16 KiB defensive cap
- `429` rate limited (3 submissions / 10 minutes per salted IP hash)
- `500` confirmed GitHub rejection/processing failure; the terminal response is idempotently replayable
- `503` ambiguous upstream execution outcome, with `X-Execution-Certainty: unknown`; retries with the same key are suppressed and replay the unknown outcome
- `503` service misconfigured (missing `FEEDBACK_IP_SALT` or `GITHUB_PAT`) or feedback limiter/storage dependency failure (`Retry-After: 60`)

---

### `POST /api/telegram-mini-app/session`

Returns the current private-chat Mini App control-panel state for a Telegram user.

**Authentication:** exempt from `X-API-Key`; requires Telegram Mini App `initData` signed with the bot token. The worker excludes Telegram's transport `hash` field from the HMAC data-check string, includes every other signed field, rejects missing/invalid hashes, and accepts sessions up to 24 hours old for read-only state loading.

**Site-data lane:** denied. The frontend calls the public API host through `src/lib/api.ts`; `/_site-data/*` never proxies this route.

**Rate limiting:** cache-backed cooldown per Telegram user (`mini-app:session`, 2 seconds). Invalid-auth requests are rejected before cooldown or analytics writes.

**Cache:** no-store.

**Request body:**

```json
{
  "initData": "query-string-from-Telegram.WebApp.initData"
}
```

The request schema is strict. Launch context such as `start_param` must come from signed Telegram `initData`. Current clients also advertise the shared contract and bundled-catalog versions through the non-identifying `mini_app_contract` and `mini_app_catalog` query parameters; older clients may omit both during the rolling-deploy compatibility window.

**Response:** matching versioned clients receive `{ contractVersion, catalogVersion, stateRevision, state }`. `state` contains the mutable Mini App projection and excludes the immutable searchable catalog, which is bundled into the fingerprinted static client asset. A legacy request with neither version parameter receives the former full state plus `catalog`; a new client can also parse that full response from an older Worker. Private fresh sessions return `state.viewer.canMutate=true`, including Telegram direct-link launches where `chat_type="sender"` identifies the user's private context. Private sessions older than the 5-minute mutation window but younger than 24 hours return state with `viewer.canMutate=false` and `viewer.mutationBlockReason="stale-auth"`. Group, supergroup, and channel launches return read-only state with `viewer.mutationBlockReason="not-private"`.

Key fields:

- `viewer` — Telegram user, optional `chatId`, chat type, `startParam`, and mutation eligibility.
- `subscriber` — global alert flags, quiet-hours settings, chat-level snooze, and `recap` state (`enabled`, `deliveryHourLocal`, `timezoneConfirmed`, `nextDueAt`, `lastWindowEndAt`, `lastDeliveredLocalDate`, and latest outcome).
- `subscriptions` — explicit per-coin follows with alert flags and per-coin thresholds.
- `presets` — followed preset watchlists.
- bundled `catalog` — recommended presets and searchable tracked stablecoins; present in the static client (and temporary legacy responses), not routine versioned API responses.
- `health` — last successful delivery/reply, recent failure class, and queued alert count.

Errors: `400` invalid request shape, `401` invalid or stale Telegram session, `409` contract/catalog version mismatch, `413` request body above the 16 KiB Mini App cap, `429` cooldown, `500` uncaught handler failure wrapper, `503` missing bot-token configuration. A version mismatch is rejected before auth cooldown or analytics writes and carries the Worker's current versions.

### `POST /api/telegram-mini-app/mutate`

Runs one private-chat Mini App operation. Read-only export/import/bulk previews return their operation result without changing preferences; writes return the refreshed mutable-state snapshot and opaque state revision. The immutable catalog is not repeated.

**Authentication:** exempt from `X-API-Key`; requires signed Telegram Mini App `initData`. Export, import-preview, and bulk-preview are read-only private-user operations and accept the 24-hour session window. Confirmations and all other writes require `initData` no older than 5 minutes. Mutations are private-user-context only (`chat_type` absent, `private`, or Telegram direct-link `sender`). The same fresh launch can perform multiple mutations inside that 5-minute window; stale write auth returns `401`.

**Site-data lane:** denied.

**Rate limiting:** read-only portability/bulk previews use the two-second session throttle and do not consume edit capacity. Writes use an anchored per-user burst budget that admits up to 12 signature-valid, schema-valid mutation attempts in 30 seconds. A denial returns the same integer delay in `Retry-After` and `retryAfterSec`; the client counts down without replaying the write while read controls remain available.

**Cache:** no-store.

**Request body:**

```json
{
  "initData": "query-string-from-Telegram.WebApp.initData",
  "operation": {
    "kind": "set-global",
    "alertType": "safety",
    "enabled": true
  }
}
```

Supported `operation.kind` values:

- `recommended-setup` — canonical first-run setup only: `presetId="usd-top25"` and `alertTypes=["dews","depeg"]`.
- `follow-preset` — follow any supported preset with selected alert types.
- `export-watchlist` — return one lossless `pw3` direct/preset token; read-only.
- `preview-watchlist-import` — decode a portable token and return exact replacement plus broadened/removed coverage; read-only.
- `confirm-watchlist-import` — revalidate generation/fingerprint and atomically replace portable direct/preset state.
- `preview-bulk-watchlist` — preview up to 20 unique direct-row adds/removals and inherited source impact; read-only.
- `confirm-bulk-watchlist` — generation/fingerprint-guarded atomic application of the previewed direct-row patch.
- `undo-bulk-watchlist` — restore the exact pre-edit direct rows/snoozes and remove added rows when post-edit state is unchanged.
- `set-global` — toggle one global alert family (`dews`, `depeg`, `safety`, `launch`, `reserve`, `freeze`).
- `set-global-depeg-step` — set or clear the global depeg severity and worsening-step threshold (`100`, `250`, `500`, or `null`).
- `set-quiet-hours` — enable or disable UTC quiet hours.
- `clear-snooze` — clear chat-level snooze.
- `set-snooze` — set chat-level snooze for `1h`, `4h`, or `24h`.
- `set-coin-snooze` — set or clear one explicit coin subscription's snooze.
- `set-timezone` — set the chat timezone used for quiet-hours display and local daily-recap scheduling.
- `set-recap` — enable or disable the private daily watchlist recap and set its local delivery hour (`deliveryHourLocal` from `0` through `23`). Enabling requires a confirmed IANA timezone and persists the preference in the recap schedule; the operation is deterministic and does not invoke an AI or external data provider.
- `unsubscribe-all` — clear all global, per-coin, and preset alert settings.
- `forget-me` — delete the private subscriber row and mutable alert settings.
- `set-coin` — add or tune one explicit coin subscription.
- `remove-coin` — remove one explicit coin subscription.
- `follow-preset` / `unfollow-preset` — add or remove a dynamic preset watchlist.

Errors: `400` invalid operation/token, unknown coin/preset, empty portable state, or empty alert type selection; `401` invalid or stale Telegram session; `403` group operation; `409` contract/catalog version mismatch or stale import/bulk preview; `413` request body above the 16 KiB Mini App cap; `429` session throttle or burst budget; `500` uncaught handler failure wrapper; `503` preset cache unavailable or missing bot-token configuration. Version mismatch occurs before rate admission, analytics, or writes. Stale preview never applies a partial patch, and the client never replays a rejected write.

### `POST /api/telegram-webhook`

Telegram Bot API webhook endpoint. Receives user messages, processes bot commands, and manages subscriptions.

**Authentication:** exempt from `X-API-Key`; requires `X-Telegram-Bot-Api-Secret-Token` for processing. Missing or invalid webhook secrets are acknowledged with `200 ok` and ignored to prevent Telegram retry storms. The webhook never uses the operator Cloudflare Access lane.

**Rate limiting:** Exempt from IP rate limiter (Telegram sends from fixed IPs).

**Cache:** no edge cache (POST passthrough)

**Request body:** Telegram Update object (JSON, sent by Telegram servers).

**Response:** Normal authenticated, unauthenticated/ignored, and command-processing paths return `200 OK` with plain-text body `ok` so Telegram does not retry routine bot decisions. Uncaught handler errors still use the standard API error wrapper and can return `500`.

**Commands handled:**

- `/start` — Welcome/setup wizard with onboarding examples plus `@pharoswatch` and `@pharoswatchers` links
- `/presets` — List the preset watchlist catalog and example commands
- `/sample` — Private preview of example alert copy and supported alert families
- `/subscribe <types> <targets>` — Subscribe to alerts for explicit coins (`dews`, `depeg`, `safety`, `launch`, `reserve`, `freeze`) or preset watchlists (`dews`, `depeg`, `safety` only)
- `/subscribe <types> all` — Enable one or more alert types across all tracked stablecoins
- `/unsubscribe <targets>` — Remove explicit coin subscriptions or the concrete coin rows covered by a preset watchlist
- `/unsubscribe all` — Remove all per-coin subscriptions, disable every current global/default alert flag including reserve and freeze, and clear the global depeg worsening step
- `/set <ticker> <setting> <value>` — Tune per-coin thresholds and modes
- `/set all <setting> <value>` — Toggle global all-stablecoin alert types
- `/settings` — Open the inline-keyboard settings menu
- `/mute <start>-<end>` — Enable quiet hours (in the subscriber's configured timezone, defaulting to UTC)
- `/unmutehours` — Disable quiet hours
- `/timezone [<IANA zone>]` — Show or set the subscriber's timezone for quiet hours; private chats without an argument offer a quick-pick keyboard, while group reads omit the keyboard and ask an admin to set a zone explicitly
- `/status <ticker>` — Read-only per-coin status summary
- `/brief` (alias: `/market`) — Market brief built from current cached datasets
- `/top <view>` — Top movers/leaders for `depeg`, `dews`, `yield`, `liquidity`, `chains`, or `safety`
- `/why <ticker>` — Explain the current Safety Score for a coin
- `/coverage <ticker>` — Per-coin coverage diagnostics for the subscriber surface
- `/health` — Chat self-diagnostics: last successful delivery/reply, queued alerts, recent failure class, quiet-hours/snooze state, and alert readiness
- `/unsnooze` — Clear an active alert snooze without waiting for it to expire
- `/cancel` — Cancel a pending disambiguation flow
- `/list` — Show current subscriptions, per-coin settings, and quiet hours
- `/forget` — Private two-step deletion flow for the subscriber row and mutable alert settings
- `/help` — Command reference

Preset watchlists are stored in `telegram_preset_subscriptions` and resolved dynamically when follow/unfollow mutations need concrete rows and when dispatch fan-out builds target alerts. `/list` displays stored preset rows directly, and `/status` is a per-coin read. Supported aliases are `usd-top10`, `usd-top25`, `usd-top50`, `non-usd-top10`, `non-usd-top25`, `non-usd-top50`, `eur-top10`, `gold-top5`, `mcap-ge-1b`, and `mcap-ge-100m`. Presets are supported for `dews`, `depeg`, and `safety`; `launch`, `reserve`, and `freeze` require explicit tickers/Pharos coin IDs or the all-stablecoin global toggle.

---

## Pages Function endpoints

These endpoints are served by Cloudflare Pages Functions from the website hosts, not by the Worker API host (`api.pharos.watch`). They are out of scope for the public `X-API-Key` regime: no API key is required and they do not appear in the OpenAPI artifact. Header behavior is function-specific; notably, the `/api/admin/*` operator proxy forwards and reflects the Worker's idempotency contract.

Each function enforces the host, origin, and Access policy appropriate to its surface. Mutating Picker, adoption, and operator-proxy requests are same-origin gated; foreign-origin requests are rejected before their action runs. These website runtime/support endpoints are documented for completeness, not as a public integration API.

Pages Function inventory:

| Surface                                                  | Function                                                         | Contract                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /_site-data/*`                                      | `functions/_site-data/[[path]].ts`                               | Same-origin browser data proxy to the Worker site-data lane.                       |
| `/api/admin/*`                                           | `functions/api/admin/[[path]].ts`                                | Same-origin operator proxy from `ops.pharos.watch` to `ops-api.pharos.watch`.      |
| `GET /admin/*`, `GET /admin-api/*`                       | `functions/admin/[[path]].ts`, `functions/admin-api/[[path]].ts` | Operator-host asset gates for Access-protected admin surfaces.                     |
| `GET /stablecoin/:legacy-id`                             | `functions/stablecoin/[[path]].ts`                               | Redirect shim for legacy numeric stablecoin URLs.                                  |
| `POST /pharoswatchbot-adoption`                          | `functions/pharoswatchbot-adoption.ts`                           | Aggregate-only same-origin PharosWatchBot CTA telemetry.                           |
| `GET /selector-snapshot/:sid`, `POST /selector-snapshot` | `functions/selector-snapshot/[[path]].ts`                        | Stablecoin Picker frozen snapshot read and canonical server-recomputation surface. |

The `/api/admin/*` proxy forwards browser `Idempotency-Key` request headers and reflects upstream `Idempotency-Key`, `X-Idempotent-Replay`, and `X-Execution-Certainty` response headers. Request bodies are capped incrementally at 128 KiB; an oversized body returns `413`. Upstream responses are fully buffered with a 16 MiB cap before being returned; an oversized or unreadable upstream response returns `502`.

### `GET /selector-snapshot/:sid`

Returns a previously stored Stablecoin Picker output JSON identified by content-addressed `sid` (32 hex chars). The returned artifact is frozen; clients that offer "Compare to today's data" must compute a separate live Picker run and keep the stored artifact unchanged.

**Authentication:** exempt — same-origin gated via `Origin` / `Referer` allowlist.

**Path parameter:** `sid` — 32 lowercase hex chars, content-addressed SHA-256 truncation. The server recomputes the identifier from the canonicalized selector output before storing or reading a snapshot. Schema-v3 verification fields contribute to the sid; verified artifacts therefore cannot collide with their legacy-unverified projection.

**Response (200):**

```json
{
  "profile": "treasury",
  "provenance": "pharos-verified",
  "snapshotSchemaVersion": 3,
  "engineVersion": "selector-v2.1",
  "datasetHash": "<64-character canonical dataset hash>",
  "verification": {
    "kind": "pharos-server-recomputed-v1",
    "datasetHash": "<same 64-character canonical dataset hash>",
    "engineVersion": "selector-v2.1"
  },
  "timestamp": 1715000000000,
  "input": {
    "profile": "treasury",
    "pegCurrency": "EUR",
    "horizon": "6mplus",
    "depegTolerance": "zero",
    "composability": "none",
    "venuePreferences": ["custody"],
    "exitSpeed": "any",
    "minApy": null,
    "yieldNativeOnly": false,
    "decentralization": "any",
    "custodyOk": "any"
  },
  "universe": { "active": 392, "surviving": 12 },
  "recommended": [/* ranked shortlist entries */],
  "lowerRanked": [/* lower-ranked entries */],
  "usedRelaxedFallback": false,
  "relaxedReasons": [],
  "coverageWarnings": {
    "skippedForCoverageCount": 0,
    "sparse": false,
    "uneven": false,
    "skippedForCoverage": [],
    "newListingCount": 0,
    "redistributionCount": 0
  },
  "exclusionSummary": [],
  "closestSurvivors": [],
  "relaxableConstraints": [],
  "lowConfidence": false,
  "methodologyVersions": { "safetyScore": "v7.25" }
}
```

The full `SelectorOutput` shape is owned by `shared/lib/selector/types.ts`. Selector creation recomputes against the live V9 publication (`functions/lib/selector-canonical-snapshot.ts`); a `503` now indicates canonical-source or schema failure, not a policy hold. Existing signed selector snapshots remain readable through their historical contract; the service does not silently run the retired V8 adapter.

New values carry both `provenance: "pharos-verified"` / `snapshotSchemaVersion: 3` in the body and `pharos-server-recomputed-v1` trust metadata in KV. GET trusts only the KV metadata, validates the exact body binding, recomputes the canonical sid, and returns `502` on mismatch or tampering. A body that merely self-claims verified provenance without trusted KV metadata is normalized to the historical `client-unverified` schema-v2 projection and must use the unverified UI banner. The first read returns `200` only after the five-year retention extension succeeds; extension failure returns `503`.

**Cache:** `private, no-store` — reads are same-origin gated with `Origin` / `Referer`, so stored snapshots are intentionally not served from a public shared cache.

**Failure modes:**

| Status | When                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 404    | Origin disallowed, sid not 32 hex chars, or KV miss.                                     |
| 500    | `SELECTOR_SNAPSHOTS` KV binding missing on the Pages project.                            |
| 502    | Stored KV value is corrupt, fails semantic validation, or recomputes to a different sid. |
| 503    | KV read throws transiently, or the first-read retention extension cannot be confirmed.   |

### `POST /pharoswatchbot-adoption`

Same-origin Pages Function used by allowlisted `/pharoswatchbot/` CTA links. It accepts a strict JSON body containing `campaign="landing"` and one canonical placement (`hero`, `setup`, `miniapp_setup`, `miniapp_home`, or `miniapp_watchlist`). The request body is capped at 512 bytes and must carry a permitted Pharos Pages `Origin` or `Referer`.

The function writes one aggregate `cta_click` count through the Pages project's primary `DB` D1 binding. It stores no raw IP address, User-Agent, referrer, cookie, request ID, chat ID, or user ID. A dedicated-pepper HMAC of `CF-Connecting-IP` is used only in the minute-quota table, where a per-client quota admits at most 10 requests per minute before the identifier-free global quota admits at most 3,000 requests per UTC minute; exhausted quota returns `429` with `Retry-After: 60`. Success returns `204 No Content`. Invalid method/origin/schema, missing binding, and D1 failures return `405`, `404`, `400`, `503`, and `500` respectively. Telemetry is best-effort and never blocks the link navigation.

### `POST /selector-snapshot`

Recomputes a Stablecoin Picker output from canonical source data and stores it under a server-computed `sid`. Idempotent while canonical content and methodology are unchanged: re-POSTing the same input against the same canonical dataset returns the same `sid`. Documented here for completeness; external integrations should not call this endpoint (it is bound to the Picker wizard at `https://pharos.watch/screener/picker/`).

**Authentication:** exempt — same-origin gated.

**Body:** `application/json`, `{ "input": <SelectorInput> }` (a bare `SelectorInput` is also accepted for compatibility). Max 100 KB defensive cap, enforced incrementally even when `Content-Length` is absent or false. Input is projected onto an exact allowlist. A legacy client may still send a complete `SelectorOutput`, but every field outside its nested `input` is ignored.

**Response (200):** `{ "sid": "<32 hex chars>", "ev": "pharos-server-recomputed-v1" }`. The sid is SHA-256 over canonicalized server output with debug/provenance/freshness-derived fields stripped (`timestamp`, `debug`, `provenance`, `snapshotSchemaVersion`, `perInputStaleness`, plus fields matching the suffixes `ageSeconds` / `capturedAt` / `stalenessMs` / `updatedAt` / `fetchedAt`), with keys lexicographically sorted at every depth. The schema-v3 `verification` binding is retained, so it commits the sid to the canonical dataset hash and engine version. `coverageWarnings.newListingCount` is retained because the engine derives it from content-level recent-listing flags.

Share-link privacy property: the KV payload contains Picker answers and server-recomputed output rows, not IP addresses, browser fingerprints, wallet addresses, or account identifiers. Rate limits use a separate D1 daily quota keyed by a dedicated-pepper HMAC of `CF-Connecting-IP`; raw and unsalted IP hashes are never stored. The website UI must disclose that anyone with the link can view the artifact. Unread KV entries expire after 90 days; the first read succeeds only when the full five-year extension is confirmed.

**Validation matrix:**

| Case                                                                   | Status / client contract                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Invalid `sid` path syntax                                              | `404`; clients should surface invalid-link/not-found state without replaying unrelated live output. |
| Missing required input answer or unknown input enum                    | `400` on POST.                                                                                      |
| Caller supplies a forged identity, score, rank, or 64-hex dataset hash | Ignored; the server projects input and recomputes all output from canonical sources.                |
| Any canonical source is non-2xx, invalid JSON, or schema-invalid       | `503`; KV is not written.                                                                           |
| Stored trusted payload canonical sid differs from requested `sid`      | `502`.                                                                                              |
| Stored body claims verified provenance without trusted KV metadata     | Returned only as normalized `client-unverified` schema v2.                                          |
| Clipboard denied after a successful POST                               | Endpoint still returns `200`; UI shows a selectable URL fallback.                                   |
| Trading profile has stale share-blocking inputs                        | UI should not POST until refreshed; the server still recomputes against its current canonical data. |

**Failure modes:**

| Status | When                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Body parse error, unsupported JSON, missing required selector input, unknown input enum, or structurally unsafe input.             |
| 404    | Origin disallowed.                                                                                                                 |
| 405    | Method on the wrong path — POST is accepted only at `/selector-snapshot` without a path segment.                                   |
| 429    | Best-effort isolate-local write throttle exceeded (10 writes/minute/IP) or durable daily write quota exceeded (100 writes/day/IP). |
| 413    | Payload exceeds 100 KB defensive cap.                                                                                              |
| 500    | `SELECTOR_SNAPSHOTS` or `SELECTOR_SNAPSHOT_IP_HASH_SECRET` binding missing.                                                        |
| 503    | Canonical source/configuration/contract failure, KV write failure, or missing/unavailable D1-backed daily quota store.             |

---

## Admin Endpoints

Preferred operator access now splits by surface:

- Browser / human operators: use `https://ops.pharos.watch/admin/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access.
- CLI / automation: call `https://ops-api.pharos.watch/api/...` with `CF-Access-Client-Id` and `CF-Access-Client-Secret` so Cloudflare Access can mint the request JWT the worker verifies. Direct `ops-api` requests also work with Cloudflare Access user/JWT headers.

Endpoint sections below do not repeat the CLI header pair. Unless an endpoint says otherwise, direct operator examples assume the `ops-api` host plus those two Cloudflare Access service-token headers.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, data quality metrics, Telegram bot subscriber stats, and operator reconciliation signals.

**Preferred access:**

- Browser: `https://ops.pharos.watch/admin/` -> same-origin `/api/admin/status`
- CLI: `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` against `https://ops-api.pharos.watch/api/status`

**Response shape:** `StatusResponse` (exported through `shared/types/index.ts`). The JSON below is illustrative rather than exhaustive; the canonical field list lives in `shared/types/status/response.ts`, with `shared/types/status.ts` retained as its compatibility barrel. It currently includes diagnostics such as `summary.transitionsLast24h`, `priceProviderDiagnostics`, `gtProbe`, `cacheBlobSizes`, `yieldHealth`, `publicationHealth`, `providerCircuitHealth`, `canaries`, `dependencyHealth`, `reserveDrift`, `classificationWarnings`, and `reserveComposition.persistentlyStaleIndependentCoins`.

```text
{
  "timestamp": 1771856453,
  "dbHealthy": true,
  "availabilityStatus": "healthy",
  "dataQualityStatus": "healthy",
  "rawOverallStatus": "healthy",
  "overallStatus": "healthy",
  "confidence": 0.94,
  "causes": {
    "availability": [{ "code": "watch_unhealthy_crons_present", "severity": "info" }],
    "dataQuality": [],
    "overall": [{ "code": "watch_unhealthy_crons_present", "severity": "info" }]
  },
  "state": {
    "currentStatus": "healthy",
    "rawStatus": "healthy",
    "lastEvaluatedAt": 1771856453,
    "lastChangedAt": 1771856200,
    "consecutiveRaw": { "healthy": 3, "degraded": 0, "stale": 0 }
  },
  "staleness": { "ageSeconds": 0, "maxAgeSec": 1800, "isStale": false },
  "probe": {
    "timestamp": 1771856440,
    "status": "healthy",
    "sampleCount": 22,
    "passCount": 22,
    "failCount": 0,
    "p95LatencyMs": 301,
    "internal": {
      "status": "healthy",
      "sampleCount": 19,
      "passCount": 19,
      "failCount": 0,
      "p95LatencyMs": 92,
      "origins": ["https://api.pharos.watch"]
    },
    "external": {
      "status": "healthy",
      "sampleCount": 3,
      "passCount": 3,
      "failCount": 0,
      "p95LatencyMs": 301,
      "origins": [
        "https://api.pharos.watch",
        "https://site-api.pharos.watch",
        "https://ops-api.pharos.watch"
      ]
    },
    "internalExternalDiscrepancy": {
      "hasDivergence": false,
      "severityDelta": 0,
      "internalStatus": "healthy",
      "externalStatus": "healthy",
      "reason": "in-sync",
      "details": null
    }
  },
  "discrepancy": {
    "hasDivergence": false,
    "severityDelta": 0,
    "consecutiveDivergent": 0
  },
  "timeline": [
    {
      "id": 411,
      "from": "degraded",
      "to": "healthy",
      "rawStatus": "healthy",
      "transitionType": "recover",
      "reason": "raw-healthy-recovery-threshold",
      "confidence": 0.94,
      "at": 1771856200
    }
  ],
  "caches": { ... },
  "crons": {
    "sync-stablecoins": {
      "lastRun": { "startedAt": 1234567890, "durationMs": 2300, "status": "ok", "itemCount": 156 },
      "inFlight": null,
      "recentRuns": [...],
      "expectedIntervalSec": 900,
      "healthy": true
    }
  },
  "dataQuality": {
    "totalStablecoins": 156,
    "missingPrices": 3,
    "blacklistMissingAmounts": 0,
    "blacklistRecentMissingAmounts": 0,
    "blacklistRecentWindowSec": 86400,
    "blacklistMissingRatio": 0,
    "blacklistTotal": 13422,
    "blacklistOldestRecoverableAgeSec": 0,
    "blacklistNeverAttemptedCount": 0,
    "blacklistRepeatedFailureCount": 0,
    "onchainSupplyDivergences": 0,
    "onchainDivergenceRatio": 0,
    "onchainSupplyMonitoring": "active",
    "onchainSupplyLatestAt": 1771856300,
    "onchainSupplyTrackedCoins": 96,
    "activeDepegs": 12,
    "staleOnchainSupply": 0,
    "onchainStaleRatio": 0
  },
  "sectionErrors": {},
  "canaries": {
    "checkedAt": 1771856453,
    "status": "healthy",
    "latestRunAt": 1771856400,
    "maxAgeSec": 7200,
    "totalChecks": 6,
    "okCount": 6,
    "degradedCount": 0,
    "errorCount": 0,
    "skippedCount": 0,
    "staleCount": 0,
    "checks": {
      "dex-liquidity-current-publication": {
        "checkId": "dex-liquidity-current-publication",
        "label": "DEX liquidity current publication",
        "description": "Current DEX rows are published and match the latest published generation row count.",
        "status": "ok",
        "severity": "info",
        "observedAt": 1771856400,
        "durationMs": 12
      }
    }
  },
  "telegramBot": {
    "totalChats": 128,
    "alertEnabledChats": 123,
    "deliverableChats": 121,
    "subscribedChats": 124,
    "emptyAlertChats": 2,
    "mutedChatsWithSubscriptions": 3,
    "totalSubscriptions": 611,
    "explicitCoinSubscriptions": 560,
    "presetImpliedCoinSubscriptions": 51,
    "activePresetFollowers": 8,
    "avgSubscriptionsPerSubscribedChat": 4.9,
    "pendingDisambiguations": 1,
    "pendingDeliveries": 5,
    "oldestPendingDeliveryAgeSec": 240,
    "pendingDeliveryBacklog": {
      "claimable": 4,
      "due": 4,
      "deferred": 1,
      "sending": 0,
      "executionUnknown": 0,
      "sentCleanup": 0,
      "expired": 1
    },
    "retryErrorClassCounts": { "rate_limit": 2, "server_error": 1 },
    "lastSubscriberActivityAt": 1771856420,
    "customPreferenceChats": 47,
    "quietHoursEnabledChats": 18,
    "alertTypeChats": {
      "dews": 121,
      "depeg": 118,
      "launch": 97,
      "safety": 102,
      "allTypes": 95
    },
    "topStablecoins": [
      { "stablecoinId": "usdc-circle", "symbol": "USDC", "subscribers": 82, "explicitSubscribers": 72, "presetImpliedSubscribers": 10 },
      { "stablecoinId": "usdt-tether", "symbol": "USDT", "subscribers": 77, "explicitSubscribers": 70, "presetImpliedSubscribers": 7 }
    ],
    "lifecycleSnapshot": {
      "date": "2026-05-13",
      "snapshotAt": 1778674145,
      "activeWatchers": 121,
      "newWatchers": 2,
      "churnedWatchers": 1,
      "reactivatedWatchers": 0,
      "explicitCoinFollows": 560,
      "presetImpliedCoinFollows": 51,
      "activePresetFollowers": 8,
      "alertTypeOptIns": {
        "dews": 121,
        "depeg": 118,
        "launch": 97,
        "safety": 102,
        "allTypes": 95
      },
      "quietHoursEnabledChats": 18,
      "pendingDeliveries": 6
    }
  },
  "datasetFreshness": {
    "stablecoins": 1771856400,
    "blacklist": 1771856200,
    "mintBurn": 1771856340,
    "supply": 1771804800,
    "safetyGrades": 1771804800,
    "yield": 1771856320,
    "depegs": 1771856010,
    "dews": 1771856400,
    "digest": 1771804800
  },
  "summary": {
    "unhealthyCrons": 1,
    "availabilityImpactingUnhealthyCrons": 0,
    "watchUnhealthyCrons": 1,
    "degradedCrons": 1,
    "cronErrors": 0,
    "availabilityImpactingCronErrors": 0,
    "availabilityImpactingConsecutiveCronErrors": 0,
    "diagnosticIssueCount": 0,
    "worstCacheRatio": 1.03
  },
  "reserveComposition": {
    "configuredCoins": 18,
    "freshCoins": 16,
    "staleCoins": 1,
    "missingCoins": 0,
    "degradedCoins": 1,
    "errorCoins": 0,
    "corruptCoins": 0,
    "independentFreshEligible": 9,
    "independentFreshUnverified": 2,
    "staticValidatedFresh": 4,
    "weakProbeFresh": 1,
    "writeTimeoutUncertain": 0,
    "deferredCoins": 0,
    "runBudgetTruncated": false,
    "deferredAt": null,
    "nextCursorStablecoinId": null,
    "persistentlyStaleIndependentCoins": [],
    "lastSuccessAt": 1771855800,
    "oldestFreshAgeSec": 3100,
    "status": "healthy",
    "freshCoverageRatio": 0.89,
    "authoritativeFreshCoverageRatio": 0.83
  },
  "priceSourceHealth": {
    "sourceDistribution": {
      "coingecko": 14,
      "coingecko+defillama-list": 118,
      "defillama": 10,
      "defillama-list": 0,
      "protocol-redeem": 1,
      "defillama-contract": 4,
      "coinmarketcap": 2,
      "dexscreener": 1,
      "geckoterminal": 0,
      "cached": 4,
      "missing": 3
    },
    "sourceDepthDistribution": {
      "0": 3,
      "1": 15,
      "2": 52,
      "3": 64,
      "4": 18,
      "5+": 4
    },
    "confidenceDistribution": {
      "high": 127,
      "single-source": 15,
      "low": 8,
      "fallback": 6
    },
    "totalAssets": 156,
    "lastSync": 1771856400
  },
  "coingeckoPriceDiff": {
    "checkedAt": 1771856453,
    "trackedWithGeckoId": 152,
    "comparedCoins": 149,
    "mismatchedCount": 2,
    "thresholdPct": 5,
    "rows": [
      {
        "stablecoinId": "pyusd-paypal",
        "symbol": "PYUSD",
        "name": "PayPal USD",
        "geckoId": "paypal-usd",
        "ourPrice": 0.944,
        "coinGeckoPrice": 1.002,
        "diffPct": 5.79,
        "priceSource": "defillama",
        "priceConfidence": "single-source"
      }
    ]
  },
  "d1Usage": {
    "checkedAt": 1771856453,
    "windowStart": 1771770053,
    "windowEnd": 1771856453,
    "databaseId": "8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a",
    "databaseName": "stablecoin-db",
    "databaseSizeBytes": 1589248000,
    "numTables": 56,
    "region": "EEUR",
    "readReplicationMode": "disabled",
    "readQueries24h": 942012,
    "writeQueries24h": 709241,
    "rowsRead24h": 1633139670,
    "rowsWritten24h": 1555568,
    "capacity": {
      "observedAt": 1771856400,
      "databaseSizeBytes": 1589248000,
      "maximumSizeBytes": 10000000000,
      "utilizationRatio": 0.158925,
      "utilizationPercent": 15.89,
      "thresholdState": "normal",
      "crossedThresholdPercent": null,
      "nextThresholdPercent": 60,
      "sampleCount": 72,
      "forecastBasis": "linear-30d",
      "forecastSpanHours": 71,
      "growthBytesPerDay": 12000000,
      "nextThresholdAt": 1803605467,
      "exhaustionAt": 1832405467,
      "daysUntilExhaustion": 700.9
    }
  },
  "liquidityHealth": {
    "lastRunStatus": "degraded",
    "currentCoverage": 120,
    "previousCoverage": 125,
    "currentGlobalTvl": 123000000,
    "previousGlobalTvl": 125000000,
    "currentTop10CoveredTvl": 100000000,
    "previousTop10CoveredTvl": 102000000,
    "failedSources": ["defillama-yields"],
    "nearCoverageGuard": false,
    "nearValueGuard": false,
    "nearMajorCoverageGuard": false,
    "currentCoverageClasses": { "primary": 80, "mixed": 20, "fallback": 20, "legacy": 0, "unobserved": 36 },
    "previousCoverageClasses": { "primary": 82, "mixed": 18, "fallback": 25, "legacy": 0, "unobserved": 31 }
  },
  "yieldHealth": {
    "status": "healthy",
    "statusImpact": "admin-watch",
    "runbookUrl": "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/yield-health.md",
    "rankingCount": 129,
    "rankingUpdatedAt": 1771856320,
    "rankingAgeSec": 133,
    "rankingMaxAgeSec": 3600,
    "rankingStatus": "healthy",
    "safetyCoverage": {
      "coveredCount": 109,
      "trackedCount": 129,
      "coverageRatio": 0.845,
      "threshold": 0.75,
      "status": "healthy",
      "reason": null
    },
    "supplemental": {
      "updatedAt": 1771849200,
      "ageSec": 7253,
      "maxAgeSec": 21600,
      "status": "healthy"
    },
    "benchmark": {
      "fetchedAt": 1771849000,
      "ageSec": 7453,
      "maxAgeSec": 172800,
      "source": "risk_free_rates",
      "isFallback": false,
      "fallbackMode": null,
      "status": "healthy"
    },
    "coverageAudit": {
      "updatedAt": 1769810400,
      "ageSec": 2046053,
      "maxAgeSec": 3888000,
      "status": "healthy"
    },
    "sourceRiskCoverage": {
      "totalRows": 180,
      "bestRows": 129,
      "altRows": 51,
      "rowsWithSourceRisk": 180,
      "fields": {
        "sourceRiskPenalty": {
          "eligibleCount": 180,
          "populatedCount": 180,
          "nullCount": 0,
          "coverageRatio": 1,
          "nullRate": 0
        },
        "sourceRiskScore": {
          "eligibleCount": 180,
          "populatedCount": 0,
          "nullCount": 180,
          "coverageRatio": 0,
          "nullRate": 1
        }
      }
    },
    "latestCronStatus": "ok",
    "latestCronStartedAt": 1771856300
  },
  "mintBurnReconciliation": {
    "checkedAt": 1771856453,
    "comparedCoins": 42,
    "criticalCount": 1,
    "warnCount": 3,
    "insufficientCount": 12,
    "rows": [
      {
        "stablecoinId": "usdt-tether",
        "symbol": "USDT",
        "flowNet24hUsd": -240000000,
        "chainSupplyDelta24hUsd": -220000000,
        "absoluteDiffUsd": 20000000,
        "diffRatio": 0.08,
        "status": "warn",
        "coverageStatus": "full"
      }
    ]
  }
}
```

`dataQuality.onchainSupplyTrackedCoins` counts only coins with at least one `onchain_supply` row inside the current 3-day active monitoring window. Older historical rows are excluded from `staleOnchainSupply` and `onchainStaleRatio`.

Ratio-based on-chain status thresholds apply only when `dataQuality.onchainSupplyTrackedCoins >= 10`; below that floor, the counts remain visible but do not by themselves escalate `dataQualityStatus`.

`itemCount` and `dataQuality.totalStablecoins` are illustrative example values. In the live handler they reflect the current cached stablecoin payload size, not `TRACKED_STABLECOINS.length`.

`summary.availabilityImpactingUnhealthyCrons` and `summary.availabilityImpactingCronErrors` count only cron jobs tagged `statusImpact="critical"` in `shared/lib/cron-jobs.ts`. `summary.watchUnhealthyCrons` counts the watch-tier jobs that remain visible but do not degrade `availabilityStatus` on their own.

`summary.availabilityImpactingConsecutiveCronErrors` is the subset of `availabilityImpactingCronErrors` whose most recent 2+ runs are **all** `error`. A single transient critical-cron error increments `availabilityImpactingCronErrors` (and sets `availabilityStatus` to `degraded`), but only a `≥2`-consecutive streak increments `availabilityImpactingConsecutiveCronErrors` and escalates `availabilityStatus` to `stale`. This transient-vs-sustained split prevents rare upstream flakes (e.g. DefiLlama returning a truncated response body) from flipping public state on a single bad sample.

`summary.diagnosticIssueCount` counts best-effort status loader failures such as cache freshness lookups, reserve overview diagnostics, mint/burn diagnostics, and non-stablecoins data-quality subqueries. These issues reduce confidence and appear as info causes, but they do not degrade `availabilityStatus` or `dataQualityStatus` on their own unless all freshness evidence for the affected lane is gone.

`reserveComposition.status` is a derived health signal for live reserve coverage. After bootstrap, it becomes `stale` when `freshCoins === 0`, `degraded` when `freshCoverageRatio < 0.75`, `authoritativeFreshCoverageRatio < 0.5`, or `persistentlyStaleIndependentCoins.length > 0`, and `healthy` otherwise.

`reserveComposition.freshCoverageRatio` is `freshCoins / configuredCoins`. `reserveComposition.authoritativeFreshCoverageRatio` counts only stronger evidence cohorts (`independentFreshEligible`, `independentFreshUnverified`, `staticValidatedFresh`) over `configuredCoins`.

`reserveComposition.runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` expose the latest live-reserve deferred-tail cursor when the internal sync budget stopped the run before the queue tail. `persistentlyStaleIndependentCoins` lists independent feeds whose latest source has been failing beyond the persistent-stale window. `writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path and could not be proven authoritative by readback.

`crons[*].healthy` reflects availability impact. Fresh cron runs with `status="degraded"` are warning-only and counted in `summary.degradedCrons`, but they do not mark availability unhealthy on their own.

`availabilityStatus` also inherits the shared public-health floor used by `/api/health`: cache-impact status, the critical mint/burn lane's public warning/staleness contract, and 3+ public-impact open circuit groups can degrade availability even when cron freshness alone is still green. Dynamic per-coin `live-reserves:*` breakers remain visible in `circuits`, but they do not change `availabilityStatus` on their own.

`alertBroker` is a retained compatibility block. The direct-alert runtime reports zero active/pending/critical conditions, zero failed/missing-target deliveries, no oldest timestamp or active keys, and `queryFailed=false`; historical broker tables are not queried.

`producerHeads` contains every canonical schedule/job/path/kind identity, including shared producer paths and budget-only surfaces. `observed=false` explicitly represents an identity that has not run since the history schema deployed. Observed rows separate `lastInvokedAt`/`lastCompletedAt` from `lastProductiveAt` and `lastPublicationAt`, and include invocation ID, Worker version, outcome/error, and invocation/productive counters.

`crons[*].inFlight` is present when a leased cron is actively reporting `cron_run_progress` and the matching `cron_leases` row is still active for the same owner. It includes `startedAt`, `updatedAt`, `stage`, optional `itemsDone/itemsTotal`, optional `message/metadata`, and a `stale` flag when the heartbeat stops updating. High-SLO jobs such as DEX liquidity, yield publication/supplemental sync, digest generation, and Telegram dispatch include stage metadata with `providerFamily`, `phase`, `countTotals`, and, where relevant, `cursor` / `deferredTail` summaries; `/api/status` reads those summaries from `cron_run_progress` and does not add producer-table scans for them.

`overallStatus` is the effective (hysteresis-smoothed) status. `rawOverallStatus` is the immediate worst-of availability/data-quality signal.

`dbHealthy=false` means the DB sentinel failed (`SELECT 1`), so status is forced to at least degraded and data-quality/database freshness queries are skipped.

`telegramBot` is `null` when the Telegram tables are unavailable in the current environment (for example, migrations not yet applied in dev/staging). The rest of `/api/status` still resolves normally.

`telegramBot.deliverySli` is the bounded operational delivery read model from Telegram source-event and authoritative target ledgers. Its envelope is always fail-visible:

- `availability` is `available` only when the complete SLI query succeeds; otherwise it is `unavailable`.
- `quality` is `complete`, `partial`, or `empty` for an available rollup, and `unavailable` on query failure.
- `freshness` is `fresh`, `stale`, or `empty` for an available rollup, and `unknown` on query failure.
- `acceptanceDefinition` is the literal `telegram_bot_api_accepted_not_user_receipt`. Fields such as `planToTelegramAcceptance`, `telegramAccepted`, and `telegramAcceptanceRate` mean Telegram's Bot API accepted a send request. They are not evidence that an end user received, opened, or read the message.
- `rollup` contains the bounded window, evidence age, detection-to-plan and plan-to-acceptance latency, acceptance-before-TTL coverage, authoritative outcomes, preference-change cancellations, unresolved backlog buckets, observed errors, execution-unknown outcomes, and dead letters. It is `null` on query failure; failure never becomes an all-zero or healthy rollup.

`sectionErrors` is a machine-readable map of subsection loader failures. When an individual status subsection fails (for example Telegram stats, discovery backlog, CoinGecko price drift, D1 usage telemetry, liquidity health, reserve drift, or mint/burn reconciliation), `/api/status` still returns `200`, keeps the unaffected sections intact, and records the degraded subsection under `sectionErrors` with a stable `code` plus an operator-facing sanitized `message`. Raw exception text, SQL fragments, and table names stay in logs, not in the response body.

`crons["dispatch-telegram-alerts"].lastRun.metadata` now carries a richer delivery breakdown, including fields such as `freshAttempted`, `freshSent`, `freshRetryQueued`, `freshPermanentFailures`, `pendingAttempted`, `pendingDrained`, `pendingRetryQueued`, `pendingDeferred`, `pendingRateLimited`, `pendingRetryAfterSec`, `pendingDropped`, `pendingEnqueued`, and expanded `eventsDetected` counters (`depegTriggered`, `depegResolved`, `depegWorsening`, `launch`, `suppressedMethodologyChanges`).

Source-event runs also include `authoritativePlanning`. It identifies `sourceEventId` and `sourceEventFamilies`; splits source-preset resolution, candidate-horizon, fan-out input loaders, preference-generation validation, routing, target materialization, duplicate suppression, queue handoff, and pending-drain duration; and reports capture/planning/handoff pages, fan-out load/cache counts, captured/planned/duplicate-suppressed/enqueued targets, and coordinator steps. Eventless runs return the same object with a null source ID and zero counts/timings so status consumers do not need a second shape.

The same cron metadata also exposes the live safety-alert source contract:

- `safetyAlertSourceState`
- `safetyAlertSourceAgeSeconds`
- `safetyAlertsSuppressed`
- `safetyAlertSourceGeneration`

When `safetyAlertsSuppressed=true`, DEWS/depeg/launch alerts can still continue, but safety-grade alerts remain paused until `compute-safety-score-v9` accepts a fresh canonical publication and the Telegram lane reseeds its prior snapshot.

`crons["status-self-check"].lastRun.metadata` now also includes `freshnessDiagnostics` when raw status had to fall back from a freshness sentinel to table or cron evidence during the self-check run, plus `d1CapacityMonitoring` when the dedicated Cloudflare D1 status bindings are configured.

`probe.internal`, `probe.external`, and `probe.internalExternalDiscrepancy` are optional because legacy `status_probe_runs` rows did not persist split-plane details. New rows compare router-dispatched internal self-checks against explicit production-domain HTTP canaries for public API, site API, and ops API routes. Probe-failure and status-divergence alerts include that internal/external comparison.

`datasetFreshness` covers the key operator-visible datasets written by the pipeline: cache-backed stablecoins, blacklist, mint/burn, supply snapshots, safety-grade history, yield, depeg/dews tables, daily digest, and discovery backlog timestamps.

`dataQuality.repairDebt` summarizes low-priority repair/backfill backlog separately from foreground publication health. It reports `status`, `openCount`, `oldestAgeSec`, `byKind`, `availabilityEscalated`, `nextRunnerDueAt`, and `source`. The current source prefers `worker_repair_tasks`; during DDR rollout, it falls back to the existing `cache["ddr:repair-debt:v1"]` marker if the task table is unavailable or not yet populated. The legacy DDR-specific `ddrRepairDebt*` fields remain populated for compatibility and continue to drive the `ddr_repair_debt_present` data-quality warning.

`priceSourceHealth` is derived from the final `sync-stablecoins` asset payload and summarizes resolved price-source distribution, active canonical source-depth buckets (`sourceDepthDistribution`, keyed by `consensusSources.length` buckets `0`, `1`, `2`, `3`, `4`, `5+`), confidence buckets, total assets, and the timestamp of the latest successful price-health snapshot. CoinGecko-vs-Pharos divergence details live in the separate `coingeckoPriceDiff` block.

`coingeckoPriceDiff` is an admin-only live comparison block. It reads the cached tracked assets with `geckoId`, fetches current CoinGecko spot prices and their upstream timestamps through one or more batched `simple/price` calls, and compares only quotes accepted by the shared CoinGecko freshness validator. Missing, invalid, stale, or materially future timestamps are excluded before reporting rows where `abs(pharosPrice - coinGeckoPrice) / coinGeckoPrice > 0.05`. The field is `null` when the comparison is unavailable in the current environment or when the loader fails; failures are surfaced through `sectionErrors.coingeckoPriceDiff`.

`d1Usage` is an admin-only live D1 telemetry block. It uses Cloudflare's D1 database info endpoint plus a trailing-24h `d1AnalyticsAdaptiveGroups` GraphQL query to surface current storage size, table count, replication mode, and recent query/row volume. Its additive `capacity` member carries the latest hourly 60/75/90% threshold classification plus 24h, 72h, 7d, and 30d linear regressions (`growthWindows`, with sample count/span). `conservativeWindow` identifies the shortest valid regression used for runway. The scheduled status lane records the same bounded capacity assessment, but exact D1 capacity telemetry is not exposed by the no-key public health endpoint. The field is `null` until `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_STATUS_API_TOKEN`, and `CLOUDFLARE_D1_DATABASE_ID` are configured on the worker; loader/config failures are surfaced through `sectionErrors.d1Usage`.

`liquidityHealth` is derived from the latest `sync-dex-liquidity` cron metadata and summarizes row coverage, value coverage, major-asset coverage, failed sources, and current/previous coverage-class distribution for the operator dashboard.

`yieldHealth` is derived only from existing yield cache rows and cron metadata: `yield-rankings`, aggregate `yield:supplemental-sources:v1`, per-family `yield:supplemental-sources:v1:*`, `yield-coverage-audit`, and `crons["sync-yield-data"]`. `rankingStatus` follows the post-V9 `sync-yield-data` cache runway (`>8x` degraded, `>12x` stale); missing or stale rankings are public-critical because `/api/yield-rankings` and `/yield/` depend on them. `rankingCountDelta` and `previousRankingCount` come from `sync-yield-data` source-coverage metadata, with a fallback to the top-level severe-coverage-guard metadata when publication is blocked before normal source coverage is assembled. Safety coverage is admin-watch unless it falls below `0.75`, supplemental family cache age is admin-watch above 6h, and coverage-audit age is admin-watch above 45d. `yieldHealth.benchmarkRegistry` evaluates every benchmark key used by published rows, including row counts and fallback-selection counts; any used fallback is degraded, while a missing or older-than-48h used benchmark is stale. The legacy `yieldHealth.benchmark` field remains the USD-only compatibility view. `yieldHealth.supplemental` reports `familyCount`, `freshFamilyCount`, `degradedFamilyCount`, `staleFamilyCount`, `missingFamilyCount`, and a `families` map keyed by source family with per-family age/source-count/status; when no per-family rows exist, aggregate supplemental age remains the fallback. `sourceRiskCoverage` reports backend-only coverage/null rates for nested `sourceRisk.*` fields across best and alternate ranking rows; `"unknown"` venue tiers count as null-equivalent coverage gaps. Loader failures return `yieldHealth: null` and `sectionErrors.yieldHealth`.

`publicationHealth` is a read-only live supplement over existing publication ledgers. It currently normalizes `dex_liquidity_publication_generations` and `yield_publication_generations` into per-surface `lastPublishedGeneration`, `lastAttemptedGeneration`, `lastFailureReason`, `candidateAgeSec`, and optional dependency watermark fields. Surface loaders settle independently: a failing surface is omitted and listed in the additive `failedSurfaces[]` (`{surface, code, message}`) while successful surfaces stay populated, and `sectionErrors.publicationHealth` is set whenever any surface fails. Loader failures do not change publication behavior or write generic publication rows.

`dependencyHealth` is a read-only derived matrix over existing status signals. The worker combines `caches`, `crons`, `publicationHealth`, and the static registry in `shared/lib/data-dependency-registry.ts` into per-dependency status rows plus `rootCauseGroups` that group degraded/stale symptoms under the highest upstream dependency. This is operator triage metadata only: it does not perform extra D1 reads, does not change `availabilityStatus` / `dataQualityStatus`, and does not mutate publication ledgers.

`providerCircuitHealth` is a read-only admin supplement over active provider circuit-breaker rows. Breaker decisions use the individual `cache["circuit:<source>"]` rows; `/api/status` reads those same authoritative rows through a bounded active-source allowlist so lost or stale aggregate-index writes cannot hide open providers. Successful/failing breaker writes still maintain `cache["provider:circuit:index"]` as best-effort telemetry. Loader failures return `providerCircuitHealth: null` and `sectionErrors.providerCircuitHealth`; public `/api/health.circuits` remains the raw per-circuit surface.

`canaries` is a read-only admin supplement over `worker_canary_runs`. In `status` or `alert` mode it reports the latest row from the current authoritative mode for each active structural check, including DEX publication/current-row invariants, stablecoins-cache active coverage, PSI and DEWS latest samples, report-card cache generation/methodology freshness, and the GBP benchmark-current check. Retained historical rows for retired check IDs are ignored by the current summary. In `off` or `shadow` mode it returns the empty/unknown compatibility shape without reading retained authoritative rows; shadow evidence is inspected through D1 and cron metadata. Loader failures return `canaries: null` and `sectionErrors.canaries`; canary findings are operator diagnostics and do not directly change availability.

`mintBurnReconciliation` compares 24h configured canonical issuance-chain mint/burn net flow (`mint_burn_hourly`) against the cached stablecoins payload's matching chain-supply delta. It is intended for operator diagnostics, not public scoring.

### `GET /api/status-history`

Machine-readable status timeline endpoint for tooling and incident analysis.

**Query parameters**

| Param   | Type                  | Default | Description                                                                                                          |
| ------- | --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `limit` | `integer`             | `50`    | Number of transitions to return (1–200)                                                                              |
| `from`  | `integer \| ISO date` | —       | Optional lower bound for transition `created_at` (Unix seconds/milliseconds or ISO date); invalid values are ignored |
| `to`    | `integer \| ISO date` | —       | Optional upper bound for transition `created_at` (Unix seconds/milliseconds or ISO date); invalid values are ignored |

`limit` is clamped into `1..200` by the shared query parser.

**Response shape:** `StatusHistoryResponse` (defined in `shared/types/index.ts`). The response includes the current `reserveComposition` summary when it can be computed, or `null` if the reserve overview diagnostic query fails. `hasMore` reports whether another matching transition exists beyond the returned page: `true` means the selected window is truncated, `false` proves the returned page covers the matching window, and `null` means the transition query failed and completeness is unknown. Consumers must not infer that no transition occurred from a `true` or `null` result.

### `GET /api/request-source-stats`

Admin-only site-vs-external demand attribution summary. Aggregates minute-bucketed request counts into a requested window so operators can estimate what share of total request demand is coming from the website itself versus external consumers.

The top-line `site` bucket combines:

- same-origin `/_site-data/*` upstream attempts recorded by the Pages Function; the retired outer Cache API path may still appear in historical windows
- `api.pharos.watch` requests attributed to browser evidence (`Origin` / `Referer` / frontend `Accept` marker + same-site fetch metadata)
- `api.pharos.watch` requests authenticated with API keys carrying the legacy `trafficClass="site"` label (no longer writable; see `POST /api/api-keys/:id/update`)

The top-line `external` bucket is `api.pharos.watch` traffic not classified as site. Admin-only routes and `/api/telegram-webhook` remain excluded. The response also includes worker-lane telemetry so operators can distinguish total demand from actual `public-api` vs `site-api` worker load.

**Query parameters**

| Param         | Type      | Default | Description                                                             |
| ------------- | --------- | ------- | ----------------------------------------------------------------------- |
| `hours`       | `integer` | `24`    | Window size in hours (`1`–`840`, currently 35 days)                     |
| `bucketSec`   | `integer` | `3600`  | Time-bucket rollup size in seconds (`60`–`86400`)                       |
| `routeLimit`  | `integer` | `20`    | Max per-route rows returned in the route breakdown (`1`-`100`)          |
| `apiKeyLimit` | `integer` | `25`    | Max per-key rows returned in the keyed public-API breakdown (`1`-`100`) |

Malformed numeric params return `400`; out-of-range numeric params are clamped to the documented bounds.

**Response shape:** `ApiRequestAttributionResponse` (defined in `shared/types/index.ts`)

`ApiRequestAttributionResponse` includes:

- `generatedAt` — Unix seconds when the response was generated
- `window` — requested `from`/`to`, `durationSec`, `bucketSizeSec`, `routeLimit`, `apiKeyLimit`, and current `retentionDays`
- `totals` — aggregate `siteRequests`, `externalRequests`, `totalRequests`, `siteSharePct`, `externalSharePct`
- `siteDelivery` — Pages delivery-path counters (`pagesCacheHits` is historical-only; current traffic uses `pagesUpstreamFetches`, `pagesUpstreamTimeouts`, or `pagesUpstreamErrors`) plus `publicApiSiteRequests`
- `lanes[]` — worker-load split by `lane` (`public-api`, `site-api`) with the same site/external counters
- `routes[]` — normalized per-route breakdown sorted by total demand volume
- `buckets[]` — time-series rollups using the requested `bucketSec`
- `keyedPublicApi` — summary of authenticated protected `public-api` traffic (`keyedRequests`, `unkeyedRequests`, share percentages, total keys in window, and truncation metadata)
- `apiKeys[]` — top API keys by keyed request volume with masked token, traffic class, active/expiry metadata, rate limit, request count, and keyed/public-api share percentages
- `scope` — explicit booleans describing total site demand, worker load, and whether the selected historical window contains retired Pages cache-hit telemetry

### `GET /api/api-keys`

Admin-only API key inventory. Returns masked tokens plus metadata, but never returns stored secret material. Expired keys remain listed for operator review; callers should use `isActive` plus `expiresAt` to distinguish `active`, `expired`, and deliberate non-expiring exceptions.

**Response shape:** `ApiKeyListResponse` (defined in `shared/types/api-keys.ts`)

### `GET /api/api-keys/lifecycle-summary`

Admin-only counts projection for the Triage workspace. Returns aggregate credential lifecycle counts and the 7-day rotate/deactivate anomaly count without exposing API-key row metadata, owner emails, masked tokens, audit actors, or audit detail payloads.

**Response shape:** `CredentialLifecycleSummaryResponse` (defined in `shared/types/api-keys.ts`)

```json
{
  "generatedAt": 1710500000,
  "totalKeys": 12,
  "active": 10,
  "expiringSoon": 2,
  "expired": 1,
  "nonExpiring": 1,
  "auditAnomalies7d": 3
}
```

### `GET /api/api-keys/audit-log`

Admin-only API key lifecycle audit log. Returns recent create/update/deactivate/rotate audit entries from `api_key_audit_log`.

**Query params:**

| Param      | Type      | Default | Max | Description                        |
| ---------- | --------- | ------- | --- | ---------------------------------- |
| `limit`    | `integer` | `50`    | 200 | Number of audit entries to return  |
| `apiKeyId` | `integer` | n/a     | n/a | Optional filter for one API key ID |

**Response shape:**

```json
{
  "entries": [
    {
      "id": 1,
      "apiKeyId": 7,
      "action": "created",
      "actor": "admin",
      "detail": { "name": "Smoke" },
      "createdAt": 1710500000
    }
  ]
}
```

### `POST /api/api-keys`

Admin-only API key creation route.

**Body shape:** `ApiKeyCreateRequest`

| Field                | Type                   | Required | Description                                                                                                                                 |
| -------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `string`               | Yes      | Display name for the key                                                                                                                    |
| `ownerEmail`         | `string`               | No       | Optional operator / owner contact                                                                                                           |
| `tier`               | `"standard" \| "self-serve"` | No       | Issuance tier; defaults to `"standard"`. `"self-serve"` is written by the verified public issuance path                              |
| `rateLimitPerMinute` | `integer`              | No       | Per-key threshold (`1`–`10000`, default `120`)                                                                                              |
| `expiresAt`          | `integer \| null`      | No       | Unix timestamp when the key should expire. Omit to use the default 90-day expiry. Send `null` only for a deliberate non-expiring exception. |

**Response shape:** `ApiKeyCreateResponse`

**Success status:** `201 Created`

`token` is returned only once. Persist it immediately; later list/read paths expose only `maskedToken`. `key.expiresAt` in the response reflects the stored expiry after the default-90-day fallback is applied.

### `POST /api/api-keys/:id/update`

Admin-only metadata update for an existing API key.

**Body shape:** `ApiKeyUpdateRequest`

Accepted fields:

- `name`
- `ownerEmail`
- `tier`
- `rateLimitPerMinute`
- `isActive`
- `expiresAt`

`trafficClass` is no longer accepted on either mutation body. It is an attribution label only — the real request lane is derived per request in `worker/src/handlers/http/gates.ts` — so issuance always writes `"external"` and existing rows keep whatever value they were created with.

**Response shape:** `ApiKeyMutationResponse`

Send `expiresAt: null` only for a deliberate non-expiring exception. Existing keys created before the expiry migration keep `expiresAt = null` until an operator changes them.

### `POST /api/api-keys/:id/deactivate`

Admin-only hard deactivation for an existing API key. This sets `isActive=false`; the secret cannot be used afterward.

**Response shape:** `ApiKeyMutationResponse`

### `POST /api/api-keys/:id/rotate`

Admin-only secret rotation. The old token stops working immediately and a new plaintext token is returned once. Rotation does not accept expiry input and preserves the current `expiresAt`.

**Response shape:** `ApiKeyRotateResponse`

### `GET /api/api-key-requests-admin`

Admin-only self-serve API key request list used by `ops.pharos.watch/admin-api/`. Returns requester details, risk context, intended endpoints, verification/issuance timestamps, linked key metadata, and claim state. It never returns plaintext API tokens.

**Query params:**

| Param    | Type      | Default | Max | Description                                                                            |
| -------- | --------- | ------- | --- | -------------------------------------------------------------------------------------- |
| `status` | `string`  | n/a     | n/a | Optional filter: `pending_verification`, `issued`, `rejected`, `blocked`, or `expired` |
| `limit`  | `integer` | `50`    | 100 | Number of request rows to return                                                       |

**Response shape:** `ApiKeySelfServeRequestAdminListResponse` (defined in `shared/types/api-key-requests.ts`)

### `POST /api/api-key-requests-admin/:requestId/reject`

Admin-only rejection for a self-serve request. If a linked key exists, the handler deactivates it before marking the request rejected and releasing the email claim.

**Response shape:** `ApiKeySelfServeAdminMutationResponse`

### `POST /api/api-key-requests-admin/:requestId/release-claim`

Admin-only claim release for a self-serve request that should no longer block the normalized email. The handler refuses to release a claim while the request still has an active, unexpired linked key.

**Response shape:** `ApiKeySelfServeAdminMutationResponse`

### `POST /api/backfill-depegs`

Backfills historical depeg events from stored price data.

For coins with a registered authoritative historical price provider, the backfill uses that same provider family first (for example, replayed protocol redemption quotes) before falling back to market history. If the authoritative provider is configured but unavailable, existing `source='backfill'` rows for that coin are preserved instead of being rebuilt from a weaker source.

Supported non-USD fiat assets now prefer direct CoinGecko native-fiat history first and compare that series to the native `1.0` peg before they fall back to USD-denominated CoinGecko/DefiLlama history plus historical FX. In that native-fiat mode, backfill uses daily points plus a two-point confirmation window across 36 hours, while still preserving extreme single-point crashes of `>= 5000 bps`.

`dry-run=true` compares the freshly replayed historical events against the currently stored `source='backfill'` rows without mutating the database. The preview reports whether the replay exactly matches the stored backfill rows, how many stored backfill rows would be removed, how many replayed rows would be added, and the current live-row counts for the same asset.

Bounded replay windows also support `startDay` / `endDay`, plus optional `contextDays` to widen the replay pad around that UTC window. This makes long-history audits and repairs practical over `ops-api` without waiting for a full-coin rebuild. In mutating mode, bounded replays only replace overlapping `source='backfill'` rows for that coin and preserve non-overlapping backfill rows plus all `source='live'` rows.
For commodity-pegged assets, bounded replays limit the peer-median reference fetch to the replay pad and only fetch the needed gold or silver source family.

**Query parameters**

| Param         | Type                               | Default | Description                                                           |
| ------------- | ---------------------------------- | ------- | --------------------------------------------------------------------- |
| `stablecoin`  | `string`                           | —       | Process a single stablecoin ID                                        |
| `batch`       | `integer`                          | `0`     | Batch offset (3 coins per batch)                                      |
| `dry-run`     | `"true"`                           | —       | Preview replay-vs-backfill differences without writing `depeg_events` |
| `startDay`    | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for bounded replay compare/mutation                       |
| `endDay`      | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for bounded replay compare/mutation                       |
| `contextDays` | `integer`                          | `7`     | Extra replay context days on each side of a bounded window (max `90`) |

### `POST /api/backfill-supply-history`

Backfills per-coin supply history snapshots. When historical market-price series are available, the endpoint also persists daily `supply_history.price` values on restored rows so historical PSI replay can use day-level deviation instead of blunt peak fallback.

Commodity and CoinGecko-only total-supply fallback replays historical EVM `totalSupply()` at each UTC day close when CoinGecko market caps are missing. It does not project the current supply backward across the requested window, and it fails closed when the asset has multiple supported EVM deployments. Protocol-TVL fallback can still write market-cap rows, but stores `price: null` for days outside the returned price-chart coverage instead of extrapolating the nearest endpoint price.

**Query parameters**

| Param                           | Type                               | Default | Description                                                                               |
| ------------------------------- | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `stablecoin`                    | `string`                           | —       | Process a single stablecoin ID                                                            |
| `batch`                         | `integer`                          | `0`     | Batch offset for chunked processing                                                       |
| `batchSize`                     | `integer`                          | `10`    | Coins per batch                                                                           |
| `allow-constant-price-fallback` | `"true"`                           | —       | Allow current-price fallback when historical non-USD prices are missing                   |
| `startDay`                      | `integer \| ISO date (YYYY-MM-DD)` | —       | Lower bound for UTC daily rows written                                                    |
| `endDay`                        | `integer \| ISO date (YYYY-MM-DD)` | —       | Upper bound for UTC daily rows written; future values clamp to the last completed UTC day |

### `POST /api/backfill-stability-index`

Backfills historical stability index scores from stored depeg events and supply data.

The rebuild now stops at the last completed UTC day; it does not write a `stability_index` row for the current UTC day. Historical market-cap denominators in this replay path are bounded to core stablecoins, cash equivalents, and configured shadow assets. Variants and stable-value investments retain their depeg and supply histories but do not contribute to replayed PSI. Historical replay treats a core-universe depeg as active for any UTC day whose window overlaps the event interval. When a usable same-day `supply_history.price` exists, the replay derives day severity from that price, but on the UTC day the depeg begins it keeps `peak_deviation_bps` as a floor only when the event materially persisted past that UTC close and the daily snapshot undercaptures the shock by at least the configured depeg threshold. Same-day recovered wicks, near-midnight bleed-throughs, and moderate follow-on moves that the restored day price already captures use the daily historical price instead, and replay days whose restored daily price is back inside the configured depeg threshold are dropped instead of still contributing breadth. Later days fall back to `peak_deviation_bps` only for missing/invalid historical prices. The historical restore path is expected to repair replay-critical `supply_history.price` coverage, including PSI-only shadow assets, before rerunning this rebuild. For methodology `v3.0+`, the replay also derives daily `stressBreadth` from core-universe `stress_signal_history` rows in `ALERT`, `WARNING`, or `DANGER` bands. If a rebuild day cannot be replayed because archival inputs are unavailable, the endpoint preserves the existing stored row instead of deleting that day. The response includes the evaluated `startDay`/`endDay` so operators can confirm the rebuild window.

**Query parameters**

| Param      | Type                               | Default                | Description                                                                      |
| ---------- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `dry-run`  | `"true"`                           | —                      | Preview the rebuild window and change summary without mutating `stability_index` |
| `startDay` | `integer \| ISO date (YYYY-MM-DD)` | earliest depeg day     | Lower bound for rebuilt UTC days                                                 |
| `endDay`   | `integer \| ISO date (YYYY-MM-DD)` | last completed UTC day | Upper bound for rebuilt UTC days                                                 |

### `POST /api/backfill-cg-prices`

Backfills historical market prices for the PSI-eligible universe. The endpoint fills NULL `supply_history.price` gaps and can insert missing `supply_history` day rows when market-cap history exists, including PSI-only shadow assets such as `ust-terra`.

**Query parameters**

| Param        | Type      | Default | Description                         |
| ------------ | --------- | ------- | ----------------------------------- |
| `stablecoin` | `string`  | —       | Process a single stablecoin ID      |
| `batchSize`  | `integer` | `10`    | Coins per batch                     |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing |

### `POST /api/backfill-yield-history`

Backfills protocol API yield-history rows for the curated target set used by yield intelligence. The current target set is limited to Zephyr ZYS (`zys-zephyr-protocol`) through the protocol API source.

**Query parameters**

| Param        | Type      | Default | Description                              |
| ------------ | --------- | ------- | ---------------------------------------- |
| `stablecoin` | `string`  | —       | Process a single supported stablecoin ID |
| `batchSize`  | `integer` | `10`    | Coins per batch                          |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing      |

### `POST /api/backfill-tape`

Runs the same TAPE projectors used by the `project-tape` cron with operator-supplied window and limit overrides. Writes are idempotent on `(source_table, source_row_id, transition)`, so the endpoint is safe to re-run. First-observation projectors such as methodology, cemetery, and lifecycle ignore `since` / `until` because they scan static sources keyed by ID.

**Request body or query parameters**

Query parameters win when the same field is supplied in both places.

| Param     | Type      | Default | Description                                                            |
| --------- | --------- | ------- | ---------------------------------------------------------------------- |
| `class`   | `string`  | all     | Repeatable projector class filter, for example `class=depeg.opened`    |
| `since`   | `integer` | none    | Lower source-row timestamp bound in Unix seconds                       |
| `until`   | `integer` | none    | Upper source-row timestamp bound in Unix seconds                       |
| `maxRows` | `integer` | `5000`  | Per-class scan cap, min `1`, max `50000`                               |
| `dryRun`  | `boolean` | `false` | Compute results without writing rows or advancing projector watermarks |
| `dry-run` | `boolean` | `false` | Query/body alias for `dryRun`                                          |

Supported projector classes are `depeg.opened`, `depeg.resolved`, `depeg.peak_worsened`, `freeze.blocked`, `freeze.unblocked`, `freeze.destroyed`, `score.upgraded`, `score.downgraded`, `psi.band_changed`, `dews.escalated`, `dews.deescalated`, `mint_burn.large_flow`, `yield.warning_emitted`, `yield.pys_dropped`, `methodology.bumped`, `cemetery.entry.added`, and `lifecycle.tracked.frozen`. `depeg.resolved` projects only recovery-backed depeg closures, not coverage-loss, orphan, or superseded-direction terminal rows.

**Response**

```json
{
  "ok": true,
  "dryRun": false,
  "maxRows": 5000,
  "since": null,
  "until": null,
  "selectedClasses": ["depeg.opened"],
  "projected": 12,
  "perClass": { "depeg.opened": 12 },
  "errors": []
}
```

**Error responses:** `400` for unknown `class` values, invalid negative timestamps, `since > until`, or `maxRows` outside `1..50000`.

### `POST /api/backfill-mint-burn-prices`

Repairs bounded historical mint/burn NULL-USD debt using exact event-day evidence. The endpoint defaults to `dry-run=true`, accepts `limit=1..500` (default `100`) and optional `stablecoin=<id>`, and never uses current `price_cache` or an adjacent-day price. Source order is exact-day `supply_history`, CoinGecko historical market chart, DefiLlama CoinGecko-identity chart, then an exact configured contract chart. DefiLlama spans are loaded sequentially in up to eight 800-day windows per identity; points are merged before event-day resolution, and an over-budget range or unavailable window keeps unresolved rows retryable rather than falsely irreducible.

Mutation requires `dry-run=false&confirm=historical-mint-prices&bookmark=<fresh-d1-bookmark>` plus an `Idempotency-Key` header from 1 to 128 trimmed characters. The bookmark and idempotency key are persisted on every attempted row. Rows without a valid point after definitive source responses become explicitly `irreducible`; transient provider failures remain retryable. Recovered rows are finalized only after `mint_burn_hourly` is rebuilt and verified against source events. `retry-irreducible=true` is reserved for reopening classifications after source coverage improves.

Cron `sync-mint-burn` automatically heals recent NULL-price events within a 48-hour window and reports the healed count in cron metadata as `nullPricesHealed`; this endpoint is primarily for historical backfills beyond that window.

**Response**

```json
{
  "dryRun": true,
  "limit": 100,
  "selected": 1,
  "recovered": 1,
  "classifiedIrreducible": 0,
  "deferredForRetry": 0,
  "aggregateCoinsRebuilt": ["ustb-superstate"],
  "aggregateVerificationPassed": null,
  "dispositions": [
    {
      "eventId": "ethereum-0xabc-0",
      "stablecoinId": "ustb-superstate",
      "chainId": "ethereum",
      "timestamp": 1740279479,
      "disposition": "recover",
      "price": 10.58,
      "priceTimestamp": 1740272109,
      "priceSource": "repair:defillama-gecko-chart-event-day:superstate-short-duration-us-government-securities-fund-ustb",
      "reason": null
    }
  ],
  "backlog": {
    "unclassified": 529,
    "irreducible": 0,
    "pendingAggregate": 0,
    "totalNullUsd": 529
  }
}
```

### `GET /api/backfill-dews`

Runs the historical DEWS backtest path against stored depeg events. This is the default `GET` mode when no `mode` or `repair` query is supplied; it reports true-positive coverage and lead-time summary fields from the historical replay implementation.

Use `GET /api/backfill-dews?mode=backtest-metrics` for the curated anchor fixture metrics described below. Use `GET /api/backfill-dews?repair=...&dry-run=true` for repair previews; mutating repair runs are `POST`-only.

### `GET /api/backfill-dews?mode=backtest-metrics`

Backtest harness that replays DEWS over a curated set of historical depeg onsets (the `BACKTEST_ANCHORS` fixture). Reports detection rate and lead-time percentiles sourced from `stress_signal_history` daily snapshots.

**Authentication:** admin only (same Cloudflare Access gate as the rest of `/api/backfill-dews`).

**Granularity:** `"daily"`. The harness reads `stress_signal_history` rows (one snapshot per UTC day) over a 14-day window ending at each anchor's `onsetAt` and looks for the first `ALERT` / `WARNING` / `DANGER` band inside that window.

**Response**

```json
{
  "detectionRate": 0.75,
  "leadTimeDaysP50": 4,
  "leadTimeDaysP90": 11,
  "granularity": "daily",
  "perAnchor": [
    {
      "stablecoinId": "usdc-circle",
      "onsetAt": 1679400000,
      "detected": true,
      "leadTimeDays": 2,
      "firstAlertBand": "WARNING"
    }
  ]
}
```

| Field             | Type                         | Description                                                                                     |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `detectionRate`   | `number`                     | Fraction of anchors where DEWS surfaced at least `ALERT` before `onsetAt` (`0` if no anchors)   |
| `leadTimeDaysP50` | `number \| null`             | 50th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `leadTimeDaysP90` | `number \| null`             | 90th-percentile lead time in days across detected anchors; `null` when no anchors were detected |
| `granularity`     | `"daily"`                    | Snapshot granularity used to compute lead time                                                  |
| `perAnchor`       | `BacktestMetricsPerAnchor[]` | One entry per anchor in the fixture (see below)                                                 |

**`BacktestMetricsPerAnchor`**

| Field            | Type                                       | Description                                                                       |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `stablecoinId`   | `string`                                   | Pharos stablecoin ID of the anchor                                                |
| `onsetAt`        | `number`                                   | Unix seconds of the curated depeg onset                                           |
| `detected`       | `boolean`                                  | Whether DEWS reached at least `ALERT` within the 14-day pre-onset window          |
| `leadTimeDays`   | `number \| null`                           | Days between the first elevated band and `onsetAt`; `null` if `detected=false`    |
| `firstAlertBand` | `"ALERT" \| "WARNING" \| "DANGER" \| null` | Band of the first elevated snapshot inside the window; `null` if `detected=false` |

### `GET /api/backfill-dews?repair=refresh-current&dry-run=true`

Dry-run preview for the current-state DEWS repair. Returns the exact set of stablecoins that would be republished under the live `$1M` DEX trust floor, plus source-coverage / validation diagnostics from the preview computation.

### `POST /api/backfill-dews?repair=refresh-current`

Immediately republishes current `stress_signals` rows under the live `$1M` DEX trust floor. The response includes the dry-run preview payload plus the executed `computeAndStoreDEWS()` summary.

### `GET /api/backfill-dews?repair=prune-history&dry-run=true`

Dry-run preview for bounded DEWS history pruning. Returns the exact `stress_signal_history` rows that fall inside the requested window, optional `stablecoin` filter scope, and the current post-window history boundary.

### `POST /api/backfill-dews?repair=prune-history`

Deletes bounded `stress_signal_history` windows that cannot be deterministically recomputed because historical daily snapshots do not retain the DEX trust metadata required to replay the live `$1M` divergence gate.

**Query parameters**

| Param        | Type                                   | Default             | Description                                                                        |
| ------------ | -------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `repair`     | `"refresh-current" \| "prune-history"` | required for `POST` | Selects the DEWS repair mode                                                       |
| `dry-run`    | `"true"`                               | —                   | Required for `GET` repair previews; optional on `POST` to preview without writes   |
| `stablecoin` | `string`                               | —                   | Optional tracked stablecoin ID for `repair=prune-history`                          |
| `startDay`   | `string`                               | `2026-03-09`        | Optional prune-window start day (`YYYY-MM-DD`, Unix seconds, or Unix milliseconds) |
| `endDay`     | `string`                               | current UTC day     | Optional prune-window end day (`YYYY-MM-DD`, Unix seconds, or Unix milliseconds)   |

### `POST /api/backfill-mint-burn`

Backfills mint/burn event ingestion for a specific contract config using the same parsing/classification pipeline as the cron.
If `configKey` is omitted, the worker auto-selects one tracked config using a critical-first / major-symbol-first / most-behind policy and returns the selected config in the response.

**Request body or query parameters**

| Param       | Type      | Default         | Description                                                                              |
| ----------- | --------- | --------------- | ---------------------------------------------------------------------------------------- |
| `configKey` | `string`  | auto-selected   | Optional config key: `{chainId}-{contractAddress}` across the tracked issuance-chain set |
| `fromBlock` | `integer` | from sync state | Start block override                                                                     |
| `toBlock`   | `integer` | chain head      | End block override (clamped to chain head)                                               |
| `chunkSize` | `integer` | `50000`         | Block span per fetch chunk (max 50000)                                                   |
| `maxChunks` | `integer` | `24`            | Maximum chunks to process per request                                                    |

### `POST /api/reclassify-atomic-roundtrips`

Retroactively tags same-transaction mint+burn pairs for the same stablecoin as `flow_type='atomic_roundtrip'` and recalculates the affected hourly buckets.

**Query parameters**

| Param          | Type      | Default         | Description                                                                                                                                 |
| -------------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`        | `integer` | `now - 90 days` | Unix seconds cutoff for both forward and reverse scans; `0` requests a full-table sweep and may exceed D1 CPU limits without `stablecoinId` |
| `stablecoinId` | `string`  | —               | Optional Pharos stablecoin ID filter applied to both scans                                                                                  |

**Response**

```json
{
  "done": false,
  "since": 1765218367,
  "stablecoinId": "usdt-tether",
  "updated": 428,
  "toRoundtrip": 420,
  "toStandard": 8,
  "hoursRecalculated": 31,
  "batchSize": 1000
}
```

The endpoint processes up to 1000 `(tx_hash, stablecoin_id)` groups per request. Repeat until `done=true`.

### `GET /api/audit-depeg-history?dry-run=true`

Dry-run preview for the depeg audit endpoint. This is the only supported `GET` mode for `/api/audit-depeg-history`; all mutating executions require `POST`.

The same endpoint also supports dry-run historical repair previews:

- `repair=synthetic-splits` surfaces adjacent same-direction events that were likely split either by the old DEX-only auto-close behavior or by a backfill-to-live handoff where historical replay expired mid-ongoing depeg
- `repair=contradictory-recovery-price` surfaces ended events whose stored `recovery_price` is still outside the allowed depeg threshold and should be nulled

**Query parameters**

| Param        | Type                                                   | Default  | Description                                                                                                                 |
| ------------ | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `limit`      | `integer`                                              | `25`     | Max events or repair candidates to inspect per request (`max 25`)                                                           |
| `offset`     | `integer`                                              | `0`      | Pagination offset                                                                                                           |
| `dry-run`    | `"true"`                                               | required | Must be exactly `"true"` for `GET`                                                                                          |
| `min-supply` | `number`                                               | `0`      | Minimum supply (USD) to include in audit                                                                                    |
| `symbol`     | `string`                                               | —        | Filter by symbol (case-insensitive)                                                                                         |
| `repair`     | `"synthetic-splits" \| "contradictory-recovery-price"` | —        | Preview synthetic split consolidation or contradictory terminal-price repairs instead of the CoinGecko false-positive audit |

### `POST /api/audit-depeg-history`

Audits existing depeg events against CoinGecko historical price data to detect false positives.

`POST /api/audit-depeg-history?repair=synthetic-splits` instead runs a historical repair pass that consolidates adjacent same-direction events when either:

- a live event was split by the retired DEX-only auto-close behavior after the earlier row closed near peg, or
- a backfill row ended without recovery and a live row resumed the same severe move within one sync gap because the historical replay window expired mid-event.

When a repair group ends in a live row, the live tail is kept as the canonical record and inherits the earlier start plus worst peak so future backfills do not recreate the split.

`POST /api/audit-depeg-history?repair=contradictory-recovery-price` instead nulls ended-event `recovery_price` values that still sit outside the permitted depeg threshold. This is the bounded repair path for legacy rows closed by a native-quote recovery while the stored USD price still looked depegged.

Mutating delete/repair runs and false-positive deletes stage any required PSI stability-index recompute into the same D1 batch commit. If that commit fails, the endpoint now returns `500` with a specific error and does not leave a partial delete/repair behind.

`GET` is accepted only with `dry-run=true`; mutating audits require `POST`.

**Query parameters**

| Param        | Type                                                   | Default | Description                                                                                                            |
| ------------ | ------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `limit`      | `integer`                                              | `25`    | Max events or repair candidates to process per request (`max 25`)                                                      |
| `offset`     | `integer`                                              | `0`     | Pagination offset                                                                                                      |
| `delete`     | `string`                                               | —       | Comma-separated event IDs to delete directly (skips CG audit)                                                          |
| `dry-run`    | `"true"`                                               | —       | When `"true"`, preview deletions without touching DB. Default behavior deletes false positives                         |
| `min-supply` | `number`                                               | `0`     | Minimum supply (USD) to include in audit                                                                               |
| `symbol`     | `string`                                               | —       | Filter by symbol (case-insensitive)                                                                                    |
| `repair`     | `"synthetic-splits" \| "contradictory-recovery-price"` | —       | Run synthetic split consolidation or contradictory terminal-price repair instead of the CoinGecko false-positive audit |

### `POST /api/trigger-digest`

Queues a deferred daily-digest regeneration, bypassing the normal 1-hour dedup check. The HTTP handler writes a `digest:force-run-request` flag into the D1 `cache` table and returns `202`; the dedicated `*/5 * * * *` digest-trigger poll slot runs the digest on the next tick under the scheduled-event wall-clock and the existing `daily-digest` lease.

**Response**

```json
{
  "ok": true,
  "accepted": true,
  "requestId": "manual-digest-...",
  "message": "Digest trigger queued; will execute on the next polling tick (≤5 min)."
}
```

**Status:** `202 Accepted`

The worker no longer uses HTTP `waitUntil()` for this action. It enqueues the request in D1 and returns immediately so the Access-gated ops proxy does not need to hold the HTTP request open for the full Anthropic generation window. The scheduled poll logs the eventual run against the `daily-digest` cron history and persists a compact `digest:last-trigger-result` cache entry for D1 inspection/future UI surfacing, including manual `skipped_locked` outcomes when another digest run already holds the lease. The current admin panel shows the enqueue result from the browser session; it does not yet render the persisted poll outcome.

Unhandled pre-enqueue failures are wrapped by the shared error handler and return `500` with `{ "error": "Internal Server Error" }`.

### `POST /api/reset-blacklist-sync`

Rolls back blacklist sync state to re-scan missed events. EVM chains are rolled back by 50,000 blocks; Tron is rolled back by 7 days. The action rewinds both typed and compatibility cursor columns, increments the attempt generation to fence late writers, and clears successful-scan freshness. Routed through `worker/src/router.ts`.

This is a global emergency rewind, not the recovery path for a known event manifest. Bounded data recovery must use a reviewed config/event-specific reconciliation so unrelated cursors are not moved.

**Response** (`evmReset` / `tronReset` are row-change counts from the `blacklist_sync_state` UPDATE, not block numbers)

```json
{
  "ok": true,
  "evmReset": 5,
  "tronReset": 2
}
```

### `GET /api/debug-sync-state`

Returns current blacklist sync state for all configured chains. Useful for diagnosing sync issues. Routed through `worker/src/router.ts`.

**Response**

```json
[
  {
    "configKey": "ethereum-usdc",
    "stablecoin": "USDC",
    "stablecoinId": "usdc-circle",
    "chainId": 1,
    "chainName": "Ethereum",
    "contractAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "providerSource": "evm-logs",
    "cursorKind": "evm_block",
    "cursorValue": 19500000,
    "lastBlock": 19500000,
    "cursorAgeSec": null,
    "attemptGeneration": 12,
    "lastAttemptedAt": 1710503000,
    "lastSucceededAt": 1710503000,
    "lastSkippedAt": null,
    "lastFailedAt": null,
    "consecutiveSkips": 0,
    "consecutiveFailures": 0,
    "lastOutcome": "quiet",
    "lastObservedSafeHead": 19500000,
    "lastSafeHeadObservedAt": 1710503000,
    "lastEventAt": 1710500000,
    "lastEventAgeSec": 3600,
    "lastEventBlock": 19499999,
    "eventCount": 42,
    "lastRunStartedAt": 1710503000,
    "lastRunStatus": "ok",
    "lastErrorClass": null,
    "lastErrorMessage": null
  }
]
```

### `POST /api/remediate-blacklist-amount-gaps`

Admin-only bounded remediation endpoint for recoverable blacklist rows.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Inputs**

- `chainId?: string`
- `stablecoin?: BlacklistStablecoin` from the shared `BLACKLIST_STABLECOINS` set
- `limit?: number` default `25`, max `200`
- `dryRun?: boolean` default `true`
- `onlyMissingProvenance?: boolean` default `false`; set `true` to restrict the pass to legacy rows missing contract/config provenance
- `maxAttempts?: number` default `25`

**Dry-run response**

```json
{
  "ok": true,
  "dryRun": true,
  "candidateCount": 26,
  "resolutionCounts": {
    "resolved": 26,
    "missing_config": 0,
    "ambiguous_config": 0
  }
}
```

**Write-enabled response**

```json
{
  "ok": true,
  "dryRun": false,
  "applied": {
    "resolved": 26,
    "resolvedZero": 26,
    "providerFailed": 0,
    "configMissing": 0,
    "configAmbiguous": 0,
    "budgetUsed": 26,
    "budgetLimit": 900
  }
}
```

### `POST /api/backfill-blacklist-current-balances`

Admin-only one-shot backfill endpoint for `blacklist_current_balances`, intended for blacklist configs whose historical events were ingested before the current-balance cache existed.

**Authentication:** same admin auth as other ops endpoints.

**Idempotency:** supported via optional `Idempotency-Key`.

**Query parameters**

| Param        | Type      | Default | Description                                                                                   |
| ------------ | --------- | ------- | --------------------------------------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | Optional uppercase symbol filter; matches any configured blacklist-contract stablecoin symbol |
| `chainId`    | `string`  | —       | Optional chain filter matching the blacklist contract config `chainId`                        |
| `limit`      | `integer` | `500`   | Max newest latest-per-address blacklist-event rows to load per matching config (max `2000`)   |
| `dryRun`     | `"true"`  | —       | Preview the active-blacklisted candidate count without writing cache rows                     |

`400` is returned when the filters match no configured blacklist contracts.

**Dry-run response**

```json
{
  "ok": true,
  "dryRun": true,
  "configs": [
    {
      "configKey": "ethereum-pyusd",
      "stablecoin": "PYUSD",
      "chainId": "ethereum",
      "candidateCount": 12,
      "updated": 0,
      "deleted": 0,
      "failed": 0
    }
  ],
  "totals": {
    "candidates": 12,
    "updated": 0,
    "deleted": 0,
    "failed": 0
  },
  "budgetUsed": 0,
  "budgetLimit": 900
}
```

**Write-enabled response**

```json
{
  "ok": true,
  "dryRun": false,
  "configs": [
    {
      "configKey": "ethereum-pyusd",
      "stablecoin": "PYUSD",
      "chainId": "ethereum",
      "candidateCount": 500,
      "updated": 12,
      "deleted": 0,
      "failed": 1
    }
  ],
  "totals": {
    "candidates": 500,
    "updated": 12,
    "deleted": 0,
    "failed": 1
  },
  "budgetUsed": 37,
  "budgetLimit": 900
}
```

### `GET /api/admin-action-log`

Returns the last N audited operator actions (action name, actor, target, result, HTTP status, details) for post-incident review. This includes every endpoint surfaced by the admin action catalog, including read-only inspections and dry-run previews, plus handler-owned audit events outside that catalog.

**Authentication:** admin. **Optional query:** `?limit=<1-200>` (default 50).

Malformed `limit` defaults to `50`; out-of-range `limit` is clamped to `1..200`.

Catalog rows contain only allowlisted operational metadata: canonical path/method, configured scope and target, dry-run/live/inspect mode, result status, HTTP status, execution certainty, result mode, replay state, and an opaque SHA-256 idempotency identity when the request supplied a valid key. Request bodies, arbitrary query parameters, authentication headers, raw handler responses, and plaintext tokens are never stored. Keyed catalog intents are unique by action and opaque intent identity; a same-key replay does not create another row, while a distinct key records a new intent. If the first audit write was transiently missing, a replay can backfill it; the original non-replay outcome remains authoritative over an earlier replay placeholder.

For browser actions, `actor` is the normalized email from the signature-verified operator UI Access JWT; browser-supplied actor headers are ignored. Direct service-token tooling without a verified human claim remains attributed to the internal actor. If canonical audit persistence fails after an idempotent result exists, the router returns `503 audit_persistence_failed`; retrying with the same key replays the result and retries the audit write without rerunning the effect.

**Response**

```json
{
  "entries": [
    {
      "id": 42,
      "at": 1700000000,
      "actor": "alice@pharos.watch",
      "action": "reset-blacklist-sync",
      "target": "blacklist-sync",
      "result": "ok",
      "httpStatus": 200,
      "details": { "cleared": 1 }
    }
  ]
}
```

### `POST /api/admin-telegram-broadcast`

Sends a pre-rendered maintenance/broadcast message to Telegram subscribers via the standard pending-queue fan-out. Used for maintenance windows or outage notices. Live calls submit one pending-queue message per target chat per message chunk; existing rows with the same dedupe key are updated rather than duplicated. The existing dispatch cron delivers them with the same per-chat rate-limit isolation and wall-clock retry semantics as regular alerts. Every live call writes one row to `admin_action_audit`.

**Authentication:** admin (`X-Pharos-Admin: 1` header required).

**Body**

```json
{
  "messageHtml": "<b>Pharos maintenance</b>\nThe bot will be offline 10:00-10:15 UTC.",
  "scope": "all",
  "dryRun": true,
  "canaryChatId": "123456789"
}
```

`scope` is `all` (every row in `telegram_subscribers`), `deliverable-watchers` (rows with at least one active global, per-coin, or preset alert follow), or `global-subscribers` (rows where at least one `global_alert_*` flag is set). `dryRun` is required and must be a boolean. `messageHtml` must be a non-empty string, is capped at 16,000 characters, and uses Telegram HTML formatting; long bodies are split via the same chunking pipeline as alerts. Dry-run and live requests preflight the supported Telegram HTML subset before target selection or enqueue: `a[href]`, `b`/`strong`, `i`/`em`, `u`/`ins`, `s`/`strike`/`del`, `code`, `pre`, `tg-spoiler`, and `blockquote` with optional `expandable`, plus simple named/numeric HTML entities. Live requests require `canaryChatId`, an operator-controlled private-chat ID, and exclude that ID from the fleet enqueue after sending every chunk to it silently with link previews disabled. The legacy optional `acknowledgeBacklogRisk` boolean is accepted for rolling-client compatibility but cannot bypass the TTL-reserve gate.

**Dry-run response (`dryRun: true`)**

```json
{
  "targetChatCount": 1247,
  "chunkCount": 1,
  "targetMessageCount": 1247,
  "pendingCapacity": {
    "total": 0,
    "active": 0,
    "due": 0,
    "deferred": 0,
    "expired": 0,
    "nearTtl": 0,
    "oldestPendingAgeSec": null,
    "oldestDuePendingAgeSec": null,
    "estimatedDrainTimeSec": 0,
    "drainBudgetPerRun": 1800,
    "dispatchIntervalSec": 300
  },
  "deliveryEstimate": {
    "currentPendingActive": 0,
    "projectedPendingMessages": 1247,
    "drainBudgetPerRun": 1800,
    "adminBroadcastTtlSec": 2700,
    "estimatedDrainTimeSec": 300,
    "minimumTtlReserveSec": 900,
    "remainingTtlReserveSec": 2400,
    "hasMaterialTtlReserve": true,
    "fitsWithinMinutes": {
      "5": true,
      "15": true,
      "30": true,
      "60": true
    }
  },
  "htmlPreflight": "ok",
  "canary": {
    "requiredForLive": true,
    "chatId": "123456789",
    "wouldSendChunkCount": 1
  },
  "sample": ["100", "200", "300", "400", "500"]
}
```

`sample` lists up to the first 5 target chat IDs (sorted ascending) — useful for sanity-checking the scope filter before going live. `targetMessageCount` covers only the fleet rows; when the supplied canary is also in the selected scope, it is excluded from that count. No Bot API call or queue write occurs during dry-run. Successful dry-runs and HTML preflight failures both write admin audit entries.

**Live response (`dryRun: false`)**

```json
{
  "enqueued": 1247,
  "canary": {
    "chatId": "123456789",
    "chunksSent": 1
  },
  "deliveryEstimate": {
    "projectedPendingMessages": 1247,
    "estimatedDrainTimeSec": 600,
    "minimumTtlReserveSec": 900,
    "remainingTtlReserveSec": 2100,
    "hasMaterialTtlReserve": true
  }
}
```

Before enqueue, live execution requires the admin-delivery pause to be inactive and the bot-wide transport circuit to be closed, claims one admin transport permit, and sends the exact chunks to the private canary. A rejected, uncertain, or incomplete canary prevents all fleet enqueue. `enqueued` reports the number of non-canary chat/chunk messages submitted to the pending queue (`fleetChatCount * chunkCount`). Because the queue uses dedupe upserts, replaying the same broadcast before drain can update existing rows instead of inserting new rows. The dispatch cron drains the queue on its normal cadence.

**Error responses:** `400` for invalid JSON, empty or over-16,000-character `messageHtml`, unknown `scope`, non-boolean `dryRun`, malformed `canaryChatId`, or a live request without `canaryChatId`. `422` for malformed/unsupported Telegram HTML or a canary rejected for formatting/bad-request reasons. `409` when the projected fleet backlog cannot retain the hard 15-minute reserve inside the 45-minute admin TTL, or when admin delivery is operator-paused/the transport circuit is unavailable. `503` covers a transport permit denial or non-formatting canary failure, and `500` means the live Worker has no bot token. Canary failures report `fleetEnqueued: 0`.
