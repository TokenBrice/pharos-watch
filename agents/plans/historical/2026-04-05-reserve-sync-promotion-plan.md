# Reserve Sync Live Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote up to 15 stablecoins from curated-validated / proof / curated reserve status to live reserve sync. Phase 1 upgrades 3 existing adapters to independent evidence class (scoring eligibility) and adds 1 new live coin. Phase 2 adds 5 new live coins. Phase 3 adds 0-4 research-dependent live coins. Net new live additions: 6-10 coins (48 → 54-58). Evidence class upgrades: 3 adapters.

**Architecture:** Three-phase approach: (1) upgrade evidence class for adapters that already do independent discovery, (2) reconfigure coins to use existing generic adapters (chainlink-nav, chainlink-por, evm-branch-balances), (3) build new adapter support for coins needing custom data-source integration.

**Tech Stack:** TypeScript, Zod schemas, Cloudflare Workers, EVM RPC calls, Chainlink AggregatorV3 / custom oracle interfaces, HTTP JSON APIs.

---

## File Map

### Phase 1 files (Tier 1: evidence class upgrades)

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/lib/live-reserve-adapters.ts` | Modify | Change evidenceClass for `usdd-data-platform` and `re-metrics`; add `frax-balance-sheet` adapter definition + params schema |
| `shared/types/live-reserves.ts` | Modify | Add `"frax-balance-sheet"` to `LIVE_RESERVE_ADAPTER_KEYS` |
| `shared/lib/live-reserve-display.ts` | Modify | Add `frax-balance-sheet` badge mapping |
| `worker/src/cron/reserve-adapters/frax.ts` | Modify | Export new `fetchFraxBalanceSheetReserves` entrypoint |
| `worker/src/cron/reserve-adapters/index.ts` | Modify | Register `frax-balance-sheet` adapter |
| `shared/data/stablecoins/usd-minor.json` | Modify | Update frxUSD config to use `frax-balance-sheet` adapter |
| `shared/data/stablecoins/usd-major.json` | Modify | Update USDai config to use `usdai-proof-of-reserves` adapter |

### Phase 2 files (Tier 2: existing adapter reuse)

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/data/stablecoins/usd-minor.json` | Modify | Add/update liveReservesConfig for OUSG, feUSD, eUSD |
| `shared/data/stablecoins/non-usd.json` | Modify | Update EURS config to use `chainlink-por` |
| `shared/data/stablecoins/commodity.json` | Modify | Update PAXG config to use `chainlink-por` |

### Phase 3 files (Tier 3: new development)

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/types/live-reserves.ts` | Modify | Add `"frax-net"` to adapter keys (if USSD API discovered) |
| `shared/lib/live-reserve-adapters.ts` | Modify | Add adapter definition for new adapters |
| `shared/lib/live-reserve-display.ts` | Modify | Add badge mappings for new adapters |
| `worker/src/cron/reserve-adapters/frax-net.ts` | Create | Adapter for net.frax.com balance-sheet embeds |
| `worker/src/cron/reserve-adapters/index.ts` | Modify | Register new adapters |
| `shared/data/stablecoins/usd-minor.json` | Modify | Add configs for USSD, Honey, Resupply |

### Test files

| File | Action | Responsibility |
|------|--------|----------------|
| `worker/src/cron/reserve-adapters/__tests__/frax.test.ts` | Modify | Add tests for `frax-balance-sheet` entrypoint |
| `worker/src/cron/reserve-adapters/__tests__/usdd-data-platform.test.ts` | Modify | Add test asserting independent evidence class |
| `worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts` | Create | Verify all promoted adapters have correct evidence class + badge |

---

## Phase 1: Evidence Class Upgrades (Tier 1)

### Task 1: Promote USDD to independent evidence class

The `usdd-data-platform` adapter already does full dynamic composition discovery — it fetches live vault-level collateral from the USDD API, maps 7 vault types to risk-classified slices, and computes percentages dynamically. The display badge is already `"live"` in `ADAPTER_DISPLAY_BADGE_KINDS`. Only the evidence class definition is conservative.

**Files:**
- Modify: `shared/lib/live-reserve-adapters.ts:531-540`

- [ ] **Step 1: Write a test asserting the evidence class is independent**

In file `worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";

