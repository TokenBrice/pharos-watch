# PharosVille Rendering, Liveliness, And Maintainability Plan

Date: 2026-04-29
Status: specialist-reviewed handoff plan
Scope: `/pharosville/` visual rendering, code maintainability, motion/liveliness, interaction clarity, and validation

## Purpose

This plan translates the useful ClaudeVille world-mode lessons into a PharosVille-specific implementation roadmap.

Do not copy ClaudeVille's fantasy village. Transfer the contracts: stable world model, durable data concepts as places, active entities as embodied actors, recent/current state as restrained effects, exact truth in DOM, manifest-owned assets, reduced-motion parity, and browser-backed visual validation.

The current PharosVille screenshot shows a strong first implementation, but also the next set of issues:

- The world is visually impressive but less authored than ClaudeVille at first glance: broad patterned sea, heavy ship clusters, dominant lighthouse, large toolbar chrome, and fewer small scene details that clarify scale and activity.
- The renderer is becoming hard to maintain: `src/app/pharosville/renderer/world-canvas.ts` is roughly 3,000 lines and owns sky, terrain, labels, assets, landmarks, effects, actors, relationships, selection, and drawing helpers.
- Drawing and hit testing still duplicate placement math for overlap-prone entities.
- Motion exists and is deterministic, but the motion vocabulary is spread across renderer functions instead of governed by one PharosVille motion budget and cue priority model.
- Visual improvements are now coupled to many unrelated renderer sections, making it easy for a sea-label fix, building effect, or asset tweak to regress hit testing, reduced motion, or DOM parity.

## Current Worktree Note

The worktree is shared and currently dirty in PharosVille files. At review time this included `world-canvas.ts`, `hit-testing.ts`, `motion.ts`, `palette.ts`, `world-layout.ts`, `visual-cue-registry.ts`, a dirty map/sea plan, a new handoff file, and an untracked `src/app/pharosville/systems/area-labels.ts`.

Before implementing this plan, run `git status --short --untracked-files=all` and inspect any touched file. Preserve existing edits. In particular, if `area-labels.ts` or equivalent shared area-label metadata exists, use it instead of creating a duplicate placement table.

## Sources Reviewed

- User screenshots:
  - ClaudeVille world: dense but legible isometric village, strong HUD, minimap, varied scenery, labeled landmarks, active agents, ships, ambient sky/sea, and readable relationships.
  - PharosVille: stablecoin maritime world with toolbar, left app sidebar, large lighthouse, many ships, harbors, semantic water zones, and detail-oriented canvas route.
- ClaudeVille:
  - `docs/visual-experience-crafting.md`
  - `claudeville/src/presentation/character-mode/README.md`
  - `claudeville/src/presentation/character-mode/Camera.js`
  - `claudeville/src/presentation/character-mode/HarborTraffic.js`
  - `claudeville/src/presentation/character-mode/IsometricRenderer.js`
- Pharos:
  - `docs/design-context.md`
  - `docs/design-language.md`
  - `docs/design-tokens.md`
  - `docs/pharosville-page.md`
  - `agents/pharosville/CURRENT.md`
  - `agents/pharosville/VISUAL_INVARIANTS.md`
  - `agents/pharosville/KNOWN_PITFALLS.md`
  - `agents/pharosville/TESTING.md`
  - `src/app/pharosville/**`
  - `public/pharosville/assets/manifest.json`
  - `tests/visual/pharosville.spec.ts`
- Related current plans:
  - `agents/plans/2026-04-29-pharosville-claudeville-design-enhancement-plan.md`
  - `agents/plans/2026-04-29-pharosville-civic-core-implementation-plan.md`
  - `agents/plans/2026-04-29-pharosville-sea-remediation-plan.md`
  - `agents/plans/2026-04-29-pharosville-map-sea-composition-polish-plan.md`

## Specialist Review Outcome

Three read-only specialist reviews were completed on 2026-04-29 and folded into this handoff:

- Visual/design review: move first-frame readability work earlier; toolbar compression should not wait until late; preserve in-flight area-label helper work; keep liveliness spatially attached and non-decorative.
- Renderer architecture/performance review: add shared render geometry before module extraction; use richer drawable metadata than one `sortY`; split base motion routes from selection cues; measure before caching; avoid the legacy `systems/isometric.ts` projection.
- Motion/accessibility/validation review: all route motion must use one motion clock; analytical renderer effects need cue registry parity; add desktop-to-fallback resize tests; define motion caps; make DOM parity a per-phase acceptance gate; strengthen normal-motion browser validation.

## Supersession Notes

Treat this as the broad current handoff. Reuse narrower plans for detailed execution only where they are still current.

- The earlier ClaudeVille-informed plan is useful conceptually, but parts are stale: manifest v2 exists, selected ship/dock relationship overlays exist, the civic core exists, and the route now has a `56 x 56` map with richer water semantics.
- The sea remediation and map/sea composition plans remain the concrete reference for sea labels, water-zone rendering, land shrink, and lighthouse-ground integration.
- This plan should not reopen completed civic-core work unless screenshot or test evidence shows a concrete regression.

## Hard Constraints

- Active route only: `/pharosville/`.
- Keep the desktop gate: below `1280px` width or `760px` height, no world queries, canvas runtime, manifest fetches, sprite decoding, or logo loading.
- Keep Canvas 2D. Do not introduce WebGL, PixiJS, Three.js, CSP relaxations, or a build/runtime dependency for visual polish.
- Keep visual-only changes route-local unless a docs/test reference requires a small update.
- No Worker/API changes, data-source changes, methodology/scoring changes, D1 migrations, supply overrides, or production fixture data.
- Canvas is never the only analytical truth. Every meaningful visual cue needs detail-panel or accessibility-ledger parity.
- Reduced motion remains deterministic and must not run a RAF loop.
- All route motion must flow through one PharosVille motion clock. Do not add independent timers, uncapped CSS animation, sprite animation loops, or minimap animation loops outside the main motion contract.
- Runtime art must come from `public/pharosville/assets/manifest.json`; no Pixellab URLs, prototype paths, or remote art.
- Preserve stablecoin semantics:
  - docks mean top-chain stablecoin supply, not transfers;
  - ship movement means rendered-chain presence and risk-water patrol, not live issuer operations;
  - stale/missing evidence maps to fog/degraded evidence, not storm/depeg risk.

## Design Direction

PharosVille should feel like a dark-first maritime observatory island-city for power users. The tone is precise, vigilant, and authored, not cozy fantasy, not Web3 marketing, and not a generic game skin.

ClaudeVille qualities to adapt:

- Clear first-frame read: major landmarks, active actors, sea/terrain contrast, labels, and navigation chrome all make sense within two seconds.
- Density with hierarchy: many objects are present, but roads, shorelines, labels, and depth order keep the eye moving.
- Motion has jobs: ships move because route state exists; effects move because data state or selection needs emphasis; ambient pieces stay secondary.
- Small details create life without becoming data: lights, water, weather, birds, and wakes are capped and spatially attached.
- UI chrome supports inspection and orientation without covering the world.

Pharos-specific boundary:

- Data density over decoration.
- Semantic color first.
- Exact values and caveats in DOM.
- Printed water labels are a canvas-only map-lettering exception, not a new route typography system. Keep them precise, subdued, and analytical rather than parchment/fantasy.
- Ambient life must be spatially attached to the lighthouse, harbors, risk-water zones, or selected entities. Avoid ambient boats or fish unless they cannot be confused with stablecoin ships.
- Visual states must not imply investment advice, executable liquidity guarantees, complete sanctions coverage, transfer flow, or full transitive dependency exposure.

## Key Gaps

### Visual Rendering

