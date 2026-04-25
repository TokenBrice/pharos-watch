# Lighthouse Harbor Scene — Layout/Composition Review

**Date:** 2026-04-25
**Branch:** `feat/lighthouse-isometric-harbor`
**Reviewer scope:** layout, composition, scale, structural visual issues. (No color/mood/animation polish.)

## Live render evidence

Captured at four viewports against the static export served from `out/`:

| File | Captured viewport | Canvas (CSS px) |
|---|---|---|
| `agents/screenshots/lighthouse-review-desktop.png` | 1920×1080 | 1700×756 (sidebar steals 220 px) |
| `agents/screenshots/lighthouse-review-wide.png` | 2400×940 | 2180×658 |
| `agents/screenshots/lighthouse-review-laptop.png` | 1440×900 | 1220×630 |
| `agents/screenshots/lighthouse-review-mobile.png` | 414×896 | 414×627 |

**What every screenshot shows:** a small lighthouse (~50 px tall on screen, ~7 % of canvas height) sitting in a vast, mostly-empty starfield + sea. The user-facing claim that "harbours are off-screen below the canvas" is **fully reproduced**: zero harbours are visible on any of the four captures. The DOM-level inspection of `.harbor-overlay__label` returned an empty array — labels render at HTML positions like `(1085, 1035)` for a canvas only 756 px tall.

The scene reads as a screensaver, not the cinematic lighthouse-and-harbor that was specified.

## Root-cause math (verified)

`worldToScreen` (`src/app/lighthouse/systems/isometric.ts:9-14`) is:
```
screenX = ((tileX - tileY) * 64) / 2 = (tileX - tileY) * 32
screenY = ((tileX + tileY) * 32) / 2 = (tileX + tileY) * 16
```

Lighthouse anchor (`src/app/lighthouse/harbor-scene-client.tsx:72-73` and the duplicate at `:189-190`):
```
originX = round(width  * 0.45)
originY = round(height * 0.65)
```

Every entry in `TRIANGLE_TILES` (`src/app/lighthouse/layers/harbor-layer.ts:6-17`) has `tileX + tileY ≥ 20`. The smallest pair is `(12, 8)` and `(6, 14)` with sum 20 → screenY = +320. The anchor sits at 65 % of canvas height (max ~491 px on the desktop capture); adding 320 lands the harbour at y ≈ 811, which is **55 px below the bottom of the 756 px canvas**. The largest pair `(8, 24)` and `(18, 28)` sum to 32 → screenY = +512, landing 200+ px off-screen.

Full table at four viewports (anchor → harbour center):

```
=== desktop 1700x756  anchor=(765,491) ===
  NE    tile(22,12) -> (1085,1035)  OFF
  SW    tile(8,24)  -> ( 253,1003)  OFF
  E     tile(26,22) -> ( 893,1259)  OFF
  mid1  tile(12,8)  -> ( 893, 811)  OFF (just below)
  mid2  tile(28,8)  -> (1405,1067)  OFF
  mid3  tile(6,14)  -> ( 509, 811)  OFF (just below)
  mid4  tile(30,16) -> (1213,1227)  OFF
  mid5  tile(18,28) -> ( 445,1227)  OFF

=== wide 2180x658,  laptop 1220x630, mobile 414x627  ===
  All slots OFF at every tested viewport (full table in evidence).
```

So: **8/8 tiles are off-screen at all four viewports**. This is a P0 layout defect — the harbour layer paints, but no harbour ever appears within the canvas rect.

A second consequence: water-layer paints water from `y0 = round(height * 0.45)` downward. On desktop that's `y=340`; the lighthouse anchor is at `y=491`. So the lighthouse base sits ~150 px below the waterline (correct), but the entire harbour set is even further south — **deep underwater** by intent of the math.

## Issues

### P0-1 — Harbours land below the canvas

