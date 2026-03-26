# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins and curated lending opportunities. Computes APY from deterministic on-chain reads, curated DeFiLlama pools, protocol-native yield APIs, price history, and benchmark-derived fallbacks; scores each coin via the Pharos Yield Score (PYS); and serves a dedicated `/yield` page plus a stablecoin-detail yield section.

---

## Methodology Versioning

- **Current methodology version:** `v5.2`
- **Public changelog page:** `/methodology/yield-changelog/`
- **Canonical source:** `shared/lib/yield-methodology-version.ts`

Yield versions are bumped when APY source resolution, source arbitration, history semantics, PYS scoring logic, or score-affecting publication rules change.

Rankings provenance now carries source-native freshness for derived sources:

- `sourceObservedAt` / `sourceAgeSeconds` reflect the actual latest observation backing the ranking, not just the cron run time
- `comparisonAnchorObservedAt` / `comparisonAnchorAgeSeconds` are included when APY is derived from a prior anchor, such as price-derived and on-chain exchange-rate calculations

---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins/index.ts` is inventoried by the yield manifest. Live cron resolution operates on the active subset (`status !== "pre-launch"`), while pre-launch or intentionally uncovered assets remain visible to operators through explicit manifest entries instead of silently disappearing from coverage accounting. The sync also supports deterministic custom sources for select non-yield-bearing coins, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows synthesize protocol-derived labels when the source is `defillama-auto`.

| Field         | Type        | Description                                                                                   |
| ------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `yieldSource` | `string`    | Human-readable source name (e.g. "Ethena staking"). Optional for auto-discovered lending rows |
| `yieldType`   | `YieldType` | Mechanism classification (see below). Optional for auto-discovered lending rows               |

### Yield Types

| Type                  | Label        | Description                                                    |
| --------------------- | ------------ | -------------------------------------------------------------- |
| `lending-vault`       | Lending      | Deposited into lending protocols or vault strategies           |
| `rebase`              | Rebase       | Token supply rebases to distribute yield                       |
| `fee-sharing`         | Fee Share    | Protocol fees passed to holders                                |
| `lp-receipt`          | LP Receipt   | LP position wrapped as stablecoin                              |
| `nav-appreciation`    | NAV          | Token price appreciates as backing grows                       |
| `governance-set`      | Gov. Set     | Yield rate set by governance vote                              |
| `lending-opportunity` | Lending Opp. | Auto-discovered best lending market from the curated allowlist |

Labels and styles are centralized in `shared/lib/classification.ts` (`YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`), both typed as `Record<YieldType, ...>` so adding a new variant without updating the maps is a compile error.

---

## Source-Aware APY Resolution

The sync cron resolves APY for each coin using a priority-ordered strategy. Deterministic and curated rows can coexist; the cron then applies confidence-weighted arbitration to choose the primary row while retaining alternatives.

### Tier 1: On-Chain Reads

Reads protocol state directly via `eth_call` RPC. The main path reads vault exchange rates and computes APY from the 7-day rate delta; special-case estimators can also derive APR from raw protocol state.

**Config:** `ON_CHAIN_RATE_CONFIGS` in `worker/src/cron/yield-config.ts`

```ts
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string; // vault contract address
  selector: string; // 4-byte function selector
  decimals: number;
  inputAmount: string; // hex-encoded input (e.g. 1e18)
}
```

Currently configured for 13 vaults (all use selector `0x07a2d13a` — `convertToAssets(uint256)`):

| Coin ID | Wrapper | Contract | Chain |
|---------|---------|----------|-------|
| `usde-ethena` | sUSDe | `0x9D39...7497` | Ethereum |
| `iusd-infinifi` | siUSD | `0xDBDC...bCB` | Ethereum |
| `usdp-parallel` | sUSDp | `0x472e...7e7` | Base |
| `usds-sky` | sUSDS | `0xa393...fbD` | Ethereum |
| `dai-makerdao` | sDAI | `0x83F2...BEeA` | Ethereum |
| `crvusd-curve` | scrvUSD | `0x0655...0367` | Ethereum |
| `frxusd-frax` | sfrxUSD | `0xcf62...5b6` | Ethereum |
| `dola-inverse-finance` | sDOLA | `0xb45a...7305` | Ethereum |
| `bold-liquity` | yBOLD | `0x9F43...a3d8` | Ethereum |
| `usdf-falcon` | sUSDf | `0xc8cf...4b0` | Ethereum |
| `usn-noon` | sUSN | `0xE24a...B91D` | Ethereum |
| `ustb-superstate` | USTB | ERC-4626 (6 decimals) | Ethereum |
| `thbill-theo` | thBILL | ERC-4626 (6 decimals) | Ethereum |

`dusd-dtrinity` and `reusd-re-protocol` are intentionally quarantined from this generic Tier 1 reader for now. Their current `convertToAssets(1e18)` probes do not return a usable value, so they continue to rely on non-deterministic source paths until protocol-specific deterministic adapters are added.

**APY formula:**

```
apy = ((rate_now / rate_7d_ago) ^ (365.25 / 7) - 1) * 100
```

Even when Tier 1 succeeds, the cron still falls through to Tier 2 to collect additional wrapper/native DeFiLlama rows. If no previous exchange rate exists yet (first sync), Tier 1 emits a seed row with `currentApy: 0` and the current `exchangeRate` so the rate is persisted in `yield_history`. This breaks the bootstrapping deadlock: without the seed, the on-chain source would never resolve because it needs a 7-day-old rate, but the rate was never stored because the source never resolved. Subsequent syncs (7+ days later) will find the seed rate and compute a real APY.

#### Special-case Tier 1 estimator: LUSD / B.Protocol Stability Pool

LUSD also has a deterministic on-chain estimator for the Liquity v1 Stability Pool via B.Protocol. This row is intentionally conservative and is labeled `B.Protocol Stability Pool (LQTY only)`.

**Reads:**

- `stabilityPool.getTotalLUSDDeposits()` on Ethereum
- `communityIssuance.totalLQTYIssued()` on Ethereum
- CoinGecko `liquity` USD price

**Formula:**

```
remainingLqtyRewards = max(0, 32_000_000 - totalLQTYIssued)
dailyIssuanceFactor  = 1 - 0.5^(1 / 365)
apr                  = remainingLqtyRewards * dailyIssuanceFactor * lqtyPriceUsd / totalLUSDDeposits * 365 * 100
```

**Caveat:** This source captures only the projected LQTY incentive stream. It deliberately excludes ETH liquidation gains, so it is a lower-bound estimate of the full Stability Pool return.

### Tier 2: DeFiLlama Yields API (Multi-Source)

Collects **all** matching DL pools per coin via `matchAllDlPools` (three layers). Each unique pool found becomes a separate row in `yield_data`. The row with the highest `currentApy` per coin is marked `is_best = 1`; others are `is_best = 0`.

Before matching, the worker now preserves any single-exposure pool that is either:

- a normal DeFiLlama stablecoin pool (`stablecoin === true`), or
- explicitly relevant via `YIELD_POOL_MAP`, or
- explicitly relevant via a configured wrapper symbol in `YIELD_VARIANT_MAP`

This keeps wrapper pools like `fxSAVE` and `msY` eligible even when DeFiLlama marks them `stablecoin: false`.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"`. Finds the native/primary yield source. If a mapped UUID is missing from the DL payload, the sync logs `[yield-sync] Pool UUID ... not found in DL response, falling through` and continues to Layer 2/3 fallback matching.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol and can also pin the wrapper chain and address. Resolution prefers `(chain, address)` when available and only falls back to symbol on an unambiguous chain-scoped match. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama).

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss. Resolution first tries underlying-token address matches and only uses chain-scoped `.includes()` symbol fallback when the remaining candidate set is unambiguous. Symbols shorter than 4 characters are excluded from `.includes()` matching to prevent false positives (e.g., "USD" matching everything). Filters for `exposure === "single"` and `stablecoin === true`. Ambiguous fallback candidates are dropped instead of guessed.

