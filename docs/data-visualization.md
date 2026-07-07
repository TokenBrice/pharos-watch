# Data Visualization Language (Pharos)

This document is the reference for designing and building **narrative data-visualization modules** on Pharos. It is grounded in four shipped case studies that the team has validated as cohesive:

- **Fiat World Atlas** on `/alt-pegs` — celestial/geographic scene of peg diversity (`src/app/alt-pegs/fiat-world-atlas/`, `src/lib/alt-peg-hero.ts`, `src/lib/alt-peg-sizing.ts`, `src/lib/alt-peg-packing.ts`)
- **PSI Lighthouse** on `/stability-index` — beacon scene of the Pharos Stability Index (`src/app/stability-index/psi-lighthouse-scene.tsx`, `presentational.tsx`, `view-model.ts`)
- **DEWS Radar** on `/depeg` — sonar scope of stablecoin stress (`src/components/dews-summary.tsx`, `dews-summary-model.ts`, `src/lib/dews-radar-utils.ts`)
- **Nautical Harbor Chart** on `/chains` — maritime scene of chain supply distribution (`src/app/chains/nautical-chart.tsx`, `harbor-map.ts`, `nautical-scene-math.ts`)

For primitive/semantic tokens, see `design-tokens.md`. For the broader dashboard visual baseline, see `design-language.md` — its "Draw the Metaphor" section states the short version of the rules below; this doc is the long form. Those docs cover cards, typography, tables, and chrome. **This doc covers expressive, metaphor-led visualization surfaces.**

### Metaphor glossary

| Term | Module | Meaning |
|---|---|---|
| Beam / dimmer | PSI | Lighthouse light cone (score) / component pressure bar |
| Cohort / constellation / thread | Atlas | Peg-currency group / index-linked cluster / sibling-highlight line |
| Blip / sweep / scanning | DEWS | Single coin mark / rotating radar arc / radar scope’s center label |
| Harbor / ship / cargo / wake / pennant / draft / fog | Harbor | Chain / deployment / dominant coin / 7d change / dominance share / concentration depth / ambient risk state |

---

## 1. Core principle: metaphor-first design

Every Pharos visualization module leads with a concrete, familiar real-world metaphor. The metaphor is not decoration — it is the semantic carrier.

| Module | Metaphor | Why it fits the data |
|---|---|---|
| Fiat World Atlas | Celestial sky + world map | USD dominates like a sun; other pegs form cohorts (moon, stars, constellations); geographic fiats anchor to real coordinates |
| PSI Lighthouse | Operating lighthouse | A brighter, farther-reaching beam = safer passage. Inverts the usual “more intense = more dangerous” trap |
| DEWS Radar | Military sonar scope | Stress = distance from center; sweep rotation = active, forward-looking surveillance; faster sweep = higher systemic risk |
| Harbor Chart | Renaissance nautical chart | Chains are harbors; stablecoin deployments are ships; supply trend is a wake; concentration is visual draft below the hull |

**Rules for choosing a metaphor:**

1. It must already live in the reader’s head. If you have to explain it, pick another one.
2. It must carry the semantics you need. Lighthouses encode “safe vs. hazard” natively; radar encodes “distant vs. close threat” natively.
3. It must give you a vocabulary. Pharos extends metaphors linguistically: *“Beam Dimmers”* (PSI components), *“Harbor Sweep”* (auto-cycle), *“Scanning”* (radar center label), *“Cohort threads”* (atlas sibling links). Copy reinforces the metaphor.
4. It must respect the data’s polarity. The PSI lighthouse deliberately chose *bright = stable* so the metaphor behaves. If your metaphor pushes the wrong way, invert it or pick another.

**Anti-pattern:** bolting a stock chart type (bar, radar chart, map) onto a page and calling it a visualization. Pharos’ narrative modules earn their screen real estate by telling a story with a consistent scene.

---

## 2. Architecture: pure view-model + presentational scene

Every module splits into two tiers with a hard boundary.

### View-model tier (pure TypeScript, runtime-neutral)

A file (or small set of files) that takes the API response and emits a presentation-ready shape. No React, no DOM, no side effects.

