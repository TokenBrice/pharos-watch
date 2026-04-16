# Redemption Backstop Adapter-First Scoring Tightening Rollout Plan

Date: 2026-04-15

## Purpose

Tighten Redemption Backstop scoring without creating avoidable score cliffs. The goal is not to preserve every current score. The goal is to preserve every score that can be backed by current, defensible redemption evidence, and to make any remaining score losses methodologically justified.

This plan pairs scoring cleanup with a major adapter/probe expansion so routes can graduate from static eventual assumptions into current evidence tiers before Safety Score eligibility is tightened.

Detailed protocol research for every named adapter candidate and broader upgrade target is captured in `agents/research/2026-04-15-redemption-backstop-adapter-upgrade-research.md`. Treat that dossier as the source list for implementation tickets.

## Assumptions

- Redemption Backstops now materially affect Safety Scores; changes require methodology version bumps and docs updates.
- The biggest current risk is not standalone route visibility. It is letting eventual-only or proxy capacity behave like immediate executable liquidity in Safety Score Liquidity / Exit.
- Adapter work should precede final scorer tightening.
- Public, machine-readable, or onchain evidence is preferred. Narrative docs alone can support route visibility, but not high Safety Score liquidity uplift.
- Any new data source must update docs/about-page data-source language when it becomes production-used.

## Success Criteria

1. Every Safety Score redemption uplift can explain:
   - whether capacity is direct, queued, proxy, or documented-only
   - current route status
   - holder eligibility
   - settlement delay / queue constraints
   - freshness proof
   - capacity ratio denominator
2. Dynamic/proxy adapter outputs are validated before persistence.
3. Redemption snapshots are generation-consistent; report cards never consume mixed-generation rows as fresh.
4. High-impact routes get adapter/probe upgrades first, especially where strict scoring would otherwise create large losses.

## Current Baseline

Live data sampled during planning:

- `/ _site-data/redemption-backstops`: 147 rows, methodology `v3.8`, `updatedAt = 1776244570`
- `/ _site-data/report-cards`: 268 rows, methodology `v6.98`, `redemptionStale = false`, `liquidityStale = false`

Current route shape:

- 122 rows are `eventual-only`
- 25 rows are `immediate-bounded`
- 6 rows are live dynamic reserve-sync capacity
- 2 rows are reserve-sync fallback
- 1 reserve-sync row is currently unresolved

Largest current exposure:

- The broad score-risk bucket is `eventual-only | supply-full | estimated`.
- The concentrated adapter-risk bucket is reserve-sync proxy/fallback: `dai-makerdao`, `usds-sky`, `iusd-infinifi`, `usdf-falcon`, `usde-ethena`, `wsrusd-reservoir`.
- Positive-control direct live routes are `gho-aave` and `zchf-frankencoin`.

## Rollout Principle

Use a two-layer model:

1. **Route quality**: how credible the redemption route is in general.
2. **Safety Score exit eligibility**: how much current, executable exit capacity should uplift Liquidity / Exit.

This avoids deleting legitimate redemption routes while preventing long-dated, issuer-mediated, queued, or proxy routes from acting like immediate liquidity.

## Proposed Evidence Tiers

Add a normalized redemption telemetry model. These names can be refined during implementation, but the scorer needs this semantic distinction.

```ts
type RedemptionCapacityKind =
  | "live-direct"
  | "live-direct-bounded"
  | "live-queue"
  | "live-proxy-validated"
  | "documented-bound"
  | "documented-eventual"
  | "heuristic";

type RedemptionFreshnessKind =
  | "verified-source-timestamp"
  | "same-run-onchain"
  | "same-run-api"
  | "reviewed-static"
  | "unverified";

type RedemptionRouteAvailability =
  | "open"
  | "degraded"
  | "paused"
  | "cohort-limited"
  | "unknown";
```

Telemetry fields to normalize:

- `capacityUsd`
- `capacityRatioOfSupply`
- `capacityKind`
- `capacityBasis`
- `freshnessKind`
- `sourceTimestamp`
- `blockNumber`
- `routeStatus`
- `routeStatusSource`
- `routeStatusReason`
- `holderEligibility`
- `settlementDelaySec`
- `queueDepthUsd`
- `dailyLimitUsd`
- `minRedeemUsd`
- `feeBps`
- `feeKind`
- `sourceUrls`

## Phase 0 - Snapshot Generation Integrity

This is correctness infrastructure and should ship before scoring changes.

### Work

1. Add a backward-compatible migration:
   - `redemption_backstop.snapshot_run_id` nullable
   - `redemption_backstop_history.snapshot_run_id` nullable
   - new `redemption_backstop_runs` table:
     - `run_id`
     - `started_at`
     - `completed_at`
     - `status`
     - `expected_count`
     - `written_count`
     - `methodology_version`
     - `min_updated_at`
     - `max_updated_at`
     - `metadata_json`

2. Update sync:
   - generate `run_id` at start
   - write all current/history rows with `run_id`
   - insert completed manifest only after all row batches and pruning succeed
   - if run fails mid-write, do not mark completed

3. Update readers:
   - prefer latest completed `run_id`
   - filter current rows to that run
   - fallback to legacy `MAX(updated_at)` only while migration backfills

4. Add status metadata:
   - current completed run age
   - expected vs written rows
   - mixed generation detection

### Files

