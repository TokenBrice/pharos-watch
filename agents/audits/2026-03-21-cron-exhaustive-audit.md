# Exhaustive Cron Audit — 2026-03-21

## Executive Summary

Audited all 10 cron triggers dispatching 25 active jobs (+1 recently deleted ghost).
Production data covers the last 7 days (~11,500 logged runs).

**Overall health: GOOD with notable issues.** The infrastructure (lease-based mutual exclusion,
cron-logger, circuit breakers, D1 overload retry) is well-engineered. However, there are:

- **2 active bugs** causing production failures right now
- **1 connection pool contention** risk in the heaviest job (dex-liquidity)
- **3 jobs with excessive frequency** wasting DB writes and CPU
- **2 jobs with noise-level degraded rates** hiding real issues (56% and 55%)
- **Several missing null guards, try/catch gaps, and missing AbortSignal checks** across jobs

---

## 1. Infrastructure Assessment

### Cron Plumbing (Rating: Excellent)

| Component | Assessment |
|---|---|
| **Lease system** (`cron-lease.ts`) | Solid. Heartbeat-based with configurable TTL, graceful lost-lease abort via AbortSignal. D1 overload retry on release. |
| **Cron logger** (`cron-logger.ts`) | Good. Logs start time, duration, status, item count, metadata. Auto-prunes >7 days with safety valve fallback. |
| **Circuit breaker** (`circuit-breaker.ts`) | Well-designed 3-state (closed/open/half-open). Documented TOCTOU limitation is acceptable. 30-min probe interval. Fires alerts on open/close transitions. |
| **Progress reporting** (`cron-progress.ts`) | Clean. Real-time upsert to `cron_run_progress` table for long-running jobs. |
| **D1 overload retry** | Exponential backoff (150ms × 2^attempt, max 3 retries). Covers all infrastructure writes. |
| **AbortSignal** | Properly threaded through lease + timeout signals merged via `AbortSignal.any()`. |
| **Per-job timeouts** | Thoughtfully configured. Heaviest jobs (dex-discovery 23min, dex-liquidity 13min, blacklist 12min) have generous limits. Default 5min for lighter jobs. |

### Trigger Schedule Design (Rating: Good)

10 cron triggers, well-staggered to avoid overlap:

| Trigger | Schedule | Jobs | Peak Connections |
|---|---|---|---|
| Quarter-hourly | `*/15 * * * *` | sync-stablecoins → snapshot-supply → snapshot-chain-supply → sync-fx-rates → stability-index → compute-dews → status-self-check | 3/6 |
| 5-minute | `2,7,12,...,57 * * * *` | dispatch-telegram-alerts | 1/6 |
| 20min blacklist | `3,23,43 * * * *` | sync-blacklist | 1/6 |
| 20min mint-burn | `4,24,44 * * * *` | sync-mint-burn (critical) | 1/6 |
| 20min extended | `13,33,53 * * * *` | sync-mint-burn-extended | 1/6 |
| 30min DEX disc. | `6,36 * * * *` | sync-dex-discovery | 1/6 |
| Half-hourly | `10,40 * * * *` | sync-stablecoin-charts → sync-dex-liquidity → sync-yield-data | 4/6 |
| Hourly reserves | `11 * * * *` | sync-live-reserves → sync-redemption-backstops → collateral drift | 1/6 |
| Daily 08:00 | `0 8 * * *` | snapshot-supply, snapshot-safety-grade-history, snapshot-psi, fetch-tbill-rate → sync-usds-status | 1/6 |
| Daily 08:05 | `5 8 * * *` | sync-bluechip, daily-digest → weekly-recap, discovery-scan | 4/6 |

**Connection budget discipline is excellent.** Every trigger slot documents its peak connection usage. Sequential chaining within slots prevents cross-job contention. The staggered minute offsets (3, 4, 6, 10, 11, 13) minimize concurrent trigger firings.

---

## 2. Production Scorecard (Last 7 Days)

### Reliability by Job

