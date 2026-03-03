# Multi-Source Yield + Stablewatch Wrapper Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 12 stablewatch-identified savings wrappers as yield sources, and refactor `yield_data` to support multiple sources per coin (showing the highest-APY source in the table, with alternatives surfaced via a popover).

**Architecture:** `yield_data` PK changes from `stablecoin_id` to `(stablecoin_id, source_key)` with an `is_best` flag. `sync-yield-data.ts` collects all DL pools per coin (static + wrapper) rather than stopping at the first match. Auto-discovery runs for all coins including yield-bearing ones. The API query and response shape stay the same (`WHERE is_best = 1`), with `altSources[]` added for UI popovers.

**Design doc:** `docs/plans/2026-03-03-multi-source-yield-design.md`

**Tech Stack:** D1 SQLite, Cloudflare Workers, TypeScript strict, Vitest, React/shadcn/ui.

---

## Task 1: Research DL pool UUIDs for the 12 new wrappers

**Files:**
- No code changes — research only, produce values used in Task 4

**Step 1: Fetch all DL yield pools and filter for each wrapper symbol**

```bash
# Run this once per wrapper symbol — replace SYMBOL with each:
curl -s "https://yields.llama.fi/pools" | \
  jq '.data[] | select(.symbol | test("SYMBOL"; "i")) | select(.stablecoin == true) | {pool, symbol, project, tvlUsd, apy, chain}' | \
  head -40
```

Run for each wrapper symbol in this order (highest TVL first):
`sUSDai`, `sNUSD`, `sUSDa`, `siUSD`, `sUSDf`, `savUSD`, `sUSDu`, `syzUSD`, `fxSAVE`, `sUSN`, `msY`, `sAID`

**Step 2: For each result, pick the pool with:**
- `stablecoin: true` ✓ (filtered above)
- Highest `tvlUsd`
- Matches the correct issuer/project (e.g. sUSDai → usd.ai or similar)

Record the `pool` UUID (e.g. `"abc123-..."`). If no result found for a symbol, leave a comment — the fallback symbol search will handle it at runtime.

**Step 3: Note down all 12 UUIDs (or "no-pool: fallback symbol search") for use in Task 4**

---

## Task 2: Schema migration

**Files:**
- Create: `worker/migrations/0041_yield_data_multi_source.sql`

**Step 1: Write the migration**

```sql
-- worker/migrations/0041_yield_data_multi_source.sql
-- Adds per-source tracking to yield_data:
--   source_key  TEXT NOT NULL  — DL pool UUID, or "price-derived"
--   is_best     INTEGER NOT NULL DEFAULT 1  — 1 = highest currentApy for this coin
-- PK changes from (stablecoin_id) to (stablecoin_id, source_key).
-- yield_history is unchanged.

CREATE TABLE yield_data_v2 (
  stablecoin_id       TEXT NOT NULL,
  source_key          TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  current_apy         REAL NOT NULL,
  apy_base            REAL,
  apy_reward          REAL,
  apy_7d              REAL NOT NULL,
  apy_30d             REAL NOT NULL,
  yield_source        TEXT NOT NULL,
  yield_type          TEXT NOT NULL,
  source_pool         TEXT,
  source_tvl_usd      REAL,
  data_source         TEXT NOT NULL,
  safety_score        REAL,
  safety_grade        TEXT,
  pharos_yield_score  REAL,
  yield_to_risk       REAL,
  excess_yield        REAL,
  yield_stability     REAL,
  apy_variance_30d    REAL,
  apy_min_30d         REAL,
  apy_max_30d         REAL,
  exchange_rate       REAL,
  exchange_rate_prev  REAL,
  warning_signals     TEXT,
  is_best             INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, source_key)
);

INSERT INTO yield_data_v2 (
  stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward,
  apy_7d, apy_30d, yield_source, yield_type, source_pool, source_tvl_usd,
  data_source, safety_score, safety_grade, pharos_yield_score, yield_to_risk,
  excess_yield, yield_stability, apy_variance_30d, apy_min_30d, apy_max_30d,
  exchange_rate, exchange_rate_prev, warning_signals, is_best, updated_at
)
SELECT
  stablecoin_id,
  COALESCE(source_pool, 'price-derived') AS source_key,
  symbol, current_apy, apy_base, apy_reward,
  apy_7d, apy_30d, yield_source, yield_type, source_pool, source_tvl_usd,
  data_source, safety_score, safety_grade, pharos_yield_score, yield_to_risk,
  excess_yield, yield_stability, apy_variance_30d, apy_min_30d, apy_max_30d,
  exchange_rate, exchange_rate_prev, warning_signals,
  1 AS is_best,
  updated_at
FROM yield_data;

DROP TABLE yield_data;
ALTER TABLE yield_data_v2 RENAME TO yield_data;

CREATE INDEX IF NOT EXISTS idx_yield_pys  ON yield_data(pharos_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_yield_apy  ON yield_data(apy_30d DESC);
CREATE INDEX IF NOT EXISTS idx_yield_best ON yield_data(stablecoin_id, is_best);
```

**Step 2: Apply locally to verify syntax**

```bash
cd worker && npx wrangler d1 migrations apply pharos-db --local
```

Expected: `Migrations applied successfully.` with no errors.

