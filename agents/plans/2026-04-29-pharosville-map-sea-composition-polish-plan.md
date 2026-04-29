# PharosVille Map, Sea, And Island Polish Plan

Date: 2026-04-29

## Scope

This is an implementation plan for the next PharosVille visual polish pass. It
targets `/pharosville/` only and covers these requested issues:

- Sea areas should be written directly on the water like labels on a paper map,
  not shown as generic sign posts.
- The island composition should be recentered: less unbalanced empty sea in the
  initial frame, and the island should sit a bit farther left.
- The island should read about 20% smaller, while buildings are redistributed so
  their sprites do not overlap and keep a clear minimum distance.
- Sea zones should be visually distinct and recognizable, not a uniform blue
  field with subtle per-tile differences.
- Random-looking light overlay circles on sea areas should be removed.
- The base island ground should feel coherent with the lighthouse asset and not
  fight the lighthouse hill/base.

No Worker/API, data-source, mobile-canvas, scoring, methodology, or global shell
changes are required.

## Assumptions

- "Reduce island size 20%" means the visible landmass silhouette should shrink
  by roughly 20% in linear width/height, not merely reduce total map tile count.
  Current land bounds are about `35 x 32` tiles (`x=16..50`, `y=16..47`), so a
  first target is about `28 x 26` tiles after reshaping. This implies land tile
  count may fall more than 20% because area scales quadratically.
- "Recenter" is primarily a first-frame composition problem. The current map is
  already numerically centered around `CIVIC_CORE_CENTER = { x: 34, y: 30 }`, but
  `fitCameraToMap()` frames the full `56 x 56` map rather than the authored
  island/sea-interest bounds. The fix should combine a smaller land mask with an
  explicit default composition focus, not blindly move every entity.
- "Random light overlay circles" refers to the deterministic translucent oval
  atmosphere bands drawn over water in `drawAtmosphere()`, plus any decorative
  glow that spills into sea without a data or scene-local purpose. Status glows
  that encode building state should be preserved or reshaped, not deleted
  wholesale.
- The current terrain PNGs in `public/pharosville/assets/terrain/` are
  manifest-valid but are not suitable for direct land/road/shore rendering in
  the active scene. Ground polish should start with procedural renderer
  integration.
- The existing dirty worktree contains PharosVille route changes. Implementation
  should inspect and preserve user/previous-agent edits before touching any
  file.

## Current State Evidence

- `src/app/pharosville/systems/world-layout.ts`
  - Map is `56 x 56`.
  - `buildPharosVilleMap()` water ratio is currently `0.8064`.
  - Current terrain counts:
    - `water`: 1547
    - `deep-water`: 351
    - `brackish-water`: 246
    - `harbor-water`: 133
    - `warning-water`: 80
    - `storm-water`: 72
    - `frozen-water`: 62
    - `alert-water`: 38
    - non-water land/shore/road/elevated terrain total: 607
  - Land bounds are currently `x=16..50`, `y=16..47`.
  - Land centroid is currently `{ x: 34.01, y: 29.99 }`.
- `src/app/pharosville/systems/data-buildings.ts`
  - Building tiles are fixed:
    - Mint/Burn Foundry: `{ x: 29, y: 30 }`
    - Dependency Loom: `{ x: 34, y: 28 }`
    - Yield Orchard: `{ x: 40, y: 30 }`
    - Exit Route Gatehouse: `{ x: 31, y: 34 }`
  - Closest current building pair is Foundry -> Exit Route Gatehouse:
    - tile distance `4.47`
    - isometric center distance about `57.7px` before zoom
  - There is no true building placement/collision solver, only fixed tiles and
    test invariants.
- `src/app/pharosville/renderer/world-canvas.ts`
  - Area signs are drawn by `drawAreaSigns()` -> `drawWaterAreaPost()` as wooden
    posts, flags, boards, and count badges.
  - Sea overlay circles are driven mainly by `ATMOSPHERE_BANDS` and the band
    loop inside `drawAtmosphere()`.
  - Ground is procedural: `TILE_COLORS`, `TERRAIN_TEXTURE`, `terrainColor()`,
    `drawLandTile()`, `drawGrassTexture()`, `drawRoadTexture()`,
    `drawRockTexture()`.
  - Lighthouse sprite already includes a hill/cliff/base, while
    `drawLighthouseHeadland()` adds another large procedural headland and halo,
    creating a double-ground risk.
