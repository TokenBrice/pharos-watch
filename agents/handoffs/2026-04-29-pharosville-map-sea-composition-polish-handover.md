# PharosVille Map, Sea, And Island Polish Handover

Date: 2026-04-29
Owner role: handover-manager
Status: initialized
Source plan: `agents/plans/2026-04-29-pharosville-map-sea-composition-polish-plan.md`

## Scope

Track implementation progress for the `/pharosville/` map, sea, and island
composition polish pass. This handover records phase status, validation,
commits, risks, and post-phase next steps for future agents.

Requested implementation outcomes:

- Replace sea sign posts with printed paper-map labels on water.
- Remove random-looking translucent sea overlay circles.
- Recenter the initial desktop composition around authored island/sea-interest
  bounds.
- Shrink the visible island footprint by about 20% in linear extent.
- Redistribute data buildings so sprites do not overlap and spacing is readable.
- Make named sea zones visually distinct by color and mark language.
- Integrate procedural ground with the lighthouse hill/base.
- Preserve desktop-only gate, reduced-motion determinism, hit testing, detail
  panel/accessibility parity, asset validation, and palette guardrails.

Non-goals: no Worker/API, D1, data-source, scoring, methodology, mobile-canvas,
gameplay, global navigation, or broad asset-regeneration changes unless a later
phase explicitly records an approved scope change.

## Coordination Rules

- This handover-manager role edits only this file.
- Do not revert or overwrite other agents' route, tests, docs, assets, or commit
  work.
- Record externally owned files as observed; do not reconcile them from this
  handover role.
- Append factual updates after each phase: scope, files changed, validation,
  residual risks, commit status, and recommended next step.

## Phase Tracker

| Phase | Goal | Status | Owner | Files changed | Notes |
| --- | --- | --- | --- | --- | --- |
| 0. Baseline and safety | Inspect dirty files, capture baseline stats/screenshot, preserve external edits. | Not started | TBD | TBD | Record water ratio, land bounds/centroid, terrain counts, building distances. |
| 1. Printed sea labels | Replace sea sign posts with cartographic water labels and aligned hit/follow targets. | Complete | Phase 1 implementer/reviewer | Shared area-label model; canvas/hit-testing/follow behavior; visual-cue tests/copy; plan update | Commit `1b50ecf88`; printed labels draw after terrain, old sea posts/boards removed, unanchored atmosphere bands removed, label hitbox scale/overlap review fixes incorporated. Full Playwright visual review still pending; final legibility should be reviewed after layout/camera phases settle. |
| 2. Remove sea circles | Remove unanchored atmosphere ovals while preserving semantic/object-attached effects. | Complete | Phase 1 implementer/reviewer | Canvas atmosphere bands | Completed in commit `1b50ecf88` with old sea-label work; reduced-motion/full visual review remains covered by pending Playwright lane. |
| 3. Recenter composition | Add composition-aware default/reset camera framing around authored interest bounds. | Complete | Phase 3 camera implementer/reviewer | Camera padding/default/reset/clamp behavior and camera/projection tests | Commit `24246b15e`; default/reset/clamp padding biases the smaller island left/up at desktop sizes while keeping reset and follow clamp-stable. Reviewer found no Critical/Major/Minor findings. |
| 4. Shrink island | Reduce visible landmass by about 20% linear extent and retune anchors/routes. | Complete | Phase 2 layout implementer/reviewer | World layout, docks/regions/cemetery/cove/patrol routes, tests | Commit `de8455616`; final bounds `x=21..48`, `y=17..43` (`28 x 27`), water ratio target `85..88%`, ship water anchors retuned and covered by exported `SHIP_WATER_ANCHORS` invariant. |
| 5. Building spacing | Redistribute four data buildings and add spacing/non-overlap invariants. | Complete | Phase 2 layout implementer/reviewer | Data-building placement and tests | Commit `de8455616`; building tiles are `{28,30}`, `{34,24}`, `{40,31}`, `{33,36}` with minimum pair distance `>= 7.75`; reviewer found no remaining Critical/Major/Minor issues after fixes. |
| 6. Sea-zone readability | Strengthen semantic water palette/textures and zone mark language. | Complete | Phase 4 texture implementer/reviewer | `world-canvas`/palette texture and style work | Commit `8ab1d571d`; stronger water terrain palettes, style-driven texture colors, and open-water strokes. Manual browser screenshot accepted; no dedicated automated pixel assertion for circular overlay absence yet. |
| 7. Ground/lighthouse integration | Tune land, road, cliff, and headland rendering to read as one terrain system. | Complete | Phase 4 texture implementer/reviewer | Ground grain, grass, road, and lighthouse/headland color integration | Commit `8ab1d571d`; base island ground grain/grass/road colors integrated with lighthouse/headland colors. Manual browser screenshot accepted; no dedicated automated ground-noise density assertion yet. |
| 8. Tests, docs, review | Update focused tests/docs/snapshots and run route validation. | Complete | Final implementer/reviewers | Desktop visual snapshot and handover closeout | Desktop snapshot reviewed/updated after intentional composition/terrain changes; PharosVille route tests, Playwright lane, lint, typecheck, build, asset guard, and palette guard passed. |

