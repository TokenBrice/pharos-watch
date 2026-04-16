# Redemption Backstop Safety Eligibility Implementation Plan - 2026-04-15

## Objective

Execute the five non-CDP redemption-backstop work streams needed to make eligible routes count in Safety Score Liquidity / Exit without weakening the current scoring requirements.

This is an implementation plan, not an implementation patch. Runtime code should continue to fail closed unless a route has current, bounded, non-heuristic redemption capacity.

## Research Inputs

Local sources reviewed:

- `docs/report-cards.md`
- `docs/redemption-backstops.md`
- `docs/live-reserves.md`
- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/redemption-backstop-confidence.ts`
- `shared/lib/redemption-backstop-configs/*`
- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/live-reserve-adapters-schemas.ts`
- `worker/src/lib/redemption-backstop-capacity.ts`
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/cron/reserve-adapters/*`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`

Runtime data checked:

- `https://pharos.watch/_site-data/report-cards`
- `https://pharos.watch/_site-data/redemption-backstops`

Subagent research tracks:

- Stream 1: existing live-capacity fixes
- Stream 2: issuer liquid buckets
- Stream 3: tokenized treasury liquidity
- Stream 4: onchain basket/stable redeem routes
- Stream 5: queue/strategy hot buffers

External research anchors:

- Circle Mint and redemption process: `https://www.circle.com/circle-mint`, `https://www.circle.com/blog/usdc-redemption-process-updated-to-expand-liquidity-worldwide`
- IDRX redemption docs: `https://docs.idrx.co/services/redeem-idr`
- Juno conversion docs: `https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins`
- Superstate liquidity API: `https://api.superstate.com/v1/funds/liquidity`
- M0 collateral composition: `https://docs.m0.org/api/recipes/collateral-composition/`, `https://protocol-api.m0.org/graphql`
- Ethena collateral API: `https://app.ethena.fi/api/positions/current/collateral`
- Cap vault docs: `https://docs.cap.app/concepts/vault`
- Frax balance sheet and frxUSD docs: `https://api.frax.finance/v2/frxusd/balance-sheet/latest`, `https://docs.frax.com/frxusd/mint-and-redeem-overview`
- USD.AI docs: `https://docs.usd.ai/faq/usdai-and-susdai-101`
- OpenEden instant-redemption reference pattern: `https://docs.openeden.com/usdo/usdo-token/redemption-workflow`
- Maple, Alchemix, Cygnus, Reserve, Berachain, Origin, Usual, Midas, and USDtb docs from existing route configs and subagent research.

## Current Gate To Preserve

Safety Score Liquidity / Exit uses redemption only when `isRedemptionEligibleForLiquidity()` returns true:

- `resolutionState === "resolved"`
- `score != null`
- `modelConfidence !== "low"`
- `capacitySemantics !== "eventual-only"`
- `routeStatus` is not `degraded`, `paused`, or `cohort-limited`
- during severe active depegs, the route must be `capacityConfidence === "live-direct"`, `sourceMode === "dynamic"`, `accessModel === "permissionless-onchain"`, and `settlementModel` must be `atomic` or `immediate`

Implementation guardrails:

- Do not change the gate above.
- Do not count total reserves, NAV, AUM, attestations, physical metal, or full eventual queue value as immediate capacity.
- Use `reserve-sync-metadata` only when the live reserve adapter declares redemption capacity support and emits current bounded telemetry.
- For issuer/API routes, keep `holderEligibility` as `verified-customer` or `whitelisted-primary`; do not imply any-holder exit liquidity.
- If a source is stale, warning-bearing, malformed, unmapped, or lacks scoring-grade freshness, the row must remain unrated or fall back only to non-scoring display semantics.

## Production Baseline

Latest refreshed live snapshot:

- `CUSD` (`cusd-cap`) is already eligible: `live-direct`, dynamic, immediate-bounded, about `42.3%` of supply.
- `USDe` (`usde-ethena`) is already eligible: `live-proxy`, dynamic, immediate-bounded, about `88.6%` of supply.
- `frxUSD`, `M`, `mUSD`, `USDN`, Circle assets, USTB, mTBILL, and USDtb remain excluded because the current route rows are still `eventual-only`.

Treat `CUSD` and `USDe` as regression controls in the implementation test suite.

## Shared Implementation Prerequisites

### One-Adapter-Per-Coin Constraint

The current `liveReservesConfig` model gives each coin one active reserve adapter. For any coin that already has reserve/NAV coverage, a capacity implementation must choose one of these shapes before code starts:

- extend the existing adapter so it still emits reserve/NAV slices and also emits redemption capacity
- replace the existing adapter with a composite adapter that emits both reserve/NAV slices and redemption capacity
- defer scoring until a separate sidecar capacity-feed model is designed

Do not replace reserve-quality coverage with a capacity-only adapter unless the replacement preserves report-card and detail-page reserve data.

Shared adapter caution:

- Do not make generic shared adapters capacity-capable in a way that emits capacity for every coin using that adapter.
- `chainlink-nav` is shared by multiple NAV products. Tokenized-treasury capacity work should use product-specific composite adapters such as `superstate-liquidity` or `midas-atomic-redemption`, or an explicit per-coin opt-in param with tests proving unrelated `chainlink-nav` assets emit no capacity.
- `m0` is shared by M, MUSD, USDN, and other M0 lineage/wrapper assets. M0 capacity work must add per-coin opt-in params or a split adapter key so wrappers and unrelated M0 coins do not silently inherit redemption capacity.

### Shared Types And Invariants

Do this before stream-specific work:

1. Confirm whether existing `RedemptionCapacityBasis` values are enough.
   - Use `live-proxy-buffer` for live dashboard/API buffers.
   - Use `live-direct-telemetry` for direct contract or issuer-route balances.
   - Reserve-sync live telemetry currently resolves basis from capacity confidence, so daily limits represented through live metadata will still store `live-direct-telemetry` / `live-proxy-buffer` unless resolver support is added.
   - Add `daily-limit`, `quote-limit`, or `block-limit` only when the capacity is not expressible as current live-direct/proxy telemetry, and include schema, resolver, docs, and tests in the same PR.
   - Use `daily-limit` only for daily or time-window limits. If Juno/MXNB relies on per-quote `source_max_amount`, add a new `quote-limit` basis with schema, tests, docs, and version notes before promoting it; otherwise defer Juno/MXNB.
2. Keep `redemptionTelemetry.capacity` in `shared/lib/live-reserve-adapters-definitions.ts` aligned with emitted metadata.
   - `direct`: route-native or contract-native redemption capacity.
   - `proxy`: a current liquid bucket that proxies redemption capacity.
   - `none`: no scoring-grade capacity allowed.
3. Keep `shared/lib/__tests__/redemption-backstop-consistency.test.ts` strict.
   - Every `reserve-sync-metadata` route must have a live-reserve adapter whose capacity telemetry is not `none`.
   - Every reviewed route must retain `reviewedAt` and docs.
4. Do not alter `worker/src/lib/redemption-backstop-capacity.ts` unless a new telemetry shape is required. The current resolver already consumes `metadata.redemption.capacityUsd` / `capacityRatioOfSupply`.

### Live Route Status Propagation

Before promoting any adapter that emits `metadata.redemption.routeStatus`, wire route status into redemption-backstop entries:

- extend `RedemptionBackstopLiveMetadata` in `worker/src/lib/redemption-backstop-live-metadata.ts` to expose `routeStatus`, `routeStatusReason`, and reviewed/source metadata from nested redemption telemetry
- add typed `routeStatusSource` and `routeStatusReviewedAt` fields to the live reserve redemption telemetry contract in `shared/types/live-reserves.ts` if those fields are preserved, rather than passing ad hoc metadata
- update live-reserve row decoding/validation so route-status provenance fields are parsed and rejected when malformed
- update `worker/src/lib/redemption-backstop-sources.ts` so dynamic reserve-sync rows use live route status instead of defaulting every resolved row to `config.routeStatus ?? "open"`
- if live route status is `paused`, `degraded`, or `cohort-limited`, the row must not uplift Safety Score liquidity
- add tests for paused/degraded live status in `worker/src/lib/__tests__/redemption-backstop-sources.test.ts` and `worker/src/lib/__tests__/report-cards-snapshot.test.ts`

### Shared Test Contract

Every promoted asset needs tests covering:

- fresh live capacity resolves to `resolutionState="resolved"`
- `capacitySemantics="immediate-bounded"`
- `capacityConfidence` is `live-direct` or `live-proxy`, not `heuristic`
- stale or warning-bearing metadata fails closed
- malformed capacity, negative capacity, unsupported adapter capacity, and unverified capacity are rejected
- report-card snapshot flips `redemptionUsedForLiquidity` to `true` only under eligible conditions
- severe active-depeg gate still suppresses non-live-direct/non-permissionless routes

Core test targets:

- `worker/src/cron/reserve-adapters/__tests__/*.test.ts`
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `shared/lib/__tests__/redemption-backstops.test.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
- `scripts/check-redemption-backstops.ts`

## Stream 1 - Existing Live-Capacity Fixes

### Goal

Use already-available live reserve telemetry where it meets the current gate, and leave regression controls alone.

### Assets

Positive controls:

- `cusd-cap`
- `usde-ethena`

Active blockers:

- `frxusd-frax`

Conditional only:

- `m-m0`
- `musd-metamask`
- `usdn-noble`

### Implementation Tasks

1. Preserve `CUSD` and `USDe`.
   - Do not change their config unless tests reveal drift.
   - Add regression assertions that production-equivalent rows with dynamic capacity remain Safety Score-eligible.
   - For `USDe`, do not lock in the current reserve/backing denominator as a supply-relative capacity ratio. Remove/ignore flat `metadata.immediateRedeemableRatio` for scoring or prove `readRedemptionBackstopLiveMetadata()` uses a supply-relative ratio derived from capacity USD and token supply.
   - Add an `ethena` regression for the flat/nested ratio fallback path, matching the frxUSD denominator guard.
2. Promote `frxusd-frax`.
   - Change `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` from `supply-full` to `reserve-sync-metadata`.
   - Change `frax-balance-sheet` in `shared/lib/live-reserve-adapters-definitions.ts` to `redemptionTelemetry.capacity = "proxy"` only if tests prove `stableRedeemableUsd` is current and explicitly mapped.
   - Ensure `worker/src/cron/reserve-adapters/frax.ts` does not emit reserve-total ratios as scoring ratios. Correct or remove both flat `metadata.immediateRedeemableRatio` and nested `metadata.redemption.capacityRatioOfSupply`; the resolver reads both.
   - If frxUSD supply is unavailable inside the adapter, emit only USD capacity and let the redemption resolver derive the supply ratio from the stablecoins cache.
   - Add a regression proving a flat reserve-composition ratio cannot leak through `readRedemptionBackstopLiveMetadata()`.
   - No fallback ratio in the first rollout.
3. M0 lineage remains conditional.
   - Do not globally emit M0 redemption capacity for every `m0` adapter user.
   - Do not count `CollateralCurrent` eligible collateral fields as redemption capacity unless M0 source docs/API explicitly prove those fields are currently redemption-exercisable or current exit liquidity.
   - Add an explicit per-coin opt-in param or split adapter key before changing `m0` adapter definition to `redemptionTelemetry.capacity = "proxy"`.
   - Tests must prove non-target M0 assets emit no `metadata.redemption.capacityUsd`.
   - For opted-in assets, tests must pin only the source-proven redemption-exercisable amount.
   - Fail closed for redemption capacity when `eligibleTokenCollateral` is missing; do not fall back to `totalTokenCollateral` for scoring capacity even if reserve composition can still display it.
   - Change `m-m0`, `musd-metamask`, and `usdn-noble` configs to `reserve-sync-metadata`.
   - Preserve offchain-issuer route family and cap; access stays issuer/API or whitelisted primary, not any-holder.
   - Add a unit test for the `M0_CASH_SCALE` hazard.
4. Accountable is intentionally excluded from Stream 1.
   - All Accountable promotion work belongs to Stream 5 after strict per-asset bucket allowlists and stablecoin JSON wiring exist.

### Files

- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `worker/src/cron/reserve-adapters/frax.ts`
- `worker/src/cron/reserve-adapters/m0.ts`
- `shared/lib/live-reserve-adapters-schemas.ts` for M0 per-coin opt-in params
- `shared/data/stablecoins/usd-major.json` and `shared/data/stablecoins/usd-minor.json` for M0 opt-in wiring
- `worker/src/cron/reserve-adapters/__tests__/frax.test.ts`
- `worker/src/cron/reserve-adapters/__tests__/m0.test.ts`

### Rollout

1. Regression tests for `CUSD` and `USDe`.
2. `frxUSD`.
3. M0 lineage only after source proof that the exposed fields are redemption-exercisable.

### Keep Excluded

- `frax-frax`, unless a separate route is intentionally added.
- `YUSD`, `USN`, `UTY`, `sUSDai`, and other strategy routes without explicit current buffer.

## Stream 2 - Issuer Liquid Buckets

### Goal

Move issuer/API rails from eventual-only to immediate-bounded only where a current issuer-controlled cap, daily limit, or live quote limit exists.

### Assets

Current-source candidates only:

- `usdc-circle`
- `eurc-circle`

Conditional:

- `idrx-idrx`
- `mxnb-juno`
- `usdtb-ethena`
- `xsgd-straitsx` / `xusd-straitsx` only if swap cap maps to issuer redemption, not secondary swap.

Keep excluded for now:

- `fdusd-first-digital`
- `eurcv-societe-generale-forge`
- `usdcv-societe-generale-forge`
- `usdp-paxos`
- `pyusd-paypal`
- `gusd-gemini`
- `usdt-tether`
- `rlusd-ripple`
- VNX, StablR, Quantoz, Monerium, Brale, Banking Circle, and similar issuers unless a current-cap source appears.

### Implementation Tasks

1. Circle current-cap adapter.
   - Extend `circle-transparency` or replace it with a composite Circle adapter; do not add a capacity-only second adapter under the current one-adapter-per-coin model.
   - Source capacity from the documented current Circle Mint redemption limits, not reserve composition.
   - If a machine-readable current source exists, emit `capacityKind="live-direct-bounded"`, `holderEligibility="verified-customer"`, and timestamp/freshness metadata. Store the daily-limit context in adapter metadata/notes unless resolver support for a true `daily-limit` live basis is added first.
   - If the only source is static docs, keep Circle display-only for redemption capacity. Do not add a documented-capacity fallback in this execution plan.
2. IDRX.
   - Add an issuer capacity adapter only if the official docs/API expose current real-time / office-hours limits through a machine-readable current source.
   - If the only source is stable docs, keep IDRX display-only unless a deliberate non-live capacity model/basis, docs, and tests are added in a separate methodology change.
   - Convert IDR limits to USD using the existing FX rate infrastructure only if needed for capacity scoring; otherwise emit ratio only if supply and FX are in the same pass.
3. Juno / MXNB.
   - If the conversion API returns `source_min_amount` / `source_max_amount`, write a small `juno-conversion-capacity` adapter.
   - Treat quote caps as issuer/API verified-customer capacity, not any-holder liquidity.
   - Do not reuse `daily-limit` for per-quote caps. Implement `quote-limit` across `shared/types/redemption.ts`, `worker/src/lib/redemption-backstop-capacity.ts` basis resolution if needed, docs, and tests, or defer Juno/MXNB.
   - If `quote-limit` is implemented, update `shared/lib/redemption-backstop-version.ts`, `docs/redemption-backstops.md`, `docs/report-cards.md`, `docs/report-cards-timeline.md`, and `docs/api-reference.md` in the same PR.
4. USDtb.
   - Treat `usdtb-ethena` as an issuer/API RFQ rail, not a tokenized-treasury/NAV stream item.
   - Add `usdtb-rfq` or extend the existing Ethena USDtb reserve path while preserving current reserve proof.
   - Include `worker/src/cron/reserve-adapters/jupusd.ts` in the impact review because JupUSD consumes USDtb as a collateral slice and already has USDtb-specific reserve handling.
   - Model per-asset max mint/redeem per block plus global max per block as bounded current capacity only if current limits are machine-readable and a `block-limit` basis is added across `shared/types/redemption.ts`, `worker/src/lib/redemption-backstop-capacity.ts`, docs, and tests. Otherwise defer USDtb.
   - Treat this as RFQ/admin-controlled issuer capacity, not permissionless liquidity.
5. StraitsX.
   - Research whether the 200K cap applies to the mint/redeem rail.
   - If it is only a secondary swap feature, reject it for Safety Score capacity.
6. FDUSD / SG-FORGE.
   - Keep existing transparency adapters for reserve quality.
   - Do not emit Safety Score capacity from cash reserve totals unless the issuer publishes current redeemable cash or a hard redemption capacity/limit.

### Files

- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/live-reserve-adapters-schemas.ts`
- `shared/types/live-reserves.ts` for new adapter keys
- `worker/src/cron/reserve-adapters/index.ts`
- `worker/src/cron/reserve-adapters/circle-transparency.ts` or a composite Circle replacement
- possible new `idrx-redemption-capacity.ts`
- possible new `juno-conversion-capacity.ts`
- possible new `worker/src/cron/reserve-adapters/usdtb-rfq.ts`
- `worker/src/cron/reserve-adapters/jupusd.ts` for USDtb collateral-consumer compatibility checks
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/types/redemption.ts` if `quote-limit` or `block-limit` is implemented
- `worker/src/lib/redemption-backstop-capacity.ts` if `quote-limit` or `block-limit` needs explicit basis resolution
- `shared/data/stablecoins/usd-major.json` for `usdtb-ethena` live reserve config wiring
- stablecoin JSON entries only if a new live reserve adapter is added

### Rollout

1. Circle only if a machine-readable current capacity source is confirmed; otherwise leave `USDC`/`EURC` display-only for redemption capacity.
2. IDRX.
3. Juno / MXNB only with `quote-limit` basis work, otherwise defer.
4. USDtb.
5. StraitsX only after source mapping.
6. Leave the rest unchanged.

## Stream 3 - Tokenized Treasury / NAV Liquidity Facilities

### Goal

Use current liquidity-facility data where available. Do not use NAV/AUM as capacity.

### Green-Light Assets

- `ustb-superstate`

### Conditional Assets

- `mtbill-midas`
- `usyc-hashnote`
- `ousg-ondo-finance`

### Keep Excluded

- `buidl-blackrock`
- `tbill-openeden`
- `ylds-figure`
- `thbill-theo`
- `cetes-etherfuse`
- `usdy-ondo-finance`

### Implementation Tasks

1. USTB / Superstate.
   - Add a product-specific composite `superstate-liquidity` adapter; do not change generic `chainlink-nav` capacity behavior for all NAV products.
   - Preserve NAV/reserve slices from current coverage while adding capacity.
   - Read `https://api.superstate.com/v1/funds/liquidity`.
   - For USTB, capacity is current available Circle USD plus USDC redemption idle balance, if both fields are present and numeric.
   - Emit `live-proxy` or `live-direct` only after deciding whether the API represents direct user redemption or facility liquidity. Default to `proxy`.
   - Fail closed if the endpoint loses fields or lacks a trustworthy freshness marker. If no timestamp exists, treat this as a release blocker unless the methodology explicitly accepts the endpoint as latest-state operational data with `not-applicable` freshness.
2. mTBILL / Midas.
   - Conditional only: do not implement until the exact endpoint/contract, freshness marker, and fields for the bounded redemption pool are named.
   - If confirmed, add a product-specific composite `midas-atomic-redemption` adapter; do not change generic `chainlink-nav` capacity behavior for all NAV products.
   - Preserve NAV/reserve slices while adding capacity.
   - Emit only the current bounded pool, not NAV or docs-derived target liquidity.
   - Keep access as whitelisted/institutional if that matches product terms.
3. USYC and OUSG.
   - Research for stable machine-readable current capacity before coding.
   - If only NAV, same-day redemption terms, or instant-manager mechanics are available, keep excluded.
4. Explicit non-goals.
   - Do not promote BUIDL, TBILL, YLDS, thBILL, CETES, or USDY until current liquidity capacity is available.

### Files

- new/composite `worker/src/cron/reserve-adapters/superstate-liquidity.ts`
- new/composite `worker/src/cron/reserve-adapters/midas-atomic-redemption.ts`
- maybe `hashnote-usyc.ts`
- maybe `ondo-instant-manager.ts`
- `shared/types/live-reserves.ts` for new adapter keys
- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/live-reserve-adapters-schemas.ts`
- `worker/src/cron/reserve-adapters/index.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/data/stablecoins/usd-minor.json` for `ustb-superstate` and `mtbill-midas` live reserve config wiring

### Rollout

1. USTB.
2. mTBILL only after exact source fields are confirmed.
3. USYC only after endpoint confirmation.
4. OUSG only after endpoint confirmation.

## Stream 4 - Onchain Basket / Stable Redeem Routes

### Goal

For onchain routes, read actual redeemable output balances, contract caps, route status, and fees. Full-system redeemability is not enough.

### Existing Path Extension

1. Celo `cUSD` / `CEUR`.
   - `mento` already emits `immediateRedeemableRatio` and `redemption.capacityRatioOfSupply`.
   - Do not promote by config wiring alone. Current Mento ratio is a stable-asset reserve-composition percentage, while redemption scoring interprets ratios as token-supply capacity.
   - Promote only after the adapter emits supply-relative current USD capacity or a correctly supply-relative ratio, with `redemptionTelemetry.capacity` changed from `none` to `proxy` and tests proving the denominator.
   - Until then, keep both configs on `supply-full` / eventual-only.
   - Keep output as mixed collateral if output is not a single stable asset.

### New Adapter Work

1. Reserve Protocol RToken adapter for `eusd-electronic-usd` (`EUSD`).
   - Read basket composition, backing manager balances, pause/default state, issuance/redeem throttles, and fees.
   - Emit capacity as the current redeemable basket lower bound after any throttle/cap.
   - Keep output asset quality as stable-basket/mixed-collateral.
   - If this replaces existing reserve coverage, preserve reserve composition slices and dependency links.
2. Berachain Honey adapter for `honey-berachain` (`HONEY`).
   - Do not model HONEY as a Reserve Protocol RToken.
   - Read Berachain Honey mint/redeem vault state, basket collateral balances, mint/redeem caps, basket mode/stress state, and fees from the Berachain-specific source path.
   - Keep route family as `basket-redeem` and output quality as stable-basket/mixed-collateral according to actual output.
3. Origin OUSD adapter.
   - Use Origin collateral/strategy/stats endpoints and direct route status.
   - Capacity is current immediately withdrawable vault liquidity, not total strategy assets.
   - Preserve reserve composition semantics if this becomes the active OUSD live reserve adapter.
4. USD.AI base USDai adapter.
   - Keep `usdai-proof-of-reserves` for `sUSDai`; do not reuse it for base USDai.
   - Add `usdai-redemption` only if the app/API or contracts expose current redeemable stablecoin capacity.
5. Usual USD0 adapter.
   - Read `DaoCollateral`, `SwapperEngine`, collateral provider balances, route caps, minimum order constraints, and emergency state.
6. Frax FPI adapter.
   - Read controller-pool balance, CPI/oracle freshness, route state, and fee.
   - Do not model FPI as a dollar stablecoin; capacity should be CPI/NAV-specific.

### Research-Gated Assets

Keep out until current-capacity sources are confirmed:

- `apxusd-apyx`
- `usx-solstice`
- `msusd-main-street`
- `u-united-stables`
- `aid-gaib`

### Files

- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/collateral-redeem.ts`
- `shared/data/stablecoins/usd-minor.json` for `eusd-electronic-usd` and `honey-berachain` live reserve config wiring
- `shared/data/stablecoins/usd-major.json` for `usd0-usual` and `usdai-usd-ai` live reserve config wiring
- `shared/data/stablecoins/non-usd.json` for `fpi-frax` live reserve config wiring if FPI gets a live adapter
- `worker/src/cron/reserve-adapters/mento.ts`
- new `reserve-r-token.ts`
- new `berachain-honey.ts`
- new `origin-ousd.ts`
- new `usdai-redemption.ts`
- new `usual-usd0.ts`
- new `frax-fpi-redemption.ts`
- `shared/types/live-reserves.ts` for new adapter keys
- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/live-reserve-adapters-schemas.ts`
- `worker/src/cron/reserve-adapters/index.ts`

### Rollout

1. `eusd-electronic-usd` (`EUSD`).
2. `honey-berachain` (`HONEY`).
3. `USD0`.
4. `OUSD`.
5. `USDai`.
6. `FPI`.
7. Celo `cUSD` / `CEUR` only after Mento emits supply-relative current capacity.
8. Research-gated routes only after source confirmation.

## Stream 5 - Queue / Strategy Hot Buffers

### Goal

Use only explicit hot-buffer or queue-state telemetry. Do not use strategy NAV, total reserves, or full queued amount.

### Candidates

Potentially viable after live payload validation:

- `nusd-neutrl`
- `yzusd-yuzu`
- `aznd-mu-digital`

Keep excluded now:

- `susdai-usd-ai`
- `rwausdi-multipli`
- `dusd-dtrinity`
- `alusd-alchemix`
- `yousd-yield-optimizer`
- `cgusd-cygnus-finance`
- `avusd-avant`
- `syrupusdc-maple`
- `syrupusdt-maple`
- `yusd-aegis`
- `usn-noon`
- `uty-xsy`

### Implementation Tasks

1. Accountable strict capacity mode.
   - Extend `accountable` params with an explicit `redemptionCapacityBuckets` or similar allowlist.
   - Capacity can be emitted only from exact bucket names configured per asset and independently documented or labeled by the source as current redemption liquidity, withdrawal buffer, or queue capacity.
   - Liquid reserve composition labels alone, such as `Stablecoin` or `Short Term Cash`, are not sufficient unless the source ties them to current redeemability.
   - Unknown or unmapped buckets must degrade or suppress capacity.
   - Change `accountable` adapter definition to `capacity="proxy"` only when strict capacity mode exists.
2. Candidate validation.
   - Inspect live payloads for `NUSD`, `YZUSD`, and `AZND`.
   - Promote only assets whose payload/docs expose a distinct liquid sleeve explicitly tied to redemption availability, such as a named liquidity buffer or claimable withdrawal pool.
3. Maple.
   - Do not promote from docs alone.
   - Future adapter must read withdrawal manager / pool liquidity / queue state.
4. Alchemix.
   - Future adapter must read Transmuter claimable underlying and queued conversion state.
5. Cygnus.
   - Future adapter must read current USDC redemption pool, NFT queue state, and fee.
6. USD.AI `sUSDai`.
   - Stay excluded until public instant buffer exists.

### Files

- `worker/src/cron/reserve-adapters/accountable.ts`
- `shared/types/live-reserves.ts` if new adapter params require key/schema type updates
- `shared/lib/live-reserve-adapters-schemas.ts`
- `shared/lib/live-reserve-adapters-definitions.ts`
- `shared/lib/redemption-backstop-configs/queue-redeem.ts`
- `shared/data/stablecoins/usd-minor.json` for `nusd-neutrl`, `yzusd-yuzu`, and `aznd-mu-digital` per-asset Accountable capacity-bucket allowlists
- `worker/src/cron/reserve-adapters/__tests__/accountable.test.ts`
- future `maple-withdrawal-queue.ts`
- future `alchemix-transmuter.ts`
- future `cygnus-redemption-queue.ts`

### Rollout

1. Accountable strict capacity mode.
2. Promote `NUSD`, `YZUSD`, and `AZND` only if payload validation passes.
3. Leave all other queue/strategy assets excluded.
4. Add future adapters only after source confirmation.

## Cross-Stream Rollout Plan

Phase 0 - Safety harness:

- Add tests that pin `CUSD` and `USDe` as eligible positive controls.
- Add tests that pin `USDC` / `frxUSD` / `M` as excluded until their stream changes land.
- Add validation tests for unsupported capacity telemetry.

Phase 1 - Low-risk existing telemetry:

- `frxUSD`
- M0 lineage only after source proof that exposed fields are redemption-exercisable

Phase 2 - Current issuer/API limits:

- Circle `USDC`, `EURC` only if a machine-readable current capacity source is confirmed
- IDRX if confirmed
- Juno/MXNB only after `quote-limit` basis work or explicit deferral
- USDtb issuer/RFQ route only after machine-readable limits plus `block-limit` basis work, otherwise defer

Phase 3 - Tokenized treasury facilities:

- USTB
- mTBILL only after exact bounded-pool source fields are confirmed

Phase 4 - Onchain protocol adapters:

- Reserve RToken: `eusd-electronic-usd` (`EUSD`)
- Berachain Honey: `honey-berachain` (`HONEY`)
- USD0
- OUSD
- USDai
- FPI

Phase 5 - Queue/strategy strict buffers:

- Accountable strict mode
- NUSD / YZUSD / AZND if confirmed
- Defer Maple, Alchemix, Cygnus, USD.AI sUSDai until source availability improves.

## Documentation And Methodology Updates

Because this changes Safety Score behavior, implementation PRs must update:

- `docs/redemption-backstops.md`
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/live-reserves.md`
- `docs/worker-infrastructure.md`
- `docs/api-reference.md`
- `docs/about-page.md` when adding a new source that changes about-page source copy
- `src/app/methodology/scoring-changelog/content-v7-0.tsx` or the current Safety Score changelog content module
- `shared/lib/redemption-backstop-version.ts`
- `shared/lib/safety-score-version-data.ts` if Safety Score version notes need a new entry
- `src/app/about/page.tsx` if a new data source is added

Versioning:

- Redemption backstop version should increment from the current value in `shared/lib/redemption-backstop-version.ts`; as of this plan, that value is `v3.93`, so the next minor label is likely `v3.94` unless the implementation warrants a major methodology bump.
- Safety Score version changes only if published score behavior changes; if it changes, follow the repo rule: after `v7.01`, use `v7.02` or similar numeric progression, not semver assumptions.

## Validation Commands

Focused validation per stream:

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__/frax.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/m0.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/accountable.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/cap-vault.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/ethena.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/mento.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/usdai-proof-of-reserves.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/registry.test.ts
npm test -- worker/src/cron/__tests__/reserve-adapter-validate.test.ts
npm test -- worker/src/lib/__tests__/live-reserves-store.test.ts
npm test -- worker/src/lib/__tests__/redemption-backstop-sources.test.ts
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts
npm test -- shared/lib/__tests__/redemption-backstops.test.ts
npm test -- shared/lib/__tests__/redemption-backstop-consistency.test.ts
npm run check:redemption-backstops
npm run check:stablecoin-data
npm run check:doc-sync
cd worker && npx tsc --noEmit
```

Each new adapter must add a dedicated test file before merge. Depending on which candidates pass source confirmation, the implementation PR must add and run the matching subset:

```bash
npm test -- worker/src/cron/reserve-adapters/__tests__/superstate-liquidity.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/midas-atomic-redemption.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/usdtb-rfq.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/jupusd.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/idrx-redemption-capacity.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/juno-conversion-capacity.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/reserve-r-token.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/berachain-honey.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/origin-ousd.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/usdai-redemption.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/usual-usd0.test.ts
npm test -- worker/src/cron/reserve-adapters/__tests__/frax-fpi-redemption.test.ts
```

If a candidate is deferred, its test file is not required, but the PR must include a note explaining the source blocker.

Pre-push validation:

```bash
npm run test:merge-gate
```

## Execution Risks

| Risk | Mitigation |
| --- | --- |
| Counting total reserves as immediate capacity | Every adapter must explicitly identify the redeemable bucket/cap; tests should reject total reserve fallback |
| Adapter emits capacity but definition says `none` | Keep `redemption-backstop-consistency` strict and add adapter validation tests |
| Stale API looks current | Require source timestamps where available; for latest-state APIs without timestamps, explicitly document and test freshness semantics |
| Overstating issuer/API access as any-holder | Preserve `holderEligibility` and access model from config |
| Severe depeg false uplift | Keep current severe-depeg live-direct permissionless gate unchanged |
| Shared adapter accidentally promotes unrelated assets | Add opt-in params such as `redemptionCapacityBuckets`; no broad regex scoring |
| D1 snapshot and Pages build drift | Deploy adapter/config changes together, run redemption sync before judging report-card effects |

## Deferred Items

These are intentionally outside the first execution batch:

- Commodity token cash facilities.
- CDP stablecoins already being researched elsewhere.
- NAV-only tokenized treasuries without current liquidity facilities.
- Queue assets whose only evidence is eventual FIFO settlement.
- Broad scoring methodology changes.

## Implementation Status

Completed:

- Shared live route-status propagation guardrail.
- Shared live-capacity ratio guardrail so nested `capacityUsd` does not reuse flat reserve-composition ratios.
- frxUSD live Frax balance-sheet capacity, with reserve-total ratios removed from scoring telemetry.
- USTB product-specific Superstate liquidity adapter, preserving NAV reserve slices while using current Circle USD + USDC RedemptionIdle liquidity as bounded capacity.
- Methodology/version updates through redemption-backstop `v3.95` and Safety Score `v7.03`.

Deferred by plan gate:

- M0 lineage until a source proves exposed collateral fields are currently redemption-exercisable.
- Circle, IDRX, Juno/MXNB, USDtb, and StraitsX until machine-readable current capacity or the required new `quote-limit` / `block-limit` basis work exists.
- mTBILL, USYC, and OUSG until exact current bounded-liquidity source fields are confirmed.
- EUSD, HONEY, USD0, OUSD, USDai, FPI, and other onchain adapters until their contract/API capacity sources are mapped and implemented.
- Accountable-backed queue/strategy routes until source-labeled current redemption liquidity buckets and per-asset allowlists exist.

## Review Loop Log

### Review Pass 1

Reviewer result: 2 major issues.

- Major: Circle section mixed live-direct telemetry with static documented daily-limit semantics.
- Major: validation commands did not explicitly require tests for new adapters.

Fixes applied:

- Circle now requires either a machine-readable/current source for `reserve-sync-metadata` live-direct telemetry, or a separate documented absolute-capacity model before static docs can score. Static docs must not masquerade as dynamic live capacity.
- Added explicit adapter-test requirements for every proposed new parser/capacity path.
- Added the local-review one-adapter-per-coin constraint and composite-adapter requirement for Circle, tokenized treasury/NAV, and onchain routes.

### Review Pass 2

Reviewer result: 2 major issues, 2 minor issues.

- Major: version bump instruction was stale because the repo is already at redemption backstop `v3.93`.
- Major: plan did not explicitly guard against capacity changes bleeding through shared adapters such as `chainlink-nav` and `m0`.
- Minor: doc-update list omitted `docs/report-cards-timeline.md`.
- Minor: validation list omitted `worker/src/cron/__tests__/reserve-adapter-validate.test.ts`.

Fixes applied:

- Versioning now references the live current version in `shared/lib/redemption-backstop-version.ts`, with `v3.94` as the likely next minor label from current `v3.93`.
- Added shared-adapter cautions and per-coin opt-in/split-adapter requirements for `chainlink-nav` and `m0`.
- Added `docs/report-cards-timeline.md`.
- Added `reserve-adapter-validate.test.ts` to focused validation.

### Review Pass 3

Reviewer result: 1 major issue, 2 minor issues.

- Major: Stream 4 used symbols `EUSD` / `HONEY` without canonical route IDs.
- Minor: USDtb path did not mention `worker/src/cron/reserve-adapters/jupusd.ts`, which consumes USDtb as collateral.
- Minor: doc-update list omitted `docs/worker-infrastructure.md`.

Fixes applied:

- Stream 4 now names `eusd-electronic-usd` and `honey-berachain` explicitly, with symbols only as labels.
- USDtb Stream 3 now includes `jupusd.ts` impact review and `jupusd.test.ts`.
- Added `docs/worker-infrastructure.md`.

### Review Pass 4

Reviewer result: 1 major issue, 2 minor issues.

- Major: Circle still allowed a static-doc documented absolute-capacity fallback, which conflicted with fail-closed source freshness rules.
- Minor: Stream 4 did not list stablecoin JSON wiring for `eusd-electronic-usd` / `honey-berachain`.
- Minor: Stream 5 did not list stablecoin JSON wiring for Accountable strict-capacity bucket allowlists.

Fixes applied:

- Circle now stays display-only unless a machine-readable current capacity source exists; documented static-cap fallback was removed from this execution plan.
- Added `shared/data/stablecoins/usd-minor.json` wiring for `eusd-electronic-usd` and `honey-berachain`.
- Added `shared/data/stablecoins/usd-minor.json` wiring for `nusd-neutrl`, `yzusd-yuzu`, and `aznd-mu-digital` Accountable bucket allowlists.

### Review Pass 5

Reviewer result: 1 major issue, 1 minor issue.

- Major: Stream 4 incorrectly grouped `honey-berachain` with Reserve Protocol RTokens.
- Minor: Juno/MXNB quote-cap basis was unresolved.

Fixes applied:

- Stream 4 now separates `eusd-electronic-usd` into `reserve-r-token` and `honey-berachain` into a Berachain-specific Honey adapter.
- Added `berachain-honey.test.ts` to required tests.
- Juno/MXNB now requires a new `quote-limit` basis path, with schema/docs/tests/version work, or deferral. It must not reuse `daily-limit`.

### Review Pass 6

Reviewer result: 2 major issues, 1 minor issue.

- Major: `quote-limit` basis work did not explicitly include required methodology/public docs.
- Major: USDtb was still grouped under tokenized treasury instead of issuer/RFQ.
- Minor: M0 capacity plan did not explicitly fail closed when `eligibleTokenCollateral` is missing.

Fixes applied:

- Juno/MXNB `quote-limit` now requires `shared/types/redemption.ts`, `worker/src/lib/redemption-backstop-capacity.ts`, `shared/lib/redemption-backstop-version.ts`, `docs/redemption-backstops.md`, `docs/report-cards.md`, `docs/report-cards-timeline.md`, and `docs/api-reference.md`, or deferral.
- USDtb moved to Stream 2 issuer/API limits and removed from Stream 3 tokenized treasury rollout.
- M0 now explicitly fails closed for redemption capacity when `eligibleTokenCollateral` is missing; it must not fall back to `totalTokenCollateral` for scoring capacity.

### Review Pass 7

Reviewer result: 2 major issues, 1 minor issue.

- Major: Stream 2 asked for daily/block capacity shapes not safely expressible by current basis/resolver behavior.
- Major: file lists omitted stablecoin JSON wiring for `usdtb-ethena`, `ustb-superstate`, and `mtbill-midas`.
- Minor: Juno `quote-limit` note pointed to `shared/lib/redemption-backstop-confidence.ts` instead of the actual resolver path.

Fixes applied:

- Shared basis section now says live reserve metadata resolves to `live-direct-telemetry` / `live-proxy-buffer` unless resolver support is added.
- Juno/MXNB requires `quote-limit` basis work in `shared/types/redemption.ts`, `worker/src/lib/redemption-backstop-capacity.ts`, docs, and tests, or deferral.
- USDtb requires `block-limit` basis work in `shared/types/redemption.ts`, `worker/src/lib/redemption-backstop-capacity.ts`, docs, and tests, or deferral.
- Added `shared/data/stablecoins/usd-major.json` for `usdtb-ethena`.
- Added `shared/data/stablecoins/usd-minor.json` for `ustb-superstate` and `mtbill-midas`.

### Review Pass 8

Reviewer result: 1 major issue, 2 minor issues.

- Major: validation section omitted existing regression/control tests for `cap-vault`, `ethena`, `mento`, and `usdai-proof-of-reserves`.
- Minor: Mento prerequisite needed correction; follow-up review later found config-only promotion was still unsafe because the emitted ratio was reserve-composition based.
- Minor: Circle rollout still read as guaranteed even though Circle must remain display-only unless a current machine-readable source is confirmed.

Fixes applied:

- Added focused validation commands for `cap-vault.test.ts`, `ethena.test.ts`, `mento.test.ts`, and `usdai-proof-of-reserves.test.ts`.
- Initial Mento wording was adjusted in this pass, then superseded in Review Pass 9 by deferring Celo/Mento until the adapter emits supply-relative current capacity.
- Renamed Circle from "green-light first" to current-source candidate and made rollout conditional on a current capacity source.

### Review Pass 9

Reviewer result: 3 major issues, 2 minor issues.

- Major: live `routeStatus` telemetry was planned but not wired into redemption-backstop entries/scoring.
- Major: Celo/Mento plan contradicted current code and would have interpreted reserve-composition ratio as token-supply capacity.
- Major: frxUSD ratio guard did not cover both nested and flat ratio fields.
- Minor: IDRX source standard allowed stable docs where current source evidence was required.
- Minor: new adapter key and M0 opt-in file prerequisites were incomplete.

Fixes applied:

- Added shared live route-status propagation prerequisite covering `redemption-backstop-live-metadata.ts`, `redemption-backstop-sources.ts`, and paused/degraded tests.
- Celo/Mento is now deferred unless Mento emits supply-relative current capacity; removed it from low-risk rollout.
- frxUSD now explicitly requires correcting or removing both `metadata.immediateRedeemableRatio` and `metadata.redemption.capacityRatioOfSupply`, with a flat-fallback regression.
- IDRX now requires a machine-readable current source; stable docs stay display-only unless a separate methodology/model change is added.
- Added `shared/types/live-reserves.ts`, M0 opt-in params/schema/stablecoin JSON wiring, and worker type-check validation.

### Review Pass 10

Reviewer result: 3 major issues, 3 minor issues.

- Major: Accountable promotion was split between Stream 1 and Stream 5, allowing unsafe promotion before strict bucket allowlists.
- Major: `mtbill-midas` was green-lit without a named current capacity endpoint/contract and fields.
- Major: `USDe` positive-control tests could preserve a reserve/backing denominator ratio hazard.
- Minor: route-status provenance fields were underspecified.
- Minor: adapter registry completeness test was missing.
- Minor: review log still had stale Mento wording.

Fixes applied:

- Accountable promotion now belongs only to Stream 5 after strict `redemptionCapacityBuckets` and JSON allowlists.
- `mtbill-midas` moved to conditional until the exact bounded-pool source contract/endpoint, freshness marker, and fields are named.
- `USDe` now has the same flat/nested ratio-denominator guard as frxUSD.
- Live route-status propagation now calls out typed `routeStatusSource` and `routeStatusReviewedAt` fields plus row decoder/validation updates.
- Added `worker/src/cron/reserve-adapters/__tests__/registry.test.ts`.
- Corrected the Mento review-log wording.

### Review Pass 11

Reviewer result: 3 major issues, 3 minor issues.

- Major: M0 eligible collateral fields were being treated as capacity without proof they are redemption-exercisable.
- Major: Accountable strict allowlists still allowed liquid reserve composition labels without proving current redemption liquidity.
- Major: Stream 4 omitted JSON wiring for `usd0-usual`, `usdai-usd-ai`, and `fpi-frax`.
- Minor: cross-stream rollout dropped conditional gates for Circle, USDtb, and mTBILL.
- Minor: validation omitted live-reserve row decoding/store coverage for route-status provenance.
- Minor: docs checklist omitted `docs/about-page.md`.

Fixes applied:

- M0 lineage is now conditional until the source proves exposed fields are redemption-exercisable/current exit liquidity.
- Accountable capacity buckets must be source-labeled or independently documented as current redemption liquidity, withdrawal buffer, or queue capacity.
- Added `shared/data/stablecoins/usd-major.json` for `usd0-usual` / `usdai-usd-ai` and `shared/data/stablecoins/non-usd.json` for `fpi-frax`.
- Repeated conditional gates in cross-stream rollout for Circle, USDtb, and mTBILL.
- Added `worker/src/lib/__tests__/live-reserves-store.test.ts`.
- Added `docs/about-page.md`.

### Review Pass 12

Not run. User accepted the post-pass-11 fixes as sufficient and directed implementation to begin.
