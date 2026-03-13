# Pharos API Reference

The Pharos API is a REST API served by a Cloudflare Worker backed by a D1 database. It powers the [pharos.watch](https://pharos.watch) stablecoin analytics dashboard, with public read endpoints plus authenticated/admin and feedback write endpoints.

**Base URL:** `https://api.pharos.watch`

Unless noted otherwise, responses are `Content-Type: application/json`. Exceptions: `GET /api/og/*` returns `image/png`, and `POST /api/telegram-webhook` returns a plain-text `ok` body. CORS headers are added to every response, but `Access-Control-Allow-Origin` is restricted by the Worker `CORS_ORIGIN` allowlist (production repo config: `https://pharos.watch,https://ops.pharos.watch`). When the request `Origin` matches an allowlisted entry, the Worker echoes that origin and sets `Vary: Origin`.

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

The full list is in `shared/lib/stablecoins.ts`. The API currently accepts canonical IDs only; legacy route redirects are handled at the frontend/static-export layer, not by the worker ID resolver.

---

## Response Headers

Endpoints backed by the cron cache include these additional headers:

| Header       | Description                                                                           |
| ------------ | ------------------------------------------------------------------------------------- |
| `X-Data-Age` | Seconds elapsed since the cron last wrote this data to D1                             |
| `Warning`    | RFC 7234 stale-data warning, present when `X-Data-Age` exceeds the endpoint's max age |

---

## Cache-Control Profiles

| Profile  | `Cache-Control`                      | Used by                                                                                                                                                                                                 |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| realtime | `public, s-maxage=60, max-age=10`    | stablecoins, stablecoin-summary, blacklist, depeg-events, peg-summary, mint-burn-events                                                                                                               |
| standard | `public, s-maxage=300, max-age=60`   | stablecoin-charts, dex-liquidity, redemption-backstops, usds-status, daily-digest, digest-archive, report-cards, stability-index, yield-rankings, mint-burn-flows, stress-signals                    |
| per-coin | `public, s-maxage=300, max-age=10`   | stablecoin/:id (cache-aside with 5-min per-coin TTL in D1)                                                                                                                                              |
| slow     | `public, s-maxage=3600, max-age=300` | supply-history, dex-liquidity-history, bluechip-ratings, yield-history, safety-score-history, digest-snapshot                                                                                           |
| no-store | `no-store`                           | health plus admin GET routes after router override (`status`, `status-history`, `debug-sync-state`, `backfill-dews`, `audit-depeg-history?dry-run=true`, `discovery-candidates`)                     |

---

## Polling Guidance

Recommended minimum polling cadence for external integrations:

| Cache profile | Minimum poll interval | Notes                                                           |
| ------------- | --------------------- | --------------------------------------------------------------- |
| realtime      | 60 seconds            | Polling faster usually re-fetches the same edge-cached payload  |
| standard      | 300 seconds           | Preferred baseline for most dashboards                          |
| per-coin      | 300 seconds           | `GET /api/stablecoin/:id` is history-heavy; avoid short loops   |
| slow          | 3600 seconds          | Historical/timeline endpoints should generally be polled hourly |
| no-store      | On-demand only        | Health/admin diagnostics; avoid high-frequency polling          |

Client best practices:

- Add interval jitter (`±10%`) to avoid synchronized bursts.
- Read `X-Data-Age` + `Warning` for freshness/stale decisions.
- Back off exponentially on `429` and `5xx` responses.

---

## Error Response Conventions

All error responses use `{ "error": "message" }` JSON format.

| Status | Meaning               | When                                                                                                     |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| 400    | Bad Request           | Invalid query parameter syntax (missing required parameter, invalid enum value, malformed numeric input) |
| 401    | Unauthorized          | Admin endpoint called without a valid operator credential (`ops-api` Access service token, or an allowed `ops-api` Access user path) |
| 404    | Not Found             | Unknown stablecoin ID or missing resource                                                                |
| 429    | Too Many Requests     | Rate limit exceeded (global public API limiter or feedback-specific limiter)                             |
| 500    | Internal Server Error | Unhandled exception (caught by `withErrorHandler`)                                                       |
| 502    | Bad Gateway           | Upstream (DefiLlama / CoinGecko) fetch failed                                                            |
| 503    | Service Unavailable   | Cache-passthrough endpoint where cache has never been populated                                          |

**Rule:** Cache-passthrough handlers return **503** when data hasn't been populated yet. Query handlers that find no matching rows return **200** with empty results (e.g., `{ events: [], total: 0 }`).

---

## Method Gating Policy

HTTP method allowance is defined centrally in `shared/lib/api-endpoints.ts` and enforced by `worker/src/router.ts` (`validateEndpointMethod`).

- `GET` is accepted for read endpoints (plus admin debug/status endpoints and `GET /api/backfill-dews`).
- `POST` is accepted for mutating admin endpoints, `POST /api/feedback`, and `POST /api/telegram-webhook`.
- `/api/audit-depeg-history` allows `GET` only with `?dry-run=true`; otherwise it is `POST`-only.
- Unknown `POST` paths return `405` with `Allow: GET`; unsupported verbs return `405` with `Allow: GET, POST`.

This keeps endpoint metadata, router behavior, and method guards aligned from one definition source.

---

## Public Endpoints

### `GET /api/stablecoins`

Full stablecoin list with current supply, price, chain breakdown, and FX rates. Data is refreshed by cron every 15 minutes; the cache entry has a 10-minute max-age.

**Cache:** realtime — `X-Data-Age` and `Warning` headers included.

**Response**

```json
{
  "peggedAssets": [StablecoinData, ...],
  "fxFallbackRates": { "peggedEUR": 1.082, "peggedGBP": 1.26 }
}
```

`fxFallbackRates` is present when the ECB FX-rate cron has run; keys are `pegType` strings (e.g. `"peggedEUR"`), values are rates in USD.

**`StablecoinData` fields**

| Field                  | Type                               | Description                                                                                                                                |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                   | `string`                           | Pharos stablecoin ID                                                                                                                       |
| `name`                 | `string`                           | Full name (e.g. `"Tether"`)                                                                                                                |
| `symbol`               | `string`                           | Ticker (e.g. `"USDT"`)                                                                                                                     |
| `geckoId`              | `string \| null`                   | CoinGecko ID (normalized output key; upstream DefiLlama uses `gecko_id`)                                                                   |
| `pegType`              | `string`                           | DefiLlama peg type (e.g. `"peggedUSD"`, `"peggedEUR"`)                                                                                     |
| `pegMechanism`         | `string`                           | `"fiat-backed"`, `"crypto-backed-algorithmic"`, etc.                                                                                       |
| `priceSource`          | `string`                           | Source of the current price (`"defillama"`, `"coingecko"`, `"coingecko+defillama"`, `"protocol-redeem"`, `"dexscreener"`)                  |
| `priceConfidence`      | `string \| null`                   | Price confidence level: `"high"` (cross-validated agreement), `"single-source"`, `"low"` (sources diverge), `"fallback"` (enrichment pipeline) |
| `supplySource`         | `string \| undefined`              | Supply data source: `"defillama"` or `"coingecko-fallback"`                                                                                |
| `price`                | `number \| null`                   | Current price in USD                                                                                                                       |
| `circulating`          | `Record<string, number>`           | Current supply in USD, keyed by pegType (e.g. `{ "peggedUSD": 138000000 }`)                                                                |
| `circulatingPrevDay`   | `Record<string, number>`           | Supply 24 h ago                                                                                                                            |
| `circulatingPrevWeek`  | `Record<string, number>`           | Supply 7 days ago                                                                                                                          |
| `circulatingPrevMonth` | `Record<string, number>`           | Supply ~30 days ago                                                                                                                        |
| `chainCirculating`     | `Record<string, ChainCirculating>` | Per-chain breakdown                                                                                                                        |
| `chains`               | `string[]`                         | List of chain names where the token is deployed                                                                                            |

**`ChainCirculating`**

```json
{
  "current": 50000000,
  "circulatingPrevDay": 49000000,
  "circulatingPrevWeek": 47000000,
  "circulatingPrevMonth": 44000000
}
```

> All `circulating` values are already in USD (the list endpoint does not return native-currency values for non-USD pegs). Do not multiply by price.

---

### `GET /api/stablecoin/:id`

Historical price and supply chart data for a single stablecoin. Proxies DefiLlama (or CoinGecko for commodity/CG-only tokens) with a 5-minute server-side cache.
All upstream calls use `fetchWithRetry` with explicit per-request timeouts; on upstream/parse failures, or when CoinGecko-derived history is empty/stale, logs include source tags and stablecoin ID before stale-cache fallback or `supply_history` reconstruction. CoinGecko history is treated as stale when its newest point is more than 72 hours old.

**Path parameter:** `:id` — Pharos stablecoin ID.

**Cache:** per-coin — custom `Cache-Control` with a 5-minute server-side D1 TTL (`public, s-maxage<=300, max-age=10`)

**Response**

```json
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

For non-USD pegs, `totalCirculating` remains in native units while `totalCirculatingUSD` is converted to USD using the current token price before caching, so the USD field always reflects market cap regardless of peg type.

**Error responses:** `502` when DefiLlama/CoinGecko is unavailable and neither cached detail nor `supply_history` fallback data exists; stale cache is returned in preference to an error.

For integrations that only need current per-coin metrics (without full historical arrays), prefer `GET /api/stablecoin-summary/:id`.

---

### `GET /api/stablecoin-summary/:id`

Lightweight per-coin snapshot sourced from cached `stablecoins` data. Designed for integrators that need current price/supply context without transferring full `/api/stablecoin/:id` history payloads.

**Path parameter:** `:id` — Pharos stablecoin ID.

**Cache:** realtime — `X-Data-Age` and `Warning` headers included.

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
  "priceSource": "coingecko+defillama",
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

| Field             | Type                     | Description                                                                                                                 |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `id`              | `string`                 | Pharos stablecoin ID                                                                                                        |
| `name`            | `string`                 | Asset name                                                                                                                  |
| `symbol`          | `string`                 | Ticker symbol                                                                                                               |
| `pegType`         | `string`                 | Peg type key (`peggedUSD`, `peggedEUR`, etc.)                                                                               |
| `pegMechanism`    | `string`                 | Backing/mechanism classification                                                                                            |
| `priceUsd`        | `number \| null`         | Current price in USD                                                                                                        |
| `priceSource`     | `string`                 | Price source identifier                                                                                                     |
| `priceConfidence` | `string \| null`         | Price confidence label                                                                                                      |
| `supplySource`    | `string \| null`         | Supply source identifier                                                                                                    |
| `supplyByPegUsd`  | `Record<string, number>` | Current supply by peg bucket (USD)                                                                                          |
| `supplyUsd`       | `object`                 | Aggregate USD supply values and deltas (`current`, `prevDay`, `prevWeek`, `prevMonth`, `change1d`, `change7d`, `change30d`) |
| `chainCount`      | `number`                 | Number of chains where the asset is deployed                                                                                |
| `updatedAt`       | `number`                 | Unix seconds of the stablecoins snapshot used for this response                                                             |

---

### `GET /api/stablecoin-reserves/:id`

Returns the resolved reserve presentation for a stablecoin with `liveReservesConfig`.

- Unknown IDs or coins without live reserve support return `404`.
- Live-enabled coins return `200` even before the first successful sync; the payload includes fallback mode + sync state.
- The endpoint currently powers the stablecoin detail-page reserve card only. Other analytics surfaces still use curated static reserve metadata.
- A response is treated as `live` only when the stored reserve snapshot matches the latest successful sync state; orphaned partial writes fall back to the curated/template presentation instead of presenting stale live data as authoritative.

**Cache:** dynamic

- Live snapshots: slow (`public, s-maxage=3600, max-age=300`)
- Bootstrap / fallback / stale presentations: shorter (`public, s-maxage=300, max-age=60`) so pre-sync fallback responses do not stay pinned at the edge after the first successful live sync

**Response (200):**

| Field          | Type             | Description |
|----------------|------------------|-------------|
| `stablecoinId` | `string`         | Pharos coin ID |
| `mode`         | `string`         | One of `live`, `live-stale`, `curated-fallback`, `template-fallback`, `unavailable` |
| `reserves`     | `ReserveSlice[]` | Reserve slices currently being shown to the user |
| `estimated`    | `boolean`        | `true` only when using the classification template fallback |
| `liveAt`       | `number`         | Unix seconds of the last successful live snapshot, when present |
| `source`       | `string`         | Adapter key (for example `"infinifi"`, `"m0"`, `"openeden-usdo"`, or `"accountable"`) when live data exists |
| `displayUrl`   | `string`         | Human-readable source link shown in the UI |
| `sync`         | `object`         | Live sync state (`status`, `bootstrap`, `stale`, `lastAttemptedAt`, `lastSuccessAt`, `warnings`) |

**Response (404):** `{ "error": "Not found" }`

---

### `GET /api/stablecoin-charts`

Aggregate historical supply chart data across all stablecoins, broken down by peg type. Updated every 15 minutes.

**Cache:** standard — `X-Data-Age` and `Warning` headers included.

**Response:** A top-level array.

```json
[
  {
    "date": "1511913600",
    "totalCirculatingUSD": {
      "peggedUSD": 110105,
      "peggedEUR": 14967600
    }
  }
]
```

| Field                 | Type                     | Description                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `date`                | `string`                 | Unix timestamp as a string           |
| `totalCirculatingUSD` | `Record<string, number>` | Aggregate supply in USD per peg type |

---

### `GET /api/blacklist`

Freeze, blacklist, and token-destruction events currently ingested for USDC, USDT, PAXG, and XAUT. The shared filter enum still includes `EURC`, but the live sync contract registry does not yet define an EURC ingestion path. Data is sourced from on-chain logs via Etherscan, Tron, and EVM RPCs.

**Cache:** realtime

**Query parameters**

| Param        | Type      | Default | Description                                                    |
| ------------ | --------- | ------- | -------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | Filter by token symbol: `USDC`, `USDT`, `EURC`, `PAXG`, `XAUT` |
| `chain`      | `string`  | —       | Filter by chain name (e.g. `Ethereum`, `Tron`)                 |
| `eventType`  | `string`  | —       | Filter by type: `blacklist`, `unblacklist`, `destroy`          |
| `limit`      | `integer` | `1000`  | Max results (1–1000; `0` maps to default `1000`)               |
| `offset`     | `integer` | `0`     | Pagination offset                                              |

`stablecoin=EURC` remains a valid query value because the shared blacklist enum still includes it, but the current sync contract registry (`worker/src/lib/blacklist-contracts.ts`) only ingests USDC, USDT, PAXG, and XAUT rows.

**Response**

```json
{
  "events": [BlacklistEvent, ...],
  "total": 13422,
  "methodology": {
    "version": "3.1",
    "versionLabel": "v3.1",
    "currentVersion": "3.1",
    "currentVersionLabel": "v3.1",
    "changelogPath": "/methodology/blacklist-tracker-changelog/",
    "asOf": 1772606400,
    "isCurrent": true
  }
}
```

**`BlacklistEvent`**

| Field                | Type             | Description                                      |
| -------------------- | ---------------- | ------------------------------------------------ |
| `id`                 | `string`         | Composite ID: `{chainId}-{txHash}-{logIndex}`    |
| `stablecoin`         | `string`         | Token symbol (`USDC`, `USDT`, etc.)              |
| `chainId`            | `string`         | Chain identifier (e.g. `"ethereum"`, `"tron"`)   |
| `chainName`          | `string`         | Human-readable chain name (e.g. `"Ethereum"`)    |
| `eventType`          | `string`         | `"blacklist"`, `"unblacklist"`, or `"destroy"`   |
| `address`            | `string`         | Affected address (EVM `0x…` or Tron `T…`)        |
| `amount`             | `number \| null` | Token-native amount recovered from event data or `balanceOf()`; `null` when unavailable |
| `txHash`             | `string`         | Transaction hash                                 |
| `blockNumber`        | `number`         | Block number                                     |
| `timestamp`          | `number`         | Unix seconds                                     |
| `methodologyVersion` | `string`         | Methodology version attributed to this event row |
| `explorerTxUrl`      | `string`         | Block explorer URL for the transaction           |
| `explorerAddressUrl` | `string`         | Block explorer URL for the address               |

**`methodology`**

| Field                 | Type      | Description                                                       |
| --------------------- | --------- | ----------------------------------------------------------------- |
| `version`             | `string`  | Methodology version of the latest returned event in this response |
| `versionLabel`        | `string`  | Display label (e.g. `"v3.1"`)                                     |
| `currentVersion`      | `string`  | Latest methodology version                                        |
| `currentVersionLabel` | `string`  | Display label for latest methodology version                      |
| `changelogPath`       | `string`  | Relative URL to the methodology changelog page                    |
| `asOf`                | `number`  | Unix timestamp of latest event used for freshness                 |
| `isCurrent`           | `boolean` | Whether `version` matches `currentVersion`                        |

---

### `GET /api/depeg-events`

Peg deviation events (≥ 100 bps for USD-pegged, ≥ 150 bps for non-USD pegs). Events are detected every 15 minutes by the cron.

**Cache:** realtime

**Query parameters**

| Param        | Type      | Default | Description                                                  |
| ------------ | --------- | ------- | ------------------------------------------------------------ |
| `stablecoin` | `string`  | —       | Filter by Pharos stablecoin ID                               |
| `active`     | `"true"`  | —       | When `"true"`, return only ongoing (unresolved) depeg events |
| `limit`      | `integer` | `100`   | Max results (1–1000)                                         |
| `offset`     | `integer` | `0`     | Pagination offset                                            |

**Response**

```json
{
  "events": [DepegEvent, ...],
  "total": 4080,
  "methodology": {
    "version": "4.6",
    "versionLabel": "v4.6",
    "currentVersion": "4.6",
    "currentVersionLabel": "v4.6",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1772606400,
    "isCurrent": true
  }
}
```

Results are ordered by `startedAt` descending (most recent first).

**`DepegEvent`**

| Field              | Type                   | Description                                                                                   |
| ------------------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| `id`               | `number`               | Auto-increment DB ID                                                                          |
| `stablecoinId`     | `string`               | Pharos stablecoin ID                                                                          |
| `symbol`           | `string`               | Token symbol                                                                                  |
| `pegType`          | `string`               | DefiLlama peg type (e.g. `"peggedUSD"`)                                                       |
| `direction`        | `"above" \| "below"`   | Whether the price was above or below the peg                                                  |
| `peakDeviationBps` | `number`               | Largest deviation observed (basis points, signed; negative = below peg, positive = above peg) |
| `startedAt`        | `number`               | Unix seconds when depeg was first detected                                                    |
| `endedAt`          | `number \| null`       | Unix seconds when price returned to peg; `null` if still active                               |
| `startPrice`       | `number`               | Price at event start (USD)                                                                    |
| `peakPrice`        | `number \| null`       | Price at worst deviation                                                                      |
| `recoveryPrice`    | `number \| null`       | Price at recovery                                                                             |
| `pegReference`     | `number`               | Reference peg value used (USD)                                                                |
| `source`           | `"live" \| "backfill"` | Detection method                                                                              |

**`methodology`**

| Field                 | Type      | Description                                                             |
| --------------------- | --------- | ----------------------------------------------------------------------- |
| `version`             | `string`  | Methodology version attributed from the latest returned event timestamp |
| `versionLabel`        | `string`  | Display label (e.g. `"v4.6"`)                                           |
| `currentVersion`      | `string`  | Latest methodology version                                              |
| `currentVersionLabel` | `string`  | Display label for latest methodology version                            |
| `changelogPath`       | `string`  | Relative URL to the methodology changelog page                          |
| `asOf`                | `number`  | Unix timestamp used for methodology attribution                         |
| `isCurrent`           | `boolean` | Whether `version` matches `currentVersion`                              |

---

### `GET /api/peg-summary`

Composite peg scores and aggregate statistics for all tracked stablecoins. Scores are computed over a 4-year window from live depeg events, DEX prices, and current prices.

**Cache:** realtime

**Response**

```json
{
  "coins": [PegSummaryCoin, ...],
  "summary": PegSummaryStats,
  "methodology": {
    "version": "4.6",
    "versionLabel": "v4.6",
    "currentVersion": "4.6",
    "currentVersionLabel": "v4.6",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1772606400,
    "isCurrent": true
  }
}
```

**`PegSummaryCoin`**

| Field                 | Type                    | Description                                                                                                                                   |
| --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `string`                | Pharos stablecoin ID                                                                                                                          |
| `symbol`              | `string`                | Token symbol                                                                                                                                  |
| `name`                | `string`                | Full name                                                                                                                                     |
| `pegType`             | `string`                | DefiLlama peg type                                                                                                                            |
| `pegCurrency`         | `string`                | Peg currency code (`USD`, `EUR`, `GOLD`, etc.)                                                                                                |
| `governance`          | `string`                | `"centralized"`, `"centralized-dependent"`, `"decentralized"`                                                                                 |
| `currentDeviationBps` | `number \| null`        | Live price deviation from peg (basis points, signed). `null` for coins with supply < $1M or missing price.                                    |
| `priceSource`         | `string`                | Primary price source used for current deviation (`defillama`, `coingecko`, `protocol-redeem`, `defillama-contract`, `coinmarketcap`, `dexscreener`, `cached`, etc.) |
| `priceConfidence`     | `"high" \| "single-source" \| "low" \| "fallback" \| null` | Confidence tier attached to the primary price input |
| `priceUpdatedAt`      | `number \| null`        | Unix seconds when the primary price was last refreshed; cached fallback prices keep the original cache timestamp |
| `primaryTrust`        | `"authoritative" \| "confirm_required" \| "unusable"` | Whether the current primary price is trusted to mutate live depeg state directly |
| `pegScore`            | `number \| null`        | Composite peg score 0–100 (higher = more stable)                                                                                              |
| `pegPct`              | `number`                | % of tracked time within ±100 bps                                                                                                             |
| `severityScore`       | `number`                | Severity sub-score (0–100)                                                                                                                    |
| `spreadPenalty`       | `number`                | Spread/liquidity penalty applied to score                                                                                                     |
| `eventCount`          | `number`                | Number of depeg events in the 4-year window                                                                                                   |
| `worstDeviationBps`   | `number \| null`        | Worst single deviation seen (basis points)                                                                                                    |
| `activeDepeg`         | `boolean`               | Whether a depeg event is currently open                                                                                                       |
| `lastEventAt`         | `number \| null`        | Unix seconds of most recent depeg event                                                                                                       |
| `trackingSpanDays`    | `number`                | Days of history used for score computation                                                                                                    |
| `methodologyVersion`  | `string`                | Methodology version attributed to this coin snapshot                                                                                          |
| `dexPriceCheck`       | `DexPriceCheck \| null` | Optional cross-validation against DEX price (shown when coin supply ≥ $1M, DEX data is ≤ 60 minutes old, and aggregate source TVL is ≥ $250K) |

**`DexPriceCheck`**

| Field             | Type      | Description                                         |
| ----------------- | --------- | --------------------------------------------------- |
| `dexPrice`        | `number`  | DEX-derived price (USD)                             |
| `dexDeviationBps` | `number`  | DEX price deviation from peg (basis points, signed) |
| `agrees`          | `boolean` | Whether primary and DEX prices are within 50 bps    |
| `sourcePools`     | `number`  | Number of DEX pools contributing to the price       |
| `sourceTvl`       | `number`  | Combined TVL of those pools (USD)                   |

**`PegSummaryStats`**

| Field                  | Type                          | Description                                                         |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `activeDepegCount`     | `number`                      | Coins with an open depeg event                                      |
| `medianDeviationBps`   | `number`                      | Median absolute deviation across all tracked coins                  |
| `worstCurrent`         | `{ id, symbol, bps } \| null` | Coin with the largest current deviation                             |
| `coinsAtPeg`           | `number`                      | Coins with current deviation below their live depeg threshold (100 bps for USD pegs, 150 bps for non-USD pegs) |
| `totalTracked`         | `number`                      | Total coins in the response                                         |
| `depegEventsToday`     | `number`                      | Number of depeg events whose `startedAt` is in the current UTC day  |
| `depegEventsYesterday` | `number`                      | Number of depeg events whose `startedAt` is in the previous UTC day |
| `fallbackPegRates`     | `string[]`                    | _(optional)_ pegType keys using stale FX fallback rates             |

**`methodology`** — same fields and semantics as `/api/depeg-events`

---

### `GET /api/usds-status`

Sky/USDS protocol status — whether the freeze module is currently active.

**Cache:** standard — `X-Data-Age` and `Warning` headers included.

**Response**

```json
{
  "freezeActive": false,
  "implementationAddress": "0x1923dfee706a8e78157416c29cbccfde7cdf4102",
  "lastChecked": 1771809338
}
```

| Field                   | Type      | Description                                         |
| ----------------------- | --------- | --------------------------------------------------- |
| `freezeActive`          | `boolean` | Whether the USDS freeze module is currently enabled |
| `implementationAddress` | `string`  | Address of the current USDS implementation contract |
| `lastChecked`           | `number`  | Unix seconds when this was last fetched on-chain    |

---

### `GET /api/bluechip-ratings`

Safety ratings from [bluechip.org](https://bluechip.org) for covered stablecoins. Updated daily at 08:05 UTC.

**Cache:** slow — `X-Data-Age` and `Warning` headers included.

**Response:** Object keyed by Pharos stablecoin ID.

```json
{
  "usdt-tether": BluechipRating,
  "usdc-circle": BluechipRating
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

**Cache:** standard

**Freshness note:** In addition to stale-data warnings, this endpoint can also emit a `Warning` header when the latest `sync-dex-liquidity` run finished in `degraded` or `error` state and the API is serving the last successful dataset.

**Response:** Object keyed by Pharos stablecoin ID.

```json
{
  "usdt-tether": DexLiquidityData,
  "usdc-circle": DexLiquidityData
}
```

**`DexLiquidityData`**

| Field                  | Type                       | Description                                                                                                                                          |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalTvlUsd`          | `number`                   | Total DEX TVL (USD)                                                                                                                                  |
| `totalVolume24hUsd`    | `number`                   | 24 h trading volume (USD)                                                                                                                            |
| `totalVolume7dUsd`     | `number`                   | 7-day trading volume (USD)                                                                                                                           |
| `poolCount`            | `number`                   | Number of liquidity pools                                                                                                                            |
| `pairCount`            | `number`                   | Number of unique trading pairs                                                                                                                       |
| `chainCount`           | `number`                   | Number of chains with active pools                                                                                                                   |
| `protocolTvl`          | `Record<string, number>`   | TVL per DEX protocol (e.g. `{ "uniswap-v3": 100000 }`)                                                                                               |
| `chainTvl`             | `Record<string, number>`   | TVL per chain (e.g. `{ "Ethereum": 500000 }`)                                                                                                        |
| `topPools`             | `DexLiquidityPool[]`       | Top 10 retained pools sorted by 24h volume, then TVL                                                                                                 |
| `liquidityScore`       | `number \| null`           | Composite liquidity score 0–100                                                                                                                      |
| `concentrationHhi`     | `number \| null`           | Herfindahl–Hirschman Index for pool concentration (0–1; lower = more distributed), computed from the full retained pool set before top-10 truncation |
| `depthStability`       | `number \| null`           | Pool depth stability metric                                                                                                                          |
| `tvlChange24h`         | `number \| null`           | % TVL change vs. 24 h ago                                                                                                                            |
| `tvlChange7d`          | `number \| null`           | % TVL change vs. 7 days ago                                                                                                                          |
| `updatedAt`            | `number`                   | Unix seconds of last cron update                                                                                                                     |
| `dexPriceUsd`          | `number \| null`           | DEX-derived price (USD)                                                                                                                              |
| `dexDeviationBps`      | `number \| null`           | DEX price deviation from peg (basis points, signed)                                                                                                  |
| `priceSourceCount`     | `number \| null`           | Number of pools used for DEX price (all must meet the shared $50K observation floor)                                                                 |
| `priceSourceTvl`       | `number \| null`           | Combined TVL of price-source pools (USD)                                                                                                             |
| `priceSources`         | `DexPriceSource[] \| null` | Detailed per-pool price sources                                                                                                                      |
| `effectiveTvlUsd`      | `number`                   | TVL after applying quality multipliers                                                                                                               |
| `avgPoolStress`        | `number \| null`           | Average pool stress index (0 = balanced, 1 = fully imbalanced)                                                                                       |
| `weightedBalanceRatio` | `number \| null`           | TVL-weighted balance ratio across pools                                                                                                              |
| `organicFraction`      | `number \| null`           | Fraction of TVL from organic (non-incentivized) pools                                                                                                |
| `durabilityScore`      | `number \| null`           | Score for pool maturity and reliability                                                                                                              |
| `coverageClass`        | `"primary" \| "mixed" \| "fallback" \| "legacy" \| "unobserved"` | Coverage-confidence classification for the retained pool set |
| `coverageConfidence`   | `number`                   | Confidence attached to the row (`1.0`, `0.85`, `0.55`, `0.5`, `0`)                                                                                  |
| `sourceMix`            | `Record<string, { poolCount: number; tvlUsd: number }>` | TVL/pool-count mix across source families (`dl`, `cg_onchain`, `gecko_terminal`, `dexscreener`, `cg_tickers`) |
| `balanceMeasuredTvlUsd` | `number`                  | TVL denominator actually used for `weightedBalanceRatio`                                                                                             |
| `organicMeasuredTvlUsd` | `number`                  | TVL denominator actually used for `organicFraction`                                                                                                  |
| `scoreComponents`      | `ScoreComponents \| null`  | Breakdown of the composite liquidity score                                                                                                           |
| `lockedLiquidityPct`   | `number \| null`           | TVL-weighted fraction of liquidity reported as locked by source pools                                                                                |
| `methodologyVersion`   | `string`                   | Methodology version attributed to this row                                                                                                           |

**`ScoreComponents`**

| Field            | Type     | Description                        |
| ---------------- | -------- | ---------------------------------- |
| `tvlDepth`       | `number` | TVL depth sub-score                |
| `volumeActivity` | `number` | Volume activity sub-score          |
| `poolQuality`    | `number` | Pool quality sub-score             |
| `durability`     | `number` | Durability sub-score               |
| `pairDiversity`  | `number` | Pair diversity sub-score           |

**`DexLiquidityPool`**

| Field         | Type                  | Description                                                    |
| ------------- | --------------------- | -------------------------------------------------------------- |
| `project`     | `string`              | Protocol slug (e.g. `"curve-dex"`, `"uniswap-v3"`)             |
| `chain`       | `string`              | Chain name                                                     |
| `tvlUsd`      | `number`              | Pool TVL (USD)                                                 |
| `symbol`      | `string`              | Pool pair name (e.g. `"USDC-USDT"`)                            |
| `volumeUsd1d` | `number`              | 24 h volume (USD)                                              |
| `poolType`    | `string`              | Pool type (e.g. `"curve-stableswap"`, `"uniswap-v3-5bp"`)      |
| `source`      | `string \| undefined` | Canonical source family for this retained pool                 |
| `extra`       | `object \| undefined` | Optional detailed pool metrics (A-factor, balance ratio, etc.) |

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

**Cache:** slow

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
    "methodologyVersion": "3.1"
  }
]
```

| Field                | Type             | Description                                     |
| -------------------- | ---------------- | ----------------------------------------------- |
| `tvl`                | `number`         | Total DEX TVL snapshot (USD)                    |
| `volume24h`          | `number`         | 24 h volume at time of snapshot (USD)           |
| `score`              | `number \| null` | Liquidity score at time of snapshot             |
| `date`               | `number`         | Unix seconds                                    |
| `coverageClass`      | `string`         | Snapshot confidence class (`primary`, `mixed`, `fallback`, `legacy`, `unobserved`) |
| `coverageConfidence` | `number`         | Snapshot confidence score                       |
| `methodologyVersion` | `string`         | Methodology version attributed to this snapshot |

---

### `GET /api/supply-history`

Per-coin circulating supply and price history, snapshotted once daily at 08:00 UTC.

**Cache:** slow

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param  | Type      | Default | Bounds | Description             |
| ------ | --------- | ------- | ------ | ----------------------- |
| `days` | `integer` | `365`   | 1–1825 | Lookback window in days |

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

**Cache:** standard — `X-Data-Age` and `Warning` (max 2 h) headers included.

**Response**

```json
{
  "digest": "USDC absorbed $812M of the market's $1.36B weekly inflow…"
}
```

If no digest exists yet, the endpoint returns only `{ "digest": null }`.

| Field            | Type             | Description                                                                          |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `digest`         | `string \| null` | Tweet-ready summary (≤ 240 characters). `null` if no digest has been generated yet.  |
| `digestTitle`    | `string \| null` | Short headline for the digest                                                        |
| `digestExtended` | `string \| null` | Extended commentary for the website view                                             |
| `generatedAt`    | `number`         | Unix seconds when this digest was generated (present only when `digest` is non-null) |

---

### `GET /api/digest-archive`

All daily digests, newest-first.

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
      "totalMcapUsd": 234500000000
    }
  ]
}
```

Each element uses `digestText` (note: differs from the singular `/api/daily-digest` which uses `digest`).

| Field            | Type             | Description                                                 |
| ---------------- | ---------------- | ----------------------------------------------------------- |
| `digestText`     | `string`         | Tweet-ready summary                                         |
| `digestTitle`    | `string \| null` | Short headline                                              |
| `digestExtended` | `string \| null` | Extended commentary                                         |
| `generatedAt`    | `number`         | Unix seconds of generation time                             |
| `psiScore`       | `number \| null` | PSI score parsed from archived digest input data            |
| `psiBand`        | `string \| null` | PSI condition band parsed from archived digest input data   |
| `totalMcapUsd`   | `number \| null` | Ecosystem market cap parsed from archived digest input data |

---

### `GET /api/digest-snapshot`

Contextual data snapshot for a specific digest date — includes the digest's input data, active depeg events, and blacklist events for that day. Used by SSG builds for individual digest pages.

**Cache:** slow

**Required query parameter**

| Param  | Type     | Description                            |
| ------ | -------- | -------------------------------------- |
| `date` | `string` | Date in `YYYY-MM-DD` format (required) |

**Response**

```json
{
  "date": "2026-02-27",
  "inputData": { "totalMcapUsd": 230000000000, "mcap7dDelta": 0.012, ... },
  "prevInputData": { ... },
  "depegEvents": [{ "stablecoinId": "usdt-tether", "symbol": "USDT", "direction": "below", "peakDeviationBps": -150, ... }],
  "blacklistEvents": [{ "stablecoin": "USDT", "chainName": "Ethereum", "eventType": "blacklist", ... }]
}
```

| Field             | Type             | Description                                                         |
| ----------------- | ---------------- | ------------------------------------------------------------------- |
| `date`            | `string`         | The requested date                                                  |
| `inputData`       | `object \| null` | Digest input data (mcap, depegs, supply changes, PSI) for this date |
| `prevInputData`   | `object \| null` | Previous day's input data for delta computation                     |
| `depegEvents`     | `array`          | Up to 20 depeg events active on that date, ordered by severity      |
| `blacklistEvents` | `array`          | Up to 50 blacklist events on that date                              |

**Error responses:** `400` for missing/invalid date, `404` if no digest exists for that date.

---

### `GET /api/health`

Worker health check. Reports cache freshness, blacklist integrity, mint/burn freshness, and circuit-breaker states. Not served from Cloudflare edge cache (`no-store`).

**Response**

```json
{
  "status": "healthy",
  "timestamp": 1771856453,
  "warnings": [],
  "caches": {
    "stablecoins": { "ageSeconds": 323, "maxAge": 600, "healthy": true },
    "stablecoin-charts": { "ageSeconds": 323, "maxAge": 600, "healthy": true },
    "usds-status": { "ageSeconds": 47118, "maxAge": 86400, "healthy": true },
    "fx-rates": { "ageSeconds": 1223, "maxAge": 1800, "healthy": true },
    "bluechip-ratings": { "ageSeconds": 22815, "maxAge": 86400, "healthy": true },
    "dex-liquidity": { "ageSeconds": 290, "maxAge": 43200, "healthy": true },
    "yield-data": { "ageSeconds": 820, "maxAge": 3600, "healthy": true },
    "dews": { "ageSeconds": 240, "maxAge": 1800, "healthy": true }
  },
  "blacklist": {
    "totalEvents": 13422,
    "missingAmounts": 0
  },
  "mintBurn": {
    "totalEvents": 112345,
    "latestEventTs": 1771856430,
    "latestHourlyTs": 1771855200,
    "freshnessAgeSec": 23,
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
  }
}
```

| Field                        | Type                            | Description                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                     | `string`                        | `"healthy"` / `"degraded"` / `"stale"`                                                                                                                                                                                                                                                                                                                          |
| `timestamp`                  | `number`                        | Unix seconds at time of response                                                                                                                                                                                                                                                                                                                                |
| `warnings`                   | `string[]`                      | Best-effort diagnostics when health subqueries fail but the endpoint can still return a non-500 payload                                                                                                                                                                                                                                                        |
| `caches`                     | `Record<string, CacheStatus>`   | Per-cache freshness status                                                                                                                                                                                                                                                                                                                                      |
| `blacklist.totalEvents`      | `number`                        | Total events in blacklist table                                                                                                                                                                                                                                                                                                                                 |
| `blacklist.missingAmounts`   | `number`                        | Events where `amount` is null (should be 0)                                                                                                                                                                                                                                                                                                                     |
| `mintBurn.totalEvents`       | `number`                        | Total mint+burn event count (aggregated from `mint_burn_hourly`)                                                                                                                                                                                                                                                                                                |
| `mintBurn.latestEventTs`     | `number \| null`                | Latest raw event timestamp from `mint_burn_events` (observability only; does not drive endpoint health on its own)                                                                                                                                                                                                                                            |
| `mintBurn.latestHourlyTs`    | `number \| null`                | Latest hourly bucket timestamp from `mint_burn_hourly`                                                                                                                                                                                                                                                                                                          |
| `mintBurn.freshnessAgeSec`   | `number \| null`                | Seconds since latest mint/burn event (observability only)                                                                                                                                                                                                                                                                                                       |
| `mintBurn.majorStaleCount`   | `number`                        | Number of configured major symbols still considered stale after sync-health gating                                                                                                                                                                                                                                                                              |
| `mintBurn.staleMajorSymbols` | `string[]`                      | Symbol list still considered stale after sync-health gating                                                                                                                                                                                                                                                                                                     |
| `mintBurn.sync`              | `object`                        | Critical-lane sync freshness summary used for public health evaluation                                                                                                                                                                                                                                                                                          |
| `mintBurn.sync.lastSuccessfulSyncAt` | `number \| null`       | Unix seconds of the latest successful `sync-mint-burn` run                                                                                                                                                                                                                                                                                                      |
| `mintBurn.sync.freshnessStatus` | `"fresh" \| "degraded" \| "stale"` | Public freshness state keyed to the 20-minute critical-lane cadence (`fresh <= 40m`, `degraded <= 60m`, `stale > 60m`)                                                                                                                                                                                                                                  |
| `mintBurn.sync.warning`      | `string \| null`                | Human-readable warning when the critical lane is stale, degraded, or errored                                                                                                                                                                                                                                                                                   |
| `mintBurn.sync.criticalLaneHealthy` | `boolean`              | `true` when the latest critical-lane run is `ok`, `degraded`, or `skipped_locked`                                                                                                                                                                                                                                                                             |
| `circuits`                   | `Record<string, CircuitRecord>` | Per-source circuit breaker states. Keys include `defillama-stablecoins`, `defillama-stablecoin-detail`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-detail-platforms`, `coingecko-mcap`, `coingecko-discovery`, `coinmarketcap-prices`, `dexscreener-prices`, `treasury-rates`, `etherscan`, `alchemy`, `twitter-api`, `telegram-api` |

