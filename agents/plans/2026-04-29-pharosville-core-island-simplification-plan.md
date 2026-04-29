# PharosVille Core Island Simplification Plan

Date: 2026-04-29

## Scope

Plan the next `/pharosville/` visual/layout pass for the crowded inland island
shown in the supplied screenshot.

Requested outcomes:

- Remove `Yield Orchard And Moonwell`.
- Remove `Dependency Loom / Chainworks`.
- Reposition the cemetery, Exit Route Gatehouse, and Royal Mint And Burn
  Foundry so inland space is distributed clearly and the coast/periphery remains
  primarily for harbors.
- Improve the remaining building art so the scene feels like one coherent
  maritime observatory island, not a collage of unrelated sprites.
- Use Pixellab MCP where regeneration is the simplest route to coherent
  building assets.

This is a PharosVille-only visual/world-model change. It should not add API
endpoints, methodology changes, mobile canvas support, global dashboard
redesigns, or new analytical semantics.

## Assumptions

- "Remove" means remove the two inland landmarks from the PharosVille world,
  canvas, hit targets, details, accessibility ledger, visual-cue registry,
  asset manifest, docs, and tests. Their primary analytical pages remain
  available through the normal app navigation.
- `reportCards` must still load for PharosVille because ships and Exit Route
  Gatehouse use report-card data. Removing `Dependency Loom / Chainworks` does
  not mean removing report-card inputs from the world.
- `yieldRankings` is currently only used by `Yield Orchard And Moonwell` inside
  PharosVille, so removing that building should also remove the route's
  `useYieldRankings()` query unless another PharosVille consumer is added in the
  same patch.
- The current desktop-only contract remains: viewports below `1280px` wide or
  `760px` tall must render the fallback and must not mount the world, queries,
  manifest loader, or canvas path.
- The current Canvas 2D renderer remains appropriate. This plan is not a move
  to SVG, CSS layout, or a full baked map image.
- The image complaint is primarily a composition and art-coherence issue, not a
  request to change the analytical data model behind Mint/Burn, Exit Routes,
  Cemetery, Chain Harbors, Ships, DEWS areas, or the Lighthouse.

## Current Evidence

Code and docs reviewed:

- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `docs/pharosville-page.md`
- `agents/pharosville/ASSET_PIPELINE.md`
- `src/app/pharosville/pharosville-desktop-data.tsx`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/geometry.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `tests/visual/pharosville.spec.ts`
- `public/pharosville/assets/manifest.json`

Measured current state from `buildPharosVilleMap()`:

- Map size: `56 x 56`.
- Water ratio: `0.8657525510204082`.
- Land bounds: `x=21..48`, `y=17..43`.
- Land centroid: `{ x: 35.00, y: 29.14 }`.
- Civic core: `{ x: 34, y: 30 }`, radius `7`.
- Cemetery center: `{ x: 24.8, y: 35.6 }`, radius `{ x: 3.0, y: 2.1 }`.
- Current building tiles:
  - `mint-burn-foundry`: `{ x: 28, y: 30 }`, `grass`
  - `exit-route-gatehouse`: `{ x: 33, y: 36 }`, `grass`
  - `yield-orchard-moonwell`: `{ x: 40, y: 31 }`, `rock`
  - `dependency-loom-chainworks`: `{ x: 34, y: 24 }`, `grass`
- Closest current building pair: Mint/Burn to Exit, distance `7.81` tiles.
- Current manifest has `28` assets and passes `npm run check:pharosville-assets`.
- Each current building sprite is `192 x 160` with anchor `[96, 148]`,
  footprint `[58, 34]`, hitbox `[18, 10, 156, 142]`, category `landmark`,
  layer `landmarks`.

Screenshot critique:

- Inland reads as a dense central knot: cemetery, foundry, gatehouse, orchard,
  loom, road/plaza, effects, and ship/harbor edges compete in the same visual
  band.
- The periphery is visually blurred: harbor structures and ships press into the
  same screen area as inland data landmarks, so the island no longer has a clear
  "coast for ports, interior for civic data" grammar.
