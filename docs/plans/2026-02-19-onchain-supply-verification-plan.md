# On-Chain Supply Verification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify and override stablecoin supply data using on-chain `totalSupply()` queries, and display contract addresses on detail pages.

**Architecture:** Separate cron (`sync-onchain-supply.ts`) queries public RPCs for `totalSupply()` across EVM + Tron chains, writes results to D1 `onchain_supply` table. Main sync reads this table and overrides DefiLlama supply when divergence > 5%. Contract addresses are stored inline in `StablecoinMeta`.

**Tech Stack:** Cloudflare Workers, D1 SQLite, JSON-RPC (EVM), TronGrid API, Next.js 16, React 19, TypeScript strict, Tailwind v4.

---

### Task 1: Add ContractDeployment type and update StablecoinMeta

**Files:**
- Modify: `src/lib/types.ts:40-51` (StablecoinMeta interface)
- Modify: `src/lib/stablecoins.ts:3-14` (StablecoinOpts interface)

**Step 1: Add ContractDeployment interface to types.ts**

Add before the `StablecoinMeta` interface (around line 39):

```typescript
export interface ContractDeployment {
  chain: string;      // Chain ID (e.g., "ethereum", "arbitrum", "tron")
  address: string;    // Contract address (0x... for EVM, T... for Tron)
  decimals: number;   // Token decimals
}
```

Add `contracts` field to `StablecoinMeta`:

```typescript
export interface StablecoinMeta {
  id: string;
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  goldOunces?: number;
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[];  // <-- NEW
}
```

**Step 2: Add `contracts` to StablecoinOpts in stablecoins.ts**

In the `StablecoinOpts` interface (line 3), add:

```typescript
contracts?: import("./types").ContractDeployment[];
```

Then update the three helper functions (`usd()`, `eur()`, `other()`) to pass through `contracts: opts?.contracts`:

In each return statement, add `contracts: opts?.contracts` to the returned object.

**Step 3: Verify types compile**

Run: `npm run build` from project root.

Run: `cd worker && npx tsc --noEmit`

Expected: Both pass (no functional changes yet, just type additions).

**Step 4: Commit**

```
feat: add ContractDeployment type to StablecoinMeta
```

---

### Task 2: Create chain RPC configuration

**Files:**
- Create: `worker/src/lib/chain-rpcs.ts`

**Step 1: Create the chain RPC config file**

```typescript
export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron";
  rpcUrl: string;
  fallbackRpcUrl?: string;
  explorerUrl: string;  // For linking addresses on the frontend
}

export const CHAIN_RPCS: ChainRpcConfig[] = [
  { chainId: "ethereum",  chainName: "Ethereum",  type: "evm",  rpcUrl: "https://cloudflare-eth.com",              explorerUrl: "https://etherscan.io" },
  { chainId: "arbitrum",  chainName: "Arbitrum",  type: "evm",  rpcUrl: "https://arb1.arbitrum.io/rpc",            explorerUrl: "https://arbiscan.io" },
  { chainId: "base",      chainName: "Base",      type: "evm",  rpcUrl: "https://mainnet.base.org",                explorerUrl: "https://basescan.org" },
  { chainId: "optimism",  chainName: "Optimism",  type: "evm",  rpcUrl: "https://mainnet.optimism.io",             explorerUrl: "https://optimistic.etherscan.io" },
  { chainId: "polygon",   chainName: "Polygon",   type: "evm",  rpcUrl: "https://polygon-rpc.com",                 explorerUrl: "https://polygonscan.com" },
  { chainId: "avalanche", chainName: "Avalanche", type: "evm",  rpcUrl: "https://api.avax.network/ext/bc/C/rpc",   explorerUrl: "https://snowscan.xyz" },
  { chainId: "bsc",       chainName: "BSC",       type: "evm",  rpcUrl: "https://bsc-dataseed.binance.org",        explorerUrl: "https://bscscan.com" },
  { chainId: "gnosis",    chainName: "Gnosis",    type: "evm",  rpcUrl: "https://rpc.gnosischain.com",             explorerUrl: "https://gnosisscan.io" },
  { chainId: "fantom",    chainName: "Fantom",    type: "evm",  rpcUrl: "https://rpc.ftm.tools",                   explorerUrl: "https://ftmscan.com" },
  { chainId: "celo",      chainName: "Celo",      type: "evm",  rpcUrl: "https://forno.celo.org",                  explorerUrl: "https://celoscan.io" },
  { chainId: "tron",      chainName: "Tron",      type: "tron", rpcUrl: "https://api.trongrid.io",                 explorerUrl: "https://tronscan.org" },
];

/** Look up RPC config by chain ID */
export function getChainRpc(chainId: string): ChainRpcConfig | undefined {
  return CHAIN_RPCS.find((c) => c.chainId === chainId);
}
```

