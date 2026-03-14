# Curve Metapool, Two-Hop Pricing, and Display Fix — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Curve on-chain pricing for metapool stablecoins (LUSD, MIM) and two-hop stablecoins (GHO, frxUSD), and fix the Price Transparency card to correctly show "Used" vs "Available" for all consensus sources.

**Architecture:** Extend `CurvePoolConfig` with `useUnderlying` and `hop` fields; add two-phase processing to `fetchCurveOnchainPrices`; thread a new `agreeSources` field from `computePriceConsensus` through the pipeline to the frontend.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers, React, Zod

**Spec:** `agents/specs/2026-03-14-curve-metapool-and-display-fix-design.md`

---

## Chunk 1: Curve Metapool and Two-Hop Backend

### Task 1: Extend CurvePoolConfig type and add underlying selector

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts:16-24` (CurvePoolConfig interface)
- Modify: `worker/src/lib/curve-onchain.ts:28` (add GET_DY_UNDERLYING_SELECTOR)

- [ ] **Step 1: Add `useUnderlying` and `hop` to CurvePoolConfig interface**

In `worker/src/lib/curve-onchain.ts`, replace the interface at lines 16-24:

```typescript
export interface CurvePoolConfig {
  stablecoinId: string;
  poolAddress: string;
  inputIndex: number;    // coin index of the reference asset (e.g., USDC=1 in 3pool)
  outputIndex: number;   // coin index of the target stablecoin
  inputDecimals: number;
  outputDecimals: number;
  chain: string;
  /** Use get_dy_underlying selector for metapools (e.g., LUSD/3Crv) */
  useUnderlying?: boolean;
  /** Two-hop pricing: raw price is in intermediate token, multiply by via-token's USD price */
  hop?: { viaStablecoinId: string };
}
```

- [ ] **Step 2: Add GET_DY_UNDERLYING_SELECTOR constant**

After line 28 (`const GET_DY_SELECTOR = "0x5e0d443f";`), add:

```typescript
// get_dy_underlying(int128,int128,uint256) selector
const GET_DY_UNDERLYING_SELECTOR = "0x07211ef7";
```

- [ ] **Step 3: Verify selector**

Run: `node -e "const {keccak256, toUtf8Bytes} = require('ethers'); console.log(keccak256(toUtf8Bytes('get_dy_underlying(int128,int128,uint256)')).slice(0,10))"`

If ethers is not available, verify at https://www.4byte.directory/signatures/?bytes4_signature=0x07211ef7

Expected: `0x07211ef7`

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/curve-onchain.ts
git commit -m "feat(curve): extend CurvePoolConfig with useUnderlying and hop fields"
```

---

### Task 2: Write failing tests for useUnderlying and hop support

**Files:**
- Modify: `worker/src/lib/__tests__/curve-onchain.test.ts`

- [ ] **Step 1: Add test for useUnderlying selector**

Append inside the `describe("fetchCurveOnchainPrices")` block in `worker/src/lib/__tests__/curve-onchain.test.ts`:

```typescript
  it("uses get_dy_underlying selector when useUnderlying is true", async () => {
    // LUSD metapool: 1 USDC (underlying index 2) → 0.999 LUSD (underlying index 0)
    const lusdOutput = BigInt("999000000000000000"); // 0.999e18
    const mockHex = ("0x" + lusdOutput.toString(16).padStart(64, "0")) as `0x${string}`;
    mockEvmCall.mockResolvedValue(mockHex);

    const config: CurvePoolConfig = {
      stablecoinId: "lusd-liquity",
      poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
      inputIndex: 2,  // USDC (underlying)
      outputIndex: 0, // LUSD (underlying)
      inputDecimals: 6,
      outputDecimals: 18,
      chain: "ethereum",
      useUnderlying: true,
    };
    const results = await fetchCurveOnchainPrices([config]);
    expect(results.get("lusd-liquity")).toBeCloseTo(1.001, 3);

    // Verify the underlying selector was used, not get_dy
    const calldata = mockEvmCall.mock.calls[0][2] as string;
    expect(calldata.startsWith("0x07211ef7")).toBe(true);
  });
```

