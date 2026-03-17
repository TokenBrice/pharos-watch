import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "./report-cards-snapshot";

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
  const trackedCount = ACTIVE_STABLECOINS.filter((meta) => includeNavTokens || !meta.flags.navToken).length;

  const scores = new Map<string, SafetyResult>();
  const allGrades: SafetyGradeRow[] = [];

  try {
    const snapshot = await buildReportCardsSnapshot(db);
    for (const card of snapshot.cards) {
      if (card.isDefunct) continue;
      if (!includeNavTokens && card.rawInputs.navToken) continue;

      if (card.overallScore !== null) {
        scores.set(card.id, { score: card.overallScore, grade: card.overallGrade });
      }

      if (outputMode === "full-grades") {
        allGrades.push({
          id: card.id,
          symbol: card.symbol,
          grade: card.overallGrade,
          score: card.overallScore ?? 0,
          pegScore: card.rawInputs.pegScore,
          liqScore: card.dimensions.liquidity.score,
        });
      }
    }
  } catch (err) {
    const reason = err instanceof ReportCardsSnapshotUnavailableError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
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