- **Symptom:** No harbour islands visible. Screenshots show an empty sea.
- **Root cause:** `TRIANGLE_TILES` in `src/app/lighthouse/layers/harbor-layer.ts:6-17` has `tileX + tileY` between 20 and 46. With `screenY = (tileX+tileY) * 16`, every harbour ends up 320–736 px below the lighthouse anchor. The anchor itself is at 65 % of canvas height. There is no canvas-size combination where these tiles fit.
- **Fix:** rebuild the tile set so `tileX + tileY` is small or negative — i.e. harbours arc *around and above* the lighthouse instead of marching south on a triangle. A symmetric 8-slot ring with `screenY ∈ [-128, -16]` keeps every harbour within the upper "sea above the foreground" region.

  **Before** (`harbor-layer.ts:6-17`):
  ```ts
  const TRIANGLE_TILES: { tileX: number; tileY: number }[] = [
    { tileX: 22, tileY: 12 }, // NE
    { tileX: 8,  tileY: 24 }, // SW
    { tileX: 26, tileY: 22 }, // E
    { tileX: 12, tileY: 8  },
    { tileX: 28, tileY: 8  },
    { tileX: 6,  tileY: 14 },
    { tileX: 30, tileY: 16 },
    { tileX: 18, tileY: 28 },
  ];
  ```

  **After** (proposed — symmetric ring, all `tileX + tileY` ∈ [-8, -1] so every harbour sits **above** the anchor; spread −256 ≤ screenX ≤ +256):
  ```ts
  // Harbours arrayed in a ring above and around the lighthouse anchor.
  // Every entry has tileX+tileY ≤ -1 so screenY is negative (north of anchor).
  // Spread is symmetric: tileX-tileY ∈ [-8, +8] so screenX ∈ [-256, +256].
  const TRIANGLE_TILES: { tileX: number; tileY: number }[] = [
    { tileX: -7, tileY: -1 }, // NW-far    screen(-192, -128)
    { tileX:  1, tileY: -7 }, // NE-far    screen(+256,  -96)
    { tileX: -6, tileY:  2 }, // W         screen(-256,  -64)
    { tileX:  2, tileY: -6 }, // E         screen(+256,  -64)
    { tileX: -3, tileY: -2 }, // NW-mid    screen( -32,  -80)
    { tileX: -2, tileY: -3 }, // NE-mid    screen( +32,  -80)
    { tileX: -4, tileY:  3 }, // SW-near   screen(-224,  -16)
    { tileX:  3, tileY: -4 }, // SE-near   screen(+224,  -16)
  ];
  ```

  **Tradeoff:** the sort by `worldY` in `harbor-layer.ts:68` still works correctly because painter's-order stays valid for negative Ys. The "isometric triangle" name in the original loses its triangular meaning — it's now a ring; rename the constant to `HARBOR_RING_TILES` for clarity (single-symbol rename in this file only).

- **Priority:** P0 (must-fix to ship).

### P0-2 — Lighthouse anchor leaves an enormous empty sky

- **Symptom:** With harbours below the lighthouse, the anchor at `y = height * 0.65` puts the lighthouse 35 % up from the bottom — but the upper 50 % of the canvas is completely empty (just stars and one moon). Even after fixing P0-1, the anchor's vertical placement matters because the new harbour ring extends 128 px **above** the anchor. We want the anchor low enough that the ring has room above, but high enough that the lighthouse + foreground isn't crammed against the bottom edge.
- **Root cause:** `harbor-scene-client.tsx:72-73` and the duplicate at `:189-190` use `0.45` and `0.65`.
- **Fix:** move the lighthouse anchor down and slightly toward center.

  **Before:** `0.45 * width`, `0.65 * height`
  **After:** `0.50 * width`, `0.78 * height`

  Sanity-check: with the new ring, the topmost harbour (NW-far, screenY = -128) lands at `y = 0.78H - 128`. On a 756 px canvas that's `590 - 128 = 462` — well within the canvas. The lighthouse base (anchored 0.78H = 590) leaves `756 - 590 = 166` px below for foreground/water/foam — comfortable.

  The duplicate constant must be updated in BOTH places (`:72-73` AND `:189-190`); these effects share state and any drift causes a one-frame mis-placement on scene updates. **Recommend extracting into a single helper** `getAnchor(width, height)` in the same file to avoid future drift — that's the only "refactor" worth doing here.

  **Tradeoff:** centering the lighthouse (0.50 instead of 0.45) sacrifices a small asymmetric "rule of thirds" feel but lets the symmetric ring sit symmetrically across the canvas. If the design team wants asymmetry kept, use `0.45 * width` and shift the ring tiles by +1 along `tileX-tileY` (every entry +1 to `tileX`, -1 to `tileY` shifts the whole ring 32 px right).

