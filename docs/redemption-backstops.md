# Redemption Backstops

Modeled redemption-route coverage for tracked stablecoins. This subsystem estimates how credibly a holder can exit to par or near-par outside secondary-market DEX liquidity, then exposes that estimate through a standalone snapshot API. Since redemption `v4.3` the legacy `effectiveExitScore` blend is retired: same-notional exit is published by the Safety Score V9 Exit pillar alone, which composes the same route-scoring primitives from `shared/lib/exit-route-scoring.ts`.

---

## Methodology Versioning

- **Current methodology version:** `v4.32`
- **Public methodology anchor:** `/methodology/#safety-scores-methodology`
- **Canonical source files:** `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-configs/*`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/methodology-versions/redemption-backstop.ts`
- **Structured changelog:** `shared/data/methodology-changelogs/redemption-backstop/`

Latest `v4.32` update: live adapters now assert current route openness and fees where the chain proves them, and several routes gained live-direct capacity, documented fee bounds, or primary-source corrections. ERC-4626 wrapper adapters emit `routeStatus` open/paused from positive same-run redemption liquidity plus opportunistic `paused()`/`isShutdown()` probes; Mento FPMM pools read `lpFee()+protocolFee()` live; USDe reads the EthenaMinting contract's own USDT/USDC float capped by max-redeem-per-block config; Reservoir routes read the USDC PSM on-chain and base rUSD gains its own PSM route; USTB is remodeled onto its atomic on-chain RedemptionIdle USDC rail; IST's route status is unknown following Inter Protocol's sunset; eUSD and USD3 (Reserve) carry documented 0 bps fee ceilings. Scoring weights, ladders, and the exit engine are unchanged — routes move only through better evidence.

Earlier release history lives in `shared/data/methodology-changelogs/redemption-backstop/`; keep this document focused on the current contract.

There is no standalone changelog page yet. The public methodology link currently points at the Safety Scores section because redemption backstops feed the report-card liquidity dimension.

---

## Coverage

Configured coverage is defined statically behind the thin facade in `shared/lib/redemption-backstops.ts`, with route-family modules under `shared/lib/redemption-backstop-configs/`.

- **Configured coins:** 311
- **Route families:** 147 `offchain-issuer`, 67 `stablecoin-redeem`, 38 `collateral-redeem`, 39 `queue-redeem`, 11 `psm-swap`, 9 `basket-redeem`
- **No discovery layer:** only coins present in `REDEMPTION_BACKSTOP_CONFIGS` are modeled

The config registry is validated at module load time against `TRACKED_META_BY_ID`, so unknown IDs fail fast during build/test/runtime startup.

`npm run audit:coverage -- --domain=redemption-backstops -- --report <path>` writes per-config audit rows with both the literal configured `capacityBasis` and the resolved runtime-style `resolvedCapacityBasis`. Reserve-sync rows use the tracked adapter's direct/proxy redemption-telemetry declaration when resolving that audit basis. The report also includes `capacityFallbackSource` for reserve-sync fallback ratios/USD buffers and `dailyLimitUsd` when a static model caps same-day capacity, so review queues can distinguish route-family defaults from explicit fallback or daily-limit constraints.

---

## Cron Schedule

- **Pattern:** `11 */4 * * *`
- **Function:** `syncRedemptionBackstops(db, signal)`
- **File:** `worker/src/cron/sync-redemption-backstops.ts`
- **Trigger order:** runs after `sync-live-reserves` in the 4-hourly reserve lane (`worker/src/handlers/scheduled/hourly-live-reserves.ts`)

The cron reads:

1. The strict `stablecoins` cache via `loadStablecoinsCache(...)`
2. The latest DEX liquidity snapshot via `loadDexLiquiditySnapshot(db)` so both the liquidity map and freshness can be reused
3. A preloaded map of the latest authoritative reserve snapshot metadata for routes that use live reserve telemetry for capacity or fee inputs

No external HTTP calls happen during the redemption-backstop pass itself; any live reserve telemetry is reused from D1.

Status semantics:

- `ok` when every active configured route resolves to a usable scored row and the DEX liquidity input used for effective-exit context is fresh, when the only unresolved active rows are a tiny `missing-capacity` tail within the current active-config tolerance budget (`max(1, ceil(activeConfigured * 1%))`), when current market evidence intentionally marks a route `impaired`, or when a configured route is absent from the active runtime stablecoins cache but still materialized as a diagnostic `missing-cache` row
- `degraded` when at least one row is written but any active configured route fails, hits a non-`missing-capacity`/non-`impaired`/non-`missing-cache` unresolved state, the `missing-capacity` tail exceeds that tolerance budget, the reused DEX liquidity snapshot is stale or missing, the runtime cache has no active configured route at all, a reserve-metadata or DEX-liquidity preload step failed, or the D1 write/retention step returned warnings
- `error` when zero routes resolve to a usable scored row because of route failures, blocking unresolved states, all active configured routes missing capacity, or every configured route being absent from the active runtime stablecoins cache

Cron metadata includes `synced`, `resolved`, `unresolved`, `unresolvedMissingCapacity` (plus per-family/per-provider `familyMissingCapacityBy` / `providerMissingCapacityBy` breakdowns when any capacity is missing, so a single failing adapter family cannot hide inside the aggregate tolerance), `unresolvedCritical`, `availabilityDegraded`, `missingCapacityOkThreshold`, `coverageRatio`, `failed`, `configured`, `activeConfigured`, `cacheAbsentConfigured`, `dynamic`, `estimated`, `static`, `liquidityStale`, `severeActiveDepegThresholdBps`, registry/run manifest fields (`registryHash`, `familyCounts`, `strongProxyCount`, `heuristicCount`, `validatorVersion`, `configMethodologyVersion`, `v4ScoringParametersHash`), and route-status producer fields (`routeStatusProducer`, `routeStatusProducerFetches`), plus capped `failedIds`, `availabilityDegradedIds`, or `missingFromCache` when relevant. `availabilityDegraded`/`availabilityDegradedIds` are row-level route-availability signals and do not by themselves degrade the cron run.

---

## Scoring Model

### Component Weights

Defined in `shared/lib/redemption-backstop-scoring.ts`:

| Component            | Weight |
| -------------------- | ------ |
| Access               | 0.20   |
| Settlement           | 0.15   |
| Execution certainty  | 0.15   |
| Capacity             | 0.25   |
| Output asset quality | 0.15   |
| Cost                 | 0.10   |

If `capacityScore` is unavailable, `computeRedemptionBackstopScore()` returns `null` and the route is treated as unrated.

### Route-Family Caps

Some route families are intentionally capped even when their component mix scores higher:

| Route family      | Cap |
| ----------------- | --- |
| `queue-redeem`    | 70  |
| `offchain-issuer` | 65  |

An optional per-config `totalScoreCap` can apply an additional `config-cap`.

The exit-route observation envelope this producer emits is consumed by the Safety Score V9 Exit pillar, which is the only same-notional route grader. Redemption observations accept only `issuer-redemption` and `protocol-redemption` as potentially scoreable families; `eventual-redemption` is diagnostic-only. Reviewed `documented-terms` evidence uses a one-year review window. Reviewed opaque-fee observations can carry modeled capacity tagged with `feeEvidence: "undisclosed-reviewed"` while remaining producer-level non-score-eligible; a consumer must apply an explicit bounded-unknown fee policy rather than treating the route as cost-bounded. Route independence — and with it the pillar's bounded redundancy credit — is decided by the V9 Exit pillar from enumerated failure domains and physical resource keys.

The V9-only FPI path observes its Controller Pool, FRAX and FPI price feeds, and CPI tracker at one Ethereum block. Admission pins every dependency address and runtime hash, verifies current oracle rounds and controller/feed agreement, rejects paused or out-of-band state, and measures the live fee, quote, FRAX balance, and maximum redeemable FPI. Capacity is denominated as input FPI at the CPI peg; execution cost and the pinned FRAX output value remain separate so the all-in loss must satisfy the modeled-request ceiling. The configured CPI update bounds admit observations up to 62 days old at high model confidence, downgrade observations from 62 through 366 days to medium, and reject older state. The issuer collateral response and the nested route attempt publish through the same reserve-adapter result, so a failed issuer request cannot leave a new route attempt attached to stale composition. This evidence is consumed only by explicit V9 replay and does not alter standalone public redemption rows or scores.

Severe active downside depegs add a current-exercisability gate on top of the static route score. When an open `depeg_events` row is directionally below peg with `abs(peak_deviation_bps) >= 2500`, a static, estimated, live-proxy, issuer/API, queue, or documented-bound redemption route is marked `impaired` unless it has live-direct dynamic permissionless redemption capacity with atomic or immediate settlement. Severe upside events do not automatically impair a route whose redemption still clears at par into a non-impaired output asset. For configured tracked wrappers, downside impairment now also propagates from the parent stablecoin (the coin's `variantOf`, or its `pegReferenceId` when set) as output-asset impairment when that parent has an open severe-depeg row. This prevents stale route documentation from producing a strong par-exit score while the market is indicating that broad redemption is not currently clearing.

---

## Route Modeling

### Config Registry

Each configured coin declares:

- `routeFamily`
- `accessModel`
- `settlementModel`
- `executionModel`
- `outputAssetType`
- `capacityModel`
- `costModel`
- optional `costModel.feeDescription`
- optional `routeExitCorrelation`
- optional `totalScoreCap`
- optional `outputAssets`
- optional `notes`

The public registry import lives in `shared/lib/redemption-backstops.ts`. The actual config inventory is split by route family under `shared/lib/redemption-backstop-configs/` to keep review and change scopes small.

`outputAssets` records concrete holder-route outputs, not every reserve asset. Stable outputs use tracked stablecoin IDs; collateral outputs use canonical `asset:<symbol>` keys. Configured baskets are limited to 16 members, matching the `ExitRouteOutput.assetKeys` bound. Leave the field unset when the published route is incomplete or when its tracked and untracked members cannot all be represented: an incomplete subset must not turn an unresolved basket into a resolved one. When a complete reviewed route contains untracked assets, `unresolvedOutputAssetKeys` may preserve the exact identities for diagnostics; those keys do not resolve or score the output.

### July 2026 Output Reconciliation

The 2026-07-15 source pass made the following config-only evidence rulings. It did not change scoring weights or formulas.

| Route                   | Ruling                                                                                                                                                                                                                                                                           | Primary evidence                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nTBILL, nBASIS, nWISDOM | Stable basket: USDC + pUSD                                                                                                                                                                                                                                                       | [Nest available vaults](https://docs.nest.credit/about/available-vaults/)                                                                                                                   |
| nOPAL                   | Stable basket: USDC + pUSD + USDT                                                                                                                                                                                                                                                | [Nest available vaults](https://docs.nest.credit/about/available-vaults/)                                                                                                                   |
| USSD                    | Stable single: frxUSD. The deployed BrandedCustodian's `custodianTkn()` returned Sonic frxUSD and `redeemFee()` returned zero at Sonic block 75,971,769; the broader supported-USD-asset wording describes upstream/cross-chain infrastructure, not this direct holder contract. | [Sonic USSD docs](https://docs.soniclabs.com/sonic/ussd), [verified BrandedCustodian](https://sonicscan.org/address/0x54e14489646fd9693ea5071cb5dfeb1f5afa8f03#code)                        |
| USDm (`cusd-celo`)      | Stable basket: USDC + USDT, matching the direct Celo Broker/BiPoolManager counter-asset pools measured by live reserve sync.                                                                                                                                                     | [Mento V3 reserve](https://docs.mento.org/mento-v3/dive-deeper/the-reserve), [Mento V3 FPMM](https://docs.mento.org/mento-v3/dive-deeper/fpmm)                                              |
| EURm (`ceur-celo`)      | Stable single: USDm, represented by the approved tracked ID `cusd-celo`, matching the current Celo EURm/USDm counter-asset pool.                                                                                                                                                 | [Mento V3 reserve](https://docs.mento.org/mento-v3/dive-deeper/the-reserve), [Mento V3 FPMM](https://docs.mento.org/mento-v3/dive-deeper/fpmm)                                              |
| ftUSD                   | Stable basket: USDC + USDT. The current buy flow names both inputs and the sell flow returns the selected input asset at the prevailing rate. Sonic USSD is reserve inventory, not a verified holder redemption output.                                                            | [Flying Tulip ftUSD](https://docs.flyingtulip.com/product-suite/ft-usd/)                                                                                                                    |
| hyUSD                   | Fail closed with `routeStatus: unknown` and no concrete outputs. Current docs distinguish V1's SOL-only LST pool from V2's SOL/BTC/USDC pools, but do not reconcile the active tracked deployment and complete routable output set.                                              | [Hylo multi-asset architecture](https://docs.hylo.so/protocol-overview/multi-asset-architecture), [Hylo dynamic routing](https://docs.hylo.so/protocol-overview/dynamic-collateral-routing) |
| dUSD                    | Remains an unresolved basket. dTRINITY marks 11 symbols redeem-eligible across three deployments, but Katana's vbUSDC and vbUSDT have no tracked Pharos IDs. The complete 11-member set is retained in `unresolvedOutputAssetKeys`; publishing only the nine tracked economic assets would falsely resolve it. | [dTRINITY dUSD](https://docs.dtrinity.org/protocol-components/dusd)                                                                                                                         |

The 2026-07-26 follow-up resolved ZYS to the exact tracked ZSD output and made three other known-but-unpriceable routes explicit without promoting them: DLLR records ZUSD + DOC as an unresolved basket, wiTRY records untracked iTRY, and AZND remains an anonymous unresolved asset because Mu Digital's primary materials do not name the redemption settlement asset.

The 2026-07-19 second output pass made the following rulings over the routes that stayed unresolved after the first pass. It did not change scoring weights or formulas; the two passes share the same bar — a published output set must be complete enough that declaring it does not misstate the documented holder route.

| Route | Ruling | Primary evidence |
| ----- | ------ | ---------------- |
| AUDm, BRLm, CADm, COPm, GHSm, KESm, ZARm (broker pools), CHFm (FPMM) | Stable single: USDm (`cusd-celo`). Mento V3 CDP docs name USDm as the collateral asset of the FX-stable path, and every FX Broker/BiPoolManager exchange settles in USDm (the rebranded cUSD). The 2026-07-15 pass left these blocked on cusd-celo being untracked; it is now tracked and priced. | [Mento V3 CDP](https://docs.mento.org/mento-v3/dive-deeper/cdp), [Mento BiPoolManager](https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager) |
| USDai | Stable single: PYUSD, from the existing reviewed note that base USDai redeems through the burn-and-withdraw path into PYUSD. | [USD.AI buy / stake](https://docs.usd.ai/app-guide/buy-stake) |
| U | Stable basket: USDC + USDT + USD1, the documented whitelisted stablecoin set of the 1:1 smart-contract mint/burn path. The terms reserve issuer discretion over which reserve asset satisfies a redemption (including cash), so the basket is the documented onchain set, not a guaranteed payout composition. | [United Stables terms](https://www.u.tech/terms/) |
| inALPHA | Type corrected nav → stable basket (USDC + pUSD), matching the four sibling Nest vault entries retyped on 2026-07-15; the payout assets were already declared and delayed-NAV settlement is unchanged. | [Nest liquidity and redemptions](https://docs.nest.credit/about/liquidity-and-redemptions) |
| sAID | Type corrected nav → stable single: AID. The withdrawal pays AID (a tracked $1-target stablecoin); the unstaking-NAV conversion-rate and haircut caveats stay in the queued rules-based-nav execution model. | [GAIB sAID docs](https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said) |
| ACRED | Type corrected nav → stable basket: USDC + USDG, the off-ramps named on the current Securitize fund page for the quarterly repurchase cycle. | [Securitize ACRED fund page](https://securitize.io/primary-market/apollo-diversified-credit-securitize-fund) |
| USDu | Type corrected stable-single → mixed collateral: SOL + BTC + ETH. The terms define redemption as burning USDu for a pro-rata share of the underlying collateral, and the delta-neutral design page names SOL, BTC, and ETH as the collateral classes; no single-stablecoin payout is documented. | [Unitas terms of service](https://docs.unitas.so/resources/terms-of-service), [Unitas delta-neutral stability](https://docs.unitas.so/solution-overview/delta-neutral-stability) |
| EUR0 | Mixed collateral: `asset:eutbl`. The EUR0 product docs state permissioned redemption burns EUR0 to receive euTBL (Spiko EU T-Bills MMF) at par, and EUTBL is the sole EUR0 collateral entry in the tech docs. | [Usual EUR0 product docs](https://docs.usual.money/usual-products/usd0-stablecoin/eur0-stablecoin) |
| SILK | Mixed collateral: `asset:sscrt` + `asset:wbtc` + `asset:usdc`. Lend docs let the redeemer choose the vault whose collateral they receive; the declared assets are the vault collateral named in official sources (sSCRT in docs, USDC.axl and wBTC vaults in Shade DAO forum redemption reports). The vault whitelist is governance-mutable. | [Shade Lend stability mechanisms](https://docs.shadeprotocol.io/shade-protocol/advanced-topics-apps/lend/stability-mechanisms) |
| USDp (Parallel) | Mixed collateral: frxUSD, sfrxUSD, USDe, sUSDe, USDS, sUSDS, USDC, ygamiUSDC — the full documented Parallelizer backing set including the untracked Avalanche ygamiUSDC vault token. DAO-mutable. | [Parallel USDp implementation](https://docs.parallel.best/products/parallel-v3/stablecoins-and-savings/usdp-and-susdp/implementation) |
| reUSD (Resupply) | Mixed collateral: crvUSD + frxUSD. Resupply docs state all reUSD collateral backing is crvUSD on Curve Lend or frxUSD on Frax Lend, and the redeemer chooses which pools to redeem against. | [Resupply collateralized debt positions](https://docs.resupply.finance/resupply-protocol/collateralized-debt-positions) |
| satUSD | Bluechip collateral: BTC + ETH + BNB. River docs name BTC, ETH, BNB, and other liquid staking tokens as collateral; individual LSTs are not exhaustively enumerated. | [River satUSD redemption docs](https://docs.river.inc/products/editor/redemption), [River FAQ](https://docs.river.inc/intro/faq) |
| AZND, wiTRY, DLLR, dEURO, NECT, scUSD, ZYS | Remain unresolved. AZND's payout asset is undocumented; wiTRY pays untracked iTRY; DLLR's Mynt basket includes untracked ZUSD; dEURO's permissionless collateral onboarding means no fixed documented output set (and its modeled redemption route is not described in current primary docs); NECT and scUSD primary sources name outputs only as examples; ZYS pays ZSD whose price feed is currently missing. | — |
| cUSD (Cap) | Stable basket remains USDC + WTGXX. The live Cap vault producer now preserves the complete proportional value weights and the reserve-value-per-cUSD output unit, with WTGXX valued from its tracked timestamped Chainlink NAV feed in the same run. The V9 consumer can therefore value this exact live basket without inventing a WTGXX peg row or a symbolic $1 assumption. | [Cap vault](https://docs.cap.app/concepts/vault), [WTGXX Chainlink NAV feed](https://etherscan.io/address/0xD13cB763C43B5C058E7Ec40176962c5030F4EB49) |
| srUSD, wsrUSD (Reservoir) | Stable single: USDC. The modeled holder path composes the wrapper or srUSD exit into rUSD with Reservoir's downstream PSM, whose documented liquid redemption asset and capacity basis is USDC. The intermediate rUSD claim is not treated as the final unvalued output. | [Reservoir savings](https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd), [Reservoir PSM](https://docs.reservoir.xyz/protocol-architecture/peg-stability-module) |
| pmUSD, reUSD (Re Protocol), USD3 (Reserve) | Already declare complete outputs; they stay unresolved only because an output leg lacks a current price (susds-sky, susde-ethena, and steakusdc-steakhouse have no peg row). Blocked on price coverage, not on output curation. | — |

### Capacity Models

Capacity resolution is dispatched in `worker/src/lib/redemption-backstop-capacity.ts`, with per-model resolvers under `worker/src/lib/redemption-backstop-capacity/` (`supply-full.ts`, `supply-ratio.ts`, `fixed-usd.ts`, `reserve-sync.ts`); `redemption-backstop-sources.ts` orchestrates the entry build and calls into it.

| Capacity model          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supply-full`           | Exposes full current supply as `eventualRedeemabilityScore`, but leaves current scoring capacity empty because immediate buffer is not separately quantified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `supply-ratio`          | Immediate modeled capacity equals `supplyUsd * ratio`, optionally capped by a documented daily limit; this is heuristic unless the config explicitly opts into stronger confidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fixed-usd`             | Immediate modeled capacity equals a reviewed absolute USD buffer, clamped to current supply when supply is known; missing-supply rows keep the USD amount visible but use conservative absolute-tier scoring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reserve-sync-metadata` | Reads normalized `reserve_composition.metadata.redemption.capacityUsd` / `capacityRatioOfSupply` when present, falling back to legacy `immediateRedeemableUsd` / `immediateRedeemableRatio`, from the latest fresh live snapshot only when the adapter explicitly exposes redemption-capacity telemetry and the snapshot carries scoring-grade freshness evidence. The telemetry must isolate assets immediately executable through the holder route; mixed reserve or accounting buckets remain contextual backing evidence. Degraded snapshots still fail closed by default, but specific lower-bound-only warning classes can be allowlisted per route when they indicate reserve completeness limits rather than broken telemetry. Routes can also fall back to a reviewed configured ratio or USD amount when public docs publish a hard primary-market buffer floor. |

