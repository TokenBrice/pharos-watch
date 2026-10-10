# Worker Runtime Experiments

Permanent, manual release qualification for paired Public/Heavy Workers compatibility dates, plus safe criteria for a future separately approved D1 read-replication evaluation. Neither is an active shadow runtime. Compatibility changes never share a release with schema, methodology, recovery, data repair, or replication changes. For incident-time storage pressure use [`docs/runbooks/d1-capacity-and-runtime-experiments.md`](../runbooks/d1-capacity-and-runtime-experiments.md).

## Compatibility-Date Experiment

The checked-in production date is not changed by the benchmark command.

```bash
npm run ops:benchmark-worker-compatibility -- --candidate-date YYYY-MM-DD
```

The command qualifies **Public/Heavy × baseline/candidate**: four full-config dry-run bundles, four startup profiles, and four fresh migrated local D1 smoke outcomes. It rejects mismatched checked-in role dates. Each report names role/config/date and passed/failed/skipped outcomes, `completeness`, `promotionReady`, `localOnly:true`, and `deployed:false`; skipped or failed required evidence always leaves `promotionReady:false`.

Public smoke checks `/api/health`. Heavy has no health fetch handler: its `scheduled-heavy` smoke uses the actual next UTC `:08` event within the real three-minute window with at least 60 seconds remaining. An isolated temporary config preserves runtime flags/aliases/entrypoint while omitting secrets and production bindings; outbound fetch and business writes are blocked. Empty-core proof requires a nonblank local version, child `skipped_neutral` with metadata/productivity reason `v9-core-slot-not-ready`, null core state/result/version, both publication-match booleans false, and enclosing parent `resultStatus:ok`. The producer callback is not reached; local lease/cron/slot bookkeeping is expected. This is **neutral admission proof, not successful Heavy producer acceptance**. `npm run validate:worker-heavy-runtime-smoke` exercises that same limited contract and can wait for the next hourly event.

Promotion gate:

1. Review Cloudflare's compatibility flags introduced between the two dates.
2. Require all four role/date bundle/startup/smoke outcomes and explicit complete evidence; review the Heavy neutral proof separately from actual producer acceptance.
3. Advance **both** `worker/wrangler.toml` and `worker/wrangler.heavy.toml` together in a dedicated release with no D1 migration, methodology change, data repair, or read-replication change.
4. Complete [pre-push readiness](../testing.md#pre-push-readiness) and production smoke.

Rollback restores both prior role dates/versions together. Cloudflare continues to support older dates; no D1 restore is required for a date-only rollback. The permanent tooling repair itself does not change either checked-in date.

## Read-Replication Experiment

**Retired 2026-08-09.** The historical benchmark bound production D1 with `workers_dev=true`; its restoration/deployment shortcut is not supported. No current benchmark implementation or production Sessions API integration is introduced by this procedure. Permanent admin `readReplicationMode` telemetry remains.

Historical Git provenance is research-only, **not a deployment recipe**: `git:831d75a8f:worker/experiments/d1-read-replication-benchmark.ts`, its test in that historical directory, `git:831d75a8f:worker/experiments/tsconfig.json`, `git:831d75a8f:worker/experiments/wrangler.d1-read-replication.toml`, and `git:831d75a8f:scripts/maintenance/benchmark-d1-read-replication.mjs`. The documentation source-path check preserves these archival references.

Future evaluation requires a measured read-latency problem and representative benefit hypothesis, followed by approval to build/review a new authenticated Access-only harness with `workers_dev=false`, previews off, and no production request-path import. Initial trials use a dedicated copied dataset. Any production-bound trial or replication enable/disable mutation needs separate explicit operations authorization; capacity pressure alone is not justification.

Retain these evaluation criteria:

1. Production query shapes complete their correctness/p95 soak; capture D1 info/Insights baselines and a Time Travel bookmark before separately authorized production operations.
2. Any required `D1:Edit` credential is short-lived and never written to reports or shell history.
3. Pair primary/session reads with identical fixed inputs, cases and `asOf`; require matching `payloadHash` values and actual `servedByPrimary=false` samples.
4. Require material representative p95 benefit across cache, status, blacklist, depeg and Tape reads without correctness regression. Faster primary-only responses do not establish replica benefit. Production Sessions integration requires its own release.
5. Observe control-plane mode changes. After a future disable, Cloudflare propagation can take up to 24 hours; code/doc rollback does not recreate a deleted remote Worker.

**Orphan-resource operation:** first perform a read-only inventory for `pharos-d1-read-replication-benchmark`, recording identity/config/ownership and absence or presence. If present, archive measurement/config evidence before a separately authorized removal after rollback-floor closure. Repository retirement and observed disabled replication do not prove resource absence. No replication mutation or remote deletion is authorized by this document.

## References

- [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Workers compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
