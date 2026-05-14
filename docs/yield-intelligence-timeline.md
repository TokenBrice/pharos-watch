# Yield Intelligence Methodology - Version Timeline

Internal changelog reconstructed from git history. Covers Yield Intelligence `v1.0` through `v8.12` (2026-03-01 -> 2026-05-14).

---

## v8.12 - Tradable Private-Credit Yield Gaps (May 14, 2026)

- `pc0000031-tradable`, `pc0000033-tradable`, `pc0000089-tradable`, and `pc0000101-tradable` are inventoried as explicit intentional yield gaps
- The four notes stay marked yield-bearing because they are private-credit instruments, but Pharos does not synthesize APY rows from contract-priced or zero-volume metadata
- Runtime rankings will include them only after a reliable public APY, NAV-change, or cashflow source is wired

---

## Boundary note - Neutral yieldRiskConfig scaffold (May 13, 2026)

- No methodology version change: the sparse typed `yieldRiskConfig` registry starts with reviewed candidate venues only and assigns no non-unknown tiers
- Aave, Compound, Spark, Maple, Yearn, Morpho, Pendle, and Beefy venue families have a controlled rationale/evidence home for future reviewed tiers, but current `unknown` tiers remain neutral
- Any future non-unknown venue tier must be wired into the existing venue-tier penalty path and ship with reviewed evidence, calibration, and the matching methodology/version update

---

## v8.11 - Yield Coverage Expansion and Rate-Derived Fund Sources (May 13, 2026)

- `gtusdc-gauntlet`, `susdc-spark`, `susdt-spark`, `sgho-aave`, `ybold-yearn`, and `yvusdc-yearn` now own curated single-exposure DeFiLlama native pool mappings
- `aa-falconx-mev-capital` remains on its NAV/price-derived fallback path until a usable single-exposure nonzero APY source is available; the current DeFiLlama tranche row is multi-exposure and reports zero APY, so it is intentionally not pinned through `YIELD_POOL_MAP`
- BENJI, WTGXX, USTBL, and EUTBL now resolve through the rate-derived benchmark lane, with EUTBL using the EUR benchmark override
- AutoFinance, Neverland, Metrom, Mystic Finance, Bitway, and Frankencoin were added to the curated lending allowlist, with deterministic pins for `reusd-resupply`, `xusd-babelfish`, and `usda-anzens`
- Exact-pool commodity coverage now includes XAUT on Lista Lending and PAXG on Hydration, and source-link coverage was added for the new Tier C and Hydration labels

---

## v8.1 - Linked Variant Parent Source Projection (May 13, 2026)

- Active tracked yield variants now project eligible native/wrapper yield sources onto their active parent stablecoin with `linked-variant:<variantId>:<sourceKey>` source keys
- Variant assets keep their own first-class rows and source history; parent projection is a linked route for comparison and coverage context, not a return to parent-owned wrapper metadata
- Third-party `lending-opportunity` rows are not projected from variants to parents, and parent rows skip duplicate source pools that are already present
- `felix-cdp` and `sovryn-dex` enter the curated lending allowlist, with deterministic pool pins for `feusd-felix`, `dllr-sovryn`, `doc-money-on-chain`, and `tgbp-tokenised`
- Coverage can only increase when a parent has a live source-backed tracked variant; the publisher does not create no-source or synthetic APY rows to inflate coverage counts

---

## v8.0 - PYS Source-Risk Penalty Rollout (May 13, 2026)

