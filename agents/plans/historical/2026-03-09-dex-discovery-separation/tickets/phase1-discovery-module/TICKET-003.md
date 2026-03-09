---
title: "Extract crawl logic from existing fetch modules and adapt for staged discovery"
agent: codex
model: gpt-5.1-codex-max
reasoning_effort: high
done: false
---

## Goal

Create the per-coin crawl function that queries CG/GT/DexScreener/CG Tickers and returns `StagedPool[]` entries. This extracts and adapts logic from the existing `fetch-crawlers.ts` and `fetch-fallbacks.ts`.

## Context

The existing DEX liquidity cron in `worker/src/cron/dex-liquidity/` has optional discovery phases that crawl CoinGecko Onchain, GeckoTerminal, DexScreener, and CoinGecko Tickers for pool data. These phases currently return in-memory arrays (`CgNewPool[]`, `GtNewPool[]`) that get merged into `LiquidityMetrics`. We need to extract the fetch logic and adapt it to return `StagedPool[]` entries for the staging table instead.

**Do NOT duplicate logic.** Import existing helpers from `../dex-liquidity/` modules and from `../../lib/`. If a helper function is not currently exported, add the `export` keyword to its declaration (do not modify the function body). Document which exports you added in your commit message.

## Key Import Paths (verified against codebase)

These are the EXACT import paths to use — do not guess:

| What | Import from |
|------|-------------|
| `sleepWithSignal`, `throwIfAborted` | `../../lib/abort` |
| `RATE_LIMITS` (includes `.GECKO_TERMINAL_MS`, `.DEXSCREENER_MS`, `.COINGECKO_ONCHAIN_MS`) | `../../lib/rate-limit` |
| `dsRateLimit` (DexScreener rate limiter) | `../../lib/dexscreener` |
| `CHAIN_REGISTRY`, `CG_CHAIN_MAP`, `GT_CHAIN_MAP`, `DS_CHAIN_MAP` | `../../lib/chain-registry` |
| `normalizeProtocol`, `getGtDexQuality` | `../dex-liquidity/pool-helpers` |
| `crawlTokenPools` (GT pagination helper) | `../dex-liquidity/crawl-helpers` |
| `CG_TICKERS_RATE_MS`, `ORDERBOOK_TVL_FACTOR` | `../dex-liquidity/constants` |
| `QUALITY_MULTIPLIERS`, `GT_DEX_QUALITY` | `../../lib/dex-constants` |
| `TRACKED_STABLECOINS` | `@shared/lib/stablecoins` |
| `StagedPool` | `./types` |

`D1Database` is a global type — do NOT import it.

## Task

1. Read these files thoroughly — they contain the logic to extract:
   - `worker/src/cron/dex-liquidity/fetch-crawlers.ts` — `fetchCgPools()` (lines 34-145), `fetchGtPools()` (lines 238-341)
   - `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` — `fetchDsFallbackPools()` (lines 35-151), `fetchCgTickersFallback()` (lines 163-282)
   - `worker/src/cron/dex-liquidity/constants.ts` — `CG_TICKERS_RATE_MS`, `ORDERBOOK_TVL_FACTOR`, crawl budget constants
   - `worker/src/cron/dex-liquidity/crawl-helpers.ts` — `crawlTokenPools` GT pagination helper
   - `worker/src/cron/dex-liquidity/pool-helpers.ts` — `normalizeProtocol()` (line ~30), `getGtDexQuality(dexId)` (line ~45)
   - `worker/src/lib/chain-registry.ts` — `CHAIN_REGISTRY` record with per-chain provider mappings
   - `worker/src/lib/rate-limit.ts` — `RATE_LIMITS` object with `.GECKO_TERMINAL_MS`, `.DEXSCREENER_MS`, `.COINGECKO_ONCHAIN_MS`
   - `worker/src/lib/dexscreener.ts` — `dsRateLimit()` function
   - `worker/src/lib/abort.ts` — `sleepWithSignal()`, `throwIfAborted()`

2. Also read `shared/lib/stablecoins.ts` and `shared/types/index.ts` — understand the `contracts` field shape. It's `ContractDeployment[]` (array of `{ chain: string; address: string; decimals: number }`), NOT a `Record`. The orchestrator builds `coinChains: Map<string, string>` via `new Map((coin.contracts ?? []).map(c => [c.chain, c.address]))`.

3. Replace the stub `worker/src/cron/dex-discovery/crawl-sources.ts` (created by TICKET-002) with the real implementation:

```typescript
import type { StagedPool } from "./types";

export interface CrawlResult {
  pools: StagedPool[];
  priceObs: Array<{
    stablecoinId: string;
    price: number;
    tvl: number;
    chain: string;
    protocol: string;
  }>;
}

/**
 * Crawl all sources for a single stablecoin.
 * Queries only chains where the coin is deployed (chain-aware routing).
 */
export async function crawlCoin(
  stablecoinId: string,
  coinChains: Map<string, string>,  // chain -> contract address
  cgApiKey: string | null,
  knownPoolIds: Set<string>,         // pools already in staging, for dedup
  signal?: AbortSignal,
  deadlineMs?: number,
): Promise<CrawlResult>
```

4. Implement `crawlCoin()` with these sequential stages:

