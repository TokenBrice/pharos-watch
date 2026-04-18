# Cron Infrastructure Audit & Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate resource waste in the cron pipeline — consolidate housekeeping prunes, fix snapshot cooldown bugs, and align each job's cadence to the volatility of its underlying data.

**Architecture:** No new infrastructure. Changes are surgical: (1) move two "on every run" DELETE statements into a single daily housekeeping pass, (2) fix two snapshot jobs whose cooldown does not match their stated intent, (3) reduce the firing frequency of five jobs whose data changes more slowly than their schedule. All scheduling metadata flows through `shared/lib/cron-jobs.ts` so most changes touch a small, well-defined surface.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Vitest, wrangler.toml.

---

## Executive Summary of Findings

### Resource waste quantified (current baseline)

| Waste category | Current daily cost | Target daily cost | Reduction |
| --- | --- | --- | --- |
| `cron_runs` prune DELETE on every job run | ~1,400 DELETEs | 1 DELETE | −99.9% |
| `cron_slot_executions` prune DELETE on every slot completion | ~1,100 DELETEs | 1 DELETE | −99.9% |
| `snapshot-supply` redundant writes | 24 writes (23 overwrite the same row) | 1 write | −95.8% |
| `snapshot-chain-supply` redundant writes | 24 writes | 1 write | −95.8% |
| `sync-fx-rates` runs | 96 / day | 48 / day | −50% external calls |
| `sync-blacklist` runs | 24 / day | 4 / day | −83% Etherscan/TronGrid calls |
| `sync-live-reserves` runs | 24 / day | 6 / day | −75% RPC + reserve-adapter calls |
| `sync-mint-burn` (critical lane) runs | 72 / day | 48 / day | −33% Alchemy CUs (critical tier) |
| `sync-mint-burn-extended` runs | 72 / day | 48 / day | −33% Alchemy CUs (extended tier) |
| `sync-dex-discovery` runs | 48 / day | 12 / day | −75% GT/CG/DS crawl traffic |

### Frequencies that stay unchanged (with justification)

- `sync-stablecoins` 15 min — home page and depeg detection require <20 min staleness (`worker/src/handlers/scheduled/quarter-hourly.ts:70`).
- `dispatch-telegram-alerts` 5 min — alert latency matters; empty-queue runs are a ~6-read DB probe.
- `digest-trigger-poll` 5 min — ops UI responsiveness; empty-flag runs are 1 DB read.
- `status-self-check` 15 min — observability signal; 34 internal `route()` calls are cheap.
- `sync-dex-liquidity` 30 min — pool imbalance signals drive DEWS/PegScore.
- `sync-stablecoin-charts` already cooldown-gated to hourly (trigger fires 30 min; `COOLDOWN_SEC = 3600`).
- `compute-dews`, `stability-index` 30 min — DB-only, <2 ms D1 time.
- `sync-yield-data` 1 h, `sync-yield-supplemental` 4 h, `sync-kinesis-supply` 1 h, `sync-redemption-backstops` 1 h — already right-sized.
- Daily and weekly snapshots (safety-grade, PSI, bluechip, t-bill, USDS, digest, recap, discovery-scan) — already right-sized.
- `yield-coverage-audit` monthly, `prune-status-probe-runs` daily — already right-sized.

### Deferred to future work (see `Future Work` section at end)

- FW1: Signal-gated `daily-digest` (skip LLM on truly quiet days) — requires product/editorial design.
- FW2: `publish-report-card-cache` cooldown — requires measuring DB impact before reducing.
- FW3: Shared GT/CG crawl cache across `dex-discovery` + `dex-liquidity` — complex coordination.
- FW4: Shared Aave/Compound on-chain rate cache across `sync-yield-data` + `sync-yield-supplemental`.
- FW5: Merging the two 5-min slots (`fiveMinuteTelegramAlerts` + `digestTriggerPoll`) — marginal benefit.
- FW6: `status-self-check` cadence reduction — observability judgment call.

### Known tradeoffs explicitly accepted (detailed in `Part E`)

- Blacklist signal latency into DEWS widens from ≤1 h to ≤6 h (rare events, acceptable).
- Mint-burn public freshness SLA widens from 40 min to 60 min (auto-derived; no alert impact).
- "Live reserve sync stale" alert threshold raises from 6 h to 12 h to preserve "3 missed runs" semantics.
- `/api/redemption-backstops` Warning header budget widens from 1 h to 8 h to match the new cadence.

---

## File Structure — What This Plan Touches

### New files

- `worker/src/cron/prune-cron-history.ts` — single-purpose daily job that prunes `cron_runs` (>7 days) and `cron_slot_executions` (>14 days). Replaces per-run pruning.

### Modified files

**Worker runtime:**
- `worker/src/lib/cron-logger.ts` — remove the per-run prune block from `finally`; drop the now-unused `SECONDS` import.
- `worker/src/lib/cron-lease.ts` — remove `pruneScheduledSlotExecutions` definition and its per-slot invocation.
- `worker/src/cron/snapshot-supply.ts` — raise `COOLDOWN_SEC` to `20 * 3600`.
- `worker/src/cron/snapshot-chain-supply.ts` — same.
- `worker/src/cron/sync-fx-rates.ts` — add a 30-min cooldown check at entry.
- `worker/src/lib/mint-burn-health-config.ts` — `MINT_BURN_CRITICAL_LANE_INTERVAL_SEC: 20*60 → 30*60`; update warning strings.
- `worker/src/handlers/scheduled/daily-0300.ts` — chain the new `prune-cron-history` job.
- `worker/src/handlers/scheduled/hourly-blacklist.ts` — rename exported function to `runSixHourlyBlacklistSlot`.
- `worker/src/handlers/scheduled/hourly-live-reserves.ts` — rename exported function; raise the `maxAge > 6*3600` alert threshold to `12*3600`.
- `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts` — rename exported function to `runHalfHourlyMintBurnCriticalSlot`.
- `worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts` — rename exported function to `runHalfHourlyMintBurnExtendedSlot`.
- `worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts` — rename exported function to `runTwoHourlyDexDiscoverySlot`.
- `worker/src/handlers/scheduled.ts` — update imports and `SLOT_RUNNER_BY_KEY` keys.

**Shared types / registry:**
- `shared/lib/cron-jobs.ts` — rename scheduleKeys; change schedule expressions and intervalSec for 5 jobs; add `prune-cron-history` definition.
- `shared/lib/scheduled-runner-registry.ts` — track renamed keys.
- `shared/lib/api-freshness.ts` — replace hardcoded `redemptionBackstops: 3600` with `CRON_INTERVALS["sync-redemption-backstops"] * 2`.

**Configuration:**
- `worker/wrangler.toml` — update five `[triggers].crons` expressions.

**Tests:**
- `worker/src/cron/__tests__/*.test.ts` — update any test asserting schedule strings, intervalSec values, cooldown thresholds, or the old 40-min mint-burn SLA.
- `worker/src/handlers/scheduled/__tests__/hourly-live-reserves.test.ts` — function rename + threshold bump.

**Documentation:**
- `README.md` — cron table at lines 221–234.
- `docs/worker-infrastructure.md` — trigger tables, connection-pool table, interval table, per-job schedule lines.
- `docs/live-reserves.md` — per-job schedule lines.
- `docs/supply-snapshot.md` — cooldown description.
- `docs/dex-liquidity.md` — discovery cadence references.
- `docs/mint-burn-flows.md` — lane cadence references; SLA references.
- `docs/api-reference.md` — blacklist freshness paragraphs.
- `docs/redemption-backstops.md` — reserve-lane cadence.
- `src/data/changelogs/` — new entry documenting the cadence + housekeeping changes.

### Test files

- `worker/src/cron/__tests__/prune-cron-history.test.ts` — new test for the daily housekeeping job.
- Existing tests updated as tasks specify.

---

## Ground Rules the Executor Must Follow

1. **Do not rename or change D1 table schemas.** Only row retention thresholds are moving; `cron_runs` and `cron_slot_executions` schemas stay put.
2. **Keep `scheduleKey` values semantically truthful.** When a cadence changes, rename the scheduleKey (e.g., `hourlyBlacklist` → `sixHourlyBlacklist`) so that future readers do not trust a misleading label. The key is a TypeScript identifier only — renaming it does not orphan D1 rows.
3. **D1 rows in `cron_slot_executions` are keyed by `slot_key` (the scheduleKey value).** Renaming a key means historical rows become orphans. They will be pruned by the new daily housekeeping pass within 14 days. No migration needed.
4. **Every schedule change touches four places together**, in this order: `shared/lib/cron-jobs.ts` → `shared/lib/scheduled-runner-registry.ts` → `worker/src/handlers/scheduled.ts` → `worker/wrangler.toml`. Changing any subset leaves the registry in an inconsistent state; keep them in lockstep per task.
5. **Each task ends with `cd worker && npx tsc --noEmit` + `npm test -- <relevant>` + one commit.** No unbounded batches.
6. **Preserve the commit-co-author trailer.** Use the signature from the repo's `CLAUDE.md` style.

---

## Part A — Consolidate Cron Housekeeping

**Why first:** These three tasks together remove ~2,500 DELETE statements per day from D1 and create a single named observability row in `cron_runs` for the housekeeping pass. They are the highest-leverage, lowest-risk wins in the plan, and they must land before cadence changes because cadence changes will increase orphan rates in `cron_slot_executions` (see ground rule 3).

