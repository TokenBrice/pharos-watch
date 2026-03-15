# Yield Intelligence Feature Audit

**Date:** 2026-03-15
**Scope:** End-to-end audit of the yield pipeline: worker cron, API, frontend, shared logic, metadata, and expansion potential.

---

## Executive Summary

The yield feature is **mature and well-architected**. It processes 43 native yield-bearing stablecoins through a 4-tier APY resolution pipeline, auto-discovers lending opportunities for an additional ~22 coins, and serves 65 total entries in the yield rankings. The codebase has strong degradation handling, confidence-weighted source arbitration, and solid test coverage on pure functions.

**Key numbers (live as of audit date):**

| Metric | Value |
|--------|-------|
| Tracked stablecoins | 157 |
| Yield-bearing (`yieldBearing: true`) | 43 |
| Coins in yield rankings | 65 |
| Auto-discovered lending opportunities | ~22 |
| Coins with NO yield data | ~92 |
| Commodity coins (excluded by design) | 10 |
| Safety-gated exclusions (score < 50) | ~30 |
| Truly unreachable (no DL pool, no lending match) | ~52 |

**Verdict:** The foundation is sturdy. The main expansion lever is widening the DeFiLlama pool coverage, adding on-chain rate configs, expanding the lending protocol allowlist, and introducing new yield source types beyond the current 4-tier model.

---

## 1. Architecture Overview

### Pipeline Flow

```
Cron trigger (every 30 min, Trigger 6)
  |
  +-- loadDlStablecoinPools()        [DeFiLlama Yields API or DEX-sync cache]
  +-- fetchOnChainRates()            [EVM eth_call for 4 vault contracts]
  +-- loadRiskFreeRateSnapshot()     [FRED DGS3MO cached daily]
  +-- computeSafetyScoresSnapshot()  [shared report-card pipeline]
  |
  v
resolveYieldSources()
  |
  +-- Tier 1: On-chain exchange rates (4 coins)
  +-- Tier 2: DeFiLlama pools (30 static + 20 variant + symbol fallback)
  +-- Tier 3: Price-derived APY (2 explicit + navToken coins)
  +-- Tier 4: Rate-derived APY (4 T-bill-proxy coins)
  +-- B.Protocol LUSD special case
  +-- Auto-discovery: lending pools from 28-protocol allowlist
  |
  v
Evaluate, arbitrate, score (PYS), detect warnings
  |
  v
Write yield_data + yield_history, cache yield-rankings JSON
```

### File Inventory (16 files, ~4,200 lines)

| Layer | File | Lines | Role |
|-------|------|-------|------|
| **Worker cron** | `sync-yield-data.ts` | 984 | Main orchestrator |
| | `yield-sync/resolve.ts` | 363 | Per-coin source resolution |
| | `yield-sync/sources.ts` | 311 | External data fetching |
| | `yield-sync/rankings.ts` | 133 | DB row mapping, median |
| | `yield-sync/cache.ts` | 147 | Cache serialization/parsing |
| | `yield-sync/types.ts` | 34 | DlPool, ResolvedYield types |
| | `yield-config.ts` | 501 | All static config maps |
| | `yield-helpers.ts` | 233 | Pure math/scoring functions |
| | `fetch-tbill-rate.ts` | ~60 | Daily T-bill rate cron |
| **Worker API** | `cache-handlers.ts` (partial) | — | `handleYieldRankings` handler |
| | `yield-history.ts` | ~80 | `/api/yield-history` handler |
| **Worker lib** | `yield-source-links.ts` | 81 | Curated source URL registry |
| **Shared** | `yield-rankings.ts` | 38 | Rankings deduplication |
| | `yield-methodology-version.ts` | 187 | Version tracking (v4.2) |
| | `types/yield.ts` | 222 | Zod schemas + TS types |
| **Frontend** | `yield/page.tsx` + `client.tsx` | 340 | Yield page (SSG + client) |
| | `yield-detail-section.tsx` | 369 | Stablecoin detail yield section |
| | `yield-leaderboard.tsx` | 455 | Sortable, paginated table |
| | `yield-history-chart.tsx` | 683 | APY history chart |
| | `yield-scatter-plot.tsx` | ~250 | Safety vs APY scatter |
| | `yield-constants.ts` | ~100 | Frontend yield utilities |
| **Tests** | `yield-helpers.test.ts` | 603 | Pure function tests |
| | `yield-constants.test.ts` | ~60 | Frontend utility tests |

