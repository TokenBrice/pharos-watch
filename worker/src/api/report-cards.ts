import { getCache } from "../lib/db";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { computePegScore } from "../../../src/lib/peg-score";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { sumPegBuckets } from "../../../src/lib/supply";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { DEAD_STABLECOINS } from "../../../src/lib/dead-stablecoins";
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
import type {
  StablecoinData,
  DepegEvent,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  ReportCardsResponse,
  PegSummaryCoin,
  DimensionKey,
  GovernanceType,
  RawDimensionInputs,
} from "../../../src/lib/types";

// ---------------------------------------------------------------------------
// Blacklist freeze-rate helpers
// ---------------------------------------------------------------------------

/** Stablecoin names in blacklist_events -> their tracked IDs */
const BLACKLIST_NAME_TO_ID: Record<string, string> = {
  USDT: "1",
  USDC: "2",
  PAXG: "gold-paxg",
  XAUT: "gold-xaut",
};

/** Set of IDs that have tracked freeze/blacklist events */
const COINS_WITH_TRACKED_FREEZE = new Set(Object.values(BLACKLIST_NAME_TO_ID));

interface BlacklistAggRow {
  stablecoin: string;
  cnt: number;
  earliest: number;
  latest: number;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface DexLiquidityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  pool_count: number;
  chain_count: number;
}

export const handleReportCards = withErrorHandler("report-cards", async (db: D1Database): Promise<Response> => {
  // 1. Load caches + dex_liquidity table in parallel
  const [stablecoinsCached, bluechipCached, dexLiqResult] = await Promise.all([
    getCache(db, "stablecoins"),
    getCache(db, "bluechip-ratings"),
    db.prepare("SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count FROM dex_liquidity").all<DexLiquidityRow>(),
  ]);

  if (!stablecoinsCached) {
    return new Response(JSON.stringify({ error: "Data not yet available" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { peggedAssets, fxFallbackRates } = JSON.parse(stablecoinsCached.value) as {
    peggedAssets: StablecoinData[];
    fxFallbackRates?: Record<string, number>;
  };

  // Build dex liquidity map from table rows (only fields scoreLiquidity needs)
  const dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">> = {};
  for (const row of dexLiqResult.results ?? []) {
    dexLiqMap[row.stablecoin_id] = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
    };
  }

  const bluechipMap: Record<string, BluechipRating> = bluechipCached
    ? JSON.parse(bluechipCached.value)
    : {};

  // 2. Load depeg events (4-year window) and blacklist aggregates in parallel
  const fourYearsAgoSec = Math.floor(Date.now() / 1000) - Math.ceil(4 * 365.25 * 86400);

  const [eventsResult, blacklistResult] = await Promise.all([
    db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
      .bind(fourYearsAgoSec)
      .all<DepegRow>(),
    db.prepare(
      "SELECT stablecoin, COUNT(*) as cnt, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM blacklist_events GROUP BY stablecoin",
    ).all<BlacklistAggRow>(),
  ]);

  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);

  // Group events by stablecoin ID
  const eventsByCoins = new Map<string, DepegEvent[]>();
  for (const e of allEvents) {
    const list = eventsByCoins.get(e.stablecoinId) ?? [];
    list.push(e);
    eventsByCoins.set(e.stablecoinId, list);
  }

  // 3. Compute freeze rates from blacklist aggregates
  const freezeRateById = new Map<string, number>();
  for (const row of blacklistResult.results ?? []) {
    const id = BLACKLIST_NAME_TO_ID[row.stablecoin];
    if (!id) continue;
    const spanSec = row.latest - row.earliest;
    if (spanSec > 0) {
      const months = spanSec / (30 * 86400);
      freezeRateById.set(id, row.cnt / months);
    }
    // When spanSec === 0: omit entry, coin gets neutral 85 in scoreResilience
  }

  // 4. Build lookup maps
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates } = derivePegRates(peggedAssets, metaById, fxFallbackRates);
  const now = Math.floor(Date.now() / 1000);
  const fourYearsAgo = now - 4 * 365.25 * 86400;

  // 5. Compute peg summary data per coin (same logic as peg-summary)
  const pegDataById = new Map<string, PegSummaryCoin>();
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoins.get(meta.id) ?? [];

    // Current deviation
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

    // Peg score
    const trackingStart = events.length > 0
      ? Math.min(Math.min(...events.map((e) => e.startedAt)), fourYearsAgo)
      : fourYearsAgo;
    const scoreResult = computePegScore(events, trackingStart, now);

    pegDataById.set(meta.id, {
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

  // 6. Phase 1: Compute grades for non-dependent coins (centralized + decentralized)
  const phase1Cards: ReportCard[] = [];
  const overallScores = new Map<string, number>(); // id -> overall score (for dependency risk)
  const phase2Metas: typeof TRACKED_STABLECOINS = [];

  for (const meta of TRACKED_STABLECOINS) {
    if (meta.flags.governance === "centralized-dependent") {
      phase2Metas.push(meta);
      continue;
    }

    const card = computeCard(meta, pegDataById, priceById, dexLiqMap, bluechipMap, freezeRateById, overallScores);
    phase1Cards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // 7. Phase 2: Compute grades for centralized-dependent coins (using Phase 1 scores)
  const phase2Cards: ReportCard[] = [];
  for (const meta of phase2Metas) {
    const card = computeCard(meta, pegDataById, priceById, dexLiqMap, bluechipMap, freezeRateById, overallScores);
    phase2Cards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // 8. Add cemetery coins as permanent F
  const defunctCards: ReportCard[] = DEAD_STABLECOINS.map((dead) => {
    const id = dead.llamaId ?? `dead-${dead.symbol.toLowerCase()}`;
    const nrDim = { grade: "F" as const, score: 0, detail: "Defunct stablecoin" };
    return {
      id,
      name: dead.name,
      symbol: dead.symbol,
      overallGrade: "F" as const,
      overallScore: 0,
      dimensions: {
        pegStability: nrDim,
        liquidity: nrDim,
        safety: nrDim,
        resilience: nrDim,
        decentralization: nrDim,
        dependencyRisk: nrDim,
      },
      ratedDimensions: 6,
      rawInputs: {
        pegScore: null, activeDepeg: false, depegEventCount: 0, lastEventAt: null,
        liquidityScore: null, concentrationHhi: null, bluechipGrade: null,
        chainCount: 0, freezeEventsPerMonth: null, hasTrackedFreezeEvents: false,
        governanceTier: "centralized" as GovernanceType, dependencies: [],
      },
      isDefunct: true,
    };
  });

  // 9. Combine and sort by overall score descending (NR at bottom)
  const allCards = [...phase1Cards, ...phase2Cards, ...defunctCards];
  allCards.sort((a, b) => {
    // NR (null score) goes to bottom
    if (a.overallScore === null && b.overallScore === null) return 0;
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });

  // 10. Build dependency graph edge list
  const edges: { from: string; to: string }[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.dependencies) {
      for (const dep of meta.dependencies) {
        edges.push({ from: dep.id, to: meta.id });
      }
    }
  }

  // 11. Return ReportCardsResponse
  const response: ReportCardsResponse = {
    cards: allCards,
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      thresholds: GRADE_THRESHOLDS,
    },
    dependencyGraph: { edges },
    updatedAt: stablecoinsCached.updatedAt,
  };

  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    },
  });
});

