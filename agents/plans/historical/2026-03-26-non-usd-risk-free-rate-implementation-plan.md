# 2026-03-26 Non-USD Risk-Free Rate Implementation Plan

> Follow-on execution plan for [2026-03-26-non-usd-yield-and-benchmark-exploration.md](../2026-03-26-non-usd-yield-and-benchmark-exploration.md).
> Assumption: the requested scope is USD default plus explicit EUR and CHF support. The user message says "EUR and USD" once, but the surrounding context consistently points to EUR and CHF while keeping USD as the default fallback.

## Goal

Add currency-aware benchmark support to Yield Intelligence so that:

1. USD remains the default benchmark for unsupported pegs
2. EUR-pegged assets use a euro benchmark when available
3. CHF-pegged assets use a CHF benchmark when available
4. row-level `excessYield` and rate-derived APY can reference the appropriate benchmark
5. public UI and docs stop implying that all yield analysis is always "vs T-Bill"

## Source Decision

### USD

- Keep the current benchmark:
  - primary: FRED `DGS3MO`
  - fallback: Treasury XML
- Label: `USD 3M T-Bill`

### EUR

- Recommended source: FRED `ECBESTRVOLWGTTRMDMNRT`
- Benchmark label: `EUR €STR`
- Why:
  - same ingestion style as the current FRED CSV path
  - daily, recent, and already compatible with the existing benchmark-fetch pattern
  - ECB also publishes the rate directly and states that it does not charge for the €STR or license its use
- Verified on 2026-03-26:
  - FRED CSV latest row fetched: `2026-03-25,1.930`
  - ECB page showed last update `25 March 2026 08:00`, reference date `24-03-2026`, rate `1.932`

### CHF

- Do not use FRED for CHF in this rollout.
- What was verified on 2026-03-26:
  - `https://fred.stlouisfed.org/series/CHFON` returns 404
  - FRED search for `saron` returns 0 series
  - the Swiss FRED alternatives currently visible are stale monthly/quarterly OECD or interbank series, not a usable current overnight benchmark
- Recommended rollout choice:
  - use the SNB public `interestRates.xlsx` workbook
  - benchmark field: `CHF SNB policy rate (proxy)`
- Why this is the pragmatic choice:
  - the workbook is current and machine-readable
  - it contains both `SNB policy rate` and `SARON fixing at the close of the trading day`
  - the same workbook embeds the SNB warning that SARON on the SNB site is for illustrative purposes only, rounded, and prohibited for commercial use
  - therefore SARON from the SNB workbook should not be used directly in Pharos
  - the SNB policy rate is the safest public CHF proxy for this product unless a licensed SIX SARON feed is added later
- Product wording implication:
  - treat the CHF benchmark as a proxy in both provenance and methodology copy
  - do not label it as SARON

## Product Semantics

### Benchmark selection rule

Recommended row-level rule:

1. Resolve the coin's peg currency
2. If that currency has a configured benchmark, use it
3. Otherwise fall back to USD
4. Mark whether the row is using:
   - `native`
   - `fallback-usd`
   - `manual-override`

Initial benchmark map:

- `USD -> USD 3M T-Bill`
- `EUR -> EUR €STR`
- `CHF -> CHF SNB policy rate (proxy)`

### Why USD should remain the default

This matches the requested operating model and avoids turning `excessYield` into `null` for currencies we do not yet cover, such as MXN.

However, the fallback must be explicit in the payload and UI. Otherwise the system will look benchmark-aware while still silently benchmarking unsupported non-USD assets against USD.

### Rate-derived APY rule

Rate-derived APY should use the resolved benchmark for that asset, not the global USD scalar.

Recommended config shape:

- keep `spreadBps`
- add optional `benchmarkCurrency`
- default resolution:
  - explicit `benchmarkCurrency` override if present
  - else stablecoin peg currency if supported
  - else USD

This preserves flexibility for future exceptions without hard-coding benchmark logic into the resolver.

## Backend Plan

## W1. Replace Singular Benchmark Infra With A Benchmark Registry

### Current limitation

The current pipeline loads one scalar `riskFreeRate`, one `YieldBenchmarkMeta`, and one cache key.

### Recommended design

Create a small benchmark registry with explicit keys:

- `USD`
- `EUR`
- `CHF`

Recommended shared types:

```ts
type RiskFreeBenchmarkKey = "USD" | "EUR" | "CHF";

interface YieldBenchmarkMeta {
  key: RiskFreeBenchmarkKey;
  label: string;
  currency: string;
  rate: number;
  recordDate: string | null;
  fetchedAt: number | null;
  ageSeconds: number | null;
  source: string;
  isFallback: boolean;
  fallbackMode: string | null;
  isProxy?: boolean;
}
```

Recommended cache shape:

- new cache key: `risk_free_rates`
- payload shape:
  - `benchmarks.USD`
  - `benchmarks.EUR`
  - `benchmarks.CHF`
  - each entry stores its own current rate plus last-market metadata

Why one map is preferred over three unrelated keys:

- one parse path and one publication contract
- partial-degradation can still be represented per benchmark
- `/api/yield-rankings` can expose all active benchmark metadata cleanly

### Worker files

- `worker/src/cron/fetch-tbill-rate.ts`
  - likely replace with `fetch-risk-free-rates.ts`
- `worker/src/cron/yield-sync/cache.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/lib/constants.ts`
- `worker/src/handlers/scheduled/daily-0800.ts`

### Recommendation

Retire the singular naming at the cron/cache layer now. Keeping `fetch-tbill-rate.ts` while it also owns EUR and CHF will create misleading terminology immediately.

## W2. Add Currency-Specific Fetchers

### USD fetcher

Keep current logic:

- FRED `DGS3MO`
- Treasury XML fallback
- retained last-known-good behavior

### EUR fetcher

Add a FRED CSV fetcher for `ECBESTRVOLWGTTRMDMNRT`.

Expected semantics:

- daily pull
- same parse-latest CSV logic as USD
- retained last-known-good fallback behavior if FRED fails

### CHF fetcher

Add an SNB workbook fetcher:

- download `https://www.snb.ch/public/rates/interestRates.xlsx`
- parse the `Interest_Rates` sheet
- extract the latest `SNB policy rate`
- do not ingest SARON from the same workbook

Operational note:

- workbook parsing is a different failure mode from CSV/XML, so unit tests should cover:
  - missing sheet
  - renamed column
  - non-numeric cell
  - stale latest row

## W3. Make Yield Resolution Benchmark-Aware

### Resolver changes

Update benchmark selection before both:

- rate-derived APY computation
- `excessYield` computation

Recommended helper:

```ts
resolveBenchmarkForStablecoin(stablecoinId, pegCurrency, registry)
```

Output should include:

- selected benchmark key
- selected benchmark meta
- selection mode: `native | fallback-usd | manual-override`

