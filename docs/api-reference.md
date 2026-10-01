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

The same static lane also serves the rolling public dataset mirrors at `https://pharos.watch/datasets/<topic>/latest.{csv,json,ndjson}`, plus one dated artifact per refresh run at `https://pharos.watch/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}`. Topic identifiers are a never-break external contract and are enumerated by `PUBLIC_DATASET_TOPICS` in `shared/lib/api-endpoints/datasets.ts`; `scripts/maintenance/generate-public-datasets.ts` writes the dated files and prunes copies older than 90 days. Current-date generation maintains the generated `public/_redirects` block and frontend current-dataset module. Historical generation through `PUBLIC_DATASETS_DATE=<past>` writes only dated artifacts unless the operator explicitly passes `--repoint-current`, preventing a backfill from moving the public `latest` aliases backward. Each `latest` URL is a Cloudflare Pages `200` rewrite to its current same-extension dated artifact, preserving the direct-fetch URL and response bytes without committing a duplicate file. The artifact check rejects aliases more than two UTC dates behind the daily producer cadence, and the production frontend build rejects the same stale `scores-latest` mirror. A date with no refresh run has no file; consumers should treat a missing dated URL as "no run", not as "no data". `https://pharos.watch/sheets/<topic>.csv` also rewrites directly to the dated CSV rather than chaining through `latest.csv`, because Pages does not follow chained redirects. These URLs are unauthenticated, are advertised to crawlers as JSON-LD `DataDownload` targets (`src/lib/analytics-dataset-json-ld.ts`), and are served with the extension-compatible content types, `Access-Control-Allow-Origin: *`, and cache policies from `public/_headers`.

Machine-readable integration artifacts are also served from the public website for onboarding. The OpenAPI endpoint catalogue is available at `https://pharos.watch/openapi.json`, and Postman artifacts are available at `https://pharos.watch/postman/pharos-api.postman_collection.json` plus `https://pharos.watch/postman/pharos-api.postman_environment.json`. Import both Postman files, then replace the environment `apiKey` placeholder with a real `X-API-Key`. The generated OpenAPI artifact includes named schemas for the richer Yield Intelligence ranking and history payloads, and the Postman collection includes both best-source and source-key yield-history examples. These are public integration/read onboarding artifacts, not a complete dump of every no-key route; they intentionally exclude Cloudflare-Access-gated admin routes, self-serve key issuance POST endpoints, feedback submission, Telegram webhook ingestion, Telegram Mini App endpoints, and dynamic OG image routes. Request keys through `https://pharos.watch/api/`.

Browser consumers should use same-origin `/_site-data/*` via the frontend helpers in `src/lib/api.ts`. In production, that Pages proxy targets `https://site-api.pharos.watch` through `SITE_API_ORIGIN`. Direct integrations and CI smoke should target `https://api.pharos.watch` and send `X-API-Key` for protected public reads, including `/api/telegram-pulse`; production Pages build-input syncs instead read allowlisted `GET` endpoints through `https://stablecoin-dashboard.pages.dev/_site-data/*` with an allowed site caller header. Each sync command rejects missing or invalid input. A Pages release may retain one failed producer's committed snapshot, but it fails before build when all three producers fail or when a failed public-dataset refresh cannot be rolled back cleanly.

Production Pages does not proxy public `/api/*` POST requests. `https://pharos.watch/api/` is the API access page: it presents the free grades feed, the supporter-key claim, and the partner-key contact. Its browser POST is the supporter-key claim, which goes cross-origin to `https://api.pharos.watch/api/donor-key-claims` with a normal CORS preflight for the JSON `POST` request.

The direct Worker cache profiles below describe responses from `api.pharos.watch` / `site-api.pharos.watch`. Pages `/_site-data/*` forwards the upstream cache policy, `Age`, and `Date` without adding a second Cache API lifetime, so it cannot make a nearly expired Worker response fresh again.

## Public API Auth

Unless a route is explicitly called out below as exempt, requests to `https://api.pharos.watch` must send:

- header: `X-API-Key: ph_live_<16 hex prefix>_<32 char base64url secret>`
- example shape: `ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF`

Public, non-admin routes on `https://api.pharos.watch` that do not require `X-API-Key` are limited to:

- `GET /api/safety-grades` (the free lane: one Safety Score and grade per tracked stablecoin)
- `GET /api/health`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/donor-key-claims` (the supporter-key claim: a Sign-In-With-Ethereum signature from an eligible donor wallet, rate-limited per IP before the body is read)
- `POST /api/telegram-webhook`
- `POST /api/telegram-mini-app/session`
- `POST /api/telegram-mini-app/mutate`

`POST /api/telegram-webhook` is externally reachable but not anonymous: it requires `X-Telegram-Bot-Api-Secret-Token` instead of `X-API-Key`.

`POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate` are also externally reachable but not anonymous. They require Telegram Mini App `initData` signed for `@PharosWatchBot`; the worker validates the HMAC, `auth_date`, and user payload before any D1-backed state write. These endpoints are denied on the website-internal site-data lane and are intended only for the Mini App at `https://pharos.watch/pharoswatchbot/app/`.

Admin/operator routes are also outside the public API-key gate, but they remain Cloudflare-Access-gated and are supported through `ops-api.pharos.watch` or the `ops.pharos.watch/api/admin/*` Pages proxy. The public API host rejects registered admin paths and configured admin-like root families before API-key auth, so a public API key cannot be used to reach registered admin routes or malformed children of configured roots such as `/api/api-keys*` on `api.pharos.watch`.

