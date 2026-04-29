# PharosVille Civic Core Implementation Plan

Date: 2026-04-29
Status: specialist-reviewed plan; executed by the 2026-04-29 civic-core patch

## Goal

Turn the PharosVille layout/cohesion research into an execution-ready composition pass that fixes the first user-visible failure and prepares a safe follow-up for the second:

1. The island center reads empty while non-sea buildings sit around the perimeter.
2. Buildings, harbors, and decorative sprites read as a patchwork rather than one authored maritime observatory town.

The first patch should claim the empty-center/civic-core fix. It should not claim the whole patchwork problem is solved unless screenshot review proves the existing sprites still cohere after relocation. Building sprite regeneration is a likely follow-up if baked terrain bases, water platforms, or cutaway interiors still read incoherent.

This plan was prepared before implementation and is retained as the execution record for the civic-core patch. Baseline sections below describe the pre-patch state unless explicitly marked as target or validation criteria.

## Hard Constraints

- Active route only: `/pharosville/`.
- Preserve the desktop gate: no canvas, data queries, asset manifest, or sprite decode under `1280px` width or `760px` height.
- Keep Canvas 2D. Do not introduce PixiJS, Three.js, WebGL, CSP relaxations, new API endpoints, new Worker data, D1 migrations, supply overrides, or methodology changes.
- Preserve DOM truth: any data-encoded visual cue must still have detail-panel and accessibility-ledger parity.
- Keep harbors/docks/ships/risk-water coastal or water-based.
- Keep the lighthouse on the elevated coastal headland.
- Move all four non-harbor data buildings inland.
- North Froze Pole remains a northern water area, not a building sprite.
- Treat the current dirty PharosVille worktree as another agent's work. Do not revert it.

## Pre-Patch Baseline Facts

Computed against the pre-implementation `world-layout.ts`:

- Map: `64 x 64`
- Water ratio: `0.851806640625`
- Land tiles: `607`
- Land centroid: approximately `{ x: 34.01, y: 29.99 }`
- Current building tiles in `src/app/pharosville/systems/data-buildings.ts`:
  - Mint foundry: `{ x: 22, y: 30 }`, distance `12.0`
  - Exit gatehouse: `{ x: 40, y: 40 }`, distance `11.7`
  - Yield orchard: `{ x: 46, y: 30 }`, distance `12.0`
  - Dependency loom: `{ x: 30, y: 40 }`, distance `10.8`
- Current cemetery center: `{ x: 36.4, y: 32.8 }`, distance `3.7`
- Current lighthouse tile: `{ x: 44, y: 18 }`, distance `15.6`
- `src/app/pharosville/renderer/world-canvas.ts` still has two hard-coded decorative `BUILDINGS` at `{ x: 31, y: 38 }` and `{ x: 24, y: 35 }`. These are not world-model entities, detail targets, hit targets, or accessibility-ledger rows.

## Target World Composition

Use four explicit districts:

| District | Entities | Placement |
| --- | --- | --- |
| Beacon Headland | Lighthouse | Elevated northeast coast; unchanged at `{ x: 44, y: 18 }`. |
| Harbor Ring | Docks, ships, risk-water signs | Coast/water only. |
| Civic Data Core | Mint, Dependency, Yield, Exit buildings | Inland land/road/plaza near `{ x: 34, y: 30 }`. |
| Lifecycle Garden | Cemetery, North Froze Pole relation | Cemetery remains central/east-central; North Froze Pole remains north water. |

The scene should read as a compact civic data town arranged around the center, with roads/plaza tying it to the southwest harbor and lighthouse stair.

## Exact Layout Targets

### Civic Core Constants

Add explicit constants in `src/app/pharosville/systems/world-layout.ts`:

```ts
export const CIVIC_CORE_CENTER = { x: 34, y: 30 } as const;
export const CIVIC_CORE_RADIUS = 6.5;
```

Use these constants for tests and implementation comments. They do not need to become user-facing copy.

### Data Building Tiles

Change `BUILDING_TILES` in `src/app/pharosville/systems/data-buildings.ts` to:

```ts
const BUILDING_TILES: Record<BuildingType, { x: number; y: number }> = {
  "mint-burn-foundry": { x: 29, y: 30 },
  "dependency-loom-chainworks": { x: 34, y: 28 },
  "yield-orchard-moonwell": { x: 40, y: 30 },
  "exit-route-gatehouse": { x: 31, y: 34 },
};
```