// ---------------------------------------------------------------------------
// Per-coin card computation
// ---------------------------------------------------------------------------

function computeCard(
  meta: (typeof TRACKED_STABLECOINS)[number],
  pegDataById: Map<string, PegSummaryCoin>,
  priceById: Map<string, StablecoinData>,
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>,
  bluechipMap: Record<string, BluechipRating>,
  freezeRateById: Map<string, number>,
  overallScores: Map<string, number>,
): ReportCard {
  const peg = pegDataById.get(meta.id);
  const liq = dexLiqMap[meta.id];
  const rating = bluechipMap[meta.id];

  // Chain count: from deployment data (how many chains the coin is on), not DEX pools
  const asset = priceById.get(meta.id);
  const chainCount = asset?.chains?.length ?? 1;

  // Freeze rate
  const hasTrackedFreezeEvents = COINS_WITH_TRACKED_FREEZE.has(meta.id);
  const freezeEventsPerMonth = freezeRateById.get(meta.id) ?? null;

  // Score each dimension
  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq),
    safety: scoreSafety(rating),
    resilience: scoreResilience(chainCount, freezeEventsPerMonth, hasTrackedFreezeEvents),
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType),
    dependencyRisk: scoreDependencyRisk(meta, overallScores),
  };

  const overall = computeOverallGrade(dimensions);

  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: liq?.liquidityScore ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    chainCount,
    freezeEventsPerMonth,
    hasTrackedFreezeEvents,
    governanceTier: meta.flags.governance as GovernanceType,
    dependencies: meta.dependencies ?? [],
  };

  return {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    overallGrade: overall.grade,
    overallScore: overall.score,
    dimensions,
    ratedDimensions: overall.ratedDimensions,
    rawInputs,
    ...(meta.dependencies && meta.dependencies.length > 0 ? { dependencies: meta.dependencies } : {}),
    isDefunct: false,
  };
}
