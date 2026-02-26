# Design Overhaul — Tier 2: Structural Improvements

**Date:** 2026-02-26
**Updated:** 2026-02-26 (verified against current codebase)
**Status:** Draft
**Effort:** 1-2 weeks per item, ~4-6 weeks total
**Impact:** Transforms the application structure from "polished dashboard" to "professional analytics platform"
**Prerequisite:** Tier 1 changes should be completed first to establish the updated visual foundation

## Overview

These changes require moderate refactoring — new components, layout restructuring, or new feature additions. Each item addresses a structural gap identified in competitive benchmarking against DefiLlama, Dune, Nansen, Token Terminal, and Artemis.

---

## 2.1 Sidebar Navigation

### Problem

Pharos uses a horizontal sticky top bar (`src/components/header.tsx`) that is `h-14` (56px) tall and contains 7 navigation items with icons + labels. This has three problems:

1. **Doesn't scale.** 7 items already crowd the bar. Adding new features (Compare, Digest Archive are accessible but not in nav) will break the layout.
2. **Wastes vertical space.** 56px of vertical screen real estate is permanently consumed. On a 1080p monitor, that's 5.2% of the viewport — space that could display one more KPI row or chart.
3. **No grouping.** All 7 items sit in a flat list. Risk Lab, Stability Index, and Liquidity are conceptually related but visually equal to Cemetery and About.

**Current nav items (7):** Dashboard, Stability Index, Risk Lab, Liquidity, Freeze Tracker, Cemetery, About

**Competitor pattern:** 4 out of 5 benchmarked competitors use a left sidebar:
- DefiLlama: 228px full sidebar with categorized groups
- Artemis: 60px icon-only sidebar (hover to expand)
- Token Terminal: Two-level (top bar for major sections + left sidebar for sub-categories)
- Dune: Top nav + left sidebar in editor context

### Design

Implement a **collapsible left sidebar** (desktop only) that defaults to collapsed (icons only) and expands on hover or toggle. On mobile, keep a hamburger top bar.

#### States

| State | Width | Content | Trigger |
|-------|-------|---------|---------|
| Collapsed (default) | 56px | Icons only, tooltip on hover | Default on all viewports ≥768px |
| Expanded | 220px | Icons + labels, grouped sections | User clicks toggle button, or hovers (with 200ms delay) |
| Hidden | 0px | Off-screen | Viewports <768px (mobile uses hamburger top bar) |

#### Navigation Groups

All items link to **existing pages** only. Portfolio and Stress Test remain inside Risk Lab — they don't warrant standalone pages since they're tightly coupled with report card data.

```
Market
  ├── Dashboard          (LayoutDashboard icon)   → /
  └── Liquidity          (Droplets icon)          → /liquidity

Risk
  ├── Stability Index    (Lighthouse icon)        → /stability-index
  └── Risk Lab           (ClipboardCheck icon)    → /risk-lab

Data
  ├── Compare            (ArrowLeftRight icon)    → /compare
  ├── Freeze Tracker     (ShieldBan icon)         → /blacklist
  ├── Cemetery           (Skull icon)             → /cemetery
  └── Digest             (Newspaper icon)         → /digest

───────────────────
About                    (Info icon)              → /about
Theme Toggle             (Sun/Moon icon)
```

> **Note:** The current header defines `NAV_ITEMS` locally in `header.tsx` (line 26-34). Before building the sidebar, **extract `NAV_ITEMS` to a shared config** (e.g., `src/lib/nav-config.ts`) so both sidebar and mobile header can import it. The shared config should include a `group` field and optional `description` for command palette search.

#### Component Structure

**New file: `src/components/sidebar.tsx`**

```tsx
// Key elements:
// - <aside> with role="navigation" and aria-label="Main navigation"
// - Fixed left, full viewport height
// - CSS transition on width: 56px ↔ 220px
// - Group headers visible only when expanded
// - Active state: left border accent (3px frost-blue) instead of background fill
// - Collapsed: show tooltip (shadcn Tooltip) on icon hover with label text
// - Hidden on mobile (<md breakpoint)
```

Styling for collapsed state:
```
w-14 (56px)
py-3
flex flex-col items-center gap-1
bg-card border-r border-border
```

Styling for expanded state:
```
w-[220px]
py-3 px-3
flex flex-col gap-1
bg-card border-r border-border
```

Nav item styling (collapsed):
```
w-10 h-10 flex items-center justify-center rounded-lg
text-muted-foreground hover:bg-muted hover:text-foreground
transition-colors
```

Nav item styling (expanded):
```
h-9 flex items-center gap-3 rounded-lg px-3
text-sm text-muted-foreground hover:bg-muted hover:text-foreground
transition-colors
```

Active state (both):
```
border-l-[3px] border-l-frost-blue text-foreground bg-muted/50
```

Group header (expanded only):
```
text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60
px-3 pt-4 pb-1
```

#### Layout Changes

**File: `src/app/layout.tsx`**

Current layout:
```tsx
<body>
  <Providers>
    <Header />
    <main id="main-content" className="container mx-auto px-4 py-8">{children}</main>
    <Footer />
    <ScrollToTop />
  </Providers>
</body>
```

