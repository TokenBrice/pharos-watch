# Live Reserve Sync

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.

---

## Overview

- **Cron:** `sync-live-reserves` (`worker/src/cron/sync-live-reserves.ts`)
- **Schedule:** `11 * * * *` (hourly at :11 UTC)
- **Current coverage:** 45 live-enabled stablecoins across 24 registered adapters
- **Storage:** `reserve_composition`, `reserve_sync_state`
- **API:** `GET /api/stablecoin-reserves/:id`
- **Frontend consumers:** `useStablecoinReserves()`, stablecoin detail view model, `/status` reserve-sync health

This pipeline is intentionally separate from curated reserve metadata in `StablecoinMeta.reserves`. Live reserve sync affects live-enabled detail-page reserve views, status monitoring, and (since v5.8) collateral quality scoring in report cards. The dependency map and all other scoring dimensions still derive from curated/static reserve metadata.

---

## Metadata Contract

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/index.ts`, `shared/lib/stablecoins.ts`).

`LiveReservesConfig` fields:

| Field | Meaning |
|-------|---------|
| `adapter` | Registered adapter key from `worker/src/cron/reserve-adapters/index.ts` |
| `version` | Increment when adapter semantics or parsing change materially |
| `semantics` | One of `collateral-mix`, `protocol-reserve`, `attestation-mix`, `single-asset` |
| `breakerScope` | Optional circuit-breaker grouping override; defaults to adapter key |
| `display` | Optional UI/source link metadata (`url`, `label`) |
| `inputs.primary` | Primary source input |
| `inputs.fallbacks` | Optional fallback inputs |
| `params` | Adapter-specific validated settings |

### Known Limitation: Fallback Inputs

`inputs.fallbacks` is declared in `LiveReservesConfig` but **not currently implemented**:

- No adapter reads or uses fallback inputs
- No coin configuration declares fallback inputs
- The cron orchestrator does not attempt fallback resolution on primary failure

When the primary source fails, the adapter throws and the circuit breaker handles recovery. Implementing fallback resolution would provide meaningful resilience for adapters with fragile primary sources (e.g., HTML-scraped sources like Mento).

**Future implementation path:** Add fallback resolution to `runAdapter()` in `sync-live-reserves.ts` -- try primary input first, and on failure, iterate through `config.inputs.fallbacks` with the same adapter function.

Supported input kinds:

| Kind | Meaning |
|------|---------|
| `http-json` | JSON API endpoint |
| `http-html` | HTML page parsed by the adapter |
| `indexer` | Indexed external data feed |
| `onchain-evm` | On-chain EVM reads via `etherscan-proxy`, `alchemy`, or `public-rpc` |

---

## Cron Behavior

`runHourlyReserveSyncSlot()` in `worker/src/handlers/scheduled/hourly-live-reserves.ts` runs the reserve cron on its own trigger so reserve-adapter fetches do not compete with the 30-minute scoring lane or the daily 08:00 jobs.

`syncLiveReserves()`:

1. Filters `TRACKED_STABLECOINS` to the coins that declare `liveReservesConfig`.
2. Resolves an adapter from `worker/src/cron/reserve-adapters/index.ts`.
3. Builds a breaker key as `live-reserves:${breakerScope ?? adapter}`.
4. Checks the per-source circuit breaker before each coin fetch.
5. Persists either a fresh snapshot (`reserve_composition`) plus sync-state row, or an error/degraded/skipped sync-state row.

Cron result statuses:

| Status | When |
|--------|------|
| `ok` | Every configured coin synced cleanly |
| `degraded` | Any coin failed, was skipped, or emitted warnings |
| `error` | No configured coin synced successfully |

The cron loop is sequential. This is deliberate: reserve adapters can hit multiple heterogeneous sources, and the isolated hourly trigger keeps connection pressure predictable.

---

## Storage Model

### `reserve_composition`

Latest successful live snapshot per live-enabled coin.

| Column | Meaning |
|--------|---------|
| `stablecoin_id` | Canonical Pharos coin ID |
| `slices` | JSON-serialized `ReserveSlice[]` |
| `fetched_at` | Unix timestamp of the successful snapshot |
| `source` | Adapter key that produced the snapshot |

### `reserve_sync_state`

Per-coin operational state for the most recent attempt.

| Column | Meaning |
|--------|---------|
| `stablecoin_id` | Canonical Pharos coin ID |
| `adapter_key` | Adapter used for the most recent attempt |
| `breaker_key` | Per-source circuit-breaker key |
| `last_attempted_at` | Unix timestamp of the latest attempt |
| `last_success_at` | Unix timestamp of the latest successful live snapshot |
| `last_status` | `ok`, `degraded`, `error`, or `skipped` |
| `warning_count` | Number of adapter warnings |
| `warnings` | JSON-serialized warning objects |
| `last_error` | Latest failure message, if any |
| `metadata` | Adapter-specific operational metadata |

Freshness and consistency rules live in `worker/src/lib/live-reserves-store.ts`:

- `LIVE_RESERVE_FRESHNESS_SEC = 172800` (48 hours)
- A live snapshot only counts as consistent when `reserve_sync_state.last_success_at === reserve_composition.fetched_at`
- Empty slice arrays never count as a valid live snapshot

`computeReserveCompositionOverview()` aggregates the status-card summary used by `/status`:

- `configuredCoins`
- `freshCoins`
- `staleCoins`
- `missingCoins`
- `degradedCoins`
- `errorCoins`
- `lastSuccessAt`
- `oldestFreshAgeSec`

---

## API Contract

`handleStablecoinReserves()` in `worker/src/api/stablecoin-reserves.ts` is only available for known tracked IDs that also declare `liveReservesConfig`.

404 behavior:

- Unknown stablecoin ID
- Tracked coin without live reserve support
- Unexpected inability to resolve either live or fallback presentation data

Successful responses return `StablecoinReservesResponse` with one of these modes:

| Mode | Meaning |
|------|---------|
| `live` | Fresh live snapshot from `reserve_composition` |
| `live-stale` | Live snapshot exists, but is older than 48 hours |
| `curated-fallback` | Live snapshot unavailable; falling back to curated `StablecoinMeta.reserves` |
| `template-fallback` | Live snapshot unavailable; falling back to reserve templates from `getReserves()` |
| `unavailable` | Coin is live-enabled, but neither live data nor fallback reserve presentation is available |

Cache control:

| Response mode | Cache-Control |
|---------------|---------------|
| `live` | `public, s-maxage=3600, max-age=300` |
| `live-stale`, fallback / unavailable modes | `public, s-maxage=300, max-age=60` |

The optional `sync` object exposes the last operational state:

| Field | Meaning |
|-------|---------|
| `enabled` | Coin is live-enabled |
| `status` | Last sync status (`ok`, `degraded`, `error`, `skipped`) |
| `stale` | Latest successful live snapshot is older than 48 hours |
| `bootstrap` | No successful live snapshot has been recorded yet |
| `lastAttemptedAt` | Latest attempt timestamp, when present |
| `lastSuccessAt` | Latest success timestamp, when present |
| `warnings[]` | Warning messages surfaced by the adapter |
| `lastError` | Most recent adapter error message (truncated to 200 chars), when present |

### Edge Cache Implications for Monitoring

When a coin has `mode="live"`, the response is edge-cached for 1 hour (`s-maxage=3600`). If the adapter starts failing *after* a successful response was cached:

- The public API will continue serving the **cached successful response** for up to 1 hour
- The `sync` object in the cached response will show the **previous** sync state, not the current failure
- Operators querying the public API will not see the error status until the edge cache expires

**For real-time monitoring**, use the auth-gated `/status` endpoint, which is never edge-cached and always reflects current D1 state.

Fallback/degraded responses use a shorter edge cache (`s-maxage=300`, 5 minutes), so status transitions from fallback modes propagate faster.

---

## Adapter Registry

Registered in `worker/src/cron/reserve-adapters/index.ts`.

| Adapter | Primary input | Semantics | Configured coins |
|---------|---------------|-----------|------------------|
| `accountable` | `http-json` | `protocol-reserve` | 6 |
| `asymmetry` | `http-json` | `collateral-mix` | 1 |
| `btcfi` | `http-json` | `collateral-mix` | 1 |
| `chainlink-nav` | `onchain-evm` | `single-asset` | 4 |
| `chainlink-por` | `onchain-evm` | `attestation-mix` | 1 |
| `collateral-positions-api` | `http-json` | `collateral-mix` | 2 |
| `crvusd` | `http-json` | `collateral-mix` | 1 |
| `erc4626-single-asset` | `onchain-evm` | `single-asset` | 2 |
| `ethena` | `http-json` | `collateral-mix` | 1 |
| `evm-branch-balances` | `onchain-evm` | `collateral-mix` | 3 |
| `falcon` | `http-json` | `collateral-mix` | 1 |
| `frax` | `http-json` | `attestation-mix` | 1 |
| `gho` | `onchain-evm` | `protocol-reserve` | 1 |
| `fx` | `http-json` | `collateral-mix` | 1 |
| `infinifi` | `http-json` | `collateral-mix` | 1 |
| `m0` | `http-json` | `protocol-reserve` | 3 |
| `mento` | `http-html` | `collateral-mix` | 2 |
| `openeden-usdo` | `http-json` | `collateral-mix` | 1 |
| `ousd` | `http-json` | `collateral-mix` | 1 |
| `reservoir` | `http-json` | `protocol-reserve` | 1 |
| `single-asset` | `onchain-evm` / `http-json` | `single-asset` | 5 |
| `sky-makercore` | `http-json` | `collateral-mix` | 2 |
| `tether` | `http-json` | `attestation-mix` | 1 |

Adapter helpers are centralized in `worker/src/cron/reserve-adapters/helpers.ts`:

- HTTP JSON / HTML fetch wrappers (`fetchJsonWithRetry`, `fetchTextWithRetry`)
- DefiLlama spot-price loading for valuation (`fetchDefiLlamaPrices`)
- EVM balance, total-supply, and hex-call reads (`fetchErc20Balance`, `fetchErc20TotalSupply`)
- Input-kind type guards and validators (`requireJsonInput`, `requireJsonInputFromConfig`, etc.)
- Slice normalization with configurable precision (`normalizeSlices`, `slicesFromValues`)
- Risk validation (`isReserveRisk`)

`worker/src/cron/reserve-adapters/evm.ts` provides hex-level EVM call helpers for ERC-4626 vault introspection.

---

## Frontend Consumers

- `src/hooks/use-stablecoin-reserves.ts` fetches the resolved API shape with `staleTime = 1 hour` and `refetchInterval = 2 hours`
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses `coin.liveReservesConfig` for the structural `Live` reserve-coverage state on `/coverage`
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

## Scope Boundaries

- Live reserve sync is detail-page and status-surface infrastructure, not a replacement for curated reserve metadata everywhere else.
- [Risk Lab](./report-cards.md) uses live reserve snapshots for collateral quality scoring when
  available (v5.8+). Dependency inference, blacklist-inherited checks, and all other scoring
  dimensions still use curated reserve metadata.
- [Dependency Map](./dependency-map.md) remains authoritative for graph behavior; dependency edges still derive from curated/static reserve metadata plus manual dependencies.

---

## File Index

| File | Role |
|------|------|
| `shared/types/index.ts` | `LiveReservesConfig`, `StablecoinReservesResponse`, sync-state types |
| `shared/lib/stablecoins.ts` | Per-coin `liveReservesConfig` declarations |
| `worker/src/cron/sync-live-reserves.ts` | Hourly sync orchestration and cron result statuses |
| `worker/src/cron/reserve-adapters/index.ts` | Adapter registry |
| `worker/src/cron/reserve-adapters/helpers.ts` | Shared adapter fetch / normalization helpers |
| `worker/src/lib/live-reserves-store.ts` | D1 persistence, snapshot resolution, status overview, 48h freshness contract |
| `worker/src/api/stablecoin-reserves.ts` | Public API handler |
| `src/hooks/use-stablecoin-reserves.ts` | Frontend query hook |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Detail-page integration |
