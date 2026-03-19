# Pricing Source Additions Design

Date: 2026-03-19

Question:
- How should Chainlink Data Feeds, Kraken public ticker, Meteora DLMM/DAMM, Bitstamp public ticker, and Jupiter Price API be added to the Pharos pricing pipeline?

## Executive Summary

Recommended placement:

1. Kraken: add as a new hard source inside `fetchPrimaryPrices()`.
2. Bitstamp: add as a lower-weight hard source inside `fetchPrimaryPrices()`.
3. Chainlink: split into two phases.
   - Phase 1: add Chainlink FX and metal reference feeds to `syncFxRates()`.
   - Phase 2: add selected direct token/USD feeds to `fetchPrimaryPrices()`.
4. Meteora DLMM/DAMM: do not add as a naive full-surface direct API crawler. Integrate through the Solana DEX discovery / staging path or a tightly targeted Solana fetcher.
5. Jupiter Price API: add as a fallback-only Solana enrichment pass inside `enrichMissingPrices()`.

This ordering improves the current pipeline in the places where the repo already has strong seams:

- direct CEX voices inside `worker/src/lib/cex-tickers.ts`,
- oracle / reference-rate logic inside `worker/src/cron/sync-fx-rates.ts`,
- hard multi-source consensus inside `worker/src/cron/enrich-prices.ts`,
- large DEX surface ingestion inside `worker/src/cron/dex-discovery/`,
- fallback recovery inside `worker/src/cron/enrich-prices-passes.ts`.

## Current Pipeline Seams

The relevant extension points are already clear in the current worker:

- `worker/src/cron/enrich-prices.ts`
  - `fetchPrimaryPrices()` is the hard-source consensus step.
  - `applyPoolChallenge()` only downgrades soft-only clusters.
  - `enrichMissingPrices()` is the fallback recovery path.
- `worker/src/lib/cex-tickers.ts`
  - current direct venue clients for Binance and Coinbase.
- `worker/src/lib/price-consensus.ts`
  - weighted N-source clustering and source-label construction.
- `worker/src/cron/sync-fx-rates.ts`
  - current FX / metal reference cache for peg-aware price validation.
- `worker/src/cron/dex-liquidity/orchestrator.ts`
  - direct API DEX fetchers for Raydium / Orca / Fluid / Balancer.
- `worker/src/cron/dex-discovery/orchestrator.ts`
  - staged discovery path for large, partial, per-coin pool crawling into `dex_pool_staging`.

The main architectural constraint is still the Worker execution model documented in `docs/worker-and-api-limits.md`: the pricing and DEX jobs share Cloudflare's per-trigger connection budget, so sources with large pool surfaces must not be treated like trivial single-call venue APIs.

## Source-by-Source Design

### 1. Kraken Public Ticker

Recommended role:
- hard primary-consensus source

Why it fits there:
- it is an independent venue voice, not an aggregator,
- it can cover multiple relevant USD pairs in one public REST call,
- it is operationally similar to Binance / Coinbase, so the current CEX client seam already matches it.

Verified pair coverage from live probes:
- `DAI/USD`
- `EURC/USD`
- `PAXG/USD`
- `PYUSD/USD`
- `USD1/USD`
- `USDC/USD`
- `USDS/USD`
- `USDT/USD`
- `EUR/USD`

Implementation shape:
- extend `worker/src/lib/cex-tickers.ts` with:
  - `KRAKEN_KNOWN_SYMBOLS`
  - explicit request-pair list
  - explicit response-key-to-symbol mapping
  - `fetchKrakenPrices(symbols, signal)`
- wire it into `worker/src/cron/enrich-prices.ts` beside Binance / Coinbase.
- add a circuit breaker key in `worker/src/lib/constants.ts`, e.g. `KRAKEN_PRICES`.

Important implementation detail:
- do not derive the stablecoin symbol from Kraken's response key.
- live responses use exchange-specific keys such as `USDTZUSD` and `ZEURZUSD`, so the integration should rely on an explicit allowlist map.

Suggested consensus treatment:
- source label: `kraken`
- weight: `2`
- confidence role: same class as Binance / Coinbase

Suggested tests:
- `worker/src/lib/__tests__/cex-tickers.test.ts`
  - parses mixed Kraken result keys correctly
  - ignores untracked markets
  - handles empty / malformed result bodies
- `worker/src/cron/__tests__/enrich-prices.test.ts`
  - Kraken participates in agreement clusters
  - Kraken alone yields `single-source`, not `high`

