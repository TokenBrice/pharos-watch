## PSI History Noise Investigation

Date: 2026-04-08

### Context

- Older PSI history was restored after a bad prune removed rows older than two years.
- The current restored chart is still noisier than the pre-prune chart, especially across 2021-2022.

### Findings So Far

- The chart/UI itself is not the issue. The stored daily PSI rows around the noisy period are materially different.
- Production `stability_index` rows for the noisy dates show elevated `peakDeviationFallbackCount`, which means replay is still leaning on event peaks instead of day-level prices.
- The worst noisy dates include many overlapping intraday depegs plus a non-trivial number of missing historical prices.
- `worker/src/api/backfill-supply-history.ts` only persists `price` for non-USD coins during the DefiLlama backfill path.
- Historical PSI replay depends on `supply_history.price` for day-level replay realism.
- `worker/src/api/backfill-cg-prices.ts` can fill `NULL` `supply_history.price` rows, but it currently selects `ACTIVE_STABLECOINS`, so PSI-only shadow assets like `ust-terra` are excluded.
- Production data confirms some replay-critical coins still have missing prices across 2021-2022, notably:
  - `ust-terra`: all restored rows missing price
  - `lusd-liquity`: all restored rows missing price
  - partial gaps remain for `mim-abracadabra`, `alusd-alchemix`, and `dola-inverse-finance`
- After repairing the worst missing-price gaps, the noisiest 2021-2022 drawdowns still persisted.
- The remaining root cause is in `worker/src/lib/psi-recompute.ts`: when replay had a usable restored `supply_history.price`, it derived a day-level deviation but never re-applied the configured depeg threshold. That let same-day recovered wicks and later recovery days stay counted in PSI even when the restored daily price had already moved back inside threshold.

### Working Hypothesis

The restored historical supply backfill left replay-critical `supply_history.price` gaps, so the PSI replay continues to fall back to event peaks for some old rows. That exaggerates daily stress and makes the restored 2021-2022 chart noisier than the original. Separately, even with repaired price coverage, replay still over-counts recovered days because the historical-price path does not currently drop in-threshold daily closes.

### Planned Fix

1. Make the historical supply backfill persist usable price history for regular USD coins too, not only non-USD conversions.
2. Expand the CoinGecko price-fill backfill to the PSI-eligible universe so shadow assets can be repaired.
3. Re-apply the configured depeg threshold after deriving a replayed daily deviation from restored `supply_history.price`, so recovered days drop out of PSI instead of still contributing breadth.
4. Add regression tests for all three behaviors.
5. Update PSI/supply docs and methodology notes.
6. Deploy the Worker-path fix, then rerun targeted price and PSI backfills for the affected window.

### Implemented Fix

- `worker/src/api/backfill-supply-history.ts` now persists daily `supply_history.price` on restored rows whenever historical market-price series are available, including regular USD coins.
- `worker/src/api/backfill-cg-prices.ts` now targets `PSI_ELIGIBLE_STABLECOINS`, so PSI-only shadow assets such as `ust-terra` can have their historical `supply_history.price` repaired.
- `worker/src/lib/psi-recompute.ts` now drops replayed contributors whose restored daily price is already back inside the configured threshold (`DEPEG_THRESHOLD_BPS` / `DEPEG_THRESHOLD_BPS_NON_USD`) instead of still counting them as active PSI contributors.
- Regression coverage was added for:
  - restored USD price persistence
  - PSI shadow-asset price fill eligibility
  - recovered same-day wicks dropping out of replay
  - later replay days with in-threshold restored prices dropping out of replay
- Methodology and API docs were updated to describe the repaired replay behavior and the restore-path price requirements.

### Validation

- `npx vitest run worker/src/lib/__tests__/psi-recompute.test.ts worker/src/lib/__tests__/psi-replay.test.ts worker/src/api/__tests__/backfill-supply-history.test.ts worker/src/api/__tests__/backfill-cg-prices.test.ts`
- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