- Building art lacks a shared hierarchy. The foundry, gatehouse, orchard, and
  loom use different silhouettes, colors, and effect languages; the orchard is
  especially saturated and toy-like, and the loom adds purple energy that reads
  like another focal landmark.
- The remaining useful inland concepts are strong enough without the two extra
  buildings: Mint/Burn and Exit Routes are operational civic structures; the
  cemetery is a lifecycle/memorial district. Those three can carry the island
  interior with more breathing room.

## Success Criteria

### Visual

- Default desktop frame reads as a maritime observatory island with clear
  districts:
  - harbors and docks on the coast/periphery
  - cemetery in a quiet inland/lowland memorial precinct
  - Royal Mint And Burn Foundry as an inland civic-industrial anchor
  - Exit Route Gatehouse as an inland pass/gate connected to the road spine
  - lighthouse remaining the northeast headland anchor
- Yield Orchard And Moonwell and Dependency Loom / Chainworks are not visible,
  selectable, listed in the detail index, or represented by ambient effects.
- The remaining three inland destinations have obvious separation at default
  zoom. Target invariants:
  - Mint/Gatehouse tile distance `>= 7.5`
  - Cemetery center to each building `>= 6.0`
  - each inland building distance to every dock tile `>= 5.0`
  - cemetery center distance to every dock tile `>= 5.5`
- Tile-distance checks are necessary but not sufficient. At `1440 x 1000`,
  projected target rectangles for Mint, Gatehouse, cemetery context/prop bounds,
  dock labels, and major harbor sprites must not overlap in the default frame.
  There must be visible terrain or road negative space between the memorial
  precinct, Mint, and Gatehouse in both the no-selection state and a
  representative selected-building state.
- Water labels and harbor labels must not sit over cemetery/building silhouettes
  or read as part of the inland core. Label hygiene is part of acceptance, not a
  cosmetic follow-up.
- Harbors remain coastal. No new dock moves inward to solve inland spacing.
- Remaining building sprites share perspective, scale, outline, palette, and
  shadow logic with the lighthouse/dock set. They must share baseline/contact
  shadow treatment, outline weight, pixel density, and saturation limits. No
  generated sprite includes text, numbers, currency symbols, logos, UI panels,
  detached background tiles, or decorative web3 glow.
- Status effects around Mint and Gatehouse are local, bounded, and subordinate
  to the sprite silhouette. They should no longer create large circular visual
  clutter around the core.

### Contract

- No new data source is introduced.
- Removing the Yield building removes the PharosVille `yield-rankings` fetch
  unless a remaining PharosVille feature still consumes it.
- Report-card data remains available for ships and Exit Route Gatehouse.
- Detail panel and accessibility ledger still expose data truth for remaining
  visual encodings.
- Reduced-motion mode remains deterministic and does not start a RAF loop.
- Ship routes and moorings remain water-only.
- Asset manifest validation, palette guard, focused unit tests, visual tests,
  and build pass before claiming completion.

## Recommended Target Layout

Use this as the first implementation target, then adjust only if the screenshot
review shows projection occlusion:

| Element | Current | Target | Rationale |
| --- | ---: | ---: | --- |
| Cemetery center | `{ x: 24.8, y: 35.6 }` | `{ x: 27.0, y: 34.0 }` | Pulls the memorial precinct inland from the southwest harbor edge while keeping it on the quieter western half. |
| Cemetery radius | `{ x: 3.0, y: 2.1 }` | `{ x: 2.7, y: 1.9 }` | Slightly tighter precinct to avoid spilling into harbor/periphery space after the center shift. |
| Royal Mint And Burn Foundry | `{ x: 28, y: 30 }` | `{ x: 30, y: 28 }` | Moves to a northwestern civic terrace, away from docks and away from the cemetery's new center. |
| Exit Route Gatehouse | `{ x: 33, y: 36 }` | `{ x: 38, y: 31 }` | Moves east/inland near the road toward the lighthouse, reading as a pass/gate rather than a harbor structure. |
| Yield Orchard And Moonwell | `{ x: 40, y: 31 }` | removed | Removes the saturated central island sprite and its separate effect language. |
| Dependency Loom / Chainworks | `{ x: 34, y: 24 }` | removed | Removes the purple loom focal point and simplifies the data-building grammar. |

