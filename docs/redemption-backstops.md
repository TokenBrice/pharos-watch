# Redemption Backstops

Modeled redemption-route coverage for tracked stablecoins. This subsystem estimates how credibly a holder can exit to par or near-par outside secondary-market DEX liquidity, then exposes both a standalone snapshot API and an effective-exit input for report-card liquidity scoring.

---

## Methodology Versioning

- **Current methodology version:** `v3.95`
- **Public methodology anchor:** `/methodology/#safety-scores-methodology`
- **Canonical source files:** `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-configs/*`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/redemption-backstop-version.ts`

Latest `v3.95` update: USTB now preserves its on-chain NAV reserve proof while using Superstate's current liquidity endpoint for bounded redemption-capacity telemetry. frxUSD also uses fresh Frax balance-sheet telemetry for stablecoin redemption capacity, live route status can flow from reserve adapters into redemption-backstop rows, and reserve-composition ratios are no longer reused as supply-relative redemption-capacity ratios when a nested live capacity amount is available.

There is no standalone changelog page yet. The public methodology link currently points at the Safety Scores section because redemption backstops feed the report-card liquidity dimension.

---

## Coverage

Configured coverage is defined statically behind the thin facade in `shared/lib/redemption-backstops.ts`, with route-family modules under `shared/lib/redemption-backstop-configs/`.

- **Configured coins:** 147
- **Route families:** 81 `offchain-issuer`, 21 `stablecoin-redeem`, 19 `collateral-redeem`, 15 `queue-redeem`, 8 `psm-swap`, 3 `basket-redeem`
- **No discovery layer:** only coins present in `REDEMPTION_BACKSTOP_CONFIGS` are modeled

The config registry is validated at module load time against `TRACKED_META_BY_ID`, so unknown IDs fail fast during build/test/runtime startup.

---

## Cron Schedule

- **Pattern:** `11 * * * *`
- **Function:** `syncRedemptionBackstops(db, signal)`
- **File:** `worker/src/cron/sync-redemption-backstops.ts`
- **Trigger order:** runs after `sync-live-reserves` in the hourly reserve lane (`worker/src/handlers/scheduled/hourly-live-reserves.ts`)

The cron reads:

1. The strict `stablecoins` cache via `loadStablecoinsCache(...)`
2. The latest DEX liquidity snapshot via `loadDexLiquiditySnapshot(db)` so both the liquidity map and freshness can be reused
3. A preloaded map of the latest authoritative reserve snapshot metadata for routes that use live reserve telemetry for capacity or fee inputs

No external HTTP calls happen during the redemption-backstop pass itself; any live reserve telemetry is reused from D1.

Status semantics:

- `ok` when every configured route resolves to a usable scored row and the DEX liquidity input used for effective-exit context is fresh, when the only unresolved rows are a tiny `missing-capacity` tail within the current tolerance budget (`ceil(configured * 1%)`), or when current market evidence intentionally marks a route `impaired`
- `degraded` when at least one row is written but any configured route fails, is missing from cache, hits a non-`missing-capacity`/non-`impaired` unresolved state, the `missing-capacity` tail exceeds that tolerance budget, or the reused DEX liquidity snapshot is stale
- `error` when zero routes resolve to a usable scored row because of route failures, cache misses, or blocking unresolved states

Cron metadata includes `synced`, `resolved`, `unresolved`, `unresolvedMissingCapacity`, `unresolvedCritical`, `availabilityDegraded`, `missingCapacityOkThreshold`, `coverageRatio`, `failed`, `configured`, `dynamic`, `estimated`, `static`, and `liquidityStale`, plus `failedIds`, `availabilityDegradedIds`, or `missingFromCache` when relevant. `availabilityDegraded`/`availabilityDegradedIds` are row-level route-availability signals and do not by themselves degrade the cron run.

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

`computeEffectiveExitScore()` uses a best-path model to combine modeled redemption quality with observable DEX liquidity:

- If both exist: `min(100, max(dexLiquidity, redemptionScore) + min(dexLiquidity, redemptionScore) × 0.10)`
- If only DEX liquidity exists: passthrough DEX liquidity
- If only redemption exists: passthrough redemption score (route family caps are the guardrails)
- If neither exists: `null`

The redemption-backstop cron only materializes `effectiveExitScore` on resolved rows when the reused DEX liquidity input is fresh. Report cards then apply their own freshness and confidence gating on top, so stale redemption snapshots and low-confidence redemption routes stay visible on redemption surfaces but do not uplift Safety Score liquidity.

Severe active depegs add a current-exercisability gate on top of the static route score. When an open `depeg_events` row has `abs(peak_deviation_bps) >= 2500`, a static, estimated, live-proxy, issuer/API, queue, or documented-bound redemption route is marked `impaired` unless it has live-direct dynamic permissionless redemption capacity with atomic or immediate settlement. This prevents stale route documentation from producing a strong par-exit score while the market is indicating that broad redemption is not currently clearing.

The effective exit model parameters are surfaced by `/api/redemption-backstops.methodology.effectiveExitModel` and reused by report cards.

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
- optional `totalScoreCap`
- optional `notes`

The public registry import lives in `shared/lib/redemption-backstops.ts`. The actual config inventory is split by route family under `shared/lib/redemption-backstop-configs/` to keep review and change scopes small.

### Capacity Models

Capacity resolution happens in `worker/src/lib/redemption-backstop-sources.ts`.

| Capacity model          | Resolution                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `supply-full`           | Scores against full current supply as eventual redeemability, but leaves `immediateCapacity*` empty because immediate buffer is not separately quantified |
| `supply-ratio`          | Immediate modeled capacity equals `supplyUsd * ratio`; this is heuristic unless the config explicitly opts into stronger confidence |
| `reserve-sync-metadata` | Reads normalized `reserve_composition.metadata.redemption.capacityUsd` / `capacityRatioOfSupply` when present, falling back to legacy `immediateRedeemableUsd` / `immediateRedeemableRatio`, from the latest fresh live snapshot only when the adapter explicitly exposes redemption-capacity telemetry and the snapshot carries scoring-grade freshness evidence; degraded snapshots still fail closed by default, but specific lower-bound-only warning classes can be allowlisted per route when they indicate reserve completeness limits rather than broken telemetry. Routes can also fall back to a reviewed configured ratio when public docs publish a hard primary-market buffer floor. |

Live reserve adapters can now emit a nested `metadata.redemption` object for new redemption-specific telemetry. The validator rejects malformed or unsupported redemption telemetry before persistence, including negative capacity, capacity ratios outside `0..1`, negative fees, capacity fields from adapters that declare no capacity support, fee fields from adapters that declare no fee support, or direct-capacity tiers emitted by proxy-only adapters. Legacy flat metadata remains readable while existing adapters are migrated to the nested contract.

Sky `DAI` and `USDS` now use the live `sky-makercore` PSM `USDC` balance as their immediate redeemable bound when that telemetry is fresh, with the prior 33% reviewed heuristic retained only as fallback.
`cUSD` now uses the live `cap-vault` onchain adapter for bounded current redemption capacity, scoring against unpaused available vault balances rather than full eventual basket redeemability.
`LUSD` now uses the live `liquity-v1` onchain adapter for bounded current direct capacity, scoring against `TroveManager.getEntireSystemDebt()` when the hourly reserve snapshot is fresh and clean rather than the old static full-supply model.
`BOLD`, `feUSD`, `USND`, and `USDQ` now use the live `liquity-v2-branches` onchain adapter for bounded current direct capacity, scoring against aggregate ActivePool branch debt when the hourly reserve snapshot is fresh and clean rather than the old static full-supply model. The adapter can also surface branch shutdown as degraded route status.
`fxUSD` now uses f(x)'s protocol pool API debt balances as live proxy capacity, while `USDaf` uses Asymmetry's timestamped protocol supply data as direct live capacity. `JupUSD` uses Jupiter's public transparency API for current USDC/USDtb holdings and oracle route-status context, with the previous 10% reviewed buffer retained only as fallback.
`GHO` now uses tracked swappable GSM backing as a live lower bound even when reserve sync is degraded solely by aggregated residual issuance outside the configured GSM set, because that warning reflects reserve completeness rather than invalid tracked telemetry.
`wsrUSD` continues to prefer live Reservoir USDC balance telemetry when available, but now falls back to Reservoir's documented 25 bps minimum USDC PSM balance instead of remaining unrated when the live feed lacks a trustworthy source timestamp.
Reviewed bounded primary-market liquidity buffers published by protocols or issuers, such as DOLA's USDS PSM share or JupUSD's USDC buffer, can also use `documented-bound` ratio semantics when the underlying source is explicit enough to avoid pretending the ratio is merely a blind heuristic.
Reviewed route docs alone are not enough to promote delta-neutral or strategy-backed rails into `documented-bound` full-supply semantics; those routes still need either an explicitly published immediate buffer bound or fresh live reserve telemetry.

The resulting row is tagged with one `sourceMode`:

- `dynamic` when fresh latest-success authoritative live reserve snapshot metadata is available
- `estimated` when static supply models or configured reserve-sync fallback ratios are used
- `static` when the route remains configured but the current snapshot could not resolve a usable score, including failure-safe rows written after per-coin sync errors

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
- `routeStatusSource`:
  - `static-config` for normal config-derived status
  - `market-implied` for the severe active-depeg exercisability gate
  - `operator-notice`, `protocol-api`, and `onchain` are reserved for future current-route evidence sources
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
  - `eventual-only` when the route is scored as eventual redeemability rather than immediate same-size liquidity
- `capacityBasis`:
  - typed evidence basis such as `issuer-term-redemption`, `full-system-eventual`, `psm-balance-share`, `strategy-buffer`, `hot-buffer`, `daily-limit`, `live-direct-telemetry`, or `live-proxy-buffer`
- `feeConfidence`:
  - `fixed` for bounded bps schedules
  - `formula` for disclosed formulas such as Liquity-style base-rate fees
  - `undisclosed-reviewed` when docs were reviewed but only descriptive fee information is available
- `feeModelKind`:
  - `fixed-bps`, `formula`, `documented-variable`, or `undisclosed-reviewed`
- `modelConfidence`:
  - `high`, `medium`, or `low` rollups used by the API and detail page to communicate fidelity
  - currently `low` for heuristic-capacity routes, unresolved rows, and impaired rows

### Docs / Notes

- `docs` prefers explicit config-reviewed sources first (`docs[]` + `reviewedAt`), then live-reserve display links for reserve-sync routes, then the coin metadata's `proofOfReserves.url`, then preferred public links (`Docs`, `Proof of Reserve`, `Transparency`, `Website`)
- `docs.provenance` distinguishes reviewed route docs from fallback live-reserve, proof-of-reserves, or generic project-link sources so detail pages do not overstate evidence quality
- `docs.reviewedAt` is the route-review date, not a claim that the rendered fallback link itself was the reviewed source; the detail card now shows review date and provenance together
- `docs.sources[]` records structured provenance for what the linked source supports (`route`, `capacity`, `fees`, `access`, `settlement`)
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
- `costScore` remains driven by the existing bounded-fee buckets; descriptive variable-fee routes still use the conservative variable / unclear bucket

---

## Database Schema

Migration: `worker/migrations/0000_baseline.sql` in the current post-squash tree, plus `0094_redemption_backstop_runs.sql` for completed-run snapshot manifests. Historical introduction lives in the pre-squash lineage recorded in `worker/migrations/MANIFEST.md`.

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

`details_json` now also stores `routeFamily`, provider/source provenance, immediate-capacity fields, fee fields, `resolutionState`, `routeStatus`, `routeStatusSource`, `routeStatusReason`, `routeStatusReviewedAt`, `holderEligibility`, `capacityConfidence`, `capacityBasis`, `capacitySemantics`, `feeConfidence`, `feeModelKind`, `modelConfidence`, and `feeDescription` alongside `docs`, `notes`, and `capsApplied`, so richer runtime context survives current-snapshot and history writes without a schema migration.

`snapshot_run_id` links current rows to a completed `redemption_backstop_runs` manifest when written by the post-`0094` worker. API and report-card readers prefer the latest completed run and filter current rows to that generation. Legacy rows without a completed run remain readable as a fallback during rollout and local bootstrap.

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

The cron upserts both current and history rows together through `upsertRedemptionBackstopSnapshots(...)`.

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

The sync inserts a `running` row before writing current/history rows and marks it `completed` only after all row batches succeed. Readers prefer the latest completed run and use `max_updated_at` for response freshness. If no completed run exists, they fall back to legacy `MAX(updated_at)` behavior.

---

## API Endpoint

### `GET /api/redemption-backstops`

**File:** `worker/src/api/redemption-backstops.ts`

- Returns `503` with `{ "error": "Data not yet available" }` until at least one hourly sync has written rows
- Returns `503` with `{ "error": "Redemption backstop snapshot unavailable" }` when the current snapshot cannot be read cleanly from D1
- Otherwise returns the current map plus methodology metadata from `buildRedemptionBackstopsSnapshot(db)`, with `methodology.version` attributed from the latest completed run or latest stored snapshot row and `currentVersion` preserved as the live code version
- Cache profile: `standard` (`public, s-maxage=300, max-age=60`) with freshness headers based on `updatedAt`

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Consumers

- `src/hooks/api-hooks.ts` exports `useRedemptionBackstops()` with `CRON_1H`
- `src/hooks/use-stablecoin-detail-view-model.ts` fetches the map and passes the coin-specific entry into the stablecoin detail view model
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` renders the detail-page card (score badges, route family, source mode, resolution state, route status, model confidence, access/settlement/output/capacity blocks, eventual-only vs immediate-bounded capacity messaging, explicit redemption-fee summaries keyed off `feeModelKind`, reviewed docs/source context, component subscores, and contextual methodology hint / footer actions)
- `src/lib/stablecoin-detail-view-model.ts` includes redemption freshness in the detail-page stale-query rail
- `worker/src/lib/report-cards-snapshot.ts` injects `redemptionBackstopScore`, `redemptionRouteFamily`, and immediate-capacity fields into `rawInputs`, and `shared/lib/report-cards.ts` consumes the score in `scoreLiquidity()`
- `src/lib/coverage.ts` now distinguishes configured-but-unrated routes, impaired routes, and low-confidence heuristic routes from genuinely covered routes, so unresolved or weakly evidenced rows do not inflate public coverage counts

