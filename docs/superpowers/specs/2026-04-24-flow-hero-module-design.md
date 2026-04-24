# Unified Mint/Burn Flow Hero Module — Design

**Date:** 2026-04-24
**Scope:** `/flows/` page — harmonize `FlowBrrrOverview` (top) and `FlowPressureReceipt` (bottom) into one coherent module.

## Problem

The `/flows/` page currently stacks two overview modules:

1. **`FlowBrrrOverview`** (`src/components/flow-brrr-overview.tsx`): direction/pressure/FTQ badges, headline + description, a 3-tile 24h mint/burn/net grid, a 3-tile 7d mint/burn/net grid, Bank Run Gauge lever, printer/shredder animation (`FlowMachineScene`), top-minter/burner pair, `MintingPressureGauge`.
2. **`FlowPressureReceipt`** (`src/components/flow-pressure-receipt.tsx`): receipt-styled card with the same 6 mint/burn/net tiles, plus a scope aside containing top-minter/burner, coverage pills, and sync warning.

The 6 data tiles and the top-minter/burner pair render twice. The user prefers the receipt rendering of the numeric tallies but wants to keep the printer/shredder scene, Bank Run Gauge, and Minting Pressure Gauge from the overview.

## Goal

One coherent mint/burn flow overview module. Each data point rendered once. Preserve the scene, the Bank Run Gauge lever, the Minting Pressure Gauge, and the receipt aesthetic for the numeric tallies.

## Design

Single `<article>` card with two internal registers:

### Register 1 — Hero (top)

- Badge row: direction, pressure, FTQ (when present).
- Two-column grid:
  - **Left column**: headline (colored, large), description paragraph, Bank Run Gauge lever (gradient bar + thumb + methodology-labelled caption).
  - **Right column**: `FlowMachineScene` (printer/shredder), `MintingPressureGauge` stacked underneath.
- The two 3-tile grids (24h, 7d) currently in the left column are **removed**.
- The top-minter/burner pair currently in the right column is **removed**.
- The Bank Run Gauge lever moves up to occupy the vertical space freed by removing the tile grids.

### Register 2 — Receipt band (bottom, inside the same card)

- Separated from the hero above by a dashed "tear-line" border (or an `<hr>`-style dashed rule).
- Preserves the receipt aesthetic: gradient stripe along the top edge of the band, `ReceiptText` icon beside the title, monospace `tabular-nums` for values.
- Title row: "Flow receipt" kicker + "Printer and shredder accounting" heading + tracked-coin count pill on the right.
- **6-tile grid** (2 rows × 3 cols on wide viewports, responsive down):
  - Row 1: Printed 24h · Shredded 24h · Net 24h
  - Row 2: Printed 7d · Shredded 7d · Net 7d
  - Each tile = label (uppercase kicker), value (tone-coloured mono), detail line.
- **Aside-as-row** below the tiles (single horizontal strip, wraps on narrow widths):
  - Scope label + one-line caption.
  - Top minter (tone-coloured symbol + signed currency).
  - Top burner (tone-coloured symbol + signed currency).
  - Coverage summary (e.g. "Covered window") + coverage pills ("full 180", "partial 12", "lagging 3").
  - Sync warning (amber panel) if present.

### Visual sketch

