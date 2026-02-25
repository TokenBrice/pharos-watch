# Report Cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a composite grading system (A+ through F) that synthesizes peg stability, DEX liquidity, Bluechip safety, resilience, decentralization, and dependency risk into a single transparent letter grade per stablecoin.

**Architecture:** Worker API handler reads existing D1 caches and computes grades on-the-fly (no new cron or DB table). Shared scoring logic lives in `src/lib/report-cards.ts` (imported by both worker and frontend for grade color/label utilities). New `/report-cards` page shows a grade grid; detail pages get a radar chart + breakdown section.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind CSS v4, Recharts RadarChart, TanStack Query, Cloudflare Workers + D1.

**Design doc:** `docs/plans/2026-02-24-report-cards-design.md`

---

## Task 1: Add `dependencies` field to types and stablecoin metadata

**Files:**
- Modify: `src/lib/types.ts:66-82` (StablecoinMeta interface)
- Modify: `src/lib/stablecoins.ts` (~63 CeFi-Dependent coins)

**Step 1: Add `dependencies` to `StablecoinMeta`**

In `src/lib/types.ts`, add a `dependencies` field to the `StablecoinMeta` interface:

```typescript
export interface StablecoinMeta {
  id: string;
  name: string;
  symbol: string;
  flags: StablecoinFlags;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  protocolSlug?: string;
  proofOfReserves?: ProofOfReserves;
  links?: StablecoinLink[];
  jurisdiction?: Jurisdiction;
  contracts?: ContractDeployment[];
  supplyMethod?: SupplyMethodConfig;
  dependencies?: string[];  // DefiLlama IDs of upstream stablecoins (CeFi-Dependent coins only)
}
```

Also add `dependencies` to the `StablecoinOpts` interface in `stablecoins.ts` so the `coin()` helper passes it through.

**Step 2: Populate `dependencies` for all ~63 CeFi-Dependent coins**

In `src/lib/stablecoins.ts`, add `dependencies` arrays. Research each coin's actual collateral to determine correct dependencies. Common patterns:

- Most CeFi-Dependent coins depend on USDT ("1") and/or USDC ("2")
- Some depend on specific stablecoins (e.g., FRAX → USDC only)
- Key IDs: USDT = "1", USDC = "2", DAI = "5", FRAX = "6"

Examples:
```typescript
// DAI
usd("5", "Dai", "DAI", "crypto-backed", "centralized-dependent", {
  dependencies: ["1", "2"],  // USDT, USDC
  // ...existing opts
})

// USDe
usd("146", "Ethena USDe", "USDe", "crypto-backed", "centralized-dependent", {
  dependencies: ["1", "2"],  // USDT, USDC
  // ...existing opts
})

// FRAX
usd("6", "Frax", "FRAX", "crypto-backed", "centralized-dependent", {
  dependencies: ["2"],  // USDC
  // ...existing opts
})
```

To determine the correct dependencies for each of the ~63 coins:
- Check existing `collateral` and `pegMechanism` fields for hints
- For coins backed by "mixed stablecoin collateral" → `["1", "2"]`
- For coins with specific known backing (e.g., FRAX = USDC only) → specify exactly
- When uncertain, default to `["1", "2"]` (most CeFi-Dependent coins use USDC + USDT as primary backing)

**Step 3: Verify the build still passes**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/stablecoins.ts
git commit -m "feat(report-cards): add dependencies field to StablecoinMeta for ~63 CeFi-Dependent coins"
```

---

## Task 2: Create shared grading logic (`src/lib/report-cards.ts`)

**Files:**
- Create: `src/lib/report-cards.ts`
- Modify: `src/lib/types.ts` (add ReportCard types)

This is the core scoring engine. It contains pure functions with no D1 or API dependencies — just data in, grades out.

**Step 1: Add report card types to `src/lib/types.ts`**

Add after the existing `DexLiquidityMap` type (around line 353):

```typescript
// --- Report Card types ---

export type ReportCardGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F" | "NR";

export interface ReportCardDimension {
  grade: ReportCardGrade;
  score: number | null;   // 0-100, null if NR
  detail: string;         // Human-readable explanation
}

export type DimensionKey = "pegStability" | "liquidity" | "safety" | "resilience" | "decentralization" | "dependencyRisk";

export interface ReportCard {
  id: string;
  name: string;
  symbol: string;
  overallGrade: ReportCardGrade;
  overallScore: number | null;
  dimensions: Record<DimensionKey, ReportCardDimension>;
  ratedDimensions: number;
  dependencies?: string[];
  isDefunct: boolean;
}

export interface ReportCardsResponse {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  updatedAt: number;
}

export type ReportCardMap = Record<string, ReportCard>;
```

**Step 2: Create `src/lib/report-cards.ts` with scoring logic**

```typescript
import type {
  ReportCardGrade,
  ReportCardDimension,
  ReportCard,
  DimensionKey,
  PegSummaryCoin,
  DexLiquidityData,
  BluechipRating,
  BluechipGrade,
  StablecoinMeta,
  GovernanceType,
} from "./types";

// ── Constants ──────────────────────────────────────────────────────────

export const METHODOLOGY_VERSION = "1.0";

export const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  pegStability: 0.25,
  liquidity: 0.25,
  safety: 0.20,
  resilience: 0.15,
  decentralization: 0.10,
  dependencyRisk: 0.05,
};

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  pegStability: "Peg Stability",
  liquidity: "Liquidity",
  safety: "Safety",
  resilience: "Resilience",
  decentralization: "Decentralization",
  dependencyRisk: "Dependency Risk",
};

export const GRADE_THRESHOLDS: { grade: ReportCardGrade; min: number }[] = [
  { grade: "A+", min: 97 },
  { grade: "A", min: 93 },
  { grade: "A-", min: 90 },
  { grade: "B+", min: 85 },
  { grade: "B", min: 80 },
  { grade: "B-", min: 75 },
  { grade: "C+", min: 70 },
  { grade: "C", min: 65 },
  { grade: "C-", min: 60 },
  { grade: "D", min: 50 },
  { grade: "F", min: 0 },
];

/** Grade color classes — matches and extends GRADE_COLORS from classification.ts */
export const REPORT_CARD_GRADE_COLORS: Record<ReportCardGrade, string> = {
  "A+": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  A: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "A-": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "B+": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  B: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "B-": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "C+": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  C: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "C-": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  D: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  F: "bg-red-500/10 text-red-500 border-red-500/20",
  NR: "bg-muted text-muted-foreground border-border",
};

