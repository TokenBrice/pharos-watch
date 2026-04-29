# Lighthouse Hill Regeneration Plan

Date: 2026-04-29

## Assumptions

- The active target is `/pharosville/`.
- The current PharosVille worktree changes are intentional and should be preserved.
- The desired change is to replace the existing `landmark.lighthouse` production asset, not add a second lighthouse entity.
- The lighthouse should visually read as the central Pharos landmark and sit on a rugged elevated hill/mountain that is part of the sprite.

## Current Situation

- Current production asset: `public/pharosville/assets/landmarks/lighthouse-alexandria.png`.
- Current manifest entry: `landmark.lighthouse`, `128 x 192`, anchor `[64, 180]`, footprint `[32, 28]`.
- Current renderer scales the lighthouse asset by `camera.zoom * 1.48` and draws an additional code-rendered headland/pedestal under it.
- The screenshot problem is mostly silhouette and grounding: the tower reads as a neat tower on a flat plinth, while the supporting hill reads as a low decorative pad rather than a mountain.
- Pixellab style-matching/inpainting is not the right primary path because the tall lighthouse plus hill needs more vertical room than the 192x192 inpainting limit.

## Options Considered

1. Keep the `128 x 192` tower and enlarge the code-drawn hill.
   - Low risk, but keeps the core asset looking like a flat-base tower.
   - Does not deliver the requested inspiration of a lighthouse sitting on top of a mountain.

2. Generate a separate mountain sprite and assemble the lighthouse on top in code.
   - More controllable, but adds new asset and alignment complexity.
   - Increases risk of perspective mismatch between tower and hill.

3. Generate one integrated lighthouse-on-hill sprite with transparent background.
   - Best fit for the vision.
   - Keeps the runtime manifest stable under the existing `landmark.lighthouse` id.
   - Requires manifest dimension, anchor, hitbox, and beacon point checks.

## Selected Path

Use Pixellab `create_map_object` in basic mode to generate multiple integrated lighthouse-on-hill candidates:

- `192 x 256`: balanced sprite, likely easiest to integrate.
- `224 x 288`: grander wonder-scale sprite, more visual dominance.
- `192 x 288`: taller dramatic silhouette with narrower footprint.

Choose the strongest candidate by:

- Reads as an old-school RPG isometric asset.
- Hill/mountain is visibly part of the sprite.
- Tower sits on the summit rather than beside or in front of the hill.
- Transparent background is clean.
- No text, logos, UI, modern lamp hardware, or flat detached plinth.
- Works at the route's normal zoom without swallowing nearby harbors.

## Integration Checklist

- Save the chosen candidate under `agents/pharosville/pixellab-prototypes/`.
- Replace `public/pharosville/assets/landmarks/lighthouse-alexandria.png`.
- Update `public/pharosville/assets/manifest.json` dimensions, anchor, footprint, hitbox, asset version, and Pixellab job id.
- Keep manifest id `landmark.lighthouse`.
- Check whether `lighthouseBeaconPoint()` still places the code-rendered fire on the generated lantern.
- Run `node scripts/pharosville/validate-assets.mjs`.
- Run focused PharosVille tests before claiming completion.

## Follow-Up Refinement

User review accepted the hill direction and requested:

- Hill/cliff height reduced by about 30%.
- Door rotated toward the island side.
- Stairs extended to the ground/end of the hill.

Generated three revised Pixellab candidates:

- `a248af36-255f-4936-8a62-49938a763f00`: lower hill, but the stairs were missing.
- `eb0d494c-ed95-4352-8c3c-9f113bdaad06`: best match; shorter cliff, left/island-facing stair run, stairs reach the hill base.
- `a448923a-dfd4-4113-8168-aa9accd904cb`: strong lower hill, but the path still read too much like a top path and kept water-framing.

Promoted `eb0d494c-ed95-4352-8c3c-9f113bdaad06` and bumped the asset cache version to `2026-04-29-lighthouse-hill-v2`.