**Variant mapping:** `YIELD_VARIANT_MAP` entries supply labels and pool matching for wrapper/savings tokens:

| Base Coin             | Wrapper | Purpose                     |
| --------------------- | ------- | --------------------------- |
| USDe (146)            | sUSDe   | Ethena staking wrapper      |
| USDS (209)            | sUSDS   | Sky savings wrapper         |
| GHO (118)             | sGHO    | Aave staked GHO             |
| DAI (5)               | sDAI    | Spark savings DAI           |
| crvUSD (110)          | scrvUSD | Curve staked crvUSD         |
| FRXUSD (235)          | sfrxUSD | Frax staked frxUSD          |
| DOLA (15)             | sDOLA   | Inverse Finance staked DOLA |
| BOLD (269)            | yBOLD   | Liquity yield BOLD          |
| USBD (253)            | sUSBD   | BIMA savings wrapper        |
| reUSD (339)           | stUSR   | Resolv staking wrapper      |
| AZND (327)            | loAZND  | Mu Digital locked wrapper   |
| USD.AI (309)          | sUSDai  | GAIB USD.AI savings         |
| Neutrl USD (346)      | sNUSD   | Neutrl staked USD           |
| Avalon USDa (220)     | sUSDa   | Avalon staked USDa          |
| infiniFi USD (298)    | siUSD   | infiniFi savings            |
| Falcon USD (246)      | sUSDf   | Falcon Finance savings      |
| Avant USD (271)       | savUSD  | Avant savings               |
| Unitas (283)          | sUSDu   | Unitas savings              |
| Yuzu USD (344)        | syzUSD   | Yuzu savings                |
| fxUSD (168)           | fxSAVE  | Concentrator savings        |
| Noon USN (230)        | sUSN    | Noon savings                |
| Main Street USD (297) | msY   | Main Street savings         |
| GAIB AID (353)        | sAID    | GAIB AID staking            |
| Parallel USDp         | sUSDp   | Parallel savings wrapper    |
| dUSD (dTRINITY)       | sdUSD   | dTRINITY dStake vault       |

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 2.5: Protocol-Native Yield APIs

For coins whose native savings path is published by the protocol itself but is not exposed as a usable DeFiLlama pool, the sync can ingest a curated protocol-owned earn endpoint directly.

**Current adapter:**

| Coin ID | Source | Endpoint |
| ------- | ------ | -------- |
| `usbd-bima` | `BIMA savings (sUSBD)` | `https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000` |

The BIMA adapter uses the protocol's published Ethereum earn feed, selects the USBD savings row, maps `amountTVL` to `sourceTvlUsd`, and uses the higher of `unboostedAPR` / `boostedAPR` as the current APY. Low-signal rows with negligible TVL or effectively zero APR are dropped instead of being published as meaningful yield. These rows are source-keyed as `protocol-api:bima-susbd` and participate in the same confidence-weighted arbitration as other curated sources.

### Tier 3: Price-Derived APY

For `navToken` coins and explicit `PRICE_DERIVED_FALLBACK_IDS`. Derives APY from price appreciation in the existing `supply_history` table using the oldest available anchor between 7 and 45 days. These fallback-only paths are now explicit manifest strategies rather than implicit behavior hidden behind `navToken`.

```
apy = ((price_now / price_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists or if the coin has fewer than 7 days of priced history.

**Tier 3 as additional source:** For `navToken` and `PRICE_DERIVED_FALLBACK_IDS` coins, Tier 3 also runs when Tier 2 found sources but they all report 0% APY. This handles DL pools that exist but have stale/broken yield data (e.g., a tiny Aave lending market matched via Layer 3 symbol fallback). The price-derived source is added alongside the DL source, and `is_best` picks the higher-APY winner.

**Known limitation:** Price-derived cannot capture yield for tokens that distribute dividends as new tokens while maintaining a fixed $1.00 NAV (e.g., BUIDL, YLDS). These tokens use the rate-derived tier instead (see below).

### Tier 4: Rate-Derived APY

For dividend-distributing tokens (maintain $1.00 NAV, pay yield as new token mints) and T-bill-backed funds whose yield mechanically tracks short-term rates. Configured via `RATE_DERIVED_CONFIGS` in `yield-config.ts`.

```
apy = max(0, cachedTbillRate - spreadBps / 100)
```

Uses the structured `risk_free_rate` cache already refreshed daily by `fetch-tbill-rate` (FRED DGS3MO). If FRED fails, the cron retains the last known good benchmark when available and marks provenance as degraded instead of immediately snapping back to the hardcoded fallback.

**Configured tokens:**

| Token | Spread (bps) | Rationale |
| ----- | ------------ | --------- |
| BUIDL | 20 | BlackRock fund, 0.20% management fee |
| USYC | 50 | Hashnote fund, modeled as ~10% performance fee at a 5% T-bill baseline |
| YLDS  | 50 | Figure Markets, T-bill rate - 50 bps formula |
| USTB  | 15 | Superstate, 0.15% management fee |
| mTBILL | 0 | Midas, tracks T-bill rate directly |
| OUSG  | 50 | Ondo US Government Bond fund, 0.50% management fee |
| thBILL | 0 | Theo thBILL, modeled as Treasury-rate passthrough |

Rate-derived runs after Tier 3 in the resolution loop and participates in the `is_best` selection like any other source. For tokens that also have price-derived or DL sources, the highest-APY source wins.

### Automatic Lending Pool Discovery (Wave 2)

For tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), the sync cron can append the best lending pool from a curated protocol allowlist. This runs after the base four-tier resolution, so yield-bearing coins can also receive an additional `defillama-auto` source row when a distinct lending market passes filters. LUSD uses this to retain Aave as an alternative source alongside the deterministic B.Protocol estimate.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/cron/yield-config.ts`):