---

## 2. Structural Health Assessment

### Strengths

1. **Well-layered architecture.** The sync pipeline is cleanly split into sources → resolve → evaluate → persist → cache stages. Pure functions are separated from I/O in `yield-helpers.ts`.

2. **Confidence-weighted arbitration (v4.2).** Sources are ranked by trust tier (deterministic > curated > discovered > fallback). Cross-source divergence above 35% triggers rejection of low-confidence sources. This prevents a spurious DL Layer 3 symbol match from overriding an on-chain vault read.

3. **Source-aware history (v4.2).** `yield_history` stores per-source rows with `is_best` markers. 7d/30d metrics are computed from source-specific series, preventing contamination when the best source switches.

4. **Degradation handling is thorough.** The cron returns `status: "degraded"` with specific reasons for: safety coverage < 75%, T-bill rate stale/fallback, DL pools unavailable, schema validation failure. Rankings are still published when safety is degraded (just `report_card_cache` is skipped). Schema-invalid payloads never overwrite the cache.

5. **Test coverage on pure functions is good.** `yield-helpers.test.ts` (603 lines) covers all scoring math, warning signal detection, pool matching, TVL-weighted median, and edge cases (negative APY, near-zero mean, Infinity guards).

6. **Frontend is feature-complete.** Scatter plot with quadrant shading, leaderboard with type-filtering/warning-hiding, inline row expansion with history charts, detail-page section with PYS breakdown popover, alt-source badges, and stale-data banners. All labels and styles are centralized in `classification.ts`.

7. **Circuit breakers and fallback chains.** DL yields has a circuit breaker. DL pool data is cached from the DEX sync (avoiding double-fetch). Risk-free rate has a hardcoded fallback (3.75%). On-chain reads have RPC failover.

### Weaknesses and Risks

1. **No integration tests for the sync pipeline.** Unit tests cover pure functions, but the full `syncYieldData()` flow (D1 writes, cache logic, source arbitration end-to-end) is untested. A mock-D1 integration test would catch regressions in the orchestration layer.

2. **On-chain rate coverage is narrow.** Only 4 coins have Tier 1 on-chain reads (sUSDe, sdUSD, siUSD, sUSDp). Many yield-bearing coins with ERC-4626 vaults (sUSDS, sDAI, scrvUSD, sfrxUSD, sDOLA, yBOLD, sGHO, etc.) still rely on DeFiLlama for their primary APY, even though their variant addresses are configured and ready for on-chain reads.

3. **Layer 3 symbol fallback uses `.includes()`.** In `matchAllDlPools()` line 157, the Layer 3 base-symbol fallback does `p.symbol.toLowerCase().includes(sym)` instead of exact match. This is intentionally looser than Layer 2 (which uses `===`), but it risks false positives (e.g., "USD" matching "USDH", "USDT", "USDC"). The static maps in Layer 1/2 mitigate this for most coins, but it's a footgun for new additions that lack static map entries.

4. **B.Protocol LUSD source is entirely hardcoded.** The `fetchBprotocolLqtyOnlySource()` function has protocol-specific constants (total LQTY reward cap, issuance factor, contract addresses) baked into the source file rather than in `yield-config.ts`. This makes it harder to add similar on-chain reward estimators for other protocols.

5. **Auto-discovery is symbol-match-only for most coins.** The `findBestLendingPool()` uses exact symbol match as primary, with address fallback. But many DeFiLlama pools have wrapped or prefixed symbols (FEUSDH, STEAKEURCV, PMFRXUSD). The 5 entries in `AUTO_LENDING_POOL_MAP` handle known drift, but new symbol drift will silently miss pools.

6. **`yield_history` volume will grow.** At ~65 coins x 48 points/day x 365 days, that's ~1.1M rows/year. With pruning at 365 days it stabilizes, but there's no partition strategy if the table gets slow. The current indexes should handle it, but worth monitoring.

7. **No backfill endpoint.** If a new yield source is added or an existing one changes, there's no way to retroactively populate `yield_history` with correct per-source data. History for new sources starts from zero.

---

## 3. Current Coverage Map

### Tier 1: On-Chain Rate Reads (4 coins)

