# Yield Intelligence Remediation & Expansion — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all code quality issues and expand yield coverage through on-chain rate configs, lending protocol additions, rate-derived expansion, and test coverage.

**Architecture:** Additive changes to static config maps + targeted code fixes + new test cases. No schema changes, no new API endpoints, no UI changes. All modifications are in the worker cron layer and shared types.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers D1, EVM RPC (`eth_call`).

**Spec:** `agents/specs/2026-03-15-yield-remediation-expansion-design.md`

---

## Chunk 1: Code Quality Fixes

### Task 1: Remove duplicate TRACKED_META_BY_ID in resolve.ts

**Files:**
- Modify: `worker/src/cron/yield-sync/resolve.ts:1,33-35`

- [ ] **Step 1: Read the file and verify the duplicate**

Run: `head -35 worker/src/cron/yield-sync/resolve.ts`
Confirm line 1 imports `TRACKED_STABLECOINS` and lines 33-35 build a local `TRACKED_META_BY_ID`.

- [ ] **Step 2: Check if TRACKED_STABLECOINS is used elsewhere in the file**

Run: `grep -n 'TRACKED_STABLECOINS' worker/src/cron/yield-sync/resolve.ts`
Expected: line 1 (import) AND line 313 (`lendingCandidates` filter). Both imports are needed.

- [ ] **Step 3: Add TRACKED_META_BY_ID import and remove local Map**

Change line 1 from:
```typescript
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
```
to:
```typescript
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
```

Remove lines 33-35 (the local duplicate):
```typescript
const TRACKED_META_BY_ID = new Map(
  TRACKED_STABLECOINS.map((stablecoin) => [stablecoin.id, stablecoin]),
);
```

Note: `TRACKED_STABLECOINS` must remain because it's used at line 313 for the `lendingCandidates` filter (array iteration). `TRACKED_META_BY_ID` replaces only the local Map that duplicated the shared export.

- [ ] **Step 4: Verify the file still type-checks**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run existing tests**

Run: `npm test -- --run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/yield-sync/resolve.ts
git commit -m "refactor: import TRACKED_META_BY_ID instead of rebuilding locally"
```

---

### Task 2: Fix stale YIELD_POOL_MAP gate comment

**Files:**
- Modify: `worker/src/cron/yield-config.ts:181-182`

- [ ] **Step 1: Count the actual YIELD_POOL_MAP entries**

Run: `grep -c '"[a-z]' worker/src/cron/yield-config.ts` or count manually in the map.

- [ ] **Step 2: Update lines 181-182 of the JSDoc comment**

The JSDoc block at lines 179-189 is multi-line. Only replace lines 181-182 (the stale GATE count and the "Empty string" note). Leave the surrounding `/**`, line 180 (purpose line), and lines 183-189 (selection criteria) unchanged.

Change lines 181-182 from:
```typescript
 * GATE: 21/24 coins matched (threshold: >=15/24).
 * Empty string = no DL pool found (comment explains why).
```
to:
```typescript
 * Entries below are curated; count grows as new yield-bearing coins are added.
 * Commented-out IDs = no DL pool found (comment explains why).
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "fix: update stale YIELD_POOL_MAP gate comment"
```

---

### Task 3: Extract LEGACY_MAX_AGE_SEC magic number

**Files:**
- Modify: `worker/src/cron/sync-yield-data.ts:41-45,311`

- [ ] **Step 1: Add the named constant alongside existing timing constants**

After line 45 (`const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;`), add:
```typescript
/** 30-day history window + 5-day buffer for legacy source-unaware rows. */
const LEGACY_HISTORY_MAX_AGE_SEC = SECONDS.THIRTY_DAYS + 5 * SECONDS.ONE_DAY;
```

- [ ] **Step 2: Replace the inline magic number**

Replace lines 311-312:
```typescript
  const LEGACY_MAX_AGE_SEC = 35 * 86400; // 30d window + 5d buffer
  const legacyCutoff = startSec - LEGACY_MAX_AGE_SEC;
```
with a single line:
```typescript
  const legacyCutoff = startSec - LEGACY_HISTORY_MAX_AGE_SEC;
```

