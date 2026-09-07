# Worker Cron Agent Notes

Applies to worker/src/cron and its scheduled dispatch wiring.

## Read First

- `docs/process/cron-trigger-policy.md`
- `docs/worker-and-api-limits.md#connection-budget-operating-assumption`
- `docs/worker-infrastructure.md#cron-scheduling`

## Invariants

- Schedule/dispatch parity and trigger capacity are enforced by `check:cron-sync` and `check:cron-connections`.
- Producer publication rules are defined in [Cron Job Ownership](../../../docs/worker-infrastructure.md#cron-job-ownership).
- Preserve slot ownership, heartbeat, takeover, lease cleanup, and terminal fencing across cancellation and platform abandonment.
- After cron, scheduler, memory, or ingestion-risk deployment, observe the first relevant production execution before claiming operational success.

## Entrypoints & Generation

- `worker/wrangler.toml` owns deployed expressions; `shared/lib/cron-jobs.ts` owns logical schedules/capacity and `shared/lib/scheduled-runner-registry.ts` owns slot topology.
- `worker/src/handlers/scheduled.ts` dispatches slots; `worker/src/lib/scheduled-slot-fence.ts` and `worker/src/lib/scheduled-slot-reconciliation.ts` own fencing and cleanup.

## Tests

- Cross-family cron and dispatch coverage lives in `worker/src/cron/__tests__/` and `worker/src/handlers/scheduled/__tests__/`.
- Slot and lease helper coverage lives in `worker/src/lib/__tests__/`.

## Common Checks

- `npm run check:cron-sync`; `npm run check:cron-connections`; `npm run check:cron-console-usage`; `npm run check:fetch-body-timeouts`; `npm run validate:worker-scheduled-smoke`.
