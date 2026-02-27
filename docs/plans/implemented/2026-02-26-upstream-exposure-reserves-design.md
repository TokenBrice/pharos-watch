# Upstream Exposure Reserves Breakdown — Design

**Date**: 2026-02-26
**Status**: Approved

## Goal

Replace the vague "Other (OTHER)" bucket and self-referential coin entries in the Portfolio upstream exposure panel with named collateral categories derived from each coin's `reserves` data (where available) or its `backing` type flag (as fallback).

## Problem

`computeUpstreamExposure` in `src/hooks/use-portfolio.ts` currently:
- Shows coins with no stablecoin dependencies (USDC, USDT, CeFi coins) as 100% exposure to themselves — self-referential and not informative
- Lumps all non-stablecoin collateral (ETH, BTC, T-bills, RWAs) into a single "Other (OTHER)" bucket

## Data Available

- **`StablecoinMeta.reserves?: ReserveSlice[]`** — manual curated breakdown (`name`, `pct`, `risk`)
  - Available for: USDT, USDC, USDe, USDS, DAI (the 5 biggest coins by marketcap)
- **`StablecoinMeta.flags.backing`** — always present: `"rwa-backed"` | `"crypto-backed"` | `"algorithmic"`
- **`StablecoinMeta.dependencies?: DependencyWeight[]`** — stablecoin dep weights, 0–1

## Algorithm (4 cases per holding)

| Case | Deps? | Reserves? | Behaviour |
|------|-------|-----------|-----------|
| USDT, USDC | No | Yes | Full holding distributes across all reserve slices by pct |
| Most CeFi (PYUSD, USD1…) | No | No | One collateral entry per backing type: rwa-backed → "Real-World Assets (RWA)", crypto-backed → "Crypto Collateral" |
| DAI, USDS, USDe | Yes | Yes | Stablecoin deps → stablecoin entries (unchanged). Remainder fraction → non-stablecoin reserve slices, normalized |
| Most DeFi (USDD, USDf…) | Yes | No | Stablecoin deps → unchanged. Remainder → backing type fallback entry |

**Stablecoin slice detection**: reserve slice is "stablecoin" if its name includes any of: USDC, USDT, DAI, USDS, Stablecoin, Stable (case-insensitive check).

**Aggregation**: same-name collateral slices across different coins merge into one bar ("ETH / stETH" from USDe + USDS → single entry).

## Type Change

`UpstreamExposure` gains `isCollateral: boolean`:
```ts
export interface UpstreamExposure {
  coinId: string;       // stablecoin id, or "__collateral_<slug>__" for collateral slices
  name: string;
  symbol: string;       // stablecoin symbol, or short label for collateral
  usd: number;
  pct: number;
  isCollateral: boolean;
}
```

## Display Changes

- `ExposureBar` in `client.tsx` gains `isCollateral` prop
- Collateral bars render **teal** (`bg-teal-500/50`) instead of blue
- The >80% amber warning only fires when `!isCollateral`

## Files to Modify

- `src/hooks/use-portfolio.ts` — `computeUpstreamExposure` function + `UpstreamExposure` type
- `src/app/portfolio/client.tsx` — `ExposureBar` component + call site