**Step 3: Commit**

```bash
git add worker/migrations/0041_yield_data_multi_source.sql
git commit -m "feat(yield): add source_key + is_best to yield_data (multi-source schema)"
```

---

## Task 3: TypeScript types

**Files:**
- Modify: `src/lib/types.ts` (around line 909)

**Step 1: Add `AltYieldSource` interface and update `YieldRanking` + schemas**

After the `YieldConfig` block (line ~907), insert `AltYieldSource`:

```ts
export interface AltYieldSource {
  sourceKey: string;
  yieldSource: string;
  yieldType: YieldType;
  currentApy: number;
  apy30d: number;
  sourceTvlUsd: number | null;
  dataSource: string;
}

export const AltYieldSourceSchema = z.object({
  sourceKey: z.string(),
  yieldSource: z.string(),
  yieldType: z.string(),
  currentApy: z.number(),
  apy30d: z.number(),
  sourceTvlUsd: z.number().nullable(),
  dataSource: z.string(),
});
```

Add `altSources` to `YieldRanking` interface (after `warningSignals`):

```ts
  warningSignals: string[];
  altSources: AltYieldSource[];   // ← add this line
```

Add `altSources` to `YieldRankingSchema`:

```ts
  warningSignals: z.array(z.string()),
  altSources: z.array(AltYieldSourceSchema),   // ← add this line
```

**Step 2: Type-check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no new errors.

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(yield): add AltYieldSource type and altSources field to YieldRanking"
```

---

## Task 4: `matchAllDlPools` pure function + tests

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts` (append at end)
- Modify: `src/lib/__tests__/yield-helpers.test.ts` (append tests)

**Step 1: Write the failing tests first**

Append to `src/lib/__tests__/yield-helpers.test.ts`:

```ts
import { matchAllDlPools } from "../../../worker/src/cron/yield-helpers";

// Minimal DL pool fixture
const pool = (id: string, sym: string, tvl = 1_000_000) => ({
  pool: id, symbol: sym, tvlUsd: tvl,
  apy: 5.0, apyBase: 5.0, apyReward: null,
  stablecoin: true, exposure: "single",
});

describe("matchAllDlPools", () => {
  it("returns static YIELD_POOL_MAP entry when present", () => {
    const dlPools = [pool("uuid-a", "DAI")];
    const result = matchAllDlPools("5", "DAI", dlPools, { "5": "uuid-a" }, {});
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-a");
  });

  it("returns wrapper pool from YIELD_VARIANT_MAP as a second source", () => {
    const dlPools = [pool("uuid-a", "DAI"), pool("uuid-b", "sDAI", 2_000_000)];
    const result = matchAllDlPools(
      "5", "DAI", dlPools,
      { "5": "uuid-a" },
      { "5": { variantSymbol: "sDAI" } },
    );
    expect(result).toHaveLength(2);
    expect(result.map(p => p.pool)).toContain("uuid-a");
    expect(result.map(p => p.pool)).toContain("uuid-b");
  });

  it("deduplicates when YIELD_POOL_MAP and wrapper search return the same pool", () => {
    const dlPools = [pool("uuid-a", "sDAI")];
    const result = matchAllDlPools(
      "5", "DAI", dlPools,
      { "5": "uuid-a" },
      { "5": { variantSymbol: "sDAI" } },
    );
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-a");
  });

  it("falls back to base-symbol search when no static maps match", () => {
    const dlPools = [pool("uuid-a", "LUSD"), pool("uuid-b", "LUSD", 2_000_000)];
    const result = matchAllDlPools("999", "LUSD", dlPools, {}, {});
    expect(result).toHaveLength(1);
    expect(result[0].tvlUsd).toBe(2_000_000); // picks highest TVL
  });

  it("returns empty array when no pool found", () => {
    const result = matchAllDlPools("999", "NOPE", [pool("uuid-a", "DAI")], {}, {});
    expect(result).toHaveLength(0);
  });

  it("picks highest TVL when multiple wrapper matches exist", () => {
    const dlPools = [pool("uuid-a", "sGHO", 100_000), pool("uuid-b", "sGHO", 500_000)];
    const result = matchAllDlPools(
      "118", "GHO", dlPools, {},
      { "118": { variantSymbol: "sGHO" } },
    );
    expect(result).toHaveLength(1);
    expect(result[0].pool).toBe("uuid-b"); // highest TVL wins
  });

  it("only matches single-exposure stablecoin pools", () => {
    const lpPool = { ...pool("uuid-a", "sDAI"), exposure: "multi" };
    const result = matchAllDlPools("5", "DAI", [lpPool], {}, { "5": { variantSymbol: "sDAI" } });
    expect(result).toHaveLength(0);
  });
});
```

**Step 2: Run tests — expect failures**

```bash
npm test -- yield-helpers 2>&1 | tail -20
```

Expected: `matchAllDlPools is not a function` or similar import error.

**Step 3: Implement `matchAllDlPools` in `yield-helpers.ts`**

Append at the end of `worker/src/cron/yield-helpers.ts`:

```ts
/**
 * Returns ALL DL pools that are yield sources for the given coin.
 * Checks YIELD_POOL_MAP (native pool) and YIELD_VARIANT_MAP (wrapper pool) independently.
 * Falls back to base-symbol search only when neither static map has an entry.
 * Deduplicates by pool UUID. Picks highest TVL when multiple wrapper matches exist.
 *
 * Used by sync-yield-data to support multiple sources per coin.
 */
export function matchAllDlPools(
  stablecoinId: string,
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
  }>,
  poolMap: Record<string, string>,
  variantMap: Record<string, { variantSymbol: string }>,
): Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> {
  const found: Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> = [];
  const seenUuids = new Set<string>();
  const eligible = dlPools.filter(p => p.exposure === "single" && p.stablecoin);

  // Layer 1: Static pool map (native/primary source)
  const nativeId = poolMap[stablecoinId];
  if (nativeId) {
    const p = eligible.find(p => p.pool === nativeId);
    if (p) {
      found.push({ pool: p.pool, apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward, tvlUsd: p.tvlUsd });
      seenUuids.add(p.pool);
    }
  }

  // Layer 2: Variant map (wrapper/savings source — additional)
  const variant = variantMap[stablecoinId];
  if (variant) {
    const sym = variant.variantSymbol.toLowerCase();
    const candidates = eligible.filter(p => p.symbol.toLowerCase().includes(sym));
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
      if (!seenUuids.has(best.pool)) {
        found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
        seenUuids.add(best.pool);
      }
    }
  }

  // Layer 3: Base-symbol fallback (only when both static maps miss)
  if (found.length === 0) {
    const sym = symbol.toLowerCase();
    const candidates = eligible.filter(p => p.symbol.toLowerCase().includes(sym));
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
      found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
    }
  }

  return found;
}
```

**Step 4: Run tests — expect all to pass**

```bash
npm test -- yield-helpers 2>&1 | tail -20
```

Expected: all `matchAllDlPools` tests pass, all prior tests still pass.

**Step 5: Commit**

```bash
git add worker/src/cron/yield-helpers.ts src/lib/__tests__/yield-helpers.test.ts
git commit -m "feat(yield): add matchAllDlPools — returns all DL sources per coin"
```

---

## Task 5: `yield-config.ts` — extend `YieldVariant` + add 12 entries

**Files:**
- Modify: `worker/src/cron/yield-config.ts`

**Step 1: Extend `YieldVariant` interface** (add optional label fields)

```ts
export interface YieldVariant {
  variantSymbol: string;
  variantAddress?: string;
  variantChain?: string;
  /** Label used as yield_source when this wrapper is the source row. */
  yieldSource?: string;
  /** Yield mechanism type for this wrapper. */
  yieldType?: string;
}
```

**Step 2: Add 12 new entries to `YIELD_VARIANT_MAP`**

Append after the existing BOLD entry:

```ts
  // USD.AI -> sUSDai (savings wrapper, $338M TVL on Stablewatch)
  "309": {
    variantSymbol: "sUSDai",
    variantChain: "ethereum",
    yieldSource: "USD.AI savings (sUSDai)",
    yieldType: "lending-vault",
  },
  // Neutrl USD -> sNUSD (savings wrapper, $188M TVL)
  "346": {
    variantSymbol: "sNUSD",
    variantChain: "ethereum",
    yieldSource: "Neutrl savings (sNUSD)",
    yieldType: "lending-vault",
  },
  // Avalon USDa -> sUSDa (savings wrapper, $162M TVL)
  "220": {
    variantSymbol: "sUSDa",
    variantChain: "ethereum",
    yieldSource: "Avalon savings (sUSDa)",
    yieldType: "lending-vault",
  },
  // infiniFi USD -> siUSD (savings wrapper, $157M TVL)
  "298": {
    variantSymbol: "siUSD",
    variantChain: "ethereum",
    yieldSource: "infiniFi savings (siUSD)",
    yieldType: "lending-vault",
  },
  // Falcon USD -> sUSDf (savings wrapper, $87M TVL)
  "246": {
    variantSymbol: "sUSDf",
    variantChain: "ethereum",
    yieldSource: "Falcon Finance savings (sUSDf)",
    yieldType: "lending-vault",
  },
  // Avant USD -> savUSD (savings wrapper, $86M TVL)
  "271": {
    variantSymbol: "savUSD",
    variantChain: "ethereum",
    yieldSource: "Avant savings (savUSD)",
    yieldType: "lending-vault",
  },
  // Unitas -> sUSDu (savings wrapper, $64M TVL — governance-set rate)
  "283": {
    variantSymbol: "sUSDu",
    variantChain: "ethereum",
    yieldSource: "Unitas savings (sUSDu)",
    yieldType: "governance-set",
  },
  // Yuzu USD -> syzUSD (savings wrapper, $56M TVL)
  "344": {
    variantSymbol: "syzUSD",
    variantChain: "ethereum",
    yieldSource: "Yuzu savings (syzUSD)",
    yieldType: "lending-vault",
  },
  // fxUSD -> fxSAVE (savings wrapper, $31M TVL — second source alongside Stability Pool)
  "168": {
    variantSymbol: "fxSAVE",
    variantChain: "ethereum",
    yieldSource: "f(x) Protocol Savings (fxSAVE)",
    yieldType: "lending-vault",
  },
  // Noon USN -> sUSN (savings wrapper, $24M TVL — governance-set rate)
  "230": {
    variantSymbol: "sUSN",
    variantChain: "ethereum",
    yieldSource: "Noon savings (sUSN)",
    yieldType: "governance-set",
  },
  // Main Street USD -> msY (savings wrapper, $23M TVL)
  "297": {
    variantSymbol: "msY",
    variantChain: "ethereum",
    yieldSource: "Main Street savings (msY)",
    yieldType: "lending-vault",
  },
  // GAIB AID -> sAID (savings wrapper, $15M TVL)
  "353": {
    variantSymbol: "sAID",
    variantChain: "ethereum",
    yieldSource: "GAIB savings (sAID)",
    yieldType: "lending-vault",
  },
```

