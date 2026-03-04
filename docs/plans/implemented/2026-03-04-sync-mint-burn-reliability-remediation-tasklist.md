# Sync Mint/Burn Reliability Remediation — Detailed Tasklist

> Status: Execution-ready  
> Date: March 4, 2026  
> Scope: `worker/src/cron/sync-mint-burn.ts`, cron orchestration, mint/burn observability, backfill/recovery

## Context

Production audit findings (March 4, 2026):

- `sync-mint-burn` runs on schedule but repeatedly reports partial coverage (`contractsProcessed=5`, `contractsSkipped=13`, `apiErrors=3`).
- `mint_burn_sync_state` has only 14/18 config keys; Base/Avalanche reUSD configs never initialized.
- High-lag/stale data for major coins (for example USDC/USDS/FRXUSD/BOLD).
- Metrics are misleading: `item_count`/`rowsWritten` represent parsed rows, not confirmed inserted rows.
- Partial failure mode is silent (`status=ok`), so circuit-breaker and alerts do not reflect degradation.

## Goals

1. Eliminate starvation and ensure fair progress across all enabled configs.
2. Make provider failures survivable (adaptive range splitting + bounded retries).
3. Make cron status reflect degraded ingestion, not only full-job failure.
4. Restore fresh mint/burn coverage for priority coins.
5. Improve operator visibility and runbook quality.

## Non-goals

1. Redesigning scoring formulas (`FIS`, gauge).
2. Reworking unrelated cron jobs.
3. Full historical reindex from genesis.

---

## Handoff Protocol (Use This After Context Reset)

1. Treat this file as the source of truth for scope and order.
2. Start with **Bootstrap Checklist** and **Baseline Snapshot** before any code changes.
3. Execute tasks in dependency order (`Task dependency map` section).
4. Do not start backfill (Tasks 14-15) until Phase A and B are deployed and stable.
5. After each phase, run the phase gates exactly as written in **Phase Gates**.

---

## Bootstrap Checklist

Run from repo root unless noted.

```bash
git checkout -b fix/mint-burn-reliability-phase-a
npm run lint
npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts
cd worker && npx tsc --noEmit
npx wrangler whoami
```

Required access/capabilities:

1. Cloudflare Worker deploy rights.
2. D1 remote migration/execute rights.
3. Worker secret management access (`ALCHEMY_API_KEY`, `ADMIN_KEY`).

## Execution Assumptions (Pin Before Work)

These are currently true in repo and should be verified first in case infrastructure changed:

1. Worker name: `stablecoin-api` (`worker/wrangler.toml`).
2. D1 binding: `DB`; D1 database name: `stablecoin-db`.
3. Cron trigger set includes `3,23,43 * * * *` for mint/burn cadence.
4. Latest existing migration in repo at time of writing: `0042_reusd_mint_amount_scale_fix.sql`.

If any of the above changed, update this document before implementing.

Migration numbering rule:

1. Use next available migration number in branch order.
2. If `0043`/`0044` are already used by other work, renumber references in this doc and in PRs consistently.

## Expected `mint_burn_sync_state` Key Manifest (Current 18 Configs)

Use this exact list to validate coverage for enabled configs:

1. `ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7`
2. `ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
3. `ethereum-0xc5f0f7b66764f6ec8c8dff7ba683102295e16409`
4. `ethereum-0x6c3ea9036406852006290770bedfcaba0e23a0e8`
5. `ethereum-0x6b175474e89094c44da98b954eedeac495271d0f`
6. `ethereum-0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f`
7. `ethereum-0x4c9edd5852cd905f086c759e8383e09bff1e68b3`
8. `ethereum-0xdc035d45d973e3ec169d2276ddab16f1e407384f`
9. `ethereum-0xcacd6fd266af91b8aed52accc382b4e165586e29`
10. `ethereum-0x6440f144b7e50d6a8439336510312d2f54beb01d`
11. `ethereum-0x4691c475be804fa85f91c2d6d0adf03114de3093`
12. `ethereum-0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e`
13. `arbitrum-0x802edbb1ec20548a4388abc337e4011718eb0291`
14. `arbitrum-0xfd4016ea13ca8acc04a11a99702df076a4d3b852`
15. `base-0x7d214438d0f27afccc23b3d1e1a53906ace5cfea`
16. `base-0x9ab62aebabe738ab233c447eedce88d1d0a61fe3`
17. `avalanche-0xb22a8533e6cd81598f82514a42f0b3161745fbe1`
18. `avalanche-0xe13292f97e38da0c64398de5e0bfc95180de9d23`

## Command Cookbook (Cold Start Safe)

Use these exact commands unless infrastructure differs.

```bash
# 1) Local quality gate
npm run lint
npm test -- \
  worker/src/cron/__tests__/sync-mint-burn.test.ts \
  worker/src/lib/__tests__/alchemy-logs.test.ts \
  worker/src/lib/__tests__/log-cron-run.test.ts \
  worker/src/api/__tests__/health.test.ts

