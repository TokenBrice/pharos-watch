# Cemetery Scene Redesign Plan

## Assumptions

- This is a frontend-only pass for `/cemetery/`.
- The cemetery JSON schema and public dataset exports stay unchanged.
- Existing `logo` values in cemetery entries are the authoritative logo source.
- Pixellab is available but should only be used if a generated bitmap asset materially improves the result over CSS/SVG.

## Success Criteria

- Tombstones render as one coherent cemetery field rather than isolated year grids.
- Every entry with a cemetery logo continues to show that logo prominently on the grave and in the obituary row.
- Hover and keyboard focus reveal a compact details panel with name, cause, date, peak market cap, peg, and obituary context.
- Selecting a tombstone still expands and scrolls to the matching autopsy row by stable dead-coin id.
- The route remains static-export friendly and does not add runtime data sources.

## Plan

1. Rework `CemeteryTombstones` into a single atmospheric scene with shared ground, path, fog, year markers, and depth bands.
2. Upgrade tombstone hover/focus detail treatment and logo presentation while preserving the existing keyboard interactions.
3. Refresh the cemetery client copy and docs to describe the scene-level behavior.
4. Run focused tests and lint/type checks for the touched files.
