# On-Chain Supply Verification — Design

**Date:** 2026-02-19
**Status:** Superseded by 2026-02-20-circulating-supply-reliability-design.md

## Problem

Non-USD stablecoins (EUR, GBP, JPY, gold-pegged, etc.) often have inaccurate supply and market cap figures on DefiLlama and CoinGecko. These data aggregators don't always process non-USD stables correctly, leading to unreliable numbers on the dashboard. On-chain `totalSupply()` is the ground truth and should be used to verify — and when necessary override — aggregator data.

## Goals

1. Maintain a registry of contract addresses for all tracked stablecoins across all deployment chains.
2. Query on-chain `totalSupply()` to compute verifiable supply per stablecoin.
3. Override DefiLlama supply/market cap when on-chain data diverges significantly.
4. Display contract addresses on the stablecoin detail page.

## Non-Goals

- Historical on-chain supply tracking (only current state).
- Solana, Cosmos, or other non-EVM/non-Tron chains (future work).
- Replacing DefiLlama entirely — it remains the primary source; on-chain is a verification/override layer.

## Architecture

### Data Model

Add `contracts` to `StablecoinMeta` in `src/lib/stablecoins.ts`:

```typescript
// types.ts
export interface ContractDeployment {
  chain: string;      // Chain ID matching CHAIN_RPCS (e.g., "ethereum", "arbitrum")
  address: string;    // Contract address (0x... for EVM, T... for Tron)
  decimals: number;   // Token decimals
}

export interface StablecoinMeta {
  // ... existing fields ...
  contracts?: ContractDeployment[];
}
```

Contracts are defined inline in `stablecoins.ts` alongside other metadata. The `StablecoinOpts` helper type and `usd()`/`eur()`/`other()` constructors gain a `contracts` parameter.

### Chain RPC Configuration

New file `worker/src/lib/chain-rpcs.ts`:

```typescript
export interface ChainRpcConfig {
  chainId: string;
  chainName: string;
  type: "evm" | "tron";
  rpcUrl: string;
  fallbackRpcUrl?: string;
}

export const CHAIN_RPCS: ChainRpcConfig[] = [
  { chainId: "ethereum", chainName: "Ethereum", type: "evm", rpcUrl: "https://cloudflare-eth.com" },
  { chainId: "arbitrum", chainName: "Arbitrum", type: "evm", rpcUrl: "https://arb1.arbitrum.io/rpc" },
  { chainId: "base",     chainName: "Base",     type: "evm", rpcUrl: "https://mainnet.base.org" },
  { chainId: "optimism", chainName: "Optimism", type: "evm", rpcUrl: "https://mainnet.optimism.io" },
  { chainId: "polygon",  chainName: "Polygon",  type: "evm", rpcUrl: "https://polygon-rpc.com" },
  { chainId: "avalanche",chainName: "Avalanche",type: "evm", rpcUrl: "https://api.avax.network/ext/bc/C/rpc" },
  { chainId: "bsc",      chainName: "BSC",      type: "evm", rpcUrl: "https://bsc-dataseed.binance.org" },
  { chainId: "tron",     chainName: "Tron",     type: "tron",rpcUrl: "https://api.trongrid.io" },
];
```

### D1 Schema

```sql
CREATE TABLE onchain_supply (
  stablecoin_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  supply REAL NOT NULL,        -- Human-readable supply (decimals applied)
  updated_at INTEGER NOT NULL, -- Unix seconds
  PRIMARY KEY (stablecoin_id, chain)
);
```

Upserted each sync cycle via `INSERT OR REPLACE`.

### New Cron: `sync-onchain-supply.ts`

**Schedule:** Every 30 minutes (new entry in `wrangler.toml` crons).

**Flow:**

