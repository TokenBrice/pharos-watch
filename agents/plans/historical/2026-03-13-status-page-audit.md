# Status Page Audit Report

**Date:** 2026-03-13
**Scope:** Full accuracy audit of `/status` — frontend, backend, shared config, and documentation cross-references.
**Goal:** Identify every place the status page halluccinates, infers, hardcodes, or misrepresents data.

---

## Executive Summary

The status page is architecturally sound — its data pipeline flows from real DB queries through a well-typed `StatusResponse` contract. However, the audit found **21 issues** across 4 categories:

| Category | Count | Severity |
|----------|-------|----------|
| Threshold duplication (frontend re-implements backend thresholds) | 5 | High |
| Ungrounded UI copy (describes behavior without data backing) | 6 | Medium |
| Data contract mismatches (phantom codes, doc drift, dual scheduling) | 6 | Medium |
| Minor validation gaps (nullability, hardcoded constants) | 4 | Low |

No critical data fabrication was found — the page does not invent data. The primary risk is **threshold drift**: the frontend hardcodes the same thresholds the backend uses for severity classification, creating a maintenance coupling where a backend threshold change silently desynchronizes the UI labels.

---

## Category 1: Threshold Duplication (High)

These are places where the frontend re-implements backend severity thresholds as hardcoded values. If the backend thresholds change, the UI labels become wrong.

### 1.1 Data Quality Cards — Missing Price Thresholds

**Files:**
- Frontend: `src/components/status/data-quality-cards.tsx:56,64-66`
- Backend: `worker/src/api/status.ts:404-425`

**Issue:** The detail string hardcodes `warn >15%, stale >40%` and the severity color logic uses `missingPriceRatio > 0.4` (red) / `> 0.15` (amber). These match the backend today but are duplicated, not sourced.

**Remediation:** Export thresholds from `worker/src/lib/status-thresholds.ts` into `shared/lib/` so both frontend and backend reference the same constants.

### 1.2 Data Quality Cards — Blacklist Gap Thresholds

**Files:**
- Frontend: `src/components/status/data-quality-cards.tsx:75,78-80`
- Backend: `worker/src/api/status.ts:406-408` + `worker/src/lib/status-thresholds.ts:4-9`

**Issue:** Detail string hardcodes `warn >=0.5%, stale >=2%` and severity logic uses `>= 0.02` / `>= 0.005`. These match `STATUS_BLACKLIST_THRESHOLDS` today but are duplicated.

**Remediation:** Same as 1.1 — move to shared.

### 1.3 Data Quality Cards — On-chain Staleness/Divergence Thresholds

**Files:**
- Frontend: `src/components/status/data-quality-cards.tsx:91,96,113,118`
- Backend: `worker/src/lib/status-thresholds.ts:11-17`

**Issue:** Detail strings hardcode `warn >=10%, stale >=25%` and severity logic uses `>= 0.25` / `>= 0.1`. These match `STATUS_ONCHAIN_THRESHOLDS` today.

**Remediation:** Same as 1.1.

### 1.4 Cache Freshness Table — Ratio Thresholds

**Files:**
- Frontend: `src/components/status/cache-freshness-table.tsx:25,32`
- Backend: `worker/src/api/status.ts:395-398`

**Issue:** Color logic uses `ratio > 2` (stale) and `ratio > 1.5` (degraded). Matches backend availability status synthesis but is duplicated.

**Remediation:** Export these as shared constants alongside the quality thresholds.

### 1.5 Price Source Health — Confidence Severity Bands

**File:** `src/components/status/price-source-health.tsx:24-32`

**Issue:** Color bands for price confidence are pure frontend heuristics:
- High confidence: `> 85%` green, `> 70%` amber, else red
- Missing: `=== 0` green, `<= 3` amber, else red
- Low: `<= 5` neutral, `<= 10` amber, else red

These have no backend equivalent — the backend provides raw counts but no severity classification for price source health. These are reasonable UI heuristics but could mislead operators into thinking they reflect backend-defined thresholds.

**Remediation:** Either (a) prefix the detail text with "UI heuristic:" or (b) define these in shared config as official thresholds.

---

## Category 2: Ungrounded UI Copy (Medium)

These are places where descriptive text explains system behavior without sourcing that explanation from data.

