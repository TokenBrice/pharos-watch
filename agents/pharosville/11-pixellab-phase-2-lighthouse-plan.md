# Pixellab Phase 2 Lighthouse Plan

Created: 2026-04-28

## Purpose

Explore Pixellab MCP as the asset path for Phase 2 PharosVille refinements, with the lighthouse upgraded from a small barebone marker into the primary "Pharos" landmark: a heroic, Alexandria-inspired PSI beacon that still fits the current Canvas 2D route, static export, asset manifest, and validation constraints.

The four user-provided lighthouse references should be treated as inspiration for massing only: stepped base, tall tapered tower, colonnaded lantern gallery, bronze/fire beacon, and island-harbor monumentality. Do not copy any exact artwork or copyrighted game asset.

## Current Constraints

- Runtime route stays `/pharosville/` with desktop gate, Canvas 2D renderer, and static assets under `public/pharosville/assets/`.
- Current manifest: `public/pharosville/assets/manifest.json`.
- Current asset count: `12`; validator cap: `34`.
- Current first-render critical assets: `landmark.lighthouse`, `dock.wooden-pier`, `ship.treasury-galleon`, `prop.tombstone`.
- Current lighthouse asset:
  - id: `landmark.lighthouse`
  - path: `landmarks/lighthouse.png`
  - dimensions: `96 x 128`
  - anchor: `[48, 116]`
  - footprint: `[24, 20]`
  - hitbox: `[18, 8, 60, 112]`
- Renderer lookup is hard-coded to `assets?.get("landmark.lighthouse")` in `src/app/pharosville/renderer/world-canvas.ts`.
- Renderer great-fire origin was previously hard-coded near `center.y - 88 * camera.zoom`, which was tuned to the old `96 x 128` asset.
- Asset validator rejects orphan PNGs under `public/pharosville/assets`, placeholder/checker/debug names, remote URLs, token markers, dimension mismatches, missing anchors, missing hitboxes, and manifests above 34 assets.

## Pixellab Tooling Result

Available MCP tools include:

- `mcp__pixellab__.create_map_object`: best fit for lighthouse, docks, buoys, warehouses, fog/glow overlays, and ship-scale props. Supports transparent background and non-square canvases up to `400 x 400`.
- `mcp__pixellab__.get_map_object`: polls and retrieves generated map objects.
- `mcp__pixellab__.create_tiles_pro`: best fit for multi-tile terrain, water, shore, and small repeated harbor tiles.
- `mcp__pixellab__.create_isometric_tile`: best fit for compact single tiles and small overlays.

For the lighthouse, use `create_map_object` in basic mode first. Style-matching mode is better after a reviewed map screenshot/crop exists, but its inpainting area limit makes it less ideal for a tall `128 x 192` hero landmark.

## Autonomous Proof

Generated and saved one non-production concept with Pixellab:

- Tool: `mcp__pixellab__.create_map_object`
- Object ID: `5a360bcb-030a-4156-8f07-33007be4243d`
- Size: `128 x 192`
- View: `low top-down`
- Outline: `single color outline`
- Shading: `medium shading`
- Detail: `high detail`
- Local proof path: `agents/pharosville/pixellab-prototypes/lighthouse-alexandria-concept-128x192.png`
- Downloaded PNG dimensions: `128 x 192`, RGBA, non-interlaced
- Production manifest was intentionally not modified for this proof.

The `get_map_object` status text reported `128 x 128`, but the downloaded PNG IHDR and `file` output confirm the requested `128 x 192` dimensions. Use downloaded image dimensions, not the status summary, before manifesting any production candidate.

