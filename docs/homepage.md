# Homepage

Route contract for `/`, the main Pharos dashboard.

---

## Route Shape

- **Server shell:** `src/app/page.tsx`
- **Desktop masthead:** `src/components/site-header.tsx`
- **KPI strip:** `src/components/kpi-bar.tsx`
- **Main dashboard client:** `src/components/homepage-client.tsx`

The route does not use `FeaturePageShell`. Instead, the server page renders:

1. An `sr-only` `h1`
2. An `ItemList` JSON-LD payload for the top 20 active stablecoins
3. `SiteHeader`
4. `KpiBar`
5. `HomepageClient`

Metadata is authored directly in `src/app/page.tsx` with canonical `/` and the shared `/og-card.png` Open Graph image.

---

## Top-Fold Contract

`src/app/page.tsx` computes three server-side counts for the masthead:

- tracked stablecoins from `ACTIVE_STABLECOINS.length`
- peg count from `PEG_CURRENCY_COUNT`
- chain count from `CHAIN_META`

The visible top fold is split across three independently composed surfaces:

- `SiteHeader` on `lg+`
- `KpiBar` across breakpoints
- the optional `HomepageStartHereCallout`, rendered by `src/app/page.tsx` between `SiteHeader` and `KpiBar`

The page keeps the only semantic `h1` visually hidden. The visible masthead is intentionally a dashboard surface, not a hero-heading block.

---

## Query And State Model

The homepage is intentionally decomposed into several cache-sharing clients instead of one route-wide view model.

### `HomepageClient`

Core query inputs:

- `useStablecoins()`
- `useLogos()`
- `usePegSummary()`
- `useDexLiquidity()`
- `useReportCards()`
- `useStressSignals()`

Derived helpers:

- `buildHomepageViewModel(...)` in `src/components/homepage-client-view-model.ts` (calls `derivePegRates(...)` for non-USD peg display context)
- `useHomepageFilters()` for URL-backed table filters

Page-level shared error and freshness surfaces:

- `QueryErrorNotice`
- `StaleDataBanner`

### `SiteHeader`

Additional masthead-only reads:

- `useHealth()` for blacklist and mint/burn totals
- `useDexLiquidity()` for total processed pools
- `useStablecoins()` for live tracked-coin availability

### `KpiBar`

Snapshot-strip reads:

- `useStablecoins()`
- `usePegSummary()`
- `useStabilityIndex()`
- `useMintBurnFlows()`
- `useStressSignals()`
- `useDexLiquidity()`

Repeated hook usage is expected. These surfaces share TanStack Query cache state rather than passing one large route payload through props.

---

## URL Filter Contract

The homepage table uses browser URL search params as its public state contract.

Managed by `src/hooks/use-homepage-filters.ts` and `src/hooks/use-url-filters.ts`:

- `q` -> text search
- `peg` -> one active peg cohort filter (`usd-peg`, `fiat-non-usd-peg`, `commodity-peg`)
- `type` -> one active governance filter
- `backing` -> one active backing filter
- `grade` -> one active score-tier filter
- `infrastructure` -> one active infrastructure filter (`infrastructure-liquity-v1`, `infrastructure-liquity-v2`, `infrastructure-m0`)

Rules:

- only one value per filter group is active at a time
- legacy homepage peg params for specific non-USD buckets (for example `eur-peg`, `gold-peg`, `silver-peg`, `other-peg`) normalize into the current aggregate peg cohorts
- the homepage peg browse strip groups landing pages into `Fiat`, `Commodity`, and `Other` categories, displaying all active pegs through `PEG_LABELS_SHORT`
- `"all"` and empty-string values clear the param instead of persisting it
- updates use `window.history.replaceState(...)`, so filter changes do not create extra history entries or scroll jumps

---

## Start Here Callout Contract

The homepage owns the first-session Start Here CTA and the shared onboarding-retirement state consumed by the shell navigation.

Files:

- `src/hooks/use-start-here-callout.ts`
- `src/lib/start-here-callout.ts`

Storage contract:

- localStorage key: `pharos-start-here-callout`
- sessionStorage key: `pharos-start-here-callout-session`

