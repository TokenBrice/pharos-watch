# Yield Intelligence Methodology - Version Timeline

Internal changelog reconstructed from git history. Runtime currently reports Yield Intelligence `v8.31`.

---

> Older entries are archived in [yield-intelligence-timeline-archive.md](./yield-intelligence-timeline-archive.md); this file keeps the 10 most recent versioned entries.

## v8.31 - Evidence Qualification and Reproducible History (July 10, 2026)

- Separates deterministic calculation mechanics from evidence quality through typed calculation mode, evidence class, completeness, and score qualification fields
- Reclassifies rate-derived products as modeled proxies, below fresh direct first-party, on-chain, and curated observations in arbitration
- Withholds exact PYS for missing or stale critical source, benchmark, or safety evidence; modeled/fallback rows are estimated and noncritical gaps are partial
- Persists the exact versioned APY30d, safety, variance, benchmark, source-risk, scaling, qualification, benchmark-key, evidence-class, and methodology inputs used by every new PYS history point
- Marks post-migration history as exactly reproducible and legacy points as partial rather than manufacturing unavailable inputs
- Leaves PYS formula weights, benchmark rates, source-risk calibration, and Report Card scores unchanged

---

## v8.3 - Registry-Wide Freshness Eligibility (July 10, 2026)

- Applies source-family and benchmark TTLs before confidence arbitration, so fresh curated observations outrank expired deterministic or rate-derived candidates
- Retains expired candidates as auditable alternatives; a stale-only winner remains visible as last-known context with `pharosYieldScore: null`
- Publishes `sourceFreshness`, `benchmarkFreshness`, and `scoreQualified` provenance plus `source-stale` / `benchmark-stale` PYS null reasons
- Uses a 48-hour hard benchmark scoring TTL; fallback or retained benchmarks degrade health, while expired benchmarks cannot support an exact PYS
- Rolls Yield Health up across every benchmark used by published rows, so fresh USD plus stale GBP reports aggregate degraded with GBP identified
- Leaves PYS formula weights, source-risk calibration, benchmark provider order, and benchmark rate derivation unchanged

---

## v8.299 - Source Identity and Freshness Correctness (July 10, 2026)

- Preserves linked-variant, protocol-specific, and other modern on-chain source keys; only null/`legacy-best` history and the explicit LUSD `bprotocol-lqty-only` legacy identity normalize to the deterministic parent key
- Reclassifies the historical linked-variant false-switch pattern only after two consecutive clean published generations, then lets the normal 30-day audit retention remove corrected noise
- Gives rate-derived observations a 48-hour freshness window, price-derived observations 36 hours, price-derived plus Midas/Ondo NAV anchors 45 days, and ordinary exchange-rate anchors 14 days
- Publishes explicit `safetyReason` values for missing report-card scores, explicit `NR` grades, and Royco rows whose underlying report-card score is missing
- Marks vaults.fyi operation as `disabled`, `probe-only`, or `rankable`, so an enabled empty allowlist is visibly non-consumable
- Records bounded FRED/ALFRED/BoE GBP response diagnostics and adds a canary requiring two consecutive direct, current GBP SONIA publications
- PYS formula, venue/source-risk calibration, benchmark derivation and provider order, and confidence-weighted source arbitration are unchanged

---

## v8.298 - Yearn-Report Venue-Risk Recalibration (July 1, 2026)

- Recalibrates reviewed venue sub-scores against Yearn's newly-published per-protocol risk reports (documentation cross-check, not a runtime feed)
- Lowers five direct-match RWA/credit venues that scored harsher than Yearn: `3jane-lending` (audits/centralization/funds 5→4, liquidity/operational 4→3), `cap` (centralization 4→3, funds 4→3, operational 3→2), `maple` (funds 4→3, liquidity 4→3), `centrifuge` (funds 4→3, liquidity 4→3), `fluid-lending` (centralization 3→2, funds 3→2)
- Venue penalties fall `(weighted − 2.0) × 0.15`: 3jane 0.42→0.27, cap 0.21→0.11, maple 0.18→0.11, centrifuge 0.15→0.08, fluid-lending 0.09→0; `fluid-lending` moves medium→low and leaves the DEWS structured-medium-risk-venue branch (DEWS thresholds unchanged)
- Upgrades `3jane-lending` confidence partial→verified (four dedicated audits + Morpho Blue base + Certora) and updates its metadata rationale/evidence
- Raises `sparklend` and `spark-savings` funds management 1→2 for shared MCD_VAT backing, and moves `yearn`/`yearn-finance` operational 2→1; all three stay below the 2.0 knee so the blue-chip no-op holds and no penalty changes
- Adds two low-severity (zero-penalty, informational) dependency-concentration entries `syrupusdc-maple` and `syrupusdt-maple` = Maple (Pool Delegate), surfacing the single off-chain EOA that originates ~97% of syrupUSDC/USDT AUM; low severity avoids double-counting the `maple` venue tier
- Holds `aave-v3` (vs Yearn's sGHO report) and `morpho`/`morpho-v1`/`morpho-blue` (vs Yearn's Gauntlet Aera-vault report) unchanged — those are proxy matches whose deltas are product-specific
- PYS formula shape, tier thresholds, penalty curve, benchmark selection, dependency-concentration registry, history semantics, and publication guards are unchanged