| Coin | Vault | Chain | Selector |
|------|-------|-------|----------|
| USDe (sUSDe) | `0x9D39...7497` | Ethereum | `convertToAssets` |
| dUSD (sdUSD) | `0x4aCB...F6Fe` | Ethereum | `convertToAssets` |
| iUSD (siUSD) | `0xDBDC...bCB` | Ethereum | `convertToAssets` |
| USDp (sUSDp) | `0x472e...7e7` | Base | `convertToAssets` |

### Tier 2: DeFiLlama Pool Map (30 coins)

Static `YIELD_POOL_MAP` entries: USDe, USYC, USDY, reUSD, TBILL, YUSD, AZND, OUSD, USP, syrupUSDC, syrupUSDT, yoUSD, USDS, GHO, DAI, crvUSD, FRXUSD, DOLA, BOLD, ZCHF, fxUSD, iUSD, USDf, USDU, AID, OUSG, USD.AI, wsrUSD, avUSD, NUSD, msUSD, yzUSD, USN.

### Tier 2: Variant Wrapper Map (23 coins)

`YIELD_VARIANT_MAP` entries covering wrapper tokens: sUSDe, stUSR, loAZND, sUSDS, sGHO, sDAI, scrvUSD, sfrxUSD, sDOLA, yBOLD, sUSDai, sNUSD, sUSDa, siUSD, sUSDf, savUSD, sUSDu, syzUSD, fxSAVE, sUSN, msY, sAID, sdUSD, sUSDp.

### Tier 3: Price-Derived (2 explicit + navTokens)

Explicit IDs: `usdb-blast`, `usda-avalon`. Also activates for any `navToken` coin when DL sources return 0%.

### Tier 4: Rate-Derived (4 coins)

| Token | Spread (bps) | Formula |
|-------|-------------|---------|
| BUIDL | 20 | T-bill - 0.20% |
| YLDS | 50 | T-bill - 0.50% |
| USTB | 15 | T-bill - 0.15% |
| mTBILL | 0 | T-bill rate |

### Auto-Discovery: Lending Protocol Allowlist (28 protocols)

**Tier 1:** aave-v3, compound-v2, compound-v3, dolomite, sparklend, spark-savings, maple, yearn-finance
**Tier 2:** fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, morpho-blue, pendle, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2
**Tier 3:** justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx, benqi-lending

**Filters:** `exposure: "single"`, `stablecoin: true`, project in allowlist, exact symbol match, APY >= 0.5%, TVL >= $1M.

### Deterministic Auto-Discovery Overrides (5 coins)

`AUTO_LENDING_POOL_MAP`: U (Venus BSC), pmUSD (Yearn), USDH (Morpho), EURCV (Morpho), EUSD (Morpho).

---

## 4. Gap Analysis: The Missing 92 Stablecoins

Of the 157 tracked stablecoins, 65 appear in yield rankings. The remaining 92 break down as:

### A. Commodity Coins (10) — Excluded by Design

XAUT, PAXG, KAU, XAUm, CGO, DGLD, PGOLD, GGBR, KAG (silver) + 1 more. Gold/silver pegs are excluded from auto-discovery. This is intentional and correct — lending markets for commodity tokens are scarce and niche.

### B. Safety-Gated (~30 coins) — Score < 50

Coins with safety score below C- (50) are excluded from auto-discovery. This includes many small/new coins. The `AUTO_LENDING_SAFETY_BYPASS_IDS` set currently has 1 exception (U/United Stables).

Examples likely in this bucket: newer/smaller stablecoins without enough track record for a C- or better rating.

### C. No DL Pool Match (~30 coins)

Coins that pass the safety gate but have no matching DeFiLlama pool (symbol mismatch, no pool on allowlisted protocol, pool below $1M TVL or 0.5% APY). Many of these are non-USD stablecoins with thinner lending markets.

### D. Coins Without Lending Markets (~22 coins)

Some stablecoins genuinely have no lending market anywhere — brand new coins, very small market cap, or niche pegs (BRL, JPY, IDR, TRY, etc.) where DeFi lending infrastructure hasn't developed.

---

## 5. Expansion Opportunities

### 5.1 Expand On-Chain Rate Reads (High Impact, Low Effort)

**Current:** 4 coins with Tier 1 on-chain reads.
**Opportunity:** The `YIELD_VARIANT_MAP` already has `variantAddress` and `variantChain` for several more coins. Adding them to `ON_CHAIN_RATE_CONFIGS` is straightforward since they all use the standard ERC-4626 `convertToAssets(uint256)` selector.