/** Hex colors for radar chart fills, keyed by grade range */
export const GRADE_RADAR_COLORS: Record<string, string> = {
  A: "#10b981",    // emerald
  B: "#3b82f6",    // blue
  C: "#f59e0b",    // amber
  D: "#f97316",    // orange
  F: "#ef4444",    // red
  NR: "#94a3b8",   // slate
};

// ── Score → Grade conversion ────────────────────────────────────────

export function scoreToGrade(score: number | null): ReportCardGrade {
  if (score === null) return "NR";
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  for (const { grade, min } of GRADE_THRESHOLDS) {
    if (clamped >= min) return grade;
  }
  return "F";
}

/** Convert a Bluechip letter grade to a numeric score (for the safety dimension) */
const BLUECHIP_GRADE_TO_SCORE: Record<BluechipGrade, number> = {
  "A+": 100, A: 95, "A-": 90,
  "B+": 85, B: 80, "B-": 75,
  "C+": 70, C: 65, "C-": 60,
  D: 50, F: 25,
};

// ── Per-Dimension Scorers ───────────────────────────────────────────

export function scorePegStability(
  peg: PegSummaryCoin | undefined,
  meta: StablecoinMeta,
): ReportCardDimension {
  if (!peg || peg.pegScore === null) {
    return { grade: "NR", score: null, detail: "No peg data available" };
  }

  let score = peg.pegScore;

  // Active depeg: cap at C (65)
  if (peg.activeDepeg) {
    score = Math.min(score, 65);
    return {
      grade: scoreToGrade(score),
      score,
      detail: `${score}/100 — currently depegged (${Math.abs(peg.currentDeviationBps ?? 0)} bps deviation)`,
    };
  }

  // No events in 12+ months bonus
  const twelveMonthsAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
  if (peg.eventCount === 0 || (peg.lastEventAt !== null && peg.lastEventAt < twelveMonthsAgo)) {
    score = Math.min(100, score + 3);
  }

  const navNote = meta.flags.navToken ? " (NAV token — expected drift excluded)" : "";
  const eventNote = peg.eventCount === 0
    ? "no depeg events recorded"
    : `${peg.eventCount} depeg event${peg.eventCount > 1 ? "s" : ""}`;

  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — ${eventNote}${navNote}`,
  };
}

export function scoreLiquidity(
  liq: DexLiquidityData | undefined,
): ReportCardDimension {
  if (!liq || liq.liquidityScore === null) {
    return { grade: "NR", score: null, detail: "No DEX liquidity data" };
  }

  let score = liq.liquidityScore;

  // HHI concentration penalty
  if (liq.concentrationHhi !== null) {
    if (liq.concentrationHhi > 0.8) {
      score = Math.max(0, score - 10);
    } else if (liq.concentrationHhi > 0.5) {
      score = Math.max(0, score - 5);
    }
  }

  const hhi = liq.concentrationHhi !== null ? `, HHI ${liq.concentrationHhi.toFixed(2)}` : "";
  const chains = liq.chainCount > 0 ? ` across ${liq.chainCount} chain${liq.chainCount > 1 ? "s" : ""}` : "";

  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — ${liq.poolCount} pools${chains}${hhi}`,
  };
}

export function scoreSafety(
  rating: BluechipRating | undefined,
): ReportCardDimension {
  if (!rating) {
    return { grade: "NR", score: null, detail: "Not rated by Bluechip" };
  }

  const score = BLUECHIP_GRADE_TO_SCORE[rating.grade];
  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — Bluechip SMIDGE rating ${rating.grade}`,
  };
}

export function scoreResilience(
  chainCount: number,
  freezeEventsPerMonth: number | null,
  hasTrackedFreezeEvents: boolean,
): ReportCardDimension {
  // Chain distribution (60% of resilience)
  let chainScore: number;
  if (chainCount <= 1) chainScore = 40;
  else if (chainCount === 2) chainScore = 55;
  else if (chainCount === 3) chainScore = 65;
  else if (chainCount <= 5) chainScore = 75;
  else if (chainCount <= 8) chainScore = 85;
  else chainScore = 95;

  // Freeze event rate (40% of resilience)
  let freezeScore: number;
  if (hasTrackedFreezeEvents && freezeEventsPerMonth !== null) {
    freezeScore = Math.max(0, Math.min(100, 100 - freezeEventsPerMonth * 2));
  } else {
    freezeScore = 85; // Neutral-positive for untracked coins
  }

  const score = Math.round(chainScore * 0.6 + freezeScore * 0.4);
  const freezeNote = hasTrackedFreezeEvents
    ? `, ${freezeEventsPerMonth?.toFixed(1) ?? "?"} freeze events/month`
    : "";

  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — ${chainCount} chain${chainCount !== 1 ? "s" : ""}${freezeNote}`,
  };
}