| Job | Runs | OK | Error | Degraded | Skipped | Avg Duration | Max Duration | Error Rate |
|---|---|---|---|---|---|---|---|---|
| sync-stablecoins | 674 | 666 | **6** | 0 | 2 | 32.8s | 119.5s | 0.9% |
| snapshot-supply | 674 | 674 | 0 | 0 | 0 | 1.1s | 7.2s | 0% |
| snapshot-chain-supply | 467 | 467 | 0 | 0 | 0 | 0.9s | 9.2s | 0% |
| sync-fx-rates | 673 | 645 | 0 | 28 | 0 | 7.8s | 111.0s | 0% |
| stability-index | 665 | 665 | 0 | 0 | 0 | 1.4s | 7.0s | 0% |
| compute-dews | 664 | 663 | 0 | 0 | 1 | 3.6s | 13.6s | 0% |
| **status-self-check** | 673 | 301 | **1** | **371** | 0 | 20.8s | 60.6s | **55.2% degraded** |
| dispatch-telegram-alerts | 2017 | 2016 | 0 | 0 | 1 | 2.3s | 18.5s | 0% |
| sync-blacklist | 501 | 482 | 0 | 18 | 1 | 108.6s | 421.9s | 0% |
| sync-mint-burn | 504 | 503 | 0 | 0 | 1 | 9.9s | 30.4s | 0% |
| sync-mint-burn-extended | 506 | 503 | **1** | 0 | 2 | 40.2s | 120.4s | 0.2% |
| sync-dex-discovery | 312 | 264 | 0 | 0 | 48 | 82.8s | 792.1s | 0% |
| **sync-dex-liquidity** | 336 | 316 | **13** | 5 | 2 | 185.7s | 483.4s | **3.9%** |
| sync-yield-data | 323 | 276 | 0 | 47 | 0 | 22.2s | 155.0s | 0% |
| sync-stablecoin-charts | 337 | 337 | 0 | 0 | 0 | 1.6s | 20.4s | 0% |
| **sync-live-reserves** | 168 | 74 | 0 | **94** | 0 | 54.5s | 141.2s | **56.0% degraded** |
| **sync-redemption-backstops** | 167 | 163 | **3** | 1 | 0 | 1.9s | 10.4s | **1.8%** |
| sync-bluechip | 7 | 7 | 0 | 0 | 0 | 5.4s | 7.7s | 0% |
| daily-digest | 7 | 7 | 0 | 0 | 0 | 22.6s | 31.1s | 0% |
| weekly-recap | 6 | 6 | 0 | 0 | 0 | 3.3s | 17.6s | 0% |
| discovery-scan | 7 | 7 | 0 | 0 | 0 | 8.6s | 16.0s | 0% |
| snapshot-psi | 8 | 8 | 0 | 0 | 0 | 1.0s | 1.9s | 0% |
| snapshot-safety-grade-history | 8 | 8 | 0 | 0 | 0 | 2.7s | 4.8s | 0% |
| fetch-tbill-rate | 8 | 7 | 0 | 1 | 0 | 4.2s | 5.7s | 0% |
| sync-usds-status | 8 | 8 | 0 | 0 | 0 | 0.9s | 1.6s | 0% |
| *(ghost)* announce-cemetery-additions | 1829 | 1828 | 0 | 0 | 1 | 1.0s | 13.6s | 0% |

### Last 3 Runs Observed

All jobs were observed completing their last 3 runs successfully except:

- **sync-redemption-backstops**: 3 consecutive errors (`too many SQL variables`) — **ACTIVE BUG**
- **status-self-check**: consistently degraded (28/29 probes pass, 1 fails) — see analysis below
- **sync-live-reserves**: alternates between degraded (52-54 synced, 2 failed) and OK (114 synced) depending on adapter breaker state

---

## 3. Active Bugs

### BUG-1: sync-redemption-backstops — "too many SQL variables" (CRITICAL)