Candidate terrain checks from the current layout:

- `{ x: 27, y: 34 }` is `grass`, minimum dock distance `6.40`.
- `{ x: 30, y: 28 }` is `grass`, minimum dock distance `5.00`.
- `{ x: 38, y: 31 }` is inland rock/road territory with acceptable first-pass
  dock separation when placed with an adjusted road/plaza tile.

Road/spine target:

- Preserve one readable road spine from the southwest harbor approach through
  the cemetery edge, Mint terrace, Gatehouse, and lighthouse stairs.
- Do not pave through the cemetery burial field. Use a light causeway or path
  along the precinct edge, with cemetery internals kept memorial-specific.
- Use a thin road spine with two civic anchors and a quiet memorial precinct.
  Do not re-create the old four-building central square.
- Treat cemetery/harbor separation as a visual composition gate. If the first
  target center `{ x: 27.0, y: 34.0 }` still reads in the same foreground band
  as EVM bay labels, ships, or dock sprites, move the cemetery farther inland
  and update invariants/docs/tests in the same patch.

## Implementation Plan

### Phase 0 - Baseline And Worktree Safety

1. Run `git status --short` and identify dirty files before edits. Preserve the
   existing untracked plan/research files unless the user explicitly asks to
   touch them.
2. Capture a before screenshot to `agents/screenshots/` at the default visual
   test viewport, or reuse the user-supplied screenshot as visual reference if
   no browser session is available.
3. Record current map metrics in the implementation notes:
   - water ratio
   - land bounds
   - cemetery center/radius
   - building tiles
   - building/dock distances
   - current manifest asset count
4. Confirm `npm run check:pharosville-assets` is passing before asset edits.

### Phase 1 - Remove Two Inland Buildings From The World Model

Primary files:

- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/pharosville-desktop-data.tsx`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/components/world-toolbar.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/renderer/geometry.ts` only if fallback building geometry
  assumptions change

Steps:

1. Narrow `BuildingType` to:
   - `mint-burn-foundry`
   - `exit-route-gatehouse`
2. Remove or retire status labels used only by removed buildings if no other
   type uses them:
   - `broad-coverage`
   - `high-median-apy`
   - `source-switch`
   - `high-hub-concentration`
   - `many-direct-dependents`
3. In `data-buildings.ts`, remove:
   - `buildYieldOrchard()`
   - `buildDependencyLoom()`
   - `sourceKeyForYieldRanking()` and yield-only helpers if unused
   - dependency-hub-only helpers if unused by Exit Gatehouse
4. Keep report-card data inside `buildExitRouteGatehouse()` because
   `weakestExitMembers()` uses report-card context.
5. Update `buildDataBuildings()` to return exactly two buildings in stable
   order: Mint, then Gatehouse.
6. Remove the `useYieldRankings()` import and query from
   `pharosville-desktop-data.tsx` if no PharosVille consumer remains:
   - remove it from `error`
   - remove it from `hasAnyData`
   - remove it from `isLoading`
   - remove it from `buildPharosVilleWorld()` inputs
   - remove `yieldStale`
   - remove it from `useMemo` dependencies
   - remove it from retry handling
7. Remove Yield-specific world inputs and freshness fields after the query is
   removed:
   - `YieldRankingsResponse` import from `pharosville-world.ts`
   - `yieldRankings` from `PharosVilleInputs`
   - `YieldRankingsResponse` import from `data-buildings.ts`
   - `yieldRankings` from `DataBuildingInputs`
   - `yieldStale` from `PharosVilleFreshness`
   - Yield stale-source rows from `accessibility-ledger.tsx`
8. Keep `useReportCards()` because ships, ship visuals/details, and
   Gatehouse still need it.
9. Remove visual-cue entries:
   - `cue.building.yield-orchard`
   - `cue.building.dependency-loom`
10. Remove removed building/cue variants from TypeScript unions:
    - `BuildingType`
    - `BuildingStatus`
    - `WorldEffectCueId`
    - visual-cue typed targets/tests
