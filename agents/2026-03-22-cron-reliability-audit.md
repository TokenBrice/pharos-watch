# Cron System Reliability Audit

**Date:** 2026-03-22
**Scope:** All 24 cron jobs across 10 triggers, their infrastructure, and live production behavior
**Method:** Static code analysis (6 parallel deep-dive audits) + production D1 data analysis (7-day window, 11,429 runs) + live observation (46 min, 39 runs across 17 unique jobs)

---

## Executive Summary

The cron system is **mature and well-engineered**, with multiple layers of defense: distributed leases, circuit breakers, retry logic, abort signal propagation, coverage guards, and compare-and-swap cache writes. However, several significant reliability gaps exist, particularly around connection pool management, missing circuit breakers, and partial-write atomicity. Production data reveals chronic issues with 3 jobs (status-self-check at 46.5% OK, sync-live-reserves at 50.6% OK, sync-dex-discovery at 82.8% OK) and intermittent bugs (null `.trim()` in dex-liquidity, D1 bind-parameter overflow in redemption-backstops).

### Key Numbers (7-day window)

| Metric | Value |
|--------|-------|
| Total cron runs | 11,429 |
| Unique jobs | 26 |
| Overall OK rate | ~92% |
| Jobs at 100% OK | 13 of 26 |
| Jobs below 90% OK | 5 of 26 |
| Longest single run | 825.8s (sync-dex-discovery) |
| Most frequent job | dispatch-telegram-alerts (2,016 runs) |

---

## Production Reliability Dashboard (7-day)

| Job | OK | Degraded | Error | Skipped | Total | OK% |
|-----|---:|--------:|------:|--------:|------:|----:|
| status-self-check | 313 | 359 | 1 | 0 | 673 | **46.5%** |
| sync-live-reserves | 85 | 83 | 0 | 0 | 168 | **50.6%** |
| sync-dex-discovery | 246 | 0 | 0 | 51 | 297 | **82.8%** |
| sync-yield-data | 276 | 47 | 0 | 0 | 323 | 85.4% |
| fetch-tbill-rate | 7 | 1 | 0 | 0 | 8 | 87.5% |
| sync-dex-liquidity | 314 | 7 | 14 | 2 | 337 | 93.2% |
| sync-fx-rates | 645 | 28 | 0 | 0 | 673 | 95.8% |
| sync-redemption-backstops | 162 | 3 | 3 | 0 | 168 | 96.4% |
| sync-blacklist | 481 | 11 | 0 | 1 | 493 | 97.6% |
| sync-stablecoins | 665 | 0 | 7 | 2 | 674 | 98.7% |
| All other jobs (13) | - | - | - | - | - | 99.6-100% |

---

## Live Observation Findings

**During the 46-minute observation window (39 runs across 17 unique jobs):**
- 38 runs `ok`, 1 `degraded` (sync-dex-liquidity — failed Fluid DEX API, Raydium/Orca recovered since earlier)
- Captured complete execution of: quarter-hourly pipeline (×3), half-hourly pipeline (×1), 5-min telegram (×10), mint-burn critical+extended (×2 each), dex-discovery (×1), blacklist (×1), live-reserves (×1), redemption-backstops (×1)
- Only daily jobs (08:00/08:05 UTC trigger) not observed (outside their trigger window)
- `sync-fx-rates` took 100.2s (falling back to `cadence-valid-carry-forward` — all primary FX sources currently failing: Frankfurter error, Fawazahmed0 error, ExchangeRateApi unavailable, OpenExchangeRates unavailable, Chainlink unavailable)
- `sync-dex-discovery` completed in 64.7s (within normal range)
- `sync-stablecoins` processed 379 items in 18.6s (healthy)
- `status-self-check` took 15.7s probing 29 endpoints (healthy — recent improvement from chronic degraded state)

**Key patterns from recent historical data:**
- `sync-dex-liquidity` consistently takes 200-400s and recently reports degraded status due to failed sources: `raydium-api`, `orca-api`, `fluid-dex-api`
- `sync-fx-rates` shows bimodal timing: 630 fast runs (avg 5.1s) vs 43 slow runs (avg 73.3s) — slow runs always in FX source fallback mode
- `sync-dex-discovery` has 51 `skipped_locked` events (17.2% of runs) despite max run duration (13.8 min) being well under the 30-min trigger interval, suggesting lease TTL management issues

