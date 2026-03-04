# Design Language Reference

Pharos follows a **dark financial terminal** aesthetic — data-dense and serious, softened by modern rounded cards, subtle gradients, and colored accent borders. Every colored element communicates meaning; decoration is minimal.

This doc codifies the patterns already established in the codebase. For the **token system** (CSS custom properties, color scales, hex companions), see [`design-tokens.md`](design-tokens.md).

---

## Typography

### Hierarchy

| Role | Classes | Notes |
|------|---------|-------|
| **Page title (h1)** | `text-4xl font-extrabold tracking-tighter` | All main pages. Detail sub-pages use `text-2xl`. |
| **Section header (h2)** | `text-xl font-semibold tracking-tight` | Major sections within a page. |
| **Subsection header (h3)** | `text-foreground font-medium` | No explicit size class (inherits base). |
| **Card label** | `text-xs font-semibold uppercase tracking-wider text-muted-foreground` | KPI labels, card headers, table column labels. The signature Pharos "small caps" style. |
| **Body text** | `text-sm text-muted-foreground` | Descriptions, subtitles, paragraphs. Add `leading-relaxed` for longer prose. |
| **AI editorial** | `text-[1.1rem] leading-relaxed text-foreground/90 italic` + Georgia serif | Distinctive serif treatment for AI-generated summaries. |

### Fonts

- **Sans-serif** — default for all UI text.
- **Monospace (`font-mono`)** — reserved for numbers and technical values: prices, market caps, percentages, scores, timestamps. Always pair with `tabular-nums` when values need columnar alignment (tables, stat rows).
- **Serif** — only for AI editorial summaries (inline `fontFamily: Georgia`).

### Text Colors

| Purpose | Class |
|---------|-------|
| Primary | `text-foreground` |
| Secondary | `text-muted-foreground` |
| Slightly muted | `text-foreground/80` or `text-foreground/90` |
| Very muted | `text-muted-foreground/70` |
| Disclaimer | `text-muted-foreground/50` |
| Positive | `text-green-500` |
| Negative | `text-red-500` |
| Warning | `text-amber-500` |
| Link accent | `text-sky-500` (hover on inline links) |

### Links

- **Inline links:** `text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors`
- **Muted links:** `text-muted-foreground hover:text-foreground transition-colors` (footer, nav)
- **Button-style links:** `inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors`

---

## Spacing & Layout

### Page Structure

Every page follows this hierarchy:

```
<main className="container mx-auto px-4 py-6 lg:px-6">   ← from layout.tsx
  <div className="space-y-6">                              ← page wrapper
    <div className="space-y-2">                            ← title block
      <h1>Page Title</h1>
      <p>Subtitle</p>
    </div>
    {/* sections */}
  </div>
</main>
```

### Vertical Spacing Scale

| Context | Class | Value |
|---------|-------|-------|
| Between page sections | `space-y-6` | 24px |
| About page (extra breathing room) | `space-y-8` | 32px |
| Within card content | `space-y-4` | 16px |
| Within subsections | `space-y-3` | 12px |
| Title + subtitle groups | `space-y-2` | 8px |
| Dense list items | `space-y-2.5` or `space-y-1` | 10px / 4px |

### Grids

**Stat card grids** use a consistent responsive pattern:

```
grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-{3|4|5|6}
```

- Mobile: always 2 columns.
- Gap: `gap-3` on mobile, `sm:gap-5` on tablet+.
- Desktop: expand to 3–6 columns depending on content density.

**Content grids** (features, info cards):

```
grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5
```

**Feed/event grids** (lower density):

```
grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-1.5
```

### Responsive Breakpoints

| Breakpoint | Usage |
|------------|-------|
| `sm:` (640px) | Gap increases, minor layout tweaks |
| `md:` (768px) | Flex direction changes (`flex-col → flex-row`), sidebar visible |
| `lg:` (1024px) | Grid column expansion, main content padding increase (`px-6`) |
| `xl:` (1280px) | Rare — only for 6-column stat grids |

---

## Shared Utilities

For consistency across custom components, use the global utility classes in `globals.css`:

| Utility | Purpose |
|---------|---------|
| `pharos-kicker` | Canonical tiny uppercase label style (`11px`, semi-bold, tracked) for card labels and section kickers |
| `pharos-focus-ring` | Standard focus-visible ring (`ring-2`, `ring-ring/60`, offset) for links/buttons outside shadcn primitives |
| `pharos-card-shell` | Shared card-like shell (`rounded-xl`, themed border, themed background) for custom containers |
| `pharos-interactive-card` | Restrained hover/transition treatment for interactive cards |

