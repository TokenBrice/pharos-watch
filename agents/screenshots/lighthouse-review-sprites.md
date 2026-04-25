# Lighthouse Sprite Legibility & Information-Density Review

Branch: `feat/lighthouse-isometric-harbor`
Date: 2026-04-25
Viewport tested: 1920 x 1080 (live page) and 1920 x 2200 (fixture-driven, to bring harbours on-screen)
Screenshots:
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-full.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-center.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-canvas-only.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-boats-zoom.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-harbor-zoom.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-tron-zoom.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-harbor-strip.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-eth-boats.png`
- `/home/ahirice/Documents/git/stablecoin-dashboard/agents/screenshots/lighthouse-sprites-boat-detail.png`

---

## P0 — Showstoppers (the data is invisible)

### P0.1 — Harbours render off-screen at the design viewport

**Evidence:** `lighthouse-canvas-only.png` (1920 x 1080 first capture) shows only the lighthouse, beam, moon, stars and a thin horizon strip. **Zero harbours, zero boats, zero warehouses, zero docks render.** The data adapter is producing harbours (verified by injecting fixtures and re-capturing at 1920 x 2200, where harbours then appear far below the original viewport).

**Root cause:** combination of two constants:
- `harbor-scene-client.tsx:72-73` — anchor placed at `originY = Math.round(frame.height * 0.65)`
- `harbor-layer.ts:6-17` — every `TRIANGLE_TILES` entry has `tileX + tileY >= 20`, and `worldToScreen` (`isometric.ts:9-14`) returns `screen.y = (tileX + tileY) * 16`

So the smallest harbour offset from the origin is `(12+8) * 16 = 320 px south`, the largest `(22+12) * 16 = 544 px south`. At 1080 viewport, `originY=702`, and harbours land at y ≥ 1022 — at or below the visible canvas. **None of the eight tiles is north or west of the origin.**

This single bug invalidates ~80% of the encoded data:
- harbour footprint (chain total supply) — invisible
- warehouse count (stablecoinCount) — invisible
- harbour resilience tier (dock material) — invisible
- boats (governance × backing × pennant × hull-size) — invisible
- lamp warmth (warehouse glow) — invisible

**Fix path A (smallest):** subtract a constant from each tile so harbours arc *around* the lighthouse instead of trailing south of it. Edit `harbor-layer.ts:6-17`, e.g.:
```
{ tileX: 22, tileY: -10 } // ENE, screen.y = 192 (above origin)
{ tileX: -8, tileY:  10 } // WNW, screen.y =  32
{ tileX: -16, tileY: -8 } // NW, screen.y = -384
{ tileX: 14, tileY:  6  } // SE, screen.y = 320
...
```
Mix northbound (negative `tileX+tileY`) and southbound entries so the largest harbours surround the lighthouse like a half-ring.

**Fix path B:** raise the lighthouse anchor to `originY = Math.round(frame.height * 0.40)` in `harbor-scene-client.tsx:73` and shrink the tile offsets in `TRIANGLE_TILES`. This keeps the painter's-order south-fanning composition the user described, but won't help if the page chrome (sticky header) crops the top.

**Expected outcome:** at 1080 viewport, at least the 3 hero harbours (Ethereum, Tron, Solana) render fully visible — the scene is no longer "lighthouse + nothing".

---

### P0.2 — Boats render at the dock terminus and are essentially invisible

**Evidence:** `lighthouse-sprites-tron-zoom.png` and `lighthouse-sprites-boat-detail.png`. The boat at the Tron dock is a ~10 x 12 px dark sliver against `deep_sea_2 #0a0e1d`. The hull (`timber_dark #3a2a1e`) is only 4-6 luma units brighter than the sea; the mast and pennant are 1-2 px wide. At normal viewing distance, the boat is functionally invisible.

**Why:**
- `boat-sprite.ts:4-9` — `BOAT_DIMENSIONS.junk.S = 13x18`, but the *visible hull* is much smaller because the hull polygon occupies only the bottom ~6 px of `dim.h` and the rest is mast.
- `boat-sprite.ts:127` — pennant is a 3 x 2 px rectangle. At 1:1 css scale that is invisible to a sighted user.
- The boats sit in a `deep_sea_2` band where `timber_dark` only contrasts with the sea by `ΔL≈10`. Galleons use `timber_warm` (better) but other styles use `timber_mid`/`timber_dark`.

