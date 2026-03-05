# End-to-End Data Flow Map

## Overview

This map links each major Pharos data domain from upstream source to frontend consumption:

`external source -> worker cron / sync -> D1 table or cache key -> API endpoint -> frontend hook -> page(s)`

## Core Flows

| Domain | External Sources | Worker Ingest / Compute | Storage Layer | API Surface | Frontend Hook(s) | Primary UI |
|-------|------------------|--------------------------|---------------|-------------|------------------|------------|
| Stablecoin core list + prices | DefiLlama, CoinGecko, CMC, DexScreener, FX sources | `worker/src/cron/sync-stablecoins.ts` (+ `worker/src/cron/enrich-prices.ts`) | `cache` key: `stablecoins` | `GET /api/stablecoins` | `useStablecoins`, `useStablecoinsWithMeta` | Homepage, Compare, Dependency Map, many cards |
| Stablecoin detail chart/supply view | DefiLlama detail/chart, CoinGecko fallback | `worker/src/cron/sync-stablecoin-charts.ts` + on-demand handler | `cache` key: `stablecoin-charts` + handler-computed payload | `GET /api/stablecoin/:id`, `GET /api/stablecoin-charts` | `useSupplyHistory`, `useStablecoinCharts`, `usePrefetchStablecoin` | Detail page, Compare |
| Depeg events + peg summary | Stablecoin cache prices + DEX corroboration | `worker/src/cron/detect-depegs.ts` (+ pending confirmation) | `depeg_events`, `depeg_pending` | `GET /api/depeg-events`, `GET /api/peg-summary` | `useDepegEvents`, `usePegSummary` | Depeg page, homepage peg columns, detail cards |
| DEX liquidity + DEX implied prices | DefiLlama Yields, Curve, Uniswap/Aerodrome subgraphs, CoinGecko Onchain/GeckoTerminal, DexScreener | `worker/src/cron/dex-liquidity/*` orchestrator | `dex_liquidity`, `dex_liquidity_history`, `dex_prices` | `GET /api/dex-liquidity`, `GET /api/dex-liquidity-history` | `useDexLiquidity`, `useDexLiquidityHistory` | Liquidity page, Compare, report-card inputs |
| Blacklist / freeze tracker | Etherscan v2, TronGrid, RPC providers | `worker/src/cron/sync-blacklist.ts` | `blacklist_events`, `blacklist_sync_state` | `GET /api/blacklist` | `useBlacklistEvents` | Blacklist page |
| Mint/Burn flow tracker | Alchemy logs (Ethereum) | `worker/src/cron/sync-mint-burn.ts` | `mint_burn_events`, `mint_burn_hourly`, `mint_burn_sync_state` | `GET /api/mint-burn-flows`, `GET /api/mint-burn-events` | `useMintBurnFlows`, `useMintBurnFlowsCoin`, `useMintBurnEvents` | Flows page, homepage flow snapshot, coin overlays |
| Stability Index (PSI) | Stablecoin cache + depeg/liquidity context | `worker/src/cron/stability-index.ts`, daily `worker/src/cron/snapshot-psi.ts` | `stability_index_samples`, `stability_index` | `GET /api/stability-index` | `useStabilityIndex`, `useStabilityIndexDetail` | Stability Index pages, digest snapshot |
| DEWS stress signals | Stablecoins + liquidity + blacklist + mint/burn + yield + PSI inputs | `worker/src/cron/compute-dews.ts` | `stress_signals`, `stress_signal_history` | `GET /api/stress-signals` | `useStressSignals`, `useStressSignalDetail` | Depeg tracker risk panels, homepage radar snapshot |
| Yield intelligence | DefiLlama pools, risk-free rate cache | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/fetch-tbill-rate.ts` | `yield_data`, `yield_history`, cache `yield-rankings`, cache `risk_free_rate` | `GET /api/yield-rankings`, `GET /api/yield-history` | `useYieldRankings` | Yield page |
| Daily digest | Anthropic Claude + PSI snapshot context | `worker/src/cron/daily-digest.ts` | `daily_digest` + static build sync to `data/digests.json` | `GET /api/daily-digest`, `GET /api/digest-archive`, `GET /api/digest-snapshot` | `useDailyDigest`, `useDigestArchive`, `useDigestSnapshot` | Digest page + archive |
| Report cards + dependency graph | Peg summary + liquidity + bluechip + stablecoin metadata/dependencies | `worker/src/api/report-cards.ts` compute on read | cache-driven upstream + in-memory compute | `GET /api/report-cards` | `useReportCards` | Safety Scores, Portfolio, Dependency Map, homepage safety snapshot |
| Status reliability | Internal synthetic probes + status synthesis | `worker/src/cron/status-self-check.ts`, `worker/src/api/status.ts` | `status_state`, `status_transitions`, `status_probe_runs`, `status_discrepancy_state` | `GET /api/status`, `GET /api/status-history` | `useStatus`, `useEndpointProbes`, `useHealth` | `/status` admin dashboard |

## Scheduling Backbone

Cron schedules are defined in `worker/src/index.ts`:

- `*/15 * * * *`: stablecoins, chained snapshot-supply retry, charts, FX, PSI compute, DEWS compute, status self-check
- `3,23,43 * * * *`: blacklist sync, mint/burn sync
- `10,40 * * * *`: DEX liquidity sync, then yield sync
- `0 8 * * *`: supply snapshot, T-bill rate, PSI daily snapshot, USDS status, bluechip sync, then daily digest

## Freshness Contract (Frontend)

All API hooks that use `useApiQuery` follow:

- `staleTime = cron interval`
- `refetchInterval = 2 * cron interval`

Defined centrally in `src/hooks/use-api-query.ts`.

## Notes

- Cache passthrough endpoints include freshness metadata via `_meta` and/or `X-Data-Age`.
- Admin/backfill endpoints bypass edge cache via `cacheBypass` flags in `shared/lib/api-endpoints.ts`.