describe("evidence class promotions", () => {
  it("usdd-data-platform has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["usdd-data-platform"].evidenceClass).toBe("independent");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`
Expected: FAIL — `"static-validated"` !== `"independent"`

- [ ] **Step 3: Change the evidence class**

In `shared/lib/live-reserve-adapters.ts`, change the `usdd-data-platform` definition:

```typescript
  "usdd-data-platform": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing USDD adapter tests to ensure no regression**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/usdd-data-platform.test.ts`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts shared/lib/live-reserve-adapters.ts
git commit -m "feat(reserves): promote USDD to independent evidence class

The usdd-data-platform adapter already performs full dynamic composition
discovery from the USDD API. Upgrading evidenceClass from static-validated
to independent makes USDD eligible for live badge and stability scoring."
```

---

### Task 2: Promote reUSD (Re Protocol) to independent evidence class

The `re-metrics` adapter scrapes `app.re.xyz/metrics` HTML, extracts embedded Next.js JSON (`initialChainBreakdowns`), and aggregates per-token USD values across chains. This is the same HTML-parsing pattern as `circle-transparency` which is already `independent`. The display badge is already `"live"`.

**Files:**
- Modify: `shared/lib/live-reserve-adapters.ts:469-475`
- Modify: `worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`

- [ ] **Step 1: Add test for re-metrics evidence class**

Append to the existing `evidence-class-promotions.test.ts`:

```typescript
  it("re-metrics has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["re-metrics"].evidenceClass).toBe("independent");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`
Expected: FAIL — `"static-validated"` !== `"independent"` for re-metrics

- [ ] **Step 3: Change the evidence class**

In `shared/lib/live-reserve-adapters.ts`, change the `re-metrics` definition. The adapter returns `"verified"` when chain breakdown timestamps are found, and `"unverified"` otherwise, so add explicit `allowedFreshnessModes` for validation parity with other independent adapters:

```typescript
  "re-metrics": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
```

- [ ] **Step 4: Run all tests**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts src/cron/reserve-adapters/__tests__/re-metrics.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add shared/lib/live-reserve-adapters.ts worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts
git commit -m "feat(reserves): promote reUSD (re-metrics) to independent evidence class

The re-metrics adapter dynamically discovers reserve composition by
parsing embedded Next.js data from app.re.xyz/metrics — same pattern as
circle-transparency. Add allowedFreshnessModes for validation parity."
```

---

### Task 3: Create frax-balance-sheet adapter for frxUSD

The existing `frax` adapter serves both frxUSD (v2 balance-sheet API, full dynamic discovery) and FRAX (legacy combineddata API, returns curated reserves). Since the evidence class is per-adapter, we need a new adapter key for frxUSD's balance-sheet path to give it `independent` evidence class without affecting legacy FRAX.

The implementation reuses the existing `adaptFraxBalanceSheet()` function — no new parsing logic needed.

**Files:**
- Modify: `shared/types/live-reserves.ts:4-36` (add key to array)
- Modify: `shared/lib/live-reserve-adapters.ts` (add definition + params schema)
- Modify: `shared/lib/live-reserve-display.ts:8-41` (add badge mapping)
- Modify: `worker/src/cron/reserve-adapters/frax.ts` (export new entrypoint)
- Modify: `worker/src/cron/reserve-adapters/index.ts` (register adapter)
- Modify: `shared/data/stablecoins/usd-minor.json` (update frxUSD config)
- Modify: `worker/src/cron/reserve-adapters/__tests__/frax.test.ts` (add test)
- Modify: `worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`

- [ ] **Step 1: Add test for the new adapter's evidence class and badge**

Append to `evidence-class-promotions.test.ts`:

```typescript
  it("frax-balance-sheet has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["frax-balance-sheet"].evidenceClass).toBe("independent");
  });
```

- [ ] **Step 2: Add `"frax-balance-sheet"` to `LIVE_RESERVE_ADAPTER_KEYS`**

In `shared/types/live-reserves.ts`, insert `"frax-balance-sheet"` alphabetically after `"frax"`:

```typescript
export const LIVE_RESERVE_ADAPTER_KEYS = [
  "accountable",
  "anzen-usdz",
  "asymmetry",
  "btcfi",
  "chainlink-nav",
  "chainlink-por",
  "circle-transparency",
  "collateral-positions-api",
  "crvusd",
  "curated-validated",
  "dola-inverse",
  "erc4626-single-asset",
  "ethena",
  "evm-branch-balances",
  "falcon",
  "fdusd-transparency",
  "frax",
  "frax-balance-sheet",
  "fx",
  "gho",
  "infinifi",
  "liquity-v1",
  "m0",
  "mento",
  "openeden-usdo",
  "re-metrics",
  "reservoir",
  "sgforge-coinvertible",
  "single-asset",
  "sky-makercore",
  "tether",
  "usdai-proof-of-reserves",
  "usdd-data-platform",
] as const;
```

- [ ] **Step 3: Add adapter definition in `shared/lib/live-reserve-adapters.ts`**

Add to `LIVE_RESERVE_ADAPTER_DEFINITIONS` after the `frax` entry:

```typescript
  "frax-balance-sheet": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
```

Add to `adapterParamsSchemas`:

```typescript
  "frax-balance-sheet": noParamsSchema,
```

- [ ] **Step 4: Add badge mapping in `shared/lib/live-reserve-display.ts`**

Add to `ADAPTER_DISPLAY_BADGE_KINDS` after the `frax` entry:

```typescript
  "frax-balance-sheet": "live",
```

- [ ] **Step 5: Add entrypoint in `worker/src/cron/reserve-adapters/frax.ts`**

Add at the end of the file, before the closing:

```typescript
/**
 * Dedicated balance-sheet adapter entrypoint for coins using the Frax v2
 * balance-sheet API with independent evidence class (e.g. frxUSD).
 * Reuses adaptFraxBalanceSheet — the only difference from fetchFraxReserves
 * is that this entrypoint requires a balance-sheet response and throws if
 * the legacy combineddata format is returned.
 */
export async function fetchFraxBalanceSheetReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax-balance-sheet");
  const payload = await fetchJsonWithRetry<FraxBalanceSheetResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
    ctx,
  );

  if (!isBalanceSheetResponse(payload)) {
    throw new Error("frax-balance-sheet adapter requires a v2 balance-sheet API response");
  }
  return adaptFraxBalanceSheet(payload);
}
```

- [ ] **Step 6: Register in adapter index**

In `worker/src/cron/reserve-adapters/index.ts`:

Add import:
```typescript
import { fetchFraxReserves, fetchFraxBalanceSheetReserves } from "./frax";
```

(If `fetchFraxReserves` is already imported, just add `fetchFraxBalanceSheetReserves` to the existing import.)

Add to `ADAPTER_FNS`:
```typescript
  "frax-balance-sheet": fetchFraxBalanceSheetReserves,
```

- [ ] **Step 7: Update frxUSD coin config**

In `shared/data/stablecoins/usd-minor.json`, update the `frxusd-frax` entry's `liveReservesConfig`:

```json
{
  "adapter": "frax-balance-sheet",
  "version": 2,
  "semantics": "attestation-mix",
  "breakerScope": "frxusd-frax",
  "display": {
    "url": "https://frax.com/transparency",
    "label": "Frax Transparency"
  },
  "inputs": {
    "primary": {
      "kind": "http-json",
      "url": "https://api.frax.finance/v2/frxusd/balance-sheet/latest"
    }
  }
}
```

Only the `"adapter"` field changes from `"frax"` to `"frax-balance-sheet"`.

- [ ] **Step 8: Add adapter test**

Append to `worker/src/cron/reserve-adapters/__tests__/frax.test.ts`. Follow existing test style by testing the pure adapter function directly (no fetch mocking needed):

```typescript
/* ---------- frax-balance-sheet guard (adaptFraxBalanceSheet rejects bad input) ---------- */

describe("adaptFraxBalanceSheet input validation", () => {
  it("throws on empty assets", () => {
    expect(() => adaptFraxBalanceSheet({ totalAssets: 0, assets: [] })).toThrow();
  });

  it("throws on zero totalAssets", () => {
    expect(() => adaptFraxBalanceSheet({ totalAssets: 0, assets: BALANCE_SHEET_SAMPLE.assets })).toThrow();
  });

  it("throws on missing assets array", () => {
    expect(() => adaptFraxBalanceSheet({ totalAssets: 100 })).toThrow();
  });
});
```

These tests verify the guard logic that `fetchFraxBalanceSheetReserves` relies on — if a non-balance-sheet response is passed, `isBalanceSheetResponse()` returns false and the entrypoint throws before reaching `adaptFraxBalanceSheet`.

- [ ] **Step 9: Run all tests**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/frax.test.ts src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`
Expected: All PASS

- [ ] **Step 10: Run type checks**

Run: `cd worker && npx tsc --noEmit && cd .. && npm run build`
Expected: No errors. The `Record<LiveReserveAdapterKey, ...>` types will enforce that every new key has entries in all maps.

- [ ] **Step 11: Commit**

```bash
git add shared/types/live-reserves.ts shared/lib/live-reserve-adapters.ts shared/lib/live-reserve-display.ts worker/src/cron/reserve-adapters/frax.ts worker/src/cron/reserve-adapters/index.ts shared/data/stablecoins/usd-minor.json worker/src/cron/reserve-adapters/__tests__/frax.test.ts worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts
git commit -m "feat(reserves): add frax-balance-sheet adapter, promote frxUSD to live

Creates a dedicated adapter key for the Frax v2 balance-sheet API with
evidenceClass 'independent'. Reuses the existing adaptFraxBalanceSheet()
parser. Switches frxUSD to the new adapter for live reserve tracking."
```

---

### Task 4: Promote USDai to live via usdai-proof-of-reserves adapter

USDai (100% PYUSD) currently uses `curated-validated`. The `usdai-proof-of-reserves` adapter already exists and works for sUSDai, hitting the same USD.AI API. Switch USDai to use it.

**Files:**
- Modify: `shared/data/stablecoins/usd-major.json` (update USDai config)
- Modify: `worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`

- [ ] **Step 1: Add test**

Append to `evidence-class-promotions.test.ts`:

```typescript
  it("usdai-proof-of-reserves has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["usdai-proof-of-reserves"].evidenceClass).toBe("independent");
  });
```

- [ ] **Step 2: Run test to confirm it passes (adapter already is independent)**

Run: `cd worker && npx vitest run src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts`
Expected: PASS (usdai-proof-of-reserves is already `independent`)

- [ ] **Step 3: Update USDai coin config**

In `shared/data/stablecoins/usd-major.json`, replace the `usdai-usd-ai` entry's `liveReservesConfig`:

```json
{
  "adapter": "usdai-proof-of-reserves",
  "version": 2,
  "semantics": "collateral-mix",
  "breakerScope": "usdai-usd-ai",
  "display": {
    "url": "https://app.usd.ai/reserves",
    "label": "USD.AI Reserves"
  },
  "inputs": {
    "primary": {
      "kind": "http-json",
      "url": "https://api.usd.ai/usdai/dashboard/proof-of-reserves?chainId=42161"
    }
  }
}
```

Changes from original:
- `adapter`: `"curated-validated"` → `"usdai-proof-of-reserves"`
- `version`: `1` → `2`
- `semantics`: `"single-asset"` → `"collateral-mix"`
- `inputs.primary`: `onchain-evm` → `http-json` with the API URL (same URL used by sUSDai)

- [ ] **Step 4: Run type check and build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/usd-major.json worker/src/cron/reserve-adapters/__tests__/evidence-class-promotions.test.ts
git commit -m "feat(reserves): promote USDai to live via usdai-proof-of-reserves adapter

Switches USDai from curated-validated to the existing usdai-proof-of-reserves
adapter (same API already used by sUSDai). Enables live reserve tracking."
```

---

## Phase 2: Existing Adapter Reuse (Tier 2)

### Task 5: Add OUSG to live tracking via chainlink-nav

OUSG (Ondo) has the same `getPrice()` oracle interface as USDY, which already uses `chainlink-nav`. The oracle address is `0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094`.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (add liveReservesConfig to OUSG)

- [ ] **Step 1: Verify the oracle is reachable on-chain**

Run the following to call `getPrice()` (selector `0x98d5fdca`) on the oracle:

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094","data":"0x98d5fdca"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); v=int(r['result'],16); print(f'getPrice() = {v} ({v/1e18:.6f} USD)')"
```

Expected: A price around $100-110 (OUSG is a NAV token, not $1-pegged).

- [ ] **Step 2: Verify the token address total supply**

The OUSG token is at `0x1b19c19393e2d034d8ff31ff34c81252fcbbee92`. Call `totalSupply()`:

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x1b19c19393e2d034d8ff31ff34c81252fcbbee92","data":"0x18160ddd"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); v=int(r['result'],16); print(f'totalSupply = {v} ({v/1e18:.2f} tokens)')"
```

Expected: Non-zero supply.

- [ ] **Step 3: Add liveReservesConfig to OUSG**

In `shared/data/stablecoins/usd-minor.json`, add to the `ousg-ondo-finance` entry:

```json
"liveReservesConfig": {
  "adapter": "chainlink-nav",
  "version": 1,
  "semantics": "single-asset",
  "breakerScope": "ousg-ondo",
  "display": {
    "url": "https://ondo.finance/ousg",
    "label": "Ondo NAV Oracle"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "etherscan-proxy"
    }
  },
  "params": {
    "oracleAddress": "0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094",
    "tokenAddress": "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92",
    "assetLabel": "BlackRock BUIDL (U.S. T-bills, cash, repos)",
    "assetRisk": "low",
    "oracleMethod": "getPrice"
  }
}
```

This mirrors the USDY config pattern exactly (same oracle method, same rpcMode).

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): add live OUSG reserve tracking via chainlink-nav

OUSG uses the same getPrice() oracle interface as USDY. Oracle at
0x9Cad...4094 provides NAV per share. Enables live reserve tracking."
```