Current terrain validation for these target tiles:

| Building | Tile | Current Terrain | Distance From Land Centroid | Cemetery Ellipse Value |
| --- | ---: | --- | ---: | ---: |
| Royal Mint And Burn Foundry | `{ x: 29, y: 30 }` | land/grass | `5.01` | `4.35` |
| Dependency Loom / Chainworks | `{ x: 34, y: 28 }` | land/rock | `1.99` | `3.10` |
| Yield Orchard And Moonwell | `{ x: 40, y: 30 }` | land/rock | `5.99` | `1.74` |
| Exit Route Gatehouse | `{ x: 31, y: 34 }` | land/grass | `5.01` | `1.99` |

All four are:

- non-water;
- within `CIVIC_CORE_RADIUS = 6.5` of `{ x: 34, y: 30 }`;
- outside the current cemetery ellipse by a meaningful margin;
- clear of current dock tiles.

These coordinates are the starting contract, but they must pass the interaction overlap gate below before screenshots are accepted. Tile-center checks alone are not enough because the 192 x 160 building sprites and manifest hitboxes can overlap docks, graves, or other buildings in screen space.

If overlap review fails, try this exact first fallback before reducing global building scale:

```ts
const BUILDING_TILES: Record<BuildingType, { x: number; y: number }> = {
  "mint-burn-foundry": { x: 29, y: 30 },
  "dependency-loom-chainworks": { x: 34, y: 28 },
  "yield-orchard-moonwell": { x: 40, y: 30 },
  "exit-route-gatehouse": { x: 34, y: 36 },
};
```

`{ x: 34, y: 36 }` is currently land/grass, inside the civic radius, and outside the cemetery ellipse. It needs visual review because it sits closer to the cemetery garden.

### Cemetery

Keep `CEMETERY_CENTER = { x: 36.4, y: 32.8 }` and `CEMETERY_RADIUS = { x: 4.0, y: 2.9 }` for the first implementation pass.

Do not move the cemetery unless visual review proves collision after the buildings are moved. If collision appears, prefer tightening only:

```ts
export const CEMETERY_RADIUS = { x: 3.6, y: 2.55 } as const;
```

Do not shift the cemetery to the coast; it is part of the center/lifecycle garden.

### Roads And Plaza

Keep the existing road spine concept but make the center read as deliberate civic space.

In `world-layout.ts`:

1. Add helper:

```ts
function isCivicPlazaTile(x: number, y: number): boolean {
  return ellipseValue(x, y, CIVIC_CORE_CENTER.x, CIVIC_CORE_CENTER.y + 1.1, 4.4, 2.6) < 1
    && cemeteryValue(x, y) > 1.08;
}
```

2. In `terrainKindAt()`, after the lighthouse and road checks and before `if (cemetery < 1) return "grass";`, classify civic plaza tiles as `road`:

```ts
if (isRoadTile(x, y) && cemetery > 1.08) return "road";
if (isCivicPlazaTile(x, y)) return "road";
if (cemetery < 1) return "grass";
```

3. Update `isRoadTile()` path to intentionally pass through the four-building civic district:

```ts
const path = [
  { x: 19, y: 39 },
  { x: 21, y: 35 },
  { x: 29, y: 32 },
  { x: 34, y: 30 },
  { x: 38, y: 27 },
  { x: 41, y: 23 },
  { x: 43, y: 19 },
];
```

Expected impact:

- The route from southwest harbor to lighthouse remains visible.
- The data buildings look arranged around a civic square.
- The cemetery remains grass, not paved over.
- Water ratio should remain inside current `0.82-0.88` contract because this changes only land terrain kind, not water/land classification.

## Sprite And Asset Direction

### First Patch Scope

For the immediate implementation patch, do not require regenerated assets before moving layout. Use the existing four building PNGs and improve placement first.

Rationale:

- The current user-visible failure is mostly composition.
- Regeneration should be a second patch if the first screenshot still reads as patchwork.
- Deferring asset regeneration reduces conflict risk with the other active agent.

### Required Asset Review In First Patch

After moving buildings and removing decorative huts:

- Run the visual test and inspect the updated screenshot.
- Decide whether existing sprites are acceptable enough for this patch.
- If existing sprites still read detached, record that as a follow-up and only update docs/tests for the layout change.

### Regeneration Follow-Up Criteria

