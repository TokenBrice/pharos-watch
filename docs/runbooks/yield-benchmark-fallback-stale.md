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

Benchmark-relative interpretation follows the [benchmark registry](../yield-intelligence.md#benchmark-registry) and [operator thresholds](./yield-health.md#threshold-table); inspect each used key's `risk-free-rate:<KEY>:<reason>`, not fetch success alone. Under the v8.43 hurdle re-base, a degraded USD reference disables rebase and makes affected non-USD PYS estimated (`reference-benchmark-degraded`), while a stale reference makes it NR (`benchmark-stale`); [publication semantics](../yield-intelligence.md#persistence-and-publication) remain separate from input quality.

Documented `benchmarkSelectionMode: "fallback-usd"` is a proxy policy, not degraded feed evidence; `proxySelectionRowCount` / `benchmarkIsProxy` do not by themselves degrade a row or benchmark.

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

Inspect the rankings prefix with the [shared cache SELECT](./yield-health.md#read-only-d1-snippets) before comparing row benchmark provenance.

## Common Causes

- FRED, Treasury.gov, ECB, SIX, or central-bank benchmark fetches failed during the daily `0 8 * * *` lane.
- FRED DGS3MO/DFF's latest valid row falls outside its five-day observation bound or one-day parser future-skew allowance. USD can try Treasury.gov; USD_EFFR tries NYFed then FRED, then retained evidence.
- The GBP SONIA source family (FRED graph CSV, ALFRED graph CSV, and BoE IADB `IUDZOS2`) failed on consecutive daily runs, so `fetch-tbill-rate` retained the last GBP market benchmark and fired the repeated-fallback alert. HTTP 520 from both St. Louis Fed graph hosts can indicate that their required contact-bearing Worker user agent drifted.
- BCB SGS `11` or `1178` can time out without response bytes, or return HTTP200 with an error envelope or HTML instead of observations. SGS1178 is a sequential same-authority fallback for the same effective Selic, not a cure for a host-wide outage. Both rejected leaves `brl:bcb-selic-failed-retained` with original `fetchedAt`, `recordDate` and `lastMarket*`.
- `fetch-tbill-rate` retained the last market-derived rate after an upstream outage.
- The benchmark cache exists but is malformed or missing one of the structured benchmark entries.
- `sync-yield-data` is healthy but continues to mark rankings degraded because the retained USD benchmark is too old — by fetch age, or by observation age past the key's record bound.

## Remediation

- After a transient fetch failure, monitor the daily `0 8 * * *` lane or the `:55` gated retry. If supplemental catch-up actually ran in that hourly slot, the benchmark leg defers with `deferred-after-supplemental-catch-up`. Otherwise it skips neutrally while both the newest market fetch and USD's market fetch are at most 24 hours old, unless USD/USD_EFFR/GBP observation age is within a day of its record bound. Fetch age and observation age are separate checks; the daily lane remains the canonical producer.
- If the GBP SONIA retained-fallback alert or canary fired, inspect `cache['fetch-tbill-rate:gbp-retained-fallback-streak']` for `consecutiveRetainedRuns`, `consecutiveFreshRuns`, `lastMarketSource`, `lastMarketRecordDate`, `lastFreshSource`, `lastFreshRecordDate`, and `lastFallbackMode`; repeat alerting is visible as the `gbp-retained-fallback-repeated` cron event, not as a cached timestamp. Inspect the latest `fetch-tbill-rate` cron metadata `gbpResponseAttempts` to distinguish transport failure, HTTP status failure, empty body, and parse failure across FRED, ALFRED, and BoE. If FRED and ALFRED both return HTTP 520, verify their adapter still sends `Pharos/1.0 (+https://pharos.watch)` before treating the incident as an upstream outage. Response bodies and URLs are intentionally absent from diagnostics.
- Inspect the latest `fetch-tbill-rate` metadata for `registryCacheState`, `registryCacheWrite`, and `resolvedBenchmarkKeys` (an unreadable prior cache row is skipped — left unwritten — only when the run resolved zero benchmark keys, per the `registryCacheWrite` guard in `worker/src/cron/fetch-tbill-rate.ts`; any resolved key rewrites the row) and, for USD, `usdFreshPublicationStreak` / `usdLastFresh*` fields feeding the `yield-usd-benchmark-current` canary.
- If a provider-specific outage is visible, wait for upstream recovery rather than replacing rates manually.
- Inspect ordered `brlResponseAttempts` (`bcb-selic`, then `bcb-selic-1178`): `transport-failed`, `http-status`, `empty-body`, `parse-failed`, `html-body`, `upstream-error` (optional numeric `upstreamStatus`), or parsed-but-rejected `stale-record` / `future-record`. Diagnostics retain no bodies/URLs; MIME is bounded to 100 characters and each BCB body intake to 16 KiB. SGS11 daily percent compounds over 252 business days; SGS1178 annual percent must not compound twice. Probe the configured `BCB_SELIC_URL` / `BCB_SELIC_ANNUALIZED_URL` read-only; HTTP200 alone is insufficient. A fresh sibling can keep hourly retry gated, so `risk-free-registry-fresh` does not clear daily BRL degradation. Never redate retained evidence or substitute CDI, policy targets, expectations or bond yields.
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
- For BRL acceptance, record the actual Worker version and run start/end/status/reason; require a real admitted SGS11/SGS1178 JSON observation with publisher date within five days, fetch within 48 hours and no excessive future skew. An SGS1178 success must preserve the preceding SGS11 failure and publish source `bcb-selic-1178`, original publisher date and matching `lastMarket*`; other currencies and the shared BRL circuit must remain isolated. Confirm publisher-date progress after the next business-day release, not just a new fetch. Deterministic fixtures prove parser/failover support, not operational source availability; if both official series still fail, retain degradation and escalate BCB availability.
- `/yield/` scatter and table benchmark labels agree with the API payload.

## Rollback Notes

Benchmark retention is the rollback mechanism: the system keeps the last market-derived benchmark fields instead of replacing them with arbitrary operator values. If a code deploy broke parsing or publication, roll back the Worker version and let the next benchmark/yield cycles republish.