- `worker/migrations/*_redemption_backstop_runs.sql`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`

### Acceptance

- Current reader cannot treat partial row writes as a fresh complete snapshot.
- Legacy rows still serve during migration.
- `npm run check:migrations` passes.

## Phase 1 - Telemetry Contract And Validation

Do this before upgrading adapters.

### Work

1. Extend live-reserve metadata schema with nested redemption telemetry, keeping legacy flat fields during transition:

```ts
metadata.redemption = {
  capacityUsd?: number;
  capacityRatioOfSupply?: number;
  capacityKind: RedemptionCapacityKind;
  freshnessKind: RedemptionFreshnessKind;
  sourceTimestamp?: number;
  blockNumber?: number;
  routeStatus?: RedemptionRouteAvailability;
  holderEligibility?: RedemptionHolderEligibility;
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  dailyLimitUsd?: number;
  minRedeemUsd?: number;
  feeBps?: number;
  sourceUrls?: string[];
}
```

2. Add validation:
   - `capacityUsd >= 0`
   - `0 <= capacityRatioOfSupply <= 1`
   - `feeBps >= 0`
   - no `live-direct` on adapters declared `proxy`
   - no Safety Score-eligible telemetry when freshness is `unverified`
   - adapter-provided ratios must be supply denominators
   - if adapter only emits `capacityUsd`, derive ratio centrally from stablecoin supply

3. Update adapter definitions:
   - expand `redemptionTelemetry.capacity`
   - distinguish `direct-current`, `direct-bounded`, `queue-current`, `proxy-validated`, `none`

4. Update redemption resolver:
   - prefer nested `metadata.redemption`
   - keep flat `immediateRedeemableUsd` compatibility for one methodology version
   - derive `capacityRatioOfSupply` centrally where possible

### Files

- `shared/types/live-reserves.ts`
- `shared/types/redemption.ts`
- `shared/lib/live-reserve-adapters.ts`
- `shared/lib/live-reserve-adapters-definitions.ts`
- `worker/src/cron/reserve-adapters/validate.ts`
- `worker/src/lib/live-reserves-store-row-decoding.ts`
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/lib/redemption-backstop-capacity.ts`
- reserve adapter tests

### Acceptance

- Invalid redemption telemetry fails adapter validation before persistence.
- Existing flat metadata remains readable.
- Ethena-style ratio denominator mismatch cannot recur.

## Phase 2 - Existing Live Adapter Hardening

Upgrade current live/proxy adapters before changing Safety Score gates.

### 3.1 Sky / Maker PSM - `dai-makerdao`, `usds-sky`

Current risk:

- Large projected Safety Score drops if Sky proxy capacity becomes low-confidence.

Current source:

- `sky-makercore` adapter uses Block Analitica group data and current PSM USDC collateral.

Upgrade:

- Classify as `live-proxy-validated`, not generic proxy.
- Add source timestamp proof and explicit `same-run-api` / `verified-source-timestamp`.
- Add PSM-specific source metadata:
  - USDC PSM balance
  - total DAI/USDS supply denominator used
  - LitePSM route status if available
  - source URL
- Keep fallback ratio, but mark fallback as `documented-bound` or `heuristic` based on source review.
- Name this route as Sky LitePSM plus DAI/USDS converter semantics, not generic legacy Maker PSM.

Acceptance:

- DAI/USDS do not drop solely because generic proxy routes are tightened.
- If Block Analitica source timestamp is stale or missing, fallback is visible and Safety Score eligibility is reduced.

### 3.2 GHO GSM - `gho-aave`

Current state:

- Positive-control direct current capacity route.

Upgrade:

- Preserve `live-direct`.
- Move current GSM backing and worst buy fee into nested telemetry.
- Keep residual issuance warning exception, but record it as lower-bound capacity semantics.
- Add route status fields from GSM frozen/seized state:
  - if all tracked GSM modules frozen/seized, routeStatus `paused` or `degraded`
  - capacity excludes non-swappable modules
- Track current facilitator / RemoteGSM mapping explicitly so stale module lists do not overstate capacity.

Acceptance:

- Stricter freshness rules do not penalize same-run onchain GSM reads.
- Direct capacity remains eligible when GSM modules are open.

### 3.3 ZCHF StablecoinBridge - `zchf-frankencoin`

Current state:

- Direct current bridge capacity from VCHF bridge balance.

Upgrade:

- Mark as `live-direct-bounded`.
- Store block/freshness proof from same-run onchain call.
- Validate bridge token balance and price source.
- Add bridge status probe if contract exposes pause/owner kill switch.

Acceptance:

- Route remains high-confidence only when bridge balance is current and bridge is not paused.

### 3.4 Ethena USDe

Current state:

- Current row is fallback/low-confidence.
- Live reserve API can expose a large liquid cash bucket, but route eligibility is the real question.

Research sources:

- Ethena peg arbitrage docs: `https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism`
- USDe terms: `https://docs.ethena.fi/resources/usde-terms-and-conditions`
- collateral API currently referenced in config

Upgrade:

- Normalize ratio against supply, not backing assets.
- Treat Liquid Cash as `live-proxy-validated`, not direct.
- Require source timestamp and API status.
- Add mint/redeem route status if app/API exposes it.
- Add holder eligibility `whitelisted-primary`.
- Cap Safety Score uplift unless direct redeemable amount or onchain hot buffer is proven.
- Model redemption as greenlisted, RFQ/quote/limit driven; do not treat Liquid Cash as unconditional public liquidity.

