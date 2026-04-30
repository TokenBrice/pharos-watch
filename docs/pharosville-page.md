# PharosVille Page

Contract for `/pharosville/`, the beta PharosVille route.

`/pharosville/` is a data-driven old-school RPG island city for exploring Pharos stablecoin signals.

The scenery contract is recorded in
[`docs/pharosville/scenery-brief.md`](./pharosville/scenery-brief.md).
It defines PharosVille as a dark-first maritime observatory island-city: lighthouse
for PSI, harbors for chain supply, ships for active stablecoins, cemetery for
dead/frozen lifecycle assets, and named risk-water districts for DEWS,
stale-evidence, and NAV-ledger placement. Mint/burn flow and exit-route
telemetry are not encoded in PharosVille and remain available on their
dedicated product surfaces. Freeze/blacklist monitoring is
not encoded in PharosVille and remains available on `/blacklist/`. The ClaudeVille transfer boundary is
contracts and validation habits only; fantasy-village scenery, decorative lore
copy, non-semantic palettes, extra typography systems, and canvas-only data
truth remain out of scope.

## Route Contract

- **Page shell:** `src/app/pharosville/page.tsx`
- **Viewport gate:** `src/app/pharosville/client.tsx`
- **Desktop fallback:** `src/app/pharosville/desktop-only-fallback.tsx`
- **World shell:** `src/app/pharosville/pharosville-world.tsx`
- **Route styles:** `src/app/pharosville/pharosville.css`

The Server Component owns metadata, canonical `/pharosville/`, breadcrumb JSON-LD, and the screen-reader H1. The client component performs the desktop viewport gate before mounting the browser-only world module.

PharosVille is a desktop-only experience. Mobile and tablet compatibility is explicitly out of scope: there is no responsive canvas layout, no touch-first toolbar, and no mobile-specific UX work. Screens below `1280px` wide or `760px` tall render a DOM fallback with links to the main analytical pages and must not mount the canvas, world queries, asset manifest loader, or sprite decode path. Mobile/narrow-viewport bugs in the world surface are not regressions — the fallback is the supported mobile contract.

## Current Phase

The current implementation includes the desktop PharosVille v0.1 baseline:

- desktop-gated route, with a short-screen fallback as well as the narrow-screen fallback
- route shell escapes the global page padding and sizes against the actual post-sidebar content pane, so the desktop canvas uses the full available viewport area whether the sidebar is expanded or collapsed
- Canvas 2D island-sea map on eligible desktop viewports, with the authored world reduced to `56 x 56` tiles and a tighter default camera so the first view reads as roughly 78-82% water rather than a mostly empty sea shelf
- authored terrain metadata layered over canonical movement tiles, including harbor water, calm DEWS anchorage water, watch breakwater water, alert water, warning shoals water, storm water, ledger water, deep outer-shelf water, beach, grass, rock, cliff, hill, and shore variants; manifest terrain sprites render first and semantic overlays add shoals, foam, current streaks, storm chop, ledger glow, and reef/buoy cues without changing analytical color meaning
- named DEWS water-zone labels attach to cartographic plaques, buoys, reefs, or breakwater markers on semantic water areas, with live band counts retained in details and the accessibility ledger, plus subtle dock mast flags using chain logos or short crest marks
- Pharos lighthouse placed on the west side of the northeast headland at tile `{ x: 38, y: 22 }`, sitting on elevated terrain clear of the Tron harbor footprint
- only the tower portion of the generated lighthouse asset is composited onto the tile-native headland, so no embedded island base or road/causeway is drawn
- Ethereum, Base, Arbitrum, and Polygon are arranged in the southwest EVM bay, with Ethereum as the central cove landmark and Base/Arbitrum/Polygon on the surrounding bay sides; BSC, Tron, Solana, Aptos, and other non-core top-chain harbors use distributed outer-coast dock slots; quay pads, seawalls, posts, crates, lamps, buoys, ropes, skiffs, tents, and harbor clutter make the ports read as EVM bay, east commercial harbor, and south ledger basin districts; the cemetery sits on the main island to the right of the EVM bay and left of the lighthouse
- live aggregate Pharos queries mounted only after the desktop gate
- pure world model for PSI, docks, active ships, clusters, cemetery, named risk-water areas, details, and visual cues
- docks are capped to the top ten chains by stablecoin supply; each dock represents one chain harbor, uses Pixellab harbor sprites with dedicated EVM-bay assets for Ethereum/Base/Arbitrum/Polygon, identifies itself with a small logo flag rather than a large name board, scales from both global share and absolute billion-dollar supply tiers, and lists that chain's highest-supply stablecoins in DOM details
- active ships use distinct Pixellab base sprites by governance class: CeFi treasury galleons, CeFi-dependent chartered brigantines, and DeFi DAO schooners, with legacy algorithmic junk and caravel fallback sprites reserved for defensive/unclassified cases
- ship scale uses exaggerated compressed market-cap tiers, not linear supply area, so $1B+ issuers are spottable while USDT and USDC remain capped
- ship reduced-motion/static placement uses each ship's risk-water idle tile, or Ledger Mooring for NAV ledger assets; rendered dock moorings remain active route stops rather than the static representative position
- normal-motion ships follow slow deterministic water-only harbor cycles, with seeded detours between chain moorings and their peg/DEWS risk water
- DEWS-driven risk water areas follow the diagrammed sea-zone field: Calm Anchorage owns the large west-edge basin, Watch Breakwater sits above the island in the northwest/top-left water, Alert Channel occupies the top-center channel, Warning Shoals wraps the lighthouse-side northeast water, and Danger Strait attaches to the far east edge; each area has its own terrain texture, printed label, selectable hit target, and live band counts in details and the accessibility ledger
- fresh ship risk water maps to Calm Anchorage, Watch Breakwater, Alert Channel, Warning Shoals, or Danger Strait; stale/low-confidence evidence stays as an evidence caveat on Calm Anchorage fallback placement, and NAV ledger assets use Ledger Mooring ledger water below the harbor in a quiet bottom basin. Normal-motion dockless patrols use current or adjacent same-purpose sea anchors so every risk zone has meaningful water-only travel
- ship docking cadence comes from `stablecoins.chainCirculating` chain presence, while risk water comes from `pegSummary.coins[]` and `stress.signals[]`; DOM details expose the route source, named risk water area, risk water zone, home dock, chain-presence count, and cadence text
- active ships draw painted sail marks or pennants when a local logo asset is available; secondary `ShipVisual.overlay` cues render as tiny lanterns, pennants, or signal flags rather than circular badges
- long-tail stablecoins beyond the individual ship budget are split into small flotillas with count pennants rather than geometric count markers; cluster details and the accessibility ledger expose the named risk water area and risk zone
- dock sprites sit on quay pads, and non-data scenery is depth-sorted with entities, so supporting landmarks share the lighthouse's heavier island-city footprint while preserving entity IDs, hit targets, and DOM detail truth
- blacklist/freeze tracker activity is intentionally not represented in PharosVille; `/blacklist/` remains the product surface for those details
- data effects include bounded local glow, semantic water shimmer, and stale-data/ledger overlays; reduced motion freezes movement but keeps static status encodings
- the cemetery is rendered as a compact maritime memorial precinct with a pale limestone terrace, muted grass/quay edges, scattered grave placement, a dedicated local marker sprite set (headstone, ledger slab, reliquary marker, regulatory obelisk), small varied cause-aware marker scale/shape, contextual mausoleum/tree/shrub details, cause-of-death plaques using the shared cemetery legend colors, toned-down stone-mounted local logos only on selected or major memorials, and light atmospheric mist
- visible RPG-styled toolbar, click-anchored detail panel, blank-map click-to-close behavior, and screen-reader accessibility ledger
- canvas hit testing for lighthouse, docks, ships, clusters, graves, and named water areas
- mouse/touch drag pan, wheel zoom, toolbar pan/zoom/reset/follow/clear controls, keyboard arrow pan, Escape clear, and fullscreen inspection mode
- normal-motion canvas loop for the lighthouse beam shimmer, semantic water textures, decorative time-derived dawn/day/dusk/night sky with sun, crescent moon, stars, constellations, cloud bands, decorative birds/lights/haze, and deterministic ship route sampling, with expensive wake effects capped to selected/top/recent ships
- printed water-area labels render above entity sprites so the names of Calm Anchorage, Watch Breakwater, Alert Channel, Warning Shoals, Danger Strait, and Ledger Mooring remain visible and selectable; label hit targets stay clear of the lighthouse asset rectangle
- deterministic reduced-motion render with no running animation frame loop
- route-owned motion debug fields for browser validation, including
  `motionClockSource`, `activeMotionLoopCount`, and capped `motionCueCounts`