- [ ] **Step 3: Verify type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/sync-yield-data.ts
git commit -m "refactor: extract LEGACY_HISTORY_MAX_AGE_SEC from inline magic number"
```

---

### Task 4: Document Layer 3 .includes() asymmetry and add length guard

**Files:**
- Modify: `worker/src/cron/yield-helpers.ts:154-162`
- Modify: `worker/src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 1: Write a failing test for the short-symbol guard**

Add to `yield-helpers.test.ts` in the `matchAllDlPools` describe block:
```typescript
it("skips Layer 3 includes fallback for symbols shorter than 4 chars", () => {
  const pools = [
    { pool: "p1", symbol: "USDH", project: "test", tvlUsd: 5e6, apy: 3, apyBase: 3, apyReward: null, exposure: "single", stablecoin: true },
    { pool: "p2", symbol: "USDT", project: "test", tvlUsd: 10e6, apy: 2, apyBase: 2, apyReward: null, exposure: "single", stablecoin: true },
  ];
  // "USD" is 3 chars — should not match anything via includes
  const result = matchAllDlPools("no-static-match", "USD", pools, {}, {});
  expect(result).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run yield-helpers`
Expected: FAIL — Layer 3 currently matches "USD" against "USDH" and "USDT" via `.includes()`.

- [ ] **Step 3: Add the length guard and explanatory comment**

In `yield-helpers.ts`, replace lines 154-162:
```typescript
  // Layer 3: Base-symbol fallback (only when both static maps miss — stablecoin=true required)
  if (found.length === 0) {
    const sym = symbol.toLowerCase();
    const candidates = dlPools.filter(p => p.exposure === "single" && p.stablecoin && p.symbol.toLowerCase().includes(sym));
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
      found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
    }
  }
```

with:
```typescript
  // Layer 3: Base-symbol fallback (only when BOTH static maps miss — stablecoin=true required).
  // Intentionally uses .includes() instead of === to catch DL pools with prefixed/suffixed
  // symbols (e.g., "FEUSDH" for USDH, "STEAKEURCV" for EURCV). Layers 1 and 2 catch most
  // coins first, so Layer 3 only fires when both miss. A minimum symbol length of 4 prevents
  // short symbols like "USD" from matching everything.
  if (found.length === 0) {
    const sym = symbol.toLowerCase();
    if (sym.length >= 4) {
      const candidates = dlPools.filter(p => p.exposure === "single" && p.stablecoin && p.symbol.toLowerCase().includes(sym));
      if (candidates.length > 0) {
        const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
        found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run yield-helpers`
Expected: all pass including the new test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-helpers.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "fix: add minimum symbol length guard to Layer 3 pool matching"
```

---

## Chunk 2: On-Chain Rate Expansion (Tier 1)

### Task 5: Add variantAddress to YIELD_VARIANT_MAP for vaults missing it

**Files:**
- Modify: `worker/src/cron/yield-config.ts`

The following vaults need `variantAddress` added to their existing YIELD_VARIANT_MAP entries. All are on Ethereum unless noted.

| Coin ID | Wrapper | Address |
|---------|---------|---------|
| `usds-sky` | sUSDS | `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD` |
| `dai-makerdao` | sDAI | `0x83F20F44975D03b1b09e64809B757c47f942BEeA` |
| `crvusd-curve` | scrvUSD | `0x0655977FEb2f289A4aB78af67BAB0d17aAb84367` |
| `frxusd-frax` | sfrxUSD | `0xcf62f905562626cfcdd2261162a51fd02fc9c5b6` |
| `dola-inverse-finance` | sDOLA | `0xb45ad160634c528cc3d2926d9807104fa3157305` |
| `bold-liquity` | yBOLD | `0x9F4330700a36B29952869fac9b33f45EEdd8A3d8` |
| `usdf-falcon` | sUSDf | `0xc8cf6d7991f15525488b2a83df53468d682ba4b0` |
| `usn-noon` | sUSN | `0xE24a3DC889621612422A64E6388927901608B91D` |

- [ ] **Step 1: Add variantAddress to each entry**

For each entry in `YIELD_VARIANT_MAP` that's missing `variantAddress`, add it. Example for `usds-sky`:
```typescript
  "usds-sky": {
    variantSymbol: "sUSDS",
    variantAddress: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
    variantChain: "ethereum",
  },
```

Repeat for all 8 entries listed above.

- [ ] **Step 2: Verify type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat: add variantAddress for 8 ERC-4626 vaults in YIELD_VARIANT_MAP"
```

