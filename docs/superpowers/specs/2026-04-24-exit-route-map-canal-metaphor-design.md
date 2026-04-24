# Exit Route Map — Canal & Locks Metaphor

**Date:** 2026-04-24
**Status:** Design approved, ready for implementation plan
**Target file:** `src/components/liquidity-stats.tsx` (`LiquidityExitRouteMap`, `ExitRouteTerminal`)

## Motivation

The current "transit concourse" metaphor — protocol gates feeding a central concourse that fans into chain lanes — is administrative and tonally weak next to Pharos's other hero visuals (`/alt-pegs` atmospheric map, `/chains` harbor & lighthouse). It reads like airport wayfinding: passive, logistical, lacking physical weight.

This redesign replaces the concourse with a **side-elevation canal scene**: lock gates, water, and a delta of chain basins opening onto the open sea. It keeps the current data mapping (protocol projection · aggregate TVL · chain projection) but gives each element physical mass and extends Pharos's nautical lineage without cannibalising `/chains`.

## Goals

- Replace the concourse visual with a canal & locks scene that reads as a working piece of infrastructure.
- Keep the exact same data dimensions and projections — this is a visual rework, not a data change.
- Preserve the right-side stats sidebar (Open routes · Crowding · Pool balance · Organic).
- Extend the nautical brand family. The Pharos lighthouse returns as a background cue, not the subject.
- Make "exit route" literal: the viewer sees liquidity passing through gates toward open water.

## Non-goals

- No change to the `buildLiquidityExitRouteModel` data model or its inputs.
- No change to the metrics displayed in the sidebar, their formulas, or their copy.
- No new interactivity (hover states, click-throughs) beyond what exists today.
- No animation beyond subtle ambient motion (opt-in via `prefers-reduced-motion`).
- No layout change to the enclosing card's borders, header, or caption row.

## Composition

Side elevation, left-to-right flow, rendered as an SVG scene that fills the existing `pharos-chart-stage` slot inside the Exit Route Map card. The scene is stacked vertically in three bands:

| Band | Y range (viewBox 1000×480) | Contents |
| --- | --- | --- |
| **Sky** | 0 – 140 | Dark-to-midnight gradient, sparse stars, distant headland with Pharos lighthouse and a faint beam |
| **Canal** | 140 – 380 | Upstream wall · lock gates · aggregate TVL body · dam wall · delta of chain basins |
| **Sea** | 380 – 480 | Gentle wave lines receding to open water |

### Data mapping

| Data | Visual element | Encoding |
| --- | --- | --- |
| `model.protocolRows[i]` (top 5 + "Other") | **Lock gate** (vertical rectangle within housing) | Open width = share of TVL; fill colour = protocol colour; protocol chip at centre; $ amount + % below |
| `model.chainRows[i]` (top 5 + "Other") | **Delta basin** (horizontal pool panel on the right) | Height = share of TVL; fill colour = chain colour; chain label + $ + % right-aligned |
| `model.totalTvlUsd` | **Canal water body** (central band) | Displayed as large numeric in the centre of the canal, above "Secondary Exit TVL" label |
| `model.topProtocol` / `model.topChain` | **Caption row** (below scene) | Already exists — text updates from "Leading door / Leading lane" to "Leading gate / Leading basin" |
| — (no data) | **Upstream wall** (left) | Decorative: represents holders exerting pressure on the canal. No metric attached. |
| — (no data) | **Pharos lighthouse** (distant headland, upper-right) | Brand cue. Static faint beam. |
| — (no data) | **Vessel** (mid-canal, between gates and dam) | Subject-of-scene. Represents exiting liquidity. Optional subtle drift animation. |
| — (no data) | **Dam wall** (between canal and delta) | Structural separator between aggregate pool and chain delta. |

### Nomenclature changes

The current scene has three column headers (`PROTOCOL GATES`, `EXIT CONCOURSE`, `CHAIN LANES`) at lines 317–320 of the component. In the canal scene these column headers are **removed** — the scene's geography (gates on the left, basin in the middle, delta on the right) carries the wayfinding without explicit headers. Two small in-scene labels replace them:

- **`UPSTREAM · HOLDERS`** — small kicker above the upstream wall (left edge of canal)
- **`SECONDARY EXIT TVL`** — kicker under the central `$XB` numeric
- **`OPEN SEA`** — small kicker at the right edge of the sea band

Copy updates in the caption row below the scene (inside `LiquidityExitRouteMap`, lines 511–516):

| Old | New |
| --- | --- |
| "Leading door" | **"Leading gate"** |
| "Leading lane" | **"Leading basin"** |

The sidebar metric labels (`Open routes`, `Crowding index`, `Pool balance`, `Organic`) and their copy stay exactly as they are. "Open routes" still reads well — each open lock gate *is* an open route.

### `data-testid` renames

The test file (`src/components/__tests__/liquidity-stats.test.ts`, lines 215–219) asserts the presence of these testids. Rename alongside the visual overhaul:

| Old testid | New testid |
| --- | --- |
| `exit-route-terminal` | `exit-route-canal` |
| `exit-concourse` | `exit-canal` |
| `chain-lane-<key>` | `chain-basin-<key>` |
| `protocol-gate-<key>` | **retained** — accurate for a lock gate |
| `protocol-gate-_other-routes` | **retained** |

