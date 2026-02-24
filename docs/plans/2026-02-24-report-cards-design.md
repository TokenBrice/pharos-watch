# Stablecoin Report Cards

**Date:** 2026-02-24
**Status:** Approved

## Goal

Add a composite grading system that synthesizes Pharos's existing data signals — peg stability, DEX liquidity, Bluechip safety ratings, chain distribution, classification tier, and freeze events — into a single, transparent letter grade (A+ through F) per stablecoin. The report card is the primary shareable artifact: a radar chart + letter grades across six dimensions that people screenshot and debate.

**Key innovation:** Contagion-aware grading. Grades propagate through a dependency graph — CeFi-Dependent coins inherit risk from the centralized stablecoins they rely on. No other rating system does this.

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
  isDefunct: boolean;             // Cemetery coin
}

interface ReportCardsResponse {
  cards: ReportCard[];
  methodology: {
    version: string;              // "1.0" — increment when weights/thresholds change
    weights: Record<string, number>;
    thresholds: { grade: string; min: number }[];
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

New top-level page in the navigation (between Liquidity and Compare).

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

**Compare page (`/compare`):** When comparing coins, show report cards side-by-side with overlaid radar charts (different colors per coin, shared axis scale).

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

## Methodology & Transparency

The report cards need a dedicated Methodology section — either a subsection of the About page or linked from the report cards page. It covers:

### Full Formula Transparency

Each dimension's exact mapping from raw score to letter grade, with worked examples:
- "USDC has a peg score of 97/100 → maps to A+. It had 0 depeg events in the last 12 months."
- "DAI has dependencies on USDC and USDT. USDC overall = A-, USDT overall = B+. DAI's dependency risk = average(91, 85) = 88 → B+."

### Explicit Limitations

- Peg Stability only reflects price data — can't detect a coin that's "stable" because nobody trades it
- Safety depends on Bluechip coverage — unrated coins get NR, not penalized
- Decentralization is structural, not a value judgment
- Dependency map is manually maintained — may not capture every collateral relationship
- Resilience uses chain count as a proxy — doesn't account for chain quality or TVL distribution per chain

### Versioning

- Methodology version (e.g., "v1.0") shipped with every API response
- If weights, thresholds, or dimension definitions change → version increments
- Changelog section on methodology page documents every version change

## Shareability

### Screenshot-Friendly Layout

The report card section on the detail page is designed so a browser screenshot captures: logo, name, overall grade, radar chart, and all dimension grades in one frame. No scrolling needed. Generous padding, clean typography.

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
| `src/lib/report-cards.ts` (new) | Grade computation logic: thresholds, weights, dimension scorers, overall calculation |
| `worker/src/api/report-cards.ts` (new) | API handler: read D1 caches, compute grades, return response |
| `worker/src/api/index.ts` | Register `/api/report-cards` route |
| `src/hooks/useReportCards.ts` (new) | TanStack Query hook |
| `src/app/report-cards/page.tsx` (new) | Report cards overview page with grade grid |
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
