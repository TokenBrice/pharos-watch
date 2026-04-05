# Redundancy Audit

Date: 2026-04-05
Scope: repo-wide redundancy pass across `src/`, `shared/`, `worker/src/`, `functions/`, and `scripts/`

## 1. Executive Summary

Inventory snapshot:

- `src/`: 607 files, including 137 app-route modules under `src/app/`
- `shared/`: 150 files
- `worker/src/`: 686 files
- `functions/`: 13 files
- `scripts/`: 51 files
- Total runtime/source files in the audit scope: 1,507

Validation signals:

- `npm run check:unused-code` passed with no dead internal modules or unused named exports
- `npm run check:duplicate-exports` passed with no duplicate export names
- Clone scanning of the active source trees surfaced a small set of concrete, consolidatable duplication islands rather than broad repo-wide copy/paste

Finding totals:

- High priority: 0
- Medium priority: 5
- Low priority: 1
- Total verified redundancy findings: 6

Redundancy health rating: 7/10

The codebase has strong shared primitives already, especially in `shared/lib/` and the charting helpers. The remaining redundancy is concentrated in UI shell patterns, a few worker adapter reducers, and some thin local wrappers that duplicate existing shared helpers.

Top opportunities:

- Reuse the existing `MetricStatCard` primitive instead of maintaining local metric tiles in multiple status cards
- Extract a shared chart-shell wrapper for the repeated animation/export/container setup
- Centralize the commodity-supply history price/tvl merge path and the reserve-adapter bucket-to-slice assembly

Technical debt footprint:

- About 10-15 source files are directly affected by the verified redundancy findings, or roughly 1% of the runtime/source files in scope
- The impact is concentrated in user-facing chart surfaces and worker ingestion adapters, so the maintenance cost is higher than the file count suggests

## 2. Findings

### 1. Duplicate metric tile primitive in status cards
Priority: Medium

Occurrences:

- `src/components/status/d1-usage-card.tsx:23-38`
- `src/components/status/liquidity-health.tsx:11-26`
- Existing consolidation target: `src/components/metric-stat-card.tsx:5-64`

Why it matters:

Both files define the same small "label/value/subtext" card primitive locally. That duplicates layout, spacing, and typography decisions that are already centralized in `MetricStatCard`, and it creates two places to keep in sync when the status-card design changes.

Strategy:

Replace the local `Metric` components with `MetricStatCard`, or extract a thinner `StatusMetricCard` wrapper that both files consume if they need slightly different header treatment.

### 2. Repeated null-guarded `formatCurrency(value, 1)` wrappers
Priority: Low

Occurrences:

- `src/components/status/discovery-candidates.tsx:12-15`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:19-22`

Why it matters:

These helpers are the same pattern: return an em dash for null and otherwise call `formatCurrency(value, 1)`. The wrapper adds no behavior beyond the null check, so the logic is duplicated in two presentation layers for no real gain.

Strategy:

Inline `formatCurrency(value, 1)` at the call sites or add one shared helper if the null-guarded 1-decimal format is meant to be a reusable semantic primitive.

### 3. Repeated chart-shell scaffolding across the major chart components
Priority: Medium

Occurrences:

- `src/components/psi-history-chart.tsx:149-161`
- `src/components/total-mcap-chart.tsx:22-37`
- `src/components/non-usd-share-chart.tsx:55-60`
- `src/components/peg-diversity-chart.tsx:75-80`

Why it matters:

These components all recreate the same shell: `useState(true)` animation gating, `CHART_DRAW_IN`/`CHART_NO_ANIM`, `useChartContainerReady`, and the same chart-card loading pattern. The business data differs, but the shell behavior does not.

Strategy:

Extract a reusable chart shell hook or wrapper component that owns animation toggling, container sizing, and loading-state wiring. Keep the chart-specific series and tooltip rendering in the leaf components.

### 4. Commodity supply-history price parsing duplicated in two API paths
Priority: Medium

Occurrences:

- `worker/src/api/backfill-supply-history.ts:109-115`
- `worker/src/api/stablecoin-detail/commodity.ts:50-60`

Why it matters:

Both files independently parse the same CoinGecko price payload shape, pull the same `coingecko:${geckoId}` series, and normalize it into the same time-ordered array. That is copy/paste debt in a code path that already handles external-data fallback complexity.

Strategy:

Extract a shared `loadCoinGeckoPriceSeries()` or `readCoinGeckoPriceHistory()` helper in the stablecoin-detail API layer or a small worker lib module, then reuse it in both routes.

### 5. Reserve-adapter bucket-to-slice assembly is duplicated
Priority: Medium

Occurrences:

- `worker/src/cron/reserve-adapters/ethena.ts:81-123`
- `worker/src/cron/reserve-adapters/falcon.ts:137-180`
- Shared slice normalizer already exists at `worker/src/cron/reserve-adapters/slice-math.ts:136-158`

Why it matters:

The two adapters perform the same shape of work: accumulate bucket totals, map them into `slicesFromValues(...)`, compute a stable bucket total, and emit the same style of metadata. The only real differences are bucket names and labels.

Strategy:

Add a tiny adapter helper that takes bucket keys plus display labels and returns the shared slice/metadata structure. Leave the per-protocol labels and bucket definitions in the adapter files.

### 6. CEX ticker fetchers duplicate the same midpoint/last-trade reduction loop
Priority: Medium

Occurrences:

- `worker/src/lib/cex-tickers.ts:100-135`
- `worker/src/lib/cex-tickers.ts:138-172`

Why it matters:

The Kraken and Bitstamp fetchers both build a results map, iterate a payload of ticker rows, resolve a symbol, derive a midpoint or last trade price, and store it if present. The transport shape differs, but the reduction logic is the same.

Strategy:

Extract a shared helper that accepts an iterable of normalized ticker rows plus symbol lookup and price-extraction callbacks, then reuse it in the exchange-specific fetchers.

## 3. Cross-Cutting Notes

- No separate cross-pillar issues are included in this pass; this audit is redundancy-only
- The strongest consolidation candidates are the chart shell, the status metric tile primitive, and the reserve-adapter bucket-to-slice mapping because they reduce both copy/paste and future drift

## 4. Prioritized Remediation Roadmap

| Phase | Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- | --- |
| Phase 1 - Quick Wins | 2 | Inline the null-guarded `formatCurrency(value, 1)` wrappers or replace them with one shared helper | `src/components/status/discovery-candidates.tsx`, `src/components/stablecoin-detail/redemption-backstop-card.tsx` | Small | None |
| Phase 1 - Quick Wins | 1 | Replace local `Metric` tiles with `MetricStatCard` | `src/components/status/d1-usage-card.tsx`, `src/components/status/liquidity-health.tsx`, `src/components/metric-stat-card.tsx` | Small | None |
| Phase 2 - Targeted Refactoring | 6 | Extract shared ticker-reduction logic for Kraken/Bitstamp style fetchers | `worker/src/lib/cex-tickers.ts` | Medium | None |
| Phase 2 - Targeted Refactoring | 4 | Extract shared CoinGecko price-history loader | `worker/src/api/backfill-supply-history.ts`, `worker/src/api/stablecoin-detail/commodity.ts` | Medium | None |
| Phase 2 - Targeted Refactoring | 5 | Add a tiny reserve-adapter helper for bucket-to-slice assembly | `worker/src/cron/reserve-adapters/ethena.ts`, `worker/src/cron/reserve-adapters/falcon.ts`, `worker/src/cron/reserve-adapters/slice-math.ts` | Medium | None |
| Phase 3 - Structural Improvements | 3 | Introduce a shared chart shell/wrapper for the repeated animation/export/container setup | `src/components/psi-history-chart.tsx`, `src/components/total-mcap-chart.tsx`, `src/components/non-usd-share-chart.tsx`, `src/components/peg-diversity-chart.tsx` | Medium | Depends on the chart primitive surface staying stable |

## 5. Appendices

### File-by-File Finding Index

| Finding | Files |
| --- | --- |
| 1 | `src/components/status/d1-usage-card.tsx`, `src/components/status/liquidity-health.tsx`, `src/components/metric-stat-card.tsx` |
| 2 | `src/components/status/discovery-candidates.tsx`, `src/components/stablecoin-detail/redemption-backstop-card.tsx` |
| 3 | `src/components/psi-history-chart.tsx`, `src/components/total-mcap-chart.tsx`, `src/components/non-usd-share-chart.tsx`, `src/components/peg-diversity-chart.tsx` |
| 4 | `worker/src/api/backfill-supply-history.ts`, `worker/src/api/stablecoin-detail/commodity.ts` |
| 5 | `worker/src/cron/reserve-adapters/ethena.ts`, `worker/src/cron/reserve-adapters/falcon.ts`, `worker/src/cron/reserve-adapters/slice-math.ts` |
| 6 | `worker/src/lib/cex-tickers.ts` |

### Dependency Audit Summary

| Area | Result | Notes |
| --- | --- | --- |
| Root and worker manifests | No redundancy finding verified | The manifest split between the root app and the worker workspace is intentional, and no package-level duplicate functionality was confirmed in this pass |
| Redundant dependency candidates | None verified | No package was found to be a clear duplicate of functionality already present in the standard library or another repo dependency |

### Glossary

| Term | Meaning |
| --- | --- |
| Thin wrapper | A function or module that mostly forwards to another implementation without adding meaningful behavior |
| Barrel shim | A one-purpose re-export module used only to provide a shorter import path |
| Clone pair | Two code blocks that are structurally the same or nearly the same, usually with superficial differences in names or labels |
| Shared primitive | A reusable component or helper that should be the canonical place for a repeated pattern |

