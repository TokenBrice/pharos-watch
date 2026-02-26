# Portfolio Analyzer & Stress Test

**Date:** 2026-02-25
**Status:** Approved
**Builds on:** [Report Cards Design (2026-02-24)](implemented/2026-02-24-report-cards-design.md)

## Goal

Add the two deferred innovations from the original report cards design:

1. **Portfolio Risk Analyzer** — Users enter their stablecoin holdings and get a blended portfolio grade, a portfolio-level radar chart, and an upstream exposure breakdown that reveals hidden collateral concentration.
2. **Interactive Stress Test** — Users simulate a grade downgrade for any upstream coin and watch cascading grade changes ripple through dependent stablecoins. When combined with a portfolio, the impact is dollar-denominated and personal.

These features build entirely on the existing report cards infrastructure (grading engine, dependency metadata, radar charts, API endpoint).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Stress test data | Extend API with `rawInputs` per card | Enables full client-side recomputation; future-proof for richer stress scenarios |
| Exposure calculation | Collateral weights per dependency | More accurate than equal-split; `{id, weight}[]` replaces `string[]` |
| Placement | Collapsible panel on `/report-cards` | Keeps portfolio, stress test, and card grid on one page |
| Grid update during sim | Yes — dashed borders, badges, sticky banner | Most impactful visualization; makes the stress test feel real |

## Data Layer Changes

### 1. Raw Dimension Inputs on ReportCard

Add `rawInputs` to each `ReportCard` so the frontend can recompute grades client-side:

```typescript
interface RawDimensionInputs {
  pegScore: number | null;
  activeDepeg: boolean;
  depegEventCount: number;
  lastEventAt: number | null;
  liquidityScore: number | null;
  concentrationHhi: number | null;
  bluechipGrade: BluechipGrade | null;
  chainCount: number;
  freezeEventsPerMonth: number | null;
  hasTrackedFreezeEvents: boolean;
  governanceTier: GovernanceType;
  dependencies: DependencyWeight[];
}

interface ReportCard {
  // ... existing fields ...
  rawInputs: RawDimensionInputs;  // NEW
}
```

### 2. Dependency Graph in Response

Pre-computed forward edges so the frontend can walk the dependency graph:

```typescript
interface ReportCardsResponse {
  // ... existing fields ...
  dependencyGraph: {
    edges: { from: string; to: string }[];  // from = upstream, to = dependent
  };
}
```

### 3. Collateral Weights on Dependencies

Change `dependencies` in `StablecoinMeta`/`StablecoinOpts` from `string[]` to `DependencyWeight[]`:

```typescript
interface DependencyWeight {
  id: string;      // DefiLlama ID of upstream stablecoin
  weight: number;  // 0-1, fraction of collateral from this source
}
```

Example: DAI currently `dependencies: ["2"]` becomes `dependencies: [{ id: "2", weight: 1.0 }]`. A coin backed 60% USDC + 40% USDT becomes `[{ id: "2", weight: 0.6 }, { id: "1", weight: 0.4 }]`.

Weights sum to <= 1.0. The remainder represents non-stablecoin collateral (ETH, BTC, etc.) that doesn't appear in the dependency graph.

All existing consumers of `dependencies` (the `scoreDependencyRisk` function, the worker API handler, the detail page dependency callout) must be updated for the new shape.

## Client-Side Recomputation Engine

New export from `src/lib/report-cards.ts`:

```typescript
export function computeStressedGrades(
  cards: ReportCard[],
  overrides: Map<string, { overallScore: number }>
): ReportCard[]
```

The function:
1. Builds an `overallScores` map from existing cards, applying overrides for target coins
2. For each dependent coin whose upstream is overridden, recomputes `scoreDependencyRisk` using the new upstream score
3. Recomputes `computeOverallGrade` for affected coins
4. Returns a new `ReportCard[]` with updated grades

Only the Dependency Risk dimension changes — all other dimensions remain unchanged. This mirrors the worker's Phase 1 → Phase 2 computation, just with a synthetic score injected.

