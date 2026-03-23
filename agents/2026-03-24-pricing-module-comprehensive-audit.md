# Pricing Module Comprehensive Audit

Date: 2026-03-24

Scope:
- Live primary pricing selection in `worker/src/cron/enrich-prices.ts`
- Fallback enrichment in `worker/src/cron/enrich-prices-passes.ts`
- Publishability / trust / replay logic in `worker/src/cron/sync-stablecoins/pricing.ts`, `worker/src/cron/sync-stablecoins/post-enrichment.ts`, `worker/src/lib/depeg-helpers.ts`, `worker/src/lib/price-validation.ts`
- Source adapters in `worker/src/lib/cex-tickers.ts`, `worker/src/lib/pyth.ts`, `worker/src/lib/redstone.ts`, `worker/src/lib/curve-onchain.ts`, `worker/src/lib/geckoterminal-price-probe.ts`, `worker/src/lib/authoritative-price-sources.ts`, `worker/src/lib/cg-ticker.ts`
- Shared source policy / provenance surfaces in `shared/lib/pricing-source-registry.ts`, `worker/src/lib/pricing-types.ts`, `worker/src/lib/db-cache.ts`

Primary goals reviewed:
1. Accuracy and trustworthiness of published prices
2. Maintainability, clarity, and reduction of avoidable complexity

Verification:
- Read: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/pricing-pipeline.md`, `docs/pricing-pipeline-timeline.md`
- Ran pricing-focused regression slice:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/lib/__tests__/curve-onchain.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
```
- Result: 10 files passed, 225 tests passed

## Executive Summary

The pricing module is directionally strong. The major architectural choices are good:
- multi-source consensus instead of single-provider trust
- source registry and trust-tier modeling
- GT probe and pool challenge as secondary guards
- protocol redemption overrides for redeemable assets
- replay-safe cached continuity instead of blind stale publication

The remaining weaknesses are not in the general design. They are in the edges:
- freshness semantics are still weaker than they appear for several sources
- some source adapters are operationally brittle because they depend on manual venue coverage maps and local fetch time as freshness
- DEX-based hardening paths still use estimators that are less robust than the rest of the pipeline
- the implementation is concentrated in a few large files with repeated control-flow and repeated metadata plumbing

The result is a module that is much safer than a typical crypto pricing pipeline, but still harder than necessary to reason about, and still capable of publishing a technically valid but operationally misleading price when source freshness or market structure is ambiguous.

## What Is Already Good

- `shared/lib/pricing-source-registry.ts` is the correct direction. Source trust semantics are now much more centralized than before.
- `worker/src/lib/price-consensus.ts` uses fully pairwise clustering rather than transitive agreement chains.
- `worker/src/lib/redstone.ts` derives the published price from the venue median rather than the provider aggregate.
- `worker/src/lib/pyth.ts` preserves true upstream publish time and enforces a hard staleness gate.
- `worker/src/cron/sync-stablecoins/pricing.ts` now has temporal jump quarantine and severe-downside corroboration.
- `worker/src/lib/db-cache.ts` and `worker/src/cron/sync-stablecoins/post-enrichment.ts` preserve replay provenance and only persist replay-safe rows.

## High-Priority Findings

### P0. Freshness is still overstated for most market sources

Evidence:
- `worker/src/cron/enrich-prices.ts:243-245` sets CoinGecko `/simple/price` observation time to local fetch time
- `worker/src/cron/enrich-prices.ts:311-312`, `324-325`, `337-338`, `350-351`, `391-392`, `411` do the same for Binance, Kraken, Bitstamp, Coinbase, Curve on-chain, and Curve oracle
- `worker/src/cron/enrich-prices.ts:438-445` treats the current DefiLlama list price as a consensus source but has no source-native timestamp
- `worker/src/lib/geckoterminal-price-probe.ts:362-367` stamps GT probe results with local time