Prompt used:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea compatible palette, pale limestone and warm sandstone monumental lighthouse inspired by the Great Lighthouse of Alexandria without copying any exact artwork, three-tier stepped square base, tall tapered central tower, colonnaded gallery, bronze fire beacon, gold beacon light, heroic landmark silhouette, transparent background, no text, no logos, no UI, readable at small game-map scale
```

## Phase 2 Implementation Result

Implemented on 2026-04-28 after user direction that the lighthouse must use a great fire rather than a sweeping beam.

Generated two additional candidates:

- `4eb52366-3404-48cb-8a6c-5d81ace01f3d` -> `agents/pharosville/pixellab-prototypes/lighthouse-alexandria-candidate-4eb52366.png`
- `4b842844-e736-4539-96bb-b3134be11328` -> `agents/pharosville/pixellab-prototypes/lighthouse-alexandria-candidate-4b842844.png`

Promoted `4eb52366-3404-48cb-8a6c-5d81ace01f3d` because it has the clearest monumental silhouette, broad podium, readable colonnaded lantern, and strongest harbor-map contrast.

Production changes:

- Added `public/pharosville/assets/landmarks/lighthouse-alexandria.png`.
- Removed the old `public/pharosville/assets/landmarks/lighthouse.png` so the validator has no orphan production PNG.
- Kept manifest ID `landmark.lighthouse`, changed its path and dimensions to `128 x 192`, and bumped `style.assetVersion` to `2026-04-28-v2`.
- Replaced the renderer's lighthouse beam with an ancient-style code-rendered great fire at an asset-derived lantern point.
- Kept six dock variant PNGs in production because the Phase 2 dock manifest and renderer now reference per-dock `assetId` values.

## Production Lighthouse Asset Plan

Prefer replacing the current lighthouse art under the same manifest ID instead of adding a second lighthouse ID. That keeps the route and renderer lookup stable.

Primary production candidate:

```json
{
  "id": "landmark.lighthouse",
  "path": "landmarks/lighthouse-alexandria.png",
  "category": "landmark",
  "layer": "landmarks",
  "width": 128,
  "height": 192,
  "displayScale": 1,
  "anchor": [64, 180],
  "footprint": [32, 28],
  "hitbox": [26, 10, 76, 168],
  "loadPriority": "critical",
  "tool": "mcp:create_map_object",
  "promptProvenance": {
    "jobId": "<pixellab-object-id>",
    "styleAnchorVersion": "2026-04-28-v2"
  }
}
```

Production prompt:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, transparent background, no text, no logos, no UI. PharosVille PSI lighthouse landmark inspired by the ancient Great Lighthouse of Alexandria without copying exact artwork: broad stepped square island-temple base, pale limestone and warm sandstone masonry, tall tapered central tower, arched window rhythm, colonnaded lantern gallery, bronze beacon brazier, gold beacon light, heroic readable silhouette, restrained Pharos palette of deep navy, teal, limestone, bronze, and gold.
```

Pixellab parameters:

```json
{
  "width": 128,
  "height": 192,
  "view": "low top-down",
  "outline": "single color outline",
  "shading": "medium shading",
  "detail": "high detail"
}
```

Acceptance criteria:

- Reads as the dominant landmark at `1440 x 1000` without overwhelming the map.
- Top lantern is visually clear at normal zoom.
- Base is broad enough to imply a Wonder-scale monument but does not cover more than about `2 x 2` map tiles visually.
- Transparent background has no dark halo or large semi-transparent rectangle.
- No embedded text, logos, UI, or reference-art copying.
- Works with current old-school maritime palette and does not push the scene into a beige-only map.

## Renderer Consumption

Files:

- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/landmarks/lighthouse-alexandria.png`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts` only if selection geometry needs asset-aware tuning
- `tests/visual/pharosville.spec.ts` after screenshot review

Renderer changes:

1. Keep `assets?.get("landmark.lighthouse")`.
2. Replace the hard-coded fire origin with a value derived from the loaded asset entry:

```ts
const beacon = lighthouseAsset
  ? {
      x: center.x + (lighthouseAsset.entry.width / 2 - lighthouseAsset.entry.anchor[0]) * camera.zoom,
      y: center.y - (lighthouseAsset.entry.anchor[1] - 30) * camera.zoom,
    }
  : { x: center.x, y: center.y - 88 * camera.zoom };
```