Prefer these over rewriting similar class strings in each component.

---

## Cards

### Structure

Always use the shadcn `Card` component hierarchy:

```tsx
<Card>
  <CardHeader className="pb-1">         {/* pb-1 or pb-2 to tighten */}
    <CardTitle as="h2">{label}</CardTitle>
  </CardHeader>
  <CardContent>
    {/* content */}
  </CardContent>
</Card>
```

Use `CardAction` for top-right actions (time range buttons, export buttons):

```tsx
<Card>
  <CardHeader>
    <CardTitle>Chart Title</CardTitle>
    <CardAction>
      <TimeRangeButtons ... />
    </CardAction>
  </CardHeader>
  <CardContent>...</CardContent>
</Card>
```

### Base Styling

Cards inherit `rounded-xl border py-4 shadow-sm` from the shadcn primitive. Do not override these.

### Left Accent Borders

Many cards use a colored left border for visual identity:

```tsx
<Card className="border-l-[3px] border-l-cyan-500">
```

Common accent colors and their semantic usage:

| Color | Usage |
|-------|-------|
| `border-l-cyan-500` | Liquidity, TVL metrics |
| `border-l-violet-500` | Active count, distribution |
| `border-l-blue-500` | Informational sections |
| `border-l-green-500` | Positive/growth metrics |
| `border-l-amber-500` | Warnings, disclaimers |
| `border-l-red-500` | Risk, danger, shrinking metrics |
| `border-l-pink-500` | Organic/quality metrics |
| `border-l-muted` | Loading/skeleton state |

### Card Header Labels

The "small caps" pattern is the canonical card header style:

```tsx
<CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
  MARKET CAP
</CardTitle>
```

### KPI Values Inside Cards

```tsx
<span className="text-xl font-extrabold font-mono tabular-nums">
  {formatCurrency(value)}
</span>
```

For slightly smaller KPIs: `text-lg font-bold font-mono tracking-tight`.

### Loading State

```tsx
<Card className="border-l-[3px] border-l-muted">
  <CardHeader className="pb-1">
    <Skeleton className="h-4 w-32" />
  </CardHeader>
  <CardContent>
    <Skeleton className="h-6 w-20" />
  </CardContent>
</Card>
```

---

## Tables

### Component

Always use the shadcn `Table` primitives. For sortable columns, use `SortableTableHead`.

### Column Alignment

| Data Type | Alignment | Extra Classes |
|-----------|-----------|---------------|
| Text (names, labels) | Left (default) | — |
| Numbers (prices, volumes, caps) | Right | `text-right font-mono tabular-nums` |
| Status (badges, grades) | Center | `text-center` |
| Rank | Right | `text-right text-muted-foreground text-xs tabular-nums` |

### Header Styling

For sticky headers:

```tsx
<TableHeader className="bg-muted/80 sticky top-0 z-10 backdrop-blur-sm">
```

### Row Interactivity

Clickable rows use:

```tsx
<TableRow
  className="group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
  onClick={() => router.push(`/stablecoin/${coin.id}`)}
  onKeyDown={handleKeyNav}
  tabIndex={0}
>
```

### Number Formatting

Use the shared formatters from `src/lib/format.ts`:

- `formatCurrency(value)` → `$1.2M`, `$45.6B`
- `formatPercentChange(current, previous)` → `↑ +2.5%` or `↓ -1.2%`
- `formatPegDeviation(bps)` → `+4 bps` with color coding

### Empty State

```tsx
<TableRow>
  <TableCell colSpan={99} className="text-center text-muted-foreground py-12">
    <p>No results for "{query}"</p>
    <p className="mt-2 text-sm">
      <button onClick={onClear} className="text-primary hover:underline cursor-pointer text-sm">
        Clear search
      </button>
    </p>
  </TableCell>
</TableRow>
```

---

## Charts (Recharts)

### Container

```tsx
<div className="h-[250px] sm:h-[350px]" role="figure" aria-label="Description">
  <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
    <AreaChart data={data} margin={{ top: 5, right: 20, bottom: 20, left: 5 }}>
      ...
    </AreaChart>
  </ResponsiveContainer>
</div>
```

- Heights: `h-[250px]` mobile, `sm:h-[350px]` desktop. Mini charts use `h-32`.
- Always set `minWidth={0} minHeight={0}` on `ResponsiveContainer`.
- Standard margins: `{ top: 5, right: 5–20, bottom: 20, left: 5 }`.

### Axis Styling

