# Runbook: Lease And Breaker Recovery

Shared recovery procedure for two operator actions that several symptom runbooks reach for: clearing a stuck cron lease and clearing an open provider circuit breaker. Diagnose the incident in the symptom runbook first; this doc owns only the safety rule and the exact statements.

## Retired Endpoints

`POST /api/reset-cron-lease` and `POST /api/reset-circuit-breaker` were retired on 2026-08-09 with the rest of the curl-only operator surface and now return `404`. The scoped deletes below are exactly what those endpoints ran. Kill, Telegram pending-clear, and resend have no direct-D1 equivalent; see [`docs/worker-infrastructure.md`](../worker-infrastructure.md).

## Safety Precondition

Never clear a lease while `/api/status` shows a fresh matching `crons[*].inFlight` progress row for the same job: the run is still live and the lease is doing its job. Confirm the lease is stale first — repeated `skipped_locked` runs with no fresh progress heartbeat. Never clear a breaker before the upstream has actually recovered; after the existing five-second isolate memo expires, the missing row reads as closed and permits another fetch. A still-failing source accumulates failures and re-opens at `CIRCUIT_OPEN_THRESHOLD` (`shared/lib/ops-limits.ts`).

For reserve-family locks, inspect `blockedBy` rather than treating the lease key as the holder job: config repair and checkpoint replay intentionally share `sync-live-reserves`. The requester `leaseOwner` is separate. Versioned holder envelopes name the actual path/invocation/slot; legacy owners are attributed only through exact-owner-matched progress, and unknown fields remain null. The natural producer waits only within its fixed admission budget (approximately 145 seconds for a fresh head); a renewed/long rollout lease can exceed that budget. Do not evict it to force admission.

`producer-slot-priority` and `heavy-slot-co-tenancy` are neutral recovery deferrals, not a stuck lease or evidence of publication. Check the protected slot identity and its finished clock, and the shared heavy-slot policy in `shared/lib/scheduled-runner-registry.ts`. Missing producer delivery remains protected; diagnose delivery rather than manufacture a slot row.

Incompatible checkpoint debt requires supersession, not a checkpoint/lease reset: a real newer finished slot must contain a completed current-hash full cohort. Recovery prioritizes active debt within its bounded 25-row drain, records exact `superseded_by_json`, and atomically fences only a matching pending attempt. A successful operator-only cohort without a real slot cannot qualify. Historical debt alone leaves a successful idle poll `ok` with debt telemetry. Never resurrect retired checkpoints, clear live claims or refresh rejected issuer evidence clocks.

## Clear A Stuck Cron Lease

Run the Wrangler examples from `worker/`, where `wrangler.toml` declares `stablecoin-db`. Lease rows are keyed by `cron_leases.job`, using the status-tracked job id (`sync-stablecoins`, `sync-yield-data`, `fetch-tbill-rate`, and so on):

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "DELETE FROM cron_leases WHERE job = '<job>';"
```

Then verify the next scheduled run of that job completes and publishes.

## Clear An Open Circuit Breaker

Breaker state lives in the D1 `cache` table under `circuit:<source>`; scoped live-reserve breakers use the same convention as `circuit:live-reserves:<scope>`. The state model and health impact are documented in [`docs/worker-infrastructure.md`](../process/worker-infrastructure-appendix.md#circuit-breakers).

```bash
npx --no-install wrangler d1 execute stablecoin-db --remote --command \
  "DELETE FROM cache WHERE key = 'circuit:<source>';"
```

Delete only the affected source row. Admin provider summaries enumerate active sources and read bounded direct `circuit:<source>` rows; no aggregate rebuild is needed. The obsolete `provider:circuit:index` has no runtime reader/writer. Its orphan row may be deleted only in a separately authorized destructive release after current/deployed/rollback/external zero-use proof, rollback-floor closure, an exact-row durable R2 export retained indefinitely and a recorded Time Travel bookmark. Never clear all circuits or shared registries/ledgers/history as index cleanup.
