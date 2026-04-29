# PharosVille Rendering Follow-Up: High And Mid Value Plan

Date: 2026-04-29
Status: implementation-ready follow-up plan
Scope: `/pharosville/` renderer maintainability, hit geometry, layer depth,
motion clarity, cue enforcement, and validation

## Purpose

This plan follows the committed work from the PharosVille rendering,
liveliness, and maintainability handoff. It identifies the remaining high and
mid value opportunities that should be acted on after the current in-flight
sea/rendering pass is resolved.

This is a planning artifact only. It intentionally does not edit route code.

## Assumptions

- The relevant committed implementation range is `origin/main..HEAD`, ending at
  `095f17af2 Improve PharosVille rendering geometry and motion`.
- Current uncommitted sea/rendering work is separately owned. At authoring time
  the worktree also had dirty changes in:
  - `agents/handoffs/2026-04-29-pharosville-map-sea-composition-polish-handover.md`
  - `src/app/pharosville/renderer/world-canvas.ts`
  - `src/app/pharosville/systems/palette.ts`
  - untracked base plan
    `agents/plans/2026-04-29-pharosville-rendering-liveliness-maintainability-plan.md`
- Do not start broad renderer extraction until the active sea/rendering work is
  committed, shelved, or explicitly handed over. Several high-value tasks touch
  `world-canvas.ts`.
- No Worker/API, D1, scoring, methodology, data-source, mobile-canvas, WebGL,
  PixiJS, Three.js, or CSP work is needed for this follow-up.

## Review Summary

Committed work completed meaningful first-frame and contract work:

- Printed water labels and shared `systems/area-labels.ts` placement metadata.
- Area hit testing and follow-selected behavior aligned with printed labels.
- Island/layout rebalance, smaller land bounds, retuned docks/regions/routes,
  and data-building spacing.
- Default/reset camera framing biased toward the authored island mass.
- Initial `renderer/geometry.ts` helper and `drawable-pass.ts` depth sort helper.
- Base motion plan split from selection/effect cue state.
- Motion policy, debug counters, live reduced-motion transition coverage, and
  docs updates.

Validation run during this review:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
git diff --check
```

Results: route unit suite passed (`19` files, `119` tests), asset validation
passed for `28` assets, PharosVille color check passed for `40` non-test source
files, and `git diff --check` passed.

Not run in this review:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Reason: the worktree contains active uncommitted sea/rendering changes that can
intentionally affect screenshots. Run the browser lane after that work is
settled.

## Remaining Opportunity Ranking

### High Value

1. Browser visual signoff for the current map/sea/camera/lighthouse state.
2. Finish shared render geometry adoption for all overlap-prone entities.
3. Replace the per-group sort helper with a real drawable layer/depth pass.
4. Extract renderer modules only after geometry and depth contracts are stable.

### Mid Value

5. Make selected route overlays use real motion-path geometry and audit semantic
   water route continuity.
6. Add measurement/debug counters before any culling or terrain caching.
7. Strengthen cue enforcement for analytical renderer/effect channels.
8. Improve ship/dock density, cluster identity, and selected-entity
   amplification after depth sorting exists.
9. Refine chrome/detail grouping after visual and geometry contracts settle.
10. Defer minimap and sprite animation pilots until budget/depth/geometry are
    proven.

## Success Criteria

- The route has a reviewed desktop screenshot and passing Playwright route lane
  after current sea/rendering work settles.
- `world-canvas.ts` stops owning duplicate placement math for ships, docks,
  buildings, graves, lighthouse, labels, and selection rings.
- Hit testing, drawing, selected/follow anchors, and debug targets use shared
  geometry and the same motion samples.
- Cross-kind overlap order is predictable through a typed drawable pipeline, not
  only category draw order.
- Renderer extraction reduces `world-canvas.ts` into an orchestrator without
  changing pixels except where a phase explicitly accepts a visual change.
- New analytical visual effects carry cue/DOM/reduced-motion parity in the same
  patch that introduces or changes them.
- Reduced motion remains one deterministic frame with no RAF loop.
- The desktop viewport gate remains unchanged and is covered before handoff.

## Phase 0 - Coordination And Visual Baseline

Goal: close the current in-flight sea/rendering loop before maintainability work
starts.

Primary files to inspect, not blindly edit:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/palette.ts`
- `agents/handoffs/2026-04-29-pharosville-map-sea-composition-polish-handover.md`
- `tests/visual/pharosville.spec.ts`
- `tests/visual/pharosville.spec.ts-snapshots/*pharosville*`