- PYS now consumes nested `sourceRisk.sourceRiskPenalty`, populated from measured reward share, source depth, source age, selected-source switches, bootstrap observation count, and sourced venue tier where available
- DeFiLlama rows without a row-level observation timestamp inherit the DeFiLlama input metadata age for both provenance and source-age scoring penalties
- Missing, invalid, or unknown source-risk evidence remains neutral (`1`); penalties below 1 clamp to 1 and penalties above `PYS_MAX_SOURCE_RISK_PENALTY` (`2.5`) clamp to 2.5
- The formula now computes `rowUtility = effectiveYield / sourceRiskPenalty`, then applies the existing safety curve, volatility multiplier, benchmark-spread weight, and scaling factor
- Same-confidence source arbitration compares source-risk-adjusted utility after penalty resolution; APY and TVL remain fallback tie-breakers
- Public API source-risk fields remain nested under `sourceRisk.*`; flattened fields such as top-level `sourceRiskPenalty` are internal calibration shorthand, not the public contract
- Production calibration was regenerated from publication generation `yield-1778700012`, which populated nested public ranking `sourceRisk.*` fields for the live rankings snapshot
- The hourly publisher now publishes the `yield-rankings` cache through CAS before replacing current `yield_data` rows, so failed cache writes or older-run CAS skips leave the last published D1 snapshot visible to downstream readers
- Legacy `v7.48` payloads remain valid without `publication`, `sourceRisk`, rank, or attribution fields because missing source-risk inputs resolve to the neutral penalty
- Report-card yield-risk helpers normalize the source-risk payload but still return explicit no-op adjustments until a separate report-card methodology version defines sourced caps or haircuts
- Current yield source-risk does not affect Safety Score, Dependency Risk, Resilience, or overall report-card grades; future score-affecting use requires a report-card methodology update and matching report-card timeline entry
- DEWS methodology v5.99 now consumes populated structured `sourceRisk.*`, source-switch, and rank-attribution stress evidence inside the existing Yield Anomaly sub-signal; missing or neutral structured rows remain no-ops

---

## v7.48 - dTRINITY sdUSD Multi-Chain Weighted Source (May 13, 2026)

- `dusd-dtrinity` now resolves a curated exact-pool group that TVL-weights DeFiLlama's Ethereum and Fraxtal sdUSD dStake rows
- The published dUSD source no longer represents only the Ethereum sdUSD vault when Fraxtal sdUSD is also live
- The new synthetic source key starts a fresh history series, so prior Ethereum-only rows are not carried forward as equivalent 30-day samples

---

## v7.47 - Avant savUSD ownership correction (May 13, 2026)

- `savusd-avant` now owns the Avant native savings pool directly in the yield manifest
- Base `avusd-avant` is no longer marked yield-bearing because Avant docs identify avUSD as the non-yield base asset and savUSD as the yield-accruing senior tranche
- Parent-side `avusd-avant` savUSD variant and pool mappings were removed so new yield history publishes under the tracked savUSD asset

---

## v7.46 - Zephyr ZYS direct yield source (May 12, 2026)

- `zys-zephyr-protocol` is tracked as a yield-bearing NAV wrapper over `zsd-zephyr-protocol`
- `protocol-api:zys-zephyr-protocol` reads Zephyr Scanner one-day effective APY and publishes it as `Zephyr Scanner ZYS returns`
- `zsd-zephyr-protocol` remains non-yield-bearing so the base stablecoin does not receive the wrapper's APY row

---

## v7.45 - USG Yield Ownership Correction (May 8, 2026)

- `usg-tangent` is no longer marked as a yield-bearing asset because USG itself does not accrue yield
- Tangent yield exposure belongs to the separate sUSG savings wrapper; USG is the borrowable CDP stablecoin
- The intentional-gap manifest now covers only assets that are actually marked yield-bearing but lack a reliable runtime APY source

---

## v7.44 - Solayer sUSD Treasury fallback coverage (May 5, 2026)

- Solayer `sUSD` now publishes through the rate-derived Treasury fallback lane instead of entering the yield manifest without a runtime strategy
- Newly added reward-bearing account assets or restricted strategy products without reliable APY telemetry remain outside runtime yield coverage until a source can be validated
- The yield-bearing registry invariant continues to require every active yield-bearing asset to have an explicit runtime strategy

---

## v7.43 - Tracked savings wrappers own their native APY history (Apr 22, 2026)

