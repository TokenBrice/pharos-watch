# Status Dashboard

Operational reference for `/status`: admin auth flow, backend status computation, hysteresis state machine, discrepancy detection, endpoint probing, and inline admin actions.

---

## Scope

The status dashboard combines seven signals:

1. Cache freshness (`/api/status` -> `caches`)
2. Cron health (`/api/status` -> `crons`)
3. Data quality (`/api/status` -> `dataQuality`)
4. Status state machine (`/api/status` -> `state`, `timeline`, `causes`, `summary`)
5. Synthetic status probes (`/api/status` -> `probe`, `discrepancy`)
6. Live reserve sync health (`/api/status` -> `reserveComposition`)
7. Live endpoint probing (`useEndpointProbes`) + filtered history (`useStatusHistory`)

This page is **auth-gated in practice** because `/api/status` plus the admin probe/action paths require a valid admin credential. There are now two active frontend modes:

- `ops.pharos.watch`: Cloudflare Access-protected operator host. The browser uses same-origin Pages Functions routes under `/api/admin/*`, and those functions proxy to `ops-api.pharos.watch` with a service token.
- `pharos.watch`: temporary fallback host. The old browser-entered `X-Admin-Key` flow still exists here until the public `/status` route is retired. The fallback key stays in memory only for the current tab and expires after 15 minutes of inactivity.

---

## Frontend Flow

### Route and metadata

- Page: `src/app/status/page.tsx`
- Client implementation: `src/app/status/client.tsx`
- Session/auth hook: `src/hooks/use-admin-session-key.ts`
- Dashboard model hook: `src/hooks/use-status-dashboard-model.ts`
- Ops proxy route: `functions/api/admin/[[path]].ts`
- Pure derived-data helpers: `src/lib/status-dashboard-model.ts`
- Decomposed UI components: `src/components/status/*`
- The page shell now adds a command-center top fold above the widget stack:
  - a compact triage utility bar for refresh/auth state (`RefreshCountdown`, sign-out, worker/client timestamp chips)
  - consolidated overall-status hero (`StatusBanner`) + a short blocker watchlist
  - a promoted `Recommended now` action strip derived from active causes / unhealthy cron lanes
  - a `Follow this order` lane list that mirrors the priority-ranked section order
  - a sticky `LongformScrollspyNav` rail for section-level navigation while scrolling
- Metadata disables indexing (`robots: { index: false, follow: false }`)

### Data hooks

- `src/hooks/use-status.ts`
  - Calls `GET /api/status` either through same-origin `/api/admin/status` on `ops.pharos.watch` or with `X-Admin-Key` on the public fallback host
  - Query key uses either the ops-proxy scope or the legacy secret-free session revision, never the raw key
  - `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`
- `src/hooks/api-hooks.ts`
  - Owns the shared low-friction query wrappers for `GET /api/health`, `GET /api/peg-summary`, `GET /api/dex-liquidity`, `GET /api/report-cards`, `GET /api/yield-rankings`, and related read endpoints
  - This is the live source of truth for `useHealth()` / `usePegSummary()` and the other cache-backed read hooks used by the dashboard model
- `src/hooks/use-endpoint-probes.ts`
  - Probes **public + admin** endpoint probe groups with `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`
  - Public probes still hit the public API origin; admin probes switch to same-origin `/api/admin/*` on the ops host
  - Manual/admin mutation actions are listed but intentionally not auto-probed
- `src/hooks/use-status-history.ts`
  - Calls `GET /api/status-history` either through same-origin `/api/admin/status-history` on `ops.pharos.watch` or with `X-Admin-Key` on the public fallback host
  - Query key uses either the ops-proxy scope or the legacy secret-free session revision, never the raw key
  - Adds rolling windows (`6h`, `24h`, `7d`, `30d`) for timeline drilldown
- `functions/api/admin/[[path]].ts`
  - Cloudflare Pages Functions catch-all for operator-only admin routes
  - Validates the `Cf-Access-Jwt-Assertion` for the UI Access app before forwarding
  - Host-gates to `ops.pharos.watch` so public hostnames cannot use the proxy
  - Strips `/api/admin` and forwards to `ops-api.pharos.watch` with `CF-Access-Client-Id` / `CF-Access-Client-Secret`
- `src/hooks/use-status-dashboard-model.ts`
  - Owns the polling orchestration for `useStatus`, `useHealth`, `useEndpointProbes`, and `useStatusHistory`
  - Derives the operational lane summaries, severity-ranked section order, notice rail entries, and cross-surface status deltas used by the page shell
