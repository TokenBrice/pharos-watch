# Market Structure Charts Investigation

Date: 2026-04-23

## Scope

Investigate why the homepage Market Structure section shows empty states for:

- `Stablecoin Total Marketcap`
- `Fiat-pegged, other than USD`

while `Non-USD Market Share` still renders normally.

## Production Evidence

### 1. The shared upstream route is failing

`Stablecoin Total Marketcap` and `Fiat-pegged, other than USD` both read from `useStablecoinCharts()`:

- `src/components/total-mcap-chart.tsx`
- `src/components/peg-diversity-chart.tsx`
- `src/hooks/api-hooks.ts`

Live production response:

```text
GET https://pharos.watch/_site-data/stablecoin-charts
=> {"error":"Cached stablecoin-charts payload is malformed"}
```

### 2. The unaffected chart uses a different endpoint

`Non-USD Market Share` reads `useNonUsdShare()`, not `useStablecoinCharts()`, and its production payload is healthy:

```text
GET https://pharos.watch/_site-data/non-usd-share
=> 219 points, numeric dates, valid payload
```

So the outage is isolated to the `stablecoin-charts` data path.

### 3. The cached production payload currently stores `date` as a string

Remote D1 cache sample for key `stablecoin-charts`:

```json
[{"date":"1511913600","totalCirculatingUSD":{"peggedUSD":110105}}, ...]
```

The top-level shape is still an array, but `date` is quoted.

### 4. DefiLlama currently returns chart dates as strings

Live upstream check:

```text
GET https://stablecoins.llama.fi/stablecoincharts/all
=> Array length 3067
=> typeof first.date === "string"
=> typeof last.date === "string"
```

This means the worker cron is ingesting string dates from upstream right now.

## Root Cause

There are two linked issues:

### A. Latent writer-side bug

`worker/src/cron/sync-stablecoin-charts.ts` assumes `RawChartPoint.date` is numeric and writes it through unchanged.

But DefiLlama now returns `date` as a string, so the cron stores string dates in the `stablecoin-charts` cache.

This is the underlying data-shape drift.

### B. Recent reader-side regression turned the latent issue into an outage

On 2026-04-22, commit `c950b9f69` replaced the old generic cache passthrough for `stablecoin-charts` with a custom handler in `worker/src/api/cache-handlers.ts`.

That new handler added strict validation:

- payload must be an array
- every entry must have `typeof date === "number"`

Because the cache now contains string dates, the handler returns:

```text
503 Cached stablecoin-charts payload is malformed
```

Before that change, the endpoint used `createCacheHandler(...)` and would have passed the cached JSON through without rejecting string dates.

## Why the UI shows “No data” instead of surfacing the API failure

The homepage components only branch on `isLoading` and `filteredData.length`.

They do not branch on query error state:

- `src/components/total-mcap-chart.tsx`
- `src/components/peg-diversity-chart.tsx`

So when `useStablecoinCharts()` fails, `data` stays `undefined`, the derived chart data becomes `[]`, and the cards render empty-state copy rather than an explicit error.

This masks the outage, but it is not the primary root cause.

## Minimal, Elegant, Efficient Fix Path

### Primary fix: worker-only, two small hardening changes

1. Normalize `date` to a finite number when ingesting DefiLlama chart rows in `worker/src/cron/sync-stablecoin-charts.ts`.

   - Treat upstream `date` as `string | number`
   - Coerce with `Number(point.date)`
   - Skip rows whose coerced date is not finite
   - Persist only numeric `date` values into cache

2. Make `handleStablecoinCharts` backward-compatible with existing cached rows in `worker/src/api/cache-handlers.ts`.

   - Replace the strict `typeof date === "number"` guard with a small normalizer that accepts `string | number`
   - Coerce legacy cached `date` strings to numbers on read
   - Return `503` only when coercion fails or `totalCirculatingUSD` is invalid

This is the smallest fix that:

- restores the endpoint immediately after deploy, even before the cron rewrites cache
- prevents the cron from reintroducing malformed cached rows
- keeps the current reconciliation logic from `c950b9f69`

### Do not start with a frontend fix

Changing the homepage empty-state behavior alone would only make the failure more visible; it would not restore data.

### Frontend follow-up (optional, not required for recovery)

After the worker fix, consider a small UX hardening pass so these cards display a data-error state when `useStablecoinCharts()` fails instead of silently falling back to “No data”.

That is useful, but it is not necessary to resolve the current bug.

## Suggested Implementation Shape

Prefer a shared helper rather than duplicating coercion logic twice.

Example target:

- add a small normalizer near the stablecoin-charts worker surface, e.g. `worker/src/lib/stablecoin-charts-payload.ts` or alongside `stablecoin-charts-reconciliation.ts`

It should:

- accept `unknown`
- require array shape
- coerce `date`
- ensure `totalCirculatingUSD` is an object
- optionally sanitize bucket values to finite numbers
- return normalized `StablecoinChartPoint[]` or `null`

Then:

- cron uses it before writing cache
- API handler uses it before appending/replacing the current point

## Tests To Add

1. `worker/src/api/__tests__/cache-passthrough.test.ts`
   - cached `stablecoin-charts` payload with string dates should still return `200`
   - response should contain numeric dates

2. `worker/src/cron/__tests__/sync-stablecoin-charts.test.ts`
   - upstream raw chart rows with string dates should be written to cache with numeric dates

3. Optional guard test
   - truly invalid dates (non-numeric strings) should still be rejected or skipped

## Confidence

High.

The failure is directly reproducible in production and the evidence lines up cleanly:

- broken cards share `useStablecoinCharts()`
- production `stablecoin-charts` route is returning `503`
- cached payload contains string dates
- DefiLlama currently emits string dates
- the custom handler added on 2026-04-22 rejects those cached rows