**Step 3: Add DL pool UUIDs to `YIELD_POOL_MAP`** (from Task 1 research)

For each wrapper that has a pool UUID from Task 1, add an entry to `YIELD_POOL_MAP`. The key is the **Pharos coin ID**, and the value is the DL pool UUID for the **wrapper** pool. If a coin already has a `YIELD_POOL_MAP` entry (like fxUSD "168"), add the wrapper's pool UUID under a NEW key — but wait, the map is keyed by coin ID, so we can only have ONE entry per coin.

**For coins with BOTH a native pool AND a wrapper pool:** only put the **native** pool in `YIELD_POOL_MAP` — the wrapper pool is found via symbol search using `YIELD_VARIANT_MAP`. For coins with ONLY a wrapper pool (no native pool), put the wrapper UUID in `YIELD_POOL_MAP`:

```ts
  // USD.AI -> sUSDai pool (UUID from Task 1 research, or omit if none found)
  "309": "<sUSDai-pool-uuid>",

  // Neutrl USD -> sNUSD pool
  "346": "<sNUSD-pool-uuid>",

  // Avalon USDa -> sUSDa pool
  "220": "<sUSDa-pool-uuid>",

  // infiniFi USD -> siUSD pool
  "298": "<siUSD-pool-uuid>",

  // Falcon USD -> sUSDf pool
  "246": "<sUSDf-pool-uuid>",

  // Avant USD -> savUSD pool
  "271": "<savUSD-pool-uuid>",

  // Unitas -> sUSDu pool
  "283": "<sUSDu-pool-uuid>",

  // Yuzu USD -> syzUSD pool
  "344": "<syzUSD-pool-uuid>",

  // fxUSD "168" already has Stability Pool in YIELD_POOL_MAP — do NOT add fxSAVE here.
  // The fxSAVE pool will be found via YIELD_VARIANT_MAP symbol search.

  // Noon USN -> sUSN pool
  "230": "<sUSN-pool-uuid>",

  // Main Street USD -> msY pool
  "297": "<msY-pool-uuid>",

  // GAIB AID -> sAID pool
  "353": "<sAID-pool-uuid>",
```

If Task 1 found no UUID for a given symbol, omit that entry (the sync will use symbol-based fallback).

**Step 4: Worker type-check**

```bash
cd worker && npx tsc --noEmit 2>&1 | grep -E "error TS" | head -20
```

Expected: no errors.

**Step 5: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): add 12 wrapper entries to YIELD_VARIANT_MAP + DL pool UUIDs"
```

---

## Task 6: `stablecoins.ts` — flag 11 coins as yield-bearing

**Files:**
- Modify: `src/lib/stablecoins.ts`

**Step 1: Add `yieldBearing: true` + `yieldConfig` to each coin**

For each of the 11 coins below, locate its `usd(...)` call and add to its options object. The pattern to follow is identical to existing coins like `GHO` (id "118"):

| ID | Coin | yieldSource | yieldType |
|----|------|-------------|-----------|
| 309 | USD.AI | `"USD.AI savings (sUSDai)"` | `"lending-vault"` |
| 346 | Neutrl USD | `"Neutrl savings (sNUSD)"` | `"lending-vault"` |
| 220 | Avalon USDa | `"Avalon savings (sUSDa)"` | `"lending-vault"` |
| 298 | infiniFi USD | `"infiniFi savings (siUSD)"` | `"lending-vault"` |
| 246 | Falcon USD | `"Falcon Finance savings (sUSDf)"` | `"lending-vault"` |
| 271 | Avant USD | `"Avant savings (savUSD)"` | `"lending-vault"` |
| 283 | Unitas | `"Unitas savings (sUSDu)"` | `"governance-set"` |
| 344 | Yuzu USD | `"Yuzu savings (syzUSD)"` | `"lending-vault"` |
| 230 | Noon USN | `"Noon savings (sUSN)"` | `"governance-set"` |
| 297 | Main Street USD | `"Main Street savings (msY)"` | `"lending-vault"` |
| 353 | GAIB AID | `"GAIB savings (sAID)"` | `"lending-vault"` |

Example — before:
```ts
usd("309", "USD.AI", "USDai", "rwa-backed", "centralized-dependent", {
  // ... existing options
}),
```

After:
```ts
usd("309", "USD.AI", "USDai", "rwa-backed", "centralized-dependent", {
  // ... existing options
  yieldBearing: true,
  yieldConfig: { yieldSource: "USD.AI savings (sUSDai)", yieldType: "lending-vault" },
}),
```

**Note:** fxUSD (168) is already `yieldBearing: true` — do NOT modify it.

**Step 2: Build + type-check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no new errors.

**Step 3: Commit**

```bash
git add src/lib/stablecoins.ts
git commit -m "feat(yield): flag 11 stablewatch wrapper coins as yield-bearing"
```

---

## Task 7: `sync-yield-data.ts` refactor — multi-source resolution

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts`

