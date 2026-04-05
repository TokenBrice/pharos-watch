# Pricing Module Audit Report

Date: 2026-03-30

## Scope

This audit reviews the current live pricing implementation across:

- Primary consensus orchestration in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- Fallback enrichment in `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
- Publish/trust policy in `worker/src/cron/sync-stablecoins/pricing.ts`, `worker/src/lib/price-validation.ts`, `worker/src/lib/price-publish-policy.ts`, `worker/src/lib/depeg-helpers.ts`
- Source adapters in `worker/src/lib/pyth.ts`, `worker/src/lib/cex-tickers.ts`, `worker/src/lib/redstone.ts`, `worker/src/lib/curve-onchain.ts`, `worker/src/lib/cg-ticker.ts`, `worker/src/lib/geckoterminal-price-probe.ts`, `worker/src/lib/authoritative-price-sources.ts`, `worker/src/lib/dexscreener.ts`
- Shared pricing metadata and policy surfaces in `worker/src/lib/primary-price-collector.ts`, `worker/src/lib/pricing-types.ts`, `worker/src/lib/pricing-source-policy.ts`, `shared/lib/pricing-source-registry.ts`, `shared/lib/pricing-provider-config.ts`

Audit goals:

1. Maximize price accuracy and downstream trustworthiness
2. Improve maintainability, clarity, and reduction of avoidable complexity

## Verification

Docs reviewed:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/pricing-pipeline.md`
- `docs/pricing-pipeline-timeline.md`

Repository checks run:

```bash
npx tsx -e "import { ACTIVE_STABLECOINS } from './shared/lib/stablecoins'; ..."
npm run audit:pricing-providers
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts
```

Results:

- Provider audit passed: Binance, Kraken, Bitstamp, Coinbase, RedStone mappings all matched live metadata
- Pricing-focused regression slice passed: 4 files, 137 tests

Current coverage snapshot from the checked-in metadata/config:

| Surface | Current count |
| --- | ---: |
| Active stablecoins | 176 |
| `geckoId` coverage | 172 |
| `llamaId` coverage | 142 |
| `pythFeedId` coverage | 46 |
| RedStone symbol coverage | 22 |
| Curve on-chain configs | 19 |
| Binance pairs | 2 |
| Kraken pairs | 8 |
| Bitstamp pairs | 4 |
| Coinbase products | 6 |
| CG ticker special cases | 2 |
| `cmcSlug` coverage | 23 |
| Authoritative protocol-redeem overrides | 2 |

## Executive Summary

The pricing module is structurally strong. The major design choices are correct:

- multi-source consensus instead of a single aggregator
- explicit trust modeling in the pricing-source registry
- hardening layers beyond consensus: pool challenge, GT probe, protocol redemption overrides, replay-safe continuity
- separate publication policy instead of blindly persisting every quote

The remaining issues are mostly in three buckets:

1. Freshness semantics are still weaker than they appear for many sources
2. A few fallback paths still have identity / sequencing weaknesses that can suppress better prices
3. The implementation is still too concentrated in large orchestration files with repeated source-specific boilerplate

No single catastrophic logic bug stood out. The biggest practical risks are:

- publishing prices that look fresher than they really are
- allowing weak fallback identity matching to attach the wrong market to an asset
- making future pricing changes expensive and error-prone because the code is harder to reason about than the methodology suggests

## What Is Already Good

- `worker/src/lib/price-consensus.ts` uses pairwise clique-based clustering instead of transitive agreement.
- `worker/src/lib/redstone.ts` derives the published price from the venue median instead of trusting the provider aggregate.
- `worker/src/lib/pyth.ts` preserves true upstream publish time and enforces a real staleness gate.
- `worker/src/lib/price-publish-policy.ts` adds temporal-jump quarantine and severe-downside corroboration.
- `worker/src/lib/geckoterminal-price-probe.ts` and `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` already moved to protocol-aware DEX estimators rather than naive single-pool means.
- `scripts/audit-pricing-provider-config.ts` is a good operational backstop for manual venue mappings, and it currently passes.