**`CacheStatus`**

| Field        | Type             | Description                                               |
| ------------ | ---------------- | --------------------------------------------------------- |
| `ageSeconds` | `number \| null` | Seconds since last cron update; `null` if never populated |
| `maxAge`     | `number`         | Expected max-age in seconds for this cache key            |
| `healthy`    | `boolean`        | `true` when `ageSeconds / maxAge ≤ 1.5`                   |

**Overall status logic:**

- `healthy` — worst cache ratio ≤ 1.5, no open circuits, and no stale major mint/burn symbols
- `degraded` — worst ratio between 1.5 and 2, or any circuit is open, or at least 1 major mint/burn symbol is stale
- `stale` — worst ratio > 2, or 3+ major mint/burn symbols are stale

---

### `GET /api/stability-index`

Daily Pharos Stability Index (PSI) scores. The PSI is a composite ecosystem health score (0–100) computed from active depeg severity, affected-market breadth, DEWS stress breadth, and 7-day ecosystem trend across the PSI-eligible universe (tracked coins plus shadow assets used for historical continuity).

**Cache:** standard — `X-Data-Age` and `Warning` headers included.

**Optional query parameters**

| Param    | Type     | Default | Description                                                                                   |
| -------- | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `detail` | `"true"` | —       | When `"true"`, returns full history with per-day component breakdowns instead of last 91 days |

