# Runbook: Yield Rankings Stale Or Missing

Triggered by:
- `/api/yield-rankings` returning `503`, malformed-cache errors, or no rankings
- `/status/` impacted surfaces naming yield data
- `/admin/` -> Crons showing stale or unhealthy `sync-yield-data`
- `/admin/` -> Endpoint probes showing unhealthy `/api/yield-rankings`

## Symptom

The public `/yield/` page shows a stale-data banner, empty leaderboard, or failed rankings request. API clients may see `503` from `GET /api/yield-rankings` when the cached `yield-rankings` payload is missing or malformed.

## Impact

Yield Intelligence rankings, PYS, source provenance, and detail-page yield panels may be stale or unavailable. `yield-history` can still serve older D1 history, but generation-aware rows are visible only after their generation is marked `published`, and reads stay capped to the latest published `yield-rankings.updatedAt` / publication cutoff. History should not advance beyond the last good public rankings snapshot.

## First Checks

1. **Public status:** `/status/` for public cache/probe impact.
2. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `sync-yield-data`; also inspect Endpoint probes for `/api/yield-rankings`.
3. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
4. **Public API:** `GET https://api.pharos.watch/api/yield-rankings`.
5. **Source decisions:** see [Source Decision Evidence](#source-decision-evidence) below for the generation and per-asset decision queries.

## Source Decision Evidence

`GET /api/yield-source-decisions`, the admin-only read path that joined generations and decisions in one response, was retired on 2026-08-09. Every table it read is unchanged and still written by each publication run, so the same evidence is assembled from the `yield_publication_generations` and `yield_source_decisions` snippets in [Read-Only D1 Snippets](#read-only-d1-snippets) below, plus the typed alternates for one asset:

```sql
SELECT generation_id, stablecoin_id, alt_source_key, alt_yield_source,
       alt_apy30d_delta, rejection_reason_code, recorded_at
FROM yield_source_decision_alternatives
WHERE stablecoin_id = '<stablecoin_id>'
  AND generation_id = '<generation_id>'
ORDER BY recorded_at DESC, alt_source_key ASC;
```

Filter generations by `state IN ('staged', 'published', 'failed')` to reproduce the endpoint's `state` filter. Keep result sets small; the retired endpoint capped both generation and decision reads at 25 rows for a reason.

## Read-Only D1 Snippets

Run these as read-only D1 queries through Wrangler or the Cloudflare dashboard:

```sql
SELECT key, updated_at, length(value) AS bytes
FROM cache
WHERE key IN ('yield-rankings', 'freshness:yield-data');
```

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job = 'sync-yield-data'
ORDER BY started_at DESC
LIMIT 5;
```

```sql
SELECT COUNT(*) AS best_rows, MAX(updated_at) AS newest_row, MIN(updated_at) AS oldest_row
FROM yield_data
WHERE is_best = 1;
```

```sql
SELECT stablecoin_id, source_key, data_source, current_apy, pharos_yield_score, updated_at
FROM yield_data
WHERE is_best = 1
ORDER BY updated_at ASC
LIMIT 20;
```

```sql
SELECT generation_id, started_at, state, ranking_count, source_row_count, best_row_count, failure_reason
FROM yield_publication_generations
ORDER BY started_at DESC
LIMIT 10;
```

```sql
SELECT stablecoin_id, selected_source_key, selected_confidence_tier, selected_data_source,
       selected_apy_30d, selected_score, source_switch, rejected_count
FROM yield_source_decisions
WHERE generation_id = '<generation_id>'
ORDER BY selected_score DESC
LIMIT 25;
```

```sql
SELECT stablecoin_id, length(alternatives_json) AS evidence_bytes, alternatives_json
FROM yield_source_decisions
WHERE generation_id = '<generation_id>' AND stablecoin_id = '<stablecoin_id>';
```

The `alternatives_json` ledger is intentionally compact and bounded to 4 KB per selected row. It keeps at most four alternate sources with short rejected/retained reasons and anomaly samples, so it is debug evidence rather than a full replay log.

## Common Causes

- `sync-yield-data` is stale, failing, or stuck behind an active lease.
- The cache publication guard skipped overwrite because the new payload failed schema validation, had duplicate IDs, or shrank severely versus the previous cache.
- Core inputs were degraded: safety snapshot coverage below threshold, retained/stale benchmark fallback, unavailable DeFiLlama pools, deterministic on-chain outage without alternative coverage, or supplemental source loss reducing coverage.
- D1 rows were staged but cache publication failed or CAS-skipped because a newer cache already exists; the generation remains `failed`, public cache stays on the previous good generation, and generation-aware history rows remain hidden.

## Remediation

- If `sync-yield-data` is stale but not leased, wait for the next `28,58 * * * *` run if the last failure was transient.
- If the cron is repeatedly `skipped_locked`, confirm the lease is stale, then delete it directly. `POST /api/reset-cron-lease` was retired on 2026-08-09; the delete below is exactly what it ran.

  ```bash
  npx --no-install wrangler d1 execute stablecoin-db --remote --command \
    "DELETE FROM cron_leases WHERE job = 'sync-yield-data';"
  ```
- If metadata shows `reason: "previous-yield-rankings-cache-invalid"` or publication guard failure, do not delete the cache blindly. Preserve the last good payload for rollback/debugging and identify whether the failure came from payload schema, severe shrink, duplicate ranking IDs, or a generation `failure_reason`.
- If the degraded reason points to benchmarks, use [`yield-benchmark-fallback-stale.md`](./yield-benchmark-fallback-stale.md).
- If the degraded reason points to deterministic on-chain cooldown or all-fail state, use [`yield-deterministic-cooldown.md`](./yield-deterministic-cooldown.md).
- If supplemental source coverage dropped, use [`yield-supplemental-snapshot.md`](./yield-supplemental-snapshot.md).

## Abort Conditions

- Do not clear a `sync-yield-data` lease while `/api/status` shows an active, fresh `inFlight` progress row for the same job.
- Do not mutate `yield_data`, `yield_history`, `yield_publication_generations`, `yield_source_decisions`, or `cache` by hand to force rankings publication.
- Do not bypass schema/severe-shrink guards; they are the rollback boundary that protects public rankings.
- Stop if another operator is running yield-history cleanup and `cache['yield-history-cleanup:writer-pause']` is armed.

## Validation

- `/admin/` shows a recent `sync-yield-data` run with `status` `ok` or expected `degraded`.
- `GET /api/yield-rankings` returns `200`, non-empty `rankings`, and a fresh `_meta` / `updatedAt`.
- Latest `yield_publication_generations` row is `published` or has an understood `failed` reason while the previous public cache remains valid.
- `yield_data` best-row count is plausible relative to the previous good run, and current rows for the latest public generation carry `publication_state='published'`.
- `GET /api/yield-history?stablecoin=<id>&days=30` works for a known ranked coin and does not return points newer than the rankings cutoff.

## Rollback Notes

The normal rollback is to keep serving the previous `yield-rankings` cache while the post-V9 publisher recovers. Failed or CAS-skipped generations are intentionally left in D1 as audit evidence and should not be promoted manually. If a deploy caused repeated publication failures, roll back the Worker version through the standard deployment process; do not manually rewrite rankings cache contents unless a maintainer explicitly approves a targeted restore.
