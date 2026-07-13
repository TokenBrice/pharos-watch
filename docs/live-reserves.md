# Live Reserve Sync

Dedicated documentation for the live reserve-composition subsystem that powers `GET /api/stablecoin-reserves/:id`, the stablecoin-detail reserve card, and `/status` reserve-sync health.

> **Agent navigation** — ~85 KB; Grep the heading you need instead of reading wholesale: Overview · Metadata Contract · Cron Behavior · Storage Model · API Contract · Adapter Registry · Frontend Consumers · Scope Boundaries · File Index.

---

## Overview

- **Cron:** `sync-live-reserves` (`worker/src/cron/sync-live-reserves.ts`)
- **Schedule:** `11 */4 * * *` (every 4 hours at :11 UTC)
- **Shared 4-hourly lane:** after live reserve sync, the same slot runs redemption backstop sync, Kinesis supply sync, and the named `reserve-post-sync-watchdog` child for collateral-drift cache updates and stale-source alerts (`worker/src/handlers/scheduled/hourly-live-reserves.ts`)
- **Current coverage:** 272 active live-enabled stablecoins across 61 registered adapters; 279 tracked metadata entries have live reserve configs. These counts are active/configured stablecoin entries, not raw source JSON files. 60 adapter keys are currently configured by per-coin metadata in `shared/data/stablecoins/coins/*.json`
- **Storage:** `reserve_composition`, `reserve_composition_history`, `reserve_sync_state`, `reserve_sync_attempt_history`
- **API:** `GET /api/stablecoin-reserves/:id`
- **Frontend consumers:** `useStablecoinReserves()`, stablecoin detail view model, `/status` reserve-sync health
- **Operational telemetry:** `sync-live-reserves` emits per-coin progress into `cron_run_progress`, including the current coin, adapter, breaker key, and running synced / failed / skipped counters

This pipeline is intentionally separate from curated reserve metadata in `StablecoinMeta.reserves`. Live reserve sync affects live-enabled detail-page reserve views, status monitoring, and (since v5.8, tightened in v6.2 and v6.5) collateral quality scoring in report cards only when a snapshot is score-grade. A configured live adapter is not enough by itself: the report-card snapshot must use a fresh, clean, independent live reserve snapshot before `collateralFromLive` becomes true. Since Safety Score v7.14, those same score-grade live slices also drive Dependency Risk and dependency-map edges when they carry tracked `coinId` links; unmapped live reserve share remains implicit self-backed / non-stablecoin exposure. Since Safety Score v8.13, a score-grade live snapshot with no mapped tracked-asset links falls back to curated/manual dependency links before it is treated as `live-unmapped`. Since v8.14, adapter validation and stored-row decoding reject unknown or self-referential `coinId` links and `depType` without `coinId`; subject-aware adapters keep self-held reserve slices visible without turning them into dependency edges. Since v8.15, live reserve dependencies that create an SCC fall affected coins back to curated/manual dependency sets for scoring; an invalid fallback graph rejects report-card publication while leaving the reserve snapshot available for reserve/status surfaces.

Adapters that can emit mapped dependency targets are enrolled in the reviewed mapping registry in `scripts/lib/dependency-target-dispositions.ts`. Each adapter-level record identifies the implementation source files that were reviewed and records the reviewer, date, rationale, and source-file provenance. The dependency coverage gate rejects missing, stale, duplicate, or source-free adapter reviews when a report-card dependency set reports `live-reserve` as its base source. The registry attests to the adapter mapping rule; canonical target identities remain owned by the adapter and its per-coin configuration, so the registry does not invent per-target fingerprints or duplicate provenance onto every emitted live slice.

---

## Metadata Contract

Live reserve support is declared per coin in `StablecoinMeta.liveReservesConfig` (`shared/types/live-reserves.ts`, loaded from `shared/data/stablecoins/coins/*.json` via `shared/lib/stablecoins/registry.ts` and validated by `shared/lib/stablecoins/schema.ts`).

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

All configured source URLs must be absolute URLs. The schema enforces this for HTTP/indexer inputs, `display.url`, and adapter-specific URL params such as RPC endpoints, dashboard APIs, and liquidity endpoints. Adapter definitions also declare their supported `semantics` values and config `version` set, so metadata changes cannot silently pair an adapter with unsupported reserve semantics.

### Registry-Defined Adapter Classes

The single lightweight declaration in `shared/types/live-reserve-adapter-declarations.ts` owns each adapter key, its params-schema identifier and accepted primary input kinds, config validation policy, public source definition, provenance status, and display badge metadata. `shared/lib/live-reserve-adapter-descriptors.ts` resolves those identifiers to Zod schemas only for config/registry consumers. `LIVE_RESERVE_ADAPTER_KEYS`, `LiveReserveAdapterKey`, definitions, schema lookups, provenance lookups, and display lookups are derived compatibility projections; key-only consumers do not initialize the Zod schema catalog. Four important descriptor properties are not user-configured per coin:

| Property              | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sourceModel`         | Distinguishes `dynamic-mix`, `validated-static`, and `single-bucket` reserve shapes                          |
| `evidenceClass`       | Distinguishes scoring-eligible `independent` feeds from `static-validated` and `weak-live-probe` feeds       |
| `sharedSourceMode`    | Distinguishes per-coin fetches (`none`) from explicitly source-invariant result sharing (`source-invariant`) |
| `redemptionTelemetry` | Declares whether the adapter can emit direct/proxy redemption capacity and current-fee telemetry             |

- `dynamic-mix`: independently measured reserve compositions. These can be `independent` evidence for scoring when the sync state is clean.
- `validated-static`: live validation/probe adapters over curated/static slices. These remain authoritative for the reserve detail API, but they are tagged `static-validated` and do not count as independent live collateral inputs for report-card scoring.
- `single-bucket`: one-slice live proofs/attestations. Some are true independent evidence (`blast-usdb-yield-manager`, `btcfi`, `chainlink-nav`, `chainlink-por`, `erc4626-single-asset`, `liquity-native-active-pool`, `liquity-v1`, `m0-wrapper-underlying`, `pusd-vault`, `ripple-transparency`, `sgforge-coinvertible`, `sgho-wrapper`, `spiko-api`, `superstate-liquidity`, `united-por`, `usd1-bundle-oracle`, `yamato`), while weak liveness-only or proof-class summary feeds such as `single-asset`, `solstice-attestation`, and `river-protocol-info` are tagged `weak-live-probe`.
- `independent`: scoring-eligible live evidence when the snapshot is fresh, authoritative, and the most recent sync status is `ok`.
- `static-validated`, `weak-live-probe`: detail/status-visible evidence classes that never override curated collateral scoring.
- `source-invariant`: opt-in within-run result sharing for adapters whose returned payload is coin-invariant. All other adapters run per coin even when configs look similar.

`single-asset` now supports optional `reserveProbe`, `supplyProbe`, and `timestampProbe` paths so weak single-bucket feeds can persist honest reserve/supply ratio telemetry when the upstream exposes it. The family remains `weak-live-probe` unless the source is strong enough to justify promotion into a more independent adapter class.

`attestation-pdf-index` is a validated-static adapter for issuer pages that expose dated PDF attestations. It selects the newest dated PDF link, including Webflow-style gated PDF attributes, validates source freshness from the report date, and emits configured static reserve slices until full PDF text extraction is implemented.
The adapter normally fetches issuer index pages with browser-style `Origin`, `Referer`, and `Accept-Language` headers because some WordPress/hosting stacks rate-limit generic Worker HTML requests while still serving normal browser navigations. Hostinger/WordPress pages that reject browser-origin hints, currently Schuman's reserve-audit page, use the neutral Pharos fetch identity instead.

### Fallback Inputs

`inputs.fallbacks` is implemented in `runAdapter()` inside `worker/src/cron/sync-live-reserves.ts`.

- The cron tries `inputs.primary` first.
- If the adapter throws, the orchestrator retries the same adapter against each fallback by temporarily swapping that fallback into `inputs.primary`.
- If every fallback fails, the attempt history records the primary and fallback failure chain, and the cron-run metadata includes per-coin `attemptFailureSummaries` for automated triage.

USDD currently uses this path: the cron retries `latest-collateral` on Ethereum if the Tron source fails, and the adapter now derives the matching `collateral-history` URL from whichever chain endpoint is active so fallback freshness stays chain-consistent.

Supported input kinds:

| Kind             | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `http-json`      | JSON API endpoint                                                    |
| `http-html`      | HTML page parsed by the adapter                                      |
| `indexer`        | Indexed external data feed                                           |
| `onchain-solana` | On-chain Solana mint-supply reads via the public mainnet RPCs        |
| `onchain-evm`    | On-chain EVM reads via `etherscan-proxy`, `alchemy`, or `public-rpc` |

The shared live-reserve config schema enforces adapter-specific primary and fallback input kinds. For example, `curated-validated` can use `onchain-evm` or `onchain-solana`, `single-asset` can use `http-json` or `onchain-evm`, and HTML scrapers such as `circle-transparency` cannot accidentally be configured with an on-chain input that would pass metadata validation but fail during cron execution.

`curated-validated` can now use `onchain-solana` when a tracked coin publishes its canonical Solana mint in `coin.contracts`, allowing the adapter to validate non-zero supply without downgrading the reserve mix to a weak single-bucket feed.

`onchain-solana` now tries three public RPCs in order before failing the adapter: `https://api.mainnet-beta.solana.com`, `https://api.mainnet.solana.com`, and `https://solana-rpc.publicnode.com`. This reduces false reserve incidents caused by single-endpoint Solana RPC reachability failures inside the Worker runtime.

