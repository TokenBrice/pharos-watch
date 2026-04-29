# PharosVille Civic Core Follow-Up Handoff

Date: 2026-04-29
Status: final
Owner: follow-up/handover subagent

## Purpose

Capture deferred PharosVille work that should not be bundled into the civic-core implementation patch, plus coordination and learning notes from the execution swarm.

This file owns follow-up sequencing for:

- regenerating every dock sprite
- new manifest schema
- frame-based Pixellab animation
- new decorative scenery packs
- filter/sort controls or dense inspection UI

## Coordination Pattern

The execution swarm split into four lanes:

- layout/world-model: central civic-core placement, terrain/plaza/road invariants, world tests
- renderer/tests: draw-order cleanup, decorative hut removal, hit testing, visual coverage
- docs: route-contract and architecture/data-visualization updates for the civic-core composition patch
- follow-up/handover research: this document, with no implementation-file edits

The important scope boundary was that this patch was a civic-core composition pass. It moved the four non-harbor data buildings inland, made the island center read as an authored civic data core, removed misleading decorative canvas huts, and validated click/detail/a11y parity. It did not attempt full sprite-pack regeneration.

## Assumptions

- `/pharosville/` remains desktop-only: no canvas, world queries, manifest fetches, or sprite decode below `1280px` wide or `760px` tall.
- Canvas 2D remains the renderer. No PixiJS/WebGL/CSP relaxation is part of these follow-ups.
- DOM detail panel and accessibility ledger remain the analytical source of truth for every encoded visual cue.
- No Worker endpoint, D1 migration, provider, supply override, or methodology change is implied by visual follow-ups.
- This handoff only edited `/agents/`.

## Baseline Facts

- Current production-style PharosVille manifest is schema v1, static PNG only.
- `src/app/pharosville/systems/asset-manifest.ts` accepts categories `terrain`, `landmark`, `dock`, `ship`, `prop`, and `overlay`; there is no `building` category yet.
- The manifest currently has 28 assets: 14 critical and 14 deferred.
- The four data-building sprites are deferred `landmark` assets on the `landmarks` layer:
  - `building.mint-burn-foundry`
  - `building.exit-route-gatehouse`
  - `building.yield-orchard-moonwell`
  - `building.dependency-loom-chainworks`
- `scripts/pharosville/validate-assets.mjs` caps v0.1 at 34 assets and requires `promptProvenance.styleAnchorVersion` to match the single global `style.assetVersion`.
- `PharosVilleAssetManager` loads critical/first-render assets first and deferred assets as a second group. It has no frame timing, sprite-sheet, per-animation, or per-state asset API.
- Pixellab `animate_object` can generate object animation frames, but PharosVille does not yet have a manifest/runtime contract for those frames.

## Recommended Sequencing

### 1. Treat Civic-Core Composition As Complete

The civic-core patch validated successfully with the existing sprite pack. The central island now uses the accepted data-building coordinates and passed build, unit, asset, lint, and Playwright checks.

Do not backfill this patch with broad asset churn. Future work should start from the deferred backlog below.

### 2. Visual Review And Asset Triage

For any future visual pass, inspect normal-motion and reduced-motion screenshots at actual route scale. Classify remaining sprite problems:

- composition problem: fix with tile placement, draw order, scale, or terrain/plaza treatment
- single-asset problem: regenerate that sprite only if it breaks the scene after relocation
- pack problem: schedule a coordinated regeneration pass
- schema/runtime problem: block on manifest v2 before generating assets

### 3. Regenerate Data Buildings Before Docks If The Core Still Looks Patchy

The four data buildings are now the center of the scene. If they still carry incompatible bases, cutaway interiors, or water slabs after relocation, regenerate them as one small pack before touching every dock.

Keep IDs stable and keep dynamic state in procedural canvas effects unless manifest v2 has shipped.

### 4. Dock Sprite Family Pass

