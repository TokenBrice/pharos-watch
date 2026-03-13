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
2. An `ItemList` JSON-LD payload for the top 20 tracked stablecoins
3. `SiteHeader`
4. `KpiBar`
5. `HomepageClient`

Metadata is authored directly in `src/app/page.tsx` with canonical `/` and the shared `/og-card.png` Open Graph image.

---

## Top-Fold Contract

`src/app/page.tsx` computes three server-side counts for the masthead:

- tracked stablecoins from `TRACKED_STABLECOINS.length`
- peg count from `PEG_CURRENCY_COUNT`
- chain count from `CHAIN_META`

The visible top fold is split across three independently composed surfaces:

- `SiteHeader` on `lg+`
- `KpiBar` across breakpoints
- the optional campaign callout inside `HomepageClient` while the March 2026 community campaign is active on the client
- the optional Start Here callout inside `HomepageClient`

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

Derived helpers:

- `derivePegRates(...)` for non-USD peg display context
- `useHomepageFilters()` for URL-backed table filters
- `useStartHereCallout()` for first-session onboarding behavior

Time-boxed promo state:

- `CAMPAIGN_END_AT` in `src/components/homepage-client.tsx` hides the campaign strip after `2026-03-20T00:00:00Z` without waiting for a redeploy

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
- `peg` -> one active peg filter
- `type` -> one active governance filter
- `backing` -> one active backing filter

Rules:

- only one value per filter group is active at a time
- `"all"` and empty-string values clear the param instead of persisting it
- updates use `window.history.replaceState(...)`, so filter changes do not create extra history entries or scroll jumps

---

## Start Here Callout Contract

The homepage owns the first-session Start Here CTA.

Files:

- `src/hooks/use-start-here-callout.ts`
- `src/lib/start-here-callout.ts`

Storage contract:

- localStorage key: `pharos-start-here-callout`
- sessionStorage key: `pharos-start-here-callout-session`

Behavior:

- the callout appears only on the first homepage session
- once `/start/` is opened, `hasOpenedStartHere` is persisted and the callout stays retired on later homepage visits
- clicking the secondary CTA dispatches the `open-command-palette` window event instead of navigating

The `/start/` route is documented in [Start Page](./start-page.md).

---

## Section Order

`HomepageClient` renders sections in this order:

1. `QueryErrorNotice`
2. `StaleDataBanner`
3. `CampaignCallout` while `CAMPAIGN_END_AT` is still in the future on the client
4. `StartHereCallout` when `useStartHereCallout()` says it should show
5. `MarketHighlights`
6. `DailyDigest` in `preview` mode
7. `Key Stablecoin Data` section
8. `Core Monitoring` band
9. `Research Surfaces` band
10. Bottom summary / last-updated footer copy

### Key Stablecoin Data

This section contains:

- `FilterBar`
- `StablecoinTable`
- `PegBrowseSection`

`PegBrowseSection` uses `ACTIVE_PEGS`, `PEG_SLUGS`, and `pegCoinCount(...)` to expose peg landing pages without duplicating routing logic locally.

### Core Monitoring

This band contains:

- `DEWSSummary`
- `HomepageFlowOverview`
- `HomepageSafetyOverview`
- `PsiHistoryChart`

### Research Surfaces

This band contains:

- `CategoryStats`
- `TotalMcapChart`
- `PegDiversityChart`

All major subsections are wrapped in `SectionErrorBoundary` so an individual visualization failure does not blank the full route.

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

For visual/layout-specific changes, also update [Design Language](./design-language.md). For end-to-end source-to-hook mapping, see [Data Flow Map](./data-flow-map.md).