---

### Task 6: Add ON_CHAIN_RATE_CONFIGS for new Tier 1 vaults

**Files:**
- Modify: `worker/src/cron/yield-config.ts`

**Candidates excluded from this expansion (not added to ON_CHAIN_RATE_CONFIGS):**

| Coin ID | Reason |
|---------|--------|
| `avusd-avant` (savUSD) | Verified ERC-4626 vault address not found on Etherscan; DL pool serves as fallback |
| `nusd-neutrl` (sNUSD) | Verified ERC-4626 vault address not found on Etherscan; DL pool serves as fallback |
| `usdai-usd-ai` (sUSDai) | Primary deployment on Arbitrum, not Ethereum; worker only has Ethereum RPC for yield reads |
| `yzusd-yuzu` (syzUSD) | Primary deployment on Plasma chain; no RPC support in worker |
| `msusd-main-street` (msY) | Interface may not be standard ERC-4626; needs further verification |
| `aid-gaib` (sAID) | ERC-4626 compliance unconfirmed; needs further verification |

These coins retain their existing DeFiLlama pool coverage (Tier 2) and can be upgraded to Tier 1 in a follow-up once addresses are verified or multi-chain RPC support is added.

- [ ] **Step 1: Add 9 new entries to ON_CHAIN_RATE_CONFIGS**

All use the same ERC-4626 `convertToAssets(uint256)` selector `0x07a2d13a` and 18 decimals with 1e18 input amount. Add after the existing 4 entries:

```typescript
  {
    stablecoinId: "reusd-re-protocol", // reUSD -> stUSR
    chain: "ethereum",
    contract: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usds-sky", // USDS -> sUSDS
    chain: "ethereum",
    contract: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "dai-makerdao", // DAI -> sDAI
    chain: "ethereum",
    contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "crvusd-curve", // crvUSD -> scrvUSD
    chain: "ethereum",
    contract: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "frxusd-frax", // FRXUSD -> sfrxUSD
    chain: "ethereum",
    contract: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "dola-inverse-finance", // DOLA -> sDOLA
    chain: "ethereum",
    contract: "0xb45ad160634c528cc3d2926d9807104fa3157305",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "bold-liquity", // BOLD -> yBOLD (Yearn V3, ERC-4626 compliant)
    chain: "ethereum",
    contract: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usdf-falcon", // USDf -> sUSDf
    chain: "ethereum",
    contract: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usn-noon", // USN -> sUSN
    chain: "ethereum",
    contract: "0xE24a3DC889621612422A64E6388927901608B91D",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
```

- [ ] **Step 2: Verify type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run tests**

