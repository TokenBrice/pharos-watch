# 2026-04-19 DEWS/PSI Cron Decoupling Plan

## Assumptions

- `sync-dex-liquidity` should keep its existing `10,40 * * * *` cadence and connection-isolated sequencing.
- `compute-dews` and `stability-index` are DB-only jobs and can tolerate reading the previous DEX-liquidity snapshot when a fresh DEX run is delayed or killed.
- A dedicated `26,56 * * * *` trigger gives DEX-liquidity roughly sixteen minutes after its scheduled start to publish fresh inputs. That covers the current 13-minute `sync-dex-liquidity` app timeout plus a small logging/persistence margin while still keeping DEWS/PSI comfortably inside their 30-minute freshness budget.

## Research Findings

- Cloudflare Workers currently enforce CPU time per invocation. For Cron Triggers under one-hour intervals, the documented paid-plan CPU limit is 30 seconds unless raised by `limits.cpu_ms`; waiting on network I/O does not count as CPU, but parsing, scoring, and JSON processing do.
- The production 16:40 UTC half-hourly invocation completed, but Wrangler tail reported about 30,512 ms CPU time. That is at or slightly above the repo-configured `worker/wrangler.toml` `cpu_ms = 30000` budget.
- Earlier failed half-hourly rows showed `sync-stablecoin-charts` completed and `sync-dex-liquidity` acquired a lease, then no cron completion was logged. That pattern is consistent with platform termination before JS cleanup/error logging, not with the existing best-effort catch path.
- `worker/src/handlers/scheduled/half-hourly.ts` already continues when `sync-dex-liquidity` throws or returns an error. It cannot continue when the whole scheduled invocation is terminated by the platform.

## Implementation Plan

1. Add a new `dewsPsiOffset` cron schedule at `26,56 * * * *` in `shared/lib/cron-jobs.ts`, including bucket metadata.
2. Move `compute-dews` and `stability-index` job metadata from `halfHourlyOffset` to `dewsPsiOffset`, with a DB-only connection group.
3. Add a new scheduled runner module that runs `compute-dews` then `stability-index`.
4. Remove DEWS/PSI from `runHalfHourlySlot`, leaving `sync-stablecoin-charts -> sync-dex-liquidity`.
5. Register the new schedule in `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled.ts`, and `worker/wrangler.toml`.
6. Update scheduler tests to assert the DEX lane no longer runs DEWS/PSI and the new trigger does.
7. Update docs that encode trigger-slot counts and cron lane descriptions.

## Success Criteria

- `npm run check:cron-sync` passes.
- `npm run check:cron-connections` passes.
- Scheduler tests cover the new trigger and the decoupled half-hourly lane.
- DEWS/PSI can run even if the DEX-liquidity scheduled invocation is killed by CPU budget.
