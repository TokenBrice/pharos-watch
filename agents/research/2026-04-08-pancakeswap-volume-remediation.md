# PancakeSwap 24h Volume Remediation Research

Date: 2026-04-08
Status: research only, no implementation
Related commit: `bdeb8d6b` (`fix(dex): restore cg orderbook fallback and balancer exact ids`)

## Current behavior

The current PancakeSwap direct fetch uses the latest `poolDayDatas.volumeUSD` row as if it were a trailing 24h value.

- Code path: `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts:143-160`
- Current assumption encoded in tests: `worker/src/cron/dex-liquidity/__tests__/fetch-pancakeswap.test.ts:23-59`

That is not a true rolling 24h metric.

## Why it is inaccurate

The official PancakeSwap v3 subgraph schema defines both:

- `PoolDayData.volumeUSD`: volume accumulated inside a UTC day bucket
- `PoolHourData.volumeUSD`: volume accumulated inside an hourly bucket

The official mapper updates `PoolDayData` and `PoolHourData` on initialize, mint, burn, and swap events, but only increments `volumeUSD` during swaps.

Implications for the current implementation:

1. Picking only the latest `PoolDayData` row undercounts most intraday runs because it ignores the prior-day slice that still belongs in the trailing 24h window.
2. Around UTC rollover the error can be severe. Just after midnight, the latest daily row can be near zero while the real trailing 24h volume is mostly yesterday.
3. A fresh current-day row can exist even before any swaps happen, because the bucket is created on non-swap events. In that case the current code can read `0` and discard yesterday's still-relevant volume entirely.

This is a data-accuracy bug, not just a naming issue.

## Official upstream evidence

### PancakeSwap docs

- Official developer docs list the Exchange v3 subgraphs and the same BSC / ETH / Base IDs we currently query, plus additional chains we intentionally do not include for cron-budget reasons.

### Official subgraph schema and mappings

- `PoolDayData` and `PoolHourData` both exist in the official v3 schema.
- `PoolHourData.periodStartUnix` makes it possible to query a real trailing window.
- `Pool.volumeUSD` is cumulative all-time volume, so a delta-based design is also theoretically possible.
- The mapper increments `poolDayData.volumeUSD` and `poolHourData.volumeUSD` from swap volume, while bucket creation/update also happens on initialize/mint/burn.

### The Graph query model

- The Graph supports time-travel queries via `block: { number: ... }`.
- The Graph docs also warn that time-travel queries still have limitations.
- The Graph docs recommend avoiding heavy `skip` pagination.

### Reliability caution

- PancakeSwap's official `pancake-subgraph` repo has an open issue (#255, opened 2024-02-06) reporting that Exchange V3 data for some pools only existed for the recent 30 minutes when historical 24h lookups were needed.

That issue is not direct proof that `PoolHourData` is bad today, but it is enough to treat historical-block deltas as lower-confidence until validated against live samples.

## Options considered

### Option A: Sum `PoolHourData.volumeUSD` over the trailing 24h window

Mechanics:

- Keep the current pool list query.
- Replace the `poolDayDatas` query with `poolHourDatas`.
- Filter on `periodStartUnix_gte` for the trailing 24h cutoff.
- Sum `volumeUSD` per pool across all returned hourly rows.

Why this is strong:

- Uses an official PancakeSwap entity whose semantics match the metric we want.
- Avoids block-resolution dependencies.
- Avoids time-travel query limitations.
- Handles UTC-boundary transitions correctly.
- Handles partial current-hour activity correctly because the active hour bucket accumulates live within the hour.

Tradeoffs:

- More query volume than the current daily-bucket approach.
- The current batch size of `50` pools is too large for a `first: 1000` hourly-row query in worst-case high-activity windows.
- To avoid row-level pagination, hourly batches should be reduced so one batch can safely fit inside the row cap.

Implementation shape if chosen later:

- Prefer hourly batches around `20` pools, or another ceiling proven safe with live data.
- Keep batch queries sequential or tightly bounded because `sync-dex-liquidity` has a 13-minute app timeout and the worker design assumes a constrained outbound connection budget.
- Extend tests to cover:
  - a trailing window spanning two UTC days
  - a current-day zero-volume row that should not erase yesterday's volume
  - multiple hourly rows summed for one pool
  - degraded behavior when one hourly batch fails

Assessment:

- Recommended first choice.

### Option B: Compute 24h volume as a delta of cumulative `Pool.volumeUSD`

Mechanics:

- Use the existing current pool query for present-day `volumeUSD`.
- Resolve the block number from roughly 24 hours ago for each chain.
- Query the same pools at `block: { number: oldBlock }`.
- Compute `currentVolumeUSD - historicalVolumeUSD`.

Why this is attractive:

- Much cheaper query count than hourly summation.
- Preserves the current per-page pool batching model.
- Uses cumulative counters, which are conceptually clean.

Why I do not recommend it first:

- Requires reliable timestamp-to-block resolution for BSC, Ethereum, and Base.
- Adds new RPC or block-index dependencies that the Pancake fetch does not currently need.
- The Graph's own docs warn about time-travel limitations.
- PancakeSwap's open historical-data issue is directionally concerning for this exact pattern.

Assessment:

- Efficient, but second choice unless live validation proves it is stable enough.

### Option C: Keep day buckets but relabel them honestly

Mechanics:

- Admit the metric is "latest daily bucket" or "day-to-date volume", not trailing 24h.

Assessment:

- Honest, but it does not solve the scoring-accuracy problem.
- Not recommended if the goal is precision.

### Option D: Query raw swaps over the last 24h and sum `amountUSD`

Assessment:

- Semantically precise.
- Operationally worst: far more rows, worse latency, and poorer cron-budget fit.
- Not recommended.

## Recommendation

Preferred remediation path:

1. Move PancakeSwap volume collection from `PoolDayData` to summed `PoolHourData`.
2. Reduce the hourly batch size enough to avoid row pagination in normal and worst-case windows.
3. Keep the rest of the fetch path unchanged for the first pass.
4. After that lands, update methodology/docs from "`poolDayDatas.volumeUSD`" to "sum of trailing `poolHourDatas.volumeUSD`".

Fallback path if hourly queries prove too slow in live testing:

1. Prototype the historical `Pool.volumeUSD` delta approach behind a local benchmark.
2. Only adopt it if live queries are stable across BSC, Ethereum, and Base for a representative pool sample.

## Pre-implementation checks

Before changing production code, validate with live queries:

1. For a sample of active pools on BSC, ETH, and Base, compare:
   - latest `PoolDayData.volumeUSD`
   - summed last-24h `PoolHourData.volumeUSD`
   - cumulative `Pool.volumeUSD` delta across a 24h-old block
2. Measure worst-case latency and row counts for hourly batches.
3. Confirm whether hourly rows are dense enough that `20` pools per batch is safe, or whether the limit should be lower.
4. Confirm that the current partial hour is present and accumulating as expected.

## Source links

- PancakeSwap subgraph docs: https://developer.pancakeswap.finance/apis/subgraph
- Official v3 subgraph schema: https://github.com/pancakeswap/exchange-v3-subgraphs/blob/main/template/schema.graphql
- Official v3 interval updates: https://github.com/pancakeswap/exchange-v3-subgraphs/blob/main/template/utils/intervalUpdates.ts
- Official v3 core mapping: https://github.com/pancakeswap/exchange-v3-subgraphs/blob/main/template/mappings/core.ts
- The Graph GraphQL API docs: https://thegraph.com/docs/en/subgraphs/querying/graphql-api/
- PancakeSwap historical-data issue #255: https://github.com/pancakeswap/pancake-subgraph/issues/255
