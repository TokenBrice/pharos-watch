# Lighthouse Isometric Harbor — Handoff

**Date:** 2026-04-25
**Owner left:** Claude (Opus 4.7) orchestrator session
**Branch state:** `feat/lighthouse-isometric-harbor` is **merged into local `main`** at HEAD `0c75750c`. Not pushed to origin yet.

This document is the entry point for the next agent picking up the lighthouse work. Read this first; do not re-read the full design spec or plan unless you need the details.

---

## TL;DR

`/lighthouse/` is now a Canvas 2D pixel-art harbor scene. Pharos is the lighthouse, chains are harbours arranged in a ring around it, stablecoins are boats moored at each dock, PSI drives the beam color and sweep speed, DEWS drives the sea state. Six phases shipped (0 spike, 1 foundations, 2 canvas+sky+water+lamps, 3 lighthouse+boats, 4 harbours+live data, 5 visual regression+docs, 6 visual enhancements).

The render pipeline is healthy: 84 vitest tests pass, lint/typecheck/build/SEO/palette-guard/hotspot-ratchet all green, full merge gate passes (`npm run test:merge-gate`).

The single most important thing you need to know: **the static-export server cannot authenticate to the production API**, so when you load `/lighthouse/` against a local build the harbours and boats render empty (sky, water, lighthouse, beam still appear). To see harbours visible, run `npm run dev` (which talks to the live API), or set up Playwright route mocking against the existing fixtures. Don't be surprised by the empty-sea baseline screenshot.

---

## Where to start

1. **Read the retrospective** at `agents/retrospectives/2026-04-25-lighthouse-isometric-harbor.md` for what shipped and the load-bearing decisions.
2. **Read the plan** at `docs/superpowers/plans/2026-04-25-lighthouse-isometric-harbor.md` only if you need the full task list / architecture rationale.
3. **Read the route contract** at `docs/lighthouse-page.md` for the public contract of `/lighthouse/`.
4. **Read the three visual reviews** at `agents/screenshots/lighthouse-review-{layout,atmosphere,sprites}.md` for what was diagnosed before Phase 6 — most P0/P1 items are now addressed; the P2 items in those docs are still queued.
5. **Look at the post-Phase-6 screenshot** at `agents/screenshots/lighthouse-after-phase6-1080.png`.

---

## File map

