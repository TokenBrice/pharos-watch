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
