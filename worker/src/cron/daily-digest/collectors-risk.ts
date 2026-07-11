import type { DigestInputData } from "@shared/types/digest";
import { scoreToGrade } from "@shared/lib/report-cards";
import { getCirculatingRaw } from "@shared/lib/supply";
import { DEWS_SIGNAL_LABELS, type DewsSignalKey } from "@shared/lib/dews-config";
import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import { computeSafetyScoresSnapshot, type SafetyGradeRow } from "../../lib/safety-scores";
import {
  logCollectorParseFailure,
  markCollectorDegraded,
  type CollectorContext,
  type SafetyScoresResult,
} from "./collectors-shared";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { loadPublishedStressSignalGeneration } from "../../lib/stress-signals-current-rows";
import { logWorkerEvent } from "../../lib/structured-log";

function parseStressSignalsMap(
  signalsJson: string,
): Record<string, { value: number; available: boolean }> {
  const parsed = JSON.parse(signalsJson) as unknown;
  const unwrapped = unwrapStressSignalsEnvelope(parsed);
  return (unwrapped?.signals ?? {}) as Record<string, { value: number; available: boolean }>;
}

export async function collectSafetyScores(
  ctx: CollectorContext,
  mentionedSymbols: Set<string>,
  degradedReasons: string[],
): Promise<SafetyScoresResult> {
  try {
    const safetySnapshot = await computeSafetyScoresSnapshot(ctx.db, {
      includeNavTokens: false,
      outputMode: "full-grades",
    });
    if (safetySnapshot.kind !== "ok") {
      degradedReasons.push(`safety-snapshot:${safetySnapshot.reason ?? "degraded"}`);
      console.warn(
        `[daily-digest] Safety snapshot degraded: ${safetySnapshot.coveredCount}/${safetySnapshot.trackedCount} ` +
        `(${(safetySnapshot.coverageRatio * 100).toFixed(1)}%)`,
      );
      return { safetyScores: undefined, safetyGrades: undefined };
    }

    const allGrades = safetySnapshot.grades;
    const scores = allGrades.map((grade) => grade.score).sort((a, b) => a - b);
    const medianScore = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0;
    const medianGrade = scoreToGrade(medianScore);
    const aboveBCount = allGrades.filter((grade) => grade.score >= 75).length;
    const fCount = allGrades.filter((grade) => grade.grade === "F").length;
    const mentionedCoinGrades = allGrades.filter((grade) => mentionedSymbols.has(grade.symbol));
    const tensionCoins = allGrades
      .filter((grade) => !mentionedSymbols.has(grade.symbol) && grade.pegScore !== null && grade.pegScore > 90 && grade.score < 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const reportCoins = [...mentionedCoinGrades, ...tensionCoins];
    const reportIds = new Set(reportCoins.map((grade) => grade.id));
    const worstGraded = allGrades
      .filter((grade) => !reportIds.has(grade.id) && (ctx.mcapById.get(grade.id) ?? 0) > 10_000_000)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    for (const grade of worstGraded) {
      if (!reportIds.has(grade.id)) {
        reportCoins.push(grade);
        reportIds.add(grade.id);
      }
    }
    const fRated = allGrades.filter(
      (grade) => grade.grade === "F" && !reportIds.has(grade.id) && (ctx.mcapById.get(grade.id) ?? 0) > 10_000_000,
    );
    for (const grade of fRated) {
      reportCoins.push(grade);
      reportIds.add(grade.id);
    }

    return {
      safetyScores: {
        mentionedCoins: reportCoins.map((grade) => ({
          symbol: grade.symbol,
          grade: grade.grade,
          score: grade.score,
          peg: grade.pegScore,
          liq: grade.liqScore,
        })),
        medianGrade,
        aboveBCount,
        fCount,
      },
      safetyGrades: allGrades,
    };
  } catch (error) {
    markCollectorDegraded(degradedReasons, "safety-snapshot-query");
    console.error("[daily-digest] Failed to compute safety scores:", error);
    return { safetyScores: undefined, safetyGrades: undefined };
  }
}

export async function collectDewsStress(
  ctx: CollectorContext,
  degradedReasons?: string[],
): Promise<DigestInputData["dewsStress"]> {
  try {
    const publishedDews = await loadPublishedStressSignalGeneration(ctx.db, ctx.nowSec);
    if (publishedDews.status !== "ok") {
      markCollectorDegraded(degradedReasons, "dews-published-generation");
      logWorkerEvent({
        scope: "lib",
        level: "error",
        event: "daily_digest.dews_generation_unavailable",
        job: "daily-digest",
        message: "Published DEWS generation unavailable",
        metadata: { reason: publishedDews.reason },
      });
      return undefined;
    }

    const todayRows = publishedDews.rows;
    if (todayRows.length > 0) {
      const yesterdayDews = await ctx.db
        .prepare("SELECT stablecoin_id, score, band FROM stress_signal_history WHERE snapshot_date = ?")
        .bind(ctx.yesterdayTs)
        .all<{ stablecoin_id: string; score: number; band: string }>();

      const yesterdayMap = new Map((yesterdayDews.results ?? []).map((row) => [row.stablecoin_id, row]));
      const initCounts = () => ({ calm: 0, watch: 0, alert: 0, warning: 0, danger: 0 });
      const bandCounts = initCounts();
      const yesterdayBandCounts = initCounts();

      for (const row of todayRows) {
        const key = row.band.toLowerCase() as keyof typeof bandCounts;
        if (key in bandCounts) bandCounts[key]++;
      }
      for (const row of yesterdayDews.results ?? []) {
        const key = row.band.toLowerCase() as keyof typeof yesterdayBandCounts;
        if (key in yesterdayBandCounts) yesterdayBandCounts[key]++;
      }

      const bandChanges: NonNullable<DigestInputData["dewsStress"]>["bandChanges"] = [];
      const malformedSignalsReason = "dews-stress-signals-json";

      for (const today of todayRows) {
        const yesterday = yesterdayMap.get(today.stablecoin_id);
        if (!yesterday || yesterday.band === today.band) continue;
        const yesterdayRank = isThreatBand(yesterday.band) ? THREAT_BAND_ORDER[yesterday.band] : 0;
        const todayRank = isThreatBand(today.band) ? THREAT_BAND_ORDER[today.band] : 0;
        if (yesterdayRank === todayRank) continue;

        let topDriver = "unknown";
        try {
          const signals = parseStressSignalsMap(today.signals_json);
          let maxVal = -1;
          for (const [key, signal] of Object.entries(signals)) {
            if (signal.available && signal.value > maxVal) {
              maxVal = signal.value;
              topDriver = key in DEWS_SIGNAL_LABELS
                ? DEWS_SIGNAL_LABELS[key as DewsSignalKey].toLowerCase()
                : key;
            }
          }
        } catch (error) {
          markCollectorDegraded(degradedReasons, malformedSignalsReason);
          logCollectorParseFailure("dews-stress", "signals_json", error, { stablecoinId: today.stablecoin_id });
        }

        const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === today.stablecoin_id);
        if (!coin) continue;
        bandChanges.push({
          symbol: coin.symbol,
          from: yesterday.band,
          to: today.band,
          score: today.score,
          topDriver,
          mcapUsd: getCirculatingRaw(coin),
        });
      }

      const elevatedCoins = todayRows
        .filter((row) => isDewsAlertBand(row.band))
        .map((row) => {
          const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === row.stablecoin_id);
          if (!coin) return null;

          let topSignals: { name: string; value: number }[] = [];
          try {
            const signals = parseStressSignalsMap(row.signals_json);
            topSignals = Object.entries(signals)
              .filter(([, signal]) => signal.available && signal.value > 0)
              .sort(([, a], [, b]) => b.value - a.value)
              .slice(0, 3)
              .map(([key, signal]) => ({
                name: key in DEWS_SIGNAL_LABELS ? DEWS_SIGNAL_LABELS[key as DewsSignalKey].toLowerCase() : key,
                value: Math.round(signal.value),
              }));
          } catch (error) {
            markCollectorDegraded(degradedReasons, malformedSignalsReason);
            logCollectorParseFailure("dews-stress", "signals_json", error, { stablecoinId: row.stablecoin_id });
          }

          const mcapUsd = getCirculatingRaw(coin);
          const yScore = yesterdayMap.get(row.stablecoin_id)?.score;
          const changeFromYesterday = yScore != null ? row.score - yScore : undefined;
          return {
            symbol: coin.symbol,
            band: row.band,
            score: row.score,
            mcapUsd,
            topSignals,
            changeFromYesterday,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null && row.mcapUsd > 10_000_000)
        .sort((a, b) => {
          const aDelta = Math.abs(a.changeFromYesterday ?? 0) * a.mcapUsd;
          const bDelta = Math.abs(b.changeFromYesterday ?? 0) * b.mcapUsd;
          return bDelta - aDelta || b.score - a.score;
        })
        .slice(0, 5);

      return {
        bandCounts,
        yesterdayBandCounts,
        bandChanges: bandChanges.slice(0, 5),
        elevatedCoins,
      };
    }
  } catch (error) {
    markCollectorDegraded(degradedReasons, "dews-stress-query");
    console.error("[daily-digest] Failed to collect DEWS stress signals:", error);
  }
  return undefined;
}

export async function collectGradeTransitions(
  ctx: CollectorContext,
  safetyGrades: SafetyGradeRow[] | undefined,
  degradedReasons?: string[],
): Promise<DigestInputData["gradeTransitions"]> {
  try {
    const cutoff48h = ctx.nowSec - 2 * 24 * 60 * 60;
    const bumpRows = await ctx.db
      .prepare(
        `SELECT recorded_at,
                COUNT(*) as cnt,
                SUM(CASE WHEN score > prev_score THEN 1 ELSE 0 END) as upgrades,
                SUM(CASE WHEN score < prev_score THEN 1 ELSE 0 END) as downgrades
         FROM safety_grade_history
         WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         GROUP BY recorded_at HAVING COUNT(*) > 15`,
      )
      .bind(cutoff48h)
      .all<{ recorded_at: number; cnt: number; upgrades: number; downgrades: number }>();
    const bumpTimestamps = new Set(
      (bumpRows.results ?? [])
        .filter((row) => row.upgrades / row.cnt > 0.8 || row.downgrades / row.cnt > 0.8)
        .map((row) => row.recorded_at),
    );

    const transitionRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, recorded_at, grade, score, prev_grade, prev_score
         FROM safety_grade_history WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         ORDER BY ABS(score - prev_score) DESC
         LIMIT 10`,
      )
      .bind(cutoff48h)
      .all<{ stablecoin_id: string; recorded_at: number; grade: string; score: number; prev_grade: string; prev_score: number }>();

    const candidates = (transitionRows.results ?? [])
      .filter((row) => !bumpTimestamps.has(row.recorded_at))
      .filter((row) => {
        const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === row.stablecoin_id);
        return coin && getCirculatingRaw(coin) > 10_000_000;
      })
      .slice(0, 5);

    if (candidates.length > 0 && safetyGrades) {
      const gradeMap = new Map(safetyGrades.map((grade) => [grade.id, grade]));
      return candidates.map((row) => {
        const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === row.stablecoin_id)!;
        const currentGrade = gradeMap.get(row.stablecoin_id);
        return {
          symbol: coin.symbol,
          fromGrade: row.prev_grade,
          toGrade: row.grade,
          fromScore: row.prev_score,
          toScore: row.score,
          currentDimensions: {
            peg: currentGrade?.pegScore ?? null,
            liq: currentGrade?.liqScore ?? null,
            resilience: null,
            decentralization: null,
          },
          mcapUsd: getCirculatingRaw(coin),
        };
      });
    }
  } catch (error) {
    markCollectorDegraded(degradedReasons, "grade-transitions-query");
    console.error("[daily-digest] Failed to collect grade transitions:", error);
  }
  return undefined;
}

export async function collectYieldAnomalies(
  ctx: CollectorContext,
  degradedReasons?: string[],
): Promise<DigestInputData["yieldAnomalies"]> {
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals
         FROM yield_data
         WHERE is_best = 1
           AND (publication_generation_id IS NULL OR publication_state = 'published')
           AND warning_signals IS NOT NULL
           AND warning_signals != '[]'
         ORDER BY current_apy DESC`,
      )
      .all<{
        stablecoin_id: string;
        symbol: string;
        current_apy: number;
        apy_7d: number;
        apy_30d: number;
        warning_signals: string;
      }>();

    const candidates = (rows.results ?? [])
      .map((row) => {
        let warnings: string[] = [];
        try {
          warnings = JSON.parse(row.warning_signals) as string[];
        } catch (error) {
          markCollectorDegraded(degradedReasons, "yield-warning-signals-json");
          logCollectorParseFailure("yield-anomalies", "warning_signals", error, { stablecoinId: row.stablecoin_id });
        }
        if (warnings.length === 0) return null;

        const mcapUsd = ctx.mcapById.get(row.stablecoin_id) ?? 0;
        if (mcapUsd < 10_000_000 || row.current_apy >= 500) return null;

        return {
          symbol: row.symbol,
          currentApy: Math.round(row.current_apy * 100) / 100,
          apy7d: Math.round(row.apy_7d * 100) / 100,
          apy30d: Math.round(row.apy_30d * 100) / 100,
          warnings,
          mcapUsd,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.mcapUsd * b.warnings.length - a.mcapUsd * a.warnings.length)
      .slice(0, 5);

    return candidates.length > 0 ? candidates : undefined;
  } catch (error) {
    markCollectorDegraded(degradedReasons, "yield-anomalies-query");
    console.error("[daily-digest] Failed to collect yield anomalies:", error);
    return undefined;
  }
}
