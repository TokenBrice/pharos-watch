# Yield Excess Benchmark Basis Investigation - 2026-04-21

## Question

The live UI showed USD 3M T-Bill at `3.71%`, while the `iusd-infinifi` detail page showed:

- Current APY: `6.06%`
- 30d APY: `4.45%`
- Excess Yield: `+0.74%`

At first glance, `6.06 - 3.71 = +2.35`, so the visible numbers looked inconsistent.

## Findings

- The current Pharos USD benchmark is `3.71%`, record date `2026-04-20`, source `treasury-yield-xml`.
- Live `/_site-data/yield-rankings` payload for `iusd-infinifi` has:
  - `currentApy = 6.05838418157254`
  - `apy30d = 4.448824361699882`
  - `benchmarkRate = 3.71`
  - `excessYield = 0.7388243616998817`
- The field is internally consistent: `4.448824361699882 - 3.71 = 0.7388243616998817`.
- The discrepancy is UI/contract wording, not an arithmetic error. `excessYield` is defined by code and docs as `apy30d - benchmarkRate`, while nearby UI also displays `Current APY`, making the headline easy to read as current spread.
- Scope is global. In the live payload, all 83 ranking rows matched `excessYield = apy30d - benchmarkRate`; 73 rows did not match `currentApy - benchmarkRate`.
- A second defect affected iUSD and other deterministic on-chain rows: bootstrap rows emitted with `currentApy = 0`, `apyBase = null`, and a real `exchangeRate` were counted as observed zero-yield samples in rolling APY stats. For iUSD this added 173 artificial zero rows inside the 30-day window and pulled `apy30d` down from a non-zero-sample average of about `5.76%` to `4.45%`.

## Code Paths

- Benchmark fetch: `worker/src/cron/fetch-tbill-rate.ts`
- Benchmark registry and row benchmark selection: `worker/src/cron/yield-sync/benchmarks.ts`
- Excess-yield computation: `worker/src/cron/yield-sync/evaluation.ts`
- Rankings cache publication: `worker/src/cron/yield-sync/publication.ts`
- Rankings endpoint read/hydration: `worker/src/api/cache-handlers.ts`
- Detail-page render: `src/components/yield-detail-section.tsx`
- Hero chip render: `src/components/stablecoin-detail/hero-card.tsx`

## Decision

Preserve the existing `excessYield = apy30d - benchmarkRate` contract because PYS intentionally uses the 30-day benchmark spread. Fix the ambiguity by labeling visible surfaces and docs as 30-day based.

Also exclude deterministic on-chain bootstrap seed rows from rolling APY stats once real APY samples exist. This is methodology-affecting because it changes `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS for newly bootstrapped on-chain sources, so the yield methodology version moved from `v7.4` to `v7.41`.