- `sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, and `scrvUSD` now own the wrapper APY rows that used to publish through `USDe`, `USDS`, `DAI`, `frxUSD`, and `crvUSD`
- Those five base assets no longer advertise wrapper-owned `yieldBearing` metadata or serve the old wrapper APY series through `/api/yield-history`
- Parent-side wrapper source keys are filtered immediately at read time and purged on the hourly sync path, so misattributed pre-handoff rows do not linger under the base ids after rollout

---

## v7.42 - First-class risk wrapper yield assets (Apr 21, 2026)

- Risk-bearing wrappers whose holder exposure differs materially from the base stablecoin now own yield rows directly instead of publishing through the base asset
- `stcUSD`, `sAID`, `msY`, and K3 `sBOLD` move from base-asset wrapper/native-yield treatment onto their own tracked NAV/wrapper assets
- `stUSDS` uses the generic on-chain ERC-4626 exchange-rate reader because Sky's risk-capital token is distinct from the plain `sUSDS` savings wrapper and has no standalone stablecoin row in DefiLlama
- Aave Umbrella `stkGHO` is an explicit runtime-yield gap until a reliable rewards APY source is wired, so coverage audits do not mistake missing reward telemetry for successful zero-yield publication

---

## v7.41 - On-chain bootstrap seeds excluded from rolling APY (Apr 21, 2026)

- Deterministic on-chain seed rows used only to establish a 7-day exchange-rate anchor no longer count as observed zero-yield samples in rolling APY stats
- This removes artificial bootstrap drag from `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS once real on-chain APY samples exist
- The raw seed rows remain in `yield_history` for exchange-rate anchoring, but rows with `data_source='onchain'`, `exchange_rate IS NOT NULL`, `apy = 0`, and `apy_base IS NULL` are excluded from rolling stats
- Detail-page and hero-chip copy now labels `excessYield` as 30-day based, matching the formula `apy30d - benchmarkRate`

---

## v7.4 - Pre-launch lending overrides quarantined (Apr 13, 2026)

- Pre-launch metadata lives in per-coin files with `status: "pre-launch"`; legacy `shared/data/stablecoins/pre-launch.json` remains an empty compatibility shell
- `pusd-polaris` is now an explicit pre-launch intentional gap instead of resolving through a deterministic Silo v2 lending override
- Explicit and deterministic lending candidate publication now checks the active stablecoin universe before resolving metadata, so upcoming assets cannot enter live yield rankings before launch
- `/upcoming/`, pre-launch detail pages, and Telegram launch alerts continue to use the combined tracked metadata universe

---

## v7.3 - scrvUSD current-rate on-chain reader (Apr 11, 2026)

- Curve Savings crvUSD now uses a dedicated Yearn V3 profit-unlock reader for current APY instead of the generic 7-day ERC-4626 exchange-rate delta
- The generic `convertToAssets(1e18)` reader is quarantined for legacy parent-side `crvusd-curve` rows because the trailing 7-day delta understated Curve's current savings APY
- The new `onchain:scrvusd-curve:scrvusd-current-rate` source reads `totalSupply`, `totalAssets`, `profitUnlockingRate`, and `fullProfitUnlockDate`, then daily-compounds the active unlock APR
- The curated DeFiLlama scrvUSD pool remains as an alternative/fallback source while source-specific current-rate history starts fresh under the new source key

---

## v7.2 - USD.AI base/yield token split (Apr 4, 2026)

- Yield coverage now treats `sUSDai` as its own tracked yield-bearing NAV token instead of hanging the USD.AI savings pool off base `USDai`
- Base `usdai-usd-ai` no longer inherits the `sUSDai` savings venue through `YIELD_VARIANT_MAP`
- New tracked asset `susdai-usd-ai` now owns the USD.AI savings pool mapping directly, aligning yield rankings with the dedicated `sUSDai` detail page
- The stale wrapper config that pointed the supposed `sUSDai` variant address at Arbitrum `PYUSD` was removed

---

## v7.1 - Explicit intentional gaps for pre-launch yield assets (Apr 3, 2026)

- Pre-launch yield-bearing assets with no live runtime source now publish as explicit intentional manifest gaps instead of appearing as covered entries with zero strategies
- `bd-basedollar` now follows the same intentional-gap path as `trusd-tori`
- Coverage audits and operator tooling still inventory every yield-bearing asset, but these pre-launch gaps now fail closed and stay visible as missing runtime coverage

## v7.0 - Supply-relative size gates for published lending suggestions (Apr 3, 2026)

