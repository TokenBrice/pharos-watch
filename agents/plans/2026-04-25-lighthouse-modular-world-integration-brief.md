# Lighthouse Modular World Integration Brief

Date: 2026-04-25
Scope: Architecture review and integration guidance for the `/lighthouse/` modular world-building pass.

## Assumptions

- Keep `/lighthouse/` textless on first paint. Visible data detail stays in SVG marks, icon controls, and the screen-reader ledger.
- Use existing data only: chains, PSI, aggregate DEWS, and stablecoin alt-peg data.
- Treat the current `LighthouseCinematicModel` as the integration seam. Worker patches should extend the model and layers, not add per-layer fetches or duplicate route state.
- The lighthouse beam is inspection/selection. PSI may color and power the lens, but it must not become a new route score.

## World Responsibilities

- `cinematic-model.ts`: owns deterministic geometry, finite-number sanitization, active target selection, module bounds, accessibility labels, and fallback ledger rows. Keep `LighthouseModuleId`, `LighthouseMode`, `stage.modules`, `stage.activeModuleId`, `stage.activeTarget`, and `fallbackRows` as the shared contract.
- `client.tsx`: owns committed UI state (`mode`, pinned harbor, fullscreen) and transient preview state (`previewMode`, preview harbor). Do not move hover state into individual layers.
- `ModuleIslandBaseLayer`: owns world-zone hit areas, module island masses, bridge/connection lines, and keyboard activation for modules. It should not render module-specific data marks.
- `HarborFleetLayer`: owns chain harbor ships, tail lights, harbor hover/focus preview, click/keyboard pinning, and harbor hit targets.
- `PsiLensIslandLayer`: owns PSI lens/facets only. It should not introduce per-coin or per-chain judgement.
- `DewsRadarLayer`: owns aggregate DEWS rings, sweep, calm density, and elevated blips. Keep it detached from chain harbors.
- `AltPegProjectionLayer`: owns non-USD peg projection marks and sky cohorts. Keep it visually secondary unless `atlas` is active.
- `PharosTowerLayer`: owns the central tower and beam. If the tower remains underwhelming, prefer splitting beam and tower cap into two render passes before changing data semantics: beam under marks, tower/lens/foreground rock above marks.

## Shared Interaction Contract

- Module hover/focus should set a transient preview mode through `onPreviewModule(id)` and clear through `onPreviewModuleEnd()`.
- Module click, Enter, or Space should commit mode through `onSelectModule(id)`, mapped with `MODULE_MODE`.
- Harbor hover/focus should preview `selectedHarborId` without pinning. Harbor click, Enter, or Space should pin the harbor and stop auto-cycling.
- Preview is transient: leaving/blur clears preview state and returns to the committed mode/selection.
- Fullscreen must reuse the same `LighthouseStage` props and callbacks as inline mode.
- Coarse-pointer users need a click/tap path for every zone; do not rely on hover-only discovery.

## Hooks, Classes, And Data Attributes

Use or keep:

- `buildLighthouseCinematicModel(...)`
- `MODULE_MODE: Record<LighthouseModuleId, LighthouseMode>`
- `onPreviewModule`, `onPreviewModuleEnd`, `onSelectModule`
- `onPreviewHarbor`, `onPreviewEnd`, `onSelectHarbor`
- `data-mode`, `data-active-module-id`, `data-selected-id`
- `data-module-id`, `data-harbor-id`
- `.lh-module-island`, `.lh-module-island--active`, `.lh-module-hit-area`
- `.lh-harbor-mark`, `.lh-harbor-mark--selected`
- `.lh-main-beam`, `.lh-pharos-layer`

Avoid:

- New data fetching from SVG layers.
- Visible SVG `<text>` in the first-paint stage.
- Per-chain DEWS attribution or new lighthouse scoring.
- CSS `transform` animations on SVG groups that already use a `transform` attribute for layout.
- JS animation loops, DOM measurement loops, or pointer handling outside React callbacks.

## Layer Order

Recommended order inside `LighthouseStage`:

1. `AtmosphereLayer`: sky, stars, haze, water, horizon.
2. Module bases and bridges: architectural islands, block bounds, world hit geometry.
3. Secondary module content: alt-peg projection, DEWS radar, PSI lens.
4. Beam pass: lighthouse beam aimed at `model.stage.activeTarget`.
5. Primary foreground marks: harbor fleet and selected/previewed harbor signals.
6. Tower foreground pass, if split: lens housing, tower cap, rocks, flame, and bright source details.
7. HTML controls overlay.

If keeping a single `PharosTowerLayer`, make sure the beam remains behind ships and data marks while the tower/lens remains visually strong enough to read as the hub.

## Acceptance Criteria

- First paint is a cinematic world, not a dashboard panel: no visible prose, no cards inside the SVG stage, no random-looking disconnected zones.
- The tower and lens are recognizable at desktop and mobile sizes, and the beam visibly reaches the active module or selected harbor.
- All four zones have deterministic model-owned bounds and responsibilities: harbors, lens, radar, atlas.
- Hover/focus on every module changes active focus and beam target; click/keyboard commits the mode.
- Hover/focus on harbors previews the beam target; click/keyboard pins and stops auto-cycle.
- Reduced motion disables sweep/flicker/drift while preserving all static data.
- Screen-reader ledger still exposes selected harbor, PSI, DEWS, alt-peg, and visible harbor facts.
- Tests cover module callbacks, harbor callbacks, mode/preview state, no SVG text, and finite model geometry.
- Browser screenshots cover desktop, mobile, fullscreen, and reduced-motion static state.

## High-Risk Integration Conflicts

- `src/app/lighthouse/layers/module-island-base-layer.tsx` currently adds `.lh-module-hit-area`, but `src/app/lighthouse/lighthouse-stage.css` has no rule for it. Without `fill: transparent` and intentional pointer behavior, the default SVG fill can visibly block the stage.
- Module hit areas sit in `ModuleIslandBaseLayer`, while module content layers render later as siblings. Either make non-interactive content layers `pointer-events: none` or add a dedicated topmost module interaction layer that does not cover harbor hit targets.
- `client.tsx` now has `previewMode` and `effectiveMode`. Keep auto-cycle tied to effective watch mode, but ensure temporary module hover does not pin state or clear a selected harbor.
- `preserveAspectRatio="none"` makes the full-canvas scene fill the frame, but it can distort tower/beam proportions. Validate mobile and fullscreen visually before accepting final geometry.
- Avoid reintroducing transform animation on transformed SVG groups. Previous harbor drift broke ship placement by overriding SVG `transform`.
- The worktree has active parallel edits across `/lighthouse`, docs, fullscreen, and shared fullscreen hook files. Integrate by rebasing worker patches onto the current model/layer contract, not by replacing these files wholesale.
