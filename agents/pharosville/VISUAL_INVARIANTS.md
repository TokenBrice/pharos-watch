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
- The central civic data core groups the four main-island data buildings around road/plaza terrain.
- North Froze Pole is a northern frozen-water area, not a building.

## Entity Semantics

| Entity | Meaning | Must not imply |
| --- | --- | --- |
| Lighthouse | PSI band and score | Full market health beyond PSI |
| Dock footprint | Chain stablecoin supply and top stablecoins on that chain | Bridge volume, transaction flow, or real-time transfers |
| Ship | Active stablecoin representative | Full supply distribution as linear pixel area |
| Ship route/docking cadence | Positive rendered-chain presence and risk-water patrol | Real transfer activity or issuer operations |
| Ship risk water | Peg/DEWS evidence and placement precedence | Risk from stale or missing evidence alone |
| Long-tail cluster | Count-capped grouped active stablecoins sharing a risk placement | One aggregated issuer |
| Cemetery marker | Dead/frozen lifecycle asset with cause-aware visual style | Active market status |
| Data building | Non-ship Pharos product summary | Methodology text, raw tables, or guarantees |
| North Froze Pole | Observed freeze/blacklist tracker activity | Complete sanctions or compliance coverage |
| Fog/data fog | Missing, stale, or low-confidence evidence | Confirmed depeg/stress |

## Ship And Risk Rules

- Ship class comes from governance/backing metadata via `ship-visuals.ts`.
- Ship size is a compressed market-cap tier, not linear area.
- Active depeg and DANGER evidence outrank calm chain presence for risk placement.
- Stale or missing peg evidence maps to degraded evidence/data fog, not storm risk.
- Reduced-motion representative placement uses deterministic static positions and no RAF loop.
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
