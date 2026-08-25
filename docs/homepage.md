# Homepage

Route contract for `/`, the main Pharos dashboard.

---

## Route Shape

- **Server shell:** `src/app/page.tsx`
- **Hero masthead:** `src/components/home-alt-hero.tsx`
- **Core top rail:** `src/components/core-top-rail.tsx` + `src/components/homepage-tape.tsx`
- **Main dashboard client:** `src/components/home-alt-client.tsx`
- **Upcoming horizon module:** `src/components/home-alt-upcoming-horizon-constellation.tsx`
- **First-paint query bootstrap:** `src/components/homepage-bootstrap-script.tsx`
- **Fresh-post banner:** `src/components/home-blog-banner.tsx`, rendered only while the latest post is within its 14-day window

The route does not use `FeaturePageShell`. Instead, the server page renders:

1. `HomepageBootstrapScript` for nonvisual first-paint query seeding
2. `CollectionPage` + `ItemList` JSON-LD payloads for the top 20 core stablecoins and cash equivalents
3. conditional `HomeBlogBanner` while the latest post is fresh
4. `HomeAltHero`, which owns the visible `h1` (exactly one raw `<h1>` in built HTML)
5. `HomeAltClient`
6. `HomeMediaStrip`, the static `Seen on` media strip linking to `/about/#media`

Metadata is authored directly in `src/app/page.tsx` with canonical `/` and the shared `/og-card.png` Open Graph image.

---

## Top-Fold Contract

`src/app/page.tsx` reads the tracked and core-aggregate stablecoin counts for metadata and JSON-LD, then reads `getHomepageHeroSnapshot()` for the server-rendered hero market-summary fallback. The hero snapshot and market-cap KPI exclude tracked variants and stable-value investments.

The visible top fold is split across three independently composed surfaces:

- `CoreTopRail`, rendered directly under the global header chrome, contains the recent-events tape while the grouped top nav owns wayfinding. On desktop the tape renders on every standard page and sticks below the fixed top nav (`top: 3.5rem` on `/`, `calc(3px + 3.5rem)` elsewhere). On mobile it renders only on the homepage so interior pages keep their first viewport focused on local content.
- `HomeAltHero`, which owns the page `h1`; its text/summary shell is server-rendered from a maximum-72-hour static public dataset fallback, then reconciles from the homepage's existing live stablecoins query after hydration, while the live historical chart mounts through a viewport gate
- `HomeAltMiniCardGrid`, mounted through a viewport gate so mobile first paint does not pay for signal-card queries before the grid enters view

`HomeAltHero` owns the visible `h1` and keeps one raw heading across breakpoints because `npm run seo:check` requires exactly one `<h1>` on every indexable page.

---

## Query And State Model

The homepage is intentionally decomposed into several cache-sharing clients instead of one route-wide view model.

### `HomeAltClient`

The hero's first-paint text summary is server-rendered from `getHomepageHeroSnapshot()` in `src/lib/homepage-static-snapshot.ts`, which reads the checked-in public top-stablecoins dataset as a fallback only. After hydration, `HomeAltHero` derives the same totals and cohorts from the cache-sharing `useStablecoins()` path. A static fallback at most 72 hours old remains visible with its as-of date; an older or undated fallback becomes unavailable when no live data exists. The historical chart remains live but does not compete with LCP: `HomeAltHeroChartGate` keeps the lightweight skeleton through first paint, then mounts `HomeAltHeroLiveChart` from an idle callback after the chart surface reaches the viewport. The chart client reads the stablecoin chart and four supply-history endpoints. The mini-card clients also mount behind the shared `LazySection` boundary. The desktop Daily Digest promo inside `HomeAltMiniCardGrid` reads `useDailyDigest()` for the current issue title and short text, falling back to static non-placeholder archive copy only while live data is unavailable, and also reads `useDigestArchive()` for the two previous daily editions behind it, rendered as decorative `aria-hidden` fold previews that stay blank without that data. The full rankings table query set is intentionally isolated in `HomeAltRankingsSection`, which is dynamically imported below the fold.

`HomeAltRankingsSection` query inputs:

