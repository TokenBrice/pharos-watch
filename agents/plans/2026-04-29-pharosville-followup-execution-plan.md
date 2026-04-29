# PharosVille Follow-Up Execution Plan

Date: 2026-04-29
Status: active execution plan

## Assumptions

- The civic-core implementation is complete and accepted as the baseline for follow-up work.
- The finalized handoff at `agents/handoffs/2026-04-29-pharosville-civic-core-followup.md` is the sequencing source for deferred work.
- Follow-up work should not reopen civic-core placement unless fresh validation exposes a concrete blocker.
- Runtime behavior stays desktop-only, Canvas 2D, local-asset-only, and DOM-truth-first.

## Visual Triage

Evidence reviewed:

- Existing desktop visual snapshot: `tests/visual/pharosville.spec.ts-snapshots/pharosville-desktop-shell-linux.png`.
- Current visual test contract from `tests/visual/pharosville.spec.ts`.
- Final handoff validation: PharosVille Playwright passed 9/9 after the civic-core patch, without snapshot updates.

Triage result:

- No immediate repair pass is required for data-building coordinates, scale, hit targets, or decorative hut cleanup.
- Building and dock sprite regeneration remains valuable, but should be evidence-driven and not bundled into schema/runtime work.
- The next execution-ready slice is manifest v2 because it reduces risk for later animation and coordinated asset-pack changes.

## Selected Slice: Manifest V2

Goal:

- Add a backwards-compatible manifest v2 contract that separates cache-busting from style/provenance versioning and reserves explicit animation metadata without changing current rendered assets.

Non-goals:

- Do not regenerate PNG assets in this slice.
- Do not animate any sprite yet.
- Do not add `category: "building"` until a later schema/user-facing reason exists.
- Do not change the desktop viewport gate or add API/Worker data sources.

Implementation checklist:

- Update `src/app/pharosville/systems/asset-manifest.ts` with v1/v2 types and helper accessors.
- Migrate `public/pharosville/assets/manifest.json` to schema v2 while keeping asset IDs, local paths, dimensions, anchors, hitboxes, priorities, and load groups unchanged.
- Update `scripts/pharosville/validate-assets.mjs` to validate both v1 and v2 manifests, including v2 cache/style version fields and optional animation blocks.
- Add focused tests for manifest helpers and v2 animation metadata shape.
- Update `agents/pharosville/ASSET_PIPELINE.md` and `docs/pharosville-page.md` to document schema v2.

Validation checklist:

- `npm run check:pharosville-assets`
- `npm test -- src/app/pharosville/systems/asset-manifest.test.ts src/app/pharosville/renderer/hit-testing.test.ts`
- `npm run build`
- `npm run test:visual -- pharosville.spec.ts`

Follow-up after manifest v2:

- Run a dock family art-direction pass before regenerating every dock sprite.
- Use v2 animation metadata for one low-risk building pilot only after static v2 validation is stable.
- Keep dense inspection/filter UI DOM-first and separate from sprite/manifest changes.
