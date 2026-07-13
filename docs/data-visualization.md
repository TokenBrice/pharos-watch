# Data Visualization Language

Implementation contract for charts, SVG scenes, and data-driven visual metaphors in Pharos. [design-language.md](./design-language.md) owns general UI rules; this document covers visualization-specific behavior.

## Principle

A visualization must make a real relationship easier to read. Use a conventional chart or table when it communicates the data more directly; use a metaphor scene only when its geometry has an explainable mapping to the underlying facts.

Every important visual channel must have a stated meaning. Color is never the only channel carrying a distinction.

## Architecture

Separate data transformation from rendering:

1. A pure TypeScript view model validates inputs, aggregates values, chooses scales, clamps geometry, and returns presentation-ready fields.
2. A React layer renders SVG/DOM from that view model and owns focus, pointer interaction, labels, and selection callbacks.
3. CSS owns static styling and motion, including reduced-motion behavior.

Runtime-neutral thresholds, labels, and palettes belong in `shared/lib/` when both frontend and Worker code consume them. Route-local geometry can remain beside the route or component.

Selection shared with sibling panels belongs in the route client, not hidden inside the scene.

## Encoding

Prefer position for the primary relationship. Size can show magnitude; hue can show category or band; shape, opacity, and motion can reinforce those meanings.

Stablecoin data often spans several orders of magnitude. Use an appropriate non-linear or piecewise scale for magnitude and give every rendered size an explicit floor and ceiling. The view model must handle null, empty, non-finite, negative, and out-of-range inputs without producing invalid SVG geometry.

Derived layout must be deterministic. Seed any jitter or long-tail accent from a stable identifier; do not use `Math.random()` during render.

## Composition

Use SVG for ordinary interactive data scenes because it preserves semantic text, element-level focus, and CSS control. Canvas is appropriate only when scale or rendering cost justifies losing DOM-level semantics.

In layered scenes, keep a predictable order:

1. decorative atmosphere
2. structural guides
3. secondary marks
4. primary data marks
5. labels
6. interaction overlays

Decorative layers use `aria-hidden="true"`. Do not add atmosphere that competes with labels or makes state colors ambiguous.

## Accessibility

Choose the SVG role from its behavior:

- A non-interactive, atomic SVG uses `role="img"` with a concise accessible name that summarizes the state.
- An SVG containing focusable or interactive descendants uses `role="group"` with an accessible name. Interactive descendants inside `role="img"` are invalid.

Interactive marks need a semantic role or native interactive element, an accessible name containing the entity and relevant value, visible focus, and keyboard activation equivalent to pointer activation. Selection controls expose their state.

Every visualization requires an equivalent accessible data surface. This may be an adjacent table, an always-present summary, a detail panel, a screen-reader-only structure, or a small-screen list. It does not have to be a duplicated fallback list, but it must expose the same decision-relevant facts when the graphic cannot be perceived or operated.

Do not announce decorative labels or duplicate the same data through several live regions. Inline text placed over complex graphics needs sufficient contrast or a stable backing surface.

## Interaction

- Mirror hover context on focus.
- Keep hit targets usable on coarse pointers, even when the visible mark is small.
- Where a tap both previews and navigates, use an explicit touch interaction model that prevents accidental navigation.
- Tooltips supplement the equivalent data surface; they are not the sole location for important information.
- Auto-cycling or ambient selection yields as soon as the user interacts.
- Provide an inspection or reflow strategy when a dense scene cannot remain legible on narrow screens.

## Motion

Prefer CSS keyframes and transitions over JavaScript animation loops for ambient effects. Data-dependent durations or positions may flow through CSS custom properties.

All nonessential motion must be gated by `prefers-reduced-motion`. The reduced-motion state must set explicit static visibility and preserve every fact communicated by motion. Do not leave a mark transparent because its reveal animation no longer runs.

## Responsive Behavior

- Start with a stable `viewBox`, aspect ratio, or constrained stage.
- Parameterize scene-wide scale and hit-area changes instead of scattering per-element media queries.
- Reflow legends, labels, and companion panels before making type unreadably small.
- Mobile may use the same responsive scene, an inspection overlay, or an equivalent list/table. The correct choice depends on legibility, not a universal breakpoint rule.
- Test long names, large values, empty cohorts, narrow widths, and 200 percent zoom.

## Color And Tokens

Data encodings use shared semantic or classification palettes. Follow [design-tokens.md](./design-tokens.md) for CSS tokens and JavaScript color maps. Unknown states need an explicit neutral fallback.

A visualization may own local atmospheric colors when those colors do not encode data. Known brand colors may come from a curated registry; unbounded categories may use a deterministic identifier-based palette.

## Labels And Context

Keep labels concise and concrete. Tickers and compact values may use mono; explanatory prose stays in the core sans face. Avoid serif inside analytical scenes.

Supply the context needed to avoid misreading:

- metric and unit
- time window
- freshness or as-of time when material
- legend for non-obvious encodings
- methodology link or label for coined scores
- a short caveat where correlation, sample scope, or retained stale data could be mistaken for something stronger

## Tests

Prioritize pure view-model tests over large visual snapshots:

- monotonicity for magnitude mappings
- floors, ceilings, and clamping
- deterministic output
- null, empty, malformed, and non-finite inputs
- aggregation, ordering, and percentage math
- stable behavior at boundary values

Add lightweight component tests for the behavior the DOM owns:

- correct root role and accessible name
- decorative layers hidden
- keyboard and pointer callbacks
- focus/selection state
- shared palette use
- reduced-motion-safe classes or structure when the component owns them
- equivalent accessible data surface present in the composed route

## Review Checklist

- The chosen chart or metaphor is simpler than the alternatives for this relationship.
- A pure view model owns transformation and geometry.
- Magnitudes have an appropriate scale plus tested bounds.
- Color is redundant with another channel.
- The SVG root role matches whether descendants are interactive.
- Keyboard, touch, and focus behavior match pointer behavior.
- An equivalent accessible data surface exposes decision-relevant facts.
- Motion is optional and reduced-motion leaves a complete static state.
- Loading, empty, stale, and error states are explicit.
- Narrow screens and zoom retain readable labels and usable controls.

Break these rules only for a documented reason, such as a very high-density canvas plot or an internal diagnostic surface. Record the tradeoff in the owning route or feature doc rather than adding a global exception here.
