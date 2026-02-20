# Circulating Supply Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make on-chain supply data PhD-reliable by using per-token circulating supply methods, tightened override guards, and on-chain decimal verification.

**Architecture:** Extend `StablecoinMeta` with an optional `supplyMethod` config that tells the sync cron how to compute circulating supply per token (custom contract calls, treasury subtraction, or raw totalSupply). Tighten the override guard from 10x to 3x. Add decimals() verification to catch config mistakes.

**Tech Stack:** TypeScript, Cloudflare Workers (D1), EVM JSON-RPC, Tron API

---

### Task 1: Add SupplyMethodConfig Type

**Files:**
- Modify: `src/lib/types.ts:40-58`

**Step 1: Add the SupplyMethodConfig type**

Add this type right after the `ContractDeployment` interface (line 44) and before `StablecoinMeta`:

```typescript
/** Configures how on-chain circulating supply is computed for a stablecoin */
export interface SupplyMethodConfig {
  type:
    | "totalSupply"                  // Default: raw totalSupply() is circulating
    | "totalSupply-minus-addresses"  // totalSupply() - sum(balanceOf(addr)) per chain
    | "custom-contract"             // Call a dedicated circulating supply contract
    | "exclude";                    // Skip on-chain supply for this token

  /** For totalSupply-minus-addresses: addresses whose balanceOf() to subtract */
  subtractAddresses?: { chain: string; address: string }[];

  /** For custom-contract: dedicated contract returning circulating supply */
  customContract?: {
    chain: string;     // Chain where the contract lives
    address: string;   // Contract address
    selector: string;  // Function selector (e.g., "0x9e2bf22c")
    decimals: number;  // Decimals for the return value
  };
}
```

**Step 2: Add supplyMethod to StablecoinMeta**

In the `StablecoinMeta` interface, add after `contracts?`:

```typescript
  supplyMethod?: SupplyMethodConfig; // How to compute circulating supply (default: totalSupply)
```

**Step 3: Add supplyMethod to StablecoinOpts in stablecoins.ts**

In `src/lib/stablecoins.ts`, add `supplyMethod` to the `StablecoinOpts` interface (around line 4-15):

```typescript
interface StablecoinOpts {
  // ... existing fields ...
  supplyMethod?: import("./types").SupplyMethodConfig;
}
```

Then pass it through in the `usd()`, `eur()`, and `other()` helper functions. Each return object already spreads opts, but `supplyMethod` needs to be added explicitly. For example, in `usd()`:

```typescript
function usd(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts): StablecoinMeta {
  return { id, name, symbol, flags: { backing, pegCurrency: "USD", governance, yieldBearing: opts?.yieldBearing ?? false, rwa: opts?.rwa ?? false, navToken: opts?.navToken ?? false }, collateral: opts?.collateral, pegMechanism: opts?.pegMechanism, proofOfReserves: opts?.proofOfReserves, links: opts?.links, jurisdiction: opts?.jurisdiction, contracts: opts?.contracts, supplyMethod: opts?.supplyMethod };
}
```

Apply the same change to `eur()` and `other()`.

**Step 4: Type-check**

Run: `npm run build` from the project root.
Expected: Passes (no consumers of the new field yet).

---

### Task 2: Configure Per-Token Supply Methods

**Files:**
- Modify: `src/lib/stablecoins.ts` — 4 stablecoin entries

**Step 1: Add supplyMethod to crvUSD (id "110")**

Located around line 407. Add `supplyMethod` to the opts object:

```typescript
  usd("110", "crvUSD", "crvUSD", "crypto-backed", "centralized-dependent", {
    collateral: "ETH, wBTC, wstETH, and other crypto assets via LLAMMA (Lending-Liquidating AMM)",
    pegMechanism: "Peg keepers use centralized stablecoins (USDC, USDT, USDP) to stabilize price via Curve pools",
    links: [
      { label: "Website", url: "https://www.curve.finance/" },
      { label: "Twitter", url: "https://x.com/CurveFinance" },
      { label: "Docs", url: "https://resources.curve.finance/" },
    ],
    jurisdiction: { country: "Switzerland" },
    contracts: [
      { chain: "ethereum", address: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", decimals: 18 },
    ],
    supplyMethod: {
      type: "custom-contract",
      customContract: {
        chain: "ethereum",
        address: "0xe24e2db9f6bb40bbe7c1c025bc87104f5401ecd7", // StablecoinLens
        selector: "0x9e2bf22c", // circulating_supply()
        decimals: 18,
      },
    },
  }),
```

