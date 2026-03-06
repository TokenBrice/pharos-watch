---
title: "Eliminate dynamic SQL interpolation patterns"
agent: "codex"
model: "o4-mini"
reasoning_effort: "high"
done: false
---

## Goal

Replace all dynamic SQL interpolation (table names, column names, WHERE fragments, IN-clauses) with safe patterns: allowlists for identifiers, a centralized `buildInClause()` helper for dynamic arrays, and parameterized conditions for WHERE fragments.

## Context

The audit found 3 genuinely unsafe patterns (table/column/WHERE interpolation) and 7 instances of `ids.map(() => "?").join(",")` IN-clause construction that, while safe, should use a centralized helper for consistency and to prevent copy-paste drift toward unsafe variants.

## Task

### Step 1: Create `buildInClause()` helper

In `worker/src/lib/db.ts`, add:

```typescript
/**
 * Build a safe SQL IN-clause with parameterized placeholders.
 * Returns the SQL fragment (e.g. "?,?,?") and the bind values.
 */
export function buildInClause(values: readonly unknown[]): { sql: string; binds: unknown[] } {
  if (values.length === 0) throw new Error("buildInClause: empty array");
  return {
    sql: values.map(() => "?").join(","),
    binds: [...values],
  };
}
```

### Step 2: Fix SEC-001 — `fetchPaginatedEvents()` table/column allowlist

In `worker/src/lib/api-utils.ts`, around line 303:

1. Add a const allowlist at module level:
```typescript
const PAGINATED_TABLES = new Set(["blacklist_events", "mint_burn_events", "depeg_events"]);
const PAGINATED_ORDER_COLS = new Set(["timestamp", "block_number", "created_at", "detected_at"]);
```

2. In `fetchPaginatedEvents()`, validate before use:
```typescript
if (!PAGINATED_TABLES.has(config.tableName)) throw new Error(`Invalid table: ${config.tableName}`);
if (!PAGINATED_ORDER_COLS.has(config.orderBy)) throw new Error(`Invalid orderBy: ${config.orderBy}`);
```

3. Keep the existing `${config.tableName}` interpolation — it's now safe because the value is validated against the allowlist. Add a comment: `// SAFETY: validated against PAGINATED_TABLES allowlist above`.

### Step 3: Fix SEC-002 — WHERE fragment in backfill-mint-burn-prices

In `worker/src/api/backfill-mint-burn-prices.ts`, around line 13-17:

The `needsRepairWhere` is a hardcoded string constant, not user input. Make this explicit by:
1. Declare it as `const` (already is) and add a safety comment
2. Alternatively, refactor to use individual column checks with AND-joined conditions as literal SQL (no interpolation)

Since this is a hardcoded constant and not derived from user input, the fix is to add a clear safety annotation:
```typescript
// SAFETY: needsRepairWhere is a compile-time constant, not derived from user input
const needsRepairWhere = "(amount_usd IS NULL OR price_used IS NULL OR price_timestamp IS NULL OR price_source IS NULL)" as const;
```

### Step 4: Fix SEC-003 — Dynamic table in DEWS cleanup

In `worker/src/cron/compute-dews.ts`, around line 55, the `deleteOrphansForTable()` function takes a `table` parameter:

1. Add an allowlist:
```typescript
const DEWS_TABLES = new Set(["dews_scores", "dews_signals"]);
```

2. Validate in the function:
```typescript
function deleteOrphansForTable(db: D1Database, table: string, ...) {
  if (!DEWS_TABLES.has(table)) throw new Error(`Invalid DEWS table: ${table}`);
  // ... rest of function with // SAFETY: validated against DEWS_TABLES allowlist
```

### Step 5: Replace all IN-clause patterns with `buildInClause()`

For each file below, replace `ids.map(() => "?").join(",")` (or similar) with `buildInClause()`:

1. **`worker/src/lib/api-utils.ts:56`** — `buildCacheStatuses()`:
   - `import { buildInClause } from "./db";`
   - Replace: `` `...IN (${cacheOnlyKeys.map(() => '?').join(',')})` `` → `` `...IN (${buildInClause(cacheOnlyKeys).sql})` `` and update `.bind(...buildInClause(cacheOnlyKeys).binds)`. Or: destructure once `const inc = buildInClause(cacheOnlyKeys)` then use `inc.sql` and `...inc.binds`.

2. **`worker/src/api/status.ts:145`** — `computeRawStatus()`:
   - Replace the `cronJobs.map(() => "?").join(",")` pattern with `buildInClause(cronJobs)`.

3. **`worker/src/api/health.ts:71`** — `handleHealth()`:
   - Replace the `mintBurnConfig.majorSymbols.map(() => "?").join(",")` with `buildInClause(mintBurnConfig.majorSymbols)`.

4. **`worker/src/handlers/scheduled.ts:197`** — mint/burn alert query:
   - Replace `symbols.map(() => "?").join(",")` with `buildInClause(symbols)`.

5. **`worker/src/cron/sync-yield-data.ts`** — three locations (~lines 215, 452, 465):
   - Replace all three `placeholders = ...map(() => "?").join(",")` with `buildInClause()`.

6. **`worker/src/cron/daily-digest.ts:342`** — supply history query:
   - Replace `top10.map(() => "?").join(",")` with `buildInClause(top10.map(c => c.id))`.
   - Be careful: the `.bind()` call also appends date params — combine: `...inc.binds, todayTs, yesterday, weekAgo`.

7. **`worker/src/lib/alchemy-logs.ts:389`** — `resolveBlockTimestamps()`:
   - Replace `batchBlocks.map(() => "?").join(",")` with `buildInClause(batchBlocks)`.
   - Combine binds: `.bind(persistentCache.chainId, cutoff, ...inc.binds)`.

8. **`worker/src/lib/mint-burn-pipeline/context.ts:38,53`** — two locations:
   - Replace string concatenation `"...IN (" + idChunk.map(() => "?").join(",") + ")"` with template literal using `buildInClause(idChunk)`.

### Step 6: Add SCHEMA-005 composite index for blacklist pagination

Create a new migration file `worker/migrations/NNNN_audit_blacklist_index.sql` (use the next available number after the highest existing migration):

```sql
-- Composite index for filtered+sorted blacklist pagination (SCHEMA-005)
CREATE INDEX IF NOT EXISTS idx_blacklist_events_chain_ts
ON blacklist_events (chain, timestamp DESC);
```

Check the existing indexes on `blacklist_events` first by reading migration files — only add if this index doesn't already exist.

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes with zero errors
2. `npm test` passes — all existing tests still pass
3. `npm run lint` passes
4. No remaining `ids.map(() => "?").join` or `.map(() => '?').join` patterns in `worker/src/` — verify with: `grep -rn "map(() => [\"']?\?[\"']?).join" worker/src/`
5. No unguarded `${table}` or `${config.tableName}` interpolation without an allowlist check — verify by reading the changed functions
6. The new `buildInClause()` function exists in `worker/src/lib/db.ts` and is imported by all files that build IN-clauses
