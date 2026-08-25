# Runbook: Yield Benchmark Fallback Or Stale State

Triggered by:
- `sync-yield-data` metadata `fallbackMode` containing `risk-free-rate:*`
- `/api/yield-rankings` provenance showing retained benchmark fallback
- `/admin/` -> Crons showing failing or stale `fetch-tbill-rate`
- Dashboard observation of the retained GBP SONIA fallback after consecutive daily runs
- Worker canary `yield-gbp-benchmark-current` reporting fewer than 2 consecutive direct, current GBP publications

## Symptom

Yield rows still publish, but benchmark provenance shows a fallback or retained market rate. Excess yield, PYS effective-yield adjustment, scatter-plot benchmark frames, and benchmark labels may be based on older benchmark inputs.

## Impact

Rankings are usually available, but benchmark-relative interpretation is degraded. The post-V9 publisher degrades when the default USD benchmark is a true fallback, when retained fallback mode is active, or when the retained last-known-good USD benchmark is older than 48 hours (2 days). A non-USD benchmark that is itself fallback or stale also degrades the run on its own, reported as `risk-free-rate:<KEY>:<reason>`. Beyond that scoring TTL, affected rows are benchmark-stale and PYS is NR.

## First Checks

1. **Access-gated status:** `https://ops.pharos.watch/admin/` -> Crons -> `fetch-tbill-rate` and `sync-yield-data`.
2. **Machine status:** `GET https://ops-api.pharos.watch/api/status` with Cloudflare Access service-token headers.
3. **Public payload:** `GET https://api.pharos.watch/api/yield-rankings` and inspect top-level `benchmarks` plus row-level `benchmarkFallbackMode`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, value
FROM cache
WHERE key IN ('risk_free_rates', 'risk_free_rate', 'fetch-tbill-rate:gbp-retained-fallback-streak')
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

- FRED, Treasury.gov, ECB, SIX, or central-bank benchmark fetches failed during the daily `0 8 * * *` lane.
- The GBP SONIA source family (FRED graph CSV, ALFRED graph CSV, and BoE IADB `IUDZOS2`) failed on consecutive daily runs, so `fetch-tbill-rate` retained the last GBP market benchmark and fired the repeated-fallback alert. HTTP 520 from both St. Louis Fed graph hosts can indicate that their required contact-bearing Worker user agent drifted.
- `fetch-tbill-rate` retained the last market-derived rate after an upstream outage.
- The benchmark cache exists but is malformed or missing one of the structured benchmark entries.
- `sync-yield-data` is healthy but continues to mark rankings degraded because the retained USD benchmark is too old.

## Remediation

- If the benchmark fetch failed once and the retained rate is recent, monitor until the next daily benchmark lane or manually trigger the established cron path if available to operators.
- If the GBP SONIA retained-fallback alert or canary fired, inspect `cache['fetch-tbill-rate:gbp-retained-fallback-streak']` for `consecutiveRetainedRuns`, `consecutiveFreshRuns`, `lastMarketSource`, `lastMarketRecordDate`, `lastFreshSource`, `lastFreshRecordDate`, and `lastFallbackMode`; repeat alerting is visible as the `gbp-retained-fallback-repeated` cron event, not as a cached timestamp. Inspect the latest `fetch-tbill-rate` cron metadata `gbpResponseAttempts` to distinguish transport failure, HTTP status failure, empty body, and parse failure across FRED, ALFRED, and BoE. If FRED and ALFRED both return HTTP 520, verify their adapter still sends `Pharos/1.0 (+https://pharos.watch)` before treating the incident as an upstream outage. Response bodies and URLs are intentionally absent from diagnostics.
- If a provider-specific outage is visible, wait for upstream recovery rather than replacing rates manually.
- If `fetch-tbill-rate` is stale because of a lease issue, clear it per [`lease-and-breaker-recovery.md`](./lease-and-breaker-recovery.md), job `fetch-tbill-rate`, and verify the next daily run.
- If only non-USD benchmarks are missing while USD is healthy, document the affected peg currencies in incident notes; USD rankings remain the primary availability path.

## Abort Conditions

- Do not hand-edit `risk_free_rates` or `risk_free_rate`.
- Do not change PYS constants, benchmark fallback thresholds, or methodology docs during incident response.
- Stop if `fetch-tbill-rate` is actively in flight; the job is serialized and should be allowed to finish.

## Validation

- `fetch-tbill-rate` has a recent `ok` or expected `degraded` run.
- `cache['risk_free_rates']` parses as JSON with a current USD benchmark and any available non-USD benchmark entries.
- If GBP SONIA sources recovered, `cache['fetch-tbill-rate:gbp-retained-fallback-streak']` shows `consecutiveRetainedRuns: 0`, `consecutiveFreshRuns >= 2`, and a current `lastFreshSource` / `lastFreshRecordDate`. The `yield-gbp-benchmark-current` canary is `ok` only when the GBP row is non-fallback, fetched within 48 hours, observed within 7 days, and verified across two consecutive daily publications.
- New `yield-rankings` rows expose benchmark fields, and `fallbackMode` is null unless an upstream outage is still active.
- `/yield/` scatter and table benchmark labels agree with the API payload.

## Rollback Notes

Benchmark retention is the rollback mechanism: the system keeps the last market-derived benchmark fields instead of replacing them with arbitrary operator values. If a code deploy broke parsing or publication, roll back the Worker version and let the next benchmark/yield cycles republish.
