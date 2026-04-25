# Lighthouse Atmosphere Review — 2026-04-25

**Branch:** `feat/lighthouse-isometric-harbor`
**Scope:** opinionated visual polish on the Canvas 2D harbor scene (atmosphere, lighting, density). No code changes — proposals only.
**Captures (1920×1080 viewport):**
- `agents/screenshots/lighthouse-atmos-frame-0.png` — early frame, beam mid-sweep, full sky/water/lighthouse visible
- `agents/screenshots/lighthouse-atmos-frame-1.png` — beam moved (sweep working)
- `agents/screenshots/lighthouse-atmos-frame-2.png` — beam pointing east; tower clearly small
- `agents/screenshots/lighthouse-atmos-frame-3.png` — captures the dataset error toast occluding sky (static export has no API; harbours are empty)
- `agents/screenshots/lighthouse-atmos-reduced.png` — `prefers-reduced-motion: reduce`, beam frozen pointing right; visually almost indistinguishable from live (no frozen-state polish)

> Important caveat: under static export, `chains` data is unavailable, so `scene.harbors = []`. That means no islands, no docks, no boats, no warehouse lamps in any of these screenshots. The shoreline foam line, scanlines, sky bands, moon, stars, and the lighthouse beam are real renders; everything harbour-side is moot until production data loads.

---

## Where it lands today vs. where it should land

Today the scene reads as **a logo on top of a stripey gradient.** The lighthouse is small (~30 CSS px wide), the beam is disproportionately oversized (200 px) and untextured, the water is a 16-row banded pattern that scans as "scanlines" rather than "ocean", the moon is a flat circle parked top-left with no relationship to the water, and the sky's eight bands are so close in luminance they look like one flat blue field with two visible seams (one mid-canvas, one near the horizon). There is no glitter, no rain, no mist, no silhouettes, no gulls. Reduced-motion looks identical to live — no signal to the eye that the world has gone still.

It should land at **"a small painted nightscape that is busy with implied life."** Octopath/Sea of Stars get there with three things this scene currently lacks: (a) clustered, varied small lights (lamps, candles, lanterns) doing different things at different speeds; (b) a strong horizon — silhouettes, haze gradient, bottom vignette — that frames the staged content in the middle band; (c) a moon-water relationship (glitter column, ripple highlights). All three are achievable in 2D Canvas without breaking the 25-color palette or pushing the layer stack past ~15 ms/frame.

---

## Priority-ranked enhancements

### P0 — visible-immediately wins (ship together, ~150 LOC)

#### 1. Density-scaled stars (item 1)
- **File:** `src/app/lighthouse/layers/sky-layer.ts`, function `ensureStars`
- **State today:** fixed `for (let i = 0; i < 70; i++)`. At 1920×1080 the upper 55% of canvas is ~1,140,000 px². 70 stars = 1 per ~16,300 px². Reads as sparse.
- **Gap:** dense night skies want ~1 star per 2,500–4,000 px², a 4–6× increase. Plus tiered brightness (1 px dim, 1 px medium, 2 px hot) to stop the field looking uniform.
- **Recommendation:** scale count to canvas area, add three intensity tiers, add a lazy twinkle on ~10% of them.
- **Before:**
  ```ts
  for (let i = 0; i < 70; i++) {
    stars.push({ x, y, alpha: 0.5 + rng() * 0.5 });
  }
  ```
- **After:**
  ```ts
  const starCount = Math.floor((w * h * 0.55) / 3500); // ~180 at 1920x1080
  for (let i = 0; i < starCount; i++) {
    const tier = rng();
    const size = tier > 0.95 ? 2 : 1;          // 5% hero stars
    const baseAlpha = tier > 0.7 ? 0.85 : 0.45 + rng() * 0.3;
    const twinkle = rng() < 0.12;              // ~12% twinkle
    stars.push({ x, y, size, baseAlpha, twinkle, phase: rng() * 6.28 });
  }
  ```
  In `draw`, `const a = s.twinkle ? s.baseAlpha * (0.6 + 0.4 * Math.sin(t * 1.5 + s.phase)) : s.baseAlpha;`
- **Palette:** `moonlight` (existing).
- **LOC impact:** +18.