- desktop, dense-atlas, stressed-ship, short-screen, ultrawide backing-store, interaction, central-core invariants, and motion visual coverage, including a p95 draw-duration budget for dense normal-motion rendering
- controlled Pixellab asset manifest v2 with critical/deferred sprite loading, separate cache/provenance versions, and reserved frame-animation metadata under `public/pharosville/assets/`
- asset validation through `npm run check:pharosville-assets`
- no production fixture/default market data

## DEWS sea zones

Five DEWS zones encircle the island, each anchored to a primary map edge and
drawn with compound coast-aware masks sized roughly proportionally to the ships
it must host:

- **Calm Anchorage** (~97 ships) — large left-side basin and lower-left reach
  spanning roughly (0, 14) to (22, 54).
- **Watch Breakwater** (~66 ships) — northwest/top basin spanning roughly
  (0, 0) to (31, 15), with tile (0,0) left as deep-water decoration.
- **Alert Channel** (~7 ships when fresh) — top-center current right of WATCH,
  roughly (29, 0) to (48, 12). Connects visually to WATCH and the east shelf.
- **Warning Shoals** (rare) — right-edge reef shelf above the lighthouse,
  roughly (47, 0) to (55, 15).
- **Danger Strait** (rare) — right-edge storm basin below WARNING, roughly
  (49, 15) to (55, 25).

The three escalation zones (ALERT + WARNING + DANGER) cover the eastern
corner of the diamond with organic seams rather than hard rectangles. A
two-tile periphery around all island lobes and water tiles inside a lighthouse
visual-clearance box (x:35..41, y:16..22) remain generic water so zones don't
crowd the island or the lighthouse sprite.

**Ledger Mooring** is non-DEWS and sits at the south edge for NAV-ledger
ships.

## Data Mapping Target

The planned PharosVille visual grammar is:

- lighthouse = PSI composite status
- dock footprint = top-ten chain stablecoin supply, with one harbor per chain, fixed EVM-bay slots for Ethereum/Base/Arbitrum/Polygon, distributed outer-coast slots for BSC/Tron/Solana/Aptos-style L1s, and absolute size floors for billion-dollar hubs so Ethereum, Base, Arbitrum-class ports read as major harbors
- dock harbor detail = highest-supply stablecoins on that chain, with the canvas flag using the chain logo or a fallback crest mark
- ships = active stablecoins only, with risk-water representatives, Ledger Mooring representatives where applicable, and rendered-dock route visits for positive chain supply
- ship base sprite = governance class (`centralized` CeFi, `centralized-dependent` CeFi-Dep, `decentralized` DeFi), with legacy algorithmic backing reserved as a fallback hull
- ship scale = exaggerated compressed market-cap tier from Micro/Unknown through Flagship, with exact market cap exposed in the detail panel
- ship sail mark = stablecoin logo, falling back to a short symbol mark
- ship route distance from shore = peg/depeg risk first, with fresh DEWS escalation mapped left-to-right through Calm Anchorage, Watch Breakwater, Alert Channel, Warning Shoals, and Danger Strait terrain while high-risk areas route around the lighthouse rather than underneath it
- ship representative position and docking cadence = positive chain supply across the rendered top-ten chain harbors, shown as slow water-only passages rather than real-time transfer flow
- sea/weather = aggregate DEWS breadth, with evidence caveats for stale/low-confidence placement inputs, ledger water for NAV-ledger placement, and storm local textures for danger areas
- cemetery = dead and frozen assets from merged cemetery data, with each tomb marker using the local memorial marker sprite for its cause-aware shape, a stone-mounted local cemetery logo on selected or major memorials when available, and a cause-of-death plaque keyed to the same color taxonomy as the cemetery legend
- mint/burn flows, DEX liquidity, and redemption-route backstops = dedicated analytical pages outside PharosVille, not canvas landmarks
- evidence caveat = missing, low-confidence, or stale evidence, exposed in ship details and the accessibility ledger
- ledger water = NAV ledger assets that do not have standard peg-summary rows

