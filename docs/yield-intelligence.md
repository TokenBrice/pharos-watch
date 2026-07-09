# Yield Intelligence

Risk-adjusted yield tracking and ranking for yield-bearing stablecoins and curated lending opportunities. Computes APY from deterministic on-chain reads, curated DeFiLlama pools, protocol-native yield APIs, price history, and benchmark-derived fallbacks; scores each coin via the Pharos Yield Score (PYS); and serves a dedicated `/yield` page plus a stablecoin-detail yield section. That detail section now renders for any asset with a live published ranking row, even when the coin itself is not statically marked `yieldBearing` (for example USDC/USDT lending opportunities or XAUT's curated Yo Protocol venue).

> **Agent navigation** — ~1,200 lines; Grep the heading you need instead of reading wholesale: Methodology Versioning · Tracked Coins · Source-Aware APY Resolution · Pharos Yield Score (PYS) · Benchmark Registry · Warning Signals (Phase 2) · Database Schema · Cron Jobs · API Endpoints · Frontend · Constants · Testing · Edge Cases · File Index · Presentation Contracts.

---

## Methodology Versioning

- **Current methodology version:** `v8.298`
- **Public changelog page:** `/methodology/yield-changelog/`
- **Canonical source:** `shared/lib/yield-methodology-version.ts`

Yield versions are bumped when APY source resolution, source arbitration, history semantics, PYS scoring logic, or score-affecting publication rules change.

Yield v8.298 recalibrates reviewed venue sub-scores against Yearn's newly-published per-protocol risk reports (documentation cross-check, not a runtime feed). Five direct-match RWA/credit venues that scored harsher than Yearn are lowered — `3jane-lending` (also upgraded partial→verified), `cap`, `maple`, `centrifuge`, and `fluid-lending` — so their continuous venue penalties fall and `fluid-lending`'s derived tier moves medium→low (leaving the DEWS medium-venue branch; DEWS thresholds unchanged). The shared Sky/Spark legs `sparklend` and `spark-savings` move funds management 1→2 for the shared MCD_VAT backing, and `yearn`/`yearn-finance` operational moves 2→1; all three stay below the 2.0 penalty knee so the blue-chip no-op is preserved. Two proxy-only reports (`aave-v3` vs sGHO, `morpho` vs a Gauntlet Aera vault) are held unchanged. It also adds two low-severity (zero-penalty) dependency-concentration entries `syrupusdc-maple` and `syrupusdt-maple` = Maple (Pool Delegate), surfacing the single off-chain Pool-Delegate EOA without double-counting the `maple` venue tier. The PYS formula, tier thresholds, and penalty curve are unchanged.

Yield v8.297 adds vaults.fyi as a disabled-by-default supplemental source family. When `VAULTS_FYI_ENABLED` is unset/false or the runtime API key is absent, it performs no fetches and emits no candidates. When enabled without `VAULTS_FYI_RANKABLE_VAULTS`, it performs only a bounded detailed-vault inventory probe for coverage review. Only explicit `network:vaultId` allowlist entries can emit rankable candidates, and each row must pass chain-plus-token-address stablecoin identity matching, TVL/APY/safety-shape gates, local credit caps, and provider fail-open handling. PYS formula, benchmark selection, deterministic source arbitration, history semantics, and publication guards are unchanged except for those explicitly enabled and allowlisted supplemental rows.

Audit-only source-preparation notes do not bump the methodology version. Promoting additional vaults.fyi rows beyond the allowlisted runtime path, changing its source-risk calibration, or making it required would need focused tests and the next Yield Intelligence methodology bump.

Yield v8.296 adds ALFRED's graph CSV as a second St. Louis Fed mirror for the GBP SONIA Compounded Index (`IUDZOS2`). The daily benchmark cron still derives `GBP 3M compounded SONIA` from the same trailing 90-day index window, but now tries FRED (`fred-sonia-compounded-index`), then ALFRED (`alfred-sonia-compounded-index`), then Bank of England IADB (`boe-sonia-compounded-index`). The GBP rate, fallback mode `gbp-sonia-compounded-index-failed`, PYS formula, source-risk calibration, history semantics, and publication guards are unchanged.

Yield v8.295 fails the GBP benchmark over to the FRED mirror of the SONIA Compounded Index (`IUDZOS2`) because the Bank of England IADB host blocks Cloudflare Worker egress. The daily benchmark cron fetches `IUDZOS2` from FRED's reachable graph CSV first and records successful observations with source `fred-sonia-compounded-index`; the Bank of England IADB feed is retained as a fallback with provenance `boe-sonia-compounded-index`. The derived value is unchanged — the same `IUDZOS2` compounded-index series and trailing 90-day annualization are applied — so the GBP rate, fallback mode `gbp-sonia-compounded-index-failed`, PYS formula, source-risk calibration, and publication guards are unchanged.

Yield v8.294 hardens the optional `USD_EFFR` benchmark source path. The daily benchmark cron now prefers the New York Fed Markets Data API latest EFFR endpoint (`nyfed-effr`) and retains FRED DFF (`fred-dff`) as a secondary market source. If both live EFFR feeds fail, the cron retains the prior market `USD_EFFR` benchmark when available and marks the fallback as `usd-effr-sources-failed-retained`; otherwise it reports `usd-effr-sources-failed`. PYS formula shape, source-risk calibration, benchmark selection semantics, history semantics, and publication guards are unchanged.

Yield v8.293 hardens MXN benchmark integrity by removing the Etherfuse CETES issuer page from the shared benchmark fallback path. Etherfuse CETES current issuance remains the product APY source for `cetes-etherfuse`, but the global MXN benchmark now resolves from Banxico SIE `SF43936` or retained prior market data only. Fallback benchmark resolutions also stop refreshing `lastMarket*` metadata, so degraded proxy values cannot become the durable last-market source for later retained fallbacks. PYS formula shape, source-risk calibration, history semantics, and publication guards are otherwise unchanged.

Yield v8.292 replaces the hand-set 3-bucket venue tier with Yearn's shipped 5-category weighted rubric (audits, centralization, funds management, liquidity, operational; each 1–5), derives `venueRiskTier` from the resulting 1–5 score, and moves the PYS venue penalty to a continuous, calibration-preserving curve `max(0, weighted - 2.0) * 0.15` (blue-chip `low` venues stay a 0 no-op; `3.0` reproduces the legacy `medium` +0.15). It scores 49 previously-unreviewed long-tail venues (the reviewed registry grows 12 → 61), lighting up uncollateralized/RWA credit, newer money markets, CDPs, app-chain lenders, and additional risky allowlist venues that were formerly `unknown` = neutral. It also adds a reviewer-set cross-venue `dependencyConcentration` sub-signal (seeded with `yvusdc-yearn` = Sky), anchored to Yearn's own published yvUSDC risk report. The newly-scored medium/high venues feed the DEWS structured-venue branch (DEWS v6.09) with no DEWS threshold change. The PYS formula shape, benchmark selection, history semantics, and publication guards are otherwise unchanged.

Yield v8.291 adds a RUB benchmark lane sourced from the Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed and promotes `a7a5-old-vector` from intentional gap to a rate-derived row labeled `CBR key-rate reserve-yield proxy (net of 1.00pp)`. It also repairs audited auto-lending coverage by repointing `usdx-hex-trust` and `reusd-resupply`, removing stale `doc-money-on-chain` and `pmusd-precious-metals` pins, adding `bifi` and `fraxlend` to the category-gated lending allowlist, and recording same-symbol collision blocks for known false positives. The monthly coverage audit now emits `stale-auto-lending-override` queue items using the same Safety Score and supply-relative TVL gates as hourly publication, and sync/status metadata exposes published ranking-count deltas. Binance BFUSD, Gate GUSD, Tradable notes, dEURO, and eBUSD remain deferred after the June 11 probe because no stable public machine-readable APY source or adapter path was verified. PYS formula, source-risk calibration, history semantics, and global APY/TVL/safety gates are unchanged.

Yield v8.29 adds the first Midas NAV-oracle adapter, a TRY benchmark lane, explicit rate-derived benchmark overrides, structured-tranche filter cleanup, and queue-guided allowlist promotion metadata. `mmev-midas` now has a curated `protocol-api:midas-mmev-nav-oracle` row from the issuer-listed Ethereum mMEV/USD oracle, using the oracle value as a NAV anchor with a three-day freshness guard. The benchmark registry adds `TRY` from CBRT EVDS BIST TLREF series `TP.BISTTLREF.ORAN`, with source metadata `cbrt-evds-tlref`, failure mode `cbrt-tlref-failed`, and a TRY-specific `[-10%, 100%]` validation band. `witry-brix` now resolves through a rate-derived BIST TLREF proxy. Rate-derived configs can set `benchmarkOverrideKey`, leaving APY derivation on the configured product benchmark while letting PYS/excess-yield provenance compare treasury-like products against an explicit benchmark hurdle such as `USD_EFFR`. The `structured-tranche` taxonomy now renders as `Structured Tranche`, and external opportunity grouping includes structured tranches alongside lending and fixed-yield rows. Monthly coverage-audit allowlist recommendations now start from unmatched high-TVL queue candidates, include category-gate metadata, source links, and suggested config snippets, and avoid broad protocol hunting. PYS formula, source-risk calibration, history semantics, and publication guards are unchanged except where row-level benchmark selection uses the explicit override.

Yield v8.28 upgrades the GBP benchmark from the Bank of England overnight SONIA proxy to the Bank of England SONIA Compounded Index (`IUDZOS2`). The daily benchmark cron annualizes the trailing 90-day index change, records source metadata as `boe-sonia-compounded-index`, and uses fallback mode `gbp-sonia-compounded-index-failed` when the feed cannot resolve. GBP benchmark labels now represent `GBP 3M compounded SONIA`; PYS formula, source arbitration, source-risk calibration, publication guards, and non-GBP benchmark paths are unchanged.

Yield v8.27 adds `fixed-yield` as a YieldType for fixed-maturity principal-token opportunities. Pendle supplemental PT market rows now publish as protocol-API `fixed-yield` rows keyed `protocol-api:pendle:<chain>:<marketAddress>`, keep underlying stablecoin matching through the PT market's underlying asset symbol/address, and are retained as external opportunity alternatives. They can appear alongside native holder-yield rows for the same stablecoin, but they do not displace native rows through variant projection or parent inheritance. PYS formula, benchmark selection, source-risk calibration, history semantics, and publication guards are unchanged.

Yield v8.26 adds the Wave 2 category-gated thin-chain/app-chain lending allowlist batch. `aries-markets`, `blend-pools-v2`, `current`, `curvance`, `scallop-lend`, and `tydro` now participate in automatic lending pool discovery after 2026-06-09 DeFiLlama verification that they are category Lending protocols with live single-asset stablecoin pools on Aptos, Stellar, Sui, Monad, and Ink. Speculative non-lending categories remain excluded by the protocol category gate before they can become high-confidence allowlist recommendations. Existing APY floors, chain-specific TVL floors, the supply-relative `0.1%` gate, reserved-pool exclusion, source-risk semantics, PYS scoring, benchmark selection, history semantics, and publication guards are unchanged.

Yield v8.25 promotes USDGO back into live Yield Intelligence coverage. `usdgo-osl` is yield-bearing again, leaves the intentional-gap manifest, and resolves through a rate-derived APY source labeled `EFFR-linked reserve-yield proxy (net of 0.38% fee)`. The daily benchmark registry adds optional `USD_EFFR`, sourced from FRED DFF (`fred-dff`) as the Effective Federal Funds Rate. USDGO computes APY as `max(0, USD_EFFR - 38 bps)`, matching OSL public material that cites approximately 3.24% net yield versus May 2026 EFFR after fees. The default USD benchmark remains the 3-month T-Bill (`USD` / FRED `DGS3MO`); `USD_EFFR` is a source-specific benchmark key for EFFR-linked products, not a replacement global USD hurdle. PYS formula, source-risk penalties, retained benchmark fallback semantics, and publication guards are unchanged.

Yield v8.24 is the source-management, venue-risk review, and sync-observability bump. The DEX-liquidity job now caches a compact DeFiLlama `/protocols` slug/category snapshot under `defillama-protocols` so the monthly yield coverage audit can annotate protocol recommendations with DeFiLlama categories. Coverage recommendations are `high-confidence` only when the category is Lending, CDP, RWA Lending, or Uncollateralized Lending; otherwise they remain `review-needed` even when TVL and pool count are high. Auto-discovered lending opportunity TVL floors are now table-driven, with a `$100K` default and configured `$25K` floors for smaller or pre-mainnet ecosystems. The monthly audit also re-probes explicit generic `convertToAssets` quarantines with configured monthly chain RPCs and queues manual restore candidates only when a nonzero rate passes the deterministic envelope. The reviewed venue-risk backlog is drained into low/medium tiers, with PYS penalty semantics unchanged except that more reviewed venues now receive the existing medium-tier +0.15 source-risk contribution. The sync metadata now records bounded Tier 1 deterministic-envelope rejection examples and comparison-anchor freshness summaries under `sourceCoverage`; these are observability-only and do not change fallback resolution or arbitration. DEWS also consumes reviewed medium venue risk as a bounded structured-yield stress input in v6.07.

Yield v8.23 is the Wave 1 source-roster expansion. It promotes selected curated wrappers to deterministic ERC-4626 exchange-rate coverage where the configured chain reader is available, with curated DeFiLlama rows retained as fallback/alternate sources; adds rate-derived coverage for FUSD, SAFO, and SPKCC; adds `aave-v4` to lending auto-discovery; and prunes the unreachable `stbt-matrixdock` intentional-gap entry. It deliberately does not add VBILL rate-derived coverage; VBILL remains a future NAV-oracle candidate. PYS scoring math, source-risk calibration, and publication guards are unchanged.

Yield v8.22 uses first-party central-bank data for GBP/JPY/AUD benchmarks in the `fetchTbillRate` path, replacing the stale or proxy-driven FRED mirrors for these lanes. This keeps benchmark freshness metadata aligned with direct exchange-data availability while leaving yield scoring and source-arbitration semantics unchanged.

Yield v8.21 treats stale comparison anchors as freshness debt, blocks severe lending-opportunity or total ranking collapses against the previous public snapshot, and tightens Layer 3 DeFiLlama fallback matching. On-chain and price-derived rows whose prior anchor is older than 14 days carry `anchor-stale` decision evidence and the public `data-stale` warning even when the current source observation is fresh. The publisher now compares candidate rankings against the prior public cache for yield-bearing rows, non-yield-bearing lending-opportunity rows, and total row count before replacing the cache. Layer 3 DeFiLlama fallback no longer accepts substring-only symbol matches; exact normalized symbols can still match, and prefixed/suffixed wrappers require underlying-token address corroboration.

Yield v8.20 rejects generic deterministic APY observations when exchange-rate or price-derived annualization exceeds the shared 300% sanity envelope. Out-of-envelope Tier 1 on-chain rows are skipped without storing the suspicious current exchange rate as a fresh anchor; out-of-envelope Tier 3 price-derived rows return no source so curated DeFiLlama, protocol-API, or rate-derived rows can win arbitration. Protocol-specific adapters and benchmark rate-derived rows keep their existing source-family rules.

Yield v8.19 adds Royco Dawn structured-tranche opportunities as protocol-native Yield Intelligence rows. Senior and junior rows publish under `royco-dawn:<chainId>:<marketId>:senior` / `royco-dawn:<chainId>:<marketId>:junior`, attach to the tracked underlying stablecoin when the deposit token resolves, and use an opportunity-level tranche Safety Score for PYS while leaving the underlying Report Card Safety Score unchanged.

Yield v8.18 corrects base-asset source ownership for GHO, DOLA, and USDN/SMARDEX routing. GHO and DOLA no longer publish wrapper APY through base rows, and `usdn-smardex` now uses its exact single-exposure DeFiLlama pool after the asset was corrected from NAV-token to rebase semantics.

Yield v8.17 tracks `sdusd-dtrinity` as the first-class dTRINITY dStake yield wrapper. The existing Ethereum/Fraxtal weighted sdUSD DeFiLlama source now publishes under `sdusd-dtrinity`, while `dusd-dtrinity` stops owning wrapper yield metadata and parent-side sdUSD history is suppressed by the ownership-handoff cleanup path.

Yield v8.16 fixes `fpi-frax`, `silk-shade-protocol`, and `isc-international-stable-currency` NAV-token metadata so they route through NAV-appreciation coverage, and adds rate-derived proxy coverage for `cgusd-cygnus-finance` and `usdn-noble`.

Yield v8.15 gives `cetes-etherfuse` a curated `protocol-api:etherfuse-cetes-current-issuance` APY source from Etherfuse's current Stablebond issuance rate. This replaces the selected USD price-derived NAV fallback when Etherfuse is reachable, so MXN/USD FX movement is no longer interpreted as CETES yield. The MXN benchmark uses Banxico SIE `SF43936`; Etherfuse CETES current issuance is not used as a shared MXN benchmark fallback.

Yield v8.14 ships the public adapter manifest endpoint at `/api/yield-adapter-manifest` as the canonical machine-readable source list for every yield-bearing asset. Each entry carries `stablecoinId`, `coinSymbol`, `family` (`onchain` / `protocol-api` / `defillama` / `defillama-auto` / `rate-derived` / `price-derived` / `intentional-gap`), nullable `sourceKey`, optional `sourceKeyPattern`, `label`, optional `chain`/`project` hints, `lifecycle` (`active` / `quarantined` / `intentional-gap` / `experimental`), `quarantineReason` when lifecycle is `quarantined`, the current `methodologyVersion` label, and a methodology-snapshot `updatedAt`. `sourceKey` is populated only when the entry has an exact runtime key that can join to rankings, decision rows, or `/api/yield-history?sourceKey=...`; runtime-resolved DeFiLlama variant rows and disabled/quarantined readers use `sourceKey: null` plus `sourceKeyPattern` instead of publishing synthetic keys. Scoring, source resolution, history semantics, and publication rules are unchanged in v8.14; the bump tracks the new public contract only.

Yield v8.14 also exposes a bounded public decision ledger on every `/api/yield-rankings` row through `decisionLedger`, persists `pys_at_publish` / `safety_at_publish` / `variance_at_publish` snapshots on each `yield_history` row, and migrates retained alternates from the legacy `alternatives_json` blob to a sibling `yield_source_decision_alternatives` table. `decisionLedger.selectedReasonCode` is a stable enum (`best-by-confidence-and-apy`, `deterministic-preferred`, `curated-over-discovered`, `tier-preference`, `tvl-floor`, `freshness-tiebreaker`, `fallback`, `no-alternatives`) so UI surfaces render display text from a client-side template. Up to 2 alternates are retained per row, sorted by absolute APY30d delta; each carries a coded `rejectionReasonCode` (`thinner`, `stale`, `lower-confidence`, `rewards-only`, `smaller`, `unspecified`). When a source switch's previous source is present in the evaluated candidate set, `decisionLedger.apy30dDeltaFromPrevious` carries the selected source's APY30d delta versus that previous source. A new nullable `retention_reason` column on `yield_source_decisions` tags each row as `trend` (source switch, any evaluated-source anomaly, or rejected higher-confidence source) or `audit`; audit-only rows and old null rollout rows that cannot be inferred as trend are pruned at 30 days while trend rows persist for long-running analytics. The legacy `alternatives_json` blob is still written for one cycle of co-existence.

The `/yield` route-level Yield Sources board is presentation-only: it derives chosen sources and retained alternate source observations from the existing `/api/yield-rankings` payload and does not change APY source resolution, source arbitration, scoring, or methodology versioning.

Yield v8 activates nested source-risk penalties for PYS and same-confidence source arbitration while preserving neutral behavior for missing evidence and old payloads. The publisher derives the penalty from measured reward share, source depth, source age, source changes, bootstrap observation count, and sourced venue tier where those inputs exist. Public source-risk fields are nested under `sourceRisk.*`; calibration artifacts may normalize those fields internally, but public API examples must not present flattened row fields such as top-level `sourceRiskPenalty`.

Yield v8.13 expands the benchmark registry to GBP, JPY, MXN, BRL, AUD, and CAD, ending the universal USD T-Bill fallback for those non-USD-pegged stablecoins. The same release derives `sourceRisk.sourceRiskScore` from the resolved source-risk penalty when no upstream value is provided (ending the 100% null rate documented in the v8 production-sample calibration) and lands the first reviewed venue tier batch: Aave V3, Compound V3, and Spark move to `low` (currently a no-op penalty), and Morpho Blue moves to `medium` (+0.15 penalty contribution). Remaining tracked venue families stay `unknown` with rationale/evidence fields until the next monthly coverage audit. At that release, AED, IDR, TRY, ZAR, and SGD stayed on USD fallback; TRY later gained native TLREF coverage in v8.29.

Rankings provenance now carries source-native freshness for derived sources:

- active tracked yield variants now project eligible native/wrapper sources onto their active parent stablecoin as linked alternative candidates, so routes such as `yBOLD` and `sBOLD` can appear under `BOLD` without removing the variants' own rows or creating no-source coverage
- curated auto-discovery now includes Felix and Sovryn exact lending venues plus a Loopscale tGBP exact pool pin when those rows pass the normal APY, TVL, and Safety Score gates
- `sourceObservedAt` / `sourceAgeSeconds` reflect the actual latest observation backing the ranking, not just the cron run time
- `comparisonAnchorObservedAt` / `comparisonAnchorAgeSeconds` are included when APY is derived from a prior anchor, such as price-derived and on-chain exchange-rate calculations
- dTRINITY sdUSD now owns its curated TVL-weighted DeFiLlama pool group across the Ethereum and Fraxtal dStake vaults; dUSD no longer publishes wrapper yield as parent-owned metadata
- `sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, `scrvUSD`, and `savUSD` now own the wrapper APY rows that used to publish through `USDe`, `USDS`, `DAI`, `frxUSD`, `crvUSD`, and `avUSD`
- Solayer `sUSD` now has rate-derived Treasury fallback coverage through the yield manifest, while newly added reward-bearing account or restricted strategy assets stay out of runtime yield until a reliable APY source is wired
- `cgusd-cygnus-finance` and `usdn-noble` now have rate-derived proxy coverage through the yield manifest
- Parent-side wrapper history for those five base assets is filtered immediately from `/api/yield-history` and purged on the hourly sync path, so the post-handoff discontinuity is explicit rather than silently grandfathered
- `sUSDai` is now a first-class tracked yield-bearing NAV token, so base `USDai` no longer inherits the USD.AI savings venue through `YIELD_VARIANT_MAP`
- Risk-bearing wrappers with materially different holder exposure now own their yield rows directly when they are tracked as separate assets: `stcUSD`, `sAID`, `msY`, and K3 `sBOLD` no longer publish through their base stablecoin rows
- `stUSDS` uses a direct ERC-4626 exchange-rate reader, while Aave Umbrella `stkGHO` is inventoried as an intentional runtime-yield gap until reliable reward APY telemetry is available
- `scrvusd-curve` now owns the dedicated scrvUSD current-rate on-chain reader based on the Yearn V3 profit-unlock stream, while legacy parent-side `crvusd-curve` rows are suppressed
- PYS now keeps raw APY as the base yield term, then adds 25% of the row's benchmark spread before applying the safety and consistency penalties
- supplemental protocol families now keep asset-scoped source identity for same-chain markets (notably Aave V3), preventing cross-coin cache collapse and preserving per-asset alternative-source coverage
- protocol-native lending venue readers such as Aave V3 and Compound V3 stay in the curated Tier 2.5 lane rather than inheriting Tier 1 deterministic wrapper precedence, so a lower-yield supplemental market does not displace a stronger native wrapper purely by source family
- wrapper resolution can now pin the intended DeFiLlama project in addition to chain and address, which keeps shared wrapper tokens fail-closed even when the same wrapper appears across multiple single-exposure venues
- read-time `data-stale` warnings now follow source cadence: hourly families use the shared three-cycle publish threshold, supplemental families wait 6 hours so they do not false-positive inside their 4-hour refresh window, `price-derived` rows wait 36 hours because they are backed by daily `supply_history` snapshots, and derived rows also warn when their comparison anchor is older than 14 days
- published `lending-opportunity` suggestions now require observable venue TVL and a size floor of `max(existing absolute floor, 0.1% of the tracked stablecoin supply)`, so tiny markets do not surface as the live recommendation for large base assets
- published `lending-opportunity` suggestions now explicitly exclude Resolv / `USR`, `stUSR`, and `wstUSR`-linked venues across both supplemental protocol APIs and auto-discovered DeFiLlama lending pools, so impaired wrapper ecosystems do not surface as recommended base-asset yield routes
- external opportunity rows (`lending-opportunity` and `fixed-yield`) are not projected from variants to parents, so protocol opportunity alternatives can attach to their matched stablecoin without displacing native holder-yield rows
- yield-bearing assets with no live runtime source now publish as explicit intentional manifest gaps rather than appearing as covered entries with zero strategies; after the RUB benchmark promoted `a7a5-old-vector`, the current set still includes issuer/account-product assets such as `bfusd-binance`, `home-homecoin`, and `gusd-gate`, `bd-basedollar`, `pusd-polaris`, `trusd-tori`, and the Tradable private-credit notes
- `usg-tangent` is not marked `yieldBearing`: USG is the borrowable stablecoin, while sUSG is the separate savings wrapper that accrues protocol revenue
- Zephyr yield is attributed to `zys-zephyr-protocol`, the tracked ZYS yield-share NAV wrapper. Base `zsd-zephyr-protocol` stays non-yield-bearing.
- explicit and deterministic lending candidates are ignored unless the target asset is in the active stablecoin universe, so pre-launch metadata cannot surface on the live yield leaderboard before launch
- deterministic on-chain bootstrap seed rows still persist exchange-rate anchors, but they are excluded from rolling APY, excess-yield, stability, and PYS stats once real on-chain APY samples exist

---

## Tracked Coins

Every stablecoin with `flags.yieldBearing: true` in `shared/lib/stablecoins/registry.ts` is inventoried by the yield manifest. Live cron resolution operates on the active subset (`status !== "pre-launch"`), while pre-launch or intentionally uncovered assets remain visible to operators through explicit manifest entries instead of silently disappearing from coverage accounting. Pre-launch status is declared in the asset's per-coin file under `shared/data/stablecoins/coins/*.json`, loaded through `shared/data/stablecoins/coins.generated.json`, and skipped by explicit lending override publication until the per-coin entry moves into the active lifecycle. The sync also supports deterministic custom sources for select non-yield-bearing coins, exact-pool curated overrides for select non-stablecoin assets, plus automatic lending pool discovery for tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), including coins already flagged `yieldBearing`. `yieldConfig` is used when present to provide canonical source/type labels; auto-discovered lending rows synthesize protocol-derived labels when the source is `defillama-auto`. Tracked savings wrappers own their own runtime pool/on-chain readers and history. When a tracked wrapper has a live native/wrapper yield source, the publisher may also expose that source on the active parent stablecoin with a `linked-variant:<variantId>:<sourceKey>` key for comparison and coverage context; this does not mark the parent `yieldBearing` purely because the wrapper exists, and external opportunity rows (`lending-opportunity` or `fixed-yield`) are not projected from variants to parents.

| Field         | Type        | Description                                                                                   |
| ------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `yieldSource` | `string`    | Human-readable source name (e.g. "Ethena staking"). Optional for auto-discovered lending rows |
| `yieldType`   | `YieldType` | Mechanism classification (see below). Optional for auto-discovered lending rows               |

### Yield Types

| Type                  | Label              | Description                                                              |
| --------------------- | ------------------ | ------------------------------------------------------------------------ |
| `lending-vault`       | Native             | Deposited into lending protocols or vault strategies                     |
| `rebase`              | Rebase             | Token supply rebases to distribute yield                                 |
| `fee-sharing`         | Fee Share          | Protocol fees passed to holders                                          |
| `lp-receipt`          | LP Receipt         | LP position wrapped as stablecoin                                        |
| `nav-appreciation`    | NAV                | Token price appreciates as backing grows                                 |
| `governance-set`      | Gov. Set           | Yield rate set by governance vote                                        |
| `lending-opportunity` | Lending Opp.       | Auto-discovered best lending market from the curated allowlist           |
| `fixed-yield`         | Fixed Yield        | Fixed-maturity principal-token opportunity over an underlying stablecoin |
| `structured-tranche`  | Structured Tranche | Senior/junior tranche opportunity over an underlying yield market        |

Labels and styles are centralized in `shared/lib/classification.ts` (`YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`), both typed as `Record<YieldType, ...>` so adding a new variant without updating the maps is a compile error.

---

## Source-Aware APY Resolution

The sync cron resolves APY for each coin using a priority-ordered strategy. Deterministic and curated rows can coexist; the cron then applies confidence-weighted arbitration to choose the primary row while retaining alternatives.

### Tier 1: On-Chain Reads

Reads protocol state directly via `eth_call` RPC. The main path reads vault exchange rates and computes APY from the 7-day rate delta; special-case estimators can also derive APR from raw protocol state.

**Config:** `ON_CHAIN_RATE_CONFIGS` in `worker/src/cron/yield-config.ts`

```ts
interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string; // vault contract address
  selector: string; // 4-byte function selector
  decimals: number;
  inputAmount: string; // hex-encoded input (e.g. 1e18)
}
```

Currently configured for 23 generic vaults (all use selector `0x07a2d13a` — `convertToAssets(uint256)`):

| Coin ID                 | Wrapper   | Contract              | Chain     |
| ----------------------- | --------- | --------------------- | --------- |
| `susde-ethena`          | sUSDe     | `0x9D39...3497`       | Ethereum  |
| `iusd-infinifi`         | siUSD     | `0xDBDC...bCB`        | Ethereum  |
| `susds-sky`             | sUSDS     | `0xa393...fbD`        | Ethereum  |
| `stusds-sky`            | stUSDS    | `0x99cd...eB9`        | Ethereum  |
| `sdai-sky`              | sDAI      | `0x83F2...BEeA`       | Ethereum  |
| `sfrxusd-frax`          | sfrxUSD   | `0xcf62...5b6`        | Ethereum  |
| `bold-liquity`          | yBOLD     | `0x9F43...a3d8`       | Ethereum  |
| `usdf-falcon`           | sUSDf     | `0xc8cf...4b0`        | Ethereum  |
| `susn-noon`             | sUSN      | `0xE24a...B91D`       | Ethereum  |
| `ustb-superstate`       | USTB      | ERC-4626 (6 decimals) | Ethereum  |
| `thbill-theo`           | thBILL    | ERC-4626 (6 decimals) | Ethereum  |
| `susdc-spark`           | spUSDC    | `0x28b3...a43d`       | Ethereum  |
| `susdt-spark`           | spUSDT    | `0xe2e7...c372`       | Ethereum  |
| `syrupusdc-maple`       | syrupUSDC | `0x80ac...cc0b`       | Ethereum  |
| `syrupusdt-maple`       | syrupUSDT | `0x356b...ba7d`       | Ethereum  |
| `yvusdc-yearn`          | yvUSDC    | `0xbe53...6204`       | Ethereum  |
| `gtusdc-gauntlet`       | gtUSDC    | `0xdd0f...90d`        | Ethereum  |
| `bbqusdc-steakhouse`    | bbqUSDC   | `0xbeef...f5bc`       | Ethereum  |
| `sgho-aave`             | sGHO      | `0xe175...ca1d`       | Ethereum  |
| `wsrusd-reservoir`      | wsrUSD    | `0xd3fd...3094`       | Ethereum  |
| `stcusd-cap`            | stcUSD    | `0x8888...8888`       | Ethereum  |
| `savusd-avant`          | savUSD    | `0x06d4...219e`       | Avalanche |
| `yousd-yield-optimizer` | yoUSD     | `0x0000...8a65`       | Base      |

`scrvusd-curve` is intentionally quarantined from this generic Tier 1 reader because its trailing 7-day `convertToAssets(1e18)` delta understated Curve's current scrvUSD savings APY. It uses the scrvUSD special-case estimator below instead. `reusd-re-protocol` is also quarantined from the generic reader for now because its current `convertToAssets(1e18)` probe does not return a usable value, so it continues to rely on non-deterministic source paths until a protocol-specific deterministic adapter is added.

The monthly yield coverage audit re-probes explicit generic `convertToAssets` quarantines when monthly `chainRpcs` are available. `reusd-re-protocol` has an inactive probe config for this audit lane, but it is not part of hourly `ON_CHAIN_RATE_CONFIGS`. Successful nonzero probe rates inside the `<=300%` exchange-rate envelope produce `quarantineReadyToRestore`, `quarantineProbeSummary`, and an operator queue candidate with kind `quarantine-ready-to-restore`; restoration remains manual and requires an operator to move the adapter back into hourly coverage. `scrvusd-curve` remains quarantined from the generic reader because its dedicated current-rate reader is the intended source. After the 2026-07-09 lifecycle review, `reusd-re-protocol` carries `nextReviewAt: 2026-08-09` for the next monthly probe check, and `scrvusd-curve` carries `nextReviewAt: 2026-10-09` while the dedicated reader remains canonical.

**APY formula:**

```
apy = ((rate_now / rate_7d_ago) ^ (365.25 / 7) - 1) * 100
```

The generic exchange-rate reader rejects computed APY above `DETERMINISTIC_APY_SANITY_MAX = 300`. Rejected observations are not published as `onchain` rows and the suspicious current exchange rate is not written as a new anchor; the resolver continues through lower tiers so curated DeFiLlama, protocol-API, or rate-derived coverage can win. The hourly sync records the rejected Tier 1 count at `sourceCoverage.onChainEnvelopeRejectionCount` and bounded examples at `sourceCoverage.onChainEnvelopeRejections` with a truncation flag. Those examples are diagnostic sync metadata only; fallback resolution is unchanged. Negative APY remains allowed because it is bounded by the ratio formula and can be useful stress evidence.

Even when Tier 1 succeeds, the cron still falls through to Tier 2 to collect additional wrapper/native DeFiLlama rows. If no previous exchange rate exists yet (first sync), Tier 1 emits a seed row with `currentApy: 0`, `apyBase: null`, and the current `exchangeRate` so the rate is persisted in `yield_history`. This breaks the bootstrapping deadlock: without the seed, the on-chain source would never resolve because it needs a 7-day-old rate, but the rate was never stored because the source never resolved. Subsequent syncs (7+ days later) will find the seed rate and compute a real APY. Once real on-chain APY samples exist, those bootstrap seeds are excluded from rolling `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS calculations because they are anchor placeholders, not observed zero-yield periods.

#### Special-case Tier 1 estimator: Curve scrvUSD

scrvUSD uses a protocol-specific on-chain current-rate reader instead of the generic 7-day exchange-rate reader. The vault is a Yearn V3 vault that distributes newly reported crvUSD rewards through a profit-unlock stream, so the current APY shown by Curve and DeFiLlama is the daily-compounded value of the active unlock rate rather than the trailing 7-day `pricePerShare` delta.

**Reads:**

- `scrvUSD.totalAssets()`
- `scrvUSD.totalSupply()`
- `scrvUSD.profitUnlockingRate()`
- `scrvUSD.fullProfitUnlockDate()`

**Formula:**

```
sharesPerSecond = profitUnlockingRate / 1e12 / 1e18
apr             = sharesPerSecond * 31_536_000 / totalSupply
apy             = ((1 + apr / 365) ^ 365 - 1) * 100
```

When `fullProfitUnlockDate` is no longer in the future, the current unlock rate is treated as 0. The row publishes under source key `onchain:scrvusd-curve:scrvusd-current-rate`, leaving the old parent-owned `crvUSD` history unmixed. The curated DeFiLlama pool `5fd328af-4203-471b-bd16-1705c726d926` remains an alternative/fallback source.

#### Special-case Tier 1 estimator: LUSD / B.Protocol Stability Pool

LUSD also has a deterministic on-chain estimator for the Liquity v1 Stability Pool via B.Protocol. This row is intentionally conservative and is labeled `B.Protocol Stability Pool (LQTY only)`.

**Reads:**

- `stabilityPool.getTotalLUSDDeposits()` on Ethereum
- `communityIssuance.totalLQTYIssued()` on Ethereum
- CoinGecko `liquity` USD price

**Formula:**

```
remainingLqtyRewards = max(0, 32_000_000 - totalLQTYIssued)
dailyIssuanceFactor  = 1 - 0.5^(1 / 365)
apr                  = remainingLqtyRewards * dailyIssuanceFactor * lqtyPriceUsd / totalLUSDDeposits * 365 * 100
```

**Caveat:** This source captures only the projected LQTY incentive stream. It deliberately excludes ETH liquidation gains, so it is a lower-bound estimate of the full Stability Pool return.

### Tier 2: DeFiLlama Yields API (Multi-Source)

Collects **all** matching DL pools per coin via `matchAllDlPools` (three layers). Each unique pool found becomes a separate row in `yield_data`. The row with the highest `currentApy` per coin is marked `is_best = 1`; others are `is_best = 0`.

Before matching, the worker now preserves any single-exposure pool that is either:

- a normal DeFiLlama stablecoin pool (`stablecoin === true`), or
- explicitly relevant via `YIELD_POOL_MAP`, or
- explicitly relevant via a configured wrapper symbol in `YIELD_VARIANT_MAP`, or
- explicitly relevant via `EXPLICIT_YIELD_SOURCE_POOL_MAP`

This keeps wrapper pools like `fxSAVE` and `msY` eligible even when DeFiLlama marks them `stablecoin: false`, and it also preserves exact curated non-stablecoin venues such as XAUT's isolated Yo Protocol market.

**Layer 1 — Static map:** `YIELD_POOL_MAP` maps Pharos ID to a DL pool UUID. Filters for `exposure === "single"`. Finds the native/primary yield source. If a mapped UUID is missing from the DL payload, the sync logs `[yield-sync] Pool UUID ... not found in DL response, falling through` and continues to Layer 2/3 fallback matching.

2026-05-22 source corrections: `usdn-smardex` now uses the exact SMARDEX USDN DeFiLlama single-exposure pool after its `navToken` flag was corrected to false. `a7a5-old-vector` was initially represented as an intentional yield gap, then gained RUB key-rate-derived coverage in v8.291.

**Layer 2 — Variant map:** `YIELD_VARIANT_MAP` maps to a wrapper/savings pool symbol and can also pin the wrapper chain, address, and preferred DeFiLlama project. Resolution prefers `(chain, address, project)` when configured, then `(chain, address)`, and only falls back to symbol on an unambiguous chain-scoped match. Filters for `exposure === "single"` only (stablecoin flag intentionally relaxed, since savings wrappers like fxSAVE are not flagged `stablecoin = true` in DeFiLlama).

**Layer 3 — Base-symbol fallback:** Used only when both static maps miss. Resolution first tries underlying-token address matches, then exact normalized symbol equality. Substring-only symbol matches are no longer accepted, so prefixed/suffixed wrapper symbols must be corroborated by underlying-token address evidence. Symbols shorter than 4 characters are still excluded from fallback symbol matching to prevent false positives. Filters for `exposure === "single"` and `stablecoin === true`. Ambiguous fallback candidates are dropped instead of guessed.

**Exact weighted pool groups:** `YIELD_WEIGHTED_POOL_GROUPS` can collapse multiple exact DeFiLlama pool UUIDs into one TVL-weighted APY row when Pharos tracks one protocol asset but the yield wrapper is deployed as chain-isolated, non-fungible vaults. This is currently used for `sdusd-dtrinity`, where Ethereum and Fraxtal sdUSD dStake pools publish under one synthetic DeFiLlama source key.

**Exact-pool overrides:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` can publish curated non-stablecoin venues when the pool UUID, project, chain, and symbol all match and the usual APY / TVL quality gates still pass. This is currently used for `xaut-tether` via Yo Protocol. These overrides stay outside generic gold/silver auto-discovery, which prevents basket venues such as Multipli's mixed-RWA pools from being treated as single-asset commodity yield sources. On 2026-05-13, XAUT gained a second curated venue on Lista Lending (BSC) alongside the existing Yo Protocol pin, and PAXG was added as a non-yield-bearing exact-pool entry on Hydration (Polkadot).

**Variant mapping:** `YIELD_VARIANT_MAP` entries supply labels and pool matching for wrapper/savings tokens:

| Base Coin          | Wrapper | Purpose                        |
| ------------------ | ------- | ------------------------------ |
| BOLD (269)         | yBOLD   | Liquity Stability Pool wrapper |
| USBD (253)         | sUSBD   | BIMA savings wrapper           |
| reUSD (339)        | stUSR   | Resolv staking wrapper         |
| AZND (327)         | loAZND  | Mu Digital locked wrapper      |
| Neutrl USD (346)   | sNUSD   | Neutrl staked USD              |
| Avalon USDa (220)  | sUSDa   | Avalon staked USDa             |
| infiniFi USD (298) | siUSD   | infiniFi savings               |
| Falcon USD (246)   | sUSDf   | Falcon Finance savings         |
| Unitas (283)       | sUSDu   | Unitas savings                 |
| Yuzu USD (344)     | syzUSD  | Yuzu savings                   |
| fxUSD (168)        | fxSAVE  | Concentrator savings           |
| Flying Tulip ftUSD | sftUSD  | Flying Tulip staking           |
| Hermetica USDh     | sUSDh   | Hermetica staking wrapper      |
| Saturn USDat       | sUSDat  | Saturn staking vault           |

`YIELD_VARIANT_MAP` is only used when the yield-bearing wrapper is not already modeled as its own tracked asset. As of May 13, 2026, `sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, `scrvUSD`, `sUSDai`, `stcUSD`, `sAID`, `msY`, K3 `sBOLD`, and `savUSD` are tracked directly, so their base assets no longer resolve through those wrapper paths. Added 2026-05-13: gtUSDC (Gauntlet/Morpho), spUSDC and spUSDT (Spark Savings), sGHO (Aave SM), yBOLD, and yvUSDC (Yearn) now own their own native pool sources. Added 2026-05-22: base `gho-aave` no longer inherits the tracked sGHO source, and base `dola-inverse-finance` no longer publishes the untracked sDOLA wrapper source. AA_FalconXUSDC remains NAV/price-derived until a usable single-exposure nonzero APY source is available.

APY, base/reward split, pool TVL, and pool UUID are all taken directly from the DL response.

### Tier 2.5: Protocol-Native Yield APIs

For coins whose native savings path is published by the protocol itself but is not exposed as a usable DeFiLlama pool, the sync can ingest a curated protocol-owned earn endpoint directly.

Protocol-specific lending-market readers that query protocol state directly also live in this tier. Even when the transport is an on-chain call, these rows are treated as curated protocol-native venues rather than Tier 1 deterministic native-wrapper sources, so arbitration still prefers a stronger native wrapper or savings source when one exists.

This tier can also carry explicit wrapper-over-wrapper native sources when the upstream venue is a distinct managed wrapper around a tracked native yield token. K3 `sBOLD` now owns this path directly as `sbold-k3-capital`, while base BOLD keeps its Yearn `yBOLD` native-wrapper source.

Royco Dawn markets also live in this tier. The supplemental source lane reads the Dawn market explorer API and emits separate `structured-tranche` rows for the senior and junior vaults in each verified market above the local Royco TVL floor. Rows use the stable source keys `royco-dawn:<chainId>:<marketId>:senior` and `royco-dawn:<chainId>:<marketId>:junior`; the tranche share tokens are not added to the stablecoin registry. Identity resolution maps the Royco deposit token back to a tracked underlying stablecoin by chain/address first, with configured wrapper-variant addresses such as Neutrl `sNUSD` attached to their tracked parent when the wrapper is not a first-class stablecoin row.

Pendle supplemental PT markets also live in this tier. The Pendle REST reader emits active stable-category principal-token markets as `fixed-yield` protocol-API rows using implied APY, the PT market address as `sourcePool`, and source keys shaped as `protocol-api:pendle:<chain>:<marketAddress>`. Identity resolution keeps the PT market's underlying asset symbol/address for stablecoin matching. These rows are external opportunity alternatives: they can attach to the matched underlying stablecoin for comparison, but they do not replace native holder-yield rows or project through variant inheritance.

Published lending-opportunity suggestions also apply an explicit venue exclusion for Resolv / `USR`, `stUSR`, and `wstUSR`-linked markets. They now also require observable venue TVL and must clear a size floor equal to the higher of the existing absolute floor and `0.1%` of the tracked stablecoin's current supply. These filters are scoped to the suggestion layer for base assets such as USDC or USDT; they do not remove native tracked yield assets from the broader methodology inventory.

**Current tracked optional adapters:**

| Coin ID               | Source                              | Endpoint                                                                                             |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scrvusd-curve`       | `Curve Savings crvUSD current-rate` | on-chain scrvUSD Yearn V3 profit-unlock reader                                                       |
| `usbd-bima`           | `BIMA savings (sUSBD)`              | `https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000` |
| `cetes-etherfuse`     | `Etherfuse CETES current issuance`  | Etherfuse first-party Next data at `https://app.etherfuse.com/bonds/cetes`                           |
| `lusd-liquity`        | `B.Protocol LQTY-only source`       | deterministic on-chain LQTY-only source reader                                                       |
| `usyc-hashnote`       | `Hashnote USYC`                     | Hashnote protocol API                                                                                |
| `mmev-midas`          | `Midas mMEV/USD Oracle`             | on-chain issuer-listed mMEV/USD NAV oracle with historical anchor rows                               |
| `usdy-ondo-finance`   | `Ondo USDY oracle`                  | on-chain Ondo oracle with historical anchor rows                                                     |
| `zys-zephyr-protocol` | `Zephyr Scanner ZYS returns`        | `https://zephyrprotocol.com/api/v1/historicalreturns`                                                |

The BIMA adapter uses the protocol's published Ethereum earn feed, selects the USBD savings row, maps `amountTVL` to `sourceTvlUsd`, and uses the higher of `unboostedAPR` / `boostedAPR` as the current APY. Low-signal rows with negligible TVL or effectively zero APR are dropped instead of being published as meaningful yield. These rows are source-keyed as `protocol-api:bima-susbd` and participate in the same confidence-weighted arbitration as other curated sources.

The Royco Dawn adapter maps APY ratios to percent APY, tranche vault TVL to `sourceTvlUsd`, and market coverage/utilization/status/drawdown plus share-token addresses into nested `sourceRisk` fields. Royco rows carry `venueRiskTier: "unknown"` until a reviewed venue-risk audit assigns a sourced tier. They also carry investability flags for withdrawal constraints, verified listing status, and whether the row is senior protected or junior first-loss. KYC/access booleans are nullable; the current Dawn market payload does not expose explicit KYC or jurisdiction restriction fields, so those penalties apply only if future source evidence populates them.

The Etherfuse CETES adapter reads the current CETES Stablebond issuance from Etherfuse's first-party Next data and maps `interestRateBps / 100` to APY. It publishes `protocol-api:etherfuse-cetes-current-issuance` with the current token amount as the exchange-rate observation when available. This source prevents MXN NAV appreciation plus USD/MXN FX movement from being annualized by the generic price-derived fallback.

The Midas mMEV adapter reads the issuer-listed Ethereum mMEV/USD oracle, decodes its Chainlink-style `latestRoundData()` answer using the oracle `decimals()`, and publishes `protocol-api:midas-mmev-nav-oracle` as a NAV-appreciation row. Oracle answers must be positive, decimals must be within the supported range, and `updatedAt` must be no older than three days. Like other NAV-oracle rows, the first successful observation can seed `exchange_rate` history with `currentApy=0`; later runs compute APY from a prior published oracle anchor between 7 and 45 days old.

The Zephyr adapter reads the protocol's historical-return API and publishes the one-day effective APY only for `zys-zephyr-protocol`. This keeps base ZSD non-yield-bearing while still showing the native ZYS yield-share return on `/yield`.

#### Optional gated supplemental source: vaults.fyi

vaults.fyi is an optional supplemental source family for coverage review and selected allowlisted lending opportunities. It is disabled by default and is not required for normal Yield Intelligence operation:

- Configure the key only as a Worker secret/runtime binding. Do not commit a vaults.fyi credential or place one in docs.
- `VAULTS_FYI_ENABLED=true` plus `VAULTS_FYI_API_KEY` is required before the supplemental cron fetches vaults.fyi.
- With no `VAULTS_FYI_RANKABLE_VAULTS`, the adapter runs a bounded detailed-vault inventory probe, records provider telemetry, and publishes no rankable candidates. Inventory volume is reported separately from supplemental candidate counts.
- `VAULTS_FYI_RANKABLE_VAULTS` is a CSV of `network:vaultId` or `network/vaultId` entries. Only matching rows can become supplemental candidates.
- Candidate rows must match a tracked stablecoin by canonical chain and token contract address. Symbol-only matches are rejected.
- The adapter applies TVL, APY, active/corruption/warning, vault-score, and local credit-budget gates before writing cache candidates.
- Source keys are stable as `protocol-api:vaults-fyi:<chain>:<vault>`. The row `project` and `sourceRisk.venueProtocol` use the underlying protocol slug from vaults.fyi when available.
- Provider telemetry exposes `pageCapReached` and `creditCapReached` so expected bounded probes are distinguishable from provider errors.
- Provider quota/errors fail open: the supplemental family records skipped/partial/failed telemetry but does not make the hourly publisher require vaults.fyi. Disabled-family telemetry distinguishes `disabled` (flag off/unset), `no-key` (enabled without runtime secret), and `invalid-config` (malformed enable flag) so operators can tell configuration states apart.

### Opportunity-Level Tranche Safety

Royco Dawn rows use a row-level tranche Safety Score for PYS instead of blindly reusing the underlying stablecoin's Report Card Safety Score. The raw underlying score remains the ceiling for senior rows unless a future methodology explicitly allows first-loss protection to create an uplift. The current implementation does not uplift senior rows; it only subtracts tranche-specific penalties. Junior rows start with a large first-loss penalty, then add utilization, coverage, market-status, drawdown, TVL, withdrawal, access, and venue-posture penalties. At high utilization, junior rows should usually score materially below the underlying stablecoin.

Published Royco source-risk metadata includes `trancheSide`, `underlyingSafetyScore`, `trancheSafetyScore`, `trancheSafetyPenalty`, `marketCoverageRatio`, `marketMinCoverageRatio`, `marketUtilizationRatio`, `marketUtilizationLimitRatio`, `marketDrawdownRatio`, `marketStatus`, `marketTvlUsd`, `trancheTvlUsd`, `withdrawalDelaySeconds`, `kycRequired`, and `accessRestricted` when available. API hydration recomputes those scores from the live underlying Report Card snapshot before ranking, so a stale cached Royco score is not allowed to overwrite current stablecoin safety data.

### Tier 3: Price-Derived APY

For `navToken` coins and explicit `PRICE_DERIVED_FALLBACK_IDS`. Derives APY from price appreciation in the existing `supply_history` table using the oldest available anchor between 7 and 45 days. These fallback-only paths are now explicit manifest strategies rather than implicit behavior hidden behind `navToken`.

```
apy = ((price_now / price_anchor) ^ (365.25 / lookbackDays) - 1) * 100
```

Zero new API calls — reuses cached price data. Falls through if no price history exists or if the coin has fewer than 7 days of priced history.

The same 300% deterministic APY sanity envelope applies to price-derived rows. A transient price spike, token migration, or one-off NAV correction above that envelope returns no price-derived source instead of publishing a headline APY or displacing a sane curated source.

**Tier 3 as additional source:** For `navToken` and `PRICE_DERIVED_FALLBACK_IDS` coins, Tier 3 also runs when Tier 2 found sources but they all report 0% APY. This handles DL pools that exist but have stale/broken yield data (e.g., a tiny Aave lending market matched via Layer 3 symbol fallback). The price-derived source is added alongside the DL source, and `is_best` picks the higher-APY winner.

**Known limitation:** Price-derived cannot capture yield for tokens that distribute dividends as new tokens while maintaining a fixed $1.00 NAV (e.g., BUIDL, YLDS). These tokens use the rate-derived tier instead (see below).

### Tier 4: Rate-Derived APY

For dividend-distributing tokens (maintain $1.00 NAV, pay yield as new token mints), rebase proxies, and T-bill-backed funds whose yield mechanically tracks short-term rates. Configured via `RATE_DERIVED_CONFIGS` in `yield-config.ts`.

```
apy = max(0, benchmarkRate - spreadBps / 100)
```

Uses the structured benchmark cache refreshed daily by `fetch-tbill-rate`. USD defaults to the 3-month Treasury yield (`DGS3MO`), but the resolver can switch to a peg-native or product-specific benchmark when one exists. EUR rows use the ECB's official 3-month compounded €STR series. CHF rows use delayed public `SAR3MC` (3-month compounded SARON) from SIX. RUB rows use the Central Bank of Russia key rate from the DailyInfo `KeyRateXML` SOAP feed. TRY rows use CBRT EVDS BIST TLREF (`TP.BISTTLREF.ORAN`). USDGO uses `USD_EFFR`, sourced first from the New York Fed EFFR endpoint and then FRED DFF, because OSL's public material describes the product against the Effective Federal Funds Rate net of fees. Rate-derived configs can also set `benchmarkOverrideKey`: APY is still computed from the configured product benchmark, but PYS/excess-yield benchmark selection and provenance use the override. USD tokenized T-bill/MMF-style proxies use this to compare against `USD_EFFR`; EUR and GBP treasury proxies carry explicit same-currency override keys; A7A5 uses `RUB` for both APY derivation and PYS/excess-yield provenance. If a benchmark fetch fails, the cron retains the last known market benchmark when available and marks provenance as degraded instead of immediately snapping back to the hardcoded default. Because the public SIX compound-rate file is delayed, CHF benchmark `recordDate` can trail the fetch date by one business day even on a healthy run.

**Configured tokens:**

| Token    | Spread (bps) | Rationale                                                                            |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| BUIDL    | 20           | BlackRock fund, 0.20% management fee                                                 |
| cgUSD    | 35           | Cygnus Finance T-bill proxy, net of 0.35% protocol fee                               |
| YLDS     | 50           | Figure Markets, T-bill rate - 50 bps formula                                         |
| mTBILL   | 0            | Midas, tracks T-bill rate directly                                                   |
| USDN     | 0            | Noble M0 T-bill rebase proxy                                                         |
| OUSG     | 50           | Ondo US Government Bond fund, 0.50% management fee                                   |
| BENJI    | 20           | Franklin Templeton FOBXX gov MMF, 0.20% mgmt fee                                     |
| WTGXX    | 25           | WisdomTree Government MMF Digital Fund, 0.25% mgmt fee                               |
| USTBL    | 10           | Spiko US T-Bills MMF (UCITS), 0.10% TER                                              |
| EUTBL    | 15           | Spiko EU T-Bills MMF (UCITS), modeled net of 0.15%, EUR-denominated (€STR benchmark) |
| sUSD     | 0            | Solayer sUSD, T-bill proxy                                                           |
| UKTBL    | 15           | Spiko UK T-Bills MMF, modeled net of 0.15%, GBP-denominated                          |
| EURSAFO  | 0            | Spiko Amundi Smart Cash overnight swap proxy, EUR-denominated                        |
| GBPSAFO  | 0            | Spiko Amundi Smart Cash overnight swap proxy, GBP-denominated                        |
| EURSPKCC | 0            | Spiko cash-and-carry strategy proxy (EUR risk-free leg)                              |
| FUSD     | 0            | FinChain tokenized T-bill/MMF reserve-yield proxy, USD-denominated                   |
| SAFO     | 0            | Spiko Amundi Smart Cash overnight swap proxy, USD-denominated                        |
| SPKCC    | 0            | Spiko cash-and-carry strategy proxy, USD risk-free leg                               |
| USDGO    | 38           | OSL/Anchorage USDGO, EFFR-linked reserve-yield proxy using `USD_EFFR` net of 0.38%   |
| wiTRY    | 0            | Brix TRY yield product, BIST TLREF overnight proxy using `TRY`                       |
| A7A5     | 100          | Old Vector A7A5, CBR key-rate reserve-yield proxy using `RUB` net of 1.00pp          |

Note: USTB and thBILL were previously rate-derived but have been promoted to Tier 1 `ON_CHAIN_RATE_CONFIGS` (ERC-4626 `convertToAssets`).
VBILL is intentionally not rate-derived in v8.23; its coin metadata documents an on-chain NAVLink-style NAV feed, so it belongs to a future NAV-oracle source lane rather than this benchmark-proxy roster.

Rate-derived runs after Tier 3 in the resolution loop and participates in the `is_best` selection like any other source. For tokens that also have price-derived or DL sources, the highest-APY source wins.

### Automatic Lending Pool Discovery (Wave 2)

For tracked non-gold/silver stablecoins rated C- or above (safety score >= 50), the sync cron can append the best lending pool from a curated protocol allowlist. This runs after the base four-tier resolution, so yield-bearing coins can also receive an additional `defillama-auto` source row when a distinct lending market passes filters. LUSD uses this to retain Aave as an alternative source alongside the deterministic B.Protocol estimate.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/cron/yield-config.ts`):

| Tier                                                       | Protocols                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier 1                                                     | aave-v3, aave-v4, compound-v2, compound-v3, dolomite, sparklend, spark-savings, maple, yearn-finance                                                                                                               |
| Tier 2                                                     | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, morpho-blue, pendle, curve-llamalend, exactly, flux-finance, gains-network, lazy-summer-protocol, moonwell-lending, silo-v2                      |
| Tier 3                                                     | justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx, benqi-lending                                                                                                                               |
| Tier 4                                                     | radiant-v2, fraxlend-v2, clearpool, centrifuge, sturdy-v2, goldfinch, truefi, lagoon, liqwid, lista-lending, loopscale, more-markets, navi-lending, overnight-finance, smardex-usdn, vesper, felix-cdp, sovryn-dex |
| Tier A (2026-03-25, >$50M TVL)                             | wildcat-protocol, tectonic, upshift, venus-flux, avantis, cap, resupply, zerobase-cedefi                                                                                                                           |
| Tier B (2026-03-25, $10M–$50M TVL)                         | convex-finance, yo-protocol, clearpool-lending, 3jane-lending, hyperlend-pooled, zest-v2, liquity-v2, echelon-market, termmax, beefy, gearbox                                                                      |
| Tier C (2026-05-13, $10M+ TVL audit)                       | autofinance, neverland, metrom, mystic-finance-lending, bitway, frankencoin                                                                                                                                        |
| Wave 2 (2026-06-09, category-gated thin/app-chain lenders) | aries-markets, blend-pools-v2, current, curvance, scallop-lend, tydro                                                                                                                                              |
| Wave 3 (2026-06-11, audit-queue follow-up)                 | bifi, fraxlend                                                                                                                                                                                                     |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, and reserved-pool exclusion. Resolution prefers underlying-token address matches over symbol matches. Symbol-only matching is allowed only when the coin remains unambiguous after chain scoping; otherwise the candidate is dropped. Current quality gates require `apy >= 0.1`, a chain-specific absolute TVL floor (`$100K` default, `$25K` on configured smaller/pre-mainnet ecosystems), and for tracked stablecoins a supply-relative floor of `0.1%` of the asset's current circulating supply.

**Source-management audit inputs:** the DEX-liquidity job caches a compact DeFiLlama `/protocols` slug/category snapshot under the `defillama-protocols` cache key. The monthly yield coverage audit reuses that cache to annotate protocol recommendations with DeFiLlama category metadata. `high-confidence` allowlist recommendations require both the existing TVL/pool-count shape and a category of Lending, CDP, RWA Lending, or Uncollateralized Lending; missing categories or non-lending categories stay `review-needed`. The 2026-06-09 Wave 2 allowlist additions are category-gated Lending protocols with live single-asset stablecoin pools on smaller/pre-mainnet or app-chain ecosystems; the 2026-06-11 Wave 3 follow-up promoted `bifi` and `fraxlend` from audit-queue evidence, while normal safety, APY, TVL, and source-shape gates still control publication. Speculative non-lending categories were excluded by the same protocol category gate. The monthly audit also re-probes explicit generic `convertToAssets` quarantines through monthly `chainRpcs` when available, emitting restore-readiness metadata and a `quarantine-ready-to-restore` candidate only after a nonzero rate passes the deterministic envelope. The 2026-07-09 lifecycle review kept overdue quarantines and intentional gaps status-neutral when no verified runtime APY path was available, updated their notes with the review disposition, and moved their `nextReviewAt` windows forward.

**Queue-guided allowlist rounds:** Future lending allowlist expansions start from the monthly coverage audit's `operatorQueue.recommendationCandidates` entries with kind `lending-allowlist`. Those candidates are derived from unmatched high-TVL single-exposure stablecoin pools outside the current allowlist, must pass the protocol-category gate for `high-confidence` status, and include DeFiLlama source links, pool examples, promotion metadata, and a suggested `LENDING_PROTOCOLS` snippet anchored near `YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR`. Operators can still review or reject candidates, but broad manual protocol hunting is no longer the default expansion path.

**Chain-specific absolute floor:** the absolute lending-opportunity TVL gate is table-driven through `CHAIN_LENDING_TVL_FLOOR_USD`. The default floor remains `$100K`; Aptos, Berachain, Cardano, Ink, Monad, Plasma, Solana, Stacks, Stellar, and Sui use the configured `$25K` smaller/pre-mainnet floor. The supply-relative gate (`0.1%` of tracked stablecoin supply) still applies on top of the chain floor for eligible stablecoins.

**Observable size requirement:** Published lending-opportunity suggestions require venue-level `sourceTvlUsd`. Protocol-native lending readers that cannot attach measurable venue TVL are omitted from published suggestion coverage until they can prove size.

**Explicit venue exclusion:** Even when a pool clears the generic quality gates above, published lending-opportunity suggestions exclude venues whose DeFiLlama `poolMeta` or supplemental source label identifies them as Resolv / `USR`, `stUSR`, or `wstUSR` linked.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend. The direct Aave v3 on-chain supply-rate path uses the same classification so rankings/cache schema validation stays aligned across deterministic and auto-discovered lending rows.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 50, it stops receiving auto-discovered yield data. If it rises back to 50 or above, it starts automatically.

**Explicit deterministic edge cases:** `AUTO_LENDING_POOL_MAP` can also pin a small number of exact-symbol, single-asset lending markets for coins that would otherwise be blocked by ambiguous matching or by the generic safety gate. These rows still pass the same pool-shape and source-quality checks; the bypass is coin-specific and documented rather than global.

Current deterministic pins include `usdx-hex-trust`, `reusd-resupply`, `xusd-babelfish`, and `usda-anzens`. `xusd-babelfish` has a coin-specific safety bypass because the tracked asset is Rootstock-only and Sovryn is the canonical Bitcoin-side venue. `reusd-resupply` also has a coin-specific exact-pool bypass because the repaired Pendle row was reviewed while live report-card safety was 49/100, one point below the generic gate. Both bypassed rows still have to pass the normal DeFiLlama shape, APY, and TVL checks. Stale pins such as the former `doc-money-on-chain` and `pmusd-precious-metals` entries are removed rather than bypassed when their current pools no longer clear the standing gates.

**Same-symbol collision blocks:** `AUTO_LENDING_COLLISION_BLOCKLIST` stores coin-specific false-positive guards for pools that are valid DeFiLlama rows but belong to a different tracked asset. The 2026-06-11 audit added guards for cases such as Kava USDX vs Hex Trust USDX, Virtue VUSD vs Monad VUSD, and legacy Nexus/Synapse NUSD vs Neutrl NUSD. These blocks apply before deterministic override resolution and before dynamic same-symbol matching.

**Commodity-specific exact venues:** `EXPLICIT_YIELD_SOURCE_POOL_MAP` is a separate lane for curated non-stablecoin assets such as `xaut-tether`. Unlike `AUTO_LENDING_POOL_MAP`, these rows are not broadening the generic stablecoin discovery universe; they only publish the exact named pool after matching the expected venue metadata.

The monthly coverage audit now treats both `AUTO_LENDING_POOL_MAP` and `EXPLICIT_YIELD_SOURCE_POOL_MAP` as exact covered DeFiLlama surfaces. Its high-TVL gap report intentionally focuses on unsupported protocol families instead of re-flagging already-allowlisted markets that the runtime already supports dynamically. It also verifies deterministic auto-lending overrides against current pool-shape, APY, supply-relative TVL, Safety Score, allowlist, and collision-block gates; failures become `stale-auto-lending-override` headline queue items for operator review. Quarantine re-probe output is advisory: `quarantineReadyToRestore` and `quarantineProbeSummary` identify candidates for manual restoration, but the audit does not mutate hourly source configuration.

---

## Pharos Yield Score (PYS)

Risk-adjusted ranking (0–100) that balances yield magnitude against source risk, stablecoin safety, and consistency.

**Formula (`computePYS()` in `shared/lib/yield-scoring.ts`):**

```
benchmarkSpread     = apy30d - benchmarkRate
effectiveYield      = max(0, apy30d + benchmarkSpread * 0.25)
sourceRiskPenalty   = clamp(sourceRisk.sourceRiskPenalty ?? 1, 1, 2.5)
rowUtility          = effectiveYield / sourceRiskPenalty
riskPenalty         = max(0.5, (101 - safetyScore) / 20)
yieldEfficiency     = rowUtility / (riskPenalty ^ 1.75)
sustainabilityMult  = max(0.3, 1.0 - apyVarianceScore)
PYS                 = clamp(round(yieldEfficiency * sustainabilityMult * scalingFactor), 0, 100)
```

**Components:**

| Component                      | Range                    | Meaning                                                                                                                                                             |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarkRate`                | depends on row           | Row-level benchmark selected from the benchmark registry                                                                                                            |
| `benchmarkSpread`              | unbounded                | `apy30d - benchmarkRate`; positive means the row clears its local benchmark                                                                                         |
| `effectiveYield`               | `>= 0`                   | Raw APY plus 25% of benchmark spread, floored at zero before the safety divisor                                                                                     |
| `sourceRisk.sourceRiskPenalty` | `1–2.5` after resolution | Nested source-risk multiplier derived from measured source evidence. Missing/invalid values are neutral (`1`); values below 1 clamp to 1 and above 2.5 clamp to 2.5 |
| `rowUtility`                   | `>= 0`                   | `effectiveYield / sourceRiskPenalty`, used before the safety curve                                                                                                  |
| `safetyScore`                  | 0–100                    | Report card overall score. `DEFAULT_SAFETY_SCORE` (40) for unrated coins                                                                                            |
| `riskPenalty`                  | 0.5–5.05                 | Raw safety penalty before the power curve is applied                                                                                                                |
| `riskPenalty^1.75`             | ~0.30–17.01              | Effective divisor used by PYS after the steeper safety curve is applied                                                                                             |
| `apyVarianceScore`             | 0–1 or null              | Coefficient of variation of 30-day APY samples, clamped to [0, 1]. Returns null if < 2 samples or mean ≈ 0 (`                                                       | mean | < 1e-10`); PYS caller defaults null to 0 |
| `scalingFactor`                | 8                        | Global constant (`PYS_SCALING_FACTOR` in `constants.ts`) tuned after the steeper safety curve                                                                       |

Returns 0 when `apy30d <= 0` or the benchmark-aware `effectiveYield` is non-positive.

The shared scorer exposes the intermediate values (`benchmarkSpread`, `benchmarkAdjustment`, `effectiveYield`, `sourceRiskPenalty`, `rowUtility`, `riskPenalty`, `adjustedRiskPenalty`, `yieldEfficiency`, `sustainabilityMult`). Frontend breakdown components should pass the nested `sourceRisk.sourceRiskPenalty` when they surface v8 source-risk details; the final PYS value is always served by the API.

### Source-Risk, Rank Attribution, and Neutral Policy

Yield v8 exposes optional `sourceRisk` and `rankChangeAttribution` shapes in shared API schemas. PYS and source arbitration consume the nested source-risk penalty; source-board, source-sheet, detail-page, and DEWS consumers can also read populated source-risk and rank-attribution evidence. Missing evidence remains neutral:

- `sourceRisk` may be omitted, `null`, or partially populated on ranking, history, and alt-source rows.
- Public API source-risk fields are nested under `sourceRisk.*` (`sourceRisk.sourceRiskPenalty`, `sourceRisk.rewardShare`, and so on). Do not document or consume flattened public fields such as top-level `sourceRiskPenalty`; calibration scripts that ingest saved payloads must normalize from the nested API contract before analysis.
- `sourceRisk.sourceRiskPenalty` is the active v8 source-risk multiplier. It is derived from reliable `rewardShare`, `sourceDepthRatio`, `sourceAgeSeconds`, `sourceSwitchCount30d`, `observationCount30d`, sourced venue inputs (the `venueRiskWeighted` 1–5 score and its derived `venueRiskTier`), and reviewer-set `dependencyConcentration` where available. Missing, `null`, or invalid evidence is equivalent to a neutral multiplier of `1`; values below 1 clamp to 1 and values above `PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) clamp to 2.5.
- Frontend source-risk driver labels use the same scoring thresholds: `reward-heavy` when `rewardShare > 0.5`, `thin source depth` when `sourceDepthRatio < 0.001`, `stale source` when `sourceAgeSeconds > 6h`, `limited history` when `0 < observationCount30d < 7`, and `source changed` when the selected source changed versus the prior published snapshot or `sourceSwitchCount30d > 0`.
- The `/yield` depth lens is explanatory context, not guaranteed executable capacity. It classifies rows only when both `sourceRisk.sourceDepthRatio` and `sourceTvlUsd` are present: `deep` is `>= 1%` of tracked stablecoin supply, `moderate` is `0.1%` to `< 1%`, `thin` is `< 0.1%`, and missing TVL or supply-relative depth is `unknown`.
- DeFiLlama rows use the shared DeFiLlama input metadata timestamp/age when an individual resolved row does not carry `sourceObservedAt`, so provenance and PYS source-age penalties are based on the same freshness evidence.
- `sourceRisk.venueRiskTier: "unknown"`, `null`, or omitted means the venue tier has not been sourced. Unknown tier is neutral, not a hidden high-risk default.
- `worker/src/cron/yield-sync/source-risk.ts` owns the typed `YIELD_RISK_CONFIG` registry of reviewed venues. As of yield v8.292 each entry carries five Yearn-style sub-scores — `audits` (20%), `centralization` (30%), `fundsManagement` (30%), `liquidity` (15%), `operational` (5%), each `1..5` with higher = riskier — weighted into a `1..5` venue-risk score. The coarse `venueRiskTier` is now DERIVED from that weighted score (`< 2.5` → `low`, `< 3.5` → `medium`, else `high`), not hand-set. The reviewed registry covers 61 venues: the blue-chip set (`aave-v3`, `compound-v3`, `sparklend`, `spark-savings`, `yearn`, `yearn-finance`, `pendle`) stays `low`; the credit/long-tail expansion adds high-tier venues (`clearpool`, `goldfinch`, `3jane-lending`, `aries-markets`, `curvance`, `avantis`) and many medium-tier lenders. Reviewed scores bind from the DeFiLlama `project` slug on auto-discovered lending rows; unknown or unreviewed venues remain neutral. Review is tied to the monthly yield coverage audit; guessed venue penalties are explicitly out of scope. Each entry carries a `confidence` (`verified` / `partial` / `low`) that is published as `sourceRisk.venueRiskConfidence` and **surfaced, not used to discount the penalty**: an uncertain venue is scored conservatively (uncertainty is treated as risk, mirroring the rubric's "no audit = riskiest" default), and the UI venue-risk chip flags low/partial confidence so the haircut is honest.
- The venue penalty moved from flat buckets to a continuous, calibration-preserving curve `max(0, venueRiskWeighted - 2.0) * 0.15`: weighted `≤ 2.0` → `0` (the legacy `low` no-op is preserved exactly for the blue-chip set), `3.0` → `+0.15` (the legacy `medium`), `4.0` → `+0.30`, `5.0` → `+0.45`. The curve applies only when a venue carries category scores; unscored venues stay neutral, and the legacy tier branch (`high` +0.35 / `medium` +0.15) remains the fallback. The penalty knee (`2.0`) sits intentionally below the low/medium tier cutoff (`2.5`): the tier is a coarse display/DEWS bucket while the penalty is continuous, so a `low`-tier venue scoring `2.0`–`2.5` (e.g. Gearbox, Exactly, Liqwid) is low-but-not-pristine and carries a small proportional penalty (≤ +0.075), while only true blue-chips (≤ `2.0`) are an exact no-op.
- `sourceRisk.dependencyConcentration` is a reviewer-set, stablecoin-id-keyed signal (not auto-derived) capturing cross-venue concentration that per-venue tiering structurally misses. It adds `+0.10` (`medium`) or `+0.20` (`high`) to the source-risk penalty (`low` is a zero-penalty informational severity). The one penalty-bearing seed is `yvusdc-yearn` = Sky (`medium`): the vault's funded debt sits ~100% behind Sky governance (sUSDS + Spark), matching Yearn's own risk report. The map also carries informational `low`-severity (zero-penalty) entries for single-curator Morpho vaults (`gtusdc-gauntlet`, `gtusdcp-gauntlet`, `steakusdc-steakhouse`, `steakusdt-steakhouse`, `bbqusdc-steakhouse`) that surface the curator coupling without an added penalty. Unseeded coins stay neutral.
- DEWS Yield Anomaly reads the derived `venueRiskTier` directly, so its `structured-medium-risk-venue` (+10) and `structured-high-risk-venue` (+25) branches now fire across the wider 61-venue registry as of DEWS v6.09; no DEWS threshold changed.
- `sourceRisk.sourceRiskScore` is the 0–100 display normalization of the resolved source-risk penalty. As of v8.13, when no upstream score is provided, the publisher fills it via `computeSourceRiskScoreFromPenalty` (`penalty = 1.0` → `0`; `penalty = PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) → `100`). The score is informational and does not change PYS — PYS continues to consume the `sourceRiskPenalty` directly. Rollback compatibility: legacy v7.48 payloads still resolve to a neutral penalty when source-risk is absent, and an explicit upstream `sourceRiskScore` value still wins over derivation.
- `sourceRisk.sourceDepthRatio`, `sourceRisk.rewardShare`, `sourceRisk.sourceAgeSeconds`, `sourceRisk.observationCount30d`, `sourceRisk.sourceSwitchCount30d`, `sourceRisk.deploymentPlace`, `sourceRisk.venueProtocol`, `sourceRisk.venueChain`, and `sourceRisk.investabilityFlags` are populated only when supported by existing rows, provenance, publication-generation evidence, or sourced yield-risk config. Missing precision stays missing instead of being guessed from labels.
- v8 rollout calibration evidence is split between `docs/process/archive/yield-pys-v8-calibration-2026-05-13.md` for source-risk golden fixtures and `docs/process/archive/yield-pys-v8-production-sample-calibration-2026-05-13.md` for the current production snapshot. The production snapshot was regenerated after publication generation `yield-1778700012` emitted populated public ranking `sourceRisk.*` fields, so it records live source-risk coverage, including the prior `sourceRiskScore` null-rate, plus rank churn, capped rows, distribution, movers, and non-USD cohorts. The v8.13 delta — benchmark registry expansion, `sourceRiskScore` derivation rule, and the first venue tier batch — is documented in `docs/process/archive/yield-pys-v8-13-calibration-2026-05-15.md`.
- External opportunity rows (`lending-opportunity`, `fixed-yield`, and `structured-tranche`) do not modify the base stablecoin's Safety Score, Dependency Risk, Resilience, or overall report-card grade. They may inform opportunity-level yield risk labels or DEWS yield anomaly inputs only through explicitly versioned consumer methodology; report-card modifiers still require a separate report-card methodology update.
- Report-card consumers ignore yield source-risk today: external lending opportunities and structured tranches belong to opportunity scoring, and native yield source-risk does not emit report-card score modifiers, Resilience caps, or Dependency Risk caps.
- Any future report-card score impact from yield source-risk requires a report-card methodology update and matching report-card timeline entry before runtime scoring can consume those fields.
- DEWS methodology (introduced in v5.99, current v6.094) consumes a bounded subset of populated structured yield evidence inside the existing Yield Anomaly sub-signal: reward-heavy rows, thin or stale sources, source switches, high source-risk penalties, reviewed medium/high-risk venue tiers, and rank-attribution drivers for source-risk or source-switch moves. Missing, malformed, or neutral source-risk fields and legacy warning-only rows remain explicit no-ops.

Rollback compatibility is part of the contract. Production-shaped `v7.48` payloads without `publication`, `publishedRank`, `liveRank`, `sourceRisk`, or `rankChangeAttribution` remain valid. With no nested source-risk penalty, v8 resolves the same neutral penalty (`1`) and keeps the benchmark-aware v7 scoring path equivalent.

### Supporting Metrics

| Metric           | Formula                                                                        | Description                                                                                  |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `yieldStability` | `1 - CV(30d samples)`                                                          | 0–1, higher = more consistent. Null if < 2 samples or mean ≈ 0 (`                            | mean | < 1e-10`) |
| `yieldToRisk`    | `apy30d / (101 - safetyScore)`                                                 | Raw yield per unit of risk                                                                   |
| `excessYield`    | `apy30d - benchmarkRate`                                                       | 30-day average APY above the row's selected benchmark                                        |
| `effectiveYield` | `max(0, apy30d + 0.25 * excessYield)`                                          | Benchmark-aware yield term used by PYS before source-risk, safety, and consistency penalties |
| `rowUtility`     | `effectiveYield / sourceRisk.sourceRiskPenalty` after neutral/clamp resolution | Source-risk-adjusted utility term used before the safety penalty                             |
| `apy7d`          | Timestamp-filtered 7d average                                                  | 7-day trailing APY (uses `recorded_at >= now - 7d`, not proportional slicing)                |
| `apy30d`         | Simple average of 30d samples                                                  | 30-day trailing APY                                                                          |
| `variance30d`    | Standard deviation of 30d APY samples                                          | APY volatility measure                                                                       |

---

## Benchmark Registry

Yield Intelligence now uses a small benchmark registry instead of a single global T-bill field.

**Benchmarks currently supported:**

| Key        | Label                            | Primary source                                                                                                           | Notes                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USD`      | USD 3M T-Bill                    | FRED `DGS3MO`, then Treasury.gov yield curve XML                                                                         | Default benchmark and backward-compatible top-level `riskFreeRate`; Treasury.gov is used as a fallback when FRED is unavailable                                                                                                                                                                     |
| `USD_EFFR` | USD effective federal funds rate | New York Fed latest EFFR endpoint, then FRED `DFF`                                                                       | Optional product-specific benchmark for EFFR-linked products such as USDGO; not the default USD hurdle                                                                                                                                                                                              |
| `EUR`      | EUR 3M compounded €STR           | ECB Data API (`EST/B.EU000A2QQF32.CR`)                                                                                   | Native benchmark for EUR pegs; retained-last-market fallback covers feed outages                                                                                                                                                                                                                    |
| `CHF`      | CHF 3M compounded SARON          | SIX delayed `SAR3MC` download                                                                                            | Public feed is delayed by one business day; not labeled as a proxy                                                                                                                                                                                                                                  |
| `GBP`      | GBP 3M compounded SONIA          | FRED graph CSV for SONIA Compounded Index `IUDZOS2`, then ALFRED graph CSV, then Bank of England IADB `IUDZOS2` fallback | Annualized from the trailing 90-day index change; metadata source `fred-sonia-compounded-index` or `alfred-sonia-compounded-index` before the BoE fallback (`boe-sonia-compounded-index`), fallback mode `gbp-sonia-compounded-index-failed`                                                        |
| `JPY`      | JPY overnight call (TONA proxy)  | Bank of Japan Time-Series Data Search `STRDCLUCON`                                                                       | Used as a TONA-equivalent proxy                                                                                                                                                                                                                                                                     |
| `MXN`      | MXN CETES 28d                    | Banxico SIE API (series `SF43936`)                                                                                       | `BANXICO_TOKEN` enables the official Banxico feed; when missing/failing, MXN retains the last market source when available or remains unavailable so rows fall back to USD. Etherfuse CETES current issuance is deliberately limited to the CETES product APY source, not the shared MXN benchmark. |
| `BRL`      | BRL SELIC over                   | BCB SGS API (series `11`)                                                                                                | No auth required; daily percentage annualized over 252 business days before scoring                                                                                                                                                                                                                 |
| `AUD`      | AUD cash-rate target             | Reserve Bank of Australia F1 money-market CSV                                                                            | RBA cash-rate target used as the AUD local cash hurdle                                                                                                                                                                                                                                              |
| `CAD`      | CAD overnight repo (CORRA proxy) | Bank of Canada Valet API (series `V122530`)                                                                              | Overnight repo; CORRA-equivalent                                                                                                                                                                                                                                                                    |
| `RUB`      | RUB CBR key rate                 | Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed                                                                  | Native benchmark for RUB pegs; validation accepts up to 100% so high key-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                                  |
| `TRY`      | TRY BIST TLREF overnight         | CBRT EVDS (`TP.BISTTLREF.ORAN`)                                                                                          | Native benchmark for TRY pegs; validation accepts up to 100% so Turkish reference-rate regimes are not rejected by the standard 20% ceiling                                                                                                                                                         |
| `SGD`      | SGD SORA (unavailable)           | —                                                                                                                        | Reserved for a future MAS SORA feed; SGD pegs fall back to USD until a stable public source is wired                                                                                                                                                                                                |

**Source URLs:**

```text
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO
https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json
https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF
https://home.treasury.gov/sites/default/files/interest-rates/yield.xml
https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata
https://indexdata.six-group.com/pro/oauth/token
https://indexdata.six-group.com/pro/api/report-download
https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv
https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp
https://www.stat-search.boj.or.jp/api/v1/getDataCode
https://www.rba.gov.au/statistics/tables/csv/f1-data.csv
https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43936/datos/oportuno
https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json
https://www.bankofcanada.ca/valet/observations/V122530/json?recent=1
https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx
https://evds3.tcmb.gov.tr/igmevdsms-dis/fe
https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2
https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2
```

**Stored as:** `cache` table, key `"risk_free_rates"`, with the legacy USD-only key `"risk_free_rate"` still written for compatibility.

**Fallback:** `RISK_FREE_RATE_FALLBACK = 3.75%` applies to USD only. Other benchmarks prefer a retained last-known source-backed value when available; otherwise they remain unavailable and rows fall back to USD when selection requires it. MXN does not use issuer-controlled product pages as benchmark fallbacks.

**Tokenized-treasury benchmark overrides:** Some rate-derived treasury-like products tokenize the same instrument as their local benchmark, which can compress excess-yield and PYS context toward zero. `benchmarkOverrideKey` lets a rate-derived row compute APY from its configured product benchmark while comparing PYS/excess-yield against an explicit benchmark hurdle. USD T-bill/MMF-style proxies use `USD_EFFR` as the comparison hurdle; EUTBL and UKTBL carry explicit same-currency override keys. CETES still uses its protocol-native issuance adapter plus the MXN CETES benchmark path, so CETES-specific override policy remains a separate future decision.

**Currencies still falling back to USD:** AED, IDR, ZAR, SGD (and any other peg currency not listed above). These remain as `benchmarkSelectionMode: "fallback-usd"` until a stable public feed is wired for each.

**Selection rules:**

- USD is the default benchmark for the stack and remains the top-level `riskFreeRate` / `provenance.benchmark`
- Yield rows switch to a peg-native benchmark when the stablecoin's benchmark currency is supported
- Rate-derived configs can explicitly override the benchmark key when the asset's benchmark should differ from the peg currency
- When a native benchmark is unavailable, the row falls back to USD and records `benchmarkSelectionMode: "fallback-usd"`

**Usage:** The hourly core yield sync resolves `excessYield` from 30-day average APY and rate-derived APY against each row's selected benchmark. Detail cards, hero chips, and history charts render that row-level label. The `/yield` scatter plot now always keeps a benchmark frame visible: homogeneous scopes use the shared visible benchmark, while mixed scopes use the default USD benchmark as an orientation frame and rely on row-level tags for the exact hurdle.

---

## Warning Signals (Phase 2)

`yield-helpers.ts::detectWarningSignals()` runs in the sync cron and stores baseline results in the `warning_signals` column of `yield_data`. Rankings responses also add a read-time freshness signal. Frontend-visible warning keys are:

| Signal             | Condition                                                                                                                                                                                                                                                                                                          | Meaning                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `yield-spike`      | `currentApy > 2% AND currentApy / apy30d > 2.0`                                                                                                                                                                                                                                                                    | Sudden 2× jump vs. 30d average (absolute floor: 2% APY)                             |
| `yield-divergence` | `currentApy > medianApy * 3`                                                                                                                                                                                                                                                                                       | 3× the market median                                                                |
| `negative-trend`   | `apy30d > 1% AND currentApy < apy30d * 0.7`                                                                                                                                                                                                                                                                        | 30% decline from average (absolute floor: 1% baseline)                              |
| `reward-heavy`     | `apyReward / apy > 0.8`                                                                                                                                                                                                                                                                                            | 80%+ from incentives, not base yield                                                |
| `tvl-outflow`      | TVL dropped > 20% from prev week                                                                                                                                                                                                                                                                                   | Capital leaving the protocol                                                        |
| `zero-yield`       | `currentApy === 0 AND apy30d > 0.5%`                                                                                                                                                                                                                                                                               | Yield dropped to zero but had recent activity                                       |
| `data-stale`       | Hourly source families are older than 3 `sync-yield-data` intervals (currently 180 min); supplemental Aave/Compound + protocol-API rows are older than 6 hours; `price-derived` rows are older than 36 hours from their latest `supply_history` snapshot; derived-source comparison anchors are older than 14 days | Yield data or its APY comparison anchor is older than the expected freshness window |

All frontend surfaces (leaderboard, detail section, history chart) format warning signals via the shared `formatYieldWarningSignal()` function in `src/lib/yield-constants.ts`, which maps known signal keys to human-readable labels and falls back to hyphen-to-space conversion for unknown signals.

At rankings cache-build time, `sync-yield-data` decorates rows with the read-time-only `data-stale` signal when the resolved source observation exceeds its freshness window or a derived-source comparison anchor is older than 14 days (`COMPARISON_ANCHOR_STALE_THRESHOLD_MS`). Hourly publication families use the shared three-interval threshold (currently 180 minutes; `STALE_THRESHOLD_MS`), supplemental protocol-API and optional Aave/Compound rows use a 6 hour threshold (`SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS`) so the hourly publisher does not flag them stale during a normal 4 hour supplemental cycle, and `price-derived` rows use a 36 hour threshold because their source observations come from daily `supply_history` snapshots (`PRICE_DERIVED_STALE_THRESHOLD_MS`). This signal is included in cached rankings responses but is not written back to `yield_data`.

The sync also records comparison-anchor freshness under `sourceCoverage.comparisonAnchorFreshness`. The summary includes the anchored row count, stale anchor count, oldest stale anchor age/source, bounded stale examples, and a truncation flag. Publication metadata additionally records `sourceCoverage.previousPublishedRankingCount` and `sourceCoverage.publishedRankingCountDelta`; severe coverage-regression guards emit the same ranking-count fields at top level before normal source coverage is assembled. `/api/status` exposes both shapes as `yieldHealth.previousRankingCount` and `yieldHealth.rankingCountDelta` so operators can see coverage growth or shrinkage without manually comparing payloads. These summaries are observability-only: stale-anchor warnings still follow the read-time `data-stale` rules above, and the freshness/ranking-delta metadata does not change source arbitration or scoring.

The sync also performs a confidence-aware cross-source arbitration pass before `is_best` is chosen:

- deterministic sources (`onchain`, `rate-derived`) outrank curated protocol-native and DeFiLlama rows
- curated DeFiLlama rows outrank discovered lending opportunities and fallback-derived rows
- non-positive APY rows cannot outrank positive rows
- within the same confidence tier, arbitration compares source-risk-adjusted row utility (`effectiveYield / sourceRiskPenalty`) after source-risk penalty resolution before falling back to raw current APY
- materially divergent discovered or fallback rows can be rejected when a higher-confidence canonical source disagrees by more than 35%
- a `canonical-zero-vs-positive` anomaly is flagged when a high-confidence source reads 0% but a lower-confidence source reports > 1% APY

This selection behavior is surfaced in row-level `provenance` metadata on `/api/yield-rankings`.

---

## Database Schema

**Migrations:** the current checked-in schema lives in `worker/migrations/0000_baseline.sql`. Historical pre-squash yield schema changes (initial table creation, warning signals, multi-source keys, and source-aware history rows) are tracked in `worker/migrations/MANIFEST.md`.

### `yield_data` — Current Snapshot (one row per coin per source)

```sql
CREATE TABLE yield_data (
  stablecoin_id       TEXT NOT NULL,
  source_key          TEXT NOT NULL,  -- DL pool UUID, "onchain:<stablecoin_id>", "protocol-api:<family>", "price-derived", or "rate-derived"
  symbol              TEXT NOT NULL,
  current_apy         REAL NOT NULL,
  apy_base            REAL,
  apy_reward          REAL,
  apy_7d              REAL NOT NULL,
  apy_30d             REAL NOT NULL,
  yield_source        TEXT NOT NULL,
  yield_type          TEXT NOT NULL,
  source_pool         TEXT,           -- DL pool UUID
  source_tvl_usd      REAL,
  data_source         TEXT NOT NULL,  -- "onchain" | "defillama" | "defillama-auto" | "protocol-api" | "price-derived" | "rate-derived"
  safety_score        REAL,
  safety_grade        TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,           -- 0-1
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,           -- current vault rate (Tier 1 only)
  exchange_rate_prev  REAL,           -- 7d-ago vault rate
  warning_signals     TEXT,           -- JSON array of active signal keys (migration 0033)
  is_best             INTEGER NOT NULL DEFAULT 1,  -- 1 = highest-APY source per coin
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);
```

**Indices:** `idx_yield_pys` (PYS DESC), `idx_yield_apy` (apy_30d DESC), `idx_yield_best` (stablecoin_id, is_best).

**Multi-source behavior:** Coins with both a native pool and a savings wrapper get multiple rows. The confidence-weighted arbitration pass marks the selected row with `is_best = 1`; non-selected rows remain available as alternatives with `is_best = 0`. This also covers mixed source types such as LUSD, where a deterministic on-chain B.Protocol row can coexist with an auto-discovered Aave lending row. Eligible tracked wrapper variants also project linked native/wrapper sources to the active parent with `linked-variant:<variantId>:<sourceKey>` source keys, while third-party lending opportunities stay attached only to the asset that owns the lending row. Rankings queries filter `WHERE is_best = 1`. Alt-source rows are read separately, sorted by the same worker candidate ordering used for arbitration, and attached as `altSources[]` in the cached API response with `sourceRole`, `confidenceTier`, `selectionRank`, and `rejectionReasonCode` metadata. Ranking rows with retained alternates also include `alternateSummary` for the best 30d-APY alternate, best source-risk-adjusted alternate, and APY spread versus the selected row. After each batch write, stale rows for coins refreshed in that run are purged so old primary sources cannot linger alongside the new winner.

Generation-aware publisher fields added by migration `0125_yield_publication_generations.sql` are nullable so old rows and rollback payloads remain readable:

```sql
publication_generation_id TEXT,
publication_state         TEXT  -- "staged" | "published" | "failed"
```

Rows are replaced in the same D1 batch as the `yield-rankings` cache publication. The batch first performs a cache compare-and-swap, then guards the current/history row replacement, decision evidence write, and generation publish on `yield-rankings.updated_at = startSec`. Successful runs write rows with a `publication_generation_id` and `publication_state = 'published'`. If preflight validation, cache publication, or an older-run cache CAS fails, the generation is marked `failed` without replacing the previous published D1 snapshot.

### `yield_history` — Historical Data Points

```sql
CREATE TABLE yield_history (
  stablecoin_id   TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,  -- Unix seconds
  is_best         INTEGER NOT NULL DEFAULT 0,
  apy             REAL NOT NULL,
  apy_base        REAL,
  apy_reward      REAL,
  exchange_rate   REAL,
  source_tvl_usd  REAL,
  data_source     TEXT NOT NULL,
  warning_signals TEXT,
  yield_source    TEXT,
  yield_type      TEXT,
  publication_generation_id TEXT,
  publication_state TEXT,
  pys_at_publish    REAL,             -- PYS at publish time (v8.14, migration 0132)
  safety_at_publish REAL,             -- safety score at publish time (v8.14, migration 0132)
  variance_at_publish REAL,           -- APY30d variance at publish time (v8.14, migration 0132)
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);
```

**Indices:** `idx_yield_hist_coin` (stablecoin_id, recorded_at DESC), `idx_yield_hist_coin_source` (stablecoin_id, source_key, recorded_at DESC), `idx_yield_hist_best` (stablecoin_id, is_best, recorded_at DESC).

**Retention:** 365 days. Older rows are pruned at the end of each sync run.

**Legacy migration behavior:** historical pre-migration rows are preserved as `source_key = 'legacy-best'`. Same-source trailing metrics only reuse these rows when the coin currently has a single resolved source **and** the legacy source family matches the current source family. If the current winner changed source family (for example price-derived → rate-derived), the new source starts a clean series instead of inheriting mixed legacy history.

**Estimated volume:** source-aware hourly snapshots. `sync-yield-data` runs once per hour and writes one history row per resolved source, so annual row volume depends on the active source set rather than a fixed one-row-per-coin estimate.

### `yield_publication_generations` and `yield_source_decisions`

Migration `0125_yield_publication_generations.sql` adds a compact generation ledger:

- `yield_publication_generations` records `generation_id`, `started_at`, publication `state`, ranking/source row counts, `published_at` or `failed_at`, and failure/debug metadata.
- `yield_source_decisions` records the selected source per stablecoin for a generation, selected confidence/data-source details, selected 30d APY and score, previous best source, source-changed flag, rejected-candidate count, and a bounded alternatives JSON payload.

The generation ID format is `yield-<startSec>`. Public payloads expose only `published` generations. Legacy rows with no generation ID remain readable through the existing cutoff fallback, which is what keeps rollback to old Worker versions compatible with the additive schema.

---

## Cron Jobs

### `sync-yield-data`

**Schedule:** `20 * * * *` (every hour on a dedicated post-DEX trigger)
**Files:** `worker/src/cron/sync-yield-data.ts` thin stage sequencer; `worker/src/cron/yield-sync/coordinator-{fetch,normalize,health-telemetry,persist}-stage.ts` orchestration stages; domain helpers under `worker/src/cron/yield-sync/`

**Execution flow:**

1. Filter the active stablecoin universe where `flags.yieldBearing === true` for the base four-tier resolution, then evaluate explicit exact-pool overrides plus auto-discovery across eligible active non-gold/silver coins
2. Fetch DeFiLlama pools (`https://yields.llama.fi/pools`) — circuit-breaker protected
3. Load the latest cached supplemental-source snapshot from `sync-yield-supplemental`; stale or missing supplemental cache is treated as optional loss, not a publisher hard-stop
4. Fetch on-chain exchange rates via `eth_call` for `ON_CHAIN_RATE_CONFIGS` entries, unless the deterministic lane is in a cooldown window after consecutive masked all-fail runs; protocol-specific hourly on-chain readers such as scrvUSD's current-rate source run during per-coin resolution and fall back to curated rows if unavailable
5. Read the cached benchmark registry from D1, with USD as the default benchmark and EUR / CHF available when fetched successfully
6. Compute safety scores via shared helper `computeSafetyScoresSnapshot(db, { includeNavTokens: true, outputMode: "map" })`; this helper now reuses the same peg-analytics path as `/api/report-cards` so live peg deviation inputs stay aligned across Safety Score and Yield Intelligence. Treat the helper's explicit degraded result as degraded input, and also classify coverage below the minimum ratio as degraded even when the helper itself succeeded
7. Resolve APY for each yield-bearing coin (Tier 1 → 2 → 3 → 4, potentially multiple sources per coin), reusing cached supplemental families instead of live-fetching them on the publisher path, then append auto-discovered lending rows for any remaining eligible tracked coins and linked parent rows for eligible tracked yield variants
8. Preload source-aware `yield_history` datasets: previous-best rows use indexed per-coin point reads, previous-TVL rows use indexed point reads for the source keys resolved in the current run, 30d APY history remains chunked by stablecoin IDs, and legacy best-history fallbacks stay available for evaluation
9. Compute 7d/30d APY, variance, and PYS per resolved source using source-specific history instead of coin-level mixed history
10. Run confidence-weighted arbitration to select `is_best` per coin and flag source changes vs. the prior best source
11. NaN/Infinity guard: clamp PYS, variance, and stability to finite values before DB write
12. Stage a publication generation, preflight the rankings payload, and compare candidate publication counts against the previous public cache for yield-bearing rows, non-yield-bearing lending-opportunity rows, and total ranking count
13. Publish the `yield-rankings` cache payload with `publication.status = "published"` plus row-level `publishedRank`, upsert `yield_data` (all sources), insert `yield_history` points, insert selected-source decision evidence, and mark the generation `published` in one guarded D1 batch; if cache publication fails or CAS skips because a newer cache exists, mark only the generation `failed` and leave the previous published D1 rows in place
14. Purge stale rows for refreshed coins only on non-degraded successful publication so obsolete primary/alt sources are removed together, then scan `yield_data` for orphan coin IDs and delete those in chunked `IN (...)` batches instead of a single large `NOT IN (...)`
15. Prune `yield_history` older than 365 days
16. Query best-source rows, fetch alt-source rows, attach as `altSources[]`, add read-time `data-stale` warning decoration using source-cadence freshness windows (three hourly publish cycles for hourly families; 6 hours for supplemental protocol-API and optional Aave/Compound rows; 36 hours for `price-derived` rows; 14 days for derived-source comparison anchors), record bounded source-coverage metadata for deterministic-envelope rejections, comparison-anchor freshness, and previous-vs-current published ranking counts, and include top-level + per-row provenance in the cached rankings payload whenever the payload passes schema validation and the new payload has not collapsed severely versus the previous cache. Safety-degraded runs still publish fresh rankings when the payload is valid but skip `report_card_cache`.

**Degraded semantics:** If `computeSafetyScoresSnapshot()` returns a degraded result, safety coverage is below the minimum ratio (0.75), the default USD benchmark is on a true fallback path (`isFallback === true`), the `fallbackMode` contains `"retained"` (indicating a benchmark fetch failure with last-known-good retention), the retained last-known-good USD benchmark is older than 72 hours (3 days), DeFiLlama pool inputs are unavailable, the direct DeFiLlama fetch payload is invalid or yields zero relevant stablecoin pools, all configured deterministic on-chain sources fail in the same cycle without full alternative coverage, a deterministic cooldown suppresses on-chain reads but coverage gaps reappear, rankings publication fails schema/severe-shrink guards, or the candidate publication severely regresses yield-bearing, lending-opportunity, or total ranking count versus the previous public cache, `sync-yield-data` returns `status: "degraded"`. Repeated deterministic all-fail runs that are fully masked by non-onchain coverage now arm a cooldown instead of burning the full deterministic path every hour. Stale or missing supplemental cache does not by itself degrade the hourly publisher; it only reduces optional source coverage unless the published-coverage guard would overwrite a materially fuller prior public snapshot. Retained benchmark metadata still appears in rankings provenance via `provenance.benchmark.fallbackMode`, including the last market-derived rate/date/source preserved across fallback streaks. Row-level benchmark provenance also exposes the selected benchmark key, label, rate, fallback state, and selection mode. Schema-invalid or severe-shrink runs skip cache overwrite so the previous public ranking remains in place. Safety-degraded runs continue to publish a fresh `yield-rankings` cache when the rankings payload is valid, but they still skip `report_card_cache` writes so the degraded condition remains visible without taking the public API offline.

Implementation stages:

- `yield-sync/sources.ts` + `yield-sync/pool-filter.ts`: DL pool loading, wrapper-relevant pool filtering, on-chain reads, benchmark cache loading, price-derived, scrvUSD current-rate, and B.Protocol helpers
- `yield-sync/resolve.ts`: per-coin source resolution and auto-discovery candidate shaping
- `yield-sync/evaluation.ts`: source-aware history normalization, trailing metric computation, confidence arbitration, and source-change tracking
- `yield-sync/publication.ts` + `yield-sync/rankings.ts`: persistence helpers, rankings shaping, provenance/warning parsing, TVL-weighted median helper, and cache writes
- `yield-sync/history.ts`: batched history preloads plus stale/orphan cleanup
- `yield-sync/coordinator-fetch-stage.ts`: preflight, writer-pause enforcement, published-generation repair, source-state loading, and safety-input progress
- `yield-sync/coordinator-normalize-stage.ts`: source resolution, history loading/normalization, and cooperative evaluation progress
- `yield-sync/coordinator-health-telemetry-stage.ts`: deterministic-source health, coverage guards, preview artifacts, degradation policy, and publication-readiness telemetry
- `yield-sync/coordinator-persist-stage.ts`: generation publication, completion telemetry, and final cron metadata
- `sync-yield-data.ts`: public cron entrypoint that sequences the four stages and preserves early degraded returns

### `sync-yield-supplemental`

**Schedule:** `25 */4 * * *` (every 4 hours on a dedicated supplemental trigger)
**Files:** `worker/src/cron/sync-yield-supplemental.ts` + helper modules under `worker/src/cron/yield-sync/`

This best-effort cron owns the heavier optional families that used to run inline on the publisher path:

- `Morpho`
- `Pendle`
- `Yearn/Kong`
- `Beefy`
- `Royco Dawn`
- `Compound V3`
- `Aave V3`
- `vaults.fyi` (disabled by default; audit-only inventory unless explicit vault allowlist entries are configured)

It fetches those families, serializes the resolved candidate set into a cache snapshot, and lets the hourly publisher consume that snapshot. Empty snapshots are treated as degraded and do not overwrite the previous cache.

vaults.fyi participates as a supplemental-family cache row only when explicitly enabled. Without `VAULTS_FYI_RANKABLE_VAULTS`, its output remains audit-only telemetry and contributes no supplemental candidates. `sourceFamilyCounts.vaultsFyi` tracks emitted candidates, while `sourceFamilyInventoryCounts.vaultsFyi` and the vaults.fyi provider telemetry track audit inventory volume. With allowlisted vaults, emitted rows use the same cached supplemental-source path as the other optional families and remain subject to the hourly publisher's existing freshness, dedupe, source-risk, and publication-collapse guards.

**Shared safety scores:** The report-cards API handler doesn't cache results, so both yield sync and daily digest call the same shared safety-score pipeline. That helper now shares peg analytics with `/api/report-cards`, preventing rated coins with live price/peg coverage from falling back to `NR` inside yield rankings. It still uses the two-phase dependency approach (independent first, then CeFi-dependent).

**History query policy:** Previous-best reads select the latest published row through indexed per-coin point queries. Previous-TVL reads select the latest published row through indexed per-coin/source point queries scoped to source keys resolved in the current run, with a legacy null-source fallback only for single-source coins. The 30d APY history read remains chunked by stablecoin IDs and indexed by stablecoin ID in memory. Cleanup deletes also chunk ID lists to stay under D1's 100-bound-parameter cap.

### `fetch-tbill-rate`

**Schedule:** `0 8 * * *` (daily lightweight snapshot/fetch lane)
**File:** `worker/src/cron/fetch-tbill-rate.ts`

Fetches the benchmark registry used by Yield Intelligence:

- USD 3M Treasury yield from FRED `DGS3MO`, falling back to Treasury.gov yield XML when FRED is unavailable
- USD Effective Federal Funds Rate from the New York Fed latest EFFR endpoint, with FRED `DFF` as fallback, stored as optional `USD_EFFR` for EFFR-linked products such as USDGO
- EUR 3M compounded €STR from the ECB Data API (`EST/B.EU000A2QQF32.CR`)
- CHF 3M compounded SARON (`SAR3MC`) from SIX's delayed public download, fetched through the guest OAuth + report-download flow used by their public site
- GBP 3M compounded SONIA from the SONIA Compounded Index `IUDZOS2`, annualized from the trailing 90-day index change, fetched through FRED graph CSV, ALFRED graph CSV, then Bank of England IADB fallback (v8.296)
- JPY call-rate proxy from Bank of Japan Time-Series Data Search `STRDCLUCON` (v8.22)
- MXN CETES 28-day from Banxico SIE (`SF43936`), with retained-last-market fallback only when a prior market source exists (v8.293 removed the Etherfuse degraded benchmark proxy)
- BRL SELIC overnight from BCB SGS series 11 (no auth), annualized from the daily percentage over 252 business days before scoring (v8.13)
- AUD cash-rate target from the Reserve Bank of Australia F1 money-market CSV (v8.22)
- CAD CORRA proxy from Bank of Canada Valet `V122530` (v8.13)
- RUB CBR key rate from the Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed (v8.291)
- TRY BIST TLREF overnight from CBRT EVDS series `TP.BISTTLREF.ORAN` (v8.29)

Validated rates must stay within `[-10, 20]` so EUR / CHF support can tolerate negative-rate regimes; RUB and TRY use `[-10, 100]` because recent local reference rates can exceed the normal 20% ceiling. The cron writes the structured `"risk_free_rates"` cache and also mirrors USD into the legacy `"risk_free_rate"` key for compatibility.

When a fetch fails but a prior benchmark exists, the cache preserves the last market-derived benchmark fields (`lastMarketRate`, `lastMarketRecordDate`, `lastMarketFetchedAt`, `lastMarketSource`) across retained fallback streaks. That lets downstream yield provenance distinguish "still carrying the last market rate" from a hardcoded or proxy default.

---

## API Endpoints

### `GET /api/yield-rankings`

Cache-backed rankings written by `sync-yield-data`, with `safetyScore`, `safetyGrade`, `yieldToRisk`, and `pharosYieldScore` hydrated from the current report-card snapshot at API read time. This keeps Yield Intelligence aligned with `/api/report-cards` even when underlying safety inputs move between yield cron runs. If a ranking row has no matching live report-card snapshot, the API now retains the row and falls back to `DEFAULT_SAFETY_SCORE` (`40`) and grade `NR` instead of dropping coverage.

**Cache profile:** Standard (`s-maxage=300, max-age=60`)

**Response shape:**

```json
{
  "rankings": [
    {
      "id": "usde-ethena",
      "symbol": "USDe",
      "name": "Ethena USDe",
      "currentApy": 12.4,
      "apy7d": 11.8,
      "apy30d": 10.2,
      "apyBase": 10.2,
      "apyReward": null,
      "yieldSource": "Ethena staking (sUSDe)",
      "yieldSourceUrl": "https://ethena.fi/",
      "yieldType": "lending-vault",
      "dataSource": "defillama",
      "sourceTvlUsd": 5200000000,
      "pharosYieldScore": 28,
      "safetyScore": 65,
      "safetyGrade": "B",
      "yieldToRisk": 0.33,
      "excessYield": 5.95,
      "benchmarkKey": "USD",
      "benchmarkLabel": "USD 3M T-Bill",
      "benchmarkCurrency": "USD",
      "benchmarkRate": 4.25,
      "benchmarkRecordDate": "2026-03-25",
      "benchmarkIsFallback": false,
      "benchmarkFallbackMode": null,
      "benchmarkSelectionMode": "native",
      "benchmarkIsProxy": false,
      "yieldStability": 0.82,
      "apyVariance30d": 2.1,
      "apyMin30d": 7.5,
      "apyMax30d": 15.3,
      "warningSignals": [],
      "altSources": [
        {
          "sourceKey": "ee0b7069-...",
          "yieldSource": "Concentrator (fxSAVE)",
          "yieldSourceUrl": "https://fx.aladdin.club",
          "yieldType": "lending-vault",
          "currentApy": 9.1,
          "apy30d": 8.8,
          "sourceTvlUsd": 31000000,
          "dataSource": "defillama",
          "sourceRisk": {
            "sourceRiskPenalty": 1.12,
            "sourceDepthRatio": 0.004,
            "rewardShare": 0.18,
            "venueRiskTier": "unknown"
          }
        }
      ],
      "provenance": {
        "confidenceTier": "curated",
        "selectionReason": "curated canonical source selected by confidence-weighted arbitration",
        "sourceSwitch": false
      },
      "publicationGenerationId": "yield-1772000000",
      "publishedRank": 3,
      "liveRank": 3,
      "sourceRisk": {
        "sourceRiskPenalty": 1,
        "sourceDepthRatio": 0.02,
        "rewardShare": 0,
        "sourceAgeSeconds": 900,
        "venueRiskTier": "unknown"
      }
    }
  ],
  "riskFreeRate": 4.25,
  "benchmarks": {
    "USD": {
      "key": "USD",
      "label": "USD 3M T-Bill",
      "currency": "USD",
      "rate": 4.25,
      "recordDate": "2026-03-25",
      "source": "fred-dgs3mo",
      "isFallback": false,
      "fallbackMode": null,
      "isProxy": false
    },
    "EUR": {
      "key": "EUR",
      "label": "EUR 3M compounded €STR",
      "currency": "EUR",
      "rate": 1.9358,
      "recordDate": "2026-03-26",
      "source": "ecb-estr-3m",
      "isFallback": false,
      "fallbackMode": null,
      "isProxy": false
    },
    "CHF": {
      "key": "CHF",
      "label": "CHF 3M compounded SARON",
      "currency": "CHF",
      "rate": -0.0539,
      "recordDate": "2026-03-25",
      "source": "six-sar3mc",
      "isFallback": false,
      "fallbackMode": null,
      "isProxy": false
    },
    "RUB": {
      "key": "RUB",
      "label": "RUB CBR key rate",
      "currency": "RUB",
      "rate": 14.5,
      "recordDate": "2026-06-11",
      "source": "cbr-key-rate",
      "isFallback": false,
      "fallbackMode": null,
      "isProxy": false
    },
    "TRY": {
      "key": "TRY",
      "label": "TRY BIST TLREF overnight",
      "currency": "TRY",
      "rate": 40.0,
      "recordDate": "2026-06-08",
      "source": "cbrt-evds-tlref",
      "isFallback": false,
      "fallbackMode": null,
      "isProxy": false
    }
  },
  "scalingFactor": 8,
  "medianApy": 4.21,
  "updatedAt": 1772000000,
  "publication": {
    "generationId": "yield-1772000000",
    "updatedAt": 1772000000,
    "cutoffAt": 1772000000,
    "schemaVersion": 1,
    "status": "published"
  },
  "methodology": {
    "version": "8.298",
    "currentVersion": "8.298",
    "changelogPath": "/methodology/yield-changelog/"
  },
  "_meta": { "updatedAt": 1772000000, "ageSeconds": 42, "status": "fresh" }
}
```

Default sort: `pharos_yield_score` DESC. `altSources` is an empty array for coins with only one yield source. `medianApy` is the TVL-weighted median of best-source `apy30d` values and is used by peer-reference warning heuristics. Generation-aware payloads include top-level `publication` and optional row-level `publicationGenerationId`; legacy rows remain valid when those fields are omitted. Rankings payloads may also include the standard Yield Intelligence `methodology` envelope.

Each best-source row and alt-source row can also include `yieldSourceUrl`. The worker resolves this from the curated yield-source link registry (`worker/src/lib/yield-source-links.ts`) and falls back to coin metadata links when no source-specific override exists.

Public source-risk evidence is nested under `sourceRisk` on selected rows and retained alternates. Missing, `null`, or `venueRiskTier: "unknown"` evidence is neutral; public examples must not expose flattened top-level fields such as `sourceRiskPenalty` or `rewardShare`.

Selected rows and retained alternates carry API-owned source role metadata so clients do not infer policy from labels: `canonical-holder`, `external-opportunity`, `fallback-proxy`, `audit-alternate`, or `degraded-canonical`. Retained alternates also carry `confidenceTier`, `selectionRank`, and `rejectionReasonCode`; the optional `alternateSummary` object reports the retained count, best alternate by 30d APY, best alternate by source-risk-adjusted utility, and the APY spread versus the selected source. These fields expose existing arbitration output only; they do not change ranking selection, PYS scoring, or methodology versioning.

The response includes a `_meta` freshness object (see [Response Body Freshness](api-reference.md#response-body-freshness-_meta)) indicating data age and staleness status. The frontend uses this to power the `StaleDataBanner` on the yield page.

### `GET /api/yield-history`

Historical APY data points for a single coin. Reads from `yield_history` directly. If a stored `warning_signals` payload is malformed, the API treats it as an empty array rather than failing the whole request.

**Cache profile:** Slow (`s-maxage=3600, max-age=300`)

| Param        | Type    | Default  | Bounds           | Description                                                                      |
| ------------ | ------- | -------- | ---------------- | -------------------------------------------------------------------------------- |
| `stablecoin` | string  | required | —                | Pharos stablecoin ID                                                             |
| `days`       | integer | 90       | 1–365            | Lookback window                                                                  |
| `mode`       | string  | best     | `best`, `source` | `best` for historically selected best-source rows; `source` requires `sourceKey` |
| `sourceKey`  | string  | —        | —                | When present, returns source-specific history for that source key                |

**Response:** Envelope with:

- `current`: latest row in the returned window, or `null`
- `history`: array sorted by `date` ASC
- `warning`: optional handler warning when the freshness cutoff lookup falls back
- `methodology`: standard methodology envelope for Yield Intelligence

Each `history` row includes:

- `date`
- `apy`
- `apyBase`
- `apyReward`
- `exchangeRate`
- `sourceTvlUsd`
- `warningSignals`
- `sourceKey`
- `yieldSource`
- `yieldSourceUrl`
- `yieldType`
- `dataSource`
- `isBest`
- `sourceSwitch`

`warningSignals` type: `string[]`.

---

## Frontend

### Page: `/yield`

**Files:** `src/app/yield/page.tsx` (SSG wrapper), `src/app/yield/client.tsx` (interactive)

**Layout (top to bottom):**

1. `QueryErrorNotice` when the rankings query fails
2. Stale data banner (tracks the hourly core publish lane and warns when rankings are delayed or stale)
3. Optional selector handoff strip when opened from the Stablecoin Picker
4. Hero scatter card with the summary metrics integrated into the card header
5. Risk-budget slider and filter controls
6. Yield leaderboard table
7. Reference rates strip, Yield Sources board for the active filtered ranking scope, and coin index
8. Disclaimer / FAQ

### Page: `/stablecoin/[id]/yield/`

**Files:** `src/app/stablecoin/[id]/yield/page.tsx` (SSG wrapper), `src/app/stablecoin/[id]/yield/client.tsx` (interactive)

Generated for every non-pre-launch tracked coin (lending-opportunity rows can appear for any tracked stablecoin, so the deep link must be reachable beyond `flags.yieldBearing`). The route renders the peer rail, per-source APY history, warning-signal timeline, and source-switch history for the selected coin; coins with no live yield row render an empty-state card, and only IDs absent from the tracked registry return `notFound()`. All known-coin pages carry noindex (`robots: { index: false, follow: true }`) metadata.

### `YieldSourceBoard` (`src/app/yield/source-board.tsx`)

Compact source-mix board rendered after the scatter on `/yield`. It consumes the pure `buildYieldSourceBoardModel(rankings, options)` output from `src/app/yield/source-board-model.ts` and stays scoped to the currently visible, peg-filtered rankings.

The board renders a minimal surface focused on which data families back the visible rows:

- header: kicker, "Source mix in the current view" heading, and a one-line helper noting the board counts every chosen source plus retained alternates
- chips: chosen-source source-changed count and chosen-source anomaly count from row provenance, each with a tooltip explaining the meaning
- source-quality bars: visible-row posture mix (`Clean`, `Watch`, `Speculative`), confidence tier mix, and source-depth mix
- source-risk driver chips: the most common populated source-risk drivers in the current visible rows, with tooltips carrying the driver definitions
- source lanes grouped by `yieldType` and `dataSource`, each row showing the yield-type badge, data-family label, total observation count (chosen + retained alternates), and up to three of the most-represented source labels with the long tail summarised as "+N more"

`Clean` means a non-thin, fresh selected source with no material source-risk penalty or source-change evidence. `Watch` means medium or explainable source-risk evidence, including unknown venue evidence debt, while `Speculative` means high venue risk, thin/stale/reward-heavy evidence, multiple active source-risk drivers, or a material source-risk penalty. The posture, confidence, and depth segments are clickable filter affordances: `sourcePosture=watch` remains the Balanced risk-budget clean-or-watch cap, while exact Watch segment clicks use `sourcePosture=watch-only`. The board uses a board-owned baseline for these axes so the selected segment can stay highlighted without collapsing the mix into a misleading 100% view. This board is presentation-only: it derives those groups from published ranking fields and does not change APY source resolution, source arbitration, PYS, or methodology versioning.

### Stablecoin Detail: `YieldDetailSection` (`src/components/yield-detail-section.tsx`)

Yield intelligence section for stablecoin detail pages. Shows stat cards (Current APY, 30d APY, PYS with breakdown, Stability) plus 30d Excess Yield, source info, source links, alt sources, warning callouts, embedded `YieldHistoryChart`, and contextual methodology hints / footer links for PYS and yield stability. Conditional: only renders for coins with yield data.

It reuses the cached `/api/yield-rankings` payload to find the coin's chosen source row, surfaces row-level provenance (decision-ledger reason, source age, benchmark state, source-changed state, previous source key when available), and passes the selected benchmark context, peer median, and source list into `YieldHistoryChart`.

**Layout (top to bottom):**

1. Header row: "Yield Intelligence" + yield-type badge from `YIELD_TYPE_LABELS` / `YIELD_TYPE_STYLES`
2. Warning treatment:
   - 2+ active signals: amber callout block listing every warning label
   - 1 active signal: compact inline alert row
3. 30d Excess Yield callout plus four stat cards: Current APY, 30d APY, PYS (with click/focus disclosure for the score breakdown), Stability
4. Compact `YieldSourceRiskCard` for the selected source, including posture, score, penalty, source depth, freshness, driver chips, venue tier/confidence, and dependency concentration when populated
5. Decision-ledger card explaining why the selected source won when the API payload includes source arbitration evidence
6. Source info row: clickable source name, normalized data-source badge, source TVL
7. Retained alternates list when `altSources.length > 0`, with alternate confidence, depth, compact source-risk score/penalty, and rejection reason when inferred
8. Shared `YieldHistoryChart`

The section returns `null` once rankings have loaded and the coin is neither `yieldBearing` nor present in the rankings cache. If a coin is marked `yieldBearing` in metadata but has no ranking row yet, it renders an inline empty/error state instead of silently disappearing.

### `YieldScatterPlot` (`src/components/yield-scatter-plot.tsx`)

Recharts scatter chart. X = safety score, Y = APY (%). The chart plots one best-source point per stablecoin, auto-focuses the x-axis on the occupied safety-score band instead of always rendering the full 0-100 range, and keeps the safety threshold at 60 visible for quadrant context. Scatter markers render each stablecoin's logo (with an initial fallback if no logo exists), and yield type information lives in the tooltip instead of a separate legend. Rare high-APY outliers are pinned to a disclosed top rail so one extreme point does not flatten the rest of the plot.

**Quadrants** (divided at safety = 60 and APY = the visible benchmark frame rate):

| Quadrant     | Position                     | Color              |
| ------------ | ---------------------------- | ------------------ |
| Sweet Spot   | High safety, above benchmark | Green (5% opacity) |
| Danger Zone  | Low safety, above benchmark  | Red (5% opacity)   |
| Play It Safe | High safety, below benchmark | Blue (5% opacity)  |
| Why Bother?  | Low safety, below benchmark  | Gray (5% opacity)  |

Dashed reference line at the benchmark frame rate. On benchmark-homogeneous scopes, that frame uses the shared visible benchmark. On mixed scopes, the chart keeps the overlay visible by using the default USD benchmark as a shared orientation frame while the table and row tags continue to show each stablecoin's local benchmark context. Scatter tooltips show each row's own benchmark label/rate and 30d excess-yield value. Click a dot to navigate to that coin's detail page.

### `YieldLeaderboard` (`src/components/yield-leaderboard.tsx`)

Sortable, paginated leaderboard (25 rows/page). Default sort: PYS descending. From `md` upward it renders the dense table; below `md` it renders first-class mobile cards with the same sort and pagination state plus direct Detail, Provider, Source, and History actions. Table headers for `PYS`, `Stability`, and `Signals` use the shared methodology-hint trigger so users can read the local definition without leaving the leaderboard.

The filter row above the table is backed by `YieldViewModel` and URL query keys for `q`, `peg`, `yieldType`, `warnings`, `minSafety`, `minTvl`, `depth`, `sourceChanged`, `sourcePosture`, `sourceConfidence`, `benchmark`, `opportunity`, `trending`, `watchlist`, and `attention`. `sourcePosture=clean` shows clean rows only, `sourcePosture=watch` is a clean-or-watch cap used by the Balanced risk budget, `sourcePosture=watch-only` isolates exact Watch posture rows, and `sourcePosture=speculative` isolates speculative rows. `attention=watchlist` is a composite watchlist risk inbox: starred rows with an active warning or source-change evidence. Risk-budget stops own only risk keys (`minSafety`, `depth`, `sourcePosture`, `sourceConfidence`, and `warnings`) so research context such as peg, search, and yield type remains intact. The trust rail promotes body-level API warnings from `YieldRankingsResponse.warnings`, including degraded live safety hydration, before the table. Search and filters feed rows into the shared sort/pagination pipeline, with page index reset whenever controls change the visible row set.

**Columns:** Rank, Coin (logo + symbol), APY (30d), Grade, PYS, Source, Type (badge), TVL, Stability (bar + %), 30d Range, Signals, and a trailing chevron for row expansion.

Stability display multiplies the raw 0–1 value by 100 for both the bar width and the percentage text.

**PYS tooltip:** Hovering a non-null PYS score opens a component breakdown tooltip with Effective Yield, benchmark adjustment, Source Risk Penalty, Yield Efficiency, the adjusted safety-penalty line, Safety (grade + score with `40` fallback), Consistency (`max(0.3, yieldStability)` shown as a percentage), and the active source-risk driver labels. Detail-page PYS breakdowns pass the nested `sourceRisk.sourceRiskPenalty` so the displayed decomposition matches the API score.

**Signals column (desktop/tablet):** Rows with no active warnings show an em dash. Rows with one warning show an amber outline alert icon. Rows with two or more warnings show a filled amber icon and an additional subtle amber left border on the row. Hovering the icon opens a tooltip with human-readable warning descriptions and an actionable next check (`yield-spike`, `yield-divergence`, `negative-trend`, `reward-heavy`, `tvl-outflow`, `zero-yield`, `data-stale`, `low-source-tvl`).

**Source inspection:** The table row delegates source inspection to the shared `YieldSourceSheet`, which opens from the retained source controls in the row/expanded state instead of the old inline `+N` popover. The sheet uses the same `YieldSourceRiskCard` and decision-ledger card as the detail surfaces. When a retained alternate is selected inside the sheet, the risk card follows that active source; otherwise it displays the canonical chosen-source risk.

**Source-risk visibility:** Desktop and mobile rows show a labeled compact summary such as `Source risk 42/100 | 1.32x` when the nested source-risk penalty is material. Stablecoin detail yield surfaces render a permanent `YieldSourceRiskCard`; the embedded detail section uses the compact variant, while `/stablecoin/<id>/yield/` keeps the full card and `VenueRiskBreakdown` when `sourceRisk.venueRiskScores` exists. These use the published `sourceRisk.sourceRiskScore` and `sourceRisk.sourceRiskPenalty` fields and are visibility changes only; neutral or missing evidence stays visually quiet.

**Inline expansion:** Clicking a leaderboard row toggles an inline `YieldHistoryChart` panel directly beneath that row. The expanded panel repeats the selected source as a clickable link above the chart, shows the decision-ledger card when present, passes the selected row benchmark, `medianApy`, and available source list into compact mode, and only one row can remain expanded at a time.

### `YieldHistoryChart` (`src/components/yield-history-chart.tsx`)

The chart now supports source-aware inspection. When retained alternates exist, users can switch between:

- `Best source`: historically selected best-source rows (`mode=best`)
- a specific retained source row (`sourceKey=<key>`)

This lets the detail page and leaderboard inspect the actual history of a retained alternate instead of only showing its current snapshot.

Recharts line chart. Primary APY line with optional base/reward breakdown toggle. Two reference lines: the row's benchmark rate and peer median APY. Warning signal markers on data points. Time presets: 7d / 30d / 90d / 1y. The legend labels the primary line source and keys source overlays by `sourceKey`, adding a short source-key suffix when two retained sources share the same display name.

It reads `/api/yield-history` through `useYieldHistory`, and points carrying `warningSignals` get amber markers so spike/divergence/reward-heavy regimes are visible without expanding the tooltip. Source-change markers use readable tooltip copy that explains the marker as source provenance churn, not an asset-risk change.

The control row exposes four fixed lookback presets (`7d`, `30d`, `90d`, `1y`) plus an optional breakdown toggle. Compact mode keeps the same data semantics for inline leaderboard expansion, but shortens the chart height to 200px and drops reference-line labels to protect legibility in tighter rows.

### Hooks

| Hook                      | File                     | Endpoint                      | Stale Time            |
| ------------------------- | ------------------------ | ----------------------------- | --------------------- |
| `useYieldRankings`        | `src/hooks/api-hooks.ts` | `/api/yield-rankings`         | `CRON_YIELD` (1 hour) |
| `useYieldHistory`         | `src/hooks/api-hooks.ts` | `/api/yield-history`          | `CRON_YIELD` (1 hour) |
| `useYieldAdapterManifest` | `src/hooks/api-hooks.ts` | `/api/yield-adapter-manifest` | `CRON_YIELD` (1 hour) |

---

## Constants

**File:** `worker/src/lib/constants.ts`

| Constant                                | Value                                                                                                  | Purpose                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `RISK_FREE_RATE_FALLBACK`               | 3.75                                                                                                   | Fallback T-bill rate (%)                                                                      |
| `FRED_TBILL_CSV_URL`                    | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO`                                            | FRED daily 3-month Treasury yield series                                                      |
| `NYFED_EFFR_JSON_URL`                   | `https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json`                                  | New York Fed latest Effective Federal Funds Rate endpoint used for EFFR-linked yield products |
| `FRED_EFFR_CSV_URL`                     | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF`                                               | FRED daily Effective Federal Funds Rate series retained as the USD_EFFR fallback feed         |
| `FRED_SONIA_COMPOUNDED_INDEX_CSV_URL`   | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=IUDZOS2`                                           | FRED graph CSV mirror for the Bank of England SONIA Compounded Index (`IUDZOS2`)              |
| `ALFRED_SONIA_COMPOUNDED_INDEX_CSV_URL` | `https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=IUDZOS2`                                       | ALFRED graph CSV mirror for the same SONIA Compounded Index series                            |
| `TREASURY_YIELD_XML_URL`                | `https://home.treasury.gov/sites/default/files/interest-rates/yield.xml`                               | Treasury.gov daily yield curve XML fallback for USD 3M                                        |
| `ECB_ESTR_3M_CSV_URL`                   | `https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata` | Official ECB 3M compounded €STR feed                                                          |
| `SIX_OAUTH_TOKEN_URL`                   | `https://indexdata.six-group.com/pro/oauth/token`                                                      | Public SIX guest OAuth endpoint for delayed downloads                                         |
| `SIX_REPORT_DOWNLOAD_URL`               | `https://indexdata.six-group.com/pro/api/report-download`                                              | SIX download broker for delayed public report files                                           |
| `SIX_SARON_3M_CSV_URL`                  | `https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv`                                  | Delayed public CSV for `SAR3MC`                                                               |
| `SIX_BROWSER_USER_AGENT`                | `Mozilla/5.0`                                                                                          | Browser-compatible UA required by SIX guest endpoints                                         |
| `BOE_SONIA_CSV_BASE_URL`                | `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp`                           | Bank of England IADB SONIA Compounded Index CSV base path (`SeriesCodes=IUDZOS2`)             |
| `CBR_DAILY_INFO_SOAP_URL`               | `https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx`                                                   | Central Bank of Russia DailyInfo SOAP endpoint used for `KeyRateXML`                          |
| `CBRT_EVDS_FE_URL`                      | `https://evds3.tcmb.gov.tr/igmevdsms-dis/fe`                                                           | CBRT EVDS3 feed endpoint used for BIST TLREF (`TP.BISTTLREF.ORAN`)                            |
| `BOJ_CALL_RATE_JSON_BASE_URL`           | `https://www.stat-search.boj.or.jp/api/v1/getDataCode`                                                 | Bank of Japan call-rate API base path                                                         |
| `RBA_F1_MONEY_MARKET_CSV_URL`           | `https://www.rba.gov.au/statistics/tables/csv/f1-data.csv`                                             | Reserve Bank of Australia F1 money-market CSV                                                 |
| `PYS_SCALING_FACTOR`                    | 8                                                                                                      | PYS distribution tuning parameter after safety-curve steepening                               |
| `DEFAULT_SAFETY_SCORE`                  | 40                                                                                                     | Safety score for unrated coins (most NAV tokens)                                              |
| `CIRCUIT_SOURCE.DL_YIELDS`              | `"defillama-yields"`                                                                                   | Circuit breaker key for DL Yields API                                                         |
| `CIRCUIT_SOURCE.TREASURY_RATES`         | `"treasury-rates"`                                                                                     | Circuit breaker key for the benchmark-registry fetch lane                                     |

---

## Testing

**Pure function tests:** `worker/src/cron/__tests__/yield-helpers.test.ts`

- `computeApyFromRate` — 7-day rate change, zero/negative inputs, decreasing rates
- `computeApyFromPrice` — delegates to `computeApyFromRate`
- `computePYS` — safe high-yield, safety penalty, variance penalty, 100 cap, negative APY
- `computeYieldStability` — stable vs. volatile yields, empty/single samples, near-zero mean → null guard
- `computeApyVarianceScore` — near-zero mean → null guard, insufficient samples → null
- `detectWarningSignals` — yield spike (with absolute floor), negative trend (with absolute floor), reward-heavy, TVL outflow, zero-yield, healthy baseline, boundary conditions, negative APY input
- `matchAllDlPools` — Layer 1/2/3 source matching, dedup, relaxed Layer 2 stablecoin filter, exact symbol match (no cross-contamination), address-corroborated wrapper fallback, highest-TVL selection, empty pools edge case, Layer 3 minimum symbol length guard (4-char cutoff), and no substring-only fallback
- `findBestLendingPool` — allowlist filtering, symbol match, address fallback, quality gates
- `computeTvlWeightedMedianApy` — empty input, null/zero TVL, single row, TVL-weighted vs simple median, zero APY filtering

**Integration tests:** `worker/src/cron/__tests__/sync-yield-data-discovery-coverage.test.ts`, `worker/src/cron/__tests__/sync-yield-data-lending-degradation.test.ts`, `worker/src/cron/__tests__/sync-yield-data-publication-cache.test.ts`, and `worker/src/cron/__tests__/sync-yield-data-rates-history.test.ts`

- Happy path, stale/orphan cleanup, D1 chunking, cached DL pools, deterministic auto-discovery override, B.Protocol LUSD, DL API failure, circuit breaker open, schema validation, price-derived fallback, source-specific history, legacy history carry-forward, rate-derived, degraded safety coverage, and mixed benchmark publication
- Deterministic/native coexistence: verifies on-chain rows can coexist with curated native rows without source-key collision
- Auto-discovery labeling: verifies `defillama-auto` rows on yield-bearing coins publish protocol-derived labels and `lending-opportunity`
- Retained benchmark degradation: verifies retained benchmark fallbacks stay marked degraded in rankings provenance

**Pool-filter tests:** `worker/src/cron/__tests__/pool-filter.test.ts`

- Preserves stablecoin single-exposure pools
- Preserves explicitly relevant wrappers like `fxSAVE` even when upstream `stablecoin` is false
- Rejects unrelated non-stablecoin pools and non-single exposure pools

**Resolve/arbitration tests:** `worker/src/cron/__tests__/yield-resolve.test.ts`

- DL curated source selection, deterministic rate-derived preference, cross-source divergence rejection, benchmark-aware excess yield, negative excess yield, hardcoded fallback rate, rate-derived from benchmark minus spread, rate floor at zero, yield-spike warning, TVL-outflow warning, stable conditions, PYS computation, PYS=0 for zero APY
- Price-derived as explicit source (Tier 3 path through resolve for navToken coins)
- Auto-discovery path (non-yield-bearing coin matches a lending pool via `AUTO_LENDING_POOL_MAP`)

**Cache parsing tests:** `worker/src/cron/__tests__/yield-cache.test.ts`

- `parseRiskFreeRateCache` / `parseRiskFreeRatesCache` — valid JSON, malformed JSON, missing fields, and negative-rate support for non-USD benchmarks
- `parseDlStablecoinPoolsCache` — valid JSON, malformed JSON, legacy format, missing fields, cache age computation, stale cache rejection

**Source link tests:** `worker/src/lib/__tests__/yield-source-links.test.ts`

- Curated protocol link for discovered source, source-specific override, metadata app link fallback, website fallback
- No-match case: returns null when no curated link, no protocol match, and no metadata link
- New lending protocols: verifies newly added protocol (Radiant v2) resolves a URL

---

## Edge Cases

- **First sync (no history):** `apy7d` and `apy30d` equal `currentApy`. PYS still computed.
- **On-chain rate bootstrapping:** When a Tier 1 vault has no previous exchange rate in history (first 7 days after config is added), the sync emits a seed row with `currentApy: 0` and the current `exchangeRate`. This persists the rate in `yield_history` so future cycles can compute APY once a 7-day-old reference point exists.
- **Unrated coins (no safety grade):** Safety score defaults to `DEFAULT_SAFETY_SCORE` (40, D-equivalent). Most NAV tokens hit this path since the report card framework doesn't grade them yet.
- **Incomplete live safety hydration:** rankings rows stay published with safety fallback `40 / NR` instead of being dropped.
- **All tiers fail:** Coin is recorded with `yield: null` and skipped in the write phase. No PYS computed. Logged as warning.
- **Negative APY:** Stored and displayed. PYS returns 0 for `apy30d <= 0`.
- **DL Yields circuit-broken:** Tier 2 skipped entirely. Coins with Tier 1 or Tier 3 coverage still get APY. Others get `yield: null`.
- **Cron gaps (7d filter):** The 7d trailing average uses timestamp-based filtering (`recorded_at >= now - 7d`) rather than proportional slicing, so gaps don't shift the window.
- **DL pool returns 0% for navToken:** When Tier 2 finds a DL pool but it reports 0% APY, Tier 3 price-derived is tried as an additional source. The `is_best` logic picks the higher APY. This covers upstream DL data staleness without relying on substring-only Layer 3 symbol matches.
- **Dividend-distributing tokens (BUIDL, YLDS):** These maintain a fixed $1.00 NAV and distribute yield as new tokens. Price-derived returns ~0% because the price doesn't change. Resolved via Tier 4 rate-derived, which computes APY from the selected benchmark rate minus the token's management fee spread.
- **Malformed persisted warning payloads:** `yield-history` treats them as `[]` so a single bad row cannot 500 the endpoint.

---

## File Index

| File                                                                  | Role                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker/migrations/0000_baseline.sql`                                 | Baseline `yield_data` / `yield_history` schema, including the historical multi-source and warning-signal additions                                                                                                            |
| `worker/src/cron/sync-yield-data.ts` + `worker/src/cron/yield-sync/*` | Yield sync orchestration and stage modules: source loading, resolution, evaluation, publication, history maintenance, and rankings caching                                                                                    |
| `worker/src/cron/sync-yield-supplemental.ts`                          | Slower optional-source cron that refreshes the cached supplemental candidate snapshot                                                                                                                                         |
| `worker/src/cron/yield-config.ts`                                     | Static config: `YIELD_POOL_MAP`, `YIELD_VARIANT_MAP`, `ON_CHAIN_RATE_CONFIGS`, `RATE_DERIVED_CONFIGS`                                                                                                                         |
| `worker/src/cron/yield-helpers.ts`                                    | Pure functions: APY, PYS, stability, variance, warning signals, `matchAllDlPools`                                                                                                                                             |
| `worker/src/cron/yield-sync/pool-filter.ts`                           | Pre-filter for wrapper-relevant DeFiLlama pools before matching                                                                                                                                                               |
| `worker/src/lib/yield-source-links.ts`                                | Curated yield-source link registry plus metadata fallback resolver for rankings/history payloads                                                                                                                              |
| `worker/src/cron/fetch-tbill-rate.ts`                                 | Daily benchmark-registry cron (USD T-bill, USD EFFR, EUR 3M compounded €STR, CHF 3M compounded SONIA, JPY call-rate proxy, MXN CETES 28d, BRL SELIC, AUD cash-rate target, CAD CORRA proxy, RUB CBR key rate, TRY BIST TLREF) |
| `worker/src/api/cache-handlers.ts`                                    | Cache-backed `GET /api/yield-rankings` handler with live Safety Score hydration (`handleYieldRankings`)                                                                                                                       |
| `worker/src/api/yield-history.ts`                                     | `GET /api/yield-history` handler                                                                                                                                                                                              |
| `shared/types/index.ts`                                               | `YieldConfig`, `YieldType`, `YieldRanking` (`.altSources: AltYieldSource[]`), `AltYieldSource`, `YieldRankingsResponse`, `YieldHistoryPoint`                                                                                  |
| `shared/lib/classification.ts`                                        | `YIELD_TYPE_LABELS`, `YIELD_TYPE_STYLES`                                                                                                                                                                                      |
| `src/hooks/api-hooks.ts`                                              | TanStack Query hook exports for `useYieldRankings()` and `useYieldHistory()`                                                                                                                                                  |
| `src/lib/yield-constants.ts`                                          | Warning-signal labels, `formatYieldWarningSignal`, `getPysColor`, `computePysBreakdown` — shared frontend yield utilities                                                                                                     |
| `src/lib/yield-decision-ledger.ts`                                    | Frontend display helper for source-selection decision-ledger reason/rejection labels                                                                                                                                          |
| `src/lib/yield-peers.ts`                                              | Pure peer-rail cohort selection for `/stablecoin/<id>/yield/`                                                                                                                                                                 |
| `src/lib/__tests__/yield-constants.test.ts`                           | Unit tests for shared frontend yield utilities                                                                                                                                                                                |
| `src/app/yield/page.tsx`                                              | SSG page wrapper with metadata                                                                                                                                                                                                |
| `src/app/yield/client.tsx`                                            | Interactive page: hero scatter, risk budget, filters, leaderboard, selector handoff strip, source board, and reference-rate surfaces                                                                                          |
| `src/app/yield/source-board-model.ts`                                 | Pure source-board model for chosen/retained-alternate source counts, source lanes, confidence counts, anomaly/source-change counts, depth counts, APY context, and benchmarks                                                 |
| `src/app/yield/source-board.tsx`                                      | Compact `/yield` source-provenance board with clickable posture/confidence/depth segments                                                                                                                                     |
| `src/app/stablecoin/[id]/yield/page.tsx`                              | SSG per-coin yield-analysis wrapper for intrinsic yield coins and curated auto-lending overrides; other known coins fall back to filtered `/yield/` through the Pages stablecoin function                                    |
| `src/app/stablecoin/[id]/yield/client.tsx`                            | Interactive per-coin yield-analysis surface with peer rail, APY history, warning timeline, and source-switch history                                                                                                          |
| `src/components/yield-decision-ledger-card.tsx`                       | Shared compact "Why this source won" card for expanded rows, sheets, and detail yield sections                                                                                                                                |
| `src/components/yield-detail-section.tsx`                             | Stablecoin detail-page yield section with warnings, decision-ledger card, source metadata, metric cards, and shared history chart                                                                                             |
| `src/components/yield-leaderboard.tsx`                                | Sortable rankings table with `+N` alt-source pill badge                                                                                                                                                                       |
| `src/components/yield-history-chart.tsx`                              | Shared APY history chart with row-benchmark / peer-median reference lines, optional base-reward split, and warning markers                                                                                                    |
| `src/components/yield-scatter-plot.tsx`                               | Risk-adjusted scatter visualization                                                                                                                                                                                           |
| `worker/src/cron/__tests__/yield-helpers.test.ts`                     | Unit tests for all pure yield functions                                                                                                                                                                                       |
| `worker/src/cron/__tests__/sync-yield-data-discovery-coverage.test.ts` | Integration tests for yield discovery, tracked coverage guards, and source-envelope behavior                                                                                                                                |
| `worker/src/cron/__tests__/sync-yield-data-lending-degradation.test.ts` | Integration tests for lending opportunities, safety degradation, and deterministic-source cooldown behavior                                                                                                                 |
| `worker/src/cron/__tests__/sync-yield-data-publication-cache.test.ts` | Integration tests for publication generations, cache guards, provenance, and writer-pause behavior                                                                                                                           |
| `worker/src/cron/__tests__/sync-yield-data-rates-history.test.ts`     | Integration tests for rate-derived sources, benchmarks, source-aware history, and cleanup behavior                                                                                                                           |
| `worker/src/cron/__tests__/pool-filter.test.ts`                       | Tests wrapper-preserving pre-filter behavior for cached/direct DeFiLlama pool ingestion                                                                                                                                       |
| `worker/src/cron/__tests__/yield-resolve.test.ts`                     | Resolve/arbitration tests (price-derived, auto-discovery, DL source selection, warnings)                                                                                                                                      |
| `worker/src/cron/__tests__/yield-cache.test.ts`                       | Cache parsing tests for DL pools and benchmark caches                                                                                                                                                                         |
| `worker/src/lib/__tests__/yield-source-links.test.ts`                 | Yield source link resolution tests (curated, protocol, metadata fallback)                                                                                                                                                     |

---

## Presentation Contracts (v8.13.x)

These conventions govern how `/yield/`-adjacent surfaces render the data already
published by `/api/yield-rankings`. They are presentation rules, not methodology
changes; the underlying scores and warnings are unchanged.

### Row visual budget

Every leaderboard row carries at most three fixed chip positions, in this order:
(a) confidence tier pill, (b) freshness stamp, (c) severity glyph stack that
combines warning-signal count with the source-risk penalty severity. New
row-level affordances must reuse one of these three positions or be deferred
to the expanded panel or detail page; the row itself stays scannable.

### Sparkbar grammar

The page exposes exactly two sparkbar idioms. The source-risk score (0-100)
sparkbar lives only in the source cell of leaderboard rows and in the
chosen-source card of the source sheet. The PYS history sparkline lives in
the expanded-row panel through the compact `YieldHistoryChart` context. No
other sparkbar grammars are introduced on `/yield/`.

### Embedded vs deep-link contract

The embedded yield section on the stablecoin detail page
(`src/components/yield-detail-section.tsx`) is at-a-glance: current state,
recent narrative, one chart, and the top alternates. The deep-link
`/stablecoin/<id>/yield/` surface
(`src/app/stablecoin/[id]/yield/client.tsx`) is history-first: full
timelines, decision rationale, and peer rail. Embedded summarises;
deep-link reveals. Both surfaces must avoid duplicating panels.
Deep-link yield pages are `noindex` and omitted from `sitemap.xml`; the indexable
SEO surface remains `/yield/` plus each stablecoin detail page because the
deep-link pages are runtime-data workbenches rather than static crawl targets.
The static export materializes workbenches only for intrinsic yield coins and
curated deterministic auto-lending overrides. A missing workbench for any other
known coin redirects to the comparison-filtered `/yield/` surface, so dynamic
lending discovery remains reachable without reserving ten export files per coin.

### Cross-surface handoffs

Stablecoin Picker yield-profile results can link into Yield Intelligence with
`from=selector`. Multi-result shortlists use `/yield/?from=selector&compare=...`
so the comparison drawer opens on the selected candidates; single-result
shortlists also include `q=<symbol>` for immediate row focus. `/yield/` shows a
small return strip for that selector-origin state without treating `from` as a
filter key.

### PYS attribution convention

To express a PYS component as a marginal-point delta, neutralize the factor
under inspection (set it to its neutral baseline: source-risk penalty &rarr;
`1.0`, sustainability multiplier &rarr; `1.0`, safety penalty &rarr; `1.0`)
and recompute PYS via `computePYS`. The signed difference vs the actual PYS
is that factor's contribution in PYS points. Because attribution is
per-factor and not sequential, the attributed points may not sum exactly to
the total PYS; this caveat must accompany any rendered attribution so users
read it as decomposition, not a residual-free reconciliation.