#### 2. Moonpath glitter column (item 2)
- **File:** new helper inside `src/app/lighthouse/layers/water-layer.ts`, drawn after the scanlines, before foam.
- **State today:** missing entirely. Moon at `(0.18w, 0.16h)` casts no path on the water.
- **Gap:** breaks the moon-water relationship. This is the single biggest "this is a sea, not a wallpaper" upgrade.
- **Recommendation:** generate ~16 single-pixel `moonlight` dots in a column directly below the moon's x-coordinate, scattered between `y = waterTop + 4` and `y = waterTop + 80`. Animate alpha sinusoidally against `frame.t` so they shimmer. Width of column ~14 px so they spread laterally.
- **Pseudocode added to water-layer:**
  ```ts
  const mx = Math.floor(frame.width * 0.18);
  const moonpath = ensureMoonpath(mx, y0); // memoized RNG-seeded array of 16 {dx, dy, phase}
  ctx.fillStyle = HARBOR_PALETTE.moonlight;
  for (const g of moonpath) {
    const a = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.8 + g.phase));
    ctx.globalAlpha = a;
    ctx.fillRect(mx + g.dx, y0 + g.dy, 1, 1);
  }
  ctx.globalAlpha = 1;
  ```
  Gate behind `!frame.reducedMotion` for the sinusoid; in reduced motion render at static `0.7` alpha.
- **Palette:** `moonlight`.
- **LOC impact:** +22.