## Validation Tracker

Record commands exactly as run, with pass/fail/skip and the reason for skips.

| Check | Status | Last run by | Notes |
| --- | --- | --- | --- |
| `npm test -- src/app/pharosville` | Passed | Final implementer | Passed after phase commits: 19 files, 120 tests. |
| `npm test -- src/app/pharosville/systems/world-layout.test.ts` | Passed | Phase 2 layout implementer/reviewer | Included in combined Phase 2 focused run: 44 tests passed across world-layout, pharosville-world, chain-docks, and motion suites. |
| `npm test -- src/app/pharosville/systems/pharosville-world.test.ts` | Passed | Phase 2 layout implementer/reviewer | Included in combined Phase 2 focused run: 44 tests passed. |
| `npm test -- src/app/pharosville/systems/chain-docks.test.ts` | Passed | Phase 2 layout implementer/reviewer | Included in combined Phase 2 focused run: 44 tests passed. |
| `npm test -- src/app/pharosville/systems/motion.test.ts` | Passed | Phase 2 layout implementer/reviewer | Included in combined Phase 2 focused run: 44 tests passed; ship water anchors were moved off land and covered by invariant. |
| `npm test -- src/app/pharosville/renderer/hit-testing.test.ts` | Passed | Phase 1 and Phase 4 implementer/reviewers | Phase 1 focused run passed; Phase 4 parent run with palette tests also passed, 23 tests total. |
| `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts` | Passed | Phase 1 implementer/reviewer | Included in combined Phase 1 focused run: 2 files, 18 tests passed; cue copy now describes printed labels instead of signs/posts. |
| `npm test -- src/app/pharosville/systems/camera.test.ts` | Passed | Phase 3 camera implementer/reviewer | Included in combined Phase 3 focused run with projection tests: 11 tests passed; covers 1440x1000 and 1280x760 authored island mass, bounded zoom clamp stability, and follow-with-map clamp stability. |
| `npm test -- src/app/pharosville/systems/projection.test.ts` | Passed | Phase 3 camera implementer/reviewer | Included in combined Phase 3 focused run with camera tests: 11 tests passed. |
| `npm test -- src/app/pharosville/systems/palette.test.ts` | Passed | Phase 4 texture implementer/reviewer | Included in parent Phase 4 run with hit-testing tests: 23 tests passed. |
| `npm run check:pharosville-assets` | Passed | Final implementer | Passed after phase commits: 28 assets validated. |
| `npm run check:harbor-palette` | Passed | Phase 4 texture implementer/reviewer | Passed after water/ground palette changes. |
| `npm run lint` | Passed | Final implementer | Full lint passed after phase commits; focused eslint also passed during phases. |
| `git diff --cached --check` | Passed | Phase 2 layout implementer/reviewer | Passed before commit `de8455616`. |
| `git diff --check -- src/app/pharosville/systems/camera.ts src/app/pharosville/systems/camera.test.ts` | Passed | Phase 3 camera implementer/reviewer | Passed before/with Phase 3 commit `24246b15e`. |
| `git diff --check` for Phase 4 files | Passed | Phase 4 texture implementer/reviewer | Passed for `world-canvas`/palette phase files. |
| `npm run typecheck` | Passed | Final implementer | `tsc --noEmit -p tsconfig.typecheck.json` passed after phase commits. |
| `npm run build` | Passed | Final implementer | Static Next build passed after phase commits. |
| `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"` | Passed | Final implementer | Passed after intentional desktop snapshot update: 11 tests. |
| Snapshot update command | Passed | Final implementer | `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell" --update-snapshots`; actual screenshot reviewed before update. |
| `npm run test:merge-gate` | Not run | TBD | Required before push of deploy-impacting work. |

