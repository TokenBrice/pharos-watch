# Cron Pipeline Audit — 2026-03-15

## Executive Summary

The Pharos cron pipeline runs **24 runtime jobs across 10 trigger slots**, tracked via the `cron_runs` D1 table and `/api/status`. Overall the system is well-architected with proper sequential chaining for connection-pool safety and lease-based concurrency control.

**Health verdict: Operationally sound but with 3 persistent degradation signals and 1 systemic issue inflating noise.**

### Key Numbers (7-day window, 9,852 total runs)

| Metric | Value |
|---|---|
| Total unique jobs observed | 25 (24 active + 1 ghost) |
| Tracked jobs | 23 |
| Overall error rate | 0.5% (47 errors / ~9,800 runs) |
| Most reliable | stability-index, snapshot-supply, compute-dews, snapshot-psi (0% error, 0% degraded) |
| Most problematic | sync-blacklist (5% error, 54% degraded), status-self-check (0.3% error, 69% degraded) |

---

## Slot-by-Slot Analysis

### Slot 1: Quarter-Hourly (`*/15 * * * *`) — SHARED

**Jobs (6, strictly sequential):** sync-stablecoins → snapshot-supply → sync-fx-rates → stability-index → compute-dews → status-self-check

| Job | Avg (s) | Max (s) | Runs/24h | Errors | Degraded |
|---|---|---|---|---|---|
| sync-stablecoins | 26.0 | 76.5 | 96 | 1 | 0 |
| snapshot-supply | 0.9 | 3.8 | 96 | 0 | 0 |
| sync-fx-rates | 3.1 | 10.5 | 96 | 0 | 0 |
| stability-index | 1.1 | 2.5 | 95 | 0 | 0 |
| compute-dews | 3.0 | 9.4 | 95 | 0 | 0 |
| status-self-check | 16.5 | 36.3 | 96 | 0 | **96** |

**Slot wall clock:** 24–47s typical, well within the 900s window (~3–5% utilization).

**Sequencing:** Correct. `sync-stablecoins` produces the cache that downstream jobs depend on. `snapshot-supply` only runs if `stablecoinsCache` capability is set. `stability-index` requires both `stablecoinsCache` and `depegPipeline`. Dependencies are enforced in code.

**Issues:**
- **status-self-check is 100% degraded** in the last 24h (96/96) and 69% over 7d (462/673). Root cause: the `/api/health` probe reports `"reported-degraded"` because `rawOverallStatus` evaluates to `"stale"`. This creates a feedback loop: the self-check detects the stale status, records itself as degraded, which doesn't fix the underlying stale condition. The stale status is likely driven by data-quality thresholds (on-chain supply staleness, blacklist gaps, or reserve composition issues). **This is a systemic noise issue — the self-check faithfully reports a real condition, but the 100% degraded rate makes it useless as a change detector.**
- stability-index and compute-dews both missed 1 run in 24h (95 vs 96) — these are expected skips when `sync-stablecoins` doesn't produce a safe depeg pipeline.

---

### Slot 2: 20-min Blacklist (`3,23,43 * * * *`) — ISOLATED

**Job:** sync-blacklist

| Metric | 24h | 7d |
|---|---|---|
| Runs | 68 | 499 |
| Avg duration | 122s (2 min) | 162s (2.7 min) |
| Max duration | 391s (6.5 min) | 480s (8 min) |
| Errors | 0 | 25 (5%) |
| Degraded | 7 | 269 (54%) |
| Timeout | 720s (12 min) | — |

**Issues:**
- **5% error rate over 7 days**, almost entirely CronTimeoutErrors at the old 480s limit. The timeout was raised to 720s (12 min) and recent 24h shows 0 errors — the fix is working.
- **54% degraded over 7 days** — this indicates partial sync failures (some chains/contracts failing while others succeed). Etherscan circuit breaker is properly gating runs when the upstream is down.
- **High variance:** min 38s, max 391s (10x range). Runtime depends heavily on block explorer response times and backfill depth.
- 4 missing runs in 24h (68 vs expected 72) — likely circuit breaker skips when Etherscan was unavailable.

---

### Slot 3: 20-min Mint/Burn Critical (`4,24,44 * * * *`) — ISOLATED

**Job:** sync-mint-burn

| Metric | 24h | 7d |
|---|---|---|
| Runs | 71 | 508 |
| Avg duration | 7.1s | 13.5s |
| Max duration | 13.5s | 174.7s |
| Errors | 0 | 2 (0.4%) |