export function scoreDecentralization(
  governance: GovernanceType,
): ReportCardDimension {
  const GOVERNANCE_SCORES: Record<GovernanceType, number> = {
    decentralized: 95,
    "centralized-dependent": 70,
    centralized: 50,
  };
  const GOVERNANCE_LABELS: Record<GovernanceType, string> = {
    decentralized: "decentralized governance (DeFi)",
    "centralized-dependent": "CeFi-dependent governance",
    centralized: "centralized governance (CeFi)",
  };

  const score = GOVERNANCE_SCORES[governance];
  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — ${GOVERNANCE_LABELS[governance]}`,
  };
}

export function scoreDependencyRisk(
  meta: StablecoinMeta,
  overallScores: Map<string, number>, // already-computed overall scores for dependencies
): ReportCardDimension {
  if (meta.flags.governance !== "centralized-dependent") {
    return {
      grade: scoreToGrade(95),
      score: 95,
      detail: "95/100 — no upstream dependencies",
    };
  }

  const deps = meta.dependencies ?? [];
  if (deps.length === 0) {
    // CeFi-Dependent but no explicit dependencies mapped yet
    return {
      grade: scoreToGrade(70),
      score: 70,
      detail: "70/100 — dependencies not yet mapped",
    };
  }

  const depScores = deps
    .map((id) => overallScores.get(id))
    .filter((s): s is number => s !== undefined);

  if (depScores.length === 0) {
    return {
      grade: scoreToGrade(70),
      score: 70,
      detail: "70/100 — dependency scores unavailable",
    };
  }

  let score = Math.round(depScores.reduce((a, b) => a + b, 0) / depScores.length);

  // Penalty if any dependency below B- (75)
  if (depScores.some((s) => s < 75)) {
    score = Math.max(0, score - 10);
  }

  return {
    grade: scoreToGrade(score),
    score,
    detail: `${score}/100 — average of ${depScores.length} upstream dependency score${depScores.length > 1 ? "s" : ""}`,
  };
}

// ── Overall Grade Computation ───────────────────────────────────────

/** Minimum rated dimensions to produce an overall grade (otherwise NR) */
const MIN_RATED_DIMENSIONS = 3;

export function computeOverallGrade(
  dimensions: Record<DimensionKey, ReportCardDimension>,
): { grade: ReportCardGrade; score: number | null; ratedDimensions: number } {
  const ratedKeys = (Object.keys(dimensions) as DimensionKey[]).filter(
    (k) => dimensions[k].score !== null,
  );
  const ratedDimensions = ratedKeys.length;

  if (ratedDimensions < MIN_RATED_DIMENSIONS) {
    return { grade: "NR", score: null, ratedDimensions };
  }

  // Redistribute weights among rated dimensions
  const totalWeight = ratedKeys.reduce((sum, k) => sum + DIMENSION_WEIGHTS[k], 0);
  let weightedSum = 0;
  for (const k of ratedKeys) {
    const adjustedWeight = DIMENSION_WEIGHTS[k] / totalWeight;
    weightedSum += (dimensions[k].score ?? 0) * adjustedWeight;
  }

  const score = Math.round(weightedSum);
  return { grade: scoreToGrade(score), score, ratedDimensions };
}

// ── Grade range helper for radar chart colors ───────────────────────

export function gradeRange(grade: ReportCardGrade): string {
  if (grade === "NR") return "NR";
  if (grade.startsWith("A")) return "A";
  if (grade.startsWith("B")) return "B";
  if (grade.startsWith("C")) return "C";
  if (grade === "D") return "D";
  return "F";
}
```

**Step 3: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/report-cards.ts
git commit -m "feat(report-cards): add shared grading logic and report card types"
```

---

## Task 3: Create the Worker API handler (`/api/report-cards`)

**Files:**
- Create: `worker/src/api/report-cards.ts`
- Modify: `worker/src/router.ts` (register route)

**Step 1: Create `worker/src/api/report-cards.ts`**

This handler reads from existing D1 caches and computes grades on-the-fly. It follows the same pattern as `peg-summary.ts` — no new cron, no new tables.

```typescript
import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { DEAD_STABLECOINS } from "../../../src/lib/dead-stablecoins";
import type {
  StablecoinData,
  PegSummaryCoin,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  ReportCardsResponse,
  DimensionKey,
  BlacklistEvent,
} from "../../../src/lib/types";
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  GRADE_THRESHOLDS,
  scorePegStability,
  scoreLiquidity,
  scoreSafety,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
} from "../../../src/lib/report-cards";

/** Stablecoin IDs with tracked freeze events (Freeze Tracker covers these) */
const FREEZE_TRACKED_IDS = new Set(["1", "2", "gold-paxg", "gold-xaut"]);