| Tier   | Protocols                                                                |
| ------ | ------------------------------------------------------------------------ |
| Tier 1 | aave-v3, compound-v2, compound-v3, dolomite, sparklend, spark-savings, maple, yearn-finance |
| Tier 2 | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, morpho-blue, pendle, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2 |
| Tier 3 | justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx, benqi-lending |
| Tier 4 | radiant-v2, fraxlend-v2, clearpool, centrifuge, sturdy-v2, goldfinch, truefi, lagoon, liqwid, lista-lending, loopscale, more-markets, navi-lending, overnight-finance, smardex-usdn, vesper |
| Tier A (2026-03-25, >$50M TVL) | wildcat-protocol, tectonic, upshift, venus-flux, avantis, cap, resupply, zerobase-cedefi |
| Tier B (2026-03-25, $10M–$50M TVL) | convex-finance, yo-protocol, clearpool-lending, 3jane-lending, hyperlend-pooled, zest-v2, liquity-v2, echelon-market, termmax, beefy, gearbox |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, and reserved-pool exclusion. Resolution prefers underlying-token address matches over symbol matches. Symbol-only matching is allowed only when the coin remains unambiguous after chain scoping; otherwise the candidate is dropped. Current quality gates require `apy >= 0.1` and `tvlUsd >= 100_000`.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend. The direct Aave v3 on-chain supply-rate path uses the same classification so rankings/cache schema validation stays aligned across deterministic and auto-discovered lending rows.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

**Explicit deterministic edge cases:** `AUTO_LENDING_POOL_MAP` can also pin a small number of exact-symbol, single-asset lending markets for coins that would otherwise be blocked by ambiguous matching or by the generic safety gate. These rows still pass the same pool-shape and source-quality checks; the bypass is coin-specific and documented rather than global.

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against safety and consistency.

**Formula (`yield-helpers.ts::computePYS`):**

```
riskPenalty         = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency     = apy30d / riskPenalty
sustainabilityMult  = max(0.3, 1.0 - apyVarianceScore)
PYS                 = min(100, round(yieldEfficiency * sustainabilityMult * scalingFactor))
```

**Components:**

| Component          | Range    | Meaning                                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------------------- | ---- | --------- |
| `safetyScore`      | 0–100    | Report card overall score. `DEFAULT_SAFETY_SCORE` (40) for unrated coins                    |
| `riskPenalty`      | 0.5–5.05 | Divisor derived from safety (A+ coin → 0.55, F → 4.55)                                      |
| `apyVarianceScore` | 0–1 or null | Coefficient of variation of 30-day APY samples, clamped to [0, 1]. Returns null if < 2 samples or mean ≈ 0 (`|mean| < 1e-10`); PYS caller defaults null to 0 |
| `scalingFactor`    | 5        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`)                                    |

Returns 0 when `apy30d <= 0`.

Frontend components display PYS breakdown via `computePysBreakdown()` in `src/lib/yield-constants.ts`, which mirrors the intermediate values (`riskPenalty`, `yieldEfficiency`, `sustainabilityMult`) from the worker's `computePYS()`. The final PYS value is always served by the API.

### Supporting Metrics

| Metric           | Formula                               | Description                                                                   |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------- | ---- | --------- |
| `yieldStability` | `1 - CV(30d samples)`                 | 0–1, higher = more consistent. Null if < 2 samples or mean ≈ 0 (`|mean| < 1e-10`) |
| `yieldToRisk`    | `apy30d / (101 - safetyScore)`        | Raw yield per unit of risk                                                    |
| `excessYield`    | `apy30d - riskFreeRate`               | Yield above the T-bill benchmark                                              |
| `apy7d`          | Timestamp-filtered 7d average         | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing) |
| `apy30d`         | Simple average of 30d samples         | 30-day trailing APY                                                           |
| `variance30d`    | Standard deviation of 30d APY samples | APY volatility measure                                                        |

---

## Risk-Free Rate (T-Bill)

Fetched daily by the `fetch-tbill-rate` cron from FRED's 3-month Treasury yield series (`DGS3MO`).

**Source URL:**

```
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO
```

**Stored as:** `cache` table, key `"risk_free_rate"`.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 3.75%`.

When FRED fetches fail after a previously good benchmark has been cached, the worker now prefers retaining that last-known-good rate and marks it as degraded fallback (`isFallback: true`) instead of silently publishing it as healthy. The hardcoded fallback is used when no retained benchmark is available.

**Usage:** The 30-min yield sync reads the cached rate. The scatter plot renders it as a dashed reference line, and `excessYield` is computed against it.

---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores baseline results in the `warning_signals` column of `yield_data`. Rankings responses also add a read-time freshness signal. Frontend-visible warning keys are:

| Signal             | Condition                                              | Meaning                              |
| ------------------ | ------------------------------------------------------ | ------------------------------------ |
| `yield-spike`      | `currentApy > 2% AND currentApy / apy30d > 2.0`       | Sudden 2× jump vs. 30d average (absolute floor: 2% APY) |
| `yield-divergence` | `currentApy > medianApy * 3`                           | 3× the market median                 |
| `negative-trend`   | `apy30d > 1% AND currentApy < apy30d * 0.7`           | 30% decline from average (absolute floor: 1% baseline) |
| `reward-heavy`     | `apyReward / apy > 0.8`                                | 80%+ from incentives, not base yield |
| `tvl-outflow`      | TVL dropped > 20% from prev week                       | Capital leaving the protocol         |
| `zero-yield`       | `currentApy === 0 AND apy30d > 0.5%`                   | Yield dropped to zero but had recent activity |
| `data-stale`       | `updated_at` > 90 min old (`STALE_THRESHOLD_MS` in `worker/src/cron/yield-helpers.ts`) | Yield data hasn't refreshed in 90+ min |

