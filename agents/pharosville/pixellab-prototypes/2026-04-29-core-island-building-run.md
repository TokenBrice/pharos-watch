# Core Island Building Pixellab Run

Date: 2026-04-29

Style anchor:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI
```

## Selected Candidates

| Runtime asset | Pixellab job | Candidate file | Dimensions | Status |
| --- | --- | --- | --- | --- |
| `public/pharosville/assets/buildings/mint-burn-foundry.png` | `26f10191-658e-4e3b-ab51-2f24f67018ab` | `agents/pharosville/pixellab-prototypes/mint-burn-foundry-core-simplification-26f10191.png` | `192 x 160` | Selected |
| `public/pharosville/assets/buildings/exit-route-gatehouse.png` | `1edcdb61-185a-4add-b264-a7a538d338b4` | `agents/pharosville/pixellab-prototypes/exit-route-gatehouse-core-simplification-1edcdb61.png` | `192 x 160` | Selected |

## Prompts

Mint/Burn Foundry:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI. Royal mint and burn foundry civic building, pale limestone mint hall with abstract bronze press machinery, small controlled furnace chimney, warm gold windows, compact industrial courtyard, bottom-centered isometric base, transparent background, no currency symbols, no numbers, no signage, no detached background tile
```

Exit Route Gatehouse:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI. Exit route gatehouse civic building, pale stone arched road gate with raised portcullis, dry island checkpoint, contained bronze wheel and tiny internal gauge detail, warm guarded arch light, bottom-centered isometric base, transparent background, no open water basin, no currency symbols, no numbers, no signage, no detached background tile
```

## Promotion Notes

- Both selected candidates were generated with `mcp:create_map_object`,
  `width=192`, `height=160`, `view=low top-down`,
  `outline=single color outline`, `shading=medium shading`, and
  `detail=medium detail`.
- Manifest `style.cacheVersion` was bumped to
  `2026-04-29-core-island-v1`; `style.styleAnchorVersion` remains
  `2026-04-29-lighthouse-hill-v5`.
- Removed building PNGs for Yield Orchard and Dependency Loom were deleted from
  `public/pharosville/assets/buildings/` when their manifest entries were
  removed, so asset validation does not see orphan runtime PNGs.
