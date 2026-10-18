# Cron Trigger Budget Policy

This policy governs the union of cron trigger expressions in `worker/wrangler.toml` and `worker/wrangler.heavy.toml`.

## Source Of Truth

The two Wrangler configs jointly own deployed cron expressions. Each expression occurs exactly once under its public/heavy owner in `shared/lib/scheduled-runner-registry.ts` and maps to one Cloudflare scheduled invocation dispatched through `worker/src/handlers/scheduled.ts`. `shared/lib/cron-jobs.ts` remains the logical/physical schedule authority. Run `npm run check:cron-sync` and `npm run check:cron-connections` for the aggregate inventory and capacity report.

Every logical lane in `CRON_SCHEDULE_DEFINITIONS` must explicitly declare `cpuPlacement` (no default): `hourly-physical-required` or `sub-hourly-allowed`. The former requires every physical alias to be a single-minute hourly `M * * * *` expression; the latter permits the lane's existing physical form. These declarations encode the existing reviewed classification, not a new workload assessment; changing placement requires measured workload review by the Worker operations owner. The registry-iterating assertion in `shared/lib/__tests__/cron-jobs.test.ts` checks every required-hourly lane, including newly added lanes, rather than maintaining a separate hand list.

The platform header-wait limit and Pharos's stricter trigger-wide budget are owned by [Worker and API Limits: Connection-budget operating assumption](../worker-and-api-limits.md#connection-budget-operating-assumption). Per-slot measurement and enforcement are in [Worker Infrastructure Appendix: Cron Slot Capacity and Connection Pool Budget](worker-infrastructure-appendix.md#cron-slot-capacity-and-connection-pool-budget).

## Target

**Do not add a new cron trigger expression unless every existing 6-budget slot has been audited for headroom and rebalanced.**