**Step 2: Verify worker types compile**

Run: `cd worker && npx tsc --noEmit`

Expected: PASS — file is self-contained.

**Step 3: Commit**

```
feat: add chain RPC configuration for on-chain supply queries
```

---

### Task 3: Create D1 migration for onchain_supply table

**Files:**
- Create: `worker/migrations/0013_onchain_supply.sql`

**Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stablecoin_id, chain)
);
```

**Step 2: Apply migration locally**

Run: `cd worker && npx wrangler d1 migrations apply stablecoin-db --local`

Expected: Migration applied successfully.

**Step 3: Commit**

```
feat: add onchain_supply D1 table migration
```

---

### Task 4: Implement the on-chain supply sync cron

**Files:**
- Create: `worker/src/cron/sync-onchain-supply.ts`
- Modify: `worker/src/lib/db.ts` (add `getOnchainSupply` and `upsertOnchainSupply` helpers)

**Step 1: Add D1 helper functions to db.ts**

Add at the end of `worker/src/lib/db.ts`:

```typescript
export interface OnchainSupplyRow {
  stablecoin_id: string;
  chain: string;
  supply: number;
  updated_at: number;
}

/** Read all on-chain supply rows fresher than maxAgeSec */
export async function getOnchainSupply(db: D1Database, maxAgeSec: number): Promise<OnchainSupplyRow[]> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const result = await db
    .prepare("SELECT stablecoin_id, chain, supply, updated_at FROM onchain_supply WHERE updated_at > ?")
    .bind(cutoff)
    .all<OnchainSupplyRow>();
  return result.results ?? [];
}

/** Upsert on-chain supply for a stablecoin on a specific chain */
export async function upsertOnchainSupply(
  db: D1Database,
  rows: { stablecoinId: string; chain: string; supply: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((r) =>
    db.prepare("INSERT OR REPLACE INTO onchain_supply (stablecoin_id, chain, supply, updated_at) VALUES (?, ?, ?, ?)")
      .bind(r.stablecoinId, r.chain, r.supply, now)
  );
  await batchExecute(db, stmts);
}
```

**Step 2: Create sync-onchain-supply.ts**

This is the core cron. It needs to:
1. Load all `StablecoinMeta` entries with `contracts`.
2. Group by chain.
3. For EVM chains: JSON-RPC batch `eth_call` for `totalSupply()` (selector `0x18160ddd`).
4. For Tron: call `triggerConstantContract`.
5. Parse results, divide by `10^decimals`.
6. Write to D1.

```typescript
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { getChainRpc } from "../lib/chain-rpcs";
import { upsertOnchainSupply } from "../lib/db";
import { USER_AGENT } from "../lib/constants";
import type { ContractDeployment } from "../../../src/lib/types";

interface ContractQuery {
  stablecoinId: string;
  contract: ContractDeployment;
}

/** Fetch totalSupply for a batch of EVM contracts on one chain via JSON-RPC batch */
async function fetchEvmTotalSupply(
  rpcUrl: string,
  queries: ContractQuery[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  // totalSupply() selector
  const selector = "0x18160ddd";

  const batchBody = queries.map((q, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: q.contract.address, data: selector }, "latest"],
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
      return results;
    }

    const responses = (await res.json()) as { id: number; result?: string; error?: unknown }[];

    for (const resp of responses) {
      const query = queries[resp.id];
      if (!query || !resp.result || resp.result === "0x") continue;

      try {
        const rawBigInt = BigInt(resp.result);
        const supply = Number(rawBigInt) / Math.pow(10, query.contract.decimals);
        if (supply > 0) {
          const key = `${query.stablecoinId}:${query.contract.chain}`;
          results.set(key, supply);
        }
      } catch {
        console.warn(`[onchain-supply] Failed to parse supply for ${query.stablecoinId} on ${query.contract.chain}`);
      }
    }
  } catch (err) {
    console.error(`[onchain-supply] RPC request failed for ${rpcUrl}:`, err);
  }

  return results;
}

