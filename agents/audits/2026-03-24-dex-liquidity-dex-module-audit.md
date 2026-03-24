# DEX Liquidity Module Audit

Date: 2026-03-24
Scope: DEX-side liquidity module only. Redemption Backstop explicitly excluded.

## Objective

This audit evaluates the DEX liquidity module against two goals:

1. Data accuracy: liquidity coverage, price-observation honesty, and source normalization reliability.
2. Code maintainability: clarity, cohesion, duplication, hotspot size, and ease of safe iteration.

The review covers:

- runtime docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/dex-liquidity.md`, `docs/pricing-pipeline.md`
- scoring/orchestration: `worker/src/cron/dex-liquidity/orchestrator.ts`, `worker/src/cron/dex-liquidity/scoring.ts`, `worker/src/cron/dex-liquidity/process-pools.ts`, `worker/src/cron/dex-liquidity/staging-merge.ts`
- primary/fallback/discovery sources: `fetch-primary.ts`, `fetch-fluid.ts`, `fetch-balancer.ts`, `fetch-raydium.ts`, `fetch-orca.ts`, `fetch-crawlers.ts`, `fetch-fallbacks.ts`, `geckoterminal-shared.ts`, `coingecko-onchain.ts`
- shared DEX helpers: `worker/src/lib/dex-api-common.ts`, `worker/src/cron/dex-liquidity/pool-identity.ts`, `worker/src/lib/dexscreener.ts`
- test surface: direct-api, fallbacks, scoring, process-pools, staging-merge, fetch-primary/fetch-crawlers tests

## Executive Summary

The module is materially stronger than a typical DEX-liquidity pipeline. It already has:

- multi-source coverage rather than single-provider dependence
- conservative address-first token resolution
- explicit degraded-mode handling
- identity-aware dedup
- staging separation between discovery and scoring
- meaningful price sanity checks
- a non-trivial test surface

The main weaknesses are no longer basic correctness bugs. They are now second-order issues:

- systematic coverage truncation in some discovery sources
- heuristics that can undercount or overstate liquidity in edge cases
- confidence semantics that are too coarse for the current source mix
- duplicated pool-contribution logic across several code paths
- oversized hotspots where fetch, normalization, dedup, scoring, and persistence concerns are interleaved

The largest risks to accuracy are:

1. first-page-only crawling for GeckoTerminal and CoinGecko onchain
2. fallback expansion that only fills zero-coverage gaps and does not improve weak partial coverage
3. DL-protocol-cap heuristics that can suppress legitimate non-DL liquidity
4. synthetic orderbook and direct-API maturity heuristics that can overstate durability/quality
5. optimistic coverage confidence labels that do not reflect source breadth or measurement quality

The largest risks to maintainability are:

1. pool metric contribution logic spread across `process-pools.ts`, `mergeGtPools`, `mergeCgPools`, and `convertToGtNewPools`
2. very large hotspot files: `fetch-primary.ts` 776 LOC, `scoring.ts` 696 LOC, `orchestrator.ts` 645 LOC, `dex-api-common.ts` 483 LOC
3. brittle “array with metadata” transport shape for direct API results
4. mutation-heavy scoring flow that filters, caps, rebuilds, aggregates, and persists in one pass

## Priority Findings

### Critical / High

1. Discovery coverage is systematically truncated for GeckoTerminal and CoinGecko onchain.
Evidence:
- `worker/src/cron/dex-liquidity/geckoterminal-shared.ts:16` hard-codes `page=1`
- `worker/src/lib/coingecko-onchain.ts:84-99` hard-codes `page=1`

Impact:
- heavily traded or wrapper-heavy assets can lose legitimate pools
- downstream effects hit both liquidity score and DEX price observations
- coverage degradation is silent because this is treated as successful fetch, not partial fetch

Why this matters:
- this is not random noise; it is a systematic ceiling on recall
- the more liquid/complex the asset, the more likely the module misses meaningful pools

Recommendation:
- add bounded multi-page crawl support with per-token page caps and explicit pagination telemetry
- record `pagesFetched`, `poolsSeen`, and `paginationTruncated`
- treat truncation as a confidence input, not just a hidden implementation detail

2. Fallback expansion only triggers for zero pools or zero price observations, not for weak partial coverage.
Evidence:
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:28-43`
- `worker/src/cron/dex-liquidity/orchestrator.ts:416-458`