### 2.1 Mint/Burn Reconciliation — Behavioral Description

**File:** `src/components/status/mint-burn-reconciliation.tsx:95-96`

**Copy:** _"Compares 24h Ethereum mint/burn net flow against the stablecoins cache's Ethereum chain-supply delta. Large gaps point to coverage or upstream chain-distribution mismatches."_

**Issue:** The 24h window is accurate (hardcoded in `getMintBurnReconciliation`), but "large gaps" is undefined — the actual thresholds are `$100M / 30%` (critical) and `$25M / 12%` (warn) in `worker/src/api/status-derived-data.ts:412-414`, which are not documented anywhere.

**Remediation:** Document reconciliation thresholds in `docs/status-dashboard.md` and reference them in the UI detail text.

### 2.2 Endpoint Health Grid — Skip List Description

**File:** `src/components/status/endpoint-health-grid.tsx:47-51`

**Copy:** _"Probe coverage skips routes that require volatile parameters or a known dated snapshot, such as digest snapshots."_

**Issue:** Describes which routes are skipped without showing the actual skip list. The real exclusion is `digest-snapshot` (no `probeGroup` in `shared/lib/api-endpoints.ts:249-256`). Copy is accurate today but makes a general claim that could drift.

**Remediation:** Low priority — consider generating skip-list text from the endpoint registry.

### 2.3 Recommended Action Strip — Empty-State Copy

**File:** `src/components/status/recommended-action-strip.tsx:22`

**Copy:** _"The system is holding. Use the lane order below to sweep for softer pressure, not to chase an active breach."_

**Issue:** Prescriptive operator guidance that isn't data-backed. Harmless but could be confusing if shown during an actual incident that has no mapped recommendations.

**Remediation:** No code change needed — flag as editorial copy, not data-driven.

### 2.4 Discovery Candidates — Hardcoded Market Cap Threshold

**File:** `src/components/status/discovery-candidates.tsx:50`

**Copy:** _"No untracked stablecoins above $5M found."_

**Issue:** The `$5M` threshold is real (`worker/src/cron/discovery-scan.ts:8`, `DISCOVERY_MIN_MCAP = 5_000_000`) but hardcoded in both places independently. If the backend threshold changes, the UI copy becomes wrong.

**Remediation:** Move `DISCOVERY_MIN_MCAP` to `shared/lib/` and import in both the cron and the UI.

### 2.5 Status Banner — Recovery Hold Explanation

**File:** `src/components/status/status-banner.tsx:147-148`

**Copy:** _"Effective status is still holding {status} while the latest raw sweep is already {rawStatus}."_

**Issue:** This is derived from `isRecoveryHold()` in `top-fold-copy.ts:82-87`, which compares effective vs raw status severity. The logic correctly identifies recovery holds, but the copy implies knowledge of the state machine's intent without referencing the actual hysteresis counters from `data.state`.

**Remediation:** Low priority — the derivation is accurate but could be strengthened by showing the remaining recovery checks needed (from `state.consecutiveRaw`).

### 2.6 Liquidity Health — Guard Status Labels

**File:** `src/components/status/liquidity-health.tsx:93-101`

**Issue:** Renders boolean guard flags as `"near threshold"` vs `"normal"` without exposing what the threshold value is or how "near" is defined. The actual guard logic is in `worker/src/cron/dex-liquidity/orchestrator.ts` with specific percentage calculations, but the UI only gets the boolean.

**Remediation:** Consider including the threshold values in the `LiquidityHealth` response so the UI can show "Coverage at 72% (guard at 70%)".

---

## Category 3: Data Contract Mismatches (Medium)

### 3.1 `snapshot-supply` Dual Scheduling — Metadata/Reality Mismatch

**Files:**
- Definition: `shared/lib/cron-jobs.ts:198-204` — `scheduleKey: "daily0800Utc"`, `intervalSec: 86400`
- Quarter-hourly dispatch: `worker/src/handlers/scheduled/quarter-hourly.ts:38-39`
- Daily dispatch: `worker/src/handlers/scheduled/daily-0800.ts:9`