**Response**

```json
{
  "current": {
    "score": 81.1,
    "band": "STEADY",
    "components": { "severity": 4.59, "breadth": 15, "stressBreadth": 1.8, "trend": 0.65 },
    "computedAt": 1771977600,
    "methodologyVersion": "3.0"
  },
  "history": [{ "date": 1771891200, "score": 81.0, "band": "STEADY", "methodologyVersion": "2.1" }],
  "methodology": {
    "version": "3.0",
    "versionLabel": "v3.0",
    "currentVersion": "3.0",
    "currentVersionLabel": "v3.0",
    "changelogPath": "/methodology/stability-index-changelog/",
    "asOf": 1771977600,
    "isCurrent": true
  }
}
```

| Field                          | Type                  | Description                                                                                 |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `current`                      | `object \| null`      | Latest PSI score and components. `null` if cron has not yet run                             |
| `current.score`                | `number`              | PSI score 0–100                                                                             |
| `current.band`                 | `string`              | Condition band: `"BEDROCK"`, `"STEADY"`, `"TREMOR"`, `"FRACTURE"`, `"CRISIS"`, `"MELTDOWN"` |
| `current.avg24h`               | `number \| undefined` | Rolling 24 h average PSI score                                                              |
| `current.avg24hBand`           | `string \| undefined` | Condition band for `avg24h`                                                                 |
| `current.components`           | `object`              | Component breakdown: `severity`, `breadth`, `stressBreadth`, `trend`                        |
| `current.contributors`         | `array`               | Top per-coin contributors from `input_snapshot.contributors` (empty when unavailable)       |
| `current.totalMcapUsd`         | `number`              | Total ecosystem market cap from the latest input snapshot (`0` when unavailable)            |
| `current.computedAt`           | `number`              | Unix seconds of computation                                                                 |
| `current.methodologyVersion`   | `string`              | Methodology version used to compute the current score                                       |
| `history`                      | `array`               | Historical scores, newest first. With `detail=true`, each entry includes `components`       |
| `history[].methodologyVersion` | `string`              | Methodology version used for that history point                                             |
| `methodology`                  | `object`              | Version metadata for current PSI methodology context                                        |
| `methodology.version`          | `string`              | Methodology version used by current score                                                   |
| `methodology.changelogPath`    | `string`              | Relative path to full methodology changelog                                                 |

