# PharosVille Sea Remediation Plan

Date: 2026-04-29

Status: Implemented in the same workstream. The shipped path uses a `56 x 56`
map, an 8-12% deep-water shelf target, brackish stale-evidence water, named
water terrain styles in the PharosVille palette, updated DOM/ledger parity, and
refreshed route visual coverage.

## Assumptions

- This is a planning pass only. No route/runtime behavior should change until the remediation is implemented in a follow-up.
- The target surface is `/pharosville/`, not the legacy lighthouse/harbor prototypes.
- Visual-only water improvements should stay route-local and use the existing PharosVille data contracts. No Worker/API changes are needed.
- The canvas can remain the rendering technology, but DOM detail/accessibility parity must continue to describe any semantic sea-zone encoding.
- PharosVille is desktop-only by contract. Mobile/tablet work remains limited to preserving the existing fallback gate.

## Success Criteria

- Deep-water stops dominating the authored map: reduce `deep-water` from the current 1,542 / 4,096 tiles (37.65%) to a narrow outer shelf target of roughly 8-12% of tiles.
- Total map tile count drops materially, preferably from `64 x 64 = 4,096` tiles to about `56 x 56 = 3,136` tiles (-23.4%) or another nearby dimension justified by fit/hit-test results.
- The camera initial fit shows the island, docks, named sea zones, and danger waters without huge unused dark-blue margins.
- All named sea areas have distinctive, semantically legible treatments: calm harbor, brackish/murky stale-evidence water, alert channel, warning shoals/treacherous seas, storm strait, frozen path, and deep outer sea.
- Water looks authored rather than flat: layered hue, current direction, wave cadence, foam, shoal marks, fog/mist, and storm/frozen local effects read at the default `1440 x 1000` viewport.
- Reduced motion remains deterministic and does not start a RAF loop.
- Hit targets remain aligned after any map shrink/repositioning.
- Focused PharosVille tests and visual snapshots are updated deliberately.

## Current Findings

- `src/app/pharosville/systems/world-layout.ts` hardcodes a `64 x 64` rectangular map. `buildPharosVilleMap()` emits every tile, and `drawTerrain()` iterates all water tiles and all land tiles every draw.
- Current terrain distribution from `buildPharosVilleMap()`:
  - `deep-water`: 1,542 tiles, 37.65%
  - generic `water`: 1,210 tiles, 29.54%
  - all authored risk/special water combined: 737 tiles, 17.99%
  - land/shore/road/elevated terrain combined: 607 tiles, 14.82%
- The route tests currently enforce the old sea-first shape:
  - unit tests assert `64 x 64`, `64 * 64`, and `0.82-0.88` water ratio.
  - Playwright visual tests parse the accessibility ledger and expect `82-88% water`.
- The deep-water rule is broad and blunt: most outlying water with `x < 8 || y < 8 || x > 55 || y > 55` becomes `deep-water`.
- The semantic sea zones exist but are visually too close in the default view:
  - `alert-water` is only 38 tiles.
  - `warning-water` is 93 tiles.
  - `storm-water` is 165 tiles.
  - `fog-water` is 246 tiles.
  - there is no explicit swamp/brackish terrain even though the world model has a `muddy` risk zone.
- The renderer already has separate texture functions for alert, warning, danger, frozen, and generic waves, but they are thin per-tile strokes. At default zoom, the dominant read is still flat rectangles of blue.
- `src/app/pharosville/systems/canvas-budget.ts` defines terrain/weather cache budget constants, but the renderer does not currently cache static terrain or weather layers. Every animation frame redraws all terrain.
- `src/app/pharosville/systems/palette.ts` exists, while `world-canvas.ts` still carries a separate local `TILE_COLORS` table and hardcoded water/texture colors. This makes themed sea work harder to keep cohesive and weakens the color guard.

## Recommended Implementation

### Phase 1: Make Map Bounds Intentional

1. Replace scattered `0`, `63`, and `64` assumptions with helpers/constants:
   - `PHAROSVILLE_MAP_WIDTH`
   - `PHAROSVILLE_MAP_HEIGHT`
   - `MAX_TILE_X`
   - `MAX_TILE_Y`
   - `clampMapTile()`
   - optional `MAP_INTEREST_BOUNDS` for test/debug reporting
