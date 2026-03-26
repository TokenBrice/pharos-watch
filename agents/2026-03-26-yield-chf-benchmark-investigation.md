# CHF Yield Benchmark Investigation

Date: 2026-03-26

## Question

Why does `/yield` show `CHF SNB policy rate (proxy) = 0.00%` while Swiss bond market yields can be positive (for example 2Y or 10Y)?

## Finding

This is intentional in the current methodology and implementation.

- The CHF benchmark registry entry is explicitly labeled `CHF SNB policy rate (proxy)`.
- CHF-pegged rows select that benchmark by peg currency.
- `excessYield` is computed as `apy30d - benchmarkRate`, so CHF rows use the SNB proxy as their hurdle rate.
- The benchmark card on `/yield` renders the benchmark registry directly; it does not derive a Swiss bond curve.

## Relevant Code

- `worker/src/cron/yield-sync/benchmarks.ts`
  - CHF static label: `CHF SNB policy rate (proxy)`
  - `resolveBenchmarkForStablecoin()` selects the native CHF benchmark for CHF-pegged assets
- `worker/src/cron/fetch-tbill-rate.ts`
  - `parseSnbPolicyRateHtml()` extracts `SNB policy rate ... valid from DD.MM.YYYY`
  - `trySnbPolicyRate()` fetches the SNB current-rates page and stores the parsed result
- `worker/src/cron/yield-sync/evaluation.ts`
  - `excessYield = apy30d - benchmarkSelection.meta.rate`
- `src/app/yield/client.tsx`
  - the Benchmarks card renders `data.benchmarks`

## Methodology References

- `docs/yield-intelligence.md`
  - Tier 4 says CHF rows use an SNB policy-rate proxy from the SNB current-rates page
- `docs/yield-intelligence-timeline.md`
  - v5.4 states CHF support intentionally uses the public SNB policy-rate proxy rather than the SNB-published SARON display

## Live Verification

Observed from live `https://api.pharos.watch/api/yield-rankings` on 2026-03-26:

- `benchmarks.CHF.rate = 0`
- `benchmarks.CHF.recordDate = 2025-06-20`
- `benchmarks.CHF.source = "snb-policy-rate"`
- `benchmarks.CHF.isFallback = false`
- `zchf-frankencoin.benchmarkKey = "CHF"`

Observed from the SNB current-rates page on 2026-03-26:

- `SNB policy rate 0.00% valid from 20.06.2025`

## Conclusion

The page is not using Swiss sovereign bond yields at all. It is using the SNB policy rate as a proxy benchmark by design. If Pharos should benchmark CHF yield against Swiss government bonds or another CHF market rate instead, that is a methodology change and would require code + docs updates, not just a bug fix.
