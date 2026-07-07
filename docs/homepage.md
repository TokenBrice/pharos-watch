# Homepage

Route contract for `/`, the main Pharos dashboard.

---

## Route Shape

- **Server shell:** `src/app/page.tsx`
- **Hero masthead:** `src/components/home-alt-hero.tsx`
- **Core top rail:** `src/components/core-top-rail.tsx` + `src/components/homepage-tape.tsx`
- **Main dashboard client:** `src/components/home-alt-client.tsx`
- **Upcoming horizon module:** `src/components/home-alt-upcoming-horizon-constellation.tsx`

The route does not use `FeaturePageShell`. Instead, the server page renders:

1. `CollectionPage` + `ItemList` JSON-LD payloads for the top 20 active stablecoins
2. `HomeAltHero`, which owns the visible `h1` (exactly one raw `<h1>` in built HTML)
3. `HomeAltClient`

Metadata is authored directly in `src/app/page.tsx` with canonical `/` and the shared `/og-card.png` Open Graph image.

---

## Top-Fold Contract

`src/app/page.tsx` reads the active/tracked stablecoin counts for metadata and JSON-LD, then reads `getHomepageHeroSnapshot()` for the server-rendered hero market summary.

The visible top fold is split across three independently composed surfaces:

- `CoreTopRail`, rendered directly under the global header chrome. It now contains only the recent-events tape: the former centered core submenu was retired and wayfinding is owned by the grouped top nav. On desktop the tape renders on every standard page and sticks below the fixed top nav (`top: 3.5rem` on `/`, `calc(3px + 3.5rem)` elsewhere). On mobile it renders only on the homepage so interior pages keep their first viewport focused on local content.
- `HomeAltHero`, which owns the page `h1`; its text/summary shell is server-rendered from the static public dataset snapshot while the live historical chart mounts through a viewport gate
- `HomeAltMiniCardGrid`, mounted through a viewport gate so mobile first paint does not pay for signal-card queries before the grid enters view

`HomeAltHero` owns the visible `h1` and keeps one raw heading across breakpoints because `npm run seo:check` requires exactly one `<h1>` on every indexable page.

---

## Query And State Model

The homepage is intentionally decomposed into several cache-sharing clients instead of one route-wide view model.

### `HomeAltClient`

The hero's first-paint text summary is server-rendered from `getHomepageHeroSnapshot()` in `src/lib/homepage-static-snapshot.ts`, which reads the checked-in public top-stablecoins dataset. The historical chart remains live but does not compete with LCP: `HomeAltHeroChartGate` keeps the lightweight skeleton through first paint, then mounts `HomeAltHeroLiveChart` from an idle callback after the chart surface reaches the viewport. The chart client reads the stablecoin chart and four supply-history endpoints. The mini-card clients also mount behind the shared `LazySection` boundary. The desktop Daily Digest promo inside `HomeAltMiniCardGrid` reads `useDailyDigest()` for the current issue title and short text, falling back to static non-placeholder archive copy only while live data is unavailable. The full rankings table query set is intentionally isolated in `HomeAltRankingsSection`, which is dynamically imported below the fold.

`HomeAltRankingsSection` query inputs:

- `useStablecoins()`
- `useLogos()`
- `usePegSummary()`
- `usePinnedStablecoins()` for local pinned-watchlist state
- `useDexLiquidity()`
- `useReportCards()`
- `useStressSignals()`

Derived helpers:

- `buildHomepageCriticalViewModel(...)` and `buildHomepageOptionalViewModel(...)` in `src/components/homepage-client-view-model.ts` (the critical builder derives `pegRates`, `pegScores`, and `filteredRowCount`; the optional builder derives `reportCardMap` and `dewsRiskLevel`)
- `bucketByDeviationBps(...)` mini-card aggregate helper in `src/lib/home-alt-aggregates.ts`
- `useHomeAltFilters()` for URL-backed peg cohort filtering

Starred stablecoin state is local to the browser:

- localStorage key: `pharos-watchlist-v1` (the shared watchlist store; the legacy `pharos-pinned-stablecoins` and `pharos:yield-watchlist:v1` keys are read once, merged into the canonical key, then deleted)
- value: normalized stablecoin ID array
- invalid, inactive, duplicate, or over-limit IDs are ignored on read

Saved shortcuts are also browser-local:

- localStorage key: `pharos-shortcuts`
- value: ordered nav href array
- legacy six-item default sets hydrate to the expanded twelve-item default
- the non-editing desktop panel backfills from the default set to keep twelve visible route shortcuts; edit mode still shows only the user's saved hrefs

### `HomeAltHero`

