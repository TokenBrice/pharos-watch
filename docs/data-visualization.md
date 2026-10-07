# Data Visualization Language

Implementation contract for charts, SVG scenes, and data-driven visual metaphors in Pharos. [design-language.md](./design-language.md) owns general UI rules; this document covers visualization-specific behavior.

## Principle

A visualization must make a real relationship easier to read. Use a conventional chart or table when it communicates the data more directly; use a metaphor scene only when its geometry has an explainable mapping to the underlying facts.

Every important visual channel must have a stated meaning. Color is never the only channel carrying a distinction.

## Architecture

For new visualizations, and for existing visualizations being brought into compliance, the standard is to separate data transformation from rendering:

1. A pure TypeScript view model validates inputs, aggregates values, chooses scales, clamps geometry, and returns presentation-ready fields.
2. A React layer renders SVG/DOM from that view model and owns focus, pointer interaction, labels, and selection callbacks.
3. CSS owns static styling and motion, including reduced-motion behavior.

Runtime-neutral thresholds, labels, and palettes belong in `shared/lib/` when both frontend and Worker code consume them. Route-local geometry can remain beside the route or component.

The Cemetery plot map is the reference split for a metaphor scene. `buildCemeteryPlotMap` in `src/lib/cemetery-plot-map.ts` is the pure, deterministic view model: lanes, shared year blocks, lot packing, peak classes, clamped stone heights, weathering classes, depth order and section-zoom cameras, all seeded by id and dated against the latest recorded death rather than the clock. `src/lib/cemetery-plot-geometry.ts` turns graves into drawn marks, and the components in `src/components/cemetery/` render them and own focus, pointer, zoom and selection. `validatePlotMapCapacity` checks the layout constants against the current data (overlapping lots, lane overflow, empty runs, the plain-stone and zoom legibility floors), so growth that breaks the plan fails a test instead of drawing badly.

Existing exceptions are documented rather than treated as the standard: `HomeAltHeroChart` still computes sampling, scales, and SVG geometry in the component (`src/components/home-alt-hero-chart.tsx`), and `BlacklistChart` still derives peak quarters and chart series in-component (`src/components/blacklist-chart.tsx`).

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

Every data-reading visualization requires an equivalent accessible data surface. This may be an adjacent table, an always-present summary, a detail panel, a screen-reader-only structure, or a small-screen list. It does not have to be a duplicated fallback list, but it must expose the same decision-relevant facts when the graphic cannot be perceived or operated. Decorative-summary visualizations may be exceptions when they are not intended to be a complete data-reading surface. The homepage hero cohort chart (`HomeAltHeroChart`) is the current decorative-summary exception: it exposes an SVG role/name and a pointer tooltip (`src/components/home-alt-hero-chart.tsx`), but no equivalent accessible data surface; do not use this exception as a model for data-reading charts.

The Cemetery's Autopsy Register is the plot map's equivalent surface: every grave's cause, death date, peak market cap, peg, record type, epitaph and obituary are server-rendered in the register, which the plan's "Skip the cemetery map" link reaches directly and whose rows each grave's `#<id>` link resolves to.

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

Keep labels concise and concrete. Tickers and compact values may use mono; explanatory prose stays in the core sans face. Avoid serif inside analytical scenes: the Cemetery plot map sets its signposts and colossus chips in sans small caps and its figures and footstone glyphs in mono, and keeps Newsreader to the route heading and the HTML record card, never inside the drawn SVG.

Supply the context needed to avoid misreading:

- metric and unit
- time window
- freshness or as-of time when material
- legend for non-obvious encodings
- methodology link or label for coined scores
- a short caveat where correlation, sample scope, or retained stale data could be mistaken for something stronger

The non-USD share chart labels its latest sample date separately from coverage start and HTTP receipt time. Its cohort amounts and shares are non-null producer observations (an observed empty cohort is zero); absent overall history remains unavailable. Server freshness metadata feeds the existing Alt Pegs page stale-data banner even when a stalled snapshot is returned over successful HTTP.