All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.

At rankings cache-build time, `sync-yield-data` decorates rows with the read-time-only `data-stale` signal when `updated_at` is older than 90 minutes (`STALE_THRESHOLD_MS`). This signal is included in cached rankings responses but is not written back to `yield_data`.

The sync also performs a confidence-aware cross-source arbitration pass before `is_best` is chosen:

- deterministic sources (`onchain`, `rate-derived`) outrank curated protocol-native and DeFiLlama rows
- curated DeFiLlama rows outrank discovered lending opportunities and fallback-derived rows
- non-positive APY rows cannot outrank positive rows
- materially divergent discovered or fallback rows can be rejected when a higher-confidence canonical source disagrees by more than 35%
- a `canonical-zero-vs-positive` anomaly is flagged when a high-confidence source reads 0% but a lower-confidence source reports > 1% APY

This selection behavior is surfaced in row-level `provenance` metadata on `/api/yield-rankings`.

---

## Database Schema

**Migrations:** the current checked-in schema lives in `worker/migrations/0000_baseline.sql`. Historical pre-squash yield schema changes (initial table creation, warning signals, multi-source keys, and source-aware history rows) are tracked in `worker/migrations/MANIFEST.md`.

### `yield_data` — Current Snapshot (one row per coin per source)

```sql
CREATE TABLE yield_data (
  stablecoin_id       TEXT NOT NULL,
  source_key          TEXT NOT NULL,  -- DL pool UUID, "onchain:<stablecoin_id>", "price-derived", or "rate-derived"
  symbol              TEXT NOT NULL,
  current_apy         REAL NOT NULL,
  apy_base            REAL,
  apy_reward          REAL,
  apy_7d              REAL NOT NULL,
  apy_30d             REAL NOT NULL,
  yield_source        TEXT NOT NULL,
  yield_type          TEXT NOT NULL,
  source_pool         TEXT,           -- DL pool UUID
  source_tvl_usd      REAL,
  data_source         TEXT NOT NULL,  -- "onchain" | "defillama" | "defillama-auto" | "price-derived" | "rate-derived"
  safety_score        REAL,
  safety_grade        TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,           -- 0-1
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,           -- current vault rate (Tier 1 only)
  exchange_rate_prev  REAL,           -- 7d-ago vault rate
  warning_signals     TEXT,           -- JSON array of active signal keys (migration 0033)
  is_best             INTEGER NOT NULL DEFAULT 1,  -- 1 = highest-APY source per coin
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);
```

**Indices:** `idx_yield_pys` (PYS DESC), `idx_yield_apy` (apy_30d DESC), `idx_yield_best` (stablecoin_id, is_best).

**Multi-source behavior:** Coins with both a native pool and a savings wrapper get two rows — one with `is_best = 1` (highest current APY), one with `is_best = 0`. This also covers mixed source types such as LUSD, where a deterministic on-chain B.Protocol row can coexist with an auto-discovered Aave lending row. Rankings queries filter `WHERE is_best = 1`. Alt-source rows are read separately and attached as `altSources[]` in the cached API response. After each batch write, stale rows for coins refreshed in that run are purged so old primary sources cannot linger alongside the new winner.

### `yield_history` — Historical Data Points

```sql
CREATE TABLE yield_history (
  stablecoin_id   TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,  -- Unix seconds
  is_best         INTEGER NOT NULL DEFAULT 0,
  apy             REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  warning_signals TEXT,
  yield_source    TEXT,
  yield_type      TEXT,
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);
```

**Indices:** `idx_yield_hist_coin` (stablecoin_id, recorded_at DESC), `idx_yield_hist_coin_source` (stablecoin_id, source_key, recorded_at DESC), `idx_yield_hist_best` (stablecoin_id, is_best, recorded_at DESC).

**Retention:** 365 days. Older rows are pruned at the end of each sync run.

**Legacy migration behavior:** historical pre-migration rows are preserved as `source_key = 'legacy-best'`. Same-source trailing metrics only reuse these rows when the coin currently has a single resolved source **and** the legacy source family matches the current source family. If the current winner changed source family (for example price-derived → rate-derived), the new source starts a clean series instead of inheriting mixed legacy history.

**Estimated volume:** ~40 coins × 48 points/day × 365 days ≈ 701K rows/year.

---

## Cron Jobs

### `sync-yield-data`

**Schedule:** `10,40 * * * *` (every 30 min, Trigger 6)
**Files:** `worker/src/cron/sync-yield-data.ts` orchestration + `worker/src/cron/yield-sync/{cache,sources,resolve,evaluation,publication,history,rankings}.ts`

**Execution flow:**

1. Filter `TRACKED_STABLECOINS` where `flags.yieldBearing === true` for the base four-tier resolution, then evaluate auto-discovery across all eligible tracked non-gold/silver coins
2. Fetch DeFiLlama pools (`https://yields.llama.fi/pools`) — circuit-breaker protected
3. Fetch on-chain exchange rates via `eth_call` for `ON_CHAIN_RATE_CONFIGS` entries, using small batched concurrency so deterministic sources do not self-inflict RPC burst failures
4. Read cached risk-free rate from D1
5. Compute safety scores via shared helper `computeSafetyScoresSnapshot(db, { includeNavTokens: true, outputMode: "map" })`; this helper now reuses the same peg-analytics path as `/api/report-cards` so live peg deviation inputs stay aligned across Safety Score and Yield Intelligence. Treat the helper's explicit degraded result as degraded input, and also classify coverage below the minimum ratio as degraded even when the helper itself succeeded
6. Resolve APY for each yield-bearing coin (Tier 1 → 2 → 3 → 4, potentially multiple sources per coin), then append auto-discovered lending rows for any remaining eligible tracked coins
7. Batch preload source-aware `yield_history` datasets (previous best source, previous TVL by source, 30d APY history by source) and legacy best-history fallbacks, chunking stablecoin ID lists so each D1 statement stays under the 100-bind limit
8. Compute 7d/30d APY, variance, and PYS per resolved source using source-specific history instead of coin-level mixed history
9. Run confidence-weighted arbitration to select `is_best` per coin and flag source switches vs. the prior best source
10. NaN/Infinity guard: clamp PYS, variance, and stability to finite values before DB write
11. Batch upsert `yield_data` (all sources) + insert `yield_history` points for every resolved source with `is_best` markers
12. Purge stale rows for refreshed coins so obsolete primary/alt sources are removed together, then scan `yield_data` for orphan coin IDs and delete those in chunked `IN (...)` batches instead of a single large `NOT IN (...)`
13. Prune `yield_history` older than 365 days
14. Query best-source rows, fetch alt-source rows, attach as `altSources[]`, add read-time `data-stale` warning decoration from `updated_at` age, and include top-level + per-row provenance in the cached rankings payload whenever the payload passes schema validation and the new payload has not collapsed severely versus the previous cache. Safety-degraded runs still publish fresh rankings when the payload is valid but skip `report_card_cache`.