Rows may include `capacityProfile`, which separates `immediateUsd`, `dailyLimitUsd`, `queuedUsd`, `eventualUsd`, `scoringUsd`, `scoringHorizon`, and `capacityProfileConfidence`. Legacy `immediateCapacityUsd`, `immediateCapacityRatio`, and `capacityScore` remain populated for compatibility.

Live reserve adapters can now emit a nested `metadata.redemption` object for new redemption-specific telemetry. The validator rejects malformed or unsupported redemption telemetry before persistence, including negative capacity, capacity ratios outside `0..1`, negative fees, capacity fields from adapters that declare no capacity support, fee fields from adapters that declare no fee support, or direct-capacity tiers emitted by proxy-only adapters. Legacy flat metadata remains readable while existing adapters are migrated to the nested contract.

Sky `DAI` and `USDS` now use the live `sky-makercore` PSM `USDC` balance as their immediate redeemable bound when that telemetry is fresh, with the prior 33% reviewed heuristic retained only as fallback.
`USDe` uses the live `ethena` adapter's same-run reads of the EthenaMinting contract's own USDT/USDC balances as direct redemption capacity, capped by the per-asset and global max-redeem-per-block configuration read in the same pass and gated on a `usde()` identity check; any failed read withholds the telemetry entirely and the reviewed 0.5% fallback ratio takes over.
Reservoir `rUSD`, `srUSD`, and `wsrUSD` use the live `reservoir` adapter's same-run on-chain reads of the USDC Peg Stability Module (pinned address, `underlying()` identity check, `underlyingBalance()`, `paused()`) as the terminal-leg capacity bound with route status open/paused from the same reads; the balance-sheet USDC bucket stays diagnostic and a failed read withholds the redemption block, falling back to the documented 25 bps minimum PSM balance.
Mento FPMM pools (`JPYm`, `CHFm`) additionally read the pool's `lpFee()` + `protocolFee()` live each run, so the route carries a current measured fee instead of an undisclosed-fee marker; the verified implementation caps the combined fee at 200 bps.
`cUSD` now uses the live `cap-vault` onchain adapter for bounded current redemption capacity, scoring against unpaused available vault balances rather than full eventual basket redeemability. The producer also binds the complete USDC + WTGXX output weights and aggregate unit value to the same reserve snapshot, using the tracked timestamped WTGXX Chainlink NAV feed; output valuation fails closed if that source-bound basket fact is unavailable.
`USD3` now uses the live `3jane-usd3` onchain adapter for fee-free, bounded USDC redemption capacity from `availableWithdrawLimit(address(0))`; credit NAV outside currently redeemable waUSDC liquidity is not scored as an immediate exit.
`LUSD` now uses the live `liquity-v1` onchain adapter for bounded current direct capacity, scoring against `TroveManager.getEntireSystemDebt()` when the 4-hourly reserve snapshot is fresh and clean rather than the old static full-supply model.
`BOLD`, `feUSD`, `USDQ`, `NECT`, and `CDP` now use the live `liquity-v2-branches` onchain adapter for bounded current direct capacity, scoring against aggregate ActivePool branch debt when the 4-hourly reserve snapshot is fresh and clean rather than the old static full-supply model. The adapter can also surface branch shutdown/sunsetting as degraded route status.
`meUSD` now uses the live `liquity-native-active-pool` onchain adapter for Mezo's native ActivePool shape, scoring against latest contract debt only when the same-run collateral, TCR/MCR, and fee telemetry is fresh and clean.
`reUSD` now uses the live `resupply-pairs` onchain adapter for bounded current direct capacity, scoring against aggregate `RedemptionHandler.getMaxRedeemableDebt(pair)` only when the same-run handler guard state shows permissionless redemptions are open. If the guard is closed above the threshold, the route is marked cohort-limited and does not uplift Safety Score liquidity.
Re Protocol `reUSD` now uses `re-metrics` instant redemption vault capacity from the official metrics payload as same-run API telemetry, retaining a reviewed fallback because redemptions above the instant vault capacity can spill to the queue.
`fxUSD` now uses f(x)'s protocol pool API debt balances as live proxy capacity, while `USDaf` uses Asymmetry's timestamped protocol supply data as direct live capacity. `JupUSD` uses Jupiter's public transparency API for current USDC/USDtb holdings and oracle route-status context, with the previous 10% reviewed buffer retained only as fallback.
M0 wrappers `wM` and `USDSC` now use `m0-wrapper-underlying` capacity telemetry from the underlying M token balance; USDSC also requires the reviewed Soneium SwapFacility and approved swapper route before emitting whitelisted-primary direct capacity.
ERC-4626 single-asset wrappers such as fxSAVE, Spark savings wrappers, sUSDS, scrvUSD, and stcUSD use the live adapter's idle underlying ERC-20 balance as current direct redemption capacity when fresh reserve telemetry is available, rather than treating the full wrapper supply as immediately executable. Vaults whose redemption is atomic and unconstrained against an external savings module — currently `sdai-sky` (legacy Sky DSR pot routing), `susdd-tron-dao-reserve` (sDAI-fork pot/join exit in the USDD v2 Maker-fork core), and `sdola-inverse-finance` (unstakes from the fully liquid DolaSavings module), each leaving the vault's idle underlying balance at ~0 despite unconstrained same-block redemption — instead set `redemptionLiquidity: { source: "atomic-full-backing" }` to score the full convertible backing (ratio 1.0) as same-run live-direct capacity. `sbold-k3-capital` uses `redemptionLiquidity: { source: "sbold-sp-withdrawable" }` to read the BOLD amount withdrawable from its Liquity V2 Stability Pool positions through `calcFragments()`; it stays at documented-bound confidence because unswapped collateral gains are excluded and K3's collateral-health gate can temporarily restrict withdrawals. `sfrxusd-frax` is another explicit exception: local Ethereum withdrawal is disabled, so `redemptionLiquidity: { source: "fraxtal-hop-withdrawable" }` observes the Ethereum RemoteHop, Fraxtal Hop, and MintRedeemer path from finalized blocks. It pins all six upgradeable implementations, validates peers, token and oracle identities, verifies the three inventory views, caps capacity by Ethereum sfrxUSD supply, and checks that the Fraxtal Hop can fund the quoted return message. The packet remains diagnostic and non-scoreable because the holder's Ethereum transaction gas and a primary-source or measured completion-time upper bound are unavailable. Failed exact-route or sBOLD reads do not fall back to full NAV or the disabled local sfrxUSD withdrawal path. `eearn-ember` now uses a specialized fixed-block observer that pins its vault, validator, and protocol-config proxy/implementation identities, reads pause/queue/fee state, and emits zero 300-second capacity because the holder route is operator-batched; idle USDC is diagnostic only. `sdusd-dtrinity` pins the Ethereum dSTAKE token, router, collateral vault, exact active strategies and conversion adapters, then bounds atomic dUSD output by the live dLEND strategy `maxWithdraw` cross-checked against available dUSD liquidity and reads the current unstaking fee. Both observers fail closed on identity or required-state drift. Reviewed Yearn V3 vault configs can use `redemptionLiquidity: { source: "yearn-v3-withdrawable" }`, which measures `totalIdle()` plus each funded default-queue strategy's `min(currentDebt, convertToAssets(maxRedeem(vault)))` from the same on-chain run; if any funded strategy probe fails, the route does not fall back to full NAV. Reviewed Morpho vault configs can additionally use Morpho V2 `liquidity` or Morpho V1 `liquidity.underlying` as same-run API capacity after validating the exact vault, underlying asset, listed status, and chain id; Morpho V2 `forceDeallocatableLiquidity` remains contextual and is not scoring capacity.
Since `v4.32` these ERC-4626 paths also assert current route openness: the adapter probes the vault's `paused()` surface (plus `isShutdown()` for Yearn V3) in the same run and emits `routeStatus: "open"` only when the capacity read is clean, positive, and no probe reports a halt — a probed `true` emits `"paused"`, a revert reads as "no pause surface" rather than as evidence, zero capacity stays `"unknown"`, and warnings still force `"degraded"`. This supplies the current-open attribution the V9 exit pillar requires before a live-direct atomic observation is score-eligible; the specialized observers (eEARN, sdUSD, sfrxUSD) keep their own richer route-state contracts.
`GHO` now uses tracked swappable GSM backing as a live lower bound even when reserve sync is degraded solely by aggregated residual issuance outside the configured GSM set, because that warning reflects reserve completeness rather than invalid tracked telemetry.
`wsrUSD` continues to prefer live Reservoir USDC balance telemetry when available, but now falls back to Reservoir's documented 25 bps minimum USDC PSM balance instead of remaining unrated when the live feed lacks a trustworthy source timestamp.
Reviewed bounded primary-market liquidity buffers published by protocols or issuers, such as DOLA's USDS PSM share or JupUSD's USDC buffer, can also use `documented-bound` ratio semantics when the underlying source is explicit enough to avoid pretending the ratio is merely a blind heuristic.
Reviewed route docs alone are not enough to promote delta-neutral or strategy-backed rails into `documented-bound` full-supply semantics; those routes still need either an explicitly published immediate buffer bound or fresh live reserve telemetry.

