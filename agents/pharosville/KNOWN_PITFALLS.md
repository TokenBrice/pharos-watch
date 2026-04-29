# PharosVille Known Pitfalls

Last updated: 2026-04-29

These are repeat-risk areas for agents working on PharosVille.

## Data And Semantics

- Do not multiply DefiLlama list `circulating` values by price. They are already USD-denominated for this surface.
- Do not turn docking cadence into transfer, bridge, or transaction-flow semantics.
- Do not let stale or missing peg evidence become storm/depeg risk.
- Do not add Worker/API endpoints for visual-only work without an explicit data-contract request.
- Do not add production fallback fixture data. The route should show loading/error states instead of invented market data.
- Do not encode analytical meaning only in pixels. Detail panels and the accessibility ledger need matching text.

## Visual And Renderer

- Do not reference Pixellab candidate paths, remote URLs, or prototype assets at runtime.
- Do not add ad hoc colors that bypass `palette.ts`, `world-canvas.ts` route constants, or shared classification colors.
- Do not change manifest geometry without checking hitboxes, anchors, selection rings, and visual tests.
- Do not move ships with a different model than hit testing and debug state use.
- Do not reintroduce old harbor-scene/layer/sprite stack code; the current stack is `systems/` plus Canvas 2D `renderer/`.
- Do not weaken canvas pixel budgets for a cosmetic fix.

## Viewport And Accessibility

- Do not mount the world below `1280px` width or `760px` height.
- Do not fetch world data, manifest, sprites, or logos in the fallback viewport.
- Do not start a RAF loop under reduced motion.
- Do not remove keyboard pan, Escape clear, toolbar controls, blank-map clear, or DOM detail parity when changing interactions.

## Tests And Docs

- Do not rely on the desktop screenshot alone. Pair visual changes with focused world-model, hit-testing, asset, and palette checks.
- Do not update snapshots for unintentional drift.
- Do not treat historical `*-plan.md` files as authoritative when they conflict with `CURRENT.md`.
- Do not forget `docs/pharosville-page.md` for user-visible route behavior changes.
- Do not forget this agent pack when changing process, assets, scenarios, or validation workflow.
