# Homepage

Route contract for `/`, the main Pharos dashboard.

---

## Route Shape

- **Server shell:** `src/app/page.tsx`
- **Desktop masthead:** `src/components/site-header.tsx`
- **Homepage top tape:** `src/components/homepage-top-tape.tsx` + `src/components/homepage-tape.tsx`
- **Main dashboard client:** `src/components/home-alt-client.tsx`

The route does not use `FeaturePageShell`. Instead, the server page renders:

1. `CollectionPage` + `ItemList` JSON-LD payloads for the top 20 active stablecoins
2. `SiteHeader`, which owns the visible `h1` (exactly one raw `<h1>` in built HTML)
3. `HomeAltClient`

Metadata is authored directly in `src/app/page.tsx` with canonical `/` and the shared `/og-card.png` Open Graph image.

---

## Top-Fold Contract

`src/app/page.tsx` reads three server-side counts for the masthead:

- tracked stablecoins from `ACTIVE_STABLECOIN_COUNT`, the static projection of `ACTIVE_STABLECOINS.length`
- peg count from `ACTIVE_PEG_CURRENCY_COUNT`
- chain count from `CHAIN_META`

The visible top fold is split across four independently composed surfaces:

- `HomepageTopTape`, rendered directly under the global PSI `RegimeBar` on `/`; it uses full mobile width and the available desktop width to the right of the sidebar
- `SiteHeader` on `lg+`
- `HomeAltHero`
- `HomeAltMiniCardGrid`

`SiteHeader` owns the visible `h1` and keeps one raw heading across breakpoints. Mobile and desktop masthead layouts may duplicate metric groups, but they must not duplicate the page-level heading because `npm run seo:check` requires exactly one `<h1>` on every indexable page.

---

## Query And State Model

The homepage is intentionally decomposed into several cache-sharing clients instead of one route-wide view model.

### `HomeAltClient`

Critical query inputs:

- `useStablecoins()`
- `useLogos()`
- `usePegSummary()`
- `usePinnedStablecoins()` for local pinned-watchlist state

Additional query inputs:

- `useDexLiquidity()`
- `useReportCards()`
- `useStressSignals()`

Derived helpers:

- `buildHomepageCriticalViewModel(...)` and `buildHomepageOptionalViewModel(...)` in `src/components/homepage-client-view-model.ts` (the critical builder derives `pegRates`, `pegScores`, and `filteredRowCount`; the optional builder derives `reportCardMap` and `dewsRiskLevel`)
- `selectVisibleMcap(...)` and mini-card aggregate helpers in `src/lib/home-alt-aggregates.ts`
- `useHomeAltFilters()` for URL-backed peg cohort filtering

Starred stablecoin state is local to the browser:

- localStorage key: `pharos-pinned-stablecoins`
- value: normalized stablecoin ID array
- invalid, inactive, duplicate, or over-limit IDs are ignored on read

### `SiteHeader`

Additional masthead-only reads:

- `useHealth()` for blacklist and mint/burn totals
- `useDexLiquidity()` for total processed pools
- `useStablecoins()` for live tracked-coin availability

Repeated hook usage is expected. These surfaces share TanStack Query cache state rather than passing one large route payload through props.

### `HomepageTape`

The live tape reads `useLatestEvents({ limit: 100, severityFloor: "notice" })`, which resolves to `GET /api/events?limit=100&severityFloor=notice` and is delivered to browsers through same-origin `/_site-data/events?...` on production Pages hosts. Before rendering, it excludes score-class events and runs `collapseForHomepageStrip(...)` so noisy repeat events collapse into one cell with a count badge. `HomepageTopTape` mounts it only on `/`, directly under the global PSI regime bar. On desktop it starts at the active sidebar width so it does not cover the main navigation; on mobile it spans the full viewport. The component renders nothing on endpoint errors or a valid empty/collapsed event array, so release smoke checks the underlying site-data contract directly instead of relying on visible ticker text.

Each item carries the class styling from the homepage tape component. The marquee track terminates with a single non-duplicated `View all events →` cell that links to `/timeline/`, the longer-form route covering the same event feed.

---

## URL Filter Contract

The homepage table uses browser URL search params as its public state contract.

Managed by `src/hooks/use-home-alt-filters.ts` and `src/hooks/use-url-filters.ts`:

- `peg` -> one active peg cohort filter (`usd-peg`, `fiat-non-usd-peg`, `commodity-peg`)

Rules:

- only one peg cohort filter is active at a time
- invalid peg params normalize to the unfiltered `all` state
- the homepage peg browse strip groups landing pages into `Fiat`, `Commodity`, and `Other` categories, displaying all active pegs through `PEG_LABELS_SHORT`
- `"all"` and empty-string values clear the param instead of persisting it
- updates use `window.history.replaceState(...)`, so filter changes do not create extra history entries or scroll jumps

---

## Section Order

Above the fold (`src/app/layout.tsx` + `src/app/page.tsx`):

1. `HomepageTopTape` directly below the global PSI `RegimeBar`
2. `SiteHeader`
3. `HomeAltHero`
4. `HomeAltMiniCardGrid`

Under the fold (`HomeAltClient`):

1. `DailyDigest` in `preview` mode
2. `HomeAltCalloutStrip`
3. `PegBrowseStrip`
4. `StablecoinTable`

### Key Stablecoin Data

This section contains:

- `PegBrowseStrip`
- `StablecoinTable`

The homepage table seeds every available column as enabled by default, keeps its own capped vertical scroll viewport, and lets users persist column changes through Table settings.

When pinning is enabled from the homepage, each table row shows a locked star column to the left of the rank column. Starred rows are shown at the top of the table, ahead of unstarred rows; filters and search still decide which rows are eligible to appear in the table.

`PegBrowseStrip` uses `ACTIVE_PEGS`, `PEG_SLUGS`, and `pegCoinCount(...)` to expose peg landing pages without duplicating routing logic locally.

---

## Loading Strategy

The heavier homepage sections are dynamically imported in `src/components/home-alt-client.tsx`:

- `StablecoinTable`
- `DailyDigest`

Each dynamic module uses a shape-matched skeleton rather than blocking the full page render.

---

## Update Rules

When changing homepage behavior, update this doc if any of these contracts move:

- visible section order
- filter query-param names or clearing semantics
- top-fold SEO structure (`h1`, JSON-LD, canonical metadata)
- major data-source composition for the homepage-wide signal cards or table

For visual/layout-specific changes, also update [Design Language](./design-language.md). For end-to-end source-to-hook mapping, see [Data Flow Map](./data-flow-map.md).
