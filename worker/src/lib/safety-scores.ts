import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "./report-cards-snapshot";
import type { StablecoinsCacheLoadResult } from "./stablecoins-cache";
import {
  loadReportCardCache,
  REPORT_CARD_CACHE_MAX_AGE_MS,
} from "./report-card-cache";
import type { SafetyScoreV8PublicationIdentity } from "@shared/types/safety-score-publication";

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
  sourceMode?: "computed" | "published-cache";
}

type ComputeSafetyScoresMapOptions = Omit<ComputeSafetyScoresOptions, "outputMode" | "sourceMode"> & {
  outputMode: "map";
  sourceMode?: "computed";
};
type ComputeSafetyScoresFullOptions = Omit<ComputeSafetyScoresOptions, "outputMode" | "sourceMode"> & {
  outputMode: "full-grades";
  sourceMode?: "computed";
};
type ComputePublishedSafetyScoresMapOptions = {
  outputMode: "map";
  sourceMode: "published-cache";
};

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

export type PublishedSafetyScoresResultMap = SafetyScoresResultMap & {
  source: "report-card-cache";
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity | null;
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
};

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

async function loadPublishedSafetyScoresSnapshot(db: D1Database): Promise<PublishedSafetyScoresResultMap> {
  const cached = await loadReportCardCache(db, {
    maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
    requireCompleteness: true,
  });
  if (cached.kind !== "ok") {
    return {
      ...toMapResult("degraded", new Map(), ACTIVE_STABLECOINS.length, `report-card-cache:${cached.reason}`),
      source: "report-card-cache",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: cached.updatedAt,
    };
  }

  const scores = new Map(
    Object.entries(cached.payload.scores).map(([id, score]) => [id, { ...score }]),
  );
  const degradedInputs = cached.payload.degradedInputs?.inputsStale === true;
  return {
    ...toMapResult(
      degradedInputs ? "degraded" : "ok",
      scores,
      cached.payload.completeness!.expectedCount,
      degradedInputs ? "report-card-cache:degraded-inputs" : undefined,
    ),
    source: "report-card-cache",
    safetyScoreIdentity: cached.payload.safetyScoreIdentity!,
    publicationGenerationId: cached.payload.publicationGenerationId!,
    methodologyVersion: cached.payload.methodologyVersion,
    publishedAt: cached.payload.updatedAt,
  };
}

/**
 * Loads safety grades from either report-card inputs or the exact published
 * compact report-card generation in D1.
 *
 * Reads all non-defunct report cards, maps each to an overall grade and score
 * derived from peg stability, liquidity depth, and governance dimensions, then
 * returns coverage statistics alongside the scored results.
 *
 * Computed mode preserves partial scores on failure. Published-cache mode
 * fails closed with an empty map unless the active-ID completeness manifest,
 * methodology, freshness, and generation identity all validate.
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
  options: ComputePublishedSafetyScoresMapOptions,
): Promise<PublishedSafetyScoresResultMap>;
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
  if (options.sourceMode === "published-cache") {
    if (outputMode !== "map") {
      throw new Error("published-cache safety scores support map output only");
    }
    return loadPublishedSafetyScoresSnapshot(db);
  }
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
