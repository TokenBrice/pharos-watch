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
| 3. Terrain and water drawing | Replace flat diamonds with terrain-specific land and water rendering. | Not started | TBD | TBD |
| 4. Lighthouse headland and landmark | Make lighthouse the compositional anchor with hill, cliff, beacon, and correct hit target. | Not started | TBD | TBD |
| 5. Atmosphere and ambient life | Add restrained birds, fog, lamps, waves, and decorative/encoded atmosphere with parity where needed. | Not started | TBD | TBD |
| 6. Entity and village detail | Integrate ships, docks, cemetery, village props, wakes, and selection cues with richer terrain. | Not started | TBD | TBD |
| 7. Asset pass, only if needed | Improve or replace sprites without bloating first render or breaking manifest contracts. | Not started | TBD | TBD |
| 8. Route shell polish | Tune HUD/detail chrome for richer scene without redesigning the route shell. | Not started | TBD | TBD |
| 9. Tests, snapshots, and docs | Lock down shipped behavior with tests, visual snapshots, docs, and full validation. | Not started | TBD | TBD |

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
- Water ratio is within the new accepted `76%` to `84%` range.
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

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

### Phase 4 Completion Notes

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

### Phase 5 Completion Notes

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

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

- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Validation run: TBD
- Residual risks: TBD
- Next handoff: TBD

## Standing Handoff Constraints

- Do not modify app code from this handover-manager role unless explicitly asked.
- Do not revert or overwrite other agents' changes.
- Keep future updates scoped to this handover document unless the requester explicitly asks for additional process docs.
- When updating this file after a phase, preserve the original source-plan intent and record deviations explicitly.
