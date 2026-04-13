# USDAI Live Reserve Fix Plan

## Problem

Base `usdai-usd-ai` and `susdai-usd-ai` are both configured against the same mixed USD.AI proof-of-reserves feed, which includes GPU-backed loan exposure. That mixed feed belongs to `sUSDai`, not base `USDai`.

## Root Cause

`shared/data/stablecoins/usd-major.json` regressed base `usdai-usd-ai` back onto the `usdai-proof-of-reserves` adapter even though the repo changelog and product split expect base `USDai` to use a curated PYUSD-only reserve baseline.

## Fix

1. Rebind base `usdai-usd-ai` to the existing `curated-validated` adapter.
2. Keep `susdai-usd-ai` on `usdai-proof-of-reserves`.
3. Point USDAI's reserve display link at the base USDai product page instead of the mixed reserve dashboard.
4. Add regression tests for the metadata split and the USDAI reserve endpoint fallback behavior.

## Validation

- `npm test -- shared/lib/__tests__/stablecoins.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts`
- `npm run lint`
- `npm run build`
- `cd worker && npx tsc --noEmit`
