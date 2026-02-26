# Design Overhaul — Tier 2: Structural Improvements

**Date:** 2026-02-26
**Status:** Draft
**Effort:** 1-2 weeks per item, ~4-6 weeks total
**Impact:** Transforms the application structure from "polished dashboard" to "professional analytics platform"
**Prerequisite:** Tier 1 changes should be completed first to establish the updated visual foundation

## Overview

These changes require moderate refactoring — new components, layout restructuring, or new feature additions. Each item addresses a structural gap identified in competitive benchmarking against DefiLlama, Dune, Nansen, Token Terminal, and Artemis.

---

## 2.1 Sidebar Navigation

### Problem

Pharos uses a horizontal sticky top bar (`src/components/header.tsx`) that is 56px tall and contains 8 navigation items with icons + labels. This has three problems:

1. **Doesn't scale.** 8 items already crowd the bar. Adding new features (Contagion Map, Portfolio Analyzer, Digest Archive are already under sub-pages) will break the layout.
2. **Wastes vertical space.** 56px of vertical screen real estate is permanently consumed. On a 1080p monitor, that's 5.2% of the viewport — space that could display one more KPI row or chart.
3. **No grouping.** All 8 items sit in a flat list. Risk Lab, Stability Index, and Report Cards are conceptually related but visually equal to Cemetery and About.

**Competitor pattern:** 4 out of 5 benchmarked competitors use a left sidebar:
- DefiLlama: 228px full sidebar with categorized groups
- Artemis: 60px icon-only sidebar (hover to expand)
- Token Terminal: Two-level (top bar for major sections + left sidebar for sub-categories)
- Dune: Top nav + left sidebar in editor context

### Design

Implement a **collapsible left sidebar** that defaults to collapsed (icons only) and expands on hover or toggle.

#### States

| State | Width | Content | Trigger |
|-------|-------|---------|---------|
| Collapsed (default) | 56px | Icons only, tooltip on hover | Default on all viewports ≥768px |
| Expanded | 220px | Icons + labels, grouped sections | User clicks toggle button, or hovers (with 200ms delay) |
| Hidden | 0px | Off-screen | Viewports <768px (mobile uses hamburger) |

#### Navigation Groups

```
Market
  ├── Dashboard          (LayoutDashboard icon)
  ├── Peg Tracker        (Activity icon)
  └── Liquidity          (Droplets icon)

Risk
  ├── Stability Index    (Lighthouse icon)
  ├── Report Cards       (ClipboardCheck icon)
  ├── Portfolio          (Briefcase icon)
  └── Contagion Map      (Network icon)

Data
  ├── Compare            (ArrowLeftRight icon)
  ├── Freeze Tracker     (ShieldBan icon)
  ├── Cemetery           (Skull icon)
  └── Digest Archive     (Newspaper icon)

───────────────────
About                    (Info icon)
Theme Toggle             (Sun/Moon icon)
```

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
// - Mobile: hidden, replaced by hamburger dropdown (existing pattern)
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
  <Header />
  <main className="container mx-auto px-4 py-8">{children}</main>
  <Footer />
</body>
```

Proposed layout:
```tsx
<body>
  <div className="flex min-h-screen">
    <Sidebar />
    <div className="flex-1 flex flex-col min-w-0">
      {/* min-w-0 prevents flex child overflow */}
      <main className="flex-1 container mx-auto px-4 py-6 lg:px-6">
        {children}
      </main>
      <Footer />
    </div>
  </div>
</body>
```

**File: `src/components/header.tsx`**

The existing header component becomes the **mobile-only** header. On desktop (md+), it is hidden and the sidebar takes over navigation.

```tsx
// Wrap the entire header in a responsive container:
<header className="md:hidden sticky top-0 z-50 border-b bg-background/95 backdrop-blur ...">
  {/* existing mobile hamburger implementation */}