This is the largest change. Make changes in this exact order to avoid breaking intermediate states.

**Step 1: Update imports — add `matchAllDlPools`**

In the imports block at the top, add `matchAllDlPools` to the `yield-helpers` import:

```ts
import {
  computeApyFromRate, computeApyFromPrice, computePYS,
  computeYieldStability, computeApyVarianceScore,
  detectWarningSignals, findBestLendingPool, matchAllDlPools,  // ← add matchAllDlPools
} from "./yield-helpers";
```

**Step 2: Extend `ResolvedYield` to include `sourceKey`**

```ts
interface ResolvedYield {
  currentApy: number;
  apyBase: number | null;
  apyReward: number | null;
  sourcePool: string | null;
  sourceTvlUsd: number | null;
  dataSource: "onchain" | "defillama" | "defillama-auto" | "price-derived";
  exchangeRate: number | null;
  sourceKey: string;           // ← add: DL pool UUID or "price-derived"
  yieldSource?: string;        // ← add: override label (for variant wrapper rows)
  yieldType?: string;          // ← add: override type (for variant wrapper rows)
}
```

**Step 3: Replace the Tier 1 block** — populate `sourcePool` from `YIELD_POOL_MAP` so `sourceKey` is the DL pool UUID rather than null:

Find the Tier 1 block (around line 226):
```ts
    // Tier 1: On-chain rate
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      ...
      resolved.push({
        id, symbol,
        yield: { currentApy: apy, ..., sourcePool: null, ..., dataSource: "onchain", exchangeRate: rate },
      });
      continue;
    }
```

Replace with:
```ts
    // Tier 1: On-chain rate
    const rateConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === id);
    if (rateConfig && onChainRates.has(id)) {
      const { rate } = onChainRates.get(id)!;
      const prevRow = await db.prepare(
        "SELECT exchange_rate, recorded_at FROM yield_history WHERE stablecoin_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1"
      ).bind(id, startSec - 7 * 86400).first<{ exchange_rate: number | null; recorded_at: number }>();
      tier1PrevRates.set(id, prevRow?.exchange_rate ?? null);

      if (prevRow?.exchange_rate && prevRow.exchange_rate > 0) {
        const actualDays = (startSec - prevRow.recorded_at) / 86400;
        const apy = computeApyFromRate(rate, prevRow.exchange_rate, actualDays);
        // Populate sourcePool from YIELD_POOL_MAP so source_key is a stable UUID.
        const nativePoolId = YIELD_POOL_MAP[id] ?? null;
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: nativePoolId,
            sourceTvlUsd: null,
            dataSource: "onchain",
            exchangeRate: rate,
            sourceKey: nativePoolId ?? "price-derived",
          },
        });
        // Do NOT continue — fall through to also check for additional sources (Tier 2 wrapper pools)
      }
      // Fall through if no previous rate yet (first run)
    }
```

**Step 4: Replace the Tier 2 block** — use `matchAllDlPools`, push one entry per source:

Find the Tier 2 block (around line 248):
```ts
    // Tier 2: DeFiLlama pool match
    const pool = matchDlPool(id, symbol, dlPools);
    if (pool && pool.apy != null && pool.apy >= 0) {
      resolved.push({ id, symbol, yield: { ..., sourcePool: pool.pool, ..., dataSource: "defillama" } });
      continue;
    }
```

Replace with:
```ts
    // Tier 2: DeFiLlama pool matching — collect ALL sources for this coin
    const alreadyResolvedKeys = new Set(
      resolved.filter(r => r.id === id && r.yield != null).map(r => r.yield!.sourceKey)
    );
    const dlSources = matchAllDlPools(id, symbol, dlPools, YIELD_POOL_MAP, YIELD_VARIANT_MAP);
    for (const dlPool of dlSources) {
      if (alreadyResolvedKeys.has(dlPool.pool)) continue; // Tier 1 already handled this source
      if (dlPool.apy == null || dlPool.apy < 0) continue;

      const variant = YIELD_VARIANT_MAP[id];
      // Use variant label/type if this pool was found via the variant map and not the pool map
      const isVariantPool = variant && !YIELD_POOL_MAP[id]
        ? true
        : dlPool.pool !== YIELD_POOL_MAP[id] && variant != null;
      const yieldSourceOverride = isVariantPool ? variant?.yieldSource : undefined;
      const yieldTypeOverride = isVariantPool ? variant?.yieldType : undefined;

      resolved.push({
        id, symbol,
        yield: {
          currentApy: dlPool.apy,
          apyBase: (dlPool as unknown as { apyBase: number | null }).apyBase ?? null,
          apyReward: (dlPool as unknown as { apyReward: number | null }).apyReward ?? null,
          sourcePool: dlPool.pool,
          sourceTvlUsd: dlPool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
          sourceKey: dlPool.pool,
          yieldSource: yieldSourceOverride,
          yieldType: yieldTypeOverride,
        },
      });
      alreadyResolvedKeys.add(dlPool.pool);
    }

    // If we found any DL sources, skip price-derived
    if (alreadyResolvedKeys.size > 0) continue;
```

