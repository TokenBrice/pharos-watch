# Live Reserve Coverage Expansion — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand live reserve sync from 28 to ~49 stablecoins by adding new adapters and config entries across 5 batches.

**Architecture:** Two new generic adapter types (`chainlink-por`, `chainlink-nav`) unlock 8 coins via Chainlink on-chain feeds. Several coins reuse existing adapters (`single-asset`, `accountable`, `evm-branch-balances`) with config-only additions. Protocol-specific adapters handle OUSD (JSON API), USDT (JSON API), GHO (on-chain facilitators), and FRXUSD (JSON API). HTML scrapers cover USDC/EURC (Circle transparency page). Each batch is independently deployable.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers, EVM RPC (etherscan-proxy), Chainlink AggregatorV3Interface

**Research:** `agents/research/2026-03-14-live-reserve-coverage-expansion.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `worker/src/cron/reserve-adapters/tether.ts` | USDT transparency.json adapter |
| `worker/src/cron/reserve-adapters/ousd.ts` | Origin Dollar collateral API adapter |
| `worker/src/cron/reserve-adapters/chainlink-por.ts` | Generic Chainlink Proof-of-Reserve adapter |
| `worker/src/cron/reserve-adapters/chainlink-nav.ts` | Generic Chainlink NAV oracle adapter |
| `worker/src/cron/reserve-adapters/gho.ts` | Aave GHO facilitator model adapter |
| `worker/src/cron/reserve-adapters/frax.ts` | Frax combineddata API adapter |
| `worker/src/cron/reserve-adapters/circle-transparency.ts` | Circle transparency page scraper |
| `worker/src/cron/reserve-adapters/sky.ts` | DAI/USDS collateral adapter |
| `worker/src/cron/reserve-adapters/__tests__/tether.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/ousd.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/gho.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/frax.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts` | Tests |
| `worker/src/cron/reserve-adapters/__tests__/sky.test.ts` | Tests |

### Modified Files

| File | Changes |
|------|---------|
| `worker/src/cron/reserve-adapters/index.ts` | Register all new adapters in ADAPTERS map |
| `shared/lib/stablecoins.ts` | Add `liveReservesConfig` to ~21 coin entries |
| `docs/live-reserves.md` | Update adapter registry table and coverage count |

---

## Chunk 1: Batch 1 — Quick Wins (+9 coins)

### Task 1: BUIDL — single-asset config

**Files:**
- Modify: `shared/lib/stablecoins.ts` (buidl-blackrock entry)

- [ ] **Step 1: Add liveReservesConfig to BUIDL**

Add after the `reserves` field in the buidl-blackrock entry:

```typescript
liveReservesConfig: {
  adapter: "single-asset",
  version: 1,
  semantics: "single-asset",
  breakerScope: "buidl-blackrock",
  display: { url: "https://securitize.io/blackrock/buidl", label: "Securitize" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    label: "U.S. Treasury Bills, cash, repos",
    risk: "very-low",
  },
},
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add BUIDL single-asset config"
```

---

### Task 2: UTY — accountable adapter config

**Files:**
- Modify: `shared/lib/stablecoins.ts` (uty-xsy entry)

- [ ] **Step 1: Verify Accountable API endpoint**

```bash
curl -s "https://accountable.xsy.fi/api/dashboard" | head -c 500
```

If the endpoint returns valid JSON with a `type_split` bucket (matching the pattern used by other Accountable-powered coins), proceed. If it 404s or uses a different URL pattern, check the network requests at `https://accountable.xsy.fi/` to find the correct endpoint and bucket name. Adjust the config below accordingly.

- [ ] **Step 2: Add liveReservesConfig to UTY**

Add after the `reserves` field in the uty-xsy entry:

```typescript
liveReservesConfig: {
  adapter: "accountable",
  version: 1,
  semantics: "collateral-mix",
  breakerScope: "uty-xsy",
  display: { url: "https://accountable.xsy.fi/", label: "Accountable" },
  inputs: { primary: { kind: "http-json", url: "https://accountable.xsy.fi/api/dashboard" } },
  params: {
    bucket: "type_split",
    riskMap: {
      "USDC": "low",
      "AVAX (Spot)": "high",
      "AVAX Perp (Short)": "high",
    },
  },
},
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add UTY accountable config"
```

---

### Task 3: USD0 — evm-branch-balances config

**Files:**
- Modify: `shared/lib/stablecoins.ts` (usd0-usual entry)

- [ ] **Step 1: Add liveReservesConfig to USD0**

The USD0 treasury contract at `0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7` holds ERC-20 collateral tokens. Configure branches for known collateral:

```typescript
liveReservesConfig: {
  adapter: "evm-branch-balances",
  version: 1,
  semantics: "collateral-mix",
  breakerScope: "usd0-usual",
  display: { url: "https://usual.money/", label: "Usual Money" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    branches: [
      {
        name: "Hashnote USYC",
        holder: "0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7",
        token: { chain: "ethereum", address: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b", decimals: 6 },
        risk: "low",
        coinId: "usyc-hashnote",
      },
      {
        name: "UsualM (wrapped M0)",
        holder: "0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7",
        token: { chain: "ethereum", address: "0x4Cbc25559DbBD1272EC5B64c7b5F48a2405e6470", decimals: 18 },
        risk: "low",
        coinId: "m-m0",
      },
      {
        name: "UsualUSDtb",
        holder: "0xdd82875f0840AAD58a455A70B88eEd9F59ceC7c7",
        token: { chain: "ethereum", address: "0x58073531a2809744D1bF311D30FD76B27D662abB", decimals: 18 },
        risk: "low",
        coinId: "usdtb-ethena",
      },
    ],
  },
},
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add USD0 evm-branch-balances config"
```

---

### Task 4: OUSD adapter — Origin Dollar collateral API