---

## v8.297 - Optional vaults.fyi Supplemental Yield Source (June 29, 2026)

- vaults.fyi joins the four-hour supplemental lane as a disabled-by-default provider; unset/false `VAULTS_FYI_ENABLED` or a missing runtime key means no fetches and no candidates
- Enabled runs without `VAULTS_FYI_RANKABLE_VAULTS` perform bounded detailed-vault inventory probing for coverage review but publish no ranking candidates
- Explicit `network:vaultId` allowlist entries can emit supplemental lending-opportunity rows only after exact chain-plus-token-address stablecoin matching, TVL/APY/source-shape gates, and local credit-budget checks
- Provider quota/errors fail open into family telemetry; PYS formula, benchmark selection, deterministic source arbitration, history semantics, and publication guards are unchanged except for explicitly enabled and allowlisted supplemental rows

---

## v8.296 - GBP SONIA St. Louis Fed Mirror Redundancy (June 25, 2026)

- GBP benchmark refreshes still derive `GBP 3M compounded SONIA` from the Bank of England SONIA Compounded Index (`IUDZOS2`) over the same trailing 90-day window
- Source failover is now FRED graph CSV (`fred-sonia-compounded-index`), then ALFRED graph CSV (`alfred-sonia-compounded-index`), then Bank of England IADB (`boe-sonia-compounded-index`)
- The GBP rate, fallback mode `gbp-sonia-compounded-index-failed`, PYS formula, source-risk calibration, history semantics, and publication guards are unchanged

---

## v8.295 - GBP SONIA Benchmark Source Failover to FRED Mirror (June 25, 2026)

- GBP benchmark refreshes now fetch the SONIA Compounded Index (`IUDZOS2`) from FRED's reachable graph CSV and record successful observations with source `fred-sonia-compounded-index`
- The Bank of England IADB feed is retained as the secondary GBP source with provenance `boe-sonia-compounded-index`, used only when the FRED mirror is unavailable, because the BoE IADB host blocks Cloudflare Worker egress
- The derived value is unchanged: the same `IUDZOS2` compounded-index series and trailing 90-day annualization are applied, so the GBP rate, fallback mode `gbp-sonia-compounded-index-failed`, PYS formula, source-risk calibration, and publication guards are unchanged

---

## v8.294 - NY Fed EFFR Benchmark Source Hardening (June 22, 2026)

- USD_EFFR benchmark refreshes now prefer the official New York Fed latest EFFR endpoint and record successful live observations with source `nyfed-effr`
- FRED DFF remains wired as the secondary USD_EFFR source with provenance `fred-dff`, so a New York Fed endpoint outage can still publish a live market observation without marking the benchmark degraded
- When both live EFFR feeds fail, the cron retains the prior market USD_EFFR benchmark when available and marks the fallback as `usd-effr-sources-failed-retained`; otherwise it reports `usd-effr-sources-failed`
- PYS formula shape, source-risk calibration, benchmark selection semantics, history semantics, and publication guards are unchanged

---

## v8.293 - Banxico-Only MXN Benchmark Hardening (June 19, 2026)

- MXN benchmark resolution still prefers Banxico SIE `SF43936` with `BANXICO_TOKEN`, but no longer queries Etherfuse CETES current issuance when Banxico is unavailable
- Etherfuse CETES current issuance remains the `cetes-etherfuse` product APY source only; it is not written into the shared `risk_free_rates` benchmark cache as a global MXN proxy
- Degraded benchmark resolutions no longer refresh `lastMarket*` fields, so fallback/proxy values cannot become durable retained market sources on later feed failures
- When Banxico is unavailable and no prior market MXN benchmark is retained, MXN-pegged rows fall back through the normal USD benchmark-selection path

