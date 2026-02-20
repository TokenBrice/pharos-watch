# Circulating Supply Reliability — Design

**Date:** 2026-02-20
**Status:** Implemented

## Problem

The on-chain supply system calls `totalSupply()` on every stablecoin contract. For many tokens, `totalSupply()` includes non-circulating tokens (treasury reserves, pre-minted lending capacity, protocol reserves), producing inflated supply figures.

**Live production impact (discovered 2026-02-20):**
- **crvUSD**: Showing $2,055M instead of $276M (7.5x inflation) — `totalSupply()` includes unborrowed capacity in Controllers + PegKeeper reserves
- **MIM**: Showing $174M instead of $32M (5.4x inflation) — `totalSupply()` includes unborrowed MIM in Cauldrons/DegenBox

The current 10x upper guard doesn't catch these because the inflation is 5-7x.

## Goals

1. Per-token circulating supply methods — each token gets the correct on-chain formula
2. Tightened override guards — prevent inflated values from overriding correct DefiLlama data
3. On-chain decimals verification — catch configuration mistakes before they corrupt data

## Non-Goals

- Replacing DefiLlama entirely (it remains the primary source)
- Historical on-chain supply tracking
- Solana, Cosmos, or other non-EVM/non-Tron chains

## Pillar 1: Per-Token Supply Methods

### Supply Method Types

```typescript
interface SupplyMethodConfig {
  type: "totalSupply"                  // Default: raw totalSupply() is circulating
       | "totalSupply-minus-addresses" // totalSupply() - sum(balanceOf(addr)) per chain
       | "custom-contract"            // Call a dedicated circulating supply contract
       | "exclude";                   // Skip on-chain supply for this token

  // For totalSupply-minus-addresses: addresses to subtract
  subtractAddresses?: { chain: string; address: string }[];

  // For custom-contract: the contract to call
  customContract?: {
    chain: string;
    address: string;
    selector: string;   // Function selector (e.g., "0x9e2bf22c" for circulating_supply())
    decimals: number;
  };
}
```

### Token Configurations (Updated After Verification)

| Token | Method | Details |
|-------|--------|---------|
| crvUSD | `exclude` | StablecoinLens is outdated (only tracks legacy factory ~25M of ~276M). DefiLlama aggregates debt across all factories. |
| MIM | `exclude` | DegenBox holds only ~4M of ~142M non-circulating MIM. Remaining spread across 45+ Cauldrons. DefiLlama tracks actual debt. |
| USDT | `totalSupply-minus-addresses` | Subtract `balanceOf(Treasury: 0x5754284f345afc66a98fbB0a0Afe71e0f007b949)` on Ethereum (~$2.3B) |
| USDC | `totalSupply-minus-addresses` | Subtract `balanceOf(Reserve: 0x55FE002aEFF02F77364de339a1292923A15844B8)` on Ethereum (~$107M) |
| All CDP stables | `totalSupply` (default) | LUSD, BOLD, GHO, FRAX, cUSD, etc. — minted = circulating |

Tokens without a `supplyMethod` field default to `totalSupply`.

### Implementation in sync-onchain-supply.ts

For EVM chains, the batch RPC call expands from just `totalSupply()` to include:
1. `totalSupply()` (selector `0x18160ddd`) for every contract
2. `balanceOf(address)` (selector `0x70a08231` + padded address) for each subtract address
3. `decimals()` (selector `0x313ce567`) for verification (Pillar 3)

All three call types can be batched into a single JSON-RPC POST per chain.

After receiving results, compute:
- `totalSupply-minus-addresses`: `supply = totalSupply - sum(balanceOf(addr))`
- `custom-contract`: `supply = customContractResult` (replaces totalSupply entirely)

### Data Flow

```
stablecoins.ts (config) → sync-onchain-supply (fetch + compute) → onchain_supply table → sync-stablecoins (override logic)
```

The `onchain_supply` table stores the **computed circulating supply** (already adjusted), not raw totalSupply. No downstream changes needed.

## Pillar 2: Tightened Override Guards

### Current Guards (sync-stablecoins.ts lines 529-551)

- Skip if divergence ≤ 5%
- Reject if on-chain < 50% of DefiLlama (likely RPC failure)
- Reject if on-chain > 10x DefiLlama (likely max supply)

### New Guards

- Skip if divergence ≤ 5% (unchanged)
- Reject if on-chain < 50% of DefiLlama (unchanged)
- **Reject if on-chain > 3x DefiLlama** (tightened from 10x — catches crvUSD/MIM-class issues)
- **Log critical warning if override changes mcap by > $500M absolute** (monitoring signal)

### Rationale for 3x

Legitimate divergence between on-chain and DefiLlama should be under 2x. If on-chain is >3x DefiLlama, the contract almost certainly returns non-circulating tokens. The per-token supply methods (Pillar 1) handle most of these cases explicitly, and the 3x guard is a safety net for tokens we haven't configured yet.

## Pillar 3: On-Chain Decimals Verification

### Problem

All 126 contract deployments have hardcoded decimals. If a decimal value is wrong, the supply is multiplied/divided by the wrong power of 10, producing absurdly inflated or deflated values.

### Solution

During `syncOnchainSupply`, batch a `decimals()` call (selector `0x313ce567`) for each EVM contract alongside totalSupply.

If the on-chain decimal ≠ configured decimal:
1. **Skip that contract's supply** (don't write to DB)
2. **Log critical error**: `[onchain-supply] DECIMAL MISMATCH: ${symbol} on ${chain} — configured=${configured} on-chain=${onchain}`
3. The status page's `onchainSupplyDivergences` metric will reflect the missing data

### Cost

Zero additional RPC calls — `decimals()` is batched into the same JSON-RPC POST as `totalSupply()` and `balanceOf()`.

### Tron

Tron contracts are called individually (no batching), so `decimals()` adds one extra call per Tron contract. With ~8 Tron contracts, this is negligible.

## Files Modified

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `SupplyMethodConfig` type |
| `src/lib/stablecoins.ts` | Add `supplyMethod` config for crvUSD, MIM, USDT, USDC |
| `worker/src/cron/sync-onchain-supply.ts` | Support balanceOf/custom calls, decimal verification |
| `worker/src/cron/sync-stablecoins.ts` | Tighten upper guard from 10x → 3x |

## Verification

After deployment, check:
1. crvUSD shows ~$276M (not $2B)
2. MIM shows ~$32M (not $174M)
3. USDT/USDC values unchanged (treasury amounts are small relative to supply)
4. Status page shows 0 decimal mismatches
5. No new on-chain supply divergences introduced