The resulting row is tagged with one `sourceMode`:

- `dynamic` when fresh latest-success authoritative live reserve snapshot metadata is available
- `estimated` when static supply models or configured reserve-sync fallback ratios are used
- `static` when the route remains configured but the current snapshot could not resolve a usable score, including failure-safe rows written after per-coin sync errors

### Provider / Source Definitions

Provider identifiers are defined in `shared/lib/redemption-backstop-providers.ts` and describe where the capacity number came from, what confidence defaults apply, and whether the source can ever survive a severe-depeg gate.

| Provider                | Capacity source           | Default source mode | Default confidence | Default semantics   | Severe-depeg scoreability         |
| ----------------------- | ------------------------- | ------------------- | ------------------ | ------------------- | --------------------------------- |
| `supply-full-model`     | Full supply model         | `estimated`         | `heuristic`        | `eventual-only`     | Not scoreable                     |
| `supply-ratio-model`    | Configured supply ratio   | `estimated`         | `heuristic`        | `immediate-bounded` | Not scoreable                     |
| `fixed-usd-model`       | Fixed reviewed USD buffer | `static`            | `documented-bound` | `immediate-bounded` | Not scoreable                     |
| `reserve-sync-metadata` | Live reserve metadata     | `dynamic`           | `dynamic`          | `immediate-bounded` | Requires strong live-direct route |
| `reserve-sync-fallback` | Reviewed fallback ratio   | `estimated`         | `heuristic`        | `immediate-bounded` | Not scoreable                     |
| `sync-error`            | Failure sentinel          | `static`            | `heuristic`        | `immediate-bounded` | Not scoreable                     |