**Note:** The `matchAllDlPools` return type doesn't include `apyBase`/`apyReward`. You need to update the `DlPool` inline type in `matchAllDlPools` call in the sync OR use the full `DlPool` array directly. Since `dlPools` in the sync is typed as `DlPool[]` (with `apyBase`/`apyReward`), pass the full pools array and the function's return values reference the same objects. Simplest fix: cast via `dlPools.find(p => p.pool === dlPool.pool)` to get the full object. Replace the `resolved.push` inside the `for` loop with:

```ts
      const fullPool = dlPools.find(p => p.pool === dlPool.pool)!;
      resolved.push({
        id, symbol,
        yield: {
          currentApy: fullPool.apy,
          apyBase: fullPool.apyBase,
          apyReward: fullPool.apyReward,
          sourcePool: fullPool.pool,
          sourceTvlUsd: fullPool.tvlUsd,
          dataSource: "defillama",
          exchangeRate: null,
          sourceKey: fullPool.pool,
          yieldSource: yieldSourceOverride,
          yieldType: yieldTypeOverride,
        },
      });
```

**Step 5: Update Tier 3 — add `sourceKey`**

In the Tier 3 block:
```ts
        resolved.push({
          id, symbol,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: null, sourceTvlUsd: null,
            dataSource: "price-derived", exchangeRate: null,
            sourceKey: "price-derived",           // ← add
          },
        });
```

**Step 6: Update auto-discovery to run for all coins (including yield-bearing)**

Find the `lendingCandidates` filter (around line 338):
```ts
    const lendingCandidates = TRACKED_STABLECOINS.filter((m) =>
      !yieldBearingIds.has(m.id) &&    // ← REMOVE this line
      !resolvedIds.has(m.id) &&        // keep, but change meaning (see below)
      ...
    );
```

Replace the entire auto-discovery section with:

```ts
  if (dlPools.length > 0) {
    // Track coins that have already received an auto-discovered (defillama-auto) source
    const autoDiscoveredIds = new Set<string>();

    // Deterministic overrides (same logic as before, but now for ALL coins)
    for (const [stablecoinId, poolId] of Object.entries(AUTO_LENDING_POOL_MAP)) {
      if (autoDiscoveredIds.has(stablecoinId)) continue;

      const pool = dlPools.find((p) => p.pool === poolId);
      if (!pool) continue;

      const safetyScore = safetyScores.get(stablecoinId)?.score ?? 0;
      const bypassSafety = AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId);
      if (!bypassSafety && safetyScore < MIN_SAFETY_SCORE_FOR_YIELD) continue;

      const eligible = (
        pool.exposure === "single" && pool.stablecoin &&
        LENDING_PROTOCOL_ALLOWLIST.has(pool.project) &&
        pool.apy >= MIN_LENDING_POOL_APY &&
        pool.tvlUsd >= MIN_LENDING_POOL_TVL_USD
      );
      if (!eligible) continue;

      // Skip if this exact pool UUID is already in resolved for this coin
      const alreadyHasPool = resolved.some(r => r.id === stablecoinId && r.yield?.sourceKey === poolId);
      if (alreadyHasPool) continue;

      const meta = TRACKED_STABLECOINS.find((m) => m.id === stablecoinId);
      if (!meta) continue;

      resolved.push({
        id: meta.id, symbol: meta.symbol,
        yield: {
          currentApy: pool.apy, apyBase: pool.apyBase, apyReward: pool.apyReward,
          sourcePool: pool.pool, sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto", exchangeRate: null, sourceKey: pool.pool,
        },
      });
      autoDiscoveredIds.add(stablecoinId);
      deterministicCount++;
      autoCount++;
    }

    // Dynamic discovery: all coins with safety >= threshold, no auto-discovered pool yet
    const lendingCandidates = TRACKED_STABLECOINS.filter((m) =>
      !autoDiscoveredIds.has(m.id) &&
      m.flags.pegCurrency !== "GOLD" &&
      m.flags.pegCurrency !== "SILVER" &&
      (safetyScores.get(m.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD
    );

    for (const meta of lendingCandidates) {
      const pool = findBestLendingPool(meta.symbol, dlPools, LENDING_PROTOCOL_ALLOWLIST, {
        minApy: MIN_LENDING_POOL_APY,
        minTvlUsd: MIN_LENDING_POOL_TVL_USD,
        contractAddresses: (meta.contracts ?? []).map((c) => c.address),
      });
      if (!pool) continue;

      // Skip if this pool UUID already in resolved for this coin
      const alreadyHasPool = resolved.some(r => r.id === meta.id && r.yield?.sourceKey === pool.pool);
      if (alreadyHasPool) continue;

      resolved.push({
        id: meta.id, symbol: meta.symbol,
        yield: {
          currentApy: pool.apy, apyBase: pool.apyBase, apyReward: pool.apyReward,
          sourcePool: pool.pool, sourceTvlUsd: pool.tvlUsd,
          dataSource: "defillama-auto", exchangeRate: null, sourceKey: pool.pool,
        },
      });
      autoDiscoveredIds.add(meta.id);
      autoCount++;
    }
    console.log(`[sync-yield-data] Auto-discovery: ${autoCount} lending pools (${deterministicCount} deterministic, ${autoCount - deterministicCount} dynamic)`);
  }
```