Tasks:

- Run `git status --short --untracked-files=all`.
- Identify which dirty files are owned by the active sea/rendering workstream.
- If the dirty sea/rendering work is still active, do not edit
  `world-canvas.ts` or `palette.ts` for architecture work yet.
- Once settled, run the browser route lane and inspect screenshots:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

- Manually inspect at least:
  - `1440 x 1000` reduced motion first frame
  - normal motion after 10-20 seconds
  - `1280 x 760` threshold viewport
  - below-gate resize from mounted desktop
  - selected lighthouse, dock, top ship, stressed ship, cluster, water area,
    data building, and grave
- Update snapshots only after confirming the visual changes are intentional.

Acceptance:

- Browser screenshots show no detached sea overlays, label clipping, lighthouse
  double-grounding, or toolbar/detail occlusion.
- Playwright route lane passes or failures are recorded with exact follow-up
  ownership.
- No architecture extraction starts while sea/rendering ownership is unclear.

## Phase 1 - Close Shared Render Geometry

Goal: make `renderer/geometry.ts` the single source for draw points, sprite
scale, target rectangles, follow anchors, and selection anchors.

Primary files:

- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/renderer/hit-testing.test.ts`

Tasks:

- Expand geometry helpers to return a complete entity geometry record:
  - semantic tile
  - sampled tile for moving ships
  - draw point
  - draw scale
  - asset scale
  - manifest hitbox rect when an asset exists
  - fallback target rect
  - label/follow anchor
  - selection-ring rect or anchor
  - depth tile
- Replace remaining duplicate math in `world-canvas.ts`:
  - `drawLighthouse()` should use shared lighthouse geometry.
  - `drawThematicBuildings()` should keep using shared building geometry.
  - `drawDocks()` should use shared dock draw point and scale.
  - `drawShips()` should use shared ship draw point and asset scale, not local
    `p.y + 12 * zoom` and `scale * 0.7` copies.
  - `drawGraves()` should use shared grave geometry.
  - `drawSelectionRing()` should use the same geometry/target source used by
    hit testing.
- Keep `areaLabelPlacementForArea()` as the semantic label-placement source for
  renderer, hit testing, and follow-selected behavior.
- Add tests that prove renderer and hit geometry stay aligned:
  - ship with manifest asset and sampled motion tile
  - lighthouse manifest hitbox and beacon anchor
  - grave marker/logo placement
  - printed area label anchor and hitbox at zoomed-out camera
  - selected/follow anchor uses sampled ship position

Acceptance:

- No duplicated ship/dock/building/area label anchor math remains outside
  `geometry.ts` except for purely visual effects such as wakes or glows.
- Focused tests pass:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
npm test -- src/app/pharosville
```

- Expected screenshot delta is none or limited to intentional selection-ring
  alignment fixes.

Risk controls:

- Do this before renderer extraction.
- Do not import legacy `systems/isometric.ts`.
- Do not change asset manifest geometry unless a test proves the current
  manifest is wrong.

## Phase 2 - Drawable Layer And Depth Pipeline

Goal: replace category draw-order assumptions with a route-local drawable pass
for overlap-prone entities.

Primary files:

- `src/app/pharosville/renderer/drawable-pass.ts`
- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `tests/visual/pharosville.spec.ts`

Implementation shape:

```ts
interface WorldDrawable {
  kind: string;
  pass: "underlay" | "body" | "overlay" | "selection";
  entityId?: string;
  detailId?: string;
  depth: number;
  screenBounds: { x: number; y: number; width: number; height: number };
  tieBreaker: string;
  draw(ctx: CanvasRenderingContext2D): void;
}
```

Tasks:

- Keep sky, terrain, printed water labels, broad non-entity atmosphere, and DOM
  overlays outside the drawable pass.
- Create drawables for overlap-prone entities:
  - lighthouse body/beacon overlay
  - building glow/body/procedural effect
  - dock body/flag overlay
  - ship wake/body/sail-logo overlay
  - grave shadow/body/logo overlay
  - cluster body/count overlay
  - selected relationships and selection rings as final selection pass