`reserve-sync-metadata` readback can refine confidence to `live-direct` or `live-proxy` when the configured adapter declares direct or proxy redemption-capacity telemetry. Proxy and queue telemetry can provide context or lower-bound capacity, but they cannot qualify as severe active-depeg live-direct evidence.

Each row also carries:

- `resolutionState`:
  - `resolved` when the route produced a usable score
  - `missing-cache` when the stablecoins snapshot did not contain the asset or its current supply
  - `missing-capacity` when the route is configured but current runtime inputs could not produce usable capacity
  - `failed` when a route-specific resolver failed
  - `impaired` when the route shape is known but current market or route-availability evidence contradicts broad par redemption; impaired rows have `score = null` and `modelConfidence = low`
- `routeStatus`:
  - `open` for normal resolved routes without current impairment evidence
  - `degraded` when the route is currently impaired by market-implied evidence such as a severe active depeg
  - `paused`, `cohort-limited`, and `unknown` are reserved for explicit route-availability sources and backward-compatible legacy rows
  - whitelist or approved-holder gates should normally be modeled through `accessModel` / `holderEligibility`; use `cohort-limited` only when current route evidence shows impairment beyond that reviewed eligible cohort
  - unknown route status remains a low-confidence signal unless the capacity evidence is direct live telemetry or a source-reviewed documented bound