Impact:
- a coin with one weak observation or one thin pool is considered “covered”
- DexScreener / CoinGecko-tickers will not add corroborating or broader coverage
- the module is good at filling holes, but weaker at improving marginal coverage

Recommendation:
- introduce a “needs enrichment” predicate based on:
  - pool count
  - covered TVL
  - measured-balance TVL
  - price-observation protocol count
  - coverage class/confidence
- run fallbacks for `weak_partial`, not just `missing`

3. Protocol TVL caps can undercount real liquidity when DeFiLlama is stale or incomplete for a protocol/chain.
Evidence:
- per-coin cap: `worker/src/cron/dex-liquidity/scoring.ts:360-397`
- global cap: `worker/src/cron/dex-liquidity/scoring.ts:491-518`

Impact:
- non-DL pools are scaled down to DL headroom even when direct APIs are newer or broader
- direct-API-only coverage on under-indexed chains can be clipped
- the system is safe against inflated virtual reserves, but can become pessimistic in real-liquidity cases

Recommendation:
- replace hard capping with source-aware cap modes:
  - `strict_cap` for known virtual-reserve families
  - `soft_cap` for direct APIs
  - `no_cap` when DL coverage for that protocol/chain is known incomplete
- make cap decisions protocol-family-specific rather than “all non-DL”

4. Coverage confidence is too coarse and can overstate trust.
Evidence:
- `worker/src/cron/dex-liquidity/scoring.ts:204-223`

Current behavior:
- any all-primary row is `primary` with confidence `1`
- that includes “all direct_api” even if only one direct provider contributed
- confidence ignores source breadth, failure telemetry, measured-balance share, and fallback dependence

Impact:
- frontends and downstream logic can treat very different coverage states as equally trusted
- durability and trend baselines can inherit overconfident historical rows

Recommendation:
- compute coverage confidence from:
  - source family count
  - protocol count
  - chain count
  - measured-balance TVL share
  - measured-organic TVL share
  - fetch degradation flags
  - whether coverage depends on one provider family

### Medium

5. Price-observation identity confidence is optimistic in several paths.
Evidence:
- staged observations: `worker/src/cron/dex-liquidity/staging-merge.ts:224-233`
- DexScreener fallback observations: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:128-145`
- direct API observations: `worker/src/lib/dex-api-common.ts:465-473`
- collapse logic trusts `derived_unique`: `worker/src/cron/dex-liquidity/scoring.ts:225-276`

Issue:
- these paths set `identityConfidence = "derived_unique"` whenever a derived key exists
- they do not prove uniqueness at observation-build time
- collapse logic later trusts that label

Impact:
- mostly latent today because many sources provide exact ids
- but when exact ids are absent or malformed, ambiguous pools can be over-collapsed

Recommendation:
- compute actual identity confidence only after derived-key cardinality is known
- use `derived_candidate` during collection and resolve it later

6. Direct API pools get a fixed maturity of 90 days, which can overstate durability for new pools.
Evidence:
- `worker/src/lib/dex-api-common.ts:398`

Impact:
- new Balancer/Raydium/Orca/Fluid pools can inherit maturity credit they did not earn
- cross-source maturity semantics are inconsistent: discovery sources cap at 30 days, direct APIs default to 90, orderbooks default to 365

Recommendation:
- either:
  - fetch actual creation timestamps where available
  - or downgrade unknown maturity to a conservative neutral floor and track `maturityMeasured`

7. Orderbook fallback intentionally forces high pair quality and high maturity.
Evidence:
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:277-290`

Issue:
- synthetic orderbook pools use `symbol: "${meta.symbol} / USDC"` solely to force pair-quality = 1.0
- they also assume `maturityDays: 365`

Impact:
- useful as a recovery heuristic, but optimistic for score-quality semantics
- this is especially sensitive because these pools are not actually AMMs and do not share the same liquidity behavior

Recommendation:
- represent orderbook pools as their own pair-quality path instead of spoofing a stable quote symbol
- separate “trusted quote asset” from “pair-quality score”

