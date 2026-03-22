# Exhaustive Cron Audit v2 — 2026-03-21

## Methodology

- **Code audit**: 5 parallel agents analyzed all 25 cron jobs, their trigger handlers, and shared infrastructure
- **Production data**: 3-day window (11,498 cron_runs rows across 26 jobs), queried via `wrangler d1 execute --remote`
- **Live observation**: 2 post-deploy run cycles observed in real time to verify recent remediation effects
- **Scope**: Reliability, error handling, job dependencies, frequency-to-task matching, resource consumption

---

## Executive Summary

25 defined cron jobs + 1 ghost job ran 11,498 times in 3 days, consuming ~29 CPU-hours. **Key findings:**

| Severity | Count | Summary |
|----------|-------|---------|
| Critical | 2 | Ghost job was still running; status-self-check permanently degraded (70.6%) |
| High | 3 | Massive over-frequency on snapshot jobs; stability-index 99.3% unproductive |
| Medium | 4 | Noisy degraded thresholds; dex-liquidity error cluster; FX fallback cascade |
| Low | 5 | Minor frequency tuning opportunities; missing itemCount fields; retention gaps |

**Top resource consumers (3-day CPU-hours):**
1. `sync-dex-liquidity` — 10.87h (37.5%)
2. `sync-blacklist` — 6.54h (22.5%) ← reduced to hourly in latest deploy
3. `sync-stablecoins` — 2.81h (9.7%)
4. `sync-mint-burn-extended` — 1.89h (6.5%)
5. `sync-dex-discovery` — 1.82h (6.3%)

---

## Per-Job Analysis

### Tier 1: Quarter-Hourly Jobs (`*/15 * * * *`)

#### 1. `sync-stablecoins` — Stablecoin Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 290 |
| OK / Degraded / Error | 287 / 0 / 2 |
| Avg duration | 34.9s |
| Avg items | 377.2 |
| Productive % | 99.0% |
| CPU hours | 2.81h |

**Reliability**: 4/5. Two errors in 290 runs (0.7%). Core pipeline with dual-primary pricing (DL + CG fallback), circuit breakers on both sources, and comprehensive metadata. The 2 errors had null metadata — likely platform-level timeout before `logCronRun` could write.

**Frequency assessment**: **Appropriate**. External data (DefiLlama stablecoins API) updates every ~10-15 minutes. 15-min cadence matches upstream refresh rate. Every run produces ~377 items.

**Dependencies**: Upstream: DefiLlama stablecoins API, CoinGecko market API. Downstream: `snapshot-supply`, `snapshot-chain-supply`, `stability-index`, `compute-dews` (all depend on fresh stablecoins cache).

**Issues**: None critical. The `intake.ts` json parse guard (added in recent remediation) protects against body parse failures.

---

#### 2. `sync-fx-rates` — FX Rate Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 289 |
| OK / Degraded / Error | 261 / 28 / 0 |
| Degraded % | 9.7% |
| Avg duration | 13.8s |
| Avg items | 20 |
| Productive % | 100% |

**Reliability**: 3/5. 9.7% degraded rate caused by Frankfurter API outages. The job falls back to cached rates (`mode: "cached-fallback"`) and keeps producing 20 items, but reports "degraded" while doing so. The `consecutiveFallbackRuns` counter climbed to 15 during one outage window.

**Frequency assessment**: **Appropriate**. FX rates change continuously. 15-min cadence is reasonable for financial data. Always produces data (100% productive).

**Issue — Degraded cascading**: When Frankfurter is down, every run reports degraded even though cached rates are perfectly valid for 15-min intervals. The fallback mode should only trigger "degraded" after >1h of consecutive fallback runs, not immediately.

---

#### 3. `stability-index` — PSI Compute
| Metric | Value |
|--------|-------|
| Runs (3d) | 286 |
| OK / Degraded / Error | 286 / 0 / 0 |
| Avg duration | 1.0s |
| Avg items | 0.007 (2 productive / 286 total) |
| **Productive %** | **0.7%** |
| CPU hours | 0.08h |

**Reliability**: 5/5. Never fails.