- `src/app/pharosville/systems/palette.ts`
  - `WATER_TERRAIN_STYLES` already exists for semantic water styles, but the
    palette/mark language is still too close at default zoom.
- `src/app/pharosville/renderer/hit-testing.ts`
  - Area hit targets currently assume sign-like geometry:
    `width=90`, `height=42`, `yOffset=-22`.
  - If area signs become printed labels, area hitboxes should be realigned with
    label anchors and sizes.

## Success Criteria

### Visual Acceptance

- Initial `1440 x 1000` desktop frame shows the island and key sea zones with
  balanced margins. The composition no longer appears top-heavy/bottom-heavy,
  and the island sits slightly farther left than the current snapshot.
- Visible island silhouette is about 20% smaller in linear extent than the
  current `35 x 32` land bounds, while still supporting the lighthouse,
  cemetery, docks, and four data buildings.
- Data buildings have no visible sprite overlap at default zoom, and each pair
  maintains a minimum readable gutter. A practical initial target is at least
  `90px` isometric center distance before zoom, or an equivalent asset-hitbox
  non-overlap invariant if manifest geometry is available.
- Sea area names read like printed cartographic labels on the water:
  `Calm Anchorage`, `Watch Breakwater`, `Alert Channel`, `Warning Shoals`,
  `Danger Strait`, and `North Froze Pole`.
- No wooden sign posts, flags, board panels, or UI-like badges are used for sea
  area labels.
- Sea zones are distinguishable by both color and mark language:
  - harbor/calm water: calm teal, short protected ripples
  - watch/breakwater water: calmer outer current or foam edge
  - alert channel: warm directional current lines
  - warning shoals: ochre shoal patches and broken wave marks
  - danger strait: dark chop, whitecaps, cross-current strokes
  - data fog/brackish water: murk/reed/fog marks
  - frozen water: ice plate/crack language
  - deep water: sparse dark shelf, not a dominant field
- The unwanted translucent oval/circle overlays are gone from open sea.
- Lighthouse, lighthouse hill, cliff/road/grass land tiles, and the base island
  material palette feel integrated. The lighthouse should look seated into the
  terrain rather than pasted over a second mound.

### Contract Acceptance

- Desktop gate remains unchanged: no world runtime below `1280px` width or
  `760px` height.
- Reduced motion remains deterministic and does not run a RAF loop.
- Ships and normal-motion samples remain water-only where existing tests assert
  that contract.
- Area labels remain selectable and details/accessibility still expose counts,
  source fields, and caveats.
- No runtime references to Pixellab candidate paths, remote URLs, or prototype
  assets are introduced.
- Palette guard and asset manifest validation remain passing.

## Implementation Plan

### Phase 0 - Baseline And Safety

1. Run `git status --short` and inspect every dirty file that will be touched.
2. Capture or inspect a current desktop screenshot before code changes:
   - current tracked baseline:
     `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`
   - optional working screenshot:
     `agents/screenshots/pharosville-map-sea-polish-before.png`
3. Record current map statistics from `buildPharosVilleMap()`:
   - water ratio
   - land bounds
   - land centroid
   - terrain counts
   - building pair distances
4. Keep this pass route-local unless a test/doc reference forces a small
   verified-doc update.