- Water areas have a richer semantic model, but the current view still risks reading as broad patterned water rather than named, cartographic zones.
- Area sign posts and large atmosphere bands are more UI-like than map-like; current in-flight sea plans address this.
- The lighthouse is a strong asset, but its procedural headland/halo can feel double-grounded against the sprite base.
- Ship density is concentrated around harbors and risk areas; individual identity cues can fight each other at default zoom.
- The toolbar is functional but visually dominant in the first frame.
- There is no compact route-local minimap or survey overlay comparable to ClaudeVille's orientation tool.

### Maintainability

- `world-canvas.ts` is too large to keep extending safely.
- Draw order is manual and category-based, not a reusable layer/depth pipeline.
- Drawing and hit testing duplicate placement math for docks, ships, buildings, lighthouse, graves, and areas.
- Some semantic placement data lives in systems, while label/effect geometry risks living only in renderer functions.
- Water and land palette are partly centralized (`palette.ts`) and partly local constants.
- Visual cue registry is descriptive, but not yet a full enforcement point for new visual channels, source fields, DOM parity, reduced-motion equivalents, and failure states.

### Motion And Liveliness

- Ship motion is centralized in `systems/motion.ts`, but building effects, sky, water shimmer, lighthouse, birds, fog, glows, relationship pulses, and wakes use local timing rules.
- `buildMotionPlan(world, selectedDetailId)` currently rebuilds route maps when selection changes; selected/effect cues should be split from base route planning before route overlays become richer.
- There is no single priority order for competing motion: selected entity, risk state, recent change, building activity, ambient life.
- Ambient life is present but sparse compared with ClaudeVille; additions should be deliberate, capped, and spatially attached.
- Manifest v2 reserves animation metadata, but there is no renderer playback path yet.

### Interaction And Inspection

- Detail panel grouping is useful, but visual cue explanations and caveats can be easier to scan.
- Selected ship/dock relationships exist; building-area or dock-zone relationships should remain DOM-only unless there is explicit world-entity linkage.
- Hit targets must continue to track sprite scale, motion samples, visible depth, and any label anchor changes.

### Validation

- PharosVille has strong tests, but renderer modularization, shared geometry, label anchors, layer depth, minimap, sprite animation, resize-to-fallback behavior, and live reduced-motion transitions need additional focused coverage.
- `agents/pharosville/VISUAL_INVARIANTS.md` may lag current map/water-ratio work; update it when the map/sea composition pass finalizes.

## Success Criteria

- First-frame world read improves at `1440 x 1000`: the viewer can identify lighthouse, harbors, active ships, risk waters, civic data core, cemetery, and freeze area without opening docs.
- The first visible slice improves sea labels, unanchored overlays, lighthouse grounding, and toolbar dominance before adding optional ambience or minimap work.
- Visual density remains high but controlled: ship clusters, labels, overlays, and effects do not obscure selection targets or data landmarks.
- Drawing, hit testing, follow-selected, and debug state share geometry and motion samples for overlap-prone entities.
- The renderer is split into small route-local modules with a stable draw pipeline. Future sea, building, ship, and label changes do not require editing a 3,000-line file.
- Any new motion has a named cue, source or non-data purpose, priority, cap, and reduced-motion fallback.
- Any analytical renderer effect carries cue-registry parity or is explicitly marked ambient/non-data.
- Static terrain/label/landmark rendering is cached only if measured or complexity warrants it, and never without aggregate backing-store accounting.
- Every new meaningful visual cue has detail-panel/accessibility-ledger parity and source-field/failure-state metadata in the same phase that introduces it.
- The desktop gate is tested both on initial load and after resizing from mounted desktop to below-gate dimensions.

## Implementation Roadmap

### Phase 0 - Baseline And Ownership

Goal: prevent broad visual work from overwriting active edits or stale plans.

Tasks:

- Run `git status --short --untracked-files=all`.
- Read:
  - `docs/pharosville-page.md`
  - `agents/pharosville/CURRENT.md`
  - `agents/pharosville/VISUAL_INVARIANTS.md`
  - `agents/pharosville/TESTING.md`
  - this plan
  - the map/sea composition plan if touching terrain, sea labels, land bounds, or camera framing.