Proposed layout:
```tsx
<body>
  <Providers>
    {/* Mobile: hamburger top bar (visible <md) */}
    <MobileHeader />
    <div className="flex min-h-screen">
      {/* Desktop: sidebar (visible ≥md) */}
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {/* min-w-0 prevents flex child overflow */}
        <main id="main-content" className="flex-1 container mx-auto px-4 py-6 lg:px-6">
          {children}
        </main>
        <Footer />
      </div>
    </div>
    <ScrollToTop />
  </Providers>
</body>
```

#### Mobile Behavior

On viewports <768px (`md` breakpoint), the sidebar is hidden entirely. A **mobile header** replaces it:

**File: `src/components/header.tsx`** → becomes mobile-only

The existing header component already has a mobile hamburger dropdown. The change is:
1. Wrap the entire header in `md:hidden` to hide it on desktop
2. Update the mobile dropdown to use the same grouped nav structure as the sidebar
3. Add a search icon trigger for the command palette (§2.2)

```tsx
<header className="md:hidden sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
  <div className="container mx-auto flex h-14 items-center justify-between px-4">
    {/* Logo */}
    {/* Search icon (opens command palette) */}
    {/* Hamburger menu (opens grouped nav dropdown) */}
    {/* Theme toggle */}
  </div>
</header>
```

> **Breakpoint change:** The current header uses `sm:` (640px) for desktop/mobile split. Moving to `md:` (768px) gives more room for the sidebar pattern and is consistent with competitor implementations. Update all responsive nav classes from `sm:` to `md:`.

#### Sticky Table Header Adjustment

The current `.table-header-sticky` in `globals.css` uses `--table-header-top` (defaults to `0px`). With the sidebar replacing the header on desktop, sticky headers should stick to `top: 0`:

**File: `src/app/globals.css`**

The current implementation already defaults to `0px`, so **no CSS change is needed**. On mobile where the 56px header persists, set `--table-header-top: 56px` on mobile breakpoints only:

```css
@media (max-width: 767px) {
  :root {
    --table-header-top: 56px;
  }
}
```

#### Persistence

Store the user's sidebar state (collapsed/expanded) in `localStorage`:

```tsx
const [expanded, setExpanded] = useState(() => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('sidebar-expanded') === 'true';
});

useEffect(() => {
  localStorage.setItem('sidebar-expanded', String(expanded));
}, [expanded]);
```

#### Keyboard Shortcuts

- `[` or `]` toggles sidebar expanded/collapsed (when not in an input field)
- Escape closes expanded sidebar

#### Accessibility

- `aria-expanded` on the toggle button
- `aria-label="Main navigation"` on the `<aside>`
- Keyboard navigation: Tab through items, Enter to navigate
- Skip-to-content link still targets `#main-content`

### Files Affected

| File | Change |
|------|--------|
| `src/lib/nav-config.ts` | **NEW** — shared nav items with groups, icons, descriptions |
| `src/components/sidebar.tsx` | **NEW** — desktop sidebar component |
| `src/app/layout.tsx` | Layout restructure (flex row with sidebar + mobile header) |
| `src/components/header.tsx` | Restrict to mobile-only (`md:hidden`), update breakpoint from `sm:` to `md:`, import from shared nav config |
| `src/app/globals.css` | Add mobile-only `--table-header-top: 56px` media query |
| `src/components/footer.tsx` | Remove redundant navigation links (sidebar handles nav) |

### Verification

- Desktop (≥768px): sidebar visible, no top header, content fills remaining width
- Mobile (<768px): hamburger top bar visible, no sidebar, full-width content
- Sidebar collapsed: icons only, tooltips on hover, 56px wide
- Sidebar expanded: icons + labels + group headers, 220px wide
- Active page highlighted correctly for all routes including nested routes (e.g., `/stablecoin/tether` highlights Dashboard)
- `npm run build` passes (static export must not break)
- Sticky table headers still work (top: 0 on desktop, top: 56px on mobile)

---

## 2.2 Command Palette (Ctrl/Cmd+K Search)

### Problem

With 141 tracked stablecoins across 9 pages, finding a specific coin or feature requires scrolling through the table or navigating page by page. Competitors like Token Terminal and Artemis offer instant Ctrl/Cmd+K search across all entities. Dune uses it for both content and command search.

### Design

Implement a **command palette dialog** triggered by Ctrl/Cmd+K (or clicking a search icon in the sidebar/header).

#### Behavior

1. Press Ctrl+K (or Cmd+K on macOS) → palette opens as a centered modal with search input auto-focused
2. Type to search → results update in real-time (client-side filtering, no API call)
3. Results organized in sections:
   - **Stablecoins** (141 entries) — fuzzy match on name, symbol, id
   - **Pages** (9 entries) — match on page name and description
   - **Actions** (toggle theme, clear filters)
4. Arrow keys navigate results, Enter selects, Escape closes
5. Selected stablecoin → navigates to `/stablecoin/{id}`
6. Selected page → navigates to the page

#### Search Data Source

The search index is purely client-side, built from:

```tsx
// Stablecoins: from TRACKED_STABLECOINS (already loaded at build time)
const coinEntries = TRACKED_STABLECOINS.map(coin => ({
  type: 'stablecoin' as const,
  label: coin.name,
  sublabel: coin.symbol,
  href: `/stablecoin/${coin.id}`,
  icon: logos?.[coin.geckoId] || null,
  keywords: [coin.name, coin.symbol, coin.id].join(' '),
}));

// Pages: from shared nav config (extracted in §2.1)
const pageEntries = NAV_ITEMS.map(item => ({
  type: 'page' as const,
  label: item.label,
  sublabel: item.description,
  href: item.href,
  icon: item.icon,
  keywords: [item.label, item.description].filter(Boolean).join(' '),
}));
```

#### Component Structure

**New file: `src/components/command-palette.tsx`**

```
┌─────────────────────────────────────────────┐
│ 🔍 Search stablecoins, pages...     ⌘K     │
├─────────────────────────────────────────────┤
│ Stablecoins                                 │
│  [USDT logo] Tether (USDT)                  │
│  [USDC logo] USD Coin (USDC)         ←      │
│  [DAI logo]  Dai (DAI)                      │
│                                             │
│ Pages                                       │
│  [icon] Stability Index                     │
│  [icon] Risk Lab                            │
│  [icon] Liquidity                           │
│                                             │
│ Actions                                     │
│  [icon] Toggle dark/light mode              │
└─────────────────────────────────────────────┘
```

Styling:
```
Dialog overlay: bg-black/50 backdrop-blur-sm
Dialog content: w-full max-w-lg mx-auto mt-[20vh]
  bg-card border border-border rounded-xl shadow-2xl
  overflow-hidden
Search input: h-12 px-4 text-base border-b border-border
  bg-transparent focus:outline-none
  placeholder: "Search stablecoins, pages..."
Results list: max-h-[60vh] overflow-y-auto py-2
Section header: px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground
Result item: px-4 py-2.5 flex items-center gap-3 cursor-pointer
  hover:bg-muted/50 rounded-lg mx-2
  text-sm text-foreground
  Sublabel: text-muted-foreground text-xs
Selected (keyboard): bg-muted/50 (same as hover)
Coin logo: w-5 h-5 rounded-full
Footer: px-4 py-2 border-t border-border text-xs text-muted-foreground
  "↑↓ navigate  ↵ select  esc close"
```

#### Dependencies

`cmdk` is **not installed**. A lightweight implementation using shadcn's `Dialog` + custom fuzzy filter is sufficient for 141 coins + 9 pages. No need for an external library.

#### Fuzzy Search

Simple substring match is adequate for 141 entries + 9 pages. No need for Fuse.js or similar:

```tsx
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  return t.includes(q) || t.split(/\s+/).some(word => word.startsWith(q));
}
```

#### Trigger Points

1. **Keyboard shortcut:** Global `useEffect` listening for Ctrl/Cmd+K
2. **Sidebar search icon:** A search icon at the top of the sidebar (collapsed and expanded)
3. **Mobile header:** A search icon button next to the hamburger menu

**File: `src/app/layout.tsx`** or `src/components/providers.tsx`

Register the global keyboard handler:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setOpen(true);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/command-palette.tsx` | **NEW** — palette component (Dialog + input + filtered list) |
| `src/app/layout.tsx` or `src/components/providers.tsx` | Add global keyboard listener + palette rendering |
| `src/components/sidebar.tsx` | Add search trigger icon |
| `src/components/header.tsx` | Add search trigger icon (mobile) |

### Verification

- Ctrl/Cmd+K opens the palette from any page
- Typing "USDT" shows Tether as the first result
- Typing "risk" shows Risk Lab page
- Arrow keys navigate, Enter selects, Escape closes
- Clicking outside closes the palette
- Works on mobile (via search icon, not keyboard shortcut)
- No layout shift when palette opens/closes
- `npm run build` passes

---

## 2.3 Homepage Data-First Redesign

### Problem

The homepage leads with a marketing tagline ("Shining a Light on Every Peg") and a Daily Digest text block that pushes charts and data below the fold. For returning users — the primary audience of an analytics tool — this wastes the most valuable screen real estate.

**Current layout (above fold on 1080p):**
```
[Header - 56px]
[H1: "Shining a Light on Every Peg" + PSI widget]
[Daily Digest - ~120px of italic serif text]
[Two-column chart grid - partially visible]
```

**Current homepage section order** (in `page.tsx` + `homepage-client.tsx`):
1. Hero heading + StabilityIndex widget (`page.tsx`)
2. DailyDigest (`page.tsx`)
3. Two-column chart grid: TotalMcapChart + PsiHistoryChart
4. "Pharos' Unique Features" — 5 summary cards (LiquiditySummary, ReportCardsSummary, BlacklistSummary, CemeterySummary, StabilityIndexSummary)
5. "Key Stablecoin Data" — FilterBar + StablecoinTable
6. CategoryStats
7. MarketHighlights
8. PegHeatmap
9. DepegFeed
10. PegDiversityChart

**Competitor pattern:** DefiLlama, Token Terminal, and Artemis all lead immediately with data — KPI metrics, charts, and tables visible within the first viewport.

### Design

Restructure the homepage to prioritize live data while preserving the editorial personality:

```
[Sidebar (if implemented) | Content area]
  ├── KPI Bar: PSI score • Total MCAP • Active Depegs • Coins at Peg • Worst Depeg
  ├── Two-column chart grid: Total MCAP | PSI History
  ├── Market Highlights: Key Movements (depegs + biggest movers, existing component)
  ├── Live Dashboard Panels (2-col / 3-col grid):
  │     ├── LiquiditySummary
  │     ├── ReportCardsSummary
  │     ├── BlacklistSummary
  │     ├── CemeterySummary
  │     └── StabilityIndexSummary
  ├── Daily Digest (collapsible card)
  ├── Key Stablecoin Data section:
  │     ├── Filter Bar
  │     └── Stablecoin Table
  ├── PegHeatmap + DepegFeed + PegDiversityChart
  └── [Footer]