```
src/app/lighthouse/
├── page.tsx                           Server Component, SEO/metadata
├── client.tsx                         Hooks + buildSceneData + canvas + ledger
├── harbor-scene-client.tsx            Canvas mount, RAF loop, layer stack
├── harbor-scene.css                   Canvas sizing + image-rendering: pixelated
├── lighthouse-a11y-ledger.tsx         sr-only data ledger (replaces both legacy ledgers)
├── layers/
│   ├── sky-layer.ts                   Gradient bands + tiered stars + moon
│   ├── water-layer.ts                 3-frequency scanlines + moonpath glitter + foam
│   ├── beam-water-layer.ts            Additive bright spot at beam ground intersection
│   ├── horizon-layer.ts               Alt-peg cohort silhouettes with pennants
│   ├── lamp-layer.ts                  Flickering point-light halos (warm/cold)
│   ├── harbor-layer.ts                HARBOR_RING_TILES (8 slots) + per-frame harbour paint
│   ├── boat-layer.ts                  id-stable Map of moored boats with idle bob
│   ├── lighthouse-layer.ts            Wraps drawLighthouse with anchor mutator
│   ├── vignette-layer.ts              Bottom vignette + horizon haze (LAST in stack)
│   └── ui-overlay.tsx                 HTML buttons over the canvas for keyboard nav
├── sprites/
│   ├── lighthouse-sprite.ts           drawLighthouse + LIGHTHOUSE_GEOM (192px tall)
│   ├── boat-sprite.ts                 drawBoat (4 styles, 2 sizes, BOAT_SCALE=2)
│   └── harbor-island-sprite.ts        drawHarborIsland (tier 1 ramparts, tier 3 broken planks)
├── systems/
│   ├── palette.ts                     HARBOR_PALETTE (25 colors) + paletteRgba helper
│   ├── isometric.ts                   worldToScreen + depthKey
│   ├── scene-data.ts                  buildSceneData adapter (hooks → SceneData)
│   ├── scene-render.ts                FrameState + DrawableLayer types
│   ├── classification-to-boat.ts      (governance, backing) → BoatStyle
│   ├── reduced-motion.ts              observeReducedMotion(cb)
│   ├── reduced-motion-freeze.ts       Aim beam at largest harbour
│   ├── timeline-registry.ts           GSAP parent timeline owner
│   ├── animation.ts                   startBeamSweep, startLanternPulse, setBeamSweepDuration
│   ├── patrol.ts                      Bezier path generator (NOT yet wired into a layer)
│   └── rng.ts                         mulberry32
└── __fixtures__/
    └── scene-data.ts                  Test fixtures + fixtureMetaById registry

tests/visual/
└── lighthouse.spec.ts                 Playwright reduced-motion baseline

scripts/
├── check-harbor-palette.mjs           Hex-literal lint guard
└── spike-pixi-csp-probe.mjs           Phase 0 probe (kept for re-running if Pixi v8 fixes CSP)

docs/
├── lighthouse-page.md                 Route contract (current — Canvas 2D version)
├── superpowers/audits/2026-04-25-pixi-v8-csp.md   Phase 0 NO-GO record
├── superpowers/plans/2026-04-25-lighthouse-isometric-harbor.md  Implementation plan
└── superpowers/specs/2026-04-25-lighthouse-2-isometric-harbor-design.md  Source design

agents/
├── retrospectives/2026-04-25-lighthouse-isometric-harbor.md  What shipped
├── screenshots/lighthouse-review-*.md     Three pre-Phase-6 review docs
├── screenshots/lighthouse-after-phase6-*.png  Post-implementation captures
└── handoffs/2026-04-25-lighthouse-isometric-harbor.md  This file
```

---

## Architecture in 90 seconds