---

### `GET /api/og/*`

Dynamic Open Graph PNG images used by share buttons and page metadata.

**Supported routes**

- `/api/og/stablecoin/:id`
- `/api/og/safety-scores`
- `/api/og/depeg`
- `/api/og/stability-index`

**Content-Type:** `image/png`

**Cache:** `public, max-age=900, s-maxage=900`

**Error cases**

- `404` for unknown coin IDs or unknown OG routes
- `503` when required cached data is not yet available

`/api/og/stablecoin/:id` accepts tracked public stablecoin IDs only. The renderer assembles each card from cached stablecoin, DEWS, PSI, report-card, depeg, liquidity, and mint/burn data on the worker.

---

### `GET /api/report-cards`

Stablecoin risk grade cards with dimension-level scores. Output includes 5 dimensions; overall score is the weighted base (exit-liquidity/resilience/decentralization/dependency) plus peg-multiplier adjustment.

**Cache:** standard

**Response**

```json
{
  "cards": [ReportCard, ...],
  "dependencyGraph": {
    "edges": [{ "from": "usde-ethena", "to": "usdc-circle" }, ...]
  },
  "methodology": {
    "version": "5.6",
    "weights": { "pegStability": 0, "liquidity": 0.30, "resilience": 0.20, "decentralization": 0.15, "dependencyRisk": 0.25 },
    "pegMultiplierExponent": 0.2,
    "thresholds": [{ "grade": "A+", "min": 87 }, { "grade": "A", "min": 83 }, ...]
  },
  "updatedAt": 1771977600
}
```