### Phase 1 - Replace Sea Signs With Paper-Map Labels

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/world-types.ts` only if label metadata is needed

Steps:

1. Replace `drawAreaSigns()` with `drawWaterAreaLabels()` and stop calling
   `drawWaterAreaPost()` for sea areas.
2. Keep `AreaNode` as the semantic source. Use existing labels from
   `DEWS_AREA_LABELS` and `buildNorthFrozePoleArea()`.
3. Add a small route-local label placement table if hardcoded offsets are
   clearer than expanding the model:
   - per `detailId` or `band`
   - optional `{ dx, dy, rotation, align, maxWidth }`
   - use inward offsets for edge labels such as `Danger Strait` and
     `North Froze Pole` to avoid clipping
4. Render labels directly on water:
   - font: route-local serif stack such as `Georgia, "Times New Roman", serif`
   - uppercase or title-case small caps; use restrained letter spacing only if
     it remains readable
   - low-opacity parchment/ink fill, subtle dark stroke or shadow
   - slight rotation along the water body's axis
   - no board, post, flag, rounded badge, or UI count pill
5. Decide canvas count treatment:
   - preferred: omit counts from the printed label and keep counts in the
     detail panel/accessibility ledger
   - acceptable fallback: tiny suffix in muted ink, not a badge
6. Draw labels after water/terrain textures and before ships/clusters so they
   feel printed under moving entities.
7. Update area hitboxes in `hit-testing.ts`:
   - either keep a generous invisible target centered on the label tile
   - or add per-area label hitbox sizes/offsets mirroring the renderer table
8. Remove `drawWaterAreaPost()` only if it is no longer used. If dock name
   ribbons still need `drawSignBoard()`, keep that helper.

Tests/checks:

- Update `tests/visual/pharosville.spec.ts` if it asserts old sign geometry.
- Add a hit-testing assertion for area targets if not already covered.
- Browser review must click at least `Alert Channel`, `Warning Shoals`,
  `Danger Strait`, and `North Froze Pole`.

Risks:

- Labels can disappear under ships or docks. Control by drawing labels before
  entities but choosing anchors outside dense mooring clusters.
- Edge labels can clip. Control with explicit inward offsets and screenshot
  review.

### Phase 2 - Remove Random Light Overlay Circles

Primary file:

- `src/app/pharosville/renderer/world-canvas.ts`

Steps:

1. Remove or disable the `ATMOSPHERE_BANDS` loop inside `drawAtmosphere()`.
2. Delete `ATMOSPHERE_BANDS` if no longer used.
3. Keep lighthouse-local mist only if it is visually attached to the beacon or
   headland; otherwise reduce its radius/alpha so it does not read as a random
   sea oval.
4. Audit remaining circular glows:
   - `drawDecorativeLights()` / `VILLAGE_LIGHTS`
   - `drawBuildingStatusGlow()`
   - building-specific procedural effects
   - `drawLighthouseHeadland()` halo
5. Preserve encoded building status effects, but reshape them when needed:
   - make them tile-local, clipped/small, or sprite-attached
   - avoid large detached ellipses over open water
6. Do not remove selection rings, hit feedback, or semantic status cues.

Tests/checks:

- Desktop screenshot review: no translucent unanchored circles over sea.
- Reduced-motion visual review: no static rings left behind by animation removal.
- `npm run check:harbor-palette` to ensure no banned visual-language drift.

Risks:

- Removing all glows can flatten the scene. Control by preserving local,
  object-attached light and semantic effects.

### Phase 3 - Recenter Initial Composition

Primary files:

- `src/app/pharosville/systems/projection.ts`
- `src/app/pharosville/systems/camera.ts`
- `src/app/pharosville/pharosville-world.tsx`
- tests in `src/app/pharosville/systems/camera.test.ts` and
  `src/app/pharosville/systems/projection.test.ts`

Preferred approach:

1. Add an explicit interest-bounds framing path instead of fitting the full map
   bounds blindly.
2. Keep `fitCameraToMap()` for generic map fit, but add one of:
   - `fitCameraToBounds()`
   - `mapInterestIsoBounds()`
   - `defaultPharosVilleCamera()` in `camera.ts`
3. Compute interest bounds from authored content, not every empty edge tile:
   - land bounds plus a margin for water labels and storm/frozen zones
   - include `Danger Strait`, `Warning Shoals`, `Alert Channel`,
     `North Froze Pole`, lighthouse, and outer dock labels
4. Apply a small composition bias after fit:
   - move rendered content left by a controlled pixel or viewport fraction
   - adjust vertical offset so top and bottom sea margins are balanced in the
     first frame
5. Use the same camera initializer for initial mount and toolbar reset/follow
   reset in `pharosville-world.tsx`.
6. Keep pan clamps based on the full map, so users can still inspect all areas.

Acceptance targets:

- At `1440 x 1000`, key map content should sit clear of the left nav and right
  detail panel.
- The island should read slightly left of the current snapshot, without hiding
  the lighthouse behind the detail panel.
- `Danger Strait` and `North Froze Pole` labels remain visible or reachable in
  the initial frame.

Risks:

- Framing only interest bounds can over-zoom and partially undo the requested
  20% island-size reduction. Control with max zoom and screenshot review.
- The right detail panel can mask the lighthouse. Control with selected-detail
  screenshot and closed-detail screenshot during review.

### Phase 4 - Shrink Island Footprint By About 20%

Primary files:

- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/motion.ts`
- tests in `world-layout.test.ts`, `pharosville-world.test.ts`,
  `chain-docks.test.ts`, and `motion.test.ts`

