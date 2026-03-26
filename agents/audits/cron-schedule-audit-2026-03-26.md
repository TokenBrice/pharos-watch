# Cron Schedule Audit — 2026-03-26

## Scope

- Reviewed the scheduler topology in `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, and the slot runners under `worker/src/handlers/scheduled/`.
- Read the cron-budget docs in `docs/worker-and-api-limits.md`, `docs/worker-infrastructure.md`, `docs/dex-liquidity.md`, `docs/yield-intelligence.md`, `docs/yield-intelligence-operations.md`, and `docs/stability-index.md`.
- Queried production `cron_runs` via Wrangler D1 on 2026-03-26 for the last 72 hours and last 7 days.

## Current Shape

- 11 trigger slots.
- 27 status-tracked cron jobs.
- Heavy isolated lanes already exist for:
  - `sync-blacklist`
  - `sync-mint-burn`
  - `sync-mint-burn-extended`
  - `sync-dex-discovery`
- The busiest shared slot is still the half-hourly lane:
  - `sync-stablecoin-charts`
  - `sync-dex-liquidity`
  - `compute-dews`
  - `stability-index`
  - `sync-yield-data`

## Jobs Already Effectively Throttled

- `sync-stablecoin-charts` is scheduled every 30 minutes but has an internal 1 hour cooldown before it writes.
- `snapshot-supply` and `snapshot-chain-supply` are invoked on the quarter-hour lane but only write one daily snapshot.
- `discovery-scan` runs from the daily 08:05 lane but immediately skips unless it is Monday.
- `weekly-recap` is also effectively Monday-only.
- `sync-dex-discovery` already has internal tier/cadence backoff, so many 30-minute triggers do only 1 coin and finish in about 3 seconds.

## Live Telemetry

### Last 7 days by job

- `sync-dex-liquidity`
  - 335 runs
  - avg `240.5s`
  - 34 degraded
  - 12 errors
- `sync-stablecoins`
  - 664 runs
  - avg `114.7s`
  - 6 degraded
  - 12 errors
- `sync-blacklist`
  - 287 runs
  - avg `92.7s`
  - 4 degraded
  - 0 errors
- `sync-live-reserves`
  - 168 runs
  - avg `76.3s`
  - 32 degraded
  - 0 errors
- `sync-dex-discovery`
  - 305 runs
  - avg `69.1s`
  - 4 degraded
  - 0 errors
- `sync-yield-data`
  - 324 runs
  - avg `25.6s`
  - 84 degraded
  - 2 errors
- `sync-mint-burn-extended`
  - 506 runs
  - avg `32.7s`
  - 0 degraded
  - 36 errors

### Shared-slot wall clock approximation

- Half-hourly slot, last 7 days, `slot_started_at IS NOT NULL`
  - 139 slots
  - avg total runtime `261.6s`
  - max total runtime `507.0s`
  - `0` slots above 15 minutes
  - 4 slots with any error
  - 40 slots with any degraded job
- Quarter-hourly slot
  - 275 slots
  - avg total runtime `256.9s`
  - max total runtime `509.5s`
  - `0` slots above 10 minutes
  - 6 slots with any error
  - 25 slots with any degraded job
- Hourly reserve slot
  - 69 slots
  - avg total runtime `130.8s`
  - max total runtime `300.0s`
  - `0` slots above 10 minutes

## Main Findings

### 1. The half-hourly lane is not globally overloaded

- The slot is averaging about 4.4 minutes total.
- The worst scheduled half-hour slot in the last 7 days was about 8.5 minutes.
- There is still substantial distance from the 30-minute trigger interval.

Conclusion:

- Lowering half-hourly jobs just to avoid slot overlap is not justified by the current wall-clock totals.

### 2. `sync-yield-data` is the clearest “non-time-sensitive but operationally noisy” job

Recent 72-hour pattern:

- healthy runs when deterministic on-chain reads work: about `3s` to `25s`
- degraded or masked-failure runs when deterministic on-chain reads fully fail: about `132s` to `258s`
- 2 recent hard timeouts at exactly `300s`

The production metadata shows the current slow path clearly:

- `onChainRatesResolved: 0`
- `onChainAllDeterministicFailed: true`
- repeated failure bucket: `rpc-empty|etherscan-empty`
- the run is often still publishable because the deterministic failure is masked by alternate sources

Root cause:

- `fetchOnChainRates()` walks the configured deterministic assets sequentially with `RATE_BATCH_SIZE = 1`.
- each asset can burn time across fallback RPC, primary RPC, then Etherscan proxy, all with a `6000ms` timeout
- when the whole deterministic lane is unhealthy, yield spends several minutes proving the same thing every 30 minutes

Conclusion:

- lowering yield cadence would reduce operational churn
- increasing only the wrapper timeout would not address the root cause
- the bigger win is either:
  - run yield less often, or
  - fail deterministic yield reads faster after consecutive all-fail runs

### 3. `sync-dex-liquidity` is heavy, but it is doing timely work and is behaving within budget

Recent 72-hour pattern:

- mostly `186s` to `226s`
- coverage stayed flat at 128 scored assets
- no sign of coverage-guard pressure in recent metadata

This job feeds:

- the `/liquidity` page freshness promise
- DEWS liquidity inputs
- PSI stress-breadth continuity indirectly through DEWS
- price challenger snapshots and DEX-side price trust

Conclusion:

- lowering DEX liquidity scoring from 30 minutes to hourly would trade away user-visible freshness and downstream monitoring quality
- it would not buy much operational stability because the lane is already comfortably inside the slot budget

### 4. `sync-dex-discovery` is already self-throttled enough that lowering the top-level cadence buys little

Recent 72-hour pattern alternates between:

- tiny runs around `3s` with 1 crawled coin
- medium runs around `55s` to `155s`
- occasional heavier runs around `425s` to `464s`

Recent metadata shows:

- `budgetExhausted: false`
- many runs with only `t1` work
- heavy passes come from internal `t2` / `t3` / `dormant` cadence windows, not from every trigger doing full work

Conclusion:

- if the goal is stability, discovery is already well-contained because it is isolated and tiered
- if the goal is reducing vendor load, adjusting tier modulos is likely better than lowering the whole trigger cadence

### 5. `sync-mint-burn-extended` is a valid secondary candidate for slower cadence

- It is explicitly a long-tail backlog drain lane.
- Critical freshness is protected by the separate `sync-mint-burn` lane.
- Recent runs are usually `10s` to `16s`, with small row deltas.

Conclusion:

- moving extended mint/burn from every 20 minutes to hourly is operationally defensible if the product is comfortable with slower long-tail reconciliation
- the stability gain is moderate, not dramatic, because the lane is already isolated and cheap

## Recommendation

### High-confidence changes

1. Move `sync-yield-data` from 30 minutes to 60 minutes.

- This is the cleanest cadence reduction with the least product downside.
- Yield is materially slower-moving than stablecoin prices, DEWS, or DEX liquidity.
- It removes repeated multi-minute deterministic failure loops from every half-hour cycle.

2. Do not increase the `sync-yield-data` timeout as the first move.

- Today the wrapper timeout is 5 minutes.
- The slow path is caused by repeated deterministic source failures, not by useful work barely needing a little more time.
- A larger timeout would mostly let a bad deterministic lane spend longer failing.

3. Instead, add a fast-fail / cooldown rule for the deterministic on-chain yield lane.

- Example: if the last 2-3 runs were `allDeterministicFailed`, skip deterministic reads for 1-2 hours and rely on alternate sources.
- This targets the real source of instability much better than a larger global timeout.

### Conditional changes

4. Keep `sync-dex-liquidity` at 30 minutes unless you are willing to relax downstream monitoring freshness.

- If you want to save load, reduce discovery aggressiveness first, not scoring freshness.

5. Leave `sync-dex-discovery` at 30 minutes for now.

- It is isolated.
- It already has 12-minute self-budgeting and per-coin caps.
- It already throttles itself heavily through tiering.

6. If you want one more low-risk simplification, move `sync-mint-burn-extended` to hourly.

- That keeps critical mint/burn coverage intact while reducing long-tail background churn.

## Direct Answer

Would you gain stability by lowering frequency and increasing timing budget / timeout?

- `yield`: yes on frequency, not much on timeout alone
- `dex-discovery`: little stability gain from lower frequency; it is already isolated and internally backed off
- `dex-liquidity`: not recommended to lower if you want to preserve current monitoring quality
- `mint-burn-extended`: reasonable optional slowdown candidate

If I had to make only one schedule change first, I would slow `sync-yield-data` to hourly and pair it with a deterministic-source fast-fail/cooldown path rather than simply giving it more time.
