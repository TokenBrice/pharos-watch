# /liquidity Frontend & API Audit (2026-04-16)

Audit scope: `/liquidity` overview page + per-stablecoin DEX liquidity card + supporting hooks, types, and worker API handlers. Live API + dev server were checked. The Chrome MCP bridge was unavailable, so live UI rendering was verified via SSR HTML, the live API payload, the unit-test suite, and worker type-check rather than an in-browser render.

## Summary

Verdict: **Solid foundation, no critical breakage**, but the `/liquidity` route under-uses the rich backend telemetry the API now ships, and several backend fields are dead weight on the wire.

- Page wiring (hook -> stats -> table -> detail card) is correct. NR / unobserved coins are routed to a dedicated section instead of being dropped, the `__global__` sentinel is correctly used for protocol/chain/TVL aggregates, the protocol legend cap is enforced, the methodology version surfaces via the page shell, and the unobserved history state is rendered cleanly on the detail card.
- The hook follows the documented `staleTime = cron interval / refetchInterval = 2x cron interval` rule.
- The `Warning` header path is wired end-to-end and surfaces a banner on degraded runs.
- Two correctness gaps and several payload-size / data-quality issues are described below.

Live verification was limited to non-browser checks (see `Live Verification Results`).

## Critical Findings

None. No undefined-at-runtime bugs were found; the schema and the live payload top-level shape agree.

## Major Findings

### M1: Backend writes `coverageClass = "unobserved"` on the `__global__` row even though it carries the real ~$7.3B aggregate TVL

Live `__global__` row:

```
totalTvlUsd: 7368648235
poolCount:   6179
coverageClass: "unobserved"
liquidityEvidenceClass: "observed_unmeasured"
```

`worker/src/api/dex-liquidity.ts:87` falls through to `row.coverage_class ?? "legacy"` and emits whatever the cron stored. The classification helper at `worker/src/api/dex-liquidity-response.ts:175` then derives `liquidityEvidenceClass` from `(totalTvl, balanceMeasured)` directly, so it correctly returns `observed_unmeasured` on the same row.

Why it doesn't crash today: the `/liquidity` page filters table rows by `ACTIVE_STABLECOINS`, which excludes `__global__`, so the misleading `unobserved` badge is never rendered. But:

- Any future consumer that surfaces the `__global__` row will paint it as NR.
- The pair (`unobserved`, TVL > 0) is internally inconsistent and should be reconciled either at the cron (use a sentinel like `n/a`) or at the API edge (override to `null`/omit `coverageClass` for the global row).

This is in the worker write path, not in /liquidity rendering, but it's worth fixing before the next consumer touches it.

### M2: API ships per-pool `poolId` and `volumeUsd7d` plus per-pool `extra.qualityAdjustedTvl` / `extra.hasMeasuredOrganicFraction` that the frontend Zod schema strips and never reads

Live payload (sample USDC pool):

```
{
  "poolId": "base:10137e20-...",
  "project": "aerodrome",
  ...
  "volumeUsd7d": 1254829239.17,
  "extra": {
    "qualityAdjustedTvl": 7947104,
    "hasMeasuredOrganicFraction": true,
    ...
  }
}
```

Frontend `DexLiquidityPoolSchema` (`shared/types/market.ts:181-225`) defines neither `poolId`, nor `volumeUsd7d`, nor `extra.qualityAdjustedTvl`, nor `extra.hasMeasuredOrganicFraction`. Zod's default object mode strips unknown keys, so they're dropped on parse. A Grep for `poolId` / `volumeUsd7d` in `src/` returns no results.

Across 181 stablecoins x ~5 pools each (946 retained pools; max 10 per coin), every pool ships `qualityAdjustedTvl`. ~42% also ship `hasMeasuredOrganicFraction`. Conservative estimate: 60-90 KB of dead payload on a ~893 KB response (~7-10%). This is hot data: it's served at the public site-data edge, refetched every 60 minutes by every visitor.

Recommended fix: drop these from `top_pools_json` at the worker write side (preferred — saves both DB column size and bandwidth) or stop emitting them in the API mapper.

### M3: `priceSources` for major stables contains contaminated cross-asset entries