---

### Task 6: Promote feUSD (Felix) to live via evm-branch-balances

feUSD is a Liquity V2 fork on HyperEVM. Each collateral branch has an ActivePool holding the collateral tokens. This is the same pattern as BOLD on Ethereum.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (update feUSD config)

- [ ] **Step 1: Research ActivePool addresses on HyperEVM**

Query the CollateralRegistry at `0x9de1e57049c475736289cb006212f3e1dce4711b` for each TroveManager, then get each TroveManager's ActivePool.

Known contracts from Felix docs:
- WHYPE TroveManager: `0x3100f4e7bda2ed2452d9a57eb30260ab071bbe62`
- kHYPE TroveManager: `0x7c07bb77b1cf9a5b40d92f805c10d90c90957e4a`
- UBTC TroveManager: `0xbbe5f227275f24b64bd290a91f55723a00214885`
- wstHYPE TroveManager: `0x58446c58caa8a6f6cc8be343f812ebf0b997c001`

For each TroveManager, call `activePool()` (selector `0xae6e0571`) to get the ActivePool address:

```bash
# Example for WHYPE TroveManager:
curl -s -X POST https://rpc.hyperliquid.xyz/evm -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x3100f4e7bda2ed2452d9a57eb30260ab071bbe62","data":"0xae6e0571"},"latest"],"id":1}'
```

