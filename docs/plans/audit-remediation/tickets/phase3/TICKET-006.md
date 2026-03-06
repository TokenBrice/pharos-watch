---
title: "Harden cron job reliability: silent-success, timeouts, atomicity"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Fix 7 cron reliability findings: eliminate silent-success paths, propagate abort signals, align timeout policies, add connection-budget awareness, wrap yield writes atomically, and detect zero-row supply snapshots.

## Task

### Step 1: CRON-001 — Eliminate silent-success in charts/USDS/bluechip sync

In these 3 files, early returns on upstream API failure currently return `void` or no explicit status, making the job appear successful:

1. **`worker/src/cron/sync-stablecoin-charts.ts`** (line ~63): When DefiLlama API fails, instead of returning early silently, return a result with `status: "degraded"`:
```typescript
// Before: return; // silently
// After:
return { status: "degraded" as const, itemCount: 0, metadata: { reason: "DL API unavailable" } };
```

2. **`worker/src/cron/sync-usds-status.ts`** (line ~93): Same pattern — return degraded status on API failure.

3. **`worker/src/cron/sync-bluechip.ts`** (line ~103): Same pattern.

Check how `logCronRun()` in `worker/src/lib/db.ts` expects the return value. The result shape should match what `logCronRun` stores. Ensure all 3 files return a consistent shape.

### Step 2: CRON-002 — Blacklist sync: degrade on partial failures

In `worker/src/cron/sync-blacklist.ts`, around lines 710-719:

Currently `apiErrors` are counted but the job still returns success. Add degradation:

```typescript
const status = apiErrors > 0
  ? (apiErrors > contractConfigs.length / 2 ? "error" : "degraded")
  : "ok";

return { status, itemCount, metadata: { apiErrors, ...breakdown } };
```

This makes the job report `"degraded"` for partial failures and `"error"` if more than half the configs fail.

### Step 3: CRON-003 — Connection budget awareness

In `worker/src/handlers/scheduled.ts`, around lines 118-126:

The quarter-hour slot fans out multiple jobs via `ctx.waitUntil()`, all sharing a 6-connection pool.

1. Add a comment documenting the connection budget constraint.
2. If jobs are currently launched in parallel, serialize them within the same trigger slot:
```typescript
// Sequential execution to respect 6-connection pool budget
await runJob1(env, ctx);
await runJob2(env, ctx);
// NOT: ctx.waitUntil(runJob1(...)); ctx.waitUntil(runJob2(...));
```

**Note:** Only serialize jobs within the SAME cron trigger. Different trigger times (15min vs 30min slots) already run independently. Read the `handleScheduledEvent` function carefully to understand which jobs share a trigger.

### Step 4: CRON-004 — Propagate abort signal through sub-pipelines

In `worker/src/cron/sync-stablecoins.ts`, the abort signal is created (line ~291 via `AbortSignal.any()`) but not passed to all sub-pipeline calls.

1. Find all major function calls in `sync-stablecoins` that do I/O (fetch, DB writes):
   - `enrichPrices()` (~line 300)
   - `supplementalAssets()` (~line 389)
   - `detectDepegs()` / `confirmDepegs()` (~line 432+)
   - Any `db.batch()` or `db.prepare()` calls

2. Thread the signal through to these functions. For fetch calls:
```typescript
await fetch(url, { signal });
```

3. For functions that accept options, add `signal` to the options parameter. For internal helpers, check if they have a signal parameter; if not, add one.

4. At the start of major sub-pipelines, check `signal.aborted`:
```typescript
if (signal.aborted) return { status: "skipped" as const, reason: "timeout" };
```

### Step 5: CRON-005 — Align timeout policy

In `worker/wrangler.toml` (line ~10), `cpu_ms = 5000` (5 seconds of CPU time).

Check if this is the actual limit or if there's also a wall-clock limit. In `worker/src/lib/db.ts` (line ~328), there may be an in-app timeout of 5-15 minutes.

1. Document the relationship between `cpu_ms` and the in-app timeout with a comment in `wrangler.toml`:
```toml
# cpu_ms = total CPU milliseconds per invocation (not wall-clock time)
# In-app timeout in logCronRun() is wall-clock; these are independent limits
cpu_ms = 5000
```

2. If the in-app timeout is set to 5 minutes but `cpu_ms` is only 5 seconds, that's fine — CPU time and wall time are different in Workers. Just ensure the documentation is clear.

### Step 6: CRON-007 — Atomic yield sync writes

In `worker/src/cron/sync-yield-data.ts`, around lines 588-589, two separate `batchExecute()` calls write yield data and history. If the first succeeds but the second fails, data is inconsistent.

Combine into a single `db.batch()`:
```typescript
// Before:
await batchExecute(db, yieldDataStmts);
await batchExecute(db, historyStmts);

// After:
await batchExecute(db, [...yieldDataStmts, ...historyStmts]);
```

If the combined batch exceeds D1's per-batch limit (check if there is one), chunk appropriately but keep yield+history pairs together.

### Step 7: STATUS-003 — Supply snapshot zero-row detection

In `worker/src/cron/snapshot-supply.ts`, around line 15:

When 0 rows are inserted, return degraded status with a reason instead of success:

```typescript
if (insertedCount === 0) {
  return {
    status: "degraded" as const,
    itemCount: 0,
    metadata: { reason: cacheExists ? "all_coins_zero_supply" : "cache_missing" },
  };
}
```

Check what currently returns and adapt to match the `logCronRun` result shape.

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes
2. `npm test` passes
3. `npm run lint` passes
4. No cron job returns `void` or implicit success on API failure — verify by reading `sync-stablecoin-charts.ts`, `sync-usds-status.ts`, `sync-bluechip.ts`
5. Blacklist sync returns `"degraded"` when `apiErrors > 0`
6. Abort signal is checked at the start of major sub-pipelines in `sync-stablecoins.ts`
7. Yield sync uses a single `db.batch()` call for both yield data and history
8. Supply snapshot returns `"degraded"` when 0 rows inserted
