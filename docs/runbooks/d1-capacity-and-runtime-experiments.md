# Runbook: D1 Capacity

Use this runbook for D1 storage pressure. Paired Public/Heavy compatibility-date qualification is permanent release tooling; the old read-replication benchmark is retired and future evaluation requires separate approval. Both are described in [`docs/process/worker-runtime-experiments.md`](../process/worker-runtime-experiments.md), not incident remediation.

## Capacity Signals

Cloudflare's paid-plan limit is 10 GB per D1 database and cannot be raised. Pharos classifies current file-size utilization at these exact boundaries:

| Utilization | State | Operator action |
| --- | --- | --- |
| below 60% | `normal` | Continue routine observation. |
| 60% to below 75% | `watch` | Review the 30-day trend and largest retained tables. |
| 75% to below 90% | `warning` | Schedule retention/index remediation and confirm a current Time Travel bookmark. |
| 90% or above | `critical` | Stop nonessential write amplification and execute the approved capacity plan. |

`d1_capacity_observations` retains at most one observation per UTC hour and raw observations for 180 days. Forecasting evaluates 24-hour, 72-hour, 7-day, and 30-day regression windows, each with at least three samples and at least 90% of its named span, then selects the shortest valid window. Until a window qualifies, or when the measured slope is flat/negative, `exhaustionAt` remains null. A D1 `DELETE` reducing reported file size is evidence for that run only, not a general compaction guarantee.

The scheduled `status-self-check` lane refreshes control-plane telemetry every 15 minutes when the dedicated bindings are configured; observations coalesce into one UTC-hour row, not one network fetch per hour. A 60% crossing opens a warning watch, 75% makes capacity health degraded, and 90% makes it stale. Forecast runway is conditional advisory diagnosis, never pruning/sharding authority; null forecast does not remove a utilization floor. A failed refresh leaves the last cached assessment intact. Missing, malformed, expired (>26h), or future-clock capacity evidence instead yields degraded health and sanitized `d1-capacity-<reason>` warnings; no unconfigured healthy exception is ratified.

The daily census reuses a same-UTC-day snapshot under the existing cron lease; it does not acquire a separate database claim. It serially measures reviewed exact table names/families, not every database table, and serves cached detail for at most 50 hours. Missing/malformed/noninteger/negative counts enter `failedTables`, never healthy zero; genuine zero, negative deltas and nullable timestamp attribution remain valid. Row counts/deltas are not disk sizes or bytes written. Detailed capacity and census rows are admin API-only at `/api/status.d1Usage.capacity` and `/api/status.d1Usage.tableGrowth`; the card renders aggregate metrics, not census rows. Status requests never run census aggregates. Admin supplements normally reuse the 15-minute raw snapshot (30-minute TTL), with live fallback for stale/missing snapshots; live fallback may refresh hourly capacity history.

For current capacity verification, confirm `d1CapacityMonitoring` and `d1TableGrowthMonitoring` metadata, including measured `tableCount`, `failedTables` and `failedTableCount`; inspect public status/warnings and admin assessments. After the first released UTC-day census, record actual allowlist completeness, failures, duration/D1 reads and cache age. Do not force production thresholds with synthetic observations. Historical rollout evidence belongs in release records and Insights captures.

## References

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