Also find each collateral token address by calling `collToken()` (selector `0x0d090427`) on each TroveManager:

```bash
curl -s -X POST https://rpc.hyperliquid.xyz/evm -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x3100f4e7bda2ed2452d9a57eb30260ab071bbe62","data":"0x0d090427"},"latest"],"id":1}'
```

Repeat for all 4 TroveManagers. Record the results.

- [ ] **Step 2: Verify balance reads work**

For each discovered ActivePool + token pair, call `balanceOf(activePool)` on the token contract:

```bash
# ERC-20 balanceOf selector: 0x70a08231 + 32-byte padded address
curl -s -X POST https://rpc.hyperliquid.xyz/evm -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<TOKEN_ADDRESS>","data":"0x70a08231000000000000000000000000<ACTIVE_POOL_NO_0x>"},"latest"],"id":1}'
```

Expected: Non-zero balances for active branches.

- [ ] **Step 3: Update feUSD config with discovered addresses**

In `shared/data/stablecoins/usd-minor.json`, replace the `feusd-felix` entry's `liveReservesConfig`:

```json
"liveReservesConfig": {
  "adapter": "evm-branch-balances",
  "version": 1,
  "semantics": "collateral-mix",
  "breakerScope": "feusd-felix",
  "display": {
    "url": "https://usefelix.xyz/",
    "label": "Felix Protocol"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "hyperevm",
      "rpcMode": "public-rpc"
    }
  },
  "params": {
    "rpcUrl": "https://rpc.hyperliquid.xyz/evm",
    "branches": [
      {
        "name": "WHYPE",
        "holder": "<WHYPE_ACTIVE_POOL>",
        "token": {
          "chain": "hyperevm",
          "address": "0x5555555555555555555555555555555555555555",
          "decimals": 18
        },
        "risk": "very-high"
      },
      {
        "name": "kHYPE (KittenFinance)",
        "holder": "<KHYPE_ACTIVE_POOL>",
        "token": {
          "chain": "hyperevm",
          "address": "<KHYPE_TOKEN>",
          "decimals": 18
        },
        "risk": "very-high"
      },
      {
        "name": "UBTC (bridged Bitcoin)",
        "holder": "<UBTC_ACTIVE_POOL>",
        "token": {
          "chain": "hyperevm",
          "address": "<UBTC_TOKEN>",
          "decimals": 8
        },
        "risk": "medium"
      },
      {
        "name": "wstHYPE",
        "holder": "<WSTHYPE_ACTIVE_POOL>",
        "token": {
          "chain": "hyperevm",
          "address": "<WSTHYPE_TOKEN>",
          "decimals": 18
        },
        "risk": "very-high"
      }
    ]
  }
}
```