**Impact:** Job failing every run since ~12 hours ago.
**Root cause:** `loadReserveSyncStateMap()` in `worker/src/lib/live-reserves-store.ts:274` builds a single `WHERE stablecoin_id IN (?,?,?...)` clause from all configured backstop IDs needing reserve-sync-metadata. As the configured count grew to 136, the filtered subset likely exceeded D1's per-statement bind variable limit.
**Error:** `D1_ERROR: too many SQL variables at offset 269: SQLITE_ERROR`
**Fix:** Batch the IN clause query into chunks (e.g., 50 IDs per query), or use a subquery/temp approach.

### BUG-2: sync-dex-liquidity — Coverage guard trips + null.trim() (DUAL CAUSE)

**Impact:** 13 errors in 336 runs (3.9% error rate, worst of all jobs).
**Root causes (two independent issues):**

1. **Coverage guard trips (primary):** When DeFiLlama Yields returns fewer pools than usual, coverage drops below 60% of previous run, triggering hard error at `orchestrator.ts:530-546`. This is a protective mechanism working as designed, but it's the most frequent error cause.

2. **null.trim() (secondary):** `normalizeTokenAddress(address)` in `token-resolution.ts:12` calls `address.trim()` without null guard. When upstream DEX APIs return a pool with a null token address, this crashes with `TypeError: Cannot read properties of null (reading 'trim')`. Same pattern in `pool-identity.ts:27`.

**Errors cluster in bursts** — 5 consecutive failures ~30min apart, then self-resolves, consistent with transient upstream degradation.
**Fix for #2:** Add null guard: `return (address ?? "").trim().toLowerCase()`.

### BUG-3: sync-dex-liquidity — Connection pool contention (LATENT)

**Impact:** Potential 6-connection limit violation during Curve + direct API fetch overlap. Contributes to long-tail duration and may cause timeouts.
**Root cause:** In `orchestrator.ts`, `directApiPromise` (4 concurrent fetchers: Fluid, Balancer, Raydium, Orca) is initiated at line 155 BEFORE Curve response bodies are consumed in `buildCurveLookups` (line 216). At that moment, 4 unconsumed Curve responses hold connections + 4 direct API fetchers open new ones = up to **8 concurrent connections**, exceeding the 6-connection-per-trigger limit.
**Additionally:** Balancer (`fetch-balancer.ts:65`), Raydium (`fetch-raydium.ts:37`), and Orca (`fetch-orca.ts:51`) use raw `fetch()` with only the cron signal — **no per-request timeout**. A hanging API holds a connection for up to 13 minutes.
**Fix:** Consume Curve response bodies before starting direct API fetchers, or await Curve completion first. Add per-request timeouts to direct API fetchers.

---

## 4. Frequency-to-Task Matching Assessment

### Wastefully Frequent Jobs

| Job | Frequency | Productive Runs | Idle Runs | Productive % | 7-day CPU | Recommendation |
|---|---|---|---|---|---|---|
| **announce-cemetery-additions** | ~5 min | 1 | 1,827 | **0.05%** | 0.50h | **DELETED** (already removed March 20, ghost data) |
| **sync-blacklist** | 20 min | 44 | 456 | **8.8%** | **15.10h** | Reduce to hourly or 2-hourly |
| **dispatch-telegram-alerts** | 5 min | 331 | 1,685 | **16.4%** | 1.28h | OK — fast idle runs (~1s), latency matters for alerts |
| **snapshot-supply** | 15 min (daily intent) | 674 | 0 | 100% | 0.21h | **Overwriting same-day data every 15 min — reduce frequency** |
| **snapshot-chain-supply** | 15 min (daily intent) | 467 | 0 | 100% | 0.12h | **Same issue as snapshot-supply** |
| **stability-index** | 15 min | 0 | 665 | **0%** | 0.26h | Reporting issue: always item_count=0/null. Job works fine. |

#### Deep Dive: sync-blacklist Overfrequency

**The worst offender by far.** Consumes **15.1 hours of CPU** over 7 days — second only to sync-dex-liquidity (17.3h). Yet only 8.8% of runs produce data. Each run averages 108 seconds scanning Etherscan/TronGrid/RPC endpoints for blacklist events.