- `routeStatusSource`:
  - `static-config` for normal config-derived status
  - `market-implied` for the severe active-depeg exercisability gate
  - `operator-notice`, `protocol-api`, and `onchain` are reserved for future current-route evidence sources
  - no operator override or standalone route-status feed is wired in the cron path today; merge precedence is live adapter evidence, then static config, with market-implied severe-depeg impairment applied last unless a strong live-direct route is explicitly open
- `holderEligibility`:
  - derived from the route access model by default: permissionless onchain routes are `any-holder`, whitelist routes are `whitelisted-primary`, issuer API routes are `verified-customer`, and manual routes are `issuer-discretionary`
- `capacityConfidence`:
  - `live-direct` for live reserve-sync capacity sourced from direct current redemption telemetry
  - `live-proxy` for live reserve-sync capacity inferred from a live proxy liquidity bucket rather than a protocol-native redemption-limit feed
  - `dynamic` only as a legacy / unresolved reserve-sync bucket when older stored rows lack the richer live-capacity classification
  - `documented-bound` when a bounded model is explicitly configured that way after source review, including reviewed full-supply redeemability where official issuer or protocol terms establish eventual redemption of outstanding supply
  - `heuristic` by default for `supply-full`, `supply-ratio`, and inferred legacy rows without stronger evidence
