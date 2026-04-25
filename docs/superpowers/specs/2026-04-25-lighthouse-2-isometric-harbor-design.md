# Lighthouse-2 Isometric Harbor — Design Spec

**Date:** 2026-04-25  
**Status:** Approved  
**Route:** `/lighthouse-2/` (full rewrite — existing files may be erased)  
**Goal:** Replace the current SVG expedition stage with a 2D isometric pixel-art harbor world. Cinematic, living, data-bound.

---

## 1. Concept & Metaphor

The page is a living isometric pixel-art harbor scene viewed from a fixed 2:1 isometric camera.

| World element | Meaning |
|---|---|
| **Lighthouse island** | Pharos itself — the central stability anchor |
| **Harbors** | Blockchains (Ethereum, Arbitrum, Base, Solana…) |
| **Moored boats** | Stablecoins deployed on that chain |
| **Sailing boats** | Most-active or bridged stablecoins moving across sea |
| **Boat style** | Stablecoin classification (see §4) |
| **Trade routes** | Bridge corridors between chains |
| **Sea state** | DEWS aggregate stress level |
| **Lighthouse beam** | PSI health score |

The scene is **purely visual in v1** — placeholder data, no live API wiring. The rendering architecture is designed so data binding in a future pass only touches one adapter file (`systems/scene-data.ts`), not the rendering layers.

---

## 2. Technology Stack

| Concern | Solution |
|---|---|
| Renderer | **PixiJS v8** — WebGL primary, Canvas 2D auto-fallback |
| React integration | **pixi-react v8** `<Application>` component |
| SSR gate | `dynamic(() => import('./harbor-scene'), { ssr: false })` |
| Ship animation | **GSAP + MotionPath plugin** — Bezier waypoint patrol routes |
| Water animation | PixiJS **Ticker** loop — sine wave offset per frame |
| Lighthouse beam | GSAP timeline — 6 s rotation loop |
| Sprite art (v1) | PixiJS **Graphics API** — code-drawn pixel art, no PNG assets |
| Sprite art (v2+) | **PixelLab MCP** — generate isometric tiles/tilesets during design iteration, commit as static PNGs, reference via `harbor_assets.json` manifest |
| Depth sorting | `zIndex = tileX + tileY`; `sortableChildren = true` on BoatLayer container |
| Reduced motion | `Ticker.stop()` + `gsap.globalTimeline.pause()` when `prefers-reduced-motion: reduce` |
| Accessibility | Existing `lighthouse-2-a11y-ledger.tsx` pattern — sr-only data table |
| Bundle cost | PixiJS ~280 KB gz + GSAP ~25 KB gz — dynamic import, only on `/lighthouse-2` |

---

## 3. Isometric Coordinate System

Standard 2:1 pixel art projection (26.565°), confirmed from ClaudeVille reference:

```
TILE_WIDTH    = 64   // px
TILE_HEIGHT   = 32   // px
SCENE_GRID_SIZE = 40 // tiles — used as multiplier in depth sort for elevated objects

// World → Screen
screenX = (tileX - tileY) * TILE_WIDTH  / 2
screenY = (tileX + tileY) * TILE_HEIGHT / 2

// Screen → World (for click hit-testing)
tileX = screenX / TILE_WIDTH  + screenY / TILE_HEIGHT
tileY = screenY / TILE_HEIGHT - screenX / TILE_WIDTH
```

Painter's algorithm: render order = ascending `tileX + tileY`. Islands and harbors are pre-sorted at scene build time (fixed camera — no per-frame sort needed). Ships use `zIndex` updated on each position change.

Canvas size: `100%` container width, `70vh` height. `image-rendering: pixelated` on the canvas element.

---

## 4. Scene Graph — 5 Layers

All layers are PixiJS `Container` objects added to the root `Stage` in this order:

### Layer 1 — SkyLayer (static)
Stars (scattered `drawCircle`), moon, faint cloud sprites. Baked once on scene init. Never redrawn unless theme changes.

### Layer 2 — WaterLayer (Ticker-animated)
Tiling water surface. Ticker loop advances a `waveOffset` float each frame; each water tile's Y position is offset by `Math.sin(waveOffset + tileX * 0.5 + tileY * 0.3) * amplitude`. `amplitude` is a scene-level param (default 1.5 px; future: driven by DEWS stress up to 4 px).

### Layer 3 — HarborLayer (painter-sorted)
One container per harbor (chain), sorted by `tileX + tileY` at build time. Each harbor container holds:
- Island ground tile stack (isometric tile rows via `drawRect` per face: top / left / right with baked lighting ratios)
- Warehouse/building sprites (code-drawn pixel blocks)
- Dock planks and pier
- Optional crane arm (for DEX expansion slot, present but low-opacity in v1)
- Chain flag on a mast (flag color = chain accent)
- **Lighthouse tower** (lighthouse island only) with GSAP beam sweep

