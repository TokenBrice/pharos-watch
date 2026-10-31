# Pharos API Reference

The Pharos API is a REST API served by a Cloudflare Worker backed by a D1 database. It powers the [pharos.watch](https://pharos.watch) stablecoin analytics dashboard through a split website-data lane plus an external integration API. On `https://api.pharos.watch`, all public routes are API-key protected unless this reference explicitly marks them as exempt.

**Base URL:** `https://api.pharos.watch`

Unless noted otherwise, responses are `Content-Type: application/json`. Exceptions: CORS preflights are bodyless without `Content-Type`; `GET /api/og/*` returns `image/png` on success for known image routes and can return `text/plain` on errors; and `POST /api/telegram-webhook` returns a plain-text `ok` body. CORS headers are added to every response, but `Access-Control-Allow-Origin` is restricted by the Worker `CORS_ORIGIN` allowlist (production repo config: `https://pharos.watch,https://ops.pharos.watch`). When the request `Origin` matches an allowlisted entry, the Worker echoes that origin and sets `Vary: Origin`; when a request includes a foreign `Origin`, the worker omits `Access-Control-Allow-Origin`, and `OPTIONS` preflights from foreign origins receive `403`. Requests without an `Origin` header keep the existing first-allowlisted-origin fallback. Non-exempt `/api/*` requests on `api.pharos.watch` require a valid `X-API-Key`; missing or invalid keys return `401 Unauthorized`. Per-key rate-limit overages return `429`, and cold auth/limiter dependency failures can still return `503`.

> **Agent navigation** — Grep the heading you need: Surface Split · Public API Auth · Stablecoin IDs · Response Headers · Response Body Freshness (`_meta`) · Cache-Control Profiles · Polling Guidance · Rate Limits · Error Response Conventions · Method Gating Policy · Safety Score Availability · Reserve Availability · Public Endpoints (generated from OpenAPI and the endpoint registry) · Pages Function endpoints. For one route, grep its path (for example, `/api/stablecoins`). Operator routes live in the internal [admin reference](./api-reference-admin.md).

## Surface Split

The runtime now uses three HTTP lanes:

- `https://api.pharos.watch` is the external integration API. Protected public routes require `X-API-Key`.
- `https://site-api.pharos.watch` requires `X-Pharos-Site-Proxy-Secret` for allowlisted `GET` reads and internal `GET /api/stablecoin-detail-snapshot-inputs`. The build-input read is denied through browser `/_site-data/*` and the public API host.
- `/_site-data/*` is the same-origin Pages Functions proxy used by browsers on `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and subdomains of `stablecoin-dashboard.pages.dev`.

Static dataset exports are served from the public website, not from the Worker API, and do not require `X-API-Key`. The Stablecoin Cemetery export is JSON at `https://pharos.watch/datasets/stablecoin-cemetery.json` and CSV at `https://pharos.watch/datasets/stablecoin-cemetery.csv`.

The same static lane serves `https://pharos.watch/datasets/<topic>/latest.{csv,json,ndjson}` and dated `/datasets/<topic>/<YYYY-MM-DD>.{csv,json,ndjson}` artifacts, retained for 90 days. Topic IDs are a never-break external contract owned by `PUBLIC_DATASET_TOPICS` in `shared/lib/api-endpoints/datasets.ts`. Each `latest` URL is a Pages `200` rewrite to the same-extension dated file; `https://pharos.watch/sheets/<topic>.csv` rewrites directly to dated CSV. Missing dated URLs mean no published artifact, including retention pruning—not an observed empty dataset or proof no refresh ran. Shared current-snapshot freshness gates reject dates beyond two UTC dates; per-topic alias checks do not age-check each topic. These JSON-LD `DataDownload` URLs have extension-compatible content types, `Access-Control-Allow-Origin: *`, and cache policies from `public/_headers`. Generator/backdating mechanics belong to `scripts/maintenance/generate-public-datasets.ts`.

The `depeg-history` topic is **retrospective windowed history**, not a historical point-in-time event-state sample. The dated filename selects the 90-day UTC event-start window ending on that date; peaks, recovery and closure fields come unchanged from the captured event ledger and may describe observations after the market snapshot. Its JSON/NDJSON metadata and CSV preamble report the ledger observation-end clock as `asOfISO`, the exact shard capture identity as `sourceGeneration`, the observation-start clock as `sourceObservationStartedAtISO`, and the separate market snapshot clock as `windowSnapshotAsOfISO`. Other topics retain the immutable market-envelope clock. A historical regeneration may change retrospective event rows and their capture provenance; it must not relabel later state as information known at the older market clock. Missing or mismatched ledger-capture provenance fails generation rather than inventing historical peaks or masking later recoveries.

`scores-latest` additionally publishes an additive `_meta.displayProjection` contract and six appended row columns (`ratingStatus`, `safetyDisplay`, `dewsComputedAt`, `liquidityUpdatedAt`, `liquidityUnavailableReason`, `liquidityMethodologyVersion`). Existing columns and `_meta.asOfISO` keep their contract; `asOfISO` remains the collection clock, while the Safety publication clock is `displayProjection.safety.publishedAtSec` and each DEWS/liquidity source keeps its own `*At` field. Legacy exports omit the Safety object and set `safetyUnavailableReason: "legacy-source-metadata-unavailable"`; consumers must not infer held, current or quarantine state from the score. `displayProjection.version` is now 2: every v1 field keeps its bytes and the projection adds `openEvidence` (`{ semantics: "open-question-v1", totals: { questions, open, issuer, documentation, obligations } } | null`) copied from the accepted publication, plus `openEvidenceUnavailableReason` (`"safety-publication-unavailable" | "open-evidence-unavailable" | null`, null exactly when the counts are present). A missing Safety publication or a pre-cutover publication without the block publishes `openEvidence: null` with the matching reason, never three zero counts; the CSV preamble is unchanged.

The static `depeg-history` dataset publishes each event's `id` as a string in JSON and NDJSON (and as text in CSV), preserving the established export contract. This differs from the numeric event IDs in the runtime depeg-events API and internal archive rows. Rows append the ledger's `auditVerdict` (`null` when none); a reviewed dispute is never exported unmarked.

Pharos code, data and data exports are [MIT-licensed](https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE). Editorial content, including profile prose, methodology and case studies, is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Third-party material retains its original terms. Editorial prose retains its license when included in a Markdown export. Dataset cards state the MIT license, the export's `_meta.asOfISO` and methodology label, and copy a citation that names the canonical Reference card and the dated JSON edition. The filename reflects publication; `asOfISO` preserves the observation clock; neither promises perpetual byte preservation.

Public onboarding artifacts are served at `https://pharos.watch/openapi.json`, `https://pharos.watch/postman/pharos-api.postman_collection.json`, and `https://pharos.watch/postman/pharos-api.postman_environment.json`. Import both files and replace the `apiKey` placeholder with a real `X-API-Key`. OpenAPI includes named Yield Intelligence ranking/history schemas; Postman includes best-source and source-key history examples. Both Postman variable lists declare `snapshotDate`: call `/api/snapshots/index` (API key required), then set `snapshotDate` to a returned `snapshots[].snapshotDate` before running either snapshot request. The integration/read catalogue is owned by `scripts/lib/public-api-artifact-catalog.ts`, not an inventory of every no-key route: it excludes admin routes, supporter-key claims, feedback, Telegram webhook/Mini App endpoints, and dynamic OG images. Request keys through `https://pharos.watch/api/`.

Browser consumers use same-origin `/_site-data/*` via `src/lib/api.ts`; production Pages targets `https://site-api.pharos.watch` through `SITE_API_ORIGIN`. Direct integrations and CI smoke target `https://api.pharos.watch` with `X-API-Key` for protected reads, including `/api/telegram-pulse`. Pages build-input syncs read allowlisted `GET` endpoints through `https://stablecoin-dashboard.pages.dev/_site-data/*` with an allowed site caller header and reject missing/invalid input. A release can retain failed producers' committed snapshots, but fails before build if all three fail or a public-dataset refresh cannot roll back.

Production Pages does not proxy public `/api/*` POST requests. `https://pharos.watch/api/` is the API access page: it presents the free grades feed, the supporter-key claim, and the partner-key contact. Its browser POST is the supporter-key claim, which goes cross-origin to `https://api.pharos.watch/api/donor-key-claims` with a normal CORS preflight for the JSON `POST` request.

The direct Worker cache profiles below describe responses from `api.pharos.watch` / `site-api.pharos.watch`. Pages `/_site-data/*` forwards the upstream cache policy, `Age`, and `Date` without adding a second Cache API lifetime, so it cannot make a nearly expired Worker response fresh again.

## Public API Auth

Unless a route is explicitly called out below as exempt, requests to `https://api.pharos.watch` must send:

- header: `X-API-Key: ph_live_<16 hex prefix>_<32 char base64url secret>`
- example shape: `ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF`

Public, non-admin routes on `https://api.pharos.watch` that do not require `X-API-Key` are limited to:

- `GET /api/safety-grades` (the free lane: one Safety Score and grade per tracked stablecoin)
- `GET /api/dependency-graph/v1`
- `GET /api/dependency-scenarios/v1`
- `GET /api/health`
- `GET /api/og/*`
- `POST /api/feedback`
- `POST /api/donor-key-claims` (the supporter-key claim: a Sign-In-With-Ethereum signature from an eligible donor wallet, rate-limited per IP before the body is read)
- `POST /api/telegram-webhook`
- `POST /api/telegram-mini-app/session`
- `POST /api/telegram-mini-app/mutate`

`POST /api/telegram-webhook` is externally reachable but not anonymous: it requires `X-Telegram-Bot-Api-Secret-Token` instead of `X-API-Key`.

`POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate` are also externally reachable but not anonymous. They require Telegram Mini App `initData` signed for `@PharosWatchBot`; the worker validates the HMAC, `auth_date`, and user payload before any D1-backed state write. These endpoints are denied on the website-internal site-data lane and are intended only for the Mini App at `https://pharos.watch/pharoswatchbot/app/`.

Admin/operator routes are also outside the public API-key gate, but remain Cloudflare-Access-gated through `ops-api.pharos.watch` or the `ops.pharos.watch/api/admin/*` Pages proxy. The public API host rejects registered admin paths and their configured child families before API-key auth, including `/api/api-keys` and `/api/api-keys/...`; a public API key cannot reach them.

Self-serve key issuance is retired: the lane was removed on 2026-09-29, so `POST /api/api-key-requests` and `POST /api/api-key-requests/verify` are unregistered and respond like any unknown API path on the public host (`401` without a valid `X-API-Key`, `404` with one), while existing `tier="self-serve"` keys keep authenticating until they drain through their `60`-day expiry (about 2026-11-06). The lane's D1 tables (`api_key_requests`, `api_key_request_rate_limit_v2`, `api_key_self_serve_email_claims`, `api_key_self_serve_issuance_limits`) are left in place and dropped in a separate follow-up rollout after this Worker is live; the rate-limit table's daily prune continues until then, and the operator may delete the lane's now-unused Worker secrets with Wrangler (names only, never values): `API_KEY_SELF_SERVE_IP_SALT`, `API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER`, `API_KEY_SELF_SERVE_REQUEST_PEPPER`, `API_KEY_SELF_SERVE_EMAIL_FROM`, `API_KEY_SELF_SERVE_EMAIL_REPLY_TO`, `API_KEY_SELF_SERVE_PUBLIC_BASE_URL`, `RESEND_API_KEY`. Keyed access is a supporter key, claimed by donors on the access page at `https://pharos.watch/api/` through `POST /api/donor-key-claims`, or an operator-issued partner key (internal tier `standard`) requested through the private channel on that page: Telegram DM to `@TokenBrice`, with X DM to `@PharosWatch` as secondary, and a human reply within `PARTNER_KEY_REPLY_BUSINESS_DAYS` (`2`) business days. The reply window and the freshness stamped on every response are service commitments, not a contractual SLA.

`POST /api/donor-key-claims` issues the supporter key and is exempt from `X-API-Key`. An externally-owned wallet signs an EIP-4361 message with `personal_sign` for domain `pharos.watch` and URI `https://pharos.watch/api/`, valid for 5 minutes, then posts `{ "message", "signature" }`. Eligibility requires at least `$10` in receipt-date USD from qualifying-stablecoin donations whose current grades are A+, A, A-, B+, B, or B-. Qualifying stablecoins are the reviewed `(chain, token contract)` pairs in `DONOR_KEY_QUALIFYING_STABLECOINS` (`shared/lib/funding/donor-eligibility.ts`): each coin counts only on its reviewed contract deployments, so bridged or same-ticker tokens never qualify, and non-USD fiat coins (EURC, EURCV, EUROP, ZCHF, XSGD, CADD, AUDM, MYRC) are valued at the ECB reference rate for their peg currency on the receipt date, never 1:1. The threshold is inclusive with floating-point tolerance, addresses are matched case-insensitively, founder rows count, and pool payouts do not. The donor list is updated every Sunday. Smart-contract wallets, Giveth streams, and exchange withdrawals cannot claim.

All claim responses use `Cache-Control: no-store`. `201` returns the plaintext token once, with tier `donor`, `10` requests per minute, and no expiry. Every failure returns `{ "error": "message", "reason": "code" }`; codes are defined once by `DONOR_KEY_CLAIM_FAILURE_REASONS` in `shared/contracts/api-keys.ts`:

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
| `X-Data-Updated-At` | Absolute source update time in Unix seconds, when known; `unknown` when authority is unavailable. Unaffected by edge residence or rewritten HTTP `Date`. Detail enrichment retains the older detail/publication clock. |
| `Warning`    | Freshness warning (`110`) when cached data is older than the generic freshness runway, plus endpoint-specific advisory warnings (`199`) on a few compute-on-read routes |
| `X-Data-Freshness` | `stale` when retained confirmed producer history is absent, or `unknown` when its lookup or timestamp admission failed |
| `X-Data-Freshness-Reason` | Machine-readable reason, including `producer-history-missing`, `freshness-lookup-failed`, and timestamp-admission reasons |

Detail snapshot acquisition preserves body or absolute-header source clocks. Its legacy reconstruction requires a valid `Date` plus explicit nonnegative decimal `X-Data-Age` and `Age`; missing or malformed evidence stays unknown, never zero-age freshness from HTTP receipt or artifact creation. Missing provenance does not discard an otherwise valid per-coin lane payload.

Generic freshness status is `fresh` through `8x maxAge`, `degraded` through `12x maxAge`, then `stale`. Generic freshness headers emit `Warning` and downgrade `Cache-Control` to `no-store` after `age > 8x maxAge` so edge/browser caches do not keep serving an old payload after the underlying cron data recovers. Some routes also use `Warning` for dependency or quality advisories even when the age is still inside that runway; clients should treat body `_meta.status` as authoritative when it exists.

DEX liquidity keeps its dataset-wide advisory in `Warning` and also emits a nullable `warning` on each coin row. Coin-specific TVL cliffs or pool-count drops produce affected-coin advisories and do not trigger a global advisory on successful runs when they are the only findings. Mixed global advisories can include those flags in their raw flag list; provider failures, near-guard proximity, and unscoped findings remain global. The advisory comes from the latest liquidity producer outcome, excluding neutral or locked skips. Coin detail consumers use the row advisory while retaining the producer timestamp for independent freshness checks; older responses without the field retain their global warning.

DEX full and website table responses assess cohort freshness from the newest published row's `updated_at`, the producer generation clock. Dormant rows do not age the whole dataset: each retains its own `updatedAt`, freshness warning, and unavailable reasons. The website coin projection instead assesses headers and cache lifetime from that selected row's own clock; a fresh sibling cannot refresh it.

A failed liquidity producer-status read is not an empty advisory: each row carries `advisoryUnavailableReason: "dex-advisory-read-failed"` and a non-null warning, the response emits a `199` advisory, and cache policy is `no-store`. Successful zero-row status reads retain a nullable advisory with no failure reason.

DDR secondary errata/lock-deferral read failures retain immutable forecasts with `_meta.degradedReason: "secondary-overlay-unavailable"` and `errata-overlay-read-failed` / `lock-deferral-overlay-read-failed` details; responses are `no-store`. Canonical projection failures return `503` for `/api/depeg-events`, naming `incident-projection-read-failed`, `incident-projection-invalid`, or `incident-projection-dangling-reference` (missing active first/current events, membership, or constituent link targets, including single-event incidents); see [projection admission](./depeg-detection.md#api). These failures never return raw history or successful empty cohorts; genuinely empty cohorts remain successful. `/api/peg-summary` retains accepted history as degraded/no-store with that reason (body `degradedReason`) and its original clock, or returns `503`. Non-NAV assets with missing/nominal primary prices expose `currentPriceUnavailable: true` and null deviation, excluded from observed at-peg counts.

`/api/peg-summary` publishes `summary.medianDeviationBps: null` when no admitted live deviations exist, even if historical coin analytics remain available. Readers render null as `—`, independently of valid numeric cohort and historical-event counts; an observed parity price yields `0 bps`. External clients must accept `number | null`. Deploy and verify null-tolerant Pages readers before enabling the Worker producer; retain those readers on producer rollback.

`/api/depeg-events` orders and paginates by public effective `startedAt` descending, then numeric event `id` descending, including DDR-projected incident onsets. The first returned event's effective onset supplies methodology `asOf`; the raw current-fragment clock is not the public pagination key. Opaque cursors are version 2; older raw-onset tokens return `400` and require restarting pagination. Projection admission, event selection and any exact count share one transactional D1 snapshot even when `includeTotal=false`; a concurrent incident-pointer advance cannot silently turn a projected incident into raw history.

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
| `updatedAt` | `number` | Authoritative source observation/publication time in Unix seconds, not request time or a later cache materialization clock |
| `ageSeconds` | `number` | Nonnegative age of the generation at `assessedAt` |
| `assessedAt` | `number` | Unix seconds at which the verdict was assessed; not a replacement generation clock |
| `freshBudgetSec` | `number` | Inclusive maximum generation age for an age-based `fresh` verdict |
| `degradedBudgetSec` | `number` | Inclusive maximum generation age for an age-based `degraded` verdict; older is `stale` |
| `status` | `string` | `"fresh"`, `"degraded"`, or `"stale"`; generic bands remain 8x/12x the endpoint max age |

Route-specific manual `_meta` injectors can be stricter. `GET /api/chains` uses its 1800-second budget directly (`fresh <= 1x`, `degraded <= 2x`, then `stale`) and switches its response to `no-store` whenever the chain snapshot is not fresh. Its `_meta.dependencies.reportCards` always names the independent Safety Score consumer budget in `freshBudgetSec`, including fresh, stale, held (`status: "degraded"`), and unavailable states. That budget comes from `SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC`, not the chain market-snapshot budget. A future-dated accepted publication is `stale` with `reason: "future-timestamp"` at any skew and `ageSeconds: null` (never clamped to zero), so its ratings do not enter Chain Health. Dependency `generationId` identifies the accepted Safety publication (`safetyScoreIdentity.publicationGenerationId`), including retained stale or held publications; unavailable evidence reports `generationId: null`.

Generic, chains, and yield producers publish assessment time and effective budgets, including response-ready cache injection. Readers accept legacy cached metadata without these fields but must treat its assessment/budget as unknown, not infer that it used the current policy. Chains can also be degraded by its named `dependencies.reportCards` verdict even when snapshot age is fresh. Timestamps over the public 60-second future allowance are degraded and not cacheable; this is timestamp validity, not an age-band change.

`GET /api/stress-signals` publishes `assessedAt`, `freshBudgetSec`, `degradedBudgetSec`, and `newestReturnedComputedAt` beside each row's `computedAt` and `ageClassification`. The newest-returned clock is the aggregate comparison basis for `retainedLastValid`; single-coin responses have no peer-generation comparison (`null`). These are row-generation verdicts, not a claim that every source used by DEWS was observed at that time.

Event feeds (`events`, `depeg-events`, `blacklist`, `mint-burn-events`) derive freshness from confirmed producer output through `cron-output.ts`, never request time, the newest matching event, or an `ok` attempt without output. Productive degraded runs may advance the output clock; explicit `outputPublishedAt: null` cannot. A feed whose rows are written by several cron lanes is dated from the oldest lane's confirmed output. An empty filtered page is fresh only with a fresh confirmed observation, including a persisted quiet scan. No confirmed output in retained cron history means stale/no authoritative recent output; a failed lookup means unknown. Both use `Cache-Control: no-store`, `Warning: 199`, and `X-Data-Age: unavailable`, with the reason headers above. `/api/events` also publishes null `updatedAt` / `ageSeconds` and `status: "stale" | "unknown"` plus `reason` in `_meta`; admitted observed clocks omit the optional `reason`, even when their age is stale. Safety-score history uses the same producer-authority headers. Blacklist-summary retains the producing snapshot's clock and lookup state, not its materialization/request time. `GET /api/blacklist` dates `methodology.asOf` from its newest returned event, else from that confirmed producer output; with neither clock the envelope is omitted rather than dated from the request.

For uncounted offset pages, `total` is a conservative observed lower bound and `totalExact` is false. A nonempty offset page establishes the offset plus its observed rows (and any lookahead row); an empty page establishes only zero, even at offset 50,000. Uncounted cursor continuations report only their observed page/lookahead bound. Blacklist defaults to uncounted pages; use `includeTotal=true` for an exact filtered count.

Yield routes override the generic 8x/12x runway: `GET /api/yield-rankings` (full and summary) and `GET /api/yield-history` use the shared `yield-data` bands: `fresh` through 21,600 seconds (3x the two-hour producer interval), `degraded` through 43,200 seconds (6x), then `stale`. Both non-fresh states return `Cache-Control: no-store`; age-based verdicts emit HTTP `Warning: 110`, while yield-history timestamps beyond the future allowance emit `199`. Their `_meta` includes required `assessedAt` (response-time Unix seconds), `freshBudgetSec`, `degradedBudgetSec`, and nullable `reason` alongside `updatedAt`, `ageSeconds`, and `status`. Non-fresh publication age names `yield-publication-age`. History freshness measures the authoritative publication cutoff, not the last point in a requested historical window; unavailable authority is stale with `publication-cutoff-unavailable`.

**Yield wire contract:** Full and summary rankings and history publish the expanded evidence directly.

- Summary rows expose `benchmarkSelectionMode` and `provenance.sourceMaxAgeSeconds`. Summary `benchmarkIsFallback` describes feed fallback independently of currency-selection policy; readers use explicit selection mode rather than inferring it from the fallback flag.
- Detailed ranking provenance retains nullable `sourceObservedAt` and `sourceAgeSeconds` without dropping the remaining evidence. Unavailable rankings `medianApy` is null. `sourceRisk.rewardShare` is nonnegative with no upper bound, preserving raw ratios above 1 in rankings, alternatives, and history.

Yield source freshness is separate from publication freshness. Unknown observation evidence must not be replaced with publication time or treated as refreshed merely because the snapshot was newly served. Source and comparison-anchor ages advance at read time; selected `sourceRisk.sourceAgeSeconds` follows authoritative provenance, while alternate ages advance from the publication clock and preserve unavailable ages.

Full, summary, and coin rankings also recompute `provenance.dlPools.ageSeconds` from the pool input's original `updatedAt` at serve time, independently of yield publication age. A null pool clock remains a null age, even if the stored age was numeric. The reference-rates strip warns only above twice the pool-input producer interval (currently 7,200 seconds from the hourly cadence); its tooltip exposes the effective budget. Neither serving nor republishing yield data renews that input clock.

Yield history may include a top-level `warning` explaining publication-cutoff fallback. A point with unreadable stored warnings returns `warningSignals: []` with `warningSignalsStatus: "unreadable"`; that marker is not a clean warning assessment. Each point's `pysReproducibility` is `exact`, `not-scored`, `legacy-partial`, or `invalid`: only `exact` affirms reproduction from the publish-time input snapshot, while legacy/absent evidence and invalid snapshots remain explicit.

**Selected endpoints with generic freshness `_meta`:**

| Endpoint                         | Max Age (sec) | Source                                       |
| -------------------------------- | ------------- | -------------------------------------------- |
| `GET /api/stablecoins`           | <!-- GENERATED-START: api-meta-stablecoins-max-age -->600<!-- GENERATED-END: api-meta-stablecoins-max-age -->           | `createCacheHandler`                         |
| `GET /api/chains`                | <!-- GENERATED-START: api-meta-chains-max-age -->1800<!-- GENERATED-END: api-meta-chains-max-age -->          | `worker/src/api/chains.ts`                   |
| `GET /api/events`                | 600           | `worker/src/api/events.ts`                   |
| `GET /api/bluechip-ratings`      | <!-- GENERATED-START: api-meta-bluechip-ratings-max-age -->43200<!-- GENERATED-END: api-meta-bluechip-ratings-max-age -->         | `createCacheHandler`                         |
| `GET /api/usds-status`           | <!-- GENERATED-START: api-meta-usds-status-max-age -->86400<!-- GENERATED-END: api-meta-usds-status-max-age -->         | `createCacheHandler`                         |
| `GET /api/yield-rankings`        | <!-- GENERATED-START: api-meta-yield-rankings-max-age -->7200<!-- GENERATED-END: api-meta-yield-rankings-max-age -->          | Manual injection after live safety hydration |

The resolver and resolver-review routes instead use domain `_meta` (`computedAt`, `expiresAt`, `degraded`, and diagnostics), not the generic shape above. Their HTTP freshness headers are assessed from the served snapshot's `computedAt`.

Array-typed responses (e.g., endpoints returning a JSON array at the top level) do not include `_meta`. They receive `X-Data-Age` / `Warning` only when their handler wires freshness metadata explicitly. Supply history, safety score history, and non-USD share are explicit history-endpoint exceptions that emit freshness headers; DEX liquidity history currently exposes cache headers but no freshness headers.

The frontend `apiFetchWithMeta()` helper (`src/lib/api.ts`) reads generic `_meta` when present. For header-only responses it prefers `X-Data-Updated-At`, then falls back to `X-Data-Age`; unavailable or invalid clocks remain explicit.

---

## Cache-Control Profiles

Active `GET /api/stablecoin/{stablecoinId}` reads refresh expired detail caches in the background only while `buildFreshnessMeta` classifies the generation as fresh using `API_FRESHNESS_MAX_AGE_SEC.stablecoins`. Older generations refresh synchronously so the first visitor receives the refreshed detail; provider failures may retain the original stale generation below the 24-hour cache ceiling, with its original clock and warning.

These profiles are ceilings, not a fresh lifetime renewed on each read. Freshness-aware responses clamp browser `max-age`, shared `s-maxage`, and the combined TTL plus `stale-while-revalidate` window to the remaining fresh runway. At the boundary (no whole second remains), or for a non-fresh/invalid timestamp, the response is `no-store`. Generic responses retain 8x/12x bands, chains 1x/2x, and yield its own publication bands; no cadence or SLO is changed. Edge cache reads reject entries whose HTTP `Age`/`Date` has exhausted that bounded lifetime. Proxies preserve `Age` and `Date`; clients interpreting cached `_meta` must distinguish its `assessedAt` from the current wall clock.

Profile strings below come from `API_CACHE_PROFILES` (`shared/lib/api-cache-profiles.ts`), except route-local immutable snapshots (`IMMUTABLE_CACHE_CONTROL` in `worker/src/api/snapshot.ts`) and telegram-pulse's equivalent custom policy.

| Profile            | `Cache-Control`                                                | Used by                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| realtime           | `public, s-maxage=60, max-age=10`                              | health, events                                                                                                                                                                                                                                                                                                                                                                                      |
| producer-backed    | `public, s-maxage=300, max-age=60, stale-while-revalidate=300` | stablecoins, stablecoin-summary, blacklist, blacklist-summary, depeg-events, peg-summary, mint-burn-events, chains (cron-published payloads with 15-30 min producers)                                                                                                                                                                                                                               |
| standard           | `public, s-maxage=300, max-age=60`                             | stablecoin-charts, depeg-resolver, depeg-resolver-review, redemption-backstops, usds-status, daily-digest, digest-archive, stability-index, yield-rankings, yield-adapter-manifest, mint-burn-flows, stress-signals. `/api/report-cards/v9` uses this profile only for a current handler response, uses `no-store` while held, and always bypasses the edge cache. |
| custom             | `public, s-maxage=300, max-age=300`                            | dex-liquidity (browser-side max-age extended to match CDN TTL); telegram-pulse uses route-local `public, max-age=300, s-maxage=300`                                                                                                                                                                                                                                                                 |
| per-coin           | `public, s-maxage=300, max-age=10`                             | stablecoin/:id (cache-aside with 5-min per-coin TTL in D1)                                                                                                                                                                                                                                                                                                                                          |
| slow               | `public, s-maxage=3600, max-age=300`                           | supply-history, dex-liquidity-history, bluechip-ratings, yield-history, safety-score-history, non-usd-share, safety-score-history-v2                                                                                                                                                                                                                                                                |
| archive            | `public, s-maxage=86400, max-age=3600`                         | digest-snapshot (elapsed UTC days), snapshots-index                                                                                                                                                                                                                                                                                                                                                                    |
| immutable-snapshot | `public, s-maxage=31536000, max-age=31536000, immutable`       | snapshots/:date.json, snapshot/:date/stablecoin/:id                                                                                                                                                                                                                                                                                                                                                 |
| public-status      | `public, max-age=60`                                           | public-status-history                                                                                                                                                                                                                                                                                                                                                                               |
| og-image           | `public, max-age=900, s-maxage=900`                            | dynamic Open Graph images, including rendered safety-score degraded states that remain explicitly marked with degraded metadata headers                                                                                                                                                                                                                                                              |
| reserve-live | `public, s-maxage=3600, max-age=300` | stablecoin-reserves live mode with healthy, certain sync |
| reserve-live-stale | `public, s-maxage=1800, max-age=120`                           | stablecoin-reserves live-stale mode                                                                                                                                                                                                                                                                                                                                                                 |
| reserve-fallback | `public, s-maxage=300, max-age=60` | stablecoin-reserves curated/template/unavailable modes and live mode with non-`ok` or uncertain sync |
| no-store           | `no-store`                                                     | admin GET routes via the router override or admin route wrapper (`status`, `status-history`, `request-source-stats`, API key inventory/audit routes, `admin-action-log`, `debug-sync-state`, `rpc-provider-trial`, `backfill-dews`, `backfill-dews?repair=...&dry-run=true`) |

`POST /api/feedback`, `POST /api/donor-key-claims`, `POST /api/telegram-webhook`, `POST /api/telegram-mini-app/session`, `POST /api/telegram-mini-app/mutate`, and admin POST endpoints bypass edge caching because they are non-GET request paths. The donor key claim and Telegram Mini App endpoints explicitly return no-store responses so plaintext API keys and per-chat alert state are never cacheable.

Live `/api/og/page/:slug` responses additionally bound browser and shared TTLs to the whole seconds remaining before the figure's admission expiry, reassessed after PNG rendering, capped at 900 seconds with no one-minute minimum. An expired figure becomes the figure-free timeless card (`X-Og-Reason: stale-cache`), using the 300-second `custom` profile. A positive subsecond remainder yields a zero-second live TTL. These origin bounds do not prove an account-wide browser-cache floor respects them; production acceptance must inspect uncached and cached OG headers.

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
| immutable-snapshot | On-demand only | Dated Worker snapshots use immutable caching; static topic exports can be regenerated |
| no-store           | On-demand only        | Admin/control diagnostics; avoid high-frequency polling                |

Client best practices:

- Add interval jitter (`±10%`) to avoid synchronized bursts.
- Read `X-Data-Age` + `Warning` for freshness/stale decisions when those optional headers are present.
- Back off exponentially on `429` and `5xx` responses.

---

## Rate Limits

Protected public API traffic is limited per key; exemptions are listed in [Public API Auth](#public-api-auth) and owned by `publicApiAccess` in `shared/lib/api-endpoints/`. The free Safety Score grades, dependency graph, and dependency scenarios routes also use `SAFETY_GRADES_RATE_LIMIT`: `120` requests per `60` seconds per client IP, with `429` / `Retry-After: 60` on exhaustion and `503` if the limiter is unavailable. Telegram ingress and supporter claims use separate limiters and authentication.

Missing or invalid keys receive `401` with `Unauthorized: valid X-API-Key required. Safety grades are free at /api/safety-grades; see https://pharos.watch/api/ for supporter and partner keys.` Supporter claim throttling is separate from the issued key's quota; see [Public API Auth](#public-api-auth).

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

Rate-limited responses include the retry delay in the HTTP `Retry-After` header (integer seconds, minimum 1) when the worker can compute one; the same header is sent with some `503` responses. The free Safety Score grades, dependency graph, and dependency scenarios routes return the same `429` shape to anonymous clients.

`POST /api/feedback` also has a form-specific limiter. Its `429` body is `{ "error": "Too many submissions. Please wait a few minutes." }`, and it should be handled as a local submission throttle rather than as a public API quota response. If the feedback limiter's D1 dependency is unavailable, the endpoint returns `503 Service Unavailable` with `{ "error": "Feedback service temporarily unavailable. Please try again." }` and `Retry-After: 60`.

API-key auth and quotas normally rely on D1. Protected cacheable `GET` edge-cache hits can use a recently verified standard key and an isolate-local limiter without D1; this counts hot hits per isolate, not globally. A cache miss still requires D1 authentication. If only limiter storage is unavailable after successful auth, cacheable standard-key reads can use the isolate fallback capped by `resolveIsolateFallbackApiKeyRateLimit()` (`worker/src/lib/api-key-rate-limit.ts`). Donor and self-serve keys never use these paths. Unavailable auth or a disallowed limiter fallback returns `503`, `{ "error": "Public API temporarily unavailable" }`, and `Retry-After: 60`. Best-effort usage updates do not fail successful reads.

### Retry Guidance

- Respect the `Retry-After` header when present
- Add random jitter (0–2 seconds) to avoid thundering-herd retries
- Use exponential backoff for sustained 429 responses
- Combine with the polling cadences in the section above to stay well under limits

## Error Response Conventions

JSON API handlers use `{ "error": "message" }` JSON format; some errors add `reason`, `message` or domain diagnostics (the generated OpenAPI `ApiError` schema requires only a string `error` and allows additional properties). `GET /api/og/*` returns `image/png` on success for known image routes; unknown OG route patterns return the normal JSON error body, while OG data/render failures inside known image routes can return `text/plain`.

| Status | Meaning               | When                                                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Bad Request           | Missing required parameters, invalid enum values, malformed numeric input, or out-of-range numeric/filter values on handlers that opt into rejection (`rangePolicy: "reject"`). Some endpoints intentionally clamp or default selected numeric params; endpoint sections call this out where it is part of the contract.                       |
| 401    | Unauthorized          | Public `/api/*` endpoint called without a valid `X-API-Key`, or admin endpoint called without a valid `ops-api` Access JWT (typically obtained through Cloudflare Access user login or service-token auth)                                                                                                                                     |
| 403    | Forbidden             | Disallowed CORS preflight from a foreign `Origin`, Pages ops proxy mutating request without a matching same-origin `Origin`, or mutating admin request missing `X-Pharos-Admin: 1`                                                                                                                                                             |
| 404    | Not Found             | Unknown stablecoin ID or missing resource                                                                                                                                                                                                                                                                                                      |
| 410    | Gone                  | Authenticated `GET https://api.pharos.watch/api/report-cards`, the retired unversioned Safety Score route (see [Full cards](#full-cards)) |
| 413    | Payload Too Large     | Public JSON `POST` body exceeds that endpoint's defensive byte cap before parsing or side effects                                                                                                                                                                                                                                              |
| 429    | Too Many Requests     | Rate limit exceeded (per-key public API limiter, anonymous Safety Score feed limiter, or feedback-specific limiter; feedback uses its own message body)                                                                                                                                                                                                                              |
| 500 | Internal Server Error | Unhandled handler exception caught by `withErrorHandler` or the router error boundary |
| 502    | Bad Gateway           | Upstream fetch failed (external data provider or Pages proxy upstream), or the ops proxy received a Cloudflare Access login redirect from `ops-api`                                                                                                                                                                                            |
| 503    | Service Unavailable   | Cache-passthrough endpoint where cache has never been populated, cached payload is corrupt / rejected by validation, a protected public API request cannot be authenticated from D1 or the recent verified-key cache, the feedback limiter/storage dependency fails, or `MAINTENANCE_MODE=true` (global kill switch via `wrangler secret put`) |
| 504 | Gateway Timeout | Pages `/_site-data/*` or `/api/admin/*` upstream timeout: 10 s default, with ops overrides from `opsProxyTimeoutMs` in `shared/lib/api-endpoints/definitions.ts` (including status reads and the longer yield-coverage audit) |

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
- `/api/backfill-dews` allows `GET` for the historical backtest and for `repair=...&dry-run=true` previews; mutating repair runs are `POST`-only.
- Unknown public `/api/*` requests can return `401` first when the API key is missing or invalid. After lane auth succeeds, unregistered paths return `404`, except authenticated `GET /api/report-cards` on the public API host, which returns `410` (see [Full cards](#full-cards)). Known paths with disallowed methods, including unsupported verbs, return `405` with the route's allowed methods in `Allow`, not a generic `GET, POST` fallback.

The same shared endpoint descriptors now also carry static worker dependency-hydration hints consumed by `worker/src/routes/registry.ts`, where the worker binds shared endpoint keys directly to handlers through a single static route-definition list. That keeps endpoint metadata, router behavior, method guards, admin status-page actions, and worker-side static route wiring aligned from one source of truth plus one worker binding table.

## Safety Score Availability

### Full cards

The retired unversioned `GET /api/report-cards` is not a redirect and not an active endpoint. With a valid `X-API-Key` on `https://api.pharos.watch` it returns `410` with `no-store` and `{ "error": "Endpoint retired", "reason": "endpoint_retired", "replacement": "/api/report-cards/v9", "documentation": "https://pharos.watch/api/reference/#safety-score-availability" }`. This is the migration pointer, not a compatible target: the v9 response schema is different, so update your client before switching. Missing or invalid keys still receive `401`, and dependency or quota failures keep their `503` / `429`.

[Safety Score contract](./report-cards.md#api). The route remains `/api/report-cards/v9`; current body `schemaVersion` is 9, wrapping public breakdown/publication schema 8 with score trace 4. Model-family/route naming, methodology decimal and body schema are distinct identities. Persisted public v6 is unavailable until a compatible accepted publication; no legacy route-key inference or fabricated cause defaults is allowed. The envelope's `openEvidence` block is computed once by `shared/lib/safety-score-v9/open-questions.ts` and is required but nullable: a report9 envelope sourced from a schema-7 publication publishes `openEvidence: null` with `openEvidenceUnavailableReason: "publication-predates-open-evidence"`, and consumers render the counts unavailable, never zero. Publication schema 8 always carries a present block; report8 and publication 7 are archive-only and require explicit historical dispatch. `openEvidenceUnavailableReason` is `null` whenever that block is present.

Each `cards[]` row publishes `ratingStatus: "rated" | "not-rated" | "pipeline-gap"`. Rated means numeric score and letter grade; not-rated means null score and `grade: "NR"` with causal withholding reasons. Pipeline-gap means null score and null grade, never NR, zero or F. At least two included pillars are needed for a Safety Score. Exactly one A/B-only excluded pillar permits a two-pillar rating; two or three give technical pipeline-gap. Pipeline-gap keeps diagnostic breakdowns and null aggregate/stages/weakest pillar, with no binding cap. Since methodology 10.26 a rated card may carry optional `gradeHold: { rawGrade, heldFromGenerationId }`: its letter grade is the previously published one, retained until two consecutive publications compute the new band `rawGrade`; `score` is always raw. Compact `/api/safety-grades` rows carry the published grade.

`partialEvidence` is null or `{ reasonCode: "partial-evidence-pipeline-gap", excludedPillars, excludedComponentKeys, causeGapRefs, causes }`. Pillars are `backing | exit | control`; causes are A/B only. It is non-null when an A/B gap is promoted from a pillar's exclusion inventory or from a peg/methodology constraint, wrapper-local fact or inherited parent partial exclusion. Subcomponent exclusions can leave no whole pillar excluded. The Exit inventory does not promote route-exclusive A/B facts from an unscored optional alternative: the alternative is neither primary nor diversification, has no admitted score or scored components, and excludes no route or factor component. If no primary is admitted, this exception additionally requires an independent barrier on the same route: explicitly rejected same-notional output eligibility (for a non-output gap), or diagnostic coverage with a distinct unresolved capacity/settlement factor carrying C/U proof. An A/B datum that is itself the only admission blocker remains a partial-evidence trigger. Those filtered gaps remain diagnostic in the route evidence and gap tables. A/B facts on the primary, admitted alternatives with excluded components, whole-pillar exclusions and non-route inventory gaps retain their triggers. `causeGapRefs` are sorted unique numeric indexes into the card's local-then-foreign gap table; resolve IDs with `resolveCauseGapId()` (`shared/types/safety-score-v9-public-cause-gaps.ts`). Partial does not itself mean NR; mixed components retain known/C/U/D contributions.

Pillars carry `aggregationDisposition: "included" | "excluded-a-b"`, `causeGapRefs`, `limitedEvidenceCauses` and `supportedComponentKeys`. Excluded scores are null; aggregation renormalizes `effectiveScoringWeights` across included pillars, with zero weight for exclusions. Contributions retain `cause`, `causeGapRefs`, `scoringDisposition` and `effectiveScoringWeight`: A/B is diagnostic null/zero weight, C/U is bounded uncertainty, admitted D is measured adverse. A requires captured pipeline proof; B requires current scoped public-data research; C is researched non-disclosure; U is not yet researched. Responsibility alone is not proof.

Exit breakdowns add `confidenceDimensions: { observation, model, capacityMethod }`; dimensions have `factor` plus optional `cause` and numeric `causeGapRefs`. A/B-missing dimensions are neutral (factor 1); known weaker models and C/U retain their factors. `confidenceFactor` is their minimum. `capacityEvidenceTier` distinguishes `live-direct`, `live-queue-proxy`, `documented`, `heuristic` and `unknown`; verified live queue/proxy uses method factor 0.75. Diagnostic routes may have null dimensions. Neutral confidence never admits stale capacity or an invalid certificate, nor implies eligibility, zero fee or executable output.

Primary and alternative Exit breakdown rows require `routeId` and `lane` (`dex` or `redemption`) alongside opaque `key`. Reconciliation uses the exact configured redemption ID and redemption lane, never key prefix/suffix guessing. These fields identify the observed rail; they do not imply admitted capacity, cost, settlement or independent liquidity.

`completeness` adds `pipelineGapCount` and sorted unique `pipelineGapIds`. `expectedCount = ratedCount + notRatedCount + pipelineGapCount`; not-rated and pipeline-gap membership is disjoint and matches the cards. Do not derive NR count from every null score. Reserve breakdowns preserve `wholeAssetWeight` independently of `effectiveScoringWeight`; A/B tail exclusion never rescales dependency or materiality exposure.

Retained old schema publications require explicit historical dispatch or refusal, never invented A/B defaults. Current consumers preserve status and partial metadata rather than treating a null score as a downgrade. Existing publication health/held headers remain a separate availability contract.

`openEvidence` is `{ semantics: "open-question-v1", totals, owners, reasons, documentation, issuer, byCard }`, part of the digest-covered publication payload projected into the report9 envelope; the field is required but nullable, and `openEvidenceUnavailableReason` names `"publication-predates-open-evidence"` when a schema-7 source leaves it null. `totals` carries `questions` (the headline), its disjoint partition `open` / `issuer` / `documentation` (summing to `questions` under documentation > issuer > open precedence), and `obligations`, the per-card evidence-obligation total with measured-adverse (cause D) facts excluded. `owners[]` partitions the open bucket only (`Σ questions = totals.open`; `responsibility: "mixed"` is the multi-owner remainder) and carries `{ responsibility, questions, obligations }`. `reasons[]` carries `{ code, bucket, questions, obligations }`; `documentation` carries `{ questions, datums, facts, reasons[] }`; `issuer` carries `questions`, `assets`, and the paired review window `oldestReviewedAtSec` / `newestReviewedAtSec` (both null when no review is dated). `byCard[]` carries `{ id, openBucketQuestionsCarried, inheritedOpenBucketQuestionsCarried, openBucketObligationsCarried, documentationObligationsCarried }`, optional `issuerNondisclosureReviewedAtSec`, and optional `documentationOnlyLimited`: the sorted unique pillars (`backing`, `control`, `exit`) limited only by documentation gaps, omitted (never `[]`) when no pillar qualifies. The `openBucket*` counters cover the headline open bucket only, with `inheritedOpenBucketQuestionsCarried` its other-root subset; `documentationObligationsCarried` counts documentation-classed obligations from any bucket, and issuer obligations are not published per card. A card absent from `byCard` while `openEvidence` is present carried zero obligations; a present card is measured. The site detail projection mirrors `documentationOnlyLimited` as an optional top-level field. Counting changes no `evidenceLevel`, cause, cap or score input. Consumers must render a null block as unavailable, never zero, and public copy maps cause A to "data pipeline unavailable", keeping the technical `pipeline-gap` status distinct.

The standalone redemption contract is described in [Redemption Backstops](./redemption-backstops.md#api-endpoint). Its optional `capacityRejectionReason` names canonical reserve or route admission failures, including missing/malformed/stale evidence, payout mismatch and unproven completion. `output-valuation-unobserved` and `all-in-cost-unobserved` distinguish missing valuation or execution cost from an unobserved native amount. Output-cache valuation keeps the original cache-generation clock, never the publication clock. Null capacity is unavailable, not measured zero. Only complete valid immutable runs are served; malformed or missing required details reject a whole run, with atomic earlier-run fallback retaining that run's clock/methodology, or `503` when none survives. Named row-drop reasons remain operator diagnostics, not partial public-row salvage.

### Free grades

`/api/safety-grades` returns compact Safety Score availability rows from the same accepted publication, without an API key. The changed response adds `schemaVersion: 1`; each `grades[]` row carries `id`, nullable `score`, nullable `grade`, `ratingStatus` and nullable compact `partialEvidence`. Compact partial metadata contains only `reasonCode`, `excludedPillars` and A/B `causes`, not full component/gap lists. Rated rows have a numeric score and letter grade; not-rated rows have null score and `"NR"`; pipeline-gap rows have null score and null grade. A partial rated result can omit one pillar. Technical availability is not an NR grade, a zero score or a historical downgrade. `methodologyVersion`, `asOfSec`, `updatedAt` and `publicationStatus` describe the same snapshot as the full cards. `X-Safety-Score-Status` is `current`, `held`, or `stale` once the publication exceeds `X-Safety-Score-Freshness-Budget` (7,200 seconds); see [Safety Score contract](./report-cards.md#api).

### Dependency graph

[Graph contract](./dependency-map.md). Current response body `schemaVersion` is 2; path and operation ID remain `/api/dependency-graph/v1` and `dependencyGraphV1`. Nodes preserve published `ratingStatus`, nullable grade/score and compact partial metadata. Pipeline-gap is technical unavailability, not NR; null parent scores do not become zero or perfect support. Graph exposure still uses original admitted whole-asset weights. No alternate scoring authority or on-demand evaluator is introduced.

### Dependency scenarios

[Modeled results](./dependency-map.md). Current response/artifact body `schemaVersion` is 2 and scenario cache generation is v2; the route remains `/api/dependency-scenarios/v1` with operation ID `dependencyScenariosV1`. Published and modeled technical pipeline-gap scores/grades stay null and distinct from NR; deltas involving unavailable numeric values remain null, never zero or a fabricated downgrade. Status and partial metadata survive parent propagation. These generation-bound offline artifacts remain noncanonical modeled scenarios, not forecasts or changes to accepted Safety Scores. Old artifacts require explicit historical version dispatch or refusal, never relabelling a v1 artifact under a v2 cache key.

## Reserve Availability

For `GET /api/stablecoin-reserves/{stablecoinId}`, optional `sync.collectionEligibility` is `{ scheduled, reason }` with successful-response reasons `active`, `quarantined`, `frozen`, or `delisted`; only active is scheduled. Suspended, unconfigured and pre-launch assets return `404`, not additional eligibility values. Readable inactive configurations may serve retained historical evidence without refreshing its clocks or admitting it to active collection. See the [reserve API contract](./live-reserves.md#api-contract).

## Blacklist Valuation Availability

`GET /api/blacklist-summary` publishes `stats.destroyedTotal`, `recentFreezeAmount24hUsd`, `recentFreezeAmount7dUsd`, and values in `perCoinFrozenTotal` / `perCoinDestroyedTotal` as `number | null`. Null means valuation unavailable, not zero. Mixed cohorts publish only the known subtotal: optional `stats.valuationCoverage` qualifies `destroyed`, `recent24h`, `recent7d`, `perCoinFrozen`, and `perCoinDestroyed` with `{ knownCount, unavailableCount }`. A positive unavailable count makes that subtotal partial; absent coverage means unknown completeness. Fully priced cohorts and observed zero remain numeric, including zero for an empty cohort.

Compatibility `activeFrozenTotal` and `activeAmountGapCount` use the last successful ledger value, including observed zero, for net-active addresses even after a provider refresh fails. Failure and original-observation freshness remain visible in `freezeLedgerMeta`; a failed first read is not evidence of zero. Released/destroyed records do not enter the active frozen total, while their retained snapshots still contribute to the distinct historical `trackedFrozenTotal`.

Producer-written `blacklist-summary` snapshots also publish optional `refresh: { observedAt, behindConfigs[] }`: when the scheduled producer rebuilt the observed totals, and each config (`configKey`, `symbol`, `chainName`, nullable `lastSucceededAt`) that did not reach its safe head that run. The freshness headers keep the oldest full-coverage clock; `refresh` lets clients say which sources hold it back rather than calling the whole tracker stalled. Absent `refresh` (request-path materialization) means no producer catch-up detail.

## Mint-Burn Scan Availability

`GET /api/mint-burn-flows` publishes exact signed 24h/7d/30d/90d windows only with continuous current-fingerprint finalized scan proof on every required config and chain. Window boundaries use closed UTC hours. Each coin's `coverage.windows` records independent `window24h`, `window7d`, `window30d` and `window90d` admission as `{ complete, unavailableReason }`; incomplete evidence has reason `scan-coverage-incomplete` and a null signed net, direction and pressure. Valuation remains an independent qualifier. For deployed-reader compatibility, `has24hActivity` is null for every incomplete 24h scan, true for proved activity, and false only for proved quiet. Additive `observed24hActivity` preserves whether events were observed even without complete scan proof; false is not a quiet-window claim.

Counts and gross volumes are observed subtotals (`totalsSemantics: "observed-subtotals"`), not proof of full history. Per-coin requested totals, chains and hourly signed nets carry their own `scanCoverage`. The gauge score/band are null when a required 24h scan is incomplete. Versioned v5 aggregate/per-coin caches reject pre-cutover exact-zero claims; old sparse events and cursors never synthesize historical proof. See [scan and valuation admission](./mint-burn-flows.md#valuation-completeness). The shared schema owns coverage reasons and producer DTOs. PR-B's null-tolerant Pages readers remain compatible during normal Worker-before-Pages activation: incomplete scans keep the legacy null activity gate rather than enabling subtotal-derived bounds.

## Chain Supply Availability

`GET /api/chains` readers must accept `null` for `globalTotalUsd`, `chainAttributedTotalUsd`, `unattributedTotalUsd`, `attributionDiscrepancyUsd`, `dominanceGeometryTotalUsd` and each chain's `dominanceShare`. Null means unavailable, not observed zero: global supply is null only when neither aggregate nor chain supply was observed, attribution is null without an observed chain current, residual/discrepancy/geometry are null unless both totals exist, and shares are null unless global supply is positive. Derived ratios and conservation claims require their observed totals. Published chain rows and optional `chainDetail` retain numeric observed totals. The shared PharosVille chains contract uses the same schema: external consumers must deploy null guards before a producer introduces null values.

## Supply Provenance

`GET /api/stablecoins` exposes optional per-asset supply provenance on `peggedAssets[]`. The owning schemas are in `shared/types/market.ts`; [Supply Snapshot](./supply-snapshot.md#supply-pipeline) owns admission and carry limits.

| Optional field | Type | Meaning |
|---|---|---|
| `chainPartition` | object | Banded on-chain shares attached to a CoinGecko-detail cap, with `basis: "onchain-share"`, `observedAt` (Unix seconds of the original complete on-chain read), `onchainUsd` (that read's units × admitted supply price), `ratio` (on-chain USD / CoinGecko total at admission), and `admission: "entered" \| "retained" \| "carried"`. CoinGecko aggregate buckets, source and clock are unchanged. Unreadable legs or deadline-skipped reads may carry shares onto the fresh cap within the shared restore ceiling; whole-row supply restoration also labels valid partition evidence `carried`. Original observation fields remain unchanged, so no fresh read is claimed. Only prior `entered`/`retained` admission grants retain hysteresis; a fresh read after `carried` must pass entry. Canonical/escrow residuals remain unattributed. Absent provenance means no admitted on-chain share partition. |
| `supplyGapFill` | object | Bounded CoinGecko raise for one missing metadata chain identity. Carries `method: "coingecko-single-missing-chain"`, `admission: "entered" \| "retained"`, `missingChainId`, `canonicalSource: "defillama"`, `canonicalCurrentUsd`, `supplementalSource: "coingecko"`, `supplementalCurrentUsd`, `ratio`, `maxRatio`, and `observedAt`. Optional `carryForwardRuns` counts bounded no-decision carries. |
| `supplyGapFill.withheldHistoricalBuckets` | `("day" \| "week" \| "month")[]` | Non-empty when present; omitted when no historical bucket is withheld. Names the missing chain's historical buckets published as `null` because existing chain observations are incomplete or do not conserve the corresponding DefiLlama aggregate within `max($0.01, DL bucket × 1e-6)`, or because DefiLlama did not observe that aggregate bucket. Existing chain values are never scaled; an admitted aggregate bucket retains its CoinGecko series value, while an unobserved DefiLlama aggregate bucket stays unavailable. |
| `supplyGapFill.withheldHistoricalBucketReasons` | `Partial<Record<"day" \| "week" \| "month", "history-unobserved" \| "nonconserving">>` | Present exactly when `withheldHistoricalBuckets` is present; its keys equal those withheld buckets. `"history-unobserved"` means the DefiLlama aggregate bucket or any existing chain's bucket value is unobserved. `"nonconserving"` means all values were observed but the existing chains' sum differs from the DefiLlama aggregate beyond the conservation tolerance above. |
| `supplyChainGuard` | object | Chain-dropout evidence with `reason: "supply-chain-dropout"`, `status: "repaired" \| "quarantined" \| "unavailable" \| "chains-unavailable"`, optional `quarantinedSince` / `concurrentGainUsd`, optional `partialCoverage: true` (a material quarantine past the carry ceiling publishing the observed remainder without its unavailable chains), and `chains[]`. Each chain includes `chainLabel`, optional `chainId`, nullable `listCurrentUsd`, `baselineUsd`, `baselineObservedAt`, `baselineSource: "state" \| "seed" \| "list-prev-day"`, and `resolution: "onchain-total-supply" \| "defillama-chain-history" \| "carried-baseline" \| "unavailable"`, with optional `repairedCurrentUsd` / `observedAt`. |
| `supplyChainGuard.chains[].observedAtKind` | `"upstream" \| "local-read"` | Optional clock kind for chain repair evidence. Native issuer `onchain-total-supply` repairs use `"local-read"` with the sync-start run clock; DefiLlama chart repairs use `"upstream"` with the point date. Without quarantine, aggregate `supplyObservedAt` uses the oldest admitted upstream chart repair clock; native-only repairs preserve the incoming list clock or its absence, and mixed repairs use only chart clocks. Withheld repairs discard the repair clock/kind before any carried-baseline or unavailable outcome. An absent kind on older provenance is unknown, not proof of an upstream clock. |

The website-only `GET /api/stablecoin-live-summary/{stablecoinId}` projection and internal detail-snapshot inputs retain unavailable USD checkpoints as `{}` across `circulating`, `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth`. Numeric buckets are finite and nonnegative; explicit zero stays observed. Native `current`/`prevWeek`/`prevMonth` checkpoints are likewise finite and nonnegative or `null`. See [checkpoint admission](./supply-snapshot.md#supply-admission-and-nullable-helpers) for selection and malformed-history handling.

## Literal Event Search

`GET /api/events?q=...` matches a literal substring of the title, summary, or coin ID; `GET /api/blacklist?q=...` matches a literal address substring. Both trim and lowercase `q` before matching against SQLite-lowercased columns. Percent (`%`), underscore (`_`), and backslash are ordinary characters, not search wildcards. SQLite's existing ASCII case-folding behavior is retained; this is not Unicode case-insensitive search.

Tape keeps its 200-character normalized `q` limit (`400` above it); blacklist intentionally has no handler-level `q` length cap, so a 201-character query is admitted there. Neither search is truncated to work around D1's `LIKE` pattern ceiling.

Tape `type=freeze.*` and `class=freeze` select the literal dot-delimited prefix `freeze.` case-insensitively: they include `freeze.blacklisted`, not bare `freeze` or `freezeframe.blacklisted`. Underscores in admitted lowercase slug segments remain literal. Prefix matching does not impose a new length cap or use SQL pattern wildcards.

## Exact Event Lookup And Retractions

`GET /api/events?event=<id>` resolves one permalink independently of listing filters or pagination. Success keeps the normal events response with exactly one event, `nextCursor: null`, `total: 1` and `totalExact: true`; the ordinary listing mode is unchanged. The ID must contain 1–200 characters. Missing or invalid stored events return `404` with `{ "error": "Event not found", "reason": "event-not-found" }`.

Source-retracted freeze and large mint/burn claims are absent from lists, search and counts. Exact lookup returns `404`, `Cache-Control: no-store` and `{ "error": "Event not found", "reason": "freeze-claim-retracted" }` (or `"flow-claim-retracted"` for a large mint/burn claim), without an event body. There is no public tombstone representation. Deploy this additive Worker query mode before Pages switches permalink resolution to it.


## Public Endpoints

On `https://api.pharos.watch`, these routes require `X-API-Key` unless marked `Authentication: exempt`. [OpenAPI schemas](https://pharos.watch/openapi.json) describe bodies; `shared/lib/api-endpoints/definitions.ts` owns auth/cache flags.

`GET /api/stablecoin/{stablecoinId}` supply-history/stablecoins-cache fallbacks publish `_meta`: newest served token source time, response assessment time, 72-hour history budgets and stale floor `detail-history-fallback`. They emit `Warning: 110`, `Cache-Control: no-store`, and neither enqueue detail-cache publication nor renew old rows. Invalid/missing history clocks stay null/unknown with the timestamp-admission reason. Stale external history without fresher D1 rescue uses this same contract.

DefiLlama detail history is admitted only with a required `tokens` array, valid observation dates within the shared 60-second future-skew allowance, and at least one finite nonnegative observed supply bucket per checkpoint. Either USD or native observations suffice; both are not required. Malformed/missing history tries admitted D1 supply history and retained detail cache before returning an unavailable error. Empty or obsolete upstream history also uses the shared fallback path; it never becomes a newly fresh detail-cache publication. Legitimate provider passthrough fields survive admitted responses.

For all peg currencies, including USD, native `circulating` aliases normalize to `totalCirculating`, while observed `totalCirculatingUSD` and native buckets remain independent. Missing unit representations stay unavailable: today's detail price and nominal peg parity never revalue historical observations or fill their gaps. Canonical current-list supply enrichment is unchanged.

`GET /api/mint-burn-flows` aggregate/per-coin `_meta` preserves the confirmed-output lookup verdict through cached fallbacks. Missing/failed lookup cannot substitute attempt/event-hour clocks for `sync.lastSuccessfulSyncAt`; unavailable metadata and headers retain their machine-readable reason.

Aggregate FTQ also publishes `gauge.classificationReason` and independent `_meta.dependencies.flightToQuality` Safety Score evidence (`generationId`, original `updatedAt`, `ageSeconds`, `status`, `reason`, `freshBudgetSec`). Unavailable classification yields `flightToQuality: null` / `flightIntensity: null`, never inactive/zero. A withheld verdict names its cause in `gauge.flightToQualityReason` (`valuation-incomplete`, `flow-window-unavailable`, `cohort-member-unpublished`) and lists the classified coins excluded because their whole flow is pending mint/burn admission in `gauge.flightToQualityExcludedIds`; both fields are absent on payloads produced before they existed. Fresh, cached and fallback paths re-admit the canonical index and expose the same advisory without renewing the flow clock; per-coin responses have no market-wide FTQ dependency. See [FTQ classification](./mint-burn-flows.md#registry-ownership) for the separate consumer budget and recovery semantics.

`GET /api/stablecoin-summary/{stablecoinId}`: `supplyUsd` fields `current`, `prevDay`, `prevWeek`, `prevMonth`, `change1d`, `change7d`, `change30d` are `number | null`. Absent/empty/wholly invalid current peg buckets yield null `current` and `currentUnavailableReason: "supply-buckets-missing"`; observed supply, including `0`, clears the reason to null. Changes require observed current and historical values; missing current never implies a negative delta. `supplyByPegUsd` contains only finite buckets (`{}` if none). Assets absent from the stablecoins publication return `404`.
`GET /api/dex-liquidity` and history publish nullable `totalVolume24hUsd`, `totalVolume7dUsd`, history `volume24h`, pool `volumeUsd1d` and `scoreComponents.volumeActivity`. [Measured volume availability (v6.9)](./dex-liquidity.md#measured-volume-availability) owns 72h admission, complete-only totals, availability-record fields, measured zero, global/legacy rows and the 50% activity/score coverage gate. Each `/api/dex-liquidity` row also carries optional `liquidityScoreUnavailableReason`: `null` when rated, otherwise the machine code of whoever nulled the score — `activity-coverage-below-floor`, `activity-missing`, `activity-stale`, `activity-completeness-unknown`, `no-retained-pools`, or `invalid-coverage-evidence` (publisher quarantine). Rows scored before the field existed publish `null`; consumers must not infer a cause. See [DEX Liquidity Score](./dex-liquidity.md#dex-liquidity-score).
`GET /api/dex-liquidity` also publishes `balanceMeasuredTvlUsd` and `organicMeasuredTvlUsd` as `number | null`. Null is unavailable measurement weight, including legacy rows, not measured zero; numeric `0` remains valid. Consumers must require both a ratio/fraction and its independently observed weight before weighted aggregation, and must not render missing coverage as 0%.
DEX [price publication](./dex-liquidity.md#dex-price-cross-validation). Malformed coverage is quarantined per asset/point, retaining independent measurements. Price admission, nullable fields and the separate 24h clock do not alter liquidity `X-Data-Age`.
`GET /api/mint-burn-flows` valuation-gated nullable fields: aggregate `coins[]`: `netFlow24hUsd`, `netFlow7dUsd`, `netFlow30dUsd`, `netFlow90dUsd`, `netFlowDirection24h`; `chains[].netFlow24hUsd`, `hourly[].netFlowUsd`, `gauge.flightToQuality`, `gauge.flightIntensity`; per-coin `netFlowUsd`, `chains[].netFlowUsd`. [Valuation completeness (v6.23)](./mint-burn-flows.md#valuation-completeness) owns gates, exact/partial/legacy semantics and gauge reweighting. `valuation` shapes: coin `{ window24h, baseline, netFlow7d, netFlow30d, netFlow90d, netFlow7dBound?, netFlow30dBound?, netFlow90dBound? }` (v6.25 bounds: `{ kind: "lower" | "upper", valueUsd }` or `null`; a proven one-sided bound on a withheld net); aggregate chain/hourly completeness labels; per-coin totals/chains `{ completeness, mintCompleteness, burnCompleteness, unpricedMintEventCount, unpricedBurnEventCount }`. Absent records are `unknown`, never complete.
`GET /api/stablecoin-charts` retains invalid/omitted buckets as null, explicit zero as zero; see [chart publication](./supply-snapshot.md#supply-pipeline).

`GET /api/supply-history?stablecoin=<id>&range=all` returns every retained daily row for one admitted coin in chronological order, with no sliding day cutoff. It uses the same inclusive completed-snapshot fence and producer freshness headers as bounded history, preserving nullable observations and observed zero. Omit `days` in this mode: supplying both is rejected. Missing `range` keeps the existing `days` contract (default 365, bounds 1–5000); empty or non-`all` range values return `400`. The website's `1Y` requests `days=365`, while `All` uses a distinct `range=all` query/cache identity. Ship the additive Worker admission before the Pages cutover; an old Worker ignores this parameter and silently serves its bounded default. Every row also carries `supplyProvenance` (Pricing v6.59, migration 0287): the daily writer's validated `{ supplySource, supplyObservedAt, supplyChainGuard }`, or `null` when coverage was not recorded (legacy, prior-Worker or backfill rows, malformed metadata). Null is unknown coverage, never complete; a guard with `partialCoverage` (or `chains-unavailable` with an `unavailable` chain) marks a numeric remainder that excludes those chains.

<!-- GENERATED-START: public-endpoints -->
<!-- Generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json and shared/lib/api-endpoints/definitions.ts. -->
<!-- Endpoint narratives are authored in scripts/lib/public-api-artifact-catalog.ts and emitted through OpenAPI. Supplemental notes and source-backed examples live in the generator. Do not edit this block by hand. -->

### Public Endpoints Quick Reference

Generated from `public/openapi.json` (`Pharos API` v1.0.0). Total OpenAPI operations: **42**.

| Method | Path | Summary | Tags | Auth | Parameters | Status codes |
| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |
| GET | `/api/events` | Tape events | Risk | `X-API-Key` required | `event` (query, optional, string); `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoins` | List stablecoins | Stablecoins | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin/{stablecoinId}` | Stablecoin detail | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-summary/{stablecoinId}` | Stablecoin summary | Stablecoins | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/non-usd-share` | Non-USD share | Market Structure, History | `X-API-Key` required | `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/chains` | Chains | Chains | `X-API-Key` required | `chain` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-reserves/{stablecoinId}` | Stablecoin reserves | Stablecoins, Reserves | `X-API-Key` required | `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/stablecoin-charts` | Stablecoin charts | Stablecoins, History | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/blacklist` | Blacklist events | Blacklist | `X-API-Key` required | `stablecoin` (query, optional, string); `chain` (query, optional, string); `chainId` (query, optional, string); `eventType` (query, optional, string); `q` (query, optional, string); `sortBy` (query, optional, string); `sortDirection` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `includeTotal` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/blacklist-summary` | Blacklist summary | Blacklist | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-events` | Depeg incidents | Peg Monitoring | `X-API-Key` required | `stablecoin` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `active` (query, optional, boolean); `includeTotal` (query, optional, boolean); `includePending` (query, optional, boolean) | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver` | Depeg Duration Resolver | Risk, Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/depeg-resolver-review` | Depeg Duration Resolver Reviewer | Risk, Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/peg-summary` | Peg summary | Peg Monitoring | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/usds-status` | USDS freeze status | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/bluechip-ratings` | Bluechip ratings | Risk | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity` | DEX liquidity | Liquidity | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/dex-liquidity-history` | DEX liquidity history | Liquidity, History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/supply-history` | Supply history | History | `X-API-Key` required | `stablecoin` (query, required, string); `days` (query, optional, integer); `range` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/daily-digest` | Daily digest | Digest | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/digest-archive` | Digest archive | Digest | `X-API-Key` required | `history` (query, optional, string); `cursor` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/digest-snapshot` | Digest snapshot | Digest | `X-API-Key` required | `date` (query, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/index` | Public snapshot index | Digest | `X-API-Key` required | `limit` (query, optional, integer); `cursor` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshots/{date}.json` | Public snapshot for a single day | Digest, History | `X-API-Key` required | `date` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/snapshot/{date}/stablecoin/{stablecoinId}` | Public snapshot projection for a single coin | Digest, Stablecoins, History | `X-API-Key` required | `date` (path, required, string); `stablecoinId` (path, required, string) | 200, 400, 401, 429, 503 |
| GET | `/api/health` | Health check | Health | exempt | — | 200, 400, 503 |
| GET | `/api/public-status-history` | Public status history | Status | `X-API-Key` required | `limit` (query, optional, integer); `window` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/telegram-pulse` | Telegram pulse | Status | `X-API-Key` required | — | 200, 400, 401, 429, 503 |
| GET | `/api/stability-index` | Pharos Stability Index | Risk | `X-API-Key` required | `detail` (query, optional, boolean); `days` (query, optional, integer) | 200, 400, 401, 429, 503 |
| GET | `/api/report-cards/v9` | Safety Score V9 report cards | Risk | `X-API-Key` required | `freshness` (query, optional, string) | 200, 400, 401, 429, 503 |
| GET | `/api/safety-grades` | Safety Score grades (no key) | Risk | exempt | — | 200, 400, 429, 503 |
| GET | `/api/dependency-graph/v1` | Dependency graph (no key) | Risk | exempt | — | 200, 400, 429, 503 |
| GET | `/api/dependency-scenarios/v1` | Modeled dependency scenarios (no key) | Risk | exempt | — | 200, 400, 429, 503 |
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

Materialized chronological feed of typed events (depeg, freeze, score) backed by the tape_events table. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1events/get).

- **Operation ID:** `events`
- **Path:** `/api/events`
- **Parameters:** `event` (query, optional, string); `type` (query, optional, string); `class` (query, optional, string); `coin` (query, optional, string); `pegCurrency` (query, optional, string); `chain` (query, optional, string); `q` (query, optional, string); `severityFloor` (query, optional, string); `since` (query, optional, integer); `until` (query, optional, integer); `cursor` (query, optional, string); `limit` (query, optional, integer); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`TapeEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/TapeEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoins`

Current stablecoin list with supply, price, peg, chain distribution, FX context, and freshness headers. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoins/get).

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

Full current/historical per-coin analytics dossier for a canonical Pharos stablecoin ID. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoin~1{stablecoinId}/get).

- **Operation ID:** `stablecoinStablecoinId`
- **Path:** `/api/stablecoin/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinDetailResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinDetailResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoin-summary/:id`

Lightweight per-coin price and aggregate supply snapshot. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoin-summary~1{stablecoinId}/get).

- **Operation ID:** `stablecoinSummaryStablecoinId`
- **Path:** `/api/stablecoin-summary/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/non-usd-share`

Current and historical market share of tracked non-USD peg groups for market-structure views. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1non-usd-share/get).

- **Operation ID:** `nonUsdShare`
- **Path:** `/api/non-usd-share`
- **Parameters:** `days` (query, optional, integer)
- **Success response schema:** [`NonUsdShareResponse`](https://pharos.watch/openapi.json#/components/schemas/NonUsdShareResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/chains`

Chain-level stablecoin aggregates with Chain Health Scores; pass `chain` for full per-chain coin detail rows. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1chains/get).

- **Operation ID:** `chains`
- **Path:** `/api/chains`
- **Parameters:** `chain` (query, optional, string)
- **Success response schema:** [`ChainsResponse`](https://pharos.watch/openapi.json#/components/schemas/ChainsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Source-backed chain methodology example**

```json
{
  "healthMethodologyVersion": "1.8"
}
```

### `GET /api/stablecoin-reserves/:id`

Live or fallback reserve composition and reviewed provenance for live-reserve-enabled assets. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoin-reserves~1{stablecoinId}/get).

- **Operation ID:** `stablecoinReservesStablecoinId`
- **Path:** `/api/stablecoin-reserves/{stablecoinId}`
- **Parameters:** `stablecoinId` (path, required, string)
- **Success response schema:** [`StablecoinReservesResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinReservesResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stablecoin-charts`

Historical total supply chart data. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoin-charts/get).

- **Operation ID:** `stablecoinCharts`
- **Path:** `/api/stablecoin-charts`
- **Parameters:** None.
- **Success response schema:** [`StablecoinChartResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinChartResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/blacklist`

Normalized issuer freeze, unfreeze, blacklist, and destruction events with optional uppercase symbol, chain display-name or chain ID, event type, search, sort, exact-count, and pagination filters. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1blacklist/get).

- **Operation ID:** `blacklist`
- **Path:** `/api/blacklist`
- **Parameters:** `stablecoin` (query, optional, string); `chain` (query, optional, string); `chainId` (query, optional, string); `eventType` (query, optional, string); `q` (query, optional, string); `sortBy` (query, optional, string); `sortDirection` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`BlacklistResponse`](https://pharos.watch/openapi.json#/components/schemas/BlacklistResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "4.62",
  "currentVersionLabel": "v4.62"
}
```

### `GET /api/blacklist-summary`

Blacklist summary statistics, chart data, chain options, manifest-derived coverage metadata, and freeze-ledger data-quality context. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1blacklist-summary/get).

- **Operation ID:** `blacklistSummary`
- **Path:** `/api/blacklist-summary`
- **Parameters:** None.
- **Success response schema:** [`BlacklistSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/BlacklistSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/depeg-events`

Historical and active depeg incidents with constituent threshold-crossing counts, filterable by asset, state, and review verdict. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1depeg-events/get).

- **Operation ID:** `depegEvents`
- **Path:** `/api/depeg-events`
- **Parameters:** `stablecoin` (query, optional, string); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `active` (query, optional, boolean); `includeTotal` (query, optional, boolean); `includePending` (query, optional, boolean)
- **Success response schema:** [`DepegEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/DepegEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "6.41"
}
```

### `GET /api/depeg-resolver`

Per active confirmed depeg: a mechanistic resolution outlook (terminal vs recoverable) and a stratified empirical duration estimate with per-horizon resolution likelihood. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1depeg-resolver/get).

- **Operation ID:** `depegResolver`
- **Path:** `/api/depeg-resolver`
- **Parameters:** None.
- **Success response schema:** [`DdrResponse`](https://pharos.watch/openapi.json#/components/schemas/DdrResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/depeg-resolver-review`

Review of stored DDR predictions against later depeg-event outcomes, including recovery-likelihood accuracy and observed-minus-predicted recovery duration error. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1depeg-resolver-review/get).

- **Operation ID:** `depegResolverReview`
- **Path:** `/api/depeg-resolver-review`
- **Parameters:** None.
- **Success response schema:** [`DdrrResponse`](https://pharos.watch/openapi.json#/components/schemas/DdrrResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/peg-summary`

Per-coin peg scores, reference evidence, coverage-aware recent metrics, and aggregate peg-monitoring summary. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1peg-summary/get).

- **Operation ID:** `pegSummary`
- **Path:** `/api/peg-summary`
- **Parameters:** None.
- **Success response schema:** [`PegSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/PegSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "6.41"
}
```

### `GET /api/usds-status`

Sky/USDS protocol status, including whether the freeze module is currently active. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1usds-status/get).

- **Operation ID:** `usdsStatus`
- **Path:** `/api/usds-status`
- **Parameters:** None.
- **Success response schema:** [`UsdsStatusResponse`](https://pharos.watch/openapi.json#/components/schemas/UsdsStatusResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/bluechip-ratings`

Safety ratings from bluechip.org joined to Pharos identities for covered stablecoins. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1bluechip-ratings/get).

- **Operation ID:** `bluechipRatings`
- **Path:** `/api/bluechip-ratings`
- **Parameters:** None.
- **Success response schema:** [`BluechipRatingsResponse`](https://pharos.watch/openapi.json#/components/schemas/BluechipRatingsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dex-liquidity`

DEX liquidity scores, top pools, chain/protocol breakdowns, and quality metadata. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1dex-liquidity/get).

- **Operation ID:** `dexLiquidity`
- **Path:** `/api/dex-liquidity`
- **Parameters:** None.
- **Success response schema:** [`DexLiquidityResponse`](https://pharos.watch/openapi.json#/components/schemas/DexLiquidityResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dex-liquidity-history`

Bounded historical liquidity-score data for a stablecoin. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1dex-liquidity-history/get).

- **Operation ID:** `dexLiquidityHistory`
- **Path:** `/api/dex-liquidity-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`DexLiquidityHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/DexLiquidityHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/supply-history`

Historical supply series for a stablecoin. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1supply-history/get).

- **Operation ID:** `supplyHistory`
- **Path:** `/api/supply-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer); `range` (query, optional, string)
- **Success response schema:** [`SupplyHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/SupplyHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/daily-digest`

Latest AI-generated stablecoin market digest. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1daily-digest/get).

- **Operation ID:** `dailyDigest`
- **Path:** `/api/daily-digest`
- **Parameters:** None.
- **Success response schema:** [`DailyDigestResponse`](https://pharos.watch/openapi.json#/components/schemas/DailyDigestResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/digest-archive`

Daily and weekly digest archive. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1digest-archive/get).

- **Operation ID:** `digestArchive`
- **Path:** `/api/digest-archive`
- **Parameters:** `history` (query, optional, string); `cursor` (query, optional, string)
- **Success response schema:** [`DigestArchiveResponse`](https://pharos.watch/openapi.json#/components/schemas/DigestArchiveResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/digest-snapshot`

Build-time digest context snapshot for a specific digest date. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1digest-snapshot/get).

- **Operation ID:** `digestSnapshot`
- **Path:** `/api/digest-snapshot`
- **Parameters:** `date` (query, required, string)
- **Success response schema:** [`DigestSnapshotResponse`](https://pharos.watch/openapi.json#/components/schemas/DigestSnapshotResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshots/index`

Listing of available daily public snapshots with content hashes and methodology versions, newest first. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1snapshots~1index/get).

- **Operation ID:** `snapshotsIndex`
- **Path:** `/api/snapshots/index`
- **Parameters:** `limit` (query, optional, integer); `cursor` (query, optional, string)
- **Success response schema:** [`SnapshotsIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/SnapshotsIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshots/:date.json`

Full per-day public dataset snapshot (camelCase). [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1snapshots~1{date}.json/get).

- **Operation ID:** `snapshotsDateJson`
- **Path:** `/api/snapshots/{date}.json`
- **Parameters:** `date` (path, required, string)
- **Success response schema:** [`JsonValue`](https://pharos.watch/openapi.json#/components/schemas/JsonValue)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/snapshot/:date/stablecoin/:id`

Per-coin slice of a daily snapshot (camelCase). [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1snapshot~1{date}~1stablecoin~1{stablecoinId}/get).

- **Operation ID:** `snapshotDateStablecoinStablecoinId`
- **Path:** `/api/snapshot/{date}/stablecoin/{stablecoinId}`
- **Parameters:** `date` (path, required, string); `stablecoinId` (path, required, string)
- **Success response schema:** [`SnapshotCoinResponse`](https://pharos.watch/openapi.json#/components/schemas/SnapshotCoinResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/health`

No-key availability canary for the public API host; it is not the operator status dashboard. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1health/get).

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
      "maxAge": 7200,
      "endpointMaxAge": 7200,
      "producerIntervalSec": 7200
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

Bounded, public-safe status timeline for the Pharos system. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1public-status-history/get).

- **Operation ID:** `publicStatusHistory`
- **Path:** `/api/public-status-history`
- **Parameters:** `limit` (query, optional, integer); `window` (query, optional, string)
- **Success response schema:** [`PublicStatusHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/PublicStatusHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/telegram-pulse`

Lightweight public Telegram adoption and delivery-health aggregates. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1telegram-pulse/get).

- **Operation ID:** `telegramPulse`
- **Path:** `/api/telegram-pulse`
- **Parameters:** None.
- **Success response schema:** [`TelegramPulseResponse`](https://pharos.watch/openapi.json#/components/schemas/TelegramPulseResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stability-index`

PSI and history. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stability-index/get).

- **Operation ID:** `stabilityIndex`
- **Path:** `/api/stability-index`
- **Parameters:** `detail` (query, optional, boolean); `days` (query, optional, integer)
- **Success response schema:** [`StabilityIndexResponse`](https://pharos.watch/openapi.json#/components/schemas/StabilityIndexResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "3.67",
  "methodologyVersion": "3.67"
}
```

### `GET /api/og/*`

Dynamic social-card PNGs, omitted from OpenAPI. Unavailable inputs stay unavailable; labels keep source time; freshness headers name budget and generation ([OG Images](./og-images.md#8-dynamic-worker-cards-apiog)). `/api/og/page/:slug` serves a stamped route figure, or the route's timeless card (`200`, `X-Og-Reason`) when its source is missing, stale, held or failing.

- **Path:** `/api/og/*`
- **Parameters:** Route-specific path segments select the supported image family.
- **Success response schema:** PNG image bytes; not represented by a JSON component schema.
- **Policy:** API-key authentication exempt; route-specific response caching.

### `GET /api/report-cards/v9`

Canonical API schema-8 Safety Score report cards from the accepted internal schema-7 publication. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1report-cards~1v9/get).

- **Operation ID:** `reportCardsV9`
- **Path:** `/api/report-cards/v9`
- **Parameters:** `freshness` (query, optional, string)
- **Success response schema:** [`ReportCardsV9Response`](https://pharos.watch/openapi.json#/components/schemas/ReportCardsV9Response)
- **Policy:** authentication `X-API-Key` required; bypass shared endpoint caching (`cacheBypass: true`).

### `GET /api/safety-grades`

Free schema-1, no-key projection of the accepted V9 publication: nullable score/grade, ratingStatus and compact partialEvidence per tracked stablecoin, plus methodology version and publication status. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1safety-grades/get).

- **Operation ID:** `safetyGrades`
- **Path:** `/api/safety-grades`
- **Parameters:** None.
- **Success response schema:** [`SafetyGradesResponse`](https://pharos.watch/openapi.json#/components/schemas/SafetyGradesResponse)
- **Policy:** authentication exempt; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dependency-graph/v1`

Free schema-2 projection of the accepted V9 publication: publication-bound node supply, nullable grades, ratingStatus, compact partialEvidence, role summaries and coverage counts, with the published dependency edges unchanged. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1dependency-graph~1v1/get).

- **Operation ID:** `dependencyGraphV1`
- **Path:** `/api/dependency-graph/v1`
- **Parameters:** None.
- **Success response schema:** [`DependencyGraphResponse`](https://pharos.watch/openapi.json#/components/schemas/DependencyGraphResponse)
- **Policy:** authentication exempt; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/dependency-scenarios/v1`

Offline schema-2 production-evaluator scenarios from a V9 publication, refreshed daily. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1dependency-scenarios~1v1/get).

- **Operation ID:** `dependencyScenariosV1`
- **Path:** `/api/dependency-scenarios/v1`
- **Parameters:** None.
- **Success response schema:** [`DependencyScenariosResponse`](https://pharos.watch/openapi.json#/components/schemas/DependencyScenariosResponse)
- **Policy:** authentication exempt; bypass shared endpoint caching (`cacheBypass: true`).

### `GET /api/redemption-backstops`

Modeled issuer/protocol redemption routes and effective-exit scoring for configured assets. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1redemption-backstops/get).

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
    "version": "4.53",
    "versionLabel": "v4.53",
    "currentVersion": "4.53",
    "currentVersionLabel": "v4.53",
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

Legacy bounded long-range safety-score history for a stablecoin. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1safety-score-history/get).

- **Operation ID:** `safetyScoreHistory`
- **Path:** `/api/safety-score-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`SafetyScoreHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/SafetyScoreHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/safety-score-history-v2`

Boundary-aware safety-score history with full score-model identity and transition kinds; the legacy endpoint remains the V8 compatibility projection. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1safety-score-history-v2/get).

- **Operation ID:** `safetyScoreHistoryV2`
- **Path:** `/api/safety-score-history-v2`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer)
- **Success response schema:** [`SafetyScoreHistoryV2Response`](https://pharos.watch/openapi.json#/components/schemas/SafetyScoreHistoryV2Response)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/yield-rankings`

Yield-bearing stablecoin rankings with safety, benchmark-aware context, and optional publication/source-risk metadata fields. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1yield-rankings/get).

- **Operation ID:** `yieldRankings`
- **Path:** `/api/yield-rankings`
- **Parameters:** `projection` (query, optional, string)
- **Success response schema:** [`YieldRankingsResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldRankingsResponse), [`YieldRankingsSummaryResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldRankingsSummaryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "8.52",
  "methodologyVersion": "10.41"
}
```

### `GET /api/yield-adapter-manifest`

Machine-readable source-list manifest for every yield-bearing asset, including adapter family, exact runtime source key when known, source-key pattern for runtime-resolved or disabled strategies, label, chain/project hints, lifecycle state, and methodology version. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1yield-adapter-manifest/get).

- **Operation ID:** `yieldAdapterManifest`
- **Path:** `/api/yield-adapter-manifest`
- **Parameters:** None.
- **Success response schema:** [`YieldAdapterManifestResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldAdapterManifestResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "methodologyVersion": "v8.52"
}
```

### `GET /api/yield-history`

Historical yield observations for a stablecoin, with optional publication/source-risk metadata fields. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1yield-history/get).

- **Operation ID:** `yieldHistory`
- **Path:** `/api/yield-history`
- **Parameters:** `stablecoin` (query, required, string); `days` (query, optional, integer); `mode` (query, optional, string); `sourceKey` (query, optional, string)
- **Success response schema:** [`YieldHistoryResponse`](https://pharos.watch/openapi.json#/components/schemas/YieldHistoryResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

**Current methodology example**

```json
{
  "currentVersion": "8.52",
  "methodologyVersion": "8.52"
}
```

### `GET /api/mint-burn-flows`

Mint/burn flow aggregates and pressure for closed UTC hours, not a rolling partial-hour window. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1mint-burn-flows/get).

- **Operation ID:** `mintBurnFlows`
- **Path:** `/api/mint-burn-flows`
- **Parameters:** `stablecoin` (query, optional, string); `hours` (query, optional, integer)
- **Success response schema:** [`MintBurnFlowsResponse`](https://pharos.watch/openapi.json#/components/schemas/MintBurnFlowsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/mint-burn-events`

Normalized issuance event stream for supported stablecoins with cursor or offset pagination. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1mint-burn-events/get).

- **Operation ID:** `mintBurnEvents`
- **Path:** `/api/mint-burn-events`
- **Parameters:** `stablecoin` (query, required, string); `direction` (query, optional, string); `chain` (query, optional, string); `burnType` (query, optional, string); `scope` (query, optional, string); `minAmount` (query, optional, number); `limit` (query, optional, integer); `offset` (query, optional, integer); `cursor` (query, optional, string); `includeTotal` (query, optional, boolean)
- **Success response schema:** [`MintBurnEventsResponse`](https://pharos.watch/openapi.json#/components/schemas/MintBurnEventsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

### `GET /api/stress-signals`

DEWS-style stress signals for the stablecoin universe or one selected asset. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stress-signals/get).

- **Operation ID:** `stressSignals`
- **Path:** `/api/stress-signals`
- **Parameters:** `stablecoin` (query, optional, string); `days` (query, optional, integer)
- **Success response schema:** [`StressSignalsResponse`](https://pharos.watch/openapi.json#/components/schemas/StressSignalsResponse)
- **Policy:** authentication `X-API-Key` required; shared endpoint caching allowed (`cacheBypass: false`).

Freshness threshold: 1800 s.

**Current methodology example**

```json
{
  "currentVersion": "6.41",
  "methodologyVersion": "6.41"
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

These website-host routes are outside the public Worker API and OpenAPI catalogue. Their caller gate checks an allowlisted UI hostname from `Origin`, falling back to `Referer`, not strict same-origin equality; external integrations should use the Worker endpoints above.

### `GET /selector-snapshot/:sid`

Reads a Picker share artifact by its 32-character identifier after UI-caller-host, shape, and content-identifier checks. Trusted KV metadata admits server-verified snapshots; retained legacy snapshots can also be returned but are not upgraded to verified. First-read retention extension is best effort and never withholds an otherwise valid artifact.

### `POST /selector-snapshot`

Recomputes a Picker result from canonical source data and stores the share artifact under a server-computed identifier. The route applies the UI-caller-host gate and rejects oversized or invalid inputs.
