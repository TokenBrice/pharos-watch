# Design Overhaul — Tier 1: Quick Wins

**Date:** 2026-02-26
**Status:** Draft
**Effort:** 1-3 days total
**Impact:** Immediately elevates perceived quality from "excellent side project" to "professional analytics platform"

## Overview

These changes require no structural refactoring — only CSS variable tweaks, Tailwind class updates, and minor component-level styling adjustments. They target the gap between Pharos' current 8.3/10 polish and the 9+ tier occupied by DefiLlama, Token Terminal, and Nansen.

Every change listed below is grounded in a specific observed weakness from the live site audit and competitive benchmarking against 5 leading platforms.

---

## 1.1 Deepen Dark Mode Color Palette

### Problem

Pharos' dark mode background (`oklch(0.13 0.02 260)` ≈ `#1a1d24`) is noticeably lighter than every major competitor:

| Platform | Background | Hex Approx |
|----------|-----------|------------|
| Token Terminal | `hsl(0 0% 2.5%)` | `#0e0e11` |
| DefiLlama | `oklch(0.148 0.004 228.8)` | `#131517` |
| Artemis | — | `#13141A` |
| Nansen | — | `#061019` |
| **Pharos** | `oklch(0.13 0.02 260)` | **`#1a1d24`** |

The result: Pharos reads as "dark gray UI" rather than "professional terminal." The card-to-background contrast is also weak — card bg `oklch(0.18)` vs page bg `oklch(0.13)` is a lightness delta of only 0.05, making cards float indistinctly.

### Changes

**File: `src/app/globals.css`**

Update the `.dark` block:

```css
/* Current values → Proposed values */
--background: oklch(0.13 0.02 260);      → oklch(0.085 0.015 260);
--card: oklch(0.18 0.005 260);           → oklch(0.14 0.01 260);
--card-foreground: oklch(0.985 0 0);     → (unchanged)
--popover: oklch(0.18 0.005 260);        → oklch(0.14 0.01 260);
--secondary: oklch(0.24 0.02 260);       → oklch(0.20 0.015 260);
--muted: oklch(0.24 0.02 260);           → oklch(0.20 0.015 260);
--accent: oklch(0.24 0.02 260);          → oklch(0.20 0.015 260);
--border: oklch(1 0 0 / 8%);             → oklch(1 0 0 / 12%);
--input: oklch(1 0 0 / 15%);             → oklch(1 0 0 / 18%);
```

Also add a new `--surface-raised` token for tooltips, dropdowns, and modals that need a third elevation level:

```css
--surface-raised: oklch(0.22 0.01 260);
```

Wire `--surface-raised` into the theme block at the top of the file:

```css
--color-surface-raised: var(--surface-raised);
```

Light mode values stay unchanged.

### Rationale

- Background drops from lightness 0.13 to 0.085, matching the DefiLlama/Artemis range
- Card-to-background delta increases from 0.05 to 0.055, and the absolute values are darker so the contrast is more perceptible
- Border opacity increases from 8% to 12%, making structural boundaries visible without being heavy
- The blue hue angle (260) is preserved for brand consistency with the frost-blue accent

### Verification

- `npm run build` passes
- Toggle dark mode in browser: cards should be visibly distinct from the background
- Borders around cards, table rows, and inputs should be faintly visible (not invisible)
- All text should remain readable (check `muted-foreground` against new `--card` and `--background`)

---

## 1.2 Reduce Border Radius for Financial Credibility

### Problem

Pharos uses `--radius: 0.625rem` (10px base), which generates `rounded-xl` = 14px on cards. This is rounded enough to read as a "consumer mobile app" rather than a "financial data terminal."

Competitor comparison:
- DefiLlama: 6-8px card radius
- Token Terminal: 6px
- Nansen: 8px
- Dune: 8px
- Artemis: 6-8px

### Changes

**File: `src/app/globals.css`**

```css
/* Current */
:root {
  --radius: 0.625rem;  /* 10px */
}

/* Proposed */
:root {
  --radius: 0.5rem;  /* 8px */
}
```