The blacklist data changes extremely rarely (new address blacklistings are infrequent events). Running every 20 minutes is far too aggressive. **Recommendation: reduce to hourly (saves ~11h CPU/week) or 2-hourly (saves ~14h CPU/week).**

#### Deep Dive: snapshot-supply / snapshot-chain-supply Overwriting

Both jobs have `intervalSec: 86400` in their definition but run on the 15-minute trigger. They use `INSERT OR REPLACE` keyed on `(stablecoin_id, snapshot_date)` with `snapshot_date` floored to UTC midnight.

**Result:** Every 15 minutes, they overwrite the same day's rows:
- snapshot-supply: 157 rows × 96 runs/day = **15,072 DB writes/day** for a single daily value
- snapshot-chain-supply: ~60 rows × 96 runs/day = **5,760 DB writes/day**

**This is not wrong** — it keeps the "latest" supply value fresh. But supply data from DefiLlama changes meaningfully at most hourly. **Recommendation: move to hourly or skip if last write was <1h ago.** This would reduce ~20,000 daily writes to ~4,000.

---

## 5. Degraded Status Analysis

### status-self-check: 55-63% degraded — MISLEADING SIGNAL

The self-check probes 29 API endpoints sequentially. Production metadata shows:
- **Degraded runs**: `passCount: 28, failCount: 1` — one probe consistently fails
- **Probe latency**: p95 ranges from 300ms-2500ms depending on load
- The `rawOverallStatus` is set to "degraded" based on data staleness checks from OTHER cron jobs, not the probe results themselves

**Deep root cause analysis (from code audit):**

The CronResult status is `degraded` when `discrepancy.hasDivergence || probeStatus !== "healthy"`. Four compounding sensitivity issues drive the 55% rate:

1. **Health probe amplifies staleness**: The `/api/health` probe reports `ok: false` when ANY cache is 1.5x its expected freshness. This makes the probe fail, which increases `failCount` AND escalates `semanticStatus` — **double-counting** one health issue through two degradation paths.

2. **Sequential probing inflates latency**: 29 probes run one-at-a-time. If 3-4 take 2-3s each (normal under D1 load), p95 exceeds the 5s "healthy" threshold even with zero failures.

3. **Zero-failure threshold is too tight**: `classifyProbeStatus` requires `failCount === 0` for "healthy." With 29 probes, any single transient timeout triggers degraded.

4. **Hysteresis creates structural divergence**: The effective status requires 3 consecutive healthy readings to recover, but each self-check run reports probe status instantly. During recovery, probe status flips while effective status stays degraded — persistent divergence.

**The self-check is not detecting real problems 55% of the time — it is over-sensitive to transient conditions.**

**Recommendation:** (a) Separate probe-health from data-staleness into distinct statuses, (b) allow 1-2 probe failures in the "healthy" band, and (c) apply the hysteresis window to the CronResult status itself (not just the persisted effective status).

### sync-live-reserves: 56% degraded — Adapter Noise

Recent degraded runs show two patterns:
1. **OK with warnings** (114/114 synced, 4 warnings from dola-inverse-finance "unknown-asset") → marked degraded
2. **Partial failure** (52/54 synced, usde-ethena + wsrusd-reservoir fail) → marked degraded

**Deep root cause (from code audit):** The degraded logic at `sync-live-reserves.ts:236-241` is:
```
failed > 0 || skipped > 0 || hasWarnings ? "degraded" : "ok"
```
This is **zero-tolerance across 114 coins × 26 adapters**. With that many external data sources (HTTP APIs, on-chain RPC, HTML scraping), it is statistically near-certain that at least 1 coin will have a transient failure or warning per run. The threshold is functionally impossible to pass.

**Recommendation:** Introduce a tolerance threshold — degrade only when failure/skip rate exceeds 10% of configured coins, OR when top-10-by-mcap coins fail.

### sync-yield-data: 14.5% degraded

47 degraded in 323 runs. **Deep root cause:** The T-bill rate cache is refreshed daily at 08:00 UTC. The yield sync marks degraded when the risk-free rate is stale (>48h) or on hardcoded fallback. Weekends and holidays reliably push the FRED data past the 48h threshold, creating contiguous degraded blocks of ~48 runs each occurrence.