- **Priority:** P0.

### P0-3 — Lighthouse is tiny on the canvas

- **Symptom:** Sum of `LIGHTHOUSE_GEOM` heights = 12 + 32 + 4 + 18 + 30 = **96 px** total height. On the 756 px desktop canvas that's 12.7 %; on the 658 px wide capture, 14.6 %. The user reads it as "tiny." The design called for the lighthouse to be the dominant vertical element.
- **Root cause:** `src/app/lighthouse/sprites/lighthouse-sprite.ts:3-9` (and all the literal width/height constants in `drawLighthouse`).
- **Fix:** doubling all geometry brings the lighthouse to 192 px tall (~25 % of viewport height) and 48 px wide at the base. This is the cleanest "make it bigger" fix; alternatives like a runtime scale factor add complexity for one-time tuning.

  **Before** (`lighthouse-sprite.ts:3-9`):
  ```ts
  export const LIGHTHOUSE_GEOM = {
    base:    { w: 24, h: 12 },
    shaft:   { w: 18, h: 32 },
    gallery: { w: 22, h: 4  },
    lantern: { w: 16, h: 18 },
    cap:     { w: 18, h: 30 },
  };
  ```

  **After:**
  ```ts
  export const LIGHTHOUSE_GEOM = {
    base:    { w: 48, h: 24 },
    shaft:   { w: 36, h: 64 },
    gallery: { w: 44, h: 8  },
    lantern: { w: 32, h: 36 },
    cap:     { w: 36, h: 60 },
  };
  ```

  The body of `drawLighthouse` (`lighthouse-sprite.ts:30-110`) contains many hard-coded literals (`ax - 12`, `ax - 9`, `ax - 8`, `ax - 7`, the shaft window `for (let y = shaftTop + 6; ...; y += 6)`, the cap polygon, etc.) — these need to be doubled in lockstep, NOT pulled from the GEOM constants. Specifically:

  | Line | Before | After |
  |---|---|---|
  | 39 | `ax - 12, baseTop, 24, ...` | `ax - 24, baseTop, 48, ...` |
  | 41 | `ax - 12, baseTop, 24, 4` | `ax - 24, baseTop, 48, 8` |
  | 45 | `ax - 9, shaftTop, 18, ...` | `ax - 18, shaftTop, 36, ...` |
  | 48 | `y < shaftTop + ...; y += 6` | `y < shaftTop + ...; y += 12` |
  | 49 | `ax - 9, y` to `ax + 9, y` | `ax - 18, y` to `ax + 18, y` |
  | 52-53 | `ax - 1, ..., 2, 3` (windows) | `ax - 2, ..., 4, 6` |
  | 57 | `ax - 11, galleryTop, 22, ...` | `ax - 22, galleryTop, 44, ...` |
  | 61 | `ax - 8, lanternTop, 16, ...` | `ax - 16, lanternTop, 32, ...` |
  | 64 | `ax - 7, ..., 14, 16` | `ax - 14, ..., 28, 32` |
  | 67 | `for (let x = -7; x < 7; x += 4)` | `for (let x = -14; x < 14; x += 8)` |
  | 69-70 | `ax + x + 2, lanternTop + 1` ... `+ 17` | `ax + x + 4, lanternTop + 2` ... `+ 34` |
  | 77-79 | cap polygon `±9` and `±4` | `±18` and `±8` |
  | 83-84 | weathervane `capTop - 12`, `±3` | `capTop - 24`, `±6` |
  | 88 | `lanternTop + Math.floor(LIGHTHOUSE_GEOM.lantern.h / 2)` | (unchanged — derives from GEOM) |
  | 96-97 | `BEAM_LEN, ±BEAM_HALF_SPREAD` | (unchanged: see below) |
  | 106 | `arc(..., 4, ...)` halo | `arc(..., 8, ...)` |
  | 109 | `arc(..., 8, ...)` outer halo | `arc(..., 16, ...)` |

  **`BEAM_LEN` and `BEAM_HALF_SPREAD`** at `:18-19` (200, 50): the beam is meant to read across the harbour scene. With harbours now arranged in a ring of radius ~256 px around the anchor, BEAM_LEN = 200 is a tad short — bump to **300**, and `BEAM_HALF_SPREAD` to **70** to keep the cone proportions identical.

  **Tradeoff:** the ratchets in `agents/visual-snapshots/` may flag because every pixel of the lighthouse moved. That's expected — re-baseline after the design lead approves the new size.

