# Non-USD Share Investigation

Date: 2026-04-08

## Scope

Investigate why the homepage `Non-USD Market Share` chart now shows a much longer and visually different history than a screenshot taken a few days earlier.

## Findings

- The homepage chart still reads the same worker endpoint it used at launch:
  - frontend: `src/components/non-usd-share-chart.tsx`
  - hook: `src/hooks/api-hooks.ts`
  - worker: `worker/src/api/non-usd-share.ts`
- Since launch on 2026-03-30, the chart path only changed in two minor ways:
  - `201e21d`: split total non-USD into commodity vs fiat non-USD stacks
  - `1aa02cd`: null-guard stale mixed-cache payloads
  - `587ee0c`: refactor chart animation/container helpers without changing the query or math
- The current production site-data payload is not a frontend rendering artifact. `https://pharos.watch/_site-data/non-usd-share` currently returns 219 points from `2021-04-10` through `2026-04-07`.
- The live site-data payload matches the raw D1 aggregation exactly when recomputed against `supply_history`.

## Spot Checks

### 2021-04-10

- Total stablecoin supply: `$64.79B`
- Commodity non-USD: `$1.874B` (`2.8926%`)
- Fiat non-USD: `$132.27M` (`0.2042%`)
- Total non-USD share: `3.0968%`

Largest contributors on that date:

- `xaut-tether`: `$971.86M`
- `paxg-paxos`: `$902.14M`
- `eurs-stasis`: `$49.93M`
- `xsgd-straitsx`: `$31.24M`

Conclusion: the large early-history values are mostly gold-backed supply, not a calculation bug.

### 2024-06-04

- Total stablecoin supply: `$162.26B`
- Commodity non-USD: `$2.813B` (`1.7335%`)
- Fiat non-USD: `$352.55M` (`0.2173%`)
- Total non-USD share: `1.9508%`

Largest contributors on that date:

- `xaut-tether`: `$1.316B`
- `paxg-paxos`: `$1.206B`
- `eurs-stasis`: `$41.78M`
- `eurc-circle`: `$29.38M`
- `xsgd-straitsx`: `$27.19M`

### 2026-04-07

- Total stablecoin supply: `$327.91B`
- Commodity non-USD: `$5.937B` (`1.8105%`)
- Fiat non-USD: `$1.827B` (`0.5571%`)
- Total non-USD share: `2.3676%`

Largest contributors on that date:

- `xaut-tether`: `$2.647B`
- `paxg-paxos`: `$2.438B`
- `a7a5-old-vector`: `$539.07M`
- `eurc-circle`: `$417.91M`

## Assessment

- I did not find a regression in the worker aggregation or the frontend chart code.
- The current chart is internally consistent with production `supply_history`.
- The dramatic difference versus the earlier screenshot is most likely explained by one of:
  - the earlier screenshot was taken from a stale/truncated payload that is no longer live
  - the earlier screenshot did not capture the full left side of the chart
  - a recent historical restore/backfill repopulated older `supply_history` rows before the newer screenshot

I could not reconstruct the exact old payload from repo state alone, so the last step remains an inference rather than a proven fact.

## Follow-up

- Added worker regression coverage for `/api/non-usd-share` split math and downsampling so future unexpected range/aggregation drift is caught in tests.
