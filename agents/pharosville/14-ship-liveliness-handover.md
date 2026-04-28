# PharosVille Ship Liveliness Handover

Created: 2026-04-28

## Objective

Maintain the operational handover for the PharosVille ship liveliness implementation described in `agents/pharosville/13-ship-liveliness-motion-plan.md`.

This file is the handover ledger only. It should track phase status, reviewer feedback, commits, validation, and remaining next steps as the implementation proceeds. It must not introduce source-code changes, README changes, or implementation details that supersede the motion plan without calling out the reason.

## File Ownership

- Owned file for this handover-manager task: `agents/pharosville/14-ship-liveliness-handover.md`
- Do not edit source code from this handover task.
- Do not update `README.md` yet.
- Keep implementation notes, reviews, validation records, and process updates in this file unless a future request explicitly changes ownership.

## Current Known Dirty-Worktree Caution

As of handover creation, the worktree is already dirty with many unrelated changes across PharosVille source, tests, docs, assets, and README files. Treat these as existing user/agent work and do not overwrite, revert, stage, or commit them from this handover task.

Known dirty areas observed with `git status --short` include:

- Modified root/docs/agent docs: `README.md`, `agents/pharosville/README.md`, `docs/architecture.md`, `docs/cemetery-and-compare.md`, `docs/data-visualization.md`, `docs/pharosville-page.md`
- Modified PharosVille source/tests: `src/app/pharosville/**`, `tests/visual/pharosville.spec.ts`, and PharosVille visual snapshots
- Modified cemetery source: `src/app/cemetery/page.tsx`, `src/components/cemetery-client.tsx`, `src/components/cemetery-tombstones.tsx`
- Deleted PharosVille files/assets: old lighthouse asset and several PharosVille component files
- Untracked PharosVille planning/assets: `agents/pharosville/10-v1-refinement-plan.md`, `11-pixellab-phase-2-lighthouse-plan.md`, `12-chain-harbor-docks-plan.md`, `13-ship-liveliness-motion-plan.md`, `agents/pharosville/pixellab-prototypes/`, and new dock/lighthouse assets
- Untracked cemetery planning/module files under `agents/plans/` and `src/components/cemetery-tombstones.module.css`

Before any implementation phase, re-run `git status --short` and inspect diffs for files that phase intends to touch. Work with existing changes; do not clean the worktree unless the user explicitly requests it.

## Handover Protocol

1. Start each implementation session by reading this file and `agents/pharosville/13-ship-liveliness-motion-plan.md`.
2. Re-run `git status --short` before editing. Record any new dirty-worktree risks in the relevant phase notes.
3. Keep source changes out of this handover-manager task. Future implementation agents may edit source only when explicitly assigned implementation work.
4. After each phase, update that phase's completion notes, reviewer feedback, commits, validation, and remaining next steps in this file.
5. Record exact validation commands and outcomes. If a command is not run, write why.
6. Record reviewer feedback with links or file/line references where available.
7. Record commits by short SHA and subject after they exist. Do not invent commit IDs.
8. Keep phase scope aligned with the motion plan. If scope changes, note the decision, owner, and date.
9. Do not update `README.md` from this handover flow. The plan currently requires docs updates during implementation, but README is intentionally deferred.

## Phase Checklist

### Phase 1: Model And Tests

- [x] Add chain presence, dock visits, risk zone, and route facts to `ShipNode`.
- [x] Stop using `placeDockedShips()` to overwrite `ship.tile`; replace it with itinerary assignment.
- [x] Update world-model and detail tests first.

Success criteria from the motion plan:

- [x] A healthy multichain ship has rendered dock visits.
- [x] An active-depeg multichain ship keeps a storm risk tile.
- [x] A ship whose dominant chain is unrendered still uses its largest rendered positive chain as `homeDockChainId`.
- [x] Reduced-motion representative placement is semantically meaningful.

Phase completion notes:

- Complete and committed. Model/test feedback was incorporated. New `ShipNode` route fields are required, dock visit assignment uses required `chainPresence`, and the clustering fixture is updated.
- Carry forward two known non-Phase-1 validation blockers: stale docked-ship hit-testing expectation under broader PharosVille tests, and an unrelated `world-canvas.ts` cemetery helper typecheck error.