- `src/components/longform-scrollspy-nav.tsx`
  - Applies sticky section navigation without re-running hash alignment on every live refresh, so polling does not snap operators back to an anchored section mid-scroll
- `src/components/status/telegram-bot-stats.tsx`
  - Renders Telegram subscriber adoption metrics, top subscribed coins, custom-preference / quiet-hour counts, and the latest `dispatch-telegram-alerts` delivery summary
- Cron cards are grouped by trigger slot on the page:
  - 15-minute core ingestion / score recompute
  - 5-minute Telegram dispatch lane, with cemetery-announcement sidecar work on the same trigger
  - 20-minute on-chain intake jobs shown together, but labeled as isolated triggers (`sync-blacklist`, `sync-mint-burn`, `sync-mint-burn-extended`, `sync-dex-discovery`)
  - 30-minute charts / liquidity / yield jobs
  - hourly reserve / redemption lane (`sync-live-reserves`, `sync-redemption-backstops`)
  - daily snapshot / digest / coverage-discovery jobs
  - Cards use operator-friendly labels but keep raw job ids visible in monospace for log lookup, plus the exact cron expression and whether the trigger is shared vs isolated
  - When a leased job is still running, cards surface `running` / `running-stale` state from `crons[*].inFlight`
  - Shared display metadata now comes from `shared/lib/cron-jobs.ts`, which also feeds worker interval expectations
  - Job-specific metadata summaries are resolved through `src/components/status/cron-metadata-summary.ts` instead of a long inline `if` chain inside `cron-card.tsx`
- The client now groups widgets into six operational lanes instead of one flat vertical list:
  - `Overview`: incident detail first, with the state-machine / probe diagnostics moved behind a secondary disclosure block
  - `Actions`: manual response tools promoted upward when recommendations exist; Telegram delivery telemetry is now secondary and collapsible
  - `Pipeline`: data-quality threshold board, price-source health, liquidity health, dataset freshness, live reserve sync health, a full-width mint/burn reconciliation grid, and discovery backlog
  - Mint/burn reconciliation now defaults to the six highest-severity rows and exposes the long insufficient-source tail behind a `See all` disclosure button
  - `Reliability`: browser probes, circuit breakers, public-health divergence callouts, and cache freshness
  - `Cron Lanes`: grouped cron-card clusters with trigger-theme wrappers; unhealthy/degraded groups sort first and fully healthy groups collapse by default
  - `History`: filtered incident timeline windows
- Lane order below `Overview` is no longer fixed; `Actions`, `Pipeline`, `Cron Lanes`, and `Reliability` are ranked from current incident severity so the scroll order tapers from urgent action into broader telemetry.
- Runtime warnings (`client stale`, `/api/health` divergence, hook fetch failures) are collapsed into a shared notice rail above the sticky lane nav instead of rendering as separate free-floating banners.

### Endpoint groups

Probe groups are sourced from `shared/lib/api-endpoints.ts`:

- `public`: user-facing read endpoints
- `admin`: admin read endpoints
- `manual`: operator-triggered actions (shown in UI, not loop-probed)

---

## Backend Contract (`GET /api/status`)

Source: `worker/src/api/status.ts`

Related extracted loaders:

- `worker/src/api/status-derived-data.ts`
  - `getDatasetFreshness()`
  - `getTelegramBotStats()`
  - `getMintBurnReconciliation()`
  - empty fallback builders for dataset freshness / reserve composition
- `worker/src/api/status-data-quality.ts`
  - canonical stablecoins-cache / blacklist-gap / active-depeg / on-chain-supply quality aggregation

### Auth and caching

- Requires a valid admin credential (`requireAdmin`)
- Response cache policy: `Cache-Control: no-store`

`computeRawStatus()` now performs the DB sentinel first and returns an explicit stale fallback snapshot when that sentinel fails, instead of throwing before the dashboard can show operator-visible degraded state.

### Cron health model

`CRON_INTERVALS` defines expected cadence per job (seconds). A cron is healthy when:

- A fresh non-stale `crons[*].inFlight` heartbeat exists for the job, or
- Last run exists within `2 * expectedIntervalSec`
- Last run status is `ok`, or
- Last run status is `degraded` (warning-only fallback mode), or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run in the same freshness window