The Liquidity dimension now represents `effectiveExitScore`: the public DEX liquidity score remains the floor, while redeemable assets can receive uplift from `redemptionBackstopScore` when a meaningful direct exit path exists.

**`dependencyGraph.edges`**: Pre-computed forward edges. `from` = upstream stablecoin ID, `to` = dependent stablecoin ID. Used by the frontend to identify targetable coins for stress testing and walk the dependency tree.

**`ReportCard`**

| Field             | Type                                   | Description                                                                         |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `id`              | `string`                               | Pharos stablecoin ID                                                                |
| `name`            | `string`                               | Full name                                                                           |
| `symbol`          | `string`                               | Ticker                                                                              |
| `overallGrade`    | `string`                               | Letter grade: `"A+"` through `"F"`, or `"NR"`                                       |
| `overallScore`    | `number \| null`                       | Weighted score 0–100. `null` for unrated coins                                      |
| `dimensions`      | `Record<DimensionKey, DimensionScore>` | Per-dimension grade, score, and detail text                                         |
| `ratedDimensions` | `number`                               | Number of dimensions with data (max 5)                                              |
| `dependencies`    | `DependencyWeight[] \| undefined`      | Upstream stablecoin dependencies with collateral weights (for CeFi-Dependent coins) |
| `rawInputs`       | `RawDimensionInputs`                   | Raw scoring inputs for client-side grade recomputation (stress testing)             |
| `isDefunct`       | `boolean`                              | `true` for cemetery coins (permanent F grade)                                       |

**`DependencyWeight`**: `{ id: string, weight: number }` — upstream stablecoin ID + fraction of collateral from that source (0–1). Weights sum to ≤ 1.0; the remainder represents non-stablecoin collateral.

**`RawDimensionInputs`**

| Field               | Type                                            |
| ------------------- | ----------------------------------------------- |
| `pegScore`          | `number \| null`                                |
| `activeDepeg`       | `boolean`                                       |
| `depegEventCount`   | `number`                                        |
| `lastEventAt`       | `number \| null`                                |
| `liquidityScore`    | `number \| null`                                |
| `effectiveExitScore` | `number \| null`                               |
| `redemptionBackstopScore` | `number \| null`                          |
| `redemptionRouteFamily` | `RedemptionRouteFamily \| null`             |
| `redemptionImmediateCapacityUsd` | `number \| null`                   |
| `redemptionImmediateCapacityRatio` | `number \| null`                 |
| `concentrationHhi`  | `number \| null`                                |
| `bluechipGrade`     | `BluechipGrade \| null`                         |
| `canBeBlacklisted`  | `boolean \| "possible" \| "possible-inherited"` |
| `chainTier`         | `ChainTier`                                     |
| `deploymentModel`   | `DeploymentModel`                               |
| `collateralQuality` | `CollateralQuality`                             |
| `custodyModel`      | `CustodyModel`                                  |
| `governanceTier`    | `GovernanceType`                                |
| `governanceQuality` | `GovernanceQuality`                             |
| `dependencies`      | `DependencyWeight[]`                            |
| `navToken`          | `boolean`                                       |

**Dimensions:** `pegStability`, `liquidity`, `resilience`, `decentralization`, `dependencyRisk`

---

### `GET /api/redemption-backstops`

Current redemption-backstop dataset for redeemable assets.

**Cache:** standard

**Error responses:** `503` when `redemption_backstop` has no rows yet.

**Response**

```json
{
  "coins": {
    "cusd-cap": {
      "stablecoinId": "cusd-cap",
      "score": 88,
      "effectiveExitScore": 56,
      "dexLiquidityScore": 29,
      "routeFamily": "basket-redeem",
      "accessModel": "permissionless-onchain",
      "settlementModel": "atomic",
      "outputAssetType": "stable-basket",
      "immediateCapacityUsd": 10000000,
      "immediateCapacityRatio": 1,
      "sourceMode": "estimated",
      "updatedAt": 1773350400,
      "methodologyVersion": "1.0"
    }
  },
  "methodology": {
    "version": "1.0",
    "componentWeights": {
      "access": 0.2,
      "settlement": 0.15,
      "executionCertainty": 0.15,
      "capacity": 0.25,
      "outputAssetQuality": 0.15,
      "cost": 0.1
    },
    "effectiveExitWeights": {
      "liquidity": 0.55,
      "redemption": 0.45
    }
  },
  "updatedAt": 1773350400
}
```

`score` is the direct redemption-quality score.

`effectiveExitScore` is the blended exit score used by report cards when available.

`sourceMode`:

- `dynamic` = live reserve/protocol telemetry
- `estimated` = modelled from current supply and conservative route assumptions
- `static` = policy-only fallback

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `coins` | `Record<string, RedemptionBackstopEntry>` | Current snapshot keyed by Pharos stablecoin ID |
| `methodology` | `object` | Version metadata plus component weights, effective-exit blend weights, and route-family caps |
| `updatedAt` | `number` | Freshest `updated_at` timestamp across all current rows |

`RedemptionBackstopEntry` highlights:

| Field | Type | Description |
|-------|------|-------------|
| `score` | `number \| null` | Direct redemption-quality score after route-family/config caps |
| `effectiveExitScore` | `number \| null` | Blended exit score used by report cards |
| `dexLiquidityScore` | `number \| null` | DEX liquidity input used in the blend |
| `routeFamily` | `string` | `stablecoin-redeem`, `basket-redeem`, `collateral-redeem`, `psm-swap`, `queue-redeem`, or `offchain-issuer` |
| `accessModel` | `string` | `permissionless-onchain`, `whitelisted-onchain`, `issuer-api`, or `manual` |
| `settlementModel` | `string` | `atomic`, `immediate`, `same-day`, `days`, or `queued` |
| `outputAssetType` | `string` | `stable-single`, `stable-basket`, `bluechip-collateral`, `mixed-collateral`, or `nav` |
| `sourceMode` | `string` | `dynamic`, `estimated`, or `static` capacity provenance |
| `immediateCapacityUsd` | `number \| null` | Immediate redeemable capacity in USD |
| `immediateCapacityRatio` | `number \| null` | Immediate redeemable capacity as a share of supply |
| `feeBps` | `number \| null` | Explicit bounded fee when configured |
| `queueEnabled` | `boolean` | Whether the modeled route is explicitly queued/serial |
| `docs` | `{ label?: string, url?: string } \| undefined` | Optional external documentation / transparency link |
| `notes` | `string[] \| undefined` | Runtime notes such as stale reserve metadata fallback |
| `capsApplied` | `string[] \| undefined` | Applied score caps (`queue-route-cap`, `offchain-route-cap`, `config-cap`) |

**Response (503):** `{ "error": "Data not yet available" }`

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

Cache-backed yield rankings written by the `sync-yield-data` cron. The endpoint rehydrates `safetyScore`, `safetyGrade`, `yieldToRisk`, and `pharosYieldScore` from the current report-card snapshot at read time so Yield Intelligence stays aligned with `/api/report-cards`. Includes source-selection provenance and the current risk-free rate.

**Cache:** standard — `X-Data-Age` and `Warning` headers included. Freshness threshold: 1800 s (30 minutes).

**Response**

```json
{
  "rankings": [YieldRanking, ...],
  "riskFreeRate": 3.76,
  "scalingFactor": 5,
  "medianApy": 4.21,
  "updatedAt": 1772000000,
  "provenance": {
    "selectionMethod": "confidence-weighted",
    "benchmark": { "rate": 3.76, "recordDate": "2026-03-10", "isFallback": false },
    "dlPools": { "mode": "dex-cache", "ageSeconds": 240, "poolCount": 812 },
    "safetySnapshot": { "kind": "ok", "coverageRatio": 0.98 }
  }
}
```

| Field           | Type             | Description                                                                                           |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `rankings`      | `YieldRanking[]` | All ranked stablecoins, sorted by Pharos Yield Score descending                                       |
| `riskFreeRate`  | `number`         | Current 3-month Treasury yield proxy (%) from FRED `DGS3MO`, used as the risk-free benchmark          |
| `scalingFactor` | `number`         | Scaling factor applied in yield score computation                                                     |
| `medianApy`     | `number`         | TVL-weighted median APY (30d) across best-source rows, used as a peer reference in warning heuristics |
| `updatedAt`     | `number`         | Unix seconds when the rankings were last computed                                                     |
| `provenance`    | `object \| null` | Snapshot-level provenance for benchmark freshness, DeFiLlama pool input freshness, safety coverage, and selection method |

**`YieldRanking`**

