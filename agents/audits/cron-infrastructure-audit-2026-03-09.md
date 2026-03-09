# Pharos Cron Infrastructure Audit

Date: March 9, 2026

Scope: full audit of Worker scheduled execution in `worker/src/handlers/scheduled.ts`, all named cron jobs, their runtime parameters, D1 write behavior, cross-job dependencies, lease/timeout behavior, and observed runtime outcomes.

Observed window: March 9, 2026, 20:58 UTC through 21:20 UTC.

## Method

I audited the scheduler and every cron entrypoint in code, then ran the jobs against an isolated local Worker + isolated local D1 state:

- Worker: `wrangler dev --test-scheduled`
- DB: seeded copy of the local D1 SQLite, then migrated to current schema
- Trigger style: compressed consecutive manual scheduled triggers to force multiple observations per job name and to stress idempotency/lease behavior harder than the production cadence

Important caveats:

- This was a local runtime audit, not a production-tail audit.
- The local `.dev.vars` used for the run did not include `ANTHROPIC_API_KEY`, so `daily-digest` correctly skipped generation in this environment.
- `sync-blacklist` never emitted a terminal `cron_runs` row during the longest observed clean invocation before I froze the environment, but it did mutate `blacklist_events` and `blacklist_sync_state` live. I include those partial-write observations below because they are operationally important.

## Executive Summary

The cron system has a solid top-level structure: 4 trigger slots, clear dependency chaining where it matters, lease fencing, per-job wall-clock timeouts, compare-and-swap cache writes, and reasonable cache-fresh skips on daily jobs. The 15-minute slot is well orchestrated and correctly serialized to respect the shared Workers fetch pool. The 30-minute slot also behaves predictably once DEX liquidity succeeds. The daily slot is highly idempotent.

The main reliability gaps are not in the schedule shape. They are in runtime integrity and observability:

1. `sync-stablecoins` degraded on every observed run because depeg detection threw a runtime `ReferenceError`.
2. `status-self-check` degraded on every observed run because one critical API route (`/api/peg-summary`) threw at runtime and three cache-backed routes returned `503` while their backing caches were absent.
3. `sync-mint-burn` is under-provisioned relative to its config set. It only processed 1-2 of 84 enabled configs per run and escalated from `ok` to `degraded` to `error`.
4. `sync-yield-data` writes tables but suppresses the public `yield-rankings` cache whenever safety-score coverage is incomplete. In this audit, that left fresh yield rows in D1 but no cache for the API.
5. The 20-minute slot exposes a real observability hole: long-running jobs mutate final tables before they log `cron_runs`, so partial state can be live in D1 with no terminal cron record.
6. `dispatch-telegram-alerts-daily` is a real runtime job but is not part of `CRON_INTERVALS`, so `/api/status` does not track it as a first-class cron.

## Scheduler Inventory

### Trigger map

| Slot | Expression | Execution model | Jobs |
|---|---|---|---|
| Quarter-hourly | `*/15 * * * *` | Sequential in one async chain | `sync-stablecoins` -> conditional `snapshot-supply` retry -> `sync-stablecoin-charts` -> `sync-fx-rates` -> conditional `stability-index` -> conditional `compute-dews` -> `status-self-check` -> conditional `dispatch-telegram-alerts` |
| 20-minute offset | `3,23,43 * * * *` | Parallel `ctx.waitUntil(...)` jobs | `sync-blacklist`, `sync-mint-burn`, `sync-dex-discovery` |
| Half-hourly offset | `10,40 * * * *` | Hard chain | `sync-dex-liquidity` -> `sync-yield-data` |
| Daily 08:00 UTC | `0 8 * * *` | Mixed parallel + promise chaining | `snapshot-supply`, `snapshot-safety-grade-history` -> `dispatch-telegram-alerts-daily`, `fetch-tbill-rate`, `snapshot-psi` -> `daily-digest`, `sync-usds-status`, `sync-bluechip` |

### Lease and timeout infrastructure

Source: `worker/src/lib/db.ts`

