import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "./report-cards-snapshot";
import type { StablecoinsCacheLoadResult } from "./stablecoins-cache";

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
  preloadedStablecoinsCache?: StablecoinsCacheLoadResult;
}

type ComputeSafetyScoresMapOptions = Omit<ComputeSafetyScoresOptions, "outputMode"> & { outputMode: "map" };
type ComputeSafetyScoresFullOptions = Omit<ComputeSafetyScoresOptions, "outputMode"> & { outputMode: "full-grades" };

export type SafetyScoresResultMap = {
  kind: "ok" | "degraded";
  mode: "map";
  reason?: string;
  coveredCount: number;
  trackedCount: number;
  coverageRatio: number;
  scores: Map<string, SafetyResult>;
};

export type SafetyScoresResultFull = {
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

function buildResultBase(
  kind: "ok" | "degraded",
  scores: Map<string, SafetyResult>,
  trackedCount: number,
  reason?: string,
): Omit<SafetyScoresResultMap, "mode"> {
  const coveredCount = scores.size;
  return {
    kind,
    ...(reason ? { reason } : {}),
    coveredCount,
    trackedCount,
    coverageRatio: trackedCount > 0 ? coveredCount / trackedCount : 1,
    scores,
  };
}

function toMapResult(
  kind: "ok" | "degraded",
  scores: Map<string, SafetyResult>,
  trackedCount: number,
  reason?: string,
): SafetyScoresResultMap {
  return {
    ...buildResultBase(kind, scores, trackedCount, reason),
    mode: "map",
  };
}

function toFullResult(
  kind: "ok" | "degraded",
  scores: Map<string, SafetyResult>,
  grades: SafetyGradeRow[],
  trackedCount: number,
  reason?: string,
): SafetyScoresResultFull {
  return {
    ...buildResultBase(kind, scores, trackedCount, reason),
    mode: "full-grades",
    grades,
  };
}

/**
 * Computes safety grades from the latest report-card snapshot in D1.
 *
 * Reads all non-defunct report cards, maps each to an overall grade and score
 * derived from peg stability, liquidity depth, and governance dimensions, then
 * returns coverage statistics alongside the scored results.
 *
 * On any failure (missing snapshot, DB error), returns a "degraded" result
 * containing whatever partial scores were accumulated before the error rather
 * than throwing, so callers can serve stale-but-non-empty data.
 *
 * @param db - D1 database handle.
 * @param options.outputMode - "map" returns an id→{grade,score} lookup suitable
 *   for fast per-coin lookups; "full-grades" returns ordered grade rows with
 *   symbol, pegScore, and liqScore for the public API and safety-scores page.
 * @param options.includeNavTokens - Whether to include NAV tokens (appreciating
 *   assets not pegged to a fixed price). Defaults to `true`.
 * @returns `SafetyScoresResultMap` when outputMode is "map", or
 *   `SafetyScoresResultFull` when outputMode is "full-grades". Both include a
 *   `kind` field ("ok" | "degraded") and coverage ratio.
 */
export async function computeSafetyScoresSnapshot(
  db: D1Database,
  options: ComputeSafetyScoresMapOptions,
): Promise<SafetyScoresResultMap>;
export async function computeSafetyScoresSnapshot(
  db: D1Database,
  options: ComputeSafetyScoresFullOptions,
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
    const snapshot = options.preloadedStablecoinsCache
      ? await buildReportCardsSnapshot(db, { preloadedStablecoinsCache: options.preloadedStablecoinsCache })
      : await buildReportCardsSnapshot(db);
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