```tsx
<XAxis
  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
  tickLine={false}
  axisLine={false}
  minTickGap={72}
/>
<YAxis
  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
  tickLine={false}
  axisLine={false}
/>
```

- Always hide `tickLine` and `axisLine`.
- Tick font: monospace, 12px, muted color.
- Use `minTickGap={72}` on time axes to prevent label crowding.

### Tooltip

Spread `RECHARTS_TOOLTIP_STYLES` from `chart-colors.ts`:

```tsx
<Tooltip
  formatter={(value) => [formatCurrency(Number(value)), "Label"]}
  labelFormatter={(label) => formatDate(label)}
  {...RECHARTS_TOOLTIP_STYLES}
/>
```

For custom tooltips, use `content={<CustomTooltip />}` with `cursor={{ fill: "currentColor", opacity: 0.05 }}`.

### Grid Lines

```tsx
<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
```

Use dashed grid lines or omit entirely.

### Colors

Always import from `chart-colors.ts`:

```tsx
import { CHART_BLUE, CHART_PALETTE, PSI_BAND_COLORS, TOKEN } from "@/lib/chart-colors";
```

Never hardcode hex values in chart components.

### Gradients

```tsx
<defs>
  <linearGradient id="mcapGradient" x1="0" y1="0" x2="0" y2="1">
    <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.3} />
    <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
  </linearGradient>
</defs>
<Area fill="url(#mcapGradient)" stroke={CHART_BLUE} strokeWidth={2} />
```

### Legend

Prefer custom legends above charts over the Recharts `<Legend>` component:

```tsx
<div className="flex flex-wrap gap-4 mb-4">
  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLOR }} />
    Label
  </div>
</div>
```

### Loading State

Use the `ChartSkeleton` component:

```tsx
<ChartSkeleton className="h-[250px] sm:h-[350px]" variant="area" />
```

Variants: `"area"` (default), `"bars"`.

### Time Range Filtering

Use the `useTimeRangeFilter` hook + `TimeRangeButtons`:

```tsx
const { range, setRange, filteredData, options } = useTimeRangeFilter(data, "ts");

<CardAction>
  <TimeRangeButtons options={options} value={range} onChange={setRange} />
</CardAction>
```

### Chart Export

```tsx
const chartRef = useRef<HTMLDivElement>(null);

<CardAction>
  <Button variant="ghost" size="icon-sm" onClick={() => downloadChartPng(chartRef, "chart-name")} title="Save as PNG">
    <Camera className="h-4 w-4" />
  </Button>
</CardAction>
```

---

## Interactive States

### Hover

| Element | Pattern |
|---------|---------|
| Cards | `pharos-interactive-card` (or `hover:bg-muted/40 transition-colors` for legacy surfaces) |
| List items / feed rows | `hover:bg-accent/50 transition-colors` |
| Muted text → primary | `hover:text-foreground transition-colors` |
| Text underline reveal | `group-hover:underline` (via `group` on parent) |

### Focus

Standard focus ring (all interactive elements):

```
focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none
```

Preferred shorthand for custom elements:

```
pharos-focus-ring
```

Alternative (larger, for tab-like elements):

```
focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50
```

### Active / Selected

| Element | Active state | Inactive state |
|---------|-------------|----------------|
| Sidebar nav item | `border-l-[3px] border-l-frost-blue text-foreground bg-muted/50` | `text-muted-foreground hover:bg-muted/50 hover:text-foreground border-l-[3px] border-l-transparent` |
| Section tab | `text-foreground bg-muted border-b-2 border-foreground/60` | `text-muted-foreground hover:text-foreground hover:bg-muted/50` |
| Time range button | `bg-primary text-primary-foreground` | `text-muted-foreground hover:bg-accent hover:text-foreground` |

### Transitions

| Duration | Usage |
|----------|-------|
| `transition-colors` (default ~150ms) | Color changes on hover/focus |
| `duration-200` | Quick layout changes (sidebar width) |
| `duration-300` | Fade-in animations, content appearing |
| `2.5s ease-in-out` | Pharos pulse animation (loader) |

### Animations

- **Fade-in:** `animate-in fade-in duration-300` (content appearing)
- **Pharos pulse:** `animate-pharos-pulse` (page-level loading indicator — pulsing teal circle)
- **Ping:** `animate-ping` (live depeg dot indicator)

---

## Loading States

### Page-Level

Use `PharosLoader`:

```tsx
<div className="flex min-h-[40vh] items-center justify-center">
  <div className="h-10 w-10 rounded-full bg-frost-blue/50 animate-pharos-pulse" />
</div>
```