**Step 2: Add supplyMethod to MIM (id "10")**

Located around line 968. Add `supplyMethod`:

```typescript
  usd("10", "Magic Internet Money", "MIM", "crypto-backed", "centralized-dependent", {
    collateral: "Interest-bearing tokens (yvDAI, xSUSHI, yvUSDT) via Abracadabra CDPs",
    pegMechanism: "Overcollateralized lending with yield-bearing collateral; depends on underlying stablecoin positions",
    contracts: [
      { chain: "ethereum", address: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", decimals: 18 },
    ],
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0xd96f48665a1410C0CD669A88898ecA36B9Fc2cce" }, // DegenBox
      ],
    },
  }),
```

**Step 3: Add supplyMethod to USDT (id "1")**

Located at line 40. Add `supplyMethod`:

```typescript
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x5754284f345afc66a98fbB0a0Afe71e0f007b949" }, // Tether Treasury
      ],
    },
```

**Step 4: Add supplyMethod to USDC (id "2")**

Located at line 59. Add `supplyMethod`:

```typescript
    supplyMethod: {
      type: "totalSupply-minus-addresses",
      subtractAddresses: [
        { chain: "ethereum", address: "0x55FE002aEFF02F77364de339a1292923A15844B8" }, // Circle Reserve
      ],
    },
```

**Step 5: Type-check**

Run: `npm run build` from the project root.
Expected: Passes.

---

### Task 3: Rewrite sync-onchain-supply.ts — EVM Batch with balanceOf + decimals

**Files:**
- Modify: `worker/src/cron/sync-onchain-supply.ts`

This is the core change. The new EVM batch must support three call types in a single RPC batch:
1. `totalSupply()` — selector `0x18160ddd` (no args)
2. `balanceOf(address)` — selector `0x70a08231` + 32-byte padded address
3. `decimals()` — selector `0x313ce567` (no args)
4. Custom contract calls (e.g., crvUSD StablecoinLens)

**Step 1: Add new imports and types**

At the top of the file, add `SupplyMethodConfig` import and new query types:

```typescript
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import { getChainRpc } from "../lib/chain-rpcs";
import { upsertOnchainSupply } from "../lib/db";
import { bigIntToDecimal } from "../lib/bigint";
import { TRON_BURN_ADDRESS, USER_AGENT } from "../lib/constants";
import type { ContractDeployment, SupplyMethodConfig } from "../../../src/lib/types";

interface ContractQuery {
  stablecoinId: string;
  contract: ContractDeployment;
}

/** A single RPC call within the batch */
interface RpcCall {
  /** Unique tag for correlating results (e.g., "supply:1:ethereum", "balance:1:ethereum:0x...") */
  tag: string;
  to: string;
  data: string;
  /** Which contract's decimals to use for parsing the result */
  decimals: number;
}
```

**Step 2: Rewrite runEvmBatch to accept generic RpcCall[]**

Replace the existing `runEvmBatch` function with a generic version that handles arbitrary calls:

```typescript
/** Run a JSON-RPC batch of arbitrary eth_call requests */
async function runEvmBatch(
  rpcUrl: string,
  calls: RpcCall[],
  results: Map<string, bigint>
): Promise<RpcCall[]> {
  const failed: RpcCall[] = [];

  const batchBody = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(batchBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[onchain-supply] RPC batch failed for ${rpcUrl}: ${res.status}`);
      return calls; // all failed
    }

    const responses = (await res.json()) as { id: number; result?: string; error?: unknown }[];

    const seen = new Set<number>();
    for (const resp of responses) {
      seen.add(resp.id);
      const call = calls[resp.id];
      if (!call) continue;
      if (!resp.result || resp.result === "0x" || resp.error) {
        failed.push(call);
        continue;
      }

      try {
        results.set(call.tag, BigInt(resp.result));
      } catch {
        console.warn(`[onchain-supply] Failed to parse result for ${call.tag}`);
        failed.push(call);
      }
    }

    for (let i = 0; i < calls.length; i++) {
      if (!seen.has(i)) failed.push(calls[i]);
    }
  } catch (err) {
    console.error(`[onchain-supply] RPC request failed for ${rpcUrl}:`, err);
    return calls;
  }

  return failed;
}
```

**Step 3: Rewrite fetchEvmTotalSupply to build multi-type batches**

Replace `fetchEvmTotalSupply` with a new function that builds totalSupply + balanceOf + decimals + custom calls:

```typescript
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_DECIMALS = "0x313ce567";

/** Pad an Ethereum address to 32 bytes for balanceOf(address) call data */
function balanceOfCalldata(holderAddress: string): string {
  const addr = holderAddress.toLowerCase().replace("0x", "");
  return SELECTOR_BALANCE_OF + addr.padStart(64, "0");
}