- `useStablecoins()`
- `useLogos()`
- `usePegSummary()`
- `usePinnedStablecoins()` for local pinned-watchlist state
- `useDexLiquidity()`
- `useReportCardsV9()`
- `useStressSignals()`

Before the client-only rankings workbench hydrates, its server-rendered fallback exposes a visible directory of the
first eight `HOMEPAGE_TOP_CORE_STABLECOINS` profiles plus the full screener. This keeps the Stablecoin Overview useful
and crawlable when JavaScript is unavailable while the live table remains the hydrated interaction surface.

Derived helpers:

- `buildHomepageCriticalViewModel(...)` and `buildHomepageOptionalViewModel(...)` in `src/components/homepage-client-view-model.ts` (the critical builder derives `pegRates`, `pegScores`, and `filteredRowCount`; the optional builder derives `reportCardMap` and `dewsRiskLevel`)
- `bucketByDeviationBps(...)` mini-card aggregate helper in `src/lib/home-alt-aggregates.ts`
- `useHomeAltFilters()` for URL-backed peg cohort filtering

Live homepage modules resolve query state through the shared `loading`, `ready`, `empty`, `unavailable`, and `stale-with-data` contract. A failed source without retained data renders an explicit unavailable state and retry action rather than a healthy or empty message. Retained data stays visible with its age and a stale notice, while a successful zero-row response can use the module's normal empty copy. The rankings workbench identifies failed source families instead of replacing them with the generic empty table.

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

`HomeAltHero` receives the server fallback from `getHomepageHeroSnapshot()` in `src/app/page.tsx`, preserves that exact selection through hydration, and then reconciles the headline and cohort rows from `useStablecoins()`. It renders the `Market Pulse` page heading, the total market-cap summary, cohort rows, and the viewport-gated live chart.

### `HomepageTape`

The live tape reads `useLatestEvents({ limit: 100, severityFloor: "notice" })`, which resolves to `GET /api/events?limit=100&severityFloor=notice` and is delivered to browsers through same-origin `/_site-data/events?...` on production Pages hosts. Before rendering, it excludes score-class events and runs `collapseForHomepageStrip(...)` so noisy repeat events collapse into one cell with a count badge. `CoreTopRail` mounts it under the global header chrome and above each page's local content. On desktop the tape renders on every standard page and is sticky below the fixed `TopNav`; on mobile it renders only on the homepage and scrolls away beneath the site header. Interior mobile routes do not mount the tape component, so its event and logo queries do not run behind CSS-hidden chrome. The server snapshot reserves the desktop rail height until the media query hydrates to avoid shifting desktop content. The tape shell uses an opaque card background: it is sticky on desktop, and a translucent fill without a backdrop blur let scrolled content ghost through the band. The tape component renders nothing on endpoint errors or a valid empty/collapsed event array, so release smoke checks the underlying site-data contract directly instead of relying on visible ticker text.

Each item carries the class styling from the homepage tape component. The marquee track terminates with a single non-duplicated `View all events →` cell that links to `/timeline/`, the longer-form route covering the same event feed.

---

## URL Filter Contract

The homepage table uses browser URL search params as its public state contract.

Managed by `src/hooks/use-home-alt-filters.ts` and `src/hooks/use-url-filters.ts`:

- `peg` -> one active peg cohort filter (`usd-peg`, `fiat-non-usd-peg`, `commodity-peg`)
- `variant` -> listing universe (`variants` or `catalog`); an absent value selects the core universe

Rules:

- only one peg cohort filter is active at a time
- the rankings table defaults to core stablecoins and cash equivalents; `variant=variants` exposes tracked variants and `variant=catalog` exposes all active listing classes
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
3. `HomeAltRankingsSection` (`StablecoinTable` + `PegBrowseStrip`)
4. `HomeAltUpcomingHorizonConstellation`
5. `HomeAltDdrOverview`
6. `HomeAltYieldOverview`
7. `HomeAltStatusTelegram`

`src/app/page.tsx` then closes the page with `HomeMediaStrip`, the static `Seen on` media credibility strip that links to `/about/#media`.

The directory table is the product's workbench, so it sits directly after shortcuts and the signal-card band; Horizon and the overview modules follow it.

