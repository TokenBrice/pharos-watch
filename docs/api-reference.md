# Pharos API Reference

The Pharos API is a REST API served by a Cloudflare Worker backed by a D1 database. It powers the [pharos.watch](https://pharos.watch) stablecoin analytics dashboard through a split website-data lane plus an external integration API. On `https://api.pharos.watch`, all public routes are API-key protected unless this reference explicitly marks them as exempt.

**Base URL:** `https://api.pharos.watch`

Unless noted otherwise, responses are `Content-Type: application/json`. Exceptions: `GET /api/og/*` returns `image/png` for known image routes, and `POST /api/telegram-webhook` returns a plain-text `ok` body. CORS headers are added to every response, but `Access-Control-Allow-Origin` is restricted by the Worker `CORS_ORIGIN` allowlist (production repo config: `https://pharos.watch,https://ops.pharos.watch`). When the request `Origin` matches an allowlisted entry, the Worker echoes that origin and sets `Vary: Origin`; when a request includes a foreign `Origin`, the worker omits `Access-Control-Allow-Origin`, and `OPTIONS` preflights from foreign origins receive `403`. Requests without an `Origin` header keep the existing first-allowlisted-origin fallback. Non-exempt `/api/*` requests on `api.pharos.watch` require a valid `X-API-Key`; missing or invalid keys return `401 Unauthorized`. Per-key rate-limit overages return `429`, and cold auth/limiter dependency failures can still return `503`.

> **Agent navigation** — Grep the heading you need: Surface Split · Public API Auth · Stablecoin IDs · Response Headers · Response Body Freshness (`_meta`) · Cache-Control Profiles · Polling Guidance · Rate Limits · Error Response Conventions · Method Gating Policy · Public Endpoints (generated from OpenAPI and the endpoint registry) · Pages Function endpoints. For one route, grep its path (for example, `/api/stablecoins`). Operator routes live in the internal [admin reference](./api-reference-admin.md).

## Surface Split

The runtime now uses three HTTP lanes:

- `https://api.pharos.watch` is the external integration API. Protected public routes require `X-API-Key`.
- `https://site-api.pharos.watch` is the website-internal Worker host. It accepts allowlisted `GET` reads and the internal `POST /api/telegram-adoption` mutation with `X-Pharos-Site-Proxy-Secret`.
- `/_site-data/*` is the same-origin Pages Functions proxy used by browsers on `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev`.

Static dataset exports are served from the public website, not from the Worker API, and do not require `X-API-Key`. The Stablecoin Cemetery export is available as JSON at `https://pharos.watch/datasets/stablecoin-cemetery.json` and CSV at `https://pharos.watch/datasets/stablecoin-cemetery.csv`.

The same static lane also serves the rolling public dataset mirrors at `https://pharos.watch/datasets/<topic>/latest.{csv,json,ndjson}`, plus one dated artifact per refresh run at `https://pharos.watch/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}`. Topic identifiers are a never-break external contract and are enumerated by `PUBLIC_DATASET_TOPICS` in `shared/lib/api-endpoints/datasets.ts`; `scripts/maintenance/generate-public-datasets.ts` writes the dated files, prunes copies older than 90 days, and maintains a generated `public/_redirects` block. Each `latest` URL is a Cloudflare Pages `200` rewrite to its current same-extension dated artifact, preserving the direct-fetch URL and response bytes without committing a duplicate file. A date with no refresh run has no file and `latest` can be older than today; consumers should treat a missing dated URL as "no run", not as "no data". `https://pharos.watch/sheets/<topic>.csv` also rewrites directly to the dated CSV rather than chaining through `latest.csv`, because Pages does not follow chained redirects. These URLs are unauthenticated, are advertised to crawlers as JSON-LD `DataDownload` targets (`src/lib/analytics-dataset-json-ld.ts`), and are served with the extension-compatible content types, `Access-Control-Allow-Origin: *`, and cache policies from `public/_headers`.

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

Revoking a self-serve key also writes a durable tombstone into the D1 table `api_key_self_serve_revocations` (`worker/src/api/api-key-requests/admin.ts`), and every self-serve authentication consults it (`worker/src/lib/api-key-auth.ts`). The tombstone is keyed on the key prefix, not on the `api_keys` row id, so it survives deactivating, rotating, or deleting that row: a revoked prefix stays refused until the tombstone itself is removed, and re-issuing a key against the same prefix does not lift the block. Because that check is only answerable from D1, self-serve keys are never served from the isolate-local verified-key cache and fail closed whenever the D1 lookup is unavailable.

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
| slow               | `public, s-maxage=3600, max-age=300`                           | supply-history, dex-liquidity-history, bluechip-ratings, yield-history, safety-score-history, non-usd-share, safety-score-history-v2                                                                                                                                                                                                                                                                |
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

**Rule:** Cache-passthrough handlers return **503** when data hasn't been populated yet or when the stored cache payload is malformed and rejected at read time. Query handlers that find no matching rows return **200** with empty results (e.g., `{ events: [], total: 0 }`). When `MAINTENANCE_MODE` is set to `"true"`, all non-`OPTIONS` requests immediately return `503` with `{ "error": "maintenance", "message": "..." }` — used during DB migrations. `OPTIONS` CORS preflights are handled before the maintenance gate. The gate is on the Worker `fetch` path only (`worker/src/handlers/http/gates.ts`, called from `worker/src/handlers/http/request-dispatch.ts`); the `scheduled()` entrypoint in `worker/src/index.ts` never consults it, so cron jobs keep executing and keep writing D1 while maintenance mode is armed. Arming it sheds HTTP traffic, not scheduled writes: a migration or D1-pressure incident that needs quiet writes must disable the affected cron triggers as a separate step.

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

## Public Endpoints

Unless an endpoint section explicitly says `Authentication: exempt`, routes in this section require `X-API-Key` when called on `https://api.pharos.watch`. OpenAPI schemas are published at [`/openapi.json`](https://pharos.watch/openapi.json); endpoint auth and cache flags come from `shared/lib/api-endpoints/definitions.ts`.

<!-- GENERATED-START: public-endpoints -->
<!-- Generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json and shared/lib/api-endpoints/definitions.ts. -->
<!-- Curated route notes are authored in the generator and keyed by operationId. Do not edit this block by hand. -->

### Public Endpoints Quick Reference

Generated from `public/openapi.json` (`Pharos API` v1.0.0). Total OpenAPI operations: **39**.

| Method | Path | Summary | Tags | Auth | Parameters | Status codes |
| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |
| GET | `/api/events` | Tape events | Risk | `X-API-Key` required | `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoins` | List stablecoins | Stablecoins | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin/{stablecoinId}` | Stablecoin detail | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-summary/{stablecoinId}` | Stablecoin summary | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/non-usd-share` | Non-USD share | Market Structure, History | `X-API-Key` required | `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/chains` | Chains | Chains | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-reserves/{stablecoinId}` | Stablecoin reserves | Stablecoins, Reserves | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-charts` | Stablecoin charts | Stablecoins, History | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/blacklist` | Blacklist events | Blacklist | `X-API-Key` required | `stablecoin` (query, optional, string); `chain` (query, optional, string); `chainId` (query, optional, string); `eventType` (query, optional, string); `q` (query, optional, string); `sortBy` (query, optional, string); `sortDirection` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/blacklist-summary` | Blacklist summary | Blacklist | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-events` | Depeg incidents | Peg Monitoring | `X-API-Key` required | `stablecoin` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `active` (query, optional, boolean); `includeTotal` (query, optional, boolean); `includePending` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver` | Depeg Duration Resolver | Risk, Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver-review` | Depeg Duration Resolver Reviewer | Risk, Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/peg-summary` | Peg summary | Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/usds-status` | USDS freeze status | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/bluechip-ratings` | Bluechip ratings | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity` | DEX liquidity | Liquidity | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity-history` | DEX liquidity history | Liquidity, History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/supply-history` | Supply history | History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/daily-digest` | Daily digest | Digest | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/digest-archive` | Digest archive | Digest | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/digest-snapshot` | Digest snapshot | Digest | `X-API-Key` required | `date` (query, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/index` | Public snapshot index | Digest | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/{date}.json` | Public snapshot for a single day | Digest, History | `X-API-Key` required | `date` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshot/{date}/stablecoin/{stablecoinId}` | Public snapshot projection for a single coin | Digest, Stablecoins, History | `X-API-Key` required | `date` (path, required, string); `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/health` | Health check | Health | exempt | — | 200, 400, 503 |
| GET | `/api/public-status-history` | Public status history | Status | `X-API-Key` required | `limit` (query, optional, integer); `window` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/telegram-pulse` | Telegram pulse | Status | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stability-index` | Pharos Stability Index | Risk | `X-API-Key` required | `detail` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/report-cards/v9` | Safety Score V9 report cards | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/redemption-backstops` | Redemption backstops | Risk, Reserves | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/safety-score-history` | Safety score history | Risk, History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/safety-score-history-v2` | Safety score history (identity-aware) | Risk, History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/yield-rankings` | Yield rankings | Yield | `X-API-Key` required | `projection` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/yield-adapter-manifest` | Yield adapter manifest | Yield | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/yield-history` | Yield history | Yield, History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer); `mode` (query, optional, string); `sourceKey` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/mint-burn-flows` | Mint and burn flows | Flows | `X-API-Key` required | `stablecoin` (query, optional, string); `hours` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/mint-burn-events` | Mint and burn events | Flows | `X-API-Key` required | `stablecoin` (query, required, string); `direction` (query, optional, string); `chain` (query, optional, string); `burnType` (query, optional, string); `scope` (query, optional, string); `minAmount` (query, optional, number); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/stress-signals` | Stress signals | Risk, Peg Monitoring | `X-API-Key` required | `stablecoin` (query, optional, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |

### `GET /api/events`

Searches the normalized event tape; cursor pagination is preferred for long result sets.

- **Operation ID:** `events`
- **Path:** `/api/events`
- **Parameters:** `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`TapeEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/TapeEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoins`

Returns the current stablecoin catalogue, prices, supply, chain breakdowns, and FX context.

- **Operation ID:** `stablecoins`
- **Path:** `/api/stablecoins`
- **Parameters:** None.
- **Success response schema:** [`StablecoinListResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinListResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Compatibility response fields**

| Field | Type | Description |
| ----- | ---- | ----------- |
| `geckoId` | `string \| null` | CoinGecko ID (normalized output key; upstream DefiLlama uses `gecko_id`) |

### `GET /api/stablecoin/:id`

Returns the full current and historical detail payload for one canonical Pharos stablecoin ID.

- **Operation ID:** `stablecoinStablecoinId`
- **Path:** `/api/stablecoin/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinDetailResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinDetailResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoin-summary/:id`

Returns the compact stablecoin projection used by lightweight consumers.

- **Operation ID:** `stablecoinSummaryStablecoinId`
- **Path:** `/api/stablecoin-summary/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/non-usd-share`

Returns the current and historical market share of tracked non-USD peg groups.

- **Operation ID:** `nonUsdShare`
- **Path:** `/api/non-usd-share`
- **Parameters:** `days` (query, optional, integer)
- **Success response schema:** [`NonUsdShareResponse`](https://pharos.watch/openapi.json#/components/schemas/NonUsdShareResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/chains`

Returns stablecoin distribution and health aggregates grouped by chain.

- **Operation ID:** `chains`
- **Path:** `/api/chains`
- **Parameters:** None.
- **Success response schema:** [`ChainsResponse`](https://pharos.watch/openapi.json#/components/schemas/ChainsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Source-backed chain methodology example**

```json
{
  "healthMethodologyVersion": "1.5"
}
```

### `GET /api/stablecoin-reserves/:id`

Returns reviewed reserve composition and provenance for one stablecoin.

- **Operation ID:** `stablecoinReservesStablecoinId`
- **Path:** `/api/stablecoin-reserves/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinReservesResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinReservesResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoin-charts`

Returns the shared chart series consumed by stablecoin overview surfaces.

- **Operation ID:** `stablecoinCharts`
- **Path:** `/api/stablecoin-charts`
- **Parameters:** None.
- **Success response schema:** [`StablecoinChartResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinChartResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/blacklist`

Returns normalized issuer freeze, unfreeze, blacklist, and destruction events.

- **Operation ID:** `blacklist`
- **Path:** `/api/blacklist`
- **Parameters:** `stablecoin` (query, optional, string); `chain` (query, optional, string); `chainId` (query, optional, string); `eventType` (query, optional, string); `q` (query, optional, string); `sortBy` (query, optional, string); `sortDirection` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`BlacklistResponse`](https://pharos.watch/openapi.json#/components/schemas/BlacklistResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "4.0",
  "currentVersionLabel": "v4.0"
}
```

### `GET /api/blacklist-summary`

Returns aggregate blacklist counts and exposure totals.

- **Operation ID:** `blacklistSummary`
- **Path:** `/api/blacklist-summary`
- **Parameters:** None.
- **Success response schema:** [`BlacklistSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/BlacklistSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/depeg-events`

Returns detected depeg incidents with filters for asset, state, and review status.

- **Operation ID:** `depegEvents`
- **Path:** `/api/depeg-events`
- **Parameters:** `stablecoin` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `active` (query, optional, boolean); `includeTotal` (query, optional, boolean); `includePending` (query, optional, boolean)
- **Success response schema:** [`DepegEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/DepegEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "6.21"
}
```

### `GET /api/depeg-resolver`

Returns machine-resolved depeg-duration evidence used by risk surfaces.

- **Operation ID:** `depegResolver`
- **Path:** `/api/depeg-resolver`
- **Parameters:** None.
- **Success response schema:** [`DdrResponse`](https://pharos.watch/openapi.json#/components/schemas/DdrResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/depeg-resolver-review`

Returns the reviewer-oriented projection of depeg-duration decisions.

- **Operation ID:** `depegResolverReview`
- **Path:** `/api/depeg-resolver-review`
- **Parameters:** None.
- **Success response schema:** [`DdrrResponse`](https://pharos.watch/openapi.json#/components/schemas/DdrrResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/peg-summary`

Returns the current cross-market peg-monitoring summary.

- **Operation ID:** `pegSummary`
- **Path:** `/api/peg-summary`
- **Parameters:** None.
- **Success response schema:** [`PegSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/PegSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "6.21"
}
```

### `GET /api/usds-status`

Returns the current USDS freeze and operational-risk status.

- **Operation ID:** `usdsStatus`
- **Path:** `/api/usds-status`
- **Parameters:** None.
- **Success response schema:** [`UsdsStatusResponse`](https://pharos.watch/openapi.json#/components/schemas/UsdsStatusResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/bluechip-ratings`

Returns imported Bluechip ratings joined to Pharos stablecoin identities.

- **Operation ID:** `bluechipRatings`
- **Path:** `/api/bluechip-ratings`
- **Parameters:** None.
- **Success response schema:** [`BluechipRatingsResponse`](https://pharos.watch/openapi.json#/components/schemas/BluechipRatingsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dex-liquidity`

Returns current DEX liquidity scores and pool-level evidence.

- **Operation ID:** `dexLiquidity`
- **Path:** `/api/dex-liquidity`
- **Parameters:** None.
- **Success response schema:** [`DexLiquidityResponse`](https://pharos.watch/openapi.json#/components/schemas/DexLiquidityResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dex-liquidity-history`

Returns bounded historical DEX liquidity observations for one stablecoin.

- **Operation ID:** `dexLiquidityHistory`
- **Path:** `/api/dex-liquidity-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`DexLiquidityHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/DexLiquidityHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/supply-history`

Returns bounded circulating-supply history for one stablecoin.

- **Operation ID:** `supplyHistory`
- **Path:** `/api/supply-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`SupplyHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/SupplyHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/daily-digest`

Returns the latest generated market digest.

- **Operation ID:** `dailyDigest`
- **Path:** `/api/daily-digest`
- **Parameters:** None.
- **Success response schema:** [`DailyDigestResponse`](https://pharos.watch/openapi.json#/components/schemas/DailyDigestResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/digest-archive`

Returns the index of available dated digest snapshots.

- **Operation ID:** `digestArchive`
- **Path:** `/api/digest-archive`
- **Parameters:** None.
- **Success response schema:** [`DigestArchiveResponse`](https://pharos.watch/openapi.json#/components/schemas/DigestArchiveResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/digest-snapshot`

Returns one digest snapshot selected by date.

- **Operation ID:** `digestSnapshot`
- **Path:** `/api/digest-snapshot`
- **Parameters:** `date` (query, required, string)
- **Success response schema:** [`DigestSnapshotResponse`](https://pharos.watch/openapi.json#/components/schemas/DigestSnapshotResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshots/index`

Returns the dates available in the public daily snapshot archive.

- **Operation ID:** `snapshotsIndex`
- **Path:** `/api/snapshots/index`
- **Parameters:** None.
- **Success response schema:** [`SnapshotsIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/SnapshotsIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshots/:date.json`

Returns the full public snapshot captured for one date.

- **Operation ID:** `snapshotsDateJson`
- **Path:** `/api/snapshots/{date}.json`
- **Parameters:** `date` (path, required, string)
- **Success response schema:** [`JsonValue`](https://pharos.watch/openapi.json#/components/schemas/JsonValue)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshot/:date/stablecoin/:id`

Returns one stablecoin projection from a dated public snapshot.

- **Operation ID:** `snapshotDateStablecoinStablecoinId`
- **Path:** `/api/snapshot/{date}/stablecoin/{stablecoinId}`
- **Parameters:** `date` (path, required, string); `stablecoinId` (path, required, string)
- **Success response schema:** [`SnapshotCoinResponse`](https://pharos.watch/openapi.json#/components/schemas/SnapshotCoinResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/health`

Provides the unauthenticated availability canary; it is not the operator status dashboard.

- **Operation ID:** `health`
- **Path:** `/api/health`
- **Parameters:** None.
- **Success response schema:** [`HealthResponse`](https://pharos.watch/openapi.json#/components/schemas/HealthResponse)
- **Policy:** authentication exempt; shared endpoint caching allowed (`cacheBypass: false`).

**Source-backed health freshness example**

```json
{
  "caches": {
    "stablecoins": {
      "maxAge": 600,
      "endpointMaxAge": 600,
      "producerIntervalSec": 900
    },
    "stablecoin-charts": {
      "maxAge": 3600,
      "endpointMaxAge": 3600,
      "producerIntervalSec": 3600
    },
    "usds-status": {
      "maxAge": 86400,
      "endpointMaxAge": 86400,
      "producerIntervalSec": 86400
    },
    "fx-rates": {
      "maxAge": 1800,
      "endpointMaxAge": 1800,
      "producerIntervalSec": 1800
    },
    "bluechip-ratings": {
      "maxAge": 86400,
      "endpointMaxAge": 43200,
      "producerIntervalSec": 86400
    },
    "dex-liquidity": {
      "maxAge": 43200,
      "endpointMaxAge": 14400,
      "producerIntervalSec": 7200
    },
    "yield-data": {
      "maxAge": 3600,
      "endpointMaxAge": 3600,
      "producerIntervalSec": 3600
    },
    "dews": {
      "maxAge": 1800,
      "endpointMaxAge": 1800,
      "producerIntervalSec": 1800
    }
  }
}
```

### `GET /api/public-status-history`

Returns a bounded, public-safe status timeline.

- **Operation ID:** `publicStatusHistory`
- **Path:** `/api/public-status-history`
- **Parameters:** `limit` (query, optional, integer); `window` (query, optional, string)
- **Success response schema:** [`PublicStatusHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/PublicStatusHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/telegram-pulse`

Returns public Telegram adoption and delivery health aggregates.

- **Operation ID:** `telegramPulse`
- **Path:** `/api/telegram-pulse`
- **Parameters:** None.
- **Success response schema:** [`TelegramPulseResponse`](https://pharos.watch/openapi.json#/components/schemas/TelegramPulseResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stability-index`

Returns the current Pharos Stability Index and optional component detail.

- **Operation ID:** `stabilityIndex`
- **Path:** `/api/stability-index`
- **Parameters:** `detail` (query, optional, boolean)
- **Success response schema:** [`StabilityIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/StabilityIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "3.6",
  "methodologyVersion": "3.6"
}
```

### `GET /api/og/*`

Dynamic social-card image routes are served by the Worker and intentionally omitted from OpenAPI.

- **Path:** `/api/og/*`
- **Parameters:** Route-specific path segments select the supported image family.
- **Success response schema:** PNG image bytes; not represented by a JSON component schema.
- **Policy:** API-key authentication exempt; route-specific response caching.

### `GET /api/report-cards/v9`

Returns the currently published Safety Score V9 report-card set.

- **Operation ID:** `reportCardsV9`
- **Path:** `/api/report-cards/v9`
- **Parameters:** None.
- **Success response schema:** [`ReportCardsV9Response`](https://pharos.watch/openapi.json#/components/schemas/ReportCardsV9Response)
- **Policy:** authentication `X-API-Key` required; bypass shared endpoint caching (`cacheBypass: true`).

**Current methodology example**

```json
{
  "version": "9.46",
  "methodologyVersion": "9.46"
}
```

### `GET /api/redemption-backstops`

Returns reviewed redemption paths and backstop evidence.

- **Operation ID:** `redemptionBackstops`
- **Path:** `/api/redemption-backstops`
- **Parameters:** None.
- **Success response schema:** [`RedemptionBackstopsResponse`](https://pharos.watch/openapi.json#/components/schemas/RedemptionBackstopsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/safety-score-history`

Returns legacy bounded Safety Score history for one stablecoin.

- **Operation ID:** `safetyScoreHistory`
- **Path:** `/api/safety-score-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`SafetyScoreHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/SafetyScoreHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/safety-score-history-v2`

Returns identity-aware bounded Safety Score history for one stablecoin.

- **Operation ID:** `safetyScoreHistoryV2`
- **Path:** `/api/safety-score-history-v2`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`SafetyScoreHistoryV2Response`](https://pharos.watch/openapi.json#/components/schemas/SafetyScoreHistoryV2Response)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/yield-rankings`

Returns current Yield Intelligence rankings and risk-adjusted fields.

- **Operation ID:** `yieldRankings`
- **Path:** `/api/yield-rankings`
- **Parameters:** `projection` (query, optional, string)
- **Success response schema:** [`YieldRankingsResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldRankingsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "8.42",
  "methodologyVersion": "9.46"
}
```

### `GET /api/yield-adapter-manifest`

Returns the public adapter-coverage and source-status manifest.

- **Operation ID:** `yieldAdapterManifest`
- **Path:** `/api/yield-adapter-manifest`
- **Parameters:** None.
- **Success response schema:** [`YieldAdapterManifestResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldAdapterManifestResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "methodologyVersion": "v8.42"
}
```

### `GET /api/yield-history`

Returns bounded yield history for one stablecoin and optional source projection.

- **Operation ID:** `yieldHistory`
- **Path:** `/api/yield-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer); `mode` (query, optional, string); `sourceKey` (query, optional, string)
- **Success response schema:** [`YieldHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "8.42",
  "methodologyVersion": "8.42"
}
```

### `GET /api/mint-burn-flows`

Returns aggregate mint and burn pressure over the requested window.

- **Operation ID:** `mintBurnFlows`
- **Path:** `/api/mint-burn-flows`
- **Parameters:** `stablecoin` (query, optional, string); `hours` (query, optional, integer)
- **Success response schema:** [`MintBurnFlowsResponse`](https://pharos.watch/openapi.json#/components/schemas/MintBurnFlowsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/mint-burn-events`

Returns the normalized issuance event stream with cursor or offset pagination.

- **Operation ID:** `mintBurnEvents`
- **Path:** `/api/mint-burn-events`
- **Parameters:** `stablecoin` (query, required, string); `direction` (query, optional, string); `chain` (query, optional, string); `burnType` (query, optional, string); `scope` (query, optional, string); `minAmount` (query, optional, number); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`MintBurnEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/MintBurnEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stress-signals`

Returns the bounded stress-signal history used by early-warning surfaces.

- **Operation ID:** `stressSignals`
- **Path:** `/api/stress-signals`
- **Parameters:** `stablecoin` (query, optional, string); `days` (query, optional, integer)
- **Success response schema:** [`StressSignalsResponse`](https://pharos.watch/openapi.json#/components/schemas/StressSignalsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

Freshness threshold: 1800 s.

**Current methodology example**

```json
{
  "currentVersion": "6.21",
  "methodologyVersion": "6.21"
}
```

### `POST /api/api-key-requests`

Starts the email-verified public API access flow.

- **Registry key:** `api-key-requests`
- **Path:** `/api/api-key-requests`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `POST /api/api-key-requests/verify`

Completes a public API key request with the emailed verification token.

- **Registry key:** `api-key-request-verify`
- **Path:** `/api/api-key-requests/verify`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `POST /api/feedback`

Accepts the bounded feedback form payload used by the website.

- **Registry key:** `feedback`
- **Path:** `/api/feedback`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `POST /api/telegram-mini-app/session`

Creates or refreshes a Telegram Mini App session after Telegram init-data validation.

- **Registry key:** `telegram-mini-app-session`
- **Path:** `/api/telegram-mini-app/session`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `POST /api/telegram-mini-app/mutate`

Applies an authenticated Telegram Mini App preference mutation.

- **Registry key:** `telegram-mini-app-mutation`
- **Path:** `/api/telegram-mini-app/mutate`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `POST /api/telegram-webhook`

Receives Telegram Bot API updates; callers outside Telegram should not use it.

- **Registry key:** `telegram-webhook`
- **Path:** `/api/telegram-webhook`
- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.
- **Success response schema:** Not published in `openapi.json`.
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

<!-- GENERATED-END: public-endpoints -->

## Pages Function endpoints

These website-host routes are outside the public Worker API and OpenAPI catalogue. They enforce their own same-origin, host, and storage policies; external integrations should use the Worker endpoints above.

### `GET /selector-snapshot/:sid`

Reads a server-verified Stablecoin Picker share artifact by its 32-character identifier. Same-origin checks, trusted KV metadata, canonical-content validation, and retention extension must all succeed before a verified artifact is returned.

### `POST /pharoswatchbot-adoption`

Forwards bounded, same-origin Telegram CTA adoption events to the internal Worker route. It stores aggregate counters only and is not a general integration endpoint.

### `POST /selector-snapshot`

Recomputes a Picker result from canonical source data and stores the share artifact under a server-computed identifier. The route is same-origin gated and rejects oversized or invalid inputs.