There is currently no dedicated list page or standalone public methodology section for redemption backstops; the primary user-facing surface is the stablecoin detail page plus the report-card liquidity dimension. Contextual hints on those surfaces currently deep-link into the Safety Scores methodology section where effective-exit logic is documented.

---

## File Index

| File                                                            | Role                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `shared/lib/redemption-backstops.ts`                            | Canonical public import facade for the config registry             |
| `shared/lib/redemption-backstop-configs/*`                      | Route-family config modules plus shared config helpers             |
| `shared/lib/redemption-backstop-scoring.ts`                     | Component scores, route caps, and effective-exit blend             |
| `shared/lib/redemption-backstop-version.ts`                     | Methodology version metadata                                       |
| `shared/types/redemption.ts`                                    | Shared API schemas and TypeScript contracts                        |
| `worker/src/cron/sync-redemption-backstops.ts`                  | Hourly snapshot sync                                               |
| `worker/src/lib/redemption-backstop-sources.ts`                 | Runtime resolver for capacity, costs, docs, and scoring inputs     |
| `worker/src/lib/redemption-backstops-store.ts`                  | D1 storage helpers and API payload builder                         |
| `worker/src/api/redemption-backstops.ts`                        | Public API handler                                                 |
| `worker/migrations/0000_baseline.sql`                           | Baseline current + history table schema                            |
| `src/hooks/api-hooks.ts`                                        | `useRedemptionBackstops()`                                         |
| `src/hooks/use-stablecoin-detail-view-model.ts`                 | Detail-page query wiring                                           |
| `src/lib/stablecoin-detail-view-model.ts`                       | Detail-page composed view model with redemption freshness tracking |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx` | Detail-page redemption card UI                                     |