**Verdict:** Healthy. Fast, reliable, well within its 10-minute timeout. Max spike to 175s over 7d is well within the 600s timeout. Circuit breaker on Alchemy API is correctly wired.

---

### Slot 4: 20-min DEX Discovery (`6,26,46 * * * *`) — ISOLATED

**Job:** sync-dex-discovery

| Metric | 24h | 7d |
|---|---|---|
| Runs | 65 | 418 |
| Avg duration | 160s (2.7 min) | 174s (2.9 min) |
| Max duration | 792s (13.2 min) | 846s (14.1 min) |
| Skipped (locked) | 5 | 18 |
| Timeout | 960s (16 min) | — |

**Issues:**
- **Window pressure:** Runs on a 20-minute cycle but regularly takes 13+ minutes (66% window consumption). The 16-minute timeout provides only 1.9 minutes of headroom above the observed max (14.1 min). Most long runs show `budgetExhausted: true`, meaning the internal 13-minute deadline is doing its job, but the outer timeout nearly matches.
- **7 missing runs in 24h** (65 vs expected 72): 5 `skipped_locked` (lease contention from overlapping runs) + 2 likely from lease-locked skips not recorded. The lease mechanism is correctly preventing overlap but the skip rate suggests runs frequently overlap into the next window.
- **No errors in 24h**, 1 error over 7d. The job is resilient but pushes timing limits.

---

### Slot 5: 20-min Mint/Burn Extended (`13,33,53 * * * *`) — ISOLATED

**Job:** sync-mint-burn-extended

| Metric | 24h | 7d |
|---|---|---|
| Runs | 72 | 391 |
| Avg duration | 31.8s | 35.3s |
| Max duration | 56.2s | 108.8s |
| Errors | 1 | 1 (0.3%) |

**Verdict:** Healthy. Comfortably within its 10-minute timeout and 20-minute cycle. Per-config budget of 25 requests (vs 60 for critical lane) keeps it bounded.

---

### Slot 6: Half-Hourly (`10,40 * * * *`) — SHARED

**Jobs (3, chained):** sync-stablecoin-charts → sync-dex-liquidity → sync-yield-data

| Job | Avg (s) | Max (s) | Runs/24h | Errors | Degraded |
|---|---|---|---|---|---|
| sync-stablecoin-charts | 1.4 | 8.0 | 47 | 0 | 0 |
| sync-dex-liquidity | 134.2 | 180.9 | 47 | 0 | 0 |
| sync-yield-data | 7.4 | 27.7 | 47 | 0 | 2 |

**Slot wall clock:** ~137s (2.3 min) typical, well within 1800s window (~8% utilization).

**Sequencing:** Charts runs first (1s), then DEX liquidity (~130s), then yield sync (~6s). The chaining in code is `chartsSync.then(() => dexSync).then(() => yieldSync)` — correct sequential execution.

**Issues:**
- **sync-dex-liquidity dominates** at 95% of slot time but is very stable (124–181s range, no errors in 24h).
- Over 7d, sync-dex-liquidity had 4 errors (1.2%) and a max of 780s — these were CronTimeoutErrors at the 13-minute limit, likely from an upstream API degradation that has since resolved.
- sync-yield-data shows 2 degraded runs in 24h from FRED API errors (`risk-free-rate:fred-api-error-retained`). Falls back to cached rate correctly.
- 1 missing run in 24h (47 vs expected 48) — acceptable.

---

### Slot 7: Hourly (`11 * * * *`) — SHARED

**Jobs (2, sequential):** sync-live-reserves → sync-redemption-backstops

| Job | Avg (s) | Max (s) | Runs/24h | Errors | Degraded |
|---|---|---|---|---|---|
| sync-live-reserves | 39.4 | 74.7 | 24 | 0 | **22** |
| sync-redemption-backstops | 1.3 | 2.4 | 23 | 0 | 0 |

**Slot wall clock:** ~41s typical, well within 3600s window (~1% utilization).

**Issues:**
- **sync-live-reserves is 92% degraded in 24h** (22/24) and 66% over 7d (42/64). Consistent adapter failures for the same coins: `usd0-usual`, `ousd-origin-protocol`, `cusd-celo`, `wsrusd-reservoir`, `usde-ethena`. These are upstream API issues with specific protocol reserve endpoints.
- The job correctly marks itself degraded (not error) when some adapters fail. Total synced count remains 40–42 out of 44–45 configured, so 91–95% of reserves sync successfully.
- sync-redemption-backstops had 1 fewer run (23 vs 24) — it runs in the `finally` block after reserves, so it should always execute. Minor timing gap.