Branch-balance adapters (`evm-branch-balances`, `liquity-v2-branches`, and `lista`) can set a per-branch `priceToken` when the measured collateral balance is a protocol receipt token whose live price should be sourced from a separate underlying token address. The balance still comes from the configured branch token; only the DefiLlama price lookup address changes. Branch-balance configs can also attach reviewed `sourceUrls` so redemption telemetry emitted from same-run on-chain reads carries source provenance into the Redemption Backstop API.

Adapters can also pass browser-style request headers through the shared JSON retry helper when an upstream is sensitive to request origin hints. Ethena, OpenEden, and Reservoir use this because production failures showed Cloudflare Worker requests intermittently receiving HTML / network failures while the same endpoints still served healthy JSON to browser-like clients. OpenEden and Reservoir additionally retry with the neutral Pharos fetch identity when the browser-style request fails.

USDe's Ethena reserve config also keeps Ethena's main-domain collateral API as a same-provider JSON fallback for cases where the `app.ethena.fi` API route returns the dashboard HTML shell to Worker-origin requests.

DOLA's Inverse FiRM market adapter normalizes the upstream `timestamp` field through the shared timestamp parser because the API can emit JavaScript millisecond timestamps while reserve validation requires Unix seconds.

### Snapshot Metadata and Warning Effects

Successful adapters can attach structured snapshot metadata that is stored on the authoritative snapshot row (`reserve_composition.metadata`), not on the mutable latest-attempt state.

Common metadata fields:

| Field                                                                                                                        | Meaning                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceTimestamp`                                                                                                            | Upstream disclosure timestamp, when independently verified                                                                                  |
| `freshnessMode`                                                                                                              | `verified`, `unverified`, or `not-applicable`                                                                                               |
| `collateralizationRatio`                                                                                                     | Reserve / liability or reserve / supply ratio when the adapter can quantify both sides honestly                                             |
| `details.freshnessSource` / `details.freshnessReason`                                                                        | Adapter-supplied explanation when freshness is explicitly unverified                                                                        |
| `unknownExposurePct`                                                                                                         | Share of reserve value that could not be mapped cleanly                                                                                     |
| `supplyUsd`, `totalReserveUsd`                                                                                               | Adapter-level reserve / supply totals when exposed                                                                                          |
| `totalAssetsUsd`, `totalLiabilitiesUsd`, `shareholderEquityUsd`                                                              | Raw attestation balance-sheet totals for coarse issuer feeds                                                                                |
| `immediateRedeemableUsd`, `immediateRedeemableRatio`                                                                         | Current redeemable-capacity telemetry reused by redemption backstops                                                                        |
| `redemptionFeeBps`                                                                                                           | Current live redemption fee telemetry when the source exposes it                                                                            |
| `buyFeeBpsMin`, `buyFeeBpsMax`                                                                                               | Optional raw buy-fee range context retained alongside normalized `redemptionFeeBps`                                                         |
| `redemption.capacityUsd`, `redemption.capacityRatioOfSupply`                                                                 | Normalized redemption-capacity telemetry. New adapters should prefer this nested shape; legacy flat fields remain readable during migration |
| `redemption.capacityKind`, `redemption.freshnessKind`                                                                        | Typed redemption evidence tier and freshness basis used by redemption-backstop validation                                                   |
| `redemption.routeStatus`, `redemption.routeStatusSource`, `redemption.routeStatusReason`, `redemption.routeStatusReviewedAt` | Optional current route availability signal and provenance, separate from reserve-sync status                                                |
| `redemption.sourceTimestamp`, `redemption.sourceUrls`                                                                        | Optional redemption-specific source timestamp and source URLs carried through to the redemption API/UI                                      |
| `redemption.settlementDelaySec`, `redemption.queueDepthUsd`                                                                  | Optional queue/delay context for redemption routes that are current but not atomic                                                          |
| `redemption.dailyLimitUsd`, `redemption.minRedeemUsd`                                                                        | Optional adapter-emitted daily redemption limit and minimum redemption size constraints                                                     |
| `redemption.holderEligibility`                                                                                               | Optional live holder-eligibility context when the adapter can sharpen the static route model                                                |
| `redemption.feeBps`                                                                                                          | Normalized current redemption fee in the nested telemetry contract                                                                          |

Redemption telemetry is validated before persistence. Negative capacity or constraint values, capacity ratios outside `0..1`, negative fees, malformed redemption source URLs, invalid redemption freshness/capacity/holder-eligibility enum values, invalid `routeStatusReviewedAt` dates, capacity emitted by adapters that do not declare redemption-capacity support, fee telemetry emitted by adapters that do not declare fee support, and direct/proxy/queue capacity evidence emitted by an incompatible adapter capability fail the adapter output validation. Queue capacity that omits queue depth, settlement delay, or daily-limit semantics is stored only with a degraded warning. Existing flat fields are still parsed for backward compatibility, but new adapter work should emit the nested `metadata.redemption` object.

Same-run adapters populate `routeStatusSource` only when the already-fetched source payload explicitly supports current route status. Adapters that derive it from same-run on-chain reads (`routeStatusSource: "onchain"`) include GHO GSM freeze/seize checks, Cap vault pause checks, Liquity V2 branch shutdown checks, the Mezo (`liquity-native-active-pool`) TCR/MCR checks, M0 `swapFacility` pause checks, Resupply pair stability checks, Liquity V1 / Yamato / sGHO-wrapper / Sky MakerCore / ERC-4626 single-asset / collateral-positions-api reads, among others; a separate group (Ethena, Falcon, fx, InfiniFi, OpenEden, Reservoir, Superstate, re-metrics, Asymmetry, JupUSD, FPI) derives it from the protocol API (`routeStatusSource: "protocol-api"`).

`freshnessMode = "not-applicable"` is the expected scoring-eligible path for intrinsically current reads such as `evm-branch-balances`, `liquity-v1`, `liquity-v2-branches`, `liquity-native-active-pool`, `m0-wrapper-underlying`, `pusd-vault`, `btcfi`, and `collateral-positions-api`, where reserve composition comes from latest-state contract/API state rather than a separately timestamped disclosure. Timestamp-less APIs that expose balance-sheet snapshots without a reviewed latest-state contract remain `freshnessMode = "unverified"` and are detail-visible but not score-grade collateral. `reservoir` graduated out of this bucket after a latest-state review: its raw reserves payload provably re-derives every balance-sheet row from issuer-disclosed on-chain contracts on each fetch (the sibling `/api/reserves` endpoint publishes the token and holder contracts per row), so it now uses `not-applicable` freshness like other reviewed latest-state reads.

Mento reserve sync combines the composition payload from Mento's analytics API with the dashboard's embedded reserve payload timestamp. When that dashboard timestamp parses successfully, the `mento` adapter emits verified freshness for USDm and Mento CDP assets; if the dashboard timestamp disappears, it falls back to explicit unverified freshness rather than guessing.

InfiniFi reserve sync hydrates freshness the same way: the protocol `/data` payload carries no timestamp, so the `infinifi` adapter probes the transparency dashboard's siUSD rate-history series (written by the same backend snapshotter on a 2-hour cadence) and emits verified freshness from the latest point only when that point's rate matches the live staked exchange rate in the reserve payload. A failed probe or a cross-check mismatch falls back to explicit unverified freshness.

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
2. Orders the queue by adapter evidence class (`independent`, then `static-validated`, then `weak-live-probe`) and packs coins sharing a `source-invariant` adapter contiguously, so run-budget truncation defers weak probes before score-grade feeds and shared fetches are reused immediately. Cursored runs process only the deferred tail and deliberately do not wrap back to the head within the same run; once that tail completes the cursor clears and the next scheduled run restarts from the head, so a coin deferred in one run is first in line on the next.
3. Resolves an adapter from `worker/src/cron/reserve-adapters/index.ts`.
4. Builds a breaker key as `live-reserves:${breakerScope ?? adapter}`.
5. Checks the per-source circuit breaker before each coin fetch.
6. Persists either a fresh snapshot (`reserve_composition`) plus sync-state row, or an error/degraded/skipped sync-state row.

**Adapter output validation:** After each adapter returns, `validateAdapterOutput()` checks
that all slice `risk` values are valid enum members, all `pct` values are finite and strictly positive,
the slice list is non-empty, and the sum is within 2 points of 100%. Invalid output is treated as
an error. Sum deviation above 0.5 points produces a `degraded` warning, while deviation above 2 points
hard-fails the adapter output with a `fatal` warning.

Source freshness validation also rejects source timestamps that are more than 10 minutes in the future, including nested redemption telemetry timestamps, so upstream clock mistakes or millisecond/second parsing errors cannot be treated as fresh snapshots. Multi-row reserve feeds should use the oldest material contributor timestamp as `sourceTimestamp` for verified freshness and can persist `latest*Timestamp` / `sourceTimestampSpreadSec` metadata for diagnostics.

Adapters can also declare shared validation policy in the registry:

- `maxSourceAgeSec`: if adapter metadata includes `sourceTimestamp` and the upstream disclosure is older than the policy allows, the sync is marked `degraded`
- `maxUnknownExposurePct`: if adapter metadata includes `unknownExposurePct` and unmapped reserve exposure is material, the sync is marked `degraded`
- `allowedFreshnessModes`: explicit per-adapter freshness contract enforced by output validation
- when `maxSourceAgeSec` exists but the adapter can only attest freshness heuristically, `freshnessMode = "unverified"` produces an informational `freshness-unverified` warning instead of forcing a degraded status on the sync itself; the snapshot still cannot enter collateral scoring
- late monthly disclosures that routinely publish after the next calendar month starts use `LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 4000000` rather than ad hoc per-coin caps
- timestamp-less dashboard/API feeds should also populate `details.freshnessSource` / `details.freshnessReason` so the lack of verified recency is explicit in stored metadata

For on-chain branch-balance adapters, branches marked with `depType: "wrapper"` are not treated as plain USD-pegged wrappers for the depeg guard. This avoids false degraded states for yield-bearing wrappers such as sUSDe whose market price can intentionally rise above one dollar while the reserve slice still links dependency risk to the underlying asset.

Unknown exposure now follows one repo-wide policy:

- quantify it and persist `unknownExposurePct` when the adapter can do so honestly
- emit an explicit unknown slice when the reserve mix would otherwise hide that exposure
- use threshold-driven warning effects so immaterial unknowns stay informational and material unknowns degrade the sync
- fail closed when the adapter cannot quantify the missing exposure without inventing precision

These policy warnings still preserve the last-known live snapshot for detail/status surfaces, but they keep the snapshot out of report-card collateral passthrough because scoring only accepts independent snapshots whose latest sync state is `ok`.

**Circuit breaker recording:** Breaker outcomes are deferred until the entire sync loop
completes, recording the worst outcome per breaker key (failure trumps success). This
prevents first-coin-wins bias where a successful early coin would mask failures of later
coins sharing the same breaker key. Finalization records failure outcomes first and
skips success heartbeats for breakers that are already closed with no failure debt;
those closed-success skips avoid rewriting hundreds of live-reserve circuit rows at
the end of every healthy run.

Cron result statuses:

| Status     | When                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`       | At least one configured coin synced, and `failed + skipped <= ceil(total * 0.1)`                                                                                                        |
| `degraded` | At least one configured coin synced and `failed + skipped > ceil(total * 0.1)`; OR no coin synced but every skip was a circuit-breaker hold (no real failures, no budget-deferred tail) |
| `error`    | No configured coin synced and at least one coin truly failed or was budget-deferred (`failed > 0` or `deferredSkipped > 0`)                                                             |