Acceptance:

- If the collateral API is fresh but only proxy liquidity, USDe gets capped/medium uplift, not full live-direct treatment.
- If API is degraded/stale, fallback remains low-confidence and no Safety Score uplift.

### 3.5 Falcon USDF

Current state:

- Dynamic proxy stable bucket and 7-day cooldown.

Research sources:

- Falcon redeem guide
- Falcon transparency API

Upgrade:

- Add `settlementDelaySec = 7 days`.
- Mark capacity `live-queue` or `live-proxy-validated`, not direct.
- Add snapshot timestamp and API freshness.
- Add queue/cooldown route status if API/app exposes pending redemption data.
- De minimis unmapped asset warnings should not unnecessarily block redemption capacity if materiality is below threshold.
- Split classic vs claim redemption path where source data supports it.

Acceptance:

- Falcon can retain partial uplift when transparency API is fresh, but queue delay caps Safety Score contribution.

### 3.6 InfiniFi iUSD

Current state:

- Dynamic proxy capacity from `totalLiquidAssetNormalized`.

Upgrade:

- Require trustworthy source timestamp or classify as `unverified`.
- Add pending redemptions to queue telemetry.
- Separate liquid assets from actually available redemption capacity.
- Add route status if protocol stats expose redemption enabled/disabled.

Acceptance:

- iUSD no longer gets Safety Score uplift from timestamp-poor liquid-asset stats unless source freshness is defensible.

### 3.7 Reservoir wsrUSD

Current state:

- Already using documented fallback because source freshness is weak.

Research sources:

- PSM docs state USDC PSM target balance is 25-50 bps of total assets and refills hourly: `https://docs.reservoir.xyz/protocol-architecture/peg-stability-module`

Upgrade:

- Search for onchain PSM contract balances from Reservoir smart-contract addresses.
- If found, replace timestamp-poor balance sheet proxy with same-run onchain USDC PSM balance.
- Keep documented 25 bps fallback as lower bound.

Acceptance:

- If onchain PSM balance is available, route becomes `live-direct-bounded` or `live-proxy-validated`.
- Otherwise current fallback behavior remains.

### 3.8 OpenEden USDO

Current state:

- Adapter emits direct USDC amount but current production row is unresolved due degraded latest snapshot.

Research sources:

- USDO transparency: `https://openeden.com/usdo/transparency`
- TBILL redemptions: `https://docs.openeden.com/tbill/redemptions`

Upgrade:

- Fix source freshness / degradation path.
- Classify USDO USDC amount as `live-direct-bounded`.
- Add queue/next-business-day settlement semantics for TBILL separately.
- Add source timestamp parsing hardening.

Acceptance:

- USDO either resolves with current USDC capacity or gives a precise degradation reason.

## Phase 3 - New High-Impact Adapter Work Packages

Implement after telemetry contract exists. Prioritize by score preservation, market cap, and defensibility.

### Tier 1 - Highest Confidence / Highest Value

The research pass classifies these as first-wave candidates because they have public onchain contracts, public APIs, or current transparency surfaces that can plausibly produce score-grade redemption telemetry.

#### 4.1 Cap cUSD

Sources:

- cUSD mechanics / vault docs: `https://docs.cap.app/concepts/vault`
- addresses: `https://docs.cap.app/developers/addresses`

Evidence:

- Vault exposes `totalSupplies`, `totalBorrows`, `availableBalance`, `utilization`, asset pause, protocol pause.
- Redemption is proportional basket withdrawal.

Adapter:

- New `cap-vault` onchain adapter.
- Probe:
  - supported assets
  - total supplies per asset
  - total borrows per asset
  - available balances
  - protocol/asset pause state
  - stale oracle state if exposed
  - redeem fee
- Capacity:
  - `live-direct-bounded`
  - proportional basket redeemable amount limited by available balances and pause states

Why:

- Current `cusd-cap` is event-only and projected to drop heavily under strict scoring.
- This is one of the cleanest onchain upgrades.

Research refinement:

- Probe `assets()`, `totalSupplies(asset)`, `totalBorrows(asset)`, `utilization(asset)`, `availableBalance(asset)`, pause state, oracle price/update time, whitelist asset list, and current fee/quote outputs.
- Stale oracle or paused state should hard-disable Safety Score uplift.

#### 4.2 Frax frxUSD / FPI

Sources:

- frxUSD docs: `https://docs.frax.com/frxusd`
- FrxUSDCustodian: `https://docs.frax.com/fraxnet/contracts/frxUsdCustodians`
- FraxNetDeposit: `https://docs.frax.com/fraxnet/contracts/fraxnetDeposit`
- RWA Redemption Coordinator: `https://docs.frax.com/fraxnet/contracts/rwaRedemptionCoordinator`
- FPI Controller Pool: `https://docs.frax.finance/frax-price-index/fpi-controller-pool`

Adapter:

- New `frax-redemption` onchain adapter.
- Probe:
  - custodian balances
  - mint/redeem caps
  - redeem fee
  - RWA redemption threshold
  - slippage ceiling
  - coordinator path status
  - FPI controller pool reserves and fee
- Capacity:
  - `live-direct-bounded` for frxUSD custodian/coordinator liquidity
  - `live-direct-bounded` for FPI controller pool