---

### Slot 8: 5-Minute Telegram (`2,7,12,17,...`) — ISOLATED

**Jobs (2, sequential):** dispatch-telegram-alerts → announce-cemetery-additions

| Job | Avg (s) | Max (s) | Runs/24h | Errors | Degraded |
|---|---|---|---|---|---|
| dispatch-telegram-alerts | 2.3 | 17.5 | 287 | 0 | 0 |
| announce-cemetery-additions | 0.7 | 2.8 | 287 | 0 | 0 |

**Slot wall clock:** ~3s typical in a 300s window (~1% utilization).

**Issues:**
- **Massive over-provisioning.** 288 triggers/day × ~3s = 864s total work/day. The 5-minute cadence was designed for rapid alert dispatch but the actual load is trivial. The slot has 99% idle time.

---

### Slot 9: Daily 08:00 UTC (`0 8 * * *`) — SHARED

**Jobs (5):** snapshot-supply (parallel) + snapshot-safety-grade-history (parallel) + snapshot-psi (parallel) + fetch-tbill-rate → sync-usds-status (chained)

| Job | Avg (s) | Max (s) | Runs/7d | Errors | Degraded |
|---|---|---|---|---|---|
| snapshot-supply | — | — | — | 0 | 0 |
| snapshot-safety-grade-history | 3.1 | 4.5 | 7 | 0 | 0 |
| fetch-tbill-rate | 7.2 | 32.7 | 7 | 0 | 2 |
| snapshot-psi | 1.4 | 2.8 | 7 | 0 | 0 |
| sync-usds-status | 2.0 | 4.2 | 7 | 0 | 0 |

**Verdict:** Healthy. All daily jobs are fast and reliable. `snapshot-supply` also runs on the quarter-hourly trigger (as a retry path), so the daily run is a safety net. DB-only snapshot jobs are parallelized; external-fetch jobs (fetch-tbill-rate → sync-usds-status) are correctly chained.

---

### Slot 10: Daily 08:05 UTC (`5 8 * * *`) — SHARED

**Jobs (3, parallel):** sync-bluechip + daily-digest + discovery-scan

| Job | Avg (s) | Max (s) | Runs/7d | Errors | Degraded |
|---|---|---|---|---|---|
| sync-bluechip | 5.4 | 6.6 | 7 | 0 | 0 |
| daily-digest | 19.1 | 21.8 | 7 | 0 | 0 |
| discovery-scan | 8.8 | 12.0 | 4 | 0 | 0 |

**Verdict:** Healthy. All three run in parallel via separate `ctx.waitUntil()` calls. Daily-digest (LLM call) is the slowest at ~20s, well within its 8-minute timeout.

**Note:** discovery-scan only has 4 runs in 7 days instead of expected 7. May have been deployed mid-week or had lease contention.

---

## Orphaned / Ghost Jobs

| Job | Status | Action |
|---|---|---|
| `dispatch-telegram-alerts-daily` | 2 rows from March 7–8. Removed from codebase. | No action — auto-prunes in 7 days |
| `announce-cemetery-additions` | Runs on telegram slot but intentionally excluded from CRON_INTERVALS tracking | By design |

---

## Improvement Suggestions

Ranked by **impact** (data freshness, reliability, noise reduction) and **implementation complexity/risk**.

### Tier 1: High Impact, Low Complexity

#### 1. Fix the status-self-check permanent degradation loop
**Impact:** High — the status page is permanently "stale/degraded", making it useless as a health signal.
**Complexity:** Low
**Risk:** Low

**Problem:** `rawOverallStatus` evaluates to `"stale"` (likely from data-quality thresholds — on-chain supply staleness, blacklist gaps, or reserve composition errors). The self-check probes `/api/health`, which reflects this stale status, and faithfully records itself as degraded. This creates a permanent noise floor.

**Recommendation:**
1. **Investigate the root cause** of the persistent "stale" `rawOverallStatus`. Query the live `/api/status` (admin endpoint) to identify which specific threshold is being exceeded: cache ratio, missing prices, blacklist gaps, on-chain supply staleness, or reserve composition.
2. **Likely suspects based on the data:**
   - `sync-live-reserves` fails 2–4 adapters every run → `reserveCompositionWarning` is probably always true → `dataQualityStatus = "degraded"` at minimum
   - `sync-blacklist` has 54% degraded rate → may cause `blacklistMissingRatio` to exceed thresholds
   - If either of these cross from "degraded" to "stale" thresholds, the overall status goes to "stale"