- **Priority:** P0.

### P1-1 — Boat scale relative to the (new) lighthouse

- **Symptom:** Boats are 12–22 px wide. With the **doubled** lighthouse base of 48 px, boats become 25–46 % of base width. That's roughly correct for "small fishing vessel against a stone tower," but the *largest* `L`-size galleon at 22 px would still feel undersized against the new lighthouse. Without the doubling, boats at 22 px were **nearly as wide as the 24 px lighthouse base** — wrong.
- **Root cause:** `src/app/lighthouse/sprites/boat-sprite.ts:4-9`. The `BOAT_DIMENSIONS` table.
- **Fix (assuming P0-3 doubling lands):** scale boats by 1.5× (not 2×) so the visual ratio of "biggest boat ≈ half the lighthouse base" reads cleanly.

  **Before:**
  ```ts
  galleon:    { S: { w: 14, h: 20 }, L: { w: 22, h: 30 } },
  brigantine: { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
  schooner:   { S: { w: 12, h: 16 }, L: { w: 18, h: 24 } },
  junk:       { S: { w: 13, h: 18 }, L: { w: 20, h: 28 } },
  ```

  **After (1.5×):**
  ```ts
  galleon:    { S: { w: 21, h: 30 }, L: { w: 33, h: 45 } },
  brigantine: { S: { w: 20, h: 27 }, L: { w: 30, h: 42 } },
  schooner:   { S: { w: 18, h: 24 }, L: { w: 27, h: 36 } },
  junk:       { S: { w: 20, h: 27 }, L: { w: 30, h: 42 } },
  ```

  The body of `drawBoat` (`:20-128`) uses many hard-coded offsets keyed off `dim.w/2` and `dim.h`, plus literal constants (`-4`, `0`, `4` for masts; `-3`, `+6` for sail rects; `±5` for the junk sail). The mast and sail literals are NOT scaled by `dim`, so they need to be multiplied by 1.5 too — this is non-trivial. **Alternative**: introduce a single `BOAT_SCALE = 1.5` constant and apply it once at the top of `drawBoat` via `ctx.scale`. That's one line of code instead of ~15 literal edits, and is the surgical fix recommended.

  ```ts
  // Before:
  export function drawBoat(ctx, ax, ay, p) {
    const dim = BOAT_DIMENSIONS[p.style][p.size];
    ...

  // After (single-line scale wrapper):
  export const BOAT_SCALE = 1.5;
  export function drawBoat(ctx, ax, ay, p) {
    ctx.save();
    ctx.translate(ax, ay);
    ctx.scale(BOAT_SCALE, BOAT_SCALE);
    const dim = BOAT_DIMENSIONS[p.style][p.size];
    // …existing code, but replace `ax`/`ay` with 0/0 throughout
    ctx.restore();
  }
  ```

  **Tradeoff:** `ctx.scale` defeats `image-rendering: pixelated`'s integer-pixel intent on non-integer `BOAT_SCALE` values. Use **2.0** for clean pixel scaling, or stay at 1.5 and accept slight blur on diagonal lines. **Recommend 2.0** — keeps pixel-art crispness, makes biggest boat (44 px wide) ≈ matches expected proportions against the doubled lighthouse base (48 px). That's actually *too* large; reconsider the lighthouse multiplier or the boat multiplier together.

  **Concrete recommendation:** Lighthouse 2×, Boat 2× — so boats remain at ~half the lighthouse base, as before, but at higher absolute scale. The relative scale is preserved; the absolute scene density goes up.