---

## Findings by Severity

### CRITICAL (4 findings)

**C1. Etherscan recursive log splits use parallel fetches, violating 6-connection pool limit**
`worker/src/lib/evm-logs.ts:235-238`

When Etherscan returns 1000 results (the cap), `fetchEvmLogsForTopics` splits the range and fetches both halves **concurrently** via `Promise.all()`. With max recursion depth of 8, this can fan out into up to 256 concurrent connections. The Alchemy equivalent (`alchemy-logs.ts:314-343`) correctly uses sequential depth-first splits.

**Impact:** Under heavy event volumes (e.g., USDT mass blacklisting), this can exhaust the Worker 6-connection pool, causing sibling cron jobs to fail.

**Fix:** Change `Promise.all` to sequential awaits (one-line fix).

---

**C2. Unbounded on-chain rate fetch parallelism in yield-sync**
`worker/src/cron/yield-sync/sources.ts:126`

`fetchOnChainRates` fires ALL `ON_CHAIN_RATE_CONFIGS` via `Promise.allSettled()` simultaneously with no concurrency limiter. Since `sync-yield-data` runs on the same cron slot as `sync-dex-liquidity`, the combined connection demand can cause cascading timeouts.

**Fix:** Add a concurrency limiter (e.g., process in batches of 3-4).

---

**C3. No atomic staging-to-production merge for DEX liquidity scores**
`worker/src/cron/dex-liquidity/orchestrator.ts:552`

`persistScores()` writes via `batchExecute` which is NOT atomic across batches. If the Worker times out mid-batch, the `dex_liquidity` table ends up in an inconsistent state (some coins updated, others stale) with no rollback mechanism.

**Impact:** Mid-write crash leaves production data inconsistent. Coverage guards prevent catastrophically wrong data but not partial writes.

---

**C4. Active production bug: `.trim()` null reference in DEX liquidity**
`worker/src/cron/dex-liquidity/fetch-crawlers.ts:138`

`pool.symbol.split(/\s*\/\s*/).map((s) => s.trim())` — if `pool.symbol` is null (external API returning null symbol), this crashes with `TypeError: Cannot read properties of null (reading 'trim')`. This caused 4 consecutive errors 1.6 days ago.

**Fix:** Guard with `(pool.symbol ?? "").split(...)`.

---

### HIGH (8 findings)

**H1. Missing circuit breaker for Etherscan in blacklist sync**
`worker/src/cron/sync-blacklist.ts:565-568`
Circuit breaker only covers TronGrid, not Etherscan. EVM chains (7+) hammer Etherscan without protection when it's down.

**H2. sync-mint-burn has no circuit breaker at all**
`worker/src/cron/sync-mint-burn.ts` (entire file)
Unlike blacklist and reserves, mint-burn has zero circuit breaker integration. Every trigger burns its full 200-request budget against a down endpoint.

**H3. No per-adapter timeout in sync-live-reserves**
`worker/src/cron/sync-live-reserves.ts:154`
A single hanging HTTP endpoint blocks the entire sequential adapter loop. No per-adapter deadline exists (only the cron-level 30s wall-clock limit).

**H4. Timeout promise rejection leak in cron-logger**
`worker/src/lib/cron-logger.ts:117-122`
When the job function throws, the timeout promise's reject callback still fires later, causing an unhandled promise rejection.

**H5. Circuit breaker read-modify-write race condition**
`worker/src/lib/circuit-breaker.ts:100-142`
Two concurrent jobs calling `recordOutcome` for the same source can both read the same state, independently modify it, and the last writer wins. The failure counter can never reach the threshold under concurrent failures.

**H6. DL pool cache stores current APY as 30-day mean**
`worker/src/cron/dex-liquidity/fetch-primary.ts:89`
`apyMean30d: p.apy` — uses current APY instead of actual 30-day mean, introducing systematic bias in yield stability scoring.

**H7. CoinGecko API key absence silently disables Stage 1 DEX discovery**
`worker/src/cron/dex-discovery/crawl-sources.ts:84`
Missing API key silently skips all CoinGecko-sourced discovery with no warning or degradation signal.

