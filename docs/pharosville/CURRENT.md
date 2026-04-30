# Current PharosVille Agent Source Of Truth

Last updated: 2026-04-30

Use this file before changing `/pharosville/`. It summarizes the current implementation shape for maintainers; the verified product contract remains `docs/pharosville-page.md`.

## Status

PharosVille is an implemented desktop-only route at `/pharosville/`. It is an old-school maritime isometric analytics surface backed by existing Pharos APIs, local PNG sprites, a pure world model, a Canvas 2D renderer, and DOM-accessible details.

The current visual revamp target is a dense dark-first maritime observatory
diorama: richer local sprites, textured sea/coast/harbor materials, warm
lighthouse and harbor lighting, readable in-world plaques, and polished
route-local chrome. It is not a ClaudeVille port; ClaudeVille contributed the
quality bar and validation habits, not its lore, fantasy-village objects,
agent mechanics, copy voice, or data semantics.

Historical plans in this directory are context, not live instructions. If they conflict with this file, follow this file and the verified docs.

## Runtime Entry Points

- Route shell: `src/app/pharosville/page.tsx`
- Viewport gate and dynamic desktop mount: `src/app/pharosville/client.tsx`
- Data hook aggregation: `src/app/pharosville/pharosville-desktop-data.tsx`
- Canvas/runtime shell: `src/app/pharosville/pharosville-world.tsx`
- Pure world model: `src/app/pharosville/systems/pharosville-world.ts`
- Map/terrain layout: `src/app/pharosville/systems/world-layout.ts`
- Chain dock model: `src/app/pharosville/systems/chain-docks.ts`
- Ship risk placement: `src/app/pharosville/systems/risk-placement.ts`
- Risk-water source of truth: `src/app/pharosville/systems/risk-water-areas.ts`
- Risk-water placement validation: `src/app/pharosville/systems/risk-water-placement.ts`
- Printed water labels: `src/app/pharosville/systems/area-labels.ts`
- Ship visuals and size classes: `src/app/pharosville/systems/ship-visuals.ts`
- Deterministic ship routes: `src/app/pharosville/systems/motion.ts`
- Detail/DOM parity: `src/app/pharosville/systems/detail-model.ts`, `src/app/pharosville/components/accessibility-ledger.tsx`
- Renderer and hit testing: `src/app/pharosville/renderer/world-canvas.ts`, `src/app/pharosville/renderer/hit-testing.ts`
- Shared render geometry: `src/app/pharosville/renderer/geometry.ts`
- Asset manifest/types: `public/pharosville/assets/manifest.json`, `src/app/pharosville/systems/asset-manifest.ts`

## Current Route Invariants

- The desktop world must not mount below `1280px` width or `760px` height. Below that gate, keep the DOM fallback and avoid world queries, manifest fetches, canvas setup, and sprite decoding.
- PharosVille uses existing frontend hooks and API payloads. Do not add Worker/API sources for visual-only route changes unless the user explicitly asks for a new data contract.
- The world model should stay pure and deterministic. Canvas drawing, hit testing, selected rings, follow-selected behavior, and debug frame state must sample the same motion model.
- Reduced-motion users get a deterministic non-animated frame without a running RAF loop.
- Normal motion uses one route-owned RAF clock. Motion caps, cue priority, and
  debug expectations are recorded in `docs/pharosville/MOTION_POLICY.md`.
- Canvas is not the only source of analytical meaning. Any new visual signal needs matching detail-panel or accessibility-ledger text.
- Ship placement and semantic water zones express peg/DEWS risk or source confidence. Dock visits express positive chain presence and supply share; they must not imply bridge volume, transaction flow, or real-time transfers.
- Fresh DEWS risk water uses edge-anchored compound/coast-aware masks. Ledger Mooring remains the only non-DEWS named risk-water area and stays clear of Solana/top-chain harbor traffic.

### DEWS zone geometry

Edge-anchored compound masks (current iteration as of 2026-04-30):

| Zone | Primary edge | Bounds | Approx tiles |
|------|--------------|--------|-------------:|
| CALM | x=0 | large left-edge vertical anchorage basin | ~549 |
| WATCH | y=0 | wide top-edge breakwater band | ~408 |
| ALERT | x=55/eastern corner | outer eastern ring | ~142 |
| WARNING | x=55/eastern corner | middle eastern ring bridged into Danger Strait | ~114 |
| DANGER | x=55/eastern corner | inner/right storm strait on the angled shelf | ~74 |

The eastern corner is covered by overlapping ALERT+WARNING+DANGER water, with
Warning Shoals touching the Danger Strait shelf rather than leaving a generic
water gap. Two-tile island periphery and lighthouse visual-clearance box
(x:14..24, y:23..32) are generic water.
- Stale or missing peg evidence maps to Calm Anchorage with an evidence caveat unless a fresher risk signal exists; it must not create a separate sea zone or masquerade as storm/depeg risk.
- Stablecoin supply values from the list payload are already USD-denominated. Use `getCirculatingRaw()` for market-cap visual tiers.
- Local runtime assets come from `public/pharosville/assets/` and `manifest.json`. Do not reference Pixellab URLs or remote assets at runtime.
- The current manifest has 32 runtime assets: 22 critical/first-render entries and 10 deferred entries. `npm run check:pharosville-assets` enforces the local PNG contract and the v0.1 core cap of 34 manifest assets.

