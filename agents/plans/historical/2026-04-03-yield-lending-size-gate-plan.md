# Yield Lending Size Gate Plan

Date: 2026-04-03

## Goal

Prevent the yield module from recommending undersized lending-opportunity venues by requiring the recommended pool to be meaningfully large relative to the tracked stablecoin's supply.

## Planned Change

1. Load current stablecoin supply from the cached stablecoins payload during `sync-yield-data`.
2. For `lending-opportunity` rows, require observable venue TVL and enforce:
   `requiredTvlUsd = max(existing absolute floor, stablecoinSupplyUsd * 0.001)`.
3. Apply that gate before publication so undersized lending venues cannot become live recommendations.
4. Update Yield Intelligence methodology/docs and bump the methodology version.
5. Add regression tests for the new size gate.

## Validation

- Targeted yield cron tests
- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