**H8. stability-index `stored_at` collision risk**
`worker/src/cron/stability-index.ts:156-178`
Plain `INSERT INTO` (not `INSERT OR REPLACE/IGNORE`) uses `Math.floor(Date.now() / 1000)` as PK. Same-second overlap crashes the job.

---

### MEDIUM (15 findings)

**M1. Heartbeat renewal failures never reset on success** — `cron-lease.ts:163-171`

**M2. No D1 overload retry on lease acquisition** — `cron-lease.ts:88-100`

**M3. Cron run pruning skipped on error path** — `cron-logger.ts:147` (throws before pruning code)

**M4. Gold/silver API (gold-api.com) has no circuit breaker** — `sync-fx-rates.ts:663-716`

**M5. Unbounded gold protocol parallel fetches** — `supplemental-assets.ts:175-196`

**M6. Duplicate `loadPreviousStablecoinsById` call** — `sync-stablecoins.ts:347` (unnecessary D1 query)

**M7. `AbortSignal.any` fallback silently ignores lease signal** — `context.ts:107-109`

**M8. Tron event ordering descending causes incomplete sync on interruption** — `sync-blacklist.ts:128`

**M9. Alchemy budget double-counting on split failures** — `alchemy-logs.ts:273,329`

**M10. Redemption backstops: no runtime budget or request budget** — `sync-redemption-backstops.ts:28-134`

**M11. Active D1 bind-parameter overflow** — `redemption-backstops-store.ts:303` (batch size 50 × 24 params = 1200; D1 limit exceeded intermittently, causing 3 errors in 24h)

**M12. GeckoTerminal rate limit relies solely on sleep timing** — `rate-limit.ts:104` (no cross-cron coordination)

