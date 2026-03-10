# Compare Page Enhancements — Design Spec

**Date:** 2026-03-10
**Status:** Approved
**Scope:** `/compare` page (`src/app/compare/`)

---

## Overview

Three targeted additions to the compare page to surface on-chain flow intelligence and historical depth alongside the existing side-by-side metrics table.

1. **Net Flow 30D row** in the comparison table
2. **Live Flow Signals section** (new, between table and charts) with per-coin flow cards + net flow comparison chart
3. **Peg Deviation History chart** (new, in charts grid — conditional on data availability)

---

## 1. Comparison Table: Net Flow 30D Row

### Position
Below the existing Safety Grade row (currently the last row).

### Display
- **Label:** "Net Flow 30D"
- **Value per coin:** total net minting over 30 days in USD, formatted as `formatCurrency`
- **Color:** green if positive (net minting), red if negative (net burning), muted if null/NR
- **Direction arrow:** `▲` prefix if positive, `▼` if negative
- **"Not tracked"** fallback in muted text for coins without mint/burn coverage

### Data source
`useMintBurnFlows(720)` — aggregate endpoint with `hours=720`. Response includes `coins[]` with `netFlowUsd` summed over the period. Filter by selected coin IDs.

A new hook variant `useMintBurnFlows30d` (or pass `hours` param to existing hook) is needed. Check `src/hooks/use-mint-burn-flows.ts` — `useMintBurnFlows` already accepts an optional `hours` param; use `useMintBurnFlows(720)`.

### Best-value highlighting
Apply existing `BEST_CLASS` (green bold) to the highest net flow value in the row (most minting), consistent with other metric rows.

---

## 2. Live Flow Signals Section

### Position
Between the comparison table and the charts grid. Only rendered when `selectedIds.length >= 2`.

### Structure

```
[section header: "Live Flow Signals" + data freshness label]
[per-coin flow cards grid]
[net flow comparison chart]
[coverage footnote]
```

### 2a. Per-coin flow cards

One card per selected coin, displayed in a responsive grid (1 col mobile, n-col desktop matching coin count, max 5).

Each card contains:
- **Coin identifier:** colored dot (COMPARE_COLORS[i]) + symbol
- **Net 24h:** formatted amount with direction arrow, colored green/red/amber per `getNetFlowDirection24h()`
- **Pressure vs 30D:** badge with band label (Confident / Cautious / Stress / etc.) and score, colored per band
- **Pressure bar:** thin 3px track, filled proportionally to `(pressureShiftScore + 100) / 200`, colored per band
- **Pressure description:** one-line human label (e.g. "Strong minting demand", "Heavy redemption pressure")
- **"Not tracked"** state: muted placeholder when coin has no mint/burn coverage

Band → color mapping reuses existing `getGaugeBand` colors from `shared/lib/mint-burn-signals.ts`.

### 2b. Net flow comparison chart

A line chart (Recharts `ComposedChart` or `LineChart`) overlaying all selected coins.

- **Y-axis:** net flow in USD (`formatCurrency` tick formatter)
- **X-axis:** time (hourly buckets, labeled by hour or date)
- **Series:** one `Line` per coin, color from `COMPARE_COLORS[i]`
- **Zero reference line:** `ReferenceLine` at y=0 with dashed stroke
- **Time range selector:** 24h / 7d / 30d pill buttons (shared state with existing range selector if feasible, otherwise independent)
- **Missing coin:** line simply absent (no error state per coin)
- **Tooltip:** shared crosshair showing all coin values at a given timestamp

Data source: `useMintBurnFlowsCoin(id, selectedHours)` per selected coin (parallel `useQueries`, same pattern as detail queries). Transform `hourly[]` array → `{ ts: hourTs * 1000, [coinId]: netFlowUsd }`.

Coins not in mint/burn tracking set are silently excluded from the chart (card shows "Not tracked").

### 2c. Section header
- Label: "Live Flow Signals"
- Right-aligned: "Updated N min ago · Ethereum" (derive from `updatedAt` timestamp in aggregate response)

### 2d. Coverage footnote
Small muted text below the chart: "Ethereum only · N of M selected coins tracked". Computed from how many selected coins appear in the aggregate `coins[]` response.

---

## 3. Peg Deviation History Chart

### Condition
**Implementation-contingent.** The current detail endpoint (`/api/stablecoin/:id`) sets `price: null` in `detailToSupplyHistory` (hardcoded). Price history is required for this chart.

**Investigation required during implementation:**
- Check whether `totalCirculatingUSD` / `totalCirculating` ratio in `DetailToken` yields a usable per-date price
- If yes: derive `price = sumCirculating(t.totalCirculatingUSD) / sumCirculating(t.totalCirculating)` in `detailToSupplyHistory`; populate the existing `price` field
- If not: the peg deviation chart is deferred to a follow-up

### Design (if data is available)

**Position:** Full-width card below supply + radar grid (spans both columns).

**Chart:** Recharts `LineChart`
- Y-axis: deviation from peg in % (`((price / pegRef) - 1) * 100`)
- X-axis: date (same time range as supply chart, shared `range` state)
- One `Line` per coin, colored per `COMPARE_COLORS[i]`
- `ReferenceLine` at y=0 ("$1.00 peg"), dashed
- Y-axis range: auto-scale ±0.5% typical, clamp to ±5% max to avoid depegged coins dominating the scale
- Tooltip: show price and deviation % per coin

**Peg reference:** uses existing `getPegReference(data.pegType, pegRates, meta.commodityOunces)` — same as the table's price column.

**If data unavailable:** chart is omitted silently (no error state, no placeholder).

---

## 4. Data Flow Summary

| Data needed | Source hook | New? |
|---|---|---|
| Per-coin 30D net flow (table row) | `useMintBurnFlows(720)` | New call (hours param) |
| Per-coin 24h flow cards | `useMintBurnFlows()` | New call |
| Per-coin hourly flow series (chart) | `useMintBurnFlowsCoin(id, hours)` × N | New per-coin queries |
| Peg price history | `useQueries` on `/api/stablecoin/:id` | Existing (extend if price derivable) |

The two aggregate calls (`useMintBurnFlows()` and `useMintBurnFlows(720)`) can be added to the existing data-loading block in `CompareClient`. Per-coin flow queries follow the same `useQueries` pattern already used for detail queries.

---

## 5. Graceful Degradation

- **No flow data for any coin:** Live Flow Signals section is hidden entirely
- **Partial coverage:** cards for untracked coins show "Not tracked" placeholder; chart lines for untracked coins are absent
- **Flow API error:** section shows `QueryErrorNotice` (reuse existing pattern)
- **Peg deviation data unavailable:** chart is silently omitted

---

## 6. Files to Modify

| File | Change |
|---|---|
| `src/app/compare/client.tsx` | Add flow data hooks, flow section rendering, range state for flow chart |
| `src/components/comparison-table.tsx` | Add Net Flow 30D row + best-value logic |
| `src/components/flow-comparison-chart.tsx` | **New component** — net flow lines chart |
| `src/components/coin-flow-card.tsx` | **New component** — per-coin flow summary card |

Keep `ComparisonTable` as a pure presentational component (pass `flowData` as prop). Keep flow chart and cards in their own files — they'll be dynamically imported via `dynamic()`.

---

## 7. Share Image

The canvas share image (`src/lib/compare-share-image.ts`) is **not updated** in this pass. Flow data is dynamic and doesn't translate well to a static export card. Revisit if needed.