Per-coin warnings still matter operationally, but they affect `reserve_sync_state.last_status` for that coin (`degraded`) and the cron metadata warning list, not the run-level `CronResult.status`.

The cron loop is sequential. This is deliberate: reserve adapters can hit multiple heterogeneous sources, and the isolated 4-hourly trigger keeps connection pressure predictable. Each adapter attempt also receives a per-attempt I/O limiter with a peak of 2 outbound HTTP/RPC operations, so internally parallel adapters such as GHO, Cap, Anzen, and crvUSD cannot consume the whole six-connection trigger pool. The limiter is abort-aware while queued, and the cron races every adapter fetch against the same per-attempt timeout signal so a non-cooperative adapter cannot overrun the queue budget. The leased wrapper gives `sync-live-reserves` a 12-minute outer wall-clock budget; the sync loop defaults to an internal 9-minute budget for cursoring, 20-second adapter attempts, a 30-second D1 finalize timeout, and a 5-second finalization margin, all resolved through `LiveReserveSyncBudgetConfig` so tests and operational wrappers can exercise safe edge values without editing cron logic. The cron defers before starting the next coin unless the remaining budget can cover adapter timeout, D1 finalization, and the margin, leaving outer-wrapper room for final cleanup and cron logging. The cron reports `setup`, `syncing`, and `finalizing` progress stages so `/status` can show which coin is currently in flight. When the internal budget is exhausted, the cron records `reserve_sync_state.last_status = "skipped"` with `metadata.failureCategory = "run-budget-exhausted"` for the untouched tail and persists a lightweight cursor in `cache.key = 'live-reserves:run-cursor'`, so the next run resumes from the first deferred coin instead of always restarting from the top of the configured list. The cursor is written before deferred tail rows with `tailState = "recording"`, updated to `"complete"` after skipped rows/history are recorded, and best-effort updated to `"incomplete"` with `tailError` / `tailFailedAt` if the row batch fails after the cursor advances. Repeated cursored truncations increment `runBudgetTruncationCount` until a full run clears the cursor; if the previous cursor cannot be read, the cron emits `live-reserve-cursor-read-failed` and starts the next truncation count from one. Deferred rows clear `last_attempt_id` and `pending_attempt_id`; they describe skipped tail work, not an attempted fetch/finalize transaction. Run-budget deferred rows are intentionally excluded from persistent-stale independent alerts because they represent scheduler capacity pressure rather than source failure. Cron metadata sets `runBudgetTruncated`, `deferredCoins`, `nextCursorStablecoinId`, and the resolved budget values; `/api/status`, `/api/status-history`, and the admin status dashboard surface those fields so operators can see the deferred tail at a glance. Cursor persistence and cleanup during finalization are best-effort and now run before optional bulk breaker or retention work: a failed cursor write/delete records `cursorPersistFailed` / `cursorPersistError` in cron metadata and emits a durable `live-reserve-cursor-finalize-failed` cron event, but it does not turn an otherwise successful reserve sync into an error run. If finalization has already consumed its D1 tail budget, remaining breaker outcome writes, artifact cleanup, and history pruning are skipped and recorded in metadata instead of risking a platform kill after current-state or deferred-tail writes. If a successful authoritative current-state write is followed by a failed history insert, the run remains successful but records `historyWriteFailedCoins`, preserves the existing `coin:history-write-failed` warning, and emits a durable `live-reserve-history-write-failed` cron event. Within a run, fetched results are only reused when the adapter registry marks the adapter as `source-invariant` (currently `m0`, `reservoir`, `sky-makercore`, and `tether-transparency`); coin-aware adapters such as `frax` never share cached results across coins. At the end of each run, the cron also removes stale operational artifacts for coins that are no longer live-enabled: orphaned `reserve_sync_state` rows and stale `cache.key = 'circuit:live-reserves:*'` entries are deleted so `/status` and `/api/health` stop surfacing removed reserve sources as active incidents after coverage changes.

Artifact cleanup remains best-effort, but the cron metadata now records `artifactCleanup` delete counts, `artifactCleanupWarningCount`, and structured `artifactCleanupWarnings` when cleanup fails. `/status` and the admin status dashboard summarize non-zero cleanup deletes and cleanup warning counts so ghost-artifact cleanup regressions do not require log scraping.

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

Append-only history of successful live snapshots. Every successful upsert also inserts a history row carrying the same slices, metadata, warnings, and adapter classification fields as the latest-snapshot table. Non-null attempt IDs are unique per coin and history inserts are idempotent, so a retried D1 write cannot duplicate rows for the same attempt. The 4-hourly reserve cron prunes rows older than 90 days.

### `reserve_sync_state`

Per-coin operational state for the most recent attempt.

| Column                                                               | Meaning                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `stablecoin_id`                                                      | Canonical Pharos coin ID                                                                                                                  |
| `adapter_key`                                                        | Adapter used for the most recent attempt                                                                                                  |
| `breaker_key`                                                        | Per-source circuit-breaker key                                                                                                            |
| `last_attempted_at`                                                  | Unix timestamp of the latest attempt                                                                                                      |
| `last_success_at`                                                    | Unix timestamp of the latest successful live snapshot                                                                                     |
| `last_status`                                                        | `ok`, `degraded`, `error`, or `skipped`                                                                                                   |
| `warning_count`                                                      | Number of adapter warnings                                                                                                                |
| `warnings`                                                           | JSON-serialized warning objects                                                                                                           |
| `last_error`                                                         | Latest failure message, if any                                                                                                            |
| `metadata`                                                           | Attempt-scoped operational metadata only (for example skip/failure reasons or warning-effect counts), not authoritative reserve telemetry |
| `last_attempt_id` / `pending_attempt_id` / `last_success_attempt_id` | Attempt-fencing identifiers used to reject orphaned or partially written live snapshots                                                   |