Run: `npm test -- --run`
Expected: all pass. On-chain configs are data — no behavioral change until rates are fetched.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat: add 9 ERC-4626 vaults to ON_CHAIN_RATE_CONFIGS (Tier 1 expansion)"
```

---

## Chunk 3: Rate-Derived & Lending Expansion

### Task 7: Add OUSG rate-derived config

**Files:**
- Modify: `worker/src/cron/yield-config.ts`

- [ ] **Step 1: Add OUSG to RATE_DERIVED_CONFIGS**

After the existing 4 entries in `RATE_DERIVED_CONFIGS`, add:
```typescript
  { stablecoinId: "ousg-ondo-finance", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
```

- [ ] **Step 2: Verify type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat: add OUSG as rate-derived yield source (T-bill - 50bps)"
```

---

### Task 8: Expand lending protocol allowlist

**Files:**
- Modify: `worker/src/cron/yield-config.ts`

- [ ] **Step 1: Add 7 protocols to LENDING_PROTOCOL_ALLOWLIST**

After the existing Tier 3 entries, add a Tier 4 section:
```typescript
  // Tier 4 (expansion — targeted coverage additions)
  "radiant-v2",     // $50M TVL, USDC/USDT on ARB/BSC
  "fraxlend-v2",    // $20M TVL, Frax ecosystem lending
  "clearpool",      // $100M TVL, institutional credit, USDC
  "centrifuge",     // $250M TVL, RWA lending
  "sturdy-v2",      // $20M TVL, yield aggregator
  "goldfinch",      // $80M TVL, real-world credit, USDC
  "truefi",         // $30M TVL, institutional credit, USDC
```

- [ ] **Step 2: Add 7 entries to LENDING_PROTOCOL_LABELS**

```typescript
  "radiant-v2": "Radiant v2",
  "fraxlend-v2": "Fraxlend",
  "clearpool": "Clearpool",
  "centrifuge": "Centrifuge",
  "sturdy-v2": "Sturdy v2",
  "goldfinch": "Goldfinch",
  "truefi": "TrueFi",
```

- [ ] **Step 3: Add 7 entries to YIELD_SOURCE_URLS in yield-source-links.ts**

```typescript
  "Radiant v2": "https://app.radiant.capital/",
  Fraxlend: "https://app.frax.finance/fraxlend",
  Clearpool: "https://app.clearpool.finance/",
  Centrifuge: "https://app.centrifuge.io/",
  "Sturdy v2": "https://v2.sturdy.finance/",
  Goldfinch: "https://app.goldfinch.finance/",
  TrueFi: "https://app.truefi.io/",
```

- [ ] **Step 4: Verify type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-config.ts worker/src/lib/yield-source-links.ts
git commit -m "feat: expand lending protocol allowlist with 7 new protocols"
```

---

## Chunk 4: Auto-Discovery Match Improvement

### Task 9: Cross-reference DeFiLlama pools for symbol-drift matches

**Files:**
- Modify: `worker/src/cron/yield-config.ts` (AUTO_LENDING_POOL_MAP)

This is a one-time research task: fetch the full DeFiLlama pools dataset, cross-reference `underlyingTokens` against tracked stablecoin contract addresses, and identify pools that match by address but miss due to symbol drift.

- [ ] **Step 1: Fetch the DeFiLlama pools dataset**

Use the raw API endpoint `https://yields.llama.fi/pools` (NOT the processed `/api/yield-rankings` which lacks `underlyingTokens` data). This can be done with curl or a small script.

```bash
curl -s 'https://yields.llama.fi/pools' | python3 -c "
import json, sys
data = json.load(sys.stdin)['data']
# Filter to stablecoin pools with underlyingTokens
pools = [p for p in data if p.get('stablecoin') and p.get('underlyingTokens')]
print(f'{len(pools)} stablecoin pools with underlyingTokens')
for p in pools[:5]:
    print(f'  {p[\"pool\"]} {p[\"symbol\"]} tokens={p[\"underlyingTokens\"][:3]}')
"
```

- [ ] **Step 2: Cross-reference against tracked stablecoin contract addresses**

For each tracked stablecoin, check if any DL pool's `underlyingTokens` array contains one of the coin's known contract addresses. Where a match is found but the symbol doesn't already match via Layers 1-3: add the pool UUID to `AUTO_LENDING_POOL_MAP`.

```bash
# Example: extract all contract addresses from stablecoin metadata and search for matches
# The implementor should write a small script or use the REPL to automate this cross-reference
```

- [ ] **Step 3: Add new entries to AUTO_LENDING_POOL_MAP**

For each symbol-drift match found, add an entry:
```typescript
  "stablecoin-id": "defillama-pool-uuid",
```

Expected: 5-10 new entries. If fewer are found, that's acceptable — the existing symbol matching may already cover most cases.

- [ ] **Step 4: Verify type-check and tests**

Run: `cd worker && npx tsc --noEmit && cd .. && npm test -- --run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat: add AUTO_LENDING_POOL_MAP entries from address-based DL pool matching"
```

---

## Chunk 5: Test Coverage Extension

### Task 10: Add cache parsing tests

**Files:**
- Create: `worker/src/cron/__tests__/yield-cache.test.ts`
- Reference: `worker/src/cron/yield-sync/cache.ts`

- [ ] **Step 1: Write tests for parseRiskFreeRateCache**

```typescript
import { describe, it, expect } from "vitest";
import {
  parseRiskFreeRateCache,
  parseDlStablecoinPoolsCache,
  buildRiskFreeRateCachePayload,
  serializeRiskFreeRateCache,
  buildDlStablecoinPoolsCache,
} from "../yield-sync/cache";

describe("parseRiskFreeRateCache", () => {
  const nowSec = 1710500000;

  it("parses a valid structured payload", () => {
    const payload = serializeRiskFreeRateCache(
      buildRiskFreeRateCachePayload({ rate: 4.25, source: "fred", recordDate: "2026-03-14", fetchedAt: nowSec - 3600 }),
    );
    const result = parseRiskFreeRateCache(payload, nowSec - 7200, nowSec);
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(4.25);
    expect(result!.source).toBe("fred");
    expect(result!.ageSeconds).toBe(3600);
  });

  it("returns null for malformed JSON", () => {
    expect(parseRiskFreeRateCache("{bad json", nowSec, nowSec)).toBeNull();
  });

  it("falls back to legacy scalar format", () => {
    const result = parseRiskFreeRateCache("3.75", nowSec - 86400, nowSec);
    expect(result).not.toBeNull();
    expect(result!.rate).toBe(3.75);
    expect(result!.source).toBe("legacy-scalar");
  });

  it("returns null for negative rate", () => {
    expect(parseRiskFreeRateCache("-1.5", nowSec, nowSec)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRiskFreeRateCache("", nowSec, nowSec)).toBeNull();
  });
});

describe("parseDlStablecoinPoolsCache", () => {
  const nowSec = 1710500000;

  it("parses structured payload with data array", () => {
    const pools = [{ pool: "abc", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null }];
    const raw = buildDlStablecoinPoolsCache(pools, nowSec - 1800);
    const result = parseDlStablecoinPoolsCache(raw, nowSec - 1800, nowSec);
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1);
    expect(result!.meta.ageSeconds).toBe(1800);
  });

  it("parses legacy array format", () => {
    const pools = [{ pool: "abc", symbol: "sDAI", apy: 5.0, tvlUsd: 1e8, stablecoin: true, exposure: "single", project: "sdai", apyBase: 5.0, apyReward: null }];
    const raw = JSON.stringify(pools);
    const result = parseDlStablecoinPoolsCache(raw, nowSec - 3600, nowSec);
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1);
    expect(result!.meta.fallbackMode).toBe("legacy-array-cache");
  });

  it("returns null for malformed JSON", () => {
    expect(parseDlStablecoinPoolsCache("{bad", nowSec, nowSec)).toBeNull();
  });

  it("returns null for non-array non-object JSON", () => {
    expect(parseDlStablecoinPoolsCache('"just a string"', nowSec, nowSec)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --run yield-cache`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/__tests__/yield-cache.test.ts
git commit -m "test: add cache parsing tests for risk-free rate and DL pools"
```

---

### Task 11: Extend yield-source-links tests

**Files:**
- Modify: `worker/src/lib/__tests__/yield-source-links.test.ts`

- [ ] **Step 1: Add no-match and new-protocol tests**

Append to the existing describe block:
```typescript
  it("returns null when no curated link and no metadata link exists", () => {
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "nonexistent-coin",
        sourceKey: "unknown-pool",
        yieldSource: "Unknown Protocol",
      }),
    ).toBeNull();
  });

  it("resolves URL for newly added lending protocols", () => {
    // Verify at least one of the newly added protocols resolves
    expect(
      resolveYieldSourceUrl({
        stablecoinId: "usdc-circle",
        sourceKey: "radiant-v2:usdc",
        yieldSource: "Radiant v2",
      }),
    ).toBe("https://app.radiant.capital/");
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --run yield-source-links`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/__tests__/yield-source-links.test.ts
git commit -m "test: extend yield-source-links tests with no-match and new protocol cases"
```

---

### Task 12: Extend sync-yield-data integration tests

**Files:**
- Modify: `worker/src/cron/__tests__/sync-yield-data.test.ts`

- [ ] **Step 1: Add test for OUSG rate-derived participation**

Add a new test case in the `syncYieldData` describe block. Follow the same pattern as the existing "resolves rate-derived yield from cached T-bill rate for configured tokens" test (line 1012):

```typescript
  it("resolves OUSG rate-derived yield with 50bps spread", async () => {
    // Inject the OUSG rate-derived config (matches real config added in Task 7)
    const configs = yieldConfigModule.RATE_DERIVED_CONFIGS as typeof yieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // Return a risk_free_rate of 4.25% from cache
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.25", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const rateDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "100" && stmt.boundValues?.[1] === "rate-derived",
    );
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.25 - 0.50 = 3.75
    expect(Number(rateDerivedRow?.boundValues?.[3])).toBeCloseTo(3.75, 2);
    // data_source should be "rate-derived"
    expect(rateDerivedRow?.boundValues?.[12]).toBe("rate-derived");

    // Clean up
    configs.length = 0;
  });
```

Note: This test uses the existing mock stablecoin ID "100" (sDAI) as a stand-in since the mock `TRACKED_STABLECOINS` doesn't include OUSG. The test validates the rate-derived math with a 50bps spread (the OUSG-specific config), not the coin identity.

- [ ] **Step 2: Add test for on-chain rate expansion (spec Phase 6a)**

Add a test verifying that new Tier 1 ON_CHAIN_RATE_CONFIGS produce valid APY entries. Follow the same pattern as the existing B.Protocol test (line 623) which uses `vi.stubGlobal("fetch", ...)` to intercept RPC calls and passes `testChainRpcs` as a parameter to `syncYieldData`.

```typescript
  it("produces valid APY entry from expanded ON_CHAIN_RATE_CONFIGS", async () => {
    // Inject a mock on-chain rate config for sDAI (id "100")
    const onChainConfigs = yieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof yieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    // Mock getChainRpc to return an Ethereum RPC config
    vi.mocked(getChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    // Mock fetch to handle the convertToAssets RPC call
    // The selector 0x07a2d13a returns an exchange rate of 1.05e18
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(String(init?.body)) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          // convertToAssets selector starts with 0x07a2d13a
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + "0".repeat(48) + "0e92596fd6290000", // ~1.05e18
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example/eth",
        explorerUrl: "https://etherscan.io",
      }],
    ]);
    const result = await syncYieldData(db, undefined, testChainRpcs);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const onChainRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "100" && stmt.boundValues?.[12] === "onchain",
    );
    // Should have an on-chain entry with a computed APY from exchange rate ~1.05
    expect(onChainRow).toBeDefined();
    // The APY should be positive (exact value depends on computeApyFromRate)
    expect(Number(onChainRow?.boundValues?.[3])).toBeGreaterThan(0);

    // Clean up
    onChainConfigs.length = 0;
  });
```

Note: This follows the same `vi.stubGlobal("fetch", ...)` pattern as the B.Protocol test at line 623. The `ChainRpcConfig` type import may need to be added if not already present — check the B.Protocol test's import section (line ~2 area). The RPC response hex value `0e92596fd6290000` is approximately 1.05e18 in decimal; the implementor should verify and adjust if the exact hex differs.

- [ ] **Step 3: Run the tests**

Run: `npm test -- --run sync-yield-data`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/__tests__/sync-yield-data.test.ts
git commit -m "test: add OUSG rate-derived and on-chain rate expansion integration tests"
```

---

### Task 13: Extend yield-resolve tests with price-derived and auto-discovery paths

**Files:**
- Modify: `worker/src/cron/__tests__/yield-resolve.test.ts`

**Gaps to fill (from spec Phase 6b):**
- Price-derived as explicit source (Tier 3 path through resolve, not just navToken fallback)
- Auto-discovery path (non-yield-bearing coin matches a lending pool)

- [ ] **Step 1: Add price-derived explicit source test**

This test is added in `yield-resolve.test.ts` (not `sync-yield-data.test.ts`). The mock stablecoins in that file include `sdai-maker` with `navToken: true`. Use `mockD1` with `supply_history` returning a `first` price value, following the same pattern as `sync-yield-data.test.ts` line 835:

```typescript
  it("resolves price-derived APY for navToken coins from supply_history prices", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [], first: { price: 1.05 } },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // sdai-maker is navToken=true, so price-derived should compute APY from price history
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: Math.floor(Date.now() / 1000) };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const priceDerivedRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "sdai-maker" && stmt.boundValues?.[12] === "price-derived",
    );
    // Should have a price-derived entry (APY computed from price 1.05 → 1.05 over 30 days)
    expect(priceDerivedRow).toBeDefined();
  });
