# Cron Trigger Budget Policy

This policy governs the addition of new cron trigger expressions to `worker/wrangler.toml`.

## Current state

The worker declares **~19 cron expressions** in `worker/wrangler.toml`. Each expression maps to one Cloudflare scheduled-trigger invocation, dispatched in `worker/src/handlers/scheduled.ts` to the jobs configured for that slot in `shared/lib/scheduled-runner-registry.ts`.

Cloudflare Workers enforce a **6 concurrent `fetch()` connection** limit per cron trigger invocation. Every job dispatched within a single trigger slot competes for that shared pool. The constraint is documented in:

- `docs/worker-and-api-limits.md` — see "Connection-budget operating assumption"
- `docs/worker-infrastructure.md` — section "Cron triggers"

## Target

**Do not add a new cron trigger expression unless every existing 6-budget slot has been audited for headroom and rebalanced.**

The soft cap is **20 trigger expressions** before re-architecting batched dispatch. Adding the 20th trigger should prompt a design pass on whether the slot plans in `shared/lib/scheduled-runner-registry.ts` can fan out instead of growing the cron table.

## Process for new scheduled work

When proposing a new cron job:

1. **Audit existing slots.** Run `npm run check:cron-connections`. Each trigger reports `N/6 connections`. Identify slots at or below `4/6`.
2. **Fit into an existing trigger.** Map the new job into a slot plan in `shared/lib/scheduled-runner-registry.ts` to share an existing trigger that has headroom. Jobs sharing a slot must consume or cancel any fetch response bodies before opening more fetches; see `docs/worker-and-api-limits.md`.
3. **Only add a new cron expression if** every slot is at or above `5/6` and no rebalancing opportunity exists, or the new job is fetch-isolated in a way that cannot share a slot (e.g. dedicated rate-limit budget for blacklist sync, mint-burn, dex-discovery, telegram dispatch).
4. **Update `CRON_CONNECTION_BUDGET_ENTRIES`** in `shared/lib/cron-jobs.ts` to declare the new job's `maxConnections` and `connectionGroup`. The CI guardrail `scripts/ci/check-cron-connection-budget.ts` (invoked via `npm run check:cron-connections`) blocks merges when any trigger exceeds `6/6`.
5. **Update `docs/worker-infrastructure.md`** with the new trigger's purpose, expected steady-state connection usage, and rationale for the cadence.

## Why this matters

- Adding triggers without auditing inflates the Workers cron surface and increases the chance of one slot's failure mode interfering with another.
- The connection pool is per-invocation, not per-worker, so the constraint is enforced on every scheduled tick — slot starvation manifests as queued or failed `fetch()` calls, not as a worker-level alert.
- Re-architecting batched dispatch (one trigger fanning out to many logical jobs via the slot plans in `shared/lib/scheduled-runner-registry.ts`) is the supported path past 20 cron expressions; bespoke new triggers should be the exception.

## Enforcement

- `npm run check:cron-connections` (canonical path: `scripts/ci/check-cron-connection-budget.ts`) — runs in `validate:prebuild`; fails the build when any trigger is at or above `6/6`.
- `npm run check:cron-sync` (canonical path: `scripts/ci/check-cron-schedule-sync.ts`) — keeps `worker/wrangler.toml` cron expressions aligned with `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts`.