Why it matters:
- The system now distinguishes `priceObservedAt` from `priceSyncedAt`, but for many sources `priceObservedAt` is still really "time Pharos fetched it".
- Downstream trust classification relies on observation age, so these sources can look fresher than they truly are.
- This is especially material for depeg detection, because a delayed exchange ticker or cached aggregator response can still be treated as fresh enough to influence live state.

Assessment:
- Pyth and RedStone are in the good state.
- Most CEX, CoinGecko, GT probe, and Curve-derived sources are not.

Recommendation:
- Move to a per-source freshness contract:
  - true upstream timestamp when available
  - explicit `observedAtMode: "upstream" | "local_fetch" | "unknown"`
  - source-specific max age and trust downgrade when freshness is synthetic
- Depeg-authoritative paths should prefer sources with true upstream timestamps when available.

### P0. CEX coverage is manually curated and can silently drift

Evidence:
- `worker/src/lib/cex-tickers.ts:20-25`, `37-39`, `45-80` hardcode active markets and document them as manually verified on `2026-03-14`

Why it matters:
- The module treats these exchanges as hard market sources.
- Listing changes, delistings, symbol migrations, or alias changes will not self-heal.
- A newly listed market is invisible until code changes; a delisted market may keep stale assumptions in comments/tests until someone notices.

Recommendation:
- Add a source-capability discovery test or small admin audit that compares configured markets against the live exchange product surface.
- Keep the explicit mapping layer, but generate or validate it from a checked audit artifact instead of maintaining it as pure handwritten code.

### P0. CEX adapters use last-trade price without trade-age or market-state checks

Evidence:
- `worker/src/lib/cex-tickers.ts:102-108`, `149-155`, `182-189`, `225-229` accept positive `price` / `last` values directly

Why it matters:
- A stale last trade is not the same as a live executable market.
- For lightly traded stablecoin/USD books, the last print may be old, crossed, or tiny.
- These sources are classified as hard market inputs and can therefore dominate low-confidence selection or satisfy authoritative-source checks downstream.

Recommendation:
- Where the exchange API exposes it, consume trade timestamp and reject stale last prints.
- Prefer best bid/ask mid or validated ticker surfaces when available over bare last trade.
- At minimum, annotate each CEX adapter with whether it is `last_trade_only` and downgrade trust if no freshness field exists.

### P1. DEX hardening still uses estimators that can be improved

Evidence:
- `worker/src/lib/geckoterminal-price-probe.ts:37-75` selects one highest-TVL pool rather than a robust multi-pool estimate
- `worker/src/cron/enrich-prices.ts:679-695` replaces consensus with a TVL-weighted mean across all challenger pools once divergence spans 2 protocols

Why it matters:
- GT probe is meant to be an independent corrective signal, but one dominant pool is still one pool.
- Pool challenge replacement includes every qualifying pool once the trigger fires, not just the corroborating divergent subset. That can dilute or skew the replacement mark.

Recommendation:
- For GT probe, use a robust estimate over the top qualifying pools per protocol, then protocol-median or protocol-weighted median.
- For pool challenge replacement, compute the replacement price from the corroborating diverging protocols only, and prefer a weighted median over a weighted mean.

### P1. Price validation still allows very wide primary-authoritative bands before the higher-level guards run

Evidence:
- `worker/src/lib/price-validation.ts:379-420` accepts fixed-peg primary prices from `0` up to `2x` reference
- `worker/src/lib/price-validation.ts:423-462` does the same when only hardcoded bounds exist
- `worker/src/cron/sync-stablecoins/pricing.ts:84-122` and `129-181` add stronger guards later, but they live outside the base validator

Why it matters:
- The runtime is safe only because several layers compose correctly.
- The first-layer validator is still a permissive structural filter rather than a policy-grade validator.
- That is error-prone when new call sites are added later, because a caller can easily use `validatePriceCandidate()` and think it is sufficient.