- Capture a fresh baseline screenshot if implementation changes pixels:
  - existing tracked baseline: `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`
  - optional working artifact: `agents/screenshots/pharosville-rendering-liveliness-before.png`
- Record current stats in implementation notes:
  - renderer file sizes;
  - map size/water ratio;
  - target count;
  - debug `motionFrameCount` behavior in reduced and normal motion;
  - active dirty files that must be preserved.

Acceptance:

- The implementer can state exactly which files are dirty and which plan/docs are authoritative for the slice.
- No behavior changes in this phase.

### Phase 1 - First-Frame Readability Slice

Goal: address the screenshot's visible hierarchy problems before deep architecture work.

Primary references:

- `agents/plans/2026-04-29-pharosville-map-sea-composition-polish-plan.md`
- existing `src/app/pharosville/systems/area-labels.ts`, if present

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/components/world-toolbar.tsx`
- `src/app/pharosville/pharosville.css`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Finish in-flight printed water labels:
  - if `area-labels.ts` exists, use it for renderer drawing, hit testing, and follow-selected label anchoring;
  - do not create a second renderer-only label table;
  - remove wooden post rendering for sea areas;
  - draw order must be `terrain -> printed water labels -> atmosphere/headland/entities/selection`.
- Remove unanchored atmosphere bands over open water.
- Keep water-label typography as canvas map lettering only: precise, subdued, no fantasy/parchment tone.
- Start lighthouse-ground integration where it is safe:
  - shrink/remove detached procedural halo;
  - avoid double-ground under the lighthouse asset;
  - keep road/stair connection readable.
- Compress toolbar chrome enough that it no longer dominates the first frame:
  - keep icon controls and outputs;
  - reduce visual weight and footprint;
  - do not remove keyboard/toolbar affordances.
- Update cue wording when visuals change. Example: if North Froze Pole is no longer a frosted sign, remove that wording from cue registry/details.

Acceptance:

- Named sea areas read as map labels, not UI badges or sign posts.
- No unanchored oval/circle overlays appear over open sea.
- Toolbar is still usable but less visually dominant.
- Lighthouse looks more seated in terrain.
- Area clicks work for `Alert Channel`, `Warning Shoals`, `Danger Strait`, and `North Froze Pole`.
- DOM parity is updated in the same phase: visual cue registry, detail panel or accessibility ledger, and at least one targeted Playwright/text assertion.
- `npm run check:harbor-palette`
- `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts src/app/pharosville/renderer/hit-testing.test.ts`
- `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell"`

Risk controls:

- This phase should be visually meaningful but narrow. Do not add minimap, sprite animation, broad renderer extraction, or new ambient life here.
- Do not weaken desktop gate, reduced motion, or DOM truth.

### Phase 2 - Shared Render Geometry

Goal: remove duplicated drawing/hit-testing math before module extraction and depth sorting.

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- optional new `src/app/pharosville/renderer/geometry.ts` or `src/app/pharosville/systems/render-geometry.ts`

Tasks:

- Add shared geometry helpers consumed by both drawing and hit testing. The helper should return draw point, asset scale, screen bounds, label anchor, and hit-rect inputs for:
  - docks and dock flags/ribbons;
  - ships and sail logos;
  - buildings and procedural effect anchors;
  - lighthouse and headland/beacon anchors;
  - graves and logos;
  - printed area labels;
  - clusters.
- Keep screen/camera/asset math in `renderer/geometry.ts` unless the data is semantic tile placement needed outside Canvas.
- Align hit-test priority with visible geometry where possible, especially for areas, docks, ships, buildings, and graves. Leave full visible-depth priority for the drawable pass.
- Add tests that prove hit targets and rendered anchors stay aligned after geometry changes.

Acceptance:

- Drawing and hit testing use the same geometry for at least areas, docks, buildings, and ships.
- No duplicated area-label anchor math remains between renderer and hit testing.
- `npm test -- src/app/pharosville/renderer/hit-testing.test.ts`
- `npm test -- src/app/pharosville`

