# Lighthouse Isometric Harbor — Retrospective

**Date:** 2026-04-25
**Branch:** feat/lighthouse-isometric-harbor
**Plan:** docs/superpowers/plans/2026-04-25-lighthouse-isometric-harbor.md
**Audit:** docs/superpowers/audits/2026-04-25-pixi-v8-csp.md

## What shipped

Replaced both /lighthouse and /lighthouse-2 with a single Canvas 2D pixel-art
harbor scene at /lighthouse:
- Pharos as the lighthouse with a volumetric beam color-keyed to PSI band
  and rotation period scaled by band (12s BEDROCK -> 1.2s MELTDOWN).
- Lantern halo pulsing on a constant 0.42s heartbeat decoupled from the beam.
- Chains as harbours arranged in an off-center triangle around the lighthouse,
  with build quality (stone / wood / weathered) tracking resilience tier.
- Stablecoins as boats moored at each harbour's dock terminus; silhouette
  encodes (governance, backing) tuple — galleon/brigantine/schooner/junk;
  pennant color from DEWS threat band; idle bob at 1Hz with id-stable phase.
- Three-frequency sine wave water with amplitude driven by aggregate DEWS
  band; foam intensity at the shoreline visible even under reduced motion.
- Sky gradient + 70 deterministic stars + moon; dock lamps + warehouse window
  glow; auto-drift parallax breath at 3-min cycle.
- HTML overlay layer for keyboard/screen-reader navigation; sr-only a11y
  ledger enumerates every visual encoding.

## What was the load-bearing change

PixiJS v8 fails Pharos's strict CSP at runtime: `AbstractRenderer._unsafeEvalCheck`
throws under `script-src 'self' 'unsafe-inline'` because v8 builds shaders via
`new Function()`. The check is unconditional and not configurable. The Phase 0
spike confirmed this; @pixi/unsafe-eval is stuck at v7.4.3.

Switched to Fork A: plain Canvas 2D with a single requestAnimationFrame loop,
GSAP value tweens (renderer-agnostic — animates JS values that layers read
per frame), and pure draw functions per sprite/layer. Bundle savings vs the
PixiJS plan: ~280 KB gz (Pixi removed entirely).

## Architectural deltas (worth carrying forward)

- **24-color anchor palette + lint guard.** `src/app/lighthouse/systems/palette.ts`
  + `scripts/check-harbor-palette.mjs` enforces every hex literal under
  `src/app/lighthouse/` comes from the palette.
- **FrameState contract.** Every layer is `(ctx, FrameState) -> void`. New
  layers don't need to reach into React or own their own RAF loop.
- **GSAP value tweens, not DOM animations.** `frame.beam.rotationRad` and
  `frame.lantern.alpha` are mutated by GSAP outside React's render path; the
  layer reads them on every frame. Single `parentTimeline.pause()` halts
  every animation under reduced-motion.
- **Dependency-injected meta lookup.** `buildSceneData(metaById?)` defaults
  to `ACTIVE_META_BY_ID` from the registry but accepts a custom map for tests
  (the API doesn't return classification flags; the registry is the source).
- **Reduced-motion freeze composition.** Pausing animations is half the work
  — the other half is making the frozen pose informative. We aim the beam at
  the largest harbour and keep foam intensity tracking DEWS amplitude so
  data is conveyed without motion.
- **Phased PR slicing.** The plan was 5 PRs; we shipped them as logical
  commits on a single branch in this session. Each phase ran with
  parallelizable subagent work, integration commits gating the next phase.

## What was deferred

- Sailing-boat patrol animation (the Bezier path generator is in place at
  `systems/patrol.ts` but no boats currently sail).
- DEX dock cranes (per-chain DEX presence visualization).
- Yield-protocol mini-lighthouses on chain harbours.
- Bridge route animation between chains (no client-side bridge-volume feed).
- Storm rain/lightning particles for DEWS DANGER state.
- Camera pan/zoom on harbour click.
- PixelLab MCP-generated PNG sprite atlas (Phase 6 polish).

## What surfaced unexpected

- **The 24-color palette had 25 entries.** The design author counted `ember`
  in two semantic groups (warm-light pole + health/data ramp) but defined it
  once. Fixed during Phase 1.
- **`depthKey` needed `* SCENE_GRID * 2`, not `* SCENE_GRID`.** The plan's
  formula failed the elevation-beats-ground invariant in a 40x40 grid (max
  ground sum 78 > SCENE_GRID 40). Fixed during Phase 1.
- **`GovernanceType`/`BackingType` weren't re-exported by classification.ts.**
  They live in `@shared/types` (re-exported from core.ts). Plan import path
  was wrong.
- **`StablecoinData` API rows don't carry `flags`.** The plan's adapter read
  `coin.flags`, which would render every boat as the schooner default in
  production. Fixed by routing through `ACTIVE_META_BY_ID` instead.
- **Next 16 forbids `dynamic({ssr:false})` in Server Components.** The Phase
  0 spike caught this; the SSR gate moved entirely into client.tsx.

## Test coverage

- 109 tests across 26 files (palette / isometric / classification mapping /
  scene-data adapter / a11y ledger / reduced-motion / animation / patrol /
  rng / freeze / lamp-layer / boat-layer / harbor-layer / sprites
  geometry / ui-overlay).
- 1 Playwright visual regression test under reduced-motion.
- Visual layers (sky/water canvas paint) deferred to the Playwright snapshot.