11. Replace the building-effect `if/else` chain in `world-canvas.ts` with an
    explicit `switch` over the narrowed `BuildingType`, with an exhaustive guard
    so a future building cannot accidentally fall through to stale Dependency
    effects.
12. Remove renderer branches and helpers only used for removed effects:
   - `drawYieldOrchardEffects()`
   - `drawDependencyLoomEffects()`
   - any purple loom thread helpers not used elsewhere
13. Ensure accessibility ledger and toolbar counts naturally reflect
    `world.buildings.length === 2`; do not hard-code the count.
14. Remove runtime assets for deleted buildings:
    - remove manifest entries for `building.yield-orchard-moonwell` and
      `building.dependency-loom-chainworks`
    - delete or move out of `public/`:
      `public/pharosville/assets/buildings/yield-orchard-moonwell.png`
      and `public/pharosville/assets/buildings/dependency-loom-chainworks.png`
    - bump `style.cacheVersion`
    - verify `npm run check:pharosville-assets` does not report orphan PNGs

Tests to update in the same phase:

- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/systems/visual-cue-registry.test.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `tests/visual/pharosville.spec.ts`

Acceptance for this phase:

- No references to `yield-orchard-moonwell` or `dependency-loom-chainworks`
  remain in active PharosVille runtime code, tests, docs, or manifest.
- A repository-wide search may still find historical plan files under
  `agents/plans/historical/`, but active route/docs should not describe the
  removed buildings as current behavior.
- `yield-rankings` is no longer requested by the PharosVille desktop data path
  or visual tests.
- `report-cards` is still requested and has a named regression test proving it
  continues to feed ship/report-card detail or Gatehouse weakest-exit members.

### Phase 2 - Redistribute The Inland Layout

Primary files:

- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/world-layout.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`
- `src/app/pharosville/renderer/world-canvas.ts`

Steps:

1. Move `CEMETERY_CENTER` and `CEMETERY_RADIUS` to the target values, then
   update `islandValue()` so the cemetery lowland remains land without
   enlarging the harbor edge.
2. Update cemetery internals:
   - `cemeteryScatterTile()`
   - `cemeteryReserved()`
   - cemetery path/causeway exclusions
   - cemetery context drawing anchors in `world-canvas.ts`
3. Move building tiles:
   - Mint: `{ x: 30, y: 28 }`
   - Gatehouse: `{ x: 38, y: 31 }`, with nearby terrain adjusted from
     `rock/road` to a buildable civic edge if needed.
4. Replace the old civic core mental model with a smaller "two-building civic
   terrace" invariant. Either update `CIVIC_CORE_CENTER/RADIUS` to describe the
   new terrace or stop using the old four-building core invariant for building
   validation.
5. Update the road path in `isRoadTile()` so it connects:
   - southwest harbor approach
   - cemetery edge
   - Mint terrace
   - Gatehouse
   - lighthouse stairs/headland
6. Keep all dock tiles on or adjacent to water; do not move harbors inward.
7. Add or update test helpers for:
   - building tiles are land/buildable terrain
   - cemetery scatter stays within cemetery and on land
   - cemetery does not overlap road internals
   - buildings maintain minimum distance from docks
   - buildings and cemetery maintain minimum distance from one another
   - exactly two building nodes and exactly two building hit targets
   - projected building target rectangles do not overlap each other at default
     visual-test camera settings
   - projected building/cemetery/dock-label target rectangles keep minimum
     screen-space gutters at `1440 x 1000`
   - ship water anchors still resolve to water

Acceptance for this phase:

- `world.buildings.length === 2`.
- All remaining buildings are inland and separated.
- Cemetery center and graves are clearly inland enough that nearby harbor sprites
  no longer read as part of the cemetery.
- No ship routing or dock mooring test regresses.

### Phase 3 - Rebuild Remaining Building Art Coherently

Primary asset files:

- `public/pharosville/assets/buildings/mint-burn-foundry.png`
- `public/pharosville/assets/buildings/exit-route-gatehouse.png`
- `public/pharosville/assets/manifest.json`
- optional promoted cemetery props under `public/pharosville/assets/props/`

Candidate/prototype files:

- `agents/pharosville/pixellab-prototypes/`

Use the current manifest style anchor:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI
```

