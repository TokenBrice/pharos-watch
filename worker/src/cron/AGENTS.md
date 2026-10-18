# Worker Cron Agent Notes

Applies to worker/src/cron and its scheduled dispatch wiring.

## Read First

- Read the routed `docs/process/cron-trigger-policy.md#source-of-truth` and `#target`. Changes to work, fetch pressure, CPU placement or topology also require `#current-growth-gate`; adding scheduled work requires `#process-for-new-scheduled-work`.
- `docs/worker-and-api-limits.md#connection-budget-operating-assumption`
- `docs/worker-infrastructure.md#event-entry-lifecycle-and-admission`; schedule/dispatch/fence changes also require `#cron-scheduling`. Job-local changes do not need the generated inventory of every other slot.

## Invariants

- Schedule/dispatch parity and trigger capacity are enforced by `check:cron-sync` and `check:cron-connections`.
- Producer publication rules are defined in [Cron Job Ownership](../../../docs/worker-infrastructure.md#cron-job-ownership).
- Preserve slot ownership, heartbeat, takeover, lease cleanup, and terminal fencing across cancellation and platform abandonment.
- After cron, scheduler, memory, or ingestion-risk deployment, observe the first relevant production execution before claiming operational success.

## Entrypoints & Generation

- `worker/wrangler.toml` and `worker/wrangler.heavy.toml` own deployed expressions; `shared/lib/cron-jobs.ts` owns logical schedules/capacity and `shared/lib/scheduled-runner-registry.ts` owns slot topology and Worker ownership.
- `worker/src/handlers/scheduled.ts` dispatches slots; `worker/src/lib/scheduled-slot-fence.ts` and `worker/src/lib/scheduled-slot-reconciliation.ts` own fencing and cleanup.

## Tests

- Cross-family cron and dispatch coverage lives in `worker/src/cron/__tests__/` and `worker/src/handlers/scheduled/__tests__/`.
- Slot and lease helper coverage lives in `worker/src/lib/__tests__/`.

## Common Checks

- `npm run check:cron-sync`; `npm run check:cron-connections`; `npm run check:fetch-body-timeouts`; `npm run validate:worker-scheduled-smoke`.
