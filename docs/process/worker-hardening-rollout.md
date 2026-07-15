# Worker Structural Hardening Rollout

This runbook covers additive Worker-infrastructure hardening slices such as the
scheduled job-attempt ledger. It is intentionally conservative because D1
migrations apply before the new Worker version is live, while rollback only
restores a prior Worker deployment and does not undo schema changes.

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

## Mode Ownership And Evidence

The **Worker infrastructure on-call** owns every promotion below. A second
maintainer reviews the captured evidence before a production mode change. Put
the evidence bundle under `agents/` with the deployed Worker version, UTC
window, status snapshots, relevant `cron_runs` metadata, and the rollback value.

| Control                        | Checked-in mode | Promotion evidence                                                                                                                                                                        | Immediate rollback                                   |
| ------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `WORKER_JOB_LEDGER_MODE`       | `shadow`        | Two clean producer cycles with no ledger bootstrap, lease-state, progress-heartbeat, terminal-write, status-loader, or prune failures                                                     | `shadow`, then `off` if writes themselves are unsafe |
| `WORKER_CANARY_MODE`           | `shadow`        | Two clean status-self-check cycles at each stage and all findings explained; promotion currently stops at `status`                                                                        | Previous stage, or `off`                             |
| `WORKER_RESERVE_RECOVERY_MODE` | `shadow`        | Eligibility has no unexplained blockers, two preview cancellations reconcile exactly, and a preview recovery completes the suffix and all sidecars without duplicate authoritative writes | `reconcile`, `shadow`, or `off`; retain checkpoints  |

## Job Attempt Ledger

Migration `0165_worker_job_attempts.sql` creates `worker_job_attempts`.
`WORKER_JOB_LEDGER_MODE` controls writes:

- unset / `off`: no attempt rows are written.
- `shadow`: attempt rows are written best-effort alongside existing scheduled
  job execution.
- `write`: bootstrap, lease-state, progress-heartbeat, and terminal ledger writes
  are required; any failure fails the owned job.

Use `WORKER_JOB_LEDGER_ALLOWLIST` as a CSV of job names for first activation.
Leave it unset only after targeted jobs show expected attempt, heartbeat,
terminal-state, status, and prune behavior.

Current checked-in Worker config starts the shadow soak with:
`WORKER_JOB_LEDGER_MODE=shadow` and
`WORKER_JOB_LEDGER_ALLOWLIST=sync-dex-discovery,sync-live-reserves,reserve-recovery,sync-cl-exit-depth,sync-dex-liquidity,sync-stablecoins,sync-yield-data`.

## Verification

For a rollout slice that touches this path, run:

- `npm run check:migrations`
- `npm run check:env-contract`
- focused Worker tests for the changed cron/status modules
- Optional local release rehearsal: `npm run test:merge-gate`

After deployment, inspect `/api/status` for `summary.activeJobAttempts`,
`summary.staleJobAttempts`, and per-cron `latestAttempt` fields. A
`sectionErrors.jobAttempts` entry means the status route could not read the
ledger and should block promotion beyond shadow mode.

An active latest attempt whose lease has expired or whose heartbeat is stale
must make that cron unhealthy immediately. Verify one critical-tier fixture
increments `availabilityImpactingUnhealthyCrons` and one watch-tier fixture
increments only `watchUnhealthyCrons`; a previous successful `cron_runs` row
must not mask either condition.

## Direct Alert Acceptance

Scheduled operational alerts use `sendAlert()` directly. Producer-owned cache
markers and cooldowns remain the incident/repeat authority; delivery is
one-shot and a failed webhook attempt returns `false` so the producer can keep
its retry marker eligible. Direct delivery evidence uses `:direct:v1` cache
keys, so legacy markers written by broker shadow mode cannot suppress the first
direct incident or manufacture a recovery. Observation/onset/streak state stays
on its existing keys. Migration `0175_durable_alert_broker.sql`, legacy marker
fields, and existing rows remain inert for forensic inspection.

The Access-gated compatibility canary remains at
`POST /api/alert-broker-canary`. Preview with `X-Pharos-Admin: 1`, then execute
with `?execute=true&confirm=emit-incident-and-recovery` and a fresh
`Idempotency-Key`. The route accepts only the configured `ALERT_WEBHOOK_URL`
and fixed synthetic copy, sends one incident and one recovery directly, and
returns `502` if either transport attempt fails.

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
   `worker_canary_runs` through the read-only D1/Night Watch path and the latest
   `data-invariant-canary` cron metadata. Shadow rows are intentionally excluded
   from `/api/status.canaries`.
3. Promote to `status` only after persistence succeeds for two consecutive
   cycles and every degraded/error check is resolved or explicitly accepted.
   The status API then reads only current `status` rows.
4. Roll back to `shadow` or `off`; the status API returns its empty/unknown
   compatibility shape without reading retained authoritative rows. Schema and
   telemetry remain additive in D1.

`prune-cron-history` owns canary retention and deletes rows older than 90 days.
The checked-in Worker config is currently at step 2 (`shadow`) so the next
action is observation, not promotion.

