# PharosVille Page

Contract for `/pharosville/`, the beta PharosVille route.

`/pharosville/` is a data-driven old-school RPG island city for exploring Pharos stablecoin signals.

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
- Canvas 2D sea-first island map on eligible desktop viewports, with roughly 86% water by tile count
- live aggregate Pharos queries mounted only after the desktop gate
- pure world model for PSI, docks, active ships, clusters, cemetery, details, and visual cues
- docks are capped to the top six chains by stablecoin supply; each dock uses a distinct Pixellab harbor sprite by rank, scales from both global share and absolute billion-dollar supply tiers, and lists that chain's highest-supply stablecoins in DOM details
- active ships use distinct Pixellab base sprites by governance class: CeFi treasury galleons, CeFi-dependent chartered brigantines, and DeFi DAO schooners
- ship scale uses exaggerated compressed market-cap tiers, not linear supply area, so $1B+ issuers are spottable while USDT and USDC remain capped
- ship risk placement is the reduced-motion/static anchor; normal-motion ships follow slow deterministic water-only routes, with seeded detours between their peg/DEWS risk water and any rendered positive-supply chain docks
- ship docking cadence comes from `stablecoins.chainCirculating` chain presence, while risk water comes from `pegSummary.coins[]` and `stress.signals[]`; DOM details expose the route source, risk water, home dock, chain-presence count, and cadence text
- active ships draw their logo on the sail when a local logo asset is available
- long-tail stablecoins beyond the individual ship budget are split into count-capped water-zone cluster markers rather than one large pile
- visible RPG-styled toolbar, click-anchored detail panel, blank-map click-to-close behavior, collapsible map key, collapsible keyboard entity browser, and screen-reader accessibility ledger
- canvas hit testing for lighthouse, docks, ships, clusters, and graves
- mouse/touch drag pan, wheel zoom, toolbar pan/zoom/reset/follow/clear controls, keyboard arrow pan, Escape clear, and fullscreen inspection mode
- normal-motion canvas loop for the lighthouse great-fire flicker, water shimmer, and deterministic ship route sampling, with expensive wake effects capped to selected/top/recent ships
- deterministic reduced-motion render with no running animation frame loop
- desktop, stressed-ship, short-screen, ultrawide backing-store, interaction, and motion visual coverage
- controlled Pixellab asset manifest with critical and deferred sprite loading under `public/pharosville/assets/`
- asset validation through `npm run check:pharosville-assets`
- no production fixture/default market data

## Data Mapping Target

The planned PharosVille visual grammar is:

- lighthouse = PSI composite status
- dock footprint = top-six chain stablecoin supply, with absolute size floors for billion-dollar hubs so Ethereum, Base, Arbitrum-class ports read as major harbors
- dock harbor detail = highest-supply stablecoins on that chain
- ships = active stablecoins only, with risk anchors plus rendered-dock route visits for positive chain supply
- ship base sprite = governance class (`centralized` CeFi, `centralized-dependent` CeFi-Dep, `decentralized` DeFi), with legacy algorithmic backing reserved as a fallback hull
- ship scale = exaggerated compressed market-cap tier from Micro/Unknown through Flagship, with exact market cap exposed in the detail panel
- ship sail mark = stablecoin logo, falling back to a short symbol mark
- ship distance from shore = peg/depeg risk first, with DEWS escalation
- ship route and docking cadence = positive chain supply across the rendered top-six docks, shown as slow water-only passages rather than real-time transfer flow
- sea/weather = aggregate DEWS breadth
- cemetery = dead and frozen assets from merged cemetery data
- fog = missing, low-confidence, or stale evidence

Exact values and placement explanations must be available in DOM panels. The canvas must never be the only source of analytical truth.

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
- sea-first tile ratio
- stressed ship detail semantics for active depeg and storm-shelf placement
- `<1280px` fallback
- short desktop fallback
- visible toolbar/detail/browser surfaces, click-anchored detail placement, blank-map click-to-close behavior, and canvas click/selection/camera interaction
- fullscreen control visibility and mode toggle
- ultrawide canvas DPR/backing-store caps
- reduced-motion ship sample stability with no RAF loop
- normal-motion RAF startup, moving ship samples, moving ship click targets, and DOM/detail route parity
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