### Task 1: Create `prune-cron-history` cron job

**Files:**
- Create: `worker/src/cron/prune-cron-history.ts`
- Create: `worker/src/cron/__tests__/prune-cron-history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/src/cron/__tests__/prune-cron-history.test.ts` with:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./shared/test-db";
import { prepareMigrations } from "./shared/migrations";
import { runPruneCronHistory } from "../prune-cron-history";

const ONE_WEEK_SEC = 7 * 24 * 60 * 60;
const TWO_WEEKS_SEC = 14 * 24 * 60 * 60;

async function insertCronRun(db: D1Database, job: string, startedAt: number) {
  await db
    .prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES (?, ?, 100, 'ok')")
    .bind(job, startedAt)
    .run();
}

async function insertSlotExecution(db: D1Database, slotKey: string, slotStartedAt: number) {
  await db
    .prepare(
      `INSERT INTO cron_slot_executions
         (slot_key, slot_started_at, state, execution_owner, started_at, updated_at)
       VALUES (?, ?, 'finished', 'owner', ?, ?)`,
    )
    .bind(slotKey, slotStartedAt, slotStartedAt, slotStartedAt)
    .run();
}

describe("runPruneCronHistory", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await createTestDb();
    await prepareMigrations(db);
  });

  it("removes cron_runs older than 7 days and keeps newer rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCronRun(db, "sync-stablecoins", now - ONE_WEEK_SEC - 3600); // old
    await insertCronRun(db, "sync-stablecoins", now - 3600);                // fresh

    const result = await runPruneCronHistory(db);

    const rows = await db.prepare("SELECT started_at FROM cron_runs ORDER BY started_at ASC").all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results![0] as { started_at: number }).started_at).toBe(now - 3600);
    expect(result.itemCount).toBe(2); // total deleted across both tables
  });

  it("removes cron_slot_executions older than 14 days and keeps newer rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertSlotExecution(db, "quarterHourly", now - TWO_WEEKS_SEC - 3600);
    await insertSlotExecution(db, "quarterHourly", now - 3600);

    await runPruneCronHistory(db);

    const rows = await db.prepare("SELECT slot_started_at FROM cron_slot_executions").all();
    expect(rows.results).toHaveLength(1);
  });

  it("reports a metadata summary with both deleted counts", async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCronRun(db, "sync-stablecoins", now - ONE_WEEK_SEC - 1);
    await insertSlotExecution(db, "quarterHourly", now - TWO_WEEKS_SEC - 1);

    const result = await runPruneCronHistory(db);
    const metadata = JSON.parse(result.metadata!) as {
      cronRunsDeleted: number;
      slotExecutionsDeleted: number;
    };
    expect(metadata.cronRunsDeleted).toBe(1);
    expect(metadata.slotExecutionsDeleted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/prune-cron-history.test.ts`
Expected: FAIL with "Cannot find module '../prune-cron-history'".

- [ ] **Step 3: Implement `runPruneCronHistory`**

Create `worker/src/cron/prune-cron-history.ts`:

```typescript
import type { CronResult } from "../lib/cron-logger";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/cron-lease";

const SLOT_EXECUTION_RETENTION_SEC = 14 * 24 * 60 * 60;

export async function runPruneCronHistory(db: D1Database): Promise<CronResult> {
  const now = Math.floor(Date.now() / 1000);

  const cronRunsResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(now - SECONDS.ONE_WEEK)
      .run(),
  );
  const cronRunsDeleted = cronRunsResult.meta.changes ?? 0;

  const slotResult = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cron_slot_executions WHERE slot_started_at < ?")
      .bind(now - SLOT_EXECUTION_RETENTION_SEC)
      .run(),
  );
  const slotExecutionsDeleted = slotResult.meta.changes ?? 0;

  return {
    itemCount: cronRunsDeleted + slotExecutionsDeleted,
    metadata: JSON.stringify({
      cronRunsDeleted,
      slotExecutionsDeleted,
      cutoffCronRunsSec: now - SECONDS.ONE_WEEK,
      cutoffSlotExecutionsSec: now - SLOT_EXECUTION_RETENTION_SEC,
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/prune-cron-history.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Register the job and wire it into the daily-0300 slot**

Edit `shared/lib/cron-jobs.ts`. Add to `CRON_JOB_DEFINITIONS_BASE` after the existing `prune-status-probe-runs` entry (currently the last item in the array):

```typescript
  {
    job: "prune-cron-history",
    label: "Cron history TTL prune",
    group: "daily",
    intervalSec: 86400,
    scheduleKey: "daily0300Utc",
    triggerMode: "isolated",
    maxConnections: 0, // DB-only DELETE
  },
```

Edit `worker/src/handlers/scheduled/daily-0300.ts`:

```typescript
import type { ScheduledRuntimeContext } from "./context";
import { runPruneStatusProbeRuns } from "../../cron/prune-status-probe-runs";
import { runPruneCronHistory } from "../../cron/prune-cron-history";

export async function runDaily0300Slot(runtime: ScheduledRuntimeContext): Promise<void> {
  try {
    await runtime.runLeasedCron("prune-status-probe-runs", () =>
      runPruneStatusProbeRuns(runtime.db),
    );
  } catch (err) {
    console.error("[cron] prune-status-probe-runs failed in daily 03:00 slot:", err);
  }

  try {
    await runtime.runLeasedCron("prune-cron-history", () =>
      runPruneCronHistory(runtime.db),
    );
  } catch (err) {
    console.error("[cron] prune-cron-history failed in daily 03:00 slot:", err);
  }
}
```

- [ ] **Step 6: Verify the worker compiles**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/prune-cron-history.ts worker/src/cron/__tests__/prune-cron-history.test.ts shared/lib/cron-jobs.ts worker/src/handlers/scheduled/daily-0300.ts
git commit -m "$(cat <<'EOF'
feat(cron): add prune-cron-history daily housekeeping job

Consolidates TTL pruning for cron_runs (>7d) and cron_slot_executions
(>14d) into a single daily pass. Wiring only; removing the per-run
prune call sites follows in the next commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2: Remove per-run `cron_runs` prune from `logCronRun`

**Files:**
- Modify: `worker/src/lib/cron-logger.ts:179-205`

- [ ] **Step 1: Update the test that asserts per-run pruning (if any)**

Run: `cd worker && grep -rn "DELETE FROM cron_runs" src/lib/__tests__/ src/cron/__tests__/`
Expected output: one or more tests that insert old rows and assert they are gone after `logCronRun`. For each such test, rewrite it to call `runPruneCronHistory` explicitly and remove the assertion that `logCronRun` itself prunes.

If no such test exists, proceed to Step 2.

- [ ] **Step 2: Remove the per-run prune block**

Edit `worker/src/lib/cron-logger.ts`. Replace the `finally` block (currently lines 179-206) with:

```typescript
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (progressActivated) {
      try {
        await clearCronProgress(db, job);
      } catch (err) {
        console.warn(`[db] Failed to clear cron progress for ${job}:`, err);
      }
    }
    // TTL pruning is owned by the daily `prune-cron-history` cron (runs at 03:00 UTC).
  }
  return resolvedResult;
```

Also remove the now-unused `SECONDS` import at line 1 (verified: the prune DELETE at line 192 was its only consumer). Change `import { SECONDS } from "./time-constants";` to delete the line entirely. Keep the other `cron-lease` import unchanged.

- [ ] **Step 3: Verify the worker compiles and all tests pass**

Run:
```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run
```
Expected: no type errors, all tests green.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/cron-logger.ts
git commit -m "$(cat <<'EOF'
refactor(cron): stop pruning cron_runs inside logCronRun

Pruning moves to the daily `prune-cron-history` cron. This removes
~1,400 per-day DELETE statements (one per cron job invocation) that
all enforced the same 7-day TTL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: Remove per-slot `cron_slot_executions` prune from `runScheduledSlotWithFence`

**Files:**
- Modify: `worker/src/lib/cron-lease.ts:256-327`

- [ ] **Step 1: Find and update any tests that depend on per-slot pruning**

Run: `cd worker && grep -rn "pruneScheduledSlotExecutions\|cron_slot_executions" src/`
Expected: identify call sites and tests. Most likely no test asserts the per-slot prune happens; only the new `prune-cron-history` test asserts TTL behavior.

- [ ] **Step 2: Remove the `pruneScheduledSlotExecutions` function and its caller**

Edit `worker/src/lib/cron-lease.ts`:

1. Delete the `pruneScheduledSlotExecutions` function (lines 256-264).
2. In `runScheduledSlotWithFence`, remove the `void pruneScheduledSlotExecutions(db).catch(...)` block from the `finally` (lines 325-327). The `clearInterval(timer)` stays.

The updated `finally` should read:

```typescript
  } finally {
    clearInterval(timer);
  }
```

- [ ] **Step 3: Verify compilation and tests**

Run:
```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/cron-lease.ts
git commit -m "$(cat <<'EOF'
refactor(cron): stop pruning cron_slot_executions inside slot fence

Pruning moves to the daily `prune-cron-history` cron. This removes
~1,100 per-day DELETE statements (one per scheduled slot completion)
that all enforced the same 14-day TTL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part B — Fix Snapshot Cooldown Bugs

**Why:** Both `snapshot-supply` and `snapshot-chain-supply` are commented as "one snapshot per day" (see `shared/lib/cron-jobs.ts:281-299` — `intervalSec: DAY_SECONDS`). In reality each has `COOLDOWN_SEC = 3600` (1 h). Because both write with `INSERT OR REPLACE` keyed on `snapshot_date = UTC midnight`, 23 of the 24 daily writes overwrite the same row. This is pure D1 write pressure on `supply_history` and `chain_supply_history`. The fix is one-line each.

### Task 4: Raise `snapshot-supply` cooldown to 20 h

**Files:**
- Modify: `worker/src/cron/snapshot-supply.ts:41`
- Modify: `worker/src/cron/__tests__/snapshot-supply.test.ts` (adjust cooldown assertion if present)

- [ ] **Step 1: Identify cooldown-related assertions in the test file**

Run: `cd worker && grep -n "COOLDOWN_SEC\|cooldown_active\|3600" src/cron/__tests__/snapshot-supply.test.ts`
If an existing test asserts a 3600 s cooldown, plan to update it in Step 3.

- [ ] **Step 2: Change the cooldown constant**

Edit `worker/src/cron/snapshot-supply.ts` line 41:

```typescript
  // One snapshot per UTC day. Use 20h (not 24h) so we tolerate daylight/leap-second
  // drift without skipping a day. INSERT OR REPLACE on snapshot_date makes
  // additional same-day writes pure churn.
  const COOLDOWN_SEC = 20 * 3600;
```

- [ ] **Step 3: Update any affected test**

If Step 1 found a test asserting 3600 s, change the numeric constant to `20 * 3600` and re-read the cooldown-active branch to confirm the semantic still matches (the branch only gates further writes the same day — semantics unchanged).

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/snapshot-supply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/snapshot-supply.ts worker/src/cron/__tests__/snapshot-supply.test.ts
git commit -m "$(cat <<'EOF'
fix(cron): snapshot-supply cooldown matches its one-per-day intent

Previous 1-hour cooldown let the job write 24× per day, overwriting
the same snapshot_date row 23 times. Raise to 20h so we tolerate
clock drift while keeping one write per UTC day.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5: Raise `snapshot-chain-supply` cooldown to 20 h

**Files:**
- Modify: `worker/src/cron/snapshot-chain-supply.ts:25`
- Modify: `worker/src/cron/__tests__/snapshot-chain-supply.test.ts` (if needed)

- [ ] **Step 1: Identify cooldown-related assertions in the test file**

Run: `cd worker && grep -n "COOLDOWN_SEC\|cooldown_active\|3600" src/cron/__tests__/snapshot-chain-supply.test.ts`
If an existing test asserts a 3600 s cooldown, plan to update it in Step 3.

- [ ] **Step 2: Change the cooldown constant**

Edit `worker/src/cron/snapshot-chain-supply.ts` line 25:

```typescript
  // One snapshot per UTC day. See snapshot-supply.ts for the rationale.
  const COOLDOWN_SEC = 20 * 3600;
```

- [ ] **Step 3: Update any affected test**

If Step 1 found a test that binds the cache with an age < 3600 s and asserts the `cooldown_active` branch, change the binding age to something < 20 * 3600 (e.g., 10 * 3600) so the assertion still verifies the branch. If the test binds an age > 3600 and expects the branch to NOT fire, change the binding age to > 20 * 3600 (e.g., 21 * 3600). Semantics unchanged.

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/snapshot-chain-supply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/snapshot-chain-supply.ts worker/src/cron/__tests__/snapshot-chain-supply.test.ts
git commit -m "$(cat <<'EOF'
fix(cron): snapshot-chain-supply cooldown matches its one-per-day intent

Same bug as snapshot-supply: 1-hour cooldown led to 24 INSERT OR
REPLACE writes per UTC day. Raise to 20h.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part C — Cadence Reductions

**Why:** Each of these five jobs fires faster than its underlying data volatility. The evidence for each is in the findings summary at the top. Cadence changes require coordinated updates across `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled.ts`, and `worker/wrangler.toml`. Failing to touch all four leaves the registry inconsistent and the worker will throw `Unknown scheduled trigger` at runtime.

### Task 6: Add a 30-minute cooldown to `sync-fx-rates`

This one is a pure cooldown: the shared `quarter-hourly` slot keeps firing every 15 min because `sync-stablecoins` needs it. FX runs become a no-op on alternating invocations. Zero schedule registry churn.

**Files:**
- Modify: `worker/src/cron/sync-fx-rates.ts` (top of `syncFxRates`)
- Modify: `worker/src/cron/__tests__/sync-fx-rates.test.ts`
- Modify: `shared/lib/cron-jobs.ts` — change `intervalSec: 900 → 1800` for the `sync-fx-rates` entry

- [ ] **Step 1: Write the failing test**

Add to `worker/src/cron/__tests__/sync-fx-rates.test.ts` (find a describe block and append):

```typescript
it("skips with cooldown_active when last write is <30 min old", async () => {
  const now = Math.floor(Date.now() / 1000);
  // Seed the cooldown cache key to simulate a recent write.
  await db
    .prepare(
      "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES ('sync-fx-rates:last-write', '1', ?)",
    )
    .bind(now - 600) // 10 min ago
    .run();

  const result = await syncFxRates(db, undefined, null, new Map(), null, null);
  const metadata = JSON.parse(result.metadata as string);

  expect(metadata.reason).toBe("cooldown_active");
  expect(result.itemCount).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd worker && npx vitest run src/cron/__tests__/sync-fx-rates.test.ts -t "cooldown_active"`
Expected: FAIL.

- [ ] **Step 3: Add the cooldown check to `syncFxRates`**

Edit `worker/src/cron/sync-fx-rates.ts`. Immediately after the function signature and before any fetch work, add:

```typescript
import { getCache, setCache } from "../lib/db-cache";
// ... existing imports unchanged

export async function syncFxRates(/* existing params */): Promise<CronResult> {
  const startSec = Math.floor(Date.now() / 1000);
  const COOLDOWN_SEC = 30 * 60;
  const lastWrite = await getCache(db, "sync-fx-rates:last-write");
  if (lastWrite && startSec - lastWrite.updatedAt < COOLDOWN_SEC) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "cooldown_active",
        lastWriteAgeSec: startSec - lastWrite.updatedAt,
      }),
    };
  }

  // ... existing body unchanged

  // At the end of the successful write path, before returning the final result:
  await setCache(db, "sync-fx-rates:last-write", "1");
  return finalResult;
}
```

**Important:** Set the `sync-fx-rates:last-write` key only on the successful write path so that a failed run does not block the next attempt.

- [ ] **Step 4: Update `CRON_JOB_DEFINITIONS` intervalSec**

Edit `shared/lib/cron-jobs.ts`. In the `sync-fx-rates` definition (around line 166), change:

```typescript
  {
    job: "sync-fx-rates",
    label: "FX rates",
    group: "quarter-hourly",
    intervalSec: 1800, // 30-minute effective cadence via cooldown
    scheduleKey: "quarterHourly",
    triggerMode: "shared",
    maxConnections: 2,
    connectionGroup: "quarter-hourly-chain",
  },
```

- [ ] **Step 5: Run tests and type-check**

Run:
```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/__tests__/sync-fx-rates.test.ts
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/sync-fx-rates.ts worker/src/cron/__tests__/sync-fx-rates.test.ts shared/lib/cron-jobs.ts
git commit -m "$(cat <<'EOF'
perf(cron): gate sync-fx-rates with 30-min cooldown

FX rates rarely move meaningfully in 15 min. Keeping the quarter-
hourly trigger (sync-stablecoins still needs it) but gating FX writes
to every 30 min halves the external fetches to Frankfurter, fawazahmed0
mirrors, OXR, and Chainlink feeds. Updates intervalSec so cron-health
staleness checks align with the new effective cadence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 7: Move `sync-blacklist` to every 6 hours

Blacklist freezes/unblocks across USDT, USDC, BUIDL, etc. total ~1–3 network-wide per week. Hourly scanning of 72 contract configs is over-polling.

**Files:**
- Modify: `shared/lib/cron-jobs.ts`
- Modify: `shared/lib/scheduled-runner-registry.ts`
- Modify: `worker/src/handlers/scheduled.ts`
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/handlers/scheduled/hourly-blacklist.ts` → (optionally rename file to `six-hourly-blacklist.ts`)
- Modify: `docs/api-reference.md:578, 658`
- Modify: `docs/mint-burn-flows.md:32, 683`
- Modify: any test that asserts the hourly schedule expression

- [ ] **Step 1: Rename scheduleKey in `CRON_SCHEDULES`**

Edit `shared/lib/cron-jobs.ts`:

```typescript
export const CRON_SCHEDULES = {
  quarterHourly: "*/15 * * * *",
  statusSelfCheckOffset: "9,24,39,54 * * * *",
  sixHourlyBlacklist: "3 */6 * * *",            // was hourlyBlacklist: "3 * * * *"
  twentyMinuteMintBurn: "4,24,44 * * * *",
  // ... rest unchanged
} as const;
```

Edit `CRON_SCHEDULE_BUCKETS` in the same file:

```typescript
const CRON_SCHEDULE_BUCKETS = {
  quarterHourly: { intervalSec: 900, offsetSec: 0 },
  statusSelfCheckOffset: { intervalSec: 900, offsetSec: 9 * 60 },
  sixHourlyBlacklist: { intervalSec: 6 * 3600, offsetSec: 3 * 60 },
  // ... rest unchanged
} as const;
```

Update the `sync-blacklist` entry in `CRON_JOB_DEFINITIONS_BASE`:

```typescript
  {
    job: "sync-blacklist",
    label: "Blacklist sync",
    group: "multi-hourly",                  // was "hourly"
    intervalSec: 6 * 3600,
    scheduleKey: "sixHourlyBlacklist",
    triggerMode: "isolated",
    maxConnections: 1,
  },
```

- [ ] **Step 2: Update `SCHEDULED_RUNNER_KEYS_BY_SCHEDULE`**

Edit `shared/lib/scheduled-runner-registry.ts`:

```typescript
  [CRON_SCHEDULES.sixHourlyBlacklist]: "sixHourlyBlacklist",
```

(Remove the old `[CRON_SCHEDULES.hourlyBlacklist]: "hourlyBlacklist"` line.)

- [ ] **Step 3: Update the worker handler registry**

Edit `worker/src/handlers/scheduled.ts`:

```typescript
import { runSixHourlyBlacklistSlot } from "./scheduled/hourly-blacklist"; // filename can stay

const SLOT_RUNNER_BY_KEY = {
  quarterHourly: runQuarterHourlySlot,
  statusSelfCheckOffset: runStatusSelfCheckSlot,
  sixHourlyBlacklist: runSixHourlyBlacklistSlot, // was hourlyBlacklist: runHourlyBlacklistSlot
  // ... rest unchanged
} satisfies Record<ScheduledRunnerKey, SlotRunner>;
```

And in `worker/src/handlers/scheduled/hourly-blacklist.ts`, rename the exported function:

```typescript
export async function runSixHourlyBlacklistSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  // body unchanged
}
```

- [ ] **Step 4: Update `wrangler.toml`**

Edit `worker/wrangler.toml` `[triggers].crons`. Replace the line `"3 * * * *"` with `"3 */6 * * *"`. The replacement should be one-for-one; do not add or remove other entries.

- [ ] **Step 5: Update docs**

Edit `docs/api-reference.md` lines 578 and 658: replace "hourly `sync-blacklist`" with "6-hourly `sync-blacklist`". Replace "hourly freshness headers" with "6-hourly freshness headers".

Edit `docs/mint-burn-flows.md` line 32: replace the hourly description with:

```markdown
- **Trigger mode:** isolated. `sync-blacklist` runs on its own dedicated 6-hourly trigger (`3 */6 * * *`); `sync-dex-discovery` runs on a dedicated hourly trigger (`6 * * * *`).
```

- [ ] **Step 6: Update tests that hardcode the schedule expression**

Run: `cd worker && grep -rn '"3 \* \* \* \*"\|hourlyBlacklist' src/`. For each match, either update the string to `"3 */6 * * *"` or to the renamed key `sixHourlyBlacklist`, or both.

Also run: `cd worker && grep -n 'intervalSec.*3600' src/cron/__tests__/sync-blacklist.test.ts`. Update any assumption that the job runs hourly.

- [ ] **Step 7: Run full cron test suite + type-check**

Run:
```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run src/cron/__tests__/sync-blacklist.test.ts src/handlers/scheduled/__tests__/ src/api/__tests__/status.test.ts
```
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add shared/lib/cron-jobs.ts shared/lib/scheduled-runner-registry.ts worker/src/handlers/scheduled.ts worker/src/handlers/scheduled/hourly-blacklist.ts worker/wrangler.toml docs/api-reference.md docs/mint-burn-flows.md worker/src/cron/__tests__/sync-blacklist.test.ts
git commit -m "$(cat <<'EOF'
perf(cron): move sync-blacklist from hourly to every 6h

Blacklist events (USDT/USDC/BUIDL freezes) are ~1-3 per week network-
wide. Hourly scanning of 72 contract configs over-polls Etherscan,
TronGrid, and fallback RPCs. Cursor advancement is already resilient
to missed runs, so 6h cadence only lengthens worst-case detection
latency from 1h to 6h (vs. the days-long upstream indexing lag).

Renames scheduleKey hourlyBlacklist → sixHourlyBlacklist so future
readers do not trust a misleading label.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8: Move `sync-live-reserves` slot to every 4 hours

This slot chains `sync-live-reserves` → `sync-redemption-backstops` → `sync-kinesis-supply` → drift-check. Reserve attestations update daily or weekly at most; the hourly scan is pure polling cost on Chainlink PoR, Ethena, Tether transparency pages, and per-coin EVM/RPC probes. `sync-kinesis-supply` and `sync-redemption-backstops` piggyback on the same slot — both tolerate a 4h cadence (kinesis is 2 HTTP calls; backstops is DB-only with a `>3600s stale` warning that can be raised).

**Files:**
- Modify: `shared/lib/cron-jobs.ts`
- Modify: `shared/lib/scheduled-runner-registry.ts`
- Modify: `worker/src/handlers/scheduled.ts`
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/handlers/scheduled/hourly-live-reserves.ts` (rename exported function)
- Modify: `docs/redemption-backstops.md:36`
- Update tests that hardcode the schedule

- [ ] **Step 1: Rename scheduleKey in `CRON_SCHEDULES` and buckets**

Edit `shared/lib/cron-jobs.ts`:

```typescript
  fourHourlyReserveSync: "11 */4 * * *",   // was hourlyReserveSync: "11 * * * *"
```

```typescript
  fourHourlyReserveSync: { intervalSec: 4 * 3600, offsetSec: 11 * 60 },
```

Update the three job entries that reference this scheduleKey:

```typescript
  {
    job: "sync-live-reserves",
    label: "Live reserve sync",
    group: "multi-hourly",                       // was "hourly"
    intervalSec: 4 * 3600,                       // was 3600
    scheduleKey: "fourHourlyReserveSync",        // was "hourlyReserveSync"
    triggerMode: "shared",
    maxConnections: 2,
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-redemption-backstops",
    label: "Redemption backstops",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 0,
    connectionGroup: "reserve-sync-chain",
  },
  {
    job: "sync-kinesis-supply",
    label: "Kinesis supply",
    group: "multi-hourly",
    intervalSec: 4 * 3600,
    scheduleKey: "fourHourlyReserveSync",
    triggerMode: "shared",
    maxConnections: 1,
    connectionGroup: "reserve-sync-chain",
  },
```

- [ ] **Step 2: Update scheduled-runner-registry**

Edit `shared/lib/scheduled-runner-registry.ts`: replace the `hourlyReserveSync` line with `fourHourlyReserveSync`.

- [ ] **Step 3: Update `handlers/scheduled.ts`**

```typescript
import { runFourHourlyReserveSyncSlot } from "./scheduled/hourly-live-reserves";

const SLOT_RUNNER_BY_KEY = {
  // ...
  fourHourlyReserveSync: runFourHourlyReserveSyncSlot,
  // ...
};
```

And in `worker/src/handlers/scheduled/hourly-live-reserves.ts`:
- Rename `runHourlyReserveSyncSlot` to `runFourHourlyReserveSyncSlot`.
- Update the JSDoc header comment at the top from "Hourly reserve-sync trigger (11 * * * *)" to "Four-hourly reserve-sync trigger (11 */4 * * *)".
- Raise the `maxAge > 6 * 3600` alert threshold at line 67 to `12 * 3600`:

```typescript
    const maxAge = await getMaxSyncAge(runtime.db);
    if (maxAge > 12 * 3600) {
      sendAlert(
        runtime.alertWebhookUrl,
        "Live reserve sync stale",
        `No successful sync in ${Math.round(maxAge / 3600)}h. Check cron scheduler.`,
      ).catch(() => {});
    }
```

Rationale: at the old 1 h cadence, 6 h was a ~6× cadence buffer (alert on several missed runs). At the new 4 h cadence, 6 h becomes a 1.5× buffer (alerts on a single delayed run). Raising to 12 h restores a "3 missed runs" alerting posture without shipping noisy false alarms in the first deploy window.

- [ ] **Step 4: Update `wrangler.toml`**

Replace `"11 * * * *"` with `"11 */4 * * *"` in `[triggers].crons`.

- [ ] **Step 5: Verify the backstop liquidity staleness warning is not affected**

Inspect `worker/src/cron/sync-redemption-backstops.ts:72-77`:

```typescript
  let liquidityStale = false;
  if (latestUpdatedAt != null) {
    const ageSec = now - latestUpdatedAt;
    if (ageSec > 3600) {
      console.warn(`[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
      liquidityStale = true;
    }
  }