~142 coins x 6 dimensions = trivial computation (<1ms). No debouncing needed. Results update live as the user changes selectors.

## Portfolio State Management

### `usePortfolio` hook

Manages holdings as `Map<string, number>` (coin ID -> USD amount).

**State sources (priority order):**
1. URL query param `?p=usdc:50000,dai:5000,frax:2000` (symbols, human-readable)
2. `localStorage` key `pharos:portfolio` (persists across sessions)
3. Empty map (default)

On load: if `?p=` exists, parse and use it (shared link mode). Otherwise load from localStorage. Shared links don't overwrite the recipient's saved portfolio.

**Derived computations (all `useMemo`):**

- **Portfolio grade**: `sum(coinScore * coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded from average, flagged in UI.
- **Portfolio radar**: Same weighted average per dimension. Produces `Record<DimensionKey, number | null>`.
- **Upstream exposure**: For each holding, walk `dependencies` using collateral weights. Direct CeFi holdings attribute 100% to themselves. Aggregate by upstream coin ID. Result: `Map<string, { usd: number; pct: number }>`.

**URL sync**: `router.replace` on edit (no scroll). Share button copies current URL.

## Stress Test State Management

### `useStressTest` hook

```typescript
{
  targetCoinId: string | null;
  targetGrade: ReportCardGrade | null;
  results: ReportCard[] | null;  // null = no active simulation
}
```

**URL sync:** `?stress=usdc&grade=D` — combined with portfolio params.

**Coin selector filter:** Only coins appearing as `from` in `dependencyGraph.edges`. Sorted by dependent count descending.

**Grade selector:** Only downgrades from the coin's current grade to F.

**Two display modes:**
- **Portfolio mode** (holdings entered): Impact scoped to held coins. Headline: "$55,200 of $57,000 at risk (97%)".
- **Ecosystem mode** (no holdings): All affected coins with market cap. Headline: "$23.4B in supply depends on USDC. 14 coins affected."

## UI Design

### Portfolio & Stress Test Panel

Collapsible section between grade distribution bar and card grid on `/report-cards`. Collapsed by default. If saved portfolio exists in localStorage, collapsed label shows: "My Portfolio & Stress Test — 3 coins, B+ (84)".

**Expanded layout — two sections stacked vertically:**

#### Top: Holdings + Portfolio Analysis

```
HOLDINGS                                    [Share] [Clear]

┌──────────────┐  ┌────────────┐
│ USDC       x │  │   50,000   │
│ DAI        x │  │    5,000   │
│ FRAX       x │  │    2,000   │
└──────────────┘  └────────────┘
[+ Add stablecoin]

Total: $57,000        Portfolio Grade: B+ (84/100)

┌─(portfolio radar)─┐   UPSTREAM EXPOSURE
│   Peg --- A       │   ====================--  USDC  96%
│   Liq --- A-      │   ==--------------------  USDT   3%
│   Saf --- B       │   =---------------------  Other  1%
│   Res --- B       │
│   Dec --- C+      │   ! 96% of your portfolio traces
│   Dep --- A-      │     back to USDC as collateral.
└───────────────────┘
```

- **Coin selector**: Reuse existing `CoinSelector` component from compare page.
- **USD input**: `type="text"` with thousand-separator formatting on blur (`Intl.NumberFormat`). Raw numeric value in state.
- **Portfolio radar**: Reuse `ReportCardRadar`, passing a synthetic `ReportCard` from weighted dimension averages.
- **Upstream exposure bar**: Horizontal stacked bar with inline `style={{ width }}` for dynamic percentages. Warning when any single upstream > 80%.

#### Bottom: Stress Test

```
STRESS TEST

What if  [USDC v]  dropped to  [D v] ?

Your portfolio: B+ (84) -> C (68)           v 16 pts
$55,200 of $57,000 at risk (97%)

┌──────────────────────────────────────────────────┐
│ Coin       Holding    Before    After     Delta  │
│ USDC       $50,000    A- (91)   D  (55)   -36   │
│ DAI        $5,000     B  (82)   C+ (72)   -10   │
│ FRAX       $2,000     B- (77)   C  (68)    -9   │
└──────────────────────────────────────────────────┘

