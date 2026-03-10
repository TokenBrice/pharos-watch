# DEX Price Observation Dedup Fix

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract DEX price observations from staged and fallback pools even when they are deduplicated for metrics purposes, fixing a bug where 52% of tracked stablecoins lack DEX price check data despite having discoverable DEX pools.

**Architecture:** Two dedup sites (`mergeStagedPools` in staging-merge.ts and `fetchDsFallbackPools` in fetch-fallbacks.ts) currently skip price observation extraction when a pool fingerprint-matches a DL yields pool. The fix moves price observation extraction above the dedup `continue` in both functions. Pool metrics dedup remains unchanged — only price observations are rescued.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers D1

---

## Task 1: Fix `mergeStagedPools` — extract price observations before dedup

**Files:**
- Modify: `worker/src/cron/dex-liquidity/staging-merge.ts:168-219`
- Test: `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`

### Step 1: Write failing test — deduped staged pool still contributes price observation

- [ ] Add this test to the `mergeStagedPools` describe block in `staging-merge.test.ts`:

```typescript
it("extracts price observations from pools skipped by address dedup", async () => {
  const now = 1710000000;
  const mockDb = createMockDb([{
    pool_id: "ethereum:0xknown",
    stablecoin_id: "usdt-tether",
    source: "cg_onchain",
    chain: "ethereum",
    protocol: "uniswap-v3",
    dex_id: "uniswap_v3",
    symbol: "USDT/USDC",
    tvl_usd: 100000,
    volume_24h: 50000,
    fee_tier: 5,
    balance_ratio: null,
    is_stable: 1,
    base_token: "0xbase",
    quote_token: "0xquote",
    quote_symbol: "USDC",
    price_usd: 0.9998,
    locked_liq_pct: null,
    discovered_at: now - 86400 * 10,
    refreshed_at: now,
  }]);
  const metrics = new Map();
  // Pool address is already known (from DL yields) — will be deduped for metrics
  const knownPoolAddrs = new Set(["ethereum:0xknown"]);

  const result = await mergeStagedPools(mockDb, metrics as never, knownPoolAddrs, now);

  // Metrics dedup still works — pool was NOT merged into metrics
  expect(result.skippedCount).toBe(1);
  expect(result.skippedByAddressCount).toBe(1);
  expect(result.mergedCount).toBe(0);
  expect(metrics.size).toBe(0);

  // But price observation WAS extracted
  const obs = result.priceObservations.get("usdt-tether");
  expect(obs).toHaveLength(1);
  expect(obs![0].price).toBe(0.9998);
  expect(obs![0].tvl).toBe(100000);
  expect(obs![0].chain).toBe("ethereum");
});
```

### Step 2: Run test to verify it fails

- [ ] Run: `cd worker && npx vitest run src/cron/dex-liquidity/__tests__/staging-merge.test.ts -t "extracts price observations from pools skipped by address dedup"`
- Expected: FAIL — `result.priceObservations.get("usdt-tether")` is undefined because the dedup `continue` skips price extraction.

### Step 3: Write second failing test — fingerprint dedup also preserves price observations

- [ ] Add this test below the previous one:

```typescript
it("extracts price observations from pools skipped by fingerprint dedup", async () => {
  const now = 1710000000;
  const mockDb = createMockDb([{
    pool_id: "ethereum:0xnewaddr",
    stablecoin_id: "usdt-tether",
    source: "gecko_terminal",
    chain: "ethereum",
    protocol: "pancakeswap",
    dex_id: "pancakeswap-v3",
    symbol: "USDT/USDC",
    tvl_usd: 80000,
    volume_24h: 40000,
    quality_multiplier: 0.5,
    pool_type: "gt-concentrated",
    fee_tier: null,
    balance_ratio: null,
    is_stable: 1,
    base_token: "0xbase",
    quote_token: "0xquote",
    quote_symbol: "USDC",
    price_usd: 1.0001,
    locked_liq_pct: null,
    discovered_at: now - 86400 * 5,
    refreshed_at: now,
  }]);
  const metrics = new Map();
  // Fingerprint is known (from DL yields) — will be deduped for metrics
  const knownPoolAddrs = new Set(["fp:ethereum:pancakeswap:0xbase:0xquote"]);

  const result = await mergeStagedPools(mockDb, metrics as never, knownPoolAddrs, now);

  // Metrics dedup still works
  expect(result.skippedCount).toBe(1);
  expect(result.skippedByFingerprintCount).toBe(1);
  expect(result.mergedCount).toBe(0);
  expect(metrics.size).toBe(0);

  // Price observation WAS extracted
  const obs = result.priceObservations.get("usdt-tether");
  expect(obs).toHaveLength(1);
  expect(obs![0].price).toBe(1.0001);
  expect(obs![0].tvl).toBe(80000);
});
```

### Step 4: Write third failing test — deduped pool with sub-threshold TVL does NOT produce observation

- [ ] Add this test to confirm the $50K TVL gate still applies:

```typescript
it("does NOT extract price observation from deduped pool with sub-threshold TVL", async () => {
  const now = 1710000000;
  const mockDb = createMockDb([{
    pool_id: "ethereum:0xknown",
    stablecoin_id: "usdt-tether",
    source: "cg_onchain",
    chain: "ethereum",
    protocol: "uniswap-v3",
    dex_id: "uniswap_v3",
    symbol: "USDT/USDC",
    tvl_usd: 30000,
    volume_24h: 5000,
    fee_tier: 5,
    balance_ratio: null,
    is_stable: 1,
    base_token: "0xbase",
    quote_token: "0xquote",
    quote_symbol: "USDC",
    price_usd: 1.0,
    locked_liq_pct: null,
    discovered_at: now - 86400 * 10,
    refreshed_at: now,
  }]);
  const metrics = new Map();
  const knownPoolAddrs = new Set(["ethereum:0xknown"]);

  const result = await mergeStagedPools(mockDb, metrics as never, knownPoolAddrs, now);

  expect(result.skippedCount).toBe(1);
  // TVL $30K × confidence 1.0 = $30K < $50K threshold — no price observation
  expect(result.priceObservations.get("usdt-tether")).toBeUndefined();
});
```

### Step 5: Run all three new tests to verify they fail