Replace all `<PLACEHOLDER>` values with addresses discovered in Step 1. Omit branches whose TroveManagers returned zero supply or whose ActivePools returned empty balances.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): promote feUSD to live via evm-branch-balances

Felix is a Liquity V2 fork on HyperEVM. Read collateral balances from
each branch's ActivePool contract, same pattern as BOLD on Ethereum."
```

---

### Task 7: Promote EURS to live via chainlink-por

EURS (Stasis Euro) has a Chainlink Proof-of-Reserves feed registered at ENS `eurr-reserves.data.eth` with 10-minute update cadence.

**Evidence class change:** This switches EURS from `single-asset` (evidenceClass `"weak-live-probe"`, badge `"Proof"`) to `chainlink-por` (evidenceClass `"independent"`, badge `"Live"`). The Chainlink PoR feed provides independent on-chain attestation of euro reserves held at licensed EU institutions — this is a genuine independent reserve verification, not a self-reported supply echo. Verify this in Step 2.

**Files:**
- Modify: `shared/data/stablecoins/non-usd.json` (update EURS config)

- [ ] **Step 1: Resolve the PoR feed address**

Resolve the ENS name to a contract address:

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41","data":"0x3b3b57de'"$(python3 -c "import hashlib; n='eurr-reserves.data.eth'.split('.'); h=b'\\x00'*32; [h:=hashlib.sha3_256(h+hashlib.sha3_256(p.encode()).digest()).digest() for p in reversed(n)]; print(h.hex())")"'"},"latest"],"id":1}'
```

If ENS resolution is complex, search Chainlink's documentation or use:

```bash
# Alternative: search Etherscan for the known EURS PoR feed
# The feed address from Chainlink registry is: 0x652A13B893BEe5F862e15A56da5a4cDC1bA1Ac2d
# Verify by calling decimals() and latestRoundData()
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x652A13B893BEe5F862e15A56da5a4cDC1bA1Ac2d","data":"0x313ce567"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'decimals = {int(r[\"result\"],16)}')"
```

- [ ] **Step 2: Verify the feed returns valid data**

Call `latestRoundData()` (selector `0xfeaf968c`):

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x652A13B893BEe5F862e15A56da5a4cDC1bA1Ac2d","data":"0xfeaf968c"},"latest"],"id":1}'
```

Expected: Valid response with 5 ABI-encoded uint256 values (roundId, answer, startedAt, updatedAt, answeredInRound). The `updatedAt` should be recent (within 24h).

**Critical verification:** Decode the `answer` field and compare it against the known EURS total supply. If the answer equals the EURS total supply, this is a **supply feed**, not a reserves feed — do NOT use it as chainlink-por (that would be misleading). A genuine PoR feed reports the amount of euros held in custody, which may differ from supply. If the answer is close to but not identical to total supply, it likely reports actual reserves.

- [ ] **Step 3: Update EURS config**

In `shared/data/stablecoins/non-usd.json`, replace the `eurs-stasis` entry's `liveReservesConfig`:

```json
"liveReservesConfig": {
  "adapter": "chainlink-por",
  "version": 1,
  "semantics": "single-asset",
  "breakerScope": "eurs-stasis",
  "display": {
    "url": "https://stasis.net/transparency",
    "label": "STASIS Transparency"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "public-rpc"
    }
  },
  "params": {
    "porFeedAddress": "0x652A13B893BEe5F862e15A56da5a4cDC1bA1Ac2d",
    "assetLabel": "Euro fiat reserves",
    "assetRisk": "very-low",
    "maxOracleAgeSec": 3600
  }
}
```

`maxOracleAgeSec: 3600` (1 hour) matches the 10-minute update cadence — the adapter will warn if the feed goes stale beyond 1 hour.

**Important:** The `porFeedAddress` above (`0x652A...Ac2d`) must be verified in Step 1. If the address is different, use the correct one.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/non-usd.json
git commit -m "feat(reserves): promote EURS to live via chainlink-por

EURS has a Chainlink Proof-of-Reserves feed (eurr-reserves.data.eth)
with 10-minute update cadence. Switches from single-asset supply probe
to independent on-chain reserve verification."
```

---

### Task 8: Promote PAXG to live via chainlink-por

PAX Gold has a Chainlink PoR feed that attests to physical gold reserves.

**Evidence class change:** This switches PAXG from `single-asset` (evidenceClass `"weak-live-probe"`, badge `"Proof"`) to `chainlink-por` (evidenceClass `"independent"`, badge `"Live"`). The Chainlink PoR feed must report actual gold bar holdings (not token supply). Verify in Step 2.

**Files:**
- Modify: `shared/data/stablecoins/commodity.json` (update PAXG config)

- [ ] **Step 1: Find the PAXG PoR feed address**

Search Chainlink's PoR feed registry. The known address for the PAXG supply feed is `0x716BB759A5f6faCdfF91F0AfB613f64a1643858D` (PAXG Reserves). Verify:

```bash
# Call decimals()
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x716BB759A5f6faCdfF91F0AfB613f64a1643858D","data":"0x313ce567"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'decimals = {int(r[\"result\"],16)}')"

# Call latestRoundData()
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x716BB759A5f6faCdfF91F0AfB613f64a1643858D","data":"0xfeaf968c"},"latest"],"id":1}'
```