/** Fetch supply data for a batch of EVM contracts, with optional fallback RPC */
async function fetchEvmSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  fallbackRpcUrl?: string,
  keyedPrimary?: boolean
): Promise<Map<string, number>> {
  const supplyResults = new Map<string, number>();

  // Build all RPC calls
  const allCalls: RpcCall[] = [];

  for (const q of queries) {
    const meta = TRACKED_META_BY_ID.get(q.stablecoinId);
    const method = meta?.supplyMethod;

    if (method?.type === "exclude") continue;

    if (method?.type === "custom-contract" && method.customContract?.chain === q.contract.chain) {
      // Custom contract call replaces totalSupply
      allCalls.push({
        tag: `custom:${q.stablecoinId}:${q.contract.chain}`,
        to: method.customContract.address,
        data: method.customContract.selector,
        decimals: method.customContract.decimals,
      });
    } else {
      // Standard totalSupply call
      allCalls.push({
        tag: `supply:${q.stablecoinId}:${q.contract.chain}`,
        to: q.contract.address,
        data: SELECTOR_TOTAL_SUPPLY,
        decimals: q.contract.decimals,
      });
    }

    // Decimals verification call
    allCalls.push({
      tag: `decimals:${q.stablecoinId}:${q.contract.chain}`,
      to: q.contract.address,
      data: SELECTOR_DECIMALS,
      decimals: 0, // decimals() returns a uint8, no scaling needed
    });

    // balanceOf calls for subtract addresses (if applicable)
    if (method?.type === "totalSupply-minus-addresses" && method.subtractAddresses) {
      for (const sub of method.subtractAddresses) {
        if (sub.chain === q.contract.chain) {
          allCalls.push({
            tag: `subtract:${q.stablecoinId}:${q.contract.chain}:${sub.address}`,
            to: q.contract.address,
            data: balanceOfCalldata(sub.address),
            decimals: q.contract.decimals,
          });
        }
      }
    }
  }

  if (allCalls.length === 0) return supplyResults;

  // Execute batched calls
  const rawResults = new Map<string, bigint>();
  const primaryChunk = keyedPrimary ? BATCH_CHUNK_KEYED : BATCH_CHUNK_PUBLIC;

  let allFailed: RpcCall[] = [];
  for (let i = 0; i < allCalls.length; i += primaryChunk) {
    const chunk = allCalls.slice(i, i + primaryChunk);
    const failed = await runEvmBatch(rpcUrl, chunk, rawResults);
    allFailed.push(...failed);
  }

  if (allFailed.length > 0 && fallbackRpcUrl) {
    console.log(`[onchain-supply] Retrying ${allFailed.length} failed calls on fallback RPC`);
    for (let i = 0; i < allFailed.length; i += BATCH_CHUNK_PUBLIC) {
      const chunk = allFailed.slice(i, i + BATCH_CHUNK_PUBLIC);
      await runEvmBatch(fallbackRpcUrl, chunk, rawResults);
    }
  }

  // Process results per query
  for (const q of queries) {
    const meta = TRACKED_META_BY_ID.get(q.stablecoinId);
    const method = meta?.supplyMethod;

    if (method?.type === "exclude") continue;

    const key = `${q.stablecoinId}:${q.contract.chain}`;

    // Decimals verification
    const decimalsRaw = rawResults.get(`decimals:${q.stablecoinId}:${q.contract.chain}`);
    if (decimalsRaw !== undefined) {
      const onchainDecimals = Number(decimalsRaw);
      if (onchainDecimals !== q.contract.decimals) {
        console.error(
          `[onchain-supply] DECIMAL MISMATCH: ${meta?.symbol ?? q.stablecoinId} on ${q.contract.chain} — ` +
          `configured=${q.contract.decimals} on-chain=${onchainDecimals}. Skipping supply for this contract.`
        );
        continue; // Skip this contract entirely
      }
    }

    if (method?.type === "custom-contract" && method.customContract?.chain === q.contract.chain) {
      // Custom contract result
      const customRaw = rawResults.get(`custom:${q.stablecoinId}:${q.contract.chain}`);
      if (customRaw !== undefined && customRaw > 0n) {
        supplyResults.set(key, bigIntToDecimal(customRaw, method.customContract!.decimals));
      }
    } else {
      // Standard totalSupply (with optional subtraction)
      const supplyRaw = rawResults.get(`supply:${q.stablecoinId}:${q.contract.chain}`);
      if (supplyRaw === undefined || supplyRaw <= 0n) continue;

      let netSupply = supplyRaw;

      if (method?.type === "totalSupply-minus-addresses" && method.subtractAddresses) {
        for (const sub of method.subtractAddresses) {
          if (sub.chain === q.contract.chain) {
            const balance = rawResults.get(`subtract:${q.stablecoinId}:${q.contract.chain}:${sub.address}`);
            if (balance !== undefined && balance > 0n) {
              netSupply -= balance;
            }
          }
        }

        if (netSupply <= 0n) {
          console.warn(`[onchain-supply] Net supply for ${meta?.symbol ?? q.stablecoinId} on ${q.contract.chain} is ≤0 after subtraction, skipping`);
          continue;
        }
      }

      supplyResults.set(key, bigIntToDecimal(netSupply, q.contract.decimals));
    }
  }

  return supplyResults;
}
```

**Step 4: Update fetchTronTotalSupply for supply methods and decimal verification**

Tron doesn't support batching so we make individual calls. Add decimals check and subtraction support:

```typescript
/** Fetch supply for Tron contracts via triggerConstantContract */
async function fetchTronSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  apiKey: string | null
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  async function callTron(contractAddress: string, functionSelector: string, parameter: string): Promise<string | null> {
    try {
      const res = await fetch(`${rpcUrl}/wallet/triggerConstantContract`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          owner_address: TRON_BURN_ADDRESS,
          contract_address: contractAddress,
          function_selector: functionSelector,
          parameter,
          visible: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as { constant_result?: string[] };
      return data.constant_result?.[0] ?? null;
    } catch {
      return null;
    }
  }

  for (const query of queries) {
    const meta = TRACKED_META_BY_ID.get(query.stablecoinId);
    const method = meta?.supplyMethod;

    if (method?.type === "exclude") continue;

    // Verify decimals
    const decimalsHex = await callTron(query.contract.address, "decimals()", "");
    if (decimalsHex) {
      const onchainDecimals = Number(BigInt("0x" + decimalsHex));
      if (onchainDecimals !== query.contract.decimals) {
        console.error(
          `[onchain-supply] DECIMAL MISMATCH (Tron): ${meta?.symbol ?? query.stablecoinId} — ` +
          `configured=${query.contract.decimals} on-chain=${onchainDecimals}. Skipping.`
        );
        continue;
      }
    }

    // Get totalSupply
    const supplyHex = await callTron(query.contract.address, "totalSupply()", "");
    if (!supplyHex) {
      console.warn(`[onchain-supply] Tron query failed for ${query.stablecoinId}`);
      continue;
    }

    let supplyRaw = BigInt("0x" + supplyHex);

    // Subtract addresses if configured
    if (method?.type === "totalSupply-minus-addresses" && method.subtractAddresses) {
      for (const sub of method.subtractAddresses) {
        if (sub.chain === "tron") {
          // Tron balanceOf takes a Tron base58 address — need to encode as parameter
          // For Tron, balanceOf(address) parameter is the hex-encoded address padded to 32 bytes
          // Tron addresses in base58 need conversion — use the contract address format
          const balHex = await callTron(
            query.contract.address,
            "balanceOf(address)",
            sub.address.padStart(64, "0")
          );
          if (balHex) {
            const balance = BigInt("0x" + balHex);
            if (balance > 0n) supplyRaw -= balance;
          }
        }
      }
    }

    if (supplyRaw > 0n) {
      const supply = bigIntToDecimal(supplyRaw, query.contract.decimals);
      const key = `${query.stablecoinId}:${query.contract.chain}`;
      results.set(key, supply);
    }
  }

  return results;
}
```

**Step 5: Update the main syncOnchainSupply function**

Replace the chain query dispatch to use the new function names:

```typescript
export async function syncOnchainSupply(db: D1Database, tronApiKey: string | null): Promise<void> {
  const allQueries: ContractQuery[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    if (meta.supplyMethod?.type === "exclude") continue;
    for (const contract of meta.contracts) {
      allQueries.push({ stablecoinId: meta.id, contract });
    }
  }

  if (allQueries.length === 0) {
    console.log("[onchain-supply] No contracts configured, skipping");
    return;
  }

  // Group by chain
  const byChain = new Map<string, ContractQuery[]>();
  for (const q of allQueries) {
    const list = byChain.get(q.contract.chain) ?? [];
    list.push(q);
    byChain.set(q.contract.chain, list);
  }

  // Query each chain in parallel
  const supplyMap = new Map<string, number>();
  const chainPromises: Promise<void>[] = [];

  for (const [chainId, queries] of byChain) {
    const rpc = getChainRpc(chainId);
    if (!rpc) {
      console.warn(`[onchain-supply] No RPC config for chain: ${chainId}`);
      continue;
    }

    chainPromises.push(
      (async () => {
        let results: Map<string, number>;
        if (rpc.type === "evm") {
          results = await fetchEvmSupply(rpc.rpcUrl, queries, rpc.fallbackRpcUrl, rpc.alchemyPrimary);
        } else {
          results = await fetchTronSupply(rpc.rpcUrl, queries, tronApiKey);
        }
        for (const [key, supply] of results) {
          supplyMap.set(key, supply);
        }
      })()
    );
  }

  await Promise.all(chainPromises);

  // Write results to D1
  const rows = Array.from(supplyMap.entries()).map(([key, supply]) => {
    const [stablecoinId, chain] = key.split(":");
    return { stablecoinId, chain, supply };
  });

  if (rows.length > 0) {
    await upsertOnchainSupply(db, rows);
    console.log(`[onchain-supply] Updated ${rows.length} supply entries across ${byChain.size} chains`);
  } else {
    console.warn("[onchain-supply] No supply data retrieved");
  }
}
```

**Step 6: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: Passes.

---

### Task 4: Tighten Override Guards in sync-stablecoins.ts

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts:543-551`

