# Pharos.watch — Comprehensive Front-End Audit

**Audit date**: 2026-02-28
**Pages audited**: 16 (all reachable pages via navigation, footer, and in-page links)
**Tools used**: Chrome Claude Extension (console reader, network inspector, page interaction, screenshots)

## Executive Summary

Pharos.watch is in excellent overall health. Across 16 audited pages, **zero console errors** were found — no uncaught exceptions, no React errors, no failed imports. All 24+ API endpoints returned 200. The only recurring console issue is a Recharts `width(-1)/height(-1)` warning that fires on every page with charts (worst on Safety Scores at 584 instances). The sole network concern is a 503 on Cloudflare Web Analytics beacon and HEAD-method prefetch requests returning 503 from Cloudflare Pages (while GET requests succeed). Visually, the site is polished, consistent, and professional — one of the best-designed crypto analytics dashboards in the space.

## Page Inventory

| # | Page | URL | Status | Console Warnings | Network Issues | Visual Issues |
|---|------|-----|--------|------------------|----------------|---------------|
| 1 | Homepage | `/` | 200 | 18 Recharts | Beacon 503, HEAD 503s | 0 |
| 2 | Stability Index | `/stability-index/` | 200 | 17 Recharts | Beacon 503, HEAD 503s | 0 |
| 3 | Safety Scores | `/safety-scores/` | 200 | 584 Recharts | Beacon 503, HEAD 503s | 0 |
| 4 | Dependency Map | `/dependency-map/` | 200 | 0 (own) | Beacon 503, HEAD 503s | 0 |
| 5 | Portfolio | `/portfolio/` | 200 | 0 | 0 | 0 |
| 6 | DEX Liquidity | `/liquidity/` | 200 | 0 | 0 | 0 |
| 7 | Blacklist Tracker | `/blacklist/` | 200 | 0 | 0 | 0 |
| 8 | Compare | `/compare/` | 200 | 0 | 0 | 0 |
| 9 | Cemetery | `/cemetery/` | 200 | 0 | 0 | 0 |
| 10 | Digest | `/digest/` | 200 | 0 | 0 | 0 |
| 11 | Methodology | `/methodology/` | 200 | 0 | 0 | 0 |
| 12 | About | `/about/` | 200 | 0 | 0 | 0 |
| 13 | Stablecoin Detail | `/stablecoin/1/` (USDT) | 200 | 16 Recharts | 0 | 0 |
| 14 | Gold Stablecoins | `/stablecoins/gold/` | 200 | 0 | 0 | 0 |
| 15 | Privacy Policy | `/privacy/` | 200 | 0 | 0 | 0 |
| 16 | 404 Page | `/nonexistent-page/` | 200 (custom) | 0 | 0 | 0 |

**Additional discovered routes** (linked from footer/homepage, not individually audited):
- `/stablecoins/eur/` — EUR peg filter
- `/?backing=crypto-backed`, `/?backing=rwa-backed` — backing filters
- `/?type=decentralized`, `/?type=centralized`, `/?type=centralized-dependent` — governance filters
- Footer category pages: USD Stablecoins, CeFi Stablecoins, CeFi-Dependent, DeFi Stablecoins, RWA-Backed, Crypto-Backed, EUR Stablecoins, Gold-Backed

## Critical Issues

**None found.** No functionality-breaking bugs, no failed API calls, no uncaught exceptions, no broken layouts.

## Console Audit

### Errors

No console errors were found on any page across the entire site.

### Warnings

| Page(s) | Type | Message | Count | Impact | Frequency |
|---------|------|---------|-------|--------|-----------|
| All pages with Recharts charts | warning | `The width(-1) and height(-1) of chart should be greater than 0, please check the style of container...` | ~635 total | Cosmetic — charts render correctly after layout settles | On load, before ResponsiveContainer resolves dimensions |

**Detail by page:**
- Homepage: 18 warnings (2 charts: Market Cap + PSI History)
- Stability Index: 17 warnings (1 large history chart)
- Safety Scores: **584 warnings** (one per radar chart for ~145 stablecoins — worst offender)
- Stablecoin Detail (USDT): 16 warnings (multiple charts: market cap, peg, radar, liquidity)
- Portfolio, Liquidity, Blacklist, Compare, Cemetery, Digest, Methodology, About, Privacy: **0 warnings**

**Root cause**: Recharts `ResponsiveContainer` fires this warning when the parent DOM element hasn't established its dimensions yet (width/height resolve to -1 during the first render pass). The charts render correctly once layout stabilizes. This is a well-known Recharts behavior, not a bug.

**Recommendation**: Suppress by ensuring chart containers have explicit `minWidth`/`minHeight` set, or wrap in a container with defined dimensions before mounting. For Safety Scores, consider lazy-rendering radar charts (e.g., only render when scrolled into viewport via `IntersectionObserver`) to reduce the warning count from 584 to near zero.

