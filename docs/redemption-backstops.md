# Redemption Backstops

Modeled redemption-route coverage for tracked stablecoins. This subsystem estimates how credibly a holder can exit to par or near-par outside secondary-market DEX liquidity, then exposes both a standalone snapshot API and an effective-exit input for report-card liquidity scoring.

---

## Methodology Versioning

- **Current methodology version:** `v4.19`
- **Public methodology anchor:** `/methodology/#safety-scores-methodology`
- **Canonical source files:** `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-configs/*`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/redemption-backstop-version.ts`

Latest `v4.19` update: live reserve metadata qualifies as executable redemption capacity only when the adapter isolates assets immediately available to the holder route. Ethena's `Liquid Cash` value is a mixed accounting bucket rather than an isolated executable buffer, so USDe keeps its reviewed 0.5% hot-buffer fallback and documented fixed 10 bps fee. The aggregate remains visible as backing composition but no longer inflates effective-exit capacity.

Previous `v4.18` update: resolved `supply-full` routes that quantify no immediate capacity now publish one explicitly-bounded `exitRouteObservations` row derived purely from the published row's own reviewed model (`deriveSupplyModelExitRouteObservation` in `worker/src/lib/redemption-exit-route-observations.ts`): documented-terms evidence at the docs review timestamp, capacity bounded by the documented full-supply basis, and a cost bound only when the fee model is a documented fixed bps fee. Atomic settlement projects onto the same-notional request and can be score-eligible; immediate/same-day/days/queued settlement publishes diagnostic `eventual-redemption` observations (conservative horizon ceilings 1h/1d/14d/30d) that are never score-eligible. Scores and blending are unchanged — this adds observation evidence only.

Previous `v4.17` update: a verified live-direct capacity tranche. The 13-coin Mento family moves from documented-bound full-supply models to same-run Celo on-chain telemetry (Broker/BiPoolManager counter-bucket depth with the pool's on-chain spread as a live formula fee; the GBPm Liquity-v2-fork branch via ActivePool debt plus `getRedemptionRateWithDecay()`; JPYm/CHFm via Mento-v3 FPMM pool depth, capacity only). `ustb-superstate` capacity of record becomes the on-chain USDC balance of Superstate's RedemptionIdle contract with the documented current 0 bps fee. `pusd-polymarket` scores its verified immutable backing vault's USDC balance as unwrap capacity (0 bps documented). `cusd-cap` reads its flat redeem fee live from the vault's inherited Minter (`getRedeemFee()`). `usde-ethena` fee evidence moves to the documented fixed 10 bps (capacity stays live-proxy — no public buffer endpoint). The atomic-full-backing cohort extends to `susdd-tron-dao-reserve` and `sdola-inverse-finance` after per-vault contract review with state-override redemption simulations; `sbold-k3-capital` (collateral-health gate, BOLD-only withdrawal cap) and `eearn-ember` (operator-batched request/settle exits) were reviewed and deliberately left on the conservative idle probe. Scoring formulas and confidence gates are unchanged.

Previous `v4.16` update: reviewed Yearn V3 ERC-4626 vault exits can set `redemptionLiquidity: { source: "yearn-v3-withdrawable", settlementDelaySec: 0 }`, which measures same-run on-chain withdrawable capacity from `totalIdle()` plus each funded default-queue strategy's `min(currentDebt, convertToAssets(maxRedeem(vault)))`. `ybold-yearn` and `yvusdc-yearn` use this path so strategy-backed BOLD/USDC that is withdrawable through the Yearn queue no longer scores as near-zero just because the vault's idle underlying balance is low. Generic ERC-4626 vaults still do not treat `convertToAssets(totalSupply)` as executable capacity without a reviewed liquidity mode.

Previous `v4.15` update: ERC-4626 savings vaults whose redemption is atomic and unconstrained against an external savings module can set a reviewed `redemptionLiquidity: { source: "atomic-full-backing" }` adapter flag, which scores the full convertible backing (ratio 1.0) as same-run live-direct capacity instead of the near-zero idle-underlying probe. The first such route is `sdai-sky`: the legacy Sky DSR routes redeemed DAI through the Maker pot, so `DAI.balanceOf(sDAI)` is ~0 despite atomic unconstrained sDAI→DAI redemption — its backstop score rises 69→93 and effective-exit 62→93. Modern `susds-sky`/`stusds-sky` hold their underlying in-contract and are unaffected.

Previous `v4.14` update: Steakhouse, Smokehouse, and Gauntlet Morpho vault-token routes (`steakusdt-steakhouse`, `steakusdc-steakhouse`, `gtusdcp-gauntlet`, `bbqusdc-steakhouse`, and `gtusdc-gauntlet`) now use reviewed Morpho V1/V2 vault liquidity as current executable redemption capacity after validating the exact vault address, underlying asset address, listed status, and Ethereum chain id. The score still caps capacity by the ERC-4626 asset base, keeps Morpho V2 `forceDeallocatableLiquidity` as context only, and leaves the standalone DEX liquidity score unchanged.

Previous `v4.13` update: eligible medium-confidence follow-ups now use same-run reserve-sync capacity for `cdp-enosys`, `meusd-mezo`, `wm-m0`, `usdsc-startale`, and `reusd-re-protocol`. A review-time adapter dry run at 2026-06-15 10:09 UTC measured $120.9M of current live-direct capacity across those routes: $84.2M wM, $25.4M Re Protocol reUSD, $4.8M USDSC, $3.5M Mezo meUSD, and $3.0M Enosys CDP. Verified entries with paused/zero live capacity, queue-only exits, or reserve-incomplete PSM-only telemetry remain deliberately unpromoted.

Previous `v4.12` update: a verified medium-confidence upgrade tranche replaces eligible undisclosed-fee placeholders with fixed or formula fee evidence, while Sky `DAI`/`USDS` now read the LitePSM `USDC` pocket directly on-chain for same-run live-direct capacity. Routes with admin-configurable, silent, or missing fee/capacity evidence remain deliberately unpromoted.

Previous `v4.11` update: reviewed issuer rails with public at-par redemption terms AND attested ~100% highly-liquid reserves (PYUSD, USDP, USDG, GUSD) move from eventual-only `supply-full` to a `documented-bound` 25% same-day hot-buffer ratio (attested liquid share with a uniform 75% haircut, anchored above the worst observed primary-redemption wave). USDT, RLUSD, FDUSD, and USD1 deliberately stay eventual-only because their public terms do not commit to a settlement window. Issuer-specific stricter bounds (USDC's 7% cash floor) take precedence over the generic rule.

Previous `v4.07` update: conservative confidence defaults in the effective-exit blend (missing model confidence now applies the low 0.35 factor), live-proxy capacity with unknown route status always rolls up low confidence, the strong live-direct severe-depeg exemption is re-evaluated against the final resolved capacity state, and over-leveraged output-dependency compositions are flagged while the impaired share stays clamped at 100%.

There is no standalone changelog page yet. The public methodology link currently points at the Safety Scores section because redemption backstops feed the report-card liquidity dimension.

---

## Coverage

Configured coverage is defined statically behind the thin facade in `shared/lib/redemption-backstops.ts`, with route-family modules under `shared/lib/redemption-backstop-configs/`.

- **Configured coins:** 308
- **Route families:** 147 `offchain-issuer`, 65 `stablecoin-redeem`, 39 `collateral-redeem`, 38 `queue-redeem`, 10 `psm-swap`, 9 `basket-redeem`
- **No discovery layer:** only coins present in `REDEMPTION_BACKSTOP_CONFIGS` are modeled

The config registry is validated at module load time against `TRACKED_META_BY_ID`, so unknown IDs fail fast during build/test/runtime startup.

`npm run check:redemption-backstops -- --report <path>` writes per-config audit rows with both the literal configured `capacityBasis` and the resolved runtime-style `resolvedCapacityBasis`. Reserve-sync rows use the tracked adapter's direct/proxy redemption-telemetry declaration when resolving that audit basis. The report also includes `capacityFallbackSource` for reserve-sync fallback ratios/USD buffers and `dailyLimitUsd` when a static model caps same-day capacity, so review queues can distinguish route-family defaults from explicit fallback or daily-limit constraints.

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

### Effective Exit Score

`computeEffectiveExitScore()` uses a capacity-aware best-path model to combine modeled redemption quality with observable DEX liquidity:

- Model exit size defaults to `min(max(circulatingSupplyUsd × 0.05, 100_000), 25_000_000)`.
- Redemption contribution is multiplied by `min(1, currentExecutableCapacityUsd / modeledExitSizeUsd)` when current capacity is known.
- Redemption contribution is also discounted by model confidence (`high = 1`, `medium = 0.75`, `low = 0.35`) when v4 options are present.
- If both DEX and redemption exist, the best path wins. The `0.10` diversification bonus applies only when `routeExitCorrelation = independent-issuer-rail`.
- If only DEX liquidity exists: passthrough DEX liquidity
- If only redemption exists: passthrough the capacity/confidence-adjusted redemption score
- If neither exists: `null`

The redemption-backstop cron materializes raw `effectiveExitScore` on every resolved row using the last-known DEX liquidity input, even when that input is stale relative to the `CRON_INTERVALS["sync-dex-liquidity"] * 2` freshness budget. Stale or missing DEX input still marks the cron run `degraded` and flips `metadata.liquidityStale = true` for operational visibility. Report cards then apply their own confidence and availability gating on top, so stale redemption snapshots and low-confidence redemption routes stay visible on redemption surfaces but do not uplift Safety Score liquidity. In v4, eventual-only routes expose `eventualRedeemabilityScore` for route-quality context but do not create redemption-only Safety liquidity uplift without current executable capacity. Documented offchain issuer eventual routes can contribute only a DEX-gated primary-market bonus, using `eventualRedeemabilityScore` as the route-quality ceiling while requiring a current DEX liquidity floor.

The shadow P4 same-notional envelope is stricter than the legacy blend. Redemption observations accept only `issuer-redemption` and `protocol-redemption` as potentially scoreable families; `eventual-redemption` must be diagnostic-only. Explicit active replay rejects future observations and live redemption evidence older than twice the 4-hour producer interval (8 hours). Reviewed `documented-terms` evidence uses a separate one-year review window. Missing modeled request, fixed clock, or eligible modeled-request observations returns an active `null` diagnostic instead of restoring legacy scores. Curated `same-stablecoin-pool-backing`, `same-protocol-liquidity`, `wrapper-to-parent-dependency`, and `unknown` correlation states veto the diversification bonus; `independent-issuer-rail` only allows the structural output and failure-domain checks to decide independence.

Severe active downside depegs add a current-exercisability gate on top of the static route score. When an open `depeg_events` row is directionally below peg with `abs(peak_deviation_bps) >= 2500`, a static, estimated, live-proxy, issuer/API, queue, or documented-bound redemption route is marked `impaired` unless it has live-direct dynamic permissionless redemption capacity with atomic or immediate settlement. Severe upside events do not automatically impair a route whose redemption still clears at par into a non-impaired output asset. For configured tracked wrappers, downside impairment now also propagates from the parent stablecoin (the coin's `variantOf`, or its `pegReferenceId` when set) as output-asset impairment when that parent has an open severe-depeg row. This prevents stale route documentation from producing a strong par-exit score while the market is indicating that broad redemption is not currently clearing.

The effective exit model parameters are surfaced by the `methodology.effectiveExitModel` field on `GET /api/redemption-backstops` and reused by report cards.

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

`outputAssets` records concrete holder-route outputs, not every reserve asset. Stable outputs use tracked stablecoin IDs; collateral outputs use canonical `asset:<symbol>` keys. Configured baskets are limited to 16 members, matching the `ExitRouteOutput.assetKeys` bound. Leave the field unset when the published route is incomplete or when its tracked and untracked members cannot all be represented: an incomplete subset must not turn an unresolved basket into a resolved one.

### July 2026 Output Reconciliation

The 2026-07-15 source pass made the following config-only evidence rulings. It did not change scoring weights or formulas.

| Route                   | Ruling                                                                                                                                                                                                                                                                           | Primary evidence                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nTBILL, nBASIS, nWISDOM | Stable basket: USDC + pUSD                                                                                                                                                                                                                                                       | [Nest available vaults](https://docs.nest.credit/about/available-vaults/)                                                                                                                   |
| nOPAL                   | Stable basket: USDC + pUSD + USDT                                                                                                                                                                                                                                                | [Nest available vaults](https://docs.nest.credit/about/available-vaults/)                                                                                                                   |
| USSD                    | Stable single: frxUSD. The deployed BrandedCustodian's `custodianTkn()` returned Sonic frxUSD and `redeemFee()` returned zero at Sonic block 75,971,769; the broader supported-USD-asset wording describes upstream/cross-chain infrastructure, not this direct holder contract. | [Sonic USSD docs](https://docs.soniclabs.com/sonic/ussd), [verified BrandedCustodian](https://sonicscan.org/address/0x54e14489646fd9693ea5071cb5dfeb1f5afa8f03#code)                        |
| USDm (`cusd-celo`)      | Stable basket: USDC + USDT, matching the direct Celo Broker/BiPoolManager counter-asset pools measured by live reserve sync.                                                                                                                                                     | [Mento V3 reserve](https://docs.mento.org/mento-v3/dive-deeper/the-reserve), [Mento V3 FPMM](https://docs.mento.org/mento-v3/dive-deeper/fpmm)                                              |
| EURm (`ceur-celo`)      | Stable single: USDm, represented by the approved tracked ID `cusd-celo`, matching the current Celo EURm/USDm counter-asset pool.                                                                                                                                                 | [Mento V3 reserve](https://docs.mento.org/mento-v3/dive-deeper/the-reserve), [Mento V3 FPMM](https://docs.mento.org/mento-v3/dive-deeper/fpmm)                                              |
| ftUSD                   | Stable basket: USDC + USDT. The current Stage 0 wrapper names both inputs and the sell flow returns the selected input asset at the prevailing rate.                                                                                                                             | [Flying Tulip ftUSD](https://docs.flyingtulip.com/product-suite/ft-usd/)                                                                                                                    |
| hyUSD                   | Fail closed with `routeStatus: unknown` and no concrete outputs. Current docs distinguish V1's SOL-only LST pool from V2's SOL/BTC/USDC pools, but do not reconcile the active tracked deployment and complete routable output set.                                              | [Hylo multi-asset architecture](https://docs.hylo.so/protocol-overview/multi-asset-architecture), [Hylo dynamic routing](https://docs.hylo.so/protocol-overview/dynamic-collateral-routing) |
| dUSD                    | Remains an unresolved basket. dTRINITY marks 11 symbols redeem-eligible across three deployments, but Katana's vbUSDC and vbUSDT have no tracked Pharos IDs. Publishing only the nine tracked economic assets would falsely claim a complete output set.                         | [dTRINITY dUSD](https://docs.dtrinity.org/protocol-components/dusd)                                                                                                                         |

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
`cUSD` now uses the live `cap-vault` onchain adapter for bounded current redemption capacity, scoring against unpaused available vault balances rather than full eventual basket redeemability.
`USD3` now uses the live `3jane-usd3` onchain adapter for fee-free, bounded USDC redemption capacity from `availableWithdrawLimit(address(0))`; credit NAV outside currently redeemable waUSDC liquidity is not scored as an immediate exit.
`LUSD` now uses the live `liquity-v1` onchain adapter for bounded current direct capacity, scoring against `TroveManager.getEntireSystemDebt()` when the 4-hourly reserve snapshot is fresh and clean rather than the old static full-supply model.
`BOLD`, `feUSD`, `USDQ`, `NECT`, and `CDP` now use the live `liquity-v2-branches` onchain adapter for bounded current direct capacity, scoring against aggregate ActivePool branch debt when the 4-hourly reserve snapshot is fresh and clean rather than the old static full-supply model. The adapter can also surface branch shutdown/sunsetting as degraded route status.
`meUSD` now uses the live `liquity-native-active-pool` onchain adapter for Mezo's native ActivePool shape, scoring against latest contract debt only when the same-run collateral, TCR/MCR, and fee telemetry is fresh and clean.
`reUSD` now uses the live `resupply-pairs` onchain adapter for bounded current direct capacity, scoring against aggregate `RedemptionHandler.getMaxRedeemableDebt(pair)` only when the same-run handler guard state shows permissionless redemptions are open. If the guard is closed above the threshold, the route is marked cohort-limited and does not uplift Safety Score liquidity.
Re Protocol `reUSD` now uses `re-metrics` instant redemption vault capacity from the official metrics payload as same-run API telemetry, retaining a reviewed fallback because redemptions above the instant vault capacity can spill to the queue.
`fxUSD` now uses f(x)'s protocol pool API debt balances as live proxy capacity, while `USDaf` uses Asymmetry's timestamped protocol supply data as direct live capacity. `JupUSD` uses Jupiter's public transparency API for current USDC/USDtb holdings and oracle route-status context, with the previous 10% reviewed buffer retained only as fallback.
M0 wrappers `wM` and `USDSC` now use `m0-wrapper-underlying` capacity telemetry from the underlying M token balance; USDSC also requires the reviewed Soneium SwapFacility and approved swapper route before emitting whitelisted-primary direct capacity.
ERC-4626 single-asset wrappers such as fxSAVE, Spark savings wrappers, sUSDS, scrvUSD, sfrxUSD, and stcUSD use the live adapter's idle underlying ERC-20 balance as current direct redemption capacity when fresh reserve telemetry is available, rather than treating the full wrapper supply as immediately executable. Vaults whose redemption is atomic and unconstrained against an external savings module — currently `sdai-sky` (legacy Sky DSR pot routing), `susdd-tron-dao-reserve` (sDAI-fork pot/join exit in the USDD v2 Maker-fork core), and `sdola-inverse-finance` (unstakes from the fully liquid DolaSavings module), each leaving the vault's idle underlying balance at ~0 despite unconstrained same-block redemption — instead set `redemptionLiquidity: { source: "atomic-full-backing" }` to score the full convertible backing (ratio 1.0) as same-run live-direct capacity. `sbold-k3-capital` and `eearn-ember` were reviewed and deliberately kept on the conservative idle probe (collateral-health withdrawal gate and operator-batched request/settle exits respectively). Reviewed Yearn V3 vault configs can use `redemptionLiquidity: { source: "yearn-v3-withdrawable" }`, which measures `totalIdle()` plus each funded default-queue strategy's `min(currentDebt, convertToAssets(maxRedeem(vault)))` from the same on-chain run; if any funded strategy probe fails, the route does not fall back to full NAV. Reviewed Morpho vault configs can additionally use Morpho V2 `liquidity` or Morpho V1 `liquidity.underlying` as same-run API capacity after validating the exact vault, underlying asset, listed status, and chain id; Morpho V2 `forceDeallocatableLiquidity` remains contextual and is not scoring capacity.
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
  - `impaired` when the route shape is known but current market or route-availability evidence contradicts broad par redemption; impaired rows have `score = null`, `effectiveExitScore = null`, and `modelConfidence = low`
- `routeStatus`:
  - `open` for normal resolved routes without current impairment evidence
  - `degraded` when the route is currently impaired by market-implied evidence such as a severe active depeg
  - `paused`, `cohort-limited`, and `unknown` are reserved for explicit route-availability sources and backward-compatible legacy rows
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

Daily history table keyed by `(stablecoin_id, snapshot_date)`.

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
- The response metadata carries `snapshotSource` (`run-rows` | `legacy-current`) so consumers can tell whether the snapshot came from immutable run rows or the run-scoped current-table fallback
- Otherwise returns the current map plus methodology metadata from `buildRedemptionBackstopsSnapshot(db)`, with `methodology.version` attributed from the latest completed run manifest or latest stored snapshot row for true legacy snapshots, and `currentVersion` preserved as the live code version
- Cache profile: `standard` (`public, s-maxage=300, max-age=60`) with freshness headers based on `updatedAt`

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Consumers

- `src/hooks/api-hooks.ts` exports `useRedemptionBackstops()`, wired through `FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops` in `src/lib/api-query-descriptors.ts` with the `CRON_RESERVE_SYNC` producer interval (4-hour reserve lane cadence)
- `src/hooks/use-stablecoin-detail-view-model.ts` fetches the map and passes the coin-specific entry into the stablecoin detail view model
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` renders the detail-page card (score badges, route family, source mode, resolution state, route status, model confidence, access/settlement/output/capacity blocks, eventual-only vs immediate-bounded capacity messaging, explicit redemption-fee summaries keyed off `feeModelKind`, reviewed docs/source context, component subscores, and contextual methodology hint / footer actions)
- `src/lib/stablecoin-detail-view-model.ts` includes redemption freshness in the detail-page stale-query rail
- `worker/src/lib/report-cards-snapshot-card.ts` injects `redemptionBackstopScore`, `redemptionRouteFamily`, and immediate-capacity fields into `rawInputs`, and `shared/lib/report-cards.ts` consumes the score in `scoreLiquidity()`
- `/coverage` consumes `useRedemptionBackstops()` through `src/lib/coverage/redemption.ts`. It distinguishes scored route-family states from low-confidence heuristic routes, resolved-but-unscored routes, configured-but-unrated routes, impaired routes, no route, and `Data n/a` feed-unavailable states, so unresolved, eventual-only, impaired, or weakly evidenced rows do not inflate public strong-coverage counts. The Redemption quick filter includes configured/resolved route states but excludes `Data n/a`.

The maintenance coverage audit requires a durable reviewed disposition for every active asset without a route config. `scripts/lib/redemption-coverage-dispositions.ts` records evidence URLs, reviewer/date, rationale, the exact blocker and evidence still needed, and a route family only when official evidence proves that family. `add` means the holder route is evidenced but configuration still needs the listed capacity/status inputs; `needs-research`, `defer`, and `hard-reject` remain legitimate coverage outcomes and do not create a scoreable route. The audit rejects stale registry rows and keeps heuristic configured routes visible until hard capacity evidence replaces them.

There is currently no dedicated list page or standalone public methodology section for redemption backstops; the primary user-facing surface is the stablecoin detail page plus the report-card liquidity dimension. Contextual hints on those surfaces currently deep-link into the Safety Scores methodology section where effective-exit logic is documented.
