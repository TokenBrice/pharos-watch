# PharosVille Visual Invariants

Last updated: 2026-04-29

These are the non-negotiable visual/data contracts for the PharosVille world. A change that violates one of these is a product behavior change and needs explicit intent plus matching tests and docs.

## Route And Runtime

- `/pharosville/` is desktop-only. The world must not mount below `1280px` width or `760px` height.
- The fallback must avoid world API queries, `/_site-data` world queries, asset manifest fetches, canvas setup, and sprite/logo decode work.
- The route uses existing Pharos frontend hooks and API payloads. Visual-only work must not add Worker/API contracts unless explicitly requested.
- No production fixture/default market data is allowed.

## Data Truth

- Canvas is a representation, not the only source of analytical truth.
- Every visual signal with analytical meaning must have detail-panel or accessibility-ledger parity.
- Source fields and caveats belong in details when a visual encoding could be misread.
- Stablecoin list `circulating` values are already USD-denominated; use `getCirculatingRaw()` for market-cap tiers.

## Geography

- The current map acceptance target is a sea-first isometric island with roughly 82-88% water by tile count. Treat that as the current route contract, but update this file and tests if an intentional layout plan changes the target.
- The lighthouse stays on the northeast headland at `LIGHTHOUSE_TILE`.
- The southwest EVM bay keeps Ethereum, Base, Arbitrum, and Polygon in preferred dock positions when those chains are rendered.
- Docks are capped by `MAX_CHAIN_HARBORS`; they represent top-chain stablecoin supply, not all chains.
- The cemetery remains a compact memorial precinct separated from the EVM bay and lighthouse approach.
- Two inland data buildings, Royal Mint And Burn Foundry and Exit Route Gatehouse, sit along the main-island road spine with a quiet memorial precinct between the harbor edge and civic anchors.
- DEWS sea geography follows the current placement diagram: Calm Anchorage owns the large west-edge basin, Watch Breakwater sits above the island in the northwest/top-left water, Alert Channel occupies the top-center channel, Warning Shoals wraps the lighthouse-side northeast water, and Danger Strait attaches to the far east edge. Warning Shoals and Danger Strait must keep label hit targets clear of the lighthouse tower rectangle.
- Calm Anchorage is intentionally the largest DEWS water block and should fill the open western basin to reduce calm-ship overlap around the western harbor/shore.
- Ledger Mooring should remain a quiet owned basin below the harbor in ledger water. Freeze/blacklist tracker activity remains outside PharosVille and belongs to the `/blacklist/` product surface.

## Entity Semantics

| Entity | Meaning | Must not imply |
| --- | --- | --- |
| Lighthouse | PSI band and score | Full market health beyond PSI |
| Dock footprint | Chain stablecoin supply and top stablecoins on that chain | Bridge volume, transaction flow, or real-time transfers |
| Ship | Active stablecoin representative | Full supply distribution as linear pixel area |
| Ship route/docking cadence | Positive rendered-chain presence and risk-water patrol | Real transfer activity or issuer operations |
| Ship risk water | Peg/DEWS evidence, named risk-water area, risk zone, and placement precedence | Risk from stale or missing evidence alone |
| Long-tail cluster | Count-capped grouped active stablecoins sharing a risk placement, named risk-water area, and risk zone | One aggregated issuer |
| Cemetery marker | Dead/frozen lifecycle asset with cause-aware visual style | Active market status |
| Data building | Non-ship Pharos product summary | Methodology text, raw tables, or guarantees |
| Evidence caveat | Missing, stale, or low-confidence evidence | Confirmed depeg/stress |

## Ship And Risk Rules

- Ship class comes from governance/backing metadata via `ship-visuals.ts`.
- Ship size is a compressed market-cap tier, not linear area.
- Active depeg and DANGER evidence outrank calm chain presence for risk placement.
- Stale or missing peg evidence maps to an evidence caveat on Calm Anchorage fallback placement, not storm risk or a separate named zone.
- Fresh DEWS bands map to the named sea districts: CALM to Calm Anchorage, WATCH to Watch Breakwater, ALERT to Alert Channel, WARNING to Warning Shoals, and DANGER to Danger Strait.
- Ledger Mooring is the only non-DEWS named risk-water area. If ships can reference it, it must also have a printed label, area hit target, detail facts, and accessibility-ledger row.
- Printed water-area labels render above entity sprites and their hit targets win inside the printed label rectangle. This keeps all zone names visible and selectable even near tall landmarks.
- Reduced-motion representative placement uses deterministic static positions and no RAF loop.
- Reduced-motion ships freeze at risk-water idle tiles, or Ledger Mooring for NAV ledger assets. Details and the accessibility ledger must still expose the named risk-water area and risk zone.
- Normal motion samples, hit testing, selected rings, follow-selected behavior, and debug state must use the same motion model.
- Water routes must stay on water tiles where tests assert that contract.

## Renderer Rules

- Local runtime art comes from `public/pharosville/assets/manifest.json`; no Pixellab URLs or prototype paths at runtime.
- Hit boxes must track rendered geometry, not just tile centers.
- Asset geometry changes require manifest updates and hit-testing/visual validation.
- Canvas backing store must remain bounded by the canvas budget.
- Palette changes must pass `npm run check:pharosville-colors`; use the route palette and classification/shared colors rather than ad hoc debug colors.

## Accessibility And Motion

- Reduced motion freezes animation while preserving static status encodings.
- Normal motion must use the single PharosVille canvas clock; independent
  analytical CSS animations, intervals, sprite loops, or minimap loops are not
  allowed.
- Motion priority is selected/focused entity, active risk or critical PSI,
  recent data change, building state, then ambient life.
- Motion caps and debug fields are governed by
  [`MOTION_POLICY.md`](./MOTION_POLICY.md).
- Keyboard pan, Escape clear, toolbar controls, click selection, and blank-map click-to-close are part of the interaction contract.
- The detail panel and accessibility ledger must remain useful without reading canvas pixels.
