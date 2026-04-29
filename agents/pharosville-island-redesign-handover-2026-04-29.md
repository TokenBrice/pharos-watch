# PharosVille Island Redesign Handover

Date: 2026-04-29
Owner role: handover-manager
Source plan: `agents/pharosville-island-redesign-plan-2026-04-29.md`

## Project Goal

Reshape `/pharosville/` from a mostly flat, centered harbor board into a living isometric coastal observatory island while preserving its analytical and accessibility contracts.

The target experience is a deterministic desktop-only Canvas scene with:

- A lighthouse on a corner hill or headland, targeted at tile `{ x: 44, y: 18 }` unless deliberately revised with matching tests and docs.
- Authored terrain, depth bands, shore foam, cliffs, grass, roads, rock, beaches, and vegetation.
- Restrained atmosphere and ambient life such as beacon light, fog, lamps, birds, waves, and water motion.
- Existing selection, detail panels, keyboard pan, fullscreen, reduced-motion behavior, visual-cue parity, and data mappings intact.

This redesign is visual/world-layout work only. It must not add API endpoints, data sources, scoring changes, methodology changes, mobile canvas support, or gameplay features.

## Active Implementation Boundary

Patch only the active `/pharosville/` implementation path unless a later approved phase note explicitly expands scope:

- `src/app/pharosville/pharosville-world.tsx`
- `src/app/pharosville/renderer/world-canvas.ts`
- `src/app/pharosville/renderer/hit-testing.ts`
- `src/app/pharosville/systems/pharosville-world.ts`
- `src/app/pharosville/systems/world-layout.ts`
- `src/app/pharosville/systems/world-types.ts`
- `src/app/pharosville/systems/motion.ts`
- `src/app/pharosville/systems/chain-docks.ts`
- `src/app/pharosville/components/*`, only when DOM parity, accessibility, HUD, or detail behavior requires it.

Treat legacy or prototype PharosVille/harbor paths as out of scope unless a separate cleanup is explicitly requested:

- `harbor-scene-*`
- `layers/*`
- `sprites/*`
- `scene-data/*`
- Legacy `reduced-motion-freeze` paths outside the active route contract.
- Legacy `palette.ts` usage not imported by the active Canvas renderer.

Potential supporting files are allowed only when required by the active implementation phase:

- `public/pharosville/assets/manifest.json`
- `public/pharosville/assets/**/*.png`
- `src/app/pharosville/systems/asset-manifest.ts`
- `src/app/pharosville/renderer/asset-manager.ts`
- `src/app/pharosville/systems/visual-cue-registry.ts`
- `src/app/pharosville/systems/detail-model.ts`
- `src/app/pharosville/pharosville.css`
- `tests/visual/pharosville.spec.ts`
- Relevant `src/app/pharosville/**` tests.
- Relevant docs listed in the source plan.

## Phase Checklist

Use this checklist as the canonical handover status tracker. Future reviewers should update `Status`, `Completed by`, and `Notes` after each major phase.

| Phase | Goal | Status | Completed by | Notes |
| --- | --- | --- | --- | --- |
| 1. Palette and renderer structure | Make later visual changes surgical by clarifying active renderer color groups. | Complete | Phase 1 reviewer | Re-check complete; see Phase 1 completion notes. |
| 2. World-layout reshape | Replace central ellipse with authored island, corner hill, harbor cove, and moved lighthouse. | Complete | Phase 2 blocker re-check reviewer | Visual test hardening blockers cleared for `tests/visual/pharosville.spec.ts`; movement files remain external. |
| 3. Terrain and water drawing | Replace flat diamonds with terrain-specific land and water rendering. | Complete | Final redesign reviewer | Implemented in renderer; visual/perf validation still pending. |
| 4. Lighthouse headland and landmark | Make lighthouse the compositional anchor with hill, cliff, beacon, and correct hit target. | Complete | Final redesign reviewer | Headland/platform/beam implemented; PSI-unavailable beam is gated. |
| 5. Atmosphere and ambient life | Add restrained birds, fog, lamps, waves, and decorative/encoded atmosphere with parity where needed. | Complete | Final redesign reviewer | Decorative haze, lamps, and birds implemented; no new encoded semantics added. |
| 6. Entity and village detail | Integrate ships, docks, cemetery, village props, wakes, and selection cues with richer terrain. | Partial | Final redesign reviewer | Village lights and terrain integration are in place; dock hitbox/orientation still needs visual review. |
| 7. Asset pass, only if needed | Improve or replace sprites without bloating first render or breaking manifest contracts. | Not started | TBD | TBD |
| 8. Route shell polish | Tune HUD/detail chrome for richer scene without redesigning the route shell. | Not started | TBD | TBD |
| 9. Tests, snapshots, and docs | Lock down shipped behavior with tests, visual snapshots, docs, and full validation. | Partial | Final redesign reviewer | Tests/docs were updated for new ratios/classifiers; desktop snapshot update still pending explicit visual run. |

