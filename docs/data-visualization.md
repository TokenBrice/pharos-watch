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

Safety pillar radars use the absolute numeric domain `[0, 100]`; adding a comparison cohort never rescales an unchanged score.

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
- Chart brushes allow dragging any empty track area to replace a selection; the body moves it, edges resize it, and double-click clears it.
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

The global regime bar uses the `stabilityIndex` data-health preset, producer metadata and PSI generation. Non-fresh/failed-refresh evidence gets neutral color and a visibly/accessibly retained as-of observation, not a current-regime claim. Its 30 cells are completed UTC days ending yesterday relative to that generation; missing days stay empty and older rows are excluded.

The non-USD share chart labels its latest sample date separately from coverage start and HTTP receipt time. Its cohort amounts and shares are non-null producer observations (an observed empty cohort is zero); absent overall history remains unavailable. Server freshness metadata feeds the existing Alt Pegs page stale-data banner even when a stalled snapshot is returned over successful HTTP.

At-peg occupancy labels use `formatPegOccupancy` from `shared/lib/format.ts`: a non-perfect value that rounds to 100 at the displayed precision is `<100%`, while exactly 100 keeps the normal perfect-record label. This applies to the depeg control board, detail history and comparison table; raw statistics and exports are unchanged.

Detail price and market-cap charts preserve their series, time-range controls, brushing, crosshairs and accessible data tables. The annotation markers, legends, density strip and their exclusive browser Tape reads are retired. The curated annotation corpus and human review/intake history remain editorial evidence, without a live chart-overlay consumer.

## Stablecoin Detail Primitives

