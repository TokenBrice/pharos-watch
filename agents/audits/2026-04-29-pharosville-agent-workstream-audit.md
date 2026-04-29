# PharosVille Agent Workstream Audit

Date: 2026-04-29

Scope: `/pharosville/` code, docs, assets, tests, validation scripts, and agent-facing resources.

## Assumptions

- This is an overview and opportunity audit, not an implementation pass.
- `/docs/` and `README.md` are the verified documentation corpus; `/agents/` is supporting planning, research, handoff, and audit material.
- Existing uncommitted work in `src/app/pharosville/renderer/world-canvas.ts`, `src/app/pharosville/systems/data-buildings.ts`, `src/app/pharosville/systems/world-layout.ts`, `agents/plans/2026-04-29-pharosville-civic-core-implementation-plan.md`, and `agents/research/2026-04-29-pharosville-layout-cohesion-research.md` was treated as user work and not modified.

## Success Criteria Used

- Identify concrete opportunities that would make future PharosVille agent work faster and less error-prone.
- Separate live route contracts from stale planning material.
- Prioritize low-risk maintainability, deduplication, performance, docs, tests, and resource improvements.
- Keep recommendations scoped to the PharosVille surface unless a repo-level routing or validation affordance is directly relevant.

## Current Surface

The active PharosVille route is mostly self-contained:

- Route shell and desktop gate: `src/app/pharosville/page.tsx`, `src/app/pharosville/client.tsx`, `src/app/pharosville/desktop-only-fallback.tsx`
- Data hydration: `src/app/pharosville/pharosville-desktop-data.tsx`
- Runtime shell: `src/app/pharosville/pharosville-world.tsx`
- Pure world model: `src/app/pharosville/systems/pharosville-world.ts`, `world-layout.ts`, `chain-docks.ts`, `risk-placement.ts`, `ship-visuals.ts`, `motion.ts`, `data-buildings.ts`, `detail-model.ts`, `visual-cue-registry.ts`
- Canvas runtime: `src/app/pharosville/renderer/world-canvas.ts`, `hit-testing.ts`, `asset-manager.ts`
- DOM parity: `src/app/pharosville/components/*`
- Assets: `public/pharosville/assets/manifest.json` plus PNG sprites
- Visual tests: `tests/visual/pharosville.spec.ts`
- Canonical route doc: `docs/pharosville-page.md`
- Agent support pack: `agents/pharosville/**`, `agents/specs/*pharosville*`, root-level PharosVille plans/research

## What Is Working Well

- The desktop viewport gate in `client.tsx` prevents data queries, canvas runtime, manifest fetches, and sprite decoding on ineligible viewports.
- The main product code separates React shell, pure world-building systems, projection/camera math, asset loading, motion planning, hit testing, and DOM detail surfaces.
- The pure systems are unusually well tested for a canvas-heavy feature: layout, motion, clustering, hit testing, palette, visual cues, camera, projection, and world model all have focused tests.
- `docs/pharosville-page.md` is strong as the route contract and explicitly documents the Canvas exception, DOM parity requirement, desktop-only behavior, and asset validation.
- The asset manifest validator catches missing files, PNG dimensions, orphan PNGs, forbidden public tokens/URLs, placeholder names, provenance/style drift, and referenced renderer asset IDs.

## Priority Opportunities

### P0: Agent Routing And Source-Of-Truth Cleanup

1. Update `agents/pharosville/README.md` into a current status index.

   Problem: it still frames PharosVille as a replacement plan, lists docs only through `14`, omits plans `15` and `16`, omits the root-level PharosVille plans, and does not point agents to the current canonical contract first.

   Recommended shape:

   - Canonical source: `docs/pharosville-page.md`
   - Active code map: route shell, data hydration, world shell, systems, renderer, components, assets, visual tests
   - Current checks by change type:
     - Model/system changes: `npm test -- src/app/pharosville`
     - Assets: `npm run check:pharosville-assets`
     - Color guard: `npm run check:harbor-palette`
     - Browser/visual: `npm run test:visual -- tests/visual/pharosville.spec.ts`
   - Stale-plan warning: older plans are background only unless explicitly referenced by current docs or code.

