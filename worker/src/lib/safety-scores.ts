import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import {
  computeOverallGrade,
  isBlacklistable,
  scoreDecentralization,
  scoreDependencyRisk,
  scoreLiquidity,
  scorePegStability,
  scoreResilience,
} from "@shared/lib/report-cards";
import { computePegScore, coinTrackingStart } from "@shared/lib/peg-score";
import { getDepegDewsMethodologyVersionAt } from "@shared/lib/depeg-dews-version";
import type { PegSummaryCoin } from "@shared/types";
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
  kind: "ok" | "degraded";
  mode: "map";
  reason?: string;
  coveredCount: number;
  trackedCount: number;
  coverageRatio: number;
  scores: Map<string, SafetyResult>;
};

type SafetyScoresResultFull = {
  kind: "ok" | "degraded";
  mode: "full-grades";
  reason?: string;
  coveredCount: number;
  trackedCount: number;
  coverageRatio: number;
  scores: Map<string, SafetyResult>;
  grades: SafetyGradeRow[];
};

export type SafetyScoresSnapshotResult = SafetyScoresResultMap | SafetyScoresResultFull;

function toMapResult(
  kind: "ok" | "degraded",
  scores: Map<string, SafetyResult>,
  trackedCount: number,
  reason?: string,
): SafetyScoresResultMap {
  const coveredCount = scores.size;
  return {
    kind,
    mode: "map",
    ...(reason ? { reason } : {}),
    coveredCount,
    trackedCount,
    coverageRatio: trackedCount > 0 ? coveredCount / trackedCount : 1,
    scores,
  };
}

function toFullResult(
  kind: "ok" | "degraded",
  scores: Map<string, SafetyResult>,
  grades: SafetyGradeRow[],
  trackedCount: number,
  reason?: string,
): SafetyScoresResultFull {
  const coveredCount = scores.size;
  return {
    kind,
    mode: "full-grades",
    ...(reason ? { reason } : {}),
    coveredCount,
    trackedCount,
    coverageRatio: trackedCount > 0 ? coveredCount / trackedCount : 1,
    scores,
    grades,
  };
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
  const trackedCount = TRACKED_STABLECOINS.filter((meta) => includeNavTokens || !meta.flags.navToken).length;

  const scores = new Map<string, SafetyResult>();
  const allGrades: SafetyGradeRow[] = [];

  try {
    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: true });
    if (stablecoinsCache.kind !== "ok") {
      const reason = `stablecoins-cache:${stablecoinsCache.reason}`;
      console.warn(`[safety-scores] computation skipped (${reason})`);
      if (outputMode === "full-grades") {
        return toFullResult("degraded", scores, allGrades, trackedCount, reason);
      }
      return toMapResult("degraded", scores, trackedCount, reason);
    }
    const peggedAssets = stablecoinsCache.payload.peggedAssets;
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
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[safety-scores] computation failed, returning degraded snapshot:", err);
    if (outputMode === "full-grades") {
      return toFullResult("degraded", scores, allGrades, trackedCount, reason);
    }
    return toMapResult("degraded", scores, trackedCount, reason);
  }

  if (outputMode === "full-grades") {
    return toFullResult("ok", scores, allGrades, trackedCount);
  }
  return toMapResult("ok", scores, trackedCount);
}