(i) Grades recomputed client-side using the same algorithm.
    Only the Dependency Risk dimension is affected.
```

- **Coin selector**: Combobox filtered to upstream-only coins (those with dependents).
- **Grade selector**: Simple `<select>`, current grade down to F.
- **No "Run" button**: Results update live (<1ms computation).
- **Impact table**: Coin, holding/mcap, before grade+score, after grade+score, delta with severity (v, vv, vvv for -5/-15/-25+ drops).

### Simulation Mode on Card Grid

When stress test is active, the card grid below reflects simulated grades:

- **Affected cards**: `border-dashed`, grade shows before->after with delta, small "Simulated" badge.
- **Unaffected cards**: `opacity-70` to draw focus to affected ones.
- **Sticky banner**: "Viewing simulated grades — [Clear simulation]". `sticky top-[header-height]` with background color.
- Clearing reverts all cards instantly.

### Responsive Behavior

- **Desktop (lg+)**: Portfolio radar + upstream exposure side by side. Full impact table.
- **Tablet (md)**: Radar stacks above exposure. Table retains all columns.
- **Mobile (sm)**: Single-column holdings. Smaller radar. Table drops "Holding" column. Exposure bar stacks vertically.

## Edge Cases

### Portfolio

- **Single-coin portfolio**: Shows that coin's grade as portfolio grade. Upstream exposure is trivial. Value is in the stress test.
- **Defunct coin added**: Contributes F grade. Warning: "(CoinName) is defunct. Consider removing."
- **All NR coins**: Portfolio grade = NR. Upstream exposure still works (based on dependency metadata).
- **Large portfolios**: No limit. UI scrolls. Computation trivial.
- **Shared link with unknown coin**: Silently ignore unknown symbols. Don't break the page.

### Stress Test

- **Coin with no dependents**: Not selectable (filtered out).
- **NR coins in cascade**: Shows "NR -> NR" in impact table.
- **Multiple shared dependencies**: Stressing USDC only changes the USDC portion. UI clarifies partial impact.
- **No transitive chains**: One level only, consistent with existing grading.

## What Changes

| File | Change |
|---|---|
| `src/lib/types.ts` | Add `RawDimensionInputs`, `DependencyWeight` types. Change `dependencies` from `string[]` to `DependencyWeight[]`. Add `rawInputs` to `ReportCard`. Add `dependencyGraph` to `ReportCardsResponse`. |
| `src/lib/stablecoins.ts` | Convert ~63 `dependencies` entries from `string[]` to `DependencyWeight[]` with researched collateral weights. |
| `src/lib/report-cards.ts` | Add `computeStressedGrades()`. Update `scoreDependencyRisk()` for weighted dependencies. |
| `worker/src/api/report-cards.ts` | Populate `rawInputs` per card. Build and return `dependencyGraph`. Update for `DependencyWeight` shape. |
| `src/hooks/use-portfolio.ts` (new) | Portfolio state: holdings map, localStorage, URL sync, derived computations (grade, radar, exposure). |
| `src/hooks/use-stress-test.ts` (new) | Stress test state: target coin/grade, recomputation via `computeStressedGrades`, URL sync. |
| `src/components/portfolio-stress-panel.tsx` (new) | Combined collapsible panel: holdings editor, portfolio grade + radar, upstream exposure, stress test controls, impact table. |
| `src/app/report-cards/client.tsx` | Integrate panel between grade distribution and card grid. Wire simulation mode to card grid (dashed borders, badges, sticky banner). |
| `src/components/report-card-mini.tsx` | Support simulation mode: dashed border, before->after grade, "Simulated" badge. |

## What Doesn't Change

- Existing grading engine (dimension scorers, weights, thresholds) — only additions
- Worker cron jobs — no new data collection
- Other pages (peg tracker, liquidity, cemetery, etc.)
- Database schema — no new D1 tables
- Other API endpoints