2. Add PharosVille to `docs/agent-task-router.md`.

   Problem: the task router has no PharosVille row, even though this is a large canvas route with special asset, test, accessibility, and desktop-gate rules.

   Suggested row: `PharosVille canvas route / asset work`, reading `docs/pharosville-page.md`, `docs/data-visualization.md`, `docs/testing.md`, and `agents/pharosville/README.md`; entrypoints should include `src/app/pharosville/**`, `public/pharosville/assets/**`, `scripts/pharosville/**`, and `tests/visual/pharosville.spec.ts`.

3. Add PharosVille ownership to `docs/doc-ownership.json`.

   Problem: doc ownership is generic for frontend routes and does not explicitly connect `src/app/pharosville/**`, `public/pharosville/assets/**`, `scripts/pharosville/**`, and `tests/visual/pharosville.spec.ts` to `docs/pharosville-page.md` and `docs/data-visualization.md`.

   Benefit: agents changing the route would be prompted to update the route contract and visualization contract instead of relying on memory.

4. Mark stale plans as completed, superseded, or historical.

   Conflicts found:

   - `agents/pharosville/12-chain-harbor-docks-plan.md` and `13-ship-liveliness-motion-plan.md` still refer to top-six docks, while live code uses a top-ten harbor model.
   - `agents/pharosville/15-ship-classes-pixellab-plan.md` says ship assets are only three sprites, while the manifest now carries five ship sprites.
   - `agents/pharosville/16-lighthouse-hill-regeneration-plan.md` says the lighthouse manifest entry is `128 x 192`, while the current manifest is `192 x 256`.

   Low-risk remediation: add a status banner at the top of stale plans pointing to `docs/pharosville-page.md` and current code, or move superseded planning docs under `agents/plans/historical/`.

### P1: Maintainability And Deduplication

1. Remove or explicitly quarantine the retired harbor-scene stack.

   Candidate files:

   - `src/app/pharosville/harbor-scene-client.tsx`
   - `src/app/pharosville/harbor-scene.css`
   - `src/app/pharosville/lighthouse-a11y-ledger.tsx`
   - `src/app/pharosville/layers/**`
   - `src/app/pharosville/sprites/**`
   - `src/app/pharosville/systems/scene-data.ts`
   - `src/app/pharosville/systems/animation.ts`
   - `src/app/pharosville/systems/patrol.ts`
   - related fixtures/tests

   Problem: current route imports go through `PharosVilleDesktopData` and `PharosVilleWorld`; the old harbor scene appears referenced only by its own tests and historical docs. It duplicates renderer concepts and increases search noise for agents.

   Recommended path: first decide whether the old stack is intentionally retained as a reference. If not, remove it and its tests in a cleanup PR. If yes, add a clear file-level or README note that it is inactive reference material, not the route runtime.

2. Extract shared selectable-entity helpers.

   Problem: entity lists are manually repeated across toolbar count, hit testing, selection lookup, detail indexing, renderer ordering, and accessibility surfaces. One live symptom is `src/app/pharosville/components/world-toolbar.tsx` counting lighthouse, areas, docks, ships, clusters, and graves but omitting `world.buildings.length`, even though buildings are selectable and rendered.

   Low-risk first step: include buildings in `entityCount`. Follow-up: add a small `systems/selectable-entities.ts` helper for `selectableWorldEntities(world)` and `worldEntityCount(world)`.

3. Consolidate stable deterministic random helpers.

   Problem: `stableHash`, `stableUnit`, and `stableOffset` style helpers are duplicated in `systems/pharosville-world.ts`, `systems/world-layout.ts`, `systems/motion.ts`, and `systems/clustering.ts`.

   Recommendation: extract `src/app/pharosville/systems/stable-random.ts` with tested helpers, then migrate callers incrementally.

4. Reduce query repetition in `pharosville-desktop-data.tsx`.

   Problem: the 11 route queries are repeated for error selection, `hasAnyData`, loading state, world inputs, freshness flags, dependency arrays, and retry callbacks.

   Recommendation: keep hook calls explicit, then assemble a typed descriptor object/list after hooks and derive error/loading/data/freshness/refetch from it. This keeps hook ordering simple while reducing missed updates when a data source is added or removed.