- [ ] Run: `cd worker && npx vitest run src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
- Expected: The first two new tests FAIL, the third PASSES (it's already the current behavior since dedup skips everything).

### Step 6: Implement the fix in `staging-merge.ts`

- [ ] In `worker/src/cron/dex-liquidity/staging-merge.ts`, restructure the loop body in `mergeStagedPools` (lines 173-253) to extract price observations before the dedup check.

The new loop body should be:

```typescript
  for (const row of rows) {
    const stagedPool = toStagedPool(row);
    if (!stagedPool.poolId || !stagedPool.stablecoinId) continue;

    const { dexId, poolType, qualityMultiplier } = resolveStagedPoolProfile(stagedPool);
    const fingerprint = buildPoolFingerprint(stagedPool.chain, dexId, [
      stagedPool.baseToken ?? "",
      stagedPool.quoteToken ?? "",
    ]);

    // Compute confidence and adjusted TVL early — needed for price observation gate
    const ageHours = (nowSec - stagedPool.refreshedAt) / 3600;
    const confidence = stagedPoolConfidence(ageHours);
    if (confidence === 0) continue;

    const adjustedTvl = (stagedPool.tvlUsd ?? 0) * confidence;

    // Extract price observations BEFORE dedup check.
    // DL yields pools provide pool metrics but never prices; CG/GT staged pools
    // carry priceUsd. Dedup correctly prevents double-counting TVL in dex_liquidity,
    // but price observations feed a separate table (dex_prices) via TVL-weighted
    // median that handles multiple observations gracefully.
    if (
      stagedPool.priceUsd != null &&
      stagedPool.priceUsd > 0 &&
      adjustedTvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD &&
      isPlausibleDexObservationPrice(stagedPool.stablecoinId, stagedPool.priceUsd)
    ) {
      const obs = stagedPriceObs.get(stagedPool.stablecoinId) ?? [];
      obs.push({
        price: stagedPool.priceUsd,
        tvl: adjustedTvl,
        chain: stagedPool.chain,
        protocol: `staged-${stagedPool.source}-${dexId}`,
      });
      stagedPriceObs.set(stagedPool.stablecoinId, obs);
    }

    // Dedup check — skip pool metrics merge for known pools
    const addressKnown = knownPoolAddrs.has(stagedPool.poolId);
    const fingerprintKnown = fingerprint != null && knownPoolAddrs.has(fingerprint);
    if (addressKnown || fingerprintKnown) {
      skippedCount++;
      if (addressKnown) {
        addressSkipped++;
      } else if (fingerprintKnown) {
        fingerprintSkipped++;
      }
      continue;
    }

    const adjustedVolume = (stagedPool.volume24h ?? 0) * confidence;
    const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;
    const maturityDays = stagedPoolMaturityDays(stagedPool.discoveredAt, nowSec);

    if (stagedPool.source === "cg_onchain") {
      pushPool(cgPoolMap, stagedPool.stablecoinId, {
        address,
        chain: stagedPool.chain,
        dexId,
        name: stagedPool.symbol,
        tvlUsd: adjustedTvl,
        volume24hUsd: adjustedVolume,
        qualityMultiplier,
        maturityDays,
        poolType,
        price: stagedPool.priceUsd ?? 0,
        symbol: stagedPool.symbol,
        balanceRatio: stagedPool.balanceRatio,
        lockedLiquidityPct: stagedPool.lockedLiqPct,
        feePercentage: stagedPool.feeTier ? stagedPool.feeTier / 100 : null,
      });
      continue;
    }

    pushPool(gtPoolMap, stagedPool.stablecoinId, {
      address,
      chain: stagedPool.chain,
      dexId,
      name: stagedPool.symbol,
      tvlUsd: adjustedTvl,
      volume24hUsd: adjustedVolume,
      qualityMultiplier,
      maturityDays,
      poolType,
      price: stagedPool.priceUsd ?? 0,
      symbol: stagedPool.symbol,
    });
  }
```

Key changes vs current code:
1. Moved `ageHours`, `confidence`, `adjustedTvl` computation above the dedup check
2. Moved price observation extraction above the dedup check
3. Removed the duplicate price observation block that was below the dedup check (it's now above)
4. `adjustedVolume`, `address`, `maturityDays` stay below dedup (only needed for metrics merge)

### Step 7: Run all staging-merge tests

- [ ] Run: `cd worker && npx vitest run src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
- Expected: ALL tests pass, including the three new ones and all existing ones.

### Step 8: Commit

- [ ] ```bash
git add worker/src/cron/dex-liquidity/staging-merge.ts worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
git commit -m "fix(dex-liquidity): extract price observations before dedup in mergeStagedPools

DL yields pools provide pool metrics but never prices. When CG/GT staged
pools fingerprint-match DL pools, the dedup correctly prevents double-counting
TVL in dex_liquidity but was also dropping their price observations.

Move price observation extraction above the dedup continue so that dex_prices
gets observations from all valid sources regardless of metrics dedup."
```

---

