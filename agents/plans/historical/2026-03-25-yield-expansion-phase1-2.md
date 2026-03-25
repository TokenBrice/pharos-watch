# Yield Coverage Expansion — Phase 1+2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend yield coverage both in width (more coins) and depth (more/better sources) by sweeping config-level wins and adding protocol-native API adapters.

**Architecture:** Phase 1 expands config maps and thresholds — no new code patterns. Phase 2 adds protocol-native fetcher functions following the established BIMA adapter pattern in `sources.ts`, wired into the resolve pipeline in `resolve.ts`. Each new adapter returns `ResolvedYield | null` and participates in confidence-weighted arbitration at `"curated"` tier (same as DeFiLlama native pools).

**Tech Stack:** TypeScript, Cloudflare Workers (D1 + KV), Vitest, existing `fetchWithRetry` + `fetchEvmUint256AtBlock` utilities.

**Expected impact:** +15-25 coins in width, 8+ coins upgraded from proxy/fallback to protocol-native data.

**Protocol count note:** The lending protocol allowlist has 44 protocols as of 2026-03-25.

---

## Connection Budget & Batching

The yield sync runs in the half-hourly cron slot (`10,40 * * * *`) with a 5-minute timeout. Workers have a **6-connection concurrent limit per cron trigger**, shared with co-scheduled jobs. Yield sync runs AFTER dex-liquidity completes, so it gets the full 6-connection pool.

**Current calls:** ~12-15 (1 DL pools + 11 on-chain rates in batches of 4 + 1-3 conditional). Peak concurrency: 4.

**New calls added by this plan:** Hashnote (1), Ondo oracle (1), mTBILL oracle (1), Morpho (1), Pendle (3), Kong (5), Beefy (2), Aave V3 (N targets, batched 4), Compound V3 (16 markets × 2 calls, batched 4), SOFR (1) = **40+ new calls total**.

**Batching strategy for new calls (add to `sync-yield-data.ts`):**

```
Phase A — Fast protocol APIs (before on-chain rates):
  Sequential: Hashnote (1 call), Superstate on-chain (1 call via existing batching)

Phase B — On-chain rates (existing, batched 4+4+3)

Phase C — Batch protocol adapters (after on-chain rates):
  Morpho (1) + Beefy APY (1) + Beefy vaults (1): Promise.allSettled([3])  — peak 3
  Pendle chain 1 + 2 + 3: Promise.allSettled([3])                         — peak 3
  Kong chain 1-4: Promise.allSettled([4])                                  — peak 4
  Kong chain 5: await single call                                          — peak 1

Phase D — Per-coin conditional (BIMA, B.Protocol, Ondo oracle): sequential as today

Phase E — Aave V3 on-chain rates (new):
  Aave targets batched 4 at a time (same as existing on-chain rate pattern)
  ~20-40 targets across tracked stablecoins = 5-10 sequential batches
  Peak: 4 concurrent RPC calls per batch, ~1-2s per batch = ~10-20s total

Phase F — Compound V3 on-chain rates (new):
  16 Comet markets × 2 calls each = 32 calls, batched 4 at a time
  8 sequential batches, ~1-2s per batch = ~8-16s total

Phase G — Single oracle reads (mTBILL, SOFR):
  Sequential: 1 RPC call + 1 FRED fetch = ~2s total
```

**Peak concurrency with new calls:** 4 (Kong/Aave/Compound batch). **Total new wall-clock time:** ~35-55 seconds (including Aave + Compound batches). Well within the 5-minute budget.

**Important:** All new fetchers MUST use `Promise.allSettled()` for fault tolerance — individual protocol failures must NOT crash the sync. Return empty arrays on failure.

---

## Investigated but NOT Suitable for On-Chain Reads

- **ftusd-flying-tulip (sftUSD):** Has `variantAddress` in `YIELD_VARIANT_MAP` but `convertToAssets(1e18)` returns exactly 1e18 (1:1 ratio). The vault uses epoch-based reward distribution, not exchange-rate appreciation. Adding to `ON_CHAIN_RATE_CONFIGS` would always compute 0% APY. Leave on DL/variant matching.
- **dusd-dtrinity (sdUSD):** Quarantined — `convertToAssets` reverts.
- **reusd-re-protocol (stUSR):** Quarantined — `convertToAssets` returns empty data.

---

## Shared Patterns Reference

All Phase 2 adapters follow this template (modeled on `fetchBimaSusbdSource` in `worker/src/cron/yield-sync/sources.ts:33-50`):

```typescript
// 1. Constants at top of sources.ts
const SOURCE_KEY = "protocol-api:<protocol-name>";
const SOURCE_LABEL = "<Protocol> <product>";
const SOURCE_TYPE: YieldType = "<yield-type>";
const API_URL = "<endpoint>";

// 2. Fetcher function signature
export async function fetch<Name>Source(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(API_URL, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal }, 1);
    if (!res?.ok) return null;
    // ... parse, validate, extract APY + TVL ...
    return { currentApy, apyBase, apyReward, sourcePool: null, sourceTvlUsd, dataSource: "protocol-api",
             exchangeRate: null, sourceKey: SOURCE_KEY, yieldSource: SOURCE_LABEL, yieldType: SOURCE_TYPE,
             sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] <Name> source failed:", error);
    return null;
  }
}
```

**Integration in `resolve.ts`** (after line 274, before `if (hasAnySource) continue;`):
```typescript
if (id === COIN_ID && !resolved.some((e) => e.id === id && e.yield?.sourceKey === SOURCE_KEY)) {
  const result = await fetchSource(signal);
  if (result) { resolved.push({ id, symbol, yield: result }); hasAnySource = true; }
}
```

**Test file template** (modeled on `worker/src/cron/__tests__/yield-bima-source.test.ts`):
```typescript
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));
import { fetch<Name>Source } from "../yield-sync/sources";

describe("fetch<Name>Source", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("parses valid response into protocol-api source row", async () => { /* ... */ });
  it("returns null on missing/invalid data", async () => { /* ... */ });
  it("returns null on HTTP error", async () => { /* ... */ });
});
```

---

## Phase 1: Config-Level Wins (Width)

### Task 1: Expand lending protocol allowlist

**Files:**
- Modify: `worker/src/cron/yield-config.ts` (LENDING_PROTOCOLS object)
- Modify: `worker/src/lib/yield-source-links.ts` (YIELD_SOURCE_URLS map)
- Modify: `docs/yield-intelligence.md` (lending protocol table)

DeFiLlama audit conducted 2026-03-25. Of 90+ protocols with >$1M stablecoin TVL not in our allowlist, the following are genuine lending protocols (excluding native yield tokens, aggregators, and rewards distributors):

**Tier A — Add immediately (>$50M TVL, well-known):**

| DL Slug | Label | TVL | App URL |
|---|---|---|---|
| `wildcat-protocol` | Wildcat | $235M | `https://app.wildcat.finance/` |
| `tectonic` | Tectonic | $100M | `https://app.tectonic.finance/` |
| `upshift` | Upshift | $87M | `https://app.upshift.finance/` |
| `venus-flux` | Venus Flux | $78M | `https://app.venus.io/` |
| `avantis` | Avantis | $77M | `https://app.avantis.finance/` |
| `cap` | Cap | $68M | `https://app.cap.money/` |
| `resupply` | Resupply | $64M | `https://resupply.fi/` |
| `zerobase-cedefi` | ZeroBase | $56M | `https://zerobase.fi/` |

**Tier B — Add if time allows ($10M-$50M TVL):**

| DL Slug | Label | TVL | App URL |
|---|---|---|---|
| `convex-finance` | Convex Finance | $42M | `https://www.convexfinance.com/` |
| `yo-protocol` | Yo Protocol | $43M | `https://yo.xyz/` |
| `autofinance` | AutoFinance | $31M | `https://autofinance.io/` |
| `neverland` | Neverland | $31M | `https://neverland.finance/` |
| `clearpool-lending` | Clearpool Lending | $31M | `https://app.clearpool.finance/` |
| `tydro` | Tydro | $26M | `https://tydro.fi/` |
| `3jane-lending` | 3Jane | $24M | `https://3jane.xyz/` |
| `hyperlend-pooled` | HyperLend | $24M | `https://app.hyperlend.finance/` |
| `zest-v2` | Zest v2 | $21M | `https://app.zestprotocol.com/` |
| `liquity-v2` | Liquity v2 | $21M | `https://www.liquity.org/` |
| `fusion-by-ipor` | IPOR Fusion | $18M | `https://app.ipor.io/fusion` |
| `echelon-market` | Echelon | $17M | `https://echelon.market/` |
| `termmax` | TermMax | $16M | `https://app.termmax.io/` |
| `beefy` | Beefy | $15M | `https://app.beefy.com/` |
| `gearbox` | Gearbox | $5M | `https://app.gearbox.fi/` |

**Note:** `venus-flux` is separate from the already-allowlisted `venus-core-pool`. `clearpool-lending` is separate from `clearpool`. Both should be added as additional slugs.

- [ ] **Step 1: Verify the DL slugs are still active**

```bash
# Quick spot-check top candidates are still alive
curl -s "https://yields.llama.fi/pools" | jq '[.data[] | select(.project == "wildcat-protocol" and .exposure == "single" and .stablecoin == true)] | length'
```

- [ ] **Step 2: Write test for expanded allowlist**

Add test cases to `worker/src/cron/__tests__/yield-config-registry.test.ts`:

```typescript
it("includes high-TVL stablecoin lending protocols from 2026-03-25 audit", () => {
  const tierAProtocols = [
    "wildcat-protocol", "tectonic", "upshift", "venus-flux",
    "avantis", "cap", "resupply", "zerobase-cedefi",
  ];
  for (const slug of tierAProtocols) {
    expect(LENDING_PROTOCOL_ALLOWLIST.has(slug), slug).toBe(true);
    expect(LENDING_PROTOCOL_LABELS[slug], slug).toBeTruthy();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 4: Add new protocols to allowlist**

In `worker/src/cron/yield-config.ts`, add entries to the `LENDING_PROTOCOLS` object (which drives both `LENDING_PROTOCOL_ALLOWLIST` and `LENDING_PROTOCOL_LABELS`):

```typescript
// Add inside LENDING_PROTOCOLS — Tier A (>$50M TVL)
"wildcat-protocol": { label: "Wildcat" },
"tectonic": { label: "Tectonic" },
"upshift": { label: "Upshift" },
"venus-flux": { label: "Venus Flux" },
"avantis": { label: "Avantis" },
"cap": { label: "Cap" },
"resupply": { label: "Resupply" },
"zerobase-cedefi": { label: "ZeroBase" },
// Tier B (optional, $10M-$50M TVL) — add as many as reasonable:
"convex-finance": { label: "Convex Finance" },
"yo-protocol": { label: "Yo Protocol" },
"clearpool-lending": { label: "Clearpool Lending" },
"3jane-lending": { label: "3Jane" },
"hyperlend-pooled": { label: "HyperLend" },
"zest-v2": { label: "Zest v2" },
"liquity-v2": { label: "Liquity v2" },
"echelon-market": { label: "Echelon" },
"termmax": { label: "TermMax" },
"beefy": { label: "Beefy" },
"gearbox": { label: "Gearbox" },
```

Add corresponding URLs to `worker/src/lib/yield-source-links.ts`:

```typescript
Wildcat: "https://app.wildcat.finance/",
Tectonic: "https://app.tectonic.finance/",
Upshift: "https://app.upshift.finance/",
"Venus Flux": "https://app.venus.io/",
Avantis: "https://app.avantis.finance/",
Cap: "https://app.cap.money/",
Resupply: "https://resupply.fi/",
ZeroBase: "https://zerobase.fi/",
"Convex Finance": "https://www.convexfinance.com/",
"Yo Protocol": "https://yo.xyz/",
"Clearpool Lending": "https://app.clearpool.finance/",
"3Jane": "https://3jane.xyz/",
HyperLend: "https://app.hyperlend.finance/",
"Zest v2": "https://app.zestprotocol.com/",
"Liquity v2": "https://www.liquity.org/",
Echelon: "https://echelon.market/",
TermMax: "https://app.termmax.io/",
Beefy: "https://app.beefy.com/",
Gearbox: "https://app.gearbox.fi/",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 6: Update docs**