**Step 1: Change the upper guard from 10x to 3x**

Find lines 543-551 (the `>10x` guard):

```typescript
        // Guard: never override if on-chain total is dramatically HIGHER than DefiLlama.
        // Some contracts return max/premined supply rather than circulating (e.g. commodity tokens).
        if (!isForced && llamaSupply > 0 && onchainTotal > llamaSupply * 10) {
          console.warn(
            `[sync-stablecoins] Rejecting on-chain override for ${asset.symbol}: ` +
            `on-chain ${onchainTotal.toFixed(0)} is >10x DL ${llamaSupply.toFixed(0)} — likely max supply, not circulating`
          );
          continue;
        }
```

Replace with:

```typescript
        // Guard: never override if on-chain total is dramatically HIGHER than DefiLlama.
        // If on-chain is >3x DL, likely includes non-circulating tokens (treasury, pre-minted capacity).
        if (!isForced && llamaSupply > 0 && onchainTotal > llamaSupply * 3) {
          console.warn(
            `[sync-stablecoins] Rejecting on-chain override for ${asset.symbol}: ` +
            `on-chain ${onchainTotal.toFixed(0)} is >3x DL ${llamaSupply.toFixed(0)} — likely includes non-circulating tokens`
          );
          continue;
        }
```

**Step 2: Add critical warning for large overrides**

