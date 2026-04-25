# Lighthouse Cinematic Engine Implementation Plan

Date: 2026-04-25
Status: Plan only, prepared from current `/lighthouse`, `/chains`, DEWS, alt-peg, design, and data-visualization code paths.
Scope: Transform `/lighthouse/` from the current chaptered dashboard scene into a full-page cinematic visualization experience.

## Assumptions

- "Pure no text" means no persistent visible prose, headings, chapter tabs, metric cards, captions, or ledger copy inside the primary cinematic viewport. Accessibility text, hidden semantic headings, JSON-LD, aria labels, and an on-demand or small-screen data fallback still remain required.
- This should reuse existing public data: `useChains()`, `useStabilityIndexDetail()`, `useStressSignals()`, and `useStablecoins()`. No Worker endpoint, D1 migration, scoring change, or new provider.
- The `/chains/` lighthouse and nautical ship language is the visual base, but `/lighthouse/` should recompose it around a central Pharos tower instead of copying the right-edge harbor chart composition.
- Existing dirty `/lighthouse/` files are treated as in-progress work. The execution pass should replace or refactor them surgically, not fold unrelated digest/status changes into the same patch.

## Verified Current State

- `src/app/lighthouse/page.tsx` uses `createClientFeaturePage()`, so the route currently renders the standard breadcrumb, `Pharos Lighthouse` title, beta badge, and lead copy before the experience. This conflicts with the target no-text immersive surface.
- `src/app/lighthouse/client.tsx` already loads the correct high-level datasets in parallel: chains, PSI detail, and stress signals. It also owns selected-harbor state and reduced-motion-aware auto-cycling.
- `src/app/lighthouse/lighthouse-story-shell.tsx` renders visible prose, chapter tabs, panel headers, and status pills. This is the largest mismatch with the desired page.
- `src/app/lighthouse/lighthouse-scene.tsx` is SVG-based and data-backed, but it is still a framed card-like stage with visible map labels, selected readout, and a caption block.
- `src/app/chains/nautical-chart.tsx` contains the best lighthouse base and ship visual vocabulary. The lighthouse geometry is currently nested inside the chart component, so reuse requires extraction or a route-local port.
- `src/app/chains/harbor-map.ts` and `src/app/chains/nautical-scene-math.ts` already provide the harbor data model, log hull scaling, depth layers, wake length, and aggregate fog state expected by `docs/data-visualization.md`.
- `src/components/dews-summary-model.ts` already provides pure DEWS radar geometry, band counts, pointer behavior, and freshness helpers. The rendered `DEWSSummary` component is card/text-heavy and should not be embedded directly.
- `src/lib/alt-peg-hero.ts` already builds a pure non-USD peg map model from stablecoins. The current rendered atlas includes legends and labels, so `/lighthouse/` should reuse the model, not the whole page component.

## Target Experience

Build **Pharos Night Engine**: a single immersive stage inside the existing app shell.

The first viewport should be one cinematic SVG scene:

- Central lighthouse on a rocky island, based on the `/chains/` Pharos lighthouse geometry.
- Rotating Fresnel lens and beam as the main inspection mechanic.
- Chain harbors as ships and islands arranged around the lighthouse.
- DEWS radar as storm/radar energy projected through or around the lens.
- Alt-peg map as a secondary cartographic projection or archipelago of non-USD peg islands.
- No visible explanatory copy. Users read the scene by interacting with glyphs, beams, pulses, wakes, and icon-only controls. Screen readers and fallback surfaces still receive the exact data.

## Success Criteria

- First paint is a full immersive visual stage with the lighthouse centered and no permanent visible text.
- No horizontal scrolling at desktop, tablet, or mobile widths.
- The visual features all three requested systems: `/chains/` lighthouse/harbor base, DEWS radar, and alt-peg map.
- Every visible mark maps to an existing field and never implies a new score.
- Motion is CSS-only, gated by `prefers-reduced-motion`, and the static reduced-motion scene remains informative.
- Fine pointer, coarse pointer, keyboard, and reduced-motion modes all have a complete interaction path.
- The implementation follows `docs/data-visualization.md`: pure view-model first, SVG scene, centralized colors, floor/ceiling scales, deterministic geometry, and fallback parity.

## Data Encoding Contract