export const handleReportCards = withErrorHandler(
  "report-cards",
  async (db: D1Database): Promise<Response> => {
    // 1. Load all caches in parallel
    const [stablecoinsCached, pegSummaryCached, dexLiquidityCached, bluechipCached] =
      await Promise.all([
        getCache(db, "stablecoins"),
        getCache(db, "peg-summary"),    // Note: peg-summary is computed, not cached. Read it differently.
        getCache(db, "dex-liquidity"),   // Note: same — may need direct compute or cache.
        getCache(db, "bluechip-ratings"),
      ]);

    // Parse caches (gracefully handle missing data)
    const stablecoinsData: StablecoinData[] = stablecoinsCached
      ? (JSON.parse(stablecoinsCached.value) as { peggedAssets: StablecoinData[] }).peggedAssets
      : [];

    // Peg summary: if not cached, we won't have peg scores
    // The peg-summary endpoint computes on the fly, but the data we need is pegScore per coin.
    // We need to either call the peg-summary computation directly or read from a separate source.
    // Since peg-summary is computed on-the-fly (not a cache key), we need to compute peg scores here.
    // Alternative: read depeg_events + stablecoins cache and compute peg scores inline.
    // For simplicity, we'll import computePegScore and do a minimal version here.

    // Actually, let's query the blacklist events for freeze rate computation
    const blacklistResult = await db
      .prepare("SELECT stablecoin, COUNT(*) as cnt, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM blacklist_events GROUP BY stablecoin")
      .all<{ stablecoin: string; cnt: number; earliest: number; latest: number }>();

    // Build freeze rate map (events per month)
    const freezeRates = new Map<string, number>();
    const FREEZE_STABLECOIN_TO_ID: Record<string, string> = {
      USDT: "1", USDC: "2", PAXG: "gold-paxg", XAUT: "gold-xaut",
    };
    for (const row of blacklistResult.results ?? []) {
      const id = FREEZE_STABLECOIN_TO_ID[row.stablecoin];
      if (id && row.earliest < row.latest) {
        const months = (row.latest - row.earliest) / (30 * 86400);
        freezeRates.set(id, months > 0 ? row.cnt / months : 0);
      }
    }

    // Build lookup maps
    const stablecoinById = new Map(stablecoinsData.map((a) => [a.id, a]));
    const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));

    // Parse peg summary (the endpoint computes this on the fly, but if we cached it we can read it)
    // We'll try to use the peg-summary as a cached response from a previous API call
    // Actually: peg-summary is NOT a cache key. It's computed on the fly by the handler.
    // We need to either:
    //   a) Import the peg score computation (computePegScore) and run it here too
    //   b) Cache peg-summary results and read from cache
    // Option (a) is cleaner — import computePegScore from src/lib/peg-score.ts

    // For peg scores, read depeg events from DB (same as peg-summary handler does)
    const { computePegScore } = await import("../../../src/lib/peg-score");
    const { derivePegRates, getPegReference } = await import("../../../src/lib/peg-rates");
    const { sumPegBuckets } = await import("../../../src/lib/supply");
    const { rowToDepegEvent } = await import("../lib/depeg-helpers");
    type DepegRow = { id: number; stablecoin_id: string; symbol: string; peg_type: string; direction: string; peak_deviation_bps: number; started_at: number; ended_at: number | null; start_price: number; peak_price: number | null; recovery_price: number | null; peg_reference: number; source: string };

    const fourYearsAgoSec = Math.floor(Date.now() / 1000) - Math.ceil(4 * 365.25 * 86400);
    const eventsResult = await db
      .prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
      .bind(fourYearsAgoSec)
      .all<DepegRow>();
    const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);

    const eventsByCoins = new Map<string, typeof allEvents>();
    for (const e of allEvents) {
      const list = eventsByCoins.get(e.stablecoinId) ?? [];
      list.push(e);
      eventsByCoins.set(e.stablecoinId, list);
    }

    const now = Math.floor(Date.now() / 1000);
    const fourYearsAgo = now - 4 * 365.25 * 86400;
    const fxFallbackRates = stablecoinsCached
      ? (JSON.parse(stablecoinsCached.value) as { fxFallbackRates?: Record<string, number> }).fxFallbackRates
      : undefined;
    const { rates: pegRates } = derivePegRates(stablecoinsData, metaById, fxFallbackRates);

    // Build peg summary map
    const pegScoreMap = new Map<string, PegSummaryCoin>();
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.navToken) continue;
      const asset = stablecoinById.get(meta.id);
      const events = eventsByCoins.get(meta.id) ?? [];
      let currentBps: number | null = null;
      if (asset?.price != null && typeof asset.price === "number" && !isNaN(asset.price)) {
        const supply = asset.circulating ? sumPegBuckets(asset.circulating) : 0;
        if (supply >= 1_000_000) {
          const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
          if (pegRef > 0) {
            currentBps = Math.round(((asset.price / pegRef) - 1) * 10000);
          }
        }
      }
      const trackingStart = events.length > 0
        ? Math.min(Math.min(...events.map((e) => e.startedAt)), fourYearsAgo)
        : fourYearsAgo;
      const scoreResult = computePegScore(events, trackingStart, now);
      pegScoreMap.set(meta.id, {
        id: meta.id,
        symbol: meta.symbol,
        name: meta.name,
        pegType: asset?.pegType ?? "",
        pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: currentBps,
        pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct,
        severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty,
        eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg,
        lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
      });
    }

    // Parse DEX liquidity
    const dexLiqMap: Record<string, DexLiquidityData> = dexLiquidityCached
      ? JSON.parse(dexLiquidityCached.value)
      : {};

    // Parse Bluechip ratings
    const bluechipMap: Record<string, BluechipRating> = bluechipCached
      ? JSON.parse(bluechipCached.value)
      : {};

    // Dead stablecoin IDs for defunct check
    const deadIds = new Set(DEAD_STABLECOINS.filter((d) => d.llamaId).map((d) => d.llamaId!));

    // ── Phase 1: Compute grades for non-dependent coins (centralized + decentralized) ──
    const overallScores = new Map<string, number>();
    const cards: ReportCard[] = [];

    const nonDependent = TRACKED_STABLECOINS.filter(
      (m) => m.flags.governance !== "centralized-dependent",
    );
    const dependent = TRACKED_STABLECOINS.filter(
      (m) => m.flags.governance === "centralized-dependent",
    );

    for (const meta of nonDependent) {
      const card = buildCard(meta, false);
      cards.push(card);
      if (card.overallScore !== null) overallScores.set(meta.id, card.overallScore);
    }

    // ── Phase 2: Compute grades for dependent coins (using Phase 1 scores) ──
    for (const meta of dependent) {
      const card = buildCard(meta, false);
      cards.push(card);
      if (card.overallScore !== null) overallScores.set(meta.id, card.overallScore);
    }

    // ── Add defunct cemetery coins as permanent F ──
    for (const dead of DEAD_STABLECOINS) {
      cards.push({
        id: dead.llamaId ?? `dead-${dead.symbol.toLowerCase()}`,
        name: dead.name,
        symbol: dead.symbol,
        overallGrade: "F",
        overallScore: 0,
        dimensions: {
          pegStability: { grade: "F", score: 0, detail: "Defunct" },
          liquidity: { grade: "F", score: 0, detail: "Defunct" },
          safety: { grade: "F", score: 0, detail: "Defunct" },
          resilience: { grade: "F", score: 0, detail: "Defunct" },
          decentralization: { grade: "F", score: 0, detail: "Defunct" },
          dependencyRisk: { grade: "F", score: 0, detail: "Defunct" },
        },
        ratedDimensions: 6,
        isDefunct: true,
      });
    }

    // Sort by overall score descending (NR at bottom)
    cards.sort((a, b) => (b.overallScore ?? -1) - (a.overallScore ?? -1));

    const response: ReportCardsResponse = {
      cards,
      methodology: {
        version: METHODOLOGY_VERSION,
        weights: DIMENSION_WEIGHTS,
        thresholds: GRADE_THRESHOLDS,
      },
      updatedAt: now,
    };

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.standard,  // 5 min edge, 1 min browser
      },
    });

    // ── Helper ──────────────────────────────────────────────────────

    function buildCard(meta: StablecoinMeta, isDefunct: boolean): ReportCard {
      const asset = stablecoinById.get(meta.id);
      const chainCount = asset?.chains?.length ?? 0;

      const dimensions = {
        pegStability: scorePegStability(pegScoreMap.get(meta.id), meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        safety: scoreSafety(bluechipMap[meta.id]),
        resilience: scoreResilience(
          chainCount,
          freezeRates.get(meta.id) ?? null,
          FREEZE_TRACKED_IDS.has(meta.id),
        ),
        decentralization: scoreDecentralization(meta.flags.governance),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };

      const overall = computeOverallGrade(dimensions);

      return {
        id: meta.id,
        name: meta.name,
        symbol: meta.symbol,
        overallGrade: overall.grade,
        overallScore: overall.score,
        dimensions,
        ratedDimensions: overall.ratedDimensions,
        dependencies: meta.dependencies,
        isDefunct,
      };
    }
  },
);
```

**Important notes for the implementer:**
- The handler recomputes peg scores inline (same as `peg-summary.ts`), reading depeg events from D1. This is the cleanest approach — no new cron or cache key needed.
- DEX liquidity data IS cached under the `"dex-liquidity"` key. Bluechip ratings are cached under `"bluechip-ratings"`. Both are read from cache directly.
- Blacklist events are queried from the `blacklist_events` table (aggregated by stablecoin) for freeze rate.
- The `CACHE_PROFILES.standard` profile (5 min edge / 1 min browser) is appropriate since underlying data refreshes every 15-20 min.

**Step 2: Register the route in `worker/src/router.ts`**

Add import at top:
```typescript
import { handleReportCards } from "./api/report-cards";
```

Add route before the `/api/stablecoin/:id` dynamic route (around line 107):
```typescript
if (path === "/api/report-cards") {
  return handleReportCards(db);
}
```

**Step 3: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Test locally**

Run: `cd worker && npx wrangler dev`
Then: `curl http://localhost:8787/api/report-cards | jq '.cards | length'`
Expected: ~141 cards returned.