Only after civic-core and building-pack review should the dock pack be revisited. The goal is not "more unique docks"; it is a smaller, more coherent harbor family.

Recommended target:

- 3-4 silhouette families, not one bespoke style per chain
- shared materials: limestone, seaworn dark wood, bronze hardware, muted teal/slate accents
- chain identity through mast flags/logos and DOM detail, not large labels or baked text
- preserve the top-ten chain cap and EVM bay semantics

### 5. Manifest v2 Design

Design schema v2 before any frame-based animation or broad decorative pack. The schema should separate concerns that v1 currently couples:

- cache-busting asset version
- style/provenance version
- static image source
- sprite-sheet/frame source
- animation timing
- reduced-motion freeze frame
- logical asset category and render layer

Do not introduce `category: "building"` casually. Either update the TypeScript type, validator, and all readers together, or continue using v1-compatible `category: "landmark"` until schema v2 is explicit.

### 6. Frame-Based Pixellab Animation Pilot

After manifest v2 exists, pilot animation on one low-risk object before animating multiple buildings or docks.

Best candidate: one data building with clear local motion, such as the foundry press/smoke or gatehouse wheel. Avoid animating ships first because ship movement already depends on sampled route motion and hit targets.

Prefer sprite sheets over separate manifest entries for every frame. A separate entry per frame would consume the v0.1 asset cap immediately and make validation noisy.

### 7. Decorative Scenery Packs

Decorative scenery should come after semantic assets are stable. The rule from the scenery brief still applies: scenery must support the maritime observatory grammar and must not compete with data meaning.

Safe pack candidates:

- road/plaza trims for the civic core
- small neutral lamps, crates, bollards, shrubs, and paving details
- harbor-side noninteractive props that clearly read as background infrastructure

Avoid decorative huts or landmarks that look selectable unless they become world-model entities with detail/a11y/cue parity.

### 8. Dense Inspection UI

Keep filtering, sorting, dense tables, transitive dependency views, full event ledgers, methodology text, and executable-exit interpretations in DOM surfaces until they have a precise analytical mapping.

If this becomes necessary, treat it as an information-architecture task, not a canvas task. Good starting point: a fullscreen inspection mode side panel with tabs for ships, docks, buildings, and risk water, backed by existing detail models.

## Deferred Task Notes

### Regenerating Every Dock Sprite

Scope boundary:

- Do not combine with civic-core layout.
- Do not move docks unless needed for visual collision.
- Preserve chain supply semantics, EVM bay roles, logo mast flags, and top-ten cap.

Risks:

- broad PNG churn invalidates visual snapshots without improving analysis
- inconsistent new prompts can make the coast look more like an asset gallery
- global `assetVersion` currently forces provenance churn unless the whole pack is aligned

Validation:

- `npm run check:pharosville-assets`
- visual screenshot comparison at `1440 x 1000` and ultrawide
- click each dock and verify detail panel chain identity and top-cargo facts
- confirm fallback/narrow viewport does not fetch manifest or sprites

### New Manifest Schema

Scope boundary:

- Schema work should be a standalone patch with tests and docs.
- It should support future animation and per-asset provenance without requiring immediate asset regeneration.

Recommended v2 capabilities:

- static image assets remain first-class
- optional animation block with `frameSource`, `frameCount`, `fps` or `durationMs`, `loop`, and `reducedMotionFrame`
- optional sprite-sheet metadata: `frameWidth`, `frameHeight`, `columns`, `rows`
- separate `cacheVersion` from `styleAnchorVersion`
- explicit schema migration path for v1 assets

Risks:

- breaking the desktop gate by fetching animation assets under fallback
- breaking validator/source-reference checks
- increasing first-render payload by marking too many assets critical

Validation:

- unit tests for manifest parsing/defaults
- validator tests or fixture checks for v1 and v2 manifests
- `npm run check:pharosville-assets`
- visual test assertion that fallback makes no manifest/asset requests

### Frame-Based Pixellab Animation

Scope boundary:

- Do not add frame animation until manifest/runtime support exists.
- Keep reduced-motion deterministic and non-RAF when reduced motion is active.
- Keep hit testing tied to the logical object bounds, not per-frame alpha.

Implementation direction:

- Use Pixellab `animate_object` for a completed object only after confirming frame count and direction needs.
- Use a single-direction object animation for buildings unless rotation/direction becomes a real renderer requirement.
- Prefer 4-8 frames for small loops.
- Store as sprite sheet if possible, with one manifest asset per animated object.

Risks:

- frame assets multiply payload and validator complexity
- animation can imply data changes that are not in DOM details
- per-frame React state would violate existing motion-budget patterns

Validation:

- normal-motion visual test sees changing frame samples
- reduced-motion visual test freezes on the configured frame and schedules no RAF
- asset validation verifies sheet dimensions and frame metadata
- manual review checks no muddy/shimmering pixel artifacts at in-world scale

### New Decorative Scenery Packs

Scope boundary:

- Decorative packs must stay subordinate to data landmarks.
- Any selectable-looking structure must either become a world entity or be removed.
- No decorative lore copy or fantasy-village drift.

Recommended first pack:

- civic-core plaza/road trim and small neutral props, because it reinforces the current implementation goal.

Risks:

- nonsemantic clutter weakens the Pharos observatory grammar
- extra deferred assets push the v0.1 cap
- hit targets become visually ambiguous

Validation:

- screenshot review for visual hierarchy
- `npm run check:pharosville-assets`
- visual tests for target overlap/clickability if props sit near interactive entities

### Filter/Sort Controls Or Dense Inspection UI

Scope boundary:

- DOM-first, not canvas-first.
- No new endpoint unless existing payloads cannot answer the inspection question.
- Do not add filters that imply the canvas is a complete table replacement.

Possible sequence:

1. Inventory existing detail models and accessibility-ledger facts.
2. Add read-only dense lists in fullscreen inspection mode if needed.
3. Add sort/filter controls only for stable, explainable fields such as market cap tier, governance class, chain, risk water, or data-building status.
4. Keep exact source/caveat text close to the filtered facts.

Risks:

- UI complexity can bury the map's primary exploratory role
- canvas selection and DOM list selection can diverge
- dense transitive dependency views can overclaim value-at-risk semantics

Validation:

- keyboard and screen-reader navigation
- detail panel/ledger parity
- visual regression for fullscreen inspection mode
- no mobile canvas expansion; fallback remains the mobile contract

## Final Civic-Core Outcomes

Implementation facts:

- Civic core constants are `{ x: 34, y: 30 }` and radius `6.5`.
- Data-building coordinates landed as:
  - Mint: `{ x: 29, y: 30 }`
  - Dependency: `{ x: 34, y: 28 }`
  - Yield: `{ x: 40, y: 30 }`
  - Exit: `{ x: 31, y: 34 }`
- The documented fallback coordinate set was not needed.
- Hard-coded decorative canvas huts were removed.
- Building hit and visual tests confirm all four building targets are present and clickable.
- The visual test clears selected DOM detail between clustered building selections, which keeps the clickability check honest for closely grouped civic-core targets.

Final validation summary:

- `git diff --check` passed.
- `npm run check:pharosville-assets` passed for 28 assets.
- Focused Vitest passed: 4 files / 36 tests for world layout, world model, hit testing, and visual cue registry.
- `npm run build` passed.
- `npm run test:visual -- pharosville.spec.ts` passed 9/9 with no snapshot updates.
- `npm run lint` passed.
- `npm run test:merge-gate` reported no merged diff and skipped.

Validator results:

- Source validator found no behavior blocker beyond ensuring the concurrent `stable-random.ts` dependency is staged if its import is committed.
- Docs validator asked that the research/plan be marked historical/pre-patch and that this handoff close out answered questions.
- Research/plan status text was patched locally outside this handoff.

## Civic-Core Implementation Learning Log