**Degraded semantics:** If `computeSafetyScoresSnapshot()` returns a degraded result, safety coverage is below the minimum ratio (0.75), the benchmark is on a true fallback path (`isFallback === true`), the `fallbackMode` contains `"retained"` (indicating FRED fetch failure with last-known-good retention), the retained last-known-good benchmark is older than 48 hours, DeFiLlama pool inputs are unavailable, the direct DeFiLlama fetch payload is invalid or yields zero relevant stablecoin pools, all configured deterministic on-chain sources fail in the same cycle, or rankings publication fails schema/severe-shrink guards, `sync-yield-data` returns `status: "degraded"`. Retained benchmark metadata still appears in rankings provenance via `provenance.benchmark.fallbackMode`, including the last market-derived rate/date/source preserved across fallback streaks. Schema-invalid or severe-shrink runs skip cache overwrite. Safety-degraded runs continue to publish a fresh `yield-rankings` cache when the rankings payload is valid, but they still skip `report_card_cache` writes so the degraded condition remains visible without taking the public API offline.

Implementation stages:
- `yield-sync/sources.ts` + `yield-sync/pool-filter.ts`: DL pool loading, wrapper-relevant pool filtering, on-chain reads, risk-free rate cache, price-derived and B.Protocol helpers
- `yield-sync/resolve.ts`: per-coin source resolution and auto-discovery candidate shaping
- `yield-sync/evaluation.ts`: source-aware history normalization, trailing metric computation, confidence arbitration, and source-switch tracking
- `yield-sync/publication.ts` + `yield-sync/rankings.ts`: persistence helpers, rankings shaping, provenance/warning parsing, TVL-weighted median helper, and cache writes
- `yield-sync/history.ts`: batched history preloads plus stale/orphan cleanup
- `sync-yield-data.ts`: safety snapshot handling, orchestration glue, and degraded-mode policy

**Shared safety scores:** The report-cards API handler doesn't cache results, so both yield sync and daily digest call the same shared safety-score pipeline. That helper now shares peg analytics with `/api/report-cards`, preventing rated coins with live price/peg coverage from falling back to `NR` inside yield rankings. It still uses the two-phase dependency approach (independent first, then CeFi-dependent).

**Batch query policy:** No per-coin query loops are used for the three high-volume `yield_history` reads (previous exchange rate, previous TVL, 30d APY history); these are loaded in chunked batches and indexed by stablecoin ID in-memory. Cleanup deletes also chunk ID lists to stay under D1's 100-bound-parameter cap.

### `fetch-tbill-rate`

**Schedule:** `0 8 * * *` (daily, Trigger 9)
**File:** `worker/src/cron/fetch-tbill-rate.ts`

Fetches the latest T-bill proxy rate from FRED (`DGS3MO`). Validates the rate (must be 0–20%), stores in cache. Falls back to `RISK_FREE_RATE_FALLBACK` on any failure.

When FRED fails but a prior benchmark exists, the cache now preserves the last market-derived benchmark fields (`lastMarketRate`, `lastMarketRecordDate`, `lastMarketFetchedAt`, `lastMarketSource`) across retained fallback streaks. That lets downstream yield provenance distinguish "still carrying the last market rate" from a hardcoded benchmark floor.

---

## API Endpoints

### `GET /api/yield-rankings`

Cache-backed rankings written by `sync-yield-data`, with `safetyScore`, `safetyGrade`, `yieldToRisk`, and `pharosYieldScore` hydrated from the current report-card snapshot at API read time. This keeps Yield Intelligence aligned with `/api/report-cards` even when underlying safety inputs move between yield cron runs. If a ranking row has no matching live report-card snapshot, the API now retains the row and falls back to `DEFAULT_SAFETY_SCORE` (`40`) and grade `NR` instead of dropping coverage.

**Cache profile:** Standard (`s-maxage=300, max-age=60`)

**Response shape:**

```json
{
  "rankings": [
    {
      "id": "usde-ethena",
      "symbol": "USDe",
      "name": "Ethena USDe",
      "currentApy": 12.4,
      "apy7d": 11.8,
      "apy30d": 10.2,
      "apyBase": 10.2,
      "apyReward": null,
      "yieldSource": "Ethena staking (sUSDe)",
      "yieldSourceUrl": "https://ethena.fi/",
      "yieldType": "lending-vault",
      "dataSource": "defillama",
      "sourceTvlUsd": 5200000000,
      "pharosYieldScore": 28,
      "safetyScore": 65,
      "safetyGrade": "B",
      "yieldToRisk": 0.33,
      "excessYield": 5.95,
      "yieldStability": 0.82,
      "apyVariance30d": 2.1,
      "apyMin30d": 7.5,
      "apyMax30d": 15.3,
      "warningSignals": [],
      "altSources": [
        {
          "sourceKey": "ee0b7069-...",
          "yieldSource": "Concentrator (fxSAVE)",
          "yieldSourceUrl": "https://fx.aladdin.club",
          "yieldType": "lending-vault",
          "currentApy": 9.1,
          "apy30d": 8.8,
          "sourceTvlUsd": 31000000,
          "dataSource": "defillama"
        }
      ],
      "provenance": {
        "confidenceTier": "curated",
        "selectionReason": "curated canonical source selected by confidence-weighted arbitration",
        "sourceSwitch": false
      }
    }
  ],
  "riskFreeRate": 3.76,
  "scalingFactor": 5,
  "medianApy": 4.21,
  "updatedAt": 1772000000
}
```

