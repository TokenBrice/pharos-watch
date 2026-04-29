# Current PharosVille Agent Source Of Truth

Last updated: 2026-04-29

Use this file before changing `/pharosville/`. It summarizes the current implementation shape for agents; the verified product contract remains `docs/pharosville-page.md`.

## Status

PharosVille is an implemented desktop-only route at `/pharosville/`. It is an old-school maritime isometric analytics surface backed by existing Pharos APIs, local PNG sprites, a pure world model, a Canvas 2D renderer, and DOM-accessible details.

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
- Ship visuals and size classes: `src/app/pharosville/systems/ship-visuals.ts`
- Deterministic ship routes: `src/app/pharosville/systems/motion.ts`
- Detail/DOM parity: `src/app/pharosville/systems/detail-model.ts`, `src/app/pharosville/components/accessibility-ledger.tsx`
- Renderer and hit testing: `src/app/pharosville/renderer/world-canvas.ts`, `src/app/pharosville/renderer/hit-testing.ts`
- Asset manifest/types: `public/pharosville/assets/manifest.json`, `src/app/pharosville/systems/asset-manifest.ts`

## Current Route Invariants

- The desktop world must not mount below `1280px` width or `760px` height. Below that gate, keep the DOM fallback and avoid world queries, manifest fetches, canvas setup, and sprite decoding.
- PharosVille uses existing frontend hooks and API payloads. Do not add Worker/API sources for visual-only route changes unless the user explicitly asks for a new data contract.
- The world model should stay pure and deterministic. Canvas drawing, hit testing, selected rings, follow-selected behavior, and debug frame state must sample the same motion model.
- Reduced-motion users get a deterministic non-animated frame without a running RAF loop.
- Canvas is not the only source of analytical meaning. Any new visual signal needs matching detail-panel or accessibility-ledger text.
- Ship placement and water zones express peg/DEWS risk. Dock visits express positive chain presence and supply share; they must not imply bridge volume, transaction flow, or real-time transfers.
- Stale or missing peg evidence maps to data fog or degraded evidence, not storm/depeg risk.
- Stablecoin supply values from the list payload are already USD-denominated. Use `getCirculatingRaw()` for market-cap visual tiers.
- Local runtime assets come from `public/pharosville/assets/` and `manifest.json`. Do not reference Pixellab URLs or remote assets at runtime.

## Current Visual Model

- Chain harbors are built from top chain supply and capped by `MAX_CHAIN_HARBORS` in `chain-docks.ts`.
- Dock sprites are rank/preference selected through manifest IDs such as `dock.grand-quay`, `dock.rollup-ferry-slip`, and `dock.bridge-pontoon`.
- Ship class is derived from governance/backing metadata:
  - centralized -> treasury galleon
  - centralized-dependent -> chartered brigantine
  - decentralized -> DAO schooner
  - algorithmic backing -> legacy algorithmic junk
  - unknown -> defensive caravel fallback
- Ship size is a compressed market-cap tier, not linear area.
- The current runtime manifest uses schema v2. `style.cacheVersion` controls image cache busting; `style.styleAnchorVersion` is the provenance/style anchor for generated assets.
- The current lighthouse asset is `landmark.lighthouse` at `public/pharosville/assets/landmarks/lighthouse-alexandria.png`, with manifest cache/style version `2026-04-29-lighthouse-hill-v5`.

## Agent Workflow

1. Read `docs/pharosville-page.md`, this file, `CHANGE_CHECKLIST.md`, and `TESTING.md`.
2. For visual/asset changes, also read `ASSET_PIPELINE.md`.
3. Run `git status --short` before editing. Preserve existing dirty work and inspect any file you intend to touch.
4. Keep code changes surgical and route-local unless the user asks for broader behavior.
5. Update `docs/pharosville-page.md` only when route behavior changes. Update this agent pack when process, ownership, or handoff guidance changes.

## Known Historical Drift

- `12-chain-harbor-docks-plan.md` describes a top-six dock target; the current model is governed by `MAX_CHAIN_HARBORS`.
- `13-ship-liveliness-motion-plan.md` and `14-ship-liveliness-handover.md` describe the implementation history of motion and DOM parity; the current code and this file are authoritative.
- `15-ship-classes-pixellab-plan.md` describes the generation/implementation plan for ship classes; use `ship-visuals.ts` and `ASSET_PIPELINE.md` for current behavior.
- `16-lighthouse-hill-regeneration-plan.md` is a completed asset history; use the manifest and `ASSET_PIPELINE.md` for current asset edits.
