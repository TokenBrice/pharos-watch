# Cron Trigger Budget Policy

This policy governs the addition of new cron trigger expressions to `worker/wrangler.toml`.

## Source Of Truth

`worker/wrangler.toml` owns the deployed cron expressions. Each expression maps to one Cloudflare scheduled-trigger invocation, dispatched in `worker/src/handlers/scheduled.ts` to the jobs configured for that slot in `shared/lib/scheduled-runner-registry.ts`. Run `npm run check:cron-sync` and `npm run check:cron-connections` for the current inventory and capacity report.

Cloudflare Workers enforce a limit of **6 simultaneous outbound requests waiting for response headers** per invocation. Pharos applies a conservative six-connection budget across every job dispatched within a trigger slot, even though Cloudflare releases the header-wait slot when headers arrive. The repo policy is documented in:

- `docs/worker-and-api-limits.md` — see "Connection-budget operating assumption"
- `docs/worker-infrastructure.md` — section "Cron Scheduling", subsection "Cron Slot Capacity and Connection Pool Budget"

## Target

**Do not add a new cron trigger expression unless every existing 6-budget slot has been audited for headroom and rebalanced.**

The growth gate is **34 physical trigger expressions**, **32 fetch-capable scheduled entries**, and two headroom-full (`5/6`) slots before re-architecting batched dispatch. ADR-10 replaced the prior single 20-expression soft cap after the schedule became fully source-owned, fenced, connection-budgeted, and status-tracked; ADR-20 records the current 34-expression reviewed topology. Crossing any gate requires a follow-up ADR plus a trigger consolidation or rebalance plan. Failure-isolated recovery work must remain independent of the invocation it is intended to recover.

### Current growth gate

The reviewed topology is fixed at **34 physical trigger expressions**, **32 fetch-capable scheduled entries**, and at most two headroom-full (`5/6`) slots. The current topology has one such slot, `halfHourlyOffset`; active measured execution remains `3/6`, and the bounded Solana shadow collector runs only after the EVM lane has released its connections, preserving that peak. Other shadow/native diagnostics remain daily. `npm run check:cron-sync` rejects a 35th physical trigger, and `npm run check:cron-connections` rejects another fetch-capable entry or a third `5/6` slot until this gate is deliberately re-reviewed. These limits are owned by `CRON_GROWTH_HEADROOM_POLICY` in `shared/lib/cron-jobs.ts`; changing one is a policy change, not a routine schedule edit.

A sub-hourly logical cadence carrying heavy CPU work must use the paired-hourly physical form: one hourly `M * * * *` alias per logical offset, with the logical schedule and slot identity retained in `shared/lib/cron-jobs.ts`. Splitting an existing comma expression into hourly aliases is a topology rebalance of existing logical work, not new scheduled work. This qualifies the invocation for Cloudflare's hourly Cron CPU class without increasing logical cadence, fetch surface, or connection pressure; see the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Before adding fetch-heavy scheduled work, the Worker operations owner is the required reviewer and must review the measured workload before one of these consolidation/rebalance paths is executed:

1. Preserve the active/shadow measured-execution surfaces. A bounded native collector may share the active `0,30` trigger only as a serialized phase with a proven unchanged connection peak and a producer runtime below the slot fence; broad diagnostic fan-out remains daily.
2. Reduce `sync-dex-liquidity-stage` from `5/6` to `4/6` by serializing the nested provider fan-out or moving a bounded source partition to a slot with proven headroom; preserve the hourly `:10` source cadence and re-run the topology checks.
3. If that path does not preserve required freshness, move the bounded unit of work to Cloudflare Queues or Workflows rather than adding another fetch-heavy cron surface.

The same owner must explicitly consider Queues/Workflows when a proposed workload has measured p95 duration of **10 minutes or more**, fan-out of **1,000 units per run or more**, or static connection pressure of **5/6**. Record the measured duration, fan-out, and connection-budget report in the PR; a threshold crossing requires a decision and rationale, not an automatic migration.

## Process for new scheduled work

When proposing a new cron job:

1. **Audit existing slots.** Run `npm run check:cron-connections`. The checker derives each trigger's peak from `shared/lib/scheduled-runner-registry.ts`: serial chains use the max child budget, parallel chains are summed, and budget-only side work is modeled as a separate serial stage. Identify slots at or below `4/6`.
2. **Fit into an existing trigger.** Map the new job into a slot plan in `shared/lib/scheduled-runner-registry.ts` to share an existing trigger that has headroom. Jobs sharing a slot must consume or cancel any fetch response bodies before opening more fetches; see `docs/worker-and-api-limits.md`.
3. **Only add a new cron expression after** the current growth gate has been re-reviewed and the consolidation/rebalance path above is complete. A fetch-isolated job still documents why it cannot share a slot (e.g. dedicated rate-limit budget for blacklist sync, mint-burn, dex-discovery, telegram dispatch).
4. **Update `CRON_CONNECTION_BUDGET_ENTRIES`** in `shared/lib/cron-jobs.ts` to declare the new job's `maxConnections` and `connectionGroup`. `connectionGroup` documents serial sharing within a chain, but it does not reduce the peak across independent parallel chains. The CI guardrail `scripts/ci/check-cron-connection-budget.ts` (invoked via `npm run check:cron-connections`) blocks merges when any trigger is at or above `6/6`.
5. **Update `docs/worker-infrastructure.md`** with the new trigger's purpose, expected steady-state connection usage, and rationale for the cadence.

## Why this matters

- Adding triggers without auditing inflates the Workers cron surface and increases the chance of one slot's failure mode interfering with another.
- The platform limit is per invocation, not per Worker, so every scheduled tick needs its own bounded fetch plan. The repo's stricter trigger-wide model prevents nested phases from producing queued or failed `fetch()` calls at the platform ceiling.
- Re-architecting batched dispatch (one trigger fanning out to many logical jobs via the slot plans in `shared/lib/scheduled-runner-registry.ts`) is the supported path past 20 cron expressions; bespoke new triggers should be the exception.

## Enforcement

- `npm run check:cron-connections` (canonical path: `scripts/ci/check-cron-connection-budget.ts`) — runs for Worker-impacting PRs; fails when any trigger is at or above `6/6`, a third `5/6` slot is introduced, or the reviewed fetch-capable-entry count grows.
- `npm run check:cron-sync` (canonical path: `scripts/ci/check-cron-schedule-sync.ts`) — keeps `worker/wrangler.toml` cron expressions aligned with `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts`, and rejects growth beyond the reviewed 34 physical triggers.
