# Runbook: Yield Benchmark Fallback Or Stale State

Triggered by:
- `sync-yield-data` metadata `fallbackMode` containing `risk-free-rate:*`
- `/api/yield-rankings` provenance showing retained benchmark fallback
- `/admin/` -> Crons showing failing or stale `fetch-tbill-rate`

## Symptom

Yield rows still publish, but benchmark provenance shows a fallback or retained market rate. Excess yield, PYS effective-yield adjustment, scatter-plot benchmark frames, and benchmark labels may be based on older USD/EUR/CHF benchmark inputs.

## Impact

Rankings are usually available, but benchmark-relative interpretation is degraded. The hourly publisher degrades when the default USD benchmark is a true fallback, when retained fallback mode is active, or when the retained last-known-good USD benchmark is older than 48 hours.

## First Checks

1. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `fetch-tbill-rate` and `sync-yield-data`.
2. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
3. **Public payload:** `GET https://api.pharos.watch/api/yield-rankings` and inspect top-level `benchmarks` plus row-level `benchmarkFallbackMode`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, value
FROM cache
WHERE key IN ('risk_free_rates', 'risk_free_rate')
ORDER BY key;
```

```sql
SELECT job, started_at, duration_ms, status, item_count, error, metadata
FROM cron_runs
WHERE job IN ('fetch-tbill-rate', 'sync-yield-data')
ORDER BY started_at DESC
LIMIT 10;
```

```sql
SELECT key, updated_at, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key = 'yield-rankings';
```

## Common Causes

- FRED, Treasury.gov, ECB, or SIX benchmark fetch failed during the daily `0 8 * * *` lane.
- `fetch-tbill-rate` retained the last market-derived rate after an upstream outage.
- The benchmark cache exists but is malformed or missing one of the structured benchmark entries.
- `sync-yield-data` is healthy but continues to mark rankings degraded because the retained USD benchmark is too old.

## Remediation

- If the benchmark fetch failed once and the retained rate is recent, monitor until the next daily benchmark lane or manually trigger the established cron path if available to operators.
- If a provider-specific outage is visible, wait for upstream recovery rather than replacing rates manually.
- If `fetch-tbill-rate` is stale because of a lease issue, confirm no active run exists before clearing the stale lease through the standard admin reset-lease flow for `fetch-tbill-rate`.
- If only non-USD benchmarks are missing while USD is healthy, document the affected peg currencies in incident notes; USD rankings remain the primary availability path.

## Abort Conditions

- Do not hand-edit `risk_free_rates` or `risk_free_rate`.
- Do not change PYS constants, benchmark fallback thresholds, or methodology docs during incident response.
- Stop if `fetch-tbill-rate` is actively in flight; the job is serialized and should be allowed to finish.

## Validation

- `fetch-tbill-rate` has a recent `ok` or expected `degraded` run.
- `cache['risk_free_rates']` parses as JSON with a current USD benchmark and any available EUR/CHF entries.
- New `yield-rankings` rows expose benchmark fields, and `fallbackMode` is null unless an upstream outage is still active.
- `/yield/` scatter and table benchmark labels agree with the API payload.

## Rollback Notes

Benchmark retention is the rollback mechanism: the system keeps the last market-derived benchmark fields instead of replacing them with arbitrary operator values. If a code deploy broke parsing or publication, roll back the Worker version and let the next benchmark/yield cycles republish.