Operational nuance: a fresh recovery attempt should not keep `/status` degraded purely because the most recent completed run failed. When a leased cron is actively running and its heartbeat is fresh, availability treats that lane as live again while still preserving the previous completed run in card history.

Mint/burn public freshness now uses the same grace window before warning: `/api/mint-burn-flows` and `/flows` stay `fresh` through `2 * expectedIntervalSec` for the critical lane (`40m` at the current cadence), then degrade/stale afterward. This avoids the public flows page warning while `/status` still shows the mint/burn lane healthy.

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`, `failedCoinErrors`) so operators can tell whether the staging crawl is still feeding the scorer and which source path failed per coin.
- `sync-dex-liquidity` `degraded` explicitly captures non-fatal upstream degradation (critical source-family failures or near-guard coverage drops), with machine-readable metadata (`failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters, and staged skip-reason breakdowns for address vs fingerprint dedup).
- `sync-mint-burn` is now the critical lane, while `sync-mint-burn-extended` drains long-tail backlog on its own offset schedule. The status surface tracks them independently so extended backlog pressure does not mask critical freshness.
- `crons[*].inFlight` exposes live `cron_run_progress` state (`stage`, `itemsDone`, `itemsTotal`, `message`, `updatedAt`, `stale`) for long-running leased jobs such as blacklist, mint/burn, and DEX discovery.
- `sync-live-reserves` now emits structured metadata (`synced`, `failed`, `skipped`, `warningCount`, `coinsWithWarnings`, `coinsWithErrors`, `breakerKeys`) summarized in the cron card.

### Availability status

Computed from cache staleness + cron error state:

- `stale` if any of:
  - `worstCacheRatio > 2`
  - any cron lastRun status is `error`
  - `unhealthyCrons >= 3`
- `degraded` if any of:
  - `worstCacheRatio > 1.5`
  - `unhealthyCrons > 0`
- else `healthy`

`degraded` cron runs are counted separately in `summary.degradedCrons` and shown in cron cards, but do not by themselves mark availability degraded.

### Data quality status

Computed from missing prices + blacklist gaps + on-chain supply monitor:

- `stale` if any of:
  - stablecoins cache is unavailable/corrupt (`dataQuality.stablecoinsCacheStatus === "error"`)
  - `missingPriceRatio > 0.4`
  - `blacklistMissingRatio >= 0.02` (2%)
  - `blacklistRecentMissingAmounts >= 25` (last 24h)
  - `staleOnchainSupply >= 10`
  - `onchainSupplyDivergences >= 25`
  - `onchainStaleRatio >= 0.25`
  - `onchainDivergenceRatio >= 0.25`
- `degraded` if any of:
  - stablecoins cache is degraded but still usable (`dataQuality.stablecoinsCacheStatus === "degraded"`, currently legacy-array payloads only)
  - any critical data-quality subquery failed (`dataQuality.sourceFailures.length > 0`)
  - `missingPriceRatio > 0.15`
  - `blacklistRecentMissingAmounts > 0` (last 24h)
  - `blacklistMissingRatio >= 0.005` (0.5%)
  - `onchainStaleRatio >= 0.1`
  - `onchainDivergenceRatio >= 0.1`
- else `healthy`

Mint/burn freshness uses shared defaults from `worker/src/lib/mint-burn-health-config.ts`:

- major symbols: `USDT`, `USDC`, `DAI`, `USDS`, `GHO`, `FRXUSD`, `BOLD`, `reUSD`
- warning threshold: `6h`
- critical threshold: `24h`

The public `/api/health` lane now keys mint/burn freshness to the critical-lane sync timestamp / latest run status rather than raw event timestamps, matching the `/flows` semantics and avoiding quiet-period false stale alerts.

`dataQuality.onchainSupplyMonitoring === "unavailable"` still renders in the quality cards, but it is no longer promoted to an active cause/watchlist item on its own while the on-chain supply monitor has no live producer.

### Overall status

`rawOverallStatus` is the worse of `availabilityStatus` and `dataQualityStatus` (`healthy < degraded < stale`).

`overallStatus` is the **effective** status after hysteresis state-machine reconciliation:

- `healthy -> degraded`: requires 2 consecutive raw degraded checks
- `healthy -> stale`: immediate on raw stale
- `degraded -> stale`: requires 2 consecutive raw stale checks
- `degraded -> healthy`: requires 3 consecutive raw healthy checks (+ dwell)
- `stale -> degraded`: requires 2 consecutive raw degraded checks (+ stale dwell)
- `stale -> healthy`: requires 3 consecutive raw healthy checks (+ stale dwell)