# 2) Worker typecheck
(cd worker && npx tsc --noEmit)
```

```bash
# 3) D1 migrations (remote)
cd worker
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
```

```bash
# 4) Deploy
cd worker
npx wrangler deploy
```

```bash
# 5) Quick cron_runs sanity query (remote)
cd worker
npx wrangler d1 execute DB --remote --command "
SELECT datetime(started_at,'unixepoch') AS run_utc, status, item_count
FROM cron_runs
WHERE job='sync-mint-burn'
ORDER BY started_at DESC
LIMIT 12;"
```

If `DB` is rejected by Wrangler in your environment, use `stablecoin-db` in the same commands.

---

## Baseline Snapshot (Point-in-Time)

Captured on **March 4, 2026** during production audit. Re-measure before implementation; differences are acceptable, but this is the reference starting point.

1. Schedule healthy: `sync-mint-burn` runs every 20 minutes (`3,23,43` cron).
2. Last observed run pattern: `contractsProcessed=5`, `contractsSkipped=13`, `apiErrors=3`.
3. `mint_burn_sync_state` rows: `14` while config count is `18`.
4. Missing sync-state keys: reUSD Base deposit/redeem and reUSD Avalanche deposit/redeem.
5. Latest event timestamp in table: `2026-03-04 04:46:35 UTC`.
6. Latest hourly bucket: `2026-03-04 04:00:00 UTC`.
7. Example staleness: USDC latest stored event around `2025-09-21`.
8. Circuit state is not open (`circuit:alchemy` closed), despite partial degradation.

---

## Repo Entry Points

Primary files involved:

1. `worker/src/cron/sync-mint-burn.ts`
2. `worker/src/lib/mint-burn-contracts.ts`
3. `worker/src/lib/alchemy-logs.ts`
4. `worker/src/index.ts`
5. `worker/src/lib/db.ts` (`logCronRun`)
6. `worker/src/api/health.ts`

Data tables involved:

1. `mint_burn_events`
2. `mint_burn_hourly`
3. `mint_burn_sync_state`
4. `cron_runs`
5. `cache` (circuit keys, optional run-state/timestamp cache)

---

## Task Dependency Map

Use this to sequence work safely:

1. Foundational: **1, 2, 3, 4, 5, 6**
2. Depends on foundational: **7, 8, 9, 10, 11, 12, 13**
3. Depends on 1-13: **14, 15**
4. Final hardening: **16, 17**

Recommended PR slices:

1. PR-A1: Tasks 1-3
2. PR-A2: Tasks 4-6
3. PR-B1: Tasks 7-10
4. PR-B2: Tasks 11-13
5. PR-C1: Task 14 (endpoint + guardrails only)
6. PR-C2: Task 15 (operational run, no logic changes)
7. PR-D1: Tasks 16-17

---

## Priority Overview

- **P0 (Immediate reliability):** Tasks 1-8
- **P1 (Observability + controls):** Tasks 9-13
- **P2 (Recovery + hardening):** Tasks 14-17

---

## Detailed Tasklist (17 Items)

### 1. Add Config-Level Enable Flags (including reUSD kill-switch)

- **Why:** Disable non-critical configs (for example reUSD) without code removal.
- **Files:**
  - `worker/src/lib/mint-burn-contracts.ts`
  - `worker/src/cron/sync-mint-burn.ts`
  - `worker/src/index.ts` (optional env-driven override)
- **Implementation:**
  - Add `enabled?: boolean` to `MintBurnContractConfig` (default `true`).
  - Add optional `MINT_BURN_DISABLED_IDS`/`MINT_BURN_DISABLED_SYMBOLS` env parsing.
  - Skip disabled configs with explicit metadata counters.
- **Acceptance criteria:**
  - ReUSD can be disabled via config/flag in one deploy.
  - Cron metadata includes `configsDisabled`.
  - Unit tests cover enabled/disabled filtering.

### 2. Fix Scan Range Off-by-One

- **Why:** `toBlock` currently uses `from + maxRange` (inclusive), effectively scanning `maxRange + 1`.
- **Files:** `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Change `scanTo = min(from + range - 1, head)`.
- **Acceptance criteria:**
  - Unit test validates exact block count.
  - No chain exceeds intended range limits.
  - Query windows respect per-chain limits exactly.

