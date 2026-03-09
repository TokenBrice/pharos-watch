---
title: "Create staging persistence, cleanup, and cron entry point"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
done: false
---

## Goal

Create the persistence layer that writes to `dex_pool_staging` and `dex_discovery_meta`, handles cleanup, and wire the cron entry point.

## Task

1. Read for context:
   - `worker/src/cron/dex-discovery/types.ts` — `StagedPool`, `DiscoveryMeta` interfaces
   - `worker/src/cron/dex-liquidity/persistence.ts` — pattern reference for D1 upserts and `db.batch()` usage

2. Create `worker/src/cron/dex-discovery/persistence.ts` with these functions:

### `upsertStagedPools`

```typescript
/**
 * Upsert discovered pools into dex_pool_staging.
 * Uses INSERT OR REPLACE since PK is (pool_id, stablecoin_id).
 * Batches in groups of 50 to stay within D1 statement limits.
 */
export async function upsertStagedPools(db: D1Database, pools: StagedPool[]): Promise<void>
```

Implementation:
- If `pools.length === 0`, return early
- Build `INSERT OR REPLACE INTO dex_pool_staging (pool_id, stablecoin_id, source, chain, protocol, symbol, tvl_usd, volume_24h, fee_tier, balance_ratio, is_stable, base_token, quote_token, quote_symbol, price_usd, locked_liq_pct, raw_json, discovered_at, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` prepared statements
- Map `isStable` boolean to integer (1/0/null) for D1
- Batch in groups of 50 using `db.batch()`

### `updateDiscoveryMeta`

```typescript
/**
 * Update dex_discovery_meta after crawling a coin.
 * Resets consecutive_misses to 0 if poolsFound > 0.
 * Increments consecutive_misses if poolsFound === 0.
 */
export async function updateDiscoveryMeta(
  db: D1Database,
  stablecoinId: string,
  poolsFound: number,
  nowSec: number,
): Promise<void>
```

Implementation:
- If `poolsFound > 0`: `INSERT OR REPLACE INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at) VALUES (?, 0, ?, ?)`
  with `(stablecoinId, nowSec, nowSec)`
- If `poolsFound === 0`:
  - Run `UPDATE dex_discovery_meta SET consecutive_misses = consecutive_misses + 1, last_crawl_at = ? WHERE stablecoin_id = ?`
  - Check if any rows were updated via `result.meta.changes === 0`
  - If no rows updated (coin not in table yet): `INSERT INTO dex_discovery_meta (stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at) VALUES (?, 1, ?, NULL)`

### `cleanupStaging`

```typescript
/**
 * Cleanup stale staging data.
 * - Delete rows where refreshed_at < nowSec - 48h (172800)
 * - NULL out raw_json where refreshed_at < nowSec - 6h (21600) to save storage
 */
export async function cleanupStaging(db: D1Database, nowSec: number): Promise<void>
```

Implementation:
- `DELETE FROM dex_pool_staging WHERE refreshed_at < ?` with `nowSec - 172800`
- `UPDATE dex_pool_staging SET raw_json = NULL WHERE raw_json IS NOT NULL AND refreshed_at < ?` with `nowSec - 21600`
- Run both via `db.batch()`

### `readDiscoveryMeta`

```typescript
/**
 * Read current discovery meta for all stablecoins.
 */
export async function readDiscoveryMeta(db: D1Database): Promise<Map<string, DiscoveryMeta>>
```

Implementation:
- `SELECT stablecoin_id, consecutive_misses, last_crawl_at, last_hit_at FROM dex_discovery_meta`
- Map to `DiscoveryMeta` objects, keyed by `stablecoinId`

### `incrementRunSeq`

```typescript
/**
 * Read and increment discovery_run_seq from kv_config table.
 * The kv_config table is created by migration 0056_dex_discovery_staging.sql.
 * Creates the row if it doesn't exist (starting at 1).
 * Returns the NEW sequence number (post-increment).
 */
export async function incrementRunSeq(db: D1Database): Promise<number>
```

Implementation:
- `SELECT value FROM kv_config WHERE key = 'discovery_run_seq'` — if no row, insert with `1` and return `1`
- Otherwise, parse value as integer, increment, `UPDATE kv_config SET value = ? WHERE key = 'discovery_run_seq'`, return new value
- Use `db.batch()` to combine the read + write for atomicity

3. Create `worker/src/cron/dex-discovery/index.ts`:

```typescript
export { syncDexDiscovery } from "./orchestrator";
```

4. If TICKET-002 created stub files for `persistence.ts`, replace the stubs with the real implementations. Make sure the orchestrator's imports resolve correctly.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `syncDexDiscovery` is re-exported from `worker/src/cron/dex-discovery/index.ts`
- `upsertStagedPools` uses `INSERT OR REPLACE` — verify: `grep -c "INSERT OR REPLACE" worker/src/cron/dex-discovery/persistence.ts` returns >= 1
- `updateDiscoveryMeta` resets `consecutive_misses` to 0 when `poolsFound > 0`
- `cleanupStaging` has both DELETE (48h) and UPDATE (6h) operations
- `incrementRunSeq` is idempotent (creates kv_config row if missing)
- Batching uses groups of 50: `grep -c "50" worker/src/cron/dex-discovery/persistence.ts` returns >= 1 (or search for the batch slicing logic)
- `npm run build` exits 0
- `npm test` exits 0 (no regressions)
- `npm run lint` exits 0