```
┌─ article.card ────────────────────────────────────────────────┐
│ [direction] [pressure] [FTQ?]                                 │
│                                                               │
│ ┌ left ──────────────┐  ┌ right ─────────────────┐            │
│ │ Headline           │  │ FlowMachineScene       │            │
│ │ Description        │  │                        │            │
│ │ Bank Run Gauge     │  │ MintingPressureGauge   │            │
│ └────────────────────┘  └────────────────────────┘            │
│                                                               │
│ - - - - - - - - dashed tear line - - - - - - - -              │
│                                                               │
│ ┌ receipt band (gradient stripe on top) ────────────────────┐ │
│ │ [Flow receipt]  Printer and shredder accounting  [N coins]│ │
│ │ ┌────────┐┌────────┐┌────────┐                            │ │
│ │ │PRINTED ││SHREDDED││NET 24H │                            │ │
│ │ │ 24H    ││ 24H    ││        │                            │ │
│ │ └────────┘└────────┘└────────┘                            │ │
│ │ ┌────────┐┌────────┐┌────────┐                            │ │
│ │ │PRINTED ││SHREDDED││NET 7D  │                            │ │
│ │ │ 7D     ││ 7D     ││        │                            │ │
│ │ └────────┘└────────┘└────────┘                            │ │
│ │                                                           │ │
│ │ Scope · Top minter · Top burner · Coverage · [warn]       │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

## Component and data changes

### `src/components/flow-brrr-overview.tsx`

- `FlowBrrrOverview` remains the only module rendered from `src/app/flows/client.tsx` under `<section aria-label="Mint/burn overview">`.
- Inside it, render a new internal sub-component — `FlowReceiptBand` — below the existing hero content. This is either inlined or lifted into `src/components/flow-receipt-band.tsx` (preferred for file size discipline, since `flow-brrr-overview.tsx` is already ~400 lines).
- `FlowBrrrOverview` passes `gauge`, `coins`, `weeklyHourly`, `scopeLabel`, `syncWarning` down to the receipt band. The new `scopeLabel` and `syncWarning` props must be added to `FlowBrrrOverviewProps`.
- `buildSnapshot` is trimmed: fields consumed only by the removed tile grids (`mint24h`, `burn24h`, `mint7d`, `burn7d`, `net24h`, `net7d`, `topMint`, `topBurn`) move to the receipt model or are computed from the snapshot's existing totals — keep whichever avoids duplicated summation. The scene/gauge-driving fields (`score`, `netDirection`, `pressureState`, `directionUi`, `pressureUi`, `leverPct`, `has24hActivity`, `headline`, `description`, `trackedCoins`, `sceneIntensity`, `sceneStress`) stay.
- The removed left-column tile grids, the removed right-column top-minter/burner sub-grid, and the methodology-labelled Bank Run Gauge block are rearranged so the lever fills the freed space in the left column.

### `src/components/flow-pressure-receipt.tsx`

- The standalone component + its export are retired. The new `FlowReceiptBand` takes its place as an internal concern of `FlowBrrrOverview`.
- `buildFlowPressureReceiptModel` in `src/lib/flow-pressure-receipt-model.ts` **stays** — it is the source of truth for tile values, tone, labels, top-minter/burner, coverage rows, and coverage summary. Only the caller changes.
- The prior "`-mt-2` receipt stacked underneath the overview" pattern is removed. The band sits inside the outer card with normal flow.

### `src/app/flows/client.tsx`

- Remove the standalone `<FlowPressureReceipt ... />` call.
- Remove the `<p className="mt-3 text-xs text-muted-foreground">Coverage badges flag coins...` caption — the coverage pills + summary already communicate this.
- Pass `scopeLabel` and `syncWarning` into `<FlowBrrrOverview />`.
- The import of `FlowPressureReceipt` is deleted.

### Homepage (`homepage-flow-overview.tsx`)

- `FlowBrrrOverview` is rendered on the homepage with `variant="compact"` (`src/components/homepage-flow-overview.tsx:48`). The receipt band must **not** appear in compact variant.
- Gate rendering on `variant !== "compact"`. No new prop required. The homepage continues to pass only `gauge`, `coins`, `weeklyHourly`, `isLoading`, `variant="compact"` — it does not need `scopeLabel` or `syncWarning`, so those props are typed optional with sensible defaults.

## Styling

- **Card container**: keep current `rounded-2xl border bg-card` plus radial-gradient backdrop. No aesthetic change.
- **Tear line**: `border-t border-dashed border-border/70` with `mt-5 pt-5` above the receipt band, or a dedicated `<hr className="border-dashed border-border/70" />` — match whichever already appears in the codebase.
- **Receipt band background**: retain the `border border-dashed border-border/80 bg-card/85` + gradient top stripe from `FlowPressureReceipt`. Remove the outer `rounded-xl shadow-sm` since it now sits inside the card; a `rounded-lg` with no shadow is sufficient.
- **Tile tones**: re-use the existing `toneClass` from the receipt.
- **Aside-as-row**: single `flex flex-wrap gap-x-6 gap-y-2` strip. Each datum is a `<div>` with an inline label + value. Coverage pills inline after the coverage summary. Sync warning gets its own full-width row below the strip (amber panel, same styling as today).

## Responsive behaviour

- Hero 2-column grid collapses to single column below `lg:` (already the case).
- Receipt tile grid: `grid-cols-2 xl:grid-cols-3` matches today's receipt; keep it, but the 6 tiles now fill 2 rows × 3 cols above `xl` and 3 rows × 2 cols below.
- Aside-as-row wraps on narrow widths via `flex-wrap`.

## Accessibility

- Keep `aria-labelledby="flow-pressure-receipt-heading"` on the band (rename heading id to live inside the new scope if needed).
- The outer hero `<article>` gets a single `aria-label` equivalent to the current section label.
- Bank Run Gauge `role="img"` and `aria-label` stay.

## Tests

- Existing `/flows/` page test (`src/app/flows/page.test.tsx`) mocks `FlowBrrrOverview` and should continue to pass unchanged.
- `src/components/__tests__/flow-pressure-receipt.test.tsx` — re-point at `FlowReceiptBand` (same model inputs, same assertions on tile values, coverage, sync warning). File renamed to `flow-receipt-band.test.tsx` to match the new component name.
- `src/lib/__tests__/flow-pressure-receipt-model.test.ts` — unchanged; covers `buildFlowPressureReceiptModel` which is preserved as-is.
- No new test fixtures required — the receipt model is unchanged.

## Out of scope

- No changes to `FlowMachineScene`, `MintingPressureGauge`, or the Bank Run Gauge math.
- No changes to `FlowTable`, `FlowChart`, methodology labels, tooltip topics, or the `FLOWS_SHELL_PROPS` copy.
- No methodology version bump — rendering change only, data sources unchanged.

## Migration notes

- `docs/mint-burn-flows.md` (line ~656) has a component inventory row for `FlowBrrrOverview`; update the description to reflect that the receipt band is now folded in.
- The on-page header supplement still surfaces `syncWarning` at page level. Dual display (page-level + receipt-local) is intentional and unchanged.