### 3. Implement Adaptive `eth_getLogs` Range Splitting

- **Why:** Large ranges/provider limits can fail and currently become hard per-event failures.
- **Files:**
  - `worker/src/lib/alchemy-logs.ts`
  - `worker/src/cron/sync-mint-burn.ts`
  - `worker/src/lib/__tests__/alchemy-logs.test.ts`
- **Implementation:**
  - On `eth_getLogs` error/timeouts, recursively split block window.
  - Keep max depth guard and minimum range guard.
  - Return combined logs on partial splits.
- **Acceptance criteria:**
  - Known range-limit errors recover automatically.
  - API error count drops materially on same traffic.
  - Split logic is deterministic and bounded by max recursion depth.

### 4. Make Per-Event Failures Non-Blocking for Contract Progress

- **Why:** Single failing event definition currently blocks `sync_state` advance for entire contract.
- **Files:** `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Track success/failure per eventDef.
  - Advance state if at least one eventDef succeeded and produced trustworthy scan coverage.
  - Persist failed eventDefs in metadata.
- **Acceptance criteria:**
  - Contract can progress when one topic works and another is flaky.
  - Metadata exposes `failedEventDefs`.
  - No infinite retry of identical failing sub-range without progress.

### 5. Add Fair Scheduling (Rotate Config Start Index Per Run)

- **Why:** Static config order causes tail configs to starve when budget is exhausted.
- **Files:**
  - `worker/src/cron/sync-mint-burn.ts`
  - new migration: `worker/migrations/0043_mint_burn_run_state.sql` (or cache-key alternative)
- **Implementation:**
  - Store `next_config_index` across runs.
  - Start each run at rotating index, wrap around list.
- **Acceptance criteria:**
  - Over N runs, every enabled config receives scan attempts.
  - `mint_burn_sync_state` exists for all enabled configs.
  - Rotation survives worker restarts.

### 6. Introduce Per-Chain Budget Quotas + Global Budget

- **Why:** High-volume chains/contracts can consume all subrequests.
- **Files:** `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Keep global budget cap.
  - Add per-chain quota caps with spillover rules.
  - Track quota usage in metadata.
- **Acceptance criteria:**
  - No single chain can starve all others.
  - Metadata includes per-chain budget usage.
  - Budget logic keeps run time within timeout envelope.

### 7. Improve Timestamp Resolution Efficiency

- **Why:** Timestamp fetches are expensive and repeated across runs.
- **Files:**
  - `worker/src/lib/alchemy-logs.ts`
  - new migration: `worker/migrations/0044_block_timestamp_cache.sql` (if persisted cache path chosen)
- **Implementation:**
  - Cache recent block timestamps (in-memory per run + optional D1 cache table).
  - Avoid refetching known block timestamps.
- **Acceptance criteria:**
  - Lower subrequest consumption on repetitive windows.
  - Equal or better correctness for hourly buckets.
  - No regression in timestamp completeness checks.

### 8. Add Degraded-Run Escalation Logic

- **Why:** Current logic marks run `ok` unless everything fails.
- **Files:**
  - `worker/src/cron/sync-mint-burn.ts`
  - `worker/src/lib/db.ts` (status enum handling if needed)
- **Implementation:**
  - Define thresholds (example: processed/total below min for M consecutive runs).
  - Return `status: "error"` or `status: "degraded"` (if extending enum) when below thresholds.
  - Trigger alerting and circuit impact on sustained degradation.
- **Acceptance criteria:**
  - Silent partial failure no longer appears healthy.
  - Operators can detect degradation from `cron_runs` alone.
  - Circuit health behavior documented and tested.

### 9. Report Actual Inserted Rows (Not Parsed Rows)

- **Why:** `item_count` and `rowsWritten` currently overstate writes due to `INSERT OR IGNORE`.
- **Files:**
  - `worker/src/lib/db.ts`
  - `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Capture `meta.changes` from D1 batch operations.
  - Record `rowsParsed`, `rowsInserted`, `rowsIgnored`.
- **Acceptance criteria:**
  - `item_count` equals inserted rows.
  - Metadata reflects parse-vs-insert delta.
  - Existing dashboards/status consumers remain compatible.

### 10. Extend Cron Metadata with Per-Config Breakdown

- **Why:** Current metadata is too coarse for root-cause analysis.
- **Files:** `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Add compact per-config object: `attempted`, `logs`, `errors`, `inserted`, `advancedTo`.
  - Include top lagging configs snapshot.
