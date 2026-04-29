# PharosVille Motion Policy

Last updated: 2026-04-29

PharosVille uses one route-owned motion clock. Normal motion is driven by the
canvas `requestAnimationFrame` loop in `pharosville-world.tsx`; reduced motion
renders deterministic static frames and must not keep a RAF loop alive.

## Speed Classes

- Static: terrain, printed water labels, cemetery markers, dormant buildings,
  dock footprints, cluster markers, and detail chrome.
- Slow: lighthouse fire/beam, semantic water shimmer, fog, selected
  relationship pulse, harbor lamps, and lighthouse-attached birds.
- Medium: ship movement along sampled water routes and bounded building
  activity effects.
- Fast: recent-change sparks and wake accents only, capped to selected, top, or
  recent-mover ships.

## Cue Priority

1. Selected or focused entity.
2. Active risk or critical PSI state.
3. Recent supply or data update.
4. Building state.
5. Ambient life attached to lighthouse, harbor, cemetery, or civic core.

## Caps And Parity

- Selected pulse: one selected entity family at a time.
- Relationship overlays: selected ship or selected dock only.
- Ship wake/effects: selected, top-supply, or recent-mover ships only.
- Ambient birds: capped to the lighthouse/far-sea set exposed in debug state.
- Harbor lights: fixed local civic-core list exposed in debug state.
- Building effects: one bounded local effect set per building.
- No independent CSS animation, sprite loop, minimap loop, interval, or timer may
  encode analytical state outside the main motion clock.
- Every analytical motion cue needs visual-cue registry metadata, DOM/detail or
  accessibility-ledger parity, and a reduced-motion equivalent.

## Ship Risk-Water Motion

- `calm`, `watch`, `alert`, `warning`, and `danger` map to the northern DEWS sea belt from Calm Anchorage through Danger Strait. `fog` maps to Data Fog, and `ledger` maps to Ledger Mooring.
- Higher DEWS turbulence should increase risk-water dwell, drift radius, and sailing wake intensity in this order: calm < watch < alert < warning < danger.
- Docked reduced-motion ships freeze at their representative harbor mooring. Dockless reduced-motion ships freeze at their risk-water patrol sample. In both cases, details and the accessibility ledger must expose named risk-water area and risk-water zone.
- Dockless normal-motion patrols must not collapse to a near-static loop. If a named area is too small for meaningful travel, use current or adjacent northern sea anchors while keeping samples on water tiles.

## Debug Contract

Development/test builds expose `window.__pharosVilleDebug` fields for browser
validation:

- `motionClockSource`
- `activeMotionLoopCount`
- `motionCueCounts`
- `motionFrameCount`
- `reducedMotion`

Reduced motion should report `activeMotionLoopCount = 0` and
`motionClockSource = "reduced-motion-static-frame"`. Normal motion should report
`activeMotionLoopCount = 1` and `motionClockSource = "requestAnimationFrame"`.
