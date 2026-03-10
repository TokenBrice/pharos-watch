# Status Dashboard

Operational reference for `/status`: admin auth flow, backend status computation, hysteresis state machine, discrepancy detection, endpoint probing, and inline admin actions.

---

## Scope

The status dashboard combines six signals:

1. Cache freshness (`/api/status` -> `caches`)
2. Cron health (`/api/status` -> `crons`)
3. Data quality (`/api/status` -> `dataQuality`)
4. Status state machine (`/api/status` -> `state`, `timeline`, `causes`, `summary`)
5. Synthetic status probes (`/api/status` -> `probe`, `discrepancy`)
6. Live endpoint probing (`useEndpointProbes`) + filtered history (`useStatusHistory`)

This page is **auth-gated in practice** because `/api/status` plus the admin probe/action paths require `X-Admin-Key`.

---

## Frontend Flow

### Route and metadata

- Page: `src/app/status/page.tsx`
- Client implementation: `src/app/status/client.tsx`
- Decomposed UI components: `src/components/status/*`
- Metadata disables indexing (`robots: { index: false, follow: false }`)

### Data hooks

- `src/hooks/use-status.ts`
  - Calls `GET /api/status` with `X-Admin-Key`
  - `staleTime: 60_000`, `refetchInterval: 120_000`, `retry: 0`
- `src/hooks/use-health.ts`
  - Calls `GET /api/health`
- `src/hooks/use-endpoint-probes.ts`
  - Probes **public + admin** endpoint probe groups every 60s
  - Manual/admin mutation actions are listed but intentionally not auto-probed
- `src/hooks/use-status-history.ts`
  - Calls `GET /api/status-history` with `X-Admin-Key`
  - Adds rolling windows (`6h`, `24h`, `7d`, `30d`) for timeline drilldown
- `src/components/status/telegram-bot-stats.tsx`
  - Renders Telegram subscriber adoption metrics, top subscribed coins, and the latest `dispatch-telegram-alerts` delivery summary
- Cron cards are grouped by trigger slot on the page:
  - 15-minute core ingestion / score recompute
  - 20-minute on-chain intake jobs shown together, but labeled as isolated triggers (`sync-blacklist`, `sync-mint-burn`, `sync-mint-burn-extended`, `sync-dex-discovery`)
  - 30-minute charts / liquidity / yield jobs
  - daily snapshot / digest / coverage-discovery jobs
  - Cards use operator-friendly labels but keep raw job ids visible in monospace for log lookup, plus the exact cron expression and whether the trigger is shared vs isolated
  - When a leased job is still running, cards surface `running` / `running-stale` state from `crons[*].inFlight`
  - Shared display metadata now comes from `shared/lib/cron-jobs.ts`, which also feeds worker interval expectations
- Status-specific sections now include:
  - `Status Facts`: summary counters + machine-readable causes with optional inline remediation actions
  - `Status Diagnostics`: worker-side self-check, browser-side probe loop, divergence, and state-machine counters
  - `Dataset Freshness`: last-writer timestamps by dataset domain and expected freshness based on owning cron cadence
  - `Incident Timeline`: filtered history windows with expandable persisted causes per transition

### Endpoint groups

Probe groups are sourced from `shared/lib/api-endpoints.ts`:

- `public`: user-facing read endpoints
- `admin`: admin read endpoints
- `manual`: operator-triggered actions (shown in UI, not loop-probed)

---

## Backend Contract (`GET /api/status`)

Source: `worker/src/api/status.ts`

### Auth and caching

- Requires `X-Admin-Key` (`requireAdmin`)
- Response cache policy: `Cache-Control: no-store`

### Cron health model

`CRON_INTERVALS` defines expected cadence per job (seconds). A cron is healthy when:

- A fresh non-stale `crons[*].inFlight` heartbeat exists for the job, or
- Last run exists within `2 * expectedIntervalSec`
- Last run status is `ok`, or
- Last run status is `degraded` (warning-only fallback mode), or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run in the same freshness window