**Step 5: Commit**

```bash
git add worker/src/api/report-cards.ts worker/src/router.ts
git commit -m "feat(report-cards): add /api/report-cards Worker endpoint"
```

---

## Task 4: Create the TanStack Query hook

**Files:**
- Create: `src/hooks/use-report-cards.ts`

**Step 1: Create `src/hooks/use-report-cards.ts`**

```typescript
"use client";

import type { ReportCardsResponse, ReportCardMap } from "@/lib/types";
import { useApiQuery, CRON_15MIN } from "./use-api-query";

export function useReportCards() {
  return useApiQuery<ReportCardsResponse>(
    ["report-cards"],
    "/api/report-cards",
    CRON_15MIN,  // Match standard cache profile (5 min edge)
  );
}
```

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/hooks/use-report-cards.ts
git commit -m "feat(report-cards): add useReportCards TanStack Query hook"
```

---

## Task 5: Create the Radar Chart component

**Files:**
- Create: `src/components/radar-chart.tsx`

**Step 1: Create `src/components/radar-chart.tsx`**

Uses Recharts `RadarChart` (already a project dependency). Renders a hexagonal spider chart with 6 axes.

```typescript
"use client";

import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";
import type { ReportCard, DimensionKey } from "@/lib/types";
import { DIMENSION_LABELS, gradeRange, GRADE_RADAR_COLORS } from "@/lib/report-cards";

