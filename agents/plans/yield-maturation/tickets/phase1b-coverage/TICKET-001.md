---
title: "Fix DeFiLlama pool map mismatches"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Update `YIELD_POOL_MAP` and `YIELD_VARIANT_MAP` with correct DeFiLlama pool UUIDs for yield-bearing coins that currently miss DL pools.

## Task

1. **Read `worker/src/cron/yield-config.ts`** — Study `YIELD_POOL_MAP` (line ~173-260) and `YIELD_VARIANT_MAP` (line ~22-160).

2. **Update entries** based on the orchestrator's research output. The orchestrator will amend this ticket with exact entries to add or update before dispatching.

   **YIELD_POOL_MAP additions** (add after the last entry, before the closing `};`):
   ```typescript
   // OUSG - ondo-yield-assets native, Ethereum, $519M TVL, ~3.1% APY
   "ousg-ondo-finance": "7436db9b-2872-46c8-81a2-da6baff902b7",

   // USD.AI -> sUSDai - usd-ai native savings, Arbitrum, $217M TVL, ~7.7% APY
   "usdai-usd-ai": "712ce948-bd9e-4f4a-8916-b72c447f7578",

   // wsrUSD - reservoir-protocol native, Ethereum, $159M TVL, ~4.8% APY
   "wsrusd-reservoir": "d646f32f-d5af-4e34-a29f-8ebeea6a8520",

   // avUSD -> savUSD - merkl HOLD pool, Avalanche, $72M TVL, APY via on-chain rate
   "avusd-avant": "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",

   // Neutrl USD -> sNUSD - pendle PT-buying pool, Ethereum, $41M TVL, ~7.5% APY
   "nusd-neutrl": "0f38d9a4-8e34-4abc-b9ba-25f326ef7828",

   // Main Street USD - mainstreet native pool, Ethereum, $29M TVL, ~12.0% APY
   "msusd-main-street": "8a28570f-2316-488a-94a7-67c87e76c1f1",

   // Yuzu USD -> syzUSD - yuzu-money native savings, Plasma, $28M TVL, ~7.3% APY
   "yzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",

   // Noon USN -> sUSN - morpho-v1 collateral, Ethereum, $10M TVL, APY via on-chain rate
   "usn-noon": "a18a761b-49cd-416d-8342-839cac722094",
   ```

   **PRICE_DERIVED_FALLBACK_IDS additions** (add to the existing Set):
   ```typescript
   "ylds-figure",     // YLDS - Figure Markets (not tracked in DL Yields)
   "usdb-blast",      // USDB - Blast native yield (not tracked in DL Yields)
   "mtbill-midas",    // mTBILL - Midas (not tracked in DL Yields)
   "usd-dinari",      // USD+ - Dinari (not tracked in DL Yields; symbol collision with Overnight Finance)
   "ustb-superstate", // USTB - Superstate (only USCC tracked in DL, not USTB)
   "usda-avalon",     // USDa - Avalon (no DL protocol pool; sUSDa Pendle pool too small at $55K)
   ```

   **No YIELD_VARIANT_MAP changes needed.** All missing coins that use wrappers already have entries.

3. **Do not remove existing working entries.** Only add new entries or update stale UUIDs.

## Acceptance Criteria

- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- No existing entries were removed (verify by diffing against the original file)
