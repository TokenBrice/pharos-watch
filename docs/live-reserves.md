# Live Reserve Sync

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.

---

## Overview

- **Cron:** `sync-live-reserves` (`worker/src/cron/sync-live-reserves.ts`)
- **Schedule:** `11 */4 * * *` (every 4 hours at :11 UTC)
- **Shared 4-hourly lane:** after live reserve sync, the same slot runs redemption backstop sync, Kinesis supply sync, and collateral-drift checks / alerts (`worker/src/handlers/scheduled/hourly-live-reserves.ts`)
- **Current coverage:** 152 live-enabled stablecoins across 44 registered adapters; 43 adapter keys are currently configured by `shared/data/stablecoins/*.json`
- **Storage:** `reserve_composition`, `reserve_composition_history`, `reserve_sync_state`, `reserve_sync_attempt_history`
- **API:** `GET /api/stablecoin-reserves/:id`
- **Frontend consumers:** `useStablecoinReserves()`, stablecoin detail view model, `/status` reserve-sync health
- **Operational telemetry:** `sync-live-reserves` emits per-coin progress into `cron_run_progress`, including the current coin, adapter, breaker key, and running synced / failed / skipped counters

This pipeline is intentionally separate from curated reserve metadata in `StablecoinMeta.reserves`. Live reserve sync affects live-enabled detail-page reserve views, status monitoring, and (since v5.8, tightened in v6.2 and v6.5) collateral quality scoring in report cards only when a snapshot is score-grade. A configured live adapter is not enough by itself: the report-card snapshot must use a fresh, clean, independent live reserve snapshot before `collateralFromLive` becomes true. The dependency map and all other scoring dimensions still derive from curated/static reserve metadata.

---