Steps:

1. Shrink the island mask around an explicit island focus point. Start from the
   current union in `islandValue()` and reduce the main ellipse radii by about
   20% in linear terms.
2. Do not shrink every auxiliary region equally. Keep enough playable/legible
   land for:
   - lighthouse headland
   - civic data core
   - cemetery
   - southwest harbor/dock coastline
3. After the first shrink, retune:
   - `lighthouseHeadlandValue()`
   - `harborCoveValue()`
   - `harborApproachValue()`
   - `CEMETERY_CENTER` / `CEMETERY_RADIUS`
   - `CIVIC_CORE_CENTER` / `CIVIC_CORE_RADIUS`
   - `isRoadTile()` path points
   - `isCivicPlazaTile()`
4. Update dock and region constants only after the land mask is stable:
   - `EVM_BAY_DOCK_TILES`
   - `OUTER_HARBOR_DOCK_TILES`
   - `PREFERRED_DOCK_TILES`
   - `REGION_TILES`
   - `SHIP_WATER_ANCHORS`
   - `AREA_SIGN_TILES`, or the new area-label placement table
5. Keep each dock on land/shore with at least one adjacent water tile.
6. Keep DEWS area anchors on matching terrain:
   - `ALERT` -> `alert-water`
   - `WARNING` -> `warning-water`
   - `DANGER` -> `storm-water`
   - `data-fog` -> `brackish-water` or `fog-water`
7. Update `world-layout.test.ts` to assert:
   - new land bounds target
   - land centroid/composition target
   - water ratio target
   - deep-water cap
   - all terrain kinds still present
   - lighthouse on elevated terrain
   - road connectivity
   - dock water adjacency
   - cemetery separation

Suggested acceptance thresholds:

- Land bounds roughly `28..31` tiles wide and `25..29` tiles tall, unless visual
  review proves a nearby value is better.
- Water ratio may rise from `0.8064` to around `0.84..0.88`. Do not preserve the
  old `0.78..0.83` contract if it conflicts with the requested shrink.
- Deep-water should remain capped as a narrow shelf, preferably under `12%` of
  all tiles.

Risks:

- A pure geometry shrink can strand buildings or docks on water. Control by
  moving constants in the same patch and running focused tests.
- Shrinking land can make the island feel too sparse if the camera also zooms
  out. Control through Phase 3 camera constraints.

### Phase 5 - Redistribute Buildings With Real Spacing Invariants

Primary files:

- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- tests in `pharosville-world.test.ts` and `hit-testing.test.ts`

Steps:

1. Replace the current tight diamond of building tiles with a wider civic-core
   arrangement around the plaza/road.
2. Candidate arrangement after shrink should use four clear quadrants:
   - Foundry lower-west or west of core, away from Exit Route Gatehouse
   - Dependency Loom upper/north core
   - Yield Orchard east or southeast core, away from the lighthouse base
   - Exit Route Gatehouse south or southwest edge near road/harbor, but not
     overlapping the Foundry