Recommendation:
- Split the concepts explicitly:
  - `validateStructuralPriceBounds`
  - `evaluatePublishPolicy`
- Keep the wide structural validator if needed, but stop naming it like a full policy decision.

### P1. DefiLlama list price ingestion still lacks explicit provenance and freshness semantics

Evidence:
- `worker/src/cron/sync-stablecoins/pricing.ts:184-196` builds `dlListPrices` from the intake asset objects
- `worker/src/cron/enrich-prices.ts:438-445` injects that price as a consensus source using `asset.priceObservedAt ?? asset.priceUpdatedAt ?? null`

Why it matters:
- The DefiLlama stablecoins list is a current upstream input, but in code it is represented as "whatever price is already on the asset row".
- That makes provenance harder to reason about and couples intake representation to consensus representation.

Recommendation:
- Materialize a typed `DefiLlamaListQuote { price, observedAt, sourceDiagnostics }` object at intake time and pass that forward explicitly.

## Maintainability And Code-Quality Findings

### M0. The main pricing logic is still too concentrated in a few hotspot files

Current sizes:
- `worker/src/cron/enrich-prices.ts`: 907 LOC
- `worker/src/cron/enrich-prices-passes.ts`: 721 LOC
- `worker/src/lib/price-validation.ts`: 604 LOC
- `worker/src/cron/sync-stablecoins/pricing.ts`: 503 LOC
- `worker/src/lib/geckoterminal-price-probe.ts`: 411 LOC
- `worker/src/lib/authoritative-price-sources.ts`: 376 LOC

Why it matters:
- The code is understandable if you already know the system, but it is not cheap to modify safely.
- Too much behavior is coupled inside monolithic orchestration functions.
- Review cost and regression risk stay high even for small pricing changes.

Recommendation:
- Treat hotspot reduction as a first-class remediation objective, not a nice-to-have.

### M0. `fetchPrimaryPrices()` mixes five different concerns

Evidence:
- `worker/src/cron/enrich-prices.ts` handles:
  - candidate eligibility
  - source fetch orchestration
  - circuit-breaker outcome accounting
  - source-to-candidate normalization
  - consensus and post-consensus hardening

Why it matters:
- This is the single biggest maintainability problem in the pricing module.
- It is difficult to change one source without re-reading unrelated logic.

Recommendation:
- Refactor into:
  - `collectPrimarySourceQuotes()`
  - `buildConsensusCandidatesForAsset()`
  - `selectPrimaryConsensus()`
  - `applySoftSourceHardening()`

### M1. Source policy is more centralized than before, but the weight model still leaks into orchestration

Evidence:
- Registry defines `defaultWeight`: `shared/lib/pricing-source-registry.ts:10-22`, `25+`
- `worker/src/cron/enrich-prices.ts:435-480` hardcodes source weights inline anyway
- `worker/src/cron/enrich-prices.ts:427` adds a separate `DEX_API_WEIGHTS` map
- `worker/src/cron/enrich-prices.ts:764` only GT reprobe reuses `getSourceDefaultWeight()`

Why it matters:
- Trust, replay safety, GT eligibility, and pool-challenge exemption are centralized.
- Weights, which are equally methodology-significant, are not.
- That leaves room for silent drift between the registry, docs, and runtime.

Recommendation:
- Make runtime source weights registry-driven for every source, including promoted DEX protocol sources.
- Keep only truly dynamic weight adjustments outside the registry, such as Pyth confidence-derived downweighting.

### M1. Price metadata is represented in too many partially overlapping types

Evidence:
- `worker/src/lib/pricing-types.ts:3-17`
- `worker/src/lib/db-cache.ts:44-53`
- `worker/src/cron/enrich-prices.ts:61-78`
- `worker/src/cron/enrich-prices-shared.ts:13-30`

Why it matters:
- The same fields recur repeatedly: `source`, `confidence`, `observedAt`, `syncedAt`, `agreeSources`, `consensusSources`, diagnostics
- This increases the chance of partial propagation bugs and forces repeated conversion code.