`CRON_GROWTH_HEADROOM_POLICY` and [ADR-10](../architecture.md#adr-10) own growth ceilings. Added logical work, fetch surface or connection pressure requires a follow-up ADR and consolidation/rebalance plan. Accounting/alias-only changes that add none of those require a note on the source policy, not a second narrative here. Failure-isolated recovery must remain independent of the invocation it recovers.

### Current growth gate

Physical expressions, deduplicated fetch-capable entries and headroom-full (`5/6`) slots each have source-owned ceilings. A ceiling edit is policy change, not routine schedule work. The public/heavy union is the accounting boundary, never a separate allowance per script.

[ADR-22](../architecture.md#adr-22) and [ADR-23](../architecture.md#adr-23) own graph/CPU-placement decisions: abandonment alone does not prove CPU exhaustion; covered analytics reported memory-limit outcomes. [ADR-38](../architecture.md#adr-38) owns role redistribution without added work. [ADR-39](../architecture.md#adr-39) owns supplemental measured-execution capacity; [the capacity contract](worker-infrastructure-appendix.md#measured-execution-capacity-expansion) retains shared lease/cursor, rollback and production acceptance. None creates headroom in existing `5/6` DEX slots.


A sub-hourly logical cadence carrying heavy CPU work must use the paired-hourly physical form: one hourly `M * * * *` alias per logical offset, with the logical schedule and slot identity retained in `shared/lib/cron-jobs.ts`. Splitting an existing comma expression into hourly aliases is a topology rebalance of existing logical work, not new scheduled work. This qualifies the invocation for Cloudflare's hourly Cron CPU class without increasing logical cadence, fetch surface, or connection pressure; see the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). A lane killed by the sub-hourly 30-second CPU class surfaces as scheduled-slot abandonment; see [`docs/runbooks/cron-slot-abandonment.md`](../runbooks/cron-slot-abandonment.md).

Before adding fetch-heavy scheduled work, the Worker operations owner is the required reviewer and must review the measured workload before one of these consolidation/rebalance paths is executed:

1. Preserve the active/shadow measured-execution surfaces. A bounded native collector may share the active measured-execution trigger (physical aliases `5 * * * *` and `35 * * * *`, logical `0,30 * * * *` slots) only as a serialized phase with a proven unchanged connection peak and a producer runtime below the slot fence; broad diagnostic fan-out remains daily.
2. Reduce `sync-dex-liquidity-stage` from `5/6` to `4/6` by serializing the nested provider fan-out or moving a bounded source partition to a slot with proven headroom; preserve the hourly `:10` source cadence and re-run the topology checks.
3. If that path does not preserve required freshness, move the bounded unit of work to Cloudflare Queues or Workflows rather than adding another fetch-heavy cron surface.

The same owner must explicitly consider Queues/Workflows when a proposed workload has measured p95 duration of **10 minutes or more**, fan-out of **1,000 units per run or more**, or static connection pressure of **5/6**. Record the measured duration, fan-out, and connection-budget report in the PR; a threshold crossing requires a decision and rationale, not an automatic migration.

## Process for new scheduled work

When proposing a new cron job:

For a simple job joining an existing lane, follow the generated checklist/topology in [Worker Infrastructure](../worker-infrastructure.md#scheduled-task-topology). Its four production authorities are the job implementation, existing lane handler, `shared/lib/cron-jobs.ts` metadata and the existing slot input in `shared/lib/scheduled-runner-registry.ts`. The descriptor supplies timeout/lease/due defaults; exceptional policies belong beside that slot's chains, not in separate Worker override maps. Tests, owning prose and generated output are evidence, not additional runtime authorities. New lanes/expressions still require the full review below.

1. **Audit existing slots.** Run `npm run check:cron-connections`. The checker derives each trigger's peak from `shared/lib/scheduled-runner-registry.ts`: serial chains use the max child budget, parallel chains are summed, and budget-only side work is modeled as a separate serial stage. The CLI prints only headroom-full (`5/6`) and failing triggers plus a summary count, so read `evaluateCronConnectionBudget()`'s `triggerReports` when you need each slot's individual peak and the slots at or below `4/6`.
2. **Fit into an existing trigger.** Map the new job into a slot plan in `shared/lib/scheduled-runner-registry.ts` to share an existing trigger that has headroom. Jobs sharing a slot must consume or cancel any fetch response bodies before opening more fetches; see `docs/worker-and-api-limits.md`.
   For a new logical lane, explicitly choose `cpuPlacement` in `CRON_SCHEDULE_DEFINITIONS` using the measured CPU workload; a lane marked `hourly-physical-required` must use only single-minute hourly physical aliases. Preserve existing placement declarations unless a measured owner review approves reclassification. Update deployed expressions in the owning config, `worker/wrangler.toml` or `worker/wrangler.heavy.toml`, and review their combined inventory.
3. **Only add a new cron expression after** the current growth gate has been re-reviewed and the consolidation/rebalance path above is complete. A fetch-isolated job still documents why it cannot share a slot (e.g. dedicated rate-limit budget for blacklist sync, mint-burn, dex-discovery, telegram dispatch).
4. **Update `CRON_CONNECTION_BUDGET_ENTRIES`** in `shared/lib/cron-jobs.ts` to declare the new job's `maxConnections`, `connectionGroup`, and exact `scheduleKey`. A budget row does not follow a job across schedule identities: moving a job requires moving its budget row in the same change. `connectionGroup` documents serial sharing within a chain, but it does not reduce the peak across independent parallel chains. The CI guardrail `scripts/ci/check-cron-connection-budget.ts` (invoked via `npm run check:cron-connections`) blocks merges when any trigger is at or above `6/6`.
5. **Update `docs/worker-infrastructure.md`** with the new trigger's purpose, expected steady-state connection usage, and rationale for the cadence.

## Why this matters

- Adding triggers without auditing inflates the Workers cron surface and increases the chance of one slot's failure mode interfering with another.
- The platform limit is per invocation, not per Worker, so every scheduled tick needs its own bounded fetch plan. The repo's stricter trigger-wide model prevents nested phases from producing queued or failed `fetch()` calls at the platform ceiling.
- Re-architecting batched dispatch (one trigger fanning out to many logical jobs via the slot plans in `shared/lib/scheduled-runner-registry.ts`) is the supported path once any `CRON_GROWTH_HEADROOM_POLICY` gate is reached; bespoke new triggers should be the exception.

## Enforcement

- `npm run check:cron-connections` (`scripts/ci/check-cron-connection-budget.ts`) — runs for Worker-impacting PRs; rejects missing/stale schedule-bound budget rows, triggers at or above `6/6`, and counts above `CRON_GROWTH_HEADROOM_POLICY`'s fetch-capable-job or headroom-full-slot ceilings.
- `npm run check:cron-sync` (canonical path: `scripts/ci/check-cron-schedule-sync.ts`) — keeps the duplicate-free union of both Wrangler configs aligned with `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts`, rejects omitted, duplicate or misowned expressions, and enforces the unchanged aggregate physical-trigger gate in `CRON_GROWTH_HEADROOM_POLICY`.
- `shared/lib/__tests__/cron-jobs.test.ts` — asserts an explicit `cpuPlacement` on every logical schedule and single-minute hourly physical aliases for every `hourly-physical-required` lane; placement reclassification still requires measured owner review.

## Workflow and Queue Review Outcome (ADR-26)

[ADR-26](../architecture.md#adr-26) owns the six-invariant parity gate: slot identity/takeover, bounded wall clock, six-fetch retry behavior, replay-safe D1, terminal/status oracle and cost. Workflow IDs, automatic retries and restarts do not supply D1 fencing, exactly-once writes or cron accounting. [Historical evidence and lane parity matrix](adr-26-workflows-measurements.md#parity-answers-and-lane-decisions) are not new deployment authorization.

The [operator sunset record](worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot) alone owns V9 experiment retirement status, rollback floor and pending observation/cleanup. Canonical cron publication remains authoritative; no expression or fence is freed.

### Conditional expression-retirement table

The former dated 41-expression proposal is deliberately **git-only history**, not copied into current policy or claimed to exist in an ADR. It authorizes no current removal. Any future Queue/Workflow/DDR/DEX proposal needs separately approved current capacity, heap and replay evidence, unchanged logical slot identity, updated shared schedule metadata, and passing cron-sync/connection gates. Live reserves remains Cron-native.
