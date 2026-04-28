# PharosVille Island Redesign Implementation Plan

Date: 2026-04-29

## Scope

Reshape PharosVille from a mostly flat, centered harbor board into a living isometric coastal observatory island:

- Move the lighthouse to a corner headland on an elevated hill or mountain.
- Replace flat pure-blue water and yellow land tiles with authored terrain, depth bands, shore foam, cliffs, grass, roads, rock, beaches, and vegetation.
- Add atmosphere and life through restrained birds, fog, beacon light, lamps, waves, and water motion.
- Preserve the analytical purpose, desktop-only contract, reduced-motion behavior, accessibility ledger, data mappings, API contracts, and existing product shell.

This is a visual/world-layout redesign only. It should not add API endpoints, new data sources, scoring changes, mobile canvas support, or gameplay features.

## Live Implementation Boundary

Only patch the active `/pharosville/` implementation path:

- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/components/*` only when DOM parity, accessibility, HUD, or detail behavior requires it.

Treat legacy or prototype PharosVille/harbor code as out of scope unless a separate cleanup is explicitly requested:

- `harbor-scene-*`
- `layers/*`
- `sprites/*`
- `scene-data/*`
- legacy `reduced-motion-freeze` paths outside the active route contract
- any legacy `palette.ts` usage not imported by the active Canvas renderer

Implementation should not patch inactive code to make the redesign appear complete.

## Assumptions

- The target route is `/pharosville/` only.
- The current Canvas 2D renderer remains the correct rendering layer because the page needs pan, zoom, culling, sprites, hit testing, and 200+ entities.
- Decorative atmosphere can be render-only if it does not encode data.
- Any visual element that encodes data must remain represented in the detail panel, visual-cue registry, or accessibility ledger.
- The current desktop gate remains hard: below `1280px` wide or `760px` tall, the route renders the desktop-only fallback and must not load queries, canvas, manifest, or assets.
- Reduced motion remains deterministic and must not run a continuous animation loop.

## Success Criteria

- The island reads as a shaped coastal settlement with a lighthouse on a corner hill/headland.
- Water has depth, movement, shore foam, and storm/fog zones instead of flat blue fill.
- Ground has terrain variety and elevation instead of flat yellow tiles.
- Birds and atmosphere make the scene feel alive without turning into visual noise.
- Existing route behavior, selection, detail panels, keyboard pan, fullscreen, and accessibility support remain intact.
- Ship routing still occurs only over valid water tiles.
- Canvas backing-store budget and first-render asset cost remain bounded.
- Visual regression changes are intentional and reviewed.
- Documentation reflects the updated current behavior after implementation.

## Non-Goals

- Do not redesign the global Pharos UI.
- Do not add mobile canvas support.
- Do not add runtime data sources, API endpoints, or methodology changes.
- Do not encode new analytical meaning in birds, fog, weather, or decorative props unless the DOM/detail model is updated in the same change.
- Do not add large numbers of PNG assets if procedural drawing can solve the issue.
- Do not use decorative purple/glass/bokeh/orb aesthetics that conflict with the existing harbor palette guardrails.

## Current Architecture Summary

- `src/app/pharosville/page.tsx` mounts the route.
- `src/app/pharosville/client.tsx` enforces the desktop-only media gate.
- `src/app/pharosville/pharosville-desktop-data.tsx` loads data and builds the pure world model.
- `src/app/pharosville/systems/world-types.ts` defines the world model. Current `TileKind` is `deep-water | water | shore | land | road`.
- `src/app/pharosville/systems/world-layout.ts` generates a fixed `64 x 64` map with a central ellipse island, cemetery ellipse, and about `86%` water.
- `src/app/pharosville/systems/pharosville-world.ts` hard-codes the lighthouse at `{ x: 32, y: 31 }`.
- `src/app/pharosville/systems/chain-docks.ts` builds docks from hard-coded `DOCK_TILES`.
- `src/app/pharosville/renderer/world-canvas.ts` is the active Canvas 2D renderer.
- Current terrain rendering uses flat isometric diamonds from `TILE_COLORS`.
- `public/pharosville/assets/manifest.json` already includes terrain assets such as water sprites, but the current renderer does not use them for terrain drawing.
- `src/app/pharosville/renderer/hit-testing.ts` uses rectangle-based hit testing and manifest hitboxes where available.
- `src/app/pharosville/systems/motion.ts` owns ship motion and reduced-motion deterministic behavior.

## Primary Files Likely to Change

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/pharosville.css`
- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/**/*.png`
- `docs/pharosville-page.md`
- `docs/data-visualization.md`
- `docs/design-language.md`, only if the route visual baseline changes materially enough to affect documented design language.

## Primary Tests Likely to Change

- `tests/visual/pharosville.spec.ts`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-narrow-fallback-linux.png`, only if fallback visual changes.
- `src/app/pharosville/systems/world-layout.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/systems/chain-docks.test.ts`
- `src/app/pharosville/systems/clustering.test.ts`
- `src/app/pharosville/systems/motion.test.ts`
- `src/app/pharosville/systems/camera.test.ts`
- `src/app/pharosville/systems/projection.test.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `src/app/pharosville/systems/reduced-motion-freeze.test.ts`
- `src/app/pharosville/systems/canvas-budget.test.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `src/app/pharosville/components/*`, if accessibility ledger or detail parity changes.

