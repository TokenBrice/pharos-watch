# Design Language Reference (Live Baseline)

This document reflects the current UI baseline in the codebase and was re-verified on **March 11, 2026**.

Use this as the visual source of truth for product-facing design decisions. For token definitions (primitive, semantic, component), see [`design-tokens.md`](design-tokens.md).

---

## Visual Direction

Pharos ships as a **dark-first financial dashboard**:

- Dense data presentation
- Conservative card-and-table surfaces
- Small, meaningful color accents (risk, status, category)
- Heavy use of monospace for numeric trust and scanability

The default theme class on load is `dark`, with a user toggle for light mode.

Light mode keeps the same hierarchy as dark mode, but status/accent text is calibrated one step darker to preserve readability on pale surfaces (typical pattern: `text-*-700 dark:text-*-400`).

---

## Global App Shell

### Root + Fonts

- Body classes: `geist_*` font variables + `antialiased`
- Sans font: `Geist`
- Mono font: `Geist Mono`
- Default corner radius token: `--radius: .5rem`
- Body background adds two subtle radial glow layers via `--page-glow-top` and `--page-glow-bottom`

### Layout Structure

Public pages use this shell:

```tsx
<header className="md:hidden sticky top-0 z-50 border-b border-border/80 bg-background/88 shadow-[0_6px_20px_oklch(0_0_0_/0.08)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/72" />
<div className="flex min-h-screen">
  <aside className="hidden md:flex flex-col fixed top-0 left-0 h-screen border-r border-border/70 bg-card/92 shadow-[0_0_0_1px_oklch(1_0_0_/0.03),0_20px_35px_oklch(0_0_0_/0.2)] backdrop-blur-xl z-40 transition-all duration-200" />
  <div className="hidden md:block shrink-0 transition-all duration-200 w-[220px]" />

  <div className="flex-1 flex flex-col min-w-0">
    <main id="main-content" className="pharos-mobile-utility-safe flex-1 container mx-auto px-4 py-6 md:py-7 lg:px-6">
      {/* route content */}
    </main>

    <footer className="border-t border-border/70 bg-muted/10 py-8 sm:py-10" />
  </div>
</div>
```

### Chrome Patterns

- Desktop sidebar width: `220px`
- Mobile header height: `h-14`
- Mobile utility dock: fixed bottom-right dock on `<640px` with shared feedback + scroll-to-top placement; the dock stays hidden until the first scroll so it does not cover top-fold content
- Main content and footer reserve bottom safe space via `pharos-mobile-utility-safe` + `--mobile-utility-safe-offset`
- Main container padding:
  - Mobile: `px-4`
  - Vertical rhythm: `py-6` (`md:py-7`)
  - Desktop (`lg`): `px-6`
- Footer now prioritizes a short list of core routes, keeps category browsing secondary, drops duplicate tagline text beside socials, and lets intro/legal copy breathe across wider lines.
- The footer intro block is not width-capped inside its header row; on larger screens it expands to fill the available column beside the social icons.

---

## Page Shell Variants

### Standard Analytics Pages

Most routes use:

- Wrapper: `space-y-6`
- Title block: `space-y-2.5`
- Breadcrumb: `flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm`
- Title row: `flex max-w-full flex-wrap items-start gap-x-3 gap-y-2`

### Longform Pages

- Privacy: `mx-auto w-full space-y-6 max-w-2xl`
- Methodology: `mx-auto w-full max-w-[76rem] space-y-8`
- Digest archive: `mx-auto max-w-4xl`
- Digest detail shell: `mx-auto max-w-4xl`, with editorial body copy constrained to `max-w-[68ch]`

### Start Here (Special)

The `/start/` orientation route keeps the shared breadcrumb/title shell, then shifts into a broader planning-board layout:

- Wrapper: `mx-auto max-w-6xl space-y-8`
- Hero shell: large rounded plotting-board surface with editorial onboarding copy on the left and a route board on the right
- Route board: staggered CTA cards over subtle route-trace lines, with the dominant top and bottom routes spanning two columns on `sm+`
- Mobile top fold compresses the hero copy so the first route card stays visible above the fold
- Desktop hero splits into a two-stage composition: headline + route board first, then a full-width fact row beneath
- Follow-up sections use glossary cards, flattened feature-atlas groups, and shortcut cards instead of one long prose stream

### Home Dashboard (Special)

Home keeps a single `sr-only` page `h1` for semantics and uses a non-heading top fold composed of:

- Desktop masthead strip: `pharos-card-shell hidden lg:flex ... px-5 py-5`
- Snapshot shell: PSI-dominant first card + four supporting desktop KPI panels; mobile and tablet collapse to a 2x2 compact tile grid that includes net mint/burn flow
- Snapshot PSI lead card hides the `Live market health`, `24h`, and `7d` pills from the desktop switch (`lg`, `1024px`) through `1599px` to protect the score/band lockup; outside that band it keeps the full desktop treatment

### Stablecoin Detail (Special)

Detail pages include an `sr-only` `h1` and visually foreground the coin name with:

- `h2`: `text-2xl font-extrabold tracking-tighter`