Pixellab generation approach:

1. Generate standalone transparent object candidates first with
   `mcp:create_map_object`.
2. Use `width=192`, `height=160`, `view="low top-down"`,
   `outline="single color outline"`, `shading="medium shading"`,
   `detail="medium detail"` for both remaining buildings unless a candidate
   proves too muddy at route zoom.
3. Generate 3-4 candidates for each building, stage them under
   `agents/pharosville/pixellab-prototypes/`, and review them at in-world scale
   before promotion.
4. If standalone candidates do not match the lighthouse/dock style, use a
   small style-reference crop or montage from existing runtime assets and the
   Pixellab style-matching/inpainting mode. Use an explicit rectangle or custom
   mask for building candidates, not the default oval mask, with the
   ground-contact/base area centered near the lower edge. Keep reference images
   local and out of runtime.
5. Prepend the manifest style anchor to every prompt. Add constraints in the
   generation log and prompt: compact single-building sprite, bottom-centered
   isometric base, no symbols, no numbers, no signage, no detached background or
   water tile.
6. Record a candidate run log under `agents/pharosville/pixellab-prototypes/`
   with prompt, Pixellab job ID, dimensions, selected/rejected status, and final
   promoted path.
7. Promote only selected PNGs to `public/pharosville/assets/`.
8. Update manifest dimensions, anchors, footprints, hitboxes, `promptKey`,
   `semanticRole`, `paletteKeys`, `tool`, `promptProvenance.jobId`,
   `promptProvenance.styleAnchorVersion`, and `style.cacheVersion`. Do not bump
   `style.styleAnchorVersion` unless the root style anchor text changes.

Suggested prompts:

Royal Mint And Burn Foundry:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI. Royal mint and burn foundry civic building, pale limestone mint hall with abstract bronze press machinery, small controlled furnace chimney, warm gold windows, compact industrial courtyard, bottom-centered isometric base, transparent background, no currency symbols, no numbers, no signage, no detached background tile
```

Exit Route Gatehouse:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI. Exit route gatehouse civic building, pale stone arched road gate with raised portcullis, dry island checkpoint, contained bronze wheel and tiny internal gauge detail, warm guarded arch light, bottom-centered isometric base, transparent background, no open water basin, no currency symbols, no numbers, no signage, no detached background tile
```