3. Add a helper for building placement validation, for example:
   - `BUILDING_CLEARANCE_TILES`
   - `buildingPlacementInvariants()`
   - or route-local test helper if production helper is unnecessary
4. Assert:
   - every building is on land
   - every building remains within or near the civic core
   - every building is outside cemetery ellipse plus margin
   - every building is outside dock margin
   - every building is outside lighthouse/headland margin
   - pairwise tile distance meets a minimum
   - pairwise isometric center distance meets a minimum
5. If tile spacing is still insufficient at default zoom, reduce visual building
   scale slightly in `drawThematicBuildings()`:
   - current effective multiplier is `camera.zoom * 0.58 * visual.scale`
   - try `0.52..0.55` before larger layout rewrites
6. If building scale changes, review `assetTargetRect()` in hit testing so
   selectable rectangles track the rendered sprites.

Acceptance targets:

- No building hitbox overlap in the Playwright debug targets for `building`
  entities.
- Default screenshot shows visible ground between building bases.
- Buildings remain visually grouped as one civic data core rather than scattered
  randomly around the island.

Risks:

- Tile distance can pass while sprites still overlap. Control with debug target
  overlap checks and screenshot review.
- Moving buildings can obscure cemetery or roads. Control with updated visual
  and layout tests.

### Phase 6 - Make Sea Zones Recognizable

Primary files:

- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/systems/palette.test.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/world-layout.ts` only if footprints need tuning

Steps:

1. Strengthen `WATER_TERRAIN_STYLES` before changing geometry:
   - separate value/lightness more aggressively between generic water,
     harbor-water, alert-water, warning-water, storm-water, brackish-water, and
     frozen-water
   - avoid generic neon, purple, or glassy gradients
2. Improve texture language:
   - `drawHarborWaterTexture()`: calmer protected ripples/reflections
   - `drawAlertChannelTexture()`: directional warm current strokes
   - `drawWarningShoalTexture()`: sandbar flecks, broken zig-zag wavelets
   - `drawDangerStraitTexture()`: darker cross-current slashes and whitecaps
   - `drawBrackishWaterTexture()`: murk patches, reeds/kelp marks, lower contrast
   - `drawNorthFrozeWaterTexture()`: ice seams/plates with crisp cyan marks
   - `drawDeepSeaTexture()`: sparse, quiet marks only
3. Add optional regional wash outlines after water tiles:
   - draw subtle soft polygon/ellipse fills per terrain region, clipped by tile
     coverage if feasible
   - do not draw large translucent circles that recreate the current problem
4. Only adjust zone geometry if palette/texture remains insufficient:
   - `isAlertChannel()`
   - `isWarningShoals()`
   - `isDangerStrait()`
   - `isDataFog()`
   - `isNorthFrozePole()`
5. Keep ship placement predicates aligned with any terrain changes in
   `isPlacementWaterTile()`.

Tests/checks:

- `palette.test.ts` should continue to assert every rendered water terrain has
  a style.
- Playwright pixel thresholds may need retuning because stronger sea colors can
  change water/land classification.
- Manual screenshot review should verify each named zone is recognizable without
  opening details.

Risks:

- Stronger colors can look decorative rather than semantic. Control by tying
  each mark language to the existing area/risk semantics and keeping DOM detail
  parity.

### Phase 7 - Integrate Ground Texture With Lighthouse

Primary files:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/systems/palette.ts` if land colors are centralized later
- `public/pharosville/assets/manifest.json` only if sprite geometry changes

Steps:

1. Treat this as renderer integration first, not an asset replacement.
2. Tune procedural land colors to the lighthouse asset:
   - grass should move closer to the lighthouse hill's brighter moss/olive
   - cliffs/rocks should share the lighthouse cliff's cool limestone/gray family
   - roads should match the lighthouse stair/road warmth
3. Reduce the double-ground effect in `drawLighthouseHeadland()`:
   - shrink the large procedural pad
   - reduce or remove the detached halo
   - make the procedural road/stair connect to the sprite base rather than sit
     under it as a second hill
