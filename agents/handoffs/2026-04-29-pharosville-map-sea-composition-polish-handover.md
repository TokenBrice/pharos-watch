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
| 1. Printed sea labels | Replace sea sign posts with cartographic water labels and aligned hit/follow targets. | Not started | TBD | TBD | Keep counts in detail/a11y unless intentionally retained as muted ink suffix. |
| 2. Remove sea circles | Remove unanchored atmosphere ovals while preserving semantic/object-attached effects. | Not started | TBD | TBD | Watch reduced-motion static output for leftover rings. |
| 3. Recenter composition | Add composition-aware default/reset camera framing around authored interest bounds. | Not started | TBD | TBD | Plan recommends doing after land/label bounds stabilize. |
| 4. Shrink island | Reduce visible landmass by about 20% linear extent and retune anchors/routes. | Not started | TBD | TBD | Target bounds roughly `28..31 x 25..29`; water ratio likely `0.84..0.88`. |
| 5. Building spacing | Redistribute four data buildings and add spacing/non-overlap invariants. | Not started | TBD | TBD | Validate tile and isometric/sprite spacing, not just land placement. |
| 6. Sea-zone readability | Strengthen semantic water palette/textures and zone mark language. | Not started | TBD | TBD | Avoid recreating large translucent circles as regional washes. |
| 7. Ground/lighthouse integration | Tune land, road, cliff, and headland rendering to read as one terrain system. | Not started | TBD | TBD | Do not enable terrain PNGs without separate visual audit/regeneration approval. |
| 8. Tests, docs, review | Update focused tests/docs/snapshots and run route validation. | Not started | TBD | TBD | Snapshot updates only after manual review of intentional diffs. |

## Validation Tracker

Record commands exactly as run, with pass/fail/skip and the reason for skips.

| Check | Status | Last run by | Notes |
| --- | --- | --- | --- |
| `npm test -- src/app/pharosville` | Not run | TBD | Route-focused unit suite. |
| `npm test -- src/app/pharosville/systems/world-layout.test.ts` | Not run | TBD | Required for island, terrain, dock, cemetery, water-ratio changes. |
| `npm test -- src/app/pharosville/systems/pharosville-world.test.ts` | Not run | TBD | Required for world entity/anchor changes. |
| `npm test -- src/app/pharosville/systems/chain-docks.test.ts` | Not run | TBD | Required after dock/shore/anchor changes. |
| `npm test -- src/app/pharosville/systems/motion.test.ts` | Not run | TBD | Required after water mask or ship-route changes. |
| `npm test -- src/app/pharosville/renderer/hit-testing.test.ts` | Not run | TBD | Required after labels, building scale, lighthouse, or target geometry changes. |
| `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts` | Not run | TBD | Required after visual-language or semantic cue copy changes. |
| `npm run check:pharosville-assets` | Not run | TBD | Required if manifest/assets/geometry change. |
| `npm run check:harbor-palette` | Not run | TBD | Required after renderer palette or water style changes. |
| `npm run lint` | Not run | TBD | Required before final handoff. |
| `npm run typecheck` | Not run | TBD | Required before final handoff if available for this repo state. |
| `npm run build` | Not run | TBD | Required after route docs/CSS/assets/static output changes. |
| `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"` | Not run | TBD | Required for visual acceptance. |
| Snapshot update command | Not run | TBD | Only after reviewed visual diffs. |
| `npm run test:merge-gate` | Not run | TBD | Required before push of deploy-impacting work. |

## Commit Tracker

| Commit/branch | Phase(s) covered | Author/owner | Status | Notes |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | Not recorded | Add hash, branch, or PR link when available. |

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
- Stronger water colors/textures can break existing visual pixel thresholds and
  require intentional snapshot/classifier updates.
- Lighthouse-ground tuning can overfit the lighthouse and make the rest of the
  island too bright or noisy.

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
- Recommended next phase: TBD.

### Phase 3

- Record final default/reset camera helper and interest bounds.
- Attach or reference before/after desktop screenshots.
- Recommended next phase: TBD.

### Phase 4

- Record final land bounds, land centroid, water ratio, terrain counts, and
  changed anchors/routes.
- Confirm ship samples remain water-only and docks remain shore/water-adjacent.
- Recommended next phase: TBD.

### Phase 5

- Record final building tiles and minimum pairwise spacing.
- Confirm click targets and detail panel behavior still match rendered sprites.
- Recommended next phase: TBD.

### Phase 6

- Record final water style/texture changes and any visual-test threshold updates.
- Confirm each named sea zone is recognizable without opening details.
- Recommended next phase: TBD.

### Phase 7

- Record final lighthouse/ground integration choices and whether any asset or
  manifest geometry changed.
- Confirm lighthouse selection remains aligned with visible sprite/base.
- Recommended next phase: TBD.

### Phase 8

- Record all validation commands, screenshot/snapshot decisions, docs updated,
  remaining risks, and final ship/no-ship decision.
- Recommended next phase: TBD.

## Phase Completion Notes

Append future updates here. Keep entries concise and factual.

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