`HomeAltYieldOverview` keeps the homepage yield teaser risk-adjusted-first: the headline stat is the best Pharos Yield Score row with APY and PYS, while the raw APY maximum is demoted to a muted `Highest raw APY (unadjusted)` note.

### Stablecoin Overview

This section contains:

- `StablecoinTable`
- `PegBrowseStrip`

The homepage table seeds a curated default column set (`HOME_ALT_DEFAULT_COLUMNS`, which omits Mint Authority and Flags), paginates at `OVERVIEW_PAGE_SIZE` (20) rows per page behind a prev/next footer inside its own capped vertical scroll viewport, and lets users persist column changes through Table settings.

When pinning is enabled from the homepage, each table row shows a locked star column to the left of the rank column. Starred rows are shown at the top of the table, ahead of unstarred rows; filters and search still decide which rows are eligible to appear in the table.

The `Mint Score` column reads the published Safety Score V9 mint component off the report-card payload (`cards[].breakdowns.control.components`, `kind: "mint"`) and shows its score (`0-100`, or `NR`) in its posture-band colour, with the band named in the badge title; the homepage suppresses the header methodology hint (`showHeaderMethodologyHints={false}`), which `/screener/` keeps. Sorting uses the `mintAuthority` sort key and places unrated rows after scored rows. The row title still includes the curated review bucket used by `/coverage/` and `/screener/`, spelled out (`No privileged mint`, `Governed mint`, `Multisig mint`, `Issuer or backend mint`, `Bridge mint`, `Inherited authority`, or `Unknown mint authority`), which describes the curation route rather than the score. Since safety `9.1` this is the same number the Economic Control pillar uses, so the column and the grade can no longer disagree; a publication without breakdowns renders `NR`. The same release renamed the CSV export headers to `Mint Control Score` and `Mint Control Band` (from `Mint Authority Score` / `Mint Authority Band`), which is breaking for header-keyed consumers; the curated route column stays `Mint Authority Status`, and band keys are unchanged.

`PegBrowseStrip` uses `ACTIVE_PEGS`, `PEG_SLUGS`, and `pegCoinCount(...)` to expose peg landing pages without duplicating routing logic locally. The collapsed homepage preview shows USD, EUR, GBP, and BRL first; remaining active fiat pegs sit behind the "View More" disclosure.

---

## Loading Strategy

`HomeAltHero` keeps the headline and cohort rows in the eager homepage experience. The market-cap chart uses a lightweight SVG renderer in `src/components/home-alt-hero-chart.tsx`, avoiding the shared Recharts runtime, and `HomeAltHeroChartGate` defers the live chart client until the chart surface reaches the viewport and the browser reaches an idle slice. The chart draws the gray total-market envelope and green USDT area as filled layers, then overlays USDC, USDS + DAI, Others, and Non-USD as legend-matched strokes.

The heavier homepage sections are client-only dynamic imports in `src/components/home-alt-client.tsx`:

- `HomeAltMiniCardGrid`, which owns the below-hero signal cards
- `HomeAltRankingsSection`, which owns `PegBrowseStrip`, `StablecoinTable`, pinned stablecoin state, and the table view model
- `HomeAltDdrOverview`
- `HomeAltYieldOverview`
- `HomeAltStatusTelegram`

The `HomeAltRankingsSection` fallback is progressive content rather than a skeleton-only shell: it renders the real
section heading, summary, and leading stablecoin profile links alongside the shape-matched table placeholder.

`DailyDigest` is imported statically inside the dynamically loaded `HomeAltMiniCardGrid`; it is not a separate dynamic import.

Each dynamic module uses a shape-matched skeleton rather than blocking the full page render.

---

## Update Rules

When changing homepage behavior, update this doc if any of these contracts move:

- visible section order
- filter query-param names or clearing semantics
- top-fold SEO structure (`h1`, JSON-LD, canonical metadata)
- major data-source composition for the homepage-wide signal cards or table

For visual/layout-specific changes, also update [Design Language](./design-language.md). For end-to-end source-to-hook mapping, see [Data Flow Map](./data-flow-map.md).
