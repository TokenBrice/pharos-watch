# Operational acceptance (read-only)

[Operational Acceptance](../../../../docs/deployment-process.md#operational-acceptance) and [Monitoring Without Model Polling](../../../../docs/deployment-process.md#monitoring-without-model-polling) own the rules, commands and flags; they win over this page. Use it after `Deploy to Cloudflare` succeeded for a cron, scheduler, memory, migration or ingestion change, or when picking up an `ops:followup` acceptance issue.

Hard stops: observe only. Never deploy, write D1, clear a lease, reset a checkpoint, or loosen an identity, freshness or score gate to obtain a green row. A defect found here becomes a `bug` issue or goes to [pharos-ci-failure-triage](../../pharos-ci-failure-triage/SKILL.md).

## Before Activation

For a nonurgent Worker release, activate after the hourly `:22` Safety Score publication rather than between `:16` preparation and compilation; the owner section states the preference and its urgent-fix exception. A paired Liquidity/Pricing methodology release has its own window there.

## Anchor The Release

Record before observing: merge SHA, `Deploy to Cloudflare` run ID, the activated public and heavy Worker version IDs with activation time, the Pages release marker, affected jobs and endpoints, the expected result/publication contract, the observation deadline, and any later deploy that supersedes this one. A run that started before activation, or an edge-cached response, is never proof.

## Observe By Change Class

- **Cron, scheduler, memory:** the first matching scheduled execution after activation, on the exact Worker version, inside its expected status, duration, memory and publication contract. `npm run ops:watch-worker-cron -- --json` is one snapshot for an execution that should already have finished; `npm run ops:night-watch-worker` collects a fixed window. Save the Access-protected `/api/status-cron-detail?job=<job>` payload and evaluate it with `scripts/lib/first-execution-acceptance.mts` (exit `0` passed, `1` failed, `2` pending). Run `npm run ops:cron-delivery` for both Workers and require no correlated resource deaths. For coupled lanes, observe the next full same-build cycle.
- **D1 migration:** no pending migration in the remote ledger; new objects or reviewed-DML post-conditions confirmed with `wrangler d1 execute stablecoin-db --remote --command "SELECT ..."` (never `--file`); the first affected read/write or scheduled path succeeds; the pre-window Time Travel bookmark and rollback Worker version are recorded. Worker rollback does not revert D1. Start from [D1 connectivity first checks](../../../../docs/runbooks/db-connectivity.md#first-checks).
- **Ingestion, producer, methodology:** the first post-activation run's upstream diagnostics show no new rejection or rate-limit class; public `_meta.updatedAt`, generation and methodology version match that run (`--require-publication` for `sync-stablecoins`). Separate what the first run proves from delayed windows (soak, backoff expiry, weekend closures).
- **Pages, scheduled workflows:** uncached release marker at the target SHA, a narrow affected-route smoke, `npm run verify:detail-snapshot-sources` when detail snapshots changed, and the next scheduled `Rebuild Pages`, `Production Canaries` or `Worker Memory Monitor` run.

Use one deadline-bounded watcher per target; do not poll unchanged state. Collectors exiting zero do not certify health: read the report.

## Classify And Hand Off

Classify every item as **passed** (run ID, timestamp, metric), **failed** (separate defect issue), **pending** (not yet observable) or **unobservable read-only** (reason). Pending is never success.

When the observation falls after the session, file one `ops:followup` issue per dated check under [Follow-up issues](../../../../docs/process/agent-artifacts.md#follow-up-issues): `Due:` is the next re-check date, and the body carries the release anchors above, the exact `Check:` command or URL, and `Done when:`. When picking one up, comment public-safe evidence (no secrets, no row-level D1 output), close only when every item passed or was routed, otherwise move `Due:`.