### `reserve_sync_attempt_history`

Append-only history of all reserve-sync attempts, including `ok`, `degraded`, `error`, and `skipped` outcomes with their warnings, error message, and attempt-scoped metadata. Non-null attempt IDs are unique per coin and inserts are idempotent. The 4-hourly reserve cron prunes rows older than 90 days.

Freshness and consistency rules now live across the `worker/src/lib/live-reserves-store*.ts` helper family, with `worker/src/lib/live-reserves-store.ts` kept as the public facade:

- `LIVE_RESERVE_FRESHNESS_SEC = 172800` (48 hours)
- A live snapshot only counts as consistent when `reserve_sync_state.last_success_at === reserve_composition.fetched_at` and, when attempt IDs are stamped, `reserve_sync_state.last_success_attempt_id === reserve_composition.attempt_id`
- Stored snapshots are parsed strictly: unreadable JSON, invalid payloads, empty slice arrays, invalid slices, or materially invalid sums are rejected instead of being partially served
- `resolveReserveResult()` is the canonical detail/API resolver used by `GET /api/stablecoin-reserves/:id`
- `computeReserveCompositionOverview()` is the status-summary resolver used by `/api/status` and `/admin/`
- `loadFreshIndependentLiveReserveMap()` further filters authoritative snapshots to `evidenceClass = independent`, `reserve_sync_state.last_status = "ok"`, **and** scoring-eligible freshness evidence for report-card/scoring consumers. In practice that means the snapshot must either carry a verified `sourceTimestamp` path or explicitly mark freshness as `not-applicable`; `freshnessMode = "unverified"` no longer qualifies for collateral passthrough, even if legacy metadata carries `scoringAllowsUnverifiedFreshness`.
- transient network/upstream failures retain the last successful composition for reserve detail/status views while the current sync state records `error` / `skipped`; scoring still fails closed because it requires the latest sync state to be `ok`
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
- `persistentlyStaleIndependentCoins` (independent feeds older than the persistent-staleness window that can escalate status beyond normal short-lived lag; includes old active failures and circuit-open skips, but not run-budget deferred rows)
- `writeTimeoutUncertain`
- `deferredCoins`
- `runBudgetTruncated`
- `deferredAt`
- `nextCursorStablecoinId`
- `cursorTailState`
- `cursorTailError`
- `cursorRecordedAt`
- `cursorTailCompletedAt`
- `cursorTailFailedAt`
- `runBudgetTruncationCount`
- `historyWriteGaps`
- `lastSuccessAt`
- `oldestFreshAgeSec`

`errorCoins` includes active adapter failures even before a coin has ever produced a successful live snapshot; those rows no longer remain hidden inside `missingCoins`.
`corruptCoins` counts rows where a matching latest-success snapshot exists in D1 but fails strict integrity validation, so the system fails closed to fallback presentation instead of serving truncated or malformed live data.
When a coin has both an old latest-success snapshot and a newer failing attempt state, the overview now prioritizes the active `error` / `degraded` attempt classification over generic `stale` labeling so status surfaces better reflect live incidents.
`writeTimeoutUncertain` counts coins whose latest attempt hit the D1 write-timeout / finalize-rejection path and whose authoritative success state could not be proven by readback.
`runBudgetTruncated`, `deferredCoins`, `deferredAt`, and `nextCursorStablecoinId` mirror the latest deferred-tail cursor so status surfaces can distinguish ordinary stale coverage from a run that intentionally stopped before the queue tail. `cursorTailState`, `cursorTailError`, `cursorRecordedAt`, `cursorTailCompletedAt`, `cursorTailFailedAt`, and `runBudgetTruncationCount` expose whether the deferred tail was fully recorded or left incomplete after a partial D1 write failure. `historyWriteGaps` reconciles authoritative current snapshots against composition and attempt history rows so missing history writes stay visible after the cron event has been overwritten by a newer event.

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

`StablecoinReservesResponseSchema` in `shared/types/live-reserves.ts` is the runtime contract for successful `200` responses and is used by the frontend reserve API client. Adapter-specific `metadata`, `metadata.details`, and nested redemption telemetry remain passthrough so feed telemetry can evolve without breaking consumers.

Cache control:

| Response mode                | Cache-Control                        |
| ---------------------------- | ------------------------------------ |
| `live`                       | `public, s-maxage=3600, max-age=300` |
| `live-stale`                 | `public, s-maxage=1800, max-age=120` |
| fallback / unavailable modes | `public, s-maxage=300, max-age=60`   |

The optional `provenance` object is present only when the response is serving an authoritative `live` or `live-stale` snapshot:

| Field             | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `evidenceClass`   | `independent`, `static-validated`, or `weak-live-probe`                               |
| `sourceModel`     | `dynamic-mix`, `validated-static`, or `single-bucket`                                 |
| `freshnessMode`   | Optional explicit freshness policy (`verified`, `unverified`, `not-applicable`)       |
| `scoringEligible` | Whether the current snapshot is eligible for collateral-quality passthrough right now |

The optional `displayBadge` object is also present only for authoritative `live` / `live-stale` snapshots:

| Field   | Meaning                                                                                      |
| ------- | -------------------------------------------------------------------------------------------- |
| `kind`  | `live`, `curated-validated`, or `proof`                                                      |
| `label` | User-facing badge text rendered on the detail page (`Live`, `Curated-Validated`, or `Proof`) |

`displayBadge` is intentionally separate from `mode` and `provenance`:

- `mode` answers whether an authoritative snapshot exists and whether it is stale
- `provenance` answers scoring/evidence semantics
- `displayBadge` answers the honest user-facing reserve label

The optional `displayUrl` and `evidenceUrls` fields are also intentionally separate:

- `displayUrl` is the curated reserve-card destination configured in `liveReservesConfig.display.url`
- `evidenceUrls` are adapter-emitted URLs tied to the authoritative live snapshot metadata
- the detail page can show both when a coin has a curated overview page plus narrower evidence links for the exact live snapshot

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
| `failureCategory` | Machine-readable failure class from attempt metadata, when present                                                                  |
| `uncertainWrite`  | `true` when the latest attempt hit the D1 write-timeout / finalize-rejection path and authoritative state could not be proven       |

Uncertain write attempts are intentionally exposed as `sync.uncertainWrite = true` instead of being collapsed into generic stale/error narration. The API may still serve the last consistent snapshot or fallback presentation, but operators can tell that the latest attempted write is ambiguous until a clean follow-up run resolves it. Detail-page polling uses the normal 4-hour reserve cadence only for clean live responses; live responses with `sync.status !== "ok"` or `sync.uncertainWrite = true` use recovery polling and render the active status, failure category, and last error above the reserve card footer.

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
This table reflects the shared adapter registry. `Configured coins` can be `0` for deliberately parked implementations retained for a future binding.