This cascades through the entire component library because all radii are derived:
- `--radius-sm`: 4px (was 6px)
- `--radius-md`: 6px (was 8px)
- `--radius-lg`: 8px (was 10px) — this is what `rounded-lg` uses
- `--radius-xl`: 12px (was 14px) — this is what `rounded-xl` uses
- `--radius-2xl`: 16px (was 18px)

Additionally, the McapChart and other chart cards explicitly use `rounded-2xl` overrides:

**File: `src/components/mcap-chart.tsx`** (line 48)
```
<Card className="rounded-2xl border-l-[3px] border-l-blue-500">
```

Change `rounded-2xl` → `rounded-xl` on all chart cards. Grep for `rounded-2xl` and `rounded-3xl` in all card contexts and reduce by one step.

**Files to update:**
- `src/components/mcap-chart.tsx` — `rounded-2xl` → `rounded-xl`
- `src/components/total-mcap-chart.tsx` — check for `rounded-2xl`
- `src/components/psi-history-chart.tsx` — check for `rounded-2xl`
- Any other component using `rounded-2xl` or larger on Card elements

### Rationale

Reducing from 10px to 8px base aligns with the industry standard while preserving enough softness to avoid looking harsh. The derived values all shift proportionally, maintaining internal consistency.

### Verification

- Visual check: cards should look slightly more angular/professional, not aggressively square
- Badges (`rounded-full`) are NOT affected — they stay circular
- Buttons stay at `rounded-md` (6px), which is appropriate

---

## 1.3 Tighten Card Padding

### Problem

Cards use `py-6 px-6` (24px all around) and `CardContent` adds another `px-6`. This is generous — too generous for a data-dense analytics tool. It wastes vertical space that could show more data above the fold.

Competitor comparison:
- DefiLlama: `p-3` (12px) on cards
- Token Terminal: 12-16px padding
- Nansen: 16px padding
- Artemis: 12px padding

### Changes

**File: `src/components/ui/card.tsx`**

This is a shadcn component, but it must be updated since the default padding is too generous.

```tsx
// Card: change py-6 → py-4
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4 shadow-sm",
        //                                         gap-6→gap-4        py-6→py-4
        className
      )}
      {...props}
    />
  )
}

// CardHeader: px-6 → px-4, pb adjustment
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4",
        //                                                                        gap-2→gap-1.5 px-6→px-4                                                      pb-6→pb-4
        className
      )}
      {...props}
    />
  )
}

// CardContent: px-6 → px-4
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4", className)}
      //              px-6→px-4
      {...props}
    />
  )
}

// CardFooter: px-6 → px-4
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-4 [.border-t]:pt-4", className)}
      //                              px-6→px-4        pt-6→pt-4
      {...props}
    />
  )
}
```

### Impact Assessment

This affects every card in the application. Most will simply become more compact, which is desired. However, review these specific cases where the denser spacing might cause visual crowding:

- **Report card detail** (`src/components/report-card.tsx`) — the radar chart inside a card may need explicit height adjustment
- **KPI stat cards** on Peg Tracker and homepage — verify large numbers still breathe
- **Feature summary cards** on the homepage — check text truncation

### Verification

- Build and visually scan every page
- Ensure no text/element clipping in tight cards
- KPI cards should still be readable but more compact
- Chart cards should retain their chart height (the chart `h-[250px]` is explicit, not padding-dependent)

---

## 1.4 Replace Table Row Striping with Subtle Row Borders

### Problem

The current table styling uses alternating row backgrounds (`.table-striped tbody tr:nth-child(even) { bg-muted/30 }`). This is a dated pattern that:

1. Conflicts with color-coded cells (peg deviation, score colors) — the stripe competes with the semantic color
2. Creates visual noise on dense tables with 25+ rows
3. None of the 5 benchmarked competitors use striped rows — they all use subtle bottom borders

### Changes

**File: `src/app/globals.css`**

Remove the striped utility:

```css
/* DELETE or comment out: */
.table-striped tbody tr:nth-child(even) {
  @apply bg-muted/30;
}
```

The `TableRow` component in `src/components/ui/table.tsx` already has `border-b` on every row (line 60: `"hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors"`), so rows will still have visual separation.

**File: `src/components/ui/table.tsx`**