Self-serve key issuance is retired: the lane was removed on 2026-09-29, so `POST /api/api-key-requests` and `POST /api/api-key-requests/verify` are unregistered and respond like any unknown API path on the public host (`401` without a valid `X-API-Key`, `404` with one), while existing `tier="self-serve"` keys keep authenticating until they drain through their `60`-day expiry (about 2026-11-06). The lane's D1 tables (`api_key_requests`, `api_key_request_rate_limit_v2`, `api_key_self_serve_email_claims`, `api_key_self_serve_issuance_limits`) are left in place and dropped in a separate follow-up rollout after this Worker is live; the rate-limit table's daily prune continues until then, and the operator may delete the lane's now-unused Worker secrets with Wrangler (names only, never values): `API_KEY_SELF_SERVE_IP_SALT`, `API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER`, `API_KEY_SELF_SERVE_REQUEST_PEPPER`, `API_KEY_SELF_SERVE_EMAIL_FROM`, `API_KEY_SELF_SERVE_EMAIL_REPLY_TO`, `API_KEY_SELF_SERVE_PUBLIC_BASE_URL`, `RESEND_API_KEY`. Keyed access is a supporter key, claimed by donors on the access page at `https://pharos.watch/api/` through `POST /api/donor-key-claims`, or an operator-issued partner key (internal tier `standard`) requested through the private channel on that page: Telegram DM to `@TokenBrice`, with X DM to `@PharosWatch` as secondary, and a human reply within `PARTNER_KEY_REPLY_BUSINESS_DAYS` (`2`) business days. The reply window and the freshness stamped on every response are service commitments, not a contractual SLA.

`POST /api/donor-key-claims` issues the supporter key and is exempt from `X-API-Key`. An externally-owned wallet signs an EIP-4361 message with `personal_sign` for domain `pharos.watch` and URI `https://pharos.watch/api/`, valid for 5 minutes, then posts `{ "message", "signature" }`. Eligibility requires at least `$10` in receipt-date USD from qualifying-stablecoin donations whose current grades are A+, A, A-, B+, B, or B-. Qualifying stablecoins are the reviewed `(chain, token contract)` pairs in `DONOR_KEY_QUALIFYING_STABLECOINS` (`shared/lib/funding/donor-eligibility.ts`, 15 coins; the source file wins): each coin counts only on its reviewed contract deployments, so bridged or same-ticker tokens never qualify, and EURC is valued at the ECB EUR/USD reference rate for the receipt date, never 1:1. The threshold is inclusive with floating-point tolerance, addresses are matched case-insensitively, founder rows count, and pool payouts do not. The donor list is updated every Sunday. Smart-contract wallets, Giveth streams, and exchange withdrawals cannot claim.

All claim responses use `Cache-Control: no-store`. `201` returns the plaintext token once, with tier `donor`, `10` requests per minute, and no expiry. Every failure returns `{ "error": "message", "reason": "code" }`; codes are defined once by `DONOR_KEY_CLAIM_FAILURE_REASONS` in `shared/types/api-keys.ts`:

| Status | Reasons |
| --- | --- |
| 400 | `body_invalid`, `siwe_invalid`, `signature_invalid` |
| 413 | `body_invalid` (body exceeds 4096 bytes) |
| 403 | `claims_closed`, `claim_revoked`, `ineligible` |
| 409 | `claim_exists`, `claim_orphaned` |
| 429 | `rate_limited` (`Retry-After: 60`) |
| 503 | `rate_limiter_missing`, `rate_limit_unavailable`, `donations_ledger_invalid`, `safety_scores_unavailable`, `grade_unavailable`, `pepper_missing`, `issue_failed` |

The `403 ineligible` body additionally returns `ledgerUpdatedAt` (Unix seconds), `qualifyingUsd` (number), and `countedAssets` (string array of counted stablecoin labels). A missing coin grade is unavailable, not a zero observation: if counted donations plus donations with unavailable grades could reach the threshold, the route returns `503 grade_unavailable` with `Retry-After: 60` instead of `403`. Published grades outside A/B do not count. Missing or held canonical accepted V9 publications return `503 safety_scores_unavailable`.

