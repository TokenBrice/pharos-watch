---
name: worker-cron-change
description: Use when adding, reviewing, or repairing Pharos Worker cron schedules, slot dispatch, leases, or runtime experiments.
---

# Worker Cron Change

## Trigger And Exclusions

Use for cron/lease work and approved runtime qualification, not unrelated Worker/API work.

## Classify The Operation

Select schedule/dispatch, lease/abandonment recovery, compatibility-date qualification, or approved replication evaluation before reading branch context.

## Mandatory Core

- `worker/src/cron/AGENTS.md`; [Cron source of truth](../../../docs/process/cron-trigger-policy.md#source-of-truth), [connection-budget assumption](../../../docs/worker-and-api-limits.md#connection-budget-operating-assumption), and [Cron Scheduling](../../../docs/worker-infrastructure.md#cron-scheduling).
- Inventory `worker/wrangler.toml`, `worker/wrangler.heavy.toml`, `shared/lib/cron-jobs.ts`, and `shared/lib/scheduled-runner-registry.ts`: cadence, aliases, role, status identity, runner, connection/CPU budget. Both configs own deployed expressions; cron metadata owns schedules/budgets; runner registry owns role/slot topology. Never duplicate that truth.
- Preserve the public/heavy union growth gate; treat 5/6 as full for new fetch-heavy work. Consume or cancel each response body before later fetches; the trigger-wide budget is six.
- Never clear a live lease or let a late finalizer overwrite a takeover. A green deploy is not runtime health: changed cron/scheduler/memory/ingestion paths require first-production-run evidence.
- The replication benchmark is retired: no supported restore/deploy shortcut. Future evaluation needs separate approval and a reviewed Access-only copied-dataset harness; retirement does not authorize remote deletion or replication mutation.

## Branch Reads And Actions

- **Schedule/dispatch:** read [new scheduled work](../../../docs/process/cron-trigger-policy.md#process-for-new-scheduled-work) and [slot capacity](../../../docs/process/worker-infrastructure-appendix.md#cron-slot-capacity-and-connection-pool-budget). Fit work into an audited slot; update its exact schedule-bound `CRON_CONNECTION_BUDGET_ENTRIES` row. Add a physical trigger only after the growth gate and consolidation/rebalance review. In `worker/src/handlers/scheduled.ts`, preserve dispatch parity, role ownership, serial/parallel order and runner entrypoint; misowned invocations skip neutrally, and triggers belong in the owner's config. Inspect `worker/src/lib/scheduled-slot-fence.ts`, `worker/src/lib/cron-lease-primitives.ts`, and `worker/src/lib/scheduled-slot-reconciliation.ts` for takeover, heartbeat, cancellation, terminal fencing and stale-artifact reconciliation.
- **Lease/abandonment recovery:** read [Cron Slot Abandonment](../../../docs/runbooks/cron-slot-abandonment.md), [Lease And Breaker Recovery](../../../docs/runbooks/lease-and-breaker-recovery.md), and [Health & Status Endpoints](../../../docs/process/worker-infrastructure-appendix.md#health--status-endpoints); inspect the fence/lease/reconciliation sources above. Fresh matching status progress bars lease clearing.
- **Compatibility date:** read [qualification](../../../docs/process/worker-runtime-experiments.md#compatibility-date-experiment). Require Public/Heavy × baseline/candidate evidence; isolated Heavy neutral admission is not producer success. Advance/roll back both roles together in a dedicated date-only release, never mixed with schema, methodology, recovery, data repair, or replication changes.
- **Approved replication evaluation only:** read [retired benchmark and future evaluation](../../../docs/process/worker-runtime-experiments.md#read-replication-experiment), including production-operation authorization, credential, correctness/benefit, propagation, and orphan-resource stops. Historical Git provenance is research-only.

## Checks Owned By The Verifier

The assigned verifier runs checks after writers finish; implementation agents return required checks and do not independently claim validation.

- Topology/runtime: `npm run check:cron-sync`, `npm run check:cron-connections`, `npm run check:cron-console-usage`, `npm run check:fetch-body-timeouts`, `npm run validate:worker-scheduled-smoke`.
- Dispatch/leases: `npx vitest run worker/src/handlers/scheduled/__tests__/scheduled-runner-contract.test.ts worker/src/lib/__tests__/cron-leases-scheduled-slot.test.ts`.
- Experiments: use only the selected branch's qualification gates. After an authorized risk-bearing deployment, observe the first relevant execution with `npm run ops:watch-worker-cron` and the status endpoint; route anomalies to the incident branch.

## Completion Evidence

Report changed schedule/slot/runner, connection and CPU-budget evidence, checks actually run (or handed to the verifier), first production execution or pending acceptance, and abandonment/lease/experiment-cleanup/rollback follow-up.