#### 3. Bottom vignette + horizon haze strip (item 8)
- **File:** new layer module `src/app/lighthouse/layers/vignette-layer.ts`, registered LAST in the layer stack in `harbor-scene-client.tsx` (after lighthouse).
- **State today:** missing entirely. Canvas reads "edge-to-edge flat" with no compositional frame.
- **Gap:** removes the "screensaver" feeling immediately. Veils everything subtly.
- **Recommendation:** two short gradient passes.
- **Pseudocode:**
  ```ts
  draw(ctx, frame) {
    // Horizon haze — 8px-tall fog_pale strip at waterline, fading both ways
    const y0 = Math.floor(frame.height * 0.45);
    const haze = ctx.createLinearGradient(0, y0 - 4, 0, y0 + 4);
    haze.addColorStop(0,   "rgba(90,112,153,0)");
    haze.addColorStop(0.5, "rgba(90,112,153,0.35)"); // fog_pale @ 35%
    haze.addColorStop(1,   "rgba(90,112,153,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, y0 - 4, frame.width, 8);

    // Bottom vignette — 24px deep_sea_2 fade up from bottom
    const v = ctx.createLinearGradient(0, frame.height - 24, 0, frame.height);
    v.addColorStop(0, "rgba(10,14,29,0)");
    v.addColorStop(1, HARBOR_PALETTE.deep_sea_2);
    ctx.fillStyle = v;
    ctx.fillRect(0, frame.height - 24, frame.width, 24);
  }
  ```
  Note: the two `rgba(...)` literals are derivations of `fog_pale` (#5a7099) and `deep_sea_2` (#0a0e1d). Add a `paletteRgba(key, alpha)` helper in `palette.ts` so the linter still passes (`check:harbor-palette`).
- **Palette:** `fog_pale`, `deep_sea_2`.
- **LOC impact:** +28 (new file + helper + registration in harbor-scene-client.tsx).

#### 4. Beam-on-water brightening (item 3)
- **File:** new short layer `src/app/lighthouse/layers/beam-water-layer.ts`, registered AFTER `water` and BEFORE `harbors` (so harbours and lighthouse paint on top).
- **State today:** beam is a flat translucent green triangle drawn on top of everything in `lighthouse-sprite.ts`. No interaction with the water.
- **Gap:** the beam reads as "decal on canvas" rather than "light hitting waves." This is the polish that distinguishes Stardew/Sea-of-Stars night scenes.
- **Recommendation:** render an additive lighter scanline overlay where the beam projects. Cheap version: the beam already rotates around the lighthouse anchor — when its angle points at the water (i.e., y-component of the beam direction is positive enough that the beam crosses the horizon), paint a brightened water rectangle of width ~140 px at the beam's projected ground intersection.
- **Pseudocode:**
  ```ts
  draw(ctx, frame) {
    const a = frame.beam;
    const ang = a.rotationRad;
    const dirY = Math.sin(ang); // beam pointing down/forward when sin > 0
    if (dirY <= 0.15) return;   // beam aimed at sky — no water lighting
    const { x: lx, y: ly } = lighthouseAnchor; // injected via setAnchor or read from frame.scene
    const reach = 200; // matches BEAM_LEN
    const ix = lx + Math.cos(ang) * reach;
    const iy = ly + Math.sin(ang) * reach;
    const w = 140, h = 6;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.18 * dirY;
    ctx.fillStyle = a.colorHex; // beam color tracks PSI band (green/yellow/red)
    ctx.fillRect(ix - w/2, iy - h/2, w, h);
    ctx.restore();
  }
  ```
  Then in `lighthouse-sprite.ts` lower the beam-triangle alpha from 0.55 to ~0.42 so it doesn't double-up.
- **Palette:** beam color is data-driven from `PSI_HEX_COLORS` (allowed — already used by `frame.beam.colorHex`).
- **LOC impact:** +30 (new file + anchor passing + minor alpha tweak in lighthouse-sprite).

---

### P1 — second-tier polish (ship after P0 lands, ~120 LOC)

#### 5. Distant horizon silhouettes (item 5)
- **File:** new layer `src/app/lighthouse/layers/horizon-layer.ts`. Register between `water` and `harbors`.
- **State today:** `scene.horizon.cohorts` is computed in `scene-data.ts` (lines 108–117) but never rendered. There is no horizon-layer module.
- **Gap:** the alt-peg cohort hero from the original critique is fully wired data-side and silently dropped in render. Free win.
- **Recommendation:** for each cohort, paint a tiny `fog_blue` silhouette (~12 px tall trapezoid or jagged-top island shape) along `y ≈ y0 - 6`, distributed across `x ∈ [width * 0.35, width * 0.95]` (avoid colliding with moon at 0.18w). Above each silhouette paint a 3 px pennant in the cohort's `PEG_CHART_COLORS` hex. Sizes scaled by `coinCount`: more coins = wider silhouette.
- **Palette:** `fog_blue` for silhouettes; pennants from `PEG_CHART_COLORS` (data-driven, consistent with how beam color is sourced).
- **Notes:** keep silhouettes painted BEFORE foreground harbours so harbours occlude them naturally. Sort by `coinCount` desc and lay out left→right with a jitter from `mulberry32(0xdeadbeef)` for stable placement across frames.
- **LOC impact:** +50.

#### 6. Lens-flash on the lantern (item 6)
- **File:** `src/app/lighthouse/sprites/lighthouse-sprite.ts`, end of `drawLighthouse`.
- **State today:** lantern is two concentric `arc()` halos with steady alpha tweened by GSAP.
- **Gap:** no "the front pane just caught the light" beat. Octopath uses this constantly.
- **Recommendation:** the beam tween already exposes `rotationRad`. Trigger a 0.4 s alpha pulse on a 2 px white square positioned on the front Fresnel pane each time `rotationRad` crosses a multiple of `2π`. Cheapest implementation: track `lastRotation` in the lighthouse-layer module, fire `flashUntil = now + 0.4` when `Math.floor(rotationRad / (2π)) > lastIndex`, then in the sprite render a `foam_white` 2×2 px at `(ax, lanternTop + 4)` with alpha `(flashUntil - now) / 0.4`.
- **Palette:** `foam_white` (closest the locked palette has to "white-hot").
- **LOC impact:** +18.

#### 7. Living-window flicker variation (item 10)
- **File:** `src/app/lighthouse/sprites/harbor-island-sprite.ts`, the `if (i % 2 === 0) { ... lit window ... }` block.
- **State today:** static painted yellow window on alternating warehouses. No flicker.
- **Gap:** lamps flicker (lamp-layer is fine), but warehouse windows are completely static — they read as "decal", not "lit."
- **Recommendation:** lift this paint into the `lampLayer` instead of the harbour sprite (so it picks up the existing flicker pipeline). Add lit-window positions to `HarborIslandResult.lampPositions` with a flag `isWindow: true` — render in lamp-layer as 3×2 rect (instead of arc + hot pixel) using `lantern_glow` with the same flicker formula but a slower phase rate (`* 1.5` instead of `* 4`).
- **Palette:** `lantern_glow`.
- **LOC impact:** +25.

---

### P2 — atmospheric depth (queue, ~200 LOC)

#### 8. Storm pass (item 7) — opt-in, gated on `frame.scene.sea.highestBand >= "WARNING"`
- **Files:** new `src/app/lighthouse/layers/storm-layer.ts` (register between `water` and `harbors` so islands/lighthouse paint over the rain).
- **Why P2:** today this only fires when at least one tracked stablecoin is in WARNING/DANGER, which is rare and dramatic. Worth doing right.
- **Recommendation:** three discrete effects, all gated on `highestBand`:
  - *Rain particles*: 80–120 short diagonal `fog_pale` line segments falling at ~400 px/s, recycled at the bottom. Density scales with band (WARNING=80, DANGER=140).
  - *Lightning flash*: every 6–12 s, fill the entire canvas with `foam_white` at 0.25 alpha for 80 ms, then `bloodmoon_red` at 0.08 alpha for 200 ms (afterglow).
  - *White-cap dither*: in DANGER only, scatter ~30 single-pixel `foam_white` dots randomly across the wave rows each frame (recycled from a pool to keep allocation flat).
- **Palette:** `fog_pale`, `foam_white`, `bloodmoon_red`.
- **LOC impact:** +100. Gate behind `if (band === "CALM" || band === "WATCH" || band === "ALERT") return;` for cheap no-op.

#### 9. Gulls (item 9) — recommend SKIP for Phase 5; queue for Phase 6
- **Why skip:** the silhouette/haze/glitter additions already crowd the upper canvas with implied life. A gull is high-LOC for marginal payoff at this scale (the lighthouse is already small at 1080p; a gull would be 6×4 px and unreadable). If the user ever ships a "zoomed harbor" detail view, gulls land naturally there.

#### 10. Shoreline foam at islands (item 4) — defer until harbours render in production
- **Why defer:** in the static-export captures islands are off-screen because the chains API is unavailable. In the live deployed product, harbour islands DO render, but the shoreline foam pixel scatter belongs in `harbor-island-sprite.ts` (after the diamond top, before the dock pier) — about 12 single-pixel `foam_white` dots along the diamond's perimeter, animated by `Math.sin(frame.t + i)`. Don't ship until verifying live coverage with real harbour data, otherwise the only foam visible is decoration on islands that load occasionally.
- **LOC impact:** +20 if/when adopted.

---

## Summary of additions

| Priority | Item | New file? | LOC |
|---|---|---|---|
| P0 | Star density tiers | no — sky-layer.ts | +18 |
| P0 | Moonpath glitter | no — water-layer.ts | +22 |
| P0 | Vignette + horizon haze | yes — vignette-layer.ts | +28 |
| P0 | Beam-on-water | yes — beam-water-layer.ts | +30 |
| P1 | Horizon silhouettes | yes — horizon-layer.ts | +50 |
| P1 | Lantern lens flash | no — lighthouse-sprite.ts | +18 |
| P1 | Window flicker | harbor-island-sprite.ts + lamp-layer.ts | +25 |
| P2 | Storm pass | yes — storm-layer.ts | +100 |
| skip/defer | Gulls, island foam | — | — |

**Total P0+P1 impact:** ~190 LOC across 4 new files and 4 edits. All within the locked 25-color palette (`fog_pale`, `moonlight`, `foam_white`, `lantern_glow`, `fog_blue`, `deep_sea_2`, plus existing data-driven beam/PSI/peg colors).

## Final note on the reduced-motion variant

`agents/screenshots/lighthouse-atmos-reduced.png` shows that reduced-motion currently freezes the beam pointing east but otherwise looks the same as live. With P0 changes, reduced-motion's static glitter/twinkle should hold at fixed phases (use `frame.t = 0` consistently), the vignette and haze still apply, the lens flash never fires. That keeps the still image readable as "a frozen moment in the same world", not "a different rendering path."