## Recommended Art Direction

PharosVille should become a living isometric coastal observatory island.

The scene should feel like a vigilant maritime RPG watchpost at dusk:

- Deep navy and teal water.
- Limestone, ochre, moss, and weathered rock land.
- Bronze and warm-gold beacon accents.
- Semantic risk and health colors preserved for data-driven elements.
- Pixel-art or 16-bit texture density, not painterly detail.
- The lighthouse as the unmistakable compositional anchor, watching from a raised corner headland.

The memorable visual idea: PharosVille is not a dashboard skin. It is a data observatory settlement built around a lighthouse on a cliff, with the sea carrying market risk around it.

## Proposed World Composition

### Required Layout Invariants

Implement the reshaped island against explicit invariants, then codify them in tests during the same stage:

- Map remains `64 x 64`.
- Water remains dominant but no longer locked to the old `86.3%` value. Target acceptable range: `76%` to `84%` water after reshape.
- Lighthouse anchor moves to the northeast headland at target tile `{ x: 44, y: 18 }`.
- Lighthouse anchor must not be inside the central island band: reject positions with `28 <= x <= 36` and `26 <= y <= 36`.
- Lighthouse anchor terrain must be elevated: `hill`, `rock`, `cliff`, or equivalent elevated metadata.
- Headland must have at least one water-facing cliff edge and a road/stair connection back toward town.
- Harbor cove sits on the southwest/lower island side, with docks on cove edges and at least one adjacent valid water tile per dock.
- Ship route samples, cluster anchors, dock mooring tiles, and nearest-water helpers must resolve only to water-like tiles.
- Minimum navigable water corridor width around harbor approach should be `3` tiles.
- Cemetery remains separated from the lighthouse headland and docks, preferably on a quieter western or southern lowland edge.
- Region anchors for `storm-shelf` and `data-fog` remain water-dominant and visually distinct from harbor water.

These coordinates are implementation targets, not placeholders. If the first implementation proves the chosen tile is visibly obstructed by isometric projection, change the invariant deliberately and update tests/docs in the same patch.

### Island Shape

Replace the central ellipse with an authored asymmetric island:

- A raised lighthouse headland in the northeast or southeast corner of the island mass.
- A stepped cliff edge under the lighthouse.
- A cove or harbor basin on the opposite lower side for chain docks.
- A village/town shelf between harbor and hill.
- A cemetery lowland on a quieter outer edge.
- Beaches or shore bands where land meets harbor water.
- Breakwaters, roads, and stairs that connect docks, town, cemetery, and lighthouse.

Keep the map `64 x 64` unless there is a hard rendering reason to change it. The likely best path is a new deterministic mask inside `world-layout.ts`, not a larger world.