### Main files

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/cron/yield-sync/provenance.ts`
- `worker/src/cron/yield-sync/publication.ts`

### Important implementation detail

Do not keep row-level `excessYield` while only exposing one page-level benchmark. That would make the API impossible to interpret downstream.

## API Contract Plan

### Design goal

Keep the existing top-level USD default available, but make row-level benchmark attribution explicit and authoritative.

### Recommended additive contract

Keep:

- top-level `riskFreeRate`
  - redefine in docs as the default USD benchmark used for summary/reference contexts

Add at response level:

- `benchmarks: Record<RiskFreeBenchmarkKey, YieldBenchmarkMeta>`

Add on each `YieldRanking`:

- `benchmarkKey`
- `benchmarkLabel`
- `benchmarkCurrency`
- `benchmarkRate`
- `benchmarkRecordDate`
- `benchmarkIsFallback`
- `benchmarkFallbackMode`
- `benchmarkSelectionMode`
- `benchmarkIsProxy`

### Provenance shape

Current snapshot provenance has one `benchmark`.

Recommended replacement:

```ts
provenance: {
  selectionMethod: "confidence-weighted";
  benchmarks: Record<RiskFreeBenchmarkKey, YieldBenchmarkMeta>;
  dlPools: YieldSourceInputMeta;
  safetySnapshot: YieldSafetySnapshotMeta;
}
```

`YieldRanking.provenance` should also carry row-specific benchmark fields or point back to the row fields, but the benchmark used by the row must be reconstructable without consulting UI heuristics.

### Optional follow-up

`/api/yield-history` can stay unchanged for the first pass if the detail chart only needs the current row's benchmark rate as a flat reference line from `/api/yield-rankings`.

If later we want historical benchmark overlays, add a separate benchmark-history payload instead of overloading the current history rows.

## Frontend Plan

## W4. Stablecoin Detail Surfaces

These should become benchmark-aware in the first implementation pass because they render one asset at a time and do not have mixed-benchmark ambiguity.

### Files

- `src/components/yield-detail-section.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/yield-history-chart.tsx`
- `src/app/stablecoin/[id]/client.tsx`

### Changes

1. Replace `vs T-Bill` copy with row-level benchmark labels
2. Show fallback and proxy states when relevant
   - examples:
     - `vs €STR`
     - `vs SNB policy rate (proxy)`
     - `vs USD T-Bill (fallback)`
3. Change chart reference labeling from hard-coded `T-Bill` to the ranking's benchmark label

## W5. `/yield` Page

This is the main UX risk because the page currently assumes one benchmark line.

### Files

- `src/app/yield/client.tsx`
- `src/components/yield-scatter-plot.tsx`
- `src/lib/yield-scatter.ts`
- `src/components/yield-leaderboard.tsx`

### Required changes

1. Remove the implication that one benchmark applies to every row
2. Stop labeling the summary card as `Risk-Free Rate (T-Bill)` for the mixed universe
3. Add benchmark attribution to leaderboard rows or expanded row details
4. Replace the single "Benchmark Provenance" card with either:
   - `Available Benchmarks`
   - or a per-benchmark provenance display

### Scatter plot recommendation

Do not keep one universal horizontal line once mixed benchmarks are live.

Preferred rollout:

1. add a peg/benchmark filter
2. only render the reference line when the visible set shares one benchmark
3. otherwise hide the line and explain that rows are benchmarked against local references

This keeps the chart honest without blocking the backend change.

## Methodology And Docs Plan

## W6. Methodology

This change alters yield semantics and therefore requires a methodology version bump.

### Must update

- `shared/lib/yield-methodology-version.ts`
- `docs/yield-intelligence-timeline.md`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `docs/yield-intelligence.md`

### Copy changes required

1. Tier 4 wording:
   - from "cached 3-month Treasury benchmark"
   - to benchmark-family language with currency-aware selection
2. Explain benchmark selection:
   - USD default
   - EUR uses €STR
   - CHF uses SNB policy rate proxy
   - unsupported pegs fall back to USD and are marked as such
3. Explain CHF caveat:
   - public SARON from SNB is not used because of the usage restriction
   - Pharos uses SNB policy rate as a proxy until a licensed SARON feed exists

### Suggested methodology version scope

This is not a patch-level wording change. It changes benchmark inputs, public semantics, and provenance structure. Plan for a normal version increment in the next implementation PR.

## W7. Public Source Documentation

Because a new public benchmark source is being added, update:

- `src/app/about/page.tsx`
- `docs/about-page.md`
- `docs/api-reference.md`

Required source-copy changes:

- `Ratings & Reference` group should include:
  - FRED `DGS3MO`
  - FRED `ECBESTRVOLWGTTRMDMNRT`
  - SNB `interestRates.xlsx` for CHF policy-rate proxy

## Validation Plan

### Worker/unit tests

- `worker/src/cron/__tests__/fetch-tbill-rate.test.ts`
  - likely split or replace with `fetch-risk-free-rates.test.ts`
- `worker/src/cron/__tests__/yield-resolve.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/api/__tests__/yield-rankings.test.ts`

Add coverage for:

1. EUR benchmark fetch success
2. CHF policy-rate workbook parse success
3. USD fallback remains active for unsupported pegs
4. EUR and CHF rows compute `excessYield` against their own benchmark
5. rate-derived rows honor explicit benchmark selection
6. mixed benchmark provenance serializes correctly
7. degraded single-benchmark fetch does not wipe the others

### Frontend tests

- yield detail section benchmark label rendering
- hero-card benchmark subtitle rendering
- `/yield` page mixed-benchmark summary behavior
- scatter plot line hidden when visible rows have multiple benchmarks

### Full verification before push

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Rollout Order

Recommended PR sequence:

1. benchmark registry + fetchers + worker types
2. row-level benchmark selection + rankings publication
3. detail-page UI updates
4. `/yield` mixed-benchmark UX corrections
5. docs, methodology, about-page source updates, and final test expansion

This order keeps the truth model and payload stable before touching the chart behavior.

## Recommendation

Ship this as:

1. USD default benchmark retained
2. EUR benchmark added from FRED `ECBESTRVOLWGTTRMDMNRT`
3. CHF benchmark added as `SNB policy rate (proxy)` from `interestRates.xlsx`
4. explicit row-level benchmark attribution everywhere `excessYield` is shown
5. `/yield` visuals updated so the page no longer implies one global T-Bill line across all assets

Do not ship CHF labeled as SARON unless Pharos later adds a licensed SARON source.

## Source Links Used For This Plan

- FRED USD 3M Treasury: https://fred.stlouisfed.org/series/DGS3MO
- FRED EUR €STR mirror: https://fred.stlouisfed.org/series/ECBESTRVOLWGTTRMDMNRT
- ECB €STR official page: https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_short-term_rate/html/index.et.html
- FRED CHFON check: https://fred.stlouisfed.org/series/CHFON
- FRED SARON search: https://fred.stlouisfed.org/searchresults/?st=saron
- FRED Swiss overnight search: https://fred.stlouisfed.org/searchresults/?st=swiss+overnight
- SNB current rates page: https://www.snb.ch/en/the-snb/mandates-goals/statistics/statistics-pub/current_interest_exchange_rates
- SNB public workbook: https://www.snb.ch/public/rates/interestRates.xlsx
- SNB repo-market speech on SARON context: https://www.snb.ch/en/publications/communication/speeches/2024/ref_20241121_gpetmo
