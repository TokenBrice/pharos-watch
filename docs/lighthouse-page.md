# PharosVille Page

Contract for `/lighthouse/`, the beta PharosVille route.

`/lighthouse/` is being replaced visually with a data-driven old-school RPG island city. The public URL remains `/lighthouse/` for now, while the page name and route copy use PharosVille.

## Route Contract

- **Page shell:** `src/app/lighthouse/page.tsx`
- **Viewport gate:** `src/app/lighthouse/client.tsx`
- **Desktop fallback:** `src/app/lighthouse/desktop-only-fallback.tsx`
- **World shell:** `src/app/lighthouse/pharosville-world.tsx`
- **Route styles:** `src/app/lighthouse/pharosville.css`

The Server Component owns metadata, canonical `/lighthouse/`, breadcrumb JSON-LD, and the screen-reader H1. The client component performs the desktop viewport gate before mounting the browser-only world module.

Screens below `1280px` wide or `760px` tall render a DOM fallback with links to the main analytical pages. They must not mount the canvas, world queries, asset manifest loader, or sprite decode path.

## Current Phase

The current implementation includes the desktop PharosVille v0.1 baseline:

- desktop-gated route, with a short-screen fallback as well as the narrow-screen fallback
- Canvas 2D island map on eligible desktop viewports
- live aggregate Pharos queries mounted only after the desktop gate
- pure world model for PSI, docks, active ships, clusters, cemetery, details, and visual cues
- DOM map key, query status, detail panel, keyboard entity browser, toolbar, minimap, and accessibility ledger
- canvas hit testing for lighthouse, docks, ships, clusters, and graves
- mouse/touch drag pan, wheel zoom, toolbar pan/zoom/reset/follow/clear controls, keyboard arrow pan, Escape clear, and minimap click-to-pan
- normal-motion canvas loop for the lighthouse sweep, water shimmer, and capped selected/top/recent ship effects
- deterministic reduced-motion render with no running animation frame loop
- controlled Pixellab asset manifest with critical and deferred sprite loading under `public/pharosville/assets/`
- asset validation through `npm run check:pharosville-assets`
- no production fixture/default market data

The next phases add renderer budget instrumentation, broader semantic visual assertions, stressed/fog scenario screenshots, and additional curated asset coverage.

## Data Mapping Target

The planned PharosVille visual grammar is:

- lighthouse = PSI composite status
- dock footprint = chain stablecoin supply
- ships = active stablecoins only
- ship distance from shore = peg/depeg risk first, with DEWS escalation
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
- canvas nonblank and backing-pixel budget tests
- no canvas/runtime work below `1280px`
- no canvas/runtime work below `760px` viewport height
- no CSP relaxation

## Visual Regression

`tests/visual/lighthouse.spec.ts` covers:

- desktop canvas shell at `1440 x 1000`
- nonblank canvas pixels
- `<1280px` fallback
- short desktop fallback
- canvas click/selection, toolbar zoom/clear, and minimap interaction
- reduced-motion determinism and normal-motion RAF startup
- no world API, site-data, manifest, or asset requests under the fallback

Visual tests route-mock `/api/*` and `/_site-data/*` data before asserting map semantics.

## Color Guard

`npm run check:harbor-palette` remains as a compatibility script name, but it now runs `scripts/check-pharosville-colors.mjs`. The new guard checks the PharosVille route shell for unsafe placeholder/debug colors and visual-system drift.

## Update Rules

Update this file when any of the following change:

- `/lighthouse/` route shell, metadata, or desktop gate
- PharosVille data mapping
- canvas mount, renderer, or world-model contract
- DOM parity, keyboard access, or detail-panel behavior
- visual regression expectations
- asset manifest or Pixellab pipeline

Related docs to check in the same change:

- [architecture.md](./architecture.md)
- [README.md](./README.md)
- [data-visualization.md](./data-visualization.md)