Examples:
- `src/app/stability-index/view-model.ts` — `buildPsiComponentData`, `buildPsiBeamDimmers`, `buildPsiHistoryStats`, `buildPsiContributorRows`
- `src/app/chains/harbor-map.ts` — `buildChainHarborEntries` (sort, cargo manifest extraction), `buildChainHarborModelFromEntries` (cap-at-8, aggregation)
- `src/app/chains/nautical-scene-math.ts` — `hullWidth`, `cargoCapacityForHull`, `depthLayers`, `wakeLength`, `aggregateSkyBand`, `nextHarborSweepId`
- `src/components/dews-summary-model.ts` — `computeBandCounts`, `resolveRadarClick`, `getAggregateFreshnessTimestamp`, plus internal `computePositions`
- `src/lib/alt-peg-hero.ts` — `buildPegDiversityHero`; sizing floors/ceilings in `src/lib/alt-peg-sizing.ts` (`SIZE_FLOOR`, `FIAT_MAP_SIZE_CEIL`, `SKY_COHORT_SIZE_CEIL`); overlap resolution in `src/lib/alt-peg-packing.ts` (`resolvePackedCoinOverlaps`)

These files are the **first thing you write and the first thing you test.** They encode the visualization’s invariants and make the presentational layer trivial to change.

### Presentational tier (React + SVG + CSS)

Consumes the view-model output and renders the scene. Where motion is needed, the component injects CSS variables and lets CSS keyframes drive animation. It does not own business logic.

The split means:
- A designer can rework the scene without touching data rules.
- A data change (new signal, new threshold) flows through the view-model and its tests first.
- Tests target invariants (monotonicity, floors, ordering) rather than pixels or snapshots.

---

## 3. Data-to-visual encoding

### Channel budget

Pharos modules reliably encode 4–6 dimensions per scene by stacking channels. Target 3–5 primary channels; 6 is the ceiling — above that, split into two scenes or route detail into a fallback list. Channels in order of cognitive weight:

- **Position (radial distance, x/y, anchor to geography)** — the strongest channel; reserve for the most important dimension.
- **Size (radius, width, length)** — rank/magnitude; always non-linear (see scaling rules below).
- **Color (hue)** — category or band. Pulled from centralized token maps; never local hex.
- **Motion (rotation, pulse rate, flicker)** — urgency, temporal recency, or system activity.
- **Glow/opacity/depth layers** — secondary magnitude or concentration.
- **Shape variants (`sun-core` / `moon` / `star` / pennant width)** — cohort membership.

**Redundant encoding is a feature.** Color alone is never load-bearing — always paired with position, size, or motion. Band hex stays consistent across the module and the legend.

### Non-linear scaling (required)

Real stablecoin/chain data spans 6–8 orders of magnitude. Linear scales collapse the long tail into a single dot. Every shipped module uses one of:

- `sqrt(x)` — Fiat World Atlas coin sizing (`coinEmblemSize` in `src/lib/alt-peg-sizing.ts`)
- `log10(x + 1)` — Nautical harbor hull width (`hullWidth` in `nautical-scene-math.ts`)
- **Piecewise band zones with within-band linear interpolation** — DEWS radar radial position: each threat band owns a fixed radial slice, and `scoreToRadius(score, band)` in `src/lib/dews-radar-utils.ts` interpolates linearly inside that slice. The non-linearity is in the slice boundaries, not the per-band scale.
- **Linear interpolation over a clamped score range** — PSI beam reach `0.4 + 0.6 * (score/100)`, opacity `0.25 + 0.47 * (score/100)`

**Every size has a floor and a ceiling.** No element collapses to zero; none dominates the frame. Examples:

- Atlas — `SIZE_FLOOR = 16` and `FIAT_MAP_SIZE_CEIL = 30` in `src/lib/alt-peg-sizing.ts`
- Harbor — `HULL_MIN_WIDTH = 28` in `nautical-scene-math.ts`
- Atlas responsive — `--peg-coin-scale` / `--peg-hit-scale` in `peg-hero.css`

Floors and ceilings belong in the view-model with explicit tests.

### Clamp, don’t crash

Inputs are hostile. Feed the view-model `-50`, `250`, `NaN`, `null`, unknown band names, empty arrays. Every case study has tests that assert graceful fallback:
- PSI scene clamps score to `[0, 100]` and falls back to neutral `#888` for unknown bands.
- Harbor map excludes null `healthBand` from aggregations so unrated chains don’t pull the average.
- Radar filters malformed entries in `computeBandCounts`.

---

