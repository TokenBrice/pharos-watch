# Live Reserve Sync

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.

---

## Overview

- **Cron:** `sync-live-reserves` (`worker/src/cron/sync-live-reserves.ts`)
- **Schedule:** `11 * * * *` (hourly at :11 UTC)
- **Shared hourly lane:** after live reserve sync, the same slot runs redemption backstop sync, Kinesis supply sync, and collateral-drift checks / alerts (`worker/src/handlers/scheduled/hourly-live-reserves.ts`)
- **Current coverage:** 119 live-enabled stablecoins across 29 registered adapters
- **Storage:** `reserve_composition`, `reserve_composition_history`, `reserve_sync_state`, `reserve_sync_attempt_history`
- **API:** `GET /api/stablecoin-reserves/:id`
- **Frontend consumers:** `useStablecoinReserves()`, stablecoin detail view model, `/status` reserve-sync health
- **Operational telemetry:** `sync-live-reserves` emits per-coin progress into `cron_run_progress`, including the current coin, adapter, breaker key, and running synced / failed / skipped counters

This pipeline is intentionally separate from curated reserve metadata in `StablecoinMeta.reserves`. Live reserve sync affects live-enabled detail-page reserve views, status monitoring, and (since v5.8, tightened in v6.2 and v6.5) collateral quality scoring in report cards. The dependency map and all other scoring dimensions still derive from curated/static reserve metadata.

---