**Frequency assessment**: **OVER-FREQUENT**. Only 2 of 286 runs produced an item (wrote a stability index row). The job reads upstream data and recomputes, but the PSI score barely changes within 15 minutes — the underlying peg scores, DEWS, and liquidity scores all update on longer cycles. **99.3% of runs are wasted computation.**

**Recommendation**: Move to 30-min or hourly cadence. The PSI score changes meaningfully only when upstream scores change, which happens at most every 30 minutes (when dex-liquidity and yield data update).

---

#### 4. `compute-dews` — DEWS Compute
| Metric | Value |
|--------|-------|
| Runs (3d) | 285 |
| OK / Degraded / Error | 284 / 0 / 0 |
| Avg duration | 2.8s |
| Avg items | 138.6 |
| Productive % | 99.6% |
| CPU hours | 0.22h |

**Reliability**: 5/5. One unproductive run out of 285 (likely a lease skip).

**Frequency assessment**: **Appropriate but borderline**. Produces 138.6 items per run (one per tracked stablecoin). However, the underlying stress signals (supply changes, peg deviations) don't change rapidly. DEWS at 15-min cadence writes ~39,351 rows in 3 days. A 30-min cadence would halve writes with minimal signal loss.

**Dependencies**: Reads from `supply_history`, `peg_scores`, `dex_liquidity_scores`. Downstream: `stability-index` uses DEWS stress breadth.

---

#### 5. `status-self-check` — Status Self-Check
| Metric | Value |
|--------|-------|
| Runs (3d) | 289 |
| OK / Degraded / Error | 84 / 204 / 1 |
| **Degraded %** | **70.6%** |
| Avg duration | 18.7s |
| CPU hours | 1.50h |

**Reliability**: 2/5. **Permanently degraded** — all recent runs show "degraded" with `probeStatus: "healthy"` and `failCount: 0`. The degraded status comes from persistent `discrepancy.hasDivergence: true` with `consecutiveDivergent >= 2`. The discrepancy compares raw vs effective status and has been divergent for days, making the hysteresis threshold ineffective.

**Root cause**: The status system detects that `rawOverallStatus: "degraded"` while `effectiveStatus: "degraded"` — these match, yet `hasDivergence: true` is still reported. Investigation needed into `buildDiscrepancy()` logic — the comparison may be against the *probe-measured* status ("healthy") rather than between raw and effective.

**Frequency assessment**: Appropriate for a health monitor (15-min). But the 18.7s average duration is high for a self-check — it probes 29 API endpoints sequentially.

**Issue — Permanent degradation**: The status-self-check has been "degraded" for hundreds of consecutive runs. This makes the status signal useless — it's boy-who-cried-wolf. The discrepancy detection needs fundamental redesign: either (a) ignore discrepancy when probe results are healthy, or (b) auto-resolve discrepancy after N consecutive runs where probes pass.

---

#### 6. `snapshot-supply` — Supply Snapshot
| Metric | Value |
|--------|-------|
| Runs (3d) | 291 |
| OK / Degraded / Error | 291 / 0 / 0 |
| Avg duration | 0.9s |
| Avg items | 156.5 |
| Productive % | 99.7% |

**Reliability**: 5/5.

**Frequency assessment**: **MASSIVELY OVER-FREQUENT (now fixed)**. This daily job (`intervalSec: 86400`) was running on the 15-min trigger and writing 159 rows via `INSERT OR REPLACE` every single run — 45,398 total rows written in 3 days for data that changes once per day. The recent cooldown fix (1h cache key) is now working: post-deploy runs show `item_count: 0` with the cooldown active.

**Post-fix status**: The cooldown reduces writes from ~96/day to ~1/day (99% reduction). Still runs 96 times/day but short-circuits in ~1s each time.

---

#### 7. `snapshot-chain-supply` — Chain Supply Snapshot
| Metric | Value |
|--------|-------|
| Runs (3d) | 287 |
| Same analysis as snapshot-supply | Cooldown now active |

**Post-fix**: Now short-circuits with `item_count: 0`. Same over-frequency pattern as snapshot-supply, same fix applied.

---

### Tier 2: Five-Minute Job