- Published `lending-opportunity` rows now require observable venue TVL before they can surface as live recommendations
- For tracked stablecoins, the recommendation gate now requires venue TVL to clear `max(existing absolute floor, 0.1% of current supply)`
- This applies across auto-discovered DeFiLlama lending markets, deterministic exact-pool overrides, and supplemental protocol-native lending venues
- TVL-less protocol suggestions now fail closed instead of publishing as recommendations until they can prove venue size

## v6.9 - K3 sBOLD added as a distinct native BOLD yield source (Mar 28, 2026)

- The supplemental Yearn/Kong feed now recognizes Ethereum `Staked yBOLD` and pins it directly to `bold-liquity`
- The source publishes as `K3: sBOLD`, giving BOLD a second native wrapper path alongside the base `yBOLD` route
- `sBOLD` is classified as native `lending-vault` yield because it is another wrapper around the Liquity Stability Pool stack, not a governance-set rate or generic lending opportunity
- Yield-source links now deep-link this row to Liquity's dedicated `https://liquity.app/earn/sbold` route

## v6.8 - Blocked USR-linked lending suggestions (Mar 28, 2026)

- Published `lending-opportunity` suggestions now exclude venues explicitly tied to Resolv / `USR`, `stUSR`, or `wstUSR`
- Supplemental protocol-API sources such as `Morpho: Resolv USDC` are dropped before ranking publication instead of competing for the best-source slot
- The shared DeFiLlama stablecoin-pool cache now preserves `poolMeta`, allowing the same exclusion rule to apply on the auto-discovery path as well
- Wrapper-over-native venues such as BOLD / `yBOLD` are treated as native yield rather than governance-set when the wrapper only packages the protocol's own Stability Pool return
- The filter is scoped to lending suggestions for base assets; native tracked yield assets keep their existing methodology coverage

## v6.7 - Benchmark-aware PYS for cross-currency yield context (Mar 27, 2026)

- PYS now forms an `effectiveYield` term equal to raw `apy30d` plus 25% of the row's benchmark spread before the safety penalty and consistency multiplier are applied
- This keeps raw nominal APY as the anchor while giving above-benchmark EUR, CHF, and other non-USD rows explicit credit for clearing their local cash hurdle
- Read-time `/api/yield-rankings` hydration, leaderboard/detail breakdowns, and methodology docs now use the same benchmark-aware scorer so shipped scores and explanations stay aligned
- Strong local-rate rows such as EURCV and ZCHF no longer look artificially flat versus same-APY USD rows that clear a much easier benchmark

## v6.6 - Supplemental freshness windows align with the 4-hour cache lane (Mar 27, 2026)

- Read-time `data-stale` warnings now treat supplemental protocol-API rows and optional Aave/Compound rows as 4-hour-family data instead of hourly-family data
- Supplemental-backed rows now wait 6 hours before going stale, which avoids false warnings during the normal final hour of the supplemental refresh cycle
- Deterministic hourly on-chain rows keep the 3-hour hourly threshold, so only the slower supplemental families move
- The methodology and operations docs now spell out the distinct stale windows for hourly, supplemental, and daily yield families

## v6.5 - Optional RPC hardening and explicit wrapper venue pins (Mar 27, 2026)

- Compound V3 now probes both configured RPC endpoints instead of only the fallback URL, and Aave V3 plus Compound V3 rotate endpoint order across targets with a slightly deeper retry budget on the supplemental lane
- `sync-yield-supplemental` metadata now records optional RPC family target counts, attempted counts, resolved target counts, emitted row counts, missing target counts, miss reasons, and per-chain miss breakdowns
- Layer 2 wrapper matching can now pin a preferred DeFiLlama project in addition to chain and address, keeping shared wrapper tokens fail-closed without attaching to the wrong venue
- Under-specified wrapper configs now carry explicit live chain/address/project pins for native venues such as `sUSDai`, `sNUSD`, `savUSD`, `sUSDu`, `syzUSD`, `sAID`, `stCUSD`, and `sGHO`

## v6.4 - Protocol-native lending readers no longer outrank stronger native wrapper yields (Mar 27, 2026)

- Supplemental lending-market readers such as Aave V3 are now classified as curated protocol-native sources instead of Tier 1 deterministic wrapper sources
- Native wrapper yields such as sDAI no longer lose the primary row to a lower-yield supplemental lending market purely because the supplemental reader queried on-chain state directly
- Source keys and alternative-source history stay unchanged, so the fix changes arbitration precedence without breaking source continuity

