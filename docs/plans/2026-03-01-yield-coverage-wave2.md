# Yield Coverage Wave 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic lending pool discovery from a 12-protocol allowlist for non-yield-bearing stablecoins rated C+ or above, plus fxUSD native yield. Expands yield coverage from 23 to ~39 coins.

**Architecture:** Two parts. Part A adds fxUSD as a standard wave 1-style native yield coin (config only). Part B adds a new auto-discovery pass to the sync cron that, after processing `yieldBearing` coins, scans DL pools for non-yield-bearing C+ coins and resolves their best lending rate. A new `"lending-opportunity"` yield type and `"defillama-auto"` data source tag distinguish these from native yield coins.

**Tech Stack:** TypeScript, Vitest

**Design doc:** `docs/plans/2026-03-01-yield-coverage-wave2-design.md`

---

### Task 1: Add `"lending-opportunity"` to YieldType union and classification maps

**Files:**
- Modify: `src/lib/types.ts:666`
- Modify: `src/lib/classification.ts:261-277`

**Step 1: Add the new type to the union**

In `src/lib/types.ts`, line 666, change:

```ts
export type YieldType = "lending-vault" | "rebase" | "fee-sharing" | "lp-receipt" | "nav-appreciation" | "governance-set";
```

to:

```ts
export type YieldType = "lending-vault" | "rebase" | "fee-sharing" | "lp-receipt" | "nav-appreciation" | "governance-set" | "lending-opportunity";
```

**Step 2: Add label and style entries**

In `src/lib/classification.ts`, add to `YIELD_TYPE_LABELS` (after line 267):

```ts
  "lending-opportunity": "Lending Opp.",
```

Add to `YIELD_TYPE_STYLES` (after line 276):

```ts
  "lending-opportunity": { badge: "bg-sky-500/10 text-sky-500 border-sky-500/20", hex: "#0ea5e9" },
```

**Step 3: Verify build**

Run: `npm run build`
Expected: clean build, no errors (TypeScript will catch any exhaustive switch/map issues)

**Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/classification.ts
git commit -m "feat(yield): add lending-opportunity yield type with label and style"
```

---

### Task 2: Add fxUSD native yield config (Part A)

**Files:**
- Modify: `src/lib/stablecoins.ts` (fxUSD entry, ID "168")
- Modify: `worker/src/cron/yield-config.ts` (YIELD_POOL_MAP)

**Step 1: Flag fxUSD as yield-bearing**

In `src/lib/stablecoins.ts`, find `geckoId: "f-x-protocol-fxusd",` (inside the `usd("168", "fxUSD", ...)` call) and add after it:

```ts
    yieldBearing: true,
    yieldConfig: { yieldSource: "f(x) Protocol Stability Pool", yieldType: "governance-set" },
```

**Step 2: Add fxUSD to YIELD_POOL_MAP**

In `worker/src/cron/yield-config.ts`, add to `YIELD_POOL_MAP` after the ZCHF entry (in the Wave 1 section):

```ts

  // fxUSD - fx-protocol Stability Pool, Ethereum, $33.9M TVL, ~4.0% APY
  //         (DL symbol is FXUSDSTABILITYPOOLV2.0, not fxUSD — must use static map)
  "168": "abd6c9e1-3b52-459a-a31b-9022a4dcf7e2",
```

**Step 3: Update GATE comment**

Change the GATE comment from `20/23` to `21/24` (one more mapped, one more total).

**Step 4: Verify**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: no errors

**Step 5: Commit**

```bash
git add src/lib/stablecoins.ts worker/src/cron/yield-config.ts
git commit -m "feat(yield): add fxUSD native yield via f(x) Protocol Stability Pool"
```

---

### Task 3: Add `LENDING_PROTOCOL_ALLOWLIST` and `MIN_SAFETY_SCORE_FOR_YIELD` constants

**Files:**
- Modify: `worker/src/cron/yield-config.ts`
- Modify: `worker/src/lib/constants.ts`

**Step 1: Add allowlist to yield-config.ts**

Add at the end of `worker/src/cron/yield-config.ts` (after `ON_CHAIN_RATE_CONFIGS`):

```ts

