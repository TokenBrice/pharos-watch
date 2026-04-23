## Homepage warning and dex-liquidity freshness investigation

Date: 2026-04-23

### Scope

- Trace the homepage warning `"Live refresh is running behind"` from UI -> API response -> worker freshness logic -> dex-liquidity producer cron jobs.
- Verify the current live incident against production D1 / public endpoints.

### Key findings

1. The homepage warning is driven by the shared data-health banner, not by dex-liquidity-specific advisory warnings.
   - `src/components/homepage-client.tsx` passes `dexLiquidity` into `StaleDataBanner`.
   - `src/components/stale-data-banner.tsx` -> `src/lib/data-health.ts` classifies health from `meta.status`.
   - `src/components/data-health-banner.tsx` shows `"Live refresh is running behind"` when the merged state is `degraded`.
   - Dex-liquidity uses the `dexLiquidity` preset in `src/lib/data-health-config.ts`, which points to `API_FRESHNESS_MAX_AGE_SEC.dexLiquidity = 3600` in `shared/lib/api-freshness.ts`.

2. The dex-liquidity endpoint does not emit body `_meta`; the frontend derives freshness from `X-Data-Age`.
   - `worker/src/api/dex-liquidity.ts` returns a plain map plus `addFreshnessHeaders(...)`.
   - `src/lib/api.ts` (`apiFetchWithMeta`) reads `X-Data-Age`, computes the freshness ratio, and marks the response `degraded` after `8x` max age and `stale` after `12x`.
   - Because `maxAgeSec = 3600`, the homepage degrades when dex-liquidity age exceeds 8 hours.

3. Live production state at 2026-04-23 12:49 UTC matches that path exactly.
   - `https://pharos.watch/_site-data/dex-liquidity` returned:
     - `X-Data-Age: 31134`
     - `Warning: 110 - "Response is stale (31134s old, max 3600s)"`
   - `https://pharos.watch/_site-data/health` still reported:
     - `caches["dex-liquidity"].ageSeconds = 30856`
     - `maxAge = 43200`
     - `healthy = true`
   - This is expected because public health uses the slower availability runway (`availabilityMaxAgeSec = 12h`) while the homepage uses the stricter endpoint runway (`endpointMaxAgeSec = 1h`, degraded after 8h).

4. The current incident is not caused by stale dex-discovery staging.
   - `sync-dex-discovery` is healthy and recent:
     - recent `cron_runs` rows are `ok`, including `2026-04-23 12:06:17 UTC`
     - `dex_pool_staging.MAX(refreshed_at) = 2026-04-23 12:15:54 UTC`
   - Discovery writes staged pools in `worker/src/cron/dex-discovery/persistence.ts`.
   - Scoring consumes staging through `mergeStagedPools(...)` in `worker/src/cron/dex-liquidity/staging-merge.ts`.
   - The homepage incident is isolated to the 30-minute scoring lane, not the 2-hour discovery lane.

5. The last completed dex-liquidity publish was `2026-04-23 04:10:17 UTC`.
   - `cron_runs` for `sync-dex-liquidity` show the last completed row:
     - `started_at = 1776917417`
     - `duration_ms = 199752`
     - `status = ok`
   - `dex_liquidity.MAX(updated_at)` and cache key `freshness:dex-liquidity.updated_at` both equal `1776917417`.
   - That is why the endpoint age and the status-cache age are both anchored to the same stale timestamp.

6. New half-hourly slots are still starting, but dex-liquidity is getting stuck or hard-killed after entry.
   - `sync-stablecoin-charts` continues to log `ok` every half hour in `worker/src/handlers/scheduled/half-hourly.ts`.
   - `cron_run_progress` currently shows:
     - `job = sync-dex-liquidity`
     - `started_at = 2026-04-23 12:40:08 UTC`
     - `stage = lease-acquired`
   - There is still no matching `cron_runs` completion row for that attempt.
   - The job-specific lease row exists, but its first heartbeat never advanced before observation.
   - This means the worker enters `syncDexLiquidity(...)` and then fails before `logCronRun(...)` can write success/error completion.

### Most plausible root-cause scenarios

1. Platform-level termination inside `syncDexLiquidity(...)` after the job starts.
   - Strongest fit for the current incident.
   - Why:
     - no `cron_runs` completion row after 04:10
     - `cron_run_progress` stops at `lease-acquired`
     - freshness sentinel never advances
     - the half-hourly slot still reaches and logs `sync-stablecoin-charts`
   - Code support:
     - `worker/src/handlers/scheduled/half-hourly.ts`
     - `worker/src/handlers/scheduled/context.ts`
     - `worker/src/lib/cron-logger.ts`
     - `worker/src/lib/cron-lease.ts`
     - `docs/worker-and-api-limits.md` explicitly calls out the risk of a platform-level dex-liquidity CPU kill.

2. A hang or non-yielding phase inside the dex-liquidity orchestrator, most likely after source fetches begin.
   - Current circuits show recent successes for DeFiLlama / Curve / direct DEX APIs, so the run likely gets past at least part of the fetch phase.
   - Plausible hot spots:
     - `fetchDataSources(...)` / `buildCurveLookups(...)` in `worker/src/cron/dex-liquidity/fetch-primary.ts`
     - `processPoolMetrics(...)`
     - `mergeStagedPools(...)`
     - `computeStablecoinScores(...)`
     - `analyzeDexLiquidityPostScoring(...)`
   - The orchestrator has no internal progress reporting, so any hard failure in these phases leaves only `lease-acquired` in `cron_run_progress`.

3. Secondary code-path risk: degraded persisted runs would still look stale on the homepage.
   - Not the current incident, because production D1 shows no writes after 04:10.
   - But `worker/src/api/dex-liquidity.ts` computes endpoint freshness from `getLatestSuccessfulCronTimestamp(db, "sync-dex-liquidity", latestRowUpdate)`.
   - If future runs persist rows but return `status = degraded`, the endpoint freshness can remain pinned to the last `ok` cron run even though `dex_liquidity.updated_at` moved forward.
   - Meanwhile status/health cache freshness can use the sentinel path in `worker/src/lib/api-freshness.ts`, so homepage freshness and status-cache freshness can diverge.

### Assumptions

- Times above are from direct production reads performed during this investigation on 2026-04-23 between roughly 12:44 and 12:49 UTC.
- I did not inspect live worker logs; conclusions about hard termination are inferred from D1 state transitions and the cleanup paths in code.