### Lighthouse Placement

Move the lighthouse from `{ x: 32, y: 31 }` to the northeast headland target `{ x: 44, y: 18 }`.

The chosen tile should preserve clear sightlines in the existing isometric camera and should not bury ships or docks behind the lighthouse. If visibility requires a minor adjustment, keep the final tile in the northeast headland and update the required layout invariants, tests, and docs in the same change.

The lighthouse should sit on:

- A hill or rock plateau tile.
- Cliff-face shadow tiles on the water-facing edges.
- A narrow road or stair path back to the town.
- A beacon glow or cone directed outward over water.

### Terrain Regions

Introduce richer terrain kinds or tile metadata:

- `deep-water`
- `water`
- `harbor-water`
- `storm-water`, if treated as water by motion and routing.
- `shore`
- `beach`
- `grass`
- `rock`
- `cliff`
- `hill`
- `road`

Prefer extending tile metadata if it avoids making motion and water checks brittle. If new water-like `TileKind` values are introduced, every water predicate must be updated together.

Before adding or using new terrain kinds, centralize terrain predicates in the active world-layout/model layer:

- `isWaterTileKind`
- `isLandTileKind`
- `isElevatedTileKind`
- `isRoadTileKind` or equivalent walkable-land predicate

Use those predicates in layout generation, ship routing, nearest-water helpers, clustering, dock/mooring logic, renderer assumptions, and tests. Do not leave duplicated checks such as `kind === "water" || kind === "deep-water"` scattered after this stage.

### Water

Water should read as actual terrain:

- Deep navy at map edges.
- Teal harbor water inside protected coves.
- Darker storm-water shelf in the existing storm/depeg risk area.
- Fog-muted water in the data-fog region.
- Directional diagonal wave strokes aligned to the isometric perspective.
- Shoreline foam on coast and breakwaters.
- Limited wakes only where already supported by the current capped wake strategy.

Avoid per-pixel procedural water, full-canvas filters, or unbounded particle systems.

### Ground

Ground should no longer read as flat yellow:

- Grass and ochre terrain variation on the main island.
- Sand/beach tiles near shoreline and harbor.
- Rock and cliff tiles on elevated headland edges.
- Dirt or stone roads connecting docks, village, cemetery, and lighthouse.
- Sparse vegetation clusters on hill ridges and cemetery edges.
- Small village lamps, crates, posts, and roof highlights as procedural details or limited sprites.

### Atmosphere

Atmospheric additions should be restrained overlay passes:

- Beacon glow or cone from lighthouse.
- Distance haze/fog bands over far water and data-fog zones.
- Subtle storm shelf darkening tied to existing storm/depeg zones.
- Warm pin-lights in village or harbor.
- Small foam and wave shimmer.

Reduced motion should render atmosphere as static, deterministic shapes.

Split atmosphere into two implementation lanes:

- Decorative lane: birds, warm lamps, minor foam, and non-semantic texture. These need no DOM changes if they do not encode analytics.
- Encoded lane: storm haze, data fog, beacon status, sea/weather intensity, or anything tied to PSI, DEWS, freshness, missing evidence, or peg risk. These require same-stage updates to `visual-cue-registry.ts`, `detail-model.ts`, and `components/accessibility-ledger.tsx`.

Do not call an encoded atmospheric visual decorative just because it is drawn on canvas.

### Birds and Life

Birds should be ambient life, not analytics:

- 5 to 12 total gull silhouettes.
- A few circling the lighthouse headland.
- A few crossing open water on long loops.
- Optional perched birds on cliff or dock posts.

Implementation rules:

- Non-interactive.
- Excluded from hit testing.
- Do not overlap logos, ships, selected targets, or panel-critical canvas areas.
- In reduced motion, draw birds in static positions or omit flight loops.
- Do not let birds encode risk state unless the detail/ledger model is updated.

## Implementation Strategy

Use staged changes. Each stage should be independently reviewable and reversible.

### Stage 1: Establish Terrain Palette and Renderer Structure