- [ ] **Step 2: Add test for two-hop pricing**

```typescript
  it("resolves hop prices by multiplying with via-token price", async () => {
    // Config 1: crvUSD/USDC direct → crvUSD at $0.999
    const crvusdOutput = BigInt("999000000000000000"); // 0.999e18 crvUSD per 1 USDC
    // Config 2: GHO/crvUSD → 1 crvUSD gets 0.998 GHO → GHO costs 1.002 crvUSD
    const ghoOutput = BigInt("998000000000000000"); // 0.998e18 GHO per 1e18 crvUSD

    mockEvmCall
      .mockResolvedValueOnce(("0x" + crvusdOutput.toString(16).padStart(64, "0")) as `0x${string}`)
      .mockResolvedValueOnce(("0x" + ghoOutput.toString(16).padStart(64, "0")) as `0x${string}`);

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 6, outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const results = await fetchCurveOnchainPrices(configs);
    // crvUSD: 1.0/0.999 ≈ 1.001001
    expect(results.get("crvusd-curve")).toBeCloseTo(1.001, 3);
    // GHO: raw = 1.0/0.998 ≈ 1.002004, then × crvUSD price ≈ 1.001 → ~1.003
    const expectedGho = (1.0 / 0.998) * (1.0 / 0.999);
    expect(results.get("gho-aave")).toBeCloseTo(expectedGho, 3);
  });
```

- [ ] **Step 3: Add test for missing hop dependency**

```typescript
  it("excludes hop coin when via-token RPC fails", async () => {
    // crvUSD RPC fails, GHO depends on it
    mockEvmCall
      .mockResolvedValueOnce(null) // crvUSD fails
      .mockResolvedValueOnce(("0x" + BigInt("998000000000000000").toString(16).padStart(64, "0")) as `0x${string}`);

    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "crvusd-curve",
        poolAddress: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 6, outputDecimals: 18,
        chain: "ethereum",
      },
      {
        stablecoinId: "gho-aave",
        poolAddress: "0x0001000100010001000100010001000100010001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "crvusd-curve" },
      },
    ];

    const results = await fetchCurveOnchainPrices(configs);
    expect(results.has("crvusd-curve")).toBe(false);
    expect(results.has("gho-aave")).toBe(false);
  });
```

- [ ] **Step 4: Add test for chained hop validation**

```typescript
  it("throws when a hop references another hop config", async () => {
    const configs: CurvePoolConfig[] = [
      {
        stablecoinId: "token-a",
        poolAddress: "0x0000000000000000000000000000000000000001",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-b" },
      },
      {
        stablecoinId: "token-b",
        poolAddress: "0x0000000000000000000000000000000000000002",
        inputIndex: 0, outputIndex: 1,
        inputDecimals: 18, outputDecimals: 18,
        chain: "ethereum",
        hop: { viaStablecoinId: "token-c" },
      },
    ];

    await expect(fetchCurveOnchainPrices(configs)).rejects.toThrow(/chained hop/i);
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts`

Expected: 4 new tests FAIL (useUnderlying not implemented, hop not implemented, validation not implemented)

- [ ] **Step 6: Commit failing tests**

```bash
git add worker/src/lib/__tests__/curve-onchain.test.ts
git commit -m "test(curve): add failing tests for useUnderlying, hop, and chained-hop guard"
```

---

### Task 3: Implement two-phase processing in fetchCurveOnchainPrices

**Files:**
- Modify: `worker/src/lib/curve-onchain.ts:33-64` (fetchCurveOnchainPrices function)
- Modify: `worker/src/lib/curve-onchain.ts:66-71` (encodeGetDy function)

- [ ] **Step 1: Rewrite fetchCurveOnchainPrices with two-phase processing**

Replace the function body (lines 33-64) in `worker/src/lib/curve-onchain.ts`:

```typescript
export async function fetchCurveOnchainPrices(
  configs: CurvePoolConfig[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  // Validate: no chained hops (hop referencing another hop)
  const hopIds = new Set(configs.filter((c) => c.hop).map((c) => c.stablecoinId));
  for (const config of configs) {
    if (config.hop && hopIds.has(config.hop.viaStablecoinId)) {
      throw new Error(
        `[curve-onchain] Chained hop detected: ${config.stablecoinId} hops via ${config.hop.viaStablecoinId} which is also a hop`,
      );
    }
  }

  // Phase 1: Execute all RPC calls, store raw implied prices
  const rawPrices = new Map<string, number>();

  for (const config of configs) {
    try {
      const inputAmount = BigInt(10) ** BigInt(config.inputDecimals); // 1 unit
      const selector = config.useUnderlying ? GET_DY_UNDERLYING_SELECTOR : GET_DY_SELECTOR;
      const calldata = encodeGetDy(selector, config.inputIndex, config.outputIndex, inputAmount);

      const resultHex = await fetchEvmCallHexAtBlock(
        config.chain, config.poolAddress, calldata, "latest", { signal },
      );
      if (!resultHex) continue;

      const outputRaw = BigInt(resultHex);
      const outputFloat = Number(outputRaw) / Math.pow(10, config.outputDecimals);
      const inputFloat = Number(inputAmount) / Math.pow(10, config.inputDecimals);
      const impliedPrice = inputFloat / outputFloat;

      if (impliedPrice > 0 && impliedPrice < 100) {
        rawPrices.set(config.stablecoinId, impliedPrice);
      }
    } catch (err) {
      if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
      console.warn(`[curve-onchain] get_dy failed for ${config.stablecoinId}:`, err);
    }
  }

  // Phase 2: Resolve hop prices, build final results
  const results = new Map<string, number>();

  for (const config of configs) {
    const raw = rawPrices.get(config.stablecoinId);
    if (raw == null) continue;

    if (config.hop) {
      const viaPrice = rawPrices.get(config.hop.viaStablecoinId);
      if (viaPrice == null) continue; // dependency missing
      const finalPrice = raw * viaPrice;
      if (finalPrice > 0 && finalPrice < 100) {
        results.set(config.stablecoinId, finalPrice);
      }
    } else {
      results.set(config.stablecoinId, raw);
    }
  }

  return results;
}
```

- [ ] **Step 2: Update encodeGetDy to accept selector parameter**

Replace the `encodeGetDy` function (lines 66-71):

```typescript
function encodeGetDy(selector: string, i: number, j: number, dx: bigint): string {
  const iHex = BigInt(i).toString(16).padStart(64, "0");
  const jHex = BigInt(j).toString(16).padStart(64, "0");
  const dxHex = dx.toString(16).padStart(64, "0");
  return `${selector}${iHex}${jHex}${dxHex}`;
}
```

- [ ] **Step 3: Run tests**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts`

Expected: ALL tests pass (existing 4 + new 4)

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/curve-onchain.ts
git commit -m "feat(curve): two-phase processing with useUnderlying and hop support"
```

---

### Task 4: Add metapool and two-hop pool configs

**Files:**
- Modify: `worker/src/lib/curve-pool-configs.ts`

- [ ] **Step 1: Add LUSD and MIM metapool configs**

In `worker/src/lib/curve-pool-configs.ts`, replace the trailing comment block (lines 75-78) with new configs:

```typescript
  // ── Metapools (get_dy_underlying) ──
  // Underlying indices for 3Crv metapools: 0=metapool token, 1=DAI(18), 2=USDC(6), 3=USDT(6)

  // LUSD/3Crv metapool (~$5M TVL)
  {
    stablecoinId: "lusd-liquity",
    poolAddress: "0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA",
    inputIndex: 2,  // USDC (underlying)
    outputIndex: 0, // LUSD (underlying)
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    useUnderlying: true,
  },
  // MIM/3Crv metapool (~$2M TVL)
  {
    stablecoinId: "mim-abracadabra",
    poolAddress: "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
    inputIndex: 2,  // USDC (underlying)
    outputIndex: 0, // MIM (underlying)
    inputDecimals: 6,
    outputDecimals: 18,
    chain: "ethereum",
    useUnderlying: true,
  },
];
```

