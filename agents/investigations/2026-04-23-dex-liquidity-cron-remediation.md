# 2026-04-23 Dex Liquidity Cron Remediation

## Production Evidence

- `https://pharos.watch/_site-data/dex-liquidity` returned `Warning: 110` with `X-Data-Age` around 30k seconds on 2026-04-23.
- `https://api.pharos.watch/api/health` still reported `caches["dex-liquidity"]` as healthy because public health uses the slower 12-hour availability runway.
- Remote D1 showed `freshness:dex-liquidity` frozen at `2026-04-23 04:10:17 UTC`.
- Remote D1 showed no completed `cron_runs` rows for `sync-dex-liquidity` after `2026-04-23 04:10:17 UTC`.
- Remote D1 showed recent `cron_run_progress` for `sync-dex-liquidity` stuck at `stage = "lease-acquired"`.
- Remote D1 showed `halfHourlyOffset` slot rows stuck in `state = "running"` with heartbeat updates stopping after roughly 30-90 seconds.
- `sync-stablecoin-charts` continued to log `ok` on the same lane.

## Root Cause

The active incident is not stale discovery output and not a clean dex-liquidity failure path. The worker is starting `sync-dex-liquidity`, then dying before `logCronRun()` can write either success or error completion. The strongest inference is a platform-level termination mid-slot, most likely from exhausting the scheduled invocation's CPU budget inside the shared `10,40 * * * *` charts-plus-dex lane.

## Remediation

- Move `sync-stablecoin-charts` off the shared `10,40` lane.
- Keep `sync-dex-liquidity` on `10,40 * * * *`.
- Add a dedicated `16,46 * * * *` charts trigger.
- Update the shared cron registry, scheduled runner wiring, Wrangler triggers, tests, and matching docs.

## Expected Result

`sync-dex-liquidity` gets a full scheduled invocation budget again. If the hypothesis is correct, the next `10,40` run should write a fresh `cron_runs` row, advance `freshness:dex-liquidity`, clear the homepage warning after propagation, and remove the dex-liquidity freshness failure from the admin browser probe grid.