**Recommendation:** Widen the T-bill stale threshold from 48h to 72h. The rate barely changes day-to-day. This alone would cut the degraded rate to <5%.

### sync-fx-rates: 4.2% degraded

28 degraded in 673 runs. The max duration outlier (111s vs 7.8s avg) suggests occasional API timeouts from FX rate providers. The degraded handling is appropriate — rates fall back to previous values.

---

## 6. Dependency Chain Analysis

### Critical Path: Quarter-Hourly Cascade

```
sync-stablecoins ──┬── [cache must be "safe"] ──→ snapshot-supply
                   ├── [cache must be "safe"] ──→ snapshot-chain-supply
                   ├── [independent] ──→ sync-fx-rates
                   ├── [cache + depeg pipeline safe] ──→ stability-index
                   ├── [cache must be "safe"] ──→ compute-dews
                   └── [independent] ──→ status-self-check
```

**Assessment:** Well-designed. The `parseStablecoinsCapabilities()` function gates downstream jobs on both cache freshness AND depeg pipeline health. If sync-stablecoins fails, dependent jobs are skipped — not errored. This prevents cascade failures.

**Risk:** sync-stablecoins has 6 errors in 674 runs (0.9%). When it fails, ALL derived scores (PSI, DEWS, supply snapshots) miss that 15-minute window. With 4 of 6 errors being timeouts, the cascade skip is correct behavior.

### Half-Hourly Chain

```
sync-stablecoin-charts → sync-dex-liquidity → sync-yield-data
```

Sequential chaining is correct — dex-liquidity uses 4 connections (Curve chains) and must complete before yield-data starts. If charts fails, dex-liquidity and yield still run (no data dependency, just connection pool sequencing).

### Hourly Reserve Chain

```
sync-live-reserves ──[finally]──→ sync-redemption-backstops ──→ collateral drift check
```

The `finally` ensures backstops always run even if reserves fail. **However, the active BUG-1 means backstops are currently failing every hour.**

### Cross-Trigger Dependencies

| Consumer Job | Depends On | Freshness Window |
|---|---|---|
| stability-index | sync-stablecoins cache + depeg pipeline | Same trigger (15min) |
| compute-dews | sync-stablecoins cache | Same trigger (15min) |
| snapshot-supply | sync-stablecoins cache | Same trigger (15min) |
| sync-redemption-backstops | sync-live-reserves, dex-liquidity, stablecoins cache | stale check (1h for liquidity) |
| status-self-check | ALL cron data freshness | Same trigger |
| daily-digest | All daily data | Different trigger (+5min offset) |

**No circular dependencies.** All data flows are acyclic.

---

## 7. Resource Consumption

### CPU Time (7-day totals, wall-clock)

| Job | Total Hours | % of Total | Runs |
|---|---|---|---|
| sync-dex-liquidity | 17.34h | **28.1%** | 336 |
| sync-blacklist | 15.10h | **24.5%** | 500 |
| sync-dex-discovery | 7.17h | 11.6% | 312 |
| sync-stablecoins | 6.15h | 10.0% | 674 |
| sync-mint-burn-extended | 5.65h | 9.2% | 506 |
| status-self-check | 3.89h | 6.3% | 673 |
| sync-live-reserves | 2.54h | 4.1% | 168 |
| sync-yield-data | 1.99h | 3.2% | 323 |
| All others combined | 1.92h | 3.1% | 4,449 |
| **TOTAL** | **61.75h** | 100% | 7,941 |

**Top 2 jobs consume 52.6% of all wall-clock time.** sync-blacklist's share is particularly wasteful given its 8.8% productivity rate.

---

## 8. Error Handling Quality (Code Audit)

### Strengths

