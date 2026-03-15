# End-to-End Data Flow Map

## Overview

This map links each major Pharos data domain from upstream source to frontend consumption:

`external source -> worker cron / sync -> D1 table or cache key -> API endpoint -> frontend hook -> page(s)`

## Core Flows

| Domain | External Sources | Worker Ingest / Compute | Storage Layer | API Surface | Frontend Hook(s) | Primary UI |
|-------|------------------|--------------------------|---------------|-------------|------------------|------------|
| Stablecoin core list + prices | DefiLlama, CoinGecko, CMC, DexScreener, Pyth Network, Binance, Coinbase, RedStone, Curve on-chain, protocol redemption quotes, FX sources (Frankfurter, Open Exchange Rates, `fawazahmed0/exchange-api`) | `worker/src/cron/sync-fx-rates.ts`, `worker/src/cron/sync-stablecoins.ts` (+ `worker/src/cron/enrich-prices.ts`, `worker/src/lib/authoritative-price-sources.ts`, `worker/src/lib/price-consensus.ts`, `worker/src/lib/price-validation.ts`) | `cache` keys: `fx-rates`, `stablecoins` | `GET /api/stablecoins` | `useStablecoins` | Homepage, Compare, Dependency Map, many cards |
| Stablecoin detail summaries + market-cap charts | DefiLlama detail/chart, CoinGecko fallback | `worker/src/cron/sync-stablecoin-charts.ts` + on-demand detail handler | `cache` key: `stablecoin-charts` + handler-computed detail payload | `GET /api/stablecoin/:id`, `GET /api/stablecoin-charts` | `usePrefetchStablecoin`, `useStablecoinCharts` | Stablecoin detail shell, homepage charts |
| Per-coin supply history | Cached stablecoins payload snapshot, CoinGecko or DefiLlama backfills | `worker/src/cron/snapshot-supply.ts`, `worker/src/api/backfill-supply-history.ts` | `supply_history` | `GET /api/supply-history` | `useSupplyHistory`, `useCompareDataModel` | Stablecoin detail page, Compare |
| Depeg events + peg summary | Stablecoin cache prices + DEX corroboration | `worker/src/cron/detect-depegs.ts` (+ pending confirmation) | `depeg_events`, `depeg_pending` | `GET /api/depeg-events`, `GET /api/peg-summary` | `useDepegEvents`, `useInfiniteDepegEvents`, `usePegSummary` | Depeg page, homepage peg columns, detail cards |
| DEX liquidity + DEX implied prices | DefiLlama Yields, DefiLlama Protocols, Curve, Uniswap/Aerodrome subgraphs, plus `CG/GT/DexScreener/CG Tickers -> [discovery cron] -> dex_pool_staging (D1)` | `worker/src/cron/dex-discovery/orchestrator.ts` (`t1/t2/t3` tiered priority + exponential backoff, staleness sorting + live FX/metal validation refs) and `worker/src/cron/dex-liquidity/*` orchestrator merge (`max(0.5, 1 - ageHours / 48)` confidence decay + live FX/metal validation refs) | `dex_pool_staging` -> `dex_liquidity`, `dex_liquidity_history`, `dex_prices` | `GET /api/dex-liquidity`, `GET /api/dex-liquidity-history` | `useDexLiquidity`, `useDexLiquidityHistory` | Liquidity page, Compare, report-card inputs, `/status` liquidity health card |
| Blacklist / freeze tracker | Etherscan v2, TronGrid, RPC providers | `worker/src/cron/sync-blacklist.ts` | `blacklist_events`, `blacklist_sync_state` | `GET /api/blacklist` | `useBlacklistEvents` | Blacklist page |
| Mint/Burn flow tracker | Alchemy logs (Ethereum) | `worker/src/cron/sync-mint-burn.ts` | `mint_burn_events`, `mint_burn_hourly`, `mint_burn_sync_state` | `GET /api/mint-burn-flows`, `GET /api/mint-burn-events` | `useMintBurnFlows`, `useMintBurnFlowsCoin`, `useMintBurnEvents` | Flows page, homepage flow snapshot, coin overlays |
| Live reserve composition | Protocol reserve APIs, dashboards, and on-chain/accounting reads via adapter-specific fetches | `worker/src/cron/sync-live-reserves.ts` | `reserve_composition`, `reserve_sync_state` | `GET /api/stablecoin-reserves/:id` | `useStablecoinReserves` | Stablecoin detail reserve card, `/status` reserve-sync health card |
| Redemption backstops + effective exit | Stablecoin cache, DEX liquidity snapshot, live reserve-sync metadata, and redeemability config registry | `worker/src/cron/sync-redemption-backstops.ts` | `redemption_backstop`, `redemption_backstop_history` | `GET /api/redemption-backstops`, `GET /api/report-cards` | `useRedemptionBackstops`, `useReportCards` | Stablecoin detail redemption card, report-card liquidity inputs |
| Stability Index (PSI) | Stablecoin cache + active depeg state + DEWS stress breadth | `worker/src/cron/stability-index.ts`, daily `worker/src/cron/snapshot-psi.ts` | `stability_index_samples`, `stability_index` | `GET /api/stability-index` | `useStabilityIndex`, `useStabilityIndexDetail` | Stability Index pages, digest snapshot |
| DEWS stress signals | Stablecoins + liquidity + blacklist + mint/burn + yield + PSI inputs | `worker/src/cron/compute-dews.ts` | `stress_signals`, `stress_signal_history` | `GET /api/stress-signals` | `useStressSignals`, `useStressSignalDetail` | Depeg tracker risk panels, homepage radar snapshot |
| Yield intelligence | On-chain rate calls, DefiLlama pools, CoinGecko price fallback, risk-free rate cache | `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/{sources,resolve,rankings,cache}.ts`, `worker/src/cron/fetch-tbill-rate.ts` | `yield_data`, source-aware `yield_history`, cache `yield-rankings`, structured cache `risk_free_rate` | `GET /api/yield-rankings`, `GET /api/yield-history` | `useYieldRankings`, `useYieldHistory` | Yield page, stablecoin detail |
| Daily digest | Anthropic Claude + PSI snapshot context | `worker/src/cron/daily-digest.ts` | `daily_digest` + static build sync to `data/digests.json` | `GET /api/daily-digest`, `GET /api/digest-archive`, `GET /api/digest-snapshot` | `useDailyDigest`, `useDigestArchive`, `useDigestSnapshot` | Digest page + archive |
| Report cards + dependency graph | Peg summary + DEX liquidity + redemption backstops + bluechip + stablecoin metadata/dependencies | `worker/src/api/report-cards.ts` compute on read | cache-driven upstream + in-memory compute | `GET /api/report-cards` | `useReportCards` | Safety Scores, Portfolio, Dependency Map, homepage safety snapshot |
| Status reliability | Real-HTTP self probes + status synthesis | `worker/src/cron/status-self-check.ts`, `worker/src/api/status.ts` | `status_state`, `status_transitions`, `status_probe_runs`, `status_discrepancy_state` | `GET /api/status`, `GET /api/status-history` | `useStatus`, `useEndpointProbes`, `useHealth` | `/status` admin dashboard |
| Coverage discovery | CoinGecko category API, DL stablecoins residuals | `worker/src/cron/discovery-scan.ts`, `worker/src/cron/sync-stablecoins.ts` (Source A) | `discovery_candidates` | `GET /api/discovery-candidates`, `POST /api/discovery-candidates/:id/dismiss` | — (admin only) | `/status` admin page |