3. Draw the sprite first, then draw a large code-rendered brazier/fire at the derived lantern point. The v2 art direction uses an ancient great fire, not a modern sweeping beam.
4. Adjust selection rect/hitbox only if the larger hit target causes accidental dock/ship clicks.

## Phase 2 Harbor Companion Assets

These should be deferred assets unless a specific first-render semantic requires them. Together with the lighthouse replacement, the count stays well under the current cap.

1. `dock.warehouse-stack`
   - Path: `docks/warehouse-stack.png`
   - Size: `64 x 64`
   - Anchor: `[32, 54]`
   - Footprint: `[18, 14]`
   - Use: child marks on large chain docks, derived from stablecoin count/top share.
   - Tool: `create_map_object`

2. `prop.beacon-buoy`
   - Path: `props/beacon-buoy.png`
   - Size: `48 x 48`
   - Anchor: `[24, 38]`
   - Footprint: `[8, 8]`
   - Use: risk-zone boundary buoys and DEWS watch markers.
   - Tool: `create_map_object`

3. `overlay.fog-patch`
   - Path: `overlays/fog-patch.png`
   - Size: `96 x 64`
   - Anchor: `[48, 32]`
   - Footprint: `[32, 18]`
   - Use: stale/missing/low-confidence evidence from `world.effects`.
   - Tool: `create_map_object`

4. `overlay.fire-glow`
   - Path: `overlays/beacon-glow.png`
   - Size: `96 x 96`
   - Anchor: `[48, 48]`
   - Footprint: `[24, 24]`
   - Use: optional PSI glow behind code-drawn fire.
   - Tool: `create_map_object`

Recommended companion prompts:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, transparent background, no text, no logos, no UI, PharosVille harbor warehouse stack, limestone dock, wooden crates, canvas awning, restrained navy teal limestone bronze palette, readable small prop
```

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, transparent background, no text, no logos, no UI, small harbor risk beacon buoy, bronze cap, teal waterline shadow, warm lamp, readable small prop
```

```text
old-school 16-bit maritime isometric RPG pixel art overlay, transparent background, soft but pixel-crisp data fog patch, pale blue gray mist, no text, no logo, sparse alpha, readable over teal water
```

## Manifest And Versioning Steps

1. Generate and review at least two `128 x 192` lighthouse candidates.
2. Save chosen production PNG to `public/pharosville/assets/landmarks/lighthouse-alexandria.png`.
3. Replace the existing `landmark.lighthouse` manifest entry path/dimensions/anchor/hitbox.
4. Bump `style.assetVersion` from `2026-04-28-v1` to `2026-04-28-v2`.
5. Set `promptProvenance.jobId` to the accepted Pixellab object ID and `styleAnchorVersion` to `2026-04-28-v2`.
6. Keep `requiredForFirstRender` unchanged.
7. Do not leave `landmarks/lighthouse.png` under `public/pharosville/assets` unless the manifest still references it; otherwise the validator will fail it as an orphan PNG.

## Validation

Focused asset checks:

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
```

Renderer/model checks after integration:

```bash
npx vitest run src/app/pharosville
npm run build
npx playwright test tests/visual/pharosville.spec.ts
```

Visual review checklist:

- Desktop shell screenshot confirms nonblank map and lighthouse dominance.
- Lighthouse great-fire origin lands on the lantern at normal zoom and after wheel zoom.
- Hit testing still selects `lighthouse` intentionally.
- Reduced-motion screenshot remains deterministic.
- Fallback view still makes no world API, manifest, or asset requests.

## Next Implementation Slice

1. Review the generated proof PNG under `agents/pharosville/pixellab-prototypes/`.
2. If the silhouette is acceptable, run one or two additional candidates with the production prompt and fixed size.
3. Select one production candidate and replace `landmark.lighthouse` in the manifest.
4. Update `world-canvas.ts` beacon origin math to derive from the asset entry.
5. Run asset validation and focused PharosVille tests.
