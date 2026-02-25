# Report Cards

Multi-dimensional safety grades (A+ through F) for every tracked stablecoin. Computed on-demand by the API from live data.

## Overall Grade

Weighted sum of 6 dimension scores (each 0–100), mapped to a letter grade. NR dimensions have their weight redistributed proportionally among rated dimensions. Requires at least 3 rated dimensions; otherwise overall = NR. Cemetery coins get a permanent F.

## Dimensions

| Dimension | Weight | Source | Scoring |
|-----------|--------|--------|---------|
| **Peg Stability** | 25% | `pegScore` from peg summary | Passthrough. Cap at 65 if active depeg. +3 bonus if no events in 12+ months. NAV tokens → NR |
| **Liquidity** | 25% | `liquidityScore` from DEX liquidity | Passthrough. −5 if HHI > 0.5, −10 if HHI > 0.8 |
| **Safety** | 20% | Bluechip SMIDGE rating | Grade-to-score mapping (A+ → 100 … F → 25). NR if no rating |
| **Resilience** | 15% | Chain count (60%) + freeze rate (40%) | See sub-scores below |
| **Decentralization** | 10% | Governance type from stablecoin metadata | `decentralized` → 95, `centralized-dependent` → 70, `centralized` → 50 |
| **Dependency Risk** | 5% | Upstream stablecoin scores | Non-dependent → 95. CeFi-Dependent → avg of upstream scores, −10 if any < 75. NR if unmapped |

### Peg Stability Details

- Uses `computePegScore()` output over 4-year tracking window
- Active depeg caps score at 65 (C grade) regardless of historical performance
- Clean 12-month streak awards +3 bonus points
- NAV tokens (yield-accruing, price-appreciating) receive NR — peg tracking not applicable
- Yield-bearing annotation added to detail text

### Liquidity Details

- Base score from DEX liquidity scoring system (see `docs/dex-liquidity.md`)
- Concentration penalty via Herfindahl-Hirschman Index:
  - HHI > 0.8: −10 (nearly single-pool concentration)
  - HHI > 0.5: −5 (moderate concentration)

### Safety Details

Bluechip grade passthrough:

| Bluechip Grade | Score |
|----------------|-------|
| A+ | 100 |
| A | 95 |
| A- | 90 |
| B+ | 85 |
| B | 80 |
| B- | 75 |
| C+ | 70 |
| C | 65 |
| C- | 60 |
| D | 50 |
| F | 25 |

### Resilience Sub-Scores

**Chain distribution (60% weight):**

| Chains | Score |
|--------|-------|
| 1 | 40 |
| 2 | 55 |
| 3 | 65 |
| 4–5 | 75 |
| 6–8 | 85 |
| 9+ | 95 |

**Freeze event rate (40% weight):**
- Formula: `100 − (events_per_month × 2)`, clamped 0–100
- Applies to USDC, USDT, PAXG, XAUT (coins with tracked freeze/blacklist events)
- Coins without freeze capability: 85 (neutral)

### Dependency Risk Details

Two-phase computation ensures upstream scores are available before dependent coins are graded:

1. **Phase 1**: Grade `centralized` + `decentralized` coins (no upstream dependencies)
2. **Phase 2**: Grade `centralized-dependent` coins using Phase 1 scores

For Phase 2 coins:
- Score = weighted average of upstream stablecoins' overall scores, using collateral weights from `DependencyWeight[]` (e.g., a coin backed 60% USDC + 40% USDT weights those upstream scores accordingly)
- −10 penalty if any dependency scores below 75 (B-)
- Falls back to 70 if dependencies aren't mapped or scores unavailable

## Grade Thresholds

| Grade | Min Score |
|-------|-----------|
| A+ | 97 |
| A | 93 |
| A- | 90 |
| B+ | 85 |
| B | 80 |
| B- | 75 |
| C+ | 70 |
| C | 65 |
| C- | 60 |
| D | 50 |
| F | 0 |
| NR | null score |

## Grade Colors

| Range | Badge (Tailwind) | Radar (hex) |
|-------|-------------------|-------------|
| A (A+, A, A-) | emerald-500 | `#10b981` |
| B (B+, B, B-) | blue-500 | `#3b82f6` |
| C (C+, C, C-) | amber-500 | `#f59e0b` |
| D | orange-500 | `#f97316` |
| F | red-500 | `#ef4444` |
| NR | muted | `#71717a` |

## API

`GET /api/report-cards` — all coins graded with per-dimension breakdown and methodology metadata. Cache: standard (5-min edge).