Live `usdc-circle.priceSources` includes Fantom rows priced ~0.044 USD:

```
{ "protocol": "spookyswap",  "chain": "Fantom", "price": 0.0443, "tvl": 154164 }
{ "protocol": "spiritswap",  "chain": "Fantom", "price": 0.0443, "tvl": 33063  }
{ "protocol": "tomb_swap_fantom", "chain": "Fantom", "price": 0.0443, "tvl": 4691 }
... 9 more Fantom entries between $1k and $155k TVL
```

Twelve Fantom-chain rows with `price ~0.044` are listed under USDC's `priceSources`. The aggregated `dexPriceUsd` is unaffected (it's a TVL-weighted median of a much larger set), but the `dex-liquidity-card.tsx` "show all" expansion will display these protocols to the end user as "USDC price sources", which is misleading. This points at a backend retention filter that lets a non-USDC quote escape into the price-source aggregate, presumably because of a USDC.e vs USDC alias collapse on Fantom.

This is a backend correctness issue (out of scope for the frontend audit), but the user-visible symptom is on the detail card "show all sources" UI, so flagging it here.

## Minor Findings

### m1: Several DB-backed row fields are emitted but never read by the frontend

| Field                  | Site of read in `src/`  | Notes                                                                                              |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `avgPoolStress`        | only test fixtures      | Per-stablecoin TVL-weighted stress; no UI surface (only per-pool `stressIndex` is shown via dot)   |
| `lockedLiquidityPct`   | none                    | Persisted but explicitly noted in docs as not in durability score; nothing renders it              |
| `methodologyVersion`   | none                    | Frontend already uses the global `LIQUIDITY_METHODOLOGY_VERSION_LABEL`; per-row version is unused  |
| `coverageConfidence`   | only test fixtures      | The badge label uses `coverageClass` only; the 0-1 confidence number isn't shown anywhere          |
| `pairCount`            | none                    | Schema includes it; only `poolCount` and `chainCount` are rendered                                 |

These are all legitimate data points — the recommendation is either (a) display them where they add value (e.g. `coverageConfidence` could be a tooltip on the badge; `avgPoolStress` could be a column / chip; `methodologyVersion` could be shown on hover for backfilled rows) or (b) stop sending them. Today they pay bytes for nothing on the public payload.

### m2: `crossChain` is an optional in `scoreComponents` schema but is never present in the payload and never rendered

`shared/types/market.ts:284` declares `crossChain: z.number().optional()` on the score components object; live data has only the five components defined in `LIQUIDITY_SCORE_WEIGHTS`. The `ScoreBreakdown` component iterates `LIQUIDITY_SCORE_WEIGHTS`, which has no `crossChain` entry, so the optional is dead. Recommend deleting from the schema.

### m3: `direct_api` has no entry in the source-mix label map

`src/lib/liquidity-coverage.ts:27-33` defines:

```
const SOURCE_LABELS = {
  dl: "DeFiLlama",
  cg_onchain: "CG Onchain",
  gecko_terminal: "GeckoTerminal",
  dexscreener: "DexScreener",
  cg_tickers: "CG Tickers",
};
```

But the API now emits `direct_api` as a first-class source family (Fluid / Balancer / Raydium / Orca / Meteora / PancakeSwap / Slipstream). When a row's `sourceMix` carries `direct_api`, the badge tooltip will render the raw string `direct_api` instead of a friendly label. One-line fix.

### m4: `coverageClass = "legacy"` is in the badge map but the live payload no longer contains any legacy rows; docs only document Primary/Mixed/Fallback/NR

`src/lib/liquidity-coverage.ts` has a `legacy` badge (`Legacy`, slate). `dex-liquidity.md` only describes `primary | mixed | fallback | unobserved` for end users. This is a defensive backfill case — fine to keep, but worth verifying that any persisted `legacy` rows have either been backfilled to the proper class or that the docs intentionally hide it from the published palette.

### m5: `LiquidityCoverageClass` includes `unobserved` but the table never displays a coverage badge for unobserved rows in any meaningful way