| Adapter                      | Primary input                                    | Semantics                                             | Configured coins |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ---------------- |
| `abracadabra`                | `onchain-evm`                                    | `collateral-mix`                                      | 1                |
| `accountable`                | `http-json`                                      | `collateral-mix` / `protocol-reserve`                 | 7                |
| `anzen-usdz`                 | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `asymmetry`                  | `http-json`                                      | `collateral-mix`                                      | 1                |
| `attestation-pdf-index`      | `http-html`                                      | `attestation-mix`                                     | 8                |
| `blast-usdb-yield-manager`   | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `btcfi`                      | `http-json`                                      | `collateral-mix`                                      | 1                |
| `cap-vault`                  | `onchain-evm`                                    | `protocol-reserve`                                    | 1                |
| `chainlink-nav`              | `onchain-evm`                                    | `single-asset`                                        | 18               |
| `chainlink-por`              | `onchain-evm`                                    | `attestation-mix`                                     | 5                |
| `circle-transparency`        | `http-html`                                      | `attestation-mix`                                     | 2                |
| `collateral-positions-api`   | `http-json`                                      | `collateral-mix`                                      | 2                |
| `crvusd`                     | `http-json`                                      | `collateral-mix`                                      | 1                |
| `curated-validated`          | `onchain-evm` / `onchain-solana`                 | `attestation-mix` / `collateral-mix` / `single-asset` | 61               |
| `dola-inverse`               | `http-json`                                      | `collateral-mix`                                      | 1                |
| `erc4626-single-asset`       | `onchain-evm`                                    | `single-asset`                                        | 36               |
| `ethena`                     | `http-json`                                      | `collateral-mix`                                      | 1                |
| `evm-branch-balances`        | `onchain-evm`                                    | `collateral-mix`                                      | 9                |
| `falcon`                     | `http-json`                                      | `collateral-mix`                                      | 1                |
| `fdusd-transparency`         | `http-html`                                      | `attestation-mix`                                     | 1                |
| `frax-balance-sheet`         | `http-json`                                      | `attestation-mix`                                     | 3                |
| `frax-fpi-collateral`        | `http-json`                                      | `collateral-mix`                                      | 1                |
| `fx`                         | `http-json` / `onchain-evm`                      | `collateral-mix`                                      | 1                |
| `gho`                        | `onchain-evm`                                    | `protocol-reserve`                                    | 1                |
| `infinifi`                   | `http-json`                                      | `collateral-mix`                                      | 1                |
| `jupusd`                     | `http-json`                                      | `collateral-mix`                                      | 1                |
| `liquity-v1`                 | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `liquity-native-active-pool` | `onchain-evm`                                    | `collateral-mix`                                      | 1                |
| `liquity-v2-branches`        | `onchain-evm`                                    | `collateral-mix`                                      | 6                |
| `lista`                      | `onchain-evm`                                    | `collateral-mix`                                      | 1                |
| `m0`                         | `http-json`                                      | `protocol-reserve`                                    | 7                |
| `m0-wrapper-underlying`      | `onchain-evm`                                    | `single-asset`                                        | 3                |
| `mento`                      | `http-json`                                      | `collateral-mix`                                      | 13               |
| `nest-vault-positions`       | `http-json`                                      | `collateral-mix`                                      | 5                |
| `openeden-usdo`              | `http-json`                                      | `collateral-mix`                                      | 0                |
| `origin-vault-balances`      | `onchain-evm`                                    | `collateral-mix`                                      | 1                |
| `pusd-vault`                 | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `quantoz-transparency`       | `http-html`                                      | `attestation-mix`                                     | 2                |
| `re-metrics`                 | `http-html`                                      | `collateral-mix`                                      | 1                |
| `resupply-pairs`             | `onchain-evm`                                    | `collateral-mix`                                      | 1                |
| `reserve-protocol-dtf`       | `http-json` / `onchain-evm`                      | `collateral-mix`                                      | 1                |
| `reservoir`                  | `http-json`                                      | `protocol-reserve`                                    | 3                |
| `ripple-transparency`        | `http-html`                                      | `attestation-mix`                                     | 1                |
| `river-protocol-info`        | `http-json`                                      | `protocol-reserve`                                    | 1                |
| `sgforge-coinvertible`       | `http-html`                                      | `attestation-mix`                                     | 2                |
| `sgho-wrapper`               | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `single-asset`               | `http-json` / `onchain-evm`                      | `single-asset`                                        | 45               |
| `sky-makercore`              | `http-json`                                      | `collateral-mix`                                      | 2                |
| `solstice-attestation`       | `http-json`                                      | `protocol-reserve`                                    | 1                |
| `spiko-api`                  | `http-json`                                      | `single-asset`                                        | 6                |
| `superstate-liquidity`       | `onchain-evm` primary; `params.liquidityUrl` API | `single-asset`                                        | 1                |
| `tether-transparency`        | `http-json`                                      | `attestation-mix`                                     | 2                |
| `united-por`                 | `http-json`                                      | `single-asset`                                        | 1                |
| `usd1-bundle-oracle`         | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `usdai-proof-of-reserves`    | `http-json`                                      | `collateral-mix`                                      | 1                |
| `usdgo-transparency`         | `http-json`                                      | `attestation-mix`                                     | 1                |
| `usdd-data-platform`         | `http-json`                                      | `collateral-mix`                                      | 1                |
| `usdh-native-markets`        | `http-html`                                      | `attestation-mix`                                     | 1                |
| `usdtb-transparency`         | `http-json`                                      | `collateral-mix`                                      | 1                |
| `yamato`                     | `onchain-evm`                                    | `single-asset`                                        | 1                |
| `zephyr-scanner`             | `http-json`                                      | `protocol-reserve`                                    | 1                |

`reserve-protocol-dtf` keeps its legacy Reserve discovery API path for
timestampless fallback reads, but score-grade configs can use the direct
`onchain-evm` path. The direct path reads the RToken `main()`,
`basketsNeeded()`, BasketHandler `quote(...)` / `fullyCollateralized()`, and
AssetRegistry asset plugins for component prices and collateral status, so its
freshness mode is `not-applicable`.

`resupply-pairs` reads the reviewed Resupply pair allowlist from config, then
each pair's current on-chain accounting and collateral vault conversion to
aggregate positive collateral assets by reviewed underlying stablecoin
(`crvUSD` / `frxUSD`). It fails closed on unmapped positive-collateral pairs
and uses `freshnessMode: not-applicable` because the source is latest Ethereum
state. When a reviewed `redemptionHandlerAddress` is configured, the adapter
also reads `getMaxRedeemableDebt(pair)`, `guardEnabled()`,
`permissionlessPriceThreshold()`, and `reUsdOraclePrice()` from the Resupply
redemption handler in the same run. That nested redemption telemetry is
score-grade only while the permissionless guard is open; if the guard is closed
above the threshold, the route is surfaced as cohort-limited and remains
excluded from Safety Score liquidity.

Adapter key intent is declared with the adapter descriptor and covered by the registry tests. Every registered key has one of these statuses:

| Status    | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `active`  | Bound by at least one active stablecoin `liveReservesConfig`              |
| `staged`  | Implemented for an approved upcoming binding, but not active yet          |
| `retired` | Kept only for historical compatibility while no new binding should use it |
| `parked`  | Retained intentionally while no active coin currently binds it            |

Current unbound registered adapter is explicit:

| Adapter         | Status   | Rationale                                                                                                                                                                      | Parked since | Next review |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------- |
| `openeden-usdo` | `parked` | OpenEden USDO adapter is retained, but its live config was suspended because OpenEden's gateway blocks Cloudflare Worker egress; rebind once the issuer allowlists our egress. | 2026-06-25   | 2026-12-25  |

`parked` and `retired` descriptors carry `parkedSince` and `nextReview` ISO dates. Default cadence is a six-month review window; when `nextReview` passes, the adapter is up for one of: revival under an active coin binding, status downgrade to `retired`, or full removal alongside its tests and fixtures. The registry test asserts both fields are populated for every non-active entry.

`collateral-positions-api` can now optionally attach direct redemption-capacity telemetry alongside the collateral mix when a reviewed bridge-backed stable exit exists. `zchf-frankencoin` uses this path to publish the current CHFAU StablecoinBridge inventory as `immediateRedeemableUsd` for redemption-backstop modeling without changing the reserve-slice composition itself. Until Frankencoin's price API publishes CHFAU directly, this route values the CHFAU bridge balance through the existing VCHF CHF-price proxy.

`cap-vault` reads Cap cUSD's Ethereum vault state directly. Reserve slices are based on each supported asset's total supplied balance, while redemption-capacity telemetry uses unpaused available balances after borrows so the route does not treat borrowed or paused collateral as immediate exit capacity. The adapter emits nested `metadata.redemption` with `capacityKind = "live-direct-bounded"`, `freshnessKind = "same-run-onchain"`, `routeStatusSource = "onchain"` from per-asset pause checks, and zero-second settlement-delay telemetry.

`origin-vault-balances`, `blast-usdb-yield-manager`, `sgho-wrapper`, and `nest-vault-positions` cover additional strategy-vault reserve sources without widening generic adapters. Origin reads OUSD Vault `checkBalance(asset)` plus `totalValue()` so only mapped assets are credited, and it separately reads idle ERC-20 `balanceOf(vault)` as direct bounded redemption capacity while excluding deployed strategy balances. Blast reads Ethereum USDYieldManager `totalValue()` and reconciles it against Blast USDB supply. `sgho-wrapper` handles Aave's legacy sGHO/stkGHO-compatible contract by reading `previewRedeem(totalSupply)` as same-run backing evidence because that contract does not expose standard ERC-4626 `asset()` / `totalAssets()` reads; its redemption metadata now also carries bounded same-run capacity ratio, any-holder eligibility, and zero-second settlement delay. Nest consumes the Nest Alpha Vault positions, NAV, and last-price-update APIs, preserving the latest verified update timestamp and grouping private/structured vault exposure as high risk.

`circle-transparency`, `quantoz-transparency`, `ripple-transparency`, and `m0` preserve source freshness when their upstream pages/API expose usable reserve disclosure or update timestamps: Circle uses the public reserve `As of` date, including the unique page-level reserve-composition date when an individual stablecoin tab has no nearer date; Quantoz uses the transparency page's `UPDATED` date and per-token reserve-ratio/allocation row; Ripple uses the RLUSD balance block's `As of` date and reserves-versus-circulation values; and M0 uses the latest collateral/update timestamp exposed by its GraphQL schema. `mento` reads reserve composition from the server-side analytics API behind `reserve.mento.org`; that API is usable from the Worker even though the public site currently trips browser CORS errors. Plain Mento configs parse the protocol reserve basket, while configs with `params.cdpStablecoin` parse active CDP troves for GBPm, JPYm, CHFm, and reviewed XOFm shape into USDm collateral slices plus live collateral/debt metadata. XOFm is schema/parser-ready but remains unconfigured until the live analytics payload exposes active XOFm troves. The adapter hydrates verified source freshness from the dashboard's embedded reserve payload timestamp when available, and falls back to explicit unverified freshness if that dashboard timestamp disappears.

