# Risk Lab Cleanup — Portfolio Removal + Systemic Risk Scoreboard

**Date:** 2026-02-26
**Status:** Approved

## Goal

Remove the portfolio analyzer from the Risk Lab page. Keep report cards and contagion simulation. Add a pre-computed Systemic Risk Scoreboard that shows the most dangerous failure scenarios without requiring user interaction.

## Decisions

- **Portfolio**: Delete entirely — component, hook, URL param sync, localStorage persistence
- **Contagion scope**: Ecosystem-only (no personal holdings)
- **Layout**: Single page, two sections (contagion panel + card grid)
- **Legacy `?p=` URLs**: Silently ignored
- **New feature**: Systemic Risk Scoreboard in the contagion panel

## What Gets Deleted

| File | Action |
|------|--------|
| `src/components/portfolio-panel.tsx` | Delete |
| `src/hooks/use-portfolio.ts` | Delete |
| `src/components/coin-selector.tsx` | Delete if only used by portfolio panel |

## What Gets Modified

### `src/hooks/use-stress-test.ts`

- Remove `holdings` parameter — no `PortfolioHolding` import
- Remove `holdingMap`, all `isPortfolioMode` branches
- Impacts always show all ecosystem-affected coins (no portfolio filter)
- Headline always ecosystem mode: affected count + supply at risk
- Remove `holdingUsd` from `StressTestImpact`
- Add `systemicRisks` to return value: top 5 pre-computed worst-case scenarios

### `src/components/stress-test-panel.tsx`

- Remove `portfolio` prop
- Remove `portfolioStressHeadline` memo
- Headline: "X coins affected. $Y supply at risk."
- Impact table: always show "Mkt Cap" column (no "Holding" toggle)
- Remove collapsible behavior — panel always visible
- Add Systemic Risk Scoreboard section above manual controls
- Each scoreboard row: coin name, affected count, supply at risk, [Simulate] button

### `src/app/risk-lab/client.tsx`

- Remove `usePortfolio` import and call
- Remove `PortfolioPanel` import and render
- Remove portfolio URL sync (`?p=` param handling)
- Remove 2-column grid layout (was portfolio + contagion side by side)
- Contagion panel renders full-width in its own row
- Pass simplified props to `StressTestPanel`

### `src/app/risk-lab/page.tsx`

- Update metadata: remove "portfolio risk analysis" from description

### `src/lib/nav-config.ts`

- Update description: "Safety grades and contagion simulation"

## Systemic Risk Scoreboard

Pre-compute the top 5 most damaging single-coin failure scenarios client-side on page load.

**Algorithm:**
1. Take the `targetableCoins` list (coins that have dependents)
2. For each, simulate a downgrade to D using `computeStressedGrades`
3. Count affected coins and sum their market cap as "supply at risk"
4. Sort by supply at risk descending, take top 5

**Computation is cheap** — `computeStressedGrades` runs client-side, ~5 iterations over the card array. Memoized so it only recomputes when cards or mcapMap change.

**UI:**

```
┌─────────────────────────────────────────────────┐
│ 🔴 Contagion Map                                │
│                                                 │
│ Biggest systemic risks:                         │
│  1. USDC fails → 42 coins, $18.2B at risk  [▶] │
│  2. USDT fails → 15 coins, $4.1B at risk   [▶] │
│  3. DAI fails  →  8 coins, $1.3B at risk   [▶] │
│                                                 │
│ ─────────── or simulate your own ────────────── │
│  [Target Coin ▾]          [Downgrade To ▾]      │
│                                                 │
│ (impact table + headline shown when active)     │
└─────────────────────────────────────────────────┘
```

Clicking [▶] on a scoreboard row sets the target coin to that coin and grade to D, triggering the existing simulation flow. The card grid below lights up with affected cards.

## Page Layout After Changes

```
┌─────────────────────────────────┐
│ Grade Distribution Bar          │
├─────────────────────────────────┤
│ Contagion Map (always visible)  │
│  Systemic Risk Scoreboard       │
│  Manual: [Target ▾] [Grade ▾]  │
│  Headline + Impact table        │
├─────────────────────────────────┤
│ [Simulation banner if active]   │
├─────────────────────────────────┤
│ Filter: All A B C D F NR        │
│ Sort: Overall Peg Liq ...       │
├─────────────────────────────────┤
│ Card grid (2-5 cols)            │
└─────────────────────────────────┘
```

## What Stays Unchanged

- `src/lib/report-cards.ts` — grading engine, `computeStressedGrades`, scoring
- `src/components/report-card-mini.tsx` — grid cards, simulation highlighting
- `src/components/report-card.tsx` — detail page card
- `src/components/grade-badge.tsx`
- `src/hooks/use-report-cards.ts`
- All API endpoints
- `src/components/report-cards-summary.tsx` — homepage widget (links to /risk-lab)
