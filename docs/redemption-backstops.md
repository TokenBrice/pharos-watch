# Redemption Backstops

Modeled redemption-route coverage for tracked stablecoins. This subsystem estimates how credibly a holder can exit to par or near-par outside secondary-market DEX liquidity, then exposes both a standalone snapshot API and an effective-exit input for report-card liquidity scoring.

---

## Methodology Versioning

- **Current methodology version:** `v1.1`
- **Public methodology anchor:** `/methodology/#safety-scores-methodology`
- **Canonical source files:** `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/redemption-backstop-version.ts`

There is no standalone changelog page yet. The public methodology link currently points at the Safety Scores section because redemption backstops feed the report-card liquidity dimension.

---

## Coverage

Configured coverage is defined statically in `shared/lib/redemption-backstops.ts`.

- **Configured coins:** 46
- **Route families:** 19 `offchain-issuer`, 11 `queue-redeem`, 9 `collateral-redeem`, 5 `psm-swap`, 1 `basket-redeem`, 1 `stablecoin-redeem`
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
2. The latest DEX liquidity map via `loadDexLiquidityMap(db)`
3. Reserve-sync state only when a route uses `capacityModel.kind = "reserve-sync-metadata"`

No external HTTP calls happen during the redemption-backstop pass itself; any live reserve telemetry is reused from D1.

Status semantics:

- `ok` when all configured in-cache coins resolve successfully
- `degraded` when some coins fail but at least one snapshot is written
- `error` when zero snapshots are written and failures or missing-cache coverage prevent a usable result

Cron metadata includes `synced`, `failed`, `configured`, `dynamic`, `estimated`, `static`, plus `failedIds` or `missingFromCache` when relevant.

---

## Scoring Model

### Component Weights

Defined in `shared/lib/redemption-backstop-scoring.ts`:

| Component | Weight |
|-----------|--------|
| Access | 0.20 |
| Settlement | 0.15 |
| Execution certainty | 0.15 |
| Capacity | 0.25 |
| Output asset quality | 0.15 |
| Cost | 0.10 |

If `capacityScore` is unavailable, `computeRedemptionBackstopScore()` returns `null` and the route is treated as unrated.

### Route-Family Caps

Some route families are intentionally capped even when their component mix scores higher:

| Route family | Cap |
|--------------|-----|
| `queue-redeem` | 70 |
| `offchain-issuer` | 65 |

An optional per-config `totalScoreCap` can apply an additional `config-cap`.

### Effective Exit Score

`computeEffectiveExitScore()` blends modeled redemption quality with observable DEX liquidity:

- If both exist: `max(dexLiquidity, 0.55 * dexLiquidity + 0.45 * redemptionScore)`
- If only DEX liquidity exists: passthrough DEX liquidity
- If only redemption exists: `min(70, redemptionScore * 0.75)`
- If neither exists: `null`

These weights are surfaced by `/api/redemption-backstops.methodology.effectiveExitWeights` and reused by report cards.

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

The registry lives in `shared/lib/redemption-backstops.ts`.

### Capacity Models

Capacity resolution happens in `worker/src/lib/redemption-backstop-sources.ts`.

| Capacity model | Resolution |
|----------------|------------|
| `supply-full` | Immediate capacity equals full current supply |
| `supply-ratio` | Immediate capacity equals `supplyUsd * ratio` |
| `reserve-sync-metadata` | Reads `reserve_sync_state.metadata.immediateRedeemableUsd` / `immediateRedeemableRatio`; falls back to configured ratio when provided |

The resulting row is tagged with one `sourceMode`:

- `dynamic` when fresh reserve-sync metadata is available
- `estimated` when static supply models or stale reserve metadata are used
- `static` when the route exists but no usable dynamic or estimated capacity could be resolved

### Docs / Notes

- `docs` is resolved from the coin metadata's `proofOfReserves.url` first, then from preferred public links (`Docs`, `Proof of Reserve`, `Transparency`, `Website`)
- `feeDescription` carries docs-backed fee text when the route fee is fixed, conditional, dynamic, flat-fee-based, or publicly undisclosed
- `notes` merges config notes plus runtime notes such as stale reserve metadata fallback
- `capsApplied` records any score caps triggered during scoring