## Priority Findings

### P0. Synthetic freshness still dominates most non-oracle sources

Why this matters:

- Downstream depeg trust uses `priceObservedAt` age in `worker/src/lib/depeg-helpers.ts:213`.
- Many sources still stamp `priceObservedAt` with local fetch time rather than source-native observation time.
- This makes several prices look fresher than they really are, even though the payload now distinguishes `priceObservedAt` from `priceSyncedAt`.

Evidence:

- CoinGecko simple price uses local fetch time: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:211`
- CG ticker uses local fetch time: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:235`
- Binance/Kraken/Bitstamp/Coinbase all use local fetch time: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:275`, `288`, `301`, `314`
- Curve on-chain and Curve oracle use local fetch time: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:355`, `374`
- GeckoTerminal probe uses local fetch time: `worker/src/lib/geckoterminal-price-probe.ts:396-401`
- Fallback passes default to `local_fetch` for every `applyResolvedPrice()` call: `worker/src/cron/sync-stablecoins/enrich-prices-shared.ts:38-54`
- DefiLlama-list observed-at is inherited from the mutable asset object rather than a typed source quote: `worker/src/lib/primary-price-collector.ts:119-124`

Assessment:

- Pyth and RedStone are the cleanest current sources from a freshness standpoint.
- Most market and fallback sources still expose synthetic freshness.
- This is the highest-priority remaining accuracy issue because the trust model now depends on freshness semantics more than before.

Recommended remediation:

- Introduce an explicit per-source freshness contract:
  - `observedAt`
  - `observedAtMode`
  - `maxTrustedAgeSec`
  - `freshnessKind: upstream | local_fetch | unknown`
- Preserve true source timestamps wherever available.
- Downgrade or annotate local-fetch-only sources more explicitly in downstream trust classification and operator surfaces.

### P0. DefiLlama contract fallback can block stronger later fallbacks before validation runs

Why this matters:

- Pass 1 / 1b marks an asset as resolved before applying any peg-aware validation.
- Once marked as resolved, the asset stops participating in later fallback passes for that run.
- If the DL contract quote is positive but wrong, the later CMC/Jupiter/DexScreener passes never get a chance to recover it during the same sync.

Evidence:

- DL pass 1 claims prices immediately: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:300-317`
- DL pass 1b does the same: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:333-353`
- Later fallback passes operate only on `hasMissingPrice()` assets: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:382`, `509-513`, `663-667`

Current safety story:

- The bad price can still be cleared later by post-enrichment validation.
- That prevents bad publication.
- It does not prevent losing a better live fallback that would have been available later in the same run.

Recommended remediation:

- Validate DL contract pass candidates before mutating `asset.price`.
- Better: have each fallback pass return candidate quotes, then apply them centrally only after pass-level validation.

### P0. DexScreener symbol search is still identity-weak and can match the wrong token

Why this matters:

- Exact chain+address lookup is good.
- The symbol-search fallback still accepts any high-liquidity pool whose base token symbol matches the Pharos symbol on an allowed chain.
- Symbol uniqueness is enforced only within the Pharos registry, not globally on the chain or in DexScreener search results.

Evidence:

- Search fallback only requires `UNIQUE_ACTIVE_SYMBOLS` within Pharos: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:581-583`
- Candidate filtering checks only base-token symbol, liquidity, and optional chain allowlist: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:612-619`
- There is no token-address, token-name, or issuer-level verification on the search path.

Impact:

- A non-Pharos asset with the same ticker on the same chain can satisfy the fallback.
- `isReasonablePrice()` is not enough to protect against this because an imposter pool can still have a peg-like USD price.

Recommended remediation:

- Restrict search fallback to assets with no known tracked address at all.
- Require a stronger identity check on symbol-search matches:
  - address in known tracked deployments, or
  - exact name/issuer match allowlist, or
  - explicit per-asset search config
- If identity cannot be established, prefer staying missing over returning a plausibly priced wrong token.

### P1. Consensus selects one member price, not the cluster median, and trust-tier precedence can override source weights

Why this matters:

- The current engine uses clusters correctly, but the final published price is one chosen source price, not the cluster median.
- Within an agreeing cluster, trust-tier precedence wins before weight.
- That means the documented source weights influence cluster selection, but not necessarily the final point estimate.

Evidence:

- High-confidence clusters publish `chosen.price`, not cluster median: `worker/src/lib/price-consensus.ts:117-133`
- Low-confidence output also publishes one chosen source: `worker/src/lib/price-consensus.ts:136-149`
- Trust-tier ordering is applied before weight inside the cluster: `worker/src/lib/price-consensus.ts:305-337`

Implications:

- Results are more discontinuous than they need to be.
- A lower-weight hard-market source can override a higher-weight hard-protocol source inside the same agreeing cluster.
- Weight semantics are therefore harder to explain and easier to misread during future maintenance.

Recommended remediation:

- Separate `clusterWinner` from `publishedPrice`.
- Keep `selectedSource` for provenance, but publish a cluster-level estimator:
  - median, or
  - weighted median if you want weights to affect the final point estimate too

### P1. DEX bridge freshness is collapsed to row write time, losing per-protocol observation fidelity

Why this matters:

- `price_sources_json` is supposed to hold per-protocol breakdowns.
- The loader currently overwrites each source's `updatedAt` with the row-level `updated_at`.
- That erases any more precise per-protocol freshness carried in the JSON payload.

Evidence:

- `worker/src/lib/depeg-helpers.ts:177-182`

Impact:

- Primary consensus receives protocol DEX sources with row-write freshness, not source freshness.
- This weakens future source-specific freshness policy and makes DEX source diagnostics less informative than they could be.

Recommended remediation:

- Preserve `source.updatedAt` from `price_sources_json` when present.
- Fall back to row `updated_at` only when the per-source field is absent.

### P1. CEX sources are useful, but they are still weaker than their current “hard market” treatment suggests

Why this matters:

- The CEX sources are valuable because they are direct venue reads.
- The current adapters still do not inspect trade age, ticker timestamp, or market-state depth.
- In practice, they behave like “current ticker snapshots” rather than strongly freshness-qualified executable quotes.

Evidence:

- Kraken uses midpoint if available, else last trade, with no age check: `worker/src/lib/cex-tickers.ts:120-128`
- Bitstamp does the same: `worker/src/lib/cex-tickers.ts:156-165`
- Coinbase does the same: `worker/src/lib/cex-tickers.ts:198-204`
- Binance uses the plain price endpoint only, which provides no bid/ask or freshness metadata: `worker/src/lib/cex-tickers.ts:69-88`

Additional context:

- Coverage is intentionally narrow: Binance 2, Kraken 8, Bitstamp 4, Coinbase 6.
- The live provider audit currently passes, but the audit is not CI-gated.

Recommended remediation:

- Prefer richer ticker/book endpoints when they expose timestamps or bid/ask state.
- Track source capability more explicitly:
  - `hasBidAsk`
  - `hasUpstreamTimestamp`
  - `hasTradeAge`
  - `isLastTradeOnly`
- Consider a softer trust treatment for last-trade-only paths if no freshness metadata is available.
- Make `audit:pricing-providers` part of CI or a scheduled operator check.

### P1. Source-registry semantics are still too coupled and partially derived

Why this matters:

- The registry is the right pattern.
- It still mixes source facts with downstream policy and derives some fields from others in a way that hides intent.

Evidence:

- `supportsUpstreamObservedAt` is derived from `requiresObservedAt`: `shared/lib/pricing-source-registry.ts:431`
- `canSingleSourceDepegAuthoritative` is derived from `canBeDepegAuthoritative && defaultObservedAtMode === "upstream"`: `shared/lib/pricing-source-registry.ts:432-433`

Why this is weak:

- “requires observed-at” is not the same concept as “supports upstream observed-at”.
- “default observed-at mode” is not the same concept as “can be single-source authoritative”.
- These are policy shortcuts embedded into metadata wiring.

Recommended remediation:

- Make the registry fully explicit for policy-significant fields.
- Split source facts from publication/depeg policy if needed.

### P1. The pricing code is still too concentrated in hotspot files

Current file sizes:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`: 699 LOC
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`: 724 LOC
- `worker/src/lib/price-validation.ts`: 589 LOC
- `worker/src/lib/geckoterminal-price-probe.ts`: 447 LOC
- `shared/lib/pricing-source-registry.ts`: 440 LOC
- `worker/src/cron/sync-stablecoins/pricing.ts`: 424 LOC
- `worker/src/lib/authoritative-price-sources.ts`: 364 LOC

Why this matters:

- The code is no longer chaotic, but it is still expensive to change safely.
- `fetchPrimaryPrices()` mixes candidate selection, breaker checks, fetch orchestration, normalization, and consensus.
- Fallback passes mix identity resolution, fetch transport, validation, mutation, and rate limiting in one file.

Recommended remediation:

- Introduce adapter-style composition:
  - `PrimarySourceAdapter`
  - `FallbackSourceAdapter`
- Unify price-candidate application through one canonical internal type.
- Move all “mutate asset” behavior to one merge layer after candidate validation.

## Source-By-Source Audit

### CoinGecko `/simple/price`

Strengths:

- Broadest current live coverage
- Clean batching
- Good primary coverage anchor

Weaknesses:

- Synthetic freshness only: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:211`
- No market structure diagnostics beyond returned price
- Soft aggregator, so agreement with other soft sources can still overstate confidence operationally

