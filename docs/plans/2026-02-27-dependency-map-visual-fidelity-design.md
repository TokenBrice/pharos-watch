# Dependency Map Visual Fidelity Refinement

**Date:** 2026-02-27
**Status:** Approved
**Goal:** Make the existing dependency weight, type, and direction data visually legible in the contagion graph through progressive disclosure.

## Context

The dependency map currently renders all edges identically — neutral gray lines with barely distinguishable width. We have three dimensions of data that are invisible:

1. **Weight** — fraction of collateral from upstream (0–1), stored in `DependencyWeight.weight`
2. **Type** — wrapper / mechanism / collateral, stored in `DependencyWeight.type`
3. **Direction** — who depends on whom, implicit in the source→target of each edge

Reserve composition data (`reserves[]`) provides the precise percentages that inform dependency weights, but the graph doesn't expose any of this.

## Design

### 1. Edge Weight Encoding (always visible)

- **Stroke width:** `1 + weight × 5` — ranges 1px (weight=0) to 6px (weight=1.0)
- **Stroke opacity:** `0.15 + weight × 0.45` — ranges 15% to 60%
- Heavy dependencies (USDTB→BUILD at 90%) visually dominate; light ones (GHO→USDC at 10%) recede

### 2. Direction — Arrowheads (always visible)

- SVG `<marker>` elements for arrowheads on each edge
- **Direction:** upstream → dependent (collateral flow). BUILD → USDTB reads as "BUILD backs USDTB"
- Arrowhead base: 6×4px, scales up to 8×6px for heaviest edges
- Arrow tip offset by target node radius so it touches the circle boundary
- Marker color matches edge stroke color (gray default, type color on hover)

### 3. Dependency Type Encoding (progressive disclosure)

**Default:** All edges are neutral gray — type hidden.

**On hover (edge or node):** Hovered edges shift to type-encoded style:

| Type | Dash Pattern | Color | Semantics |
|------|-------------|-------|-----------|
| Collateral | Solid | Blue-gray | Standard backing (default/common) |
| Mechanism | Dashed | Amber/orange | Critical peg infrastructure |
| Wrapper | Dotted | Purple | Thin layer around upstream |

**Toggle control:** "Show types" pill/switch near the legend. When on, all edges display type encoding permanently.

**Legend:** Extended with an "Edge Types" section showing the three styles.

### 4. Edge Tooltips

On edge hover, a tooltip appears:

```
BUILD → USDTB
90% · collateral
```

- Line 1: `{upstream symbol} → {dependent symbol}`
- Line 2: `{weight as %}` · `{type label}`
- Styled to match existing node tooltip aesthetic
- Wide invisible hit area (12px stroke) behind each edge for hovering thin edges

### 5. Node Hover Highlights

On node hover:
- **Connected edges:** Highlight with full type encoding (color + dash). Slight opacity/width bump.
- **Unconnected edges:** Fade to ~5% opacity.
- **Connected nodes:** Stay fully visible.
- **Unconnected nodes:** Dim to ~40% opacity.
- Existing node tooltip (symbol, grade, mcap) unchanged.

## Files Affected

- `src/components/contagion-graph.tsx` — all rendering changes (edges, markers, tooltips, hover logic)
- `src/lib/types.ts` — no changes needed (DependencyType and DependencyWeight already exist)
- `src/lib/stablecoins.ts` — no changes needed (dependency data already present)

## Out of Scope

- Reserve composition display in the graph (stays on detail pages/report cards)
- New API endpoints
- Analytical features (scenario analysis, blast radius calculation)
- Changes to node rendering (circles, logos, grade rings)
