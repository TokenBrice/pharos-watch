# Non-USD Yield And Benchmark Exploration

Date: 2026-03-26

## Scope

Explore three questions:

1. Should Yield Intelligence stop benchmarking non-USD stablecoins against the USD 3M Treasury rate?
2. Should Pharos surface the base reference asset's move versus USD for non-USD pegs?
3. What other non-USD handling refinements are worth doing?

## Current Reality In The Repo

### Yield benchmarking is globally USD-only today

- `worker/src/cron/fetch-tbill-rate.ts` writes a single cache key, `risk_free_rate`, sourced from FRED `DGS3MO` with Treasury XML fallback.
- `worker/src/cron/yield-sync/cache.ts` parses that cache into one `YieldBenchmarkMeta`.
- `worker/src/cron/sync-yield-data.ts` loads one scalar `riskFreeRate`.
- `worker/src/cron/yield-sync/evaluation.ts` computes `excessYield = apy30d - input.riskFreeRate` for every row.
- `worker/src/cron/yield-sync/resolve.ts` uses that same scalar for all rate-derived rows.
- `shared/types/yield.ts` exposes one top-level `riskFreeRate` plus one `benchmark` metadata object for the whole payload.
- `src/app/yield/client.tsx`, `src/components/yield-scatter-plot.tsx`, `src/components/yield-history-chart.tsx`, and `src/components/yield-detail-section.tsx` all assume one global benchmark line labeled "T-Bill".

This is not just a source swap. It is a payload-contract and UX-contract change.

### The active non-USD yield universe is very small right now

Active non-USD coins with `flags.yieldBearing: true`:

- `zchf-frankencoin` (`ZCHF`, peg `CHF`)
- `cetes-etherfuse` (`CETES`, peg `MXN`)

There are currently no active EUR yield-bearing stablecoins in the yield module.

Implication:

- A EUR benchmark helps future-proofing, but it does not change any current yield row.
- The current mis-benchmarking problem already affects `ZCHF` and `CETES`.
- A EUR+CHF-only implementation still leaves `CETES` on a USD hurdle, which is conceptually inconsistent.

## Idea 1: Currency-aware risk-free benchmarks

### External source check

#### EUR on FRED: yes

FRED has a daily euro short-term rate series:

- Series: `ECBESTRVOLWGTTRMDMNRT`
- Title: "Euro Short-Term Rate: Volume-Weighted Trimmed Mean Rate"
- Frequency: daily
- Units: percent
- Latest row fetched during this review: `2026-03-25,1.930`

Useful URLs:

- https://fred.stlouisfed.org/series/ECBESTRVOLWGTTRMDMNRT
- https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBESTRVOLWGTTRMDMNRT

This fits the current `fredgraph.csv` ingestion style well.

#### CHF on FRED: not in the form suggested

What I verified on 2026-03-26:

- `https://fred.stlouisfed.org/series/CHFON` returns 404.
- FRED search for `saron` returns 0 series.
- FRED search for `swiss overnight` returns only OECD call money / interbank series for Switzerland in monthly, quarterly, and annual formats, not a daily SARON-like series.

Useful URLs:

- https://fred.stlouisfed.org/series/CHFON
- https://fred.stlouisfed.org/searchresults/?st=saron
- https://fred.stlouisfed.org/searchresults/?st=swiss+overnight

Conclusion:

- I would not plan around a FRED `CHFON` daily series today.
- The user hypothesis is directionally useful, but the exact FRED series appears unavailable as of 2026-03-26.

#### CHF official source options exist, but need validation

Official evidence found:

- The SNB current-rates page shows SARON and explicitly says the SNB display is rounded to two decimals, that SIX is the administrator, and that the SNB-published value must not be used for commercial purposes.
- The SNB data-portal page says all portal time series can be downloaded.

Useful URLs:

- https://www.snb.ch/en/the-snb/mandates-goals/statistics/statistics-pub/current_interest_exchange_rates
- https://www.snb.ch/en/services-events/digital-services/datenportal

