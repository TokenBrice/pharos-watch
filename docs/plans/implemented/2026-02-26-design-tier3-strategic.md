# Design Overhaul — Tier 3: Strategic Investments

**Date:** 2026-02-26
**Status:** Draft
**Effort:** Weeks to months per item
**Impact:** Long-term differentiation, design system maturity, and institutional-grade polish
**Prerequisites:** Tier 1 (visual foundation) and at least Tier 2.1 (sidebar) and 2.2 (command palette) should be complete

## Overview

These investments are not about fixing weaknesses — Tiers 1 and 2 handle that. Tier 3 is about building moats: design system formalization that prevents quality regression, custom visualizations that no competitor offers, user personalization that creates stickiness, and accessibility standards that demonstrate institutional maturity.

---

## 3.1 Design Token System

### Problem

Pharos currently uses CSS custom properties in `globals.css` for theme colors and a `--radius` variable for border radius. This works but has gaps:

1. **No semantic naming layer.** Colors are named by visual properties (`--card`, `--muted`) not by function (`--surface-primary`, `--surface-elevated`). Adding a third elevation level or a new component category requires ad-hoc variable creation.
2. **Hardcoded values scattered across components.** PSI band colors in `psi-history-chart.tsx`, deviation colors in `severity-colors.ts`, classification colors in `classification.ts`, chart palette in `chart-colors.ts` — four separate files with overlapping color concerns.
3. **No spacing scale documentation.** Gap values (gap-1 through gap-6) are used ad-hoc. There's no documented scale for "how much spacing between X and Y."
4. **No typography scale documentation.** Font sizes, weights, and tracking values are applied per-component without a documented hierarchy.
5. **No design-to-code bridge.** A designer or contributor has no single reference for "what are Pharos' design tokens?"

Competitor reference: DefiLlama uses a fully semantic token system with `--text-primary`, `--bg-main`, `--cards-bg`, `--divider` across light/dark modes, all defined in a single `tailwind.css` file.

### Design

Create a **three-layer token architecture:**

```
Layer 1: Primitive tokens (raw values)
  ↓
Layer 2: Semantic tokens (function-based aliases)
  ↓
Layer 3: Component tokens (specific component mappings)
```

#### Layer 1: Primitives

**New file: `src/styles/tokens/primitives.css`**

These are the raw color, spacing, and typography values — never used directly in components:

```css
:root {
  /* ─── Color Primitives (OKLch) ─── */
  --p-white: oklch(1 0 0);
  --p-black: oklch(0 0 0);

  /* Neutral scale (0 chroma = pure gray) */
  --p-neutral-50:  oklch(0.985 0 0);
  --p-neutral-100: oklch(0.97 0 0);
  --p-neutral-200: oklch(0.922 0 0);
  --p-neutral-300: oklch(0.82 0 0);
  --p-neutral-400: oklch(0.708 0 0);
  --p-neutral-500: oklch(0.556 0 0);
  --p-neutral-600: oklch(0.40 0 0);
  --p-neutral-700: oklch(0.30 0 0);
  --p-neutral-800: oklch(0.205 0 0);
  --p-neutral-900: oklch(0.145 0 0);
  --p-neutral-950: oklch(0.085 0 0);

  /* Blue-gray scale (hue 260, low chroma — Pharos dark mode tint) */
  --p-blue-gray-50:  oklch(0.97 0.005 260);
  --p-blue-gray-100: oklch(0.92 0.008 260);
  --p-blue-gray-200: oklch(0.82 0.01 260);
  --p-blue-gray-300: oklch(0.70 0.015 260);
  --p-blue-gray-400: oklch(0.55 0.02 260);
  --p-blue-gray-500: oklch(0.40 0.02 260);
  --p-blue-gray-600: oklch(0.30 0.02 260);
  --p-blue-gray-700: oklch(0.24 0.02 260);
  --p-blue-gray-800: oklch(0.20 0.015 260);
  --p-blue-gray-900: oklch(0.14 0.01 260);
  --p-blue-gray-950: oklch(0.085 0.015 260);

  /* Brand */
  --p-frost-blue: oklch(0.72 0.14 248);

  /* Severity */
  --p-green: oklch(0.72 0.17 155);       /* #22c55e range */
  --p-emerald: oklch(0.70 0.17 165);     /* #10b981 range */
  --p-teal: oklch(0.68 0.14 180);        /* #14b8a6 range */
  --p-amber: oklch(0.80 0.18 85);        /* #f59e0b range */
  --p-yellow: oklch(0.82 0.19 90);       /* #eab308 range */
  --p-orange: oklch(0.72 0.20 50);       /* #f97316 range */
  --p-red: oklch(0.63 0.24 28);          /* #ef4444 range */
  --p-red-dark: oklch(0.45 0.20 25);     /* #991b1b range */
  --p-blue: oklch(0.60 0.20 260);        /* #3b82f6 range */
  --p-violet: oklch(0.60 0.20 290);      /* #8b5cf6 range */
  --p-pink: oklch(0.65 0.22 350);        /* #ec4899 range */
  --p-indigo: oklch(0.55 0.20 275);      /* #6366f1 range */
  --p-cyan: oklch(0.70 0.14 200);        /* #06b6d4 range */

  /* ─── Spacing Primitives ─── */
  --p-space-0: 0;
  --p-space-0.5: 0.125rem;  /* 2px */
  --p-space-1: 0.25rem;     /* 4px */
  --p-space-1.5: 0.375rem;  /* 6px */
  --p-space-2: 0.5rem;      /* 8px */
  --p-space-3: 0.75rem;     /* 12px */
  --p-space-4: 1rem;        /* 16px */
  --p-space-5: 1.25rem;     /* 20px */
  --p-space-6: 1.5rem;      /* 24px */
  --p-space-8: 2rem;        /* 32px */

  /* ─── Typography Primitives ─── */
  --p-font-sans: var(--font-geist-sans);
  --p-font-mono: var(--font-geist-mono);

  --p-text-xs: 0.75rem;     /* 12px */
  --p-text-sm: 0.875rem;    /* 14px */
  --p-text-base: 1rem;      /* 16px */
  --p-text-lg: 1.125rem;    /* 18px */
  --p-text-xl: 1.25rem;     /* 20px */
  --p-text-2xl: 1.5rem;     /* 24px */
  --p-text-3xl: 1.875rem;   /* 30px */
  --p-text-4xl: 2.25rem;    /* 36px */
  --p-text-5xl: 3rem;       /* 48px */

  /* ─── Radius Primitives ─── */
  --p-radius-sm: 0.25rem;   /* 4px */
  --p-radius-md: 0.375rem;  /* 6px */
  --p-radius-lg: 0.5rem;    /* 8px */
  --p-radius-xl: 0.75rem;   /* 12px */
  --p-radius-full: 9999px;
}
```

#### Layer 2: Semantic Tokens

**New file: `src/styles/tokens/semantic.css`**

These map primitives to functional roles:

```css
/* ─── Light Mode ─── */
:root {
  /* Surfaces */
  --s-surface-page: var(--p-neutral-50);
  --s-surface-card: var(--p-white);
  --s-surface-elevated: var(--p-white);
  --s-surface-overlay: var(--p-white);
  --s-surface-inset: var(--p-neutral-100);

  /* Text */
  --s-text-primary: var(--p-neutral-900);
  --s-text-secondary: var(--p-neutral-500);
  --s-text-tertiary: var(--p-neutral-400);
  --s-text-inverse: var(--p-neutral-50);
  --s-text-link: var(--p-blue);
  --s-text-on-accent: var(--p-white);

  /* Borders */
  --s-border-default: var(--p-neutral-200);
  --s-border-subtle: var(--p-neutral-100);
  --s-border-emphasis: var(--p-neutral-300);

  /* Accent */
  --s-accent-primary: var(--p-frost-blue);

  /* Severity (status colors — same in both themes) */
  --s-severity-healthy: var(--p-green);
  --s-severity-warning: var(--p-amber);
  --s-severity-caution: var(--p-orange);
  --s-severity-critical: var(--p-red);
  --s-severity-positive: var(--p-green);
  --s-severity-negative: var(--p-red);

  /* PSI Bands */
  --s-psi-bedrock: var(--p-green);
  --s-psi-steady: var(--p-teal);
  --s-psi-tremor: var(--p-yellow);
  --s-psi-fracture: var(--p-orange);
  --s-psi-crisis: var(--p-red);
  --s-psi-meltdown: var(--p-red-dark);

  /* Interactive */
  --s-interactive-hover: var(--p-neutral-100);
  --s-interactive-active: var(--p-neutral-200);
  --s-interactive-focus-ring: var(--p-blue);
}

/* ─── Dark Mode ─── */
.dark {
  /* Surfaces */
  --s-surface-page: var(--p-blue-gray-950);
  --s-surface-card: var(--p-blue-gray-900);
  --s-surface-elevated: var(--p-blue-gray-800);
  --s-surface-overlay: var(--p-blue-gray-800);
  --s-surface-inset: var(--p-blue-gray-950);

  /* Text */
  --s-text-primary: var(--p-neutral-50);
  --s-text-secondary: var(--p-neutral-300);
  --s-text-tertiary: var(--p-neutral-400);
  --s-text-inverse: var(--p-neutral-900);

  /* Borders */
  --s-border-default: oklch(1 0 0 / 12%);
  --s-border-subtle: oklch(1 0 0 / 6%);
  --s-border-emphasis: oklch(1 0 0 / 20%);

  /* Interactive */
  --s-interactive-hover: var(--p-blue-gray-800);
  --s-interactive-active: var(--p-blue-gray-700);
}
```

#### Layer 3: Component Tokens (Optional)

Component-specific tokens can be added as needed:

```css
:root {
  --c-card-padding: var(--p-space-4);
  --c-card-radius: var(--p-radius-lg);
  --c-card-gap: var(--p-space-4);

  --c-table-row-height: 2.25rem;  /* 36px */
  --c-table-cell-padding-x: var(--p-space-2);
  --c-table-cell-padding-y: var(--p-space-1.5);

  --c-chart-grid-opacity: 0.06;
  --c-chart-fill-opacity: 0.2;
  --c-chart-height-sm: 250px;
  --c-chart-height-lg: 350px;

  --c-sidebar-width-collapsed: 56px;
  --c-sidebar-width-expanded: 220px;
}
```

#### Migration Path

1. Create the token files
2. Import them in `globals.css` (before the existing variable definitions)
3. **Gradually** map existing `--background`, `--card`, etc. variables to semantic tokens:
   ```css
   .dark {
     --background: var(--s-surface-page);
     --card: var(--s-surface-card);
     --foreground: var(--s-text-primary);
     --muted-foreground: var(--s-text-secondary);
     --border: var(--s-border-default);
   }
   ```
4. Existing components continue working through the existing variables
5. New components can reference semantic tokens directly
6. Over time, migrate old components from raw variables to semantic tokens

#### Documentation

**New file: `docs/design-tokens.md`**

Document all three layers with:
- Visual color swatches (hex approximations for quick reference)
- Spacing scale with visual ruler
- Typography hierarchy with example text
- When to use each semantic token
- Examples of correct and incorrect usage

### Files Affected

| File | Change |
|------|--------|
| `src/styles/tokens/primitives.css` | **NEW** |
| `src/styles/tokens/semantic.css` | **NEW** |
| `src/app/globals.css` | Import token files, map existing variables to semantic tokens |
| `docs/design-tokens.md` | **NEW** — documentation |
| `src/lib/chart-colors.ts` | Migrate hex values to CSS variable references |
| `src/lib/severity-colors.ts` | Migrate hex values to CSS variable references |
| `src/components/psi-history-chart.tsx` | BAND_ZONES colors → semantic tokens |

### Effort Estimate

- Token file creation: 1-2 days
- Migration of globals.css: 1 day
- Component migration (gradual): 1-2 weeks
- Documentation: 1 day
- Total: ~2-3 weeks for full migration

---

## 3.2 Virtual Scrolling for Main Table

### Problem

The stablecoin table paginates at 25 items per page, requiring 6 pages to see all 141 coins. This forces users to paginate to find coins ranked 26+. Professional analytics tools (DefiLlama, Token Terminal) use virtualized scrolling to show all rows with instant access.