### Milestone 1 - Swarm Start

Learning:

- The implementation split is healthy when each lane has a hard boundary: layout/world-model owns coordinates and terrain invariants; renderer/tests owns draw order and clickability; docs owns public contract; handoff owns deferred work and knowledge capture.
- The first patch must solve the user-visible empty-center problem without absorbing every known art-direction issue.
- "Patchwork" is a valid follow-up concern, but it needs post-relocation screenshot evidence before it becomes an asset-regeneration mandate.

Coordination note:

- Handoff work should not prescribe implementation-file changes while active agents are editing those files. It should record sequencing, risks, and validation gates that later agents can use after the civic-core patch stabilizes.

### Milestone 2 - Layout/World-Model Complete

Files changed by the layout/world-model lane:

- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/data-buildings.ts`
- `src/app/pharosville/systems/world-layout.test.ts`
- `src/app/pharosville/systems/pharosville-world.test.ts`

Validation reported:

- Focused world/layout tests passed: 22 tests across the two world/layout test files.

Learning:

- The planned central civic-core coordinates were accepted by the layout/world-model tests without using the documented fallback coordinate set.
- This is a map/model acceptance only. It does not yet prove the current 192 x 160 building sprites are visually clean or independently clickable after rendering.
- Renderer hit-target overlap validation was still the next gate at this point; it was later resolved by hit and Playwright coverage.

Coordination note:

- Follow-up asset decisions should wait for renderer/test evidence. A passing world-model lane lowers the probability that sprite regeneration is needed for layout reasons, but it does not answer sprite-footprint overlap, visual density, or hitbox questions.

### Milestone 3 - Renderer/Test Worker Complete

Files changed by the renderer/test lane:

- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.test.ts`
- `tests/visual/pharosville.spec.ts`

Validation reported:

- Focused hit-testing tests passed.
- Typecheck passed in that worker.
- Playwright visual suite had not run yet at this milestone; it later passed 9/9.

Learning:

- Civic-core visual acceptance depends on deferred building assets being loaded before screenshot and click-target review. Tests that inspect the civic core too early can validate the map while missing the actual sprite footprint problem.
- Target-overlap checks are now as important as map-coordinate correctness. The coordinate set can be valid in `world-layout.ts` and still fail if rendered 192 x 160 assets occlude each other, docks, graves, or named water-area targets.
- Follow-up asset regeneration should remain evidence-driven: if deferred-asset visual/overlap checks pass, broad sprite-pack regeneration is lower priority; if they fail, the failure mode should distinguish scale/placement from asset-art incompatibility.

Coordination note:

- Do not treat focused hit-testing plus typecheck as final acceptance for the visual patch. The integrated Playwright run still needs to prove nonblank canvas, deferred asset readiness, clickability, reduced-motion stability, and no fallback asset/network regressions together.

### Milestone 4 - Integration Review Starting

Current local workspace includes the civic-core implementation patch set:

- world layout and data-building moves
- renderer decorative-building removal
- hit-testing and visual building clickability guards
- docs updates
- research and implementation plan notes
- this follow-up handoff

Validation state:

- Integration review and validation pass is starting now.
- This handoff is not the acceptance record for the current patch. It should stay focused on deferred work and record only what the integrated validation teaches about follow-up sequencing.

Learning:

- The swarm's patch set now spans implementation, tests, docs, and agent notes, so follow-up recommendations should avoid reopening current-patch scope unless integrated validation exposes a concrete blocker.
- Deferred work remains separate: dock regeneration, manifest v2, frame animation, decorative packs, and dense inspection UI should not be pulled into the civic-core patch just because related files are already dirty.

Coordination note:

- Wait for the integration review outcome before changing priorities. If visual validation passes, the immediate next work should likely be documentation/merge hygiene rather than asset generation. If it fails, classify the failure first as placement/scale, deferred-asset readiness, target-overlap, or art-pack incoherence.

### Milestone 5 - First Integrated Validation Batch Green

