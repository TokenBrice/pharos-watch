# Compact Contract Addresses (Mobile)

**Date:** 2026-02-23
**Status:** Approved

## Problem

The contract addresses card renders one full row per chain (chain name + truncated address + explorer link). On mobile, stablecoins with many deployments (e.g. USDT with 7 chains) consume excessive vertical scroll space.

## Solution

Responsive dual-view in `contract-addresses.tsx`:

- **Mobile (`< md`)**: A wrapping flex row of 28px chain logo icons. Tapping any icon opens a shadcn `Popover` with the chain name, truncated address, a copy button, and an explorer link.
- **Desktop (`≥ md`)**: Current layout unchanged (text rows with chain name, truncated address, external link icon).

## Files Changed

| File | Change |
|---|---|
| `public/chains/*.svg` | 11 new SVG chain logo files |
| `src/lib/chains.ts` | Add `logoUrl: string` to `ChainMeta` interface + populate each entry |
| `src/components/contract-addresses.tsx` | Add mobile icon strip with Popover; keep desktop rows |

## Chain Logos

SVG files sourced from DefiLlama's open-source assets (MIT/permissive), saved locally under `public/chains/`:

`ethereum`, `arbitrum`, `base`, `optimism`, `polygon`, `avalanche`, `bsc`, `gnosis`, `fantom`, `celo`, `tron`

## Popover UX

```
┌─────────────────────────┐
│ Ethereum                │
│ 0xdac1...ec7       [⎘]  │
│ [View on Etherscan →]   │
└─────────────────────────┘
```

- One popover open at a time
- Closes on outside click
- Copy uses `navigator.clipboard.writeText`
- Explorer URL built with existing `CHAIN_META` logic (Tron uses `/#/contract/`, others use `/address/`)

## Constraints

- No API changes
- No new dependencies (shadcn `Popover` already available)
- Tailwind breakpoint: `md` (768px)