Best improvements:

- Capture any available cache-age / provider freshness if exposed by the API tier in use
- Keep as broad-coverage anchor, but not as a freshness-rich source

### CoinGecko ticker extraction

Strengths:

- Good targeted fix for Kinesis assets
- Better than trusting `/simple/price` for those assets

Weaknesses:

- Still local-fetch freshness: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:235`
- `pickBestTicker()` ignores spread thresholds and richer quality hints: `worker/src/lib/cg-ticker.ts`
- Only covers 2 assets

Best improvements:

- Add a spread ceiling and optional exchange-side quality heuristics
- Preserve upstream time when exposed

### DefiLlama list

Strengths:

- Independent soft voice relative to CoinGecko
- Important for assets with Llama-led supply/pricing

Weaknesses:

- Not represented as a first-class typed quote
- Freshness/provenance inherited from mutable asset state: `worker/src/lib/primary-price-collector.ts:119-124`
- Harder than necessary to reason about in consensus and in debugging

Best improvements:

- Materialize a `DefiLlamaListQuote` object at intake time with explicit provenance

### DefiLlama contract fallback

Strengths:

- Strong recovery path for missing prices on address-known assets
- Tracked alternate-deployment logic is safer than synthetic cross-chain identity

Weaknesses:

- No validation before claiming the asset and blocking later fallbacks: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:300-353`
- Raw-address heuristic defaults to `ethereum:` for any `0x...` and `solana:` otherwise: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:63-70`

Best improvements:

- Validate before mutating
- Eliminate address-shape chain inference where canonical deployment metadata exists

### Pyth

Strengths:

- True upstream publish time
- Real confidence interval handling
- Best freshness semantics in the module

Weaknesses:

- Coverage remains partial at 46 assets
- Confidence downweighting is very coarse:
  - `>100bps` becomes weight 1
  - `>200bps` becomes discarded
  - `worker/src/lib/primary-price-collector.ts:158-170`

Best improvements:

- Expand feed coverage where available
- Replace step-function downweighting with a smoother confidence-to-weight policy

### Binance / Kraken / Bitstamp / Coinbase

Strengths:

- Direct market voices
- Very useful hard-price inputs when healthy

Weaknesses:

- Narrow configured coverage
- Freshness mostly inferred from local fetch
- Last-trade-only fallback still possible on Kraken/Bitstamp/Coinbase
- Binance path is especially thin because it uses the price endpoint only

Best improvements:

- Richer ticker surfaces where possible
- Explicit capability metadata
- CI/scheduled gating of provider-config audit

### RedStone

Strengths:

- Venue-level breakdown is valuable
- Upstream timestamp enforced
- Median across venues is the right direction

Weaknesses:

- Coverage is still partial at 22 assets
- Admission rule is fairly permissive: `venueCount >= 2 && venueAgreementPct >= 50` in `worker/src/lib/primary-price-collector.ts:173-186`
- All venues are weighted equally

Best improvements:

- Consider a stricter venue-agreement floor
- Add trusted-venue weighting or venue-quality tiers

### Curve on-chain / Curve oracle

Strengths:

- High-quality on-chain signal for supported pools
- Clear config-driven coverage

Weaknesses:

- Coverage still limited to 19 configs plus the crvUSD oracle path
- Observed-at is local fetch, not block time: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:355`, `374`
- Single quote-size estimator only