`sortableChildren = true` is set on this container. Each harbor child sprite has `zIndex = tileX + tileY + elevation * SCENE_GRID_SIZE` (the `SCENE_GRID_SIZE` multiplier ensures elevated objects always sort above any non-elevated tile).

### Layer 4 — BoatLayer (dynamic z-sort)
One `Sprite`/`Container` per stablecoin boat. `sortableChildren = true`. Each boat has `zIndex = screenY` updated on position change. Boats on patrol routes move via GSAP MotionPath along pre-computed Bezier curves. Moored boats have a gentle idle bob (CSS-style sine on Y, amplitude 1 px, 3 s period).

### Layer 5 — UIOverlay (HTML, above canvas)
Positioned via CSS absolute over the canvas. Contains chain name labels and future tooltip cards. Data-bound in a later pass.

---

## 5. Boat Classification System

| Boat style | Classification | Visual signature | Examples |
|---|---|---|---|
| **Galleon** | CeFi | Three masts, largest hull, square sails | USDT, USDC, BUSD |
| **Brigantine** | CeFi-dep | Two masts, medium hull | USDC.e, wrapped/bridged stables |
| **Schooner** | DeFi | Two fore-and-aft sails, nimble hull, teal-tinted canvas | DAI, crvUSD, FRAX, LUSD, GHO |
| **Junk** | Algo / Exotic | Battened sails (horizontal ribs), unusual silhouette | FRAX v1, algorithmic stables |

Classification comes from `shared/lib/classification.ts` — no new classification logic, same labels.

Boat hull size: 3 tiers (S / M / L) determined by stablecoin supply rank within its harbor, log-scaled.

---

## 6. Data Encoding Map

All data fields are **stubbed with placeholder values in v1**. The `scene-data.ts` adapter is the sole connection point — swapping it for live API data is the only change needed for v2 data binding.

| Visual | Data field | Encoding | Module |
|---|---|---|---|
| Harbor size | Chain total stablecoin supply | Tile count, dock length, building count — log-scaled | Chains |
| Harbor buildings | Chain activity / TVL | Warehouse count, crane presence | Chains |
| Boat count per harbor | Stablecoin count on chain | Moored boats visible (max 6–8 per harbor) | Chains |
| Boat hull size | Stablecoin supply on chain | S / M / L hull — 3 tiers, log-scaled | Chains |
| Boat style | Stablecoin classification | Galleon / Brigantine / Schooner / Junk | Chains |
| Boat flag color | Peg health / deviation | `HEALTH_HEX_FILL` palette (green → amber → red) | Chains |
| Boat sailing vs moored | Stablecoin 24h volume rank | Top N by volume sail open water | Chains |
| Lighthouse beam color | PSI band | `PSI_HEX_COLORS` (gold → amber → red) | PSI |
| Beam sweep speed | PSI score 0–100 | Inverse: high score = slow, calm sweep | PSI |
| Sea wave amplitude | DEWS aggregate stress | `1.5` calm → `4.0` px storm | DEWS |
| Weather / cloud density | DEWS highest band | Clear → haze → storm cloud sprites | DEWS |
| Horizon silhouettes | Alt-peg cohort count | Faint distant harbor shapes on horizon | Alt-Pegs |

---

## 7. Animation Systems

### Lighthouse beam sweep
GSAP timeline on the beam `Graphics` object. Rotates the beam container 360° over `sweepDuration` seconds (default 6 s). In v2: `sweepDuration` driven inversely by PSI score (high stability = slow, reassuring sweep; crisis = rapid scan). Paused when `prefers-reduced-motion`.

### Ship patrol routes
Each sailing boat has a pre-computed Bezier path between its home harbor and the lighthouse island (or between two harbors for bridged assets). Paths are defined as `[{x, y}, ...]` waypoint arrays passed directly to GSAP `motionPath: { path: [...], type: 'cubic' }`. Boats loop continuously with a randomised `stagger` so they never all arrive simultaneously. Speed in v2 driven by stablecoin 24h volume. Paused when `prefers-reduced-motion`.

### Water shimmer
Ticker callback increments `waveOffset += delta * 0.001`. Each water tile Y is `baseY + Math.sin(waveOffset + col * 0.5 + row * 0.3) * amplitude`. Ticker stopped when `prefers-reduced-motion`.

### Moored boat bob
Idle boats oscillate Y ± 1 px on a 3 s sine. Implemented as a Ticker sub-callback keyed per boat with a random phase offset so boats bob independently. Stopped when `prefers-reduced-motion`.

---

## 8. Asset Pipeline