**Recommendation (combine):**
1. **Increase boat scale by ~2x.** Edit `boat-sprite.ts:4-9` to `S: { w: 22, h: 28 }` and `L: { w: 36, h: 44 }`. The 80%-vs-100% S/L distinction will then be discernible (10 vs 16 px hull width vs current 4-6 vs 8-10 px).
2. **Halo the hull.** Add a 1 px lighter outline around the hull polygon using `foam_white` at α=0.4. This is the single largest legibility win — gives every boat a silhouette that reads against any sea tint.
3. **Switch pennant from a 3x2 flag to a 2 px-wide vertical streak that runs the top third of the mast** (~5 px tall). The streak's hue (THREAT_BAND color) is what the eye picks up; the literal "flag" shape is too small to convey shape information at this scale.

---

## P1 — Encodings present but illegible

### P1.1 — Boat silhouettes (galleon vs brigantine vs schooner vs junk) are indistinguishable

**Encoding rating: D**

At 12-22 px wide hulls, the differentiating features are:
- galleon: 3 masts with 6x10 white sails, plus stern lantern
- brigantine: 1 square + 1 triangular sail (asymmetric)
- schooner: 2 triangular teal sails
- junk: red square sail with horizontal batten lines

In the screenshots, only the **junk** stands out (red sail is the most saturated). Schooner's teal-on-deep_sea is near-invisible (`sail_teal #3a5e5a` against `deep_sea_2 #0a0e1d` is low-contrast). Galleon's white sails work in principle but the sails are 6x10 px — with 3 masts crammed across a 22 px hull the result is a generic blob.

