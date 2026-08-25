# Worker Runtime Experiments

Planned, gated release procedures for two runtime changes that are never bundled with schema, methodology, recovery, or data-repair work: advancing the Workers compatibility date, and evaluating D1 read replication. Each is its own release. Incident-time D1 storage pressure is a different job; use [`docs/runbooks/d1-capacity-and-runtime-experiments.md`](../runbooks/d1-capacity-and-runtime-experiments.md).

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

D1 read replication is currently beta. It only serves reads from replicas when code uses the D1 Sessions API. The isolated benchmark Worker that ran this experiment was removed from the repository because its Wrangler config bound the production D1 database with `workers_dev = true`. Before repeating it, restore the complete compatible snapshot from commit `831d75a8f`: `git:831d75a8f:worker/experiments/d1-read-replication-benchmark.ts`, its test in the same historical directory, `git:831d75a8f:worker/experiments/tsconfig.json`, `git:831d75a8f:worker/experiments/wrangler.d1-read-replication.toml`, and `git:831d75a8f:scripts/maintenance/benchmark-d1-read-replication.mjs`. The `git:<revision>:<path>` notation is verified by the documentation source-path check. Keep the Worker read-only and outside production imports. The deleted npm alias is not required; run the restored driver directly.

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
benchmark harness (`benchmark-d1-read-replication.mjs`) was removed with the
2026-08 cleanup; recover the verified `831d75a8f` snapshot for a rerun, or issue paired
`curl` reads against the experiment Worker's single endpoint with `mode=primary` and
`mode=replica` (each also requires `case`, an integer `asOf`, and a `BENCHMARK_TOKEN`
bearer header) and compare the top-level `payloadHash` and `d1.servedByPrimary` manually.

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

- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Workers compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
