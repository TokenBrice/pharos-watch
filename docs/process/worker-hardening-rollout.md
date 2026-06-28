# Worker Structural Hardening Rollout

This runbook covers additive Worker-infrastructure hardening slices such as the
scheduled job-attempt ledger. It is intentionally conservative because D1
migrations apply before the new Worker version is live, while rollback only
re-promotes Worker code and does not undo schema changes.

## Contract

1. Additive schema first. New tables, columns, and indexes must keep the
   previous production Worker valid until the deploy completes.
2. New runtime behavior starts disabled unless it is strictly read-only.
3. Shadow mode must be best effort: write failures log diagnostics but must not
   fail scheduled jobs, leases, or existing `cron_runs` writes.
4. Status surfaces must expose shadow telemetry query failures as diagnostics
   without changing availability scoring until a later milestone explicitly does
   so.
5. Retention or pruning must ship with the first writer that can grow a table.

## Job Attempt Ledger

Migration `0165_worker_job_attempts.sql` creates `worker_job_attempts`.
`WORKER_JOB_LEDGER_MODE` controls writes:

- unset / `off`: no attempt rows are written.
- `shadow`: attempt rows are written best-effort alongside existing scheduled
  job execution.
- `write`: reserved for a later promotion; currently behaves like `shadow`.

Use `WORKER_JOB_LEDGER_ALLOWLIST` as a CSV of job names for first activation.
Leave it unset only after targeted jobs show expected attempt, heartbeat,
terminal-state, status, and prune behavior.

Current checked-in Worker config starts the shadow soak with:
`WORKER_JOB_LEDGER_MODE=shadow` and
`WORKER_JOB_LEDGER_ALLOWLIST=sync-dex-discovery,sync-live-reserves,sync-dex-liquidity,sync-stablecoins,sync-yield-data`.

## Verification

For a rollout slice that touches this path, run:

- `npm run check:migrations`
- `npm run check:env-contract`
- focused Worker tests for the changed cron/status modules
- `npm run test:merge-gate` before pushing

After deployment, inspect `/api/status` for `summary.activeJobAttempts`,
`summary.staleJobAttempts`, and per-cron `latestAttempt` fields. A
`sectionErrors.jobAttempts` entry means the status route could not read the
ledger and should block promotion beyond shadow mode.

## Data-Invariant Canaries

Migration `0167_worker_canary_runs.sql` creates `worker_canary_runs`.
`WORKER_CANARY_MODE` controls the scheduled `data-invariant-canary` job:

- unset / `off`: the job exits without writes.
- `shadow`: run checks and persist telemetry; persistence failures are reported
  in cron metadata as `persistFailed` but do not fail the scheduled slot.
- `status`: same writer path as `shadow`; `/api/status.canaries` is expected to
  be watched by operators.
- `alert`: reserved for later escalation; do not enable until alert routing has
  a separate acceptance test.

Activation sequence:

1. Deploy migrations with `WORKER_CANARY_MODE=off`.
2. Set `WORKER_CANARY_MODE=shadow` for one status-self-check cycle and inspect
   `/api/status.canaries`, `sectionErrors.canaries`, and the latest
   `data-invariant-canary` cron metadata.
3. Promote to `status` only after persistence succeeds for at least one cycle
   and any degraded/error checks are understood.
4. Roll back by setting `WORKER_CANARY_MODE=off`; schema and retained telemetry
   are additive and can remain in D1.

`prune-cron-history` owns canary retention and deletes rows older than 90 days.
The checked-in Worker config is currently at step 2 (`shadow`) so the next
action is observation, not promotion.

## Repair Task Ledger

Migration `0166_worker_repair_tasks.sql` creates `worker_repair_tasks`.
Initial producers should enqueue only shadow/diagnostic repair debt. Runner
promotion requires:

- an allowlisted task kind,
- bounded claim batch size,
- visible `/api/status.dataQuality.repairDebt` counts,
- rollback by disabling the producer or runner without deleting queued rows.

If repair writes fail, the existing cache-backed repair-debt/status paths must
remain readable.

The checked-in Worker config sets `WORKER_REPAIR_RUNNER_MODE=shadow` so the
daily runner reports due/stale backlog telemetry without claiming tasks.

## Status Supplements

`publicationHealth`, `dependencyHealth`, `providerCircuitHealth`, and
`canaries` are advisory admin supplements. Loader failures must produce a
matching `sectionErrors.*` entry and `null` supplement value, not a failed
`/api/status` response. These fields are optional in the public TypeScript/Zod
contract so a newer frontend can read an older Worker during rollback.

The current `publicationHealth` slice covers DEX-liquidity and yield-ranking
publication generations, plus stablecoins, DEWS, PSI, and report-card cache
through existing cache/table fallbacks until generic surface rows are written.
Do not treat missing generic rows for those fallback-backed surfaces as rollout
failures; treat missing fallback data itself as a data-publication issue.

## Night Watch

For staged activation, collect an operator window with:

```bash
npm run ops:night-watch-worker -- --cycles 1 --include-status --include-status-history --include-d1
```

For recurring hardening soaks or follow-up after a production incident, collect
two complete four-hour cycles with:

```bash
npm run ops:night-watch-worker:two-cycle
```

When operator origins are behind Cloudflare Access, pass the service token via
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` environment variables. The
collector records D1/status access failures as access gaps in the evidence
rather than aborting the report.

Use the generated coverage matrix plus `artifactGaps`, legacy `artifactErrors`,
`jobAttempts`, `repairTasks`, `canaryRuns`, and `publicationGenerations`
evidence to decide whether the slice can promote beyond shadow/status mode.