Optional cemetery prop pass:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI. Single small memorial cemetery prop, pale stone tombstone or low mausoleum detail for maritime island graveyard, restrained moss and lantern accent, bottom-centered isometric base, transparent background, no text, no logos, no UI, no detached background tile
```

Asset quality gates:

- Sprites align to the same `low top-down` camera as docks/lighthouse.
- Transparent edges are clean at 1x and zoomed screenshots.
- The strongest silhouette is visible at the default camera zoom.
- No sprite text or embedded iconography leaks into runtime.
- Building shadows do not fight the procedural terrain shadows.
- Derive anchor from the actual ground-contact point, footprint from the visible
  base, and hitbox from opaque body pixels excluding transparent margins and
  decorative shadows.
- Verify selection rings, detail-panel anchor, and click target rectangles
  against the rendered sprite.
- Run a metadata/byte check before promotion so forbidden tokens, remote URLs,
  or JSON error bodies cannot enter `public/pharosville/assets/`.
- Manifest asset count stays within the current validator cap. Removing two
  buildings creates room for optional cemetery prop variants only if each prop
  is a separate manifest-backed sprite and the renderer is updated to place it.
  Otherwise defer the cemetery prop pass.

### Phase 4 - Simplify Renderer Effects Around The Core

Primary file:

- `src/app/pharosville/renderer/world-canvas.ts`

Steps:

1. Delete effect functions for removed buildings.
2. Re-tune `drawBuildingStatusGlow()` so Mint and Gatehouse glows are local
   underlays, not large circular marks that compete with roads, graves, docks,
   or water labels.
3. Keep Mint effects semantic but restrained:
   - small chimney smoke
   - minimal spark/furnace glow
   - no broad orange circle
4. Keep Gatehouse effects semantic but restrained:
   - water/channel ripple or wheel hint
   - narrow teal light inside the arch
   - no broad cyan circle
5. Update cemetery context rendering for the new center:
   - mausoleum/tree/lantern anchors
   - shrub bands
   - mist bounds
   - cause-color plaques if needed
6. Verify entity depth sorting after layout moves. Gatehouse at the east/inland
   side should not hide ships or docks; cemetery props should not overpaint
   building bases.

Acceptance for this phase:

- At default zoom, the remaining buildings read as authored sprites first and
  status effects second.
- No purple dependency threads or green orchard/well glints remain.
- Cemetery no longer visually collides with harbor sprites or the road spine.

### Phase 5 - Documentation And Tests

Docs to update:

- `docs/pharosville-page.md`
- `docs/data-visualization.md` if it describes PharosVille data landmarks
- `docs/architecture.md` if it lists the PharosVille building/data contract
- `agents/specs/2026-04-29-pharosville-scenery-brief.md`
- `docs/design-language.md` only if the route's documented special visual
  baseline changes materially
- `public/pharosville/assets/manifest.json`
- `agents/pharosville/ASSET_PIPELINE.md` only if the Pixellab workflow changes,
  not merely because new assets were generated

Tests/checks:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
npm test -- src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/visual-cue-registry.test.ts src/app/pharosville/renderer/hit-testing.test.ts
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
npm run build
```

If the change is pushed, run:

```bash
npm run test:merge-gate
```

Visual review checklist:

- `1440 x 1000` desktop default frame.
- `1440 x 1000` no-selection frame.
- `1440 x 1000` selected Mint frame.
- `1440 x 1000` selected Gatehouse frame.
- short desktop fallback still avoids mounting the world.
- narrow fallback still avoids world/API/manifest requests.
- fullscreen mode.
- reduced-motion mode.
- click targets for Mint, Gatehouse, cemetery graves, lighthouse, docks, and
  printed water labels.
- visual debug target rectangles for the two buildings and nearby harbor labels
  do not overlap in a way that blocks clickability or visual reading.
- asset-load debug state: no critical/deferred asset errors.

## Risks And Mitigations

- Risk: deleting the two buildings breaks TypeScript unions or cue parity tests.
  Mitigation: narrow `BuildingType` and update all cue/detail/test constants in
  the same patch.
- Risk: removing `yieldRankings` from PharosVille changes loading/error behavior.
  Mitigation: only remove it after confirming no remaining route consumer exists;
  update visual test mocked endpoint lists accordingly.
- Risk: report-card fetch is accidentally removed with the Dependency building.
  Mitigation: keep a test that ship detail or Gatehouse members still consume
  report-card-backed fields.
- Risk: new building sprites look good alone but wrong at route zoom.
  Mitigation: review candidates in-world before promotion, not only as raw PNGs.
- Risk: cemetery move invalidates grave scatter and context props.
  Mitigation: update scatter/reserved/context anchors together and run focused
  world-layout tests.
- Risk: moving Gatehouse near the road/lighthouse path causes isometric
  occlusion.
  Mitigation: use visual debug target rectangles and Playwright screenshot
  review; adjust target tiles before accepting.

## Deliberate Non-Goals

- Do not add a new inland landmark to replace Yield or Dependency.
- Do not add new data semantics for Yield or Dependency under another visual
  form in this pass.
- Do not move harbors inland to fill space.
- Do not turn PharosVille into a full generated/baked map image.
- Do not alter Yield Intelligence, Dependency Map, Mint/Burn, Report Cards,
  Liquidity, Cemetery, PSI, or DEWS methodology.
- Do not relax asset validation, palette guard, visual-cue parity, or desktop
  fallback contracts.

## Review Status

Specialized subagent review requested after this draft:

- Visual/composition review.
- Implementation-risk review.
- Asset/Pixellab pipeline review.

Findings should be folded into this file before implementation starts.