Goal: make later visual changes surgical.

Files:

- `src/app/pharosville/systems/palette.ts`, if not already present or if route-local canvas colors need extraction.
- `src/app/pharosville/renderer/world-canvas.ts`
- `scripts/check-pharosville-colors.mjs`, only if palette guardrails need update.

Work:

- Audit whether the existing `src/app/pharosville/systems/palette.ts` is used by the active renderer or only legacy harbor code.
- If it is legacy-only, either create an active renderer palette module intentionally or keep carefully named constants in `world-canvas.ts`.
- Define route-local semantic color groups for `sea`, `land`, `stone`, `beacon`, `ship`, `cemetery`, `selection`, and `atmosphere` only in code imported by the active renderer.
- Move top-level renderer color constants out of ad-hoc renderer literals where practical.
- Keep canvas colors as literal strings at runtime; do not use CSS variables directly inside draw calls.
- Keep cemetery cause colors sourced from the existing cemetery taxonomy.
- Keep banned visual drift checks intact.

Acceptance criteria:

- Renderer output is either equivalent or intentionally minimally improved.
- No world layout, hit testing, or data behavior changes.
- Palette names describe purpose, not raw hues.

### Stage 2: Reshape the World Layout

Goal: change the island from central ellipse to authored coastal island with a corner hill.

Files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/motion.ts`, only if new water-like tile kinds are introduced.

Work:

- Add or migrate to centralized terrain predicates before adding new terrain kinds or metadata.
- Replace the simple ellipse mask with deterministic region helpers:
  - main island mass.
  - lighthouse headland.
  - harbor cove.
  - cemetery lowland.
  - beach/shore bands.
  - cliff/hill region.
- Move the lighthouse to a corner hill tile.
- Move or adjust `DOCK_TILES` so docks line the new harbor cove and remain adjacent to valid water.
- Update region anchor tiles so cemetery, docks, risk zones, and town elements remain visually separated.
- Keep enough water corridors around docks for ship routes.
- Update any hard-coded center assumptions in dock mooring direction logic.
- Pair this stage with unit tests before renderer work continues.

Acceptance criteria:

- Map remains deterministic.
- Lighthouse tile is `{ x: 44, y: 18 }` unless deliberately adjusted with matching test/doc updates.
- Lighthouse tile is on elevated land, not central flat land.
- Docks remain reachable and adjacent to water.
- Ships route only across water-like tiles.
- Accessibility ledger water ratio text is intentionally updated if ratio changes.
- No new API/data behavior.

Stage-specific tests:

- Lighthouse is not central and sits on elevated terrain.
- Lighthouse has a road/stair connection to the settlement.
- Docks are adjacent to valid water.
- Dock mooring tiles are water-only.
- Cluster anchors are water-only.
- Ship route samples are water-only.
- Water ratio stays within the new accepted range.
- Cemetery bounds do not collide with lighthouse or dock regions.

### Stage 3: Terrain and Water Drawing Upgrade

Goal: make the terrain itself look alive before adding new decorative entities.

Files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `public/pharosville/assets/manifest.json`, only if existing terrain sprites are used or replaced.
- `public/pharosville/assets/**/*.png`, only if sprite replacement is necessary.

Work:

- Replace flat diamonds with terrain-specific tile rendering.
- Draw water depth bands before land.
- Add deterministic wave texture with diagonal perspective.
- Draw shoreline foam and shallows along coast edges.
- Draw beach, grass, road, rock, cliff, and hill tiles with tile-local deterministic variation.
- Precompute or derive coast/cliff/foam edge metadata outside hot draw paths where practical.
- Use existing terrain sprites if they improve quality without adding schema complexity; otherwise keep procedural canvas drawing.
- Keep `ctx.imageSmoothingEnabled = false`.
- Avoid full-canvas expensive effects per frame.
- Avoid per-frame neighborhood scans, random allocation, unbounded arrays, or object churn in tile draw loops.

Acceptance criteria:

- Water no longer reads as pure flat blue.
- Land no longer reads as plain yellow tile fill.
- Elevated lighthouse headland is visible before the lighthouse is drawn.
- Existing canvas budget remains within current limits.
- Reduced-motion frame is deterministic.

Stage-specific tests:

- Canvas budget tests remain within existing backing-store constraints.
- Reduced-motion still produces a deterministic still frame.
- Visual pixel tests are updated to detect natural terrain and water bands instead of only yellow land and pure blue water.

### Stage 4: Lighthouse Headland and Landmark Refinement

Goal: make the lighthouse the compositional anchor.

Files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`, only if footprint/hitbox changes require it.
- `public/pharosville/assets/manifest.json`, only if landmark sprite or anchor changes.
- `src/app/pharosville/systems/visual-cue-registry.ts`, only if meaningful PSI visual encoding changes.
- `src/app/pharosville/systems/detail-model.ts`, only if new meaningful PSI visual details need DOM explanation.