Practical read:

- Do not scrape the rounded SNB current-rates page for production benchmarking.
- A CHF rollout should use a validated downloadable SNB/SIX series with acceptable usage terms.
- This needs one extra source-validation pass before implementation.

### Product assessment

#### Should we do currency-aware benchmarks?

Yes, but not as "replace one FRED series with three hard-coded if statements."

The right model is:

- benchmark selection by `pegCurrency`
- source metadata stored per benchmark currency
- row-level benchmark attribution
- nullable benchmark for unsupported currencies

Why:

- only `excessYield` and rate-derived yield really need the benchmark today
- `PYS` itself does not use `riskFreeRate`
- a partially covered benchmark map is still useful if unsupported currencies return `null` instead of silently using USD

This is especially important for `CETES`. If we only add EUR and CHF, the one active MXN yield coin remains incorrectly benchmarked against USD.

### Backend design recommendation

Minimal coherent backend shape:

- Replace singular `risk_free_rate` cache with a benchmark snapshot keyed by currency, for example `benchmark_rates`.
- Keep per-currency metadata, not one global metadata object.
- Add row-level fields such as:
  - `benchmarkCurrency`
  - `benchmarkLabel`
  - `benchmarkRate`
  - `benchmarkRecordDate`
  - `benchmarkSource`
  - `excessYield`
- For unsupported non-USD currencies, set benchmark fields to `null` and skip `excessYield`.

Implementation hotspots:

- `worker/src/cron/fetch-tbill-rate.ts`
- `worker/src/cron/yield-sync/cache.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `shared/types/yield.ts`

### Frontend implication that matters

The current `/yield` page assumes one horizontal benchmark line across the whole market.

That breaks once rows can have different benchmarks.

Specifically impacted:

- `src/app/yield/client.tsx`
- `src/components/yield-scatter-plot.tsx`
- `src/components/yield-history-chart.tsx`
- `src/components/yield-detail-section.tsx`

Recommendation:

- Stablecoin detail can become benchmark-aware first. That is easy because it renders one coin at a time.
- The global `/yield` page should either:
  - stay USD-only until filters exist, or
  - add a peg filter and render one benchmark line per filtered peg, or
  - switch the main comparison view to excess-yield-relative-to-local-benchmark.

I would not ship mixed-benchmark backend changes without at least a peg filter on `/yield`.

### Recommendation for Idea 1

Best path:

1. Generalize the data model to row-level benchmarks.
2. Ship EUR support from FRED immediately.
3. Ship CHF only after validating an official downloadable source and usage terms.
4. For unsupported currencies, use `null` benchmark fields rather than defaulting to USD.

If you want the smallest near-term change:

- benchmark-aware detail pages first
- keep `/yield` filtered to USD or add peg filtering before mixed-benchmark visuals

## Idea 2: Surface base asset performance vs USD

### Why this is valuable

For non-USD pegs, a user often wants to separate:

- stablecoin-specific peg behavior
- the base currency move itself versus USD

Example:

- a EUR stablecoin at `$1.08` can be perfectly healthy if EUR/USD is `$1.08`
- a USD-only chart or card can look like "price drift" unless the FX context is shown

This has broader user impact than EUR risk-free benchmarking because there are many active non-USD detail pages today, while the yield module currently only has two active non-USD rows.

### Existing plumbing already gets us most of the way

What already exists:

- live FX fallback references via `worker/src/cron/sync-fx-rates.ts`
- historical FX fetch helpers in `worker/src/api/backfill-fx.ts`
- historical lookup helper `buildFxLookup(...)`
- `supply_history` stores daily USD price and USD circulating values
- stablecoin detail history responses already materialize both native and USD totals inside the Worker detail path

What is missing:

- no public FX-history endpoint
- `GET /api/supply-history` only exposes `circulatingUsd` and `price`
- stablecoin detail charts are still USD-centric (`src/components/mcap-chart.tsx`)

### Recommended product surface

The highest-signal low-noise addition is:

- for non-USD pegs, add a small context card:
  - "Base FX vs USD"
  - 7d / 30d / 90d move of the peg currency versus USD
  - latest FX reference with source/date

After that, the more useful chart addition is:

- overlay peg reference USD on the detail price history
- or show a toggle:
  - `Native peg terms`
  - `USD terms`

This gives users both:

- "is the stablecoin staying at 1.00 native?"
- "what did the reference asset do versus USD?"

### API recommendation

Two clean options:

1. Add `GET /api/fx-history?peg=EUR&days=365`
2. Extend `GET /api/supply-history` for non-USD coins with:
   - `pegReferenceUsd`
   - `circulatingNative`

I prefer option 1 for separation of concerns.

Why:

- historical FX is reusable across detail pages, comparisons, and future analytics
- the repo already has most of the lookup logic in `worker/src/api/backfill-fx.ts`
- it avoids overloading supply history with reference-asset concerns

## Further refinements worth doing

### 1. Make warning heuristics peg-aware

Current warning logic uses one global `medianApy`.

That is reasonable for mostly USD datasets, but weaker for mixed-currency yield rows. Non-USD rows can look abnormally low or high relative to a USD-heavy market even when they are normal relative to local rates.

Impacted code:

- `worker/src/cron/yield-sync/rankings.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `worker/src/cron/yield-helpers.ts`