### Cost Modeling

- `feeBps` is still used only when the route has a bounded fixed basis-point fee that can be represented cleanly in the score model
- `feeDescription` is used to surface:
  - dynamic formulas such as Liquity-style `min 50 bps + baseRate`
  - conditional fee schedules such as borrower-vs-non-borrower redemptions
  - flat minimums or bank/network charges that do not map cleanly to one global bps number
  - cases where public docs were reviewed but no numeric redemption-fee schedule is published
- `costScore` remains driven by the existing bounded-fee buckets; descriptive variable-fee routes still use the conservative variable / unclear bucket

---

## Database Schema

Migration: `worker/migrations/0066_redemption_backstops.sql`

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

`details_json` now also stores `feeDescription` alongside `docs`, `notes`, and `capsApplied`, so descriptive fee logic survives current-snapshot and history writes without a schema migration.

### `redemption_backstop_history`

Daily history table keyed by `(stablecoin_id, snapshot_date)`.

Stored fields:

- `score`
- `effective_exit_score`
- `dex_liquidity_score`
- `updated_at`
- `methodology_version`
- `details_json`

The cron upserts both current and history rows together through `upsertRedemptionBackstopSnapshots(...)`.

---

## API Endpoint

### `GET /api/redemption-backstops`

**File:** `worker/src/api/redemption-backstops.ts`

- Returns `503` with `{ "error": "Data not yet available" }` until at least one hourly sync has written rows
- Otherwise returns the current map plus methodology metadata from `buildRedemptionBackstopsSnapshot(db)`
- Cache profile: `standard` (`public, s-maxage=300, max-age=60`) with freshness headers based on `updatedAt`

See [API Reference](./api-reference.md) for the exact response shape.

---

## Frontend Consumers

- `src/hooks/api-hooks.ts` exports `useRedemptionBackstops()` with `CRON_1H`
- `src/hooks/use-stablecoin-detail-view-model.ts` fetches the map and passes the coin-specific entry into the stablecoin detail view model
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` renders the detail-page card (score badges, route family, source mode, access/settlement/output/capacity blocks, an explicit redemption-fee summary with fixed or documented variable/conditional fee text, component subscores, docs link, and contextual methodology hint / footer actions)
- `src/lib/stablecoin-detail-view-model.ts` includes redemption freshness in the detail-page stale-query rail
- `worker/src/lib/report-cards-snapshot.ts` injects `redemptionBackstopScore`, `redemptionRouteFamily`, and immediate-capacity fields into `rawInputs`, and `shared/lib/report-cards.ts` consumes the score in `scoreLiquidity()`

There is currently no dedicated list page or standalone public methodology section for redemption backstops; the primary user-facing surface is the stablecoin detail page plus the report-card liquidity dimension. Contextual hints on those surfaces currently deep-link into the Safety Scores methodology section where effective-exit logic is documented.

---

## File Index

| File | Role |
|------|------|
| `shared/lib/redemption-backstops.ts` | Canonical per-coin redemption route configs |
| `shared/lib/redemption-backstop-scoring.ts` | Component scores, route caps, and effective-exit blend |
| `shared/lib/redemption-backstop-version.ts` | Methodology version metadata |
| `shared/types/redemption.ts` | Shared API schemas and TypeScript contracts |
| `worker/src/cron/sync-redemption-backstops.ts` | Hourly snapshot sync |
| `worker/src/lib/redemption-backstop-sources.ts` | Runtime resolver for capacity, costs, docs, and scoring inputs |
| `worker/src/lib/redemption-backstops-store.ts` | D1 storage helpers and API payload builder |
| `worker/src/api/redemption-backstops.ts` | Public API handler |
| `worker/migrations/0066_redemption_backstops.sql` | Current + history tables |
| `src/hooks/api-hooks.ts` | `useRedemptionBackstops()` |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Detail-page query wiring |
| `src/lib/stablecoin-detail-view-model.ts` | Detail-page composed view model with redemption freshness tracking |
| `src/components/stablecoin-detail/redemption-backstop-card.tsx` | Detail-page redemption card UI |
