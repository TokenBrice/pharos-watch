# Status Dashboard

Operational reference for `/status`: admin auth flow, backend status computation, endpoint probing, and inline admin actions.

---

## Scope

The status dashboard combines four independent signals:

1. Cache freshness (`/api/status` -> `caches`)
2. Cron health (`/api/status` -> `crons`)
3. Data quality (`/api/status` -> `dataQuality`)
4. Live endpoint probing (`useEndpointProbes`)

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

### Overall status

`overallStatus` is the worse of `availabilityStatus` and `dataQualityStatus` (`healthy < degraded < stale`).

---

## Endpoint Probing

Source: `src/hooks/use-endpoint-probes.ts`

- Probe timeout: 5s per endpoint
- Parallel probing with `Promise.all`
- Admin probe paths include `X-Admin-Key`
- Returned result shape: `{ path, status, latencyMs, error? }`

Manual actions are rendered from `getStatusPageActions()` and executed only on user confirmation.

---

## Inline Admin Actions

These are handled directly in `worker/src/index.ts` and surfaced on the status page:

- `POST /api/trigger-digest`
- `POST /api/reset-blacklist-sync`
- `GET /api/debug-sync-state`

Mutating admin paths are protected by method guardrails:

- `GET` on mutating admin path -> `405` with `Allow: POST`

---

## Related Files

| File | Role |
|------|------|
| `src/app/status/client.tsx` | Status UI (banner, cron cards, cache table, probe grid, circuit table, action dialog) |
| `src/hooks/use-status.ts` | 60s polling for `/api/status` with admin key auth |
| `src/hooks/use-endpoint-probes.ts` | 60s endpoint probe loop + group definitions |
| `src/lib/api-endpoints.ts` | Shared endpoint registry for probe groups + status-page actions |
| `worker/src/api/status.ts` | Core status synthesis logic (cache/cron/data-quality) |
| `worker/src/api/health.ts` | Public health endpoint for cache/circuit observability |
| `worker/src/index.ts` | Inline admin action handlers and mutating-method enforcement |
