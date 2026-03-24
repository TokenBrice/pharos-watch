# DEWS stale investigation

Date: 2026-03-23

## Findings

- `GET https://api.pharos.watch/api/health` reported `caches.dews.ageSeconds = 3288`, `maxAge = 1800`, `healthy = false` at `2026-03-23T12:38:52Z`
- That ratio is `1.83x`, which is `degraded` by the shared thresholds (`>1.5x degraded`, `>2.0x stale`)
- The public status UI was rendering that degraded lane as `stale` because it treated `healthy=false` as equivalent to stale inside:
  - `src/components/status/cache-freshness-table.tsx`
  - `src/app/status/client.tsx`

## Runtime state

- Latest successful `compute-dews` run in production was slot `2026-03-23T11:40:00Z`
- Latest `stress_signals.computed_at` was `2026-03-23T11:44:04Z` with 143 rows written
- The next `halfHourlyOffset` slot (`2026-03-23T12:10:00Z`) did start, but `cron_slot_executions` was left in `running` with last heartbeat `2026-03-23T12:13:19Z`
- Only `sync-stablecoin-charts` logged for that slot; `sync-dex-liquidity` never wrote a `cron_runs` row, so the invocation died between charts completion and downstream half-hourly jobs

## Action taken

- Fixed the public cache-status classification so degraded cache ratios stay degraded unless the ratio or source status is actually stale
- Added a regression test for the `1.5x < ratio <= 2.0x` case