- **Universal lease protection**: Every job goes through `runLeasedCron()` — no bare cron execution
- **AbortSignal threading**: All jobs receive and check signal, most propagate to fetch calls
- **Rich CronResult metadata**: Jobs return structured metadata (rows read/written, source coverage, validation failures)
- **Circuit breakers**: Blacklist (Etherscan) and mint-burn (Alchemy) properly gate on circuit state and record outcomes
- **Data validation**: sync-stablecoins validates upstream data (min expected count, source coverage) before committing
- **Staleness guards**: snapshot-supply/chain-supply skip if cache is >20min old

### Weaknesses

- **sync-dex-liquidity**: Connection pool contention (8 connections when limit is 6), missing per-request timeouts on Balancer/Raydium/Orca fetchers, `.trim()` null-safety gaps, and `persistScores` lacks `runWithOverloadRetry`
- **sync-redemption-backstops**: No batching of IN clause in `loadReserveSyncStateMap`, now hitting D1 limits
- **snapshot-supply / snapshot-chain-supply**: `batchExecute` not wrapped in try/catch — D1 write failures crash as unhandled exceptions instead of returning degraded CronResult. No short-circuit logic despite running 96x/day.
- **status-self-check**: Health probe amplifies minor staleness into probe failure (double-counted through both `failCount` and `semanticStatus`). Sequential 29-probe execution inflates p95 past 5s threshold. Hysteresis state machine creates structural divergence with instant probe status.
- **sync-live-reserves**: Main `for...of` loop never checks `signal.aborted` between iterations — relies solely on lease timeout
- **stability-index / compute-dews**: Both accept `_signal` but never use it (DB-only, low risk)
- **sync-dex-discovery**: Variance is structurally inherent (serial per-coin crawl with variable multi-source fan-out × tiering). No per-coin timeout — relies on 20-min global deadline
- **sync-blacklist**: No circuit breaker for dRPC or TronGrid providers — wasted budget on persistently-failing providers. Etherscan recursive `Promise.all` could briefly spike connections.
- **sync-stablecoins**: `llamaRes!.json()` in `intake.ts:89` not try/caught — malformed DL response body bypasses CoinGecko fallback
- **batchExecute**: The shared `batchExecute` helper in `db.ts` does not use `runWithOverloadRetry`. All snapshot jobs are vulnerable to transient D1 overload on business-logic writes (even though infrastructure writes retry).
- **Empty catch blocks**: Several jobs have `catch { /* Non-blocking */ }` patterns. Individually acceptable but compounds debugging difficulty.

---

## 9. Key Improvements (Prioritized)

### P0 — Fix Now (Active Production Bugs)

1. **Fix `loadReserveSyncStateMap` IN clause overflow** — Batch the query into chunks of 50 IDs. The current code uses a single unbounded IN clause that breaks at D1's bind variable limit. Affects sync-redemption-backstops every run.

2. **Add null guards in dex-liquidity token normalization** — `normalizeTokenAddress()` and related `.trim()` calls need `(value ?? "")` guards. Affects sync-dex-liquidity intermittently when upstream APIs return null addresses.

### P1 — High Impact, Low Effort

3. **Fix sync-dex-liquidity connection pool contention** — Await Curve body consumption before starting direct API fetchers. Add 15s per-request timeouts to Balancer/Raydium/Orca (currently raw `fetch()` with no timeout). Add `runWithOverloadRetry` to `persistScores`.

4. **Reduce sync-blacklist frequency to hourly** — Change from `3,23,43 * * * *` to a single hourly trigger. Saves ~11h CPU/week with negligible data freshness impact. Blacklist events are rare (8.8% productive rate).

5. **Fix status-self-check degraded threshold** — Separate probe-health from data-staleness. Allow 1-2 probe failures in the "healthy" band. Apply hysteresis to CronResult status itself. Currently 55-63% degraded renders the signal useless.

6. **Fix sync-live-reserves degraded threshold** — Introduce tolerance: degrade only when failure rate exceeds 10% of configured coins, or when critical (top-10 mcap) coins fail. Current zero-tolerance across 114 coins is statistically impossible to pass.

### P2 — Medium Impact

7. **Add short-circuit to snapshot-supply / snapshot-chain-supply** — Confirmed: NO short-circuit exists in the code. Every 15 minutes, it runs to completion and overwrites. Skip if last successful write was <1h ago. Reduces ~20,000 writes/day to ~4,000.