This is intentionally denser than standard feature pages.

### Digest Article (Special)

Digest entries use:

- `h1`: `text-3xl font-extrabold tracking-tighter`
- Executive summary card ahead of body copy
- Editorial prose constrained to `max-w-[68ch]`
- Homepage digest preview switches to a split desktop layout so the title block and italic executive-summary paragraph can use the full container width; dedicated digest pages keep the `max-w-[68ch]` editorial measure.

---

## Typography

### Heading Scale

| Role                      | Live class pattern                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Standard page title       | `min-w-0 text-3xl sm:text-4xl font-extrabold tracking-tight leading-[1.08]`                  |
| Digest article title      | `text-3xl font-extrabold tracking-tighter`                                                   |
| Home logotype label       | `text-[1.02rem] font-mono font-semibold uppercase tracking-[0.16em]`                         |
| Primary section heading   | `leading-none font-semibold`                                                                 |
| Secondary section heading | `text-lg font-semibold` or `text-lg font-semibold tracking-tight`                            |
| Table/section kicker      | `text-[12px] sm:text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground` |
| Subsection heading        | `text-foreground font-medium`                                                                |

### Body + Supporting Text

| Role               | Live class pattern                             |
| ------------------ | ---------------------------------------------- |
| Standard body copy | `text-sm text-muted-foreground`                |
| Small metadata     | `text-xs text-muted-foreground`                |
| Card micro-labels  | `text-xs uppercase tracking-wide`              |
| Footer disclaimer  | `text-center text-xs text-muted-foreground/60` |

### Numeric Language

Numbers are consistently mono/tabular where precision matters:

- `font-mono`
- `tabular-nums`

---

## Spacing and Layout Rhythm

### Common Vertical Rhythm

- Section rhythm: `space-y-6`
- Header block rhythm: `space-y-2.5`
- Longform rhythm: `space-y-8`
- Card prose rhythm: `space-y-6 text-sm text-muted-foreground leading-relaxed`

### Common Grids

- KPI grid (dense analytics): `grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-5`
- Home feature grid: `grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5`
- Home snapshot desktop partition: `hidden lg:grid grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,0.92fr))] divide-x divide-border/50`

### Chip/Pill Layout

- Chips are frequently wrapped in `flex flex-wrap gap-2`
- Category links and peg links prioritize `rounded-full` micro-surfaces.

### Onboarding / Access Surfaces

First-run compare, portfolio, and gated status states now share a structured onboarding surface:

- Large rounded shell with dark gradient backdrop
- `pharos-kicker` eyebrow + one decisive title
- 3 step explainer cards
- CTA row using rounded-full buttons
- Preview panel shell on the right at desktop, stacked on mobile
- Optional footnote/support panel at the bottom of the text column

The dedicated `/start/` route extends the same language into a full-page onboarding pattern:

- large hero shell with route-selection cards instead of a single preview panel
- compact fact blocks embedded in the copy column
- glossary cards beneath the hero
- flattened feature-atlas groups plus shortcut cards for optional progressive discovery

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
className =
  "pharos-card-shell pharos-focus-ring pharos-interactive-card group flex flex-col gap-2 border-l-[3px] bg-gradient-to-b from-background/40 to-transparent p-4";
```

### Logo Containers

Tracked token logos now render inside a shared neutral container:

- `rounded-full border border-border/60 bg-background/80`
- subtle inset highlight
- image shrunk slightly inside the wrapper so transparent/low-quality upstream assets do not collapse into the page background

---

## Badges and Chips

### Feature Status Badges

- **Mature**: emerald badge (`bg-emerald-500/15 ... border-emerald-500/30`)
- **Experimental**: amber badge (`bg-amber-500/15 ... border-amber-500/30`)
- **Testing in Prod**: orange badge (`bg-orange-500/15 ... border-orange-500/30`)
- Status text should follow light/dark pairing (`text-*-700 dark:text-*-400`) instead of fixed `text-*-300/400` tones.
- Badge copy is now terse (`Mature`, `Experimental`, `Testing in Prod`) instead of repeating “Feature Status”.

### Version Badge

Secondary version pill:

- `bg-background/35 text-muted-foreground border-border/60`

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

### Mobile Directory Table Handling

- Toolbar becomes a vertical stack on mobile instead of a cramped inline row
- `Columns` and `Export CSV` go full-width on mobile
- Table keeps a deliberate horizontal-scroll affordance via helper copy and `min-w-[820px]`
- Bottom spacing is preserved so the mobile utility dock never sits on the last visible rows

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
- Chart-heavy home modules now reserve height through matching skeletons or client-ready mount guards before `ResponsiveContainer` renders

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
- Blacklist hero chart uses `h-[220px] sm:h-[280px]`
- Yield scatter plot uses `h-[240px] sm:h-[340px]` inside a bordered chart stage

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
  - Home KPI grid keeps the wide five-panel snapshot module intact

### Mobile-Specific UX

- Category browse collapses into `details` (`sm:hidden`)
- `--table-header-top: 56px` is set on mobile for sticky header offset alignment
- Bottom utility controls are consolidated into one dock on mobile instead of separate floating widgets

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