Update the lending protocol table in `docs/yield-intelligence.md` with the new entries.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/yield-config.ts worker/src/lib/yield-source-links.ts worker/src/cron/__tests__/yield-config-registry.test.ts docs/yield-intelligence.md
git commit -m "feat(yield): expand lending protocol allowlist with Solana/L2 protocols"
```

---

### Task 2: Lower TVL floor for smaller ecosystems

**Files:**
- Modify: `worker/src/lib/constants.ts:120` (`MIN_LENDING_POOL_TVL_USD`)
- Modify: `worker/src/cron/yield-sync/resolve.ts:320,365` (pass ecosystem-aware floor)
- Modify: `worker/src/cron/yield-helpers.ts` (update `findBestLendingPool` if threshold is parameterized)
- Test: `worker/src/cron/__tests__/yield-helpers.test.ts`

The current $100K TVL floor excludes legitimate lending markets on Solana, Sui, and other smaller ecosystems. Introduce a lower floor ($25K) for non-EVM or smaller-TVL chains.

- [ ] **Step 1: Write test for chain-aware TVL threshold**

In `worker/src/cron/__tests__/yield-helpers.test.ts`, add:

```typescript
describe("findBestLendingPool with ecosystem-aware TVL floor", () => {
  it("uses $100K floor for Ethereum pools", () => {
    const pool = { pool: "p1", chain: "Ethereum", project: "aave-v3", symbol: "USDC",
                   tvlUsd: 80_000, apy: 3, apyBase: 3, apyReward: null, stablecoin: true,
                   exposure: "single", apyMean30d: 3, underlyingTokens: null };
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST,
                                       { minApy: 0.1, minTvlUsd: 100_000, contractAddresses: [] });
    expect(result).toBeNull();
  });

  it("accepts $25K pool on Solana chains", () => {
    const pool = { pool: "p2", chain: "Solana", project: "kamino-lend", symbol: "USDC",
                   tvlUsd: 30_000, apy: 4, apyBase: 4, apyReward: null, stablecoin: true,
                   exposure: "single", apyMean30d: 4, underlyingTokens: null };
    const result = findBestLendingPool("USDC", [pool], LENDING_PROTOCOL_ALLOWLIST,
                                       { minApy: 0.1, minTvlUsd: 25_000, contractAddresses: [] });
    expect(result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 3: Implement chain-aware TVL floor**

Rather than hardcoding chain-aware logic inside the helper, add a new constant and pass the appropriate floor from the resolve callsite. In `worker/src/lib/constants.ts`:

```typescript
export const MIN_LENDING_POOL_TVL_USD = 100_000;
export const MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM = 25_000;
```

In `worker/src/cron/yield-sync/resolve.ts`, update the auto-lending discovery loop (line ~358-368) to use the lower floor for non-EVM chains:

```typescript
const SMALL_ECOSYSTEM_CHAINS = new Set(["Solana", "Sui", "Aptos", "Cardano", "Stacks"]);

for (const meta of lendingCandidates) {
  // Determine appropriate TVL floor based on coin's primary chain
  const primaryChain = meta.contracts?.[0]?.chain;
  const chainLabel = primaryChain ? /* map to DL chain name */ primaryChain : null;
  const effectiveTvlFloor = chainLabel && SMALL_ECOSYSTEM_CHAINS.has(chainLabel)
    ? MIN_LENDING_POOL_TVL_USD_SMALL_ECOSYSTEM
    : MIN_LENDING_POOL_TVL_USD;

  const pool = findBestLendingPool(meta.symbol, dlPools, LENDING_PROTOCOL_ALLOWLIST, {
    minApy: MIN_LENDING_POOL_APY,
    minTvlUsd: effectiveTvlFloor,
    contractAddresses: (meta.contracts ?? []).map((c) => c.address),
  });
  // ... rest unchanged
}
```

- [ ] **Step 4: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-helpers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/constants.ts worker/src/cron/yield-sync/resolve.ts worker/src/cron/__tests__/yield-helpers.test.ts
git commit -m "feat(yield): lower TVL floor to $25K for Solana/Sui/Aptos/Cardano/Stacks lending pools"
```

---

### Task 3: Curate DL pool mappings for fragile auto-lending-only coins

> **Note:** cetes-etherfuse already has `yieldConfig` in `shared/data/stablecoins/non-usd.json` and passes the registry test. No action needed for that coin.

**Files:**
- Modify: `worker/src/cron/yield-config.ts` (YIELD_POOL_MAP or AUTO_LENDING_POOL_MAP)

8 coins rely entirely on auto-discovered lending with no curated fallback. Verify each has a valid DL pool UUID and add explicit mappings where missing.

- [ ] **Step 1: Audit current AUTO_LENDING_POOL_MAP entries**

For each coin in `AUTO_LENDING_POOL_MAP`, verify the pool UUID still exists in DL:

```bash
# For each pool UUID, check DL
for uuid in "d8e9bb79-79d3-4897-8a4f-8d489040097d" "add30093-8fb6-4972-bb6a-a0f3add8bfe8" ...; do
  curl -s "https://yields.llama.fi/chart/$uuid" | jq '.status'
done
```

- [ ] **Step 2: Add missing curated mappings**

For auto-lending coins where the pool UUID is still valid, no change needed. For any that have gone stale, find the replacement pool in DL and update `AUTO_LENDING_POOL_MAP` in `yield-config.ts`.

- [ ] **Step 3: Run full test suite**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "chore(yield): verify and refresh auto-lending pool UUIDs for fragile coins"
```

---

### Task 4: Flag cusd-cap as yield-bearing (stCUSD savings wrapper)

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (flip yieldBearing + add yieldConfig for cusd-cap)
- Modify: `worker/src/cron/yield-config.ts` (add YIELD_VARIANT_MAP + YIELD_POOL_MAP entries)

DeFiLlama audit (2026-03-25) found 1 actionable coin: `cusd-cap` has a native savings wrapper `stCUSD` at $67.9M TVL / 4.59% APY (pool `bf6ca887-e357-49ec-8031-0d1a6141c455`), but is flagged `yieldBearing: false`. All other wrapper hits (stUSDT, sRUSDe, sENPYUSD, etc.) are third-party lending deposits, not protocol-native savings.

- [ ] **Step 1: Write failing registry test**

The registry test at `worker/src/cron/__tests__/yield-config-registry.test.ts` already asserts all active yield-bearing coins have runtime strategies. After flipping `yieldBearing: true`, the coin must also have a strategy. Verify the test currently passes (cusd-cap is not yield-bearing yet):

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 2: Flip yieldBearing flag and add yieldConfig**

In `shared/data/stablecoins/usd-major.json`, find the `cusd-cap` entry:
1. Set `"yieldBearing": true` in `flags`
2. Add:
```json
"yieldConfig": {
  "defiLlamaPoolId": "bf6ca887-e357-49ec-8031-0d1a6141c455",
  "yieldSource": "Cap savings (stCUSD)",
  "yieldType": "lending-vault"
}
```

- [ ] **Step 3: Add YIELD_VARIANT_MAP and YIELD_POOL_MAP entries**

In `worker/src/cron/yield-config.ts`:

```typescript
// YIELD_VARIANT_MAP:
"cusd-cap": {
  variantSymbol: "stCUSD",
  variantChain: "ethereum",
  yieldSource: "Cap savings (stCUSD)",
  yieldType: "lending-vault",
},

// YIELD_POOL_MAP:
"cusd-cap": "bf6ca887-e357-49ec-8031-0d1a6141c455",
```

- [ ] **Step 4: Run registry tests**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

Expected: all tests pass (new coin has both yieldConfig metadata and DL pool strategy).

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/usd-major.json worker/src/cron/yield-config.ts
git commit -m "feat(yield): flag cusd-cap as yield-bearing with stCUSD savings wrapper"
```

---

## Phase 2: Protocol-Native API Adapters (Depth)

### Task 5: Hashnote USYC API adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts` (add fetcher)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (wire in)
- Modify: `worker/src/lib/yield-source-links.ts` (add URL)
- Create: `worker/src/cron/__tests__/yield-hashnote-source.test.ts`

Hashnote publishes USYC price history at `https://usyc.hashnote.com/api/price` (free, no auth). USYC is currently rate-derived (T-bill minus 50bps spread). This adapter provides real NAV-derived APY instead.

- [ ] **Step 1: Probe the API and document response shape**

```bash
curl -s "https://usyc.hashnote.com/api/price" | jq '.'
curl -s "https://usyc.hashnote.com/api/price-reports" | jq '.[0:3]'
```

Document the exact field names, types, and semantics.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-hashnote-source.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchHashnoteUsycSource } from "../yield-sync/sources";

describe("fetchHashnoteUsycSource", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("derives APY from USYC price reports", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysAgoSec = nowSec - 7 * 86400;
    mockFetch([{
      match: "usyc.hashnote.com/api/price-reports",
      body: {
        entity: "usyc_price_report",
        data: [
          { roundId: "392", price: "1.120246648414663082", timestamp: String(nowSec), principal: "2453604554.64", interest: "236175.55", balance: "2453840730.19", totalSupply: "2190425756.78094", decimals: 6, fee: "21082.459861", txhash: "0xabc" },
          { roundId: "385", price: "1.119046648414663082", timestamp: String(sevenDaysAgoSec), principal: "2400000000.00", interest: "200000.00", balance: "2400200000.00", totalSupply: "2190000000.00", decimals: 6, fee: "20000.00", txhash: "0xdef" },
        ],
      },
    }]);

    const result = await fetchHashnoteUsycSource();
    expect(result).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      sourceKey: "protocol-api:hashnote-usyc",
      yieldSource: "Hashnote USYC",
    }));
    expect(result!.currentApy).toBeGreaterThan(0);
  });

  it("returns null on HTTP error", async () => {
    mockFetch([{ match: "usyc.hashnote.com", status: 500 }]);
    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-hashnote-source.test.ts`

- [ ] **Step 4: Implement the fetcher**

In `worker/src/cron/yield-sync/sources.ts`, add constants and fetcher:

```typescript
const HASHNOTE_USYC_SOURCE_KEY = "protocol-api:hashnote-usyc";
const HASHNOTE_USYC_SOURCE_LABEL = "Hashnote USYC";
const HASHNOTE_USYC_SOURCE_TYPE = "nav-appreciation";
const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";

// Actual API response shape (verified 2026-03-25):
// { entity: "usyc_price_report", data: Array<{ roundId: string, price: string (18 decimals),
//   timestamp: string (Unix seconds), principal: string, interest: string, ... }> }
// Returns ~45 reports, newest first.

interface HashnoteReport {
  roundId: string;
  price: string;       // 18-decimal string like "1.120246648414663082"
  timestamp: string;   // Unix seconds as string
}

export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(HASHNOTE_PRICE_REPORTS_URL, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal,
    }, 1);
    if (!res?.ok) return null;

    const body = (await res.json()) as { entity?: string; data?: HashnoteReport[] };
    const reports = body.data;
    if (!Array.isArray(reports) || reports.length < 2) return null;

    // Reports come newest-first (highest roundId first)
    const latest = reports[0];
    const latestPrice = parseFloat(latest.price);
    const latestTimeSec = parseInt(latest.timestamp, 10);
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
    if (!Number.isFinite(latestTimeSec)) return null;

    // Find anchor closest to 7 days ago
    const targetAnchorSec = latestTimeSec - 7 * 86400;
    let anchor = reports[reports.length - 1];
    for (const report of reports) {
      const ts = parseInt(report.timestamp, 10);
      if (Number.isFinite(ts) && ts <= targetAnchorSec) { anchor = report; break; }
    }
    const anchorPrice = parseFloat(anchor.price);
    const anchorTimeSec = parseInt(anchor.timestamp, 10);
    if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return null;

    const daysDelta = (latestTimeSec - anchorTimeSec) / 86400;
    if (daysDelta < 1) return null;

    const apy = (Math.pow(latestPrice / anchorPrice, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: null, sourceKey: HASHNOTE_USYC_SOURCE_KEY,
      yieldSource: HASHNOTE_USYC_SOURCE_LABEL, yieldType: HASHNOTE_USYC_SOURCE_TYPE,
      sourceObservedAt: latestTimeSec,
      comparisonAnchorObservedAt: anchorTimeSec,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Hashnote USYC source failed:", error);
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-hashnote-source.test.ts`

- [ ] **Step 6: Wire into resolve pipeline**

In `worker/src/cron/yield-sync/resolve.ts`:

1. Add `fetchHashnoteUsycSource` to the existing `import { ... } from "./sources"` line.
2. Add constant: `const HASHNOTE_USYC_ID = "usyc-hashnote";`
3. After the BIMA block (line ~274), add:

```typescript
if (
  id === HASHNOTE_USYC_ID &&
  !resolved.some((e) => e.id === id && e.yield?.sourceKey === "protocol-api:hashnote-usyc")
) {
  const hashnoteYield = await fetchHashnoteUsycSource(signal);
  if (hashnoteYield) {
    resolved.push({ id, symbol, yield: hashnoteYield });
    hasAnySource = true;
  }
}
```

- [ ] **Step 7: Add source URL**

In `worker/src/lib/yield-source-links.ts`, add to `YIELD_SOURCE_URLS`:

```typescript
"Hashnote USYC": "https://usyc.hashnote.com/",
```

- [ ] **Step 8: Run full yield test suite**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

- [ ] **Step 9: Commit**

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/lib/yield-source-links.ts worker/src/cron/__tests__/yield-hashnote-source.test.ts
git commit -m "feat(yield): add Hashnote USYC protocol-native API adapter"
```

---

### Task 6: Superstate USTB on-chain NAV adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-superstate-source.test.ts`

**Important:** Superstate has NO public REST API for yield/NAV data (verified 2026-03-25 — all `api.superstate.co` endpoints return 404). USTB is an ERC-4626 NAV-accreting token at `0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e` on Ethereum. We can read its NAV via `convertToAssets(1e6)` (6 decimals) and derive APY from the rate delta — same approach as our Tier 1 on-chain adapters.

**Decision:** Add USTB to `ON_CHAIN_RATE_CONFIGS` in `yield-config.ts` instead of a protocol-API adapter. This is more reliable and consistent with our existing deterministic on-chain pattern.

- [ ] **Step 1: Verify USTB is ERC-4626 compatible**

```bash
# convertToAssets(uint256) selector = 0x07a2d13a, input = 1e6 (USTB has 6 decimals)
cast call 0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e "convertToAssets(uint256)(uint256)" 1000000 --rpc-url https://eth.llamarpc.com
```

Expected: returns a value > 1000000 (representing NAV appreciation above $1.00).

- [ ] **Step 2: Write failing test**

Add to `worker/src/cron/__tests__/yield-config-registry.test.ts`:

```typescript
it("includes USTB in on-chain rate configs", () => {
  const ustbConfig = ON_CHAIN_RATE_CONFIGS.find((c) => c.stablecoinId === "ustb-superstate");
  expect(ustbConfig).toBeDefined();
  expect(ustbConfig!.chain).toBe("ethereum");
  expect(ustbConfig!.decimals).toBe(6);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 4: Add USTB to ON_CHAIN_RATE_CONFIGS**

In `worker/src/cron/yield-config.ts`, add:

```typescript
{
  stablecoinId: "ustb-superstate",
  chain: "ethereum",
  contract: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e",
  selector: "0x07a2d13a", // convertToAssets(uint256)
  decimals: 6,
  inputAmount: "0x00000000000000000000000000000000000000000000000000000000000f4240", // 1e6
},
```

Also add to `YIELD_VARIANT_MAP` if not already present:

```typescript
"ustb-superstate": {
  variantSymbol: "USTB",
  variantAddress: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e",
  variantChain: "ethereum",
},
```

- [ ] **Step 5: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

- [ ] **Step 6: Optionally remove USTB from RATE_DERIVED_CONFIGS**

Since on-chain reads are "deterministic" tier (highest confidence), the rate-derived entry becomes redundant. Remove `ustb-superstate` from `RATE_DERIVED_CONFIGS` so the on-chain source is the sole source. The evaluation engine would pick on-chain over rate-derived anyway, but removing avoids a confusing dual-source.

- [ ] **Step 7: Run full test suite and commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-config.ts worker/src/cron/__tests__/yield-config-registry.test.ts
git commit -m "feat(yield): add USTB on-chain NAV read via ERC-4626 convertToAssets"
```

---

### Task 7: Ondo USDY on-chain oracle adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-ondo-source.test.ts`

Ondo publishes USDY price via an on-chain oracle at `0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0` with `getPrice()` (18 decimals). USDY is currently covered by DL pool mapping — this adds a deterministic on-chain source as an alternative.

- [ ] **Step 1: Probe the oracle**

```bash
# getPrice() selector = 0x98d5fdca
cast call 0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0 "getPrice()(uint256)" --rpc-url https://eth.llamarpc.com
```

Document the response (should be ~1.08e18 representing $1.08 USDY price).

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-ondo-source.test.ts`. Since this requires EVM RPC mocking, mock `fetchEvmUint256AtBlock`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchOndoUsdyOracleSource } from "../yield-sync/sources";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

describe("fetchOndoUsdyOracleSource", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from USDY oracle price vs 7-day-old DB row", async () => {
    // Current price: $1.0850 (1085000000000000000n)
    mockEvmCall.mockResolvedValue(1_085_000_000_000_000_000n);

    const result = await fetchOndoUsdyOracleSource(
      1_083_500_000_000_000_000n, // 7 days ago price
      7, // days delta
    );

    expect(result).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      sourceKey: "protocol-api:ondo-usdy-oracle",
    }));
    expect(result!.currentApy).toBeGreaterThan(0);
  });

  it("returns null when oracle call fails", async () => {
    mockEvmCall.mockResolvedValue(null);
    const result = await fetchOndoUsdyOracleSource(null, 7);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Implement the fetcher**

This adapter reads the Ondo oracle for the current price, then computes APY from a prior price stored in yield_history (similar to Tier 1 on-chain pattern but via oracle, not ERC-4626 vault).

```typescript
const ONDO_USDY_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const ONDO_USDY_SOURCE_LABEL = "Ondo USDY Oracle";
const ONDO_USDY_SOURCE_TYPE = "nav-appreciation";
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca"; // getPrice()

export async function fetchOndoUsdyOracleSource(
  prevPriceBigint: bigint | null,
  daysDelta: number,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  try {
    const currentPrice = await fetchEvmUint256AtBlock(
      "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
      { signal, chainRpcs },
    );
    if (!currentPrice || currentPrice === 0n) return null;

    const currentPriceFloat = Number(currentPrice) / 1e18;
    if (!Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

    if (!prevPriceBigint || prevPriceBigint === 0n || daysDelta < 1) {
      // Seed: store current price for future delta computation
      return {
        currentApy: 0, apyBase: null, apyReward: null,
        sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
        exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
        yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
        sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
      };
    }

    const prevPriceFloat = Number(prevPriceBigint) / 1e18;
    const apy = (Math.pow(currentPriceFloat / prevPriceFloat, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
      yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Ondo USDY oracle source failed:", error);
    return null;
  }
}
```

- [ ] **Step 4: Wire into resolve pipeline**

In `worker/src/cron/yield-sync/resolve.ts`, add:

1. Add `fetchOndoUsdyOracleSource` to the existing `import { ... } from "./sources"` line.
2. Constant: `const ONDO_USDY_ID = "usdy-ondo-finance";`
3. After the Hashnote block (added in Task 5), add oracle resolution. This adapter needs the prior exchange_rate from `yield_history` (stored from the previous sync), similar to Tier 1 on-chain coins:

```typescript
if (
  id === ONDO_USDY_ID &&
  !resolved.some((e) => e.id === id && e.yield?.sourceKey === "protocol-api:ondo-usdy-oracle")
) {
  // Look up prior oracle price from yield_history
  const priorRow = await db
    .prepare(
      `SELECT exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = 'protocol-api:ondo-usdy-oracle'
         AND exchange_rate IS NOT NULL
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(ONDO_USDY_ID)
    .first<{ exchange_rate: number; recorded_at: number }>();

  const prevPriceBigint = priorRow?.exchange_rate
    ? BigInt(Math.round(priorRow.exchange_rate * 1e18))
    : null;
  const daysDelta = priorRow ? (startSec - priorRow.recorded_at) / 86400 : 0;

  const ondoYield = await fetchOndoUsdyOracleSource(prevPriceBigint, daysDelta, signal, chainRpcs);
  if (ondoYield) {
    resolved.push({ id, symbol, yield: ondoYield });
    hasAnySource = true;
  }
}
```

Note: The `fetchEvmUint256AtBlock` call inside the fetcher should use `extraRpcUrls` built from `getChainRpc(chainRpcs, "ethereum")` to match the established pattern in `sources.ts`:
```typescript
const rpc = getChainRpc(chainRpcs, "ethereum");
const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];
const currentPrice = await fetchEvmUint256AtBlock(
  "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
  { extraRpcUrls, signal },
);
```

- [ ] **Step 5: Add source URL**

In `worker/src/lib/yield-source-links.ts`: `"Ondo USDY Oracle": "https://ondo.finance/usdy"`

- [ ] **Step 6: Run full yield test suite**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/lib/yield-source-links.ts worker/src/cron/__tests__/yield-ondo-source.test.ts
git commit -m "feat(yield): add Ondo USDY on-chain oracle adapter"
```

---

### Task 8: Morpho GraphQL API adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-morpho-source.test.ts`

Morpho publishes vault/market APY via GraphQL at `https://api.morpho.org/graphql` (free, 5k req/5min). This covers 15+ stablecoins via Morpho vaults/markets — much richer than DL auto-discovery.

This adapter is different from the single-coin adapters above: it fetches ALL Morpho stablecoin vaults in one GraphQL call and returns a map of `stablecoinId → ResolvedYield[]`. This avoids N+1 API calls.

- [ ] **Step 1: Probe the Morpho API**

```bash
curl -s -X POST "https://api.morpho.org/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ vaults(first: 5, where: { whitelisted: true }) { items { address name asset { symbol } state { netApy totalAssets } chain { id } } } }"}'
```

Document the exact GraphQL schema for vault APY and market APY.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-morpho-source.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchMorphoVaultSources } from "../yield-sync/sources";

describe("fetchMorphoVaultSources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("returns yield sources for stablecoin vaults", async () => {
    mockFetch([{
      match: "api.morpho.org",
      body: {
        data: {
          vaults: {
            items: [{
              address: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
              name: "Gauntlet USDC Prime",
              asset: { symbol: "USDC" },
              chain: { id: 1 },
              state: { netApy: 0.02968, totalAssetsUsd: 142_917_322, fee: 0 },
            }],
          },
        },
      },
    }]);

    const results = await fetchMorphoVaultSources();
    expect(results.length).toBe(1);
    expect(results[0].symbol).toBe("USDC");
    expect(results[0].yield).toEqual(expect.objectContaining({
      currentApy: expect.closeTo(2.968, 1),
      dataSource: "protocol-api",
      sourceKey: expect.stringContaining("protocol-api:morpho-vault:"),
      yieldSource: expect.stringContaining("Morpho"),
      sourceTvlUsd: 142_917_322,
    }));
  });
});
```

- [ ] **Step 3: Implement the batch fetcher**

```typescript
// Morpho GraphQL schema verified 2026-03-25.
// Key: use `listed: true` NOT `whitelisted`, use `assetSymbol_in` for stablecoins,
// `state.netApy` is decimal (0.03 = 3%), `state.totalAssetsUsd` is USD float,
// `curator` is scalar Address (not object).
const MORPHO_GQL_URL = "https://api.morpho.org/graphql";
const MORPHO_STABLECOIN_SYMBOLS = ["USDC", "USDT", "DAI", "USDS", "GHO", "FRAX", "PYUSD", "FRXUSD", "crvUSD", "DOLA", "LUSD"];
const MORPHO_STABLECOIN_QUERY = `query($symbols: [String!]!) {
  vaults(first: 100, where: { listed: true, assetSymbol_in: $symbols, totalAssetsUsd_gte: 100000 }) {
    items {
      address name
      asset { symbol }
      chain { id }
      state { netApy totalAssetsUsd fee }
    }
  }
}`;

interface MorphoVaultItem {
  address: string; name: string;
  asset: { symbol: string };
  chain: { id: number };
  state: { netApy: number; totalAssetsUsd: number | null; fee: number } | null;
}

export async function fetchMorphoVaultSources(
  signal?: AbortSignal,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  try {
    const res = await fetchWithRetry(MORPHO_GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query: MORPHO_STABLECOIN_QUERY, variables: { symbols: MORPHO_STABLECOIN_SYMBOLS } }),
      signal,
    }, 1);
    if (!res?.ok) return [];

    const body = (await res.json()) as { data?: { vaults?: { items?: MorphoVaultItem[] } } };
    const items = body.data?.vaults?.items;
    if (!Array.isArray(items)) return [];

    const results: Array<{ symbol: string; yield: ResolvedYield }> = [];
    for (const vault of items) {
      const apy = vault.state?.netApy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

      const tvl = vault.state?.totalAssetsUsd;
      if (typeof tvl !== "number" || tvl < 100_000) continue;

      results.push({
        symbol: vault.asset.symbol,
        yield: {
          currentApy: apy * 100, // Morpho returns decimal (0.03 = 3%)
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.address,
          sourceTvlUsd: tvl,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:morpho-vault:${vault.address.slice(0, 10)}`,
          yieldSource: `Morpho: ${vault.name}`,
          yieldType: "lending-vault",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Morpho vault sources failed:", error);
    return [];
  }
}
```

- [ ] **Step 4: Wire into resolve pipeline**

In `resolve.ts`, add `fetchMorphoVaultSources` to the existing `import { ... } from "./sources"` line. Then add this **after the LUSD B.Protocol block (the `if (lusdMeta` block) and BEFORE the auto-lending discovery `if (dlPools.length > 0)` section**:

```typescript
// Morpho protocol-native vaults — runs once, matched by asset symbol
const morphoVaults = await fetchMorphoVaultSources(signal);
for (const { symbol: assetSymbol, yield: morphoYield } of morphoVaults) {
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
    if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === morphoYield.sourceKey)) continue;
    resolved.push({ id: meta.id, symbol: meta.symbol, yield: morphoYield });
    break;
  }
}
```

- [ ] **Step 5: Add source URL, run tests, commit**

In `yield-source-links.ts`, add (if not already present): `"Morpho": "https://app.morpho.org/"` (already exists — verify).

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-morpho-source.test.ts
git commit -m "feat(yield): add Morpho GraphQL batch adapter for vault APYs"
```

---

### Task 9: Pendle REST API adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-pendle-source.test.ts`

Pendle publishes market APY at `https://api-v2.pendle.finance/core/` (free, 100 CU/min). Pendle lists yield-bearing stablecoin markets (sUSDe, sDAI, sUSDS, etc.) with implied yield — a unique yield dimension.

Like Morpho, this is a batch adapter: one API call, results matched to tracked coins.

- [ ] **Step 1: Probe the Pendle API**

```bash
curl -s "https://api-v2.pendle.finance/core/v2/1/markets?order_by=name%3A1&skip=0&limit=20" | jq '.results[0:3]'
```

Document exact fields: `impliedApy`, `underlyingApy`, `liquidity`, `pt`, `yt`, `expiry`.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-pendle-source.test.ts` following the same pattern as Morpho.

- [ ] **Step 3: Implement the batch fetcher**

**API shape verified 2026-03-25.** Response: `{ total, limit, skip, results: PendleMarket[] }`. Key fields on each market: `impliedApy` (decimal, e.g. 0.052 = 5.2%), `underlyingApy`, `aggregatedApy`, `liquidity.usd` (TVL), `underlyingAsset.symbol`, `categoryIds` (contains `"stables"` for stablecoin markets), `protocol` (source protocol name), `isActive`, `expiry`.

```typescript
const PENDLE_MARKETS_BASE = "https://api-v2.pendle.finance/core/v1";
const PENDLE_CHAINS = [1, 42161, 8453]; // Ethereum, Arbitrum, Base

interface PendleMarket {
  id: string; address: string; chainId: number;
  isActive: boolean; expiry: string;
  impliedApy: number; underlyingApy: number; aggregatedApy: number;
  underlyingAsset: { symbol: string; address: string };
  assetRepresentation: string;
  protocol: string;
  liquidity: { usd: number };
  categoryIds: string[];
}

export async function fetchPendleMarketSources(
  signal?: AbortSignal,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  const results: Array<{ symbol: string; yield: ResolvedYield }> = [];

  for (const chainId of PENDLE_CHAINS) {
    try {
      const url = `${PENDLE_MARKETS_BASE}/${chainId}/markets?limit=100&is_active=true`;
      const res = await fetchWithRetry(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal,
      }, 1);
      if (!res?.ok) continue;

      const body = (await res.json()) as { results?: PendleMarket[] };
      if (!Array.isArray(body.results)) continue;

      for (const market of body.results) {
        // Only stablecoin markets
        if (!market.categoryIds?.includes("stables")) continue;
        if (!market.isActive) continue;

        const apy = market.impliedApy;
        if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

        const tvl = market.liquidity?.usd;
        if (typeof tvl !== "number" || tvl < 100_000) continue;

        results.push({
          symbol: market.assetRepresentation || market.underlyingAsset.symbol,
          yield: {
            currentApy: apy * 100, // Pendle returns decimal (0.052 = 5.2%)
            apyBase: apy * 100,
            apyReward: null,
            sourcePool: market.address,
            sourceTvlUsd: tvl,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: `protocol-api:pendle:${market.address.slice(0, 10)}`,
            yieldSource: `Pendle: ${market.protocol} ${market.assetRepresentation}`,
            yieldType: "lending-vault",
            sourceObservedAt: Math.floor(Date.now() / 1000),
            comparisonAnchorObservedAt: null,
          },
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`[yield] Pendle chain ${chainId} failed:`, error);
    }
  }
  return results;
}
```

Key considerations:
- Pendle has markets on multiple chains (1 = Ethereum, 42161 = Arbitrum, 8453 = Base) — one call per chain
- Use `impliedApy` (market-implied forward yield) as the primary APY — this is the fixed rate you get by buying PT
- Filter by `categoryIds.includes("stables")` for stablecoin markets (81 active on Ethereum alone)
- Rate limit: 100 CU/min — 3 chain calls is well within budget

- [ ] **Step 4: Wire into resolve pipeline**

In `resolve.ts`, add `fetchPendleMarketSources` to the existing `import { ... } from "./sources"` line. Add this **right after the Morpho block** (added in Task 8):

```typescript
// Pendle protocol-native markets — runs once, matched by asset symbol
const pendleMarkets = await fetchPendleMarketSources(signal);
for (const { symbol: assetSymbol, yield: pendleYield } of pendleMarkets) {
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
    if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === pendleYield.sourceKey)) continue;
    resolved.push({ id: meta.id, symbol: meta.symbol, yield: pendleYield });
    break;
  }
}
```

- [ ] **Step 5: Add source URL, run tests, commit**

In `yield-source-links.ts`: `"Pendle": "https://app.pendle.finance/"` (already exists — verify).

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-pendle-source.test.ts
git commit -m "feat(yield): add Pendle REST batch adapter for implied yield markets"
```

---

### Task 10: Yearn Kong GraphQL adapter (broad ERC-4626 scanner)

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-yearn-kong-source.test.ts`

Kong (`kong.yearn.fi/api/gql`) indexes **2,083 ERC-4626 vaults** across 11 chains — 55% are non-Yearn (Morpho MetaMorpho, Spark, Fluid, Curve, Aave strategies, Euler EVK). $16.4B non-Yearn TVL. This makes Kong a valuable broad vault scanner, not just a Yearn-specific source.

**IMPORTANT:** yDaemon (`ydaemon.yearn.fi`) is being discontinued. Use Kong exclusively. Source: https://github.com/yearn/kong

**Strategy:** Fetch ALL stablecoin vaults (both `yearn: true` and `yearn: false`), filter by `meta.category == "Stablecoin"` OR asset symbol matching tracked coins, and match to Pharos stablecoins. This captures Yearn vaults AND non-Yearn ERC-4626 vaults (Spark, Fluid, Morpho curators, etc.) in a single adapter.

Like Morpho/Pendle, this is a batch adapter.

- [ ] **Step 1: Probe the Kong API**

```bash
curl -s -X POST "https://kong.yearn.fi/api/gql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ vaults(chainId: 1, yearn: true) { address name asset { symbol } tvl { close } apy { net monthlyNet } meta { category isRetired } } }"}'
```

Filter for `meta.category == "Stablecoin"` or where `asset.symbol` matches tracked stablecoins.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-yearn-kong-source.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { fetchYearnKongSources } from "../yield-sync/sources";

describe("fetchYearnKongSources", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("extracts stablecoin vault APYs from Kong GraphQL", async () => {
    mockFetch([{
      match: "kong.yearn.fi",
      body: {
        data: {
          vaults: [{
            address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
            name: "USDC-1 yVault",
            asset: { symbol: "USDC" },
            tvl: { close: 31_708_022 },
            apy: { net: 0.0312, monthlyNet: 0.0312 },
            meta: { category: "Stablecoin", isRetired: false },
          }],
        },
      },
    }]);

    const results = await fetchYearnKongSources();
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(expect.objectContaining({
      symbol: "USDC",
      yield: expect.objectContaining({
        currentApy: 3.12,
        dataSource: "protocol-api",
        sourceKey: expect.stringContaining("protocol-api:yearn-kong:"),
        yieldSource: expect.stringContaining("Yearn"),
      }),
    }));
  });

  it("skips retired vaults", async () => {
    mockFetch([{
      match: "kong.yearn.fi",
      body: { data: { vaults: [{
        address: "0x123", name: "Old USDC", asset: { symbol: "USDC" },
        tvl: { close: 1_000_000 }, apy: { net: 0.02, monthlyNet: 0.02 },
        meta: { category: "Stablecoin", isRetired: true },
      }] } },
    }]);

    const results = await fetchYearnKongSources();
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 3: Implement the batch fetcher**

```typescript
const YEARN_KONG_GQL_URL = "https://kong.yearn.fi/api/gql";
const YEARN_KONG_CHAINS = [1, 10, 137, 8453, 42161]; // Ethereum, Optimism, Polygon, Base, Arbitrum

// Fetch ALL ERC-4626 vaults (yearn + non-yearn) — Kong indexes 2,083 vaults
// Non-Yearn vaults include Morpho MetaMorpho, Spark, Fluid, Curve, Euler EVK
const YEARN_KONG_VAULTS_QUERY = `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol }
    tvl { close }
    apy { net monthlyNet }
    meta { category isRetired }
  }
}`;

interface KongVault {
  address: string; name: string; yearn: boolean;
  asset: { symbol: string };
  tvl: { close: number } | null;
  apy: { net: number | null; monthlyNet: number | null } | null;
  meta: { category: string | null; isRetired: boolean | null } | null;
}

export async function fetchYearnKongSources(
  signal?: AbortSignal,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  const results: Array<{ symbol: string; yield: ResolvedYield }> = [];

  // Fetch one chain at a time to stay within connection limits
  for (const chainId of YEARN_KONG_CHAINS) {
    try {
      const res = await fetchWithRetry(YEARN_KONG_GQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: YEARN_KONG_VAULTS_QUERY, variables: { chainId } }),
        signal,
      }, 1);
      if (!res?.ok) continue;

      const body = (await res.json()) as { data?: { vaults?: KongVault[] } };
      const vaults = body.data?.vaults;
      if (!Array.isArray(vaults)) continue;

      for (const vault of vaults) {
        if (vault.meta?.isRetired) continue;
        // Only stablecoin vaults (category-based or symbol match)
        const isStablecoinVault = vault.meta?.category === "Stablecoin";
        if (!isStablecoinVault) continue;

        const netApy = vault.apy?.monthlyNet ?? vault.apy?.net;
        if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;

        const tvl = vault.tvl?.close;
        if (typeof tvl !== "number" || tvl < 100_000) continue;

        // Distinguish Yearn-native vaults from third-party ERC-4626 vaults
        const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
        results.push({
          symbol: vault.asset.symbol,
          yield: {
            currentApy: netApy * 100, // Kong returns decimal (0.031 = 3.1%)
            apyBase: netApy * 100,
            apyReward: null,
            sourcePool: vault.address,
            sourceTvlUsd: tvl,
            dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: `protocol-api:kong:${vault.address.slice(0, 10)}`,
            yieldSource: `${sourcePrefix}: ${vault.name}`,
            yieldType: "lending-vault",
            sourceObservedAt: Math.floor(Date.now() / 1000),
            comparisonAnchorObservedAt: null,
          },
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`[yield] Yearn Kong chain ${chainId} failed:`, error);
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-yearn-kong-source.test.ts`

- [ ] **Step 5: Wire into resolve pipeline**

In `resolve.ts`, add `fetchYearnKongSources` to the existing `import { ... } from "./sources"` line. Add this **right after the Pendle block** (added in Task 9):

```typescript
// Yearn Kong ERC-4626 vaults (Yearn-native + third-party) — runs once, matched by asset symbol
const kongVaults = await fetchYearnKongSources(signal);
for (const { symbol: assetSymbol, yield: kongYield } of kongVaults) {
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
    if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === kongYield.sourceKey)) continue;
    resolved.push({ id: meta.id, symbol: meta.symbol, yield: kongYield });
    break;
  }
}
```

- [ ] **Step 6: Add source URL, run full tests, commit**

In `yield-source-links.ts`, the existing `Yearn` entry already points to `https://app.yearn.fi/` — verify it exists. For non-Yearn Kong vaults, the `yieldSource` field uses `"Kong: <vault name>"` which will fall through to metadata-based URL resolution.

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-yearn-kong-source.test.ts
git commit -m "feat(yield): add Yearn Kong GraphQL batch adapter (replaces yDaemon)"
```

---

### Task 11: Beefy REST API adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts`
- Modify: `worker/src/cron/yield-sync/resolve.ts`
- Modify: `worker/src/lib/yield-source-links.ts`
- Create: `worker/src/cron/__tests__/yield-beefy-source.test.ts`

Beefy publishes vault APYs at `https://api.beefy.finance/apy` (free, no auth, 1000+ vaults across 20+ chains). Provides auto-compounded yield for stablecoin strategies.

- [ ] **Step 1: Probe the Beefy API**

```bash
curl -s "https://api.beefy.finance/apy" | jq 'to_entries | map(select(.key | test("usdc|usdt|dai|frax"; "i"))) | .[0:5]'
curl -s "https://api.beefy.finance/vaults" | jq '[.[] | select(.tokenAddress != null and (.token | test("USDC|USDT|DAI"; "i")))] | .[0:3]'
curl -s "https://api.beefy.finance/tvl" | jq 'to_entries | .[0:3]'
```

Beefy uses vault IDs as keys. APY endpoint returns `{ "vault-id": 0.037 }` (decimal). Vaults endpoint provides metadata. TVL endpoint provides per-vault TVL.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-beefy-source.test.ts`.

- [ ] **Step 3: Implement the batch fetcher**

**API shape verified 2026-03-25.** `/apy` returns flat `{ vaultId: decimal }` (5,744 entries). `/vaults` returns array of vault objects with `id`, `token` (symbol), `assets[]`, `status`, `chain`, `platformId`. Join by vault `id`.

```typescript
const BEEFY_APY_URL = "https://api.beefy.finance/apy";
const BEEFY_VAULTS_URL = "https://api.beefy.finance/vaults";

interface BeefyVault {
  id: string; name: string; token: string;
  assets: string[]; status: string; chain: string;
  platformId: string; tokenAddress: string;
}

export async function fetchBeefySources(
  signal?: AbortSignal,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  try {
    // Fetch APY map and vaults list in parallel
    const [apyRes, vaultsRes] = await Promise.all([
      fetchWithRetry(BEEFY_APY_URL, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal }, 1),
      fetchWithRetry(BEEFY_VAULTS_URL, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal }, 1),
    ]);
    if (!apyRes?.ok || !vaultsRes?.ok) return [];

    const apyMap = (await apyRes.json()) as Record<string, number | null>;
    const vaults = (await vaultsRes.json()) as BeefyVault[];
    if (!Array.isArray(vaults)) return [];

    const results: Array<{ symbol: string; yield: ResolvedYield }> = [];
    for (const vault of vaults) {
      // Single-asset, active stablecoin vaults only
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > 10) continue; // Cap at 1000% to filter broken data

      results.push({
        symbol: vault.assets[0], // Single asset symbol (e.g., "USDC")
        yield: {
          currentApy: apy * 100, // Beefy returns decimal (0.037 = 3.7%)
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.id,
          sourceTvlUsd: null, // TVL requires separate /tvl call — omit for now
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:beefy:${vault.id.slice(0, 30)}`,
          yieldSource: `Beefy: ${vault.name || vault.id}`,
          yieldType: "lending-vault",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Beefy sources failed:", error);
    return [];
  }
}
```

Key considerations:
- Beefy returns ~1000 vaults — filter by `assets.length === 1` (single-exposure) and stablecoin token
- APY is auto-compounded (already annualized)
- TVL endpoint is a separate call — fetch in parallel with APY
- Source key: `protocol-api:beefy:<vault-id-prefix>`

- [ ] **Step 4: Wire into resolve pipeline**

In `resolve.ts`, add `fetchBeefySources` to the existing `import { ... } from "./sources"` line. Add this **right after the Kong block** (added in Task 10):

```typescript
// Beefy auto-compounded vaults — runs once, matched by asset symbol
const beefyVaults = await fetchBeefySources(signal);
for (const { symbol: assetSymbol, yield: beefyYield } of beefyVaults) {
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
    if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === beefyYield.sourceKey)) continue;
    resolved.push({ id: meta.id, symbol: meta.symbol, yield: beefyYield });
    break;
  }
}
```

- [ ] **Step 5: Add source URL, run tests, commit**

In `yield-source-links.ts`: `Beefy: "https://app.beefy.com/"` (add if not present).

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-beefy-source.test.ts
git commit -m "feat(yield): add Beefy Finance REST batch adapter for auto-compounded vault APYs"
```

---

### Task 12: Update about page data source attribution

**Files:**
- Modify: `src/app/about/page.tsx:56` (DATA_SOURCE_GROUPS DEX group)

- [ ] **Step 1: Update the DEX data sources string**

In `src/app/about/page.tsx`, update the DEX group sources string (line 56):

```typescript
sources: "DeFiLlama Yields & Protocols, protocol-native yield APIs (Hashnote, Ondo, Morpho, Pendle, Yearn Kong, Beefy, Aave V3, BIMA Earn), Curve Finance API, ..."
```

- [ ] **Step 2: Build to verify no breakage**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "docs: update about page with new yield data source attributions"
```

---

### Task 13: Upgrade thBILL from rate-derived to on-chain ERC-4626 read

**Files:**
- Modify: `worker/src/cron/yield-config.ts` (add to ON_CHAIN_RATE_CONFIGS, remove from RATE_DERIVED_CONFIGS)
- Test: `worker/src/cron/__tests__/yield-config-registry.test.ts`

thBILL (Theo) is confirmed ERC-4626 at `0x5FA487BCa6158c64046B2813623e20755091DA0b` on Ethereum (verified 2026-03-25, implementation is `IERC4626MultiAsset` with `convertToAssets`). Currently rate-derived (T-bill minus 0bps). Upgrading to on-chain gives actual protocol exchange rate instead of proxy.

- [ ] **Step 1: Verify the contract**

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x5FA487BCa6158c64046B2813623e20755091DA0b","data":"0x07a2d13a00000000000000000000000000000000000000000000000000000000000f4240"},"latest"],"id":1}'
```

Expected: returns a value >= 0xF4240 (1e6), showing NAV appreciation above $1.00.

- [ ] **Step 2: Add to ON_CHAIN_RATE_CONFIGS**

```typescript
{
  stablecoinId: "thbill-theo",
  chain: "ethereum",
  contract: "0x5FA487BCa6158c64046B2813623e20755091DA0b",
  selector: "0x07a2d13a",
  decimals: 6,
  inputAmount: "0x00000000000000000000000000000000000000000000000000000000000f4240",
},
```

- [ ] **Step 3: Remove from RATE_DERIVED_CONFIGS**

Remove the `thbill-theo` entry from `RATE_DERIVED_CONFIGS`. The on-chain source is "deterministic" tier (highest confidence) and will win arbitration anyway, but removing avoids confusing dual-source.

- [ ] **Step 4: Run tests and commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-config-registry.test.ts`

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): upgrade thBILL from rate-derived to on-chain ERC-4626 read"
```

---

### Task 14: Add Aave V3 direct on-chain supply rate adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts` (add Aave rate fetcher)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (wire in after batch adapters)
- Create: `worker/src/cron/__tests__/yield-aave-onchain-source.test.ts`

Aave V3 Pool contract's `getReserveData(address asset)` (selector `0x35ea6a75`) returns `currentLiquidityRate` in RAY units (10^27). This gives us fresh on-chain supply APY for every stablecoin listed on Aave — removing DL intermediation for the largest lending protocol. Covers 10-15 major stablecoins.

- [ ] **Step 1: Probe the contract**

```bash
# getReserveData(address) for USDC on Ethereum Aave V3 Pool
# Pool: 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
# USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2","data":"0x35ea6a75000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"},"latest"],"id":1}'
```

Parse the response to extract `currentLiquidityRate` (RAY field at offset 4, uint128).

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-aave-onchain-source.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { fetchAaveV3SupplyRates } from "../yield-sync/sources";

const mockEvmCall = vi.mocked(fetchEvmCallHexAtBlock);

describe("fetchAaveV3SupplyRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives supply APY from Aave getReserveData currentLiquidityRate", async () => {
    // Mock: currentLiquidityRate = 25000000000000000000000000 (2.5% APR in RAY)
    // This is at offset 4 in the returned struct (uint128 at bytes 64-96)
    const mockResponse = "0x" + "0".repeat(128) + // first two uint128s (configuration, liquidityIndex)
      "00000000000000000000000000000000" + "0000000000000000014adf4b7320334b" + // currentLiquidityRate ~2.5% APR
      "0".repeat(384); // remaining fields
    mockEvmCall.mockResolvedValue(mockResponse as `0x${string}`);

    const results = await fetchAaveV3SupplyRates([
      { chain: "ethereum", pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
    ]);

    expect(results.length).toBe(1);
    expect(results[0].symbol).toBe("USDC");
    expect(results[0].yield.currentApy).toBeGreaterThan(0);
    expect(results[0].yield.dataSource).toBe("protocol-api");
    expect(results[0].yield.sourceKey).toContain("protocol-api:aave-v3-supply:");
  });
});
```

- [ ] **Step 3: Implement the Aave rate fetcher**

In `sources.ts`, add `fetchEvmCallHexAtBlock` to the existing import from `"../../lib/evm-rpc"` (currently only imports `fetchEvmUint256AtBlock`). Also add `getChainRpc` import from `"../../lib/chain-registry"` if not already present.

```typescript
// Aave V3 Pool contracts by chain
const AAVE_V3_POOLS: Record<string, string> = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  optimism: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  polygon: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  avalanche: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};
const AAVE_GET_RESERVE_DATA_SELECTOR = "0x35ea6a75";
const RAY = 10n ** 27n;

interface AaveRateTarget {
  chain: string; pool: string; asset: string; symbol: string;
}

function rayToApy(currentLiquidityRate: bigint): number {
  // Convert RAY rate to APY: ((1 + rate/RAY/secondsPerYear)^secondsPerYear - 1) * 100
  const ratePerSecond = Number(currentLiquidityRate) / Number(RAY) / 31536000;
  return (Math.pow(1 + ratePerSecond, 31536000) - 1) * 100;
}

export async function fetchAaveV3SupplyRates(
  targets: AaveRateTarget[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  const results: Array<{ symbol: string; yield: ResolvedYield }> = [];

  for (const target of targets) {
    try {
      const callData = AAVE_GET_RESERVE_DATA_SELECTOR +
        target.asset.slice(2).toLowerCase().padStart(64, "0");
      const rpc = getChainRpc(chainRpcs, target.chain);
      const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];

      const hex = await fetchEvmCallHexAtBlock(
        target.chain, target.pool, callData, "latest",
        { extraRpcUrls, signal },
      );
      if (!hex || hex === "0x") continue;

      // currentLiquidityRate is the 3rd uint128 in the struct (bytes 64-96)
      // Each uint128 occupies 32 bytes in ABI encoding (left-padded)
      const rateHex = hex.slice(2 + 64 * 2, 2 + 64 * 3); // 3rd 32-byte slot
      const currentLiquidityRate = BigInt("0x" + rateHex);
      if (currentLiquidityRate === 0n) continue;

      const apy = rayToApy(currentLiquidityRate);
      if (!Number.isFinite(apy) || apy <= 0) continue;

      results.push({
        symbol: target.symbol,
        yield: {
          currentApy: apy, apyBase: apy, apyReward: null,
          sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:aave-v3-supply:${target.chain}:${target.asset.slice(0, 10)}`,
          yieldSource: `Aave V3 (${target.chain})`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`[yield] Aave V3 ${target.chain}:${target.symbol} failed:`, error);
    }
  }
  return results;
}
```

- [ ] **Step 4: Build target list and wire into resolve pipeline**

In `resolve.ts`, build Aave targets from tracked stablecoins that have Ethereum contracts, then call the fetcher after the batch adapter section:

```typescript
// Build Aave V3 targets: tracked stablecoins with contracts on Aave-supported chains
const aaveTargets: AaveRateTarget[] = [];
for (const meta of TRACKED_STABLECOINS) {
  for (const contract of meta.contracts ?? []) {
    const pool = AAVE_V3_POOLS[contract.chain];
    if (!pool) continue;
    aaveTargets.push({ chain: contract.chain, pool, asset: contract.address, symbol: meta.symbol });
  }
}
// Batch in groups of 4 to respect connection limit
for (let i = 0; i < aaveTargets.length; i += 4) {
  const batch = aaveTargets.slice(i, i + 4);
  const batchResults = await fetchAaveV3SupplyRates(batch, signal, chainRpcs);
  // Match results to tracked coins by symbol (same as Morpho/Kong pattern)
  for (const { symbol, yield: aaveYield } of batchResults) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === aaveYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: aaveYield });
      break;
    }
  }
}
```

**Important:** Not all stablecoins are listed on Aave. The `getReserveData` call will return empty/zero for unlisted assets — the fetcher handles this gracefully (continues on zero rate). No pre-filtering needed.

- [ ] **Step 5: Add source URL, run tests, commit**

In `yield-source-links.ts`, update existing Aave entry (already there as `"Aave v3": "https://app.aave.com/"`). The on-chain source uses `yieldSource: "Aave V3 (ethereum)"` which won't exact-match the existing key — add:
```typescript
"Aave V3 (ethereum)": "https://app.aave.com/",
"Aave V3 (arbitrum)": "https://app.aave.com/",
"Aave V3 (base)": "https://app.aave.com/",
"Aave V3 (optimism)": "https://app.aave.com/",
"Aave V3 (polygon)": "https://app.aave.com/",
"Aave V3 (avalanche)": "https://app.aave.com/",
```

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/lib/yield-source-links.ts worker/src/cron/__tests__/yield-aave-onchain-source.test.ts
git commit -m "feat(yield): add Aave V3 direct on-chain supply rate adapter"
```

---

### Task 15: DeFiLlama yield history backfill

**Files:**
- Create: `worker/src/cron/yield-history-backfill.ts`
- Create: `worker/src/cron/__tests__/yield-history-backfill.test.ts`
- Modify: `worker/src/api/admin.ts` (or equivalent admin handler to trigger backfill)

When a coin is first tracked or a new DL pool mapping is added, its yield history starts empty. The DL `/chart/{uuid}` endpoint returns full daily history (up to 900 days). This task adds a backfill function that populates `yield_history` with up to 365 days of historical APY data from DL, giving users instant long-range yield charts.

**API verified 2026-03-25:** `GET https://yields.llama.fi/chart/{pool-uuid}` returns `{ status, data: [{ timestamp, tvlUsd, apy, apyBase, apyReward }] }`. Daily resolution, ~140 bytes/point, full history (no pagination). No auth needed.

- [ ] **Step 1: Write failing test**

Create `worker/src/cron/__tests__/yield-history-backfill.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { buildBackfillRows } from "../yield-history-backfill";

describe("buildBackfillRows", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("converts DL chart data to yield_history rows", () => {
    const dlData = [
      { timestamp: "2025-06-01T23:00:00.000Z", tvlUsd: 100_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, il7d: null, apyBase7d: null },
      { timestamp: "2025-06-02T23:00:00.000Z", tvlUsd: 101_000_000, apy: 3.6, apyBase: 3.6, apyReward: null, il7d: null, apyBase7d: null },
    ];

    const rows = buildBackfillRows("usde-ethena", "66985a81-9c51-46ca-9977-42b4fe7bc6df", dlData);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      stablecoin_id: "usde-ethena",
      source_key: "66985a81-9c51-46ca-9977-42b4fe7bc6df",
      apy: 3.5,
      apy_base: 3.5,
      source_tvl_usd: 100_000_000,
      data_source: "defillama-backfill",
    }));
  });

  it("filters to last 365 days", () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 86400 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
    const dlData = [
      { timestamp: twoYearsAgo, tvlUsd: 50_000_000, apy: 2.0, apyBase: 2.0, apyReward: null, il7d: null, apyBase7d: null },
      { timestamp: yesterday, tvlUsd: 100_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, il7d: null, apyBase7d: null },
    ];

    const rows = buildBackfillRows("test-coin", "pool-uuid", dlData);
    expect(rows.length).toBe(1); // Only yesterday's row
  });
});
```

- [ ] **Step 2: Implement the backfill logic**

Create `worker/src/cron/yield-history-backfill.ts`:

```typescript
import { D1_BATCH_SIZE, USER_AGENT } from "../lib/constants";
import { fetchWithRetry } from "../lib/fetch-retry";
import { YIELD_POOL_MAP } from "./yield-config";

const DL_CHART_BASE = "https://yields.llama.fi/chart";
const MAX_BACKFILL_DAYS = 365;

interface DlChartPoint {
  timestamp: string; tvlUsd: number; apy: number;
  apyBase: number | null; apyReward: number | null;
  il7d: number | null; apyBase7d: number | null;
}

interface BackfillRow {
  stablecoin_id: string; source_key: string; recorded_at: number;
  apy: number; apy_base: number | null; apy_reward: number | null;
  source_tvl_usd: number | null; data_source: string;
  is_best: number; warning_signals: string;
}

export function buildBackfillRows(
  stablecoinId: string, sourceKey: string, dlData: DlChartPoint[],
): BackfillRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - MAX_BACKFILL_DAYS * 86400;
  return dlData
    .map((point) => {
      const recordedAt = Math.floor(new Date(point.timestamp).getTime() / 1000);
      if (recordedAt < cutoff) return null;
      if (typeof point.apy !== "number" || !Number.isFinite(point.apy)) return null;
      return {
        stablecoin_id: stablecoinId,
        source_key: sourceKey,
        recorded_at: recordedAt,
        apy: point.apy,
        apy_base: point.apyBase,
        apy_reward: point.apyReward,
        source_tvl_usd: point.tvlUsd,
        data_source: "defillama-backfill",
        is_best: 1,
        warning_signals: "[]",
      };
    })
    .filter((row): row is BackfillRow => row != null);
}

export async function backfillYieldHistory(
  db: D1Database,
  stablecoinId: string,
  signal?: AbortSignal,
): Promise<{ inserted: number; skipped: number }> {
  const poolUuid = YIELD_POOL_MAP[stablecoinId];
  if (!poolUuid) return { inserted: 0, skipped: 0 };

  const res = await fetchWithRetry(`${DL_CHART_BASE}/${poolUuid}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal,
  }, 1);
  if (!res?.ok) return { inserted: 0, skipped: 0 };

  const body = (await res.json()) as { status: string; data?: DlChartPoint[] };
  if (body.status !== "success" || !Array.isArray(body.data)) return { inserted: 0, skipped: 0 };

  const rows = buildBackfillRows(stablecoinId, poolUuid, body.data);
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  // Batch INSERT OR IGNORE to avoid overwriting live sync data
  let inserted = 0;
  for (let i = 0; i < rows.length; i += D1_BATCH_SIZE) {
    const batch = rows.slice(i, i + D1_BATCH_SIZE);
    const stmts = batch.map((row) =>
      db.prepare(
        `INSERT OR IGNORE INTO yield_history
         (stablecoin_id, source_key, recorded_at, apy, apy_base, apy_reward, source_tvl_usd, data_source, is_best, warning_signals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.stablecoin_id, row.source_key, row.recorded_at,
        row.apy, row.apy_base, row.apy_reward, row.source_tvl_usd,
        row.data_source, row.is_best, row.warning_signals,
      ),
    );
    await db.batch(stmts);
    inserted += batch.length;
  }

  return { inserted, skipped: body.data.length - rows.length };
}
```

- [ ] **Step 3: Run tests**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-history-backfill.test.ts`

- [ ] **Step 4: Wire as admin action or conditional sync step**

Option A (recommended): Add as an admin API endpoint so it can be triggered manually:

```typescript
// In worker/src/api/admin.ts or similar:
// POST /api/admin/yield-backfill?coin=usde-ethena
```

Option B: Run conditionally during sync when a coin has fewer than 30 history rows (automatic backfill on first encounter).

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/yield-history-backfill.ts worker/src/cron/__tests__/yield-history-backfill.test.ts
git commit -m "feat(yield): add DeFiLlama yield history backfill for instant 365-day charts"
```

---

### Task 16: Compound V3 direct on-chain supply rates

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts` (add Compound V3 rate fetcher)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (wire in)
- Create: `worker/src/cron/__tests__/yield-compound-v3-source.test.ts`

Compound V3 Comet contracts expose `getUtilization()` (selector `0x7eb71131`) and `getSupplyRate(uint256 utilization)` (selector `0xd955759d`). Returns per-second rate scaled by 1e18. Live-tested: USDC Comet on Ethereum returns 2.51% APY. **16 stablecoin markets across 10 chains** (USDC on 10 chains, USDT on 4, USDS on 2).

Same pattern as Aave V3 (Task 14) — two sequential `eth_call`s per market, batched 4 at a time.

- [ ] **Step 1: Probe the contract**

```bash
# getUtilization() on USDC Comet (Ethereum: 0xc3d688B66703497DAA19211EEdff47f25384cdc3)
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xc3d688B66703497DAA19211EEdff47f25384cdc3","data":"0x7eb71131"},"latest"],"id":1}'
```

Parse utilization, then call `getSupplyRate(utilization)`.

- [ ] **Step 2: Write failing test**

Create `worker/src/cron/__tests__/yield-compound-v3-source.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchCompoundV3SupplyRates } from "../yield-sync/sources";

const mockEvmCall = vi.mocked(fetchEvmUint256AtBlock);

describe("fetchCompoundV3SupplyRates", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("derives APY from Compound V3 per-second supply rate", async () => {
    // First call: getUtilization() returns ~68.77% (687700000000000000n)
    // Second call: getSupplyRate(utilization) returns per-second rate
    mockEvmCall
      .mockResolvedValueOnce(687_700_000_000_000_000n) // utilization
      .mockResolvedValueOnce(795_585_475n); // per-second rate (~2.51% APY)

    const results = await fetchCompoundV3SupplyRates([
      { chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
    ]);

    expect(results.length).toBe(1);
    expect(results[0].yield.currentApy).toBeCloseTo(2.51, 0);
    expect(results[0].yield.sourceKey).toContain("protocol-api:compound-v3-supply:");
  });
});
```

- [ ] **Step 3: Implement the fetcher**

```typescript
const COMPOUND_V3_GET_UTILIZATION = "0x7eb71131";
const COMPOUND_V3_GET_SUPPLY_RATE = "0xd955759d";
const SECONDS_PER_YEAR = 31_536_000;

// Known Comet contract addresses (from github.com/compound-finance/comet deployments)
const COMPOUND_V3_COMETS: Array<{ chain: string; comet: string; symbol: string }> = [
  { chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
  { chain: "ethereum", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", symbol: "USDT" },
  { chain: "ethereum", comet: "0x5D409e56D886231aDAf00c8775665AD0f9897b56", symbol: "USDS" },
  { chain: "base", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", symbol: "USDC" },
  { chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", symbol: "USDC" },
  // ... add more from compound-finance/comet repo deployments/
];

export async function fetchCompoundV3SupplyRates(
  targets: Array<{ chain: string; comet: string; symbol: string }>,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Array<{ symbol: string; yield: ResolvedYield }>> {
  const results: Array<{ symbol: string; yield: ResolvedYield }> = [];

  for (const target of targets) {
    try {
      const rpc = getChainRpc(chainRpcs, target.chain);
      const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];
      const opts = { extraRpcUrls, signal };

      // Step 1: get current utilization
      const utilization = await fetchEvmUint256AtBlock(
        target.chain, target.comet, COMPOUND_V3_GET_UTILIZATION, "latest", opts,
      );
      if (utilization == null) continue;

      // Step 2: get supply rate at current utilization
      const callData = COMPOUND_V3_GET_SUPPLY_RATE +
        utilization.toString(16).padStart(64, "0");
      const perSecondRate = await fetchEvmUint256AtBlock(
        target.chain, target.comet, callData, "latest", opts,
      );
      if (perSecondRate == null || perSecondRate === 0n) continue;

      // Convert per-second rate (1e18 scale) to APY
      const ratePerSecond = Number(perSecondRate) / 1e18;
      const apy = (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
      if (!Number.isFinite(apy) || apy <= 0) continue;

      results.push({
        symbol: target.symbol,
        yield: {
          currentApy: apy, apyBase: apy, apyReward: null,
          sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:compound-v3-supply:${target.chain}:${target.comet.slice(0, 10)}`,
          yieldSource: `Compound V3 (${target.chain})`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`[yield] Compound V3 ${target.chain}:${target.symbol} failed:`, error);
    }
  }
  return results;
}
```

- [ ] **Step 4: Wire into resolve pipeline (after Aave V3 batch)**

In `resolve.ts`, add `fetchCompoundV3SupplyRates` to the existing `import { ... } from "./sources"` line. Add this **right after the Aave V3 batch** (added in Task 14), using the same batching pattern:

```typescript
// Compound V3 direct on-chain rates — batch 4 at a time
for (let i = 0; i < COMPOUND_V3_COMETS.length; i += 4) {
  const batch = COMPOUND_V3_COMETS.slice(i, i + 4);
  const batchResults = await fetchCompoundV3SupplyRates(batch, signal, chainRpcs);
  for (const { symbol: assetSymbol, yield: compYield } of batchResults) {
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.symbol.toUpperCase() !== assetSymbol.toUpperCase()) continue;
      if (resolved.some((e) => e.id === meta.id && e.yield?.sourceKey === compYield.sourceKey)) continue;
      resolved.push({ id: meta.id, symbol: meta.symbol, yield: compYield });
      break;
    }
  }
}
```

Import `COMPOUND_V3_COMETS` from `"./sources"` or define inline in resolve.ts.

- [ ] **Step 5: Add source URLs, run tests, commit**

In `yield-source-links.ts`, add per-chain entries:
```typescript
"Compound V3 (ethereum)": "https://app.compound.finance/",
"Compound V3 (base)": "https://app.compound.finance/",
"Compound V3 (arbitrum)": "https://app.compound.finance/",
```

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/lib/yield-source-links.ts worker/src/cron/__tests__/yield-compound-v3-source.test.ts
git commit -m "feat(yield): add Compound V3 direct on-chain supply rate adapter"
```

---

### Task 17: mTBILL Chainlink-compatible NAV oracle adapter

**Files:**
- Modify: `worker/src/cron/yield-sync/sources.ts` (add oracle reader)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (wire in)
- Create: `worker/src/cron/__tests__/yield-mtbill-oracle-source.test.ts`

mTBILL has a Chainlink AggregatorV3-compatible oracle at `0x056339C044055819E8Db84E71f5f2E1F536b2E5b` (Ethereum, 8 decimals). **Verified 2026-03-25:** Returns NAV $1.05584403, updated same day. Replaces rate-derived T-bill proxy with actual fund NAV.

Same approach as Ondo USDY oracle (Task 7) — read current NAV, compute APY from stored prior NAV.

- [ ] **Step 1: Write failing test**

```typescript
vi.mock("../../lib/evm-rpc", () => ({ fetchEvmCallHexAtBlock: vi.fn() }));
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { fetchMtbillOracleSource } from "../yield-sync/sources";

describe("fetchMtbillOracleSource", () => {
  it("derives APY from mTBILL Chainlink oracle NAV delta", async () => {
    // latestRoundData() returns: roundId, answer (NAV in 8 decimals), startedAt, updatedAt, answeredInRound
    const mockHex = "0x" +
      "0000000000000000000000000000000000000000000000000000000000000156" + // roundId 342
      "00000000000000000000000000000000000000000000000000000000064a6c13" + // answer: 105584403 ($1.0558)
      "0000000000000000000000000000000000000000000000000000000069e2c3d7" + // startedAt
      "0000000000000000000000000000000000000000000000000000000069e2c3d7" + // updatedAt
      "0000000000000000000000000000000000000000000000000000000000000156"; // answeredInRound
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValue(mockHex as `0x${string}`);

    const result = await fetchMtbillOracleSource(
      104500000n, // prior NAV 7 days ago ($1.0450)
      7,
    );
    expect(result).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      sourceKey: "protocol-api:mtbill-oracle",
    }));
    expect(result!.currentApy).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement the fetcher**

```typescript
const MTBILL_ORACLE = "0x056339C044055819E8Db84E71f5f2E1F536b2E5b";
const MTBILL_ORACLE_DECIMALS = 8;
const CHAINLINK_LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData()

export async function fetchMtbillOracleSource(
  prevNavRaw: bigint | null, daysDelta: number,
  signal?: AbortSignal, chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  try {
    const rpc = getChainRpc(chainRpcs, "ethereum");
    const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];
    const hex = await fetchEvmCallHexAtBlock(
      "ethereum", MTBILL_ORACLE, CHAINLINK_LATEST_ROUND_DATA, "latest",
      { extraRpcUrls, signal },
    );
    if (!hex || hex.length < 2 + 64 * 5) return null;

    // answer is the 2nd word (bytes 64-128)
    const answerHex = hex.slice(2 + 64, 2 + 128);
    const navRaw = BigInt("0x" + answerHex);
    const navFloat = Number(navRaw) / 10 ** MTBILL_ORACLE_DECIMALS;
    if (!Number.isFinite(navFloat) || navFloat <= 0) return null;

    if (!prevNavRaw || prevNavRaw === 0n || daysDelta < 1) {
      // Seed: store current NAV for future delta computation
      return {
        currentApy: 0, apyBase: null, apyReward: null,
        sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
        exchangeRate: navFloat, sourceKey: "protocol-api:mtbill-oracle",
        yieldSource: "mTBILL NAV Oracle", yieldType: "nav-appreciation",
        sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
      };
    }

    const prevNavFloat = Number(prevNavRaw) / 10 ** MTBILL_ORACLE_DECIMALS;
    const apy = (Math.pow(navFloat / prevNavFloat, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: navFloat, sourceKey: "protocol-api:mtbill-oracle",
      yieldSource: "mTBILL NAV Oracle", yieldType: "nav-appreciation",
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] mTBILL oracle source failed:", error);
    return null;
  }
}
```

- [ ] **Step 3: Remove mTBILL from RATE_DERIVED_CONFIGS**

In `worker/src/cron/yield-config.ts`, remove the `mtbill-midas` entry from `RATE_DERIVED_CONFIGS` (consistent with Tasks 6 and 13 which remove USTB and thBILL respectively). The oracle source is "curated" tier and will provide more accurate data than the T-bill proxy.

- [ ] **Step 4: Wire into resolve pipeline**

In `resolve.ts`, add `fetchMtbillOracleSource` to the existing `import { ... } from "./sources"` line. Add constant: `const MTBILL_MIDAS_ID = "mtbill-midas";`. Same pattern as Ondo (Task 7) — look up prior NAV from `yield_history` where `source_key = 'protocol-api:mtbill-oracle'`:

```typescript
if (
  id === MTBILL_MIDAS_ID &&
  !resolved.some((e) => e.id === id && e.yield?.sourceKey === "protocol-api:mtbill-oracle")
) {
  const priorRow = await db
    .prepare(
      `SELECT exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = 'protocol-api:mtbill-oracle'
         AND exchange_rate IS NOT NULL
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(MTBILL_MIDAS_ID)
    .first<{ exchange_rate: number; recorded_at: number }>();

  const prevNavBigint = priorRow?.exchange_rate
    ? BigInt(Math.round(priorRow.exchange_rate * 1e8))
    : null;
  const daysDelta = priorRow ? (startSec - priorRow.recorded_at) / 86400 : 0;

  const mtbillYield = await fetchMtbillOracleSource(prevNavBigint, daysDelta, signal, chainRpcs);
  if (mtbillYield) {
    resolved.push({ id, symbol, yield: mtbillYield });
    hasAnySource = true;
  }
}
```

- [ ] **Step 5: Run tests and commit**

Run: `cd worker && npx vitest run src/cron/__tests__/yield-*.test.ts`

```bash
git add worker/src/cron/yield-sync/sources.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/yield-config.ts worker/src/cron/__tests__/yield-mtbill-oracle-source.test.ts
git commit -m "feat(yield): add mTBILL Chainlink NAV oracle adapter, remove rate-derived entry"
```

---

### Task 18: Add SOFR benchmark and update YLDS config

**Files:**
- Modify: `worker/src/lib/constants.ts` (add FRED_SOFR_CSV_URL)
- Modify: `worker/src/cron/fetch-tbill-rate.ts` (fetch SOFR alongside T-bill, store under separate cache key)
- Modify: `worker/src/cron/yield-config.ts` (add `benchmark` field to RATE_DERIVED_CONFIGS, update YLDS)
- Modify: `worker/src/cron/yield-sync/resolve.ts` (support `benchmark: "sofr"` in rate-derived resolution)
- Test: `worker/src/cron/__tests__/yield-cache.test.ts`

YLDS (Figure) accrues at SOFR minus 50bps, but currently uses T-bill (DGS3MO) minus 50bps. SOFR is ~11bps lower (3.63% vs 3.74% on 2026-03-24). Adding SOFR as a parallel benchmark rate matches the contractual formula exactly.

- [ ] **Step 1: Add SOFR URL constant**

In `worker/src/lib/constants.ts`:

```typescript
export const FRED_SOFR_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=SOFR";
```

- [ ] **Step 2: Extend fetch-tbill-rate.ts to also fetch SOFR**

Extract the FRED fetching logic into a reusable helper, call it for both DGS3MO and SOFR. Store SOFR under a separate cache key `sofr_rate` using the same structured benchmark payload format.

- [ ] **Step 3: Add benchmark field to RateDerivedConfig**

```typescript
export interface RateDerivedConfig {
  stablecoinId: string;
  spreadBps: number;
  label: string;
  benchmark?: "tbill" | "sofr"; // NEW: defaults to "tbill"
}

// Update YLDS config:
{ stablecoinId: "ylds-figure", spreadBps: 50, label: "SOFR proxy (net of 0.50% fee)", benchmark: "sofr" },
```

- [ ] **Step 4: Update resolve.ts to read the correct benchmark**

In the rate-derived block (~line 238), look up the appropriate cached rate based on `config.benchmark`:

```typescript
const benchmarkRate = rateDerivedConfig.benchmark === "sofr"
  ? sofrRate  // loaded from cache key "sofr_rate"
  : riskFreeRate; // existing T-bill rate
```

- [ ] **Step 5: Run tests, commit**

```bash
git add worker/src/lib/constants.ts worker/src/cron/fetch-tbill-rate.ts \
       worker/src/cron/yield-config.ts worker/src/cron/yield-sync/resolve.ts \
       worker/src/cron/__tests__/yield-cache.test.ts
git commit -m "feat(yield): add SOFR benchmark for YLDS, matching contractual formula"
```

---

### Task 19: Fluid fToken ERC-4626 on-chain reads

**Files:**
- Modify: `worker/src/cron/yield-config.ts` (add fTokens to ON_CHAIN_RATE_CONFIGS)

Fluid fTokens are ERC-4626 compliant — `convertToAssets` works. Adding to `ON_CHAIN_RATE_CONFIGS` gives direct on-chain supply rates. ~5 stablecoins across ~12 lending markets. Near-zero new code needed.

- [ ] **Step 1: Probe fToken contracts**

```bash
# fUSDC on Ethereum (address from fluid.instadapp.io):
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33","data":"0x07a2d13a0000000000000000000000000000000000000000000000000000000000000064"},"latest"],"id":1}'
```

Verify rate > input (indicates NAV appreciation).

- [ ] **Step 2: Add fToken configs**

Research Fluid's deployed fToken addresses from their docs or contract registry, then add to `ON_CHAIN_RATE_CONFIGS`:

```typescript
// Fluid fTokens — ERC-4626 lending vaults
{ stablecoinId: "usdc-circle", chain: "ethereum", contract: "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", selector: "0x07a2d13a", decimals: 6, inputAmount: "..." },
// fUSDT, fGHO, fEURC, etc. — discover addresses from Fluid docs
```

**Note:** These are lending rates for non-yield-bearing stablecoins. They would show up as alternative yield sources alongside Aave and Compound, giving users a direct comparison of lending rates across protocols.

- [ ] **Step 3: Run tests, commit**

```bash
git add worker/src/cron/yield-config.ts
git commit -m "feat(yield): add Fluid fToken ERC-4626 on-chain lending rates"
```

---

### Task 20: Update documentation and bump methodology version

**Files:**
- Modify: `docs/yield-intelligence.md`
- Modify: `shared/lib/yield-methodology-version.ts`
- Modify: `docs/yield-intelligence-timeline.md`

- [ ] **Step 1: Update yield-intelligence.md**

Add new protocol-native adapters to the data sources section. Update the tier table. Document new protocols in the lending allowlist.

- [ ] **Step 2: Bump methodology version**

In `shared/lib/yield-methodology-version.ts`, add a new version entry:

```typescript
{
  version: "5.0",
  title: "Yield Coverage Expansion — Protocol-Native API Wave",
  date: "2026-03-XX", // actual date
  effectiveAt: Math.floor(Date.now() / 1000), // replace with actual Unix timestamp
  summary:
    "Major yield coverage expansion: 12+ protocol-native adapters, direct on-chain rates for Aave V3 + Compound V3 + Fluid, mTBILL oracle, SOFR benchmark, DL history backfill, expanded lending allowlist.",
  impact: [
    "12 new protocol-native adapters provide direct yield data, reducing DeFiLlama intermediation",
    "Aave V3 + Compound V3 direct on-chain supply rates for all major stablecoins across 10 chains",
    "Fluid fToken ERC-4626 reads add another direct lending protocol source",
    "mTBILL upgraded from T-bill proxy to actual Chainlink NAV oracle",
    "SOFR benchmark added for YLDS, matching contractual formula (was using T-bill proxy)",
    "DeFiLlama yield history backfill gives instant 365-day charts for newly tracked coins",
    "thBILL + USTB upgraded from rate-derived to on-chain ERC-4626 exchange rate reads",
    "Expanded lending protocol allowlist adds 8+ new protocols (Wildcat $235M, Tectonic $100M, etc.)",
    "Lower TVL floor ($25K) captures legitimate lending markets on smaller ecosystems",
    "Kong adapter covers both Yearn-native AND third-party ERC-4626 vaults (2,083 total)",
  ],
  commits: [], // fill during implementation
  reconstructed: false,
},
```

- [ ] **Step 3: Update timeline doc**

Add corresponding entry to `docs/yield-intelligence-timeline.md`.

- [ ] **Step 4: Run merge gate**

Run: `npm run test:merge-gate`

- [ ] **Step 5: Commit**

```bash
git add docs/yield-intelligence.md shared/lib/yield-methodology-version.ts docs/yield-intelligence-timeline.md
git commit -m "docs: yield methodology v5.0 — protocol-native API wave"
```