---

## v8.292 - Yearn-Style 5-Category Venue Risk and Dependency Concentration (June 15, 2026)

- Each reviewed venue now carries five Yearn-style sub-scores — audits (20%), centralization (30%), funds management (30%), liquidity (15%), operational (5%), each 1–5 with higher = riskier — weighted into a 1–5 venue-risk score; the coarse `venueRiskTier` is now derived from that score (Minimal+Low → low, Medium → medium, Elevated+High → high) rather than hand-set
- The PYS venue penalty moves from the flat low/medium/high buckets (0 / +0.15 / +0.35) to a continuous curve `max(0, weighted − 2.0) × 0.15`; it is calibration-preserving (weighted ≤ 2.0 → 0, 3.0 → +0.15, 4.0 → +0.30, 5.0 → +0.45) and only applies when a venue carries category scores, so unscored venues stay neutral
- The reviewed venue registry expands from 12 to 61, scoring the previously-unscored long tail (uncollateralized/RWA credit, newer EVM money markets, CDPs, app-chain lenders, and a second wave of risky allowlist venues); scores bind from the DeFiLlama `project` slug carried on auto-discovered lending rows, and remaining unreviewed venues continue to resolve `unknown` and stay neutral
- A reviewer-set `dependencyConcentration` sub-signal (keyed by stablecoin id, not auto-derived) adds +0.10 (medium) or +0.20 (high) to the source-risk penalty; seeded with `yvusdc-yearn` = Sky (medium) for its ~100% Sky-governance debt coupling
- Newly-scored medium/high venues also feed the DEWS structured-venue Yield Anomaly branch (DEWS v6.09); no DEWS threshold changed
- PYS formula shape, benchmark selection, history semantics, and publication guards are otherwise unchanged

---

## v8.291 - RUB Benchmark and Audit-Queue Coverage Repairs (June 11, 2026)

- The benchmark registry adds `RUB`, sourced from the Central Bank of Russia DailyInfo `KeyRateXML` SOAP feed, with source metadata `cbr-key-rate` and failure mode `cbr-key-rate-failed`
- RUB benchmark validation uses the wider `[-10%, 100%]` range so high local reference rates are not rejected by the standard 20% ceiling
- `a7a5-old-vector` leaves the intentional-gap manifest and now resolves through a rate-derived `CBR key-rate reserve-yield proxy (net of 1.00pp)` row with `benchmarkOverrideKey: RUB`
- `usdx-hex-trust` and `reusd-resupply` deterministic lending pins are repointed to live DeFiLlama pools, while stale `doc-money-on-chain` and `pmusd-precious-metals` pins are removed
- `reusd-resupply` gets a coin-specific exact-pool safety bypass after review; the pinned Pendle row still has to pass pool-shape, APY, and TVL gates
- `bifi` and `fraxlend` join the lending allowlist from the audit-queue follow-up; normal safety, APY, TVL, and source-shape publication gates still control whether their candidate pools appear
- Same-symbol collision blocks now guard known false positives including Kava USDX vs Hex Trust USDX, Virtue VUSD vs Monad VUSD, and legacy Nexus NUSD vs Neutrl NUSD
- The monthly coverage audit now emits `stale-auto-lending-override` queue items, and sync/status metadata exposes published ranking-count deltas for operator-visible coverage regression monitoring
- Binance BFUSD, Gate GUSD, Tradable notes, dEURO, and eBUSD remain deferred after the June 11 probe because no stable public machine-readable APY source or adapter path was verified

---

## v8.29 - NAV Oracle, TRY TLREF, and Queue-Guided Coverage (June 9, 2026)