**Files:**
- Create: `worker/src/cron/reserve-adapters/ousd.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/ousd.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (ousd-origin-protocol entry)

- [ ] **Step 1: Write the adapter test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/ousd.test.ts
import { describe, it, expect } from "vitest";
import { adaptOusdCollateral, type OusdCollateralResponse } from "../ousd";

const SAMPLE_RESPONSE: OusdCollateralResponse = {
  collateral: {
    DAI: { total: 1_500_000, price: 1.0 },
    USDC: { total: 3_200_000, price: 1.0 },
    USDT: { total: 2_800_000, price: 1.0 },
  },
};

describe("adaptOusdCollateral", () => {
  it("produces slices from collateral response", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("maps known stablecoins to coinIds", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    const usdc = result.slices.find((s) => s.name.includes("USDC"));
    expect(usdc?.coinId).toBe("usdc-circle");
  });

  it("assigns risk based on canonical risk map", () => {
    const result = adaptOusdCollateral(SAMPLE_RESPONSE);
    for (const slice of result.slices) {
      expect(["very-low", "low", "medium", "high", "very-high"]).toContain(slice.risk);
    }
  });

  it("handles empty collateral", () => {
    const empty: OusdCollateralResponse = { collateral: {} };
    const result = adaptOusdCollateral(empty);
    expect(result.slices).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/ousd.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/ousd.ts
import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

export interface OusdCollateralResponse {
  collateral: Record<string, { total: number; price: number }>;
}

const SYMBOL_TO_COIN_ID: Record<string, string> = {
  USDC: "usdc-circle",
  USDT: "usdt-tether",
  DAI: "dai-makerdao",
};

const SYMBOL_TO_RISK: Record<string, ReserveSlice["risk"]> = {
  USDC: "low",
  USDT: "low",
  DAI: "low",
};

export function adaptOusdCollateral(payload: OusdCollateralResponse): AdapterResult {
  const entries = Object.entries(payload.collateral)
    .map(([symbol, data]) => ({
      name: symbol,
      value: data.total * data.price,
      risk: (SYMBOL_TO_RISK[symbol] ?? "medium") as ReserveSlice["risk"],
      ...(SYMBOL_TO_COIN_ID[symbol] ? { coinId: SYMBOL_TO_COIN_ID[symbol] } : {}),
      depType: "wrapper" as const,
    }))
    .filter((e) => e.value > 0);

  if (entries.length === 0) return { slices: [] };

  const slices = slicesFromValues(entries);
  return {
    slices,
    metadata: {
      assetCount: entries.length,
    },
  };
}

export async function fetchOusdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "ousd");
  const payload = await fetchJsonWithRetry<OusdCollateralResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptOusdCollateral(payload);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/ousd.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter and add coin config**

In `worker/src/cron/reserve-adapters/index.ts`, add to imports:
```typescript
import { fetchOusdReserves } from "./ousd";
```

Add to `ADAPTERS` map:
```typescript
"ousd": fetchOusdReserves,
```

In `shared/lib/stablecoins.ts`, add to ousd-origin-protocol entry:
```typescript
liveReservesConfig: {
  adapter: "ousd",
  version: 1,
  semantics: "collateral-mix",
  display: { url: "https://www.ousd.com/", label: "Origin Protocol" },
  inputs: { primary: { kind: "http-json", url: "https://api.originprotocol.com/api/v2/ousd/collateral" } },
},
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/ousd.ts worker/src/cron/reserve-adapters/__tests__/ousd.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add OUSD collateral API adapter"
```

---

### Task 5: USDT adapter — Tether transparency.json

**Files:**
- Create: `worker/src/cron/reserve-adapters/tether.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/tether.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (usdt-tether entry)

- [ ] **Step 1: Write the adapter test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/tether.test.ts
import { describe, it, expect } from "vitest";
import { adaptTetherTransparency, type TetherTransparencyResponse } from "../tether";

const SAMPLE: TetherTransparencyResponse = {
  data: {
    usdt: {
      total_assets: 145_000_000_000,
      total_liabilities: 144_500_000_000,
      shareholder_eq: 500_000_000,
    },
  },
};