- Reserve-sync capacity now ignores degraded snapshots, weak fee-only adapters, and snapshots that do not carry scoring-grade freshness evidence by default. The only exceptions are route-specific lower-bound warning classes that explicitly preserve a trustworthy redeemable-capacity floor while keeping reserve sync itself degraded for completeness review.
- Immutable fully on-chain systems and reviewed direct issuer / direct redeem routes can use `documented-bound` with `eventual-only` semantics when protocol mechanics or issuer terms establish full-system redeemability directly, even if no separate immediate buffer is measured
- `capacitySemantics`:
  - `immediate-bounded` when the model is intended to represent a current redeemable buffer
  - `eventual-only` when the route is scored as eventual redeemability rather than immediate same-size liquidity. Report cards generally treat these as visible-only, except documented offchain issuer routes can add a DEX-gated primary-market exit bonus under Safety Score methodology v7.05+
- `capacityBasis` (orthogonal to `capacityConfidence`: basis describes the model shape, confidence the evidence strength — consumers must read both; a `psm-balance-share` basis can be live-measured or a heuristic guess):
  - typed evidence basis such as `issuer-term-redemption`, `full-system-eventual`, `psm-balance-share`, `strategy-buffer`, `hot-buffer`, `daily-limit`, `live-direct-telemetry`, or `live-proxy-buffer`
  - reserve-sync fallback ratios use the configured `basis` when present, otherwise route-family defaults such as `psm-balance-share`, `strategy-buffer`, or `hot-buffer`; they are not labeled `live-proxy-buffer` unless live proxy telemetry produced the capacity
