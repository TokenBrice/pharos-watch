# Rate-Derived Yield for Dividend-Distributing Tokens

**Date:** 2026-03-10
**Status:** Approved
**Scope:** BUIDL, YLDS, USTB, mTBILL

## Problem

Dividend-distributing tokens (BUIDL, YLDS) maintain a $1.00 NAV and pay yield as newly minted tokens. Price-derived APY returns 0% for these because the price never changes. NAV tokens (USTB, mTBILL) can use price-derived but rate-derived is more accurate since their yield tracks T-bill rates mechanically.

## Solution

Reuse the existing cached T-bill rate (FRED DGS3MO, fetched daily by `fetch-tbill-rate` cron) to compute yield as `max(0, tbillRate - spreadBps/100)` per token.

## Config

```ts
export const RATE_DERIVED_CONFIGS: RateDerivedConfig[] = [
  { stablecoinId: "buidl-blackrock", spreadBps: 20, label: "T-bill proxy (net of 0.20% fee)" },
  { stablecoinId: "ylds-figure",     spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
  { stablecoinId: "ustb-superstate", spreadBps: 15, label: "T-bill proxy (net of 0.15% fee)" },
  { stablecoinId: "mtbill-midas",    spreadBps: 0,  label: "T-bill proxy" },
];
```

## Files Changed

| File | Change |
|------|--------|
| `worker/src/cron/yield-config.ts` | Add `RateDerivedConfig` interface + `RATE_DERIVED_CONFIGS`. Remove 4 IDs from `PRICE_DERIVED_FALLBACK_IDS`. |
| `worker/src/cron/yield-sync/resolve.ts` | Add `riskFreeRate` param, ~15 lines of rate-derived resolution after Tier 3 |
| `worker/src/cron/yield-sync/types.ts` | Add `"rate-derived"` to DataSource if typed |
| `worker/src/cron/sync-yield-data.ts` | Thread `riskFreeRate` into `resolveYieldSources` |
| `worker/src/cron/__tests__/sync-yield-data.test.ts` | Test case for rate-derived resolution |
| `docs/yield-intelligence.md` | Document rate-derived tier |

## Data Flow

```
fetch-tbill-rate (daily) → cache "risk_free_rate"
sync-yield-data (30min)  → loadRiskFreeRate() → resolveYieldSources({ riskFreeRate })
                           → RATE_DERIVED_CONFIGS lookup → APY = max(0, rate - spread)
                           → dataSource: "rate-derived", sourceKey: "rate-derived"
                           → is_best picks highest APY across all sources
```

## No New Infrastructure

- No new API calls, cron jobs, DB tables, or external dependencies.
- Piggybacks entirely on the existing `fetch-tbill-rate` → `risk_free_rate` cache pipeline.
