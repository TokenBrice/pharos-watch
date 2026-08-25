# Runbook: D1 Capacity

Use this runbook for D1 storage pressure. The Workers compatibility-date advance and the D1 read-replication experiment are planned, gated releases rather than incident remediation; they live in [`docs/process/worker-runtime-experiments.md`](../process/worker-runtime-experiments.md).

## Capacity Signals

Cloudflare's paid-plan limit is 10 GB per D1 database and cannot be raised. Pharos classifies current file-size utilization at these exact boundaries:

| Utilization | State | Operator action |
| --- | --- | --- |
| below 60% | `normal` | Continue routine observation. |
| 60% to below 75% | `watch` | Review the 30-day trend and largest retained tables. |
| 75% to below 90% | `warning` | Schedule retention/index remediation and confirm a current Time Travel bookmark. |
| 90% or above | `critical` | Stop nonessential write amplification and execute the approved capacity plan. |

`d1_capacity_observations` retains at most one observation per UTC hour and raw observations for 180 days. Forecasting evaluates 24-hour, 72-hour, 7-day, and 30-day regression windows, each with at least three samples and at least 90% of its named span, then selects the shortest valid window. Until a window qualifies, or when the measured slope is flat/negative, `exhaustionAt` remains null. A D1 `DELETE` reducing reported file size is evidence for that run only, not a general compaction guarantee.

The scheduled `status-self-check` lane refreshes the Cloudflare control-plane size observation and claims at most one bounded per-table growth snapshot per UTC day. A 60% crossing opens a warning watch, 75% makes public/admin health degraded, and 90% makes capacity health stale. A control-plane failure is logged and returned as a monitoring error without replacing the last cached assessment. Public `/api/health` exposes only the resulting status and machine-readable warnings; admin `/api/status.d1Usage.capacity` and `/api/status.d1Usage.tableGrowth` expose the detailed assessments. Ordinary status requests read the cached table snapshot and never run its table-count queries. An uninitialized observation cache remains compatible because the admin fields are nullable.

For current capacity verification, confirm the latest `status-self-check` metadata contains `d1CapacityMonitoring` and `d1TableGrowthMonitoring`, then inspect `/api/health` status/warnings and `/api/status.d1Usage.capacity` plus `/api/status.d1Usage.tableGrowth`. Do not force a production threshold by writing synthetic size observations. Historical index-rollout evidence belongs in release records and D1 Insights captures, not this current-operations runbook.

## References

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