**Candidates for immediate Tier 1 expansion:**

| Coin | Wrapper | Chain | Address Available? |
|------|---------|-------|--------------------|
| reUSD | stUSR | Ethereum | Yes (`0x1202...d51`) |
| USDS | sUSDS | Ethereum | Not in variant map yet |
| DAI | sDAI | Ethereum | Not in variant map yet |
| crvUSD | scrvUSD | Ethereum | Not in variant map yet |
| FRXUSD | sfrxUSD | Ethereum | Not in variant map yet |
| DOLA | sDOLA | Ethereum | Not in variant map yet |
| GHO | sGHO | Ethereum | Not in variant map yet |
| BOLD | yBOLD | Ethereum | Not in variant map yet |
| USDf | sUSDf | Ethereum | Not in variant map yet |
| avUSD | savUSD | Ethereum | Not in variant map yet |
| NUSD | sNUSD | Ethereum | Not in variant map yet |
| USD.AI | sUSDai | Ethereum | Not in variant map yet |

**Impact:** Tier 1 on-chain reads are the highest-fidelity yield source. They're immune to DeFiLlama staleness, can't be circuit-broken, and provide exchange rate data for richer history charts.

**Effort:** Per coin: look up the vault contract address on Etherscan, verify it supports `convertToAssets(uint256)` (standard ERC-4626), add one entry to `ON_CHAIN_RATE_CONFIGS`. All use the same selector `0x07a2d13a` and same input amount.

### 5.2 Expand Rate-Derived Configs (Medium Impact, Low Effort)

**Current:** 4 coins (BUIDL, YLDS, USTB, mTBILL).
**Opportunity:** Other T-bill-backed / RWA fund tokens that distribute yield as dividends while maintaining a ~$1.00 NAV.

**Candidates:**

| Token | Issuer | Spread Estimate | Notes |
|-------|--------|----------------|-------|
| OUSG | Ondo Finance | ~50 bps | Ondo US Gov Bond fund, currently price-derived |
| TBILL | OpenEden | ~30 bps | Currently DL pool; rate-derived as backup |
| USYC | Hashnote | ~20 bps | Currently DL pool; rate-derived as backup |

OUSG currently uses price-derived (Tier 3) which yields 3.46%. Adding it as rate-derived would provide a more stable, deterministic baseline.

### 5.3 Expand Lending Protocol Allowlist (Medium Impact, Medium Effort)

**Current:** 28 protocols.
**Missing notable protocols:**

| Protocol | DL Slug | TVL Estimate | Stablecoin Coverage | Notes |
|----------|---------|-------------|--------------------|----|
| Lido (wstETH lending) | lido | $30B+ | Indirect — stablecoin borrowing side | Not directly applicable |
| Radiant Capital | radiant-v2 | ~$50M | USDC, USDT on ARB/BSC | Established, multi-chain |
| Notional Finance | notional-v3 | ~$30M | USDC, DAI | Fixed-rate lending |
| Clearpool | clearpool | ~$100M | USDC | Institutional credit |
| Sturdy Finance | sturdy-v2 | ~$20M | Various | Yield aggregator |
| Tarot | tarot | ~$15M | USDC on FTM/OP | Leveraged lending |
| Fraxlend | fraxlend-v2 | ~$20M | FRAX pairs | Frax ecosystem |
| Goldfinch | goldfinch | ~$80M | USDC | Real-world credit |
| TrueFi | truefi | ~$30M | USDC | Institutional credit |
| Centrifuge | centrifuge | ~$250M | Various | RWA lending |

**Impact:** Each added protocol potentially unlocks lending-opportunity rows for coins that currently have no yield data.

### 5.4 Introduce New Yield Source Types (High Impact, High Effort)

These are entirely new source categories beyond the current 4-tier model:

#### A. Staking/Restaking Yield

Some stablecoins are used as collateral in staking or restaking protocols (e.g., EigenLayer, Symbiotic). These could generate a "staking-yield" source type.

#### B. CEX Lending Rates

Major CEXes (Binance Earn, Coinbase, Bybit) offer stablecoin lending. An API integration could surface these as a `cex-lending` source type. Challenges: API access varies, rates change frequently, custody risk considerations.

#### C. Fixed-Rate Markets

Protocols like Pendle, Notional, and Term Finance offer fixed-rate stablecoin markets. Currently Pendle is in the allowlist but only as lending — its fixed-rate PT (principal token) markets could be a distinct source.