Why:

- `frxusd-frax` and `fpi-frax` are high-score, high-impact static routes with explicit onchain contract surfaces.

Research refinement:

- frxUSD should probe custodian balance, mint/redeem caps, redeem fee, max slippage, custodian-vs-RWA path selection, and bridge/cross-chain route status.
- FPI should probe controller pool balance, redeem fee, `twammToPeg`, CPI oracle answer/update time, pool state, and AMO exposure.
- Treat FPI as constrained by controller-pool liquidity, not full-system eventual liquidity.

#### 4.3 M0 / M

Sources:

- M0 protocol API: `https://protocol-api.m0.org/graphql`
- M0 orchestration docs: `https://gateway.m0.xyz/v1/orchestration`
- docs llms file confirms collateral composition and supported-assets APIs.

Adapter:

- New `m0-redemption` adapter.
- Probe:
  - supported assets
  - collateral composition
  - current network supply
  - minter debt / burnability if public GraphQL supports it
  - gateway supported swap/redemption paths
  - route availability
- Constraint:
  - APIs may require API keys. If no public keyless access is possible, classify as optional configured secret.

Why:

- `m-m0` is large and projected to lose large Safety Score uplift without current evidence.
- Same primitive can help M0-backed assets such as USDN / MetaMask USD if configured.

Research refinement:

- M0 protocol/orchestration APIs are API-keyed. Use direct chain RPC for score-grade fallback where feasible.
- Keep holder eligibility conservative (`whitelisted-primary` / primary minters). M is not a broad retail redemption asset.
- Do not convert M0 API support into any-holder immediate liquidity without a route-specific quote/redeem proof.

#### 4.4 Usual USD0

Sources:

- Mint/redeem architecture: `https://docs.usual.money/usual-products/usd0-stablecoin/usd0/flow-and-architecture`
- factsheets, analytics, tech docs.

Evidence:

- Direct onchain redemption via `DaoCollateral`.
- Indirect USDC minting via `SwapperEngine`.
- Minimum order threshold and real-time reserve verification.

Adapter:

- New `usual-usd0` onchain/API adapter.
- Probe:
  - direct redeem route status
  - contract pause/emergency state
  - oracle freshness
  - collateral balances
  - SwapperEngine capacity
  - minimum size and CP route availability
- Capacity:
  - `live-direct-bounded` for direct collateral route
  - `live-proxy-validated` or `live-queue` for indirect CP route

Why:

- `usd0-usual` is high impact and has enough public architecture to justify current evidence work.

Research refinement:

- Split direct `DaoCollateral` and indirect `SwapperEngine` routes.
- Probe Counter Bank Run / emergency state, oracle freshness, eligible collateral set, CP route availability, and minimum-order constraints.
- Direct route can be `live-direct-bounded`; indirect CP path should be capped unless it proves executable capacity.

#### 4.5 Superstate USTB

Sources:

- USTB redemption docs: `https://docs.superstate.com/superstate-funds/ustb/redeeming-ustb`
- docs mention liquidity API and protocol redemption.

Evidence:

- USDC payouts processed immediately when liquidity is available.
- Public liquidity API is referenced.
- Protocol redemption instructions exist.

Adapter:

- New `superstate-ustb-liquidity` API/onchain adapter.
- Probe:
  - liquidity API current capacity
  - USDC payout availability
  - protocol redemption contract / idle redemption contract
  - NAV/fund status
- Capacity:
  - `live-direct-bounded` when liquidity API confirms USDC capacity

Why:

- `ustb-superstate` currently relies on eventual issuer route. This can become a strong current-liquidity route.

Research refinement:

- Use the documented liquidity API and RedemptionIdle/onchain contract surfaces if public.
- Probe USDC liquidity, `offchainRedeem()` availability, conversion quote functions, continuous-price oracle freshness, market holiday/cutoff state, and allowlist constraints.
- USDC payout can be immediate only when liquidity exists; USD payout has market-day timing.

#### 4.6 Midas mTBILL

Sources:

- mTBILL docs and atomic redemption docs.
- Independent reporting docs.

Adapter:

- New `midas-atomic-redemption` adapter.
- Probe:
  - redemption pool capacity
  - daily attestations
  - NAV/current redemption price
  - status / pause
- Capacity:
  - `live-direct-bounded` for atomic redemption pool

Why:

- `mtbill-midas` is currently event-only but public docs claim atomic redemption mechanics.

Research refinement:

- Probe instant redemption capacity, standard queue state, redemption mode, pending queue depth, daily attestation date, oracle price freshness, minimums, and fee.
- Treat instant capacity as `live-direct-bounded`; standard redemption as `live-queue`.

### Tier 2 - Queue / Delay-Aware Current Evidence

#### 4.7 Maple syrupUSDC / syrupUSDT

Sources:

- Withdrawal docs and `WithdrawalManagerQueue`.

Adapter:

- New `maple-withdrawal-queue` onchain adapter.
- Probe:
  - withdrawal manager queue state
  - pending shares/assets
  - available liquidity
  - last processed window
  - configured delay/max processing expectation
- Capacity:
  - `live-queue`
  - cap Safety Score uplift by queue delay and available liquidity

Risk:

- Needs ABI/event indexing if no simple public API exists.

Research refinement:

