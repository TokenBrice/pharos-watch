# D1 Capacity And Runtime Experiments

Use this runbook for D1 storage pressure, the measured hot-query rollout, a Workers compatibility-date advance, or a D1 read-replication experiment. Compatibility and replication experiments are separate releases. Neither is bundled with schema, methodology, recovery, or data-repair changes.

## Capacity Signals

Cloudflare's paid-plan limit is 10 GB per D1 database and cannot be raised. Pharos classifies current file-size utilization at these exact boundaries:

| Utilization | State | Operator action |
| --- | --- | --- |
| below 60% | `normal` | Continue routine observation. |
| 60% to below 75% | `watch` | Review the 30-day trend and largest retained tables. |
| 75% to below 90% | `warning` | Schedule retention/index remediation and confirm a current Time Travel bookmark. |
| 90% or above | `critical` | Stop nonessential write amplification and execute the approved capacity plan. |

`d1_capacity_observations` retains at most one observation per UTC hour. The calculation uses linear regression over the latest 30 days only after at least three samples span 24 hours. Until then, or when the measured slope is flat/negative, `exhaustionAt` remains null. A D1 `DELETE` reducing reported file size is evidence for that run only, not a general compaction guarantee.

The scheduled `status-self-check` lane refreshes the Cloudflare control-plane size observation and routes threshold transitions through the durable alert broker. A 60% crossing opens a warning watch, 75% makes public/admin health degraded, and 90% makes capacity health stale and the broker incident critical. Three consecutive control-plane failures open the separate `d1:capacity-observation-unavailable` warning. `/api/health.d1Capacity` and `/api/status.d1Usage.capacity` expose the latest assessment; old Workers and an uninitialized observation cache remain compatible because both fields are additive/optional.

## Hot-Query Rollout

Migration `0179_measured_hot_query_indexes.sql` is additive. It covers only query families justified by the July 2026 D1 Insights capture:

- global time-bounded `cron_runs` reads;
- public blacklist pages filtered by `chain_id`;
- time-ordered `yield_source_decisions` scans.

The code rollout separately:

- uses the existing DDR first-publication partial index by requiring `first_published = 1`;
- trusts `stress_signals_latest` only when every row matches the completed publication generation, otherwise preserving the canonical-history merge;
- replaces Tape DEWS predecessor grouping with bounded per-coin index seeks;
- forces time-bounded mint/burn aggregates through `idx_mbh_ts` and replaces full-table first-hour grouping with bounded `(chain_id, stablecoin_id, hour_ts)` seeks;
- pins blacklist page queries to the matching public pagination index so SQLite cannot prefer the low-selectivity suppression index.

Before applying the index migration:

1. Capture `cd worker && npx wrangler d1 time-travel info stablecoin-db` and retain the bookmark in the release record.
2. Run `npm run ops:d1-insights -- --period 7d --period 30d --sort-by reads --sort-by time`.
3. Record `cd worker && npx wrangler d1 info stablecoin-db --json` for the pre-index file size.
4. Save `EXPLAIN QUERY PLAN` output for each indexed query family.

After deployment and at least two producer cycles:

1. Repeat the plans, D1 Insights capture, and D1 info snapshot.
2. Verify DDR first-publication probes are near the first-publication row count rather than retained snapshot-row count.
3. Verify no legacy stress query runs for a current, exact latest generation.
4. Verify the Tape predecessor path reads fewer than 1,000 rows and stays below 5 seconds at p95.
5. Record index storage delta separately from retained-data growth.

Confirm the next `status-self-check` metadata contains `d1CapacityMonitoring`, and verify the `d1:capacity-threshold` broker condition is recovered below 60% or active at the expected threshold. Do not force a production threshold by writing synthetic size observations.

Rollback the Worker for a query-shape regression. Keep additive indexes in place during the immediate rollback so the previous Worker remains compatible. If an index has unacceptable storage/write cost, remove it only in a later coordinated cleanup migration after capturing a new Time Travel bookmark.

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

D1 read replication is currently beta. It only serves reads from replicas when code uses the D1 Sessions API. The experiment Worker at `worker/experiments/d1-read-replication-benchmark.ts` is read-only and is not imported by the production Worker.

Prerequisites:

1. Complete and soak correctness and hot-query changes first.
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

Run paired primary/session reads from the same experiment Worker:

```bash
D1_BENCHMARK_TOKEN=... npm run ops:benchmark-d1-read-replication -- \
  --url https://pharos-d1-read-replication-benchmark.<account-subdomain>.workers.dev
```

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
