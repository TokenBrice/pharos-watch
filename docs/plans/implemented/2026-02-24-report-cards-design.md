# Stablecoin Report Cards

**Date:** 2026-02-24
**Status:** Approved

## Goal

Add a composite grading system that synthesizes Pharos's existing data signals — peg stability, DEX liquidity, Bluechip safety ratings, chain distribution, classification tier, and freeze events — into a single, transparent letter grade (A+ through F) per stablecoin. The report card is the primary shareable artifact: a radar chart + letter grades across six dimensions that people screenshot and debate.

**Key innovation:** Contagion-aware grading. Grades propagate through a dependency graph — CeFi-Dependent coins inherit risk from the centralized stablecoins they rely on. No other rating system does this.

**Second key innovation:** Interactive stress testing. Users can simulate a grade downgrade for any upstream coin and watch cascading grade changes ripple through every dependent stablecoin in real time. This turns the abstract question "What happens if Tether collapses?" into a concrete, visual answer.

**Third key innovation:** Portfolio risk analyzer. Users manually enter their stablecoin holdings and get a blended portfolio grade, a portfolio-level radar chart, and — critically — an upstream exposure breakdown that reveals hidden concentration. Someone holding DAI + FRAX + USDC might think they're diversified across three coins, but the dependency graph exposes ~85% effective exposure to USDC. The stress test becomes personal: "if USDC drops to D, $55,200 of your $57,000 is at risk."

## Why This Feature

Pharos already has all the signals. Each lives on its own page: peg scores on the peg tracker, liquidity scores on the liquidity page, Bluechip ratings on the detail page. No single view answers the question users actually care about: *"Is this stablecoin safe to hold?"*

The report card synthesizes these signals into one defensible, transparent grade per coin. It's opinionated by nature (the weighting IS the opinion), which makes it inherently shareable and debatable.

## Grading Dimensions

Six dimensions, each graded A+ through F:

| Dimension | Weight | Data Source | What It Measures |
|---|---|---|---|
| **Peg Stability** | 25% | `PegSummaryCoin.pegScore` (0-100), event count, worst deviation | How faithfully the coin holds its peg over time |
| **Liquidity** | 25% | `DexLiquidityData.liquidityScore` (0-100), `concentrationHhi` | Can you exit a large position without slippage? |
| **Safety** | 20% | `BluechipRating.grade` (A+ to F) | Independent SMIDGE audit: stability, management, implementation, decentralization, governance, externals |
| **Resilience** | 15% | Chain count from `StablecoinData.chains`, freeze event rate from blacklist API | Single points of failure and operational risk |
| **Decentralization** | 10% | `StablecoinMeta.flags.governance` tier | Governance structure and custodial model |
| **Dependency Risk** | 5% | Classification tier + `dependencies` field (new) | Inherited risk from upstream stablecoins |

### Grade Thresholds

Numeric scores (0-100) map to letter grades:

| Grade | Score Range |
|---|---|
| A+ | 97-100 |
| A | 93-96 |
| A- | 90-92 |
| B+ | 85-89 |
| B | 80-84 |
| B- | 75-79 |
| C+ | 70-74 |
| C | 65-69 |
| C- | 60-64 |
| D | 50-59 |
| F | 0-49 |

### Per-Dimension Scoring Details

#### Peg Stability (25%)

Source: `PegSummaryCoin` from `/api/peg-summary`.

Primary input: `pegScore` (0-100), already a composite of depeg duration, worst deviation, frequency, and liquidity spread penalty. This maps directly to the grade thresholds above.

Modifiers:
- Active depeg (`activeDepeg: true`): cap at C regardless of score
- No depeg events in 12+ months: +3 bonus points
- Yield-bearing or NAV tokens: annotate that expected NAV drift is excluded from deviation metrics

#### Liquidity (25%)

Source: `DexLiquidityData` from `/api/dex-liquidity`.

Primary input: `liquidityScore` (0-100), already a 6-component composite (TVL depth 30%, volume activity 20%, pool quality 20%, durability 15%, pair diversity 7.5%, cross-chain 7.5%).

Modifiers:
- `concentrationHhi > 0.5` (highly concentrated): -5 points
- `concentrationHhi > 0.8` (near-monopoly): -10 points
- No liquidity data: NR

#### Safety (20%)

Source: `BluechipRating` from `/api/bluechip-ratings`.