### Phase 1 — Code-drawn (v1, no PNG assets)
All sprites built with PixiJS `Graphics` API:
- Island tile faces: `drawRect` for top / left / right with baked brightness ratios (top = 100%, left = 75%, right = 60%)
- Lighthouse tower: stacked isometric polygon blocks + `ColorMatrixFilter` glow on lantern
- Boat hulls: isometric polygon, mast line, sail quads per style
- Water tiles: flat polygon, sine-animated Y per Ticker
- Stars / moon: `drawCircle` with opacity

### Phase 2 — PixelLab MCP assets (post-MVP)
Use PixelLab MCP during design iteration to generate higher-fidelity assets:
```
create_isometric_tile("harbor dock planks, weathered wood", 64)
create_isometric_tile("rocky island top face, grass", 64)
create_tileset("deep ocean waves", "sandy harbor shore")
create_character("tall ship galleon, pixel art, side view")
```
Outputs committed as static PNGs, organized into sprite sheets. Referenced via `harbor_assets.json` manifest (frame dimensions, animation names per boat type). Replacing `Graphics`-drawn sprites with PNG sprites requires only changes inside the `sprites/` files — no layer or scene logic changes.

---

## 9. File Structure

```
src/app/lighthouse-2/
├── page.tsx                        # Route shell, metadata, noindex preserved
├── client.tsx                      # React shell, dynamic import gate, error boundary
├── harbor-scene.tsx                # pixi-react <Application>, responsive canvas, layer assembly
├── harbor-scene.css                # Canvas sizing, image-rendering, overlay positioning
├── layers/
│   ├── sky-layer.tsx               # Stars, moon — baked Graphics on mount
│   ├── water-layer.tsx             # TilingSprite + Ticker shimmer
│   ├── harbor-layer.tsx            # Chain harbors — island tiles, buildings, docks, flag
│   ├── boat-layer.tsx              # Stablecoin boats — patrol routes + moored bob
│   └── ui-overlay.tsx              # HTML overlay — chain labels, future tooltips
├── sprites/
│   ├── lighthouse-sprite.ts        # Tower blocks + beam container
│   ├── island-sprite.ts            # Isometric tile stack generator
│   ├── harbor-sprite.ts            # Warehouse, dock, crane, pier builders
│   ├── boat-sprite.ts              # Hull + sail factory keyed by BoatStyle enum
│   └── water-tile.ts               # Water face polygon
├── systems/
│   ├── isometric.ts                # Tile↔screen projection, depth sort key, hit-test inverse
│   ├── patrol.ts                   # Bezier path generation per boat, GSAP MotionPath wiring
│   └── scene-data.ts               # Placeholder scene config → future live data adapter
├── harbor_assets.json              # (Phase 2) Sprite sheet manifest
└── lighthouse-2-a11y-ledger.tsx    # Unchanged — sr-only data table
```

---

## 10. Future Expansion Slots

The following are **designed into the scene graph but not built in v1**:

| Slot | Meaning | Implementation hook |
|---|---|---|
| Dock cranes | DEX venues on a chain | Low-opacity crane sprites on each harbor; future: height = DEX liquidity depth |
| Harbor lighthouses | Yield protocols | Small lighthouse sprites on each chain harbor; future: glow intensity = TVL |
| Bridge route animation | Cross-chain flows | Trade route Bezier paths already in scene; future: boat sprites traverse them with volume-driven frequency |
| Camera pan / zoom | Exploration mode | PixiJS stage `scale` + `position` lerp (ClaudeVille camera pattern); future: click harbor to zoom in |
| Weather layer | DEWS visual escalation | Cloud sprites already in SkyLayer; future: opacity + count driven by DEWS band |

---

## 11. Accessibility

- `<canvas>` element is `aria-hidden="true"`
- `lighthouse-2-a11y-ledger.tsx` renders a visually hidden `<table>` with all chain/stablecoin data for screen readers — unchanged from current implementation
- `UIOverlay` labels use semantic HTML
- Reduced-motion: all animation systems pause; static scene remains fully readable

---

## 12. Build Sequence

1. **Isometric utilities** (`systems/isometric.ts`) — projection math, depth key, hit-test inverse. No PixiJS dependency. Unit-testable.
2. **PixiJS Application shell** (`harbor-scene.tsx`) — pixi-react `<Application>`, responsive canvas, verify WebGL context.
3. **Sky + Water layers** — baked stars, Ticker wave shimmer, confirm reduced-motion pauses.
4. **Lighthouse island + tower** — island tile stack, tower pixel blocks, GSAP 6 s beam sweep.
5. **Boat sprites + patrol routes** — all four styles via `Graphics`, GSAP MotionPath loop with stagger.
6. **Chain harbors (placeholder count)** — 3–5 placeholder harbors at fixed tile positions, painter-sorted, buildings and dock planks, moored boats per harbor.
7. **Scene data bridge** (`systems/scene-data.ts`) — typed placeholder config matching the future live data shape.
8. **A11y ledger + validation** — wire ledger, run `npm run build`, `npm run lint`, confirm no SSR errors.
