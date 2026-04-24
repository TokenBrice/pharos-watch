# Exit Route Map V2 Salvage Plan

Date: 2026-04-24

## Verdict

The module is salvageable, but not by polishing the current canal scene. The data contract is useful and the metaphor is directionally right: secondary-market liquidity should read as exits with congestion and route diversity. The current implementation fails mostly at visual hierarchy, not data availability.

V2 should keep `buildLiquidityExitRouteModel()` and the surrounding metric disclosures, then replace the scenic canal with a simpler "route lock instrument": a data-first topology that shows protocol doors feeding one exit channel and chain lanes receiving flow after the bottleneck.

## Current Failure Mode

The current `ExitRouteCanalScene` in `src/components/liquidity-stats.tsx` attempts to encode too much inside one SVG:

- protocol gates, chain basins, total TVL, crowding, lighthouse, vessel, sea, stars, ripples, labels, logos, and exact values all compete for attention;
- the lock/canal metaphor is not visually self-explanatory because the gates look like decorative columns and the chain basins look like stacked bars;
- the side metric rail duplicates important values but is visually calmer than the scene, so the scene loses authority;
- the hero number sits in empty water, while the actual route marks are crowded into the margins;
- labels inside the chain basins collide conceptually with the scenic background and are fragile as data changes;
- the plan over-indexed on illustration details, so the final card reads as a themed picture rather than an analytical map.

The salvage opportunity is to keep the "exit routes under crowding" story and remove the nautical ornament.

## Non-Negotiables

- Preserve the existing model seam: no API, D1, scoring, or methodology changes.
- Preserve exact disclosures: total DEX TVL, protocol count, chain count, pool count, HHI/crowding index, weighted pool balance, organic share, 24h routed volume, leading protocol, leading chain, and the source caveat.
- Do not imply a true protocol-by-chain matrix. Current data has aggregate protocol shares and aggregate chain shares, not pairwise flow.
- Do not add another chart below the module. Replace the current scene.
- Keep `/docs/` untouched unless the implementation changes behavior or methodology, which V2 should not.

## V2 Concept

Use a "route lock instrument" rather than a scenic canal.

Layout:

- Left: protocol doors as ranked apertures. Each door has logo, label, TVL, and share. Door aperture width or height encodes `sharePct`.
- Center: exit channel and crowding throat. Total DEX TVL is the primary number inside the channel. HHI controls throat width and lane separation.
- Right: chain lanes as horizontal receiving bands. Each lane has logo, label, TVL, and share. Lane thickness encodes `sharePct`.
- Bottom or right rail: compact metric strip for open routes, crowding index, pool balance, and organic activity.

Visual language:

- Treat the SVG like a technical instrument: measured rails, apertures, flow bands, exact labels.
- Use one dark stage and a small number of accents from existing protocol/chain colors.
- Remove lighthouse, stars, boat, sea ripples, horizon, and scenic water.
- Keep "door" and "lane" copy only if the geometry actually supports it.

## Data Encoding

- Protocol route share: door aperture size and optional short inflow band.
- Chain route share: outbound lane thickness.
- Total DEX TVL: central focal number.
- HHI/crowding:
  - `< 0.18`: broad channel, separated lane guides, label `broad`;
  - `0.18-0.35`: visible throat, moderate lane convergence, label `visible`;
  - `>= 0.35`: narrow throat, stronger convergence, label `crowded`.
- Weighted pool balance: channel surface quality. High balance uses continuous rails; lower balance introduces segmented rail marks, with the exact value still in the metric strip.
- Organic share: flow marker solidity. High organic uses solid ticks; lower organic uses dashed ticks. Avoid color-only meaning.
- `Other routes`: explicit tail door/lane with muted treatment, never hidden.

## Proposed File Scope

- Modify `src/components/liquidity-stats.tsx`
  - Replace `ExitRouteCanalScene` with `ExitRouteInstrumentScene`.
  - Keep `LiquidityExitRouteMap`, `ExitRouteMetric`, `buildLiquidityExitRouteModel`, and existing route item types.
  - Delete canal-only geometry helpers and scenic constants.
- Replace `src/components/exit-route-canal.css`
  - Either rename to `exit-route-instrument.css` or rewrite in place if avoiding file churn is preferred.
  - Keep only stage tokens, responsive rules, and reduced-motion-safe flow marker animation.
- Modify `src/components/__tests__/liquidity-stats.test.ts`
  - Update render test IDs to the new scene contract.
  - Add assertions for crowding band, protocol door, chain lane, and preserved labels.

## Component Contract

New test IDs:

- `exit-route-instrument`
- `exit-throat`
- `protocol-door-${route.key}`
- `chain-lane-${route.key}`
- `exit-route-flow-markers`

Recommended accessible labels:

- SVG: `Exit route instrument: $XB DEX TVL, [top protocol] leading protocol, [top chain] leading chain, [crowding] crowding. Secondary-market DEX exits only.`
- Route groups: `[label] protocol door, $X, Y% of DEX TVL`
- Chain groups: `[label] chain lane, $X, Y% of DEX TVL`

## Implementation Steps

1. Freeze the current behavior with focused tests
   - Run `npm test -- src/components/__tests__/liquidity-stats.test.ts`.
   - Confirm current render expectations before editing.

2. Extract or replace scenic helpers
   - Remove canal-only constants: scene water bands, lighthouse, vessel duration, basin geometry, ripple animation.
   - Keep small pure helpers for share-to-size and HHI-to-throat width.

3. Build the instrument scene
   - Use a single SVG viewBox with three stable zones: protocol doors, throat, chain lanes.
   - Put the total TVL and crowding label in the center.
   - Render protocol and chain labels outside the densest geometry, not on top of decorative fills.

4. Rebalance the card layout
   - Keep the existing `xl:grid-cols-[minmax(0,1fr)_14rem]` only if the scene remains readable.
   - On tablet/mobile, stack the metric cards under the scene in two columns, then one column.
   - Avoid horizontal scrolling for the whole page; if the SVG needs a minimum width, scope overflow to the stage only.

5. Update tests
   - Replace canal test IDs with instrument test IDs.
   - Assert the exact caveat copy remains.
   - Assert `Other routes` remains in the DOM when tail routes exist.

6. Visual validation
   - Run focused tests.
   - Run `npm run build` if the component or CSS import changes.
   - Use Playwright screenshots for `/liquidity/` at desktop and mobile widths.
   - Check that labels do not overlap with current production-like data.

## Success Criteria

- From shape alone, broad vs crowded exits are visible within two seconds.
- The largest protocol and largest chain are obvious without reading the sidebar metrics.
- Exact TVL/share labels remain available for every displayed top route.
- The visual no longer looks like a decorative harbor/canal scene.
- Mobile shows the same story without clipped labels, page-level horizontal overflow, or hidden route categories.

## Defer

- Protocol-by-chain Sankey or subway intersections. That requires pairwise pool aggregation to avoid false precision.
- New liquidity collection fields.
- Methodology or score changes.
- Redemption route integration. This module should remain secondary-market DEX exits only.