Work:

- Draw cliff base, shadow, and hill platform before the lighthouse.
- Draw lighthouse after terrain and most entities so it remains prominent.
- Add a static or animated beacon glow/cone over water.
- Keep PSI status color/meaning consistent with existing lighthouse semantics.
- Ensure selection ring/hover state remains readable on the new hill.
- Update hitbox only if the visual footprint moves relative to current target bounds.
- If beacon visuals encode PSI, update the visual-cue registry, detail model, and accessibility ledger in this stage.

Acceptance criteria:

- Lighthouse clearly sits on a corner hill/headland.
- Clicking/selecting the lighthouse still opens the correct detail.
- Detail panel and accessibility support still explain PSI semantics.
- Beacon animation is reduced-motion safe.

Stage-specific tests:

- Lighthouse hit-testing still selects the PSI detail.
- Reduced-motion beacon is static.
- Visual cue registry/detail/ledger tests pass if beacon semantics changed.

### Stage 5: Add Atmosphere and Ambient Life

Goal: give the scene life without adding analytical ambiguity.

Files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/motion.ts`, only if shared timing helpers are required.

Work:

- Add a decorative `drawLife` or equivalent pass for birds and warm lights.
- Add an encoded `drawAtmosphere` pass only for fog/storm/beacon visuals that already have or receive DOM parity.
- Add a `drawBirds` pass with a small fixed number of non-interactive gulls.
- Gate bird flight and fog drift on reduced-motion preference.
- Keep all loops bounded and based on current time only when animation is allowed.
- Use stable seeded positions derived from tile coordinates or constants.
- Keep bird count between `5` and `12`.
- Do not allocate random bird/fog data inside the frame loop.

Acceptance criteria:

- Scene feels alive at rest.
- Birds and fog do not cover important data entities.
- Reduced motion produces static birds/fog or omits their animation.
- No hit-testing or DOM changes required for decorative-only elements.
- Encoded fog/storm/beacon visuals remain documented and represented in DOM parity surfaces.

Stage-specific tests:

- Normal-motion visual spec still observes animation-bearing scene behavior.
- Reduced-motion visual/spec path confirms no continuous motion dependency.
- Component tests pass if accessibility ledger/detail copy changes.

### Stage 6: Entity and Village Detail Pass

Goal: integrate ships, docks, cemetery, and village details with the richer terrain.

Files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`, only if footprints change.
- `src/app/pharosville/systems/ship-visuals.ts`, only if visual class mappings change.
- `src/app/pharosville/systems/visual-cue-registry.ts`, if encoded visual cues change.
- `src/app/pharosville/systems/detail-model.ts`, if detail facts must explain changed visuals.

Work:

- Improve dock mooring posts, small crates, ropes, and warm lights.
- Keep ship visual encoding tied to existing fields.
- Preserve capped wakes for selected, top, or recent ships.
- Ensure cemetery mist and tombstones remain visually separated from the new terrain palette.
- Keep selection rings and hover emphasis high contrast.
- Avoid adding decorative clutter to tile areas with dense interactive entities.

Acceptance criteria:

- Existing entity interactions still select the correct row/detail.
- Meaningful visual encodings still match the registry and detail model.
- No decorative detail interferes with labels, logos, or selection.

Stage-specific tests:

- Hit-testing tests for ships, docks, lighthouse, and cemetery still pass.
- Visual-cue registry tests pass if any visual mappings changed.
- Component tests pass for detail panel and accessibility ledger parity if copy changed.

### Stage 7: Asset Pass, Only If Needed

Goal: improve sprite quality without bloating first render.

Files:

- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/**/*.png`
- `src/app/pharosville/systems/asset-manifest.ts`, only if schema changes are unavoidable.
- `src/app/pharosville/renderer/asset-manager.ts`, only if loading behavior changes.
- `scripts/pharosville/validate-assets.mjs`, only if validator categories/caps must change intentionally.

Work:

- Prefer replacing existing PNGs over adding new categories.
- Keep asset IDs stable where behavior is unchanged.
- Preserve anchors, footprints, and hitboxes.
- Keep `requiredForFirstRender` limited to essential first-paint assets.
- Keep terrain sprites deferred unless intentionally promoted with a documented first-render reason.
- Renderer must gracefully fall back to procedural drawing when deferred terrain/decorative sprites are unavailable.
- Bump `style.assetVersion` when asset files change.
- Do not include generation prompts, tokens, URLs, or metadata forbidden by the validator.
- Avoid exceeding the current `34` asset cap unless there is a documented reason and validator/docs are updated intentionally.

Acceptance criteria:

- Asset validator passes.
- No orphan PNGs.
- No missing required first-render assets.
- First render does not wait for decorative assets.
- Hit targets remain aligned with visible sprites.

Stage-specific tests:

- `npm run check:pharosville-assets`
- Focused visual interaction checks for lighthouse, dock, and ship selection after any anchor/hitbox change.

### Stage 8: Route Shell Polish

Goal: make HUD/detail chrome support the upgraded scene without becoming a route redesign.

Files:

- `src/app/pharosville/pharosville.css`
- `src/app/pharosville/components/world-toolbar.tsx`, only if markup grouping is needed.
- `src/app/pharosville/components/detail-panel.tsx`, only if panel hierarchy needs minor adjustment.
- `src/app/pharosville/desktop-only-fallback.tsx`, only if fallback styling changes.

Work:

- Tune shell CSS variables and overlay contrast.
- Keep `.pharosville-shell`, `.pharosville-overlay`, `.pharosville-hud`, and `.pharosville-detail-dock` structure intact where possible.
- Ensure controls stay readable over richer terrain.
- Preserve toolbar semantics and keyboard reachability.

Acceptance criteria:

- Desktop eligible viewport mounts canvas as before.
- Narrow/short viewport fallback still appears and does not load data/assets.
- Detail panel still contains all existing facts, links, members, and close behavior.
- No banned palette drift.

### Stage 9: Tests, Snapshots, and Documentation

Goal: lock down the new current behavior.

Files:

- `tests/visual/pharosville.spec.ts`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-narrow-fallback-linux.png`, only if changed.
- `src/app/pharosville/systems/world-layout.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/systems/motion.test.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `docs/pharosville-page.md`
- `docs/data-visualization.md`
- `docs/architecture.md`, if route/canvas/asset-contract summaries materially change.
- `docs/design-language.md`, if materially affected.

Work:

- Update world-layout tests for the new map shape, water ratio, dock anchors, and lighthouse placement.
- Update motion tests for water-only routing if water kinds change.
- Update hit-testing tests for moved lighthouse or changed sprite anchors.
- Update visual pixel classifiers so they detect richer natural terrain rather than only yellow land and blue water.
- Update screenshots only after reviewing visual diffs.
- Update docs to describe the current renderer, map contract, visual mapping, motion/reduced-motion behavior, asset pipeline, and visual regression expectations.
- Do not update API docs unless API behavior changes, which this plan avoids.
- Do not update methodology docs unless scoring/data-source meaning changes, which this plan avoids.
- Run doc link/source checks if docs are touched.

Acceptance criteria:

- Tests validate intentional behavior, not old ellipse/yellow-blue assumptions.
- Docs describe shipped behavior, not aspirational plans.
- Snapshot changes are limited to intentional visual diffs.

## Detailed Technical Decisions

### Terrain Modeling

Recommended approach:

- Extend terrain with either additional `TileKind` values or a small `terrainVariant/elevation` metadata field.
- Keep water predicates centralized so motion, layout, clustering, and rendering agree.
- Prefer helper predicates such as `isWaterTileKind`, `isLandTileKind`, `isElevatedTileKind`, and `isWalkableLandTileKind` if the model expands.

Reasoning:

Adding many tile kinds without central predicates will create bugs in ship routing and tests. Adding a metadata field can preserve existing water/land checks but may require more renderer branching. The safer implementation depends on the current type shape.

### Island Shape Algorithm

Recommended approach:

- Keep deterministic procedural generation.
- Use layered masks:
  - base island lobe.
  - harbor cutout/cove.
  - lighthouse headland lobe.
  - cemetery lowland lobe.
  - beach band around water-adjacent land.
  - cliff/hill band near lighthouse.
- Avoid random generation.

Reasoning:

This preserves predictable tests, route stability, and visual snapshots while producing an authored shape.

### Water Predicate

If `harbor-water` or `storm-water` become `TileKind` values:

- Update motion routing.
- Update `nearestWaterTile` and `nearestAvailableWaterTile`.
- Update dock mooring logic.
- Update clustering assumptions.
- Update tests that expect only `water` or `deep-water`.

If they are renderer variants layered over existing `water`/`deep-water`:

- Keep motion simpler.
- Encode visual water zones in the renderer or tile metadata.
- Reduce test churn.

Recommendation:

Prefer keeping canonical movement kinds as `water` and `deep-water`, with visual variants derived from position/region or metadata, unless semantic zone distinctions truly require new `TileKind` values. If new water kinds are added, centralized predicates are mandatory before any routing/layout code consumes them.

### Lighthouse Hit Testing

Recommended approach:

- Move the world model tile first.
- Verify whether existing hit testing uses tile position, sprite hitbox, or manifest hitbox for lighthouse.
- Adjust hitbox only if the visible lighthouse no longer matches the target rectangle.

Reasoning:

Hit-testing changes are higher risk than renderer changes. Keep them minimal.

### Atmosphere Rendering

Recommended render order:

1. Background gradient.
2. Water terrain and depth bands.
3. Shore foam and waves.
4. Land, beach, road, rock, hill, cliff terrain.
5. Cemetery ground/context.
6. Buildings and docks.
7. Ships and clusters.
8. Graves and cemetery details.
9. Lighthouse hill/platform details.
10. Lighthouse.
11. Atmosphere that should overlay the world, such as beacon cone, fog, lamps, and birds.
12. Selection and hover cues, unless a specific cue should sit under fog for readability.

Final selection cues should remain the most legible layer.

### Motion and Reduced Motion

Rules:

- Normal motion may animate bird flight, water shimmer, beacon pulse, and fog drift.
- Reduced motion must use static positions and no continuous RAF loop.
- Decorative animation must not be required to understand data state.
- Avoid animating layout or expensive canvas effects.

### Asset Strategy

Preferred order:

1. Procedural canvas improvements for terrain, foam, birds, and fog.
2. Reuse existing manifest terrain assets if they materially improve quality.
3. Replace existing sprites if object quality is the blocker.
4. Add new assets only when needed and within validator limits.

Reasoning:

Procedural details avoid manifest churn, first-render cost, orphan assets, and anchor/hitbox bugs.

## Risk Register

### Risk: Ship routing breaks on asymmetric island

Mitigation:

- Keep water corridors wide.
- Update dock mooring direction logic if it assumes map center.
- Run motion/world tests before snapshot update.

### Risk: Visual tests fail for old color assumptions

Mitigation:

- Update pixel classifiers to detect water/land by broader natural palette bands.
- Keep tests focused on nonblank canvas, water dominance, land visibility, and interactive targets.

### Risk: Lighthouse visual and hit target diverge

Mitigation:

- Move the world model anchor and render anchor together.
- Adjust manifest hitbox or hit-testing only if needed.

### Risk: Decorative atmosphere implies unsupported analytics

Mitigation:

- Keep birds/fog decorative and consistent across data states.
- If any atmosphere maps to DEWS/PSI/peg risk, update registry/detail/ledger in the same stage.

### Risk: Asset manifest bloat

Mitigation:

- Prefer procedural details.
- Keep first-render assets minimal.
- Validate asset cap and orphan rules.

### Risk: Richer terrain buries semantic colors

Mitigation:

- Preserve stronger contrast for ships, selection rings, lighthouse status, and risk/fog regions.
- Keep semantic colors saturated enough against natural terrain.

### Risk: Reduced motion accidentally animates

Mitigation:

- Centralize time-dependent drawing decisions.
- Use static seeded positions in reduced-motion mode.
- Keep reduced-motion tests in the validation set.

### Risk: Patching inactive legacy PharosVille files

Mitigation:

- Follow the live implementation boundary section.
- Confirm imports flow through the active route before editing a file.
- Leave legacy cleanup for a separate explicit task.

### Risk: Hot draw path becomes too expensive

Mitigation:

- Precompute edge/variant metadata where possible.
- Avoid per-frame neighborhood scans and random allocation.
- Keep particle counts capped and static arrays reused.
- Validate canvas budget after terrain and atmosphere stages, not only at the end.

## Validation Plan

Minimum validation for implementation:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
npm test -- src/app/pharosville
npm run test:visual -- tests/visual/pharosville.spec.ts
npm run lint
npm run build
```