- `mmev-midas` gains a curated Midas mMEV NAV oracle source at `protocol-api:midas-mmev-nav-oracle`, using the issuer-listed Ethereum mMEV/USD oracle as the current NAV and prior published oracle rows as the APY anchor
- The Midas oracle row requires positive oracle answers, valid oracle decimals, and source freshness within three days; the first successful row can seed `exchange_rate` history with `currentApy=0` until a 7-45 day anchor exists
- The benchmark registry adds `TRY`, sourced from CBRT EVDS BIST TLREF series `TP.BISTTLREF.ORAN`, with source metadata `cbrt-evds-tlref` and failure mode `cbrt-tlref-failed`
- TRY benchmark validation uses a wider `[-10%, 100%]` range so Turkish reference rates above the normal 20% ceiling are accepted
- `witry-brix` now resolves through a rate-derived `BIST TLREF overnight proxy (TRY)` row
- Rate-derived configs can set `benchmarkOverrideKey`; APY derivation still uses the configured product benchmark, while PYS/excess-yield benchmark selection and provenance can use the override
- USD tokenized T-bill/MMF-style rate-derived proxies now compare against `USD_EFFR` for PYS/excess-yield provenance, while EUR/GBP treasury proxy rows carry explicit same-currency override keys
- `structured-tranche` keeps its runtime taxonomy but renders as `Structured Tranche`, and frontend external-opportunity grouping now includes structured tranches alongside lending and fixed-yield rows
- Monthly coverage-audit allowlist recommendations now start from the unmatched high-TVL queue, require the existing protocol-category gate for `high-confidence` candidates, and include source links, promotion metadata, and suggested allowlist snippets
- PYS formula, source-risk calibration, history semantics, and publication guards are unchanged except where row-level benchmark selection uses the explicit override

---

## v8.28 - GBP SONIA Compounded Index Benchmark (June 9, 2026)

- GBP benchmark refresh now uses the Bank of England IADB SONIA Compounded Index `IUDZOS2` instead of the overnight SONIA proxy
- The daily benchmark cron annualizes the trailing 90-day index change to produce `GBP 3M compounded SONIA`
- Benchmark metadata records source `boe-sonia-compounded-index`
- GBP feed failures use fallback mode `gbp-sonia-compounded-index-failed` and retain the existing retained-last-market behavior when available
- PYS formula, source arbitration, source-risk calibration, publication guards, and non-GBP benchmark paths are unchanged

---

## v8.27 - Fixed-Yield Pendle PT Opportunities (June 9, 2026)

- `fixed-yield` joins the YieldType taxonomy for fixed-maturity principal-token opportunities
- Pendle supplemental PT market rows now emit `fixed-yield` protocol-API candidates with source keys shaped as `protocol-api:pendle:<chain>:<marketAddress>`
- Pendle rows keep underlying stablecoin matching through the PT market's underlying asset symbol/address instead of creating synthetic stablecoin entries
- `fixed-yield` rows are treated as external opportunity alternatives alongside `lending-opportunity`, so they can appear next to native holder-yield rows without displacing those rows through variant projection or parent inheritance
- PYS formula, benchmark selection, source-risk calibration, history semantics, and publication guards are unchanged

---

## v8.26 - Wave 2 Category-Gated Lending Allowlist (June 9, 2026)

- The curated lending allowlist now includes `aries-markets`, `blend-pools-v2`, `current`, `curvance`, `scallop-lend`, and `tydro`
- These protocols were verified on 2026-06-09 as DeFiLlama category Lending with live single-asset stablecoin pools on Aptos, Stellar, Sui, Monad, and Ink
- Speculative non-lending categories remain excluded by the protocol category gate before they can become high-confidence allowlist recommendations
- The existing APY floor, chain-specific TVL floors, supply-relative `0.1%` gate, reserved-pool exclusion, and source-risk penalty semantics continue to apply
- PYS formula, benchmark selection, history semantics, and publication guards are unchanged; v8.26 is a source-roster expansion only

---

## v8.25 - USDGO EFFR Rate-Derived Source (June 9, 2026)

- `usdgo-osl` is yield-bearing again and leaves the intentional-gap manifest because it now has a reliable rate-derived runtime APY path
- The benchmark registry adds optional `USD_EFFR`, sourced from FRED DFF (`fred-dff`) as the Effective Federal Funds Rate feed
- USDGO computes rate-derived APY as `max(0, USD_EFFR - 38 bps)`, matching OSL public material that references approximately 3.24% net yield versus May 2026 EFFR after fees
- The default USD benchmark remains `USD` / FRED `DGS3MO`; `USD_EFFR` is a product-specific benchmark key for EFFR-linked products rather than a replacement global USD hurdle
- PYS formula, source-risk penalties, publication guards, and benchmark retained-last-market semantics are unchanged

---

## v8.24 - Source Management, Venue Risk, and Sync Telemetry (June 9, 2026)