## Commit Tracker

| Commit/branch | Phase(s) covered | Author/owner | Status | Notes |
| --- | --- | --- | --- | --- |
| `1b50ecf88` | Phase 1 | Phase 1 implementer/reviewer | Recorded | `Polish PharosVille sea labels`; includes shared label placement, printed water labels, hit/follow alignment, sign/post removal, atmosphere band removal, cue/test updates, and xhigh review feedback. |
| `de8455616` | Phase 2 layout rebalance; tracker phases 3-5 partial/complete | Phase 2 layout implementer/reviewer | Recorded | `Rebalance PharosVille island layout`; island shrink/recenter, building distribution, cemetery/cove/dock/region anchor retune, patrol-route retune, and `SHIP_WATER_ANCHORS` invariant. |
| `24246b15e` | Phase 3 | Phase 3 camera implementer/reviewer | Recorded | `Recenter PharosVille camera framing`; default/reset/clamp camera padding biases smaller island left/up at desktop sizes while preserving reset/follow clamp stability. |
| `8ab1d571d` | Phase 4 texture pass; tracker phases 6-7 | Phase 4 texture implementer/reviewer | Recorded | `Differentiate PharosVille sea and ground textures`; stronger water palettes/textures plus base island ground/lighthouse color integration. |

## Open Risks

- Other agents may have dirty route/test/docs changes. Implementation owners
  must inspect and preserve external edits before touching files.
- Camera recentering done before final land/label geometry may need rework.
- Shrinking the island can strand docks, buildings, cemetery, routes, or area
  anchors unless constants and tests move in the same patch.
- Label draw order can bury sea labels under ships/docks, while edge labels can
  clip without explicit inward offsets.
- Removing all glows can flatten the scene; preserve small object-attached or
  semantic effects where they still have detail/a11y parity.
- Tile-distance checks can pass while rendered sprites still overlap; verify
  rendered hitboxes or Playwright debug targets.
- Stronger water colors/textures may require intentional snapshot/classifier
  updates in final Playwright review.
- Full Playwright visual lane passed after the intentional desktop snapshot
  update.
- There is still no dedicated automated pixel assertion for absence of circular
  water overlays or for ground-noise density; Phase 4 manual browser screenshot
  review accepted the current output.
- Concurrent motion/debug/doc work exists in the worktree and was not included
  in commit `de8455616`.
- Concurrent uncommitted renderer helper work may still exist outside this
  handover scope; it was left untouched.

## Next Steps After Each Major Phase

### Phase 0

- Update baseline stats and screenshot references.
- Confirm owned implementation files and externally owned dirty files.
- Recommended next phase: TBD.

### Phase 1

- Record final label placement source, hitbox behavior, and count treatment.
- Click-test at least `Alert Channel`, `Warning Shoals`, `Danger Strait`, and
  `North Froze Pole` when validation is authorized.
- Recommended next phase: TBD.

### Phase 2

- Confirm no detached translucent ovals remain in normal or reduced motion.
- Record which semantic/object-attached effects were preserved.
- Status note: unanchored atmosphere bands were removed in `1b50ecf88`.
- Recommended next phase: verify normal and reduced-motion visual output in the
  pending Playwright review lane.

### Phase 3

- Record final default/reset camera helper and interest bounds.
- Attach or reference before/after desktop screenshots.
- Status note: camera recentering committed in `24246b15e`; tests cover
  default authored island mass at `1440 x 1000` and `1280 x 760`, bounded zoom
  clamp stability, and follow-with-map clamp stability.
- Recommended next phase: proceed to sea-zone texture/palette readability, then
  perform Playwright visual review after remaining visual phases settle.

### Phase 4

- Record final land bounds, land centroid, water ratio, terrain counts, and
  changed anchors/routes.
- Confirm ship samples remain water-only and docks remain shore/water-adjacent.
- Status note: layout rebalance committed in `de8455616`; bounds are `28 x 27`
  at `x=21..48`, `y=17..43`, with target water ratio `85..88%`.