### Stage 1: CoinGecko Onchain (if `cgApiKey` is set)

For each `(chain, address)` in `coinChains` where `CHAIN_REGISTRY[chain]` has a `coingecko` mapping:
- Resolve the CG network slug from `CG_CHAIN_MAP` or `CHAIN_REGISTRY[chain].coingecko`
- Call the CG `/onchain/networks/{network}/tokens/{address}/pools` endpoint
- Use the same rate limiting as `fetchCgPools()` — `await sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal)`
- For each pool returned:
  - Compute `poolId` = `${chain}:${poolAddress.toLowerCase()}`
  - Skip if `poolId` is in `knownPoolIds`
  - Extract `balanceRatio` from base/quote token prices for stable pairs (same logic as `fetchCgPools`)
  - Extract `feeTier` from `pool_fee_percentage` (convert to basis points: `* 100`)
  - Extract `lockedLiqPct` from `locked_liquidity_percentage`
  - Determine `protocol` via `normalizeProtocol(pool.dex?.identifier ?? "")`
  - Determine quality via `getGtDexQuality(pool.dex?.identifier ?? "")`
  - Build a `StagedPool` with `source: "cg_onchain"`
  - Collect price observation if price data available
- Check `deadlineMs` after each chain — if `Date.now() >= deadlineMs`, stop and return partial results

### Stage 2: GeckoTerminal (for GT-only chains)

For each `(chain, address)` in `coinChains` where `CHAIN_REGISTRY[chain]` has a `geckoTerminal` mapping **but was NOT already queried via CG in Stage 1**:
- Resolve the GT network slug from `GT_CHAIN_MAP` or `CHAIN_REGISTRY[chain].geckoTerminal`
- Use `crawlTokenPools` from `../dex-liquidity/crawl-helpers` for GT pagination
- Use `RATE_LIMITS.GECKO_TERMINAL_MS` for rate limiting
- For each pool returned:
  - Compute `poolId`, skip if in `knownPoolIds`
  - Apply quality gates: TVL > $1,000, volume > 0 or TVL > $10,000
  - Build a `StagedPool` with `source: "gecko_terminal"`, `balanceRatio: null`, `lockedLiqPct: null`
  - Collect price observation
- Check `deadlineMs` after each chain

### Stage 3: DexScreener (gap-filler)

Only run if Stages 1+2 found **0 pools** for this coin, OR for chains in `coinChains` not covered by CG/GT registry:
- For each `(chain, address)` to query:
  - Resolve the DexScreener chain ID from `DS_CHAIN_MAP` or `CHAIN_REGISTRY[chain].dexscreener`
  - Call `/tokens/v1/{chainDsId}/{address}`
  - Use `dsRateLimit(signal)` from `../../lib/dexscreener` for rate limiting
  - Apply quality gates from existing code: TVL > $1K, volume > 0 or TVL > $10K, base token must be our token
  - Skip if `poolId` is in `knownPoolIds`
  - Build a `StagedPool` with `source: "dexscreener"`, `balanceRatio: null`, `lockedLiqPct: null`
  - Determine quality: `getGtDexQuality(pair.dexId)` (same lookup used by existing fallback)
  - Collect price observation
- Check `deadlineMs` after each contract

### Stage 4: CoinGecko Tickers (orderbook fallback)

Only run if Stages 1-3 found **0 pools** AND the coin has a `geckoId`. Look up `geckoId` from `TRACKED_STABLECOINS.find(s => s.id === stablecoinId)?.geckoId`.
- Call `/coins/{geckoId}/tickers`
- Rate limit: `await sleepWithSignal(CG_TICKERS_RATE_MS, signal)` (from `../dex-liquidity/constants`)
- Apply existing filters from `fetchCgTickersFallback`: `!is_stale && !is_anomaly && trust_score !== null`, USD-denominated quote, volume >= $1,000
- Aggregate per-exchange into one synthetic `StagedPool` per exchange:
  - `poolId: "orderbook:${exchangeId}:${stablecoinId}"` (not chain:address since these are CEX)
  - `source: "cg_tickers"`
  - `tvlUsd: totalVolume * ORDERBOOK_TVL_FACTOR` (from `../dex-liquidity/constants`, defaults to 3)
  - `protocol: exchangeId`
  - `chain: "cex"` (not on-chain)
  - `balanceRatio: null`, `lockedLiqPct: null`
- Collect price observation

5. After all stages, return `{ pools: allStagedPools, priceObs: allPriceObs }`.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `crawlCoin` is exported from `worker/src/cron/dex-discovery/crawl-sources.ts`
- The file imports from existing modules — verify: `grep -c "from.*dex-liquidity\|from.*lib/" worker/src/cron/dex-discovery/crawl-sources.ts` returns >= 5
- No duplicate implementations of rate limiting, protocol normalization, or chain registry lookup
- All `StagedPool` entries have `poolId` in lowercase format
- DexScreener (Stage 3) only runs when earlier stages found 0 pools or for uncovered chains
- CG Tickers (Stage 4) only runs when all other stages found 0 pools
- No `import type { D1Database }` — it's a global
- `npm run build` exits 0
- `npm test` exits 0 (no regressions)
- `npm run lint` exits 0