Risk controls:

- Do not do broad visual module splitting until shared geometry is in place.
- Do not import the legacy `src/app/pharosville/systems/isometric.ts` for renderer projection or depth.

### Phase 3 - Renderer Module Extraction

Goal: reduce `world-canvas.ts` into an orchestrator after shared geometry exists.

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- route-local modules under `src/app/pharosville/renderer/`
- `src/app/pharosville/renderer/README.md`

Suggested modules:

- `draw-context.ts`
- `canvas-primitives.ts`
- `colors.ts`
- `layers/sky.ts`
- `layers/terrain.ts`
- `layers/labels.ts`
- `layers/landmarks.ts`
- `layers/buildings.ts`
- `layers/docks.ts`
- `layers/ships.ts`
- `layers/cemetery.ts`
- `layers/relationships.ts`
- `layers/selection.ts`

Tasks:

- Move one visual category per patch.
- Keep `drawPharosVille(input)` as the public entrypoint.
- Keep semantic decisions in `systems/`; renderer modules should consume world nodes and geometry helpers.
- Avoid behavior changes during mechanical extraction unless paired with Phase 1 and explicitly tested.
- Update renderer README with module ownership.

Acceptance:

- `world-canvas.ts` becomes a small orchestrator.
- Behavior and screenshots remain unchanged except for intentional Phase 1 changes.
- Focused renderer and PharosVille tests pass.

### Phase 4 - Layer And Depth Pipeline

Goal: make overlap, selection, and future effects predictable.

Primary files:

- `src/app/pharosville/renderer/layers/*`
- optional new `src/app/pharosville/renderer/drawable-pass.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Add a route-local drawable shape with enough metadata for current overlap cases:

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

- Use multiple passes per entity where needed:
  - ship wake underlay, ship body, sail/logo overlay;
  - dock sprite body, flag/ribbon overlay;
  - building glow underlay, building sprite body, procedural effect overlay;
  - grave shadow underlay, marker body, logo overlay;
  - selection and relationship overlays last.
- Use the pass only where depth can overlap. Keep sky, base terrain, printed labels, and DOM overlays direct.
- Sort by renderer projection/tile coordinates from `systems/projection.ts`, with stable tie-breakers by pass, kind, and id.
- Keep hit testing derived from the same rendered anchors and motion samples. For overlap-prone entities, hit-test priority should match visible depth where practical instead of relying only on fixed kind priority.

Acceptance:

- Ships, buildings, docks, and graves no longer visibly draw above/below landmarks contrary to isometric position.
- Selected relationship overlays remain readable and do not globally clutter the scene.
- Hit targets still click every building, dock, ship, grave, area, cluster, and lighthouse in the visual suite.
- Reduced motion remains one deterministic frame.

Risk controls:

- Do not force every simple shape into the drawable pass.
- Preserve clickability before and after depth sorting.

### Phase 5 - Measurement, Culling, And Conditional Caching

Goal: buy performance headroom only where measurement or complexity warrants it.

Primary files:

- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/renderer/layers/terrain.ts`
- `src/app/pharosville/systems/canvas-budget.ts`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Add frame timing/debug counters first:
  - frame duration or approximate draw cost;
  - visible tile/entity counts;
  - active motion loop count;
  - optional cue family counts.
- Add visible-tile culling before offscreen caching. The map is only `56 x 56`, so full terrain cache may not be the bottleneck.
- Add aggregate canvas budget accounting before introducing offscreen buffers:
  - main backing store;
  - terrain cache, if added;
  - minimap/static survey cache, if added.
- Add static terrain/label/background cache only if frame timing or future complexity justifies it.
- Keep animated water accents, ships, relationship lines, selection, and time-of-day sky outside any static terrain cache.

Acceptance:

- Normal motion keeps a stable frame cadence during ship animation and ambient effects.
- Canvas backing-store budget remains bounded across desktop and ultrawide tests.
- Static cache, if introduced, does not blur pixel art or change hit testing.
- Reduced motion still draws once after setup or explicit camera/asset changes.