The `data-crowding-band` attribute on `exit-concourse` → `exit-canal` is retained — the crowding-band mechanic stays (a subtle visual cue when HHI concentration crosses a threshold; now rendered as a narrowing indicator in the canal's dominant channel rather than as a band).

### Stats sidebar

Unchanged in position, contents, and styling. The `xl:grid-cols-[minmax(0,1fr)_14rem]` wrapper stays. The four `ExitRouteMetric` cards (Open routes · Crowding index · Pool balance · Organic) are preserved verbatim. Their icons (`DoorOpen`, `Gauge`, `Split`, `Route`) stay, since they still map metaphorically (gate → door, balance → split).

### Animation

Default: **static**. The scene reads as an illustrated moment.

Optional ambient motion (behind `@media (prefers-reduced-motion: no-preference)`):

- Vessel drifts rightward with a 12s linear loop; wake fades with opacity keyframes.
- Lighthouse beam sweeps through a narrow arc on a 10s loop.
- Sea wave lines shift phase on a 6s loop for subtle shimmer.

Motion is a progressive enhancement — the scene must still make full sense with all three disabled.

### Responsive behaviour

- **≥ xl (≥ 1280px):** Full scene as specified, sidebar adjacent.
- **md–lg:** Sidebar wraps below scene (the existing `xl:grid-cols-*` breakpoint already handles this). Scene keeps aspect ratio.
- **sm:** Scene compresses vertically but preserves layout. Lighthouse hides below 640px to reduce clutter. Protocol chips switch to two-line label (icon + $, percentage drops). Delta basin labels shorten ($ only, chain abbreviated).
- **Minimum legibility test:** at 360px wide, the six lock gates still render with distinguishable widths and readable percentages.

## Implementation Surface

Single component file change: `src/components/liquidity-stats.tsx`.

### Changes required

1. **Replace** the `ExitRouteTerminal` component body with a new `ExitRouteCanalScene` component that renders the SVG scene.
2. **Update** the caption row copy in `LiquidityExitRouteMap`: "Leading door" → "Leading gate", "Leading lane" → "Leading basin".
3. **Keep** the `ExitRouteMetric` sidebar cards verbatim.
4. **Keep** the `buildLiquidityExitRouteModel` function and its output shape unchanged.

### New CSS (scoped)

One new class block in the matching stylesheet (`src/app/chains/nautical-chart.css` pattern → a new `exit-route-canal.css` or added to an existing liquidity-stats stylesheet). Contains:

- SVG gradient definitions (sky, canal water, sea)
- Colour tokens for lock gate states (active, "other" dimmed)
- Keyframes for the three optional animations, all behind `prefers-reduced-motion`

### Tests to update

- `src/components/__tests__/liquidity-stats.test.ts` asserts the presence of `data-testid` attributes on the scene (lines 215–219) and the `data-crowding-band` attribute on the concourse element. Update testid assertions per the rename table above. Data-model assertions (lines 30–172) remain unchanged.

### Out of scope (explicitly)

- Sidebar stat reordering or relabeling.
- Any change to `buildLiquidityExitRouteModel` or `LiquidityStatsData` shape.
- Changes to `ChainAggregateBar` / `ProtocolAggregateBar` components below the Exit Route Map.
- Changes to the `/liquidity` page layout, card ordering, or the six summary stat cards above.
- Changes to methodology copy or the liquidity-score changelog.

## Success Criteria

1. The Exit Route Map card renders the canal & locks scene with the exact same data as today.
2. All existing `liquidity-stats.test.ts` assertions pass (after label updates).
3. `npm run build` and `cd worker && npx tsc --noEmit` both succeed.
4. At ≥1280px, the scene is visually coherent: lock-gate widths are proportional to the percentages shown; chain basins are ordered by size; lighthouse beam is visible but not dominant.
5. With `prefers-reduced-motion: reduce`, no motion triggers; the static frame is fully legible.
6. Visual comparison to V2 mockup: the live render matches the approved mockup's layout and hierarchy within normal implementation tolerance.

## Risks & Tradeoffs

- **Illustration risk:** the scene has more visual ink than a chart. Mitigation: data elements (gate widths, basin heights, TVL numeric) are the visual focus; atmospheric elements (vessel, lighthouse, stars) are dim and dismissible at small viewports.
- **Brand cannibalisation:** `/chains` already uses the Pharos lighthouse as its hero. Here the lighthouse is a distant background cue on a small headland — not the subject. This is the same "family-of-scenes" pattern that PSI uses.
- **Responsive fidelity:** six lock gates across a narrow viewport get tight. The small-screen degradation above is not gratuitous — it's required for the visual to survive 360px.
- **Snapshot test churn:** if any snapshot tests cover the SVG output of `ExitRouteTerminal`, they need regenerating. The logic-level tests should remain intact.

## Open Questions

None blocking. The three that came up during brainstorming and were resolved:

1. *Side elevation vs top-down plan vs isometric?* — Side elevation (sturdiest, closest to current data layout, lowest build cost).
2. *Tight diagrammatic vs scene-forward?* — Scene-forward (the atmospheric chrome earns its place; the schematic underneath is fully preserved).
3. *Extend or replace the sidebar stats?* — Extend-not-replace. Sidebar stays exactly as-is.
