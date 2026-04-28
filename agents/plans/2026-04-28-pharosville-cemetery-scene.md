# PharosVille Cemetery Scene Plan

## Assumptions

- The reported unchanged cemetery is the PharosVille canvas cemetery, not the standalone `/cemetery/` page.
- Existing hover and detail behavior should remain intact.
- Cemetery entries already have local logo assets under `public/logos/cemetery/`.

## Success Criteria

- The PharosVille cemetery no longer renders as a dense or linear block of identical tombstones.
- Grave nodes carry cemetery logo paths and the canvas preloads those logos.
- The cemetery reads as one larger memorial precinct with scattered tombs, varied marker scale/shape, ground treatment, paths, atmosphere, and stablecoin logo medallions.
- Tomb markers avoid the old obelisk/sprite look and carry cause-of-death plaques keyed to the same categories as the cemetery cause legend.
- Focused PharosVille tests pass.

## Plan

1. Add `logoSrc` to grave world nodes.
2. Replace the rectangular grave placement with deterministic scatter placement inside an expanded cemetery region.
3. Draw cemetery ground, paths, fence posts, mausoleum/tree/shrub context, mist, shadows, cause accents, and per-grave logo medallions.
4. Update PharosVille docs/tests and run focused validation.

## Follow-Up Refinement

- Reworked the canvas tombstones into procedural headstone, cross, tablet, ledger, and reliquary variants.
- Made marker selection cause-aware and rendered each stone with a cause-of-death plaque using the shared cause color map.

## Sizing Pass

- Reduced the full cemetery footprint and context props to roughly 60% of the prior pass.
- Reduced grave marker scale to roughly 36% of the original marker sizing, preserving deterministic scatter placement and hover hit targets.