Reviewer feedback:

- Phase 1 reviewer go: model/test feedback incorporated. New `ShipNode` route fields are required, dock visit assignment uses required `chainPresence`, clustering fixture is updated, and focused world/clustering tests pass.

Commits:

- `b2e55459b` `feat(pharosville): model ship docking itineraries`

Validation:

- Passed: `npm test -- src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/systems/clustering.test.ts`
- Failed with known non-Phase-1 blocker only: `npm test -- src/app/pharosville`
  - Failure: stale docked-ship hit-testing expectation under broader PharosVille tests.
- Failed with known unrelated blocker: `npm run typecheck`
  - Failure: current `world-canvas.ts` cemetery helper issue.

Remaining next steps:

- Start Phase 2: Water Routes And Motion Plan.
- Before Phase 2 implementation, account for the carried-forward hit-testing expectation and `world-canvas.ts` typecheck blocker so they are not misattributed to Phase 2 route work.

### Phase 2: Water Routes And Motion Plan

- [x] Add `ShipWaterPath`, `ShipMotionRoute`, `ShipMotionSample`, route builder, and sampler.
- [x] Ensure basic route samples cover all rendered ships.
- [x] Keep wake/effect budget capped.

Success criteria from the motion plan:

- [x] Every visible ship has a route.
- [x] Samples are deterministic by ID and time.
- [x] Chain breadth affects cycle/cadence.
- [x] Sampled route positions stay on water/deep-water.
- [x] Storm/fog behavior does not imply healthy dock activity.

Phase completion notes:

- Complete and committed. Phase 2 added deterministic ship motion route construction and sampling in `src/app/pharosville/systems/motion.ts`, with focused coverage in `src/app/pharosville/systems/motion.test.ts`.
- Scope stayed limited to route/motion systems. Renderer, hit testing, debug frame wiring, and visual integration remain Phase 3+ work.

Reviewer feedback:

- Phase 2 reviewer Maxwell gave Go after follow-up.
- Reviewer confirmed deterministic route construction/sampling, water-only sampled routing, reduced-motion static sampling, chain-breadth cadence, storm/fog dwell behavior, and focused coverage.

Commits:

- `ffb0b0f47` `feat(pharosville): add ship motion routes`

Validation:

- Passed: `npx vitest run src/app/pharosville/systems/motion.test.ts` with 12 tests.
- Passed: `npx eslint src/app/pharosville/systems/motion.ts src/app/pharosville/systems/motion.test.ts`
- Passed: `git diff --check -- src/app/pharosville/systems/motion.ts src/app/pharosville/systems/motion.test.ts`
- Known broader blocker remains: `npm test -- src/app/pharosville` has stale hit-testing expectations until Phase 3 samples are wired.
- Known broader blocker remains: `npm run typecheck` has pre-existing/current dirty PharosVille renderer/ship visual failures to address in later integration.
- Known broader blocker remains: `npx vitest run src/app/pharosville/systems` still has ship visual expectation drift from current dirty ship visual work.

Remaining next steps:

- Start Phase 3: Renderer And Hit Testing.
- Wire Phase 2 samples into canvas drawing, hit target generation, selected rings, hover/click, debug frame state, and follow-selected behavior.
- Resolve or update the stale docked-ship hit-testing expectation as part of Phase 3 sample wiring.
- Preserve the Phase 2 reduced-motion static sampling contract when integrating the renderer.

### Phase 3: Renderer And Hit Testing

- [x] Wire sampled positions into drawing.
- [x] Wire sampled positions into hit targets.
- [x] Wire sampled positions into selected rings, hover/click, debug, and follow-selected behavior.
- [x] Avoid per-frame React state updates.

Success criteria from the motion plan:

- [x] Ships visibly move in normal motion.
- [x] Moving ships remain clickable.
- [x] Docked ships remain above dock hitboxes.
- [x] Reduced motion still has no RAF loop.

Phase completion notes:

- Complete and committed. Phase 3 wired committed Phase 2 ship motion samples into canvas rendering, hit testing, selected/hovered behavior, debug frame state, and follow-selected behavior.
- The blocker during review was the outside-click capture handler clearing toolbar actions before Follow selected. It was fixed by exempting `.pharosville-overlay` and `.pharosville-fullscreen-button` through `Element.closest()`, so SVG/icon descendants are handled.
- Commit includes asset-manager logo loading and sail logo drawing because the user explicitly requested each ship/stablecoin show its logo on its sail, and the canvas wiring needs that runtime support.
- Partial staging was used for `src/app/pharosville/renderer/hit-testing.ts` and `src/app/pharosville/renderer/world-canvas.ts`; unrelated dirty cemetery/dock visual edits in those files remain unstaged.

Reviewer feedback:

- Phase 3 reviewer Singer gave final Go after two follow-ups.

Commits:

- `8dadfbbbd` `feat(pharosville): wire ship motion into canvas`

Validation:

- Passed: `npm test -- src/app/pharosville/renderer/hit-testing.test.ts src/app/pharosville/systems/motion.test.ts` with 17 tests.
- Passed: `npx eslint src/app/pharosville/renderer/world-canvas.ts src/app/pharosville/renderer/hit-testing.ts src/app/pharosville/renderer/hit-testing.test.ts src/app/pharosville/pharosville-world.tsx`
- Passed: `npm run typecheck`
- Passed before commit: `git diff --cached --check`
- Remaining validation expectations for later phases/final validation: run broader PharosVille tests, visual regression checks, build, SEO, harbor palette, and merge gate after Phase 4/5 docs, DOM parity, and tuning are complete.
- Current dirty-worktree caution remains: `src/app/pharosville/renderer/hit-testing.ts` and `src/app/pharosville/renderer/world-canvas.ts` may still contain unrelated unstaged visual edits after the Phase 3 partial-staging commit.

Remaining next steps:

- Start Phase 4: Water Zones And DOM Parity.
- Reviewer handoff for Phase 4: verify restrained safe/muddy/storm/fog environmental treatment, route facts in the detail panel and accessibility ledger, DOM parity for motion/docking meaning, and no badge-colored water/status overstatement.
- Preserve Phase 3's sampled-position contract in any water-zone or DOM work: drawing, hit targets, debug state, and follow-selected behavior must keep reading the same frame samples.

### Phase 4: Water Zones And DOM Parity

- [x] Add restrained environmental water treatment.
- [x] Add route facts in the detail panel.
- [x] Add route facts in the accessibility ledger.

Success criteria from the motion plan:

- [x] Safe/muddy/storm/fog areas are readable but not badge-colored.
- [x] Canvas is not the only source of motion/docking meaning.
- [x] Detail panel and accessibility ledger explain source fields.

Phase completion notes:

- Complete and committed. Phase 4 added ship route DOM parity through detail-model facts, accessibility ledger route summaries, and the visual cue registry.
- The review blocker was a zero rendered dock edge case where multichain ships could be labeled `Frequent`; fixed so zero rendered dock stops stays `No rendered dock cadence`.

Reviewer feedback:

- Phase 4 reviewer Locke gave Go after follow-up.

Commits:

- `48efbdfee` `feat(pharosville): add ship route DOM parity`

Validation:

- Passed: `npm test -- src/app/pharosville/systems/visual-cue-registry.test.ts src/app/pharosville/systems/pharosville-world.test.ts src/app/pharosville/systems/motion.test.ts` with 22 tests.
- Passed: `npx eslint src/app/pharosville/systems/detail-model.ts src/app/pharosville/components/accessibility-ledger.tsx src/app/pharosville/systems/visual-cue-registry.ts src/app/pharosville/systems/visual-cue-registry.test.ts`
- Passed: `npm run typecheck -- --pretty false`
- Passed: `git diff --check -- src/app/pharosville/systems/detail-model.ts src/app/pharosville/components/accessibility-ledger.tsx src/app/pharosville/systems/visual-cue-registry.ts src/app/pharosville/systems/visual-cue-registry.test.ts`

Remaining next steps:

- Start Phase 5: Visual Regression And Tuning.
- Phase 5 should verify the integrated page visually and behaviorally: moving samples, reduced-motion determinism, screenshot stability, click/follow behavior, DOM route parity, and no overstatement of docking cadence.
- Final validation should include the broader PharosVille suite and release-gate commands listed in the validation ledger.

### Phase 5: Visual Regression And Tuning

- [x] Update Playwright checks.
- [x] Run full validation.
- [x] Tune constants by screenshot and interaction behavior.

Success criteria from the motion plan:

- [x] Desktop shell remains nonblank and performant.
- [x] Normal-motion test proves movement.
- [x] Reduced-motion screenshots are stable.
- [x] Focused interaction tests pass.

Phase completion notes:

- Complete. Phase 5 delivered slower ship motion and deterministic water-only detours, spread risk anchors, split long-tail clusters, and hardened the normal-motion Playwright test with a virtual clock after reviewer feedback.
- Dirty-worktree caution: many unrelated PharosVille/cemetery/docs/assets remain unstaged. `tests/visual/pharosville.spec.ts` and docs still contain Phase 5 and/or unrelated dirty edits that are not included in the two commits listed below.

Reviewer feedback:

- Reviewer feedback led to hardening the normal-motion Playwright test with a virtual clock.

Commits:

- `6d044a463` `feat(pharosville): tune ship motion pacing`
- `d0b144ecd` `chore(pharosville): track motion hotspot follow-ups`
- `ba0b27b55` `test(pharosville): harden moving ship coverage`

Validation:

- Passed: `npm test -- src/app/pharosville` with 33 files and 138 tests.
- Passed: focused system tests with 24 tests.
- Passed: `npm run lint`
- Passed: `npm run typecheck -- --pretty false`
- Passed: `npm run build`
- Passed: `npm run seo:check`
- Passed: `npm run check:harbor-palette`
- Passed: `npm run check:pharosville-assets`
- Passed before reviewer fix: `npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"` with 8 tests.
- Passed after reviewer fix: `npx playwright test tests/visual/pharosville.spec.ts --grep "normal motion"` with 1 test in 1.4s.
- Passed: `npm run check:hotspot-ratchet`
- Passed after hotspot waiver metadata update: `npm run test:merge-gate`
- Merge gate note: `audit:deps` still reports the known moderate Next/PostCSS advisory, but exits successfully because the audit threshold is high.

Remaining next steps:

- Before final shipping or additional commits, re-run `git status --short` and intentionally separate remaining dirty edits from unrelated PharosVille/cemetery/docs/assets work.
- A narrow Playwright motion hardening patch was committed in `ba0b27b55`; broader `tests/visual/pharosville.spec.ts` and docs dirty edits remain in the worktree and still need an explicit ownership decision.
- Keep the hotspot follow-up tracked by `d0b144ecd` visible for later cleanup; do not fold it into this completed liveliness phase unless explicitly requested.

## Validation Command Ledger

Planned validation commands from the motion plan:

```bash
npm test -- src/app/pharosville
npm run lint
npm run typecheck
npm run build
npm run seo:check
npm run check:harbor-palette
npx playwright test tests/visual/pharosville.spec.ts --grep "pharosville"
npm run test:merge-gate
```

Record actual command outcomes under the phase that runs them.

## Cross-Phase Guardrails

- Do not let docking cadence imply transaction frequency, bridge flow, or real-time transfers. It represents positive chain presence and supply share only.
- Do not represent stale/missing evidence as storm risk.
- Do not animate all 215 assets individually until there is a zoom/LOD plan and canvas budget proof.
- Do not use straight-line routes that cross land or roads.
- Do not move analytical truth into canvas only; every encoded signal needs DOM parity.
- Do not add bright particle effects, arcade movement, or storm drama that competes with data readability.
- Do not use React state for per-frame positions.
- Do not change viewport-gate behavior.

## Deferred Follow-Up

Literal per-asset rendering for all 215 active stablecoins remains out of scope for this ship liveliness implementation. That larger follow-up needs a separate plan for zoom-level LOD or culling policy, performance budget proof, hit-target density, and revised clustering/detail semantics.