## v6.3 - Restored mixed-view scatter benchmark frame (Mar 27, 2026)

- The `/yield` scatter plot now restores its horizontal benchmark line and four shaded quadrants on mixed-benchmark scopes instead of dropping them entirely
- Mixed scopes use the default USD benchmark as the shared visual frame, so the chart stays readable even when rows carry local EUR or CHF hurdles
- Mixed-view copy now makes the distinction explicit: the background frame is for orientation, while each row's benchmark tag still controls excess-yield interpretation

## v6.2 - Source-cadence-aware freshness warnings (Mar 26, 2026)

- Read-time `data-stale` warnings now respect source cadence instead of forcing daily price-derived rows through the hourly publish threshold
- `price-derived` rows now wait 36 hours before going stale because they are backed by daily `supply_history` snapshots
- Hourly publication families still mark stale after three missed `sync-yield-data` intervals
- Healthy daily snapshot rows such as USTB, USDA, and CETES no longer surface false stale warnings after roughly one day of normal operation

## v6.1 - 3M risk-free benchmarks for EUR and CHF (Mar 26, 2026)

- EUR pegs now benchmark against the ECB's official 3-month compounded €STR series rather than the overnight €STR feed
- CHF pegs now benchmark against delayed public `SAR3MC` from SIX rather than an SNB policy-rate proxy
- CHF benchmark rows are no longer marked as proxies, and mixed-benchmark UI copy now names the 3-month compounded EUR/CHF cash hurdles directly
- The worker now fetches delayed SARON compound-rate files through SIX's guest OAuth plus report-download flow, and the docs/about-page source inventory reflect that pipeline

## v6.0 - Asset-scoped supplemental identity and actionable coverage audits (Mar 26, 2026)

- Aave V3 supplemental rows now use asset-scoped source keys instead of collapsing all same-chain markets into one cached row
- `sync-yield-supplemental` metadata now reports raw candidate count, deduped candidate count, and dropped-row count so silent row loss is visible in cron history
- The monthly yield coverage audit now counts explicit auto-discovery overrides and curated exact-pool overrides as covered DL surfaces
- High-TVL gap reporting now focuses on unsupported protocol families instead of flooding the audit with already-allowlisted markets

## v5.9 - Cadence-aligned data-stale warnings (Mar 26, 2026)

- The read-time `data-stale` warning now keys off three `sync-yield-data` intervals instead of a leftover fixed `90 min` threshold from the old half-hourly lane
- At the current hourly publisher cadence, that means detail-surface stale warnings wait about 3 hours before firing
- The hourly-source threshold is derived from shared cron metadata, so future schedule changes stay aligned without another manual constant update

## v5.8 - First-party EUR benchmarks and resilient CHF parsing (Mar 26, 2026)

- EUR benchmark refreshes now query the ECB's official €STR feed first and only fall back to the FRED mirror when the first-party source is unavailable
- CHF benchmark parsing now normalizes the SNB current-rates page to text before extracting the policy-rate sentence, so harmless markup changes no longer null out the proxy rate
- Benchmark degradation metadata now reports explicit EUR and CHF failure modes instead of collapsing first-run outages into a generic `unavailable` bucket
- The methodology docs, API examples, and about-page source inventory now reflect the ECB Data API and the hardened SNB parser

## v5.7 - Safety-reweighted PYS curve and shared scoring hydration (Mar 26, 2026)

- PYS now divides APY by `riskPenalty ^ 1.75` instead of a linear safety divisor, making weak safety grades earn their place with much larger yield spreads
- The global PYS scaling factor was retuned from `5` to `8` so score distribution stays readable after the steeper safety curve
- Live `/api/yield-rankings` hydration now reuses the shared PYS scorer instead of maintaining a duplicated read-time formula
- Leaderboard and detail breakdown copy now references the adjusted risk penalty explicitly, and the methodology docs / changelog reflect the new formula

## v5.6 - Currency-aware benchmarks for excess yield (Mar 26, 2026)