8. **Wrap `batchExecute` in try/catch in snapshot-supply and snapshot-chain-supply** — Currently, D1 write failures crash as unhandled exceptions, logged as "error" instead of returning a descriptive "degraded" CronResult. Both jobs at `snapshot-supply.ts:75` and `snapshot-chain-supply.ts:60`.

9. **Widen sync-yield-data T-bill stale threshold** — From 48h to 72h. Weekends/holidays reliably trigger degraded status because FRED only publishes on business days. Would cut degraded rate from 14.5% to <5%.

10. **Add per-coin timeout in sync-dex-discovery** — The 82s→792s variance is structurally inherent (serial per-coin crawl with variable multi-source fan-out × tiering), but a per-coin timeout (e.g., 60s) would cap the worst-case contribution of any single coin.

11. **Add `runWithOverloadRetry` to shared `batchExecute`** — The helper in `db.ts` does not retry on D1 overload. All snapshot and scoring jobs are vulnerable to transient D1 pressure on business-logic writes, even though infrastructure writes retry.

### P3 — Nice to Have

12. **Add circuit breakers for dRPC and TronGrid in sync-blacklist** — Currently only Etherscan has a circuit breaker. Repeated dRPC/TronGrid failures waste budget on doomed requests every run.

13. **Add per-source error attribution to sync-dex-liquidity metadata** — When errors propagate as generic TypeErrors, include the failing pool's chain+protocol to speed debugging.

14. **Guard `llamaRes!.json()` in sync-stablecoins `intake.ts:89`** — Add try/catch so a malformed DL response body (HTML error page on 200) routes to the CoinGecko fallback path instead of crashing.

15. **Add explicit `signal.aborted` checks in sync-live-reserves loop** — The main `for...of` over 114 coins never checks the signal between iterations. Adding `throwIfAborted(signal)` at the top would match the pattern used in sync-redemption-backstops.

16. **Standardize item_count reporting** — stability-index reports 0% productive (item_count always null) despite working correctly. Aligning with compute-dews pattern would make the productive-run metric trustworthy.

17. **Consider parallelizing UniV3 subgraph queries in sync-dex-liquidity** — Currently sequential across 4 chains (up to 60s worst case). These are independent and could run in parallel.

---

## Appendix A: Trigger Timing Conflicts

Minute-by-minute overlap analysis for a typical hour:

```
:00  quarter-hourly (sync-stablecoins ~33s → snapshot-supply → ... → status-self-check)
:02  telegram-alerts (~2s)
:03  blacklist (sync-blacklist ~108s, finishes ~:05)
:04  mint-burn critical (~10s)
:06  dex-discovery (~82s, finishes ~:07-:08)
:07  telegram-alerts (~2s)
:10  half-hourly (charts → dex-liquidity ~186s → yield ~22s, finishes ~:14)
:11  hourly reserves (sync-live-reserves ~55s → backstops ~2s)
:12  telegram-alerts (~2s)
:13  mint-burn extended (~40s)
:15  quarter-hourly (repeat)
:17  telegram-alerts (~2s)
...
```

**No problematic overlaps on the same trigger.** Cross-trigger overlap is fine since each trigger has its own 6-connection pool. The only concern is D1 write contention when multiple triggers write simultaneously, but the D1 overload retry handles this.

## Appendix B: Job Definition vs Reality Gaps

| Job | Defined intervalSec | Actual Frequency | Discrepancy |
|---|---|---|---|
| snapshot-supply | 86400 (daily) | Every 15 min | By design — updates throughout day |
| snapshot-chain-supply | 86400 (daily) | Every 15 min | By design — updates throughout day |
| weekly-recap | 604800 (weekly) | Daily (skips non-Monday) | By design — Monday-gated |
| announce-cemetery-additions | Not in definitions | Was 5-min, now deleted | Ghost entries |

All other jobs match their defined interval within the expected trigger cadence.

## Appendix C: Per-Job Code Quality Ratings (Deep Audit)