describe("adaptTetherTransparency", () => {
  it("returns a single attestation slice", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].risk).toBe("very-low");
  });

  it("includes collateralization metadata", () => {
    const result = adaptTetherTransparency(SAMPLE);
    expect(result.metadata?.totalAssetsUsd).toBe(145_000_000_000);
    expect(result.metadata?.totalLiabilitiesUsd).toBe(144_500_000_000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.00346, 4);
  });

  it("throws on missing usdt data", () => {
    expect(() => adaptTetherTransparency({ data: {} } as TetherTransparencyResponse)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/tether.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/tether.ts
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig } from "./helpers";

export interface TetherTransparencyResponse {
  data: {
    usdt: {
      total_assets: number;
      total_liabilities: number;
      shareholder_eq: number;
    };
  };
}

export function adaptTetherTransparency(payload: TetherTransparencyResponse): AdapterResult {
  const usdt = payload.data?.usdt;
  if (!usdt) throw new Error("Tether transparency response missing usdt data");

  const { total_assets, total_liabilities } = usdt;
  if (!Number.isFinite(total_assets) || total_assets <= 0) {
    throw new Error("Tether total_assets invalid or zero");
  }

  return {
    slices: [
      {
        name: "U.S. Treasury Bills, repos, cash, and other reserves",
        pct: 100,
        risk: "very-low",
      },
    ],
    metadata: {
      totalAssetsUsd: total_assets,
      totalLiabilitiesUsd: total_liabilities,
      shareholderEquityUsd: usdt.shareholder_eq,
      collateralizationRatio:
        total_liabilities > 0 ? total_assets / total_liabilities : null,
    },
  };
}

export async function fetchTetherReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "tether");
  const payload = await fetchJsonWithRetry<TetherTransparencyResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptTetherTransparency(payload);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/tether.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter and add coin config**

In `index.ts`, add import and register `"tether": fetchTetherReserves`.

In `stablecoins.ts`, add to usdt-tether entry:
```typescript
liveReservesConfig: {
  adapter: "tether",
  version: 1,
  semantics: "attestation-mix",
  display: { url: "https://tether.to/en/transparency", label: "Tether Transparency" },
  inputs: { primary: { kind: "http-json", url: "https://app.tether.to/transparency.json" } },
},
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/tether.ts worker/src/cron/reserve-adapters/__tests__/tether.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add USDT tether transparency adapter"
```

---

### Task 6: USYC — single-asset with HTTP JSON probe

**Files:**
- Modify: `shared/lib/stablecoins.ts` (usyc-hashnote entry)

- [ ] **Step 1: Add liveReservesConfig to USYC**

Use the public Hashnote price API as a probe to verify the fund is active:

```typescript
liveReservesConfig: {
  adapter: "single-asset",
  version: 1,
  semantics: "single-asset",
  breakerScope: "usyc-hashnote",
  display: { url: "https://usyc.hashnote.com/", label: "Hashnote" },
  inputs: { primary: { kind: "http-json", url: "https://usyc.hashnote.com/api/price" } },
  params: {
    label: "U.S. Treasury Bills and reverse repos",
    risk: "very-low",
    probe: { kind: "json-path", path: ["price"] },
  },
},
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add USYC single-asset config with Hashnote API probe"
```

---

### Task 7: TBILL — test and extend OpenEden adapter

**Files:**
- Modify: `shared/lib/stablecoins.ts` (tbill-openeden entry)

- [ ] **Step 1: Verify OpenEden TBILL API endpoint**

Before adding config, test if the TBILL endpoint follows the USDO pattern:

```bash
curl -s "https://prod-gw.openeden.com/tbill/sys/reserve-composition-last" | head -c 500
```

If the endpoint returns valid JSON with the same shape as the USDO endpoint (`totalTbillAmountInUsd`, `usdcAmount`, etc.), proceed to Step 2. If it 404s or returns a different shape:
1. **Skip Steps 2-3** — TBILL is not compatible with the current OpenEden adapter
2. Skip to Step 4 with commit message: `"chore: skip TBILL — openeden endpoint not available"`
3. Adjust Task 8's coverage count to exclude TBILL

- [ ] **Step 2: Add liveReservesConfig to TBILL (if endpoint works)**

```typescript
liveReservesConfig: {
  adapter: "openeden-usdo",
  version: 1,
  semantics: "collateral-mix",
  breakerScope: "openeden",
  display: { url: "https://openeden.com/tbill/transparency", label: "OpenEden" },
  inputs: { primary: { kind: "http-json", url: "https://prod-gw.openeden.com/tbill/sys/reserve-composition-last" } },
},
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add TBILL openeden config (shared breaker scope)"
```

---

### Task 8: Batch 1 docs update + registry commit

**Files:**
- Modify: `docs/live-reserves.md`

- [ ] **Step 1: Update docs/live-reserves.md**

Update the adapter registry table to include:
- New adapters: `ousd`, `tether` (2 new → total 18 adapters)
- New coins: BUIDL (single-asset), UTY (accountable), USD0 (evm-branch-balances), OUSD (ousd), USDT (tether), USYC (single-asset), TBILL (openeden-usdo if endpoint works) = 6-7 new coins → total 34-35 live-enabled stablecoins
- Update the coverage summary line accordingly

- [ ] **Step 2: Run full verification**

Run: `npm run build && npm test && cd worker && npx tsc --noEmit`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add docs/live-reserves.md
git commit -m "docs: update live-reserves for batch 1 coverage expansion"
```

---

## Chunk 2: Batch 2 — Chainlink PoR + NAV Adapters (+8 coins)

### Task 9: chainlink-por adapter

**Files:**
- Create: `worker/src/cron/reserve-adapters/chainlink-por.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`

- [ ] **Step 1: Write the adapter test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts
import { describe, it, expect } from "vitest";
import { adaptChainlinkPorResponse, type ChainlinkPorParams } from "../chainlink-por";

describe("adaptChainlinkPorResponse", () => {
  const params: ChainlinkPorParams = {
    porFeedAddress: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
    assetLabel: "USD Cash Reserves",
    assetRisk: "very-low",
  };

  it("returns single 100% slice with configured label and risk", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toEqual({
      name: "USD Cash Reserves",
      pct: 100,
      risk: "very-low",
    });
  });

  it("includes metadata with reserves and feed info", () => {
    const result = adaptChainlinkPorResponse(
      { reserves: 145_000_000_000n, decimals: 8, roundId: 42n, updatedAt: 1710000000 },
      params,
    );
    expect(result.metadata?.totalReservesRaw).toBe("145000000000");
    expect(result.metadata?.feedDecimals).toBe(8);
    expect(result.metadata?.feedRoundId).toBe("42");
    expect(result.metadata?.feedUpdatedAt).toBe(1710000000);
  });

  it("throws on zero reserves", () => {
    expect(() =>
      adaptChainlinkPorResponse(
        { reserves: 0n, decimals: 8, roundId: 1n, updatedAt: 1710000000 },
        params,
      ),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts`
Expected: FAIL

- [ ] **Step 3: Add fetchOnchainRawCall helper to helpers.ts**

In `worker/src/cron/reserve-adapters/helpers.ts`, add a new helper that returns the full hex response from `eth_call` (unlike `fetchOnchainUint256` which extracts only the first 32-byte word). This follows the same RPC dispatch pattern — try public RPCs via `fetchEvmCallHexAtBlock`, then fall back to `fetchEtherscanProxyHex` for etherscan-proxy mode:

```typescript
import { fetchEtherscanProxyHex, fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";

/**
 * Raw eth_call returning full hex result string.
 * Unlike fetchOnchainUint256 which extracts only the first 32-byte word,
 * this returns the complete response for multi-return-value calls
 * (e.g. Chainlink latestRoundData which returns 5 values).
 */
export async function fetchOnchainRawCall(options: EvmCallOptions): Promise<string | null> {
  const extraRpcUrls = [options.rpcUrl, options.fallbackRpcUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  const rpcResult = await fetchEvmCallHexAtBlock(
    options.chain,
    options.contract,
    options.data,
    "latest",
    { extraRpcUrls, signal: options.signal, timeoutMs: 10_000 },
  );
  if (rpcResult != null) return rpcResult;

  if (options.rpcMode === "etherscan-proxy") {
    if (options.chain !== "ethereum") return null;
    return fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_call",
      to: options.contract,
      data: options.data,
      blockNumberOrTag: "latest",
      apiKey: options.ctx?.etherscanApiKey,
      signal: options.signal,
      timeoutMs: 10_000,
    });
  }

  return null;
}
```

> Note: `fetchEvmCallHexAtBlock` and `fetchEtherscanProxyHex` are already exported from `../../lib/evm-rpc.ts`. Add the import at the top of `helpers.ts` alongside the existing `fetchEtherscanUint256AtBlock` and `fetchEvmUint256AtBlock` imports.

- [ ] **Step 4: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/chainlink-por.ts
import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchOnchainRawCall, fetchOnchainUint256, getAdapterTimeout, isReserveRisk, requireOnchainInput } from "./helpers";

export interface ChainlinkPorParams {
  porFeedAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
}

interface ChainlinkFeedResult {
  reserves: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: number;
}

// AggregatorV3Interface selectors
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const DECIMALS_SELECTOR = "0x313ce567";

function readParams(config: LiveReservesConfig): ChainlinkPorParams {
  const params = config.params as Record<string, unknown> | undefined;
  if (!params?.porFeedAddress || typeof params.porFeedAddress !== "string") {
    throw new Error("chainlink-por: params.porFeedAddress required");
  }
  if (!params?.assetLabel || typeof params.assetLabel !== "string") {
    throw new Error("chainlink-por: params.assetLabel required");
  }
  const risk = String(params.assetRisk ?? "");
  if (!isReserveRisk(risk)) {
    throw new Error(`chainlink-por: params.assetRisk must be a valid risk level, got "${risk}"`);
  }
  return {
    porFeedAddress: params.porFeedAddress,
    assetLabel: params.assetLabel,
    assetRisk: risk,
  };
}

export function adaptChainlinkPorResponse(
  feed: ChainlinkFeedResult,
  params: ChainlinkPorParams,
): AdapterResult {
  if (feed.reserves <= 0n) {
    throw new Error("chainlink-por: feed returned zero or negative reserves");
  }

  return {
    slices: [
      {
        name: params.assetLabel,
        pct: 100,
        risk: params.assetRisk,
      },
    ],
    metadata: {
      totalReservesRaw: feed.reserves.toString(),
      feedDecimals: feed.decimals,
      feedRoundId: feed.roundId.toString(),
      feedUpdatedAt: feed.updatedAt,
    },
  };
}