### Noise Assessment

The console is **very clean** for a production site. No debug `console.log` statements were found. No deprecation warnings from React, Next.js, or any dependency. The only noise is the Recharts dimension warnings.

## Network Audit

### Failed Requests

| URL | Method | Status | Page(s) | Impact |
|-----|--------|--------|---------|--------|
| `static.cloudflareinsights.com/beacon.min.js` | GET | 503 | All pages | Cloudflare Web Analytics not loading — likely ad blocker or Cloudflare configuration issue. No user-facing impact. |
| `www.google-analytics.com/g/collect` | POST | 503 | All pages | GA4 event collection failing — likely ad blocker. No user-facing impact. |
| Internal pages (e.g., `/about/`, `/stability-index/`, etc.) | HEAD | 503 | All pages | Next.js prefetch HEAD requests returning 503 from Cloudflare Pages while GET requests succeed. Pages load correctly via client-side navigation. |

**Note on HEAD 503s**: Every page load triggers ~10-15 HEAD prefetch requests to sibling navigation pages. All return 503. This is a Cloudflare Pages behavior where HEAD requests to static HTML pages may not be served the same as GET requests. This does **not** affect user experience — client-side navigation works flawlessly — but it does generate unnecessary network traffic and could potentially affect SEO crawlers.

### Performance Concerns

- **Homepage loads ~263 network requests** on cold load (JS chunks, CSS, fonts, API calls, prefetches, logos). This is typical for a Next.js static site with Turbopack chunking.
- **Safety Scores loads ~345 requests** due to ~100+ stablecoin logo images loading at once. Consider lazy-loading logos below the fold.
- **All API calls return 200** with no observable slow responses. The API layer (`api.pharos.watch`) is healthy.
- **No redundant API calls** observed — TanStack Query caching appears to work correctly. Shared endpoints like `/api/stablecoins` and `/api/report-cards` are fetched once and reused.

### Missing Resources

None. All images, fonts, scripts, and stylesheets load successfully (200).

### CORS / Mixed Content

None. All resources served over HTTPS. No CORS issues detected.

## Visual & Design Findings

### Consistency Issues

**None of significance.** The site maintains exceptional visual consistency:

- **Color palette**: Consistent dark theme (`#0a0a0a` background range) with teal/green accents for positive values, red/orange for negative, amber for warnings. All sourced from the design token system.
- **Typography**: Two font families (Inter for body, JetBrains Mono for data) applied consistently. Heading hierarchy is proper (h1 for page titles, h2 for sections).
- **Component patterns**: Cards, tables, badges, and charts share consistent styling across all pages. Filter pill buttons use the same treatment everywhere (Stability Index, Blacklist, Liquidity, Safety Scores).
- **Spacing**: Consistent padding/margins within cards and between sections.

### Layout Problems

**None observed.** All pages render correctly at the tested viewport (2548x1235). No overflow, no overlapping elements, no unintended whitespace.

**Note**: Testing was conducted at a single wide-screen resolution. Responsive behavior at mobile/tablet breakpoints was not tested but should be verified separately.

### Specific Page Observations

- **Safety Scores**: The radar chart grid renders ~145 cards — all properly aligned in a responsive grid. No visual glitches despite the large number of charts.
- **Dependency Map**: D3 force graph renders cleanly with logos, legend, and interactive nodes. Edge lines visible between connected stablecoins.
- **Cemetery**: Tombstone cards with R.I.P. arches and gauge meters are a standout design element — visually memorable and thematically appropriate.
- **Stablecoin Detail (USDT)**: Tab-based layout (Overview, Safety Score, Chart, Info, Liquidity, Depeg History) is well-organized. Reserve composition treemap is clear and informative.

## UX Findings

### Navigation & Information Architecture

**Strengths:**
- **Sidebar navigation** is well-organized into logical sections (RISK LAB, DATA, INFO) with clear labels
- **Active page indicator** (left border highlight + bold text) always visible
- **Breadcrumbs** present on every subpage (e.g., "Dashboard / Stability Index")
- **Search** (Ctrl+K) provides instant fuzzy matching across stablecoins and pages with keyboard navigation hints
- **Footer** provides secondary navigation with category-based entry points (USD, CeFi, DeFi, EUR, Gold, etc.)

**Observation:**
- ~~The sidebar "Freeze Tracker" label and the URL `/blacklist/` are semantically different.~~ **Fixed**: Renamed to "Blacklist Tracker" across sidebar, footer, about page, and blacklist page to match the URL.

### Interaction & Feedback