5. Split `renderer/world-canvas.ts` after the current visual language stabilizes.

   Problem: the file is roughly 2,900 lines and carries terrain, sky, lighthouse, docks, signs, buildings, ships, graves, relationship lines, and fallback procedural sprites. There is already a hotspot waiver noting this concentration.

   Recommended slices:

   - `renderer/terrain-canvas.ts`
   - `renderer/sky-canvas.ts`
   - `renderer/cemetery-canvas.ts`
   - `renderer/docks-canvas.ts`
   - `renderer/buildings-canvas.ts`
   - `renderer/ships-canvas.ts`
   - `renderer/canvas-primitives.ts`

   This should be a dedicated cleanup pass, not mixed into visual feature work.

### P1: Runtime And Optimization

1. Avoid restarting the canvas loop for volatile hover and camera inputs.

   Problem: `pharosville-world.tsx` draw effects depend on volatile state like `camera`, `hoveredDetailId`, and `selectedDetailId`; pointer movement can cancel and recreate animation work.

   Recommendation: move volatile draw inputs into refs read by a stable RAF loop. Start with `hoveredDetailId`, because hover should not rebuild the motion plan.

2. Make hit testing single-pass.

   Problem: `hitTest()` filters and sorts every matching target even though it only needs the highest-priority match.

   Recommendation: replace `filter(...).toSorted(...)[0]` with a single-pass best-target scan.

3. Hoist deterministic static world pieces.

   Problem: `buildPharosVilleWorld()` rebuilds deterministic structures such as the map, default cemetery nodes, and visual cue registry on each query refresh.

   Recommendation: hoist default map/default cemetery/default visual cue constants where test injection allows. Preserve the injected `cemeteryEntries` path for tests and fixture control.

4. Harden logo loading.

   Problem: `asset-manager.ts` loads all local logos via one `Promise.all()`, and the world shell treats the batch as all-or-nothing. One missing local logo can reject the batch without a precise per-logo debug path, and many logos can create a decode/request burst.

   Recommendation: use `Promise.allSettled()`, cache failed logo `src`s for the session, record failures in the existing debug state, and consider a small concurrency limit.

### P1: Testing And Validation

1. Add a PharosVille-focused visual test command that cannot silently use stale `out/`.

   Problem: `npm run test:visual -- tests/visual/pharosville.spec.ts` serves the existing static export. It is useful, but agents can accidentally run it against stale `out/`.

   Recommendation: add an agent-facing script such as `test:visual:pharosville` that either builds first or checks artifact freshness before Playwright starts. Wire this into the delta-aware merge gate for `src/app/pharosville/**`, `public/pharosville/**`, `tests/visual/pharosville.spec.ts`, and `scripts/pharosville/**`.

2. Bring the PharosVille color guard into the main validation path.

   Problem: `check:harbor-palette` exists but is not in `VALIDATE_PREBUILD_COMMANDS`. It also scans only five shell files, while many route colors live in renderer/system files.

   Recommendation:

   - Add a clearer alias: `check:pharosville-colors`.
   - Keep `check:harbor-palette` as compatibility alias if desired.
   - Scan all tracked non-test `src/app/pharosville/**/*.{ts,tsx,css}` files, with explicit waivers for accepted palette constants.
   - Add the command to validate prebuild.

3. Strengthen stressed-ship visual assertions.

   Problem: the visual test constructs a stressed/depeg ship scenario but does not assert enough of the storm/depeg detail semantics after selection.

   Recommendation: assert the detail panel or accessibility ledger includes the stressed coin, active depeg/risk state, risk water/storm placement, and route-source facts.

4. Assert runtime asset load health in visual tests.

   Problem: the app exposes `assetLoadErrors`, `assetsLoaded`, and `deferredAssetsLoaded` through debug state, but visual tests mostly wait for critical assets and do not assert zero errors.

   Recommendation: add a helper that expects `assetLoadErrors` to be empty and either waits for `assetsLoaded` on desktop tests or explicitly documents acceptable deferred failures.

5. Make asset reference validation less brittle.

   Problem: `scripts/pharosville/validate-assets.mjs` scans selected source files with double-quote regexes for asset IDs. Single quotes, moved files, or future central constants can bypass the guard.

   Recommendation: either centralize render asset IDs in exported constants and validate those, or scan all non-test PharosVille source files with quote-agnostic asset ID matching.

