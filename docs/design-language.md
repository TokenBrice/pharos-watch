# Design Language Reference (Live Baseline)

This document reflects the deployed UI on [pharos.watch](https://pharos.watch) and was re-verified on **March 5, 2026**.

Use this as the visual source of truth for product-facing design decisions. For token definitions (primitive, semantic, component), see [`design-tokens.md`](design-tokens.md).

---

## Visual Direction

Pharos ships as a **dark-first financial dashboard**:

- Dense data presentation
- Conservative card-and-table surfaces
- Small, meaningful color accents (risk, status, category)
- Heavy use of monospace for numeric trust and scanability

The default theme class on load is `dark`, with a user toggle for light mode.

---

## Global App Shell

### Root + Fonts

- Body classes: `geist_*` font variables + `antialiased`
- Sans font: `Geist`
- Mono font: `Geist Mono`
- Default corner radius token: `--radius: .5rem`

### Layout Structure

Public pages use this shell:

```tsx
<header className="md:hidden sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60" />
<div className="flex min-h-screen">
  <aside className="hidden md:flex flex-col fixed top-0 left-0 h-screen border-r border-border bg-card z-40 transition-all duration-200" />
  <div className="hidden md:block shrink-0 transition-all duration-200 w-[220px]" />

  <div className="flex-1 flex flex-col min-w-0">
    <main id="main-content" className="flex-1 container mx-auto px-4 py-6 lg:px-6">
      {/* route content */}
    </main>

    <footer className="border-t py-6" />
  </div>
</div>
```

### Chrome Patterns

- Desktop sidebar width: `220px`
- Mobile header height: `h-14`
- Main container padding:
  - Mobile: `px-4`
  - Desktop (`lg`): `px-6`
- Footer nav is muted text with hover promotion to foreground.

---

## Page Shell Variants

### Standard Analytics Pages

Most routes use:

- Wrapper: `space-y-6`
- Title block: `space-y-2`
- Breadcrumb: `flex items-center gap-1.5 text-sm text-muted-foreground`
- Title row: `flex max-w-full flex-wrap items-start gap-x-3 gap-y-2`

### Longform Pages

- Privacy: `mx-auto w-full space-y-6 max-w-2xl`
- Methodology: `mx-auto w-full max-w-6xl space-y-8`

### Home Dashboard (Special)

Home has no large feature `h1` hero title. Instead it uses a top logotype strip:

- `h1`: `text-base font-mono font-semibold uppercase tracking-[0.18em] text-foreground`
- Snapshot shell: `pharos-card-shell` + `pharos-kicker`

### Stablecoin Detail (Special)

Detail pages include an `sr-only` `h1` and visually foreground the coin name with:

- `h2`: `text-2xl font-extrabold tracking-tighter`

This is intentionally denser than standard feature pages.

### Digest Article (Special)

Digest entries use:

- `h1`: `text-3xl font-extrabold tracking-tighter`
- Editorial prose: `text-[1.15rem] leading-relaxed text-foreground/90 italic` with Georgia/Times serif fallback.

---

## Typography

### Heading Scale

| Role | Live class pattern |
|---|---|
| Standard page title | `min-w-0 text-4xl font-extrabold tracking-tighter` |
| Digest article title | `text-3xl font-extrabold tracking-tighter` |
| Home logotype title | `text-base font-mono font-semibold uppercase tracking-[0.18em]` |
| Primary section heading | `leading-none font-semibold` |
| Secondary section heading | `text-lg font-semibold` or `text-lg font-semibold tracking-tight` |
| Table/section kicker | `text-sm font-semibold uppercase tracking-wider text-muted-foreground` |
| Subsection heading | `text-foreground font-medium` |

### Body + Supporting Text

| Role | Live class pattern |
|---|---|
| Standard body copy | `text-sm text-muted-foreground` |
| Small metadata | `text-xs text-muted-foreground` |
| Card micro-labels | `text-xs uppercase tracking-wide` |
| Footer disclaimer | `text-center text-xs text-muted-foreground/60` |

### Numeric Language

Numbers are consistently mono/tabular where precision matters:

- `font-mono`
- `tabular-nums`

---

## Spacing and Layout Rhythm

### Common Vertical Rhythm

- Section rhythm: `space-y-6`
- Header block rhythm: `space-y-2`
- Longform rhythm: `space-y-8`
- Card prose rhythm: `space-y-6 text-sm text-muted-foreground leading-relaxed`

### Common Grids

- KPI grid (dense analytics): `grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-5`
- Home feature grid: `grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5`
- Home snapshot desktop partition: `hidden sm:grid grid-cols-2 xl:grid-cols-4 divide-x divide-border/50`

### Chip/Pill Layout

- Chips are frequently wrapped in `flex flex-wrap gap-2`
- Category links and peg links prioritize `rounded-full` micro-surfaces.

---

## Shared Utility Classes

Live production uses all four shared utility classes:

- `pharos-kicker`
- `pharos-focus-ring`
- `pharos-card-shell`
- `pharos-interactive-card`

Current high-use areas:

- Homepage snapshot and explore cards
- Peg filter pills
- CTA links with custom focus treatment

---

## Cards

### Base Card Primitive

Default card composition in production:

- `data-slot="card"`
- `bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4 shadow-sm`

### Card Header + Title

- Header: `@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4`
- Tight variants add `pb-1`, `pb-1.5`, or `pb-2`
- Titles: mostly `leading-none font-semibold`

### Accent Border Palette (Live)

`border-l-[3px]` is actively used with:

- `border-l-cyan-500`
- `border-l-amber-500`
- `border-l-violet-500`
- `border-l-sky-500`
- `border-l-zinc-500`
- `border-l-rose-500`
- `border-l-orange-500`
- `border-l-emerald-500`
- `border-l-teal-500`
- `border-l-red-500`
- `border-l-blue-500`

Navigation active state uses `border-l-frost-blue`.

### Interactive Card Pattern

Homepage explore cards use:

```tsx
className="pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col gap-1.5 border-l-[3px] p-4"
```

---

## Badges and Chips

### Feature Status Badges

- **Mature**: emerald badge (`bg-emerald-500/15 ... border-emerald-500/30`)
- **Experimental**: amber badge (`bg-amber-500/15 ... border-amber-500/30`)

### Version Badge

Secondary version pill:

- `bg-muted/50 text-muted-foreground border-border/60`

### Micro Chips

Common chip form:

- `inline-flex items-center rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent transition-colors`

---

## Tables

### Base Table Styling

- Table: `w-full caption-bottom text-sm`
- Row: `hover:bg-muted/40 data-[state=selected]:bg-muted border-b transition-colors`

### Header Variants

- Standard header: `[&_tr]:border-b bg-muted/80`
- Sticky directory header (peg pages): `[&_tr]:border-b bg-muted/80 sticky top-0 z-10 backdrop-blur-sm`

### Sortable Head Pattern

Sortable heads consistently include:

- `cursor-pointer`
- `hover:bg-muted/50 transition-colors`

Numeric columns remain right-aligned (`text-right`) and collapse progressively by breakpoint (`hidden sm:table-cell`, `hidden md:table-cell`, etc.).

### Clickable Rows

Interactive rows use:

- `group cursor-pointer`
- `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none`

---

## Charts

### Live Chart Container Pattern

- Height: `h-[250px] sm:h-[350px]`
- Recharts container keeps `min-width: 0; min-height: 0`

### Axis + Grid (Observed)

From production rendered charts:

- Tick text: `font-size: 12`, `font-family: var(--font-mono, monospace)`, `fill: var(--color-muted-foreground)`
- Grid lines: `stroke="var(--color-border)"`, `strokeDasharray="3 3"`

### Area Chart Styling (Observed)

- Areas use gradient fills (e.g. `fill="url(#psiScoreGradient)"`)
- Stroke widths are typically `1.5` or `2`
- Tooltips are present (`.recharts-tooltip-wrapper` appears on interaction)

### Loading Fallbacks

Common chart skeletons:

- `rounded-lg bg-muted/30 animate-pulse relative overflow-hidden h-[250px] sm:h-[350px] w-full`
- `bg-accent animate-pulse h-[250px] sm:h-[350px] w-full rounded-xl`

---

## Interaction and State Patterns

### Navigation Active vs Inactive

- Active sidebar item:
  - `border-l-[3px] border-l-frost-blue text-foreground bg-muted/50`
- Inactive sidebar item:
  - `text-muted-foreground hover:bg-muted/50 hover:text-foreground border-l-[3px] border-l-transparent`

### Focus Treatment

Two dominant focus patterns:

- `focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`
- `focus-visible:ring-[3px] focus-visible:ring-ring/50`

### Loading States

- Skeletons are the default loading surface (`data-slot="skeleton"` + `animate-pulse`)
- Page-level loader currently appears as:
  - `flex min-h-[40vh] items-center justify-center`
  - `h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse`

### Live/Event Indicator

Depeg live indicator uses animated ping:

- `animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75`

### Data Availability Banner

When data streams are missing:

- `rounded-md border px-4 py-2.5 text-sm border-border/60 bg-muted/40 text-muted-foreground`

Used with copy like: `Some data is not yet available (...)`.

---

## Responsive Behavior

### Breakpoint Behavior in Production

- `sm`:
  - Compacts/expands table columns
  - Converts details/nav patterns
- `md`:
  - Sidebar becomes active (`md:flex`)
  - Mobile header hides (`md:hidden`)
- `lg`:
  - Main horizontal padding increases (`lg:px-6`)
  - Larger grid splits and extra table columns
- `xl`:
  - Additional dense table columns
  - Home KPI grid expands to 4 panels in snapshot module

### Mobile-Specific UX

- Category browse collapses into `details` (`sm:hidden`)
- `--table-header-top: 56px` is set on mobile for sticky header offset alignment

---

## Accessibility Baseline

Live app-wide patterns:

- Skip link present on every page: `sr-only focus:not-sr-only ...`
- Breadcrumb navigation on content routes
- Focus-visible rings on sidebar links, buttons, table rows, and chips
- Keyboard-ready clickable rows on interactive tables
- Color is reinforced with structure and iconography for key status states

---

## Maintenance Rule

If a deployed class pattern changes in production, update this document immediately after release. This file is intended to describe what users currently see, not aspirational or historical styles.
