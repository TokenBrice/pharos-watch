# Pharos Data Pipeline & API Audit (Second Pass)

Date: 2026-03-03  
Scope: Worker cron pipeline, D1 persistence model, admin/backfill APIs, read APIs, and test coverage with strict focus on data correctness.

## Second-Pass Summary
This second pass re-validated first-pass findings against the current code and expanded the audit to concurrency, atomicity, snapshot completeness, and admin mutation safety.

### What is already improved since first pass
- DEWS schema drift in runtime + backfill path is fixed and covered by tests:
  - `worker/src/cron/compute-dews.ts:80`
  - `worker/src/api/backfill-dews.ts:41`
  - `worker/src/cron/__tests__/compute-dews.test.ts:128`
  - `worker/src/api/__tests__/backfill-dews.test.ts:28`
- `stress-signals` now handles malformed JSON rows defensively:
  - `worker/src/api/stress-signals.ts:63`
- Tron blacklist enrichment now avoids false historical amount reconstruction:
  - `worker/src/cron/sync-blacklist.ts:435`
- Most mutating admin routes were moved off `GET` to `POST`:
  - `worker/src/index.ts:116`
  - `worker/src/router.ts:51`

These are meaningful improvements. The remaining risks are mostly in concurrency semantics, mutation safety, and long-horizon historical correctness.

## Method
- Reviewed cron orchestration and lease/timeout flow: `worker/src/index.ts`, `worker/src/lib/db.ts`
- Audited all major ingest/transformation jobs (`sync-*`, `snapshot-*`, `compute-*`)
- Audited mutating admin/backfill endpoints and idempotency flow
- Cross-checked D1 migrations for constraint coverage
- Cross-checked test coverage gaps with file-level comparison

## Priority Matrix
| ID | Area | Priority | Effort | Data Integrity Risk If Unchanged | Expected Benefit |
|---|---|---|---|---|---|
| S2-F01 | Timeout + cancellation semantics | Critical | M (2-4d) | High | Prevents overlapping writers and stale-lock corruption |
| S2-F02 | Lease renewal loss handling | Critical | M (2-3d) | High | Avoids concurrent cron execution after lease loss |
| S2-F03 | DEX daily snapshot self-healing | High | M (2-3d) | High | Eliminates persistent partial-day historical gaps |
| S2-F04 | DEWS daily snapshot self-healing | High | M (2-3d) | High | Eliminates partial-day stress history gaps |
| S2-F05 | Supply snapshot one-shot gap risk | High | M (2-4d) | High | Preserves complete daily supply history continuity |
| S2-F06 | Depeg orphan auto-close behavior | High | M (2-4d) | High | Prevents false recoveries from transient missing inputs |
| S2-F07 | Backfill depeg supply lookup ordering | High | S (0.5-1d) | Medium-High | Corrects historical event gating/classification |
| S2-F08 | `audit-depeg-history` mutation via `GET` | High | S-M (1-2d) | High | Prevents accidental/replayed destructive operations |
| S2-F09 | Idempotency race (double execution) | High | M (2-4d) | High | Makes admin mutations truly single-execution |
| S2-F10 | Non-atomic backfill rewrites | High | M-L (3-6d) | High | Prevents partial table states on failure |
| S2-F11 | Mint/burn price backfill overwrite semantics | High | S (0.5-1d) | Medium-High | Prevents unintended USD valuation rewrites |
| S2-F12 | PSI recompute drift in audit path | High | S-M (1-2d) | High | Keeps historical PSI recomputation faithful |
| S2-F13 | Non-USD supply backfill constant-price fallback | High | M (2-4d) | High | Prevents distorted historical supply USD series |
| S2-F14 | FX failure signaling + stale FX use | Medium | S-M (1-2d) | Medium-High | Better correctness for non-USD peg logic |
| S2-F15 | Schema constraints for enum-like fields | Medium | M (2-3d) | Medium | Hardens DB-level correctness against bad writes |
| S2-F16 | Status/health under-reporting degraded states | Medium | S-M (1-2d) | Medium | More truthful operational signal for correctness |
| S2-F17 | Missing `Idempotency-Key` in CORS allowlist | Low | S (<0.5d) | Low | Enables safe idempotent admin calls from browser UIs |
| S2-F18 | Coverage gaps on high-risk cron/admin paths | Medium | M-L (3-7d) | Medium-High | Prevents regressions in integrity-critical paths |

## Detailed Findings

### S2-F01. Cron timeouts are advisory, not hard-enforced
**Evidence**
- `logCronRun` aborts only an `AbortSignal`; it does not race/cancel the job promise:
  - `worker/src/lib/db.ts:302`
  - `worker/src/lib/db.ts:305`