```

#### Changes by Section

##### KPI Bar (new)

Replace the hero `<h1>` + PSI widget with a dense, data-first KPI bar:

**File: `src/app/page.tsx`**

```tsx
/* Current */
<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-6">
  <div className="space-y-2">
    <h1 className="text-3xl font-bold tracking-tight">Shining a Light on Every Peg</h1>
    <p className="text-muted-foreground">
      Track {total} stablecoins, across {PEG_CURRENCY_COUNT} pegs. ...
    </p>
  </div>
  <StabilityIndex />
</div>

/* Proposed */
<div className="mb-6">
  <div className="flex items-center gap-3 mb-4">
    <h1 className="text-xl font-semibold tracking-tight text-muted-foreground">
      PHAROS <span className="text-foreground">Dashboard</span>
    </h1>
    <span className="text-xs text-muted-foreground/60">
      {total} stablecoins · {PEG_CURRENCY_COUNT} pegs
    </span>
  </div>
  <KpiBar />  {/* NEW component */}
</div>
```

**New file: `src/components/kpi-bar.tsx`**

A horizontal row of 5 key metrics with the PSI score as the anchor:

```
┌─────────┬─────────────┬──────────────┬─────────────┬────────────┐
│ PSI     │ Total MCAP  │ Active       │ Coins       │ Worst      │
│ 96.3    │ $183.66B    │ Depegs: 3    │ at Peg: 138 │ Depeg:     │
│ BEDROCK │ ▲ +0.2%     │              │ / 141       │ -1805 bps  │
└─────────┴─────────────┴──────────────┴─────────────┴────────────┘
```

The bar uses a single `<Card>` with `grid` layout and dividers:

```tsx
<Card className="p-0 overflow-hidden">
  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border">
    <KpiCell label="PSI" value="96.3" sublabel="BEDROCK" accentColor="green" />
    <KpiCell label="Total MCAP" value="$183.66B" sublabel="+0.2%" />
    <KpiCell label="Active Depegs" value="3" pulse={true} />
    <KpiCell label="Coins at Peg" value="138 / 141" />
    <KpiCell label="Worst Depeg" value="-1805 bps" accentColor="red" />
  </div>
</Card>
```

Each `KpiCell` is:
```tsx
<div className="px-4 py-3 flex flex-col gap-0.5">
  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
  <span className="text-xl font-bold font-mono tabular-nums">{value}</span>
  {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
</div>
```

Data sources: PSI from `useStabilityIndex()`, MCAP from `useStablecoins()`, depegs from `usePegSummary()`.

##### Daily Digest Repositioning

Move the Daily Digest from position 2 (immediately after hero in `page.tsx`) to after the summary cards. Wrap it in a collapsible card:

**File: `src/components/homepage-client.tsx`**

Move `<DailyDigest />` rendering to after the summary cards section. Add a collapse toggle:

```tsx
<section>
  <Card>
    <CardHeader className="flex flex-row items-center justify-between cursor-pointer"
                onClick={() => setDigestOpen(!digestOpen)}>
      <CardTitle className="text-sm font-semibold uppercase tracking-wider">
        Signal & Noise
      </CardTitle>
      <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform",
                                   digestOpen && "rotate-180")} />
    </CardHeader>
    {digestOpen && (
      <CardContent>
        <DailyDigest />
      </CardContent>
    )}
  </Card>
</section>
```

Default `digestOpen` to `true` on first visit, persist state in `localStorage`.

##### Live Dashboard Panels

Keep the existing "Pharos' Unique Features" section with its **5 summary cards** (LiquiditySummary, ReportCardsSummary, BlacklistSummary, CemeterySummary, StabilityIndexSummary). These already show live data via their respective hooks.

**File: `src/components/homepage-client.tsx`**

Current (5 cards in 2→3 col grid):
```tsx
<section>
  <h2 className="text-xl font-semibold tracking-tight mb-4">Pharos' Unique Features</h2>
  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
    <LiquiditySummary />
    <ReportCardsSummary />
    <BlacklistSummary />
    <CemeterySummary />
    <StabilityIndexSummary />
  </div>