- **Canvas 2D, not WebGL.** Phase 0 (`audits/2026-04-25-pixi-v8-csp.md`) confirmed PixiJS v8.18 throws `_unsafeEvalCheck` under our CSP (`public/_headers`'s `script-src 'self' 'unsafe-inline'`). The whole rendering pipeline is plain `<canvas>` + 2D context + a single `requestAnimationFrame` loop.

- **`FrameState` contract.** Every layer is a function `(ctx, frame) => void`. The orchestrator (`harbor-scene-client.tsx`) owns the canvas, sizes it DPR-aware, builds the FrameState, runs the RAF loop, and calls each layer's `draw()` in painter's order. Layers don't know about React, hooks, or each other.

- **GSAP value tweens.** GSAP animates JS values (`frame.beam.rotationRad`, `frame.lantern.alpha`, the upcoming patrol-boat positions). The render layers READ those values per frame and paint accordingly. No DOM animations, no Pixi tickers — `parentTimeline.pause()` halts every animation atomically when reduced-motion fires.

- **Painter's order (locked):**
  ```
  sky → water → beam-water → horizon → harbours → boats → lamps → lighthouse → vignette
  ```
  Vignette is last so the entire scene gets the soft bottom fade + horizon haze on top.

- **Palette discipline.** Every hex literal under `src/app/lighthouse/` must come from `HARBOR_PALETTE` (25 colors). Enforced by `npm run check:harbor-palette`. Helpers: `hexToInt(hex)` for bit math, `paletteOrThrow(key)` for runtime lookups, `paletteRgba(key, alpha)` for gradients that need alpha.

- **Anchor.** Lighthouse anchored at `(width * 0.50, height * 0.78)` via `getLighthouseAnchor(width, height)` in `harbor-scene-client.tsx`. Harbour ring tiles (`HARBOR_RING_TILES` in `layers/harbor-layer.ts`) place harbours NORTH and EAST/WEST of this anchor, never below.

- **Data flow.** TanStack Query hooks → `buildSceneData()` → `SceneData` object → `client.tsx` passes scene to `<HarborSceneClient>` → mount effect builds layers and stashes refs; scene-update effect (`useEffect([scene])`) re-syncs harbours, boats, beam color/duration, lamps without remounting. Cron is 15 min for chains; updates land smoothly on the running canvas.

- **Reduced-motion freeze composition.** Pause GSAP, freeze water displacement at 0, freeze idle bobs, AND aim the lighthouse beam at the largest harbour (`pickLargestHarborPlacement`). The frozen frame is a deliberate composition, not a random one.

---

## Known limits and open issues

### 1. Visual regression baseline shows empty harbours

`tests/visual/lighthouse.spec.ts-snapshots/lighthouse-reduced-linux.png` was captured against the local static-export server, which cannot authenticate to `https://api.pharos.watch`. So the baseline shows sky + lighthouse + beam but no harbours, no boats, no lamps.

**Practical effect:** the test catches regressions in the data-independent layers (sky/water/beam/lighthouse) but NOT in the harbour or boat rendering. Regressions to harbour layout, boat sprites, lamp positions, etc. will pass the test.

**Fix path:** intercept `/api/*` calls via Playwright `page.route` and serve the existing `__fixtures__/scene-data.ts` payloads. This unblocks full-coverage visual regression. The fixture has `fixtureMetaById` ready; you'd serve `fixtureChains`, `fixtureStability`, `fixtureStress`, `fixtureStablecoins` as JSON responses to the four API endpoints.

### 2. Sailing-boat patrol is not wired

`src/app/lighthouse/systems/patrol.ts` exists with `generatePatrolPath(home, beacon, seed)` returning a 4-point Bezier waypoint array. No layer consumes it. The intent: the top-volume coin per chain leaves its harbour, sails toward the lighthouse, returns. Adds motion variety beyond beam sweep + idle bob.

**To wire:** new `layers/patrol-layer.ts` similar to `boat-layer.ts` but with one `Map<coinId, PatrolState>` keyed by the top-volume coin per harbour. Lerp position along the path using `frame.t` modulo a duration. Use the existing `drawBoat` with `auraHex: null` and a `style: "schooner"` to keep it visually distinct from moored boats.

### 3. DEX dock cranes — queued

The data exists in `PROTOCOL_HEX` / `PROTOCOL_NAMES` but no canvas rendering. Per the design review, each chain harbour with notable DEX presence should grow a small crane sprite. **Implementation hint:** extend `drawHarborIsland` to take a `dexCount` arg (computed in `scene-data.ts` from the live DEX liquidity feed) and paint a 6×24 crane sprite atop one warehouse when count > 0.

### 4. Yield-protocol mini-lighthouses — queued

Per the design review, chains with yield-bearing stablecoin deployments get a small secondary lighthouse on their harbour island. Data: `chainsWithYield(stablecoins)` derivation already exists conceptually (any coin with `yieldConfig` in its meta). Render: 12px-tall miniature lighthouse on the side of the harbour diamond.

### 5. Bridge route animation between chains — blocked on data

No bridge-volume feed exists in Pharos today. Don't implement until/unless `worker/src/api/bridge-flows.ts` (or similar) ships. The Bezier patrol generator in `patrol.ts` is the rendering primitive when the data lands.

### 6. Storm pass for DEWS DANGER — queued

Atmosphere review prescribed rain particles + lightning flashes + white-cap dither when DEWS aggregate band is WARNING or DANGER. Currently only wave amplitude responds. Spec at `agents/screenshots/lighthouse-review-atmosphere.md` (P2 #8).

### 7. Mobile layout breaks

The current `HARBOR_RING_TILES` spread is ±256 px — fits comfortably on desktop and laptop, but on a 414 px mobile canvas the leftmost/rightmost harbours land partially off-screen.

**Fix path:** `harbor-layer.ts:syncHarbors` accepts a `placementScale` arg. The orchestrator reads `frame.width` and passes `0.5` for `< 768 px`, `1.0` otherwise. Multiplies `screen.x` and `screen.y` before adding to origin.

### 8. PixelLab MCP sprite atlas — Phase 6+ polish

Replace code-drawn sprites with PixelLab-generated PNGs. The locked palette + 2x scale + integer pixel rules constrain the prompts. Expect a 30-50% visual quality improvement at the cost of a sprite atlas to maintain. See "Phase 2 — PixelLab MCP assets" in the spec.

### 9. Hotspot ratchet entry for `worker/src/api/mint-burn-flows.ts`

Phase 5's `e5c0f0cf` added a waiver entry for this file because removing the lighthouse legacy code shifted the file-lines ranking. The mint-burn endpoint has unrelated tech debt that should be addressed in the worker-API decomposition lane. Tracker: `agents/tasks/2026-04-22-frontend-hotspot-follow-up.md`.

---

## Recommended next tasks (prioritized)

If you have a session to spend on this work, pick from the top:

| # | Task | Effort | Payoff | Files |
|---|---|---|---|---|
| 1 | Playwright route-mock for the API so the visual regression baseline shows full harbours | 2-3 hours | Restores visual regression coverage to the harbour/boat/lamp layers | `tests/visual/lighthouse.spec.ts`, `playwright.config.ts` |
| 2 | Wire sailing-boat patrol — top-volume coin per harbour traces a Bezier route | 4-6 hours | Adds the "living harbour" motion the design called for | new `layers/patrol-layer.ts`, modify `harbor-scene-client.tsx` |
| 3 | Mobile placement scale | 1-2 hours | Mobile users see all 8 harbours instead of clipped 2 | `layers/harbor-layer.ts` (add `placementScale` arg) |
| 4 | Storm pass — rain + lightning when DEWS ≥ WARNING | 3-4 hours | Conveys system stress dramatically; rare but high-impact event | new `layers/storm-layer.ts` |
| 5 | DEX dock cranes per harbour | 2-3 hours | Visualises the DEX presence dimension that's currently untapped | `sprites/harbor-island-sprite.ts`, `systems/scene-data.ts` |
| 6 | Push branch to origin and open PR | <1 hour | Get the work in front of users | git/gh |
| 7 | PixelLab sprite atlas for the 4 boat styles + lighthouse | 1-2 days | Distinctive visual identity beyond what code-drawn shapes can deliver | new `harbor_assets.json` manifest, sprite swaps in `sprites/*` |

---

## How to run things

```bash
# Dev — talks to live api.pharos.watch (real harbours visible)
npm run dev
# then open http://localhost:3000/lighthouse/

# Build the static export (regenerates out/lighthouse/index.html)
npm run build

# Serve the static export — note: cannot auth to /api/*, harbours empty
npx tsx scripts/serve-static-export.mjs
# then open http://localhost:4173/lighthouse/

# Visual regression
npm run test:visual                                     # passes against current baseline
npx playwright test tests/visual --update-snapshots     # regenerate baseline

# Unit tests (lighthouse-only — fast)
npx vitest run src/app/lighthouse shared/lib/psi-colors.test.ts

# Lint + typecheck + palette guard
npm run lint
npm run typecheck
npm run check:harbor-palette

# Pre-push merge gate (full validation)
npm run test:merge-gate
```

### Screenshot harness pattern (used by review agents)

```bash
npx tsx scripts/serve-static-export.mjs &
SERVER_PID=$!
sleep 2
node -e "(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  const p = await ctx.newPage();
  await p.goto('http://localhost:4173/lighthouse/', { waitUntil: 'load' });
  await p.waitForSelector('[data-testid=harbor-scene] canvas');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'agents/screenshots/<your-name>.png' });
  await b.close();
})();"
kill $SERVER_PID 2>/dev/null
```

For reduced-motion screenshots, add `reducedMotion: 'reduce'` to the context options. For API-mocked screenshots, intercept `/api/*` via `page.route(...)` before `goto`.

---

## Things that will trip you up

1. **Adding a hex literal under `src/app/lighthouse/`** without going through the palette will fail `npm run check:harbor-palette`. Either add the color to `HARBOR_PALETTE` (and rerun the test for `25 entries` so it bumps to 26), or use `paletteRgba(key, alpha)` if you need alpha.

2. **Anchor math duplicated.** If you change the lighthouse anchor, you must change `getLighthouseAnchor()` in `harbor-scene-client.tsx`. The mount effect AND the scene-update effect both call it. There's only one helper now (Phase 6 consolidation), but if you split anchor math per-effect, you'll get one-frame drift.

3. **Painter's order is load-bearing.** `vignette` MUST stay last (or the bottom fade ends up under the lighthouse). `lighthouse` after `lamps` (or the beam reads under the lamp halos). `harbours` after `horizon` (or near silhouettes paint over the foreground islands).

4. **`scene-data.ts` reads flags from `ACTIVE_META_BY_ID`, not the API.** The `metaById?` parameter to `buildSceneData` defaults to the registry. Tests must pass `metaById: fixtureMetaById` (the fixture's bare coin IDs are not in the production registry).

5. **`react-hooks/refs` lint rule.** Don't assign to `ref.current` in the render body. Use a `useEffect` that depends on the prop. The pattern is already established in `harbor-scene-client.tsx`'s top-level effect.

6. **Next 16 + `dynamic(ssr: false)`.** Don't use `{ ssr: false }` on a `dynamic()` import inside a Server Component. The Phase 0 spike caught this. The SSR boundary is `client.tsx`; the canvas import is `import { HarborSceneClient } from "./harbor-scene-client"` (NOT dynamic).

7. **The reduced-motion freeze aims at the largest harbour ON FIRST FREEZE only.** If a scene update changes "largest harbour" while reduced-motion is already active, the beam doesn't re-aim (re-aiming during reduced-motion would be motion). Documented behaviour, not a bug.

8. **The visual regression test's `maxDiffPixelRatio` is 2%.** Major scene composition changes break the baseline (Phase 6 needed a regen). Minor scene changes (a new star, a slightly different gradient) should fit within 2%. If a small change blows the budget, your change is not as small as you think.

9. **GSAP timeline is paused on reduced-motion via `parent.pause()`.** Tweens added AFTER `parent.pause()` don't auto-pause unless added as children of the parent. The `startBeamSweep`/`startLanternPulse` helpers handle this with `registry.parent.add(tween, 0)`. If you add a new tween that should respect reduced-motion, parent it to the registry the same way.

---

## What you can safely change without re-validating the whole stack

- New layer modules in `layers/`. Add the file, write tests, register it in `harbor-scene-client.tsx`'s painter's order. Don't touch the existing layer ordering unless you have a reason.
- Sprite redesigns in `sprites/`. The pure draw functions can be rewritten freely as long as the export signature stays the same.
- Palette additions. Append to `HARBOR_PALETTE`, update the entry-count test (currently asserts 25), use it in your layer.
- Test fixtures in `__fixtures__/scene-data.ts`. The fixture's coin IDs (`usdt`, `usdc`, `dai`) are bare and intentional — don't switch to suffixed registry IDs without rewriting most of the tests.

## What requires careful coordination

- `FrameState` shape. Every layer reads from it. Adding fields is safe; removing or renaming is not.
- `SceneData` shape. The adapter in `scene-data.ts` and the consumers in every layer know its shape. Changes ripple.
- `HARBOR_RING_TILES`. Change one tile and harbours rearrange visibly. The full table at the top of `harbor-layer.ts` documents the screen-space placements; keep that comment updated.
- The painter's order. Documented in a comment block in `harbor-scene-client.tsx` — keep it accurate or future maintainers will get confused.

---

## Final note

This branch wasn't pushed to origin. If you intend to ship, push and open the PR:

```bash
git push -u origin main   # or work on a fresh feature branch off main
gh pr create --title "feat(lighthouse): isometric pixel-art harbor" --body "$(cat agents/retrospectives/2026-04-25-lighthouse-isometric-harbor.md)"
```

Or revert if you prefer to land via PR from a feature branch:

```bash
# put main back where origin/main is, then push the feature branch
git reset --hard origin/main
git push origin feat/lighthouse-isometric-harbor
gh pr create ...
```

Good luck. The bones are sound — the work that's left is polish and signal density. Keep the palette discipline; it's the load-bearing aesthetic constraint.