6. Resolve or document `building.*` ID/category mismatch.

   Problem: the manifest validator accepts `building.*` IDs, but allowed categories and TypeScript manifest types do not include `building`, so building sprites are categorized as landmarks.

   Recommendation: either add `building` as a real category or document/enforce the intentional `building.*` ID plus `landmark` category mapping.

### P2: Documentation Clarifications

1. Split `docs/pharosville-page.md` coverage sections.

   Problem: the current visual regression section implies `tests/visual/pharosville.spec.ts` covers thematic building targets, visual-cue registry entries, and asset manifest validation. Some of that coverage is unit tests or `npm run check:pharosville-assets`, not visual tests.

   Recommendation: split into:

   - Visual coverage
   - Unit coverage
   - Asset validation
   - Suggested focused commands

2. Rename “Data Mapping Target” to “Current Data Mapping” where applicable.

   Problem: much of the section describes current behavior, not future target behavior. The “planned” wording can send agents hunting through old plans unnecessarily.

   Recommendation: rename the current mapping section and keep deferred ideas under a separate “Deferred / DOM-only Concepts” heading.

3. Add a PharosVille subsection to `docs/testing.md`.

   Suggested content:

   - `npm test -- src/app/pharosville`
   - `npm run check:pharosville-assets`
   - `npm run check:harbor-palette` or future `check:pharosville-colors`
   - `npm run test:visual -- tests/visual/pharosville.spec.ts`
   - Note that visual tests should run against a fresh static export.

4. Update generated/navigation docs.

   - `docs/agent-code-map.md` should include `src/app/pharosville/page.tsx` and the main PharosVille runtime paths.
   - `docs/README.md` already lists `docs/pharosville-page.md`; keep it aligned if the doc is split or renamed.

## Suggested Agent Resources To Produce

1. `agents/pharosville/CURRENT.md`

   Purpose: compact, high-signal current state for agents.

   Contents:

   - Active route chain
   - Canonical docs
   - Data-source-to-world mapping summary
   - Files by responsibility
   - Checks by change type
   - Asset manifest rules
   - “Do not use stale harbor-scene stack unless intentionally reactivated”

2. `agents/pharosville/CHANGE_CHECKLIST.md`

   Purpose: preflight checklist before editing and before final response.

   Suggested checklist:

   - Did the change touch route shell, viewport gate, world model, renderer, assets, or visual tests?
   - Did `docs/pharosville-page.md` or `docs/data-visualization.md` need updating?
   - Did asset IDs/categories/manifests change?
   - Did mobile fallback remain canvas/query-free?
   - Did DOM detail/ledger parity remain true for any new canvas signal?
   - Which focused checks were run?

3. `agents/pharosville/ASSET_PIPELINE.md`

   Purpose: prevent future sprite/manifest drift.

   Contents:

   - Manifest schema expectations
   - Asset category decision, including building IDs
   - Version/provenance rules
   - Critical vs deferred load guidance
   - Required validation commands
   - How to handle prototype assets under `agents/pharosville/pixellab-prototypes/`

4. `agents/pharosville/TESTING.md`

   Purpose: route-specific verification guide for agents.

   Contents:

   - Unit test targets
   - Visual test command and stale-`out` warning
   - Asset/color guard commands
   - Expected debug fields and how to inspect them
   - Snapshot update cautions

## Proposed Sequencing

1. Documentation/router cleanup:
   update `agents/pharosville/README.md` or add `CURRENT.md`, add router/doc ownership entries, mark stale plans.

2. Low-risk correctness fixes:
   toolbar count includes buildings, hit testing single-pass, stronger stressed-ship and asset-load visual assertions.

3. Guardrail improvements:
   add `check:pharosville-colors`, broaden scanner, add PharosVille testing docs, create stale-export-safe visual command.

4. Dead-code decision:
   remove or quarantine the old harbor-scene stack.

5. Refactor pass:
   extract stable random helpers, data query descriptors, static world constants, and renderer modules.

## Verification Notes

Subagent verification reported these commands passing against the current worktree/static export:

- `npm test -- src/app/pharosville --run`
- `npm run check:pharosville-assets`
- `npm run check:harbor-palette`
- `npm run test:visual -- tests/visual/pharosville.spec.ts`

This audit file itself is documentation-only and was not accompanied by a full merge gate run.