</section>
```

Consider enhancing:
- Rename section to something more data-forward (e.g., "Live Indicators")
- A mini version of the peg heatmap (top 20 coins only) that links to full heatmap section below
- A compact grade distribution bar (already exists in Risk Lab's `client.tsx` — extract and reuse)

##### Section Header Consistency

All section headers should follow a single pattern:

```tsx
<div className="flex items-center justify-between mb-4">
  <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
  <Link href={link} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
    View all <ArrowRight className="h-3.5 w-3.5" />
  </Link>
</div>
```

### Files Affected

| File | Change |
|------|--------|
| `src/app/page.tsx` | Replace hero section with compact title + KPI bar; move DailyDigest into homepage-client |
| `src/components/kpi-bar.tsx` | **NEW** — horizontal KPI metrics bar |
| `src/components/homepage-client.tsx` | Reorder sections, add Daily Digest collapse, rename summary section |
| `src/components/daily-digest.tsx` | May need adjustments for collapsible context |

### Verification

- On a 1080p monitor in dark mode, the KPI bar + two charts should be fully visible above the fold
- PSI value, MCAP, active depegs, coins at peg update from live data (not stale)
- Daily Digest is visible but not blocking data visibility
- Mobile: KPI bar wraps to 2-column grid, still readable
- `npm run build` passes

---

## 2.4 Chart Skeleton Components & Loading States

### Problem

When chart data is loading:
1. Some chart containers show nothing (empty card with header)
2. This creates a jarring visual gap and potential layout shift
3. 4 of 10 chart components already have skeleton states, but 5 don't

### Current State

| Chart Component | Has Skeleton? |
|-----------------|--------------|
| `total-mcap-chart.tsx` | **Yes** — `<Skeleton className="h-[250px]...">` |
| `psi-history-chart.tsx` | **Yes** — Skeleton elements |
| `blacklist-chart.tsx` | **Yes** — `isLoading` prop |
| `peg-diversity-chart.tsx` | **Yes** — Skeleton elements |
| `mcap-chart.tsx` | **No** — shows "No market cap data available" text |
| `comparison-chart.tsx` | **No** — no loading state |
| `governance-chart.tsx` | **No** — returns null if data missing |
| `peg-type-chart.tsx` | **No** — returns null if data missing |
| `cemetery-charts.tsx` | **No** — static data, may not need skeleton |
| `dex-liquidity-card.tsx` | Has embedded chart — check if history chart section has loading state |

The stablecoin table skeleton (`stablecoin-table.tsx` lines 184-200) **already uses varied widths** (w-8, w-6, w-28, w-16, w-12, w-20, w-14) — no update needed.

### Design

Create a `<ChartSkeleton>` component that renders a pulsing gradient placeholder matching the chart dimensions.

**New file: `src/components/chart-skeleton.tsx`**

```tsx
interface ChartSkeletonProps {
  className?: string;  // accepts the height class, e.g., "h-[250px] sm:h-[350px]"
}

export function ChartSkeleton({ className = "h-[250px] sm:h-[350px]" }: ChartSkeletonProps) {
  return (
    <div className={cn("w-full rounded-lg bg-muted/30 animate-pulse relative overflow-hidden", className)}>
      {/* Fake axis labels */}
      <div className="absolute left-3 top-3 bottom-8 w-8 flex flex-col justify-between">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="h-2.5 w-full rounded bg-muted/50" />
        ))}
      </div>
      {/* Fake x-axis labels */}
      <div className="absolute bottom-2 left-12 right-3 flex justify-between">
        {[0, 1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-2 w-8 rounded bg-muted/50" />
        ))}
      </div>
      {/* Fake area shape */}
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <path
          d="M 40 80 C 80 75, 120 60, 160 65 C 200 70, 240 40, 280 45 C 320 50, 360 30, 400 35 L 400 100 L 40 100 Z"
          fill="currentColor"
          className="text-muted/20"
          vectorEffect="non-scaling-stroke"
          style={{ transform: 'scaleX(1) scaleY(1)' }}
        />
      </svg>
    </div>
  );
}
```

#### Usage

Add `ChartSkeleton` fallback to chart components that **currently lack loading states**:

**`src/components/mcap-chart.tsx`** (detail page market cap chart):
```tsx
/* Current - shows text when empty */
{filteredData.length > 0 ? (
  <div className="h-[250px] sm:h-[350px]">
    <ResponsiveContainer>...</ResponsiveContainer>
  </div>
) : <p>No market cap data available</p>}