#### D. Liquidity Mining / Points Programs

Many stablecoins offer incentivized yields through points programs. This is ephemeral and hard to quantify, but a `points-estimate` source type could flag coins with active incentive campaigns.

### 5.5 Increase Auto-Discovery Match Rate (Medium Impact, Medium Effort)

**Current gap:** Many coins fail auto-discovery because DeFiLlama uses non-standard symbols for wrapped/vault positions. The `AUTO_LENDING_POOL_MAP` handles 5 known cases, but there are likely more.

**Approach:** Periodic audit of DeFiLlama pool data to identify pools whose `underlyingTokens` match tracked stablecoin contract addresses but whose `symbol` doesn't match. Systematically populate `AUTO_LENDING_POOL_MAP` with these.

**Batch approach:** Build a one-time script that fetches all DL pools, cross-references `underlyingTokens` against all tracked stablecoin contract addresses, and surfaces unmapped matches.

### 5.6 Lower or Tier the Safety Gate (Low Impact, Low Effort)

**Current:** `MIN_SAFETY_SCORE_FOR_YIELD = 50` (C-).
**Opportunity:** Could introduce a two-tier system:
- Coins with score >= 50: full auto-discovery (current behavior)
- Coins with score >= 30: limited discovery, clearly labeled as "higher risk lending" in UI

This would add ~15 more coins to the lending-opportunity tab but requires UI changes to communicate the elevated risk.

### 5.7 Multi-Chain Yield Aggregation (High Impact, High Effort)

Currently, auto-discovery picks the highest-TVL pool per coin, which is typically on one chain. For major stablecoins (USDC, USDT, DAI) deployed across 10+ chains, there could be a "best yield by chain" view showing where to deploy capital for the highest APY.

---

## 6. Code Quality Issues

### Minor Issues

1. **Duplicate `TRACKED_META_BY_ID` construction.** Both `resolve.ts:33` and `sync-yield-data.ts` (via import) use `TRACKED_META_BY_ID`, but `resolve.ts` rebuilds it locally from `TRACKED_STABLECOINS` instead of importing from `@shared/lib/stablecoins`. Harmless but unnecessary.

2. **`matchAllDlPools` Layer 3 uses `.includes()` while Layer 2 uses `===`.** The asymmetry is documented but could surprise future maintainers. A comment explaining _why_ Layer 3 is looser would help.

3. **`YIELD_POOL_MAP` gate comment says "21/24" but the map now has 30+ entries.** The threshold comment at line 181 of `yield-config.ts` is stale.

4. **Magic number in history loading.** `LEGACY_MAX_AGE_SEC = 35 * 86400` (line 311 of `sync-yield-data.ts`) embeds a "30d window + 5d buffer" without a named constant.

### Potential Improvements (Not Bugs)

1. **Extract B.Protocol LUSD into a generic "reward estimator" pattern.** The current hardcoded approach works but doesn't scale. If other protocols need similar on-chain reward estimation (e.g., Liquity v2 for BOLD, Frax veFXS rewards), a config-driven estimator registry would be cleaner.

2. **Add a `yield_data` freshness index.** The orphan cleanup scans `SELECT DISTINCT stablecoin_id FROM yield_data` on every run. An index on `updated_at` would speed up stale-row detection for larger datasets.

3. **Consider source-key stability.** DeFiLlama pool UUIDs are stable, but `"price-derived"` and `"rate-derived"` as source keys mean all price-derived coins share a single key namespace. If two sources of the same type ever collide (unlikely today), the PK would conflict.

---

## 7. Test Coverage Assessment

### Well-Covered

- `computeApyFromRate` / `computeApyFromPrice` — 5 test cases including edge cases
- `computePYS` — 4 cases covering zero APY, scaling, safety penalty, cap
- `computeYieldStability` / `computeApyVarianceScore` — 10 cases including near-zero mean, Infinity guards
- `detectWarningSignals` — 15 cases covering all 6 signal types, boundary conditions, simultaneous signals
- `matchAllDlPools` — 7 cases covering all 3 layers, dedup, cross-contamination prevention
- `findBestLendingPool` — 6 cases covering allowlist, symbol match, address fallback, quality gates
- `computeTvlWeightedMedianApy` — 6 cases covering edge cases
- `parseWarningSignals` — 4 cases covering malformed JSON

### Missing Test Coverage

