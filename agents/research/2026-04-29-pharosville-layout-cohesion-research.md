# PharosVille Layout And Sprite Cohesion Research

Date: 2026-04-29
Status: historical pre-implementation research note

## Scope

Prepare a layout/art-direction pass for PharosVille so the island reads as one coherent maritime observatory town rather than edge-loaded sprite patches.

Assumptions:

- This is preparation only. Do not change implementation files while another agent is actively editing PharosVille.
- Keep the current desktop-only Canvas 2D route, DOM detail parity, reduced-motion determinism, and no-CSP-relaxation contract.
- The user explicitly wants inland/main-island buildings to use the center. Only harbors/docks and the lighthouse should require sea/coast placement.
- Use existing Pharos data surfaces and hooks. No Worker endpoint, D1 migration, provider, methodology, or mobile support change is implied.

## Sources Reviewed

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `docs/pharosville-page.md`
- `agents/specs/2026-04-29-pharosville-scenery-brief.md`
- `agents/pharosville-thematic-buildings-research-2026-04-29.md`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `public/pharosville/assets/manifest.json`
- `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`

## Pre-Implementation Placement Facts

This section records the baseline that motivated the 2026-04-29 civic-core patch. It is intentionally historical: the active implementation now places the four data buildings around the central civic core and removed the hard-coded decorative huts from the Canvas renderer.

The generated map is 64 x 64 with `waterRatio = 0.8518`, leaving 607 land tiles. The land centroid from current terrain is approximately `{ x: 34.0, y: 30.0 }`.

Current non-harbor landmark/data positions:

| Entity | Tile | Terrain | Distance From Land Centroid | Notes |
| --- | ---: | --- | ---: | --- |
| Royal Mint And Burn Foundry | `{ x: 22, y: 30 }` | grass | 12.0 | West edge of the central island, visually reads like an outlying sprite. |
| Yield Orchard And Moonwell | `{ x: 46, y: 30 }` | grass | 12.0 | East edge, near water/docks. The sprite includes its own floating land mass, which fights the map terrain. |
| Dependency Loom / Chainworks | `{ x: 30, y: 40 }` | beach/shore | 10.8 | Southern edge, not truly inland. |
| Exit Route Gatehouse | `{ x: 40, y: 40 }` | shore | 11.7 | Southern/eastern shore. Conceptually nautical, but the user asked non-harbors to use inland center. |
| Cemetery center | `{ x: 36.4, y: 32.8 }` | grass | 3.7 | Already central, but it currently carries most of the island center alone. |
| Lighthouse | `{ x: 44, y: 18 }` | hill | 15.6 | Correctly coastal/elevated and should stay a headland exception. |

The renderer also has two hard-coded decorative huts in `world-canvas.ts`:

- `{ x: 31, y: 38 }` currently resolves to harbor water.
- `{ x: 24, y: 35 }` resolves to beach/shore.

Those huts are not part of the world model, detail index, hit testing, or accessibility ledger. They add visual noise and weaken the "every landmark means data" contract.

## Core Critique

### Anti-Pattern Verdict

The issue is not generic SaaS/AI UI slop. It is game-map incoherence:

- landmarks are individually detailed but not master-planned;
- inland data buildings are placed around the island perimeter rather than forming a readable town core;
- some sprites carry their own base terrain/water while the map already renders terrain;
- decorative huts are separate from the data model;
- docks use many distinct silhouettes and colors without a shared harbor grammar.

The result is a patchwork of good assets rather than a designed island city.

### What Works

- The lighthouse as northeast headland landmark is conceptually strong and correctly separated from the town.
- Docks/ships/risk water have a clear sea-first analytical role.
- The cemetery has the right idea: compact, central, and tied to a distinct lifecycle concept.
- The cue registry and DOM detail model are strong constraints. The layout pass should preserve them.

### Main Problem

The island lacks a civic center. The map currently says "coastline attractions around empty grass" instead of "Pharos data town organized around a central observatory/civic spine."

The fix should be a masterplan before asset tweaks:

1. Define a central civic district around the land centroid, roughly `{ x: 31-39, y: 28-36 }`.
2. Move all non-harbor/lighthouse buildings into that district or immediately around it.
3. Connect them with a small plaza/road spine so their relationship is legible.
4. Keep docks as coastal infrastructure and lighthouse as high-coast signal tower.
5. Keep North Froze Pole as northern water, not a main-island building.

## Recommended Spatial Plan

Use four visual districts:

| District | Role | Entities | Placement Rule |
| --- | --- | --- | --- |
| Beacon Headland | Systemic PSI watchtower | Lighthouse | Northeast elevated coast only. |
| Harbor Ring | Chain supply and ship traffic | Docks, ships, risk-water signs | Coast/water only. Do not pull these inland. |
| Civic Data Core | Main Pharos product telemetry | Mint, Yield, Dependency, Exit building | Land tiles near centroid; no sea requirement. |
| Lifecycle Garden | Stablecoin endings/freeze context | Cemetery, North Froze Pole nearby sign relation only | Cemetery central/east-central land; North Froze Pole remains northern water. |

Candidate inland placements to test, assuming current island shape remains close:

| Entity | Candidate Tile | Rationale |
| --- | ---: | --- |
| Royal Mint And Burn Foundry | `{ x: 29, y: 30 }` | West side of civic core, near road, still visible but no longer edge-bound. |
| Dependency Loom / Chainworks | `{ x: 33, y: 29 }` | Central guild/workshop, acts as town anchor. |
| Yield Orchard And Moonwell | `{ x: 38, y: 30 }` | East/northeast garden district beside cemetery but not on coastline. |
| Exit Route Gatehouse | `{ x: 31, y: 35 }` or `{ x: 33, y: 36 }` | Keep it near a road/canal metaphor without requiring shoreline. If it must visually mention water, use a small internal canal/lock element in the sprite, not map-edge water. |
| Cemetery | keep near `{ x: 36.4, y: 32.8 }`, possibly tighten radius slightly | Already central; adjust only if building footprints overlap. |

Before implementation, run actual collision checks because 192 x 160 building sprites at current `0.58` scale still occupy roughly 100 px x 90 px after anchor scaling. Four large buildings plus a cemetery may require either a slightly larger central plateau or 0.50-0.54 building render scale.

## Map Shape Guidance

The current map uses a sea-first 82-88% water contract. Preserve that, but the island center needs an authored town plateau:

- Slightly expand or smooth the central land mass around `{ x: 31-39, y: 28-36 }`.
- Avoid deep harbor-water cuts that reach into the future civic core.
- Make one visible road/plaza spine from southwest harbor -> civic core -> lighthouse stair/headland.
- Add a small plaza or paved town square under the civic buildings so the center is visually claimed even before sprites load.
- Keep beaches/shore terrain around docks; keep the data buildings on grass/road/plaza terrain.

## Sprite Cohesion Direction

Regenerate or revise assets under one stronger PharosVille art bible:

- Same camera: low top-down isometric, same tile angle, same north-facing orientation.
- Same materials: pale limestone walls, muted teal/slate roofs, bronze/gold hardware, dark seaworn wood.
- Same base logic: inland buildings should have a transparent or small limestone-footprint base, not their own floating island/chunk/water slab.
- Same footprint family: data buildings should share a 2x2 or 3x2 tile footprint and anchor convention.
- Same lighting: northwest/top-left light, modest shadows, no independent glow baked into PNGs.
- Same semantic restraint: bake neutral architecture into sprites; draw changing data effects procedurally on canvas.
- No text, logos, signs, UI badges, or decorative lore in the sprite itself.

Current asset-specific issues:

- `yield-orchard-moonwell.png` reads like a detached floating island. Regenerate as an orchard garden on a ground footprint that belongs to the main island.
- `dependency-loom-chainworks.png` reads as an exposed interior/room cutaway. Regenerate as an exterior workshop/loom hall with a roof silhouette and visible chain/loom cue.
- `exit-route-gatehouse.png` includes water/platform context; regenerate as a customs/gatehouse with a tiny internal lock/canal detail so it can sit inland.
- `mint-burn-foundry.png` is the most coherent, but should match the shared roof/material/base language.
- Docks should be grouped into a smaller family of 3-4 silhouette types with shared dock posts/flags/materials. Current dock sprites vary from tiny wooden pier to large marina/wharf styles, making the coast read as asset-gallery rather than harbor network.

## Implementation Prep

Likely files for the future implementation pass:

- `src/app/pharosville/systems/data-buildings.ts`
  - Move `BUILDING_TILES`.
  - Potentially add footprint/collision metadata if tests need it.
- `src/app/pharosville/systems/world-layout.ts`
  - Adjust island plateau, road spine, cemetery radius/placement, and terrain guards.
  - Add/export a small `CIVIC_CORE_TILES` or `DATA_BUILDING_TILES` helper if tests need stable assertions.
- `src/app/pharosville/renderer/world-canvas.ts`
  - Remove or convert the hard-coded decorative `BUILDINGS`.
  - Update depth sorting/scale only if moved buildings collide visually.
  - Prefer map-ground plaza/road rendering over extra decorative huts.
- `src/app/pharosville/renderer/hit-testing.ts`
  - Re-check hitbox scale after sprite/scale changes.
- `public/pharosville/assets/manifest.json`
  - Update prompt provenance and footprint/anchor metadata after regenerated assets.
- `scripts/pharosville/validate-assets.mjs`
  - Update only if the manifest category/limit rules need to reflect building assets more directly.
- `tests/visual/pharosville.spec.ts`
  - Update screenshots and add semantic assertions for central data-building placement.
- `src/app/pharosville/systems/world-layout.test.ts`
  - Add tests that non-harbor/lighthouse buildings are on land and close enough to the central civic district.
- `docs/pharosville-page.md`, `docs/architecture.md`, `docs/data-visualization.md`
  - Update if the data mapping, scenery contract, manifest rules, or visual regression expectations change.

## Success Criteria

- Center of the island has at least three major non-harbor data landmarks visible in the first desktop view.
- Every non-harbor/lighthouse building sits on land/road/plaza terrain and is within an agreed civic-core radius of the land centroid.
- Harbors and ships remain coastal/water entities; the lighthouse remains the elevated coastal exception.
- No purely decorative hut/building appears in canvas without DOM/detail/accessibility representation, unless it is clearly background filler and cannot be mistaken for selectable data.
- Regenerated sprites look like one art pack: shared perspective, scale, roof/material palette, base footprint, and lighting.
- Visual tests pass for nonblank canvas, terrain/water ratio, detail parity, building targets, and asset validation.

## Suggested Validation

For the later implementation pass:

```bash
npm run check:pharosville-assets
npm test -- src/app/pharosville
npm run test:visual -- tests/visual/pharosville.spec.ts
```

If implementation touches only layout/rendering, the full merge gate is still safest before push:

```bash
npm run test:merge-gate
```