Additional response fields:

- `confidence`: normalized status confidence (0.1–1.0)
- `causes`: structured trigger list (`availability`, `dataQuality`, `overall`)
- `state`: state-machine counters and thresholds
- `staleness`: freshness of status-system evaluations
- `probe`: latest synthetic probe aggregate
- `discrepancy`: divergence between effective status and synthetic probe status
- `timeline`: recent status transitions
- `telegramBot`: admin-only Telegram bot subscriber aggregates (`null` when Telegram tables are unavailable)
- `datasetFreshness`: last-write timestamps for key operational datasets (`stablecoins`, `blacklist`, `mintBurn`, `supply`, `safetyGrades`, `yield`, `depegs`, `dews`, `digest`, `discoveryCandidates`)
- `summary`: compact availability rollup (`unhealthyCrons`, `degradedCrons`, `cronErrors`, `worstCacheRatio`)
- `reserveComposition`: live reserve sync coverage summary (`configuredCoins`, `freshCoins`, `staleCoins`, `missingCoins`, `degradedCoins`, `lastSuccessAt`, `oldestFreshAgeSec`)

`dataQuality` now also exposes:

- `stablecoinsCacheStatus`: `ok | degraded | error`
- `stablecoinsCacheReason`: machine-readable reason when the stablecoins cache is unavailable or transitional
- `blacklistGapStatus`: `ok | failed`
- `activeDepegStatus`: `ok | failed`
- `onchainSupplyQueryStatus`: `ok | failed | unavailable`
- `sourceFailures`: list of failed critical subqueries with machine-readable source keys and error messages

This prevents `/status` from silently treating a broken stablecoins cache as `0 / 0` healthy price coverage.

When one of those critical subqueries fails, `/api/status` now degrades `dataQualityStatus` and the status cards render `ERR` for the affected metric instead of showing a misleading `0`.

Cache freshness subqueries are now also explicit. If a dedicated-table freshness lookup fails, `/api/status` adds a `cache_freshness_query_failed` availability cause instead of only surfacing a stale ratio.

The public `/api/health` companion endpoint now returns a `warnings` array for these best-effort failures, and the status page model treats that as additional public-health context instead of assuming zero-like data is real.

### Live reserve sync health

`reserveComposition` is derived from:

- coins with `liveReservesConfig`
- `reserve_composition`
- `reserve_sync_state`

Behavior:

- bootstrap is suppressed until the first successful live reserve sync exists
- only matched `reserve_composition` + `reserve_sync_state.last_success_at` pairs count as live snapshots; orphaned or split-write rows are treated as missing
- after bootstrap, stale/degraded/missing live reserve feeds can degrade `dataQualityStatus`
- the page renders a dedicated `Live Reserve Sync` card in the pipeline lane

### Telegram bot metrics

The `/status` payload now includes a `telegramBot` block derived from:

- `telegram_subscribers`
- `telegram_subscriptions`
- `telegram_pending_disambiguation`
- `telegram_pending_alerts`

The UI uses that block plus `crons["dispatch-telegram-alerts"].lastRun.metadata` to show:

- total known chats
- alert-enabled and alert-ready chats (including global all-stablecoin follows)
- total coin follows and average follows per subscribed chat
- pending disambiguation replies
- pending delivery backlog
- alert-type adoption counts
- custom-preference adoption and quiet-hours adoption
- muted / misconfigured chat counts
- top subscribed stablecoins
- latest dispatch delivery stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `freshRetryQueued`, `freshPermanentFailures`, `pendingRetryQueued`, `pendingDropped`)

### Synthetic self-check

`status-self-check` runs on `*/15 * * * *` and:

1. Probes critical public/admin read endpoints using a hybrid strategy:
   - default production origin (`https://api.pharos.watch`): router-dispatched internal `GET` requests to avoid Cloudflare custom-domain self-fetch `522` false negatives while still exercising the real handler/auth path
   - explicit non-default `SELF_URL`: real HTTPS `fetch()` probes with a 10s timeout per endpoint
   - internal-router timings reflect uncached worker handler execution, not browser-visible edge-cache latency
   - cache-backed bootstrap probes (`/api/usds-status`, `/api/bluechip-ratings`, `/api/yield-rankings`) are treated as bootstrap misses rather than hard failures only while their producing cron has never recorded a run
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak and probe-failure streak in `status_discrepancy_state`.
5. Sends alert on sustained divergence and independently alerts on sustained probe failures (3+ consecutive failing checks).