Regenerate all four data-building sprites together only if the moved layout still reads incoherent.

Shared art bible for regeneration:

- Old-school 16-bit maritime isometric RPG pixel art.
- Low top-down isometric view, same tile angle and northwest/top-left light direction.
- Pale limestone walls, muted teal/slate roofs, bronze/gold hardware, dark seaworn wood.
- Transparent background.
- No text, logos, UI badges, signs, or decorative lore.
- Inland building base only: small limestone/road/grass footprint, no floating island chunk, no surrounding water slab.
- Neutral sprite body; dynamic semantic state remains procedural canvas effects.
- Same production constraints for all four: `192 x 160` canvas, bottom-center anchor, `58 x 34` ground footprint target, no baked status glow, no surrounding water, no floating terrain slab, no cutaway interiors, and no signboards/text.

Concrete sprite fixes if regenerating:

- `yield-orchard-moonwell.png`: remove detached floating island base; make it a garden/orchard footprint that sits on map terrain.
- `dependency-loom-chainworks.png`: stop reading as a cutaway room; make it an exterior workshop/chainworks hall.
- `exit-route-gatehouse.png`: remove large external water platform; keep a small internal lock/canal cue so it can be inland.
- `mint-burn-foundry.png`: keep the general foundry read, but align roof/material/base with the other three.

Manifest rules:

- Keep IDs unchanged: `building.mint-burn-foundry`, `building.exit-route-gatehouse`, `building.yield-orchard-moonwell`, `building.dependency-loom-chainworks`.
- In manifest schema v1, keep building entries as `category: "landmark"` and `layer: "landmarks"`. `category: "building"` is not currently accepted by the type or validator.
- Keep `loadPriority: "deferred"` unless screenshot proves first-render blankness.
- Keep manifest schema v1 unless frame animation is explicitly added later.
- Do not casually bump `style.assetVersion` for a four-building-only regeneration. The current manifest uses one global `style.assetVersion` for every asset URL, and `scripts/pharosville/validate-assets.mjs` requires each `promptProvenance.styleAnchorVersion` to match it. A regeneration patch must choose one of:
  - regenerate/update provenance for the whole pack under one new global version; or
  - first change the validator/schema so cache-busting asset version and per-asset style provenance are separate.
- If metadata is touched, add `promptKey`, `semanticRole`, and `paletteKeys` to building entries that lack them.
- Update anchors/hitboxes from actual sprite bounds if regenerated.

Shared regeneration prompt preamble:

```text
old-school 16-bit maritime isometric RPG pixel art, low top-down 2:1 isometric view, northwest/top-left light, pale limestone walls, muted teal/slate roof, bronze/gold hardware, dark seaworn wood, crisp single-color outline, medium shading, transparent background, 192x160 map-object sprite, bottom-center anchor, small 58x34 limestone/road/grass footprint, no surrounding water, no floating island, no text, no logos, no UI badges, no signboards, no baked status glow
```

Append per asset:

- Foundry: `royal coin mint foundry, brass coin press, small furnace chimney, quenching trough, ingot crates`
- Gatehouse: `inland civic canal-lock customs gatehouse, tiny internal lock channel, waterwheel, tidegate doors contained inside footprint, no exterior water platform`
- Orchard: `terraced yield orchard and moonwell garden, small windmill, fruit trees, irrigation stones, harvest baskets, no detached island base`
- Loom: `exterior chainworks loom hall, roofed workshop, bronze gear loom, visible anchor chains, ledger table, no cutaway room interior`

## Renderer Changes

File: `src/app/pharosville/renderer/world-canvas.ts`

1. Remove the hard-coded `BUILDINGS` constant.
2. Remove `drawBuildings(input)` from the draw order.
3. Delete `drawBuildings()` if unused.
4. Delete the now-unused procedural `drawBuilding()` helper if it has no remaining callers.
5. Keep `drawThematicBuildings()` as the only building renderer for data buildings.
6. Move `VILLAGE_LIGHTS` to cemetery-safe civic-core positions:

```ts
const VILLAGE_LIGHTS = [
  { x: 30.1, y: 31.8, size: 0.54 },
  { x: 33.2, y: 30.1, size: 0.5 },
  { x: 37.2, y: 29.5, size: 0.52 },
] as const;
```

7. Preserve draw order with `drawSky(input)` still first:

```ts
drawSky(input);
drawTerrain(input);
drawAtmosphere(input);
drawCemeteryGround(input);
drawLighthouseHeadland(input);
drawCemeteryContext(input);
drawThematicBuildings(input);
drawDocks(input);
drawAreaSigns(input);
drawDecorativeLights(input);
drawShips(input);
drawClusters(input);
drawGraves(input);
drawCemeteryMist(input);
drawLighthouse(input);
drawBirds(input);
drawSelection(input);
```

8. Do not add any new decorative building sprite unless it becomes a world-model entity with detail/a11y parity.

9. Keep current building render scale `0.58` initially. If screenshot and hit-target review show unacceptable overlap in the civic core, try the `exit-route-gatehouse` coordinate fallback first. If it still fails, reduce only the building asset scale from `0.58` to `0.52` in both `world-canvas.ts` and `renderer/hit-testing.ts` so selection rects stay aligned.

## Hit Testing

File: `src/app/pharosville/renderer/hit-testing.ts`

Required test change even if scale remains `0.58`:

- Parameterize all four building detail IDs in `hit-testing.test.ts`.
- For each building, assert it has at least one unoccluded click point where `hitTest()` returns that same building.
- Use the same five-point strategy as the Playwright helper: center plus four quadrants.

No production hit-testing code change is required if building scale remains `0.58`, manifest hitboxes remain accurate, and all four building clickability tests pass.

If building render scale changes:

- Update the matching multiplier in `assetDrawPoint()` for `entity.kind === "building"`.
- Re-run `src/app/pharosville/renderer/hit-testing.test.ts`.
- Manually verify with the visual test click-target coverage or a Playwright click on each building.
- Add a building-specific manifest-hitbox test; the current manifest-hitbox coverage is not enough if only lighthouse math is asserted.

## World Model And Detail Parity

Files:

- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/components/accessibility-ledger.tsx`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`

Expected changes:

- None required for the first layout-only pass if the same four building IDs/types remain.

Guardrail:

- If any decorative building remains after renderer cleanup, it must either be non-interactive background scenery that cannot be confused with data, or it must be promoted to `BuildingNode`/detail/a11y/cue parity. The preferred path is removal.

## Docks And Harbors

Do not move docks in the same patch unless visual review shows a direct collision with the moved civic core.

Reason:

- The user's core issue is non-sea buildings and global cohesion.
- Chain-aware harbor placement is already a separate active concern and likely part of the other agent's dirty work.
- Moving docks and civic buildings together increases screenshot churn and test fallout.

If dock cohesion remains visually weak after the civic-core patch, create a separate harbor-family pass:

- reduce dock sprite families to 3-4 visual archetypes;
- preserve chain-specific preferred slots and top-ten cap;
- keep one chain harbor per rendered dock;
- keep logo mast flags as identity, not large labels.

## Test Plan

### Unit Tests

Update `src/app/pharosville/systems/pharosville-world.test.ts`:

- Assert the four building tiles exactly match target coordinates by `buildingType`, not array order.
- Assert every building tile resolves to `land` or `road`:

```ts
expect(world.buildings.every((building) => (
  ["land", "road"].includes(tileKindAt(building.tile.x, building.tile.y))
))).toBe(true);
```

- Assert every building is inside civic radius:

```ts
expect(
  world.buildings.every((building) => (
    Math.hypot(building.tile.x - CIVIC_CORE_CENTER.x, building.tile.y - CIVIC_CORE_CENTER.y) <= CIVIC_CORE_RADIUS
  )),
).toBe(true);
```

- Assert lighthouse remains outside civic core and elevated.
- Assert North Froze Pole remains an `area`, not a building.
- Assert dock clearance:

```ts
expect(world.buildings.every((building) => (
  DOCK_TILES.every((dock) => Math.hypot(building.tile.x - dock.x, building.tile.y - dock.y) > 3)
))).toBe(true);
```

- Assert cemetery clearance with a local helper equivalent to current `cemeteryValue()`:

```ts
expect(world.buildings.every((building) => cemeteryEllipseValue(building.tile) > 1.08)).toBe(true);
```

Update `src/app/pharosville/systems/world-layout.test.ts`:

- Keep current sea-first water-ratio assertion `0.82 <= waterRatio <= 0.88`.
- Assert the computed land centroid remains close to the civic core:

```ts
expect(Math.hypot(landCentroid.x - CIVIC_CORE_CENTER.x, landCentroid.y - CIVIC_CORE_CENTER.y)).toBeLessThanOrEqual(1.5);
```

