# Runbook: Yield Supplemental Empty Or Stale Snapshot

Triggered by:
- `sync-yield-supplemental` returning `degraded` with `fallbackMode: "empty-snapshot"`
- `sync-yield-data` metadata showing `supplementalSourceMode` as `unavailable` or `stale-cache`
- Optional Aave, Compound, Morpho, Pendle, Yearn/Kong, Beefy, or Royco Dawn rows disappearing from rankings/source boards

## Symptom

The slower supplemental source snapshot is missing, malformed, empty, or older than its allowed freshness window. The hourly publisher still runs but consumes zero supplemental candidates.

## Impact

Core yield publication should remain available. Optional protocol-API and optional RPC family coverage is reduced, so some alternate sources or best rows may disappear until `sync-yield-supplemental` writes a fresh aggregate snapshot or a fresh per-family snapshot. Stale or missing supplemental cache does not by itself degrade the hourly publisher.

## First Checks

1. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-supplemental` and `sync-yield-data`.
2. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
3. **Public rankings:** compare `altSources` and `dataSource` distribution in `GET https://api.pharos.watch/api/yield-rankings`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, length(value) AS bytes, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key = 'yield:supplemental-sources:v1'
   OR key LIKE 'yield:supplemental-sources:v1:%'
ORDER BY key;
```

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job IN ('sync-yield-supplemental', 'sync-yield-data')
ORDER BY started_at DESC
LIMIT 12;
```

```sql
SELECT data_source, COUNT(*) AS rows, MAX(updated_at) AS newest
FROM yield_data
GROUP BY data_source
ORDER BY rows DESC;
```

## Common Causes

- All supplemental families emitted zero candidates, so the cron refused to overwrite the previous aggregate cache.
- One per-family cache is malformed or stale. The hourly publisher should still load other fresh family caches and report `partial-family-cache` metadata instead of dropping all optional coverage.
- One successful per-family run emitted zero candidates. That family may intentionally publish an empty per-family cache to clear a previous non-empty family snapshot without overwriting the aggregate cache.
- Optional protocol APIs timed out inside the family budget.
- Optional RPC families exhausted their family budget or missed many chain targets.
- The cache payload became malformed or older than the supplemental freshness window.
- `setCacheIfNewer` skipped the write because a newer snapshot already existed.

## Remediation

- If the latest supplemental run is a single `empty-snapshot`, keep serving the previous snapshot and wait for the next 4-hour run unless optional coverage is business-critical for an incident.
- If `sync-yield-supplemental` metadata shows one family dominating misses or budget exhaustion, inspect `sourceCoverage.sourceFamilySummaries` first. It gives compact per-family status, raw/emitted counts, audit inventory counts, budget/cap flags, miss reasons, chain breakdowns, and bounded missing-target examples. `sourceCoverage.sourceFamilyCounts` is candidate-oriented; audit-only inventory such as vaults.fyi lives in `sourceCoverage.sourceFamilyInventoryCounts`. Do not move heavy family fetches onto the hourly publisher.
- If the job is stale due to a stuck lease, first confirm `/api/status` has no fresh matching `inFlight` progress. `POST /api/reset-cron-lease` is retired; then delete only `cron_leases.job = 'sync-yield-supplemental'` with scoped remote D1 SQL and verify the next four-hour run.
- If the cache is malformed, preserve the malformed value for debugging and let a later successful supplemental run replace it.

## Abort Conditions

- Do not write an empty aggregate supplemental snapshot over the last good aggregate cache.
- Do not increase Worker connection pressure by moving supplemental readers into `sync-yield-data`.
- Do not hand-create supplemental candidate rows in `yield_data`; the hourly publisher owns evaluation and arbitration.

## Validation

- `sync-yield-supplemental` has a recent run with `rowsWritten > 0` or a documented `skipped-newer`, and `sourceCoverage.sourceFamilySummaries` explains any empty, failed, or budget-exhausted family.
- `cache['yield:supplemental-sources:v1']` and any `yield:supplemental-sources:v1:<family>` rows are present when expected, parseable, and recent. A per-family row with `sourceCount: 0` is valid when that family completed successfully with no deduplicated candidates. A single malformed family row should not block other fresh family rows.
- The next `sync-yield-data` metadata shows `supplementalSourceMode: "cache"` and a non-zero `supplementalSourceCount`.
- Public rankings/source board show expected optional family rows or alternatives.

## Rollback Notes

The supplemental lane rollback is last-good aggregate-cache retention. All-family empty aggregate snapshots are intentionally not published; successful zero-candidate per-family snapshots may publish to clear stale family-owned rows. If a code deploy caused persistent malformed snapshots or zero aggregate candidates, roll back the Worker version and allow the next supplemental cycle to repopulate the cache.