- Maple documents GraphQL at `https://api.maple.finance/v2/graphql`.
- Probe `WithdrawalManagerQueue.nextRequest.id`, shares/status, queue position, pool lending balance, total shares, available liquidity, and `requestRedeem()` events.
- Settlement should use queue caps: often under 24h, up to 30d.

#### 4.8 USD.AI USDai / sUSDai

Sources:

- FAQ and app guide describe instant USDai redemption and sUSDai queue windows.

Adapter:

- New `usdai-redemption` adapter.
- Probe:
  - instant-liquidity buffer
  - sUSDai redemption queue
  - next processing window
  - pending withdrawals
  - route status
- Capacity:
  - USDai: `live-direct-bounded` if instant buffer is visible
  - sUSDai: `live-queue`

Risk:

- Needs contract/app endpoint discovery.

Research refinement:

- USDai can target `live-direct-bounded` if instant buffer is visible onchain.
- sUSDai should target `live-queue` with fixed 30-day redemption windows.
- Probe unlock dates, pending withdrawals, queue ordering, `serviceRedemptions()` processing, and next window timing.

#### 4.9 Main Street msUSD

Sources:

- Redemption process docs expose ~20% concurrent redemption cap and 7-day cooldown.

Adapter:

- Research-first ticket.
- Probe if public contract exposes:
  - current cap used
  - queued/pending redemptions
  - cooldown timers
  - available USDC
  - route status

Risk:

- Public docs alone are insufficient for a strong current adapter. Keep as `documented-bound` unless a machine-readable path is found.

Research refinement:

- Keep this as research-first. Docs expose concurrent redemption cap and cooldown, but not enough current machine-readable state yet.

#### 4.10 Neutrl, Avant, Re Protocol, Cygnus

Candidates:

- `nusd-neutrl`: instant-vs-queued depending on AssetReserve liquidity.
- `avusd-avant`: active redemption UI with cooldown.
- `reusd-re-protocol`: atomic-if-available, queued otherwise, transparency page.
- `cgusd-cygnus`: request-and-claim NFT queue.

Plan:

- Create one generic `queue-redemption` adapter primitive:
  - available liquidity
  - pending queue
  - settlement delay
  - route status
  - fee
- Then add per-protocol adapters only where public API/onchain state exists.

Research refinement:

- Re Protocol is stronger than initially assumed: transparency pages expose total redemption capacity and remaining daily capacity. Target `live-direct-bounded` for reUSD when dashboard/API state is fresh, and `live-queue` for queued/windowed paths.
- Cygnus is also stronger: redemption is queue/NFT-based with claimable-state NFTs and 2-5 day settlement. Target `live-queue`.
- Avant has active redemption tracking and up-to-7-day waits; target `live-queue` if app/contract state is accessible.
- Neutrl should move to hold/research-first until public queue/capacity/status sources are confirmed. Audit PDFs alone are not enough for score-preserving current capacity.

### Tier 3 - Issuer Transparency And Attestation Upgrades

These may not produce immediate capacity in the same way as onchain redemptions, but they can upgrade evidence from generic eventual-only to documented-current issuer status.

#### 4.11 Circle USDC / EURC

Sources:

- Circle transparency pages and reserve reports.

Adapter:

- Extend or add `circle-transparency` redemption telemetry:
  - reserve freshness
  - issuance/redemption available status if public
  - attestation date
  - route eligibility: verified customer / institutional

Expected effect:

- Better provenance and route status, probably not a huge score movement because current scores already have strong DEX liquidity.

#### 4.12 Paxos PYUSD / USDP / USDG / PAXG

Sources:

- Paxos mint/redeem page says 1:1 redemption always available and zero fees for Paxos-issued stablecoins.
- Paxos attestations / transparency pages.

Adapter:

- Add `paxos-transparency` live issuer evidence:
  - latest attestation date
  - reserves vs supply
  - redemption terms
  - PAXG gold-specific reports

Expected effect:

- Defensible evidence upgrade for issuer routes; may preserve offchain issuer uplift under stricter docs requirements.

#### 4.13 Ripple RLUSD

Sources:

- RLUSD transparency and stablecoin page.

Adapter:

- Add reserve report freshness and issuer route status.

#### 4.14 SG-FORGE CoinVertible

Sources:

- CoinVertible pages indicate daily reserve composition / circulation.

Adapter:

- Extend `sgforge-coinvertible` to include redemption telemetry:
  - daily reserve composition timestamp
  - circulation
  - issuer eligibility

#### 4.15 Brale / SBC And Bridge-Issued Stablecoins

Sources:

- Brale API docs and attestation approach.
- Bridge issuance docs.

Adapter:

- Add route status/issuer transparency where API credentials or public endpoints exist.

Risk:

- If APIs require private credentials, keep optional and fail closed.

#### 4.16 Mento Stable Assets - cUSD / cEUR / USDm / EURm Scope Check

Sources:

- Mento reserve docs and reserve dashboard.
- Verify current V3 naming/scope before implementation: current Mento docs increasingly center USDm/EURm, while legacy cUSD/cEUR semantics may have shifted.
- Research dossier source references:
  - `https://docs.mento.org/mento/overview/getting-started/analytics-and-dashboards`
  - `https://docs.mento.org/mento/overview/core-concepts/the-reserve`
  - `https://reserve.mento.org/`

Adapter:

- Extend or add a `mento-reserve` redemption telemetry path:
  - reserve dashboard freshness
  - current reserve/collateral composition
  - current supported Mento stable asset supply
  - route/open status if exposed
  - onchain reserve balances where public contracts make this cleaner than dashboard reads

Capacity tier:

- `live-proxy-validated` if current reserve composition can be tied to redemption mechanics.
- Otherwise `documented-bound` with fresh reserve evidence.

Risk:

- Reserve dashboard proves backing quality better than direct any-holder executable capacity. Avoid treating full reserve value as immediate exit liquidity unless a direct redemption capacity path is proven.

#### 4.17 Liquity LUSD / BOLD

Sources:

- Liquity V1 and V2 redemption docs.
- Existing repo `liquity-v1` adapter already emits live redemption fee telemetry.
- Research dossier source references:
  - `https://docs.liquity.org/liquity-v1/faq/lusd-redemptions`
  - `https://docs.liquity.org/v2-faq/redemptions-and-delegation`

Adapter:

- Extend Liquity adapter from fee-only into redemption state:
  - total debt / supply
  - total collateral
  - current base rate / redemption fee
  - protocol recovery/critical mode if exposed
  - trove ordering / redeemability constraints where feasible
  - oracle freshness

Capacity tier:

- `live-direct-bounded` for fully onchain redemption route when system state is healthy.
- Route status `degraded` if critical mode, stale oracle, or redemption mechanics would fail.

Risk:

- Fully onchain redemption is real, but redemption can materially affect collateralized borrowers and depends on system state. Capacity should not be blindly full-supply without health checks.

### Tier 4 - Tokenized T-Bill / Gold

#### 4.18 Hashnote USYC

Sources:

- USYC docs describe subscription/redemption and Teller route.

Adapter:

- Add oracle/fund NAV freshness and redemption route status if public.

#### 4.19 OpenEden TBILL

Sources:

- TBILL redemption docs.

Adapter:

- Extend OpenEden adapter to TBILL:
  - queue/FIFO status if public
  - settlement next-business-day model
  - current reserve report

#### 4.20 Matrixdock XAUm, Tether XAUt, Kinesis, Paxos PAXG

Adapter focus:

- Current reserve/attestation freshness.
- Physical redemption threshold and eligibility.
- Do not treat physical redemption as immediate retail liquidity unless current executable route is public.

### Tier 5 - Additional Protocol Templates And Long-Tail Backlog

These candidates came from the final broad config pass. They should be included in the rollout backlog, but not all belong in the first implementation wave.

#### 4.21 Reserve Protocol RTokens / Basket-Redeem Routes

Candidates:

- `eusd-electronic-usd`
- `honey-berachain`

Adapter:

- Add generic basket-redemption / RToken telemetry where public contracts expose basket state:
  - basket assets
  - backing manager balances
  - redemption quote
  - disabled/default state
  - issuance/redemption throttle or fee if exposed

Capacity kind:

- `live-direct-bounded` when an onchain quote proves current basket redemption.
- Otherwise `documented-eventual` with stronger reserve provenance.

#### 4.22 Origin OUSD

Candidate:

- `ousd-origin-protocol`

Adapter:

- Probe OUSD vault state:
  - supported assets
  - redeem/withdraw quote
  - withdrawal fee
  - vault liquidity vs strategy-deployed assets
  - paused/defaulted strategies

Capacity kind:

- `live-direct-bounded` for immediately withdrawable vault liquidity.
- `documented-eventual` for strategy unwind capacity.

#### 4.23 Alchemix Transmuter

Candidate:

- `alusd-alchemix`

Adapter:

- Add transmuter queue telemetry:
  - transmuter buffer
  - unexchanged claims
  - claimable amount
  - settlement velocity if derivable

Capacity kind:

- `live-queue`.

#### 4.24 PSM / Swap-Floor Batch

Candidates:

- `dola-inverse-finance`
- `buck-bucket-protocol`
- `lisusd-lista`
- `usdd-tron-dao-reserve`
- `dusd-alto`

Adapter:

- Add or extend protocol-specific PSM adapters:
  - current stablecoin reserves
  - daily limits
  - fee bps
  - pause/route status
  - min/max redemption
  - current supply denominator

Capacity kind:

- `live-direct-bounded` if actual PSM balance is readable.
- `live-proxy-validated` if only reserve share is available.

#### 4.25 Accountable / Dashboard-Backed Strategy Routes

Candidates:

- `yusd-aegis`
- `usn-noon`
- `uty-xsy`
- `yzusd-yuzu`
- `aznd-mu-digital`
- `usdu-unitas`
- possibly `usdf-astherus`

Adapter:

- Add generic dashboard-backed strategy telemetry:
  - dashboard source timestamp
  - stablecoin/cash buffer
  - strategy collateral split
  - immediate withdrawal buffer
  - queue status if exposed
  - access/settlement docs

Capacity kind:

- `live-proxy-validated` for fresh dashboard cash buffer.
- `live-queue` if queue state is available.
- Otherwise `documented-bound`.

#### 4.26 Additional Regulated Fiat Issuers

Add explicit backlog candidates:

- STASIS EURS
- Native Markets USDH
- Hex Trust USDX
- Fidelity FIDD
- MNEE
- Agora AUSD
- Tether USA-T
- StablR EURR/USDR
- Quantoz USDQ/EURQ
- Plume pUSD
- Gemini GUSD
- FDUSD First Digital
- TrueUSD
- VNX VEUR/VCHF/VGBP
- GMO GYEN/ZUSD
- IDRX
- MXNB
- JPYC
- AnchorX / Anchored Coins
- Banking Circle EURI
- AllUnity EURAU/CHFAU
- Monerium EURe
- Anzens USDA
- OSL USDGO
- WSPN WUSD
- Tether USDT if issuer transparency route is expanded beyond current curated fallback

Adapter:

- Group by issuer/transparency family:
  - attestation/report freshness
  - reserves vs circulating supply
  - redemption fee/minimum/settlement
  - route eligibility
  - route status if public

Capacity kind:

- Usually `documented-bound` with current reserve freshness.
- Do not mark `live-direct` without current executable capacity.

Notes:

- STASIS EURS, Native USDH, USDX, FIDD, MNEE, AUSD, USAT, StablR, Quantoz, and pUSD look more actionable than docs-only issuers because current transparency or reserve pages were identified.
- Banking Circle EURI, Monerium EURe, StraitsX XUSD/XSGD, AllUnity, OSL USDGO, USDM, GYEN, JPYC, BRZ, IDRT, TRYB, CADC, TGBP, AUDD, and AXCNH are weaker adapter ROI until a public current reserve/capacity feed is confirmed.

#### 4.27 Additional Collateral-Redeem / CDP Routes

Candidates:

- `fxusd-f-x-protocol`
- `feusd-felix`
- `meusd-mezo`
- `nect-beraborrow`
- `reusd-resupply`
- `satusd-river`
- `usbd-bima`
- `usdq-quill`
- `usdk-orki`
- `usnd-nerite`
- `usdaf-asymmetry`
- `ebusd-ebisu`
- `usdp-parallel`
- `ussd-sonic-labs`

Adapter:

- Add protocol-state templates after Liquity/Frax patterns are proven:
  - total debt/supply
  - collateral backing
  - redemption fee
  - redemption queue/limit if any
  - pause/recovery mode
  - oracle freshness
  - protocol-specific minimum/slippage

Capacity kind:

- `live-direct-bounded` for fully onchain redemption with healthy current state.
- `documented-eventual` where only full-system redemption docs exist.

#### 4.28 Additional Stablecoin-Redeem Routes

Candidates:

- `aid-gaib`
- `apxusd-apyx`
- `dusd-dtrinity`
- `jupusd-jupiter`
- `msusd-main-street`
- `ousg-ondo-finance`
- `u-united-stables`
- `usda-avalon`
- `usdf-astherus`
- `usr-resolv`
- `usx-solstice`
- `yousd-yield-optimizer`

Adapter:

- Split into:
  - whitelisted/issuer-mediated app/API routes
  - protocol-native vault routes
  - incident-sensitive route-availability registry candidates

Capacity kind:

- Default to `documented-bound` or `documented-eventual` until current machine-readable state is found.

Notes:

- Main Street and Ondo remain research-first.
- Resolv should go through route availability / incident registry before any renewed capacity uplift.

## Phase 4 - Scoring Policy Tightening

Only after the adapter batches have produced the new telemetry and the corresponding tests/docs are updated.

### Proposed Safety Score Eligibility Rules

1. `live-direct` / `live-direct-bounded`
   - Eligible when fresh, route open, and holder eligibility matches modeled access.
   - Full route score can be used, subject to capacity score and route caps.

2. `live-queue`
   - Eligible with queue/delay cap.
   - Cap depends on settlement delay and queue depth:
     - <= 24h: cap 80
     - <= 7d: cap 70
     - <= 30d: cap 55-60
     - unknown/delayed: no Safety Score uplift or low cap

3. `live-proxy-validated`
   - Eligible only when proxy is explicitly tied to redemption mechanics.
   - Cap lower than direct capacity unless current route proves executability.

4. `documented-bound`
   - Visible and scoreable as route quality.
   - Safety Score uplift capped and no diversification bonus unless immediate bound is quantified.

5. `documented-eventual`
   - Visible as Redemption Backstop.
   - No high Liquidity / Exit uplift by itself.
   - May provide a low/floor contribution for offchain issuer routes, but should not produce A-grade liquidity alone.

6. `heuristic`
   - Visible only.
   - No Safety Score uplift.

### Raw vs Safety-Eligible Scores

Add or expose separately:

- `modeledEffectiveExitScore`
- `safetyEligibleExitScore`
- `redemptionLiquidityEligibility`
- `redemptionLiquidityExclusionReason`

Keep `effectiveExitScore` as a deprecated alias during one API/methodology version if needed.

## Phase 5 - Route Availability Layer

Add route-status sources beyond severe active depegs.

### Work

1. Add curated incident/status registry:
   - `stablecoinId`
   - `status`
   - `startedAt`
   - `reviewedAt`
   - `sourceUrl`
   - `reason`
   - optional `expiresAt`

2. Add protocol-specific route status probes:
   - pause flags
   - frozen modules
   - app/API 503s where stable enough
   - queue closed/full states
   - circuit breakers / emergency modes

3. Integrate status into:
   - redemption sync
   - report-card eligibility
   - detail card
   - status dashboard metadata

## Phase 6 - Guardrails And Tests

### New Guards