The cron metadata now includes:

- `probeMode` / `probeBaseUrl`
- `bootstrapMissCount`
- `latencySummary` (`minMs`, `medianMs`, `p95Ms`, `maxMs`)
- `slowestProbes` (top slow endpoints for the run)

`status_discrepancy_state` persists both divergence and probe-failure alert state:
`consecutive_divergent`, `last_divergent_at`, `last_alert_at`,
`consecutive_probe_failures`, `last_probe_failure_at`, and `last_probe_alert_at`.

### History endpoint (`GET /api/status-history`)

Admin machine-readable timeline endpoint for internal tooling and incident audits.

Response includes:

1. persisted state snapshot
2. status-system staleness
3. latest probe aggregate
4. discrepancy summary
5. transition list (`limit` query param, max 200)

---

## Endpoint Probing

Source: `src/hooks/use-endpoint-probes.ts`

- Probe timeout: 5s per endpoint
- Parallel probing with `Promise.all`
- Admin probe paths include `X-Admin-Key`
- The dashboard labels these as **browser-origin probes** to distinguish them from the worker-origin `status-self-check` synthetic probe stored in `/api/status`
- Parameterized routes probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=usdt-tether`) to avoid expected `400` validation responses.
- The stablecoin-detail probe also uses a curated canary `probePath` rather than the heaviest history payload, so route-health checks are less sensitive to oversized per-coin datasets.
- Routes without a stable canary URL are intentionally excluded from automatic probe coverage. `GET /api/digest-snapshot` is omitted because it requires a valid `date` that must map to a real stored digest.
- Returned result shape: `{ path, status, latencyMs, error? }`

Manual actions are rendered from `getStatusPageActions()` and executed only on user confirmation.

---

## Inline Admin Actions

Status-page manual actions are router-dispatched from shared endpoint metadata (`shared/lib/api-endpoints.ts`):

- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `GET /api/debug-sync-state`
- `POST /api/backfill-depegs`
- `POST /api/backfill-supply-history`
- `POST /api/backfill-cg-prices`
- `POST /api/backfill-stability-index`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `POST /api/reclassify-atomic-roundtrips`
- `GET /api/audit-depeg-history?dry-run=true`
- `GET /api/backfill-dews`

The UI now uses these actions in two ways:

- a complete operator tool shelf (`All actions`)
- contextual recommendations derived from active causes and unhealthy cron lanes (`Recommended now`)

Each action execution is confirmed, logged locally in the page, and triggers a status/probe/history refresh on completion.

`POST /api/backfill-mint-burn` is operator-safe from the status page even without an explicit `configKey`: the worker auto-selects the most behind Ethereum config with a critical-first / major-symbol-first policy and returns the selected config in the response payload.

Mutating admin paths are protected by method guardrails:

- `GET` on mutating admin path -> `405` with `Allow: POST`

---

## Coverage Discovery Card

**Component:** `DiscoveryCandidatesCard` (`src/components/status/discovery-candidates.tsx`)

Renders after the Admin Actions section. Shows stablecoins tracked by CoinGecko or DefiLlama that Pharos does not yet monitor. Each row displays symbol, name, a source badge (`CG` / `DL` / `Both`), market cap, days seen, and a dismiss button. Admin auth is required for the dismiss action (`POST /api/discovery-candidates/:id/dismiss`). Data is sourced from `GET /api/discovery-candidates` (admin endpoint, active candidates only).

## Price Source Health Card

**Component:** `PriceSourceHealthCard` (`src/components/status/price-source-health.tsx`)

Renders after the Circuit Breakers section. Shows the current price confidence distribution across all tracked stablecoins:

- **Confidence tiles** — colored metric tiles for `High`, `Single-source`, `Low`, `Fallback`, and `Missing` counts
- **Source breakdown line** — which price sources contributed to the current sync, including protocol redemption quotes when they override thin market pricing
- **Divergences list** — collapsible list of assets where dual-primary sources disagreed by more than 50 bps
- **Last sync age** — how old the price-health snapshot is

Data is sourced from `sync-stablecoins` cron metadata stored in the most recent `cron_runs` row — no extra DB query required.

## Mint/Burn Reconciliation Card

**Component:** `MintBurnReconciliationCard` (`src/components/status/mint-burn-reconciliation.tsx`)

Renders after the Liquidity Health section. It compares:

- 24h Ethereum mint/burn net flow from `mint_burn_hourly`
- 24h Ethereum chain-supply delta from the cached stablecoins payload's `chainCirculating.ethereum.current - circulatingPrevDay`

Each row shows:

- stablecoin symbol
- reconciliation status (`ok`, `warn`, `critical`, `insufficient-source`)
- coverage hint (`full`, `partial-history`, `bootstrapping`, or `unknown`)
- absolute USD difference
- raw flow net, raw chain delta, and ratio

This is an operator integrity signal, not a public user-facing score. Large gaps typically mean one of:

- flow coverage is still partial or newly bootstrapping
- upstream chain distribution moved in a way the mint/burn tracker does not capture
- ingestion or classification logic needs review

---

## Related Files

| File                                                 | Role                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/status/client.tsx`                          | Host-aware auth gate + status dashboard orchestration shell; `ops.pharos.watch` skips the legacy key prompt and uses Access-backed proxy mode                                                                                                                                        |
| `src/components/status/*`                            | Decomposed status UI modules (banner, facts, diagnostics, probe grid, cron cards, admin actions, tables). Cron cards are grouped by trigger slot, surface trigger expressions + isolation mode, show last-good/error-skip context, and expose full raw metadata in collapsible panels. |
| `src/components/status/telegram-bot-stats.tsx`       | Telegram bot subscriber metrics + last dispatch summary panel                                                                                                                                                                                                                          |
| `src/components/status/discovery-candidates.tsx`     | Discovery candidates card — untracked stablecoin list with dismiss actions                                                                                                                                                                                                             |
| `src/components/status/price-source-health.tsx`      | Price source health card — confidence distribution, source breakdown, divergences                                                                                                                                                                                                      |
| `src/components/status/mint-burn-reconciliation.tsx` | Mint/burn reconciliation card — 24h Ethereum flow vs chain-supply delta diagnostics                                                                                                                                                                                                    |
| `src/hooks/use-status.ts`                            | Shared polling policy for `/api/status` (`staleTime=60s`, `refetchInterval=120s`) with either ops-host same-origin proxy mode or legacy admin-key auth                                                                                                                              |
| `src/hooks/api-hooks.ts`                             | Shared read hooks consumed by the dashboard model (`useHealth`, `usePegSummary`, `useDexLiquidity`, `useReportCards`, `useYieldRankings`)                                                                                                                                              |
| `src/hooks/use-endpoint-probes.ts`                   | Shared polling policy for endpoint probes (`staleTime=60s`, `refetchInterval=120s`); admin probes switch to same-origin proxy mode on the ops host                                                                                                                                    |
| `src/hooks/use-status-history.ts`                    | Shared polling policy for `/api/status-history` + dashboard time-window filters in both ops-host proxy mode and public fallback mode                                                                                                                                                 |
| `functions/api/admin/[[path]].ts`                    | Pages Functions admin proxy: Access JWT validation, ops-host gating, upstream method/path allowlisting, and service-token forwarding to `ops-api.pharos.watch`                                                                                                                       |
| `shared/lib/cron-jobs.ts`                            | Shared cron expressions, display grouping, trigger isolation metadata, and per-job intervals used by both frontend and worker                                                                                                                                                          |
| `shared/lib/api-endpoints.ts`                        | Shared endpoint contract metadata: paths, probe groups, method/cache flags, status-page actions                                                                                                                                                                                       |
| `worker/src/route-registry.ts`                       | Static route binding registry keyed by shared endpoint metadata                                                                                                                                                                                                                        |
| `worker/src/router.ts`                               | Route dispatcher: static registry lookup plus dynamic stablecoin/discovery/OG matching                                                                                                                                                                                                |
| `worker/src/api/status.ts`                           | Raw status synthesis + effective state response                                                                                                                                                                                                                                        |
| `worker/src/api/status-history.ts`                   | Machine-readable status timeline/history endpoint                                                                                                                                                                                                                                      |
| `worker/src/api/health.ts`                           | Public health endpoint for cache/circuit observability                                                                                                                                                                                                                                 |
| `worker/src/lib/status-reliability.ts`               | Hysteresis, transitions, probes, discrepancy helpers                                                                                                                                                                                                                                   |
| `worker/src/cron/status-self-check.ts`               | Real-HTTP self-probe + divergence/probe-failure alert cron                                                                                                                                                                                                                             |