- Recommended next phase: run Playwright visual review/update after remaining
  visual and camera work settles.

### Phase 5

- Record final building tiles and minimum pairwise spacing.
- Confirm click targets and detail panel behavior still match rendered sprites.
- Status note: building distribution committed in `de8455616`; tiles are
  `{28,30}`, `{34,24}`, `{40,31}`, `{33,36}`, with pair distance `>= 7.75`.
- Recommended next phase: verify rendered sprite spacing in the Playwright
  visual lane after camera composition is final.

### Phase 6

- Record final water style/texture changes and any visual-test threshold updates.
- Confirm each named sea zone is recognizable without opening details.
- Status note: sea-zone texture/palette pass committed in `8ab1d571d`; manual
  browser screenshot accepted by reviewer.
- Recommended next phase: final Playwright visual lane and snapshot
  review/update.

### Phase 7

- Record final lighthouse/ground integration choices and whether any asset or
  manifest geometry changed.
- Confirm lighthouse selection remains aligned with visible sprite/base.
- Status note: ground grain/grass/road colors were integrated with
  lighthouse/headland colors in `8ab1d571d`; no asset/manifest change was
  reported.
- Recommended next phase: final Playwright visual lane and snapshot
  review/update.

### Phase 8

- Record all validation commands, screenshot/snapshot decisions, docs updated,
  remaining risks, and final ship/no-ship decision.
- Status note: final route validation and Playwright visual regression passed;
  desktop shell snapshot was reviewed and intentionally updated after the
  composition/terrain changes.
- Recommended next phase: run/record merge-gate before push and coordinate any
  remaining concurrent renderer-helper work separately.

## Phase Completion Notes

Append future updates here. Keep entries concise and factual.

### Phase 2 Layout Rebalance Completion

- Phase completed: Phase 2 execution slice covering island shrink/recenter and
  building distribution; maps to tracker phases 3-5.
- Completed by: Phase 2 layout implementer/reviewer
- Date: 2026-04-29
- Files changed: Route layout/building/dock/region/motion code and focused
  tests, per commit `de8455616`; concurrent motion/debug/doc work remained
  outside this commit.
- Scope completed: Island shrank to bounds `x=21..48`, `y=17..43` (`28 x 27`)
  with water ratio target `85..88%`.
- Scope completed: Building tiles redistributed to `{28,30}`, `{34,24}`,
  `{40,31}`, `{33,36}` with minimum pair distance `>= 7.75`.
- Scope completed: Cemetery, cove, dock, region anchors, patrol routes, and
  ship water anchors were retuned; `SHIP_WATER_ANCHORS` is exported and covered
  by an invariant.
- Reviewer status: Staged diff was rechecked after fixes; no remaining
  Critical/Major/Minor issues were found.
- Validation run: `npm test -- src/app/pharosville/systems/world-layout.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/systems/chain-docks.test.ts src/app/pharosville/systems/motion.test.ts` passed, 44 tests.
- Validation run: Focused eslint for Phase 2 files passed.
- Validation run: `git diff --cached --check` passed before commit.
- Visual screenshots/snapshots: Full Playwright visual lane still pending;
  review/update after visual and camera phases settle.
- Commit/PR: `de8455616` (`Rebalance PharosVille island layout`).
- Residual risks: Final label/building/island composition needs browser visual
  review after camera and visual phases; concurrent motion/debug/doc work exists
  in the worktree and was not included in this phase commit.
- Recommended next phase: Continue with remaining sea-zone readability,
  camera/visual signoff, and ground/lighthouse integration before snapshot
  approval.

### Phase 3 Camera Recenter Completion

- Phase completed: Phase 3 camera framing.
- Completed by: Phase 3 camera implementer/reviewer
- Date: 2026-04-29
- Files changed: `src/app/pharosville/systems/camera.ts` and focused
  camera/projection tests, per commit `24246b15e`.
- Scope completed: Default/reset/clamp camera padding now biases the smaller
  island left/up in desktop composition while keeping reset clamp-stable.
- Scope completed: Tests cover default authored island mass at `1440 x 1000`
  and `1280 x 760`, bounded zoom clamp stability, and follow-with-map clamp
  stability.