- Benchmark selection is now row-level: USD pegs use the USD 3M Treasury benchmark, EUR pegs use €STR when available, and CHF pegs use an SNB policy-rate proxy
- `/api/yield-rankings` now carries row-level benchmark labels, rates, and fallback-selection metadata so `excessYield` stays interpretable on mixed-currency views
- Stablecoin detail yield cards, hero chips, and history charts no longer hard-code `vs T-Bill`; they render the selected row benchmark instead
- The `/yield` scatter plot now suppresses the single benchmark line on mixed-benchmark scopes and restores it only when the visible filter shares one benchmark
- CHF support intentionally uses the public SNB policy rate proxy rather than the SNB-published SARON display, whose use is restricted

## v5.5 - Non-USD yield scoping and exact-pool commodity overrides (Mar 26, 2026)

- `/yield` now exposes a shareable peg scope with a `non-usd` preset so the live EUR, CHF, SGD, MXN, and commodity rows can be reviewed as one universe
- Tier-2 DeFiLlama ingestion now preserves exact curated non-stablecoin pool UUIDs alongside native pool IDs and wrapper-symbol matches
- Added an exact-pool override lane for assets like `xaut-tether`, while keeping the generic gold/silver auto-discovery exclusion in place so mixed baskets such as Multipli `RWAUSDI` do not get misclassified as single-asset commodity yield sources

## v5.4 - Address-First Identity and Explicit Coverage Truth (Mar 26, 2026)

- DeFiLlama discovery, variant matching, and protocol-native adapters now resolve by chain and address before symbol fallback and drop ambiguous candidates instead of guessing
- Protocol-native source keys now use full chain-aware identifiers, and source-link resolution understands prefixed labels such as `Morpho: ...`, `Pendle: ...`, `Yearn: ...`, `Kong: ...`, `Beefy: ...`, and chain-qualified labels such as `Aave v3 (base)`
- Yield manifest coverage is now explicit for every yield-bearing asset, including price-derived fallback-only assets and intentional gaps
- Warning divergence checks and published `medianApy` now share the same TVL-weighted 30d median benchmark
- `/api/yield-history` is now bounded to the latest published `/api/yield-rankings` snapshot so history cannot advance past an unpublished cache state

## v5.3 - Yield Infrastructure Automation (Mar 26, 2026)

- Chain-scoped Layer 3 symbol matching prevents cross-chain false positives in auto-lending discovery
- Variant symbol auto-scanner detects new wrapper tokens (sXXX/stXXX/wXXX prefix and SAVE/VAULT/EARN/STAKE suffix patterns) in advisory mode
- Monthly yield coverage audit cron (`0 6 1 * *`, 1st of month at 06:00 UTC) provides protocol expansion recommendations
- Protocol recommendations classify missing protocols as high-confidence (>$10M, 3+ pools) or review-needed

---

## v5.2 - Yield Coverage Expansion — Protocol-Native API Wave (Mar 25, 2026)

- 10 protocol-native adapters added: Hashnote USYC, Ondo oracle, Morpho GraphQL, Pendle REST, Yearn Kong GraphQL, Beefy REST, Aave V3 on-chain, Compound V3 on-chain, BIMA Earn
- USTB + thBILL promoted to on-chain ERC-4626 exchange rate reads (previously T-bill proxy only)
- cusd-cap flagged yield-bearing
- 19 new lending protocols added to the auto-discovery allowlist
- TVL floor lowered for smaller ecosystems
- DeFiLlama yield history backfill for instant 365-day charts

---

## v5.1 - Protocol-native BIMA savings fallback for USBD (Mar 24, 2026)

- `usbd-bima` now resolves through BIMA's public `earn/pools` feed when no usable DeFiLlama `sUSBD` wrapper pool is available
- Protocol-owned earn APIs are now treated as curated yield sources in the arbitration layer
- The source-link registry and public about-page data-source copy now include BIMA's earn surface

## v5.0 - Richer freshness provenance and curated lending source links (Mar 24, 2026)

- Rankings provenance now exposes source-observation age and comparison-anchor timing for derived sources such as price-derived and on-chain APYs
- This removes the prior optimistic `age = 0` behavior for derived rows whose underlying snapshots may be materially older than the sync run
- The lending allowlist now has curated source-link coverage for every supported protocol label