- **`syncYieldData()` orchestrator** — No integration tests. The function is ~600 lines of orchestration logic including D1 writes, source arbitration, cache serialization, and cleanup. This is the highest-risk untested code.
- **`resolveYieldSources()`** — No unit tests. The 4-tier resolution cascade, LUSD B.Protocol special case, and auto-discovery logic are only implicitly tested via prod observation.
- **`loadDlStablecoinPools()` cache parsing** — The cache module has no tests for `parseDlStablecoinPoolsCache` or `parseRiskFreeRateCache`.
- **`resolveYieldSourceUrl()`** — The link resolution fallback chain is untested.
- **Frontend `computePysBreakdown()`** — The mirror PYS computation in `yield-constants.ts` has some tests but doesn't verify parity with the worker's `computePYS()`.

---

## 8. Recommendations Summary

### Priority 1 — Quick Wins (1-2 days each)

| # | Action | Impact |
|---|--------|--------|
| 1a | Add Tier 1 on-chain rate configs for 8+ more ERC-4626 vaults (sUSDS, sDAI, scrvUSD, etc.) | Higher fidelity APY for major coins |
| 1b | Run DL pool → contract address cross-reference to find missed `AUTO_LENDING_POOL_MAP` entries | +5-10 more auto-discovered coins |
| 1c | Add rate-derived config for OUSG (currently price-derived) | More stable OUSG yield data |
| 1d | Fix stale `YIELD_POOL_MAP` gate comment (21/24 → actual count) | Code hygiene |

### Priority 2 — Medium Effort (3-5 days each)

| # | Action | Impact |
|---|--------|--------|
| 2a | Add 5-10 more protocols to lending allowlist (Radiant, Clearpool, Fraxlend, Centrifuge, etc.) | +10-15 more lending opportunities |
| 2b | Build integration tests for `syncYieldData()` with mock D1 | Prevent orchestration regressions |
| 2c | Build a DL pool→Pharos coin matching audit script that runs periodically | Automated coverage gap detection |
| 2d | Extract B.Protocol LUSD into a generic reward estimator config | Scalability for future on-chain estimators |

### Priority 3 — Strategic (1-2 weeks each)

| # | Action | Impact |
|---|--------|--------|
| 3a | Introduce "staking yield" source type for restaking protocols | New yield category |
| 3b | Multi-chain yield view (best APY by chain for major coins) | New analytical dimension |
| 3c | CEX lending rate integration | Broadest yield comparison possible |
| 3d | Two-tier safety gate (50 for standard, 30 for labeled high-risk) | +15 more coins |

---

## 9. Data Source Dependency Map

| Source | Provider | Fetch Frequency | Circuit Breaker | Fallback |
|--------|----------|----------------|-----------------|----------|
| Stablecoin pools | DeFiLlama Yields | Cached from DEX sync (2h) | Yes | Direct fetch, then unavailable |
| Vault exchange rates | EVM RPCs (Alchemy/Infura) | Every 30 min | No (per-call retry) | Skip coin for this run |
| T-bill rate | FRED DGS3MO | Daily | Yes | Last known good, then 3.75% hardcoded |
| LQTY price | CoinGecko | Every 30 min (LUSD only) | No | Skip B.Protocol source |
| Safety scores | Internal (report-card) | Computed each run | N/A | Degraded mode (skip cache write) |
| Price history | Internal (supply_history D1) | Price-derived only | N/A | Skip coin |

---

## 10. Frontend Feature Completeness

The frontend is mature and feature-complete for the current data model:

- **Yield page** (`/yield`): Summary stats, scatter plot (safety vs APY with quadrants), leaderboard with 2 tabs (native yield / lending opportunities), type pills, warning filters, inline expansion with history charts.
- **Detail page** (`/stablecoin/[id]/`): `YieldDetailSection` with 5 metric cards (current APY, 30d APY, PYS with breakdown popover, stability, excess yield), source info, alt sources, warnings, embedded history chart.
- **History chart**: 4 time presets (7d/30d/90d/1y), base/reward breakdown toggle, T-bill + peer median reference lines, warning markers, compact mode for inline leaderboard expansion.

**No missing UI features identified.** The frontend gracefully handles:
- Missing yield data (returns null)
- Yield-bearing coins with no rankings yet (inline empty state)
- Stale data (banner with age calculation)
- Single vs multiple warnings (different visual treatments)
- Source switches (indicator in source info)

---

*End of audit.*