export async function fetchChainlinkPorReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-por");
  const params = readParams(config);

  // Fetch decimals (single uint8 return — fetchOnchainUint256 is fine)
  const decimalsRaw = await fetchOnchainUint256({
    contract: params.porFeedAddress, data: DECIMALS_SELECTOR,
    signal, ctx, rpcMode: input.rpcMode, chain: input.chain,
  });
  if (decimalsRaw == null) throw new Error("chainlink-por: failed to read decimals()");
  const decimals = Number(decimalsRaw);

  // Fetch latestRoundData — returns 5 words, need raw hex
  const raw = await fetchOnchainRawCall({
    contract: params.porFeedAddress, data: LATEST_ROUND_DATA_SELECTOR,
    signal, ctx, rpcMode: input.rpcMode, chain: input.chain,
  });
  if (raw == null) throw new Error("chainlink-por: failed to read latestRoundData()");

  // latestRoundData returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  // Each occupies one 32-byte (64 hex char) word after the 0x prefix
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const roundId = BigInt("0x" + hex.slice(0, 64));
  const reserves = BigInt("0x" + hex.slice(64, 128));
  const updatedAt = Number(BigInt("0x" + hex.slice(192, 256)));

  return adaptChainlinkPorResponse({ reserves, decimals, roundId, updatedAt }, params);
}
```

- [ ] **Step 5: Register adapter**

In `index.ts`, add import and register `"chainlink-por": fetchChainlinkPorReserves`.

- [ ] **Step 6: Run tests**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts`
Expected: PASS

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/reserve-adapters/chainlink-por.ts worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts worker/src/cron/reserve-adapters/helpers.ts worker/src/cron/reserve-adapters/index.ts
git commit -m "feat(live-reserves): add generic chainlink-por adapter with fetchOnchainRawCall helper"
```

---

### Task 10: Add Chainlink PoR configs (TUSD + discovery for USD1, EURS, PAXG)

**Files:**
- Modify: `shared/lib/stablecoins.ts`

- [ ] **Step 1: Add liveReservesConfig to TUSD**

TUSD has a confirmed Chainlink PoR feed at `0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5`:

```typescript
liveReservesConfig: {
  adapter: "chainlink-por",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "tusd-archblock",
  display: { url: "https://data.chain.link/feeds/ethereum/mainnet/tusd-por", label: "Chainlink PoR" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    porFeedAddress: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5",
    assetLabel: "USD reserves (Moore Hong Kong attested)",
    assetRisk: "very-low",
  },
},
```

- [ ] **Step 2: Resolve and add USD1 config**

USD1 at `0x691b74146cdba162449012aa32d3cbf5df77d4c4` uses a custom `latestBundle()` ABI, NOT standard AggregatorV3 `latestRoundData()`. Before adding config:

1. Verify on Etherscan whether the contract implements AggregatorV3Interface (check for `latestRoundData` in the Read Contract tab)
2. If YES: add `chainlink-por` config with `porFeedAddress: "0x691b74146cdba162449012aa32d3cbf5df77d4c4"`
3. If NO: **skip USD1** — it needs a custom adapter (defer to follow-up work). Note the skip in the commit message.

If compatible:
```typescript
liveReservesConfig: {
  adapter: "chainlink-por",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "usd1-wlfi",
  display: { url: "https://por.worldlibertyfinancial.com", label: "WLFI PoR" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    porFeedAddress: "0x691b74146cdba162449012aa32d3cbf5df77d4c4",
    assetLabel: "U.S. Treasury Bills, cash equivalents (BitGo)",
    assetRisk: "very-low",
  },
},
```

- [ ] **Step 3: Resolve and add EURS config**

Resolve the EURS Chainlink PoR feed address. Try:
```bash
# Check Chainlink PoR feed directory for EURS
curl -s "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-proofs-of-reserve.json" | grep -i "eurs\|stasis\|eurr" | head -5
```

If the feed address is found, add config. If not resolvable, **skip EURS** and note in commit.

```typescript
liveReservesConfig: {
  adapter: "chainlink-por",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "eurs-stasis",
  display: { url: "https://stasis.net/transparency", label: "Chainlink PoR" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    porFeedAddress: "<RESOLVED_ADDRESS>",
    assetLabel: "EUR cash reserves",
    assetRisk: "very-low",
  },
},
```

- [ ] **Step 4: Resolve and add PAXG config**

Resolve the PAXG Chainlink PoR feed address:
```bash
curl -s "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-proofs-of-reserve.json" | grep -i "paxg\|paxos.*gold" | head -5
```

If the feed address is found, add config. If not resolvable, **skip PAXG** and note in commit.

```typescript
liveReservesConfig: {
  adapter: "chainlink-por",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "paxg-paxos",
  display: { url: "https://www.paxos.com/paxg-transparency", label: "Chainlink PoR" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    porFeedAddress: "<RESOLVED_ADDRESS>",
    assetLabel: "Physical gold (LBMA Good Delivery, Brink's London)",
    assetRisk: "very-low",
  },
},
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

Adjust commit message to list only the coins that were actually added:
```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add chainlink-por configs for TUSD [+USD1/EURS/PAXG if resolved]"
```

---

### Task 11: chainlink-nav adapter

**Files:**
- Create: `worker/src/cron/reserve-adapters/chainlink-nav.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`

- [ ] **Step 1: Write the adapter test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts
import { describe, it, expect } from "vitest";
import { adaptChainlinkNavResponse, type ChainlinkNavParams } from "../chainlink-nav";