## Current Visual Model

- Chain harbors are built from top chain supply and capped by `MAX_CHAIN_HARBORS` in `chain-docks.ts`.
- The authored map is `56 x 56` tiles. Deep outer water is intentionally a narrow perimeter shelf, not a large default border.
- The current composition target is 78-82% water by tile count with a tighter default camera and more coast/district density.
- Named sea areas use printed cartographic water labels backed by
  `systems/area-labels.ts`; renderer drawing, hit targets, and follow-selected
  behavior must use the same placement metadata.
- Printed water labels render above entity sprites, so label visibility and label hit targets intentionally win over overlapping ships or tall landmarks.
- Sea terrain is semantic: harbor water, calm DEWS anchorage water, watch breakwater water, alert current, warning shoals, storm strait, ledger water, generic navigable water, and deep outer shelf each have distinct palette/texture handling. Manifest terrain sprites draw first; renderer overlays preserve analytical color semantics while adding shoals, foam, current streaks, storm chop, ledger glow, and reef/buoy context.
- Ship risk routes expose both `riskWaterLabel` and `riskZone` in details and the accessibility ledger. Reduced-motion ships freeze at their current risk-water idle tile, or Ledger Mooring for NAV ledger assets; harbor moorings are route stops, not the static representative position.
- Dock sprites are rank/preference selected through manifest IDs such as `dock.ethereum-harbor-hub`, `dock.harbor-ring-quay`, `dock.compact-harbor-pier`, `dock.rollup-ferry-slip`, and `dock.bridge-pontoon`; Ethereum's hub remains selectable while its dock body is drawn behind ships so harbor traffic sails over it.
- Dock selection reserves the Ethereum/L2 harbor cluster (`ethereum`, `base`, `arbitrum`, `optimism`, `polygon`, `mantle`) when those chains are present, then fills the remaining ten-dock cap by chain stablecoin supply.
- The Ethereum/L2 cove prints `ETHEREUM HARBOR` and `L2 BAY` plaque signs using the same canvas label treatment as named DEWS water areas.
- Ship class is derived from governance/backing metadata:
  - centralized -> treasury galleon
  - centralized-dependent -> chartered brigantine
  - decentralized -> DAO schooner
  - algorithmic backing -> legacy algorithmic junk
  - unknown -> defensive caravel fallback
- Ship size is a compressed market-cap tier, not linear area.
- The current runtime manifest uses schema v2. `style.cacheVersion` controls image cache busting; `style.styleAnchorVersion` is the provenance/style anchor for generated assets.
- Asset loading is intentionally staged: the route loads the manifest and critical/first-render sprites before the initial canvas frame, then loads deferred sprite families after the core scene can render. Do not move visual-only sprites into the critical set without checking first-render need and the manifest cap.
- The current lighthouse asset is `landmark.lighthouse` at `public/pharosville/assets/landmarks/lighthouse-alexandria.png`, with manifest cache version `2026-04-30-pharosville-island-harbor-recompose-v1` and style anchor `2026-04-29-lighthouse-hill-v5`.
- Current ship sprites share the lighthouse style anchor, use 104 x 80 transparent PNGs, keep logo-safe sail/pennant zones, and treat overlays as small lanterns/pennants/signals rather than badges.
- Current cemetery props share the same style anchor and use a local memorial sprite set under `public/pharosville/assets/props/`: `memorial-terrace`, `memorial-headstone`, `ledger-slab`, `reliquary-marker`, and `regulatory-obelisk`.

## Agent Workflow

1. Read `docs/pharosville-page.md`, this file, `CHANGE_CHECKLIST.md`, and `TESTING.md`.
2. Use `CHANGE_PLAYBOOK.md` to classify the task and choose the smallest relevant source/doc/test set.
3. For visual semantics, read `VISUAL_INVARIANTS.md`; for fixture or browser coverage, read `SCENARIO_CATALOG.md` and `VISUAL_REVIEW_ATLAS.md`.
4. For visual/asset changes, also read `ASSET_PIPELINE.md`; for repeat-risk checks, read `KNOWN_PITFALLS.md`.
5. Run `git status --short` before editing. Preserve existing dirty work and inspect any file you intend to touch.
6. Keep code changes surgical and route-local unless the user asks for broader behavior.
7. Update `docs/pharosville-page.md` only when route behavior changes. Update this maintenance pack when process, ownership, or handoff guidance changes.

## Local Code Orientation

- `src/app/pharosville/systems/README.md` explains the pure data-to-world layer and its extension points.
- `src/app/pharosville/renderer/README.md` explains Canvas drawing, asset loading, hit testing, and renderer validation.

## Known Historical Drift

- `12-chain-harbor-docks-plan.md` describes a top-six dock target; the current model is governed by `MAX_CHAIN_HARBORS`.
- `13-ship-liveliness-motion-plan.md` and `14-ship-liveliness-handover.md` describe the implementation history of motion and DOM parity; the current code and this file are authoritative.
- `15-ship-classes-pixellab-plan.md` describes the generation/implementation plan for ship classes; use `ship-visuals.ts` and `ASSET_PIPELINE.md` for current behavior.
- `16-lighthouse-hill-regeneration-plan.md` is a completed asset history; use the manifest and `ASSET_PIPELINE.md` for current asset edits.