## 4. Scene composition

### Layer stack

Build the scene as an ordered layer stack from atmospheric background to interactive foreground. Canonical order:

1. **Atmospheric background** — sky gradient, starfield, water gradient; `aria-hidden`.
2. **Ambient state wash** — band-tinted overlay covering sky and water (PSI sky 0.12, water 0.08; Harbor "fog" sky when ≥30% of rated chains are fragile or concentrated). This makes the *whole scene* reflect the headline state, not just one glyph.
3. **Structural grid** — rings, spokes, waterline, depth ticks, grid, region anchors. Low opacity, `aria-hidden`.
4. **Secondary data marks** — wakes, cohort threads, depth draft, reflections.
5. **Primary data marks** — coins, blips, ships, beacons. These are the focusable units.
6. **Labels** — inline SVG `<text>` for searchability and a11y.
7. **Interactive overlay** — hover cards, tooltips, selection rings, hit-target layer.

Z-order is controlled by DOM order in SVG; supplement with CSS `z-index` only for DOM overlay layers like hover cards (atlas uses z-index `1 → 40`).

### SVG over Canvas, CSS over JS animation

Most Pharos narrative modules are SVG-based. For standard data volumes (≤250 coins, ≤8 primary harbors, ≤50 stars), SVG gives you:
- Real `<text>` for a11y and selection
- Per-element CSS classes and transforms
- Native DOM focus and keyboard handling

Animation is **CSS keyframes**, not JS rAF loops. The React component injects CSS custom properties for values that depend on data (`--psi-pulse-dur`, `--psi-beam-origin-x`, `--nc-beam-angle`). Keyframes stay static. No animation frame loops, no react-spring, no GSAP.

### `prefers-reduced-motion` is a hard requirement

Every animation must be wrapped:

```css
@media (prefers-reduced-motion: no-preference) {
  .my-animation { animation: ... ; }
}
@media (prefers-reduced-motion: reduce) {
  .my-animation { animation: none !important; }
}
```

The scene must remain legible and informative when motion is off. DEWS pauses
the sweep, sets glow to static `opacity: 0.15`, and freezes the center pulse.
PSI shows a static colored lighthouse. Harbor retains positions but freezes
drift. Static labels, legends, and detail panels must preserve the same facts
available during animated states. **The information content never depends on
motion playing.**

---

## 5. Responsive + mobile strategy

At a glance:

| Concern | Rule | Example |
|---|---|---|
| Viewport adaptation | Parameterize the scene with CSS variables; change values per breakpoint, not markup | Atlas `--peg-coin-scale`: `1 / 0.72 / 0.54` |
| Hit targets | Grow on coarse pointer | Atlas `--peg-hit-scale: 1.35`; DEWS 18px invisible hit circle |
| Interaction polarity | Fine = hover/click; coarse = tap to preview, tap again to commit | `resolveRadarClick` in `dews-summary-model.ts` |
| Small-screen fallback | Full-feature parallel list or scale-first inspection when the scene would become unreadable | Harbor fallback list; Atlas responsive `PegDiversityHeroLive` scene with fullscreen inspection |

### Scale-first, not breakpoint-first

The atlas parameterizes the whole scene with CSS custom properties (`--peg-coin-scale`, `--peg-sky-scale`, `--peg-hit-scale`) and changes those values at each breakpoint. All positions and sizes are `calc()` expressions over those variables. One scale change adjusts the entire scene uniformly — no per-element media queries.

The harbor uses a fixed SVG viewBox and `width: 100%`, letting the browser scale the whole scene linearly while preserving `aspect-ratio`.

### Hit targets grow on touch

Small blips need finger-sized touch zones. The atlas bumps `--peg-hit-scale` from `1.0` (desktop) to `1.35` (mobile). DEWS overlays an invisible 18px hit circle on every dot. Ship groups on the harbor are tall enough to tap reliably.

### Pointer-aware interaction

DEWS reads `matchMedia("(hover: hover) and (pointer: fine)")` and runs two interaction models from one component (`resolveRadarClick` in `dews-summary-model.ts`):
- **Fine pointer:** hover to preview, click to navigate.
- **Coarse pointer:** first tap shows the tooltip, second tap navigates. This prevents accidental navigation on touch.

### Parallel list fallback

Below the breakpoint where the scene becomes unreadable, render a screen-reader-friendly list that presents the same data:

- Harbor: no dedicated fallback list ships; small-screen data is served by the always-on horizontally-scrollable `DataTableShell` leaderboard table in `src/app/chains/client.tsx` (the prior `harbor-list.tsx` component was removed as unused).
- Atlas: current mobile strategy is scale-first. One responsive `PegDiversityHeroLive` scene adjusts CSS scale variables per breakpoint and offers fullscreen inspection; there is no shipped `mobile-region-list.tsx` or production `CelestialBand` fallback.

The list is not a degraded experience — it is a first-class surface for small screens and assistive tech. Feature parity is required.

---

## 6. Interaction model

### Hover/focus context

Where multiple elements need to coordinate on a single hovered item, use a **React Context provider** scoped to the scene (`HoverProvider` in the atlas). Consumers derive three states from one hovered id:

- `isHovered(target)` — full emphasis
- `isSibling(target)` — same cohort, visual highlight + opacity 1.0, threads drawn
- `isDimmed(target)` — different cohort; `opacity: 0.58` in `peg-hero.css` (via `.coin-emblem.is-dimmed`)

Fallback functions when the provider is absent keep the component usable outside the scene.

### Keyboard parity with mouse

Primary data marks are `<a>` (atlas) or `<g role="button" tabIndex={0}>` (harbor, radar). `onFocus`/`onBlur` mirror `onMouseEnter`/`onMouseLeave`. `Enter` and `Space` trigger selection. No custom focus-trap logic.

### Selection state lives in the page, not the scene

Selection (`selectedChainId`) is owned by the client route component and passed down. The scene reports selection changes via callback and renders the current state. This keeps the scene testable in isolation and lets a sibling panel (`SelectedHarborPanel`) react to the same state. The DEWS radar instead resolves a coin click by navigating to that coin's own page (`router.push(buildStablecoinUrl(id))`) rather than sharing selection state with a same-page sibling.

### Ambient attention: auto-cycling

Where the scene is passive and contemplative, add a gentle auto-cycle to move the viewer’s attention across the data:
- Harbor: `nextHarborSweepId` cycles the selected harbor every 7s (`HARBOR_LIGHT_SWEEP_MS`).
- DEWS: continuous sweep rotation with duration keyed to worst-band (`2.5s` at DANGER → `12s` at CALM).
- PSI: 10.5s beam rotation.

Auto-cycles must pause under `prefers-reduced-motion` and must yield to user selection.

---

## 7. Typography and labeling

### Inside the scene

- **Font:** `ui-monospace` for numbers and tickers; the core sans token for prose. No serif inside a scene.
- **Size:** 8–11px. Labels are atmospheric, not the main read.
- **Opacity:** 0.45–0.65 for atmospheric labels (“DOMINANCE DRAFT”), 0.8+ for primary (ship names, band counts).
- **Placement:** below or beside the glyph at a fixed offset. Collision avoidance is not attempted at ≤8 labels; at higher density, lean on hover cards instead of more labels.
- **Decorative text:** `aria-hidden="true"`. Semantic text: concrete, announced.

### Outside the scene (scaffolding)

Every module is framed by consistent copy architecture:

1. **Kicker** — small uppercase class `pharos-kicker`, e.g., "The Beacon", "Peg Diversity Atlas", "DEWS: Depeg Early Warning System".
2. **Section title** — `pharos-section-title`, one line with an icon (Compass, Lighthouse, Radar).
3. **Freshness line** — "Updated every 30 min" in muted text.
4. **Legend rail** — size scale, band color key, top-3 cohort strip, wake legend.
5. **Methodology label** — `<MethodologyLabel topic="...">` wraps any coined term that deserves a definition popover.
6. **Caveat line** — short micro-copy that defuses misreads. PSI dimmers carry *"Values from the current PSI sample — not a causal timeline."* Assume the reader will misread; pre-empt it.

Metaphor-extended language is deliberate. Call things "beams," "wakes," "harbors," "cohorts," "blips" where the metaphor applies. Consistency between the scene and the copy is what makes the metaphor legible.

---

## 8. Color and tokens

### Centralize band palettes

Every module reads its color scale from a single token source. Do **not** hardcode hex locally.

