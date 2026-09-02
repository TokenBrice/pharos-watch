---
name: worker-cron-change
description: Use when adding, reviewing, or repairing Pharos Worker cron schedules, slot dispatch, leases, or runtime experiments.
---

# Worker Cron Change

## Purpose

Route cron changes through the source-owned topology, bounded fetch budget, and fenced runtime.
Keep policy and incident detail in the owner docs; this skill coordinates the change and proof.

## Read first

- `worker/src/cron/AGENTS.md`
- [Cron policy: Source Of Truth](../../../docs/process/cron-trigger-policy.md#source-of-truth) and [new scheduled work](../../../docs/process/cron-trigger-policy.md#process-for-new-scheduled-work)
- [Connection-budget operating assumption](../../../docs/worker-and-api-limits.md#connection-budget-operating-assumption)
- [Cron Scheduling](../../../docs/worker-infrastructure.md#cron-scheduling), [slot capacity](../../../docs/worker-infrastructure.md#cron-slot-capacity-and-connection-pool-budget), and [Health & Status Endpoints](../../../docs/worker-infrastructure.md#health-status-endpoints)
- `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, and `shared/lib/scheduled-runner-registry.ts`
- `worker/src/handlers/scheduled.ts`, `worker/src/lib/scheduled-slot-fence.ts`, `worker/src/lib/scheduled-slot-reconciliation.ts`, and `worker/src/lib/cron-lease-primitives.ts`
- [Cron Slot Abandonment](../../../docs/runbooks/cron-slot-abandonment.md) and [Lease And Breaker Recovery](../../../docs/runbooks/lease-and-breaker-recovery.md)
- [Worker Runtime Experiments](../../../docs/process/worker-runtime-experiments.md#compatibility-date-experiment) and [read replication](../../../docs/process/worker-runtime-experiments.md#read-replication-experiment)

## Procedure

1. **Inventory with `shared/lib/cron-jobs.ts` and `worker/wrangler.toml`.** Map the logical schedule, physical trigger, status identity, runner key, and connection budget; run `npm run check:cron-sync`.
2. **Plan in `shared/lib/scheduled-runner-registry.ts`.** Fit work into an audited slot. Treat a 5/6 slot as full, and add a trigger only after the growth gate and consolidation/rebalance review in the cron policy.
3. **Wire `worker/src/handlers/scheduled.ts`.** Keep dispatch parity, serial/parallel ordering, and the correct runner entrypoint. For fetch-heavy work, consume or cancel each response body before later fetches.
4. **Preserve `worker/src/lib/scheduled-slot-fence.ts` and `worker/src/lib/cron-lease-primitives.ts`.** Check takeover, heartbeat, lease, cancellation, terminal fencing, and stale-artifact reconciliation in `worker/src/lib/scheduled-slot-reconciliation.ts`; never clear a live lease.
5. **Run the focused commands** `npm run check:cron-connections`, `npm run check:cron-console-usage`, and `npm run check:fetch-body-timeouts`. Keep compatibility-date or read-replication experiments isolated and clean up their temporary surface per the runtime-experiments process.
6. **Observe with `npm run ops:watch-worker-cron` and the status endpoint.** After a cron, scheduler, memory, or ingestion-risk deployment, inspect the first relevant production execution before claiming operational success; use the abandonment and lease runbooks for anomalies.

## Verification

- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:cron-console-usage`
- `npm run check:fetch-body-timeouts`
- `npm run validate:worker-scheduled-smoke`
- `npx vitest run worker/src/handlers/scheduled/__tests__/scheduled-runner-contract.test.ts worker/src/lib/__tests__/cron-leases-scheduled-slot.test.ts`

## Do not

- Add a physical trigger without auditing headroom and rebalancing the reviewed growth gate.
- Open another fetch before the prior response body is consumed or cancelled; the trigger-wide budget is six, and 5/6 is full for new fetch-heavy work.
- Duplicate schedule truth: `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, and `shared/lib/scheduled-runner-registry.ts` own different layers.
- Clear a lease while matching status-endpoint progress is fresh, or let a late finalizer overwrite a takeover.
- Treat a green deploy as cron health; first-production-run evidence is required.

## Handoff

Report the changed schedule/slot and runner, connection and CPU-budget evidence, focused checks, first production execution, and any abandonment, lease, experiment-cleanup, or rollback follow-up.