The unrated table renders `getLiquidityCoverageBadge("unobserved")` -> `NR` badge for every row. Because the entire section header already says "Unrated / Not Observed", the per-row badge is redundant filler. Not a bug, just visual noise.

### m6: Top-pool table key collision risk on the detail card

`src/components/dex-liquidity-card.tsx:213` keys top pool rows by `${pool.chain}-${pool.symbol}-${pool.project}`. Two pools on the same chain in the same project with the same token symbols (e.g. parallel UniV3 0.01% and 0.05% pools, or a fee-tier-split Curve pool) would collide. The API now sends `poolId` (chain:address) for exactly this purpose — see M2. If `poolId` were kept in the schema, this row could safely key on it.

### m7: `useDexLiquidityHistory` polls at `CRON_1H`

Snapshots are written once per UTC day. `CRON_1H` is fine for staleness handling but the documented rule (`staleTime = cron interval`) doesn't strictly map to history endpoints. Not a defect — flagging because future maintainers may misread the rule.

### m8: Hook timing rule on `/liquidity`

`useDexLiquidity` uses `CRON_30MIN` (30 min). With `usePollingQuery`, that means `staleTime = 30 min`, `refetchInterval = 60 min`. Matches CLAUDE.md exactly.

## Data Shape Diff (API <-> Frontend)

Top-level row fields:

| Field                          | In API | In hook type / Zod | Read by UI                                  | Notes                                                                                |
| ------------------------------ | ------ | ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| totalTvlUsd                    | yes    | yes                | stats, table, card                          | Used for trend math and display                                                      |
| totalVolume24hUsd              | yes    | yes                | stats, table, card                          |                                                                                      |
| totalVolume7dUsd               | yes    | yes                | table, card                                 |                                                                                      |
| poolCount / pairCount / chainCount | yes | yes (all three)    | poolCount + chainCount                      | `pairCount` is unused                                                                |
| protocolTvl / chainTvl         | yes    | yes                | stats breakdown bars + card breakdown       |                                                                                      |
| topPools                       | yes    | yes                | detail card top-pool table                  | Pool-level dead fields below                                                         |
| liquidityScore                 | yes    | yes                | table + card + stats                        |                                                                                      |
| concentrationHhi               | yes    | yes                | detail card only                            | Not on `/liquidity` overview                                                         |
| depthStability                 | yes    | yes                | detail card only                            |                                                                                      |
| tvlChange24h / tvlChange7d     | yes    | yes                | table 7d trend col + card                   |                                                                                      |
| updatedAt                      | yes    | yes                | implicit via meta                           |                                                                                      |
| dexPriceUsd / dexDeviationBps  | yes    | yes                | detail card                                 |                                                                                      |
| priceSourceCount / priceSourceTvl | yes | yes                | detail card                                 |                                                                                      |
| priceSources                   | yes    | yes (nullable)     | detail card "show all"                      | M3 contamination                                                                     |
| effectiveTvlUsd                | yes    | yes                | detail card "Effective" line                |                                                                                      |
| avgPoolStress                  | yes    | yes                | none                                        | m1 dead                                                                              |
| weightedBalanceRatio           | yes    | yes                | table + card + stats avg                    |                                                                                      |
| organicFraction                | yes    | yes                | table + card + stats avg                    |                                                                                      |
| durabilityScore                | yes    | yes                | table + card                                |                                                                                      |
| coverageClass                  | yes    | yes                | badges everywhere                           | M1 inconsistency on `__global__`                                                     |
| coverageConfidence             | yes    | yes                | none                                        | m1 dead                                                                              |
| liquidityEvidenceClass         | yes    | yes                | detail card label + history empty state     |                                                                                      |
| hasMeasuredLiquidityEvidence   | yes    | yes                | detail card label                           |                                                                                      |
| trendworthy                    | yes    | yes                | history empty state check                   |                                                                                      |
| sourceMix                      | yes    | yes                | badge tooltip                               | m3 missing `direct_api` label                                                        |
| balanceMeasuredTvlUsd          | yes    | yes                | `/liquidity` weighted-avg math              |                                                                                      |
| organicMeasuredTvlUsd          | yes    | yes                | `/liquidity` weighted-avg math              |                                                                                      |
| scoreComponents                | yes    | yes                | detail card score breakdown                 | m2 dead `crossChain` optional                                                        |
| lockedLiquidityPct             | yes    | yes                | none                                        | m1 dead                                                                              |
| methodologyVersion             | yes    | yes                | none                                        | m1 dead                                                                              |