## What to Verify After Each Phase

### Phase 1: Palette and Renderer Structure

- Renderer output is equivalent or intentionally minimally improved.
- No world-layout, hit-testing, or data behavior changed.
- Palette names describe purpose, not raw hues.
- Existing color guardrails remain intact.
- Suggested checks: `npm run check:harbor-palette`, focused renderer review.

### Phase 2: World-Layout Reshape

- Map remains deterministic and `64 x 64`.
- Lighthouse tile is `{ x: 44, y: 18 }`, unless deliberately adjusted with matching tests/docs.
- Lighthouse is on elevated land and outside the old central island band.
- Docks remain adjacent to valid water and mooring tiles are water-only.
- Ship routes, cluster anchors, and nearest-water helpers resolve only to water-like tiles.
- Water ratio is within the new accepted `82%` to `88%` range.
- Cemetery remains separated from lighthouse and docks.
- Suggested checks: focused world-layout, pharosville-world, chain-docks, clustering, and motion tests.

### Phase 3: Terrain and Water Drawing

- Water no longer reads as flat pure blue.
- Land no longer reads as plain yellow tile fill.
- Elevated lighthouse headland is visible before lighthouse drawing.
- Canvas backing-store and hot draw path remain bounded.
- Reduced-motion frame remains deterministic.
- Suggested checks: canvas-budget test, reduced-motion-freeze test, visual spec update/review.

### Phase 4: Lighthouse Headland and Landmark

- Lighthouse clearly sits on a corner hill/headland.
- Clicking or selecting the lighthouse still opens the PSI detail.
- Selection and hover states remain readable on the new hill.
- Beacon behavior is reduced-motion safe.
- If beacon visuals encode PSI meaning, visual-cue registry, detail model, and accessibility ledger are updated in the same phase.
- Suggested checks: hit-testing test, reduced-motion test, visual-cue/detail/ledger tests if semantics changed.

### Phase 5: Atmosphere and Ambient Life

- Scene feels alive without obscuring ships, logos, selected targets, or panel-critical canvas areas.
- Birds remain decorative, non-interactive, excluded from hit testing, and between `5` and `12` total.
- Reduced motion uses static birds/fog or omits animation.
- Decorative atmosphere does not imply unsupported analytics.
- Encoded fog, storm, beacon, or risk visuals have DOM/detail/ledger parity.
- Suggested checks: normal-motion visual spec, reduced-motion visual/spec path, component tests if copy changed.

### Phase 6: Entity and Village Detail

- Ships, docks, lighthouse, cemetery, and clusters still select the correct detail.
- Semantic visual encodings still match the visual-cue registry and detail model.
- Decorative detail does not interfere with labels, logos, or selection rings.
- Cemetery remains visually distinct from richer terrain.
- Suggested checks: hit-testing tests, visual-cue registry tests if mappings changed, detail/accessibility component tests if copy changed.

### Phase 7: Asset Pass, Only If Needed

- Asset validator passes.
- No orphan PNGs or missing required first-render assets.
- First render does not wait on decorative assets.
- Asset IDs, anchors, footprints, and hitboxes remain stable unless intentionally changed.
- `style.assetVersion` is bumped if asset files changed.
- Hit targets remain aligned with visible sprites.
- Suggested checks: `npm run check:pharosville-assets`, focused lighthouse/dock/ship interaction checks after anchor or hitbox changes.

### Phase 8: Route Shell Polish

- Desktop eligible viewport mounts canvas as before.
- Narrow or short viewport fallback still appears and does not load data/assets.
- Detail panel still contains existing facts, links, members, and close behavior.
- Toolbar semantics and keyboard reachability are preserved.
- Controls remain readable over richer terrain.
- No banned palette drift.
- Suggested checks: desktop route visual review, fallback visual review if fallback CSS changed, accessibility/component checks if markup changed.