| Layer | Data Source | Visual Encoding | Guardrail |
| --- | --- | --- | --- |
| Central lighthouse | PSI detail current sample | Beam reach, lens brightness, and lens color use PSI score/band | Beam remains an inspection signal, not a new score |
| Chain fleet | `/api/chains` via `useChains()` | Ship/island size by `totalUsd`, order by supply rank, health by `healthBand`, wake by `change7dPct`, draft/pennant by dominant stablecoin share | Reuse harbor math from `/chains`; no chain-specific DEWS implication |
| Tail fleet | `/api/chains` after visible cap | Distant silhouettes/horizon marks | Aggregate only, no hidden ranking beyond supply |
| DEWS radar | `useStressSignals()` | Radar rings, sweep speed, storm arcs, and blips by threat band/count | Aggregate market weather only; not assigned to selected chain |
| Alt-peg map | `useStablecoins()` + `buildPegDiversityHero()` | Non-USD peg islands/map glyphs sized by market cap and colored by peg token map | Non-USD peg geography/cluster story, not chain or safety story |

## Route Architecture

Recommended file shape:

```text
src/app/lighthouse/
  page.tsx                         # custom page, no FeaturePageShell chrome
  client.tsx                       # query orchestration, selection, mode, pointer state
  cinematic-model.ts               # pure root model for all layers
  cinematic-model.test.ts          # cross-layer invariant tests
  lighthouse-stage.tsx             # root SVG/stage renderer
  lighthouse-stage.test.tsx        # structural/a11y/interaction tests
  lighthouse-stage.css             # layer keyframes and responsive sizing
  layers/
    pharos-tower-layer.tsx
    harbor-fleet-layer.tsx
    dews-radar-layer.tsx
    alt-peg-projection-layer.tsx
    atmospheric-layer.tsx
    interaction-overlay.tsx
  lighthouse-a11y-ledger.tsx       # sr-only/compact fallback data surface
```

Keep existing `view-model.ts` only if the final diff is smaller that way. If the cinematic model becomes meaningfully broader than the current harbor-only model, introduce `cinematic-model.ts` and retire the old story model/panels in the same change.

## Page Shell Plan

Replace `createClientFeaturePage()` on `/lighthouse/` with a bespoke route component:

- Emit `BreadcrumbJsonLd` for SEO, but no visible breadcrumb.
- Render one `h1` as `sr-only`.
- Keep metadata in `buildPageMetadata()`.
- Render the dynamic client inside a route-local immersive wrapper.
- Do not change global `src/app/layout.tsx`. The page should fill the content column under the existing sidebar/header shell unless a later design decision explicitly changes app chrome.

This is the first required change because the standard feature shell is the main source of visible text.

## Visualization Engine

### Root Model

`buildLighthouseCinematicModel()` should be pure TypeScript and return:

- `harbor`: visible chain harbor rows, tail fleet, selected id, largest id, aggregate fog band.
- `lens`: PSI score, band, beam reach, beam opacity, lens color, computed timestamp.
- `radar`: DEWS band counts, elevated marks, calm density, highest band, sweep duration.
- `altPeg`: peg clusters, sky/commodity cohorts, market-cap sizes, deterministic positions.
- `stage`: selected visual mode, active target coordinates, reduced content counts, scene summary.

All geometric values should be deterministic. No `Math.random()`.

### SVG Stage

Use one root SVG with a stable viewBox, likely `0 0 1440 900`, scaled by CSS:

- `preserveAspectRatio="xMidYMid meet"` to avoid cropping data marks.
- Stage wrapper `min-height: calc(100svh - app chrome estimate)` with mobile-safe fallbacks.
- CSS variables for layer scale and safe margins, not per-element media-query math.
- Root `role="img"` and a stateful `aria-label`.

Canonical layer order:

1. Atmosphere: sky, stars, water, haze, island shadows.
2. Ambient state wash: PSI light and aggregate harbor fog.
3. Structural guides: faint radar rings, map projection lines, sea grid.
4. Secondary data marks: wakes, reflections, alt-peg constellation threads.
5. Primary data marks: lighthouse, ships, peg islands, DEWS blips.
6. Interaction overlay: selection rings, icon-only controls, focus geometry.
7. Hidden ledger and fallback DOM outside the SVG.

## Component Plan

### `PharosTowerLayer`