Risk note:
- Kraken plus Bitstamp increases the number of CEX voices in the consensus cluster.
- That is still a net improvement, but it pushes the system closer to "CEX-family overweighting". For now, the safest control is conservative weights rather than adding a new family-cap mechanism immediately.

### 2. Bitstamp Public Ticker

Recommended role:
- hard primary-consensus source, but lower-weight than Kraken / Binance / Coinbase

Why it fits there:
- it is another direct venue voice,
- it exposes a simple all-tickers endpoint,
- implementation cost is small and bounded.

Verified pair coverage from live probes:
- `EUR/USD`
- `USDC/USD`
- `DAI/USD`
- `USDT/USD`
- `PYUSD/USD`

Implementation shape:
- extend `worker/src/lib/cex-tickers.ts` with:
  - `BITSTAMP_PAIR_TO_SYMBOL`
  - `fetchBitstampPrices(signal)` using the single all-tickers endpoint
- wire it into `worker/src/cron/enrich-prices.ts`
- add `BITSTAMP_PRICES` to `worker/src/lib/constants.ts`

Suggested consensus treatment:
- source label: `bitstamp`
- weight: `1`
- confidence role: corroborating venue, not a dominant voice

Why the lower weight matters:
- Bitstamp improves venue diversity.
- It should not let the CEX family swamp CoinGecko, Pyth, RedStone, or promoted DEX prices in close-call clusters.

Suggested tests:
- `worker/src/lib/__tests__/cex-tickers.test.ts`
  - parses all-tickers payload
  - maps `pair` / `market` correctly
  - ignores pairs outside the tracked allowlist

### 3. Chainlink Data Feeds

Recommended role:
- phase 1: reference-rate and metal-feed upgrade
- phase 2: selected hard primary-consensus source for direct token/USD feeds

This should not be implemented as a single broad "add Chainlink everywhere" change. The clean design is staged.

#### Phase 1: Chainlink inside `syncFxRates()`

Best first use:
- intraday FX reference feeds for supported pegs
- intraday metal reference feeds for `peggedGOLD` / `peggedSILVER`

Why phase 1 comes first:
- this is the highest quality improvement for non-USD pegs and commodity-backed assets,
- the current live path still leans on daily ECB publication plus secondary currency APIs,
- Chainlink improves the reference side without forcing broad stablecoin-feed coverage on day 1.

Implementation shape:
- add `worker/src/lib/chainlink-feeds.ts`
  - curated registry of supported feeds
  - proxy address
  - chain
  - decimals
  - heartbeat / freshness budget
  - semantic key such as `peggedEUR`, `peggedGBP`, `peggedGOLD`
- use existing RPC plumbing in:
  - `worker/src/lib/evm-rpc.ts`
  - `worker/src/lib/chain-registry.ts`
- extend `worker/src/cron/sync-fx-rates.ts` to:
  - fetch Chainlink-supported references first,
  - validate freshness via `latestRoundData.updatedAt`,
  - normalize by `decimals`,
  - keep existing Frankfurter / secondary APIs for unsupported pegs and as fallback.

Source handling recommendation:
- prefer Chainlink where coverage is present and fresh,
- keep the current cache key shape (`fx-rates`) so downstream price validation does not need a large refactor,
- add per-peg source metadata into the cron result payload.

Suggested circuit breaker:
- `CHAINLINK_FEEDS`

#### Phase 2: Chainlink inside `fetchPrimaryPrices()`

Best second use:
- selected direct token/USD feeds only

Scope recommendation:
- major assets with confirmed feed coverage and known operational value
- examples from research coverage: `USDC`, `USDT`, `EURC`, `PAXG`, plus FX / metal references already used in validation

Do not do this:
- do not attempt blanket long-tail Chainlink support for all tracked assets,
- do not treat stale or thinly maintained feeds as equivalent to liquid venue prices.

Implementation shape:
- expand `worker/src/lib/chainlink-feeds.ts` with a stablecoin-feed registry keyed by `stablecoinId`
- in `worker/src/cron/enrich-prices.ts`, load Chainlink prices in parallel with Pyth / RedStone / CEX sources
- only emit a source when:
  - the feed is in the curated registry,
  - `answer > 0`,
  - `updatedAt` is within the configured freshness budget,
  - the normalized price is within peg-aware plausibility bounds

Suggested consensus treatment:
- source label: `chainlink`
- weight: `2`
- confidence role: hard oracle voice, comparable to Pyth / RedStone