- Live reserve telemetry fields are additive display/provenance context, not Safety Score eligibility by themselves:
  - `capacityKind` describes the adapter-declared evidence shape, such as `live-direct-bounded`, `live-queue`, `live-proxy-validated`, `documented-bound`, `documented-eventual`, or `heuristic`
  - `freshnessKind` describes the adapter-declared redemption freshness evidence, such as `verified-source-timestamp`, `same-run-onchain`, `same-run-api`, `reviewed-static`, or `unverified`
  - `sourceTimestamp`, `sourceUrls`, `settlementDelaySec`, `queueDepthUsd`, `dailyLimitUsd`, `minRedeemUsd`, and `liveHolderEligibility` are carried through the API/UI when emitted by live reserve adapters
- `feeConfidence`:
  - `fixed` for bounded bps schedules
  - `formula` for disclosed formulas such as Liquity-style base-rate fees
  - `undisclosed-reviewed` when docs were reviewed but only descriptive fee information is available
- `feeModelKind`:
  - `fixed-bps`, `formula`, `documented-variable`, or `undisclosed-reviewed`
- `modelConfidence`:
  - `high`, `medium`, or `low` rollups used by the API and detail page to communicate fidelity
  - `low` for heuristic-capacity routes, unresolved rows, impaired rows, unclear holder eligibility, stale docs without current route-status evidence, or unknown route status without direct live telemetry or source-reviewed documented-bound capacity
  - `confidenceDetails` can expose the component evidence scores and rollup reasons
- `routeExitCorrelation`:
  - `independent-issuer-rail`, `same-stablecoin-pool-backing`, `same-protocol-liquidity`, `wrapper-to-parent-dependency`, or `unknown`
  - only `independent-issuer-rail` earns the v4 effective-exit diversification bonus

### Docs / Notes

- `docs` prefers explicit config-reviewed sources first (`docs[]` + `reviewedAt`), then live-reserve display links for reserve-sync routes, then the coin metadata's `proofOfReserves.url`, then preferred public links (`Docs`, `Proof of Reserve`, `Transparency`, `Website`)
- `docs.provenance` distinguishes reviewed route docs from fallback live-reserve, proof-of-reserves, or generic project-link sources so detail pages do not overstate evidence quality
- `docs.reviewedAt` is the route-review date, not a claim that the rendered fallback link itself was the reviewed source; the detail card now shows review date and provenance together
- `docs.sources[]` records structured provenance for what the linked source supports (`route`, `capacity`, `fees`, `access`, `settlement`)
- The registry check ratchets aggregate source-support coverage and emits per-config warnings when a `documented-bound` capacity route lacks explicit `route` or `capacity` support. These warnings are backlog controls, not hard CI errors, until the remaining documented-bound source-support gaps are cleaned up.
- `feeDescription` carries docs-backed fee text when the route fee is fixed, conditional, dynamic, flat-fee-based, or publicly undisclosed
- `notes` merges config notes plus runtime notes such as stale reserve metadata expiry, conservative fallback use, or live fee fallback
- `capsApplied` records any score caps triggered during scoring

### Cost Modeling

- `feeBps` is still used only when the route has a bounded fixed basis-point fee that can be represented cleanly in the score model
- Formula-based routes can also populate `feeBps` from fresh latest-success live reserve snapshot metadata when the protocol exposes a current on-chain redemption rate; the route still remains labeled as `feeModelKind = formula`
- Reviewed fixed-fee routes may also consume fresh authoritative live fee telemetry when the protocol exposes the current active redemption fee and the static config is only a safe fallback bound
- `feeModelKind` distinguishes fixed-fee routes from documented formulas, documented variable schedules, and reviewed-but-undisclosed fee rails
- `feeDescription` is used to surface:
  - dynamic formulas such as Liquity-style `min 50 bps + baseRate`
  - conditional fee schedules such as borrower-vs-non-borrower redemptions
  - flat minimums or bank/network charges that do not map cleanly to one global bps number
  - cases where public docs were reviewed but no numeric redemption-fee schedule is published
- If live formula telemetry is missing, the route falls back to the reviewed-formula bucket rather than pretending a fixed fee is known
- `costScore` uses the active-user scenario by default when v4 fee-shape inputs are present; optional `costScenarioScores` exposes retail, active-user, and institutional route-size scores

---

## Database Schema

Migration: `worker/migrations/0000_baseline.sql` in the current post-squash tree, plus `0094_redemption_backstop_runs.sql` for completed-run snapshot manifests and `0120_redemption_backstop_run_rows.sql` for the manifest-scoped current row store. Historical introduction lives in the pre-squash lineage recorded in `worker/migrations/MANIFEST.md`.

### `redemption_backstop`

Current snapshot table, one row per configured stablecoin.

Key columns:

- `stablecoin_id` — PK
- `score`
- `effective_exit_score`
- `dex_liquidity_score`
- `access_score`
- `settlement_score`
- `execution_certainty_score`
- `capacity_score`
- `output_asset_quality_score`
- `cost_score`
- `route_family`
- `access_model`
- `settlement_model`
- `execution_model`
- `output_asset_type`
- `provider`
- `source_mode`
- `immediate_capacity_usd`
- `immediate_capacity_ratio`
- `fee_bps`
- `queue_enabled`
- `updated_at`
- `methodology_version`
- `details_json`
- `snapshot_run_id`