8. Fluid reserve normalization loses precision and uses a fragile volume approximation.
Evidence:
- bigint to number: `worker/src/cron/dex-liquidity/fetch-fluid.ts:105-109`
- approximate volume: `worker/src/cron/dex-liquidity/fetch-fluid.ts:160-165`
- approximation is codified by test: `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

Impact:
- large reserve values can exceed safe integer precision before decimal normalization
- if token-level volume-to-USD derivation later fails, the raw `base_volume + target_volume` fallback is not guaranteed to be USD-consistent

Recommendation:
- keep reserve math in bigint/string until decimal normalization
- mark approximate volume provenance explicitly and reduce its confidence if USD derivation fails

## Source-By-Source Review

### DeFiLlama Yields

Strengths:
- still the best broad primary TVL source
- gives the module its broadest coverage footprint

Weaknesses:
- the system depends heavily on DL availability for breadth and protocol caps
- DL protocol caps are reused beyond their natural scope and can suppress better direct observations

Assessment:
- keep as core breadth input, but stop using it as a universal truth oracle for non-DL sources

### Curve API

Strengths:
- best measured balance data in the module
- metapool-aware handling is thoughtful
- price observations are gated by balance ratio and TVL

Weaknesses:
- source family is treated as `dl` in price observations, which obscures provenance separation
- Curve is doing double duty as both scoring enrichment and price-honesty input

Assessment:
- reliable, but provenance should be more explicit in persisted observation metadata

### Uniswap V3 / Aerodrome Subgraphs

Strengths:
- useful for fee-tier/stability enrichment and additional price observations
- non-fatal per-chain failure semantics are sensible

Weaknesses:
- subgraph observability is basic
- no persisted per-source coverage detail survives into row-level confidence

Assessment:
- acceptable accuracy path, but under-modeled in confidence outputs

### Fluid

Strengths:
- resolver-backed balances are valuable
- avoids symbol-based ownership learning

Weaknesses:
- reserve precision risk
- approximate volume fallback
- sequential per-pool resolver enrichment is expensive relative to its information gain

Assessment:
- high-value source, but the implementation needs a more disciplined measurement/provenance model

### Balancer

Strengths:
- rich token-level data
- weight-aware balance calculations are good

Weaknesses:
- fetcher repeats generic pagination/error handling patterns
- pool normalization logic is source-local instead of using a reusable adapter framework

Assessment:
- strong source, average implementation hygiene

### Raydium

Strengths:
- direct Solana coverage is important and useful

Weaknesses:
- no explicit provenance on whether balance/price came from raw API or reconstructed logic
- same adapter duplication problem as other direct APIs

Assessment:
- useful source, but not architecturally distinct enough to justify its own large bespoke fetch path

### Orca

Strengths:
- cursor handling is more mature than some other source fetchers

Weaknesses:
- same adapter duplication pattern
- fee/balance normalization assumptions live only in code comments and tests

Assessment:
- good source integration, but not well mutualized

### CoinGecko Onchain

Strengths:
- important for long-tail discovery
- provides balance and locked-liquidity inputs not available from GT

Weaknesses:
- first-page-only crawl
- confidence decay is coarse
- merged pools share logic with GT but still duplicate a lot of code

Assessment:
- strategically valuable, currently recall-limited

### GeckoTerminal

Strengths:
- wide DEX surface
- good fallback coverage for unsupported ecosystems

Weaknesses:
- first-page-only crawl
- random token order means coverage can vary run to run under budget pressure

Assessment:
- useful breadth source, but too probabilistic today

### DexScreener Fallback

Strengths:
- exact token-address lookup is good
- useful for exotic chain coverage

Weaknesses:
- only runs for missing, not weak, coverage
- observations are recorded before dedup outcome

Assessment:
- should evolve from “hole filler” into “coverage improver”

### CoinGecko Tickers Fallback

Strengths:
- essential for orderbook-native names that DEX APIs miss

Weaknesses:
- synthetic TVL, forced pair quality, and long assumed maturity are optimistic
- useful operationally, but not semantically clean

Assessment:
- keep the source, but model it as an explicit lower-honesty liquidity family

## Maintainability Audit

### Main Structural Problems

1. Pool contribution logic is duplicated across four places.
Files:
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/lib/dex-api-common.ts`

Symptoms:
- each path re-computes quality, balance, stress, protocol/chain aggregation, and pool shaping with slightly different defaults
- correctness improvements must be ported manually
- behavior drift is likely over time

2. `computeStablecoinScores()` is doing too much.
Evidence:
- `worker/src/cron/dex-liquidity/scoring.ts` 696 LOC