#### 8. `dispatch-telegram-alerts` — Telegram Alert Dispatch
| Metric | Value |
|--------|-------|
| Runs (3d) | 864 |
| OK / Degraded / Error | 864 / 0 / 0 |
| Avg duration | 1.8s |
| Productive % | 18.1% |
| CPU hours | 0.44h |

**Reliability**: 5/5. Never fails.

**Frequency assessment**: **Borderline over-frequent**. 82% of runs produce zero items. The job checks for pending alerts and dispatches them. Alert generation is event-driven (depeg events, coverage changes), so most runs have nothing to send.

**Trade-off**: The 5-minute cadence provides fast alert delivery when events do occur. If latency SLA is "alerts within 10 minutes of detection", a 10-min cadence works. If SLA is "within 5 minutes", current cadence is justified.

---

### Tier 3: Hourly Jobs

#### 9. `sync-blacklist` — Blacklist Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 215 |
| OK / Degraded / Error | 205 / 10 / 0 |
| Avg duration | 109.5s |
| **Productive %** | **4.7%** |
| CPU hours | 6.54h (2nd highest!) |

**Reliability**: 3/5. 10 degraded runs (4.7%) — all due to budget/time constraints.

**Frequency assessment**: **OVER-FREQUENT (recently fixed from 20-min to hourly)**. Only 10 of 215 runs (4.7%) found any blacklist events. Even at hourly, the productive rate suggests 2-3 hourly would suffice.

**Resource waste**: At 109.5s average × 215 runs = 6.54 CPU-hours — the second-highest resource consumer, producing just 42 items total. Even with the hourly fix, expect ~2.6h/3d.

---

#### 10. `sync-live-reserves` — Live Reserve Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 72 |
| OK / Degraded / Error | 28 / 44 / 0 |
| **Degraded %** | **61.1%** (pre-fix) |
| Avg duration | 52.3s |
| Avg items | 52.8 |
| Productive % | 100% |

**Reliability**: 3/5 (pre-fix). The 61.1% degraded rate was caused by the zero-tolerance threshold. Post-deploy, the last 6 runs show "ok" with 114 items — the 10% tolerance fix is working.

**Frequency assessment**: **Appropriate**. Always produces data (100% productive). Reserve compositions update on-chain at varying intervals; hourly is a reasonable polling frequency.

---

#### 11. `sync-redemption-backstops` — Redemption Backstops
| Metric | Value |
|--------|-------|
| Runs (3d) | 72 |
| OK / Degraded / Error | 66 / 3 / 3 |
| Avg duration | 1.6s |
| Productive % | 95.8% |

