# Runbook: D1 Connectivity, Capacity and Telemetry Pressure

Triggered by `StatusCause.code`:
- `db_unhealthy`
- `data_quality_skipped_db_unhealthy`
- `d1_capacity_watch`
- `d1_capacity_warning`
- `d1_capacity_critical`
- `d1_capacity_query_failed`

## Symptom

`/api/status` reports a fallback payload; `assessPublicHealth` failed its connectivity probe. Data-quality loaders were skipped to avoid cascading failures; status persistence may also fail, leaving only the raw fallback rather than a durable transition.

For storage warnings use [Capacity signals](#capacity-signals); for write-pressure shedding use [Telemetry kill switch](#telemetry-kill-switch). Compatibility-date qualification and retired replication research belong to [runtime experiments](../process/worker-runtime-experiments.md), not incident remediation.

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

## Capacity signals

The paid-plan D1 limit is 10 GB per database and cannot be raised. Utilization floors are: below 60% `normal`; 60–<75% `watch` (review 30-day growth/largest retained tables); 75–<90% `warning` (schedule retention/index remediation and confirm a Time Travel bookmark); ≥90% `critical` (stop nonessential write amplification and execute the approved capacity plan). Watch opens a warning; warning degrades health; critical makes it stale.

The billing-quota floors are separate and ops-only. `d1Usage.quota` projects the trailing-24h rows read/written over a 30-day month against the paid included allowances (25 B rows read, 50 M rows written; [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). ≥80% opens `d1_rows_read_quota_watch`/`d1_rows_written_quota_watch`; ≥95% opens the matching `_warning` cause. Those causes appear only in the admin `/api/status` cause lists; they never change availability status or public health (owner decision D10). Unavailable analytics leave the projection and utilization null with `thresholdState: "unavailable"`, never zero.

`status-self-check` refreshes control-plane telemetry every 15 minutes with the dedicated bindings. `d1_capacity_observations` coalesces one observation per UTC hour and retains raw observations for 180 days. `capacity.hourlyMinMax24h` keeps the min/max/swing across the retained hourly observations in the trailing 24 hours, so intra-day allocation swings (observed at 560–770 MB) stay visible instead of collapsing into the retained-size point. Forecasting selects the shortest qualifying 24h/72h/7d/30d regression window with ≥3 samples covering ≥90% of its span. An unqualified or flat/negative slope leaves `exhaustionAt` null, never removing a utilization floor. Runway is advisory, not pruning/sharding authorization. A `DELETE` reducing file size proves only that run's result, not guaranteed compaction.

A failed refresh preserves the last cached assessment. Missing, malformed, >26h-old or future-clock evidence yields degraded health and sanitized `d1-capacity-<reason>` warnings, not an unconfigured healthy exception.

The daily census reuses a same-UTC-day snapshot under the existing cron lease, with no separate database claim. It serially counts reviewed exact table names/families and serves detail for ≤50h. Missing/malformed/noninteger/negative counts enter `failedTables`, never healthy zero; genuine zero, negative deltas and nullable timestamp attribution remain valid. Counts/deltas are not disk size or bytes written. Detailed capacity/census rows are admin-only at `/api/status.d1Usage.capacity` and `.tableGrowth`; the card renders aggregate metrics. Status requests never run census aggregates. Admin supplements reuse the 15-minute raw snapshot (30-minute TTL); stale/missing snapshots permit live fallback, which may refresh hourly capacity history.

Verify `d1CapacityMonitoring`/`d1TableGrowthMonitoring`, `tableCount`, `failedTables`, `failedTableCount`, public warnings and admin assessments. After a released UTC-day census, record allowlist completeness, failures, duration/D1 reads and cache age. Do not force production thresholds with synthetic observations. Follow [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and migration backup/Time Travel safety; capacity remediation is not blanket permission for destructive cleanup.

## Telemetry kill switch

Use when D1 latency/queue pressure threatens product reads, Telegram dispatch or cron writes: D1 subsection errors, stale cron telemetry, usage warnings, `D1 DB is overloaded`/`Requests queued for too long`, or delayed Telegram pending writes while cache-hit traffic still generates attribution.

### Kill-switch order

1. Set `REQUEST_SOURCE_ATTRIBUTION_DISABLED=true` on Worker and Pages environments. Route/source writes stop; API-key auth, D1 rate limiting and per-key load controls remain.
2. Only during keyed spikes, set Worker-only `API_KEY_REQUEST_ATTRIBUTION_DISABLED=true`. Per-key stats stop; auth, D1 quota enforcement and best-effort last-used updates remain.
3. **Never remove the Pages `DB` binding.** Selector-snapshot POST quotas require it; removing it returns `503 Snapshot quota store is not configured`.
4. Do not use `MAINTENANCE_MODE=true` for telemetry pressure alone: it returns 503 for all non-OPTIONS product traffic.

From `worker/`:

```bash
printf "true" | npx wrangler secret put REQUEST_SOURCE_ATTRIBUTION_DISABLED
printf "true" | npx wrangler secret put API_KEY_REQUEST_ATTRIBUTION_DISABLED
```

Pages uses project environment variables; disable route/source attribution in production and preview if both generate pressure. The per-key flag is Worker-only. Roll back from `worker/` after pressure clears:

```bash
npx wrangler secret delete REQUEST_SOURCE_ATTRIBUTION_DISABLED
npx wrangler secret delete API_KEY_REQUEST_ATTRIBUTION_DISABLED
```

### Verification

Use authenticated `/api/request-source-stats?measurementVersion=2` (or the Pages `/api/admin/request-source-stats` proxy with that query); require `200`, `Cache-Control: no-store`, measurement metadata and the intended `[from,to)` window. Unversioned calls must return `400 attribution-measurement-version-required`. This reader-first release leaves writers unchanged and sample tables empty; verify ordinary old source writes continue and old key writes leave `source_v2_request_count=0` after migration.

For a disabled environment, compare bounded raw observations in matching fresh windows, not rolling expanded estimates: legacy counters or sampled `sample_count` must stop after in-flight flushes. After separately approved sampled-writer activation, absence of a 1/64 sample in one or two windows does **not** prove the kill switch is working, nor does zero estimate prove no traffic. Record policy, sample sizes, probability strata, window clocks and coverage; do not manufacture production requests/failures. Per-key counters remain unsampled: compare `apiKeys[].requestCount` and full-window `keyedPublicApi.keyedRequests` independently of route estimates. Missing/failed evidence stays unavailable.

Confirm protected requests still enforce keys/quotas, Pages selector-snapshot quotas retain `DB`, and Telegram still writes metadata/pending rows. Remove flags after recovery and observe real counter/sample persistence over a sufficiently populated window; this emergency switch is not the sampling remediation. Captured Pages transport failures remain unsampled and UI warnings retain those event semantics.

For migration 0275 retain the verified pre-window Time Travel bookmark, ledger, both Worker identities and Pages release marker; apply D1 before Workers, then Pages. After the later writer cutover, keep this measurement-aware reader/UI as rollback floor. Legacy 35-day row deletion continues during the drain: no immediate sub-95% quota projection is guaranteed. Compare complete post-release 24h windows and matched hours over multiple days; billing/Insights sampling factors and D1 `rows_written` evidence, not modeled savings, establish recovery.

See [Request Attribution](../process/worker-infrastructure-appendix.md#request-attribution), [D1 overload posture](../worker-and-api-limits.md), and [Telegram backlog expiration](telegram-no-delivery.md#backlog-and-expiration).