### Phase 9: Tests, Snapshots, and Documentation

- Tests validate new current behavior, not old ellipse/yellow-blue assumptions.
- Visual snapshots are updated only after reviewing intentional diffs.
- Docs describe shipped behavior, not aspirational plan content.
- API and methodology docs remain unchanged unless actual API/scoring/data-source behavior changed.
- Suggested checks: `npm run check:pharosville-assets`, `npm run check:harbor-palette`, `npm test -- src/app/pharosville`, `npm run test:visual -- tests/visual/pharosville.spec.ts`, `npm run lint`, `npm run build`.
- If docs changed, also run `npm run check:doc-source-paths` and `npm run check:verified-doc-links`.
- Before push, run `npm run test:merge-gate`.

## Open Handoff Notes

Append future phase completion notes here. Keep entries factual and include scope, validation, residual risks, and next recommended phase.

### Final Blocker Re-check Handoff Note

- Completed by: Final reviewer blocker re-check
- Date: 2026-04-29
- Status: PharosVille island redesign blocker re-check is satisfied for the committed/working scope reviewed.
- Scope reviewed: Northeast lighthouse headland implemented at `{ x: 44, y: 18 }`.
- Scope reviewed: Richer terrain and water rendering implemented.
- Scope reviewed: Decorative birds, haze, and lamps implemented.
- Scope reviewed: Water-ratio tests updated.
- Scope reviewed: Handover notes updated.
- Scope reviewed: Prior stale `86.3%` and `0.83` assertions replaced with `82%` to `88%` range checks.
- Validation run: Playwright screenshot regeneration/review was intentionally not run because this workflow did not authorize test or snapshot execution.
- Residual risks: `pharosville-desktop-shell.png` should be regenerated and visually reviewed in the authorized validation pass before final shipping.
- Next handoff: Authorized validation owner should regenerate/review the PharosVille desktop shell screenshot before treating the redesign as final-shipping ready.

### Phase 1 Completion Notes

- Completed by: Phase 1 reviewer re-check
- Date: 2026-04-29
- Files changed: App/docs changes reviewed externally; this handover update did not modify app code.
- Scope reviewed: Lighthouse moved to northeast headland target `{ x: 44, y: 18 }`.
- Scope reviewed: Terrain metadata added with compatibility-preserving optional terrain field.
- Scope reviewed: Centralized terrain predicates are used by renderer.
- Scope reviewed: Fog, storm, and harbor terrain rendering plus focused layout tests are in place.
- Scope reviewed: Lighthouse beam no longer renders when PSI is unavailable.
- Scope reviewed: `docs/pharosville-page.md` updated for current world-model/rendering behavior.
- Validation run: Static review only. No tests, lint, build, or visual snapshots were run by reviewer.
- Residual risks: Movement files remain externally owned and should be reconciled by that worker before merge.
- Residual risks: Visual/perf risks remain for the richer two-pass terrain renderer until focused tests and visual review run.
- Residual risks: Dock hitbox alignment remains unverified until focused interaction tests or visual review run.
- Residual risks: Reduced-motion visual output remains unverified until focused reduced-motion tests or visual review run.
- Next handoff: Phase 2 owner should reconcile externally owned movement files before merge and run focused layout/motion/visual validation before relying on the reviewed changes.

### Phase 2 Completion Notes

- Completed by: Phase 2 blocker re-check reviewer
- Date: 2026-04-29
- Files changed: `tests/visual/pharosville.spec.ts` reviewed externally; this handover update did not modify app code.
- Scope reviewed: Prior visual-test blockers were addressed.
- Scope reviewed: The second water-band classifier now requires stronger blue/cyan dominance.
- Scope reviewed: Ratio caps were added for land and water coverage against backing pixels.
- Reviewer finding: No remaining blockers in Phase 2 visual test hardening review scope.
- Validation run: Reviewer performed blocker re-check for `tests/visual/pharosville.spec.ts`; no broader tests, lint, build, or movement-file review recorded in this note.
- Residual risks: Movement files remain external and were not reviewed.
- Residual risks: Risk outside Phase 2 visual test hardening scope remains with the owning workers/reviewers.
- Next handoff: Safe to commit from the Phase 2 visual test hardening review scope; do not treat this as approval of externally owned movement files.