Exact values and placement explanations must be available in DOM panels. The canvas must never be the only source of analytical truth.

Dense inspection concepts stay DOM-only until they have a clear analytical
mapping: full event/holding/pool/yield/dependency tables, transitive dependency
or value-at-risk interpretation, executable redemption guarantees, filtering and
sorting controls, and methodology text beyond short source or caveat labels.

## Canvas Exception

Pharos narrative visualizations normally prefer SVG/CSS view-model presentations. PharosVille is a deliberate Canvas 2D exception because it needs a pan/zoom world, isometric tile projection, depth sorting, sprite layers, culling, and 200+ possible entities.

Compensating gates:

- pure tested world model before renderer complexity
- DOM ledger/detail parity for encoded signals
- reduced-motion deterministic render
- canvas nonblank, semantic terrain/water, and backing-pixel budget tests
- no canvas/runtime work below `1280px`
- no canvas/runtime work below `760px` viewport height
- no CSP relaxation

## Motion Budget

PharosVille motion is governed by one route-owned canvas clock. Normal motion
uses the world RAF loop in `pharosville-world.tsx`; reduced motion renders a
static deterministic frame and cancels the loop. Analytical motion cues must have
visual-cue registry metadata, DOM/detail or accessibility-ledger parity, and a
reduced-motion equivalent.

Priority order is selected/focused entity, active risk or critical PSI, recent
data change, then ambient life. Relationship overlays are
selected-only, ship wake/effects are capped to selected/top/recent-mover ships,
and ambient birds/lights remain fixed-size local sets attached to the lighthouse
or civic core.

## Visual Regression

`tests/visual/pharosville.spec.ts` covers:

- desktop canvas shell at `1440 x 1000`
- nonblank canvas pixels, terrain/water pixel coverage, and backing-store budget
- reduced `56 x 56` map size, 78-82% water ratio, deep-water perimeter cap, terrain metadata coverage, northeast headland lighthouse placement, and harbor/cemetery separation invariants
- dense atlas fixture with 10 docks, 128 visible ships, long-tail flotilla clusters, cemetery/civic/risk-water crops, and normal-motion draw-duration p95 budget
- stressed ship detail semantics for active depeg, Danger Strait/storm-shelf placement, named risk water, and evidence fields
- `<1280px` fallback
- short desktop fallback
- visible toolbar/detail surfaces, click-anchored detail placement, blank-map click-to-close behavior, and canvas click/selection/camera interaction
- fullscreen control visibility and mode toggle
- ultrawide canvas DPR/backing-store caps
- reduced-motion ship sample stability with no RAF loop
- normal-motion RAF startup, moving ship samples, moving ship click targets, and DOM/detail route parity
- absence of retired building targets, central civic-core placement invariants, visual-cue registry entries, and asset manifest validation
- no world API, site-data, manifest, or asset requests under the fallback

Visual tests route-mock `/api/*` and `/_site-data/*` data before asserting map semantics.

## Color Guard

`npm run check:harbor-palette` remains as a compatibility script name, but it now runs `scripts/check-pharosville-colors.mjs`. The new guard checks the PharosVille route shell for unsafe placeholder/debug colors and visual-system drift.

## Update Rules

Update this file when any of the following change:

- `/pharosville/` route shell, metadata, or desktop gate
- PharosVille data mapping
- canvas mount, renderer, or world-model contract
- DOM parity, keyboard access, or detail-panel behavior
- visual regression expectations
- asset manifest or Pixellab pipeline

Related docs to check in the same change:

- [architecture.md](./architecture.md)
- [README.md](./README.md)
- [data-visualization.md](./data-visualization.md)