- Start from the `/chains/` `Lighthouse` geometry in `nautical-chart.tsx`.
- Preferred execution: extract a parameterized `PharosLighthouseBase` component into a shared visualization path and keep `/chains/` rendering visually identical.
- Fallback execution: port the geometry route-locally into `/lighthouse/` first, then extract later if the shared API becomes awkward.
- Props: `x`, `y`, `scale`, `waterlineY`, `beamTarget`, `beamIntensity`, `lensColor`, `mode`.
- Animations: flame flicker, lens rotation, beam breathe, optional beam sweep.
- Verification: `/chains/` screenshot before/after if extraction touches it; structural test that `/lighthouse/` renders the tower and beam even with missing PSI.

### `HarborFleetLayer`

- Reuse `buildChainHarborEntries()`, `hullWidth()`, `cargoCapacityForHull()`, `depthLayers()`, `wakeLength()`, and `aggregateSkyBand()`.
- Arrange top harbors in a curved harbor orbit around the lighthouse rather than a straight line.
- Use ships for largest harbors and smaller island/lantern marks for tail fleet.
- Remove permanent ship labels from the cinematic stage. Use logo, hull size, wake, color, and selection ring instead.
- Verification: model tests for sort order, floors/ceilings, selected fallback, wake sign, and no `NaN` on null bands.

### `DewsRadarLayer`

- Reuse pure helpers from `src/components/dews-summary-model.ts`.
- Do not embed `DEWSSummary`; it brings cards, legend, labels, and route navigation.
- Render a radar projection as either:
  - a translucent lens overlay around the lighthouse, or
  - a storm/radar disc behind the tower.
- Highest DEWS band controls sweep speed and threat hue using `THREAT_BAND_HEX`.
- Elevated marks can be drawn as blips or lightning needles. Calm dots become faint horizon stars.
- Verification: band count tests, malformed rows ignored, highest-band sweep duration wired, reduced-motion freezes sweep with visible static rings.

### `AltPegProjectionLayer`

- Reuse `buildPegDiversityHero()` and `buildAltPegSnapshot()` from the alt-peg route.
- Do not render atlas headers, legends, or cohort text.
- Render non-USD peg data as either:
  - a cartographic glass projection inside the lighthouse beam, using the existing world-map layer clipped to a lens plate, or
  - an archipelago of peg islands outside the main harbor, with commodity cohorts in the sky.
- Size coin glyphs with `coinEmblemSize()` and use `PEG_CHART_COLORS`.
- Verification: existing alt-peg sizing/packing tests plus a route model test that empty stablecoin data returns an empty but renderable projection.

### `InteractionOverlay`

- Replace chapter tabs with icon-only controls or direct manipulation.
- Default mode: auto-watch, cycling through harbor targets until the user interacts.
- Fine pointer: hover previews, click pins.
- Coarse pointer: first tap previews/pins; explicit icon or second tap opens detail if used.
- Keyboard: every primary mark is focusable, `Enter`/`Space` selects, focus mirrors hover.
- No permanent visible text. Tooltips or a detail drawer may contain text only after explicit interaction, and the stage must work without them.

### `LighthouseA11yLedger`

- Provide the data that visible text used to carry:
  - scene summary
  - current PSI label
  - top harbors with supply, share, health, dominant cargo, wake
  - DEWS counts
  - top non-USD peg cohorts
- Default to `sr-only` on large screens.
- On small screens or when the SVG cannot stay legible, expose a compact fallback list below the stage. This is the only intentional visible text exception and should be limited to accessibility/responsiveness needs.

## Motion Plan

Signature motion:

- Lighthouse beam performs a slow inspection sweep and settles on the selected mark.
- DEWS radar sweep rotates at the existing band-derived speed.
- PSI changes beam reach/opacity, not layout.

Secondary motion:

- Water shimmer and selected-harbor wake drift.
- Pennant drift on ships.
- Lens prism rotation/fresnel glints.
- Alt-peg coin shimmer or subtle orbit for commodity cohorts.
- Distant tail-fleet lights pulse slowly.

Rules:

- CSS keyframes only. No animation frame loop, GSAP, Framer Motion, or canvas.
- Animate `transform` and `opacity`, not layout properties.
- Wrap every animation in `@media (prefers-reduced-motion: no-preference)`.
- Reduced-motion branch sets static opacities and no hidden/invisible marks.
- Auto-cycle must stop after manual selection and must not run under reduced motion.