**Reliability**: 3/5. 3 errors (4.2%) with null metadata — occurred in the same window as dex-liquidity errors, suggesting platform-level issues. 3 degraded runs show `unresolved: 1` (1 of 136 configs couldn't resolve).

**Frequency assessment**: **Appropriate**. DB-only computation, runs in 1.6s, shares the hourly trigger.

**Dependency**: Runs AFTER `sync-live-reserves` on the same trigger. Depends on fresh liquidity data.

---

### Tier 4: Half-Hourly Jobs

#### 12. `sync-dex-liquidity` — DEX Liquidity Scoring
| Metric | Value |
|--------|-------|
| Runs (3d) | 144 |
| OK / Degraded / Error | 131 / 5 / 8 |
| Avg duration | 271.8s (4.5 min) |
| Avg items | 135.6 |
| **CPU hours** | **10.87h (37.5% of total)** |

**Reliability**: 3/5. 8 errors (5.6%) — all with null metadata, clustered in a 2-hour window (platform outage). 5 degraded runs from coverage drops.

**Frequency assessment**: **Appropriate**. DEX pools update continuously. 30-min cadence captures meaningful TVL changes. Always productive when it completes (94.4%). The 4.5-minute average runtime leaves headroom in the 30-min window.

**Issues**:
- Error runs have null metadata — the job crashes before `logCronRun` can write. Suggests platform-level kills during data fetching.
- The connection pool fix (moving directApiPromise after Curve consumption) should reduce errors.

---

#### 13. `sync-dex-discovery` — DEX Pool Discovery
| Metric | Value |
|--------|-------|
| Runs (3d) | 118 |
| OK / Degraded / Error | 92 / 0 / 0 |
| Avg duration | 55.4s |
| Avg items | 11.1 |
| Productive % | 78% |
| Unaccounted runs | 26 (22%) |

**Reliability**: 4/5.

**Frequency assessment**: **Appropriate**. 78% productive — discovers ~11 new pools per run. 22% are lease-skips when previous runs exceeded the 30-min window (max 825s = 13.8 min).

---

#### 14. `sync-stablecoin-charts` — Chart Data Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 144 |
| OK / Degraded / Error | 144 / 0 / 0 |
| Avg duration | 1.3s |
| Avg items | 258.9 |
| Productive % | 100% |
| CPU hours | 0.05h |

**Reliability**: 5/5.

**Frequency assessment**: **Potentially over-frequent**. DefiLlama chart data is typically updated daily or every few hours. The job overwrites the full chart dataset each time. Consider reducing to hourly — the CPU cost is trivial (0.05h) but the DB writes are unnecessary.

---

#### 15. `sync-yield-data` — Yield Sync
| Metric | Value |
|--------|-------|
| Runs (3d) | 136 |
| OK / Degraded / Error | 136 / 0 / 0 |
| Avg duration | 21.1s |
| Avg items | 87.4 |
| Productive % | 100% |
| Missing runs | 8 (of expected 144) |

**Reliability**: 5/5 (when it runs).

**Frequency assessment**: **Appropriate**. DeFi yield data updates frequently. 8 missing runs (5.6%) — likely lease-skipped because `sync-dex-liquidity` ran long on the shared trigger.

---

### Tier 5: Twenty-Minute Jobs

#### 16. `sync-mint-burn` — Mint/Burn Critical Lane
| Runs (3d) | 217 | OK | 216 | Avg duration | 7.8s | Items | 37 | Productive % | 99.5% |

**Reliability**: 5/5. **Frequency**: Appropriate — 37 events per run confirms high activity.

#### 17. `sync-mint-burn-extended` — Mint/Burn Extended Lane
| Runs (3d) | 217 | OK | 216 | Avg duration | 31.3s | Items | 11.3 | CPU hours | 1.89h |

**Reliability**: 5/5. **Frequency**: Borderline — extended lane sees fewer events (11.3 vs 37). Could run every 30 min.

---

### Tier 6: Daily Jobs

| Job | Runs | OK | Avg | Items | Notes |
|-----|------|----|-----|-------|-------|
| `daily-digest` | 3 | 3 | 22.4s | 1 | Correct cadence |
| `weekly-recap` | 3 | 3 | 0.3s | - | Skip mechanism works correctly |
| `fetch-tbill-rate` | 4 | 4 | 4.0s | 1 | 72h stale threshold handles weekends |
| `snapshot-psi` | 4 | 4 | 0.9s | null | Missing `itemCount` (same issue as stability-index) |
| `snapshot-safety-grade-history` | 4 | 4 | 1.8s | 27 | Correct |
| `sync-usds-status` | 4 | 4 | 0.8s | 1 | Correct |
| `sync-bluechip` | 3 | 3 | 5.6s | 3 | Correct |
| `discovery-scan` | 3 | 3 | 6.3s | **0** | **Zero discoveries in 3 days** — consider weekly |

---

### Ghost Job

#### `announce-cemetery-additions` (GHOST — now stopped)
| Runs (3d) | 597 | Items | 0 | CPU | 0.13h |

**Dead code** — folded into `daily-digest` appendices but cron registration was not fully removed. Ran 597 times producing nothing. Confirmed stopped post-deploy.

---

## Cross-Cutting Findings

### 1. Over-Frequency Summary

| Job | Current cadence | Productive % | Recommended | Savings |
|-----|----------------|-------------|-------------|---------|
| `stability-index` | 15 min | 0.7% | 30-60 min | 50-75% fewer runs |
| `snapshot-supply` | 15 min (cooldown now) | Fixed | No change needed | Already fixed |
| `snapshot-chain-supply` | 15 min (cooldown now) | Fixed | No change needed | Already fixed |
| `sync-blacklist` | Hourly (was 20 min) | 4.7% | 2-3 hourly | 50-66% fewer runs |
| `dispatch-telegram-alerts` | 5 min | 18.1% | 10 min | 50% fewer runs |
| `sync-stablecoin-charts` | 30 min | 100% (overwrites) | 60 min | 50% fewer writes |
| `discovery-scan` | Daily | 0% | Weekly | 86% fewer runs |
| `compute-dews` | 15 min | 99.6% | 30 min | 50% fewer DB writes |

### 2. Permanently Degraded Status

Two jobs were stuck in permanent "degraded" state (one now fixed):

- **`status-self-check`** (STILL BROKEN): 70.6% degraded — probes all pass but discrepancy detection fires every run because `consecutiveDivergent >= 2` has been true for days. The hysteresis threshold doesn't help when divergence is persistent. **Needs fundamental fix: ignore discrepancy when `probeStatus === "healthy"` and `failCount === 0`.**
- **`sync-live-reserves`** (FIXED): Was 61.1% degraded, now "ok" with 10% tolerance.

### 3. Error Clustering Pattern

8 `sync-dex-liquidity` errors + 3 `sync-redemption-backstops` errors, all with `metadata: null`, clustered in the same 2-hour window. Indicates platform-level outage where Workers were killed before results could be written.

**Recommendation**: Write a `started_at` marker to DB at the beginning of each job so crash-without-metadata is distinguishable from never-started.

### 4. Job Dependency Chain

```
sync-stablecoins ──→ snapshot-supply (cooldown gated)
                 ──→ snapshot-chain-supply (cooldown gated)
                 ──→ stability-index
                 ──→ compute-dews

sync-dex-liquidity ──→ sync-yield-data (safety-score dependency)
                   ──→ sync-redemption-backstops (liquidity data)

sync-live-reserves ──→ sync-redemption-backstops (reserve data)

fetch-tbill-rate ──→ sync-yield-data (risk-free rate, 72h threshold)

sync-dex-discovery ──→ sync-dex-liquidity (staged pools merged)

daily-digest ←── all upstream jobs (reads latest data)
```

### 5. cron_runs Table Retention

- **Current size**: 11,498 rows spanning 6 days
- **Retention**: 7-day time-based pruning after every cron execution + 5000-row safety valve (`cron-logger.ts:173-191`)
- **Status**: Working as designed — no action needed

### 6. D1 Write Waste (Pre-Fix)

`snapshot-supply` wrote 45,398 rows in 3 days for daily data (~477 rows needed). **95× over-write factor**, now fixed with cooldown.

---

## Priority Remediation Recommendations

### P0 — Fix Now

1. **Fix `status-self-check` permanent degradation**: When `probeStatus === "healthy"` and `failCount === 0`, the CronResult should be "ok" regardless of discrepancy state. The current logic allows persistent divergence to permanently degrade the signal.

### P1 — Next Sprint

2. **Reduce `stability-index` frequency to 30-min**: Only 0.7% productive at 15-min. Most impactful frequency change.

3. **Reduce `compute-dews` to 30-min**: Halves DB writes (~39K → ~19K per 3 days) with negligible signal loss.

4. ~~**Add `cron_runs` retention**~~ — Already exists (7-day pruning + 5000-row safety valve in `cron-logger.ts`).

5. **Add circuit breaker for Frankfurter/secondary FX APIs** in `sync-fx-rates`: Currently retries every 15 min without backoff when primary FX source is down.

6. **Relax `sync-fx-rates` degraded threshold**: Only report "degraded" after >4 consecutive fallback runs (~1 hour), not on the first cached-fallback run.

### P2 — Backlog

6. **Reduce `dispatch-telegram-alerts` to 10-min**: 82% no-op runs.
7. **Reduce `sync-stablecoin-charts` to hourly**: Chart data doesn't update every 30 min.
8. **Reduce `discovery-scan` to weekly**: 0% discovery rate at daily cadence.
9. **Consider `sync-blacklist` 2-3 hourly**: Even at hourly, 95% no-op.
10. **Add crash marker writes**: Distinguish platform kills from lease-skips.

### P3 — Nice to Have

11. **Fix `snapshot-psi` missing `itemCount`**: Same pattern as stability-index (already fixed there).
12. **Reduce `sync-mint-burn-extended` to 30-min**: Lower activity than critical lane.

---

## Post-Deploy Verification

| Fix | Status | Evidence |
|-----|--------|----------|
| snapshot-supply cooldown | ✅ Working | `item_count: 0` post-deploy |
| snapshot-chain-supply cooldown | ✅ Working | `item_count: 0` post-deploy |
| sync-live-reserves 10% threshold | ✅ Working | Last 6 runs "ok" with 114 items |
| stability-index itemCount | ✅ Working | `item_count: 1` post-deploy |
| sync-blacklist hourly | ✅ Working | Single run on hourly trigger |
| announce-cemetery-additions ghost | ✅ Stopped | No runs post-deploy |
| status-self-check thresholds | ⚠️ Partial | probeStatus="healthy", failCount=0, but still "degraded" due to persistent discrepancy |

---

## Code Audit Findings (from 5 parallel agents)

The following issues were identified by deep code-level analysis across all job files, trigger handlers, and shared infrastructure. Issues already covered in earlier sections are omitted.

### Infrastructure Findings

| Finding | Severity | Location |
|---------|----------|----------|
| `cron_runs` retention is 7 days + 5000-row safety valve — NOT unbounded | Correction | `cron-logger.ts:173-191` |
| `runWithOverloadRetry` doesn't accept AbortSignal — can't be preempted by lease loss or cron timeout | Low | `cron-lease.ts:23-37` |
| No manual circuit breaker reset endpoint — requires direct D1 access | Low | `circuit-breaker.ts` |
| Circuit breaker states persist across deploys (stored in D1 cache table) | Info | `circuit-breaker.ts` |
| Lease TTL = job timeout + 60s buffer — crashed jobs auto-recover after expiry | Info | `cron-lease.ts:132` |
| TOCTOU window in circuit breaker `shouldAttemptFetch`→`recordOutcome` documented and accepted | Info | `circuit-breaker.ts:93-98` |

### Per-Job Code Issues

#### `snapshot-supply` / `snapshot-chain-supply` — Cache write race condition
If `setCache()` fails after `batchExecute()` succeeds, the cooldown key is not written, causing the next 15-min trigger to re-insert the same date's rows. Not data-corrupting (`INSERT OR REPLACE`) but inefficient.
- **File**: `snapshot-supply.ts:84-87`, `snapshot-chain-supply.ts:70`
- **Fix**: Include the cache key update inside the batchExecute transaction, or treat setCache failure as critical.

#### `sync-fx-rates` — No circuit breaker for primary FX APIs
Frankfurter and secondary FX APIs have no circuit breaker, unlike DefiLlama/CoinGecko. When Frankfurter is down, every 15-min run retries without backoff. Also throws unrecoverable error if all fallbacks fail (vs graceful degradation in sync-stablecoins).
- **File**: `sync-fx-rates.ts:466-517`

#### `sync-fx-rates` — Downstream jobs don't validate FX freshness
`stability-index` and `compute-dews` consume FX rates without checking if they're fresh or on cached-fallback mode. Stale rates could silently affect PSI/DEWS computations.
- **File**: `stability-index.ts`, `compute-dews.ts`

#### `stability-index` — Missing abort signal handling
The `_signal` parameter is accepted but never checked. No timeout handling during DB writes. If the cron deadline expires during INSERT, the job won't exit gracefully.
- **File**: `stability-index.ts:8, 146`

#### `stability-index` — Missing null check on depeg_events.results
No null-check before iterating depeg event rows. If D1 returns malformed rows, could silently produce NaN.
- **File**: `stability-index.ts:85`

#### `dispatch-telegram-alerts` — Unsafe snapshot parsing
`previousDewsSnapshot` and `previousDepegSnapshot` are used without null guards. If `parseSnapshotMap()` returns null, indexing crashes with TypeError.
- **File**: `dispatch-telegram-alerts.ts:341-353, 378`

#### `dispatch-telegram-alerts` — Possible duplicate alerts
If a user is subscribed to both global DEWS alerts and a specific stablecoin, they could receive the same alert twice. Dedup is per-event, not per-chat.
- **File**: `dispatch-telegram-alerts.ts:537-608`

#### `snapshot-psi` — Missing error handling on DB queries
No try/catch around D1 queries. DB errors propagate uncaught. Also returns incomplete CronResult (missing status and itemCount when no samples exist).
- **File**: `snapshot-psi.ts:10-22, 35-36`

#### `sync-usds-status` — setCacheIfNewer error not caught
If the cache write after a successful probe fails, the job still returns success status without recording the result.
- **File**: `sync-usds-status.ts:114`

#### `daily-digest` — No per-collector timeout
Each of the ~10 data collectors runs without explicit timeout. If a collector hangs, the entire digest hangs until the 8-min job timeout.
- **File**: `daily-digest.ts:24-34 imports`

#### `sync-blacklist` — No per-request timeout on TronGrid/Etherscan calls
All fetches rely on the global 12-minute deadline. A hanging API endpoint blocks for up to 12 minutes.
- **File**: `sync-blacklist.ts:139-149`

#### `sync-blacklist` — Etherscan batch recursion could spike connections
When multiple configs hit Etherscan simultaneously, recursive `Promise.all` for backfill range scanning could briefly open 4-8 connections before budget check takes effect.
- **File**: `evm-logs.ts`

### Error Handling Scorecard (from code audit)

| Job | Error Handling | Dependency Mgmt | Signal Handling | Overall |
|-----|:-:|:-:|:-:|:-:|
| sync-stablecoins | 4/5 | 5/5 | 4/5 | A- |
| sync-fx-rates | 3/5 | 4/5 | 3/5 | B |
| stability-index | 3/5 | 4/5 | 2/5 | B- |
| compute-dews | 4/5 | 5/5 | 3/5 | B+ |
| status-self-check | 5/5 | 5/5 | 5/5 | A |
| snapshot-supply | 4/5 | 4/5 | 2/5 | B |
| snapshot-chain-supply | 4/5 | 4/5 | 2/5 | B |
| dispatch-telegram-alerts | 3.5/5 | 3/5 | 3/5 | B- |
| sync-blacklist | 3.5/5 | 3/5 | 3/5 | B- |
| sync-mint-burn | 4/5 | 4/5 | 4/5 | A- |
| sync-mint-burn-extended | 3.5/5 | 4/5 | 3/5 | B |
| sync-dex-liquidity | 3/5 | 4/5 | 4/5 | B |
| sync-dex-discovery | 4/5 | 4/5 | 4/5 | A- |
| sync-stablecoin-charts | 4/5 | 3/5 | 4/5 | A- |
| sync-yield-data | 3.5/5 | 4/5 | 3/5 | B |
| sync-live-reserves | 4/5 | 4/5 | 4/5 | A- |
| sync-redemption-backstops | 4/5 | 4/5 | 4/5 | A- |
| fetch-tbill-rate | 5/5 | 4/5 | 4/5 | A |
| snapshot-safety-grade-history | 3/5 | 3/5 | 3/5 | B- |
| snapshot-psi | 2/5 | 3/5 | 2/5 | C+ |
| sync-usds-status | 4/5 | 3/5 | 3/5 | B |
| sync-bluechip | 4/5 | 3/5 | 3/5 | B |
| daily-digest | 4/5 | 4/5 | 3/5 | B+ |
| weekly-recap | 4/5 | 3/5 | 4/5 | B+ |
| discovery-scan | 4/5 | 3/5 | 3/5 | B |

### Corrected Findings

The initial report incorrectly assumed `cron_runs` has no retention. The infrastructure audit agent confirmed:
- **7-day time-based pruning** runs after every cron execution (`cron-logger.ts:173-191`)
- **5000-row safety valve** if time-based prune fails
- P1 recommendation #4 ("Add cron_runs retention") is **no longer needed** — it already exists.

---

*Generated 2026-03-21. Data window: 2026-03-18 through 2026-03-21 (3 days, 11,498 runs). Code audit: 5 parallel agents, ~25 minutes, 160+ file reads.*