1. Load all `StablecoinMeta` entries with `contracts` defined.
2. Group contracts by chain ID.
3. For each EVM chain:
   - Build a JSON-RPC batch of `eth_call` requests for `totalSupply()` (selector `0x18160ddd`).
   - Send as a single HTTP POST to the chain's RPC endpoint.
   - Parse hex results, divide by `10^decimals`.
4. For Tron:
   - Call `triggerConstantContract` on `totalSupply()` for each contract.
   - Parse results similarly.
5. Write per-chain supply to `onchain_supply` table.

**Error handling:**
- Individual contract failures: log and skip, don't block others.
- Entire chain RPC down: skip chain for this cycle, previous data remains.
- Timeout: 10s per RPC call, 30s total per chain batch.

### Override Logic in `sync-stablecoins.ts`

After fetching DefiLlama data and before cache write:

1. Read `onchain_supply` rows where `updated_at > now - 7200` (2-hour freshness).
2. For each stablecoin with on-chain data:
   - `onchainTotal` = sum of supply across all chains.
   - `llamaTotal` = `getCirculatingRaw(coin)` from DefiLlama data.
   - If `|onchainTotal - llamaTotal| / llamaTotal > 0.05` (5% divergence):
     - Override `circulating` with `{ [pegType]: onchainTotal * price }` (USD-denominated to match DefiLlama convention).
     - Override `chainCirculating` with per-chain values from `onchain_supply`.
     - Log: `[override] ${symbol}: DefiLlama=${llamaTotal} → OnChain=${onchainTotal}`.
3. Market cap = `onchainTotal (token units) × price (from enrichment pipeline)`.

**Why 5% threshold:** Small rounding differences between on-chain and DefiLlama are normal (DefiLlama may exclude burned tokens, lock contracts, etc.). Only override when the difference is material.

### Frontend: Contract Addresses on Detail Page

Add a "Contracts" section to the stablecoin detail page (`src/app/stablecoin/[id]/`):

- List each chain + contract address, linked to the chain's block explorer.
- Show on-chain supply per chain (from the API response, when available).
- Reuse explorer URL patterns from `blacklist-contracts.ts` chain configs.

### API Changes

The `/api/stablecoin/:id` response already returns the full `StablecoinData`. The override happens at cache level, so no API changes needed for supply data.

For contract addresses, the frontend reads directly from `StablecoinMeta` (already available client-side via `TRACKED_STABLECOINS`).

### Data Population Strategy

1. **Blacklist reuse:** USDC, USDT, PAXG, XAUT already have per-chain addresses in `blacklist-contracts.ts`. Copy these into `stablecoins.ts`.
2. **DefiLlama address field:** The API response includes an `address` field (typically Ethereum). Use this as a starting point for single-chain coverage.
3. **Manual curation:** For non-USD stables and other priority coins, look up multi-chain addresses from project documentation. This is a one-time effort per stablecoin.
4. **Incremental:** Not all 130 stablecoins need full multi-chain contracts on day one. Prioritize: non-USD stables (most data issues), then top-20 USD stables, then the rest.

## Cron Schedule Summary

| Cron | Interval | Purpose |
|------|----------|---------|
| `sync-stablecoins` | 5 min | DefiLlama + price enrichment + override application |
| `sync-onchain-supply` | 30 min (piggybacks on `*/10` cron at :00 and :30) | On-chain totalSupply queries → D1 |
| `sync-blacklist` | 10 min | Blacklist/freeze event tracking |
| `sync-dex-liquidity` | 15 min | DEX liquidity scoring |
| `sync-fx-rates` | 2 hours | FX rates from ECB |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Public RPC rate limits | JSON-RPC batching, 30min interval, fallback URLs |
| Wrong contract address in registry | Manual curation + sanity check (supply > 0, reasonable range) |
| Proxy contract upgrade changes totalSupply semantics | Rare; monitor for zero/anomalous supply returns |
| On-chain supply includes burned/locked tokens | 5% threshold absorbs minor discrepancies; flag large ones for review |
| Tron RPC differences | Separate code path using triggerConstantContract API |