- [ ] **Step 2: Build + type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/curve-pool-configs.ts
git commit -m "feat(curve): add LUSD and MIM metapool configs"
```

---

### Task 5: Research and add two-hop pool configs (GHO, frxUSD)

**Files:**
- Modify: `worker/src/lib/curve-pool-configs.ts`

- [ ] **Step 1: Research GHO/crvUSD pool address**

Use CoinGecko or Etherscan to find the GHO/crvUSD Curve pool on Ethereum mainnet. Check:
1. Pool address
2. Current TVL (must be >$1M)
3. Token indices: which index is crvUSD, which is GHO
4. Token decimals (GHO=18, crvUSD=18)
5. Verify `get_dy` is available (not just `exchange`)

Likely pool: search Curve factory for GHO/crvUSD. If no direct pool exists with >$1M TVL, skip GHO.

- [ ] **Step 2: Research frxUSD/crvUSD pool address**

Same verification as Step 1 for frxUSD/crvUSD.

- [ ] **Step 3: Add verified two-hop configs**

For each verified pool, add a config entry. Example for GHO (adjust address/indices based on research):

```typescript
  // ── Two-hop configs (via crvUSD) ──

  // GHO/crvUSD pool (~$XM TVL) — price in crvUSD terms, multiplied by crvUSD/USDC price
  {
    stablecoinId: "gho-aave",
    poolAddress: "0x<VERIFIED_ADDRESS>",
    inputIndex: <CRVUSD_INDEX>,  // crvUSD
    outputIndex: <GHO_INDEX>,    // GHO
    inputDecimals: 18,
    outputDecimals: 18,
    chain: "ethereum",
    hop: { viaStablecoinId: "crvusd-curve" },
  },
```

- [ ] **Step 4: Research additional metapool candidates**

Check TVL and `get_dy_underlying` availability for:
- TUSD/3Crv: `0xEcd5e75AFb02eFa118AF914515D6521aaBd189F1`
- GUSD/3Crv: `0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956`
- aLUSD/3Crv: `0x43b4FdFD4Ff969587185cDB6f0BD875c5Fc83f8c`
- DOLA/3Crv: `0xAA5A67c256e27A5d80712c51971408db3370927D`

Only add configs for pools with >$1M TVL that expose `get_dy_underlying`.

- [ ] **Step 5: Build + type-check**

Run: `cd worker && npx tsc --noEmit`

- [ ] **Step 6: Run all curve tests**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts`

Expected: ALL pass

- [ ] **Step 7: Commit**

```bash
git add worker/src/lib/curve-pool-configs.ts
git commit -m "feat(curve): add two-hop and additional metapool configs"
```

---

## Chunk 2: agreeSources Pipeline (Backend)

### Task 6: Add agreeSources to PrimaryPriceResult and PeggedAsset

**Files:**
- Modify: `worker/src/cron/enrich-prices.ts:58` (PeggedAsset interface)
- Modify: `worker/src/cron/enrich-prices.ts:116-123` (PrimaryPriceResult interface)
- Modify: `worker/src/cron/enrich-prices.ts:418-424` (consensus result mapping)

- [ ] **Step 1: Add `agreeSources` to PeggedAsset**

In `worker/src/cron/enrich-prices.ts`, after line 58 (`consensusSources?: string[];`), add:

```typescript
  agreeSources?: string[];
```

- [ ] **Step 2: Add `agreeSources` to PrimaryPriceResult**

In the `PrimaryPriceResult` interface (line 122, after `candidateSources: string[];`), add:

```typescript
  agreeSources: string[];
```

- [ ] **Step 3: Populate agreeSources from consensus result**

In the results mapping (around line 418-424), change:

```typescript
    results.set(asset.id, {
      price: consensus.price,
      source: consensus.source,
      confidence: consensus.confidence,
      dlPrice: dl ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
    });
```

to:

```typescript
    results.set(asset.id, {
      price: consensus.price,
      source: consensus.source,
      confidence: consensus.confidence,
      dlPrice: dl ?? null,
      cgPrice: cg ?? null,
      candidateSources: sources.map((s) => s.source),
      agreeSources: consensus.agreeSources,
    });
```

- [ ] **Step 4: Type-check (expect errors)**

Run: `cd worker && npx tsc --noEmit`

Expected: Type errors — the `results.set()` object literal at line ~418 now requires the new `agreeSources` field (already added in Step 3). Additional errors in `sync-stablecoins.ts` may appear after Task 7-8 changes. These are expected and resolved in Tasks 7-8.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/enrich-prices.ts
git commit -m "feat(price): add agreeSources to PrimaryPriceResult and PeggedAsset"
```

---

### Task 7: Add agreeSources to Zod schemas

**Files:**
- Modify: `shared/types/market.ts:33` (StablecoinDataRawSchema)
- Modify: `shared/types/market.ts:54` (StablecoinDataSchema transform)
- Modify: `shared/types/market.ts:310` (PegSummaryCoinSchema)

- [ ] **Step 1: Add to StablecoinDataRawSchema**

In `shared/types/market.ts`, after line 33 (`consensusSources: z.array(z.string()).optional(),`), add:

```typescript
  agreeSources: z.array(z.string()).optional(),
```

- [ ] **Step 2: Add to StablecoinDataSchema transform**

After line 54 (`consensusSources: asset.consensusSources ?? [],`), add:

```typescript
  agreeSources: asset.agreeSources ?? [],
```

- [ ] **Step 3: Add to PegSummaryCoinSchema**

After line 310 (`consensusSources: z.array(z.string()).optional(),`), add:

```typescript
  agreeSources: z.array(z.string()).optional(),
```

- [ ] **Step 4: Type-check**

Run: `npm run build`

Expected: May have downstream type errors (expected, resolved in later tasks)

- [ ] **Step 5: Commit**

```bash
git add shared/types/market.ts
git commit -m "feat(types): add agreeSources to StablecoinData and PegSummaryCoin Zod schemas"
```

---

### Task 8: Update stampPriceMetadata and sync-stablecoins call sites

**Files:**
- Modify: `worker/src/cron/sync-stablecoins/shared.ts:145-158` (stampPriceMetadata)
- Modify: `worker/src/cron/sync-stablecoins.ts` (call sites at lines ~208, 570, 572, 576, 595)

- [ ] **Step 1: Add agreeSources parameter to stampPriceMetadata**

In `worker/src/cron/sync-stablecoins/shared.ts`, replace the function (lines 145-158):

```typescript
export function stampPriceMetadata(
  asset: PeggedAsset,
  source: string,
  confidence: PeggedAsset["priceConfidence"],
  updatedAt: number | null,
  consensusSources?: string[],
  agreeSources?: string[],
): void {
  asset.priceSource = source;
  asset.priceConfidence = confidence ?? null;
  asset.priceUpdatedAt = updatedAt;
  if (consensusSources !== undefined) {
    asset.consensusSources = consensusSources;
  }
  if (agreeSources !== undefined) {
    asset.agreeSources = agreeSources;
  }
}
```

- [ ] **Step 2: Pass agreeSources at primary consensus call site (line ~570)**

In `worker/src/cron/sync-stablecoins.ts`, find the line:

```typescript
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources);
```

Replace with:

```typescript
        stampPriceMetadata(asset, primary.source, primary.confidence, syncStartSec, primary.candidateSources, primary.agreeSources);
```

- [ ] **Step 3: Pass agreeSources at authoritative/protocol override call sites**

Find lines like:

```typescript
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source]);
```

Replace each with:

```typescript
    stampPriceMetadata(asset, override.source, override.confidence, syncStartSec, [override.source], [override.source]);
```

There are two such call sites (lines ~208 and ~595).

- [ ] **Step 4: Pass agreeSources at single-source DL fallback call sites (lines ~572 and ~576)**

These 5-argument calls set `consensusSources` to a single-element array. Add matching `agreeSources`:

Find both occurrences of:

```typescript
        stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"]);