- **Acceptance criteria:**
  - One query to `cron_runs` can identify failing configs quickly.
  - Metadata size remains within practical limits for D1 row storage.

### 11. Add Mint/Burn Freshness + Lag to Health Endpoint

- **Why:** `/api/health` currently reports only total mint/burn event count.
- **Files:**
  - `worker/src/api/health.ts`
  - `worker/src/api/__tests__/health.test.ts`
- **Implementation:**
  - Add `latestEventTs`, `latestHourlyTs`, and freshness age.
  - Add stale-major-coins count (configurable major set).
- **Acceptance criteria:**
  - Health endpoint flags stale ingestion even if cron runs.
  - No privileged data leakage via public health response.

### 12. Add Structured Staleness Alerts for Mint/Burn

- **Why:** Need proactive detection when high-priority coins stall.
- **Files:** `worker/src/index.ts`, `worker/src/cron/sync-mint-burn.ts`, `worker/src/lib/alerts.ts`
- **Implementation:**
  - After run, check freshness per major stablecoin.
  - Alert when stale beyond threshold (for example > 6h, > 24h).
- **Acceptance criteria:**
  - Alert emitted for reproducible stale scenario.
  - Alert spam protection (dedupe / cool-down) is enforced.

### 13. Add Runtime Policy for Non-Critical Coins

- **Why:** Keep ingestion focused under stress without deleting coverage permanently.
- **Files:** `worker/src/lib/mint-burn-contracts.ts`, `worker/src/cron/sync-mint-burn.ts`
- **Implementation:**
  - Mark configs as `tier: critical|extended`.
  - Under budget pressure, prioritize `critical` first.
- **Acceptance criteria:**
  - Critical coins stay fresh under constrained budget.
  - Extended coins can be deferred deterministically.
  - Policy is configurable and documented.

### 14. Build Controlled Backfill Worker Path (Chunked, Idempotent)

- **Why:** Current incremental loop cannot recover large stale gaps quickly.
- **Files:**
  - new admin endpoint: `worker/src/api/backfill-mint-burn.ts`
  - router wiring: `worker/src/router.ts`, `worker/src/index.ts`
- **Implementation:**
  - Backfill by `(configKey, fromBlock, toBlock, chunkSize)`.
  - Enforce auth + idempotency.
  - Reuse same parse/insert/aggregate pipeline.
- **Acceptance criteria:**
  - Can backfill stale coins without waiting weeks of incremental scans.
  - Backfill endpoint is admin-authenticated and idempotent-key aware.

### 15. Execute One-Time Recovery Backfill (Post-Fix)

- **Why:** Existing stale history must be repaired after logic fixes.
- **Files:** runbook in docs + admin command logs
- **Implementation:**
  - Backfill stale major configs first (USDC, USDS, DAI, GHO, FRXUSD, BOLD, reUSD chains).
  - Rebuild affected hourly windows.
  - Track progress in execution log.
- **Acceptance criteria:**
  - Latest event timestamps for critical coins are within freshness SLA.
  - Hourly table catches up to current period.
  - Recovery runbook captures exact commands and timestamps.

### 16. Expand Test Coverage for Reliability Modes

- **Why:** Current tests do not cover starvation/fairness/degraded status.
- **Files:**
  - `worker/src/cron/__tests__/sync-mint-burn.test.ts`
  - `worker/src/lib/__tests__/alchemy-logs.test.ts`
  - new integration-style fixtures as needed
- **Implementation:**
  - Add tests for:
    - rotating config index
    - budget exhaustion fairness
    - split-range recovery
    - partial eventDef failure behavior
    - inserted vs parsed counters
    - degraded-run escalation
- **Acceptance criteria:**
  - Tests fail on regression of the above behaviors.
  - Critical path tests execute in CI within acceptable duration.

### 17. Update Documentation + Operator Runbook

- **Why:** On-call needs concrete validation queries and rollback procedures.
- **Files:**
  - `docs/mint-burn-flows.md`
  - new runbook: `docs/runbooks/mint-burn-ingestion.md`
  - `README.md` (short operational note)
- **Implementation:**
  - Document new controls, metrics, and recovery commands.
  - Include standard SQL checks for freshness, lag, and coverage.
- **Acceptance criteria:**
  - A new operator can diagnose ingestion state without reading source code.
  - Includes rollback and emergency-disable instructions.

---

## Rollout Plan

### Phase A (Stabilize)