```

This warning measures **DEX liquidity cache** age (written by `sync-dex-liquidity` every 30 min, unchanged in this plan), not reserve cache age. The 3600 s threshold remains correct. **Do not change.**

- [ ] **Step 6: Update docs**

Edit `docs/redemption-backstops.md:36`: replace "hourly reserve lane" with "4-hourly reserve lane".

Search the docs tree for other cadence references:
```bash
grep -rn "hourly.*reserve\|reserve.*hourly\|sync-live-reserves.*hour" docs/
```
Update each hit.

- [ ] **Step 7: Update tests**

Run: `cd worker && grep -rn '"11 \* \* \* \*"\|hourlyReserveSync' src/`. Update each occurrence.

Also check `worker/src/handlers/scheduled/__tests__/hourly-live-reserves.test.ts`. The file can stay named `hourly-live-reserves.test.ts`, but references inside may need to change to `fourHourlyReserveSync`.

- [ ] **Step 8: Verify and commit**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run
```

```bash
git add -A
git commit -m "$(cat <<'EOF'
perf(cron): move reserve-sync slot from hourly to every 4h

sync-live-reserves scans ~147 coins per run; most reserve attestations
(Chainlink PoR, Ethena app, Tether transparency, etc.) update daily
or weekly, so hourly polling is wasted RPC + HTTP traffic. Shifts the
slot to 4h, renames scheduleKey hourlyReserveSync → fourHourlyReserveSync,
and raises the slot's "sync stale" alert threshold from 6h to 12h so
it still corresponds to "3+ missed runs" at the new cadence.

sync-redemption-backstops and sync-kinesis-supply chain on the same
slot and tolerate the new cadence (kinesis is 2 HTTP fetches;
backstops is DB-only and its existing liquidity-staleness warning
targets the 30-min dex-liquidity cache, so it is unaffected).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8b: Align `API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops` with the new cadence

The `/api/redemption-backstops` endpoint exposes freshness via HTTP `Warning` / `X-Data-Age` headers. The budget is currently hardcoded to 3600 s (1 h) in `shared/lib/api-freshness.ts:15`. After Task 8 lands, the underlying cache legitimately ages up to 4 h, so the UI banner and HTTP headers would fire "stale" on every run. The fix: derive the budget from `CRON_INTERVALS["sync-redemption-backstops"]` the same way `blacklist`, `yieldRankings`, and `mintBurnFlows` already do.

**Files:**
- Modify: `shared/lib/api-freshness.ts:15`
- Modify: any test that asserts the old 3600 s budget for this key

- [ ] **Step 1: Find tests that depend on the old budget**

Run: `cd worker && grep -rn 'redemptionBackstops.*3600\|API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops' .`. Update each assertion that hardcodes 3600 to read `CRON_INTERVALS["sync-redemption-backstops"] * 2` dynamically, or to expect the new 28800 s (8 h) value.

- [ ] **Step 2: Update the budget**

Edit `shared/lib/api-freshness.ts`. Replace line 15:

```typescript
  redemptionBackstops: CRON_INTERVALS["sync-redemption-backstops"] * 2,
