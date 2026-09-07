# Design Language Reference

Durable UI rules for Pharos. This document records reusable invariants and ownership boundaries, not a snapshot of every route's current class list.

Use these sources together:

- [Context](#context) below defines audience, brand personality, surface tiers, and design principles.
- [design-tokens.md](./design-tokens.md) defines the primitive, semantic, component, and JavaScript token layers.
- `src/app/globals.css` owns shared application utilities and the shadcn-to-semantic-token bridge.
- `src/components/ui/` owns low-level primitives; do not edit those primitives for route-local styling.
- Route docs own intentional page-specific compositions and exceptions.

## Context

> Canonical human-facing source. The root [`DESIGN.md`](../DESIGN.md) is a compact, hand-maintained machine-readable reference for AI screen generation, not a generated artifact. Keep both aligned with the **as-built code** when brand tokens, typography, or homepage composition change: frost-blue + the drawn lighthouse identity are retained, with a global top nav replacing the retired left "watch column" sidebar.

This document owns product posture and visual or brand adjectives. [Pharos Editorial Style](./editorial-style.md) owns sentences. On mechanics, the style authority wins.

### Users

Crypto-native DeFi participants who actively monitor stablecoin health — checking market conditions, peg stability, and risk signals regularly to inform financial decisions. The core audience is power-user-leaning: they value density, precision, and speed-to-insight over softness or consumer-app hand-holding.

Discovery and onboarding surfaces (`/start/`, first-run callouts, `/about/`, `/api/` public landing, `/learn/mechanisms/`) deliberately soften their layout and use warmer framing to welcome newcomers. The data surfaces they hand off to remain practitioner-grade, so the softer treatment belongs to the _funnel_.

### Brand Personality

**Vigilant, precise, distinctive.** Pharos is a lighthouse. It watches every peg so you do not have to. The product is practitioner-built, not corporate, and should feel unmistakable rather than merely competent. It earns trust through completeness and specificity, but it should also carry a unique vibe that separates it from generic analytics dashboards.

### Emotional Design

**Calm by default, urgent when needed.** The steady state is composed and analytical, so the user feels informed and in control. When risk signals fire (depeg events, DEWS alerts, PSI band shifts), the interface shifts presentation to communicate urgency without panic.

### Surface Tiers

Pharos calibrates density and posture to surface intent across three explicit tiers. Use this table to place new work; do not blend tiers within a single surface.

| Tier           | Routes / Surfaces                                                                                                                                                     | Density | Posture                                               | Layout signal                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Discovery**  | `/start/`, `/about/`, `/api/` public landing, `/learn/mechanisms/`, marketing-adjacent shells                                                                         | Lowest  | Softer framing permitted; inviting presentation       | Larger rounded shells, generous whitespace, fewer controls, step explainers, route boards |
| **Analytics**  | Homepage dashboard, `/depeg/`, `/chains/`, `/liquidity/`, `/freezewatch/`, `/yield/`, `/coverage/`, `/alt-pegs/`, `/safety-scores/`, `/upcoming/`, `/digest/` archive | Default | Composed, analytical, information-rich                | `pharos-card-shell`, KPI grids, charts, sortable tables, control pills                    |
| **Power-user** | `/stablecoin/[id]/`, `/compare/`, `/screener/`, `/timeline/`, `/portfolio/`, ops admin                                                                                | Highest | Maximum information per pixel; assumes domain fluency | Dense tables, minimal chrome, hairline dividers, mono-heavy, multi-pane composition       |

The gradient runs Discovery → Analytics → Power-user. Drift between adjacent tiers is acceptable when justified by the surface's actual user intent; jumps across tiers (warm presentation on `/timeline/`, marketing-style soft chrome on `/screener/`, or dense multi-pane composition inside `/start/`) are not.

### Aesthetic Direction

- **Theme**: Light theme by default, with the same dense financial-dashboard hierarchy preserved in dark mode
- **References**: DeFi-native research products with strong data density and practical crypto analytics, but Pharos should not collapse into looking like another interchangeable dashboard
- **Brand accent**: Frost-blue `#4BC4DE`, sampled from the Figma Market Pulse frame — used sparingly for navigation active states, homepage metrics, and brand touches
- **Fonts**: the system UI stack for core UI, JetBrains Mono for data figures, and the tracked Bricolage Grotesque face for display. The retained `--font-geist-*` variable names are legacy tokens, not loaded Geist webfonts. Intentional non-core carve-outs include Newsreader serif for editorial/tombstone surfaces, Georgia serif for `AiSummary` and route error treatments, Courier New for Digest/depeg editorial body copy, and the Tape `/timeline/` mono-token wire-service stream.
- **Color use**: Semantic first — color communicates state (health, risk, trend direction), not empty decoration
- **Design bar**: Avoid generic SaaS sameness; every major surface should feel authored and recognizably Pharos

### Anti-References (what Pharos must NOT look like)

- **Web3 marketing pages**: Purple gradients, glassmorphism, buzzword-heavy, style over substance
- **Corporate fintech**: Sterile, over-polished, feels like a bank app — no personality
- **Generic SaaS dashboards**: Cookie-cutter admin panels with big empty cards, interchangeable KPI tiles, and safe pastel gradients
- **Derivative crypto analytics clones**: Anything that feels like a reskinned DefiLlama or generic trading terminal without its own point of view
- **Consumer-app over-softening**: Discovery surfaces soften their _layout and framing_, not their _data_. Charts, tables, and numbers stay analytical on every tier. No chunky illustrations or onboarding mascots belong inside data surfaces.

### Design Principles

1. **Data density over decoration** — every pixel earns its place by communicating information
2. **Calibrate density to surface intent**: Discovery surfaces breathe and lead with warmer framing; Analytics surfaces hold the default; Power-user surfaces compress. Do not apply a single density everywhere.
3. **Calm authority, not loud urgency** — steady state is composed; risk signals shift the tone
4. **Precision as personality** — monospace numbers, exact percentages, named bands — trust through specificity
5. **Semantic color only** — color communicates state (health, risk, trend), never decoration
6. **Soften the funnel, not the product**: Onboarding and discovery can welcome with warmer framing and roomier layouts; data surfaces remain crypto-native and practitioner-grade.
7. **Distinctive, not generic** — Pharos should feel authored and memorable, never like a template or a clone. When a page introduces a metaphor, _draw it_ (Cemetery, Alt-Peg Atlas, Chains Harbor) — but every shape must encode a data field
8. **Consistency is polish** — premium feel comes from repeated precision in spacing, shell treatment, controls, and empty/error states, not from adding decorative novelty

### Stablecoin Detail Module Contract

Every scored/evidence module on `/stablecoin/[id]/` compiles to one shape:

- **Header**: `DETAIL_MODULE_*` constants + `StablecoinModuleTitle` with `MethodologyLabel`; the title lockup is coin icon → ticker → module title so standalone screenshots retain their subject. Right slot order is score (`ScorePill`) → status chip → freshness (`FreshnessIndicator`). Recommendation and cross-coin modules that are not about the current asset keep an ordinary `DetailSectionTitle`.
- **Summary layer** (always visible): verdict line, bounded-vocabulary facts (`FactGrid`, the hero passport grammar), at most one primary visual, and **current-state** callouts only.
- **Detail layer**: breakdowns, tables, long prose, and historical incidents fold behind `ModuleDisclosure` (named labels, native `<details>`), collapsed by default **at every breakpoint** — desktop included. There is no sanctioned auto-open; the Safety Score V9 pillars fold too.
- **Footer**: `EvidenceFooter` — one line of methodology links, folded `Sources (N)` (collapsed everywhere, kept in the DOM for crawlers), right-aligned reviewed/updated stamp.
- **Semantic color**: red/amber callouts are reserved for *active* state; resolved incidents render as calm folded history.
- **Drawn rails**: Mint Authority and Redemption draw their mechanism as compact rails (`MintAuthorityRail`, `RedemptionRouteRail`) — issuer → controls → supply and holder → access gate → venue → output — where every glyph encodes a published field (signer dots = threshold, clock = timelock, gate geometry = access model, arrow label = settlement). Scores sit on a `ScoreBandSpectrum`: **ordinal** band ladder for posture-derived bands (V9 mint — score cutoffs were retired in 9.1, so no marker), **range** track with a score marker only where tones genuinely derive from score cutoffs (redemption 80/65/50/35). Both read "right = safer". Never invent band names or score ranges for a spectrum.
- The xl summary rail keeps expanded at-a-glance compact cards (its purpose *is* the summary layer); below xl, rail-only content must have an in-flow `xl:hidden` copy — never amputated.

## Product Character

Pharos is a dense monitoring product: calm by default, explicit when risk rises, and precise enough for repeated professional use. Discovery pages may use more space and warmer framing, but analytics and power-user routes keep information density high.

The lighthouse metaphor is useful only when it communicates data. Decorative novelty, generic SaaS card grids, glass effects, and color without semantic meaning do not belong in the product.

## Typography

- Core UI and analytics prose use the sans token.
- Numeric values, tickers, timestamps, and compact data labels use `.pharos-numeric` or the mono token.
- Page titles use `.pharos-page-title`; compact panel headings use `.pharos-section-title` rather than hero-scale type.
- `.pharos-kicker` introduces a short category or section label. It is supporting hierarchy, not body copy.
- Serif and unusually mono-heavy treatments are route-owned exceptions for editorial surfaces, Cemetery, error treatments, AI narrative, and `/timeline/`. Do not spread them into general analytics UI.
- Letter spacing remains neutral for ordinary text. Do not scale font size continuously with viewport width.

## Color And State

- Use semantic tokens and shared classification/status helpers. Classification labels and colors belong in `shared/lib/classification.ts`.
- Frost blue is the brand accent and a selective point of emphasis, not the default color for every metric.
- Health, warning, error, freshness, and score colors must represent state consistently in both themes.
- Never rely on color alone. Pair it with text, position, shape, iconography, or another redundant channel.
- JavaScript chart colors normally come from the shared runtime maps described in [design-tokens.md](./design-tokens.md), not local hex constants. Intentional local canonical palettes are the market-cap delta colors in `src/components/mcap-chart.tsx`, `PEG_BAND_HEX` in `src/components/peg-deviation-chart.tsx`, and `ANNOTATION_HEX_COLORS` in `src/components/chart-primitives/annotations.tsx`.

## Page Shells

- Standard route hierarchy and metadata should flow through the established page-shell helpers where they fit.
- Visible slash-separated breadcrumb trails are not part of current page headers. Emit breadcrumb JSON-LD when a route needs crawlable hierarchy.
- Data-dense routes use the available page width with a sensible ultrawide ceiling. Longform prose supplies its own readable measure.
- The homepage, stablecoin detail, Digest, Cemetery, Tape, and other special surfaces own their composition in their route contracts; do not generalize their local layout into a global rule.
- A page hero supplements the route heading. It must not duplicate or replace the semantic `h1` unless the owning shell explicitly does so.

### Feature-page heroes

Feature and reference routes use one signature full-width hero with one frost-blue **One Beam** metric; supporting figures stay neutral unless they encode semantic state. The route owner defines the drawn metaphor and any explicit exception. Learn routes use the light-editorial treatment; Coverage and Funding use the reference treatment. Their route docs own only those route-specific calls.

## Shared Utility Classes

Prefer the established utilities in `src/app/globals.css`:

| Utility | Contract |
| --- | --- |
| `.pharos-card-shell` | Default framed analytics surface using shared background, border, and elevation tokens. |
| `.pharos-interactive-card` | Clickable card hover and press motion; pair it with `.pharos-focus-ring` for the focus treatment. |
| `.pharos-control-pill` | Dense option or mode control; pair the selected state with `.pharos-control-pill-active`. |
| `.pharos-focus-ring` | Shared keyboard focus treatment for custom interactive elements. |
| `.pharos-table-shell` / `.pharos-table-toolbar` | Shared framing and controls for tabular workspaces. |
| `.pharos-chart-stage` | Inner chart surface distinct from its surrounding section. |
| `.pharos-subtle-band` | Low-emphasis grouped information without introducing another card. |
| `.pharos-empty-note` | Bounded empty-state treatment inside a data surface. |
| `.pharos-meta` | Compact secondary metadata. |
| `.pharos-prose-link` | Inline link treatment in explanatory copy. |

Check the current declarations before depending on exact padding, radius, shadow, or responsive behavior. Those implementation details belong to `src/app/globals.css` and the token files.

## Cards And Sections

- `src/components/ui/card.tsx` is a structural primitive. It currently has no resting `shadow-sm`; do not document or depend on one.
- Use cards for genuinely framed tools, repeated items, and modals. Do not place cards inside cards or turn every page section into a floating card.
- Shared resting and hover elevation comes from component tokens such as `--card-shadow` and `--card-shadow-hover` through the application utilities.
- Keep headings, actions, and content within stable responsive constraints so dynamic labels do not resize the surrounding layout.
- Use hairline dividers and unframed bands when a card would add hierarchy without adding meaning.

## Controls And Navigation

- Use icons for familiar actions, with tooltips for unfamiliar icon-only controls.
- Use pills or segmented controls for compact mutually exclusive modes, checkboxes/toggles for binary settings, and menus for larger option sets.
- Interactive controls need a visible focus state, an accessible name, and a stable hit area. Touch targets should remain usable even when desktop controls are visually compact.
- URL-backed filters must preserve unrelated query parameters and normalize deprecated aliases at the route boundary.
- Sticky UI must account for global navigation and must not obscure anchored content.

### Control Pills

`.pharos-control-pill` is the canonical compact option shell. Use `.pharos-control-pill-active` for its selected state, keep labels short enough to wrap safely, and expose group/pressed semantics appropriate to the interaction. The current visual values live in `src/app/globals.css`.

Use `ControlPillToggle` in `src/components/control-pill-toggle.tsx` for plain controlled, pressed-option groups. Callers retain labels, layout, responsive density, and state ownership. Keep radio controls, directional sort buttons, and bespoke icon/count/action or focus treatments local rather than adding modes to the primitive.

### Tape (Special)

`/timeline/` deliberately uses a wire-service treatment rather than the standard analytics card language. [tape-page.md](./tape-page.md) owns that route's aesthetic lock and exact implementation.

## Tables And Charts

- Tables are the authoritative comparison surface when users must scan, sort, or export exact values.
- Product tables compose the shared primitives in `src/components/table/`, plus `src/components/data-table-shell.tsx` for sortable workspaces. Nothing else under `src/` may emit raw `<table>` markup or import a shadcn table module directly; the only exceptions are those primitives themselves, the screen-reader data table in `src/components/chart-primitives/data-table.tsx`, and test fixtures. `npm run check:table-primitives` is a blocking PR gate for this, so reach for a primitive before hand-rolling a grid.
- Sortable headers expose `aria-sort`; clickable rows must retain an explicit keyboard path and must not swallow nested links or buttons.
- Preserve horizontal access on narrow screens rather than hiding important columns without an equivalent surface. The shared table viewport already renders a swipe hint under a horizontally scrollable table; disable it with `mobileScrollHint={false}` when the surface cannot overflow, and do not add your own swipe copy beside a table that still shows the default hint.
- Charts need explicit loading, empty, stale, and error states. Freshness and methodology context belong near the data when misreading is plausible.
- Follow [data-visualization.md](./data-visualization.md) for SVG roles, equivalent accessible data, reduced motion, view-model separation, and test invariants.

## Responsive Behavior

- Use stable grids, aspect ratios, min/max constraints, and overflow rules for fixed-format tools.
- Reflow before shrinking text. Long labels and localized text must wrap without covering adjacent controls.
- Mobile may change interaction order or density, but it must preserve the workflow and the underlying facts.
- CSS can own purely visual breakpoint changes. Use runtime viewport logic only when behavior or data fetching genuinely differs.
- Verify dense and fixed-format surfaces at common mobile widths and at 200 percent zoom.

## Accessibility And Motion

- Use semantic HTML before adding ARIA.
- Every interactive element is keyboard reachable and visibly focused.
- Loading and mutation states use the appropriate `aria-busy`, status, or alert semantics without noisy duplicate announcements.
- Respect `prefers-reduced-motion`; no information may depend on animation playing.
- Decorative graphics are hidden from assistive technology. Data graphics expose a concise name and an equivalent accessible data surface as described in [data-visualization.md](./data-visualization.md).
- Text and controls must meet the contrast baseline in both themes.

## Maintenance

When a reusable rule changes, update the owning layer rather than copying the new implementation into several docs:

1. Brand, audience, or density model: [Context](#context).
2. Token value or token architecture: [design-tokens.md](./design-tokens.md) and `src/styles/tokens/`.
3. Shared utility behavior: `src/app/globals.css` and this primitive index when its contract changes.
4. Route-specific composition: the route doc.
5. Visualization behavior: [data-visualization.md](./data-visualization.md).

Use source as truth. Avoid dated redesign history, copied route rosters, and exact class snapshots in this file.
