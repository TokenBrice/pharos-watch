# Multi-Source Yield + Stablewatch Wrapper Expansion

**Date:** 2026-03-03
**Status:** Approved, ready for implementation

---

## Background

Stablewatch.io tracks yield-bearing stablecoin wrappers (YBS products). Cross-referencing their data against Pharos revealed 12 savings wrappers for coins we already track that are not yet feeding our yield pipeline. Adding them requires:

1. Supporting **multiple yield sources per coin** in `yield_data` (e.g. fxUSD has both a Stability Pool and fxSAVE savings vault)
2. Adding **12 new `YIELD_VARIANT_MAP` entries** so the sync finds wrapper pools
3. Flagging **11 coins** as `yieldBearing: true` in `stablecoins.ts`

---

## Section 1: Schema

### `yield_data` — PK change + `is_best` flag

```sql
-- New primary key
PRIMARY KEY (stablecoin_id, source_key)

-- New columns
source_key  TEXT NOT NULL   -- DL pool UUID, or "price-derived"
is_best     INTEGER NOT NULL DEFAULT 1  -- 1 = highest apy_30d source for this coin

-- New index
CREATE INDEX idx_yield_best ON yield_data(stablecoin_id, is_best);
```

**`source_key` rules:**
- DL pool UUID when a pool exists (covers Tier 1, Tier 2, and auto-discovered sources)
- `"price-derived"` for coins with no DL pool (e.g. BUIDL)
- Tier 1 on-chain coins (sUSDe): `source_pool` is populated from `YIELD_POOL_MAP[id]` so they also use a UUID key

**Migration:** `0034_yield_data_multi_source.sql` — standard D1 table-recreate pattern:
```sql
CREATE TABLE yield_data_new ( ... PRIMARY KEY (stablecoin_id, source_key) );
INSERT INTO yield_data_new SELECT ..., COALESCE(source_pool, 'price-derived') AS source_key, 1 AS is_best FROM yield_data;
DROP TABLE yield_data;
ALTER TABLE yield_data_new RENAME TO yield_data;
-- Recreate indices
```

Existing rows all get `is_best = 1` and `source_key = COALESCE(source_pool, 'price-derived')`.

### `yield_history` — no changes

Records the best source's APY per coin per timestamp. As `is_best` shifts between sources over time, history naturally reflects the best source. 30d trailing averages may blend two sources during a ~30-day transition window; acceptable.

### Stale source cleanup

At the end of each sync run, delete `yield_data` rows for processed coins where `updated_at < startSec`. This removes sources that no longer appear in DL.

---

## Section 2: Sync Cron Refactor

### `matchDlPool` → `matchAllDlPools` (returns `DlPool[]`)

```
1. If YIELD_POOL_MAP[id] exists → add that pool (primary/native source)
2. If YIELD_VARIANT_MAP[id] exists → symbol-search for wrapper pool;
   add if its UUID differs from step 1
3. If nothing found via static maps → fallback symbol search on base coin
```

For Tier 1 on-chain coins (sUSDe): set `sourcePool = YIELD_POOL_MAP[id]` so source_key becomes the pool UUID. Tier 1 and Tier 2 then resolve to the same source_key — Tier 1 wins on data quality for that single row, no duplicate rows created.

### Auto-discovery runs for all coins

Remove the `!yieldBearingIds.has(m.id)` guard. Deduplication is by source_key: a pool UUID already present in `resolved` for that coin is skipped. A coin like NUSD can now have both its sNUSD wrapper source **and** an Aave lending pool source.

### `resolved[]` allows multiple entries per coin

After all sources collected:
1. Group by `stablecoin_id`
2. Compute `apy_30d` for each source (from `yield_history` same as today)
3. Set `is_best = 1` on source with highest `apy_30d` for each coin

### `yield_history` write — unchanged

One INSERT per coin per timestamp using the best source's APY values. PYS and warning signals computed only for the `is_best` source per coin.

### Per-source labels

`YieldVariant` interface gets two optional fields:

```ts
interface YieldVariant {
  variantSymbol: string;
  variantAddress?: string;
  variantChain?: string;
  yieldSource?: string;  // label used when this wrapper is a source row
  yieldType?: YieldType; // type used when this wrapper is a source row
}
```

