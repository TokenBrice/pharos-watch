# Risk Lab

Multi-dimensional risk grades (A+ through F) for every tracked stablecoin. Computed on-demand by the API from live data.

## Overall Grade

Weighted sum of 5 dimension scores (each 0–100), mapped to a letter grade. NR dimensions have their weight redistributed proportionally among rated dimensions. Requires at least 3 rated dimensions; otherwise overall = NR. Cemetery coins get a permanent F.

## Dimensions

| Dimension | Weight | Source | Scoring |
|-----------|--------|--------|---------|
| **Peg Stability** | 25% | `pegScore` from peg summary | Passthrough. Cap at 65 if active depeg. +3 bonus if no events in 12+ months. NAV tokens → NR |
| **Liquidity** | 20% | `liquidityScore` from DEX liquidity | Passthrough. −5 if HHI > 0.5, −10 if HHI > 0.8 |
| **Resilience** | 20% | Token metadata (4 sub-factors) | Weighted avg of chain risk, collateral quality, custody model, and blacklist capability |
| **Decentralization** | 10% | Governance type + chain risk | Base: `decentralized` → 100, `centralized-dependent` → 50, `centralized` → 0. Chain-risk penalty applied for non-Ethereum chains |
| **Dependency Risk** | 25% | Upstream stablecoin scores | Non-dependent → 95. CeFi-Dependent → blended score (upstream × weight + self-backed × 75), −10 if any < 75. NR if unmapped |

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

### Resilience Details

4-factor weighted average (each sub-factor 25% of the resilience score):

| Sub-factor | Scoring | Tiers |
|---|---|---|
| **Chain Risk** | Where does the core protocol operate? | Ethereum (100), Stage 1+ L2 (66), Established alt-L1 (20), Unproven (0) |
| **Collateral Quality** | Trust assumptions in backing assets | Native ETH/BTC (100), Ethereum LSTs (66), RWA/off-chain (50), Alt-L1 LSTs/bridged (20), Exotic/opaque (0) |
| **Custody Model** | Who holds collateral? | On-chain (100), Institutional custodian (50), CEX/off-exchange (0) |
| **Blacklist Capability** | Can issuer freeze funds? | Not blacklistable (100), Blacklistable (0) |

**Default inference:** When sub-factor fields aren't explicitly set on `StablecoinMeta`, defaults are inferred from `backing` + `governance`:

| Backing + Governance | Chain Risk | Collateral Quality | Custody Model |
|---|---|---|---|
| `rwa-backed` + `centralized` | ethereum | rwa | institutional |
| `rwa-backed` + `centralized-dependent` | ethereum | rwa | institutional |
| `crypto-backed` + `decentralized` | ethereum | native | onchain |
| `crypto-backed` + `centralized-dependent` | ethereum | eth-lst | onchain |
| `algorithmic` + any | ethereum | native | onchain |

Explicit overrides exist for ~25 coins where defaults are incorrect (e.g. HYUSD on Solana, USDe with CEX custody).

Data sources: `chainRisk`, `collateralQuality`, `custodyModel` optional fields on `StablecoinMeta`. `canBeBlacklisted` field (falls back to governance type).

### Decentralization Details

Base score from governance type, then a chain-risk penalty for protocols on less decentralized chains. Governance decentralization is undermined when the underlying chain itself has centralisation concerns (validator set, halt risk, etc.).

**Base scores:** `decentralized` → 100, `centralized-dependent` → 50, `centralized` → 0.

**Chain-risk penalty** (applied to non-centralized governance only):

| Chain Risk | Penalty |
|---|---|
| Ethereum | 0 |
| Stage 1+ L2 | −15 |
| Established alt-L1 | −50 |
| Unproven | −65 |

The chain risk comes from the coin's explicit `chainRisk` override on `StablecoinMeta`. Coins without an override (defaulting to Ethereum) are unaffected.

Examples: hyUSD (decentralized, Solana) = 100 − 50 = **50**. USDB (centralized-dependent, Blast L2) = 50 − 15 = **35**.

### Dependency Risk Details

Two-phase computation ensures upstream scores are available before dependent coins are graded:

1. **Phase 1**: Grade `centralized` + `decentralized` coins (no upstream dependencies)
2. **Phase 2**: Grade `centralized-dependent` coins using Phase 1 scores

For Phase 2 coins:
- Score = blended: `sum(weight_i × upstream_score_i) + (1 − totalWeight) × 75`. The self-backed fraction (non-stablecoin collateral) scores 75, reflecting that dependent coins inherently carry more risk than independent ones. This ensures weights matter — a coin 10% backed by USDC has much lower contagion risk than one 100% backed by USDC.
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
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `liquidityScore`, `concentrationHhi`, `bluechipGrade`, `canBeBlacklisted`, `chainRisk`, `collateralQuality`, `custodyModel`, `governanceTier`, `dependencies`, etc.) — enables client-side stress test recomputation.

## Portfolio Analyzer & Stress Test

Collapsible panel on `/risk-lab` between the grade distribution bar and card grid. Two sections stacked vertically:

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
- **Recomputation**: `computeStressedGrades()` injects a synthetic score, recomputes only the Dependency Risk dimension for affected downstream coins. ~142 coins × 5 dimensions = <1ms, no debouncing needed.
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
