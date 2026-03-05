import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import {
  computeOverallGrade,
  isBlacklistable,
  scoreDecentralization,
  scoreDependencyRisk,
  scoreLiquidity,
  scorePegStability,
  scoreResilience,
} from "../../../src/lib/report-cards";
import { computePegScore, coinTrackingStart } from "../../../src/lib/peg-score";
import { getDepegDewsMethodologyVersionAt } from "../../../src/lib/depeg-dews-version";
import type { PegSummaryCoin, StablecoinData } from "../../../src/lib/types";
import { type DepegRow, rowToDepegEvent } from "./depeg-helpers";
import { getFirstSeenDates } from "./db";
import { loadStablecoinsCache } from "./stablecoins-cache";
import { loadDexLiquidityMap } from "./dex-liquidity";

interface SafetyResult {
  score: number;
  grade: string;
}

export interface SafetyGradeRow {
  id: string;
  symbol: string;
  grade: string;
  score: number;
  pegScore: number | null;
  liqScore: number | null;
}

export interface ComputeSafetyScoresOptions {
  includeNavTokens?: boolean;
  outputMode?: "map" | "full-grades";
}

type SafetyScoresResultMap = {
  mode: "map";
  scores: Map<string, SafetyResult>;
};

type SafetyScoresResultFull = {
  mode: "full-grades";
  scores: Map<string, SafetyResult>;
  grades: SafetyGradeRow[];
};

export type SafetyScoresSnapshotResult = SafetyScoresResultMap | SafetyScoresResultFull;

function toMapResult(scores: Map<string, SafetyResult>): SafetyScoresResultMap {
  return { mode: "map", scores };
}

function toFullResult(scores: Map<string, SafetyResult>, grades: SafetyGradeRow[]): SafetyScoresResultFull {
  return { mode: "full-grades", scores, grades };
}

export async function computeSafetyScoresSnapshot(
  db: D1Database,
  options: { includeNavTokens?: boolean; outputMode: "map" },
): Promise<SafetyScoresResultMap>;
export async function computeSafetyScoresSnapshot(
  db: D1Database,
  options: { includeNavTokens?: boolean; outputMode: "full-grades" },
): Promise<SafetyScoresResultFull>;
export async function computeSafetyScoresSnapshot(
  db: D1Database,
  options: ComputeSafetyScoresOptions = {},
): Promise<SafetyScoresSnapshotResult> {
  const outputMode = options.outputMode ?? "map";
  const includeNavTokens = options.includeNavTokens ?? true;

  const scores = new Map<string, SafetyResult>();
  const allGrades: SafetyGradeRow[] = [];

  try {
    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
    if (stablecoinsCache.ok && stablecoinsCache.warningReason) {
      console.warn(`[safety-scores] stablecoins cache fallback (${stablecoinsCache.warningReason})`);
    }
    const peggedAssets = stablecoinsCache.payload.peggedAssets as StablecoinData[];
    const priceById = new Map(peggedAssets.map((asset) => [asset.id, asset]));

    const nowSec = Math.floor(Date.now() / 1000);
    const fourYearsAgoSec = nowSec - Math.ceil(4 * 365.25 * 86400);
    const [eventsResult, dexLiqMap, firstSeenMap] = await Promise.all([
      db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
        .bind(fourYearsAgoSec)
        .all<DepegRow>(),
      loadDexLiquidityMap(db),
      getFirstSeenDates(db),
    ]);

    const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);
    const eventsByCoin = new Map<string, typeof allEvents>();
    for (const event of allEvents) {
      const list = eventsByCoin.get(event.stablecoinId) ?? [];
      list.push(event);
      eventsByCoin.set(event.stablecoinId, list);
    }

    const overallScores = new Map<string, number>();
    const blacklistableIds: ReadonlySet<string> = new Set(
      TRACKED_STABLECOINS
        .filter((meta) => isBlacklistable(meta) === true)
        .map((meta) => meta.id),
    );
    const methodologyVersion = getDepegDewsMethodologyVersionAt(nowSec);

    const computeForCoin = (meta: (typeof TRACKED_STABLECOINS)[number]): void => {
      if (!includeNavTokens && meta.flags.navToken) return;

      const asset = priceById.get(meta.id);
      const events = eventsByCoin.get(meta.id) ?? [];
      const trackingStart = coinTrackingStart(events, fourYearsAgoSec, firstSeenMap.get(meta.id));
      const scoreResult = computePegScore(events, trackingStart, nowSec);

      const pegData: PegSummaryCoin = {
        id: meta.id,
        symbol: meta.symbol,
        name: meta.name,
        pegType: asset?.pegType ?? "",
        pegCurrency: meta.flags.pegCurrency,
        governance: meta.flags.governance,
        currentDeviationBps: null,
        pegScore: scoreResult.pegScore,
        pegPct: scoreResult.pegPct,
        severityScore: scoreResult.severityScore,
        spreadPenalty: scoreResult.spreadPenalty,
        eventCount: scoreResult.eventCount,
        worstDeviationBps: scoreResult.worstDeviationBps,
        activeDepeg: scoreResult.activeDepeg,
        lastEventAt: scoreResult.lastEventAt,
        trackingSpanDays: scoreResult.trackingSpanDays,
        methodologyVersion,
      };

      const canBlacklist = isBlacklistable(meta, blacklistableIds);
      const dimensions = {
        pegStability: scorePegStability(pegData, meta),
        liquidity: scoreLiquidity(dexLiqMap[meta.id]),
        resilience: scoreResilience(meta, canBlacklist),
        decentralization: scoreDecentralization(meta.flags.governance, meta),
        dependencyRisk: scoreDependencyRisk(meta, overallScores),
      };
      const overall = computeOverallGrade(dimensions, { navToken: !!meta.flags.navToken });
      if (overall.score !== null) {
        overallScores.set(meta.id, overall.score);
        scores.set(meta.id, { score: overall.score, grade: overall.grade });
      }

      if (outputMode === "full-grades") {
        allGrades.push({
          id: meta.id,
          symbol: meta.symbol,
          grade: overall.grade,
          score: overall.score ?? 0,
          pegScore: scoreResult.pegScore,
          liqScore: dexLiqMap[meta.id]?.liquidityScore ?? null,
        });
      }
    };

    // Phase 1: non-dependent
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.governance === "centralized-dependent") continue;
      computeForCoin(meta);
    }

    // Phase 2: dependent
    for (const meta of TRACKED_STABLECOINS) {
      if (meta.flags.governance !== "centralized-dependent") continue;
      computeForCoin(meta);
    }
  } catch (err) {
    console.warn("[safety-scores] computation failed, returning empty snapshot:", err);
  }

  if (outputMode === "full-grades") {
    return toFullResult(scores, allGrades);
  }
  return toMapResult(scores);
}