The sync uses `variant.yieldSource` as the `yield_source` column value for wrapper-sourced rows. Falls back to a generated label (`"${variantSymbol} wrapper"`) if not specified.

---

## Section 3: API + Frontend

### `/api/yield-rankings` — response shape mostly unchanged

Internal query changes to `WHERE is_best = 1`. Same row count, same fields.

**One addition:** `altSources` array on each ranking entry (empty array when only one source):

```ts
interface AltYieldSource {
  sourceKey: string;
  yieldSource: string;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
}

// Added to YieldRanking:
altSources: AltYieldSource[];
```

Populated by a second query in the cache-build step: `SELECT * FROM yield_data WHERE is_best = 0`, grouped by coin, attached to the relevant ranking entry before cache write. No new endpoint.

### `YieldRanking` type (`src/lib/types.ts`)

Add `altSources: AltYieldSource[]`.

### Frontend `/yield` table — minimal change

- Table displays the best source exactly as today (no visible change for single-source coins)
- For coins with `altSources.length > 0`: small pill badge next to source name (e.g. `+1 source`) opening a popover listing alternatives with their APYs and types
- No new page or route

---

## Section 4: New `YIELD_VARIANT_MAP` Entries

12 new entries in `worker/src/cron/yield-config.ts`:

| Pharos ID | Coin | Wrapper symbol | Stablewatch TVL |
|-----------|------|---------------|-----------------|
| 309 | USD.AI | sUSDai | $338M |
| 346 | Neutrl USD | sNUSD | $188M |
| 220 | Avalon USDa | sUSDa | $162M |
| 298 | infiniFi USD | siUSD | $157M |
| 246 | Falcon USD | sUSDf | $87M |
| 271 | Avant USD | savUSD | $86M |
| 283 | Unitas | sUSDu | $64M |
| 344 | Yuzu USD | syzUSD | $56M |
| 168 | fxUSD | fxSAVE | $31M |
| 230 | Noon USN | sUSN | $24M |
| 297 | Main Street USD | msY | $23M |
| 353 | GAIB AID | sAID | $15M |

fxUSD (168) is a special case: already `yieldBearing` with a `YIELD_POOL_MAP` entry (Stability Pool). Adding to `YIELD_VARIANT_MAP` gives it a second source. No `stablecoins.ts` change needed.

During implementation, look up each wrapper's DL pool UUID and add to `YIELD_POOL_MAP` for deterministic matching. Symbol-based fallback will work in the meantime.

---

## Section 5: `stablecoins.ts` Changes

11 coins (all except fxUSD) get:
- `yieldBearing: true`
- `yieldConfig: { yieldSource: "<Protocol> savings (<symbol>)", yieldType: "lending-vault" }`

Most savings/vault wrappers default to `lending-vault`. During implementation, verify each protocol's mechanism and use `governance-set` where the rate is governance-controlled. **Unitas (sUSDu) and Noon (sUSN) are likely `governance-set` candidates.**

---

## File Checklist

| File | Change |
|------|--------|
| `worker/migrations/0034_yield_data_multi_source.sql` | New migration: PK change + `source_key` + `is_best` |
| `worker/src/cron/yield-config.ts` | 12 new `YIELD_VARIANT_MAP` entries; `YieldVariant` interface extended; DL pool UUIDs added to `YIELD_POOL_MAP` |
| `worker/src/cron/sync-yield-data.ts` | `matchAllDlPools`; multi-entry `resolved[]`; `is_best` logic; auto-discovery guard removed; Tier 1 populates `sourcePool`; stale source cleanup |
| `worker/src/api/yield-rankings.ts` | Query uses `WHERE is_best = 1`; `altSources` attached to cache payload |
| `src/lib/types.ts` | `AltYieldSource` interface; `altSources` on `YieldRanking` |
| `src/lib/stablecoins.ts` | `yieldBearing: true` + `yieldConfig` on 11 coins |
| `src/components/yield-leaderboard.tsx` | `+N source` pill badge + popover for multi-source rows |
| `src/lib/__tests__/yield-helpers.test.ts` | No changes needed (pure functions unchanged) |
| `docs/yield-intelligence.md` | Update to reflect multi-source schema and new wrappers |
