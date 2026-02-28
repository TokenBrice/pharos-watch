# Liquidity Score Coverage Expansion

**Date:** 2026-02-28
**Status:** Approved

## Problem

25 of 143 tracked stablecoins have no liquidity score (score 0 or null). Several have significant DEX presence that the pipeline misses:

- **YLDS** ($588M supply) — $3.9M TVL on Raydium (Solana)
- **REUSD** ($39M) — $1.9M TVL on Curve (Ethereum) — lost to symbol collision
- **NECT** ($18M) — $155K TVL on Kodiak/Winnieswap (Berachain)
- **CUSD** Cap ($108M) — $17K on Prism (MegaETH)
- **USDGO** ($50M) — $15K on Orca (Solana)
- **pUSD** ($6.7M) — $2.4M TVL on Uniswap V3 (Arbitrum)

Root causes: unsupported chains in CG/GT maps (Solana, Berachain, Sui), symbol collisions (CUSD, GUSD, USDM), and missing fallback source for exotic chains.

## Design

Three-pronged approach: fix matching, expand chain support, add universal fallback.

### 1. Auto-Seed Address Map from Contracts

**Current state:** `buildSymbolLookups()` in `sync-dex-liquidity.ts` seeds `addressToId` with 2 hard-coded entries for known collisions (reUSD vs REUSD).

**Change:** Replace the hard-coded seed with an automatic loop over all `TRACKED_STABLECOINS` contract entries. Every coin with contracts gets address-based matching from day one.

```
for (const meta of TRACKED_STABLECOINS) {
  for (const contract of meta.contracts ?? []) {
    addressToId.set(contract.address.toLowerCase(), meta.id);
  }
}
```

This makes symbol collision handling automatic — no manual enumeration needed. The two existing hard-coded entries become redundant and are removed.

**Also:** In `processPoolMetrics`, when a DeFiLlama pool has `underlyingTokens` (contract addresses), use `addressToId` for matching before falling back to symbol matching. This prevents false attribution for colliding symbols.

### 2. Expand CoinGecko/GeckoTerminal Chain Maps

Add missing chains to `CG_CHAIN_MAP` (in `worker/src/lib/coingecko-onchain.ts`) and `GT_CHAIN_MAP` (in `sync-dex-liquidity.ts`):

| Chain | Our name | CG ID | GT ID |
|-------|----------|-------|-------|
| Solana | `solana` | `solana` | `solana` |
| Berachain | `berachain` | `berachain` | `berachain` |
| Sui | `sui` | `sui-network` | `sui-network` |

The existing `buildChainAddresses()` function iterates all contract entries and maps through the chain map — adding chains automatically enables pool discovery for coins with contracts on those chains.

Expected to pick up: YLDS (Raydium), NECT (Kodiak), USDGO (Orca), ISC, EURR on Solana.

Rate impact: ~10-15 extra CG API requests per sync. Well within Pro limits.

### 3. DexScreener Universal Fallback

After the main pipeline (steps 1-5b), query DexScreener for any tracked coin still at 0 pools.

**New file:** `worker/src/lib/dexscreener.ts`
- Thin wrapper for DexScreener token pools API
- Endpoint: `GET /tokens/v1/{chainId}/{tokenAddress}`
- Rate limiting: 60 req/min free tier (~50 queries needed max)
- Types for pool response

**Integration in `syncDexLiquidity()`:**
- New step 5c: after merging CG/GT pools, identify zero-pool coins
- For each, iterate their `contracts`, query DexScreener by chain+address
- Convert results to pool metrics:
  - TVL from `liquidity.usd`
  - Volume from `volume.h24`
  - Quality: use `GT_DEX_QUALITY` for known DEX IDs, `generic` (0.3) otherwise
  - Balance ratio: approximate from token prices if available
- **Deduplication:** Check each DexScreener pool address against `knownPoolAddrs` before merging (prevents double-counting with main pipeline)
- Merge into existing `metrics` map
- Scoring pipeline treats these pools identically

**DexScreener chain ID mapping:**
```
solana → solana
berachain → berachain
ethereum → ethereum
base → base
arbitrum → arbitrum
polygon → polygon
bsc → bsc
...
```
For unmapped chains, skip gracefully.

**Minimum quality gates:**
- Pool TVL must be > $1,000
- Pool must have non-zero volume in last 7 days OR TVL > $10,000
- Skip pools where our token is the quote token of a meme/unknown pair

### 4. Coverage Regression Test

New test file that verifies:

1. Every chain in any tracked coin's `contracts` list appears in either `CG_CHAIN_MAP`, `GT_CHAIN_MAP`, or an explicit `UNSUPPORTED_CHAINS` allowlist
2. All colliding symbols (symbols shared by 2+ tracked coins) have all member coins' addresses present in the auto-seeded `addressToId` map

This catches regressions when adding new coins — test fails if a coin uses an unmapped chain or creates an unresolved symbol collision.

## Files Changed

| File | Change |
|------|--------|
| `worker/src/lib/coingecko-onchain.ts` | Add Solana, Berachain, Sui to `CG_CHAIN_MAP` |
| `worker/src/cron/sync-dex-liquidity.ts` | Expand `GT_CHAIN_MAP`, auto-seed `addressToId`, add DexScreener fallback step, address-first matching in `processPoolMetrics` |
| `worker/src/lib/dexscreener.ts` | New file: DexScreener API wrapper with rate limiting and types |
| `src/app/about/page.tsx` | Add DexScreener as data source |
| `docs/dex-liquidity.md` | Update with new sources and chain coverage |
| `src/tests/` or `worker/tests/` | Coverage regression test |

## Expected Impact

- From ~25 zero-score tracked coins to ~8-10 (genuinely illiquid RWA/institutional tokens)
- YLDS, REUSD, NECT, pUSD, USDGO, CUSD should gain scores
- USYC, TBILL, rwaUSDi, cgUSD, gold/silver tokens remain at 0 (no DEX pools exist)

## Non-Goals

- Not adding DexScreener for coins already scored by the main pipeline
- Not using DexScreener's symbol search (collision-prone)
- Not querying DexScreener for coins without contracts (gold-kau, etc.)
- Not adding support for chains with no standard DEX infrastructure (Cardano/XRPL)
