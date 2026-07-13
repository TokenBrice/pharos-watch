# Cron Trigger Budget Policy

This policy governs the addition of new cron trigger expressions to `worker/wrangler.toml`.

## Current state

The worker declares **20 cron expressions** in `worker/wrangler.toml`. Each expression maps to one Cloudflare scheduled-trigger invocation, dispatched in `worker/src/handlers/scheduled.ts` to the jobs configured for that slot in `shared/lib/scheduled-runner-registry.ts`.

Cloudflare Workers enforce a limit of **6 simultaneous outbound requests waiting for response headers** per invocation. Pharos applies a conservative six-connection budget across every job dispatched within a trigger slot, even though Cloudflare releases the header-wait slot when headers arrive. The repo policy is documented in:

- `docs/worker-and-api-limits.md` — see "Connection-budget operating assumption"
- `docs/worker-infrastructure.md` — section "Cron Scheduling", subsection "Cron Slot Capacity and Connection Pool Budget"

## Target

**Do not add a new cron trigger expression unless every existing 6-budget slot has been audited for headroom and rebalanced.**

The soft cap is **20 trigger expressions** before re-architecting batched dispatch, and it is fully allocated. The 20th expression is the isolated five-minute reserve-recovery lane: sharing that recovery work with the affected reserve slot or an unrelated status lane would defeat its failure isolation. A 21st expression requires an ADR plus a trigger consolidation or rebalance plan.

## Process for new scheduled work

When proposing a new cron job:

1. **Audit existing slots.** Run `npm run check:cron-connections`. The checker derives each trigger's peak from `shared/lib/scheduled-runner-registry.ts`: serial chains use the max child budget, parallel chains are summed, and budget-only side work is modeled as a separate serial stage. Identify slots at or below `4/6`.
2. **Fit into an existing trigger.** Map the new job into a slot plan in `shared/lib/scheduled-runner-registry.ts` to share an existing trigger that has headroom. Jobs sharing a slot must consume or cancel any fetch response bodies before opening more fetches; see `docs/worker-and-api-limits.md`.
3. **Only add a new cron expression if** every slot is at or above `5/6` and no rebalancing opportunity exists, or the new job is fetch-isolated in a way that cannot share a slot (e.g. dedicated rate-limit budget for blacklist sync, mint-burn, dex-discovery, telegram dispatch).
4. **Update `CRON_CONNECTION_BUDGET_ENTRIES`** in `shared/lib/cron-jobs.ts` to declare the new job's `maxConnections` and `connectionGroup`. `connectionGroup` documents serial sharing within a chain, but it does not reduce the peak across independent parallel chains. The CI guardrail `scripts/ci/check-cron-connection-budget.ts` (invoked via `npm run check:cron-connections`) blocks merges when any trigger is at or above `6/6`.
5. **Update `docs/worker-infrastructure.md`** with the new trigger's purpose, expected steady-state connection usage, and rationale for the cadence.

## Why this matters

- Adding triggers without auditing inflates the Workers cron surface and increases the chance of one slot's failure mode interfering with another.
- The platform limit is per invocation, not per Worker, so every scheduled tick needs its own bounded fetch plan. The repo's stricter trigger-wide model prevents nested phases from producing queued or failed `fetch()` calls at the platform ceiling.
- Re-architecting batched dispatch (one trigger fanning out to many logical jobs via the slot plans in `shared/lib/scheduled-runner-registry.ts`) is the supported path past 20 cron expressions; bespoke new triggers should be the exception.

## Enforcement

- `npm run check:cron-connections` (canonical path: `scripts/ci/check-cron-connection-budget.ts`) — runs in `validate:prebuild`; fails the build when any trigger is at or above `6/6`.
- `npm run check:cron-sync` (canonical path: `scripts/ci/check-cron-schedule-sync.ts`) — keeps `worker/wrangler.toml` cron expressions aligned with `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts`.