```

Note: `mockD1` returns the `first` value for ALL `supply_history` queries (both recent and 30d-ago), which gives price=1.05 for both → 0% APY. If the test needs a non-zero APY, the implementor should adjust the mock to use `matchBinds` to differentiate the two queries. However, even a 0% APY still produces a `price-derived` row (the key assertion is that the row exists with correct data_source).

- [ ] **Step 2: Add auto-discovery lending pool test**

This test requires mock data that the `yield-resolve.test.ts` mocks don't currently include. The implementor must:
1. Add `u-united-stables` to the mock `TRACKED_STABLECOINS` array and `TRACKED_META_BY_ID` map in the file-level `vi.mock("@shared/lib/stablecoins", ...)` block
2. Add `"u-united-stables": "pool-u-venus"` to the `AUTO_LENDING_POOL_MAP` in the `vi.mock("../yield-config", ...)` block
3. Add `"u-united-stables"` to `AUTO_LENDING_SAFETY_BYPASS_IDS` (so it bypasses the safety score gate)

Then add the test:
```typescript
  it("resolves auto-discovery lending pool for non-yield-bearing coin", async () => {
    const db = makeDb();
    setupDefaultMocks();

    // DL pools must include the auto-discovery target pool
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              symbol: "U",
              project: "venus-core-pool",
              tvlUsd: 5_000_000,
              apy: 3.5,
              apyBase: 3.5,
              apyReward: null,
              exposure: "single",
              stablecoin: true,
            },
          ]),
          updatedAt: nowSec - 300,
        };
      }
      if (key === "risk_free_rate") {
        return { value: "4.0", updatedAt: nowSec };
      }
      return null;
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    // u-united-stables is in AUTO_LENDING_POOL_MAP → maps to "pool-u-venus"
    // It should get a discovered yield entry
    const writeStatements = vi.mocked(batchExecute).mock.calls[0]?.[1] as Array<{ boundValues?: unknown[] }> | undefined;
    const autoRow = writeStatements?.find(
      (stmt) => stmt.boundValues?.[0] === "u-united-stables",
    );
    expect(autoRow).toBeDefined();
  });