Behavior:

- the callout appears only on the first homepage session
- once `/start/` is opened, `hasOpenedStartHere` is persisted and the callout stays retired on later homepage visits
- the same persisted state now also retires the shell-level `Start Here` nav shortcut for repeat users, so desktop/sidebar and mobile menu chrome stop advertising onboarding after the user has either opened `/start/` or clearly returned for later sessions
- clicking the secondary CTA dispatches the `open-command-palette` window event instead of navigating

The `/start/` route is documented in [Start Page](./start-page.md).

---

## Section Order

Above the fold (`src/app/page.tsx`):

1. `SiteHeader`
2. `HomepageStartHereCallout` (first-session only)
3. `KpiBar`

The callout and KPI bar share a `flex flex-col gap-3 lg:contents` wrapper. Because the wrapper becomes `display: contents` at `lg+`, the DOM order remains the effective order at every breakpoint: first-session visitors see the callout before the KPI bar, and returning visitors see the KPI bar directly under the header.

Under the fold (`HomepageClient`):

1. `QueryErrorNotice`
2. `StaleDataBanner`
3. `MarketHighlights`
4. `Key Stablecoin Data` section
5. `DailyDigest` in `preview` mode (prefixed with a short orientation caption)
6. `UpcomingStablecoinsSection` (includes a `Launch alerts` promo link to `/telegram/#getting-started` plus `View all` to `/upcoming`)
7. `Core Monitoring` band
8. `Research Surfaces` band
9. Bottom summary / last-updated footer copy

The destination route for item 6 is documented in [Upcoming Page](./upcoming-page.md).

### Key Stablecoin Data

This section contains:

- `PegBrowseStrip`
- `StablecoinTable`
- conditional `FilterBar` mounted through the table's `filterPanel` slot only while the local Filters toggle is open

`PegBrowseStrip` uses `ACTIVE_PEGS`, `PEG_SLUGS`, and `pegCoinCount(...)` to expose peg landing pages without duplicating routing logic locally.

### Core Monitoring

This band contains:

- `DEWSSummary`
- `HomepageFlowOverview`
- `HomepageSafetyOverview`
- `PsiHistoryChart`

### Research Surfaces

This band contains:

- `CategoryStats` (full-width)
- `TotalMcapChart` (full-width)
- `PegDiversityChart` and `NonUsdShareChart` side-by-side in a 2-col grid at `lg+`; stacked below `lg`.

All four components are wrapped in individual `SectionErrorBoundary` instances.

### Market Snapshot freshness

`KpiBar` surfaces a `Last refreshed · <relative age> · <absolute time>` line below the Market Snapshot card. The timestamp is read from the shared TanStack Query `dataUpdatedAt` for the stablecoins and PSI queries (whichever is newer). The relative age updates on a 30-second interval.

---

## Loading Strategy

The heavier homepage sections are dynamically imported in `src/components/homepage-client.tsx`:

- `StablecoinTable`
- `CategoryStats`
- `TotalMcapChart`
- `PsiHistoryChart`
- `DEWSSummary`
- `HomepageFlowOverview`
- `HomepageSafetyOverview`
- `PegDiversityChart`
- `NonUsdShareChart`
- `DailyDigest`

Each dynamic module uses a shape-matched skeleton rather than blocking the full page render.

---

## Update Rules

When changing homepage behavior, update this doc if any of these contracts move:

- visible section order
- filter query-param names or clearing semantics
- Start Here retirement behavior or storage keys
- top-fold SEO structure (`h1`, JSON-LD, canonical metadata)
- major data-source composition for the homepage-wide stale/error surfaces
- homepage chart source-alignment rules for `TotalMcapChart`

`TotalMcapChart` uses `GET /api/stablecoin-charts` for the aggregate total and cached `GET /api/stablecoin/:id` history for the named USDT / USDC / USDS + DAI stacks. The named series are aligned by "latest point at or before chart date" so the breakdown stays valid against the downsampled total history.

For visual/layout-specific changes, also update [Design Language](./design-language.md). For end-to-end source-to-hook mapping, see [Data Flow Map](./data-flow-map.md).