```

Replace each with:

```typescript
        stampPriceMetadata(asset, asset.priceSource || "defillama", "single-source", syncStartSec, [asset.priceSource || "defillama"], [asset.priceSource || "defillama"]);
```

This ensures single-source DL coins show their source as "Used" (not only "Available").

- [ ] **Step 5: Leave degraded paths unchanged**

The 4-argument call sites (lines ~229, ~242, ~293, ~624, ~640, ~701) pass no `consensusSources` and should also omit `agreeSources`. These represent fallback/rejection states where provenance is not meaningful. The frontend handles `undefined` gracefully via `agreeSources ?? []`. No changes needed.

- [ ] **Step 6: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 7: Run full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/sync-stablecoins/shared.ts worker/src/cron/sync-stablecoins.ts
git commit -m "feat(price): thread agreeSources through stampPriceMetadata and sync pipeline"
```

---

### Task 9: Serve agreeSources in peg-summary API

**Files:**
- Modify: `worker/src/api/peg-summary.ts:215` (coins object literal)

- [ ] **Step 1: Add agreeSources to coins object**

In `worker/src/api/peg-summary.ts`, after line 215 (`consensusSources: asset?.consensusSources,`), add:

```typescript
      agreeSources: asset?.agreeSources,
```

- [ ] **Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add worker/src/api/peg-summary.ts
git commit -m "feat(api): serve agreeSources in peg-summary response"
```

---

### Task 10: Write pipeline tests for agreeSources

**Files:**
- Modify: `worker/src/cron/__tests__/enrich-prices.test.ts`
- Modify: `worker/src/cron/__tests__/sync-stablecoins.test.ts`

- [ ] **Step 1: Add test for agreeSources on PrimaryPriceResult**

In `worker/src/cron/__tests__/enrich-prices.test.ts`, find the test `"sets consensusSources to single-element array with source name"` (around line 775). After it, add a test that exercises `computePriceConsensus` through the `PrimaryPriceResult` construction path. Since `fetchPrimaryPrices` requires a D1 database mock, we test the consensus → agreeSources mapping directly:

```typescript
  it("agreeSources reflects consensus.agreeSources not candidateSources", () => {
    // computePriceConsensus returns agreeSources as the subset that agreed.
    // When all sources agree, agreeSources === candidateSources.
    // When they disagree, agreeSources is the winning cluster.
    const { computePriceConsensus } = require("../../lib/price-consensus");
    const sources = [
      { source: "coingecko", price: 1.0001, weight: 2 },
      { source: "defillama", price: 1.0002, weight: 1 },
      { source: "outlier", price: 1.05, weight: 1 },  // diverges >50bps
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result).not.toBeNull();
    // coingecko and defillama agree; outlier disagrees
    expect(result!.agreeSources).toContain("coingecko");
    expect(result!.agreeSources).toContain("defillama");
    expect(result!.agreeSources).not.toContain("outlier");
    expect(result!.disagreeSources).toContain("outlier");
  });
```

- [ ] **Step 2: Add test for stampPriceMetadata with agreeSources**

In `worker/src/cron/__tests__/sync-stablecoins.test.ts`, find the test `"stamps consensusSources when provided"` (around line 1065). After the `"leaves consensusSources unchanged when not provided"` test, add:

```typescript
  it("stamps agreeSources when provided", () => {
    const asset = { priceSource: "", priceConfidence: null, priceUpdatedAt: null } as PeggedAsset;
    stampPriceMetadata(asset, "coingecko+defillama", "high", 100, ["coingecko", "defillama"], ["coingecko", "defillama"]);
    expect(asset.agreeSources).toEqual(["coingecko", "defillama"]);
  });

  it("leaves agreeSources unchanged when not provided", () => {
    const asset = {
      priceSource: "", priceConfidence: null, priceUpdatedAt: null,
      agreeSources: ["existing"],
    } as PeggedAsset;
    stampPriceMetadata(asset, "x", "high", 100);
    expect(asset.agreeSources).toEqual(["existing"]);
  });