## Task 2: Fix `fetchDsFallbackPools` — extract price observations before dedup

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:78-141`
- Test: `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` (add a new describe block for the fallback, or create a new test file)

### Step 1: Implement the fix in `fetch-fallbacks.ts`

- [ ] In `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`, in the `fetchDsFallbackPools` function, restructure the inner pair loop (lines 78-143) to extract price observations before the dedup check.

The pair loop body should become:

```typescript
      for (const pair of pairs) {
        // Quality gates
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;
        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;

        // Ensure our token is the base token (not some random meme pairing)
        const baseAddr = pair.baseToken.address.toLowerCase();
        const isBase = baseAddr === contract.address.toLowerCase();
        if (!isBase) continue;

        // Parse price early — needed for price observation extraction
        const price = parseFloat(pair.priceUsd ?? "") || 0;

        // Extract price observation BEFORE dedup check.
        // DL yields pools provide pool metrics but never prices; DexScreener pairs
        // carry priceUsd. Dedup correctly prevents double-counting TVL in dex_liquidity,
        // but price observations feed dex_prices via TVL-weighted median.
        if (isPlausibleDexObservationPrice(meta.id, price) && tvl >= DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({ price, tvl, chain: contract.chain, protocol: `dexscreener-${pair.dexId}` });
          priceObs.set(meta.id, obs);
        }

        // Dedup against known pool addresses + token-pair fingerprints
        const poolKey = `${contract.chain}:${pair.pairAddress.toLowerCase()}`;
        const quoteAddr = pair.quoteToken.address.toLowerCase();
        const fpKey = buildPoolFingerprint(contract.chain, pair.dexId, [baseAddr, quoteAddr]);
        if (knownPoolAddrs.has(poolKey) || (fpKey != null && knownPoolAddrs.has(fpKey))) continue;
        knownPoolAddrs.add(poolKey);

        // Compute maturity
        let maturityDays = 0;
        if (pair.pairCreatedAt) {
          maturityDays = Math.max(0, Math.floor((nowSec - pair.pairCreatedAt / 1000) / 86400));
        }

        // Quality multiplier — use GT_DEX_QUALITY for known DEXes, generic fallback
        let qualMult = QUALITY_MULTIPLIERS["generic"]!;
        for (const [prefix, q] of GT_DEX_QUALITY) {
          if (pair.dexId.startsWith(prefix)) { qualMult = q; break; }
        }

        // Pool type inference
        let poolType = "generic";
        if (pair.labels?.includes("CLMM") || pair.labels?.includes("V3")) poolType = "concentrated";
        else if (pair.labels?.includes("StableSwap")) poolType = "stableswap";

        const symbolStr = `${pair.baseToken.symbol} / ${pair.quoteToken.symbol}`;

        const poolList = newPools.get(meta.id) ?? [];
        poolList.push({
          address: pair.pairAddress.toLowerCase(),
          chain: contract.chain,
          dexId: pair.dexId,
          name: symbolStr,
          tvlUsd: tvl,
          volume24hUsd: vol24h,
          qualityMultiplier: qualMult,
          maturityDays,
          poolType,
          price,
          symbol: symbolStr,
        });
        newPools.set(meta.id, poolList);
        poolsFound++;
      }
```

Key changes vs current code:
1. Moved `isBase` check and `price` parsing above the dedup check
2. Moved price observation extraction above the dedup check
3. Removed the duplicate price observation block that was below the dedup check
4. Pool metrics (newPools, poolsFound) stay below dedup — correctly deduplicated

### Step 2: Run existing tests + type check

- [ ] Run: `cd worker && npx vitest run && npx tsc --noEmit`
- Expected: All tests pass, no type errors. (The fetch-fallbacks function is tested indirectly through integration; no unit tests exist for it specifically.)

### Step 3: Commit

- [ ] ```bash
git add worker/src/cron/dex-liquidity/fetch-fallbacks.ts
git commit -m "fix(dex-liquidity): extract price observations before dedup in fetchDsFallbackPools

Same pattern as the staging-merge fix: DexScreener fallback pairs that
fingerprint-match existing DL/Curve/UniV3 pools were skipping price observation
extraction. Move price observation logic above the dedup continue."
```

---

## Task 3: Full build verification

**Files:** None (verification only)

### Step 1: Run full test suite

- [ ] Run: `npm test`
- Expected: All tests pass.

### Step 2: Run full build + type check

- [ ] Run: `npm run build && cd worker && npx tsc --noEmit`
- Expected: Clean build, no type errors.

### Step 3: Run lint

- [ ] Run: `npm run lint`
- Expected: No lint errors.