Best improvements:

- Preserve block timestamp where feasible
- Consider multi-size sanity sampling for fragile pools if false signals appear

### Promoted DEX sources from `dex_prices`

Strengths:

- Good corroboration gates
- Non-overlap guard with `dex-promoted`
- Useful bridge from DEX liquidity infra into pricing

Weaknesses:

- Per-source freshness is collapsed to row-write time: `worker/src/lib/depeg-helpers.ts:177-182`
- The DEX bridge currently sits behind multiple helper layers, making provenance harder to inspect than primary API sources

Best improvements:

- Preserve per-protocol freshness and keep it visible through diagnostics

### GeckoTerminal probe

Strengths:

- Good soft-source challenge path
- Budgeted and breaker-aware
- Protocol-aware estimator is a real improvement

Weaknesses:

- Still local-fetch freshness: `worker/src/lib/geckoterminal-price-probe.ts:396-401`
- Coverage is not universal because probeable chain support is selective

Best improvements:

- Preserve richer per-pool timestamps if available
- Expand probeability only where chain/network mappings and connection budget justify it

### Pool challenge replacement

Strengths:

- Correctly uses corroborating divergent protocol groups
- Good last-resort honesty mechanism against soft-source consensus

Weaknesses:

- Replacement updates `priceSource` to `pool-tvl-weighted` but leaves the original `agreeSources`/candidate diagnostics untouched: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:568-597`
- That weakens transparency and makes later debugging harder

Best improvements:

- Stamp explicit challenger provenance when replacement fires
- Preserve both:
  - original consensus sources
  - replacement challenger sources

### CoinMarketCap fallback

Strengths:

- Reasonableness-validated
- Slug-first matching is safer than plain symbol matching

Weaknesses:

- Coverage still only 23 `cmcSlug` values
- Unique-symbol fallback is still weaker than explicit slug matching: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:448-457`
- Not enough current coverage to be considered a robust general fallback layer

Best improvements:

- Expand explicit `cmcSlug` coverage or move to a stronger identity scheme for this provider

### Jupiter fallback

Strengths:

- Exact mint identity
- Solana-specific fallback is useful and cleaner than symbol search

Weaknesses:

- Still local-fetch freshness via `applyResolvedPrice()`
- Relies on liquidity threshold only; no additional trust classification beyond fallback mode

Best improvements:

- Preserve provider-native freshness if/when exposed in a stable way

### DexScreener fallback

Strengths:

- Exact token-address path is a legitimate last-resort source
- Budgeted and chain-aware for address lookups

Weaknesses:

- Symbol-search fallback is identity-weak
- Request cap means missing assets beyond the first 10 are not attempted in that run: `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:516-526`

Best improvements:

- Tighten or remove symbol-search matching
- If the cap remains, order candidates explicitly by expected recovery value rather than array position