describe("adaptChainlinkNavResponse", () => {
  const params: ChainlinkNavParams = {
    oracleAddress: "0x74f2199AEb743f68f05943e5715A33EaF2b61f53",
    tokenAddress: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
    assetLabel: "U.S. Treasury Bills",
    assetRisk: "very-low",
  };

  it("returns single 100% slice", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
    expect(result.slices[0].name).toBe("U.S. Treasury Bills");
  });

  it("calculates AUM in metadata", () => {
    const result = adaptChainlinkNavResponse(
      { navPerToken: 1_119_000n, navDecimals: 6, totalSupply: 500_000_000n, tokenDecimals: 6, roundId: 384n, updatedAt: 1773405239 },
      params,
    );
    // NAV = 1.119, Supply = 500, AUM = 559.5
    expect(result.metadata?.navPerToken).toBe("1.119");
    expect(result.metadata?.totalSupplyFormatted).toBe("500");
  });

  it("throws on zero NAV", () => {
    expect(() =>
      adaptChainlinkNavResponse(
        { navPerToken: 0n, navDecimals: 6, totalSupply: 500n, tokenDecimals: 6, roundId: 1n, updatedAt: 0 },
        params,
      ),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/chainlink-nav.ts
import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchOnchainRawCall, fetchOnchainUint256, getAdapterTimeout, isReserveRisk, requireOnchainInput } from "./helpers";

export interface ChainlinkNavParams {
  oracleAddress: string;
  tokenAddress: string;
  assetLabel: string;
  assetRisk: ReserveSlice["risk"];
  /** Override oracle read method. Default uses AggregatorV3 latestRoundData(). */
  oracleMethod?: "latestRoundData" | "getPrice";
}

interface NavFeedResult {
  navPerToken: bigint;
  navDecimals: number;
  totalSupply: bigint;
  tokenDecimals: number;
  roundId: bigint;
  updatedAt: number;
}

const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const DECIMALS_SELECTOR = "0x313ce567";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const GET_PRICE_SELECTOR = "0x98d5fdca"; // getPrice()

function readParams(config: LiveReservesConfig): ChainlinkNavParams {
  const params = config.params as Record<string, unknown> | undefined;
  if (!params?.oracleAddress || typeof params.oracleAddress !== "string") {
    throw new Error("chainlink-nav: params.oracleAddress required");
  }
  if (!params?.tokenAddress || typeof params.tokenAddress !== "string") {
    throw new Error("chainlink-nav: params.tokenAddress required");
  }
  if (!params?.assetLabel || typeof params.assetLabel !== "string") {
    throw new Error("chainlink-nav: params.assetLabel required");
  }
  const risk = String(params.assetRisk ?? "");
  if (!isReserveRisk(risk)) {
    throw new Error(`chainlink-nav: invalid assetRisk "${risk}"`);
  }
  return {
    oracleAddress: params.oracleAddress,
    tokenAddress: params.tokenAddress,
    assetLabel: params.assetLabel,
    assetRisk: risk,
    oracleMethod: (params.oracleMethod as ChainlinkNavParams["oracleMethod"]) ?? "latestRoundData",
  };
}

function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);
  const trimmed = fracPart.replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

export function adaptChainlinkNavResponse(feed: NavFeedResult, params: ChainlinkNavParams): AdapterResult {
  if (feed.navPerToken <= 0n) {
    throw new Error("chainlink-nav: NAV per token is zero or negative");
  }

  return {
    slices: [
      { name: params.assetLabel, pct: 100, risk: params.assetRisk },
    ],
    metadata: {
      navPerToken: formatUnits(feed.navPerToken, feed.navDecimals),
      totalSupplyFormatted: formatUnits(feed.totalSupply, feed.tokenDecimals),
      feedRoundId: feed.roundId.toString(),
      feedUpdatedAt: feed.updatedAt,
    },
  };
}

export async function fetchChainlinkNavReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "chainlink-nav");
  const params = readParams(config);
  const callOpts = { rpcMode: input.rpcMode, chain: input.chain, signal, ctx };

  // Fetch token decimals + totalSupply in parallel with oracle data
  const [tokenDecimalsRaw, totalSupplyRaw, navResult] = await Promise.all([
    fetchOnchainUint256({ contract: params.tokenAddress, data: DECIMALS_SELECTOR, ...callOpts }),
    fetchOnchainUint256({ contract: params.tokenAddress, data: TOTAL_SUPPLY_SELECTOR, ...callOpts }),
    params.oracleMethod === "getPrice"
      ? fetchGetPrice(input, params.oracleAddress, signal, ctx)
      : fetchLatestRoundData(input, params.oracleAddress, signal, ctx),
  ]);

  if (tokenDecimalsRaw == null) throw new Error("chainlink-nav: failed to read token decimals()");
  if (totalSupplyRaw == null) throw new Error("chainlink-nav: failed to read token totalSupply()");

  return adaptChainlinkNavResponse(
    {
      navPerToken: navResult.answer,
      navDecimals: navResult.decimals,
      totalSupply: totalSupplyRaw,
      tokenDecimals: Number(tokenDecimalsRaw),
      roundId: navResult.roundId,
      updatedAt: navResult.updatedAt,
    },
    params,
  );
}