/* Proposed */
{filteredData.length > 0 ? (
  <div className="h-[250px] sm:h-[350px]">
    <ResponsiveContainer>...</ResponsiveContainer>
  </div>
) : (
  <ChartSkeleton className="h-[250px] sm:h-[350px]" />
)}
```

Apply to these components (verify each has no existing loading state first):
- `src/components/mcap-chart.tsx` — detail page market cap
- `src/components/comparison-chart.tsx` — compare page charts
- `src/components/governance-chart.tsx` — homepage/about governance pie
- `src/components/peg-type-chart.tsx` — homepage/about peg type pie
- `src/components/dex-liquidity-card.tsx` — embedded liquidity history chart section

**Skip** (already have skeletons): `total-mcap-chart.tsx`, `psi-history-chart.tsx`, `blacklist-chart.tsx`, `peg-diversity-chart.tsx`

**Skip** (static data): `cemetery-charts.tsx`

### Files Affected

| File | Change |
|------|--------|
| `src/components/chart-skeleton.tsx` | **NEW** — skeleton component |
| `src/components/mcap-chart.tsx` | Add `ChartSkeleton` fallback |
| `src/components/comparison-chart.tsx` | Add `ChartSkeleton` fallback |
| `src/components/governance-chart.tsx` | Add `ChartSkeleton` fallback |
| `src/components/peg-type-chart.tsx` | Add `ChartSkeleton` fallback |
| `src/components/dex-liquidity-card.tsx` | Add `ChartSkeleton` to history chart section |

### Verification

- Navigate to a stablecoin detail page with slow network: chart area shows pulsing skeleton
- Navigate to compare page with coins selected: chart shows skeleton before data loads
- Skeletons match the dimensions of the actual charts (no layout shift)
- `npm run build` passes

---

## 2.5 Detail Page Sticky Section Navigation

### Problem

The stablecoin detail page (`/stablecoin/[id]`) is the most data-dense page in the application. It contains 8 sections stacked vertically (in `client.tsx`):

1. Key Metrics grid (Price, MCAP, Supply, Supply Changes, Peg Score, Bluechip, Liquidity)
2. AI Summary (editorial commentary)
3. Report Card (grade + radar + dimension breakdown)
4. Market Cap Chart
5. Key Information card (links, governance, backing, collateral, jurisdiction)
6. Contract Addresses
7. DEX Liquidity (protocol breakdown, pools, history chart)
8. Depeg History (event timeline)

On a 1080p monitor, this page scrolls for 4-5 viewport heights. Users frequently want to jump between sections (e.g., check the DEX liquidity section after reading the report card).

### Design

Add a **sticky horizontal tab bar** below the coin header that scrolls with the page and highlights the current section.

```
┌──────────────────────────────────────────────────────┐
│ [Logo] Tether (USDT)  · USD · Centralized · RWA     │
├──────────────────────────────────────────────────────┤
│ Overview │ Report Card │ Chart │ Info │ Liquidity │ History │ ← sticky
├──────────────────────────────────────────────────────┤
│                                                      │
│ [Current section content]                            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### Tab Sections

| Tab | Scrolls to | Content |
|-----|-----------|---------|
| Overview | Top of page | Key Metrics grid + AI Summary |
| Report Card | `#report-card` | Grade badge + Radar chart + Dimension breakdown |
| Chart | `#chart` | Market Cap chart |
| Info | `#info` | Key Information + Contract Addresses |
| Liquidity | `#liquidity` | DEX breakdown + Pools + History chart |
| History | `#history` | Depeg event timeline |

#### Implementation

**New file: `src/components/detail-section-nav.tsx`**

```tsx
// Uses IntersectionObserver to detect which section is in viewport
// Renders a sticky horizontal tab bar
// Clicking a tab smooth-scrolls to the section

interface SectionNavProps {
  sections: { id: string; label: string }[];
}

export function DetailSectionNav({ sections }: SectionNavProps) {
  const [activeSection, setActiveSection] = useState(sections[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }  // triggers when section is in upper 30% of viewport
    );

    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border -mx-4 px-4 mb-6">
      <div className="flex gap-1 overflow-x-auto scrollbar-none py-1">
        {sections.map(section => (
          <button
            key={section.id}
            onClick={() => {
              document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            className={cn(
              "px-3 py-2 text-sm font-medium whitespace-nowrap rounded-lg transition-colors",
              activeSection === section.id
                ? "text-foreground bg-muted"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
          >
            {section.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
```

#### Section IDs

Add `id` attributes to each major section in the detail client component:

**File: `src/app/stablecoin/[id]/client.tsx`**

```tsx
<section id="overview">
  {/* Key Metrics grid + AI Summary */}
</section>
<section id="report-card">
  {/* ReportCardDetail */}
</section>
<section id="chart">
  {/* McapChart */}
</section>
<section id="info">
  {/* Key Information + Contract Addresses */}
</section>
<section id="liquidity">
  {/* DexLiquidityCard */}
</section>
<section id="history">
  {/* Depeg History */}
</section>
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/detail-section-nav.tsx` | **NEW** — sticky section nav |
| `src/app/stablecoin/[id]/client.tsx` | Add section IDs, integrate `DetailSectionNav` |
| `src/app/stablecoin/[id]/page.tsx` | May need to pass section config to client |

### Verification

- Scroll down the detail page: tab bar highlights the current section
- Click a tab: smooth-scrolls to the section
- Mobile: tab bar scrolls horizontally, doesn't wrap
- Sticky position doesn't conflict with sidebar (sidebar is vertical, this is horizontal)
- On mobile, sticky top accounts for the 56px header (use `top: 56px` or `top: var(--table-header-top)` on mobile)

---

## 2.6 Compare Page Empty State Improvement

### Problem

The Compare page at `/compare` shows a minimal empty state: a Search icon + "Select at least 2 stablecoins to compare." This gives new users no guidance on what a comparison looks like or which coins are worth comparing.