`sgforge-coinvertible` treats SG Forge slash-form `Last update` dates (with either two- or four-digit years) as European day/month/year by default, but falls back to month/day/year when the European parse would put the disclosure timestamp in the future. This keeps the future-timestamp validator strict while tolerating SG Forge edge/localization variants that can reverse ambiguous dates.

`asymmetry` preserves the protocol API's top-level timestamp as verified freshness when available and normalizes branch symbols before classification, so casing-only variants such as `wBTC` do not degrade an otherwise mapped USDaf reserve mix.

`usdai-proof-of-reserves` consumes USD.AI's public proof-of-reserves API, preserves oversized fixed-point `share` and `amount` integers from the raw JSON payload, groups the many hardware-loan `DEAL` rows into a single high-risk loan slice, and exposes liquid reserve buckets such as PYUSD separately. The adapter prefers explicit `share` weights when the share-bearing rows already cover the full published mix, ignores auxiliary amount-only rows in that case with an informational warning, and falls back to `amount` weighting only if the feed stops publishing share values entirely. Because the API endpoint itself does not publish a trustworthy disclosure timestamp, the adapter hydrates verified freshness from USD.AI's public reserves page when available, using the oldest scoped proof-row timestamp as the freshness bound while retaining oldest/latest spread metadata for review; otherwise snapshots stay `freshnessMode = "unverified"`. As of April 4, 2026, Pharos binds this mixed reserve feed to `susdai-usd-ai`, not to base `usdai-usd-ai`, because the public API is protocol/yield-side collateral rather than a clean base-token reserve proof.

`crvusd` now reads Curve's Ethereum ControllerFactory and LLAMMA AMMs directly on-chain, summing each market's `bands_y` collateral balances across active bands via Multicall3. `bands_x` crvUSD inventory from soft-liquidation state is tracked as metadata rather than external collateral. The adapter also walks the Ethereum Yield Basis factory (`factory.yieldbasis.eth`), unwraps each market's LT position with `preview_emergency_withdraw(totalSupply)`, values the resulting external asset balances with DefiLlama prices, and folds those balances into the same BTC / ETH reserve buckets. `crvusd-curve` config version `3` marks the direct on-chain LLAMMA expansion and emits `freshnessMode: not-applicable`. The Yield Basis leg is optional and time-bounded; if it stalls, the adapter records a degraded warning while preserving the direct Curve collateral snapshot. The checked-in config also keeps Curve's market JSON endpoint as a fallback so transient RPC slowness does not open the reserve-source breaker when the public market feed is still reachable.

GHO-specific note:
the `gho` adapter values reviewed mainnet GSM backing directly from live onchain GSM state and then decomposes the remainder of GHO supply across the active facilitator registry. Each residual slice is classified by facilitator label into `aave-v3-direct` (medium risk), `flashminter` (high risk), or `unknown` (high risk). The unknown-labeled share is accumulated into `metadata.unknownExposurePct` so the standard `material-unknown-exposure` validator governs whether a residual slice degrades the sync, rather than a GHO-specific aggregated-residual warning. If no facilitator labels are readable in a run (for example the registry call fails), the entire residual is treated as unknown so the fail-closed policy still applies. `immediateRedeemableUsd` only counts GSM modules that are not frozen or seized, while `redemptionFeeBps` is normalized to the current worst tracked GSM buy fee and the raw min/max values are retained as `buyFeeBpsMin` / `buyFeeBpsMax`. Follow-up Path D (direct `GhoReserve` / `GhoDirectFacilitator` / RemoteGSM reads) remains pending verified Aave deployment addresses.

Liquity v1 note:
the `liquity-v1` adapter covers `lusd-liquity` by reading `getEntireSystemColl()` and `getEntireSystemDebt()` from the official Ethereum `TroveManager`, preserving LUSD as a one-slice 100% ETH reserve view while classifying the feed as independent latest-state on-chain evidence rather than a generic ERC-20 liveness probe. The adapter also publishes nested redemption telemetry from the same run: `capacityUsd` is derived from `getEntireSystemDebt()`, `capacityKind = "live-direct-bounded"`, `freshnessKind = "same-run-onchain"`, and the existing redemption-fee probe populates the nested fee field when available.

Liquity v2 branch note:
the `liquity-v2-branches` adapter reads branch ActivePool collateral balances, DefiLlama prices, ActivePool debt, optional branch shutdown status, and optional live redemption-fee telemetry. `bold-liquity`, `feusd-felix`, `usdq-quill`, `nect-beraborrow`, and `cdp-enosys` use this path so their reserve slices remain branch-collateral based while nested redemption telemetry uses aggregate branch debt as `capacityUsd` with `capacityKind = "live-direct-bounded"` and `freshnessKind = "same-run-onchain"`. The Beraborrow binding also supports ERC-4626-style Collateral Vault share branches, branch `fetchPrice()` fallback, and per-branch `getRedemptionRateWithDecay()` fee telemetry.

Liquity native ActivePool note:
the `liquity-native-active-pool` adapter covers Liquity-style forks whose native collateral balance is exposed directly on ActivePool instead of through per-branch ERC-20 balances. `meusd-mezo` uses this path on Mezo: the adapter reads ActivePool debt and collateral, values native collateral through the protocol price feed, checks TCR against MCR for current route health, and emits same-run redemption-fee telemetry from BorrowerOperations when available.

M0 wrapper note:
the `m0-wrapper-underlying` adapter covers token-specific M0 wrappers whose immediate redemption capacity is the current M token balance held by a wrapper or reviewed facility. `wm-m0` reads the Ethereum wM wrapper's M balance directly. `usdsc-startale` reads the Soneium SwapFacility's M balance only after verifying the stable token, underlying M token, approved swapper, and unpaused route state, then emits whitelisted-primary direct capacity.

`pusd-vault` covers `pusd-polymarket`'s Polygon CollateralToken, whose immutable backing vault is a separate contract address rather than one discoverable via a wrapper selector (contrast `m0-wrapper-underlying`). The adapter sums `balanceOf(vault)` across the vault's configured USDC variants (native USDC and bridged USDC.e) and compares that total to the token's own `totalSupply()`; `collateralizationRatio` and bounded live-direct redemption capacity follow directly from that same-run read, with any-holder eligibility and zero-second settlement delay since `unwrap()` is a permissionless 1:1 burn against the vault.

`united-por` reads United Stables' public aggregate PoR payload (`https://u.tech/u-client-api/v1/public/u/por`) directly: `totalReserve` vs `totalToken` decimal strings and an ISO `updatedAt` drive `collateralizationRatio` and verified freshness for `u-united-stables`, while per-asset composition detail stays on the coin's configured `params.slice` (mirroring its curated reserve bucket) since the source only discloses the aggregate. The payload's own `ripcord` data-quality alarm is treated as a degraded warning rather than a thrown error — the snapshot is still stored with its ratio and freshness, but a ripcord run (with any disclosed `ripcordDetails` folded into the warning message) never reads as healthy, and it is excluded from score-grade scoring passthrough same as any other degraded snapshot.

Re Protocol metrics note:
the `re-metrics` adapter parses Re Protocol's official metrics page and now extracts instant redemption vault capacity from the embedded `redemptionRows` payload. The reserve slices remain metrics-derived, while nested redemption telemetry carries the current direct vault capacity from the same API payload for `reusd-re-protocol`.

`fx` now publishes f(x) protocol pool debt balances as conservative live proxy redemption capacity for `fxusd-f-x-protocol`; the configured score-grade path reads the reviewed Ethereum WBTC and wstETH pool collateral/debt totals directly on-chain. `fxsave-f-x-protocol` uses the generic `erc4626-single-asset` path to publish the vault's idle fxSP balance as live-direct capacity for its fxSP/router exit route. The same adapter can also attach reviewed ERC-4626 liquidity sidecars: Morpho V1/V2 vault configs use Morpho V2 `liquidity` or V1 `liquidity.underlying` as same-run API capacity after validating the vault address, chain id, listed status, and underlying asset; Yearn V3 configs use the vault's same-run default withdrawal queue, measuring `totalIdle()` plus each funded strategy's `min(currentDebt, convertToAssets(maxRedeem(vault)))`. Morpho V2 `forceDeallocatableLiquidity` is persisted for context but not used as scoring capacity, and Yearn V3 funded-strategy probe failures degrade instead of falling back to full NAV. `asymmetry` now publishes USDaf protocol supply from the timestamped stats API as live direct redemption capacity alongside branch collateral slices. `jupusd` consumes Jupiter's public transparency API and latest snapshot timestamp, grouping USDC/USDtb holdings into reserve slices while emitting whitelisted-primary live redemption capacity and route status from the public oracle endpoint.

