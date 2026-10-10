# Pricing Pipeline

> **Agent navigation** — Current invariants and interfaces are below. Detailed implementation and historical decisions are retained in the [appendix](./process/pricing-pipeline-appendix.md). Read routed sections rather than either file wholesale.

Canonical reference for Pharos live-price selection, fallback enrichment, and source-specific normalization.

Supply fallback behavior is owned by [Supply Snapshot: Supply Pipeline](./supply-snapshot.md#supply-pipeline). Cross-pipeline cache and integrity guardrails are retained in [Data Integrity Guardrails](process/pricing-pipeline-appendix.md#data-integrity-guardrails) below.


---

## Overview

Pharos separates critical publication from best-effort corroboration:

1. **15-minute publication** runs the full primary consensus: DefiLlama and CoinGecko, the curated CoinGecko ticker and CEX lanes, RedStone, Curve on-chain/oracle, reserve NAV telemetry, promoted DEX observations, and the post-consensus pool challenge. Registered authoritative overrides then run before publication.
2. **Hourly corroboration** runs after the existing `:09` status-check chain, ahead of the `:15` publication. This avoids the previous full publication-cycle wait after `:00` publication without putting provider requests on the primary path or extending source TTLs. It requires a valid published cache to build its cohort; unavailable or malformed cache reads leave the prior staging untouched. Fallback probes restore curated provider identifiers, contract overrides, and NAV hints omitted from public rows before enrichment. Original missing-price identity survives probe price clearing so bounded provider searches prioritize recovery over low-depth corroboration. It runs `enrichMissingPrices()` and the explicitly enabled exact-address provider against only the latest missing or low-depth rows. It stages actual fetched observations in `price:corroboration-observations:v1` for a later publication to revalidate, separately from ordinary `price_cache` replay provenance. Each hourly attempt also persists a bounded `price-corroboration` cron event with the scheduled slot, Worker version, resolution counts and provider status/error classes. Admin status exposes it as `sync-stablecoins.latestEvent` when it is the newest event; newer critical slot events take precedence. Provider URLs, credentials, response bodies and raw error messages are excluded. DexScreener diagnostics distinguish failed requests from successful empty or price-ineligible responses; circuit and price-admission rules are unchanged. The same 15-minute price-observation refresh also re-observes the rows whose published price comes from the exact-address lane, because those quotes live for a single publication window and are never replayable from `price_cache`; a row that lane prices, or any row still missing a price, gets a fresh exact-address observation each slot instead of waiting for the next hourly collection.

Both publication paths record `priceObservationEffectiveness` in progress and final cron metadata, including the size-compacted main result. It reports staging status/slot/age, loaded and eligible observation counts, mutually exclusive discard reasons, and eligible outcomes (`alreadyPriced`, `assetAbsent`, `policyRejected`, `selected`, `notNeededAfterSelection`). Loaded count is `null` when the staging payload was not read or validated. Eligible outcomes sum to eligible observations; eligible plus discarded sum to loaded observations when known. `selected` means applied to the candidate payload, not independent proof of cache publication; use the final run's publication evidence and cache generation to confirm delivery. Minimum freshness headroom measures remaining source TTL among eligible observations. The shared completion path reads the existing staging cache even when all assets already have prices, with no additional provider requests or changes to admission, freshness or selection order.

The output is the cached `price`, `priceSource`, `priceConfidence`, `priceObservedAt`, `priceObservedAtMode`, `priceSyncedAt`, optional `priceSourceConfidenceProfile`, and compatibility `priceUpdatedAt` fields served through `/api/stablecoins`.

When an asset still has no usable current price after validation and fallback recovery, Pharos keeps `price = null`, `priceConfidence = null`, and serializes `priceSource = "missing"` so the cache payload stays structurally valid while still making the missing-price state explicit.

## Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-pricing-pipeline -->`v6.45`<!-- GENERATED-END: methodology-version-pricing-pipeline -->
- **Canonical version module:** `shared/lib/methodology-versions/registry.ts`
- **Public changelog route:** `/methodology/pricing-pipeline-changelog/`
- **Longform methodology section:** `/methodology/#pricing-pipeline-methodology`

The 2026-10-09 `v6.45` change adds a sticky chain-dropout guard for DefiLlama list supply. A positive row whose chain current is null, zero, or at most half of a persisted vetted per-chain baseline (at least $1M) no longer publishes that collapse as supply. The chain is repaired from a reviewed issuer-native on-chain read or a fresh DefiLlama per-chain daily point; otherwise it is published as `null`. A material deficit (at least 2%) quarantines the asset with `supplyRestored`, carrying the frozen baselines for at most 7 days and then publishing unavailable supply, never accepting the collapse because time passed. The trigger was the 2026-10-09 DefiLlama list regression that understated USDG by 47% and USDC by $7.5B. Contract and thresholds: [Chain dropout guard](./supply-snapshot.md#chain-dropout-guard). The entry provisionally activates at 2026-10-10 00:00 UTC and must be re-dated at release.

The 2026-10-08 `v6.44` change makes discovery CoinGecko Tickers price-only: admission requires at least $1,000 observed USD flow, non-future evidence within 24h and peg-aware plausibility; aggregate median weight is observed flow × existing ticker confidence (0.55), not synthetic TVL/depth. A ticker-only `dex_prices` publication may have `source_total_tvl = 0` but remains behind the unchanged primary, UI and depeg trust gates. Liquidity v6.93 independently removes synthetic ticker liquidity and fixes the registry evaluation clock. Both entries provisionally activate at 2026-10-09 00:00 UTC and must be re-dated at release; Safety formula is unchanged and improved Safety Score stability is unmeasured.

The 2026-10-08 `v6.43` release makes JLTXX native-share admission unconditional: a positive CoinGecko market cap cannot bypass a complete pinned pass. Finalized EIP-1898 reads retain raw `totalSupply`, observed decimals, canonical hash and block time. The original transaction-NAV dealing date must fit a reviewed NAV-versus-block temporal policy and legal tokenized/untokenized native-share perimeter; class assets remain diagnostic, never token circulation. Staged bootstrap can capture evidence but cannot activate the asset, mutate accepted generations or publish scores. JLTXX remains quarantined with its existing October 10 review deadline until an explicit operator decision and real runtime price/market-cap PASS; no approval or runtime observation is claimed by this release note.

---

## Primary Consensus

`fetchPrimaryPrices()` keeps the established depeg-protective consensus in the critical 15-minute publication path. It combines DefiLlama intake observations with CoinGecko, curated exchange tickers, RedStone, Curve, reserve NAV telemetry, and promoted DEX observations, then applies the pool challenge. Registered authoritative protocol/NAV overrides run afterward and may replace the selected market price. Only the five missing-price fallback passes and exact-address providers are detached to hourly corroboration.

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
| CoinGecko Onchain exact-address | provenance weight 1 | `worker/src/lib/address-price-providers/coingecko-onchain.ts` | Hourly corroboration only, limited to the prior publication's missing or fewer-than-three-source rows; never blocks the 15-minute publication. |

Reserve NAV quotes use the shared decoder in `worker/src/lib/reserve-nav-price.ts`. It accepts only registered NAV adapters, independently checks the successful snapshot fetch age and upstream NAV evidence clock, and rejects invalid/nonpositive NAV, missing or malformed metadata, and stale or excessively future evidence. JPMorgan JLTXX uses the exact issuer Token Class transaction NAV with the shared five-day business-day NAV source-age policy; Chainlink and Superstate retain their existing source-specific policies. Supply admission can read the same matched successful snapshot before a new NAV asset has a previous stablecoin cache row: `fiat-cg.ts` values positive native on-chain supply at that observed NAV and applies the existing trusted FX conversion for non-USD classes. This valuation does not itself fabricate a published market quote; primary reserve-NAV consensus supplies the live price. A missing/stale NAV and absent alternative trusted price leave the candidate out, rather than assigning nominal $1.

Both primary collection and supplemental supply use `decodeCurrentReserveNavPrice()` to require the current semantic configuration fingerprint and canonical successful snapshot/attempt linkage for every NAV adapter. Fresh evidence from prior same-adapter oracle/token/method parameters is unavailable. A later failed attempt does not retire an otherwise current Chainlink/Superstate success; JPMorgan retains its stricter current issuer-class/latest-attempt binding. Fetch and source-age checks remain independent of configuration identity.

Promoted DEX corroboration is candidate-scoped. A hard-source match admits only the agreeing protocol lane, while DEX-only corroboration requires an independent protocol lane within the existing divergence threshold. Divergent siblings are excluded with `lacked_corroboration` telemetry rather than inheriting another lane's evidence.

The primary CEX, ticker, oracle, promoted-DEX, reserve-telemetry, and pool-challenge lanes remain part of `sync-stablecoins` publication because they protect depeg detection. Inline exact-address transport does not. DexScreener-address, DexPaprika-address, Alchemy-address, Moralis-address, and Birdeye-address adapters were removed; CoinGecko Onchain is the only retained exact-address adapter and is disabled unless explicitly allowlisted.

Pyth Hermes was retired from live primary consensus on 2026-08-26 after Pyth's API-key mandate made the free tier unavailable for API access. New runs do not request the Pyth lane and stablecoin metadata no longer carries `pythFeedId`; the pricing registry retains the retired `pyth` key only so historical price provenance remains renderable.

Kraken's curated `SOFIDUSD` market supplies SoFiUSD's hard-market quote through the existing batched ticker request. Its bid/ask midpoint can corroborate a fresh CoinGecko quote, but the ticker retains its local-fetch clock: that pair alone does not satisfy nominal-par precedence's unchanged depeg-authoritative trust gate. A second agreeing depeg-authoritative source or an admitted upstream-capable authoritative source is still required. Provider registration alone does not establish a published observed price; unavailable or non-agreeing observations retain their ordinary admission behavior.

> **Historical note (v2.0→v2.1):** The DL coins API (`coins.llama.fi/prices/current/coingecko:{id}`) was removed from primary consensus because it returned CoinGecko-sourced data, creating illusory two-source agreement. It is still used in fallback enrichment via contract-address queries.

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

Challenger publication preserves protocol diversity before applying its 95% qualifying-TVL coverage target: it first retains the highest-TVL qualifying pool from each protocol, ordered by total qualifying protocol TVL, then fills remaining slots from the global pool-TVL order until the coverage target or 50-row hard cap is reached. If more than 50 protocols qualify, representatives from the 50 largest protocol groups are retained. This prevents a dominant venue from consuming the coverage budget before a smaller independent protocol can reach the multi-protocol replacement check; it does not change the per-pool TVL floor, freshness rules, validation, or replacement thresholds. Challenger pools come only from the retained set that already passed the discovery-time pool-price coherence admission ([DEX Liquidity](./dex-liquidity.md#discovery-cron)), so a provider row whose tracked-leg price is incoherent with its own pair ratio never becomes challenge or DEX-bridge evidence.

1. Confidence downgrades to `low` only while the divergence is unresolved: the downgrade is skipped when **≥2 independent protocol medians corroborate** the selected price and strictly outnumber the diverging protocols (`corroboratingProtocolGroupsOutvote` in `worker/src/lib/constants.ts`, the same authority as the replacement precedence test). A tie, a diverging majority, or a single corroborating protocol still downgrades, and any replacement that happens still downgrades because DEX evidence displaced the consensus.
2. The price is **replaced** when diverging protocol-level challenger prices span **≥2 independent protocols**. A single protocol's pools may share data-quality issues (vault-token counterparties, misconfigured pairs), and one rogue pool inside an otherwise agreeing protocol does not make that protocol count as corroborating disagreement. A high-TVL multi-protocol path also replaces a near-peg soft result when at least two independent protocol medians each carry at least `$5M` TVL, are depeg-sized in the same direction, diverge from the soft result by at least the peg depeg threshold, and agree with each other inside the existing pool-challenge bps band. If an additional high-TVL protocol median shows the same direction but breaks pairwise coherence, Pharos selects the largest coherent same-direction high-TVL subset instead of letting that outlier veto the otherwise corroborated replacement. A narrow single-protocol exception exists when that protocol median carries at least the `$5M` high-TVL threshold, the protocol median itself is depeg-sized versus the peg reference, the DEX mark materially diverges from the published soft result, and a hard market/oracle/protocol primary candidate agrees with that protocol median within the normal consensus threshold. When replacement fires, Pharos first collapses each protocol to a TVL-weighted median price, then evaluates divergence and the final replacement from those protocol medians. When only one lower-TVL or uncorroborated protocol diverges, or no coherent high-TVL same-direction subset remains, the original price is preserved but confidence stays `low`. The diverging protocols must also not be outnumbered by the challenger protocols whose medians corroborate the current price: replacement weight is provider-reported challenger TVL and a dormant pool keeps its last traded price behind a large nominal reserve, so a two-protocol diverging minority could otherwise outvote a corroborated consensus (the 2026-09-24 `vchf-vnx` replacement used the Celo Uniswap v3 `VCHF/USD₮` pool, last traded 2026-03-15 behind a reported $4.7M reserve, against four protocols sitting on the ECB franc rate). A corroborating majority no longer downgrades confidence (see item 1); the high-TVL multi-protocol and single-protocol hard-corroborated exceptions above can still replace the price, and a replacement itself still downgrades.

Before any pool-challenge divergence or replacement decision, protocol-level challenger medians must pass the peg-aware `dex_observation` price validator. This keeps inverse or malformed commodity marks (for example `1 / XAUUSD` instead of a USD-per-ounce gold token price) from downgrading or replacing a healthy primary price, while valid depeg-sized DEX medians remain eligible for the normal replacement paths.

When pool-challenge replacement fires, the selected primary result is rewritten in lockstep so downstream carry-through sees the new source: `allPrices`, `observedAtBySource`, and `observedAtModeBySource` are collapsed to a single `pool-tvl-weighted` entry, the replacement `observedAt` is the minimum of the contributing pools' observed-at timestamps (with mode `local_fetch`), and `agreeSources` / `candidateSources` / `disagreeSources` are updated to match. This keeps `hasCorroboratedSevereDownsideCandidate` and the primary-candidate carry-through lane from reading stale pre-replacement sources during later validation passes.

If the selected primary price is a severe fixed-peg downside and at least two live candidate sources independently
corroborate that downside by source family, including at least one depeg-authoritative source such as RedStone or Curve on-chain, pool challenge can still
downgrade confidence but cannot replace the selected price with a DEX pool median. The same candidate corroboration
also satisfies the temporal-jump guard when the previous trusted price was near peg. This keeps near-peg or stale DEX
liquidity from erasing a corroborated severe depeg while preserving the normal challenge behavior for weak,
uncorroborated soft-source prices.

The DEX bridge and the pool challenge now deliberately read from different storage views:

- `dex_prices.price_sources_json`: one aggregate per protocol, used for primary-price promotion
- `dex_price_challenger_snapshots` + `dex_price_challengers`: current individual challenger pools, selected from the full retained DEX pool set with protocol-first diversity and bounded TVL coverage for large-pool challenge / depeg confirmation
- `dex_liquidity.top_pools_json`: display-oriented top pools for UI detail, no longer the canonical challenger source

Dead or explicitly blocked DEX ids, including Bunni and its chain-scoped variants, are filtered upstream and cannot contribute challenger pools, promoted DEX bridge sources, or pool-challenge replacement marks.

This catches cases where multiple aggregators or DEX-derived bridge sources agree on a misleading price derived from small pools while ignoring large pools that show a depeg. When the challenge fires, on-chain pool liquidity provides a more honest price signal than aggregator consensus because large pools carry proportional weight. Hard sources (Binance, Kraken, Bitstamp, Coinbase, Curve on-chain, Curve oracle, RedStone with multi-venue agreement, protocol-redeem) are exempt because they provide independent market/oracle data.

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
- Hard single-source prices are only depeg-authoritative when their freshness is source-native (`priceObservedAtMode = "upstream"`); local-fetch hard single-source prices remain `confirm_required`
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

`sync-stablecoins` metadata also records, alongside the row counts, the circulating-value weight of each confidence bucket (`confidenceMarketCapUsd` plus the `pricedMarketCapUsd` denominator, active scope included) and the count of missing active prices covered by a valid, unexpired price-gap review (`acknowledgedMissingCount`). These are status-display inputs for the admin Price Source Health card — the value-weighted view exists because the row-count distribution is dominated by the single-source long tail by design (see [Status Dashboard](./status-dashboard.md#price-source-health-card)); they do not alter price selection, publication, or confidence assignment.

---

## Update Rules

When changing live pricing behavior, update all relevant surfaces in the same change:

1. runtime implementation in `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`, or related provider modules
2. this document for canonical pricing behavior
3. [Supply Snapshot](./supply-snapshot.md#supply-pipeline), [Depeg Detection](./depeg-detection.md#stage-2----confirmation), [Pharos Stability Index](./stability-index.md#cron--storage), or [Blacklist Tracker](./blacklist-tracker.md#blacklist-sync-state-semantics) when the corresponding pipeline semantics changed
4. `/methodology` pricing copy in `src/app/methodology/sections/core-sections-pricing.tsx`
5. `shared/lib/methodology-versions/registry.ts` and the matching entry under `shared/data/methodology-changelogs/pricing-pipeline/` if methodology semantics changed
6. [about-page.md](./about-page.md) and `src/lib/about-content.ts` when externally visible data sources change

## Treasury Benchmark Rates

`fetch-tbill-rate` runs daily at 08:00 UTC and fetches every benchmark descriptor on each run: USD 3-month Treasury, USD/EFFR, EUR, CHF, GBP, JPY, MXN, BRL, AUD, CAD, RUB, and TRY.

Each descriptor owns an independent circuit breaker key in the form `TREASURY_RATES:<descriptor>` (for example, `TREASURY_RATES:EUR`). An open descriptor circuit produces its retained or hardcoded fallback while every other descriptor continues through its own breaker and provider path. The daily publication preserves the structured `risk_free_rates` and legacy `risk_free_rate` cache shapes.

## Stale Data Monitoring (Frontend)

The `StaleDataBanner` component (`src/components/stale-data-banner.tsx`) warns users when data from selected critical queries is degraded or stale. Its named budgets come from `DATA_HEALTH_PRESETS` in `src/lib/data-health-config.ts`, which projects `API_FRESHNESS_MAX_AGE_SEC`; they are endpoint/UI health budgets, not necessarily producer intervals. Frontend freshness uses the shared `FRESHNESS_RATIOS` thresholds from `shared/lib/status-thresholds.ts`: fresh through `8x staleTime`, degraded through `12x staleTime`, then stale. When a hook uses `apiFetchWithMeta()`, backend freshness metadata (`_meta.status`, `X-Data-Age`, stale `Warning`) takes precedence over browser fetch time so a fresh client refetch cannot mask stale server data. Which presets a page monitors is owned by that route's own client model — each page passes its `StaleQuery` set to `StaleDataBanner` — and the minute values behind each preset are owned by `API_FRESHNESS_MAX_AGE_SEC` in `shared/lib/api-freshness.ts`, which derives most of them from `CRON_INTERVALS` and `DATA_SURFACE_DESCRIPTORS`. Read both from source rather than from a table here: a producer-cadence change moves the budgets without touching any prose. Screener, for example, monitors Prices, Peg Data, Report Cards, DEWS, and Liquidity, while Blacklist monitors only Blacklist. Some routes also render additional detail queries that are handled locally rather than by the page-level banner.

Homepage KPI cards also consume PSI, mint/burn, and DEWS data, while Compare can fetch supply-history and per-coin mint/burn detail queries. Those additional queries are not part of the current page-level stale banner contract.

Cron-backed hooks normally derive polling from `FRONTEND_API_QUERY_DESCRIPTORS`: `staleTime` uses the producer interval and `refetchInterval` uses twice that interval. Endpoint and banner freshness budgets can intentionally be tighter or looser—for example, prices warn after 10 minutes, Report Cards after 15 minutes despite a 30-minute V9 producer, and Liquidity after four hours despite an hourly scoring producer. Local browser age becomes degraded after `8x` the selected banner preset and stale after `12x`, while hook-level freshness metadata can mark data degraded/stale sooner when the Worker explicitly reports old cache age or stale-table warnings.

Tracked NAV classification is authoritative in both intake normalization and price-validation context: an omitted curated NAV flag means false, and a provider's `navToken: true` cannot bypass fixed-peg validation. Untracked rows retain their source classification.