- `check:redemption-backstops`:
  - reserve-sync route must point to adapter with matching capacity telemetry
  - `live-direct` adapters must emit same-run/onchain or verified current source evidence
  - `documented-bound` needs explicit docs and reviewedAt
  - `documented-eventual` routes cannot be Safety Score eligible unless a current capacity layer exists
  - no adapter emits redemption ratio without supply denominator proof

- `check:stablecoin-data`:
  - live reserve adapter params include required redemption source URLs / contract addresses

### Tests

- `worker/src/cron/reserve-adapters/__tests__/*`
  - one adapter test per new telemetry field
  - invalid telemetry rejected

- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
  - direct vs queue vs proxy vs documented-only eligibility
  - stale/unverified telemetry fail-closed
  - routeStatus blocks scoring

- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
  - raw modeled exit differs from Safety-eligible exit
  - eventual-only no longer creates high liquidity alone
  - queue cap behavior

- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`
  - config/adapter semantic invariants

- API/UI tests:
  - detail card labels raw vs eligible exit
  - unresolved/paused/cohort-limited copy

## Phase 7 - Documentation And Versioning

Docs to update:

- `docs/redemption-backstops.md`
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/api-reference.md`
- `docs/live-reserves.md`
- `docs/data-pipeline.md`
- `docs/about-page.md` if new external sources are production-used
- public `/methodology` page and relevant changelog route

Versioning:

- Redemption Backstop methodology: bump from `v3.8` to at least `v3.9` for telemetry/schema hardening; use `v4.0` if Safety Score eligibility semantics change materially.
- Safety Score methodology: bump from current version because Liquidity / Exit semantics change.

## Rollout Gates

### Gate A - Infrastructure And Telemetry

Ship:

- snapshot generation integrity
- telemetry schema
- validation
- detail/API additive fields

No Safety Score eligibility changes.

### Gate B - Adapter Upgrades

Ship tiered adapters behind current scoring behavior.

### Gate C - Methodology Cutover

Only cut over when:

- no critical adapter regressions
- docs updated
- methodology versions bumped
- status dashboard reflects new health metadata

## Execution Order

1. Phase 0 snapshot generation integrity.
2. Phase 1 telemetry contract / validation.
3. Phase 2 harden current live adapters.
4. Phase 3 Tier 1 adapter additions: Cap, Frax, M0, Usual, Superstate, Midas.
5. Phase 3 Tier 2 queue adapters: Maple, USD.AI, Falcon refinements, Re/Cygnus/Avant where feasible; keep Neutrl research-first.
6. Phase 3 Tier 3/Tier 4 broader upgrades: Circle, Paxos/PYUSD/USDG/PAXG, Ripple RLUSD, SG-FORGE, Brale/Bridge-issued assets, Mento stable assets scope check, Liquity LUSD/BOLD, Hashnote USYC, OpenEden TBILL, tokenized gold/Kinesis.
7. Phase 3 Tier 5 protocol templates and long-tail backlog: Reserve Protocol RTokens, Origin OUSD, Alchemix Transmuter, PSM/swap-floor systems, Accountable/dashboard-backed strategy routes, long-tail regulated issuers, additional CDP routes, and additional stablecoin-redeem routes.
8. Phase 4 scoring policy tightening.
9. Phase 5 route availability expansion.
10. Phase 6 guardrails and tests.
11. Phase 7 docs/versioning and methodology cutover.

## Research Source Index

Key public sources used during planning:

- Cap Vault: `https://docs.cap.app/concepts/vault`
- Usual Mint & Redeem: `https://docs.usual.money/usual-products/usd0-stablecoin/usd0/flow-and-architecture`
- M0 docs/API: `https://docs.m0.org/`, `https://protocol-api.m0.org/graphql`, `https://gateway.m0.xyz/v1/orchestration`
- Superstate USTB redemption: `https://docs.superstate.com/superstate-funds/ustb/redeeming-ustb`
- Reservoir PSM candidate: `https://docs.reservoir.xyz/protocol-architecture/peg-stability-module` (verify product-specific route surface before implementation)
- Paxos mint/redeem: `https://www.paxos.com/mint-and-redeem`
- Maple docs: `https://docs.maple.finance/syrupusdc-for-lenders/risk`, `https://docs.maple.finance/technical-resources/withdrawal-managers/withdrawal-manager-queue`
- Frax frxUSD/FPI docs: `https://docs.frax.com/frxusd`, `https://docs.frax.com/fraxnet/contracts/rwaRedemptionCoordinator`, `https://docs.frax.finance/frax-price-index/fpi-controller-pool`
- OpenEden USDO/TBILL: `https://openeden.com/usdo/transparency`, `https://docs.openeden.com/tbill/redemptions`
- Reservoir docs: `https://docs.reservoir.xyz/protocol-architecture/peg-stability-module`
- Circle transparency: `https://www.circle.com/en/transparency`
- Paxos transparency/attestations: `https://www.paxos.com/attestations/`
- Ripple RLUSD transparency: `https://ripple.com/solutions/stablecoin/transparency/`

## Open Questions

1. Should `documented-eventual` give any Safety Score Liquidity / Exit floor, or only standalone route visibility?
2. What is the exact cap curve for queue settlement delay?
3. Should offchain issuer routes with verified reserve reports but no current redemption capacity API retain a capped Safety Score uplift?
4. Should API-keyed sources such as M0 be allowed as production dependencies, and how should missing keys fail closed?
5. Should route availability registry be manual-only at first, or should it include machine probes immediately?