```

The `× 2` matches the pattern used by `mintBurnFlows` on line 16 — fresh = within one cadence, warn = within two cadences. After Task 8 runs `CRON_INTERVALS["sync-redemption-backstops"]` is 14400, so the budget resolves to 28800 s (8 h), which correctly accommodates one missed run plus jitter.

- [ ] **Step 3: Verify front-end staleness banner picks up the new value**

The front-end consumes this via `src/lib/data-health-config.ts:15` (`staleTime: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 1000`). No frontend edit needed — it re-exports the shared value. Confirm by reading the file and observing it still references `API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops` with no hardcoded override.

- [ ] **Step 4: Run tests + commit**

```bash
cd worker && npx vitest run
npm test
```

```bash
git add shared/lib/api-freshness.ts
git commit -m "$(cat <<'EOF'
fix(api): align redemption-backstops freshness budget with 4h cron

Before: hardcoded 3600s (1h) — correct for the old 1-hourly cron.
After: derived from CRON_INTERVALS["sync-redemption-backstops"] × 2
(8h), matching the pattern used by mintBurnFlows. Without this,
Task 8's 1h→4h cadence change would trigger the Warning header and
UI stale-data banner on every run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 9: Move both mint-burn lanes from 20 min to 30 min

Both the critical lane (USDT/USDC/DAI/USDS/GHO/FRXUSD/BOLD/reUSD) and the extended lane (~82 lower-tier coins) drop from a 20-minute cadence to 30 minutes. Rationale:

- **Critical lane (higher-stakes change).** No downstream consumer hard-depends on <30-min mint-burn freshness. The quarter-hourly `<20 min` gate in `worker/src/handlers/scheduled/quarter-hourly.ts:70` is for the stablecoins cache, not mint-burn. The mint-burn freshness SLA (`MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC`) is derived from `MINT_BURN_CRITICAL_LANE_INTERVAL_SEC × 2`; raising the interval to 30 min automatically lifts the SLA from 40 min to 60 min.
- **Extended lane.** Already identified as over-polled for long-tail coins.
- **Offset preservation.** 9 min between lane starts (`4,34` vs `13,43`) preserves the current stagger, so the two lanes still do not compete for the Alchemy connection pool.

Combined effect: ~33% Alchemy CU reduction on both lanes, with the critical-lane SLA still comfortably inside the hour.

**Files:**
- Modify: `shared/lib/cron-jobs.ts` (rename both scheduleKeys; change cron expressions; update `intervalSec` on both job entries)
- Modify: `shared/lib/scheduled-runner-registry.ts` (rename mappings)
- Modify: `worker/src/handlers/scheduled.ts` (rename imports + `SLOT_RUNNER_BY_KEY` keys)
- Modify: `worker/wrangler.toml` (both cron expressions)
- Modify: `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts` (rename exported function; filename can stay)
- Modify: `worker/src/handlers/scheduled/twenty-minute-mint-burn-extended.ts` (rename exported function; filename can stay)
- Modify: `worker/src/lib/mint-burn-health-config.ts:15` (`MINT_BURN_CRITICAL_LANE_INTERVAL_SEC = 20 * 60` → `30 * 60`)
- Update tests and docs

- [ ] **Step 1: Raise the critical-lane interval constant (anchors the SLA)**

Edit `worker/src/lib/mint-burn-health-config.ts` line 15:

```typescript
const MINT_BURN_CRITICAL_LANE_INTERVAL_SEC = 30 * 60;
```

This single change cascades: `MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC` (line 17) now resolves to 3600 (60 min), which `computeMintBurnSyncFreshnessStatus` consumes for fresh/degraded/stale bucketing. Also update the two user-facing warning strings at lines 93 and 95 to say "30-minute cron cadence" instead of "20-minute cron cadence".

- [ ] **Step 2: Rename scheduleKeys in `CRON_SCHEDULES` and buckets**

Edit `shared/lib/cron-jobs.ts`:

```typescript
  halfHourlyMintBurnCritical: "4,34 * * * *",      // was twentyMinuteMintBurn: "4,24,44 * * * *"
  halfHourlyMintBurnExtended: "13,43 * * * *",     // was twentyMinuteExtendedOffset: "13,33,53 * * * *"
```

```typescript
  halfHourlyMintBurnCritical: { intervalSec: 1800, offsetSec: 4 * 60 },
  halfHourlyMintBurnExtended: { intervalSec: 1800, offsetSec: 13 * 60 },
```

Update the two job entries in `CRON_JOB_DEFINITIONS_BASE`:

```typescript
  {
    job: "sync-mint-burn",
    label: "Mint/burn critical",
    group: "half-hourly",                          // was "twenty-minute"
    intervalSec: 1800,                             // was 1200
    scheduleKey: "halfHourlyMintBurnCritical",     // renamed
    triggerMode: "isolated",
    maxConnections: 1,
  },
  {
    job: "sync-mint-burn-extended",
    label: "Mint/burn extended",
    group: "half-hourly",                          // was "twenty-minute"
    intervalSec: 1800,                             // was 1200
    scheduleKey: "halfHourlyMintBurnExtended",     // renamed
    triggerMode: "isolated",
    maxConnections: 1,
  },
```

- [ ] **Step 3: Update scheduled-runner-registry**

Edit `shared/lib/scheduled-runner-registry.ts`. Replace both mappings:

```typescript
  [CRON_SCHEDULES.halfHourlyMintBurnCritical]: "halfHourlyMintBurnCritical",
  [CRON_SCHEDULES.halfHourlyMintBurnExtended]: "halfHourlyMintBurnExtended",
```

Remove the old `twentyMinuteMintBurn` and `twentyMinuteExtendedOffset` lines.

- [ ] **Step 4: Update handler registry and exported functions**

Edit `worker/src/handlers/scheduled.ts`:

```typescript
import { runHalfHourlyMintBurnCriticalSlot } from "./scheduled/twenty-minute-mint-burn-critical";
import { runHalfHourlyMintBurnExtendedSlot } from "./scheduled/twenty-minute-mint-burn-extended";

const SLOT_RUNNER_BY_KEY = {
  // ...
  halfHourlyMintBurnCritical: runHalfHourlyMintBurnCriticalSlot,
  halfHourlyMintBurnExtended: runHalfHourlyMintBurnExtendedSlot,
  // ...
};
```

In `worker/src/handlers/scheduled/twenty-minute-mint-burn-critical.ts`, rename the exported function from `runTwentyMinuteMintBurnCriticalSlot` to `runHalfHourlyMintBurnCriticalSlot`. Same shape in `twenty-minute-mint-burn-extended.ts`.

Filenames can stay (they are internal), but consider renaming them to `half-hourly-mint-burn-critical.ts` / `half-hourly-mint-burn-extended.ts` in a follow-up commit if desired.

- [ ] **Step 5: Update `wrangler.toml`**