Expected: Valid PoR data. If this address returns errors, search for the correct PAXG PoR feed address in [Chainlink's data feeds list](https://data.chain.link/feeds) or on Etherscan by searching for "PAX Gold" proof of reserves.

- [ ] **Step 2: Verify data freshness**

Parse the `updatedAt` from `latestRoundData()` response. The Chainlink PAXG PoR feed updates every 24h or on 5% deviation. Confirm `updatedAt` is within 48 hours.

**Critical verification:** Decode the `answer` field and compare it against the known PAXG total supply (call `totalSupply()` on PAXG token `0x45804880De22913dAFE09f4980848ECE6EcbAf78`). A genuine gold reserves PoR feed reports the quantity of gold ounces (or equivalent value) held in Brink's vaults, which may differ from token supply. If the answer exactly equals the token total supply, this is a **supply feed** and must NOT be used as `chainlink-por` — stay on `single-asset` instead.

- [ ] **Step 3: Update PAXG config**

In `shared/data/stablecoins/commodity.json`, replace the `paxg-paxos` entry's `liveReservesConfig`:

```json
"liveReservesConfig": {
  "adapter": "chainlink-por",
  "version": 1,
  "semantics": "single-asset",
  "breakerScope": "paxg-paxos",
  "display": {
    "url": "https://www.paxos.com/paxg-transparency",
    "label": "Paxos Transparency"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "public-rpc"
    }
  },
  "params": {
    "porFeedAddress": "0x716BB759A5f6faCdfF91F0AfB613f64a1643858D",
    "assetLabel": "Physical gold bars (LBMA Good Delivery, Brink's London vaults)",
    "assetRisk": "very-low",
    "maxOracleAgeSec": 172800
  }
}
```

`maxOracleAgeSec: 172800` (48 hours) allows for one missed 24h update cycle before warning.

**Important:** Replace `porFeedAddress` with the verified address from Step 1 if different.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add shared/data/stablecoins/commodity.json
git commit -m "feat(reserves): promote PAXG to live via chainlink-por

PAX Gold has a Chainlink Proof-of-Reserves feed attesting to LBMA
Good Delivery gold bars in Brink's London vaults. Upgrades from
supply-only probe to independent on-chain reserve verification."
```

---

### Task 9: Add eUSD (Electronic USD) to live tracking via evm-branch-balances

Reserve Protocol's eUSD is an RToken backed by cUSDCv3, aUSDCv3, and cUSDTv3. The collateral tokens are held by the RToken's BackingManager contract on Ethereum.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (add liveReservesConfig to eUSD)

- [ ] **Step 1: Find the BackingManager address**

The eUSD RToken is at `0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f`. Call `main()` to get the Main contract, then `backingManager()`:

```bash
# Call main() on the RToken (selector 0xd4aae0c4)
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f","data":"0xd4aae0c4"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'main = 0x{r[\"result\"][-40:]}')"
```

Then call `backingManager()` on the Main contract (selector `0x498b5828`):

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<MAIN_ADDRESS>","data":"0x498b5828"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'backingManager = 0x{r[\"result\"][-40:]}')"
```

- [ ] **Step 2: Find the collateral token addresses**

The eUSD basket collateral tokens are:
- Compound V3 USDC (cUSDCv3): `0xc3d688B66703497DAA19211EEdff47f25384cdc3`
- Aave V3 USDC (aEthUSDC / saUSDC wrapper): Discover via `basketHandler().basket()`
- Compound V3 USDT (cUSDTv3): `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840`

Call `basketHandler()` on Main (selector `0xc2138a48`), then call `getBackingTokens()` or enumerate the basket:

```bash
# Get basketHandler
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<MAIN_ADDRESS>","data":"0xc2138a48"},"latest"],"id":1}' | python3 -c "import json,sys; r=json.load(sys.stdin); print(f'basketHandler = 0x{r[\"result\"][-40:]}')"
```

- [ ] **Step 3: Verify balances at the BackingManager**

For each collateral token, call `balanceOf(backingManager)`:

```bash
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<TOKEN>","data":"0x70a08231000000000000000000000000<BACKING_MANAGER_NO_0x>"},"latest"],"id":1}'
```

Expected: Non-zero balances for all 3 collateral tokens.

- [ ] **Step 4: Add liveReservesConfig**

In `shared/data/stablecoins/usd-minor.json`, add to the `eusd-electronic-usd` entry:

```json
"liveReservesConfig": {
  "adapter": "evm-branch-balances",
  "version": 1,
  "semantics": "collateral-mix",
  "breakerScope": "eusd-electronic-usd",
  "display": {
    "url": "https://app.reserve.org/ethereum/token/0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f/overview",
    "label": "Reserve Protocol"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "alchemy"
    }
  },
  "params": {
    "branches": [
      {
        "name": "Compound V3 USDC (cUSDCv3)",
        "holder": "<BACKING_MANAGER>",
        "token": {
          "chain": "ethereum",
          "address": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
          "decimals": 6
        },
        "risk": "low",
        "coinId": "usdc-circle",
        "depType": "wrapper"
      },
      {
        "name": "Aave V3 USDC (aUSDCv3 wrapper)",
        "holder": "<BACKING_MANAGER>",
        "token": {
          "chain": "ethereum",
          "address": "<AAVE_WRAPPER_ADDRESS>",
          "decimals": 6
        },
        "risk": "low",
        "coinId": "usdc-circle",
        "depType": "wrapper"
      },
      {
        "name": "Compound V3 USDT (cUSDTv3)",
        "holder": "<BACKING_MANAGER>",
        "token": {
          "chain": "ethereum",
          "address": "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
          "decimals": 6
        },
        "risk": "low",
        "coinId": "usdt-tether",
        "depType": "wrapper"
      }
    ]
  }
}
```

Replace all `<PLACEHOLDER>` values with addresses discovered in Steps 1-2.

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): add live eUSD reserve tracking via evm-branch-balances