4. Keep `drawLandTile()` texture density consistent:
   - grass variation should be enough to avoid flat fill
   - avoid noisy checker/blue terrain from manifest PNGs
   - keep cliff facet shading coherent with tile edges
5. Review building base integration:
   - if sprite bases fight the new ground, adjust local shadows/glows rather
     than regenerating assets immediately
6. Do not enable `terrain.land`, `terrain.road`, or `terrain.shore` PNGs until
   they are visually audited or regenerated.
7. If any asset bytes or manifest geometry change:
   - update manifest dimensions/anchor/footprint/hitbox
   - bump `style.cacheVersion`
   - run asset validation and hit-testing checks

Acceptance targets:

- Lighthouse hill appears as one integrated terrain feature.
- Ground tiles no longer read as flat yellow/olive under a more polished
  lighthouse sprite.
- Roads, cliffs, shoreline, and grass retain isometric readability at default
  zoom.

Risks:

- Over-tuning to the lighthouse can make the rest of the island too bright.
  Control with full-scene screenshot review in dark theme.

### Phase 8 - Tests, Docs, And Review

Focused unit checks:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
```

Specific lanes to run during implementation:

```bash
npm test -- src/app/pharosville/systems/world-layout.test.ts
npm test -- src/app/pharosville/systems/pharosville-world.test.ts
npm test -- src/app/pharosville/systems/chain-docks.test.ts
npm test -- src/app/pharosville/systems/motion.test.ts
npm test -- src/app/pharosville/renderer/hit-testing.test.ts
```

Visual lane:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Snapshot update only after manual review:

```bash
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell" --update-snapshots
```

Build/static checks if route docs, CSS, assets, or static output are changed:

```bash
npm run build
npm run seo:check
```

Docs to update when behavior changes:

- `docs/pharosville-page.md`
- `agents/pharosville/CURRENT.md`
- `agents/pharosville/VISUAL_INVARIANTS.md`
- `agents/pharosville/TESTING.md` only if validation workflow changes

Before pushing deploy-impacting work:

```bash
npm run test:merge-gate
```

## Recommended Implementation Order

1. Remove `ATMOSPHERE_BANDS` sea circles and replace sign posts with printed
   labels. This directly addresses two visible issues with low layout risk.
2. Strengthen sea palette and textures. This makes labels and zones legible
   before the larger island geometry change.
3. Add composition-aware camera framing. This can improve initial balance even
   before land shrink lands.
4. Shrink the island mask and retune docks, roads, cemetery, area anchors, and
   region anchors together.
5. Redistribute buildings and add spacing invariants.
6. Tune ground/lighthouse integration after the final land mask and building
   positions are stable.
7. Update tests, docs, screenshots, and run the route-focused validation suite.

## Non-Goals

- No new API routes or data payloads.
- No methodology/scoring changes.
- No mobile canvas implementation.
- No new gameplay mechanics.
- No terrain PNG adoption unless assets are regenerated or separately approved.
- No broad redesign of ships, docks, cemetery, or global Pharos navigation.

## Open Decisions For Implementation

- Whether the 20% island reduction should be measured by tile bounds, visual
  pixel footprint, or land tile count. This plan recommends tile-bound linear
  footprint as the primary metric and screenshot review as the final arbiter.
- Whether canvas area counts should remain visible. This plan recommends moving
  counts to detail/accessibility only so sea labels feel like printed map text.
- Whether camera recentering should be implemented as a generic projection
  helper or a PharosVille-specific default camera helper. This plan recommends a
  PharosVille-specific helper if generic map fit does not need the new behavior.

## Reviewer Checklist

- Are all requested issues mapped to concrete code paths?
- Does the plan avoid redoing already-landed map shrink/deep-water work unless
  required by the new 20% landmass request?
- Does the plan preserve desktop gate, reduced motion, hit testing, and DOM
  parity?
- Are visual-only changes kept route-local?
- Are asset changes avoided unless necessary, and validated if introduced?
- Are tests and docs specific enough for a follow-up implementer to execute?