</header>
```

#### Sticky Table Header Adjustment

The current `.table-header-sticky` uses `--table-header-top` to offset below the 56px header. With the sidebar, the header is removed on desktop, so sticky headers should stick to `top: 0`:

**File: `src/app/globals.css`**

```css
.table-header-sticky thead {
  position: sticky;
  top: 0;  /* was: var(--table-header-top, 0px) */
  z-index: 10;
}
```

If some components still use `--table-header-top`, set it to `0px` in the `:root` block.

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
| `src/components/sidebar.tsx` | **NEW** — main sidebar component |
| `src/app/layout.tsx` | Layout restructure (flex row with sidebar) |
| `src/components/header.tsx` | Restrict to mobile-only, or refactor into `mobile-header.tsx` |
| `src/app/globals.css` | Update `--table-header-top`, add sidebar transition utilities |
| `src/components/footer.tsx` | Remove redundant navigation links (sidebar handles nav) |

### Verification

- Desktop (≥768px): sidebar visible, no top header, content fills remaining width
- Mobile (<768px): hamburger menu, no sidebar, full-width content
- Sidebar collapsed: icons only, tooltips on hover, 56px wide
- Sidebar expanded: icons + labels + group headers, 220px wide
- Active page highlighted correctly for all routes including nested routes
- `npm run build` passes (static export must not break)
- Sticky table headers still work (top: 0 without header offset)

---

## 2.2 Command Palette (Ctrl/Cmd+K Search)

### Problem

With 141 tracked stablecoins across 8+ pages, finding a specific coin or feature requires scrolling through the table or navigating page by page. Competitors like Token Terminal and Artemis offer instant Ctrl/Cmd+K search across all entities. Dune uses it for both content and command search.

### Design

Implement a **command palette dialog** triggered by Ctrl/Cmd+K (or clicking a search icon in the sidebar/header).

#### Behavior

1. Press Ctrl+K (or Cmd+K on macOS) → palette opens as a centered modal with search input auto-focused
2. Type to search → results update in real-time (client-side filtering, no API call)
3. Results organized in sections:
   - **Stablecoins** (141 entries) — fuzzy match on name, symbol, id
   - **Pages** (8 entries) — match on page name and description
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

// Pages: hardcoded
const pageEntries = NAV_ITEMS.map(item => ({
  type: 'page' as const,
  label: item.label,
  sublabel: item.description,
  href: item.href,
  icon: item.icon,
  keywords: item.label,
}));
```

#### Component Structure

**New file: `src/components/command-palette.tsx`**

Use shadcn's `<Dialog>` as the base (or `cmdk` library if already available):

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
│  [icon] Peg Tracker                         │
│  [icon] Stability Index                     │
│  [icon] Report Cards                        │
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

Check if `cmdk` is already installed. If not, consider using it for accessible command palette behavior (keyboard navigation, scoring, grouping). If adding a dependency is undesired, implement with a custom `<Dialog>` + `<input>` + filtered list.

```bash
# Check existing deps
grep "cmdk" package.json
```

If not present, a lightweight implementation using shadcn's `Dialog` + custom fuzzy filter is sufficient.

#### Fuzzy Search

Simple substring match is adequate for 141 entries + 8 pages. No need for Fuse.js or similar:

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
| `src/components/command-palette.tsx` | **NEW** — palette component |
| `src/app/layout.tsx` or `src/components/providers.tsx` | Add global keyboard listener + palette rendering |
| `src/components/sidebar.tsx` | Add search trigger icon |
| `src/components/header.tsx` | Add search trigger icon (mobile) |

### Verification

- Ctrl/Cmd+K opens the palette from any page
- Typing "USDT" shows Tether as the first result
- Typing "peg" shows both Peg Tracker (page) and pegged coins
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

**Competitor pattern:** DefiLlama, Token Terminal, and Artemis all lead immediately with data — KPI metrics, charts, and tables visible within the first viewport.

### Design

Restructure the homepage to prioritize live data while preserving the editorial personality:

```
[Sidebar (if implemented) | Content area]
  ├── KPI Bar: PSI score • Total MCAP • Active Depegs • Coins at Peg • 24h Volume
  ├── Two-column chart grid: Total MCAP | PSI History
  ├── Market Highlights: Key Movements (depegs + biggest movers, existing component)
  ├── Live Dashboard Panels (3-col grid):
  │     ├── Peg Status (mini heatmap, top 20 coins)
  │     ├── Recent Freeze Events (last 3)
  │     └── Grade Distribution (compact)
  ├── Daily Digest (collapsible card)
  ├── Key Stablecoin Data section:
  │     ├── Filter Bar
  │     └── Stablecoin Table
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

A horizontal row of 5-6 key metrics with the PSI score as the anchor:

```
┌─────────┬─────────────┬──────────────┬─────────────┬────────────┐
│ PSI     │ Total MCAP  │ Active       │ Coins       │ Worst      │
│ 96.3    │ $183.66B    │ Depegs: 3    │ at Peg: 138 │ Depeg:     │
│ BEDROCK │ ▲ +0.2%     │ 🔴           │ / 141       │ -1805 bps  │
└─────────┴─────────────┴──────────────┴─────────────┴────────────┘
```

Each cell:
```
text-xs font-semibold uppercase tracking-wider text-muted-foreground  (label)
text-2xl font-bold font-mono tabular-nums  (value)
text-xs text-muted-foreground  (sublabel/delta)
```

The bar uses a single `<Card>` with `flex` layout and dividers:

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

Move the Daily Digest from position 2 (immediately after hero) to position 5 (after the dashboard panels, before the table). Wrap it in a collapsible card:

**File: `src/components/homepage-client.tsx`**

Move `<DailyDigest />` import and rendering below the feature cards section. Add a collapse toggle:

```tsx
<section>
  <Card>
    <CardHeader className="flex flex-row items-center justify-between cursor-pointer"
                onClick={() => setDigestOpen(!digestOpen)}>
      <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider">
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

**Replace the "Pharos' Unique Features" section** (which shows static counts) with **live data panels**:

**File: `src/components/homepage-client.tsx`** (lines 78-88)

Current:
```tsx
<section>
  <h2 className="text-lg font-semibold tracking-tight mb-4">Pharos' Unique Features</h2>
  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
    <PegTrackerSummary />
    <LiquiditySummary />
    <ReportCardsSummary />
    <BlacklistSummary />
    <CemeterySummary />
    <StabilityIndexSummary />
  </div>
</section>
```

Keep the existing summary components but restructure to show more live data. The current `PegTrackerSummary`, `BlacklistSummary`, etc. already show live counts — verify they show trending/changing data, not just totals.

Consider adding:
- A mini version of the peg heatmap (top 20 coins only) that links to full Peg Tracker
- A "Biggest 24h Movers" micro-table (top 3 gainers, top 3 losers)
- A compact grade distribution bar (already exists in Risk Lab — extract and reuse)

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
| `src/app/page.tsx` | Replace hero section with compact title + KPI bar |
| `src/components/kpi-bar.tsx` | **NEW** — horizontal KPI metrics bar |
| `src/components/homepage-client.tsx` | Reorder sections, add Daily Digest collapse |
| `src/components/daily-digest.tsx` | May need adjustments for collapsible context |
| Existing summary components | Verify they show live data, not just static counts |

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
1. The chart container area shows nothing (empty card with header)
2. This creates a jarring visual gap and potential layout shift
3. The table uses skeleton rows but charts have no equivalent

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

Replace empty states in all chart components:

**File: `src/components/mcap-chart.tsx`**

```tsx
/* Current - no loading state */
{filteredData.length > 0 ? (
  <div className="h-[250px] sm:h-[350px]">
    <ResponsiveContainer>...</ResponsiveContainer>
  </div>
) : null}

/* Proposed */
{filteredData.length > 0 ? (
  <div className="h-[250px] sm:h-[350px]">
    <ResponsiveContainer>...</ResponsiveContainer>
  </div>
) : (
  <ChartSkeleton className="h-[250px] sm:h-[350px]" />
)}
```

Apply to:
- `src/components/mcap-chart.tsx`
- `src/components/total-mcap-chart.tsx`
- `src/components/psi-history-chart.tsx`
- `src/components/supply-chart.tsx`
- `src/components/dex-liquidity-history-chart.tsx`
- Any wrapper component that conditionally renders a chart

#### Improved Table Skeleton

Also update the table skeleton to vary row widths:

**File: `src/components/stablecoin-table.tsx`** (skeleton section)

```tsx
// Current: all skeleton bars are same width
<Skeleton className="h-4 w-20" />

// Proposed: vary widths to approximate column content
const SKELETON_WIDTHS = [
  'w-6',   // rank
  'w-28',  // name
  'w-16',  // price
  'w-12',  // peg
  'w-20',  // mcap
  'w-14',  // 24h
  'w-14',  // 7d
];
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/chart-skeleton.tsx` | **NEW** — skeleton component |
| All chart components | Add `ChartSkeleton` fallback for empty/loading states |
| `src/components/stablecoin-table.tsx` | Improve skeleton row width variance |

### Verification

- Navigate to homepage with slow network: chart areas should show pulsing skeleton
- Navigate to stability index: PSI chart shows skeleton before data loads
- Table shows varied-width skeleton bars
- Skeletons match the dimensions of the actual charts (no layout shift)

---

## 2.5 Detail Page Sticky Section Navigation

### Problem

The stablecoin detail page (`/stablecoin/[id]`) is the most data-dense page in the application. It contains 7+ sections stacked vertically:

1. Coin header + badges
2. KPI cards (Price, MCAP, Supply)
3. Score cards (Peg, Bluechip, Liquidity)
4. Editorial commentary
5. Report Card (grade + radar + dimension breakdown)
6. Market Cap chart + Key Information
7. Contract Addresses
8. DEX Liquidity (protocol breakdown, pools, chart)

On a 1080p monitor, this page scrolls for 4-5 viewport heights. Users frequently want to jump between sections (e.g., check the DEX liquidity section after reading the report card).

### Design

Add a **sticky horizontal tab bar** below the coin header that scrolls with the page and highlights the current section.

```
┌──────────────────────────────────────────────────────┐
│ [Logo] Tether (USDT)  · USD · Centralized · RWA     │
├──────────────────────────────────────────────────────┤
│ Overview │ Report Card │ Charts │ Info │ Liquidity   │ ← sticky, scrolls horizontally on mobile
├──────────────────────────────────────────────────────┤
│                                                      │
│ [Current section content]                            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### Tab Sections

| Tab | Scrolls to | Content |
|-----|-----------|---------|
| Overview | Top of page | KPI cards + Score cards + Commentary |
| Report Card | `#report-card` | Grade badge + Radar chart + Dimension breakdown |
| Charts | `#charts` | Market Cap chart + Supply chart |
| Info | `#info` | Key Information + Contract Addresses |
| Liquidity | `#liquidity` | DEX breakdown + Pools + History chart |

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

Add `id` attributes to each major section in the detail page:

**File: `src/app/stablecoin/[id]/page.tsx`** (or the detail client component)

```tsx
<section id="overview">...</section>
<section id="report-card">...</section>
<section id="charts">...</section>
<section id="info">...</section>
<section id="liquidity">...</section>
```

### Files Affected

| File | Change |
|------|--------|
| `src/components/detail-section-nav.tsx` | **NEW** — sticky section nav |
| `src/app/stablecoin/[id]/page.tsx` | Add section IDs, integrate `DetailSectionNav` |

### Verification

- Scroll down the detail page: tab bar highlights the current section
- Click a tab: smooth-scrolls to the section
- Mobile: tab bar scrolls horizontally, doesn't wrap
- Sticky position doesn't conflict with other sticky elements (sidebar on desktop is horizontal, not vertical)

---

## 2.6 Compare Page Empty State Improvement

### Problem

The Compare page at `/compare` shows a minimal empty state: a magnifying glass icon + "Select at least 2 stablecoins to compare." This gives new users no guidance on what a comparison looks like or which coins are worth comparing.

### Design

Replace the empty state with **suggested comparison presets** and a preview of what the comparison view looks like:

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
│ │ vs FDUSD     │ │ vs BOLD      │ │ vs TGLD      │     │
│ │   [Compare]  │ │   [Compare]  │ │   [Compare]  │     │
│ └──────────────┘ └──────────────┘ └──────────────┘     │
│                                                         │
│ ┌──────────────┐ ┌──────────────┐                      │
│ │ Euro Pegs    │ │ Yield-bearing│                      │
│ │ EURS vs EURA │ │ sDAI vs USDS │                      │
│ │ vs EURe      │ │ vs USDe      │                      │
│ │   [Compare]  │ │   [Compare]  │                      │
│ └──────────────┘ └──────────────┘                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Suggested Presets