### Design

Replace the empty state with **suggested comparison presets** and a preview of what the comparison view looks like.

> **Critical implementation note:** The compare page uses **lowercase symbols** (not DefiLlama IDs) in the URL query parameter. E.g., `/compare?coins=usdt,usdc,fdusd` — not `coins=tether,usd-coin,first-digital-usd`. All preset `coins` arrays must use symbols.

```
┌─────────────────────────────────────────────────────────┐
│ Compare Stablecoins                                     │
│ Select 2-5 stablecoins to compare side by side          │
│                                                         │
│ [Dropdown 1] [Dropdown 2] [Dropdown 3] [Dropdown 4] [5]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Popular Comparisons                                     │
│                                                         │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│ │ The Big Three│ │ DeFi Natives │ │ Gold Pegs    │     │
│ │ USDT vs USDC │ │ DAI vs LUSD  │ │ PAXG vs XAUT │     │
│ │ vs FDUSD     │ │ vs BOLD      │ │ vs KAU       │     │
│ │   [Compare]  │ │   [Compare]  │ │   [Compare]  │     │
│ └──────────────┘ └──────────────┘ └──────────────┘     │
│                                                         │
│ ┌──────────────┐ ┌──────────────┐                      │
│ │ Euro Pegs    │ │ Yield-bearing│                      │
│ │ EURS vs EURA │ │ USDS vs USDe │                      │
│ │ vs EURE      │ │ vs GHO       │                      │
│ │   [Compare]  │ │   [Compare]  │                      │
│ └──────────────┘ └──────────────┘                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Suggested Presets

All `coins` arrays use **lowercase symbols** matching `SYMBOL_TO_COIN` in `compare/client.tsx`. Every coin below has been verified present in `TRACKED_STABLECOINS`.

```tsx
const COMPARISON_PRESETS = [
  {
    title: "The Big Three",
    description: "The three largest USD stablecoins by market cap",
    coins: ["usdt", "usdc", "fdusd"],
  },
  {
    title: "DeFi Natives",
    description: "Decentralized, crypto-backed stablecoins",
    coins: ["dai", "lusd", "bold"],
  },
  {
    title: "Gold Pegs",
    description: "Tokenized gold stablecoins",
    coins: ["paxg", "xaut", "kau"],
  },
  {
    title: "Euro Stablecoins",
    description: "EUR-pegged stablecoins",
    coins: ["eurs", "eura", "eure"],
  },
  {
    title: "Yield-Bearing",
    description: "Stablecoins with native yield mechanisms",
    coins: ["usds", "usde", "gho"],
  },
];
```

Clicking a preset navigates to `/compare?coins=usdt,usdc,fdusd` (using `router.push`), which the existing `CompareClient` parses via `SYMBOL_TO_COIN`.

### Files Affected

| File | Change |
|------|--------|
| `src/app/compare/client.tsx` | Add preset cards to empty state (inline, or import from separate component) |

### Verification

- Compare page with no coins selected shows preset cards
- Clicking a preset updates the URL and populates the dropdowns with the correct coins
- Comparison table/radar renders correctly after preset selection
- All preset symbols resolve correctly via `SYMBOL_TO_COIN`
- `npm run build` passes

---

## 2.7 Data Export (CSV & Chart PNG)

### Problem

Professional analytics tools let users export data for further analysis. Currently, Pharos offers no export functionality for tables or charts.

Competitors offering export:
- Dune: CSV download, chart screenshot
- Token Terminal: CSV, Excel, chart PNG
- DefiLlama: CSV download on most tables

### Design

Add two export capabilities:

#### 2.7a — CSV Download for Tables

Add a "Download CSV" button to the filter bar above each major table.

**New file: `src/lib/csv-export.ts`**

```tsx
interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => string | number | null;
}