- Several jobs ignore the signal in practice. Example: `syncMintBurn` accepts `_signal` but does not pass signal into Alchemy helpers:
  - `worker/src/cron/sync-mint-burn.ts:56`
  - `worker/src/cron/sync-mint-burn.ts:91`
  - `worker/src/cron/sync-mint-burn.ts:182`
  - `worker/src/cron/sync-mint-burn.ts:200`

**Recommendation**
- Enforce hard timeout with `Promise.race` in `logCronRun` and throw `TimeoutError`.
- Require each cron to propagate signal through all network helpers.
- Add timeout conformance tests for at least `sync-mint-burn` and `sync-dex-liquidity`.

**Effort**: M (2-4d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium (requires coordinated refactor of helper signatures)  
**Expected benefit**: Prevents runaway cron overlap and timeout-blind writes.

---

### S2-F02. Lease renewal failures do not stop execution
**Evidence**
- `runCronWithLease` counts renewal failures but continues running/writing:
  - `worker/src/lib/db.ts:255`
  - `worker/src/lib/db.ts:260`
  - `worker/src/lib/db.ts:266`

**Recommendation**
- Add a renewal failure threshold; abort job when lease cannot be renewed.
- Mark run metadata with `leaseLost=true`, and treat as failed run.

**Effort**: M (2-3d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Prevents two workers writing same datasets concurrently after lease loss.

---

### S2-F03. DEX daily snapshots can become permanently partial
**Evidence**
- Daily write gate checks only global max date:
  - `worker/src/cron/dex-liquidity/persistence.ts:116`
  - `worker/src/cron/dex-liquidity/persistence.ts:119`
- Inserts are chunked (`batchExecute`), so failures can leave partial-day rows:
  - `worker/src/lib/db.ts:6`
  - `worker/src/lib/db.ts:8`
  - `worker/src/cron/dex-liquidity/persistence.ts:146`

**Recommendation**
- Replace max-date gate with per-day completeness check (`rows_for_day >= expected_coin_count`).
- Upsert missing rows for current day on every run until complete.
- Persist expected row count/version for each snapshot day.

**Effort**: M (2-3d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Self-healing history; no long-lived partial days.

---

### S2-F04. DEWS daily snapshots have the same partial-day trap
**Evidence**
- DEWS daily snapshot gate checks existence of any row for the day:
  - `worker/src/cron/compute-dews.ts:350`
  - `worker/src/cron/compute-dews.ts:354`
- Writes are chunked via `batchExecute`:
  - `worker/src/cron/compute-dews.ts:362`

**Recommendation**
- Apply same completeness model as DEX history (expected vs actual rows per day).
- Reconcile missing daily rows on each 15-minute run.

**Effort**: M (2-3d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Full, consistent DEWS history per day.

---

### S2-F05. Daily supply snapshots can miss entire days with no retry
**Evidence**
- `snapshot-supply` runs once daily in scheduler:
  - `worker/src/index.ts:409`
- Job skips when stablecoins cache is stale (>20 min):
  - `worker/src/cron/snapshot-supply.ts:15`
  - `worker/src/cron/snapshot-supply.ts:17`

**Recommendation**
- Add retry windows (e.g., hourly retries until successful snapshot for day).
- Add daily completeness audit job to backfill missing `supply_history` dates.

**Effort**: M (2-4d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Prevents sparse/missing daily supply baselines used by multiple models.

---

### S2-F06. Depeg orphan cleanup can falsely close valid open events
**Evidence**
- Coins with missing price/supply are skipped in main detection loop:
  - `worker/src/cron/detect-depegs.ts:105`
  - `worker/src/cron/detect-depegs.ts:108`
- Later, unseen open events are auto-closed as “orphaned”:
  - `worker/src/cron/detect-depegs.ts:237`
  - `worker/src/cron/detect-depegs.ts:251`

**Recommendation**
- Distinguish `not_observed_due_to_data_gap` from true recovery.
- Require explicit below-threshold confirmation for N consecutive runs before close.

**Effort**: M (2-4d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Prevents false recovery timestamps and broken depeg episode continuity.

---

### S2-F07. Backfill depeg supply matching relies on implicit map ordering
**Evidence**
- Supply points are loaded into a `Map` without explicit sort guarantees:
  - `worker/src/api/backfill-depegs.ts:581`
- Nearest lookup breaks early as if timestamps are ordered:
  - `worker/src/api/backfill-depegs.ts:602`

**Recommendation**
- Store sorted arrays per coin and use binary search for nearest supply.
- Remove early-break dependence on insertion order.

**Effort**: S (0.5-1d)  
**Data integrity risk if unchanged**: Medium-High  
**Implementation risk**: Low  
**Expected benefit**: Correct historical supply thresholding and large-cap confirmation behavior.

---

### S2-F08. `audit-depeg-history` is still a mutating `GET` path
**Evidence**
- Deletion behavior exists in endpoint:
  - `worker/src/api/audit-depeg-history.ts:63`
  - `worker/src/api/audit-depeg-history.ts:82`
  - `worker/src/api/audit-depeg-history.ts:238`
- Route/index mutating path allowlists do not include this endpoint:
  - `worker/src/router.ts:43`
  - `worker/src/index.ts:90`

**Recommendation**
- Move mutation mode to `POST` only.
- Add it to mutating admin allowlist and wrap with `runIdempotentAdminAction`.
- Keep read-only audit preview on `GET` with `dry-run=true` only.

**Effort**: S-M (1-2d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Low-Medium  
**Expected benefit**: Prevents accidental/replayed destructive operations.

---

### S2-F09. Idempotency implementation still allows concurrent double execution
**Evidence**
- Current pattern: read existing -> execute mutation -> `INSERT OR IGNORE`:
  - `worker/src/lib/idempotency.ts:55`
  - `worker/src/lib/idempotency.ts:77`
  - `worker/src/lib/idempotency.ts:83`

**Recommendation**
- Reserve key first with a pending record (`INSERT`), then execute exactly once.
- For concurrent callers: return 409/202 for in-flight key instead of executing.
- Add concurrency test (parallel requests same key).

**Effort**: M (2-4d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: True exactly-once semantics for admin mutations.

---

### S2-F10. Several heavy backfills are not atomic end-to-end
**Evidence**
- Mint/burn repair rebuild is delete-then-insert in separate chunked batches:
  - `worker/src/api/backfill-mint-burn-prices.ts:50`
  - `worker/src/api/backfill-mint-burn-prices.ts:53`
  - `worker/src/api/backfill-mint-burn-prices.ts:73`
- Stability index backfill uses delete + large chunked inserts:
  - `worker/src/api/backfill-stability-index.ts:151`
  - `worker/src/api/backfill-stability-index.ts:152`

**Recommendation**
- Use explicit transaction boundaries where feasible, or shadow table + swap pattern.
- Add resume/checkpoint markers for long backfills.

**Effort**: M-L (3-6d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Eliminates partial table states if process/network fails mid-run.

---

### S2-F11. Mint/burn repair can overwrite valid `amount_usd`
**Evidence**
- Any missing audit field triggers full rewrite of `amount_usd`:
  - `worker/src/api/backfill-mint-burn-prices.ts:13`
  - `worker/src/api/backfill-mint-burn-prices.ts:33`

**Recommendation**
- Use field-wise `COALESCE` semantics:
  - `amount_usd = COALESCE(amount_usd, amount * ?)`
  - price audit fields only where null.
- Add regression test with non-null `amount_usd` + missing `price_source`.

**Effort**: S (0.5-1d)  
**Data integrity risk if unchanged**: Medium-High  
**Implementation risk**: Low  
**Expected benefit**: Preserves existing valuations while completing audit metadata.

---

### S2-F12. PSI recompute in audit path is algorithmically inconsistent
**Evidence**
- Recompute omits `depegAgeDays` (defaults to 0 in PSI function):
  - `worker/src/api/audit-depeg-history.ts:329`
  - `worker/src/lib/stability-index.ts:10`
  - `worker/src/lib/stability-index.ts:44`
- Recompute upsert does not set `methodology_version`:
  - `worker/src/api/audit-depeg-history.ts:367`

**Recommendation**
- Align recompute logic with backfill-stability-index (include age + methodology version per day).
- Use `getPsiMethodologyVersionAt(day)` on recompute writes.

**Effort**: S-M (1-2d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Low-Medium  
**Expected benefit**: Keeps recomputed PSI historically faithful and version-correct.

---

### S2-F13. Non-USD supply backfill may use constant current price for full history
**Evidence**
- If historical price series missing, endpoint falls back to current price constant:
  - `worker/src/api/backfill-supply-history.ts:280`
  - `worker/src/api/backfill-supply-history.ts:315`

**Recommendation**
- For non-USD coins, require historical price source for backfill beyond short bounded windows.
- If fallback is unavoidable, mark rows with provenance and exclude from strict analytics.

**Effort**: M (2-4d)  
**Data integrity risk if unchanged**: High  
**Implementation risk**: Medium  
**Expected benefit**: Avoids long-range market cap distortion in `supply_history`.

---

### S2-F14. FX failure signaling and FX freshness usage are weak
**Evidence**
- `sync-fx-rates` returns `{}` on hard failure paths (logged as `ok` by cron logger):
  - `worker/src/cron/sync-fx-rates.ts:105`
  - `worker/src/cron/sync-fx-rates.ts:244`
- `sync-stablecoins` consumes cached FX rates without age check:
  - `worker/src/cron/sync-stablecoins.ts:629`

**Recommendation**
- Throw (or explicit error status) when no usable rates were produced.
- Enforce max age when consuming FX cache for peg logic.

**Effort**: S-M (1-2d)  
**Data integrity risk if unchanged**: Medium-High  
**Implementation risk**: Low-Medium  
**Expected benefit**: Better non-USD peg correctness and faster operational detection.

---

### S2-F15. DB constraints still do not enforce key enums
**Evidence**
- `depeg_events.direction/source` have comments but no `CHECK` constraints:
  - `worker/migrations/0006_depeg_events.sql:7`
  - `worker/migrations/0006_depeg_events.sql:15`
- `mint_burn_events.direction` has no `CHECK`:
  - `worker/migrations/0031a_mint_burn_v2.sql:7`

**Recommendation**
- Add migration with table rebuild or guarded writes + validation constraints.
- Enforce allowed values for direction/source/bands and numeric non-negativity where applicable.

**Effort**: M (2-3d)  
**Data integrity risk if unchanged**: Medium  
**Implementation risk**: Medium (migration/data cleanup)  
**Expected benefit**: Database-level corruption prevention.

---

### S2-F16. `status` can under-report degraded correctness conditions
**Evidence**
- Overall status ignores cron `healthy` booleans and most quality counters:
  - `worker/src/api/status.ts:120`
  - `worker/src/api/status.ts:139`

**Recommendation**
- Include stale/unhealthy cron states and key data quality indicators in overall scoring.
- Separate “availability healthy” vs “data quality healthy”.

**Effort**: S-M (1-2d)  
**Data integrity risk if unchanged**: Medium  
**Implementation risk**: Low  
**Expected benefit**: Operational truth aligns with data correctness reality.

---

### S2-F17. CORS allowlist omits `Idempotency-Key`
**Evidence**
- CORS `Access-Control-Allow-Headers` currently lacks `Idempotency-Key`:
  - `worker/src/index.ts:55`

**Recommendation**
- Add `Idempotency-Key` to allowed headers.

**Effort**: S (<0.5d)  
**Data integrity risk if unchanged**: Low  
**Implementation risk**: Low  
**Expected benefit**: Enables browser-based admin tooling to safely use idempotency.

---

### S2-F18. Coverage gaps remain in integrity-critical paths
**Evidence**
- Untested cron jobs:
  - `confirm-pending-depegs.ts`, `daily-digest.ts`, `fetch-tbill-rate.ts`, `snapshot-psi.ts`, `stability-index.ts`, `sync-bluechip.ts`, `sync-stablecoin-charts.ts`, `sync-usds-status.ts`
- Untested admin/mutation APIs:
  - `audit-depeg-history.ts`, `backfill-cg-prices.ts`, `backfill-depegs.ts`, `backfill-stability-index.ts`, `backfill-supply-history.ts`

**Recommendation**
- Add contract tests for high-risk mutators first (`audit-depeg-history`, `backfill-*`), then missing cron tests.
- Add concurrency tests for idempotency and lease-loss edge cases.

**Effort**: M-L (3-7d)  
**Data integrity risk if unchanged**: Medium-High  
**Implementation risk**: Low  
**Expected benefit**: Prevents regression of correctness guarantees.

## Recommended Execution Order
1. S2-F01, S2-F02, S2-F06, S2-F08, S2-F09, S2-F10, S2-F11, S2-F12  
2. S2-F03, S2-F04, S2-F05, S2-F13, S2-F14, S2-F15  
3. S2-F16, S2-F17, S2-F18

## Verification Checklist After Remediation
- Concurrency and timeout tests:
  - forced timeout asserts hard failure + no continued writes
  - lease renew loss abort path
  - concurrent idempotency requests execute mutation once
- Snapshot completeness tests:
  - partial-day write simulation self-heals on next run
- Depeg correctness tests:
  - missing-price cycles do not auto-close open events
  - audit recompute matches backfill-stability-index output for same day
- API mutation safety:
  - `audit-depeg-history` rejects `GET` mutation attempts
  - idempotency headers accepted via CORS

## Bottom Line
Pharos has closed multiple first-pass correctness gaps. The main remaining risk is not basic parsing; it is **state integrity under failure/concurrency** and **historical consistency over long windows**. Addressing the top 8 findings above materially tightens correctness guarantees and makes the pipeline much harder to corrupt silently.