**Issue:** `snapshot-supply` is defined as a daily job (24h interval) but is also dispatched conditionally in the quarter-hourly slot (every 15 min when `stablecoinsCacheSafe`). The status page reports `expectedIntervalSec: 86400` for this job, which means:
- A quarter-hourly run will always show as "fresh" (way under 2x the expected interval)
- If the quarter-hourly conditional stops running, the job could go 24h without an alert because the expected interval is so long
- The cron card shows a 24h cadence badge, which is misleading

This is the documented retry path (`worker-infrastructure.md` line 5: "the snapshot-supply retry path runs on the */15 trigger only after a downstream-safe sync-stablecoins cache write"), but the status page metadata doesn't reflect this dual nature.

**Remediation:** Either:
- (a) Change `intervalSec` to `900` to match the actual expected cadence, and accept that the daily trigger is a safety net, or
- (b) Add a `retryScheduleKey` field to `CronJobDefinition` and surface it on the cron card so operators see both cadences.

### 3.2 `onchain_monitor_unavailable` — Phantom Cause Code

**File:** `src/components/status/action-recommendations.ts:18`

**Issue:** The recommendation mapping includes `onchain_monitor_unavailable: ["/api/backfill-mint-burn"]`, but the backend (`worker/src/api/status.ts`) never generates a cause with this code. The test at `worker/src/api/__tests__/status.test.ts:802-803` explicitly asserts this code does NOT appear. The mapping is dead code — it can never trigger.

**Remediation:** Remove the phantom mapping or add the cause code to the backend if it was intended.

### 3.3 `reclassify-atomic-roundtrips` — Doc/Code Mismatch

**Files:**
- Doc: `docs/status-dashboard.md:354` — listed as an inline admin action
- Code: `shared/lib/api-endpoints.ts:510-518` — has `probeGroup: "manual"` but NO `statusPageAction`

**Issue:** The documentation lists `POST /api/reclassify-atomic-roundtrips` as an inline admin action, but it has no `statusPageAction` config so it never appears on the status page. Either the doc is aspirational or the config is incomplete.

**Remediation:** Either add the `statusPageAction` config or remove it from the doc's inline actions list.

### 3.4 Status Facts vs Action Recommendations — Inconsistent Cause Filtering

**Files:**
- `src/components/status/status-facts.tsx:143` — uses `[...causes.availability, ...causes.dataQuality]`
- `src/components/status/action-recommendations.ts:80` — uses `causes.overall`

**Issue:** The blockers list in StatusFacts shows `availability + dataQuality` causes, while the recommended actions strip derives from `causes.overall`. These are different views of the same data:
- `overall` is a severity-sorted, truncated (top 12) merge of both
- `availability + dataQuality` is the full untruncated set

This means the blockers list can show causes that have no corresponding recommendation (if they were outside the top 12 overall), and recommendations can map to causes not visible in the blockers list.

**Impact:** Low in practice (top 12 is generous), but the inconsistency is a potential confusion source for operators.

**Remediation:** Align both views to use the same cause source — either both use `overall` or both use the raw arrays.

### 3.5 Worker Infrastructure Doc Count Nuance

**File:** `docs/worker-infrastructure.md:3`

**Claim:** _"24 scheduled runtime jobs across 10 cron expressions / trigger slots. CRON_INTERVALS / /api/status track 23 of them"_

**Actual:** 23 jobs in `CRON_JOB_DEFINITIONS_BASE`, 1 untracked (`announce-cemetery-additions`). The doc also says "22 status-tracked jobs" elsewhere but the cron-jobs definitions list 23.

**Remediation:** Verify the "22 status-tracked jobs" claim and update if stale.

### 3.6 Dataset Freshness Table — Inferred Expected Freshness

**File:** `src/components/status/dataset-freshness-table.tsx:41,63,69`

**Issue:** The component infers expected freshness from cron job metadata (`getCronJobMeta(job)?.intervalSec * 2`), then applies its own additional severity bands:
- `> expectedFreshness * 1.5` → "late" (red)
- `> expectedFreshness` → "aging" (amber)

These multipliers are frontend-only heuristics. The backend's actual freshness judgment uses `2x interval` for cron health. The frontend's `1.5x` band has no backend equivalent.

**Remediation:** Document these as UI-only visual bands or align with backend thresholds.

---

## Category 4: Minor Validation Gaps (Low)