Implementation caution:
- Chainlink proxy reads are on-chain ABI calls, not simple JSON fetches.
- The worker already has generic `eth_call` helpers, but the integration will still need a small ABI decoding layer for `latestRoundData()` and `decimals()`.

Suggested tests:
- `worker/src/lib/__tests__/chainlink-feeds.test.ts`
  - parses proxy response data
  - rejects stale rounds
  - normalizes decimals correctly
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`
  - Chainlink-supported pegs override ECB where valid
  - ECB / secondary fallback still fills uncovered pegs
- `worker/src/cron/__tests__/enrich-prices.test.ts`
  - Chainlink joins consensus clusters as a hard source

### 4. Meteora DLMM / DAMM

Recommended role:
- targeted Solana DEX coverage that eventually feeds `dex_prices` and `dex_liquidity`

Recommended placement:
- preferred: `worker/src/cron/dex-discovery/`
- fallback alternative: a tightly filtered direct API fetcher, not a full global sweep

Why this placement matters:
- live probes show a very large pool surface:
  - DLMM: roughly `101k+` pools
  - DAMM v2: roughly `54k+` pools
- a naive "fetch every pool every run" design is not coherent with the current cron budgets.

What not to build:
- do not add Meteora as another unconstrained source beside `fetchRaydiumPools()` and `fetchOrcaPools()` if the implementation requires paginating the whole venue every cycle.

Preferred implementation shape:
- add targeted Meteora crawlers under `worker/src/cron/dex-discovery/`
- scope each crawl by tracked Solana stablecoin mint rather than global venue pagination
- persist discovered pools into `dex_pool_staging`
- let the existing staging merge and DEX pricing pipeline decide:
  - whether a pool is eligible for liquidity scoring
  - whether it emits a price observation
  - whether it becomes a promoted DEX voice via `dex_prices.price_sources_json`

Targeting strategy:
- start from the tracked Solana mint registry in `shared/lib/stablecoins.ts`
- only query pools where one side is a tracked stablecoin mint
- prefer quote sides that are already usable as USD references inside the DEX pricing code path:
  - `USDC`
  - `USDT`
  - `PYUSD`
  - `EURC` for euro-pegged assets
- stop early once TVL or quality falls below the same economic thresholds the DEX pipeline already uses

Why discovery / staging is the safer first fit:
- Meteora is a large venue surface, not a tiny venue API,
- the existing discovery path is already built for partial per-asset crawls,
- this keeps Meteora from bloating the main pricing cron while still feeding:
  - DEX price observations,
  - top pools for the UI,
  - pool challenge inputs,
  - eventual `dex-promoted` / per-protocol primary-consensus evidence.

Possible later promotion path:
- once Meteora pools are flowing cleanly into `dex_prices.price_sources_json`, they can contribute through the existing DEX bridge in `fetchPrimaryPrices()`
- likely source labels:
  - `meteora-dlmm`
  - `meteora-damm`

Weight guidance if later promoted:
- `meteora-dlmm`: `2` initially
- `meteora-damm`: `1` initially

Suggested tests:
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
  - tracked-mint filtering
  - malformed pool rejection
  - pagination stop conditions
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
  - Meteora pools generate eligible price observations only when quote/reference logic is valid

### 5. Jupiter Price API V3

Recommended role:
- fallback-only Solana enrichment source

Recommended placement:
- add a new pass in `worker/src/cron/enrich-prices-passes.ts`
- call it from `enrichMissingPrices()` after the stronger hard sources have already had a chance to resolve the asset

Why it should not be a hard primary source:
- Jupiter is an aggregated routing / price surface, not a raw venue feed,
- using it inside primary consensus would create fake independence against other Solana-derived sources.

Best use case in Pharos:
- recover prices for Solana-issued tracked assets that still remain unresolved after:
  - DefiLlama contract passes
  - hard primary consensus
  - optional CMC batch

Implementation shape:
- add `runJupiterPass()` to `worker/src/cron/enrich-prices-passes.ts`
- batch requests by Solana mint, up to the documented per-request limit
- only query assets that:
  - still have missing prices,
  - have a Solana contract address in tracked metadata,
  - do not already have a strong resolved price
- add a circuit breaker key, e.g. `JUPITER_PRICES`

Validation gates:
- require `usdPrice > 0`
- require meaningful `liquidity`
- require recent `createdAt` / block freshness when present
- apply the existing peg-aware `isReasonablePrice()` bounds before accepting the price

Suggested source treatment:
- source label: `jupiter`
- confidence: `fallback`

API contract recommendation:
- use the documented `api.jup.ag` price API with `x-api-key` if this source is implemented for production
- treat the public `lite-api.jup.ag` path only as a research observation, not the main contract to design around

Suggested stats impact:
- extend `EnrichmentStats` to include a Jupiter pass count
- update the summary log in `enrichMissingPrices()`

Suggested tests:
- `worker/src/cron/__tests__/enrich-prices.test.ts`
  - unresolved Solana asset is filled by Jupiter
  - low-liquidity or implausible Jupiter prices are rejected
  - non-Solana assets are ignored

## Recommended Rollout Order

1. Kraken
   - highest value for lowest implementation risk
2. Bitstamp
   - same seam, low cost, modest additional venue diversity
3. Chainlink phase 1
   - strongest improvement for non-USD and commodity reference validation
4. Jupiter
   - low-risk fallback gain for unresolved Solana assets
5. Meteora
   - highest Solana upside, but needs deliberate placement and throttling
6. Chainlink phase 2
   - add curated direct stablecoin/USD feeds after the Chainlink plumbing exists

## Concrete File Surface For Future Implementation

Primary pricing / consensus:
- `worker/src/lib/cex-tickers.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/lib/constants.ts`
- `worker/src/lib/price-consensus.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/lib/__tests__/cex-tickers.test.ts`

Chainlink reference-rate work:
- `worker/src/lib/chainlink-feeds.ts` (new)
- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/lib/evm-rpc.ts`
- `worker/src/lib/chain-registry.ts`
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `worker/src/lib/__tests__/chainlink-feeds.test.ts` (new)