## Repair Task Ledger

Migration `0166_worker_repair_tasks.sql` creates `worker_repair_tasks`. DDR
repair-required events are dual-written as diagnostic debt. The daily
`worker-repair-runner` compatibility job permanently reads due/stale counts and
does not claim or mutate tasks. Producer reconciliation closes DDR tasks that
are no longer current, `/api/status.dataQuality.repairDebt` exposes the debt,
and retention removes old terminal rows.

If repair writes fail, the existing cache-backed repair-debt/status paths must
remain readable.

## Reserve Interruption Recovery

`WORKER_RESERVE_RECOVERY_MODE` owns only the isolated five-minute recovery
lane. The four-hour producer always dual-writes generation-fenced checkpoints,
regardless of this mode.

- `off`: do not scan or claim checkpoints.
- `shadow`: run read-only eligibility and blocker queries.
- `reconcile`: generation-CAS stale slot accounting, seal the exact abandoned
  checkpoint/domain attempt, write explicit `not_started` sidecar disposition,
  and prepare the next attempt as `ready`; do not claim it.
- `recover`: perform reconciliation, claim one ready attempt, validate the
  queue hash, and replay the suffix and unfinished sidecars.

Promotion drill:

1. Deploy with the checked-in `shadow` value and observe at least one complete
   four-hour reserve cycle. Active child or recovery leases may appear while a
   producer is live; any other blocker must be explained before promotion.
2. Provision a named Cloudflare Worker environment called
   `reserve-recovery-preview` with its own isolated D1 database bound as `DB`.
   Set `WORKER_RESERVE_FAULT_INJECTION_ENABLED=true` only in that environment;
   keep it unset or false in production. The flag gates both arming and scheduled
   execution, so disabling it also neutralizes any retained fault row. This
   repository change does not create or deploy the environment, and a
   placeholder/fake D1 UUID does not satisfy this prerequisite. On its uploaded `workers.dev` version, obtain a valid
   Access JWT for `CF_ACCESS_OPS_API_AUD` and arm
   `POST /api/admin/reserve-recovery-fault-injection` for an exact version,
   schedule, slot, and attempt. Run two cancellations at different boundaries,
   including one per-asset boundary and one sidecar boundary.
3. Set the preview version to `reconcile`. Within one poll after the exact child
   lease expires, require one `platform_abandoned` source attempt, one `ready`
   successor, exact pending-attempt cleanup, and explicit `not_started`
   dispositions. A duplicate poll must prepare nothing.
4. Set the preview version to `recover`. Require the next attempt number,
   unchanged queue hash, no duplicate authoritative reserve write, terminal
   child accounting exactly once, and no pending/ownership ghost. A forced
   lease contention, budget truncation, or retryable upstream/sidecar error must
   leave the affected child and every downstream sidecar nonterminal, report
   the recovery as degraded/error, and claim the saved work on
   a later poll. On completion it may CAS-retire only the exact source cohort's
   owned global cursor after an acceptable reserve result; error outcomes and a
   newer normal-run cursor must remain byte-for-byte unchanged.
5. Repeat `shadow -> reconcile -> recover` in production. Hold each promotion
   until its evidence is captured. Roll back immediately to `reconcile` to stop
   claims, `shadow` to stop mutation, or `off` to stop scans; checkpoint dual
   writes remain enabled for forensic continuity.

## Historical Data Debt Closure

Migration `0178_historical_data_debt_closure.sql` adds the resumable mint-price
repair state and applies the reviewed append-only DDR repairs for BRLA events
`90492`, `90493`, `90494`, and `90496`. Before running the mint-price operator:

1. Confirm migration `0178` is applied and take a fresh D1 Time Travel bookmark with `cd worker && npx wrangler d1 time-travel info stablecoin-db`.
2. Preview a bounded batch through `POST /api/backfill-mint-burn-prices?dry-run=true&limit=100`; review every `disposition`, especially `irreducible` and provider-retry reasons.
3. Execute the same scope with a unique `Idempotency-Key` and `dry-run=false&confirm=historical-mint-prices&bookmark=<fresh-d1-bookmark>`. The route rejects mutation unless both identifiers are present and persists them on every attempted row. Keep the batch at or below 500 rows.
4. Repeat until `backlog.unclassified = 0` and `backlog.pendingAggregate = 0`. A nonzero `pendingAggregate` means the next call must resume aggregate rebuild/verification before attempting more prices.
5. Do not use `retry-irreducible=true` unless a named event-day historical source was added or repaired. Current spot, peg par, and adjacent-day prices are forbidden substitutes.
6. Verify the four DDR tasks are `closed`, all four event links carry non-null repair authorizations, the two canonical incidents point to events `90494` and `90496`, and the regenerated DDR/DDR-review caches no longer carry the invalidation marker.

Normal code rollback keeps the additive repair columns and all DDR
authorizations, consumptions, links, and revisions. Use the pre-run Time Travel
bookmark only for confirmed data corruption; never delete append-only DDR
provenance as a routine rollback step.

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