### Phase 3 Completion Notes

- Completed by: Final redesign reviewer
- Date: 2026-04-29
- Files changed: `src/app/pharosville/renderer/world-canvas.ts`, `src/app/pharosville/systems/world-layout.ts`, `src/app/pharosville/systems/world-types.ts`, related layout tests.
- Scope completed: Renderer now consumes terrain metadata and draws distinct water bands, shoreline foam, beach, grass, rock, cliff, hill, and road terrain.
- Scope completed: `fog-water`, `storm-water`, and `harbor-water` are visually distinct while canonical movement tiles remain compatible.
- Validation run: Static review only. No tests, lint, build, or visual snapshots were run.
- Residual risks: Hot-path renderer performance needs focused canvas-budget/visual validation.
- Next handoff: Run focused PharosVille visual and canvas-budget checks before snapshot approval.

### Phase 4 Completion Notes

- Completed by: Final redesign reviewer
- Date: 2026-04-29
- Files changed: `src/app/pharosville/renderer/world-canvas.ts`, `src/app/pharosville/systems/world-layout.ts`, `src/app/pharosville/systems/pharosville-world.ts`.
- Scope completed: Lighthouse anchor moved to `{ x: 44, y: 18 }` and renderer adds a headland platform, cliff base, road/stair detail, and reduced-motion-safe beam.
- Scope completed: Active gold beam is gated when PSI is unavailable.
- Validation run: Static review only. No hit-testing or visual interaction run was recorded.
- Residual risks: Dock/lighthouse visual alignment and hit targets need focused interaction or visual review.
- Next handoff: Confirm lighthouse click target and screenshot before final release.

### Phase 5 Completion Notes

- Completed by: Final redesign reviewer
- Date: 2026-04-29
- Files changed: `src/app/pharosville/renderer/world-canvas.ts`.
- Scope completed: Decorative haze bands, warm village lights, and seven ambient birds were added.
- Scope completed: No new encoded semantics were added for birds/lights; reduced motion uses static timing.
- Validation run: Static review only. No reduced-motion visual run was recorded.
- Residual risks: Reduced-motion output and normal-motion atmosphere need visual confirmation.
- Next handoff: Run reduced-motion and normal-motion PharosVille visual checks when validation is authorized.

### Phase 6 Completion Notes

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

### Phase 7 Completion Notes

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

### Phase 8 Completion Notes

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

### Phase 9 Completion Notes

- Completed by: Final redesign reviewer
- Date: 2026-04-29
- Files changed: `tests/visual/pharosville.spec.ts`, `src/app/pharosville/systems/pharosville-world.test.ts`, `docs/pharosville-page.md`, this handover document.
- Scope completed: Old hard-coded `86.3% water` visual assertion replaced with a range-safe ledger assertion.
- Scope completed: World test water-ratio bounds aligned to `0.76` through `0.84`.
- Scope completed: Visual pixel classifiers were broadened and ratio-capped for natural terrain/water bands.
- Validation run: Static review only. No Playwright snapshot update was run.
- Residual risks: `pharosville-desktop-shell.png` snapshot is likely stale and needs authorized visual snapshot regeneration/review.
- Next handoff: Update visual snapshot after an explicit test/snapshot run is approved.

## Next Pass: PharosVille Polish Pass 2

Requested scope: sky and day/night mode, stronger birds, reduced island size with more water, cemetery brought onto the main island, and an epic larger lighthouse on a hill.

Important ownership note: Existing dirty movement files are externally owned. Do not review, revert, or reconcile those files from this polish-pass planning scope unless the owning worker explicitly hands them off.

### Goals

- Add a sky/atmosphere layer that makes PharosVille feel less like an isolated board and more like a coastal observatory scene.
- Introduce a day/night visual mode without changing scoring, API behavior, data sources, or route eligibility.
- Make birds more visually present while keeping them decorative, non-interactive, bounded, and reduced-motion safe.
- Reduce the island footprint to create more surrounding water while preserving ship routing, dock reachability, and readable data entities.
- Bring the cemetery onto the main island so it feels intentionally placed in the settlement rather than detached from the world.
- Enlarge and elevate the lighthouse so it becomes an epic hilltop landmark without breaking PSI hit testing, detail behavior, or visual-cue parity.