Risk controls:

- Do not introduce offscreen cache without aggregate pixel-budget tests.
- Keep cache optional and easy to bypass in debug until validated.

### Phase 6 - Ship, Dock, And Density Clarity

Goal: preserve the "active market as ships" metaphor under load.

Primary files:

- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/clustering.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/ship-visuals.ts`
- `src/app/pharosville/renderer/layers/ships.ts`
- `src/app/pharosville/renderer/layers/docks.ts`
- `src/app/pharosville/renderer/layers/relationships.ts`
- `src/app/pharosville/systems/detail-model.ts`

Tasks:

- Split base route planning from selected/effect cue sets before making selected route overlays richer. Avoid recomputing every ship route and water path just because `selectedDetailId` changes.
- Audit visible ship density by zone at default zoom:
  - top chains/EVM bay;
  - risk zones;
  - long-tail clusters;
  - open-water patrols.
- Add deterministic lane offsets and mooring lanes where ships stack too tightly.
- Keep individual ships for the highest-value or highest-risk assets; push lower-priority long-tail items into clusters sooner if default view becomes unreadable.
- Make selected ship route overlays use existing `motionPlan.shipRoutes` path geometry where feasible, rather than only straight lines.
- Keep selected dock overlays capped to the top associated ships. Current cap of 10 is a good starting point.
- Add hover/selection identity amplification:
  - brighten selected sail logo/outline;
  - show dock ribbon only on hover/selection;
  - avoid permanent labels for every ship.
- Improve cluster markers so they feel like fleet markers, not generic circular badges:
  - still expose exact members in DOM;
  - keep count and risk placement visible;
  - use a semantic marker shape tied to water zone, not a decorative UI pill.

Acceptance:

- At `1440 x 1000`, top stablecoins remain individually recognizable and long-tail entities do not obscure harbors.
- Selected ship route and selected dock relationships clarify the model without making the whole map look like a graph.
- Reduced motion uses static representative placements.
- Motion tests continue to prove water-only samples.
- DOM parity ships with the visual change: detail/accessibility rows describe any new route or cluster cue.

Risk controls:

- Do not imply transfers, bridge volume, or issuer operations.
- Do not use ship scale as linear supply area.

### Phase 7 - Motion Budget And Liveliness Layer

Goal: make the world feel alive without motion noise.

Primary files:

- `src/app/pharosville/systems/motion.ts`
- optional new `src/app/pharosville/systems/motion-cues.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- renderer `layers/*`
- `tests/visual/pharosville.spec.ts`

Tasks:

- Add a PharosVille motion policy in `agents/pharosville/` or `docs/pharosville-page.md`:
  - static: terrain, labels, cemetery markers, dormant buildings;
  - slow: lighthouse beam/fire, water shimmer, fog, selected relationship pulse;
  - medium: ship movement, building activity effects;
  - fast: capped recent-change sparks/wakes only.
- Define priority:
  1. selected/focused entity;
  2. active risk or critical PSI state;
  3. recent supply or data update;
  4. building state;
  5. ambient life.
- Add one shared motion clock. CSS animations must be non-analytical and gated by reduced motion. Sprite/minimap animation frames must freeze under reduced motion.
- Analytical renderer effects must carry a cue registry id, source field, DOM equivalent, and reduced-motion equivalent. Ambient-only effects must be explicitly marked non-data.
- Add concrete caps:
  - selected pulse: one selected entity family at a time;
  - relationship overlays: selected-only;
  - recent wakes/sparks: cap to selected/top/recent sets, not all ships;
  - birds: keep current lighthouse/far-sea count or lower unless measured and reviewed;
  - harbor lights: small fixed list, spatially attached;
  - building effects: capped per building, no unbounded particle loops;
  - no fast cue unless tied to recent data or selection.