- The DEX-liquidity job caches a compact DeFiLlama `/protocols` slug/category snapshot under `defillama-protocols`, and the monthly yield coverage audit reuses that cache for protocol-category annotations
- Coverage-audit protocol recommendations carry DeFiLlama category metadata when available; `high-confidence` lending-allowlist recommendations require a category of Lending, CDP, RWA Lending, or Uncollateralized Lending instead of relying on TVL and pool count alone
- Auto-discovered lending opportunities move from a binary small-ecosystem TVL gate to `CHAIN_LENDING_TVL_FLOOR_USD`: `$100K` remains the default floor, while Aptos, Berachain, Cardano, Ink, Monad, Plasma, Solana, Stacks, Stellar, and Sui use `$25K`; the supply-relative `0.1%` gate still applies
- The reviewed venue-risk backlog assigns sourced tiers across the tracked venue registry: `spark-savings`, `yearn`, `yearn-finance`, and `pendle` move to `low`; `maple`, `morpho`, `morpho-v1`, `morpho-blue`, and `beefy` move to `medium`; unknown or unreviewed venues remain neutral
- Monthly coverage audits now re-probe explicit generic `convertToAssets` quarantines with configured monthly `chainRpcs` when available; `reusd-re-protocol` has an inactive audit probe config and remains outside hourly `ON_CHAIN_RATE_CONFIGS`
- Successful nonzero quarantine probe rates inside the `<=300%` exchange-rate envelope produce `quarantineReadyToRestore`, `quarantineProbeSummary`, and an operator queue candidate kind `quarantine-ready-to-restore`; restoration remains manual
- `scrvusd-curve` stays quarantined from the generic reader because it already uses the dedicated current-rate reader; `scrvusd-curve` and `reusd-re-protocol` both carry `nextReviewAt: 2026-07-09`
- Tier 1 deterministic APYs above the 300% sanity envelope are recorded in sync metadata as `sourceCoverage.onChainEnvelopeRejectionCount` plus bounded rejection examples; fallback resolution remains unchanged
- Comparison-anchor freshness is recorded in sync metadata as `sourceCoverage.comparisonAnchorFreshness`, including anchored row count, stale anchor count, oldest stale anchor age/source, bounded stale examples, and truncation state
- Admin `/api/status` exposes the comparison-anchor freshness summary at `yieldHealth.comparisonAnchorFreshness`; the summary is observability-only and does not change source arbitration, scoring, or publication eligibility
- PYS keeps the existing source-risk penalty semantics: `low` is a no-op and `medium` contributes the existing +0.15 source-risk penalty; PYS formula, history semantics, and publication guards are otherwise unchanged
- DEWS v6.07 Yield Anomaly adds a bounded medium-venue branch (`structured-medium-risk-venue`, +10) while the existing high-risk venue branch remains +25

---

## v8.23 - Wave 1 Source-Roster Expansion (June 9, 2026)

- Selected curated wrappers now have deterministic ERC-4626 exchange-rate coverage through `ON_CHAIN_RATE_CONFIGS`: `susdc-spark`, `susdt-spark`, `syrupusdc-maple`, `syrupusdt-maple`, `yvusdc-yearn`, `gtusdc-gauntlet`, `sgho-aave`, `wsrusd-reservoir`, `stcusd-cap`, `savusd-avant`, and `yousd-yield-optimizer`
- Curated DeFiLlama rows for those wrappers remain eligible as fallback or retained alternate sources; the change promotes source resilience and determinism rather than changing wrapper ownership
- `fusd-finchain`, `safo-spiko-usd`, and `spkcc-spiko` gain rate-derived coverage for fixed-NAV or NAV-accreting fund mechanics that price-derived APY does not model cleanly
- `aave-v4` joins the curated lending auto-discovery allowlist
- The unreachable `stbt-matrixdock` intentional-gap entry is pruned because STBT is not tracked and could never surface in the yield adapter manifest
- VBILL is intentionally excluded from this rate-derived batch because its metadata points to an on-chain NAVLink-style NAV feed; a future NAV-oracle source lane should handle it instead
- PYS scoring math, source-risk penalties, history semantics, and publication guards are unchanged; v8.23 is a source-roster and coverage-accounting update

---

## v8.22 - First-Party GBP/JPY/AUD Benchmarks (June 7, 2026)

- GBP benchmark refresh now reads Bank of England IADB `IUDSOIA` directly instead of the FRED mirror; this overnight proxy is superseded by the SONIA Compounded Index in v8.28
- JPY benchmark refresh now reads Bank of Japan Time-Series Data Search `STRDCLUCON`, replacing the stale FRED mirror that ended at December 2023
- AUD benchmark refresh now reads the Reserve Bank of Australia F1 money-market CSV cash-rate target instead of the FRED 3-month interbank mirror
- Retained-last-market fallback semantics and PYS scoring math are unchanged; the update is a benchmark source-roster and freshness reliability change