- Sort by projection-aware depth plus stable tie-breakers.
- Update hit target priority to account for depth where overlapping visible
  bodies compete. Keep selected and hovered boosts.
- Add a small overlap fixture or test world that places a dock/ship/building
  close enough to prove draw and hit priority agree.

Acceptance:

- No entity draws in front of another entity contrary to its isometric depth.
- Moving ship hit targets still follow sampled motion positions.
- Selected relationship overlays remain selected-only and do not clutter the
  full map.
- Tests:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
npm test -- src/app/pharosville
npx playwright test tests/visual/pharosville.spec.ts --grep "interaction|normal motion|desktop canvas shell"
```

Risk controls:

- Do not force static terrain or labels into the pass.
- Keep this as a renderer-local refactor unless tests reveal a missing semantic
  placement field.

## Phase 3 - Renderer Module Extraction

Goal: reduce `world-canvas.ts` from a 3,000-line all-purpose file into an
orchestrator.

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- new modules under `src/app/pharosville/renderer/layers/`
- `src/app/pharosville/renderer/README.md`

Recommended first modules:

- `draw-context.ts`
- `canvas-primitives.ts`
- `layers/sky.ts`
- `layers/terrain.ts`
- `layers/water-labels.ts`
- `layers/lighthouse.ts`
- `layers/buildings.ts`
- `layers/docks.ts`
- `layers/ships.ts`
- `layers/cemetery.ts`
- `layers/relationships.ts`
- `layers/selection.ts`

Tasks:

- Extract one category per patch.
- Preserve the public `drawPharosVille(input)` entrypoint.
- Keep semantic decisions in `systems/`; renderer layers consume world nodes,
  geometry helpers, assets, and motion state.
- Keep shared primitive functions in one local module instead of duplicating
  canvas helpers across layers.
- Update `renderer/README.md` after each meaningful ownership split.

Acceptance:

- `world-canvas.ts` becomes an orchestrator and shared helper surface, not the
  home of every rendering detail.
- Visual snapshots are unchanged except for intentional changes already
  approved in earlier phases.
- Focused checks:

```bash
npm test -- src/app/pharosville
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell"
```

Risk controls:

- Do not combine extraction with sea palette, lighthouse art, cluster redesign,
  or minimap work.
- Avoid circular imports between renderer layers and systems.

## Phase 4 - Motion Path And Semantic Water Clarity

Goal: make selected motion cues explain the route model without implying
transfers or issuer operations.

Primary files:

- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/renderer/layers/relationships.ts` or current
  relationship rendering module
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/motion.test.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Replace straight selected ship relationship lines with sampled route geometry
  from `motionPlan.shipRoutes` where practical:
  - current ship position to next relevant route segment
  - home dock route
  - risk-water route
- Keep selected dock overlays capped to top associated ships.
- Audit `motion.ts` water-kind routing. It currently has local water-kind logic
  that should be reviewed against `isWaterTileKind()` and semantic terrain:
  - harbor water
  - brackish stale-evidence water
  - alert water
  - warning water
  - storm water
  - frozen water
  - deep water
- Decide whether transit paths should traverse all semantic water kinds or only
  generic/deep water. If changing, add tests proving risk routes start and end
  on matching semantic water without crossing land.
- Expose debug fields only if needed for browser assertions, such as selected
  route segment point count or selected relationship count.

Acceptance:

- Selected ship route overlay follows the same path model used by motion
  sampling.
- Detail panel and ledger continue to describe route source, risk water, home
  dock, chain presence, and docking cadence.
- Tests:

```bash
npm test -- src/app/pharosville/systems/motion.test.ts
npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"
```

Risk controls:

- Do not imply transfers, bridge volume, transaction flow, issuer operations,
  or executable liquidity.
- Keep all route motion on the single route-owned clock.

## Phase 5 - Measurement Before Caching

Goal: add evidence before optimizing draw cost.

Primary files:

- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/systems/canvas-budget.ts`
- renderer layer modules after Phase 3
- `tests/visual/pharosville.spec.ts`

Tasks:

- Add debug-only counters:
  - approximate frame draw duration
  - visible tile count
  - drawable count by pass
  - moving ship count
  - active motion loop count
  - backing-store pixel count
- Add visible-tile culling only if the current renderer still draws clearly
  offscreen work after pan/zoom.
- Do not add offscreen terrain caches until measurements show they are needed.
- If a terrain cache is introduced later, include aggregate backing-store
  accounting for main canvas plus cache buffers.

Acceptance:

- Normal motion frame cadence is observable in debug state.
- Ultrawide backing-store budget remains bounded.
- Reduced motion still draws only deterministic static frames after setup or
  explicit camera/asset changes.

Validation:

```bash
npm test -- src/app/pharosville
npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion|ultrawide|reduced motion"
```

## Phase 6 - Cue Enforcement And Effect Metadata

Goal: ensure new analytical visuals cannot ship as canvas-only meaning.

Primary files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`

Tasks:

- Add an explicit structure for renderer/world effects before adding more
  effects:
  - analytical effects carry a `cueId` or typed cue reference
  - ambient effects are explicitly marked `nonData: true`
  - each analytical effect has a reduced-motion equivalent
- Enforce coverage in tests:
  - every meaningful building type has a cue
  - every analytical area/building/ship/cluster effect maps to a cue
  - no analytical cue relies on color alone
  - cue source/failure/DOM/reduced-motion fields are populated
- Update detail/ledger copy in the same patch as any new analytical visual.

Acceptance:

- `WorldEffect` is no longer just a loose annotation if it carries analytical
  meaning.
- No new visual cue exists only in pixels.
- Tests:

```bash
npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts
npm test -- src/app/pharosville
```

## Phase 7 - Density, Selection Identity, And Cluster Readability

Goal: improve scanability after geometry and depth are reliable.

Primary files:

- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/ship-visuals.ts`
- renderer ship/dock/cluster layers
- `src/app/pharosville/systems/detail-model.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Audit default `1440 x 1000` density by zone:
  - EVM bay
  - top outer-chain docks
  - risk waters
  - long-tail clusters
- Add deterministic lane offsets where ships stack too tightly.
- Keep permanent labels off individual ships.
- Amplify identity on hover/selection:
  - brighter selected sail logo/outline
  - selected dock flag/ribbon emphasis
  - route overlays remain selected-only
- Redesign cluster markers to feel like fleet markers, not generic count pills,
  while preserving exact member lists in DOM.

Acceptance:

- Top stablecoins remain individually recognizable at default zoom.
- Long-tail entities do not obscure harbors or risk areas.
- Reduced motion keeps static representative placements.
- DOM cluster details remain exact.

## Phase 8 - Chrome, Detail Panel, Minimap, And Animation Deferrals

Goal: keep orientation improvements scoped after renderer contracts are stable.

Recommended order:

1. Detail panel grouping and concise cue/caveat scanability.
2. Toolbar/status rail refinement if the first-frame chrome still dominates.
3. Minimap/survey inset only after geometry, depth, and backing-store budget
   are proven.
4. Sprite animation pilot only after asset and motion contracts are proven.

Non-goals for this phase:

- No dense filters or tables inside the canvas route.
- No minimap before tests for backing-store budget, reduced-motion freeze, and
  viewport gate behavior.
- No broad sprite animation. Pilot one low-risk asset only if a concrete visual
  problem remains.

## Validation Matrix

Focused route checks:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
```

Renderer and hit geometry:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
```

Motion:

```bash
npm test -- src/app/pharosville/systems/motion.test.ts
npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"
npx playwright test tests/visual/pharosville.spec.ts --grep "reduced motion"
```

Visual/browser:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Build/static checks when route shell, CSS, docs, assets, screenshots, or static
output are affected:

```bash
npm run lint
npm run typecheck
npm run build
npm run seo:check
```

Before pushing deploy-impacting work:

```bash
npm run test:merge-gate
```

## Recommended Sequencing

1. Settle and validate the ongoing sea/rendering work.
2. Phase 1 shared geometry closure.
3. Phase 2 drawable layer/depth pipeline.
4. Phase 3 renderer module extraction.
5. Phase 4 motion path and semantic-water clarity.
6. Phase 5 measurement/debug counters before caching.
7. Phase 6 cue enforcement as a standing gate.
8. Phase 7 density and selection identity.
9. Phase 8 chrome/minimap/animation deferrals only when earlier phases are
   stable.

Do not bundle these into one implementation session. The safest first
maintainability slice is Phase 1 only; the safest visible validation slice is
Phase 0 only.