### Proposed Phases

| Phase | Goal | Primary scope | Handoff requirement |
| --- | --- | --- | --- |
| P2-1. Current-state audit | Confirm the shipped state after the first redesign and identify active files only. | Handover, plan, active `/pharosville/` route files, externally owned movement caveat. | Record assumptions, owned files, and files explicitly not touched. |
| P2-2. Layout rebalancing | Reduce island footprint, increase water area, and move cemetery onto main island. | `world-layout`, terrain metadata, dock/cemetery/lighthouse anchors, focused layout tests. | Record final water ratio, cemetery bounds, route-water invariants, and changed anchors. |
| P2-3. Epic lighthouse hill | Scale up lighthouse presence and strengthen hill/headland staging. | Renderer lighthouse pass, terrain/hill/cliff rendering, hit testing only if footprint changes. | Confirm PSI selection still works and note whether hitboxes or manifest anchors changed. |
| P2-4. Sky and day/night visual mode | Add sky/backdrop treatment and deterministic day/night rendering states. | Renderer background/atmosphere pass, route-local state if needed, reduced-motion behavior. | Document whether mode is decorative, user-controlled, time-derived, or data-derived. |
| P2-5. Stronger birds and atmosphere | Increase bird presence and atmospheric staging without adding analytical ambiguity. | Renderer life/atmosphere pass, bounded bird definitions, reduced-motion branch. | Record bird count, interaction exclusion, and reduced-motion behavior. |
| P2-6. Visual polish and parity pass | Ensure richer visuals do not bury semantic colors or interactive targets. | Selection rings, labels/logos, detail parity, visual-cue registry only if semantics change. | Record any DOM/detail/ledger updates or state that all additions remain decorative. |
| P2-7. Validation and docs | Lock down behavior and update docs/snapshots after authorized validation. | Focused tests, visual snapshots, docs, handover notes. | Record commands run, screenshots regenerated, residual risks, and shipping caveats. |

### Phase Guidance

#### P2-1. Current-State Audit

- Confirm the first redesign state from the handover and active implementation files before editing app code.
- Do not inspect or modify externally owned dirty movement files unless ownership changes.
- Treat legacy/prototype PharosVille files as out of scope unless a separate cleanup is requested.
- Success output: a brief implementation note listing owned files, untouched external files, and assumptions.

#### P2-2. Layout Rebalancing

- Reduce island area deliberately rather than by random erosion.
- Preserve `64 x 64` map size unless there is a hard rendering reason to change it.
- Keep water dominant and increase water presence beyond the first redesign while maintaining valid harbor/dock routing.
- Bring cemetery onto main island in a quiet, readable lowland or ridge-adjacent zone.
- Keep cemetery separated from the lighthouse hill and dense dock/ship interaction zones.
- Update tests for water ratio, cemetery bounds, water-only routing, dock adjacency, cluster anchors, and lighthouse elevation.

#### P2-3. Epic Lighthouse Hill

- Make the lighthouse larger and more prominent through hill massing, cliff base, beacon staging, and render order before changing hit testing.
- Preserve PSI detail selection and accessibility semantics.
- If the visible footprint changes enough to affect clicks, adjust hit testing or manifest hitboxes in the same phase and document it.
- Keep beacon behavior consistent with the existing rule that the beam does not render when PSI is unavailable.

#### P2-4. Sky and Day/Night Visual Mode

- Decide whether day/night is decorative route state, user-controlled UI state, or time-derived. Do not make it data-derived unless DOM/detail/ledger parity is updated.
- Keep canvas draw colors as runtime literals or renderer constants; do not rely on CSS variables inside draw calls.
- Reduced motion must not depend on continuous animation for the sky or mode transition.
- Avoid global app theming changes; this is route-local visual polish.

#### P2-5. Stronger Birds and Atmosphere

- Birds may be larger, more numerous, or more composed, but must remain bounded and decorative.
- Birds must stay non-interactive and excluded from hit testing.
- Keep bird placement away from logos, selected targets, dense ship clusters, and detail-critical canvas regions.
- Reduced motion should use static bird positions or omit flight loops.
- Any fog, haze, storm, or beacon visual that encodes data must update visual-cue registry, detail model, and accessibility ledger in the same phase.

#### P2-6. Visual Polish and Parity Pass