Pool-level fields inside `topPools[]`:

| Field                                | In API | In Zod schema | Read by UI         | Notes                                                                                |
| ------------------------------------ | ------ | ------------- | ------------------ | ------------------------------------------------------------------------------------ |
| poolId                               | yes    | NO            | none               | M2 dead                                                                              |
| project, chain, symbol, poolType     | yes    | yes           | top pools table    |                                                                                      |
| tvlUsd, volumeUsd1d, price           | yes    | yes           | top pools table    |                                                                                      |
| volumeUsd7d                          | yes    | NO            | none               | M2 dead                                                                              |
| source                               | yes    | yes           | -                  | Normalized to source family                                                          |
| extra.amplificationCoefficient       | yes    | yes           | top pools table    |                                                                                      |
| extra.balanceRatio                   | yes    | yes           | top pools BalanceBar |                                                                                    |
| extra.feeTier                        | yes    | yes           | top pools detail col |                                                                                    |
| extra.organicFraction                | yes    | yes           | OrganicBadge       |                                                                                      |
| extra.pairQuality                    | yes    | yes           | none               | Persisted but unused                                                                 |
| extra.stressIndex                    | yes    | yes           | StressDot          |                                                                                      |
| extra.maturityDays                   | yes    | yes           | OrganicBadge mature flag |                                                                                |
| extra.balanceDetails                 | yes    | yes           | balance tooltip    |                                                                                      |
| extra.measurement.*                  | yes    | yes           | none               | All five booleans persisted, none currently rendered                                 |
| extra.qualityAdjustedTvl             | yes    | NO            | none               | M2 dead                                                                              |
| extra.hasMeasuredOrganicFraction     | yes    | NO            | none               | M2 dead                                                                              |
| extra.effectiveTvl                   | yes    | yes           | none               | Per-pool effective TVL — collected by schema, not displayed                          |
| extra.isMetaPool                     | yes    | yes           | top pools detail col |                                                                                    |
| extra.registryId                     | yes    | yes           | none               | Curve registry id, parsed but not displayed                                          |

`/api/dex-liquidity-history`:

| Field                          | In API | In hook type | Read by UI                                                       |
| ------------------------------ | ------ | ------------ | ----------------------------------------------------------------- |
| tvl                            | yes    | yes          | TvlTrendChart Y axis                                              |
| volume24h                      | yes    | yes          | none                                                              |
| score                          | yes    | yes          | none                                                              |
| date                           | yes    | yes          | TvlTrendChart X axis                                              |
| coverageClass                  | yes    | yes          | TvlTrendChart "unobserved" empty-state guard                      |
| coverageConfidence             | yes    | yes          | none                                                              |
| liquidityEvidenceClass         | yes    | yes          | TvlTrendChart empty-state guard                                   |
| hasMeasuredLiquidityEvidence   | yes    | yes          | none                                                              |
| trendworthy                    | yes    | yes          | TvlTrendChart empty-state guard                                   |
| methodologyVersion             | yes    | yes          | none                                                              |

The classification logic in `worker/src/api/dex-liquidity-history.ts:15-51` correctly applies `liquidityEvidenceClass` / `hasMeasuredLiquidityEvidence` / `trendworthy`, so the doc requirement is met.

## Live Verification Results