### Protocol redemption overrides

Strengths:

- Best source in the whole module for the assets it covers
- Historical replay support is a major quality feature

Weaknesses:

- Coverage is only 2 assets
- Provider implementations are still bespoke rather than registry-driven

Best improvements:

- Expand only when there is genuinely authoritative redeemability and stable on-chain quote semantics

### Cached replay continuity

Strengths:

- Much safer than blind stale replay
- Important for continuity through brief source outages

Weaknesses:

- Still implemented through several type conversions and policy checks spread across the module
- Harder than necessary to audit end-to-end

Best improvements:

- Rebuild around one canonical internal `SelectedPrice` / `ReplaySafePrice` representation

## Maintainability And Mutualization Opportunities

### 1. Introduce source-adapter interfaces

Current problem:

- Source orchestration is handwritten per source in `enrich-prices-primary.ts` and `enrich-prices-passes.ts`
- Breaker logic, fetch timing, normalization, and outcome accounting are repeated

Recommended shape:

```ts
interface PrimarySourceAdapter {
  key: PricingSourceKey;
  eligible(asset: AssetContext): boolean;
  fetch(ctx: SourceFetchContext): Promise<SourceBatchResult>;
  quoteFor(asset: AssetContext, batch: SourceBatchResult): SourcePrice | null;
}
```

Equivalent pattern for fallback adapters.

### 2. Stop mutating `PeggedAsset` during fallback passes

Current problem:

- Every pass mutates the shared asset array in place
- Pass order is part of the data model

Recommended shape:

- Passes return `ResolvedFallbackQuote[]`
- One merge function applies validated winners

### 3. Unify pricing metadata types

Current problem:

- `PrimaryPriceResult`, `PriceMetadata`, `PriceCacheEntry`, `PeggedAsset` pricing fields, and fallback quote shapes overlap substantially

Recommended shape:

```ts
interface SelectedPrice {
  price: number;
  source: string;
  confidence: PriceConfidence | null;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  syncedAt: number | null;
  agreeSources: string[];
  candidateSources: string[];
  diagnostics?: PriceSourceDiagnostics;
}
```

### 4. Split structural validation from publication policy

Current problem:

- `validatePriceCandidate()` is structurally permissive by design
- Publication safety depends on higher-level policy layers in other modules

Recommended split:

- `validateStructuralPriceBounds()`
- `evaluatePricePublicationPolicy()`
- `evaluateReplayPolicy()`

### 5. Make the registry the real single source of truth

Current problem:

- Weight, authority, and freshness semantics still leak into orchestration code and derived metadata

Recommended direction:

- Explicit registry fields for:
  - default weight
  - freshness kind
  - authority rules
  - depeg-authoritative capability
  - fallback/search-derived risk

## Recommended Remediation Sequence

### Phase 1. Accuracy hardening

- Fix synthetic freshness semantics source-by-source, starting with primary sources
- Validate DefiLlama contract pass candidates before they block later fallbacks
- Tighten or disable DexScreener symbol-search fallback unless identity can be proven
- Preserve per-protocol DEX bridge timestamps from `price_sources_json`

### Phase 2. Consensus-model hardening

- Publish cluster median or weighted median while retaining `selectedSource` for transparency
- Revisit RedStone venue-quality policy
- Improve CEX capability modeling and freshness semantics
- Clean up pool-challenge provenance stamping

### Phase 3. Simplification / mutualization

- Introduce primary/fallback source adapters
- Unify internal price metadata types
- Split validation layers clearly
- Reduce hotspot file size by moving source-specific code behind stable interfaces

## Bottom Line

If the next implementation plan needs one short version, it is this:

1. Fix freshness semantics
2. Fix fallback identity / sequencing integrity
3. Simplify the orchestration surface before adding more sources

The pricing module is already good enough to build on. The remaining work is less about inventing a new methodology and more about making the existing methodology honest, source-aware, and easier to maintain.