## Metadata Contract

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/live-reserves.ts`, loaded from `shared/data/stablecoins/*.json` via `shared/lib/stablecoins/index.ts` and validated by `shared/lib/stablecoins/schema.ts`).

`LiveReservesConfig` fields:

| Field              | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `adapter`          | Registered adapter key from `shared/lib/live-reserve-adapters.ts`                     |
| `version`          | Increment when adapter semantics or parsing change materially                         |
| `semantics`        | One of `collateral-mix`, `protocol-reserve`, `attestation-mix`, `single-asset`        |
| `breakerScope`     | Optional circuit-breaker grouping override; defaults to adapter key                   |
| `display`          | Optional UI/source link metadata (`url`, `label`)                                     |
| `inputs.primary`   | Primary source input                                                                  |
| `inputs.fallbacks` | Optional fallback inputs                                                              |
| `params`           | Adapter-specific validated settings enforced by the shared live-reserve config schema |

### Registry-Defined Adapter Classes

The shared registry in `shared/lib/live-reserve-adapters.ts` defines two important adapter properties that are not user-configured per coin:

| Property           | Meaning                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `sourceModel`      | Distinguishes `dynamic-mix`, `validated-static`, and `single-bucket` reserve shapes                          |
| `evidenceClass`    | Distinguishes scoring-eligible `independent` feeds from `static-validated` and `weak-live-probe` feeds       |
| `sharedSourceMode` | Distinguishes per-coin fetches (`none`) from explicitly source-invariant result sharing (`source-invariant`) |

- `dynamic-mix`: independently measured reserve compositions. These can be `independent` evidence for scoring when the sync state is clean.
- `validated-static`: live validation/probe adapters over curated/static slices. These remain authoritative for the reserve detail API, but they are tagged `static-validated` and do not count as independent live collateral inputs for report-card scoring.
- `single-bucket`: one-slice live proofs/attestations. Some are true independent evidence (`btcfi`, `chainlink-nav`, `chainlink-por`, `erc4626-single-asset`, `liquity-v1`, `sgforge-coinvertible`, `superstate-liquidity`, `usd1-bundle-oracle`), while weak liveness-only probes such as `single-asset` and coarse issuer attestation summaries such as `tether` are tagged `weak-live-probe`.
- `independent`: scoring-eligible live evidence when the snapshot is fresh, authoritative, and the most recent sync status is `ok`.
- `static-validated`, `weak-live-probe`: detail/status-visible evidence classes that never override curated collateral scoring.
- `source-invariant`: opt-in within-run result sharing for adapters whose returned payload is coin-invariant. All other adapters run per coin even when configs look similar.

`single-asset` now supports optional `reserveProbe`, `supplyProbe`, and `timestampProbe` paths so weak single-bucket feeds can persist honest reserve/supply ratio telemetry when the upstream exposes it. The family remains `weak-live-probe` unless the source is strong enough to justify promotion into a more independent adapter class.

### Fallback Inputs

`inputs.fallbacks` is implemented in `runAdapter()` inside `worker/src/cron/sync-live-reserves.ts`.

- The cron tries `inputs.primary` first.
- If the adapter throws, the orchestrator retries the same adapter against each fallback by temporarily swapping that fallback into `inputs.primary`.
- If every fallback fails, the original primary error is surfaced and the normal breaker/error path runs.

USDD currently uses this path: the cron retries `latest-collateral` on Ethereum if the Tron source fails, and the adapter now derives the matching `collateral-history` URL from whichever chain endpoint is active so fallback freshness stays chain-consistent.

Supported input kinds:

| Kind          | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `http-json`   | JSON API endpoint                                                    |
| `http-html`   | HTML page parsed by the adapter                                      |
| `indexer`     | Indexed external data feed                                           |
| `onchain-solana` | On-chain Solana mint-supply reads via the public mainnet RPCs       |
| `onchain-evm` | On-chain EVM reads via `etherscan-proxy`, `alchemy`, or `public-rpc` |

The shared live-reserve config schema enforces adapter-specific primary and fallback input kinds. For example, `curated-validated` can use `onchain-evm` or `onchain-solana`, `single-asset` can use `http-json` or `onchain-evm`, and HTML scrapers such as `circle-transparency` cannot accidentally be configured with an on-chain input that would pass metadata validation but fail during cron execution.

`curated-validated` can now use `onchain-solana` when a tracked coin publishes its canonical Solana mint in `coin.contracts`, allowing the adapter to validate non-zero supply without downgrading the reserve mix to a weak single-bucket feed.

`onchain-solana` now tries three public RPCs in order before failing the adapter: `https://api.mainnet-beta.solana.com`, `https://api.mainnet.solana.com`, and `https://solana-rpc.publicnode.com`. This reduces false reserve incidents caused by single-endpoint Solana RPC reachability failures inside the Worker runtime.

Adapters can also pass browser-style request headers through the shared JSON retry helper when an upstream is sensitive to request origin hints. Ethena and Reservoir now do this because production failures showed Cloudflare Worker requests intermittently receiving HTML / network failures while the same endpoints still served healthy JSON to browser-like clients.

USDe's Ethena reserve config also keeps Ethena's main-domain collateral API as a same-provider JSON fallback for cases where the `app.ethena.fi` API route returns the dashboard HTML shell to Worker-origin requests.

DOLA's Inverse FiRM market adapter normalizes the upstream `timestamp` field through the shared timestamp parser because the API can emit JavaScript millisecond timestamps while reserve validation requires Unix seconds.

### Snapshot Metadata and Warning Effects

Successful adapters can attach structured snapshot metadata that is stored on the authoritative snapshot row (`reserve_composition.metadata`), not on the mutable latest-attempt state.

Common metadata fields:

| Field                                                           | Meaning                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `sourceTimestamp`                                               | Upstream disclosure timestamp, when independently verified                                      |
| `freshnessMode`                                                 | `verified`, `unverified`, or `not-applicable`                                                   |
| `collateralizationRatio`                                        | Reserve / liability or reserve / supply ratio when the adapter can quantify both sides honestly |
| `details.freshnessSource` / `details.freshnessReason`           | Adapter-supplied explanation when freshness is explicitly unverified                            |
| `unknownExposurePct`                                            | Share of reserve value that could not be mapped cleanly                                         |
| `supplyUsd`, `totalReserveUsd`                                  | Adapter-level reserve / supply totals when exposed                                              |
| `totalAssetsUsd`, `totalLiabilitiesUsd`, `shareholderEquityUsd` | Raw attestation balance-sheet totals for coarse issuer feeds                                    |
| `immediateRedeemableUsd`, `immediateRedeemableRatio`            | Current redeemable-capacity telemetry reused by redemption backstops                            |
| `redemptionFeeBps`                                              | Current live redemption fee telemetry when the source exposes it                                |
| `buyFeeBpsMin`, `buyFeeBpsMax`                                  | Optional raw buy-fee range context retained alongside normalized `redemptionFeeBps`             |
| `redemption.capacityUsd`, `redemption.capacityRatioOfSupply`    | Normalized redemption-capacity telemetry. New adapters should prefer this nested shape; legacy flat fields remain readable during migration |
| `redemption.capacityKind`, `redemption.freshnessKind`           | Typed redemption evidence tier and freshness basis used by redemption-backstop validation        |
| `redemption.routeStatus`, `redemption.routeStatusSource`, `redemption.routeStatusReason`, `redemption.routeStatusReviewedAt` | Optional current route availability signal and provenance, separate from reserve-sync status |
| `redemption.settlementDelaySec`, `redemption.queueDepthUsd`     | Optional queue/delay context for redemption routes that are current but not atomic              |
| `redemption.feeBps`                                             | Normalized current redemption fee in the nested telemetry contract                              |

Redemption telemetry is validated before persistence. Negative capacity, capacity ratios outside `0..1`, negative fees, capacity emitted by adapters that do not declare redemption-capacity support, fee telemetry emitted by adapters that do not declare fee support, and direct-capacity evidence emitted by proxy-only adapters fail the adapter output validation. Existing flat fields are still parsed for backward compatibility, but new adapter work should emit the nested `metadata.redemption` object.

`freshnessMode = "not-applicable"` is the expected scoring-eligible path for intrinsically current on-chain reads such as `evm-branch-balances`, `liquity-v1`, and `liquity-v2-branches`, where reserve composition comes from latest-state contract balances rather than a separately timestamped disclosure.

The registry now also declares the admissible `freshnessMode` set per adapter family so timestamp-backed disclosures, latest-state on-chain proofs, and explicitly unverified dashboard/API feeds cannot silently drift into undocumented freshness semantics.

Warnings now carry both a display `severity` and an execution `effect`:

| Effect     | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `info`     | Informational only; the snapshot can still be stored and remain `ok`                                                             |
| `degraded` | Snapshot is stored, but the per-coin sync state becomes `degraded` and the feed is excluded from independent scoring passthrough |
| `fatal`    | Snapshot is rejected and the attempt is recorded as an `error`                                                                   |

---

## Cron Behavior

`runFourHourlyReserveSyncSlot()` in `worker/src/handlers/scheduled/hourly-live-reserves.ts` runs the reserve cron on its own 4-hourly trigger so reserve-adapter fetches do not compete with the 30-minute scoring lane or the daily 08:00 jobs.

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

Source freshness validation also rejects source timestamps that are more than 10 minutes in the future, including nested redemption telemetry timestamps, so upstream clock mistakes or millisecond/second parsing errors cannot be treated as fresh snapshots. Multi-row reserve feeds should use the oldest material contributor timestamp as `sourceTimestamp` and can persist `latest*Timestamp` / `sourceTimestampSpreadSec` metadata for diagnostics.

Adapters can also declare shared validation policy in the registry:

- `maxSourceAgeSec`: if adapter metadata includes `sourceTimestamp` and the upstream disclosure is older than the policy allows, the sync is marked `degraded`
- `maxUnknownExposurePct`: if adapter metadata includes `unknownExposurePct` and unmapped reserve exposure is material, the sync is marked `degraded`
- `allowedFreshnessModes`: explicit per-adapter freshness contract enforced by output validation
- when `maxSourceAgeSec` exists but the adapter can only attest freshness heuristically, `freshnessMode = "unverified"` produces an informational `freshness-unverified` warning instead of forcing a degraded status on the sync itself
- timestamp-less dashboard/API feeds should also populate `details.freshnessSource` / `details.freshnessReason` so the lack of verified recency is explicit in stored metadata

Unknown exposure now follows one repo-wide policy:

- quantify it and persist `unknownExposurePct` when the adapter can do so honestly
- emit an explicit unknown slice when the reserve mix would otherwise hide that exposure
- use threshold-driven warning effects so immaterial unknowns stay informational and material unknowns degrade the sync
- fail closed when the adapter cannot quantify the missing exposure without inventing precision

These policy warnings still preserve the last-known live snapshot for detail/status surfaces, but they keep the snapshot out of report-card collateral passthrough because scoring only accepts independent snapshots whose latest sync state is `ok`.

**Circuit breaker recording:** Breaker outcomes are deferred until the entire sync loop
completes, recording the worst outcome per breaker key (failure trumps success). This
prevents first-coin-wins bias where a successful early coin would mask failures of later
coins sharing the same breaker key.

Cron result statuses:

| Status     | When                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| `ok`       | At least one configured coin synced, and `failed + skipped <= ceil(total * 0.1)`   |
| `degraded` | At least one configured coin synced, and `failed + skipped > ceil(total * 0.1)`    |
| `error`    | No configured coin synced successfully and at least one coin failed or was skipped |

Per-coin warnings still matter operationally, but they affect `reserve_sync_state.last_status` for that coin (`degraded`) and the cron metadata warning list, not the run-level `CronResult.status`.

The cron loop is sequential. This is deliberate: reserve adapters can hit multiple heterogeneous sources, and the isolated 4-hourly trigger keeps connection pressure predictable. Each adapter attempt also receives a per-attempt I/O limiter with a peak of 2 outbound HTTP/RPC operations, so internally parallel adapters such as GHO, Cap, Anzen, and crvUSD cannot consume the whole six-connection trigger pool. The leased wrapper now gives `sync-live-reserves` an explicit 12-minute wall-clock budget, and the cron itself reports `setup`, `syncing`, and `finalizing` progress stages so `/status` can show which coin is currently in flight. Within a run, fetched results are only reused when the adapter registry marks the adapter as `source-invariant` (currently `m0`, `mento`, and `sky-makercore`); coin-aware adapters such as `frax` never share cached results across coins. At the end of each run, the cron also removes stale operational artifacts for coins that are no longer live-enabled: orphaned `reserve_sync_state` rows and stale `cache.key = 'circuit:live-reserves:*'` entries are deleted so `/status` and `/api/health` stop surfacing removed reserve sources as active incidents after coverage changes.

---

## Storage Model

### `reserve_composition`

Latest successful live snapshot per live-enabled coin.

| Column                                            | Meaning                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `stablecoin_id`                                   | Canonical Pharos coin ID                                                                              |
| `slices`                                          | JSON-serialized `ReserveSlice[]`                                                                      |
| `fetched_at`                                      | Unix timestamp of the successful snapshot                                                             |
| `source`                                          | Adapter key that produced the snapshot                                                                |
| `metadata`                                        | Snapshot-scoped adapter telemetry (freshness, redeemable capacity, live fee, disclosure totals, etc.) |
| `warning_count` / `warnings`                      | Warning summary persisted alongside the successful snapshot                                           |
| `adapter_source_model` / `adapter_evidence_class` | Registry-derived classification copied onto the snapshot row for authoritative reads                  |
| `attempt_id`                                      | Attempt-fencing identifier for the successful snapshot when the writer stamped one                    |

### `reserve_composition_history`

Append-only history of successful live snapshots. Every successful upsert also inserts a history row carrying the same slices, metadata, warnings, and adapter classification fields as the latest-snapshot table. The 4-hourly reserve cron prunes rows older than 90 days.

### `reserve_sync_state`

Per-coin operational state for the most recent attempt.

| Column              | Meaning                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `stablecoin_id`     | Canonical Pharos coin ID                                                                                                                  |
| `adapter_key`       | Adapter used for the most recent attempt                                                                                                  |
| `breaker_key`       | Per-source circuit-breaker key                                                                                                            |
| `last_attempted_at` | Unix timestamp of the latest attempt                                                                                                      |
| `last_success_at`   | Unix timestamp of the latest successful live snapshot                                                                                     |
| `last_status`       | `ok`, `degraded`, `error`, or `skipped`                                                                                                   |
| `warning_count`     | Number of adapter warnings                                                                                                                |
| `warnings`          | JSON-serialized warning objects                                                                                                           |
| `last_error`        | Latest failure message, if any                                                                                                            |
| `metadata`          | Attempt-scoped operational metadata only (for example skip/failure reasons or warning-effect counts), not authoritative reserve telemetry |
| `last_attempt_id` / `pending_attempt_id` / `last_success_attempt_id` | Attempt-fencing identifiers used to reject orphaned or partially written live snapshots |

### `reserve_sync_attempt_history`

Append-only history of all reserve-sync attempts, including `ok`, `degraded`, `error`, and `skipped` outcomes with their warnings, error message, and attempt-scoped metadata. The 4-hourly reserve cron prunes rows older than 90 days.

Freshness and consistency rules now live across the `worker/src/lib/live-reserves-store*.ts` helper family, with `worker/src/lib/live-reserves-store.ts` kept as the public facade:

- `LIVE_RESERVE_FRESHNESS_SEC = 172800` (48 hours)
- A live snapshot only counts as consistent when `reserve_sync_state.last_success_at === reserve_composition.fetched_at` and, when attempt IDs are stamped, `reserve_sync_state.last_success_attempt_id === reserve_composition.attempt_id`
- Stored snapshots are parsed strictly: unreadable JSON, invalid payloads, empty slice arrays, invalid slices, or materially invalid sums are rejected instead of being partially served
- `resolveReserveResult()` is the canonical detail/API resolver used by `GET /api/stablecoin-reserves/:id`
- `computeReserveCompositionOverview()` is the status-summary resolver used by `/api/status` and `/admin/`
- `loadFreshIndependentLiveReserveMap()` further filters authoritative snapshots to `evidenceClass = independent`, `reserve_sync_state.last_status = "ok"`, **and** scoring-eligible freshness evidence for report-card/scoring consumers. In practice that means the snapshot must either carry a verified `sourceTimestamp` path or explicitly mark freshness as `not-applicable` / `verified`; `freshnessMode = "unverified"` no longer qualifies for collateral passthrough.
- `getLatestSuccessfulReserveSnapshotMetadata()` is the canonical accessor for downstream consumers that need snapshot telemetry such as redeemable capacity or live redemption fees
- failed `reserve_sync_state` / `reserve_sync_attempt_history` rows now also retain `metadata.failureCategory` so parser drift, network issues, upstream HTTP failures, validation failures, and storage write failures are distinguishable without log grep
- authoritative `live` / `live-stale` API responses now also carry a `provenance` envelope plus a separate `displayBadge` so the frontend can distinguish true live feeds from curated-validated and proof-style reserve views

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
- `persistentlyStaleIndependentCoins` (independent feeds older than the persistent-staleness window that can escalate status beyond normal short-lived lag)
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

| Mode                | Meaning                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `live`              | Fresh live snapshot from `reserve_composition`                                             |
| `live-stale`        | Live snapshot exists, but is older than 48 hours                                           |
| `curated-fallback`  | Live snapshot unavailable; falling back to curated `StablecoinMeta.reserves`               |
| `template-fallback` | Live snapshot unavailable; falling back to reserve templates from `getReserves()`          |
| `unavailable`       | Coin is live-enabled, but neither live data nor fallback reserve presentation is available |

`live` / `live-stale` only apply when the stored snapshot matches the latest successful sync state and passes strict integrity validation. Orphaned partial writes or corrupt stored snapshots fail closed to the fallback modes.

Cache control:

| Response mode                              | Cache-Control                        |
| ------------------------------------------ | ------------------------------------ |
| `live`                                     | `public, s-maxage=3600, max-age=300` |
| `live-stale`                               | `public, s-maxage=1800, max-age=120` |
| fallback / unavailable modes               | `public, s-maxage=300, max-age=60`   |

The optional `provenance` object is present only when the response is serving an authoritative `live` or `live-stale` snapshot:

| Field             | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `evidenceClass`   | `independent`, `static-validated`, or `weak-live-probe`                               |
| `sourceModel`     | `dynamic-mix`, `validated-static`, or `single-bucket`                                 |
| `freshnessMode`   | Optional explicit freshness policy (`verified`, `unverified`, `not-applicable`)       |
| `scoringEligible` | Whether the current snapshot is eligible for collateral-quality passthrough right now |

The optional `displayBadge` object is also present only for authoritative `live` / `live-stale` snapshots:

| Field   | Meaning                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `kind`  | `live`, `curated-validated`, or `proof`                                                              |
| `label` | User-facing badge text rendered on the detail page (`Live`, `Curated-Validated`, or `Proof`)        |

`displayBadge` is intentionally separate from `mode` and `provenance`:

- `mode` answers whether an authoritative snapshot exists and whether it is stale
- `provenance` answers scoring/evidence semantics
- `displayBadge` answers the honest user-facing reserve label

The optional `metadata` object is also present only for authoritative `live` / `live-stale` snapshots. It exposes the adapter snapshot metadata already stored with the reserve snapshot row so the UI can surface feed-specific context without re-querying D1. For example, `crvusd` now exposes `yieldBasisCollateralPct` when Yield Basis positions account for part of the live reserve mix.

The optional `sync` object exposes the last operational state:

| Field             | Meaning                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | Coin is live-enabled                                                                                                                |
| `status`          | Last sync status (`ok`, `degraded`, `error`, `skipped`)                                                                             |
| `stale`           | Latest successful live snapshot is older than 48 hours                                                                              |
| `bootstrap`       | No successful live snapshot has been recorded yet                                                                                   |
| `lastAttemptedAt` | Latest attempt timestamp, when present                                                                                              |
| `lastSuccessAt`   | Latest success timestamp, when present                                                                                              |
| `warnings[]`      | Warning messages surfaced by the latest attempt and, when relevant, storage-integrity warnings injected by the fail-closed resolver |
| `lastError`       | Most recent adapter error message (truncated to 200 chars), when present                                                            |

### Edge Cache Implications for Monitoring

When a coin has `mode="live"`, the response is edge-cached for 1 hour (`s-maxage=3600`). If the adapter starts failing _after_ a successful response was cached:

- The public API will continue serving the **cached successful response** for up to 1 hour
- The `sync` object in the cached response will show the **previous** sync state, not the current failure
- Operators querying the public API will not see the error status until the edge cache expires

**For real-time monitoring**, use the Access-gated admin surface (`/admin/`, backed by admin-only `GET /api/status`), which is never edge-cached and always reflects current D1 state.

Fallback, template-fallback, and unavailable responses use a shorter edge cache (`s-maxage=300`, 5 minutes), so status transitions from fallback modes propagate faster. `live-stale` responses use an intermediate cache (`s-maxage=1800`, 30 minutes); fully live responses use `s-maxage=3600` (1 hour).

---

## Adapter Registry

Registered in `worker/src/cron/reserve-adapters/index.ts`.
This table reflects the adapter keys currently configured in `shared/data/stablecoins/*.json`; the runtime registry also retains unconfigured implementations.

| Adapter                    | Primary input               | Semantics                            | Configured coins |
| -------------------------- | --------------------------- | ------------------------------------ | ---------------- |
| `abracadabra`              | `onchain-evm`               | `collateral-mix`                     | 1                |
| `accountable`              | `http-json`                 | `collateral-mix` / `protocol-reserve` | 7               |
| `anzen-usdz`               | `onchain-evm`              | `single-asset`                       | 1                |
| `asymmetry`                | `http-json`                 | `collateral-mix`                     | 1                |
| `btcfi`                    | `http-json`                 | `collateral-mix`                     | 1                |
| `buck-io-transparency`     | `http-html`                 | `attestation-mix`                    | 1                |
| `cap-vault`                | `onchain-evm`               | `protocol-reserve`                   | 1                |
| `chainlink-nav`            | `onchain-evm`               | `single-asset`                       | 6                |
| `chainlink-por`            | `onchain-evm`               | `attestation-mix`                    | 1                |
| `circle-transparency`      | `http-html`                 | `attestation-mix`                    | 2                |
| `collateral-positions-api` | `http-json`                 | `collateral-mix`                     | 2                |
| `crvusd`                   | `http-json`                 | `collateral-mix`                     | 1                |
| `curated-validated`        | `onchain-evm` / `onchain-solana` | `attestation-mix` / `collateral-mix` / `single-asset` | 34 |
| `dola-inverse`             | `http-json`                 | `collateral-mix`                     | 1                |
| `erc4626-single-asset`     | `onchain-evm`               | `single-asset`                       | 2                |
| `ethena`                   | `http-json`                 | `collateral-mix`                     | 1                |
| `evm-branch-balances`      | `onchain-evm`               | `collateral-mix`                     | 4                |
| `falcon`                   | `http-json`                 | `collateral-mix`                     | 1                |
| `fdusd-transparency`       | `http-html`                 | `attestation-mix`                    | 1                |
| `frax-balance-sheet`       | `http-json`                 | `attestation-mix`                    | 3                |
| `fx`                       | `http-json`                 | `collateral-mix`                     | 1                |
| `gho`                      | `onchain-evm`               | `protocol-reserve`                   | 1                |
| `infinifi`                 | `http-json`                 | `collateral-mix`                     | 1                |
| `jupusd`                   | `http-json`                 | `collateral-mix`                     | 1                |
| `liquity-v1`               | `onchain-evm`               | `single-asset`                       | 1                |
| `liquity-v2-branches`      | `onchain-evm`               | `collateral-mix`                     | 6                |
| `lista`                    | `onchain-evm`               | `collateral-mix`                     | 1                |
| `m0`                       | `http-json`                 | `protocol-reserve`                   | 10               |
| `mento`                    | `http-html`                 | `collateral-mix`                     | 2                |
| `openeden-usdo`            | `http-json`                 | `collateral-mix`                     | 1                |
| `re-metrics`               | `http-html`                 | `collateral-mix`                     | 1                |
| `reservoir`                | `http-json`                 | `protocol-reserve`                   | 1                |
| `river-protocol-info`      | `http-json`                 | `protocol-reserve`                   | 1                |
| `sgforge-coinvertible`     | `http-html`                 | `attestation-mix`                    | 1                |
| `single-asset`             | `http-json` / `onchain-evm` | `single-asset`                       | 42               |
| `sky-makercore`            | `http-json`                 | `collateral-mix`                     | 2                |
| `solstice-attestation`     | `http-json`                 | `protocol-reserve`                   | 1                |
| `superstate-liquidity`     | `onchain-evm` + `http-json` | `single-asset`                       | 1                |
| `usdgo-transparency`       | `http-json`                 | `attestation-mix`                    | 1                |
| `usdai-proof-of-reserves`  | `http-json`                 | `collateral-mix`                     | 1                |
| `usd1-bundle-oracle`       | `onchain-evm`               | `single-asset`                       | 1                |
| `usdd-data-platform`       | `http-json`                 | `collateral-mix`                     | 1                |
| `usdh-native-markets`      | `http-html`                 | `attestation-mix`                    | 1                |

`collateral-positions-api` can now optionally attach direct redemption-capacity telemetry alongside the collateral mix when a reviewed bridge-backed stable exit exists. `zchf-frankencoin` uses this path to publish the current VCHF StablecoinBridge inventory as `immediateRedeemableUsd` for redemption-backstop modeling without changing the reserve-slice composition itself.

`cap-vault` reads Cap cUSD's Ethereum vault state directly. Reserve slices are based on each supported asset's total supplied balance, while redemption-capacity telemetry uses unpaused available balances after borrows so the route does not treat borrowed or paused collateral as immediate exit capacity. The adapter emits nested `metadata.redemption` with `capacityKind = "live-direct-bounded"` and `freshnessKind = "same-run-onchain"`.

`circle-transparency`, `m0`, and `mento` preserve source freshness when their upstream pages/API expose usable reserve disclosure or update timestamps: Circle uses the public reserve `As of` date, M0 uses the latest collateral/update timestamp exposed by its GraphQL schema, and Mento uses the embedded reserve-holding `updated` timestamps. When those timestamps are missing, the adapters keep `freshnessMode = "unverified"` and remain detail-visible without report-card collateral passthrough.

`asymmetry` preserves the protocol API's top-level timestamp as verified freshness when available and normalizes branch symbols before classification, so casing-only variants such as `wBTC` do not degrade an otherwise mapped USDaf reserve mix.

`usdai-proof-of-reserves` consumes USD.AI's public proof-of-reserves API, preserves oversized fixed-point `share` and `amount` integers from the raw JSON payload, groups the many hardware-loan `DEAL` rows into a single high-risk loan slice, and exposes liquid reserve buckets such as PYUSD separately. The adapter prefers explicit `share` weights when the share-bearing rows already cover the full published mix, ignores auxiliary amount-only rows in that case with an informational warning, and falls back to `amount` weighting only if the feed stops publishing share values entirely. Because the API endpoint itself does not publish a trustworthy disclosure timestamp, the adapter hydrates verified freshness from USD.AI's public reserves page when available; otherwise snapshots stay `freshnessMode = "unverified"`. As of April 4, 2026, Pharos binds this mixed reserve feed to `susdai-usd-ai`, not to base `usdai-usd-ai`, because the public API is protocol/yield-side collateral rather than a clean base-token reserve proof.

`crvusd` now combines the direct Ethereum LLAMMA collateral feed from `https://prices.curve.finance/v1/crvusd/markets` with on-chain Yield Basis exposure. The adapter walks the Ethereum Yield Basis factory (`factory.yieldbasis.eth`), unwraps each market's LT position with `preview_emergency_withdraw(totalSupply)`, values the resulting external asset balances with DefiLlama prices, and folds those balances into the same BTC / ETH reserve buckets as the direct Curve markets. `crvusd-curve` config version `2` marks that semantic expansion.

GHO-specific note:
the `gho` adapter values reviewed mainnet GSM backing directly from live onchain GSM state and then decomposes the remainder of GHO supply across the active facilitator registry. Each residual slice is classified by facilitator label into `aave-v3-direct` (medium risk), `flashminter` (high risk), or `unknown` (high risk). The unknown-labeled share is accumulated into `metadata.unknownExposurePct` so the standard `material-unknown-exposure` validator governs whether a residual slice degrades the sync, rather than a GHO-specific aggregated-residual warning. If no facilitator labels are readable in a run (for example the registry call fails), the entire residual is treated as unknown so the fail-closed policy still applies. `immediateRedeemableUsd` only counts GSM modules that are not frozen or seized, while `redemptionFeeBps` is normalized to the current worst tracked GSM buy fee and the raw min/max values are retained as `buyFeeBpsMin` / `buyFeeBpsMax`. Follow-up Path D (direct `GhoReserve` / `GhoDirectFacilitator` / RemoteGSM reads) is tracked in `agents/tasks/reserve-coverage-tracker.md` pending verified Aave deployment addresses.

Liquity v1 note:
the `liquity-v1` adapter covers `lusd-liquity` by reading `getEntireSystemColl()` and `getEntireSystemDebt()` from the official Ethereum `TroveManager`, preserving LUSD as a one-slice 100% ETH reserve view while classifying the feed as independent latest-state on-chain evidence rather than a generic ERC-20 liveness probe. The adapter also publishes nested redemption telemetry from the same run: `capacityUsd` is derived from `getEntireSystemDebt()`, `capacityKind = "live-direct-bounded"`, `freshnessKind = "same-run-onchain"`, and the existing redemption-fee probe populates the nested fee field when available.

Liquity v2 branch note:
the `liquity-v2-branches` adapter reads branch ActivePool collateral balances, DefiLlama prices, ActivePool debt, optional branch shutdown status, and optional live redemption-fee telemetry. `bold-liquity`, `feusd-felix`, `usnd-nerite`, and `usdq-quill` use this path so their reserve slices remain branch-collateral based while nested redemption telemetry uses aggregate branch debt as `capacityUsd` with `capacityKind = "live-direct-bounded"` and `freshnessKind = "same-run-onchain"`.

`fx` now publishes f(x) protocol-pool API debt balances as conservative live proxy redemption capacity for `fxusd-f-x-protocol`. `asymmetry` now publishes USDaf protocol supply from the timestamped stats API as live direct redemption capacity alongside branch collateral slices. `jupusd` consumes Jupiter's public transparency API and latest snapshot timestamp, grouping USDC/USDtb holdings into reserve slices while emitting whitelisted-primary live redemption capacity and route status from the public oracle endpoint.

`usdgo-transparency`, `solstice-attestation`, and `river-protocol-info` are proof-class reserve-sync adapters. They make current issuer/protocol telemetry visible on reserve detail and status surfaces, but their registry evidence class is `weak-live-probe`, so they do not override report-card collateral quality. USDGO remains proof-class until source provenance, per-slice risk evidence, and date-only freshness semantics are methodology-approved; Solstice remains proof-class until its aggregate solvency feed exposes timestamped asset-category composition; River remains proof-class because its protocol-info endpoint exposes aggregate TVL/circulating-supply telemetry rather than asset-level collateral composition.

Chainlink NAV note:
`chainlink-nav` now supports both standard AggregatorV3 feeds and Ondo router-style NAV lookups. When `oracleMethod = "getAssetPrice"`, the adapter calls `getAssetPrice(token)` on the router and, when available, follows `tokenToRWAOracle(token) -> getPriceData()` to recover a verified freshness timestamp instead of treating the feed as permanently timestampless.

`superstate-liquidity` extends USTB's on-chain NAV reserve proof with Superstate's public liquidity endpoint. Reserve slices remain NAV-based, while nested redemption telemetry uses the current Circle USD available amount plus USDC RedemptionIdle balance as bounded proxy capacity. Missing or malformed liquidity fields fail the adapter instead of falling back to NAV/AUM as immediate liquidity.

`usd1-bundle-oracle` reads USD1's Chainlink bundle oracle on Ethereum. The adapter decodes `latestBundle()` into a source timestamp and reserve value, cross-checks `latestBundleTimestamp()`, reads live USD1 total supply, and stores reserve metadata from latest-state on-chain data. The oracle publishes WLFI aggregate fund reserves across multiple products rather than USD1-earmarked collateral, so the adapter intentionally does not emit a `collateralizationRatio`. The raw fund-reserve / USD1-supply ratio is persisted as `fundBackingTotalRatio` alongside a `details.fundScope` disclaimer; consumers must not read it as a 1:1 collateralization signal.

`frax-balance-sheet` now covers both `frxusd-frax` and legacy `frax-frax` through the Frax v2 balance-sheet API. Known Frax ecosystem assets are classified explicitly; any future unmapped balance-sheet exposure is aggregated and only degrades the run when material. For frxUSD redemption modeling, the adapter emits current stablecoin capacity as a USD amount and intentionally avoids reusing reserve-composition ratios as supply-relative redemption capacity.
Business-day NAV feeds can set `maxOracleAgeSec` when their oracle is expected to pause through weekends or market holidays; `ousg-ondo-finance` and `mtbill-midas` use a 4-day window so normal Friday-to-Monday NAV cadence does not trip their reserve circuit breakers.

Adapter helpers now live in a small helper family, with `worker/src/cron/reserve-adapters/helpers.ts` kept as the shared import surface:

- HTTP JSON / HTML fetch wrappers (`fetchJsonWithRetry`, `fetchTextWithRetry`)
- HTML parser failure helpers that distinguish upstream layout drift (`layout-changed`) from content decoding failures (`parse-failed`) so attempt logs are more actionable for scraped disclosures
- Shared bucketed-composition accumulation and classification helpers (`classification.ts`) for adapters that collapse many raw assets into a smaller reserve-bucket surface while tracking unknown exposure consistently
- Shared unverified-freshness metadata helper so timestamp-less dashboard feeds explain why they remain non-scoring
- DefiLlama spot-price loading for valuation (`fetchDefiLlamaPrices`), with fixed-price overrides supported for wrapper branches in `evm-branch-balances`
- EVM balance, total-supply, and hex-call reads (`fetchErc20Balance`, `fetchErc20TotalSupply`)
- Solana mint-supply reads (`fetchSolanaTokenSupplyRaw`) used by `curated-validated` for tracked Solana-issued assets
- Input-kind type guards and validators (`requireJsonInput`, `requireJsonInputFromConfig`, etc.)
- Slice normalization / valuation / unknown-exposure math (`slice-math.ts`) with configurable precision (`normalizeSlices`, `slicesFromValues`, `valueUsdFromBigIntPrice`)
- Risk validation (`isReserveRisk`)

`worker/src/cron/reserve-adapters/evm.ts` provides hex-level EVM call helpers for ERC-4626 vault introspection.

---

## Frontend Consumers

- `src/hooks/use-stablecoin-reserves.ts` uses mode-aware polling: `live` responses follow the 4-hour reserve producer cadence (`staleTime = 4 hours` / `refetchInterval = 8 hours`), while stale or fallback modes tighten to `1 minute` / `2 minutes` so the UI re-checks recovery faster
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses the adapter badge taxonomy in `shared/lib/live-reserve-display.ts` so `/coverage` distinguishes true `Live` reserve feeds from `Curated-Validated` and `Proof` reserve-sync paths
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

## Scope Boundaries

- Live reserve sync is detail-page and status-surface infrastructure, not a replacement for curated reserve metadata everywhere else.
- [Risk Lab](./report-cards.md) uses fresh authoritative independent live reserve snapshots for collateral quality scoring when available. In practice this now means: `dynamic-mix` adapters can qualify when their latest sync state is `ok` **and** the snapshot carries scoring-eligible freshness evidence, only a subset of `single-bucket` adapters carry `evidenceClass = independent`, and `validated-static` / `weak-live-probe` feeds remain detail-card/status data only. Dependency inference stays curated-only, but blacklist attribution can consume enriched live reserve slices when they exist.
- Blacklist attribution no longer treats live reserves as invisible just because most adapters lack `coinId` links. The report-card resolver enriches both live and curated reserve names with the same blacklist clue pipeline, then resolves inherited exposure to a fixed point across the tracked set so cyclic upstream graphs do not depend on traversal order. The collateral drift alert only compares comparable live reserve mixes: snapshots must still resolve to at least two live slices after normalization, so single-bucket proofs and collapsed one-slice snapshots do not generate noisy curated-vs-live drift alerts.
- [Dependency Map](./dependency-map.md) remains authoritative for graph behavior; dependency edges still derive from curated/static reserve metadata plus manual dependencies.

---

## File Index

| File                                            | Role                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `shared/types/live-reserves.ts`                 | `LiveReservesConfig`, `StablecoinReservesResponse`, sync-state types                             |
| `shared/lib/live-reserve-adapters.ts`           | Shared adapter registry, source/evidence classes, validation policy, and config schemas          |
| `shared/lib/stablecoins/index.ts`               | Loader for per-coin `liveReservesConfig` declarations backed by `shared/data/stablecoins/*.json` |
| `worker/src/cron/sync-live-reserves.ts`         | 4-hourly sync orchestration and cron result statuses                                             |
| `worker/src/cron/reserve-adapters/index.ts`     | Adapter registry                                                                                 |
| `worker/src/cron/reserve-adapters/helpers.ts`   | Shared adapter fetch / normalization helpers                                                     |
| `worker/src/lib/live-reserves-store.ts`         | Public facade over the live-reserve store helpers                                                |
| `worker/src/lib/live-reserves-store-read.ts`    | D1 read/query helpers and authoritative row loaders                                              |
| `worker/src/lib/live-reserves-store-write.ts`   | D1 write paths and history pruning                                                               |
| `worker/src/lib/live-reserves-store-overview.ts`| Status overview, scoring-eligible freshness checks, and authoritative snapshot maps              |
| `worker/src/lib/live-reserves-store-response.ts`| Detail/API reserve-result resolution and curated/static fallback handling                        |
| `worker/src/lib/live-reserves-store-shared.ts`  | Shared live-reserve store types, constants, and row mapping                                      |
| `worker/src/api/stablecoin-reserves.ts`         | Public API handler                                                                               |
| `src/hooks/use-stablecoin-reserves.ts`          | Frontend query hook                                                                              |
| `src/hooks/use-stablecoin-detail-view-model.ts` | Detail-page integration                                                                          |