Ratings from 7 parallel deep code audits reading every line of every cron job implementation.

| Job | Error Handling | Data Validation | AbortSignal | CronResult | Overall |
|---|---|---|---|---|---|
| **sync-stablecoins** | Strong | Strong | Strong | Strong | **A** — Best-in-class. 14+ abort checkpoints, Zod schema validation, layered fallbacks. |
| **sync-fx-rates** | Strong | Excellent | Good | Good | **A** — 5-layer fallback cascade, Zod validation, cross-source rate verification. |
| **compute-dews** | Excellent | Excellent | Absent | Excellent | **A-** — Best-structured job. Per-source failure tracking, chunked IN clauses, orphan safety. Signal ignored but DB-only. |
| **sync-blacklist** | Good | Good | Good | Good | **B+** — Per-config isolation, budget system, rate limiting. Missing dRPC/TronGrid circuit breakers. |
| **sync-mint-burn** | Good | Good | Good | Good | **B+** — Smart config rotation, tier prioritization, consecutive-run degraded thresholds. |
| **dispatch-telegram-alerts** | Excellent | Good | Thorough | Good | **B+** — Blocked-user detection, pending queue TTL, message budget caps. |
| **sync-dex-discovery** | Good | Good | Thorough | Good | **B+** — Tier system, rate-limited multi-source fan-out, abort-safe sleep. |
| **sync-dex-liquidity** | Good | Excellent | Good | Good | **B** — Coverage guards are excellent. Connection pool contention, missing per-request timeouts, and persistScores lacking retry are the gaps. |
| **daily-digest** | Good | Strong | Adequate | Good | **B** — Claude API timeout composed, Zod validation, raw-text fallback. No signal checkpoints between DB queries. |
| **sync-live-reserves** | Good | Good | Partial | Good | **B** — Per-coin isolation, shared-source caching. Zero-tolerance degraded and missing loop-level abort check. |
| **sync-yield-data** | Good | Good | Good | Good | **B** — Multi-layer DL fallback, on-chain `allSettled`, APY divergence checks. Overly sensitive degraded threshold. |
| **sync-bluechip** | Good | Good | Good | Good | **B** — Clean and simple. Batched with inter-batch delay, Zod validation. |
| **fetch-tbill-rate** | Excellent | Excellent | Good | Excellent | **B+** — Primary/fallback/hardcoded cascade, circuit breaker, good bounds-checking. |
| **snapshot-safety-grade-history** | Fair | Good | Excellent | Excellent | **B** — Best abort handling of snapshot jobs. `buildReportCardsSnapshot` throw uncaught. |
| **sync-stablecoin-charts** | Good | Good | Good | Good | **B** — Simple and clean. FX rate corruption fix is a nice touch. |
| **sync-usds-status** | Good | Good | Good | Good | **B** — Reasonable for a daily probe. Missing API key fails silently as degraded. |
| **weekly-recap** | Good | Adequate | Good | Good | **B-** — Monday guard, dedup, `.finally()` chaining. |
| **discovery-scan** | Good | Good | Minimal | Good | **B-** — Single-fetch job, re-discovery via 10x mcap threshold. |
| **snapshot-supply** | Adequate | Good | Minimal | Adequate | **C+** — No short-circuit, no try/catch on batchExecute, sparse success metadata. |
| **snapshot-chain-supply** | Adequate | Good | Minimal | Adequate | **C+** — Same issues as snapshot-supply. Zero-row snapshot silently succeeds. |
| **snapshot-psi** | Fair | Good | Missing | Good | **C+** — Signal ignored, DB errors uncaught. Functionally simple. |
| **stability-index** | Good | Good | Absent | Good | **B-** — One unprotected DB write. Signal ignored. Stale DEWS data read without freshness filter. |
| **sync-redemption-backstops** | Good | Good | Excellent | Good | **B** — Gold-standard abort handling. Active bug in upstream IN clause. |
| **status-self-check** | Good | Adequate | Good | Good | **B-** — Over-sensitive. One unprotected `evaluateStatusAndPersist` call. |