## v4.9 - Publish-safe retention and deterministic adapter quarantine (Mar 24, 2026)

- Yield rankings payloads are now preflighted before live-row mutation, reducing DB/cache divergence risk when publication would fail
- Degraded runs now retain prior current rows by skipping destructive yield cleanup instead of pruning optimistically under impaired inputs
- `dusd-dtrinity` and `reusd-re-protocol` were removed from the generic Tier 1 ERC-4626 reader until protocol-specific deterministic adapters exist

## v4.8 - Explicit edge-case overrides for remaining high-signal lending markets (Mar 24, 2026)

- Polaris pUSD now resolves through a deterministic Silo v2 lending override, fixing the prior bypass-only configuration gap
- Added deterministic exact-symbol lending overrides for USDX, USDO, and USDM
- These overrides bypass the generic C- safety gate only for a short named list of high-signal edge cases rather than lowering the global discovery threshold

---

## v4.7 - Early NAV fallback support and deeper long-tail lending coverage (Mar 24, 2026)

- Price-derived APY now uses the oldest available 7-45 day price anchor instead of requiring a strict 30-day sample, improving early NAV-token coverage
- Auto-discovered lending floors moved from `$500K / 0.5%` to `$100K / 0.1%` to capture still-meaningful long-tail markets
- Added More Markets and SmarDex USDN to the curated lending allowlist, plus an explicit Polaris pUSD safety bypass for vetted yield-bearing coverage

---

## v4.6 - Rate-derived treasury expansion and broader lending discovery (Mar 24, 2026)

- Added rate-derived Treasury fallback coverage for `usyc-hashnote` and `thbill-theo`
- Expanded the curated lending allowlist with live-observed protocols including Loopscale, Vesper, Lista Lending, Liqwid, Overnight, Lagoon, and NAVI Lending
- Lowered the lending auto-discovery TVL floor from `$1.0M` to `$0.5M` to capture still-meaningful long-tail markets without admitting dust pools

---

## v4.5 - Fail-closed source validation and retained-market benchmark continuity (Mar 23, 2026)

- Direct DeFiLlama yield fetches now degrade when the payload shape is invalid or when the response contains zero relevant stablecoin pools
- Yield sync now surfaces full deterministic Tier 1 outages as degraded runs instead of quietly publishing as if on-chain coverage were optional for that cycle
- Retained Treasury benchmark fallbacks preserve the last market-derived benchmark fields across degraded streaks, and rankings-cache publication blocks on severe shrink relative to the previous cache

---

## v4.4 - On-chain rate bootstrapping and pipeline hardening (Mar 20, 2026)

- On-chain rate configs now emit a seed row with `currentApy: 0` and `exchangeRate` when no previous rate exists, breaking a bootstrapping deadlock that prevented all 13 Tier 1 vaults from ever computing APY
- `buildOnChainSourceKey()` consolidated from 3 duplicate definitions (sync-yield-data, resolve, sources) into a single export from yield-helpers
- `isYieldRelevantDlPool` pre-filter sets (pool IDs and variant symbols) promoted from per-call allocations to module-level constants
- `hydrateYieldRankingsWithLiveSafety` coverage ratio guard fixed to use active card count instead of total card count

---

## v4.3 - Wrapper-preserving ingestion and hydration hardening (Mar 19, 2026)

- Wrapper-relevant DeFiLlama pools are now preserved through pre-filtering even when upstream `stablecoin` flags are false
- Deterministic on-chain rows now use `onchain:<stablecoinId>` source keys so source-aware history cannot collide with curated pool UUIDs
- `/api/yield-rankings` retains rows with fallback safety (`40` / `NR`) when report-card hydration is incomplete instead of dropping coverage
- Retained benchmark fallback snapshots stay marked degraded, and malformed stored `warning_signals` payloads no longer fail `yield-history`

---

## v4.2 - Source-aware history and confidence-weighted arbitration (Mar 10, 2026)

- `yield_history` now persists per-source rows with best-source markers instead of a single mixed best series
- 7d and 30d APY metrics are computed from source-specific history, preventing source-switch contamination
- Rankings now include provenance for benchmark freshness, safety coverage, source-switch state, and selection reasoning
- Cross-source arbitration can reject divergent discovered or fallback sources when canonical sources disagree materially