- **Priority:** P1 (should-fix; depends on P0-3).

### P1-2 — Harbour island footprint vs. lighthouse base

- **Symptom:** Islands are 80–160 px wide (`harbor-island-sprite.ts:19`). Lighthouse base is 24 px wide (96 px tall total). Islands are **3–7× wider than the lighthouse**, which is fine. After P0-3 doubles the lighthouse, islands are 1.7–3.3× wider — still believable as "harbour at scale of a lighthouse base," but the *tallest* harbour structure (warehouse roof at 16 px tall, `:71`) is dwarfed by the 192 px lighthouse. That's actually correct — a single tower should dominate over surrounding warehouses.
- **Root cause:** `src/app/lighthouse/sprites/harbor-island-sprite.ts:19`: `footprintW = 80 + log10(totalUsd/1e6) * 18`.
- **Fix:** none required *if* P0-3 lands. The relative scale is acceptable. If it doesn't land, **shrink** the island footprint to `60 + log10(...) * 14` (max ~120 px) so the lighthouse doesn't get visually overwhelmed by even the smallest harbour.
- **Priority:** P1 (nice-to-have, conditional on P0-3 landing).

### P2-1 — Camera framing / no zoom

- **Symptom:** the canvas is 1700×756 (or larger), but the meaningful scene content sits in a ~600×300 region around the lighthouse. The current rendering shows ~30 % of the canvas as "scene" and ~70 % as background sky/sea.
- **Root cause:** `worldToScreen` uses absolute pixel offsets (TILE_W=64, TILE_H=32) regardless of canvas size. There is no camera zoom / scale factor.
- **Fix:** if the proposed P0 fixes don't make the scene feel full enough, introduce a single `SCENE_SCALE = 1.5` multiplier in `worldToScreen` (i.e. `screenX = (tileX-tileY) * 32 * SCENE_SCALE`). This pushes the harbour ring out from radius ~256 to ~384, which roughly fills the laptop/desktop canvases edge-to-edge.
- **Tradeoff:** breaks `screenToWorld` reciprocally (must multiply by the same factor). Also requires re-checking that mobile (414 px wide) doesn't push harbours off-canvas — at SCENE_SCALE=1.5 with the proposed ring, the rightmost harbour lands at `0.5*414 + 256*1.5 = 207 + 384 = 591`, off-screen by 177 px. **Mobile must use SCENE_SCALE=0.6 or compress to a 4-harbour ring**; that's beyond P0.
- **Priority:** P2 (only after P0-1/P0-2/P0-3 are evaluated; might not be needed).

### P2-2 — Mobile (≤480 px) needs its own ring

- **Symptom:** Even with the proposed P0-1 ring, the 414 px mobile canvas can only fit 2 of 8 harbours within the canvas rect — the ±256 px screen spread overflows a 414 px-wide canvas.
- **Root cause:** isometric tile spread is in absolute pixels; mobile canvas is much narrower.
- **Fix:** in `harbor-layer.ts`'s `syncHarbors`, accept a `placementScale` arg (passed by `harbor-scene-client.tsx` based on `frame.width`); multiply `screen.x` and `screen.y` by it. Use `1` for ≥768 px wide, `0.5` for <768 px. Or — show only the top 4 harbours (largest by total USD) on mobile.
- **Priority:** P2 (mobile is not the primary target per the Phase 0 spec).

## Post-fix sanity table