- **Page loaded successfully**: SSR HTML renders with the expected shell (`DEX Liquidity` title, breadcrumbs, methodology badge). Hydrated rendering was NOT verified because the Chrome MCP bridge returned `No Chrome extension connected.`
- **Console errors**: not checked (no browser bridge)
- **Network 4xx/5xx**: not checked (no browser bridge). Direct dev-server fetch for `/liquidity/` returned 200 and the expected HTML.
- **Sort/filter**: not checked at runtime. Static review of `compareLiquidityRows` (`src/components/liquidity-table-logic.ts`) shows all eleven sort keys (`score, tvl, tvlTrend, volume, volume7d, vtRatio, pools, chains, balance, organic, durability`) are wired to non-null fallbacks (`?? 0`), so no NaN sort traps.
- **Mobile**: not checked at runtime. Static review shows responsive class chains (`hidden sm:table-cell`, `hidden md:table-cell`, etc.) on every secondary column; mobile collapses to rank/name/score/TVL/24h-vol.
- **Screenshots**: none. Browser bridge unavailable.
- **Tests**: `npm test -- liquidity` -> 31 files / 234 tests passed in 3.24s.
- **Worker typecheck**: `cd worker && npx tsc --noEmit` -> clean.
- **Live API shape**: 181 stablecoin keys (180 coins + `__global__`); coverage distribution `primary=31, mixed=91, fallback=36, unobserved=23`. All top-level row keys match the Zod schema. Pool-level extras include four undocumented fields not in the schema (M2).
- **Warning header**: not exercised (latest run is healthy). The `buildDexLiquidityWarning` worker helper, the meta-aware client header parser, and the page banner render path are wired together correctly.
- **Live API auth**: `https://api.pharos.watch/api/dex-liquidity` returned 401 to direct curl regardless of `Origin` / `Accept` markers — the public payload is served from `https://pharos.watch/_site-data/dex-liquidity` (CF Pages site-data proxy). That's how the browser hook reaches it via `buildRequestUrl` -> `shouldUseSiteDataProxy` -> `toSiteDataPath`. Working as documented.

## Recommendations

Listed in suggested order of value vs effort.

1. **(M2)** Stop emitting `poolId`, `volumeUsd7d`, `extra.qualityAdjustedTvl`, and `extra.hasMeasuredOrganicFraction` from `worker/src/api/dex-liquidity.ts` (or, better, from the cron writer that builds `top_pools_json`). Estimated savings: 60-90 KB on a 893 KB hot endpoint, ~7-10%. Optionally, instead, add `poolId` to the Zod schema and re-key the detail card top-pool rows by it (m6).
2. **(M1)** Reconcile `coverageClass` for the `__global__` row. Either (a) override to `null` or omit the field at the API edge, or (b) write a sentinel value at the cron and teach the badge map about it. Today only `liquidityEvidenceClass` is consistent on this row.
3. **(M3)** Investigate the Fantom non-USD rows showing up in `usdc-circle.priceSources`. Most likely a USDC.e -> USDC alias collapse that survives the retained-pool price filter. Tracker should be in the cron's `dex_prices` build path, not in the API.
4. **(m1)** Decide whether `avgPoolStress`, `lockedLiquidityPct`, `methodologyVersion`, `coverageConfidence`, `pairCount` should (a) appear in the UI or (b) be removed from the API mapper. The current state is the worst of both worlds.
5. **(m3)** Add `direct_api: "Direct API"` (or per-protocol breakdown) to `SOURCE_LABELS` in `src/lib/liquidity-coverage.ts`.
6. **(m2)** Delete the dead `crossChain` optional from `DexLiquidityDataSchema.scoreComponents`.
7. **(m6)** If `poolId` is kept (option in #1), re-key top-pool rows to remove the project+symbol+chain collision risk.
8. Consider exposing `concentrationHhi` and `depthStability` as a sortable column on `/liquidity` (or as small chips on the row), since these are persisted and meaningful but only appear on the detail card today.
9. Live UI verification (sort/filter, mobile, console, network) was not possible in this session because the Chrome MCP bridge was disconnected. A follow-up audit pass should cover that explicitly.

## Files Inspected

- `/home/ahirice/Documents/git/stablecoin-dashboard/docs/dex-liquidity.md`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/app/liquidity/page.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/app/liquidity/client.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/app/liquidity/error.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/liquidity-table.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/liquidity-table-logic.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/liquidity-stats.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/dex-liquidity-card.tsx`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/components/dex-liquidity-card-model.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/api-hooks.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-api-query.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/liquidity-coverage.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/cron-intervals.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/market.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/liquidity-score-weights.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity-history.ts`
- `/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity-response.ts`