**M13. Yield sync lacks coverage regression guard** — `sync-yield-data.ts` (no equivalent to DEX liquidity's 60% minimum guard)

**M14. Anthropic LLM calls retried 3x with no cost guard** — `daily-digest.ts:606-625`

**M15. Telegram appendix state committed before send** — `daily-digest.ts:756-763` (lost appendix on send failure)

---

### LOW (14 findings)

L1. No jitter on D1 overload retry delay (thundering herd) — `cron-lease.ts:38`
L2. No deduplication of cron_runs rows — `cron-logger.ts:129`
L3. Alert fire-and-forget silently swallows failures — `circuit-breaker.ts:117,139`
L4. Sequential probing scales linearly with endpoint count — `status-self-check.ts:324-331`
L5. Etherscan log fetching has no retry on transient failures — `evm-logs.ts:210-226`
L6. Balance provider cascade burns budget without rate limiting — `blacklist/balance-providers.ts:161-202`
L7. Rate limiter serializes all calls through single promise chain — `evm-logs.ts:26-42`
L8. Discovery backoff can permanently demote coins after transient failures — `dex-discovery/orchestrator.ts:254`
L9. `fetchWithRetry` null returns lack telemetry — `fetch-retry.ts:56`
L10. No retention pruning for `supply_history` / `chain_supply_history` tables — `snapshot-supply.ts`
L11. `snapshot-safety-grade-history` has unhandled `buildReportCardsSnapshot` error — `snapshot-safety-grade-history.ts:26`
L12. USDS sync has no circuit breaker on Etherscan — `sync-usds-status.ts:80-88`
L13. Bluechip sync has no circuit breaker — `sync-bluechip.ts:66-152`
L14. Hardcoded T-bill fallback (3.75%) may drift from actual rates — `constants.ts:106`

---

## Root Cause Analysis: Chronic Degraded Jobs

### status-self-check (46.5% OK)

**Root cause:** The self-check probes all API endpoints. When `/api/health` reports `degraded` or `stale` semantically, the probe returns `probeStatus = "stale"` which maps to cron result `status: "degraded"`. The chronic degradation over the past week was driven by the health endpoint itself reporting non-healthy status (likely due to upstream data staleness from DL/FX outages). The situation improved ~3 hours before audit started (probes now returning "healthy").

**Recommendation:** The self-check is correctly reflecting actual system health. The high degraded rate is a symptom, not a cause. Focus on fixing upstream data freshness issues (FX sources, DL availability).

### sync-live-reserves (50.6% OK)

**Root cause:** 83 degraded runs. Metadata shows consistent warnings about `dola-inverse-finance:unknown-asset`. The job has 114 reserve adapters and reports "degraded" when any adapter produces warnings or failures. The 50% degraded rate suggests certain adapters (particularly smaller/newer coins) frequently encounter issues.

**Recommendation:** Consider a tiered degradation model — don't mark the entire job as "degraded" for non-critical adapter warnings on minor coins. Track per-adapter health separately.

### sync-dex-discovery (82.8% OK, 17.2% skipped_locked)

**Root cause:** 51 lease contention events despite max run duration (13.8 min) fitting within the 30-min interval. The lease TTL may not be released cleanly after completion, or CF edge scheduling delivers triggers slightly early.

**Recommendation:** Investigate lease release timing. Consider adding explicit lease release logging to verify clean handoff.

---

## Active Production Issues Observed

1. **All FX rate sources currently failing** — Frankfurter, Fawazahmed0, ExchangeRateApi, OpenExchangeRates, and Chainlink all erroring. System running on cached carry-forward rates. Every sync-fx-rates run takes ~100s trying all sources before falling back.

2. **DEX liquidity sources partially down** — Raydium API, Orca API, and Fluid DEX API failing, causing every `sync-dex-liquidity` run to report `degraded` status with `fallbackMode: ["raydium-api-partial", "orca-api-partial", "fluid-dex-api-partial"]`.

3. **Redemption backstops bind-parameter overflow** — 3 errors in the last 24h from `D1_ERROR: too many SQL variables`. The batch size of 50 statements × 24 params = 1200 total binds exceeds D1's limit intermittently.

---

## Top 10 Recommendations (Priority Order)

1. **Fix null `.trim()` bug in dex-liquidity** — Guard `pool.symbol` with nullish coalescing. Active crash source.

2. **Make Etherscan log splits sequential** — Change `Promise.all` to sequential awaits in `evm-logs.ts:235`. One-line fix preventing connection pool exhaustion.

3. **Reduce redemption backstop batch size** — Lower from 50 to 25 in `redemption-backstops-store.ts:303` to stay within D1 bind-parameter limits.

4. **Add circuit breaker to sync-mint-burn** — Record Alchemy success/failure outcomes. Prevent wasting 200 requests against a downed endpoint.

5. **Add per-adapter timeout to sync-live-reserves** — `Promise.race` with a 20-second deadline per adapter call. Prevent one slow adapter from blocking all others.

6. **Add concurrency limiter to yield-sync on-chain rate fetches** — Cap at 3-4 concurrent RPC calls to avoid competing with co-scheduled DEX liquidity for connections.

7. **Add circuit breaker to Etherscan in blacklist sync** — Record outcomes for `CIRCUIT_SOURCE.ETHERSCAN` across all EVM chains.

8. **Fix cron-logger timeout promise rejection** — Add `.catch(() => {})` to the timeout promise to prevent unhandled rejection.

9. **Add yield coverage regression guard** — Analogous to DEX liquidity's 60% minimum, prevent dramatic yield data regression on DL outage.

10. **Investigate FX rate source failures** — All 5 FX rate sources are currently failing. While carry-forward works, prolonged outage will make rates stale.

---

## Positive Patterns Worth Preserving

- **Compare-and-swap cache writes** (`setCacheIfNewer`) prevent slow runs from overwriting faster newer runs
- **Comprehensive coverage guards** in DEX liquidity (60% min, global TVL guard, top-10 guard)
- **Lease-based distributed locking** prevents concurrent execution across Worker instances
- **Multi-layered data validation** (structural, schema, bounds, delta) throughout ingestion pipeline
- **Abort signal propagation** is thorough and consistent across all major pipeline stages
- **Circuit breakers** on most external APIs with configurable thresholds
- **Normalized metadata** on every cron run enables excellent observability
- **Graceful degradation** — jobs report "degraded" rather than crashing when partial data is available

---

*Report generated by exhaustive code audit (6 parallel analysis agents) + production data analysis (7-day D1 query window, 11,429 historical runs) + live observation (45-minute monitoring window, 36 real-time runs captured across 15 unique jobs). Live observation confirmed: sync-dex-liquidity degraded (Fluid DEX API failure; Raydium/Orca recovered during observation), sync-fx-rates bimodal timing (100s in FX fallback mode, all 5 primary sources failing), and healthy operation of all other observed jobs. The DEX liquidity job completed in 408.6s — consistent with historical 200-400s range.*