- Avoid ambient boats/fish for now because they can be confused with stablecoin ships.
- Add debug/test fields for active loops, sprite frame, minimap frame if present, and motion cue counts.
- Add a live reduced-motion preference transition test:
  - no-preference starts RAF;
  - reduce cancels RAF and freezes samples/frames;
  - no-preference resumes normal motion.

Acceptance:

- Normal motion has visible life after several seconds without overwhelming the user's eye.
- Reduced motion remains information-complete and has no running RAF or independent animation loop.
- Every analytical motion cue has source/failure/DOM parity.
- One targeted Playwright/text assertion verifies DOM parity for any new analytical cue.

### Phase 8 - Asset And Sprite Animation Readiness

Goal: use manifest v2 to support safer asset iteration and eventual sprite-sheet animation.

Primary files:

- `public/pharosville/assets/manifest.json`
- `src/app/pharosville/systems/asset-manifest.ts`
- `src/app/pharosville/renderer/asset-manager.ts`
- `scripts/pharosville/validate-assets.mjs`
- renderer asset drawing modules

Tasks:

- Keep schema v2: `style.cacheVersion` for cache busting and `style.styleAnchorVersion` for provenance.
- Add renderer support for optional `asset.animation` only when a real sprite-sheet pilot is selected.
- Pilot one low-risk animated asset first:
  - recommended: lighthouse flame/beam accent or one building effect sheet;
  - avoid animating all ships/buildings in the first pass.
- Use sprite sheets, not many separate manifest entries.
- Keep reduced-motion frame selection from manifest metadata.
- Regenerate static assets only when screenshot review proves a problem:
  - dock family art direction;
  - building base integration;
  - terrain tiles if procedural terrain cannot reach the desired finish.
- If PNG bytes or geometry change:
  - update manifest dimensions/anchors/hitboxes;
  - bump `style.cacheVersion`;
  - preserve `style.styleAnchorVersion` rules;
  - run asset validation and hit-testing tests.

Acceptance:

- `npm run check:pharosville-assets`
- Asset failures are visible enough in development review without breaking production resilience.
- Animation metadata does not increase first-render critical load unexpectedly.
- Sprite frames freeze under reduced motion.
- Hitboxes remain aligned after asset changes.

### Phase 9 - World Chrome, Detail Panel, And Optional Minimap

Goal: improve orientation and inspection without turning the canvas into a table.

Primary files:

- `src/app/pharosville/components/world-toolbar.tsx`
- `src/app/pharosville/components/detail-panel.tsx`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/pharosville.css`
- optional new `src/app/pharosville/components/world-minimap.tsx` or canvas renderer module
- `tests/visual/pharosville.spec.ts`

Tasks:

- Toolbar compression starts in Phase 1. This later phase can refine the full world chrome after the map composition improves.
- Add a PharosVille status rail only if it clarifies the world:
  - PSI band;
  - active risk counts;
  - rendered ships/clusters;
  - top chain harbors;
  - stale source count.
- Consider a small route-local minimap/survey inset only after geometry/depth/budget work:
  - use the same map/world model;
  - show land/water/major landmarks/viewport;
  - click-to-pan only if tested;
  - update current tests that intentionally assert no minimap.
- Improve detail panel grouping:
  - Facts;
  - Route/placement;
  - Visual cue explanation;
  - Source/freshness/caveat;
  - Members/top rows;
  - Links.
- Do not add dense filters, tables, or methodology prose to the canvas. Keep those DOM-only.

Acceptance:

- First-frame chrome helps orientation and does not dominate the world.
- Detail panel remains concise and exact.
- Any minimap is tested for visibility, click/pan if interactive, backing-store budget, reduced-motion freeze, and route docs.
- Keyboard pan, Escape clear, toolbar controls, and blank-map click-to-close remain intact.

### Phase 10 - Cue Enforcement, Accessibility, And Docs

Goal: keep the artistic route auditable and usable.

Primary files:

- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/systems/detail-model.ts`
- `docs/pharosville-page.md`
- `agents/pharosville/CURRENT.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/TESTING.md`