- Verify semantic colors for ships, selection, risk regions, and PSI remain readable against night/day palettes.
- Keep HUD/detail chrome readable over stronger sky/water/terrain contrast.
- Do not introduce new analytics, gameplay, data sources, or route-shell redesign.
- Preserve desktop-only fallback behavior and avoid loading queries/assets below the route gate.

#### P2-7. Validation and Docs

- Regenerate and visually review `pharosville-desktop-shell.png` only in an authorized validation pass.
- Update docs to describe shipped behavior, not this plan.
- Do not update API or methodology docs unless implementation changes API, scoring, data sources, or analytical meaning.
- Final handoff should explicitly say whether screenshots were regenerated and reviewed.

### Risks

- Layout shrink can break ship routing, dock reachability, cluster anchors, or nearest-water helpers.
- Moving the cemetery onto the main island can crowd interactive regions or weaken cemetery visual separation.
- A larger lighthouse can diverge from its hit target or obscure ships, docks, labels, and selection rings.
- Day/night mode can accidentally imply data state if not clearly decorative or documented with parity.
- Night palette can reduce contrast for semantic risk, PSI, ship, and selection colors.
- Stronger birds can become visual noise or interfere with hit targets if not bounded and layered carefully.
- Richer sky/atmosphere can increase canvas cost if implemented with full-canvas filters, unbounded particles, or per-frame allocations.
- Reduced-motion behavior can regress if sky transitions, bird movement, beacon effects, or haze drift require continuous animation.
- Externally owned dirty movement files can be accidentally overwritten if ownership boundaries are ignored.

### Validation Plan

Run only when the implementing worker has authorization for validation:

- `npm test -- src/app/pharosville/systems/world-layout.test.ts`
- `npm test -- src/app/pharosville/systems/pharosville-world.test.ts`
- `npm test -- src/app/pharosville/systems/chain-docks.test.ts`
- `npm test -- src/app/pharosville/systems/clustering.test.ts`
- `npm test -- src/app/pharosville/systems/motion.test.ts`
- `npm test -- src/app/pharosville/renderer/hit-testing.test.ts`
- `npm test -- src/app/pharosville/systems/reduced-motion-freeze.test.ts`
- `npm test -- src/app/pharosville/systems/canvas-budget.test.ts`
- `npm test -- src/app/pharosville/components`
- `npm run check:pharosville-assets`, if assets or manifest changed.
- `npm run check:harbor-palette`, if renderer palette or route colors changed.
- `npm run test:visual -- tests/visual/pharosville.spec.ts`, when screenshot regeneration/review is authorized.
- `npm run lint`
- `npm run build`
- `npm run check:doc-source-paths`, if docs changed.
- `npm run check:verified-doc-links`, if docs changed.
- `npm run test:merge-gate`, before push.

Minimum focused checks by phase:

- P2-2: world-layout, pharosville-world, chain-docks, clustering, motion.
- P2-3: hit-testing, reduced-motion-freeze, visual-cue/detail/ledger tests if beacon semantics changed.
- P2-4: reduced-motion-freeze, canvas-budget, visual spec when authorized.
- P2-5: reduced-motion-freeze, canvas-budget, visual spec when authorized.
- P2-6: hit-testing, components, visual-cue registry tests if semantics changed.
- P2-7: full validation and screenshot review.

### Post-Phase Handoff Checklist

Each implementing worker should append a note under this section after completing a P2 phase.

- Phase completed: TBD
- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Externally owned files avoided: confirm movement files were not modified, or explain explicit ownership transfer.
- App code modified: yes/no.
- Layout invariants changed: yes/no; if yes, list final water ratio, lighthouse tile, cemetery bounds, dock anchors, and route-water assumptions.
- Visual semantics changed: yes/no; if yes, list registry/detail/ledger/docs updates.
- Day/night behavior: decorative/user-controlled/time-derived/data-derived/TBD.
- Reduced-motion behavior: static/omitted/animated/TBD.
- Asset manifest changed: yes/no; if yes, list `style.assetVersion`, new/removed assets, and validation.
- Tests run: TBD.
- Visual snapshots regenerated/reviewed: yes/no.
- Docs updated: yes/no.
- Residual risks: TBD.
- Recommended next phase: TBD.

### Pass-2 Reviewer Closeout

