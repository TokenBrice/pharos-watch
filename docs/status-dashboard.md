# Status Dashboard

Operational reference for `/status`: admin auth flow, backend status computation, hysteresis state machine, discrepancy detection, endpoint probing, and inline admin actions.

---

## Scope

The status dashboard combines six signals:

1. Cache freshness (`/api/status` -> `caches`)
2. Cron health (`/api/status` -> `crons`)
3. Data quality (`/api/status` -> `dataQuality`)
4. Status state machine (`/api/status` -> `state`, `timeline`)
5. Synthetic status probes (`/api/status` -> `probe`, `discrepancy`)
6. Live endpoint probing (`useEndpointProbes`)

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
- `src/components/status/telegram-bot-stats.tsx`
  - Renders Telegram subscriber adoption metrics, top subscribed coins, and the latest `dispatch-telegram-alerts` delivery summary
- Cron cards are grouped by trigger slot on the page:
  - 15-minute core ingestion / score recompute
  - 20-minute intake + `sync-dex-discovery`
  - 30-minute scoring + downstream `sync-yield-data`
  - daily snapshot / digest jobs
  - Cards use operator-friendly labels but keep raw job ids visible in monospace for log lookup

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

- Last run exists within `2 * expectedIntervalSec`
- Last run status is `ok`, or
- Last run status is `degraded` (warning-only fallback mode), or
- Last run status is `skipped_locked` **and** there is a fresh `ok` run in the same freshness window

For the split DEX pipeline:

- `sync-dex-discovery` surfaces crawl-progress metadata (`coinsCrawled`, `poolsDiscovered`, `tierBreakdown`, `budgetExhausted`, `failedCoins`) so operators can tell whether the staging crawl is still feeding the scorer.
- `sync-dex-liquidity` `degraded` explicitly captures non-fatal upstream degradation (critical source-family failures or near-guard coverage drops), with machine-readable metadata (`failedSources`, `fallbackMode`, `sourceCoverage`, staged-pool merge counters).

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
  - `missingPriceRatio > 0.4`
  - `blacklistMissingRatio >= 0.02` (2%)
  - `blacklistRecentMissingAmounts >= 25` (last 24h)
  - `staleOnchainSupply >= 10`
  - `onchainSupplyDivergences >= 25`
  - `onchainStaleRatio >= 0.25`
  - `onchainDivergenceRatio >= 0.25`
- `degraded` if any of:
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
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak and probe-failure streak in `status_discrepancy_state`.
5. Sends alert on sustained divergence and independently alerts on sustained probe failures (3+ consecutive failing checks).

The cron metadata now includes:

- `probeMode` / `probeBaseUrl`
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
- Parameterized routes probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=usdt-tether`) to avoid expected `400` validation responses.
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

Mutating admin paths are protected by method guardrails:

- `GET` on mutating admin path -> `405` with `Allow: POST`

---

## Related Files

| File                                           | Role                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/status/client.tsx`                    | Auth gate + status dashboard orchestration shell                                                                                                                                                                      |
| `src/components/status/*`                      | Decomposed status UI modules (banner, diagnostics, probe grid, cron cards, admin actions, tables). Cron cards are grouped by trigger slot, surface structured metadata for warning/error runs, show textual recent-run counts alongside history dots, and expose full raw metadata in a collapsible panel. |
| `src/components/status/telegram-bot-stats.tsx` | Telegram bot subscriber metrics + last dispatch summary panel                                                                                                                                                         |
| `src/hooks/use-status.ts`                      | Shared polling policy for `/api/status` (`staleTime=60s`, `refetchInterval=120s`) with admin key auth                                                                                                                 |
| `src/hooks/use-endpoint-probes.ts`             | Shared polling policy for endpoint probes (`staleTime=60s`, `refetchInterval=120s`) + group definitions                                                                                                               |
| `shared/lib/api-endpoints.ts`                  | Shared endpoint registry for probe groups + status-page actions                                                                                                                                                       |
| `worker/src/router.ts`                         | Static route dispatch for status, probes, and shared admin action endpoints (`trigger-digest`, `reset-blacklist-sync`, `debug-sync-state`, mint/burn backfills, DEWS audit/backfill)                                 |
| `worker/src/api/status.ts`                     | Raw status synthesis + effective state response                                                                                                                                                                       |
| `worker/src/api/status-history.ts`             | Machine-readable status timeline/history endpoint                                                                                                                                                                     |
| `worker/src/api/health.ts`                     | Public health endpoint for cache/circuit observability                                                                                                                                                                |
| `worker/src/lib/status-reliability.ts`         | Hysteresis, transitions, probes, discrepancy helpers                                                                                                                                                                  |
| `worker/src/cron/status-self-check.ts`         | Real-HTTP self-probe + divergence/probe-failure alert cron                                                                                                                                                            |
