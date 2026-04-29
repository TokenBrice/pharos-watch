# PharosVille Asset Pipeline

Last updated: 2026-04-29

This is the agent-facing workflow for PharosVille raster assets. Runtime asset truth is `public/pharosville/assets/manifest.json`.

## Asset Rules

- Generate or stage candidates under `agents/pharosville/pixellab-prototypes/` first.
- Promote selected PNGs to `public/pharosville/assets/` only after they are chosen for runtime use.
- Runtime code must reference local manifest asset IDs, not Pixellab URLs, remote URLs, tokens, or prototype paths.
- Every runtime PNG needs a manifest entry with accurate dimensions, anchor, footprint, hitbox, layer/category, load priority, semantic role when useful, and prompt provenance.
- Manifest schema v2 separates `style.cacheVersion` from `style.styleAnchorVersion`.
- Bump `style.cacheVersion` whenever promoted asset bytes, manifest geometry, or animation frame assets change.
- Keep `promptProvenance.jobId` and `promptProvenance.styleAnchorVersion` aligned with the selected asset's style anchor.
- Optional frame-based animation metadata belongs in `asset.animation`; keep `path` as the static/reduced-motion source unless a future renderer change says otherwise.

## Current Runtime Asset Areas

- Terrain tiles: `public/pharosville/assets/terrain/`
- Landmark: `public/pharosville/assets/landmarks/lighthouse-alexandria.png` as `landmark.lighthouse`
- Chain docks: `public/pharosville/assets/docks/`
- Ships: `public/pharosville/assets/ships/`
- Props: `public/pharosville/assets/props/`
- Manifest: `public/pharosville/assets/manifest.json`

## Pixellab Guidance

Use transparent PNG map-object generation for standalone sprites and tile generation for repeatable terrain. Keep prompts consistent with the manifest style anchor:

```text
old-school 16-bit maritime isometric RPG pixel art, crisp pixel edges, low top-down view, deep navy and teal sea, pale limestone island city, bronze and gold beacon light, restrained analytics palette, readable silhouettes, no text, no logos, no UI
```

Preferred constraints:

- Transparent background for objects.
- Low top-down/isometric viewpoint.
- Readable silhouette at route zoom.
- No embedded text, logos, UI, or photorealistic details.
- restrained palette that works with the existing sea/island colors.

## Promotion Checklist

1. Save candidate PNGs under `agents/pharosville/pixellab-prototypes/`.
2. Select one candidate and copy only the chosen production asset into `public/pharosville/assets/...`.
3. Verify actual PNG dimensions before editing the manifest.
4. Update manifest geometry, cache/provenance versions, and optional animation metadata.
5. Re-check renderer assumptions for anchor, scale, beacon points, sail-logo offsets, and hitboxes.
6. Run focused asset and visual checks.

## Required Checks For Asset Changes

```bash
npm run check:pharosville-assets
npm run check:harbor-palette
```

For geometry, anchor, hitbox, or visible sprite changes, also run focused unit tests and visual checks:

```bash
npm test -- src/app/pharosville/renderer/hit-testing.test.ts src/app/pharosville/systems/pharosville-world.test.ts
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
```

Use `npm run build` and `npm run seo:check` when the change affects the static route artifact or is part of release validation.

## Common Failure Modes

- Manifest dimensions do not match the PNG.
- Anchor/footprint changes make hit targets or selection rings drift from the drawn sprite.
- Lighthouse beacon geometry no longer lands on the lantern.
- Sail-logo offsets no longer fit a replacement ship sprite.
- A prototype or remote URL leaks into runtime paths.
- Too many critical assets slow first render; keep first-render priority narrow.