### Component-Level

Use `Skeleton` placeholders that mirror the shape of the real content:

```tsx
<div className="flex items-center gap-3 px-4 py-2 border-t">
  <Skeleton className="h-4 w-8 shrink-0" />
  <Skeleton className="h-6 w-6 rounded-full shrink-0" />
  <Skeleton className="h-4 w-32" />
  <Skeleton className="h-4 w-20 ml-auto" />
</div>
```

Skeletons inherit `rounded bg-muted animate-pulse` from shadcn.

### Error Boundaries

Wrap major sections with `SectionErrorBoundary` to isolate failures:

```tsx
<SectionErrorBoundary name="highlights">
  <MarketHighlights ... />
</SectionErrorBoundary>
```

---

## Error States

### Inline Error

```tsx
<div className="rounded-md bg-destructive/10 p-4 text-destructive flex items-center justify-between">
  <span>Failed to load data.</span>
  <button onClick={() => window.location.reload()}
    className="text-sm font-medium underline hover:no-underline">
    Retry
  </button>
</div>
```

### Full-Page Error

```tsx
<div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
  <div className="text-center space-y-2">
    <h1 className="text-4xl font-bold font-mono tracking-tight">Something went wrong</h1>
    <p className="text-muted-foreground text-sm max-w-md">{error.message}</p>
  </div>
  <button className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors">
    Try again
  </button>
</div>
```

---

## Badges & Indicators

### Grade Badges

Use `GradeBadge` from `src/components/grade-badge.tsx`:

```tsx
<GradeBadge grade="B+" score={76} size="sm" />
```

Sizes: `"sm"` (`text-xs px-2 py-0.5`) or `"lg"` (`text-2xl px-4 py-2`).

Grade colors follow the spectrum defined in `REPORT_CARD_GRADE_COLORS`:
- **A** = bright green
- **B** = teal / blue-green
- **C** = amber / orange
- **D** = orange-red
- **F** = red

### Classification Badges

```tsx
<Badge variant="outline" className={`text-xs ${BACKING_COLORS[backing]}`}>
  {BACKING_LABELS_SHORT[backing]}
</Badge>
```

Always source label text and colors from `classification.ts`.

### Live Indicator (Animated Ping Dot)

```tsx
<span className="relative flex h-2 w-2">
  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
</span>
```

### Trend Indicators

```tsx
<span className={change >= 0 ? "text-green-500" : "text-red-500"}>
  {change >= 0 ? "↑" : "↓"} {formatPercentChange(current, previous)}
</span>
```

---

## Notices & Alerts

Use `CoinNotice` from `src/components/coin-notice.tsx`:

```tsx
<CoinNotice notice={{ type: "warning", title: "Unstable peg", message: "..." }} />
```

Types and their color mapping:

| Type | Border | Background | Icon/Title |
|------|--------|------------|------------|
| `danger` | `border-red-500/40` | `bg-red-500/5` | `text-red-500` / `text-red-600 dark:text-red-400` |
| `warning` | `border-amber-500/40` | `bg-amber-500/5` | `text-amber-500` / `text-amber-600 dark:text-amber-400` |
| `info` | `border-blue-500/40` | `bg-blue-500/5` | `text-blue-500` / `text-blue-600 dark:text-blue-400` |

Layout: `flex items-start gap-3 rounded-lg border-l-4 px-4 py-3`.

---

## Icons

### Library

**Lucide React** (`lucide-react`) — the only icon library.

### Sizes

| Size | Usage |
|------|-------|
| `h-3 w-3` | Inline indicators (peg deviation icons) |
| `h-3.5 w-3.5` | Search icons, sort indicators |
| `h-4 w-4` | Standard — nav items, buttons, actions |
| `h-5 w-5` | Notice/alert icons |

### Icon + Text

Always use flex alignment:

```tsx
<span className="flex items-center gap-1.5">
  <Icon className="h-4 w-4 shrink-0" />
  <span>Label</span>
</span>
```

### Tooltips

Use native HTML `title` attributes. No custom tooltip library.

---

## Accessibility

- **Skip link:** `<a href="#main-content" className="sr-only focus:not-sr-only ...">Skip to main content</a>`
- **Keyboard navigation:** All interactive rows support `tabIndex={0}` + `onKeyDown` (Enter/Space).
- **ARIA labels:** Charts use `role="figure" aria-label="..."`.
- **Focus indicators:** Visible `ring-2` focus rings on all interactive elements.
- **Sort announcements:** `SortableTableHead` includes `aria-sort` values.