| Field              | Type             | Description                                                     |
| ------------------ | ---------------- | --------------------------------------------------------------- |
| `id`               | `string`         | Pharos stablecoin ID                                            |
| `symbol`           | `string`         | Token symbol                                                    |
| `name`             | `string`         | Full name                                                       |
| `currentApy`       | `number`         | Current APY (%)                                                 |
| `apy7d`            | `number`         | 7-day average APY (%)                                           |
| `apy30d`           | `number`         | 30-day average APY (%)                                          |
| `apyBase`          | `number \| null` | Base APY component (%)                                          |
| `apyReward`        | `number \| null` | Reward APY component (%), `null` if none                        |
| `yieldSource`      | `string`         | Human-readable yield source description                         |
| `yieldSourceUrl`   | `string \| null` | Official URL for the selected source when Pharos has a curated or metadata-derived link |
| `yieldType`        | `string`         | Yield type classification (e.g. `"lending-vault"`, `"staking"`) |
| `dataSource`       | `string`         | Data source identifier (e.g. `"defillama"`)                     |
| `sourceTvlUsd`     | `number \| null` | TVL of the yield source pool (USD)                              |
| `pharosYieldScore` | `number \| null` | Composite Pharos Yield Score (0–100), recomputed at read time from cached APY inputs plus the current Safety Score |
| `safetyScore`      | `number \| null` | Current Safety Score input used by Yield Intelligence. Rated coins match `/api/report-cards`; unrated coins use the default NR penalty input (`40`) |
| `safetyGrade`      | `string \| null` | Current Safety Score letter grade (`"A+"` through `"F"`, or `"NR"`) from `/api/report-cards` |
| `yieldToRisk`      | `number \| null` | Yield-to-risk ratio recomputed at read time from cached APY inputs plus the current Safety Score |
| `excessYield`      | `number \| null` | APY above risk-free rate (percentage points)                    |
| `yieldStability`   | `number \| null` | Yield stability metric (0–1; higher = more stable)              |
| `apyVariance30d`   | `number \| null` | 30-day APY variance                                             |
| `apyMin30d`        | `number \| null` | Minimum APY in last 30 days (%)                                 |
| `apyMax30d`        | `number \| null` | Maximum APY in last 30 days (%)                                 |
| `warningSignals`   | `string[]`       | Active warning-signal flags for the selected best source        |
| `altSources`       | `AltYieldSource[]` | Additional non-selected source rows for the same coin         |
| `provenance`       | `object \| null` | Source-level provenance: confidence tier, selection reason, benchmark state, and source-switch metadata |

---

### `GET /api/yield-history`

Historical yield data for a single stablecoin.

**Cache:** slow — `X-Data-Age` and `Warning` headers included.

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param  | Type      | Default | Bounds | Description             |
| ------ | --------- | ------- | ------ | ----------------------- |
| `days` | `integer` | `90`    | 1–365  | Lookback window in days |
| `mode` | `string`  | `best`  | —      | `best` for historically selected best-source rows |
| `sourceKey` | `string` | — | — | When present, returns source-specific history for that source key |

**Response:** Array sorted by `date` ascending.

```json
[
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
    "sourceSwitch": false
  }
]
```

| Field          | Type             | Description                                                                |
| -------------- | ---------------- | -------------------------------------------------------------------------- |
| `date`         | `number`         | Unix seconds                                                               |
| `apy`          | `number`         | Total APY at snapshot time (%)                                             |
| `apyBase`      | `number \| null` | Base APY component (%)                                                     |
| `apyReward`    | `number \| null` | Reward APY component (%); `null` if none                                   |
| `exchangeRate` | `number \| null` | Exchange rate at snapshot time (e.g. sUSDe/USDe); `null` if not applicable |
| `sourceTvlUsd` | `number \| null` | TVL of the yield source pool at snapshot time (USD)                        |
| `warningSignals` | `string[]`     | Active warning-signal flags at that snapshot                               |
| `sourceKey`    | `string \| null` | Stable source identifier for this history row                              |
| `yieldSource`  | `string \| null` | Human-readable source label at that snapshot                               |
| `yieldSourceUrl` | `string \| null` | Official URL for that source when Pharos has a curated or metadata-derived link |
| `yieldType`    | `string \| null` | Yield type classification at that snapshot                                 |
| `dataSource`   | `string \| null` | Underlying data-source family                                              |
| `isBest`       | `boolean`        | Whether this row was the selected best source at that timestamp            |
| `sourceSwitch` | `boolean`        | True when the historically selected best source changed at this row        |

---

### `GET /api/mint-burn-flows`

Mint/burn flow data across tracked stablecoins — aggregate gauge score, per-coin net-flow + pressure-shift signals, and hourly timeseries. Updated every 20 minutes by the sync cron.

**Cache:** standard

**Optional query parameters**

| Param        | Type      | Default | Bounds | Description                                                               |
| ------------ | --------- | ------- | ------ | ------------------------------------------------------------------------- |
| `stablecoin` | `string`  | —       | —      | Filter to a single stablecoin ID. Changes response shape to per-coin mode |
| `hours`      | `integer` | `24`    | 1–720  | Lookback window for the returned `hourly[]` series                        |

**Response (aggregate mode — no `stablecoin` param)**

```json
{
  "gauge": {
    "score": 2.3,
    "band": "NEUTRAL",
    "flightToQuality": false,
    "flightIntensity": 0,
    "trackedCoins": 8,
    "trackedMcapUsd": 215000000000
  },
  "coins": [CoinFlow, ...],
  "hourly": [HourlyFlow, ...],
  "updatedAt": 1772000000,
  "windowHours": 24,
  "scope": { "chainIds": ["ethereum"], "label": "Ethereum-only" },
  "sync": { "lastSuccessfulSyncAt": 1772000200, "freshnessStatus": "fresh", "warning": null, "criticalLaneHealthy": true }
}
```

**`gauge`**

| Field             | Type             | Description                                                                                          |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `score`           | `number \| null` | Market-cap-weighted pressure-shift composite (-100 to +100). `null` when insufficient data           |
| `band`            | `string \| null` | Gauge band: `"CRISIS"`, `"STRESS"`, `"CAUTIOUS"`, `"NEUTRAL"`, `"HEALTHY"`, `"CONFIDENT"`, `"SURGE"` |
| `flightToQuality` | `boolean`        | Whether flight-to-quality conditions are active                                                      |
| `flightIntensity` | `number`         | Flight-to-quality intensity (0–100). 0 when not active                                               |
| `trackedCoins`    | `number`         | Number of stablecoins tracked for mint/burn flows                                                    |
| `trackedMcapUsd`  | `number`         | Combined market cap of tracked coins (USD)                                                           |

**Top-level metadata**

| Field         | Type     | Description                                                                                   |
| ------------- | -------- | --------------------------------------------------------------------------------------------- |
| `windowHours` | `number` | Requested chart window for `hourly[]`                                                         |
| `scope`       | `object` | Current ingestion scope, currently `{ chainIds: ["ethereum"], label: "Ethereum-only" }`      |
| `sync`        | `object` | Latest critical-lane freshness metadata and warning state                                     |

**`CoinFlow`**

| Field                 | Type                                             | Description                                                                                                  |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `stablecoinId`        | `string`                                         | Pharos stablecoin ID                                                                                         |
| `symbol`              | `string`                                         | Token symbol                                                                                                 |
| `flowIntensity`       | `number \| null`                                 | Deprecated alias for `pressureShiftScore`; retained for compatibility                                        |
| `pressureShiftScore`  | `number \| null`                                 | Canonical baseline-relative pressure score (-100 to +100). `null` if < 7 days of data or no current activity |
| `pressureShiftState`  | `"improving" \| "stable" \| "worsening" \| "nr"` | Interpreted pressure state from `pressureShiftScore`                                                         |
| `netFlowDirection24h` | `"minting" \| "burning" \| "flat" \| "inactive"` | Current 24h direction derived from raw net flow + activity                                                   |
| `has24hActivity`      | `boolean`                                        | Whether any 24h mint/burn events were recorded for the coin                                                  |
| `baselineDailyNetUsd` | `number \| null`                                 | Average daily net flow over the baseline window used for scoring                                             |
| `baselineDailyAbsUsd` | `number \| null`                                 | Average daily absolute flow over the baseline window used for scoring                                        |
| `baselineDataDays`    | `number \| null`                                 | Number of tracked days contributing to the baseline window                                                   |
| `netFlow24hUsd`       | `number`                                         | Raw 24h net flow (USD, positive = net minting, negative = net burning). Fixed to the canonical 24h window even when `hours` changes |
| `mintVolume24hUsd`    | `number`                                         | Total mint volume in the canonical 24h window (USD)                                                          |
| `burnVolume24hUsd`    | `number`                                         | Total burn volume in the canonical 24h window (USD)                                                          |
| `mintCount24h`        | `number`                                         | Number of mint events in the canonical 24h window                                                            |
| `burnCount24h`        | `number`                                         | Number of burn events in the canonical 24h window                                                            |
| `netFlow7dUsd`        | `number`                                         | 7-day net flow (USD)                                                                                         |
| `netFlow30dUsd`       | `number`                                         | 30-day net flow (USD)                                                                                        |
| `netFlow90dUsd`       | `number`                                         | 90-day net flow (USD)                                                                                        |
| `largestEvent24h`     | `object \| null`                                 | Largest event in the last 24h: `{ direction, amountUsd, txHash, timestamp }`                                 |
| `coverage`            | `object \| undefined`                            | Coverage metadata: `startBlock`, `lastSyncedBlock`, `lagBlocks`, `historyStartAt`, window booleans, and `status` |

**`HourlyFlow`**

| Field           | Type     | Description                     |
| --------------- | -------- | ------------------------------- |
| `hourTs`        | `number` | Unix seconds (start of hour)    |
| `netFlowUsd`    | `number` | Net flow for this hour (USD)    |
| `mintVolumeUsd` | `number` | Mint volume for this hour (USD) |
| `burnVolumeUsd` | `number` | Burn volume for this hour (USD) |

**Response (per-coin mode — with `stablecoin` param)**

Returns per-chain breakdown and hourly timeseries for a single coin. Returns `404` if the stablecoin is not tracked for mint/burn flows.