Direct passthrough — Bluechip already grades A+ through F using the SMIDGE framework. Convert letter grade to numeric score using the same thresholds (A+ = 100, A = 95, ..., F = 25).

No Bluechip rating: NR (Not Rated). Do not penalize — many legitimate coins simply haven't been reviewed.

#### Resilience (15%)

Composite of two sub-signals:

**Chain Distribution (60% of resilience score):**
- Source: `StablecoinData.chains` from `/api/stablecoins`
- 1 chain = 40, 2 chains = 55, 3 chains = 65, 4-5 = 75, 6-8 = 85, 9+ = 95
- Logarithmic scaling — going from 1 to 3 chains matters more than 10 to 15

**Freeze Event Rate (40% of resilience score):**
- Source: `/api/blacklist` filtered by stablecoin
- Only applies to USDC, USDT, PAXG, XAUT (coins with tracked freeze events)
- Score = 100 - (events_per_month * 2), clamped to 0-100
- Coins without tracked freeze events: automatic 85 (neutral-positive — absence of freeze capability is generally good, but we can't fully verify)

#### Decentralization (10%)

Source: `StablecoinMeta.flags.governance` from `stablecoins.ts`.

Static mapping:
- `decentralized` → 95 (A)
- `centralized-dependent` → 70 (C+)
- `centralized` → 50 (D)

This is NOT a value judgment. CeFi isn't "worse" — it's a different risk profile. Centralized stablecoins trade decentralization for regulatory clarity and reserve backing. The methodology page must explain this framing.

#### Dependency Risk (5%)

Source: `StablecoinMeta.flags.governance` + new `dependencies` field in `stablecoins.ts`.

For coins classified as `centralized-dependent`:
1. Look up each dependency's overall grade
2. Dependency risk score = average of dependencies' overall scores
3. If any dependency scores below B- (75): apply -10 penalty
4. One level of recursion only (no transitive dependency chains)

For `centralized` and `decentralized` coins: automatic 95 (A). CeFi coins ARE the upstream — they have no dependency risk. DeFi coins with purely crypto/algo backing have no centralized dependencies.

**New metadata field** in `StablecoinMeta` / `StablecoinOpts`:

```typescript
dependencies?: string[];  // DefiLlama IDs of stablecoins this coin depends on
```

Needs to be populated for ~60 CeFi-Dependent coins. Examples:
- DAI (`"5"`) → dependencies: `["1", "2"]` (USDT, USDC)
- USDe (`"146"`) → dependencies: `["1", "2"]` (USDT, USDC)
- crvUSD (`"110"`) → dependencies: `["1", "2"]` (USDT, USDC)
- FRAX (`"6"`) → dependencies: `["2"]` (USDC)

### Overall Grade Calculation

Weighted sum of available dimension scores, using the weights above. If a dimension is NR, its weight is redistributed proportionally among rated dimensions.

```
overallScore = Σ(dimensionScore × adjustedWeight) for all rated dimensions
```

**Minimum rated dimensions:** If fewer than 3 dimensions have data, the coin receives an overall grade of NR (Not Rated) rather than a misleading partial grade.

**Cemetery coins:** Permanent F with a "Defunct" label. No radar chart — just the F and a link to their cemetery entry.

## Data Architecture

### API Endpoint

**`GET /api/report-cards`** — New Worker API endpoint.

Reads from existing D1 cached data and computes grades on-the-fly. No new cron job needed — all input data is already refreshed by existing crons (sync-stablecoins, detect-depegs, sync-dex-liquidity, sync-bluechip).

**Cache profile:**
- Edge: 5 minutes (same as liquidity — grades change as underlying data changes)
- Browser staleTime: 5 minutes
- refetchInterval: 10 minutes

**Computation steps:**
1. Read `peg_summary` cache → extract `pegScore`, `eventCount`, `activeDepeg` per coin
2. Read `dex_liquidity` cache → extract `liquidityScore`, `concentrationHhi` per coin
3. Read `bluechip_ratings` cache → extract `grade` per coin
4. Read `stablecoins` cache → extract `chains` per coin
5. Read `blacklist` cache → compute freeze event rate per coin
6. Look up classification tier and dependencies from `TRACKED_STABLECOINS` (imported from `src/lib/stablecoins.ts`)
7. Compute dimension scores → letter grades → overall grade
8. Return full report card array

**Dependency resolution order:** Compute grades for `centralized` and `decentralized` coins first (they have no dependencies), then compute `centralized-dependent` coins using the already-computed grades of their dependencies.

### Shared Computation Module

The grade computation logic in `src/lib/report-cards.ts` is structured to be importable by both the Worker (server-side grading) and the frontend (client-side stress test recomputation). The core function signature:

```typescript
function computeAllGrades(
  dimensionInputs: Map<string, RawDimensionInputs>,
  overrides?: Map<string, Partial<DimensionScores>>  // stress test injects here
): ReportCard[]
```

The `overrides` parameter lets the stress test swap in synthetic dimension scores for a target coin, then recompute only the dependent coins' grades. The Worker calls `computeAllGrades(inputs)` with no overrides. The frontend calls it with overrides when the stress test is active.

This means the grading logic ships in the client bundle (~2-3KB gzipped — it's arithmetic, not data). The raw dimension inputs are included in the API response so the client has everything it needs to recompute.

### Response Shape

```typescript
interface ReportCardDimension {
  grade: string;          // "A+", "A", ..., "F", "NR"
  score: number | null;   // 0-100, null if NR
  detail: string;         // Human-readable: "96/100 — no depeg events in 12 months"
}

interface ReportCard {
  id: string;
  name: string;
  symbol: string;
  overallGrade: string;           // "A+", "A", ..., "F", "NR"
  overallScore: number | null;    // 0-100 weighted composite, null if NR
  dimensions: {
    pegStability: ReportCardDimension;
    liquidity: ReportCardDimension;
    safety: ReportCardDimension;
    resilience: ReportCardDimension;
    decentralization: ReportCardDimension;
    dependencyRisk: ReportCardDimension;
  };
  ratedDimensions: number;        // Count of non-NR dimensions (3-6)
  dependencies?: string[];        // IDs of upstream stablecoins (CeFi-Dep only)
  dependents?: string[];          // IDs of coins that depend on this one (stress test uses this)
  isDefunct: boolean;             // Cemetery coin
  rawInputs: RawDimensionInputs;  // Raw scores for client-side stress test recomputation
}

// Raw inputs needed for client-side grade recomputation (stress test)
interface RawDimensionInputs {
  pegScore: number | null;
  activeDepeg: boolean;
  depegEventCount: number;
  liquidityScore: number | null;
  concentrationHhi: number | null;
  bluechipGrade: string | null;   // "A+", "A", ..., "F", or null
  chainCount: number;
  freezeEventsPerMonth: number | null;
  governanceTier: string;         // "decentralized" | "centralized-dependent" | "centralized"
  dependencies: string[];
}

interface ReportCardsResponse {
  cards: ReportCard[];
  methodology: {
    version: string;              // "1.0" — increment when weights/thresholds change
    weights: Record<string, number>;
    thresholds: { grade: string; min: number }[];
  };
  dependencyGraph: {              // Pre-computed graph for stress test
    edges: { from: string; to: string }[];  // from = upstream, to = dependent
  };
  updatedAt: number;              // Unix timestamp of computation
}
```

### TanStack Query Hook

```typescript
// src/hooks/useReportCards.ts
export function useReportCards() {
  return useQuery<ReportCardsResponse>({
    queryKey: ["report-cards"],
    queryFn: () => fetch(`${API_BASE}/api/report-cards`).then(r => r.json()),
    staleTime: 5 * 60 * 1000,       // 5 min (matches edge cache)
    refetchInterval: 10 * 60 * 1000, // 10 min
  });
}
```

## Visual Design

### Report Cards Overview Page (`/report-cards`)

New top-level page in the navigation (between Liquidity and Cemetery).

**Layout:**

```
┌─────────────────────────────────────────────────────┐
│  REPORT CARDS                                       │
│  Transparent, data-driven grades for every          │
│  tracked stablecoin.                  [Methodology] │
├─────────────────────────────────────────────────────┤
│  Grade Distribution                                 │
│  ┌──┬────┬──────┬──────────┬───┬──┐                │
│  │A+│ A  │  B   │    C     │ D │F │  (bar chart)   │
│  └──┴────┴──────┴──────────┴───┴──┘                │
│  12 coins A-range | 38 B-range | 52 C-range | ...  │
├─────────────────────────────────────────────────────┤
│  [📊 My Portfolio & Stress Test          ▸ expand]  │
├─────────────────────────────────────────────────────┤
│  Filter: [All] [A-range] [B-range] [C-range] [NR]  │
│  Sort by: [Overall ▼] [Peg] [Liquidity] [Safety]   │
│           [Resilience] [Decent.] [Depend.] [MCap]   │
├─────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ ◆ USDC   │  │ ◆ USDT   │  │ ◆ DAI    │          │
│  │          │  │          │  │          │          │
│  │  [A-]    │  │  [B+]    │  │  [B]     │          │
│  │          │  │          │  │          │          │
│  │ (radar)  │  │ (radar)  │  │ (radar)  │          │
│  │          │  │          │  │          │          │
│  │ $52.1B   │  │ $145.2B  │  │ $5.2B    │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

Each card tile contains:
- Coin logo + name + symbol
- Large overall letter grade (color-coded)
- Mini radar chart showing 6 dimensions at a glance
- Market cap for context
- Click → navigates to full detail page

**Color coding for grades:**
- A-range: emerald/green
- B-range: blue
- C-range: amber/yellow
- D: orange
- F: red
- NR: gray

Use static Tailwind classes only — define all grade colors in `classification.ts` (or a new `report-cards.ts` constants file) following the existing pattern.

### Full Report Card on Detail Page (`/stablecoin/[id]`)

New section on each coin's detail page, placed prominently (after the price/supply charts, before the chain distribution).

```
┌─────────────────────────────────────────────────────┐
│  PHAROS REPORT CARD                                 │
├──────────────────────┬──────────────────────────────┤
│                      │                              │
│     Overall: A-      │  Peg Stability    A   96/100 │
│                      │  Liquidity        A-  91/100 │
│    ┌──(radar)──┐     │  Safety           B+  87/100 │
│    │  /\    /\ │     │  Resilience       B   82/100 │
│    │ /  \  /  \│     │  Decentralization C   50/100 │
│    │/    \/    \│     │  Dependency Risk  A   95/100 │
│    │\    /\    /│     │                              │
│    │ \  /  \  / │     │  ⓘ Methodology v1.0         │
│    │  \/    \/ │     │                              │
│    └───────────┘     │                              │
│                      │                              │
├──────────────────────┴──────────────────────────────┤
│  ⚠ This coin depends on: USDC, USDT                │
│  Their grades affect the Dependency Risk score.     │
└─────────────────────────────────────────────────────┘
```

**Radar chart:** Hexagonal spider chart with 6 axes. Filled area shows the coin's profile shape. The shape becomes a visual signature — USDC's hexagon is different from DAI's.

**Dependency callout:** Only shown for CeFi-Dependent coins. Lists upstream dependencies with links to their report cards.

**Detail strings** per dimension provide one-line explanations:
- "Peg Stability: A — 96/100, no depeg events in 12 months"
- "Liquidity: A- — deep pools across 8 chains, HHI 0.22"
- "Safety: B+ — Bluechip SMIDGE rating B+"
- "Resilience: B — deployed on 6 chains, low freeze activity"
- "Decentralization: C — centralized governance (CeFi)"
- "Dependency Risk: A — no upstream dependencies"

### Touches to Existing Pages

**Homepage table (`/`):** New "Grade" column showing the overall letter grade, sortable. Placed after the existing columns. Color-coded to match the report card page.

**Compare page (`/compare`):** The compare page is not in the main nav — it's accessed via the "Compare" link on each stablecoin detail page (`/stablecoin/[id]`), which pre-populates the current coin as a query param. When comparing coins, show report cards side-by-side with overlaid radar charts (different colors per coin, shared axis scale).

### Portfolio & Stress Test Panel (`/report-cards`)

Collapsible section below the grade distribution bar chart. Collapsed by default with a prominent toggle: "📊 My Portfolio & Stress Test". The portfolio and stress test are merged into a single panel — the stress test is most compelling when applied to the user's own holdings.

**Layout (expanded):**

```
┌───────────────────────────────────────────────────────────────┐
│  📊 MY PORTFOLIO & STRESS TEST                     [Close ✕]  │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  HOLDINGS                                     [Share] [Clear] │
│                                                               │
│  Coin              Amount (USD)                               │
│  ┌──────────────┐  ┌──────────────┐                           │
│  │ USDC       ✕ │  │    50,000    │                           │
│  │ DAI        ✕ │  │     5,000    │                           │
│  │ FRAX       ✕ │  │     2,000    │                           │
│  └──────────────┘  └──────────────┘                           │
│  [+ Add coin]                                                 │
│                                                               │
│  Total: $57,000          Portfolio Grade: B+  (84/100)        │
│                                                               │
│  ┌─(portfolio radar)─┐                                        │
│  │   Peg ━━━ A       │   UPSTREAM EXPOSURE                    │
│  │   Liq ━━━ A-      │   ████████████████████░░░  USDC  84%  │
│  │   Saf ━━━ B       │   ████░░░░░░░░░░░░░░░░░░  USDT  12%  │
│  │   Res ━━━ B       │   █░░░░░░░░░░░░░░░░░░░░░  Algo   4%  │
│  │   Dec ━━━ C+      │                                        │
│  │   Dep ━━━ A-      │   ⚠ 97% of your portfolio traces      │
│  └───────────────────┘     back to USDC as collateral.        │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│  ⚡ STRESS TEST                                               │
│                                                               │
│  What if  [USDC ▼]  dropped to  [D ▼] ?          [Run ▶]     │
│                                                               │
│  Your portfolio: B+ (84) → C (68)                             │
│  $55,200 of $57,000 at risk (97%)                             │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Coin       Holding    Before    After     Δ              │ │
│  │ USDC       $50,000    A- (91)   D  (55)   -36 pts ▼▼▼   │ │
│  │ DAI        $5,000     B  (82)   C+ (72)   -10 pts ▼     │ │
│  │ FRAX       $2,000     B- (77)   C  (68)   -9 pts  ▼     │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ⓘ Grades recomputed client-side using the same algorithm.    │
│    Only the Dependency Risk dimension is affected.            │
└───────────────────────────────────────────────────────────────┘
```

**Without a portfolio entered**, the stress test falls back to the ecosystem-wide view showing all ~142 coins and aggregate market cap impact — same as a standalone stress test. The portfolio narrows the lens to show personal dollar-denominated impact.

#### Portfolio Interaction Model

1. **Coin selector:** Combobox filtering `TRACKED_STABLECOINS` by name/symbol — same component pattern as the compare page. Adding a coin creates a new row with a USD amount input.

2. **Amount input:** USD-denominated. Users type in their total holdings regardless of where the coins sit (CEX, DeFi, cold wallet, multiple chains). Formatted with thousand separators on blur.

3. **Portfolio grade:** Weighted average of each coin's overall score, weighted by the user's USD amount. Displayed as a letter grade with the numeric composite. Recalculates instantly as holdings change.

4. **Portfolio radar chart:** Weighted average of each dimension across holdings. Shows the aggregate risk shape — visually obvious if the portfolio is heavy on peg stability but weak on decentralization.

5. **Upstream exposure breakdown:** The key insight. For each holding, trace through the `dependencyGraph` to attribute the user's USD amount to upstream stablecoins. A coin with `dependencies: ["usdc", "usdt"]` splits its amount 50/50 (or by known collateral weights if available). Direct holdings of upstream coins count at 100%. Display as a horizontal stacked bar with percentages. Flag concentrations above 80% with a warning.

6. **Persistence:** Holdings saved in `localStorage` keyed by a stable identifier. Survive page reloads and browser sessions. No account or login needed.

7. **Share button:** Encodes holdings in URL query params (`?p=usdc:50000,dai:5000,frax:2000`). Anyone opening the link sees the portfolio pre-populated (read-only until they edit).

#### Stress Test Interaction Model

1. **Coin selector:** Dropdown filtered to coins that have at least one dependent (i.e., coins in the `dependencyGraph` as an upstream). Sorted by number of dependents descending.

2. **Grade selector:** Dropdown showing target grades from the coin's current grade down to F. Only downgrades — simulating upgrades isn't useful for risk analysis.

3. **Run button:** Triggers client-side recomputation via `computeAllGrades()` with the override applied.

4. **Impact display — portfolio mode:** When a portfolio is entered, the impact table is scoped to the user's holdings. Columns: coin name/symbol, user's holding amount, grade before, grade after, point change (red-tinted). The headline stat is dollar-denominated: "$55,200 of $57,000 at risk (97%)".

5. **Impact display — ecosystem mode:** When no portfolio is entered, falls back to showing all affected coins with market cap (the original design). Headline stat: "$23.4B in supply depends on USDC. 14 coins affected."

6. **Card grid update:** While the stress test is active, the card grid below updates to show simulated grades with a visual indicator (dashed border, "simulated" badge). A sticky banner reminds the user: "Viewing simulated grades. [Clear simulation]."

#### Technical Implementation

- All computation is client-side — no API call needed. The `rawInputs` and `dependencyGraph` from the initial `/api/report-cards` response provide everything.
- The `usePortfolio` hook manages holdings state: `Map<string, number>` (coin ID → USD amount). Reads/writes `localStorage`. Computes derived values (blended grade, portfolio radar, upstream exposure) via `useMemo`.
- The `useStressTest` hook manages stress test state: `{ targetCoin: string | null, targetGrade: string | null, results: ReportCard[] | null }`. When a portfolio exists, it filters/weights results by holdings.
- `useMemo` recomputes grades only when the target changes, using `computeAllGrades(inputs, overrides)` from the shared `src/lib/report-cards.ts` module.
- ~142 coins × 6 dimensions = ~850 arithmetic operations. Runs in <1ms — no debouncing needed.
- Upstream exposure computation: walk each holding's `dependencies` array, split the USD amount equally among dependencies (or 100% for direct holdings of CeFi coins), aggregate by upstream coin ID. Simple reduce operation.

**URL state:** Combined query string encodes both portfolio and stress test: `?p=usdc:50000,dai:5000,frax:2000&stress=usdc&grade=D`. Sharing a link opens the page with portfolio pre-populated and simulation pre-applied. Portfolio-only links also work: `?p=usdc:50000,dai:5000`.

## Edge Cases

### Coins with Incomplete Data

Many of 142 tracked coins won't have all 6 dimensions:
- **No Bluechip rating** (~120+ coins): Safety = NR
- **No liquidity data** (small/new coins): Liquidity = NR
- **No peg score** (very new, no price history): Peg Stability = NR
- **Threshold:** <3 rated dimensions → overall grade = NR
- NR dimensions are excluded from the radar chart (axis still shown but grayed out)
- Weight redistribution: NR dimension's weight splits proportionally among rated dimensions

### Dead Coins (Cemetery)

Coins in the cemetery get permanent F grade with "Defunct" label. No radar chart. Just the F and a link to their cemetery entry. They appear at the bottom of the report cards grid (or excluded with a toggle).

### Yield-Bearing / NAV Tokens

Coins flagged `yieldBearing` or `navToken` already have peg deviation adjustments in the peg tracker. The report card should display a note: "NAV token — peg stability grade accounts for expected price appreciation."

### Grade Disagreements with Bluechip

Pharos's overall grade may differ from Bluechip's standalone SMIDGE rating. The methodology section explicitly acknowledges: "Bluechip's SMIDGE rating is one of six dimensions. A coin rated A by Bluechip may receive a lower overall Pharos grade if its peg stability or liquidity is weak."

### New Coins

Coins added to `TRACKED_STABLECOINS` start with mostly NR dimensions. As data accumulates (peg history, liquidity discovery, potential Bluechip review), dimensions fill in and the grade becomes meaningful. No special handling needed — the NR threshold naturally handles this.

### Portfolio Edge Cases

**Single-coin portfolio:** Valid — just shows that coin's grade as the portfolio grade. Upstream exposure is trivial (100% to itself or its dependencies). The value is in the stress test: "what happens to my one holding?"

**Defunct coin in portfolio:** If a user adds a cemetery coin, it contributes its F grade to the portfolio weighted average. Display a warning: "⚠ [CoinName] is defunct. Consider removing it from your portfolio."

**All NR coins:** If every holding is NR, the portfolio grade is NR. The upstream exposure still works (based on dependency metadata, not grades).

**Very large portfolios:** No practical limit on holdings count — all 142 coins could be entered. The UI scrolls the holdings list and the computation remains trivial.

**Shared link with unknown coin IDs:** If a `?p=` URL contains a coin ID not in `TRACKED_STABLECOINS`, silently ignore that entry. Don't break the page over a stale link.

### Stress Test Edge Cases

**Coin with no dependents:** The coin selector only shows coins that appear as an upstream in the dependency graph. Coins with no dependents aren't selectable — there's nothing to cascade to.

**NR coins in the cascade:** If a dependent coin has an overall grade of NR (fewer than 3 rated dimensions), it still appears in the impact table but shows "NR → NR" since even with the dependency risk change, it remains below the minimum rated dimensions threshold.

**Multiple shared dependencies:** Some coins depend on both USDC and USDT. Stress-testing USDC alone only changes the USDC portion of their dependency risk average. The UI clarifies: "DAI depends on USDC and USDT. Only the USDC dependency is affected by this simulation."

**Cascading through dependency chains:** The plan limits dependency resolution to one level (no transitive chains). The stress test follows the same rule — overriding USDC affects coins that directly depend on USDC, but not coins that depend on DAI (which depends on USDC). This is consistent and avoids speculative compounding.

## Methodology & Transparency

The report cards need a dedicated Methodology section — either a subsection of the About page or linked from the report cards page. It covers:

### Full Formula Transparency

Each dimension's exact mapping from raw score to letter grade, with worked examples:
- "USDC has a peg score of 97/100 → maps to A+. It had 0 depeg events in the last 12 months."
- "DAI has dependencies on USDC and USDT. USDC overall = A-, USDT overall = B+. DAI's dependency risk = average(91, 85) = 88 → B+."

### Stress Test Transparency

The methodology page explains exactly what the stress test does and doesn't simulate:

- **What it does:** Overrides the target coin's overall grade, then recomputes the Dependency Risk dimension for every coin that lists the target as a dependency. The overall grades of dependent coins are recalculated with the new Dependency Risk score.
- **What it doesn't do:** It does not simulate second-order effects. A USDC downgrade in reality would likely cause DAI's peg stability and liquidity to deteriorate too — the stress test only captures the mechanical dependency risk impact, not the market panic. The methodology page states this clearly: "This models the direct dependency channel only. Real-world contagion would likely be worse."

Worked example:
- "Stress test: USDC drops from A- (91) to D (55). DAI depends on USDC and USDT. USDT is unchanged at B+ (85). DAI's new dependency risk = average(55, 85) = 70. Penalty applies because USDC < B- (75): 70 - 10 = 60 → C-. DAI's overall grade drops from B (82) to C+ (74)."

### Portfolio Methodology Transparency

The methodology page explains the portfolio calculations:

- **Portfolio grade:** Weighted average of held coins' overall scores, weighted by USD amount. `portfolioScore = Σ(coinScore × coinAmount) / Σ(coinAmount)` for all rated coins. NR coins are excluded from the weighted average but flagged in the UI.
- **Portfolio radar:** Same weighted average applied per-dimension. Shows the aggregate risk profile shape.
- **Upstream exposure:** For each holding, trace `dependencies` and split the USD amount equally among upstream coins. Direct holdings of CeFi coins (no dependencies) attribute 100% to themselves. The result is an aggregate exposure map showing effective collateral concentration regardless of how many intermediate coins the user holds.

Worked example:
- "Portfolio: $50K USDC + $5K DAI + $2K FRAX. DAI depends equally on USDC and USDT → $2.5K attributed to USDC, $2.5K to USDT. FRAX depends on USDC → $2K to USDC. USDC is direct → $50K to USDC. Total USDC exposure: $54.5K of $57K = 96%."

### Explicit Limitations

- Peg Stability only reflects price data — can't detect a coin that's "stable" because nobody trades it
- Safety depends on Bluechip coverage — unrated coins get NR, not penalized
- Decentralization is structural, not a value judgment
- Dependency map is manually maintained — may not capture every collateral relationship
- Resilience uses chain count as a proxy — doesn't account for chain quality or TVL distribution per chain
- Stress test models the dependency risk channel only — real contagion events also impact peg stability, liquidity, and market confidence simultaneously
- Portfolio upstream exposure assumes equal splits across dependencies — in reality, collateral ratios vary (e.g., DAI may be 60% USDC, 30% ETH, 10% USDT). Equal splits are a simplification; refining with actual collateral weights is a future improvement
- Portfolio holdings are self-reported — there is no wallet connection or on-chain verification

### Versioning

- Methodology version (e.g., "v1.0") shipped with every API response
- If weights, thresholds, or dimension definitions change → version increments
- Changelog section on methodology page documents every version change

## Shareability

### Screenshot-Friendly Layout

The report card section on the detail page is designed so a browser screenshot captures: logo, name, overall grade, radar chart, and all dimension grades in one frame. No scrolling needed. Generous padding, clean typography.

### Shareable Portfolio Links

Portfolio state encodes cleanly in query params: `?p=usdc:50000,dai:5000,frax:2000`. Combined with stress test: `?p=usdc:50000,dai:5000,frax:2000&stress=usdc&grade=D`. These links fully reconstruct the portfolio, upstream exposure, and any active simulation. The share button copies the link to clipboard with a toast confirmation. This creates a natural sharing loop — "check what happens to my portfolio if Tether collapses" is a compelling link to send someone.

### OG Image Generation (Phase 1.5 — Nice to Have)

For maximum Twitter/social sharing, each coin's URL (`pharos.watch/stablecoin/usdc`) could generate a dynamic Open Graph preview showing the radar chart and overall grade.

Options:
1. **Pre-generated at build time** — static SVG → PNG for ~142 coins (feasible, no runtime cost)
2. **Worker-generated** — dynamic image endpoint using Satori/resvg or similar

This is optional for Phase 1 — the page itself is screenshot-friendly even without custom OG images.

## Phase 2 — AI Narratives (Future)

After Phase 1 ships and stabilizes:

- New cron (daily, after 08:00 UTC digest) calls Claude API with each coin's grade breakdown
- Claude generates 2-3 sentence narrative per coin explaining the grade in plain English
- Example: *"USDC earns an A- overall: rock-solid peg and deep liquidity, but centralized governance and aggressive freeze history cost it top marks."*
- Narrative stored in D1, served alongside grade data
- Displayed below radar chart on detail page
- Clearly labeled as AI-generated (same treatment as daily digest)

The API response shape accommodates this: add optional `narrative?: string` field to `ReportCard`.

## What Changes

| Component | Change |
|---|---|
| `src/lib/types.ts` | New `StablecoinMeta.dependencies` field, new `ReportCard` / `ReportCardsResponse` types |
| `src/lib/stablecoins.ts` | Add `dependencies` array to ~60 CeFi-Dependent coins |
| `src/lib/report-cards.ts` (new) | Grade computation logic: thresholds, weights, dimension scorers, overall calculation. Shared by Worker and frontend (stress test). Exports `computeAllGrades()` with optional overrides parameter |
| `worker/src/api/report-cards.ts` (new) | API handler: read D1 caches, compute grades, build dependency graph, return response with `rawInputs` per coin |
| `worker/src/api/index.ts` | Register `/api/report-cards` route |
| `src/hooks/useReportCards.ts` (new) | TanStack Query hook |
| `src/hooks/usePortfolio.ts` (new) | Portfolio holdings state: `Map<string, number>` (coin ID → USD amount), localStorage persistence, derived computations (blended grade, portfolio radar, upstream exposure). URL query sync for `?p=` param |
| `src/hooks/useStressTest.ts` (new) | Stress test state management: target coin, target grade, client-side recomputation via `computeAllGrades()` with overrides. Portfolio-aware: scopes impact to holdings when portfolio exists. URL query sync for `?stress=` and `?grade=` params |
| `src/app/report-cards/page.tsx` (new) | Report cards overview page with grade grid + portfolio & stress test panel |
| `src/components/PortfolioStressTestPanel.tsx` (new) | Combined collapsible panel: portfolio holdings editor, portfolio grade + radar, upstream exposure breakdown, stress test controls, impact table (portfolio-scoped or ecosystem-wide) |
| `src/components/ReportCard.tsx` (new) | Full report card component (radar chart + dimension list) |
| `src/components/ReportCardMini.tsx` (new) | Compact report card tile for grid view |
| `src/components/RadarChart.tsx` (new) | Hexagonal radar chart using Recharts `RadarChart` |
| `src/app/stablecoin/[id]/` | Add report card section to detail page |
| `src/app/page.tsx` (or table component) | Add "Grade" column to homepage table |
| `src/app/compare/` | Add side-by-side report card comparison |
| `src/app/about/` | Add methodology section (or link to dedicated page) |
| Navigation component | Add "Report Cards" to nav menu |

## What Doesn't Change

- Existing cron jobs (no new data collection needed)
- Peg tracker page and scoring algorithm
- Liquidity page and scoring algorithm
- Bluechip sync and rating display
- Blacklist tracker
- Cemetery
- Database schema (no new D1 tables — grades computed on-the-fly)
- Existing API endpoints (all unchanged)
