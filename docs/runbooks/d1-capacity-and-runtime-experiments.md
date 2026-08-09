# D1 Capacity And Runtime Experiments

Use this runbook for D1 storage pressure, a Workers compatibility-date advance, or a D1 read-replication experiment. Compatibility and replication experiments are separate releases. Neither is bundled with schema, methodology, recovery, or data-repair changes.

## Capacity Signals

Cloudflare's paid-plan limit is 10 GB per D1 database and cannot be raised. Pharos classifies current file-size utilization at these exact boundaries:

| Utilization | State | Operator action |
| --- | --- | --- |
| below 60% | `normal` | Continue routine observation. |
| 60% to below 75% | `watch` | Review the 30-day trend and largest retained tables. |
| 75% to below 90% | `warning` | Schedule retention/index remediation and confirm a current Time Travel bookmark. |
| 90% or above | `critical` | Stop nonessential write amplification and execute the approved capacity plan. |

`d1_capacity_observations` retains at most one observation per UTC hour. The calculation uses linear regression over the latest 30 days only after at least three samples span 24 hours. Until then, or when the measured slope is flat/negative, `exhaustionAt` remains null. A D1 `DELETE` reducing reported file size is evidence for that run only, not a general compaction guarantee.

The scheduled `status-self-check` lane refreshes the Cloudflare control-plane size observation. A 60% crossing opens a warning watch, 75% makes public/admin health degraded, and 90% makes capacity health stale. A control-plane failure is logged and returned as a monitoring error without replacing the last cached assessment. Public `/api/health` exposes only the resulting status and machine-readable warnings; admin `/api/status.d1Usage.capacity` exposes the detailed assessment. An uninitialized observation cache remains compatible because the admin field is nullable.

For current capacity verification, confirm the latest `status-self-check` metadata contains `d1CapacityMonitoring`, then inspect `/api/health` status/warnings and `/api/status.d1Usage.capacity`. Do not force a production threshold by writing synthetic size observations. Historical index-rollout evidence belongs in release records and D1 Insights captures, not this current-operations runbook.

## Compatibility-Date Experiment

The checked-in production date is not changed by the benchmark command.

```bash
npm run ops:benchmark-worker-compatibility -- --candidate-date YYYY-MM-DD
```

The command builds both dates with `wrangler deploy --dry-run`, runs Worker startup profiling, and checks the `/api/health` runtime contract against a fresh, fully migrated temporary local D1 for each date. This keeps stale local Wrangler state and fixture data out of the comparison. It writes a comparison under `agents/` and never deploys.

Promotion gate:

1. Review Cloudflare's compatibility flags introduced between the two dates.
2. Require both bundle/startup checks and both local smoke runs to pass.
3. Advance `worker/wrangler.toml` in a dedicated release with no D1 migration, methodology change, data repair, or read-replication change.
4. Run the normal discover/push gate and production smoke.

Rollback by restoring the prior Worker version or reverting only the compatibility-date release and redeploying. Cloudflare continues to support older dates; no D1 restore is required for a date-only rollback.

## Read-Replication Experiment

D1 read replication is currently beta. It only serves reads from replicas when code uses the D1 Sessions API. The isolated benchmark Worker that ran this experiment was removed from the repository because its Wrangler config bound the production D1 database with `workers_dev = true`. Restore it from git history (`worker/experiments/`, last present at `831d75a8f`) before repeating the experiment, keep it read-only, and keep it out of the production Worker's imports. Its driver script (`scripts/maintenance/`, benchmark-d1-read-replication.mjs) and the `ops:benchmark-d1-read-replication` alias were removed with it; restore the script from git history (last present at `5eefc2cc2`) in the same step and run it directly rather than through an npm alias.

Prerequisites:

1. Confirm the current production query shapes have completed their soak without correctness or p95 regressions.
2. Capture a Time Travel bookmark and current D1 info/Insights baselines.
3. Use a short-lived API token with `D1:Edit`; never write the token to a report or shell history.

Deploy the isolated benchmark Worker and provision its authentication secret:

```bash
cd worker
npx wrangler deploy --config experiments/wrangler.d1-read-replication.toml
npx wrangler secret put BENCHMARK_TOKEN --config experiments/wrangler.d1-read-replication.toml
```

Enable replication through Cloudflare's D1 control-plane API:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_D1_EDIT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"read_replication":{"mode":"auto"}}'
```

Run paired primary/session reads from the same experiment Worker. The original
benchmark harness (`benchmark-d1-read-replication.mjs`) was retired in `5eefc2cc2`
with the 2026-08 cleanup; recover it from Git history for a rerun, or issue paired
`curl` reads against the experiment Worker's primary/session endpoints and compare
payload hashes and `servedByPrimary` manually.

Promotion requires matching payload hashes, actual `servedByPrimary=false` samples, and a material p95 improvement across the representative cache, status, blacklist, depeg, and Tape reads. A faster response that never reaches a replica is not evidence of replication benefit. Do not move the Sessions API into the production request path as part of this experiment.

Disable replication and remove the isolated Worker after the measurement window:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_D1_EDIT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"read_replication":{"mode":"disabled"}}'

cd worker
npx wrangler delete pharos-d1-read-replication-benchmark
```

Cloudflare documents that disabling replica processing can take up to 24 hours. Sessions API remains safe while replication is disabled, but this experiment leaves production code unchanged.

## References

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Workers compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