async function fetchLatestRoundData(
  input: { rpcMode: string; chain: string },
  oracleAddress: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<{ answer: bigint; decimals: number; roundId: bigint; updatedAt: number }> {
  const callOpts = { rpcMode: input.rpcMode, chain: input.chain, signal, ctx };

  const [decimalsRaw, raw] = await Promise.all([
    fetchOnchainUint256({ contract: oracleAddress, data: DECIMALS_SELECTOR, ...callOpts }),
    fetchOnchainRawCall({ contract: oracleAddress, data: LATEST_ROUND_DATA_SELECTOR, ...callOpts }),
  ]);

  if (decimalsRaw == null) throw new Error("chainlink-nav: failed to read oracle decimals()");
  if (raw == null) throw new Error("chainlink-nav: failed to read oracle latestRoundData()");

  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return {
    roundId: BigInt("0x" + hex.slice(0, 64)),
    answer: BigInt("0x" + hex.slice(64, 128)),
    updatedAt: Number(BigInt("0x" + hex.slice(192, 256))),
    decimals: Number(decimalsRaw),
  };
}

async function fetchGetPrice(
  input: { rpcMode: string; chain: string },
  oracleAddress: string,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<{ answer: bigint; decimals: number; roundId: bigint; updatedAt: number }> {
  const answer = await fetchOnchainUint256({
    contract: oracleAddress, data: GET_PRICE_SELECTOR, signal, ctx,
    rpcMode: input.rpcMode, chain: input.chain,
  });

  if (answer == null) throw new Error("chainlink-nav: failed to read oracle getPrice()");

  // getPrice() returns a single uint256 with 18 decimals (Ondo convention).
  // Note: No on-chain timestamp available from this method — we use current time.
  // The cron's own staleness guard (48h freshness window) provides coverage.
  return {
    answer,
    decimals: 18,
    roundId: 0n,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter**

In `index.ts`, add import and register `"chainlink-nav": fetchChainlinkNavReserves`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/cron/reserve-adapters/chainlink-nav.ts worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts worker/src/cron/reserve-adapters/index.ts
git commit -m "feat(live-reserves): add generic chainlink-nav adapter"
```

---

### Task 12: Add Chainlink NAV configs (OUSG, USDY, mTBILL, USTB)

**Files:**
- Modify: `shared/lib/stablecoins.ts`

- [ ] **Step 1: Add configs for all 4 coins**

OUSG (uses `getPrice` method — Ondo custom oracle):
```typescript
liveReservesConfig: {
  adapter: "chainlink-nav",
  version: 1,
  semantics: "single-asset",
  display: { url: "https://ondo.finance/ousg", label: "Ondo NAV Oracle" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    oracleAddress: "0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094",
    tokenAddress: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92",
    assetLabel: "BlackRock BUIDL + FedFund (U.S. Treasuries)",
    assetRisk: "very-low",
    oracleMethod: "getPrice",
  },
},
```

USDY (uses `getPrice` method — Ondo custom oracle):
```typescript
liveReservesConfig: {
  adapter: "chainlink-nav",
  version: 1,
  semantics: "single-asset",
  breakerScope: "ondo-nav",
  display: { url: "https://ondo.finance/usdy", label: "Ondo NAV Oracle" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    oracleAddress: "0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0",
    tokenAddress: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C",
    assetLabel: "Short-term U.S. Treasuries and bank deposits",
    assetRisk: "very-low",
    oracleMethod: "getPrice",
  },
},
```

mTBILL (uses `latestRoundData` — Ankura Trust / Chainlink compatible):
```typescript
liveReservesConfig: {
  adapter: "chainlink-nav",
  version: 1,
  semantics: "single-asset",
  display: { url: "https://midas.app/transparency", label: "Ankura Trust Oracle" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    oracleAddress: "0x056339C044055819E8Db84E71f5f2E1F536b2E5b",
    tokenAddress: "0xDD629E5241CbC5919847783e6C96B2De4754e438",
    assetLabel: "BlackRock IB01 T-Bill ETF",
    assetRisk: "very-low",
  },
},
```

USTB (uses `latestRoundData` — Superstate/Chainlink):
```typescript
liveReservesConfig: {
  adapter: "chainlink-nav",
  version: 1,
  semantics: "single-asset",
  display: { url: "https://superstate.com/assets/ustb", label: "Superstate Oracle" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
  params: {
    oracleAddress: "0x289B5036cd942e619E1Ee48670F98d214E745AAC",
    tokenAddress: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e",
    assetLabel: "Short-duration U.S. government securities",
    assetRisk: "very-low",
  },
},
```

- [ ] **Step 2: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add chainlink-nav configs for OUSG, USDY, mTBILL, USTB"
```

---

### Task 13: Batch 2 docs update

- [ ] **Step 1: Update docs/live-reserves.md**

Add `chainlink-por` and `chainlink-nav` to the adapter registry table. Update coverage counts.

- [ ] **Step 2: Full verification**

Run: `npm run build && npm test && cd worker && npx tsc --noEmit`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add docs/live-reserves.md
git commit -m "docs: update live-reserves for batch 2 (chainlink-por, chainlink-nav)"
```

---

## Chunk 3: Batch 3 — Protocol-Specific Adapters (+2-4 coins)

### Task 14: GHO adapter — Aave facilitator model

**Files:**
- Create: `worker/src/cron/reserve-adapters/gho.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/gho.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (gho-aave entry)

- [ ] **Step 1: Write test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/gho.test.ts
import { describe, it, expect } from "vitest";
import { adaptGhoFacilitators, type GhoFacilitatorData } from "../gho";

const SAMPLE: GhoFacilitatorData = {
  facilitators: [
    { label: "Aave V3 Ethereum", bucketLevel: 100_000_000n, bucketCapacity: 200_000_000n },
    { label: "GHO FlashMinter", bucketLevel: 0n, bucketCapacity: 10_000_000n },
    { label: "CCIP", bucketLevel: 5_000_000n, bucketCapacity: 50_000_000n },
  ],
  gsmUsdc: 30_000_000n,
  gsmUsdt: 15_000_000n,
};

describe("adaptGhoFacilitators", () => {
  it("produces slices from facilitators + GSM", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    expect(result.slices.length).toBeGreaterThanOrEqual(2);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("skips facilitators with zero bucket level", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    const flashMint = result.slices.find((s) => s.name.includes("FlashMint"));
    expect(flashMint).toBeUndefined();
  });

  it("includes GSM USDC and USDT slices with coinIds", () => {
    const result = adaptGhoFacilitators(SAMPLE);
    const gsmUsdc = result.slices.find((s) => s.name.includes("USDC") && s.name.includes("GSM"));
    expect(gsmUsdc?.coinId).toBe("usdc-circle");
    expect(gsmUsdc?.risk).toBe("low");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/gho.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/gho.ts
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchOnchainUint256, getAdapterTimeout, requireOnchainInput, slicesFromValues } from "./helpers";

const GHO_TOKEN = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GSM_USDC = "0xFeeb6FE430B7523fEF2a38327241eE7153779535";
const GSM_USDT = "0x535b2f7C20B9C83d70e519cf9991578eF9816B7B";

const BALANCE_OF = "0x70a08231"; // balanceOf(address)
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

// GSM tokens
const USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

export interface GhoFacilitatorData {
  facilitators: Array<{ label: string; bucketLevel: bigint; bucketCapacity: bigint }>;
  gsmUsdc: bigint;
  gsmUsdt: bigint;
}

export function adaptGhoFacilitators(data: GhoFacilitatorData): AdapterResult {
  const values: Array<{ name: string; value: number; risk: "very-low" | "low" | "medium" | "high" | "very-high"; coinId?: string; depType?: "wrapper" | "mechanism" | "collateral" }> = [];

  for (const f of data.facilitators) {
    const level = Number(f.bucketLevel);
    if (level <= 0) continue;
    values.push({
      name: f.label,
      value: level,
      risk: "medium",
    });
  }

  const gsmUsdcVal = Number(data.gsmUsdc);
  if (gsmUsdcVal > 0) {
    values.push({ name: "GSM USDC", value: gsmUsdcVal, risk: "low", coinId: "usdc-circle" });
  }

  const gsmUsdtVal = Number(data.gsmUsdt);
  if (gsmUsdtVal > 0) {
    values.push({ name: "GSM USDT", value: gsmUsdtVal, risk: "low", coinId: "usdt-tether" });
  }

  if (values.length === 0) return { slices: [] };

  return {
    slices: slicesFromValues(values),
    metadata: {
      facilitatorCount: data.facilitators.length,
      activeFacilitatorCount: data.facilitators.filter((f) => f.bucketLevel > 0n).length,
    },
  };
}

export async function fetchGhoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "gho");
  const callOpts = { rpcMode: input.rpcMode, chain: input.chain, signal, ctx };

  // Simplified approach: read GHO totalSupply and GSM balances.
  // facilitator-minted = totalSupply - GSM USDC - GSM USDT
  const [gsmUsdc, gsmUsdt, totalSupply] = await Promise.all([
    fetchOnchainUint256({
      contract: USDC_TOKEN,
      data: BALANCE_OF + GSM_USDC.slice(2).padStart(64, "0"),
      ...callOpts,
    }),
    fetchOnchainUint256({
      contract: USDT_TOKEN,
      data: BALANCE_OF + GSM_USDT.slice(2).padStart(64, "0"),
      ...callOpts,
    }),
    fetchOnchainUint256({
      contract: GHO_TOKEN,
      data: TOTAL_SUPPLY_SELECTOR,
      ...callOpts,
    }),
  ]);

  if (gsmUsdc == null || gsmUsdt == null || totalSupply == null) {
    throw new Error("gho: failed to read one or more on-chain values");
  }

  // GHO has 18 decimals, USDC has 6, USDT has 6
  // Normalize all to the same scale for percentage calculation
  const gsmUsdcScaled = gsmUsdc * 10n ** 12n; // 6 → 18 decimals
  const gsmUsdtScaled = gsmUsdt * 10n ** 12n;
  const facilitatorMinted = totalSupply - gsmUsdcScaled - gsmUsdtScaled;

  return adaptGhoFacilitators({
    facilitators: [
      {
        label: "Aave V3 Ethereum (overcollateralized)",
        bucketLevel: facilitatorMinted > 0n ? facilitatorMinted : 0n,
        bucketCapacity: 0n,
      },
    ],
    gsmUsdc: gsmUsdcScaled,
    gsmUsdt: gsmUsdtScaled,
  });
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/gho.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter + add coin config**

Register `"gho": fetchGhoReserves` in `index.ts`.

Add to gho-aave entry in `stablecoins.ts`:
```typescript
liveReservesConfig: {
  adapter: "gho",
  version: 1,
  semantics: "protocol-reserve",
  display: { url: "https://aave.com/gho", label: "Aave GHO" },
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
},
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/gho.ts worker/src/cron/reserve-adapters/__tests__/gho.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add GHO facilitator adapter"
```

---

### Task 15: FRXUSD adapter — Frax combineddata API

**Files:**
- Create: `worker/src/cron/reserve-adapters/frax.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/frax.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (frxusd-frax entry)

- [ ] **Step 1: Write test**

```typescript
// worker/src/cron/reserve-adapters/__tests__/frax.test.ts
import { describe, it, expect } from "vitest";
import { adaptFraxCombinedData, type FraxCombinedDataResponse } from "../frax";

const SAMPLE: FraxCombinedDataResponse = {
  collateral: {
    collateral_ratio: 1.05,
    decentralization_ratio: 0.85,
    total_dollar_value_of_collateral: 800_000_000,
  },
};

describe("adaptFraxCombinedData", () => {
  it("returns single attestation slice", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].pct).toBe(100);
  });

  it("includes collateralization metadata", () => {
    const result = adaptFraxCombinedData(SAMPLE);
    expect(result.metadata?.collateralRatio).toBe(1.05);
    expect(result.metadata?.totalCollateralUsd).toBe(800_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/frax.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the adapter**

```typescript
// worker/src/cron/reserve-adapters/frax.ts
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig } from "./helpers";

export interface FraxCombinedDataResponse {
  collateral: {
    collateral_ratio: number;
    decentralization_ratio: number;
    total_dollar_value_of_collateral: number;
  };
}

export function adaptFraxCombinedData(payload: FraxCombinedDataResponse): AdapterResult {
  const { collateral } = payload;
  if (!collateral || !Number.isFinite(collateral.total_dollar_value_of_collateral)) {
    throw new Error("Frax combineddata response missing collateral data");
  }

  return {
    slices: [
      {
        name: "Tokenized T-bills and cash equivalents (BUIDL, USTB, USCC, USDC)",
        pct: 100,
        risk: "low",
      },
    ],
    metadata: {
      collateralRatio: collateral.collateral_ratio,
      decentralizationRatio: collateral.decentralization_ratio,
      totalCollateralUsd: collateral.total_dollar_value_of_collateral,
    },
  };
}

export async function fetchFraxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "frax");
  const payload = await fetchJsonWithRetry<FraxCombinedDataResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 12_000),
  );
  return adaptFraxCombinedData(payload);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/frax.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter**

In `index.ts`, add import and register `"frax": fetchFraxReserves`.

- [ ] **Step 6: Add coin config**

Add to frxusd-frax entry in `stablecoins.ts`:

```typescript
liveReservesConfig: {
  adapter: "frax",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "frxusd-frax",
  display: { url: "https://frax.com/transparency", label: "Frax Transparency" },
  inputs: { primary: { kind: "http-json", url: "https://api.frax.finance/combineddata/" } },
},
```

- [ ] **Step 7: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add worker/src/cron/reserve-adapters/frax.ts worker/src/cron/reserve-adapters/__tests__/frax.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add FRXUSD frax combineddata adapter"
```

---

### Task 15b: Batch 3 docs update

- [ ] **Step 1: Update docs/live-reserves.md**

Add `gho` and `frax` adapters to the registry table. Update coverage counts.

- [ ] **Step 2: Commit**

```bash
git add docs/live-reserves.md
git commit -m "docs: update live-reserves for batch 3 (gho, frax)"
```

---

## Chunk 4: Batch 4 — Circle Transparency (+2 coins, discovery-gated)

### Task 16a: Circle transparency — discovery

- [ ] **Step 1: Probe for JSON API endpoints**

```bash
# Try common API patterns
curl -s "https://www.circle.com/api/transparency" | head -c 500
curl -s "https://www.circle.com/api/v1/transparency" | head -c 500
curl -s "https://api.circle.com/v1/stablecoins/usdc/reserves" | head -c 500
```

- [ ] **Step 2: Check HTML page for embedded data**

```bash
agent-browser screenshot "https://www.circle.com/transparency" --out /tmp/circle-transparency.png
curl -s "https://www.circle.com/transparency" | grep -i "reserves\|treasury\|deposits\|__NEXT_DATA__\|window.__" | head -30
```

- [ ] **Step 3: Record findings and decide path**

| Finding | Action |
|---------|--------|
| JSON API found | Build `http-json` adapter (like `ousd` pattern) |
| Next.js `__NEXT_DATA__` contains reserve data | Extract from embedded JSON, build `http-json` adapter parsing the page |
| HTML contains parseable reserve data | Build `http-html` adapter (like `mento` pattern) |
| JS-only rendering, no extractable data | **Defer task** — worker cannot run headless browser. Skip to Task 17 |

Document the discovered endpoint URL, response shape, and data field names before proceeding.

### Task 16b: Circle transparency — implementation (gated on 16a)

**Files:**
- Create: `worker/src/cron/reserve-adapters/circle-transparency.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (usdc-circle, eurc-circle entries)

> Steps below assume a JSON API was found. If HTML scraping is needed, follow the `mento` adapter pattern instead. Adjust the test fixture, adapter, and input kind accordingly.

- [ ] **Step 1: Write test with real response fixture**

Build a test fixture using the actual response shape discovered in Task 16a. The fixture should contain real field names and a representative data sample from the API/page.

```typescript
// worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts
import { describe, it, expect } from "vitest";
import { adaptCircleReserves, type CircleReservesResponse } from "../circle-transparency";

// REPLACE with actual response shape from discovery
const SAMPLE: CircleReservesResponse = {
  // ... fields from discovered API
};

describe("adaptCircleReserves", () => {
  it("produces slices from reserve data", () => {
    const result = adaptCircleReserves(SAMPLE);
    expect(result.slices.length).toBeGreaterThanOrEqual(1);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("maps all slices to valid risk levels", () => {
    const result = adaptCircleReserves(SAMPLE);
    for (const slice of result.slices) {
      expect(["very-low", "low", "medium", "high", "very-high"]).toContain(slice.risk);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the adapter**

Build adapter using the discovered endpoint. Follow the `ousd` adapter pattern (for JSON) or `mento` pattern (for HTML). Risk mapping for Circle reserves:
- U.S. Treasury securities → "very-low"
- Cash deposits at SIIs / regulated banks → "very-low"
- Overnight reverse repos → "very-low"
- Other → "low"

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter + add coin configs**

Register `"circle-transparency": fetchCircleReserves` in `index.ts`.

Add configs to `usdc-circle` and `eurc-circle` entries in `stablecoins.ts`:

```typescript
// usdc-circle
liveReservesConfig: {
  adapter: "circle-transparency",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "circle-reserves",
  display: { url: "https://www.circle.com/transparency", label: "Circle Transparency" },
  inputs: { primary: { kind: "http-json", url: "<DISCOVERED_URL>" } },
},

// eurc-circle (shared breaker scope)
liveReservesConfig: {
  adapter: "circle-transparency",
  version: 1,
  semantics: "attestation-mix",
  breakerScope: "circle-reserves",
  display: { url: "https://www.circle.com/transparency", label: "Circle Transparency" },
  inputs: { primary: { kind: "http-json", url: "<DISCOVERED_URL_EURC>" } },
},
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/circle-transparency.ts worker/src/cron/reserve-adapters/__tests__/circle-transparency.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add Circle transparency adapter for USDC/EURC"
```

---

## Chunk 5: Batch 5 — Sky DAI/USDS Collateral (+2 coins, discovery-gated)

### Task 17a: Sky collateral — discovery

- [ ] **Step 1: Probe Block Analitica / Sky APIs**

```bash
# Try Block Analitica API
curl -s "https://atlas.blockanalitica.com/api/v1/collaterals/" | head -c 1000
# Try Sky ecosystem info site
curl -s "https://info.skyeco.com/api/collateral" | head -c 1000
# Try MakerDAO endpoints
curl -s "https://api.makerdao.com/v1/collateral" | head -c 1000
# Try Daistats
curl -s "https://daistats.com/api" | head -c 1000
```

- [ ] **Step 2: Record findings and decide path**

| Finding | Action |
|---------|--------|
| JSON API returns collateral breakdown by ilk | Build `http-json` adapter with risk bucketing |
| No API — must read on-chain | Build `onchain-evm` adapter reading Vat ilks. Limit to top ~10 ilks by debt to stay within RPC budget |
| API requires auth or is rate-limited | **Defer task** — cannot use authenticated APIs from worker |

### Task 17b: Sky collateral — implementation (gated on 17a)

**Files:**
- Create: `worker/src/cron/reserve-adapters/sky.ts`
- Create: `worker/src/cron/reserve-adapters/__tests__/sky.test.ts`
- Modify: `worker/src/cron/reserve-adapters/index.ts`
- Modify: `shared/lib/stablecoins.ts` (dai-makerdao, usds-sky entries)

- [ ] **Step 1: Write test with fixture from discovery**

Build a test fixture using the actual API response shape from Task 17a. The pure `adaptSkyCollateral` function should bucket collateral into risk categories:

```typescript
// worker/src/cron/reserve-adapters/__tests__/sky.test.ts
import { describe, it, expect } from "vitest";
import { adaptSkyCollateral } from "../sky";

// Fixture shape depends on discovery — API JSON or simulated on-chain data
const SAMPLE = {
  // ... fields from discovered source
};

describe("adaptSkyCollateral", () => {
  it("produces risk-bucketed slices", () => {
    const result = adaptSkyCollateral(SAMPLE);
    expect(result.slices.length).toBeGreaterThanOrEqual(2);
    const total = result.slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("maps RWA to very-low risk", () => {
    const result = adaptSkyCollateral(SAMPLE);
    const rwa = result.slices.find((s) => s.name.includes("RWA") || s.name.includes("Treasury"));
    if (rwa) expect(rwa.risk).toBe("very-low");
  });
});
```

Risk bucketing for Sky collateral:
- RWA (Treasuries, bonds) → `"very-low"`
- Stablecoins (USDC PSM) → `"low"`, coinId: `"usdc-circle"`
- ETH/LSTs (wstETH, rETH) → `"low"`
- WBTC → `"medium"`
- Other → `"high"`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/sky.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the adapter**

Build the adapter using the discovered data source. For the `http-json` path, follow the `ousd` pattern. For the on-chain path, use `fetchOnchainUint256` with Vat ilk selectors for the top ~10 ilks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run worker/src/cron/reserve-adapters/__tests__/sky.test.ts`
Expected: PASS

- [ ] **Step 5: Register adapter + add coin configs**

Register `"sky": fetchSkyReserves` in `index.ts`.

Add configs to both `dai-makerdao` and `usds-sky` entries:

```typescript
// dai-makerdao
liveReservesConfig: {
  adapter: "sky",
  version: 1,
  semantics: "protocol-reserve",
  breakerScope: "sky",
  display: { url: "https://info.sky.money/collateral", label: "Sky Ecosystem" },
  inputs: { primary: { kind: "http-json", url: "<DISCOVERED_URL>" } },
  // OR for on-chain: inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" } },
},

// usds-sky (shared adapter and breaker scope)
liveReservesConfig: {
  adapter: "sky",
  version: 1,
  semantics: "protocol-reserve",
  breakerScope: "sky",
  display: { url: "https://info.sky.money/collateral", label: "Sky Ecosystem" },
  inputs: { primary: { kind: "http-json", url: "<DISCOVERED_URL>" } },
},
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/cron/reserve-adapters/sky.ts worker/src/cron/reserve-adapters/__tests__/sky.test.ts worker/src/cron/reserve-adapters/index.ts shared/lib/stablecoins.ts
git commit -m "feat(live-reserves): add Sky adapter for DAI/USDS collateral"
```

---

### Task 18: Final verification + docs

**Files:**
- Modify: `docs/live-reserves.md`
- Modify: `docs/about-page.md` (update data source list)

- [ ] **Step 1: Update docs/live-reserves.md**

Update the adapter registry table with all new adapters. Update the coverage count to reflect the final number of live-enabled stablecoins and registered adapters.

- [ ] **Step 2: Update about page data sources**

Per CLAUDE.md: "When adding a data source, update the about page." Add any new external data sources (Chainlink PoR feeds, Tether transparency API, Origin Protocol API, Frax API, Circle transparency, Block Analitica/Sky) to the data sources section.

- [ ] **Step 3: Run full verification suite**

```bash
npm run build && npm test && cd worker && npx tsc --noEmit && npm run lint
```
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add docs/live-reserves.md docs/about-page.md
git commit -m "docs: update live-reserves and about page for full coverage expansion"
```

- [ ] **Step 5: Push to main**

```bash
git push origin main
```

- [ ] **Step 6: Monitor Cloudflare deployment**

Check Pages dashboard for successful deployment.

- [ ] **Step 7: Verify production after next cron run**

Wait for the next `:11` UTC cron cycle, then:

```bash
# Check status page for reserve sync health
curl -s "https://api.pharos.watch/api/status" | jq '.reserveSync'

# Spot-check 3-5 newly added coins
curl -s "https://api.pharos.watch/api/stablecoin-reserves/usdt-tether" | jq '.mode'
curl -s "https://api.pharos.watch/api/stablecoin-reserves/buidl-blackrock" | jq '.mode'
curl -s "https://api.pharos.watch/api/stablecoin-reserves/gho-aave" | jq '.mode'
```

Expected: `mode: "live"` for newly added coins.

- [ ] **Step 8: Monitor for circuit breaker trips over 2-3 cron cycles**

Check `/status` page for any adapter failures. Fix as needed.
