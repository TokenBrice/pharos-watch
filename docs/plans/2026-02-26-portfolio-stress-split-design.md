# Design: Split Portfolio & Stress Test into Two Separate Cards

**Date:** 2026-02-26
**Status:** Approved

## Problem

The current `PortfolioStressPanel` is a single collapsible card containing three logical sections: holdings management, portfolio analysis, and stress test. Users find it confusing because the portfolio tool and the contagion/stress test are distinct features with different purposes.

## Solution

Split `portfolio-stress-panel.tsx` into two independent components, each rendered as its own collapsible card on the Report Cards page.

## Components

### `PortfolioPanel` (`src/components/portfolio-panel.tsx`)

**Title:** "My Portfolio"
**Collapse:** Independently collapsible, starts collapsed
**Collapsed summary:** coin count + grade (e.g. "3 coins, B (82)")

**Contents:**
- Holdings list with `HoldingRow` (amount inputs, remove buttons)
- `CoinSelector` for adding coins
- Share / Clear action buttons
- Portfolio grade badge + total USD
- Radar chart (portfolio dimension scores)
- Upstream exposure bars + concentration warning

### `StressTestPanel` (`src/components/stress-test-panel.tsx`)

**Title:** "Contagion Map"
**Collapse:** Independently collapsible, starts collapsed
**Collapsed summary:** active scenario if set (e.g. "USDC → D")

**Contents:**
- Target coin `<select>`
- Downgrade-to `<select>`
- Headline stats (portfolio before/after grades, at-risk USD, affected count)
- Impact table (coin, holding, before grade, after grade, delta)
- Methodology note
- Clear simulation button

## Data Flow

Both hooks (`usePortfolio`, `useStressTest`) remain in `ReportCardsClient`. Props passed down:

```
ReportCardsClient
  ├── <PortfolioPanel portfolio={portfolio} cards={cards} logos={logos} />
  └── <StressTestPanel portfolio={portfolio} stressTest={stressTest} cards={cards} logos={logos} />
```

`StressTestPanel` receives `portfolio.holdings` (via the portfolio prop) to detect portfolio mode and show at-risk USD amounts. No logic changes — purely a structural split.

## File Changes

| Action | File |
|--------|------|
| Delete | `src/components/portfolio-stress-panel.tsx` |
| Create | `src/components/portfolio-panel.tsx` |
| Create | `src/components/stress-test-panel.tsx` |
| Update | `src/app/report-cards/client.tsx` — replace `<PortfolioStressPanel>` with two panel components |

## Shared Sub-components

`HoldingRow`, `GradeBadge`, `ExposureBar`, and formatting helpers (`formatUsd`, `parseUsdInput`, `severityArrow`) are used by both panels. They move into whichever file uses them — `HoldingRow`/`ExposureBar` into `portfolio-panel.tsx`, `GradeBadge` into both (duplicate the small component or extract to a shared file if it grows).

Given `GradeBadge` is used in both, extract it to `src/components/grade-badge.tsx` to avoid duplication.

## Page Order (unchanged)

1. Grade Distribution bar
2. **My Portfolio** card
3. **Contagion Map** card
4. Filter + Sort controls
5. Card grid