Tasks:

- Make this a per-phase gate, not a late cleanup. Phases 1, 6, 7, 8, and 9 must ship DOM/cue parity in the same patch that changes meaningful visuals.
- Enforce cue coverage:
  - every meaningful `BuildingType` has a cue;
  - every entity kind with analytical visual meaning has a cue;
  - analytical `WorldEffect` or render-layer effect records carry a `cueId` or equivalent registry link;
  - ambient-only effects are explicitly non-data;
  - each cue has source field, question answered, failure state, DOM equivalent, primary channels, and reduced-motion equivalent where motion is involved.
- Ensure color is not the only load-bearing channel for any new analytical cue.
- Keep accessibility ledger aligned with any new visual cue, status rail, minimap, label behavior, or animation.
- Update route docs for:
  - renderer architecture changes;
  - visual grammar changes;
  - asset manifest/schema behavior;
  - minimap if added;
  - validation expectations.

Acceptance:

- `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts`
- No new analytical visual exists only as pixels.
- Docs and agent pack do not contradict current tests.

## Validation Matrix

Run the narrow checks for the touched slice, then broaden before handoff.

Focused code checks:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
```

Renderer/hit testing:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
```

Motion:

```bash
npm test -- src/app/pharosville/systems/motion.test.ts
npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"
npx playwright test tests/visual/pharosville.spec.ts --grep "reduced motion"
```

Fallback gate:

- Add/maintain Playwright coverage for:
  - `1280 x 760` mounts world;
  - `1279 x 760` does not mount world;
  - `1280 x 759` does not mount world;
  - resizing from desktop to `1279 x 759` removes canvas/minimap, cancels RAF/assets, and makes no further world/manifest/logo requests.

Normal-motion browser validation:

- Use deterministic `page.clock` or equivalent controlled time where feasible.
- After 10-20 seconds:
  - target count is stable;
  - browser console is clean;
  - labels remain clickable/readable;
  - no detached sea overlays appear;
  - selected routes follow `motionPlan.shipRoutes`;
  - active loop/debug counters stay within caps.

Visual/browser:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Build/static checks when route shell, CSS, docs, static output, or screenshots change:

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

Manual review checklist:

- Desktop `1440 x 1000`.
- Fullscreen/ultrawide.
- Short-screen fallback.
- Reduced motion first frame.
- Normal motion after 10-20 seconds.
- Resize from mounted desktop to below-gate dimensions.
- Selected lighthouse, one dock, one top ship, one stressed ship, one cluster, one area, one building, one grave.
- Browser console clean.
- No network requests under fallback viewport.

## Recommended Sequencing

1. Phase 0 baseline and ownership.
2. Phase 1 first-frame readability slice: finish area labels, remove unanchored sea overlays, begin lighthouse grounding, and compress toolbar chrome.
3. Phase 2 shared render geometry.
4. Phase 3 renderer module extraction.
5. Phase 4 depth pipeline.
6. Phase 6 ship/dock density and route clarity.
7. Phase 7 motion budget and liveliness.
8. Phase 5 measurement/culling/cache only when needed by evidence.
9. Phase 9 status rail/minimap/detail grouping only after geometry, budget, and first-frame composition are stable.
10. Phase 8 asset animation pilot.
11. Phase 10 cue enforcement, docs, and full validation throughout.

Do not bundle all phases into one PR or agent session. The safest first implementation slice is Phase 1 only. The safest maintainability slice is Phase 2 only.

## Implementation Handoff Checklist

- Confirm current `git status --short --untracked-files=all`.
- Identify the chosen phase and list touched files before editing.
- Preserve unrelated edits.
- Keep visual semantics in `systems/` first, renderer second, DOM parity alongside.
- When adding visual metadata used by drawing and hit testing, define it once and import it in both places.
- Update tests in the same patch as behavior.
- Update `docs/pharosville-page.md` and `agents/pharosville/*` when contracts change.
- Record commands and outcomes in the final handoff.
