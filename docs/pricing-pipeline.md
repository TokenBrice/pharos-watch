# Pricing Pipeline

> **Agent navigation** — Current invariants and interfaces are below. Maintainers can read the [implementation appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/pricing-pipeline-appendix.md) by routed section; it is not a second methodology authority.

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

Supply fallback admits only reviewed, fail-closed, double-count-safe observations; price recovery cannot manufacture supply. The [supply contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-pipeline) owns admission/clocks; the [integrity index](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/pricing-pipeline-appendix.md#data-integrity-guardrails) routes cross-domain protections.


---

## Overview

Pharos separates critical publication from best-effort corroboration:

1. **15-minute publication** runs the full primary consensus: DefiLlama and CoinGecko, the curated CoinGecko ticker and CEX lanes, RedStone, Curve on-chain/oracle, reserve NAV telemetry, promoted DEX observations, and the post-consensus pool challenge. Registered authoritative overrides then run before publication.
2. **Hourly corroboration** runs after the existing `:09` status-check chain, ahead of the `:15` publication. This avoids the previous full publication-cycle wait after `:00` publication without putting provider requests on the primary path or extending source TTLs. It requires a valid published cache to build its cohort; unavailable or malformed cache reads leave the prior staging untouched. Fallback probes restore curated provider identifiers, contract overrides, and NAV hints omitted from public rows before enrichment. Original missing-price identity survives probe price clearing so bounded provider searches prioritize recovery over low-depth corroboration. It runs `enrichMissingPrices()` and the explicitly enabled exact-address provider against only the latest missing or low-depth rows. It stages actual fetched observations in `price:corroboration-observations:v1` for a later publication to revalidate, separately from ordinary `price_cache` replay provenance. Each hourly attempt also persists a bounded `price-corroboration` cron event with the scheduled slot, Worker version, resolution counts and provider status/error classes. Admin status exposes it as `sync-stablecoins.latestEvent` when it is the newest event; newer critical slot events take precedence. Provider URLs, credentials, response bodies and raw error messages are excluded. DexScreener diagnostics distinguish failed requests from successful empty or price-ineligible responses; circuit and price-admission rules are unchanged. The same 15-minute price-observation refresh also re-observes the rows whose published price comes from the exact-address lane, because those quotes live for a single publication window and are never replayable from `price_cache`; a row that lane prices, or any row still missing a price, gets a fresh exact-address observation each slot instead of waiting for the next hourly collection.

The `:09/:24/:39/:54` refresh also reruns eligible DefiLlama contract and Jupiter fallbacks with separate 25-second envelopes, without changing admission or source TTLs. Refreshed quotes keep fallback confidence and cannot become trusted inherited parents; a child's publication time never refreshes its parent observation.

Both publication paths record `priceObservationEffectiveness` in progress and final cron metadata, including the size-compacted main result. It reports staging status/slot/age, loaded and eligible observation counts, mutually exclusive discard reasons, and eligible outcomes (`alreadyPriced`, `assetAbsent`, `policyRejected`, `selected`, `notNeededAfterSelection`). Loaded count is `null` when the staging payload was not read or validated. Eligible outcomes sum to eligible observations; eligible plus discarded sum to loaded observations when known. `selected` means applied to the candidate payload, not independent proof of cache publication; use the final run's publication evidence and cache generation to confirm delivery. Minimum freshness headroom measures remaining source TTL among eligible observations. The shared completion path reads the existing staging cache even when all assets already have prices, with no additional provider requests or changes to admission, freshness or selection order.

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, optional `priceSourceConfidenceProfile`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

USDFC is included in the reviewed CoinGecko low-volume fallback cohort. Its exact Filecoin token identity is verified against issuer deployments and CoinGecko metadata; sparse trading can leave an observed quote older than primary consensus permits. Recovery retains the original upstream clock and fallback confidence under the existing seven-day budget, without changing DefiLlama supply or treating the FIL collateral oracle as a USDFC market price.


## Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-pricing-pipeline -->`v6.52`<!-- GENERATED-END: methodology-version-pricing-pipeline -->
- **Canonical version module:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

The [public Pricing changelog](https://pharos.watch/methodology/pricing-pipeline-changelog/) owns release chronology, activation dates and retained historical behavior. Supply admission, historical-bucket conservation and repair clocks remain governed by the [supply contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-data-source), not by a second Pricing specification.

### Release obligations

Before releasing a Pricing methodology change, converge its runtime constant/registry, structured Pricing history, owning prose and public Pricing section, together with current-version route-parity fixtures and generated methodology documentation blocks. Public changelog metadata and Markdown exports derive from the registry. Provisional activation dates in structured history must be re-dated at release; the generated version marker above is not edited by hand.

Fixed-clock price/supply/valuation/coverage comparison remains a release prerequisite for the admitted-input and coverage changes. Fresh admitted producer observations and production resource evidence are separate acceptance gates, not conclusions established by a version bump or a passing local comparison. These obligations do not claim a completed replay or production-health observation.


---

## Primary Consensus

`fetchPrimaryPrices()` keeps the established depeg-protective consensus in the critical 15-minute publication path. It combines DefiLlama intake observations with CoinGecko, curated exchange tickers, RedStone, Curve, reserve NAV telemetry, and promoted DEX observations, then applies the pool challenge. Registered authoritative protocol/NAV overrides run afterward and may replace the selected market price. Missing-price fallback and exact-address requests remain outside that critical invocation: broad corroboration is hourly, with quarter-hour refresh of the short-lived contract, Jupiter, exact-address and exact-DEX quotes.

The DefiLlama-list consensus input accepts only intake prices with an absent source or an explicit `defillama` / `defillama-list` origin, and still excludes `coingecko-fallback` supply rows. Supplemental contract quotes and other named price sources retain their own provenance and cannot be relabeled `defillama-list`, including when their supply comes from an on-chain read.

Tracked NAV classification is authoritative in both intake normalization and price-validation context: an omitted curated NAV flag means false, and a provider's `navToken: true` cannot bypass fixed-peg validation. Untracked rows retain their source classification.

### Source Weights

| Source | Weight | Module / Origin | Cadence and role |
| --- | ---: | --- | --- |
| CoinGecko `/simple/price` | 2 | `worker/src/lib/coingecko-simple-price.ts` | One live primary fetch surface per 15-minute publication; uses upstream `last_updated_at` when available and rejects stale rows. |
| CoinGecko ticker | 2 | `worker/src/lib/cg-ticker.ts` | Curated exchange-ticker corroboration for the tracked Kinesis assets. |
| DefiLlama stablecoins list | 1 | Typed quote from the intake response | Local primary input on every 15-minute publication; no second request. |
| Binance spot | 2 | `worker/src/lib/cex-tickers.ts` | Batch venue input retained in 15-minute consensus. |
| Kraken spot | 2 | `worker/src/lib/cex-tickers.ts` | Explicit-pair venue input with alias-safe symbol mapping. |
| Bitstamp spot | 1 | `worker/src/lib/cex-tickers.ts` | Lower-weight all-tickers corroboration venue. |
| Coinbase spot | 2 | `worker/src/lib/cex-tickers.ts` | Per-symbol venue input. |
| RedStone | 1 | `worker/src/lib/redstone.ts` | Fresh exact-case oracle symbols with venue-agreement gating and solo retry recovery. |
| Curve on-chain and crvUSD oracle | 3 | `worker/src/lib/curve-onchain.ts` | Configured pool routes plus the crvUSD PriceAggregator oracle. |
| Chainlink/Superstate/JPMorgan reserve NAV telemetry | 3 | `reserve_composition` | Matched fresh reserve snapshots, with fresh/static FX conversion for non-USD NAVs. |
| Promoted DEX protocol lanes | 2–3 | `worker/src/lib/depeg-helpers.ts` | Per-protocol observations from `dex_prices`; each lane must agree with a hard source or an independent promoted DEX lane, and the aggregate is withheld whenever any promoted protocol candidate exists, even when every lane is then rejected (registry, freshness, TVL, or corroboration). |
| Authoritative protocol/NAV overrides | authoritative replacement | `worker/src/lib/authoritative-price-sources/` | Bounded route registry evaluated after primary consensus for assets with a registered known source. |
| CoinGecko Onchain exact-address | provenance weight 1 | `worker/src/lib/address-price-providers/coingecko-onchain.ts` | Hourly corroboration plus slot-level refresh for missing/address-priced rows; outside the main publication invocation. |

Reserve NAV quotes use the shared decoder in `worker/src/lib/reserve-nav-price.ts`. It accepts only registered NAV adapters, independently checks the successful snapshot fetch age and upstream NAV evidence clock, and rejects invalid/nonpositive NAV, missing or malformed metadata, and stale or excessively future evidence. JPMorgan JLTXX uses the exact issuer Token Class transaction NAV with the shared five-day business-day NAV source-age policy; Chainlink and Superstate retain their existing source-specific policies. Supply admission can read the same matched successful snapshot before a new NAV asset has a previous stablecoin cache row: `fiat-cg.ts` values positive native on-chain supply at that observed NAV and applies the existing trusted FX conversion for non-USD classes. This valuation does not itself fabricate a published market quote; primary reserve-NAV consensus supplies the live price. A missing/stale NAV and absent alternative trusted price leave the candidate out, rather than assigning nominal $1.

Both primary collection and supplemental supply use `decodeCurrentReserveNavPrice()` to require the current semantic configuration fingerprint and canonical successful snapshot/attempt linkage for every NAV adapter. Fresh evidence from prior same-adapter oracle/token/method parameters is unavailable. A later failed attempt does not retire an otherwise current Chainlink/Superstate success; JPMorgan retains its stricter current issuer-class/latest-attempt binding. Fetch and source-age checks remain independent of configuration identity.

Promoted DEX corroboration is candidate-scoped. A hard-source match admits only the agreeing protocol lane, while DEX-only corroboration requires an independent protocol lane within the existing divergence threshold. Divergent siblings are excluded with `lacked_corroboration` telemetry rather than inheriting another lane's evidence.

The primary CEX, ticker, oracle, promoted-DEX, reserve-telemetry and pool-challenge lanes protect depeg detection within publication. Exact-address transport remains detached; CoinGecko Onchain is the sole retained adapter and requires explicit allowlisting. Retired source registry keys, including `pyth`, remain renderable for historical provenance but cannot contribute live observations.

Kraken's curated `SOFIDUSD` market supplies SoFiUSD's hard-market quote through the existing batched ticker request, corroborating the contract-verified CoinGecko `sofiusd` identity. SoFiUSD no longer has a nominal-par override: admitted observed market consensus publishes through the ordinary validation path. Kraken's bid/ask midpoint retains its local-fetch clock, and CoinGecko agreement does not upgrade that quote to single-source depeg authority. Failed or absent quotes stay unavailable rather than publishing par. Provider registration alone does not establish a published observation.

### Nominal-reference recovery boundary

`protocol-par` is a nominal reference, never an observed market quote. The current nominal routes are Bima USBD, Quill USDQ (`usdq-quill`, not Quantoz USDQ), Mento XOFm and Mento ZARm. `isObservedPrice()` rejects both the nominal observation mode and any composite source containing `protocol-par`; a fresh sync timestamp does not make parity observed.

Primary collection already includes assets with retained DEX rows or protocol-source observations, independent of their incumbent price. Each registered promoted protocol lane must pass its existing freshness policy, the $50,000 per-lane TVL floor and candidate-scoped 50-bps corroboration from a hard source or a different DEX source family. One protocol on two chains is not independent corroboration. Admission to primary consensus is distinct from nominal-reference precedence: even an independently corroborated DEX-only consensus remains `confirm_required`, because promoted DEX lanes are not depeg-authoritative.

`isTrustedMarketQuote()` and final `settleNominalPriceReferences()` retain nominal publication unless the incumbent passes the existing authoritative depeg-trust gate. Therefore adding an exact-address refresh probe, an exchange symbol without verified token identity, or soft-source corroboration cannot by itself recover these four assets' observed peg inputs. Recovery needs an identity-safe observed path that already satisfies that gate; changing the gate is a separate pricing-methodology decision. Non-USD recovery also requires its independently fresh native FX reference: PHT is PHP-pegged, XOFm is XOF-pegged, and ZARm is ZAR-pegged, never $1-pegged.

Only fresh, identity-safe producer observations that pass these admission rules can clear a peg-input gap. A coverage review, provider registration or price-gap acknowledgement is not evidence of an admitted market.

The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) is excluded from primary consensus because it re-exports CoinGecko and cannot establish independent agreement. Exact contract-address queries remain eligible only for fallback enrichment.

### Consensus Rules

Before clustering, repeated quotes with the same source key are collapsed to one provider observation using their median,
maximum configured weight, and conservative observation time. Registered source keys that share a
`depegSourceFamily` are then reduced to the strongest representative for that family. This prevents multiple
deployments from one address provider, or correlated lanes such as CoinGecko list and CoinGecko ticker data, from
creating false multi-source confidence or gaining extra median weight.

`computePriceConsensus()` then behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build fully pairwise agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> initially `high` confidence, publish the cluster median, and keep the best trusted member as internal provenance. Even clusters average the middle sorted pair: the six-source public example's 1.0000/1.0001 pair yields 1.00005, not four-decimal display rounding.
5. no 2+ cluster:
   - fixed pegs -> stay in fixed-peg mode even if the reference price is temporarily unavailable; choose the best trusted fallback source by trust tier first, then reference proximity, and mark `low`
   - NAV tokens -> use a wider 500 bps cluster threshold first, otherwise choose the best trusted fallback source and mark `low`

When multiple clusters have the same size, the winner is chosen deterministically by:

1. larger total cluster weight
2. stronger trust tier (any hard-tier member > mixed > all soft) — prevents a tight soft cluster from beating an equal-weight hard cluster on proximity alone
3. tighter internal spread
4. proximity to peg reference (when available)
5. stable alphabetical source label as the final tie-break

Source labels list all agreeing sources alphabetically:

- 1 source: source name directly
- 2+ sources: `sourceA+sourceB+sourceC` (full list, no truncation)

High-confidence consensus now separates:

- the **published price**: the median of the agreeing winning cluster
- the **selected source**: the best cluster member kept internally for provenance and downstream trust policy

Inside the winning cluster, the selected source is chosen by:

1. higher configured weight
2. stronger trust tier
3. closer distance to the reference price
4. alphabetical source key

When severe fixed-peg downside publication is accepted because multiple candidate sources independently confirm the
downside, that candidate-price evidence is carried through the later prevalidation and post-enrichment validation passes
as long as the current asset price, source, and confidence still match the selected primary result. Post-enrichment
validation also merges a same-run primary candidate set with a current fallback quote when fallback recovery replaced
the selected result. This keeps a corroborated low-confidence depeg price from being cleared as if it were genuinely
single-source, without loosening the guardrail for unrelated fallback, correlated list-only, or stale prices.

Severe fixed-peg downside corroboration counts independent source families, not raw source labels. CoinGecko-derived
sources share one lineage, DefiLlama list/detail/contract sources share one lineage, each CEX/oracle source keeps its own
lineage, and promoted DEX protocol lanes count by protocol. A CoinGecko plus DefiLlama-list downside pair is treated as
correlated list-aggregator evidence and cannot publish a severe downside price unless a separate hard or non-list family
also corroborates it.

### Publication Pool Challenge

`sync-stablecoins` invokes the pool challenge after primary consensus on every 15-minute publication. It remains a critical depeg safeguard: current published challenger pools can downgrade a weak soft-source result or replace it when the independent-protocol rules below are satisfied. The hourly fallback/address corroboration phase does not replace this check.

After consensus, weak soft-source results where the selected/agreeing source cluster is **pool-challenge eligible** are challenged against current individual priced pools from the published challenger snapshot (`dex_price_challenger_snapshots` + `dex_price_challengers`) that meet the live $100K TVL minimum and are fresh within `DEX_FRESHNESS_SEC`. Eligible source families include CoinGecko, DefiLlama-list, `dex-promoted`, and promoted protocol-level DEX sources (`fluid-dex`, `balancer-dex`, `curve-dex`, `uniswap-v3-dex`, `uniswap-v4-dex`, `raydium-dex`, `orca-dex`, `meteora-dex`, `pancakeswap-dex`, `aerodrome-dex`, `velodrome-dex`) as long as the selected cluster does not include an exempt hard source. Non-selected hard candidates do not by themselves exempt the selected soft result, but they can corroborate the narrow high-TVL replacement exception below. NAV tokens are excluded from the pool challenge entirely: their fair value is their published NAV and the peg-aware divergence threshold does not map to a meaningful DEX-liquidity check, so diverging pools cannot downgrade or replace a NAV price. The standard divergence threshold is **peg-type-aware**: 500 bps for USD pegs, `min(2× depeg threshold, 500)` for non-USD pegs (e.g., 300 bps for JPY/EUR). High-TVL replacement paths use the peg depeg threshold as their result-vs-pool trigger when the soft result is still inside that same threshold. If ANY qualifying protocol median diverges from the weak result beyond the applicable threshold:

Challenger publication preserves protocol diversity before applying its 95% qualifying-TVL coverage target: it first retains the highest-TVL qualifying pool from each protocol, ordered by total qualifying protocol TVL, then fills remaining slots from the global pool-TVL order until the coverage target or 50-row hard cap is reached. If more than 50 protocols qualify, representatives from the 50 largest protocol groups are retained. This prevents a dominant venue from consuming the coverage budget before a smaller independent protocol can reach the multi-protocol replacement check; it does not change the per-pool TVL floor, freshness rules, validation, or replacement thresholds. Challenger pools come only from the retained set that already passed the discovery-time pool-price coherence admission ([DEX Liquidity](https://pharos.watch/docs/dex-liquidity/#discovery-cron)), so a provider row whose tracked-leg price is incoherent with its own pair ratio never becomes challenge or DEX-bridge evidence.

1. Confidence downgrades to `low` only while the divergence is unresolved: the downgrade is skipped when **≥2 independent protocol medians corroborate** the selected price and strictly outnumber the diverging protocols (`corroboratingProtocolGroupsOutvote` in `worker/src/lib/constants.ts`, the same authority as the replacement precedence test). A tie, a diverging majority, or a single corroborating protocol still downgrades, and any replacement that happens still downgrades because DEX evidence displaced the consensus.
2. The price is **replaced** when diverging protocol-level challenger prices span **≥2 independent protocols**. A single protocol's pools may share data-quality issues (vault-token counterparties, misconfigured pairs), and one rogue pool inside an otherwise agreeing protocol does not make that protocol count as corroborating disagreement. A high-TVL multi-protocol path also replaces a near-peg soft result when at least two independent protocol medians each carry at least `$5M` TVL, are depeg-sized in the same direction, diverge from the soft result by at least the peg depeg threshold, and agree with each other inside the existing pool-challenge bps band. If an additional high-TVL protocol median shows the same direction but breaks pairwise coherence, Pharos selects the largest coherent same-direction high-TVL subset instead of letting that outlier veto the otherwise corroborated replacement. A narrow single-protocol exception exists when that protocol median carries at least the `$5M` high-TVL threshold, the protocol median itself is depeg-sized versus the peg reference, the DEX mark materially diverges from the published soft result, and a hard market/oracle/protocol primary candidate agrees with that protocol median within the normal consensus threshold. When replacement fires, Pharos first collapses each protocol to a TVL-weighted median price, then evaluates divergence and the final replacement from those protocol medians. When only one lower-TVL or uncorroborated protocol diverges, or no coherent high-TVL same-direction subset remains, the original price is preserved but confidence stays `low`. The diverging protocols must also not be outnumbered by the challenger protocols whose medians corroborate the current price: replacement weight is provider-reported challenger TVL and a dormant pool keeps its last traded price behind a large nominal reserve, so a two-protocol diverging minority could otherwise outvote a corroborated consensus (the 2026-09-24 `vchf-vnx` replacement used the Celo Uniswap v3 `VCHF/USD₮` pool, last traded 2026-03-15 behind a reported $4.7M reserve, against four protocols sitting on the ECB franc rate). A corroborating majority no longer downgrades confidence (see item 1); the high-TVL multi-protocol and single-protocol hard-corroborated exceptions above can still replace the price, and a replacement itself still downgrades.

Before any pool-challenge divergence or replacement decision, protocol-level challenger medians must pass the peg-aware `dex_observation` price validator. This keeps inverse or malformed commodity marks (for example `1 / XAUUSD` instead of a USD-per-ounce gold token price) from downgrading or replacing a healthy primary price, while valid depeg-sized DEX medians remain eligible for the normal replacement paths.

Pool replacement collapses `allPrices`, `observedAtBySource`, and `observedAtModeBySource` to `pool-tvl-weighted`, using the minimum contributing observation time and `local_fetch`. `agreeSources` becomes only that pool source; `candidateSources` retains earlier candidates and adds it, while `disagreeSources` becomes every other candidate. Downstream candidate-price checks therefore cannot reuse pre-replacement prices even though the diagnostic source roster is retained.

If the selected primary price is a severe fixed-peg downside and at least two live candidate sources independently
corroborate that downside by source family, including at least one depeg-authoritative source such as RedStone or Curve on-chain, pool challenge can still
downgrade confidence but cannot replace the selected price with a DEX pool median. The same candidate corroboration
also satisfies the temporal-jump guard when the previous trusted price was near peg. This keeps near-peg or stale DEX
liquidity from erasing a corroborated severe depeg while preserving the normal challenge behavior for weak,
uncorroborated soft-source prices.

Promotion consumes protocol aggregates; pool challenges consume dedicated challenger snapshots, not display-oriented top-pool summaries. These views cannot substitute for one another.

Dead or explicitly blocked DEX ids, including Bunni and its chain-scoped variants, are filtered upstream and cannot contribute challenger pools, promoted DEX bridge sources, or pool-challenge replacement marks.

This catches weak-source agreement derived from small pools while larger pools show a depeg. Exemption is registry-owned: a selected cluster containing a hard market/oracle/protocol source is not pool-challenged; RedStone does not require additional multi-venue agreement for that exemption.

---

### Timestamp Semantics

- `priceObservedAt`: effective observation time attached to the selected source price
- `priceObservedAtMode`: freshness provenance for `priceObservedAt`
- `priceObservedAtMode = "upstream"`: `priceObservedAt` came from source-native freshness metadata
- `priceObservedAtMode = "local_fetch"`: the source exposed no trustworthy upstream observation timestamp, so Pharos uses local fetch time instead
- `priceObservedAtMode = "unknown"`: legacy or carried-forward metadata did not preserve freshness provenance explicitly
- `priceSyncedAt`: when Pharos selected and wrote the price during the current sync
- `priceUpdatedAt`: compatibility alias for the effective observation timestamp, preserved so existing consumers do not interpret sync-write time as source freshness
- high-confidence cluster labels can describe multiple agreeing sources even when the published price is the cluster median rather than any one constituent source price

### Downstream Trust Semantics

- Source labels are normalized through the pricing-source registry before replay safety, pool-challenge eligibility, fallback-only classification, severe-downside corroboration, and depeg-authority checks run. Composite labels such as `coingecko+geckoterminal` are expanded into their component sources instead of being treated as unknown standalone sources.
- Every registered source declares a `depegSourceFamily`. CoinGecko-derived sources collapse to the `coingecko` family, DefiLlama list/detail/contract sources collapse to the `defillama` family, hard market/oracle/protocol sources keep provider-specific families, and promoted DEX lanes keep protocol-specific `dex:*` families. The same family map now defines independence before ordinary consensus clustering as well as severe-downside corroboration and downstream depeg confirmation.
- Fallback/search lanes remain non-authoritative even when their source labels appear inside composite strings. `coinmarketcap`, `defillama-contract`, and CoinGecko mirror/low-volume-style sources are treated as list aggregators for independence checks; Jupiter, DexScreener exact/search/address, DexPaprika, CoinGecko Onchain address augmentation, Alchemy Prices, Moralis, Birdeye, and cached replay cannot satisfy single-source depeg authority.
- Soft single-source prices are never depeg-authoritative
- Soft-only multi-source agreement can still publish, but it remains `confirm_required` downstream unless a hard authoritative source is present
- Hard single-source prices require `upstream` freshness, except legacy unset modes on upstream-capable sources; explicit `local_fetch` remains `confirm_required`
- Supported non-USD fiat assets can require a fresh direct native-peg corroboration step before a derived USD/FX move is allowed to publish, or to open, extend, or confirm downstream depeg state; when that native-implied mark is published, it remains a non-replay-safe fallback lane rather than cached consensus continuity
- Weak fixed-peg price jumps versus the previous trusted price are withheld until corroboration arrives

---

## Confidence Model

The final cached price can carry one of four confidence states:

| Value           | Meaning                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `high`          | 2 or more independent sources agree, or a validated authoritative override succeeded                                                                 |
| `single-source` | only one live source produced a usable price, or a 2-source agreeing cluster was downgraded because every agreeing member is a list-style aggregator |
| `low`           | multiple sources existed but failed to form a strong agreeing cluster                                                                                |
| `fallback`      | price came from enrichment rather than primary consensus                                                                                             |

Downstream consumers use these tags for display, depeg confirmation, and risk handling.

After consensus, `applyListAggregatorDowngrade()` expands composite source labels and downgrades 2-source clusters made entirely of list-style aggregators such as CoinGecko, DefiLlama-list, DefiLlama-contract, and CoinMarketCap from `high` to `single-source`, because those feeds can re-export overlapping upstream list data and are not treated as independent corroboration by themselves.

`sync-stablecoins` metadata records circulating-value confidence weights and valid reviewed missing-price counts for status display. These diagnostics do not alter price selection, publication or confidence assignment.

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`, or related provider modules
2. this document for canonical pricing behavior
3. [Supply Snapshot](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-pipeline), [Depeg Detection](https://pharos.watch/docs/depeg-detection/#stage-2----confirmation), [Pharos Stability Index](https://pharos.watch/docs/stability-index/#cron--storage), or [Blacklist Tracker](https://pharos.watch/docs/blacklist-tracker/#blacklist-sync-state-semantics) when the corresponding pipeline semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections-pricing.tsx`
5. `shared/lib/methodology-versions/registry.ts` and the matching entry under `shared/data/methodology-changelogs/pricing-pipeline/` if methodology semantics changed
6. [About Pharos](https://pharos.watch/about/) and `src/lib/about-content.ts` when externally visible data sources change

## Treasury Benchmark Rates

Benchmark feed/retry/fallback semantics are owned by [Yield Intelligence](https://pharos.watch/docs/yield-intelligence/#benchmark-registry), not live-price methodology.

## Stale Data Monitoring (Frontend)

Frontend banners distinguish stale/degraded backend generations from a recent browser fetch; route-monitored queries and freshness presets are independent of price admission. See [public status](https://pharos.watch/status/) for data health.