- Add civic-plaza/road assertions:

```ts
expect(terrainKindAt(CIVIC_CORE_CENTER.x, CIVIC_CORE_CENTER.y)).toBe("road");
expect(terrainKindAt(29, 32)).toBe("road");
expect(terrainKindAt(38, 27)).toBe("road");
expect(terrainKindAt(43, 19)).toBe("road");
expect(terrainKindAt(34, 31)).toBe("grass"); // cemetery guard
```

- Assert the lighthouse road still connects from the civic core toward `{ x: 43, y: 19 }`.
- Keep dock slots coastline/water-access assertions unchanged.
- Keep cemetery connected-land assertions unchanged unless radius is intentionally tightened.

Always update `src/app/pharosville/renderer/hit-testing.test.ts` to cover all four building click targets, as described in the Hit Testing section. Add extra manifest-hitbox assertions if building scale or hitbox behavior changes.

### Visual Tests

Update `tests/visual/pharosville.spec.ts`:

- Add a helper that waits for deferred building assets before screenshot review or building click assertions:

```ts
await page.waitForFunction(() => {
  const debug = (window as typeof window & {
    __pharosVilleDebug?: PharosVilleVisualDebug;
  }).__pharosVilleDebug;
  const buildingTargets = debug?.targets.filter((target) => target.kind === "building") ?? [];
  return Boolean(
    debug?.criticalAssetsLoaded
    && debug.deferredAssetsLoaded
    && (debug.assetLoadErrors?.length ?? 0) === 0
    && buildingTargets.length >= 4
  );
});
```

- Add a visual/interaction loop that clicks all four exact building detail IDs:

```ts
const BUILDING_DETAIL_IDS = [
  "building.mint-burn-foundry",
  "building.exit-route-gatehouse",
  "building.yield-orchard-moonwell",
  "building.dependency-loom-chainworks",
] as const;

for (const detailId of BUILDING_DETAIL_IDS) {
  const selection = await clickMapTargetWithPoint(page, "building", detailId);
  expect(selection.detailId).toBe(detailId);
  await expect(page.getByTestId("pharosville-detail-panel")).toBeVisible();
  await expect(page.getByTestId("pharosville-detail-panel")).toContainText(
    detailId === "building.mint-burn-foundry"
      ? "Royal Mint And Burn Foundry"
      : detailId === "building.exit-route-gatehouse"
        ? "Exit Route Gatehouse"
        : detailId === "building.yield-orchard-moonwell"
          ? "Yield Orchard And Moonwell"
          : "Dependency Loom / Chainworks",
  );
}
```

- Add a reduced-motion debug-target overlap assertion before accepting coordinates:
  - fail if a building target overlaps a `dock`, `area`, or `grave` target and no unoccluded center/quadrant point selects the building;
  - separately assert each building has at least one such unoccluded point;
  - allow building-building overlap only if every building remains independently clickable.
- Add/adjust semantic assertion that building target rect centers are clustered near the visual center, not map edges. Prefer target/camera math over brittle pixels.
- Update `pharosville-desktop-shell-linux.png` snapshot after visual review.
- Do not update the narrow fallback snapshot unless it actually changes.

Manual visual acceptance before snapshot update:

- First viewport shows a dense civic center with at least three data buildings visibly inland.
- Center no longer reads as empty grass.
- Cemetery is still legible and not swallowed by building sprites.
- Docks remain clearly coastal.
- No decorative hut appears on harbor water.
- Selecting each building still anchors the detail panel to that target.
- Reduced motion still renders a stable nonblank scene.
- Normal motion still animates ships/effects without layout drift.

## Documentation Updates

Update `docs/pharosville-page.md`:

- Current phase bullets should say the four data buildings are placed around a central civic data core on the main island.
- Mention the road/plaza spine if implemented.
- Remove or avoid any wording implying data buildings are edge/coast landmarks.

Update `docs/architecture.md` only if its PharosVille summary changes materially. If it already says "main-island data buildings", a one-sentence central-civic-core addition is enough.

Update `docs/data-visualization.md` if it has a PharosVille visual grammar section that mentions building placement or world composition.

No methodology docs should change because this is visual placement only.

## Validation Commands

Targeted checks:

```bash
npm run check:pharosville-assets
npm test -- src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/renderer/hit-testing.test.ts src/app/pharosville/systems/visual-cue-registry.test.ts
npm run build
npm run test:visual -- pharosville.spec.ts
```