2. Shrink the map dimensions after verifying fit. Start with `56 x 56`; fall back to `58 x 58` if danger/frozen/fog zones feel cramped.
3. Reposition the outlying authored zones rather than just chopping them:
   - keep the main island, EVM bay, cemetery, data buildings, and lighthouse close to their current relative relationships.
   - pull Danger Strait inward from the extreme southeast so it remains visible and selectable inside the smaller map.
   - keep North Froze Pole near the northwest edge, but avoid letting it require a large deep-water corner.
   - keep Data Fog / stale-evidence waters west/northwest, but make them authored water instead of a large generic blob.
4. Retune `fitCameraToMap()` only if necessary after map shrink. Prefer changing map shape first; camera code already responds to map bounds.

Primary files:

- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/projection.ts` only if bounds/padding math needs adjustment.

### Phase 2: Reduce Deep-Water To An Outer Shelf

1. Change `terrainKindAt()` so `deep-water` is no longer the default broad border.
2. Use a narrow, shaped perimeter rule:
   - deep sea only at the farthest outside corners and along the outermost shelf.
   - generic/ordinary water fills the navigable sea around the island.
   - special water zones override the perimeter rule where necessary.
3. Add tests that assert distribution instead of the old water-ratio contract:
   - map tile count equals the new dimension product.
   - `deep-water` count is below a fixed percentage target.
   - special water zones still exist and remain selectable.
   - named DEWS area anchors sit on the matching terrain.

Expected docs update:

- `docs/pharosville-page.md`: replace the current "roughly 82-88% water by tile count" language with a smaller authored-sea target and deep-water cap.
- `agents/pharosville/CURRENT.md`: update the current visual model and invariants.

### Phase 3: Introduce A Sea-Terrain Vocabulary

Add explicit terrain kinds only where they carry a clear visual or data purpose. Recommended set:

- `harbor-water`: calm teal with mooring reflections and gentle foam.
- `swamp-water` or `brackish-water`: murky stale/low-confidence water for the existing `data-fog` / degraded-evidence area, paired with fog overlay rather than replacing it.
- `alert-water`: amber current lines and signal buoys for Alert Channel.
- `shoal-water` or keep `warning-water`: sandbars, broken wave lines, reef flecks for Warning Shoals / treacherous water.
- `storm-water`: dark chop, cross-current slashes, stronger whitecaps for Danger Strait.
- `frozen-water`: cracked ice seams and cold cyan highlights for North Froze Pole.
- `deep-water`: sparse outer shelf only, darker and quieter than active seas.

World-model implications:

- If adding `swamp-water` / `shoal-water`, update `TerrainKind`, `WATER_TERRAIN_KINDS`, tests, and any detail/accessibility copy that names the zone.
- Keep `ShipWaterZone` semantics stable unless the detail panel needs clearer labels. Avoid implying new risk categories that are not in `pegSummary` or `stress.signals`.
- Preserve existing route-source copy: chain moorings come from `stablecoins.chainCirculating`; risk water comes from `pegSummary.coins[]` and `stress.signals[]`.

### Phase 4: Consolidate Sea Colors And Textures

1. Move terrain color tokens out of the local `TILE_COLORS` object in `world-canvas.ts` into a PharosVille terrain palette module or extend `systems/palette.ts`.
2. Keep hardcoded colors out of renderer logic where possible. The renderer should read named terrain styles such as:
   - base fill
   - inner fill
   - wave stroke
   - foam stroke
   - accent stroke
   - hazard mark
3. Add a `waterStyleForTerrain(kind)` helper so new terrain kinds do not expand the `drawWaterTile()` conditional into a larger one-off block.
4. Update `scripts/check-pharosville-colors.mjs` only if needed. It currently guards placeholder/debug drift but does not enforce palette use.

Primary files:

- `src/app/pharosville/systems/palette.ts`
- `src/app/pharosville/systems/palette.test.ts`
- `src/app/pharosville/renderer/world-canvas.ts`
- `scripts/check-pharosville-colors.mjs` if the guard should enforce the expanded palette.

### Phase 5: Upgrade Water Rendering

Implement richer water in layers, with reduced-motion-safe deterministic output:

1. Base water tile:
   - per-terrain base fill.
   - subtle inner diamond for depth.
   - deterministic per-tile hue/lightness variation from `tileX/tileY`.
2. Directional currents:
   - harbor: short calm ripples aligned with dock approaches.
   - alert channel: amber directional signal streaks.
   - warning/treacherous seas: broken zig-zag wavelets plus shoal flecks.
   - storm: cross-current slashes and stronger whitecaps.
   - swamp/brackish: dark green-brown patches, reeds/kelp flecks, low fog.
   - frozen: crack lines and small ice plates.
3. Regional overlays:
   - fog band over swamp/data fog water.
   - storm haze localized to Danger Strait.
   - foam lines around shore and shoal edges.
4. Animation:
   - non-reduced motion: animate alpha/phase only, not geometry or layout.
   - reduced motion: freeze phase at deterministic values.
5. Keep draw cost bounded:
   - use deterministic modulus gates so not every tile draws every effect.
   - prioritize visible semantic regions over generic water.

Preferred implementation shape:

- Keep `drawWaterTile()` small and dispatch to terrain-specific texture helpers.
- Consider static terrain caching only after the map-size and texture changes are in place. If richer water regresses frame cost, use a terrain layer cache for static base tiles and draw only animated water accents each frame.

### Phase 6: Visual And Test Updates

Focused test updates:

- `src/app/pharosville/systems/world-layout.test.ts`
  - new dimensions.
  - deep-water cap.
  - terrain vocabulary coverage.
  - named area terrain anchors.
  - dock and grave land/connectivity invariants after map shift.
- `src/app/pharosville/systems/pharosville-world.test.ts`
  - risk area/world details still point to valid areas.
  - no stale/missing evidence maps into storm risk.
- `src/app/pharosville/systems/motion.test.ts`
  - moving ship samples remain water-only inside new bounds.
- `src/app/pharosville/renderer/hit-testing.test.ts`
  - target alignment after map shrink.
- `tests/visual/pharosville.spec.ts`
  - replace the `82-88% water` assertion with a new map-size/deep-water expectation from the accessibility ledger or debug state.
  - update pixel-stat thresholds so they verify meaningful sea/land coverage without preserving old bloat.
  - update snapshots after manual review.

Validation commands:

```bash
npm test -- src/app/pharosville
npm run check:pharosville-assets
npm run check:harbor-palette
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
npm run lint
npm run typecheck
```

Run `npm run build` and `npm run seo:check` if route docs, metadata, shell behavior, generated output, or screenshots are updated in the same change.

## Implementation Order

1. Add map bound helpers and update tests to use constants where appropriate.
2. Shrink/reposition map dimensions and anchors, keeping the visual output functional even before polish.
3. Retune deep-water generation and update map distribution tests.
4. Add/rename semantic sea terrain kinds and DOM parity copy.
5. Consolidate terrain palette and refactor `drawWaterTile()`.
6. Add richer water textures by terrain type.
7. Run focused unit tests, then visual tests, then refresh snapshots only after inspecting the screenshot.
8. Update `docs/pharosville-page.md` and `agents/pharosville/CURRENT.md`.

## Risks And Controls

- **Risk: cut map breaks ship placement.** Control: replace hardcoded `63` clamps and add tests that all ship risk/home/motion samples are inside bounds and water-only.
- **Risk: visual zones become decorative rather than semantic.** Control: every new terrain style must map to existing area/risk/detail semantics and appear in DOM detail or the accessibility ledger.
- **Risk: smaller map crowds harbors, cemetery, and data buildings.** Control: shrink water margins first; only compress island landmarks if screenshots show they still breathe.
- **Risk: richer water hurts animation performance.** Control: keep effect density gated, use reduced-motion static phases, and add terrain caching only if measured frame cost justifies it.
- **Risk: snapshots hide regressions behind broad pixel thresholds.** Control: update visual assertions to check semantic distribution and manually inspect the refreshed desktop screenshot.
- **Risk: palette drifts into generic neon dark-mode water.** Control: keep colors in a named PharosVille palette, avoid purple/blue gradient tropes, and use color for sea-state semantics.

## Non-Goals

- No new API payloads or data source additions.
- No mobile PharosVille canvas.
- No new gameplay mechanics.
- No extra map key/minimap/browser UI unless separately requested.
- No broad redesign of ships, docks, cemetery, data buildings, or the sidebar shell.