3. **Fix options (pick one or both):**
   - Tune the stale thresholds for data-quality metrics that are chronically exceeded by known-broken upstream APIs (e.g., exclude known-failing reserve adapters from the composition health score)
   - Add a `knownIssues` mechanism to the status evaluation that downgrades known-persistent issues from "stale" to "degraded"

#### 2. Stabilize sync-live-reserves adapter failures
**Impact:** Medium-High — reduces the 92% degraded rate and likely fixes a status-stale root cause.
**Complexity:** Low-Medium
**Risk:** Low

**Problem:** Same 4–5 adapters fail every run: `usd0-usual`, `ousd-origin-protocol`, `cusd-celo`, `wsrusd-reservoir`, `usde-ethena`.

**Recommendation:**
1. Investigate each failing adapter — are the upstream APIs permanently broken, rate-limited, or do they need different endpoints?
2. For persistently broken adapters, either fix the endpoint or mark them as `disabled` in config to stop the noise.
3. Consider adding a `expectedFailures` list to the reserve-sync job so it doesn't mark itself degraded for known-broken adapters.

#### 3. Clean up stale cron_runs data
**Impact:** Low (hygiene)
**Complexity:** Trivial
**Risk:** None

The `dispatch-telegram-alerts-daily` rows will self-prune. No action needed, but if you want to clean now:
```sql
DELETE FROM cron_runs WHERE job = 'dispatch-telegram-alerts-daily';
```

---

### Tier 2: Medium Impact, Medium Complexity

#### 4. Relieve sync-dex-discovery window pressure
**Impact:** Medium — reduces skip rate (7/72 in 24h = 10% miss rate) and prevents future timeout risk.
**Complexity:** Medium
**Risk:** Low-Medium

**Problem:** Discovery regularly runs 13+ minutes on a 20-minute cycle with a 16-minute timeout. 10% of runs are skipped due to lease contention (previous run still active when next trigger fires).

**Options (in order of preference):**

**A. Increase the trigger interval to 30 minutes.** Move from `6,26,46 * * * *` to a half-hourly slot (or create a new 30-min expression). This gives the 13-minute typical run 17 minutes of headroom instead of 7. The discovery job already uses a tiered cadence internally (t1/t2/t3/dormant), so less-frequent triggers would simply reduce the number of coins crawled per day. **Cost: 1 new trigger slot (you have >200 free).** Requires updating `CRON_SCHEDULES`, `CRON_JOB_DEFINITIONS`, and the slot handler.

**B. Reduce the internal crawl budget from 13 to 10 minutes.** This creates more headroom within the 20-minute window but reduces per-run coverage. The tiering system would compensate over time.

**C. Keep the current setup.** The 10% skip rate is acceptable because the lease mechanism prevents data corruption. Discovery is a background enrichment job, not a critical data path.

#### 5. Monitor and tune the blacklist sync degradation rate
**Impact:** Medium — the 54% degraded rate over 7 days is noisy.
**Complexity:** Medium
**Risk:** Low

**Problem:** More than half of blacklist syncs return "degraded" status. This likely comes from partial contract/chain failures during each run. The recent 24h shows improvement (7 degraded vs 54% over 7d), suggesting upstream recovery.

**Recommendation:**
1. Add per-chain/per-contract breakdown to the degraded metadata (if not already present) so you can identify which chains consistently fail.
2. Consider adding a `degraded-tolerance` config: if fewer than N contracts fail, still mark the run as "ok" (with a warning in metadata). This would reduce noise while preserving visibility.
3. The timeout increase from 480s to 720s has already eliminated the error rate. Monitor for 2 more weeks to confirm stability.

#### 6. Investigate FRED API failures in yield sync
**Impact:** Low-Medium — the cached fallback rate works but will go stale if FRED stays down.
**Complexity:** Low
**Risk:** None

**Problem:** `sync-yield-data` shows intermittent FRED API errors with `fallbackMode: "risk-free-rate:fred-api-error-retained"`, falling back to a cached rate of 3.71%.

**Recommendation:** Check the FRED API key/endpoint validity. If the API has changed endpoints or rate limits, update the config. If it's intermittent, the current fallback behavior is correct and no action is needed.