- **Search modal**: Opens with Ctrl+K, shows results instantly, keyboard navigable with arrow keys + Enter. Excellent.
- **Chart time range buttons** (7D, 30D, 90D, 1Y, All): Clear toggle behavior with visual active state.
- **Save chart as PNG**: Present on homepage charts — nice export feature.
- **Feedback button**: Persistent in bottom-right corner on every page — accessible but unobtrusive.
- **Light mode toggle**: Available in sidebar footer.
- **Sidebar pin/unpin**: Available for compact view.
- **404 handling**: Custom branded page with lighthouse icon, "Trail gone cold." copy, and "Back to dashboard" link. Clean and helpful.
- **Export CSV**: Available on Liquidity and Blacklist pages.

### Content & Clarity

- **Homepage**: Immediately communicates purpose — shows PSI score, total market cap, DEX volume, depeg counts, and the daily digest. A first-time visitor can understand what Pharos does within seconds.
- **Methodology page**: Transparent scoring methodology with clear visual flow diagram (dimensions → weighted average → peg multiplier → no-liquidity penalty → final grade). Builds trust.
- **About page**: Concise explanation of what Pharos tracks and computes, with classification definitions.
- **Privacy page**: Minimal and clear — explains GA4 usage, no accounts, no wallet connections.
- **Data disclaimer**: "Not financial advice. Data is provided as-is for informational purposes only." in footer — appropriate for a crypto analytics site.
- **Stablecoin detail pages**: Rich data presented with clear labels. The AI-written editorial summary is a nice touch that adds context beyond raw numbers.

### Accessibility Basics

- **Focus indicators**: Not explicitly tested via keyboard-only navigation, but the search modal shows proper focus management
- **Color contrast**: Text on dark backgrounds generally appears legible. The green/red color coding for positive/negative values could be problematic for red-green colorblind users — consider supplementing with icons or shapes
- **Click targets**: Sidebar links and buttons appear adequately sized
- **Alt text**: Logo images observed to load correctly; alt text attributes not explicitly verified

## Strengths

1. **Zero console errors across the entire site** — exceptional for a production dashboard of this complexity
2. **100% API success rate** — every API call returns 200 with no timeouts or failures
3. **Exceptional visual consistency** — dark theme with design tokens applied uniformly across 16+ pages
4. **Outstanding information architecture** — sidebar sections, breadcrumbs, search, and footer provide multiple navigation paths
5. **Rich stablecoin detail pages** — tabbed layout with editorial summaries, safety scores, reserve composition, liquidity, and depeg history
6. **Memorable design touches** — Cemetery tombstones, PSI lighthouse icon, "Trail gone cold." 404 page, condition band names (Bedrock, Steady, Tremor, Fracture, Crisis, Meltdown)
7. **Clean production build** — no debug logs, no leaked environment variables, no dev-mode artifacts
8. **Thoughtful data export** — CSV export on data-heavy pages, PNG export on charts
9. **Privacy-respecting** — clear privacy policy, no accounts required, GA4 only

## Prioritized Recommendations

| Priority | Issue | Effort | Impact | Recommendation |
|----------|-------|--------|--------|----------------|
| 1 | Recharts width/height warnings (635+ total) | Medium | Low (cosmetic) | Add `minWidth={0}` and `minHeight={0}` to all `ResponsiveContainer` components, or set explicit dimensions on parent containers. For Safety Scores, lazy-render radar charts with `IntersectionObserver` to prevent 584 warnings on load. |
| 2 | HEAD 503s on Cloudflare Pages prefetch | Low | Low (no UX impact) | Investigate Cloudflare Pages configuration for HEAD method handling. If intentional (Cloudflare limitation), consider disabling Next.js prefetch for navigation links via `prefetch={false}` on `<Link>` components. |
| 3 | Cloudflare Web Analytics beacon 503 | Low | Low (analytics gap) | Verify Cloudflare Web Analytics is properly configured in the dashboard. The 503 may indicate the feature is disabled or the beacon URL has changed. If analytics aren't needed (GA4 is already present), remove the beacon script. |
| 4 | Safety Scores logo loading (100+ images at once) | Medium | Medium (performance) | Implement lazy loading for stablecoin logos in the card grid using `loading="lazy"` on `<img>` tags or an `IntersectionObserver`-based solution. This would reduce initial network requests from ~345 to ~50-60. |
| 5 | Color-blind accessibility | Medium | Medium (accessibility) | Supplement red/green color coding for positive/negative values with directional arrows (↑/↓) or other non-color indicators. This affects the homepage depeg table, fastest movers, and table columns across the site. |
| 6 | Responsive testing | Medium | Unknown | Conduct a separate audit at mobile (375px), tablet (768px), and small desktop (1024px) breakpoints. The current audit only tested at 2548x1235. |
| 7 | ~~Sidebar label vs URL mismatch~~ | Low | Low (cosmetic) | **Fixed**: Renamed "Freeze Tracker" → "Blacklist Tracker" across sidebar, footer, about page, feature highlights, and blacklist page metadata/breadcrumbs. URL stays `/blacklist/`. |