**Note:** You'll need to declare `let autoCount = 0; let deterministicCount = 0;` at the top of the `if (dlPools.length > 0)` block.

**Step 7: Determine `is_best` per coin before the write loop**

After the auto-discovery block and before step 6 of the original sync (`// 6. Compute trailing averages, PYS, and store`), add:

```ts
  // Determine is_best per coin: source with highest currentApy wins.
  // (Using currentApy per user spec: "display the currently best paying one")
  const bestSourceKeyByCoin = new Map<string, string>();
  const coinApys = new Map<string, number>();
  for (const { id, yield: y } of resolved) {
    if (!y) continue;
    const prev = coinApys.get(id) ?? -Infinity;
    if (y.currentApy > prev) {
      coinApys.set(id, y.currentApy);
      bestSourceKeyByCoin.set(id, y.sourceKey);
    }
  }
```

**Step 8: Update the `yieldDataStmts` write to use `(stablecoin_id, source_key)` PK**

In the main write loop (`for (const { id, symbol, yield: y } of resolved)`), update:

a) Compute `yieldSource` and `yieldType` using the override if present:
```ts
    const yieldSource = y.yieldSource
      ?? yieldConfig?.yieldSource
      ?? (y.dataSource === "defillama-auto" ? "Best lending rate" : "Unknown");
    const yieldType = y.yieldType
      ?? yieldConfig?.yieldType
      ?? (y.dataSource === "defillama-auto" ? "lending-opportunity" : "nav-appreciation");
```

b) Compute `is_best`:
```ts
    const isBest = bestSourceKeyByCoin.get(id) === y.sourceKey ? 1 : 0;
```

c) Update the `INSERT OR REPLACE` to include `source_key` and `is_best`. Change the column list and values:
```ts
    yieldDataStmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO yield_data (
          stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
          yield_source, yield_type, source_pool, source_tvl_usd, data_source,
          safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
          apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev,
          warning_signals, is_best, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, y.sourceKey, symbol, y.currentApy, y.apyBase, y.apyReward, apy7d, apy30d,
        yieldSource, yieldType,
        y.sourcePool, y.sourceTvlUsd, y.dataSource,
        safetyScore, safetyGrade, safePys, yieldToRisk, excessYield, safeStability,
        safeVariance30d, apyMin30d, apyMax30d, y.exchangeRate, prevExchangeRate,
        warningSignalsJson, isBest, startSec,
      )
    );
```

**Step 9: Add stale source cleanup after the batch write**

After `if (historyStmts.length > 0) await batchExecute(db, historyStmts);`, add:

```ts
  // Remove stale sources: any yield_data row we processed but didn't update this run.
  // updated_at < startSec means the row existed before this sync and wasn't refreshed.
  const processedCoinIds = [...new Set(resolved.map(r => r.id))];
  if (processedCoinIds.length > 0) {
    const staleCleanupStmts = processedCoinIds.map(coinId =>
      db.prepare("DELETE FROM yield_data WHERE stablecoin_id = ? AND updated_at < ?")
        .bind(coinId, startSec)
    );
    await batchExecute(db, staleCleanupStmts);
  }
```

**Step 10: Update the rankings cache query to use `WHERE is_best = 1`**

Find (around line 508):
```ts
  const rankingsData = await db.prepare("SELECT * FROM yield_data ORDER BY pharos_yield_score DESC").all();
```

Replace with:
```ts
  const rankingsData = await db.prepare(
    "SELECT * FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC"
  ).all();
```

**Step 11: Update `rowToRanking` to include `altSources: []`**

Add `altSources: [],` to the `rowToRanking` return object (alt sources are attached separately in the next task):

```ts
function rowToRanking(row: Record<string, unknown>) {
  return {
    // ... existing fields ...
    warningSignals: row.warning_signals ? JSON.parse(row.warning_signals as string) : [],
    altSources: [],   // ← add — populated in the cache-build step
  };
}
```

**Step 12: Worker type-check**

```bash
cd worker && npx tsc --noEmit 2>&1 | grep "error TS" | head -30
```

Expected: no errors. Fix any type errors before continuing.

**Step 13: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(yield): refactor sync to collect all DL sources per coin with is_best flag"
```

---

## Task 8: Attach `altSources` in the cache build step

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts` (the rankings cache section)

The cache build step already runs at the end of `syncYieldData`. We need to fetch alt sources and attach them to the ranking entries before writing the cache.

**Step 1: Replace the cache build section** (around line 508):