Response includes `cards` (array of `ReportCard` with `rawInputs` for client-side recomputation), `dependencyGraph` (forward edges for dependency traversal), `methodology` (version, weights, thresholds), and `updatedAt`. See `docs/api-reference.md` for full response shape.

Key types:
- **`DependencyWeight`**: `{ id: string; weight: number }` — upstream stablecoin ID + collateral fraction (0–1). Replaces the old `string[]` dependency format.
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `liquidityScore`, `concentrationHhi`, `bluechipGrade`, `chainCount`, `freezeEventsPerMonth`, `governanceTier`, `dependencies`, etc.) — enables client-side stress test recomputation.

## Portfolio Analyzer & Stress Test

Collapsible panel on `/report-cards` between the grade distribution bar and card grid. Two sections stacked vertically:

### Portfolio Analyzer

Users enter stablecoin holdings (coin + USD amount). Derived computations (all client-side):

- **Portfolio grade**: `sum(coinScore × coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded.
- **Portfolio radar**: Same weighted average per dimension. Displays via `ReportCardRadar` with a synthetic `ReportCard`.
- **Upstream exposure**: Walks `dependencies` using collateral weights. Direct CeFi holdings attribute 100% to themselves. Aggregates by upstream coin ID. Shows concentration warning when any single upstream exceeds 80%.

State: `usePortfolio` hook. Sources (priority): URL `?p=usdc:50000,dai:5000` → `localStorage` → empty. Shared links don't overwrite saved portfolio.

### Interactive Stress Test

Users simulate a grade downgrade for any upstream coin and watch cascading grade changes:

- **Coin selector**: Filtered to coins appearing as `from` in `dependencyGraph.edges`, sorted by dependent count.
- **Grade selector**: Only downgrades from the coin's current grade to F.
- **Recomputation**: `computeStressedGrades()` injects a synthetic score, recomputes only the Dependency Risk dimension for affected downstream coins. ~142 coins × 6 dimensions = <1ms, no debouncing needed.
- **Two display modes**: Portfolio mode (dollar-denominated, scoped to held coins in impact table) vs ecosystem mode (all affected coins with market cap).
- **Card grid simulation**: ALL affected coins show dashed amber borders + "Simulated" badge regardless of portfolio mode. Unaffected cards dimmed. Sticky banner with clear button.

State: `useStressTest` hook. URL sync: `?stress=usdc&grade=D`.

## Frontend

- **Grid page**: `src/app/report-cards/client.tsx` — filterable/sortable grid of grade cards with grade distribution bar, portfolio/stress panel integration, simulation mode
- **Portfolio & stress panel**: `src/components/portfolio-stress-panel.tsx` — collapsible panel with holdings editor, portfolio grade/radar/exposure, stress test controls + impact table
- **Detail card**: `src/components/report-card.tsx` — full radar chart + dimension breakdown
- **Mini card**: `src/components/report-card-mini.tsx` — compact grid tile with simulation support (dashed border, before→after grade, "Simulated" badge)
- **Radar chart**: `src/components/radar-chart.tsx` — hexagonal Recharts radar with `ReportCardRadar` (single) and `CompareRadar` (multi-coin overlay)
- **Hooks**: `src/hooks/use-report-cards.ts` (TanStack Query), `src/hooks/use-portfolio.ts` (portfolio state + localStorage + URL sync), `src/hooks/use-stress-test.ts` (stress test state + recomputation)

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/report-cards.ts` | Pure grading engine: dimension scorers, weights, thresholds, colors, `computeStressedGrades()` |
| `worker/src/api/report-cards.ts` | API handler: data loading, two-phase computation, `rawInputs`, `dependencyGraph`, response |
| `src/components/portfolio-stress-panel.tsx` | Combined portfolio analyzer + stress test collapsible panel |
| `src/components/report-card.tsx` | Full detail card with radar |
| `src/components/report-card-mini.tsx` | Compact grid tile with simulation mode support |
| `src/components/radar-chart.tsx` | Recharts radar visualization |
| `src/app/report-cards/client.tsx` | Full page with filtering, sorting, grade distribution, simulation mode |
| `src/hooks/use-report-cards.ts` | TanStack Query hook |
| `src/hooks/use-portfolio.ts` | Portfolio holdings state, localStorage persistence, URL sync, upstream exposure |
| `src/hooks/use-stress-test.ts` | Stress test state, `computeStressedGrades` invocation, impact calculation |