/** Fetch totalSupply for Tron contracts via triggerConstantContract */
async function fetchTronTotalSupply(
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

  for (const query of queries) {
    try {
      const res = await fetch(`${rpcUrl}/wallet/triggerConstantContract`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", // any valid address
          contract_address: query.contract.address,
          function_selector: "totalSupply()",
          parameter: "",
          visible: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as { constant_result?: string[] };
      const hex = data.constant_result?.[0];
      if (!hex) continue;

      const rawBigInt = BigInt("0x" + hex);
      const supply = Number(rawBigInt) / Math.pow(10, query.contract.decimals);
      if (supply > 0) {
        const key = `${query.stablecoinId}:${query.contract.chain}`;
        results.set(key, supply);
      }
    } catch {
      console.warn(`[onchain-supply] Tron query failed for ${query.stablecoinId}`);
    }
  }

  return results;
}

export async function syncOnchainSupply(db: D1Database, tronApiKey: string | null): Promise<void> {
  // Collect all contracts from tracked stablecoins
  const allQueries: ContractQuery[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
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
          results = await fetchEvmTotalSupply(rpc.rpcUrl, queries);
        } else {
          results = await fetchTronTotalSupply(rpc.rpcUrl, queries, tronApiKey);
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

**Step 3: Verify worker types compile**

Run: `cd worker && npx tsc --noEmit`

Expected: PASS.

**Step 4: Commit**

```
feat: implement on-chain supply sync cron
```

---

### Task 5: Wire up the on-chain supply cron in the worker

**Files:**
- Modify: `worker/src/index.ts` (add import + cron case)
- Modify: `worker/wrangler.toml` (add cron schedule)

**Step 1: Add cron schedule to wrangler.toml**

Change the `crons` array to add a `*/30 * * * *` entry:

```toml
[triggers]
crons = [
  "*/5 * * * *",
  "*/10 * * * *",
  "*/15 * * * *",
  "*/30 * * * *",
  "0 */2 * * *",
]
```

**Step 2: Add import and cron case in index.ts**

Add import at top:
```typescript
import { syncOnchainSupply } from "./cron/sync-onchain-supply";
```

Add a new case in the `scheduled` switch:
```typescript
case "*/30 * * * *":
  ctx.waitUntil(syncOnchainSupply(env.DB, env.TRONGRID_API_KEY ?? null));
  break;
```

**Step 3: Verify worker types compile**

Run: `cd worker && npx tsc --noEmit`

Expected: PASS.

**Step 4: Commit**

```
feat: wire on-chain supply cron at 30min interval
```

---

### Task 6: Add override logic to sync-stablecoins.ts

**Files:**
- Modify: `worker/src/cron/sync-stablecoins.ts` (add on-chain override step before cache write)

**Step 1: Add import**

At the top of `sync-stablecoins.ts`, add:
```typescript
import { getOnchainSupply } from "../lib/db";
```

Note: `getOnchainSupply` is already importable because `getCache`, `setCacheIfNewer`, etc. are imported from `"../lib/db"` — just add the new function to the existing import.

**Step 2: Add override logic**

Insert the override logic **after** the supply sanity check (line ~486, after `totalSupply < 100_000_000_000` guard) and **before** the FX rates embedding (line ~489). The override should run after prices are finalized but before the cache write.

```typescript
// --- On-chain supply override ---
try {
  const onchainRows = await getOnchainSupply(db, 7200); // 2-hour freshness
  if (onchainRows.length > 0) {
    // Group by stablecoin ID
    const byStablecoin = new Map<string, { chain: string; supply: number }[]>();
    for (const row of onchainRows) {
      const list = byStablecoin.get(row.stablecoin_id) ?? [];
      list.push({ chain: row.chain, supply: row.supply });
      byStablecoin.set(row.stablecoin_id, list);
    }

    let overrideCount = 0;
    for (const [stablecoinId, chainSupplies] of byStablecoin) {
      const asset = llamaData.peggedAssets.find((a) => String(a.id) === stablecoinId);
      if (!asset) continue;

      const onchainTotal = chainSupplies.reduce((s, c) => s + c.supply, 0);
      const price = asset.price as number | null;
      if (!price || price <= 0 || onchainTotal <= 0) continue;

      // Compare on-chain supply (token units) with DefiLlama supply (token units)
      const circ = asset.circulating as Record<string, number> | undefined;
      const llamaMcap = circ ? Object.values(circ).reduce((s, v) => s + (v ?? 0), 0) : 0;
      const llamaSupply = llamaMcap / price;

      const divergence = Math.abs(onchainTotal - llamaSupply) / Math.max(llamaSupply, 1);
      if (divergence <= 0.05) continue; // Within 5%, keep DefiLlama

      // Override: recompute circulating in USD (DefiLlama convention)
      const pegKey = Object.keys(circ ?? {})[0] ?? asset.pegType ?? "peggedUSD";
      const newMcap = onchainTotal * price;
      asset.circulating = { [pegKey]: newMcap };

      // Override chainCirculating with per-chain data
      const chainCirc: Record<string, { current: number; circulatingPrevDay: number; circulatingPrevWeek: number; circulatingPrevMonth: number }> = {};
      for (const cs of chainSupplies) {
        const chainMcap = cs.supply * price;
        chainCirc[cs.chain] = {
          current: chainMcap,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        };
      }
      asset.chainCirculating = chainCirc;
      asset.chains = chainSupplies.map((cs) => cs.chain);

      overrideCount++;
      console.log(
        `[sync-stablecoins] On-chain override for ${asset.symbol} (id=${stablecoinId}): ` +
        `DL=${llamaSupply.toFixed(0)} → OnChain=${onchainTotal.toFixed(0)} tokens, mcap $${newMcap.toFixed(0)}`
      );
    }

    if (overrideCount > 0) {
      console.log(`[sync-stablecoins] Applied ${overrideCount} on-chain supply overrides`);
    }
  }
} catch (err) {
  console.error("[sync-stablecoins] On-chain supply override failed:", err);
}
```

**Step 3: Verify worker types compile**

Run: `cd worker && npx tsc --noEmit`

Expected: PASS.

**Step 4: Commit**

```
feat: override DefiLlama supply with on-chain data when divergence > 5%
```

---

### Task 7: Add contract addresses UI on stablecoin detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx` (add ContractAddresses component)

**Step 1: Create ContractAddresses component**

Add this component in `client.tsx`, after the `IssuerInfoCard` component (around line 162):

```typescript
import { CHAIN_RPCS } from "../../../../worker/src/lib/chain-rpcs";

function ContractAddresses({ meta }: { meta: StablecoinMeta }) {
  if (!meta.contracts || meta.contracts.length === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contract Addresses</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {meta.contracts.map((c) => {
            const chainRpc = CHAIN_RPCS.find((r) => r.chainId === c.chain);
            const explorerUrl = chainRpc?.explorerUrl;
            const addressUrl = c.chain === "tron"
              ? `${explorerUrl}/#/contract/${c.address}`
              : `${explorerUrl}/address/${c.address}`;

            return (
              <div key={`${c.chain}-${c.address}`} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-sm font-medium text-muted-foreground">{chainRpc?.chainName ?? c.chain}</span>
                <a
                  href={addressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-500 hover:underline"
                >
                  {c.address.slice(0, 6)}...{c.address.slice(-4)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Render the component in the detail page**

In the `StablecoinDetailClient` return JSX (around line 403), add after `<IssuerInfoCard>`:

```tsx
{meta && (
  <ContractAddresses meta={meta} />
)}
```

**Step 3: Verify frontend builds**

Run: `npm run build`

Expected: PASS.

**Important note:** The import of `CHAIN_RPCS` from the worker directory works because the root tsconfig allows importing from `worker/src/lib/`. Verify this compiles. If it doesn't, an alternative is to move the chain config to `src/lib/` (shared between frontend and worker) or duplicate just the explorer URL mapping. Check `src/lib/blacklist-contracts.ts` — it already has explorer URLs per chain, so you could reuse those instead of importing from the worker. If the worker import doesn't work, create a minimal `src/lib/chain-explorers.ts` mapping chain IDs to explorer URLs.

**Step 4: Commit**

```
feat: display contract addresses on stablecoin detail page
```

---

### Task 8: Populate contract addresses for priority stablecoins

**Files:**
- Modify: `src/lib/stablecoins.ts` (add `contracts` to stablecoin entries)

This is the data entry task. Populate `contracts` for stablecoins, prioritizing:

1. **Reuse blacklist data:** USDC (id=2), USDT (id=1), PAXG (gold-paxg), XAUT (gold-xaut) — addresses already in `src/lib/blacklist-contracts.ts`.

2. **Non-USD stables with known data issues:** EURS, agEUR/EURA, EURe, EURC, stEUR, ZCHF, crvUSD, GHO, PYUSD, FDUSD, etc.

3. **Top USD stables:** DAI, USDS, USDe, FRAX, TUSD, LUSD, etc.

**Step 1: Add contracts to entries**

For each stablecoin, look up contract addresses from:
- DefiLlama API response (has `address` field, typically Ethereum)
- Project documentation (for multi-chain deployments)
- Existing `blacklist-contracts.ts` (for USDC/USDT/PAXG/XAUT)

Example entries:

```typescript
// USDT (id=1)
usd("1", "Tether", "USDT", "rwa-backed", "centralized", {
  // ... existing opts ...
  contracts: [
    { chain: "ethereum", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { chain: "tron", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
    { chain: "arbitrum", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
    { chain: "optimism", address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6 },
    { chain: "polygon", address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
    { chain: "avalanche", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6 },
    { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 },
  ],
})

// USDC (id=2)
usd("2", "USD Coin", "USDC", "rwa-backed", "centralized", {
  // ... existing opts ...
  contracts: [
    { chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    { chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
    { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    { chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
    { chain: "polygon", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
    { chain: "avalanche", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
  ],
})

// EURC (id=220) — Circle EUR stablecoin
eur("220", "Euro Coin", "EURC", "rwa-backed", "centralized", {
  // ... existing opts ...
  contracts: [
    { chain: "ethereum", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", decimals: 6 },
    { chain: "base", address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 },
    { chain: "avalanche", address: "0xc891eb4cbdeff6e073e859e987815ed1505c2acd", decimals: 6 },
  ],
})
```

**This is a data-heavy task.** Work through stablecoins methodically. For each stablecoin:
- Check if the address can be found in the DefiLlama API response or project docs.
- Verify address by cross-referencing the token symbol on the block explorer.
- At minimum, add the Ethereum mainnet address. Add L2/alt-chain addresses where available.

**Step 2: Verify types compile and build passes**

Run: `npm run build`

Run: `cd worker && npx tsc --noEmit`

Expected: Both pass.

**Step 3: Commit**

```
feat: populate contract addresses for tracked stablecoins
```

---

### Task 9: End-to-end verification

**Step 1: Run the worker locally**

Run: `cd worker && npx wrangler dev`

Verify the on-chain supply cron can be triggered manually (use the wrangler dev console or `curl` to trigger).

**Step 2: Verify the frontend builds**

Run: `npm run build`

Expected: Clean build, no type errors.

**Step 3: Verify the detail page renders contracts**

Run: `npm run dev`

Navigate to a stablecoin detail page that has contracts populated (e.g., USDT, USDC). Verify the "Contract Addresses" section appears with clickable explorer links.

**Step 4: Final commit if any fixes needed**

```
fix: address issues found during e2e verification
```