### 4.1 Telegram Metadata Parsing — No Schema Validation

**File:** `src/components/status/telegram-bot-stats.tsx:39-85`

**Issue:** Parses cron run metadata with `readNumber()`/`readString()` helpers that silently return `null` for missing or mistyped fields. If the backend changes field names (e.g., `subscribersNotified` → `subscribers_notified`), the UI renders "—" without any warning.

**Remediation:** Low priority — defensive parsing is correct behavior. Consider adding a console warning for unexpected empty parse results in development.

### 4.2 Cron Metadata Summarizers — Incomplete Coverage

**File:** `src/components/status/cron-metadata-summary.ts:250-259`

**Issue:** Only 8 of 23 tracked jobs have metadata summarizers. Other jobs' metadata is available via raw JSON disclosure but gets no structured summary. This is not a bug — most jobs have simple metadata — but new jobs with rich metadata would silently lack summaries.

**Remediation:** No immediate action needed. Consider a generic key-value summary fallback for jobs without a custom summarizer.

### 4.3 System Diagnostics — No Null Check on Timestamps

**File:** `src/components/status/system-diagnostics.tsx:71-72`

**Issue:** Displays "evaluated {age} ago" and "changed {age} ago" without null-checking `lastEvaluatedAt` / `lastChangedAt`. If either is 0, `formatAge(0)` returns "just now" which could be misleading during bootstrap.

**Remediation:** Add a null/zero guard and show "pending" instead of "just now".

### 4.4 Live Reserve Composition — Degraded/Missing Double-Count

**File:** `worker/src/lib/live-reserves-store.ts:317-323`

**Issue:** A coin can be counted as BOTH degraded AND missing in the same pass:
- Line 317-319: Increments `degradedCoins` if sync status is not `ok` or snapshot is inconsistent
- Line 321-323: Increments `missingCoins` and `continue`s if no `successAt` or no composition

If a coin has a sync row with `last_status !== "ok"` AND no composition row, it gets counted in both buckets. The `continue` at line 323 prevents it from also being counted as stale or fresh, but the `degradedCoins++` at line 318 already fired.

**Remediation:** Move the degraded check below the missing check, or restructure as mutually exclusive categories.

---

## Verified Accurate (No Issues Found)

The following were audited and found to be accurate:

- All 10 wrangler.toml cron expressions match `shared/lib/cron-jobs.ts` `CRON_SCHEDULES`
- All 23 job names in `CRON_JOB_DEFINITIONS_BASE` match `CRON_INTERVALS` in the worker
- All `intervalSec` values match actual cron cadences
- The `announce-cemetery-additions` exclusion from status tracking is documented and intentional
- The "24 jobs / 10 triggers" claim is accurate
- `StatusResponse` type contract is consistent between backend and frontend
- Probe endpoint lists (`getProbePaths`) are correctly sourced from `shared/lib/api-endpoints.ts`
- Self-check probe uses the same endpoint registry as browser probes
- Bootstrap cache miss detection covers the correct 3 endpoints
- `datasetFreshness` follows writer timestamps, not event timestamps (correctly documented)
- Data quality source failure handling correctly renders `ERR` instead of misleading `0`
- Active depegs are correctly labeled as informational-only (not affecting health status)
- Hysteresis state machine rendering accurately reflects the persisted state

---

## Recommended Implementation Order

1. **Shared thresholds** (Issues 1.1–1.4, 2.4): Move status thresholds and discovery min mcap to `shared/lib/status-thresholds.ts`. Single change, eliminates 5 duplication risks.
2. **Fix degraded/missing double-count** (Issue 4.4): Small backend fix, prevents incorrect counts.
3. **Remove phantom cause code** (Issue 3.2): Delete one line of dead code.
4. **Fix reclassify-atomic-roundtrips doc** (Issue 3.3): One-line doc edit.
5. **Align cause filtering** (Issue 3.4): Choose one cause source for both views.
6. **Document reconciliation thresholds** (Issue 2.1): Add to `docs/status-dashboard.md`.
7. **Address snapshot-supply dual scheduling** (Issue 3.1): Design decision needed.
8. **Remaining copy/validation items** (Issues 2.2–2.6, 4.1–4.3): Low priority, no data integrity risk.