Adjust the hover opacity to be lighter now that there's no stripe competing:

```tsx
// TableRow: hover:bg-muted/50 → hover:bg-muted/30
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/30 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props}
    />
  )
}
```

**Files that apply `.table-striped`:**

Search the codebase for `table-striped` and remove the class from all table wrappers:

- `src/components/stablecoin-table.tsx` — look for `className` on the Table or wrapper div
- `src/components/peg-leaderboard.tsx` — same
- `src/components/blacklist-table.tsx` — same
- Any other table component using this class

The sticky header style in `globals.css` (`.table-header-sticky`) stays unchanged.

### Rationale

Row borders provide cleaner separation that doesn't interfere with semantic color coding. The lighter hover (`/30` instead of `/50`) is sufficient when there's no alternating stripe to compete with.

### Verification

- Tables should show faint horizontal lines between rows
- Hover highlights should be visible but subtle
- Color-coded peg deviation and score cells should be the dominant visual signal, not the row background
- Sticky headers should remain styled correctly (`bg-muted/80 backdrop-blur-sm`)

---

## 1.5 Increase Page Title Size

### Problem

Page titles use `text-3xl font-bold tracking-tight` (30px). This is undersized for a primary heading — it doesn't create enough contrast with the `text-lg` (18px) section headers below it, resulting in a flat hierarchy.

Competitor comparison:
- Nansen: 56px h1, weight 600
- DefiLlama: 36-40px page titles
- Token Terminal: 32-36px
- Artemis: 28-32px (denser layout compensates)

### Changes

**File: `src/app/page.tsx`** (line 37)

```tsx
/* Current */
<h1 className="text-3xl font-bold tracking-tight">Shining a Light on Every Peg</h1>

/* Proposed */
<h1 className="text-4xl font-bold tracking-tight">Shining a Light on Every Peg</h1>
```

Apply the same change to ALL page titles across the application:

| File | Current | Proposed |
|------|---------|----------|
| `src/app/page.tsx` | `text-3xl` | `text-4xl` |
| `src/app/peg-tracker/client.tsx` | Check current | `text-4xl` |
| `src/app/stability-index/client.tsx` | Check current | `text-4xl` |
| `src/app/risk-lab/page.tsx` | Check current | `text-4xl` |
| `src/app/blacklist/page.tsx` | Check current | `text-4xl` |
| `src/app/liquidity/page.tsx` | Check current | `text-4xl` |
| `src/app/cemetery/page.tsx` | Check current | `text-4xl` |
| `src/app/compare/page.tsx` | Check current | `text-4xl` |
| `src/app/about/page.tsx` | Check current | `text-4xl` |
| `src/app/digest/page.tsx` | Check current | `text-4xl` |
| `src/app/stablecoin/[id]/page.tsx` | Check current | `text-3xl` (keep slightly smaller for detail pages — the coin name is the title and can be long) |

Also ensure section headers (`h2`) use `text-xl font-semibold tracking-tight` (not `text-lg`) to maintain the hierarchy gap:

| Level | Current | Proposed |
|-------|---------|----------|
| Page title (h1) | `text-3xl` (30px) | `text-4xl` (36px) |
| Section header (h2) | `text-lg` (18px) | `text-xl` (20px) |
| Card title | `font-semibold` (16px) | unchanged |
| Label | `text-xs uppercase tracking-wider` | unchanged |

**File: `src/components/homepage-client.tsx`** (lines 79, 91)

```tsx
/* Current */
<h2 className="text-lg font-semibold tracking-tight mb-4">

/* Proposed */
<h2 className="text-xl font-semibold tracking-tight mb-4">
```

Apply to all `h2` section headers across the codebase (grep for `text-lg font-semibold`).

### Verification

- Page titles should be clearly dominant over section headers
- Section headers should be clearly dominant over card titles
- Detail page coin names (potentially long: "First Digital USD (FDUSD)") should not overflow

---

## 1.6 Refine Chart Styling

### Problem

Several chart styling parameters are slightly off from professional standards:

1. **Area fill opacity is too heavy.** The gradient starts at `stopOpacity={0.4}` which creates a dense, heavy block. Professional charts use 0.15-0.25.
2. **Grid lines are too prominent.** `strokeDasharray="3 3"` with default opacity creates visual noise.
3. **PSI band colors use hardcoded hex values** instead of CSS variables, creating a maintenance gap.

### Changes

#### 1.6a — Reduce area fill opacity

**Files: All chart components using `<Area>` with gradient fills:**

- `src/components/mcap-chart.tsx` (line 60)
- `src/components/total-mcap-chart.tsx`
- `src/components/psi-history-chart.tsx`
- `src/components/dex-liquidity-history-chart.tsx` (if exists)
- Any other `AreaChart` component

In each file, find the gradient `<stop>` elements:

```tsx
/* Current */
<stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.4} />
<stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />

/* Proposed */
<stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.2} />
<stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.02} />
```

#### 1.6b — Reduce grid line opacity

In each chart component, find `<CartesianGrid>`:

```tsx
/* Current (typical) */
<CartesianGrid strokeDasharray="3 3" opacity={0.1} />

/* Proposed */
<CartesianGrid strokeDasharray="3 3" opacity={0.06} stroke="var(--color-border)" />
```

If no explicit `opacity` is set, add `opacity={0.06}`. Also add `stroke="var(--color-border)"` to use the theme's border color instead of the default gray.

#### 1.6c — Move PSI band colors to CSS variables

**File: `src/components/psi-history-chart.tsx`** (lines 26-32)

```tsx
/* Current */
export const BAND_ZONES = [
  { y1: 90, y2: 100, color: "#22c55e", label: "BEDROCK" },
  { y1: 75, y2: 90, color: "#14b8a6", label: "STEADY" },
  { y1: 60, y2: 75, color: "#eab308", label: "TREMOR" },
  { y1: 40, y2: 60, color: "#f97316", label: "FRACTURE" },
  { y1: 20, y2: 40, color: "#ef4444", label: "CRISIS" },
  { y1: 0, y2: 20, color: "#991b1b", label: "MELTDOWN" },
];
```

Move these colors to `src/lib/chart-colors.ts`:

```tsx
/* Add to chart-colors.ts */
export const PSI_BAND_COLORS = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
} as const;
```

Update `psi-history-chart.tsx` to import from the central location:

```tsx
import { PSI_BAND_COLORS } from "@/lib/chart-colors";

export const BAND_ZONES = [
  { y1: 90, y2: 100, color: PSI_BAND_COLORS.BEDROCK, label: "BEDROCK" },
  // ... etc
];
```

### Verification

- Charts should look lighter, more airy, with the data line as the dominant visual
- Grid lines should be barely perceptible (visible on close inspection, not at a glance)
- PSI chart bands should render identically (only the source of the color values changes)

---

## 1.7 Add Tooltips to Abbreviated Column Headers

### Problem

The stablecoin table uses abbreviated column headers that are unclear to new users:

- "Liq" → Liquidity Score
- "Backing" → Backing Type
- "7d" → 7-Day Change
- "Peg Score" → no tooltip explaining what the score measures

### Changes

**File: `src/components/stablecoin-table.tsx`**

Add `title` attributes to all `<SortableTableHead>` or `<TableHead>` elements with abbreviated or domain-specific labels:

```tsx
<SortableTableHead
  sortKey="liquidity"
  title="DEX Liquidity Score (0-100): measures on-chain pool depth across decentralized exchanges"
  // ... existing props
>
  Liq
</SortableTableHead>
```

Full list of columns needing tooltips:

| Column | Display | Tooltip Text |
|--------|---------|-------------|
| Peg | Peg | "Current peg deviation from target price, in basis points" |
| 24h | 24h | "24-hour market cap change" |
| 7d | 7d | "7-day market cap change" |
| Stability | Stability | "Peg Stability Score (0-100): measures peg-holding consistency over 30 days" |
| Liq | Liq | "DEX Liquidity Score (0-100): measures on-chain pool depth" |
| Grade | Grade | "Pharos Safety Rating: composite grade across 5 dimensions" |
| Backing | Backing | "Collateral backing type: RWA, Crypto, Algorithmic, Hybrid, or N/A" |

**File: `src/components/sortable-table-head.tsx`**