One key is issued per wallet, atomically with its `api_key_donor_claims` row. Existing claim lookup precedes grading; later grade changes do not alter already-issued keys. Re-signing never rotates a key. For a lost key or record removal, message [@TokenBrice on Telegram](https://t.me/TokenBrice), with [@PharosWatch on X](https://x.com/PharosWatch) as secondary. An operator verifies the donating wallet before rotating a lost key. Claim outcome logs contain codes only, not signed messages, signatures, or wallet addresses.

Claims are enabled by `DONOR_KEY_CLAIMS_OPEN` in `shared/lib/public-api-contract.ts`. The `DONOR_KEY_CLAIM_RATE_LIMIT` binding admits `10` attempts per `60` seconds per client IP before reading the body. Donor keys always use D1-backed auth and quotas, not the isolate fast-cache path. Migration `0238_api_key_donor_claims.sql` must precede deployment; `docs/api-page.md` owns the live claim, quota, replay, and access-gate acceptance sequence.

The worker stores only the key prefix plus a peppered HMAC of the secret portion. Admin callers create, rotate, and deactivate keys through the operator lane (`ops.pharos.watch` / `ops-api.pharos.watch`); plaintext tokens are returned only once at creation/rotation time.

Self-serve authentication also consults durable revocation tombstones in the D1 table `api_key_self_serve_revocations` (`worker/src/lib/api-key-auth.ts`). The tombstone is keyed on the key prefix, not on the `api_keys` row id, so it survives deactivating, rotating, or deleting that row: a revoked prefix stays refused until the tombstone itself is removed. The writer was the retired self-serve admin route, so no new tombstones are written, but existing ones keep blocking their prefixes while self-serve keys drain. Because that check is only answerable from D1, self-serve keys are never served from the isolate-local verified-key cache and fail closed whenever the D1 lookup is unavailable.

For protected cacheable `GET` routes, the worker keeps a bounded isolate-local verified-key cache and a bounded isolate-local limiter. A recently verified standard key can use that local path for hot edge-cache hits, and can continue to read cached routes during a brief D1 auth/limiter outage. Donor, self-serve, unknown, stale-cache, or not-yet-verified keys still fail closed.

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
| `X-Data-Age` | Seconds elapsed since the authoritative producer observation; `unavailable` when that clock cannot be established |
| `Warning`    | Freshness warning (`110`) when cached data is older than the generic freshness runway, plus endpoint-specific advisory warnings (`199`) on a few compute-on-read routes |
| `X-Data-Freshness` | `stale` when retained successful producer history is absent, or `unknown` when its lookup failed |
| `X-Data-Freshness-Reason` | Machine-readable unavailable-authority reason: `producer-history-missing` or `freshness-lookup-failed` |

Generic freshness status is `fresh` through `8x maxAge`, `degraded` through `12x maxAge`, then `stale`. Generic freshness headers emit `Warning` and downgrade `Cache-Control` to `no-store` after `age > 8x maxAge` so edge/browser caches do not keep serving an old payload after the underlying cron data recovers. Some routes also use `Warning` for dependency or quality advisories even when the age is still inside that runway; clients should treat body `_meta.status` as authoritative when it exists.

DEX liquidity keeps its dataset-wide advisory in `Warning` and also emits a nullable `warning` on each coin row. Coin-specific TVL cliffs or pool-count drops from an otherwise successful run apply only to affected coins and are omitted from the `Warning` header and from the `__global__` row entirely; provider failures, near-guard proximity, and unscoped findings remain global. The advisory comes from the latest liquidity producer outcome, excluding neutral or locked skips. Coin detail consumers use the row advisory while retaining the producer timestamp for independent freshness checks; older responses without the field retain their global warning.

---

## Response Body Freshness (`_meta`)

Endpoints that emit `_meta` into plain-object (non-array) response bodies do so through `createCacheHandler()` or route-specific manual injection, alongside the HTTP freshness headers above. This provides inline freshness metadata for consumers that prefer not to parse response headers.

**Shape:**

```json
{
  "_meta": {
    "updatedAt": 1710500000,
    "ageSeconds": 42,
    "status": "fresh",
    "assessedAt": 1710500042,
    "freshBudgetSec": 4800,
    "degradedBudgetSec": 7200
  }
}
```

| Field        | Type     | Description                                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `updatedAt`  | `number` | Unix epoch seconds when the cron last wrote this data to D1                                 |
| `ageSeconds` | `number` | Nonnegative age of the generation at `assessedAt` |
| `assessedAt` | `number` | Unix seconds at which the verdict was assessed; not a replacement generation clock |
| `freshBudgetSec` | `number` | Inclusive maximum generation age for an age-based `fresh` verdict |
| `degradedBudgetSec` | `number` | Inclusive maximum generation age for an age-based `degraded` verdict; older is `stale` |
| `status` | `string` | `"fresh"`, `"degraded"`, or `"stale"`; generic bands remain 8x/12x the endpoint max age |

Route-specific manual `_meta` injectors can be stricter. `GET /api/chains` uses its 1800-second budget directly (`fresh <= 1x`, `degraded <= 2x`, then `stale`) and switches its response to `no-store` whenever the chain snapshot is not fresh.

Generic, chains, and yield producers publish assessment time and effective budgets, including response-ready cache injection. Readers accept legacy cached metadata without these fields but must treat its assessment/budget as unknown, not infer that it used the current policy. Chains can also be degraded by its named `dependencies.reportCards` verdict even when snapshot age is fresh. Timestamps over the public 60-second future allowance are degraded and not cacheable; this is timestamp validity, not an age-band change.

`GET /api/stress-signals` publishes `assessedAt`, `freshBudgetSec`, `degradedBudgetSec`, and `newestReturnedComputedAt` beside each row's `computedAt` and `ageClassification`. The newest-returned clock is the aggregate comparison basis for `retainedLastValid`; single-coin responses have no peer-generation comparison (`null`). These are row-generation verdicts, not a claim that every source used by DEWS was observed at that time.

Event feeds (`events`, `depeg-events`, `blacklist`, `mint-burn-events`) derive freshness only from a successful producer run, never request time or the newest matching event. An empty filtered page is fresh only with a fresh producer observation, including a successful zero-event run. No successful run in the retained seven-day cron history means stale/no authoritative recent run; a failed lookup means unknown. Both use `Cache-Control: no-store`, `Warning: 199`, and `X-Data-Age: unavailable`, with the reason headers above. `/api/events` also publishes null `updatedAt` / `ageSeconds` and `status: "stale" | "unknown"` plus `reason` in `_meta`; normal observed metadata is unchanged. Safety-score history uses the same producer-authority headers. Blacklist-summary retains the producing snapshot's clock and lookup state, not its materialization/request time.

For uncounted offset pages, `total` is a conservative observed lower bound and `totalExact` is false. A nonempty offset page establishes the offset plus its observed rows (and any lookahead row); an empty page establishes only zero, even at offset 50,000. Cursor continuations report only their observed page/lookahead bound. Blacklist defaults to uncounted pages; use `includeTotal=true` for an exact filtered count.

Yield routes override the generic 8x/12x runway: `GET /api/yield-rankings` (full and summary) and `GET /api/yield-history` use the shared `yield-data` bands: `fresh` through 7,200 seconds (2x the hourly producer interval), `degraded` through 14,400 seconds (4x), then `stale`. Both non-fresh states return HTTP `Warning: 110` and `Cache-Control: no-store`. Their `_meta` includes required `assessedAt` (response-time Unix seconds), `freshBudgetSec`, `degradedBudgetSec`, and nullable `reason` alongside `updatedAt`, `ageSeconds`, and `status`. Non-fresh publication age names `yield-publication-age`. History freshness measures the authoritative publication cutoff, not the last point in a requested historical window; unavailable authority is stale with `publication-cutoff-unavailable`.

**Yield wire contract:** Full and summary rankings and history publish the expanded evidence directly.

- Summary rows expose `benchmarkSelectionMode` and `provenance.sourceMaxAgeSeconds`. Summary `benchmarkIsFallback` describes feed fallback independently of currency-selection policy; readers use explicit selection mode rather than inferring it from the fallback flag.
- Detailed ranking provenance retains nullable `sourceObservedAt` and `sourceAgeSeconds` without dropping the remaining evidence. Unavailable rankings `medianApy` is null. `sourceRisk.rewardShare` is nonnegative with no upper bound, preserving raw ratios above 1 in rankings, alternatives, and history.

Yield source freshness is separate from publication freshness. Unknown observation evidence must not be replaced with publication time or treated as refreshed merely because the snapshot was newly served. Source and comparison-anchor ages advance at read time; selected `sourceRisk.sourceAgeSeconds` follows authoritative provenance, while alternate ages advance from the publication clock and preserve unavailable ages.

Yield history may include a top-level `warning` explaining publication-cutoff fallback. A point with unreadable stored warnings returns `warningSignals: []` with `warningSignalsStatus: "unreadable"`; that marker is not a clean warning assessment. Each point's `pysReproducibility` is `exact`, `not-scored`, `legacy-partial`, or `invalid`: only `exact` affirms reproduction from the publish-time input snapshot, while legacy/absent evidence and invalid snapshots remain explicit.

**Endpoints with `_meta`:**

| Endpoint                         | Max Age (sec) | Source                                       |
| -------------------------------- | ------------- | -------------------------------------------- |
| `GET /api/stablecoins`           | <!-- GENERATED-START: api-meta-stablecoins-max-age -->600<!-- GENERATED-END: api-meta-stablecoins-max-age -->           | `createCacheHandler`                         |
| `GET /api/chains`                | <!-- GENERATED-START: api-meta-chains-max-age -->1800<!-- GENERATED-END: api-meta-chains-max-age -->          | `worker/src/api/chains.ts`                   |
| `GET /api/events`                | 600           | `worker/src/api/events.ts`                   |
| `GET /api/bluechip-ratings`      | <!-- GENERATED-START: api-meta-bluechip-ratings-max-age -->43200<!-- GENERATED-END: api-meta-bluechip-ratings-max-age -->         | `createCacheHandler`                         |
| `GET /api/usds-status`           | <!-- GENERATED-START: api-meta-usds-status-max-age -->86400<!-- GENERATED-END: api-meta-usds-status-max-age -->         | `createCacheHandler`                         |
| `GET /api/yield-rankings`        | <!-- GENERATED-START: api-meta-yield-rankings-max-age -->3600<!-- GENERATED-END: api-meta-yield-rankings-max-age -->          | Manual injection after live safety hydration |
| `GET /api/depeg-resolver`        | 900           | `worker/src/api/depeg-resolver.ts`           |
| `GET /api/depeg-resolver-review` | 900           | `worker/src/api/depeg-resolver-review.ts`    |

Array-typed responses (e.g., endpoints returning a JSON array at the top level) do not include `_meta`. They receive `X-Data-Age` / `Warning` only when their handler wires freshness metadata explicitly. Supply history, safety score history, and non-USD share are explicit history-endpoint exceptions that emit freshness headers; DEX liquidity history currently exposes cache headers but no freshness headers.

The frontend `apiFetchWithMeta()` helper (in `src/lib/api.ts`) reads `_meta` from the response body when present, falling back to the `X-Data-Age` header for endpoints that do not include it.

---

## Cache-Control Profiles

These profiles are ceilings, not a fresh lifetime renewed on each read. Freshness-aware responses clamp browser `max-age`, shared `s-maxage`, and the combined TTL plus `stale-while-revalidate` window to the remaining fresh runway. At the boundary (no whole second remains), or for a non-fresh/invalid timestamp, the response is `no-store`. Generic responses retain 8x/12x bands, chains 1x/2x, and yield its own publication bands; no cadence or SLO is changed. Edge cache reads reject entries whose HTTP `Age`/`Date` has exhausted that bounded lifetime. Proxies preserve `Age` and `Date`; clients interpreting cached `_meta` must distinguish its `assessedAt` from the current wall clock.

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
| no-store           | `no-store`                                                     | admin GET routes via the router override or admin route wrapper (`status`, `status-history`, `request-source-stats`, API key inventory/audit routes, `admin-action-log`, `debug-sync-state`, `rpc-provider-trial`, `backfill-dews`, `backfill-dews?repair=...&dry-run=true`, `audit-depeg-history?dry-run=true`) |

`POST /api/feedback`, `POST /api/donor-key-claims`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, `POST /api/telegram-mini-app/mutate`, and admin POST endpoints bypass edge caching because they are non-GET request paths. The donor key claim and Telegram Mini App endpoints explicitly return no-store responses so plaintext API keys and per-chat alert state are never cacheable.

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

Public API traffic enforces per-key rate limiting to ensure fair usage. Non-exempt `/api/*` requests require a valid `X-API-Key`; the no-key public exceptions are `GET /api/safety-grades`, `GET /api/health`, `GET /api/og/*`, `POST /api/feedback`, `POST /api/donor-key-claims`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`. The Telegram webhook is authenticated separately with `X-Telegram-Bot-Api-Secret-Token`; Telegram Mini App endpoints are authenticated with signed Telegram `initData`.

Missing or invalid keys receive `401` with `Unauthorized: valid X-API-Key required. Safety grades are free at /api/safety-grades; see https://pharos.watch/api/ for supporter and partner keys.` Supporter claims have their own pre-body IP limiter; its `429` response includes `reason: "rate_limited"` and `Retry-After: 60`, separately from the issued key's global `10` requests per minute quota.

### Per-key limit

| Scope       | Limit                | Window     |
| ----------- | -------------------- | ---------- |
| Per API key | Varies (default 120) | 60 seconds |

Per-key overrides are stored in `api_keys.rate_limit_per_minute`.

Existing self-serve keys (retired lane; see Public API Auth) keep their fixed default of `30` requests per minute and `60` day expiry until they drain; the request and verification abuse limiters were removed with the route.

When the per-key limiter is exceeded, the API returns `429 Too Many Requests`:

```json
{
  "error": "Rate limit exceeded"
}
```

Rate-limited responses include the retry delay in the HTTP `Retry-After` header when the worker can compute one.

`POST /api/feedback` also has a form-specific limiter. Its `429` body is `{ "error": "Too many submissions. Please wait a few minutes." }`, and it should be handled as a local submission throttle rather than as a public API quota response. If the feedback limiter's D1 dependency is unavailable, the endpoint returns `503 Service Unavailable` with `{ "error": "Feedback service temporarily unavailable. Please try again." }` and `Retry-After: 60`.

API-key authentication and per-key limiter storage normally rely on D1. For protected cacheable `GET` edge-cache hits, the worker can serve a recently verified standard (non-donor, non-self-serve) key through a bounded isolate-local auth/limiter path. It can also continue serving a recently verified standard (non-donor, non-self-serve) key during a brief D1 outage by reusing its bounded verified-key cache and isolate-local limiter. Donor and self-serve keys never use the isolate path — donor quotas must stay global and self-serve revocation state is only answerable from D1 — so both fail closed when D1 is unavailable. Unknown or not-yet-verified keys still fail closed with `503 Service Unavailable`, `{ "error": "Public API temporarily unavailable" }`, and `Retry-After: 60`. Best-effort API-key usage timestamp updates do not fail otherwise successful reads.

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

**Public status history:** `GET /api/public-status-history` returns `503` with `{ "error": "Public status history unavailable" }` and `Cache-Control: no-store` when its transition-ledger query fails, even when current public health is healthy. Only a successful query may return an empty `transitions` array and `lastChangedAt: null`; successful responses retain `public, max-age=60`. The public status page presents missing or failed runway history as unavailable, not as an empty incident observation.

---

## Method Gating Policy

HTTP method allowance is defined centrally in `shared/lib/api-endpoints/` and enforced by `worker/src/router.ts` via `validateRouteMatchMethod()` and `validateAllowedEndpointMethods()`.

- `GET` is accepted for read endpoints (plus admin debug/status endpoints, `GET /api/backfill-dews`, and dry-run repair previews for `GET /api/backfill-dews?repair=...&dry-run=true`).
- `HEAD` is not accepted as an implicit `GET`; known routes return `405` with the route's `Allow` methods.
- `POST` is accepted for mutating admin endpoints, `POST /api/feedback`, `POST /api/donor-key-claims`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, and `POST /api/telegram-mini-app/mutate`.
- `GET, POST` is accepted on `/api/api-keys` so operators can list keys and create a new key through the same route.
- `GET` is accepted on `/api/api-keys/lifecycle-summary` for counts-only Triage credential monitoring.
- `POST` is accepted on `/api/api-keys/:id/update`, `/api/api-keys/:id/deactivate`, and `/api/api-keys/:id/rotate`.
- `/api/audit-depeg-history` allows `GET` only with `?dry-run=true`; otherwise it is `POST`-only.
- `/api/backfill-dews` allows `GET` for the historical backtest and for `repair=...&dry-run=true` previews; mutating repair runs are `POST`-only.
- Unknown public `/api/*` requests can return `401` first when the API key is missing or invalid. After lane auth succeeds, unregistered paths return `404` because no route dependencies can be hydrated. Once a static or dynamic route family is registered, known paths with disallowed methods return `405` with `Allow`; unsupported verbs on known endpoint families return `405` with `Allow: GET, POST`.

The same shared endpoint descriptors now also carry static worker dependency-hydration hints consumed by `worker/src/routes/registry.ts`, where the worker binds shared endpoint keys directly to handlers through a single static route-definition list. That keeps endpoint metadata, router behavior, method guards, admin status-page actions, and worker-side static route wiring aligned from one source of truth plus one worker binding table.

## Public Endpoints

Unless an endpoint section explicitly says `Authentication: exempt`, routes in this section require `X-API-Key` when called on `https://api.pharos.watch`. OpenAPI schemas are published at [`/openapi.json`](https://pharos.watch/openapi.json); endpoint auth and cache flags come from `shared/lib/api-endpoints/definitions.ts`.
For `GET /api/stablecoin-summary/{stablecoinId}`, `supplyUsd.current`, `supplyUsd.prevDay`, `supplyUsd.prevWeek`, and `supplyUsd.prevMonth` — plus `supplyUsd.change1d`, `supplyUsd.change7d`, and `supplyUsd.change30d` — are `number | null`. `current` is `null` (with `supplyUsd.currentUnavailableReason: "supply-buckets-missing"`) when the coin is present but its current peg buckets are absent, empty or wholly invalid; the reason is `null` whenever current supply was observed. Each change is `null` unless both current and its historical value are observed, so missing current supply never produces a negative delta. An observed zero bucket remains numeric `0`. `supplyByPegUsd` publishes only finite buckets (`{}` when none). A coin absent from the stablecoins publication still returns `404`.
For `GET /api/dex-liquidity` and `GET /api/dex-liquidity-history`, `totalVolume24hUsd`, `totalVolume7dUsd`, history `volume24h`, pool `volumeUsd1d` and `scoreComponents.volumeActivity` are `number | null`. Since liquidity v6.9 (2026-09-28) a pool reading counts only when observed at most 72h ago, never decayed or zero-filled. A total is a number only when every retained pool was admitted (a measured zero stays `0`); otherwise it is `null` beside `volume24hAvailability` / `volume7dAvailability`: `completeness`, `reason`, pool counts, window clock, `partialGrossUsd` (observed admitted-pool volume, a lower bound) and `admittedTvlUsd` / `retainedTvlUsd` / `volumeCoverage`. Activity is admitted volume over admitted TVL; below 50% coverage it and `liquidityScore` are `null` (NR). `__global__` publishes its observed volume and coverage the same way. Rows without a record are legacy (`unknown` completeness). See [DEX liquidity § Measured volume availability](./dex-liquidity.md#measured-volume-availability-dec-19-active-since-v69).
For `GET /api/mint-burn-flows`, aggregate `coins[].netFlow24hUsd`, `netFlow7dUsd`, `netFlow30dUsd`, `netFlow90dUsd`, `coins[].netFlowDirection24h`, `chains[].netFlow24hUsd`, `hourly[].netFlowUsd`, `gauge.flightToQuality` and `gauge.flightIntensity`, and per-coin `netFlowUsd` / `chains[].netFlowUsd`, are nullable for valuation gating. Since 2026-09-28 (mint-burn-flow v6.23) the producer publishes `null` for a signed net whose window is `partial`, for a direction or flight-to-quality decision that missing valuation could change, and for pressure unless the 24h window is `complete` and the baseline is not `partial`. Additive `valuation` records qualify them: per coin `{ window24h, baseline, netFlow7d, netFlow30d, netFlow90d }`, per chain/bucket a completeness label, per-coin totals and chains a full record `{ completeness, mintCompleteness, burnCompleteness, unpricedMintEventCount, unpricedBurnEventCount }`, and `gauge.partialValuationInputs` counts weighted coins whose valuation can alter `gauge.score` (from v6.23: coins with at least seven days of baseline history whose pressure was withheld for incomplete valuation, with their weight in the additive `gauge.partialValuationMcapUsd` beside the scored weight `gauge.scoredMcapUsd`; the score re-weights over the scored coins). `complete` means exact (an empty window is complete); `partial` means unpriced events exist, so mint/burn volumes are lower bounds and a signed net is not a bound; `unknown` marks data aggregated before completeness was recorded, whose nets stay published with that label until the legacy buckets age out. An absent record (older payload) is `unknown`, never complete.

<!-- GENERATED-START: public-endpoints -->
<!-- Generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json and shared/lib/api-endpoints/definitions.ts. -->
<!-- Curated route notes are authored in the generator and keyed by operationId. Do not edit this block by hand. -->

### Public Endpoints Quick Reference

Generated from `public/openapi.json` (`Pharos API` v1.0.0). Total OpenAPI operations: **42**.

| Method | Path | Summary | Tags | Auth | Parameters | Status codes |
| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |
| GET | `/api/events` | Tape events | Risk | `X-API-Key` required | `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoins` | List stablecoins | Stablecoins | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin/{stablecoinId}` | Stablecoin detail | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-summary/{stablecoinId}` | Stablecoin summary | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/non-usd-share` | Non-USD share | Market Structure, History | `X-API-Key` required | `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/chains` | Chains | Chains | `X-API-Key` required | `chain` (query, optional, string) | 200, 400, 401, 429, 503 |
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
| GET | `/api/snapshots/index` | Public snapshot index | Digest | `X-API-Key` required | `limit` (query, optional, integer); `cursor` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/{date}.json` | Public snapshot for a single day | Digest, History | `X-API-Key` required | `date` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshot/{date}/stablecoin/{stablecoinId}` | Public snapshot projection for a single coin | Digest, Stablecoins, History | `X-API-Key` required | `date` (path, required, string); `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/health` | Health check | Health | exempt | — | 200, 400, 503 |
| GET | `/api/public-status-history` | Public status history | Status | `X-API-Key` required | `limit` (query, optional, integer); `window` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/telegram-pulse` | Telegram pulse | Status | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stability-index` | Pharos Stability Index | Risk | `X-API-Key` required | `detail` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/report-cards/v9` | Safety Score V9 report cards | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/safety-grades` | Safety Score grades (no key) | Risk | exempt | — | 200, 400, 503 |
| GET | `/api/dependency-graph/v1` | Dependency graph (no key) | Risk | exempt | — | 200, 400, 503 |
| GET | `/api/dependency-scenarios/v1` | Modeled dependency scenarios (no key) | Risk | exempt | — | 200, 400, 503 |
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

Searches the normalized event tape; cursor pagination is preferred for long result sets. `droppedRows` is the number of queried database rows rejected because they did not match the response schema; a non-zero value means the returned event set is incomplete, while `total` still counts those queried rows.

- **Operation ID:** `events`
- **Path:** `/api/events`
- **Parameters:** `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`TapeEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/TapeEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoins`

Returns the current stablecoin catalogue, prices, supply, chain breakdowns, and FX context. Since 2026-09-28, `StablecoinListResponse.peggedAssets[].chainCirculating` preserves unobserved `current`, `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth` values as `null` instead of the legacy projected `0`; omitted historical keys also mean unavailable. Explicit observed zero remains `0`. Consumers must not interpret unavailable chain observations as redemptions, mints, or a complete distribution denominator. Also since 2026-09-28 (pricing v6.38), nominal par routes carry par in `nominalPriceReference` (`{ price, source: "protocol-par", mode: "nominal_reference" }`) instead of a high-confidence `protocol-redeem` price stamped with the sync clock; non-USD par adds optional `fxReferenceType` (`fresh` or `static`) and `fxObservedAt` (the FX reference's own source time, `null` when unknown). A fresh market quote that depeg detection rates authoritative stays the published `price`; otherwise `price` is par with `priceSource` `protocol-par`, `priceObservedAtMode` `nominal_reference`, and `priceConfidence`, `priceObservedAt` and `priceUpdatedAt` `null`. Such a price is a nominal reference, not an observation.

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

Returns the full current and historical detail payload for one canonical Pharos stablecoin ID. Since 2026-09-28 (pricing v6.38), nominal par routes may carry `nominalPriceReference`; a `priceObservedAtMode` of `nominal_reference` marks a published par reference, not an observed price.

- **Operation ID:** `stablecoinStablecoinId`
- **Path:** `/api/stablecoin/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinDetailResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinDetailResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoin-summary/:id`

Returns the compact stablecoin projection used by lightweight consumers. Since 2026-09-28 (pricing v6.38), nominal par routes may carry `nominalPriceReference`; a `priceObservedAtMode` of `nominal_reference` marks a published par reference, not an observed price.

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

Returns stablecoin distribution and health aggregates grouped by chain. Since 2026-09-27 chain accounting is raw: `chainAttributedTotalUsd` is the unclamped sum of the published chain rows (previously capped at `globalTotalUsd`), each `dominanceShare` is `totalUsd / globalTotalUsd` without rescaling (shares can sum above 1 when chain rows over-attribute supply), `attributionDiscrepancyUsd` is the signed `chainAttributedTotalUsd - globalTotalUsd`, `unattributedTotalUsd` is its positive residual, and `dominanceGeometryTotalUsd` (`max(global, attributed)`) is a bar-geometry denominator, never a share label. `supplyCoverage` and per-chain `unavailableSupplyObservationCount` count unobserved aggregate and chain supply excluded from those totals. Since Chain Health v1.6, zero peg coverage publishes `healthFactors.pegStability: null`; partial coverage publishes the observed-only factor with `pegStabilityCoverage`. Since v1.7, `healthScore`/`healthBand` also publish for partial coverage with `pegStabilityCoverage.coverage >= 0.95`; below that they are null. `neutralImputedSupplyUsd` is zero for new payloads; old cached payloads retain their original methodology. Since 2026-09-28 the unused V8 fields `_meta.dependencies.reportCards.inputsStale` and `_meta.dependencies.reportCards.staleInputs` are removed from the public contract; dependency status, age, and reason are unchanged.

- **Operation ID:** `chains`
- **Path:** `/api/chains`
- **Parameters:** `chain` (query, optional, string)
- **Success response schema:** [`ChainsResponse`](https://pharos.watch/openapi.json#/components/schemas/ChainsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Source-backed chain methodology example**

```json
{
  "healthMethodologyVersion": "1.7"
}
```

### `GET /api/stablecoin-reserves/:id`

Returns reviewed reserve composition and provenance for one stablecoin. Since 2026-09-27 the freshness verdict carries its policy values: `sync.freshness` publishes the assessment clock (`assessedAt`), judged generation (`fetchedAt`, `attemptId`), fetch age against the route's fetch budget, and, for verified source timestamps, source age against the effective source budget with the cap that set it; `provenance.scoringRejectionReasons` lists the admission gates behind `scoringEligible`. Both are additive optional fields, and unjudged or legacy values are `null`. Also since 2026-09-27, supply-comparing reserve snapshots publish `metadata.liabilityScope` (reviewed included/excluded chains with reasons), `supplyCoverageComplete`, `reserveObservedAt`, `supplyObservedAt`, and `ratioSkewSec`, and `metadata.collateralizationRatio` is omitted with `metadata.ratioUnavailableReason` when liability coverage or reserve/supply time identity is not established. USD1 now publishes `collateralizationRatio` over its reviewed issuer-native perimeter; the former USD1 `fundBackingTotalRatio` and `details.fundScope` fields are removed.

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
  "currentVersion": "4.2",
  "currentVersionLabel": "v4.2"
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

Returns detected depeg incidents with filters for asset, state, and review status. The response exposes pagination totals through `total` and optional `totalExact`; it no longer includes an aggregate `counts` field. Clients that need threshold-crossing totals should sum each event&rsquo;s `constituentEventCount` after loading all pages. Since 2026-09-28 `auditVerdict` accepts only confirmed, repaired, false_positive, disputed, no_data, or null; unknown archived verdicts are rejected rather than converted into scoreable evidence.

- **Operation ID:** `depegEvents`
- **Path:** `/api/depeg-events`
- **Parameters:** `stablecoin` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `active` (query, optional, boolean); `includeTotal` (query, optional, boolean); `includePending` (query, optional, boolean)
- **Success response schema:** [`DepegEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/DepegEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "6.30"
}
```

### `GET /api/depeg-resolver`

Returns machine-resolved depeg-duration evidence used by risk surfaces. Since 2026-09-28 unknown audit verdicts fail closed. DDR excludes false_positive, disputed, and no_data; PegScore excludes false_positive and disputed but retains no_data. Null retains legacy eligibility.

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
  "currentVersion": "6.30"
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

Returns current DEX liquidity scores and pool-level evidence. Volume, activity and NR follow the liquidity v6.9 volume contract above.

- **Operation ID:** `dexLiquidity`
- **Path:** `/api/dex-liquidity`
- **Parameters:** None.
- **Success response schema:** [`DexLiquidityResponse`](https://pharos.watch/openapi.json#/components/schemas/DexLiquidityResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dex-liquidity-history`

Returns bounded historical DEX liquidity observations for one stablecoin. `volume24h` and `score` follow the same v6.9 contract.

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
- **Parameters:** `limit` (query, optional, integer); `cursor` (query, optional, string)
- **Success response schema:** [`SnapshotsIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/SnapshotsIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshots/:date.json`

Returns the full public snapshot captured for one date. Historical report-v5 cards from methodologies before 9.15 may retain a valid nullable `stressStateDigest`; archive validation accepts only that retired field while preserving the original payload and ETag. Current report producers remain strict. The same compatibility applies to dated coin projections.

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

Provides the unauthenticated availability canary; it is not the operator status dashboard. Since 2026-09-27 dedicated asset-scoped circuit outages no longer count as source-wide degradation; the shared `protocol-redeem` circuit remains source-wide.

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
      "producerIntervalSec": 3600
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

Returns the current Pharos Stability Index and optional component detail. Since 2026-09-28 (PSI v3.64), daily snapshots persist all-null components as null rather than zero. Observed zero remains numeric zero; partial components average only observations and disclose `dailyProvenance.componentSampleCounts`. All-day score averaging and mixed-version breakdown are retained; `componentsUnavailable` identifies unavailable components. Legacy rows without counts remain unknown, not assumed complete.

- **Operation ID:** `stabilityIndex`
- **Path:** `/api/stability-index`
- **Parameters:** `detail` (query, optional, boolean)
- **Success response schema:** [`StabilityIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/StabilityIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "3.64",
  "methodologyVersion": "3.64"
}
```

### `GET /api/og/*`

Dynamic social-card image routes are served by the Worker and intentionally omitted from OpenAPI.

- **Path:** `/api/og/*`
- **Parameters:** Route-specific path segments select the supported image family.
- **Success response schema:** PNG image bytes; not represented by a JSON component schema.
- **Policy:** API-key authentication exempt; route-specific response caching.

### `GET /api/report-cards/v9`

[V9 contract](./report-cards.md#api).

- **Operation ID:** `reportCardsV9`
- **Path:** `/api/report-cards/v9`
- **Parameters:** None.
- **Success response schema:** [`ReportCardsV9Response`](https://pharos.watch/openapi.json#/components/schemas/ReportCardsV9Response)
- **Policy:** authentication `X-API-Key` required; bypass shared endpoint caching (`cacheBypass: true`).

### `GET /api/safety-grades`

Returns one Safety Score and grade per tracked stablecoin from the same V9 publication, without an API key.

- **Operation ID:** `safetyGrades`
- **Path:** `/api/safety-grades`
- **Parameters:** None.
- **Success response schema:** [`SafetyGradesResponse`](https://pharos.watch/openapi.json#/components/schemas/SafetyGradesResponse)
- **Policy:** authentication exempt; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dependency-graph/v1`

[Graph contract](./dependency-map.md).

- **Operation ID:** `dependencyGraphV1`
- **Path:** `/api/dependency-graph/v1`
- **Parameters:** None.
- **Success response schema:** [`DependencyGraphResponse`](https://pharos.watch/openapi.json#/components/schemas/DependencyGraphResponse)
- **Policy:** authentication exempt; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dependency-scenarios/v1`

[Modeled results](./dependency-map.md).

- **Operation ID:** `dependencyScenariosV1`
- **Path:** `/api/dependency-scenarios/v1`
- **Parameters:** None.
- **Success response schema:** [`DependencyScenariosResponse`](https://pharos.watch/openapi.json#/components/schemas/DependencyScenariosResponse)
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `GET /api/redemption-backstops`

Returns reviewed redemption paths and backstop evidence.

- **Operation ID:** `redemptionBackstops`
- **Path:** `/api/redemption-backstops`
- **Parameters:** None.
- **Success response schema:** [`RedemptionBackstopsResponse`](https://pharos.watch/openapi.json#/components/schemas/RedemptionBackstopsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Minimal response example**

```json
{
  "coins": {},
  "methodology": {
    "version": "4.45",
    "versionLabel": "v4.45",
    "currentVersion": "4.45",
    "currentVersionLabel": "v4.45",
    "changelogPath": "/methodology/redemption-backstop-changelog/",
    "asOf": 0,
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
  "updatedAt": 0,
  "snapshotSource": "run-rows"
}
```

**Capacity-confidence vocabulary:** `live-direct`, `live-proxy`, `dynamic`, `documented-bound`, `heuristic`.

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
- **Success response schema:** [`YieldRankingsResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldRankingsResponse), [`YieldRankingsSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldRankingsSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "8.46",
  "methodologyVersion": "9.99"
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
  "methodologyVersion": "v8.46"
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
  "currentVersion": "8.46",
  "methodologyVersion": "8.46"
}
```

### `GET /api/mint-burn-flows`

Returns aggregate mint and burn pressure over the requested window. Since 2026-09-28 (mint-burn-flow v6.23) signed nets (`netFlow24hUsd`, `netFlow7dUsd`, `netFlow30dUsd`, `netFlow90dUsd`, chain `netFlow24hUsd`, per-coin and hourly `netFlowUsd`) are `null` when the matching `valuation` is `partial`; gross mint/burn volumes remain known-valuation lower bounds. `netFlowDirection24h` is `null` unless missing valuation cannot change it, `pressureShiftScore` is `null` (state `nr`) unless the 24h window is `complete` and the baseline is not `partial`, and `gauge.flightToQuality` / `gauge.flightIntensity` are `null` unless exact or provably inactive. `gauge.score` re-weights over coins whose pressure is published; `gauge.partialValuationInputs` counts weighted coins with at least seven days of baseline history whose pressure was withheld for incomplete valuation, the additive `gauge.partialValuationMcapUsd` their weight and `gauge.scoredMcapUsd` the weight actually scored, so the full-cohort score lies within `(scoredMcapUsd·score ± 100·partialValuationMcapUsd) / (scoredMcapUsd + partialValuationMcapUsd)`. Windows with legacy `unknown` coverage keep their nets, labelled by `valuation`, until those buckets age out.

- **Operation ID:** `mintBurnFlows`
- **Path:** `/api/mint-burn-flows`
- **Parameters:** `stablecoin` (query, optional, string); `hours` (query, optional, integer)
- **Success response schema:** [`MintBurnFlowsResponse`](https://pharos.watch/openapi.json#/components/schemas/MintBurnFlowsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/mint-burn-events`

Returns the normalized issuance event stream with cursor or offset pagination. Since 2026-09-28 (mint-burn-flow v6.23) `amountUsd` is set only from a price whose actual observation time is within 24 hours either side of the event, and `priceTimestamp` is that observation time: `priceSource` `supply-history-daily` / `supply-history-heal` for a daily snapshot price with a recorded observation clock (never its day label; nominal par is never stored), `price-cache-event-window` / `price_cache_heal` for a replay-safe observed cache price (never a legacy `protocol-redeem` par row of a nominal-par route); the candidate observed closest to the event wins. Events without such evidence keep `amountUsd: null`; this includes NAV tokens whose latest observation is more than 24 hours from the event (for example over weekends). Older rows may still carry `price-cache-current` with a run-time `priceTimestamp`, or `supply-history-daily` with the snapshot day as `priceTimestamp`.

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
  "currentVersion": "6.30",
  "methodologyVersion": "6.30"
}
```

### `POST /api/donor-key-claims`

Issues one non-expiring supporter API key to a donor wallet that signs a Sign-In-With-Ethereum claim message.

- **Registry key:** `donor-key-claim`
- **Path:** `/api/donor-key-claims`
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