At-peg occupancy labels use `formatPegOccupancy` from `shared/lib/format.ts`: a non-perfect value that rounds to 100 at the displayed precision is `<100%`, while exactly 100 keeps the normal perfect-record label. This applies to the depeg control board, detail history and comparison table; raw statistics and exports are unchanged.

## Stablecoin Detail Primitives

The `/stablecoin/[id]/` evidence modules share a small set of CSS/HTML visuals under `src/components/stablecoin-detail/`. They are spans with inline offsets rather than SVG, which keeps the static dossier HTML light. Each draws a published field and states its degenerate case explicitly: unavailable is dashed, hatched or "–", and never a zero-width fill, a "0 %" or a green mark. [design-language.md](./design-language.md#stablecoin-detail-module-contract) owns where these sit in a module.

- **`ThresholdGauge`** (`threshold-gauge.tsx`): a collateral ratio, or a hedge coverage ratio read against par, on a clamped **log** track; `ScoreBandSpectrum` cannot serve here because its range mode is fixed to 0–100. Without a fixed `domain`, `resolveThresholdGaugeDomain` picks the tightest track that keeps every mark (the ratio, par and any reviewed marker) unclamped and clear of both ends: 90–125 %, then 75–200 %, else the 50–1,000 % default, which puts par near 23 % of the track and keeps 100–1,000 % legible. On the default track 100 % and 103 % read as one knob; zoomed, they sit about 9 pp apart. Both scale ends are labelled whenever a value is drawn, so a zoomed track never passes for the default one, and par keeps its true position on it. Par (100 %) is always marked. A reviewed minimum collateral ratio (solid tick) and shutdown ratio (dashed tick) are drawn only from a dated, applicable oracle review; with several branches, the lowest MCR is marked and the ranges fold into the card's details. The fill reads over/par in the ok tone and under-collateralized in rose, the "structurally short" slot, never the red `alert` step; within ±0.5 pp of 100 % reads as par. A value beyond the domain pins to the end with an overflow arrow, while every label keeps the true figure; labels stack in up to three lanes rather than overlap. A missing, non-finite or negative ratio draws a dashed empty track labelled "Unavailable" on the default scale. Root `role="img"`, named with the measure and its basis, the value, each marker, any clamp, and the log scale's ends. The caller caps the width so a wide row never strands the knob on an empty track.
- **`ShareMeter`** (`threshold-gauge.tsx`): a compact 0–100 % share of a whole, such as the liquidation backstop as a share of supply or a Backing KPI sub-metric. The fill is neutral by default, because a share is a composition rather than a graded level unless the caller has published cutoffs. A measured zero draws an empty solid track; a missing share draws a dashed track with an "Unavailable" note, so the two never read alike (`LinearGauge` is not reused because it draws a missing value as an empty bar). Root `role="img"`, named with the share, its denominator and the value.
- **`DeploymentStrip`** (`deployment-strip.tsx`): one cell per chain or route, filled by bridge tier in the published `bridgeTierQuality` order (`BRIDGE_TIER_POLICY_ORDER` and `BRIDGE_TIER_CELL_CLASSES` in `shared/lib/classification.ts`). Hue families match the bridge tier pills; tiers the policy scores alike share one fill, so the strip implies no distinction the policy does not make. An opaque or unestablished tier is hatched, never red. Only a route whose bridge component sits at the eligible Control minimum is outlined; a route outside the eligible set is a diagnostic, drawn dashed in its own tier's hue (`BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES`) so the tier stays readable; the home chain carries a house glyph. The best tier reads "Native" on a multi-chain asset and "Single-chain / native" only on a single-chain one (`getBridgeTierLabel`); a chain carrying several routes names each "<chain> · <protocol>". Cell widths follow supply weights only when every cell has one; otherwise cells are equal and the caveat line says the split is unavailable. Names render inline up to six cells, then only the home chain's. Shared failure domains draw as brackets over the cells they span, deduped by the caller with `×N`; an unquantified share reads "share unquantified", never a percent. The legend lists tiers in policy order as solid swatches with counts, which are the whole inventory's totals when the caller passes `legendTotals` (a truncated strip still counts every route), then keys the role channels with the cells' own treatment beside a compact `ControlRoleTag`: the outline for limiting, the dashed tier fill for diagnostics; the home key appears only when drawn. One caveat line carries the caller's caveats (routes drawn of the total, brackets shown of the total) and the equal-width note. The root is `role="group"`; the drawn band is hidden from assistive technology, and screen-reader lists state each cell's tier, role, home mark and share, and each bracket's span and share. No cells renders nothing, and the Bridging module never draws a one-cell strip: a single-chain or lone-route coin degrades to strip form.
- **Station rail parts** (`rail-station.tsx`): `StationLabel` (an 11 px kicker of at most three words), `RailStationChip`, `RailStation` and `RailArrow` are shared by Mint Authority, Redemption, Price feed (sources → aggregator → consumer) and Freeze & seizure (power → scope → used). The parts are presentational; each rail root is `role="img"` with an `aria-label` that spells out every station. A chip is `default`, `terminal` (the rail's end state) or `unknown`: dashed and muted, for an undisclosed or unestablished stage, never a blank chip. Station names stay sentence case in the sans face; by default a name too long for its station truncates, and `wrap` breaks it onto further lines instead, for rails that reflow with their container and must never hide part of a name. An arrow label keeps mono caps only when it is a pure figure with no letters (`isMonoArrowLabel`); any label containing a letter ("1-7 days", "Atomic", "Same day") is sentence-case sans. A rail draws only stations backed by structured fields. A station with no usable data is omitted rather than drawn as zero: Freeze drops its "Used" station when the tracker publishes nothing for the coin, and states a tracked coin's empty record in words ("None recorded"). `RailArrow` runs left to right (`horizontal`), downward below `sm` (`responsive`, for rails that stack on phones), or keyed on the rail's own width (`container`: downward until the nearest `@container/rail` is 36rem wide, then left to right, with the caller flipping its station row at the same threshold), for rails that live in tiles as well as full-width modules.
- **`ScoreBandSpectrum`** (`score-band-spectrum.tsx`): "you are here" on a module's band scale, `role="img"` with a caller-supplied name. `ordinal` mode draws equal segments in published band order and lights the active one; `range` mode sizes segments by real score cutoffs and notches a marker at the score, only where tones derive from those cutoffs. Labels are 11 px sentence case at full muted contrast, sized to the spectrum's own container: the full label from 36rem, the band's optional one-word `shortLabel` below it (the full name moves into the label's `title`), wrapping at spaces and never ellipsized. Below `sm` the inactive labels hide but keep their width, and the active label shows in full, anchored inward at either end of the track.
- **Pillar strip bars** (`pillar-evidence-strip.tsx`): the score bars in the pillar header strips use the same channels. An unscored value is a dashed outline; an unverified mechanism component is hatched with "Unverified · scored N"; the limiting Control input is outlined; and diagnostics are muted and dashed. Control rows carry `ControlRoleGlyph` beside their score, keyed once by a compact `ControlRoleTag` legend. Several non-eligible components of one kind and posture draw as one row with a score range ("57 deployment mint paths"; bridges group by role alone as "N bridge controls"), and a kind with two or more rows gains a scope suffix ("token-wide", "deployments"). Every bar pairs its hue with a text label.

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
- New or compliance-targeted visualizations use a pure view model for transformation and geometry.
- Magnitudes have an appropriate scale plus tested bounds.
- Color is redundant with another channel.
- The SVG root role matches whether descendants are interactive.
- Keyboard, touch, and focus behavior match pointer behavior.
- Data-reading visualizations expose an equivalent accessible data surface; any decorative-summary exception is explicitly documented.
- Motion is optional and reduced-motion leaves a complete static state.
- Loading, empty, stale, and error states are explicit.
- Narrow screens and zoom retain readable labels and usable controls.

Break these rules only for a documented reason, such as a very high-density canvas plot or an internal diagnostic surface. Record the tradeoff in the owning route or feature doc rather than adding a global exception here.