Default sort: `pharos_yield_score` DESC. `altSources` is an empty array for coins with only one yield source. `medianApy` is the TVL-weighted median of best-source `apy30d` values and is used by peer-reference warning heuristics.

Each best-source row and alt-source row can also include `yieldSourceUrl`. The worker resolves this from the curated yield-source link registry (`worker/src/lib/yield-source-links.ts`) and falls back to coin metadata links when no source-specific override exists.

`medianApy` type: `number`.

The response includes a `_meta` freshness object (see [Response Body Freshness](api-reference.md#response-body-freshness-_meta)) indicating data age and staleness status. The frontend uses this to power the `StaleDataBanner` on the yield page.

### `GET /api/yield-history`

Historical APY data points for a single coin. Reads from `yield_history` directly. If a stored `warning_signals` payload is malformed, the API treats it as an empty array rather than failing the whole request.

**Cache profile:** Slow (`s-maxage=3600, max-age=300`)

| Param        | Type    | Default  | Bounds | Description          |
| ------------ | ------- | -------- | ------ | -------------------- |
| `stablecoin` | string  | required | —      | Pharos stablecoin ID |
| `days`       | integer | 90       | 1–365  | Lookback window      |
| `mode`       | string  | best     | —      | `best` for historically selected best-source rows |
| `sourceKey`  | string  | —        | —      | When present, returns source-specific history for that source key |

**Response:** Envelope with:

- `current`: latest row in the returned window, or `null`
- `history`: array sorted by `date` ASC
- `methodology`: standard methodology envelope for Yield Intelligence

Each `history` row includes:

- `date`
- `apy`
- `apyBase`
- `apyReward`
- `exchangeRate`
- `sourceTvlUsd`
- `warningSignals`
- `sourceKey`
- `yieldSource`
- `yieldSourceUrl`
- `yieldType`
- `dataSource`
- `isBest`
- `sourceSwitch`

`warningSignals` type: `string[]`.

---

## Frontend

### Page: `/yield`

**Files:** `src/app/yield/page.tsx` (SSG wrapper), `src/app/yield/client.tsx` (interactive)

**Layout (top to bottom):**

1. Stale data banner (triggers at 2 × 30 min = 60 min)
2. Summary stat cards — Average Yield (TVL-weighted), Risk-Free Rate, Best Risk-Adjusted (highest PYS)
3. Yield vs Safety scatter plot
4. Yield leaderboard table
5. Disclaimer

### Stablecoin Detail: `YieldDetailSection` (`src/components/yield-detail-section.tsx`)

Yield intelligence section for stablecoin detail pages. Shows stat cards (Current APY, 30d APY, PYS with breakdown, Stability, Excess Yield), source info, source links, alt sources, warning callouts, embedded `YieldHistoryChart`, and contextual methodology hints / footer links for PYS and yield stability. Conditional: only renders for coins with yield data.

It reuses the cached `/api/yield-rankings` payload to find the coin's best-source row, surfaces row-level provenance (selection reason, source age, benchmark state, source-switch state), and passes the shared risk-free rate, peer median, and source list into `YieldHistoryChart`.

**Layout (top to bottom):**

1. Header row: "Yield Intelligence" + yield-type badge from `YIELD_TYPE_LABELS` / `YIELD_TYPE_STYLES`
2. Warning treatment:
   - 2+ active signals: amber callout block listing every warning label
   - 1 active signal: compact inline alert row
3. Five stat cards: Current APY, 30d APY, PYS (with click/focus disclosure for the score breakdown), Stability, Excess Yield
4. Source info row: clickable source name, normalized data-source badge, source TVL
5. Alternative sources list when `altSources.length > 0`
6. Shared `YieldHistoryChart`

The section returns `null` once rankings have loaded and the coin is neither `yieldBearing` nor present in the rankings cache. If a coin is marked `yieldBearing` in metadata but has no ranking row yet, it renders an inline empty/error state instead of silently disappearing.

### `YieldScatterPlot` (`src/components/yield-scatter-plot.tsx`)

Recharts scatter chart. X = safety score, Y = APY (%). The chart plots one best-source point per stablecoin, auto-focuses the x-axis on the occupied safety-score band instead of always rendering the full 0-100 range, and keeps the safety threshold at 60 visible for quadrant context. Scatter markers render each stablecoin's logo (with an initial fallback if no logo exists), and yield type information lives in the tooltip instead of a separate legend. Rare high-APY outliers are pinned to a disclosed top rail so one extreme point does not flatten the rest of the plot.

**Quadrants** (divided at safety = 60 and APY = T-bill rate):

| Quadrant     | Position                  | Color              |
| ------------ | ------------------------- | ------------------ |
| Sweet Spot   | High safety, above T-bill | Green (5% opacity) |
| Danger Zone  | Low safety, above T-bill  | Red (5% opacity)   |
| Play It Safe | High safety, below T-bill | Blue (5% opacity)  |
| Why Bother?  | Low safety, below T-bill  | Gray (5% opacity)  |

Dashed reference line at the T-bill rate. Click a dot to navigate to that coin's detail page.

### `YieldLeaderboard` (`src/components/yield-leaderboard.tsx`)

Tabbed, sortable, paginated table (25 rows/page). Default sort: PYS descending. Table headers for `PYS`, `Stability`, and `Signals` now use the shared methodology-hint trigger so users can read the local definition without leaving the leaderboard.

The leaderboard is split into two source-aware tabs:

- `Native Yield` — best-source rows where `dataSource !== "defillama-auto"`
- `Lending Opportunities` — auto-discovered rows where `dataSource === "defillama-auto"`

Each tab includes a filter row above the table:

- **Yield type pills (multi-select):** One pill per yield type present in the current tab's data (not global). Active pills use `YIELD_TYPE_STYLES[type].badge`; inactive pills use a muted outline. Users can toggle any subset on/off.
- **Hide warned checkbox:** Excludes rows with one or more active warning signals (`warningSignals.length > 0`) when enabled.

Tab selection and both filters feed rows into the shared sort/pagination pipeline. With `resetPageOnTotalChange: true`, page index automatically resets to 0 whenever those controls change the input row count.

**Columns:** Rank, Coin (logo + symbol), APY (30d), Grade, PYS, Source, Type (badge), TVL, Stability (bar + %), 30d Range, Signals, and a trailing chevron for row expansion.

Stability display multiplies the raw 0–1 value by 100 for both the bar width and the percentage text.

**PYS tooltip:** Hovering a non-null PYS score opens a component breakdown tooltip with Yield Efficiency (`apy30d / riskPenalty`), the APY-to-risk line, Safety (grade + score with `40` fallback), and Consistency (`max(0.3, yieldStability)` shown as a percentage).

**Signals column (desktop/tablet):** Rows with no active warnings show an em dash. Rows with one warning show an amber outline alert icon. Rows with two or more warnings show a filled amber icon and an additional subtle amber left border on the row. Hovering the icon opens a tooltip with human-readable warning descriptions (`yield-spike`, `yield-divergence`, `negative-trend`, `reward-heavy`, `tvl-outflow`, `zero-yield`, `data-stale`).

**Alt-sources badge:** When a coin has `altSources.length > 0`, a `+N` pill badge appears next to the source name in the Source column. Clicking it opens a small inline popover listing each alternative source name, clickable source link, and current APY.

**Inline expansion:** Clicking a leaderboard row toggles an inline `YieldHistoryChart` panel directly beneath that row. The expanded panel repeats the selected source as a clickable link above the chart, passes the page-level `riskFreeRate`, `medianApy`, and available source list into compact mode, and only one row can remain expanded at a time.

### `YieldHistoryChart` (`src/components/yield-history-chart.tsx`)

The chart now supports source-aware inspection. When alternative sources exist, users can switch between:

- `Best source`: historically selected best-source rows (`mode=best`)
- a specific retained source row (`sourceKey=<key>`)

This lets the detail page and leaderboard inspect the actual history of an alternative source instead of only showing its current snapshot.

Recharts line chart. Primary APY line with optional base/reward breakdown toggle. Two reference lines: T-bill rate and peer median APY. Warning signal markers on data points. Time presets: 7d / 30d / 90d / 1y.

It reads `/api/yield-history` through `useYieldHistory`, and points carrying `warningSignals` get amber markers so spike/divergence/reward-heavy regimes are visible without expanding the tooltip.

The control row exposes four fixed lookback presets (`7d`, `30d`, `90d`, `1y`) plus an optional breakdown toggle. Compact mode keeps the same data semantics for inline leaderboard expansion, but shortens the chart height to 200px and drops reference-line labels to protect legibility in tighter rows.

### Hooks

| Hook               | File                     | Endpoint              | Stale Time            |
| ------------------ | ------------------------ | --------------------- | --------------------- |
| `useYieldRankings` | `src/hooks/api-hooks.ts` | `/api/yield-rankings` | `CRON_30MIN` (30 min) |
| `useYieldHistory`  | `src/hooks/api-hooks.ts` | `/api/yield-history`  | `CRON_30MIN` (30 min) |

---

## Constants

**File:** `worker/src/lib/constants.ts`

| Constant                        | Value                                                       | Purpose                                          |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `RISK_FREE_RATE_FALLBACK`       | 3.75                                                        | Fallback T-bill rate (%)                         |
| `FRED_TBILL_CSV_URL`            | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO` | FRED daily 3-month Treasury yield series         |
| `PYS_SCALING_FACTOR`            | 5                                                           | PYS distribution tuning parameter                |
| `DEFAULT_SAFETY_SCORE`          | 40                                                          | Safety score for unrated coins (most NAV tokens) |
| `CIRCUIT_SOURCE.DL_YIELDS`      | `"defillama-yields"`                                        | Circuit breaker key for DL Yields API            |
| `CIRCUIT_SOURCE.TREASURY_RATES` | `"treasury-rates"`                                          | Circuit breaker key for risk-free rate fetch     |

---

## Testing

**Pure function tests:** `worker/src/cron/__tests__/yield-helpers.test.ts`

- `computeApyFromRate` — 7-day rate change, zero/negative inputs, decreasing rates
- `computeApyFromPrice` — delegates to `computeApyFromRate`
- `computePYS` — safe high-yield, safety penalty, variance penalty, 100 cap, negative APY
- `computeYieldStability` — stable vs. volatile yields, empty/single samples, near-zero mean → null guard
- `computeApyVarianceScore` — near-zero mean → null guard, insufficient samples → null
- `detectWarningSignals` — yield spike (with absolute floor), negative trend (with absolute floor), reward-heavy, TVL outflow, zero-yield, healthy baseline, boundary conditions, negative APY input
- `matchAllDlPools` — Layer 1/2/3 source matching, dedup, relaxed Layer 2 stablecoin filter, exact symbol match (no cross-contamination), highest-TVL selection, empty pools edge case, Layer 3 minimum symbol length guard (4-char cutoff)
- `findBestLendingPool` — allowlist filtering, symbol match, address fallback, quality gates
- `computeTvlWeightedMedianApy` — empty input, null/zero TVL, single row, TVL-weighted vs simple median, zero APY filtering

**Integration tests:** `worker/src/cron/__tests__/sync-yield-data.test.ts`

- Happy path, stale/orphan cleanup, D1 chunking, cached DL pools, deterministic auto-discovery override, B.Protocol LUSD, DL API failure, circuit breaker open, schema validation, price-derived fallback, source-specific history, legacy history carry-forward, rate-derived, degraded safety coverage
- Deterministic/native coexistence: verifies on-chain rows can coexist with curated native rows without source-key collision
- Auto-discovery labeling: verifies `defillama-auto` rows on yield-bearing coins publish protocol-derived labels and `lending-opportunity`
- Retained benchmark degradation: verifies retained FRED fallback stays marked degraded in rankings provenance

**Pool-filter tests:** `worker/src/cron/__tests__/pool-filter.test.ts`

- Preserves stablecoin single-exposure pools
- Preserves explicitly relevant wrappers like `fxSAVE` even when upstream `stablecoin` is false
- Rejects unrelated non-stablecoin pools and non-single exposure pools

**Resolve/arbitration tests:** `worker/src/cron/__tests__/yield-resolve.test.ts`

- DL curated source selection, deterministic rate-derived preference, cross-source divergence rejection, T-bill excess yield, negative excess yield, hardcoded fallback rate, rate-derived from T-bill, rate floor at zero, yield-spike warning, TVL-outflow warning, stable conditions, PYS computation, PYS=0 for zero APY
- Price-derived as explicit source (Tier 3 path through resolve for navToken coins)
- Auto-discovery path (non-yield-bearing coin matches a lending pool via `AUTO_LENDING_POOL_MAP`)

**Cache parsing tests:** `worker/src/cron/__tests__/yield-cache.test.ts`

- `parseRiskFreeRateCache` — valid JSON, malformed JSON, missing fields
- `parseDlStablecoinPoolsCache` — valid JSON, malformed JSON, legacy format, missing fields, cache age computation, stale cache rejection

**Source link tests:** `worker/src/lib/__tests__/yield-source-links.test.ts`

- Curated protocol link for discovered source, source-specific override, metadata app link fallback, website fallback
- No-match case: returns null when no curated link, no protocol match, and no metadata link
- New lending protocols: verifies newly added protocol (Radiant v2) resolves a URL

---

## Edge Cases

- **First sync (no history):** `apy7d` and `apy30d` equal `currentApy`. PYS still computed.
- **On-chain rate bootstrapping:** When a Tier 1 vault has no previous exchange rate in history (first 7 days after config is added), the sync emits a seed row with `currentApy: 0` and the current `exchangeRate`. This persists the rate in `yield_history` so future cycles can compute APY once a 7-day-old reference point exists.
- **Unrated coins (no safety grade):** Safety score defaults to `DEFAULT_SAFETY_SCORE` (40, D-equivalent). Most NAV tokens hit this path since the report card framework doesn't grade them yet.
- **Incomplete live safety hydration:** rankings rows stay published with safety fallback `40 / NR` instead of being dropped.
- **All tiers fail:** Coin is recorded with `yield: null` and skipped in the write phase. No PYS computed. Logged as warning.
- **Negative APY:** Stored and displayed. PYS returns 0 for `apy30d <= 0`.
- **DL Yields circuit-broken:** Tier 2 skipped entirely. Coins with Tier 1 or Tier 3 coverage still get APY. Others get `yield: null`.
- **Cron gaps (7d filter):** The 7d trailing average uses timestamp-based filtering (`recorded_at >= now - 7d`) rather than proportional slicing, so gaps don't shift the window.
- **DL pool returns 0% for navToken:** When Tier 2 finds a DL pool but it reports 0% APY, Tier 3 price-derived is tried as an additional source. The `is_best` logic picks the higher APY. This covers upstream DL data staleness and spurious Layer 3 symbol matches.
- **Dividend-distributing tokens (BUIDL, YLDS):** These maintain a fixed $1.00 NAV and distribute yield as new tokens. Price-derived returns ~0% because the price doesn't change. Resolved via Tier 4 rate-derived, which computes APY from the cached T-bill rate minus the token's management fee spread.
- **Malformed persisted warning payloads:** `yield-history` treats them as `[]` so a single bad row cannot 500 the endpoint.

---

## File Index

| File                                                 | Role                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/migrations/0000_baseline.sql`                | Baseline `yield_data` / `yield_history` schema, including the historical multi-source and warning-signal additions                           |
| `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | Yield sync orchestration and stage modules: source loading, resolution, evaluation, publication, history maintenance, and rankings caching |
| `worker/src/cron/yield-config.ts`                    | Static config: `YIELD_POOL_MAP`, `YIELD_VARIANT_MAP`, `ON_CHAIN_RATE_CONFIGS`, `RATE_DERIVED_CONFIGS`                                        |
| `worker/src/cron/yield-helpers.ts`                   | Pure functions: APY, PYS, stability, variance, warning signals, `matchAllDlPools`                                                            |
| `worker/src/cron/yield-sync/pool-filter.ts`          | Pre-filter for wrapper-relevant DeFiLlama pools before matching                                                                               |
| `worker/src/lib/yield-source-links.ts`               | Curated yield-source link registry plus metadata fallback resolver for rankings/history payloads                                               |
| `worker/src/cron/fetch-tbill-rate.ts`                | Daily T-bill rate cron                                                                                                                       |
| `worker/src/api/cache-handlers.ts`                   | Cache-backed `GET /api/yield-rankings` handler with live Safety Score hydration (`handleYieldRankings`)                                      |
| `worker/src/api/yield-history.ts`                    | `GET /api/yield-history` handler                                                                                                             |
| `shared/types/index.ts`                              | `YieldConfig`, `YieldType`, `YieldRanking` (`.altSources: AltYieldSource[]`), `AltYieldSource`, `YieldRankingsResponse`, `YieldHistoryPoint` |
| `shared/lib/classification.ts`                       | `YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`                                                                                                     |
| `src/hooks/api-hooks.ts`                             | TanStack Query hook exports for `useYieldRankings()` and `useYieldHistory()`                                                                |
| `src/lib/yield-constants.ts`                         | Warning-signal labels, `formatYieldWarningSignal`, `getPysColor`, `computePysBreakdown` — shared frontend yield utilities                    |
| `src/lib/__tests__/yield-constants.test.ts`          | Unit tests for shared frontend yield utilities                                                                                               |
| `src/app/yield/page.tsx`                             | SSG page wrapper with metadata                                                                                                               |
| `src/app/yield/client.tsx`                           | Interactive page: stats, scatter, leaderboard                                                                                                |
| `src/components/yield-detail-section.tsx`            | Stablecoin detail-page yield section with warnings, source metadata, metric cards, and shared history chart                                 |
| `src/components/yield-leaderboard.tsx`               | Sortable rankings table with `+N` alt-source pill badge                                                                                      |
| `src/components/yield-history-chart.tsx`             | Shared APY history chart with T-bill / peer-median reference lines, optional base-reward split, and warning markers                          |
| `src/components/yield-scatter-plot.tsx`              | Risk-adjusted scatter visualization                                                                                                          |
| `worker/src/cron/__tests__/yield-helpers.test.ts`    | Unit tests for all pure yield functions                                                                                                      |
| `worker/src/cron/__tests__/sync-yield-data.test.ts`  | Integration tests for sync-yield-data orchestration (on-chain, rate-derived, DL, auto-discovery)                                             |
| `worker/src/cron/__tests__/pool-filter.test.ts`      | Tests wrapper-preserving pre-filter behavior for cached/direct DeFiLlama pool ingestion                                                       |
| `worker/src/cron/__tests__/yield-resolve.test.ts`    | Resolve/arbitration tests (price-derived, auto-discovery, DL source selection, warnings)                                                     |
| `worker/src/cron/__tests__/yield-cache.test.ts`      | Cache parsing tests for DL pools and risk-free rate cache                                                                                    |
| `worker/src/lib/__tests__/yield-source-links.test.ts` | Yield source link resolution tests (curated, protocol, metadata fallback)                                                                   |