`usdgo-transparency`, `solstice-attestation`, and `river-protocol-info` are proof-class reserve-sync adapters. They make current issuer/protocol telemetry visible on reserve detail and status surfaces, but their registry evidence class is `weak-live-probe`, so they do not override report-card collateral quality. USDGO currently parses BUIDL, STBXX, optional JLTXX, and cash buckets from the public transparency payload, and remains proof-class until source provenance, per-slice risk evidence, and date-only freshness semantics are methodology-approved; Solstice remains proof-class until its aggregate solvency feed exposes timestamped asset-category composition; River remains proof-class because its protocol-info endpoint exposes aggregate TVL/circulating-supply telemetry rather than asset-level collateral composition. River snapshots degrade when the aggregate TVL is below circulating satUSD, and timestampless protocol-info payloads remain freshness-unverified.

`zephyr-scanner` consumes Zephyr's reserve snapshot API for `zsd-zephyr-protocol`, preserving the snapshot capture timestamp, ZEPH reserve value, ZSD supply, reserve ratio, moving-average reserve ratio, and ZSD yield-reserve metadata. It is proof-class because the feed is protocol-published native-chain telemetry over volatile ZEPH collateral rather than independently verified asset-level reserve evidence.

Accountable note:
`accountable` configs may exclude reviewed buckets from strict `total_reserves` reconciliation when the dashboard publishes auxiliary reserves outside the reported total. Those excluded buckets are also omitted from normalized reserve slices so auxiliary values cannot dilute or inflate the published collateral mix. Configs may also allow reviewed signed exposure buckets; negative buckets are omitted from reserve slices, recorded in metadata, and degrade the snapshot instead of opening the breaker.

Chainlink NAV note:
`chainlink-nav` now supports both standard AggregatorV3 feeds and Ondo router-style NAV lookups. When `oracleMethod = "getAssetPrice"`, the adapter calls `getAssetPrice(token)` on the router and, when available, follows `tokenToRWAOracle(token) -> getPriceData()` to recover a verified freshness timestamp instead of treating the feed as permanently timestampless.

Chainlink PoR note:
`chainlink-por` supports USD-denominated reserve feeds and commodity reserve-unit feeds. Commodity configs such as Kinesis KAU and KAG set `reserveUnit = "XAU"` or `"XAG"`; those snapshots persist reserve quantity/unit metadata and intentionally omit USD reserve totals, supply USD, and collateralization ratios because the feed proves physical commodity quantity rather than a USD liability value.

`superstate-liquidity` extends USTB's on-chain NAV reserve proof with Superstate's public liquidity endpoint. Reserve slices remain NAV-based, while nested redemption telemetry uses the current Circle USD available amount plus USDC RedemptionIdle balance as bounded proxy capacity. Missing or malformed liquidity fields fail the adapter instead of falling back to NAV/AUM as immediate liquidity.

`usd1-bundle-oracle` reads USD1's Chainlink bundle oracle on Ethereum. The adapter decodes `latestBundle()` into a source timestamp and reserve value, cross-checks `latestBundleTimestamp()`, reads live USD1 total supply, and stores reserve metadata from latest-state on-chain data. The oracle publishes WLFI aggregate fund reserves across multiple products rather than USD1-earmarked collateral, so the adapter intentionally does not emit a `collateralizationRatio`. The raw fund-reserve / USD1-supply ratio is persisted as `fundBackingTotalRatio` alongside a `details.fundScope` disclaimer; consumers must not read it as a 1:1 collateralization signal.

`frax-balance-sheet` now covers both `frxusd-frax` and legacy `frax-frax` through the Frax v2 balance-sheet API. Known Frax ecosystem assets are classified explicitly; any future unmapped balance-sheet exposure is aggregated and only degrades the run when material. For frxUSD redemption modeling, the adapter emits current stablecoin capacity as a USD amount and intentionally avoids reusing reserve-composition ratios as supply-relative redemption capacity.

`frax-fpi-collateral` parses Frax's `/v2/fpifpis/fpi-collateral` endpoint for FPI. It excludes self-held FPI from reserve slices, nets self-held FPI against liabilities, classifies known Frax ecosystem assets, and degrades only when unmapped non-FPI collateral exposure becomes material.

`yamato` reads CJPY reserve state directly from Yamato's `getStates()` contract path and values ETH collateral with the configured Yamato price-feed `getPrice()` call. The latest-state on-chain read uses `freshnessMode = "not-applicable"` and publishes protocol collateral ratio and threshold metadata for the reserve detail view.

Business-day NAV feeds can set `maxOracleAgeSec` when their oracle is expected to pause through weekends or market holidays; `ousg-ondo-finance` and `mtbill-midas` use a 4-day window so normal Friday-to-Monday NAV cadence does not trip their reserve circuit breakers. Weekly or institutional NAV feeds can also set a wider oracle-read grace window while pairing it with `scoring.maxSourceAgeSec`; for example, `mre7yield-midas` accepts up to 14-day Chainlink NAV reads at the adapter layer but degrades snapshots older than 7 days before they can enter score-grade live collateral. BUIDL and Spiko EUTBL use the same split policy with a 7-day Chainlink NAV read window and a 4-day scoring freshness cap, so delayed institutional NAV updates can keep reserve detail/status surfaces populated without entering score-grade live collateral.

`spiko-api` reads Spiko's public `share-classes/{symbol}/totals` REST endpoint directly for the six Spiko fund shares that do not have a Chainlink NAV oracle (`eursafo-spiko`, `safo-spiko-usd`, `gbpsafo-spiko`, `uktbl-spiko`, `eurspkcc-spiko`, `spkcc-spiko`). `totalAssets.value`, `totalShares`, and `netAssetValue.amount.value` are all denominated in the same fund currency, so `collateralizationRatio` needs no FX conversion; `totalReserveUsd`/`supplyUsd` are only persisted when the fund currency is USD so EUR/GBP fund totals are never mislabeled as USD. The adapter emits the coin's single configured reserve slice (matching its curated bucket: swap/money-market exposure for the SAFO share classes, UK Treasury bills and cash for UKTBL, and the cash-and-carry strategy for the SPKCC share classes) at 100%, and uses `netAssetValue.updatedAt` as a verified source timestamp. Because the CACEIS-administered NAV only updates on business days, `spiko-api` uses `BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC` (5 days) so a holiday-extended weekend doesn't trip staleness before the next NAV lands.

`usdtb-transparency` reads Ethena's public `backing-and-supply/current` REST endpoint for `usdtb-ethena`. `backingAssets` amounts are summed per asset across custodian entries; BUIDL and BUIDL-I (the same BlackRock fund's institutional share class) merge into one slice, USDC and USDT map to their tracked coins, and `assetsInMotion` becomes its own honestly-labeled settlement-float slice. USDtb's own self-held balance is excluded from backing as self-referential (an info warning fires if it is ever nonzero), and any future unmapped backing-asset key degrades into an "unmapped" bucket rather than failing the sync closed. `collateralizationRatio` is the sum of all backing slices (including assets in motion) over `supply`, and `lastUpdatedAt` is a verified source timestamp under `DASHBOARD_SOURCE_MAX_AGE_SEC` (3 days).

`tether-transparency` reads Tether's public `transparency.json` (one payload shared by `usdt-tether` and `xaut-tether`, selected by `params.currencyIso`). This is a coarse issuer balance-sheet feed like `frax-balance-sheet`: it does not itemize reserve composition, so `params.slices` carries a configured static mix reviewed alongside each coin's `collateral` disclosure, while the live payload validates `total_assets` / `total_liabilities` and freshness. `collateralizationRatio` is `total_assets / total_liabilities`; the USD-denominated `totalAssetsUsd`, `totalLiabilitiesUsd`, and `shareholderEquityUsd` metadata fields are only persisted for `usdt-tether`; XAUt's unit is gold-equivalent, not verified USD, so only the dimensionless ratio is kept. Per-chain issued liabilities (`totalAuthorized - notIssued`) and quarantined amounts from `data_formatted[].blockChains` populate `metadata.details.chains`, and a nonzero quarantined balance on any chain raises an info warning. The freshness timestamp comes from the entry's `id` (Unix seconds). Because these totals are Tether's own self-published figures rather than a third-party-audited feed, the adapter's `evidenceClass: "independent"` classification (mirroring `frax-balance-sheet`) is flagged for owner review.

Adapter helpers now live in a small helper family, with `worker/src/cron/reserve-adapters/helpers.ts` kept as the shared import surface:

- HTTP JSON / HTML fetch wrappers (`fetchJsonWithRetry`, `fetchTextWithRetry`)
- HTML parser failure helpers that distinguish upstream layout drift (`layout-changed`) from content decoding failures (`parse-failed`) so attempt logs are more actionable for scraped disclosures
- Shared bucketed-composition accumulation and classification helpers (`classification.ts`) for adapters that collapse many raw assets into a smaller reserve-bucket surface while tracking unknown exposure consistently
- Shared unverified-freshness metadata helper so timestamp-less dashboard feeds explain why they remain non-scoring, plus a not-applicable freshness helper for reviewed latest-state on-chain/API reads
- DefiLlama spot-price loading for valuation (`fetchDefiLlamaPrices`), with fixed-price overrides supported for wrapper branches in `evm-branch-balances`; tracked branch assets can also reuse a fresh stablecoins cache price when DefiLlama address pricing is missing
- EVM balance, total-supply, hex-call, and Multicall3 aggregate reads (`fetchErc20Balance`, `fetchErc20TotalSupply`, `fetchOnchainMulticall3`)
- Solana / on-chain mint-supply reads (`probeTrackedTokenSupply`, `probeOnchainTotalSupply`) used by `curated-validated` for tracked assets
- Input-kind type guards and validators (`requireJsonInput`, `requireJsonInputFromConfig`, etc.)
- Slice normalization / valuation / unknown-exposure math (`slice-math.ts`) with configurable precision (`normalizeSlices`, `slicesFromValues`, `valueUsdFromBigIntPrice`)
- Risk validation (`isReserveRisk`)

`worker/src/cron/reserve-adapters/evm.ts` provides EVM address-decoding/contract-resolution helpers (`parseEvmAddressResult`, `resolveCoinContractAddress`); ERC-4626 vault introspection helpers live in `erc4626.ts` and raw on-chain call helpers in `onchain.ts`.

### Adding a New Adapter

To register a new adapter for a coin's `liveReservesConfig.adapter`, edit these surfaces in order. The shared projection test and Worker registry test fail if descriptor or fetcher coverage drifts.

1. **Params schema, when needed** — define a reusable Zod schema in `shared/lib/live-reserve-adapter-schema-primitives.ts` and expose it through `LIVE_RESERVE_PARAM_SCHEMAS`. Reuse `none` or another existing schema when the shape already matches.
2. **Descriptor declaration** — add one entry to `LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS` in `shared/types/live-reserve-adapter-declarations.ts`. Declare accepted primary input kinds, params-schema identifier, source/evidence class, source-sharing policy, supported semantics/versions, redemption telemetry, validation policy, and only non-default provenance or display metadata. The key union and all shared lookup maps derive from this entry.
3. **Adapter fetch function** — add `worker/src/cron/reserve-adapters/<key>.ts` exporting `async function fetch<Name>Reserves(coin, config, signal, ctx?): Promise<AdapterResult>`. Adapter contract lives in `worker/src/cron/reserve-adapters/types.ts` (`AdapterFn`, `AdapterContext`, `AdapterResult`). Use helpers from `./helpers` rather than rebuilding fetch/parse/freshness primitives.
4. **Worker fetcher wiring** — import the fetch function and add it to `LIVE_RESERVE_ADAPTER_FETCHERS` in `worker/src/cron/reserve-adapters/index.ts`. This remains separate because Worker implementations cannot enter the runtime-neutral shared registry.
5. **Config, test, fixture, and docs** — bind the coin's `liveReservesConfig`, add `worker/src/cron/reserve-adapters/__tests__/<key>.test.ts`, capture an HTTP-html fixture when applicable, and register non-obvious semantics in the Adapter Registry notes above.

Minimal scaffold (HTTP-json single-asset shape):

```ts
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
} from "./helpers";

interface MyAdapterPayload {
  totalReserves: number;
  updatedAt?: string;
}

export async function fetchMyAdapterReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "my-adapter");
  const params = parseLiveReserveAdapterParams("my-adapter", config.params);
  const payload = await fetchJsonWithRetry<MyAdapterPayload>(input.url, signal, 12_000, ctx);
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.updatedAt);

  return {
    slices: [{ name: params.assetLabel, pct: 100, risk: params.assetRisk }],
    metadata: {
      ...freshnessMetadataFromTimestamp(sourceTimestamp, "issuer-api", "payload has no source timestamp"),
    },
  };
}
```

---

## Frontend Consumers

- `src/hooks/use-stablecoin-reserves.ts` uses mode-aware polling: `live` responses follow the 4-hour reserve producer cadence (`staleTime = 4 hours` / `refetchInterval = 8 hours`), while stale or fallback modes tighten to `1 minute` / `2 minutes` so the UI re-checks recovery faster
- `src/hooks/use-stablecoin-detail-view-model.ts` injects the reserve result into the detail-page view model
- `src/lib/coverage.ts` uses the adapter badge taxonomy in `shared/lib/live-reserve-display.ts` so `/coverage` distinguishes true `Live` reserve feeds from `Curated-Validated` and `Proof` reserve-sync paths
- `worker/src/api/status.ts` uses `computeReserveCompositionOverview()` to surface reserve-sync health on `/status`

---

## Scope Boundaries

- Live reserve sync is detail-page and status-surface infrastructure, not a replacement for curated reserve metadata everywhere else.
- [Risk Lab](./report-cards.md) uses fresh authoritative independent live reserve snapshots for collateral quality scoring when available. In practice this now means: `dynamic-mix` adapters can qualify when their latest sync state is `ok` **and** the snapshot carries scoring-eligible freshness evidence, only a subset of `single-bucket` adapters carry `evidenceClass = independent`, and `validated-static` / `weak-live-probe` feeds remain detail-card/status data only. Dependency inference uses the same score-grade live snapshot; live slices with `coinId` become dependency links, unmapped live share stays implicit self-backed / non-stablecoin exposure, and curated/static dependency modeling is used only when no score-grade live snapshot is available.
- Blacklist attribution no longer treats live reserves as invisible just because most adapters lack `coinId` links. The report-card resolver enriches both live and curated reserve names with the same blacklist clue pipeline, then resolves inherited exposure to a fixed point across the tracked set so cyclic upstream graphs do not depend on traversal order. The collateral drift alert only compares comparable live reserve mixes: snapshots must still resolve to at least two live slices after normalization, so single-bucket proofs and collapsed one-slice snapshots do not generate noisy curated-vs-live drift alerts.
- [Dependency Map](./dependency-map.md) remains authoritative for graph behavior; dependency edges now come from the effective report-card dependency source, including score-grade live reserve links when present and curated/static reserve metadata plus manual dependencies otherwise.

---

## File Index

| File                                                   | Role                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `shared/types/live-reserve-core.ts`                    | Runtime-neutral reserve descriptor enums, input types, and validation policy                           |
| `shared/types/live-reserves.ts`                        | `LiveReservesConfig`, `StablecoinReservesResponse`, sync-state types                                   |
| `shared/types/live-reserve-adapter-declarations.ts`    | Lightweight single adapter key/schema-id/definition/provenance/display declaration                     |
| `shared/lib/live-reserve-adapter-descriptors.ts`       | Zod-resolved descriptor registry plus derived compatibility projections                                |
| `shared/lib/live-reserve-adapter-schema-primitives.ts` | Reusable Zod config/input schema primitives consumed by descriptors                                    |
| `shared/lib/live-reserve-adapters.ts`                  | Stable shared facade for descriptor projections and config parsing                                     |
| `shared/lib/stablecoins/registry.ts`                   | Loader for per-coin `liveReservesConfig` declarations backed by `shared/data/stablecoins/coins/*.json` |
| `worker/src/cron/sync-live-reserves.ts`                | 4-hourly sync orchestration and cron result statuses                                                   |
| `worker/src/cron/reserve-adapters/index.ts`            | Exhaustive Worker-only adapter fetcher map and runtime registry                                        |
| `worker/src/cron/reserve-adapters/helpers.ts`          | Shared adapter fetch / normalization helpers                                                           |
| `worker/src/lib/live-reserves-store.ts`                | Public facade over the live-reserve store helpers                                                      |
| `worker/src/lib/live-reserves-store-read.ts`           | D1 read/query helpers and authoritative row loaders                                                    |
| `worker/src/lib/live-reserves-store-write.ts`          | D1 write paths and history pruning                                                                     |
| `worker/src/lib/live-reserves-store-overview.ts`       | Status overview, scoring-eligible freshness checks, and authoritative snapshot maps                    |
| `worker/src/lib/live-reserves-store-views.ts`          | Detail/API reserve-result resolution and curated/static fallback handling                              |
| `worker/src/lib/live-reserves-store-shared.ts`         | Shared live-reserve store types, constants, and row mapping                                            |
| `worker/src/api/stablecoin-reserves.ts`                | Public API handler                                                                                     |
| `src/hooks/use-stablecoin-reserves.ts`                 | Frontend query hook                                                                                    |
| `src/hooks/use-stablecoin-detail-view-model.ts`        | Detail-page integration                                                                                |
