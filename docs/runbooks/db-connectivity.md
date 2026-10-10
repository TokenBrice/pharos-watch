# Runbook: D1 Database Connectivity

Triggered by `StatusCause.code`:
- `db_unhealthy`
- `data_quality_skipped_db_unhealthy`

## Symptom

`/api/status` reports a fallback payload; `assessPublicHealth` failed its connectivity probe. Data-quality loaders were skipped to avoid cascading failures; status persistence may also fail, leaving only the raw fallback rather than a durable transition.

## First checks

1. **Cloudflare D1 dashboard:** confirm the `stablecoin-db` database is reachable and not in maintenance.
2. **Recent deploys:** `cd worker && npx --no-install wrangler deployments list` — did a new Worker version ship with a migration that's still applying? Migrations apply *before* the Worker is live, so a hang here is rare but possible for very large backfills.
3. **D1 region:** check for regional outages at https://www.cloudflarestatus.com/.

## Remediation

- If the database is reachable but the Worker can't see it, the binding may have drifted. Re-check the `worker/wrangler.toml` `[[d1_databases]]` block for the correct `database_id`, then use the standard protected production deploy workflow after correcting it.
- If a migration is mid-apply, wait it out. Check `cd worker && npx --no-install wrangler d1 migrations list stablecoin-db --remote` to confirm state.
- If a transient network issue, the next `status-self-check` cron (every 15 min) will self-clear. No manual action needed once connectivity recovers.

## Prevention

- A failed sentinel makes the raw availability verdict `stale`. When status persistence succeeds, a previously `healthy` state escalates on one stale reading (`escalateToStale = 1`); a previously `degraded` state requires two (`STATUS_DEGRADED_TO_STALE_THRESHOLD`). Recovery from `stale` to `healthy` requires three consecutive healthy readings (`recoverToHealthy = 3`) and the 180s minimum dwell, roughly 30–45 minutes after connectivity returns at the 15-minute cadence. Recovery to `degraded` instead requires two degraded readings and the same dwell.
- Long-running migrations should be batched so each statement stays under D1's 30s per-statement limit.