**Recommendation:** lean into ONE strongly readable feature per style instead of cumulative detail:
- galleon → tall solid white sail block (single tall rectangle, centered, full hull width)
- brigantine → asymmetric — solid white left, tall mast right
- schooner → switch `sail_teal` to a higher-contrast `lantern_cold` (#5a8aaa) so the triangles are actually visible
- junk → keep red square + battens (already the readable one)

Files: `boat-sprite.ts:91-123`, `palette.ts:22` (consider raising `sail_teal` luminance).

---

### P1.2 — Hull-size S vs L bins cluster too coarsely

**Encoding rating: C-**

`scene-data.ts:178` does `c.supplyUsd / maxSupply > 0.5 ? "L" : "S"`. With Tron's USDT at 93% dominance, only USDT is L and everything else is S — fine. But on Ethereum (USDT 41%, USDC 26%, DAI 3%), USDT alone is L and USDC + DAI are both S even though USDC is ~10x DAI's supply. The viewer can't see that intra-S variation.

**Recommendation:** use a 3-bin scheme keyed off log-supply, not a binary cutoff. Add an "M" hull (intermediate dimensions). Edit `boat-sprite.ts:4-9` to add an `M` row, edit `scene-data.ts:174-182` to bin by `log10(supplyUsd) / log10(maxSupply)`:
- `>0.85` → L
- `0.55-0.85` → M
- else S

Even without P0.2's scale doubling, three bins with a 30%/60%/100% size ratio would read where binary 80%/100% does not.

---

### P1.3 — Pennant 3 x 2 px flag is invisible

**Encoding rating: F**

The pennant carries DEWS threat band — arguably the most safety-critical signal on the canvas. Encoded as a 3x2 px rectangle at the masthead, it is 6 pixels total. Even with the recommended 2x boat scale, the pennant becomes 6x4 px — still marginal.

**Recommendation:** **wire the boat aura instead** (see P1.6). The aura halo is already coded (`boat-sprite.ts:27-34`) but disabled (`boat-layer.ts:62 auraHex: null`). The aura is a `halfW + 4` radius disc at α=0.22 — far more visible than a 6 px flag. Move DEWS to the aura color, retire the pennant or repurpose it for a different signal (e.g., chain-residency indicator).

---

### P1.4 — Resilience tier (stone/wood/weathered) is barely a palette swap on the dock plank only

**Encoding rating: D**

`harbor-island-sprite.ts:23-27` selects `stone_pale` (tier 1), `timber_mid` (tier 2), `timber_dark` (tier 3) for an 8 px-tall dock plank. The island body itself is always `stone_dark`/`stone_mid`. Viewers comparing two harbours side-by-side cannot tell tier from the dock alone — the change is one band of color on a sliver of the sprite.

**Recommendation:** make the tier difference structural, not just chromatic:
- Tier 1 (stone): add a 2-row crenellation/rampart line on top of the island diamond (`harbor-island-sprite.ts:56`).
- Tier 2 (timber): keep current.
- Tier 3 (weathered): break the dock pier into 2 short planks with a 2 px gap (suggests rot); use the darker `ember` palette for warehouse roofs instead of `stone_dark`.

Files: `harbor-island-sprite.ts:30-58, 67-71`.

---

### P1.5 — Warehouse count (1-4) is hard to read at this scale

**Encoding rating: C**

`harbor-island-sprite.ts:62` caps at 4. Each warehouse is 12 px wide, stacked horizontally with 16 px stride. Tron's 6 stablecoins → ceil(6/3) = 2 warehouses. Solana's 9 → 3. Ethereum's 14 → 4 (capped). Visually, in `lighthouse-sprites-tron-zoom.png` Tron has two warm dots in a row — readable but low-impact. The cap erases the tail (any chain ≥12 stablecoins looks identical).

**Recommendation:** keep the cap (4 is enough for a glanceable "many"), but **emphasize the gradient** by raising warehouse height with count (1 wh = 10 px, 4 wh = 16 px) so a 4-warehouse harbour has visibly taller buildings, not just more of them. Files: `harbor-island-sprite.ts:68`.

---

### P1.6 — Boat aura (peg deviation) is hardcoded null

**Encoding rating: missing**

`boat-layer.ts:62` ships `auraHex: null` — the aura code path in `boat-sprite.ts:27-34` never executes. The user's brief flagged this; it was queued in design review.

**Recommendation: wire it now (move from queued to live).** This is the cheapest 1-line win to surface peg-health visually, and once P0.2 doubles boat size the aura will be one of the loudest signals on canvas.

Plumbing:
1. Add `auraHex: string | null` to `SceneBoat` in `scene-data.ts:14-22`.
2. In `buildBoat` (`scene-data.ts:157-183`), reuse the existing `pennantHex` lookup or compute a separate peg-deviation band: aura = THREAT_BAND_HEX if `sig.band !== "CALM"`, else null.
3. In `boat-layer.ts:62`, pass `e.boat.auraHex` instead of literal `null`.

---

## P2 — Tier 3 issues / hierarchy

### P2.1 — Sea wave amplitude vs foam-intensity vs sky tint redundancy

`water-layer.ts:11, 32-35` derives wave amplitude AND foam alpha from the same `sea.amplitudePx`. `scene-data.ts:106` also computes a `sea.tintHex` from the highest stress band but **the water layer never reads it.** The encoding is computed but never drawn.

**Recommendation:** either (a) draw the tint as a low-alpha sea-overlay during DANGER/WARNING bands so the entire sea visibly reddens, or (b) drop `sea.tintHex` from the data adapter to avoid dead state. Option (a) is the bigger payoff and matches the stated design intent.

Files: `water-layer.ts:6-37`, `scene-data.ts:101-106`.

### P2.2 — Lamp warmth flag is unused as a signal

`harbor-island-sprite.ts:77-83` always emits `warm: true`. The `Lamp.warm` flag and `lantern_cold` palette both exist (`palette.ts:20`) but no harbour or boat ever sets `warm: false`. Either repurpose for an encoding (e.g., cool lights for chains in WARNING+ band) or remove the flag to reduce surface area.

### P2.3 — Patrol routes (top-volume coins moving toward beacon)

The `patrol.ts` system is queued. Recommendation: **defer**. P0.1 + P0.2 + aura wiring (P1.6) deliver more legibility than patrol motion would, and patrol risks adding more motion to a scene that already has beam sweep + lantern pulse + wave swell + boat bob. If implemented later, restrict to the top-1 boat per harbour to avoid clutter.

---

## Per-encoding rating summary

| Encoding | Rating | Notes |
|---|---|---|
| Beam color (PSI band) | A- | Beam is large and saturated — the most readable signal on the canvas. The 0.55 alpha is appropriate. |
| Beam sweep speed (PSI band) | B+ | Visible on long observation, not glanceable; 12s vs 1.2s endpoints are well-spaced (`psiSweepDuration`). |
| Boat silhouette (gov × backing) | D | See P1.1. Junk readable, others not. |
| Boat hull size S vs L | C- | See P1.2. Binary cutoff under-encodes. |
| Boat pennant (DEWS threat) | F | See P1.3. 3x2 px is below visual threshold. |
| Boat aura (peg deviation) | n/a | See P1.6. Code present, hardcoded null. |
| Harbour build quality (tier) | D | See P1.4. Tier swap is one plank only. |
| Harbour footprint (chain total) | B | Log-scale 80-160 px width is readable when harbours render (P0.1). |
| Warehouse count | C | See P1.5. Cap correct, gradient too flat. |
| Sea wave amplitude (DEWS aggregate) | C | Visible swell at high amplitude, low amplitude indistinguishable from idle motion. |
| Sky tint / sea tint (DEWS) | n/a | `sea.tintHex` computed but never drawn. |
| Stars/moon | A | Atmospheric, not data. Reads fine. |

---

## Data hierarchy recommendation

The canvas should have **three loud reads** and let the rest fade into atmosphere. Recommended ranking (loudest first):

1. **Beam color** — PSI band. Already loudest, keep that way.
2. **Boat aura (peg deviation)** — wire the THREAT_BAND halo (P1.6). With 2x boat scale (P0.2) this is the second-loudest on the scene.
3. **Harbour footprint + warehouse count + boat density** — combined "weight of harbour" read. Once P0.1 fixes positioning, the largest harbour visibly dominates.

Fade to background:
- Beam sweep speed (read on second look, not glance)
- Resilience tier (subtle architectural hint; never the headline)
- Pennant (retire or repurpose)
- Sea wave amplitude (idle texture; only assertive at WARNING+)
- Stars, moon, sky bands (pure atmosphere)

---

## Prioritized fix list

| # | Priority | File | Change | Outcome |
|---|---|---|---|---|
| 1 | P0 | `harbor-layer.ts:6-17` | Rewrite TRIANGLE_TILES so harbours arc N/E/W of origin | Harbours visible at 1080 viewport |
| 2 | P0 | `boat-sprite.ts:4-9` | Double `BOAT_DIMENSIONS` (S: 22x28, L: 36x44) | Boats become legible silhouettes |
| 3 | P1 | `boat-layer.ts:62` + `scene-data.ts:14-22, 157-183` | Wire `auraHex` from peg-health band | Most safety-critical signal becomes glanceable |
| 4 | P1 | `boat-sprite.ts:91-123` + `palette.ts:22` | Single-feature silhouettes; raise sail_teal luminance | Galleon/brigantine/schooner/junk distinguishable |
| 5 | P1 | `harbor-island-sprite.ts:30-58, 67-71` | Add structural variation per resilience tier | Tier reads at glance, not on inspection |
| 6 | P1 | `scene-data.ts:174-182` + `boat-sprite.ts:4-9` | Add M hull size, log-scale binning | 3-bin supply rank |
| 7 | P2 | `water-layer.ts` | Draw `sea.tintHex` overlay at WARNING+ | Sea visibly reddens during stress |
| 8 | P2 | `harbor-island-sprite.ts:62-78` | Warehouse height grows with count | Sharper density gradient |
| 9 | P2 | `boat-sprite.ts:127` | Drop or repurpose pennant | Reduce dead encoding |

---

## Concerns / Caveats

- The first capture (live API at 1080 viewport) hit `/api/*` 401s because of the local-main public-API gate — the scene rendered with empty harbours regardless. The 1080-viewport-with-no-harbours bug (P0.1) reproduces with **fixture data injected via `page.route`**, so it is real and not a fixture-fetch issue.
- I did NOT measure the live page on `pharos.watch` — this analysis is from the local static export. If `pharos.watch` differs (e.g., container CSS forces a specific aspect ratio), retest there before committing P0.1's tile rewrite.
- The sr-only ledger was empty in my captures (`Skip to main content` only). I did not chase that down because it is out of scope for sprite legibility, but it is worth a separate verification pass — if the ledger is also broken, we've lost the only accessible way to read the data.
- Recommendations above propose constants and code changes; no code was modified per instructions.