export function downloadCsv<T>(
  data: T[],
  columns: CsvColumn<T>[],
  filename: string
): void {
  const header = columns.map(c => c.header).join(',');
  const rows = data.map(row =>
    columns.map(c => {
      const val = c.accessor(row);
      if (val === null || val === undefined) return '';
      const str = String(val);
      // Escape CSV special chars
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
```

**Components to add CSV export:**

| Table | Component | Filename |
|-------|-----------|----------|
| Stablecoin table (homepage) | `src/components/stablecoin-table.tsx` | `pharos-stablecoins` |
| Peg heatmap | `src/components/peg-heatmap.tsx` | `pharos-peg-data` |
| Blacklist table | `src/components/blacklist-table.tsx` | `pharos-freeze-events` |
| DEX Liquidity (liquidity page) | Identify the table component in `src/app/liquidity/` | `pharos-dex-liquidity` |

**Button placement:** Add a `<Button variant="outline" size="xs">` with a Download icon to the filter bar or table header:

```tsx
<Button
  variant="outline"
  size="xs"
  onClick={() => downloadCsv(data, columns, 'pharos-stablecoins')}
  className="gap-1.5"
>
  <Download className="h-3.5 w-3.5" />
  CSV
</Button>
```

#### 2.7b — Chart Screenshot (PNG)

Add a camera/download icon to chart card headers. On click, capture the chart as a PNG using `html-to-image`.

**Dependency:** `html-to-image` is **not installed** — requires `npm install html-to-image`.

**New file: `src/lib/chart-export.ts`**

```tsx
import { toPng } from 'html-to-image';

export async function downloadChartPng(
  elementRef: React.RefObject<HTMLElement>,
  filename: string
): Promise<void> {
  if (!elementRef.current) return;
  const dataUrl = await toPng(elementRef.current, {
    backgroundColor: 'var(--color-card)',
    pixelRatio: 2,  // retina quality
  });
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${filename}-${new Date().toISOString().split('T')[0]}.png`;
  a.click();
}
```

Add a download button to chart card headers using `CardAction` (exists in `src/components/ui/card.tsx`):

```tsx
<CardHeader>
  <CardTitle>Market Cap</CardTitle>
  <CardAction>
    <div className="flex items-center gap-1">
      <TimeRangeButtons ... />
      <Button variant="ghost" size="icon-sm" onClick={() => downloadChartPng(chartRef, 'pharos-mcap')}>
        <Camera className="h-3.5 w-3.5" />
      </Button>
    </div>
  </CardAction>
</CardHeader>
```

The chart container needs a `ref`:

```tsx
const chartRef = useRef<HTMLDivElement>(null);
// ...
<div ref={chartRef} className="h-[250px] sm:h-[350px]">
  <ResponsiveContainer>...</ResponsiveContainer>
</div>
```

### Files Affected

| File | Change |
|------|--------|
| `src/lib/csv-export.ts` | **NEW** — CSV generation utility |
| `src/lib/chart-export.ts` | **NEW** — chart PNG capture utility |
| `src/components/stablecoin-table.tsx` | Add CSV download button |
| `src/components/peg-heatmap.tsx` | Add CSV download button |
| `src/components/blacklist-table.tsx` | Add CSV download button |
| Chart components with CardAction headers | Add PNG export button + ref |
| `package.json` | Add `html-to-image` dependency |

### Verification

- Click CSV on any table → downloads a `.csv` file with correct headers and data
- Open CSV in Excel/Google Sheets → data is properly formatted, no encoding issues
- Click camera on any chart → downloads a `.png` file with the chart at 2x resolution
- PNG has correct background color (card color, not transparent)
- Export buttons don't interfere with existing UI (small, unobtrusive)
- `npm run build` passes

---

## Implementation Order

Execute in this order to minimize interdependencies:

1. **2.4 Chart skeletons** — independent, no structural changes, reduced scope (5 components)
2. **2.6 Compare empty state** — independent, small scope (single file)
3. **2.5 Detail section nav** — independent, small scope
4. **2.7 Data export** — independent, adds new utility files + buttons
5. **2.3 Homepage redesign** — depends on Tier 1 being complete for visual consistency
6. **2.1 Sidebar navigation** — largest structural change; creates shared nav config needed by §2.2
7. **2.2 Command palette** — depends on shared nav config from §2.1

Items 1-4 can be done in parallel. Items 5-7 should be sequential.

---

## Appendix: Discrepancies Corrected from Original Plan

This section documents what changed from the original draft after verifying against the current codebase (2026-02-26):

| Original Assumption | Actual State | Correction |
|---------------------|-------------|------------|
| Header has 8 nav items | 7 items (no Peg Tracker in nav) | Updated count and item list |
| `/peg-tracker` page exists | No such page; peg heatmap is on homepage | Removed from sidebar nav |
| Portfolio is standalone page | Embedded in Risk Lab (`/risk-lab`) | Kept in Risk Lab, removed from nav |
| Contagion Map page exists | Does not exist | Removed from sidebar nav |
| Mobile breakpoint is `md:` (768px) | Header uses `sm:` (640px) | Plan standardizes on `md:` with migration note |
| `PegTrackerSummary` component exists | Does not exist | Removed; actual components are 5 (not 6) |
| Compare presets use DefiLlama IDs | Compare page uses lowercase symbols via `SYMBOL_TO_COIN` | All presets rewritten with symbols |
| Preset coins: tgold, savings-dai, mountain-protocol-usdm | Not in TRACKED_STABLECOINS | Replaced with KAU, USDS, GHO |
| `supply-chart.tsx` exists | No such file | Removed from chart skeleton targets |
| `dex-liquidity-history-chart.tsx` is standalone | Embedded in `dex-liquidity-card.tsx` | Updated file reference |
| 4+ charts need skeletons | total-mcap, psi-history, blacklist, peg-diversity already have them | Reduced scope to 5 components |
| Table skeleton uses uniform `w-20` | Already uses varied widths (w-8 through w-28) | Removed table skeleton update |
| `peg-leaderboard.tsx` exists | No such file; peg data is in `peg-heatmap.tsx` | Updated file reference |
| `cmdk` may be installed | Not installed | Confirmed: use Dialog + custom filter |
| `html-to-image` may be installed | Not installed | Confirmed: needs `npm install` |
| Section IDs in `page.tsx` | Detail sections are in `client.tsx` | Updated file reference |
| `NAV_ITEMS` in shared config | Defined locally in `header.tsx` | Added extraction step to §2.1 |