## Metadata Contract

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/live-reserves.ts`, loaded from `shared/data/stablecoins/*.json` via `shared/lib/stablecoins/index.ts` and validated by `shared/lib/stablecoins/schema.ts`).

`LiveReservesConfig` fields:

| Field | Meaning |
|-------|---------|
| `adapter` | Registered adapter key from `shared/lib/live-reserve-adapters.ts` |
| `version` | Increment when adapter semantics or parsing change materially |
| `semantics` | One of `collateral-mix`, `protocol-reserve`, `attestation-mix`, `single-asset` |
| `breakerScope` | Optional circuit-breaker grouping override; defaults to adapter key |
| `display` | Optional UI/source link metadata (`url`, `label`) |
| `inputs.primary` | Primary source input |
| `inputs.fallbacks` | Optional fallback inputs |
| `params` | Adapter-specific validated settings enforced by the shared live-reserve config schema |

### Registry-Defined Adapter Classes

The shared registry in `shared/lib/live-reserve-adapters.ts` defines two important adapter properties that are not user-configured per coin:

| Property | Meaning |
|----------|---------|
| `sourceModel` | Distinguishes `dynamic-mix`, `validated-static`, and `single-bucket` reserve shapes |
| `evidenceClass` | Distinguishes scoring-eligible `independent` feeds from `static-validated` and `weak-live-probe` feeds |
| `sharedSourceMode` | Distinguishes per-coin fetches (`none`) from explicitly source-invariant result sharing (`source-invariant`) |

- `dynamic-mix`: independently measured reserve compositions. These can be `independent` evidence for scoring when the sync state is clean.
- `validated-static`: live validation/probe adapters over curated/static slices. These remain authoritative for the reserve detail API, but they are tagged `static-validated` and do not count as independent live collateral inputs for report-card scoring.
- `single-bucket`: one-slice live proofs/attestations. Some are true independent evidence (`chainlink-nav`, `chainlink-por`, `erc4626-single-asset`, `btcfi`, `sgforge-coinvertible`), while weak liveness-only probes such as `single-asset` and generic attestation summaries such as `tether` are tagged `weak-live-probe`.
- `independent`: scoring-eligible live evidence when the snapshot is fresh, authoritative, and the most recent sync status is `ok`.
- `static-validated`, `weak-live-probe`: detail/status-visible evidence classes that never override curated collateral scoring.
- `source-invariant`: opt-in within-run result sharing for adapters whose returned payload is coin-invariant. All other adapters run per coin even when configs look similar.

### Fallback Inputs

`inputs.fallbacks` is implemented in `runAdapter()` inside `worker/src/cron/sync-live-reserves.ts`.

- The cron tries `inputs.primary` first.
- If the adapter throws, the orchestrator retries the same adapter against each fallback by temporarily swapping that fallback into `inputs.primary`.
- If every fallback fails, the original primary error is surfaced and the normal breaker/error path runs.

USDD currently uses this path: the cron retries `latest-collateral` on Ethereum if the Tron source fails, and the adapter now derives the matching `collateral-history` URL from whichever chain endpoint is active so fallback freshness stays chain-consistent.

Supported input kinds:

| Kind | Meaning |
|------|---------|
| `http-json` | JSON API endpoint |
| `http-html` | HTML page parsed by the adapter |
| `indexer` | Indexed external data feed |
| `onchain-evm` | On-chain EVM reads via `etherscan-proxy`, `alchemy`, or `public-rpc` |

### Snapshot Metadata and Warning Effects

Successful adapters can attach structured snapshot metadata that is stored on the authoritative snapshot row (`reserve_composition.metadata`), not on the mutable latest-attempt state.

Common metadata fields:

| Field | Meaning |
|-------|---------|
| `sourceTimestamp` | Upstream disclosure timestamp, when independently verified |
| `freshnessMode` | `verified`, `unverified`, or `not-applicable` |
| `details.freshnessSource` / `details.freshnessReason` | Adapter-supplied explanation when freshness is explicitly unverified |
| `unknownExposurePct` | Share of reserve value that could not be mapped cleanly |
| `supplyUsd`, `totalReserveUsd` | Adapter-level balance-sheet totals when exposed |
| `immediateRedeemableUsd`, `immediateRedeemableRatio` | Current redeemable-capacity telemetry reused by redemption backstops |
| `redemptionFeeBps` | Current live redemption fee telemetry when the source exposes it |
| `buyFeeBpsMin`, `buyFeeBpsMax` | Optional raw buy-fee range context retained alongside normalized `redemptionFeeBps` |

`freshnessMode = "not-applicable"` is the expected scoring-eligible path for intrinsically current on-chain reads such as `evm-branch-balances`, where reserve composition comes from latest-state contract balances rather than a separately timestamped disclosure.

Warnings now carry both a display `severity` and an execution `effect`:

| Effect | Meaning |
|--------|---------|
| `info` | Informational only; the snapshot can still be stored and remain `ok` |
| `degraded` | Snapshot is stored, but the per-coin sync state becomes `degraded` and the feed is excluded from independent scoring passthrough |
| `fatal` | Snapshot is rejected and the attempt is recorded as an `error` |

---

## Cron Behavior

`runHourlyReserveSyncSlot()` in `worker/src/handlers/scheduled/hourly-live-reserves.ts` runs the reserve cron on its own trigger so reserve-adapter fetches do not compete with the 30-minute scoring lane or the daily 08:00 jobs.

`syncLiveReserves()`:

1. Filters `ACTIVE_STABLECOINS` to the coins that declare `liveReservesConfig`.
2. Resolves an adapter from `worker/src/cron/reserve-adapters/index.ts`.
3. Builds a breaker key as `live-reserves:${breakerScope ?? adapter}`.
4. Checks the per-source circuit breaker before each coin fetch.
5. Persists either a fresh snapshot (`reserve_composition`) plus sync-state row, or an error/degraded/skipped sync-state row.

**Adapter output validation:** After each adapter returns, `validateAdapterOutput()` checks
that all slice `risk` values are valid enum members, all `pct` values are finite and strictly positive,
the slice list is non-empty, and the sum is within 2 points of 100%. Invalid output is treated as
an error. Sum deviation above 0.5 points produces a `degraded` warning, while deviation above 2 points
hard-fails the adapter output with a `fatal` warning.

Adapters can also declare shared validation policy in the registry:

- `maxSourceAgeSec`: if adapter metadata includes `sourceTimestamp` and the upstream disclosure is older than the policy allows, the sync is marked `degraded`
- `maxUnknownExposurePct`: if adapter metadata includes `unknownExposurePct` and unmapped reserve exposure is material, the sync is marked `degraded`
- when `maxSourceAgeSec` exists but the adapter can only attest freshness heuristically, `freshnessMode = "unverified"` produces an informational `freshness-unverified` warning instead of forcing a degraded status on the sync itself
- timestamp-less dashboard/API feeds should also populate `details.freshnessSource` / `details.freshnessReason` so the lack of verified recency is explicit in stored metadata

These policy warnings still preserve the last-known live snapshot for detail/status surfaces, but they keep the snapshot out of report-card collateral passthrough because scoring only accepts independent snapshots whose latest sync state is `ok`.

**Circuit breaker recording:** Breaker outcomes are deferred until the entire sync loop
completes, recording the worst outcome per breaker key (failure trumps success). This
prevents first-coin-wins bias where a successful early coin would mask failures of later
coins sharing the same breaker key.

Cron result statuses:

| Status | When |
|--------|------|
| `ok` | At least one configured coin synced, and `failed + skipped <= ceil(total * 0.1)` |
| `degraded` | At least one configured coin synced, and `failed + skipped > ceil(total * 0.1)` |
| `error` | No configured coin synced successfully and at least one coin failed or was skipped |

Per-coin warnings still matter operationally, but they affect `reserve_sync_state.last_status` for that coin (`degraded`) and the cron metadata warning list, not the run-level `CronResult.status`.

The cron loop is sequential. This is deliberate: reserve adapters can hit multiple heterogeneous sources, and the isolated hourly trigger keeps connection pressure predictable. The leased wrapper now gives `sync-live-reserves` an explicit 12-minute wall-clock budget, and the cron itself reports `setup`, `syncing`, and `finalizing` progress stages so `/status` can show which coin is currently in flight. Within a run, fetched results are only reused when the adapter registry marks the adapter as `source-invariant` (currently `m0`, `mento`, and `sky-makercore`); coin-aware adapters such as `frax` never share cached results across coins.

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
| `metadata` | Snapshot-scoped adapter telemetry (freshness, redeemable capacity, live fee, disclosure totals, etc.) |
| `warning_count` / `warnings` | Warning summary persisted alongside the successful snapshot |
| `adapter_source_model` / `adapter_evidence_class` | Registry-derived classification copied onto the snapshot row for authoritative reads |

### `reserve_composition_history`

Append-only history of successful live snapshots. Every successful upsert also inserts a history row carrying the same slices, metadata, warnings, and adapter classification fields as the latest-snapshot table. The hourly reserve cron prunes rows older than 90 days.

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
| `metadata` | Attempt-scoped operational metadata only (for example skip/failure reasons or warning-effect counts), not authoritative reserve telemetry |

### `reserve_sync_attempt_history`

Append-only history of all reserve-sync attempts, including `ok`, `degraded`, `error`, and `skipped` outcomes with their warnings, error message, and attempt-scoped metadata. The hourly reserve cron prunes rows older than 90 days.

Freshness and consistency rules now live across the `worker/src/lib/live-reserves-store*.ts` helper family, with `worker/src/lib/live-reserves-store.ts` kept as the public facade:

- `LIVE_RESERVE_FRESHNESS_SEC = 172800` (48 hours)
- A live snapshot only counts as consistent when `reserve_sync_state.last_success_at === reserve_composition.fetched_at`
- Stored snapshots are parsed strictly: unreadable JSON, invalid payloads, empty slice arrays, invalid slices, or materially invalid sums are rejected instead of being partially served
- `loadFreshAuthoritativeReserveSnapshots()` is the canonical resolver used by `GET /api/stablecoin-reserves/:id` and reserve-sync status surfaces
- `loadFreshIndependentLiveReserveMap()` further filters authoritative snapshots to `evidenceClass = independent`, `reserve_sync_state.last_status = "ok"`, **and** scoring-eligible freshness evidence. In practice that means the snapshot must either carry a verified `sourceTimestamp` path or explicitly mark freshness as `not-applicable` / `verified`; `freshnessMode = "unverified"` no longer qualifies for collateral passthrough.
- `getLatestSuccessfulReserveSnapshotMetadata()` is the canonical accessor for downstream consumers that need snapshot telemetry such as redeemable capacity or live redemption fees
- failed `reserve_sync_state` / `reserve_sync_attempt_history` rows now also retain `metadata.failureCategory` so parser drift, network issues, upstream HTTP failures, validation failures, and storage write failures are distinguishable without log grep
- authoritative `live` / `live-stale` API responses now also carry a `provenance` envelope so the frontend can distinguish independent live disclosure from static-validation and weak-proof paths

`computeReserveCompositionOverview()` aggregates the status-card summary used by `/status`:

- `configuredCoins`
- `freshCoins`
- `staleCoins`
- `missingCoins`
- `degradedCoins`
- `errorCoins`
- `corruptCoins`
- `independentFreshEligible`
- `independentFreshUnverified`
- `staticValidatedFresh`
- `weakProbeFresh`
- `writeTimeoutUncertain`
- `lastSuccessAt`
- `oldestFreshAgeSec`

`errorCoins` includes active adapter failures even before a coin has ever produced a successful live snapshot; those rows no longer remain hidden inside `missingCoins`.
`corruptCoins` counts rows where a matching latest-success snapshot exists in D1 but fails strict integrity validation, so the system fails closed to fallback presentation instead of serving truncated or malformed live data.
When a coin has both an old latest-success snapshot and a newer failing attempt state, the overview now prioritizes the active `error` / `degraded` attempt classification over generic `stale` labeling so status surfaces better reflect live incidents.
`writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path, meaning the worker could not prove whether the attempted write became authoritative.

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

`live` / `live-stale` only apply when the stored snapshot matches the latest successful sync state and passes strict integrity validation. Orphaned partial writes or corrupt stored snapshots fail closed to the fallback modes.

Cache control:

| Response mode | Cache-Control |
|---------------|---------------|
| `live` | `public, s-maxage=3600, max-age=300` |
| `live-stale`, fallback / unavailable modes | `public, s-maxage=300, max-age=60` |

The optional `provenance` object is present only when the response is serving an authoritative `live` or `live-stale` snapshot:

| Field | Meaning |
|-------|---------|
| `evidenceClass` | `independent`, `static-validated`, or `weak-live-probe` |
| `sourceModel` | `dynamic-mix`, `validated-static`, or `single-bucket` |
| `freshnessMode` | Optional explicit freshness policy (`verified`, `unverified`, `not-applicable`) |
| `scoringEligible` | Whether the current snapshot is eligible for collateral-quality passthrough right now |

The optional `sync` object exposes the last operational state:

| Field | Meaning |
|-------|---------|
| `enabled` | Coin is live-enabled |
| `status` | Last sync status (`ok`, `degraded`, `error`, `skipped`) |
| `stale` | Latest successful live snapshot is older than 48 hours |
| `bootstrap` | No successful live snapshot has been recorded yet |
| `lastAttemptedAt` | Latest attempt timestamp, when present |
| `lastSuccessAt` | Latest success timestamp, when present |
| `warnings[]` | Warning messages surfaced by the latest attempt and, when relevant, storage-integrity warnings injected by the fail-closed resolver |
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
| `accountable` | `http-json` | `protocol-reserve` | 7 |
| `asymmetry` | `http-json` | `collateral-mix` | 1 |
| `btcfi` | `http-json` | `collateral-mix` | 1 |
| `chainlink-nav` | `onchain-evm` | `single-asset` | 3 |
| `chainlink-por` | `onchain-evm` | `attestation-mix` | 1 |
| `circle-transparency` | `http-html` | `attestation-mix` | 2 |
| `collateral-positions-api` | `http-json` | `collateral-mix` | 2 |
| `crvusd` | `http-json` | `collateral-mix` | 1 |
| `curated-validated` | `onchain-evm` | `attestation-mix` / `collateral-mix` | 24 |
| `dola-inverse` | `http-json` | `collateral-mix` | 1 |
| `erc4626-single-asset` | `onchain-evm` | `single-asset` | 2 |
| `ethena` | `http-json` | `collateral-mix` | 1 |
| `evm-branch-balances` | `onchain-evm` | `collateral-mix` | 3 |
| `falcon` | `http-json` | `collateral-mix` | 1 |
| `fdusd-transparency` | `http-html` | `attestation-mix` | 1 |
| `frax` | `http-json` | `attestation-mix` | 2 |
| `fx` | `http-json` | `collateral-mix` | 1 |
| `gho` | `onchain-evm` | `protocol-reserve` | 1 |
| `infinifi` | `http-json` | `collateral-mix` | 1 |
| `m0` | `http-json` | `protocol-reserve` | 4 |
| `mento` | `http-html` | `collateral-mix` | 3 |
| `openeden-usdo` | `http-json` | `collateral-mix` | 1 |
| `re-metrics` | `http-html` | `collateral-mix` | 1 |
| `reservoir` | `http-json` | `protocol-reserve` | 1 |
| `sgforge-coinvertible` | `http-html` | `attestation-mix` | 1 |
| `single-asset` | `onchain-evm` / `http-json` | `single-asset` | 48 |
| `sky-makercore` | `http-json` | `collateral-mix` | 2 |
| `tether` | `http-json` | `attestation-mix` | 1 |
| `usdd-data-platform` | `http-json` | `collateral-mix` | 1 |

GHO-specific note:
the `gho` adapter now values reviewed mainnet GSM backing directly from live onchain GSM state and leaves the remainder of GHO supply in an aggregated residual issuance / reserve-buffer slice. `immediateRedeemableUsd` only counts GSM modules that are not frozen or seized, while `redemptionFeeBps` is normalized to the current worst tracked GSM buy fee and the raw min/max values are retained as `buyFeeBpsMin` / `buyFeeBpsMax`.

Adapter helpers are centralized in `worker/src/cron/reserve-adapters/helpers.ts`:

- HTTP JSON / HTML fetch wrappers (`fetchJsonWithRetry`, `fetchTextWithRetry`)
- HTML parser failure helpers that distinguish upstream layout drift (`layout-changed`) from content decoding failures (`parse-failed`) so attempt logs are more actionable for scraped disclosures
- Shared bucketed-composition accumulation for adapters that classify many raw assets into a smaller reserve-bucket surface while tracking unknown exposure consistently
- Shared unverified-freshness metadata helper so timestamp-less dashboard feeds explain why they remain non-scoring
- DefiLlama spot-price loading for valuation (`fetchDefiLlamaPrices`), with fixed-price overrides supported for wrapper branches in `evm-branch-balances`
- EVM balance, total-supply, and hex-call reads (`fetchErc20Balance`, `fetchErc20TotalSupply`)
- Input-kind type guards and validators (`requireJsonInput`, `requireJsonInputFromConfig`, etc.)
- Slice normalization with configurable precision (`normalizeSlices`, `slicesFromValues`)
- Risk validation (`isReserveRisk`)

`worker/src/cron/reserve-adapters/evm.ts` provides hex-level EVM call helpers for ERC-4626 vault introspection.

---

## Frontend Consumers

- `src/hooks/use-stablecoin-reserves.ts` uses mode-aware polling: `live` responses keep `staleTime = 1 hour` / `refetchInterval = 2 hours`, while stale or fallback modes tighten to `1 minute` / `2 minutes` so the UI re-checks recovery faster
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses `coin.liveReservesConfig` for the structural `Live` reserve-coverage state on `/coverage`
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

## Scope Boundaries

- Live reserve sync is detail-page and status-surface infrastructure, not a replacement for curated reserve metadata everywhere else.
- [Risk Lab](./report-cards.md) uses fresh authoritative independent live reserve snapshots for collateral quality scoring when available. In practice this now means: `dynamic-mix` adapters can qualify when their latest sync state is `ok` **and** the snapshot carries scoring-eligible freshness evidence, only a subset of `single-bucket` adapters carry `evidenceClass = independent`, and `validated-static` / `weak-live-probe` feeds remain detail-card/status data only. Dependency inference stays curated-only, but blacklist attribution can consume enriched live reserve slices when they exist.
- Blacklist attribution no longer treats live reserves as invisible just because most adapters lack `coinId` links. The report-card resolver enriches both live and curated reserve names with the same blacklist clue pipeline, then resolves inherited exposure to a fixed point across the tracked set so cyclic upstream graphs do not depend on traversal order. The collateral drift alert still flags when live collateral quality diverges materially from curated metadata.
- [Dependency Map](./dependency-map.md) remains authoritative for graph behavior; dependency edges still derive from curated/static reserve metadata plus manual dependencies.

---

## File Index

| File | Role |
|------|------|
| `shared/types/live-reserves.ts` | `LiveReservesConfig`, `StablecoinReservesResponse`, sync-state types |
| `shared/lib/live-reserve-adapters.ts` | Shared adapter registry, source/evidence classes, validation policy, and config schemas |
| `shared/lib/stablecoins/index.ts` | Loader for per-coin `liveReservesConfig` declarations backed by `shared/data/stablecoins/*.json` |
| `worker/src/cron/sync-live-reserves.ts` | Hourly sync orchestration and cron result statuses |
| `worker/src/cron/reserve-adapters/index.ts` | Adapter registry |
| `worker/src/cron/reserve-adapters/helpers.ts` | Shared adapter fetch / normalization helpers |
| `worker/src/lib/live-reserves-store.ts` | Public facade over the live-reserve store helpers |
| `worker/src/lib/live-reserves-store-read.ts` | D1 read/query helpers and authoritative row loaders |
| `worker/src/lib/live-reserves-store-write.ts` | D1 write paths and history pruning |
| `worker/src/lib/live-reserves-store-view.ts` | Snapshot resolution, status overview, metadata views, 48h freshness contract |
| `worker/src/lib/live-reserves-store-shared.ts` | Shared live-reserve store types, constants, and row mapping |
| `worker/src/api/stablecoin-reserves.ts` | Public API handler |
| `src/hooks/use-stablecoin-reserves.ts` | Frontend query hook |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Detail-page integration |
