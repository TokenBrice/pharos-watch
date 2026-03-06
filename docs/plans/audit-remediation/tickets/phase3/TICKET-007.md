---
title: "Expand status API: DB health, dataset freshness, history, indexes"
agent: "codex"
model: "o4-mini"
reasoning_effort: "high"
done: false
---

## Goal

Fix 7 status/schema findings: add DB health sentinel, per-dataset freshness, dependency monitoring, status history time-range queries, surface secondary API failures in UI, and add composite indexes for hot queries.

## Task

### Step 1: STATUS-004 — DB health sentinel

In `worker/src/api/status.ts`, around line 525:

Add a lightweight DB health check before the data quality queries:

```typescript
// DB health sentinel — fast ping to verify D1 connectivity
let dbHealthy = true;
try {
  await db.prepare("SELECT 1").first();
} catch {
  dbHealthy = false;
}
```

Include `dbHealthy` in the status response payload. If DB is unhealthy, set overall status to `"degraded"` and short-circuit the data quality queries.

### Step 2: STATUS-005 — Time-range query for status history

In `worker/src/api/status-history.ts`, around line 17-20:

Add support for time-range filtering:

1. Accept `from` and `to` query params (Unix timestamps or ISO dates):
```typescript
const from = url.searchParams.get("from");
const to = url.searchParams.get("to");
```

2. If provided, filter the query:
```typescript
let sql = "SELECT * FROM status_transitions WHERE 1=1";
const binds: unknown[] = [];
if (from) { sql += " AND timestamp >= ?"; binds.push(from); }
if (to) { sql += " AND timestamp <= ?"; binds.push(to); }
sql += " ORDER BY timestamp DESC LIMIT ?";
binds.push(limit);
```

3. Update the corresponding docs (`docs/api-reference.md`) with the new query params.

### Step 3: STATUS-006 — Expand dependency monitoring

In `worker/src/lib/constants.ts`, around line 103:

1. Find the `CIRCUIT_SOURCE` enum or similar constant that lists monitored external dependencies.
2. Add any missing critical providers. Based on the codebase, these should be tracked:
   - DefiLlama (list + detail APIs)
   - CoinGecko (price + detail_platforms)
   - DexScreener (price fallback)
   - Alchemy (event logs)
   - Etherscan/block explorers (contract verification)
   - CoinMarketCap (price fallback)
   - Twitter API (digest posting)
   - Telegram API (digest posting)

3. For each provider, ensure there's a circuit breaker or health check entry.

### Step 4: STATUS-007 — Surface secondary API failures in status UI

In `src/app/status/client.tsx`, around line 72:

Currently the dashboard primarily hard-fails only on `/api/status`. Health and probe fetch failures are hidden.

1. The page likely fetches both `/api/status` and `/api/health` (or similar). Find where secondary fetch errors are caught.
2. Add visible error indicators for secondary API failures:
```tsx
{healthError && (
  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    Health endpoint unavailable: {healthError.message}
  </div>
)}
```

3. Don't block the entire dashboard on secondary failures — show what's available with warnings.

### Step 5: STATUS-008 — Per-dataset freshness in status payload

In `worker/src/api/status.ts`, around line 615:

Add dataset-level freshness blocks to the status response:

```typescript
const datasetFreshness = {
  stablecoins: await getLastUpdate(db, "stablecoins_cache"),
  blacklist: await getLastUpdate(db, "blacklist_events"),
  mintBurn: await getLastUpdate(db, "mint_burn_events"),
  supply: await getLastUpdate(db, "supply_history"),
  yield: await getLastUpdate(db, "yield_data"),
  depegs: await getLastUpdate(db, "depeg_events"),
  dews: await getLastUpdate(db, "dews_scores"),
  digest: await getLastUpdate(db, "daily_digest"),
};
```

Where `getLastUpdate` queries `MAX(updated_at)` or `MAX(timestamp)` for each table:
```typescript
async function getLastUpdate(db: D1Database, table: string): Promise<string | null> {
  // SAFETY: table name is from hardcoded list above, not user input
  const row = await db.prepare(`SELECT MAX(updated_at) as latest FROM ${table}`).first<{ latest: string | null }>();
  return row?.latest ?? null;
}
```

Include `datasetFreshness` in the status API response.

### Step 6: SCHEMA-003 — Composite index for mint_burn_events

Create migration `worker/migrations/NNNN_audit_perf_indexes.sql` (use next available number):

```sql
-- SCHEMA-003: Composite covering index for mint_burn_events hot query
-- Covers: WHERE stablecoin_id = ? AND chain_id = ? ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_mbe_coin_chain_ts
ON mint_burn_events (stablecoin_id, chain_id, timestamp DESC);

-- SCHEMA-004: Index for health symbol aggregation
-- Covers: WHERE symbol IN (...) → GROUP BY symbol, MAX(timestamp)
CREATE INDEX IF NOT EXISTS idx_mbe_symbol_ts
ON mint_burn_events (symbol, timestamp DESC);
```

**Important:** Check existing indexes on `mint_burn_events` first by reading migration files. Don't create duplicates. This table has ~1M rows, so the index creation may take time.

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes
2. `npm test` passes
3. `npm run lint` passes
4. `npm run build` passes (frontend changes in status UI)
5. Status API response includes `dbHealthy` boolean
6. Status API response includes `datasetFreshness` object with per-table timestamps
7. Status history endpoint accepts `from`/`to` query params
8. Migration file exists with the two new indexes
9. Status UI shows warnings for secondary API failures instead of hiding them
