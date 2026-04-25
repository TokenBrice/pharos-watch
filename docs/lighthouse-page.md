# Lighthouse Page

Contract for the public concept route:

- `/lighthouse/` is a Canvas 2D isometric pixel-art harbor scene. Pharos is the lighthouse; chains are harbours; stablecoins are boats. PSI drives the beam; DEWS drives the sea.

Background on the renderer choice: a 2026-04-25 spike confirmed PixiJS v8 fails Pharos's strict CSP at runtime (`AbstractRenderer._unsafeEvalCheck` throws under `script-src 'self' 'unsafe-inline'`). See `docs/superpowers/audits/2026-04-25-pixi-v8-csp.md`. The page therefore uses plain Canvas 2D with a single `requestAnimationFrame` loop and GSAP value tweens.

---

## Route Shape

- **Page shell:** `src/app/lighthouse/page.tsx`
- **Route client:** `src/app/lighthouse/client.tsx`
- **Canvas mount + render loop:** `src/app/lighthouse/harbor-scene-client.tsx`
- **Canvas styles:** `src/app/lighthouse/harbor-scene.css`
- **Accessible ledger:** `src/app/lighthouse/lighthouse-a11y-ledger.tsx`
- **HTML overlay (keyboard targets, chain labels):** `src/app/lighthouse/layers/ui-overlay.tsx`
- **Render systems:** `src/app/lighthouse/systems/` (palette, isometric math, scene-data adapter, GSAP animation helpers, reduced-motion observer, freeze composition)
- **Sprites (pure draw fns):** `src/app/lighthouse/sprites/` (lighthouse, boats, harbour islands)
- **Layers (DrawableLayer wrappers):** `src/app/lighthouse/layers/` (sky, water, lamps, harbours, boats, lighthouse, ui-overlay)
- **Primary data hooks:** `useChains()`, `useStabilityIndexDetail()`, `useStressSignals()`, `useStablecoins()`
- **Primary API:** `GET /api/chains`, the PSI detail endpoint, aggregate `GET /api/stress-signals`, and `GET /api/stablecoins`

The route is intentionally visual-first. The lighthouse anchors at canvas (45%, 65%) — slightly off-center for rule-of-thirds — and harbours arrange in a fixed off-center triangle around it. Text is kept out of the canvas; exact data remains available through the sr-only ledger and the HTML overlay's chain labels.

---

## `/lighthouse/` Contract

`src/app/lighthouse/page.tsx` renders a minimal Server Component shell with:

- canonical path `/lighthouse/`
- breadcrumb JSON-LD
- a screen-reader heading
- a dynamic-imported `LighthouseClient` (no `ssr: false` here — Next 16 disallows that flag inside Server Components)

`src/app/lighthouse/client.tsx`:

- loads chains, PSI detail, stress signals, and stablecoins in parallel via TanStack Query
- builds a single `SceneData` snapshot via `buildSceneData()` (production reads classification flags from `ACTIVE_META_BY_ID`; tests inject a custom `metaById`)
- dynamic-imports `HarborSceneClient` with `ssr: false`
- renders the sr-only ledger alongside the canvas

`src/app/lighthouse/harbor-scene-client.tsx`:

- sizes a `<canvas>` to 70vh, DPR-aware (capped at 2)
- creates a `FrameState` and a layer stack: sky → water → harbours → boats → lamps → lighthouse
- runs a single `requestAnimationFrame` loop: clear → DPR scale → background wash → parallax-breath translate → invoke each layer's `draw(ctx, frame)` → restore
- starts a GSAP `parentTimeline` with two children: a beam-rotation tween whose duration tracks PSI band (12s BEDROCK → 1.2s MELTDOWN), and a constant 0.42s lantern-pulse yoyo
- subscribes to `prefers-reduced-motion`: pauses the parent timeline AND aims the beam at the largest harbour, freezing the scene in a deliberate composition rather than a random pose

The data mapping is explicit:

