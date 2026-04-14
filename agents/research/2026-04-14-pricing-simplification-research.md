# Pricing Simplification Research

Date: 2026-04-14

Target: complexity audit item 1, pricing validation/publication and post-enrichment policy.

## Scope

Primary files:

- `worker/src/lib/price-validation.ts`
- `worker/src/lib/price-publish-policy.ts`
- `worker/src/lib/price-consensus.ts`
- `worker/src/lib/primary-price-collector.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `worker/src/cron/sync-stablecoins/shared.ts`

Docs reviewed:

- `docs/pricing-pipeline.md`
- `docs/pricing-pipeline-timeline.md`

## Current Behavior Map

The pricing path is not one module; it is a chain of partially overlapping policy layers:

1. `fetchPrimaryPrices()` loads source availability, fetches CoinGecko, CG tickers, Pyth, CEX venues, RedStone, Curve, DEX bridge rows, and DL-list quotes.
2. `buildPrimarySourceCandidates()` turns the per-provider maps into uniform `SourcePrice[]`, including Pyth weight adjustment, RedStone venue gating, promoted DEX corroboration, and DEX aggregate overlap suppression.
3. `computePriceConsensus()` builds maximal pairwise-agreement clusters and returns the cluster median plus selected-source provenance.
4. `applyPrimaryPriceResults()` mutates each `PeggedAsset` with accepted primary consensus or stamps existing DL-list prices.
5. `prevalidatePrices()` clears prices that fail publication policy before fallback enrichment.
6. `runMissingPriceEnrichmentPhase()` mutates assets missing prices through DL contract, CMC, Jupiter, and DexScreener fallback passes.
7. `runSharedPriceCompletion()` applies authoritative protocol overrides and then runs `runPostEnrichmentPricePipeline()`.
8. `runPostEnrichmentPricePipeline()` applies native-peg fills/corrections, rejects unreasonable prices, writes replay-safe `price_cache`, and rehydrates still-missing assets from replay cache.
9. `validateAndWriteStablecoinsCache()` writes the normalized stablecoins payload.

The external output is simple: `price`, `priceSource`, `priceSelectedSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, `priceUpdatedAt`, `consensusSources`, and `agreeSources` on each asset.

## Why This Is A Good Simplification Target

The code is not obviously wrong. The problem is that the "can this price publish?" decision is split across:

- reference construction and peg classification in `price-validation.ts`
- severe downside and temporal-jump rules in `price-publish-policy.ts`
- source authority semantics in `pricing-source-policy.ts` / `pricing-source-registry.ts`
- consensus and selected-source provenance in `price-consensus.ts`
- repeated mutation/stamping in `pricing.ts` and `post-enrichment.ts`

That makes small pricing changes expensive because a maintainer has to simulate the same asset across several mutation passes.

## Invariants To Preserve

Do not change these in a first remediation tranche:

- `computePriceConsensus()` must keep pairwise agreement semantics. Do not replace it with transitive clustering unless the chain-agreement regression remains protected.
- High-confidence consensus publishes the cluster median and keeps selected-source provenance separately.
- `coingecko + defillama-list` two-source agreement is downgraded to `single-source`.
- Fallback enrichment must not overrule a good primary consensus price.
- Protocol/redeem overrides must run after GT probe and remain final when accepted.
- Native-peg implied quotes are live fallback-validation lane only; they must not be written into replay cache.
- Replay cache must stay limited to replay-safe sources and must not store `low` or `fallback` prices.
- Severe fixed-peg downside requires hard source, 2+ agreeing sources, previous trusted severe downside, or 2+ independently severe candidate prices.
- Weak fixed-peg temporal jumps against previous trusted price must stay quarantined.
- Stamping semantics in `stampPriceMetadata()` must remain compatible:
  - `priceUpdatedAt = observedAt ?? syncedAt ?? null`
  - `priceSyncedAt = syncedAt ?? observedAt ?? null`
  - `consensusSources` and `agreeSources` only change when explicitly provided.
- Missing prices should serialize as explicit missing state, not invalid payload rows.

## Proposed Research Conclusion

The best first remediation is not a provider-adapter split. Start with a decision/finalization boundary:

1. Add one pure publication decision layer:
   - input: `{ price, source, confidence, agreeSources, candidatePrices, validationContext, validationReferences, previousTrustedPrice, mode }`
   - output: `{ accepted, reason, referenceType, referencePrice, candidateRatio, boundsUsed, gates: string[] }`
   - internally call the current reference-band, severe-downside, and temporal-jump logic.
   - goal: one entrypoint for publish eligibility; not a methodology change.
2. Add one price finalizer helper:
   - input: `asset`, accepted candidate, `syncStartSec`, and optional selected source
   - output: mutates `PeggedAsset` in exactly one place, via `stampPriceMetadata()`
   - clearing rejected prices should also route through one helper wrapping `clearPriceMetadata()`.
3. Only after that, consider provider source collection:
   - `fetchPrimaryPrices()` can be split into `fetchPrimarySourceMaps()` and `buildConsensusResults()`.
   - Keep provider transport functions and circuit breaker calls intact at first.

This sequence cuts the mental model first and avoids rewriting all provider fetch paths at once.

## Suggested File Touch Plan

Tranche A, policy finalization only:

- `worker/src/lib/price-publish-policy.ts`
  - expose a richer internal decision type without changing public wrappers.
  - consolidate `validatePrimaryPriceCandidate()`, `validateFallbackPriceCandidate()`, and `validatePublishedAssetPrice()` behind the same internal result.
- `worker/src/cron/sync-stablecoins/pricing.ts`
  - introduce a local or shared `applyAcceptedPriceCandidate()` helper.
  - make `applyPrimaryCandidate()`, `applyGtProbeResults()`, and `applyProtocolPriceOverrides()` call that helper.
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
  - reuse the same finalizer for native-peg fills/corrections and cached fallback rehydration.

Tranche B, provider/source fan-in:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
  - extract fetch source maps into one function returning a named object.
  - keep current circuit breaker behavior and `Promise.all(fetches)` shape.
- `worker/src/lib/primary-price-collector.ts`
  - keep source admission policy here; do not split it until Tranche A is stable.

## Tests To Add Or Reuse

Existing tests to run for any pricing remediation:

- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/lib/__tests__/price-publish-policy.test.ts`
- `worker/src/lib/__tests__/price-consensus.test.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`

Characterization tests worth adding before Tranche A:

- Accepted primary consensus, GT probe, protocol override, native-implied correction, and cached fallback all stamp the same metadata fields consistently.
- Rejected candidate clears price exactly once and does not leave stale `agreeSources` / `consensusSources`.
- `coingecko-native-implied` publishes live but is not saved to `price_cache`.
- Previous trusted replay cache wins only when it is authoritative and newer than the previous stablecoins publication.
- Severe downside single-source remains rejected unless the existing corroboration exceptions are present.

## Do Not Change Public Contracts

- Stablecoins cache schema and `_meta` behavior.
- Cron metadata names for primary/fallback stats, `gtProbe`, staleness, and validation failures.
- `price_cache` replay-safe admission rules and TTL.
- Pricing methodology version unless behavior intentionally changes.

## Open Questions Before Implementation

- Should the richer publication decision be public to tests only, or kept private and tested via existing wrappers?
- Is `isReasonablePrice()` still needed as a compatibility helper after `validatePriceCandidate()` is the canonical path, or should it remain untouched for now?
- Should provider fetch maps be represented as one typed object per source or as `SourcePrice[]` plus side-channel stats? For the first refactor, typed source maps are safer because they preserve current diagnostics.