Operational nuance: a fresh recovery attempt should not keep `/status` degraded purely because the most recent completed run failed. When a leased cron is actively running and its heartbeat is fresh, availability treats that lane as live again while still preserving the previous completed run in card history.

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`, `failedCoinErrors`) so operators can tell whether the staging crawl is still feeding the scorer and which source path failed per coin.
- `sync-dex-liquidity` `degraded` explicitly captures non-fatal upstream degradation (critical source-family failures or near-guard coverage drops), with machine-readable metadata (`failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters, and staged skip-reason breakdowns for address vs fingerprint dedup).
- `sync-mint-burn` is now the critical lane, while `sync-mint-burn-extended` drains long-tail backlog on its own offset schedule. The status surface tracks them independently so extended backlog pressure does not mask critical freshness.
- `crons[*].inFlight` exposes live `cron_run_progress` state (`stage`, `itemsDone`, `itemsTotal`, `message`, `updatedAt`, `stale`) for long-running leased jobs such as blacklist, mint/burn, and DEX discovery.

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
- `datasetFreshness`: last-write timestamps for key operational datasets (`stablecoins`, `blacklist`, `mintBurn`, `supply`, `yield`, `depegs`, `dews`, `digest`)
- `summary`: compact availability rollup (`unhealthyCrons`, `degradedCrons`, `cronErrors`, `worstCacheRatio`)

`dataQuality` now also exposes:

- `stablecoinsCacheStatus`: `ok | degraded | error`
- `stablecoinsCacheReason`: machine-readable reason when the stablecoins cache is unavailable or transitional

This prevents `/status` from silently treating a broken stablecoins cache as `0 / 0` healthy price coverage.

### Telegram bot metrics

The `/status` payload now includes a `telegramBot` block derived from:

- `telegram_subscribers`
- `telegram_subscriptions`
- `telegram_pending_disambiguation`

The UI uses that block plus `crons["dispatch-telegram-alerts"].lastRun.metadata` to show:

- total known chats
- alert-enabled and alert-ready chats
- total coin follows and average follows per subscribed chat
- pending disambiguation replies
- alert-type adoption counts
- muted / misconfigured chat counts
- top subscribed stablecoins
- latest dispatch delivery stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`)

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
- **Source breakdown line** — which price sources contributed to the current sync
- **Divergences list** — collapsible list of assets where dual-primary sources disagreed by more than 50 bps
- **Last sync age** — how old the price-health snapshot is
- **Shadow pipeline stats** — divergence summary, coverage deltas, and compared-asset count

Data is sourced from `sync-stablecoins` cron metadata stored in the most recent `cron_runs` row — no extra DB query required.

---

## Related Files

| File                                             | Role                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/status/client.tsx`                      | Auth gate + status dashboard orchestration shell                                                                                                                                                                                                                                       |
| `src/components/status/*`                        | Decomposed status UI modules (banner, facts, diagnostics, probe grid, cron cards, admin actions, tables). Cron cards are grouped by trigger slot, surface trigger expressions + isolation mode, show last-good/error-skip context, and expose full raw metadata in collapsible panels. |
| `src/components/status/telegram-bot-stats.tsx`   | Telegram bot subscriber metrics + last dispatch summary panel                                                                                                                                                                                                                          |
| `src/components/status/discovery-candidates.tsx` | Discovery candidates card — untracked stablecoin list with dismiss actions                                                                                                                                                                                                             |
| `src/components/status/price-source-health.tsx`  | Price source health card — confidence distribution, source breakdown, divergences                                                                                                                                                                                                      |
| `src/hooks/use-status.ts`                        | Shared polling policy for `/api/status` (`staleTime=60s`, `refetchInterval=120s`) with admin key auth                                                                                                                                                                                  |
| `src/hooks/use-endpoint-probes.ts`               | Shared polling policy for endpoint probes (`staleTime=60s`, `refetchInterval=120s`) + group definitions                                                                                                                                                                                |
| `src/hooks/use-status-history.ts`                | Shared polling policy for `/api/status-history` + dashboard time-window filters                                                                                                                                                                                                        |
| `shared/lib/cron-jobs.ts`                        | Shared cron expressions, display grouping, trigger isolation metadata, and per-job intervals used by both frontend and worker                                                                                                                                                          |
| `shared/lib/api-endpoints.ts`                    | Shared endpoint registry for probe groups + status-page actions                                                                                                                                                                                                                        |
| `worker/src/router.ts`                           | Static route dispatch for status, probes, and shared admin action endpoints (`trigger-digest`, `reset-blacklist-sync`, `debug-sync-state`, mint/burn backfills, DEWS audit/backfill)                                                                                                   |
| `worker/src/api/status.ts`                       | Raw status synthesis + effective state response                                                                                                                                                                                                                                        |
| `worker/src/api/status-history.ts`               | Machine-readable status timeline/history endpoint                                                                                                                                                                                                                                      |
| `worker/src/api/health.ts`                       | Public health endpoint for cache/circuit observability                                                                                                                                                                                                                                 |
| `worker/src/lib/status-reliability.ts`           | Hysteresis, transitions, probes, discrepancy helpers                                                                                                                                                                                                                                   |
| `worker/src/cron/status-self-check.ts`           | Real-HTTP self-probe + divergence/probe-failure alert cron                                                                                                                                                                                                                             |
