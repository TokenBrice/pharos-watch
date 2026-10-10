# Runbook: Yield Benchmark Fallback Or Stale State

Triggered by:
- `sync-yield-data` metadata `quality.reasons` containing `risk-free-rate:*`
- `/api/yield-rankings` provenance showing retained benchmark fallback
- `/admin/` -> Crons showing failing or stale `fetch-tbill-rate`
- Dashboard observation of the retained GBP SONIA fallback after consecutive daily runs
- Worker canary `yield-gbp-benchmark-current` reporting fewer than 2 consecutive direct, current GBP publications
- Worker canary `yield-usd-benchmark-current` reporting fewer than 2 consecutive direct, current USD publications
- `/yield` rows carrying the `reference-benchmark-degraded` warning (the USD reference the v8.43 re-base consumes is retained or stale)

## Symptom

Yield rows still publish, but benchmark provenance shows a fallback or retained market rate. Excess yield, PYS effective-yield adjustment, scatter-plot benchmark frames, and benchmark labels may be based on older benchmark inputs.

## Impact

Rankings are usually available, but benchmark-relative interpretation can be degraded. Inspect publisher completion and input quality using the [shared entry checks](./yield-health.md#first-checks). The [benchmark threshold row](./yield-health.md#threshold-table) owns the independent fetch and observation-age limits, defined in `shared/lib/yield-benchmark-freshness.ts`; a frozen upstream cannot become healthy merely because fetching succeeds. Non-USD fallback or stale evidence raises `risk-free-rate:<KEY>:<reason>` independently. Past either freshness bound, affected rows are benchmark-stale and PYS is NR.

The v8.43 hurdle re-base consumes the USD reference only while it classifies healthy on its own feed evidence. A degraded reference nulls `usdBenchmarkRate`, so affected non-USD rows publish an estimated PYS with the `reference-benchmark-degraded` warning; a stale reference makes them NR (`benchmark-stale`). Documented proxy selection (`benchmarkSelectionMode: "fallback-usd"`) is a methodology choice, not a degraded feed: it is reported as `proxySelectionRowCount` / `benchmarkIsProxy` and never degrades the benchmark entry or the row by itself.

## First Checks

Start with the [shared read-only Yield Health checks](./yield-health.md#first-checks), focusing on `yieldHealth.benchmarkRegistry` and the `fetch-tbill-rate` / `sync-yield-data` cron metadata. Then inspect top-level `benchmarks` and row-level `benchmarkFallbackMode` in `GET https://api.pharos.watch/api/yield-rankings`.

## Read-Only D1 Snippets

```sql
SELECT key, updated_at, value
FROM cache
WHERE key IN ('risk_free_rates', 'risk_free_rate', 'fetch-tbill-rate:gbp-retained-fallback-streak')
ORDER BY key;
```

Use the [shared cron-history SELECT](./yield-health.md#read-only-d1-snippets) with jobs `fetch-tbill-rate` and `sync-yield-data`, newest 10 runs.

```sql
SELECT key, updated_at, substr(value, 1, 1200) AS value_prefix
FROM cache
WHERE key = 'yield-rankings';
```

## Common Causes

- FRED, Treasury.gov, ECB, SIX, or central-bank benchmark fetches failed during the daily `0 8 * * *` lane.
- FRED DGS3MO/DFF's latest valid row falls outside its five-day observation bound or one-day parser future-skew allowance. USD can try Treasury.gov; USD_EFFR tries NYFed then FRED, then retained evidence.
- The GBP SONIA source family (FRED graph CSV, ALFRED graph CSV, and BoE IADB `IUDZOS2`) failed on consecutive daily runs, so `fetch-tbill-rate` retained the last GBP market benchmark and fired the repeated-fallback alert. HTTP 520 from both St. Louis Fed graph hosts can indicate that their required contact-bearing Worker user agent drifted.
- `fetch-tbill-rate` retained the last market-derived rate after an upstream outage.
- The benchmark cache exists but is malformed or missing one of the structured benchmark entries.
- `sync-yield-data` is healthy but continues to mark rankings degraded because the retained USD benchmark is too old — by fetch age, or by observation age past the key's record bound.

## Remediation

- After a transient fetch failure, monitor the daily `0 8 * * *` lane or the `:55` gated retry. If supplemental catch-up actually ran in that hourly slot, the benchmark leg defers with `deferred-after-supplemental-catch-up`. Otherwise it skips neutrally while both the newest market fetch and USD's market fetch are at most 24 hours old, unless USD/USD_EFFR/GBP observation age is within a day of its record bound. Fetch age and observation age are separate checks; the daily lane remains the canonical producer.
- If the GBP SONIA retained-fallback alert or canary fired, inspect `cache['fetch-tbill-rate:gbp-retained-fallback-streak']` for `consecutiveRetainedRuns`, `consecutiveFreshRuns`, `lastMarketSource`, `lastMarketRecordDate`, `lastFreshSource`, `lastFreshRecordDate`, and `lastFallbackMode`; repeat alerting is visible as the `gbp-retained-fallback-repeated` cron event, not as a cached timestamp. Inspect the latest `fetch-tbill-rate` cron metadata `gbpResponseAttempts` to distinguish transport failure, HTTP status failure, empty body, and parse failure across FRED, ALFRED, and BoE. If FRED and ALFRED both return HTTP 520, verify their adapter still sends `Pharos/1.0 (+https://pharos.watch)` before treating the incident as an upstream outage. Response bodies and URLs are intentionally absent from diagnostics.
- Inspect the latest `fetch-tbill-rate` metadata for `registryCacheState`, `registryCacheWrite`, and `resolvedBenchmarkKeys` (an unreadable prior cache row is skipped — left unwritten — only when the run resolved zero benchmark keys, per the `registryCacheWrite` guard in `worker/src/cron/fetch-tbill-rate.ts`; any resolved key rewrites the row) and, for USD, `usdFreshPublicationStreak` / `usdLastFresh*` fields feeding the `yield-usd-benchmark-current` canary.
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
- After GBP recovery, `cache['fetch-tbill-rate:gbp-retained-fallback-streak']` must show `consecutiveRetainedRuns: 0`, `consecutiveFreshRuns >= 2`, and current `lastFreshSource` / `lastFreshRecordDate`. The canary requires a non-fallback row fetched within 48 hours and observed within the shared GBP bound (five days), plus two consecutive fresh publications; hourly retries also count.
- New `yield-rankings` rows expose benchmark fields, and `metadata.quality.reasons` contains no benchmark finding after recovery. The yield run no longer has a top-level `fallbackMode`; benchmark-specific fallback fields remain.
- The `yield-usd-benchmark-current` canary is `ok` only when the USD row is direct and current and has been published fresh in two consecutive generations.
- The retained entries carry a current `recordDate` inside the key's observation bound, not just a recent fetch timestamp.
- `/yield/` scatter and table benchmark labels agree with the API payload.

## Rollback Notes

Benchmark retention is the rollback mechanism: the system keeps the last market-derived benchmark fields instead of replacing them with arbitrary operator values. If a code deploy broke parsing or publication, roll back the Worker version and let the next benchmark/yield cycles republish.
