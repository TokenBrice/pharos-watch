# Technical Architecture

Note: `08-implementation-plan.md` is the current source of truth for v0.1 sequencing. This architecture note describes the reconciled `/lighthouse/` replacement direction, but defer to `08` where details differ.

## Route Shape

Current implementation route:

```text
src/app/lighthouse/
  page.tsx
  client.tsx
  desktop-only-fallback.tsx
  pharosville-world.tsx
  pharosville.css
  components/
    detail-panel.tsx
    world-toolbar.tsx
    accessibility-ledger.tsx
    loading-state.tsx
  systems/
    world-adapter.ts
    world-types.ts
    projection.ts
    camera.ts
    hit-testing.ts
    layout.ts
    clustering.ts
    rng.ts
    motion-policy.ts
    asset-manager.ts
  renderer/
    render-loop.ts
    canvas-budget.ts
    layers/
      terrain-layer.ts
      water-layer.ts
      landmark-layer.ts
      dock-layer.ts
      ship-layer.ts
      cemetery-layer.ts
      weather-layer.ts
      ui-overlay-layer.ts
    sprites/
      draw-placeholder-ship.ts
      draw-placeholder-landmark.ts
      sprite-renderer.ts
  __fixtures__/
    world-data.ts
```

Use a Server Component for metadata and a Client Component for viewport gating. The gate must render the `<1280px` fallback before mounting query hooks, the world model, canvas runtime, manifest fetch, or sprite loader. Keep the canvas module browser-only if it touches DOM APIs during construction.

## Data Flow

```text
TanStack Query hooks
  -> PharosVilleInputs
  -> buildPharosVilleWorld(inputs)
  -> WorldSnapshot
  -> Renderer update(snapshot)
  -> Canvas draw + DOM detail panel + accessibility ledger
```

V1 hooks:

- `useStablecoins()`
- `useChains()`
- `useStabilityIndexDetail()`
- `usePegSummary()`
- `useStressSignals()`
- `useReportCards()`

Optional v1.5 hooks:

- `useDexLiquidity()`
- `useMintBurnFlows()`
- `useYieldRankings()`

Load policy:

- Fetch the V1 hooks in parallel only after the desktop viewport gate passes.
- Lazy-load optional v1.5 datasets when the matching layer is enabled or when the selected entity needs that detail.
- Never call external `https://api.pharos.watch` directly from the browser route; use existing hooks/helpers so production reads go through same-origin `/_site-data/*`.

The adapter must be pure TypeScript and unit-tested. It should not import React, DOM, Canvas, or Worker-only code.

## World Snapshot Types

Suggested shape:

```ts
interface PharosVilleWorld {
  generatedAt: number;
  freshness: WorldFreshness;
  map: WorldMap;
  lighthouse: LighthouseNode;
  districts: DistrictNode[];
  docks: DockNode[];
  ships: ShipNode[];
  shipClusters: ShipClusterNode[];
  graves: GraveNode[];
  effects: WorldEffect[];
  legends: LegendItem[];
}
```

Entity contracts:

- Every entity has a stable `id`, `kind`, `label`, `tile`, `sortY`, `dataRefs`, and `selectable`.
- Every visual encoding has a matching human-readable `legend` item.
- Every selectable entity has a DOM detail model.

## Rendering Stack

Use Canvas 2D:

- DPR capped at 2.
- `imageSmoothingEnabled = false`.
- Terrain rendered to cache canvas.
- Water/weather/ships/effects rendered per frame.
- Draw visible tiles only.
- Sort overlapping entities by projected Y.
- Use deterministic hash variants for ship/prop variation.

ClaudeVille patterns to adapt:

- `Camera.js` pan/zoom/follow model.
- `CanvasBudget.js` effective DPR/backing-store guardrails.
- `AssetManager.js` manifest loading, cache busting, placeholder fallback.
- `SpriteRenderer.js` pixel-snapped blits.
- `SceneryEngine.js` authored terrain/water masks.
- `Minimap.js` click-to-pan overview.

Pharos-specific changes:

- React/TanStack Query state instead of event bus.
- TypeScript modules.
- Responsive layout.
- DOM-first detail and controls.
- Query freshness integrated into world state.

Coverage note:

- Build ship entities from `/api/stablecoins` `chainCirculating`, not from `/api/chains.topStablecoins`.
- Use `chains.topStablecoins` only for dock summary decorations and default berth labels.

Normalization note:

- `world-adapter.ts` should import `ACTIVE_IDS` / `ACTIVE_META_BY_ID` from `@shared/lib/stablecoins`.
- It should import `getCirculatingRaw`, `getPrevDayRawOrNull`, `getPrevWeekRawOrNull`, and `getPrevMonthRawOrNull` from `@shared/lib/supply`.
- It should import `canonicalizeChainCirculating` or `findCanonicalChainData` from `@shared/lib/chain-circulating`.
- It should use `buildPegSummaryCoinMap()` and a report-card map before entity construction.
- It should not multiply supply by price.
- It should not scan all response arrays inside every ship loop.

## Asset Runtime

Use `public/pharosville/assets/manifest.json`.

Prefer JSON over YAML in Pharos to avoid adding `js-yaml`.

Example:

```json
{
  "style": {
    "assetVersion": "2026-04-28-v1",
    "anchor": "old-school high-fantasy isometric pixel art..."
  },
  "terrain": [],
  "buildings": [],
  "ships": [],
  "props": [],
  "overlays": []
}
```

`AssetManager` responsibilities:

- Fetch manifest and images.
- Append `?v=<assetVersion>` to image URLs.
- Decode dimensions and anchors.
- Provide placeholder checker only in development or explicit missing state.
- Expose missing asset diagnostics.

Do not block the full page on final art in phase 1. Render code-drawn placeholders first, then swap in sprites. Production must not render test fixture market data as live data.

## Map Layout

Use authored layout, not dynamic random layout.

Recommended files:

- `systems/layout.ts` — district/dock/landmark coordinates.
- `systems/map-fixture.ts` — water/land tile masks.
- `systems/layout.test.ts` — no overlaps, water ratio, required landmarks present.

The map should be deterministic and stable across reloads. Data changes should move ships and effects, not reshuffle the island itself.

## Interaction Model

Canvas:

- Pointer hover highlights selectable entity.
- Click selects entity.
- Drag pans camera.
- Wheel/pinch zooms camera.
- Double-click / toolbar button follows selected entity.
- Escape clears selection.

DOM:

- Toolbar filters: risk band, chain, stablecoin type, show clusters/all/top assets.
- Detail panel mirrors selected entity.
- Keyboard list allows selecting lighthouse, docks, ships, and graves without using canvas.
- Links route to existing analytical pages.

Selection state should live in React, with renderer callbacks:

```ts
onSelect(entityRef)
onHover(entityRef | null)
selectedEntityId
filters
```

## Desktop Gate And Layout

V0.1 is desktop-only for the world renderer.

Desktop:

- Canvas fills main panel.
- Detail panel docked right or collapsible.
- Minimap bottom-right.

Narrow screens below `1280px`:

- Render a polished DOM desktop-only fallback.
- Do not mount the query-backed world component.
- Do not fetch the asset manifest or decode sprites.
- Include links to existing analytical pages.

Acceptance: no text/control overlap at desktop widths; canvas nonblank and navigable at desktop; fallback visible and no canvas/runtime requests below `1280px`.

## Accessibility

- Canvas `aria-hidden="true"`.
- DOM ledger lists all encoded summaries:
  - PSI score/band.
  - Chain dock sizes and health.
  - Ship/cluster counts by risk band.
  - Cemetery count and newest entries.
  - Data freshness.
- Keyboard-selectable entity list.
- Detail panel has exact values.
- Reduced motion freezes ship movement, weather, particles, and camera easing.
- Color never carries status alone.

Operational requirements:

- Canvas may be `aria-hidden="true"` only because all entities are reachable in DOM.
- Visible fallback/ledger panel lists lighthouse, docks, ship clusters, selected top ships, and cemetery summaries.
- Keyboard controls:
  - pan buttons or arrow-key support when the world surface is focused.
  - zoom in/out/reset buttons.
  - follow selected / clear selected buttons.
  - entity list selection without canvas pointer input.
- Toolbar/detail controls are at least 44px. Canvas entity hit slop is at least 24px where the visible sprite is smaller.
- Focus-visible styles use existing Pharos focus tokens.
- Selecting an entity moves focus to the detail panel heading or announces the change with `aria-live`.
- Escape clears selection and returns focus predictably.
- Reduced motion preserves all status cues statically.

## Performance Budget

Target:

- 60 FPS desktop in normal state.
- Main canvas and all offscreen cache backing stores capped.
- No more than top 60-80 ships individually animated at default zoom.
- Clusters for long-tail assets.
- Particle caps per layer.
- Renderer pauses when route hidden or tab not visible.
- Asset loads cached and versioned.

Budget model:

- Adapt ClaudeVille's effective-DPR pattern rather than only `Math.min(devicePixelRatio, 2)`.
- Define constants:
  - `MAX_MAIN_CANVAS_PIXELS`
  - `MAX_TERRAIN_CACHE_PIXELS`
  - `MAX_WEATHER_CACHE_PIXELS`
  - `MAX_MINIMAP_PIXELS`
  - `MAX_TOTAL_BACKING_PIXELS`
- Compute effective DPR from CSS size and total backing budget.
- Release terrain/weather/minimap caches on unmount, route hide, page visibility hidden, and canvas context loss.
- Automated tests should assert budget calculations for desktop and ultrawide CSS sizes plus the `<1280px` no-runtime gate.
- Renderer should define max visible/selectable entities by zoom:
  - default zoom: top ships + clusters.
  - medium zoom: expanded ships near viewport.
  - high zoom: all viewport ships and graves, still culled by viewport.

## Testing

Unit:

- `world-adapter.test.ts`
- `risk-placement.test.ts`
- `layout.test.ts`
- `projection.test.ts`
- `hit-testing.test.ts`
- `clustering.test.ts`
- `asset-manager.test.ts` with mocked manifest
- `canvas-budget.test.ts`

Required fixtures:

- `current` PSI is null.
- PSI contributors missing.
- Report cards stale.
- DEWS rows missing for some active coins.
- Unknown PSI and DEWS band strings.
- Frozen asset appears in stablecoins payload.
- Long-tail overload with at least 215 metadata entries.
- NAV token with missing peg summary.
- Low/fallback price confidence.
- Active depeg with null current deviation.

Visual:

- Playwright reduced-motion screenshot desktop.
- Playwright reduced-motion screenshot desktop.
- Playwright fallback screenshot below `1280px` with no canvas/manifest/API world requests.
- Canvas nonblank pixel check.
- Canvas backing-pixel budget assertion.
- No-overlap smoke for DOM overlay and detail panel.

Commands for implementation phase:

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run seo:check` if route is indexable
- `npm run test:merge-gate` before push