---

### Tier 3: Low Impact, Low Complexity (Nice-to-Haves)

#### 7. Consider relaxing the Telegram alert dispatch cadence
**Impact:** Negligible — reduces trigger count but alerts are already near-instant.
**Complexity:** Trivial
**Risk:** Very Low

**Current state:** 288 triggers/day, ~3s execution each (1% utilization). The 5-minute cadence was designed for rapid alert dispatch but the actual workload is trivial.

**Consideration:** A 10-minute cadence would halve triggers to 144/day with no practical impact on alert timeliness (worst-case delay increases from 5 min to 10 min). However, the current setup is working fine and uses minimal resources. **Only worth doing if you're hitting Cloudflare trigger slot limits or want to reduce D1 writes** (each run writes a cron_runs row + progress upsert).

#### 8. Add P95 duration tracking to status metadata
**Impact:** Low (observability improvement)
**Complexity:** Low
**Risk:** None

The cron_runs table has all the data but the status API only shows the last 10 runs. Adding P95/P99 percentile tracking for the most variable jobs (sync-blacklist, sync-dex-discovery, sync-stablecoins) would make it easier to spot trends.

#### 9. Parallelize independent quarter-hourly jobs
**Impact:** Low (wall clock reduction from ~45s to ~25s, but the window is 900s)
**Complexity:** Medium
**Risk:** Medium (connection pool contention)

Currently, all 6 quarter-hourly jobs run sequentially to respect the 6-connection pool limit. However, the DB-only jobs (snapshot-supply, stability-index, compute-dews) don't use external fetch connections. They could theoretically run in parallel with the fetch-heavy jobs after sync-stablecoins completes.

**Not recommended yet** — the current 45s total is only 5% of the 900s window. The risk of connection pool contention outweighs the marginal benefit.

---

## Timing Diagram (Representative Quarter-Hourly Slot)

```
T+0s   ┌─── sync-stablecoins ──────────────────────┐ (~20s)
T+20s  ├─ snapshot-supply ─┤ (~1s)
T+21s  ├─── sync-fx-rates ───┤ (~3s)
T+24s  ├─ stability-index ─┤ (~1s)
T+25s  ├── compute-dews ──┤ (~3s)
T+28s  ├──────── status-self-check ────────────┤ (~15s)
T+43s  └─ Done
       ·───────────────────────────────────── 900s window ─────────────────────────────────────┘
```

## Timing Diagram (Representative Half-Hourly Slot)

```
T+0s   ├ charts ┤ (~1s)
T+1s   ├───────────────── sync-dex-liquidity ──────────────────┤ (~130s)
T+131s ├─ yield ─┤ (~6s)
T+137s └─ Done
       ·─────────────────── 1800s window ────────────────────────────────────────────────────────┘
```

## Timing Diagram (Representative DEX Discovery Slot — Heavy Run)

```
T+0s   ├─────────────────────── sync-dex-discovery ─────────────────────────┤ (~780s / 13 min)
       ·                                                                    ·
       ·───────────── 1200s (20 min) window ────────────────────────────────·
       ·                                                    ▲               ·
       ·                                          budget exhausted          ·
       ·                                               (13 min)            ·
```

---

## Run Count Accuracy (24h)

| Slot | Expected | Actual | Miss Rate |
|---|---|---|---|
| Quarter-hourly (sync-stablecoins) | 96 | 96 | 0% |
| 5-min telegram | 288 | 287 | 0.3% |
| Blacklist | 72 | 68 | 5.6% |
| Mint/burn critical | 72 | 71 | 1.4% |
| Mint/burn extended | 72 | 72 | 0% |
| DEX discovery | 72 | 65 | **9.7%** |
| Half-hourly (charts) | 48 | 47 | 2.1% |
| Hourly (reserves) | 24 | 24 | 0% |
| Daily 08:00 | 1 | 1 | 0% |
| Daily 08:05 | 1 | 1 | 0% |

---

## Architecture Observations

**What's working well:**
- The lease-based concurrency control prevents data corruption from overlapping runs
- Sequential chaining within shared slots correctly respects the 6-connection pool
- Circuit breakers on Etherscan and Alchemy properly gate runs when upstreams are down
- The tiered discovery system (t1/t2/t3/dormant) self-regulates crawl depth
- Daily jobs are well-split across 08:00 and 08:05 slots for connection headroom
- DB-only snapshot jobs are correctly parallelized in the daily slot