- All scheduled jobs run through `runCronWithLease(...)` + `logCronRun(...)`.
- Default timeout: 5 minutes.
- Custom timeouts:
  - `sync-dex-liquidity`: 13 minutes
  - `sync-dex-discovery`: 14 minutes
  - `sync-blacklist`: 8 minutes
  - `sync-mint-burn`: 8 minutes
  - `daily-digest`: 8 minutes
- Lease TTL defaults to `job timeout + 60s`.
- A lock miss is recorded as `status='skipped_locked'`.

### Status tracking blind spot

`worker/src/lib/cron-schedule.ts` tracks 19 jobs in `CRON_INTERVALS`, but runtime actually executes 20 job names because `dispatch-telegram-alerts-daily` is only launched from `worker/src/handlers/scheduled.ts`.

Impact:

- `/api/status` and cron health cards do not treat `dispatch-telegram-alerts-daily` as a tracked cron.
- A daily Telegram dispatch regression can be invisible in the status surface even while `cron_runs` contains rows for it.

## Job-by-Job Parameters and Writes

### Quarter-hourly slot

| Job | Timeout | Inputs / gates | Main writes |
|---|---|---|---|
| `sync-stablecoins` | 5m | DefiLlama stablecoins API, CG supplementals, dual-primary price validation, CMC fallback, DefiLlama circuit breaker, optional `CMC_API_KEY` | `cache.stablecoins`, `cache.stablecoins:invalid-last`, `price_cache`, `depeg_events`, `depeg_pending` |
| `snapshot-supply` retry | 5m | Only runs when `sync-stablecoins` returns `downstreamSafe=true` | `supply_history` |
| `sync-stablecoin-charts` | 5m | DefiLlama charts API + cached FX rates | `cache.stablecoin-charts` |
| `sync-fx-rates` | 5m | Frankfurter, Fawaz Ahmed FX API, gold-api.com, cached prior rates | `cache.fx-rates` |
| `stability-index` | 5m | Strict stablecoins cache + active `depeg_events` + latest `stress_signals` | `stability_index_samples` |
| `compute-dews` | 5m | Strict stablecoins cache + `dex_liquidity`, `dex_prices`, `dex_liquidity_history`, `blacklist_events`, `stress_signals`, `mint_burn_hourly`, yield warnings | `stress_signals`, `stress_signal_history` |
| `status-self-check` | 5m | Internal router probes by default, `SELF_URL`/`ADMIN_KEY` optional | `status_probe_runs`, `status_state`, `status_transitions`, `status_discrepancy_state` |
| `dispatch-telegram-alerts` | 5m | Telegram circuit breaker + `TELEGRAM_BOT_TOKEN` + latest DEWS/depeg/safety snapshots | cache keys `alert:dews-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot`; may update `telegram_subscribers` |

### 20-minute slot

| Job | Timeout | Inputs / gates | Main writes |
|---|---|---|---|
| `sync-blacklist` | 8m wrapper, 7m internal runtime budget | Etherscan circuit breaker, Etherscan key optional, TronGrid optional, dRPC optional, shared 900-subrequest budget | `blacklist_events`, `blacklist_sync_state` |
| `sync-mint-burn` | 8m | Alchemy circuit breaker, `ALCHEMY_API_KEY` required, Ethereum-only configs, `MINT_BURN_DISABLED_IDS`, `MINT_BURN_DISABLED_SYMBOLS`, 200-request budget, 50k block scan windows | `mint_burn_events`, `mint_burn_hourly`, `mint_burn_sync_state`, `mint_burn_run_state` |
| `sync-dex-discovery` | 14m | Optional `COINGECKO_API_KEY`, tiered coverage based on `dex_liquidity`, per-coin backoff | `dex_pool_staging`, `dex_discovery_meta` |

### Half-hourly slot

| Job | Timeout | Inputs / gates | Main writes |
|---|---|---|---|
| `sync-dex-liquidity` | 13m | DefiLlama yields + protocols, Curve API, Uniswap V3/Aerodrome subgraphs, staged pool merge | `dex_liquidity`, `dex_liquidity_history`, `dex_prices` |
| `sync-yield-data` | 5m | Runs only after successful `sync-dex-liquidity`; uses T-bill cache, DeFiLlama yields, on-chain rates, safety snapshot | `yield_data`, `yield_history`, optionally `cache.yield-rankings`, optionally `cache.report_card_cache` |