- `PEG_CHART_COLORS` — `@shared/lib/classification`
- `PSI_HEX_COLORS` — `@shared/lib/psi-colors`
- `THREAT_BAND_HEX` (DEWS bands) — `@shared/lib/classification`, re-exported via `src/lib/chart-colors.ts`
- `HEALTH_HEX_FILL` — `src/lib/chain-ui.ts`

For the broader colour-in-JS story (Recharts-vs-SVG, `-hex` companions), defer to `design-tokens.md`.

Fallback values (`#888`, `#64748b`) are explicit in the view-model, not scattered.

### Scene-specific palettes

A scene can own a local thematic palette for atmospheric elements — `NAUTICAL_COLORS` in the harbor, sky gradients in the atlas — as long as those colors are not doing data encoding. The rule: *data channels use tokens; atmosphere can own its mood.*

### Deterministic accent colors for long tails

Where the data has unbounded cardinality (every blockchain is a potential chain), synthesize a stable hue from the id:

```ts
let hash = 0;
for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
return `oklch(0.68 0.14 ${hash})`;
```

This gives each new entity a distinct, aesthetically coherent color without a static registry. Known-brand chains still override via a curated map.

### OKLCH for emissive, hex for brand

Glows, halos, gradients, and ambient washes use OKLCH with alpha, which stays perceptually clean across light/dark modes. Band hex values (brand-like) stay hex.

---

## 9. Accessibility

- **SVG root:** non-interactive scenes use `role="img"` + an `aria-label` that summarizes state in one sentence (PSI lighthouse — "Pharos lighthouse — STEADY 72"; harbor chart SVG — "Nautical chart of 8 largest stablecoin chains", inside a `role="group"` scroll wrapper). Scenes with focusable marks use `role="group"` instead, because interactive descendants inside `role="img"` are invalid (axe nested-interactive) — e.g. the DEWS radar ("DEWS radar — 4 elevated, highest: DANGER") carries `role="group"`. `role="img"` lets screen readers treat the scene as one atomic image.
- **Interactive marks:** `role="button"`, `tabIndex={0}`, `aria-label` with the entity name and metric, `aria-pressed` when selected.
- **Decorative layers:** `aria-hidden="true"` on stars, grid, ripples, reflections, atmospheric text.
- **Reduced motion:** animations behind a no-preference media query; reduced-motion branch sets static fallback opacities (don’t leave elements invisible).
- **Fallback list:** full feature parity in a linear DOM when the scene is unavailable or suppressed.
- **Contrast:** inline text against atmospheric backgrounds needs a semi-opaque plate behind it (atlas region tags sit on `oklch(0 0 0 / 0.45)`).

---

## 10. Test patterns

Pharos does **not** snapshot-test visualization scenes. Tests target the view-model and a few structural scene invariants.

### View-model tests (required)

- **Monotonicity:** higher input magnitude produces larger/farther/brighter output.
- **Floors and ceilings:** `computeHullWidth(0)` ≥ `HULL_MIN_WIDTH`; oversized inputs clamp to ceiling.
- **Determinism:** same input produces the same output on every call. Jitter comes from a seeded function of the entity id, not `Math.random()`.
- **Null-resilience:** unrated, undefined, NaN, empty arrays all return sensible defaults.
- **Aggregation correctness:** band counts, share percentages, sort order.
- **Clamp across valid and invalid inputs:** `-50`, `250`, `NaN`, unknown enum values.

### Scene tests (lightweight)

- Role, aria-label, `data-band`, `data-score` attributes are present.
- Color fills come from the token map (`PSI_HEX_COLORS[band]`).
- ViewBox geometry allows overscan for animated motion (beams rotating past the nominal bounds).
- Interaction callbacks fire on click/key events; pointer-aware behavior resolves correctly.
- Hover state propagates: hovering one mark dims the rest.

### Example testable invariants from shipped code

From `nautical-scene-math.test.ts`:
- `hullWidth` is monotonic; floors at 28px; ceils at inner card width.
- `wakeLength` returns 0 under 0.5% change; clamps to ±1 at ±20%.
- `aggregateSkyBand` returns `"fog"` when ≥30% of rated chains are fragile/concentrated.

From `view-model.test.ts`:
- `buildPsiContributorRows` sorts by total impact descending.
- `buildPsiEventTimelineRows` cross-references each event with the worst nearby PSI score, not the event's own date.