eUSD (Reserve Protocol) holds cUSDCv3 + aUSDCv3 + cUSDTv3 in its
BackingManager. Read collateral token balances on-chain for live tracking."
```

---

## Phase 3: New Development (Tier 3)

### Task 10: Add USSD (Sonic Labs) to live tracking

USSD uses Frax's infrastructure (built on frxUSD). The PoR page is at `net.frax.com/embed/balance-sheet/<address>`. The direct v2 API path for USSD (`/v2/ussd/`) returns 404. Research is needed to find a machine-readable endpoint.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json` (add liveReservesConfig)
- Potentially create: new adapter if custom parsing needed

- [ ] **Step 1: Research the Frax net API for USSD**

Try alternative API paths that might serve the balance-sheet data:

```bash
# Try address-based path (USSD contract: 0x000000000eCcFf26B795F73fb0A70d48da657fEf)
curl -s "https://api.frax.finance/v2/balance-sheet/0x000000000eCcFf26B795F73fb0A70d48da657fEf/latest" | head -c 500

# Try the net.frax.com API directly
curl -s "https://net.frax.com/api/balance-sheet/0x000000000eCcFf26B795F73fb0A70d48da657fEf" | head -c 500

# Try the embed page content-type negotiation
curl -s -H "Accept: application/json" "https://net.frax.com/embed/balance-sheet/0x000000000eCcFf26B795F73fb0A70d48da657fEf" | head -c 500
```

- [ ] **Step 2: If a JSON API exists, use frax-balance-sheet adapter**

If any of the above returns a `FraxBalanceSheetResponse`-shaped JSON:

Add to `shared/data/stablecoins/usd-minor.json`:

```json
"liveReservesConfig": {
  "adapter": "frax-balance-sheet",
  "version": 1,
  "semantics": "attestation-mix",
  "breakerScope": "ussd-sonic-labs",
  "display": {
    "url": "https://net.frax.com/embed/balance-sheet/0x000000000eCcFf26B795F73fb0A70d48da657fEf",
    "label": "Frax Balance Sheet"
  },
  "inputs": {
    "primary": {
      "kind": "http-json",
      "url": "<DISCOVERED_API_URL>"
    }
  }
}
```

- [ ] **Step 3: If no JSON API exists, build HTML adapter**

If only the embed page works, create `worker/src/cron/reserve-adapters/frax-net.ts` that:
1. Fetches the embed HTML
2. Extracts the Next.js embedded JSON (same pattern as `re-metrics`)
3. Parses it using `adaptFraxBalanceSheet()` (reuse the existing parser)

This requires:
- Adding `"frax-net"` to `LIVE_RESERVE_ADAPTER_KEYS`
- Adding adapter definition with `evidenceClass: "independent"`
- Adding badge mapping
- Registering the adapter

- [ ] **Step 4: If neither works, defer**

If the embed page also blocks programmatic access, defer USSD and file a research note.

- [ ] **Step 5: Commit (if successful)**

Stage only the files that were modified (adapter source, type definitions, data JSON, display mapping):

```bash
git add shared/data/stablecoins/usd-minor.json
# If a new adapter was created, also add:
# git add shared/types/live-reserves.ts shared/lib/live-reserve-adapters.ts shared/lib/live-reserve-display.ts worker/src/cron/reserve-adapters/frax-net.ts worker/src/cron/reserve-adapters/index.ts
git commit -m "feat(reserves): add live USSD reserve tracking via Frax balance-sheet

USSD uses Frax infrastructure for reserves. Tracks composition via
the Frax balance-sheet API/embed."
```

---

### Task 11: Research and add Honey (Berachain) to live tracking

Honey is Berachain's native stablecoin backed by USDC, USDT0, pyUSD, BYUSD, and USDe via PSM vaults.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json`

- [ ] **Step 1: Research Honey PSM vault addresses**

```bash
# Search for Honey contract documentation
# Honey contract: not in our data files yet (curated-only)
# Check Berachain docs or explorer for PSM vault addresses
# Try calling the Honey contract to find vault/collateral addresses
```

Look for:
- The PSM/Honey minting contract address on Berachain
- The vault addresses holding USDC, USDT0, pyUSD, BYUSD, USDe
- Berachain RPC endpoint (likely `https://rpc.berachain.com` or similar)

- [ ] **Step 2: Verify balance reads on Berachain RPC**

For each vault address + token pair, test `balanceOf()` calls via the Berachain RPC.

- [ ] **Step 3: Configure evm-branch-balances**

If vault addresses are found, add liveReservesConfig using `evm-branch-balances`:

```json
"liveReservesConfig": {
  "adapter": "evm-branch-balances",
  "version": 1,
  "semantics": "collateral-mix",
  "breakerScope": "honey-berachain",
  "display": {
    "url": "https://honey.berachain.com/",
    "label": "Berachain Honey"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "berachain",
      "rpcMode": "public-rpc"
    }
  },
  "params": {
    "rpcUrl": "<BERACHAIN_RPC>",
    "branches": [
      {
        "name": "USDC",
        "holder": "<VAULT_ADDRESS>",
        "token": { "chain": "berachain", "address": "<USDC_ON_BERA>", "decimals": 6 },
        "risk": "low",
        "coinId": "usdc-circle"
      }
    ]
  }
}
```

- [ ] **Step 4: If successful, commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): add live Honey reserve tracking via evm-branch-balances

Read PSM vault balances on Berachain for USDC, USDT0, pyUSD, BYUSD, USDe."
```

---

### Task 12: Research and add Resupply USD to live tracking

Resupply USD is backed by Curve Lend + Fraxlend vault shares on Ethereum. The vault share tokens are ERC-20s held by the Resupply protocol contracts.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json`

- [ ] **Step 1: Research Resupply contracts**

