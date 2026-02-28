# Pharos API Reference

The Pharos API is a read-only REST API served by a Cloudflare Worker backed by a D1 database. It powers the [pharos.watch](https://pharos.watch) stablecoin analytics dashboard.

**Base URL:** `https://api.pharos.watch`

All responses are `Content-Type: application/json`. CORS headers are added to every response, so the API can be called from any browser origin.

---

## Stablecoin IDs

Most endpoints use the Pharos stablecoin ID, which comes in three forms:

| Form | Example | Source |
|------|---------|--------|
| Numeric string | `"1"` (USDT), `"122"` (GYEN) | DefiLlama numeric ID |
| `gold-*` prefix | `"gold-paxg"` | Commodity (gold) token |
| `cg-*` prefix | `"cg-xyz"` | CoinGecko-only token |

---

## Response Headers

Endpoints backed by the cron cache include these additional headers:

| Header | Description |
|--------|-------------|
| `X-Data-Age` | Seconds elapsed since the cron last wrote this data to D1 |
| `Warning` | RFC 7234 stale-data warning, present when `X-Data-Age` exceeds the endpoint's max age |

---

## Cache-Control Profiles

| Profile | `Cache-Control` | Used by |
|---------|----------------|---------|
| realtime | `public, s-maxage=60, max-age=10` | stablecoins, blacklist, depeg-events, peg-summary |
| standard | `public, s-maxage=300, max-age=60` | stablecoin-charts, dex-liquidity, usds-status, daily-digest, digest-archive, report-cards, stability-index |
| per-coin | `public, s-maxage=300, max-age=10` | stablecoin/:id (cache-aside with 5-min per-coin TTL in D1) |
| slow | `public, s-maxage=3600, max-age=300` | supply-history, dex-liquidity-history, bluechip-ratings |
| no-store | `no-store` | health |

---

## Error Responses

| Status | Body | When |
|--------|------|------|
| 400 | `{ "error": "Missing ?stablecoin= parameter" }` | Required query param absent |
| 400 | `{ "error": "Invalid stablecoin ID" }` | ID fails format validation |
| 401 | `{ "error": "Unauthorized" }` | Admin endpoint called without valid `X-Admin-Key` |
| 500 | `{ "error": "Internal Server Error" }` | Unhandled exception |
| 502 | `{ "error": "..." }` | Upstream (DefiLlama / CoinGecko) fetch failed |
| 503 | `{ "error": "Data not yet available" }` | Cron has not yet populated the cache |

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

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Pharos stablecoin ID |
| `name` | `string` | Full name (e.g. `"Tether"`) |
| `symbol` | `string` | Ticker (e.g. `"USDT"`) |
| `gecko_id` | `string \| null` | CoinGecko ID |
| `pegType` | `string` | DefiLlama peg type (e.g. `"peggedUSD"`, `"peggedEUR"`) |
| `pegMechanism` | `string` | `"fiat-backed"`, `"crypto-backed-algorithmic"`, etc. |
| `priceSource` | `string` | Source of the current price (`"defillama"`, `"coingecko"`, `"defillama+coingecko"`, `"dexscreener"`) |
| `priceConfidence` | `string \| null` | Price confidence level: `"high"` (dual-source agreement), `"single-source"`, `"low"` (sources diverge), `"fallback"` (enrichment pipeline) |
| `supplySource` | `string \| undefined` | Supply data source: `"defillama"` or `"coingecko-fallback"` |
| `price` | `number \| null` | Current price in USD |
| `circulating` | `Record<string, number>` | Current supply in USD, keyed by pegType (e.g. `{ "peggedUSD": 138000000 }`) |
| `circulatingPrevDay` | `Record<string, number>` | Supply 24 h ago |
| `circulatingPrevWeek` | `Record<string, number>` | Supply 7 days ago |
| `circulatingPrevMonth` | `Record<string, number>` | Supply ~30 days ago |
| `chainCirculating` | `Record<string, ChainCirculating>` | Per-chain breakdown |
| `chains` | `string[]` | List of chain names where the token is deployed |

**`ChainCirculating`**

```json
{
  "current": { "peggedUSD": 50000000 },
  "circulatingPrevDay": { "peggedUSD": 49000000 },
  "circulatingPrevWeek": { "peggedUSD": 47000000 },
  "circulatingPrevMonth": { "peggedUSD": 44000000 }
}
```

> All `circulating` values are already in USD (the list endpoint does not return native-currency values for non-USD pegs). Do not multiply by price.

---

### `GET /api/stablecoin/:id`

Historical price and supply chart data for a single stablecoin. Proxies DefiLlama (or CoinGecko for commodity/CG-only tokens) with a 5-minute server-side cache.

**Path parameter:** `:id` — Pharos stablecoin ID.

**Cache:** realtime

**Response**

```json
{
  "tokens": [TokenPoint, ...]
}
```

**`TokenPoint`**

| Field | Type | Description |
|-------|------|-------------|
| `date` | `number` | Unix timestamp (seconds) |
| `totalCirculatingUSD` | `Record<string, number>` | Supply in USD per pegType key |
| `totalCirculating` | `Record<string, number>` | Supply in native units per pegType key |

For regular stablecoins the response is the raw DefiLlama stablecoin detail shape (it includes additional fields). For commodity and CG-only tokens the response is normalized to the shape above.

Non-USD pegs have their `totalCirculatingUSD` values converted to USD using the current token price before caching, so the `totalCirculatingUSD` field always reflects the USD market cap regardless of peg type.

**Error responses:** `502` when DefiLlama/CoinGecko is unavailable and no cached value exists; stale cache is returned in preference to an error.

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

| Field | Type | Description |
|-------|------|-------------|
| `date` | `string` | Unix timestamp as a string |
| `totalCirculatingUSD` | `Record<string, number>` | Aggregate supply in USD per peg type |

---

### `GET /api/blacklist`

Freeze, blacklist, and token-destruction events for USDC, USDT, PAXG, and XAUT. Sourced from on-chain logs via Etherscan, Tron, and EVM RPCs.

**Cache:** realtime

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Filter by token symbol: `USDC`, `USDT`, `PAXG`, `XAUT` |
| `chain` | `string` | — | Filter by chain name (e.g. `Ethereum`, `Tron`) |
| `eventType` | `string` | — | Filter by type: `blacklist`, `unblacklist`, `destroy` |
| `limit` | `integer` | 0 (all) | Max results (0–5000; 0 means no limit) |
| `offset` | `integer` | `0` | Pagination offset |

**Response**

```json
{
  "events": [BlacklistEvent, ...],
  "total": 13422
}
```

**`BlacklistEvent`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Composite ID: `{chainId}-{txHash}-{logIndex}` |
| `stablecoin` | `string` | Token symbol (`USDC`, `USDT`, etc.) |
| `chainId` | `string` | Chain identifier (e.g. `"ethereum"`, `"tron"`) |
| `chainName` | `string` | Human-readable chain name (e.g. `"Ethereum"`) |
| `eventType` | `string` | `"blacklist"`, `"unblacklist"`, or `"destroy"` |
| `address` | `string` | Affected address (EVM `0x…` or Tron `T…`) |
| `amount` | `number \| null` | USD value for `destroy` events; `null` otherwise |
| `txHash` | `string` | Transaction hash |
| `blockNumber` | `number` | Block number |
| `timestamp` | `number` | Unix seconds |
| `explorerTxUrl` | `string` | Block explorer URL for the transaction |
| `explorerAddressUrl` | `string` | Block explorer URL for the address |

---

### `GET /api/depeg-events`

Peg deviation events (≥ 100 bps for USD-pegged, ≥ 150 bps for non-USD pegs). Events are detected every 15 minutes by the cron.

**Cache:** realtime

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Filter by Pharos stablecoin ID |
| `active` | `"true"` | — | When `"true"`, return only ongoing (unresolved) depeg events |
| `limit` | `integer` | `100` | Max results (1–1000) |
| `offset` | `integer` | `0` | Pagination offset |

**Response**

```json
{
  "events": [DepegEvent, ...],
  "total": 4080
}
```

Results are ordered by `startedAt` descending (most recent first).

**`DepegEvent`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-increment DB ID |
| `stablecoinId` | `string` | Pharos stablecoin ID |
| `symbol` | `string` | Token symbol |
| `pegType` | `string` | DefiLlama peg type (e.g. `"peggedUSD"`) |
| `direction` | `"above" \| "below"` | Whether the price was above or below the peg |
| `peakDeviationBps` | `number` | Largest deviation observed (basis points, always positive) |
| `startedAt` | `number` | Unix seconds when depeg was first detected |
| `endedAt` | `number \| null` | Unix seconds when price returned to peg; `null` if still active |
| `startPrice` | `number` | Price at event start (USD) |
| `peakPrice` | `number \| null` | Price at worst deviation |
| `recoveryPrice` | `number \| null` | Price at recovery |
| `pegReference` | `number` | Reference peg value used (USD) |
| `source` | `"live" \| "backfill"` | Detection method |

---

### `GET /api/peg-summary`

Composite peg scores and aggregate statistics for all tracked stablecoins. Scores are computed over a 4-year window from live depeg events, DEX prices, and current prices.

**Cache:** realtime

**Response**

```json
{
  "coins": [PegSummaryCoin, ...],
  "summary": PegSummaryStats
}
```

**`PegSummaryCoin`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Pharos stablecoin ID |
| `symbol` | `string` | Token symbol |
| `name` | `string` | Full name |
| `pegType` | `string` | DefiLlama peg type |
| `pegCurrency` | `string` | Peg currency code (`USD`, `EUR`, `GOLD`, etc.) |
| `governance` | `string` | `"centralized"`, `"centralized-dependent"`, `"decentralized"` |
| `currentDeviationBps` | `number \| null` | Live price deviation from peg (basis points, signed). `null` for coins with supply < $1M or missing price. |
| `pegScore` | `number \| null` | Composite peg score 0–100 (higher = more stable) |
| `pegPct` | `number` | % of tracked time within ±100 bps |
| `severityScore` | `number` | Severity sub-score (0–100) |
| `spreadPenalty` | `number` | Spread/liquidity penalty applied to score |
| `eventCount` | `number` | Number of depeg events in the 4-year window |
| `worstDeviationBps` | `number \| null` | Worst single deviation seen (basis points) |
| `activeDepeg` | `boolean` | Whether a depeg event is currently open |
| `lastEventAt` | `number \| null` | Unix seconds of most recent depeg event |
| `trackingSpanDays` | `number` | Days of history used for score computation |
| `dexPriceCheck` | `DexPriceCheck \| null` | Optional cross-validation against DEX price |

**`DexPriceCheck`**

| Field | Type | Description |
|-------|------|-------------|
| `dexPrice` | `number` | DEX-derived price (USD) |
| `dexDeviationBps` | `number` | DEX price deviation from peg (basis points, signed) |
| `agrees` | `boolean` | Whether primary and DEX prices are within 50 bps |
| `sourcePools` | `number` | Number of DEX pools contributing to the price |
| `sourceTvl` | `number` | Combined TVL of those pools (USD) |

**`PegSummaryStats`**

| Field | Type | Description |
|-------|------|-------------|
| `activeDepegCount` | `number` | Coins with an open depeg event |
| `medianDeviationBps` | `number` | Median absolute deviation across all tracked coins |
| `worstCurrent` | `{ id, symbol, bps } \| null` | Coin with the largest current deviation |
| `coinsAtPeg` | `number` | Coins with current deviation < 100 bps |
| `totalTracked` | `number` | Total coins in the response |
| `fallbackPegRates` | `string[]` | *(optional)* pegType keys using stale FX fallback rates |

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

| Field | Type | Description |
|-------|------|-------------|
| `freezeActive` | `boolean` | Whether the USDS freeze module is currently enabled |
| `implementationAddress` | `string` | Address of the current USDS implementation contract |
| `lastChecked` | `number` | Unix seconds when this was last fetched on-chain |

---

### `GET /api/bluechip-ratings`

Safety ratings from [bluechip.org](https://bluechip.org) for covered stablecoins. Updated daily at 08:00 UTC.

**Cache:** slow — `X-Data-Age` and `Warning` headers included.

**Response:** Object keyed by Pharos stablecoin ID.

```json
{
  "1": BluechipRating,
  "5": BluechipRating
}
```

**`BluechipRating`**

| Field | Type | Description |
|-------|------|-------------|
| `grade` | `string` | Letter grade: `"A+"`, `"A"`, `"A-"`, `"B+"` … `"F"` |
| `slug` | `string` | Bluechip report slug (e.g. `"usdt"`) |
| `collateralization` | `number` | Collateralization percentage |
| `smartContractAudit` | `boolean` | Whether an audit exists |
| `dateOfRating` | `string` | ISO 8601 date of rating |
| `dateLastChange` | `string \| null` | ISO 8601 date of last grade change |
| `smidge` | `BluechipSmidge` | Plain-text evaluation summaries (HTML stripped) |

**`BluechipSmidge`** — each field is `string | null`:

| Field | Description |
|-------|-------------|
| `stability` | Reserves management and stabilization mechanisms |
| `management` | Personnel restrictions and track records |
| `implementation` | Smart contract implementation assessment |
| `decentralization` | Decentralization posture |
| `governance` | Governance and redemption terms |
| `externals` | External risk factors |

---

### `GET /api/dex-liquidity`

DEX liquidity scores, pool breakdowns, and on-chain DEX price data for all tracked stablecoins. Updated every 15 minutes. Includes 7-day trend data computed from stored history snapshots.

**Cache:** standard

**Response:** Object keyed by Pharos stablecoin ID.

```json
{
  "1": DexLiquidityData,
  "5": DexLiquidityData
}
```

**`DexLiquidityData`**

| Field | Type | Description |
|-------|------|-------------|
| `totalTvlUsd` | `number` | Total DEX TVL (USD) |
| `totalVolume24hUsd` | `number` | 24 h trading volume (USD) |
| `totalVolume7dUsd` | `number` | 7-day trading volume (USD) |
| `poolCount` | `number` | Number of liquidity pools |
| `pairCount` | `number` | Number of unique trading pairs |
| `chainCount` | `number` | Number of chains with active pools |
| `protocolTvl` | `Record<string, number>` | TVL per DEX protocol (e.g. `{ "uniswap-v3": 100000 }`) |
| `chainTvl` | `Record<string, number>` | TVL per chain (e.g. `{ "Ethereum": 500000 }`) |
| `topPools` | `DexLiquidityPool[]` | Top pools sorted by TVL |
| `liquidityScore` | `number \| null` | Composite liquidity score 0–100 |
| `concentrationHhi` | `number \| null` | Herfindahl–Hirschman Index for pool concentration (0–1; lower = more distributed) |
| `depthStability` | `number \| null` | Pool depth stability metric |
| `tvlChange24h` | `number \| null` | % TVL change vs. 24 h ago |
| `tvlChange7d` | `number \| null` | % TVL change vs. 7 days ago |
| `updatedAt` | `number` | Unix seconds of last cron update |
| `dexPriceUsd` | `number \| null` | DEX-derived price (USD) |
| `dexDeviationBps` | `number \| null` | DEX price deviation from peg (basis points, signed) |
| `priceSourceCount` | `number \| null` | Number of pools used for DEX price |
| `priceSourceTvl` | `number \| null` | Combined TVL of price-source pools (USD) |
| `priceSources` | `DexPriceSource[] \| null` | Detailed per-pool price sources |
| `effectiveTvlUsd` | `number` | TVL after applying quality multipliers |
| `avgPoolStress` | `number \| null` | Average pool stress index (0 = balanced, 1 = fully imbalanced) |
| `weightedBalanceRatio` | `number \| null` | TVL-weighted balance ratio across pools |
| `organicFraction` | `number \| null` | Fraction of TVL from organic (non-incentivized) pools |
| `durabilityScore` | `number \| null` | Score for pool maturity and reliability |
| `scoreComponents` | `ScoreComponents \| null` | Breakdown of the composite liquidity score |

**`ScoreComponents`**

| Field | Type | Description |
|-------|------|-------------|
| `tvlDepth` | `number` | TVL depth sub-score |
| `volumeActivity` | `number` | Volume activity sub-score |
| `poolQuality` | `number` | Pool quality sub-score |
| `durability` | `number` | Durability sub-score |
| `pairDiversity` | `number` | Pair diversity sub-score |
| `crossChain` | `number` | Cross-chain distribution sub-score |

**`DexLiquidityPool`**

| Field | Type | Description |
|-------|------|-------------|
| `project` | `string` | Protocol slug (e.g. `"curve-dex"`, `"uniswap-v3"`) |
| `chain` | `string` | Chain name |
| `tvlUsd` | `number` | Pool TVL (USD) |
| `symbol` | `string` | Pool pair name (e.g. `"USDC-USDT"`) |
| `volumeUsd1d` | `number` | 24 h volume (USD) |
| `poolType` | `string` | Pool type (e.g. `"curve-stableswap"`, `"uniswap-v3-5bp"`) |
| `extra` | `object \| undefined` | Optional detailed pool metrics (A-factor, balance ratio, etc.) |

**`DexPriceSource`**

| Field | Type | Description |
|-------|------|-------------|
| `protocol` | `string` | DEX protocol name |
| `chain` | `string` | Chain name |
| `price` | `number` | Price from this source |
| `tvl` | `number` | TVL of this pool (USD) |

---

### `GET /api/dex-liquidity-history`

Per-coin historical DEX liquidity snapshots. Snapshots are recorded every 15 minutes.

**Cache:** slow

**Required query parameter**

| Param | Type | Description |
|-------|------|-------------|
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param | Type | Default | Bounds | Description |
|-------|------|---------|--------|-------------|
| `days` | `integer` | `90` | 1–365 | Lookback window in days |

**Response:** Array sorted by `date` ascending.

```json
[
  {
    "tvl": 1658000000,
    "volume24h": 1700000000,
    "score": 93,
    "date": 1771500000
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `tvl` | `number` | Total DEX TVL snapshot (USD) |
| `volume24h` | `number` | 24 h volume at time of snapshot (USD) |
| `score` | `number \| null` | Liquidity score at time of snapshot |
| `date` | `number` | Unix seconds |

---

### `GET /api/supply-history`

Per-coin circulating supply and price history, snapshotted once daily at 08:00 UTC.

**Cache:** slow

**Required query parameter**

| Param | Type | Description |
|-------|------|-------------|
| `stablecoin` | `string` | Pharos stablecoin ID (required) |

**Optional query parameters**

| Param | Type | Default | Bounds | Description |
|-------|------|---------|--------|-------------|
| `days` | `integer` | `365` | 1–1825 | Lookback window in days |

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

| Field | Type | Description |
|-------|------|-------------|
| `date` | `number` | Unix seconds |
| `circulatingUsd` | `number` | Circulating supply in USD |
| `price` | `number \| null` | Price at snapshot time (USD); may be `null` for older records |

---

### `GET /api/daily-digest`

Latest AI-generated market summary, produced daily at 08:00 UTC via the Claude API.

**Cache:** standard — `X-Data-Age` and `Warning` (max 2 h) headers included.

**Response**

```json
{
  "digest": "USDC absorbed $812M of the market's $1.36B weekly inflow…",
  "digestTitle": "USDC Eats the Week",
  "digestExtended": "Longer editorial commentary for website display…",
  "generatedAt": 1771839719
}
```

| Field | Type | Description |
|-------|------|-------------|
| `digest` | `string \| null` | Tweet-ready summary (≤ 240 characters). `null` if no digest has been generated yet. |
| `digestTitle` | `string \| null` | Short headline for the digest |
| `digestExtended` | `string \| null` | Extended commentary for the website view |
| `generatedAt` | `number` | Unix seconds when this digest was generated |

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
      "generatedAt": 1771839719
    }
  ]
}
```

Each element uses `digestText` (note: differs from the singular `/api/daily-digest` which uses `digest`).

| Field | Type | Description |
|-------|------|-------------|
| `digestText` | `string` | Tweet-ready summary |
| `digestTitle` | `string \| null` | Short headline |
| `digestExtended` | `string \| null` | Extended commentary |
| `generatedAt` | `number` | Unix seconds of generation time |

---

### `GET /api/digest-snapshot`

Contextual data snapshot for a specific digest date — includes the digest's input data, active depeg events, and blacklist events for that day. Used by SSG builds for individual digest pages.

**Cache:** slow

**Required query parameter**

| Param | Type | Description |
|-------|------|-------------|
| `date` | `string` | Date in `YYYY-MM-DD` format (required) |

**Response**

```json
{
  "date": "2026-02-27",
  "inputData": { "totalMcapUsd": 230000000000, "mcap7dDelta": 0.012, ... },
  "prevInputData": { ... },
  "depegEvents": [{ "stablecoinId": "42", "symbol": "FOO", "direction": "below", "peakDeviationBps": 150, ... }],
  "blacklistEvents": [{ "stablecoin": "USDT", "chainName": "Ethereum", "eventType": "blacklist", ... }]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `date` | `string` | The requested date |
| `inputData` | `object \| null` | Digest input data (mcap, depegs, supply changes, PSI) for this date |
| `prevInputData` | `object \| null` | Previous day's input data for delta computation |
| `depegEvents` | `array` | Up to 20 depeg events active on that date, ordered by severity |
| `blacklistEvents` | `array` | Up to 50 blacklist events on that date |

**Error responses:** `400` for missing/invalid date, `404` if no digest exists for that date.

---

### `GET /api/health`

Worker health check. Reports cache freshness and blacklist table integrity. Not served from Cloudflare edge cache (`no-store`).

**Response**

```json
{
  "status": "healthy",
  "timestamp": 1771856453,
  "caches": {
    "stablecoins": { "ageSeconds": 323, "maxAge": 600, "healthy": true },
    "stablecoin-charts": { "ageSeconds": 323, "maxAge": 600, "healthy": true },
    "usds-status": { "ageSeconds": 47118, "maxAge": 86400, "healthy": true },
    "fx-rates": { "ageSeconds": 1223, "maxAge": 14400, "healthy": true },
    "bluechip-ratings": { "ageSeconds": 22815, "maxAge": 43200, "healthy": true },
    "dex-liquidity": { "ageSeconds": 290, "maxAge": 43200, "healthy": true }
  },
  "blacklist": {
    "totalEvents": 13422,
    "missingAmounts": 0
  },
  "circuits": {
    "defillama-stablecoins": { "state": "closed", "consecutiveFailures": 0, "lastSuccessAt": 1772190029 },
    "coingecko-prices": { "state": "closed", "consecutiveFailures": 0, "lastSuccessAt": 1772190030 }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | `"healthy"` / `"degraded"` / `"stale"` |
| `timestamp` | `number` | Unix seconds at time of response |
| `caches` | `Record<string, CacheStatus>` | Per-cache freshness status |
| `blacklist.totalEvents` | `number` | Total events in blacklist table |
| `blacklist.missingAmounts` | `number` | Events where `amount` is null (should be 0) |
| `circuits` | `Record<string, CircuitRecord>` | Per-source circuit breaker states. Keys: `defillama-stablecoins`, `defillama-coins`, `defillama-yields`, `defillama-protocols`, `coingecko-prices`, `coingecko-mcap`. Empty until first cron run |

**`CacheStatus`**

| Field | Type | Description |
|-------|------|-------------|
| `ageSeconds` | `number \| null` | Seconds since last cron update; `null` if never populated |
| `maxAge` | `number` | Expected max-age in seconds for this cache key |
| `healthy` | `boolean` | `true` when `ageSeconds / maxAge ≤ 1.5` |

**Overall status logic:**
- `healthy` — worst cache ratio ≤ 1.5 and no open circuits
- `degraded` — worst ratio between 1.5 and 2, or any circuit is open
- `stale` — worst ratio > 2

---

### `GET /api/stability-index`

Daily Pharos Stability Index (PSI) scores. The PSI is a composite ecosystem health score (0–100) aggregating peg integrity, supply growth, and liquidity depth across all tracked stablecoins.

**Cache:** standard — `X-Data-Age` and `Warning` headers included.

**Optional query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `detail` | `"true"` | — | When `"true"`, returns full history with per-day component breakdowns instead of last 91 days |

**Response**

```json
{
  "current": {
    "score": 81.1,
    "band": "STEADY",
    "components": { "severity": 4.59, "breadth": 15, "trend": 0.65 },
    "computedAt": 1771977600
  },
  "history": [
    { "date": 1771891200, "score": 81.0, "band": "STEADY" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `current` | `object \| null` | Latest PSI score and components. `null` if cron has not yet run |
| `current.score` | `number` | PSI score 0–100 |
| `current.band` | `string` | Condition band: `"BEDROCK"`, `"STEADY"`, `"TREMOR"`, `"FRACTURE"`, `"CRISIS"`, `"MELTDOWN"` |
| `current.components` | `object` | Component breakdown: `severity`, `breadth`, `trend` |
| `current.computedAt` | `number` | Unix seconds of computation |
| `history` | `array` | Historical scores, newest first. With `detail=true`, each entry includes `components` |

---

### `GET /api/report-cards`

Stablecoin risk grade cards with dimension-level scores. Grades are computed from 5 dimensions using weighted scoring.

**Cache:** standard

**Response**

```json
{
  "cards": [ReportCard, ...],
  "dependencyGraph": {
    "edges": [{ "from": "2", "to": "5" }, ...]
  },
  "methodology": {
    "version": "5.1",
    "weights": { "pegStability": 0, "liquidity": 0.30, "resilience": 0.20, "decentralization": 0.15, "dependencyRisk": 0.25 },
    "thresholds": [{ "grade": "A+", "min": 87 }, { "grade": "A", "min": 83 }, ...]
  },
  "updatedAt": 1771977600
}
```

**`dependencyGraph.edges`**: Pre-computed forward edges. `from` = upstream stablecoin ID, `to` = dependent stablecoin ID. Used by the frontend to identify targetable coins for stress testing and walk the dependency tree.

**`ReportCard`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Pharos stablecoin ID |
| `name` | `string` | Full name |
| `symbol` | `string` | Ticker |
| `overallGrade` | `string` | Letter grade: `"A+"` through `"F"`, or `"NR"` |
| `overallScore` | `number \| null` | Weighted score 0–100. `null` for unrated coins |
| `dimensions` | `Record<DimensionKey, DimensionScore>` | Per-dimension grade, score, and detail text |
| `ratedDimensions` | `number` | Number of dimensions with data (max 5) |
| `dependencies` | `DependencyWeight[] \| undefined` | Upstream stablecoin dependencies with collateral weights (for CeFi-Dependent coins) |
| `rawInputs` | `RawDimensionInputs` | Raw scoring inputs for client-side grade recomputation (stress testing) |
| `isDefunct` | `boolean` | `true` for cemetery coins (permanent F grade) |

**`DependencyWeight`**: `{ id: string, weight: number }` — upstream stablecoin ID + fraction of collateral from that source (0–1). Weights sum to ≤ 1.0; the remainder represents non-stablecoin collateral.

**`RawDimensionInputs`**

| Field | Type |
|-------|------|
| `pegScore` | `number \| null` |
| `activeDepeg` | `boolean` |
| `depegEventCount` | `number` |
| `lastEventAt` | `number \| null` |
| `liquidityScore` | `number \| null` |
| `concentrationHhi` | `number \| null` |
| `bluechipGrade` | `BluechipGrade \| null` |
| `canBeBlacklisted` | `boolean \| "possible"` |
| `chainTier` | `ChainTier` |
| `deploymentModel` | `DeploymentModel` |
| `collateralQuality` | `CollateralQuality` |
| `custodyModel` | `CustodyModel` |
| `governanceTier` | `GovernanceType` |
| `governanceQuality` | `GovernanceQuality` |
| `dependencies` | `DependencyWeight[]` |
| `navToken` | `boolean` |

**Dimensions:** `pegStability`, `liquidity`, `resilience`, `decentralization`, `dependencyRisk`

---

## Admin Endpoints

These endpoints require an `X-Admin-Key` header matching the `ADMIN_KEY` Worker secret. Unauthorized requests receive a `401` response. They are not intended for public consumption.

### `GET /api/status`

Full admin dashboard: cron run history, cache freshness for all keys, and data quality metrics.

**Headers:** `X-Admin-Key: <secret>` (required)

**Response shape:** `StatusResponse` (defined in `src/lib/types.ts`)

```json
{
  "timestamp": 1771856453,
  "overallStatus": "healthy",
  "caches": { ... },
  "crons": {
    "sync-stablecoins": {
      "lastRun": { "startedAt": 1234567890, "durationMs": 2300, "status": "success", "itemCount": 142 },
      "recentRuns": [...],
      "expectedIntervalSec": 900,
      "healthy": true
    }
  },
  "dataQuality": {
    "totalStablecoins": 142,
    "missingPrices": 3,
    "blacklistMissingAmounts": 0,
    "blacklistTotal": 13422,
    "onchainSupplyDivergences": 0,
    "activeDepegs": 12,
    "staleOnchainSupply": 0
  }
}
```

### `GET /api/backfill-depegs`

Backfills historical depeg events from stored price data.

**Headers:** `X-Admin-Key: <secret>` (required)

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Process a single stablecoin ID |
| `batch` | `integer` | `0` | Batch offset (3 coins per batch) |

### `GET /api/backfill-supply-history`

Backfills per-coin supply history snapshots.

**Headers:** `X-Admin-Key: <secret>` (required)

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Process a single stablecoin ID |
| `batch` | `integer` | `0` | Batch offset for chunked processing |
| `batchSize` | `integer` | `10` | Coins per batch |

### `GET /api/backfill-stability-index`

Backfills historical stability index scores from stored depeg events and supply data.

**Headers:** `X-Admin-Key: <secret>` (required)

### `GET /api/backfill-cg-prices`

Backfills CoinGecko historical prices into the price_cache table for more accurate depeg detection.

**Headers:** `X-Admin-Key: <secret>` (required)

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Process a single stablecoin ID |
| `batchSize` | `integer` | `10` | Coins per batch |
| `batch` | `integer` | `0` | Batch offset for chunked processing |

### `GET /api/audit-depeg-history`

Audits existing depeg events against CoinGecko historical price data to detect false positives. Supports dry-run mode.

**Headers:** `X-Admin-Key: <secret>` (required)

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Audit a single stablecoin ID |
| `limit` | `integer` | `200` | Max events to audit |
| `offset` | `integer` | `0` | Pagination offset |
| `delete` | `string` | — | Comma-separated event IDs to delete directly (skips CG audit) |
| `dry-run` | `"true"` | — | When `"true"`, preview deletions without touching DB. Default behavior deletes false positives |
| `min-supply` | `number` | `0` | Minimum supply (USD) to include in audit |
| `symbol` | `string` | — | Filter by symbol (case-insensitive) |

### `GET /api/trigger-digest`

Force-regenerates the daily digest, bypassing the normal 1-hour dedup check. Handled directly in `index.ts` (not via the router).

**Headers:** `X-Admin-Key: <secret>` (required)

**Response**

```json
{
  "ok": true,
  "result": { ... }
}
```

Returns `500` with `{ "ok": false, "error": "..." }` on failure.

### `GET /api/reset-blacklist-sync`

Rolls back blacklist sync state to re-scan missed events. EVM chains are rolled back by 50,000 blocks; Tron is rolled back by 7 days. Handled directly in `index.ts` (not via the router).

**Headers:** `X-Admin-Key: <secret>` (required)

**Response**

```json
{
  "ok": true,
  "evmReset": 12345678,
  "tronReset": 1740000000000
}
```

### `GET /api/debug-sync-state`

Returns current blacklist sync state for all configured chains. Useful for diagnosing sync issues. Handled directly in `index.ts` (not via the router).

**Headers:** `X-Admin-Key: <secret>` (required)

**Response**

```json
[
  { "config_key": "ethereum-usdc", "last_block": 19500000 },
  { "config_key": "tron-usdt", "last_block": 1740000000000 }
]
```
