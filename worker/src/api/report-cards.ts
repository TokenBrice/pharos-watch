import { getCache } from "../lib/db";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { computePegScore } from "../../../src/lib/peg-score";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { sumPegBuckets } from "../../../src/lib/supply";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { deriveDependencies } from "../../../src/lib/reserve-templates";
import { DEAD_STABLECOINS } from "../../../src/lib/dead-stablecoins";
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  resolveResilienceFactors,
  resolveGovernanceQuality,
} from "../../../src/lib/report-cards";
import type {
  StablecoinData,
  StablecoinMeta,
  DepegEvent,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  ReportCardsResponse,
  PegSummaryCoin,
  DimensionKey,
  GovernanceType,
  GovernanceQuality,
  RawDimensionInputs,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
} from "../../../src/lib/types";

// ---------------------------------------------------------------------------
// Blacklistability helper
// ---------------------------------------------------------------------------

function isBlacklistable(meta: StablecoinMeta): boolean | "possible" {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  return meta.flags.governance === "centralized";
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

  let peggedAssets: StablecoinData[];
  let fxFallbackRates: Record<string, number> | undefined;
  try {
    const parsed = JSON.parse(stablecoinsCached.value) as {
      peggedAssets: StablecoinData[];
      fxFallbackRates?: Record<string, number>;
    };
    peggedAssets = parsed.peggedAssets;
    fxFallbackRates = parsed.fxFallbackRates;
  } catch {
    return new Response(JSON.stringify({ error: "Cached stablecoins data is corrupt" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  let bluechipMap: Record<string, BluechipRating> = {};
  if (bluechipCached) {
    try { bluechipMap = JSON.parse(bluechipCached.value); } catch { /* fall back to empty */ }
  }

  // 2. Load depeg events (4-year window)
  const fourYearsAgoSec = Math.floor(Date.now() / 1000) - Math.ceil(4 * 365.25 * 86400);

  const eventsResult = await db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
    .bind(fourYearsAgoSec)
    .all<DepegRow>();

  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);

  // Group events by stablecoin ID
  const eventsByCoins = new Map<string, DepegEvent[]>();
  for (const e of allEvents) {
    const list = eventsByCoins.get(e.stablecoinId) ?? [];
    list.push(e);
    eventsByCoins.set(e.stablecoinId, list);
  }

  // 3. Build lookup maps (priceById is used for peg summary below)
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates } = derivePegRates(peggedAssets, metaById, fxFallbackRates);
  const now = Math.floor(Date.now() / 1000);
  const fourYearsAgo = now - 4 * 365.25 * 86400;

  // 4. Compute peg summary data per coin (same logic as peg-summary)
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
      ? Math.min(events.reduce((m, e) => Math.min(m, e.startedAt), Infinity), fourYearsAgo)
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

  // 5. Score all coins in dependency order (upstream first)
  const sortedMetas = topologicalOrder([...TRACKED_STABLECOINS]);
  const overallScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];

  for (const meta of sortedMetas) {
    const card = computeCard(meta, pegDataById, dexLiqMap, bluechipMap, overallScores);
    liveCards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // 6. Add cemetery coins as permanent F
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
        resilience: nrDim,
        decentralization: nrDim,
        dependencyRisk: nrDim,
      },
      ratedDimensions: 5,
      rawInputs: {
        pegScore: null, activeDepeg: false, depegEventCount: 0, lastEventAt: null,
        liquidityScore: null, concentrationHhi: null, bluechipGrade: null,
        canBeBlacklisted: false,
        chainTier: "ethereum" as ChainTier,
        deploymentModel: "single-chain" as DeploymentModel,
        collateralQuality: "native" as CollateralQuality,
        custodyModel: "onchain" as CustodyModel,
        governanceTier: "centralized" as GovernanceType,
        governanceQuality: "single-entity" as GovernanceQuality,
        dependencies: [],
        navToken: false,
      },
      isDefunct: true,
    };
  });

  // 7. Combine and sort by overall score descending (NR at bottom)
  const allCards = [...liveCards, ...defunctCards];
  allCards.sort((a, b) => {
    // NR (null score) goes to bottom
    if (a.overallScore === null && b.overallScore === null) return 0;
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });

  // 8. Build dependency graph edge list
  const edges: { from: string; to: string }[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    for (const dep of deriveDependencies(meta)) {
      edges.push({ from: dep.id, to: meta.id });
    }
  }

  // 9. Return ReportCardsResponse
  const response: ReportCardsResponse = {
    cards: allCards,
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      thresholds: GRADE_THRESHOLDS,
    },
    dependencyGraph: { edges },
    updatedAt: stablecoinsCached.updatedAt,
  };

  return new Response(JSON.stringify(response), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.standard,
    }, stablecoinsCached.updatedAt, 900),
  });
});

// ---------------------------------------------------------------------------
// Per-coin card computation
// ---------------------------------------------------------------------------

function computeCard(
  meta: (typeof TRACKED_STABLECOINS)[number],
  pegDataById: Map<string, PegSummaryCoin>,
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>,
  bluechipMap: Record<string, BluechipRating>,
  overallScores: Map<string, number>,
): ReportCard {
  const peg = pegDataById.get(meta.id);
  const liq = dexLiqMap[meta.id];
  const rating = bluechipMap[meta.id];

  const canBeBlacklisted = isBlacklistable(meta);
  const resilienceFactors = resolveResilienceFactors(meta);

  // Score each dimension
  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq),
    resilience: scoreResilience(meta, canBeBlacklisted),
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType, meta),
    dependencyRisk: scoreDependencyRisk(meta, overallScores),
  };

  const navToken = !!meta.flags.navToken;
  const overall = computeOverallGrade(dimensions, { navToken });

  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: liq?.liquidityScore ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    canBeBlacklisted,
    chainTier: resilienceFactors.chainTier,
    deploymentModel: resilienceFactors.deploymentModel,
    collateralQuality: resilienceFactors.collateralQuality,
    custodyModel: resilienceFactors.custodyModel,
    governanceTier: meta.flags.governance as GovernanceType,
    governanceQuality: resolveGovernanceQuality(meta.flags.governance as GovernanceType, meta),
    dependencies: deriveDependencies(meta),
    navToken,
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
    ...(() => { const d = deriveDependencies(meta); return d.length > 0 ? { dependencies: d } : {}; })(),
    isDefunct: false,
  };
}

// ---------------------------------------------------------------------------
// Topological sort — ensures every coin is scored after all its upstreams
// ---------------------------------------------------------------------------

function topologicalOrder(metas: StablecoinMeta[]): StablecoinMeta[] {
  const metaMap = new Map(metas.map(m => [m.id, m]));
  const visited = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const meta = metaMap.get(id);
    if (!meta) return;
    for (const dep of deriveDependencies(meta)) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    result.push(meta);
  }

  for (const meta of metas) visit(meta.id);
  return result;
}
