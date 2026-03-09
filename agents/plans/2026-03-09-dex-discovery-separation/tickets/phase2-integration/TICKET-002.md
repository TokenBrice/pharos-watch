---
title: "Add integration tests for empty staging, chain-aware routing, and backoff reset"
agent: codex
model: gpt-5.3-codex
reasoning_effort: medium
done: false
---

## Goal

Verify no regression when the staging table is empty and test chain-aware routing + backoff reset logic.

## Task

1. Read existing test files for patterns:
   - `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` (from Phase 1)
   - `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` (from Phase 1)
   - `shared/lib/stablecoins.ts` — check the `contracts` field shape on a few stablecoins

2. Add to `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`:

```typescript
import { computeEffectiveTier } from "../orchestrator";
import type { DiscoveryMeta } from "../types";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";

describe("chain-aware routing", () => {
  it("coin contracts array determines crawl chains", () => {
    // Find a real stablecoin with known contracts
    const usdc = TRACKED_STABLECOINS.find(s => s.id.includes("usdc"));
    expect(usdc).toBeDefined();
    expect(usdc!.contracts).toBeDefined();
    expect(Array.isArray(usdc!.contracts)).toBe(true);

    // Build coinChains the same way the orchestrator does
    // contracts is ContractDeployment[] = { chain, address, decimals }[]
    const coinChains = new Map(
      (usdc!.contracts ?? []).map(c => [c.chain, c.address])
    );

    // Verify it only contains chains from the contracts array
    expect(coinChains.size).toBeGreaterThan(0);
    // Every chain in the map should correspond to a contract entry
    for (const [chain] of coinChains) {
      expect(usdc!.contracts!.some(c => c.chain === chain)).toBe(true);
    }
  });
});

describe("backoff reset integration", () => {
  const nowSec = 1710000000;

  it("after miss reset, coin returns to base tier", () => {
    // After finding pools, consecutiveMisses resets to 0
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 0,  // was 10, then reset after finding pools
      lastCrawlAt: nowSec - 100,
      lastHitAt: nowSec - 100,
    };

    const tier = computeEffectiveTier(0, 0, meta, 1, nowSec);
    expect(tier).toBe("t1");  // 0 pools = T1, no backoff
  });

  it("dormant coin becomes eligible after 24h", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 86401,  // just over 24h ago
      lastHitAt: null,
    };

    // Dormant but stale — should be eligible at T3 cadence
    const tier = computeEffectiveTier(0, 0, meta, 10, nowSec);  // seq=10 divisible by 10
    expect(tier).not.toBe("skip");
  });

  it("dormant coin with recent crawl is skipped", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 3600,  // 1 hour ago
      lastHitAt: null,
    };

    const tier = computeEffectiveTier(0, 0, meta, 10, nowSec);
    expect(tier).toBe("skip");
  });
});
```

3. Add to `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`:

```typescript
describe("mergeStagedPools — no-regression with empty staging", () => {
  it("does not modify metrics when staging table is empty", async () => {
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    const { mergeStagedPools } = await import("../staging-merge");
    const metrics = new Map<string, any>();
    metrics.set("test-coin", {
      totalTvlUsd: 1000000,
      poolCount: 5,
    });
    const originalTvl = metrics.get("test-coin")!.totalTvlUsd;

    const result = await mergeStagedPools(mockDb, metrics as any, new Set(), 1710000000);

    expect(result.mergedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(metrics.get("test-coin")!.totalTvlUsd).toBe(originalTvl);
  });
});
```

4. Run all tests and verify they pass.

## Acceptance Criteria

- `npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` — all tests pass
- `npm test -- --run worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts` — all tests pass
- `npm test` — all tests pass (no regressions)
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- Chain-aware routing test uses actual `TRACKED_STABLECOINS` data
- Backoff tests verify behavior with explicit `nowSec` parameter (deterministic)
- Empty staging test proves existing metrics are unmodified