Recommendation:

- keep global median for market-wide views
- add optional same-peg median for warning heuristics when row peg is non-USD

### 2. Add a peg filter to `/yield`

Once benchmarks diverge by currency, `/yield` needs at least a peg filter.

Without it:

- the benchmark card becomes ambiguous
- the scatter line becomes misleading
- the "below T-Bill" copy is wrong for non-USD rows

### 3. Stop labeling every benchmark as "T-Bill"

Even EUR support alone requires dynamic labels.

Examples:

- USD: `3M U.S. Treasury`
- EUR: `EUR short-term rate`
- CHF: `SARON`

### 4. Expose native supply history for non-USD detail pages

Current detail charts emphasize USD market cap, which blends:

- issuance / redemption
- FX move

For non-USD coins, native supply is often the cleaner operating metric.

Recommendation:

- expose `circulatingNative` in public history for non-USD assets
- add a chart toggle between native supply and USD market cap

### 5. Treat unsupported local benchmarks as "unknown", not USD

This is the most important integrity rule.

If local benchmark coverage is partial, unsupported currencies should not inherit the USD rate silently. That creates false precision in `excessYield`.

## Suggested implementation order

### Option A: Smallest high-value slice

1. Add `fx-history` API for non-USD detail context.
2. Add "base FX vs USD" card on non-USD stablecoin detail pages.

Why:

- broad product benefit immediately
- low impact on the existing yield contract
- reuses existing historical FX helpers

### Option B: Benchmark-aware detail pages first

1. Generalize yield row payload to row-level benchmark fields.
2. Add EUR benchmark from FRED.
3. Render benchmark-aware excess-yield on detail pages only.
4. Add peg filter on `/yield`.
5. Expand `/yield` global visuals after the filter exists.

### Option C: Full mixed-currency yield refactor

1. Multi-currency benchmark cache
2. Row-level benchmark payload
3. Unsupported-currency null handling
4. `/yield` peg filter
5. Benchmark-aware scatter/history/summary copy
6. CHF source validation and onboarding

This is the cleanest long-term path, but it is not a "small tweak."

## Bottom line

- EUR benchmarking is feasible now from FRED.
- CHF is not available on FRED in the way suggested; it needs a different official source.
- The current active non-USD yield problem is actually `CHF + MXN`, not `EUR + CHF`.
- The biggest immediate user-facing win is probably not EUR benchmarking. It is showing the base asset's USD move on non-USD detail pages.
- If we do currency-aware benchmarks, the design should be generic and nullable by currency, not a USD/EUR/CHF one-off branch.