```

**Mock additions required** (add to existing vi.mock blocks):

In `vi.mock("@shared/lib/stablecoins", ...)`, add to `TRACKED_STABLECOINS` array:
```typescript
    {
      id: "u-united-stables",
      name: "United Stables",
      symbol: "U",
      geckoId: "united-stables",
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        yieldBearing: false,
        navToken: false,
        governance: "centralized",
      },
    },
```

And add to `TRACKED_META_BY_ID` map:
```typescript
    ["u-united-stables", {
      id: "u-united-stables",
      name: "United Stables",
      symbol: "U",
      geckoId: "united-stables",
      flags: {
        pegCurrency: "USD",
        backing: "rwa-backed",
        yieldBearing: false,
        navToken: false,
        governance: "centralized",
      },
    }],
```

In `vi.mock("../yield-config", ...)`:
```typescript
  AUTO_LENDING_POOL_MAP: { "u-united-stables": "pool-u-venus" },
  AUTO_LENDING_SAFETY_BYPASS_IDS: new Set(["u-united-stables"]),
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- --run yield-resolve`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/__tests__/yield-resolve.test.ts
git commit -m "test: add price-derived and auto-discovery path tests for yield resolve"
```

---

## Chunk 6: Documentation Updates

### Task 14: Update yield-intelligence.md

