# Runbook: Yield History Cleanup Writer Pause

Triggered by:
- Planned use of `worker/scripts/yield-history-cleanup.ts`
- `sync-yield-data` returning a degraded no-op while `cache['yield-history-cleanup:writer-pause']` is armed
- `/admin/` showing repeated degraded post-V9 yield runs during a cleanup window

## Symptom

The post-V9 yield publisher sees the writer pause guard and exits without purging or rewriting yield history. This is expected during a bounded yield-history cleanup window and unexpected if the key remains after the cleanup is complete.

## Impact

While the pause is armed, `yield_data`, `yield_history`, and the `yield-rankings` cache do not advance through the post-V9 writer. Public rankings continue from the last published cache, but freshness degrades if the pause spans multiple post-V9 cycles.

## First Checks

1. **Release/maintenance plan:** confirm a cleanup operator is actively running `worker/scripts/yield-history-cleanup.ts`.
2. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-data` and active progress.
3. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, value
FROM cache
WHERE key = 'yield-history-cleanup:writer-pause';
```

```sql
SELECT job, lease_owner, lease_until, heartbeat_at, updated_at
FROM cron_leases
WHERE job = 'sync-yield-data';
```

```sql
SELECT job, started_at, status, item_count, error, metadata
FROM cron_runs
WHERE job = 'sync-yield-data'
ORDER BY started_at DESC
LIMIT 8;
```

```sql
SELECT stablecoin_id, source_key, COUNT(*) AS rows, MAX(recorded_at) AS newest
FROM yield_history
GROUP BY stablecoin_id, source_key
ORDER BY newest DESC
LIMIT 20;
```

## Remediation

- For a planned cleanup, follow the deployment-process sequence: deploy protections, arm writer pause, verify no active `sync-yield-data` lease, export targeted rows, rehearse delete and restore locally, run bounded production cleanup, then validate after the next post-V9 writer cycle.
- Use `worker/scripts/yield-history-cleanup.ts` controls rather than ad hoc SQL. The script owns the `--arm-writer-pause`, `--clear-writer-pause`, `--execute`, `--confirm yield-history-cleanup`, and guarded restore paths.
- If the pause key is stale and no cleanup operator owns it, clear it with the script's `--clear-writer-pause` path, then let the next post-V9 `sync-yield-data` cycle publish.
- If cleanup failed after deleting rows, use the exported artifact and the script's guarded restore path. Remote restore requires `--execute --confirm yield-history-cleanup` and an armed writer pause.

## Abort Conditions

- Abort cleanup if `cron_leases` or `/api/status` shows `sync-yield-data` actively leased or in flight.
- Abort remote mutation or restore if no export artifact exists.
- Abort if the local delete + restore rehearsal has not passed.
- Abort if another worker/operator owns yield API contracts, D1 migrations, or cleanup logic for the same release.

## Validation

- `cache['yield-history-cleanup:writer-pause']` is absent after cleanup.
- `sync-yield-data` has a fresh post-cleanup run and is no longer returning writer-pause no-ops.
- Targeted parent/source rows remain absent after the next post-V9 writer cycle.
- `GET /api/yield-rankings` returns a fresh non-empty payload.
- `GET /api/yield-history?stablecoin=<wrapper-id>&days=365` returns expected wrapper-owned history without resurrecting parent-owned rows.

## Rollback Notes

Rollback is artifact restore through `worker/scripts/yield-history-cleanup.ts` while the writer pause is armed and `sync-yield-data` is not leased. Clear the writer pause only after restore validation passes.