Jupiter fallback:
- `worker/src/cron/enrich-prices-passes.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`

Meteora integration:
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts` or new Meteora-specific crawler modules
- `worker/src/cron/dex-discovery/persistence.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts` only if a later direct API path is adopted
- `worker/src/cron/dex-discovery/__tests__/crawl-sources.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`

## Docs And Product Surfaces To Update When Implementation Starts

If these sources are actually added to production behavior, update:

- `docs/pricing-pipeline.md`
- `docs/worker-and-api-limits.md`
- `docs/api-reference.md` if status / source-distribution fields change
- the about page, because new data sources are being added

If Meteora changes DEX-liquidity scoring or price-promotion methodology in a material way, also update:
- `docs/dex-liquidity.md`

## Source Links

Official docs:
- Chainlink Data Feeds: `https://docs.chain.link/data-feeds`
- Chainlink using data feeds: `https://docs.chain.link/data-feeds/using-data-feeds`
- Chainlink API reference: `https://docs.chain.link/data-feeds/api-reference`
- Kraken ticker docs: `https://docs.kraken.com/api/docs/rest-api/get-ticker-information/`
- Kraken rate limits: `https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits/`
- Bitstamp API docs: `https://www.bitstamp.net/api/`
- Jupiter price API docs: `https://dev.jup.ag/api-reference/price`
- Jupiter v3 price docs: `https://dev.jup.ag/api-reference/price/v3/price`
- Jupiter price OpenAPI spec: `https://dev.jup.ag/openapi-spec/price/v3/price.yaml`
- Meteora DLMM API docs: `https://docs.meteora.ag/api-reference/dlmm/overview`
- Meteora DLMM pools docs: `https://docs.meteora.ag/api-reference/dlmm/pools/pools`
- Meteora DLMM group docs: `https://docs.meteora.ag/api-reference/dlmm/pools/group`
- Meteora DAMM v2 docs: `https://docs.meteora.ag/api-reference/damm-v2/overview`
- Meteora DAMM v2 pools docs: `https://docs.meteora.ag/api-reference/damm-v2/pools/pools`

Representative live probe endpoints used in the research pass:
- Kraken ticker: `https://api.kraken.com/0/public/Ticker?pair=USDTUSD,USDCUSD,DAIUSD,EURUSD`
- Kraken asset pairs: `https://api.kraken.com/0/public/AssetPairs?pair=USDTUSD,USDCUSD,DAIUSD,EURUSD,PAXGUSD`
- Bitstamp all tickers: `https://www.bitstamp.net/api/v2/ticker/`
- Bitstamp markets: `https://www.bitstamp.net/api/v2/markets/`
- Jupiter public probe: `https://lite-api.jup.ag/price/v3`
- Meteora DLMM pools: `https://dlmm.datapi.meteora.ag/pools`
- Meteora DAMM v2 pools: `https://damm-v2.datapi.meteora.ag/pools`
