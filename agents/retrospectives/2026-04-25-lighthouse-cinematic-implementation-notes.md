# Lighthouse Cinematic Implementation Notes

Date: 2026-04-25
Status: Running notes for the base and follow-up `/lighthouse/` implementation.

## Working Notes

- Starting state: only `agents/specs/2026-04-25-lighthouse-cinematic-engine-plan.md` was modified before implementation work resumed.
- Follow-up plan created before code work so findings from the base implementation can be routed into a bounded post-base refinement pass.

## Base Implementation Findings

- Root model implemented as `src/app/lighthouse/cinematic-model.ts`.
- The base model composes existing sources only: chain harbor helpers, PSI colors, DEWS helpers, and alt-peg hero sizing/packing.
- Hostile input handling needed explicit sanitization before using chain and DEWS helpers; otherwise NaN geometry can leak through log/radar math.
- DEWS is modeled as aggregate radar marks detached from chain harbors to preserve the no per-chain DEWS semantics.
- Alt-peg projection should stay visually secondary because live alt-peg data can produce many small marks quickly.
- The route shell now keeps visible copy out of first paint; the only always-present text is the screen-reader heading and the hidden ledger.
- The stage keeps the exact data audit path in `LighthouseA11yLedger`; small screens expose the ledger automatically because the dense SVG cannot remain the only accessible surface there.
- SVG accessibility labels intentionally repeat harbor names, so tests need ledger-scoped or `getAllBy*` assertions when checking exact names.
- `npm test -- src/app/lighthouse/cinematic-model.test.ts src/app/lighthouse/lighthouse-stage.test.tsx src/app/lighthouse/page.test.tsx` passes after the stage implementation.
- `npm run typecheck` passes after the stage implementation.
- The previous chapter/story implementation became unreachable after the stage route switch; removing it eliminates stale docs/tests and keeps `/lighthouse/` to one model and one renderer.
- `docs/lighthouse-page.md` now documents the cinematic model, stage layers, data hooks, and no-new-score semantics.
- Cleanup validation passed with the focused lighthouse tests, `npm run check:doc-source-paths -- docs/lighthouse-page.md docs/README.md`, and `npm run typecheck`.
- User review rejected the stacked lighthouse composition; modules now behave as canvas blocks: harbor fleet, PSI lens, DEWS radar, and alt-peg map each have explicit model bounds and are arranged across a 1920x1080 stage.
- The route breaks out of the app-level `container` max width so the inline visualization spans the full content lane next to the pinned sidebar.
- Browser review caught a real SVG bug: CSS `transform` animation on `.lh-harbor-mark` overrode each harbor group's SVG `transform`, pulling ships to the origin. The harbor drift animation was removed; pennants and water retain motion.
- The lighthouse was reduced to a central hub so the module blocks, not the tower, carry the layout.
- The fullscreen feature from a parallel agent is in-scope: it promotes `useBrowserFullscreen` to `src/hooks/use-browser-fullscreen.ts`, keeps alt-pegs on the shared hook, and lets `/lighthouse/` open the same stage in a viewport-sized Radix Dialog with progressive browser fullscreen.
- The fullscreen dialog title is screen-reader-only so the expanded surface stays visually icon-only.
- Full-canvas screenshot: `agents/screenshots/lighthouse-cinematic-2026-04-25/modular-full-canvas-1920-v4.png`.

## Follow-Up Candidates

- Verify responsive block placement at tablet and mobile sizes after the full-canvas correction.
- Consider whether the module block outlines should become slightly more architectural or recede further after specialized design review.
- Verify fullscreen dialog composition after the inline canvas is accepted.

## Review Notes

- Pending.