For intentional visual snapshot updates:

```bash
npm run test:visual -- pharosville.spec.ts --update-snapshots
```

Broader local confidence if time allows:

```bash
npm run lint
npm run typecheck
```

Before push:

```bash
npm run test:merge-gate
```

## Implementation Sequence

1. Refresh branch/worktree status and coordinate with the other PharosVille agent.
2. Update `BUILDING_TILES` to the exact civic-core coordinates.
3. Add `CIVIC_CORE_CENTER`, `CIVIC_CORE_RADIUS`, `isCivicPlazaTile()`, and road path updates in `world-layout.ts`.
4. Remove hard-coded decorative `BUILDINGS` rendering and move `VILLAGE_LIGHTS` into the civic core.
5. Delete unused decorative `drawBuilding()` if no callers remain.
6. Add/adjust unit tests for civic-core terrain, building coordinates, land/road placement, cemetery clearance, dock clearance, all-building hit testing, and visual-cue stability.
7. Run `npm test -- src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/renderer/hit-testing.test.ts src/app/pharosville/systems/visual-cue-registry.test.ts`.
8. If tests fail because terrain classification changed more than expected, fix the terrain predicate/order rather than weakening the invariant.
9. Run `npm run build`.
10. Run the visual test once, wait for deferred assets, inspect screenshot, and evaluate debug-target overlap.
11. If building overlap is severe, try the Exit fallback coordinate `{ x: 34, y: 36 }`; if still severe, reduce building render and hit-test scale from `0.58` to `0.52`.
12. Update focused tests and visual snapshot.
13. Update docs.
14. Run targeted validation commands.
15. Only after targeted validation passes, consider broader lint/typecheck/build or merge gate.

## Out Of Scope For First Patch

- Regenerating every dock sprite.
- New manifest schema.
- Frame-based Pixellab animation.
- New decorative scenery packs.
- Filter/sort controls or dense inspection UI.
- Mobile/touch canvas.
- Any API/data/methodology change.

## Rollback Strategy

If visual review is worse after moving the buildings:

1. Keep the removal of hard-coded decorative huts if it improved semantic clarity.
2. Revert only `BUILDING_TILES` to the prior positions or try the alternate exact coordinate set:

```ts
const BUILDING_TILES: Record<BuildingType, { x: number; y: number }> = {
  "mint-burn-foundry": { x: 29, y: 30 },
  "dependency-loom-chainworks": { x: 33, y: 29 },
  "yield-orchard-moonwell": { x: 38, y: 30 },
  "exit-route-gatehouse": { x: 31, y: 34 },
};
```

3. Do not change product/data semantics to justify a visual layout.

## Review Checklist For Subagents

- Layout/math review: Are target tiles valid, central, outside cemetery overlap, and compatible with terrain/water invariants?
- Renderer/hit-test review: Are draw order, scale, hitboxes, and decorative hut removal safe?
- Asset/design review: Does this art direction and sequencing solve patchwork without forcing unnecessary asset churn?
- Test/docs review: Are the proposed assertions enough to prevent regression while avoiding brittle visual-only tests?

## Specialist Review Resolution

This plan incorporates four read-only specialist reviews:

- Layout/math review accepted the four target building coordinates, `CIVIC_CORE_CENTER`, `CIVIC_CORE_RADIUS`, unchanged cemetery center/radius, and unchanged water-ratio expectation. It required cemetery-safe `VILLAGE_LIGHTS` positions, which are now in the renderer plan.
- Renderer/hit-test review required deferred-asset readiness, `drawSky(input)` in the preserved draw order, deletion of the now-unused `drawBuilding()` helper, and a hit-target overlap gate before accepting screenshots. Those are now required.
- Asset/design review accepted the layout-only first patch as a composition pass, but rejected claiming full sprite-patchwork resolution without screenshot proof. It also tightened schema-v1 manifest rules, global `assetVersion` caveats, and regeneration prompt constraints.
- Test/docs review required build-before-visual validation, all-building click tests, all-building hit-test coverage, land/road assertions instead of "not water", deferred-asset waits, and explicit central-civic-core doc wording. Those are now required.

Remaining execution risk is visual density: the target coordinates are valid in map space, but current sprite bounds can overlap in screen space. The implementation must pass the debug-target overlap/clickability gate before updating visual snapshots.
