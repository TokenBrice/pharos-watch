# PharosVille Page

Contract for `/pharosville/`, the beta PharosVille route.

`/pharosville/` is a data-driven old-school RPG island city for exploring Pharos stablecoin signals.

The scenery contract is recorded in
[`agents/specs/2026-04-29-pharosville-scenery-brief.md`](../agents/specs/2026-04-29-pharosville-scenery-brief.md).
It defines PharosVille as a dark-first maritime observatory island-city: lighthouse
for PSI, harbors for chain supply, ships for active stablecoins, cemetery for
dead/frozen lifecycle assets, four main-island data buildings for non-ship
Pharos products arranged around a central civic data core, and North Froze Pole
as a frozen northern water area for
observed freeze/blacklist activity. The ClaudeVille transfer boundary is
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
- Canvas 2D sea-first island map on eligible desktop viewports, with a reshaped coastal island and roughly 82–88% water by tile count
- authored terrain metadata layered over canonical movement tiles, including harbor water, alert water, warning shoals water, storm water, fog water, beach, grass, rock, cliff, hill, road, and shore variants
- named DEWS water-zone posts showing live band counts from `stress.signals[]`, plus subtle dock mast flags using chain logos or short crest marks
- Pharos lighthouse placed on the northeast headland at tile `{ x: 44, y: 18 }`, sitting on elevated terrain with a road/stair connection back toward town
- a main-island road/plaza spine ties the southwest harbor, central civic data core, and lighthouse approach together without changing any data semantics
- Ethereum, Base, Arbitrum, and Polygon are arranged in the southwest EVM bay, with Ethereum as the central cove landmark and Base/Arbitrum/Polygon on the surrounding bay sides; BSC, Tron, Solana, Aptos, and other non-core top-chain harbors use distributed outer-coast dock slots; the cemetery sits on the main island to the right of the EVM bay and left of the lighthouse
- live aggregate Pharos queries mounted only after the desktop gate
- pure world model for PSI, docks, active ships, clusters, cemetery, thematic data buildings, northern water areas, details, and visual cues
- docks are capped to the top ten chains by stablecoin supply; each dock represents one chain harbor, uses Pixellab harbor sprites with dedicated EVM-bay assets for Ethereum/Base/Arbitrum/Polygon, identifies itself with a small logo flag rather than a large name board, scales from both global share and absolute billion-dollar supply tiers, and lists that chain's highest-supply stablecoins in DOM details
- active ships use distinct Pixellab base sprites by governance class: CeFi treasury galleons, CeFi-dependent chartered brigantines, and DeFi DAO schooners
- ship scale uses exaggerated compressed market-cap tiers, not linear supply area, so $1B+ issuers are spottable while USDT and USDC remain capped
- ship reduced-motion/static placement uses a rendered harbor mooring when the ship has rendered positive-supply chain docks; a separate peg/DEWS risk anchor remains part of the normal-motion route
- normal-motion ships follow slow deterministic water-only harbor cycles, with seeded detours between chain moorings and their peg/DEWS risk water
- DEWS-driven risk water areas are named as Calm Anchorage, Watch Breakwater, Alert Channel, Warning Shoals, and Danger Strait; ALERT, WARNING, and DANGER use successive terrain bands so the water itself escalates from channel chop to shoals to storm strait, and ships with matching fresh DEWS bands anchor and route through those areas
- ship docking cadence comes from `stablecoins.chainCirculating` chain presence, while risk water comes from `pegSummary.coins[]` and `stress.signals[]`; DOM details expose the route source, risk water, home dock, chain-presence count, and cadence text
- active ships draw their logo on the sail when a local logo asset is available
- long-tail stablecoins beyond the individual ship budget are split into count-capped water-zone cluster markers rather than one large pile
- four selectable main-island data buildings are arranged around a central civic data core on the main island and use Pixellab sprites plus deterministic Canvas overlays:
  - Royal Mint And Burn Foundry = configured issuance-chain mint/burn events from `mintBurnFlows.gauge`, `coins[]`, `hourly[]`, `scope`, and `sync`
  - Exit Route Gatehouse = DEX liquidity telemetry plus modeled redemption backstops from `dexLiquidity[__global__]`, per-coin DEX liquidity, and `redemptionBackstops.coins`
  - Yield Orchard And Moonwell = yield ranking source breadth, benchmark context, source switches, anomalies, and safety snapshot coverage from `yieldRankings`
  - Dependency Loom / Chainworks = direct report-card dependency graph links from `reportCards.dependencyGraph.edges[]`