Ensure the component passes `title` through to the underlying `<th>`:

```tsx
interface SortableTableHeadProps {
  title?: string;
  // ... existing props
}
```

### Verification

- Hover over any abbreviated column header → tooltip appears with full description
- Screen readers announce the title for accessibility
- No visual change to the table layout

---

## 1.8 Enforce Monospace Tabular Figures on All Numeric Contexts

### Problem

Numbers in cards and table cells correctly use `font-mono tabular-nums`, but several contexts miss this:

1. **Chart axis labels** — Recharts renders axis ticks with the default sans-serif font
2. **Chart tooltip values** — formatted numbers in tooltips use proportional figures
3. **Some KPI card values** — inconsistent application across different stat components
4. **PSI score on the homepage** — the large "96.3" may not use monospace

### Changes

#### 1.8a — Chart axis tick styling

**All chart components** — Add `tick` prop to `<XAxis>` and `<YAxis>`:

```tsx
<XAxis
  // ... existing props
  tick={{ fontSize: 12, fontFamily: "var(--font-mono)", fill: "var(--color-muted-foreground)" }}
/>
<YAxis
  // ... existing props
  tick={{ fontSize: 12, fontFamily: "var(--font-mono)", fill: "var(--color-muted-foreground)" }}
/>
```

Files to update:
- `src/components/mcap-chart.tsx`
- `src/components/total-mcap-chart.tsx`
- `src/components/psi-history-chart.tsx`
- `src/components/supply-chart.tsx` (if exists)
- `src/components/dex-liquidity-history-chart.tsx` (if exists)
- Any other Recharts component with axes

#### 1.8b — Chart tooltip text styling

**File: `src/lib/chart-colors.ts`**

Update the shared tooltip styles:

```tsx
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-lg, 0.5rem)",
    fontFamily: "var(--font-mono)",  // ADD
  },
  labelStyle: {
    color: "var(--color-foreground)",
    fontFamily: "var(--font-sans)",  // labels stay sans-serif
  },
  itemStyle: {
    color: "var(--color-muted-foreground)",
    fontFamily: "var(--font-mono)",  // ADD — numeric values in tooltips
  },
} as const;
```

#### 1.8c — Global audit

Grep for large numeric displays that might be missing `font-mono`:

```bash
grep -r "text-2xl\|text-3xl\|text-4xl" src/components/ --include="*.tsx" -l
```

For each file, check if the numeric value element has `font-mono tabular-nums`. If not, add it.

Common pattern to look for:

```tsx
/* Missing font-mono */
<span className="text-2xl font-bold">{formatCurrency(value)}</span>

/* Correct */
<span className="text-2xl font-bold font-mono tabular-nums">{formatCurrency(value)}</span>
```

### Verification

- Chart axis labels should use monospace font (visually distinct from body text)
- Numbers in tooltips should align cleanly (tabular figures prevent jitter)
- All large KPI numbers across the app should use the same monospace treatment

---

## Implementation Order

Execute in this order to minimize cascading rework:

1. **1.1 Dark mode colors** — foundational; changes the canvas everything sits on
2. **1.2 Border radius** — foundational; affects all components
3. **1.3 Card padding** — foundational; affects content spacing
4. **1.4 Table striping** — independent change
5. **1.5 Page title size** — independent change
6. **1.6 Chart styling** — independent change
7. **1.7 Column tooltips** — independent change
8. **1.8 Monospace enforcement** — independent change

Items 4-8 can be done in any order or in parallel.

## Risk Assessment

- **Risk of 1.1 (colors):** Low — if the new background is too dark, the lightness values can be fine-tuned. Start with the proposed values and adjust by ±0.01 until satisfied.
- **Risk of 1.2 (radius):** Very low — purely cosmetic, fully reversible by changing one CSS variable.
- **Risk of 1.3 (padding):** Medium — some card content may need per-component padding overrides if the compact padding causes crowding. The report card radar chart inside a card is the most likely candidate.
- **Risk of 1.4 (striping):** Low — removing striping is purely cosmetic. If the new look feels too sparse, the hover effect opacity can be increased.
- **Risk of 1.5-1.8:** Very low — isolated changes with no cascade effects.