- Complete Tasks 1-8.
- Deploy.
- Observe 6-12 hours of cron metadata:
  - target `contractsProcessed >= 90%` of enabled set over rolling 6 runs.
  - target `apiErrors` trending down.

### Phase B (Visibility + controls)

- Complete Tasks 9-13.
- Deploy.
- Verify health + alert quality.

### Phase C (Recovery)

- Complete Tasks 14-15.
- Run staged backfill (critical first, then extended).

### Phase D (Hardening)

- Complete Tasks 16-17.
- Finalize runbook and SLO checks.

---

## Phase Gates (Hard Stop Criteria)

### Gate A (after Tasks 1-8)

Proceed only if all are true for at least 6 consecutive runs:

1. `contractsProcessed / contractsTotal >= 0.9` (or >= 0.9 of enabled configs).
2. `apiErrors <= 1` median over the 6-run window.
3. `mint_burn_sync_state` exists for all enabled configs.

### Gate B (after Tasks 9-13)

Proceed only if all are true:

1. `item_count == rowsInserted` semantics verified.
2. Health endpoint includes mint/burn freshness and lag fields.
3. Staleness alerts are tested and deduped.

### Gate C (before Task 15 backfill execution)

Proceed only if all are true:

1. No major ingestion regression in prior 12 hours.
2. Backfill endpoint auth and idempotency verified in staging/dev.
3. Rollback plan prepared and validated.

---

## Suggested SLOs (Post-Remediation)

1. `sync-mint-burn` successful run every 20 minutes.
2. Critical coin mint/burn freshness: <= 2 hours.
3. Enabled config coverage: 100% attempted at least once every 2 hours.
4. Degraded run rate: < 5% over 24h.

---

## Rollback / Emergency Controls

If production degrades after deployment:

1. Immediately disable extended/non-critical configs (or reUSD specifically) via Task 1 controls.
2. Re-deploy Worker with conservative config set.
3. If needed, roll back to prior Worker version and pause backfill activity.
4. Preserve `cron_runs` and backfill logs for incident review.

---

## Deliverables Checklist

Mark complete before closing the initiative:

1. Code merged for Tasks 1-13.
2. Migrations applied (`0043+` as introduced).
3. Health endpoint updated and validated.
4. Alerting updated and validated.
5. Backfill endpoint delivered and tested.
6. Recovery backfill executed and logged.
7. Test suite updates merged.
8. `docs/mint-burn-flows.md` + runbook updated.

---

## Ready-to-Use Validation Queries

```sql
-- 1) Recent run quality
SELECT datetime(started_at,'unixepoch') AS run_utc, status, item_count,
       json_extract(metadata,'$.sourceCoverage.contractsProcessed') AS processed,
       json_extract(metadata,'$.sourceCoverage.contractsTotal') AS total,
       json_extract(metadata,'$.apiErrors') AS api_errors
FROM cron_runs
WHERE job='sync-mint-burn'
ORDER BY started_at DESC
LIMIT 24;

-- 2) Missing sync_state keys
SELECT COUNT(*) FROM mint_burn_sync_state;

-- 2b) List sync_state keys
SELECT config_key, last_block
FROM mint_burn_sync_state
ORDER BY config_key;

-- 3) Latest event per coin
SELECT stablecoin_id, symbol, datetime(MAX(timestamp),'unixepoch') AS latest_utc
FROM mint_burn_events
GROUP BY stablecoin_id, symbol
ORDER BY MAX(timestamp) ASC;

-- 4) Latest hourly bucket
SELECT datetime(MAX(hour_ts),'unixepoch') AS latest_hour_utc
FROM mint_burn_hourly;

-- 5) Major coin freshness
SELECT stablecoin_id, symbol, datetime(MAX(timestamp),'unixepoch') AS latest_utc
FROM mint_burn_events
WHERE stablecoin_id IN ('1','2','5','118','119','120','146','209','235','269')
GROUP BY stablecoin_id, symbol
ORDER BY MAX(timestamp) ASC;

-- 6) Recent degraded/error runs
SELECT datetime(started_at,'unixepoch') AS run_utc, status, item_count, error,
       json_extract(metadata,'$.apiErrors') AS api_errors,
       json_extract(metadata,'$.sourceCoverage.contractsProcessed') AS processed,
       json_extract(metadata,'$.sourceCoverage.contractsTotal') AS total
FROM cron_runs
WHERE job='sync-mint-burn'
  AND (status != 'ok' OR COALESCE(json_extract(metadata,'$.apiErrors'),0) > 0)
ORDER BY started_at DESC
LIMIT 50;
```