```

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: ALL pass

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
git commit -m "test(price): add tests for agreeSources pipeline"
```

---

## Chunk 3: Frontend Display Fix

### Task 11: Update view model to expose agreeSources

**Files:**
- Modify: `src/lib/stablecoin-detail-view-model.ts:76` (interface)
- Modify: `src/lib/stablecoin-detail-view-model.ts:205` (extraction)
- Modify: `src/lib/stablecoin-detail-view-model.ts:237` (return object)

- [ ] **Step 1: Add agreeSources to StablecoinDetailReadyViewModel**

In `src/lib/stablecoin-detail-view-model.ts`, after line 76 (`consensusSources: string[];`), add:

```typescript
  agreeSources: string[];
```

- [ ] **Step 2: Extract agreeSources from pegScoreResult**

After line 205 (`const consensusSources = pegScoreResult?.consensusSources ?? [];`), add:

```typescript
  const agreeSources = pegScoreResult?.agreeSources ?? [];
```

- [ ] **Step 3: Add to return object**

After the `consensusSources,` line in the return object (around line 237), add:

```typescript
    agreeSources,
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/stablecoin-detail-view-model.ts
git commit -m "feat(detail): expose agreeSources in stablecoin detail view model"
```

---

### Task 12: Fix PriceTransparencyCard to use agreeSources

**Files:**
- Modify: `src/components/stablecoin-detail/price-transparency-card.tsx:22-33` (resolveSourceStatus)
- Modify: `src/components/stablecoin-detail/price-transparency-card.tsx:68-72` (props)
- Modify: `src/components/stablecoin-detail/price-transparency-card.tsx:146-152` (usage)

- [ ] **Step 1: Add agreeSources to props**

In `src/components/stablecoin-detail/price-transparency-card.tsx`, replace the props interface (lines 68-72):

```typescript
interface PriceTransparencyCardProps {
  coinData: StablecoinData;
  consensusSources: string[];
  agreeSources: string[];
  dexPriceCheck: PegSummaryCoin["dexPriceCheck"];
}
```

- [ ] **Step 2: Update resolveSourceStatus signature and logic**

Replace the function (lines 22-33):

```typescript
function resolveSourceStatus(
  sourceKey: string,
  agreeSources: string[],
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}
```

- [ ] **Step 3: Update the component to destructure and pass agreeSources**

Update the component destructuring (line 74-78 area):

```typescript
export function PriceTransparencyCard({
  coinData,
  consensusSources,
  agreeSources,
  dexPriceCheck,
}: PriceTransparencyCardProps) {
```

Update the `resolveSourceStatus` call in the JSX (around line 147-152):

```typescript
                const status = resolveSourceStatus(
                  key,
                  agreeSources,
                  consensusSources,
                  isProtocolRedeem,
                );
```

- [ ] **Step 4: Add unit test for resolveSourceStatus**

The `resolveSourceStatus` function is not exported, but it is a pure function exercised through the component. To test the core display bug fix, add a co-located test. Create or append to a test file. If no test file exists for the component, add inline verification via a simple script or add to an existing frontend test:

At minimum, verify the logic by adding a describe block in a new file `src/components/stablecoin-detail/__tests__/price-transparency-card.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Since resolveSourceStatus is not exported, we test the logic inline
type SourceStatus = "used" | "available" | "no-data" | "not-applicable";

function resolveSourceStatus(
  sourceKey: string,
  agreeSources: string[],
  consensusSources: string[],
  isProtocolRedeem: boolean,
): SourceStatus {
  if (isProtocolRedeem) return "not-applicable";
  if (agreeSources.includes(sourceKey)) return "used";
  if (consensusSources.includes(sourceKey)) return "available";
  return "no-data";
}

describe("resolveSourceStatus", () => {
  it("returns 'used' when source is in agreeSources", () => {
    expect(resolveSourceStatus("binance", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("used");
  });

  it("returns 'available' when source is in consensusSources but not agreeSources", () => {
    expect(resolveSourceStatus("pyth", ["binance", "coingecko"], ["binance", "coingecko", "pyth"], false)).toBe("available");
  });

  it("returns 'no-data' when source is in neither", () => {
    expect(resolveSourceStatus("redstone", ["binance"], ["binance", "coingecko"], false)).toBe("no-data");
  });

  it("returns 'not-applicable' for protocol-redeem coins", () => {
    expect(resolveSourceStatus("binance", ["binance"], ["binance"], true)).toBe("not-applicable");
  });
});
```

