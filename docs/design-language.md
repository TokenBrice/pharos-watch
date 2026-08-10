# Design Language Reference

Durable UI rules for Pharos. This document records reusable invariants and ownership boundaries, not a snapshot of every route's current class list.

Use these sources together:

- [design-context.md](./design-context.md) defines audience, brand personality, surface tiers, and design principles.
- [design-tokens.md](./design-tokens.md) defines the primitive, semantic, component, and JavaScript token layers.
- `src/app/globals.css` owns shared application utilities and the shadcn-to-semantic-token bridge.
- `src/components/ui/` owns low-level primitives; do not edit those primitives for route-local styling.
- Route docs own intentional page-specific compositions and exceptions.

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
- JavaScript chart colors come from the shared runtime maps described in [design-tokens.md](./design-tokens.md), not local hex constants.

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
| `.pharos-interactive-card` | Clickable/focusable card behavior with consistent hover and focus treatment. |
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

### Tape (Special)

`/timeline/` deliberately uses a wire-service treatment rather than the standard analytics card language. [tape-page.md](./tape-page.md) owns that route's aesthetic lock and exact implementation.

## Tables And Charts

- Tables are the authoritative comparison surface when users must scan, sort, or export exact values.
- Sortable headers expose `aria-sort`; clickable rows must retain an explicit keyboard path and must not swallow nested links or buttons.
- Preserve horizontal access on narrow screens rather than hiding important columns without an equivalent surface.
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

1. Brand, audience, or density model: [design-context.md](./design-context.md).
2. Token value or token architecture: [design-tokens.md](./design-tokens.md) and `src/styles/tokens/`.
3. Shared utility behavior: `src/app/globals.css` and this primitive index when its contract changes.
4. Route-specific composition: the route doc.
5. Visualization behavior: [data-visualization.md](./data-visualization.md).

Use source as truth. Avoid dated redesign history, copied route rosters, and exact class snapshots in this file.