After applying P0-1 (ring tiles) + P0-2 (anchor → 0.50W, 0.78H), every harbour lands within the canvas at desktop, wide, and laptop. Mobile still needs P2-2.

```
=== desktop 1700x756  anchor=(850,590) ===
  NW-far   tile(-7,-1) screen(-192,-128) -> ( 658, 462)  ON
  NE-far   tile( 1,-7) screen(+256, -96) -> (1106, 494)  ON
  W        tile(-6, 2) screen(-256, -64) -> ( 594, 526)  ON
  E        tile( 2,-6) screen(+256, -64) -> (1106, 526)  ON
  NW-mid   tile(-3,-2) screen( -32, -80) -> ( 818, 510)  ON
  NE-mid   tile(-2,-3) screen( +32, -80) -> ( 882, 510)  ON
  SW-near  tile(-4, 3) screen(-224, -16) -> ( 626, 574)  ON
  SE-near  tile( 3,-4) screen(+224, -16) -> (1074, 574)  ON

=== wide 2180x658  anchor=(1090,513) ===
  NW-far   ( 898, 385)  ON
  NE-far   (1346, 417)  ON
  W        ( 834, 449)  ON
  E        (1346, 449)  ON
  NW-mid   (1058, 433)  ON
  NE-mid   (1122, 433)  ON
  SW-near  ( 866, 497)  ON
  SE-near  (1314, 497)  ON

=== laptop 1220x630  anchor=(610,491) ===
  NW-far   ( 418, 363)  ON
  NE-far   ( 866, 395)  ON
  W        ( 354, 427)  ON
  E        ( 866, 427)  ON
  NW-mid   ( 578, 411)  ON
  NE-mid   ( 642, 411)  ON
  SW-near  ( 386, 475)  ON
  SE-near  ( 834, 475)  ON

=== mobile 414x627  anchor=(207,489) ===
  NW-far   (  15, 361)  OFF (just inside left edge if margin=0)
  NE-far   ( 463, 393)  OFF
  W        ( -49, 425)  OFF
  E        ( 463, 425)  OFF
  NW-mid   ( 175, 409)  ON
  NE-mid   ( 239, 409)  ON
  SW-near  ( -17, 473)  OFF
  SE-near  ( 431, 473)  OFF
```

## Summary of recommended P0 fixes

1. **`src/app/lighthouse/layers/harbor-layer.ts:6-17`** — replace `TRIANGLE_TILES` with the symmetric ring (8 entries with `tileX+tileY ∈ [-8,-1]`).
2. **`src/app/lighthouse/harbor-scene-client.tsx:72-73` and `:189-190`** — change anchor from `(0.45 W, 0.65 H)` to `(0.50 W, 0.78 H)`; extract into a single helper to prevent drift.
3. **`src/app/lighthouse/sprites/lighthouse-sprite.ts:3-9` (and the literal coordinates throughout `drawLighthouse`)** — double `LIGHTHOUSE_GEOM` and every hard-coded offset; bump `BEAM_LEN` to 300 and `BEAM_HALF_SPREAD` to 70.

## Concerns / open questions

- **Visual snapshot ratchets** (`agents/visual-snapshots/`) will fail across the board after these changes. Re-baseline only after the design lead signs off on the new framing.
- **Boat sprite scale** is conditionally P1: the right multiplier depends on whether the lighthouse is doubled (2×) or tripled. We recommend matching multipliers (lighthouse 2× → boat 2×) to preserve the existing relative-scale story.
- **Mobile** (≤480 px) is not solved by P0 fixes alone; needs P2-2 (placement-scale arg) or a mobile-specific harbour count. Out of scope here.
- The **scene drift** in `harbor-scene-client.tsx:162-164` (`Math.sin(t*0.05)*8`, `Math.cos(t*0.04)*4`) is unrelated to layout and should not be touched.
- The **scene-application effect duplicates** anchor math at `:71-115` and `:181-226`. Worth refactoring into one helper *as part of this change* since you'll be editing both.