`details_json` now also stores `routeFamily`, provider/source provenance, immediate-capacity fields, optional live telemetry fields, fee fields, `resolutionState`, `routeStatus`, `routeStatusSource`, `routeStatusReason`, `routeStatusReviewedAt`, `holderEligibility`, `capacityConfidence`, `capacityBasis`, `capacitySemantics`, `feeConfidence`, `feeModelKind`, `modelConfidence`, and `feeDescription` alongside `docs`, `notes`, and `capsApplied`, so richer runtime context survives current-snapshot and history writes without a schema migration.

`snapshot_run_id` links current rows to a completed `redemption_backstop_runs` manifest when written by the post-`0094` worker. API and report-card readers prefer the latest valid completed run. If the newest completed manifest is incomplete or its rows are unreadable, readers try recent earlier completed runs before returning `503`. The true-legacy `MAX(updated_at)` fallback is retired: with no valid completed run, readers fail closed to `503` (fresh local databases 503 cleanly until the first completed sync).

### `redemption_backstop_history`

Daily history table keyed by `(stablecoin_id, snapshot_date)`. No runtime reader consumes it today; rows are retained for 90 days for future track-record use and pruned in bounded batches by the same retention pass that prunes run manifests.

Stored fields:

- `score`
- `effective_exit_score`
- `dex_liquidity_score`
- `updated_at`
- `methodology_version`
- `details_json`
- `snapshot_run_id`

The cron writes immutable `redemption_backstop_run_rows` first, writes daily history, and marks the run manifest completed only after the immutable row count and bounds are valid. The legacy current-mirror refresh is retired: readers (including the depeg-resolver context, which uses a narrow store reader over the latest valid completed run) consume immutable run rows exclusively, and the `redemption_backstop` table is frozen in place pending a separately coordinated destructive cleanup.

### `redemption_backstop_runs`

Completed-run manifest table used to prevent mixed-generation current snapshots from being treated as fresh.

Stored fields:

- `run_id` — unique generated run identifier
- `started_at`
- `completed_at`
- `status` (`running`, `completed`, or `failed`)
- `expected_count`
- `written_count`
- `methodology_version`
- `min_updated_at`
- `max_updated_at`
- `metadata_json`

The sync inserts a `running` row before writing immutable run rows, writes history after those rows are complete, and marks the manifest `completed` only after the immutable row count and update bounds are valid. If immutable row, history, or completion writes fail after the manifest is started, the writer best-effort marks the manifest `failed` with phase-specific failure metadata before rethrowing. Readers prefer the latest valid completed run, use its `max_updated_at` for response freshness, and use its `methodology_version` for API methodology attribution. If no completed run exists, they return `503`; the legacy current-mirror write and the `MAX(updated_at)` fallback are retired.

Run manifests and immutable run rows are pruned after successful writes with a 14-day retention window. The prune keeps the just-written run and the latest completed run even when either is older than the cutoff, so current API reads and legacy fallback constraints stay intact. Retention failures are recorded as completed-run warnings instead of failing the already-written snapshot.

---

## API Endpoint

### `GET /api/redemption-backstops`

**File:** `worker/src/api/redemption-backstops.ts`

- Returns `503` with `{ "error": "Redemption backstop snapshot unavailable" }` when no valid completed run can be read cleanly from immutable run rows (including before the first completed sync on a fresh database); partial manifested current rows are not treated as authoritative
- The response metadata carries `snapshotSource: "run-rows"`; snapshots are read only from immutable rows for a valid completed run
- Otherwise returns the current map plus methodology metadata from `buildRedemptionBackstopsSnapshot(db)`, with `methodology.version` attributed from the latest completed run manifest and `currentVersion` preserved as the live code version
- Cache profile: `standard` (`public, s-maxage=300, max-age=60`) with freshness headers based on `updatedAt`

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Consumers

- `src/hooks/api-hooks.ts` exports `useRedemptionBackstops()`, wired through `FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops` in `src/lib/api-query-descriptors.ts` with the `CRON_RESERVE_SYNC` producer interval (4-hour reserve lane cadence)
- `src/hooks/use-stablecoin-detail-view-model.ts` fetches the map and passes the coin-specific entry into the stablecoin detail view model
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` renders one `Standalone route score` with a route-specific title (`Issuer redemption route` or `Redemption route`), source freshness, route family, source mode, resolution state, route status, model confidence, access/settlement/output/capacity blocks, eventual-only vs immediate-bounded capacity messaging, explicit redemption-fee summaries keyed off `feeModelKind`, reviewed docs/source context, component subscores, and contextual methodology hint / footer actions.
- `src/lib/stablecoin-detail-view-model.ts` includes redemption freshness in the detail-page stale-query rail
- `/coverage` consumes `useRedemptionBackstops()` through `src/lib/coverage/redemption.ts`. It distinguishes scored route-family states from low-confidence heuristic routes, resolved-but-unscored routes, configured-but-unrated routes, impaired routes, no route, and `Data n/a` feed-unavailable states, so unresolved, eventual-only, impaired, or weakly evidenced rows do not inflate public strong-coverage counts. The Redemption quick filter includes configured/resolved route states but excludes `Data n/a`.

The maintenance coverage audit requires a durable reviewed disposition for every active asset without a route config. `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts` records evidence URLs, reviewer/date, rationale, the exact blocker and evidence still needed, and a route family only when official evidence proves that family. `add` means the holder route is evidenced but configuration still needs the listed capacity/status inputs; `needs-research`, `defer`, and `hard-reject` remain legitimate coverage outcomes and do not create a scoreable route. The audit rejects stale registry rows and keeps heuristic configured routes visible until hard capacity evidence replaces them.

There is currently no dedicated list page or standalone public methodology section for redemption routes; the primary user-facing surface is the stablecoin detail page. Contextual hints identify the route score as standalone and link to the Safety Scores methodology section for the separate V9 Exit model.
