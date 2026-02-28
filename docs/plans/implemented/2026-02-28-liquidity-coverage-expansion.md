# Liquidity Coverage Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce zero-score tracked stablecoins from ~25 to ~8-10 by fixing symbol matching, expanding chain coverage, and adding DexScreener as a universal fallback.

**Architecture:** Three changes to the existing `syncDexLiquidity()` pipeline: (1) auto-seed `addressToId` from all contracts instead of 2 hard-coded entries, (2) add Solana/Berachain/Sui to CG/GT chain maps, (3) add DexScreener token API as step 5c for coins still at zero pools after the main pipeline.

**Tech Stack:** TypeScript, Cloudflare Workers, DexScreener REST API, Vitest

---

### Task 1: Auto-Seed Address Map from All Contracts

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts:659-681`

**Step 1: Replace the hard-coded address seed in `buildSymbolLookups()`**

In `worker/src/cron/sync-dex-liquidity.ts`, replace lines 674-678:

```typescript
  // Seed with known addresses for colliding symbols (e.g. reUSD vs REUSD)
  const addressToId = new Map<string, string>([
    ["0x5086bf358635b81d8c47c66d1c8b9e567db70c72", "339"], // Re Protocol reUSD
    ["0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a", "256"], // Resupply REUSD
  ]);
```

With:

```typescript
  // Auto-seed from all contract addresses — resolves symbol collisions automatically
  const addressToId = new Map<string, string>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const c of meta.contracts) {
      addressToId.set(c.address.toLowerCase(), meta.id);
    }
  }
```

**Step 2: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS (no type errors)

**Step 3: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "fix(dex-liquidity): auto-seed addressToId from all contracts

Replaces 2 hard-coded address entries with automatic seeding from every
contract in TRACKED_STABLECOINS. Resolves symbol collisions (CUSD, GUSD,
USDM, REUSD) without manual maintenance."
```

---

### Task 2: Expand CG/GT Chain Maps

**Files:**
- Modify: `worker/src/lib/coingecko-onchain.ts:14-27`
- Modify: `worker/src/cron/sync-dex-liquidity.ts:83-94`

**Step 1: Add Solana, Berachain, Sui to `CG_CHAIN_MAP`**

In `worker/src/lib/coingecko-onchain.ts`, add three entries to `CG_CHAIN_MAP` (after `ink: "ink"`):

```typescript
export const CG_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  bsc: "bsc",
  avalanche: "avax",
  optimism: "optimism",
  celo: "celo",
  gnosis: "xdai",
  fantom: "ftm",
  tron: "tron",
  ink: "ink",
  solana: "solana",
  berachain: "berachain",
  sui: "sui-network",
};
```

**Step 2: Add the same chains to `GT_CHAIN_MAP`**

In `worker/src/cron/sync-dex-liquidity.ts`, add three entries to `GT_CHAIN_MAP` (after `fantom: "ftm"`):

```typescript
const GT_CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  bsc: "bsc",
  avalanche: "avax",
  optimism: "optimism",
  celo: "celo",
  gnosis: "xdai",
  fantom: "ftm",
  solana: "solana",
  berachain: "berachain",
  sui: "sui-network",
};
```

**Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add worker/src/lib/coingecko-onchain.ts worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(dex-liquidity): add Solana, Berachain, Sui to CG/GT chain maps

Enables pool discovery on three new chains via existing CoinGecko/
GeckoTerminal pipeline. Expected to pick up YLDS (Raydium), NECT
(Kodiak), USDGO (Orca), ISC, EURR pools."
```

---

### Task 3: Create DexScreener API Wrapper

**Files:**
- Create: `worker/src/lib/dexscreener.ts`

**Step 1: Write the DexScreener module**

Create `worker/src/lib/dexscreener.ts`:

```typescript
/**
 * DexScreener token pools API wrapper.
 * Used as a universal fallback for pool discovery on chains not covered
 * by the main CG/GT/Curve/UniV3 pipeline.
 */
import { fetchWithRetry } from "./fetch-retry";
import { USER_AGENT } from "./constants";

const DS_TOKEN_API = "https://api.dexscreener.com/tokens/v1";
const DS_RATE_LIMIT_MS = 1100; // ~60 req/min free tier