`HomeAltHero` is a server component fed by `getHomepageHeroSnapshot()` in `src/app/page.tsx`. It renders the `Market Pulse` page heading, the total market-cap snapshot, cohort rows, and the viewport-gated live chart.

### `HomepageTape`

The live tape reads `useLatestEvents({ limit: 100, severityFloor: "notice" })`, which resolves to `GET /api/events?limit=100&severityFloor=notice` and is delivered to browsers through same-origin `/_site-data/events?...` on production Pages hosts. Before rendering, it excludes score-class events and runs `collapseForHomepageStrip(...)` so noisy repeat events collapse into one cell with a count badge. `CoreTopRail` mounts it under the global header chrome and above each page's local content. On desktop the tape renders on every standard page and is sticky below the fixed `TopNav`; on mobile it renders only on the homepage and scrolls away beneath the site header. The tape shell uses an opaque card background: it is sticky on desktop, and a translucent fill without a backdrop blur let scrolled content ghost through the band. The tape component renders nothing on endpoint errors or a valid empty/collapsed event array, so release smoke checks the underlying site-data contract directly instead of relying on visible ticker text.

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

1. `TopNav`
2. `CoreTopRail` directly below the global header chrome
3. `HomeAltHero`

Under the fold (`HomeAltClient`):

1. `HomeAltMiniCardGrid`
2. `ShortcutsSection`
3. `HomeAltRankingsSection` (`PegBrowseStrip` + `StablecoinTable`)
4. `HomeAltUpcomingHorizonConstellation`
5. `HomeAltDdrOverview`
6. `HomeAltYieldOverview`
7. `HomeAltStatusTelegram`

The directory table is the product's workbench, so it sits directly after shortcuts and the signal-card band; Horizon and the overview modules follow it.

### Key Stablecoin Data

This section contains:

- `PegBrowseStrip`
- `StablecoinTable`

The homepage table seeds a curated default column set (`HOME_ALT_DEFAULT_COLUMNS`, which omits Mint Authority and Flags), keeps its own capped vertical scroll viewport, and lets users persist column changes through Table settings.

When pinning is enabled from the homepage, each table row shows a locked star column to the left of the rank column. Starred rows are shown at the top of the table, ahead of unstarred rows; filters and search still decide which rows are eligible to appear in the table.

The `Mint Score` column reads `coin.mintAuthoritySummary` from the slim client registry and shows the standalone Mint Authority Score (`0-100`, or `NR`) with a methodology hint. Sorting uses the `mintAuthority` sort key and places unrated rows after scored rows. The row title still includes the compact review bucket used by `/coverage/` and `/screener/` (`No priv.`, `Governed`, `Multisig`, `Issuer`, `Bridge`, `Inherited`, or `Unknown`). This score is visible and sortable but does not change the homepage default sort. Since Safety Score v8.0 it also feeds the Decentralization report-card dimension through a penalty-only blend (see report-cards.md). The slim projection carries the cap-mutability fields needed for the homepage score to match full metadata scoring.

`PegBrowseStrip` uses `ACTIVE_PEGS`, `PEG_SLUGS`, and `pegCoinCount(...)` to expose peg landing pages without duplicating routing logic locally. The collapsed homepage preview shows USD, EUR, GBP, and BRL first; remaining active fiat pegs sit behind the "more pegs" disclosure.

---

## Loading Strategy

`HomeAltHero` keeps the headline and cohort rows in the eager homepage experience. The market-cap chart uses a lightweight SVG renderer in `src/components/home-alt-hero-chart.tsx`, avoiding the shared Recharts runtime, and `HomeAltHeroChartGate` defers the live chart client until the chart surface reaches the viewport and the browser reaches an idle slice. The chart draws the gray total-market envelope and green USDT area as filled layers, then overlays USDC, USDS + DAI, Others, and Non-USD as legend-matched strokes.

The heavier homepage sections are client-only dynamic imports in `src/components/home-alt-client.tsx`:

- `HomeAltMiniCardGrid`, which owns the below-hero signal cards
- `DailyDigest`
- `HomeAltRankingsSection`, which owns `PegBrowseStrip`, `StablecoinTable`, pinned stablecoin state, and the table view model

Each dynamic module uses a shape-matched skeleton rather than blocking the full page render.

---

## Update Rules

When changing homepage behavior, update this doc if any of these contracts move:

- visible section order
- filter query-param names or clearing semantics
- top-fold SEO structure (`h1`, JSON-LD, canonical metadata)
- major data-source composition for the homepage-wide signal cards or table

For visual/layout-specific changes, also update [Design Language](./design-language.md). For end-to-end source-to-hook mapping, see [Data Flow Map](./data-flow-map.md).