In `[triggers].crons`, replace:
- `"4,24,44 * * * *"` → `"4,34 * * * *"`
- `"13,33,53 * * * *"` → `"13,43 * * * *"`

Replacements are one-for-one; do not add or remove other entries. The two new lines preserve the 9-minute stagger between lanes.

- [ ] **Step 6: Update docs**

Search and update each hit:
```bash
grep -rn "20-minute\|twenty-minute\|twentyMinute.*MintBurn\|twentyMinute.*Extended\|4,24,44\|13,33,53\|MINT_BURN_CRITICAL_LANE_INTERVAL_SEC" docs/
```

In `docs/mint-burn-flows.md` specifically, update the cadence-describing paragraphs around lines 32–42 and anywhere referencing the 40-min SLA (now 60 min).

- [ ] **Step 7: Update tests**

Run: `cd worker && grep -rn "twentyMinuteMintBurn\|twentyMinuteExtendedOffset\|4,24,44\|13,33,53\|MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC.*40\|20.\*60" src/`. Update each. The `mint-burn-health-config.ts` tests in particular may assert a 40-min freshness bound — update to 60 min.

Also check `worker/src/cron/__tests__/sync-mint-burn.test.ts` and `mint-burn-run-state-rotation.test.ts` for hardcoded interval assumptions.

- [ ] **Step 8: Verify and commit**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run
```
Expected: green.

```bash
git add -A
git commit -m "$(cat <<'EOF'
perf(cron): move both mint-burn lanes from 20 min to 30 min

Critical lane (sync-mint-burn) and extended lane (sync-mint-burn-
extended) both drop to a 30-minute cadence. MINT_BURN_CRITICAL_LANE_
INTERVAL_SEC rises to 30 min, which lifts the public freshness SLA
from 40 min to 60 min in lockstep via the existing × 2 derivation.

Renames scheduleKeys twentyMinuteMintBurn → halfHourlyMintBurnCritical
and twentyMinuteExtendedOffset → halfHourlyMintBurnExtended. 9-minute
stagger between lanes preserved (4,34 vs 13,43) so Alchemy connection
pools do not collide.

~33% Alchemy CU reduction on both lanes. No downstream consumer of
mint-burn data requires <30-min freshness (the stablecoins cache
<20 min gate is in quarter-hourly.ts and independent).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 10: Move `sync-dex-discovery` from 30 min to every 2 hours

Pool discovery is slow-moving: new pools appear with new protocol deployments, not intraday. Discovery already tiers its work (`worker/src/cron/dex-discovery/orchestrator.ts:51-86`): Tier-1 coins every run, Tier-2 every 2–3 runs, Tier-3 every 5+. Moving to 2 h keeps Tier-1 ≤2 h stale, which is well within the window new pools need to accumulate meaningful liquidity. Tier-2 lands every 4–6 h and Tier-3 every 10+ h, both of which were already the implicit intent of the tiered scheduler.

Upside vs. the earlier hourly proposal:
- GT/CG/DS crawl traffic drops 75% (48 → 12 runs/day), not 50%.
- Releases GT `30 req/min` headroom entirely for `sync-dex-liquidity` (the tight budget consumer).
- No product impact: `sync-dex-liquidity` continues scoring existing pools every 30 min independently — discovery only adds new pools, which already take time to matter.

4 h was considered and rejected: on active deployment days (e.g., a new chain launch), 4 h would sometimes let Tier-1 pools sit undiscovered long enough to briefly distort liquidity scoring. 2 h is the tighter bound.

**Files:**
- Modify: `shared/lib/cron-jobs.ts` (rename `thirtyMinuteDexDiscovery` → `twoHourlyDexDiscovery`)
- Modify: `shared/lib/scheduled-runner-registry.ts`
- Modify: `worker/src/handlers/scheduled.ts`
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts` (rename exported function)
- Update tests and docs

- [ ] **Step 1: Rename scheduleKey**

Edit `shared/lib/cron-jobs.ts`:

```typescript
  twoHourlyDexDiscovery: "6 */2 * * *",     // was thirtyMinuteDexDiscovery: "6,36 * * * *"
```

```typescript
  twoHourlyDexDiscovery: { intervalSec: 2 * 3600, offsetSec: 6 * 60 },
```

Update the `sync-dex-discovery` entry in `CRON_JOB_DEFINITIONS_BASE`:

```typescript
  {
    job: "sync-dex-discovery",
    label: "DEX pool discovery",
    group: "multi-hourly",                 // was "half-hourly"
    intervalSec: 2 * 3600,                 // was 1800
    scheduleKey: "twoHourlyDexDiscovery",
    triggerMode: "isolated",
    maxConnections: 1,
  },
```

- [ ] **Step 2: Update scheduled-runner-registry + handlers**

Replace `thirtyMinuteDexDiscovery` with `twoHourlyDexDiscovery` in `shared/lib/scheduled-runner-registry.ts` and in the `SLOT_RUNNER_BY_KEY` object of `worker/src/handlers/scheduled.ts`. In `worker/src/handlers/scheduled/thirty-minute-dex-discovery.ts`, rename the exported function from `runThirtyMinuteDexDiscoverySlot` to `runTwoHourlyDexDiscoverySlot`.

- [ ] **Step 3: Update `wrangler.toml`**

Replace `"6,36 * * * *"` with `"6 */2 * * *"` in `[triggers].crons`.

- [ ] **Step 4: Verify the discovery orchestrator budget still fits**

Inspect `worker/src/cron/dex-discovery/orchestrator.ts`. Confirm `DEX_DISCOVERY_RUN_BUDGET_MS = 12 * 60_000` (12 min) remains well under the scheduled-event wall-clock ceiling (15 min). No change needed; this step only guards against the rare case where the longer gap between runs leads an operator to want a larger per-run budget. Leave the budget constant as-is.

- [ ] **Step 5: Update docs**

Search: `grep -rn "6,36\|thirty-minute\|30-minute.*discovery\|thirtyMinuteDexDiscovery" docs/`. Update each, including `docs/mint-burn-flows.md:32` which was already amended in Task 7 (update the "hourly trigger" phrasing there to "2-hourly trigger (`6 */2 * * *`)").

- [ ] **Step 6: Update tests**

Run: `cd worker && grep -rn "thirtyMinuteDexDiscovery\|6,36\|intervalSec.*1800.*discovery" src/`. Update each.

- [ ] **Step 7: Verify and commit**

```bash
cd worker && npx tsc --noEmit
cd worker && npx vitest run
```

```bash
git add -A
git commit -m "$(cat <<'EOF'
perf(cron): move sync-dex-discovery from 30 min to every 2h

Pool discovery is slow-moving and already tiered (Tier-1 every run,
Tier-2/3 every 2-5 runs). 2h cadence keeps Tier-1 ≤2h stale, which
new pools need anyway to accumulate meaningful liquidity. Cuts
GT/CG/DS crawl traffic by 75% (48 → 12 runs/day) and releases the
tight GT 30 req/min headroom for sync-dex-liquidity.

sync-dex-liquidity continues scoring existing pools every 30 min
independently, so discovery only adds net-new pools.

Renames scheduleKey thirtyMinuteDexDiscovery → twoHourlyDexDiscovery.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part D — Documentation Consolidation

Individual tasks above each update the small set of docs directly touching their change surface. This part is a single bundled pass that covers the cross-cutting reference pages so no contributor ends up reading a doc whose cadences disagree with the deployed reality.

### Task 11: Update cross-cutting reference docs

**Files:**
- `README.md` (top-level cron table at lines 221–234)
- `docs/worker-infrastructure.md` (cron trigger tables at lines 3, 328–333, 363–475, 492–497, 903, 984, 1000, 1086–1102)
- `docs/live-reserves.md` (lines 10–11, 132, 204, 225)
- `docs/supply-snapshot.md` (lines 40, 239, 256)
- `docs/dex-liquidity.md` (lines 5, 66, 281, 284–285)
- `docs/mint-burn-flows.md` (any line mentioning "20-minute", the mint-burn SLA, or the blacklist cron expression — prior tasks touched some but this task is the second-pass sweep)
- `docs/api-reference.md` (lines 578, 658 — blacklist freshness language)
- `docs/redemption-backstops.md` (line 36, and any "hourly lane" reference)
- Any other `.md` file matched by the verification grep in Step 5

- [ ] **Step 1: Update `README.md` top-level cron table**

Replace the affected lines (221–234) with:

```markdown
Cloudflare Worker (API layer)
  ├── Cron: */15 * * * *                        → sync stablecoins (includes depeg detection + confirmation) + downstream-safe snapshot-supply retry + snapshot-chain-supply + FX rates
  ├── Cron: 9,24,39,54 * * * *                  → status self-check
  ├── Cron: 3 */6 * * *                         → blacklist sync (every 6h)
  ├── Cron: 4,34 * * * *                        → mint/burn critical lane (every 30 min)
  ├── Cron: 6 */2 * * *                         → DEX discovery staging (every 2h)
  ├── Cron: 13,43 * * * *                       → mint/burn extended lane (every 30 min)
  ├── Cron: 10,40 * * * *                       → stablecoin charts + DEX liquidity + DEWS + PSI
  ├── Cron: 11 */4 * * *                        → live reserve sync + redemption backstop snapshots + Kinesis supply + collateral drift check (every 4h)
  ├── Cron: 20 * * * *                          → yield sync
  ├── Cron: 25 */4 * * *                        → supplemental yield sync
  ├── Cron: 2,7,12,17,22,27,32,37,42,47,52,57 * * * * → Telegram subscriber alerts
  ├── Cron: 0 8 * * *                           → supply snapshot + safety-grade snapshot + T-bill rate + PSI daily snapshot + USDS status
  ├── Cron: 5 8 * * *                           → Bluechip sync + daily digest + weekly recap (Mondays) + discovery scan (Mondays)
  ├── Cron: 0 3 * * *                           → status-probe TTL prune + cron-history TTL prune
  └── Cron: 0 6 1 * *                           → monthly yield coverage audit
```