### Design

Replace pagination with **windowed virtual scrolling** using `@tanstack/react-virtual`.

#### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Library | `@tanstack/react-virtual` | DefiLlama uses it; lightweight, well-maintained, works with `<table>` |
| Row height | Fixed 36px | Consistent height enables efficient virtualization |
| Overscan | 10 rows | Smooth scrolling without visible blank space |
| Container height | `max-h-[70vh]` | Fills most of the viewport, scrollable within the container |
| Keep search/filter | Yes | Filtering still reduces the visible set |
| Keep sorting | Yes | Sort happens on the full dataset before virtualization |
| Remove pagination | Yes | No longer needed |

#### Implementation

**File: `src/components/stablecoin-table.tsx`**

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

// ... inside component:
const parentRef = useRef<HTMLDivElement>(null);

const rowVirtualizer = useVirtualizer({
  count: sortedData.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 36,  // fixed row height
  overscan: 10,
});

return (
  <div
    ref={parentRef}
    className="overflow-auto max-h-[70vh] rounded-lg border"
  >
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
        {/* existing header row */}
      </thead>
      <tbody
        style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
      >
        {rowVirtualizer.getVirtualItems().map(virtualRow => {
          const row = sortedData[virtualRow.index];
          return (
            <tr
              key={row.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="border-b hover:bg-muted/30 transition-colors"
            >
              {/* existing cells */}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
```

#### Scroll Indicator

Add a subtle scroll position indicator (total rows + current range):

```tsx
<div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground border-t">
  <span>Showing {visibleRange.start + 1}-{visibleRange.end + 1} of {sortedData.length}</span>
  <span>Scroll to see all</span>
</div>
```

#### Mobile Considerations

On mobile, the container height may need to be `max-h-[50vh]` to leave room for the filter bar and header. Use a responsive class: `max-h-[50vh] sm:max-h-[70vh]`.

### Files Affected

| File | Change |
|------|--------|
| `src/components/stablecoin-table.tsx` | Replace pagination with virtual scrolling |
| `src/components/table-pagination.tsx` | Can be removed or kept for other tables |
| `package.json` | Add `@tanstack/react-virtual` (if not already present) |

### Effort Estimate

- Core implementation: 2-3 days
- Testing across browsers and viewport sizes: 1-2 days
- Mobile refinement: 1 day
- Total: ~1 week

---

## 3.3 Custom Visualization Components

### Problem

Pharos uses standard Recharts components (AreaChart, RadarChart, BarChart). While functional, these don't create visual distinctiveness. The peg deviation heatmap is the one custom visualization and it's the most praised element.

### Design

Build 3 custom visualizations that leverage Pharos' unique data and create visual moats:

#### 3.3a — Animated Peg Gauge

A real-time gauge visualization for the stablecoin detail page showing current peg position:

```
        ◠◡◠◡◠◡◠
      ╱              ╲
    ╱   🔴          🟢  ╲
   │  DEPEGGED    AT PEG  │
   │        ▲ 0.9987       │
   │     (−13 bps)         │
    ╲                    ╱
      ╲              ╱
        ◡◠◡◠◡◠◡
```

Implementation:
- Custom SVG component with arc path
- Needle position maps to peg deviation (center = 1.000, left = depegged, right = over-pegged)
- Color gradient along the arc: red → amber → green → amber → red
- Smooth CSS animation when value updates
- Below the gauge: numeric readout with deviation in bps
- Tooltip on hover: "Last updated: 2 min ago"

Use cases:
- Stablecoin detail page (hero metric position, replacing or augmenting the current score cards)
- Homepage KPI bar (miniature version, 40px wide)

#### 3.3b — Reserve Composition Treemap

For stablecoins with known collateral composition, show a treemap breaking down the backing:

```
┌─────────────────────────────────────────┐
│                                         │
│         US Treasuries (62%)             │
│                                         │
├────────────────────┬────────────────────┤
│  Reverse Repo (18%)│  Bank Deposits (8%)│
│                    │                    │
├────────────────────┼──────┬─────────────┤
│  Commercial Paper  │ Cash │   Other     │
│  (7%)              │ (3%) │   (2%)      │
└────────────────────┴──────┴─────────────┘
```

Implementation:
- Use `d3-hierarchy` (or Recharts' `Treemap`) for layout calculation
- Each cell colored by risk tier (green for treasuries, blue for bank deposits, amber for commercial paper)
- Hover shows exact value and percentage
- Data source: manual collateral breakdown per coin in `StablecoinMeta`

Use cases:
- Stablecoin detail page (new "Reserves" section)
- Compare page (side-by-side treemaps for selected coins)

#### 3.3c — Contagion Network Graph

A force-directed graph showing dependency relationships between stablecoins:

```
         USDC ──────── DAI
        ╱    ╲        ╱   ╲
     FRAX    sDAI   LUSD   BOLD
       │             │
     crvUSD        pyUSD
```

Implementation:
- Use `d3-force` for physics simulation (or a lighter library like `react-force-graph`)
- Nodes = stablecoins, sized by market cap
- Edges = dependency relationships (from the existing dependency dimension in report cards)
- Node color = report card grade
- Edge thickness = dependency weight
- Click a node → navigates to detail page
- Drag nodes to rearrange
- Zoom and pan with mouse/touch

Data source: Already available in the report card dependency data. The contagion map page already exists conceptually in Risk Lab — this adds the visualization.

Use cases:
- Dedicated Contagion Map page (under Risk Lab)
- Stress test visualization (highlight affected nodes when a coin is stressed)

### Files Affected

| Component | New Files |
|-----------|----------|
| Peg Gauge | `src/components/peg-gauge.tsx` |
| Treemap | `src/components/reserve-treemap.tsx` |
| Network Graph | `src/components/contagion-graph.tsx` |

### Dependencies

| Component | Library |
|-----------|---------|
| Peg Gauge | None (pure SVG + CSS animations) |
| Treemap | `recharts` (already installed) or `d3-hierarchy` |
| Network Graph | `d3-force` + custom SVG rendering, or `react-force-graph-2d` |

### Effort Estimate

- Peg Gauge: 3-4 days (SVG design + animation + responsive)
- Treemap: 3-5 days (layout algorithm + data integration + interaction)
- Network Graph: 1-2 weeks (force simulation + interactivity + performance with 141 nodes)
- Total: ~3-4 weeks

---

## 3.4 Display Typeface Addition

### Problem

Pharos uses Geist Sans for everything — from hero headings to badge labels. This works but doesn't create the typographic hierarchy seen in competitors:

| Platform | Display Font | Body Font | Data Font |
|----------|-------------|-----------|-----------|
| Nansen | Kuniforma 70 (600w, 56px) | Inter | IBM Plex Mono |
| Token Terminal | Denton (serif, 400w) | GeistSans | GeistMono |
| Artemis | Geist (700w) | Inter | Roboto Mono |
| **Pharos** | Geist Sans (700w) | Geist Sans | Geist Mono |

### Design

Add a **display typeface** for page titles and hero text only. Two options:

#### Option A: PP Neue Montreal (used by Artemis)

- Geometric sans-serif with wider letter spacing
- Available on Google Fonts or Fontshare
- Pairs well with Geist Sans (complementary but distinct)
- Use at: page titles (`h1`), hero text, large KPI numbers in the KPI bar

#### Option B: Instrument Serif (Google Fonts)

- Elegant serif with high contrast
- Perfect for the editorial personality (Daily Digest, AI summaries)
- Use at: Daily Digest header, page titles, "About Pharos" text
- Creates a "financial publication" aesthetic (like The Financial Times or Bloomberg)

#### Option C: Geist Sans at higher weight contrast (no new font)

- Use weight 700-800 and 40-48px for display text
- Use weight 400-500 and 14-16px for body text
- This maximizes the existing font's hierarchy without loading another font
- Simplest option with lowest risk

#### Recommended: Option C first, Option B later

Start with maximizing Geist Sans weight/size contrast (zero added weight, zero risk). If the editorial personality warrants it, add Instrument Serif for the Daily Digest and About page to create a "data platform with editorial soul" identity.

### Implementation (Option C — weight contrast)

**File: `src/app/page.tsx`** and all page titles:

```tsx
/* Current */
<h1 className="text-4xl font-bold tracking-tight">

/* Proposed — heavier weight, tighter tracking */
<h1 className="text-4xl font-extrabold tracking-tighter">
```

**File: `src/components/kpi-bar.tsx`** (if implemented from Tier 2):

```tsx
/* Large KPI values */
<span className="text-3xl font-extrabold font-mono tabular-nums tracking-tight">
```

### Implementation (Option B — add Instrument Serif)

**File: `src/app/layout.tsx`**

```tsx
import { Instrument_Serif } from 'next/font/google';

const instrumentSerif = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

// Add to <body> className:
<body className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}>
```

**File: `src/app/globals.css`**

```css
@theme inline {
  --font-display: var(--font-display);
}
```

**Usage in components:**

```tsx
/* Page titles with display serif */
<h1 className="font-display text-4xl tracking-tight">Shining a Light on Every Peg</h1>

/* Daily Digest header */
<span className="font-display text-lg tracking-wide">Signal & Noise</span>
```

### Files Affected

| File | Change |
|------|--------|
| `src/app/layout.tsx` | Load display font (if adding new font) |
| `src/app/globals.css` | Register font variable |
| All page `h1` elements | Apply `font-display` or increased weight |

### Effort Estimate

- Option C (weight contrast only): 1 day
- Option B (add serif font): 2-3 days
- Total: 1-3 days

---

## 3.5 Persistent User Preferences

### Problem

Every visit to Pharos starts from scratch — no saved column preferences, no favorite coins, no default time ranges, no preferred sort order. Power users (the target audience) want to configure their view once and have it persist.

### Design

Implement a `localStorage`-based preference system covering:

#### 3.5a — Table Column Visibility

```tsx
interface TablePreferences {
  visibleColumns: string[];  // ['rank', 'name', 'price', 'mcap', ...]
  sortKey: string;
  sortDirection: 'asc' | 'desc';
  pageSize: number;  // if keeping pagination
}
```

**Storage key:** `pharos:table-prefs`

UI: Add a "Columns" dropdown button in the filter bar:

```
[Search...] [Filter toggles...] [Columns ▼] [CSV ↓]
                                      │
                                 ┌────┴────────┐
                                 │ ☑ Rank      │
                                 │ ☑ Name      │
                                 │ ☑ Price     │
                                 │ ☑ Peg       │
                                 │ ☑ Market Cap│
                                 │ ☑ 24h       │
                                 │ ☐ 7d        │
                                 │ ☑ Grade     │
                                 │ ☐ Backing   │
                                 │ ☐ Governance│
                                 │ ☑ Peg Score │
                                 │ ☑ Liquidity │
                                 │─────────────│
                                 │ Reset       │
                                 └─────────────┘
```

#### 3.5b — Favorite Coins (Watchlist)

REMOVED, REASON = REFUSED. NO USER PREFERENCE TO BE STORED, NO WALLET, NO EMAIL: PURE INFORMATION.

#### 3.5c — Default Time Ranges

REMOVED, REASON = REFUSED. NO USER PREFERENCE TO BE STORED, NO WALLET, NO EMAIL: PURE INFORMATION.

#### 3.5d — Sidebar State

Already proposed in Tier 2.1 — collapsed/expanded preference stored in `localStorage`.

#### Hook Implementation

**New file: `src/hooks/use-preferences.ts`**

```tsx
function usePreference<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const stored = localStorage.getItem(`pharos:${key}`);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setAndPersist = useCallback((newValue: T) => {
    setValue(newValue);
    localStorage.setItem(`pharos:${key}`, JSON.stringify(newValue));
  }, [key]);

  return [value, setAndPersist];
}
```

### Files Affected

| File | Change |
|------|--------|
| `src/hooks/use-preferences.ts` | **NEW** — generic preference hook |
| `src/components/stablecoin-table.tsx` | Column visibility toggle, watchlist stars |
| `src/components/filter-bar.tsx` | "Columns" dropdown button |
| `src/components/time-range-buttons.tsx` | "Set as default" option |
| `src/components/sidebar.tsx` | Sidebar collapse state (if Tier 2.1 implemented) |

### Effort Estimate

- Preference hook: 1 day
- Column visibility: 2-3 days
- Watchlist: 2-3 days (star UI + filter/sort by favorites)
- Time range default: 1 day
- Total: ~1.5-2 weeks

---

## 3.6 Light Mode Polish

### Problem

Pharos offers a theme toggle but the light mode has not been audited with the same rigor as dark mode. Given that the entire competitive landscape defaults to dark mode, light mode is a secondary priority — but it should not be embarrassingly bad if a user toggles to it.

### Design

#### Audit Checklist

| Area | What to Check |
|------|--------------|
| Backgrounds | Page bg (`oklch(0.98)`) and card bg (`oklch(1)`) — sufficient contrast? |
| Text | Primary text (`oklch(0.145)`) on white cards — is it too black? Should be `oklch(0.20-0.25)` |
| Borders | `oklch(0.922)` — visible enough? |
| Charts | Do chart fills look good on white backgrounds? (opacity may need to increase to 0.3) |
| Heatmap tiles | Do the severity background colors (green/amber/orange/red at `/10` opacity) have enough contrast on white? |
| Badges | Classification badge colors at `/10` opacity — readable on white? |
| PSI bands | Do the reference area fills show clearly on a white chart background? |
| Sidebar | (if implemented) Does the sidebar look distinct from the content area? |
| Shadows | `shadow-sm` is appropriate for light mode — no change needed |

#### Known Issues to Fix

1. **Chart grid lines** may be invisible on white if `stroke="var(--color-border)"` is too light in light mode
2. **The PSI band fills** at 0.05 opacity may disappear on white — increase to 0.1 for light mode
3. **The pharos-pulse loader** uses `frost-blue/30` which may look washed out on white
4. **Card elevation** — cards need `shadow-sm` or `shadow` in light mode (currently set but verify)

#### Implementation

Most fixes are CSS variable adjustments in the `:root` (light mode) block of `globals.css`. A few may require conditional rendering:

```css
/* Light mode specific adjustments */
:root {
  --chart-grid-opacity: 0.1;   /* slightly more visible on white */
  --chart-fill-opacity: 0.25;  /* slightly more opaque on white */
}
.dark {
  --chart-grid-opacity: 0.06;
  --chart-fill-opacity: 0.2;
}
```

These variables would be referenced in chart components:

```tsx
<CartesianGrid opacity="var(--chart-grid-opacity)" />
```

Note: Recharts may not accept CSS variables for numeric props. If so, use a JavaScript-based approach:

```tsx
const isDark = useTheme() === 'dark';
const gridOpacity = isDark ? 0.06 : 0.1;
```

### Files Affected

| File | Change |
|------|--------|
| `src/app/globals.css` | Light mode variable adjustments |
| Chart components | Theme-aware opacity values |

### Effort Estimate

- Audit: 1 day
- Fixes: 2-4 days
- Total: 3-5 days

---

## 3.7 Accessibility Audit & Remediation

### Problem

Pharos has above-average accessibility (skip links, aria-sort, keyboard nav, focus-visible, reduced-motion). However, two gaps remain:

1. **Color-only encoding.** Severity indicators (green/amber/orange/red) rely entirely on color. Users with color vision deficiency (8% of males) cannot distinguish the tiers.
2. **Chart data inaccessibility.** Charts are SVG images with no textual fallback. Screen readers announce nothing about the data.

### Design

#### 3.7a — Non-Color Severity Indicators

Add secondary visual cues to color-coded elements:

| Tier | Color | Additional Indicator |
|------|-------|---------------------|
| Healthy (<50bps) | Green | `●` (filled dot) or `✓` checkmark |
| Mild (50-200bps) | Amber | `◐` (half dot) or `⚠` caution |
| Moderate (200-500bps) | Orange | `◑` (quarter dot) or `△` triangle |
| Severe (≥500bps) | Red | `○` (empty dot) or `✕` cross |

Implementation options:

1. **Icons alongside text** — Add a tiny Lucide icon (CheckCircle, AlertTriangle, XCircle) next to the color-coded number
2. **Shape markers in charts** — Use different point shapes (circle, square, triangle, diamond) for different severity tiers
3. **Pattern fills in heatmap tiles** — Add subtle patterns (diagonal lines for amber, dots for orange, crosshatch for red) to peg heatmap backgrounds

Recommended: Option 1 (icons alongside text) is the lowest-effort and highest-impact change.

**File: `src/lib/severity-colors.ts`**

Add icon mappings alongside color mappings:

```tsx
import { CheckCircle, AlertTriangle, AlertOctagon, XCircle } from 'lucide-react';

export const SEVERITY_ICONS = {
  green: CheckCircle,
  amber: AlertTriangle,
  orange: AlertOctagon,
  red: XCircle,
} as const;

export function deviationIcon(absBps: number) {
  if (absBps < 50) return SEVERITY_ICONS.green;
  if (absBps < 200) return SEVERITY_ICONS.amber;
  if (absBps < 500) return SEVERITY_ICONS.orange;
  return SEVERITY_ICONS.red;
}
```

Components to update:
- `src/components/stablecoin-table.tsx` — peg deviation column
- `src/components/peg-heatmap.tsx` — tile severity
- `src/components/peg-leaderboard.tsx` — deviation column

#### 3.7b — Chart Data Tables

For each chart, provide a hidden data table that screen readers can access:

```tsx
<div className="sr-only">
  <table>
    <caption>Market Cap history, last 30 days</caption>
    <thead><tr><th>Date</th><th>Market Cap</th></tr></thead>
    <tbody>
      {data.map(d => (
        <tr key={d.ts}>
          <td>{formatDate(d.ts)}</td>
          <td>{formatCurrency(d.mcap)}</td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

This is a large data dump, so limit to a summary for long datasets:

```tsx
// For datasets > 30 points, show summary instead
<div className="sr-only" role="img" aria-label={
  `Market cap chart. Current: ${formatCurrency(latest)}. ` +
  `30-day high: ${formatCurrency(high)}. ` +
  `30-day low: ${formatCurrency(low)}. ` +
  `Trend: ${trend > 0 ? 'up' : 'down'} ${formatPercent(Math.abs(trend))}.`
}>
</div>
```

#### 3.7c — ARIA Live Regions for Data Updates

When live data updates (PSI score changes, new depeg event), announce it to screen readers:

```tsx
<div aria-live="polite" className="sr-only">
  {newDepeg && `New depeg event: ${newDepeg.symbol} is at ${newDepeg.deviation} basis points`}
</div>
```

Add to:
- PSI score widget (when score changes)
- Peg Tracker stats (when active depegs count changes)
- Blacklist feed (when new event arrives)

### Files Affected

| File | Change |
|------|--------|
| `src/lib/severity-colors.ts` | Add icon mappings |
| Table/heatmap components | Add severity icons alongside colors |
| Chart components | Add sr-only data summaries |
| `src/components/stability-index.tsx` | Add aria-live region |
| `src/components/peg-tracker-stats.tsx` | Add aria-live region |

### Effort Estimate

- Severity icons: 2-3 days
- Chart accessibility: 2-3 days
- ARIA live regions: 1 day
- Total: ~1 week

---

## Implementation Priority

Within Tier 3, prioritize by impact-to-effort ratio:

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 1 | 3.4 Display typeface (Option C) | 1 day | Immediate visual hierarchy improvement |
| 2 | 3.1 Design token system | 2-3 weeks | Foundation for all future work, prevents quality regression |
| 3 | 3.5 User preferences | 1.5-2 weeks | Stickiness and power-user satisfaction |
| 4 | 3.7 Accessibility | 1 week | Institutional credibility, inclusive design |
| 5 | 3.2 Virtual scrolling | 1 week | Professional data handling |
| 6 | 3.6 Light mode polish | 3-5 days | Secondary priority but prevents embarrassment |
| 7 | 3.3 Custom visualizations | 3-4 weeks | High differentiation but highest effort |

Items 1-4 can be started immediately after Tier 2 completes.
Items 5-7 can be deferred and tackled based on user feedback and team capacity.