- Reviewer status: Rechecked after feedback; no Critical/Major/Minor findings.
- Validation run: `npm test -- src/app/pharosville/systems/camera.test.ts src/app/pharosville/systems/projection.test.ts` passed, 11 tests.
- Validation run: Focused eslint for camera files passed.
- Validation run: `git diff --check -- src/app/pharosville/systems/camera.ts src/app/pharosville/systems/camera.test.ts` passed.
- Visual screenshots/snapshots: Full Playwright visual lane still pending after
  texture/palette and ground/lighthouse visual phases.
- Commit/PR: `24246b15e` (`Recenter PharosVille camera framing`).
- Residual risks: Browser-level composition and snapshot approval still need
  Playwright review after remaining visual texture/palette work settles.
- Recommended next phase: Implement/review sea-zone texture and palette
  readability.

### Phase 4 Sea And Ground Texture Completion

- Phase completed: Phase 4 texture pass covering tracker phases 6-7.
- Completed by: Phase 4 texture implementer/reviewer
- Date: 2026-04-29
- Files changed: `world-canvas`/palette texture and style files, per commit
  `8ab1d571d`.
- Scope completed: Stronger water terrain palettes, style-driven water texture
  colors, and open-water texture strokes.
- Scope completed: Base island ground grain, grass, and road color integration
  with lighthouse/headland colors.
- Reviewer status: No Critical/Major/Minor issues; manual browser screenshot
  accepted.
- Validation run: `npm test -- src/app/pharosville/systems/palette.test.ts src/app/pharosville/renderer/hit-testing.test.ts` passed, 23 tests.
- Validation run: Focused eslint for `world-canvas`/palette files passed.
- Validation run: `npm run check:harbor-palette` passed.
- Validation run: `git diff --check` for phase files passed.
- Visual screenshots/snapshots: Manual browser screenshot accepted; final
  Playwright visual lane and snapshot review/update remain pending.
- Commit/PR: `8ab1d571d` (`Differentiate PharosVille sea and ground textures`).
- Residual risks: No dedicated automated pixel assertion yet for absence of
  circular water overlays or for ground-noise density.
- Recommended next phase: Final validation and intentional Playwright snapshot
  review/update.

### Phase 8 Final Validation And Snapshot Completion

- Phase completed: Phase 8 final validation and snapshot review.
- Completed by: Final implementer
- Date: 2026-04-29
- Files changed: Desktop visual snapshot and this handover document.
- Scope completed: Reviewed the new desktop screenshot after intentional map
  composition, sea-zone, and ground-texture changes; updated only
  `pharosville-desktop-shell-linux.png`.
- Scope completed: Confirmed final browser lane after snapshot update.
- Deviations from source plan: No additional app docs were changed in this
  closeout because existing route docs already reflect printed labels, `56 x
  56` map, water terrain bands, and motion/debug contracts.
- Validation run: `npm test -- src/app/pharosville` passed, 19 files and 120
  tests.
- Validation run: `npm run check:pharosville-assets` passed, 28 assets.
- Validation run: `npm run check:harbor-palette` passed.
- Validation run: `npm run typecheck` passed.
- Validation run: `npm run lint` passed.
- Validation run: `npm run build` passed.
- Validation run: `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville renders desktop canvas shell" --update-snapshots` passed and updated the desktop shell snapshot.
- Validation run: `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"` passed, 11 tests.
- Visual screenshots/snapshots: Desktop shell snapshot intentionally updated
  after manual review. The actual output shows a smaller, better centered island
  with printed sea-zone names, stronger water-zone differentiation, and no
  detached water overlay circles.
- Commit/PR: Final closeout commit will include this handover update and the
  reviewed desktop snapshot.
- Residual risks: No dedicated automated pixel assertion yet for absence of
  circular water overlays or for ground-noise density.
- Recommended next phase: Run/record merge-gate before push; review any
  concurrent renderer-helper changes in their own scope before merging.

### Template

- Phase completed: TBD
- Completed by: TBD
- Date: TBD
- Files changed: TBD
- Scope completed: TBD
- Deviations from source plan: TBD
- Validation run: TBD
- Visual screenshots/snapshots: TBD
- Commit/PR: TBD
- Residual risks: TBD
- Recommended next phase: TBD