Note: the `0 3 * * *` line was already present but did not call out the two chained jobs it now carries. Make the second-line pass explicit so the README matches `daily-0300.ts` after Task 1 lands.

- [ ] **Step 2: Update `docs/worker-infrastructure.md`**

a. Line 3 (header): change "29 scheduled runtime jobs" → "30 scheduled runtime jobs" (the +1 is `prune-cron-history`).

b. Lines 328–333 (wrangler.toml reproduction): update the cron strings in the code block to match `wrangler.toml` exactly after Tasks 7/8/9/10.

c. Trigger section headers (lines 371, 379, 387, 396, 417):

| Line | Before | After |
| --- | --- | --- |
| 371 | `### Trigger 3: \`3 * * * *\` (blacklist — dedicated hourly)` | `### Trigger 3: \`3 */6 * * *\` (blacklist — dedicated, every 6h)` |
| 379 | `### Trigger 4: \`4,24,44 * * * *\` (mint/burn critical — dedicated)` | `### Trigger 4: \`4,34 * * * *\` (mint/burn critical — dedicated, every 30 min)` |
| 387 | `### Trigger 5: \`6,36 * * * *\` (DEX discovery — dedicated, every 30 minutes)` | `### Trigger 5: \`6 */2 * * *\` (DEX discovery — dedicated, every 2h)` |
| 396 | `### Trigger 6: \`13,33,53 * * * *\` (every 20 minutes, offset at :13/:33/:53)` | `### Trigger 6: \`13,43 * * * *\` (every 30 minutes, offset at :13/:43)` |
| 417 | `### Trigger 8: \`11 * * * *\` (hourly at :11 — reserve + redemption lane)` | `### Trigger 8: \`11 */4 * * *\` (every 4h at :11 — reserve + redemption lane)` |

d. Update any prose immediately below these headers that describes "every N minutes/hours" — rewrite to match the new cadence.

e. Connection-pool table (lines 492–497): update the cron-expression column for the five affected rows. The connection budget column stays the same.

f. Cron-interval table at lines 1086–1102: update the interval and schedule columns for each affected row. After this pass the rows should read:

```markdown
| `sync-blacklist`                | 21,600s (6h)     | `3 */6 * * *`                                     |
| `sync-mint-burn`                | 1,800s (30min)   | `4,34 * * * *`                                    |
| `sync-dex-discovery`            | 7,200s (2h)      | `6 */2 * * *`                                     |
| `sync-mint-burn-extended`       | 1,800s (30min)   | `13,43 * * * *`                                   |
| `sync-live-reserves`            | 14,400s (4h)     | `11 */4 * * *`                                    |
| `sync-redemption-backstops`     | 14,400s (4h)     | `11 */4 * * *`                                    |
| `sync-kinesis-supply`           | 14,400s (4h)     | `11 */4 * * *`                                    |
```

g. Lines 903, 984, 1000: update the per-job `**Schedule:**` lines for `sync-live-reserves`, `sync-redemption-backstops`, and `sync-kinesis-supply` to `11 */4 * * *` (every 4 hours at :11 UTC).

h. Add a new Trigger section for `prune-cron-history`. It chains onto the existing `0 3 * * *` trigger that already hosts `prune-status-probe-runs`, so it does not need a new trigger entry, but it should appear in the job table at lines 1086–1102 with interval 86,400s (1d) and schedule `0 3 * * *`.

- [ ] **Step 3: Update `docs/live-reserves.md`**

| Line | Before | After |
| --- | --- | --- |
| 10 | `**Schedule:** \`11 * * * *\` (hourly at :11 UTC)` | `**Schedule:** \`11 */4 * * *\` (every 4 hours at :11 UTC)` |
| 11 | `**Shared hourly lane:** after live reserve sync, the same slot runs ...` | `**Shared 4-hourly lane:** after live reserve sync, the same slot runs ...` |
| 132 | `\`runHourlyReserveSyncSlot()\` in \`worker/src/handlers/scheduled/hourly-live-reserves.ts\` runs the reserve cron on its own trigger so reserve-adapter fetches do not compete with the 30-minute scoring lane or the daily 08:00 jobs.` | `\`runFourHourlyReserveSyncSlot()\` in \`worker/src/handlers/scheduled/hourly-live-reserves.ts\` runs the reserve cron on its own 4-hourly trigger so reserve-adapter fetches do not compete with the 30-minute scoring lane or the daily 08:00 jobs.` |
| 204, 225 | `The hourly reserve cron prunes rows older than 90 days.` | `The 4-hourly reserve cron prunes rows older than 90 days.` |

- [ ] **Step 4: Update `docs/supply-snapshot.md`**

| Line | Before | After |
| --- | --- | --- |
| 40 | `- if the previous successful write is < 1 hour old, skip with \`reason: "cooldown_active"\`` | `- if the previous successful write is < 20 hours old, skip with \`reason: "cooldown_active"\` (one snapshot per UTC day)` |
| 239 | `\| Successful write < 1 hour ago \| Skip write (\`reason: "cooldown_active"\`) \|` | `\| Successful write < 20 hours ago \| Skip write (\`reason: "cooldown_active"\`) \|` |
| 256 | `The write path is intentionally throttled by a 1-hour cooldown cache key even though the cron is chained to more frequent lanes` | `The write path is intentionally throttled by a 20-hour cooldown cache key (one snapshot per UTC day) even though the cron is chained to the 15-minute lane` |

- [ ] **Step 5: Update `docs/dex-liquidity.md`**

| Line | Before | After |
| --- | --- | --- |
| 5 | `... \`syncDexLiquidity()\` in \`worker/src/cron/dex-liquidity/orchestrator.ts\` runs every 30 minutes (on the \`10,40 * * * *\` cron schedule) ...` | keep as-is (dex-liquidity cadence unchanged) |
| 66 | `... discovery sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers) now run only on \`6,36 * * * *\` (every 30 minutes) and write to \`dex_pool_staging\` for later merge.` | `... discovery sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers) now run only on \`6 */2 * * *\` (every 2 hours) and write to \`dex_pool_staging\` for later merge.` |
| 281 | `\`worker/src/cron/dex-discovery/orchestrator.ts\` runs every 30 minutes (\`6,36 * * * *\`) and is responsible for pool discovery only. Scored TVL continues on the 30-minute cadence; discovery data is merged during the scoring run.` | `\`worker/src/cron/dex-discovery/orchestrator.ts\` runs every 2 hours (\`6 */2 * * *\`) and is responsible for pool discovery only. Scored TVL continues on the 30-minute cadence; discovery data is merged during the scoring run.` |
| 284 | `  - Scoring cron: \`syncDexLiquidity()\` every 30 minutes (\`10,40 * * * *\`).` | keep as-is |
| 285 | `  - Discovery cron: \`syncDexDiscovery()\` every 30 minutes (\`6,36 * * * *\`).` | `  - Discovery cron: \`syncDexDiscovery()\` every 2 hours (\`6 */2 * * *\`).` |

