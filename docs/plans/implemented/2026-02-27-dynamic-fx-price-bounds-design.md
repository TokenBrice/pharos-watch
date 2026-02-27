# Dynamic FX-Based Price Bounds

**Date**: 2026-02-27
**Status**: Approved

## Problem

`isReasonablePrice` in `worker/src/cron/enrich-prices.ts` uses hardcoded bounds per currency to reject corrupted prices. These go stale as currencies move (ARS hyperinflation, RUB sanctions volatility) and require manual maintenance.

## Solution

Use live FX rates (already cached in D1 every 15 min by `sync-fx-rates.ts`) to compute bounds dynamically: `[0.01 * fxRate, 2 * fxRate]`.

- Lower bound (0.01x): captures severe depegs down to near-zero
- Upper bound (2x): catches data corruption (no stablecoin legitimately trades at 2x its peg)

## Signature Change

```ts
// Before
isReasonablePrice(price: number, pegType: string | undefined): boolean

// After
isReasonablePrice(price: number, pegType: string | undefined, fxRates?: Record<string, number>): boolean
```

## Logic

1. If `fxRates` is provided and contains a rate for `pegType` → use `[0.01 * rate, 2 * rate]`
2. **Exception: `peggedUSD`** — keep tight hardcoded bounds (`$0.01 – $1.19`) since USD is the base currency with no FX rate entry
3. **Fallback** — if `fxRates` missing or doesn't have the peg type → use current hardcoded bounds

## Call Site Changes

| File | How FX rates become available |
|------|-------------------------------|
| `sync-stablecoins.ts` (calls before FX cache load) | Load FX cache early, pass to all calls |
| `sync-stablecoins.ts` (`fallbackToCgSupply`) | Already loads FX cache, pass through |
| `enrichMissingPrices()` (2 internal calls) | Load FX from `db` param at start |
| `backfill-depegs.ts` (1 call) | Load FX via `getCache`, pass through |

## What stays hardcoded

- `peggedUSD` bounds ($0.01–$1.19)
- Generic unknown-peg fallback (`0 < price < 100,000`)
- All existing hardcoded bounds as fallback when `fxRates` not provided