The Resupply USD token is at `0x57ab1e0003f623289cd798b1824be09a793e4bec` on Ethereum.

```bash
# Find the collateral registry or vault manager
# Check GitHub: https://github.com/resupplyfi/resupply
# Look for a "PairRegistry" or "Controller" contract

# Try calling common view functions on the token contract:
# totalSupply()
curl -s -X POST https://eth.llamarpc.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x57ab1e0003f623289cd798b1824be09a793e4bec","data":"0x18160ddd"},"latest"],"id":1}'
```

Look for:
- The vault/collateral manager contract
- Which Curve Lend and Fraxlend vault share tokens are held
- The holder address(es) where vault shares are deposited

- [ ] **Step 2: Verify vault share balance reads**

For each discovered vault share token + holder pair, test `balanceOf()`.

- [ ] **Step 3: Configure evm-branch-balances**

```json
"liveReservesConfig": {
  "adapter": "evm-branch-balances",
  "version": 1,
  "semantics": "collateral-mix",
  "breakerScope": "reusd-resupply",
  "display": {
    "url": "https://resupply.fi/",
    "label": "Resupply Finance"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "alchemy"
    }
  },
  "params": {
    "branches": [
      {
        "name": "Curve Lend crvUSD vault shares",
        "holder": "<RESUPPLY_CONTROLLER>",
        "token": { "chain": "ethereum", "address": "<CURVE_VAULT_SHARE>", "decimals": 18 },
        "risk": "high",
        "coinId": "crvusd-curve"
      },
      {
        "name": "Fraxlend frxUSD vault shares",
        "holder": "<RESUPPLY_CONTROLLER>",
        "token": { "chain": "ethereum", "address": "<FRAX_VAULT_SHARE>", "decimals": 18 },
        "risk": "high",
        "coinId": "frxusd-frax"
      }
    ]
  }
}
```

- [ ] **Step 4: If successful, commit**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): add live Resupply USD tracking via evm-branch-balances

Read Curve Lend and Fraxlend vault share balances on Ethereum."
```

---

### Task 13: Research pmUSD Chainlink PoR feed

pmUSD (RAAC Precious Metals USD) mentions "Chainlink proof-of-reserves feeds attest to gold holdings in real time" via Chainlink/Instruxi.

**Files:**
- Modify: `shared/data/stablecoins/usd-minor.json`

- [ ] **Step 1: Find the pmUSD PoR feed address**

Search for the Chainlink/Instruxi PoR feed for ION.au gold:

```bash
# Check if there's a feed for ION.au or pmUSD on Chainlink
# Search Etherscan for contracts mentioning "ION" or "pmUSD" or "Instruxi"
# Check pmusd.raac.io for contract addresses
```

- [ ] **Step 2: If standard Chainlink interface, use chainlink-por**

If the feed uses standard `AggregatorV3Interface` (`latestRoundData`):

```json
"liveReservesConfig": {
  "adapter": "chainlink-por",
  "version": 1,
  "semantics": "single-asset",
  "breakerScope": "pmusd-raac",
  "display": {
    "url": "https://pmusd.raac.io/",
    "label": "RAAC pmUSD"
  },
  "inputs": {
    "primary": {
      "kind": "onchain-evm",
      "chain": "ethereum",
      "rpcMode": "public-rpc"
    }
  },
  "params": {
    "porFeedAddress": "<FEED_ADDRESS>",
    "assetLabel": "ION.au tokenized gold (Chainlink PoR attested)",
    "assetRisk": "medium"
  }
}
```

- [ ] **Step 3: If non-standard interface, defer or build custom adapter**

- [ ] **Step 4: Commit if successful**

```bash
git add shared/data/stablecoins/usd-minor.json
git commit -m "feat(reserves): add live pmUSD reserve tracking via chainlink-por

ION.au gold holdings attested by Chainlink/Instruxi PoR feed."
```

---

### Task 14: Final validation and cleanup

- [ ] **Step 1: Run the full merge gate**

```bash
npm run test:merge-gate
```

Expected: All checks pass.

- [ ] **Step 2: Verify evidence class test file covers all promotions**

Ensure `evidence-class-promotions.test.ts` has assertions for every promoted adapter.

- [ ] **Step 3: Update documentation**

Evidence class changes affect scoring eligibility and badge display. Update the methodology page and relevant docs:

1. Check `src/app/methodology/` for any hardcoded live reserve counts and update them
2. Check `src/app/about/` for reserve coverage statistics
3. If the `/methodology` page describes evidence class semantics, verify the descriptions remain accurate
4. Check `src/components/status/reserve-sync-health.tsx` for any hardcoded totals

- [ ] **Step 4: Final commit**

```bash
git add src/app/methodology/ src/app/about/ src/components/status/
git commit -m "docs(reserves): update methodology page for reserve sync promotions"
```

---

## Summary

| Phase | Coins | New live coins | Evidence class upgrades |
|-------|-------|---------------|----------------------|
| Phase 1 (Tier 1) | USDD, reUSD, frxUSD, USDai | +1 (USDai) | +3 (USDD, reUSD, frxUSD gain independent class + scoring eligibility) |
| Phase 2 (Tier 2) | OUSG, feUSD, EURS, PAXG, eUSD | +5 (address research required) | n/a (already using independent adapters) |
| Phase 3 (Tier 3) | USSD, Honey, Resupply, pmUSD | +0-4 (research-dependent) | n/a |
| **Total** | **13 coins** | **+6 to +10 new live** | **+3 upgrades** |

Post-implementation: live tracking moves from **48 → 54-58 coins** (27% → 30-33% coverage). Three existing adapters (USDD, reUSD, frxUSD) gain scoring-eligible independent evidence class.
