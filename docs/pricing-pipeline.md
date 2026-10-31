# Pricing Pipeline

> **Agent navigation** — Current invariants and interfaces are below. Maintainers can read the [implementation appendix](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/pricing-pipeline-appendix.md) by routed section; it is not a second methodology authority.

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

Supply fallback admits only reviewed, fail-closed, double-count-safe observations; price recovery cannot manufacture supply. The [supply contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-pipeline) owns admission/clocks; the [integrity index](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/pricing-pipeline-appendix.md#data-integrity-guardrails) routes cross-domain protections.

Eligible CoinGecko-detail supply may attach a banded on-chain share partition while retaining its total, source, clock and history. USTB and gtUSDCp cannot receive or carry these partitions. Reviewed native-stock preferences instead replace mismatched caps, failing closed on unreadable legs; NAV valuation still needs an admitted market/NAV price. The [supply contract](supply-snapshot.md#supply-data-source) owns the reconciled perimeters.


---

## Overview

Pharos separates critical publication from best-effort corroboration:

1. **15-minute publication** runs the full primary consensus: DefiLlama and CoinGecko, the curated CoinGecko ticker and CEX lanes, Curve on-chain/oracle, reserve NAV telemetry, promoted DEX observations, and the post-consensus pool challenge. Registered authoritative overrides then run before publication.
2. **Hourly corroboration** runs after the existing `:09` status-check chain, ahead of the `:15` publication. This avoids the previous full publication-cycle wait after `:00` publication without putting provider requests on the primary path or extending source TTLs. It requires a valid published cache to build its cohort; unavailable or malformed cache reads leave the prior staging untouched. Fallback probes restore curated provider identifiers, contract overrides, and NAV hints omitted from public rows before enrichment. Original missing-price identity survives probe price clearing so bounded provider searches prioritize recovery over low-depth corroboration. It runs `enrichMissingPrices()` and the explicitly enabled exact-address provider against only the latest missing or low-depth rows. It stages actual fetched observations in `price:corroboration-observations:v1` for a later publication to revalidate, separately from ordinary `price_cache` replay provenance. Each hourly attempt also persists a bounded `price-corroboration` cron event with the scheduled slot, Worker version, resolution counts and provider status/error classes. Admin status exposes it as `sync-stablecoins.latestEvent` when it is the newest event; newer critical slot events take precedence. Provider URLs, credentials, response bodies and raw error messages are excluded. DexScreener diagnostics distinguish failed requests from successful empty or price-ineligible responses; circuit and price-admission rules are unchanged. The same 15-minute price-observation refresh also re-observes the rows whose published price comes from the exact-address lane, because those quotes live for a single publication window and are never replayable from `price_cache`; a row that lane prices, or any row still missing a price, gets a fresh exact-address observation each slot instead of waiting for the next hourly collection.

The `:09/:24/:39/:54` refresh also reruns eligible DefiLlama contract and Jupiter fallbacks with separate 25-second envelopes, without changing admission or source TTLs. Refreshed quotes keep fallback confidence and cannot become trusted inherited parents; a child's publication time never refreshes its parent observation.

Both publication paths record `priceObservationEffectiveness` in progress and final cron metadata, including the size-compacted main result. It reports staging status/slot/age, loaded and eligible observation counts, mutually exclusive discard reasons, and eligible outcomes (`alreadyPriced`, `assetAbsent`, `policyRejected`, `selected`, `notNeededAfterSelection`). Loaded count is `null` when the staging payload was not read or validated. Eligible outcomes sum to eligible observations; eligible plus discarded sum to loaded observations when known. `selected` means applied to the candidate payload, not independent proof of cache publication; use the final run's publication evidence and cache generation to confirm delivery. Minimum freshness headroom measures remaining source TTL among eligible observations. The shared completion path reads the existing staging cache even when all assets already have prices, with no additional provider requests or changes to admission, freshness or selection order.

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, optional `priceSourceConfidenceProfile`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

The public methodology's compact overview and current source-admission exceptions share typed content with its Markdown export in `src/lib/methodology-content.ts`. HBD, SOFID, ticker-only evidence, quarantine and original-clock caveats remain in the technical disclosure; source tables, formulas and bounded supply gap-fill rules retain their existing sections. Dated release and acceptance evidence belongs to canonical Pricing history, not a second overview diary.

USDFC is included in the reviewed CoinGecko low-volume fallback cohort. Its exact Filecoin token identity is verified against issuer deployments and CoinGecko metadata; sparse trading can leave an observed quote older than primary consensus permits. Recovery retains the original upstream clock and fallback confidence under the existing seven-day budget, without changing DefiLlama supply or treating the FIL collateral oracle as a USDFC market price.


## Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-pricing-pipeline -->`v6.63`<!-- GENERATED-END: methodology-version-pricing-pipeline -->
- **Canonical version module:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

The [public Pricing changelog](https://pharos.watch/methodology/pricing-pipeline-changelog/) owns release chronology, activation dates and retained historical behavior. Supply admission, historical-bucket conservation and repair clocks remain governed by the [supply contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-data-source), not by a second Pricing specification.

### Release obligations

Before releasing a Pricing methodology change, converge its runtime constant/registry, structured Pricing history, owning prose and public Pricing section, together with current-version route-parity fixtures and generated methodology documentation blocks. Public changelog metadata and Markdown exports derive from the registry. Provisional activation dates in structured history must be re-dated at release; the generated version marker above is not edited by hand.

Fixed-clock price/supply/valuation/coverage comparison remains a release prerequisite for the admitted-input and coverage changes. Fresh admitted producer observations and production resource evidence are separate acceptance gates, not conclusions established by a version bump or a passing local comparison. These obligations do not claim a completed replay or production-health observation.


---

## Native Hive HBD market

Pricing v6.53 is effective **2026-10-19 00:00 UTC** (`1792368000`). This release-date boundary does not claim completed production acceptance or backfill historical observations.

`hive-native-cg` submits `HIVE/USD ÷ midpoint(HBD/HIVE)` to ordinary primary consensus. Its exact CoinGecko `hive` parent rides the existing batch, never supply or a second HBD vote. The parent requires an upstream timestamp within five minutes, allowing at most 60 seconds future skew. A fresh publication cannot refresh either leg.

The [observer policy](https://github.com/TokenBrice/pharos-watch/blob/main/worker/src/lib/hive-market-price.ts) owns admission: fresh non-regressing heads, bounded same-node sampling, narrow spread, at least 500 HBD per side within 2% of midpoint, and at least 1,000 HBD proven non-self daily turnover with recent book-consistent activity. Posted inventory is not pool TVL; capped or indistinguishable duplicate fills prove only a lower bound.

The derived source uses soft-aggregator tier/weight 2 and the CoinGecko family, describing dependency-capped trust rather than the native venue type. Equal tier/weight lets a valid cross-rate survive family collapse against an out-of-bounds direct HBD mark before peg validation. Near-par direct CG can still beat a native depeg. Alone, or with only direct CG, confidence remains single-source and depeg trust `confirm_required`. No protocol override, replay safety or validation/pool-challenge exemption is granted.

The effective observation clock is the earlier of book retrieval and parent upstream time, conservatively `local_fetch` because the book has no native observation clock. Both clocks, policy and generation remain in bounded operator metadata. Failed gates omit only the native candidate. Existing HBD low-volume fallback, supply and historical observations remain unchanged. See the [implementation contract](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/pricing-pipeline-appendix.md#native-hive-order-book) for limits and rollout.

## Primary Consensus

`fetchPrimaryPrices()` combines DefiLlama intake, CoinGecko, curated exchange tickers, Curve, reserve NAV and promoted DEX observations in the critical 15-minute depeg path, then applies pool challenge. Registered protocol/NAV overrides may replace that result afterward. Missing-price fallback/exact-address requests remain outside this invocation: broad corroboration is hourly; short-lived contract, Jupiter, exact-address and exact-DEX quotes refresh quarter-hourly.

CoinMarketCap fallback is outside primary consensus. [Fallback enrichment](process/pricing-pipeline-appendix.md#fallback-enrichment) owns exact-slug/category matching, targeted chain/address identity and verified-cache admission.

Fallback providers return explicit confidence and observation provenance with every recovered quote; publication never synthesizes missing confidence. Both intake paths reuse their initial authoritative overrides and replay snapshot for shared completion, retaining the later local-only dependency repair and nominal-reference settlement. Their discriminated publication context selects the existing path-specific labels and main-only DefiLlama circuit bookkeeping.

The DefiLlama-list consensus input accepts only intake prices with an absent source or an explicit `defillama` / `defillama-list` origin, and still excludes `coingecko-fallback` supply rows. Supplemental contract quotes and other named price sources retain their own provenance and cannot be relabeled `defillama-list`, including when their supply comes from an on-chain read. A DefiLlama quote exactly at the peg reference (1.0 for USD) is a flat list default, not an observed quote: publication rejects it as `exact_par_list_price_requires_corroboration` and leaves the row unavailable unless an admitted source from another family corroborates it. The contract lane shares the DefiLlama family and cannot corroborate the list.

Tracked NAV classification is authoritative in both intake normalization and price-validation context: an omitted curated NAV flag means false, and a provider's `navToken: true` cannot bypass fixed-peg validation. Untracked rows retain their source classification.
Outcome bookkeeping and shared DEX read-clock handling follow the [implementation details](process/pricing-pipeline-appendix.md#primary-collection-bookkeeping); required admission stays fail-closed.


### Source Weights

| Source | Weight | Module / Origin | Cadence and role |
| --- | ---: | --- | --- |
| CoinGecko `/simple/price` | 2 | `worker/src/lib/coingecko-simple-price.ts` | One live primary fetch surface per 15-minute publication; uses upstream `last_updated_at` when available and rejects stale rows. |
| CoinGecko ticker | 2 | `worker/src/lib/cg-ticker.ts` | Curated exchange-ticker corroboration for the tracked Kinesis assets. |
| Hive market × CG HIVE/USD | 2 | `worker/src/lib/hive-market-price.ts` | Depth-gated, CG-dependent primary cross-rate; not independent CG corroboration. |
| DefiLlama stablecoins list | 1 | Typed quote from the intake response | Local primary input on every 15-minute publication; no second request. |
| Binance spot | 2 | `worker/src/lib/cex-tickers.ts` | Batch venue input retained in 15-minute consensus. |
| Kraken spot | 2 | `worker/src/lib/cex-tickers.ts` | Explicit-pair venue input with alias-safe symbol mapping. |
| Bitstamp spot | 1 | `worker/src/lib/cex-tickers.ts` | Lower-weight all-tickers corroboration venue. |
| Coinbase spot | 2 | `worker/src/lib/cex-tickers.ts` | Per-symbol venue input. |
| Curve on-chain and crvUSD oracle | 3 | `worker/src/lib/curve-onchain.ts` | Configured pool routes plus the crvUSD PriceAggregator oracle. |
| Chainlink/Superstate/JPMorgan reserve NAV telemetry | 3 | `reserve_composition` | Matched fresh reserve snapshots, with fresh/static FX conversion for non-USD NAVs. |
| Promoted DEX protocol lanes | 2–3 | `worker/src/lib/depeg-helpers.ts` | Per-protocol observations from `dex_prices`; each lane must agree with a hard source or an independent promoted DEX lane, and the aggregate is withheld once an overlapping protocol candidate passes registry, freshness, price and TVL checks, even when every lane then fails corroboration. |
| Authoritative protocol/NAV overrides | authoritative replacement | `worker/src/lib/authoritative-price-sources/` | Bounded route registry evaluated after primary consensus for assets with a registered known source. |
| CoinGecko Onchain exact-address | provenance weight 1 | `worker/src/lib/address-price-providers/coingecko-onchain.ts` | Hourly corroboration plus slot-level refresh for missing/address-priced rows; outside the main publication invocation. |

Reserve NAV/supply share configuration-bound successful evidence, independent fetch/source-age checks and trusted FX, never nominal $1. JPMorgan requires current issuer-class/latest-attempt linkage; Chainlink/Superstate may retain current success after a failed attempt. [Decoder and valuation details](process/pricing-pipeline-appendix.md#primary-collection-bookkeeping) own adapter policies and unavailable-evidence handling.

Curve USDT-reference pools first value USDT through its existing USDC anchor. USAT, Quantoz USDQ, sUSDS and USDx multiply their pool ratios by the admitted USDT USD quote; DOLA explicitly permits the two-dependency DOLA -> sUSDS -> USDT path. sUSDe's DOLA pool reuses that path, USD3's, DUSD's and trUSD's frxUSD pools reuse the existing frxUSD -> crvUSD route, reUSD's fxUSD pool reuses the existing fxUSD route, and scrvUSD chains through reUSD; MUSD's 2pool metapool resolves through its USDC underlying, and sUSDe's raw ratio is not multiplied by the ERC-4626 rate because its vault rate is internal. Missing or stale dependencies withhold the quote, and the oldest contributing observation dates the result.

Promoted DEX corroboration is candidate-scoped. A hard-source match admits only the agreeing protocol lane, while DEX-only corroboration requires an independent protocol lane within the existing divergence threshold. Divergent siblings are excluded with `lacked_corroboration` telemetry rather than inheriting another lane's evidence.

The primary CEX, ticker, oracle, promoted-DEX, reserve-telemetry and pool-challenge lanes protect depeg detection within publication. Exact-address transport remains detached; CoinGecko Onchain is the sole retained adapter and requires explicit allowlisting. Retired source registry keys, including `pyth` and `redstone`, remain renderable for historical provenance but cannot contribute live observations.

The current exact-address lane also requires a configured CoinGecko key and canonical deployment identity. It targets missing prices or below-target source depth under its existing freshness, liquidity and request-budget gates; hourly corroboration and slot-level refresh neither bypass admission nor renew an old observation. DexScreener exact-pool enrichment/refresh is a separate live fallback, not the retired DexScreener address-provider adapter; retired adapters belong in the canonical pricing release history, not the active inventory.

Both exact-address callers share one enabled predicate, a flat target list and a scalar circuit outcome. The comma-separated allowlist remains explicit opt-in; no candidates recover successfully, blocked or unattempted work stays neutral, and an answered 404 is an unindexed deployment rather than a provider outage.

Kraken's curated `SOFIDUSD`, `FRNTUSD`, `CASHUSD` and `USDGOUSD` books supply those assets' hard-market quotes; the 2026-10-30 review added the `ZCHFUSD`, `USDSMUSD`, `USDSUIUSD`, `USDPTUSD`, `EUROPUSD`, `QCADUSD`, `AUDXUSD` and `BRL1USD` books for the coins those CoinGecko ticker sets name. Coinbase's `XSGD-USDC` FX-stablecoin book adds XSGD on the reviewed USDC-at-par precedent, and its last-trade clock rejects sparse prints. SoFiUSD has no nominal-par override; admitted consensus uses ordinary validation. Midpoints keep local-fetch clocks and never become single-source depeg authority; absent or stale quotes stay unavailable, never par, and registration alone is not a published observation. [Kraken exact markets](process/pricing-pipeline-appendix.md#provider-specific-normalization) own identity joins and failure detail.

USDY uses `detailProvider: "coingecko"` so its supplemental lane admits a fresh CoinGecko price and market cap without a live DefiLlama row; an admitted row's primary supply still wins. USYC, reUSD, USP and USD3 (on-chain roster supply) follow it after DefiLlama's 2026-10-14 delisting.

### Nominal-reference recovery boundary

`protocol-par` is a nominal reference, never an observed market quote. The current nominal routes are Bima USBD, Quill USDQ (`usdq-quill`, not Quantoz USDQ), Mento XOFm, Mento ZARm and the M0 extension KAST USDK (`usdk-kast`) on M0's reviewed 1:1 USDC redemption route. `isObservedPrice()` rejects both the nominal observation mode and any composite source containing `protocol-par`; a fresh sync timestamp does not make parity observed.

Primary collection already includes assets with retained DEX rows or protocol-source observations, independent of their incumbent price. Each registered promoted protocol lane must pass its existing freshness policy, the $50,000 per-lane TVL floor and candidate-scoped 50-bps corroboration from a hard source or a different DEX source family. One protocol on two chains is not independent corroboration. Admission to primary consensus is distinct from nominal-reference precedence: even an independently corroborated DEX-only consensus remains `confirm_required`, because promoted DEX lanes are not depeg-authoritative.

`isTrustedMarketQuote()` and final `settleNominalPriceReferences()` retain nominal publication unless the incumbent passes the existing authoritative depeg-trust gate. Therefore adding an exact-address refresh probe, an exchange symbol without verified token identity, a coverage review, provider registration, price-gap acknowledgement or soft-source corroboration cannot by itself recover these assets' observed peg inputs: recovery needs an identity-safe observed path that already satisfies that gate, and changing the gate is a separate pricing-methodology decision. Non-USD recovery also requires its independently fresh native FX reference: PHT is PHP-pegged, XOFm is XOF-pegged, and ZARm is ZAR-pegged, never $1-pegged.

The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) is excluded from primary consensus because it re-exports CoinGecko and cannot establish independent agreement. Exact contract-address queries remain eligible only for fallback enrichment.

### Consensus Rules

Before clustering, duplicate source keys collapse to their median, maximum configured weight and conservative observation time. Keys sharing a `depegSourceFamily` then reduce to its strongest representative: correlated provider deployments or CoinGecko list/ticker lanes cannot add votes or median weight.

`computePriceConsensus()` then behaves as follows:

1. 0 sources -> no result
2. 1 source -> `single-source`
3. 2+ sources -> build fully pairwise agreement clusters within a peg-aware threshold
4. best cluster with 2+ members -> initially `high` confidence, publish the cluster median, and keep the best trusted member as internal provenance. Even clusters average the middle sorted pair: 1.0000/1.0001 yields 1.00005, not four-decimal display rounding.
5. no 2+ cluster:
   - fixed pegs -> stay in fixed-peg mode even if the reference price is temporarily unavailable; choose the best trusted fallback source by trust tier first, then reference proximity, and mark `low`
   - NAV tokens -> use a wider 500 bps cluster threshold first, otherwise choose the best trusted fallback source and mark `low`

When multiple clusters have the same size, the winner is chosen deterministically by:

1. larger total cluster weight
2. stronger trust tier (any hard-tier member > mixed > all soft)
3. tighter internal spread
4. proximity to peg reference (when available)
5. stable alphabetical source label as the final tie-break

Source labels list agreeing sources alphabetically, joined with `+` without truncation (one source uses its name directly). Internal provenance ranks the cluster's best member by configured weight, trust tier, reference proximity, then alphabetical source key.

Severe fixed-peg downside candidate evidence survives prevalidation and post-enrichment validation while price, source and confidence match the selected primary result. If fallback replaces it, post-enrichment validation combines the current fallback quote with same-run primary candidates, so corroborated low-confidence depegs survive without admitting unrelated, correlated list-only or stale prices.

Downside corroboration counts independent families: CoinGecko-derived lanes share one, DefiLlama list/detail/contract share one, CEX/oracle providers each retain theirs, and promoted DEX lanes count by protocol. CoinGecko plus DefiLlama-list alone is correlated list-aggregator evidence; severe downside needs another corroborating hard or non-list family.

### Publication Pool Challenge

`sync-stablecoins` invokes the pool challenge after primary consensus on every 15-minute publication. It remains a critical depeg safeguard: current published challenger pools can downgrade a weak soft-source result or replace it under the independent-protocol rules below; the hourly fallback/address corroboration phase does not replace this check.

After consensus, weak soft-source results where the selected/agreeing source cluster is **pool-challenge eligible** are challenged against current individual priced pools from the accepted immutable challenger publication that meet the live $100K price-evidence TVL minimum and `DEX_FRESHNESS_SEC` freshness. Eligible source families include CoinGecko, DefiLlama-list, `dex-promoted`, and promoted protocol-level DEX sources (`fluid-dex`, `balancer-dex`, `curve-dex`, `uniswap-v3-dex`, `uniswap-v4-dex`, `raydium-dex`, `orca-dex`, `meteora-dex`, `pancakeswap-dex`, `aerodrome-dex`, `velodrome-dex`, `aero-dex`) as long as the selected cluster does not include an exempt hard source. Non-selected hard candidates do not by themselves exempt the selected soft result, but they can corroborate the narrow high-TVL replacement exception below. NAV tokens are never pool-challenged: their fair value is their published NAV, which the peg-aware divergence threshold cannot test against DEX liquidity, so diverging pools cannot downgrade or replace it. The standard divergence threshold is **peg-type-aware**: 500 bps for USD pegs, `min(2× depeg threshold, 500)` for non-USD pegs. High-TVL replacement paths use the peg depeg threshold as their result-vs-pool trigger when the soft result is still inside that same threshold. If ANY qualifying protocol median diverges from the weak result beyond the applicable threshold:

Challengers preserve protocol diversity before 95% coverage and the 50-row cap. Admission and weights use `min(retained TVL, priceEvidenceTvlUsd ?? retained TVL)` and `priceSource ?? source`; publication never renews quotes. [Selection details](process/pricing-pipeline-appendix.md#primary-collection-bookkeeping) own ordering and exact empty/fallback semantics.

1. Confidence downgrades to `low` only while the divergence is unresolved: the downgrade is skipped when **≥2 independent protocol medians corroborate** the selected price and strictly outnumber the diverging protocols (`corroboratingProtocolGroupsOutvote` in `worker/src/lib/constants.ts`, the same authority as the replacement precedence test). A tie, a diverging majority, or a single corroborating protocol still downgrades, and any replacement that happens still downgrades because DEX evidence displaced the consensus.
2. The price is **replaced** when diverging protocol-level challenger prices span **≥2 independent protocols**: one protocol's pools may share data-quality issues, and one rogue pool inside an otherwise agreeing protocol does not make that protocol count as disagreement. Replacement first collapses each protocol to a TVL-weighted median, then evaluates divergence and the final replacement on those medians. A high-TVL multi-protocol path also replaces a near-peg soft result when at least two independent protocol medians each carry at least `$5M` TVL, are depeg-sized in the same direction, diverge from the soft result by at least the peg depeg threshold, and agree with each other inside the pool-challenge bps band; an additional same-direction high-TVL median that breaks pairwise coherence cannot veto, as Pharos selects the largest coherent same-direction high-TVL subset. A narrow single-protocol exception applies when that protocol median carries at least `$5M` TVL, is itself depeg-sized versus the peg reference, materially diverges from the published soft result, and a hard market/oracle/protocol primary candidate agrees with it within the normal consensus threshold. With only one lower-TVL or uncorroborated diverging protocol, or no coherent high-TVL same-direction subset, the price is preserved at `low` confidence. Diverging protocols must also not be outnumbered by challenger protocols corroborating the current price: replacement weight is provider-reported TVL, and a dormant pool keeps its last traded price behind a large nominal reserve (on 2026-09-24 a Celo Uniswap v3 `VCHF/USD₮` pool last traded 2026-03-15 behind a reported $4.7M reserve replaced `vchf-vnx` against four protocols on the ECB franc rate). These exceptions can still replace against a corroborating majority; any replacement downgrades (item 1).

Before any pool-challenge divergence or replacement decision, protocol-level challenger medians must pass the peg-aware `dex_observation` price validator. This stops inverse or malformed commodity marks from downgrading or replacing a healthy primary price, while valid depeg-sized DEX medians remain eligible for the normal replacement paths.

Replacement retains diagnostic candidates but discards their pre-replacement prices; only `pool-tvl-weighted` contributes, with the oldest contributing clock and `local_fetch` provenance.

If the selected primary price is a severe fixed-peg downside and at least two live candidate sources independently corroborate that downside by source family, including at least one depeg-authoritative source such as Curve on-chain, pool challenge can still downgrade confidence but cannot replace the selected price with a DEX pool median. The same candidate corroboration also satisfies the temporal-jump guard when the previous trusted price was near peg, so near-peg or stale DEX liquidity cannot erase a corroborated severe depeg while weak, uncorroborated soft sources keep the normal challenge behavior.

Promotion consumes protocol aggregates; pool challenges consume dedicated challenger snapshots, not display-oriented top-pool summaries. These views cannot substitute for one another.

Dead or explicitly blocked DEX ids, including Bunni and its chain-scoped variants, are filtered upstream and cannot contribute challenger pools, promoted DEX bridge sources, or pool-challenge replacement marks.

This catches weak-source agreement derived from small pools while larger pools show a depeg. Exemption is registry-owned: a selected cluster containing a hard market/oracle/protocol source is not pool-challenged.

---

### Timestamp Semantics

- `priceObservedAt`: effective observation time attached to the selected source price
- `priceObservedAtMode`: freshness provenance for `priceObservedAt`
- `priceObservedAtMode = "upstream"`: from source-native freshness metadata
- `priceObservedAtMode = "local_fetch"`: no trustworthy upstream timestamp, so Pharos uses local fetch time
- `priceObservedAtMode = "unknown"`: legacy or carried-forward metadata did not preserve freshness provenance
- `priceSyncedAt`: when Pharos selected and wrote the price during the current sync
- `priceUpdatedAt`: compatibility alias for the effective observation timestamp, so existing consumers do not read sync-write time as source freshness
- high-confidence cluster labels can name multiple agreeing sources even when the published price is the cluster median rather than any constituent price

Inherited protocol/NAV prices retain the parent's admitted source observation clock. A recent `priceSyncedAt` never rescues stale composite provenance, including pre-intake supply NAV valuation, whose parent may be an admitted same-run direct CoinGecko quote (including BOLD for the reviewed sBOLD/yBOLD vaults and USN for sUSN); without an admissible parent the child remains unavailable. A published parent-derived quote carries optional `priceDerivation` (parent ID, source, confidence, clock, replay safety, plus `navMethod` for a successful live vault read or `cachedVaultRate` with its original `rateObservedAt`); it is attribution only, travels with that quote through list, detail, live-summary and integration-summary projections, and is cleared whenever the quote is replaced, nominal or unavailable. The Price Transparency card does not render it. Date-only FX observations must name a real ISO calendar day no later than the run's UTC day. Today's daily payload remains valid before its nominal publication hour; a future day cannot gain freshness by clamping its synthetic timestamp to the run clock. Injected frozen-coin rows keep the captured row's own provenance: `capturedAt` is the observation clock, and a captured price outside its source's freshness budget is cleared instead of being republished as a this-run DefiLlama quote.

Zephyr Scanner distinguishes genuinely absent clocks from present-but-invalid, stale or excessively future-skewed clocks: a rejected scanner clock withholds its price rather than becoming an undated or local-fetch quote, and ZYS's dependent NAV supply valuation is withheld too. ZSD keeps its separate official-circulation supply policy, and an independently admitted preferred market quote keeps its own observation clock. Absent scanner clocks retain the existing undated-price behavior; see the [Zephyr supplemental lane](process/pricing-pipeline-appendix.md#zephyr-scanner-supplemental-lane).

The hourly DEX writer separately retains original quote clocks in `dex_prices.price_sources_json`: per-family `observedAt` and aggregate-contributor `aggregateObservedAt`, independent of the row's publication `updated_at`. Original registry price clocks survive pool shaping, deduplication and scoring-stage serialization; an old quote wrapped in a new generation remains old evidence. Shared source admission requires the original family quote within the caller's 35-minute source budget and the original aggregate contributors within the 75-minute depeg budget, inclusively and without future clocks. Missing or invalid clocks cannot inherit `updated_at` or a legacy source `updatedAt`; admitted sources expose their original `observedAt` as the internal `updatedAt` consumed by promoted lanes. Strict reader activation follows an accepted clocked-writer publication, not the writer deployment alone.

### Downstream Trust Semantics

- Source labels are normalized through the pricing-source registry before replay safety, pool-challenge eligibility, fallback-only classification, severe-downside corroboration, and depeg-authority checks run. Composite labels such as `coingecko+geckoterminal` are expanded into their component sources instead of being treated as unknown standalone sources.
- Every registered source declares a `depegSourceFamily`: CoinGecko-derived sources collapse to `coingecko`, DefiLlama list/detail/contract sources to `defillama`, hard market/oracle/protocol sources keep provider-specific families, and promoted DEX lanes keep protocol-specific `dex:*` families. This one family map defines independence for ordinary consensus clustering, severe-downside corroboration and downstream depeg confirmation.
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

`sync-stablecoins` metadata records circulating-value confidence weights and valid reviewed missing-price counts for status display, plus the depeg observation census as `quality.depegObservation`. Unavailable census inputs add the `depeg-observation-incomplete` quality reason without changing execution status. If detection stops before a census exists, the field is null and `quality.depegObservationUnavailableReason` says why. These diagnostics do not alter price selection, publication or confidence assignment.

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`, or related provider modules
2. this document for canonical pricing behavior
3. [Supply Snapshot](https://github.com/TokenBrice/pharos-watch/blob/main/docs/supply-snapshot.md#supply-pipeline), [Depeg Detection](https://pharos.watch/docs/depeg-detection/#stage-2----confirmation), [Pharos Stability Index](https://pharos.watch/docs/stability-index/#cron--storage), or [Blacklist Tracker](https://github.com/TokenBrice/pharos-watch/blob/main/docs/blacklist-tracker.md#blacklist-sync-state-semantics) when the corresponding pipeline semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections-pricing.tsx`
5. `shared/lib/methodology-versions/registry.ts` and the matching entry under `shared/data/methodology-changelogs/pricing-pipeline/` if methodology semantics changed
6. [About Pharos](https://pharos.watch/about/) and `src/lib/about-content.ts` when externally visible data sources change

## Treasury Benchmark Rates

Benchmark feed/retry/fallback semantics are owned by [Yield Intelligence](https://pharos.watch/docs/yield-intelligence/#benchmark-registry), not live-price methodology.

## Stale Data Monitoring (Frontend)

Frontend banners distinguish stale/degraded backend generations from a recent browser fetch; route-monitored queries and freshness presets are independent of price admission. See [public status](https://pharos.watch/status/) for data health.
