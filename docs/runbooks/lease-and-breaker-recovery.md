# Runbook: Lease And Breaker Recovery

Shared recovery procedure for two operator actions that several symptom runbooks reach for: clearing a stuck cron lease and clearing an open provider circuit breaker. Diagnose the incident in the symptom runbook first; this doc owns only the safety rule and the exact statements.

## Retired Endpoints

`POST /api/reset-cron-lease` and `POST /api/reset-circuit-breaker` were retired on 2026-08-09 with the rest of the curl-only operator surface and now return `404`. The scoped deletes below are exactly what those endpoints ran. Kill, Telegram pending-clear, and resend have no direct-D1 equivalent; see [`docs/worker-infrastructure.md`](../worker-infrastructure.md).

## Safety Precondition

Never clear a lease while `/api/status` shows a fresh matching `crons[*].inFlight` progress row for the same job: the run is still live and the lease is doing its job. Confirm the lease is stale first — repeated `skipped_locked` runs with no fresh progress heartbeat. Never clear a breaker before the upstream has actually recovered; the delete forces the next call to re-probe closed and a still-failing source simply re-opens it.

## Clear A Stuck Cron Lease

Lease rows are keyed by `cron_leases.job`, using the status-tracked job id (`sync-stablecoins`, `sync-yield-data`, `fetch-tbill-rate`, and so on):

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "DELETE FROM cron_leases WHERE job = '<job>';"
```

Then verify the next scheduled run of that job completes and publishes.

## Clear An Open Circuit Breaker

Breaker state lives in the D1 `cache` table under `circuit:<source>`; scoped live-reserve breakers use the same convention as `circuit:live-reserves:<scope>`. The state model and health impact are documented in [`docs/worker-infrastructure.md`](../worker-infrastructure.md#circuit-breakers).

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "DELETE FROM cache WHERE key = 'circuit:<source>';"
```

Delete only the affected source row. `cache["provider:circuit:index"]` is best-effort aggregate telemetry and is rebuilt by the next breaker write.