From `dews-summary.test.ts`:
- `resolveRadarClick` navigates on single tap with fine pointer; requires two taps with coarse pointer.
- `computeBandCounts` ignores malformed entries.

---

## 11. File layout convention

```
src/app/<route>/
  page.tsx                  # server component, route meta, data fetches
  client.tsx                # client orchestration, selection state, URL filter state
  presentational.tsx        # (optional) layout wrapper when the scene is one of several panels
  <scene-name>.tsx          # the scene component, SVG root
  <scene-name>.css          # keyframes, prefers-reduced-motion gates, CSS-var wiring
  <scene-name>-math.ts      # (optional) pure geometry helpers
  view-model.ts             # pure data transformers
  <fallback-list>.tsx       # small-screen / a11y fallback
  __tests__/                # view-model and structural scene tests
```

Where the scene is shared across routes (e.g., DEWS on `/depeg` and the homepage), lift the scene to `src/components/` and the view-model next to it (`dews-summary-model.ts`).

Shared, runtime-neutral token maps and palette helpers go in `shared/lib/` so both the worker and the client can agree on thresholds and band labels.

---

## 12. Build checklist (new visualization module)

Use this as a pull-request readiness gate.

### Metaphor & framing
- [ ] Chosen metaphor is legible without explanation to a first-time viewer.
- [ ] Metaphor polarity matches the data (good = good direction, risk = risk direction).
- [ ] Copy uses metaphor-extended language consistently (kicker, labels, tooltips, methodology text).
- [ ] Kicker + section title + freshness line + legend rail are present.
- [ ] Every coined or metaphor-extended term is wrapped in `<MethodologyLabel>`.

### View-model
- [ ] A pure TS module owns all data transformation; presentational layer has no math.
- [ ] Unit test: monotonicity (higher input → larger/farther/brighter output).
- [ ] Unit test: floor respected at zero/tiny inputs.
- [ ] Unit test: ceiling respected at oversized inputs.
- [ ] Unit test: null-resilience (null, undefined, NaN, empty array all return sane defaults).
- [ ] Unit test: clamp at out-of-range inputs (negative, above-max, unknown enum).
- [ ] Deterministic jitter (character-sum hash, not `Math.random()`).

### Encoding
- [ ] At least 3 visual channels encode data.
- [ ] Color is never the only channel carrying a data distinction.
- [ ] Non-linear scaling (sqrt / log / piecewise / clamped-lerp) applied to every magnitude channel.
- [ ] Every size has an explicit floor and ceiling with a test.
- [ ] Colors come from a centralized token map; unknown-value fallback is explicit.

### Scene
- [ ] Rendered in SVG, not canvas.
- [ ] Layered in the canonical z-order.
- [ ] Atmospheric layers carry `aria-hidden`.
- [ ] Root SVG has `role="img"` and a stateful `aria-label`.

### Motion
- [ ] All animations wrapped in `@media (prefers-reduced-motion: no-preference)`.
- [ ] Reduced-motion branch sets explicit static opacities so nothing goes invisible.
- [ ] Scene is fully legible with animation off.
- [ ] Auto-cycles yield to user selection.

### Responsive & interaction
- [ ] Scene scales via CSS custom properties, not per-element media queries.
- [ ] Touch hit targets scale up on coarse pointers.
- [ ] Parallel screen-reader-friendly list at small breakpoints with feature parity.
- [ ] Primary marks are keyboard-focusable; Enter/Space activates them.
- [ ] Pointer-aware interaction for destructive/navigating actions on touch.

### Integration
- [ ] Selection state owned by the route client, not the scene.
- [ ] Sibling panels (detail cards, legends, feeds) subscribe to the same selection.
- [ ] View-model helpers exported for reuse where other surfaces consume the same data.

---

## 13. When to break these rules

These patterns exist because they cohere across the four shipped modules. Break them deliberately, not by accident.

- A module with **one value and no categories** (headline KPI) doesn't need the full scene stack. Use a typographic treatment and move on.
- A module that is **pure analytical detail** (a comparison table, a scatter of 1000 points) should use a conventional chart, not a metaphor scene. Metaphor scenes don’t scale to high-density analytical work.
- A **temporary debugging surface** on an internal-only route can skip the fallback list and methodology copy.

If you are breaking a rule, say so in the PR description and explain the tradeoff. The merge gate runs `npm run check:doc-counts`; it doesn't enforce design rules — the reviewer does.
