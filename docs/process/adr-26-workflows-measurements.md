# ADR-26 Workflows spike: production measurement record

Measurement date: 2026-09-03 07:54:27 UTC. The requested 14-day lower bound was Unix `1787212467` (2026-08-20 07:54:27 UTC); `cron_runs` retained candidate rows only from 2026-08-27 through the query time (`1788422067`). Therefore the figures below are the available retained sample, not a claim that the full 14 days exist in D1.

## Duration and error query

Exact command SQL (read-only remote D1 query):

```sql
WITH candidate AS (SELECT job, duration_ms, status, metadata, ROW_NUMBER() OVER (PARTITION BY job ORDER BY duration_ms) AS rank_no, COUNT(*) OVER (PARTITION BY job) AS n FROM cron_runs WHERE started_at >= 1787212467 AND job IN ('compute-safety-score-v9','sync-dex-liquidity-stage','sync-cl-exit-depth','sync-live-reserves','compute-depeg-resolver','digest-trigger-poll','daily-digest')) SELECT job, n AS runs, MIN(CASE WHEN rank_no >= (n + 1) / 2 THEN duration_ms END) AS p50_ms, MIN(CASE WHEN rank_no >= (95 * n + 99) / 100 THEN duration_ms END) AS p95_ms, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_runs, SUM(CASE WHEN lower(COALESCE(metadata, '')) LIKE '%exceededmemory%' THEN 1 ELSE 0 END) AS exceeded_memory_class, SUM(CASE WHEN lower(COALESCE(metadata, '')) LIKE '%exceededcpu%' OR lower(COALESCE(metadata, '')) LIKE '%exceeded_cpu%' THEN 1 ELSE 0 END) AS exceeded_cpu_class FROM candidate GROUP BY job, n ORDER BY job
```

| job | retained runs | p50 | p95 | error rows | D1 `exceededMemory` markers | D1 `exceededCpu` markers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `compute-depeg-resolver` | 690 | 16,278 ms | 26,969 ms | 17 | 0 | 0 |
| `compute-safety-score-v9` | 346 | 28,076 ms | 48,891 ms | 9 | 0 | 0 |
| `daily-digest` | 143 | 4,117 ms | 11,400 ms | 22 | 0 | 0 |
| `sync-cl-exit-depth` | 353 | 42,312 ms | 99,477 ms | 16 | 0 | 0 |
| `sync-dex-liquidity-stage` | 172 | 109,819 ms | 156,823 ms | 2 | 0 | 0 |
| `sync-live-reserves` | 48 | 349,068 ms | 496,272 ms | 2 | 0 | 0 |
| `digest-trigger-poll` | 0 | — | — | 0 | 0 | 0 |

The percentile query uses the nearest-rank form: `ceil(n/2)` and `ceil(0.95n)` (SQLite integer arithmetic). The `daily-digest` rows are the only `cron_runs` proxy for the digest-intent lane; `digest-trigger-poll` itself has no logger row when no intent is pending.

## Failure-class query

Exact command SQL (read-only remote D1 query):

```sql
SELECT job, COALESCE(json_extract(metadata, '$.failureCategory'), '(none)') AS failure_category, SUM(CASE WHEN lower(COALESCE(error, '')) LIKE '%memory%' OR lower(COALESCE(metadata, '')) LIKE '%memory%' THEN 1 ELSE 0 END) AS memory_markers, SUM(CASE WHEN lower(COALESCE(error, '')) LIKE '%cpu%' OR lower(COALESCE(metadata, '')) LIKE '%cpu%' THEN 1 ELSE 0 END) AS cpu_markers, COUNT(*) AS rows FROM cron_runs WHERE started_at >= 1787212467 AND job IN ('compute-safety-score-v9','sync-dex-liquidity-stage','sync-cl-exit-depth','sync-live-reserves','compute-depeg-resolver','daily-digest') GROUP BY job, failure_category ORDER BY job, failure_category
```

| job | failure category | rows | memory markers | CPU markers |
| --- | --- | ---: | ---: | ---: |
| `compute-depeg-resolver` | `(none)` | 673 | 0 | 0 |
| `compute-depeg-resolver` | `platform-abandoned` | 17 | 0 | 0 |
| `compute-safety-score-v9` | `(none)` | 337 | 0 | 0 |
| `compute-safety-score-v9` | `platform-abandoned` | 9 | 0 | 0 |
| `daily-digest` | `(none)` | 121 | 0 | 0 |
| `daily-digest` | `platform-abandoned` | 22 | 0 | 0 |
| `sync-cl-exit-depth` | `(none)` | 337 | 0 | 0 |
| `sync-cl-exit-depth` | `platform-abandoned` | 16 | 0 | 0 |
| `sync-dex-liquidity-stage` | `(none)` | 170 | 0 | 0 |
| `sync-dex-liquidity-stage` | `platform-abandoned` | 2 | 0 | 0 |
| `sync-live-reserves` | `(none)` | 47 | 0 | 0 |
| `sync-live-reserves` | `platform-abandoned` | 1 | 0 | 0 |

`platform-abandoned` is the D1 reconciliation class, not a Cloudflare resource-outcome label. No `exceededMemory`/`exceededCpu` marker appears in the retained `cron_runs` metadata or error text; Cloudflare invocation analytics would be required to assert platform resource outcomes separately.

## Workflow source notes

Official Cloudflare references consulted on 2026-09-03:

- [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/): Paid step CPU defaults to 30 seconds and is configurable to 5 minutes; step wall duration is unlimited; each step's non-stream result and payload are 1 MiB; max steps 10,000 (configurable to 25,000); retries per step 10,000; Cron-triggered instances have a one-hour budget without consuming the normal Workflow concurrency slot.
- [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/): Paid included usage is 10 million requests/month, 30 million CPU-ms/month, 500,000 steps/month, and 1 GB-month storage; overage is $0.30/million requests, $0.02/million CPU-ms, $0.80/100k steps, and $0.20/GB-month storage. Wait/sleep/idle time does not consume CPU.
- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/): `step.do` retries are configurable (default limit 5, 10-second exponential delay); timeout applies per attempt; `NonRetryableError` suppresses retries.
- [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/): instance IDs are unique within a Workflow; the event exposes `instanceId` and schedule metadata; restart reruns steps and is not a takeover/fence API.
- [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): `step.do` is the per-step execution boundary.

Cost envelope at the plan's ~50 instances/day: 1,500 instance requests/month and approximately 7,500 steps/month for five steps/instance, both inside included Paid usage. Actual cost is active CPU, not cron wall time. A deliberately conservative upper bound of 300,000 active CPU-ms per instance-day yields 15 million CPU-ms/day; after the 1 million CPU-ms/day share of the monthly allowance, the CPU overage is about $0.28/instance-day ($8.40/30-day month). This is a ceiling scenario, not an observed measurement.