/**
 * Curated protocol allowlist for automatic lending pool discovery (Wave 2).
 * Only pools from these protocols are considered for non-yield-bearing coins.
 *
 * Tier 1 (battle-tested, $1B+ historical TVL):
 *   aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance
 *
 * Tier 2 (established, well-audited):
 *   fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle
 */
export const LENDING_PROTOCOL_ALLOWLIST = new Set([
  // Tier 1
  "aave-v3",
  "compound-v3",
  "sparklend",
  "spark-savings",
  "maple",
  "yearn-finance",
  // Tier 2
  "fluid-lending",
  "euler-v2",
  "venus-core-pool",
  "kamino-lend",
  "morpho-v1",
  "pendle",
]);
```

**Step 2: Add MIN_SAFETY_SCORE_FOR_YIELD constant**

In `worker/src/lib/constants.ts`, add after the `DEFAULT_SAFETY_SCORE` line:

```ts
/** Minimum report-card score for a coin to qualify for automatic yield discovery (C+ = 60). */
export const MIN_SAFETY_SCORE_FOR_YIELD = 60;
```

**Step 3: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add worker/src/cron/yield-config.ts worker/src/lib/constants.ts
git commit -m "feat(yield): add lending protocol allowlist and min safety score constant"
```

---

### Task 4: Extend `ResolvedYield.dataSource` to include `"defillama-auto"`

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:51`

**Step 1: Widen the dataSource type**

In `worker/src/cron/sync-yield-data.ts`, line 51, change:

```ts
  dataSource: "onchain" | "defillama" | "price-derived";
```

to:

```ts
  dataSource: "onchain" | "defillama" | "defillama-auto" | "price-derived";
```

**Step 2: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(yield): widen ResolvedYield.dataSource to include defillama-auto"
```

---

### Task 5: Write tests for auto-discovery pool matching

**Files:**
- Modify: `src/lib/__tests__/yield-helpers.test.ts`
- The function under test (`findBestLendingPool`) will be created in Task 6

**Step 1: Write the failing tests**

Add a new `describe("findBestLendingPool")` block at the end of `src/lib/__tests__/yield-helpers.test.ts`:

```ts
import { findBestLendingPool } from "../../../worker/src/cron/yield-helpers";

describe("findBestLendingPool", () => {
  const allowlist = new Set(["aave-v3", "compound-v3", "maple"]);

  const makeDlPool = (overrides: Partial<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string; chain: string;
  }>) => ({
    pool: "pool-1",
    symbol: "USDC",
    project: "aave-v3",
    tvlUsd: 1_000_000,
    apy: 3.5,
    apyBase: 3.5,
    apyReward: null,
    stablecoin: true,
    exposure: "single",
    chain: "Ethereum",
    apyMean30d: 3.5,
    underlyingTokens: null,
    ...overrides,
  });

  it("returns the highest-TVL pool from an allowlisted protocol", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", tvlUsd: 500_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", tvlUsd: 2_000_000 }),
      makeDlPool({ pool: "c", project: "compound-v3", tvlUsd: 1_000_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).not.toBeNull();
    expect(result!.pool).toBe("b"); // highest TVL
  });

  it("excludes pools from non-allowlisted protocols", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "sketchy-dex", tvlUsd: 10_000_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", tvlUsd: 500_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result!.pool).toBe("b");
  });

  it("excludes multi-exposure pools", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", exposure: "multi", tvlUsd: 5_000_000 }),
      makeDlPool({ pool: "b", project: "aave-v3", exposure: "single", tvlUsd: 100_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result!.pool).toBe("b");
  });

  it("excludes non-stablecoin pools", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", stablecoin: false, tvlUsd: 5_000_000 }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).toBeNull();
  });

  it("matches symbol case-insensitively", () => {
    const pools = [
      makeDlPool({ pool: "a", project: "aave-v3", symbol: "usdc" }),
    ];
    const result = findBestLendingPool("USDC", pools, allowlist);
    expect(result).not.toBeNull();
  });

  it("returns null when no pools match", () => {
    const result = findBestLendingPool("XSGD", [], allowlist);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter verbose 2>&1 | grep -A2 "findBestLendingPool"`
Expected: FAIL (function not found / import error)

**Step 3: Commit**

```bash
git add src/lib/__tests__/yield-helpers.test.ts
git commit -m "test(yield): add tests for findBestLendingPool auto-discovery function"
```