const DIMENSION_ORDER: DimensionKey[] = [
  "pegStability",
  "liquidity",
  "safety",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

interface ReportCardRadarProps {
  card: ReportCard;
  size?: number;        // Container height in px (default 250)
  showLabels?: boolean; // Show dimension labels on axes (default true)
  className?: string;
}

export function ReportCardRadar({
  card,
  size = 250,
  showLabels = true,
  className,
}: ReportCardRadarProps) {
  const data = DIMENSION_ORDER.map((key) => ({
    dimension: showLabels ? DIMENSION_LABELS[key] : key,
    score: card.dimensions[key].score ?? 0,
    fullMark: 100,
  }));

  const fillColor = GRADE_RADAR_COLORS[gradeRange(card.overallGrade)] ?? GRADE_RADAR_COLORS.NR;

  return (
    <div className={className} style={{ width: "100%", height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="currentColor" className="text-border" />
          {showLabels && (
            <PolarAngleAxis
              dataKey="dimension"
              tick={{ fontSize: 11, fill: "currentColor" }}
              className="text-muted-foreground"
            />
          )}
          <Radar
            dataKey="score"
            stroke={fillColor}
            fill={fillColor}
            fillOpacity={0.25}
            strokeWidth={2}
          />
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

**For the compare page**, add an overlay variant:

```typescript
interface CompareRadarProps {
  cards: { card: ReportCard; color: string }[];
  size?: number;
  className?: string;
}

export function CompareRadar({ cards, size = 300, className }: CompareRadarProps) {
  // Build merged data array with one score per card
  const data = DIMENSION_ORDER.map((key) => {
    const point: Record<string, string | number> = { dimension: DIMENSION_LABELS[key] };
    cards.forEach(({ card }, i) => {
      point[`score${i}`] = card.dimensions[key].score ?? 0;
    });
    return point;
  });

  return (
    <div className={className} style={{ width: "100%", height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsRadarChart data={data} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="currentColor" className="text-border" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-muted-foreground"
          />
          {cards.map(({ card, color }, i) => (
            <Radar
              key={card.id}
              dataKey={`score${i}`}
              stroke={color}
              fill={color}
              fillOpacity={0.15}
              strokeWidth={2}
              name={card.symbol}
            />
          ))}
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/radar-chart.tsx
git commit -m "feat(report-cards): add hexagonal radar chart component"
```

---

## Task 6: Create the Report Card detail component

**Files:**
- Create: `src/components/report-card.tsx`

This is the full-featured report card component used on the detail page (`/stablecoin/[id]`). Shows the large overall grade, radar chart, and per-dimension breakdown.

**Step 1: Create `src/components/report-card.tsx`**

Layout: two-column — radar chart on left, dimension list on right. Dependency callout at bottom for CeFi-Dependent coins.

```typescript
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard as ReportCardType, DimensionKey } from "@/lib/types";
import {
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_LABELS,
  METHODOLOGY_VERSION,
} from "@/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import Link from "next/link";

const DIMENSION_ORDER: DimensionKey[] = [
  "pegStability", "liquidity", "safety", "resilience", "decentralization", "dependencyRisk",
];

interface ReportCardDetailProps {
  card: ReportCardType;
}

export function ReportCardDetail({ card }: ReportCardDetailProps) {
  if (card.isDefunct) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pharos Report Card</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <span className="text-4xl font-bold font-mono text-red-500">F</span>
            <span className="text-muted-foreground">Defunct — this stablecoin is no longer active.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const gradeColor = REPORT_CARD_GRADE_COLORS[card.overallGrade];

  // Resolve dependency names
  const depNames = (card.dependencies ?? [])
    .map((id) => TRACKED_STABLECOINS.find((s) => s.id === id))
    .filter(Boolean);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Pharos Report Card</CardTitle>
          <span className="text-xs text-muted-foreground">Methodology v{METHODOLOGY_VERSION}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left: Overall grade + radar chart */}
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Overall</span>
              <Badge variant="outline" className={`text-2xl font-bold font-mono px-3 py-1 ${gradeColor}`}>
                {card.overallGrade}
              </Badge>
              {card.overallScore !== null && (
                <span className="text-sm text-muted-foreground">{card.overallScore}/100</span>
              )}
            </div>
            <ReportCardRadar card={card} size={250} />
          </div>

          {/* Right: Dimension breakdown */}
          <div className="space-y-3">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              const dimColor = REPORT_CARD_GRADE_COLORS[dim.grade];
              return (
                <div key={key} className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{DIMENSION_LABELS[key]}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className={`text-xs font-mono px-1.5 py-0 ${dimColor}`}>
                      {dim.grade}
                    </Badge>
                    {dim.score !== null && (
                      <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
                        {dim.score}/100
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Dependency callout for CeFi-Dependent coins */}
        {depNames.length > 0 && (
          <div className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
            <span className="text-amber-600 dark:text-amber-400 font-medium">Dependency notice: </span>
            <span className="text-muted-foreground">
              This coin depends on{" "}
              {depNames.map((dep, i) => (
                <span key={dep!.id}>
                  {i > 0 && (i === depNames.length - 1 ? " and " : ", ")}
                  <Link href={`/stablecoin/${dep!.id}`} className="text-foreground underline underline-offset-2 hover:text-primary">
                    {dep!.symbol}
                  </Link>
                </span>
              ))}
              . Their grades affect the Dependency Risk score.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/report-card.tsx
git commit -m "feat(report-cards): add full report card detail component with radar chart"
```

---

## Task 7: Create the Report Card mini tile component

**Files:**
- Create: `src/components/report-card-mini.tsx`

Compact card tile for the grid view on the `/report-cards` page. Contains: name, overall grade, mini radar, market cap.

```typescript
"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard } from "@/lib/types";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";
import { StablecoinLogo } from "./stablecoin-logo"; // if this component exists; otherwise use Image

interface ReportCardMiniProps {
  card: ReportCard;
  mcap?: number | null;  // from StablecoinData
  logo?: string;
}

export function ReportCardMini({ card, mcap, logo }: ReportCardMiniProps) {
  const gradeColor = REPORT_CARD_GRADE_COLORS[card.overallGrade];

  return (
    <Link href={`/stablecoin/${card.id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
        <CardContent className="p-4 flex flex-col items-center gap-2">
          {/* Header: logo + name + symbol */}
          <div className="flex items-center gap-2 w-full">
            {logo && (
              <img src={logo} alt={card.name} className="w-6 h-6 rounded-full" />
            )}
            <div className="truncate">
              <span className="text-sm font-medium">{card.name}</span>
              <span className="text-xs text-muted-foreground ml-1">{card.symbol}</span>
            </div>
          </div>

          {/* Large grade badge */}
          <Badge variant="outline" className={`text-xl font-bold font-mono px-3 py-1 ${gradeColor}`}>
            {card.overallGrade}
          </Badge>

          {/* Mini radar chart */}
          {!card.isDefunct && (
            <ReportCardRadar card={card} size={140} showLabels={false} />
          )}

          {card.isDefunct && (
            <span className="text-xs text-muted-foreground">Defunct</span>
          )}

          {/* Market cap */}
          {mcap != null && mcap > 0 && (
            <span className="text-xs text-muted-foreground">
              ${mcap >= 1e9 ? `${(mcap / 1e9).toFixed(1)}B` : mcap >= 1e6 ? `${(mcap / 1e6).toFixed(0)}M` : `${(mcap / 1e3).toFixed(0)}K`}
            </span>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
```

**Important:** Verify that `StablecoinLogo` or equivalent exists in the codebase. If not, use a plain `<img>` or `next/image`. Check the homepage table for how logos are rendered — it uses `logos` prop as a `Record<string, string>` (coin ID → logo URL).

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/report-card-mini.tsx
git commit -m "feat(report-cards): add compact report card tile for grid view"
```

---

## Task 8: Create the Report Cards page (`/report-cards`)

**Files:**
- Create: `src/app/report-cards/page.tsx` (server component with metadata)
- Create: `src/app/report-cards/client.tsx` (client component with data fetching)
- Modify: `src/components/header.tsx` (add nav item)

**Step 1: Create `src/app/report-cards/page.tsx`**

Follow the pattern from `src/app/liquidity/page.tsx`:

```typescript
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { ReportCardsClient } from "./client";

const reportCardsDescription =
  "Transparent, data-driven grades for every tracked stablecoin. Six dimensions — peg stability, liquidity, safety, resilience, decentralization, and dependency risk — combined into a single letter grade.";

export const metadata: Metadata = {
  title: "Report Cards — Stablecoin Safety Grades",
  description: reportCardsDescription,
  alternates: { canonical: "/report-cards/" },
  openGraph: {
    title: "Stablecoin Report Cards — Pharos",
    description: reportCardsDescription,
    url: "https://pharos.watch/report-cards/",
    type: "website",
  },
};

export default function ReportCardsPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Report Cards" path="/report-cards/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Report Cards</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Report Cards</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {reportCardsDescription}
        </p>
      </div>
      <Suspense>
        <ReportCardsClient />
      </Suspense>
    </div>
  );
}
```

**Step 2: Create `src/app/report-cards/client.tsx`**

This is the main client component. It fetches report cards data and renders:
1. Grade distribution bar chart (summary)
2. Filter row (grade range + sort)
3. Card grid with `ReportCardMini` tiles

Features:
- **Filters:** All, A-range, B-range, C-range, D, F, NR
- **Sort by:** Overall (default), Peg, Liquidity, Safety, Resilience, Decentralization, Dependency, MCap
- **Defunct toggle:** Show/hide cemetery coins (hidden by default)

The client component uses `useReportCards()` hook and also `useStablecoins()` (for market cap data and logos). Follow the pattern from `src/app/liquidity/client.tsx` or `src/app/peg-tracker/client.tsx`.

```typescript
"use client";

import { useState, useMemo } from "react";
import { useReportCards } from "@/hooks/use-report-cards";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { ReportCardMini } from "@/components/report-card-mini";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ReportCard, DimensionKey, ReportCardGrade } from "@/lib/types";
import { REPORT_CARD_GRADE_COLORS, gradeRange } from "@/lib/report-cards";
import { sumPegBuckets } from "@/lib/supply";

type GradeFilter = "all" | "A" | "B" | "C" | "D" | "F" | "NR";
type SortKey = "overall" | DimensionKey | "mcap";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "overall", label: "Overall" },
  { key: "pegStability", label: "Peg" },
  { key: "liquidity", label: "Liquidity" },
  { key: "safety", label: "Safety" },
  { key: "resilience", label: "Resilience" },
  { key: "decentralization", label: "Decent." },
  { key: "dependencyRisk", label: "Depend." },
  { key: "mcap", label: "MCap" },
];

export function ReportCardsClient() {
  const { data, isLoading } = useReportCards();
  const { data: stablecoinsData } = useStablecoins();
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [showDefunct, setShowDefunct] = useState(false);

  // Build mcap + logo maps from stablecoins data
  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(
      stablecoinsData.peggedAssets.map((a) => [
        a.id,
        a.circulating ? sumPegBuckets(a.circulating) : 0,
      ]),
    );
  }, [stablecoinsData]);

  // TODO: logos map — check how homepage-client.tsx builds this.
  // It likely comes from a separate API or static mapping.

  const filteredCards = useMemo(() => {
    if (!data?.cards) return [];
    let cards = data.cards;

    // Hide defunct unless toggled
    if (!showDefunct) cards = cards.filter((c) => !c.isDefunct);

    // Grade filter
    if (gradeFilter !== "all") {
      cards = cards.filter((c) => gradeRange(c.overallGrade) === gradeFilter);
    }

    // Sort
    cards = [...cards].sort((a, b) => {
      if (sortKey === "overall") return (b.overallScore ?? -1) - (a.overallScore ?? -1);
      if (sortKey === "mcap") return (mcapMap.get(b.id) ?? 0) - (mcapMap.get(a.id) ?? 0);
      // Dimension sort
      const dimKey = sortKey as DimensionKey;
      return (b.dimensions[dimKey].score ?? -1) - (a.dimensions[dimKey].score ?? -1);
    });

    return cards;
  }, [data, gradeFilter, sortKey, showDefunct, mcapMap]);

  // Grade distribution counts
  const distribution = useMemo(() => {
    if (!data?.cards) return {};
    const counts: Record<string, number> = {};
    for (const card of data.cards.filter((c) => !c.isDefunct)) {
      const range = gradeRange(card.overallGrade);
      counts[range] = (counts[range] ?? 0) + 1;
    }
    return counts;
  }, [data]);

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading report cards...</div>;
  }

  if (!data?.cards?.length) {
    return <div className="text-muted-foreground text-sm">No report card data available yet.</div>;
  }

  const gradeFilters: { key: GradeFilter; label: string }[] = [
    { key: "all", label: `All (${data.cards.filter((c) => !c.isDefunct).length})` },
    { key: "A", label: `A (${distribution["A"] ?? 0})` },
    { key: "B", label: `B (${distribution["B"] ?? 0})` },
    { key: "C", label: `C (${distribution["C"] ?? 0})` },
    { key: "D", label: `D (${distribution["D"] ?? 0})` },
    { key: "F", label: `F (${distribution["F"] ?? 0})` },
    { key: "NR", label: `NR (${distribution["NR"] ?? 0})` },
  ];

  return (
    <div className="space-y-6">
      {/* Grade distribution summary */}
      <Card>
        <CardContent className="p-4">
          <h2 className="text-sm font-medium mb-3">Grade Distribution</h2>
          <div className="flex gap-1 h-8">
            {(["A", "B", "C", "D", "F", "NR"] as const).map((range) => {
              const count = distribution[range] ?? 0;
              const total = data.cards.filter((c) => !c.isDefunct).length;
              const pct = total > 0 ? (count / total) * 100 : 0;
              if (pct === 0) return null;
              const color = REPORT_CARD_GRADE_COLORS[range === "NR" ? "NR" : `${range}` as ReportCardGrade] ?? "";
              return (
                <div
                  key={range}
                  className={`rounded-sm flex items-center justify-center text-xs font-mono font-medium ${color}`}
                  style={{ width: `${Math.max(pct, 3)}%` }}
                  title={`${range}-range: ${count} coins`}
                >
                  {count > 2 && range}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-2">
        {gradeFilters.map(({ key, label }) => (
          <Button
            key={key}
            variant={gradeFilter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setGradeFilter(key)}
          >
            {label}
          </Button>
        ))}
        <div className="h-4 w-px bg-border mx-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showDefunct}
            onChange={(e) => setShowDefunct(e.target.checked)}
            className="rounded"
          />
          Show defunct
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-muted-foreground text-xs">Sort:</span>
        {SORT_OPTIONS.map(({ key, label }) => (
          <Button
            key={key}
            variant={sortKey === key ? "secondary" : "ghost"}
            size="sm"
            className="text-xs h-7 px-2"
            onClick={() => setSortKey(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {filteredCards.map((card) => (
          <ReportCardMini
            key={card.id}
            card={card}
            mcap={mcapMap.get(card.id)}
          />
        ))}
      </div>

      {filteredCards.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-8">
          No coins match this filter.
        </p>
      )}
    </div>
  );
}
```

**Step 3: Add "Report Cards" to navigation**

In `src/components/header.tsx`, add the import and nav item. Use the `ClipboardCheck` icon from lucide-react (or `Award`, `BarChart3` — pick one that fits).

Add import:
```typescript
import { Activity, ClipboardCheck, Droplets, Info, LayoutDashboard, Menu, ShieldBan, Skull } from "lucide-react";
```

Add nav item after Liquidity (between Liquidity and Cemetery, per the design doc which says "between Liquidity and Compare"):
```typescript
const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/blacklist", label: "Freeze Tracker", icon: ShieldBan },
  { href: "/peg-tracker", label: "Peg Tracker", icon: Activity },
  { href: "/liquidity", label: "Liquidity", icon: Droplets },
  { href: "/report-cards", label: "Report Cards", icon: ClipboardCheck },
  { href: "/cemetery", label: "Cemetery", icon: Skull },
  { href: "/about", label: "About", icon: Info },
];
```

**Step 4: Verify the build**

Run: `npm run build`
Expected: Clean build. New page at `/report-cards/` renders.

**Step 5: Commit**

```bash
git add src/app/report-cards/page.tsx src/app/report-cards/client.tsx src/components/header.tsx
git commit -m "feat(report-cards): add /report-cards page with grade grid, filters, and nav link"
```

---

## Task 9: Add report card section to stablecoin detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

**Step 1: Add the report card section**

In the detail page client component, add `useReportCards()` and render `<ReportCardDetail>` in the appropriate position.

Import the hook and component:
```typescript
import { useReportCards } from "@/hooks/use-report-cards";
import { ReportCardDetail } from "@/components/report-card";
```

In the component body, call the hook:
```typescript
const { data: reportCardsData } = useReportCards();
const reportCard = reportCardsData?.cards.find((c) => c.id === id);
```

Then render the report card section. Place it **after the stat cards grid and BluechipBox/LiquidityBox row** (around line 188 of the client component), **before the AI Summary**:

```tsx
{reportCard && <ReportCardDetail card={reportCard} />}
```

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(report-cards): add report card section to stablecoin detail page"
```

---

## Task 10: Add "Grade" column to homepage table

**Files:**
- Modify: `src/components/stablecoin-table.tsx`
- Modify: `src/components/homepage-client.tsx`

**Step 1: Add report cards data to the table**

In `src/components/homepage-client.tsx`:
- Import `useReportCards`
- Call the hook
- Pass data to StablecoinTable via a new `reportCards` prop

```typescript
import { useReportCards } from "@/hooks/use-report-cards";

// In component body:
const { data: reportCardsData } = useReportCards();
const reportCardMap = useMemo(() => {
  if (!reportCardsData?.cards) return undefined;
  return Object.fromEntries(reportCardsData.cards.map((c) => [c.id, c]));
}, [reportCardsData]);

// Pass to table:
<StablecoinTable
  // ...existing props
  reportCards={reportCardMap}
/>
```

**Step 2: Add the column to the table component**

In `src/components/stablecoin-table.tsx`:

1. Add to props interface:
```typescript
reportCards?: Record<string, ReportCard>;
```

2. Add `"grade"` to the `SortKey` type.

3. Add a "Grade" column header after the existing columns (but before Backing/Type/Flags). Place it next to "Liq" since they're both scores.

4. Add sorting logic for the grade column.

5. Render the grade badge in the table row:
```tsx
{reportCards?.[coin.id] && (
  <Badge
    variant="outline"
    className={`text-xs font-mono px-1 py-0 ${REPORT_CARD_GRADE_COLORS[reportCards[coin.id].overallGrade]}`}
    title={`Pharos grade: ${reportCards[coin.id].overallGrade}${reportCards[coin.id].overallScore ? ` (${reportCards[coin.id].overallScore}/100)` : ""}`}
  >
    {reportCards[coin.id].overallGrade}
  </Badge>
)}
```

**Step 3: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/components/stablecoin-table.tsx src/components/homepage-client.tsx
git commit -m "feat(report-cards): add Grade column to homepage table"
```

---

## Task 11: Add report card comparison to compare page

**Files:**
- Modify: `src/app/compare/client.tsx`

**Step 1: Add report card comparison**

In the compare page client component:

1. Import `useReportCards` and the `CompareRadar` component.
2. Call the hook.
3. After the existing comparison sections (ComparisonTable + ComparisonChart), add a new section showing overlaid radar charts for the selected coins.

```tsx
import { useReportCards } from "@/hooks/use-report-cards";
import { CompareRadar } from "@/components/radar-chart";
import { ReportCardDetail } from "@/components/report-card";

// In component:
const { data: reportCardsData } = useReportCards();

// Build card lookup
const cardMap = useMemo(() => {
  if (!reportCardsData?.cards) return new Map();
  return new Map(reportCardsData.cards.map((c) => [c.id, c]));
}, [reportCardsData]);

// In the comparison section (after ComparisonChart), add:
const compareColors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];
const radarCards = selectedCoins
  .map((id, i) => {
    const card = cardMap.get(id);
    if (!card) return null;
    return { card, color: compareColors[i] };
  })
  .filter(Boolean);

{radarCards.length >= 2 && (
  <Card>
    <CardHeader>
      <CardTitle className="text-lg">Report Card Comparison</CardTitle>
    </CardHeader>
    <CardContent>
      <CompareRadar cards={radarCards} size={350} />
      <div className="flex flex-wrap gap-3 justify-center mt-3">
        {radarCards.map(({ card, color }) => (
          <div key={card.id} className="flex items-center gap-1.5 text-sm">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            <span>{card.symbol}: {card.overallGrade}</span>
          </div>
        ))}
      </div>
    </CardContent>
  </Card>
)}
```

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/app/compare/client.tsx
git commit -m "feat(report-cards): add overlaid radar chart comparison to compare page"
```

---

## Task 12: Add methodology section to about page

**Files:**
- Modify: `src/app/about/page.tsx`

**Step 1: Add methodology content**

Add a section to the about page explaining the report card methodology. This should cover:
- The 6 dimensions and their weights
- Grade thresholds (A+ through F)
- How NR (Not Rated) works
- Dependency risk propagation
- Explicit limitations
- Versioning

Place this as a new section after the existing data sources section. Follow the existing page's formatting patterns.

If the about page is already very long, consider linking to a separate methodology page (`/report-cards/methodology`) instead — but the design doc says "subsection of the About page or linked from the report cards page."

**Key content to include:**
- Table of dimensions with weights and data sources
- Grade threshold table
- Worked example (e.g., "USDC has peg score 97 → A+")
- Limitations section (5 bullet points from design doc)
- "Methodology v1.0" label

**Step 2: Verify the build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "docs(report-cards): add grading methodology section to about page"
```

---

## Task 13: Final integration testing and polish

**Step 1: Full build check**

Run: `npm run build`
Expected: Clean build, no type errors, no warnings.

**Step 2: Worker type check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

**Step 3: Visual review**

Run `npm run dev` and verify:
1. `/report-cards` page loads with grade grid
2. Grade filters and sort work correctly
3. Clicking a card navigates to detail page
4. Detail page shows report card section with radar chart
5. Homepage table has Grade column
6. Compare page shows overlaid radar charts
7. About page has methodology section
8. Navigation shows "Report Cards" link
9. Dark mode works correctly for all new components
10. Mobile responsive layout works

**Step 4: Edge case verification**
- Check a coin with NR overall (few rated dimensions)
- Check a CeFi-Dependent coin (dependency callout shows)
- Check a cemetery/defunct coin (shows F with "Defunct" label)
- Check a yield-bearing/NAV token (peg stability note shows)

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(report-cards): polish and integration testing"
```

---

## Dependency Graph

```
Task 1 (types + stablecoins.ts)
  └─► Task 2 (shared grading logic)
        ├─► Task 3 (Worker API)
        │     └─► Task 4 (TanStack hook)
        │           ├─► Task 8 (report cards page)
        │           ├─► Task 9 (detail page section)
        │           ├─► Task 10 (homepage table column)
        │           └─► Task 11 (compare page)
        ├─► Task 5 (radar chart component)
        │     ├─► Task 6 (report card detail component)
        │     │     └─► Task 9 (detail page section)
        │     └─► Task 7 (report card mini tile)
        │           └─► Task 8 (report cards page)
        └─► Task 12 (about page methodology)

Task 13 (integration testing) depends on all above.
```

**Parallelizable tasks after Task 2:**
- Tasks 3+4 (API + hook) can be done in parallel with Tasks 5+6+7 (components)
- Task 12 (about page) is independent of all UI tasks
- Tasks 8, 9, 10, 11 all depend on Task 4 (hook) + relevant components