```ts
  // 9. Cache the rankings response for fast API reads
  const [rankingsData, altSourcesData] = await Promise.all([
    db.prepare("SELECT * FROM yield_data WHERE is_best = 1 ORDER BY pharos_yield_score DESC").all(),
    db.prepare("SELECT stablecoin_id, source_key, yield_source, yield_type, current_apy, apy_30d, source_tvl_usd, data_source FROM yield_data WHERE is_best = 0").all(),
  ]);

  // Group alt sources by stablecoin_id
  const altSourcesByCoins = new Map<string, AltYieldSource[]>();
  for (const row of altSourcesData.results ?? []) {
    const r = row as Record<string, unknown>;
    const coinId = r.stablecoin_id as string;
    const alt: AltYieldSource = {
      sourceKey: r.source_key as string,
      yieldSource: r.yield_source as string,
      yieldType: r.yield_type as string,
      currentApy: r.current_apy as number,
      apy30d: r.apy_30d as number,
      sourceTvlUsd: (r.source_tvl_usd as number | null) ?? null,
      dataSource: r.data_source as string,
    };
    const existing = altSourcesByCoins.get(coinId) ?? [];
    existing.push(alt);
    altSourcesByCoins.set(coinId, existing);
  }

  const rankingsPayload = {
    rankings: (rankingsData.results ?? []).map(row => {
      const ranking = rowToRanking(row);
      ranking.altSources = altSourcesByCoins.get(ranking.id) ?? [];
      return ranking;
    }),
    riskFreeRate,
    scalingFactor: PYS_SCALING_FACTOR,
    updatedAt: startSec,
  };
```

**Step 2: Add the `AltYieldSource` import** to the sync file:

```ts
import type { AltYieldSource, YieldRankingsResponseSchema /* existing */ } from "../../../src/lib/types";
```

**Step 3: Worker type-check**

```bash
cd worker && npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

**Step 4: Full test run**

```bash
npm test 2>&1 | tail -20
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(yield): attach altSources to yield-rankings cache payload"
```

---

## Task 9: Frontend — `+N sources` pill badge in yield leaderboard

**Files:**
- Modify: `src/components/yield-leaderboard.tsx`

**Step 1: Locate the Source column cell** in `yield-leaderboard.tsx`

Find the table cell that renders `yieldSource` (it's a `<td>` or similar in the row mapping). It likely looks like:
```tsx
<td>{row.yieldSource}</td>
// or
<TableCell>{item.yieldSource}</TableCell>
```

**Step 2: Replace with source cell that includes the pill + popover**

Add this import at the top if not already present:
```tsx
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
```

Replace the source cell render:
```tsx
<TableCell>
  <div className="flex items-center gap-1.5 flex-wrap">
    <span className="text-sm">{item.yieldSource}</span>
    {item.altSources && item.altSources.length > 0 && (
      <Popover>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted/80 transition-colors">
            +{item.altSources.length}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <p className="text-xs font-medium text-muted-foreground mb-2">Other yield sources</p>
          <div className="space-y-2">
            {item.altSources.map((alt) => (
              <div key={alt.sourceKey} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground truncate mr-2">{alt.yieldSource}</span>
                <span className="font-medium tabular-nums whitespace-nowrap">
                  {alt.currentApy.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    )}
  </div>
</TableCell>
```

**Step 3: Build to verify no JSX/type errors**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/components/yield-leaderboard.tsx
git commit -m "feat(yield): add +N sources pill badge with popover in yield leaderboard"
```

---

## Task 10: Docs + final verification

**Files:**
- Modify: `docs/yield-intelligence.md`

**Step 1: Update `docs/yield-intelligence.md`**

Update the following sections:

1. **Tracked Coins** (line 9): update coin count from 24 to 35 (24 + 11 new).

2. **`YIELD_VARIANT_MAP` table** (line 72–83): add the 12 new rows.

3. **Database Schema** — `yield_data` table: add `source_key TEXT NOT NULL` and `is_best INTEGER NOT NULL DEFAULT 1` columns, update PRIMARY KEY line.

4. **`sync-yield-data` cron** — update execution flow to mention multi-source collection and `is_best` determination.

5. **`GET /api/yield-rankings` response**: add `altSources` field to the example JSON.

6. **File Index**: no new files, but update descriptions to reflect the changes.

**Step 2: Full build + lint + type-check**

```bash
npm run build 2>&1 | tail -5
npm run lint 2>&1 | grep -E "error|warning" | grep -v "^$" | head -20
cd worker && npx tsc --noEmit && echo "worker types OK"
```

Expected: all clean.

**Step 3: Full test run**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

**Step 4: Final commit**

```bash
git add docs/yield-intelligence.md
git commit -m "docs(yield): update yield-intelligence.md for multi-source schema and 12 new wrappers"
```

---

## Verification Checklist

Before declaring done, confirm:

- [ ] `npm run build` passes (no TypeScript errors)
- [ ] `npm run lint` passes (no ESLint errors)
- [ ] `cd worker && npx tsc --noEmit` passes
- [ ] `npm test` passes (all yield-helpers tests including new `matchAllDlPools` tests)
- [ ] Migration `0041` applies cleanly: `cd worker && npx wrangler d1 migrations apply pharos-db --local`
- [ ] `yield_data` has composite PK `(stablecoin_id, source_key)` in schema
- [ ] `YIELD_VARIANT_MAP` has 22 entries (10 original + 12 new)
- [ ] 11 new coins have `yieldBearing: true` in `stablecoins.ts`
- [ ] fxUSD (168) has both a `YIELD_POOL_MAP` entry (Stability Pool) and a `YIELD_VARIANT_MAP` entry (fxSAVE)
- [ ] `YieldRanking.altSources` present in types and Zod schema
- [ ] `+N` pill visible in yield leaderboard for multi-source coins (verify locally with `npm run dev`)
