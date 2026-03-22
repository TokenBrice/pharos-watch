# Pricing Module Audit

Date: 2026-03-22

Scope:
- Live stablecoin pricing selection in `worker/src/cron/sync-stablecoins.ts`
- Primary consensus in `worker/src/cron/enrich-prices.ts`
- Fallback enrichment in `worker/src/cron/enrich-prices-passes.ts`
- Validation, publication, cache replay, and downstream depeg trust
- DEX price bridge / challenger generation in `worker/src/cron/dex-liquidity/*` and `worker/src/lib/dex-api-common.ts`
- Source adapters: CoinGecko, DefiLlama list / contract, Pyth, Binance, Kraken, Bitstamp, Coinbase, RedStone, Curve on-chain, GeckoTerminal probe, CoinMarketCap, Jupiter, DexScreener, protocol redemption

Verification:
- Pricing-focused test slice passed: 16 files, 254 tests
- Command run:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/lib/__tests__/curve-onchain.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts worker/src/cron/__tests__/dex-api-common.test.ts worker/src/cron/__tests__/challenger-persistence.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-fallbacks.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts
```

## Executive Summary

The module is materially stronger than a typical ad hoc price pipeline. The consensus model, DEX bridge suppression work, GT probe, protocol-redeem overrides, and price validation layer all move in the right direction.

The remaining problem is not lack of sophistication. It is that several weak-path outcomes are still allowed to publish and then become authoritative downstream. The current design still has too many ways for a wrong price to survive when it is:
- single-source
- low-confidence but still inside a very wide 0x-2x band
- derived from a DEX path that reuses previously published stablecoin prices
- insufficiently challenged by large-pool evidence

That means the module can still fail in exactly the class of incident you care about: a bad price that is internally “valid enough” to be published, then trusted by depeg logic, UI, and any downstream reuse.

## Highest-Priority Findings

### P0. Single-source prices are still treated as authoritative by depeg detection

Evidence:
- `worker/src/lib/depeg-helpers.ts:177-187`

Why it matters:
- `single-source` is a display confidence bucket, but downstream it is currently trusted the same as `high`.
- A single CoinGecko print, single DefiLlama-list print, single Curve config, or single hard-source bug can open or close depegs without secondary confirmation.
- This is the most important downstream trust mismatch in the current system.

Impact:
- False depeg opens/closes remain possible even after the recent DEX hardening work.

Recommendation:
- Split trust into source-aware tiers, not just confidence labels.
- At minimum:
  - soft single-source (`coingecko`, `defillama-list`, `geckoterminal`, `dex-promoted`) => `confirm_required`
  - fallback / cached / low => `confirm_required`
  - hard single-source (`pyth`, selected CEX, validated `curve-onchain`, `protocol-redeem`) => optionally authoritative, but only with tighter extreme-move guards

### P0. Pool challenge coverage is materially narrower than the code and docs imply

Evidence:
- Expected challenge threshold is `$100K`: `worker/src/lib/constants.ts:164-165`
- Published challenger snapshots currently retain only `$1M+` pools: `worker/src/cron/dex-liquidity/orchestrator.ts:563-568`
- Snapshot completeness is global all-or-nothing, not per-coin: `worker/src/cron/dex-liquidity/orchestrator.ts:560-562`

Why it matters:
- The live pricing path and pending depeg confirmation ask for `$100K` challengers.
- In published mode they only receive pools that survived a `$1M` publication gate.
- A single failed critical DEX source prevents snapshot publication for every coin, even when most coins still have usable challenger coverage.

Impact:
- Large-pool correction is weaker than intended.
- Challenge behavior changes depending on whether the system is using published snapshots or legacy fallback.
- Soft wrong prices can survive simply because the challenger publication path withheld usable pools.

Recommendation:
- Align challenger publication threshold with `POOL_CHALLENGE_MIN_TVL`.
- Make coverage completeness per stablecoin, not global.
- Persist publication diagnostics per coin so the pricing path knows when it is challenging against partial evidence.

### P0. Weak soft-source outcomes still bypass both GT probing and pool challenge

Evidence:
- Pool challenge only runs on `high` consensus results: `worker/src/cron/enrich-prices.ts:542-544`
- GT probe only runs when `primary.confidence === "single-source"` and `candidateSources.length === 1`: `worker/src/cron/enrich-prices.ts:615-620`

Why it matters:
- `CG + DL-list` results that are downgraded to `single-source` still have `candidateSources.length === 2`, so they are not GT-probed.
- Any `low` soft result is not challenged by large pools at all.
- This leaves a blind spot exactly where the system is already telling us “sources disagree”.

Impact:
- The module has strong defenses for some weak paths, but not for all weak paths.
- This is the biggest remaining “grave mistake” surface after the recent USR fix.

Recommendation:
- Extend the large-pool challenge to all soft outcomes, not just `high`.
- Extend GT probing or an equivalent secondary pool check to:
  - downgraded `CG + DL-list` results
  - selected `low` soft-source results
  - extreme soft-source moves even when confidence is not `single-source`

### P0. The DEX bridge still has a feedback-loop risk through cached stablecoin prices

Evidence:
- DEX liquidity loads any positive stablecoin cache price with no confidence or staleness gating: `worker/src/cron/dex-liquidity/orchestrator.ts:131-137`
- Direct-API quote conversion prefers those tracked prices whenever the counterparty is a tracked stablecoin: `worker/src/lib/dex-api-common.ts:186-190`

Why it matters:
- Yesterday’s published stablecoin price can become today’s quote leg for DEX observations.
- Those DEX observations then feed `dex_prices`.
- `dex_prices` then re-enters primary pricing as promoted DEX sources.

Impact:
- The module can self-reinforce a bad prior price through the DEX bridge.
- This is especially dangerous for stablecoin-vs-stablecoin pools and for exactly the class of symbol/address confusion that caused recent incidents.

Recommendation:
- Only reuse tracked stablecoin prices when they are:
  - fresh
  - `high`
  - from an allowed trust tier
- Otherwise fall back to peg reference, explicit trusted quote assets, or “do not derive”.
- Persist and expose whether a DEX observation used a tracked-price quote leg.

### P0. Source observation time is discarded and replaced with sync time

Evidence:
- Pyth already has true `publish_time`: `worker/src/lib/pyth.ts:87-90`
- Fallback prices default to `Date.now()` at mutation time: `worker/src/cron/enrich-prices-shared.ts:35-45`
- Primary results are stamped with `syncStartSec`, not source observation time: `worker/src/cron/sync-stablecoins/pricing.ts:162-164`

Why it matters:
- `priceUpdatedAt` currently means “Pharos sync write time”, not “upstream observation time”.
- Downstream freshness trust uses that field in `classifyPrimaryDepegTrust()`.
- A stale upstream print can therefore look fresh to downstream logic.

Impact:
- Freshness is overstated.
- Source-specific staleness protections exist at fetch time for some sources, but they are lost after aggregation and publication.

Recommendation:
- Carry `observedAt` through every source adapter and consensus result.
- Preserve both:
  - `sourceObservedAt`
  - `pharosSyncedAt`
- Base depeg trust on source observation age, not cache write age.

### P1. Publication bounds are still too wide for weak paths

Evidence:
- Primary-authoritative validation allows `0` to `2x` reference: `worker/src/lib/price-validation.ts:379-420`
- Severe publication guard only applies below the 50% downside threshold: `worker/src/cron/sync-stablecoins/pricing.ts:69-85`

Why it matters:
- A fixed-peg asset at `$1.05`, `$1.12`, or `$1.49` is still publishable if it survives consensus.
- A downside at `$0.51` is still publishable without the special corroboration rule.
- This is too permissive for soft sources, fallback sources, and single-source outputs.

Impact:
- Wrong but “not quite catastrophic enough” prices still get published.

Recommendation:
- Add symmetric extreme-move corroboration for both upside and downside.
- Use tighter, source-aware publish thresholds:
  - soft single-source / fallback / cached: require corroboration above a peg-aware deviation band
  - hard sources may keep wider bands, but not the same band as search-derived fallbacks

### P1. Low-confidence consensus still collapses to “highest-weight wins”

Evidence:
- `computePriceConsensus()` chooses a single source when no 2+ cluster exists: `worker/src/lib/price-consensus.ts:82-89`
- `pickBestSource()` prefers highest weight before peg proximity: `worker/src/lib/price-consensus.ts:237-241`

Why it matters:
- When sources disagree materially, the output is not a robust aggregate. It is whichever single source carries the highest weight.
- This is how a lone weighted source can dominate a low-confidence outcome.

Impact:
- Low confidence is not just a warning label. It is a selection regime that can still publish a bad single source.

Recommendation:
- For `low` outcomes, switch from “highest-weight source” to one of:
  - weighted median constrained by source class
  - closest-to-reference among allowed hard sources
  - no publication unless corroborated when deviation is above a peg-aware band

### P1. There is still no temporal jump quarantine

Evidence:
- The only stateful price sanity check compares against unchanged prices to detect staleness: `worker/src/cron/sync-stablecoins/stages.ts:233-258`

Why it matters:
- The module has a staleness detector, but not a sudden-move detector.
- A weak new print can jump far from the prior accepted price and still publish if it is inside the current wide validation corridor.

Impact:
- The system has no “this is too different from the last trusted price to publish immediately” safety net.

Recommendation:
- Add a stateful quarantine layer keyed by previous accepted price and previous trust tier.
- Example policy:
  - if move > X bps and new trust tier is weaker than previous tier, hold, downgrade, or require confirmation
  - always alert on large source-family changes plus large price moves

## Secondary Findings

### P1. Enrichment passes 2-4 still fail as one coupled block

Evidence:
- `worker/src/cron/enrich-prices.ts:735-786`

Why it matters:
- A throw in CMC can suppress Jupiter and DexScreener.
- This is a reliability loss, not just a code-style issue.

Recommendation:
- Isolate pass execution and failure accounting per source.
- Return richer per-pass diagnostics instead of one `passes-2-4` bucket.

### P1. The replay cache drops all provenance

Evidence:
- `worker/src/lib/db-cache.ts:43-60`

Why it matters:
- `price_cache` stores only `{ asset_id, price, updated_at }`.
- Replayed prices lose their original source, confidence, and observation time.

Recommendation:
- Store source, confidence, observedAt, syncedAt, and maybe source family.
- Only replay entries that still satisfy replay-safety rules at replay time.

### P1. RedStone still trusts the provider aggregate instead of deriving from the venue breakdown

Evidence:
- Venue agreement is measured against `entry.value`: `worker/src/lib/redstone.ts:150-156`
- The published result price is also `entry.value`: `worker/src/lib/redstone.ts:161-166`

Why it matters:
- The venue breakdown is available, but the module does not derive its own robust price from it.
- If the aggregate is wrong while venues are sane, the module still uses the aggregate.

Recommendation:
- Compute a venue median or trimmed mean from `entry.source`.
- Compare the provider aggregate to the venue-derived price and reject if they diverge materially.

### P1. Source policy is scattered across too many files

Evidence:
- Pool challenge / GT / replay safety sets: `worker/src/lib/pricing-source-policy.ts:3-39`
- Labels / health buckets: `shared/lib/pricing-sources.ts:1-82`
- Depeg trust mapping: `worker/src/lib/depeg-helpers.ts:177-187`
- Source weights and promoted DEX admission: `worker/src/cron/enrich-prices.ts`
- Publication semantics: `worker/src/cron/sync-stablecoins/pricing.ts`

Why it matters:
- Source behavior is currently encoded as string comparisons in multiple locations.
- This increases drift risk every time a source is added or semantics change.

Recommendation:
- Replace stringly-distributed source policy with one canonical source registry:
  - weight
  - trust tier
  - replay-safe?
  - GT-eligible?
  - pool-challenge exempt?
  - can be depeg-authoritative?
  - expected timestamp semantics

### P2. The DEX bridge aggregate collapses protocol observations too aggressively

Evidence:
- Protocol aggregation is by protocol, not protocol+chain, and stores a single median plus total TVL: `worker/src/cron/dex-liquidity/scoring.ts:279-309`

Why it matters:
- A cross-chain protocol can produce one promoted source even when only one chain is bad.
- The primary pricing path no longer sees which chain drove the protocol median.

Recommendation:
- Persist richer protocol-source diagnostics:
  - chain breakdown
  - source-family breakdown
  - whether tracked-price quote legs were used
  - observation count and TVL concentration

### P2. Primary result diagnostics are not persisted deeply enough

Evidence:
- Published primary result only keeps `candidateSources` and `agreeSources`: `worker/src/cron/enrich-prices.ts:454-461`

Why it matters:
- The consensus engine already computes richer data (`allPrices`, `disagreeSources`), but it is mostly dropped.
- When a bad price appears, operators cannot see the full source matrix from the published state.

Recommendation:
- Persist a per-asset source matrix to a dedicated diagnostics table or detailed cron metadata payload.

### P2. Manual source coverage registries are still drift-prone

Evidence:
- CEX pair allowlists are hardcoded with hand-verified comments: `worker/src/lib/cex-tickers.ts:20-72`
- RedStone coverage is a manual exact-case allowlist + symbol map: `worker/src/lib/redstone.ts:21-68`

Why it matters:
- These lists will drift silently unless actively audited.

Recommendation:
- Add source-registry verification tests or smoke checks that compare the configured universe against live exchange / provider metadata.

### P3. The `geckoId.includes("wrong")` sentinel is a code smell

Evidence:
- `worker/src/cron/enrich-prices.ts:120`

Why it matters:
- Invalid metadata is being represented as a magic substring, not typed metadata.

Recommendation:
- Replace with explicit metadata flags in the tracked registry.

## Source-by-Source Audit

### CoinGecko simple price

Current strengths:
- Broad coverage
- Fast
- Strong primary voice

Weaknesses:
- No per-asset freshness carried into the published result
- Can still become downstream-authoritative when single-source
- Large soft moves are not quarantined

Best next improvements:
- Fetch and store `last_updated_at` where available
- Downgrade trust of CG-only results in depeg logic
- Add previous-price jump guard

### DefiLlama stablecoins list

Current strengths:
- Independent aggregator voice
- Already treated more honestly than `coins.llama.fi`

Weaknesses:
- Same freshness problem as CG in the published result
- `CG + DL-list` downgraded results still miss GT probing and pool challenge expansion
- The list price still enters the system as a raw candidate even when other evidence is weak

Best next improvements:
- Carry source timestamp if DL exposes one
- Route downgraded `CG + DL-list` cases into secondary checks

### Pyth

Current strengths:
- Freshness gate
- Confidence interval gate

Weaknesses:
- Publish-time metadata is discarded after fetch
- Absolute “hard source” treatment downstream is too broad if a config/feed is wrong

Best next improvements:
- Preserve `publish_time`
- Add source-specific config sanity tests for each mapped feed

### Binance / Kraken / Bitstamp / Coinbase

Current strengths:
- Independent market venues
- Pair mappings are explicit, not string-sliced

Weaknesses:
- Coverage is manually curated
- Drift risk is operational, not enforced by tests
- Single-source venue prints can still become downstream-authoritative

Best next improvements:
- Add mapping verification tests against live product metadata
- Fold venue capabilities into a canonical source registry

### RedStone

Current strengths:
- Freshness gate
- Venue-count and venue-agreement gate

Weaknesses:
- Uses the provider aggregate as the final price even though venue detail is available
- Manual allowlist / case map drift risk

Best next improvements:
- Derive a robust venue-based price locally
- Persist venue diagnostics for auditability

### Curve on-chain / Curve oracle

Current strengths:
- Strong independent signal
- On-chain, not aggregator-scraped

Weaknesses:
- Still treated as absolutely exempt from pool challenge
- Any pool-config / hop misconfiguration would be highly trusted

Best next improvements:
- Add config-level invariant tests per configured pool
- Add “hard-source disagreement” alerting even when price is retained

### GeckoTerminal probe

Current strengths:
- Independent pool-level cross-check
- Good transport fallback and breaker semantics

Weaknesses:
- Only applied to the narrowest single-source shape
- Does not cover downgraded `CG + DL-list` or low-confidence soft results

Best next improvements:
- Expand eligibility to more weak-result classes

### DEX promoted / direct API bridge

Current strengths:
- Recent hardening closed the exact USR-style uncorroborated promoted-DEX failure mode
- Identity matching is better than before

Weaknesses:
- Still circular through cached tracked stablecoin quote legs
- Snapshot publication threshold/completeness weakens the challenge system
- Protocol aggregation hides chain/source-family detail

Best next improvements:
- Confidence-gate tracked quote prices
- Align challenger publication with challenge consumption
- Persist richer DEX-source provenance

### CoinMarketCap / Jupiter / DexScreener fallback enrichment

Current strengths:
- Best-effort hole filling
- Peg-aware reasonableness validation exists

Weaknesses:
- Weak paths are still publishable inside very wide corridors
- Passes are still failure-coupled
- Fallback results can still become the visible current price too easily

Best next improvements:
- Stronger source-aware publish gating
- Per-pass isolation
- Better provenance retention

### Protocol redemption overrides

Current strengths:
- Best current source family for redeemable assets
- Applied after market consensus so they stay authoritative

Weaknesses:
- Source observation metadata is still flattened into sync time
- There is limited market-vs-redemption observability

Best next improvements:
- Preserve quote timestamp / block context
- Emit explicit divergence diagnostics when redemption and market are far apart

## Maintainability Audit

Hotspots:
- `worker/src/cron/enrich-prices.ts` — 788 LOC
- `worker/src/cron/enrich-prices-passes.ts` — 721 LOC
- `worker/src/lib/price-validation.ts` — 604 LOC
- `worker/src/cron/dex-liquidity/orchestrator.ts` — 622 LOC
- `worker/src/cron/dex-liquidity/scoring.ts` — 696 LOC
- `worker/src/lib/dex-api-common.ts` — 483 LOC

Main code-quality concerns:
- Source behavior is encoded by string comparisons in multiple modules.
- Fetch, validation, selection, publication, replay, and downstream trust are not driven by one shared model.
- Similar concepts exist in several forms:
  - source labels
  - source weights
  - source trust
  - replay safety
  - challenge exemption
  - depeg authority
  - GT probe eligibility
- The DEX bridge stack is especially fragmented across `orchestrator.ts`, `scoring.ts`, `dex-api-common.ts`, `fetch-primary.ts`, and `fetch-fallbacks.ts`.

Best structural cleanup opportunities:
- Introduce a canonical `pricing source registry`.
- Introduce a first-class `ObservedPrice` shape carrying:
  - `source`
  - `price`
  - `observedAt`
  - `confidence`
  - `trustTier`
  - `sourceFamily`
  - optional raw diagnostics
- Refactor publication validation around source trust tier instead of just `high` / `single-source` / `low` / `fallback`.
- Refactor enrichment passes to run through a uniform adapter interface with isolated errors and uniform metrics.
- Collapse duplicate validation logic in `price-validation.ts`.

## Proposed Remediation Workstreams

### Workstream 1: Downstream trust hardening

Goal:
- Stop weak prices from becoming depeg-authoritative.

Actions:
- Rework `classifyPrimaryDepegTrust()` to be source-aware.
- Distinguish soft single-source from hard single-source.
- Make cached / fallback / low always require confirmation.

### Workstream 2: Weak-path publication quarantine

Goal:
- Prevent obviously dangerous prices from publishing even if they are inside the current wide validation band.

Actions:
- Add symmetric extreme-move corroboration.
- Add previous-price jump guard.
- Expand GT / pool challenge to weak soft outcomes.

### Workstream 3: DEX bridge decoupling

Goal:
- Break self-reinforcing price loops.

Actions:
- Confidence-gate `stablecoinPriceById` reuse.
- Persist quote-leg provenance.
- Align challenger publication threshold with consumption threshold.
- Make challenger completeness per coin.

### Workstream 4: Source timestamp and diagnostics propagation

Goal:
- Make freshness real and incidents debuggable.

Actions:
- Preserve `sourceObservedAt`.
- Keep full source matrices for primary results.
- Preserve replay-cache provenance.

### Workstream 5: Source policy mutualization

Goal:
- Reduce drift and hotspot complexity.

Actions:
- Replace scattered string-based policy with one canonical registry.
- Move source capabilities, trust, and replay semantics out of ad hoc conditionals.

## Suggested Implementation Priority

1. Change depeg trust so soft single-source is no longer authoritative.
2. Align challenger publication with challenger consumption and remove the global all-or-nothing completeness gate.
3. Add extreme-move + previous-price quarantine for weak paths.
4. Confidence-gate cached tracked stablecoin quote-leg reuse in DEX pricing.
5. Preserve source observation timestamps and replay provenance.
6. Expand GT / pool challenge coverage to more weak-result classes.
7. Refactor source policy into one registry.

## Bottom Line

The current system is no longer “naive”, but it is still too permissive when confidence is weak and too trusting once a price has been published once. The next iteration should focus less on adding more sources and more on changing publication and downstream trust semantics so weak evidence cannot become authoritative without corroboration.