The `/stablecoin/[id]/` evidence modules share a small set of CSS/HTML visuals under `src/components/stablecoin-detail/`. They are spans with inline offsets rather than SVG, which keeps the static dossier HTML light. Each draws a published field and states its degenerate case explicitly: unavailable is dashed, hatched or "–", and never a zero-width fill, a "0 %" or a green mark. [design-language.md](./design-language.md#stablecoin-detail-module-contract) owns where these sit in a module.

- **`ThresholdGauge`** (`threshold-gauge.tsx`): a collateral ratio, or a hedge coverage ratio read against par, on a clamped **log** track; `ScoreBandSpectrum` cannot serve here because its range mode is fixed to 0–100. Without a fixed `domain`, `resolveThresholdGaugeDomain` picks the tightest track that keeps every mark (the ratio, par and any reviewed marker) unclamped and clear of both ends: 90–125 %, then 75–200 %, else the 50–1,000 % default, which puts par near 23 % of the track and keeps 100–1,000 % legible. On the default track 100 % and 103 % read as one knob; zoomed, they sit about 9 pp apart. Both scale ends are labelled whenever a value is drawn, so a zoomed track never passes for the default one, and par keeps its true position on it. Par (100 %) is always marked. A reviewed minimum collateral ratio (solid tick) and shutdown ratio (dashed tick) are drawn only from a dated, applicable oracle review; with several branches, the lowest MCR is marked and the ranges fold into the card's details. The fill reads over/par in the ok tone and under-collateralized in rose, the "structurally short" slot, never the red `alert` step; 99.5 % ≤ value < 100.5 % reads as par. A value beyond the domain pins to the end with an overflow arrow, while every label keeps the true figure; labels stack in up to three lanes rather than overlap. A missing, non-finite or negative ratio draws a dashed empty track labelled "Unavailable", retaining a fixed `domain` if supplied, otherwise the default scale. Root `role="img"`, named with the measure and its basis, the value, each marker, any clamp, and the log scale's ends when available. The caller caps the width so a wide row never strands the knob on an empty track.
- **`ShareMeter`** (`threshold-gauge.tsx`): a compact 0–100 % share of a whole, such as the liquidation backstop as a share of supply or a Backing KPI sub-metric. The fill is neutral by default, because a share is a composition rather than a graded level unless the caller has published cutoffs. A measured zero draws an empty solid track; a missing share draws a dashed track with an "Unavailable" note, so the two never read alike (`LinearGauge` is not reused because it draws a missing value as an empty bar). Root `role="img"`, named with the share, its denominator and the value.
- **`DeploymentStrip`** (`deployment-strip.tsx`): one cell per chain or route, filled by bridge tier in the published `bridgeTierQuality` order (`BRIDGE_TIER_POLICY_ORDER` and `BRIDGE_TIER_CELL_CLASSES` in `shared/lib/classification.ts`). Hue families match the tier pills; equally scored tiers share a fill. An opaque or unestablished tier is hatched, never red. A route at the eligible Control minimum is outlined; a diagnostic is dashed in its tier's hue (`BRIDGE_TIER_DIAGNOSTIC_CELL_CLASSES`); the home chain carries a house glyph. `bandLimiting` outlines the whole band when no cell carries the limiting input. The best tier reads "Native" on a multi-chain asset and "Single-chain / native" on a single-chain one (`getBridgeTierLabel`); multiple routes name each "<chain> · <protocol>". Widths follow finite, nonnegative supply weights only when every cell has one and their total is positive; otherwise widths are equal. Up to six cells, home cells and cells with at least 12 % of the width carry inline names; above six, only a sole home cell is named (multiple home cells show glyphs). Shared failure domains bracket their cells, deduped by the caller with `×N`; absent shares read "share unquantified". The legend groups shared fills in policy order and uses `legendTotals` only when every displayed tier label has a total; otherwise it counts drawn cells. Role keys use the outline or diagnostic fill beside a compact `ControlRoleTag`; the home key appears only when drawn. One caveat line combines caller caveats and, for multiple equal-width cells, "supply split unavailable". The root is `role="group"`; the band is hidden from assistive technology, with screen-reader lists stating each cell's tier, role, home mark and share, and each bracket's span and share. No cells renders nothing; the Bridging module degrades a single-chain or lone-route coin to strip form. An optional bracket `shareNote` qualifies its share ("≥X · N unquantified").
- **Station rail parts** (`rail-station.tsx`): `StationLabel` (an 11 px kicker of at most three words), `RailStationChip`, `RailStation` and `RailArrow` are shared by Mint Authority, Redemption, Price feed (sources → aggregator → consumer) and Freeze & seizure (power → scope → used). The parts are presentational; each rail root is `role="img"` with an `aria-label` that spells out every station. A chip is `default`, `terminal` (the rail's end state) or `unknown`: dashed and muted, for an undisclosed or unestablished stage, never a blank chip. Station names stay sentence case in the sans face; by default a name too long for its station truncates, and `wrap` breaks it onto further lines instead, for rails that reflow with their container and must never hide part of a name. An arrow label keeps mono caps only when it is a pure figure with no letters (`isMonoArrowLabel`); any label containing a letter ("1-7 days", "Atomic", "Same day") is sentence-case sans. A rail draws only stations backed by structured fields. A station with no usable data is omitted rather than drawn as zero: Freeze drops its "Used" station when the tracker publishes nothing for the coin, and states a tracked coin's empty record in words ("None recorded"). `RailArrow` runs left to right (`horizontal`), downward below `sm` (`responsive`, for rails that stack on phones), or keyed on the rail's own width (`container`: downward until the nearest `@container/rail` is 36rem wide, then left to right, with the caller flipping its station row at the same threshold), for rails that live in tiles as well as full-width modules.
- **`ScoreBandSpectrum`** (`score-band-spectrum.tsx`): "you are here" on a module's band scale, `role="img"` with a caller-supplied name. `ordinal` mode draws equal segments in published band order and lights the active one; `range` mode sizes segments by real score cutoffs and notches a marker at the score, only where tones derive from those cutoffs. Labels are 11 px sentence case at full muted contrast, sized to the spectrum's own container: the full label from 36rem, the band's optional one-word `shortLabel` below it (the full name moves into the label's `title`), wrapping at spaces and never ellipsized. Below `sm` the inactive labels hide but keep their width, and the active label shows in full, anchored inward at either end of the track.
- **Failure-scenario route map, clock and steps** (`failure-scenario/route-map.tsx`, `failure-scenario/scenario-clock.tsx`, `failure-scenario/scenario-steps.tsx`, shared marks in `failure-scenario/scenario-glyphs.tsx`, pure model in `failure-scenario/scenario-model.ts`): a curated hypothetical path, not a simulation or Safety Score input. Its reusable record and degradation contract is below.

### Failure-Scenario Record Contract

New scenarios are data-only additions to `data/failure-scenarios.json`; the UI does not look up a coin or protocol. Supply a schema-valid `FailureScenario` from `shared/types/failure-scenarios.ts`, selected by `shared/lib/failure-scenarios.ts`. [Curated Failure Scenarios](./process/failure-scenarios.md) owns validation, evidence and maintainer approval; author records as drafts, never approve them during implementation.

- **Required narrative:** `title`, `thesis`, `premise`, an ordered nonempty trunk of `stages`, `keyFigures`, `defenders`, `falsifiers`, `sources`, `evidencePin` and `review`; `exposure` is a required array that may be empty. Each stage supplies its own short title, actor, action, elapsed label, cost, explanation, evidence status and source references. Coin names, protocol terms, actors, actions, outcomes, branch labels and window copy all come from the record. Only interface chrome, evidence/verdict vocabulary and derived counts/ticks are shared UI text.
- **Summary budgets:** keep the thesis within 25 words and each always-visible prose line within 40 words, with no raw addresses or block heights. The premise's first sentence appears above the map only if it fits that contract; the remainder stays in the path fold. A draft review note that would violate the summary contract stays in that fold instead of beside the always-visible draft marker.
- **Optional branching:** omit `branchPoint` for a linear path of any length. When present, it inserts at least two branches after a non-final trunk stage, with one or more stages per branch and globally unique stage IDs. There is no two-branch limit; branch lengths may differ. All branches rejoin at the next trunk stage. Numbers are path positions: each branch starts after the trunk prefix, and the shared suffix resumes after the longest branch. `route.length` counts the longest path, not every alternative step. The detail list keeps every stage in authored reading order and uses as many columns as fit at wide container widths.
- **Optional stage details:** `missingDefense` draws a lock on the hop leaving that stage; absence draws no lock. `actionIsCode` switches between ordinary prose and a wrapping monospace call path. `targets` add named contract/explorer links only when supplied. Empty exposure omits its fold; sources are numbered in authored order.
- **Responsive route layout:** whole static Tailwind container-query strings switch to the horizontal map at 45rem for paths of 1–5 steps, 61rem for 6–7, 69rem for 8, 78rem for 9 and 86rem for 10. These thresholds are calibrated from a measured 100px minimum node plus its 32px lock connector, 24px extra for the fork brackets, and 56px reserved for the evidence body's padding. The named query measures the evidence ancestor's content box; the map has less usable width after its body's padding, so neither viewport width nor the module's border-box width is the correct comparison. The minimum assumes compact titles: authors must also check that each title fits in at most three lines without overflowing. Word count alone is insufficient; longer titles require shortening the title/path, not forcing the horizontal drawing. A rendered nine-column probe with longer five-word titles required 1268px of map width to meet the three-line budget, more than the roughly 1094–1110px map available at a 1600px viewport; nine columns are not automatically readable merely because the module appears wide. Longer paths deliberately retain the vertical map at every width. Width is based on the longest path, not the branch count. Horizontal lanes have their own labels/thresholds and fork/rejoin brackets; shorter lanes run out to the join. Below the chosen threshold, routes stack on a vertical spine. The alternate drawing is `display: none`, so assistive technology encounters one map.
- **Optional clock:** `elapsed` is always displayed verbatim in the stage row and may be a non-time label. To opt into a to-scale ruler, every stage must use a complete explicit `T+` instant (`T+0`, `T+30min`, `T+1.5h`, `T+7d`, `T+2w`) or forward range (`T+0 → T+1d`). Units are `min`/`m`, `h`, `d` or `w`; only zero may omit a unit. The `(or earlier)` qualifier is accepted. Unsupported prose, missing units, malformed values or reversed ranges omit the entire clock and its heading, not individual steps. A single instant also omits the clock, including when every stage is at a positive instant. Stages need not be time-ordered: the map/list retain causal order while clock flags sort by elapsed time. Day/week banking chains therefore still render, whether or not their labels opt into the clock convention.
- **Optional window:** omit `window` when no interval is meaningful. With a usable clock and forward endpoint times, it draws a brace beneath the axis, labelled with the record's label/duration and captioned with its note. Without plottable times, its authored label, duration and note remain plain text inside the path fold; no time geometry is invented.

The drawings share `StepNumber`: a ruled number box, dashed for hypothetical steps (a premise, or `inferred`/`unverified` evidence), and filled only for the last trunk stage/outcome. Hops are dashed into hypothetical steps and solid into established steps. The open padlock marks an absent defense; its tooltip repeats the defense already available in the collapsed stage row. Every node links to its step and opens/focuses its native disclosure (`revealAnchorId`). The clock uses one swimlane for the shared trunk and one per branch; simultaneous steps fold into one numbered flag, ranges become spans, and the axis has at most eight intervals.

Each stage owns `#failure-scenario-<stageId>` on a native `<details data-scenario-step>`: collapsed, it shows number, title, defense, evidence and the authored elapsed label; expanded, it adds explanation, actor, action/call, optional targets, cost and citations. Expand all / Collapse all operate on every branch as well as the trunk. Evidence is neutral shape, not severity hue: filled disc (verified onchain), half disc (documented), dashed ring (inferred), dotted ring (unverified). Red is reserved for a "Cannot stop it" defender verdict; amber marks missing defenses and drafts. Nothing animates.

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