- [ ] **Step 6: Second-pass sweep across docs/**

Run the exhaustive verification grep from the repo root:

```bash
grep -rn '"3 \* \* \* \*"\|"4,24,44\|"13,33,53\|"6,36\|"11 \* \* \* \*"\|every 20 minutes\|every 30 minutes.*discovery\|hourly.*blacklist\|hourlyBlacklist\|twentyMinuteMintBurn\|twentyMinuteExtendedOffset\|thirtyMinuteDexDiscovery\|hourlyReserveSync\|1-hour cooldown' docs/ README.md
```

For every hit that is NOT already under `docs/*-timeline.md`, `docs/historical*`, or `agents/plans/historical/`, rewrite the passage to match the deployed state after Tasks 1–10. Leave timeline/historical docs alone — they are dated records.

- [ ] **Step 7: Add an explicit changelog entry**

Add a new entry to `src/data/changelogs/` following the repo's weekly-changelog convention, describing the cron-infrastructure audit outcome in operator-facing terms. This is the only "live reference" UI surface that records deploys and must include the cadence changes so support and ops teams can reference them.

- [ ] **Step 8: Verify and commit**

Run the merge-gate sanity check to catch stale doc-count guards:

```bash
npm run check:doc-counts
npm run test:merge-gate
```

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: sync cron cadence references to the audit remediation plan

Updates README.md, docs/worker-infrastructure.md, docs/live-reserves.md,
docs/supply-snapshot.md, docs/dex-liquidity.md, docs/mint-burn-flows.md,
docs/api-reference.md, docs/redemption-backstops.md to reflect the new
cadences:
- sync-blacklist: 1h → 6h
- sync-live-reserves slot: 1h → 4h
- both mint-burn lanes: 20min → 30min
- sync-dex-discovery: 30min → 2h
- snapshot-supply / snapshot-chain-supply cooldown: 1h → 20h

Also documents the new prune-cron-history daily housekeeping job.
Timeline and historical docs are left untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part E — Known Tradeoffs (Explicitly Accepted)

Before executing, the plan owner should acknowledge the following behavioral changes:

### E1. Blacklist signal latency in DEWS increases 1 h → 6 h

DEWS reads blacklist event counts over rolling 24-hour and 7-day windows (`worker/src/cron/dews/source-state.ts:145-168`). With `sync-blacklist` now running every 6 h instead of hourly, the worst-case delay between a blacklist event being observed on-chain and it entering the DEWS 24-h window goes from ~1 h to ~6 h. Given the measured network-wide event rate of ~1–3 per week, the chance of a blacklist event materially shifting the DEWS band *within a single 6 h window* is very low. Accepted.

### E2. Mint-burn public freshness SLA widens 40 min → 60 min

`MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC` auto-derives from `MINT_BURN_CRITICAL_LANE_INTERVAL_SEC × 2`. Moving the critical lane to 30 min lifts the SLA to 60 min. The operator alert threshold (`MINT_BURN_STALE_WARN_SEC = 6 h`) stays untouched, so this change is user-facing only: API `X-Data-Age` / `Warning` headers and UI banners reclassify the 40–60 min band from "degraded" to "fresh". This is the intended behavior; no alert retuning needed.

### E3. Live reserves: "Live reserve sync stale" alert threshold shifts 6 h → 12 h

Task 8, Step 3 raises the alert threshold so that it still corresponds to "3+ missed runs" at the new 4 h cadence. Operators should know this: reserve-sync downtime that previously triggered alerting within 6 h now does so within 12 h. The upstream `LIVE_RESERVE_FRESHNESS_SEC = 2 days` tolerance at the API layer is untouched, so public freshness semantics are unaffected.

### E4. API redemption-backstops Warning header window widens 1 h → 8 h

Task 8b derives the budget from `CRON_INTERVALS["sync-redemption-backstops"] × 2`. This is a UI/HTTP change only: the banner "Data more than N old" threshold on the redemption-backstops surface widens to match the new cadence. No alerting impact.

---

## Part F — Post-Deploy Verification

### Task 12: Pre-push merge gate + wrangler dry-run

- [ ] **Step 1: Run the project merge gate**

Run: `npm run test:merge-gate` from the repo root.
Expected: passes with coverage for the worker changes.

- [ ] **Step 2: Dry-run the wrangler deploy**

Run: `cd worker && npx wrangler deploy --dry-run --outdir /tmp/worker-dryrun`.
Expected: the dry-run succeeds and the output reports exactly the cron expressions changed. Five cron expressions have new values after this plan:
- `"3 */6 * * *"` (sync-blacklist)
- `"11 */4 * * *"` (reserve-sync slot)
- `"4,34 * * * *"` (sync-mint-burn critical)
- `"13,43 * * * *"` (sync-mint-burn extended)
- `"6 */2 * * *"` (sync-dex-discovery)

The total number of cron entries in `[triggers].crons` is unchanged from the 16 entries present today.

- [ ] **Step 3: Sanity-check the cron registry end-to-end**

Run: `cd worker && npx vitest run src/handlers/scheduled/__tests__/ src/lib/status/__tests__/ src/api/__tests__/status.test.ts src/cron/__tests__/`.
Expected: green.

- [ ] **Step 4 (post-deploy, human-gated): Verify the first 03:00 UTC run**

After deployment, query `cron_runs` via `wrangler d1 execute`:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "SELECT job, started_at, duration_ms, status, metadata FROM cron_runs WHERE job = 'prune-cron-history' ORDER BY started_at DESC LIMIT 3"
```
Expected: a row exists with status `ok` and a metadata JSON object containing `cronRunsDeleted` and `slotExecutionsDeleted`.

Also verify `cron_runs` row count is bounded:

```bash
cd worker && npx wrangler d1 execute stablecoin-db --remote --command "SELECT COUNT(*) AS total, MIN(started_at) AS oldest, MAX(started_at) AS newest FROM cron_runs"
```
Expected: oldest is within the last 7 days.

---

## Future Work — Deferred from this Plan

The items below were identified during the audit but are out of scope. Each deserves its own plan because either the risk profile is different (product decisions) or the implementation is non-trivial (coordination / caching).

### FW1. Signal-gate `daily-digest` on quiet days

**Finding:** `generateDailyDigest` always calls Anthropic with 64k max_tokens even when `llmSignals.activeDepegCount === 0 && llmSignals.topDepegs.length === 0 && llmSignals.yieldAnomalies.length === 0 && llmSignals.liquidityShifts.length === 0` and there are no safety-grade transitions. On quiet days the model consumes tokens formatting boilerplate.

**Why deferred:** The "what does a quiet-day digest look like?" decision is editorial. Options include skipping the LLM entirely with a templated "market stable" summary, dropping to a cheaper model tier (Haiku), or lowering effort/max_tokens. All three change the product; product input is needed first.

### FW2. `publish-report-card-cache` cadence

**Finding:** Runs every 15 min with no cooldown. `buildReportCardsSnapshot` does multi-table DB aggregation every time. At ~96 runs/day that is a meaningful write load on `report_card_cache`.

**Why deferred:** Report cards are fronted by a cache that downstream UI consumers treat as nearly-real-time. Before reducing cadence, measure: (a) actual `buildReportCardsSnapshot` cost in production, (b) staleness tolerance at the consuming surface. A 30-min cooldown is likely safe; 60 min may not be.

### FW3. Shared GT/CG crawl cache across `dex-discovery` and `dex-liquidity`

**Finding:** Both jobs crawl the same GeckoTerminal and CoinGecko Onchain endpoints with overlapping rate-limit pools. The GT limit (30 req/min) is the tightest single upstream constraint; discovery and liquidity together run close to budget.

**Why deferred:** Cache-coherence design is non-trivial. We need a schema that is cross-job-readable, survives partial runs, and invalidates on pool address changes. Implementation risks pool-identity mismatches between crawlers (see memory: "Dedup must use the same mechanism as existing code").

### FW4. Shared on-chain rate cache across `sync-yield-data` and `sync-yield-supplemental`

**Finding:** Both jobs fetch Aave V3 and Compound V3 reserve/rate data. `sync-yield-data` runs hourly, `sync-yield-supplemental` runs 4-hourly; the supplemental run re-fetches rates that the hourly run wrote ≤1 hour ago.

**Why deferred:** Requires choosing a cache key structure, freshness policy, and a migration path. Not a one-commit change.

### FW5. Merge the two 5-minute slots (`fiveMinuteTelegramAlerts` + `digestTriggerPoll`)

**Finding:** Both fire every 5 min on offset schedules. Each slot has its own cron trigger, own execution fence row, own logCronRun wrapper.

**Why deferred:** Marginal benefit (~1 D1 read saved per 5 min). The two slots do different things with different failure semantics. Not worth the complexity.

### FW6. `status-self-check` cadence

**Finding:** Runs every 15 min, probes 34 endpoints per run. Observability pressure is moderate but not resource-critical.

**Why deferred:** Reducing to 30 min saves ~48 in-process `route()` calls per day but delays onset-of-issue detection. The current cadence is defensible for an observability signal; reducing it is a judgment call the operator should make with recent incident-response data.

---

## Expected Cumulative Impact

After all ten implementation tasks land:

- **Housekeeping**: ~2,500 per-run DELETEs → 1 daily DELETE in a dedicated job.
- **Snapshot writes**: 48 daily redundant INSERT OR REPLACEs → 2 daily writes.
- **External API calls**: FX (−50%), blacklist (−83%), reserves (−75%), mint-burn both lanes (−33% each), DEX discovery (−75%).
- **Worker slot invocations**: measured daily reductions from the cadence changes:

| Job | Runs/day before | Runs/day after | Delta |
| --- | --- | --- | --- |
| sync-fx-rates (effective, via cooldown) | 96 | 48 | −48 |
| sync-blacklist | 24 | 4 | −20 |
| reserve-sync slot (live-reserves + backstops + kinesis) | 24 | 6 | −18 |
| sync-mint-burn (critical) | 72 | 48 | −24 |
| sync-mint-burn-extended | 72 | 48 | −24 |
| sync-dex-discovery | 48 | 12 | −36 |
| **Net scheduled invocations reclaimed** | — | — | **~170/day** |

- **Mint-burn freshness SLA**: 40 min → 60 min (documented and auto-computed from the interval constant).
- **D1 contention**: per-slot write pressure drops meaningfully during the quarter-hourly window, which is the tightest slot (sync-stablecoins + sync-fx-rates + snapshots). Reserve-sync slot drops from 24 → 6 chained invocations per day.
- **Observability**: new `prune-cron-history` row in `cron_runs` every day gives a single place to audit historical retention.

No user-facing behavior changes. No API contract changes. No D1 schema changes. The one SLA that shifts (mint-burn public freshness, 40 → 60 min) is still well under the `MINT_BURN_STALE_WARN_SEC = 6 h` operator-alert threshold and will not trigger any current alert.