---

## v4.1 - Conservative LUSD Stability Pool source (Mar 7, 2026)

- Added a deterministic LUSD source using Liquity Stability Pool deposits and CommunityIssuance totals
- APR converts projected LQTY emissions to USD using CoinGecko spot price and intentionally excludes ETH liquidation gains
- LUSD can now surface both the B.Protocol Stability Pool source and auto-discovered lending alternatives

---

## v4.0 - Multi-source rankings and alternative-source transparency (Mar 3, 2026)

**Commit:** `b94e042`

- `yield_data` primary key changed to `(stablecoin_id, source_key)` with per-source rows
- `is_best` now marks the highest-APY source per coin while non-best alternatives are retained
- Tier-2 matching aggregates all valid sources (native map, wrapper map, symbol fallback)
- `/api/yield-rankings` now includes `altSources[]` and the UI exposes `+N` alternative-source details

---

## v3.3 - Coverage ratchet: deterministic overrides + address-aware discovery (Mar 3, 2026)

**Commits:** `d9bf617`, `39f3f95`, `2a45230`, `ce2293d`

- Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage
- Deterministic pool overrides were introduced for hard-to-match symbols, including explicit safety bypass handling
- `findBestLendingPool()` now falls back to underlying token address matches when symbol matching fails
- Price-derived fallback was explicitly extended to BUIDL when no usable on-chain or DeFiLlama source exists

---

## v3.2 - Inherited blacklistability alignment for inline safety scoring (Mar 2, 2026)

**Commit:** `595f176`

- Yield sync safety scoring switched to shared `isBlacklistable()` logic, including reserve inheritance
- Risk penalties in PYS now better reflect inherited blacklist exposure
- Reduced divergence between yield-page safety grades and safety-score outputs

---

## v3.1 - Auto-discovery hardening and finite-math safeguards (Mar 1, 2026)

**Commits:** `2e2a0aa`, `9decd36`, `4402307`

- NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior
- Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures
- Non-finite 30-day APY volatility values are sanitized before D1 writes

---

## v3.0 - Automatic lending-opportunity discovery (Mar 1, 2026)

**Commit:** `2b1a551`

- Added allowlist-based auto-discovery over DeFiLlama lending pools
- Eligibility is gated by safety score before pool selection
- Introduced `defillama-auto` source type and `lending-opportunity` yield classification

---

## v2.1 - Warning-signal telemetry and fxUSD native mapping (Mar 1, 2026)

**Commits:** `dcdefde`, `35f8021`

- Added `warning_signals` persistence with spike, divergence, trend, reward-heavy, and TVL-outflow checks
- Signal detection now uses market-median APY and prior TVL context per coin
- Tier-2 deterministic source coverage added an explicit fxUSD native mapping

---

## v2.0 - Wave-1 coverage expansion and numerical hardening (Mar 1, 2026)

**Commits:** `f5ecd72`, `6b327eb`

- Added wave-1 variant and pool mappings for additional native-yield stablecoins
- Near-zero-mean handling in stability/variance math prevents coefficient-of-variation blowups
- Safety fallback and finite-value guards were formalized for ranking writes

---

## v1.1 - Launch-audit corrections for APY windowing and display (Mar 1, 2026)

**Commit:** `873842c`

- 7-day APY switched to timestamp-window filtering instead of proportional sample slicing
- Tier-1 previous exchange-rate reads were reused from cached lookup state
- Yield stability display normalized as a true 0-100 percentage in UI components

---

## v1.0 - Initial Yield Intelligence release (Mar 1, 2026)

**Commits:** `0709a1d`, `569664e`, `22695dc`, `81ba632`, `0e7b8b3`

- Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)
- Launched the PYS model (risk penalty + variance sustainability multiplier + scaling factor)
- Added `yield_data` / `yield_history` tables and public `yield-rankings` / `yield-history` API handlers

---

## Notes

- Yield methodology did not initially ship with explicit version tracking; the early entries above were reconstructed from methodology-impacting commit boundaries.
- Canonical machine-readable source: `shared/lib/yield-methodology-version.ts`.