## Scheduling Backbone

Cron schedules are declared in `worker/wrangler.toml` and orchestrated by `worker/src/handlers/scheduled.ts`:

- `*/15 * * * *`: sync-stablecoins (including depeg detection + pending confirmation), then downstream-safe snapshot-supply retry / FX / PSI / DEWS / status self-check
- `3,23,43 * * * *`: blacklist sync
- `4,24,44 * * * *`: mint/burn critical lane
- `6,36 * * * *`: DEX discovery staging (every 30 minutes)
- `13,33,53 * * * *`: mint/burn extended lane
- `10,40 * * * *`: stablecoin charts, then DEX liquidity, then yield sync
- `11 * * * *`: live reserve sync, then redemption backstop sync
- `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`: Telegram subscriber alerts + cemetery announcements
- `0 8 * * *`: supply snapshot, safety-grade snapshot, T-bill rate, PSI daily snapshot, USDS status
- `5 8 * * *`: bluechip sync, daily digest, discovery scan

## Freshness Contract (Frontend)

All API hooks that use `useApiQuery` follow:

- `staleTime = cron interval`
- `refetchInterval = 2 * cron interval`

Defined centrally in `src/hooks/use-api-query.ts`.

## Notes

- Cache passthrough endpoints include freshness metadata via `_meta` and/or `X-Data-Age`.
- `/api/dex-liquidity` is meta-aware on the frontend: the page uses worker freshness metadata (and degraded-run `Warning` headers) rather than client fetch time to assess staleness.
- Liquidity history now carries `coverageClass` / `coverageConfidence`; trend and durability consumers should treat low-confidence snapshots as informational, not authoritative baselines.
- Admin/backfill endpoints bypass edge cache via `cacheBypass` flags in `shared/lib/api-endpoints.ts`.
- The stablecoins cache loader distinguishes `ok`, `degraded`, and `error` states. Operator-facing or published consumers (`/status`, daily digest, safety snapshot) now fail closed on non-`ok` cache reads instead of treating broken cache state as an empty valid dataset.
- `consensusSources` flows from the price-consensus cron stage through the `stablecoins` cache → `/api/stablecoins` and `/api/peg-summary` → `useStablecoins` / `usePegSummary` hooks → `PriceTransparencyCard` on the detail page and `CoverageBadge` source-count enrichment on the coverage page.