Recommendation:
- Introduce one internal canonical type such as:
```ts
interface SelectedPrice {
  price: number;
  meta: PriceMetadata;
}
```
- Use adapters at the boundaries rather than field-by-field copies across the pipeline.

### M1. Validation is executed repeatedly across the pipeline

Evidence:
- `worker/src/cron/sync-stablecoins/pricing.ts:313-320` validates when applying primary prices
- `worker/src/cron/sync-stablecoins/pricing.ts:364-376` validates again in `prevalidatePrices()`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts:107-129` validates again before cache write
- `worker/src/cron/sync-stablecoins/post-enrichment.ts:177-187` validates replay fallback again

Why it matters:
- The multiple passes are defensible for safety, but the implementation is not explicit about which validations are intended to be idempotent and which are stage-specific.
- This adds branching and repeated plumbing.

Recommendation:
- Convert validation into explicit stage functions:
  - `validatePrimaryCandidate`
  - `validatePublishedAssetPrice`
  - `validateReplayCandidate`
- Keep shared policy helpers under them.

### M1. Fallback enrichment still mutates shared assets in place

Evidence:
- `worker/src/cron/enrich-prices-passes.ts` mutates the shared `assets` array directly in every pass

Why it matters:
- Mutation makes the pass order part of the data contract.
- It also forces each pass to care about previous pass side effects instead of returning explicit candidate results.

Recommendation:
- Keep sequential execution, but make each pass return `ResolvedFallbackQuote[]`, then merge centrally.
- This will improve testability and make pass diagnostics richer.

## Source-By-Source Notes

### CoinGecko `/simple/price`

Strengths:
- batched
- independent soft aggregator voice

Weaknesses:
- no true upstream timestamp in runtime model
- no provider freshness metadata used
- local fetch time becomes apparent observation time

### CoinGecko ticker extraction

Strengths:
- good targeted workaround for Kinesis-style aggregator noise

Weaknesses:
- narrow bespoke source
- still no true upstream timestamp
- pool/market selection is highest volume only; no spread sanity despite spread fields being available in payload

### DefiLlama stablecoins list

Strengths:
- independent from the removed DL coins mirror misuse

Weaknesses:
- implicit provenance in code
- no explicit observed-time semantics
- current quote is represented indirectly via the intake asset row

### Pyth

Strengths:
- best freshness semantics in the module
- confidence-aware weighting
- normalized feed IDs and hard staleness gate

Weaknesses:
- no major structural issue found in current implementation

### Binance / Kraken / Bitstamp / Coinbase

Strengths:
- explicit market mappings avoid unsafe symbol guessing

Weaknesses:
- coverage is hand-maintained
- adapters consume last trade only
- no trade-age or market-state validation
- freshness is synthetic local fetch time

### RedStone

Strengths:
- venue median, venue agreement, timestamp gate, exact-case mapping, batch+solo retry

Weaknesses:
- symbol allowlist is hand-maintained
- provider-specific support changes still require code changes

### Curve on-chain / Curve oracle

Strengths:
- strong independent on-chain/protocol voice
- explicit curated configs

Weaknesses:
- freshness is local RPC fetch time
- no per-config health metadata beyond success/failure
- reliability of a 1-unit `get_dy` quote is assumed rather than characterized per pool

### Promoted DEX / challenger pools / GT probe

Strengths:
- good defense-in-depth conceptually
- independent DEX corroboration is correctly treated as softer than hard oracles/markets

Weaknesses:
- GT probe is single-pool best-of-book logic
- pool challenge replacement estimator can be more robust
- DEX logic is spread across several modules and storage representations, increasing cognitive load

### CoinMarketCap / Jupiter / DexScreener fallback

Strengths:
- bounded, best-effort, peg-aware validation, uniqueness rules

Weaknesses:
- all use local observation time
- CMC is intentionally throttled to once per hour, which is fine operationally but means it is a coarse fallback rather than a live corroborator
- DexScreener path still contains the most complicated matching logic in the module

### Protocol redemption overrides

Strengths:
- correct conceptual treatment for executable redeem value
- historical replay support is strong

Weaknesses:
- implementation is provider-by-provider bespoke; this will become unwieldy as more assets are added

## Mutualization / LOC Reduction Opportunities

### 1. Replace repeated source-fetch boilerplate with a source adapter executor

Target:
- `worker/src/cron/enrich-prices.ts`

Current repetition:
- fetch
- parse
- write to result map
- synthesize observedAt
- record breaker outcome
- log failures

Proposed shape:
```ts
interface PrimarySourceAdapter<TQuote> {
  key: PricingSourceKey;
  enabled(input): boolean;
  fetch(input): Promise<Map<string, TQuote>>;
  toSourcePrice(asset, quote): SourcePrice | null;
}
```

Expected win:
- lower LOC
- less drift across sources
- simpler addition of new providers

### 2. Introduce a canonical `ObservedQuote` / `SelectedPrice` model

Target:
- `enrich-prices.ts`
- `pricing.ts`
- `db-cache.ts`
- `enrich-prices-shared.ts`

Expected win:
- remove field-copying glue
- make provenance propagation much harder to get wrong

### 3. Turn fallback passes into data-returning resolvers

Target:
- `worker/src/cron/enrich-prices-passes.ts`

Expected win:
- make pass composition explicit
- simplify testing
- enable richer pass diagnostics without mutating the shared asset array

### 4. Make source weights fully registry-driven

Target:
- `shared/lib/pricing-source-registry.ts`
- `worker/src/cron/enrich-prices.ts`

Expected win:
- eliminate duplicated methodology constants
- align docs, runtime, status, and testing around one source of truth

### 5. Separate structural bounds from publish policy

Target:
- `worker/src/lib/price-validation.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`

Expected win:
- clearer contracts
- fewer accidental misuse paths
- easier future remediation of source-aware publish thresholds

### 6. Consolidate manual symbol/market maps into audited config

Target:
- `worker/src/lib/cex-tickers.ts`
- `worker/src/lib/redstone.ts`

Expected win:
- keep explicit mappings, but move them out of the fetch logic
- allow automated validation and easier review

## Recommended Remediation Workstreams

### Workstream 1: Freshness integrity

Do first.

Deliverables:
- per-source freshness modes
- true upstream timestamps where available
- downgrade rules for synthetic-local freshness
- status surfacing that distinguishes upstream freshness from fetch freshness

### Workstream 2: Source adapter refactor

Do second.

Deliverables:
- adapter executor for primary sources
- registry-driven weights
- reduced `fetchPrimaryPrices()` size

### Workstream 3: DEX hardening estimator upgrade

Do third.

Deliverables:
- robust GT multi-pool estimator
- robust pool-challenge replacement estimator
- clearer per-protocol challenger aggregation

### Workstream 4: Validation simplification

Do fourth.

Deliverables:
- separate structural validation from publish policy
- explicit validation stage APIs
- reduced repeated validation glue

### Workstream 5: Config auditability

Do alongside or immediately after Workstream 2.

Deliverables:
- audited exchange market config
- audited RedStone symbol support config
- small test or admin audit flow that proves config still matches live provider capabilities

## Bottom Line

The current pricing module is not fundamentally broken. It is already thoughtful and materially safer than most comparable stablecoin pricing pipelines.

The next step is not another broad algorithm rewrite. The next step is to harden the remaining edge cases and reduce the complexity tax:
- make freshness semantics honest
- reduce manual venue drift risk
- make DEX corrections more robust
- refactor the orchestration so source behavior is easier to change safely

That combination will improve both of the stated goals at the same time:
- better price accuracy under stress and ambiguity
- a pricing module that is easier to maintain, review, and extend
