---
title: "Extract shared fetch pattern helpers for DEX liquidity and price enrichment"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "xhigh"
done: false
---

## Goal

Extract duplicated fetch scaffolding in DEX liquidity crawlers and price enrichment into shared helpers, reducing ~200 LOC.

## Context

The audit found 3 major duplication clusters in the worker cron code:
1. CG/GT pool crawlers duplicate the same crawl/filter/dedupe pipeline
2. GraphQL subgraph fetch loops (UniV3 vs Aerodrome) repeat identical POST/query/error scaffolding
3. Price enrichment passes repeat fetch+JSON parse+apply logic

## Task

### 1. Extract crawlTokenPools helper

**`worker/src/cron/dex-liquidity/fetch-crawlers.ts`** (~lines 46-155 and ~307-416) has two long loops (CoinGecko crawler and GeckoTerminal crawler) that repeat nearly identical stages: rate limit, fetch, parse, filter known pools, volume/TVL sanity check, pool assembly, deduplication.

Extract a shared `crawlTokenPools(config)` function in the same file (or a new `worker/src/cron/dex-liquidity/crawl-helpers.ts`). The config should accept:
- `fetchPools: (tokenAddress, chain) => Promise<RawPool[]>` — the source-specific fetcher
- `parsePool: (raw) => PoolObservation` — source-specific parsing
- Rate limiting config
- Pool dedup/filter logic

Then refactor both crawlers to use the shared function.

**Important:** Read both crawler loops carefully before extracting. Only extract truly shared logic — don't force differences into the abstraction.

### 2. Extract fetchSubgraphEntities helper

**`worker/src/cron/dex-liquidity/fetch-primary.ts`** (~lines 301-390 for UniV3 and ~430-505 for Aerodrome) repeats the same GraphQL request scaffold, error handling, entity loop, and per-token observation insertion.

Extract a `fetchSubgraphEntities(config)` helper accepting:
- `subgraphUrl: string`
- `buildQuery: (skip: number) => string`
- `mapEntity: (entity) => PoolObservation`
- Error handling options

Then refactor both subgraph fetchers to use it.

### 3. Extract fetchPriceMapByIds helper for enrich-prices

**`worker/src/cron/enrich-prices.ts`** (~lines 365-510) has 4 passes that each:
1. Build a list of IDs to fetch
2. Fetch a JSON endpoint
3. Parse the response
4. Apply prices to the working map

Extract a `fetchPriceMapByIds(config)` helper accepting:
- `source: string` (for logging)
- `buildUrl: (ids: string[]) => string`
- `parseResponse: (json) => Map<string, number>`
- `signal: AbortSignal`

Then refactor all 4 passes to use this shared fetch helper, passing source-specific URL builders and response parsers.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- New helper functions exist and are used by the refactored code
- No behavioral changes — the same data sources are fetched in the same order with the same error handling
- `wc -l worker/src/cron/dex-liquidity/fetch-crawlers.ts worker/src/cron/dex-liquidity/fetch-primary.ts worker/src/cron/enrich-prices.ts` shows reduced total LOC
