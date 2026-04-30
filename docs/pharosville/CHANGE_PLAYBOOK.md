# PharosVille Change Playbook

Last updated: 2026-04-30

Use this playbook to choose the smallest safe path for `/pharosville/` work. The verified product contract remains `docs/pharosville-page.md`; this file is for maintenance execution.

## Decision Path

Start by classifying the change:

| Change type | Read first | Likely source files | Required follow-up |
| --- | --- | --- | --- |
| Route shell, desktop gate, metadata, loading, or error state | `docs/pharosville-page.md`, `CURRENT.md`, `TESTING.md` | `src/app/pharosville/page.tsx`, `client.tsx`, `desktop-only-fallback.tsx`, `pharosville-desktop-data.tsx`, `pharosville-world.tsx` | Update `docs/pharosville-page.md` for behavior changes. Run route visual checks and build/SEO for static-export changes. |
| World-model mapping or data semantics | `VISUAL_INVARIANTS.md`, `SCENARIO_CATALOG.md`, `src/app/pharosville/systems/README.md` | `systems/pharosville-world.ts`, `detail-model.ts`, `chain-docks.ts`, `risk-placement.ts`, `ship-visuals.ts`, `world-types.ts` | Keep DOM detail parity. Add or update focused system tests. Update `docs/pharosville-page.md` if visual meaning changes. |
| Layout, geography, or selectable placement | `VISUAL_INVARIANTS.md`, `VISUAL_REVIEW_ATLAS.md`, `src/app/pharosville/systems/README.md` | `systems/world-layout.ts`, `chain-docks.ts`, `pharosville-world.ts`, `renderer/hit-testing.ts` | Check target overlap, water/land ratios, desktop shell screenshot, absence of retired building targets, and interaction tests. |
| Canvas drawing or animation | `src/app/pharosville/renderer/README.md`, `VISUAL_INVARIANTS.md`, `TESTING.md` | `renderer/world-canvas.ts`, `renderer/hit-testing.ts`, `pharosville-world.tsx`, `systems/motion.ts`, `systems/canvas-budget.ts` | Keep reduced motion deterministic, hit targets aligned, and backing pixels capped. Run Playwright visual checks. |
| Asset addition or replacement | `ASSET_PIPELINE.md`, `VISUAL_REVIEW_ATLAS.md`, `src/app/pharosville/renderer/README.md` | `public/pharosville/assets/**`, `public/pharosville/assets/manifest.json`, `systems/asset-manifest.ts`, renderer draw/hitbox logic if geometry changes | Bump manifest cache/style provenance fields per `ASSET_PIPELINE.md`, validate PNG dimensions and manifest references, run asset/color checks and visual tests. |
| Fixture, scenario, or visual test update | `SCENARIO_CATALOG.md`, `VISUAL_REVIEW_ATLAS.md`, `TESTING.md` | `src/app/pharosville/__fixtures__/pharosville-world.ts`, `tests/visual/pharosville.spec.ts`, focused `*.test.ts` files | Keep scenarios realistic and fixture-only. Do not introduce production fallback data. |
| Maintenance guidance | `README.md`, `CURRENT.md`, this file | `docs/pharosville/*.md`, `docs/agent-task-router.md`, `docs/doc-ownership.json`, `docs/testing.md` | Run doc checks when verified docs changed. Keep historical context subordinate to `CURRENT.md`. |

## Edit Loop

1. Run `git status --short`.
2. Inspect the files you plan to touch and any dirty files in that scope.
3. Identify whether the change affects route behavior, visual semantics, assets, tests, docs, or maintenance process only.
4. Make the smallest route-local change that satisfies the task.
5. Update matching docs before validation, not after.
6. Run the narrow checks from the table below, then broaden when the change affects exported pages or shared contracts.

## Focused Validation

| Work area | First checks |
| --- | --- |
| World model and data mapping | `npm test -- src/app/pharosville` |
| Layout/geography | `npm test -- src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/chain-docks.test.ts` |
| Motion | `npm test -- src/app/pharosville/systems/motion.test.ts` |
| Hit testing | `npm test -- src/app/pharosville/renderer/hit-testing.test.ts` |
| Assets | `npm run check:pharosville-assets` |
| Palette/color drift | `npm run check:pharosville-colors` |
| Canvas/UI behavior | `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"` |
| Static export or metadata | `npm run build && npm run seo:check` |
| Release/deploy-impacting work | `npm run test:merge-gate` |

## Documentation Rules

- Update `docs/pharosville-page.md` when user-visible behavior, visual semantics, route shell behavior, or validation expectations change.
- Update `docs/pharosville/CURRENT.md` when entrypoints, authoritative invariants, or workflow boundaries change.
- Update `SCENARIO_CATALOG.md` when tests/fixtures gain or lose canonical scenarios.
- Update `VISUAL_REVIEW_ATLAS.md` when screenshot baselines, Playwright coverage, or manual visual review criteria change.
- Update `ASSET_PIPELINE.md` when manifest schema, asset staging, or promotion rules change.
