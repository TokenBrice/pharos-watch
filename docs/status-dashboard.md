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

This page is **admin-only in practice** because all status/probe calls require `X-Admin-Key` for admin paths.

---

## Frontend Flow

### Route and metadata

- Page: `src/app/status/page.tsx`
- Client implementation: `src/app/status/client.tsx`
- Metadata disables indexing (`robots: { index: false, follow: false }`)

### Data hooks

- `src/hooks/use-status.ts`
  - Calls `GET /api/status` with `X-Admin-Key`
  - `staleTime: 60_000`, `refetchInterval: 60_000`, `retry: 0`
- `src/hooks/use-health.ts`
  - Calls `GET /api/health`
- `src/hooks/use-endpoint-probes.ts`
  - Probes **public + admin** endpoint probe groups every 60s
  - Manual/admin mutation actions are listed but intentionally not auto-probed

### Endpoint groups

Probe groups are sourced from `src/lib/api-endpoints.ts`:

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

For `sync-dex-liquidity`, `degraded` now explicitly captures non-fatal upstream degradation (critical source-family failures or near-guard coverage drops), with machine-readable metadata (`failedSources`, `fallbackMode`, `sourceCoverage`).

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

### Synthetic self-check

`status-self-check` runs on `*/15 * * * *` and:

1. Probes critical public/admin read endpoints.
2. Persists probe aggregate to `status_probe_runs`.
3. Reconciles raw status into persisted effective state.
4. Tracks divergence streak in `status_discrepancy_state`.
5. Sends alert on sustained divergence.

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
- Parameterized routes probe `probePath` values from registry (for example `/api/mint-burn-events?stablecoin=1`) to avoid expected `400` validation responses.
- Returned result shape: `{ path, status, latencyMs, error? }`

Manual actions are rendered from `getStatusPageActions()` and executed only on user confirmation.

---

## Inline Admin Actions

These are handled directly in `worker/src/index.ts` and surfaced on the status page:

- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `GET /api/debug-sync-state`
- `POST /api/backfill-mint-burn-prices`
- `POST /api/backfill-mint-burn`
- `GET /api/backfill-dews`

Mutating admin paths are protected by method guardrails:

- `GET` on mutating admin path -> `405` with `Allow: POST`

---

## Related Files

| File | Role |
|------|------|
| `src/app/status/client.tsx` | Status UI (banner, cron cards, cache table, probe grid, circuit table, action dialog) |
| `src/hooks/use-status.ts` | Shared polling policy for `/api/status` (`staleTime=60s`, `refetchInterval=120s`) with admin key auth |
| `src/hooks/use-endpoint-probes.ts` | Shared polling policy for endpoint probes (`staleTime=60s`, `refetchInterval=120s`) + group definitions |
| `src/lib/api-endpoints.ts` | Shared endpoint registry for probe groups + status-page actions |
| `worker/src/api/status.ts` | Raw status synthesis + effective state response |
| `worker/src/api/status-history.ts` | Machine-readable status timeline/history endpoint |
| `worker/src/api/health.ts` | Public health endpoint for cache/circuit observability |
| `worker/src/lib/status-reliability.ts` | Hysteresis, transitions, probes, discrepancy helpers |
| `worker/src/cron/status-self-check.ts` | Synthetic probe + divergence alert cron |
| `worker/src/index.ts` | Inline admin action handlers and mutating-method enforcement |