### Daily slot

| Job | Timeout | Inputs / gates | Main writes |
|---|---|---|---|
| `snapshot-supply` | 5m | Requires fresh `stablecoins` cache | `supply_history` |
| `snapshot-safety-grade-history` | 5m | Uses live report-card snapshot builder | `safety_grade_history` |
| `dispatch-telegram-alerts-daily` | 5m | Chained after safety snapshot | alert snapshot cache keys, optional `telegram_subscribers` updates |
| `snapshot-psi` | 5m | Reads yesterday’s `stability_index_samples` | `stability_index` |
| `sync-usds-status` | 5m | Etherscan V2, 20h freshness gate | `cache.usds-status` |
| `sync-bluechip` | 5m | Bluechip backend, 6h freshness gate | `cache.bluechip-ratings` |
| `fetch-tbill-rate` | 5m | FRED CSV + treasury circuit breaker | `cache.risk_free_rate`, circuit state |
| `daily-digest` | 8m | Chained after `snapshot-psi`, requires `ANTHROPIC_API_KEY` to actually generate | `daily_digest`, optional Twitter/Telegram side effects |

## Observed Runtime Results

### Quarter-hourly: 3 consecutive runs

Observed runs:

| Run | UTC start | Result pattern |
|---|---|---|
| 1 | 21:01:22 UTC | `sync-stablecoins` degraded, all downstream jobs still ran, `status-self-check` degraded |
| 2 | 21:01:36 UTC | same |
| 3 | 21:01:43 UTC | same |

Stable facts across all 3 runs:

- `sync-stablecoins` degraded every time, but still returned `downstreamSafe=true`.
- `snapshot-supply` retry ran every time and wrote 153 rows each time.
- `compute-dews` wrote 137 rows each time.
- `status-self-check` degraded every time with `failCount=4`.
- `dispatch-telegram-alerts` no-op’ed cleanly and wrote zero messages.

### Half-hourly: 3 consecutive successful slot runs

Observed runs:

| Run | UTC start | `sync-dex-liquidity` | `sync-yield-data` |
|---|---|---|---|
| 1 | 21:10:47 UTC | `ok`, 7.211s | `degraded`, 0.591s |
| 2 | 21:11:20 UTC | `ok`, 6.788s | `degraded`, 0.447s |
| 3 | 21:11:30 UTC | `ok`, 5.001s | `degraded`, 0.332s |

Observed data:

- `sync-dex-liquidity` stabilized at 123 scored coins plus 1 `__global__` row.
- It consistently merged 166 staged pools and skipped 71 staged pools.
- It produced 62 `dex_prices` rows.
- `sync-yield-data` consistently wrote 41 `yield_data` rows and 111 cumulative `yield_history` rows, but skipped the public rankings cache every time.

### Daily 08:00 slot: 3 consecutive runs

Observed runs:

| Run | UTC start | Pattern |
|---|---|---|
| 1 | 21:16:01 UTC | first real write run: `snapshot-supply` 153 rows, `snapshot-safety-grade-history` seeded 156 rows, `sync-usds-status` wrote 1 cache entry, `sync-bluechip` fetched 17 ratings, `fetch-tbill-rate` took 17.5s and succeeded |
| 2 | 21:16:21 UTC | cache-fresh / idempotent fast path |
| 3 | 21:16:24 UTC | same as run 2 |

Important details:

- `snapshot-psi` returned `ok` but actually skipped all 3 times because there were no samples for yesterday.
- `daily-digest` returned `ok` but skipped all 3 times because no Anthropic key existed in this local environment.
- `dispatch-telegram-alerts-daily` ran and no-op’ed cleanly all 3 times.

### 20-minute slot: observed behavior across compressed and clean reruns

This slot was the hardest to observe cleanly because `sync-blacklist` remained live far longer than the other two jobs.

Compressed reruns:

- One compressed run produced no `cron_runs` rows within 300s but did create live leases and mutate tables.
- The next two compressed reruns immediately produced `skipped_locked` rows for the same job names.

Clean reruns:

| Observation | UTC start | What completed |
|---|---|---|
| Clean run 1 | 21:11:46 UTC | `sync-mint-burn` `ok` in 36.960s, `sync-dex-discovery` `ok` in 123.024s, `sync-blacklist` still held lease after 240s and never emitted a terminal `cron_runs` row before environment freeze |
| Clean run 2 | 21:17:32 UTC | `sync-blacklist` `skipped_locked`, `sync-mint-burn` `degraded` in 36.474s, `sync-dex-discovery` stayed locked/live past the 180s observation window |
| Clean run 3 | 21:20:34 UTC | `sync-blacklist` `skipped_locked`, `sync-dex-discovery` `skipped_locked`, `sync-mint-burn` escalated to `error` in 16.366s |

What still changed in D1 despite the missing final blacklist row:

- `blacklist_events`: 630 rows
- `blacklist_sync_state`: 1 row
- All 630 observed blacklist events were for USDC on Ethereum
- `dex_pool_staging`: 651 rows by audit freeze
- `dex_discovery_meta`: 94 rows by audit freeze

This means the 20-minute slot can materially mutate final tables before it has emitted terminal `cron_runs` observability.

## Key Findings

### 1. `sync-stablecoins` is deterministically degraded every 15 minutes

Evidence:

- Runs 31, 39, 47 all returned `status='degraded'`.
- All 3 runs recorded the same depeg error:
  - `depegErrors=["detection: ReferenceError: metaById is not defined"]`
- Log output also showed:
  - `[sync-stablecoins] Depeg detection failed: ReferenceError: metaById is not defined`

Impact:

- `depeg_events` and `depeg_pending` are not trustworthy on the live 15-minute path.
- PSI and Telegram alerts still run because `downstreamSafe=true`, so downstream jobs are consuming a cache that looks fresh even while depeg detection is broken.

Code paths:

- `worker/src/cron/sync-stablecoins.ts:651-709`
- `worker/src/cron/detect-depegs.ts`

Suggested fix:

1. Fix the runtime error first.
2. Change `sync-stablecoins` degraded semantics so a depeg-detection failure sets a separate `downstreamDepegUnsafe=true`.
3. Gate `stability-index`, `dispatch-telegram-alerts`, and any depeg-dependent downstream consumer on that narrower flag instead of only `downstreamSafe`.
4. Add a compiled-worker scheduled smoke test that actually executes `detectDepegEvents(...)` through the built Worker bundle, not just unit tests.

### 2. `status-self-check` is correctly catching real regressions, but one of them is a hard runtime failure

Evidence:

- Runs 37, 45, 53 all returned `status='degraded'`.
- `status_probe_runs` recorded the same 4 failing endpoints every time:
  - `/api/peg-summary` -> `500`
  - `/api/usds-status` -> `503`
  - `/api/bluechip-ratings` -> `503`
  - `/api/yield-rankings` -> `503`
- Worker logs showed a real runtime error for `/api/peg-summary`:
  - `ReferenceError: TRACKED_STABLECOINS is not defined`

Impact:

- The self-check path is doing its job; the issue is that the platform is genuinely unhealthy from the probe’s perspective.
- `yield-rankings` is unavailable because `sync-yield-data` never writes the cache.
- `usds-status` and `bluechip-ratings` were `503` during cold-state quarter-hourly probes because their daily caches had not yet been populated.

Code paths:

- `worker/src/cron/status-self-check.ts:231-381`
- `worker/src/api/peg-summary.ts:156`

Suggested fix:

1. Fix `/api/peg-summary` immediately.
2. Split self-check failures into:
   - hard route failures (`500`)
   - freshness unavailability (`503` due missing cache)
3. Keep the overall cron degraded, but emit more actionable metadata so runtime exceptions are separated from expected bootstrap/cold-cache misses.

### 3. `sync-mint-burn` is under-provisioned relative to its configuration set

Evidence:

- It has 84 enabled configs.
- Observed runs processed only 1-2 configs per run:
  - run 68: `contractsProcessed=2`, `contractsSkipped=82`
  - run 95: `contractsProcessed=1`, `contractsSkipped=83`
  - run 98: `contractsProcessed=1`, `contractsSkipped=83`
- Critical coverage stayed at `1/7 = 14.29%`.
- Backlog remained massive:
  - `laggingConfigs` were still 2.7M-2.9M blocks behind on top configs.
- Status progression:
  - row 68 -> `ok` with `degradedStreak=1`
  - row 95 -> `degraded` with `degradedStreak=2`
  - row 98 -> `error` with `degradedStreak=3`

Impact:

- The mint/burn system cannot realistically keep the majority of tracked configs current at the present budget and scan shape.
- The run-state streak logic is working, but it is escalating a structural capacity problem, not just intermittent API noise.

Code paths:

- `worker/src/cron/sync-mint-burn.ts:40-46`
- `worker/src/cron/sync-mint-burn.ts:224-308`
- `worker/src/cron/sync-mint-burn.ts:669-755`

Suggested fix:

1. Stop treating 84 configs as a single homogeneous round-robin workload.
2. Split critical contracts into a dedicated faster lane and extended contracts into a slower lane or separate cron family.
3. Persist and expose per-config lag SLOs, then force each run to satisfy a minimum number of critical configs before any extended work.
4. Revisit `GLOBAL_BUDGET_LIMIT=200` and `MAX_SCAN_RANGE=50_000`; the current combination is too small for the live backlog.
5. Consider per-config continuation cursors plus deterministic batch partitioning so “one heavy coin consumed the run” is impossible.

### 4. `sync-yield-data` updates tables but withholds the public cache

Evidence:

- Runs 63, 65, 67 all returned `status='degraded'`.
- Each run wrote 41 `yield_data` rows.
- Each run reported:
  - `fallbackMode="safety-snapshot-coverage"`
  - `cacheWriteSkipped=true`
  - `safetyScoresComputed=16`
  - `safetyScoresExpected=156`
- Final D1 state:
  - `yield_data`: 41 rows
  - `yield_history`: 111 rows
  - `cache.yield-rankings`: absent

Impact:

- Backing data is fresh but the API cache is absent, so `/api/yield-rankings` remains unavailable.
- This is an orchestration problem, not an upstream-yield problem.

Code paths:

- `worker/src/cron/sync-yield-data.ts:58-89`
- `worker/src/cron/sync-yield-data.ts:422-465`
- `worker/src/lib/safety-scores.ts`

Suggested fix:

1. Decouple cache publication from full safety-score completeness.
2. Write `yield-rankings` even when safety coverage is partial:
   - keep stale-or-null safety fields per coin
   - add a top-level degraded reason
3. If `report_card_cache` is a prerequisite for broad safety coverage, produce that cache in its own cron or refresh it before yield runs.

### 5. The 20-minute slot mutates final tables before terminal cron observability exists

Evidence:

- During the first compressed 20-minute observation, no terminal `cron_runs` rows appeared within 300s.
- Despite that, by the end of the audit the same job family had already written:
  - `blacklist_events`: 630 rows
  - `blacklist_sync_state`: 1 row
  - `dex_pool_staging`: 651 rows
  - `dex_discovery_meta`: 94 rows
- `sync-blacklist` and `sync-dex-discovery` were still present in `cron_leases` when I froze the environment, but there was no terminal `cron_runs` row for the in-flight blacklist invocation.

Impact:

- A job can partially mutate live data, then stall or die, without leaving a final cron record.
- Operators can see changed data but no matching cron completion.
- Retrying the slot can produce `skipped_locked` rows even while the original in-flight job’s effects are already visible.

Code paths:

- `worker/src/handlers/scheduled.ts:207-295`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`

Suggested fix:

1. Add start-row observability:
   - create/update a `cron_run_progress` or “started” row at job start
   - update percent/progress checkpoints during long jobs
2. For D1-heavy long jobs, prefer staging tables plus final swap/commit rather than direct writes to final tables during the crawl.
3. Sequence the 20-minute slot’s three D1-heavy writers or split them into separate schedules if D1 write pressure is a recurring issue.

### 6. `dispatch-telegram-alerts-daily` is a real job but not a first-class status job

Evidence:

- Daily runs 74, 84, 92 show `dispatch-telegram-alerts-daily` executing and returning `ok`.
- `worker/src/lib/cron-schedule.ts` does not define it in `CRON_INTERVALS`.
- `/api/status` only queries jobs present in `CRON_INTERVALS`.

Impact:

- The daily alert dispatcher is invisible to health dashboards and freshness expectations.

Suggested fix:

1. Add `dispatch-telegram-alerts-daily` to `CRON_INTERVALS`.
2. Group it under the daily slot on `/status`.
3. Decide whether it should be health-impacting or warning-only, but make the policy explicit.

### 7. The 30-minute slot has a hard failure edge: if DEX liquidity fails, yield does not run at all

Evidence:

- Earlier compressed observation row 61 recorded `sync-dex-liquidity status='error'`.
- No paired `sync-yield-data` row existed for that failed half-hourly invocation.
- The scheduler uses `dexSync.then(() => runLeasedCron("sync-yield-data", ...))`, so a rejected DEX sync prevents yield execution entirely.

Impact:

- A transient DEX-liquidity outage can suppress the yield pipeline, even if the last known liquidity state would have been sufficient for a degraded yield refresh.

Code path:

- `worker/src/handlers/scheduled.ts:300-305`

Suggested fix:

1. Run yield off the latest successful `dex_liquidity` snapshot when the current DEX sync fails.
2. Mark that yield run `degraded` and stamp metadata with `fallbackMode="stale-dex-liquidity"`.

## Strengths

- The 15-minute slot’s sequential orchestration is correct. It prevents fetch-pool spikes and preserves deterministic downstream ordering.
- Cache-fresh skip patterns on daily jobs work well:
  - `sync-usds-status` and `sync-bluechip` dropped to 8-9ms on reruns.
- `sync-dex-liquidity` stabilized nicely across 3 consecutive successful runs.
- Daily snapshot jobs are idempotent.
- Lease fencing does prevent duplicate work during compressed reruns.

## Prioritized Fix Plan

### P0

1. Fix the two runtime regressions:
   - `sync-stablecoins` / depeg detection runtime error
   - `/api/peg-summary` runtime error
2. Add a compiled scheduled smoke test in CI that executes:
   - quarter-hourly slot once
   - half-hourly slot once
   - representative route probes afterward

### P1

1. Redesign mint/burn throughput:
   - separate critical from extended configs
   - guarantee minimum critical coverage per run
   - expose lag per config in status
2. Decouple yield cache publication from full safety coverage.
3. Promote `dispatch-telegram-alerts-daily` into tracked cron status.

### P2

1. Add start/progress observability for long jobs.
2. Rework 20-minute slot D1 write strategy:
   - checkpoint/progress rows
   - staging + final merge for blacklist/discovery where possible
3. Consider splitting the 20-minute slot if D1 contention remains high under production load.

## Final State Snapshot

At audit freeze, the isolated D1 contained:

- `cache`: 25 rows
- `price_cache`: 364 rows
- `depeg_events`: 8 rows
- `stress_signals`: 685 rows
- `stability_index_samples`: 5 rows
- `status_probe_runs`: 5 rows
- `dex_liquidity`: 157 rows
- `dex_liquidity_history`: 156 rows
- `dex_prices`: 62 rows
- `yield_data`: 41 rows
- `yield_history`: 111 rows
- `supply_history`: 153 rows
- `safety_grade_history`: 156 rows
- `mint_burn_events`: 12,301 rows
- `mint_burn_hourly`: 667 rows
- `blacklist_events`: 630 rows
- `dex_pool_staging`: 651 rows
- `dex_discovery_meta`: 94 rows

Outstanding leases at freeze:

- `sync-blacklist`
- `sync-dex-discovery`

That final detail matters: both long-running 20-minute jobs had already mutated live tables, but neither had produced a final terminal cron row by the time the environment was frozen.