**Files:**
- Modify: `docs/yield-intelligence.md`

- [ ] **Step 1: Update counts and add new entries**

Update the following sections:
1. Tier 1 on-chain rate count: 4 → 13
2. Lending protocol allowlist count: 28 → 35
3. Rate-derived configs count: 4 → 5 (add OUSG)
4. `AUTO_LENDING_POOL_MAP` entries count: update to reflect new entries from Task 9
5. `YIELD_POOL_MAP` entry count: verify current count and update if changed
6. Add the new vault addresses to the Tier 1 table
7. Add the new protocols to the lending allowlist section
8. Update the test coverage section to reflect new test files

- [ ] **Step 2: Check if docs/coverage-page.md needs updates**

Review whether the 7 new lending protocols change the coverage matrix described in `docs/coverage-page.md`. If new protocols materially expand coverage for previously uncovered coins, update the doc. Otherwise, no changes needed.

- [ ] **Step 3: Verify no markdown issues**

Visually inspect the updated sections for formatting.

- [ ] **Step 4: Commit**

```bash
git add docs/yield-intelligence.md docs/coverage-page.md
git commit -m "docs: update yield-intelligence.md for expansion (13 Tier 1, 35 protocols)"
```

---

### Task 15: Final build verification

- [ ] **Step 1: Run full build + type-check**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: clean build, no type errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no lint errors.

- [ ] **Step 4: Verify doc counts if applicable**

Run: `npm run check:doc-counts`
Expected: pass (stablecoin counts unchanged).