- lighthouse beam color → PSI band (`PSI_HEX_COLORS`)
- lighthouse beam sweep duration → PSI band (`PSI_SWEEP_DURATION` — added in this rewrite)
- harbour build quality → chain resilience tier (1 = stone seawall, 2 = wood pier, 3 = weathered timber)
- harbour footprint size → chain `totalUsd`, log-scaled
- warehouse count per harbour → ceil(`stablecoinCount` / 3), capped at 4
- boat silhouette → `(governance, backing)` tuple → galleon / brigantine / schooner / junk (algorithmic backing overrides to junk)
- boat hull size (S / L) → per-coin supply rank within harbour
- boat pennant color → DEWS threat band per coin (`THREAT_BAND_HEX`)
- water amplitude + foam intensity → DEWS aggregate band
- horizon cohorts → alt-peg cohort silhouettes (renderer-side projection of `buildPegDiversityHero`)

---

## Animation systems

- **Beam sweep:** `gsap.to(frame.beam, { rotationRad: Math.PI * 2, duration, ease: "none", repeat: -1 })`. Duration is updated in-place via `setBeamSweepDuration` whenever PSI band changes; progress is preserved so the beam doesn't snap.
- **Lantern pulse:** `gsap.to(frame.lantern, { alpha: 0.7, duration: 0.42, yoyo: true, repeat: -1 })`. Constant 0.42s heartbeat regardless of band — the keeper's pulse stays steady even in storms.
- **Parallax breath:** `ctx.translate(sin(t·0.05)·8, cos(t·0.04)·4)`. ~3-min cycle; the whole scene drifts gently. Locked at zero under reduced-motion.
- **Water:** 16 horizontal scanlines, each displaced by the sum of three sines (swell + chop + ripple) scaled by `frame.scene.sea.amplitudePx`. Foam intensity at the shoreline tracks amplitude even when motion is paused.
- **Idle bob:** boats oscillate ±1px on Y at ~1Hz with hash-derived per-coin phase so they never sync up.

---

## Accessibility

- `<canvas>` is `aria-hidden="true"`.
- A sr-only `<dl>` + nested `<ol>` ledger enumerates every visual encoding: beam state, sea state, every harbour with coin count and supply, every boat with classification and hull size, alt-peg cohorts.
- An HTML overlay layer renders one `<button>` per harbour, positioned over the canvas; `pointer-events: none` on the overlay container plus `pointer-events: auto` on the buttons preserves canvas hit-testing.
- All animation systems pause under `prefers-reduced-motion: reduce`. Frozen pose: beam aimed at largest harbour, water foam intensity preserved, idle bobs stopped.

---

## Visual regression

`tests/visual/lighthouse.spec.ts` loads `/lighthouse/` under `prefers-reduced-motion: reduce`, waits 800ms for the scene-application effect and lamp-population RAF deferral to settle, and snapshots the canvas. Baseline at `tests/visual/lighthouse.spec.ts-snapshots/lighthouse-reduced-linux.png`. `maxDiffPixelRatio: 0.02`. Run via `npm run test:visual`.

---

## Palette discipline

`src/app/lighthouse/systems/palette.ts` exports a 25-color anchor palette (`HARBOR_PALETTE`). Every hex literal under `src/app/lighthouse/` (excluding test files and `__fixtures__/`) must be a value in that palette. `scripts/check-harbor-palette.mjs` enforces this — run via `npm run check:harbor-palette`.

---

## Update Rules

Update this file when any of the following change:

- `/lighthouse/` route shell, layout, or metadata
- Canvas mount, RAF loop, or GSAP timeline structure
- Layer stack ordering or new layer additions
- Data mapping (palette assignments, sprite encodings, harbour composition)
- Reduced-motion behaviour or freeze composition
- Visual regression baseline or `maxDiffPixelRatio`

Related docs to check in the same change:

- [architecture.md](./architecture.md)
- [README.md](./README.md)
- [retrospective](../agents/retrospectives/2026-04-25-lighthouse-isometric-harbor.md)