**Slot utilization summary:**

| Slot | Typical Runtime | Window | Utilization |
|---|---|---|---|
| Quarter-hourly | ~45s | 900s | 5% |
| Blacklist | ~120s | 1200s | 10% |
| Mint/burn critical | ~7s | 1200s | 0.6% |
| DEX discovery | ~160s (up to 780s) | 1200s | **13–65%** |
| Mint/burn extended | ~32s | 1200s | 2.7% |
| Half-hourly | ~137s | 1800s | 7.6% |
| Hourly | ~41s | 3600s | 1.1% |
| 5-min telegram | ~3s | 300s | 1% |
| Daily 08:00 | ~15s | 86400s | 0.02% |
| Daily 08:05 | ~25s | 86400s | 0.03% |

**Only DEX discovery has meaningful window pressure.** All other slots have >90% headroom.

---

## Remediation Status (2026-03-15)

All Tier 1 and Tier 2 fixes have been implemented:

| # | Fix | Status | Details |
|---|-----|--------|---------|
| 1 | Status-self-check permanent degradation | **Done** | Root cause: 2 permanently broken reserve adapters (usd0-usual, ousd) → open circuits → health "degraded" → self-check "degraded"; plus blacklist gap ratio 0.53% barely over 0.5% threshold; plus zero-tolerance `reserveCompositionWarning`. Fixed by disabling broken adapters, raising blacklist `missingRatioDegraded` from 0.5% to 1%, making reserve warning proportional (≥10% or 3+ issues), and requiring ≥3 open circuits before health degrades. |
| 2 | Stabilize sync-live-reserves adapters | **Done** | Disabled `usd0-usual` (missing DefiLlama price for UsualM token) and `ousd-origin-protocol` (deprecated API endpoint, 404). Cleaned up D1 circuit breaker and sync state rows. |
| 3 | Clean up stale cron_runs data | **Done** | Deleted `dispatch-telegram-alerts-daily` ghost rows from D1. |
| 4 | DEX discovery window pressure | **Done** | Moved from 20-min to 30-min cycle (`6,26,46` → `6,36`). Internal deadline 13→20 min, timeout 16→23 min. |
| 5 | Blacklist sync degradation rate | **Done** | Changed from `apiErrors > 0 → degraded` to 25% proportional threshold (`degradedThreshold = max(1, ceil(configs * 0.25))`). |
| 6 | FRED API failures | **Done** | Increased `FRED_FETCH_MAX_RETRIES` from 1 to 2. |

### Changes by file

**Code:**
- `shared/lib/stablecoins.ts` — Disabled liveReservesConfig for usd0-usual and ousd-origin-protocol
- `shared/lib/cron-jobs.ts` — DEX discovery moved to half-hourly group, schedule key renamed, twenty-minute group description updated
- `shared/lib/status-thresholds.ts` — Blacklist `missingRatioDegraded` raised from 0.005 to 0.01
- `worker/wrangler.toml` — DEX discovery trigger changed from `6,26,46` to `6,36`
- `worker/src/handlers/scheduled.ts` — Schedule key updated to `thirtyMinuteDexDiscovery`
- `worker/src/cron/dex-discovery/orchestrator.ts` — Internal deadline raised from 13 to 20 minutes
- `worker/src/lib/cron-lease.ts` — sync-dex-discovery timeout raised from 16 to 23 minutes
- `worker/src/lib/constants.ts` — FRED_FETCH_MAX_RETRIES increased from 1 to 2
- `worker/src/cron/sync-blacklist.ts` — Proportional error tolerance (25% degraded, 50% error)
- `worker/src/api/status.ts` — Reserve composition warning uses proportional threshold (≥10% or 3+)
- `worker/src/api/health.ts` — Open circuit threshold changed from ANY to ≥3

**D1 cleanup (post-deploy):**
- Deleted `dispatch-telegram-alerts-daily` from cron_runs
- Deleted circuit breaker records for `live-reserves:usd0-usual` and `live-reserves:ousd`
- Deleted reserve_sync_state rows for `usd0-usual` and `ousd-origin-protocol`

**Docs updated:**
- `docs/dex-liquidity.md`, `docs/worker-infrastructure.md`, `docs/mint-burn-flows.md`, `docs/data-flow-map.md`, `docs/status-dashboard.md`, `docs/methodology-page.md`, `docs/liquidity-score-timeline.md`, `README.md`