---

### Task 6: Implement `findBestLendingPool` in yield-helpers.ts

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts`

**Step 1: Add the function**

Add at the end of `worker/src/cron/yield-helpers.ts`, before the file ends:

```ts
/**
 * Auto-discovery: find the best lending pool for a coin from allowlisted protocols.
 * Used for non-yield-bearing stablecoins rated C+ or above (Wave 2).
 *
 * Filters: single exposure, stablecoin = true, project in allowlist, symbol match.
 * Picks the highest-TVL pool.
 */
export function findBestLendingPool(
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
  }>,
  allowlist: Set<string>,
): { pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number; project: string } | null {
  const symLower = symbol.toLowerCase();

  const candidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    allowlist.has(p.project) &&
    p.symbol.toLowerCase() === symLower
  );

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (b.tvlUsd > a.tvlUsd ? b : a));
  return {
    pool: best.pool,
    apy: best.apy,
    apyBase: best.apyBase,
    apyReward: best.apyReward,
    tvlUsd: best.tvlUsd,
    project: best.project,
  };
}
```

**Step 2: Run tests**

Run: `npm test`
Expected: all pass (including the 6 new findBestLendingPool tests)

**Step 3: Commit**

```bash
git add worker/src/cron/yield-helpers.ts
git commit -m "feat(yield): implement findBestLendingPool for auto-discovery"
```

---

### Task 7: Add auto-discovery pass to sync-yield-data.ts

This is the main logic change. After the existing yield-bearing coin loop (line 267), add a second pass for non-yield-bearing C+ coins.

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts`

**Step 1: Add imports**

At the top of `sync-yield-data.ts`, add `LENDING_PROTOCOL_ALLOWLIST` to the yield-config import (line 17-18):

```ts
import {
  YIELD_VARIANT_MAP, YIELD_POOL_MAP, ON_CHAIN_RATE_CONFIGS,
  LENDING_PROTOCOL_ALLOWLIST,
} from "./yield-config";
```

Add `MIN_SAFETY_SCORE_FOR_YIELD` to the constants import (line 6-8):

```ts
import {
  USER_AGENT, CIRCUIT_SOURCE, RISK_FREE_RATE_FALLBACK,
  PYS_SCALING_FACTOR, DEFAULT_SAFETY_SCORE, MIN_SAFETY_SCORE_FOR_YIELD,
} from "../lib/constants";
```

Add `findBestLendingPool` to the yield-helpers import (line 11-15):

```ts
import {
  computeApyFromRate, computeApyFromPrice, computePYS,
  computeYieldStability, computeApyVarianceScore,
  detectWarningSignals, findBestLendingPool,
} from "./yield-helpers";
```

**Step 2: Add auto-discovery pass after the yield-bearing coin loop**

After line 267 (`resolved.push({ id, symbol, yield: null });` and the closing `}`), add the auto-discovery block. Insert it between the yield-bearing loop and the "6. Compute trailing averages" section:

```ts
  // 5b. Auto-discovery: find lending pools for non-yield-bearing C+ coins
  if (dlPools.length > 0) {
    const yieldBearingIds = new Set(yieldCoins.map((m) => m.id));
    const lendingCandidates = TRACKED_STABLECOINS.filter((m) =>
      !yieldBearingIds.has(m.id) &&
      (safetyScores.get(m.id)?.score ?? 0) >= MIN_SAFETY_SCORE_FOR_YIELD
    );

    for (const meta of lendingCandidates) {
      const pool = findBestLendingPool(meta.symbol, dlPools, LENDING_PROTOCOL_ALLOWLIST);
      if (pool && pool.apy != null && pool.apy >= 0) {
        resolved.push({
          id: meta.id,
          symbol: meta.symbol,
          yield: {
            currentApy: pool.apy,
            apyBase: pool.apyBase,
            apyReward: pool.apyReward,
            sourcePool: pool.pool,
            sourceTvlUsd: pool.tvlUsd,
            dataSource: "defillama-auto",
            exchangeRate: null,
          },
        });
      }
    }
  }
```

**Step 3: Update the store loop to handle auto-discovered coins**

In the store loop (line 295-383), the code currently does:

```ts
    const meta = yieldCoins.find((m) => m.id === id)!;
    const yieldConfig = meta.yieldConfig;
```

This will fail for auto-discovered coins because they're not in `yieldCoins`. Replace those two lines with:

```ts
    const meta = TRACKED_STABLECOINS.find((m) => m.id === id)!;
    const yieldConfig = meta.yieldConfig;
    // Auto-discovered coins: synthesize yieldSource/yieldType from pool data
    const yieldSource = yieldConfig?.yieldSource ?? `${y.dataSource === "defillama-auto" ? "Best lending rate" : "Unknown"}`;
    const yieldType = yieldConfig?.yieldType ?? (y.dataSource === "defillama-auto" ? "lending-opportunity" : "nav-appreciation");
```

Then update the upsert bind (line 367) to use `yieldSource` and `yieldType` instead of `yieldConfig?.yieldSource ?? "Unknown"` and `yieldConfig?.yieldType ?? "nav-appreciation"`:

Change:
```ts
        yieldConfig?.yieldSource ?? "Unknown", yieldConfig?.yieldType ?? "nav-appreciation",
```
to:
```ts
        yieldSource, yieldType,
```

**Step 4: Update the log line**

Change line 402:
```ts
  console.log(`[sync-yield-data] Updated ${updatedCount}/${yieldCoins.length} coins`);
```
to:
```ts
  console.log(`[sync-yield-data] Updated ${updatedCount} coins (${yieldCoins.length} yield-bearing + auto-discovered)`);
```

**Step 5: Verify**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

Run: `npm test`
Expected: all pass

**Step 6: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "feat(yield): add auto-discovery pass for lending pools from allowlisted protocols"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/yield-intelligence.md`

**Step 1: Update tracked coins count**

Line 9: Change `Currently 23 coins.` to `Currently 24 yield-bearing coins, plus automatic lending pool discovery for non-yield-bearing stablecoins rated C+ or above.`

**Step 2: Update pool map stats**

Line 66: Change `20 of 23 coins mapped.` to `21 of 24 coins mapped.`

**Step 3: Update estimated volume**

Line 221: Change `~23 coins × 48 points/day × 365 days ≈ 403K rows/year.` to `~39 coins × 48 points/day × 365 days ≈ 684K rows/year.`

**Step 4: Add auto-discovery section**

After the Tier 3 section (after line 87), add a new section:

```markdown
### Automatic Lending Pool Discovery (Wave 2)

For stablecoins **not** flagged `yieldBearing` but rated C+ or above (safety score >= 60), the sync cron automatically discovers the best lending pool from a curated protocol allowlist.

**Allowlist** (`LENDING_PROTOCOL_ALLOWLIST` in `worker/src/cron/yield-config.ts`):

| Tier | Protocols |
|------|-----------|
| Tier 1 | aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance |
| Tier 2 | fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle |

**Discovery logic:** Filters DL pools by `exposure === "single"`, `stablecoin === true`, project in allowlist, exact symbol match (case-insensitive). Picks highest TVL.

**Yield type:** `lending-opportunity` — distinguishes these from native yield coins on the frontend.

**Data source:** `defillama-auto` — distinguishes from static-mapped `defillama` pools.

**Eligibility evaluated dynamically:** If a coin's safety score drops below 60, it stops receiving yield data. If it rises above 60, it starts automatically.
```

**Step 5: Commit**

```bash
git add docs/yield-intelligence.md
git commit -m "docs: add wave-2 auto-discovery section to yield-intelligence.md"
```

---

### Task 9: Verify end-to-end

**Step 1: Run full test suite**

Run: `npm test`
Expected: all pass

**Step 2: Run frontend build**

Run: `npm run build`
Expected: clean build

**Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors

**Step 4: Verify yield-bearing count**

Run: `grep -c 'yieldBearing: true' src/lib/stablecoins.ts`
Expected: `24` (23 from wave 1 + fxUSD)

**Step 5: Verify allowlist size**

Run: `grep -c '"aave-v3"\|"compound-v3"\|"sparklend"\|"spark-savings"\|"maple"\|"yearn-finance"\|"fluid-lending"\|"euler-v2"\|"venus-core-pool"\|"kamino-lend"\|"morpho-v1"\|"pendle"' worker/src/cron/yield-config.ts`
Expected: `12`
