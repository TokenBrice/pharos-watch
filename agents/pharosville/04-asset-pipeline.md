# Asset Pipeline

## Recommendation

Use a manifest-first static asset pipeline inspired by ClaudeVille.

Do not begin with a full Pixellab map bake. First build the renderer, world model, and placeholder visual grammar. Then generate assets for known manifest entries and replace placeholders incrementally.

## Directory Contract

Recommended paths:

```text
public/pharosville/assets/
  manifest.json
  _placeholder/checker-64.png
  terrain/
    water-deep.png
    water-shallow.png
    shore.png
    cobble.png
    grass.png
  buildings/
    lighthouse/
      base.png
      flame.png
      beam.png
    dock-ethereum.png
    dock-generic.png
    cemetery-gate.png
    market-exchange.png
    mint-house.png
  ships/
    merchant-galleon.png
    bridge-barge.png
    defi-sloop.png
    algo-skiff.png
    bullion-barge.png
  props/
    tombstone-arch.png
    tombstone-slab.png
    buoy-warning.png
    cargo-crate.png
  overlays/
    selection-ring.png
    risk-watch.png
    risk-danger.png
```

Generated helper scripts:

```text
scripts/pharosville/
  validate-assets.mjs
  capture-baseline.mjs
  visual-diff.mjs
  generate-pixellab-assets.mjs
```

`validate-assets.mjs` should verify:

- Every manifest asset exists.
- PNG dimensions match manifest.
- Required anchors are present.
- `assetVersion` exists.
- No missing placeholder in production manifest.
- Required fields exist: `id`, `path`, `width`/`height` or `size`, `anchor`, `category`, `layer`, `displayScale`, `promptProvenance`.
- Image byte size is plausible for PNG, so JSON error bodies from async endpoints are not accidentally saved.
- Optional alpha-edge check warns about nontransparent fringes for transparent sprites.
- Optional optimization check warns when PNGs are unusually large.

## Manifest Shape

Use JSON:

```json
{
  "style": {
    "assetVersion": "2026-04-28-v1",
    "anchor": "old-school high-fantasy isometric pixel art, crisp pixel edges, limited maritime palette, medieval island city, no text, no UI"
  },
  "terrain": [
    {
      "id": "terrain.water.deep",
      "path": "terrain/water-deep.png",
      "tool": "create_isometric_tile",
      "size": 48,
      "displayScale": 2,
      "category": "terrain",
      "layer": "terrain",
      "anchor": [24, 24],
      "prompt": "deep ocean tile, navy and teal wave facets",
      "promptProvenance": {
        "styleAnchorVersion": "2026-04-28-v1",
        "tool": "mcp:create_isometric_tile",
        "seed": 4282026
      }
    }
  ],
  "ships": [
    {
      "id": "ship.merchant-galleon",
      "path": "ships/merchant-galleon.png",
      "tool": "create_map_object",
      "width": 96,
      "height": 72,
      "displayScale": 1,
      "category": "ship",
      "layer": "ships",
      "anchor": [48, 58],
      "prompt": "large treasury merchant galleon, three masts, readable at small size",
      "promptProvenance": {
        "styleAnchorVersion": "2026-04-28-v1",
        "tool": "mcp:create_map_object"
      }
    }
  ]
}
```

Initial PNG budget:

- Terrain tiles/sheets: 8-12.
- Buildings/landmarks: 8-12.
- Ships: 6-8.
- Props/vegetation/cemetery: 12-18.
- Overlays/status: 8-12.
- Total initial requests/assets target: 45-60 PNGs, before any optional character/NPC work.

Loading strategy:

- Load required terrain/building/ship core first.
- Lazy-load decorative props and optional overlays after first render.
- Prefer sprite sheets for terrain and repeated overlays once the art direction stabilizes.
- Production manifest validation must fail on any required placeholder/checker asset.

## Pixellab Tool Selection

From ClaudeVille's verified runbook:

- `create_isometric_tile`: small terrain, overlays, floor rings, compact props. 16-64 px, prefer 32+.
- `create_map_object`: transparent larger props/ships/buildings up to 400x400.
- `create_tiles_pro`: multi-tile terrain experiments. Higher cost, useful after style is established.
- `create_character`: not necessary for v1 unless animated keepers/citizens are added.
- REST PixFlux: useful for hero buildings or larger composed assets, but requires a dedicated script.

Recommended PharosVille use:

| Asset | Tool |
| --- | --- |
| Water / shore / cobble tiles | `create_isometric_tile` first, `create_tiles_pro` if transitions need improvement |
| Lighthouse hero | `create_map_object` or REST PixFlux |
| Docks | `create_map_object` or composed smaller isometric tiles |
| Ships | `create_map_object` with transparent background |
| Tombstones | `create_map_object` or `create_isometric_tile` |
| Risk/status overlays | `create_isometric_tile` thin tile |

## Smoke Test Result

Started a low-cost Pixellab MCP smoke test:

- Tool: `create_isometric_tile`
- Tile ID: `cfde765b-c17e-4d49-9f33-bb8818b2a18b`
- Prompt: deep ocean isometric water tile for medieval island city map
- Size: `48x48`
- Shape: thin tile
- Seed: `4282026`

The first poll returned processing status, confirming the MCP path is reachable. The asset was not committed; this was only a feasibility smoke.

Follow-up poll completed successfully:

- Status: completed.
- Download URL returned by MCP: `https://api.pixellab.ai/mcp/isometric-tile/cfde765b-c17e-4d49-9f33-bb8818b2a18b/download`
- Result preview read as a small teal/navy isometric water tile.
- No file was downloaded or committed because this research phase should not add production assets.

## Generation Rules

1. Read `style.anchor` from the manifest.
2. Prepend it to each asset prompt.
3. Pass view/outline/shading/detail as parameters, not duplicated prose.
4. Generate one asset category at a time.
5. Save PNGs to manifest-implied paths.
6. Run alpha trim / edge cleanup for transparent props and ships when needed.
7. Run PNG optimization before committing broad batches.
8. Run `scripts/pharosville/validate-assets.mjs`.
9. Review assets at actual in-world scale before accepting them.
10. Bump `style.assetVersion` for changed PNGs.
11. Capture visual baselines after renderer integration.

## Style Constraints

PharosVille should be:

- Old-school RPG and maritime.
- High-fantasy but not whimsical at the expense of analytics.
- Crisp pixel edges.
- Limited palette.
- Semantic risk colors only where status is encoded.
- Dark-first compatible.
- Readable at zoomed-out distances.

Avoid:

- Text inside generated sprites.
- Logos inside generated sprites.
- Generic fantasy clutter.
- High-detail assets that turn muddy at 48-96 px.
- Purple gradient / Web3 marketing aesthetics.
- Overly brown/tan map palette.

## Asset Quality Risks

Risk: inconsistent perspective.

Mitigation: enforce `low top-down` / isometric prompts and inspect assets before manifesting.

Risk: transparent-edge bleed.

Mitigation: add post-processing for alpha trimming if using REST PixFlux; ClaudeVille's `generate-pixellab-revamp.mjs` has relevant edge-cleanup logic.

Risk: generated ships do not read at small sizes.

Mitigation: start with exaggerated silhouettes and test at actual canvas scale.

Risk: asset churn invalidates visual regressions.

Mitigation: version asset batches and update baselines only after review.

Risk: key exposure.

Mitigation: keep Pixellab calls in local scripts or MCP only. Never expose Pixellab keys in browser code or `NEXT_PUBLIC_*`.