Responsibilities currently mixed together:
- per-coin filtering
- protocol cap application
- aggregate rebuilding
- top-pool shaping
- global deduping
- coverage classification
- final score assembly
- DEX price aggregation

Result:
- hard to reason about invariants
- hard to test one rule without invoking many others

3. `fetch-primary.ts` is too large and functionally mixed.
Evidence:
- 776 LOC

Responsibilities mixed:
- DeFiLlama fetch
- protocol-cap fetch
- Curve parse
- UniV3 subgraph
- Aerodrome subgraph
- chain-address construction
- pool identity bootstrap

Result:
- source-specific behavior is buried inside a broad orchestration file

4. Direct API result transport is brittle.
Evidence:
- `worker/src/lib/dex-api-common.ts:19-24`

Issue:
- `makeDexApiFetchResult()` attaches metadata onto an array via `Object.assign`

Why it is bad:
- non-obvious
- awkward to serialize/log
- easy to accidentally strip metadata with normal array operations

Recommendation:
- replace with `{ pools, ok, degraded, errors }`

### Best Mutualization Opportunities

1. Introduce a single normalized intermediate pool model.
Target:
- one “NormalizedLiquidityPool” built by every source adapter before merge/scoring

Benefits:
- one quality-calculation path
- one balance-measurement path
- one source-provenance model
- one persistence shape

2. Split adapters from scoring policy.
Suggested layers:
- source adapter
- normalization
- identity/dedup
- pool contribution engine
- scoring
- persistence

3. Centralize provenance flags.
Needed flags:
- `tvlMeasured`
- `volumeMeasured`
- `balanceMeasured`
- `maturityMeasured`
- `priceMeasured`
- `synthetic`
- `capped`
- `decayed`

This would let the module explain itself and support better row-level confidence.

## Testing Gaps

The module has good breadth of unit tests, but the highest-value missing tests are:

1. pagination truncation tests for GT and CoinGecko onchain
2. row-level confidence tests that distinguish:
- one direct API source
- multiple primary source families
- primary + fallback blend
- synthetic orderbook-only coverage
3. protocol-cap regression tests for legitimate direct-API-only liquidity
4. maturity-provenance tests for direct APIs vs staged pools vs orderbooks
5. ambiguous derived-identity tests for observation collapse
6. end-to-end fixture tests from raw source payloads to final `dex_liquidity` + `dex_prices`

## Remediation Themes

### Theme 1: Improve Recall Before More Scoring Tweaks

Highest-value work:
- bounded pagination for GT and CG onchain
- weak-partial fallback targeting
- explicit coverage/provenance telemetry

Reason:
- scoring improvements on incomplete pool sets have limited value

### Theme 2: Separate Measurement From Heuristic Defaults

Highest-value work:
- provenance flags for measured vs synthetic vs assumed fields
- conservative handling for unknown maturity and approximate volumes
- explicit orderbook semantics instead of pair-quality spoofing

Reason:
- today several heuristics are valid operational shortcuts but are encoded as if they were measured facts

### Theme 3: Unify Pool Contribution Logic

Highest-value work:
- one normalized pool schema
- one contribution engine
- smaller source adapters

Reason:
- this is the main maintainability unlock and will reduce future logic drift

### Theme 4: Make Confidence Honest

Highest-value work:
- replace `primary/mixed/fallback` confidence shortcut with a composite model
- incorporate source breadth, degradation, and measured-input coverage

Reason:
- trust semantics should reflect how the row was built, not just which family names appeared

## Recommended Planning Order

1. Coverage remediation
- GT/CG pagination
- weak-partial fallback targeting
- telemetry additions

2. Semantics remediation
- provenance flags
- direct-API maturity fix
- orderbook quality/maturity cleanup
- Fluid precision/volume cleanup

3. Architecture remediation
- replace array-with-metadata direct API result shape
- introduce normalized pool adapter boundary
- unify merge/contribution logic

4. Confidence remediation
- rebuild coverage-confidence model
- align historical filtering and trend baselines with new confidence semantics

## Final Assessment

The DEX liquidity module is not fragile, but it has reached the point where more iteration inside the current shape will get progressively more expensive and less reliable. The next gains are not from adding yet another source or another heuristic. They come from:

- recovering missed pools
- being stricter about what is measured versus assumed
- reducing duplicated contribution logic
- making confidence outputs match the true evidence quality

That combination will improve both Pharos’ pricing integrity and the long-term maintainability of the liquidity stack.