```tsx
const COMPARISON_PRESETS = [
  {
    title: "The Big Three",
    description: "The three largest USD stablecoins by market cap",
    coins: ["tether", "usd-coin", "first-digital-usd"],
  },
  {
    title: "DeFi Natives",
    description: "Decentralized, crypto-backed stablecoins",
    coins: ["dai", "liquity-usd", "bold-dollar"],
  },
  {
    title: "Gold Pegs",
    description: "Tokenized gold stablecoins",
    coins: ["pax-gold", "tether-gold", "tgold"],
  },
  {
    title: "Euro Stablecoins",
    description: "EUR-pegged stablecoins",
    coins: ["stasis-eurs", "ageur", "monerium-eur-money"],
  },
  {
    title: "Yield-Bearing",
    description: "Stablecoins with native yield mechanisms",
    coins: ["savings-dai", "ethena-usde", "mountain-protocol-usdm"],
  },
];
```

Clicking a preset populates the dropdowns and triggers the comparison view. The preset cards link to `/compare?coins=tether,usd-coin,first-digital-usd`.

### Files Affected

| File | Change |
|------|--------|
| `src/app/compare/page.tsx` (or `client.tsx`) | Add preset cards to empty state |
| `src/components/comparison-presets.tsx` | **NEW** — preset card grid component |

### Verification

- Compare page with no coins selected shows preset cards
- Clicking a preset populates the dropdowns with the correct coins
- Comparison table/radar renders correctly after preset selection
- Preset coin IDs must be valid (cross-reference with `TRACKED_STABLECOINS`)

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

| Table | Columns to Export | Filename |
|-------|-------------------|----------|
| Stablecoin table | Rank, Name, Symbol, Price, MCAP, 24h%, 7d%, Peg Score, Liquidity Score, Grade | `pharos-stablecoins` |
| Peg Leaderboard | Symbol, Peg Score, Current Dev, Peg %, Events, Worst Dev | `pharos-peg-tracker` |
| Blacklist table | Date, Stablecoin, Chain, Event, Address, Amount, Tx | `pharos-freeze-events` |
| DEX Liquidity table | Symbol, Score, TVL, Pools, Protocols | `pharos-dex-liquidity` |

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

Add a camera/download icon to chart card headers. On click, capture the chart as a PNG using `html-to-image` or the Canvas API.

**Approach: `html-to-image` library** (lightweight, works with SVG-based Recharts):

```bash
npm install html-to-image
```

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

Add a download button to chart card headers using `CardAction`:

```tsx
<CardHeader>
  <CardTitle as="h2">Market Cap</CardTitle>
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
| `src/components/peg-leaderboard.tsx` | Add CSV download button |
| `src/components/blacklist-table.tsx` | Add CSV download button |
| All chart components | Add PNG export button + ref |
| `package.json` | Add `html-to-image` dependency |

### Verification

- Click CSV on any table → downloads a `.csv` file with correct headers and data
- Open CSV in Excel/Google Sheets → data is properly formatted, no encoding issues
- Click camera on any chart → downloads a `.png` file with the chart at 2x resolution
- PNG has correct background color (card color, not transparent)
- Export buttons don't interfere with existing UI (small, unobtrusive)

---

## Implementation Order

Execute in this order to minimize interdependencies:

1. **2.4 Chart skeletons** — independent, no structural changes
2. **2.6 Compare empty state** — independent, small scope
3. **2.5 Detail section nav** — independent, small scope
4. **2.7 Data export** — independent, adds new files only
5. **2.3 Homepage redesign** — depends on Tier 1 being complete for visual consistency
6. **2.2 Command palette** — should be done after or alongside 2.1
7. **2.1 Sidebar navigation** — largest structural change, do last (or first if prioritized)

Items 1-4 can be done in parallel. Items 5-7 should be sequential.
