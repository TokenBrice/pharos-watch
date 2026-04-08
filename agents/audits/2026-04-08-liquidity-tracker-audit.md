# Liquidity Tracker Audit - 2026-04-08

## Scope

- Reviewed the DEX liquidity scoring pipeline under `worker/src/cron/dex-liquidity/`
- Inspected every protocol-native liquidity fetcher currently wired into `syncDexLiquidity()`
- Checked staged discovery and orderbook fallback paths that can materially affect published liquidity
- Verified current upstream API behavior for Balancer and CoinGecko against live responses / official docs

## Changes made

### 1. CoinGecko tickers fallback no longer depends on deprecated `trust_score`

Files:

- `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- tests under `worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts`
- tests under `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`

Why:

- CoinGecko deprecated ticker `trust_score` effective March 3, 2026 and now returns `null`
- The previous filter required `trust_score !== null`, which meant valid orderbook rows were silently discarded
- This impacted both the half-hourly discovery cron and the in-run CG tickers fallback

New rule:

- accept tickers when they are not stale/anomalous, have a non-empty exchange identifier, finite USD price, and finite USD volume >= $1,000, with a USD-equivalent quote asset

### 2. Balancer direct pools now use the API's exact pool address

Files:

- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- tests under `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

Why:

- Balancer `poolGetPools` exposes both:
  - `id`: 32-byte vault pool id
  - `address`: 20-byte pool address
- The pipeline previously stored `id` as `poolAddress`, so Balancer pools could not participate in exact-address identity matching
- That weakened exact dedupe and authoritative staged-pool confirmation

New rule:

- use `address` as the exact pool identity
- keep a defensive fallback that derives the first 20 bytes from `id` if `address` is absent

## Documentation updated

- `docs/dex-liquidity.md`
- `docs/liquidity-score-timeline.md`
- `shared/lib/liquidity-score-version.ts`
- `src/app/methodology/sections/core/liquidity-section.tsx`

## Validation

- `npm test -- worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run build`

## Residual risk

### PancakeSwap 24h volume is still sourced from `poolDayDatas`

File:

- `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts`

Risk:

- The fetcher currently uses the latest `poolDayDatas.volumeUSD` row as if it were rolling 24h volume
- In subgraph families this data is day-bucketed, so during the current UTC day it can understate true trailing-24h activity

Recommended next step:

- move Pancake volume intake to an explicitly rolling source if available, or reconstruct a trailing 24h estimate from finer-grained buckets instead of taking the latest day bucket as-is