```json
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

Paginated list of individual mint/burn events for a specific stablecoin. Events are sourced from on-chain logs via Alchemy JSON-RPC.

**Cache:** realtime

**Required query parameter**

| Param        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param       | Type      | Default | Bounds                                                   | Description                                                                                                             |
| ----------- | --------- | ------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `direction` | `string`  | —       | `"mint"` or `"burn"`                                     | Filter by direction                                                                                                     |
| `chain`     | `string`  | —       | `"ethereum"`                                             | Filter by chain ID (current production scope is Ethereum only)                                                          |
| `burnType`  | `string`  | —       | `"effective_burn"`, `"bridge_burn"`, `"review_required"` | Filter burn rows by classification                                                                                      |
| `scope`     | `string`  | `"all"` | `"all"` or `"counted"`                                   | `counted` returns only rows used in economic-flow aggregates (`flow_type='standard'` and mint/effective-burn semantics) |
| `minAmount` | `number`  | —       | —                                                        | Minimum USD amount; unpriced rows are excluded when this filter is used                                                 |
| `limit`     | `integer` | `50`    | 1–500                                                    | Max results                                                                                                             |
| `offset`    | `integer` | `0`     | —                                                        | Pagination offset                                                                                                       |

**Response**

```json
{
  "events": [MintBurnEvent, ...],
  "total": 1234
}
```

Results are ordered by `timestamp` descending (most recent first).

**`MintBurnEvent`**

| Field              | Type                                                             | Description                                                                                 |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`               | `string`                                                         | Composite ID: `{chainId}-{txHash}-{logIndex}`                                               |
| `stablecoinId`     | `string`                                                         | Pharos stablecoin ID                                                                        |
| `symbol`           | `string`                                                         | Token symbol                                                                                |
| `chainId`          | `string`                                                         | Chain identifier (e.g. `"ethereum"`)                                                        |
| `direction`        | `"mint" \| "burn"`                                               | Whether tokens were minted or burned                                                        |
| `flowType`         | `"standard" \| "atomic_roundtrip"`                               | Flow-noise classification; `atomic_roundtrip` rows are excluded from aggregate flow metrics |
| `amount`           | `number`                                                         | Amount in native token units                                                                |
| `amountUsd`        | `number \| null`                                                 | USD value at time of event                                                                  |
| `burnType`         | `"effective_burn" \| "bridge_burn" \| "review_required" \| null` | Burn classification; `null` for mint rows                                                   |
| `burnReviewReason` | `string \| null`                                                 | Reason emitted when a burn requires manual review classification                            |
| `counterparty`     | `string \| null`                                                 | Non-zero address (recipient for mint, sender for burn)                                      |
| `txHash`           | `string`                                                         | Transaction hash                                                                            |
| `blockNumber`      | `number`                                                         | Block number                                                                                |
| `timestamp`        | `number`                                                         | Unix seconds                                                                                |
| `explorerTxUrl`    | `string`                                                         | Block explorer URL for the transaction                                                      |
| `priceUsed`        | `number \| null`                                                 | Price used to derive `amountUsd`                                                            |
| `priceTimestamp`   | `number \| null`                                                 | Unix seconds of the price snapshot used                                                     |
| `priceSource`      | `string \| null`                                                 | Valuation provenance (`supply_history`, `price_cache`, `price_cache_heal`, etc.)            |

---

### `GET /api/stress-signals`

Returns Depeg Early Warning Score (DEWS) data for tracked stablecoins.

**All coins (no params):** Latest DEWS score + signal breakdown per coin.

**Single coin:** Add `?stablecoin=ID&days=30` for latest + daily history.

`stablecoin` must be a tracked Pharos stablecoin ID. Untracked IDs return `404` with `{ "error": "Stablecoin not tracked" }`.

**Cache:** standard (`public, s-maxage=300, max-age=60`)

**Query parameters**

| Param        | Type      | Default | Description                                     |
| ------------ | --------- | ------- | ----------------------------------------------- |
| `stablecoin` | `string`  | —       | Single coin mode: return latest + daily history |
| `days`       | `integer` | `30`    | History lookback (max 365)                      |

Aggregate responses are filtered to tracked stablecoin IDs only, even if stale rows for de-tracked IDs still exist in storage.

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
      "computedAt": 1740000000,
      "methodologyVersion": "4.6"
    }
  },
  "updatedAt": 1740000000,
  "methodology": {
    "version": "4.6",
    "versionLabel": "v4.6",
    "currentVersion": "4.6",
    "currentVersionLabel": "v4.6",
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
      "computedAt": 1740000000,
      "methodologyVersion": "4.6"
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
      "methodologyVersion": "4.3"
    }
  ],
  "methodology": {
    "version": "4.6",
    "versionLabel": "v4.6",
    "currentVersion": "4.6",
    "currentVersionLabel": "v4.6",
    "changelogPath": "/methodology/depeg-changelog/",
    "asOf": 1740000000,
    "isCurrent": true
  }
}
```

**`methodology`** — same fields and semantics as `/api/depeg-events`

---

### `POST /api/feedback`

Public feedback ingestion endpoint used by the in-app feedback modal. Validates payloads, applies IP-based rate limiting, and forwards submissions to GitHub Issues/Discussions.

**Cache:** no edge cache (POST passthrough)

**Rate limits**

- Global public API limiter: best-effort per-IP in-memory limiter (`300 requests / 60 seconds`) for non-admin requests.
- Feedback endpoint limiter: `3 submissions / 10 minutes` per salted IP hash in D1.

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
  "website": ""
}
```

| Field                                                         | Type                                              | Required    | Notes                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `type`                                                        | `"bug" \| "data-correction" \| "feature-request"` | Yes         | Submission category                                                                    |
| `title`                                                       | `string`                                          | Conditional | Required for `bug` and `feature-request` (3–100 chars); optional for `data-correction` |
| `description`                                                 | `string`                                          | Yes         | 10–2000 chars                                                                          |
| `pageUrl`                                                     | `string`                                          | Yes         | Relative app path (must start with `/`)                                                |
| `website`                                                     | `string`                                          | No          | Honeypot field; non-empty is silently accepted/dropped                                 |
| `expectedValue`, `stablecoinId`, `stablecoinName`, `pegValue` | `string`                                          | No          | Optional metadata                                                                      |

**Response**

```json
{ "ok": true }
```

**Error responses**

- `400` invalid payload
- `429` rate limited (3 submissions / 10 minutes per salted IP hash)
- `500` forwarding/processing failure
- `503` service misconfigured (missing `FEEDBACK_IP_SALT` or `GITHUB_PAT`)

---

### `POST /api/telegram-webhook`

Telegram Bot API webhook endpoint. Receives user messages, processes bot commands, and manages subscriptions.

**Authentication:** Secret query parameter (`?secret=...`), not the standard `X-Admin-Key`.

**Rate limiting:** Exempt from IP rate limiter (Telegram sends from fixed IPs).

**Cache:** no edge cache (POST passthrough)

**Request body:** Telegram Update object (JSON, sent by Telegram servers).

**Response:** Always `200 OK` with plain-text body `ok` (Telegram retries on non-2xx).

**Commands handled:**

- `/start` — Welcome message
- `/subscribe <types> <tickers>` — Subscribe to alerts (types: dews, depeg, safety)
- `/unsubscribe <tickers>` — Remove coin subscriptions
- `/unsubscribe all` — Remove all subscriptions
- `/set <ticker> <setting> <value>` — Tune per-coin thresholds and modes
- `/mute <start>-<end>` — Enable UTC quiet hours
- `/unmutehours` — Disable quiet hours
- `/cancel` — Cancel a pending disambiguation flow
- `/list` — Show current subscriptions, per-coin settings, and quiet hours
- `/help` — Command reference

---

## Admin Endpoints

Preferred operator access now splits by surface:

- Browser / human operators: use `https://ops.pharos.watch/status/`, which talks to same-origin `/api/admin/*` Pages Functions routes behind Cloudflare Access.
- CLI / automation: call `https://ops-api.pharos.watch/api/...` with `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, data quality metrics, Telegram bot subscriber stats, and operator reconciliation signals.

**Preferred access:**

- Browser: `https://ops.pharos.watch/status/` -> same-origin `/api/admin/status`
- CLI: `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` against `https://ops-api.pharos.watch/api/status`

**Response shape:** `StatusResponse` (defined in `shared/types/index.ts`)