/** Map our chain names → DexScreener chain IDs */
export const DS_CHAIN_MAP: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  polygon: "polygon",
  bsc: "bsc",
  avalanche: "avalanche",
  optimism: "optimism",
  solana: "solana",
  berachain: "berachain",
  sui: "sui",
  fantom: "fantom",
  celo: "celo",
  gnosis: "gnosis",
  tron: "tron",
  ink: "ink",
  // Exotic chains — DexScreener accepts these IDs
  sonic: "sonic",
  mantle: "mantle",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  zksync: "zksync",
  mode: "mode",
  sei: "sei",
  manta: "manta",
  monad: "monad",
  plume: "plume",
  hyperevm: "hyperevm",
  bob: "bob",
  unichain: "unichain",
  soneium: "soneium",
  worldchain: "worldchain",
  taiko: "taiko",
};

/** Response shape from GET /tokens/v1/{chainId}/{address} */
export interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string | null;
  volume: { h24: number; h6: number; h1: number; m5: number } | null;
  liquidity: { usd: number; base: number; quote: number } | null;
  pairCreatedAt: number | null;
}

/**
 * Fetch all pools for a token on a specific chain from DexScreener.
 * Returns an array of pairs, or empty if the request fails.
 */
export async function fetchDsTokenPools(
  chain: string,
  tokenAddress: string,
): Promise<DsPair[]> {
  const dsChain = DS_CHAIN_MAP[chain];
  if (!dsChain) return [];

  const url = `${DS_TOKEN_API}/${dsChain}/${tokenAddress}`;
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res?.ok) return [];

  try {
    const data = (await res.json()) as DsPair[] | null;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Rate-limit sleep between DexScreener calls */
export function dsRateLimit(): Promise<void> {
  return new Promise((r) => setTimeout(r, DS_RATE_LIMIT_MS));
}
```

**Step 2: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add worker/src/lib/dexscreener.ts
git commit -m "feat(dex-liquidity): add DexScreener API wrapper module

Thin wrapper for /tokens/v1 endpoint with chain mapping for 30+ chains,
rate limiting (60 req/min), and typed response interface."
```

---

### Task 4: Integrate DexScreener Fallback into Sync Pipeline

**Files:**
- Modify: `worker/src/cron/sync-dex-liquidity.ts`

This is the main integration task. Add a new step 5c between pool merging and score computation.

**Step 1: Add import for DexScreener module**

At the top of `sync-dex-liquidity.ts`, after the existing imports (line ~11):

```typescript
import { fetchDsTokenPools, dsRateLimit, DS_CHAIN_MAP } from "../lib/dexscreener";
```

**Step 2: Write the `fetchDsFallbackPools` function**

Add before `syncDexLiquidity()` (around line 2360):

```typescript
/** DexScreener fallback: fetch pools for tracked stablecoins with 0 pools in the main pipeline. */
async function fetchDsFallbackPools(
  metrics: Map<string, LiquidityMetrics>,
  knownPoolAddrs: Set<string>,
): Promise<{ newPools: Map<string, GtNewPool[]>; priceObs: Map<string, DexPriceObs[]> }> {
  const newPools = new Map<string, GtNewPool[]>();
  const priceObs = new Map<string, DexPriceObs[]>();
  const nowSec = Date.now() / 1000;

  // Find tracked coins with no pools from the main pipeline
  const zeroCoinIds = new Set<string>();
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts?.length) continue;
    const m = metrics.get(meta.id);
    if (!m || m.poolCount === 0) zeroCoinIds.add(meta.id);
  }

  if (zeroCoinIds.size === 0) {
    console.log("[dex-liquidity] DexScreener fallback: no zero-pool coins, skipping");
    return { newPools, priceObs };
  }

  console.log(`[dex-liquidity] DexScreener fallback: querying ${zeroCoinIds.size} zero-pool coins`);

  let requests = 0;
  let poolsFound = 0;

  for (const meta of TRACKED_STABLECOINS) {
    if (!zeroCoinIds.has(meta.id)) continue;
    if (!meta.contracts?.length) continue;

    for (const contract of meta.contracts) {
      if (!DS_CHAIN_MAP[contract.chain]) continue;

      if (requests > 0) await dsRateLimit();
      requests++;

      const pairs = await fetchDsTokenPools(contract.chain, contract.address);
      if (pairs.length === 0) continue;

      for (const pair of pairs) {
        // Quality gates
        const tvl = pair.liquidity?.usd ?? 0;
        if (tvl < 1_000) continue;
        const vol24h = pair.volume?.h24 ?? 0;
        if (vol24h === 0 && tvl < 10_000) continue;

        // Dedup against known pool addresses
        const poolKey = `${pair.chainId}:${pair.pairAddress.toLowerCase()}`;
        if (knownPoolAddrs.has(poolKey)) continue;
        knownPoolAddrs.add(poolKey);

        // Ensure our token is the base token (not some random meme pairing)
        const isBase = pair.baseToken.address.toLowerCase() === contract.address.toLowerCase();
        if (!isBase) continue;

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
          symbol: symbolStr,
        });
        newPools.set(meta.id, poolList);
        poolsFound++;

        // Price observation
        const price = parseFloat(pair.priceUsd ?? "");
        if (price > 0 && price >= 0.5 && price <= 2.0 && tvl >= 10_000) {
          const obs = priceObs.get(meta.id) ?? [];
          obs.push({ price, tvl, chain: contract.chain, protocol: `dexscreener-${pair.dexId}` });
          priceObs.set(meta.id, obs);
        }
      }
    }
  }

  console.log(
    `[dex-liquidity] DexScreener fallback: ${requests} requests, ${poolsFound} pools found for ${newPools.size} coins`
  );
  return { newPools, priceObs };
}
```

**Step 3: Wire the fallback into `syncDexLiquidity()`**

In `syncDexLiquidity()`, after step 5b (the `mergeGtPools`/`mergeCgPools` block at ~line 2474), add:

```typescript
  // 5c. DexScreener fallback for coins still at zero pools
  try {
    const dsFallback = await fetchDsFallbackPools(metrics, knownPoolAddrs);
    // Merge DS pools using the same logic as GT pools
    mergeGtPools(metrics, dsFallback.newPools);
    // Merge price observations
    for (const [id, obs] of dsFallback.priceObs) {
      const existing = priceObservations.get(id) ?? [];
      existing.push(...obs);
      priceObservations.set(id, existing);
    }
  } catch (err) {
    console.warn("[dex-liquidity] DexScreener fallback failed (non-fatal):", err);
  }
```

**Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add worker/src/cron/sync-dex-liquidity.ts
git commit -m "feat(dex-liquidity): integrate DexScreener fallback for zero-pool coins

After the main CG/GT pipeline, queries DexScreener for any tracked coin
still at 0 pools. Covers 30+ chains including Solana, Berachain, Monad,
MegaETH, Plume. Deduplicates against known pools, applies quality gates
(min $1K TVL), and feeds price observations into cross-validation."
```

---

### Task 5: Coverage Regression Test

**Files:**
- Create: `src/lib/__tests__/liquidity-coverage.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "../stablecoins";
import { CG_CHAIN_MAP } from "../../../worker/src/lib/coingecko-onchain";
import { DS_CHAIN_MAP } from "../../../worker/src/lib/dexscreener";

/** Chains that have no standard DEX infrastructure — intentionally unsupported */
const UNSUPPORTED_CHAINS = new Set([
  "algorand", "aptos", "astar", "aurora", "bittorrent", "boba",
  "cardano", "fraxtal", "hedera", "hydration", "icp", "kava",
  "klaytn", "mantra", "metis", "moonbeam", "moonriver", "morph-l2",
  "near", "noble", "osmosis", "plasma", "polkadot", "polygon-zkevm",
  "starknet", "stellar", "swellchain", "tezos", "ton", "viction",
  "xdc", "xlayer", "xrpl", "zircuit", "bitlayer", "apechain",
]);

describe("liquidity coverage", () => {
  it("every contract chain is mapped in CG, DS, or explicitly unsupported", () => {
    const unmapped: string[] = [];
    const allChains = new Set<string>();
    for (const meta of TRACKED_STABLECOINS) {
      for (const c of meta.contracts ?? []) {
        allChains.add(c.chain);
      }
    }
    for (const chain of allChains) {
      if (!CG_CHAIN_MAP[chain] && !DS_CHAIN_MAP[chain] && !UNSUPPORTED_CHAINS.has(chain)) {
        unmapped.push(chain);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("all colliding symbols have contracts for address-based disambiguation", () => {
    // Build symbol → ids map
    const symbolToIds = new Map<string, string[]>();
    for (const meta of TRACKED_STABLECOINS) {
      const key = meta.symbol.toUpperCase();
      const ids = symbolToIds.get(key) ?? [];
      ids.push(meta.id);
      symbolToIds.set(key, ids);
    }

    const missing: string[] = [];
    for (const [symbol, ids] of symbolToIds) {
      if (ids.length <= 1) continue;
      // For colliding symbols, every coin must have at least one contract
      for (const id of ids) {
        const meta = TRACKED_STABLECOINS.find((m) => m.id === id);
        if (!meta?.contracts?.length) {
          missing.push(`${symbol} (id=${id}) has no contracts for disambiguation`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
```

**Step 2: Run test**

Run: `npm test -- src/lib/__tests__/liquidity-coverage.test.ts`
Expected: Both tests PASS. If the second test fails, it identifies coins with colliding symbols that lack contracts — those are known gaps (e.g., gold/silver coins) and the test may need the assertion adjusted.

**Step 3: Fix any failures**

If the colliding-symbols test fails for specific coins that genuinely have no contracts (commodity tokens), add those specific IDs to an allowlist in the test.

**Step 4: Commit**

```bash
git add src/lib/__tests__/liquidity-coverage.test.ts
git commit -m "test: add liquidity coverage regression tests

Verifies all contract chains are mapped in CG/DS/unsupported, and all
colliding symbols have contracts for address-based disambiguation."
```

---

### Task 6: Update Documentation & About Page

**Files:**
- Modify: `src/app/about/page.tsx:14`
- Modify: `docs/dex-liquidity.md:16,56`

**Step 1: Update about page DEX Data sources**

In `src/app/about/page.tsx` line 14, add DexScreener:

```typescript
  { label: "DEX Data", sources: "DeFiLlama Yields & Protocols, Curve Finance API, The Graph, GeckoTerminal, DexScreener" },
```

**Step 2: Update docs/dex-liquidity.md**

In the data sources line (line 16), update:

```
Data sources: DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure) + Uniswap V3 Subgraph (4 chains) + Aerodrome Subgraph (Base) + CoinGecko Onchain API (15 chains, with GeckoTerminal free API as fallback when no CG API key is configured) + DexScreener token API (30+ chains, fallback for coins with zero pools from primary sources).
```

In the CoinGecko table (line 56), update chain coverage:

```
| Chain coverage | 13 chains | 15 chains (adds tron, ink, solana, berachain, sui) |
```

Add a new section after the CoinGecko Integration section (after line 66):

```markdown
### DexScreener Fallback

After the primary pipeline (DeFiLlama + CG/GT + Curve + UniV3 + Aerodrome), any tracked stablecoin with zero pools is queried via DexScreener's `/tokens/v1/{chainId}/{address}` endpoint. This covers 30+ chains including Solana, Berachain, Monad, MegaETH, Plume, and other exotic chains.

Quality gates:
- Pool TVL must exceed $1,000
- Pool must have 24h volume > 0 or TVL > $10,000
- Only pools where our token is the base token are counted
- Pools already discovered by the primary pipeline are deduplicated by `chainId:pairAddress`
- Generic quality multiplier (0.3x) unless the DEX ID matches a known protocol (same `GT_DEX_QUALITY` lookup)

DexScreener pools are merged using the same `mergeGtPools()` logic — no balance ratio data, neutral organic fraction default (0.5).
```

**Step 3: Run frontend build to catch any issues**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/about/page.tsx docs/dex-liquidity.md
git commit -m "docs: update dex-liquidity docs and about page for new sources

Adds DexScreener to DEX Data sources, updates chain coverage numbers,
documents DexScreener fallback behavior and quality gates."
```

---

### Task 7: Full Build Verification

**Step 1: Run full lint**

Run: `npm run lint`
Expected: PASS (no new errors)

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 3: Run frontend build**

Run: `npm run build`
Expected: PASS

**Step 4: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: PASS