After the `>3x` guard and before the "Override: recompute" comment (around line 553), add:

```typescript
        // Warning: flag large absolute overrides for monitoring
        const overrideAmountUsd = Math.abs(onchainTotal * (price ?? 0) - llamaMcap);
        if (overrideAmountUsd > 500_000_000) {
          console.warn(
            `[sync-stablecoins] LARGE OVERRIDE for ${asset.symbol}: ` +
            `mcap change $${(overrideAmountUsd / 1e6).toFixed(0)}M — verify data quality`
          );
        }
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Passes.

---

### Task 5: Verify crvUSD StablecoinLens Selector

**Files:** None (verification only)

Before deploying, verify the `circulating_supply()` function selector is correct.

**Step 1: Verify the selector on-chain**

Run the following to confirm `0x9e2bf22c` returns a reasonable value from StablecoinLens:

```bash
curl -s https://cloudflare-eth.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xe24e2db9f6bb40bbe7c1c025bc87104f5401ecd7","data":"0x9e2bf22c"},"latest"],"id":1}'
```

Expected: A hex value that, when divided by 10^18, gives a number in the hundreds of millions (matching DefiLlama's ~$276M circulating crvUSD).

**Step 2: Verify MIM DegenBox balance**

```bash
curl -s https://cloudflare-eth.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3","data":"0x70a08231000000000000000000000000d96f48665a1410C0CD669A88898ecA36B9Fc2cce"},"latest"],"id":1}'
```

Expected: A large hex value representing the MIM balance in DegenBox (should be ~140M tokens in 18-decimal format, i.e., the difference between totalSupply ~174M and circulating ~32M).

**Step 3: Verify USDT Tether Treasury balance**

```bash
curl -s https://cloudflare-eth.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xdac17f958d2ee523a2206206994597c13d831ec7","data":"0x70a082310000000000000000000000005754284f345afc66a98fbB0a0Afe71e0f007b949"},"latest"],"id":1}'
```

Expected: A hex value representing Tether Treasury USDT on Ethereum (should be in the billions in 6-decimal format).

---

### Task 6: Full Build + Type-Check Verification

**Files:** None (verification only)

**Step 1: Frontend build**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean, no errors.

**Step 3: Review the sync-onchain-supply.ts diff**

Review the complete diff to ensure:
- No calls to the old `fetchEvmTotalSupply` or `fetchTronTotalSupply` remain
- All original functionality (batch chunking, fallback RPC, Tron support) is preserved
- The new `decimals()` verification doesn't block supply writes for tokens where `decimals()` fails (e.g., non-standard contracts) — it only blocks when there's an explicit mismatch

---

### Task 7: Update Documentation

**Files:**
- Modify: `docs/data-pipeline.md`

**Step 1: Update the on-chain supply section**

Find the section about on-chain supply verification and update it to document the new supply methods:

Add a paragraph explaining:
- Tokens can now have per-token `supplyMethod` configs
- Three method types: `totalSupply` (default), `totalSupply-minus-addresses`, `custom-contract`
- Override guard tightened from 10x to 3x
- On-chain decimals verification catches config mistakes

**Step 2: Update the existing design doc status**

In `docs/plans/2026-02-19-onchain-supply-verification-design.md`, change the status line from `Draft` to:

```
**Status:** Superseded by 2026-02-20-circulating-supply-reliability-design.md
```