```json
{
  "timestamp": 1771856453,
  "dbHealthy": true,
  "availabilityStatus": "healthy",
  "dataQualityStatus": "healthy",
  "rawOverallStatus": "degraded",
  "overallStatus": "healthy",
  "confidence": 0.94,
  "causes": {
    "availability": [{ "code": "degraded_cron_warning", "severity": "info" }],
    "dataQuality": [],
    "overall": [{ "code": "degraded_cron_warning", "severity": "info" }]
  },
  "state": {
    "currentStatus": "healthy",
    "rawStatus": "degraded",
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
    "p95LatencyMs": 301
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
    "onchainSupplyDivergences": 0,
    "onchainDivergenceRatio": 0,
    "onchainSupplyMonitoring": "active",
    "onchainSupplyLatestAt": 1771856300,
    "onchainSupplyTrackedCoins": 96,
    "activeDepegs": 12,
    "staleOnchainSupply": 0,
    "onchainStaleRatio": 0
  },
  "telegramBot": {
    "totalChats": 128,
    "alertEnabledChats": 123,
    "deliverableChats": 121,
    "subscribedChats": 124,
    "emptyAlertChats": 2,
    "mutedChatsWithSubscriptions": 3,
    "totalSubscriptions": 611,
    "avgSubscriptionsPerSubscribedChat": 4.9,
    "pendingDisambiguations": 1,
    "pendingDeliveries": 6,
    "lastSubscriberActivityAt": 1771856420,
    "customPreferenceChats": 47,
    "quietHoursEnabledChats": 18,
    "alertTypeChats": {
      "dews": 121,
      "depeg": 118,
      "safety": 102,
      "allTypes": 95
    },
    "topStablecoins": [
      { "stablecoinId": "usdc-circle", "symbol": "USDC", "subscribers": 82 },
      { "stablecoinId": "usdt-tether", "symbol": "USDT", "subscribers": 77 }
    ]
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
    "digest": 1771804800,
    "discoveryCandidates": 1771856400
  },
  "summary": {
    "unhealthyCrons": 0,
    "degradedCrons": 1,
    "cronErrors": 0,
    "worstCacheRatio": 1.03
  },
  "priceSourceHealth": {
    "sourceDistribution": {
      "coingecko": 14,
      "coingecko+defillama": 118,
      "defillama": 10,
      "protocol-redeem": 1,
      "defillama-contract": 4,
      "coinmarketcap": 2,
      "dexscreener": 1,
      "cached": 4,
      "missing": 3
    },
    "confidenceDistribution": {
      "high": 127,
      "single-source": 15,
      "low": 8,
      "fallback": 6
    },
    "divergences": [
      {
        "id": "fdusd-first-digital-usd",
        "symbol": "FDUSD",
        "cgPrice": 0.9994,
        "dlPrice": 1.0012,
        "bps": 18
      }
    ],
    "totalAssets": 156,
    "lastSync": 1771856400
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
  "discoveryCandidates": [
    {
      "id": 12,
      "geckoId": "usdq",
      "llamaId": null,
      "name": "USDQ",
      "symbol": "USDQ",
      "marketCap": 18200000,
      "source": "coingecko",
      "firstSeen": 1771683600,
      "lastSeen": 1771856400,
      "daysSeen": 2,
      "dismissed": false
    }
  ],
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

`itemCount` and `dataQuality.totalStablecoins` are illustrative example values. In the live handler they reflect the current cached stablecoin payload size, not `TRACKED_STABLECOINS.length`.

`crons[*].healthy` reflects availability impact. Fresh cron runs with `status="degraded"` are warning-only and counted in `summary.degradedCrons`, but they do not mark availability unhealthy on their own.

`crons[*].inFlight` is present when a leased cron is actively reporting `cron_run_progress`. It includes `startedAt`, `updatedAt`, `stage`, optional `itemsDone/itemsTotal`, optional `message/metadata`, and a `stale` flag when the heartbeat stops updating.

`overallStatus` is the effective (hysteresis-smoothed) status. `rawOverallStatus` is the immediate worst-of availability/data-quality signal.

`dbHealthy=false` means the DB sentinel failed (`SELECT 1`), so status is forced to at least degraded and data-quality/database freshness queries are skipped.

`telegramBot` is `null` when the Telegram tables are unavailable in the current environment (for example, migrations not yet applied in dev/staging). The rest of `/api/status` still resolves normally.

`crons["dispatch-telegram-alerts"].lastRun.metadata` now carries a richer delivery breakdown, including fields such as `freshAttempted`, `freshSent`, `freshRetryQueued`, `freshPermanentFailures`, `pendingAttempted`, `pendingDrained`, `pendingRetryQueued`, `pendingDropped`, `pendingEnqueued`, and expanded `eventsDetected` counters (`depegTriggered`, `depegResolved`, `depegWorsening`, `suppressedMethodologyChanges`).

`datasetFreshness` covers the key operator-visible datasets written by the pipeline: cache-backed stablecoins, blacklist, mint/burn, supply snapshots, safety-grade history, yield, depeg/dews tables, daily digest, and discovery backlog timestamps.

`priceSourceHealth` is derived from the final `sync-stablecoins` asset payload and summarizes resolved price-source distribution, confidence buckets, recent CoinGecko-vs-DefiLlama divergences, and the timestamp of the latest successful price-health snapshot. This includes protocol-backed sources such as direct redemption quotes when they supersede market data.

`liquidityHealth` is derived from the latest `sync-dex-liquidity` cron metadata and summarizes row coverage, value coverage, major-asset coverage, failed sources, and current/previous coverage-class distribution for the operator dashboard.

`discoveryCandidates` exposes the current untracked-coverage backlog from `discovery_candidates`, ordered by market cap for the `/status` operator workflow.

`mintBurnReconciliation` compares 24h Ethereum mint/burn net flow (`mint_burn_hourly`) against the cached stablecoins payload's Ethereum chain-supply delta (`chainCirculating.ethereum.current - circulatingPrevDay`). It is intended for operator diagnostics, not public scoring.

### `GET /api/status-history`

Machine-readable status timeline endpoint for tooling and incident analysis.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param   | Type                  | Default | Description                                                                              |
| ------- | --------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `limit` | `integer`             | `50`    | Number of transitions to return (1–200)                                                  |
| `from`  | `integer \| ISO date` | —       | Optional lower bound for transition `created_at` (Unix seconds/milliseconds or ISO date) |
| `to`    | `integer \| ISO date` | —       | Optional upper bound for transition `created_at` (Unix seconds/milliseconds or ISO date) |

**Response shape:** `StatusHistoryResponse` (defined in `shared/types/index.ts`)

### `POST /api/backfill-depegs`

Backfills historical depeg events from stored price data.

For coins with a registered authoritative historical price provider, the backfill uses that same provider family first (for example, replayed protocol redemption quotes) before falling back to CoinGecko/DefiLlama market history. If the authoritative provider is configured but unavailable, existing `source='backfill'` rows for that coin are preserved instead of being rebuilt from a weaker source.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param        | Type      | Default | Description                      |
| ------------ | --------- | ------- | -------------------------------- |
| `stablecoin` | `string`  | —       | Process a single stablecoin ID   |
| `batch`      | `integer` | `0`     | Batch offset (3 coins per batch) |

### `POST /api/backfill-supply-history`

Backfills per-coin supply history snapshots.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param                           | Type      | Default | Description                                                             |
| ------------------------------- | --------- | ------- | ----------------------------------------------------------------------- |
| `stablecoin`                    | `string`  | —       | Process a single stablecoin ID                                          |
| `batch`                         | `integer` | `0`     | Batch offset for chunked processing                                     |
| `batchSize`                     | `integer` | `10`    | Coins per batch                                                         |
| `allow-constant-price-fallback` | `"true"`  | —       | Allow current-price fallback when historical non-USD prices are missing |

### `POST /api/backfill-stability-index`

Backfills historical stability index scores from stored depeg events and supply data.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

### `POST /api/backfill-cg-prices`

Backfills CoinGecko historical prices into the price_cache table for more accurate depeg detection.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param        | Type      | Default | Description                         |
| ------------ | --------- | ------- | ----------------------------------- |
| `stablecoin` | `string`  | —       | Process a single stablecoin ID      |
| `batchSize`  | `integer` | `10`    | Coins per batch                     |
| `batch`      | `integer` | `0`     | Batch offset for chunked processing |

### `POST /api/backfill-mint-burn-prices`

Backfills `amount_usd` for all mint-burn events with NULL values using current prices from `price_cache`. Recalculates affected hourly aggregation buckets.

Cron `sync-mint-burn` automatically heals recent NULL-price events within a 48-hour window and reports the healed count in cron metadata as `nullPricesHealed`; this endpoint is primarily for historical backfills beyond that window.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Response**

```json
{
  "totalUpdated": 15000,
  "coins": [
    { "id": "usdt-tether", "updated": 49 },
    { "id": "usdc-circle", "updated": 15119 }
  ]
}
```

### `GET /api/backfill-dews`

Validates DEWS against historical depeg events. Reports true-positive rate and average lead time.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

### `POST /api/backfill-mint-burn`

Backfills mint/burn event ingestion for a specific contract config using the same parsing/classification pipeline as the cron.
If `configKey` is omitted, the worker auto-selects one Ethereum config using a critical-first / major-symbol-first / most-behind policy and returns the selected config in the response.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Request body or query parameters**

| Param       | Type      | Default         | Description                                                                  |
| ----------- | --------- | --------------- | ---------------------------------------------------------------------------- |
| `configKey` | `string`  | auto-selected   | Optional config key: `{chainId}-{contractAddress}` (currently Ethereum-only) |
| `fromBlock` | `integer` | from sync state | Start block override                                                         |
| `toBlock`   | `integer` | chain head      | End block override (clamped to chain head)                                   |
| `chunkSize` | `integer` | `50000`         | Block span per fetch chunk (max 50000)                                       |
| `maxChunks` | `integer` | `24`            | Maximum chunks to process per request                                        |

### `POST /api/reclassify-atomic-roundtrips`

Retroactively tags same-transaction mint+burn pairs for the same stablecoin as `flow_type='atomic_roundtrip'` and recalculates the affected hourly buckets.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Response**

```json
{
  "done": false,
  "updated": 428,
  "hoursRecalculated": 31,
  "batchSize": 1000
}
```

The endpoint processes up to 1000 `(tx_hash, stablecoin_id)` groups per request. Repeat until `done=true`.

### `GET /api/audit-depeg-history?dry-run=true`

Dry-run preview for the depeg audit endpoint. This is the only supported `GET` mode for `/api/audit-depeg-history`; all mutating executions require `POST`.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param        | Type      | Default  | Description                              |
| ------------ | --------- | -------- | ---------------------------------------- |
| `limit`      | `integer` | `200`    | Max events to audit                      |
| `offset`     | `integer` | `0`      | Pagination offset                        |
| `dry-run`    | `"true"`  | required | Must be exactly `"true"` for `GET`       |
| `min-supply` | `number`  | `0`      | Minimum supply (USD) to include in audit |
| `symbol`     | `string`  | —        | Filter by symbol (case-insensitive)      |

### `POST /api/audit-depeg-history`

Audits existing depeg events against CoinGecko historical price data to detect false positives.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

`GET` is accepted only with `dry-run=true`; mutating audits require `POST`.

**Query parameters**

| Param        | Type      | Default | Description                                                                                    |
| ------------ | --------- | ------- | ---------------------------------------------------------------------------------------------- |
| `limit`      | `integer` | `200`   | Max events to audit                                                                            |
| `offset`     | `integer` | `0`     | Pagination offset                                                                              |
| `delete`     | `string`  | —       | Comma-separated event IDs to delete directly (skips CG audit)                                  |
| `dry-run`    | `"true"`  | —       | When `"true"`, preview deletions without touching DB. Default behavior deletes false positives |
| `min-supply` | `number`  | `0`     | Minimum supply (USD) to include in audit                                                       |
| `symbol`     | `string`  | —       | Filter by symbol (case-insensitive)                                                            |

### `POST /api/trigger-digest`

Force-regenerates the daily digest, bypassing the normal 1-hour dedup check. Routed through `worker/src/router.ts`.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Response**

```json
{
  "ok": true,
  "result": { ... }
}
```

Returns `500` with `{ "ok": false, "error": "..." }` on failure.

### `POST /api/reset-blacklist-sync`

Rolls back blacklist sync state to re-scan missed events. EVM chains are rolled back by 50,000 blocks; Tron is rolled back by 7 days. Routed through `worker/src/router.ts`.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Response**

```json
{
  "ok": true,
  "evmReset": 12345678,
  "tronReset": 1740000000000
}
```

### `GET /api/debug-sync-state`

Returns current blacklist sync state for all configured chains. Useful for diagnosing sync issues. Routed through `worker/src/router.ts`.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Response**

```json
[
  { "config_key": "ethereum-usdc", "last_block": 19500000 },
  { "config_key": "tron-usdt", "last_block": 1740000000000 }
]
```

### `GET /api/discovery-candidates`

Returns stablecoins tracked by CoinGecko or DefiLlama that Pharos does not yet monitor, surfaced by the daily discovery scan.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Query parameters**

| Param    | Type                               | Default    | Description                |
| -------- | ---------------------------------- | ---------- | -------------------------- |
| `status` | `"active" \| "dismissed" \| "all"` | `"active"` | Filter by candidate status |
| `limit`  | `integer`                          | `50`       | Max results (max 200)      |
| `offset` | `integer`                          | `0`        | Pagination offset          |

Malformed `limit` / `offset` values return `400` instead of silently defaulting.

**Response**

```json
{
  "candidates": [DiscoveryCandidate, ...],
  "total": 12
}
```

**`DiscoveryCandidate` fields**

| Field       | Type                                   | Description                                    |
| ----------- | -------------------------------------- | ---------------------------------------------- |
| `id`        | `number`                               | Internal candidate ID                          |
| `geckoId`   | `string \| null`                       | CoinGecko coin ID                              |
| `llamaId`   | `number \| null`                       | DefiLlama stablecoin ID                        |
| `name`      | `string`                               | Asset name                                     |
| `symbol`    | `string`                               | Ticker symbol                                  |
| `marketCap` | `number \| null`                       | Latest known market cap (USD)                  |
| `source`    | `"coingecko" \| "defillama" \| "both"` | Which discovery source detected this asset     |
| `firstSeen` | `number`                               | Unix seconds when first discovered             |
| `lastSeen`  | `number`                               | Unix seconds of most recent detection          |
| `daysSeen`  | `number`                               | Number of days the candidate has been observed |
| `dismissed` | `boolean`                              | Whether this candidate has been dismissed      |

### `POST /api/discovery-candidates/:id/dismiss`

Dismisses a discovery candidate so it no longer appears in the active list. Dismissed candidates will not resurface unless their market cap crosses 10× the value at dismissal time.

**Headers:** `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>` (required)

**Path parameter:** `:id` — candidate ID from `GET /api/discovery-candidates`

**Response**

```json
{ "ok": true }
```

**Error responses:** `404` if the candidate is not found or is already dismissed.