- Completed by: Pass-2 blocker re-check reviewer
- Date: 2026-04-29
- Status: Pass-2 blocker re-check is satisfied apart from deferred snapshot regeneration.
- Scope reviewed: Lighthouse hit-testing now mirrors the epic renderer scale and asset offset.
- Scope reviewed: Fallback target size is enlarged.
- Scope reviewed: Hit-testing test expectations match the new manifest geometry.
- Scope reviewed: Docs now describe the cemetery as a compact main-island lowland precinct.
- Scope reviewed: Docs identify day/night sky mood as decorative time-derived renderer behavior.
- Files changed during re-check: None.
- Validation run: None. No tests were run during this re-check.
- Remaining handoff item: Regenerate and visually review `pharosville-desktop-shell.png` in an authorized Playwright snapshot pass before final visual signoff.

### Pass-2 Cemetery Relocation Closeout

- Completed by: Pass-2 cemetery relocation re-check reviewer
- Date: 2026-04-29
- Status: No code/docs blockers found for cemetery relocation.
- Scope reviewed: Cemetery moved to southwest main-island pocket `{ x: 17.4, y: 43.4 }`.
- Scope reviewed: Harbor-water mask excludes the cemetery precinct so it stays visible on land.
- Scope reviewed: Tests cover exact center, land/grass terrain, and connected main-island placement.
- Scope accepted: Prior lighthouse hit-target parity, docs, and handover alignment remain accepted.
- Files changed during re-check: None.
- Validation run: Not recorded in this note.
- Remaining handoff item: `pharosville-desktop-shell.png` needs authorized Playwright regeneration and visual review before final visual signoff.

## Standing Handoff Constraints

- Do not modify app code from this handover-manager role unless explicitly asked.
- Do not revert or overwrite other agents' changes.
- Keep future updates scoped to this handover document unless the requester explicitly asks for additional process docs.
- When updating this file after a phase, preserve the original source-plan intent and record deviations explicitly.

### P2 Implementation Review Note

- Completed by: Pass-2 reviewer follow-up
- Date: 2026-04-29
- Files changed in follow-up: `src/app/pharosville/renderer/hit-testing.ts`, `src/app/pharosville/renderer/hit-testing.test.ts`, `docs/pharosville-page.md`, this handover document.
- Scope completed: Lighthouse hit target now mirrors the epic renderer scale (`1.48x`) and `y + 3` asset-center offset.
- Scope completed: PharosVille docs now describe the cemetery as a main-island lowland precinct and day/night mood as decorative time-derived renderer behavior.
- Validation run: Static review only. No tests, lint, build, or visual snapshots were run.
- Residual risk: `pharosville-desktop-shell.png` still needs an authorized Playwright regeneration and visual review because the sky/lighthouse/island composition changed materially.
- Residual risk: External movement files remain dirty and owned by the movement-bug worker.

### P2 Cemetery Visibility Follow-up

- Completed by: Main agent
- Date: 2026-04-29
- Files changed: `src/app/pharosville/systems/world-layout.ts`, `src/app/pharosville/systems/world-layout.test.ts`, `docs/pharosville-page.md`, this handover document.
- Scope completed: Cemetery center moved to the southwest main-island lowland target `{ x: 17.4, y: 43.4 }`, matching the requested circled area.
- Scope completed: Cemetery precinct now overrides local harbor-water masking so graves render on visible land instead of submerged/hidden under the harbor overlay.
- Validation run: None. Needs focused layout/visual validation when authorized.
- Residual risk: Grave scatter density and exact visual placement still need screenshot review.

### P2 Sky Refinement Follow-up

- Completed by: Main agent
- Date: 2026-04-29
- Files changed: `src/app/pharosville/renderer/world-canvas.ts`, `docs/pharosville-page.md`, this handover document.
- Scope completed: Replaced basic day/night palette switch with decorative time-derived dawn/day/dusk/night sky states.
- Scope completed: Added visible sun, crescent moon, denser stars, constellation lines, sky cloud bands, and celestial path treatment in the active canvas renderer.
- Reduced-motion behavior: Static night sky with moon/stars; no continuous sky transition required for reduced-motion information content.
- Validation run: None. Needs visual review and snapshot regeneration when authorized.
- Residual risk: New sky pixels may require visual snapshot update and classifier tuning after Playwright review.