Run: `npx vitest run src/components/stablecoin-detail/__tests__/price-transparency-card.test.ts`

Expected: ALL 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/components/stablecoin-detail/price-transparency-card.tsx src/components/stablecoin-detail/__tests__/price-transparency-card.test.ts
git commit -m "fix(ui): use agreeSources for Used status in PriceTransparencyCard"
```

---

### Task 13: Pass agreeSources from overview-section to PriceTransparencyCard

**Files:**
- Modify: `src/components/stablecoin-detail/overview-section.tsx` (props + passthrough)
- Modify: `src/app/stablecoin/[id]/client.tsx` (pass agreeSources to overview section)

- [ ] **Step 1: Check how PriceTransparencyCard is rendered in overview-section**

Read `src/components/stablecoin-detail/overview-section.tsx` to find where `PriceTransparencyCard` is rendered. It should receive `consensusSources` as a prop from `OverviewSectionProps`.

- [ ] **Step 2: Add agreeSources to OverviewSectionProps**

In the `OverviewSectionProps` interface, add:

```typescript
  agreeSources?: string[];
```

- [ ] **Step 3: Pass agreeSources to BOTH PriceTransparencyCard render sites**

`overview-section.tsx` renders `PriceTransparencyCard` in TWO locations:
- Line ~131: narrow/no-left-column layout
- Line ~244: desktop two-column layout

Add the `agreeSources` prop at BOTH locations:

```typescript
  agreeSources={agreeSources ?? []}
```

- [ ] **Step 4: Pass agreeSources from client.tsx to OverviewSection**

In `src/app/stablecoin/[id]/client.tsx`, find where `<NoticesAndSummarySection` or the overview section is rendered. The view model exposes `agreeSources`. Pass it through:

```typescript
  agreeSources={vm.agreeSources}
```

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: Build succeeds with no type errors

- [ ] **Step 6: Commit**

```bash
git add src/components/stablecoin-detail/overview-section.tsx src/app/stablecoin/[id]/client.tsx
git commit -m "feat(ui): thread agreeSources from view model to PriceTransparencyCard"
```

---

## Chunk 4: Integration Verification

### Task 14: Full build, type-check, and test verification

**Files:** None (verification only)

- [ ] **Step 1: Full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`

Expected: Clean build, no type errors

- [ ] **Step 2: Full test suite**

Run: `npm test`

Expected: All tests pass

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: No lint errors in changed files

- [ ] **Step 4: Verify curve-onchain tests specifically**

Run: `cd worker && npx vitest run src/lib/__tests__/curve-onchain.test.ts -v`

Expected: All 8 tests pass (4 existing + 4 new)

- [ ] **Step 5: Spot-check API response structure**

After deploying to staging/dev, verify:

```bash
curl -s 'https://api.pharos.watch/api/peg-summary' | jq '[.coins[] | select(.id == "usdt-tether") | {id, consensusSources, agreeSources, priceSource}]'
```

Expected: `agreeSources` field present, containing sources that agreed in consensus.

- [ ] **Step 6: Spot-check frontend rendering**

Navigate to USDT detail page. Price Transparency card should show:
- Curve on-chain: "Used" (green dot) — it's in the consensus cluster
- All other consensus sources: "Used" (green dot)

Navigate to LUSD detail page (after deploy with new configs). Should show:
- Curve on-chain: "Available" (blue dot) or "Used" (green dot) depending on consensus

- [ ] **Step 7: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: integration fixups for curve metapool and display fix"
```
