# Runbook: D1 Database Connectivity

Triggered by `StatusCause.code`:
- `db_unhealthy`
- `data_quality_skipped_db_unhealthy`

## Symptom

`/api/status` reports a fallback payload; `assessPublicHealth` failed its connectivity probe. The state notifier has short-circuited, and data-quality loaders were skipped to avoid cascading failures.

## First checks

1. **Cloudflare D1 dashboard:** confirm the `stablecoin-db` database is reachable and not in maintenance.
2. **Recent deploys:** `cd worker && npx --no-install wrangler deployments list` — did a new Worker version ship with a migration that's still applying? Migrations apply *before* the Worker is live, so a hang here is rare but possible for very large backfills.
3. **D1 region:** check for regional outages at https://www.cloudflarestatus.com/.

## Remediation

- If the database is reachable but the Worker can't see it, the binding may have drifted. Re-check the `worker/wrangler.toml` `[[d1_databases]]` block for the correct `database_id`, then use the standard protected production deploy workflow after correcting it.
- If a migration is mid-apply, wait it out. Check `cd worker && npx --no-install wrangler d1 migrations list stablecoin-db --remote` to confirm state.
- If a transient network issue, the next `status-self-check` cron (every 15 min) will self-clear. No manual action needed once connectivity recovers.

## Prevention

- `status-self-check` flags `db_unhealthy` on the first failure; the hysteresis policy holds `stale` for 180s minimum before recovery. Short blips are absorbed.
- Long-running migrations should be batched so each statement stays under D1's 30s per-statement limit.