Pre-push validation:

```bash
npm run test:merge-gate
```

Focused validation to use during staged work:

```bash
npm test -- src/app/pharosville/systems/world-layout.test.ts
npm test -- src/app/pharosville/systems/pharosville-world.test.ts
npm test -- src/app/pharosville/systems/chain-docks.test.ts
npm test -- src/app/pharosville/systems/clustering.test.ts
npm test -- src/app/pharosville/systems/motion.test.ts
npm test -- src/app/pharosville/systems/camera.test.ts
npm test -- src/app/pharosville/systems/projection.test.ts
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
npm test -- src/app/pharosville/systems/reduced-motion-freeze.test.ts
npm test -- src/app/pharosville/systems/canvas-budget.test.ts
npm test -- src/app/pharosville/components
npm run test:visual -- tests/visual/pharosville.spec.ts
```

Documentation validation, if docs are touched:

```bash
npm run check:doc-source-paths
npm run check:verified-doc-links
```

If the repo has a dedicated typecheck command, run it in addition to `npm run build`. If it does not, `npm run build` remains the app-level type/build gate and `cd worker && npx tsc --noEmit` is unnecessary unless worker/shared runtime changes are made.

After each animation-bearing stage, validate both normal-motion and reduced-motion behavior instead of waiting until final snapshots.

## Recommended Implementation Order

1. Palette and renderer structure.
2. World-layout reshape and lighthouse relocation.
3. Terrain and water rendering.
4. Lighthouse headland and beacon.
5. Birds and atmosphere.
6. Entity/village detail refinement.
7. Asset replacement only if needed.
8. Shell polish.
9. Tests, snapshots, docs, and full validation.

This order keeps risk controlled: world semantics change before visuals depending on them, decorative life stays after terrain readability, and asset churn is delayed until procedural options are exhausted.

## Definition of Done

- PharosVille visually presents a living coastal island with a corner lighthouse on a hill/headland.
- Water, terrain, atmosphere, and birds address the prompt directly.
- Existing desktop-only, reduced-motion, accessibility, and data-parity contracts remain intact.
- Tests and visual snapshots are updated for intentional changes.
- Documentation reflects the shipped behavior.
- No unrelated route, API, methodology, data-source, or global design changes are introduced.