Validation reported:

- `git diff --check` passed.
- `npm run check:pharosville-assets` passed for 28 assets.
- Focused Vitest passed: 4 files / 36 tests covering world layout, world model, hit testing, and visual cue registry.

Later resolved:

- Production build later passed.
- Playwright visual validation later passed 9/9 with no snapshot updates.

Learning:

- The v1 manifest remains healthy after the civic-core patch; no immediate manifest-schema change is forced by this work.
- The 28-asset count confirms the current patch did not expand the asset pack or consume the remaining v0.1 asset-cap headroom.
- Focused unit/hit/cue coverage is now green at integration level, but visual acceptance still depends on build output plus Playwright evidence.

Coordination note:

- Keep deferred work deferred. Passing asset validation and focused Vitest reduces pressure to bundle manifest v2, dock regeneration, or decorative pack changes into this patch.

### Milestone 6 - Build And Playwright Green

Validation reported:

- Production build passed.
- Focused interaction rerun passed after clearing the detail panel between clustered building selections in the test.
- Full PharosVille Playwright spec passed: 9/9.
- No visual snapshot updates were needed.

Later resolved:

- Read-only validators later reported no behavior blocker.
- Lint later passed.

Learning:

- The civic-core visual change passed integrated browser validation without needing building-coordinate fallback, building-scale reduction, or snapshot churn.
- Clustered civic-core building targets are close enough that tests should intentionally reset/clear selection state between building clicks. This is a test-harness interaction-state issue, not evidence that the map needs a denser inspection UI.
- Passing the full PharosVille Playwright spec without snapshots is strong evidence that deferred building assets, target-overlap checks, reduced-motion behavior, fallback no-runtime guards, and existing visual baselines remain compatible with the civic-core composition patch.

Coordination note:

- Follow-up work should continue to start from the deferred backlog, not from emergency remediation of this patch. Validator/lint results can still change that, but current build and visual evidence does not justify pulling dock regeneration, manifest v2, frame animation, decorative packs, or dense inspection UI into the civic-core commit.

### Milestone 7 - Final Validation And Review Complete

Validation reported:

- `git diff --check`, asset validation, focused Vitest, production build, PharosVille Playwright, and lint all passed.
- `npm run test:merge-gate` skipped because there was no merged diff.
- Source validator found no behavior blocker.
- Docs validator follow-ups were handled by marking research/plan status text historical/pre-patch locally and closing out this handoff's open questions.

Learning:

- The current civic-core patch does not create an immediate follow-up blocker. Remaining work is product/design backlog, not repair work required to make the patch acceptable.
- The main staging caveat is outside this handoff: if the committed implementation imports the concurrent `stable-random.ts` dependency, that dependency must be staged with the implementation.

## Answered Implementation Outcomes

- Building clickability/overlap: answered. All four building targets are present and clickable in hit/visual coverage at the accepted coordinates.
- Sprite incoherence after relocation: answered for this patch. No snapshot updates, coordinate fallback, or building-scale reduction were needed, so broad sprite regeneration remains deferred rather than required.
- Decorative huts: answered. The hard-coded decorative canvas huts were removed rather than converted to selectable/background scenery.
- Deferred-asset readiness: answered. Asset validation passed for 28 assets and full PharosVille Playwright passed with deferred building assets participating in building clickability checks.
- Civic-core docs wording: answered. Docs were updated in the implementation patch; validator asked only for research/plan historical/pre-patch status and this handoff close-out.
- Manifest v2 priority: answered. No validation result forced manifest v2; it remains a future enabler for animation/provenance improvements.

## Final Deferred Scope

Keep follow-up work scoped to:

- dock sprite regeneration as a separate harbor-family pass
- manifest v2 as a standalone schema/runtime/validator change
- frame-based Pixellab animation after manifest/runtime support exists
- decorative scenery packs only after semantic assets remain stable
- dense inspection/filter UI as DOM-first information architecture, not canvas-first expansion