## Brainstormed Layouts

### Recommended: Central Island Observatory

The lighthouse sits at center-bottom on a rock island. Chain ships orbit across the water, DEWS radar rings sit behind/through the lens, and alt-peg islands appear as a cartographic projection in the beam.

Why: strongest first paint, lighthouse is truly central, and each requested system has a distinct layer.

### Alternate: Lens Room Interior

The existing `/lighthouse/` lens room becomes full-screen. The harbor, DEWS radar, and alt-peg map are projections on glass and horizon panels.

Why not first: it keeps the current "inside a room with panels" direction, which is more likely to reintroduce cards and text.

### Alternate: Watchtower Cutaway

Vertical composition from water to lens to sky: chain fleet below, PSI lens in the middle, DEWS storm above, alt-pegs as stars.

Why not first: good story, weaker as a no-text interactive map because users must parse vertical scroll instead of one stage.

## Implementation Sequence

1. **Freeze route goal**
   - Remove the standard feature shell from `/lighthouse/` and establish the sr-only page shell.
   - Keep existing metadata and route docs updated.

2. **Build the cinematic model**
   - Add the root pure model and tests.
   - Reuse current harbor, DEWS, PSI, and alt-peg helpers before adding new math.

3. **Create the static stage**
   - Render atmosphere, central tower, fleet, radar rings, and peg projection without motion.
   - Remove all permanent visible labels/readouts/captions from the stage.

4. **Add interaction**
   - Wire selected target state, preview/pin behavior, keyboard selection, and icon-only controls if needed.
   - Add the hidden/compact fallback ledger.

5. **Add motion**
   - Layer in beam, radar, water, wake, and glint animations behind reduced-motion gates.
   - Verify static reduced-motion rendering manually.

6. **Polish responsiveness**
   - Desktop, tablet, and mobile Playwright screenshots.
   - Confirm no horizontal scroll and no clipped primary marks.
   - Confirm mobile fallback appears only where the visual cannot carry the data alone.

7. **Docs and cleanup**
   - Update `docs/lighthouse-page.md`, `docs/architecture.md`, and `docs/README.md` if route contract or public docs index changes.
   - Do not bump methodology unless the implementation changes scoring, data definitions, or methodology semantics.
   - Remove retired story panels/tests only after their replacement is covered.

## Validation Plan

Targeted tests:

```bash
npm test -- src/app/lighthouse/cinematic-model.test.ts src/app/lighthouse/lighthouse-stage.test.tsx
npm test -- src/app/chains/nautical-chart.test.tsx src/app/chains/nautical-scene-math.test.ts
npm test -- src/components/__tests__/dews-summary.test.tsx src/lib/__tests__/alt-peg-hero.test.ts
```

Design/doc checks:

```bash
npm run check:doc-source-paths
npm run check:verified-doc-links
```

Pre-push gate after implementation:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run test:merge-gate
```

Visual verification:

- Run local app and capture desktop, tablet, and mobile Playwright screenshots for `/lighthouse/`.
- Check `/chains/` screenshot too if the lighthouse base is extracted from `nautical-chart.tsx`.
- Inspect reduced-motion mode with the browser emulation flag.
- Verify the stage has no horizontal scroll and the first viewport remains visually complete.

## Risks And Decisions

- **No visible text vs. data-viz documentation:** `docs/data-visualization.md` expects labels, legends, and caveats. Decision: the cinematic stage may suppress visible text, but semantic labels and a fallback ledger must preserve auditability.
- **DEWS causality confusion:** DEWS must stay aggregate storm/radar context. Do not attach DEWS blips to chain ships.
- **Alt-peg overload:** The non-USD peg map can easily clutter the harbor. Keep it secondary and mode-aware, with strict mark caps and opacity.
- **Shared lighthouse extraction risk:** If extraction touches `/chains/`, require a before/after screenshot or component test. If the extraction grows too broad, port route-locally first.
- **Performance:** SVG is still appropriate at this scale. Cap visible primary marks and avoid JS animation loops.

## Out Of Scope

- New scoring or "lighthouse score".
- Per-chain DEWS attribution.
- New Worker endpoints, D1 tables, cron jobs, or upstream data providers.
- Three.js/canvas unless SVG proves insufficient, which current data volumes do not suggest.
- Primary navigation promotion. Reassess after the cinematic route is stable.