- North Froze Pole is a northern frozen-water path, not a building sprite; it uses `frozen-water` terrain, a named water-area sign, and observed blacklist/freeze tracker summary from `blacklistSummary.stats`, per-coin frozen totals, chain coverage, and methodology metadata
- data effects include bounded local glow, smoke, sparks, waterwheel motion, orchard/well glints, dependency thread pulses, and North Froze Pole ice seams/cold-water texture; reduced motion freezes movement but keeps static status encodings
- the cemetery is rendered as a compact memorial precinct with scattered grave placement, small varied cause-aware tomb marker scale/shape, contextual mausoleum/tree/shrub details, cause-of-death plaques using the shared cemetery legend colors, local cemetery logos on tomb markers, and light atmospheric mist
- visible RPG-styled toolbar, click-anchored detail panel, blank-map click-to-close behavior, and screen-reader accessibility ledger
- canvas hit testing for lighthouse, docks, ships, clusters, graves, thematic data buildings, and named water areas
- mouse/touch drag pan, wheel zoom, toolbar pan/zoom/reset/follow/clear controls, keyboard arrow pan, Escape clear, and fullscreen inspection mode
- normal-motion canvas loop for the lighthouse great-fire flicker, water shimmer, decorative time-derived dawn/day/dusk/night sky with sun, crescent moon, stars, constellations, cloud bands, decorative birds/lights/haze, and deterministic ship route sampling, with expensive wake effects capped to selected/top/recent ships
- deterministic reduced-motion render with no running animation frame loop
- desktop, stressed-ship, short-screen, ultrawide backing-store, interaction, central-core invariants, building-interaction, and motion visual coverage
- controlled Pixellab asset manifest with critical and deferred sprite loading under `public/pharosville/assets/`
- asset validation through `npm run check:pharosville-assets`
- no production fixture/default market data

## Data Mapping Target

The planned PharosVille visual grammar is:

- lighthouse = PSI composite status
- dock footprint = top-ten chain stablecoin supply, with one harbor per chain, fixed EVM-bay slots for Ethereum/Base/Arbitrum/Polygon, distributed outer-coast slots for BSC/Tron/Solana/Aptos-style L1s, and absolute size floors for billion-dollar hubs so Ethereum, Base, Arbitrum-class ports read as major harbors
- dock harbor detail = highest-supply stablecoins on that chain, with the canvas flag using the chain logo or a fallback crest mark
- ships = active stablecoins only, with rendered harbor mooring representatives, risk anchors, and rendered-dock route visits for positive chain supply
- ship base sprite = governance class (`centralized` CeFi, `centralized-dependent` CeFi-Dep, `decentralized` DeFi), with legacy algorithmic backing reserved as a fallback hull
- ship scale = exaggerated compressed market-cap tier from Micro/Unknown through Flagship, with exact market cap exposed in the detail panel
- ship sail mark = stablecoin logo, falling back to a short symbol mark
- ship route distance from shore = peg/depeg risk first, with DEWS escalation mapped to Alert Channel, Warning Shoals, and Danger Strait terrain
- ship representative position and docking cadence = positive chain supply across the rendered top-ten chain harbors, shown as slow water-only passages rather than real-time transfer flow
- sea/weather = aggregate DEWS breadth
- cemetery = dead and frozen assets from merged cemetery data, with each tomb marker using its local cemetery logo when available and a cause-of-death plaque keyed to the same color taxonomy as the cemetery legend
- main-island data buildings and northern water path = non-ship Pharos data products, with the four data buildings visually grouped around a central civic data core and road/plaza spine on the main island:
  - Royal Mint And Burn Foundry = configured issuance-chain mint/burn flow state (`minting`, `burning`, `balanced`, `quiet`, `stale`, or `unavailable`)
  - Exit Route Gatehouse = combined DEX liquidity and redemption-route backstop state (`deep-exit`, `thin-exit`, `concentrated`, `stale`, or `unavailable`), with detail copy caveating that these are not guarantees of executable exit capacity
  - Yield Orchard And Moonwell = yield source breadth and benchmark context, avoiding any claim that higher APY is safer
  - Dependency Loom / Chainworks = direct report-card dependency links and hubs only, not transitive or value-at-risk exposure
- North Froze Pole = observed freeze/blacklist tracker activity (`recent-freeze`, `large-active-frozen`, `quiet`, `stale`, or `unavailable`) as frozen northern water, not a building
- fog = missing, low-confidence, or stale evidence

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

## Visual Regression

`tests/visual/pharosville.spec.ts` covers:

- desktop canvas shell at `1440 x 1000`
- nonblank canvas pixels, terrain/water pixel coverage, and backing-store budget
- sea-first tile ratio, terrain metadata coverage, northeast headland lighthouse placement, and harbor/cemetery separation invariants
- stressed ship detail semantics for active depeg and storm-shelf placement
- `<1280px` fallback
- short desktop fallback
- visible toolbar/detail surfaces, click-anchored detail placement, blank-map click-to-close behavior, and canvas click/selection/camera interaction
- fullscreen control visibility and mode toggle
- ultrawide canvas DPR/backing-store caps
- reduced-motion ship sample stability with no RAF loop
- normal-motion RAF startup, moving ship samples, moving ship click targets, and DOM/detail route parity
- thematic building targets, central civic-core placement invariants, building click/selection interactions, detail facts, visual-cue registry entries, and asset manifest validation
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
